# -*- coding: utf-8 -*-
import sys, io
sys.path.insert(0, r"d:\code\statistics_erp")
import openpyxl
from app.database import SessionLocal
from app.models import CodeMapping, Product
from sqlalchemy import or_, select
from app.routers import imports as M

db = SessionLocal()
mapping_rows = list(db.execute(select(CodeMapping)).scalars())
mapping_by_code = {m.external_code: m for m in mapping_rows}
print("total mappings:", len(mapping_rows))

wb = openpyxl.load_workbook(r"d:\code\statistics_erp\销售出库单_20260905110521_71949896_1.xlsx", data_only=True)
ws = wb.worksheets[0]
rows = [list(r) for r in ws.iter_rows(values_only=True)]
orders, skip = M.jushuitan_rows(rows, ("已出库",))
print("orders:", len(orders), "skip:", skip)

fmt = "{:<30}{:<18}{}".format("ext_name", "mapped?", "note")
print(fmt)
for o in orders:
    for ext_name, qty in M.parse_jushuitan_name(o["name"]):
        m = mapping_by_code.get(ext_name)
        pid = m.product_id if m else None
        p = db.get(Product, pid) if pid else None
        if not p:
            p = db.scalar(select(Product).where(or_(Product.name == ext_name, Product.code == ext_name)))
        unit, per_item = M.pick_jst_unit(p, ext_name) if p else (None, None)
        print("{:<30}{:<18}{}".format(
            ext_name,
            "YES"+("(<n>)" if m and not m.product_id else "") if p else "NO",
            ("unit=%s per=%s"%(unit,per_item)) if p else "",
        ))
db.close()