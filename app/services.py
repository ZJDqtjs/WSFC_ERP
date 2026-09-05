"""核心业务逻辑：单位换算、加权平均成本、库存/成本重算、入库/出库创建。"""

from sqlalchemy import func, select
from sqlalchemy.orm import Session

from .models import FinanceRecord, Inbound, Outbound, OutboundLine, Product, StockMovement, Unit

# 标准重量单位（克 为基础）
STANDARD_WEIGHT_UNITS = [
    ("克", 1.0),
    ("斤", 500.0),
    ("公斤", 1000.0),
    ("千克", 1000.0),
]
STANDARD_COUNT_UNITS = ["个", "包", "袋", "盒", "箱", "件", "份"]

DEFAULT_CONVERSIONS_BASE_WEIGHT = {"克": 1, "斤": 500, "公斤": 1000, "千克": 1000}
DEFAULT_CONVERSIONS_BASE_COUNT = {"个": 1}


def seed_units(db: Session) -> None:
    if db.scalar(select(Unit).limit(1)):
        return
    for name, gram in STANDARD_WEIGHT_UNITS:
        db.add(Unit(name=name, category="weight", gram_per_unit=gram, is_standard=True))
    for name in STANDARD_COUNT_UNITS:
        db.add(Unit(name=name, category="count", gram_per_unit=None, is_standard=True))
    db.commit()


def unit_to_base(product: Product, unit: str, quantity: float) -> float:
    """把某商品在指定单位的数量折算成基础单位数量。"""
    conv = product.conversions or {}
    factor = conv.get(unit)
    if factor is None or factor <= 0:
        raise ValueError(f"商品「{product.name}」未配置单位「{unit}」的换算系数")
    return quantity * float(factor)


def stock_deduction(db: Session, order_product: Product, qty_base_in_order: float) -> tuple[Product, float]:
    """计算出库时实际扣减的库存商品与扣减数量（库存基础单位）。

    - 订单商品关联了库存商品：扣减库存商品，扣减数 = 订单基础数量 × 倍数 × 库存默认单位折算
    - 未关联：回退为扣减订单商品自身
    """
    if order_product.stock_product_id:
        sp = db.get(Product, order_product.stock_product_id)
        if sp:
            du = sp.default_unit or sp.base_unit
            factor = (sp.conversions or {}).get(du, 1.0)
            return sp, qty_base_in_order * (order_product.multiplier or 1.0) * float(factor)
    return order_product, qty_base_in_order


def base_to_unit(product: Product, unit: str, quantity_base: float) -> float:
    conv = product.conversions or {}
    factor = conv.get(unit)
    if factor is None or factor <= 0:
        raise ValueError(f"商品「{product.name}」未配置单位「{unit}」的换算系数")
    return quantity_base / float(factor)


def default_conversions(base_unit: str) -> dict:
    """按基础单位给出默认换算表（克→重量单位；个→计数单位）。"""
    if base_unit in ("克", "g"):
        return dict(DEFAULT_CONVERSIONS_BASE_WEIGHT)
    return dict(DEFAULT_CONVERSIONS_BASE_COUNT)


def recompute_product(db: Session, product_id: int) -> Product:
    """以库存流水为准重算商品的库存、加权平均成本、库存价值。

    入库行 amount 作为入库金额；出库/包装行按当前平均成本结转。
    """
    product = db.get(Product, product_id)
    db.flush()  # 确保本事务中新写入的流水在重算前可见
    moves = list(
        db.execute(
            select(StockMovement)
            .where(StockMovement.product_id == product_id)
            .order_by(StockMovement.id)
        ).scalars()
    )
    stock = 0.0
    value = 0.0
    avg = 0.0
    for m in moves:
        qty = m.quantity_base
        if qty >= 0:  # 入库 / 盘点增加
            new_stock = stock + qty
            amount = m.amount if m.amount else qty * avg
            if new_stock > 0:
                avg = (value + amount) / new_stock
            stock = new_stock
            value = value + amount
        else:  # 出库 / 包装消耗 / 盘点减少
            out = -qty
            cogs = out * avg
            stock = stock - out
            value = max(value - cogs, 0.0)
            m.amount = cogs
    product.stock = round(stock, 6)
    product.stock_value = round(value, 6)
    product.avg_cost = round(avg, 6)
    # 人工分类不记库存：工作量 = 全部流水绝对值之和（单），库存恒为 0
    if product.category == "人工":
        product.workload = round(sum(abs(m.quantity_base) for m in moves), 6)
        product.stock = 0.0
        product.stock_value = 0.0
    db.flush()
    return product


def fmt_qty(qty: float) -> str:
    """去掉多余小数。"""
    if abs(qty - round(qty)) < 1e-6:
        return str(int(round(qty)))
    return f"{qty:.4f}".rstrip("0").rstrip(".")


def resolve_product(db: Session, key: str) -> Product | None:
    """按商品编码或名称查找商品（导入用）。"""
    key = (key or "").strip()
    if not key:
        return None
    p = db.scalar(select(Product).where(Product.code == key))
    if p:
        return p
    return db.scalar(select(Product).where(Product.name == key))


def gen_inbound_code(db: Session, date: str) -> str:
    count = db.scalar(
        select(func.count()).select_from(Inbound).where(Inbound.code.like(f"RK{date}%"))
    )
    return f"RK{date}-{count + 1:03d}"


def gen_outbound_code(db: Session, date: str) -> str:
    count = db.scalar(
        select(func.count()).select_from(Outbound).where(Outbound.code.like(f"CK{date}%"))
    )
    return f"CK{date}-{count + 1:03d}"


def create_inbound(db: Session, payload: dict, operator: str = "") -> Inbound:
    """创建入库单（含库存流水 + 财务记录 + 成本重算）。"""
    product = db.get(Product, payload["product_id"])
    if not product:
        raise ValueError("商品不存在")
    quantity = float(payload["quantity"])
    if quantity <= 0:
        raise ValueError("数量必须大于 0")
    unit = payload["unit"]
    unit_price = float(payload["unit_price"])
    date = payload["date"]
    qty_base = unit_to_base(product, unit, quantity)
    amount = round(quantity * unit_price, 2)
    op = (payload.get("operator") or "").strip() or operator

    rec = Inbound(
        code=gen_inbound_code(db, date),
        product_id=product.id,
        unit=unit,
        quantity=quantity,
        quantity_base=qty_base,
        unit_price=unit_price,
        total_amount=amount,
        supplier=(payload.get("supplier") or "").strip(),
        operator=op,
        date=date,
        remark=(payload.get("remark") or "").strip(),
    )
    db.add(rec)
    db.flush()
    db.add(
        StockMovement(
            product_id=product.id,
            move_type="in",
            quantity_base=qty_base,
            amount=amount,
            ref_type="inbound",
            ref_id=rec.id,
            date=date,
            operator=op,
            remark=f"入库 {rec.code}",
        )
    )
    db.add(
        FinanceRecord(
            type="expense",
            category="采购支出",
            product_id=product.id,
            amount=amount,
            date=date,
            operator=op,
            remark=f"采购入库 {rec.code}",
            ref_type="inbound",
            ref_id=rec.id,
        )
    )
    recompute_product(db, product.id)
    db.flush()
    return rec


def build_order(db: Session, lines, pack_lines=None, fee_total=None) -> dict:
    """构建出库单明细：销售行 + 关联结算行(包装材料) + 费用，并校验库存。不落库。"""
    pack_lines = pack_lines or []
    sale_rows, pack_rows, warnings = [], [], []
    total_amount = total_cogs = 0.0

    for ln in lines:
        if hasattr(ln, "product_id"):  # Pydantic 对象
            pid, unit, quantity = ln.product_id, ln.unit, ln.quantity
            price = float(ln.price or 0)
            fee = ln.pack_fee
        else:  # dict（批量导入）
            pid, unit, quantity = ln["product_id"], ln["unit"], ln["quantity"]
            price = float(ln.get("price", 0) or 0)
            fee = ln.get("pack_fee")
        p = db.get(Product, pid)
        if not p:
            raise ValueError("商品不存在")
        if quantity <= 0:
            raise ValueError(f"「{p.name}」数量必须大于 0")
        qty_base = unit_to_base(p, unit, quantity)
        amount = round(quantity * price, 2)
        # 扣减目标：订单商品关联的库存商品（大类），未关联则扣减自身
        target, deduction_base = stock_deduction(db, p, qty_base)
        cogs = round(deduction_base * (target.avg_cost or target.unit_cost), 2)
        if fee is None:
            fee = p.pack_fee
        sale_rows.append(
            {
                "product_id": p.id, "product_name": p.name, "base_unit": p.base_unit,
                "unit": unit, "quantity": quantity, "quantity_base": qty_base,
                "stock_product_id": target.id, "stock_product_name": target.name,
                "deduction_base": deduction_base,
                "unit_price": price, "amount": amount, "cogs": cogs, "pack_fee": fee,
                "line_type": "sale",
            }
        )
        total_amount += amount
        total_cogs += cogs

    pack_specs = list(pack_lines)
    if not pack_specs:
        agg: dict[int, dict] = {}
        for ln in lines:
            if hasattr(ln, "product_id"):  # Pydantic 对象
                pid, quantity = ln.product_id, ln.quantity
            else:  # dict（批量导入）
                pid, quantity = ln["product_id"], ln["quantity"]
            p = db.get(Product, pid)
            if not p:
                continue
            for item in (p.pack_items or []):
                mid = item["product_id"]
                # 关联结算按「单」计：每销售 1 单消耗一次包材/人工。
                # 如 6单「佛手柑中果2个」→ 6个纸箱、6次人工；数量以销售行 quantity（单）为倍数。
                q = float(item.get("quantity", 1)) * float(quantity)
                d = agg.setdefault(mid, {"quantity": 0.0, "unit": item.get("unit", "个")})
                d["quantity"] += q
        pack_specs = [
            {"product_id": mid, "unit": d["unit"], "quantity": d["quantity"]}
            for mid, d in agg.items()
        ]

    for spec in pack_specs:
        m = db.get(Product, spec["product_id"])
        if not m:
            raise ValueError(f"关联商品ID {spec['product_id']} 不存在")
        qty_base = unit_to_base(m, spec["unit"], spec["quantity"])
        # 关联材料成本：优先用库存平均成本，未入库时用参考成本（如纸箱单价）
        cost = m.avg_cost if m.avg_cost else m.unit_cost
        cogs = round(qty_base * cost, 2)
        pack_rows.append(
            {
                "product_id": m.id, "product_name": m.name, "base_unit": m.base_unit,
                "unit": spec["unit"], "quantity": spec["quantity"], "quantity_base": qty_base,
                "unit_price": cost, "amount": cogs, "cogs": cogs, "pack_fee": 0,
                "line_type": "pack",
            }
        )
        total_cogs += cogs

    if fee_total is not None:
        total_fee = round(float(fee_total), 2)
    else:
        total_fee = round(sum(r["pack_fee"] for r in sale_rows), 2)

    # 库存预警（允许继续，仅提示；服务型商品如 人工/快递 不校验库存）
    for r in sale_rows + pack_rows:
        if r["line_type"] == "sale":
            pid, need = r["stock_product_id"], r["deduction_base"]
            label = f"{r['product_name']}（扣{fmt_qty(need)} {r['stock_product_name']}）"
        else:
            pid, need = r["product_id"], r["quantity_base"]
            label = r["product_name"]
        p = db.get(Product, pid)
        if not p or p.category in ("人工", "快递"):
            continue
        if need > p.stock + 1e-6:
            warnings.append(f"「{label}」库存不足：需 {fmt_qty(need)} {p.base_unit}，现有 {fmt_qty(p.stock)} {p.base_unit}")

    return {
        "sale_lines": sale_rows,
        "pack_lines": pack_rows,
        "total_amount": round(total_amount, 2),
        "total_cogs": round(total_cogs, 2),
        "total_fee": round(total_fee, 2),
        "gross_profit": round(total_amount - total_cogs, 2),
        "net_profit": round(total_amount - total_cogs - total_fee, 2),
        "warnings": warnings,
    }


def create_outbound(db: Session, payload: dict, operator: str = "", import_group: str = "") -> tuple[Outbound, list]:
    """创建出库/销售单（含明细、库存流水、财务记录、成本重算）。返回 (单, 预警)。
    import_group：批量导入批次号，空表示手动单条。
    """
    lines = payload["lines"]
    order = build_order(db, lines, payload.get("pack_lines"), payload.get("pack_fee_total"))
    op = (payload.get("operator") or "").strip() or operator
    date = payload["date"]
    rec = Outbound(
        code=gen_outbound_code(db, date),
        import_group=import_group,
        customer=(payload.get("customer") or "").strip(),
        operator=op,
        date=date,
        remark=(payload.get("remark") or "").strip(),
        total_amount=order["total_amount"],
        total_cogs=order["total_cogs"],
        total_fee=order["total_fee"],
    )
    db.add(rec)
    db.flush()

    affected = set()
    for r in order["sale_lines"] + order["pack_lines"]:
        is_sale = r["line_type"] == "sale"
        # 库存流水扣在库存商品上（订单商品扣减其关联大类）
        move_pid = r["stock_product_id"] if is_sale else r["product_id"]
        if is_sale:
            move_qty, move_type = -r["deduction_base"], "out"
        else:
            # 人工打包记为正工作量（不扣库存）；包材等仍为负向包装消耗
            pack_p = db.get(Product, r["product_id"])
            is_labor = bool(pack_p and pack_p.category == "人工")
            move_qty = r["quantity_base"] if is_labor else -r["quantity_base"]
            move_type = "work" if is_labor else "pack_out"
        db.add(
            OutboundLine(
                outbound_id=rec.id,
                product_id=r["product_id"],
                line_type=r["line_type"],
                unit=r["unit"],
                quantity=r["quantity"],
                quantity_base=r["quantity_base"],
                unit_price=r["unit_price"],
                amount=r["amount"],
                cogs=r["cogs"],
                pack_fee=r["pack_fee"],
            )
        )
        db.add(
            StockMovement(
                product_id=move_pid,
                move_type=move_type,
                quantity_base=move_qty,
                amount=r["cogs"],
                ref_type="outbound",
                ref_id=rec.id,
                date=date,
                operator=op,
                remark=f"{'销售' if is_sale else '包装消耗'} {rec.code}",
            )
        )
        affected.add(move_pid)
        affected.add(r["product_id"])
        if is_sale and r["amount"] > 0:
            db.add(
                FinanceRecord(
                    type="income", category="销售收入", product_id=r["product_id"],
                    amount=r["amount"], date=date, operator=op,
                    remark=f"销售 {rec.code}", ref_type="outbound", ref_id=rec.id,
                )
            )
    if order["total_fee"] > 0:
        db.add(
            FinanceRecord(
                type="expense", category="人工打包费", product_id=None,
                amount=order["total_fee"], date=date, operator=op,
                remark=f"打包费 {rec.code}", ref_type="outbound", ref_id=rec.id,
            )
        )
    for pid in affected:
        recompute_product(db, pid)
    db.flush()
    return rec, order["warnings"]
