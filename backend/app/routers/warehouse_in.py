"""入仓：按「袋」采购的备货商品（半加工等）入仓台账。

- 入仓品资料：名称 / 类目 / SKU / 69码 / 箱规 / 采购价(元/袋) / 运费(元/袋，暂空待维护)。
- 入仓记录：入库数量（袋）、箱数、采购单号、配送中心、采购价/运费快照与成本合计。
- 导入《入仓配送明细》常温贴单：按「采购单号 / 商品名称 / 箱数 / 配送中心 / 数量 / 箱规」
  解析每一行，自动匹配入仓品（可人工调整），确认后按对应数量入仓。

入仓记录独立于库存商品(Product)，不改变现有库存；仅作为入仓成本台账。
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
from ..models import User, WarehouseIn, WarehouseProduct

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


# ---------------- 序列化 ----------------
def _product_dict(p: WarehouseProduct) -> dict:
    return {
        "id": p.id, "name": p.name, "category": p.category, "sku": p.sku,
        "barcode": p.barcode, "box_spec": p.box_spec,
        "purchase_price": p.purchase_price, "freight": p.freight,
        "shelf_life": p.shelf_life, "remark": p.remark, "is_active": p.is_active,
    }


def _in_dict(r: WarehouseIn) -> dict:
    return {
        "id": r.id, "code": r.code, "product_id": r.product_id,
        "product_name": r.product_name, "category": r.category, "unit": r.unit,
        "purchase_no": r.purchase_no, "center": r.center,
        "quantity": r.quantity, "box_count": r.box_count, "box_spec": r.box_spec,
        "unit_price": r.unit_price, "freight": r.freight, "amount": r.amount,
        "date": r.date, "operator": r.operator, "remark": r.remark,
        "import_group": r.import_group,
    }


# ---------------- 入仓品资料 ----------------
class ProductIn(BaseModel):
    name: str
    category: str = ""
    sku: str = ""
    barcode: str = ""
    box_spec: float = 0.0
    purchase_price: float = 0.0
    freight: float = 0.0
    shelf_life: str = ""
    remark: str = ""
    is_active: bool = True


@router.get("/products")
def list_products(db: Session = Depends(get_db), user: User = Depends(get_current_user)):
    rows = db.execute(select(WarehouseProduct).order_by(WarehouseProduct.id)).scalars()
    return [_product_dict(p) for p in rows]


@router.post("/products")
def create_product(data: ProductIn, db: Session = Depends(get_db), user: User = Depends(get_current_user)):
    name = (data.name or "").strip()
    if not name:
        raise HTTPException(400, "入仓品名称不能为空")
    p = WarehouseProduct(**{**data.model_dump(), "name": name})
    db.add(p)
    db.commit()
    db.refresh(p)
    return _product_dict(p)


@router.put("/products/{pid}")
def update_product(pid: int, data: ProductIn, db: Session = Depends(get_db), user: User = Depends(get_current_user)):
    p = db.get(WarehouseProduct, pid)
    if not p:
        raise HTTPException(404, "入仓品不存在")
    name = (data.name or "").strip()
    if not name:
        raise HTTPException(400, "入仓品名称不能为空")
    for k, v in data.model_dump().items():
        setattr(p, k, v)
    p.name = name
    db.commit()
    db.refresh(p)
    return _product_dict(p)


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
    unit_price: float = 0.0
    freight: float = 0.0
    date: str
    operator: str = ""
    remark: str = ""


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
    date: str
    remark: str = ""


def _gen_code(db: Session, date: str) -> str:
    count = db.scalar(
        select(func.count()).select_from(WarehouseIn).where(WarehouseIn.code.like(f"RC{date}%"))
    )
    return f"RC{date}-{count + 1:03d}"


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
        freight=freight,
        amount=round(quantity * (unit_price + freight), 2),
        date=date,
        operator=(payload.get("operator") or "").strip() or operator,
        remark=(payload.get("remark") or "").strip(),
        import_group=import_group,
    )
    db.add(rec)
    db.flush()
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
    total_amount = round(sum(r.amount or 0 for r in rows), 2)
    return {"items": [_in_dict(r) for r in rows], "total_amount": total_amount, "count": len(rows)}


@router.post("")
def create_inbound(data: InboundIn, db: Session = Depends(get_db), user: User = Depends(get_current_user)):
    try:
        rec = _create_record(db, data.model_dump(), operator=user.name)
    except ValueError as e:
        raise HTTPException(400, str(e))
    db.commit()
    db.refresh(rec)
    return _in_dict(rec)


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
    rec.amount = round(rec.quantity * (rec.unit_price + rec.freight), 2)
    db.commit()
    db.refresh(rec)
    return _in_dict(rec)


@router.delete("/{rid}")
def delete_inbound(rid: int, db: Session = Depends(get_db), user: User = Depends(get_current_user)):
    rec = db.get(WarehouseIn, rid)
    if not rec:
        raise HTTPException(404, "入仓记录不存在")
    db.delete(rec)
    db.commit()
    return {"ok": True}


class BatchIds(BaseModel):
    ids: list[int]


@router.post("/batch-delete")
def batch_delete(data: BatchIds, db: Session = Depends(get_db), user: User = Depends(get_current_user)):
    deleted = 0
    for rid in data.ids:
        rec = db.get(WarehouseIn, rid)
        if rec:
            db.delete(rec)
            deleted += 1
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
    default_date = (date or "").strip() or datetime.now().strftime("%Y-%m-%d")
    items, failed = [], []
    for i in range(start, len(rows)):
        row = rows[i]
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
        items.append({
            "row": i + 1,
            "purchase_no": _cell(row, mapping.get("purchase_no")),
            "product_name": name,
            "center": _cell(row, mapping.get("center")),
            "quantity": qty,
            "box_count": box_count,
            "box_spec": box_spec or (product.box_spec if product else 0.0),
            "product_id": product.id if product else None,
            "matched_name": product.name if product else "",
            "category": product.category if product else "",
            "unit_price": product.purchase_price if product else 0.0,
            "freight": product.freight if product else 0.0,
            "match_score": score,
        })
    return {
        "sheet": sheet_name,
        "sheets": sheets,
        "date": default_date,
        "items": items,
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
