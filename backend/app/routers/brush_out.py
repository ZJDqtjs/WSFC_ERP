"""刷单出库：把「放单仓刷单」的聚水潭销售出库单按刷单口径入账，并在推错仓时先回冲。

背景（用户口径）：
    刷单的订单在聚水潭里本应挂在放单仓（brush.BRUSH_WAREHOUSES，如「芳谊放单仓」），
    但偶尔会被推到「自持干货打单仓」这类正常仓 —— 自动出库就把它们当正常订单出了库
    （扣库存、结转商品成本、记销售收入）。发现后要用「刷单出库」按刷单口径重新入账。

判定与处理（每个出库单号单独判定）：
    1) 仓储方本身就是放单仓 → 与「导入聚水潭出库单」完全一致，直接按刷单口径建单
       （见 services.build_order(brush=True)：不扣库存、不耗包材、商品成本 0，
        成本只算 brush_cost + brush_fee）；
    2) 仓储方是别的仓 → 若系统里能查到同单号、还没按刷单口径入账的出库单（自动出库误建的正常单），
       先「回冲」：删除原出库单（主单/明细/库存流水/财务流水一并删除，库存因此自动恢复），
       同时在「盘点记录」里为每个商品留一条回冲明细（数量 0 的留痕流水，备注写明
       单号 / 商品 / 回冲数量 / 原出库单号），最后再按刷单口径建单。
       收入只保留刷单单这一份，原单的收入/成本随删单一起消失。

为什么盘点留痕是 0 数量：
    删除原出库单时，它的库存流出流水被删除，库存数量与 FIFO 成本已经精确回滚；
    若再写一条真实盘盈，库存会被加两次。所以这里只写「留痕」流水（数量/金额都是 0），
    让盘点记录里有据可查，同时不动任何账。
"""
from datetime import datetime

from fastapi import APIRouter, Depends, HTTPException, UploadFile
from sqlalchemy import or_, select
from sqlalchemy.orm import Session, selectinload

from ..auth import get_current_user
from ..brush import BRUSH_WAREHOUSES, DEFAULT_BRUSH_FEE, is_brush_warehouse
from ..database import get_db
from ..models import Outbound, Product, StockMovement, User
from ..services import purge_outbounds
from .imports import ConfirmOutIn, _confirm_orders, _log_manual_jst_import, parse_jushuitan_draft

router = APIRouter(prefix="/api/brush-out", tags=["brush-out"])


def _brush_warehouse() -> str:
    """刷单出库统一入账用的放单仓名（brush.BRUSH_WAREHOUSES 的第一个）。"""
    if not BRUSH_WAREHOUSES:
        raise HTTPException(500, "没有配置放单仓（backend/app/brush.py 的 BRUSH_WAREHOUSES）")
    return BRUSH_WAREHOUSES[0]


def _find_existing(db: Session, doc_no: str) -> list[Outbound]:
    """找出该聚水潭出库单号在系统里已经建过的出库单（自动出库误建的正常单）。

    出库单没有单独存聚水潭单号，只能按备注匹配：导入时备注固定写成
    「聚水潭导入 单{出库单号} 快递…」，故按 "单{no} " / "单{no}（" 精确到编号边界。
    已是刷单口径（brush_cost / brush_fee 非 0）的单不再算需要回冲。
    """
    no = str(doc_no or "").strip()
    if not no:
        return []
    rows = db.execute(
        select(Outbound)
        .options(selectinload(Outbound.lines))
        .where(
            Outbound.is_return.is_(False),
            or_(
                Outbound.remark.like(f"%单{no} %"),
                Outbound.remark.like(f"%单{no}（"),
            ),
        )
        .order_by(Outbound.id)
    ).scalars()
    return [
        o for o in rows
        if not (float(o.brush_cost or 0) or float(o.brush_fee or 0))
    ]


def _return_codes(db: Session, ids: list[int]) -> list[str]:
    """这些出库单下面挂着的退货单号（有退货单就不能直接删原单，否则库存会重复计）。"""
    if not ids:
        return []
    return [c for c in db.execute(
        select(Outbound.code).where(Outbound.return_of_id.in_(ids))
    ).scalars() if c]


def _revert_summary(o: Outbound) -> dict:
    """回冲预览用：原出库单的可读摘要（单号/金额/商品明细）。"""
    lines = []
    for l in o.lines:
        if l.line_type != "sale":
            continue
        p = l.product
        unit = (p.default_unit or p.base_unit) if p else l.unit
        conv = (p.conversions or {}) if p else {}
        f = conv.get(unit, 1) or 1
        lines.append({
            "product_id": l.product_id,
            "product_name": p.name if p else "",
            "unit": unit,
            "quantity": round((l.quantity_base or 0) / f, 4),
            "cogs": round(l.cogs or 0, 2),
        })
    return {
        "id": o.id,
        "code": o.code,
        "date": o.date,
        "total_amount": round(o.total_amount or 0, 2),
        "total_cogs": round(o.total_cogs or 0, 2),
        "lines": lines,
    }


def _revert_marks_snapshot(orig: Outbound) -> list[dict]:
    """删单前把「要留痕的商品明细」快照下来（删单后明细行就没了）。"""
    out = []
    for l in orig.lines:
        if l.line_type != "sale":
            continue
        p = l.product
        if not p:
            continue
        du = p.default_unit or p.base_unit
        f = (p.conversions or {}).get(du, 1) or 1
        out.append({
            "product_id": p.id,
            "product_name": p.name,
            "unit": du,
            "quantity": round((l.quantity_base or 0) / f, 4),
            "code": orig.code,
        })
    return out


def _write_revert_marks(db: Session, marks: list[dict], doc_no: str, operator: str, today: str) -> int:
    """在「盘点记录」里为原出库单的每个销售商品留一条回冲明细（数量/金额都为 0 的留痕）。

    每个商品单独成组（盘点记录按 ref_id 分组、每组只展示一个商品），返回写入条数。
    """
    for mk in marks:
        m = StockMovement(
            product_id=mk["product_id"],
            move_type="adjust",
            quantity_base=0.0,   # 留痕，不改库存（删单已回滚）
            amount=0.0,
            ref_type="manual",
            date=today,
            operator=operator,
            remark=(
                f"盘点调整：刷单出库回冲 · 单{doc_no} · {mk['product_name']} "
                f"{mk['quantity']:g}{mk['unit']}（原出库单 {mk['code']} 已删除，库存随删单回滚）"
            )[:255],
        )
        db.add(m)
        db.flush()      # 取 id 做分组
        m.ref_id = m.id
    return len(marks)


@router.post("/preview")
def preview_brush_out(
    file: UploadFile,
    db: Session = Depends(get_db),
    user: User = Depends(get_current_user),
):
    """解析聚水潭销售出库单 → 刷单草稿。

    - 商品按文件里**原始仓储方**匹配（这样误推成「自持干货打单仓」的单也能找到对应商品）；
    - 草稿的 warehouse 统一改写成放单仓，确认时 create_outbound 才会走刷单口径
      （不扣库存、成本 = 刷单成本 + 快递+包装固定费）；
    - 仓储方不是放单仓、且系统里已有同单号出库单的，列入 revert（确认时先回冲）。
    """
    drafts, failed, skip, unmapped, unmapped_list, unmatched_multi = parse_jushuitan_draft(file, db, user)
    target = _brush_warehouse()

    revert: list[dict] = []
    origin: dict[str, str] = {}
    fee_default = round(float(DEFAULT_BRUSH_FEE), 2)
    for d in drafts:
        origin[d.doc_no] = d.warehouse or ""
        # 仓储方本身就是放单仓 → 正常刷单流程，不需要回冲
        if not is_brush_warehouse(d.warehouse):
            for o in _find_existing(db, d.doc_no):
                revert.append({**_revert_summary(o), "doc_no": d.doc_no})
        d.warehouse = target          # 统一按放单仓入账（刷单口径）
        d.brush_fee_auto = fee_default
    rets = _return_codes(db, [r["id"] for r in revert])
    for r in revert:
        r["has_return"] = bool(rets)

    return {
        "orders": [d.model_dump() for d in drafts],
        "skip": skip, "failed": failed, "failed_count": len(failed),
        "notices": [f for f in failed if f.get("level") == "warn"],
        "unmapped_codes": sorted(unmapped),
        "unmapped": unmapped_list,
        "unmatched_multi": unmatched_multi,
        # 放单仓名单与默认固定费（前端复用聚水潭的逐单刷单结算表）
        "brush_warehouses": sorted({target}),
        "brush_warehouse_names": list(BRUSH_WAREHOUSES),
        "brush_default_fee": fee_default,
        # 需要先回冲的已入账出库单（仓储方推错仓时才会有）
        "revert": revert,
        "origin_warehouse": origin,
    }


@router.post("/confirm")
def confirm_brush_out(
    data: ConfirmOutIn,
    db: Session = Depends(get_db),
    user: User = Depends(get_current_user),
):
    """确认刷单出库：先把误建的原出库单回冲（删单 + 盘点留痕），再按刷单口径建单。"""
    target = _brush_warehouse()
    if not data.orders:
        raise HTTPException(400, "没有可出库的单据")

    today = datetime.now().strftime("%Y-%m-%d")
    purge_ids: list[int] = []
    plans: list[tuple[int, str, list[dict]]] = []   # (原单id, 出库单号, 留痕快照)
    revert_done: list[dict] = []
    for o in data.orders:
        for old in _find_existing(db, o.doc_no):
            if old.id in purge_ids:
                continue
            purge_ids.append(old.id)
            plans.append((old.id, o.doc_no, _revert_marks_snapshot(old)))
            revert_done.append({**_revert_summary(old), "doc_no": o.doc_no})

    if purge_ids:
        rets = _return_codes(db, purge_ids)
        if rets:
            raise HTTPException(
                400,
                f"原出库单还挂着退货单（{('、'.join(rets))}），请先在出库记录里删掉这些退货单，再做刷单出库",
            )
        # 1) 回冲：删除原出库单（库存流水/财务/其他收支/代发账单随之删除，库存精确回滚）
        deleted, missing, _affected = purge_outbounds(db, purge_ids)
        db.flush()
        # 2) 盘点记录里留回冲明细（数量 0，不改账，只做可追溯的痕迹）
        for _oid, doc_no, marks in plans:
            _write_revert_marks(db, marks, doc_no, user.name, today)
        # 回冲先单独提交：一是删单后 session 里的旧对象不影响随后重建（避免 id 复用撞 identity map），
        # 二是万一随后建单失败，回冲也已生效，重跑本流程即可（此时不再有 revert）。
        db.commit()
        revert_note = (f"回冲 {deleted} 单" if deleted == len(purge_ids)
                       else f"回冲 {deleted} 单（{missing} 单已不存在）")
    else:
        revert_note = ""

    # 3) 按刷单口径建单：仓储方强制为放单仓，固定费没填就带默认值
    for o in data.orders:
        o.warehouse = target
        if not float(o.brush_fee or 0):
            o.brush_fee = round(float(DEFAULT_BRUSH_FEE), 2)

    res = _confirm_orders(db, user, data.orders)
    note = "由「出库/销售 → 刷单出库」确认"
    if revert_note:
        note += f"，{revert_note}（原单库存已回滚，盘点记录已留回冲明细）"
    _log_manual_jst_import((data.source or "").strip(), res, orders=data.orders, note=note)

    res["revert"] = revert_done
    if revert_note:
        res["revert_note"] = revert_note
    return res
