"""包材 / 人工 分类数据同步：
1) 将数据库中「包材」「人工」两类的商品档案导出备份到 json/ 目录（packaging.json / labor.json）
2) 再从这两个 json 文件重新导入（按名称 upsert：存在则更新成本/规格，不存在则新建）

说明：只同步 包材/人工 两类商品；按名称 upsert，不会改变已有商品 id，
因此订单商品 pack_items（关联结算清单）中的引用不受影响。
"""
import json
from pathlib import Path

from app.database import SessionLocal
from app.models import Product

ROOT = Path(__file__).resolve().parent
JSON_DIR = ROOT / "json"

# 需要独立备份/重导入的两个分类：分类名 → (json 文件名, 单位)
CATEGORIES = {
    "包材": {"file": "packaging.json", "unit": "个"},
    "人工": {"file": "labor.json", "unit": "单"},
}


def export(db):
    JSON_DIR.mkdir(exist_ok=True)
    for cat, cfg in CATEGORIES.items():
        rows = (
            db.query(Product)
            .filter(Product.category == cat)
            .order_by(Product.id)
            .all()
        )
        payload = {
            "category": cat,
            "unit": cfg["unit"],
            "products": [
                {
                    "name": p.name,
                    "unit_cost": p.unit_cost,
                    "spec": p.spec,
                    "product_type": p.product_type,
                }
                for p in rows
            ],
        }
        fp = JSON_DIR / cfg["file"]
        fp.write_text(json.dumps(payload, ensure_ascii=False, indent=2), encoding="utf-8")
        print(f"  备份 {cat}: {len(payload['products'])} 条 -> {fp.name}")


def import_(db):
    total = 0
    for cat, cfg in CATEGORIES.items():
        fp = JSON_DIR / cfg["file"]
        if not fp.exists():
            print(f"  跳过 {cat}: 缺少 {fp.name}")
            continue
        payload = json.loads(fp.read_text(encoding="utf-8"))
        unit = payload.get("unit", cfg["unit"])
        existing = {
            p.name: p for p in db.query(Product).filter(Product.category == cat).all()
        }
        for it in payload["products"]:
            name = str(it.get("name", "")).strip()
            if not name:
                continue
            p = existing.get(name)
            if p:
                p.unit_cost = float(it.get("unit_cost", p.unit_cost))
                p.spec = str(it.get("spec", p.spec))
                p.product_type = it.get("product_type", p.product_type)
            else:
                p = Product(
                    name=name,
                    category=cat,
                    product_type=it.get("product_type", "stock"),
                    base_unit=unit,
                    default_unit=unit,
                    conversions={unit: 1},
                    unit_cost=float(it.get("unit_cost", 0)),
                    spec=str(it.get("spec", "")),
                    is_active=True,
                )
                db.add(p)
                existing[name] = p
            total += 1
        db.commit()
        print(f"  导入 {cat}: {len(payload['products'])} 条（按名称 upsert）")
    return total


def main():
    db = SessionLocal()
    try:
        print("== 1) 备份 包材 / 人工 -> json/ ==")
        export(db)
        print("\n== 2) 从 json/ 重新导入 ==")
        n = import_(db)
        counts = {
            cat: db.query(Product).filter(Product.category == cat).count()
            for cat in CATEGORIES
        }
        print(
            f"\n== 完成：共 upsert {n} 条，"
            f"当前 包材 {counts['包材']} 条、人工 {counts['人工']} 条 =="
        )
    finally:
        db.close()


if __name__ == "__main__":
    main()
