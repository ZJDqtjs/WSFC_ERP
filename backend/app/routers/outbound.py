import re

from fastapi import APIRouter, Depends, HTTPException
from pydantic import BaseModel, Field
from sqlalchemy import select
from sqlalchemy.orm import Session, selectinload

from ..auth import get_current_user
from ..brush import brush_adjust, brush_fee_of
from ..database import get_db
from ..models import DropshipBill, FinanceRecord, OtherExpense, Outbound, OutboundLine, Product, StockMovement, User
from ..services import (
    build_order,
    create_outbound,
    normalize_settle_cats,
    pack_settle_cat,
    pay_fields,
    purge_outbounds,
    recompute_product,
    sync_doc_edit,
    sync_settle_income_record,
)

router = APIRouter(prefix="/api/outbounds", tags=["outbound"])

DATE_RE = re.compile(r"^\d{4}-\d{2}-\d{2}$")


class SaleLine(BaseModel):
    product_id: int
    unit: str
    quantity: float
    price: float = 0.0
    pack_fee: float | None = None


class PackLine(BaseModel):
    product_id: int
    unit: str
    quantity: float
    # 显式指定这一项的成本（不填=按该商品先进先出成本算）。
    # AI 识别出的「运费」与结算表里的金额可能不等于按重量自动算的值，这里按识别金额记账。
    cogs: float | None = None


class PreviewIn(BaseModel):
    lines: list[SaleLine]
    auto_express: bool = True   # False = 不自动结算快递费（手动出库时删掉「快递费」行）
    # 手动挑选的关联出库物品（追加在自动带出的结算项后面）：让预览也按 FIFO 算它们的成本
    extra_pack_lines: list[PackLine] = Field(default=[])
    # 客户承担的关联结算类别（material 包材 / labor 人工 / express 快递费）：预览随之返回 settle_income
    settle_cats: list[str] | None = None


class OutboundIn(BaseModel):
    customer: str = ""
    operator: str = ""
    date: str
    remark: str = ""
    lines: list[SaleLine]
    pack_lines: list[PackLine] = Field(default=[])
    pack_fee_total: float | None = None
    # False = 不自动结算快递费（手动出库时用户在预览里删掉了「快递费」行）；
    # 批量导入/聚水潭等不传，保持按整单毛重自动计快递费的原行为
    auto_express: bool = True
    pay_status: str = "paid"  # paid 已付款/已回款（默认）/ unpaid 待付款（先进「待付款账单」）
    # 金额调整（给客户抹零/凑整）：正=加收，负=抹零。商品成本不变，差额自动记「金额调整」其他开支
    adjust_amount: float = 0.0
    # 客户承担的关联结算类别（包材/人工/快递费）→ 计入实收金额；不传 = 默认客户不承担（到账只有货款）
    settle_cats: list[str] | None = None


class OutboundUpdate(BaseModel):
    """手动修改出库单：可改 客户 / 日期 / 付款状态 / 实收口径（其余字段须删除重建）。"""

    customer: str = ""
    date: str
    pay_status: str = "paid"
    # 改「实收含哪些关联结算」（包材/人工/快递费）：只影响实收金额与报表收入，不动成本
    settle_cats: list[str] | None = None


class BatchIds(BaseModel):
    ids: list[int]


def _to_dict(o: Outbound) -> dict:
    remark = o.remark or ""
    is_multi = "一单多货" in remark
    # 实收金额 = 销售收入 + 抹零/凑整 + 客户代收的关联结算（包材/人工/快递费）
    settle_income = round(float(getattr(o, "settle_income", 0.0) or 0.0), 2)
    # 工单刷单结算的额外扣减（非放单仓订单 adj=0）
    brush_final = round((o.total_amount or 0.0) + (getattr(o, "adjust_amount", 0.0) or 0.0) + settle_income, 2)
    adj = brush_adjust(o)
    multi_rule = o.pack_rule_name or ""
    if not multi_rule and "一单多货·规则：" in remark:
        multi_rule = remark.split("一单多货·规则：", 1)[1].split("）", 1)[0]
    # pack 行所属销售商品名：同单内 sale_product_id → sale 行 product_id
    sale_names = {l.product_id: (l.product.name if l.product else "") for l in o.lines if l.line_type == "sale"}
    return {
        "id": o.id,
        "code": o.code,
        "import_group": o.import_group,
        "pack_rule_id": o.pack_rule_id,
        "pack_rule_name": o.pack_rule_name,
        "customer": o.customer,
        "operator": o.operator,
        "date": o.date,
        "remark": o.remark,
        "is_multi": is_multi,
        "multi_rule": multi_rule,
        "total_amount": o.total_amount,
        "adjust_amount": round(getattr(o, "adjust_amount", 0.0) or 0.0, 2),
        # 客户代收的关联结算（包材/人工/快递费）与其类别：实收金额 = 销售收入 + 调整 + 这笔
        "settle_income": settle_income,
        "settle_cats": (getattr(o, "settle_cats", "") or ""),
        "final_amount": brush_final,
        "total_cogs": o.total_cogs,
        "total_fee": o.total_fee,
        "pay_status": getattr(o, "pay_status", "paid") or "paid",
        "paid_at": getattr(o, "paid_at", "") or "",
        # 毛利/净利按实收口径（total_amount + 抹零/凑整调整），与列表「收入」列自洽；
        # 芳谊放单仓的单子再扣掉「刷单结算」（刷单成本 + 固定费覆盖差，见 app/brush.py）
        "gross_profit": round(brush_final - o.total_cogs - adj, 2),
        "net_profit": round(brush_final - o.total_cogs - o.total_fee - adj, 2),
        # 刷单结算（非放单仓订单三列都是 0）：brush_cost=我刷这单的成本，
        # brush_fee=本单结算用的「快递+包装固定费」（= brush_auto_fee 时表示没覆盖），
        # settle_amount=这单结算给我多少（收入 − 固定费），brush_profit=结算 − 刷单成本
        "brush_cost": round(float(getattr(o, "brush_cost", 0.0) or 0.0), 2),
        "brush_fee": round(brush_fee_of(o), 2),
        "brush_auto_fee": round(float(getattr(o, "brush_auto_fee", 0.0) or 0.0), 2),
        "is_brush_order": bool(getattr(o, "brush_auto_fee", 0.0)),
        "brush_adjust": adj,
        "settle_amount": round(brush_final - brush_fee_of(o), 2),
        "brush_profit": round(brush_final - brush_fee_of(o) - float(getattr(o, "brush_cost", 0.0) or 0.0), 2),
        # 是否含代发行（订单商品未关联库存大类：不扣库存，只记代发数量/成本）
        "has_dropship": any(bool(getattr(l, "is_dropship", False)) for l in o.lines),
        "lines": [
            {
                "product_id": l.product_id,
                "product_name": l.product.name if l.product else "",
                "line_type": l.line_type,
                "sale_product_id": l.sale_product_id,
                "sale_product_name": sale_names.get(l.sale_product_id, ""),
                "spec": l.spec or "",
                "is_dropship": bool(getattr(l, "is_dropship", False)),
                "unit": l.unit,
                "quantity": l.quantity,
                "quantity_base": l.quantity_base,
                "unit_price": l.unit_price,
                "amount": l.amount,
                "cogs": l.cogs,
                "gross_sales": l.gross_sales or 0,
                "pack_fee": l.pack_fee,
                "category": l.product.category if l.product else "",
                "is_labor": bool(l.product and (l.product.category == "人工" or (l.product.name or "").strip().endswith("打包"))),
            }
            for l in o.lines
        ],
    }


@router.post("/preview")
def preview(data: PreviewIn, db: Session = Depends(get_db), user: User = Depends(get_current_user)):
    try:
        # 手动出库：销售行直接选「库存商品（大类）」时扣它自己的库存（导入路径才需要报错，见 build_order）
        # extra_pack_lines = 手动挑选的关联出库物品（追加到自动带出的后面）
        # settle_cats = 客户承担的关联结算类别 → 返回 settle_income，前端实收金额直接用服务端的数
        return build_order(db, data.lines, [], None, data.auto_express,
                           allow_self_stock=True, extra_pack_lines=data.extra_pack_lines,
                           settle_cats=data.settle_cats)
    except ValueError as e:
        raise HTTPException(400, str(e))


@router.get("")
def list_outbounds(date_from: str = "", date_to: str = "", g: str = "", db: Session = Depends(get_db), user: User = Depends(get_current_user)):
    # _to_dict 遍历 o.lines 与 l.product，selectinload 一次性预载避免 N+1
    q = select(Outbound).options(selectinload(Outbound.lines).selectinload(OutboundLine.product)).order_by(Outbound.id.desc())
    if date_from:
        q = q.where(Outbound.date >= date_from)
    if date_to:
        q = q.where(Outbound.date <= date_to)
    if g:
        q = q.where(Outbound.import_group.in_([x for x in g.split(",") if x]))
    return [_to_dict(o) for o in db.execute(q).scalars()]


@router.post("")
def create_outbound_api(data: OutboundIn, db: Session = Depends(get_db), user: User = Depends(get_current_user)):
    try:
        # 操作员固定为当前登录账号：忽略前端传入的 operator，避免被改成别人
        # 手动出库允许直接选库存大类（扣它自己的库存）
        rec, warnings = create_outbound(db, {**data.model_dump(), "operator": user.name},
                                       operator=user.name, allow_self_stock=True)
    except ValueError as e:
        raise HTTPException(400, str(e))
    db.commit()
    db.refresh(rec)
    return {"order": _to_dict(rec), "warnings": warnings}


@router.put("/{oid}")
def update_outbound(oid: int, data: OutboundUpdate, db: Session = Depends(get_db), user: User = Depends(get_current_user)):
    """手动修改出库单：只允许改 客户 / 日期 / 付款状态；操作员记为本次修改人。"""
    rec = db.get(Outbound, oid)
    if not rec:
        raise HTTPException(404, "出库单不存在")
    date = (data.date or "").strip()
    if not DATE_RE.match(date):
        raise HTTPException(400, "日期格式应为 YYYY-MM-DD")
    pay = pay_fields({"pay_status": data.pay_status, "paid_at": ""}, date)
    rec.customer = (data.customer or "").strip()
    rec.date = date
    rec.operator = user.name   # 记录为后来的修改人（忽略前端传值）
    rec.pay_status, rec.paid_at = pay["pay_status"], pay["paid_at"]
    # 「实收含哪些关联结算」可改：只动实收/报表收入口径，成本与库存不变，按单据现有结算行重算
    if data.settle_cats is not None:
        cats = normalize_settle_cats(data.settle_cats)
        rec.settle_cats = ",".join(cats)
        amount = sum(
            float(l.cogs or 0.0) for l in rec.lines
            if l.line_type == "pack" and pack_settle_cat(
                l.product.category if l.product else "", l.product.name if l.product else ""
            ) in cats
        )
        if "fee" in cats:   # 固定成本（工时/胶带这类按金额记的）也由客户承担
            amount += float(rec.total_fee or 0.0)
        rec.settle_income = round(amount, 2)
        sync_settle_income_record(db, rec, date, user.name, pay)   # 代收流水跟着改（0 则删掉）
    sync_doc_edit(db, "outbound", oid, date, user.name, pay)
    db.commit()
    db.refresh(rec)
    return _to_dict(rec)


@router.delete("/{oid}")
def delete_outbound(oid: int, db: Session = Depends(get_db), user: User = Depends(get_current_user)):
    rec = db.get(Outbound, oid)
    if not rec:
        raise HTTPException(404, "出库单不存在")
    affected = set()
    for l in rec.lines:
        affected.add(l.product_id)
    for m in db.execute(select(StockMovement).where(StockMovement.ref_type == "outbound", StockMovement.ref_id == oid)).scalars():
        affected.add(m.product_id)  # 库存流水实际扣在哪个商品（含库存大类/包材/人工）就重算哪个
        db.delete(m)
    for f in db.execute(select(FinanceRecord).where(FinanceRecord.ref_type == "outbound", FinanceRecord.ref_id == oid)).scalars():
        db.delete(f)
    # 金额调整带出的其他开支一并删除，避免删单后报表还挂着这笔调整
    for e in db.execute(select(OtherExpense).where(OtherExpense.ref_type == "outbound", OtherExpense.ref_id == oid)).scalars():
        db.delete(e)
    # 代发商品带出的应付账单一并删除
    for b in db.execute(select(DropshipBill).where(DropshipBill.outbound_id == oid)).scalars():
        db.delete(b)
    db.delete(rec)
    for pid in affected:
        recompute_product(db, pid)
    db.commit()
    return {"ok": True}


@router.post("/batch-delete")
def batch_delete_outbounds(data: BatchIds, db: Session = Depends(get_db), user: User = Depends(get_current_user)):
    deleted, missing, _affected = purge_outbounds(db, data.ids)
    db.commit()
    return {"ok": True, "deleted": deleted, "missing": missing}
