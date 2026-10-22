// 走查补充：直接打 web 桥（:8088，注入 erp_token cookie → Go :8100），验证改基础单位的 400 文案与折算。
const B = 'http://127.0.0.1:8088';
const H = { Cookie: `erp_token=${process.env.ERP_TOKEN}` };
const PID = Number(process.argv[2] || 233);

async function get() {
  const r = await fetch(`${B}/api/products`, { headers: H });
  return (await r.json()).find((x) => x.id === PID);
}
function mk(g, base, du, ratio) {
  return {
    code: g.code, name: g.name, category: g.category, product_type: g.product_type,
    base_unit: base, default_unit: du, spec: g.spec, sale_price: g.sale_price,
    unit_cost: g.unit_cost, weight_kg: g.weight_kg, conversions: g.conversions,
    pack_items: g.pack_items, pack_fee: g.pack_fee, stock_product_id: g.stock_product_id,
    multiplier: g.multiplier, stock_links: g.stock_links, stock_schemes: g.stock_schemes,
    free_shipping: !!g.free_shipping, is_active: !!g.is_active, unit_change_ratio: ratio,
  };
}
async function put(body) {
  const r = await fetch(`${B}/api/products/${PID}`, {
    method: 'PUT', headers: { ...H, 'Content-Type': 'application/json' }, body: JSON.stringify(body),
  });
  const j = await r.json().catch(() => null);
  return { st: r.status, detail: typeof j === 'string' ? j : j && j.detail, base: j && j.base_unit, du: j && j.default_unit, stock: j && j.stock, avg: j && j.avg_cost };
}

const start = await get();
console.log('起始', JSON.stringify({ base: start.base_unit, du: start.default_unit, stock: start.stock, avg: start.avg_cost }));
console.log('A 不给系数', JSON.stringify(await put(mk(start, '个', '个', null))));
const after = await get();
console.log('A 后未变', JSON.stringify({ base: after.base_unit, du: after.default_unit, stock: after.stock, avg: after.avg_cost }));
