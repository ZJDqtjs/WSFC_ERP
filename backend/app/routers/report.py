from fastapi import APIRouter, Depends, HTTPException
from pydantic import BaseModel
from sqlalchemy import and_, case, exists, func, or_, select
from sqlalchemy.orm import Session, aliased, selectinload

from ..auth import get_current_user
from ..brush import brush_adjust, brush_adjust_sql, brush_fee_of
from ..database import (
    current_warehouse_name,
    get_db,
    get_db_wh,
    get_sessionmaker,
    get_warehouses,
    resolve_key,
)
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


def _pack_cost_category_of(cat: str | None, name: str | None) -> str:
    """按「商品分类 + 名称」判断关联结算行属于哪类费用（人工打包费 / 包材耗材 / 快递运费）。

    与 SQL 聚合后的归类共用同一套口径：聚合查询只要分类名，不必把商品对象取出来。
    """
    c = (cat or "").strip()
    if c in PACK_COST_CATS:
        return PACK_COST_CATS[c]
    # 兜底：名称以「打包」结尾的按人工计（与 outbound._to_dict 的 is_labor 判定一致）
    if (name or "").strip().endswith("打包"):
        return "人工打包费"
    return "其他关联结算"


def _pack_cost_category(p: Product | None, line: OutboundLine) -> str:
    """判断一条关联结算行属于哪类费用（人工打包费 / 包材耗材 / 快递运费）。"""
    if not p:
        return "其他关联结算"
    return _pack_cost_category_of(p.category, p.name)


# 关联结算类别 → 「商品销售明细」逐行的成本字段。
# 人工与耗材分开记，明细里才能写成「打包人工 ¥x ＋ 耗材 ¥y ＋ 快递费 ¥z」。
PACK_FIELD_OF_CAT = {
    "人工打包费": "labor_cogs",
    "包材耗材": "material_cogs",
    "快递运费": "express_cogs",
    "其他关联结算": "other_cogs",
}

# 商品分类 → 成本字段（把上面两步合成一步，供 SQL 的 CASE 归类使用，口径与 _pack_cost_category_of 一致）
PACK_FIELD_OF_CATNAME = {cat: PACK_FIELD_OF_CAT[fee] for cat, fee in PACK_COST_CATS.items()}


def _pack_cost_breakdown(outbounds: list[Outbound]) -> dict[str, float]:
    """按费用类别汇总出库单的关联结算成本。

    这些成本已包含在 total_cogs 中（不是账外费用），此处仅做结构化拆分，
    让报表能看清「包材 / 人工 / 快递」各花了多少，不重复计入净利。

    注：报表接口现已改为 SQL 聚合（按「商品分类 + 名称」分组，见 _pack_cost_category_of），
    本函数保留给需要直接对单据对象汇总的场合。
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
        """区间汇总——全部走 SQL 聚合，不把单据与明细实例化成 ORM 对象。

        原来这里 selectinload 出区间内每张单、每条明细（单仓近 5000 单 / 2 万行，实测 0.9 秒，
        线上放大到 4 秒+）。其中只有「关联结算(pack)成本按类拆分」需要明细，
        改成按「商品分类 + 名称」分组聚合，几十行就能算完；付款状态过滤也一并下推。
        """
        paid_o = func.coalesce(Outbound.pay_status, PAID) != "unpaid"
        orders, revenue, cogs, brush = db.execute(
            select(func.count(),
                   func.coalesce(func.sum(Outbound.total_amount), 0),
                   func.coalesce(func.sum(Outbound.total_cogs), 0),
                   # 芳谊放单仓刷单结算：刷单成本 + 固定费覆盖差（非放单仓订单为 0）
                   func.coalesce(func.sum(brush_adjust_sql(Outbound)), 0))
            .where(Outbound.date >= f, Outbound.date <= t, paid_o)
        ).one()
        revenue, cogs, brush = float(revenue), float(cogs), round(float(brush), 2)

        # 期间费用 = 财务流水里手工登记的支出（不含采购支出，采购已计入库存成本）+ 其他开支
        manual_expense = float(db.execute(
            select(func.coalesce(func.sum(FinanceRecord.amount), 0))
            .where(FinanceRecord.date >= f, FinanceRecord.date <= t,
                   FinanceRecord.type == "expense", FinanceRecord.category != "采购支出",
                   func.coalesce(FinanceRecord.pay_status, PAID) != "unpaid")
        ).scalar() or 0.0)
        other_fee = round(float(db.execute(
            select(func.coalesce(func.sum(OtherExpense.amount), 0))
            .where(OtherExpense.date >= f, OtherExpense.date <= t,
                   func.coalesce(OtherExpense.pay_status, PAID) != "unpaid")
        ).scalar() or 0.0), 2)

        packs: dict[str, float] = {}
        for cat, name, amt in db.execute(
            select(Product.category, Product.name, func.coalesce(func.sum(OutboundLine.cogs), 0))
            .select_from(OutboundLine)
            .join(Outbound, Outbound.id == OutboundLine.outbound_id)
            .join(Product, Product.id == OutboundLine.product_id, isouter=True)
            .where(OutboundLine.line_type == "pack", Outbound.date >= f, Outbound.date <= t, paid_o)
            .group_by(Product.category, Product.name)
        ):
            key = _pack_cost_category_of(cat, name)
            packs[key] = round(packs.get(key, 0.0) + float(amt or 0.0), 2)

        fee = round(manual_expense + other_fee, 2)  # 期间费用含「其他开支」（与报表口径一致）
        return {
            "revenue": round(revenue, 2),
            # 毛利 = 收入 − 商品/关联成本 − 刷单结算（芳谊放单仓的刷单成本与固定费）
            "gross": round(revenue - cogs - brush, 2),
            "net": round(revenue - cogs - brush - fee, 2),
            "orders": int(orders),
            "cogs": round(cogs, 2),
            "brush_cost": brush,
            "expense": fee,
            "other_expense": other_fee,
            "pack_costs": packs,
            "pack_cost_total": round(sum(packs.values()), 2),
        }

    products = list(db.execute(select(Product)).scalars())
    # 人工/快递 无真实库存，不计入库存统计；已停用的商品不参与工作台统计（如缺货预警）
    NO_STOCK_CATS = ["人工", "快递"]
    stock_products = [
        p for p in products
        if p.product_type == "stock" and p.is_active and p.category not in NO_STOCK_CATS
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
        keys = list(groups.keys())
        stats: dict[str, tuple] = {}
        if keys:
            # 各批次的真实规模与合计：一条 group by 查完（原来每个批次两条 SQL，批次一多就是 N+1）
            for gk, cnt, amt, net in db.execute(
                select(
                    Outbound.import_group,
                    func.count(),
                    func.coalesce(func.sum(Outbound.total_amount), 0),
                    # 净利同样扣掉刷单结算（芳谊放单仓的刷单成本 + 固定费覆盖差）
                    func.coalesce(func.sum(
                        Outbound.total_amount - Outbound.total_cogs - Outbound.total_fee
                        - brush_adjust_sql(Outbound)
                    ), 0),
                ).where(Outbound.import_group.in_(keys)).group_by(Outbound.import_group)
            ):
                stats[gk] = (int(cnt), float(amt), float(net))
        for gk, g in groups.items():
            cnt, amt, net = stats.get(gk, (len(g), 0.0, 0.0))
            ls = g[:6]  # recent 已按 id 倒序，组内前几条即该批次最近的几单
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
                "amount": s.total_amount,
                "net": round(s.total_amount - s.total_cogs - s.total_fee - brush_adjust(s), 2),
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
def summary(
    date_from: str = "",
    date_to: str = "",
    wh: str = "",   # 可选：指定查看哪个分仓（单仓总览手动切换用），缺省=本登录会话的分仓；wh=all = 全仓合计
    exclude_other: int = 0,   # 1 = 排除「其他开支」，报表只看商品售卖利润（默认 0：含其他开支）
    db: Session = Depends(get_db_wh),
    user: User = Depends(get_current_user),
):
    """经营汇总：默认本登录会话的分仓；wh=all 时合并所有分仓（各自是独立账套）。"""
    if wh == ALL_WH:
        return _summary_all(date_from, date_to, bool(exclude_other))
    return _summary_of(db, date_from, date_to, resolve_key(wh), bool(exclude_other))


def _summary_of(db: Session, date_from: str, date_to: str, key: str, exclude_other: bool = False) -> dict:
    """单个分仓的经营汇总（「单仓总览」各分区的数据源）。

    exclude_other=True 时不计入「其他开支」（other_expenses 表）：期间费用只剩手工记账支出，
    净利润即「只看商品售卖」的利润；被排除的金额仍以 excluded_other_expense 返回，供前端提示。
    """
    def scope(model):
        q = select(model)
        if date_from:
            q = q.where(model.date >= date_from)
        if date_to:
            q = q.where(model.date <= date_to)
        return q

    # 出库单只取单据本身：明细（单仓 2 万行）改成下面的列查询 + 按单分组处理，
    # 不再把每张单的 lines/product 都实例化成 ORM 对象（这一步实测 0.9 秒，线上放大到 4 秒+）。
    # 「待付款」的单据不进报表：先拆出来，单独汇总给报表页提示（在「待付款账单」点「已支付」后转入报表）
    outbounds, unpaid_outbounds = _split_paid(list(db.execute(scope(Outbound)).scalars()))
    # 采购明细要显示商品名，预载 product 避免逐条懒加载
    inbounds, unpaid_inbounds = _split_paid(
        list(db.execute(scope(Inbound).options(selectinload(Inbound.product))).scalars())
    )
    finances, unpaid_finances = _split_paid(list(db.execute(scope(FinanceRecord)).scalars()))
    others, unpaid_others = _split_paid(list(db.execute(scope(OtherExpense)).scalars()))

    revenue = sum(o.total_amount for o in outbounds)
    cogs = sum(o.total_cogs for o in outbounds)
    # 芳谊放单仓刷单结算：刷单成本（我填的）+ 固定费覆盖差；非放单仓订单都是 0。
    # 注意 cogs 里**不**含这笔钱（cogs 仍是商品/包材/快递的结转成本），毛利单独扣它，
    # 这样「商品成本 goods_cogs」不会被刷单成本污染。
    brush_cost = round(sum(float(getattr(o, "brush_cost", 0.0) or 0.0) for o in outbounds), 2)
    brush_total = round(sum(brush_adjust(o) for o in outbounds), 2)
    gross = round(revenue - cogs - brush_total, 2)
    # 期间费用 = 财务流水里手工登记的支出（不含采购支出，采购已计入库存成本）+ 其他开支
    manual_expense = sum(f.amount for f in finances if f.type == "expense" and f.category != "采购支出")
    # 其他开支原始金额始终统计，便于前端提示「已排除多少」；口径关闭时不计入任何支出/净利计算
    other_raw = round(sum(e.amount or 0.0 for e in others), 2)
    others_in = [] if exclude_other else others
    other_total = 0.0 if exclude_other else other_raw
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

    def _bucket(pid, spec, dropship, name=""):
        """按「商品 + 规格 + 是否代发」分桶：出库明细里代发与库存商品不混在一起，也按规格区分。"""
        return by_product.setdefault(
            (pid, spec, dropship),
            {
                "product_id": pid,
                "spec": spec,
                "is_dropship": dropship,
                "name": name,
                "qty": 0.0,
                "amount": 0.0,
                "gross_sales": 0.0,
                "cogs": 0.0,  # 兼容旧字段：仅商品本身的结算成本
                "goods_cogs": 0.0,  # 商品本身的先进先出结转成本
                "pack_cogs": 0.0,  # 打包人工费 + 包材耗材（= 人工 + 耗材 + 其他，兼容旧字段）
                "labor_cogs": 0.0,  # 打包人工费
                "material_cogs": 0.0,  # 包材 / 耗材
                "other_cogs": 0.0,  # 其他关联结算
                "express_cogs": 0.0,  # 快递运费
                "brush_cogs": 0.0,  # 芳谊放单仓刷单结算（刷单成本 + 固定费覆盖差，按销售金额占比分摊到单内商品）
            },
        )

    # ---- 商品维度：交给 SQL 按「单 × 桶」聚合，Python 只做最后合并与分摊 ----
    # 明细动辄两万行，逐行在 Python 里跑是这里最大的开销（实测 0.7 秒，线上放大到几秒）。
    # 归属规则与原来完全一致：关联结算行优先归到本单对应销售商品的桶，
    # 无归属的（没填销售商品 / 指向的商品不在本单）按单内销售金额占比分摊到各桶。
    line_conds = []
    if date_from:
        line_conds.append(Outbound.date >= date_from)
    if date_to:
        line_conds.append(Outbound.date <= date_to)
    paid_out = func.coalesce(Outbound.pay_status, PAID) != "unpaid"
    spec_expr = func.trim(func.coalesce(OutboundLine.spec, ""))
    dr_expr = func.coalesce(OutboundLine.is_dropship, 0)
    pk = aliased(Product)
    # 关联结算行的费用类别（人工/包材/快递/其他）→ 成本字段；口径同 _pack_cost_category_of
    field_expr = case(
        *[(func.trim(func.coalesce(pk.category, "")) == c, f) for c, f in PACK_FIELD_OF_CATNAME.items()],
        (func.trim(func.coalesce(pk.name, "")).like("%打包"), "labor_cogs"),
        else_="other_cogs",
    )

    # ① 销售行：按「单 × 商品 × 规格 × 是否代发」聚合
    sale_rows = db.execute(
        select(
            OutboundLine.outbound_id.label("oid"),
            OutboundLine.product_id.label("pid"),
            spec_expr.label("spec"),
            dr_expr.label("dr"),
            func.count().label("n"),
            func.coalesce(func.sum(OutboundLine.quantity_base), 0).label("qb"),
            func.coalesce(func.sum(OutboundLine.amount), 0).label("amt"),
            func.coalesce(func.sum(func.coalesce(OutboundLine.gross_sales, OutboundLine.amount)), 0).label("gross"),
            func.coalesce(func.sum(OutboundLine.cogs), 0).label("goods"),
            func.max(Product.name).label("pname"),
        )
        .select_from(OutboundLine)
        .join(Outbound, Outbound.id == OutboundLine.outbound_id)
        .join(Product, Product.id == OutboundLine.product_id, isouter=True)
        .where(OutboundLine.line_type == "sale", *line_conds, paid_out)
        .group_by(OutboundLine.outbound_id, OutboundLine.product_id, spec_expr, dr_expr)
    ).all()

    # ② 有关联对象的结算行：归到「本单该销售商品所在的桶」
    #    同单同商品只会有一个规格（实测），所以用 MIN(id) 定位那一行即可，不会重复计数
    first_sale = (
        select(OutboundLine.outbound_id.label("oid"), OutboundLine.product_id.label("pid"),
               func.min(OutboundLine.id).label("sid"))
        .where(OutboundLine.line_type == "sale")
        .group_by(OutboundLine.outbound_id, OutboundLine.product_id)
        .subquery()
    )
    owner = aliased(OutboundLine)
    owned_rows = db.execute(
        select(
            owner.product_id.label("pid"),
            func.trim(func.coalesce(owner.spec, "")).label("spec"),
            func.coalesce(owner.is_dropship, 0).label("dr"),
            field_expr.label("field"),
            func.coalesce(func.sum(OutboundLine.cogs), 0).label("amt"),
        )
        .select_from(OutboundLine)
        .join(Outbound, Outbound.id == OutboundLine.outbound_id)
        .join(first_sale, and_(first_sale.c.oid == OutboundLine.outbound_id,
                               first_sale.c.pid == OutboundLine.sale_product_id))
        .join(owner, owner.id == first_sale.c.sid)
        .join(pk, pk.id == OutboundLine.product_id, isouter=True)
        .where(OutboundLine.line_type == "pack", *line_conds, paid_out)
        .group_by(owner.product_id, func.trim(func.coalesce(owner.spec, "")),
                  func.coalesce(owner.is_dropship, 0), field_expr)
    ).all()

    # ③ 无归属的结算成本：按「单 × 类别」聚合，稍后按销售金额占比分摊
    sl = aliased(OutboundLine)
    has_owner = (
        select(sl.id).where(
            sl.outbound_id == OutboundLine.outbound_id,
            sl.line_type == "sale",
            sl.product_id == OutboundLine.sale_product_id,
        ).exists()
    )
    unowned_rows = db.execute(
        select(
            OutboundLine.outbound_id.label("oid"),
            field_expr.label("field"),
            func.coalesce(func.sum(OutboundLine.cogs), 0).label("amt"),
        )
        .select_from(OutboundLine)
        .join(Outbound, Outbound.id == OutboundLine.outbound_id)
        .join(pk, pk.id == OutboundLine.product_id, isouter=True)
        .where(OutboundLine.line_type == "pack", *line_conds, paid_out,
               or_(OutboundLine.sale_product_id.is_(None), ~has_owner))
        .group_by(OutboundLine.outbound_id, field_expr)
    ).all()

    for r in sale_rows:
        d = _bucket(r.pid, r.spec, bool(r.dr), r.pname or "")
        if r.pname:  # 名称以销售行自身的商品为准（结算行只累加金额，不参与命名）
            d["name"] = r.pname
        d["qty"] += float(r.qb or 0.0)
        d["amount"] += float(r.amt or 0.0)
        d["gross_sales"] += float(r.gross or 0.0)
        d["goods_cogs"] += float(r.goods or 0.0)
        d["cogs"] += float(r.goods or 0.0)

    for r in owned_rows:
        d = _bucket(r.pid, r.spec, bool(r.dr), "")
        d[r.field] += float(r.amt or 0.0)

    # 分摊无归属的关联成本（按单内销售金额占比；金额为 0 时按销售行数平均）——
    # 与原来逐行分摊等价：同一桶内多行累加后即为「桶金额占比 × 无归属金额」
    per_order: dict[int, list] = {}
    for r in sale_rows:
        per_order.setdefault(r.oid, []).append(r)

    def _spread(oid, field: str, amt: float) -> None:
        """把一单上的整单金额按单内各销售行的销售金额占比分摊（金额为 0 时按行数平均）。"""
        rows_o = per_order.get(oid)
        if not rows_o or not amt:
            return
        tot_amt = sum(float(x.amt or 0.0) for x in rows_o)
        tot_n = sum(int(x.n or 0) for x in rows_o)
        for x in rows_o:
            share = (float(x.amt or 0.0) / tot_amt) if tot_amt else ((int(x.n or 0) / tot_n) if tot_n else 0.0)
            _bucket(x.pid, x.spec, bool(x.dr), "")[field] += float(amt or 0.0) * share

    for r in unowned_rows:
        _spread(r.oid, r.field, float(r.amt or 0.0))
    # 芳谊放单仓的刷单结算也按同一套算法归到该单的商品上，商品毛利才能扣掉它
    for o in outbounds:
        _spread(o.id, "brush_cogs", brush_adjust(o))

    product_rows = []
    for _key, d in sorted(by_product.items(), key=lambda kv: -kv[1]["amount"]):
        goods = round(d["goods_cogs"], 2)
        labor = round(d["labor_cogs"], 2)       # 打包人工费
        material = round(d["material_cogs"], 2)  # 包材 / 耗材
        other = round(d["other_cogs"], 2)        # 其他关联结算
        pack = round(labor + material + other, 2)  # 兼容旧字段「打包人工+耗材」
        express = round(d["express_cogs"], 2)
        brush = round(d["brush_cogs"], 2)  # 芳谊放单仓刷单结算（非放单仓商品为 0）
        total_cogs = round(goods + pack + express + brush, 2)
        amount = round(d["amount"], 2)
        gross_sales = round(d["gross_sales"], 2)
        gp = round(amount - total_cogs, 2)
        # 毛利率分母用扣点前销售金额（与出库批次页 gp_rate 口径一致）
        denom = gross_sales or amount
        product_rows.append(
            {
                "product_id": d["product_id"],
                # 规格 + 是否代发：前端据此把「代发」单独标出、并按规格区分
                "spec": d["spec"],
                "is_dropship": d["is_dropship"],
                "name": d["name"],
                "qty": round(d["qty"], 4),
                "amount": amount,
                "gross_sales": gross_sales,
                # cogs 语义升级为「总成本」，含商品成本 + 打包人工/耗材 + 快递费 + 刷单结算
                "cogs": total_cogs,
                "goods_cogs": goods,
                "pack_cogs": pack,
                "labor_cogs": labor,        # 打包人工费（从 pack_cogs 拆出）
                "material_cogs": material,  # 包材 / 耗材（从 pack_cogs 拆出）
                "other_cogs": other,        # 其他关联结算
                "express_cogs": express,
                "brush_cogs": brush,        # 芳谊放单仓刷单结算（刷单成本 + 固定费覆盖差）
                "total_cogs": total_cogs,
                "gross_profit": gp,
                "gp_rate": round(gp / denom * 100, 2) if denom else 0.0,
            }
        )

    # 关联结算成本拆分（包材/人工/快递）——已含在 cogs 内，单独列出供分析。
    # 按「商品分类 + 名称」分组聚合即可（与 _pack_cost_category_of 同口径），不必逐行累加。
    pack_costs: dict[str, float] = {}
    for pcat, pname, amt in db.execute(
        select(Product.category, Product.name, func.coalesce(func.sum(OutboundLine.cogs), 0))
        .select_from(OutboundLine).join(Outbound, Outbound.id == OutboundLine.outbound_id)
        .join(Product, Product.id == OutboundLine.product_id, isouter=True)
        .where(OutboundLine.line_type == "pack", *line_conds,
               func.coalesce(Outbound.pay_status, PAID) != "unpaid")
        .group_by(Product.category, Product.name)
    ):
        cat_key = _pack_cost_category_of(pcat, pname)   # 注意别用 key：那是分仓标识参数
        pack_costs[cat_key] = round(pack_costs.get(cat_key, 0.0) + float(amt or 0.0), 2)
    pack_total = round(sum(pack_costs.values()), 2)
    # 商品本身成本 = 总成本 - 关联结算成本
    goods_cogs = round(cogs - pack_total, 2)

    # 账外费用（finance_records 中登记的手工支出），按类别归集
    manual_fees: dict[str, float] = {}
    for f in finances:
        if f.type != "expense" or f.category == "采购支出":
            continue
        manual_fees[f.category] = round(manual_fees.get(f.category, 0.0) + f.amount, 2)

    # 其他开支（网线费/安装费/机器费/样品费…），按费用类型归集（口径关闭时为空）
    other_fees: dict[str, float] = {}
    for e in others_in:
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
    for e in others_in:
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
    for e in others_in:
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
        # 本报表是哪个分仓的（单仓总览可切换分仓查看）
        "warehouse": {"key": key, "name": current_warehouse_name(key)},
        "is_current": key == resolve_key(""),
        # 以下金额一律只含「已付款」单据（待付款的在 pending 里，点「已支付」后自动转入）
        "pending": _pending_stats(unpaid_inbounds, unpaid_outbounds, unpaid_others, unpaid_finances),
        "revenue": round(revenue, 2),
        "cogs": round(cogs, 2),
        "goods_cogs": goods_cogs,
        # 刷单结算（芳谊放单仓）：刷单成本 + 固定费覆盖差，已从下面的毛利/净利里扣掉
        "brush_cost": brush_total,
        "brush_input_cost": brush_cost,   # 其中「我填的刷单成本」原值合计（展示用）
        "gross_profit": gross,
        # 期间费用 = 手工记账支出 + 其他开支，从毛利中扣减得到净利
        "expense": expense,
        "manual_expense": round(manual_expense, 2),
        "other_expense": other_total,
        # 报表口径开关：exclude_other_expense=True = 已排除其他开支（只看商品售卖利润）
        "exclude_other_expense": bool(exclude_other),
        "excluded_other_expense": other_raw,   # 被排除掉的其他开支金额（仅供提示）
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


# 「全仓合计」：每个分仓是独立账套（独立 db 文件），所以逐个分仓算完再合并。
# 报表页「全仓总览」下的 汇总/支出/商品/流水 四个分区都用这里的合并结果，口径与单仓一致。
ALL_WH = "all"


def _each_warehouse(fn):
    """逐个分仓执行 fn(db, key, name)，返回 (结果列表, 失败列表)。

    某个仓读不出来只记一条失败信息，不影响其它仓（例如刚建仓、文件缺失）。
    """
    parts: list = []
    failed: list = []
    for w in get_warehouses():
        key, name = w["key"], w.get("name", w["key"])
        db = None
        try:
            db = get_sessionmaker(key)()
            parts.append(fn(db, key, name))
        except Exception as e:  # 单个仓失败不拖累整体
            failed.append({"key": key, "name": name, "error": f"读取失败：{e}"})
            print(f"[全仓合计] {key} 读取失败:", e)
        finally:
            if db is not None:
                db.close()
    return parts, failed


def _summary_all(date_from: str, date_to: str, exclude_other: bool = False) -> dict:
    parts, failed = _each_warehouse(
        lambda db, key, name: _summary_of(db, date_from, date_to, key, exclude_other)
    )
    return _merge_summaries(parts, date_from, date_to, failed)


def _merge_summaries(parts: list[dict], date_from: str, date_to: str, failed: list[dict]) -> dict:
    """把各分仓的 _summary_of 结果合并成「全仓合计」。

    金额/笔数直接相加；商品、按日按月支出、逐笔明细按业务主键归并后重算比率/合计。
    各分仓已经按 exclude_other_expense 口径算好，这里只做相加与标记透传。
    """
    def s(field: str) -> float:
        return round(sum(float(p.get(field) or 0) for p in parts), 2)

    def i(field: str) -> int:
        return int(sum(int(p.get(field) or 0) for p in parts))

    def merge_maps(field: str) -> dict:
        out: dict[str, float] = {}
        for p in parts:
            for k, v in (p.get(field) or {}).items():
                out[k] = round(out.get(k, 0.0) + float(v or 0), 2)
        return out

    def pend(field: str) -> float:
        return round(sum(float((p.get("pending") or {}).get(field) or 0) for p in parts), 2)

    # ---- 商品：按「商品 + 规格 + 是否代发」归并，再用合并后的成本重算毛利/毛利率 ----
    num_fields = ("qty", "amount", "gross_sales", "goods_cogs", "pack_cogs",
                  "labor_cogs", "material_cogs", "other_cogs", "express_cogs", "brush_cogs")
    buckets: dict[tuple, dict] = {}
    for p in parts:
        for r in p.get("by_product") or []:
            k = (r.get("name") or "", r.get("spec") or "", bool(r.get("is_dropship")))
            d = buckets.get(k)
            if d is None:
                d = {**r}
                for f in num_fields:
                    d[f] = 0.0
                buckets[k] = d
            for f in num_fields:
                d[f] = float(d.get(f) or 0) + float(r.get(f) or 0)
    product_rows: list[dict] = []
    for d in buckets.values():
        goods = round(d["goods_cogs"], 2)
        pack = round(d["pack_cogs"], 2)
        express = round(d["express_cogs"], 2)
        brush = round(d["brush_cogs"], 2)   # 芳谊放单仓刷单结算（与单仓口径一致）
        total_cogs = round(goods + pack + express + brush, 2)
        amount = round(d["amount"], 2)
        gross_sales = round(d["gross_sales"], 2)
        gp = round(amount - total_cogs, 2)
        denom = gross_sales or amount
        product_rows.append({
            **d,
            "qty": round(d["qty"], 4),
            "amount": amount,
            "gross_sales": gross_sales,
            # cogs 语义与单仓一致：总成本 = 商品成本 + 打包人工/耗材 + 快递费
            "cogs": total_cogs,
            "total_cogs": total_cogs,
            "gross_profit": gp,
            "gp_rate": round(gp / denom * 100, 2) if denom else 0.0,
        })
    product_rows.sort(key=lambda x: -x["amount"])

    # ---- 支出：按日 / 按月归并（采购 + 其他开支 + 手工记账）----
    def merge_expense_rows(field: str, label: str) -> list[dict]:
        acc: dict[str, dict] = {}
        for p in parts:
            for r in p.get(field) or []:
                k = r.get(label) or ""
                if not k:
                    continue
                b = acc.setdefault(k, {"purchase": 0.0, "other": 0.0, "manual": 0.0, "count": 0})
                b["purchase"] += float(r.get("purchase") or 0)
                b["other"] += float(r.get("other_expense") or 0)
                b["manual"] += float(r.get("manual_expense") or 0)
                b["count"] += int(r.get("count") or 0)
        return [
            {
                label: k,
                "purchase": round(v["purchase"], 2),
                "other_expense": round(v["other"], 2),
                "manual_expense": round(v["manual"], 2),
                "period_expense": round(v["other"] + v["manual"], 2),
                "total": round(v["purchase"] + v["other"] + v["manual"], 2),
                "count": v["count"],
            }
            for k, v in sorted(acc.items(), reverse=True)
        ]

    # ---- 逐笔支出明细：拼接并补上来源分仓，按日期倒序 ----
    expense_items: list[dict] = []
    for p in parts:
        wname = (p.get("warehouse") or {}).get("name", "")
        for r in p.get("expense_items") or []:
            expense_items.append({**r, "warehouse": wname})
    expense_items.sort(key=lambda r: r.get("date") or "", reverse=True)

    pack_costs = merge_maps("pack_costs")
    manual_fees = merge_maps("manual_fees")
    return {
        "date_from": date_from,
        "date_to": date_to,
        "warehouse": {"key": ALL_WH, "name": "全仓合计"},
        "is_current": False,
        # 前端据此给流水/支出明细加「分仓」列、给统计卡加「全仓」前缀
        "is_all": True,
        "warehouse_count": len(parts),
        "failed": failed,
        "pending": {
            "payables_count": int(pend("payables_count")),
            "payables_amount": pend("payables_amount"),
            "receivables_count": int(pend("receivables_count")),
            "receivables_amount": pend("receivables_amount"),
        },
        "revenue": s("revenue"),
        "cogs": s("cogs"),
        "goods_cogs": s("goods_cogs"),
        # 刷单结算（芳谊放单仓）合计：各分仓已按同口径扣减，这里只相加
        "brush_cost": s("brush_cost"),
        "brush_input_cost": s("brush_input_cost"),
        "gross_profit": s("gross_profit"),
        "expense": s("expense"),
        "manual_expense": s("manual_expense"),
        "other_expense": s("other_expense"),
        # 全仓口径开关：任一分仓标记为「排除其他开支」即视为同一口径
        "exclude_other_expense": any(bool(p.get("exclude_other_expense")) for p in parts),
        "excluded_other_expense": s("excluded_other_expense"),
        "net_profit": s("net_profit"),
        "purchase": s("purchase"),
        "total_expense": s("total_expense"),
        "stock_value": s("stock_value"),
        "order_count": i("order_count"),
        "inbound_count": i("inbound_count"),
        "by_product": product_rows,
        "pack_costs": pack_costs,
        "pack_cost_total": round(sum(pack_costs.values()), 2),
        "manual_fees": manual_fees,
        "other_expenses": merge_maps("other_expenses"),
        "expense_by_day": merge_expense_rows("expense_by_day", "date"),
        "expense_by_month": merge_expense_rows("expense_by_month", "month"),
        "expense_items": expense_items,
        "fee_breakdown": {**pack_costs, **{k: v for k, v in manual_fees.items() if k not in pack_costs}},
    }


@router.get("/report/sales-by-spec")
def sales_by_spec(
    date_from: str = "",
    date_to: str = "",
    wh: str = "",
    db: Session = Depends(get_db_wh),
    user: User = Depends(get_current_user),
):
    """出库明细（按天 × 规格）：每天每种规格卖了多少单 / 多少数量 / 多少金额，并单独给出代发数量与代发成本。

    口径与财务不同：这里**不区分是否已收款**（只看实际发出的货），
    「代发」行（订单商品未关联库存大类，本仓不出货）也一并列出，方便统计代发量。

    wh=all 时把所有分仓的明细按「日期 × 规格」合并成全仓合计。
    """
    if wh == ALL_WH:
        return _sales_by_spec_all(date_from, date_to)
    return _sales_by_spec_of(db, date_from, date_to, resolve_key(wh))


def _sales_by_spec_of(db: Session, date_from: str, date_to: str, key: str) -> dict:
    """按「日期 × 规格」汇总出库明细（全部在 SQL 里分组求和）。

    以前把区间内每张出库单连同明细 selectinload 出来、在 Python 里逐行累加
    （单仓近 5000 单 / 2 万行，实测 5 秒+），但这些其实都是「分组求和」：
    订单数 = COUNT(DISTINCT 单号)，代发量/成本 = 条件求和，单位取组内出现最多的那个。
    """
    conds = []
    if date_from:
        conds.append(Outbound.date >= date_from)
    if date_to:
        conds.append(Outbound.date <= date_to)
    sale_conds = [*conds, OutboundLine.line_type == "sale"]
    spec_col = func.coalesce(func.nullif(func.trim(OutboundLine.spec), ""), "未标规格")
    dropship = OutboundLine.is_dropship == True  # noqa: E712 - 生成 SQL 的 = 1，NULL 不匹配

    def _sums():
        """销售行的分组聚合（日期×规格、规格两个粒度共用）。"""
        return (
            func.count(func.distinct(Outbound.id)),
            func.coalesce(func.sum(OutboundLine.quantity), 0.0),
            func.coalesce(func.sum(OutboundLine.amount), 0.0),
            func.coalesce(func.sum(case((dropship, OutboundLine.quantity), else_=0.0)), 0.0),
            func.coalesce(func.sum(case((dropship, OutboundLine.cogs), else_=0.0)), 0.0),
        )

    # 每天的总单数：含没有销售行的单（与原实现一致，days 也会包含这些日期）
    day_orders = dict(db.execute(
        select(Outbound.date, func.count()).where(*conds).group_by(Outbound.date)
    ).all())
    days: dict[str, dict] = {d: {"date": d, "cells": {}} for d in day_orders}

    for date, spec, cnt, qty, amount, dq, dc in db.execute(
        select(Outbound.date, spec_col, *_sums())
        .select_from(OutboundLine).join(Outbound, Outbound.id == OutboundLine.outbound_id)
        .where(*sale_conds).group_by(Outbound.date, spec_col)
    ):
        days[date]["cells"][spec] = {"orders": int(cnt), "qty": float(qty), "amount": float(amount),
                                     "dropship_qty": float(dq), "dropship_cogs": float(dc), "units": {}}

    specs: dict[str, dict] = {}
    for spec, cnt, qty, amount, dq, dc, ndays in db.execute(
        select(spec_col, *_sums(), func.count(func.distinct(Outbound.date)))
        .select_from(OutboundLine).join(Outbound, Outbound.id == OutboundLine.outbound_id)
        .where(*sale_conds).group_by(spec_col)
    ):
        specs[spec] = {"name": spec, "orders": int(cnt), "days": int(ndays), "qty": float(qty),
                       "amount": float(amount), "dropship_qty": float(dq), "dropship_cogs": float(dc),
                       "units": {}}

    # 单位取组内出现次数最多的（按计数倒序、单位名升序，结果稳定可复现）
    for date, spec, unit, cnt in db.execute(
        select(Outbound.date, spec_col, OutboundLine.unit, func.count())
        .select_from(OutboundLine).join(Outbound, Outbound.id == OutboundLine.outbound_id)
        .where(*sale_conds).group_by(Outbound.date, spec_col, OutboundLine.unit)
        .order_by(func.count().desc(), OutboundLine.unit)
    ):
        cell = (days.get(date) or {}).get("cells", {}).get(spec)
        if cell is not None and not cell["units"]:
            cell["units"][unit or ""] = int(cnt)
        s = specs.get(spec)
        if s is not None and not s["units"]:
            s["units"][unit or ""] = int(cnt)

    def _unit(units: dict) -> str:
        return max(units, key=units.get) if units else ""

    out_rows = []
    for date in sorted(days, reverse=True):
        cells = days[date]["cells"]
        out_rows.append({
            "date": date,
            "orders": int(day_orders.get(date, 0)),
            "qty": round(sum(c["qty"] for c in cells.values()), 2),
            "amount": round(sum(c["amount"] for c in cells.values()), 2),
            "dropship_qty": round(sum(c["dropship_qty"] for c in cells.values()), 2),
            "dropship_cogs": round(sum(c["dropship_cogs"] for c in cells.values()), 2),
            "cells": {
                name: {
                    "orders": c["orders"], "qty": round(c["qty"], 2), "unit": _unit(c["units"]),
                    "amount": round(c["amount"], 2),
                    "dropship_qty": round(c["dropship_qty"], 2),
                    "dropship_cogs": round(c["dropship_cogs"], 2),
                }
                for name, c in cells.items()
            },
        })

    spec_cols = sorted(specs.values(), key=lambda x: (-x["orders"], -x["qty"]))
    return {
        "date_from": date_from,
        "date_to": date_to,
        "warehouse": {"key": key, "name": current_warehouse_name(key)},
        "specs": [
            {
                "name": s["name"], "orders": s["orders"], "days": s["days"],
                "qty": round(s["qty"], 2), "unit": _unit(s["units"]), "amount": round(s["amount"], 2),
                "dropship_qty": round(s["dropship_qty"], 2), "dropship_cogs": round(s["dropship_cogs"], 2),
            }
            for s in spec_cols
        ],
        "rows": out_rows,
        "totals": {
            "orders": sum(int(v) for v in day_orders.values()),
            "days": len(days),
            "spec_count": len(specs),
            "qty": round(sum(x["qty"] for x in out_rows), 2),
            "amount": round(sum(x["amount"] for x in out_rows), 2),
            "dropship_qty": round(sum(x["dropship_qty"] for x in out_rows), 2),
            "dropship_cogs": round(sum(x["dropship_cogs"] for x in out_rows), 2),
        },
    }


def _sales_by_spec_all(date_from: str, date_to: str) -> dict:
    """全仓合计的出库明细：把各分仓的「日期 × 规格」结果按同一天/同一规格累加。"""
    parts, failed = _each_warehouse(lambda db, key, name: _sales_by_spec_of(db, date_from, date_to, key))

    def _fresh():
        return {"orders": 0, "qty": 0.0, "amount": 0.0, "unit": "", "dropship_qty": 0.0, "dropship_cogs": 0.0}

    days: dict[str, dict] = {}
    totals = {"orders": 0, "qty": 0.0, "amount": 0.0, "dropship_qty": 0.0, "dropship_cogs": 0.0}
    for p in parts:
        t = p.get("totals") or {}
        totals["orders"] += int(t.get("orders") or 0)
        for f in ("qty", "amount", "dropship_qty", "dropship_cogs"):
            totals[f] += float(t.get(f) or 0)
        for r in p.get("rows") or []:
            d = days.setdefault(r.get("date") or "", {"date": r.get("date") or "", "orders": 0, "cells": {}})
            d["orders"] += int(r.get("orders") or 0)
            for name, c in (r.get("cells") or {}).items():
                cell = d["cells"].setdefault(name, _fresh())
                cell["orders"] += int(c.get("orders") or 0)
                for f in ("qty", "amount", "dropship_qty", "dropship_cogs"):
                    cell[f] += float(c.get(f) or 0)
                if not cell["unit"] and c.get("unit"):
                    cell["unit"] = c["unit"]

    spec_acc: dict[str, dict] = {}
    rows: list[dict] = []
    for date in sorted(days, reverse=True):
        d = days[date]
        for name, c in d["cells"].items():
            acc = spec_acc.setdefault(name, {**_fresh(), "name": name, "days": set()})
            acc["orders"] += c["orders"]
            for f in ("qty", "amount", "dropship_qty", "dropship_cogs"):
                acc[f] += c[f]
            if not acc["unit"] and c["unit"]:
                acc["unit"] = c["unit"]
            acc["days"].add(date)
        rows.append({
            "date": date,
            "orders": d["orders"],
            "qty": round(sum(c["qty"] for c in d["cells"].values()), 2),
            "amount": round(sum(c["amount"] for c in d["cells"].values()), 2),
            "dropship_qty": round(sum(c["dropship_qty"] for c in d["cells"].values()), 2),
            "dropship_cogs": round(sum(c["dropship_cogs"] for c in d["cells"].values()), 2),
            "cells": {
                n: {
                    "orders": c["orders"], "qty": round(c["qty"], 2), "unit": c["unit"],
                    "amount": round(c["amount"], 2),
                    "dropship_qty": round(c["dropship_qty"], 2),
                    "dropship_cogs": round(c["dropship_cogs"], 2),
                }
                for n, c in d["cells"].items()
            },
        })

    spec_cols = sorted(spec_acc.values(), key=lambda x: (-len(x["days"]), -x["qty"]))
    return {
        "date_from": date_from,
        "date_to": date_to,
        "warehouse": {"key": ALL_WH, "name": "全仓合计"},
        "is_all": True,
        "warehouse_count": len(parts),
        "failed": failed,
        "specs": [
            {
                "name": x["name"], "orders": x["orders"], "days": len(x["days"]),
                "qty": round(x["qty"], 2), "unit": x["unit"], "amount": round(x["amount"], 2),
                "dropship_qty": round(x["dropship_qty"], 2), "dropship_cogs": round(x["dropship_cogs"], 2),
            }
            for x in spec_cols
        ],
        "rows": rows,
        "totals": {
            "orders": totals["orders"],
            "days": len(days),
            "spec_count": len(spec_cols),
            "qty": round(totals["qty"], 2),
            "amount": round(totals["amount"], 2),
            "dropship_qty": round(totals["dropship_qty"], 2),
            "dropship_cogs": round(totals["dropship_cogs"], 2),
        },
    }


def _overview_of(db: Session, key: str, name: str, date_from: str, date_to: str, exclude_other: bool = False) -> dict:
    """单个分仓的「收入 / 支出 / 利润」总览（口径与 /report/summary 完全一致：只含已付款单据）。

    exclude_other=True 时不计入其他开支（只看商品售卖利润）。

    全部走 SQL 聚合：全仓总览要为每个分仓各算一遍，以前每仓都把区间内所有单据
    （出库/入库/流水/开支）实例化成 ORM 对象再在 Python 里求和，几秒钟就是这么攒出来的。
    """
    def _date_conds(model):
        c = []
        if date_from:
            c.append(model.date >= date_from)
        if date_to:
            c.append(model.date <= date_to)
        return c

    def paid(model):
        return func.coalesce(model.pay_status, PAID) != "unpaid"

    def unpaid(model):
        return func.coalesce(model.pay_status, PAID) == "unpaid"

    def unpaid_count_sum(model, col, extra=()):
        """未付款单据的 (条数, 金额合计)。"""
        cnt, amt = db.execute(
            select(func.count(), func.coalesce(func.sum(col), 0))
            .where(*_date_conds(model), unpaid(model), *extra)
        ).one()
        return int(cnt), float(amt or 0)

    orders, revenue, cogs, brush = db.execute(
        select(func.count(), func.coalesce(func.sum(Outbound.total_amount), 0),
               func.coalesce(func.sum(Outbound.total_cogs), 0),
               # 芳谊放单仓刷单结算（刷单成本 + 固定费覆盖差），与 /report/summary 同口径
               func.coalesce(func.sum(brush_adjust_sql(Outbound)), 0))
        .where(*_date_conds(Outbound), paid(Outbound))
    ).one()
    revenue, cogs, brush = float(revenue), float(cogs), round(float(brush), 2)

    manual_expense = float(db.execute(
        select(func.coalesce(func.sum(FinanceRecord.amount), 0))
        .where(*_date_conds(FinanceRecord), paid(FinanceRecord),
               FinanceRecord.type == "expense", FinanceRecord.category != "采购支出")
    ).scalar() or 0.0)
    other_raw = round(float(db.execute(
        select(func.coalesce(func.sum(OtherExpense.amount), 0))
        .where(*_date_conds(OtherExpense), paid(OtherExpense))
    ).scalar() or 0.0), 2)
    inb_cnt, purchase = db.execute(
        select(func.count(), func.coalesce(func.sum(Inbound.total_amount), 0))
        .where(*_date_conds(Inbound), paid(Inbound))
    ).one()
    purchase = float(purchase)
    stock_value = round(float(db.execute(
        select(func.coalesce(func.sum(Product.stock_value), 0))
    ).scalar() or 0.0), 2)

    other_expense = 0.0 if exclude_other else other_raw
    expense = round(manual_expense + other_expense, 2)

    # 待付款/待收款：与 _pending_stats 同口径（按来源单据算，避免自动流水重复计）
    ib_c, ib_a = unpaid_count_sum(Inbound, Inbound.total_amount)
    oe_c, oe_a = unpaid_count_sum(OtherExpense, OtherExpense.amount)
    fi_out_c, fi_out_a = unpaid_count_sum(FinanceRecord, FinanceRecord.amount,
                                          (FinanceRecord.type == "expense", FinanceRecord.ref_type == "manual"))
    ob_c, ob_a = unpaid_count_sum(Outbound, Outbound.total_amount)
    fi_in_c, fi_in_a = unpaid_count_sum(FinanceRecord, FinanceRecord.amount,
                                        (FinanceRecord.type == "income", FinanceRecord.ref_type == "manual"))

    return {
        "key": key,
        "name": name,
        "revenue": round(revenue, 2),
        "cogs": round(cogs, 2),
        "brush_cost": brush,
        "gross": round(revenue - cogs - brush, 2),
        "expense": expense,
        "other_expense": other_expense,
        "manual_expense": round(manual_expense, 2),
        "exclude_other_expense": bool(exclude_other),
        "excluded_other_expense": other_raw,
        "purchase": round(purchase, 2),
        "total_expense": round(purchase + expense, 2),
        "net_profit": round(revenue - cogs - brush - expense, 2),
        "orders": int(orders),
        "inbounds": int(inb_cnt),
        "stock_value": stock_value,
        "pending": {
            "payables_count": ib_c + oe_c + fi_out_c,
            "payables_amount": round(ib_a + oe_a + fi_out_a, 2),
            "receivables_count": ob_c + fi_in_c,
            "receivables_amount": round(ob_a + fi_in_a, 2),
        },
    }


@router.get("/report/all-warehouses")
def all_warehouses(
    date_from: str = "",
    date_to: str = "",
    exclude_other: int = 0,   # 1 = 排除「其他开支」（与 /report/summary 同口径）
    user: User = Depends(get_current_user),
):
    """全仓总览：把所有分仓的收入 / 支出 / 利润汇总成一张表 + 合计。

    每个分仓是**独立账套**（独立 db 文件），因此逐个分仓查询后累加；某个仓读不出来只标记该行，
    不影响其他仓（例如刚建仓、文件缺失）。
    """
    items: list[dict] = []
    for w in get_warehouses():
        key, name = w["key"], w.get("name", w["key"])
        db = None
        try:
            db = get_sessionmaker(key)()
            items.append(_overview_of(db, key, name, date_from, date_to, bool(exclude_other)))
        except Exception as e:  # 单个仓失败不拖累整体
            print(f"[全仓总览] {key} 读取失败:", e)
            items.append({"key": key, "name": name, "error": f"读取失败：{e}"})
        finally:
            if db is not None:
                db.close()

    ok = [x for x in items if "error" not in x]

    def s(field: str) -> float:
        return round(sum(float(x.get(field) or 0) for x in ok), 2)

    def p(field: str) -> float:
        return round(sum(float((x.get("pending") or {}).get(field) or 0) for x in ok), 2)

    total = {
        "revenue": s("revenue"),
        "cogs": s("cogs"),
        # 刷单结算（芳谊放单仓）：各分仓已扣减，这里只相加
        "brush_cost": s("brush_cost"),
        "gross": s("gross"),
        "expense": s("expense"),
        "other_expense": s("other_expense"),
        "manual_expense": s("manual_expense"),
        "excluded_other_expense": s("excluded_other_expense"),
        "purchase": s("purchase"),
        "total_expense": s("total_expense"),
        "net_profit": s("net_profit"),
        "orders": int(sum(int(x.get("orders") or 0) for x in ok)),
        "inbounds": int(sum(int(x.get("inbounds") or 0) for x in ok)),
        "stock_value": s("stock_value"),
        "warehouse_count": len(ok),
        "pending": {
            "payables_count": int(p("payables_count")),
            "payables_amount": p("payables_amount"),
            "receivables_count": int(p("receivables_count")),
            "receivables_amount": p("receivables_amount"),
        },
    }
    return {
        "date_from": date_from,
        "date_to": date_to,
        "exclude_other_expense": bool(exclude_other),
        "current": resolve_key(""),   # 本登录会话所在分仓（前端默认选中）
        "items": items,
        "total": total,
    }


@router.get("/finance")
def list_finance(
    date_from: str = "",
    date_to: str = "",
    wh: str = "",   # 可选：查看指定分仓（与 /report/summary 的 wh 保持一致）；wh=all = 全仓流水
    db: Session = Depends(get_db_wh),
    user: User = Depends(get_current_user),
):
    if wh == ALL_WH:
        return _finance_all(date_from, date_to)
    return _finance_of(db, date_from, date_to)


def _finance_of(db: Session, date_from: str, date_to: str, wh_name: str = "") -> list[dict]:
    """财务流水列表。

    商品名用 join 直接取列，不再 selectinload 出整棵对象树——流水动辄几千条，
    每条只用一个商品名，没必要把 FinanceRecord/Product 都实例化成 ORM 对象。
    """
    q = select(
        FinanceRecord.id, FinanceRecord.type, FinanceRecord.category, FinanceRecord.product_id,
        Product.name, FinanceRecord.amount, FinanceRecord.date, FinanceRecord.operator,
        FinanceRecord.remark, FinanceRecord.ref_type, FinanceRecord.ref_id,
        FinanceRecord.pay_status, FinanceRecord.paid_at,
    ).outerjoin(Product, Product.id == FinanceRecord.product_id)
    q = _date_filter(q, date_from, date_to).order_by(FinanceRecord.id.desc())
    return [
        {
            "id": fid,
            "type": ftype,
            "category": fcat,
            "product_id": fpid,
            "product_name": pname or "",
            "amount": famount,
            "date": fdate,
            "operator": fop or "",
            "remark": frm or "",
            "ref_type": fref or "",
            "ref_id": frefid,
            "pay_status": fpay or PAID,
            "paid_at": fpaid or "",
            # 全仓流水需要区分来源分仓（单仓模式下为空，前端不显示该列）
            **({"warehouse": wh_name} if wh_name else {}),
        }
        for fid, ftype, fcat, fpid, pname, famount, fdate, fop, frm, fref, frefid, fpay, fpaid
        in db.execute(q)
    ]


def _finance_all(date_from: str, date_to: str) -> list[dict]:
    """全仓财务流水：拼接各分仓记录（带来源分仓名），按日期倒序。"""
    parts, _failed = _each_warehouse(lambda db, key, name: _finance_of(db, date_from, date_to, name))
    rows = [r for part in parts for r in part]
    rows.sort(key=lambda r: (r.get("date") or "", int(r.get("id") or 0)), reverse=True)
    return rows


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
