// AI 模块（routers/ai.py → internal/api/ai_api.go）差分：
// 沙箱里 llm.api_key 已清空，所以大模型分支只能验到 400「未配置 LLM」；
// 本地快速解析、出库重算、建档、最近单价都是确定性路径，逐字段比对。
// 用法：ERP_TOKEN=xxx node go/_diff/ai.mjs [--tag=parse] [--only=3] [--verbose]
const PY = process.env.PY_BASE || 'http://127.0.0.1:8050';
const GO = process.env.GO_BASE || 'http://127.0.0.1:8100';
const TOKEN = process.env.ERP_TOKEN || '';
const ROOT = process.env.REPO || 'D:/code/WSFC_ERP';
const args = Object.fromEntries(process.argv.slice(2).map(a => { const [k, ...r] = a.replace(/^--/, '').split('='); return [k, r.length ? r.join('=') : true]; }));
import fs from 'node:fs';

const CASES = [
  // ---- GET /api/ai/last-price ----
  { m: 'GET', p: '/api/ai/last-price?product_id=1&op_type=inbound', tag: 'price' },
  { m: 'GET', p: '/api/ai/last-price?product_id=1&op_type=outbound', tag: 'price' },
  { m: 'GET', p: '/api/ai/last-price?product_id=362', tag: 'price', note: '缺省 op_type，原样回显' },
  { m: 'GET', p: '/api/ai/last-price?product_id=364&op_type=weird', tag: 'price', note: '非法 op_type 当作 inbound' },
  { m: 'GET', p: '/api/ai/last-price?product_id=999999', tag: 'price', note: '404' },
  { m: 'GET', p: '/api/ai/last-price', tag: 'price', note: '缺必填 422' },
  { m: 'GET', p: '/api/ai/last-price?product_id=abc', tag: 'price', note: '422 int_parsing' },

  // ---- POST /api/ai/parse（本地快速识别 + 参数校验） ----
  { m: 'POST', p: '/api/ai/parse', b: {}, tag: 'parse', note: '缺 text 422' },
  { m: 'POST', p: '/api/ai/parse', b: { text: '   ' }, tag: 'parse', note: '空白 400' },
  { m: 'POST', p: '/api/ai/parse', b: { text: 123 }, tag: 'parse', note: 'text 非字符串 422' },
  { m: 'POST', p: '/api/ai/parse', b: { text: '今天天气不错' }, tag: 'parse', note: '没命中规则→走大模型→400' },
  { m: 'POST', p: '/api/ai/parse', b: { text: '2026-08-17 入库100斤红皮土豆，25一斤' }, tag: 'parse', note: '显式日期交给大模型→400' },
  { m: 'POST', p: '/api/ai/parse', b: { text: '昨天入库300斤红皮土豆80g+，25一斤' }, tag: 'parse', note: '快速识别' },
  { m: 'POST', p: '/api/ai/parse', b: { text: '入库100个佛手柑中果1个打包 2元一个' }, tag: 'parse', note: '名称在数量前' },
  { m: 'POST', p: '/api/ai/parse', b: { text: '出库5件人参果中果3斤打包，19.9一元' }, tag: 'parse', note: '出库快速识别' },
  { m: 'POST', p: '/api/ai/parse', b: { text: '进货20箱云南大香芋头9斤3-5个打包，8.8元一箱' }, tag: 'parse' },
  { m: 'POST', p: '/api/ai/parse', b: { text: '发货200单新鲜天麻净重1斤单果60g+' }, tag: 'parse' },

  // ---- POST /api/ai/parse/stream（无 key → 400，先于 SSE） ----
  { m: 'POST', p: '/api/ai/parse/stream', b: {}, tag: 'stream', note: '422' },
  { m: 'POST', p: '/api/ai/parse/stream', b: { text: '' }, tag: 'stream', note: '400 请输入描述文字' },
  { m: 'POST', p: '/api/ai/parse/stream', b: { text: '昨天入库300斤红皮土豆80g+，25一斤' }, tag: 'stream', note: '400 未配置 LLM' },
  { m: 'POST', p: '/api/ai/parse/stream', b: { text: '随便', hint: '改成出库', prev: '{"lines":[]}' }, tag: 'stream', sse: true },

  // ---- POST /api/ai/outbound-preview（确认框重算，确定性） ----
  { m: 'POST', p: '/api/ai/outbound-preview', b: {}, tag: 'preview', note: '全空' },
  { m: 'POST', p: '/api/ai/outbound-preview', b: { lines: [{ product_id: 362, unit: '单', quantity: 2, price: 19.9 }] }, tag: 'preview', note: '只有商品行' },
  { m: 'POST', p: '/api/ai/outbound-preview', b: { lines: [{ product_id: 362, unit: '单', quantity: 2, price: 19.9 }], charges: [{ name: '工时', amount: 30 }] }, tag: 'preview', note: '固定成本' },
  { m: 'POST', p: '/api/ai/outbound-preview', b: { charges: [{ name: '快递费', amount: 4.5 }, { name: '胶带', quantity: 2, unit: '个' }, { name: '8号纸箱', amount: 1.2, quantity: 3 }] }, tag: 'preview', note: '附加项（无商品行）' },
  { m: 'POST', p: '/api/ai/outbound-preview', b: { lines: [{ product_id: 1, unit: '单', quantity: 3, price: 9.9 }], charges: [{ name: '打包人工', amount: 12 }], fee_total: 66.6 }, tag: 'preview', note: '用户改过固定成本' },
  { m: 'POST', p: '/api/ai/outbound-preview', b: { lines: 'x' }, tag: 'preview', note: '422 list_type' },
  { m: 'POST', p: '/api/ai/outbound-preview', b: { lines: ['x'] }, tag: 'preview', note: '422 dict_type' },
  { m: 'POST', p: '/api/ai/outbound-preview', b: { fee_total: 'abc' }, tag: 'preview', note: '422 float_parsing' },
  { m: 'POST', p: '/api/ai/outbound-preview', b: { fee_total: null }, tag: 'preview', note: 'null 视为未改' },

  // ---- POST /api/ai/products（确认提交时建档） ----
  { m: 'POST', p: '/api/ai/products', b: {}, tag: 'goods', note: '缺 items 422' },
  { m: 'POST', p: '/api/ai/products', b: { items: [] }, tag: 'goods' },
  { m: 'POST', p: '/api/ai/products', b: { items: [{ name: '  ' }] }, tag: 'goods', note: '空名跳过' },
  { m: 'POST', p: '/api/ai/products', b: { items: [{ name: '差分AI新商品甲', unit: 'kg', category: 'stock' }] }, tag: 'goods', note: '单位归一 kg→公斤' },
  { m: 'POST', p: '/api/ai/products', b: { items: [{ name: '差分AI新商品甲' }] }, tag: 'goods', note: '同名复用 created=false' },
  { m: 'POST', p: '/api/ai/products', b: { items: [{ name: '差分AI新商品乙', unit: '个', category: 'pack' }] }, save: 'newpid', tag: 'goods' },
  { m: 'POST', p: '/api/ai/products', b: { items: [{ name: '差分AI新商品丙', category: 5 }] }, tag: 'goods', note: '子模型 422' },
  { m: 'POST', p: '/api/ai/products', b: { items: [{ unit: '个' }] }, tag: 'goods', note: '缺 name 422' },

  // ---- 建档后回填单价 ----
  { m: 'GET', p: '/api/ai/last-price?product_id=${newpid}&op_type=inbound', tag: 'goods', note: '新商品无历史价' },

  // ---- AI 记忆 /api/ai/memories（查看 / 手动记 / 删 / 清空） ----
  { m: 'GET', p: '/api/ai/memories', tag: 'mem', note: '初始列表' },
  { m: 'POST', p: '/api/ai/memories', b: {}, tag: 'mem', note: '缺 text 422' },
  { m: 'POST', p: '/api/ai/memories', b: { text: 123 }, tag: 'mem', note: 'text 非字符串 422' },
  { m: 'POST', p: '/api/ai/memories', b: { text: ' 只 ' }, tag: 'mem', note: '折叠空白后 1 字 → 400 太短' },
  { m: 'POST', p: '/api/ai/memories', b: { text: '字'.repeat(501) }, tag: 'mem', note: '400 太长（按字符数）' },
  { m: 'POST', p: '/api/ai/memories', b: { text: '京东8号  ->  8号纸箱' }, tag: 'mem', note: '手动记一条（空白折叠）' },
  { m: 'POST', p: '/api/ai/memories', b: { text: '京东8号->8号纸箱' }, tag: 'mem', note: '同一句不重复' },
  { m: 'POST', p: '/api/ai/memories', b: { text: '今天入库100斤木耳25一斤' }, tag: 'mem', note: '手动添加不做规则判定' },
  { m: 'POST', p: '/api/ai/memories', b: { text: '一件纸箱 12个' }, tag: 'mem', note: '装箱换算归 unit' },
  { m: 'GET', p: '/api/ai/memories', tag: 'mem', save: 'memTop', path: '0.id', note: '列表新的在前' },
  { m: 'DELETE', p: '/api/ai/memories/${memTop}', tag: 'mem', note: '硬删' },
  { m: 'DELETE', p: '/api/ai/memories/${memTop}', tag: 'mem', note: '再删 404 记忆不存在' },
  { m: 'DELETE', p: '/api/ai/memories/abc', tag: 'mem', note: '422 int_parsing（loc=path）' },
  { m: 'DELETE', p: '/api/ai/memories', tag: 'mem', note: '清空' },
  { m: 'GET', p: '/api/ai/memories', tag: 'mem', note: '清空后为空' },
];

// multipart：parse-image/stream（file 必填 → 422 / 无 key → 400）
const FORM = [
  { name: '缺 file', parts: {}, tag: 'image' },
  { name: '空文件名（FastAPI 当字符串字段，422 的 input 是原始字节，只比 type/msg）', parts: { file: { data: '089504a4554000a0a1a11025265000', filename: '', type: 'image/png' } }, tag: 'image', ign: ['input'] },
  { name: '带 text/hint', parts: { file: { data: '089504a4554000a0a1a11025265000', filename: '票据.PNG', type: 'image/png' }, text: '京东8号->8号纸箱', hint: '改成入库' }, tag: 'image' },
];

const SNAPSHOTS = [
  '/api/ai/last-price?product_id=1&op_type=inbound',
  '/api/products',
  '/api/stocks',
  '/api/outbounds',
  '/api/report/summary',
];

const IGNORE = ['created_at', 'updated_at', 'server_time', 'deadline', 'file', 'at', 'mtime',
  // 导入批次号带随机后缀（imp+hex），两边各生成各的，不是口径差异
  'import_group'];

function norm(v) {
  if (Array.isArray(v)) return v.map(norm);
  if (v && typeof v === 'object') {
    const o = {};
    for (const k of Object.keys(v).sort()) o[k] = norm(v[k]);
    return o;
  }
  if (typeof v === 'number') return Math.round(v * 1e6) / 1e6;
  return v;
}

function deepDiff(A, B, p, out = [], ign = IGNORE) {
  A = norm(A); B = norm(B);
  const same = JSON.stringify(A) === JSON.stringify(B);
  if (same) return out;
  // 按「路径最后一段」命中忽略表：嵌套数组里的 created_at / input 也要能跳过
  const leaf = p.replace(/^\./, '').split('.').pop().replace(/\[[^\]]*\]/g, '');
  if (leaf && ign.includes(leaf)) return out;
  if (typeof A === 'string' && typeof B === 'string') {
    if (A !== B) {
      const ra = A.replace(/(_gosb[/\\](py|go)|D:[/\\]code[/\\]WSFC_ERP)/g, 'ROOT').replace(/ROOT[/\\](py|go)/g, 'ROOT');
      const rb = B.replace(/(_gosb[/\\](py|go)|D:[/\\]code[/\\]WSFC_ERP)/g, 'ROOT').replace(/ROOT[/\\](py|go)/g, 'ROOT');
      if (ra === rb) return out;
      out.push(`${p}: PY=${JSON.stringify(A).slice(0, 160)} GO=${JSON.stringify(B).slice(0, 160)}`);
    }
    return out;
  }
  if (A === null || B === null || typeof A !== typeof B) {
    if (!(A === undefined && B === null) && !(B === undefined && A === null)) {
      out.push(`${p}: PY=${JSON.stringify(A) ?? String(A)} GO=${JSON.stringify(B) ?? String(B)}`);
    }
    return out;
  }
  if (typeof A !== 'object') {
    if (A !== B) out.push(`${p}: PY=${A} GO=${B}`);
    return out;
  }
  if (Array.isArray(A) || Array.isArray(B)) {
    if (!Array.isArray(A) || !Array.isArray(B)) { out.push(`${p}: 类型不一致 PY=${Array.isArray(A) ? 'list' : 'obj'} GO=${Array.isArray(B) ? 'list' : 'obj'}`); return out; }
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

async function call(base, method, url, body) {
  const headers = { Cookie: `erp_token=${TOKEN}` };
  let payload;
  if (body !== null && body !== undefined) { headers['Content-Type'] = 'application/json'; payload = JSON.stringify(body); }
  try {
    const res = await fetch(base + url, { method, headers, body: payload, signal: AbortSignal.timeout(90000) });
    const text = await res.text();
    let json; try { json = JSON.parse(text); } catch { json = text.slice(0, 400); }
    return { status: res.status, body: json, ct: res.headers.get('content-type') || '' };
  } catch (e) { return { status: 0, body: String(e.message), ct: '' }; }
}

async function callForm(base, parts) {
  const fd = new FormData();
  for (const [k, v] of Object.entries(parts)) {
    if (k === 'file') {
      const buf = Buffer.from(v.data, 'hex');
      fd.append('file', new Blob([buf], { type: v.type || 'application/octet-stream' }), v.filename);
    } else fd.append(k, v);
  }
  try {
    const res = await fetch(base + '/api/ai/parse-image/stream', {
      method: 'POST', headers: { Cookie: `erp_token=${TOKEN}` }, body: fd, signal: AbortSignal.timeout(30000),
    });
    const text = await res.text();
    let json; try { json = JSON.parse(text); } catch { json = text.slice(0, 400); }
    return { status: res.status, body: json, ct: res.headers.get('content-type') || '' };
  } catch (e) { return { status: 0, body: String(e.message), ct: '' }; }
}

const vars = { PY: {}, GO: {} };
function resolve(side, s) {
  return s.replace(/\$\{(\w+)\}/g, (_, k) => {
    const v = vars[side][k];
    return v === undefined ? '0' : encodeURIComponent(String(v));
  });
}
// getPath 按 '0.id' 这样的路径从响应里取值（save/path 用）。
function getPath(body, path) {
  let cur = body;
  for (const k of path.split('.')) {
    if (cur === null || cur === undefined) return null;
    cur = cur[k];
  }
  return cur === undefined ? null : cur;
}
function resolveBody(side, b) {
  if (b === null || b === undefined) return b;
  let s = JSON.stringify(b);
  s = s.replace(/"\$\{(\w+)\}"/g, (_, k) => { const v = vars[side][k]; return v === undefined ? '0' : String(v); });
  return JSON.parse(s);
}

const targets = CASES.filter(c => !args.tag || c.tag === args.tag);
const forms = FORM.filter(f => !args.tag || f.tag === args.tag);
console.log(`AI 用例 ${targets.length} + 表单 ${forms.length} | PY=${PY} GO=${GO}`);
const results = [];
let i = 0;
for (const c of targets) {
  i++;
  const r = {};
  for (const side of ['PY', 'GO']) {
    const base = side === 'PY' ? PY : GO;
    const res = await call(base, c.m, resolve(side, c.p), resolveBody(side, c.b));
    r[side] = res;
    if (c.save) {
      // 默认取 items[0].product_id / id；给了 path（如 '0.id'）就按路径取（记忆列表返回的是裸数组）
      const v = c.path ? getPath(res.body, c.path)
        : (res.body && (res.body.items?.[0]?.product_id ?? res.body.id ?? null));
      vars[side][c.save] = v;
      if (v === null) console.log(`      ! ${side} 的 save:${c.save} 取到 null，后面的 \${${c.save}} 用例会失真`);
    }
  }
  const ctOk = (r.PY.ct || '').split(';')[0] === (r.GO.ct || '').split(';')[0];
  const d = r.PY.status === r.GO.status ? deepDiff(r.PY.body, r.GO.body, '') : [];
  const verdict = !ctOk ? 'CTYPE' : r.PY.status !== r.GO.status ? 'STATUS' : (d.length ? 'DIFF' : 'OK');
  results.push({ c, ...r, d, verdict });
  const mark = { OK: '✓', DIFF: '✗', STATUS: '!', CTYPE: '~' }[verdict];
  console.log(`${mark} [${String(i).padStart(2)}] ${verdict.padEnd(6)} ${c.m.padEnd(5)} ${c.p}  PY=${r.PY.status} GO=${r.GO.status}${c.note ? '  // ' + c.note : ''}`);
  if (!ctOk) console.log(`      CT PY=${r.PY.ct} GO=${r.GO.ct}`);
  if (verdict === 'STATUS') console.log(`      PY=${JSON.stringify(r.PY.body).slice(0, 200)}\n      GO=${JSON.stringify(r.GO.body).slice(0, 200)}`);
  else for (const l of d.slice(0, args.verbose ? 99 : 6)) console.log('      - ' + l);
}
for (const f of forms) {
  i++;
  const r = {};
  for (const side of ['PY', 'GO']) r[side] = await callForm(side === 'PY' ? PY : GO, f.parts);
  const ctOk = (r.PY.ct || '').split(';')[0] === (r.GO.ct || '').split(';')[0];
  const d = r.PY.status === r.GO.status ? deepDiff(r.PY.body, r.GO.body, '', [], IGNORE.concat(f.ign || [])) : [];
  const verdict = !ctOk ? 'CTYPE' : r.PY.status !== r.GO.status ? 'STATUS' : (d.length ? 'DIFF' : 'OK');
  results.push({ c: { p: '/api/ai/parse-image/stream (' + f.name + ')' }, ...r, d, verdict });
  const mark = { OK: '✓', DIFF: '✗', STATUS: '!', CTYPE: '~' }[verdict];
  console.log(`${mark} [${String(i).padStart(2)}] ${verdict.padEnd(6)} POST  /api/ai/parse-image/stream  ${f.name}  PY=${r.PY.status} GO=${r.GO.status}`);
  if (!ctOk) console.log(`      CT PY=${r.PY.ct} GO=${r.GO.ct}`);
  if (verdict === 'STATUS') console.log(`      PY=${JSON.stringify(r.PY.body).slice(0, 200)}\n      GO=${JSON.stringify(r.GO.body).slice(0, 200)}`);
  else for (const l of d.slice(0, args.verbose ? 99 : 6)) console.log('      - ' + l);
}

console.log('\n==== 最终状态快照 ====');
const snaps = [];
for (const g of SNAPSHOTS) {
  const a = await call(PY, 'GET', g, null);
  const b = await call(GO, 'GET', g, null);
  const d = a.status === b.status ? deepDiff(a.body, b.body, '', [], IGNORE) : [`status PY=${a.status} GO=${b.status}`];
  snaps.push({ g, d });
  console.log(`${d.length ? '✗' : '✓'} ${g}  PY=${a.status} GO=${b.status}` + (d.length ? `\n      - ${d.slice(0, args.verbose ? 99 : 6).join('\n      - ')}` : ''));
}

const cnt = {};
for (const r of results) cnt[r.verdict] = (cnt[r.verdict] || 0) + 1;
console.log('\n汇总:', JSON.stringify(cnt), '| 快照不一致:', snaps.filter(s => s.d.length).length, '/', snaps.length);
fs.writeFileSync(process.env.DIFF_OUT || (ROOT + '/go/_diff/last-ai.json'), JSON.stringify({ results, snaps }, null, 1));
