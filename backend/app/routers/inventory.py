from fastapi import APIRouter, Depends, HTTPException
from pydantic import BaseModel
from sqlalchemy import select
from sqlalchemy.orm import Session

from ..auth import get_current_user
from ..database import get_db
from ..models import Product, StockMovement, User
from ..services import fmt_qty, recompute_product

router = APIRouter(prefix="/api", tags=["inventory"])


class AdjustIn(BaseModel):
    product_id: int
    quantity: float  # 基础单位，正=盘盈，负=盘亏
    unit_price: float = 0.0
    remark: str = ""
    operator: str = ""
    date: str


@router.get("/movements")
def list_movements(
    product_id: int = 0,
    date_from: str = "",
    date_to: str = "",
    db: Session = Depends(get_db),
    user: User = Depends(get_current_user),
):
    q = select(StockMovement).order_by(StockMovement.id.desc()).limit(500)
    if product_id:
        q = q.where(StockMovement.product_id == product_id)
    if date_from:
        q = q.where(StockMovement.date >= date_from)
    if date_to:
        q = q.where(StockMovement.date <= date_to)
    rows = []
    for m in db.execute(q).scalars():
        p = m.product
        du = (p.default_unit or p.base_unit) if p else ""
        conv = (p.conversions or {}) if p else {}
        factor = conv.get(du, 1) or 1
        rows.append(
            {
                "id": m.id,
                "product_id": m.product_id,
                "product_name": m.product.name if m.product else "",
                "move_type": m.move_type,
                "quantity_base": m.quantity_base,
                # 真实单位展示：基础数量换算到商品默认展示单位
                "quantity_display": round(m.quantity_base / factor, 4),
                "unit": du,
                "amount": m.amount,
                "date": m.date,
                "operator": m.operator,
                "remark": m.remark,
            }
        )
    return rows


@router.post("/adjust")
def adjust_stock(data: AdjustIn, db: Session = Depends(get_db), user: User = Depends(get_current_user)):
    p = db.get(Product, data.product_id)
    if not p:
        raise HTTPException(404, "商品不存在")
    if data.quantity == 0:
        raise HTTPException(400, "调整数量不能为 0")
    amount = round(data.quantity * data.unit_price, 2) if data.quantity > 0 else 0.0
    op = data.operator.strip() or user.name
    db.add(
        StockMovement(
            product_id=p.id,
            move_type="adjust",
            quantity_base=data.quantity,
            amount=amount,
            ref_type="manual",
            date=data.date,
            operator=op,
            remark=f"盘点调整：{data.remark.strip()}",
        )
    )
    recompute_product(db, p.id)
    db.commit()
    p = db.get(Product, p.id)
    return {"ok": True, "stock": p.stock, "avg_cost": p.avg_cost, "stock_value": p.stock_value}


@router.get("/stock-overview")
def stock_overview(db: Session = Depends(get_db), user: User = Depends(get_current_user)):
    # 人工/快递 无真实库存，不进入库存总览
    NO_STOCK_CATS = ["人工", "快递"]
    rows = db.execute(
        select(Product).where(
            Product.is_active.is_(True),
            Product.product_type == "stock",
            Product.category.not_in(NO_STOCK_CATS),
        )
        .order_by(Product.category, Product.name)
    ).scalars()
    result = []
    for p in rows:
        du = p.default_unit or p.base_unit
        conv = p.conversions or {}
        factor = conv.get(du, 1) or 1
        # 真实单位展示：库存（基础单位克）换算到默认展示单位（如 公斤）
        stock_disp = f"{fmt_qty(p.stock / factor)} {du}" if factor != 1 else f"{fmt_qty(p.stock)} {p.base_unit}"
        result.append(
            {
                "id": p.id,
                "name": p.name,
                "category": p.category,
                "base_unit": p.base_unit,
                "default_unit": du,
                "conversions": conv,
                "stock": p.stock,
                "stock_display": stock_disp,
                "avg_cost": p.avg_cost,
                "stock_value": p.stock_value,
            }
        )
    return result
