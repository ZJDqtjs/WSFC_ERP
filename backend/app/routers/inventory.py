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
    avg_cost_adj: str = ""  # 平均成本相对调整：形如 +2 / -1（留空=不调整），按展示单位单价计（如 元/斤），在现有均价基础上升降
    unit_cost_adj: str = ""  # 成本单价(参考成本)相对调整：形如 +2 / -1（留空=不调整），按展示单位单价计，在现有成本单价基础上升降
    remark: str = ""
    operator: str = ""
    date: str


def _parse_rel(s: str, what: str) -> float:
    """解析相对调整串，要求形如 +100 / -1.5，返回数值；空串返回 None。"""
    s = (s or "").strip()
    if not s:
        return None
    if not re.match(r"^[+-]\d+(\.\d+)?$", s):
        raise HTTPException(400, f"{what}必须以 + 或 - 开头（如 +2 增加 / -1 减少），不允许直接填裸数字；留空则不调整")
    v = float(s)
    if v == 0:
        raise HTTPException(400, f"{what}不能为 0（需要不调整请留空）")
    return v


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
    """相对盘点调整：
    库存 +100 / -100（按展示单位）、
    平均成本 +2 / -1（元/展示单位，在现有均价基础上升降，影响库存价值与未来出库成本结转）、
    成本单价 +2 / -1（元/展示单位，在现有 unit_cost 基础上升降，仅影响参考成本，不影响库存价值）。
    均使用 +/- 相对当前值调整；留空则不调整。"""
    p = db.get(Product, data.product_id)
    if not p:
        raise HTTPException(404, "商品不存在")
    conv = p.conversions or {}
    du = p.default_unit or p.base_unit
    f_disp = conv.get(du, 1) or 1
    op = data.operator.strip() or user.name
    reason = (data.remark or "").strip()  # 盘点原因（在盘点记录备注栏展示，供追溯）
    adjust_summary = ""

    qty_str = (data.quantity or "").strip()
    avg_str = (data.avg_cost_adj or "").strip()
    uc_str = (data.unit_cost_adj or "").strip()
    if not qty_str and not avg_str and not uc_str:
        return {
            "ok": True, "adjusted": False,
            "stock": p.stock, "display": round(p.stock / f_disp, 4), "unit": du,
            "avg_cost": p.avg_cost, "unit_cost": p.unit_cost,
            "message": "数量与成本均留空，未进行调整",
        }

    movements = []
    delta_disp = 0.0
    parts = []

    # 1) 平均成本相对调整：在现有均价基础上增减（按展示单位单价），作用于当前全部库存
    avg_delta_disp = 0.0
    if avg_str:
        avg_delta_disp = _parse_rel(avg_str, "平均成本")
        avg_delta_base = round(avg_delta_disp / f_disp, 6)
        value_delta = round(p.stock * avg_delta_base, 2)
        if value_delta != 0:
            movements.append(
                StockMovement(
                    product_id=p.id,
                    move_type="cost",
                    quantity_base=0.0,
                    amount=value_delta,
                    ref_type="manual",
                    date=data.date,
                    operator=op,
                )
            )
        parts.append(f"均价{avg_delta_disp:+g}元/{du}")

    # 2) 成本单价（参考成本）相对调整：直接修改 product.unit_cost 字段，并记录一条 ucost 流水用于回退
    uc_delta_base = 0.0
    if uc_str:
        uc_delta_disp = _parse_rel(uc_str, "成本单价")
        uc_delta_base = round(uc_delta_disp / f_disp, 6)
        p.unit_cost = max(round((p.unit_cost or 0) + uc_delta_base, 6), 0.0)
        movements.append(
            StockMovement(
                product_id=p.id,
                move_type="ucost",
                quantity_base=0.0,
                amount=round(uc_delta_base, 6),  # 记录单位成本增量（基础单位），删除回退时反向抵扣
                ref_type="manual",
                date=data.date,
                operator=op,
            )
        )
        parts.append(f"成本单价{uc_delta_disp:+g}元/{du}")

    # 3) 库存相对调整
    if qty_str:
        delta_disp = _parse_rel(qty_str, "调整数量")
        unit = data.unit or du
        f = conv.get(unit, 1) or 1
        delta_base = round(delta_disp * f, 6)
        # 盘盈金额：按“保持均价不变”的原则入账。若按现均价(sum = qty×avg)入账，
        # 在负库存(库存价值被截到0)时会把均价抬高（如 -0.17kg 盘盈 +3kg → 1060.07元/kg）。
        # 改为 amount = 目标均价×(调整后库存) - 现库存价值，使均价(含同期均价重估)保持不变。
        amount = 0.0
        if delta_base > 0:
            S0 = p.stock or 0.0
            V_eff = p.stock_value or 0.0  # 现库存价值（负库存时为0）
            A_eff = p.avg_cost or 0.0     # 现均价（每基础单位）
            if avg_str and S0 > 0:        # 与均价重估流水同步：先重估再盘盈
                A_eff += avg_delta_base
                V_eff += S0 * avg_delta_base
            ns = S0 + delta_base
            if ns > 0:
                amount = round(A_eff * ns - V_eff, 2)
        movements.append(
            StockMovement(
                product_id=p.id,
                move_type="adjust",
                quantity_base=delta_base,
                amount=amount,
                ref_type="manual",
                date=data.date,
                operator=op,
                remark=f"盘点调整：{reason}".strip() if reason else "",
            )
        )

    for m in movements:
        db.add(m)
    db.flush()
    group_id = movements[0].id if movements else 0
    for m in movements:
        m.ref_id = group_id
        if not m.remark:
            m.remark = (f"盘点调整：{reason}".strip() if reason
                        else (f"盘点调整：{', '.join(parts)}".strip() if parts else "盘点调整"))

    recompute_product(db, p.id)
    db.commit()
    db.refresh(p)
    msg_parts = []
    if qty_str:
        msg_parts.append(f"库存{delta_disp:+.6g} {du}")
    if avg_str:
        msg_parts.append(f"均价{avg_delta_disp:+g}元/{du}")
    if uc_str:
        msg_parts.append(f"成本单价{uc_delta_disp:+g}元/{du}")
    return {
        "ok": True, "adjusted": True,
        "adjustment_id": group_id,
        "quantity": delta_disp, "unit": du,
        "avg_cost_delta": round(avg_delta_disp, 4) if avg_str else 0.0,
        "unit_cost_delta": round(uc_delta_disp, 4) if uc_str else 0.0,
        "stock": p.stock, "display": round(p.stock / f_disp, 4),
        "avg_cost": round(p.avg_cost * f_disp, 4),
        "unit_cost": round((p.unit_cost or 0) * f_disp, 4),
        "message": "调整成功：" + "；".join(msg_parts) + f"（当前 {round(p.stock / f_disp, 4):g} {du}，均价 {fmt_qty(p.avg_cost * f_disp)}元/{du}）",
    }


@router.get("/adjustments")
def list_adjustments(
    product_id: int = 0,
    date_from: str = "",
    date_to: str = "",
    db: Session = Depends(get_db),
    user: User = Depends(get_current_user),
):
    """盘点调整记录：按一次调整(分组)汇总，展示是谁盘点的、数量/成本变动，供回退。"""
    q = (
        select(StockMovement)
        .where(StockMovement.ref_type == "manual")
        .order_by(StockMovement.ref_id.desc(), StockMovement.id)
    )
    if date_from:
        q = q.where(StockMovement.date >= date_from)
    if date_to:
        q = q.where(StockMovement.date <= date_to)
    matched = db.execute(q).scalars()
    # 按分组聚合：一次调整可能含 成本行 + 库存行；历史 manual 流水(ref_id 为空)按自身 id 单独成组
    groups: dict[int, dict] = {}
    order: list[int] = []
    for m in matched:
        if product_id and m.product_id != product_id:
            continue
        key = m.ref_id if m.ref_id is not None else m.id
        if key not in groups:
            groups[key] = {"rows": [], "product_id": m.product_id}
            order.append(key)
        groups[key]["rows"].append(m)

    # 预载涉及商品的全部流水（id, quantity_base），用于还原每个成本重估流水发生时的库存基数
    involved_ids = {g["product_id"] for g in groups.values()}
    run: dict[int, float] = {pid: 0.0 for pid in involved_ids}
    basis: dict[int, float] = {}  # 成本流水 id -> 发生时库存基数
    for _m in db.execute(
        select(StockMovement)
        .where(StockMovement.product_id.in_(involved_ids))
        .order_by(StockMovement.id)
    ).scalars():
        if _m.move_type == "cost":
            basis[_m.id] = run[_m.product_id]  # 含该成本流水前的全部库存（其自身数量为 0）
        run[_m.product_id] += _m.quantity_base or 0.0

    result = []
    for gid in order:
        g = groups[gid]
        g["rows"].sort(key=lambda r: r.id)
        p = g["rows"][0].product
        if not p:
            continue
        du = p.default_unit or p.base_unit
        f = (p.conversions or {}).get(du, 1) or 1
        qty_move = next((r for r in g["rows"] if r.move_type == "adjust"), None)
        cost_move = next((r for r in g["rows"] if r.move_type == "cost"), None)
        uc_move = next((r for r in g["rows"] if r.move_type == "ucost"), None)
        qty_disp = (qty_move.quantity_base / f) if qty_move else 0.0
        cost_delta = 0.0
        if cost_move:
            b = basis.get(cost_move.id, 0.0)
            cost_delta = (cost_move.amount / b * f) if b > 0 else 0.0
        uc_delta = (uc_move.amount * f) if uc_move else 0.0
        first = g["rows"][0]
        remark = (qty_move.remark if qty_move else uc_move.remark if uc_move else cost_move.remark) or ""
        result.append(
            {
                "id": gid,
                "product_id": p.id,
                "product_name": p.name,
                "unit": du,
                "quantity": round(qty_disp, 4),
                "avg_cost_delta": round(cost_delta, 4),
                "unit_cost_delta": round(uc_delta, 4),
                "date": first.date,
                "operator": first.operator,
                "remark": remark,
                "created_at": first.created_at.strftime("%Y-%m-%d %H:%M:%S") if first.created_at else "",
            }
        )
    return result


@router.delete("/adjustments/{gid}")
def delete_adjustment(gid: int, db: Session = Depends(get_db), user: User = Depends(get_current_user)):
    """删除盘点调整记录并回退：清理该次调整写入的库存/均价/成本单价流水后重算商品，并反向抵消 unit_cost。
    兼容历史 manual 流水(ref_id 为空)：按单一流水 id 匹配。"""
    moves = list(db.execute(
        select(StockMovement).where(
            StockMovement.ref_type == "manual",
            (StockMovement.ref_id == gid) | (StockMovement.ref_id.is_(None) & (StockMovement.id == gid)),
        )
    ).scalars())
    if not moves:
        raise HTTPException(404, "盘点调整记录不存在")
    affected = set()
    # 回退 成本单价(unit_cost)：按记录的增量反向抵扣
    for m in moves:
        affected.add(m.product_id)
        if m.move_type == "ucost" and m.amount:
            pu = db.get(Product, m.product_id)
            if pu:
                pu.unit_cost = max(round((pu.unit_cost or 0) - (m.amount or 0), 6), 0.0)
    for m in moves:
        db.delete(m)
    for pid in affected:
        recompute_product(db, pid)
    db.commit()
    return {"ok": True, "deleted": len(moves)}


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
