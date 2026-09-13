# -*- coding: utf-8 -*-
"""细化清除业务数据脚本（命令行入口）。

功能已并入 keyadmin 页面，此脚本保留命令行用法，支持：
- 指定分仓（--key，默认奥斯迪仓）
- 指定清除类别（--items，逗号分隔或 all）
- 清除前自动备份（--no-backup 可跳过）

用法（在 backend 目录执行，或任意目录均可）:
    python clear_stock.py --list
    python clear_stock.py                              # 默认：清空奥斯迪仓全部业务数据
    python clear_stock.py --key aosidi --items inbounds,stock_movements
    python clear_stock.py --key aosidi --items all --no-backup
"""
import argparse
import sys
from pathlib import Path

# 保证任意工作目录下都能 import app 包
sys.path.insert(0, str(Path(__file__).resolve().parent))

from app.clear_data import (  # noqa: E402
    CLEAR_ITEMS,
    DEFAULT_WAREHOUSE_KEY,
    all_item_keys,
    execute,
    preview,
    warehouse_choices,
)


def main(argv: list[str] | None = None) -> int:
    parser = argparse.ArgumentParser(description="细化清除业务数据")
    parser.add_argument("--key", default=DEFAULT_WAREHOUSE_KEY, help="分仓 key（默认奥斯迪仓）")
    parser.add_argument("--items", default="all", help="逗号分隔的清除类别 key，或 all（全部）")
    parser.add_argument("--no-backup", action="store_true", help="清除前不备份")
    parser.add_argument("--list", action="store_true", help="列出分仓与清除类别后退出")
    args = parser.parse_args(argv)

    if args.list:
        print("可选分仓:")
        for w in warehouse_choices():
            mark = "（默认）" if w["key"] == DEFAULT_WAREHOUSE_KEY else ""
            print(f"  {w['key']:<16} {w['name']} {mark}".rstrip())
        print("\n可清除类别:")
        for it in CLEAR_ITEMS:
            print(f"  {it['key']:<20} {it['name']} —— {it['desc']}")
        return 0

    item_keys = (
        all_item_keys()
        if args.items.strip().lower() == "all"
        else [k.strip() for k in args.items.split(",") if k.strip()]
    )

    try:
        p = preview(args.key)
    except ValueError as e:
        print(f"[错误] {e}")
        return 1

    print("=" * 46)
    print(f"  目标分仓: {p['name']}（{p['key']}）")
    print("-" * 46)
    print("  将清除以下类别:")
    for it in p["items"]:
        if it["key"] in item_keys:
            print(f"    - {it['name']}: 当前 {it['count']} 行")
    print("-" * 46)
    if args.no_backup:
        print("  注意：已指定 --no-backup，清除前不会备份！")
    print("=" * 46)

    confirm = input("确认执行清除？输入 yes 继续: ").strip().lower()
    if confirm != "yes":
        print("已取消")
        return 0

    try:
        result = execute(args.key, item_keys, backup=not args.no_backup)
    except ValueError as e:
        print(f"[错误] {e}")
        return 1
    except Exception as e:
        print(f"[错误] 清除失败: {e}")
        return 1

    print(f"完成！分仓「{result['warehouse']}」清除结果:")
    for table, n in result["cleared"].items():
        print(f"  - {table}: 清除 {n} 行")
    print(f"  合计: {result['total']} 行")
    if result["backup"]:
        print(f"  已备份: {result['backup']}")
    return 0


if __name__ == "__main__":
    sys.exit(main())
