"""AI 智能录入：调用云端大模型，把用户口语拆分为 入库/出库 结构化参数。

- LLM 配置在 product_rules.json 的 llm 段（base_url / api_key / model）
- 通过官方 openai 客户端调用（标准 OpenAI 兼容协议 /chat/completions），支持流式输出
- 大模型只负责"理解 + 抽取"，商品匹配与单位换算在服务端做（更快、更可靠），前端弹确认框核对
- 提速要点：不向模型发送 307 个商品的完整目录（由后端匹配），并采用流式返回（首 token 约 1~2 秒）
"""
import json
import re
from datetime import date, datetime
from pathlib import Path

from fastapi import APIRouter, Depends, File, Form, HTTPException, UploadFile
from fastapi.responses import StreamingResponse
from openai import OpenAI
from pydantic import BaseModel
from sqlalchemy.orm import Session

from ..auth import get_current_user
from ..database import get_db
from ..models import Inbound, OutboundLine, Product, Unit, User

router = APIRouter(prefix="/api/ai", tags=["ai"])

ROOT = Path(__file__).resolve().parent.parent.parent
CONFIG_FILE = ROOT / "product_rules.json"

# AI 票据图片保存目录：记录备注可引用 /uploads/xxx.jpg 预览
UPLOAD_DIR = ROOT / "data" / "uploads"

# 单位别名 -> 系统换算表里的标准名
UNIT_ALIASES = {
    "g": "克", "克": "克",
    "kg": "千克", "千克": "千克", "公斤": "公斤", "斤": "斤",
    "个": "个", "件": "件", "袋": "袋", "包": "包", "盒": "盒", "箱": "箱", "份": "份", "单": "单",
}

SYSTEM_PROMPT = """你是「企业台账系统」的自然语言录入解析器。用户会用口语描述入库（进货/采购/进仓）或出库（销售/卖出/发货）业务，例如：
- 入库：今天入库了100斤木耳，25一斤
- 出库：出库2单七彩土豆3斤，每单15元，客户叫张三

处理要求：
1. 判断业务类型 type：入库 -> "inbound"；出库 -> "outbound"。按用户第一个明确的动作词判断。
2. 商品名称 product：输出用户提到的商品名称（原词即可，简洁，不要加多余说明）。
3. 数量、单位、单价：直接保留用户表述的数字与单位（如 quantity=100, unit="斤", unit_price=25），禁止自行换算单位、禁止改数字。
4. 日期 date：用户没说具体日期就用"今天"（今天的日期见用户消息），格式 YYYY-MM-DD。
5. supplier（入库时的供应商）/ customer（出库时的客户）/ remark（备注）：有则提取，没有给空字符串。
6. 一句话可能包含多行/多个商品，lines 里逐行列出；单价统一理解为"每 unit 单位的金额"。

只输出一个 JSON 对象，禁止输出 JSON 以外的任何文字、解释、markdown 代码块标记。
JSON 要紧凑输出：单行、无缩进无换行、字段间不留多余空格；supplier/customer/remark 为空时省略该字段。
JSON 结构：
{
  "type": "inbound" | "outbound",
  "date": "YYYY-MM-DD",
  "supplier": "",
  "customer": "",
  "remark": "",
  "lines": [
    { "product": "商品名称", "quantity": 100, "unit": "斤", "unit_price": 25 }
  ]
}"""

IMAGE_SYSTEM_PROMPT = """你是「企业台账系统」的采购票据识别助手。用户会提供一张采购发票 / 送货单 / 销货单的图片（如公司进货凭证），请从中提取采购信息。

处理要求：
1. 业务类型一律为入库（inbound）：这些票据代表公司采购了货物进入仓库。
2. 逐条提取每条采购商品的：商品名称（product，按票据原文，简洁）、数量（quantity）、单位（unit，如 张/个/斤/公斤/袋/箱）、单价（unit_price，每单位的金额，保留小数）。
3. supplier：票据上的销方（卖方）公司名称；customer 留空。
4. 日期 date：票据上若有日期就用它（格式 YYYY-MM-DD），没有就用"今天"（今天的日期见用户消息）。
5. remark：可留空。
6. 票据可能有多张/多条，lines 逐条列出；金额合计不用输出。

只输出一个 JSON 对象，禁止输出 JSON 以外的任何文字、解释、markdown 代码块标记。
JSON 要紧凑输出：单行、无缩进无换行、字段间不留多余空格；supplier/customer/remark 为空时省略该字段。
JSON 结构：
{
  "type": "inbound",
  "date": "YYYY-MM-DD",
  "supplier": "",
  "customer": "",
  "remark": "",
  "lines": [
    { "product": "商品名称", "quantity": 100, "unit": "个", "unit_price": 0.5 }
  ]
}"""


class ParseIn(BaseModel):
    text: str


def _llm_config() -> dict:
    try:
        cfg = json.loads(CONFIG_FILE.read_text(encoding="utf-8"))
        return (cfg.get("llm") or {}) if cfg.get("llm", {}).get("enabled", True) else {}
    except Exception:
        return {}


def _make_client(cfg: dict) -> OpenAI:
    """注意：SDK 会在 base_url 后自动追加 /chat/completions，
    因此配置里若给了完整端点，需先去掉该后缀，避免路径重复。"""
    sdk_base = cfg["base_url"]
    if sdk_base.endswith("/chat/completions"):
        sdk_base = sdk_base[: -len("/chat/completions")]
    return OpenAI(
        base_url=sdk_base,
        api_key=cfg["api_key"],
        timeout=300.0,       # 云端模型较慢，放宽到 5 分钟
        max_retries=2,
    )


def _chat(cfg: dict, system: str, user: str) -> str:
    resp = _make_client(cfg).chat.completions.create(
        model=cfg["model"],
        messages=[
            {"role": "system", "content": system},
            {"role": "user", "content": user},
        ],
        temperature=0.1,
        max_tokens=800,  # 限制输出长度，避免模型生成超长内容拖慢整体耗时
    )
    if not resp.choices or not resp.choices[0].message or not resp.choices[0].message.content:
        raise RuntimeError(f"大模型返回异常：{resp.model_dump() if hasattr(resp, 'model_dump') else resp}")
    return resp.choices[0].message.content


def _chat_stream(cfg: dict, system: str, user: str):
    """流式获取增量文本（生成器，逐段返回内容片段）。"""
    stream = _make_client(cfg).chat.completions.create(
        model=cfg["model"],
        messages=[
            {"role": "system", "content": system},
            {"role": "user", "content": user},
        ],
        temperature=0.1,
        max_tokens=800,  # 限制输出长度，避免模型生成超长内容拖慢整体耗时
        stream=True,
    )
    for chunk in stream:
        if chunk.choices and chunk.choices[0].delta and chunk.choices[0].delta.content:
            yield chunk.choices[0].delta.content


def _chat_stream_mm(cfg: dict, system: str, user: str, image_data_uri: str):
    """多模态流式调用：文本 + 图片（base64 data URI）。"""
    stream = _make_client(cfg).chat.completions.create(
        model=cfg["model"],
        messages=[
            {"role": "system", "content": system},
            {
                "role": "user",
                "content": [
                    {"type": "text", "text": user},
                    {"type": "image_url", "image_url": {"url": image_data_uri}},
                ],
            },
        ],
        temperature=0.1,
        max_tokens=800,  # 限制输出长度，避免模型生成超长内容拖慢整体耗时
        stream=True,
    )
    for chunk in stream:
        if chunk.choices and chunk.choices[0].delta and chunk.choices[0].delta.content:
            yield chunk.choices[0].delta.content


def _ensure_unit(db: Session, unit: str) -> Unit:
    """确保单位存在，不存在则自动新增（计数类单位）。返回 Unit。"""
    unit = (unit or "").strip()
    if not unit:
        unit = "个"
    u = db.query(Unit).filter(Unit.name == unit).first()
    if not u:
        u = Unit(name=unit, category="count", gram_per_unit=None, is_standard=False)
        db.add(u)
        db.flush()
    return u


def _auto_create_stock(db: Session, name: str, unit: str) -> Product:
    """自动新增一个库存商品（采购新物品），并自动补齐单位。返回新商品。"""
    name = (name or "").strip()
    if not name:
        raise HTTPException(400, "商品名称为空，无法自动新增")
    _ensure_unit(db, unit or "个")
    u = (unit or "个").strip()
    p = Product(
        name=name,
        category="商品",
        product_type="stock",
        base_unit=u,
        default_unit=u,
        conversions={u: 1},
        unit_cost=0.0,
        spec="AI 自动新增（票据识别）",
        is_active=True,
    )
    db.add(p)
    db.flush()
    return p


def _extract_json(content: str) -> dict:
    """从模型输出中稳健提取 JSON（兼容带 markdown 代码块或前后杂文）。"""
    content = content.strip()
    m = re.search(r"\{.*\}", content, re.S)
    if m:
        content = m.group(0)
    return json.loads(content)


def _normalize_quick_product_name(name: str) -> str:
    name = (name or "").strip().strip("，,。;；")
    name = re.sub(r"^(?:的|约|大约|约为)\s*", "", name)
    return name


def _quick_parse_text(text: str) -> dict | None:
    """针对简单口语文本做本地快速识别：适用于常见入库/出库描述，不依赖大模型。"""
    s = re.sub(r"\s+", "", str(text or "")).strip()
    if not s:
        return None
    lowered = s.lower()
    if any(k in lowered for k in ("入库", "进货", "采购", "进仓", "收货")):
        op_type = "inbound"
    elif any(k in lowered for k in ("出库", "销售", "卖出", "发货", "出货")):
        op_type = "outbound"
    else:
        return None

    unit_pattern = r"斤|公斤|千克|个|件|袋|包|盒|箱|份|单|桶|瓶|扎|本"
    line_pattern = re.compile(
        rf"(?P<qty>\d+(?:\.\d+)?)\s*(?P<unit>{unit_pattern})\s*(?P<product>[A-Za-z0-9\u4e00-\u9fa5][^，,。!！?？;；\n]+?)(?=(?:\d+\s*(?:{unit_pattern})|(?:，|,|。|!|！|\?|？|;|；|$)))",
        re.S,
    )
    matches = list(line_pattern.finditer(s))
    if not matches:
        alt_pattern = re.compile(
            rf"(?P<product>[A-Za-z0-9\u4e00-\u9fa5][^\d，,。!！?？;；\n]{0,20}?)\s*(?P<qty>\d+(?:\.\d+)?)\s*(?P<unit>{unit_pattern})",
            re.S,
        )
        matches = list(alt_pattern.finditer(s))
    if not matches:
        return None

    lines = []
    for idx, m in enumerate(matches):
        qty = float(m.group("qty") or 0)
        unit = m.group("unit") or "个"
        product = _normalize_quick_product_name(m.group("product"))
        if not product:
            continue
        tail = s[m.end():]
        price = 0.0
        price_patterns = [
            rf"(?:每\s*(?:{unit_pattern})|单价|每单|每份|每袋|每盒|每箱|每包|每件|每斤|每公斤|每千克)\s*(?:￥|¥)?(?P<price>\d+(?:\.\d+)?)\s*(?:元|￥|¥)",
            rf"(?:￥|¥)?(?P<price>\d+(?:\.\d+)?)\s*(?:一|两)?(?P<price_unit>{unit_pattern})\s*(?:元|￥|¥)",
            rf"(?:￥|¥)?(?P<price>\d+(?:\.\d+)?)\s*(?:一|两)?(?P<price_unit>{unit_pattern})",
            rf"(?:￥|¥)?(?P<price>\d+(?:\.\d+)?)\s*(?:元|￥|¥)",
        ]
        for pat in price_patterns:
            pm = re.search(pat, tail, re.S)
            if pm:
                price = float(pm.group("price") or 0)
                break
        if idx == 0 and price == 0:
            # 例如：今天入库了100斤木耳，25一斤 -> 取尾部的数字价格
            pm = re.search(r"(?:￥|¥)?(?P<price>\d+(?:\.\d+)?)\s*(?:一|两)?(?P<u>斤|公斤|千克|个|件|袋|包|盒|箱|份|单)", s, re.S)
            if pm:
                price = float(pm.group("price") or 0)

        lines.append({
            "product": product,
            "quantity": qty,
            "unit": unit,
            "unit_price": price,
        })
    if not lines:
        return None

    return {
        "type": op_type,
        "date": date.today().isoformat(),
        "supplier": "",
        "customer": "",
        "remark": "",
        "lines": lines,
    }


def _match_product(db: Session, name: str, want: str | None) -> Product | None:
    """按名称匹配商品：先精确，再子串包含（取匹配更长的）。want: stock/order/None=不限。"""
    name = (name or "").strip()
    if not name:
        return None
    q = db.query(Product).filter(Product.is_active.is_(True))
    if want == "stock":
        q = q.filter(Product.product_type == "stock")
    elif want == "order":
        q = q.filter(Product.product_type == "order")
    p = q.filter(Product.name == name).first()
    if p:
        return p
    cands = []
    for p in q.all():
        if name in p.name or p.name in name:
            cands.append((min(len(p.name), len(name)), p))
    if cands:
        cands.sort(key=lambda x: -x[0])
        return cands[0][1]
    return None


def _resolve_inbound_product(db: Session, name: str) -> Product | None:
    """入库必须是库存商品（大类）；若命中订单商品，则用其关联的库存商品。"""
    p = _match_product(db, name, "stock")
    if p:
        return p
    o = _match_product(db, name, "order")
    if o and o.stock_product_id:
        return db.get(Product, o.stock_product_id)
    return _match_product(db, name, None)


def _resolve_outbound_product(db: Session, name: str) -> Product | None:
    """出库优先订单商品（小类，可自动结算），否则用库存商品。"""
    p = _match_product(db, name, "order")
    if p:
        return p
    return _match_product(db, name, "stock")


def _norm_unit(unit: str, conv: dict) -> str | None:
    """把单位别名归一到商品换算表中的标准名。"""
    if not unit:
        return None
    unit = str(unit).strip()
    if unit in conv:
        return unit
    u = UNIT_ALIASES.get(unit)
    if u and u in conv:
        return u
    return unit  # 找不到标准名时原样返回，由前端兜底


def _last_price_default(db: Session, p: Product | None, op_type: str) -> float:
    """取该商品最近一次录入的价格（折算到默认展示单位）。

    入库取最近一条入库单价（回退商品参考采购单价）；出库取最近一条出库单价（回退默认售价）。
    供 AI 识别未提取到单价时默认填入。
    """
    if not p:
        return 0.0
    conv = p.conversions or {}
    du = p.default_unit or p.base_unit

    def to_du(price: float, unit: str) -> float:
        price = float(price or 0)
        if not price:
            return 0.0
        if unit and unit in conv and du in conv and conv.get(unit):
            return round(price * conv[du] / conv[unit], 4)
        return round(price, 4)

    if op_type == "inbound":
        row = db.query(Inbound).filter(Inbound.product_id == p.id).order_by(Inbound.id.desc()).first()
        if row and row.unit_price:
            return to_du(row.unit_price, row.unit)
        return to_du(p.unit_cost, p.base_unit)
    row = db.query(OutboundLine).filter(OutboundLine.product_id == p.id).order_by(OutboundLine.id.desc()).first()
    if row and row.unit_price:
        return to_du(row.unit_price, row.unit)
    return to_du(p.sale_price, p.base_unit)


def _normalize_line(db: Session, p: Product | None, line: dict, op_type: str, auto_created: bool = False) -> dict:
    """把 数量/单价 换算到商品的默认展示单位（如 公斤），并保留原始值供前端参考。

    若用户未录入单价，则按该商品上次录入的价格默认填入（不再换算为 0）。
    """
    name = (line.get("product") or "").strip()
    qty = float(line.get("quantity") or 0)
    unit = str(line.get("unit") or "").strip()
    price = float(line.get("unit_price") or 0)

    out = {
        "product_id": 0,
        "product_name": name,
        "quantity": qty,
        "unit": unit,
        "unit_price": price,
        "matched": False,
        "auto_created": bool(auto_created),
        "price_defaulted": False,
        "hint": "",
    }
    if not p:
        out["hint"] = "未匹配到系统商品，请手动选择" + ("（已自动新增为新商品）" if auto_created else "")
        return out

    conv = p.conversions or {}
    du = p.default_unit or p.base_unit
    u = _norm_unit(unit, conv)
    out["product_id"] = p.id
    out["product_name"] = p.name
    out["matched"] = True
    out["hint"] = f"已匹配「{p.name}」（{p.product_type}）" + ("，🆕 自动新增" if auto_created else "")

    # 换算到默认展示单位：数量与单价都折算到 1 个默认单位
    if u and u in conv and du in conv and conv.get(u):
        qty_default = qty * conv[u] / conv[du]
        out["quantity"] = round(qty_default, 4)
        out["unit"] = du
        if price:
            out["unit_price"] = round(price * conv[du] / conv[u], 4)
    else:
        # 换算表没有该单位：尝试 斤<->公斤 兜底
        if u == "斤" and "公斤" in conv:
            out["quantity"] = round(qty * 0.5, 4)
            out["unit"] = "公斤"
            if price:
                out["unit_price"] = round(price * 2, 4)
        elif u in ("公斤", "千克") and "公斤" in conv:
            out["quantity"] = round(qty, 4)
            out["unit"] = "公斤"
        else:
            out["unit"] = du if du else unit
            out["hint"] += "；未能换算单位，请核对"

    # 用户未录入单价（仍为 0）：按该商品上次录入的价格默认填入（已是默认单位，不再换算）
    if not out["unit_price"]:
        last = _last_price_default(db, p, op_type)
        if last:
            out["unit_price"] = round(last, 4)
            out["price_defaulted"] = True
            out["hint"] += "；价格未识别，已按上次录入单价默认填入，请核对"
    return out


def _user_msg(text: str) -> str:
    """构造发送给模型的用户消息：显式告知今天日期避免模型幻觉。"""
    return f"今天是 {date.today().isoformat()}（务必以这个日期作为\"今天\"）。\n\n【用户描述】\n{text}"


def _build_result(db: Session, parsed: dict, text: str) -> dict:
    """把模型抽取结果规范化：校验类型/日期，匹配商品，换算单位。"""
    op_type = str(parsed.get("type", "")).strip().lower()
    if op_type not in ("inbound", "outbound"):
        raise HTTPException(400, "无法识别业务类型（入库/出库），请换个说法")
    lines_in = parsed.get("lines") or []
    if not lines_in:
        raise HTTPException(400, "未能从描述中提取商品明细，请补充商品名称、数量与价格")

    resolver = _resolve_inbound_product if op_type == "inbound" else _resolve_outbound_product
    lines = []
    for ln in lines_in:
        p = resolver(db, ln.get("product", ""))
        auto = False
        if p is None and op_type == "inbound":
            # 入库的新物品：自动新增库存商品（含新单位），并标记 auto_created
            p = _auto_create_stock(db, ln.get("product", ""), ln.get("unit", ""))
            auto = True
        lines.append(_normalize_line(db, p, ln, op_type, auto_created=auto))
    if any(ln.get("auto_created") for ln in lines):
        db.commit()  # 持久化自动新增的商品与单位，否则会话结束即回滚

    # 日期校验：格式非法/为空时回退为今天，避免模型幻觉日期
    try:
        pd = str(parsed.get("date") or "").strip()
        d = date.fromisoformat(pd) if pd else date.today()
    except ValueError:
        d = date.today()

    return {
        "type": op_type,
        "date": d.isoformat(),
        "supplier": str(parsed.get("supplier") or ""),
        "customer": str(parsed.get("customer") or ""),
        "remark": str(parsed.get("remark") or ""),
        "lines": lines,
        "raw": text,
    }


@router.post("/parse")
def parse_ai(data: ParseIn, db: Session = Depends(get_db), user: User = Depends(get_current_user)):
    text = (data.text or "").strip()
    if not text:
        raise HTTPException(400, "请输入描述文字")
    quick = _quick_parse_text(text)
    if quick:
        try:
            return _build_result(db, quick, text)
        except HTTPException:
            raise
    cfg = _llm_config()
    if not cfg.get("api_key"):
        raise HTTPException(400, "未配置 LLM（product_rules.json 的 llm 段）")
    try:
        parsed = _extract_json(_chat(cfg, SYSTEM_PROMPT, _user_msg(text)))
        return _build_result(db, parsed, text)
    except HTTPException:
        raise
    except Exception as e:
        raise HTTPException(502, f"调用/解析大模型失败：{type(e).__name__}: {e}")


@router.post("/parse/stream")
def parse_stream(data: ParseIn, db: Session = Depends(get_db), user: User = Depends(get_current_user)):
    """流式解析：优先返回本地快速识别结果，随后补全大模型精修结果。"""
    text = (data.text or "").strip()
    if not text:
        raise HTTPException(400, "请输入描述文字")
    cfg = _llm_config()
    if not cfg.get("api_key"):
        raise HTTPException(400, "未配置 LLM（product_rules.json 的 llm 段）")

    def event(obj: dict) -> str:
        return f"data: {json.dumps(obj, ensure_ascii=False)}\n\n"

    def gen():
        try:
            quick = _quick_parse_text(text)
            if quick:
                try:
                    quick_result = _build_result(db, quick, text)
                    # 本地快速识别已成功：直接返回，不再调用慢速大模型（识别即出结果）
                    yield event({"result": quick_result, "source": "quick", "confidence": "high"})
                    return
                except HTTPException:
                    pass
            buf = ""
            for delta in _chat_stream(cfg, SYSTEM_PROMPT, _user_msg(text)):
                buf += delta
                yield event({"delta": delta})
            result = _build_result(db, _extract_json(buf), text)
            yield event({"result": result, "source": "llm", "confidence": "high"})
        except HTTPException as e:
            yield event({"error": e.detail})
        except Exception as e:
            yield event({"error": f"{type(e).__name__}: {e}"})
        yield event({"done": True})

    return StreamingResponse(gen(), media_type="text/event-stream")


def _image_data_uri(data: bytes, filename: str) -> str:
    """把上传的图片字节转成 data URI（base64），供多模态模型使用。"""
    import base64

    ext = Path(filename).suffix.lower().lstrip(".")
    mime = {
        "png": "image/png", "jpg": "image/jpeg", "jpeg": "image/jpeg",
        "gif": "image/gif", "webp": "image/webp", "bmp": "image/bmp",
    }.get(ext, "image/jpeg")
    b64 = base64.b64encode(data).decode("ascii")
    return f"data:{mime};base64,{b64}"


def _save_invoice(data: bytes, filename: str) -> str:
    """把票据图片保存到 data/uploads，返回可公开访问的 /uploads/xxx.jpg 相对路径。"""
    UPLOAD_DIR.mkdir(parents=True, exist_ok=True)
    ext = Path(filename).suffix.lower()
    if ext not in (".png", ".jpg", ".jpeg", ".gif", ".webp", ".bmp"):
        ext = ".jpg"
    name = f"invoice_{datetime.now().strftime('%Y%m%d_%H%M%S_%f')}{ext}"
    (UPLOAD_DIR / name).write_bytes(data)
    return f"/uploads/{name}"


@router.post("/parse-image/stream")
async def parse_image_stream(
    file: UploadFile = File(...),
    text: str = Form(""),
    db: Session = Depends(get_db),
    user: User = Depends(get_current_user),
):
    """多模态图片识别：识别采购票据（发票/送货单），自动新增新商品与新单位。

    流式返回，最后推送规范化结果（含 auto_created 标记）。
    """
    cfg = _llm_config()
    if not cfg.get("api_key"):
        raise HTTPException(400, "未配置 LLM（product_rules.json 的 llm 段）")
    data = await file.read()
    if not data:
        raise HTTPException(400, "未读取到图片内容")
    # 保存票据图片，供确认框预览与记录备注引用
    image_url = _save_invoice(data, file.filename or "invoice.jpg")

    user_msg = (
        f"今天是 {date.today().isoformat()}（务必以这个日期作为\"今天\"）。"
        "请识别这张采购票据图片。"
        + (f"补充说明：{text}" if (text or "").strip() else "")
    )

    def event(obj: dict) -> str:
        return f"data: {json.dumps(obj, ensure_ascii=False)}\n\n"

    def gen():
        try:
            uri = _image_data_uri(data, file.filename or "invoice.jpg")
            buf = ""
            for delta in _chat_stream_mm(cfg, IMAGE_SYSTEM_PROMPT, user_msg, uri):
                buf += delta
                yield event({"delta": delta})
            result = _build_result(db, _extract_json(buf), text or "(图片票据识别)")
            result["image_url"] = image_url  # 供前端确认框展示与备注挂图
            yield event({"result": result})
        except HTTPException as e:
            yield event({"error": e.detail})
        except Exception as e:
            yield event({"error": f"{type(e).__name__}: {e}"})
        yield event({"done": True})

    return StreamingResponse(gen(), media_type="text/event-stream")
