"""一次性导入：把 箱子及薪水支出统计.py 的 SPECIAL_CONFIG（一单多货合并打包规则）维护进系统。

用法（项目根目录、激活虚拟环境）:
    uv run python seed_pack_rules.py
或在登录后由后端自动建表完成后运行：
    python seed_pack_rules.py

逻辑：
- 从脚本文本中提取 SPECIAL_CONFIG 字典（不 import 该文件，避免执行其顶层代码）。
- 每条 key 如 '七彩土豆3斤*1,京鲜生七彩花生1斤*1' 按 ',' 拆分为条目，
  每条目尾部 *N 作为数量，剩余部分作为商品名。
- 商品名与系统中「订单商品」精确匹配则关联 product_id，否则留空（保留原文）。
- 幂等：已存在同名组合则跳过（可反复运行）。
"""
import ast
import re

from sqlalchemy import select

from app.database import Base, SessionLocal, engine
from app.models import PackRule, Product

SRC = "箱子及薪水支出统计.py"


def extract_special_config(path) -> dict:
    with open(path, encoding="utf-8") as f:
        src = f.read()
    marker = "SPECIAL_CONFIG = {"
    idx = src.index(marker)
    i = idx + len(marker) - 1  # 指向 '{'
    depth = 0
    j = i
    in_str = False
    while j < len(src):
        c = src[j]
        if in_str:
            if c == "\\":
                j += 2
                continue
            if c == '"':
                in_str = False
        else:
            if c == '"':
                in_str = True
            elif c == "{":
                depth += 1
            elif c == "}":
                depth -= 1
                if depth == 0:
                    break
        j += 1
    dict_text = src[i : j + 1]
    return ast.literal_eval(dict_text)


def parse_items(key: str):
    """'七彩土豆3斤*1,京鲜生七彩花生1斤*1' -> [{'name':'七彩土豆3斤','quantity':1}, ...]"""
    items = []
    for part in key.split(","):
        part = part.strip()
        if not part:
            continue
        # 提取尾部 *N 作为数量；若多个 *，取最后一个，如 '包浆豆腐300g*2盒*1'
        m = re.search(r"\*(\d+(?:\.\d+)?)$", part)
        if m:
            qty = float(m.group(1))
            name = part[: m.start()].strip()
        else:
            qty = 1.0
            name = part
        items.append({"name": name, "quantity": qty})
    return items


def main():
    Base.metadata.create_all(bind=engine)  # 确保 pack_rules 表已创建
    cfg = extract_special_config(SRC)
    print(f"从 {SRC} 读取到一单多货规则 {len(cfg)} 条")

    db = SessionLocal()
    try:
        existing = {r.name for r in db.execute(select(PackRule)).scalars()}
        # 订单商品名 -> id 精确映射
        name_to_id = {
            p.name: p.id
            for p in db.execute(select(Product).where(Product.product_type == "order")).scalars()
        }
        added, skipped, linked = 0, 0, 0
        for key, val in cfg.items():
            if key in existing:
                skipped += 1
                continue
            items = parse_items(key)
            for it in items:
                pid = name_to_id.get(it["name"])
                if pid is not None:
                    it["product_id"] = pid
                    linked += 1
                else:
                    it["product_id"] = None
            db.add(
                PackRule(
                    name=key,
                    items=items,
                    box_type=(val.get("纸箱型号") or ""),
                    labor_price=val.get("工人单价"),
                    box_ratio=float(val.get("箱单比") or 1),
                    remark=(val.get("备注") or ""),
                    is_active=True,
                )
            )
            added += 1
        db.commit()
        print(f"新增 {added} 条，跳过已存在 {skipped} 条，累计关联订单商品条目 {linked} 次")
        unlinked = sum(1 for it in (i for r in db.execute(select(PackRule)).scalars() for i in (r.items or [])) if not it.get("product_id"))
        print(f"未关联到订单商品（保留原文）的条目数：{unlinked}")
    finally:
        db.close()


if __name__ == "__main__":
    main()