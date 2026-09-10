from fastapi import APIRouter, Depends, HTTPException
from pydantic import BaseModel
from sqlalchemy import func, select
from sqlalchemy.orm import Session

from ..auth import get_current_user
from ..database import get_db
from ..models import FinanceRecord, Inbound, Outbound, OutboundLine, Product, User

router = APIRouter(prefix="/api", tags=["report"])


class FinanceIn(BaseModel):
    type: str  # income / expense
    category: str
    amount: float
    date: str
    operator: str = ""
    remark: str = ""


def _date_filter(q, date_from, date_to):
    if date_from:
        q = q.where(FinanceRecord.date >= date_from)
    if date_to:
        q = q.where(FinanceRecord.date <= date_to)
    return q


# 关联结算行（line_type='pack'）的费用归类：出库时自动结算的包材/人工/快递
PACK_COST_CATS = {
    "人工": "人工打包费",
    "包材": "包材耗材",
    "耗材": "包材耗材",
    "包装": "包材耗材",
    "快递": "快递运费",
}


def _pack_cost_category(p: Product | None, line: OutboundLine) -> str:
    """判断一条关联结算行属于哪类费用（人工打包费 / 包材耗材 / 快递运费）。"""
    if not p:
        return "其他关联结算"
    cat = (p.category or "").strip()
    if cat in PACK_COST_CATS:
        return PACK_COST_CATS[cat]
    # 兜底：名称以「打包」结尾的按人工计（与 outbound._to_dict 的 is_labor 判定一致）
    if (p.name or "").strip().endswith("打包"):
        return "人工打包费"
    return "其他关联结算"


def _pack_cost_breakdown(outbounds: list[Outbound]) -> dict[str, float]:
    """按费用类别汇总出库单的关联结算成本。

    这些成本已包含在 total_cogs 中（不是账外费用），此处仅做结构化拆分，
    让报表能看清「包材 / 人工 / 快递」各花了多少，不重复计入净利。
    """
    out: dict[str, float] = {}
    for o in outbounds:
        for l in o.lines:
            if l.line_type != "pack":
                continue
            key = _pack_cost_category(l.product, l)
            out[key] = round(out.get(key, 0.0) + (l.cogs or 0.0), 2)
    return out


@router.get("/dashboard")
def dashboard(db: Session = Depends(get_db), user: User = Depends(get_current_user)):
    from datetime import date

    today = date.today().isoformat()
    month = today[:8] + "01"

    def range_summary(f, t):
        outbounds = list(
            db.execute(select(Outbound).where(Outbound.date >= f, Outbound.date <= t)).scalars()
        )
        finances = list(
            db.execute(select(FinanceRecord).where(FinanceRecord.date >= f, FinanceRecord.date <= t)).scalars()
        )
        revenue = sum(o.total_amount for o in outbounds)
        cogs = sum(o.total_cogs for o in outbounds)
        fee = sum(x.amount for x in finances if x.type == "expense" and x.category != "采购支出")
        packs = _pack_cost_breakdown(outbounds)
        return {
            "revenue": round(revenue, 2),
            "gross": round(revenue - cogs, 2),
            "net": round(revenue - cogs - fee, 2),
            "orders": len(outbounds),
            "cogs": round(cogs, 2),
            "pack_costs": packs,
            "pack_cost_total": round(sum(packs.values()), 2),
        }

    products = list(db.execute(select(Product)).scalars())
    # 人工/快递 无真实库存，不计入库存统计
    NO_STOCK_CATS = ["人工", "快递"]
    stock_products = [
        p for p in products
        if p.product_type == "stock" and p.category not in NO_STOCK_CATS
    ]
    stock_value = round(sum(p.stock_value for p in stock_products), 2)
    low_stock = [
        {"id": p.id, "name": p.name, "stock": p.stock, "base_unit": p.base_unit,
         "default_unit": p.default_unit, "conversions": p.conversions or {}}
        for p in stock_products
        if p.stock <= 1e-6
    ]
    low_stock.sort(key=lambda x: x["stock"])

    def inbound_snapshot():
        rows = list(db.execute(select(Inbound).order_by(Inbound.id.desc()).limit(6)).scalars())
        return [
            {"code": r.code, "product_name": r.product.name if r.product else "", "quantity": r.quantity,
             "unit": r.unit, "date": r.date, "operator": r.operator, "amount": r.total_amount}
            for r in rows
        ]

    def outbound_snapshot():
        # 最近一批出库（窗口内取足够多行以覆盖近期批次+手动单）
        recent = list(db.execute(select(Outbound).order_by(Outbound.id.desc()).limit(200)).scalars())
        groups: dict[str, list] = {}
        singles = []
        for r in recent:
            if r.import_group:
                groups.setdefault(r.import_group, []).append(r)
            else:
                singles.append(r)
        entries = []
        for g in groups.values():
            key = g[0].import_group
            # 整批真实规模与合计（批次可能远大于窗口）
            cnt, amt, net = db.execute(
                select(
                    func.count(),
                    func.coalesce(func.sum(Outbound.total_amount), 0),
                    func.coalesce(func.sum(Outbound.total_amount - Outbound.total_cogs - Outbound.total_fee), 0),
                ).where(Outbound.import_group == key)
            ).one()
            ls = list(db.execute(
                select(Outbound).where(Outbound.import_group == key).order_by(Outbound.id.desc()).limit(6)
            ).scalars())
            if not ls:
                continue
            entries.append({
                "code": f"批量 · {cnt}单",
                "customer": "/".join(dict.fromkeys(x.customer for x in ls if x.customer)),
                "date": max(x.date for x in ls),
                "operator": ls[0].operator,
                "amount": round(float(amt), 2),
                "net": round(float(net), 2),
                "_sort": max(x.id for x in ls),
            })
        for s in singles:
            entries.append({
                "code": s.code, "customer": s.customer, "date": s.date, "operator": s.operator,
                "amount": s.total_amount, "net": round(s.total_amount - s.total_cogs - s.total_fee, 2),
                "_sort": s.id,
            })
        entries.sort(key=lambda e: -e["_sort"])
        return [{k: v for k, v in e.items() if k != "_sort"} for e in entries[:6]]

    return {
        "user_name": user.name,
        "today": today,
        "today_summary": range_summary(today, today),
        "month_summary": range_summary(month, today),
        "stock_value": stock_value,
        "low_stock": low_stock,
        "recent_inbounds": inbound_snapshot(),
        "recent_outbounds": outbound_snapshot(),
        "product_count": len(stock_products),
    }


@router.get("/report/summary")
def summary(date_from: str = "", date_to: str = "", db: Session = Depends(get_db), user: User = Depends(get_current_user)):
    def scope(model):
        q = select(model)
        if date_from:
            q = q.where(model.date >= date_from)
        if date_to:
            q = q.where(model.date <= date_to)
        return q

    outbounds = list(db.execute(scope(Outbound)).scalars())
    inbounds = list(db.execute(scope(Inbound)).scalars())
    finances = list(db.execute(scope(FinanceRecord)).scalars())

    revenue = sum(o.total_amount for o in outbounds)
    cogs = sum(o.total_cogs for o in outbounds)
    gross = round(revenue - cogs, 2)
    # 期间费用：不含采购支出（采购已计入库存成本）
    expense = sum(f.amount for f in finances if f.type == "expense" and f.category != "采购支出")
    purchase = sum(f.amount for f in finances if f.type == "expense" and f.category == "采购支出")
    purchase_db = sum(i.total_amount for i in inbounds)
    net = round(gross - expense, 2)
    stock_value = round(sum(p.stock_value for p in db.execute(select(Product)).scalars()), 2)

    # 商品维度：销售数量/收入/成本
    by_product = {}
    for o in outbounds:
        for l in o.lines:
            if l.line_type != "sale":
                continue
            d = by_product.setdefault(l.product_id, {"name": l.product.name if l.product else "", "qty": 0.0, "amount": 0.0, "cogs": 0.0})
            d["qty"] += l.quantity_base
            d["amount"] += l.amount
            d["cogs"] += l.cogs
    product_rows = [
        {"product_id": pid, "name": d["name"], "qty": round(d["qty"], 4), "amount": round(d["amount"], 2), "cogs": round(d["cogs"], 2)}
        for pid, d in sorted(by_product.items(), key=lambda kv: -kv[1]["amount"])
    ]

    # 关联结算成本拆分（包材/人工/快递）——已含在 cogs 内，单独列出供分析
    pack_costs = _pack_cost_breakdown(outbounds)
    pack_total = round(sum(pack_costs.values()), 2)
    # 商品本身成本 = 总成本 - 关联结算成本
    goods_cogs = round(cogs - pack_total, 2)

    # 账外费用（finance_records 中登记的手工支出），按类别归集
    manual_fees: dict[str, float] = {}
    for f in finances:
        if f.type != "expense" or f.category == "采购支出":
            continue
        manual_fees[f.category] = round(manual_fees.get(f.category, 0.0) + f.amount, 2)

    return {
        "date_from": date_from,
        "date_to": date_to,
        "revenue": round(revenue, 2),
        "cogs": round(cogs, 2),
        "goods_cogs": goods_cogs,
        "gross_profit": gross,
        "expense": round(expense, 2),
        "net_profit": net,
        "purchase": round(purchase_db, 2),
        "stock_value": stock_value,
        "order_count": len(outbounds),
        "inbound_count": len(inbounds),
        "by_product": product_rows,
        # 出库自动结算的关联成本明细（包材/人工/快递），已包含在 cogs 中
        "pack_costs": pack_costs,
        "pack_cost_total": pack_total,
        # 账外手工登记费用（不含采购支出），会额外从毛利中扣减得到净利
        "manual_fees": manual_fees,
        "fee_breakdown": {
            **pack_costs,
            **{k: v for k, v in manual_fees.items() if k not in pack_costs},
        },
    }


@router.get("/finance")
def list_finance(date_from: str = "", date_to: str = "", db: Session = Depends(get_db), user: User = Depends(get_current_user)):
    q = _date_filter(select(FinanceRecord), date_from, date_to).order_by(FinanceRecord.id.desc())
    return [
        {
            "id": f.id,
            "type": f.type,
            "category": f.category,
            "product_id": f.product_id,
            "product_name": f.product.name if f.product else "",
            "amount": f.amount,
            "date": f.date,
            "operator": f.operator,
            "remark": f.remark,
            "ref_type": f.ref_type,
            "ref_id": f.ref_id,
        }
        for f in db.execute(q).scalars()
    ]


@router.post("/finance")
def create_finance(data: FinanceIn, db: Session = Depends(get_db), user: User = Depends(get_current_user)):
    if data.type not in ("income", "expense"):
        raise HTTPException(400, "类型必须为 income 或 expense")
    if data.amount <= 0:
        raise HTTPException(400, "金额必须大于 0")
    f = FinanceRecord(
        type=data.type,
        category=data.category.strip() or ("销售收入" if data.type == "income" else "其他支出"),
        amount=data.amount,
        date=data.date,
        operator=data.operator.strip() or user.name,
        remark=data.remark.strip(),
        ref_type="manual",
    )
    db.add(f)
    db.commit()
    db.refresh(f)
    return {"ok": True, "id": f.id}


@router.delete("/finance/{fid}")
def delete_finance(fid: int, db: Session = Depends(get_db), user: User = Depends(get_current_user)):
    f = db.get(FinanceRecord, fid)
    if not f:
        raise HTTPException(404, "财务记录不存在")
    if f.ref_type != "manual":
        raise HTTPException(400, "该记录由入库/出库自动生成，请在对应单据中删除")
    db.delete(f)
    db.commit()
    return {"ok": True}
