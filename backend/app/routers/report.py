import threading
import time

from fastapi import APIRouter, Depends, HTTPException
from pydantic import BaseModel
from sqlalchemy import and_, case, exists, func, literal, or_, select
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
from ..models import (
    FinanceRecord,
    Inbound,
    OtherExpense,
    Outbound,
    OutboundLine,
    Product,
    StockMovement,
    User,
    WarehouseIn,
    WarehouseProduct,
)
from .warehouse_in import net_weight_kg
from ..services import INBOUND_FEE_REF

router = APIRouter(prefix="/api", tags=["report"])


# ---------------- 重汇总的并发闸 + 短缓存 ----------------
# 背景：/report/summary（尤其 wh=all）、/report/all-warehouses、/finance?wh=all 都会逐仓跑重查询。
# 手机端打开「全仓合计」会一次发多个；若并发执行，CPU / 内存 / 数据库连接池会被同时打满，
# 1.6G 小内存机器直接 OOM 崩溃（2026-10-13 事故）。这里做三层保护：
#   ① 单飞：同一 key（接口+区间+分仓+口径）并发时只算一次，其余等待复用；
#   ② 并发闸：全局同一时刻只跑一个重汇总，其余排队，绝不叠加；
#   ③ 短缓存：结果缓存 _HEAVY_TTL 秒，反复刷新秒回。
_HEAVY_GATE = threading.Semaphore(1)
# 财务流水只是「一条走索引的查询」（实测 wh01 本月 0.29 秒），和逐仓重汇总不是一个量级。
# 让它挤同一把全局闸，等于排在 5~8 秒的汇总后面干等，所以给它独立的、可并发的闸。
_FIN_GATE = threading.Semaphore(4)
_HEAVY_LOCK = threading.Lock()
_HEAVY_CACHE: dict = {}
_HEAVY_INFLIGHT: dict = {}
_HEAVY_TTL = 60.0
_HEAVY_CACHE_MAX = 32
# 行列表超过这个条数就不进缓存：全仓流水一条结果能占几十 MB，缓存 32 条足以吃掉整台 1.6G 机器
_HEAVY_CACHE_LIST_MAX = 2000


def _heavy_cached(key, compute, gate=_HEAVY_GATE):
    """带单飞 + 并发闸 + 短缓存的汇总计算。key 必须能唯一标识「同一次结果」。"""
    hit = _HEAVY_CACHE.get(key)
    if hit and time.time() - hit[0] < _HEAVY_TTL:
        return hit[1]
    with _HEAVY_LOCK:
        hit = _HEAVY_CACHE.get(key)
        if hit and time.time() - hit[0] < _HEAVY_TTL:
            return hit[1]
        ev = _HEAVY_INFLIGHT.get(key)
        if ev is None:
            ev = threading.Event()
            _HEAVY_INFLIGHT[key] = ev
            leader = True
        else:
            leader = False
    if not leader:
        # 已在算同一个 key：等它算完复用，绝不再算一遍
        ev.wait(timeout=300)
        hit = _HEAVY_CACHE.get(key)
        if hit:
            return hit[1]
        # 领导者异常退出且无缓存：退回自己算一次兜底（放弃单飞，避免死等）
        with gate:
            return compute()
    try:
        with gate:
            result = compute()
        with _HEAVY_LOCK:
            if not isinstance(result, list) or len(result) <= _HEAVY_CACHE_LIST_MAX:
                _HEAVY_CACHE[key] = (time.time(), result)
            while len(_HEAVY_CACHE) > _HEAVY_CACHE_MAX:
                oldest = min(_HEAVY_CACHE, key=lambda k: _HEAVY_CACHE[k][0])
                _HEAVY_CACHE.pop(oldest, None)
        return result
    finally:
        with _HEAVY_LOCK:
            _HEAVY_INFLIGHT.pop(key, None)
        ev.set()


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


# ---------------- 出库「收入」口径 ----------------
# 收入 = 销售收入（商品） + 客户代收的关联结算（settle_income：包材/人工/快递费）。
# 成本侧 total_cogs 本来就含关联结算（出库就结转掉了），收入侧一起计，毛利才不会被包材/快递吃成负数。
# 老单据没有 settle_income 列值时按 0 处理，口径与改造前完全一致。
def _income_expr():
    """SQL 侧收入表达式：total_amount + settle_income（用于 func.sum 聚合）。"""
    return Outbound.total_amount + func.coalesce(Outbound.settle_income, 0)


def _income_of(o) -> float:
    """单据对象侧收入：销售收入 + 客户代收的关联结算。"""
    return (o.total_amount or 0.0) + (getattr(o, "settle_income", 0.0) or 0.0)


# 报表读出库单只用到这几列：整行 ORM 实例化在 wh01 一个月就要造 3.3 万个对象
# （实测占 _summary_of 一半耗时，光InstanceState.__init__ 就 1.5 秒）。
# 列查询返回的 Row 同样支持 o.total_amount / getattr(o, "brush_cost", 0) 这种属性访问，
# 所以下游口径代码一行都不用改。
OUTBOUND_COLS = (
    Outbound.id, Outbound.code, Outbound.date, Outbound.operator, Outbound.remark,
    Outbound.total_amount, Outbound.total_cogs, Outbound.settle_income, Outbound.pay_status,
    Outbound.brush_cost, Outbound.brush_fee, Outbound.brush_auto_fee,
)


def _not_return(model):
    """单数口径：退货单（红冲）不计一单。金额/成本侧不用它 —— 退货单本身记负数，加法即净额。"""
    return case((model.is_return == True, 0), else_=1)  # noqa: E712 - 生成 SQL 的 = 1，NULL 归为普通单


def _pending_stats(inbounds: list, outbounds: list, others: list, finances: list,
                   warehouse_ins: list | None = None) -> dict:
    """未计入本报表的待付款/待收款汇总（按来源单据算，避免自动流水重复计数）。"""
    payables = [_inbound_unpaid(i) for i in inbounds]                       # 入库（采购，部分付款只算未付余额）
    payables += [e.amount or 0.0 for e in others]                           # 其他收支
    payables += [f.amount or 0.0 for f in finances if f.type == "expense" and f.ref_type == "manual"]
    receivables = [_income_of(o) for o in outbounds]                         # 出库（销售，含客户代收的包材等）
    # 入仓（入仓品卖到京东）也是销售渠道：未回款的同样算「待收」
    receivables += [w.amount or 0.0 for w in (warehouse_ins or [])]
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
            # 单数不含退货单（退货是红冲，金额已按负数净额，不该再算一单）
            select(func.coalesce(func.sum(_not_return(Outbound)), 0),
                   # 收入口径 = 销售收入 + 客户代收的关联结算（包材/人工/快递费），见 _income_expr
                   func.coalesce(func.sum(_income_expr()), 0),
                   func.coalesce(func.sum(Outbound.total_cogs), 0),
                   # 芳谊放单仓刷单结算：刷单成本 + 固定费覆盖差（非放单仓订单为 0）
                   func.coalesce(func.sum(brush_adjust_sql(Outbound)), 0))
            .where(Outbound.date >= f, Outbound.date <= t, paid_o)
        ).one()
        revenue, cogs, brush = float(revenue), float(cogs), round(float(brush), 2)

        # 期间费用 = 财务流水里手工登记的支出（不含采购支出，采购已计入库存成本）+ 其他收支
        manual_expense = float(db.execute(
            select(func.coalesce(func.sum(FinanceRecord.amount), 0))
            .where(FinanceRecord.date >= f, FinanceRecord.date <= t,
                   FinanceRecord.type == "expense", FinanceRecord.category != "采购支出",
                   func.coalesce(FinanceRecord.pay_status, PAID) != "unpaid")
        ).scalar() or 0.0)
        other_fee = round(float(db.execute(
            select(func.coalesce(func.sum(OtherExpense.amount), 0))
            .where(OtherExpense.date >= f, OtherExpense.date <= t,
                   func.coalesce(OtherExpense.pay_status, PAID) != "unpaid",
                   # 运费/装卸镜像行已计入批次成本，期间费用不重复扣（「其他收支」页仍可查）
                   func.coalesce(OtherExpense.ref_type, "") != INBOUND_FEE_REF)
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

        fee = round(manual_expense + other_fee, 2)  # 期间费用含「其他收支」（与报表口径一致）
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
                    func.coalesce(func.sum(_income_expr()), 0),
                    # 净利同样扣掉刷单结算（芳谊放单仓的刷单成本 + 固定费覆盖差）
                    func.coalesce(func.sum(
                        _income_expr() - Outbound.total_cogs - Outbound.total_fee
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
                "amount": _income_of(s),
                "net": round(_income_of(s) - s.total_cogs - s.total_fee - brush_adjust(s), 2),
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
    exclude_other: int = 0,   # 1 = 排除「其他收支」，报表只看商品售卖利润（默认 0：含其他收支）
    db: Session = Depends(get_db_wh),
    user: User = Depends(get_current_user),
):
    """经营汇总：默认本登录会话的分仓；wh=all 时合并所有分仓（各自是独立账套）。"""
    key = (
        "summary",
        ALL_WH if wh == ALL_WH else resolve_key(wh),
        date_from,
        date_to,
        int(exclude_other),
    )

    def _compute():
        if wh == ALL_WH:
            return _summary_all(date_from, date_to, bool(exclude_other))
        return _summary_of(db, date_from, date_to, resolve_key(wh), bool(exclude_other))

    return _heavy_cached(key, _compute)


def _inbound_landed(i) -> float:
    """入库实际支出 = 货款 + 运费 + 装卸费（运费/装卸已计入批次成本，故期间费用不重复扣）。

    部分付款时只算已经付掉的那部分：已付金额按应付合计（含调整/运费/装卸）记，
    这里按「货款 + 运费 + 装卸」封顶（金额调整另走「其他收支」，不计入采购桶）。
    """
    landed = round((i.total_amount or 0.0) + (getattr(i, "freight", 0.0) or 0.0) + (getattr(i, "handling", 0.0) or 0.0), 2)
    if (getattr(i, "pay_status", PAID) or PAID) == "partial":
        return round(max(0.0, min(getattr(i, "paid_amount", 0.0) or 0.0, landed)), 2)
    return landed


def _inbound_due(i) -> float:
    """入库单应付合计 = 货款 + 金额调整 + 运费 + 装卸（与「待付款账单」页的应付口径一致）。"""
    return round((i.total_amount or 0.0) + (getattr(i, "adjust_amount", 0.0) or 0.0)
                 + (getattr(i, "freight", 0.0) or 0.0) + (getattr(i, "handling", 0.0) or 0.0), 2)


def _inbound_unpaid(i) -> float:
    """还没付的余额（报表「待付款」口径）：部分付款 = 应付合计 - 已付；待付款沿用原口径（货款）。"""
    if (getattr(i, "pay_status", PAID) or PAID) == "partial":
        return round(max(_inbound_due(i) - (getattr(i, "paid_amount", 0.0) or 0.0), 0.0), 2)
    return round(i.total_amount or 0.0, 2)


def _summary_of(db: Session, date_from: str, date_to: str, key: str, exclude_other: bool = False) -> dict:
    """单个分仓的经营汇总（「单仓总览」各分区的数据源）。

    exclude_other=True 时不计入「其他收支」（other_expenses 表）：期间费用只剩手工记账支出，
    净利润即「只看商品售卖」的利润；被排除的金额仍以 excluded_other_expense 返回，供前端提示。
    """
    def scope(model):
        q = select(model)
        if date_from:
            q = q.where(model.date >= date_from)
        if date_to:
            q = q.where(model.date <= date_to)
        return q

    # 出库单只取用到的那几列（见 OUTBOUND_COLS），不再整行实例化 ORM 对象。
    # 「待付款」的单据不进报表：先拆出来，单独汇总给报表页提示（在「待付款账单」点「已支付」后转入报表）
    ob_q = select(*OUTBOUND_COLS)
    if date_from:
        ob_q = ob_q.where(Outbound.date >= date_from)
    if date_to:
        ob_q = ob_q.where(Outbound.date <= date_to)
    outbounds, unpaid_outbounds = _split_paid(list(db.execute(ob_q)))
    # 采购明细要显示商品名，预载 product 避免逐条懒加载
    inbounds, unpaid_inbounds = _split_paid(
        list(db.execute(scope(Inbound).options(selectinload(Inbound.product))).scalars())
    )
    # 部分付款：已付的那部分算进报表（_inbound_landed 按 paid_amount 计），
    # 没付的余额仍算「待付款」（跟着 unpaid_inbounds 一起进 pending）
    partial_inbounds = [i for i in inbounds if (getattr(i, "pay_status", PAID) or PAID) == "partial"]
    # 流水只取两类行：支出桶要 type=expense，待收/待付桶要 ref_type=manual。
    # 每张出库单都会自动产一条「销售收入」流水（wh01 本月 3.3 万行），本函数一处都不读它，
    # 在 SQL 侧就滤掉：3.3 万个 ORM 对象 → 493 个。
    fin_q = select(FinanceRecord).where(
        or_(FinanceRecord.type == "expense", FinanceRecord.ref_type == "manual")
    )
    finances, unpaid_finances = _split_paid(
        list(db.execute(_date_filter(fin_q, date_from, date_to)).scalars())
    )
    others, unpaid_others = _split_paid(list(db.execute(scope(OtherExpense)).scalars()))
    # 入库「运费/装卸费」镜像行已计入批次到岸成本（FIFO 结转随销量扣减，体现在该品毛利上），
    # 期间费用口径（others → other_raw/other_fees/支出分区/excluded_other_expense）剔除它，
    # 避免「成本 + 期间费用」重复扣减；待付款口径（unpaid_others → _pending_stats）保留，
    # 与「待付款账单」页的应付金额（货款 + 调整 + 运费/装卸）保持一致。
    others = [e for e in others if e.ref_type != INBOUND_FEE_REF]

    # 入仓（入仓品卖到京东那条线）：与出库同属销售渠道，收入/成本一并计入本报表口径，
    # 这样「商品销售明细」里入仓品能作为单独的行列出，且明细合计 = 汇总。
    # 口径：收入 = 入仓收入（已扣入仓品扣点）；成本 = 商品成本 + 运费 + 随货包材。
    warehouse_ins, unpaid_warehouse_ins = _split_paid(list(db.execute(scope(WarehouseIn)).scalars()))
    wi_revenue = round(sum(w.amount or 0.0 for w in warehouse_ins), 2)
    wi_goods = round(sum(w.cogs or 0.0 for w in warehouse_ins), 2)
    wi_freight = round(sum(w.freight_total or 0.0 for w in warehouse_ins), 2)
    wi_pack = round(sum(w.pack_cost or 0.0 for w in warehouse_ins), 2)
    # 固定成本（每袋打包费/难量化包材）：新记录才有快照，老记录 0 → 历史数据口径不变
    wi_fixed = round(sum(getattr(w, "fixed_total", 0.0) or 0.0 for w in warehouse_ins), 2)
    wi_cogs = round(wi_goods + wi_freight + wi_pack + wi_fixed, 2)

    # 收入 = 销售收入 + 客户代收的关联结算（包材/人工/快递费）：与出库单「实收金额」同口径
    revenue = sum(_income_of(o) for o in outbounds) + wi_revenue
    cogs = sum(o.total_cogs for o in outbounds) + wi_cogs
    # 芳谊放单仓刷单结算：刷单成本（我填的）+ 固定费覆盖差；非放单仓订单都是 0。
    # 注意 cogs 里**不**含这笔钱（cogs 仍是商品/包材/快递的结转成本），毛利单独扣它，
    # 这样「商品成本 goods_cogs」不会被刷单成本污染。
    brush_cost = round(sum(float(getattr(o, "brush_cost", 0.0) or 0.0) for o in outbounds), 2)
    brush_total = round(sum(brush_adjust(o) for o in outbounds), 2)
    # 其中「快递+包装固定费」：逐单手填（默认 3.6），与刷单成本一起构成刷单单的全部成本
    brush_fee_total = round(sum(brush_fee_of(o) for o in outbounds), 2)
    gross = round(revenue - cogs - brush_total, 2)
    # 期间费用 = 财务流水里手工登记的支出（不含采购支出，采购已计入库存成本）+ 其他收支
    manual_expense = sum(f.amount for f in finances if f.type == "expense" and f.category != "采购支出")
    # 其他收支原始金额始终统计，便于前端提示「已排除多少」；口径关闭时不计入任何支出/净利计算
    other_raw = round(sum(e.amount or 0.0 for e in others), 2)
    others_in = [] if exclude_other else others
    other_total = 0.0 if exclude_other else other_raw
    expense = round(manual_expense + other_total, 2)
    purchase = sum(f.amount for f in finances if f.type == "expense" and f.category == "采购支出")
    # 本期进货 = 货款 + 入库运费/装卸费（与「支出」分区的采购桶、支出合计口径一致）
    purchase_db = sum(_inbound_landed(i) for i in inbounds)
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
        """按「商品 + 规格 + 是否代发」分桶：出库明细里代发与库存商品不混在一起，也按规格区分。

        注意：这里**不能**把空规格就地归一成商品名——结算行（owned_rows/_spread）调用时
        拿不到商品名（name 传空），就地归一会让结算行找不到销售行那个桶、关联成本丢失。
        规格归一统一放在输出阶段做（见下方 _merge_by_name）。
        """
        return by_product.setdefault(
            (pid, spec, dropship),
            {
                "product_id": pid,
                "spec": spec,
                "is_dropship": dropship,
                "name": name,
                "code": "",  # 商品编码：订单商品上一般填的是平台 SKU（京东 skuId），对外成本表按它对账
                "unit": "",  # 销量单位（商品的默认单位，如 单 / 袋 / 公斤）
                "srcs": set(),  # 该行的来源集合：手动出库 / 聚水潭出库 / 导入出库 / 入仓
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
                "settle_income": 0.0,  # 客户代收的关联结算（包材/人工/快递费，按销售金额占比分摊到单内商品）
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
            func.max(Product.code).label("pcode"),
            # 来源：手动建单（无导入分组）/ 聚水潭导入（备注带「聚水潭」）/ 其他批量导入
            func.max(func.coalesce(Outbound.import_group, "")).label("ig"),
            func.max(case((Outbound.remark.like("%聚水潭%"), 1), else_=0)).label("jst"),
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

    # 销量口径：quantity_base 是「基础单位」数量（如 克），而各商品的基础单位不一样
    # （订单小类是「单/袋」，按公斤卖的库存大类是「克」）。直接拿基础数量当销量，
    # 「20 公斤拇指小玉米」就会显示成 20000，看着像 20000 单 —— 这里统一折成「默认单位」并带上单位。
    du_of: dict[int, tuple[str, float]] = {}
    _pids = {r.pid for r in sale_rows if r.pid}
    if _pids:
        for _p in db.execute(select(Product).where(Product.id.in_(_pids))).scalars():
            _du = (_p.default_unit or _p.base_unit or "").strip()
            _f = float((_p.conversions or {}).get(_du) or 1) or 1.0
            du_of[_p.id] = (_du, _f)

    for r in sale_rows:
        d = _bucket(r.pid, r.spec, bool(r.dr), r.pname or "")
        if r.pname:  # 名称以销售行自身的商品为准（结算行只累加金额，不参与命名）
            d["name"] = r.pname
        if r.pcode:  # 同理带上商品编码（对外成本表按平台 SKU 对账用）
            d["code"] = r.pcode
        du, factor = du_of.get(r.pid or 0, ("", 1.0))
        d["qty"] += float(r.qb or 0.0) / (factor or 1.0)
        if du and not d.get("unit"):
            d["unit"] = du
        # 来源：手动建单没有导入分组；聚水潭导入的备注里带「聚水潭导入 …」
        d["srcs"].add("手动出库" if not (r.ig or "") else ("聚水潭出库" if r.jst else "导入出库"))
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
    # 客户代收的关联结算（包材/人工/快递费）同样归到该单的商品上：
    # 成本侧的包材/快递本来就算在这行成本里，收入侧要把它计回来，商品毛利才不被吃成负数
    for o in outbounds:
        _spread(o.id, "settle_income", float(getattr(o, "settle_income", 0.0) or 0.0))

    # ---- 重量（净重 kg）：与出库结算快递费同一口径 ----
    # 由该销售行实际扣减的库存流水反推：重量类库存商品（基础单位 克）按 扣减量 ÷ 1000；
    # 计数类按 扣减量 ÷ 默认单位换算系数 × 该商品单件净重；没有扣减流水（代发 / 没扣库存）时
    # 回退用订单商品自身的单件净重折算 —— 就是 services.deduction_net_weight_kg / line_weight_kg。
    # 已用「快递费(自动)行的 spec = 整单净重 + 0.1kg 箱重」抽样 200 单做过校验，100% 一致。
    sm = aliased(Product)   # 被扣减的库存商品
    op = aliased(Product)   # 订单商品（销售行自己指向的商品）

    def _kg_per_base(pr):
        """某商品「1 个基础单位」折成 kg：重量类按克数，计数类按 单件净重 ÷ 默认单位换算系数。"""
        return case(
            (pr.base_unit.in_(("克", "g")), 1.0 / 1000.0),
            else_=(1.0 / func.coalesce(func.json_extract(
                pr.conversions, literal("$.").op("||")(pr.default_unit)), 1.0)
                * func.coalesce(pr.weight_kg, 0.0)),
        )

    # 老流水没写 line_id（2026-09 及以前的一部分）：只在「该单只有一条销售行」时按单归属，
    # 多行单据不猜（那种单会退化成用订单商品自身净重），避免把别的商品的重量摊到它头上。
    # 「单行单」用子查询表达 —— 旧实现把几万个单据 id 拼进 IN(...)，全量历史在昆明蔬菜仓
    # 这种大仓直接超 SQLite 999 参数上限（too many SQL variables，接口 500）。
    single_line_ids = (
        select(OutboundLine.outbound_id)
        .select_from(OutboundLine).join(Outbound, Outbound.id == OutboundLine.outbound_id)
        .where(OutboundLine.line_type == "sale", *line_conds, paid_out)
        .group_by(OutboundLine.outbound_id)
        .having(func.count() == 1)
    )
    has_single_line = Outbound.id.in_(single_line_ids.scalar_subquery())
    no_single_line = ~has_single_line
    # ⚠️ 性能红线：不要把「按 line_id 归属」与「按 ref_id 归属」合并成一条带 OR 的 JOIN——
    # SQLite 会退化成从 stock_movements 全表驱动、逐行回查（实测 13 天区间 104 秒，接口超时 499）。
    # 拆成「各自单条件」的分段查询，每段都能走索引（line_id / (ref_type,ref_id)），秒级完成。
    kg_by_line: dict[tuple, float] = {}

    def _add_kg(rows) -> None:
        for pid, spec, dr, kg in rows:
            k = (pid, spec, bool(dr))
            kg_by_line[k] = round(kg_by_line.get(k, 0.0) + float(kg or 0.0), 4)

    # ①-A 新流水：严格按 line_id 关联出库行（走 idx_stock_movements_line）
    _add_kg(db.execute(
        select(OutboundLine.product_id, spec_expr, dr_expr,
               func.coalesce(func.sum(-StockMovement.quantity_base * _kg_per_base(sm)), 0.0))
        .select_from(OutboundLine)
        .join(Outbound, Outbound.id == OutboundLine.outbound_id)
        .join(StockMovement, and_(StockMovement.ref_type == "outbound",
                                  StockMovement.line_id == OutboundLine.id))
        .join(sm, sm.id == StockMovement.product_id, isouter=True)
        .where(OutboundLine.line_type == "sale", *line_conds, paid_out)
        .group_by(OutboundLine.product_id, spec_expr, dr_expr)
    ).all())

    # ①-B 旧流水（line_id 为空）：仅「该单只有一条销售行」时按整单归属（走 ref 索引）
    _add_kg(db.execute(
        select(OutboundLine.product_id, spec_expr, dr_expr,
               func.coalesce(func.sum(-StockMovement.quantity_base * _kg_per_base(sm)), 0.0))
        .select_from(OutboundLine)
        .join(Outbound, Outbound.id == OutboundLine.outbound_id)
        .join(StockMovement, and_(StockMovement.ref_type == "outbound",
                                  StockMovement.line_id.is_(None),
                                  StockMovement.ref_id == Outbound.id))
        .join(sm, sm.id == StockMovement.product_id, isouter=True)
        .where(OutboundLine.line_type == "sale", *line_conds, paid_out, has_single_line)
        .group_by(OutboundLine.product_id, spec_expr, dr_expr)
    ).all())

    # ② 完全没有扣减流水的销售行（代发等）：回退用订单商品自身单件净重
    #    等价于原「LEFT JOIN 流水 WHERE 流水为空」：不存在按 line_id 的流水，且（非单行单 或 不存在按单的旧流水）
    _no_line_mv = ~exists().where(
        StockMovement.ref_type == "outbound",
        StockMovement.line_id == OutboundLine.id,
    )
    _no_ref_mv = ~exists().where(
        StockMovement.ref_type == "outbound",
        StockMovement.line_id.is_(None),
        StockMovement.ref_id == Outbound.id,
    )
    _no_mv = and_(_no_line_mv, or_(no_single_line, _no_ref_mv))
    _add_kg(db.execute(
        select(OutboundLine.product_id, spec_expr, dr_expr,
               func.coalesce(func.sum(OutboundLine.quantity_base * _kg_per_base(op)), 0.0))
        .select_from(OutboundLine)
        .join(Outbound, Outbound.id == OutboundLine.outbound_id)
        .join(op, op.id == OutboundLine.product_id, isouter=True)
        .where(OutboundLine.line_type == "sale", *line_conds, paid_out, _no_mv)
        .group_by(OutboundLine.product_id, spec_expr, dr_expr)
    ).all())

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
        settle = round(d.get("settle_income", 0.0), 2)  # 客户代收的关联结算（包材/人工/快递费）
        # 商品毛利 = 销售收入 + 客户代收的关联结算 − 总成本（包材/快递本来就在成本里）
        gp = round(amount + settle - total_cogs, 2)
        # 毛利率分母用扣点前销售金额 + 代收的关联结算（与毛利同口径）
        denom = round((gross_sales or amount) + settle, 2)
        product_rows.append(
            {
                "product_id": d["product_id"],
                # 规格 + 是否代发：前端据此把「代发」单独标出、并按规格区分
                "spec": d["spec"],
                "is_dropship": d["is_dropship"],
                "name": d["name"],
                # 商品编码：订单商品上一般填的是平台 SKU（京东为数字 skuId）
                "code": d.get("code") or "",
                # 销量（已折算成商品默认单位）与单位：前端「销量」列直接拼成「20公斤」
                "qty": round(d["qty"], 4),
                "unit": d.get("unit") or "",
                # 来源：手动出库 / 聚水潭出库 / 导入出库（同一商品混了多种来源时用「＋」连接）
                "source": " ＋ ".join(sorted(d.get("srcs") or [])),

                # 净重（kg）：口径见上面「重量」那一段（与出库结算快递费一致）
                "weight_kg": round(kg_by_line.get(
                    (d["product_id"], d["spec"], bool(d["is_dropship"])), 0.0), 4),
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
                "settle_income": settle,    # 客户代收的关联结算（包材/人工/快递费）
                "total_cogs": total_cogs,
                "gross_profit": gp,
                "gp_rate": round(gp / denom * 100, 2) if denom else 0.0,
            }
        )

    # ---- 规格归一：空规格并入「同名规格」，消掉看起来重复的行 ----------------
    # 聚水潭同一个订单商品在不同批次导入时，规格可能写成不同值（多为空）。
    # 例：wh01「云南大香芋头4.5斤3-5个」(id=366) 的出库行里，15 单规格为空、
    # 14 单规格="云南大香芋头4.5斤3-5个"，报表按「商品+规格」分桶后就是两行，
    # 而两行的销量/收入都只反映各自那一半 → 用户看到「同一个商品出现两次」。
    #
    # 这里在**输出阶段**做归一（不能改 _bucket：结算行走 owned_rows/_spread 时拿不到商品名，
    # 就地归一会让关联结算找不到销售行那个桶，成本会丢）：
    #   某商品只有一个非空规格 + 若干空规格 → 把空规格并进去，规格取那个非空值；
    #   多个非空规格（真有规格差异）→ 空规格单独成行，规格标为「未标注规格」，不丢数据。
    _by_pid: dict[tuple, list[dict]] = {}
    for r in product_rows:
        _by_pid.setdefault((r["product_id"], bool(r["is_dropship"])), []).append(r)
    _merged: list[dict] = []
    for _rows in _by_pid.values():
        _named = [r for r in _rows if (r["spec"] or "").strip()]
        _blank = [r for r in _rows if not (r["spec"] or "").strip()]
        if _blank and len(_named) == 1:
            _t = _named[0]
            for r in _blank:
                _t["qty"] += r["qty"]
                _t["weight_kg"] = round(_t["weight_kg"] + r["weight_kg"], 4)
                _t["amount"] += r["amount"]
                _t["gross_sales"] += r["gross_sales"]
                for _f in ("cogs", "goods_cogs", "pack_cogs", "labor_cogs",
                           "material_cogs", "other_cogs", "express_cogs",
                           "brush_cogs", "settle_income", "total_cogs"):
                    _t[_f] = round(_t[_f] + r[_f], 2)
                _t["gross_profit"] = round(_t["amount"] + _t["settle_income"] - _t["total_cogs"], 2)
                _den = (_t["gross_sales"] or _t["amount"]) + _t["settle_income"]
                _t["gp_rate"] = round(_t["gross_profit"] / _den * 100, 2) if _den else 0.0
            _merged.extend(_named)
        elif _blank:
            # 有多个非空规格（规格真有差异）→ 空规格单独成行标「未标注规格」。
            # ⚠️ 这里必须把 _named 和 _blank 都带上：以前只 extend(_named)，
            # 空规格那几行被改了名字却没进结果，整行（销量/收入/成本）直接丢掉 —— 用户反馈
            # 「财务报表商品明细比出库明细少了 1000 多」就是这么来的（如 wh01「紫皮独头蒜中果3斤」）。
            for r in _blank:
                r["spec"] = "未标注规格"
            _merged.extend(_named + _blank)
        else:
            _merged.extend(_named)
    product_rows = _merged
    product_rows.sort(key=lambda r: -r["amount"])

    # ---- 入仓品：按「入仓品名 + 分类」单独成行（出库方式=入仓），不与出库商品合并 ----
    # 重量口径两条路，优先第一条：
    #   ① 入仓品资料里维护的「每袋净重 + 单位」（bag_net_weight / bag_net_unit）——
    #      关联库存商品的单位是「瓶/个」这类计数单位时（如花生按瓶入、每瓶 228g），
    #      成本口径的 bag_weight 是「每袋 1 瓶」而不是重量，只有这里能给出真实净重；
    #   ② 没维护时回退：把「每袋数量」bag_weight 当作库存默认单位下的净重折算（公斤/斤/克 才有意义）。
    # 两条都算不出（库存单位不是重量且没维护净重）就记 0，前端显示「—」，不凭空造数。
    wi_net_of: dict[int, tuple[float, str]] = {}   # 入仓品 id → (每袋净重, 单位)
    wi_unit_of: dict[int, str] = {}                # 关联库存商品 id → 默认单位
    wi_pids = {w.product_id for w in warehouse_ins if w.product_id}
    if wi_pids:
        for _wp in db.execute(
            select(WarehouseProduct).where(WarehouseProduct.id.in_(wi_pids))
        ).scalars():
            wi_net_of[_wp.id] = (float(_wp.bag_net_weight or 0.0), (_wp.bag_net_unit or "").strip())
    wi_sp_ids = {w.stock_product_id for w in warehouse_ins if w.stock_product_id}
    if wi_sp_ids:
        for _sp in db.execute(select(Product).where(Product.id.in_(wi_sp_ids))).scalars():
            wi_unit_of[_sp.id] = (_sp.default_unit or _sp.base_unit or "").strip()

    def _wi_weight(w) -> float:
        """入仓一行的净重 kg。"""
        qty = w.quantity or 0.0
        net, unit = wi_net_of.get(w.product_id or 0, (0.0, ""))
        if net > 0:
            return qty * net_weight_kg(net, unit)
        return qty * net_weight_kg(w.bag_weight or 0.0, wi_unit_of.get(w.stock_product_id, ""))

    wi_buckets: dict[tuple, dict] = {}
    for w in warehouse_ins:
        nm = (w.product_name or "").strip()
        cat = (w.category or "").strip()
        b = wi_buckets.setdefault((nm, cat), {
            "product_id": w.product_id, "name": nm, "spec": cat, "unit": w.unit or "袋",
            "qty": 0.0, "amount": 0.0, "gross_sales": 0.0,
            "goods": 0.0, "freight": 0.0, "pack": 0.0, "fixed": 0.0, "weight": 0.0,
        })
        b["qty"] += w.quantity or 0.0
        b["weight"] += _wi_weight(w)
        b["amount"] += w.amount or 0.0
        # 扣点前金额 = 数量 × 采购价（入仓品采购价是扣点前的收入单价），与出库的 gross_sales 同口径
        b["gross_sales"] += (w.quantity or 0.0) * (w.unit_price or 0.0)
        b["goods"] += w.cogs or 0.0
        b["freight"] += w.freight_total or 0.0
        b["pack"] += w.pack_cost or 0.0
        b["fixed"] += getattr(w, "fixed_total", 0.0) or 0.0
    for b in wi_buckets.values():
        goods = round(b["goods"], 2)
        freight = round(b["freight"], 2)
        pack = round(b["pack"], 2)
        fixed = round(b["fixed"], 2)
        total_cogs = round(goods + freight + pack + fixed, 2)
        amount = round(b["amount"], 2)
        gross_sales = round(b["gross_sales"], 2)
        gp = round(amount - total_cogs, 2)
        product_rows.append({
            "product_id": b["product_id"],
            "spec": b["spec"],
            "is_dropship": False,
            "is_warehouse_in": True,   # 前端据此把「出库方式」标成「入仓」
            "source": "入仓",          # 来源列：入仓台账（对面是 手动出库 / 聚水潭出库 / 导入出库）
            "name": b["name"] or "（未命名入仓品）",
            "code": "",
            "unit": b["unit"],         # 入仓按「袋」计；出库行没有这个字段
            "qty": round(b["qty"], 4),
            "weight_kg": round(b["weight"], 4),
            "amount": amount,
            "gross_sales": gross_sales,
            "cogs": total_cogs,
            "goods_cogs": goods,
            # 入仓的包材/运费复用 material/express 字段（成本构成小字按 is_warehouse_in 换标签）
            "pack_cogs": pack,
            "labor_cogs": 0.0,
            "material_cogs": pack,
            "other_cogs": 0.0,
            "express_cogs": freight,
            # 固定成本（每袋打包费/难量化包材，老记录为 0）——成本构成小字里单独列出
            "fixed_cogs": fixed,
            "brush_cogs": 0.0,
            "settle_income": 0.0,
            "total_cogs": total_cogs,
            "gross_profit": gp,
            "gp_rate": round(gp / gross_sales * 100, 2) if gross_sales else 0.0,
        })
    # 出库行原本已按收入倒序，这里把入仓行并进来后统一重排，保证整表按收入从大到小
    product_rows.sort(key=lambda r: -r["amount"])

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
    # 商品本身成本 = 总成本 − 出库关联结算成本 − 入仓运费/随货包材
    # （入仓的运费/包材单独列在 warehouse_in_* 字段里，不混进「关联结算」口径）
    goods_cogs = round(cogs - pack_total - wi_freight - wi_pack, 2)

    # 账外费用（finance_records 中登记的手工支出），按类别归集
    manual_fees: dict[str, float] = {}
    for f in finances:
        if f.type != "expense" or f.category == "采购支出":
            continue
        manual_fees[f.category] = round(manual_fees.get(f.category, 0.0) + f.amount, 2)

    # 其他收支（网线费/安装费/机器费/样品费…），按费用类型归集（口径关闭时为空）
    other_fees: dict[str, float] = {}
    for e in others_in:
        other_fees[e.category] = round(other_fees.get(e.category, 0.0) + (e.amount or 0.0), 2)

    # 逐日 / 逐月支出：四类合计——采购进货 + 其他收支 + 手工记账 + 刷单成本。
    # 注意口径：total 是"全部支出"（含采购与刷单成本），period_expense 才是从毛利中扣减的「期间费用」；
    # 采购已计入结转成本（COGS）、刷单成本已在毛利里扣过，两者都不进期间费用，净利仍按期间费用计算。
    exp_day: dict[str, dict] = {}
    exp_month: dict[str, dict] = {}

    def _add_expense(bucket: dict, key: str, kind: str, amount: float) -> None:
        if not key:
            return
        b = bucket.setdefault(key, {"purchase": 0.0, "other": 0.0, "manual": 0.0, "brush": 0.0, "count": 0})
        b[kind] += amount or 0.0
        b["count"] += 1

    for i in inbounds:  # 采购/进货（与顶部「本期进货」同源；含运费/装卸）
        _add_expense(exp_day, i.date, "purchase", _inbound_landed(i))
        _add_expense(exp_month, (i.date or "")[:7], "purchase", _inbound_landed(i))
    for e in others_in:
        _add_expense(exp_day, e.date, "other", e.amount)
        _add_expense(exp_month, (e.date or "")[:7], "other", e.amount)
    for f in finances:
        if f.type != "expense" or f.category == "采购支出":
            continue
        _add_expense(exp_day, f.date, "manual", f.amount)
        _add_expense(exp_month, (f.date or "")[:7], "manual", f.amount)
    # 刷单成本（放单仓刷单单 = 快递+包装固定费 + 刷单成本）：一笔=一张刷单单
    for o in outbounds:
        adj = brush_adjust(o)
        if not adj and not float(getattr(o, "brush_fee", 0) or 0):
            continue
        _add_expense(exp_day, o.date, "brush", adj)
        _add_expense(exp_month, (o.date or "")[:7], "brush", adj)

    def _expense_rows(bucket: dict, label: str) -> list[dict]:
        """按日期/月份倒序的支出明细：采购 / 其他收支 / 手工记账 / 刷单成本 / 合计 / 笔数。"""
        return [
            {
                label: k,
                "purchase": round(v["purchase"], 2),
                "other_expense": round(v["other"], 2),
                "manual_expense": round(v["manual"], 2),
                # 刷单成本＝快递+包装固定费＋刷单成本（已从毛利扣减，不重复计入期间费用）
                "brush_expense": round(v["brush"], 2),
                # 期间费用＝其他收支＋手工记账（真正从毛利中扣减的部分）
                "period_expense": round(v["other"] + v["manual"], 2),
                # 全部支出＝采购＋其他收支＋手工记账＋刷单成本
                "total": round(v["purchase"] + v["other"] + v["manual"] + v["brush"], 2),
                "count": v["count"],
            }
            for k, v in sorted(bucket.items(), reverse=True)
        ]

    # 逐笔支出明细：与「支出合计」完全同口径（采购进货 + 其他收支 + 手工记账），
    # 供报表「支出」分区逐条核对。「流水」分区只列财务流水，不含其他收支与采购，故这里单独拆出。
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
        fee = round((getattr(i, "freight", 0.0) or 0.0) + (getattr(i, "handling", 0.0) or 0.0), 2)
        note = i.supplier or i.remark or ""
        if fee:
            # 运费/装卸费已计入批次成本，这里并入采购支出金额并注明，和「逐日支出」的采购桶口径一致
            parts = []
            if getattr(i, "freight", 0.0):
                parts.append(f"运费 ¥{round(i.freight, 2)}")
            if getattr(i, "handling", 0.0):
                parts.append(f"装卸费 ¥{round(i.handling, 2)}")
            note = (note + " · " if note else "") + "、".join(parts) + "（已计入成本）"
        if (getattr(i, "pay_status", PAID) or PAID) == "partial":
            # 部分付款：这里只列已付部分，未付余额在「待付款账单」里
            note = (note + " · " if note else "") + (
                f"部分付款：已付 ¥{_inbound_landed(i):.2f} / 应付 ¥{_inbound_due(i):.2f}"
                f"（未付 ¥{_inbound_unpaid(i):.2f} 见待付款账单）"
            )
        expense_items.append({
            "date": i.date, "source": "采购", "category": "采购支出",
            "item": _inbound_label(i), "amount": _inbound_landed(i),
            "operator": i.operator or "", "remark": note,
            "ref": i.code or "", "auto": False,
        })
    for e in others_in:
        expense_items.append({
            "date": e.date, "source": "其他收支", "category": e.category,
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
    # 刷单成本（放单仓刷单单）：逐单列出来，金额 = 快递+包装固定费 + 刷单成本，
    # 与「支出合计」同口径（已从毛利扣减，不重复计入期间费用）
    for o in outbounds:
        adj = brush_adjust(o)
        if not adj and not float(getattr(o, "brush_fee", 0) or 0):
            continue
        fee = round(brush_fee_of(o), 2)
        cost = round(float(getattr(o, "brush_cost", 0) or 0), 2)
        detail = " ＋ ".join(x for x in (
            f"快递+包装 ¥{fee}" if fee else "",
            f"刷单成本 ¥{cost}" if cost else "",
        ) if x) or "刷单结算"
        expense_items.append({
            "date": o.date, "source": "刷单成本", "category": "刷单成本",
            "item": detail, "amount": adj,
            "operator": o.operator or "", "remark": o.remark or "",
            "ref": o.code or "", "auto": False,
        })
    # 日期倒序；同一天保持「采购 → 其他收支 → 手工记账」顺序（稳定排序）
    expense_items.sort(key=lambda r: r["date"], reverse=True)

    return {
        "date_from": date_from,
        "date_to": date_to,
        # 本报表是哪个分仓的（单仓总览可切换分仓查看）
        "warehouse": {"key": key, "name": current_warehouse_name(key)},
        "is_current": key == resolve_key(""),
        # 以下金额一律只含「已付款」单据（待付款 / 部分付款的未付余额在 pending 里，点「已支付」后自动转入）
        "pending": _pending_stats(unpaid_inbounds + partial_inbounds, unpaid_outbounds, unpaid_others,
                                  unpaid_finances, unpaid_warehouse_ins),
        "revenue": round(revenue, 2),
        # 其中：客户随货款一起付的关联结算（包材/人工/快递费）——只在勾了「实收含关联结算」的单据上
        "settle_income": round(sum(float(getattr(o, "settle_income", 0.0) or 0.0) for o in outbounds), 2),
        "cogs": round(cogs, 2),
        "goods_cogs": goods_cogs,
        # 入仓（入仓品卖到京东）拆分：上面的 revenue / cogs / goods_cogs 已包含它，这里单列便于核对
        "warehouse_in_revenue": wi_revenue,
        "warehouse_in_cogs": wi_cogs,
        "warehouse_in_goods_cogs": wi_goods,
        "warehouse_in_freight": wi_freight,
        "warehouse_in_pack": wi_pack,
        "warehouse_in_qty": round(sum(w.quantity or 0.0 for w in warehouse_ins), 4),
        "warehouse_in_count": len(warehouse_ins),
        # 刷单结算（芳谊放单仓）：刷单成本 + 固定费覆盖差，已从下面的毛利/净利里扣掉
        "brush_cost": brush_total,
        "brush_input_cost": brush_cost,   # 其中「我填的刷单成本」原值合计（展示用）
        "brush_fee_cost": brush_fee_total,  # 其中「快递+包装固定费」合计（逐单手填，默认 3.6）
        "gross_profit": gross,
        # 期间费用 = 手工记账支出 + 其他收支，从毛利中扣减得到净利
        "expense": expense,
        "manual_expense": round(manual_expense, 2),
        "other_expense": other_total,
        # 报表口径开关：exclude_other_expense=True = 已排除其他收支（只看商品售卖利润）
        "exclude_other_expense": bool(exclude_other),
        "excluded_other_expense": other_raw,   # 被排除掉的其他收支金额（仅供提示）
        "net_profit": net,
        "purchase": round(purchase_db, 2),
        # 全部支出 = 采购（进货）+ 其他收支 + 手工记账 + 刷单成本；仅用于"支出"展示口径
        # （采购已进结转成本、刷单成本已在毛利里扣过，都不进期间费用，净利不受影响）
        "total_expense": round(purchase_db + expense + brush_total, 2),
        "stock_value": stock_value,
        "order_count": len(outbounds),
        "inbound_count": len(inbounds),
        "by_product": product_rows,
        # 出库自动结算的关联成本明细（包材/人工/快递），已包含在 cogs 中
        "pack_costs": pack_costs,
        "pack_cost_total": pack_total,
        # 账外手工登记费用（不含采购支出），会额外从毛利中扣减得到净利
        "manual_fees": manual_fees,
        # 其他收支明细（按费用类型），同样计入期间费用
        "other_expenses": other_fees,
        # 逐日 / 逐月支出明细（采购 + 其他收支 + 手工记账）
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

    # ---- 商品：按「商品 + 规格 + 是否代发 + 是否入仓」归并，再用合并后的成本重算毛利/毛利率 ----
    # 入仓品要单独成行，不能和同名同规格的出库商品合并（否则「出库方式」就没法区分了）
    num_fields = ("qty", "weight_kg", "amount", "gross_sales", "goods_cogs", "pack_cogs",
                  "labor_cogs", "material_cogs", "other_cogs", "express_cogs", "brush_cogs",
                  "fixed_cogs", "settle_income")
    buckets: dict[tuple, dict] = {}
    for p in parts:
        for r in p.get("by_product") or []:
            k = (r.get("name") or "", r.get("spec") or "", bool(r.get("is_dropship")),
                 bool(r.get("is_warehouse_in")))
            d = buckets.get(k)
            if d is None:
                d = {**r}
                for f in num_fields:
                    d[f] = 0.0
                d["_srcs"] = set()
                buckets[k] = d
            for f in num_fields:
                d[f] = float(d.get(f) or 0) + float(r.get(f) or 0)
            # 来源跨分仓取并集（同一商品在不同分仓可能是手动建单或聚水潭导入）
            d["_srcs"].update(x.strip() for x in str(r.get("source") or "").split("＋") if x.strip())
    product_rows: list[dict] = []
    for d in buckets.values():
        goods = round(d["goods_cogs"], 2)
        pack = round(d["pack_cogs"], 2)
        express = round(d["express_cogs"], 2)
        brush = round(d["brush_cogs"], 2)   # 芳谊放单仓刷单结算（与单仓口径一致）
        fixed = round(d.get("fixed_cogs", 0.0), 2)   # 入仓品固定成本（老记录为 0）
        total_cogs = round(goods + pack + express + brush + fixed, 2)
        amount = round(d["amount"], 2)
        gross_sales = round(d["gross_sales"], 2)
        settle = round(d.get("settle_income", 0.0), 2)   # 客户代收的关联结算（与单仓口径一致）
        gp = round(amount + settle - total_cogs, 2)
        denom = round((gross_sales or amount) + settle, 2)
        product_rows.append({
            # 去掉内部字段（_srcs 是集合，不能进 JSON）
            **{k: v for k, v in d.items() if not k.startswith("_")},
            "qty": round(d["qty"], 4),
            # 来源：合并各分仓后取并集
            "source": " ＋ ".join(sorted(d.get("_srcs") or [])) or (d.get("source") or ""),
            "amount": amount,
            "gross_sales": gross_sales,
            "settle_income": settle,
            # cogs 语义与单仓一致：总成本 = 商品成本 + 打包人工/耗材 + 快递费
            "cogs": total_cogs,
            "total_cogs": total_cogs,
            "gross_profit": gp,
            "gp_rate": round(gp / denom * 100, 2) if denom else 0.0,
        })
    product_rows.sort(key=lambda x: -x["amount"])

    # ---- 支出：按日 / 按月归并（采购 + 其他收支 + 手工记账）----
    def merge_expense_rows(field: str, label: str) -> list[dict]:
        acc: dict[str, dict] = {}
        for p in parts:
            for r in p.get(field) or []:
                k = r.get(label) or ""
                if not k:
                    continue
                b = acc.setdefault(k, {"purchase": 0.0, "other": 0.0, "manual": 0.0, "brush": 0.0, "count": 0})
                b["purchase"] += float(r.get("purchase") or 0)
                b["other"] += float(r.get("other_expense") or 0)
                b["manual"] += float(r.get("manual_expense") or 0)
                b["brush"] += float(r.get("brush_expense") or 0)
                b["count"] += int(r.get("count") or 0)
        return [
            {
                label: k,
                "purchase": round(v["purchase"], 2),
                "other_expense": round(v["other"], 2),
                "manual_expense": round(v["manual"], 2),
                "brush_expense": round(v["brush"], 2),
                "period_expense": round(v["other"] + v["manual"], 2),
                "total": round(v["purchase"] + v["other"] + v["manual"] + v["brush"], 2),
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
        # 入仓（入仓品卖到京东）：各分仓已把收入/成本并入上面的 revenue/cogs/goods_cogs，这里只相加
        "warehouse_in_revenue": s("warehouse_in_revenue"),
        "warehouse_in_cogs": s("warehouse_in_cogs"),
        "warehouse_in_goods_cogs": s("warehouse_in_goods_cogs"),
        "warehouse_in_freight": s("warehouse_in_freight"),
        "warehouse_in_pack": s("warehouse_in_pack"),
        "warehouse_in_qty": s("warehouse_in_qty"),
        "warehouse_in_count": i("warehouse_in_count"),
        # 刷单结算（芳谊放单仓）合计：各分仓已按同口径扣减，这里只相加
        "brush_cost": s("brush_cost"),
        "brush_input_cost": s("brush_input_cost"),
        "brush_fee_cost": s("brush_fee_cost"),
        "gross_profit": s("gross_profit"),
        "expense": s("expense"),
        "manual_expense": s("manual_expense"),
        "other_expense": s("other_expense"),
        # 全仓口径开关：任一分仓标记为「排除其他收支」即视为同一口径
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
            # 单数：退货单（红冲）不算一单，但它的数量/金额仍按负数参与合计
            func.count(func.distinct(case((Outbound.is_return == True, None), else_=Outbound.id))),  # noqa: E712
            func.coalesce(func.sum(OutboundLine.quantity), 0.0),
            func.coalesce(func.sum(OutboundLine.amount), 0.0),
            func.coalesce(func.sum(case((dropship, OutboundLine.quantity), else_=0.0)), 0.0),
            func.coalesce(func.sum(case((dropship, OutboundLine.cogs), else_=0.0)), 0.0),
        )

    # 每天的总单数：含没有销售行的单（与原实现一致，days 也会包含这些日期）；退货单不计单数
    day_orders = dict(db.execute(
        select(Outbound.date, func.coalesce(func.sum(_not_return(Outbound)), 0))
        .where(*conds).group_by(Outbound.date)
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

    exclude_other=True 时不计入其他收支（只看商品售卖利润）。

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

    orders, revenue, cogs, brush, settle_total = db.execute(
        # 单数不含退货单（红冲单）
        select(func.coalesce(func.sum(_not_return(Outbound)), 0),
               func.coalesce(func.sum(_income_expr()), 0),
               func.coalesce(func.sum(Outbound.total_cogs), 0),
               # 芳谊放单仓刷单结算（刷单成本 + 固定费覆盖差），与 /report/summary 同口径
               func.coalesce(func.sum(brush_adjust_sql(Outbound)), 0),
               # 其中客户代收的关联结算（包材/人工/快递费）
               func.coalesce(func.sum(func.coalesce(Outbound.settle_income, 0)), 0))
        .where(*_date_conds(Outbound), paid(Outbound))
    ).one()
    revenue, cogs, brush = float(revenue), float(cogs), round(float(brush), 2)
    settle_total = round(float(settle_total or 0), 2)

    # 入仓（入仓品卖到京东）：与出库同为销售渠道，收入/成本一并计入（口径与 /report/summary 一致）
    wi_cnt, wi_revenue, wi_cogs = db.execute(
        select(
            func.count(),
            func.coalesce(func.sum(WarehouseIn.amount), 0),
            func.coalesce(func.sum(
                func.coalesce(WarehouseIn.cogs, 0)
                + func.coalesce(WarehouseIn.freight_total, 0)
                + func.coalesce(WarehouseIn.pack_cost, 0)
            ), 0),
        ).where(*_date_conds(WarehouseIn), paid(WarehouseIn))
    ).one()
    wi_cnt, wi_revenue, wi_cogs = int(wi_cnt), float(wi_revenue), float(wi_cogs)
    revenue += wi_revenue
    cogs += wi_cogs

    manual_expense = float(db.execute(
        select(func.coalesce(func.sum(FinanceRecord.amount), 0))
        .where(*_date_conds(FinanceRecord), paid(FinanceRecord),
               FinanceRecord.type == "expense", FinanceRecord.category != "采购支出")
    ).scalar() or 0.0)
    other_raw = round(float(db.execute(
        select(func.coalesce(func.sum(OtherExpense.amount), 0))
        .where(*_date_conds(OtherExpense), paid(OtherExpense),
               # 运费/装卸镜像行已计入批次成本，期间费用不重复扣（「其他收支」页仍可查）
               func.coalesce(OtherExpense.ref_type, "") != INBOUND_FEE_REF)
    ).scalar() or 0.0), 2)
    # 部分付款：已付部分算本期进货，未付余额算待付款（与 /report/summary 同口径）
    inbound_landed = (Inbound.total_amount + func.coalesce(Inbound.freight, 0)
                      + func.coalesce(Inbound.handling, 0))
    inbound_due = inbound_landed + func.coalesce(Inbound.adjust_amount, 0)
    inbound_paid = func.coalesce(Inbound.paid_amount, 0)
    inb_partial = func.coalesce(Inbound.pay_status, PAID) == "partial"
    inb_cnt, purchase = db.execute(
        select(
            func.count(),
            # 本期进货 = 货款 + 入库运费/装卸费（与「支出」分区采购口径、支出合计一致）
            func.coalesce(func.sum(
                case((inb_partial & (inbound_paid < inbound_landed), inbound_paid), else_=inbound_landed)
            ), 0),
        )
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
    # 部分付款：未付余额（应付合计 - 已付）也计进待付款
    pb_c, pb_a = db.execute(
        select(func.count(), func.coalesce(func.sum(
            case((inbound_due > inbound_paid, inbound_due - inbound_paid), else_=0)
        ), 0)).where(*_date_conds(Inbound), inb_partial)
    ).one()
    ib_c, ib_a = ib_c + int(pb_c), ib_a + float(pb_a or 0)
    oe_c, oe_a = unpaid_count_sum(OtherExpense, OtherExpense.amount)
    fi_out_c, fi_out_a = unpaid_count_sum(FinanceRecord, FinanceRecord.amount,
                                          (FinanceRecord.type == "expense", FinanceRecord.ref_type == "manual"))
    # 待收（未回款）：应收口径与出库单「实收金额」一致（含客户代收的包材/人工/快递费）
    ob_c, ob_a = unpaid_count_sum(Outbound, _income_expr())
    fi_in_c, fi_in_a = unpaid_count_sum(FinanceRecord, FinanceRecord.amount,
                                        (FinanceRecord.type == "income", FinanceRecord.ref_type == "manual"))
    # 待收：未回款的入仓单（入仓也是销售渠道，应收口径与出库一致）
    wi_un_c, wi_un_a = unpaid_count_sum(WarehouseIn, WarehouseIn.amount)

    return {
        "key": key,
        "name": name,
        "revenue": round(revenue, 2),
        # 其中：客户随货款一起付的关联结算（包材/人工/快递费）
        "settle_income": settle_total,
        "cogs": round(cogs, 2),
        # 入仓（入仓品卖到京东）：上面的 revenue/cogs 已包含它，这里单列便于核对
        "warehouse_in_revenue": round(wi_revenue, 2),
        "warehouse_in_cogs": round(wi_cogs, 2),
        "brush_cost": brush,
        "gross": round(revenue - cogs - brush, 2),
        "expense": expense,
        "other_expense": other_expense,
        "manual_expense": round(manual_expense, 2),
        "exclude_other_expense": bool(exclude_other),
        "excluded_other_expense": other_raw,
        "purchase": round(purchase, 2),
        # 全部支出 = 采购 + 其他收支 + 手工记账 + 刷单成本（与单仓 /report/summary 同口径）
        "total_expense": round(purchase + expense + brush, 2),
        "net_profit": round(revenue - cogs - brush - expense, 2),
        "orders": int(orders),
        "inbounds": int(inb_cnt),
        "warehouse_ins": wi_cnt,
        "stock_value": stock_value,
        "pending": {
            "payables_count": ib_c + oe_c + fi_out_c,
            "payables_amount": round(ib_a + oe_a + fi_out_a, 2),
            "receivables_count": ob_c + fi_in_c + wi_un_c,
            "receivables_amount": round(ob_a + fi_in_a + wi_un_a, 2),
        },
    }


@router.get("/report/all-warehouses")
def all_warehouses(
    date_from: str = "",
    date_to: str = "",
    exclude_other: int = 0,   # 1 = 排除「其他收支」（与 /report/summary 同口径）
    user: User = Depends(get_current_user),
):
    """全仓总览：把所有分仓的收入 / 支出 / 利润汇总成一张表 + 合计。"""
    return _heavy_cached(
        ("all-warehouses", date_from, date_to, int(exclude_other)),
        lambda: _all_warehouses_impl(date_from, date_to, bool(exclude_other)),
    )


def _all_warehouses_impl(date_from: str, date_to: str, exclude_other: bool) -> dict:
    """全仓总览的实际计算（逐仓查询后累加）。

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
        # 入仓（入仓品卖到京东）：各分仓已按同口径并入 revenue/cogs，这里只相加
        "warehouse_in_revenue": s("warehouse_in_revenue"),
        "warehouse_in_cogs": s("warehouse_in_cogs"),
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
        "warehouse_ins": int(sum(int(x.get("warehouse_ins") or 0) for x in ok)),
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
        return _heavy_cached(
            ("finance", "all", date_from, date_to),
            lambda: _finance_all(date_from, date_to),
            gate=_FIN_GATE,
        )
    return _heavy_cached(
        ("finance", resolve_key(wh), date_from, date_to),
        lambda: _finance_of(db, date_from, date_to),
        gate=_FIN_GATE,
    )


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
