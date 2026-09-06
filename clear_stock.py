# -*- coding: utf-8 -*-
"""快速清空库存脚本：一键重置业务数据。

功能：
1. 先把 erp.db 备份到 data/backups/（一致性备份，含 WAL 数据）
2. 清空 出库明细(outbound_lines)、出库单(outbounds)、入库单(inbounds)、库存流水(stock_movements)、财务流水(finance_records)
3. 将所有商品库存相关字段归零（stock / avg_cost / stock_value / workload）
4. 重置以上表的自增序列，并打印每张表清除的行数

用法（在项目根目录执行）:
    python clear_stock.py
"""
import shutil
import sqlite3
import sys
from datetime import datetime
from pathlib import Path

ROOT = Path(__file__).resolve().parent
DB_PATH = ROOT / "data" / "erp.db"
BACKUP_DIR = ROOT / "data" / "backups"

# 按外键依赖顺序删除
CLEAR_TABLES = [
    "outbound_lines",
    "outbounds",
    "inbounds",
    "stock_movements",
    "finance_records",
]


def main() -> int:
    if not DB_PATH.exists():
        print(f"[错误] 未找到数据库文件: {DB_PATH}")
        return 1

    conn = sqlite3.connect(DB_PATH)
    conn.execute("PRAGMA busy_timeout=10000")
    conn.execute("PRAGMA foreign_keys=ON")

    # 1. 备份（sqlite3 backup API 在 WAL 模式下也能得到一致快照）
    BACKUP_DIR.mkdir(exist_ok=True)
    stamp = datetime.now().strftime("%Y%m%d_%H%M%S")
    bak_path = BACKUP_DIR / f"erp.db.bak_clear_{stamp}"
    with sqlite3.connect(bak_path) as bak_conn:
        conn.backup(bak_conn)
    print(f"[1/4] 已备份数据库 -> {bak_path}")

    # 2. 清空业务记录表
    try:
        counts = {}
        for table in CLEAR_TABLES:
            cur = conn.execute(f"SELECT COUNT(*) FROM {table}")
            counts[table] = cur.fetchone()[0]
            conn.execute(f"DELETE FROM {table}")
        # 3. 商品库存字段归零
        conn.execute(
            "UPDATE products SET stock = 0, avg_cost = 0, stock_value = 0, workload = 0"
        )
        # 4. 重置自增序列（表不存在则跳过）
        has_seq = conn.execute(
            "SELECT 1 FROM sqlite_master WHERE type='table' AND name='sqlite_sequence'"
        ).fetchone()
        if has_seq:
            for table in CLEAR_TABLES:
                conn.execute("DELETE FROM sqlite_sequence WHERE name = ?", (table,))
        conn.commit()
    except Exception as e:
        conn.rollback()
        print(f"[错误] 执行失败，已回滚，数据未改动: {e}")
        return 1
    finally:
        conn.close()

    print("[2/4] 业务记录已清空:")
    for table in CLEAR_TABLES:
        print(f"      - {table}: 清除 {counts[table]} 行")
    print("[3/4] 所有商品库存已归零（stock / avg_cost / stock_value / workload = 0）")
    print("[4/4] 自增序列已重置")
    print("完成！建议重启后端服务后刷新页面查看效果。")
    return 0


if __name__ == "__main__":
    sys.exit(main())
