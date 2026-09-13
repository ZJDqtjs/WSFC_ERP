# -*- coding: utf-8 -*-
"""数据清理：按仓库、按类别细化清除业务数据。

供 keyadmin 页面（HTTP 接口）与 backend/clear_stock.py（命令行）共用。
- 支持指定分仓（默认奥斯迪仓 data/erp.db，其余 data/warehouses/{key}.db）
- 支持按类别细化清除：出库 / 入库 / 入仓 / 库存流水 / 财务流水 / 商品库存归零 / 仅清库存数量
- 清除前自动备份（SQLite 在线备份，兼容 WAL）
"""
from __future__ import annotations

import sqlite3
from datetime import datetime

from .database import DATA_DIR, DEFAULT_WAREHOUSE_KEY, get_warehouses, warehouse_db_path

BACKUP_DIR = DATA_DIR / "backups"

# 清除项定义：key / 名称 / 说明 / 涉及表（实际删除顺序按 _TABLE_ORDER 排序）
CLEAR_ITEMS: list[dict] = [
    {
        "key": "outbounds",
        "name": "出库单（含明细）",
        "desc": "清空出库明细 outbound_lines 与出库单 outbounds",
        "tables": ["outbound_lines", "outbounds"],
    },
    {
        "key": "inbounds",
        "name": "入库单",
        "desc": "清空入库单 inbounds",
        "tables": ["inbounds"],
    },
    {
        "key": "warehouse_ins",
        "name": "入仓记录",
        "desc": "清空入仓记录 warehouse_ins",
        "tables": ["warehouse_ins"],
    },
    {
        "key": "warehouse_products",
        "name": "入仓品资料",
        "desc": "清空入仓品资料 warehouse_products（会一并清空引用它的入仓记录）",
        "tables": ["warehouse_products"],
    },
    {
        "key": "stock_movements",
        "name": "库存流水",
        "desc": "清空库存流水 stock_movements",
        "tables": ["stock_movements"],
    },
    {
        "key": "finance_records",
        "name": "财务流水",
        "desc": "清空财务流水 finance_records",
        "tables": ["finance_records"],
    },
    {
        "key": "stock_reset",
        "name": "商品库存归零（含成本）",
        "desc": "将商品的 stock / avg_cost / stock_value / workload 全部归零",
        "tables": [],
        "reset_fields": ["stock", "avg_cost", "stock_value", "workload"],
    },
    {
        "key": "stock_only",
        "name": "仅清库存（数量与价值）",
        "desc": "仅将商品的 stock / stock_value 归零，保留 avg_cost / workload",
        "tables": [],
        "reset_fields": ["stock", "stock_value"],
    },
]

# 商品库存字段中文标签（用于结果展示）
_STOCK_FIELD_LABELS = {
    "stock": "库存数量",
    "avg_cost": "平均成本",
    "stock_value": "库存价值",
    "workload": "工作量",
}

# 外键安全的删除顺序（子表在前）
_TABLE_ORDER = [
    "outbound_lines",
    "outbounds",
    "inbounds",
    "stock_movements",
    "finance_records",
    "warehouse_ins",
    "warehouse_products",
]

_ITEM_BY_KEY = {it["key"]: it for it in CLEAR_ITEMS}


def warehouse_choices() -> list[dict]:
    """可选分仓列表。"""
    return [
        {"key": w["key"], "name": w.get("name") or w["key"]}
        for w in get_warehouses()
    ]


def all_item_keys() -> list[str]:
    """全部清除类别 key。"""
    return [it["key"] for it in CLEAR_ITEMS]


def _resolve_key(key: str | None) -> str:
    key = (key or "").strip() or DEFAULT_WAREHOUSE_KEY
    valid = [w["key"] for w in get_warehouses()]
    if key not in valid:
        raise ValueError(f"分仓不存在: {key}")
    return key


def _warehouse_name(key: str) -> str:
    for w in get_warehouses():
        if w["key"] == key:
            return w.get("name") or key
    return key


def _connect(key: str) -> sqlite3.Connection:
    conn = sqlite3.connect(warehouse_db_path(key))
    conn.execute("PRAGMA busy_timeout=10000")
    conn.execute("PRAGMA foreign_keys=ON")
    return conn


def _table_exists(conn: sqlite3.Connection, table: str) -> bool:
    return (
        conn.execute(
            "SELECT 1 FROM sqlite_master WHERE type='table' AND name=?", (table,)
        ).fetchone()
        is not None
    )


def _count_table(conn: sqlite3.Connection, table: str) -> int:
    if not _table_exists(conn, table):
        return 0
    return conn.execute(f"SELECT COUNT(*) FROM {table}").fetchone()[0]


def _stock_reset_count(conn: sqlite3.Connection, fields: list[str]) -> int:
    if not _table_exists(conn, "products") or not fields:
        return 0
    cond = " OR ".join(f"{f} != 0" for f in fields)
    return conn.execute(f"SELECT COUNT(*) FROM products WHERE {cond}").fetchone()[0]


def preview(key: str | None = None) -> dict:
    """返回指定分仓各清除项的当前行数（用于页面展示）。"""
    key = _resolve_key(key)
    conn = _connect(key)
    try:
        items = []
        for it in CLEAR_ITEMS:
            if it.get("reset_fields"):
                count = _stock_reset_count(conn, it["reset_fields"])
            else:
                count = sum(_count_table(conn, t) for t in it["tables"])
            items.append(
                {
                    "key": it["key"],
                    "name": it["name"],
                    "desc": it["desc"],
                    "count": count,
                }
            )
        return {"key": key, "name": _warehouse_name(key), "items": items}
    finally:
        conn.close()


def _backup(key: str) -> str | None:
    """清除前备份，返回备份文件名；备份失败返回 None（不阻断清除）。"""
    BACKUP_DIR.mkdir(exist_ok=True)
    prefix = "erp" if key == DEFAULT_WAREHOUSE_KEY else key
    name = (
        f"{prefix}_backup_clear_" + datetime.now().strftime("%Y%m%d_%H%M%S") + ".db"
    )
    target = BACKUP_DIR / name
    src = sqlite3.connect(str(warehouse_db_path(key)))
    dst = sqlite3.connect(str(target))
    try:
        src.backup(dst)
        return name
    except Exception:
        return None
    finally:
        dst.close()
        src.close()


def execute(key: str | None, item_keys: list[str], backup: bool = True) -> dict:
    """清除指定分仓的指定类别数据。返回结果摘要。

    参数:
        key: 分仓 key（None 或空 → 默认奥斯迪仓）
        item_keys: 要清除的类别 key 列表
        backup: 是否在清除前自动备份
    """
    key = _resolve_key(key)
    item_keys = [k for k in item_keys if k in _ITEM_BY_KEY]
    if not item_keys:
        raise ValueError("未选择任何要清除的数据类别")

    # 收集要删除的表（按外键安全顺序去重），以及需要归零的商品库存字段
    tables: list[str] = []
    reset_fields: list[str] = []
    for k in item_keys:
        it = _ITEM_BY_KEY[k]
        for f in it.get("reset_fields", []):
            if f not in reset_fields:
                reset_fields.append(f)
        for t in it["tables"]:
            if t not in tables:
                tables.append(t)
    # 外键依赖：入仓记录 warehouse_ins 引用入仓品 warehouse_products，
    # 仅清空入仓品时需先一并清空入仓记录，避免外键约束失败。
    if "warehouse_products" in tables and "warehouse_ins" not in tables:
        tables.append("warehouse_ins")

    tables.sort(key=lambda t: _TABLE_ORDER.index(t) if t in _TABLE_ORDER else 999)

    backup_name = _backup(key) if backup else None

    conn = _connect(key)
    cleared: dict[str, int] = {}
    try:
        for t in tables:
            if not _table_exists(conn, t):
                continue
            n = _count_table(conn, t)
            conn.execute(f"DELETE FROM {t}")
            cleared[t] = n

        if reset_fields and _table_exists(conn, "products"):
            n = _stock_reset_count(conn, reset_fields)
            set_sql = ", ".join(f"{f} = 0" for f in reset_fields)
            conn.execute(f"UPDATE products SET {set_sql}")
            label = "、".join(_STOCK_FIELD_LABELS.get(f, f) for f in reset_fields)
            cleared[f"products({label}归零)"] = n

        # 重置已清除表的自增序列
        if _table_exists(conn, "sqlite_sequence"):
            for t in tables:
                conn.execute("DELETE FROM sqlite_sequence WHERE name = ?", (t,))

        conn.commit()
    except Exception:
        conn.rollback()
        raise
    finally:
        conn.close()

    return {
        "ok": True,
        "key": key,
        "warehouse": _warehouse_name(key),
        "backup": backup_name,
        "cleared": cleared,
        "total": sum(cleared.values()),
    }
