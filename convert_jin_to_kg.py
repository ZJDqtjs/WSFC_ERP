"""单位体系切换：重量商品主单位 斤 -> 公斤
- 默认单位 default_unit：斤 -> 公斤（保留 斤:500、公斤:1000，斤仍可作为换算单位输入）
- 关联结算倍数 multiplier：按 斤(500g) -> 公斤(1000g) 折半重算（500/1000 = 0.5）
- 商品名称、历史出入库记录（均以基础单位存）保持不变
"""
from app.database import SessionLocal
from app.models import Product

db = SessionLocal()
try:
    # 1) 默认单位为 斤 的商品 -> 公斤，并确保换算表齐全（保留斤可输入）
    jin = db.query(Product).filter(Product.default_unit == "斤").all()
    jin_ids = set()
    for p in jin:
        conv = dict(p.conversions or {})
        conv["克"] = 1
        conv["斤"] = 500
        conv["公斤"] = 1000
        conv["千克"] = 1000
        p.conversions = conv
        p.default_unit = "公斤"
        jin_ids.add(p.id)
    print(f"默认单位 斤 -> 公斤：{len(jin)} 个")

    # 2) 关联结算倍数折半（目标库存商品默认单位由斤变公斤）
    n = 0
    for o in db.query(Product).filter(
        Product.product_type == "order", Product.stock_product_id.isnot(None)
    ).all():
        if o.stock_product_id in jin_ids:
            o.multiplier = round(o.multiplier * 0.5, 4)
            n += 1
    print(f"关联结算倍数折半重算：{n} 个订单商品")

    db.commit()

    # 3) 复核
    from collections import Counter

    print("复核 default_unit 分布:", dict(Counter(
        p.default_unit for p in db.query(Product).all()
    )))
    print("完成")
finally:
    db.close()
