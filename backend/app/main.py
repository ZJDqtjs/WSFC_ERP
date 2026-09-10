import asyncio
import json
import os
import re
from contextlib import asynccontextmanager
from pathlib import Path

from fastapi import FastAPI
from fastapi.middleware.cors import CORSMiddleware
from fastapi.staticfiles import StaticFiles
from sqlalchemy import or_, select, text

from .auth import ensure_seed_users
from .database import Base, DATA_DIR, SessionLocal, engine
from .models import Product
from .routers import ai, auth, backup, deductions, express, fresh, imports, inbound, inventory, outbound, pack_rules, product_data, products, report
from .routers.backup import create_backup_file, load_config
from .services import recompute_product, seed_units

# 桌面 Web 前端目录（WSFC_ERP/web/static，前后端分离；SERVE_STATIC=1 时后端顺带托管）
STATIC_DIR = Path(__file__).resolve().parent.parent.parent / "web" / "static"
# 根配置位于 WSFC_ERP 根目录
CONFIG_PATH = Path(__file__).resolve().parent.parent.parent / "config.json"
with CONFIG_PATH.open(encoding="utf-8") as config_file:
    ROUTES = json.load(config_file).get("routes", {})
API_ROUTE = ROUTES.get("api", "/api").rstrip("/") or "/api"
UPLOAD_ROUTE = ROUTES.get("uploads", "/uploads").rstrip("/") or "/uploads"

# 前后端分离：默认后端只提供 API（SERVE_STATIC=0，由 nginx / web/serve.py 托管前端）。
# 需要单进程一体化预览时，设 SERVE_STATIC=1 让后端顺带托管 static/。
SERVE_STATIC = os.getenv("SERVE_STATIC", "0") in ("1", "true", "yes", "on")


def migrate():
    """轻量迁移：为已存在的库补充新增列。"""
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
    _backfill_sale_product()
    _backfill_pack_rule()

    # 一单多货规则表：箱型号关联清单（新增列）
    with engine.connect() as conn:
        prcols = [r[1] for r in conn.execute(text("PRAGMA table_info(pack_rules)")).fetchall()]
        if "box_items" not in prcols:
            conn.execute(text("ALTER TABLE pack_rules ADD COLUMN box_items JSON"))
            conn.commit()
    _backfill_pack_rule_box_items()
    _backfill_gross_sales()


def _backfill_gross_sales():
    """历史出库销售行回填「扣点前销售金额」：按备注里的店铺扣点把 gross_sales=0 的扣点单行还原（幂等）。

    新导入的单由 imports.py 在解析时精确截取扣点前金额，无需本回填；
    此函数只针对修复前已导入（gross_sales 为 0）的扣点行做近似还原。
    """
    from .database import SessionLocal
    from .models import Outbound

    db = SessionLocal()
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


def _backfill_pack_rule_box_items():
    """回填 pack_rules.box_items：把旧 box_type 文本解析并关联到包材纸箱（幂等）。"""
    from .database import SessionLocal
    from .models import PackRule

    db = SessionLocal()
    try:
        for r in db.execute(select(PackRule)).scalars():
            if r.box_items:
                continue
            items = None
            # 从 box_type 解析：'7号+8号' / '6号*2+7号*2'
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


def _backfill_pack_rule():
    """回填出库单的 pack_rule_name / pack_rule_id（幂等）：从 remark 解析「一单多货·规则：xxx）」。"""
    from .database import SessionLocal
    from .models import Outbound, PackRule

    db = SessionLocal()
    try:
        from sqlalchemy import select

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


def _backfill_sale_product():
    """回填 pack 行的 sale_product_id（幂等）：按同单内销售商品的 pack_items 匹配，无匹配保持空。"""
    from .database import SessionLocal
    from .models import OutboundLine

    db = SessionLocal()
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


async def auto_backup_loop():
    """每 60 秒检查一次；开启自动备份且距上次备份超过间隔则执行备份。"""
    import time as _time

    last = _time.monotonic()
    while True:
        await asyncio.sleep(60)
        cfg = load_config()
        if not cfg.get("enabled", True):
            last = _time.monotonic()
            continue
        interval = max(0.5, float(cfg.get("interval_hours", 2))) * 3600
        if _time.monotonic() - last >= interval:
            try:
                create_backup_file()
            except Exception as e:  # 自动备份失败不影响主流程
                print("[自动备份] 失败:", e)
            last = _time.monotonic()


@asynccontextmanager
async def lifespan(app: FastAPI):
    Base.metadata.create_all(bind=engine)
    migrate()  # 为旧库补充新增列（新库已含全部列，自动跳过）
    db = SessionLocal()
    try:
        seed_units(db)
        ensure_seed_users(db)
        # 回填存量商品的默认展示/出库单位：有「斤」换算则默认斤，否则用基础单位
        for p in db.execute(select(Product).where(Product.default_unit == "")).scalars():
            conv = p.conversions or {}
            p.default_unit = "斤" if "斤" in conv else p.base_unit
        # 回填人工商品的工作量（人工不记库存，重算后 stock=0、workload=历史绝对值之和）
        for pid in db.execute(select(Product.id).where(Product.category == "人工")).scalars():
            recompute_product(db, pid)
        # 默认维护商品单件净重：重量类商品按「默认单位的克数」自动折算为 kg，未设置的不重复覆盖
        for p in db.execute(select(Product).where(or_(Product.weight_kg.is_(None), Product.weight_kg == 0))).scalars():
            if (p.base_unit or "") not in ("克", "g"):
                continue
            conv = p.conversions or {}
            gm = float(conv.get(p.default_unit or p.base_unit) or 0)
            if gm > 0:
                p.weight_kg = round(gm / 1000.0, 4)
        db.commit()
    finally:
        db.close()
    # 启动时若开启自动备份则立即生成一份，此后按间隔由后台任务执行
    if load_config().get("enabled", True):
        try:
            create_backup_file()
        except Exception as e:
            print("[自动备份] 启动备份失败:", e)
    task = asyncio.create_task(auto_backup_loop())
    yield
    task.cancel()


app = FastAPI(title="企业台账系统", lifespan=lifespan)


@app.middleware("http")
async def normalize_api_route(request, call_next):
    if API_ROUTE != "/api" and request.scope["path"].startswith(API_ROUTE + "/"):
        request.scope["path"] = "/api" + request.scope["path"][len(API_ROUTE):]
    return await call_next(request)

app.add_middleware(
    CORSMiddleware,
    allow_origins=["*"],
    allow_methods=["*"],
    allow_headers=["*"],
)

app.include_router(auth.router)
app.include_router(products.router)
app.include_router(product_data.router)
app.include_router(inbound.router)
app.include_router(outbound.router)
app.include_router(inventory.router)
app.include_router(pack_rules.router)
app.include_router(deductions.router)
app.include_router(express.router)
app.include_router(report.router)
app.include_router(imports.router)
app.include_router(backup.router)
app.include_router(ai.router)
app.include_router(fresh.router)

# AI 票据图片上传目录：记录备注可引用 /uploads/xxx.jpg 预览
UPLOAD_DIR = Path(__file__).resolve().parent.parent / "data" / "uploads"
UPLOAD_DIR.mkdir(parents=True, exist_ok=True)
app.mount(UPLOAD_ROUTE, StaticFiles(directory=str(UPLOAD_DIR)), name="uploads")

# 前后端分离：默认不托管前端静态文件（由 nginx / web/serve.py 提供）
if SERVE_STATIC:
    app.mount("/", StaticFiles(directory=str(STATIC_DIR), html=True), name="static")
