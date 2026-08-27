from fastapi import APIRouter, Depends, HTTPException
from pydantic import BaseModel
from sqlalchemy import select
from sqlalchemy.orm import Session

from ..auth import get_current_user
from ..database import get_db
from ..models import FinanceRecord, Inbound, Product, StockMovement, User
from ..services import create_inbound, recompute_product

router = APIRouter(prefix="/api/inbounds", tags=["inbound"])


class BatchIds(BaseModel):
    ids: list[int]


class InboundIn(BaseModel):
    product_id: int
    unit: str
    quantity: float
    unit_price: float
    supplier: str = ""
    operator: str = ""
    date: str
    remark: str = ""


def _to_dict(r: Inbound) -> dict:
    return {
        "id": r.id,
        "code": r.code,
        "product_id": r.product_id,
        "product_name": r.product.name if r.product else "",
        "unit": r.unit,
        "quantity": r.quantity,
        "quantity_base": r.quantity_base,
        "unit_price": r.unit_price,
        "total_amount": r.total_amount,
        "supplier": r.supplier,
        "operator": r.operator,
        "date": r.date,
        "remark": r.remark,
    }


@router.get("")
def list_inbounds(date_from: str = "", date_to: str = "", db: Session = Depends(get_db), user: User = Depends(get_current_user)):
    q = select(Inbound).order_by(Inbound.id.desc())
    if date_from:
        q = q.where(Inbound.date >= date_from)
    if date_to:
        q = q.where(Inbound.date <= date_to)
    return [_to_dict(r) for r in db.execute(q).scalars()]


@router.post("")
def create_inbound_api(data: InboundIn, db: Session = Depends(get_db), user: User = Depends(get_current_user)):
    p = db.get(Product, data.product_id)
    if p and p.product_type == "order":
        raise HTTPException(400, f"「{p.name}」是订单商品（小类），请入库其关联的库存商品（大类）")
    try:
        rec = create_inbound(
            db,
            data.model_dump(),
            operator=user.name,
        )
    except ValueError as e:
        raise HTTPException(400, str(e))
    db.commit()
    db.refresh(rec)
    return _to_dict(rec)


@router.delete("/{rid}")
def delete_inbound(rid: int, db: Session = Depends(get_db), user: User = Depends(get_current_user)):
    rec = db.get(Inbound, rid)
    if not rec:
        raise HTTPException(404, "入库单不存在")
    pid = rec.product_id
    for m in db.execute(select(StockMovement).where(StockMovement.ref_type == "inbound", StockMovement.ref_id == rid)).scalars():
        db.delete(m)
    for f in db.execute(select(FinanceRecord).where(FinanceRecord.ref_type == "inbound", FinanceRecord.ref_id == rid)).scalars():
        db.delete(f)
    db.delete(rec)
    recompute_product(db, pid)
    db.commit()
    return {"ok": True}


@router.post("/batch-delete")
def batch_delete_inbounds(data: BatchIds, db: Session = Depends(get_db), user: User = Depends(get_current_user)):
    deleted, missing = 0, 0
    for rid in data.ids:
        rec = db.get(Inbound, rid)
        if not rec:
            missing += 1
            continue
        pid = rec.product_id
        for m in db.execute(select(StockMovement).where(StockMovement.ref_type == "inbound", StockMovement.ref_id == rid)).scalars():
            db.delete(m)
        for f in db.execute(select(FinanceRecord).where(FinanceRecord.ref_type == "inbound", FinanceRecord.ref_id == rid)).scalars():
            db.delete(f)
        db.delete(rec)
        recompute_product(db, pid)
        deleted += 1
    db.commit()
    return {"ok": True, "deleted": deleted, "missing": missing}
