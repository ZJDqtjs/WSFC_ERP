// 写接口重放差分：同一串用例依次打到 Python(8050,_gosb/py) 与 Go(8100,_gosb/go) 各自的独立库副本，
// 逐步比对响应，全部跑完再比对最终状态快照（验证写入是否算出同一本账：库存/FIFO/财务/待付款）。
// 用法：node go/_diff/write.mjs [--module=all] [--only=12] [--snap=/api/stocks,/api/movements] [--verbose]
// 大表快照（如 /api/outbounds 单次 40MB+）在低内存机器上容易把紧随的请求拖成 status 0：
// 收尾可用 --snap 分批比，最后再不带 --snap 跑一次全量快照。
const PY = process.env.PY_BASE || 'http://127.0.0.1:8050';
const GO = process.env.GO_BASE || 'http://127.0.0.1:8100';
const TOKEN = process.env.ERP_TOKEN || '';
const ROOT = process.env.REPO || 'D:/code/WSFC_ERP';
const args = Object.fromEntries(process.argv.slice(2).map(a => { const [k, ...r] = a.replace(/^--/, '').split('='); return [k, r.length ? r.join('=') : true]; }));

import fs from 'node:fs';

// ---- 用例表 ----
// save: 把响应里的字段存进本侧变量（PY/GO 各存各的，路径 ${var} 按侧替换）
// cmp:  可选，自定义可比字段（默认整包深度比对）
const D = '2026-10-01', D2 = '2026-10-02', D3 = '2026-10-03';
const CASES = [
  // === 单位 ===
  { m: 'POST', p: '/api/units', b: { name: '差分测试斤', category: 'weight', gram_per_unit: 500 }, save: 'wuid', tag: 'units' },
  { m: 'POST', p: '/api/units', b: { name: '差分测试包', category: 'count' }, save: 'cuid', tag: 'units' },
  { m: 'POST', p: '/api/units', b: { name: '公斤', category: 'weight', gram_per_unit: 1000 }, tag: 'units', note: '重名应 400' },
  { m: 'POST', p: '/api/units', b: { name: '', category: 'weight' }, tag: 'units', note: '空名 400' },
  { m: 'POST', p: '/api/units', b: { name: '差分测试X', category: 'other' }, tag: 'units', note: '非法类型 400' },
  { m: 'POST', p: '/api/units', b: { name: '差分测试克', category: 'weight' }, tag: 'units', note: '重量类缺克数 400' },
  { m: 'DELETE', p: '/api/units/${cuid}', tag: 'units' },
  { m: 'DELETE', p: '/api/units/1', tag: 'units', note: '标准单位不可删' },

  // === 商品 ===
  { m: 'POST', p: '/api/products', b: { code: 'DC001', name: '差分测试白菜', category: '蔬菜', product_type: 'stock', base_unit: '克', default_unit: '公斤', spec: '2公斤', sale_price: 9.9, unit_cost: 3.333, weight_kg: 2.5, free_shipping: false, conversions: { 公斤: 1000, 斤: 500 }, pack_fee: 1.5 }, save: 'pid', tag: 'products' },
  { m: 'POST', p: '/api/products', b: { name: '差分测试订单商品', category: '蔬菜', product_type: 'order', base_unit: '单', default_unit: '单', sale_price: 19.9, stock_links: [{ product_id: 280, multiplier: 0.5 }] }, save: 'opid', tag: 'products' },
  { m: 'POST', p: '/api/products', b: { name: '' }, tag: 'products', note: '空名 400' },
  { m: 'POST', p: '/api/products', b: { name: '差分测试白菜2', category: '蔬菜', product_type: 'stock', base_unit: '克', default_unit: '公斤', conversions: { 公斤: 0 } }, tag: 'products', note: '非法换算 400' },
  // 编码一对一：冲突 409（detail 是对象，前端据此弹「替换编码」），带 code_takeover 才抢
  { m: 'POST', p: '/api/products', b: { name: '差分测试抢编码', code: 'DC001', product_type: 'stock', base_unit: '克' }, tag: 'products', note: '409 编码被占' },
  { m: 'POST', p: '/api/products', b: { name: '差分测试抢编码', code: ' DC001 ', product_type: 'stock', base_unit: '克' }, tag: 'products', note: 'trim 后同样冲突' },
  { m: 'POST', p: '/api/products', b: { name: '差分测试占编码', code: 'DC001', product_type: 'stock', base_unit: '克', code_takeover: true }, save: 'tpid', tag: 'products', note: '替换：原商品编码清空' },
  { m: 'PUT', p: '/api/products/${tpid}', b: { name: '差分测试占编码', code: 'DC001', product_type: 'stock', base_unit: '克' }, tag: 'products', note: '编码没变 → 不校验冲突' },
  { m: 'PUT', p: '/api/products/${pid}', b: { name: '差分测试白菜', code: 'DC001', category: '蔬菜', product_type: 'stock', base_unit: '克', default_unit: '公斤' }, tag: 'products', note: '原主想抢回 → 409（已被占）' },
  { m: 'PUT', p: '/api/products/${pid}', b: { code: 'DC001B', name: '差分测试白菜改', category: '水果', product_type: 'stock', base_unit: '克', default_unit: '斤', spec: '', sale_price: 12.34, unit_cost: 4.56, weight_kg: 1.2, free_shipping: true, conversions: { 斤: 500 }, pack_items: [{ product_id: 1, quantity: 2, unit: '个' }], pack_fee: 2 }, tag: 'products' },
  { m: 'POST', p: '/api/products/batch-update', b: { ids: ['${pid}', '${opid}'], category: '蔬菜', default_unit: '公斤', is_active: true, sale_price: 8.88, unit_cost: 2.22, pack_fee: 0.5, free_shipping: false }, tag: 'products' },
  { m: 'POST', p: '/api/products/batch-update', b: { ids: [], category: '蔬菜' }, tag: 'products', note: '空 ids' },
  { m: 'POST', p: '/api/products/batch-delete', b: { ids: ['${opid}'] }, tag: 'products' },
  { m: 'DELETE', p: '/api/products/${pid}', tag: 'products' },
  { m: 'DELETE', p: '/api/products/999999', tag: 'products', note: '不存在 404' },
  { m: 'DELETE', p: '/api/products/${tpid}', tag: 'products', note: '清掉替换用例建的商品' },
  // 多套扣减方案：null=保留原方案、[]=清空；库存商品须 stock 且倍数>0、每套至少一项；未传 stock_links 时同步成第一套
  { m: 'POST', p: '/api/products', b: { name: '差分方案订单', category: '蔬菜', product_type: 'order', base_unit: '单', default_unit: '单', stock_schemes: [{ name: '方案甲', links: [{ product_id: 1, multiplier: 1 }] }, { name: '', links: [{ product_id: 2, multiplier: 2 }, { product_id: 2 }] }] }, save: 'schid', tag: 'products', note: '两套方案：空名补「方案2」，同套重复项只留第一个' },
  { m: 'PUT', p: '/api/products/${schid}', b: { name: '差分方案订单', product_type: 'order', base_unit: '单', default_unit: '单' }, tag: 'products', note: '不传 stock_schemes → 保留原方案' },
  { m: 'PUT', p: '/api/products/${schid}', b: { name: '差分方案订单', product_type: 'order', base_unit: '单', default_unit: '单', stock_schemes: [{ name: 'B单', links: [{ product_id: 280, multiplier: 1.5 }] }] }, tag: 'products', note: '改方案且未传 stock_links → links 同步成第一套' },
  { m: 'PUT', p: '/api/products/${schid}', b: { name: '差分方案订单', product_type: 'order', base_unit: '单', default_unit: '单', stock_schemes: null }, tag: 'products', note: '显式 null = 保留（与未传同义）' },
  { m: 'PUT', p: '/api/products/${schid}', b: { name: '差分方案订单', product_type: 'order', base_unit: '单', default_unit: '单', stock_schemes: [] }, tag: 'products', note: '传 [] → 清空方案' },
  { m: 'PUT', p: '/api/products/${schid}', b: { name: '差分方案订单', product_type: 'order', base_unit: '单', default_unit: '单', stock_schemes: [{ name: '坏方案', links: [{ product_id: 999999, multiplier: 1 }] }] }, tag: 'products', note: '库存商品不存在 400' },
  { m: 'PUT', p: '/api/products/${schid}', b: { name: '差分方案订单', product_type: 'order', base_unit: '单', default_unit: '单', stock_schemes: [{ name: '坏方案', links: [{ product_id: '${schid}', multiplier: 1 }] }] }, tag: 'products', note: '关联订单小类 → 400' },
  { m: 'PUT', p: '/api/products/${schid}', b: { name: '差分方案订单', product_type: 'order', base_unit: '单', default_unit: '单', stock_schemes: [{ name: '坏方案', links: [{ product_id: 1, multiplier: 0 }] }] }, tag: 'products', note: '倍数 0 → 400' },
  { m: 'PUT', p: '/api/products/${schid}', b: { name: '差分方案订单', product_type: 'order', base_unit: '单', default_unit: '单', stock_schemes: [{ name: '空方案', links: [] }] }, tag: 'products', note: '空方案 → 400' },
  { m: 'POST', p: '/api/products', b: { name: '差分方案库存', category: '蔬菜', product_type: 'stock', base_unit: '克', default_unit: '公斤', conversions: { 公斤: 1000 }, unit_cost: 4, stock_schemes: [{ name: 'A', links: [{ product_id: 280, multiplier: 3 }] }, { name: 'B', links: [{ product_id: 1, multiplier: 1 }] }] }, save: 'spid2', tag: 'products', note: '库存大类也能挂方案（出库只在订单小类选方案）' },
  { m: 'DELETE', p: '/api/products/${schid}', tag: 'products', note: '清掉方案夹具' },
  { m: 'DELETE', p: '/api/products/${spid2}', tag: 'products', note: '清掉方案夹具2' },

  // === 改基础单位（计数「个」↔ 重量「克」）：有历史必须给换算关系，历史数量按系数折算后由 FIFO 重算库存/均价 ===
  { m: 'POST', p: '/api/products', b: { name: '差分换单位商品', category: '蔬菜', product_type: 'stock', base_unit: '个', default_unit: '个', conversions: { 个: 1 }, unit_cost: 5 }, save: 'uba', tag: 'unit' },
  { m: 'POST', p: '/api/inbounds', b: { product_id: '${uba}', unit: '个', quantity: 10, unit_price: 5, supplier: '差分换单位', date: D, pay_status: 'paid' }, save: 'ubia', tag: 'unit', note: '先造 10 个的历史（流水 + 入库行）' },
  { m: 'PUT', p: '/api/products/${uba}', b: { name: '差分换单位商品', category: '蔬菜', product_type: 'stock', base_unit: '克', default_unit: '克', conversions: { 克: 1000 }, unit_cost: 5 }, tag: 'unit', note: '跨类别不给换算关系 → 400，中文文案逐字对齐' },
  { m: 'PUT', p: '/api/products/${uba}', b: { name: '差分换单位商品', category: '蔬菜', product_type: 'stock', base_unit: '克', default_unit: '克', conversions: { 克: 1000 }, unit_cost: 5, unit_change_ratio: 1000 }, tag: 'unit', note: '1 个 = 1000 克 → 流水/入库 quantity_base 一起折算' },
  { m: 'PUT', p: '/api/products/${uba}', b: { name: '差分换单位商品', category: '蔬菜', product_type: 'stock', base_unit: '克', default_unit: '公斤', conversions: { 公斤: 1000 }, unit_cost: 5, unit_change_ratio: 500 }, tag: 'unit', note: '克→克 同类别：系数被忽略、历史不动（只改默认单位）' },
  { m: 'PUT', p: '/api/products/${uba}', b: { name: '差分换单位商品', category: '蔬菜', product_type: 'stock', base_unit: '个', default_unit: '个', conversions: { 个: 1 }, unit_cost: 5, unit_change_ratio: 0.001 }, tag: 'unit', note: '折回「个」→ 数量回到 10，验证小数系数' },
  { m: 'POST', p: '/api/products', b: { name: '差分换单位无历史', category: '蔬菜', product_type: 'stock', base_unit: '个', default_unit: '个', conversions: { 个: 1 } }, save: 'ubb', tag: 'unit', note: '无历史 → 改单位不需要系数' },
  { m: 'PUT', p: '/api/products/${ubb}', b: { name: '差分换单位无历史', category: '蔬菜', product_type: 'stock', base_unit: '克', default_unit: '克', conversions: { 克: 1000 } }, tag: 'unit' },
  { m: 'DELETE', p: '/api/inbounds/${ubia}', tag: 'unit', note: '清夹具：先删入库单' },
  { m: 'DELETE', p: '/api/products/${uba}', tag: 'unit' },
  { m: 'DELETE', p: '/api/products/${ubb}', tag: 'unit' },

  // === 入库（含运费/装卸/金额调整，会牵动库存、成本、其他开支、待付款） ===
  { m: 'POST', p: '/api/inbounds', b: { product_id: 1, unit: '单', quantity: 100, unit_price: 2.5, supplier: '差分供应商', date: D, remark: '差分入库', pay_status: 'paid', adjust_amount: 1.5, freight: 10, handling: 5 }, save: 'iid', tag: 'inbound' },
  { m: 'POST', p: '/api/inbounds', b: { product_id: 2, unit: '单', quantity: 50.25, unit_price: 3.7, supplier: '差分供应商2', date: D2, remark: '', pay_status: 'unpaid', adjust_amount: -2.5, freight: 0, handling: 0 }, save: 'iid2', tag: 'inbound' },
  { m: 'POST', p: '/api/inbounds', b: { product_id: 999999, unit: '单', quantity: 1, unit_price: 1, date: D }, tag: 'inbound', note: '商品不存在' },
  { m: 'POST', p: '/api/inbounds', b: { product_id: 1, unit: '不存在单位', quantity: 1, unit_price: 1, date: D }, tag: 'inbound', note: '单位非法' },
  { m: 'POST', p: '/api/inbounds', b: { product_id: 1, unit: '单', quantity: 0, unit_price: 1, date: D }, tag: 'inbound', note: '数量 0' },
  { m: 'POST', p: '/api/inbounds', b: { product_id: 1, unit: '单', quantity: 1, unit_price: 1, date: '2026-13-45' }, tag: 'inbound', note: '日期非法' },
  { m: 'POST', p: '/api/inbounds/batch', b: { items: [{ product_id: 364, unit: '单', quantity: 10, unit_price: 4.4, supplier: '批量甲', date: D, pay_status: 'paid' }, { product_id: 1, unit: '单', quantity: 5, unit_price: 1.1, supplier: '批量乙', date: D2, pay_status: 'unpaid' }] }, tag: 'inbound' },
  { m: 'POST', p: '/api/inbounds/batch', b: { items: [] }, tag: 'inbound', note: '空批量' },
  { m: 'PUT', p: '/api/inbounds/${iid}', b: { supplier: '差分供应商改', date: D2, pay_status: 'paid', freight: 20, handling: null }, tag: 'inbound' },
  { m: 'PUT', p: '/api/inbounds/${iid2}', b: { supplier: '改2', date: D3, pay_status: 'paid' }, tag: 'inbound', note: 'unpaid→paid 应写 paid_at 并退出待付款' },
  { m: 'POST', p: '/api/inbounds/batch-delete', b: { ids: ['${iid2}'] }, tag: 'inbound' },
  { m: 'DELETE', p: '/api/inbounds/${iid}', tag: 'inbound' },
  { m: 'DELETE', p: '/api/inbounds/999999', tag: 'inbound', note: '不存在' },

  // === 出库（FIFO 成本、快递费、包材人工、金额调整、实收口径） ===
  { m: 'POST', p: '/api/outbounds/preview', b: { lines: [{ product_id: 362, unit: '单', quantity: 3, price: 19.9 }], auto_express: true }, tag: 'outbound', note: '预览' },
  { m: 'POST', p: '/api/outbounds/preview', b: { lines: [{ product_id: 362, unit: '单', quantity: 3, price: 19.9 }], auto_express: false, settle_cats: ['material', 'labor', 'express'] }, tag: 'outbound' },
  // 出库自动选扣减方案：哪套里的库存商品「最近一次采购入库」更新就扣哪套；一单多货规则指定库存大类时优先按规则（方案名留空）
  { m: 'POST', p: '/api/products', b: { name: '差分方案库存A', category: '蔬菜', product_type: 'stock', base_unit: '克', default_unit: '公斤', conversions: { 公斤: 1000 }, unit_cost: 5 }, save: 'sa_id', tag: 'outbound' },
  { m: 'POST', p: '/api/products', b: { name: '差分方案库存B', category: '蔬菜', product_type: 'stock', base_unit: '克', default_unit: '公斤', conversions: { 公斤: 1000 }, unit_cost: 6 }, save: 'sb_id', tag: 'outbound' },
  { m: 'POST', p: '/api/inbounds', b: { product_id: '${sa_id}', unit: '公斤', quantity: 100, unit_price: 5, supplier: '差分方案', date: D, pay_status: 'paid' }, tag: 'outbound', note: '方案A 库存 10-01 进货' },
  { m: 'POST', p: '/api/inbounds', b: { product_id: '${sb_id}', unit: '公斤', quantity: 100, unit_price: 6, supplier: '差分方案', date: D3, pay_status: 'paid' }, tag: 'outbound', note: '方案B 库存 10-03 进货（更新）' },
  { m: 'POST', p: '/api/products', b: { name: '差分自动选方案', category: '蔬菜', product_type: 'order', base_unit: '单', default_unit: '单', conversions: { 单: 1 }, stock_links: [{ product_id: 280, multiplier: 1 }], stock_schemes: [{ name: '方案A', links: [{ product_id: '${sa_id}', multiplier: 1 }] }, { name: '方案B', links: [{ product_id: '${sb_id}', multiplier: 2 }] }] }, save: 'so_id', tag: 'outbound', note: '配了多方案 → 优先于 stock_links' },
  { m: 'POST', p: '/api/outbounds/preview', b: { lines: [{ product_id: '${so_id}', unit: '单', quantity: 2, price: 19.9 }], auto_express: false }, tag: 'outbound', note: '预览应自动选方案B：扣 B 2×2×1000 克' },
  { m: 'POST', p: '/api/outbounds/preview', b: { lines: [{ product_id: '${so_id}', unit: '单', quantity: 2, price: 19.9, stock_product_id: '${sa_id}', multiplier: 3 }], auto_express: false }, tag: 'outbound', note: '明细多带 stock_product_id/multiplier → pydantic 不认，仍自动选方案B' },
  { m: 'POST', p: '/api/outbounds', b: { customer: '差分方案客户', date: D3, remark: '方案出库', lines: [{ product_id: '${so_id}', unit: '单', quantity: 1, price: 19.9 }], auto_express: false, pay_status: 'paid' }, save: 'soid', tag: 'outbound', note: '真实落库：扣 B 1×2×1000 克' },
  { m: 'DELETE', p: '/api/outbounds/${soid}', tag: 'outbound', note: '回滚方案出库（流水/成本复原）' },
  { m: 'POST', p: '/api/products/batch-delete', b: { ids: ['${so_id}'] }, tag: 'outbound', note: '清掉方案订单夹具' },
  { m: 'POST', p: '/api/outbounds', b: { customer: '差分客户', date: D, remark: '差分出库', lines: [{ product_id: 362, unit: '单', quantity: 2, price: 19.9 }], auto_express: true, pay_status: 'paid', adjust_amount: -0.5 }, save: 'oid', tag: 'outbound' },
  { m: 'POST', p: '/api/outbounds', b: { customer: '差分客户2', date: D2, remark: '', lines: [{ product_id: 1, unit: '单', quantity: 1, price: 5 }], pack_lines: [{ product_id: 2, unit: '单', quantity: 1, cogs: 3.3 }], pack_fee_total: 2.5, auto_express: false, pay_status: 'unpaid', settle_cats: ['material'] }, save: 'oid2', tag: 'outbound' },
  { m: 'POST', p: '/api/outbounds', b: { customer: '超库存', date: D, lines: [{ product_id: 280, unit: '公斤', quantity: 999999, price: 1 }] }, tag: 'outbound', note: '库存不足文案' },
  { m: 'POST', p: '/api/outbounds', b: { customer: '空行', date: D, lines: [] }, tag: 'outbound', note: '无明细' },
  { m: 'PUT', p: '/api/outbounds/${oid}', b: { customer: '差分客户改', date: D3, pay_status: 'unpaid', settle_cats: ['express'] }, tag: 'outbound' },
  { m: 'POST', p: '/api/outbounds/batch-delete', b: { ids: ['${oid2}'] }, tag: 'outbound' },
  { m: 'DELETE', p: '/api/outbounds/${oid}', tag: 'outbound' },

  // === 库存调整 ===
  { m: 'POST', p: '/api/adjust', b: { product_id: 1, quantity: '+10', unit: '单', avg_cost_adj: '+0.5', unit_cost_adj: '-0.2', date: D2, remark: '差分调整' }, tag: 'inventory' },
  { m: 'POST', p: '/api/adjust', b: { product_id: 2, quantity: '-1', unit: '单', date: D3, remark: '盘点减少' }, tag: 'inventory' },
  { m: 'POST', p: '/api/adjust', b: { product_id: 2, quantity: 'abc', unit: '单', date: D3 }, tag: 'inventory', note: '非法调整串' },
  { m: 'POST', p: '/api/adjust', b: { product_id: 2, quantity: '', avg_cost_adj: '3', date: D3 }, tag: 'inventory', note: '缺正负号' },

  // === 其他开支 ===
  { m: 'POST', p: '/api/other-expenses', b: { category: '网线费', amount: 123.456, date: D3, remark: '差分', pay_status: 'paid' }, save: 'eid', tag: 'others' },
  { m: 'POST', p: '/api/other-expenses', b: { category: '差分自定义类型', amount: 7, date: D3, pay_status: 'unpaid' }, save: 'eid2', tag: 'others' },
  { m: 'POST', p: '/api/other-expenses', b: { category: '', amount: 7, date: D3 }, tag: 'others', note: '缺类型' },
  { m: 'POST', p: '/api/other-expenses', b: { category: '运费', amount: 0, date: D3 }, tag: 'others', note: '金额 0' },
  { m: 'POST', p: '/api/other-expenses', b: { category: '运费', amount: 5, date: '2026/10/03' }, tag: 'others', note: '日期格式' },
  { m: 'PUT', p: '/api/other-expenses/${eid}', b: { category: '安装费', amount: 200, date: D2, remark: '改', pay_status: 'unpaid' }, tag: 'others' },
  { m: 'DELETE', p: '/api/other-expenses/${eid2}', tag: 'others' },
  { m: 'DELETE', p: '/api/other-expenses/${eid}', tag: 'others' },

  // === 扣点 / 快递 / 打包规则 ===
  { m: 'POST', p: '/api/deductions', b: { category: '差分测试类', percent: 8.88, remark: 'x' }, save: 'did', tag: 'deductions' },
  { m: 'POST', p: '/api/deductions', b: { category: '差分测试类', percent: 12.5 }, tag: 'deductions', note: '同名 upsert' },
  { m: 'DELETE', p: '/api/deductions/${did}', tag: 'deductions' },
  { m: 'POST', p: '/api/deductions/shops', b: { shop: '差分店铺', percent: 5.5 }, tag: 'deductions' },
  { m: 'POST', p: '/api/deductions/shops', b: { shop: '差分店铺', categories: { 蔬菜: 6.6, 水果: 7.7 } }, tag: 'deductions' },
  { m: 'DELETE', p: '/api/deductions/shops/差分店铺', tag: 'deductions' },
  { m: 'PUT', p: '/api/express/rule', b: { mode: 'tiered', first_kg_fee: 4.2, per_extra_kg: 1.2, rate_per_kg: 4.2, round_up: false }, tag: 'express' },
  { m: 'PUT', p: '/api/express/rule', b: { mode: 'flat', first_kg_fee: 3.6, per_extra_kg: 1, rate_per_kg: 2.5, round_up: true }, tag: 'express' },
  { m: 'PUT', p: '/api/express/rule', b: { mode: 'nope' }, tag: 'express', note: '非法计费方式' },
  { m: 'PUT', p: '/api/express/rule', b: { mode: 'tiered', first_kg_fee: 99999 }, tag: 'express', note: '越界' },
  { m: 'POST', p: '/api/pack-rules', b: { items: [{ product_id: 362, name: '新鲜天麻净重1斤单果60g+', quantity: 1, stock_product_id: 280, multiplier: 0.5 }], box_items: [{ product_id: null, name: '3号', quantity: 1 }], box_type: '3号', labor_price: 1.5, box_ratio: 1, remark: '差分', is_active: true }, save: 'prid', tag: 'pack_rules' },
  { m: 'POST', p: '/api/pack-rules', b: { items: [] }, tag: 'pack_rules', note: '空 items' },
  { m: 'PUT', p: '/api/pack-rules/${prid}', b: { items: [{ product_id: 362, name: '新鲜天麻净重1斤单果60g+', quantity: 2, stock_product_id: 280, multiplier: 1 }], box_items: [], box_type: '5号', labor_price: 2.5, box_ratio: 0.5, remark: '改', is_active: false }, tag: 'pack_rules' },
  { m: 'DELETE', p: '/api/pack-rules/${prid}', tag: 'pack_rules' },

  // === 账单 / 财务 ===
  { m: 'POST', p: '/api/inbounds', b: { product_id: 1, unit: '单', quantity: 3, unit_price: 1, date: D, pay_status: 'unpaid' }, save: 'pay_iid', tag: 'payables' },
  { m: 'POST', p: '/api/payables/pay', b: { kind: 'inbound', id: '${pay_iid}', paid: true }, tag: 'payables' },
  { m: 'POST', p: '/api/payables/pay', b: { kind: 'inbound', id: '${pay_iid}', paid: false }, tag: 'payables', note: '撤销支付' },
  { m: 'POST', p: '/api/payables/pay-batch', b: { kind: 'other', ids: ['${pay_iid}'], paid: true }, tag: 'payables', note: 'kind 不匹配' },
  { m: 'POST', p: '/api/payables/pay', b: { kind: '不存在', id: 1 }, tag: 'payables', note: '非法 kind' },
  { m: 'DELETE', p: '/api/inbounds/${pay_iid}', tag: 'payables' },
  { m: 'POST', p: '/api/finance', b: { type: 'expense', category: '房租', amount: 800, date: D3, remark: '差分', pay_status: 'paid' }, save: 'fid', tag: 'report' },
  { m: 'POST', p: '/api/finance', b: { type: 'income', category: '其他收入', amount: 50.5, date: D3, pay_status: 'unpaid' }, save: 'fid2', tag: 'report' },
  { m: 'POST', p: '/api/finance', b: { type: 'wrong', category: 'x', amount: 1, date: D3 }, tag: 'report', note: '非法 type' },
  { m: 'DELETE', p: '/api/finance/${fid}', tag: 'report' },
  { m: 'DELETE', p: '/api/finance/${fid2}', tag: 'report' },

  // === 鲜货配置 ===
  { m: 'POST', p: '/api/fresh/config', b: { ids: [1, 2, 364] }, tag: 'fresh' },
  { m: 'POST', p: '/api/fresh/config', b: { ids: [] }, tag: 'fresh' },

  // === 分仓 ===
  { m: 'POST', p: '/api/warehouses', b: { name: '差分测试仓' }, save: 'newwh', tag: 'warehouses' },
  { m: 'POST', p: '/api/warehouses', b: { name: '差分测试仓' }, tag: 'warehouses', note: '重名' },
  { m: 'POST', p: '/api/warehouses', b: { name: '', key: 'bad key' }, tag: 'warehouses', note: '非法 key' },
  { m: 'POST', p: '/api/warehouses/switch', b: { key: 'aosidi' }, tag: 'warehouses' },
  { m: 'POST', p: '/api/warehouses/switch', b: { key: 'wh01' }, tag: 'warehouses', note: '切回原仓' },
  { m: 'POST', p: '/api/warehouses/switch', b: { key: '不存在' }, tag: 'warehouses', note: '非法 key' },
];

// 最终状态快照（写入序列跑完后两边应当是同一本账）
const SNAPSHOTS = ['/api/dashboard', '/api/products', '/api/stocks', '/api/units', '/api/inbounds', '/api/outbounds',
  '/api/movements', '/api/adjustments', '/api/stock-overview', '/api/workload', '/api/other-expenses', '/api/other-expenses/stats',
  '/api/deductions', '/api/deductions/shops', '/api/express/rule', '/api/pack-rules', '/api/payables?include_paid=1&days=3650',
  '/api/finance', '/api/fresh', '/api/report/summary', '/api/warehouses'];

const IGNORE_ALWAYS = new Set(['created_at', 'updated_at', 'server_time', 'deadline']);
// file: /api/deductions/shops 回显的是配置文件绝对路径，PY/GO 跑在各自沙箱目录下，不是口径差异
// import_group: 批量导入批次号是 uuid/随机 hex（PY uuid4().hex[:10]、GO 随机 5 字节），
// 两套库各自生成必然不同；已在 _snapchk 核对过两边格式（imp+10 hex）与组数一致，屏蔽掉再看其余字段。
const IGNORE_SNAP = new Set([...IGNORE_ALWAYS, 'id', 'file', 'import_group']);
function norm(v, key, ign) {
  if (key && ign.has(key)) return '<ignore>';
  if (typeof v === 'number') return Math.round(v * 1e4) / 1e4;
  if (Array.isArray(v)) return v.map(x => norm(x, '', ign));
  if (v && typeof v === 'object') { const o = {}; for (const k of Object.keys(v).sort()) o[k] = norm(v[k], k, ign); return o; }
  return v;
}
function deepDiff(a, b, p, out, ign) {
  out = out || []; if (out.length > 40) return out;
  ign = ign || IGNORE_ALWAYS;
  const A = norm(a, '', ign), B = norm(b, '', ign);
  if (JSON.stringify(A) === JSON.stringify(B)) return out;
  if (typeof A !== typeof B || A === null || B === null || typeof A !== 'object') {
    out.push(`${p || '(整包)'}: ${JSON.stringify(A)}  !=  ${JSON.stringify(B)}`);
    return out;
  }
  if (Array.isArray(A) !== Array.isArray(B)) { out.push(`${p}: 一方是数组另一方不是`); return out; }
  if (Array.isArray(A)) {
    if (A.length !== B.length) out.push(`${p}.length: PY=${A.length} GO=${B.length}`);
    const n = Math.min(A.length, B.length);
    // 数组按「同键集合」逐项对齐，避免顺序差异被当成内容差异（顺序另有专门用例覆盖）
    for (let i = 0; i < n; i++) deepDiff(A[i], B[i], `${p}[${i}]`, out, ign);
    return out;
  }
  for (const k of new Set([...Object.keys(A), ...Object.keys(B)])) {
    if (!(k in A)) { out.push(`${p}.${k}: Go 多出`); continue; }
    if (!(k in B)) { out.push(`${p}.${k}: Go 缺`); continue; }
    deepDiff(A[k], B[k], `${p}.${k}`, out, ign);
  }
  return out;
}

async function call(base, method, url, body) {
  const headers = { Cookie: `erp_token=${TOKEN}` };
  let payload;
  if (body !== null && body !== undefined) { headers['Content-Type'] = 'application/json'; payload = JSON.stringify(body); }
  try {
    const res = await fetch(base + url, { method, headers, body: payload, signal: AbortSignal.timeout(30000) });
    const text = await res.text();
    let json; try { json = JSON.parse(text); } catch { json = text.slice(0, 200); }
    return { status: res.status, body: json, headers: Object.fromEntries(res.headers) };
  } catch (e) { return { status: 0, body: String(e.message) }; }
}

const vars = { PY: {}, GO: {} };
function resolve(side, s) {
  return s.replace(/\$\{(\w+)\}/g, (_, k) => {
    const v = vars[side][k];
    return v === undefined ? '0' : encodeURIComponent(String(v));
  });
}
function resolveBody(side, b) {
  if (b === null || b === undefined) return b;
  let s = JSON.stringify(b);
  s = s.replace(/"\$\{(\w+)\}"/g, (_, k) => { const v = vars[side][k]; return v === undefined ? '0' : String(v); });
  s = s.replace(/(\[[^\]]*)"#\{(\w+)\}"/g, '$1"$2"');
  return JSON.parse(s);
}

// 用例过滤：--module=<tag> 只跑该标签；--module=all（或不传）跑全部；--only=<序号> 单条。
let targets = !args.module || args.module === 'all' ? CASES : CASES.filter(c => c.tag === args.module);
if (args.only) targets = targets.filter((c, i) => String(i + 1) === String(args.only).replace(/^\./, ''));

console.log(`写用例 ${targets.length} 条 | PY=${PY} GO=${GO}`);
const results = [];
for (const [i, c] of targets.entries()) {
  const r = {};
  for (const side of ['PY', 'GO']) {
    const base = side === 'PY' ? PY : GO;
    const url = resolve(side, c.p);
    const body = resolveBody(side, c.b);
    const res = await call(base, c.m, url, body);
    r[side] = res;
    if (c.save) {
      const v = res.body && (res.body.id ?? res.body.item?.id ?? res.body.order?.id ?? res.body.key ?? res.body.warehouse?.key ?? res.body.created?.key);
      vars[side][c.save] = v ?? 0;
    }
  }
  const d = r.PY.status === r.GO.status ? deepDiff(r.PY.body, r.GO.body, '') : [];
  const verdict = r.PY.status !== r.GO.status ? 'STATUS' : (d.length ? 'DIFF' : 'OK');
  results.push({ c, ...r, d, verdict });
  const mark = { OK: '✓', DIFF: '✗', STATUS: '!' }[verdict];
  console.log(`${mark} [${String(i + 1).padStart(2)}] ${verdict.padEnd(6)} ${c.m.padEnd(6)} ${c.p}  PY=${r.PY.status} GO=${r.GO.status}${c.note ? '  // ' + c.note : ''}`);
  if (verdict === 'STATUS') console.log(`      PY=${JSON.stringify(r.PY.body).slice(0, 170)}\n      GO=${JSON.stringify(r.GO.body).slice(0, 170)}`);
  else for (const l of d.slice(0, args.verbose ? 99 : 5)) console.log('      - ' + l);
}

console.log('\n==== 最终状态快照 ====');
// 快照单独走一条长超时通道：/api/outbounds 这类大表单次可达 40MB，Python 侧要十几秒，
// 用 30 秒的通用超时会在 GC 抖动时误报成 status 0（看起来像移植差异，其实是取数没跑完）。
async function snapGet(base, url) {
  try {
    const res = await fetch(base + url, { headers: { Cookie: `erp_token=${TOKEN}` }, signal: AbortSignal.timeout(180000) });
    const text = await res.text();
    let json; try { json = JSON.parse(text); } catch { json = text.slice(0, 200); }
    return { status: res.status, body: json };
  } catch (e) {
    console.log(`  ! 取快照失败 ${base}${url}: ${e.name} ${e.message}${e.cause?.code ? ' cause=' + e.cause.code : ''}`);
    return { status: 0, body: String(e.message) };
  }
}
const snaps = [];
for (const g of (args.snap ? String(args.snap).split(',').map(s => (s.startsWith('/') ? s : '/' + s)) : SNAPSHOTS)) {
  if (!SNAPSHOTS.includes(g)) { console.log(`? ${g} 不在快照表里，跳过`); continue; }
  const a = await snapGet(PY, g);
  const b = await snapGet(GO, g);
  if (a.status === 404 && b.status === 404) { snaps.push({ g, d: [], skip: true }); continue; }
  const d = a.status === b.status ? deepDiff(a.body, b.body, '', [], IGNORE_SNAP) : [`status PY=${a.status} GO=${b.status}`];
  snaps.push({ g, d, a: a.status, b: b.status });
  console.log(`${d.length ? '✗' : '✓'} ${g}  PY=${a.status} GO=${b.status}` + (d.length ? `\n      - ${d.slice(0, args.verbose ? 99 : 6).join('\n      - ')}` : ''));
}

const cnt = {};
for (const r of results) cnt[r.verdict] = (cnt[r.verdict] || 0) + 1;
console.log('\n汇总:', JSON.stringify(cnt), '| 快照不一致:', snaps.filter(s => s.d.length).length, '/', snaps.filter(s => !s.skip).length);
fs.writeFileSync(process.env.DIFF_OUT || (ROOT + '/go/_diff/last-write.json'), JSON.stringify({ results, snaps }, null, 1));
