"""商品资料解耦：独立一键导入/导出/查看状态脚本。

用法（在项目根目录执行）:
    uv run python sync_product_data.py             # 默认：一键导入
    uv run python sync_product_data.py import      # 一键导入（5 个 json 均在 backend/json 时生效）
    uv run python sync_product_data.py export      # 一键导出 5 类到 backend/json
    uv run python sync_product_data.py status      # 查看 json 目录与数据库对照状态

功能：
- 将商品资料拆成 5 个 JSON：units / products_stock / products_order / pack_rules / code_mappings
- 按名称 upsert（不改变已有商品 id），商品间相互引用按名称解析，可跨库/跨设备迁移。
"""
import sys

from app.database import SessionLocal
from app.product_master import export_all, import_all, status


def main():
    args = [a for a in sys.argv[1:] if a in ("import", "export", "status")]
    action = args[0] if args else "import"
    db = SessionLocal()
    try:
        if action == "export":
            print("== 一键导出商品资料 -> backend/json ==")
            r = export_all(db)
            for f in r["files"]:
                print(f"  {f['file']}: {f['count']} 条")
            print(f"已写入 {len(r['files'])} 个文件（{r['exported_at']}）")
        elif action == "status":
            print("== 商品资料 json 目录 vs 数据库 对照 ==")
            s = status(db)
            print(f"目录: {s['dir']}\n")
            print("类型          文件                    数据库   json目录  状态")
            for r in s["rows"]:
                state = "缺失" if not r["exists"] else "已备份"
                print(f"  {r['label']:<12}{r['file']:<24}{r['count_in_db']:<7}"
                      f"{r['count_in_file'] if r['exists'] else '-':<8}{state}")
        else:
            print("== 一键导入商品资料（存在 json 时生效） ==")
            r = import_all(db)
            for s in r["results"]:
                tag = "导入" if s["loaded"] else "跳过"
                extra = ""
                if not s["loaded"]:
                    extra = f"（{s['warnings'][0] if s['warnings'] else ''}）"
                print(f"  {s['label']:<12}{s['file']:<24}{s['created']} 新增 / "
                      f"{s['updated']} 更新  [{tag}]{extra}")
                for w in s.get("warnings", []):
                    print(f"      提醒：{w}")
    finally:
        db.close()


if __name__ == "__main__":
    main()