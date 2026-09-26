"""核心业务逻辑：单位换算、先进先出(FIFO)成本、库存/成本重算、入库/出库创建。"""
import json
import math
import os
from collections import deque

from sqlalchemy import delete, func, select
from sqlalchemy.orm import Session

from .brush import is_brush_warehouse
from .models import FinanceRecord, Inbound, OtherExpense, Outbound, OutboundLine, Product, StockMovement, Unit

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


def stock_deductions(db: Session, order_product: Product, qty_base_in_order: float) -> list[tuple[Product, float]]:
    """计算出库时实际需扣减的库存商品清单 [(库存商品, 扣减数量(基础单位)), ...]（可为多个）。

    - 订单商品关联了 1~N 个库存商品（stock_links）：逐个扣减，扣减数 = 订单基础数量 × 倍数 × 库存默认单位折算；
    - 仅配置了旧的单关联字段（stock_product_id + multiplier）时按单关联扣减；
    - **订单商品无任何关联**：视为**代发**（别人代发，自己不出货），返回空列表，不扣任何库存，
      只在出库明细里记代发数量与代发成本；
    - **库存商品（大类）直接出现在销售行上（无关联结算清单）：不再兜底扣自身库存**，
      返回空列表。大类的扣减必须由「关联结算」（订单商品/小类）显式建立；
      调用方（见 build_order）应在此情形报错，要求用户先补关联，而不是默默改账。
    """
    items: list[tuple[Product, float]] = []

    def _add(sp: Product, multiplier: float) -> None:
        du = sp.default_unit or sp.base_unit
        factor = (sp.conversions or {}).get(du, 1.0)
        qty = qty_base_in_order * float(multiplier or 1.0) * float(factor)
        if qty > 0:
            items.append((sp, qty))

    for it in (order_product.stock_links or []):
        pid = (it or {}).get("product_id")
        sp = db.get(Product, pid) if pid else None
        if sp:
            _add(sp, float((it or {}).get("multiplier") or 1.0))
    if not items and order_product.stock_product_id:
        sp = db.get(Product, order_product.stock_product_id)
        if sp:
            _add(sp, order_product.multiplier or 1.0)
    # 库存商品（大类）无关联时**不再兜底扣自身库存**：
    # 大类在商品编辑页不允许配置关联（关联是小类的事），若平台商品名直接落到大类，
    # 旧逻辑会默默扣掉大类库存、账实不符。现改为返回空，由 build_order 报错要求补关联结算。
    return items


def stock_deduction(db: Session, order_product: Product, qty_base_in_order: float) -> tuple[Product, float, bool]:
    """（兼容旧接口）取第一项扣减目标；订单商品无任何关联时视为代发（扣减数 0）。"""
    items = stock_deductions(db, order_product, qty_base_in_order)
    if not items:
        return order_product, 0.0, True   # 代发：不扣库存
    sp, qty = items[0]
    return sp, qty, False


def _deductions_with_override(db: Session, order_product: Product, qty_base_in_order: float,
                              stock_product_id: int | None, multiplier: float = 1.0) -> list[tuple[Product, float]]:
    """计算一次出库需扣减的库存商品清单。

    一单多货规则若显式指定了关联库存商品（大类）与倍数，则优先按其扣减（单项）；
    否则回退为按订单商品自身关联扣减（stock_deductions；订单商品未关联即代发，返回空）。
    扣减数 = 订单基础数量 × 倍数 × 库存商品默认单位系数。
    """
    if stock_product_id:
        sp = db.get(Product, stock_product_id)
        if sp and sp.product_type == "stock":
            du = sp.default_unit or sp.base_unit
            factor = (sp.conversions or {}).get(du, 1.0)
            qty = qty_base_in_order * float(multiplier or 1.0) * float(factor)
            if qty > 0:
                return [(sp, qty)]
            return []
    return stock_deductions(db, order_product, qty_base_in_order)


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


def _movement_rows(db: Session, product_id: int):
    """读取某商品的库存流水（只取 FIFO 重放需要的列，不实例化 ORM 对象）。

    大商品流水上千条，而 recompute_product / fifo_state 在一次批量导入里会被调用上千次，
    ORM 实例化开销会占到大头（实测 300 单导入里约 95 万次对象构造、占近 30% 时间）。
    """
    return db.execute(
        select(
            StockMovement.id, StockMovement.move_type, StockMovement.quantity_base,
            StockMovement.amount, StockMovement.ref_type, StockMovement.ref_id,
        ).where(StockMovement.product_id == product_id).order_by(StockMovement.id)
    ).all()


def _fifo_replay(moves, fallback: float = 0.0) -> tuple[float, float, list, float, dict]:
    """按「先进先出(FIFO)」重放库存流水，计算库存量、库存价值、剩余批次与每次出库成本。

    - 入库 / 盘点增加：先按本次入库成本「补回」历史上的超卖(负库存)，余量作为新批次(layer)；
    - 出库 / 包装消耗 / 盘点减少：从最早批次依次扣减，成本 = Σ(批次单位成本 × 扣减数量)；
      批次不足(超卖)时，缺口先按「当时已知」的最后进价暂估（超卖时无法预知下次进货价），
      并登记为「待补负库存」；后续入库优先补回，并按**实际进价**回溯修正当时那次出库的成本，
      使「进货 − 出库成本 = 剩余库存价值」始终成立（与标准 FIFO 一致）；
    - 均价重估(avg)：把「每基础单位均价增量」平摊到所有现存批次；旧式成本重估(cost)的
      amount 为库存价值增量，换算成单位增量后同样处理；
    - 参考成本(ucost)：仅作记录，不影响库存与成本。

    返回 (stock, value, layers, base, out_costs)：
      layers   剩余批次 [[qty, unit_cost], ...]（qty > 0）
      base     兜底单位成本（取最新一批的单位成本；库存为 0/负时用于均价展示与出库兜底）
      out_costs  {出库流水 id: 该次 FIFO 结转成本（含后续按实际进价的回补修正）}
    """
    layers: deque[list[float]] = deque()  # [剩余数量, 单位成本]
    backorders: deque[list] = deque()  # 超卖待补：[待补数量, 暂估单位成本, 对应出库流水id]
    stock = 0.0
    base = 0.0
    out_costs: dict[int, float] = {}
    # 现存批次价值：增量维护（入库/出库时加减），成本重估(avg/cost)改了单价才置脏、用时重算。
    # 原实现每次入库都 sum(全部批次) → 入出库各上千条时是 O(n²)（实测 300 单要 230 秒）。
    layers_value = 0.0
    layers_dirty = False

    def _layers_value() -> float:
        nonlocal layers_value, layers_dirty
        if layers_dirty:
            layers_value = sum(l[0] * l[1] for l in layers)
            layers_dirty = False
        return layers_value
    for m in moves:
        qty = m.quantity_base or 0.0
        if m.move_type == "ucost":  # 成本单价(参考成本)调整：仅作记录
            continue
        if m.move_type in ("avg", "cost"):
            # 成本重估：单位均价增量 = avg 直接给出；cost 为价值增量 → 除以现有库存
            if m.move_type == "avg":
                delta = m.amount or 0.0
            else:
                delta = ((m.amount or 0.0) / stock) if stock > 1e-9 else 0.0
            if delta:
                for l in layers:
                    l[1] = max(l[1] + delta, 0.0)
                base = max(base + delta, 0.0)
                layers_dirty = True  # 单价被改过，批次价值需重算
            continue
        if qty >= 0:  # 入库 / 盘点增加
            if qty > 0:
                cur_value = _layers_value()
                unit = (m.amount / qty) if m.amount else ((cur_value / stock) if stock > 1e-9 else base)
                unit = max(unit, 0.0)
                base = unit
                rest = qty
                # 先补回历史超卖：按本次实际进价计价，并回溯修正当时那次出库的成本
                while rest > 1e-9 and backorders:
                    bo = backorders[0]
                    take = bo[0] if bo[0] < rest else rest
                    out_costs[bo[2]] = out_costs.get(bo[2], 0.0) + take * (unit - bo[1])
                    bo[0] -= take
                    rest -= take
                    if bo[0] <= 1e-9:
                        backorders.popleft()
                if rest > 1e-9:
                    layers.append([rest, unit])
                    layers_value += rest * unit
            stock += qty
            continue
        # 出库 / 包装消耗 / 盘点减少：先进先出扣减
        out = -qty
        cost = 0.0
        remain = out
        while remain > 1e-9 and layers:
            l = layers[0]
            take = l[0] if l[0] < remain else remain
            cost += take * l[1]
            layers_value -= take * l[1]
            l[0] -= take
            remain -= take
            if l[0] <= 1e-9:
                layers.popleft()
        if remain > 1e-9:  # 超卖：先按兜底成本暂估，登记待后续入库回补
            assumed = base if base > 0 else fallback
            if base <= 0:
                base = assumed  # 无任何入库批次时，用兜底成本参与均价展示与后续暂估
            cost += remain * assumed
            backorders.append([remain, assumed, m.id])
        stock -= out
        out_costs[m.id] = out_costs.get(m.id, 0.0) + cost
    return stock, _layers_value(), list(layers), base, out_costs


def _sync_outbound_cogs(db: Session, outbound_id: int) -> None:
    """把 FIFO 重算后的出库流水金额回写到出库单行成本与单据总成本。

    优先按流水的 line_id 归组求和回写（订单商品可关联多个库存商品，一行明细对应多条流水）；
    旧数据（流水无 line_id）退化为按 id 顺序一一对应；结构不一致(数量不等)时保守跳过，避免错配。
    """
    out = db.get(Outbound, outbound_id)
    if not out:
        return
    lines = sorted(out.lines, key=lambda x: x.id)
    moves = list(
        db.execute(
            select(StockMovement)
            .where(StockMovement.ref_type == "outbound", StockMovement.ref_id == outbound_id)
            .order_by(StockMovement.id)
        ).scalars()
    )
    by_line: dict[int, list] = {}
    for m in moves:
        if m.line_id:
            by_line.setdefault(m.line_id, []).append(m)
    if by_line:
        total = 0.0
        for line in lines:
            ms = by_line.get(line.id) or []
            if not ms:
                total += line.cogs or 0.0
                continue
            amount = round(sum(m.amount or 0.0 for m in ms), 2)
            if abs((line.cogs or 0.0) - amount) > 1e-6:
                line.cogs = amount
            total += line.cogs or 0.0
        out.total_cogs = round(total, 2)
        return
    if len(lines) != len(moves):
        return
    total = 0.0
    for line, mv in zip(lines, moves):
        amount = round(mv.amount or 0.0, 2)
        if abs((line.cogs or 0.0) - amount) > 1e-6:
            line.cogs = amount
        total += line.cogs or 0.0
    out.total_cogs = round(total, 2)


def recompute_product(db: Session, product_id: int) -> Product:
    """以库存流水为准，按「先进先出(FIFO)」重算商品的库存、库存均价与库存价值。

    入库行 amount 作为批次成本；出库/包装行按最早批次成本结转。
    """
    product = db.get(Product, product_id)
    db.flush()  # 确保本事务中新写入的流水在重算前可见
    moves = _movement_rows(db, product_id)
    stock, value, _layers, base, out_costs = _fifo_replay(moves, fallback=product.unit_cost or 0.0)
    # 出库/包装消耗行回写 FIFO 结转成本（库存流水是成本的源数据），并同步出库单行成本与总成本。
    # 只同步「成本确实发生变化」的那几单（通常是超卖回补涉及的少数单），避免批量导入时 O(N²) 全量重写。
    changed: list[tuple[int, float]] = []
    affected_outbounds: set[int] = set()
    for m in moves:
        if m.id not in out_costs:
            continue
        new_amount = out_costs[m.id]
        if abs((m.amount or 0.0) - new_amount) > 1e-9:
            changed.append((m.id, new_amount))
            if m.ref_type == "outbound" and m.ref_id:
                affected_outbounds.add(m.ref_id)
    if changed:
        # 只有值变化的那几条按 ORM 写回（保持与旧实现同一写法；条数通常为 0~几条）
        amt_by_id = dict(changed)
        for m in db.execute(
            select(StockMovement).where(StockMovement.id.in_(list(amt_by_id)))
        ).scalars():
            m.amount = amt_by_id[m.id]
    for oid in affected_outbounds:
        _sync_outbound_cogs(db, oid)
    # 库存均价 = 剩余批次加权均价；无剩余批次时用兜底成本（保证无库存/负库存商品仍有成本参与利润与报表）
    avg = (value / stock) if stock > 1e-9 else base
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


# ---------------- 单据批量删除 ----------------
# SQLite 单条 SQL 的变量数有上限，ids 分批处理，避免一次删几千单时 in_() 参数过多。
_DELETE_CHUNK = 400


def _chunks(seq: list, size: int = _DELETE_CHUNK):
    for i in range(0, len(seq), size):
        yield seq[i:i + size]


def _bulk_delete_ref(db: Session, model, ref_type: str, ref_ids: list[int]) -> None:
    """按来源(ref_type + ref_id)批量删除流水，stock_movements / finance_records 共用。"""
    if not ref_ids:
        return
    db.execute(
        delete(model)
        .where(model.ref_type == ref_type, model.ref_id.in_(ref_ids))
        .execution_options(synchronize_session=False)
    )


def purge_outbounds(db: Session, ids: list[int]) -> tuple[int, int, set[int]]:
    """批量删除出库单（主单 + 明细 + 库存流水 + 财务流水），返回 (deleted, missing, 受影响商品集合)。

    旧实现逐单 `get` + lazy load 明细 + 逐单对每个受影响商品全量重放 FIFO，删几百单时是
    O(单数 × 商品数 × 该商品流水数)——出库单几乎每单都含人工/包材/快递等热门商品，
    每个热门商品会被反复全量重算，实测一次批量删除要 114 秒。
    这里改为：查询与删除按批合并成常数次 SQL，受影响商品去重后只在最后各重算一次。
    调用方负责 db.commit()；本函数内部已 flush 并完成 FIFO 重算。
    """
    uniq = list(dict.fromkeys(int(i) for i in ids))
    existing: list[int] = []
    affected: set[int] = set()
    for part in _chunks(uniq):
        existing += db.execute(select(Outbound.id).where(Outbound.id.in_(part))).scalars().all()
        affected |= set(
            db.execute(select(OutboundLine.product_id).where(OutboundLine.outbound_id.in_(part))).scalars()
        )
        # 库存流水实际扣在哪个商品（含库存大类/包材/人工）就重算哪个
        affected |= set(
            db.execute(
                select(StockMovement.product_id).where(
                    StockMovement.ref_type == "outbound", StockMovement.ref_id.in_(part)
                )
            ).scalars()
        )
    for part in _chunks(existing):
        _bulk_delete_ref(db, StockMovement, "outbound", part)
        _bulk_delete_ref(db, FinanceRecord, "outbound", part)
        _bulk_delete_ref(db, OtherExpense, "outbound", part)  # 金额调整带出的其他开支一并删除
        db.execute(
            delete(OutboundLine).where(OutboundLine.outbound_id.in_(part)).execution_options(synchronize_session=False)
        )
        db.execute(delete(Outbound).where(Outbound.id.in_(part)).execution_options(synchronize_session=False))
    db.flush()  # 删除落库后 FIFO 重放才看得到最新流水
    for pid in affected:
        if pid is not None:
            recompute_product(db, pid)
    return len(existing), len(uniq) - len(existing), affected


def purge_inbounds(db: Session, ids: list[int]) -> tuple[int, int, set[int]]:
    """批量删除入库单（主单 + 库存流水 + 财务流水），返回 (deleted, missing, 受影响商品集合)。

    与 purge_outbounds 同一思路：批量查询/删除 + 受影响商品去重后只重算一次。
    """
    uniq = list(dict.fromkeys(int(i) for i in ids))
    existing: list[int] = []
    affected: set[int] = set()
    for part in _chunks(uniq):
        existing += db.execute(select(Inbound.id).where(Inbound.id.in_(part))).scalars().all()
        affected |= set(db.execute(select(Inbound.product_id).where(Inbound.id.in_(part))).scalars())
        affected |= set(
            db.execute(
                select(StockMovement.product_id).where(
                    StockMovement.ref_type == "inbound", StockMovement.ref_id.in_(part)
                )
            ).scalars()
        )
    for part in _chunks(existing):
        _bulk_delete_ref(db, StockMovement, "inbound", part)
        _bulk_delete_ref(db, FinanceRecord, "inbound", part)
        _bulk_delete_ref(db, OtherExpense, "inbound", part)  # 金额调整带出的其他开支一并删除
        _bulk_delete_ref(db, OtherExpense, INBOUND_FEE_REF, part)  # 运费/装卸费镜像行一并删除
        db.execute(delete(Inbound).where(Inbound.id.in_(part)).execution_options(synchronize_session=False))
    db.flush()
    for pid in affected:
        if pid is not None:
            recompute_product(db, pid)
    return len(existing), len(uniq) - len(existing), affected


def fifo_state(db: Session, product_id: int) -> tuple[deque, float]:
    """取商品当前 FIFO 剩余批次与兜底成本（供出库前预估结转成本，不落库、不修改数据）。"""
    p = db.get(Product, product_id)
    moves = _movement_rows(db, product_id)
    _, _, layers, base, _ = _fifo_replay(moves, fallback=(p.unit_cost if p else 0.0) or 0.0)
    return deque([list(l) for l in layers]), base


def fifo_take(layers: deque, base: float, qty: float, fallback: float) -> float:
    """从 FIFO 批次消耗 qty，返回结转成本；批次不足的缺口按 base（无则 fallback）计价。"""
    cost = 0.0
    remain = qty
    while remain > 1e-9 and layers:
        l = layers[0]
        take = l[0] if l[0] < remain else remain
        cost += take * l[1]
        l[0] -= take
        remain -= take
        if l[0] <= 1e-9:
            layers.popleft()
    if remain > 1e-9:
        cost += remain * (base if base > 0 else fallback)
    return cost


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


def pay_fields(payload: dict, date: str = "") -> dict:
    """付款状态：paid 已付款（默认）/ unpaid 待付款。

    待付款的单据先进「待付款账单」，点「已支付」后才纳入财务报表；已付款时记下支付日期（默认=单据日期）。
    """
    status = "unpaid" if (payload.get("pay_status") or "").strip() == "unpaid" else "paid"
    paid_at = (payload.get("paid_at") or "").strip()
    if status == "paid" and not paid_at:
        paid_at = (date or payload.get("date") or "").strip()
    return {"pay_status": status, "paid_at": paid_at if status == "paid" else ""}


ADJUST_CATEGORY = "金额调整"  # 抹零/凑整等金额调整自动生成的其他开支类型


def sync_adjust_expense(db: Session, kind: str, ref_id: int, code: str, date: str,
                        operator: str, adjust: float, pay: dict) -> None:
    """维护单据「金额调整」对应的其他开支：调整额为 0 则删除，否则新建/更新为 |调整额|。

    单据金额与商品成本都按商品原价不变，抹零/凑整的差额在这里单独记一笔支出——
    这样报表口径 = 实收/实付，而商品成本（FIFO 批次）不受影响。
    """
    existing = list(db.execute(
        select(OtherExpense).where(OtherExpense.ref_type == kind, OtherExpense.ref_id == ref_id)
    ).scalars())
    amount = round(abs(float(adjust or 0)), 2)
    if amount <= 0:
        for e in existing:
            db.delete(e)
        return
    label = "入库" if kind == "inbound" else "出库"
    remark = f"{label} {code} 金额调整 {'+' if adjust > 0 else '-'}{amount}"
    if existing:
        e = existing[0]
        e.amount, e.date, e.remark, e.operator = amount, date, remark, operator
        e.pay_status, e.paid_at = pay["pay_status"], pay["paid_at"]
        for extra in existing[1:]:
            db.delete(extra)
        return
    db.add(OtherExpense(
        category=ADJUST_CATEGORY, amount=amount, date=date, remark=remark,
        operator=operator, ref_type=kind, ref_id=ref_id,
        pay_status=pay["pay_status"], paid_at=pay["paid_at"],
    ))


# 入库「运费 / 装卸费」带出的其他开支镜像行的 ref_type（与金额调整的 "inbound" 区分，互不误伤）
INBOUND_FEE_REF = "inbound_fee"
INBOUND_FEE_CATEGORIES = (("freight", "运费"), ("handling", "装卸费"))


def sync_inbound_fee_expenses(db: Session, rec: "Inbound", product_name: str, pay: dict) -> None:
    """维护入库单「运费 / 装卸费」对应的其他开支镜像行：每项 >0 各生成一行，清零则删除。

    这两项费用已计入批次到岸成本（FIFO 结转随销量扣减，体现在该品毛利上）；这里的镜像行
    只供「其他开支」页按类型/日期查询，报表的期间费用聚合一律排除 ref_type="inbound_fee"
    （见 routers/report.py），避免「成本 + 期间费用」重复扣减。日期/付款状态随单据
    同步维护（sync_doc_edit / pay_bill / 删除级联）。
    """
    for attr, label in INBOUND_FEE_CATEGORIES:
        amount = round(float(getattr(rec, attr, 0.0) or 0.0), 2)
        existing = list(db.execute(
            select(OtherExpense).where(
                OtherExpense.ref_type == INBOUND_FEE_REF,
                OtherExpense.ref_id == rec.id,
                OtherExpense.category == label,
            )
        ).scalars())
        for stale in existing[1:]:
            db.delete(stale)
        if amount <= 0:
            for e in existing[:1]:
                db.delete(e)
            continue
        remark = f"入库 {rec.code} {label} · {product_name}（已计入批次成本）"
        if existing:
            e = existing[0]
            e.amount, e.date, e.remark, e.operator = amount, rec.date, remark, rec.operator
            e.pay_status, e.paid_at = pay["pay_status"], pay["paid_at"]
        else:
            db.add(OtherExpense(
                category=label, amount=amount, date=rec.date, remark=remark,
                operator=rec.operator, ref_type=INBOUND_FEE_REF, ref_id=rec.id,
                pay_status=pay["pay_status"], paid_at=pay["paid_at"],
            ))


def sync_doc_edit(db: Session, kind: str, ref_id: int, date: str, operator: str, pay: dict) -> None:
    """单据被手动修改（供应商/客户、日期、付款状态）后，同步它带出的库存流水/财务流水/其他开支。

    - 操作员统一记为本次修改人（后端强制取登录账号，忽略前端传值）；
    - 改日期时三类关联记录的日期一起改，保证报表按日期统计口径一致；
      FIFO 重放按流水 id 排序，因此改日期不会改变结转成本。
    """
    for m in db.execute(
        select(StockMovement).where(StockMovement.ref_type == kind, StockMovement.ref_id == ref_id)
    ).scalars():
        m.date, m.operator = date, operator
    for f in db.execute(
        select(FinanceRecord).where(FinanceRecord.ref_type == kind, FinanceRecord.ref_id == ref_id)
    ).scalars():
        f.date, f.operator = date, operator
        f.pay_status, f.paid_at = pay["pay_status"], pay["paid_at"]
    # 其他开支带出行：金额调整(ref_type=kind) + 入库的运费/装卸费镜像行(ref_type=inbound_fee)
    fee_types = [kind] + ([INBOUND_FEE_REF] if kind == "inbound" else [])
    for e in db.execute(
        select(OtherExpense).where(OtherExpense.ref_type.in_(fee_types), OtherExpense.ref_id == ref_id)
    ).scalars():
        e.date, e.operator = date, operator
        e.pay_status, e.paid_at = pay["pay_status"], pay["paid_at"]


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
    amount = round(quantity * unit_price, 2)   # 商品金额（货款），不随金额调整变化
    adjust = round(float(payload.get("adjust_amount") or 0), 2)   # 抹零/凑整：正=多付，负=少付
    freight = round(float(payload.get("freight") or 0), 2)    # 运费（选填，计入批次成本）
    handling = round(float(payload.get("handling") or 0), 2)  # 装卸费（选填，计入批次成本）
    if freight < 0 or handling < 0:
        raise ValueError("运费 / 装卸费不能为负数")
    landed = round(amount + freight + handling, 2)  # 批次到岸成本 = 货款 + 运费 + 装卸费（金额调整不计入）
    op = (payload.get("operator") or "").strip() or operator

    pay = pay_fields(payload, date)
    rec = Inbound(
        code=gen_inbound_code(db, date),
        product_id=product.id,
        unit=unit,
        quantity=quantity,
        quantity_base=qty_base,
        unit_price=unit_price,
        total_amount=amount,
        adjust_amount=adjust,
        freight=freight,
        handling=handling,
        supplier=(payload.get("supplier") or "").strip(),
        operator=op,
        date=date,
        remark=(payload.get("remark") or "").strip(),
        **pay,
    )
    db.add(rec)
    db.flush()
    mv = StockMovement(
        product_id=product.id,
        move_type="in",
        quantity_base=qty_base,
        amount=landed,
        ref_type="inbound",
        ref_id=rec.id,
        date=date,
        operator=op,
        remark=f"入库 {rec.code}" + (f"（含运费/装卸 ¥{round(freight + handling, 2)}）" if freight or handling else ""),
    )
    db.add(mv)
    db.flush()
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
            **pay,   # 挂账状态随入库单：待付款时这笔采购支出也不进报表
        )
    )
    sync_adjust_expense(db, "inbound", rec.id, rec.code, date, op, adjust, pay)
    sync_inbound_fee_expenses(db, rec, product.name, pay)
    recompute_product(db, product.id)
    db.flush()
    return rec


def build_order(db: Session, lines, pack_lines=None, fee_total=None, auto_express: bool = True) -> dict:
    """构建出库单明细：销售行 + 关联结算行(包装材料) + 费用，并校验库存。不落库。

    成本结转按「先进先出(FIFO)」：从商品最早的入库批次依次扣减，成本 = Σ(批次单位成本 × 扣减数量)。

    auto_express=False 时不自动结算快递费（手动出库时用户在预览里删掉「快递费」行即为不结算），
    其余批量导入/聚水潭等流程不传该参数，保持「按整单毛重自动计快递费」的原行为。
    """
    pack_lines = pack_lines or []
    sale_rows, pack_rows, warnings = [], [], []
    total_amount = total_cogs = 0.0
    express_weight = 0.0  # 整单毛重(kg)，用于自动计算快递费
    # FIFO 批次缓存：{库存商品id: (剩余批次deque, 兜底成本)}；同单内对同一商品的多行按顺序依次扣减
    fifo_cache: dict[int, tuple] = {}

    def _fifo_cogs(target: Product, qty: float) -> float:
        if target.id not in fifo_cache:
            fifo_cache[target.id] = fifo_state(db, target.id)
        layers, base = fifo_cache[target.id]
        return fifo_take(layers, base, qty, target.unit_cost or 0.0)

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
        # 规格：导入单（聚水潭）会带「每件2斤」这类规格，手动单没有 → 回退用商品维护的「规格说明」，
        # 这样「出库明细（每天×每种规格）」对手动单也能按规格归类。
        if not spec:
            spec = (p.spec or "").strip()
        qty_base = unit_to_base(p, unit, quantity)
        amount = round(quantity * price, 2)
        # 扣点前销售金额（原始金额）：导入扣点单传入；否则等于实际销售金额
        gross_sales = round(float(gross), 2) if gross and float(gross) > 0 else amount
        # 扣减目标：一单多货规则如指定库存大类则按其扣减；否则按订单商品关联的库存商品（大类）；
        # 订单商品未关联库存大类 = 代发：不扣任何库存，只记代发数量与代发成本。
        deds = _deductions_with_override(db, p, qty_base, ov_sp, ov_mult)
        if not deds and (p.product_type or "stock") == "stock":
            # 库存大类没有「关联结算清单」（大类在商品编辑页不能配关联，关联属于订单小类）：
            # 旧逻辑会兜底扣大类自身库存 —— 属于默默改账，已去掉，改为直接报错，
            # 让用户到「关联结算」新建订单商品（小类）并关联该大类，或在「关联明细」把平台商品名指到该小类。
            raise ValueError(
                f"商品「{p.name}」是库存大类、没有关联结算清单，未扣减库存："
                f"请先在「关联结算」新增对应的订单商品（小类）并关联该库存大类"
                f"（或在「关联明细」把平台商品名指到该小类）后重新导入"
            )
        is_dropship = not deds
        # 包邮：商品自身勾了「包邮」，或其扣减的任一库存大类勾了「包邮」→ 该行不计入计费毛重。
        # 整单全是包邮商品时 express_weight 为 0，不会生成「快递费(自动)」行；混合单只为不包邮的部分计运费。
        line_free = bool(getattr(p, "free_shipping", False)) or any(
            bool(getattr(sp, "free_shipping", False)) for sp, _ in deds
        )
        ded_info: list[dict] = []
        if is_dropship:
            # 代发：商品由别人发出，本仓不扣库存；代发成本按商品「参考成本（每基础单位）」计（未填则 0，并给出提示）。
            # 快递费：代发商品若填了「单件净重」（weight_kg），仍按净重结算快递费（有的代发只包货不包邮）；
            # 没填净重就不计（视为代发方包邮）。
            if not line_free:
                express_weight += line_weight_kg(p, qty_base)
            cogs = round(qty_base * (p.unit_cost or 0.0), 2)
            if not (p.unit_cost or 0.0):
                warnings.append(f"「{p.name}」是代发商品（未关联库存大类）但没填「参考成本」，代发成本按 0 计")
        else:
            # 订单商品可关联多个库存商品：成本与净重按各扣减项分别结转后累加。
            # 净重优先由「扣减库存量」推导（如 七彩花生2斤 → 扣 1kg 库存 → 净重 1kg）；
            # 推导不出（0）时回退扣减目标自身的净重；全部推导不出再用当前销售商品填的净重。
            line_net_kg = 0.0
            cogs = 0.0
            for sp, ded_qty in deds:
                kg = deduction_net_weight_kg(sp, ded_qty)
                if kg <= 0:
                    kg = line_weight_kg(sp, ded_qty)
                line_net_kg += kg
                c = _fifo_cogs(sp, ded_qty)
                cogs += c
                ded_info.append({
                    "product_id": sp.id, "product_name": sp.name, "base_unit": sp.base_unit,
                    "deduction_base": ded_qty, "cogs": c,
                })
            if line_net_kg <= 0:
                line_net_kg = line_weight_kg(p, qty_base)
            if not line_free:
                express_weight += line_net_kg
            cogs = round(cogs, 2)
        if fee is None:
            fee = p.pack_fee
        sale_rows.append(
            {
                "product_id": p.id, "product_name": p.name, "base_unit": p.base_unit,
                "unit": unit, "quantity": quantity, "quantity_base": qty_base,
                # 首个扣减项（兼容旧字段与展示）；deductions 为全部扣减项（多关联）
                "stock_product_id": deds[0][0].id if deds else p.id,
                "stock_product_name": deds[0][0].name if deds else p.name,
                "deduction_base": deds[0][1] if deds else 0.0,
                "deductions": ded_info, "is_dropship": is_dropship, "free_shipping": line_free,
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
            # 关联材料成本：按先进先出结转；无批次时回退参考成本。
            # unit_price 与显式成本行口径一致，均按「每展示单位」给出，供前端直接展示与重算。
            cogs = round(_fifo_cogs(m, qty_base), 2)
            unit_price = round(cogs / spec["quantity"], 6) if spec["quantity"] else 0.0
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
    # auto_express=False（手动出库并在预览里删掉了「快递费」行）时不再自动追加
    if auto_express and express_weight > 0:
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

    # 库存预警（允许继续，仅提示；服务型商品如 人工/快递 不校验库存）；
    # 订单商品关联多个库存商品时，逐个扣减目标分别提示。
    for r in sale_rows + pack_rows:
        if r["line_type"] == "sale":
            if r.get("is_dropship"):
                continue   # 代发不扣库存，无需预警
            checks = [(d["product_id"], d["deduction_base"], d.get("product_name") or "") for d in (r.get("deductions") or [])]
        else:
            checks = [(r["product_id"], r["quantity_base"], "")]
        for pid, need, sp_name in checks:
            p = db.get(Product, pid)
            if not p or p.category in ("人工", "快递"):
                continue
            if need > p.stock + 1e-6:
                label = r["product_name"] if not sp_name else f"{r['product_name']}（扣{fmt_qty(need)} {sp_name}）"
                warnings.append(f"「{label}」库存不足：需 {fmt_qty(need)} {p.base_unit}，现有 {fmt_qty(p.stock)} {p.base_unit}")

    return {
        "sale_lines": sale_rows,
        "pack_lines": pack_rows,
        "total_amount": round(total_amount, 2),
        "total_cogs": round(total_cogs, 2),
        "total_fee": round(total_fee, 2),
        # 关联结算合计（包材 + 人工 + 自动快递费）：芳谊放单仓「快递+包装固定费」的自动值口径
        "pack_cogs": round(sum(r["cogs"] for r in pack_rows), 2),
        "gross_profit": round(total_amount - total_cogs, 2),
        "net_profit": round(total_amount - total_cogs - total_fee, 2),
        "warnings": warnings,
    }


def create_outbound(db: Session, payload: dict, operator: str = "", import_group: str = "",
                    defer_recompute: bool = False, affected_out: list | None = None) -> tuple[Outbound, list]:
    """创建出库/销售单（含明细、库存流水、财务记录、成本重算）。返回 (单, 预警)。

    import_group：批量导入批次号，空表示手动单条。
    defer_recompute=True 时不在本单内重算商品成本，而是把受影响的商品 id 追加到 affected_out，
    由调用方（批量导入）在整批写完后统一重算一次 —— 避免每单都全量重放流水。
    """
    lines = payload["lines"]
    order = build_order(
        db, lines, payload.get("pack_lines"), payload.get("pack_fee_total"),
        payload.get("auto_express", True),   # 手动出库可关掉自动快递费；批量导入等默认开
    )
    op = (payload.get("operator") or "").strip() or operator
    date = payload["date"]
    adjust = round(float(payload.get("adjust_amount") or 0), 2)   # 抹零/凑整：正=加收，负=抹零
    pay = pay_fields(payload, date)
    # 芳谊放单仓刷单结算（口径见 app/brush.py）：只有放单仓的单子才记这三列，其余单据口径不变。
    # brush_auto_fee 由服务端自己按出库口径算（= 关联结算快递/包材/人工 + 打包费），不信任前端传值。
    brush = is_brush_warehouse(payload.get("warehouse"))
    brush_auto_fee = round(float(order.get("pack_cogs", 0) or 0) + float(order["total_fee"] or 0), 2) if brush else 0.0
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
        adjust_amount=adjust,
        total_cogs=order["total_cogs"],
        total_fee=order["total_fee"],
        brush_cost=round(float(payload.get("brush_cost") or 0), 2) if brush else 0.0,
        brush_fee=round(float(payload.get("brush_fee") or 0), 2) if brush else 0.0,
        brush_auto_fee=brush_auto_fee,
        **pay,
    )
    db.add(rec)
    db.flush()

    affected = set()
    for r in order["sale_lines"] + order["pack_lines"]:
        is_sale = r["line_type"] == "sale"
        dropship = bool(is_sale and r.get("is_dropship"))
        line = OutboundLine(
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
            is_dropship=dropship,
        )
        db.add(line)
        db.flush()   # 取行 id：订单商品关联多个库存商品时，一行明细对应多条库存流水
        if not dropship:   # 代发：本仓不出货，不产生库存流水（否则会把库存扣成负数）
            if is_sale:
                # 库存流水扣在库存商品（大类）上：订单商品关联多个则逐个扣减，每条流水回指本行
                deds = r.get("deductions") or []
                if deds:
                    move_items = [(d["product_id"], -d["deduction_base"], d["cogs"]) for d in deds]
                else:
                    move_items = [(r["stock_product_id"], -r["deduction_base"], r["cogs"])]
                for move_pid, move_qty, move_amount in move_items:
                    db.add(
                        StockMovement(
                            product_id=move_pid,
                            move_type="out",
                            quantity_base=move_qty,
                            amount=move_amount,
                            ref_type="outbound",
                            ref_id=rec.id,
                            line_id=line.id,
                            date=date,
                            operator=op,
                            remark=f"销售 {rec.code}",
                        )
                    )
                    affected.add(move_pid)
            else:
                # 人工 / 快递等服务类记为正向工作量（不扣库存）；包材等仍为负向包装消耗
                pack_p = db.get(Product, r["product_id"])
                is_service = bool(pack_p and pack_p.category in ("人工", "快递"))
                move_qty = r["quantity_base"] if is_service else -r["quantity_base"]
                move_type = "work" if is_service else "pack_out"
                db.add(
                    StockMovement(
                        product_id=r["product_id"],
                        move_type=move_type,
                        quantity_base=move_qty,
                        amount=r["cogs"],
                        ref_type="outbound",
                        ref_id=rec.id,
                        line_id=line.id,
                        date=date,
                        operator=op,
                        remark=f"包装消耗 {rec.code}",
                    )
                )
                affected.add(r["product_id"])
        affected.add(r["product_id"])
        if is_sale and r["amount"] > 0:
            db.add(
                FinanceRecord(
                    type="income", category="销售收入", product_id=r["product_id"],
                    amount=r["amount"], date=date, operator=op,
                    remark=f"销售 {rec.code}", ref_type="outbound", ref_id=rec.id,
                    **pay,   # 挂账状态随出库单
                )
            )
    if order["total_fee"] > 0:
        db.add(
            FinanceRecord(
                type="expense", category="人工打包费", product_id=None,
                amount=order["total_fee"], date=date, operator=op,
                remark=f"打包费 {rec.code}", ref_type="outbound", ref_id=rec.id,
                **pay,   # 挂账状态随出库单
            )
        )
    sync_adjust_expense(db, "outbound", rec.id, rec.code, date, op, adjust, pay)
    if defer_recompute:
        if affected_out is not None:
            affected_out.extend(affected)
    else:
        for pid in affected:
            recompute_product(db, pid)
    db.flush()
    return rec, order["warnings"]
