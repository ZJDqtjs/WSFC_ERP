"""核心业务逻辑：单位换算、加权平均成本、库存/成本重算、入库/出库创建。"""
import json
import math
import os

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


def _deduct_with_override(db: Session, order_product: Product, qty_base_in_order: float,
                          stock_product_id: int | None, multiplier: float = 1.0) -> tuple[Product, float]:
    """计算一次出库的扣减目标库存商品与扣减数量。

    一单多货规则若显式指定了关联库存商品（大类）与倍数，则优先按其扣减；
    否则回退为按订单商品自身关联扣减（stock_deduction）。
    扣减数 = 订单基础数量 × 倍数 × 库存商品默认单位系数。
    """
    if stock_product_id:
        sp = db.get(Product, stock_product_id)
        if sp and sp.product_type == "stock":
            du = sp.default_unit or sp.base_unit
            factor = (sp.conversions or {}).get(du, 1.0)
            return sp, qty_base_in_order * float(multiplier or 1.0) * float(factor)
    return stock_deduction(db, order_product, qty_base_in_order)


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


# ---------------- 快递费（多段计费，规则页可实时维护） ----------------
EXPRESS_CONFIG_FILE = os.path.join(os.path.dirname(__file__), "..", "..", "json", "express_config.json")
EXPRESS_BOX_WEIGHT_KG = 0.1      # 每个包裹在净重基础上统一加 0.1kg 箱重
DEFAULT_EXPRESS_CONFIG = {
    "mode": "tiered",   # tiered=首重+续重（1kg内首重价，每超1kg加收）；flat=每kg单价
    "first_kg_fee": 3.6,   # 1kg 以内
    "per_extra_kg": 1.0,   # 每超 1kg 加收
    "rate_per_kg": 3.6,    # flat 模式：每 1kg 单价
    "round_up": True,      # 是否按整 kg 向上取整（续重按 ≥1kg 段计）
}


def load_express_config() -> dict:
    """读取快递费计费配置。文件缺失/异常时回退默认。"""
    cfg = dict(DEFAULT_EXPRESS_CONFIG)
    try:
        with open(EXPRESS_CONFIG_FILE, encoding="utf-8") as f:
            data = json.load(f)
            for k in cfg:
                if k in data:
                    cfg[k] = data[k]
    except Exception:
        pass
    return cfg


def save_express_config(cfg: dict) -> dict:
    """保存快递费计费配置到文件（实时生效）。"""
    merged = dict(DEFAULT_EXPRESS_CONFIG)
    if cfg and isinstance(cfg, dict):
        merged.update(cfg)
    os.makedirs(os.path.dirname(EXPRESS_CONFIG_FILE), exist_ok=True)
    with open(EXPRESS_CONFIG_FILE, "w", encoding="utf-8") as f:
        json.dump(merged, f, ensure_ascii=False, indent=2)
    return merged


def compute_express_fee(weight_kg: float, cfg: dict | None = None) -> float:
    """快递费。
    - tiered：1kg 内收 first_kg_fee；每超 1kg 加收 per_extra_kg（round_up 时按整 kg 向上取整）。
    - flat：weight × rate_per_kg。
    """
    if cfg is None:
        cfg = load_express_config()
    w = max(0.0, float(weight_kg))
    if cfg.get("mode") == "flat":
        return round(w * float(cfg.get("rate_per_kg") or 0.0), 2)
    over = max(0.0, w - 1.0)
    if cfg.get("round_up", True) and over > 0:
        over = float(math.ceil(over))
    return round(float(cfg.get("first_kg_fee") or 0.0) + over * float(cfg.get("per_extra_kg") or 0.0), 2)


def deduction_net_weight_kg(target: Product | None, deduction_base: float) -> float:
    """由扣减库存量推导净重(kg)：重量类库存按其基础单位克数折算（如扣 1000 克 = 1kg）。"""
    if target and (target.base_unit or "") in ("克", "g") and deduction_base > 0:
        return round(float(deduction_base) / 1000.0, 4)
    return 0.0


def line_weight_kg(product: Product, quantity_base: float) -> float:
    """某销售行折成「默认单位」后的净重(kg)。weight_kg 为每 默认单位 的净重(kg)。
    仅用于基础单位非克（计数类）且未关联重量的兜底。"""
    w = float(product.weight_kg or 0)
    if w <= 0:
        return 0.0
    ref_unit = product.default_unit or product.base_unit
    factor = float((product.conversions or {}).get(ref_unit) or 1.0)
    if factor <= 0:
        factor = 1.0
    return round(quantity_base / factor * w, 4)


def get_or_create_express_product(db: Session) -> Product:
    """取已存在的「快递」分类商品作为快递费结算载体；没有则自动创建一个。"""
    p = db.scalar(select(Product).where(Product.category == "快递").order_by(Product.id).limit(1))
    if p:
        return p
    p = Product(
        name="快递费(自动)", category="快递", product_type="stock",
        base_unit="单", default_unit="单", is_active=True,
        conversions={"单": 1}, pack_items=[], pack_fee=0.0,
    )
    db.add(p)
    db.flush()
    return p


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
        if m.move_type == "cost":  # 成本重估：不改变库存，仅按当前库存总量调整价值与均价
            if stock > 0:
                value = max(value + (m.amount or 0.0), 0.0)
                avg = value / stock
            continue
        if m.move_type == "ucost":  # 成本单价(参考成本)调整：仅作记录，不影响库存/均价/库存价值
            continue
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
    # 人工 / 快递分类不记库存：工作量 = 全部流水绝对值之和（单），库存恒为 0
    if product.category in ("人工", "快递"):
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
    express_weight = 0.0  # 整单毛重(kg)，用于自动计算快递费

    for ln in lines:
        if hasattr(ln, "product_id"):  # Pydantic 对象
            pid, unit, quantity = ln.product_id, ln.unit, ln.quantity
            price = float(ln.price or 0)
            fee = ln.pack_fee
            spec = getattr(ln, "spec", "") or ""
            ov_sp = getattr(ln, "stock_product_id", None)
            ov_mult = getattr(ln, "multiplier", 1.0)
            gross = getattr(ln, "gross_sales", None)
        else:  # dict（批量导入）
            pid, unit, quantity = ln["product_id"], ln["unit"], ln["quantity"]
            price = float(ln.get("price", 0) or 0)
            fee = ln.get("pack_fee")
            spec = ln.get("spec", "") or ""
            ov_sp = ln.get("stock_product_id")
            ov_mult = ln.get("multiplier", 1.0)
            gross = ln.get("gross_sales")
        p = db.get(Product, pid)
        if not p:
            raise ValueError("商品不存在")
        if quantity <= 0:
            raise ValueError(f"「{p.name}」数量必须大于 0")
        qty_base = unit_to_base(p, unit, quantity)
        amount = round(quantity * price, 2)
        # 扣点前销售金额（原始金额）：导入扣点单传入；否则等于实际销售金额
        gross_sales = round(float(gross), 2) if gross and float(gross) > 0 else amount
        # 扣减目标：一单多货规则如指定库存大类则按其扣减；否则按订单商品关联的库存商品（大类），未关联则扣减自身
        target, deduction_base = _deduct_with_override(db, p, qty_base, ov_sp, ov_mult)
        # 订单/库存商品净重优先由「扣减库存量」推导（如 七彩花生2斤 → 扣 1kg 库存 → 净重 1kg）；
        # 计数类（未关联重量类库存）回退用商品的 weight_kg。
        line_net_kg = deduction_net_weight_kg(target, deduction_base)
        if line_net_kg <= 0:
            line_net_kg = line_weight_kg(p, qty_base)
        express_weight += line_net_kg
        cogs = round(deduction_base * (target.avg_cost or target.unit_cost), 2)
        if fee is None:
            fee = p.pack_fee
        sale_rows.append(
            {
                "product_id": p.id, "product_name": p.name, "base_unit": p.base_unit,
                "unit": unit, "quantity": quantity, "quantity_base": qty_base,
                "stock_product_id": target.id, "stock_product_name": target.name,
                "deduction_base": deduction_base,
                "unit_price": price, "amount": amount, "cogs": cogs, "pack_fee": fee, "gross_sales": gross_sales,
                "line_type": "sale", "spec": spec,
            }
        )
        total_amount += amount
        total_cogs += cogs

    pack_specs = list(pack_lines)
    if not pack_specs:
        agg: dict[tuple[int, int], dict] = {}
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
                d = agg.setdefault(
                    (pid, mid),
                    {"quantity": 0.0, "unit": item.get("unit", "个"), "sale_product_id": pid},
                )
                d["quantity"] += q
        pack_specs = [
            {
                "product_id": mid,
                "unit": d["unit"],
                "quantity": d["quantity"],
                "sale_product_id": d["sale_product_id"],
            }
            for (pid, mid), d in agg.items()
        ]

    for spec in pack_specs:
        m = db.get(Product, spec["product_id"])
        if not m:
            raise ValueError(f"关联商品ID {spec['product_id']} 不存在")
        qty_base = unit_to_base(m, spec["unit"], spec["quantity"])
        # 关联材料成本：优先用显式指定成本（人工行），否则库存平均成本，未入库时用参考成本
        if spec.get("cogs") is not None:
            cogs = round(float(spec["cogs"]), 2)
            unit_price = round(cogs / spec["quantity"], 4) if spec["quantity"] else 0.0
        else:
            cost = m.avg_cost if m.avg_cost else m.unit_cost
            cogs = round(qty_base * cost, 2)
            unit_price = cost
        pack_rows.append(
            {
                "product_id": m.id, "product_name": m.name, "base_unit": m.base_unit,
                "unit": spec["unit"], "quantity": spec["quantity"], "quantity_base": qty_base,
                "unit_price": unit_price, "amount": cogs, "cogs": cogs, "pack_fee": 0,
                "line_type": "pack",
                "sale_product_id": spec.get("sale_product_id"),
            }
        )
        total_cogs += cogs

    # 快递费自动结算：整单净重(商品净重累加) + 每单箱体 0.1kg，按「每kg快递费单价」计算，作为一项「快递」分类成本
    if express_weight > 0:
        total_weight = round(express_weight + EXPRESS_BOX_WEIGHT_KG, 3)
        express_fee = compute_express_fee(total_weight)
        if express_fee > 0:
            ep = get_or_create_express_product(db)
            pack_rows.append(
                {
                    "product_id": ep.id, "product_name": ep.name, "base_unit": ep.base_unit,
                    "unit": "单", "quantity": 1, "quantity_base": 1,
                    "unit_price": express_fee, "amount": express_fee, "cogs": express_fee,
                    "pack_fee": 0, "line_type": "pack", "sale_product_id": None,
                    "express_weight": total_weight,
                    "spec": f"{total_weight:.3f}kg",
                }
            )
            total_cogs += express_fee

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
        pack_rule_id=payload.get("pack_rule_id"),
        pack_rule_name=(payload.get("pack_rule_name") or "").strip(),
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
            # 人工 / 快递等服务类记为正向工作量（不扣库存）；包材等仍为负向包装消耗
            pack_p = db.get(Product, r["product_id"])
            is_service = bool(pack_p and pack_p.category in ("人工", "快递"))
            move_qty = r["quantity_base"] if is_service else -r["quantity_base"]
            move_type = "work" if is_service else "pack_out"
        db.add(
            OutboundLine(
                outbound_id=rec.id,
                product_id=r["product_id"],
                line_type=r["line_type"],
                sale_product_id=r.get("sale_product_id"),  # pack 行所属销售商品（组合统计用）
                spec=r.get("spec", ""),  # 销售行规格来源
                unit=r["unit"],
                quantity=r["quantity"],
                quantity_base=r["quantity_base"],
                unit_price=r["unit_price"],
                amount=r["amount"],
                cogs=r["cogs"],
                gross_sales=r.get("gross_sales", 0) or 0,
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
