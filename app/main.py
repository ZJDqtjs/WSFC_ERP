import asyncio
import json
import os
from contextlib import asynccontextmanager
from pathlib import Path

from fastapi import FastAPI
from fastapi.middleware.cors import CORSMiddleware
from fastapi.staticfiles import StaticFiles
from sqlalchemy import select, text

from .auth import ensure_seed_users
from .database import Base, DATA_DIR, SessionLocal, engine
from .models import Product
from .routers import ai, auth, backup, fresh, imports, inbound, inventory, outbound, products, report
from .routers.backup import create_backup_file, load_config
from .services import recompute_product, seed_units

# 桌面 Web 前端目录（app/main.py -> 项目根/static）
STATIC_DIR = Path(__file__).resolve().parent.parent / "static"
CONFIG_PATH = Path(__file__).resolve().parent.parent / "config.json"
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
app.include_router(inbound.router)
app.include_router(outbound.router)
app.include_router(inventory.router)
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
