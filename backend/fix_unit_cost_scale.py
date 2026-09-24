"""修复历史「参考成本」被按默认单位填进基础单位字段的商品（放大 f 倍）。

历史问题：
- 「参考成本」unit_cost 在库里统一按**基础单位**存（重量类 = 元/克）。
- 早期商品编辑页的价格输入框是按**基础单位**填的，界面标签却只写「参考成本」，
  于是重量类商品（1 公斤 = 1000 克）填 5.8 会存成 5.8 元/克 = 5800 元/公斤。
- 前端已改为按默认单位填（填 5.8 元/公斤 → 存 0.0058 元/克），但历史数据仍是错的。

判定规则（只动证据确凿的记录）：
    f = conversions[默认单位] > 1
    avg_cost > 0（库存均价由真实入库价算出，是可信基准）
    unit_cost / avg_cost == f（误差 < 1e-6）
  → unit_cost 被放大了 f 倍，修正为 unit_cost / f。

另外会列出「存疑但未自动改」的记录（无库存均价可比对，且换算后单价异常大），供人工确认。

用法:
    python fix_unit_cost_scale.py          # dry-run，仅打印将要修改的内容
    python fix_unit_cost_scale.py --apply  # 实际写入
"""
import sys

from app.database import get_sessionmaker, get_warehouses
from app.models import Product

APPLY = "--apply" in sys.argv

# 换算后「元/默认单位」超过这个值就提示人工看一眼（避免误改松茸/虫草这类高价货）
SUSPICIOUS_DISPLAY_PRICE = 1000.0


def _factor(p: Product) -> float:
    du = p.default_unit or p.base_unit
    try:
        return float((p.conversions or {}).get(du) or 1) or 1.0
    except Exception:
        return 1.0


def scan(db, wh_name: str) -> tuple[list[tuple], list[tuple]]:
    """返回 (待修复列表, 存疑列表)。"""
    to_fix, suspicious = [], []
    for p in db.query(Product).order_by(Product.id).all():
        uc = float(p.unit_cost or 0)
        if uc <= 0:
            continue
        f = _factor(p)
        if f <= 1:
            continue
        ac = float(p.avg_cost or 0)
        du = p.default_unit or p.base_unit
        if ac > 0 and abs(uc / ac - f) / f < 1e-6:
            to_fix.append((wh_name, p, f, ac, uc, round(uc / f, 8)))
        elif ac <= 0 and round(uc * f, 4) >= SUSPICIOUS_DISPLAY_PRICE:
            suspicious.append((wh_name, p, f, ac, uc, round(uc * f, 4)))
    return to_fix, suspicious


def main() -> int:
    warehouses = get_warehouses() or []
    if not warehouses:
        print("未找到任何分仓")
        return 0

    total_fixed = 0
    for wh in warehouses:
        key, name = wh.get("key"), wh.get("name") or wh.get("key")
        maker = get_sessionmaker(key)
        db = maker()
        try:
            to_fix, suspicious = scan(db, name)
            print(f"==== 分仓 {name}（{key}） ====")
            if not to_fix:
                print("  无需修复")
            for wh_name, p, f, ac, uc, new_uc in to_fix:
                print(
                    f"  [修复] #{p.id} {p.name}：参考成本 {uc} → {new_uc}"
                    f"（默认单位 {p.default_unit or p.base_unit}，1{p.default_unit or p.base_unit}={f:g}{p.base_unit}；"
                    f"库存均价 {ac}/{p.base_unit} = {round(ac * f, 4)} 元/{p.default_unit or p.base_unit}）"
                )
                if APPLY:
                    p.unit_cost = new_uc
                    total_fixed += 1
            if suspicious:
                print("  [存疑·未自动改] 无库存均价可比对，换算后单价异常大：")
                for wh_name, p, f, ac, uc, disp in suspicious:
                    print(
                        f"    #{p.id} {p.name}：参考成本 {uc}（= {disp} 元/{p.default_unit or p.base_unit}），"
                        f"若本意是 {disp} 元/{p.default_unit or p.base_unit} 请改成 {round(uc / f, 8)}"
                    )
            if APPLY and to_fix:
                db.commit()
        finally:
            db.close()
        print("")

    if APPLY:
        print(f"已修复 {total_fixed} 条")
    else:
        print("dry-run 结束；确认无误后加 --apply 实际写入")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
