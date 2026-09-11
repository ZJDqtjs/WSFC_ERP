"""数据库连接层（分仓感知）。

每个分仓一套独立 SQLite 数据库文件；「奥斯迪仓」(key=aosidi) 使用历史文件 data/erp.db，
其余分仓使用 data/warehouses/{key}.db。get_db() 依赖在每次请求创建时按当前分仓绑定 session，
切仓后新请求自动走新仓；当前分仓为服务端全局状态（进程内缓存 + data/warehouses.json 持久化）。
"""
import json
import os
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


_current_key_cache: str | None = None


def get_current_key() -> str:
    global _current_key_cache
    if _current_key_cache is None:
        d = load_warehouses()
        keys = [w["key"] for w in d["list"]]
        if d.get("current") not in keys:  # 兜底：current 指向不存在仓
            d["current"] = keys[0] if keys else DEFAULT_WAREHOUSE_KEY
            save_warehouses(d)
        _current_key_cache = d["current"]
    return _current_key_cache


def set_current_key(key: str) -> None:
    global _current_key_cache
    d = load_warehouses()
    if key not in [w["key"] for w in d["list"]]:
        raise ValueError(f"分仓不存在: {key}")
    d["current"] = key
    save_warehouses(d)
    _current_key_cache = key


def current_warehouse_name() -> str:
    k = get_current_key()
    for w in get_warehouses():
        if w["key"] == k:
            return w.get("name", k)
    return k


# ---------------- Session 依赖 ----------------
def get_db():
    """当前分仓的会话（每次请求创建，切仓后新请求自动走新仓）。"""
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
