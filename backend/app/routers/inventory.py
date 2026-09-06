from collections import defaultdict
import re

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
    quantity: str = ""  # 相对调整量：形如 +100 / -100（留空=不调整），按展示单位计
    unit: str = ""      # 调整单位（默认取商品展示/默认单位）
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
        # 默认展示/出库单位下的数量，供表格与柱状图直接展示（如 公斤/个）
        du = (p.default_unit or p.base_unit) if p else ""
        f = ((p.conversions or {}).get(du, 1) or 1) if p else 1
        rows.append(
            {
                "id": m.id,
                "product_id": m.product_id,
                "product_name": p.name if p else "",
                "move_type": m.move_type,
                "quantity_base": m.quantity_base,
                "unit": du,
                "quantity_display": round(m.quantity_base / f, 4),
                "amount": m.amount,
                "date": m.date,
                "operator": m.operator,
                "remark": m.remark,
            }
        )
    return rows


@router.post("/adjust")
def adjust_stock(data: AdjustIn, db: Session = Depends(get_db), user: User = Depends(get_current_user)):
    """相对盘点调整：+100 增加 / -100 减少（按展示单位）；留空则不调整。"""
    p = db.get(Product, data.product_id)
    if not p:
        raise HTTPException(404, "商品不存在")
    qty_str = (data.quantity or "").strip()
    conv = p.conversions or {}
    du = p.default_unit or p.base_unit
    f_disp = conv.get(du, 1) or 1
    if not qty_str:
        # 未填写数量：不调整，返回当前库存
        return {
            "ok": True, "adjusted": False,
            "stock": p.stock, "display": round(p.stock / f_disp, 4), "unit": du,
            "message": "数量留空，未调整库存",
        }
    if not re.match(r"^[+-]\d+(\.\d+)?$", qty_str):
        raise HTTPException(400, "调整数量必须以 + 或 - 开头（如 +100 增加 / -100 减少），不允许直接填裸数字；留空则不调整")
    delta_disp = float(qty_str)
    if delta_disp == 0:
        raise HTTPException(400, "调整数量不能为 0（需要不调整请留空）")
    # 展示单位 → 基础单位（如 +100 公斤 = +100000 克）
    unit = data.unit or du
    f = conv.get(unit, 1) or 1
    delta_base = round(delta_disp * f, 6)
    amount = round(delta_disp * data.unit_price, 2) if delta_disp > 0 else 0.0
    op = data.operator.strip() or user.name
    db.add(
        StockMovement(
            product_id=p.id,
            move_type="adjust",
            quantity_base=delta_base,
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
    return {
        "ok": True, "adjusted": True,
        "quantity": delta_disp, "unit": unit,
        "stock": p.stock, "display": round(p.stock / f_disp, 4),
        "message": f"调整成功：{delta_disp:+.6g} {unit}（当前 {round(p.stock / f_disp, 4):g} {du}）",
    }


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
        # 用默认展示/出库单位显示库存与成本（如 斤/公斤/个），而非基础单位（克）
        du = p.default_unit or p.base_unit
        f = (p.conversions or {}).get(du, 1) or 1
        result.append(
            {
                "id": p.id,
                "name": p.name,
                "category": p.category,
                "base_unit": p.base_unit,
                "default_unit": du,
                "conversions": p.conversions or {},
                "stock": p.stock,
                "stock_display": f"{fmt_qty(p.stock / f)} {du}",
                "avg_cost": p.avg_cost,
                "stock_value": p.stock_value,
            }
        )
    return result


@router.get("/workload")
def workload_report(
    date_from: str = "",
    date_to: str = "",
    db: Session = Depends(get_db),
    user: User = Depends(get_current_user),
):
    """人工工作量统计：按 人工 商品与日期聚合完成的工作量（单，正数）。"""
    rows = db.execute(
        select(StockMovement)
        .join(Product, StockMovement.product_id == Product.id)
        .where(Product.category == "人工")
        .order_by(StockMovement.date)
    ).scalars()
    per_prod: dict[int, float] = defaultdict(float)
    per_date: dict[str, float] = defaultdict(float)
    total = 0.0
    for m in rows:
        if date_from and m.date < date_from:
            continue
        if date_to and m.date > date_to:
            continue
        w = abs(m.quantity_base or 0)
        if not w:
            continue
        per_prod[m.product_id] += w
        per_date[m.date] += w
        total += w

    by_product = []
    for pid, w in per_prod.items():
        p = db.get(Product, pid)
        if not p:
            continue
        rate = p.avg_cost or p.unit_cost or 0
        by_product.append(
            {
                "id": p.id,
                "name": p.name,
                "workload": round(w, 2),
                "unit": p.base_unit or "单",
                "rate": round(rate, 4),
                "cost": round(w * rate, 2),
            }
        )
    by_product.sort(key=lambda x: -x["workload"])
    return {
        "total_workload": round(total, 2),
        "total_cost": round(sum(x["cost"] for x in by_product), 2),
        "by_product": by_product,
        "by_date": [{"date": d, "workload": round(w, 2)} for d, w in sorted(per_date.items())],
    }
