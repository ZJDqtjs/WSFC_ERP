"""其他开支：仓库/经营中的零散支出（网线费、安装费、机器费、样品费等）。

- 按「费用类型 + 日期」独立记账，供「经营分析 → 其他开支」页做按日 / 按月 / 按类型统计；
- 财务报表（/report/summary）与工作台（/dashboard）把它并入「期间费用」，
  从毛利中扣减得到净利——所以不要再在「手动记账」里重复录一遍，避免重复扣减。
"""
import re
from datetime import date as _date
from datetime import datetime

from fastapi import APIRouter, Depends, HTTPException
from pydantic import BaseModel
from sqlalchemy import select
from sqlalchemy.orm import Session

from ..auth import get_current_user
from ..database import get_db
from ..models import OtherExpense, User

router = APIRouter(prefix="/api", tags=["other-expense"])

# 预设费用类型（前端下拉建议；也允许直接输入新类型，保存后自动进入建议列表）
PRESET_CATEGORIES = [
    "金额调整",  # 入库/出库抹零·凑整自动生成（也可手动登记）
    "网线费", "安装费", "机器费", "样品费", "设备维修", "水电费", "搬运费", "办公用品", "其他",
]

DATE_RE = re.compile(r"^\d{4}-\d{2}-\d{2}$")


class OtherExpenseIn(BaseModel):
    category: str
    amount: float
    date: str
    remark: str = ""
    pay_status: str = "paid"  # paid 已付款（默认）/ unpaid 待付款（先进「待付款账单」，支付后才计入报表）


def _to_dict(e: OtherExpense) -> dict:
    return {
        "id": e.id,
        "category": e.category,
        "amount": round(e.amount or 0.0, 2),
        "date": e.date,
        "remark": e.remark or "",
        "operator": e.operator or "",
        "pay_status": getattr(e, "pay_status", "paid") or "paid",
        "paid_at": getattr(e, "paid_at", "") or "",
        # 来源单据（入库/出库金额调整自动生成）：非空表示由单据带出，删除/改日期随单据同步
        "ref_type": getattr(e, "ref_type", "") or "",
        "ref_id": getattr(e, "ref_id", None),
        "created_at": e.created_at.isoformat(timespec="seconds") if e.created_at else "",
    }


def _clean(data: OtherExpenseIn) -> tuple[str, float, str, str, str]:
    category = (data.category or "").strip()
    if not category:
        raise HTTPException(400, "请填写费用类型（如 网线费 / 安装费 / 机器费 / 样品费）")
    if len(category) > 32:
        raise HTTPException(400, "费用类型过长（≤32 字）")
    try:
        amount = round(float(data.amount), 2)
    except (TypeError, ValueError):
        raise HTTPException(400, "金额格式不正确")
    if amount <= 0:
        raise HTTPException(400, "金额必须大于 0")
    day = (data.date or "").strip()
    if not DATE_RE.match(day):
        raise HTTPException(400, "日期格式应为 YYYY-MM-DD")
    pay = "unpaid" if (data.pay_status or "").strip() == "unpaid" else "paid"
    return category, amount, day, (data.remark or "").strip(), pay


@router.get("/other-expenses")
def list_other_expenses(
    date_from: str = "",
    date_to: str = "",
    category: str = "",
    db: Session = Depends(get_db),
    user: User = Depends(get_current_user),
):
    """开支明细：按日期倒序（可按日期区间 / 类型过滤）。"""
    q = select(OtherExpense).order_by(OtherExpense.date.desc(), OtherExpense.id.desc())
    if date_from:
        q = q.where(OtherExpense.date >= date_from)
    if date_to:
        q = q.where(OtherExpense.date <= date_to)
    if category:
        q = q.where(OtherExpense.category == category)
    return [_to_dict(e) for e in db.execute(q).scalars()]


def _span_days(date_from: str, date_to: str, rows: list[OtherExpense]) -> int:
    """统计区间天数（算日均用）：优先按查询区间，其次按数据实际跨度。"""
    def _parse(s: str):
        try:
            return datetime.strptime(s, "%Y-%m-%d").date()
        except Exception:
            return None

    f, t = _parse(date_from), _parse(date_to)
    if f and t and t >= f:
        return (t - f).days + 1
    days = sorted(r.date for r in rows if DATE_RE.match(r.date or ""))
    if days:
        f2, t2 = _parse(days[0]), _parse(days[-1])
        if f2 and t2:
            return (t2 - f2).days + 1
    return 1 if rows else 0


@router.get("/other-expenses/stats")
def other_expense_stats(
    date_from: str = "",
    date_to: str = "",
    db: Session = Depends(get_db),
    user: User = Depends(get_current_user),
):
    """开支统计：今日 / 本月 / 所选区间（合计、笔数、日均）+ 按日 / 按月 / 按类型。"""
    today = _date.today().isoformat()
    month = today[:7]
    rows = list(db.execute(select(OtherExpense)).scalars())  # 表很小，一次取回做多口径统计

    def _sum(items: list[OtherExpense]) -> float:
        return round(sum(x.amount or 0.0 for x in items), 2)

    today_rows = [r for r in rows if r.date == today]
    month_rows = [r for r in rows if (r.date or "").startswith(month)]
    range_rows = [
        r for r in rows
        if (not date_from or (r.date or "") >= date_from) and (not date_to or (r.date or "") <= date_to)
    ]

    by_category: dict[str, float] = {}
    by_day: dict[str, dict] = {}
    by_month: dict[str, dict] = {}
    for r in range_rows:
        amt = r.amount or 0.0
        by_category[r.category] = by_category.get(r.category, 0.0) + amt
        for bucket, key in ((by_day, r.date), (by_month, (r.date or "")[:7])):
            b = bucket.setdefault(key, {"amount": 0.0, "count": 0})
            b["amount"] += amt
            b["count"] += 1

    span = _span_days(date_from, date_to, range_rows)
    range_total = _sum(range_rows)
    used = {r.category for r in rows}
    return {
        "today": today,
        "month": month,
        "today_total": _sum(today_rows),
        "month_total": _sum(month_rows),
        "date_from": date_from,
        "date_to": date_to,
        "range_total": range_total,
        "range_count": len(range_rows),
        "range_days": span,
        "range_daily_avg": round(range_total / span, 2) if span else 0.0,
        "by_category": [
            {"category": k, "amount": round(v, 2), "count": sum(1 for r in range_rows if r.category == k)}
            for k, v in sorted(by_category.items(), key=lambda kv: -kv[1])
        ],
        "by_day": [
            {"date": k, "amount": round(v["amount"], 2), "count": v["count"]}
            for k, v in sorted(by_day.items(), reverse=True)
        ],
        "by_month": [
            {"month": k, "amount": round(v["amount"], 2), "count": v["count"]}
            for k, v in sorted(by_month.items(), reverse=True)
        ],
        # 前端下拉建议 = 预设类型 + 已用过的自定义类型
        "presets": PRESET_CATEGORIES + sorted(used - set(PRESET_CATEGORIES)),
    }


@router.post("/other-expenses")
def create_other_expense(
    data: OtherExpenseIn, db: Session = Depends(get_db), user: User = Depends(get_current_user)
):
    """登记一笔其他开支（操作员固定为当前登录账号）。

    待付款的开支先进「待付款账单」，点「已支付」后才计入财务报表的期间费用。
    """
    category, amount, day, remark, pay = _clean(data)
    e = OtherExpense(
        category=category, amount=amount, date=day, remark=remark, operator=user.name,
        pay_status=pay, paid_at=day if pay == "paid" else "",
    )
    db.add(e)
    db.commit()
    db.refresh(e)
    return {"ok": True, "item": _to_dict(e)}


@router.put("/other-expenses/{eid}")
def update_other_expense(
    eid: int, data: OtherExpenseIn, db: Session = Depends(get_db), user: User = Depends(get_current_user)
):
    e = db.get(OtherExpense, eid)
    if not e:
        raise HTTPException(404, "开支记录不存在")
    category, amount, day, remark, pay = _clean(data)
    e.category, e.amount, e.date, e.remark = category, amount, day, remark
    if pay != (e.pay_status or "paid"):
        e.pay_status = pay
        e.paid_at = day if pay == "paid" else ""
    db.commit()
    db.refresh(e)
    return {"ok": True, "item": _to_dict(e)}


@router.delete("/other-expenses/{eid}")
def delete_other_expense(
    eid: int, db: Session = Depends(get_db), user: User = Depends(get_current_user)
):
    e = db.get(OtherExpense, eid)
    if not e:
        raise HTTPException(404, "开支记录不存在")
    db.delete(e)
    db.commit()
    return {"ok": True}
