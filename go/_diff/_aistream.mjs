// 真 key 下跑通 /api/ai/parse-image/stream 的 SSE 全链路；用法：node _aistream.mjs <base> <图片路径>
const H = { Cookie: `erp_token=${process.env.ERP_TOKEN}` };
const base = process.argv[2];
const file = process.argv[3];
import fs from 'node:fs';
const buf = fs.readFileSync(file);

const fd = new FormData();
fd.append('file', new Blob([buf], { type: 'image/png' }), file.split('/').pop());
fd.append('text', '识别这张截图里的商品、数量和单价');

const t0 = Date.now();
const r = await fetch(`${base}/api/ai/parse-image/stream`, { method: 'POST', headers: H, body: fd });
console.log(`${base} 状态 ${r.status} content-type=${r.headers.get('content-type')} 图片 ${(buf.length / 1024).toFixed(0)}KB`);
if (!r.ok) console.log('非 2xx 响应体：', (await r.text()).slice(0, 300));

const dec = new TextDecoder();
let pending = '', n = 0, kinds = {}, first = null, last = null, total = 0;
const rd = r.body.getReader();
for (;;) {
  const { value, done } = await rd.read();
  if (done) break;
  total += value.length;
  pending += dec.decode(value, { stream: true });
  let i;
  while ((i = pending.indexOf('\n')) >= 0) {
    const line = pending.slice(0, i).trim();
    pending = pending.slice(i + 1);
    if (!line.startsWith('data:')) continue;
    n++;
    const s = line.slice(5).trim();
    let j = null;
    try { j = JSON.parse(s); } catch (e) { }
    const k = j ? Object.keys(j).join('+') : 'RAW';
    kinds[k] = (kinds[k] || 0) + 1;
    if (!first) first = s.slice(0, 160);
    last = s.slice(0, 240);
    if (k.includes('error') || k.includes('result') || k.includes('stage')) console.log(`  [${((Date.now() - t0) / 1000).toFixed(1)}s] ${k}: ${s.slice(0, 200)}`);
  }
}
console.log(`共 ${n} 个 data 帧 / ${(total / 1024).toFixed(1)}KB / ${((Date.now() - t0) / 1000).toFixed(1)}s`);
console.log('帧类型统计', JSON.stringify(kinds));
console.log('首帧', first);
console.log('末帧', last);
