from fastapi import APIRouter, Depends, HTTPException
from pydantic import BaseModel
from sqlalchemy import func, select
from sqlalchemy.orm import Session, selectinload

from ..auth import get_current_user
from ..database import get_db
from ..models import FinanceRecord, Inbound, OtherExpense, Outbound, OutboundLine, Product, User

router = APIRouter(prefix="/api", tags=["report"])


class FinanceIn(BaseModel):
    type: str  # income / expense
    category: str
    amount: float
    date: str
    operator: str = ""
    remark: str = ""
    pay_status: str = "paid"  # paid 已付款（默认）/ unpaid 待付款（先进「待付款账单」）


def _date_filter(q, date_from, date_to):
    if date_from:
        q = q.where(FinanceRecord.date >= date_from)
    if date_to:
        q = q.where(FinanceRecord.date <= date_to)
    return q


# ---------------- 付款状态口径 ----------------
# 规则：单据/流水为「待付款」时**不进财务报表**，先出现在「待付款账单」，点「已支付」后才计入。
# 默认（含历史数据）一律视为「已付款」，因此口径与改造前完全一致，不会凭空改动历史报表。
PAID = "paid"


def _is_paid(row) -> bool:
    return (getattr(row, "pay_status", PAID) or PAID) != "unpaid"


def _split_paid(rows: list) -> tuple[list, list]:
    """按付款状态拆成 (已付款, 待付款)。"""
    paid = [r for r in rows if _is_paid(r)]
    unpaid = [r for r in rows if not _is_paid(r)]
    return paid, unpaid


def _pending_stats(inbounds: list, outbounds: list, others: list, finances: list) -> dict:
    """未计入本报表的待付款/待收款汇总（按来源单据算，避免自动流水重复计数）。"""
    payables = [i.total_amount or 0.0 for i in inbounds]                    # 入库（采购）
    payables += [e.amount or 0.0 for e in others]                           # 其他开支
    payables += [f.amount or 0.0 for f in finances if f.type == "expense" and f.ref_type == "manual"]
    receivables = [o.total_amount or 0.0 for o in outbounds]                 # 出库（销售）
    receivables += [f.amount or 0.0 for f in finances if f.type == "income" and f.ref_type == "manual"]
    return {
        "payables_count": len(payables),
        "payables_amount": round(sum(payables), 2),
        "receivables_count": len(receivables),
        "receivables_amount": round(sum(receivables), 2),
    }


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
        # 需遍历 o.lines 统计包材/人工/快递，务必 selectinload 一次预载，避免每单一条懒加载 SELECT（N+1）
        # 只统计「已付款」单据，与财务报表口径保持一致（待付款的先到「待付款账单」）
        outbounds = [
            o for o in db.execute(
                select(Outbound)
                .options(selectinload(Outbound.lines).selectinload(OutboundLine.product))
                .where(Outbound.date >= f, Outbound.date <= t)
            ).scalars()
            if _is_paid(o)
        ]
        finances = [
            x for x in db.execute(select(FinanceRecord).where(FinanceRecord.date >= f, FinanceRecord.date <= t)).scalars()
            if _is_paid(x)
        ]
        others = [
            x for x in db.execute(select(OtherExpense).where(OtherExpense.date >= f, OtherExpense.date <= t)).scalars()
            if _is_paid(x)
        ]
        revenue = sum(o.total_amount for o in outbounds)
        cogs = sum(o.total_cogs for o in outbounds)
        fee = sum(x.amount for x in finances if x.type == "expense" and x.category != "采购支出")
        other_fee = round(sum(e.amount or 0.0 for e in others), 2)
        fee = round(fee + other_fee, 2)  # 期间费用含「其他开支」（与报表口径一致）
        packs = _pack_cost_breakdown(outbounds)
        return {
            "revenue": round(revenue, 2),
            "gross": round(revenue - cogs, 2),
            "net": round(revenue - cogs - fee, 2),
            "orders": len(outbounds),
            "cogs": round(cogs, 2),
            "expense": fee,
            "other_expense": other_fee,
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

    # 后续遍历 o.lines / l.product，selectinload 一次预载避免 N+1（by_product 与包材拆分两处复用）
    # 「待付款」的单据不进报表：先拆出来，单独汇总给报表页提示（在「待付款账单」点「已支付」后转入报表）
    outbounds, unpaid_outbounds = _split_paid(
        list(db.execute(scope(Outbound).options(selectinload(Outbound.lines).selectinload(OutboundLine.product))).scalars())
    )
    # 采购明细要显示商品名，预载 product 避免逐条懒加载
    inbounds, unpaid_inbounds = _split_paid(
        list(db.execute(scope(Inbound).options(selectinload(Inbound.product))).scalars())
    )
    finances, unpaid_finances = _split_paid(list(db.execute(scope(FinanceRecord)).scalars()))
    others, unpaid_others = _split_paid(list(db.execute(scope(OtherExpense)).scalars()))

    revenue = sum(o.total_amount for o in outbounds)
    cogs = sum(o.total_cogs for o in outbounds)
    gross = round(revenue - cogs, 2)
    # 期间费用 = 财务流水里手工登记的支出（不含采购支出，采购已计入库存成本）+ 其他开支
    manual_expense = sum(f.amount for f in finances if f.type == "expense" and f.category != "采购支出")
    other_total = round(sum(e.amount or 0.0 for e in others), 2)
    expense = round(manual_expense + other_total, 2)
    purchase = sum(f.amount for f in finances if f.type == "expense" and f.category == "采购支出")
    purchase_db = sum(i.total_amount for i in inbounds)
    net = round(gross - expense, 2)
    stock_value = round(sum(p.stock_value for p in db.execute(select(Product)).scalars()), 2)

    # 商品维度：销售数量/收入/商品成本，并把出库时自动结算的关联成本（人工打包/包材/快递）
    # 归属到具体商品，得到该商品的「总成本 = 商品成本 + 打包人工+耗材 + 快递费」。
    #
    # 归属规则（按现有数据实测口径）：
    #   sale 行的 sale_product_id 恒为 NULL，pack 行的 sale_product_id 才指向它所服务的销售商品。
    #   1) pack 行带 sale_product_id → 直接归到该销售商品；
    #   2) 其余 pack 行（快递费按整单重量计费，无归属）→ 按该单各 sale 行的销售金额占比分摊；
    #      单内只有一条 sale 行时全部归它，与该单口径一致，不会丢账。
    by_product: dict = {}

    def _bucket(pid, name):
        return by_product.setdefault(
            pid,
            {
                "name": name,
                "qty": 0.0,
                "amount": 0.0,
                "gross_sales": 0.0,
                "cogs": 0.0,  # 兼容旧字段：仅商品本身的结算成本
                "goods_cogs": 0.0,  # 商品本身的先进先出结转成本
                "pack_cogs": 0.0,  # 打包人工费 + 包材耗材
                "express_cogs": 0.0,  # 快递运费
            },
        )

    for o in outbounds:
        sale_lines = [l for l in o.lines if l.line_type == "sale"]
        sale_pids = {l.product_id for l in sale_lines}
        # 本单待分摊的关联成本：{费用类别: 金额}
        unowned: dict[str, float] = {}
        for l in o.lines:
            if l.line_type != "pack":
                continue
            cat = _pack_cost_category(l.product, l)
            amount = l.cogs or 0.0
            field = "express_cogs" if cat == "快递运费" else "pack_cogs"
            # 仅当归属对象确实是本单的销售商品时才直接归属，避免历史脏数据把费用挂到
            # 不存在的商品上（并确保 _bucket 不会用「未归属」覆盖真实商品名）
            if l.sale_product_id and l.sale_product_id in sale_pids:
                _bucket(l.sale_product_id, "")[field] += amount
            else:
                unowned[field] = unowned.get(field, 0.0) + amount

        total_sale_amount = sum(l.amount or 0.0 for l in sale_lines)
        for l in sale_lines:
            d = _bucket(l.product_id, l.product.name if l.product else "")
            # 名称以销售行自身的商品为准（pack 行只累加金额，不参与命名）
            if l.product and l.product.name:
                d["name"] = l.product.name
            d["qty"] += l.quantity_base or 0.0
            d["amount"] += l.amount or 0.0
            d["gross_sales"] += l.gross_sales if l.gross_sales is not None else (l.amount or 0.0)
            d["goods_cogs"] += l.cogs or 0.0
            d["cogs"] += l.cogs or 0.0
            # 分摊无归属的关联成本（按销售金额占比；金额为 0 时平均分摊）
            if unowned:
                share = (l.amount or 0.0) / total_sale_amount if total_sale_amount else 1.0 / max(len(sale_lines), 1)
                for field, amt in unowned.items():
                    d[field] += amt * share

    product_rows = []
    for pid, d in sorted(by_product.items(), key=lambda kv: -kv[1]["amount"]):
        goods = round(d["goods_cogs"], 2)
        pack = round(d["pack_cogs"], 2)
        express = round(d["express_cogs"], 2)
        total_cogs = round(goods + pack + express, 2)
        amount = round(d["amount"], 2)
        gross_sales = round(d["gross_sales"], 2)
        gp = round(amount - total_cogs, 2)
        # 毛利率分母用扣点前销售金额（与出库批次页 gp_rate 口径一致）
        denom = gross_sales or amount
        product_rows.append(
            {
                "product_id": pid,
                "name": d["name"],
                "qty": round(d["qty"], 4),
                "amount": amount,
                "gross_sales": gross_sales,
                # cogs 语义升级为「总成本」，含商品成本 + 打包人工/耗材 + 快递费
                "cogs": total_cogs,
                "goods_cogs": goods,
                "pack_cogs": pack,
                "express_cogs": express,
                "total_cogs": total_cogs,
                "gross_profit": gp,
                "gp_rate": round(gp / denom * 100, 2) if denom else 0.0,
            }
        )

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

    # 其他开支（网线费/安装费/机器费/样品费…），按费用类型归集
    other_fees: dict[str, float] = {}
    for e in others:
        other_fees[e.category] = round(other_fees.get(e.category, 0.0) + (e.amount or 0.0), 2)

    # 逐日 / 逐月支出：三类合计——采购进货 + 其他开支 + 手工记账。
    # 注意口径：total 是"全部支出"（含采购），period_expense 才是从毛利中扣减的「期间费用」；
    # 采购已计入结转成本（COGS），不重复扣减，因此净利仍按期间费用计算。
    exp_day: dict[str, dict] = {}
    exp_month: dict[str, dict] = {}

    def _add_expense(bucket: dict, key: str, kind: str, amount: float) -> None:
        if not key:
            return
        b = bucket.setdefault(key, {"purchase": 0.0, "other": 0.0, "manual": 0.0, "count": 0})
        b[kind] += amount or 0.0
        b["count"] += 1

    for i in inbounds:  # 采购/进货（与顶部「本期进货」同源）
        _add_expense(exp_day, i.date, "purchase", i.total_amount)
        _add_expense(exp_month, (i.date or "")[:7], "purchase", i.total_amount)
    for e in others:
        _add_expense(exp_day, e.date, "other", e.amount)
        _add_expense(exp_month, (e.date or "")[:7], "other", e.amount)
    for f in finances:
        if f.type != "expense" or f.category == "采购支出":
            continue
        _add_expense(exp_day, f.date, "manual", f.amount)
        _add_expense(exp_month, (f.date or "")[:7], "manual", f.amount)

    def _expense_rows(bucket: dict, label: str) -> list[dict]:
        """按日期/月份倒序的支出明细：采购 / 其他开支 / 手工记账 / 合计 / 笔数。"""
        return [
            {
                label: k,
                "purchase": round(v["purchase"], 2),
                "other_expense": round(v["other"], 2),
                "manual_expense": round(v["manual"], 2),
                # 期间费用＝其他开支＋手工记账（真正从毛利中扣减的部分）
                "period_expense": round(v["other"] + v["manual"], 2),
                # 全部支出＝采购＋其他开支＋手工记账
                "total": round(v["purchase"] + v["other"] + v["manual"], 2),
                "count": v["count"],
            }
            for k, v in sorted(bucket.items(), reverse=True)
        ]

    # 逐笔支出明细：与「支出合计」完全同口径（采购进货 + 其他开支 + 手工记账），
    # 供报表「支出」分区逐条核对。「流水」分区只列财务流水，不含其他开支与采购，故这里单独拆出。
    def _fmt_qty(v: float) -> str:
        s = f"{float(v or 0):.4f}".rstrip("0").rstrip(".")
        return s or "0"

    def _inbound_label(i) -> str:
        name = i.product.name if i.product else ""
        if not name:
            return i.code or "入库"
        return f"{name} × {_fmt_qty(i.quantity)}{i.unit or ''}"

    expense_items: list[dict] = []
    for i in inbounds:
        expense_items.append({
            "date": i.date, "source": "采购", "category": "采购支出",
            "item": _inbound_label(i), "amount": round(i.total_amount or 0.0, 2),
            "operator": i.operator or "", "remark": i.supplier or i.remark or "",
            "ref": i.code or "", "auto": False,
        })
    for e in others:
        expense_items.append({
            "date": e.date, "source": "其他开支", "category": e.category,
            "item": e.category, "amount": round(e.amount or 0.0, 2),
            "operator": e.operator or "", "remark": e.remark or "",
            "ref": "", "auto": False,
        })
    for f in finances:
        if f.type != "expense" or f.category == "采购支出":
            continue
        expense_items.append({
            "date": f.date, "source": "手工记账", "category": f.category,
            "item": f.category, "amount": round(f.amount or 0.0, 2),
            "operator": f.operator or "", "remark": f.remark or "",
            "ref": "", "auto": f.ref_type not in ("", "manual"),
        })
    # 日期倒序；同一天保持「采购 → 其他开支 → 手工记账」顺序（稳定排序）
    expense_items.sort(key=lambda r: r["date"], reverse=True)

    return {
        "date_from": date_from,
        "date_to": date_to,
        # 以下金额一律只含「已付款」单据（待付款的在 pending 里，点「已支付」后自动转入）
        "pending": _pending_stats(unpaid_inbounds, unpaid_outbounds, unpaid_others, unpaid_finances),
        "revenue": round(revenue, 2),
        "cogs": round(cogs, 2),
        "goods_cogs": goods_cogs,
        "gross_profit": gross,
        # 期间费用 = 手工记账支出 + 其他开支，从毛利中扣减得到净利
        "expense": expense,
        "manual_expense": round(manual_expense, 2),
        "other_expense": other_total,
        "net_profit": net,
        "purchase": round(purchase_db, 2),
        # 全部支出 = 采购（进货）+ 其他开支 + 手工记账；仅用于"支出"展示口径
        "total_expense": round(purchase_db + expense, 2),
        "stock_value": stock_value,
        "order_count": len(outbounds),
        "inbound_count": len(inbounds),
        "by_product": product_rows,
        # 出库自动结算的关联成本明细（包材/人工/快递），已包含在 cogs 中
        "pack_costs": pack_costs,
        "pack_cost_total": pack_total,
        # 账外手工登记费用（不含采购支出），会额外从毛利中扣减得到净利
        "manual_fees": manual_fees,
        # 其他开支明细（按费用类型），同样计入期间费用
        "other_expenses": other_fees,
        # 逐日 / 逐月支出明细（采购 + 其他开支 + 手工记账）
        "expense_by_day": _expense_rows(exp_day, "date"),
        "expense_by_month": _expense_rows(exp_month, "month"),
        # 逐笔支出明细（同上口径，逐条列出：日期/来源/项目/金额/操作员/备注）
        "expense_items": expense_items,
        "fee_breakdown": {
            **pack_costs,
            **{k: v for k, v in manual_fees.items() if k not in pack_costs},
        },
    }


@router.get("/finance")
def list_finance(date_from: str = "", date_to: str = "", db: Session = Depends(get_db), user: User = Depends(get_current_user)):
    q = _date_filter(select(FinanceRecord), date_from, date_to).options(selectinload(FinanceRecord.product)).order_by(FinanceRecord.id.desc())
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
            "pay_status": getattr(f, "pay_status", PAID) or PAID,
            "paid_at": getattr(f, "paid_at", "") or "",
        }
        for f in db.execute(q).scalars()
    ]


@router.post("/finance")
def create_finance(data: FinanceIn, db: Session = Depends(get_db), user: User = Depends(get_current_user)):
    if data.type not in ("income", "expense"):
        raise HTTPException(400, "类型必须为 income 或 expense")
    if data.amount <= 0:
        raise HTTPException(400, "金额必须大于 0")
    pay = "unpaid" if (data.pay_status or "").strip() == "unpaid" else "paid"
    f = FinanceRecord(
        type=data.type,
        category=data.category.strip() or ("销售收入" if data.type == "income" else "其他支出"),
        amount=data.amount,
        date=data.date,
        operator=user.name,  # 操作员固定为当前登录账号（不接受前端指定）
        remark=data.remark.strip(),
        ref_type="manual",
        pay_status=pay,
        paid_at=data.date if pay == "paid" else "",
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
