// 对比 /api/ai/parse-image/stream 在 Python 源(:8050) 与 Go(:8100/桥:8088) 上的报错，确认 400 是同一条。
const PNG = Buffer.from(
  'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8DwHwAFAAH/q842iQAAAABJRU5ErkJggg==',
  'base64');
const H = { Cookie: `erp_token=${process.env.ERP_TOKEN}` };

async function probe(base) {
  const fd = new FormData();
  fd.append('file', new Blob([PNG], { type: 'image/png' }), '票据.png');
  fd.append('text', '今天入库 100 斤木耳');
  try {
    const r = await fetch(`${base}/api/ai/parse-image/stream`, { method: 'POST', headers: H, body: fd });
    const t = await r.text();
    return `${base} -> ${r.status} ${t.slice(0, 200).replace(/\s+/g, ' ')}`;
  } catch (e) {
    return `${base} -> ERR ${e.message}`;
  }
}
for (const b of ['http://127.0.0.1:8050', 'http://127.0.0.1:8100', 'http://127.0.0.1:8088']) {
  console.log(await probe(b));
}
