"""数据库连接层（分仓感知）。

每个分仓一套独立 SQLite 数据库文件；「奥斯迪仓」(key=aosidi) 使用历史文件 data/erp.db，
其余分仓使用 data/warehouses/{key}.db。

「当前分仓」是**请求级**状态：登录会话把自己的分仓写在会话令牌里（payload.wh），
由 app.main.WarehouseScopeMiddleware 每请求解析后写入下面的上下文变量。因此每个用户各自
持有自己的分仓——某人切仓只影响他自己，不会让其他在线用户的令牌失效（不再"全员掉线"）。

请求外（进程启动、后台任务）没有请求上下文，一律使用「默认分仓」
（data/warehouses.json 的 current；新登录会话从它起步）。

例外：账号注册表 users 固定在默认仓（由 keyadmin 维护），登录与鉴权以它为准，
业务数据才按当前分仓隔离。
"""
import json
import os
from contextvars import ContextVar
from datetime import datetime
from pathlib import Path

from sqlalchemy import create_engine, event
from sqlalchemy.engine import Engine
from sqlalchemy.orm import DeclarativeBase, sessionmaker

BASE_DIR = Path(__file__).resolve().parent.parent
DATA_DIR = BASE_DIR / "data"
DATA_DIR.mkdir(exist_ok=True)

DEFAULT_WAREHOUSE_KEY = "aosidi"
WAREHOUSES_FILE = DATA_DIR / "warehouses.json"
WAREHOUSES_DIR = DATA_DIR / "warehouses"
WAREHOUSES_DIR.mkdir(exist_ok=True)

# 默认仓路径（历史文件），保持旧符号兼容
DB_PATH = DATA_DIR / "erp.db"


def _set_sqlite_pragma(dbapi_connection, connection_record):
    cursor = dbapi_connection.cursor()
    cursor.execute("PRAGMA journal_mode=WAL")
    cursor.execute("PRAGMA foreign_keys=ON")
    cursor.execute("PRAGMA busy_timeout=10000")
    cursor.close()


def _make_engine(db_path: Path) -> Engine:
    eng = create_engine(
        f"sqlite:///{db_path}",
        connect_args={"check_same_thread": False},
        echo=False,
    )
    event.listen(eng, "connect", _set_sqlite_pragma)
    return eng


def warehouse_db_path(key: str) -> Path:
    """aosidi 用老文件 erp.db，其余用 data/warehouses/{key}.db。"""
    return DB_PATH if key == DEFAULT_WAREHOUSE_KEY else WAREHOUSES_DIR / f"{key}.db"


_ENGINES: dict[str, Engine] = {}
_MAKERS: dict[str, sessionmaker] = {}


def get_engine(key: str) -> Engine:
    if key not in _ENGINES:
        _ENGINES[key] = _make_engine(warehouse_db_path(key))
    return _ENGINES[key]


def get_sessionmaker(key: str) -> sessionmaker:
    if key not in _MAKERS:
        _MAKERS[key] = sessionmaker(bind=get_engine(key), autoflush=False, autocommit=False)
    return _MAKERS[key]


# ---- 兼容旧引用：默认仓（奥斯迪） ----
engine = _make_engine(DB_PATH)
_ENGINES[DEFAULT_WAREHOUSE_KEY] = engine
SessionLocal = sessionmaker(bind=engine, autoflush=False, autocommit=False)
_MAKERS[DEFAULT_WAREHOUSE_KEY] = SessionLocal


class Base(DeclarativeBase):
    pass


# ---------------- 分仓注册表与当前分仓状态 ----------------
def load_warehouses() -> dict:
    """读取注册表；文件缺失时创建默认注册表（奥斯迪仓）。"""
    if not WAREHOUSES_FILE.exists():
        d = {
            "current": DEFAULT_WAREHOUSE_KEY,
            "list": [
                {
                    "key": DEFAULT_WAREHOUSE_KEY,
                    "name": "奥斯迪仓",
                    "db": "erp.db",
                    "created_at": datetime.now().isoformat(timespec="seconds"),
                }
            ],
        }
        save_warehouses(d)
        return d
    try:
        return json.loads(WAREHOUSES_FILE.read_text(encoding="utf-8"))
    except Exception:
        return {"current": DEFAULT_WAREHOUSE_KEY, "list": []}


def save_warehouses(d: dict) -> None:
    tmp = WAREHOUSES_FILE.with_suffix(".json.tmp")  # 原子写，防断电损坏
    tmp.write_text(json.dumps(d, ensure_ascii=False, indent=2), encoding="utf-8")
    os.replace(tmp, WAREHOUSES_FILE)


def get_warehouses() -> list[dict]:
    return load_warehouses()["list"]


def register_warehouse(key: str, name: str) -> dict:
    d = load_warehouses()
    if any(w["key"] == key for w in d["list"]):
        raise ValueError(f"分仓 key 已存在: {key}")
    wh = {
        "key": key,
        "name": name,
        "db": f"warehouses/{key}.db",
        "created_at": datetime.now().isoformat(timespec="seconds"),
    }
    d["list"].append(wh)
    save_warehouses(d)
    return wh


def key_exists(key: str) -> bool:
    """分仓是否已注册（用于校验会话令牌里携带的分仓 key）。"""
    return any(w["key"] == key for w in get_warehouses())


# ---- 默认分仓：持久化在 warehouses.json 的 current，新登录会话从这里起步 ----
_default_key_cache: str | None = None


def get_default_key() -> str:
    global _default_key_cache
    if _default_key_cache is None:
        d = load_warehouses()
        keys = [w["key"] for w in d["list"]]
        if d.get("current") not in keys:  # 兜底：current 指向不存在仓
            d["current"] = keys[0] if keys else DEFAULT_WAREHOUSE_KEY
            save_warehouses(d)
        _default_key_cache = d["current"]
    return _default_key_cache


def set_current_key(key: str) -> None:
    """设置默认分仓（持久化）。

    只影响「之后新登录的会话起点」，**不会**改变任何在线会话，也不影响业务接口的当前分仓
    （业务接口按登录会话自己的分仓走）——所以以前"切仓把所有人登出"的问题不复存在。
    """
    global _default_key_cache
    d = load_warehouses()
    if key not in [w["key"] for w in d["list"]]:
        raise ValueError(f"分仓不存在: {key}")
    d["current"] = key
    save_warehouses(d)
    _default_key_cache = key


# ---- 当前分仓：请求级，随登录会话；由 WarehouseScopeMiddleware 每请求设置 ----
_request_key_var: ContextVar[str | None] = ContextVar("erp_request_warehouse", default=None)


def set_request_key(key: str | None) -> None:
    """设置本请求（本登录会话）的分仓；None = 无请求上下文/无有效会话，回退默认分仓。"""
    _request_key_var.set(key)


def get_current_key() -> str:
    """当前分仓：请求内取该登录会话自己的分仓，请求外取默认分仓。"""
    return _request_key_var.get() or get_default_key()


def current_warehouse_name(key: str | None = None) -> str:
    k = key or get_current_key()
    for w in get_warehouses():
        if w["key"] == k:
            return w.get("name", k)
    return k


def resolve_key(wh: str = "") -> str:
    """把请求里的 ?wh= 参数解析成分仓 key：有效则用它，否则用本登录会话的分仓。"""
    return wh if (wh and key_exists(wh)) else get_current_key()


# ---------------- Session 依赖 ----------------
def get_db():
    """当前分仓的会话（每次请求创建；按登录会话的分仓，切仓后新请求自动走新仓）。"""
    db = get_sessionmaker(get_current_key())()
    try:
        yield db
    finally:
        db.close()


def get_db_default():
    """钉死在默认仓（奥斯迪）的会话，供 keyadmin 等独立入口使用。"""
    db = SessionLocal()
    try:
        yield db
    finally:
        db.close()


def get_db_wh(wh: str = ""):
    """带 ?wh= 的分仓会话：用于报表「单仓总览」手动切换查看其他分仓。

    只影响本次查询的**数据来源**，不改变你的工作分仓（不改令牌），因此看完不用切回来。
    """
    db = get_sessionmaker(resolve_key(wh))()
    try:
        yield db
    finally:
        db.close()


# ERP 登录/鉴权用的「账号注册表」会话：用户、私钥指纹、角色统一由 keyadmin 维护在默认仓。
# 鉴权固定在注册表上，可避免「切到某仓后因该仓没有这个账号而被判 401 掉线」。
get_user_db = get_db_default
