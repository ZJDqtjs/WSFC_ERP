"""一次性数据迁移：补齐销售出库单解析缺失的商品与聚水潭编码关联。

背景：销售出库单中 19 个聚水潭商品名（红皮土豆/天麻/西兰苔/雪莲果）在系统商品主数据中不存在，
导致解析时报「未关联商品」。本脚本：
1) 创建 4 个库存大类商品：红皮土豆、天麻、西兰苔、雪莲果（沿用黑紫土豆的换算体系）；
2) 为 19 个外部商品名建立「编码关联」→ 对应库存商品（与黑紫土豆3斤→黑紫土豆 同一模式）；
3) 将既存、但未关联的订单商品「雪莲果中果4.5斤」挂到新库存商品「雪莲果」；
4) 重新导出 json 备份，保持 json 与 DB 同步。

幂等：商品按名称 upsert，编码关联按 (source, external_code) upsert。
"""
import sys
from pathlib import Path

BACKEND_DIR = Path(__file__).resolve().parent  # 项目 backend 目录，随项目移动自动适配

sys.path.insert(0, str(BACKEND_DIR))
from sqlalchemy import select

from app.database import SessionLocal
from app.models import CodeMapping, Product
from app.product_master import export_payload

db = SessionLocal()

CATEGORY = "蔬菜"
CONV = {"克": 1, "斤": 500, "公斤": 1000, "千克": 1000}

# 库存大类： name -> code
STOCK = {
    "红皮土豆": "HPT",
    "天麻": "TM",
    "西兰苔": "XLT",
    "雪莲果": "XLG",
}

# 外部商品名 -> 关联的库存产品名
MAPPINGS = {
    "京喜红皮土豆80g+1斤(带箱": "红皮土豆",
    "京喜红皮土豆80g+3斤(带箱": "红皮土豆",
    "京喜红皮土豆80g+9斤(带箱": "红皮土豆",
    "京喜红皮土豆80g+净重1.8斤": "红皮土豆",
    "红皮土豆3斤100g+": "红皮土豆",
    "红皮土豆3斤200g+": "红皮土豆",
    "红皮土豆5斤100g+": "红皮土豆",
    "红皮土豆5斤200g+": "红皮土豆",
    "新鲜天麻大果1斤4-5个": "天麻",
    "新鲜天麻大果2斤8-10个": "天麻",
    "新鲜天麻特大果3斤10-13个": "天麻",
    "新鲜天麻特大果3斤6-9个": "天麻",
    "新鲜有机天麻大果2斤8-10个": "天麻",
    "新鲜西兰苔2.5斤": "西兰苔",
    "新鲜西兰苔4.5斤": "西兰苔",
    "雪莲果中果3斤": "雪莲果",
    "雪莲果中果8斤": "雪莲果",
    "雪莲果大果4.5斤": "雪莲果",
    "雪莲果大果8斤": "雪莲果",
}


def get_or_create_stock(name: str, code: str) -> Product:
    p = db.scalar(select(Product).where(Product.name == name))
    if p is None:
        p = Product(
            code=code, name=name, category=CATEGORY, product_type="stock",
            base_unit="克", default_unit="公斤", spec="", sale_price=0.0,
            unit_cost=0.0, conversions=dict(CONV), pack_items=[], pack_fee=0.0,
            is_active=True,
        )
        db.add(p)
        db.flush()
        print(f"  [+] 新增库存商品: {name} (code={code})")
    else:
        p.code = code or p.code
        p.product_type = "stock"
        print(f"  [=] 已存在: {name}")
    return p


def main():
    created_stocks = []
    for name, code in STOCK.items():
        created_stocks.append(get_or_create_stock(name, code))
    stock_by_name = {p.name: p for p in created_stocks}
    db.flush()

    print("== 编码关联 ==")
    for ext, pname in MAPPINGS.items():
        stock = stock_by_name.get(pname) or db.scalar(select(Product).where(Product.name == pname))
        if stock is None:
            print(f"  [!] 找不到商品 {pname}，跳过 {ext!r}")
            continue
        m = db.scalar(select(CodeMapping).where(
            CodeMapping.source == "jushuitan", CodeMapping.external_code == ext
        ))
        is_new = m is None
        if is_new:
            m = CodeMapping(source="jushuitan", external_code=ext, external_name=ext)
            db.add(m)
        m.product_id = stock.id
        m.auto_score = 0.0
        print(f"  {'[+]' if is_new else '[=]'} {ext!r} -> {pname}")

    print("== 挂接既存订单商品 雪莲果中果4.5斤 ==")
    sp = stock_by_name["雪莲果"]
    op = db.get(Product, 357)
    if op is not None and op.product_type == "order":
        op.stock_product_id = sp.id
        op.spec = ""
        op.multiplier = 1.0
        print(f"  已挂接 雪莲果中果4.5斤 -> 雪莲果")

    db.commit()

    print("== 同步 json 备份 ==")
    for kind in ("products_stock", "products_order", "code_mappings"):
        payload = export_payload(db, kind)
        import json
        fname, _, listkey = (
            ("products_stock.json", "库存商品", "items"),
            ("products_order.json", "订单商品", "items"),
            ("code_mappings.json", "聚水潭编码关联", "mappings"),
        )[["products_stock", "products_order", "code_mappings"].index(kind)]
        fp = BACKEND_DIR / "json" / fname
        fp.write_text(json.dumps(payload, ensure_ascii=False, indent=2), encoding="utf-8")
        print(f"  {fname}: {len(payload[listkey])} 条")
    print("完成")


if __name__ == "__main__":
    main()
    db.close()