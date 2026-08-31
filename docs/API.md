# 企业台账系统 - 后端 API 文档

> 供前端（Web / **Flutter 移动端**）对接使用。
> 文档基于当前后端实现（FastAPI + SQLite），随代码同步维护。

***

## 1. 基础信息

### 1.1 服务地址（Linux 部署后）

| 环境              | 地址                                                       |
| --------------- | -------------------------------------------------------- |
| 生产（nginx 反代 80） | `http://20.24.210.119`（即 `http://20.24.210.119/api/...`） |
| 本地开发后端          | `http://127.0.0.1:8000`（`/api/...`）                      |

* 前端页面由 nginx 托管在 **80 端口**，后端 API 由 nginx 把 `/api`、`/uploads` 反代到本机 `127.0.0.1:8000`。

* 所有请求路径均以 `/api` 开头（`/uploads` 为静态图片，见第 11 节）。

### 1.2 认证方式（Cookie 会话）

* 除登录外，**所有接口都需要登录**。

* 登录成功后服务端通过响应头 `Set-Cookie: erp_token=...; HttpOnly; Path=/; SameSite=Lax` 下发会话令牌，有效期 7 天。

* 之后每个请求需携带 `Cookie: erp_token=...`，否则返回 `401 {"detail":"未登录"}`。

**Flutter 对接要点：**

* Flutter 的 `http` 包默认不管理 Cookie，需自行处理：

  * 登录时读取响应头 `set-cookie`，提取 `erp_token=xxx` 部分；

  * 后续每个请求手动加请求头 `Cookie: erp_token=xxx`；

  * 或使用 `cookie_jar` / `dio` 的 `cookieJar` 自动管理。

* Flutter 原生请求不经过浏览器，**不受 CORS 限制**，无需额外跨域配置。

### 1.3 通用约定

* 请求 / 响应均为 `application/json`（文件上传接口除外）。

* 日期格式统一为字符串 `YYYY-MM-DD`。

* 错误响应格式：`{"detail": "错误信息"}`，配合 HTTP 状态码（400 / 401 / 404 / 500 等）。

***

## 2. 认证 Auth

### 2.1 登录

`POST /api/auth/login`

请求：

```json
{ "username": "admin1", "password": "admin1" }
```

响应 200：

```json
{
  "ok": true,
  "user": { "id": 1, "username": "admin1", "name": "管理员", "role": "admin" }
}
```

响应头会带 `Set-Cookie`（登录成功才下发）。

### 2.2 登出

`POST /api/auth/logout`
响应：`{ "ok": true }`（清除 Cookie）

### 2.3 当前用户

`GET /api/auth/me`（需登录）
响应：

```json
{ "id": 1, "username": "admin1", "name": "管理员", "role": "admin" }
```

***

## 3. 商品 Products

### 3.1 商品列表

`GET /api/products`（需登录）
响应：`[Product]`（数组）

Product 字段：

| 字段                   | 类型       | 说明                                      |
| -------------------- | -------- | --------------------------------------- |
| id                   | int      | 商品 ID                                   |
| code                 | string   | 商品编码                                    |
| name                 | string   | 商品名称                                    |
| category             | string   | 分类（蔬菜/干货/包材/人工/快递/商品…）                  |
| product\_type        | string   | `stock` 库存商品（大类）/ `order` 订单商品（小类）      |
| base\_unit           | string   | 基础单位（克/个）                               |
| default\_unit        | string   | 默认展示/出库单位（斤/公斤/个…）                      |
| spec                 | string   | 规格说明                                    |
| sale\_price          | float    | 默认售价（每基础单位）                             |
| unit\_cost           | float    | 参考成本（每基础单位）                             |
| conversions          | object   | 单位换算表 `{单位: 到基础单位的系数}`                  |
| pack\_items          | array    | 关联结算清单 `[{product_id, quantity, unit}]` |
| pack\_fee            | float    | 每单固定人工/包装费                              |
| stock\_product\_id   | int/null | 订单商品关联的库存商品 ID                          |
| stock\_product\_name | string   | 关联库存商品名称                                |
| multiplier           | float    | 1 单订单商品 = multiplier × 库存默认单位           |
| is\_active           | bool     | 是否启用                                    |
| stock                | float    | 当前库存（基础单位）                              |
| avg\_cost            | float    | 加权平均成本（基础单位）                            |
| stock\_value         | float    | 库存总值                                    |

### 3.2 新建商品

`POST /api/products`

请求：

```json
{
  "code": "",
  "name": "佛手柑大果",
  "category": "蔬菜",
  "product_type": "stock",
  "base_unit": "个",
  "default_unit": "个",
  "spec": "",
  "sale_price": 0,
  "unit_cost": 0,
  "conversions": { "个": 1, "斤": 10 },
  "pack_items": [ { "product_id": 3, "quantity": 1, "unit": "个" } ],
  "pack_fee": 0,
  "stock_product_id": null,
  "multiplier": 1,
  "is_active": true
}
```

响应：创建的 `Product` 对象。`conversions` 缺省时按 `base_unit` 生成默认换算表。

### 3.3 更新商品

`PUT /api/products/{pid}` 请求体同 3.2，响应更新后的 `Product`。

### 3.4 删除商品

`DELETE /api/products/{pid}` → `{ "ok": true }`

### 3.5 库存商品列表（大类）

`GET /api/stocks`
响应：`[{id, name, category, base_unit, default_unit, conversions, stock}]`，供订单商品关联选择。

### 3.6 批量删除

`POST /api/products/batch-delete` 请求：`{ "ids": [1,2] }`
响应：`{ "ok": true, "deleted": 2, "blocked": ["被引用商品名"] }`（被单据/关联引用的商品会跳过并列入 blocked）

### 3.7 批量修改

`POST /api/products/batch-update`
请求：`{ "ids": [1,2], "category": "蔬菜", "default_unit": "斤", "is_active": true, "sale_price": 5, "unit_cost": 1, "pack_fee": 0.5 }`（字段均可选）
响应：`{ "ok": true, "updated": 2 }`

### 3.8 单位管理

* `GET /api/units` → `[{id, name, category, gram_per_unit}]`

* `POST /api/units` 请求：`{ "name": "箱", "category": "count", "gram_per_unit": null }`（weight 类必填 gram\_per\_unit）

* `DELETE /api/units/{uid}` → `{ "ok": true }`（标准单位不可删）

***

## 4. 入库 Inbound

### 4.1 入库列表

`GET /api/inbounds?date_from=2026-01-01&date_to=2026-08-31`
响应：`[Inbound]`

Inbound 字段：`id, code(单号), product_id, product_name, unit, quantity, quantity_base, unit_price, total_amount, supplier, operator, date, remark`

### 4.2 新建入库

`POST /api/inbounds`
请求：

```json
{
  "product_id": 41,
  "unit": "公斤",
  "quantity": 100,
  "unit_price": 4,
  "supplier": "张三菜行",
  "operator": "",
  "date": "2026-08-31",
  "remark": ""
}
```

响应：创建的 `Inbound`（`code` 由系统生成）。订单商品（小类）不可入库，会返回 400。

### 4.3 删除入库

`DELETE /api/inbounds/{rid}` → `{ "ok": true }`（自动回退库存/成本/财务）

### 4.4 批量删除

`POST /api/inbounds/batch-delete` 请求：`{ "ids": [1,2] }`
响应：`{ "ok": true, "deleted": 2, "missing": 0 }`

***

## 5. 出库 / 销售 Outbound

### 5.1 出库预览（不落库，先算明细与校验）

`POST /api/outbounds/preview`
请求：

```json
{
  "lines": [
    { "product_id": 1, "unit": "斤", "quantity": 3, "price": 8, "pack_fee": null }
  ]
}
```

响应：

```json
{
  "sale_lines": [
    {
      "product_id": 1, "product_name": "番茄", "base_unit": "克",
      "unit": "斤", "quantity": 3, "quantity_base": 1500,
      "stock_product_id": 1, "stock_product_name": "番茄",
      "deduction_base": 1500, "unit_price": 8, "amount": 24,
      "cogs": 12, "pack_fee": 1, "line_type": "sale"
    }
  ],
  "pack_lines": [
    { "product_id": 3, "product_name": "泡沫箱", "base_unit": "个",
      "unit": "个", "quantity": 1, "quantity_base": 1,
      "unit_price": 2, "amount": 2, "cogs": 2, "pack_fee": 0, "line_type": "pack" }
  ],
  "total_amount": 24, "total_cogs": 14, "total_fee": 1,
  "gross_profit": 10, "net_profit": 9,
  "warnings": ["「番茄」库存不足：需 1.5 公斤，现有 0 公斤"]
}
```

> 关联结算清单（包材）会自动按商品配置的 `pack_items` 追加到 `pack_lines`。

### 5.2 出库列表

`GET /api/outbounds?date_from=&date_to=`
响应：`[Outbound]`

Outbound 字段：`id, code, customer, operator, date, remark, total_amount, total_cogs, total_fee, gross_profit, net_profit, lines[]`

* `lines[]`：`{product_id, product_name, line_type(sale/pack), unit, quantity, quantity_base, unit_price, amount, cogs, pack_fee}`

### 5.3 新建出库（确认落库）

`POST /api/outbounds`
请求：

```json
{
  "customer": "李四",
  "operator": "",
  "date": "2026-08-31",
  "remark": "",
  "lines": [ { "product_id": 1, "unit": "斤", "quantity": 3, "price": 8, "pack_fee": null } ],
  "pack_lines": [],
  "pack_fee_total": null
}
```

响应：

```json
{
  "order": { "id": 1, "code": "CK202608310001", "...": "...", "lines": [] },
  "warnings": ["..."]
}
```

### 5.4 删除出库

`DELETE /api/outbounds/{oid}` → `{ "ok": true }`

### 5.5 批量删除

`POST /api/outbounds/batch-delete` 请求：`{ "ids": [1] }` → `{ "ok": true, "deleted": 1, "missing": 0 }`

***

## 6. 库存 Inventory

### 6.1 库存流水

`GET /api/movements?product_id=0&date_from=&date_to=`（最多 500 条，倒序）
响应：

```json
[
  {
    "id": 1, "product_id": 1, "product_name": "番茄",
    "move_type": "in", "quantity_base": 100, "amount": 300,
    "date": "2026-08-31", "operator": "管理员", "remark": ""
  }
]
```

`move_type`：`in` 入库 / `out` 出库 / `pack_out` 关联扣减 / `adjust` 盘点。

### 6.2 库存盘点调整

`POST /api/adjust`
请求：

```json
{
  "product_id": 1,
  "quantity": -5,
  "unit_price": 0,
  "remark": "盘亏",
  "operator": "",
  "date": "2026-08-31"
}
```

`quantity` 以基础单位计，正=盘盈，负=盘亏，不可为 0。
响应：`{ "ok": true, "stock": 95, "avg_cost": 3, "stock_value": 285 }`

### 6.3 库存总览

`GET /api/stock-overview`
响应：

```json
[
  {
    "id": 1, "name": "番茄", "category": "蔬菜",
    "base_unit": "克", "stock": 95000, "stock_display": "95 公斤",
    "avg_cost": 0.003, "stock_value": 285
  }
]
```

***

## 7. 报表 / 财务 Report

### 7.1 首页看板

`GET /api/dashboard`
响应：

```json
{
  "user_name": "管理员",
  "today": "2026-08-31",
  "today_summary": { "revenue": 0, "gross": 0, "net": 0, "orders": 0 },
  "month_summary": { "revenue": 0, "gross": 0, "net": 0, "orders": 0 },
  "stock_value": 1234.5,
  "low_stock": [ { "id": 1, "name": "番茄", "stock": 0, "base_unit": "克", "default_unit": "公斤", "conversions": {} } ],
  "recent_inbounds": [ { "code": "", "product_name": "", "quantity": 0, "unit": "", "date": "", "operator": "", "amount": 0 } ],
  "recent_outbounds": [ { "code": "", "customer": "", "date": "", "operator": "", "amount": 0, "net": 0 } ],
  "product_count": 30
}
```

### 7.2 经营汇总

`GET /api/report/summary?date_from=&date_to=`
响应：

```json
{
  "date_from": "", "date_to": "",
  "revenue": 0, "cogs": 0, "gross_profit": 0,
  "expense": 0, "net_profit": 0, "purchase": 0, "stock_value": 0,
  "order_count": 0, "inbound_count": 0,
  "by_product": [ { "product_id": 1, "name": "番茄", "qty": 3, "amount": 24, "cogs": 12 } ],
  "fee_breakdown": { "人工打包费": 0, "其他支出": 0 }
}
```

### 7.3 财务流水

`GET /api/finance?date_from=&date_to=`
响应：`[{id, type(income/expense), category, product_id, product_name, amount, date, operator, remark, ref_type, ref_id}]`

### 7.4 新增财务记录（手动）

`POST /api/finance`
请求：

```json
{
  "type": "expense",
  "category": "其他支出",
  "amount": 50,
  "date": "2026-08-31",
  "operator": "",
  "remark": "打车费"
}
```

响应：`{ "ok": true, "id": 1 }`

### 7.5 删除财务记录

`DELETE /api/finance/{fid}` → `{ "ok": true }`（仅可删除手动记录，单据自动生成的需在对应单据中删）

***

## 8. 备份 Backup

* `GET /api/backups` → `{ "config": {enabled, interval_hours, keep}, "backups": [{name, size, size_human, mtime}] }`

* `POST /api/backup` → 立即备份：`{ "ok": true, "name": "erp_backup_....db", "backups": [...] }`

* `POST /api/backup/restore` 请求：`{ "name": "erp_backup_....db" }` → `{ "ok": true }`

* `DELETE /api/backup/{name}` → `{ "ok": true, "backups": [...] }`

* `POST /api/backup/config` 请求：`{ "enabled": true, "interval_hours": 2, "keep": 30 }` → `{ "ok": true, "config": {...} }`

***

## 9. AI 智能录入

> 需在 `product_rules.json` 的 `llm` 段配置 api\_key（`enabled: false` 或未配置时接口返回 400）。

### 9.1 文字解析（非流式）

`POST /api/ai/parse`
请求：`{ "text": "今天入库了100斤木耳，25一斤" }`
响应：

```json
{
  "type": "inbound",
  "date": "2026-08-31",
  "supplier": "", "customer": "", "remark": "",
  "lines": [
    {
      "product_id": 1, "product_name": "木耳", "quantity": 50,
      "unit": "公斤", "unit_price": 50,
      "matched": true, "auto_created": false,
      "hint": "已匹配「木耳」（stock）"
    }
  ],
  "raw": "今天入库了100斤木耳，25一斤"
}
```

> 入库时若商品不存在会自动新增并标记 `auto_created: true`；`quantity/unit_price` 已折算到默认展示单位。

### 9.2 文字解析（流式，推荐）

`POST /api/ai/parse/stream`
请求：`{ "text": "..." }`；响应 `Content-Type: text/event-stream`（SSE）。
事件逐行推送：

```
data: {"delta": "模型增量文本"}

data: {"result": { ...同上 9.1 结果结构... }}

data: {"done": true}
```

异常时推送：`data: {"error": "..."}`。

### 9.3 票据图片识别（流式）

`POST /api/ai/parse-image/stream`

* `Content-Type: multipart/form-data`

* 字段：`file`（图片文件，必填）、`text`（补充说明，可选）
  响应 SSE 事件同上，`result` 额外含 `image_url`（如 `/uploads/invoice_xxx.jpg`，用于确认框预览与入库/出库备注挂图）。

***

## 10. 鲜货现采 Fresh

### 10.1 鲜货库存（按展示清单顺序）

`GET /api/fresh`
响应：

```json
{
  "items": [
    { "id": 41, "name": "七彩土豆", "category": "蔬菜", "unit": "公斤",
      "stock": 15, "avg_cost": 4, "stock_value": 60 }
  ],
  "ids": [41, 149, 295]
}
```

`ids` 为当前用户配置的展示清单（有序商品 id）；清单外鲜货自动追加在末尾。

### 10.2 全部可选鲜货商品

`GET /api/fresh/options`
响应：`{ "items": [ { "id": 1, "name": "", "category": "", "unit": "" } ] }`

### 10.3 保存展示清单

`POST /api/fresh/config`
请求：`{ "ids": [41, 149, 295, 120] }` → `{ "ok": true, "count": 4 }`

### 10.4 导入今日订单预演算（不扣库存）

`POST /api/fresh/plan`

* `Content-Type: multipart/form-data`，字段：`file`（聚水潭订单 .xlsx）
  响应：

```json
{
  "items": [
    { "id": 1, "name": "番茄", "unit": "公斤", "stock": 10, "need": 3, "remain": 7, "suggest": 0 }
  ],
  "order_count": 10, "failed_count": 0, "skip": { "待出库": 0, "作废": 0, "其他": 0 },
  "unmapped": ["未关联编码"]
}
```

***

## 11. 批量导入 / 聚水潭 Import

### 11.1 模板下载（.xlsx 文件）

* `GET /api/templates/products`

* `GET /api/templates/inbounds`

* `GET /api/templates/outbounds`

### 11.2 商品批量导入

`POST /api/import/products`（multipart：`file`）
响应：`{ "ok": true, "created": n, "skipped": n, "failed": [{"row", "reason"}], "product_ids": [...], "failed_count": n }`

### 11.3 入库导入

* `POST /api/import/inbounds/preview`（multipart：`file`）→ `{ "items": [DraftInbound], "failed": [], "failed_count": 0 }`

  * DraftInbound：`{product_id, product_name, unit, quantity, unit_price, supplier, date, operator, remark}`

* `POST /api/import/inbounds/confirm` 请求：`{ "items": [DraftInbound...] }` → `{ "ok": true, "created": n, "failed": [...], "failed_count": n }`

* `POST /api/import/inbounds`（multipart：`file`，直接导入）→ 同上

### 11.4 出库导入

* `POST /api/import/outbounds/preview`（multipart：`file`）→ `{ "orders": [DraftOrder], "failed": [...], "failed_count": n }`

  * DraftOrder：`{doc_no, date, customer, operator, remark, pack_fee, lines:[{product_id, product_name, unit, quantity, price, amount, deduct}]}`

* `POST /api/import/outbounds/confirm` 请求：`{ "orders": [DraftOrder...] }` → `{ "ok": true, "created": n, "failed": [...], "warnings": [...], "failed_count": n }`

* `POST /api/import/outbounds`（multipart：`file`，直接导入）

### 11.5 聚水潭出库单

* `POST /api/jushuitan/parse`（multipart：`file`）→ 解析出外部商品编码并推荐匹配：

  ```json
  {
    "total_orders": 10,
    "skip": { "待出库": 0, "作废": 0, "其他": 0 },
    "codes": [
      { "external_code": "京鲜生茯苓500g", "count": 2, "spec": "500 g/件",
        "product_id": 1, "product_name": "茯苓", "score": 1.0 }
    ]
  }
  ```

* `POST /api/jushuitan/import/preview`（multipart：`file`）→ `{ "orders": [DraftOrder], "skip": {...}, "failed": [...], "unmapped_codes": [...], "failed_count": n }`

* `POST /api/jushuitan/import/confirm` 请求：`{ "orders": [DraftOrder...] }` → 确认导入

* `POST /api/jushuitan/import`（multipart：`file`，直接导入）→ `{ "ok": true, "created": n, "skip": {...}, "failed": [...], "warnings": [...], "unmapped_codes": [...], "failed_count": n }`

### 11.6 商品编码关联（CodeMapping）

* `GET /api/mappings` → `[{id, source, external_code, external_name, product_id, product_name, auto_score}]`

* `POST /api/mappings` 请求：`{ "source": "jushuitan", "external_code": "京鲜生茯苓500g", "product_id": 1 }` → `{ "ok": true }`

* `POST /api/mappings/bulk` 请求：`{ "source": "jushuitan", "items": [{external_code, product_id}...] }` → `{ "ok": true, "saved": n }`

* `POST /api/mappings/auto` → 自动为未关联编码推荐匹配：`{ "ok": true, "matched": n, "total": n }`

* `DELETE /api/mappings?source=jushuitan` → 清空该来源全部关联

* `DELETE /api/mappings/{mid}` → 删除单条

***

## 12. 静态资源 / 上传

* `GET /uploads/{filename}`：AI 票据识别时保存的票据图片，可直接用做 `<img src>` 预览，也可写入备注（形如 `/uploads/invoice_20260831_xxx.jpg`）。

***

## 13. Flutter 对接速查

1. **基础 URL**：`http://20.24.210.119`（nginx 80）。本地联调可用 `http://127.0.0.1:8000`（注意 127.0.0.1 只在本机；真机调试用局域网 IP + 8000 或部署后域名/公网 IP）。
2. **登录**：`POST /api/auth/login` → 捕获 `set-cookie` 里的 `erp_token`。
3. **鉴权**：每个请求头加 `Cookie: erp_token=xxx`；遇 `401` 则重新登录。
4. **文件上传**：`multipart/form-data`，文件字段名统一为 `file`（AI 图片接口另有 `text` 字段）。
5. **流式 AI**：`parse/stream`、`parse-image/stream` 返回 `text/event-stream`，按行解析 `data: `  前缀的 JSON，事件键为 `delta` / `result` / `error` / `done`。
6. **关键业务时序建议**：

   * 销售出库：`GET /api/products` 选商品 → `POST /api/outbounds/preview` 看明细/预警 → 确认后 `POST /api/outbounds`；

   * 智能录入：`POST /api/ai/parse/stream`（或票据图）→ 前端确认 → 按 `type` 调 `POST /api/inbounds` 或 `POST /api/outbounds` 落库。

