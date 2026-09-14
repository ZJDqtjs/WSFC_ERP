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
CONFIG_FILE = ROOT.parent / "product_rules.json"

# AI 票据图片保存目录（backend/data/uploads）：记录备注可引用 /uploads/xxx.jpg 预览
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
4. category 商品分类：逐条判断该商品属于哪一类，按以下四选一输出原词：
   - "库存商品"：采购入库/库存货品（如 木耳、佛手柑大果、七彩土豆）
   - "订单商品"：销售的小规格商品（如 佛手柑大果2个、七彩土豆3斤）
   - "包材"：包装材料（如 纸箱、泡沫箱、胶带、保鲜袋）
   - "人工"：打包人工/劳务（如 某某打包、人工打包费）
   无法判断时不输出该字段（省略）。
5. 日期 date：用户没说具体日期就用"今天"（今天的日期见用户消息），格式 YYYY-MM-DD。
6. supplier（入库时的供应商）/ customer（出库时的客户）/ remark（备注）：有则提取，没有给空字符串。
7. 一句话可能包含多行/多个商品，lines 里逐行列出；单价统一理解为"每 unit 单位的金额"。

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
    { "category": "库存商品", "product": "商品名称", "quantity": 100, "unit": "斤", "unit_price": 25 }
  ]
}"""

IMAGE_SYSTEM_PROMPT = """你是「企业台账系统」的采购票据识别助手。用户会提供一张采购发票 / 送货单 / 销货单的图片（如公司进货凭证），请从中提取采购信息。

处理要求：
1. 业务类型一律为入库（inbound）：这些票据代表公司采购了货物进入仓库。
2. 逐条提取每条采购商品的：商品名称（product，按票据原文，简洁）、数量（quantity）、单位（unit，如 张/个/斤/公斤/袋/箱）、单价（unit_price，每单位的金额，保留小数）。
3. category 商品分类：逐条判断属于"库存商品"（货品/蔬菜/干货）、"包材"（纸箱/泡沫箱/胶带/包装袋等包装材料）、还是"人工"（打包劳务）；销售小规格的"订单商品"一般不出现，出现也按"库存商品"处理。无法判断时不输出该字段（省略）。
4. supplier：票据上的销方（卖方）公司名称；customer 留空。
5. 日期 date：票据上若有日期就用它（格式 YYYY-MM-DD），没有就用"今天"（今天的日期见用户消息）。
6. remark：可留空。
7. 票据可能有多张/多条，lines 逐条列出；金额合计不用输出。

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
    { "category": "库存商品", "product": "商品名称", "quantity": 100, "unit": "个", "unit_price": 0.5 }
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
        max_tokens=1600,  # 放宽，避免长内容被截断
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
        max_tokens=1600,  # 长表述也可能较长，放宽到 1600
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
        max_tokens=3200,  # 票据商品多、JSON 长，放宽以免截断
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


# AI 商品分类：库存商品 stock / 订单商品 order / 包材 pack / 人工 labor
AI_CATEGORIES = ("stock", "order", "pack", "labor")
AI_CATEGORY_LABELS = {
    "stock": "库存商品",
    "order": "订单商品",
    "pack": "包材",
    "labor": "人工",
}
_AI_ALIAS_TO_CAT = {}
for _cat, _aliases in {
    "stock": ("库存商品", "库存", "商品", "stock", "货品"),
    "order": ("订单商品", "订单", "order", "销售商品"),
    "pack": ("包材", "包装材料", "包装耗材", "耗材", "包装", "pack"),
    "labor": ("人工", "劳务", "打包", "labor", "工费"),
}.items():
    for _a in _aliases:
        _AI_ALIAS_TO_CAT.setdefault(_a, _cat)

# 包材识别关键字（用于本地兜底/新建商品归类）
PACK_KEYWORDS = (
    "纸箱", "拖箱", "果箱", "泡沫箱", "保温箱", "周转箱", "编织袋", "保鲜袋",
    "包装袋", "胶带", "气泡膜", "珍珠棉", "冰袋", "内膜袋", "牛皮纸", "封箱",
    "气柱", "吸塑", "拉链袋", "自封袋", "网兜", "彩盒", "礼盒盒",
    # 「号箱」「箱子」：票据里常只写「6号箱」「冰糖橙箱子」，缺这些关键字会被判成非包材，
    # 从而走不到包材的等价匹配（「6号箱」↔「6号纸箱」）。
    "号箱", "箱子",
)


def _normalize_category(raw: str) -> str:
    """把 LLM 输出的分类原文归一到内部标识 stock/order/pack/labor；无法识别返回空串。"""
    s = (str(raw or "").strip().lower())
    if not s:
        return ""
    best, blen = "", -1
    for alias, cat in _AI_ALIAS_TO_CAT.items():
        if alias in s and len(alias) > blen:
            blen, best = len(alias), cat
    return best


def _product_category(p: Product | None) -> str:
    """按商品档案反推其 AI 分类标识：订单商品/人工/包材/库存商品。"""
    if not p:
        return ""
    cat = (p.category or "").strip()
    name = (p.name or "")
    if p.product_type == "order":
        return "order"
    if cat == "人工" or name.endswith("打包"):
        return "labor"
    if cat in ("包材", "耗材", "包装"):
        return "pack"
    return "stock"


def _guess_category(name: str) -> str:
    """本地兜底：按名称猜测分类（名称带打包/人工 -> 人工；含包材关键字 -> 包材）。"""
    name = (name or "")
    if name.endswith("打包") or name.endswith("人工") or "人工" in name:
        return "labor"
    if any(k in name for k in PACK_KEYWORDS):
        return "pack"
    return ""


def _auto_create_product(db: Session, name: str, unit: str, cat: str) -> Product:
    """按分类自动新增商品档案（采购新物品/新包材/新人工），并自动补齐单位。返回新商品。"""
    name = (name or "").strip()
    if not name:
        raise HTTPException(400, "商品名称为空，无法自动新增")
    _ensure_unit(db, unit or "个")
    u = (unit or "个").strip()
    if cat == "labor":
        category, ptype = "人工", "stock"
    elif cat == "pack":
        category, ptype = "包材", "stock"
    elif cat == "order":
        category, ptype = "商品", "order"
    else:
        category, ptype = "商品", "stock"
    p = Product(
        name=name,
        category=category,
        product_type=ptype,
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


def _new_product_meta(name: str, cat: str) -> dict:
    """计算「待新增商品」的档案信息（纯计算，不写库）。

    识别阶段只返回该预览信息，用户点「确认提交」时才由 _auto_create_product 真正建档，
    避免用户取消/关闭确认框也在商品资料里留下新的商品类型与包材。
    """
    cat = cat if cat in AI_CATEGORIES else "stock"
    if cat == "labor":
        category, ptype = "人工", "stock"
    elif cat == "pack":
        category, ptype = "包材", "stock"
    elif cat == "order":
        category, ptype = "商品", "order"
    else:
        category, ptype = "商品", "stock"
    return {
        "name": (name or "").strip(),
        "category": cat,
        "category_label": category,
        "product_type": ptype,
    }


def _repair_truncated_json(content: str) -> dict:
    """模型输出被 max_tokens 截断时，按括号配平补上缺失的闭合括号，尽量恢复为合法 JSON。

    适用场景：长票据/长描述导致 JSON 不完整（对象/数组未闭合）。
    """
    base = content.strip()
    if base.endswith(","):
        base = base[:-1].rstrip()
    stack = []
    in_str = esc = False
    for ch in base:
        if in_str:
            if esc:
                esc = False
            elif ch == "\\":
                esc = True
            elif ch == '"':
                in_str = False
            continue
        if ch == '"':
            in_str = True
        elif ch == "{":
            stack.append("}")
        elif ch == "[":
            stack.append("]")
        elif ch in "}]" and stack:
            stack.pop()
    tail = "".join(reversed(stack))
    if tail:
        try:
            return json.loads(base + tail)
        except ValueError:
            pass
    raise ValueError("模型输出无法解析为 JSON（可能被截断）")


def _extract_json(content: str) -> dict:
    """从模型输出中稳健提取 JSON（兼容 markdown 代码块 / 前后杂文 / 截断）。"""
    content = content.strip()
    m = re.search(r"\{.*\}", content, re.S)
    if m:
        content = m.group(0)
    try:
        return json.loads(content)
    except ValueError:
        pass
    return _repair_truncated_json(content)


# 快速解析时误并入商品名开头的动作词/时间词（「入库苹果10箱」→「苹果」）
_QUICK_LEAD_RE = re.compile(
    r"^(?:今天|昨天|前天|今早|上午|下午|晚上|早上|刚才|刚刚)?"
    r"(?:入库|进货|采购|进仓|收货|出库|销售|卖出|发货|出货)+了*"
)


def _normalize_quick_product_name(name: str) -> str:
    name = (name or "").strip().strip("，,。;；")
    name = re.sub(r"^(?:的|约|大约|约为)\s*", "", name)
    # 名称写在数量之前时（如「入库苹果10箱」），正则会把开头的动作词一起吃进名称，这里去掉；
    # 只有去掉后仍剩 ≥2 个字才替换，避免误伤「出库费」这类真实商品名。
    stripped = _QUICK_LEAD_RE.sub("", name)
    if stripped != name and len(stripped) >= 2:
        name = stripped
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
        # 名称在数量之前（如「入库6号纸箱100个」）。
        # 注意：f-string 里正则量词的花括号必须写成 {{0,20}}，写成 {0,20} 会被当成格式字段，
        # 编译出的正则变成「[^...]0?」，商品名只能匹配到 2 个字（「6号纸箱」被截成「纸箱」），
        # 结果匹配不到具体商品（只能匹配到一堆相似商品），价格也就无从回填。
        alt_pattern = re.compile(
            rf"(?P<product>[A-Za-z0-9\u4e00-\u9fa5][^\d，,。!！?？;；\n]{{0,20}}?)\s*(?P<qty>\d+(?:\.\d+)?)\s*(?P<unit>{unit_pattern})",
            re.S,
        )
        matches = list(alt_pattern.finditer(s))
    if not matches:
        return None

    lines = []
    for idx, m in enumerate(matches):
        qty = float(m.group("qty") or 0)
        unit = m.group("unit") or "个"
        raw_product = m.group("product") or ""
        # 名称里含数字且写在数量之前的写法（如「入库20*30*10纸箱100个」），可能只截到后半段（「0纸箱」）：
        # 若商品名以数字开头且紧邻的前一个字符也是数字，说明只是更长词条的一截，丢弃该行交给大模型。
        if raw_product[:1].isdigit() and m.start("product") > 0 and s[m.start("product") - 1].isdigit():
            continue
        product = _normalize_quick_product_name(raw_product)
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
            # 兜底：价格写在本行数量之前时（如「25元一斤的木耳100斤」）。
            # 只在本行数量之外查找，且必须带价格特征（元/¥ 或「一/两+单位」），
            # 否则会把数量本身（如「100个」）误当成单价（旧实现就因此把 100 当成价格）。
            others = s[: m.start()] + tail
            pm = re.search(
                rf"(?:￥|¥)?(?P<price>\d+(?:\.\d+)?)\s*(?:元|￥|¥|(?:一|两)(?:{unit_pattern}))",
                others,
                re.S,
            )
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
    """按名称匹配商品：先精确（忽略空白），再子串包含（取匹配更长的）。want: stock/order/None=不限。"""
    name = (name or "").strip()
    if not name:
        return None
    qkey = _tight(name)
    q = db.query(Product).filter(Product.is_active.is_(True))
    if want == "stock":
        q = q.filter(Product.product_type == "stock")
    elif want == "order":
        q = q.filter(Product.product_type == "order")
    p = q.filter(Product.name == name).first()
    if p:
        return p
    rows = q.all()
    for p in rows:  # 忽略空白的同名（模型常把「8号拖箱」写成「8 号拖箱」）
        if _tight(p.name) == qkey:
            return p
    cands = []
    for p in rows:
        pn = _tight(p.name)
        if qkey in pn or pn in qkey:
            cands.append((min(len(pn), len(qkey)), p))
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


def _match_by_category(db: Session, name: str, cat: str) -> Product | None:
    """在指定 AI 分类内按名称匹配商品（精确→子串，取更长）。"""
    name = (name or "").strip()
    if not name or cat not in AI_CATEGORIES:
        return None
    q = db.query(Product).filter(Product.is_active.is_(True))
    if cat == "order":
        q = q.filter(Product.product_type == "order")
    elif cat == "pack":
        q = q.filter(Product.category.in_(("包材", "耗材", "包装")))
    elif cat == "labor":
        q = q.filter(Product.category == "人工")
    else:  # stock：库存商品（排除 人工/包材/耗材/包装）
        q = q.filter(
            Product.product_type == "stock",
            ~Product.category.in_(("人工", "包材", "耗材", "包装")),
        )
    p = q.filter(Product.name == name).first()
    if p:
        return p
    qkey = _tight(name)
    rows = q.all()
    for c in rows:
        if _tight(c.name) == qkey:      # 忽略空白的同名（如票据「8 号拖箱」↔ 档案「8号拖箱」）
            return c
    best, blen = None, -1
    for c in rows:
        cn = _tight(c.name)
        if qkey in cn or cn in qkey:
            m = min(len(cn), len(qkey))
            if m > blen:
                blen, best = m, c
    return best


def _resolve_line(db: Session, name: str, op_type: str, cat: str) -> Product | None:
    """按分类优先匹配商品；未命中再回退业务类型默认解析（入库库存，出库订单优先）。

    指定分类时：仅在对应分类内匹配；无命中时只做全局精确名称匹配，
    不做跨分类子串回退（避免把「xx打包」人工错配到「xx」库存商品）。
    未指定分类时：沿用业务类型默认解析。
    """
    if cat in AI_CATEGORIES:
        p = _match_by_category(db, name, cat)
        if p:
            return p
        p = db.query(Product).filter(Product.is_active.is_(True), Product.name == name).first()
        if p:
            return p
        return None
    if op_type == "inbound":
        return _resolve_inbound_product(db, name)
    return _resolve_outbound_product(db, name)


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


def _tight(s: str) -> str:
    """名称归一：去掉所有空白，便于与商品档案名比较（模型常输出「8 号拖箱」）。"""
    return re.sub(r"\s+", "", s or "")


def _pack_key(s: str) -> str:
    """包材宽松名：去空白、去“纸/拖”等箱型限定词，用于「9号箱」↔「9号纸箱」的等价判断。"""
    return _tight(s).replace("纸", "").replace("拖", "")


def _line_candidates(db: Session, name: str, op_type: str, cat: str) -> list[Product]:
    """收集该识别名称下的候选商品（精确同名优先，其次近似名），供前端让用户选择。

    - 近似：名称互相包含（如「9号箱」↔「9号纸箱」）
    - 触发提示的条件：无完全同名、但存在近似名（由调用方判定 ambiguous）
    - 包材额外做宽松匹配：去掉空白与“纸/拖”后按等价/包含判断，避免「9 号箱」匹配不到「9号纸箱」
    """
    name = (name or "").strip()
    if not name:
        return []
    rows = []
    if cat in AI_CATEGORIES:
        q = db.query(Product).filter(Product.is_active.is_(True))
        if cat == "order":
            q = q.filter(Product.product_type == "order")
        elif cat == "pack":
            q = q.filter(Product.category.in_(("包材", "耗材", "包装")))
        elif cat == "labor":
            q = q.filter(Product.category == "人工")
        else:  # stock：库存商品（排除 人工/包材/耗材/包装）
            q = q.filter(
                Product.product_type == "stock",
                ~Product.category.in_(("人工", "包材", "耗材", "包装")),
            )
        rows = q.all()
    else:
        rows = db.query(Product).filter(Product.is_active.is_(True)).all()
    qname = _tight(name)
    qkey = _pack_key(name) if cat == "pack" else qname
    exact = []
    for p in rows:
        if _tight(p.name) == qname:          # 同名（忽略空白）
            exact.append(p)
        elif cat == "pack" and _pack_key(p.name) == qkey and _tight(p.name) != qname:
            exact.append(p)
    # 去重（按 id）
    seen = {p.id for p in exact}
    sub = []
    for p in rows:
        if p.id in seen:
            continue
        pn = _tight(p.name)
        hit = (qname in pn or pn in qname)
        if not hit and cat == "pack":
            pkey = _pack_key(p.name)
            hit = (qkey in pkey or pkey in qkey)
        if hit:
            sub.append(p)
    sub.sort(key=lambda p: -min(len(_tight(p.name)), len(qname)))
    return exact + sub


def _normalize_line(db: Session, p: Product | None, line: dict, op_type: str, auto_created: bool = False, category: str = "") -> dict:
    """把 数量/单价 换算到商品的默认展示单位（如 公斤），并保留原始值供前端参考。

    若用户未录入单价，则按该商品上次录入的价格默认填入（不再换算为 0）。
    category: AI 分类标识 stock/order/pack/labor（用于前端分级下拉）。
    """
    name = (line.get("product") or "").strip()
    qty = float(line.get("quantity") or 0)
    unit = str(line.get("unit") or "").strip()
    price = float(line.get("unit_price") or 0)

    out = {
        "product_id": 0,
        "product_name": name,
        "category": category,
        "quantity": qty,
        "unit": unit,
        "unit_price": price,
        "matched": False,
        "auto_created": bool(auto_created),
        "price_defaulted": False,
        "ambiguous": False,
        "candidates": [],
        "unit_conflict": False,
        "unit_conflict_msg": "",
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
    out["category"] = _product_category(p) or category
    out["hint"] = f"已匹配「{p.name}」（{AI_CATEGORY_LABELS.get(out['category'], p.product_type)}）" + ("，🆕 自动新增" if auto_created else "")

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

    # 单位冲突检测：识别原始单位 与 商品库存/展示单位 不一致时，提示用户确认换算
    raw_unit = _norm_unit(unit, conv) or (unit or "")  # 归一化后的识别单位
    stored_unit = du or p.base_unit
    if (
        out["unit"]                       # 已换算出的目标单位
        and raw_unit
        and stored_unit
        and raw_unit != stored_unit
        and raw_unit != out["unit"]
        and not (auto_created)            # 自动新增不冲突
    ):
        out["unit_conflict"] = True
        out["unit_conflict_msg"] = (
            f"识别单位为「{raw_unit}」，商品「{p.name}」当前按「{stored_unit}」记录，"
            f"已换算为「{out['unit']}」，请核对数量与单位"
        )
        out["hint"] += f"；⚠ {out['unit_conflict_msg']}"

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

    lines = []
    for ln in lines_in:
        name = ln.get("product", "")
        cat = _normalize_category(ln.get("category", ""))
        if not cat:
            cat = _guess_category(name)
        p = _resolve_line(db, name, op_type, cat)
        auto = False
        cands = _line_candidates(db, name, op_type, cat)
        if cat == "pack":
            # 包材判定分三级，优先级从高到低：
            #   ① 同名（忽略空白）：票据「8号拖箱」必须命中档案里的「8号拖箱」，绝不串到「8号纸箱」
            #   ② 去「纸/拖」等限定词后等价且唯一：「3号箱」→「3号纸箱」
            #   ③ 前缀近似且唯一：「松茸6号」→「松茸6号箱」
            # 仍剩多个候选（如「8号箱」同时对上 8号纸箱 / 8号拖箱）才算歧义，交给用户挑选。
            qname = _tight(name)
            qkey = _pack_key(name)
            exact_name = [c for c in cands if _tight(c.name) == qname]
            loose = [c for c in cands if c not in exact_name and _pack_key(c.name) == qkey]
            sub = [
                c for c in cands
                if c not in exact_name and c not in loose
                and (
                    _pack_key(c.name).startswith(qkey) or qkey.startswith(_pack_key(c.name))
                )
            ]
            cands = exact_name + loose + sub
            if exact_name:
                exact_hit = True
                p = exact_name[0]
            elif len(loose) == 1:
                exact_hit = True
                p = loose[0]
            elif not loose and len(sub) == 1:
                exact_hit = True
                p = sub[0]
            else:
                exact_hit = False
                p = None       # 没有/有多个等价 → 交由用户选择
        else:
            exact_hit = any(c.name == name for c in cands)
            if p is None and exact_hit:
                # 有精确同名但被分类过滤漏掉（罕见），直接采用精确同名
                for c in cands:
                    if c.name == name:
                        p = c
                        break
        similar = [c for c in cands if c.id != (p.id if p else None)]
        # 存在近似候选且无完全同名 => 歧义：不自动新增，交由用户在候选里挑选
        ambiguous = bool(similar) and not exact_hit
        pending_new = None
        if p is None and not ambiguous and op_type == "inbound":
            # 入库的新物品（无任何相似商品）：识别阶段只生成「待新增档案」预览，绝不写库。
            # 用户点「确认提交」时才真正建档（见 materialize_products），取消则不产生任何商品/包材数据。
            pending_new = _new_product_meta(_tight(name), cat or "stock")
            auto = True
        category = _product_category(p) if p else (cat or "")
        ln_out = _normalize_line(db, p, ln, op_type, auto_created=auto, category=category)
        ln_out["ambiguous"] = ambiguous
        ln_out["candidates"] = (
            [
                {
                    "product_id": c.id,
                    "name": c.name,
                    "category": _product_category(c),
                    "unit": c.default_unit or c.base_unit,
                    "last_price": _last_price_default(db, c, op_type),  # 供前端选中候选后回填价格
                }
                for c in cands
            ]
            if ambiguous else []
        )
        if pending_new:
            ln_out["product_name"] = pending_new["name"]     # 用归一后的名称（去掉模型多余空格）
            ln_out["new_product"] = {**pending_new, "unit": (ln.get("unit") or "").strip() or "个"}
            ln_out["hint"] = (
                f"🆕 系统暂无此商品，确认提交后将新增到「{pending_new['category_label']}」，"
                f"新商品没有历史价，请填写单价（取消不会创建）"
            )
        if ambiguous:
            names = "、".join(c["name"] for c in ln_out["candidates"])
            ln_out["hint"] = f"⚠ 识别到多个相似商品（{names}），请确认选哪一个"
            # 歧义行也先按默认候选（列表第一个，即前端默认选中的那个）的最近价填入，
            # 免得用户看到空单价；用户改选其他候选时前端会跟着刷新。
            if not ln_out["unit_price"] and ln_out["candidates"] and ln_out["candidates"][0]["last_price"]:
                first = ln_out["candidates"][0]
                ln_out["unit_price"] = first["last_price"]
                ln_out["price_defaulted"] = True
                ln_out["hint"] += f"；已按默认候选「{first['name']}」最近价 {first['last_price']} 填入，请核对"
        lines.append(ln_out)

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


class NewProductIn(BaseModel):
    name: str
    category: str = "stock"
    unit: str = ""


class MaterializeIn(BaseModel):
    items: list[NewProductIn]


@router.post("/products")
def materialize_products(
    data: MaterializeIn,
    db: Session = Depends(get_db),
    user: User = Depends(get_current_user),
):
    """确认提交时，把识别出的「新物品」真正写入商品档案。

    识别阶段（/parse、/parse/stream、/parse-image/stream）不写库；
    只有用户点「确认提交」调用本接口后才创建商品（含商品类型/包材/单位）；
    同名商品已存在则直接复用，不重复创建。
    """
    results = []
    created_any = False
    for it in data.items:
        name = (it.name or "").strip()
        if not name:
            continue
        p = db.query(Product).filter(Product.name == name).first()
        created = False
        if not p:
            p = _auto_create_product(db, name, (it.unit or "").strip() or "个", it.category or "stock")
            created = True
        results.append({
            "name": name,
            "product_id": p.id,
            "category": _product_category(p),
            "created": created,
        })
        created_any = created_any or created
    if created_any:
        db.commit()
    return {"items": results}


@router.get("/last-price")
def last_price(
    product_id: int,
    op_type: str = "inbound",
    db: Session = Depends(get_db),
    user: User = Depends(get_current_user),
):
    """返回某商品最近一次的录入单价（折算到默认展示单位），供确认框切换商品后回填价格。"""
    p = db.get(Product, product_id)
    if not p:
        raise HTTPException(404, "商品不存在")
    price = _last_price_default(db, p, "outbound" if op_type == "outbound" else "inbound")
    return {"product_id": p.id, "price": price, "unit": p.default_unit or p.base_unit, "op_type": op_type}
