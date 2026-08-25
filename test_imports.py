"""测试账号系统 + 柠檬云商品导入 + 聚水潭编码关联与自动结算导入。"""
import http.cookiejar
import json
import mimetypes
import urllib.request

BASE = "http://127.0.0.1:8000"
LEMON = "柠檬云商品导入模板.xlsx"
JST = "销售出库单_20260825154634_11796234_1.xlsx"

cj = http.cookiejar.CookieJar()
opener = urllib.request.build_opener(urllib.request.HTTPCookieProcessor(cj))


def call(method, path, body=None):
    data = json.dumps(body).encode() if body is not None else None
    req = urllib.request.Request(BASE + path, data=data, method=method,
                                 headers={"Content-Type": "application/json"})
    with opener.open(req) as r:
        return json.loads(r.read().decode())


def upload(path, filepath):
    boundary = "----boundary1234"
    with open(filepath, "rb") as f:
        filedata = f.read()
    fname = filepath.split("\\")[-1]
    ctype = mimetypes.guess_type(fname)[0] or "application/octet-stream"
    body = (
        f"--{boundary}\r\n"
        f'Content-Disposition: form-data; name="file"; filename="{fname}"\r\n'
        f"Content-Type: {ctype}\r\n\r\n"
    ).encode() + filedata + f"\r\n--{boundary}--\r\n".encode()
    req = urllib.request.Request(BASE + path, data=body, method="POST",
                                 headers={"Content-Type": f"multipart/form-data; boundary={boundary}"})
    with opener.open(req) as r:
        return json.loads(r.read().decode())


def show(title, obj, limit=None):
    s = json.dumps(obj, ensure_ascii=False, indent=1)
    if limit and len(s) > limit:
        s = s[:limit] + " ...(截断)"
    print(f"\n=== {title} ===\n{s}")


# 1. 未登录访问应 401
try:
    call("GET", "/api/products")
    print("\n[FAIL] 未登录竟然成功了")
except urllib.error.HTTPError as e:
    print(f"\n[OK] 未登录返回 {e.code}")

# 2. 登录（错误密码 / 正确）
try:
    call("POST", "/api/auth/login", {"username": "admin1", "password": "wrong"})
    print("[FAIL] 错误密码竟然成功")
except urllib.error.HTTPError as e:
    print(f"[OK] 错误密码返回 {e.code}")
me = call("POST", "/api/auth/login", {"username": "admin1", "password": "admin1"})
print(f"[OK] 登录成功: {me['user']}")
show("当前用户", call("GET", "/api/auth/me"))

# 3. 柠檬云商品导入
r = upload("/api/import/products", LEMON)
show("柠檬云商品导入", {k: r[k] for k in ("created", "skipped", "failed_count")} | {"failed": r["failed"][:5]})

# 4. 建一个与聚水潭同名的商品并配置包装清单，做关联测试
products = call("GET", "/api/products")
names = [p["name"] for p in products]
demo_box = next(p for p in products if p["name"] == "泡沫箱")
demo_pad = next(p for p in products if p["name"] == "泡沫垫")

if "京鲜生五指毛桃250g" not in names:
    prod = call("POST", "/api/products", {
        "code": "jst_wmt", "name": "京鲜生五指毛桃250g", "category": "干货",
        "base_unit": "克", "spec": "每袋250克", "sale_price": 0.07,
        "conversions": {"克": 1, "斤": 500, "个": 250, "袋": 250},
        "pack_items": [{"product_id": demo_box["id"], "quantity": 1, "unit": "个"},
                       {"product_id": demo_pad["id"], "quantity": 2, "unit": "个"}],
        "pack_fee": 1.0,
    })
    print(f"[OK] 创建测试商品 京鲜生五指毛桃250g id={prod['id']}")
else:
    prod = next(p for p in products if p["name"] == "京鲜生五指毛桃250g")
    print(f"[OK] 商品已存在 id={prod['id']}")

# 5. 补库存（商品 + 包装材料）
call("POST", "/api/inbounds", {"product_id": prod["id"], "unit": "袋", "quantity": 30,
                               "unit_price": 10, "operator": "管理员", "date": "2026-08-25"})
call("POST", "/api/inbounds", {"product_id": demo_box["id"], "unit": "个", "quantity": 50,
                               "unit_price": 2, "operator": "管理员", "date": "2026-08-25"})
call("POST", "/api/inbounds", {"product_id": demo_pad["id"], "unit": "个", "quantity": 100,
                               "unit_price": 0.5, "operator": "管理员", "date": "2026-08-25"})
print("[OK] 已补库存")

# 6. 解析聚水潭（应返回 75 种编码 + 自动推荐）
parsed = upload("/api/jushuitan/parse", JST)
print(f"\n[OK] 聚水潭解析: 已出库 {parsed['total_orders']} 单, 跳过 {parsed['skip']}, 编码 {len(parsed['codes'])} 种")
wmt = next((c for c in parsed["codes"] if c["external_code"] == "京鲜生五指毛桃250g"), None)
show("五指毛桃解析结果", wmt)
show("前3条自动推荐示例", parsed["codes"][:3])

# 7. 保存关联
call("POST", "/api/mappings/bulk", {"source": "jushuitan", "items": [
    {"external_code": "京鲜生五指毛桃250g", "product_id": prod["id"]},
]})
mappings = call("GET", "/api/mappings")
print(f"[OK] 已保存 {len(mappings)} 条关联: {[m['external_code'] for m in mappings]}")

# 8. 导入聚水潭出库单（自动结算）
imp = upload("/api/jushuitan/import", JST)
show("聚水潭导入结果", {k: imp[k] for k in ("created", "skip", "failed_count")} | {
    "failed": imp["failed"][:5], "warnings": imp["warnings"][:5],
    "unmapped_count": len(imp["unmapped_codes"])})

# 9. 报表验证
rep = call("GET", "/api/report/summary")
show("财务报表摘要", {k: rep[k] for k in ("revenue", "cogs", "gross_profit", "expense", "net_profit", "stock_value", "order_count")})
print("\n全部完成")
