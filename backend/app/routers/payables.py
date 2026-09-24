"""待付款账单：把各处的「待付款」单据聚合成一张待办账单。

- 来源：入库（采购）/ 入仓 / 出库（销售回款）/ 其他开支 / 手动记账；
- 各处录入表单默认「已付款」→ 直接进财务报表；勾「待付款」→ 先落到这张账单；
- 点「已支付」→ 标记该单据已结清（入库/出库会同步它自动生成的财务流水），
  随后按原日期纳入财务报表（收入/支出同时计入，避免只算一头导致毛利失真）。
"""
from datetime import date as _date
from datetime import timedelta

from fastapi import APIRouter, Depends, HTTPException
from pydantic import BaseModel
from sqlalchemy import and_, func, or_, select
from sqlalchemy.orm import Session, selectinload

from ..auth import get_current_user
from ..database import get_db
from ..models import (
    FinanceRecord,
    Inbound,
    OtherExpense,
    Outbound,
    OutboundLine,
    Product,
    User,
    WarehouseIn,
)

router = APIRouter(prefix="/api", tags=["payables"])

# kind → 模型（前端按 kind 提交「已支付」）
MODEL_OF = {
    "inbound": Inbound,
    "warehouse_in": WarehouseIn,
    "outbound": Outbound,
    "otherexp": OtherExpense,
    "finance": FinanceRecord,
}
SOURCE_NAME = {
    "inbound": "入库",
    "warehouse_in": "入仓",
    "outbound": "出库",
    "otherexp": "其他开支",
    "finance": "手动记账",
}
# 跳转到对应页面的锚点（前端用于「去处理」）
SOURCE_PAGE = {
    "inbound": "inbound",
    "warehouse_in": "warehouse-in",
    "outbound": "outbound",
    "otherexp": "otherexp",
    "finance": "report",
}


class PayIn(BaseModel):
    kind: str
    id: int
    paid: bool = True  # True=已支付（转入报表），False=撤销为待付款


def _qty(v) -> str:
    s = f"{float(v or 0):.4f}".rstrip("0").rstrip(".")
    return s or "0"


def _row(kind: str, rid: int, date: str, title: str, sub: str, amount: float,
         direction: str, pay_status: str, paid_at: str, operator: str, remark: str,
         code: str = "") -> dict:
    return {
        "kind": kind,
        "source": SOURCE_NAME[kind],
        "page": SOURCE_PAGE[kind],
        "id": rid,
        "code": code,
        "date": date or "",
        "title": title,
        "sub": sub,
        "amount": round(float(amount or 0), 2),
        "direction": direction,  # out=应付（要付出去）/ in=应收（要收进来）
        "pay_status": pay_status or "paid",
        "paid_at": paid_at or "",
        "operator": operator or "",
        "remark": remark or "",
    }


def _pay_filter(model, include_paid: bool, cutoff: str):
    """付款状态过滤（下推到 SQL）。

    pay_status 为空的历史数据按「已付款」看待（与 report._is_paid 同一口径）；
    默认只取「待付款」，勾选「含已结清」时再带上最近 cutoff 之后结清的。

    以前是整表加载后按 pay_status 在内存里筛——几千张出库单连同明细全部 ORM 实例化，
    实测单仓近 1 秒（线上 4 秒+），而真正要展示的常常只有几条。
    """
    unpaid = func.coalesce(model.pay_status, "paid") == "unpaid"
    if not include_paid:
        return unpaid
    settled_recent = and_(
        func.coalesce(model.pay_status, "paid") != "unpaid",
        func.coalesce(func.nullif(model.paid_at, ""), model.date) >= cutoff,
    )
    return or_(unpaid, settled_recent)


def _outbound_titles(db: Session, ids: list[int]) -> dict[int, tuple[str, float, str, int]]:
    """批量取每张出库单「首个销售行」的商品名/数量/单位 + 销售行数，用于拼待办标题。

    出库明细动辄上万行，只为拼一个标题没必要把整棵对象树 selectinload 出来；
    改用聚合查询（按 400 一批，避开 SQLite 变量数上限）。勾选「含已结清」一次列几千张单时，
    这一项就是主要的耗时来源。
    """
    out: dict[int, tuple[str, float, str, int]] = {}
    for i in range(0, len(ids), 400):
        part = ids[i:i + 400]
        counts = dict(db.execute(
            select(OutboundLine.outbound_id, func.count()).where(
                OutboundLine.line_type == "sale", OutboundLine.outbound_id.in_(part)
            ).group_by(OutboundLine.outbound_id)
        ).all())
        for oid, name, qty, unit in db.execute(
            select(OutboundLine.outbound_id, Product.name, OutboundLine.quantity, OutboundLine.unit)
            .join(Product, Product.id == OutboundLine.product_id, isouter=True)
            .where(OutboundLine.line_type == "sale", OutboundLine.outbound_id.in_(part))
            .order_by(OutboundLine.outbound_id, OutboundLine.id)
        ).all():
            if oid in out:
                continue
            out[oid] = (name or "销售", float(qty or 0), unit or "", int(counts.get(oid, 1)))
    return out


def _collect(db: Session, *, include_paid: bool = False, cutoff: str = "") -> list[dict]:
    """汇总待办来源（付款状态过滤已在 SQL 层完成）。"""
    rows: list[dict] = []

    for r in db.execute(
        select(Inbound).options(selectinload(Inbound.product))
        .where(_pay_filter(Inbound, include_paid, cutoff))
    ).scalars():
        name = r.product.name if r.product else ""
        rows.append(_row(
            "inbound", r.id, r.date,
            f"{name} × {_qty(r.quantity)}{r.unit or ''}".strip(),
            "供应商 " + r.supplier if r.supplier else "采购入库",
            r.total_amount + (getattr(r, "adjust_amount", 0.0) or 0.0),  # 应付 = 实付（含抹零/凑整调整）
            "out", r.pay_status, r.paid_at, r.operator, r.remark, r.code,
        ))

    for r in db.execute(
        select(WarehouseIn).where(_pay_filter(WarehouseIn, include_paid, cutoff))
    ).scalars():
        sub = " / ".join(x for x in (f"采购单 {r.purchase_no}" if r.purchase_no else "",
                                     r.center or "") if x) or "入仓"
        if r.freight_total:
            sub += f"（含运费 ¥{round(r.freight_total, 2)}）"
        rows.append(_row(
            "warehouse_in", r.id, r.date,
            f"{r.product_name} × {_qty(r.quantity)}{r.unit or '袋'}",
            sub, r.amount, "in", r.pay_status, r.paid_at, r.operator, r.remark, r.code,
        ))

    ob_rows = list(db.execute(
        select(Outbound).where(_pay_filter(Outbound, include_paid, cutoff))
    ).scalars())
    titles = _outbound_titles(db, [r.id for r in ob_rows])
    for r in ob_rows:
        name, qty, unit, n = titles.get(r.id) or ("", 0.0, "", 0)
        if n:
            title = f"{name or '销售'} × {_qty(qty)}{unit}".strip()
            if n > 1:
                title += f" 等 {n} 项"
        else:
            title = f"出库单 {r.code}"
        rows.append(_row(
            "outbound", r.id, r.date, title,
            ("客户 " + r.customer) if r.customer else "销售出库",
            r.total_amount + (getattr(r, "adjust_amount", 0.0) or 0.0),  # 应收 = 实收（含抹零/凑整调整）
            "in", r.pay_status, r.paid_at, r.operator, r.remark, r.code,
        ))

    # 只列手工登记的其他开支：入库/出库金额调整自动生成的记录随主单结算，不单独作为待办
    for r in db.execute(
        select(OtherExpense).where(
            func.coalesce(OtherExpense.ref_type, "") == "",
            _pay_filter(OtherExpense, include_paid, cutoff),
        )
    ).scalars():
        rows.append(_row(
            "otherexp", r.id, r.date, r.category, "其他开支",
            r.amount, "out", r.pay_status, r.paid_at, r.operator, r.remark,
        ))

    # 手动记账里自动生成的流水（入库/出库带出来的）不重复列，由来源单据代表
    for r in db.execute(
        select(FinanceRecord).where(
            FinanceRecord.ref_type == "manual", _pay_filter(FinanceRecord, include_paid, cutoff)
        )
    ).scalars():
        rows.append(_row(
            "finance", r.id, r.date, r.category,
            "手动记账 · " + ("收入" if r.type == "income" else "支出"),
            r.amount, "in" if r.type == "income" else "out",
            r.pay_status, r.paid_at, r.operator, r.remark,
        ))
    return rows


@router.get("/payables")
def list_payables(
    include_paid: int = 0,
    days: int = 30,
    db: Session = Depends(get_db),
    user: User = Depends(get_current_user),
):
    """待付款/待收款账单。

    - include_paid=0（默认）：只列未结清的（待办）；
    - include_paid=1：额外带上最近 days 天内已结清的（可撤销，改回待付款）。
    """
    cutoff = (_date.today() - timedelta(days=max(1, days))).isoformat()
    # 过滤已下推到 SQL：默认只查「待付款」的少量单据，不再把整库单据+明细拉进内存
    all_rows = _collect(db, include_paid=bool(include_paid), cutoff=cutoff)
    unpaid = [r for r in all_rows if r["pay_status"] == "unpaid"]
    paid: list[dict] = [r for r in all_rows if r["pay_status"] != "unpaid"]
    unpaid.sort(key=lambda r: r["date"], reverse=True)
    paid.sort(key=lambda r: (r["paid_at"] or r["date"]), reverse=True)

    def _sum(rows: list[dict], direction: str) -> float:
        return round(sum(r["amount"] for r in rows if r["direction"] == direction), 2)

    return {
        "items": unpaid + paid,
        "total": {
            "unpaid_count": len(unpaid),
            "payables_amount": _sum(unpaid, "out"),      # 待付款（要付出去）
            "receivables_amount": _sum(unpaid, "in"),    # 待收款（要收进来）
            "paid_count": len(paid),
        },
    }


@router.post("/payables/pay")
def pay_bill(data: PayIn, db: Session = Depends(get_db), user: User = Depends(get_current_user)):
    """标记已支付（转入财务报表）或撤销（改回待付款，从报表移出）。"""
    kind = (data.kind or "").strip()
    model = MODEL_OF.get(kind)
    if not model:
        raise HTTPException(400, "未知的账单类型")
    rec = db.get(model, data.id)
    if not rec:
        raise HTTPException(404, "账单不存在")
    rec.pay_status = "paid" if data.paid else "unpaid"
    rec.paid_at = _date.today().isoformat() if data.paid else ""
    # 入库/出库会自动生成财务流水（采购支出 / 销售收入 / 人工打包费），状态要跟着走
    if kind in ("inbound", "outbound"):
        for f in db.execute(
            select(FinanceRecord).where(FinanceRecord.ref_type == kind, FinanceRecord.ref_id == rec.id)
        ).scalars():
            f.pay_status, f.paid_at = rec.pay_status, rec.paid_at
    db.commit()
    return {
        "ok": True,
        "kind": kind,
        "id": rec.id,
        "source": SOURCE_NAME[kind],
        "pay_status": rec.pay_status,
        "paid_at": rec.paid_at,
    }
