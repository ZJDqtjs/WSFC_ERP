import asyncio
from contextlib import asynccontextmanager
from pathlib import Path

from fastapi import FastAPI
from fastapi.middleware.cors import CORSMiddleware
from fastapi.staticfiles import StaticFiles
from sqlalchemy import select, text

from .auth import ensure_seed_users
from .database import Base, DATA_DIR, SessionLocal, engine
from .models import Product
from .routers import auth, backup, imports, inbound, inventory, outbound, products, report
from .routers.backup import create_backup_file, load_config
from .services import seed_units

STATIC_DIR = Path(__file__).resolve().parent.parent / "static"


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
        conn.commit()


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

app.add_middleware(
    CORSMiddleware,
    allow_origins=["*"],
    allow_methods=["*"],
    allow_headers=["*"],
)

app.include_router(auth.router)
app.include_router(products.router)
app.include_router(inbound.router)
app.include_router(outbound.router)
app.include_router(inventory.router)
app.include_router(report.router)
app.include_router(imports.router)
app.include_router(backup.router)

app.mount("/", StaticFiles(directory=str(STATIC_DIR), html=True), name="static")
