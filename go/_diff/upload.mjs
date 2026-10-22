// imports 模块 multipart 上传差分：同一份 xlsx 夹具先打 Python(8050) 再打 Go(8100)，
// 逐用例比对响应；确认类用例的 body 由该侧 preview 响应回灌（等价前端行为）。
// 用法：ERP_TOKEN=... node go/_diff/upload.mjs [--only=3] [--verbose] [--module=jst]
const PY = process.env.PY_BASE || 'http://127.0.0.1:8050';
const GO = process.env.GO_BASE || 'http://127.0.0.1:8100';
const TOKEN = process.env.ERP_TOKEN || '';
const ROOT = (process.env.REPO || 'D:/code/WSFC_ERP').replace(/\\/g, '/');
const FX = `${ROOT}/_gosb/fixtures`;
const args = Object.fromEntries(process.argv.slice(2).map(a => { const [k, ...r] = a.replace(/^--/, '').split('='); return [k, r.length ? r.join('=') : true]; }));

import fs from 'node:fs';

const JST_DATES = () => '2026-10-01';
const CASES = [
  // ---- 只读：解析预览 ----
  { m: 'POST', p: '/api/import/inbounds/preview', file: 'inbounds.xlsx', tag: 'inbound', cap: 'inPreview', ro: true, note: '入库预览' },
  { m: 'POST', p: '/api/import/inbounds/preview', file: 'bad_header.xlsx', tag: 'inbound', ro: true, note: '表头非法 400' },
  { m: 'POST', p: '/api/import/inbounds/preview', file: 'empty_inbounds.xlsx', tag: 'inbound', ro: true, note: '空明细' },
  { m: 'POST', p: '/api/import/outbounds/preview', file: 'outbounds.xlsx', tag: 'outbound', cap: 'outPreview', ro: true, note: '出库预览' },
  { m: 'POST', p: '/api/import/outbounds/preview', file: 'bad_header.xlsx', tag: 'outbound', ro: true, note: '表头非法 400' },
  { m: 'POST', p: '/api/jushuitan/import/preview', file: 'jst.xlsx', tag: 'jst', cap: 'jstPreview', ro: true, note: '聚水潭预览（不写库）' },
  { m: 'POST', p: '/api/jushuitan/import/preview', file: 'bad_header.xlsx', tag: 'jst', ro: true, note: '表头非法 400' },

  // ---- 写：商品 / 入库 / 出库 直传 ----
  { m: 'POST', p: '/api/import/products', file: 'products.xlsx', tag: 'products', note: '商品导入（新建/重名跳过/空名跳过）' },
  { m: 'POST', p: '/api/import/products', file: 'bad_header.xlsx', tag: 'products', note: '表头非法 400' },
  { m: 'POST', p: '/api/import/inbounds', file: 'inbounds.xlsx', tag: 'inbound', note: '入库直传建单' },
  { m: 'POST', p: '/api/import/inbounds/confirm', bodyFrom: s => ({ items: s.inPreview.items }), tag: 'inbound', note: '入库确认（回灌预览）' },
  { m: 'POST', p: '/api/import/inbounds/confirm', body: { items: [{ product_id: 1, unit: '单', quantity: 1, unit_price: 1, date: JST_DATES() }] }, tag: 'inbound', note: '入库确认（手填一行）' },
  { m: 'POST', p: '/api/import/inbounds/confirm', body: { items: [{ product_id: 'x', unit: 1, quantity: 'abc', date: true }] }, tag: 'inbound', note: '422 明细口径' },
  { m: 'POST', p: '/api/import/outbounds', file: 'outbounds.xlsx', tag: 'outbound', note: '出库直传建单' },
  { m: 'POST', p: '/api/import/outbounds/confirm', bodyFrom: s => ({ orders: s.outPreview.orders, source: 'outbounds.xlsx' }), tag: 'outbound', note: '出库确认（回灌预览）' },

  // ---- 写：聚水潭关联发现 + 规则回写 + 建单 ----
  { m: 'POST', p: '/api/jushuitan/parse', file: 'jst.xlsx', tag: 'jst', note: '发现商品并自动新增品类（写库）' },
  { m: 'GET', p: '/api/mappings', tag: 'jst', note: 'parse 后关联快照' },
  { m: 'GET', p: '/api/pack-rules', tag: 'jst', note: 'parse 后规则快照' },
  { m: 'POST', p: '/api/pack-rules/from-jushuitan', bodyFrom: s => ({ doc_no: 'DIFFDOC', items: (s.jstPreview.unmapped || []).slice(0, 2).map(u => ({ external_code: u.external_code, quantity: 1, product_id: 1 })) }), tag: 'jst', note: '组合写成规则' },
  { m: 'POST', p: '/api/jushuitan/import/confirm', bodyFrom: s => ({ orders: s.jstPreview.orders.slice(0, 3), source: 'jst.xlsx' }), tag: 'jst', note: '聚水潭确认建单 + 执行记录留痕' },
  { m: 'POST', p: '/api/jushuitan/import', file: 'jst.xlsx', tag: 'jst', note: '一键导入（解析+落库+留痕）' },

  // ---- 写：编码关联维护 ----
  { m: 'POST', p: '/api/mappings', body: { source: 'jushuitan', external_code: '差分关联甲', product_id: 1 }, tag: 'mappings' },
  { m: 'POST', p: '/api/mappings', body: { source: 'jushuitan', external_code: '差分关联甲', product_id: 2 }, tag: 'mappings', note: '同码改写' },
  { m: 'POST', p: '/api/mappings', body: { source: 'jushuitan', external_code: '差分关联乙', product_id: null }, tag: 'mappings', note: 'product_id=null' },
  { m: 'POST', p: '/api/mappings', body: { source: 'jushuitan' }, tag: 'mappings', note: '缺 external_code → 422' },
  { m: 'POST', p: '/api/mappings/bulk', body: { source: 'jushuitan', items: [{ external_code: '差分批量甲', product_id: 1 }, { external_code: '差分批量乙' }] }, tag: 'mappings' },
  { m: 'POST', p: '/api/mappings/auto', tag: 'mappings', note: '一键自动关联' },
  { m: 'GET', p: '/api/mappings', tag: 'mappings', ro: true, note: '关联表快照' },
  { m: 'POST', p: '/api/mappings/ai-suggest', body: { source: 'jushuitan', codes: ['差分AI测试甲9斤', '差分AI测试乙'], apply: false }, tag: 'mappings', soft: true, note: 'AI 试算（沙箱无 key，比对状态码即可）' },
  { m: 'POST', p: '/api/mappings/ai-suggest', body: { source: 'jushuitan', codes: [], apply: true }, tag: 'mappings', note: '无商品名 → 400' },
  { m: 'POST', p: '/api/mappings/ai-suggest', body: { codes: 'notalist' }, tag: 'mappings', note: '422 明细口径' },
  { m: 'DELETE', p: '/api/mappings?source=jushuitan', tag: 'mappings', note: '清空 jushuitan 关联（沙箱库，勿在生产跑）' },
];

const IGNORE_ALWAYS = new Set(['created_at', 'updated_at', 'server_time', 'deadline', 'file']);
function norm(v, key, ign) {
  if (key && ign.has(key)) return '<ignore>';
  if (typeof v === 'number') return Math.round(v * 1e4) / 1e4;
  if (Array.isArray(v)) return v.map(x => norm(x, '', ign));
  if (v && typeof v === 'object') { const o = {}; for (const k of Object.keys(v).sort()) o[k] = norm(v[k], k, ign); return o; }
  return v;
}
function deepDiff(a, b, p, out, ign) {
  out = out || []; if (out.length > 60) return out;
  ign = ign || IGNORE_ALWAYS;
  const A = norm(a, '', ign), B = norm(b, '', ign);
  if (JSON.stringify(A) === JSON.stringify(B)) return out;
  if (typeof A !== typeof B || A === null || B === null || typeof A !== 'object') {
    out.push(`${p || '(整包)'}: PY=${JSON.stringify(A)}  GO=${JSON.stringify(B)}`);
    return out;
  }
  if (Array.isArray(A) !== Array.isArray(B)) { out.push(`${p}: 一方是数组另一方不是`); return out; }
  if (Array.isArray(A)) {
    if (A.length !== B.length) out.push(`${p}.length: PY=${A.length} GO=${B.length}`);
    const n = Math.min(A.length, B.length);
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

async function call(side, c) {
  const base = side === 'PY' ? PY : GO;
  const headers = { Cookie: `erp_token=${TOKEN}` };
  let body;
  if (c.file) {
    const buf = fs.readFileSync(`${FX}/${c.file}`);
    const fd = new FormData();
    fd.append('file', new Blob([buf], {
      type: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
    }), c.file);
    body = fd;
  } else if (c.body !== undefined || c.bodyFrom) {
    headers['Content-Type'] = 'application/json';
    body = JSON.stringify(c.bodyFrom ? c.bodyFrom(store[side] || {}) : c.body);
  }
  try {
    const res = await fetch(base + c.p, { method: c.m, headers, body, signal: AbortSignal.timeout(120000) });
    const text = await res.text();
    let json; try { json = JSON.parse(text); } catch { json = text.slice(0, 300); }
    return { status: res.status, body: json };
  } catch (e) { return { status: 0, body: String(e.message) }; }
}

const store = { PY: {}, GO: {} };
// 用例顺序即数组顺序：只读预览（ro）已全部排在前面，确认类用例依赖它们的 store 捕获
let targets = CASES.filter(c => !args.module || c.tag === args.module);
if (args.only) targets = targets.filter((c, i) => String(i + 1) === String(args.only).replace(/^\./, ''));

console.log(`上传用例 ${targets.length} 条（只读先行）| PY=${PY} GO=${GO}`);
const results = [];
for (const [i, c] of targets.entries()) {
  const r = {};
  for (const side of ['PY', 'GO']) {
    const res = await call(side, c);
    r[side] = res;
    if (c.cap) store[side][c.cap] = res.body;
  }
  const d = r.PY.status === r.GO.status ? deepDiff(r.PY.body, r.GO.body, '') : [];
  let verdict = r.PY.status !== r.GO.status ? 'STATUS' : (d.length ? 'DIFF' : 'OK');
  if (verdict === 'DIFF' && c.soft) verdict = 'SOFT';
  results.push({ c, ...r, d, verdict });
  const mark = { OK: '✓', DIFF: '✗', STATUS: '!', SOFT: '~' }[verdict];
  console.log(`${mark} [${String(i + 1).padStart(2)}] ${verdict.padEnd(6)} ${c.m.padEnd(6)} ${c.p}${c.file ? '  ' + c.file : ''}  PY=${r.PY.status} GO=${r.GO.status}${c.note ? '  // ' + c.note : ''}`);
  if (verdict !== 'OK') console.log(`      PY=${JSON.stringify(r.PY.body).slice(0, 240)}\n      GO=${JSON.stringify(r.GO.body).slice(0, 240)}`);
  for (const l of d.slice(0, args.verbose ? 99 : 8)) console.log('      - ' + l);
}

const cnt = {};
for (const r of results) cnt[r.verdict] = (cnt[r.verdict] || 0) + 1;
console.log('\n汇总:', JSON.stringify(cnt));
fs.writeFileSync(process.env.DIFF_OUT || (ROOT + '/go/_diff/last-upload.json'), JSON.stringify({ results }, null, 1));
