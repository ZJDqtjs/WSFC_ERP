"""代发账单核对：用户上传供应商/分仓的销售明细（图片或 Excel），
自动与「待付款账单 → 代发」里的代发成本逐日逐商品比对，输出成本差异核对视图。

口径：
- 单据侧（用户上传）：数量、单价、价税合计，按「日期 + 商品家族」聚合；
- 系统侧（代发账单）：DropshipBill.amount（= 代发成本，即付给代发方的钱），同样按「日期 + 商品家族」聚合；
- 商品家族：商品名去掉规格数字/单位（如「老味道番茄净重3斤80g+」→「老味道番茄」），
  这样单据里的「电商小果1.5斤/箱」与系统的「老味道番茄净重3斤80g+」可归到同一家族核对总额；
- 差异 = 单据金额 − 系统代发成本（正数=账单比系统高，系统少记；负数=系统多记）。

补充说明里可写商品别名（如「电商果是老味道番茄，牧心果是牧心番茄」），
与 AI 录入共用一套别名解析规则，用来把单据商品名映射到系统商品。
"""
from __future__ import annotations

import csv
import difflib
import io
import re
from datetime import date as _date
from datetime import datetime, timedelta
from functools import lru_cache

from fastapi import APIRouter, Depends, File, Form, HTTPException, UploadFile
from openpyxl import load_workbook
from sqlalchemy import select
from sqlalchemy.orm import Session

from ..auth import get_current_user
from ..database import get_db
from ..models import DropshipBill, Product, User
from .ai import (
    _alias_ok,
    _alias_side,
    _extract_json,
    _image_data_uri,
    _llm_config,
    _make_client,
    _parse_aliases,
)

router = APIRouter(prefix="/api/reconcile", tags=["reconcile"])

# 表头列识别（同一字段的多种叫法）
HEADER_ALIASES = {
    "date": ("单据日期", "日期", "出库日期", "业务日期", "销售日期"),
    "product": ("商品名称", "商品", "货品名称", "品名", "货品"),
    "unit": ("单位", "计量单位"),
    "quantity": ("数量", "销售数量", "下单数量", "件数", "箱数"),
    "unit_price": ("单价", "销售单价", "成本单价", "价格"),
    "amount": ("价税合计", "金额", "合计金额", "小计", "销售额", "含税金额"),
}

# 商品家族归一：去掉规格数字、重量单位、包装容器词
_CORE_STRIP = (
    "净重", "礼盒装", "礼盒", "公斤", "千克", "kg", "斤", "克", "g",
    "袋", "包", "盒", "箱", "个", "件", "份", "装", "单", "桶", "瓶", "扎", "本",
    "特大", "特果", "大果", "中果", "小果",
)


@lru_cache(maxsize=4096)
def _core(name: str) -> str:
    """商品家族核心名：去数字/单位/规格修饰，用于跨规格聚合核对。"""
    s = str(name or "").lower()
    s = re.sub(r"[\d.]+", "", s)
    s = re.sub(r"\s+", "", s).replace("/", "").replace("+", "").replace("（", "").replace("）", "")
    for w in _CORE_STRIP:
        s = s.replace(w, "")
    return s


def _num(v) -> float:
    if isinstance(v, (int, float)):
        return float(v)
    s = str(v or "").strip().replace("￥", "").replace("¥", "").replace(",", "").replace("元", "")
    try:
        return float(s)
    except (TypeError, ValueError):
        return 0.0


def _to_date(v) -> str:
    """把 Excel 单元格 / 文本日期统一成 YYYY-MM-DD。"""
    if isinstance(v, datetime):
        return v.date().isoformat()
    if isinstance(v, _date):
        return v.isoformat()
    # Excel 未设日期格式时会读到序列号（1900 起算）
    if isinstance(v, (int, float)) and 20000 <= float(v) <= 80000:
        return (datetime(1899, 12, 30) + timedelta(days=float(v))).date().isoformat()
    s = str(v or "").strip()
    m = re.search(r"(\d{4})[-/.年](\d{1,2})[-/.月](\d{1,2})", s)
    if m:
        return f"{int(m.group(1)):04d}-{int(m.group(2)):02d}-{int(m.group(3)):02d}"
    return ""


def _norm_cell(v) -> str:
    return str(v or "").strip().replace("*", "").replace(" ", "").replace("\u3000", "")


def _detect_header(rows: list[list]) -> tuple[dict[str, int], int]:
    """扫描前 20 行找表头，返回 {字段: 列下标} 与数据起始行。"""
    flat = {name for names in HEADER_ALIASES.values() for name in names}
    for idx, row in enumerate(rows[:20]):
        cells = {_norm_cell(c) for c in row if _norm_cell(c)}
        if len(cells & flat) < 2:
            continue
        mapping: dict[str, int] = {}
        for i, c in enumerate(row):
            c = _norm_cell(c)
            for field, names in HEADER_ALIASES.items():
                if c in names and field not in mapping:
                    mapping[field] = i
        if "product" in mapping and ("quantity" in mapping or "amount" in mapping):
            return mapping, idx + 1
    raise HTTPException(400, "未找到表头（需要包含：商品名称 / 数量 / 金额 等列）")


def _rows_from_matrix(rows: list[list]) -> list[dict]:
    """把二维表（Excel/CSV）转成统一的单据行。"""
    mapping, start = _detect_header(rows)
    out: list[dict] = []
    for r in rows[start:]:
        if not r:
            continue
        def cell(field):
            i = mapping.get(field)
            return r[i] if i is not None and i < len(r) else None

        product = str(cell("product") or "").strip()
        if not product:
            continue
        qty = _num(cell("quantity"))
        price = _num(cell("unit_price"))
        amount = _num(cell("amount"))
        if not amount and qty and price:
            amount = round(qty * price, 2)
        if amount <= 0 and qty <= 0:
            continue
        out.append({
            "date": _to_date(cell("date")),
            "product": product,
            "unit": str(cell("unit") or "").strip(),
            "quantity": round(qty, 4),
            "unit_price": price,
            "amount": round(amount, 2),
        })
    return out


def _read_excel(data: bytes, filename: str) -> list[dict]:
    name = (filename or "").lower()
    if name.endswith(".csv"):
        text = data.decode("utf-8-sig", errors="ignore")
        return _rows_from_matrix(list(csv.reader(io.StringIO(text))))
    if not name.endswith((".xlsx", ".xlsm")):
        raise HTTPException(400, "仅支持 .xlsx / .xlsm / .csv；.xls 请先另存为 .xlsx")
    try:
        wb = load_workbook(io.BytesIO(data), data_only=True, read_only=True)
    except Exception:
        raise HTTPException(400, "无法读取 Excel，请确认文件未加密且为 .xlsx 格式")
    try:
        ws = wb.worksheets[0]
        ws.reset_dimensions()
        rows = [list(r) for r in ws.iter_rows(values_only=True)]
    finally:
        wb.close()
    return _rows_from_matrix(rows)


IMAGE_PROMPT = """你是「企业台账系统」的代发单据核对助手。用户会提供一张供应商销售明细表 / 代发账单的图片，
请逐行提取每一笔商品记录。

要求：
1. 只读取表格中的明细行，忽略表头的合计/标题行；
2. date：单据日期，格式 YYYY-MM-DD；
3. product：商品名称，按图片原文，完整保留规格（如「电商小果1.5斤/箱」）；
4. unit：单位（箱 / 件 / 个 / 袋…）；找不到就留空；
5. quantity：数量数字；unit_price：单价数字；amount：价税合计/金额数字；
6. 数字只保留数值，不要带货币符号或千分位；
7. 若某列缺失，对应字段给 0 或空字符串，不要臆造。

只输出一个 JSON 对象，禁止输出 JSON 以外的任何文字、解释或 markdown 代码块：
{"rows":[{"date":"YYYY-MM-DD","product":"商品名称","unit":"箱","quantity":12,"unit_price":12.9,"amount":154.8}]}"""


def _chat_mm(cfg: dict, system: str, user: str, image_data_uri: str, max_tokens: int = 6000) -> str:
    """多模态非流式调用：用于一次性提取整张单据明细。"""
    resp = _make_client(cfg).chat.completions.create(
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
        max_tokens=max_tokens,
    )
    if not resp.choices or not resp.choices[0].message or not resp.choices[0].message.content:
        raise RuntimeError("大模型未返回识别内容")
    return resp.choices[0].message.content


def _read_image(data: bytes, filename: str, hint: str) -> list[dict]:
    cfg = _llm_config()
    if not cfg.get("api_key"):
        raise HTTPException(400, "未配置 LLM（product_rules.json 的 llm 段），图片核对需要大模型")
    user = (
        f"今天是 {_date.today().isoformat()}。请识别这张代发单据图片的全部商品明细。"
        + (f"\n补充说明：{hint}" if (hint or "").strip() else "")
    )
    content = _chat_mm(cfg, IMAGE_PROMPT, user, _image_data_uri(data, filename or "bill.png"))
    parsed = _extract_json(content)
    raw_rows = parsed.get("rows") or parsed.get("lines") or []
    out: list[dict] = []
    for r in raw_rows:
        product = str(r.get("product") or "").strip()
        if not product:
            continue
        qty = _num(r.get("quantity"))
        price = _num(r.get("unit_price"))
        amount = _num(r.get("amount"))
        if not amount and qty and price:
            amount = round(qty * price, 2)
        out.append({
            "date": _to_date(r.get("date")),
            "product": product,
            "unit": str(r.get("unit") or "").strip(),
            "quantity": round(qty, 4),
            "unit_price": price,
            "amount": round(amount, 2),
        })
    return out


# 补充说明里的别名：在 AI 录入的解析基础上，额外支持「A是B」这种写法
_RC_SPLIT = re.compile(r"[，,。;；\n\r\t（）()\[\]【】{}、\"'“”‘’|]")
_RC_CONNECT = re.compile(r"^(.{2,24}?)(?:就是|即是|指的是|是|＝|=|->|→|=>|⇒)(.{2,24})$")
_ALIAS_TAIL = "果类蔬品 "


def _reconcile_aliases(text: str) -> list[tuple[str, str]]:
    out: list[tuple[str, str]] = []
    for pair in _parse_aliases(text):
        if pair not in out:
            out.append(pair)
    for seg in _RC_SPLIT.split(str(text or "")):
        seg = seg.strip()
        if not seg or len(seg) > 48:
            continue
        m = _RC_CONNECT.match(seg)
        if not m:
            continue
        src, dst = _alias_side(m.group(1)), _alias_side(m.group(2))
        if _alias_ok(src, dst) and (src, dst) not in out:
            out.append((src, dst))
    return out


def _map_alias(name: str, aliases: list[tuple[str, str]]) -> tuple[str, str | None]:
    """按别名映射商品名；允许别名核心词（如「电商果」→「电商」）只匹配名称的一段。

    返回 (映射后名称, 命中的别名目标)；未命中时目标为 None。
    """
    name = (name or "").strip()
    for src, dst in aliases:
        if not src:
            continue
        if src in name:
            return name.replace(src, dst), dst
        core = src.rstrip(_ALIAS_TAIL)
        if len(core) >= 2 and core in name:
            return name.replace(core, dst), dst
    return name, None


_ANCHOR_GENERIC = ("西红柿", "番茄", "蔬菜", "蔬果", "水果", "果", "菜")


def _anchor_key(target: str) -> str:
    """别名目标的锚点词：去掉泛化品类词（老味道番茄→老味道，牧心番茄→牧心）。"""
    s = str(target or "").strip()
    for w in _ANCHOR_GENERIC:
        s = s.replace(w, "")
    return s.strip()


_LEAD_NO_RE = re.compile(r"^(\d+(?:\.\d+)?)")

# 包材/耗材特征词（注意不能包含单独的「箱」，因为农产品也常以「/箱」为销售单位）
_PACK_WORDS = ("纸箱", "号箱", "号纸", "泡沫", "托盘", "托", "包装", "膜", "胶带", "标签", "果托")


def _leading_no(name: str) -> str:
    """商品名前导编号（如「9号箱」→ 9），用于防止不同编号的包材互相误配。"""
    m = _LEAD_NO_RE.match(str(name or "").strip())
    return m.group(1) if m else ""


def _is_packaging(name: str) -> bool:
    return any(w in str(name or "") for w in _PACK_WORDS)


def _type_pool(products: list[Product], raw_name: str) -> list[Product]:
    """按单据商品类型缩小候选：包材类只配包材/耗材，农产品排除包材/人工。"""
    pack = _is_packaging(raw_name)
    out = []
    for p in products:
        cat = (p.category or "").strip()
        is_pack = cat in ("包材", "耗材", "包装")
        if pack and is_pack:
            out.append(p)
        elif not pack and not is_pack and cat != "人工":
            out.append(p)
    return out


def _score_name(doc_core: str, prod_core: str, doc_raw: str = "", prod_raw: str = "") -> float:
    """单据名与商品档案名的相似度。

    优先「公共前缀 ≥2 字」（如 牧心番茄 / 牧心草莓西红柿），其次整体相似度；
    若两边都带前导编号但编号不同（9号箱 vs 11号纸箱），直接判为不匹配。
    """
    if not doc_core or not prod_core:
        return 0.0
    d_no, p_no = _leading_no(doc_raw), _leading_no(prod_raw)
    if d_no and p_no and d_no != p_no:
        return 0.0
    if d_no and p_no:
        # 前导编号相同（9号箱 / 9号纸箱），视为同一规格
        return 0.95
    if doc_core == prod_core:
        return 1.0
    # 互相包含且较短核心名 ≥3 字才算命中；避免「番茄」(2字) 这种泛化词乱配
    if (doc_core in prod_core or prod_core in doc_core) and min(len(doc_core), len(prod_core)) >= 3:
        return 0.9
    ratio = difflib.SequenceMatcher(None, doc_core, prod_core).ratio()
    # 未命中别名时只接受高度相似，宁可不匹配（列为「仅单据」）也不误配
    return ratio if ratio >= 0.8 else 0.0


def _resolve_family(raw_name: str, aliases: list[tuple[str, str]],
                    products: list[Product]) -> tuple[str, str, int | None]:
    """把单据商品名映射到系统商品家族。

    返回 (family_core, 展示名, product_id)；找不到时 product_id=None，family 用映射后的核心名。
    """
    mapped, anchor_dst = _map_alias(raw_name, aliases)
    doc_core = _core(mapped)
    pool = _type_pool(products, raw_name)
    # 别名命中：用锚点词锁定目标商品家族，避免再被泛化相似度带偏
    if anchor_dst:
        anchor = _anchor_key(anchor_dst)
        anchored = [p for p in pool if anchor and anchor in (p.name or "")]
        if anchored:
            best = max(anchored, key=lambda p: difflib.SequenceMatcher(None, doc_core, _core(p.name)).ratio())
            return _core(best.name) or best.name, best.name, best.id
    best, best_score, best_pid = None, 0.0, None
    for p in pool:
        score = _score_name(doc_core, _core(p.name), mapped, p.name)
        if score > best_score:
            best, best_score, best_pid = p, score, p.id
    if best and best_score >= 0.8:
        return _core(best.name) or best.name, best.name, best_pid
    # 没命中：保留映射后的名字作为家族名，单独列「仅单据」行
    return (doc_core or mapped or raw_name), mapped or raw_name, None


def _collect_dropship(db: Session, date_from: str, date_to: str) -> dict[tuple[str, str], dict]:
    """取日期区间内的代发账单，按「日期 + 商品家族」聚合。"""
    q = select(DropshipBill)
    if date_from:
        q = q.where(DropshipBill.date >= date_from)
    if date_to:
        q = q.where(DropshipBill.date <= date_to)
    groups: dict[tuple[str, str], dict] = {}
    for b in db.execute(q).scalars():
        family = _core(b.product_name) or (b.product_name or f"#{b.product_id}")
        key = ((b.date or "").strip(), family)
        g = groups.setdefault(key, {
            "family": family,
            "product_names": set(),
            "specs": set(),
            "units": set(),
            "quantity": 0.0,
            "amount": 0.0,
            "order_ids": set(),
        })
        g["product_names"].add(b.product_name or "")
        if (b.spec or "").strip():
            g["specs"].add(b.spec.strip())
        if (b.unit or "").strip():
            g["units"].add(b.unit.strip())
        g["quantity"] += float(b.quantity or 0.0)
        g["amount"] += float(b.amount or 0.0)
        g["order_ids"].add(b.outbound_id)
    return groups


def _build_reconciliation(doc_rows: list[dict], text: str, db: Session,
                          date_from: str, date_to: str) -> dict:
    """单据行 × 代发账单 → 成本差异核对结果（纯同步逻辑，便于单测）。"""
    aliases = _reconcile_aliases(text)
    products = list(db.execute(select(Product).where(Product.is_active.is_(True))).scalars())

    # 单据侧按「日期 + 商品家族」聚合
    doc_groups: dict[tuple[str, str], dict] = {}
    for r in doc_rows:
        family, label, pid = _resolve_family(r["product"], aliases, products)
        key = (r["date"], family)
        g = doc_groups.setdefault(key, {
            "family": family,
            "product_names": set(),
            "units": set(),
            "quantity": 0.0,
            "amount": 0.0,
            "matched": pid is not None,
            "display_name": label,
        })
        g["product_names"].add(r["product"])
        if r["unit"]:
            g["units"].add(r["unit"])
        g["quantity"] += r["quantity"]
        g["amount"] += r["amount"]
        g["matched"] = g["matched"] or (pid is not None)

    # 日期范围：优先用前端传入；否则取单据里的最早/最晚日期
    doc_dates = sorted({r["date"] for r in doc_rows if r["date"]})
    from_ = (date_from or "").strip() or (doc_dates[0] if doc_dates else "")
    to_ = (date_to or "").strip() or (doc_dates[-1] if doc_dates else "")
    sys_groups = _collect_dropship(db, from_, to_)

    keys = set(doc_groups) | set(sys_groups)
    rows: list[dict] = []
    for key in keys:
        day, family = key
        d = doc_groups.get(key)
        s = sys_groups.get(key)
        doc_amt = round(d["amount"], 2) if d else 0.0
        sys_amt = round(s["amount"], 2) if s else 0.0
        diff = round(doc_amt - sys_amt, 2)
        if d and s:
            status = "一致" if abs(diff) <= 0.02 else "金额差异"
        elif d:
            status = "仅单据"
        else:
            status = "仅系统"
        doc_units = sorted(d["units"]) if d else []
        sys_units = sorted(s["units"]) if s else []
        qty_comparable = bool(doc_units and sys_units and doc_units == sys_units)
        rows.append({
            "date": day,
            "family": family,
            "status": status,
            "doc_names": sorted(d["product_names"]) if d else [],
            "doc_unit": " / ".join(doc_units),
            "doc_quantity": round(d["quantity"], 4) if d else 0.0,
            "doc_amount": doc_amt,
            "system_name": "、".join(sorted(x for x in s["product_names"] if x)) if s else "",
            "system_spec": "、".join(sorted(s["specs"])) if s else "",
            "system_unit": " / ".join(sys_units),
            "system_quantity": round(s["quantity"], 4) if s else 0.0,
            "system_amount": sys_amt,
            "qty_diff": round(d["quantity"] - s["quantity"], 4) if (d and s and qty_comparable) else None,
            "amount_diff": diff,
        })

    # 差异优先展示：金额差异 → 仅单据 → 仅系统 → 一致；同状态按日期
    order = {"金额差异": 0, "仅单据": 1, "仅系统": 2, "一致": 3}
    rows.sort(key=lambda r: (order.get(r["status"], 9), r["date"], r["family"]))

    doc_total = round(sum(r["amount"] for r in doc_rows), 2)
    # 系统合计只取「单据里出现过的商品」，避免把同日无关商品也算进差异；
    # system_all_total 保留同日全部代发成本，供参考。
    doc_keys = set(doc_groups)
    sys_total = round(sum(g["amount"] for k, g in sys_groups.items() if k in doc_keys), 2)
    sys_all_total = round(sum(g["amount"] for g in sys_groups.values()), 2)
    return {
        "ok": True,
        "aliases": [{"from": a, "to": b} for a, b in aliases],
        "date_from": from_,
        "date_to": to_,
        "summary": {
            "doc_rows": len(doc_rows),
            "doc_total": doc_total,
            "system_total": sys_total,
            "system_all_total": sys_all_total,
            "diff": round(doc_total - sys_total, 2),
            "groups": len(rows),
            "diff_groups": sum(1 for r in rows if r["status"] == "金额差异"),
            "only_doc": sum(1 for r in rows if r["status"] == "仅单据"),
            "only_system": sum(1 for r in rows if r["status"] == "仅系统"),
            "same": sum(1 for r in rows if r["status"] == "一致"),
        },
        "rows": rows,
    }


@router.post("/dropship")
async def reconcile_dropship(
    file: UploadFile = File(...),
    text: str = Form(""),
    date_from: str = Form(""),
    date_to: str = Form(""),
    db: Session = Depends(get_db),
    user: User = Depends(get_current_user),
):
    """代发账单核对：上传图片/Excel → 提取单据明细 → 与代发账单比对 → 成本差异视图。"""
    data = await file.read()
    if not data:
        raise HTTPException(400, "未读取到文件内容")
    filename = file.filename or ""
    is_image = bool(re.search(r"\.(png|jpg|jpeg|gif|webp|bmp)$", filename.lower()))
    if is_image:
        doc_rows = _read_image(data, filename, text)
    else:
        doc_rows = _read_excel(data, filename)
    if not doc_rows:
        raise HTTPException(400, "未从文件中提取到商品明细，请检查表头或图片清晰度")
    return _build_reconciliation(doc_rows, text, db, date_from, date_to)
