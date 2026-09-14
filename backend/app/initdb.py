"""分仓数据库初始化：建表、迁移、种子、回填（幂等）。

从 main.py 抽出的公共逻辑，供启动（奥斯迪仓 + 当前仓）与新建分仓复用。
"""
import re

from sqlalchemy import or_, select, text
from sqlalchemy.engine import Engine
from sqlalchemy.orm import Session, sessionmaker

from .auth import ensure_seed_users
from .database import Base, DATA_DIR, get_engine, get_sessionmaker
from .models import Deduction, FinanceRecord, Outbound, OutboundLine, PackRule, Product, User, WarehouseIn, WarehouseProduct
from .services import recompute_product, seed_units


def migrate(engine: Engine, maker: sessionmaker) -> None:
    """轻量迁移：为已存在的库补充新增列（幂等，新库 create_all 已含全部列自动跳过）。"""
    with engine.connect() as conn:
        cols = [r[1] for r in conn.execute(text("PRAGMA table_info(products)")).fetchall()]
        if "code" not in cols:
            conn.execute(text("ALTER TABLE products ADD COLUMN code VARCHAR(128) DEFAULT ''"))
        if "default_unit" not in cols:
            conn.execute(text("ALTER TABLE products ADD COLUMN default_unit VARCHAR(32) DEFAULT ''"))
        if "unit_cost" not in cols:
            conn.execute(text("ALTER TABLE products ADD COLUMN unit_cost FLOAT DEFAULT 0"))
        if "product_type" not in cols:
            conn.execute(text("ALTER TABLE products ADD COLUMN product_type VARCHAR(8) DEFAULT 'stock'"))
        if "stock_product_id" not in cols:
            conn.execute(text("ALTER TABLE products ADD COLUMN stock_product_id INTEGER"))
        if "multiplier" not in cols:
            conn.execute(text("ALTER TABLE products ADD COLUMN multiplier FLOAT DEFAULT 1"))
        if "workload" not in cols:
            conn.execute(text("ALTER TABLE products ADD COLUMN workload FLOAT DEFAULT 0"))
        if "weight_kg" not in cols:
            conn.execute(text("ALTER TABLE products ADD COLUMN weight_kg FLOAT DEFAULT 0"))
        conn.commit()

    # 用户表：SSH 指纹认证所需字段
    with engine.connect() as conn:
        ucols = [r[1] for r in conn.execute(text("PRAGMA table_info(users)")).fetchall()]
        if "public_key" not in ucols:
            conn.execute(text("ALTER TABLE users ADD COLUMN public_key VARCHAR(512)"))
        if "fingerprint" not in ucols:
            conn.execute(text("ALTER TABLE users ADD COLUMN fingerprint VARCHAR(64)"))
        if "key_created_at" not in ucols:
            conn.execute(text("ALTER TABLE users ADD COLUMN key_created_at DATETIME"))
        conn.commit()

    # 出库单表：批量导入批次号（空=手动单条）
    with engine.connect() as conn:
        ocols = [r[1] for r in conn.execute(text("PRAGMA table_info(outbounds)")).fetchall()]
        if "import_group" not in ocols:
            conn.execute(text("ALTER TABLE outbounds ADD COLUMN import_group VARCHAR(32) DEFAULT ''"))
        if "pack_rule_id" not in ocols:
            conn.execute(text("ALTER TABLE outbounds ADD COLUMN pack_rule_id INTEGER"))
        if "pack_rule_name" not in ocols:
            conn.execute(text("ALTER TABLE outbounds ADD COLUMN pack_rule_name VARCHAR(255) DEFAULT ''"))
        conn.commit()

    # 出库单行：pack 行所属销售商品（打包人工+耗材组合统计用）
    with engine.connect() as conn:
        lcols = [r[1] for r in conn.execute(text("PRAGMA table_info(outbound_lines)")).fetchall()]
        if "sale_product_id" not in lcols:
            conn.execute(text("ALTER TABLE outbound_lines ADD COLUMN sale_product_id INTEGER"))
        if "spec" not in lcols:
            conn.execute(text("ALTER TABLE outbound_lines ADD COLUMN spec VARCHAR(64) DEFAULT ''"))
        if "gross_sales" not in lcols:
            conn.execute(text("ALTER TABLE outbound_lines ADD COLUMN gross_sales FLOAT DEFAULT 0"))
        conn.commit()
    _backfill_sale_product(maker)
    _backfill_pack_rule(maker)

    # 一单多货规则表：箱型号关联清单（新增列）
    with engine.connect() as conn:
        prcols = [r[1] for r in conn.execute(text("PRAGMA table_info(pack_rules)")).fetchall()]
        if "box_items" not in prcols:
            conn.execute(text("ALTER TABLE pack_rules ADD COLUMN box_items JSON"))
            conn.commit()
    _backfill_pack_rule_box_items(maker)
    _backfill_gross_sales(maker)

    # 入仓表：入仓品新增「关联库存商品 / 每袋净重」，入仓记录新增「收入/成本/运费/毛利」口径（新增列，幂等）
    with engine.connect() as conn:
        wpcols = [r[1] for r in conn.execute(text("PRAGMA table_info(warehouse_products)")).fetchall()]
        if wpcols:
            if "stock_product_id" not in wpcols:
                conn.execute(text("ALTER TABLE warehouse_products ADD COLUMN stock_product_id INTEGER"))
            if "bag_weight" not in wpcols:
                conn.execute(text("ALTER TABLE warehouse_products ADD COLUMN bag_weight FLOAT DEFAULT 0"))
            conn.commit()
    with engine.connect() as conn:
        wicols = [r[1] for r in conn.execute(text("PRAGMA table_info(warehouse_ins)")).fetchall()]
        if wicols:
            for col, ddl in (
                ("stock_product_id", "INTEGER"),
                ("bag_weight", "FLOAT DEFAULT 0"),
                ("unit_cost", "FLOAT DEFAULT 0"),
                ("cogs", "FLOAT DEFAULT 0"),
                ("freight_total", "FLOAT DEFAULT 0"),
                ("profit", "FLOAT DEFAULT 0"),
                ("deduction_percent", "FLOAT DEFAULT 0"),
            ):
                if col not in wicols:
                    conn.execute(text(f"ALTER TABLE warehouse_ins ADD COLUMN {col} {ddl}"))
            conn.commit()


def _backfill_gross_sales(maker: sessionmaker) -> None:
    """历史出库销售行回填「扣点前销售金额」：按备注里的店铺扣点把 gross_sales=0 的扣点单行还原（幂等）。"""
    db = maker()
    try:
        for o in db.execute(select(Outbound)).scalars():
            remark = o.remark or ""
            if "扣点" not in remark:
                continue
            fixed = re.search(r"店铺扣点\s*([\d.]+)%", remark)
            cat_map = {}
            if "店铺分类扣点" in remark:
                part = remark.split("店铺分类扣点", 1)[1]
                for name, pct in re.findall(r"([^、()（）]+?)\s*([\d.]+)%", part):
                    cat_map[name.strip()] = float(pct)
            changed = False
            for l in o.lines:
                if l.line_type != "sale" or (l.gross_sales or 0) or not (l.amount or 0):
                    continue
                pct = float(fixed.group(1)) if fixed else (cat_map.get(l.product.category if l.product else "", 0) or 0)
                if pct > 0:
                    l.gross_sales = round(l.amount / (1 - pct / 100.0), 2)
                    changed = True
            if changed:
                db.flush()
        db.commit()
    finally:
        db.close()


def _backfill_pack_rule_box_items(maker: sessionmaker) -> None:
    """回填 pack_rules.box_items：把旧 box_type 文本解析并关联到包材纸箱（幂等）。"""
    db = maker()
    try:
        for r in db.execute(select(PackRule)).scalars():
            if r.box_items:
                continue
            items = None
            for part in str(r.box_type or "").split("+"):
                part = part.strip()
                if not part:
                    continue
                m = re.search(r"\*(\d+)$", part)
                if m:
                    name, qty = part[: m.start()], int(m.group(1))
                else:
                    name, qty = part, 1
                pid = None
                for cand in (name, name + "纸箱", name + "箱"):
                    p = db.scalar(select(Product).where(Product.name == cand))
                    if p:
                        pid = p.id
                        name = _box_model_name(p.name)
                        break
                if items is None:
                    items = []
                items.append({"product_id": pid, "name": name, "quantity": qty})
            if items:
                r.box_items = items
        db.commit()
    except Exception as e:  # 回填失败不影响主流程
        print("[迁移] 回填 pack_rules.box_items 失败:", e)
        db.rollback()
    finally:
        db.close()


def _box_model_name(pname: str) -> str:
    n = (pname or "").strip()
    if n.endswith("纸箱"):
        return n[:-2]
    if n.endswith("号箱"):
        return n[:-1]
    return n


def _backfill_pack_rule(maker: sessionmaker) -> None:
    """回填出库单的 pack_rule_name / pack_rule_id（幂等）：从 remark 解析「一单多货·规则：xxx）」。"""
    db = maker()
    try:
        rules = {r.name: r.id for r in db.execute(select(PackRule)).scalars()}
        for o in db.execute(select(Outbound).where(Outbound.pack_rule_name == "")).scalars():
            remark = o.remark or ""
            if "一单多货·规则：" not in remark:
                continue
            seg = remark.split("一单多货·规则：", 1)[1].split("）", 1)[0].strip()
            if not seg:
                continue
            o.pack_rule_name = seg
            o.pack_rule_id = rules.get(seg)
        db.commit()
    except Exception as e:  # 回填失败不影响主流程
        print("[迁移] 回填 pack_rule 失败:", e)
        db.rollback()
    finally:
        db.close()


def _backfill_sale_product(maker: sessionmaker) -> None:
    """回填 pack 行的 sale_product_id（幂等）：按同单内销售商品的 pack_items 匹配，无匹配保持空。"""
    db = maker()
    try:
        pack_lines = (
            db.query(OutboundLine)
            .filter(OutboundLine.line_type == "pack", OutboundLine.sale_product_id.is_(None))
            .all()
        )
        by_out: dict[int, list[OutboundLine]] = {}
        for pl in pack_lines:
            by_out.setdefault(pl.outbound_id, []).append(pl)
        changed = False
        for out_id, pls in by_out.items():
            sale_lines = (
                db.query(OutboundLine)
                .filter(OutboundLine.outbound_id == out_id, OutboundLine.line_type == "sale")
                .all()
            )
            for pl in pls:
                for sl in sale_lines:
                    p = sl.product
                    if p and any((it.get("product_id") or 0) == pl.product_id for it in (p.pack_items or [])):
                        pl.sale_product_id = sl.product_id
                        changed = True
                        break
        if changed:
            db.commit()
    except Exception as e:  # 回填失败不影响主流程
        print("[迁移] 回填 sale_product_id 失败:", e)
        db.rollback()
    finally:
        db.close()


def _backfill_products(db: Session) -> None:
    """存量商品回填：默认单位、人工工作量、单件净重（幂等，空表自动跳过）。"""
    for p in db.execute(select(Product).where(Product.default_unit == "")).scalars():
        conv = p.conversions or {}
        p.default_unit = "斤" if "斤" in conv else p.base_unit
    for pid in db.execute(select(Product.id).where(Product.category == "人工")).scalars():
        recompute_product(db, pid)
    for p in db.execute(select(Product).where(or_(Product.weight_kg.is_(None), Product.weight_kg == 0))).scalars():
        if (p.base_unit or "") not in ("克", "g"):
            continue
        conv = p.conversions or {}
        gm = float(conv.get(p.default_unit or p.base_unit) or 0)
        if gm > 0:
            p.weight_kg = round(gm / 1000.0, 4)


# 入仓品种子（半加工叶梅）——表为空时写入，幂等。
# 字段：名称, 类目, SKU, 69码, 箱规(袋/箱), 采购价(元/袋,=收入单价), 保质期, 备注, 关联库存商品ID, 每袋净重(默认单位，通常公斤)
_WAREHOUSE_PRODUCT_SEED = [
    ("白拇指玉米", "半加工叶梅", "100024877397", "6978122780046", 25, 25, "半年", "", 131, 1),
    ("紫拇指玉米", "半加工叶梅", "100024227294", "6980027710011", 20, 16, "半年", "给李狮说的30", 236, 0.5),
    ("玉米段1.2kg", "半加工叶梅", "100051680966", "6980027713692", 25, 16, "一年", "", 197, 1.2),
    ("甜玉米粒1000g", "半加工叶梅", "100012495050", "6980027711681", 10, 16, "一年", "", 204, 1),
    ("花糯玉米3斤礼盒装", "半加工叶梅", "100244806952", "6980027712220", 18, 20, "半年", "", 125, 1.5),
    ("白拇指玉米2斤礼盒", "半加工叶梅", "100296324589", "6980027711117", 18, 39, "半年", "", 131, 1),
    ("七彩冻干花生228g", "半加工叶梅", "100172098848", "6980027711131", 15, 26, "", "", 3, 0.228),
    ("冻干黑花生228g", "半加工叶梅", "100306607178", "6980027711148", 15, 28, "", "", 5, 0.228),
]


def seed_warehouse_products(db: Session) -> None:
    """入仓品（半加工叶梅）种子 + 默认配置补齐。

    - 表为空：写入全部种子（运费留空，后续在系统维护）；
    - 表非空：仅对同名种子行补齐「关联库存商品 / 每袋净重」（未配置时），不新增、不覆盖用户改动。
    关联库存商品仅在目标仓确实存在该商品时才写入（避免外键失败）。
    """
    valid_pids = set(db.execute(select(Product.id)).scalars())
    existing = {p.name: p for p in db.execute(select(WarehouseProduct)).scalars()}
    if not existing:
        for name, category, sku, barcode, box_spec, price, shelf_life, remark, spid, bw in _WAREHOUSE_PRODUCT_SEED:
            db.add(
                WarehouseProduct(
                    name=name, category=category, sku=sku, barcode=barcode,
                    box_spec=float(box_spec), purchase_price=float(price), freight=0.0,
                    stock_product_id=spid if spid in valid_pids else None, bag_weight=float(bw),
                    shelf_life=shelf_life, remark=remark, is_active=True,
                )
            )
        db.flush()
        return
    for name, _cat, _sku, _bc, _bs, _price, _sl, _rm, spid, bw in _WAREHOUSE_PRODUCT_SEED:
        p = existing.get(name)
        if not p:
            continue
        if not p.stock_product_id and spid in valid_pids:
            p.stock_product_id = spid
        if not p.bag_weight and bw:
            p.bag_weight = float(bw)
    db.flush()


# 入仓品扣点：使用 Deduction 表，保留类别名「入仓品」表示（在「扣点」页统一维护）
WAREHOUSE_DEDUCTION_CATEGORY = "入仓品"


def ensure_warehouse_deduction(db: Session) -> None:
    """入仓品扣点种子：默认 6%（可在「扣点」页统一维护）。幂等，不覆盖用户后续修改。"""
    if db.scalar(select(Deduction).where(Deduction.category == WAREHOUSE_DEDUCTION_CATEGORY)):
        return
    db.add(Deduction(category=WAREHOUSE_DEDUCTION_CATEGORY, percent=6.0, remark="入仓品采购价（收入）扣点"))
    db.flush()


def _migrate_warehouse_bag_weight(maker: sessionmaker, key: str) -> None:
    """一次性迁移：入仓品「每袋净重」与入仓记录「每袋净重/单位成本」由基础单位(克)换算为默认单位(通常公斤)。

    仅对种子内的入仓品按名称重设；入仓记录按关联库存商品的换算系数换算（金额口径不变）。
    幂等（标记文件控制只跑一次）。
    """
    marker = DATA_DIR / f".wh_bag_weight_kg_{key}"
    if marker.exists():
        return
    db = maker()
    try:
        by_name = {spec[0]: float(spec[9]) for spec in _WAREHOUSE_PRODUCT_SEED}
        for p in db.execute(select(WarehouseProduct)).scalars():
            if p.name in by_name:
                p.bag_weight = by_name[p.name]
        for r in db.execute(select(WarehouseIn)).scalars():
            if not r.stock_product_id:
                continue
            sp = db.get(Product, r.stock_product_id)
            if not sp:
                continue
            du = sp.default_unit or sp.base_unit
            factor = float((sp.conversions or {}).get(du) or 1) or 1.0
            if factor and factor != 1:
                if r.bag_weight:
                    r.bag_weight = round(r.bag_weight / factor, 6)
                if r.unit_cost:
                    r.unit_cost = round(r.unit_cost * factor, 6)
        db.commit()
        marker.write_text("kg\n", encoding="utf-8")
    except Exception as e:
        print("[迁移] 入仓品每袋净重单位换算失败:", e)
        db.rollback()
    finally:
        db.close()


def copy_users(src_key: str, dst_key: str) -> None:
    """把源仓 users 全表复制到目标仓（保持 id 不变）。须在 ensure_seed_users 前调用（目标仓 users 为空）。"""
    src = get_sessionmaker(src_key)()
    dst = get_sessionmaker(dst_key)()
    try:
        for u in src.query(User).all():
            dst.add(
                User(
                    id=u.id, username=u.username, password_hash=u.password_hash,
                    name=u.name, role=u.role, is_active=u.is_active,
                    public_key=u.public_key, fingerprint=u.fingerprint,
                    key_created_at=u.key_created_at, created_at=u.created_at,
                )
            )
        dst.commit()
    finally:
        src.close()
        dst.close()


def _drop_cost_variance_records(db) -> None:
    """清理历史「成本差异」记录：该差额现已按标准 FIFO 直接计入出库成本，避免重复计账。"""
    for f in db.execute(select(FinanceRecord).where(FinanceRecord.category == "成本差异")).scalars():
        db.delete(f)


def _fifo_recompute_once(maker: sessionmaker, key: str) -> None:
    """先进先出(FIFO)成本一次性迁移：全量重算 + 清理历史「成本差异」记录。

    幂等：以 data/.cost_method_fifo_v5_{key} 标记是否已处理（标记丢失只会再算一次，无副作用）。
    重算商品缓存(stock/avg_cost/stock_value)与出库流水金额（超卖部分按后续实际进价回溯修正），
    并同步出库单行/总成本。
    """
    marker = DATA_DIR / f".cost_method_fifo_v5_{key}"
    if marker.exists():
        return
    db = maker()
    try:
        for pid in db.execute(select(Product.id)).scalars():
            recompute_product(db, pid)
        _drop_cost_variance_records(db)
        db.commit()
        marker.write_text("fifo\n", encoding="utf-8")
    except Exception as e:  # 重算失败不影响主流程（下次启动自动重试）
        print("[迁移] FIFO 全量重算失败:", e)
        db.rollback()
    finally:
        db.close()


def ensure_schema(key: str) -> None:
    """只补齐缺失的表结构（不跑迁移/种子/回填）。

    新增表上线时用：每个分仓是独立 db 文件，启动时逐个补建，避免老分仓库缺表报错。
    """
    Base.metadata.create_all(bind=get_engine(key))


def init_warehouse(key: str, copy_users_from: str | None = None) -> None:
    """幂等初始化分仓：建表 + 迁移 + 单位/账号种子 + 回填。"""
    eng = get_engine(key)
    Base.metadata.create_all(bind=eng)
    maker = get_sessionmaker(key)
    migrate(eng, maker)
    db = maker()
    try:
        seed_units(db)
        if copy_users_from:
            copy_users(copy_users_from, key)  # 先拷用户（空表显式 id 插入），再 ensure 兜底
        ensure_seed_users(db)
        _backfill_products(db)
        seed_warehouse_products(db)
        ensure_warehouse_deduction(db)
        db.commit()
    finally:
        db.close()
    _fifo_recompute_once(maker, key)
    _migrate_warehouse_bag_weight(maker, key)
