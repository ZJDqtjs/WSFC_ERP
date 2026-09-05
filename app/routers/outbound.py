from fastapi import APIRouter, Depends, HTTPException
from pydantic import BaseModel, Field
from sqlalchemy import select
from sqlalchemy.orm import Session

from ..auth import get_current_user
from ..database import get_db
from ..models import FinanceRecord, Outbound, Product, StockMovement, User
from ..services import build_order, create_outbound, recompute_product

router = APIRouter(prefix="/api/outbounds", tags=["outbound"])


class SaleLine(BaseModel):
    product_id: int
    unit: str
    quantity: float
    price: float = 0.0
    pack_fee: float | None = None


class PackLine(BaseModel):
    product_id: int
    unit: str
    quantity: float


class PreviewIn(BaseModel):
    lines: list[SaleLine]


class OutboundIn(BaseModel):
    customer: str = ""
    operator: str = ""
    date: str
    remark: str = ""
    lines: list[SaleLine]
    pack_lines: list[PackLine] = Field(default=[])
    pack_fee_total: float | None = None


class BatchIds(BaseModel):
    ids: list[int]


def _to_dict(o: Outbound) -> dict:
    return {
        "id": o.id,
        "code": o.code,
        "import_group": o.import_group,
        "customer": o.customer,
        "operator": o.operator,
        "date": o.date,
        "remark": o.remark,
        "total_amount": o.total_amount,
        "total_cogs": o.total_cogs,
        "total_fee": o.total_fee,
        "gross_profit": round(o.total_amount - o.total_cogs, 2),
        "net_profit": round(o.total_amount - o.total_cogs - o.total_fee, 2),
        "lines": [
            {
                "product_id": l.product_id,
                "product_name": l.product.name if l.product else "",
                "line_type": l.line_type,
                "unit": l.unit,
                "quantity": l.quantity,
                "quantity_base": l.quantity_base,
                "unit_price": l.unit_price,
                "amount": l.amount,
                "cogs": l.cogs,
                "pack_fee": l.pack_fee,
            }
            for l in o.lines
        ],
    }


@router.post("/preview")
def preview(data: PreviewIn, db: Session = Depends(get_db), user: User = Depends(get_current_user)):
    try:
        return build_order(db, data.lines, [], None)
    except ValueError as e:
        raise HTTPException(400, str(e))


@router.get("")
def list_outbounds(date_from: str = "", date_to: str = "", g: str = "", db: Session = Depends(get_db), user: User = Depends(get_current_user)):
    q = select(Outbound).order_by(Outbound.id.desc())
    if date_from:
        q = q.where(Outbound.date >= date_from)
    if date_to:
        q = q.where(Outbound.date <= date_to)
    if g:
        q = q.where(Outbound.import_group.in_([x for x in g.split(",") if x]))
    return [_to_dict(o) for o in db.execute(q).scalars()]


@router.post("")
def create_outbound_api(data: OutboundIn, db: Session = Depends(get_db), user: User = Depends(get_current_user)):
    try:
        rec, warnings = create_outbound(db, data.model_dump(), operator=user.name)
    except ValueError as e:
        raise HTTPException(400, str(e))
    db.commit()
    db.refresh(rec)
    return {"order": _to_dict(rec), "warnings": warnings}


@router.delete("/{oid}")
def delete_outbound(oid: int, db: Session = Depends(get_db), user: User = Depends(get_current_user)):
    rec = db.get(Outbound, oid)
    if not rec:
        raise HTTPException(404, "出库单不存在")
    affected = set()
    for l in rec.lines:
        affected.add(l.product_id)
    for m in db.execute(select(StockMovement).where(StockMovement.ref_type == "outbound", StockMovement.ref_id == oid)).scalars():
        db.delete(m)
    for f in db.execute(select(FinanceRecord).where(FinanceRecord.ref_type == "outbound", FinanceRecord.ref_id == oid)).scalars():
        db.delete(f)
    db.delete(rec)
    for pid in affected:
        recompute_product(db, pid)
    db.commit()
    return {"ok": True}


@router.post("/batch-delete")
def batch_delete_outbounds(data: BatchIds, db: Session = Depends(get_db), user: User = Depends(get_current_user)):
    deleted, missing = 0, 0
    for oid in data.ids:
        rec = db.get(Outbound, oid)
        if not rec:
            missing += 1
            continue
        affected = {l.product_id for l in rec.lines}
        for m in db.execute(select(StockMovement).where(StockMovement.ref_type == "outbound", StockMovement.ref_id == oid)).scalars():
            db.delete(m)
        for f in db.execute(select(FinanceRecord).where(FinanceRecord.ref_type == "outbound", FinanceRecord.ref_id == oid)).scalars():
            db.delete(f)
        db.delete(rec)
        for pid in affected:
            recompute_product(db, pid)
        deleted += 1
    db.commit()
    return {"ok": True, "deleted": deleted, "missing": missing}
