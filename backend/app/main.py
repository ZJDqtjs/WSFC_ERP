import asyncio
import json
import os
from contextlib import asynccontextmanager
from pathlib import Path

from fastapi import FastAPI
from fastapi.middleware.cors import CORSMiddleware
from fastapi.middleware.gzip import GZipMiddleware
from fastapi.staticfiles import StaticFiles

from .database import (
    DEFAULT_WAREHOUSE_KEY,
    get_default_key,
    get_warehouses,
    set_request_key,
)
from .initdb import init_warehouse
from .routers import ai, auth, backup, deductions, express, fresh, imports, inbound, inventory, outbound, pack_rules, product_data, products, report, uploads, warehouse_in, warehouses
from .routers.backup import create_backup_file, load_config

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


class WarehouseScopeMiddleware:
    """把「当前分仓」从进程全局改为**请求级**：按登录 cookie 里的会话令牌解析本次请求属于哪个仓。

    这是"一人切仓，全员被登出"的根因修复：分仓随会话走，服务端不再有全局当前仓，
    谁的会话在哪个仓互不影响。请求结束即清空，绝不外泄到其他请求。
    """

    def __init__(self, app):
        self.app = app

    async def __call__(self, scope, receive, send):
        if scope["type"] != "http":
            await self.app(scope, receive, send)
            return
        from starlette.requests import Request as _Request

        from .auth import COOKIE_NAME, token_warehouse

        token = _Request(scope).cookies.get(COOKIE_NAME)
        set_request_key(token_warehouse(token))
        try:
            await self.app(scope, receive, send)
        finally:
            set_request_key(None)


def _backup_all_warehouses() -> None:
    """逐个分仓备份。

    分仓改为"随登录会话"之后，服务端已不存在唯一的"当前仓"，因此自动备份必须覆盖全部
    已注册分仓，否则只有默认仓有备份。
    """
    for w in get_warehouses():
        try:
            create_backup_file(w["key"])
        except Exception as e:  # 单个仓失败不影响其他仓
            print(f"[自动备份] {w.get('key')} 失败:", e)


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
            _backup_all_warehouses()
            last = _time.monotonic()


@asynccontextmanager
async def lifespan(app: FastAPI):
    # 1) 默认仓（奥斯迪）初始化（幂等）
    init_warehouse(DEFAULT_WAREHOUSE_KEY)
    # 2) 初始化默认分仓（新登录会话的起点）：与奥斯迪不同时也初始化（防 db 文件在但表/种子缺失）
    default_key = get_default_key()
    if default_key != DEFAULT_WAREHOUSE_KEY:
        init_warehouse(default_key)
    # 3) 启动时若开启自动备份则立即为各分仓各生成一份，此后按间隔由后台任务执行
    if load_config().get("enabled", True):
        _backup_all_warehouses()
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
# gzip 压缩：移动端/公网体积大的 JSON 响应显著减小传输量（桌面内网提升有限，弱网收益大）
app.add_middleware(GZipMiddleware, minimum_size=500)
# 分仓随登录会话（请求级），必须早于业务路由生效
app.add_middleware(WarehouseScopeMiddleware)

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
app.include_router(uploads.router)
app.include_router(fresh.router)
app.include_router(warehouse_in.router)
app.include_router(warehouses.router)

# AI 票据图片上传目录：记录备注可引用 /uploads/xxx.jpg 预览
UPLOAD_DIR = Path(__file__).resolve().parent.parent / "data" / "uploads"
UPLOAD_DIR.mkdir(parents=True, exist_ok=True)
app.mount(UPLOAD_ROUTE, StaticFiles(directory=str(UPLOAD_DIR)), name="uploads")

# 前后端分离：默认不托管前端静态文件（由 nginx / web/serve.py 提供）
if SERVE_STATIC:
    app.mount("/", StaticFiles(directory=str(STATIC_DIR), html=True), name="static")
