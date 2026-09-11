# -*- coding: utf-8 -*-
"""查询：分仓状态 + 奥斯迪仓分类分布 + 蔬菜仓内容"""
import sys
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent))
sys.path.insert(0, str(Path(__file__).resolve().parent / "backend"))

from sqlalchemy import func, select

from backend.app.database import get_sessionmaker, warehouse_db_path
from backend.app.models import Product, Unit, CodeMapping, PackRule

# 蔬菜仓 db 文件
p = warehouse_db_path("wh01")
print("wh01.db 存在:", p.exists(), "| 大小:", p.stat().st_size if p.exists() else 0)

# 奥斯迪仓分类分布
db = get_sessionmaker("aosidi")()
print("\n== 奥斯迪仓 stock 分类 ==")
for cat, n in db.execute(
    select(Product.category, func.count(Product.id))
    .where(Product.product_type == "stock")
    .group_by(Product.category).order_by(func.count(Product.id).desc())
).all():
    print(f"  {cat or '(空)'}: {n}")
print("== 奥斯迪仓 order 分类 ==")
for cat, n in db.execute(
    select(Product.category, func.count(Product.id))
    .where(Product.product_type == "order")
    .group_by(Product.category).order_by(func.count(Product.id).desc())
).all():
    print(f"  {cat or '(空)'}: {n}")
print("== 奥斯迪仓 单位/规则/编码 ==")
print("  units:", db.query(Unit).count(), "| pack_rules:", db.query(PackRule).count(), "| code_mappings:", db.query(CodeMapping).count())
db.close()

# 蔬菜仓内容
try:
    db2 = get_sessionmaker("wh01")()
    print("\n== 蔬菜仓 ==")
    print("  products:", db2.query(Product).count())
    print("  units:", db2.query(Unit).count())
    print("  users:", db2.query(func.count()).select_from(__import__("backend.app.models", fromlist=["User"]).User).scalar())
    db2.close()
except Exception as e:
    print("蔬菜仓打开失败:", e)
