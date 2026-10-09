"""清理「新建分仓被播种的入仓品资料」模板行（默认只预览，加 --apply 才真删）。

背景：init_warehouse 以前给每个新分仓播种 _WAREHOUSE_PRODUCT_SEED（玉米/花生那套模板清单），
新分仓一建出来就带着这些行，看起来像"别的仓的入仓品串过来了"。现在新分仓不再播种
（见 initdb.init_warehouse 的 seed_catalog 参数），这个脚本用来清掉**已经被种进去、
且没有任何入仓记录**的模板行；有入仓记录的仓（如奥斯迪）一律不动。

判定规则（两条都满足才删）：
  1. 该行的「名称 + SKU」与模板种子一致；
  2. 没有任何入仓记录（warehouse_ins）引用它。

用法（在 backend 目录下）：
    ./.venv/bin/python clean_seed_warehouse_products.py            # 只预览
    ./.venv/bin/python clean_seed_warehouse_products.py --apply    # 真删（会打印删除结果）
    ./.venv/bin/python clean_seed_warehouse_products.py --all      # 连原始仓（奥斯迪）也算

默认**跳过原始仓**（DEFAULT_WAREHOUSE_KEY，如奥斯迪）：那套模板本来就是它自己的货品台账，
只有它不是要清理的对象；要给原始仓也清掉加 --all。

⚠️ 顺序：先上线 seed_catalog 修复，再清（或清完马上上线）。修复没上线时，旧代码在重启/部署时
仍会给「默认分仓」（get_default_key()，如 wh01）重新种一遍，清了也是白清。
"""
import sys

from sqlalchemy import select

from app.database import DEFAULT_WAREHOUSE_KEY, get_sessionmaker, get_warehouses
from app.initdb import _WAREHOUSE_PRODUCT_SEED
from app.models import WarehouseIn, WarehouseProduct

SEED_KEYS = {(spec[0], spec[2]) for spec in _WAREHOUSE_PRODUCT_SEED}   # (名称, SKU)


def main(apply: bool, include_original: bool = False) -> int:
    total = 0
    for w in get_warehouses():
        key, name = w["key"], w.get("name") or w["key"]
        if key == DEFAULT_WAREHOUSE_KEY and not include_original:
            print(f"== {key} {name}：原始仓，跳过（要一起清加 --all）")
            continue
        db = get_sessionmaker(key)()
        try:
            products = list(db.execute(select(WarehouseProduct).order_by(WarehouseProduct.id)).scalars())
            if not products:
                continue
            used = {r.product_id for r in db.execute(select(WarehouseIn)).scalars() if r.product_id}
            hits = [p for p in products if (p.name, p.sku) in SEED_KEYS and p.id not in used]
            if not hits:
                continue
            print(f"== {key} {name}：入仓品 {len(products)} 个，其中可清理的模板行 {len(hits)} 个"
                  f"（其余 {len(products) - len(hits)} 个保留：有入仓记录或不是模板）")
            for p in hits:
                print(f"   - #{p.id} {p.name} | {p.sku} | 采购价 {p.purchase_price}")
            if apply:
                for p in hits:
                    db.delete(p)
                db.commit()
                print(f"   ✓ 已删除 {len(hits)} 行")
            total += len(hits)
        finally:
            db.close()
    print()
    print(("已删除 " if apply else "待清理（预览）") + f"共 {total} 行" + ("" if apply else "；确认没问题再加 --apply 执行"))
    return 0


if __name__ == "__main__":
    args = sys.argv[1:]
    sys.exit(main("--apply" in args, include_original="--all" in args))
