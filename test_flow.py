"""端到端测试：单位换算 + 关联商品结算 + 成本核算。使用标准库，仅演示。"""
import json
import urllib.request

BASE = "http://127.0.0.1:8000"


def call(method, path, body=None):
    data = json.dumps(body).encode() if body is not None else None
    req = urllib.request.Request(BASE + path, data=data, method=method,
                                 headers={"Content-Type": "application/json"})
    with urllib.request.urlopen(req) as r:
        return json.loads(r.read().decode())


def show(title, obj):
    print(f"\n=== {title} ===")
    print(json.dumps(obj, ensure_ascii=False, indent=2))


# 1. 建商品
tomato = call("POST", "/api/products", {
    "name": "番茄", "category": "蔬菜", "base_unit": "克", "spec": "每个约150克",
    "sale_price": 0.016,  # 每克 0.016 元 ≈ 8元/斤
    "conversions": {"克": 1, "斤": 500, "公斤": 1000, "个": 150},
    "pack_items": [],
    "pack_fee": 1.0,
})
show("创建番茄", tomato)

box = call("POST", "/api/products", {
    "name": "泡沫箱", "category": "包装材料", "base_unit": "个",
    "conversions": {"个": 1, "箱": 1}, "sale_price": 3,
})
pad = call("POST", "/api/products", {
    "name": "泡沫垫", "category": "包装材料", "base_unit": "个",
    "conversions": {"个": 1, "包": 10}, "sale_price": 0.5,
})
show("创建泡沫箱", box)
show("创建泡沫垫", pad)

# 修正番茄包装清单引用实际商品ID
call("PUT", f"/api/products/{tomato['id']}", {
    "name": "番茄", "category": "蔬菜", "base_unit": "克", "spec": "每个约150克",
    "sale_price": 0.016,
    "conversions": {"克": 1, "斤": 500, "公斤": 1000, "个": 150},
    "pack_items": [
        {"product_id": box["id"], "quantity": 1, "unit": "个"},
        {"product_id": pad["id"], "quantity": 2, "unit": "个"},
    ],
    "pack_fee": 1.0,
})
print("\n番茄包装清单已绑定")

# 2. 入库
i1 = call("POST", "/api/inbounds", {"product_id": tomato["id"], "unit": "斤", "quantity": 10,
                                    "unit_price": 3, "supplier": "张三菜行", "operator": "王姐", "date": "2026-08-25"})
i2 = call("POST", "/api/inbounds", {"product_id": box["id"], "unit": "个", "quantity": 50,
                                    "unit_price": 2, "supplier": "包装厂", "operator": "王姐", "date": "2026-08-25"})
i3 = call("POST", "/api/inbounds", {"product_id": pad["id"], "unit": "包", "quantity": 10,
                                    "unit_price": 5, "supplier": "包装厂", "operator": "王姐", "date": "2026-08-25"})
show("入库 番茄10斤", i1)
show("入库 泡沫箱50个", i2)
show("入库 泡沫垫10包(100个)", i3)

# 3. 出库预览：卖3斤番茄
prev = call("POST", "/api/outbounds/preview", {"lines": [
    {"product_id": tomato["id"], "unit": "斤", "quantity": 3, "price": 8, "pack_fee": 1},
]})
show("出库预览(卖3斤番茄)", prev)

# 4. 确认出库
out = call("POST", "/api/outbounds", {
    "customer": "李四", "operator": "王姐", "date": "2026-08-25",
    "lines": [{"product_id": tomato["id"], "unit": "斤", "quantity": 3, "price": 8, "pack_fee": 1}],
    "pack_lines": [p for p in prev["pack_lines"]],
    "pack_fee_total": 1,
})
show("确认出库", out)

# 5. 库存 & 报表
stock = call("GET", "/api/stock-overview")
show("出库后库存", stock)
rep = call("GET", "/api/report/summary?date_from=2026-08-25&date_to=2026-08-25")
show("财务报表", rep)
