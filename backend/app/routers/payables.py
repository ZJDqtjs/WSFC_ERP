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
    DropshipBill,
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

# kind → 模型（前端按 kind 提交「已支付」）。dropship 例外：按出库单聚合，见 pay_bill。
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
    "dropship": "代发",
    "dropship_item": "代发",
}
# 跳转到对应页面的锚点（前端用于「去处理」）
SOURCE_PAGE = {
    "inbound": "inbound",
    "warehouse_in": "warehouse-in",
    "outbound": "outbound",
    "otherexp": "otherexp",
    "finance": "report",
    "dropship": "outbound",
}
DROPSHIP_KIND = "dropship"                  # 按出库单整单结算（账单列表里的代发行）
DROPSHIP_ITEM_KIND = "dropship_item"        # 按「商品+规格」的账单行结算（代发页签合并后的行）


class PayIn(BaseModel):
    kind: str
    id: int
    paid: bool = True  # True=已支付（转入报表），False=撤销为待付款


class PayBatchIn(BaseModel):
    kind: str
    ids: list[int]
    paid: bool = True


def _qty(v) -> str:
    s = f"{float(v or 0):.4f}".rstrip("0").rstrip(".")
    return s or "0"


def _num(v, nd: int = 4) -> str:
    """数字转短字符串（去掉多余的 0）：15.0 → 15、6.6667 → 6.6667。"""
    s = f"{float(v or 0):.{nd}f}".rstrip("0").rstrip(".")
    return s or "0"


def _unit_price_of(amount: float, quantity: float) -> float:
    """按下单单位折算的单价 = 金额 ÷ 单量（保证「单价 × 单量 = 金额」可直接核对）。"""
    return round(float(amount or 0) / float(quantity), 4) if quantity else 0.0


# 「含最近已结清」时最多列多少张出库单（按日期倒序）：防止上万张单把接口与浏览器拖垮
SETTLED_LIST_LIMIT = 1200


def _dropship_formula(b: "DropshipBill") -> str:
    """代发一行的核对算式：规格 单价×单量=金额。"""
    label = (b.spec or "").strip() or (b.product_name or "代发")
    price = _unit_price_of(b.amount, b.quantity)
    return f"{label} ¥{_num(price)}×{_qty(b.quantity)}=¥{round(float(b.amount or 0), 2):.2f}"


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
            # 应付 = 实付（含抹零/凑整调整 + 运费/装卸费；后两者的「其他开支」镜像行不单独列为待办）
            r.total_amount + (getattr(r, "adjust_amount", 0.0) or 0.0)
            + (getattr(r, "freight", 0.0) or 0.0) + (getattr(r, "handling", 0.0) or 0.0),
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

    # 「含最近已结清」时最近 30 天可能上万张单（wh01 实测 1.9 万）：按日期倒序只取最近一批，
    # 免得接口要 1.5 秒、浏览器拉 2MB 备注渲染几千行（未结清的单不受影响，一笔都不会少）。
    ob_q = (
        select(Outbound).where(_pay_filter(Outbound, include_paid, cutoff))
        .order_by(Outbound.date.desc(), Outbound.id.desc())
    )
    if include_paid:
        ob_q = ob_q.limit(SETTLED_LIST_LIMIT)
    ob_rows = list(db.execute(ob_q).scalars())
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
            # 应收 = 实收（销售收入 + 抹零/凑整调整 + 客户代收的包材/人工/快递费）
            r.total_amount + (getattr(r, "adjust_amount", 0.0) or 0.0)
            + (getattr(r, "settle_income", 0.0) or 0.0),
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

    # 代发应付**不进这张通用账单列表**：wh01 实测有 7000+ 张单，塞进来会把列表灌满、接口要 1.5 秒，
    # 浏览器还要拉几千行备注与图片。代发有专门的「代发」页签（/api/payables/dropship，
    # 按出库单列出每款规格「单价 × 单量 = 金额」），这里不再重复列。
    return rows


def _dropship_rows(db: Session, outbound_ids: list[int]) -> dict[int, list[DropshipBill]]:
    """按出库单分组取代发账单明细（SQLite 变量数有限，分批查询）。"""
    out: dict[int, list[DropshipBill]] = {}
    for i in range(0, len(outbound_ids), 400):
        part = outbound_ids[i:i + 400]
        for b in db.execute(select(DropshipBill).where(DropshipBill.outbound_id.in_(part))).scalars():
            out.setdefault(b.outbound_id, []).append(b)
    for bs in out.values():
        bs.sort(key=lambda x: (x.product_name or "", x.spec or "", x.id))
    return out


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
    status, paid_at = _mark_paid(db, kind, data.id, bool(data.paid))
    db.commit()
    return {
        "ok": True,
        "kind": kind,
        "id": data.id,
        "source": SOURCE_NAME.get(kind, kind),
        "pay_status": status,
        "paid_at": paid_at,
    }


@router.post("/payables/pay-batch")
def pay_bills_batch(data: PayBatchIn, db: Session = Depends(get_db), user: User = Depends(get_current_user)):
    """批量标记已支付/撤销（「代发」页签里勾选多张单一次结清）。

    ids 的含义随 kind：普通单据是自身 id；代发是**出库单 id**（整单的代发成本一起结清）。
    """
    kind = (data.kind or "").strip()
    ids = list(dict.fromkeys(int(i) for i in (data.ids or [])))
    if not ids:
        raise HTTPException(400, "请先勾选要处理的账单")
    updated, missing = 0, 0
    for rid in ids:
        try:
            _mark_paid(db, kind, rid, bool(data.paid))
            updated += 1
        except HTTPException as e:
            if e.status_code != 404:
                raise
            missing += 1
    db.commit()
    return {"ok": True, "kind": kind, "updated": updated, "missing": missing}


@router.get("/payables/dropship")
def list_dropship_bills(
    date_from: str = "",
    date_to: str = "",
    include_paid: int = 0,
    limit: int = 300,
    db: Session = Depends(get_db),
    user: User = Depends(get_current_user),
):
    """代发应付明细（「待付款账单 → 代发」页签）：按「商品 + 规格 + 单位」跨单合并。

    金额 = 代发成本（出库行 cogs = 成本单价 × 基础数量）。它本来就已计入该单结转成本，
    这里只做「付给代发方」的付款核对，所以不影响报表口径；付款状态独立于出库单
    （出库单的收付款状态是客户回款）。
    """
    q = select(DropshipBill)
    if date_from:
        q = q.where(DropshipBill.date >= date_from)
    if date_to:
        q = q.where(DropshipBill.date <= date_to)
    if not include_paid:
        q = q.where(func.coalesce(DropshipBill.pay_status, "unpaid") == "unpaid")
    bills = list(db.execute(q.order_by(DropshipBill.date.desc(), DropshipBill.id.desc())).scalars())

    groups: dict[tuple, dict] = {}
    for b in bills:
        spec = (b.spec or "").strip()
        unit = (b.unit or "").strip()
        g = groups.setdefault((b.product_id, spec, unit), {
            "product_id": b.product_id,
            "product_name": b.product_name or "",
            "spec": spec,
            "unit": unit,
            "base_unit": b.base_unit or "",
            "quantity": 0.0,
            "quantity_base": 0.0,
            "amount": 0.0,
            "order_ids": set(),
            "bill_ids": [],
            "dates": [],
            "sale_amount": 0.0,
            "sale_price": 0.0,
            "unit_cost": 0.0,
            "unpaid": 0,
            "paid_at": "",
            "operator": "",
        })
        g["quantity"] += b.quantity or 0.0
        g["quantity_base"] += b.quantity_base or 0.0
        g["amount"] = round(g["amount"] + (b.amount or 0.0), 2)
        g["sale_amount"] = round(g["sale_amount"] + (b.sale_amount or 0.0), 2)
        g["order_ids"].add(b.outbound_id)
        g["bill_ids"].append(b.id)
        if b.date:
            g["dates"].append(b.date)
        if (b.pay_status or "unpaid") == "unpaid":
            g["unpaid"] += 1
        else:
            g["paid_at"] = max(g["paid_at"], b.paid_at or b.date or "")
        if not g["operator"]:
            g["operator"] = b.operator or ""
        if not g["unit_cost"]:
            g["unit_cost"] = round(b.unit_cost or 0.0, 6)
        if not g["sale_price"]:
            g["sale_price"] = round(b.sale_price or 0.0, 4)

    out: list[dict] = []
    for (pid, spec, unit), g in groups.items():
        qty = round(g["quantity"], 4)
        out.append({
            "product_id": pid,
            "product_name": g["product_name"],
            "spec": spec,
            "unit": unit,
            "base_unit": g["base_unit"],
            "quantity": qty,
            "quantity_base": round(g["quantity_base"], 4),
            "unit_price": _unit_price_of(g["amount"], qty),   # 成本单价（按下单单位）= 代发成本 ÷ 单量
            "unit_cost": g["unit_cost"],
            "sale_price": g["sale_price"],
            "sale_amount": g["sale_amount"],
            "amount": g["amount"],        # 应付 = 代发成本
            "order_count": len(g["order_ids"]),
            "order_ids": sorted(g["order_ids"]),
            "bill_ids": g["bill_ids"],
            "date_from": min(g["dates"]) if g["dates"] else "",
            "date_to": max(g["dates"]) if g["dates"] else "",
            "pay_status": "unpaid" if g["unpaid"] else "paid",
            "unpaid_count": g["unpaid"],
            "paid_at": g["paid_at"],
            "operator": g["operator"],
        })
    out.sort(key=lambda x: (x["pay_status"] != "unpaid", -x["amount"]))
    pend = [x for x in out if x["pay_status"] == "unpaid"]
    # 合计按全部算（不受下面截断影响），但列表只回最近 limit 行：
    # wh01 实测 7790 行（每行还带规格明细），前端渲染上万行会很卡；截断后上面会提示「仅列最近 N 行」。
    shown = out[: max(1, min(int(limit or 0) or 300, 2000))]
    return {
        "groups": shown,
        "truncated": len(out) > len(shown),
        "limit": len(shown),
        "total": {
            "groups": len(out),
            "orders": sum(x["order_count"] for x in out),
            "quantity": round(sum(x["quantity"] for x in out), 4),
            "amount": round(sum(x["amount"] for x in out), 2),
            "pending_groups": len(pend),
            "pending_amount": round(sum(x["amount"] for x in pend), 2),
            "paid_amount": round(sum(x["amount"] for x in out if x["pay_status"] != "unpaid"), 2),
        },
    }


def _mark_paid(db: Session, kind: str, rid: int, paid: bool) -> tuple[str, str]:
    """把一张账单标记为已支付/撤销，返回 (pay_status, paid_at)。

    代发（dropship）按出库单批量更新它名下的规格明细；其余 kind 更新单据自身，
    入库/出库还要把自动生成的财务流水与其他开支（金额调整 / 运费装卸）一起跟着走。
    """
    status = "paid" if paid else "unpaid"
    paid_at = _date.today().isoformat() if paid else ""
    if kind == DROPSHIP_ITEM_KIND:
        # 代发页签：按「商品+规格」合并后的行结算，ids 是账单行 id（可能跨多张出库单）
        bill = db.get(DropshipBill, rid)
        if not bill:
            raise HTTPException(404, "账单不存在")
        bill.pay_status, bill.paid_at = status, paid_at
        return status, paid_at
    if kind == DROPSHIP_KIND:
        bills = list(db.execute(select(DropshipBill).where(DropshipBill.outbound_id == rid)).scalars())
        if not bills:
            raise HTTPException(404, "账单不存在")
        for b in bills:
            b.pay_status, b.paid_at = status, paid_at
        return status, paid_at
    model = MODEL_OF.get(kind)
    if not model:
        raise HTTPException(400, "未知的账单类型")
    rec = db.get(model, rid)
    if not rec:
        raise HTTPException(404, "账单不存在")
    rec.pay_status, rec.paid_at = status, paid_at
    # 入库/出库会自动生成财务流水（采购支出 / 销售收入 / 人工打包费），状态要跟着走
    if kind in ("inbound", "outbound"):
        for f in db.execute(
            select(FinanceRecord).where(FinanceRecord.ref_type == kind, FinanceRecord.ref_id == rec.id)
        ).scalars():
            f.pay_status, f.paid_at = rec.pay_status, rec.paid_at
        # 单据带出的其他开支同样随主单结算：金额调整(ref_type=kind) + 入库运费/装卸镜像行
        exp_types = [kind] + (["inbound_fee"] if kind == "inbound" else [])
        for e in db.execute(
            select(OtherExpense).where(OtherExpense.ref_type.in_(exp_types), OtherExpense.ref_id == rec.id)
        ).scalars():
            e.pay_status, e.paid_at = rec.pay_status, rec.paid_at
    return status, paid_at
