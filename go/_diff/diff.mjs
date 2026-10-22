// 差分回归工具：把同一批请求同时打到 Python(基准) 与 Go(移植)，做深度 JSON 比对。
// 用法：node go/_diff/diff.mjs [--module=imports] [--path=/api/xxx] [--verbose]
import fs from 'node:fs';
import path from 'node:path';

const PY = process.env.PY_BASE || 'http://127.0.0.1:8050';
const GO = process.env.GO_BASE || 'http://127.0.0.1:8100';
const TOKEN = process.env.ERP_TOKEN || '';
const ROOT = process.env.REPO || 'D:/code/WSFC_ERP';
const args = Object.fromEntries(process.argv.slice(2).map(a => { const [k, ...rest] = a.replace(/^--/, '').split('='); return [k, rest.length ? rest.join('=') : true]; }));
const verbose = !!args.verbose;

const routersDir = path.join(ROOT, 'backend/app/routers');

function parseEndpoints() {
  const out = [];
  for (const f of fs.readdirSync(routersDir).filter(f => f.endsWith('.py'))) {
    const src = fs.readFileSync(path.join(routersDir, f), 'utf8');
    const prefix = (src.match(/APIRouter\(\s*prefix=["']([^"']*)["']/) || [])[1] || '';
    const re = /@(?:router|app)\.(get|post|put|delete|patch)\(\s*["']([^"']*)["']\s*\)\s*(?:async\s+)?def\s+(\w+)\s*\(([^)]*)\)/gs;
    for (const m of src.matchAll(re)) {
      out.push({
        mod: path.basename(f, '.py'),
        method: m[1].toUpperCase(),
        path: (prefix + m[2]) || '/',
        fn: m[3],
        params: m[4] || '',
      });
    }
  }
  return out;
}

// 从函数签名里抽 query 参数（跳过已知的依赖注入）
const SKIP = new Set(['self', 'request', 'response', 'db', 'user', 'file', 'files', 'data', 'body', 'payload']);
function queryParams(ep) {
  const ps = [];
  // 按顶层逗号切分
  let depth = 0, cur = '', parts = [];
  for (const ch of ep.params) {
    if ('([{'.includes(ch)) depth++;
    if (')]})'.includes(ch)) depth--;
    if (ch === ',' && depth === 0) { parts.push(cur); cur = ''; } else cur += ch;
  }
  if (cur.trim()) parts.push(cur);
  for (const p of parts) {
    const t = p.trim();
    if (!t || t.startsWith('*')) continue;
    const name = t.split(':')[0].trim();
    if (SKIP.has(name)) continue;
    if (/Depends\(/.test(t)) continue;
    const d = t.split(':', 2)[1] || '';
    ps.push({ name, default: d.includes('=') ? t.slice(t.indexOf('=') + 1).trim() : null, type: d.split('=')[0] });
  }
  return ps;
}

function defaultValue(p) {
  const d = p.default;
  const ty = (p.type || '').trim();
  if (d !== null) {
    if (d === 'None') return undefined;         // 可空且无默认 -> 省略
    if (d === '...') return 1;
    if (/^["'].*["']$/.test(d)) return d.slice(1, -1);
    if (d === 'True') return 'true';
    if (d === 'False') return undefined;
    if (/^-?\d+(\.\d+)?$/.test(d)) return d;
    if (/^date\.|^datetime/.test(d)) return undefined;
    return undefined;
  }
  if (/Optional|str \| None|int \| None|float \| None/.test(ty)) return undefined;
  if (/bool/.test(ty)) return 'true';
  if (/int/.test(ty)) return '1';
  if (/float/.test(ty)) return '1';
  if (/date/.test(ty)) return '2026-10-01';
  if (/str/.test(ty)) return '';
  return undefined; // 复杂类型（pydantic body）跳过
}

function buildQuery(ep, ids) {
  const q = new URLSearchParams();
  for (const p of queryParams(ep)) {
    const v = defaultValue(p);
    if (v === undefined) continue;
    if (v === '') continue;
    q.set(p.name, String(v));
  }
  let urlPath = ep.path;
  const pm = [...ep.path.matchAll(/\{(\w+)\}/g)].map(m => m[1]);
  for (const name of pm) {
    let v = ids[name];
    if (v === undefined) {
      if (/id/.test(name)) v = 1;
      else if (/kind/.test(name)) v = 'products';
      else if (/name/.test(name)) v = 'x';
      else return null;
    }
    urlPath = urlPath.replace(`{${name}}`, encodeURIComponent(v));
  }
  const qs = q.toString();
  return { path: urlPath, query: qs ? '?' + qs : '' };
}

// 两边各自沙箱的绝对路径、各自墙上时钟、各自随机密钥（备份 remote_token 是 token_urlsafe 生成的），
// 这些差异不是移植口径问题，比对前先归一/跳过。
const SKIP_KEYS = new Set(['server_time', 'created_at', 'updated_at', 'mtime', 'at', 'import_group', 'remote_token']);
function normStr(s) {
  return s.replace(/(_gosb[/\\](py|go)|D:[/\\]code[/\\]WSFC_ERP)/g, 'ROOT').replace(/ROOT[/\\](py|go)/g, 'ROOT')
    // 部署脚本里内嵌的随机 token：两边各自生成，掩掉再比结构
    .replace(/TOKEN="[A-Za-z0-9_-]{16,}"/g, 'TOKEN="<token>"');
}

function norm(v) {
  if (typeof v === 'number') return Math.abs(v) > 1e12 ? Math.round(v) : Math.round(v * 1e6) / 1e6;
  if (typeof v === 'string') return normStr(v);
  if (Array.isArray(v)) return v.map(norm);
  if (v && typeof v === 'object') { const o = {}; for (const k of Object.keys(v).sort()) o[k] = norm(v[k]); return o; }
  return v;
}

function diff(a, b, p = '', out = [], limit = 12) {
  if (out.length >= limit) return out;
  const A = norm(a), B = norm(b);
  if (JSON.stringify(A) === JSON.stringify(B)) return out;
  if (A === null || B === null || typeof A !== typeof B || typeof A !== 'object' || Array.isArray(A) !== Array.isArray(B)) {
    if (typeof A === 'object' && A !== null || typeof B === 'object' && B !== null) {
      out.push(`${p}: ${JSON.stringify(A).slice(0, 90)}  !=  ${JSON.stringify(B).slice(0, 90)}`);
      return out;
    }
    out.push(`${p}: ${JSON.stringify(A)}  !=  ${JSON.stringify(B)}`);
    return out;
  }
  if (Array.isArray(A)) {
    if (A.length !== B.length) out.push(`${p}.length: ${A.length} != ${B.length}`);
    for (let i = 0; i < Math.min(A.length, B.length, 3); i++) diff(A[i], B[i], `${p}[${i}]`, out, limit);
    return out;
  }
  const keys = new Set([...Object.keys(A), ...Object.keys(B)]);
  for (const k of keys) {
    if (SKIP_KEYS.has(k)) continue; // 各自沙箱的时钟/随机密钥，不是口径差异
    if (!(k in A)) { out.push(`${p}.${k}: Go 多出字段`); continue; }
    if (!(k in B)) { out.push(`${p}.${k}: Go 缺字段`); continue; }
    diff(A[k], B[k], `${p}.${k}`, out, limit);
  }
  return out;
}

async function call(base, urlPath, query) {
  const t0 = Date.now();
  try {
    const res = await fetch(base + urlPath + (query || ''), {
      headers: { Cookie: `erp_token=${TOKEN}` },
      signal: AbortSignal.timeout(25000),
    });
    const text = await res.text();
    let json;
    try { json = JSON.parse(text); } catch { json = text.slice(0, 200); }
    return { status: res.status, body: json, ms: Date.now() - t0 };
  } catch (e) { return { status: 0, body: String(e.message), ms: Date.now() - t0 }; }
}

// 先跑一遍列表接口，抓真实 id 供带路径参数的详情接口使用
async function harvestIds(eps) {
  const ids = {};
  const listEps = eps.filter(e => e.method === 'GET' && !e.path.includes('{'));
  for (const ep of listEps) {
    const r = await call(PY, ep.path, buildQuery(ep, {})?.query || '');
    const rows = Array.isArray(r.body) ? r.body : (r.body && (r.body.items || r.body.list || r.body.rows || r.body.data || r.body.products || r.body.results));
    if (Array.isArray(rows) && rows.length && typeof rows[0] === 'object' && rows[0]) {
      for (const k of ['id', 'pid', 'gid', 'oid', 'rid', 'uid', 'mid', 'did', 'eid', 'fid']) {
        if (rows[0][k] !== undefined && ids[k] === undefined) ids[k] = rows[0][k];
      }
      if (!ids.id && rows[0].product_id) ids.id = rows[0].product_id;
    }
  }
  ids.pid = ids.pid ?? ids.id; ids.rid = ids.rid ?? ids.id; ids.oid = ids.oid ?? ids.id;
  ids.uid = ids.uid ?? 1; ids.mid = ids.mid ?? 1; ids.did = ids.did ?? 1; ids.eid = ids.eid ?? 1; ids.fid = ids.fid ?? 1;
  return ids;
}

const eps = parseEndpoints().filter(e => e.method === 'GET');
const onlyMod = args.module, onlyPath = args.path;
const targets = eps.filter(e => (!onlyMod || e.mod === onlyMod) && (!onlyPath || e.path === onlyPath));

console.log(`GET 端点 ${targets.length} 个 | PY=${PY} GO=${GO}`);
const ids = await harvestIds(targets);
console.log('harvested ids:', JSON.stringify(ids));

const results = [];
for (const ep of targets) {
  const q = buildQuery(ep, ids);
  if (!q) { results.push({ ep, skip: '需要未提供的路径参数' }); continue; }
  const full = q.path + q.query;
  const [a, b] = [await call(PY, q.path, q.query), await call(GO, q.path, q.query)];
  let verdict;
  if (a.status === 404 && b.status === 404) verdict = 'BOTH_404';
  else if (b.status === 404 && a.status !== 404) verdict = 'MISSING';
  else if (a.status === 401 && b.status === 401) verdict = 'BOTH_401';
  else if (a.status !== b.status) verdict = 'STATUS';
  else {
    const d = diff(a.body, b.body);
    verdict = d.length ? 'DIFF' : 'OK';
    if (d.length) { results.push({ ep, full, a, b, d, verdict }); continue; }
  }
  results.push({ ep, full, a, b, verdict });
}

const count = {};
for (const r of results) count[r.verdict || r.skip] = (count[r.verdict || r.skip] || 0) + 1;
console.log('\n==== 汇总 ====', JSON.stringify(count));

const bad = results.filter(r => r.verdict && !['OK', 'BOTH_404', 'BOTH_401'].includes(r.verdict));
for (const r of bad) {
  console.log(`\n[${r.verdict}] ${r.ep.mod}  GET ${r.full}   PY=${r.a.status}(${r.a.ms}ms) GO=${r.b.status}(${r.b.ms}ms)`);
  (r.d || (r.verdict === 'STATUS' ? [`status ${r.a.status} vs ${r.b.status}`, `PY=${JSON.stringify(r.a.body).slice(0, 160)}`, `GO=${JSON.stringify(r.b.body).slice(0, 160)}`] : [])).slice(0, verbose ? 99 : 6).forEach(l => console.log('   - ' + l));
}
fs.writeFileSync(process.env.DIFF_OUT || path.join(ROOT, 'go/_diff/last.json'), JSON.stringify(results.map(r => ({ mod: r.ep.mod, path: r.full || r.ep.path, verdict: r.verdict || r.skip, d: r.d })), null, 1));
console.log('\n明细已写入', process.env.DIFF_OUT || 'go/_diff/last.json');
