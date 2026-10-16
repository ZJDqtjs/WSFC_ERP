"""芳谊放单仓「刷单结算」口径（PC / 移动端 / 报表共用同一处定义）。

业务口径（用户定义）：
    结算价 = 出库收入（已扣店铺扣点） − 快递+包装固定费
    利润   = 结算价 − 刷单成本（导入聚水潭出库单、确认时我手动填的那笔钱）

刷单单**不出货、不耗包材**，所以出库单里不结转任何库存与成本（见 services.build_order(brush=True)）：
- 不生成 包材 / 打包人工 / 快递费 这些关联结算行，也不产生库存流水；
- 商品成本按 0 计（刷单的货不走本仓库存），于是出库单的 total_cogs = 0、total_fee = 0。

该单的全部成本就是确认框里那两项：
- 「快递+包装固定费」= brush_fee（我手填，如 3.6 元/单；确认框默认带上次填过的值）；
- 「刷单成本」   = brush_cost（我刷这单花掉的钱）。

于是「该单应从利润里额外扣掉的金额」恒为：
    brush_adjust = brush_cost + brush_fee − brush_auto_fee(=0)
                 = 快递+包装固定费 + 刷单成本
即净利 = 出库收入 − brush_adjust = 结算价 − 刷单成本。
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
