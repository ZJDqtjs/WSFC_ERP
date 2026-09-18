"""入仓：按「袋」采购的备货商品（半加工等）入仓台账。

口径：
- 入仓品资料：名称 / 类目 / SKU / 69码 / 箱规 / 采购价(元/袋，即给「我」的收入单价) / 运费(元/袋)，
  并关联一个「库存商品(大类)」+ 每袋净重（库存管理的基础单位，通常克），用于成本核算。
- 入仓记录：收入 = 数量 × 采购价；商品成本 = 数量 × 每袋净重 × 库存单位成本（库存均价优先，回退参考成本）；
  运费 = 数量 × 运费单价；毛利 = 收入 − 商品成本 − 运费。
- 导入《入仓配送明细》常温贴单：表头「采购单号 / 商品名称 / 箱数 / 配送中心 / 数量 / 箱规」，
  采购单号为合并单元格时自动向下回填；每袋净重优先从商品名解析（净重2斤 / 228g / 1.2kg），
  否则取入仓品的每袋净重；箱数、数量、价格、运费、净重均可在预览页修正。

入仓记录独立于库存商品(Product)，不改变现有库存；商品成本按库存管理的成本口径取值。
"""
import difflib
import re
import uuid
from datetime import datetime

from fastapi import APIRouter, Depends, File, Form, HTTPException, UploadFile
from openpyxl import load_workbook
from pydantic import BaseModel
from sqlalchemy import func, select
from sqlalchemy.orm import Session

from ..auth import get_current_user
from ..database import get_db
from ..models import Deduction, Product, StockMovement, User, WarehouseIn, WarehouseProduct
from ..services import fifo_state, fifo_take, pay_fields, recompute_product, unit_to_base

router = APIRouter(prefix="/api/warehouse-in", tags=["warehouse-in"])

# 常温贴单所在表名（导入时若未指定则优先使用）
DEFAULT_SHEET = "常温贴单"

# ---------------- Excel 表头别名 ----------------
WH_ALIASES = {
    "purchase_no": ["采购单号", "采购订单号", "采购编号", "单号"],
    "product": ["商品名称", "商品", "名称", "商品编码或名称"],
    "box_count": ["箱数", "件数"],
    "center": ["配送中心", "收货仓", "仓库", "仓"],
    "quantity": ["数量"],
    "box_spec": ["箱规", "每箱", "规格"],
}


def _norm(s) -> str:
    return re.sub(r"\s+", "", str(s or "")).lower()


# 核心名归一化：去掉数量与单位/包装词，便于「拇指小玉米净重2斤」≈「白拇指玉米」
_CORE_STRIP = (
    "净重", "礼盒装", "礼盒", "公斤", "千克", "kg", "斤", "克", "g",
    "袋", "包", "盒", "箱", "个", "件", "份", "装",
)


def _core(name: str) -> str:
    s = re.sub(r"[\d.]+", "", _norm(name))
    for w in _CORE_STRIP:
        s = s.replace(w, "")
    return s


def _norm_cell(c) -> str:
    return str(c).strip().replace("*", "").strip() if c is not None else ""


def _cell(row, idx, default=""):
    if idx is None or idx >= len(row):
        return default
    v = row[idx]
    if v is None:
        return default
    return str(v).strip()


def _to_float(v, default=0.0) -> float:
    if v is None:
        return default
    s = str(v).strip().replace(",", "").replace("￥", "").replace("¥", "")
    if not s:
        return default
    try:
        return float(s)
    except (TypeError, ValueError):
        cleaned = re.sub(r"[^\d\-+\.]+", "", s)
        try:
            return float(cleaned)
        except ValueError:
            return default


# 从商品名解析每袋净重（克）：净重2斤 → 1000；1.2kg → 1200；228g → 228
def _parse_weight_grams(name: str) -> float:
    s = str(name or "").lower()
    m = re.search(r"(\d+(?:\.\d+)?)\s*(?:公斤|千克|kg)", s)
    if m:
        return round(float(m.group(1)) * 1000, 4)
    m = re.search(r"(\d+(?:\.\d+)?)\s*斤", s)
    if m:
        return round(float(m.group(1)) * 500, 4)
    m = re.search(r"(\d+(?:\.\d+)?)\s*(?:克|g)", s)
    if m:
        return round(float(m.group(1)), 4)
    return 0.0


def _detect_header(rows, aliases) -> tuple[dict, int]:
    """扫描前 20 行找表头行，返回 {字段: 列索引} 与数据起始行号。"""
    flat = {name for names in aliases.values() for name in names}
    for idx, row in enumerate(rows[:20]):
        cells = {_norm_cell(c) for c in row if _norm_cell(c)}
        if len(cells & flat) >= 2:
            mapping = {}
            for i, c in enumerate(row):
                c = _norm_cell(c)
                for field, names in aliases.items():
                    if c in names:
                        mapping[field] = i
            return mapping, idx + 1
    return {}, 0


def _load_workbook(file: UploadFile):
    try:
        return load_workbook(file.file, data_only=True)
    except Exception:
        raise HTTPException(400, "无法读取文件，请上传 .xlsx 格式")


# 库存成本：库存均价(先进先出)优先，无库存时回退参考成本 unit_cost。
# 返回 (库存商品, 基础单位成本, 默认单位换算系数, 默认单位成本)。
# 成本口径统一按「默认单位」（如 公斤），与库存管理展示口径一致。
def _stock_info(db: Session, stock_product_id: int | None) -> tuple[Product | None, float, float, float]:
    if not stock_product_id:
        return None, 0.0, 1.0, 0.0
    sp = db.get(Product, stock_product_id)
    if not sp:
        return None, 0.0, 1.0, 0.0
    base_cost = float((sp.avg_cost if (sp.avg_cost or 0) > 0 else (sp.unit_cost or 0)) or 0)
    du = sp.default_unit or sp.base_unit
    factor = float((sp.conversions or {}).get(du) or 1) or 1.0
    return sp, base_cost, factor, base_cost * factor


def _stock_default_unit(sp: Product | None) -> str:
    return (sp.default_unit or sp.base_unit) if sp else ""


# 入仓品扣点：统一在「扣点」页维护，保留类别名「入仓品」
WAREHOUSE_DEDUCTION_CATEGORY = "入仓品"


def _warehouse_deduction(db: Session) -> float:
    """入仓品采购价（收入）扣点百分比；未配置返回 0（不折算）。"""
    d = db.scalar(select(Deduction).where(Deduction.category == WAREHOUSE_DEDUCTION_CATEGORY))
    return float(d.percent if d else 0)


@router.get("/deduction")
def get_warehouse_deduction(db: Session = Depends(get_db), user: User = Depends(get_current_user)):
    """返回入仓品扣点百分比（供入仓页使用）。"""
    return {"percent": _warehouse_deduction(db)}


# ---------------- 序列化 ----------------
def _product_dict(db: Session, p: WarehouseProduct) -> dict:
    sp, _base_cost, _factor, unit_cost = _stock_info(db, p.stock_product_id)
    pack_items = []
    for it in (p.pack_items or []):
        mp = db.get(Product, it.get("product_id")) if it.get("product_id") else None
        pack_items.append({
            "product_id": it.get("product_id"),
            "quantity": it.get("quantity"),
            "unit": it.get("unit") or "",
            "name": mp.name if mp else "",
            "category": mp.category if mp else "",
        })
    return {
        "id": p.id, "name": p.name, "category": p.category, "sku": p.sku,
        "barcode": p.barcode, "box_spec": p.box_spec,
        "purchase_price": p.purchase_price,
        "freight": p.freight,
        "stock_product_id": p.stock_product_id,
        "stock_product_name": sp.name if sp else "",
        "stock_base_unit": (sp.base_unit if sp else ""),
        "stock_default_unit": _stock_default_unit(sp),
        "stock_unit_cost": round(unit_cost, 6),  # 元/默认单位（如 元/公斤）
        "bag_weight": p.bag_weight,  # 每袋净重（默认单位，如 公斤）
        "bag_cost": round((p.bag_weight or 0) * unit_cost, 4),  # 每袋商品成本
        "shelf_life": p.shelf_life, "remark": p.remark, "is_active": p.is_active,
        "pack_items": pack_items,  # 关联结算（随货包材）清单（每袋用量）
    }


def _in_dict(db: Session, r: WarehouseIn) -> dict:
    sp = db.get(Product, r.stock_product_id) if r.stock_product_id else None
    return {
        "id": r.id, "code": r.code, "product_id": r.product_id,
        "product_name": r.product_name, "category": r.category, "unit": r.unit,
        "purchase_no": r.purchase_no, "center": r.center,
        "quantity": r.quantity, "box_count": r.box_count, "box_spec": r.box_spec,
        "unit_price": r.unit_price, "deduction_percent": r.deduction_percent, "freight": r.freight,
        "stock_product_id": r.stock_product_id,
        "stock_product_name": sp.name if sp else "",
        "stock_default_unit": _stock_default_unit(sp),
        "bag_weight": r.bag_weight, "unit_cost": r.unit_cost,
        "cogs": r.cogs, "amount": r.amount, "freight_total": r.freight_total, "profit": r.profit,
        "pack_items": r.pack_items or [],  # 随货包材结算快照
        "pack_cost": r.pack_cost or 0.0,
        "date": r.date, "operator": r.operator, "remark": r.remark,
        "import_group": r.import_group,
        "pay_status": getattr(r, "pay_status", "paid") or "paid",
        "paid_at": getattr(r, "paid_at", "") or "",
    }


# ---------------- 入仓品资料 ----------------
class PackItemDef(BaseModel):
    product_id: int
    quantity: float
    unit: str = "个"


class ProductIn(BaseModel):
    name: str
    category: str = ""
    sku: str = ""
    barcode: str = ""
    box_spec: float = 0.0
    purchase_price: float = 0.0
    freight: float = 0.0
    stock_product_id: int | None = None
    bag_weight: float = 0.0
    shelf_life: str = ""
    remark: str = ""
    is_active: bool = True
    pack_items: list[PackItemDef] = []  # 关联结算（随货包材）清单，每袋用量


def _clean_pack_items(db: Session, items: list[PackItemDef]) -> list[dict]:
    """校验并规范化入仓品关联结算清单：商品必须存在、数量>0、单位有效，否则报错。"""
    cleaned = []
    for it in items:
        if not it.product_id or not (it.quantity and it.quantity > 0):
            raise HTTPException(400, "关联结算清单存在无效行（商品/数量需完整且大于 0）")
        p = db.get(Product, it.product_id)
        if not p:
            raise HTTPException(400, f"关联结算商品ID {it.product_id} 不存在")
        unit = (it.unit or "").strip() or p.default_unit or p.base_unit or "个"
        if unit not in (p.conversions or {}):
            raise HTTPException(400, f"关联结算商品「{p.name}」不支持单位「{unit}」")
        cleaned.append({"product_id": it.product_id, "quantity": it.quantity, "unit": unit})
    return cleaned


@router.get("/products")
def list_products(db: Session = Depends(get_db), user: User = Depends(get_current_user)):
    rows = db.execute(select(WarehouseProduct).order_by(WarehouseProduct.id)).scalars()
    return [_product_dict(db, p) for p in rows]


@router.post("/products")
def create_product(data: ProductIn, db: Session = Depends(get_db), user: User = Depends(get_current_user)):
    name = (data.name or "").strip()
    if not name:
        raise HTTPException(400, "入仓品名称不能为空")
    pack_items = _clean_pack_items(db, data.pack_items)
    p = WarehouseProduct(**{**data.model_dump(), "name": name, "pack_items": pack_items})
    db.add(p)
    db.commit()
    db.refresh(p)
    return _product_dict(db, p)


@router.put("/products/{pid}")
def update_product(pid: int, data: ProductIn, db: Session = Depends(get_db), user: User = Depends(get_current_user)):
    p = db.get(WarehouseProduct, pid)
    if not p:
        raise HTTPException(404, "入仓品不存在")
    name = (data.name or "").strip()
    if not name:
        raise HTTPException(400, "入仓品名称不能为空")
    pack_items = _clean_pack_items(db, data.pack_items)
    for k, v in data.model_dump().items():
        setattr(p, k, v)
    p.name = name
    p.pack_items = pack_items
    db.commit()
    db.refresh(p)
    return _product_dict(db, p)


@router.delete("/products/{pid}")
def delete_product(pid: int, db: Session = Depends(get_db), user: User = Depends(get_current_user)):
    p = db.get(WarehouseProduct, pid)
    if not p:
        raise HTTPException(404, "入仓品不存在")
    db.delete(p)
    db.commit()
    return {"ok": True}


# ---------------- 入仓记录 ----------------
class InboundIn(BaseModel):
    product_id: int | None = None
    product_name: str = ""
    category: str = ""
    unit: str = "袋"
    purchase_no: str = ""
    center: str = ""
    quantity: float
    box_count: float = 0.0
    box_spec: float = 0.0
    unit_price: float = 0.0  # 采购价（元/袋，收入单价）
    freight: float = 0.0  # 运费（元/袋）
    bag_weight: float = 0.0  # 每袋净重（基础单位），0=用入仓品默认
    date: str
    operator: str = ""
    remark: str = ""
    pay_status: str = "paid"  # paid 已付款（默认）/ unpaid 待付款（先进「待付款账单」）


class InboundUpdate(BaseModel):
    product_id: int | None = None
    product_name: str = ""
    category: str = ""
    unit: str = "袋"
    purchase_no: str = ""
    center: str = ""
    quantity: float
    box_count: float = 0.0
    box_spec: float = 0.0
    unit_price: float = 0.0
    freight: float = 0.0
    bag_weight: float = 0.0
    date: str
    remark: str = ""
    pay_status: str = "paid"


def _gen_code(db: Session, date: str) -> str:
    count = db.scalar(
        select(func.count()).select_from(WarehouseIn).where(WarehouseIn.code.like(f"RC{date}%"))
    )
    return f"RC{date}-{count + 1:03d}"


def _settle_pack_items(db: Session, product: WarehouseProduct | None, quantity: float, cache: dict | None = None) -> tuple[list[dict], float]:
    """按「每袋用量 × 入仓袋数」结算随货包材。返回 (明细快照, 包材成本合计)。

    不落库；成本按 FIFO 结转（批次不足时回退参考成本）。同一结算过程共享 cache，
    避免多次读取同一商品批次导致重复扣减。
    """
    items, total = [], 0.0
    if not product:
        return items, total
    cache = cache if cache is not None else {}
    for it in (product.pack_items or []):
        pid = it.get("product_id")
        m = db.get(Product, pid)
        if not m:
            continue
        per = float(it.get("quantity") or 0)
        qty = round(per * quantity, 6)
        if qty <= 0:
            continue
        unit = (it.get("unit") or m.default_unit or m.base_unit or "个").strip() or "个"
        if unit not in (m.conversions or {}):
            continue
        qty_base = unit_to_base(m, unit, qty)
        if m.id not in cache:
            cache[m.id] = fifo_state(db, m.id)
        layers, base = cache[m.id]
        cost = round(fifo_take(layers, base, qty_base, m.unit_cost or 0.0), 2)
        items.append({
            "product_id": m.id, "name": m.name, "unit": unit,
            "quantity": qty, "quantity_base": round(qty_base, 6),
            "unit_price": round(cost / qty, 6) if qty else 0.0,
            "cost": cost,
        })
        total += cost
    return items, round(total, 2)


def _apply_pack_settlement(db: Session, rec: WarehouseIn) -> None:
    """把随货包材结算落成库存流水（包材=包装消耗；人工/快递=正向工作量）并重算受影响商品。"""
    affected: set[int] = set()
    op = rec.operator or ""
    for it in (rec.pack_items or []):
        pid = it.get("product_id")
        m = db.get(Product, pid)
        if not m:
            continue
        is_service = m.category in ("人工", "快递")
        db.add(
            StockMovement(
                product_id=pid,
                move_type="work" if is_service else "pack_out",
                quantity_base=(it.get("quantity_base") or 0) if is_service else -(it.get("quantity_base") or 0),
                amount=it.get("cost") or 0.0,
                ref_type="warehouse_in",
                ref_id=rec.id,
                date=rec.date,
                operator=op,
                remark=f"入仓随货包材 {rec.code}",
            )
        )
        affected.add(pid)
    for pid in affected:
        recompute_product(db, pid)


def _clear_pack_settlement(db: Session, rec_id: int) -> set[int]:
    """删除某入仓记录的随货包材流水，返回受影响商品 id 集合（供调用方重算）。"""
    affected: set[int] = set()
    for m in db.execute(
        select(StockMovement).where(StockMovement.ref_type == "warehouse_in", StockMovement.ref_id == rec_id)
    ).scalars():
        affected.add(m.product_id)
        db.delete(m)
    return affected


def _create_record(db: Session, payload: dict, operator: str, import_group: str = "") -> WarehouseIn:
    quantity = float(payload.get("quantity") or 0)
    if quantity <= 0:
        raise ValueError("数量必须大于 0")
    date = (payload.get("date") or "").strip() or datetime.now().strftime("%Y-%m-%d")
    unit_price = float(payload.get("unit_price") or 0)
    freight = float(payload.get("freight") or 0)
    pid = payload.get("product_id")
    product = db.get(WarehouseProduct, pid) if pid else None
    name = (payload.get("product_name") or "").strip() or (product.name if product else "")
    if not name:
        raise ValueError("缺少商品名称")

    # 成本口径：库存管理的默认单位成本 × 每袋净重（默认单位）
    stock_product_id = product.stock_product_id if product else None
    sp, _base_cost, _factor, unit_cost = _stock_info(db, stock_product_id)
    bag_weight = float(payload.get("bag_weight") or 0) or float((product.bag_weight if product else 0) or 0)
    deduction = _warehouse_deduction(db)
    revenue = round(quantity * unit_price * (1 - deduction / 100), 2)
    cogs = round(quantity * bag_weight * unit_cost, 2)
    freight_total = round(quantity * freight, 2)
    # 随货包材：每袋用量 × 袋数，成本按 FIFO 结转
    pack_items, pack_cost = _settle_pack_items(db, product, quantity)
    profit = round(revenue - cogs - freight_total - pack_cost, 2)

    rec = WarehouseIn(
        code=_gen_code(db, date),
        product_id=product.id if product else None,
        product_name=name,
        category=(payload.get("category") or (product.category if product else "") or "").strip(),
        unit=(payload.get("unit") or "袋").strip() or "袋",
        purchase_no=(payload.get("purchase_no") or "").strip(),
        center=(payload.get("center") or "").strip(),
        quantity=quantity,
        box_count=float(payload.get("box_count") or 0),
        box_spec=float(payload.get("box_spec") or 0),
        unit_price=unit_price,
        deduction_percent=deduction,
        freight=freight,
        stock_product_id=sp.id if sp else None,
        bag_weight=bag_weight,
        unit_cost=unit_cost,
        cogs=cogs,
        amount=revenue,
        freight_total=freight_total,
        pack_items=pack_items,
        pack_cost=pack_cost,
        profit=profit,
        date=date,
        operator=(payload.get("operator") or "").strip() or operator,
        remark=(payload.get("remark") or "").strip(),
        import_group=import_group,
        **pay_fields(payload, date),
    )
    db.add(rec)
    db.flush()
    _apply_pack_settlement(db, rec)
    return rec


@router.get("")
def list_inbounds(
    date_from: str = "", date_to: str = "", q: str = "",
    db: Session = Depends(get_db), user: User = Depends(get_current_user),
):
    query = select(WarehouseIn).order_by(WarehouseIn.id.desc())
    if date_from:
        query = query.where(WarehouseIn.date >= date_from)
    if date_to:
        query = query.where(WarehouseIn.date <= date_to)
    rows = list(db.execute(query).scalars())
    kw = (q or "").strip().lower()
    if kw:
        rows = [r for r in rows if kw in " ".join(
            [r.code, r.product_name, r.purchase_no, r.center, r.operator]
        ).lower()]
    items = [_in_dict(db, r) for r in rows]
    total = {
        "amount": round(sum(r.amount or 0 for r in rows), 2),  # 收入
        "cogs": round(sum(r.cogs or 0 for r in rows), 2),      # 商品成本
        "freight": round(sum(r.freight_total or 0 for r in rows), 2),
        "pack_cost": round(sum(r.pack_cost or 0 for r in rows), 2),  # 随货包材成本
        "profit": round(sum(r.profit or 0 for r in rows), 2),
        "quantity": round(sum(r.quantity or 0 for r in rows), 2),
    }
    return {"items": items, "total": total, "count": len(rows)}


@router.post("")
def create_inbound(data: InboundIn, db: Session = Depends(get_db), user: User = Depends(get_current_user)):
    try:
        rec = _create_record(db, data.model_dump(), operator=user.name)
    except ValueError as e:
        raise HTTPException(400, str(e))
    db.commit()
    db.refresh(rec)
    return _in_dict(db, rec)


@router.put("/{rid}")
def update_inbound(rid: int, data: InboundUpdate, db: Session = Depends(get_db), user: User = Depends(get_current_user)):
    rec = db.get(WarehouseIn, rid)
    if not rec:
        raise HTTPException(404, "入仓记录不存在")
    d = data.model_dump()
    quantity = float(d.get("quantity") or 0)
    if quantity <= 0:
        raise HTTPException(400, "数量必须大于 0")
    product = db.get(WarehouseProduct, d["product_id"]) if d.get("product_id") else None
    rec.product_id = product.id if product else None
    if product:
        rec.product_name = product.name
        rec.category = product.category or ""
    elif (d.get("product_name") or "").strip():
        rec.product_name = d["product_name"].strip()
        rec.category = (d.get("category") or "").strip()
    rec.unit = (d.get("unit") or "袋").strip() or "袋"
    rec.purchase_no = (d.get("purchase_no") or "").strip()
    rec.center = (d.get("center") or "").strip()
    rec.quantity = quantity
    rec.box_count = float(d.get("box_count") or 0)
    rec.box_spec = float(d.get("box_spec") or 0)
    rec.unit_price = float(d.get("unit_price") or 0)
    rec.freight = float(d.get("freight") or 0)
    rec.date = (d.get("date") or rec.date).strip() or rec.date
    rec.remark = (d.get("remark") or "").strip()
    rec.pay_status = "unpaid" if (d.get("pay_status") or "").strip() == "unpaid" else "paid"
    rec.paid_at = "" if rec.pay_status == "unpaid" else (rec.paid_at or rec.date)
    # 成本重算：关联库存商品/每袋净重变化时同步成本口径
    stock_product_id = product.stock_product_id if product else rec.stock_product_id
    sp, _base_cost, _factor, unit_cost = _stock_info(db, stock_product_id)
    rec.stock_product_id = sp.id if sp else None
    rec.bag_weight = float(d.get("bag_weight") or 0) or float((product.bag_weight if product else 0) or 0) or rec.bag_weight
    rec.unit_cost = unit_cost
    rec.deduction_percent = _warehouse_deduction(db)
    rec.amount = round(rec.quantity * rec.unit_price * (1 - (rec.deduction_percent or 0) / 100), 2)
    rec.cogs = round(rec.quantity * rec.bag_weight * rec.unit_cost, 2)
    rec.freight_total = round(rec.quantity * rec.freight, 2)
    # 随货包材：先清除旧结算流水，再按新入仓品/数量重算
    old_affected = _clear_pack_settlement(db, rec.id)
    rec.pack_items, rec.pack_cost = _settle_pack_items(db, product, quantity)
    rec.profit = round(rec.amount - rec.cogs - rec.freight_total - rec.pack_cost, 2)
    _apply_pack_settlement(db, rec)
    for pid in old_affected:  # 从清单里移除的旧包材也要重算回库存
        recompute_product(db, pid)
    db.commit()
    db.refresh(rec)
    return _in_dict(db, rec)


@router.delete("/{rid}")
def delete_inbound(rid: int, db: Session = Depends(get_db), user: User = Depends(get_current_user)):
    rec = db.get(WarehouseIn, rid)
    if not rec:
        raise HTTPException(404, "入仓记录不存在")
    affected = _clear_pack_settlement(db, rid)
    db.delete(rec)
    for pid in affected:
        recompute_product(db, pid)
    db.commit()
    return {"ok": True}


class BatchIds(BaseModel):
    ids: list[int]


@router.post("/batch-delete")
def batch_delete(data: BatchIds, db: Session = Depends(get_db), user: User = Depends(get_current_user)):
    deleted = 0
    affected: set[int] = set()
    for rid in data.ids:
        rec = db.get(WarehouseIn, rid)
        if rec:
            affected |= _clear_pack_settlement(db, rid)
            db.delete(rec)
            deleted += 1
    for pid in affected:
        recompute_product(db, pid)
    db.commit()
    return {"ok": True, "deleted": deleted}


# ---------------- 导入常温贴单 ----------------
def _match_product(products: list[WarehouseProduct], name: str) -> tuple[WarehouseProduct | None, float]:
    """按名称匹配入仓品：先精确名，再核心名精确/模糊。返回 (入仓品, 匹配分)。"""
    key = (name or "").strip()
    if not key:
        return None, 0.0
    for p in products:
        if p.name == key:
            return p, 1.0
    core = _core(key)
    for p in products:
        if _core(p.name) == core and core:
            return p, 0.99
    best, best_score = None, 0.0
    for p in products:
        score = difflib.SequenceMatcher(None, core, _core(p.name)).ratio()
        if score > best_score:
            best, best_score = p, score
    if best and best_score >= 0.6:
        return best, round(best_score, 3)
    score = 0.0
    for p in products:
        s = difflib.SequenceMatcher(None, _norm(key), _norm(p.name)).ratio()
        if s > score:
            best, score = p, s
    if best and score >= 0.5:
        return best, round(score, 3)
    return None, round(score, 3)


@router.post("/import/preview")
def import_preview(
    file: UploadFile = File(...),
    sheet: str = Form(""),
    date: str = Form(""),
    db: Session = Depends(get_db),
    user: User = Depends(get_current_user),
):
    wb = _load_workbook(file)
    sheets = wb.sheetnames
    sheet_name = (sheet or "").strip()
    if sheet_name and sheet_name not in sheets:
        raise HTTPException(400, f"工作表「{sheet_name}」不存在，可选：{'、'.join(sheets)}")
    if not sheet_name:
        sheet_name = next((s for s in sheets if "常温" in s), None) or (sheets[0] if sheets else "")
    if not sheet_name:
        raise HTTPException(400, "Excel 中没有可读取的工作表")
    ws = wb[sheet_name]
    rows = [list(r) for r in ws.iter_rows(values_only=True)]
    mapping, start = _detect_header(rows, WH_ALIASES)
    if not mapping or "product" not in mapping:
        raise HTTPException(400, "未识别到表头（需包含「商品名称」等列），请确认工作表内容")

    products = list(db.execute(select(WarehouseProduct)).scalars())
    deduction = _warehouse_deduction(db)
    default_date = (date or "").strip() or datetime.now().strftime("%Y-%m-%d")
    items, failed = [], []
    last_purchase_no = ""
    for i in range(start, len(rows)):
        row = rows[i]
        raw_pn = _cell(row, mapping.get("purchase_no"))
        if raw_pn:  # 合并单元格：采购单号仅首行有值，向下回填
            last_purchase_no = raw_pn
        purchase_no = raw_pn or last_purchase_no
        name = _cell(row, mapping.get("product"))
        if not name:
            continue
        qty = _to_float(_cell(row, mapping.get("quantity")), 0.0)
        if qty <= 0:
            failed.append({"row": i + 1, "reason": f"「{name}」数量无效"})
            continue
        box_count = _to_float(_cell(row, mapping.get("box_count")), 0.0)
        box_spec = _to_float(_cell(row, mapping.get("box_spec")), 0.0)
        product, score = _match_product(products, name)
        sp, _base_cost, factor, unit_cost = _stock_info(db, product.stock_product_id if product else None)
        # 每袋净重（默认单位）：优先商品名内嵌规格(克) ÷ 换算系数，其次入仓品维护值
        grams = _parse_weight_grams(name)
        bag_weight = round(grams / factor, 6) if (grams and factor) else float((product.bag_weight if product else 0) or 0)
        unit_price = product.purchase_price if product else 0.0
        freight = product.freight if product else 0.0
        revenue = round(qty * unit_price * (1 - deduction / 100), 2)
        cogs = round(qty * bag_weight * unit_cost, 2)
        freight_total = round(qty * freight, 2)
        items.append({
            "row": i + 1,
            "purchase_no": purchase_no,
            "product_name": name,
            "center": _cell(row, mapping.get("center")),
            "quantity": qty,
            "box_count": box_count,
            "box_spec": box_spec or (product.box_spec if product else 0.0),
            "product_id": product.id if product else None,
            "matched_name": product.name if product else "",
            "category": product.category if product else "",
            "unit_price": unit_price,
            "deduction_percent": deduction,
            "net_price": round(unit_price * (1 - deduction / 100), 4),
            "freight": freight,
            "bag_weight": bag_weight,
            "unit_cost": unit_cost,
            "stock_product_name": sp.name if sp else "",
            "stock_default_unit": _stock_default_unit(sp),
            "revenue": revenue,
            "cogs": cogs,
            "freight_total": freight_total,
            "profit": round(revenue - cogs - freight_total, 2),
            "match_score": score,
        })
    totals = {
        "revenue": round(sum(it["revenue"] for it in items), 2),
        "cogs": round(sum(it["cogs"] for it in items), 2),
        "freight": round(sum(it["freight_total"] for it in items), 2),
        "profit": round(sum(it["profit"] for it in items), 2),
        "quantity": round(sum(it["quantity"] for it in items), 2),
    }
    return {
        "sheet": sheet_name,
        "sheets": sheets,
        "date": default_date,
        "items": items,
        "totals": totals,
        "failed": failed,
        "failed_count": len(failed),
    }


class ConfirmItem(BaseModel):
    product_id: int | None = None
    product_name: str = ""
    category: str = ""
    unit: str = "袋"
    purchase_no: str = ""
    center: str = ""
    quantity: float
    box_count: float = 0.0
    box_spec: float = 0.0
    unit_price: float = 0.0
    freight: float = 0.0
    bag_weight: float = 0.0
    date: str = ""
    remark: str = ""


class ConfirmIn(BaseModel):
    date: str = ""
    items: list[ConfirmItem] = []


@router.post("/import/confirm")
def import_confirm(data: ConfirmIn, db: Session = Depends(get_db), user: User = Depends(get_current_user)):
    if not data.items:
        raise HTTPException(400, "没有可入仓的数据")
    group = f"wh{uuid.uuid4().hex[:10]}"
    created, failed = 0, []
    for it in data.items:
        payload = it.model_dump()
        if not payload.get("date"):
            payload["date"] = data.date
        try:
            _create_record(db, payload, operator=user.name, import_group=group)
            db.flush()
            created += 1
        except Exception as e:
            failed.append({"row": it.product_name or it.purchase_no, "reason": str(e)})
    db.commit()
    return {"ok": True, "created": created, "failed": failed, "failed_count": len(failed), "group": group}
