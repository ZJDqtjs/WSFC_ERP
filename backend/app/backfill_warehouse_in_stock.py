"""一次性回填：历史「入仓」没扣库存的商品，补记入仓发货流水 + 等量减少盘点盘亏。

背景（2026-11-01 之前）：入仓只扣了「随货包材」，货本身没扣库存 →
系统库存虚高，用户只能在盘点时记大额盘亏。本脚本按每条历史入仓记录
「袋数 × 每袋数量」补记一条「入仓发货」出库流水（ref_type=warehouse_in_goods,
ref_id=入仓记录 id，之后改/删那条入仓记录能自动回退），同时把**同量的盘点盘亏**
流水等量减少（备注里写明改判了多少）——**净库存不变**，只是把「损耗」改判成「发货」。
成本仍由 FIFO 重放重算，库存价值口径与出库一致。

用法（在 backend 目录下）：
    python -m app.backfill_warehouse_in_stock             # dry-run，只打印计划，不写库
    python -m app.backfill_warehouse_in_stock --apply     # 真正写入（务必先冷备）
    python -m app.backfill_warehouse_in_stock --key wh01  # 指定分仓（默认 aosidi）
"""
import sys

from sqlalchemy import select

from .database import get_sessionmaker
from .models import Product, StockMovement, WarehouseIn, WarehouseProduct
from .services import recompute_product

GOODS_REF = "warehouse_in_goods"


def _factor(sp: Product) -> float:
    """库存商品默认单位 → 基础单位的换算系数（每袋数量就是按默认单位记的）。"""
    du = sp.default_unit or sp.base_unit
    return float((sp.conversions or {}).get(du) or 1) or 1.0


def run(key: str = "aosidi", apply: bool = False) -> None:
    db = get_sessionmaker(key)()
    try:
        prods = {p.id: p for p in db.execute(select(Product)).scalars()}
        wp_links = {wp.id: wp.stock_product_id for wp in db.execute(select(WarehouseProduct)).scalars()}
        recs = list(db.execute(select(WarehouseIn).order_by(WarehouseIn.date, WarehouseIn.id)).scalars())
        # 幂等：已经补过的入仓记录（有 warehouse_in_goods 流水）跳过
        done = {
            int(r) for (r,) in db.execute(
                select(StockMovement.ref_id).where(StockMovement.ref_type == GOODS_REF)
            ) if r is not None
        }

        plan: dict[int, dict] = {}
        for rec in recs:
            spid = rec.stock_product_id or wp_links.get(rec.product_id or 0)
            if not spid or spid not in prods or rec.id in done:
                continue
            sp = prods[spid]
            qty = float(rec.quantity or 0)
            bw = float(rec.bag_weight or 0)
            if qty <= 0 or bw <= 0:
                continue
            item = plan.setdefault(spid, {"recs": [], "need": 0.0})
            base_qty = round(qty * bw * _factor(sp), 6)
            item["recs"].append((rec, base_qty))
            item["need"] += base_qty

        losses: dict[int, list] = {}
        for m in db.execute(
            select(StockMovement).where(
                StockMovement.move_type == "adjust",
                StockMovement.ref_type == "manual",
                StockMovement.quantity_base < 0,
            ).order_by(StockMovement.date.desc(), StockMovement.id.desc())
        ).scalars():
            losses.setdefault(m.product_id, []).append(m)

        if not plan:
            print(f"[{key}] 没有需要回填的入仓记录（已全部补过）")
            return

        total_new = total_cut = 0.0
        print(f"[{key}] {'执行' if apply else '预演（不写库）'}：涉及 {len(plan)} 个库存商品\n")
        for spid, item in plan.items():
            sp = prods[spid]
            du = sp.default_unit or sp.base_unit
            f = _factor(sp)
            need = item["need"]
            loss_rows = losses.get(spid, [])
            loss_total = sum(-float(m.quantity_base or 0) for m in loss_rows)
            absorb = min(need, loss_total)
            gap = need - absorb
            print(f"· {sp.name}（id={spid}，单位 {du}）")
            print(f"    待补入仓发货 {need / f:g}{du}（{len(item['recs'])} 条入仓记录）"
                  f" | 现有盘亏 {loss_total / f:g}{du} | 可改判 {absorb / f:g}{du}"
                  f" | 缺口 {gap / f:g}{du}")
            if gap > 1e-6:
                print(f"    ⚠ 盘亏不够改判：剩余 {gap / f:g}{du} 需要另外决定（是否直接扣库存）")
            if not apply or absorb <= 0:
                print()
                continue

            left = absorb
            for rec, base_qty in item["recs"]:
                if base_qty > left + 1e-9:
                    break
                db.add(StockMovement(
                    product_id=spid, move_type="out", quantity_base=-base_qty, amount=0.0,
                    ref_type=GOODS_REF, ref_id=rec.id, date=rec.date,
                    operator=rec.operator or "", remark=f"入仓发货 {rec.code}（历史补记）",
                ))
                left -= base_qty
                total_new += base_qty
            made = absorb - left

            to_cut = made
            for m in loss_rows:
                if to_cut <= 1e-9:
                    break
                cur = -float(m.quantity_base or 0)
                cut_base = round(min(cur, to_cut), 6)
                m.quantity_base = round(float(m.quantity_base or 0) + cut_base, 6)
                m.remark = (m.remark or "") + f"（其中 {cut_base / f:g}{du} 已改判为入仓发货）"
                to_cut -= cut_base
                total_cut += cut_base
                if abs(m.quantity_base) < 1e-9:
                    db.delete(m)
            db.flush()
            recompute_product(db, spid)
            db.refresh(sp)
            print(f"    已补 {made / f:g}{du}，同期盘亏改判 {made / f:g}{du}；"
                  f"当前库存仍为 {sp.stock / f:g}{du}\n")

        if apply:
            db.commit()
            print(f"完成：补记入仓发货 {total_new:g}（基础单位），盘亏改判 {total_cut:g}，净库存不变")
        else:
            db.rollback()
            print("（预演结束，未写库；确认后加 --apply 执行）")
    finally:
        db.close()


if __name__ == "__main__":
    args = sys.argv[1:]
    wh_key = "aosidi"
    if "--key" in args:
        wh_key = args[args.index("--key") + 1]
    run(key=wh_key, apply="--apply" in args)
