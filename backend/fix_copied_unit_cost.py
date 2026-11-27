"""修复「跨分仓复制商品」后目标仓没有成本基准的商品（参考成本=均价=0）。

背景（2026-11-10 事故）：
- 「复制商品到其他分仓」只带资料，不带库存数量/均价/流水（各仓自己的账，设计如此）；
  参考成本 unit_cost 会跟着复制，但很多商品的成本其实是**入库算出来的库存均价**，
  自己手填的参考成本一直是 0 → 复制过去就是 0。
- 目标仓这些商品既没有入库批次、也没有兜底参考成本，FIFO 出库/关联结算的成本全按 0 记，
  于是 11 月天麻/百合（含包材冰袋、保温袋、冰瓶）整批订单的商品成本都是 0、毛利虚高。

修复口径：
- 只修「目标仓 参考成本=0 且 库存均价=0」的**库存商品**（股票商品/订单商品不动，订单成本由它关联的库存商品决定）；
- 成本从**其他分仓的同名同基础单位商品**取：优先源仓手填的参考成本，没有则取源仓库存均价；
- 多个源仓都有该商品且成本不一致时，打印歧义并跳过（可用 --source 指定源仓）；
- 写入后对每个商品跑一次 recompute_product（FIFO 重放），把历史出库/关联结算的成本按新的兜底成本回写。

用法:
    python fix_copied_unit_cost.py                      # dry-run，只打印
    python fix_copied_unit_cost.py --apply              # 实际写入
    python fix_copied_unit_cost.py --source wh01        # 只用某个分仓作为成本来源
    python fix_copied_unit_cost.py --since 2026-11-10   # 只修该日期之后创建的商品
"""
import sys
from datetime import datetime

from sqlalchemy import select

from app.database import get_sessionmaker, get_warehouses
from app.models import Product, StockMovement
from app.services import recompute_product

APPLY = "--apply" in sys.argv


def _arg(name: str, default: str = "") -> str:
    for i, a in enumerate(sys.argv):
        if a == name and i + 1 < len(sys.argv):
            return sys.argv[i + 1]
        if a.startswith(name + "="):
            return a.split("=", 1)[1]
    return default


SOURCE = _arg("--source").strip()
SINCE = _arg("--since").strip()


def _cost_of(p: Product) -> float:
    """该商品的成本基准（每基础单位）：手填参考成本优先，其次库存均价。"""
    uc = float(p.unit_cost or 0)
    if uc > 0:
        return uc
    return float(p.avg_cost or 0)


def _out_qty(db, pid: int) -> float:
    """累计出库/包装消耗量（正数）。"""
    total = 0.0
    for (v,) in db.execute(
        select(StockMovement.quantity_base).where(
            StockMovement.product_id == pid, StockMovement.quantity_base < 0
        )
    ):
        total += -(v or 0.0)
    return total


def _source_index(exclude_key: str) -> dict[tuple[str, str], list[tuple[str, float]]]:
    """(名称, 基础单位) → [(分仓key, 成本单价)]，只收有成本的库存商品。"""
    idx: dict[tuple[str, str], list[tuple[str, float]]] = {}
    for wh in get_warehouses():
        key = wh.get("key")
        if not key or key == exclude_key:
            continue
        if SOURCE and key != SOURCE:
            continue
        db = get_sessionmaker(key)()
        try:
            for p in db.execute(select(Product).where(Product.product_type == "stock")).scalars():
                c = _cost_of(p)
                if c <= 0:
                    continue
                idx.setdefault((p.name.strip(), p.base_unit), []).append((key, c))
        finally:
            db.close()
    return idx


def main() -> int:
    warehouses = get_warehouses() or []
    if not warehouses:
        print("未找到任何分仓")
        return 0

    print(f"{'【写入】' if APPLY else '【dry-run】'} 源仓={SOURCE or '自动（同名同单位）'} 起始创建日={SINCE or '不限'}\n")

    total_fix = 0
    total_money = 0.0
    for wh in warehouses:
        key, name = wh.get("key"), wh.get("name") or wh.get("key")
        db = get_sessionmaker(key)()
        try:
            blank = []
            for p in db.execute(select(Product).order_by(Product.id)).scalars():
                if p.product_type != "stock":
                    continue
                if float(p.unit_cost or 0) > 0 or float(p.avg_cost or 0) > 0:
                    continue
                if SINCE and (p.created_at or datetime.min).strftime("%Y-%m-%d") < SINCE:
                    continue
                blank.append(p)
            if not blank:
                continue

            idx = _source_index(key)
            print(f"==== 分仓 {name}（{key}）待补成本 {len(blank)} 个 ====")
            for p in blank:
                qty = _out_qty(db, p.id)
                cands = idx.get((p.name.strip(), p.base_unit)) or []
                costs = {round(c, 8) for _k, c in cands}
                if not cands:
                    print(f"  [跳过] #{p.id} {p.name}：其他分仓没有同名同单位且有成本的商品（出库 {qty:g}{p.base_unit}）")
                    continue
                if len(costs) > 1:
                    print(f"  [歧义] #{p.id} {p.name}：多个源仓成本不一致 {cands}，用 --source 指定源仓")
                    continue
                src_key, cost = cands[0]
                add = round(qty * cost, 2)
                total_fix += 1
                total_money += add
                print(
                    f"  [修复] #{p.id} {p.name}：参考成本 0 → {cost:g} 元/{p.base_unit}"
                    f"（取自 {src_key}；累计出库 {qty:g}{p.base_unit}，应补记成本 {add:g} 元）"
                )
                if APPLY:
                    p.unit_cost = cost
                    db.flush()
                    recompute_product(db, p.id)
            if APPLY:
                db.commit()
                print("  已写入并完成 FIFO 重算")
            print("")
        finally:
            db.close()

    if APPLY:
        print(f"已修复 {total_fix} 个商品，补记成本合计约 {round(total_money, 2)} 元")
    else:
        print(f"dry-run 结束：将修 {total_fix} 个商品，补记成本合计约 {round(total_money, 2)} 元；确认后加 --apply")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
