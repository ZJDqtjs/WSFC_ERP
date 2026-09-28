"""芳谊放单仓「刷单结算」口径（PC / 移动端 / 报表共用同一处定义）。

业务口径（用户定义）：
    结算价 = 出库收入（已扣店铺扣点） − 快递+包装固定费
    利润   = 结算价 − 刷单成本（导入聚水潭出库单、确认时我手动填的那笔钱）

- 「快递+包装固定费」默认取系统出库时自动结算的 快递费(按重量) + 包材 + 人工（= build_order 的 pack 成本 + 打包费），
  允许在导入确认框里手填覆盖（如按 4.1 元/单 固定）。
- 覆盖只影响这一单的「结算价/利润」口径：出库单里的快递/包材明细仍按系统原值记录，
  差额靠 brush_auto_fee（系统自动值快照）还原。

于是「该单应从利润里额外扣掉的金额」恒为：
    brush_adjust = brush_cost + (brush_fee or brush_auto_fee) − brush_auto_fee
即：没覆盖固定费时就是刷单成本；覆盖后按用户填的固定费算。
非放单仓订单（三列都是 0）brush_adjust = 0，所有既有口径不变。
"""


# 需要刷单成本核算的「仓储方」（聚水潭出库单里的「仓储方」列）。新增放单仓在这里追加即可。
BRUSH_WAREHOUSES = ("芳谊放单仓",)


def is_brush_warehouse(name: str | None) -> bool:
    """该仓储方是否属于「放单仓」（需要按单填刷单成本）。"""
    return str(name or "").strip() in BRUSH_WAREHOUSES


def brush_fee_of(o) -> float:
    """该单结算用的「快递+包装固定费」：用户填了 brush_fee 就用它，否则用系统自动值。"""
    fee = float(getattr(o, "brush_fee", 0) or 0)
    return fee if fee > 0 else float(getattr(o, "brush_auto_fee", 0) or 0)


def brush_adjust(o) -> float:
    """该单因刷单结算应从利润里额外扣掉的金额 = 刷单成本 + 固定费覆盖差（非放单单为 0）。"""
    cost = float(getattr(o, "brush_cost", 0) or 0)
    fee = float(getattr(o, "brush_fee", 0) or 0)
    if not cost and not fee:
        return 0.0
    return round(cost + brush_fee_of(o) - float(getattr(o, "brush_auto_fee", 0) or 0), 2)


def brush_adjust_sql(model):
    """brush_adjust 的 SQL 版本（报表聚合用，逐单累加）。

    NULLIF(brush_fee, 0)：brush_fee=0 表示没覆盖 → NULL → 差额记 0，不退不补。
    """
    from sqlalchemy import func

    cost = func.coalesce(model.brush_cost, 0.0)
    fee = func.coalesce(model.brush_fee, 0.0)
    auto = func.coalesce(model.brush_auto_fee, 0.0)
    return cost + func.coalesce(func.nullif(fee, 0.0) - auto, 0.0)
