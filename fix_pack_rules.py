"""修复历史「一单多货」订单的 pack 行：按当前 PackRule 重新生成纸箱 + 人工明细行。

历史问题：
- 早期订单人工用了独立「XX打包」商品、数量=件数、成本=单件成本×件数（错误）
- 后期订单纸箱对了但人工走成了 total_fee 费用，无人工明细行

本脚本复用 _pack_rule_settle 逻辑，对 pack_rule_id 非空的订单幂等重建 pack 行：
- 删除旧 pack 行 + 对应 StockMovement + 「人工打包费」FinanceRecord
- 按规则 box_items 生成纸箱行、labor_price 生成「人工打包费」行
- 回填 sale 行 spec（规格/合并数）
- 重算 total_cogs / total_fee，重算受影响商品库存/成本

用法:
    python fix_pack_rules.py          # dry-run，仅打印变更
    python fix_pack_rules.py --apply  # 实际写入
"""
import sys

from sqlalchemy import select

from app.database import SessionLocal
from app.models import FinanceRecord, Outbound, OutboundLine, PackRule, Product, StockMovement
from app.routers.imports import _pack_rule_settle
from app.services import recompute_product, unit_to_base

APPLY = "--apply" in sys.argv


def fix() -> int:
    db = SessionLocal()
    changed = 0
    try:
        orders = list(
            db.execute(
                select(Outbound).where(Outbound.pack_rule_id.is_not(None)).order_by(Outbound.id)
            ).scalars()
        )
        for o in orders:
            rule = db.get(PackRule, o.pack_rule_id)
            if not rule:
                print(f"[跳过] #{o.id} 规则不存在")
                continue

            order_items = [
                (str(it.get("name") or "").strip(), float(it.get("quantity", 1) or 1))
                for it in (rule.items or [])
                if str(it.get("name") or "").strip()
            ]
            if not order_items:
                print(f"[跳过] #{o.id} 规则无组合条目")
                continue

            sale_lines, pack_lines, labor_fee, issues = _pack_rule_settle(db, rule, order_items)
            if issues:
                print(f"[跳过] #{o.id} {o.code} 规则:{rule.name} 问题: {issues}")
                continue

            old_packs = [l for l in o.lines if l.line_type == "pack"]
            old_pack_cogs = round(sum(l.cogs for l in old_packs), 2)
            sale_cogs = round(sum(l.cogs for l in o.lines if l.line_type == "sale"), 2)

            # 计算新 pack 行的 cogs / unit_price
            new_rows = []
            for spec in pack_lines:
                m = db.get(Product, spec["product_id"])
                if not m:
                    continue
                qty_base = unit_to_base(m, spec["unit"], spec["quantity"])
                if spec.get("cogs") is not None:
                    cogs = round(float(spec["cogs"]), 2)
                    unit_price = round(cogs / spec["quantity"], 4) if spec["quantity"] else 0.0
                else:
                    cost = m.avg_cost if m.avg_cost else m.unit_cost
                    cogs = round(qty_base * cost, 2)
                    unit_price = cost
                new_rows.append({
                    "product_id": m.id, "name": m.name, "category": m.category,
                    "unit": spec["unit"], "quantity": spec["quantity"], "quantity_base": qty_base,
                    "unit_price": unit_price, "cogs": cogs, "sale_product_id": spec.get("sale_product_id"),
                })
            new_pack_cogs = round(sum(r["cogs"] for r in new_rows), 2)
            new_total_cogs = round(sale_cogs + new_pack_cogs, 2)
            new_total_fee = round(labor_fee, 2)

            # sale 行 spec 回填（历史单为空）
            specmap = {sl["product"].id: sl["spec"] for sl in sale_lines if sl.get("spec")}
            spec_changed = []
            for sl in o.lines:
                if sl.line_type == "sale" and not sl.spec and specmap.get(sl.product_id):
                    spec_changed.append(f"{sl.product.name}:{specmap[sl.product_id]}")
                    if APPLY:
                        sl.spec = specmap[sl.product_id]

            desc_packs = [f"{r['name']}×{r['quantity']}@{r['cogs']}" for r in new_rows]
            print(
                f"#{o.id} {o.code} 规则:{rule.name}\n"
                f"  旧pack: {[f'{l.product.name}×{l.quantity}@{l.cogs}' for l in old_packs]}\n"
                f"  新pack: {desc_packs}\n"
                f"  total_cogs: {o.total_cogs} -> {new_total_cogs}  total_fee: {o.total_fee} -> {new_total_fee}"
                + (f"\n  spec回填: {spec_changed}" if spec_changed else "")
            )

            if not APPLY:
                changed += 1
                continue

            # 删除旧 pack 行及其 StockMovement（旧行商品库存/工作量也需一并重算）
            affected = {l.product_id for l in old_packs}
            for l in old_packs:
                for mv in db.execute(
                    select(StockMovement).where(
                        StockMovement.ref_type == "outbound",
                        StockMovement.ref_id == o.id,
                        StockMovement.product_id == l.product_id,
                    )
                ).scalars():
                    db.delete(mv)
                db.delete(l)
            # 删除旧「人工打包费」费用记录
            for f in db.execute(
                select(FinanceRecord).where(
                    FinanceRecord.ref_type == "outbound",
                    FinanceRecord.ref_id == o.id,
                    FinanceRecord.category == "人工打包费",
                )
            ).scalars():
                db.delete(f)
            db.flush()

            # 插入新 pack 行 + StockMovement
            for r in new_rows:
                nl = OutboundLine(
                    outbound_id=o.id,
                    product_id=r["product_id"],
                    line_type="pack",
                    sale_product_id=r["sale_product_id"],
                    spec="",
                    unit=r["unit"],
                    quantity=r["quantity"],
                    quantity_base=r["quantity_base"],
                    unit_price=r["unit_price"],
                    amount=r["cogs"],
                    cogs=r["cogs"],
                    pack_fee=0,
                )
                db.add(nl)
                is_labor = r["category"] == "人工"
                move_qty = r["quantity_base"] if is_labor else -r["quantity_base"]
                move_type = "work" if is_labor else "pack_out"
                db.add(
                    StockMovement(
                        product_id=r["product_id"],
                        move_type=move_type,
                        quantity_base=move_qty,
                        amount=r["cogs"],
                        ref_type="outbound",
                        ref_id=o.id,
                        date=o.date,
                        operator=o.operator,
                        remark=f"{'打包' if is_labor else '包装消耗'} {o.code}",
                    )
                )
                affected.add(r["product_id"])

            o.total_cogs = new_total_cogs
            o.total_fee = new_total_fee
            changed += 1

            db.flush()
            for pid in affected:
                recompute_product(db, pid)

        if APPLY:
            db.commit()
            print(f"\n=== 已修复 {changed} 单 ===")
        else:
            print(f"\n=== dry-run：共 {changed} 单将变更（加 --apply 实际写入） ===")
    except Exception as e:
        db.rollback()
        import traceback
        traceback.print_exc()
        print("修复失败:", e)
        return 1
    finally:
        db.close()
    return 0


if __name__ == "__main__":
    sys.exit(fix())