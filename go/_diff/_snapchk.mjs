// 一次性核对：/api/outbounds 快照差异是否只有随机批次号 import_group
import fs from 'node:fs';
const PY = 'http://127.0.0.1:8050', GO = 'http://127.0.0.1:8100';
const TOKEN = process.env.ERPTOK || fs.readFileSync('/tmp/erptok', 'utf8').trim();
async function get(base, url) {
  const r = await fetch(base + url, { headers: { Cookie: `erp_token=${TOKEN}` }, signal: AbortSignal.timeout(300000) });
  return { status: r.status, body: await r.json() };
}
function norm(v, key, ign) {
  if (key && ign.has(key)) return '<ignore>';
  if (typeof v === 'number') return Math.round(v * 1e4) / 1e4;
  if (Array.isArray(v)) return v.map(x => norm(x, '', ign));
  if (v && typeof v === 'object') { const o = {}; for (const k of Object.keys(v).sort()) o[k] = norm(v[k], k, ign); return o; }
  return v;
}
function deepDiff(a, b, path, ign, out = []) {
  if (out.length > 20) return out;
  const ta = a === null ? 'null' : Array.isArray(a) ? 'arr' : typeof a, tb = b === null ? 'null' : Array.isArray(b) ? 'arr' : typeof b;
  if (ta !== tb) { out.push(`${path}: 类型 ${ta} != ${tb}`); return out; }
  if (ta === 'arr') {
    if (a.length !== b.length) out.push(`${path}: 长度 ${a.length} != ${b.length}`);
    for (let i = 0; i < Math.min(a.length, b.length); i++) deepDiff(a[i], b[i], `${path}[${i}]`, ign, out);
    return out;
  }
  if (ta === 'object') {
    for (const k of new Set([...Object.keys(a), ...Object.keys(b)])) {
      if (ign.has(k)) continue;
      deepDiff(a[k], b[k], `${path}.${k}`, ign, out);
    }
    return out;
  }
  if (a !== b) out.push(`${path || '<root>'}: ${JSON.stringify(a)} != ${JSON.stringify(b)}`);
  return out;
}
const IGN = new Set(['created_at', 'updated_at', 'server_time', 'deadline', 'id', 'file', 'import_group']);
for (const g of ['/api/outbounds', '/api/movements']) {
  const a = await get(PY, g), b = await get(GO, g);
  const rowsA = Array.isArray(a.body) ? a.body : a.body?.items ?? [];
  const rowsB = Array.isArray(b.body) ? b.body : b.body?.items ?? [];
  const grp = (rows) => rows.map(r => r.import_group).filter(Boolean);
  const fmt = (s) => /^imp[0-9a-f]{10}$/.test(s);
  console.log(`\n${g}  PY=${a.status}(${rowsA.length} 行) GO=${b.status}(${rowsB.length} 行)`);
  console.log(`  import_group PY 样本=${grp(rowsA).slice(0, 2)} 全部合规=${grp(rowsA).every(fmt)} 去重后组数=${new Set(grp(rowsA)).size}`);
  console.log(`  import_group GO 样本=${grp(rowsB).slice(0, 2)} 全部合规=${grp(rowsB).every(fmt)} 去重后组数=${new Set(grp(rowsB)).size}`);
  const d = deepDiff(norm(rowsA, '', IGN), norm(rowsB, '', IGN), '', IGN);
  console.log(`  屏蔽随机字段后差异 ${d.length} 条${d.length ? ':\n   - ' + d.slice(0, 10).join('\n   - ') : ''}`);
}
