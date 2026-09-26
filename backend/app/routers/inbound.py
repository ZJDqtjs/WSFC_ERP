import re

from fastapi import APIRouter, Depends, HTTPException
from pydantic import BaseModel
from sqlalchemy import select
from sqlalchemy.orm import Session, selectinload

from ..auth import get_current_user
from ..database import get_db
from ..models import FinanceRecord, Inbound, OtherExpense, Product, StockMovement, User
from ..services import create_inbound, pay_fields, purge_inbounds, recompute_product, sync_doc_edit

router = APIRouter(prefix="/api/inbounds", tags=["inbound"])

DATE_RE = re.compile(r"^\d{4}-\d{2}-\d{2}$")


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
    pay_status: str = "paid"  # paid 已付款（默认）/ unpaid 待付款（先进「待付款账单」）
    # 金额调整（抹零/凑整）：正=多付给供应商，负=少付。商品成本按原价不变，差额自动记「金额调整」其他开支
    adjust_amount: float = 0.0
    # 运费 / 装卸费（选填，≥0）：计入该批次到岸成本（体现在这个品的毛利上），
    # 并自动在「其他开支」生成镜像行供查询（ref_type="inbound_fee"，报表期间费用不重复扣）
    freight: float = 0.0
    handling: float = 0.0


class InboundUpdate(BaseModel):
    """手动修改入库单：只允许改 供应商 / 日期 / 付款状态（其余字段须删除重建）。"""

    supplier: str = ""
    date: str
    pay_status: str = "paid"


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
        "adjust_amount": round(getattr(r, "adjust_amount", 0.0) or 0.0, 2),
        "final_amount": round((r.total_amount or 0.0) + (getattr(r, "adjust_amount", 0.0) or 0.0), 2),
        # 运费/装卸费：已计入批次到岸成本（landed_amount = 货款 + 这两项），并在「其他开支」留有镜像行
        "freight": round(getattr(r, "freight", 0.0) or 0.0, 2),
        "handling": round(getattr(r, "handling", 0.0) or 0.0, 2),
        "landed_amount": round(
            (r.total_amount or 0.0) + (getattr(r, "freight", 0.0) or 0.0) + (getattr(r, "handling", 0.0) or 0.0), 2
        ),
        "supplier": r.supplier,
        "operator": r.operator,
        "date": r.date,
        "remark": r.remark,
        "pay_status": getattr(r, "pay_status", "paid") or "paid",
        "paid_at": getattr(r, "paid_at", "") or "",
    }


@router.get("")
def list_inbounds(date_from: str = "", date_to: str = "", db: Session = Depends(get_db), user: User = Depends(get_current_user)):
    # _to_dict 访问 r.product，selectinload 预载避免每行一条懒加载查询
    q = select(Inbound).options(selectinload(Inbound.product)).order_by(Inbound.id.desc())
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
            # 操作员固定为当前登录账号：忽略前端传入的 operator，避免被改成别人
            {**data.model_dump(), "operator": user.name},
            operator=user.name,
        )
    except ValueError as e:
        raise HTTPException(400, str(e))
    db.commit()
    db.refresh(rec)
    return _to_dict(rec)


@router.put("/{rid}")
def update_inbound(rid: int, data: InboundUpdate, db: Session = Depends(get_db), user: User = Depends(get_current_user)):
    """手动修改入库单：只允许改 供应商 / 日期 / 付款状态；操作员记为本次修改人。"""
    rec = db.get(Inbound, rid)
    if not rec:
        raise HTTPException(404, "入库单不存在")
    date = (data.date or "").strip()
    if not DATE_RE.match(date):
        raise HTTPException(400, "日期格式应为 YYYY-MM-DD")
    pay = pay_fields({"pay_status": data.pay_status, "paid_at": ""}, date)
    rec.supplier = (data.supplier or "").strip()
    rec.date = date
    rec.operator = user.name   # 记录为后来的修改人（忽略前端传值）
    rec.pay_status, rec.paid_at = pay["pay_status"], pay["paid_at"]
    sync_doc_edit(db, "inbound", rid, date, user.name, pay)
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
    # 金额调整 / 运费装卸镜像行带出的其他开支一并删除，避免删单后报表或「其他开支」还挂着这些记录
    for e in db.execute(
        select(OtherExpense).where(
            OtherExpense.ref_type.in_(["inbound", "inbound_fee"]), OtherExpense.ref_id == rid
        )
    ).scalars():
        db.delete(e)
    db.delete(rec)
    recompute_product(db, pid)
    db.commit()
    return {"ok": True}


@router.post("/batch-delete")
def batch_delete_inbounds(data: BatchIds, db: Session = Depends(get_db), user: User = Depends(get_current_user)):
    deleted, missing, _affected = purge_inbounds(db, data.ids)
    db.commit()
    return {"ok": True, "deleted": deleted, "missing": missing}
