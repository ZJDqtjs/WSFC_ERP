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
from sqlalchemy import select
from sqlalchemy.orm import Session, selectinload

from ..auth import get_current_user
from ..database import get_db
from ..models import (
    FinanceRecord,
    Inbound,
    OtherExpense,
    Outbound,
    OutboundLine,
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


def _collect(db: Session) -> list[dict]:
    """汇总全部待办来源（未过滤付款状态）。"""
    rows: list[dict] = []

    for r in db.execute(select(Inbound).options(selectinload(Inbound.product))).scalars():
        name = r.product.name if r.product else ""
        rows.append(_row(
            "inbound", r.id, r.date,
            f"{name} × {_qty(r.quantity)}{r.unit or ''}".strip(),
            "供应商 " + r.supplier if r.supplier else "采购入库",
            r.total_amount, "out", r.pay_status, r.paid_at, r.operator, r.remark, r.code,
        ))

    for r in db.execute(select(WarehouseIn)).scalars():
        sub = " / ".join(x for x in (f"采购单 {r.purchase_no}" if r.purchase_no else "",
                                     r.center or "") if x) or "入仓"
        if r.freight_total:
            sub += f"（含运费 ¥{round(r.freight_total, 2)}）"
        rows.append(_row(
            "warehouse_in", r.id, r.date,
            f"{r.product_name} × {_qty(r.quantity)}{r.unit or '袋'}",
            sub, r.amount, "in", r.pay_status, r.paid_at, r.operator, r.remark, r.code,
        ))

    for r in db.execute(
        select(Outbound).options(selectinload(Outbound.lines).selectinload(OutboundLine.product))
    ).scalars():
        sales = [l for l in r.lines if l.line_type == "sale"]
        head = sales[0] if sales else None
        title = f"{head.product.name if head and head.product else '销售'} × {_qty(head.quantity)}{head.unit or ''}".strip() \
            if head else f"出库单 {r.code}"
        if len(sales) > 1:
            title += f" 等 {len(sales)} 项"
        rows.append(_row(
            "outbound", r.id, r.date, title,
            ("客户 " + r.customer) if r.customer else "销售出库",
            r.total_amount, "in", r.pay_status, r.paid_at, r.operator, r.remark, r.code,
        ))

    for r in db.execute(select(OtherExpense)).scalars():
        rows.append(_row(
            "otherexp", r.id, r.date, r.category, "其他开支",
            r.amount, "out", r.pay_status, r.paid_at, r.operator, r.remark,
        ))

    # 手动记账里自动生成的流水（入库/出库带出来的）不重复列，由来源单据代表
    for r in db.execute(select(FinanceRecord).where(FinanceRecord.ref_type == "manual")).scalars():
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
    all_rows = _collect(db)
    unpaid = [r for r in all_rows if r["pay_status"] == "unpaid"]
    paid: list[dict] = []
    if include_paid:
        cutoff = (_date.today() - timedelta(days=max(1, days))).isoformat()
        paid = [
            r for r in all_rows
            if r["pay_status"] != "unpaid" and (r["paid_at"] or r["date"]) >= cutoff
        ]
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
