/* =============== 出库 =============== */
let outSaleRowId = 0;
let OUT_PREVIEW = null;  // 最近一次服务端出库预览（含先进先出结转成本），用于展示真实成本
let OUT_FEE_MANUAL = false;  // 固定费用合计是否被手动改过（改过就别让「预览结算」覆盖掉）
let OUT_EXPRESS_MANUAL = null;  // 快递费手动改过的金额（null=按整单毛重自动算）
let OUT_EXPRESS_CARRIER = null; // 本单选用的快递公司 id（null=默认快递）；在「关联结算」的快递费行里切换
let EXPRESS_CARRIER_LIST = [];  // 快递公司规则缓存（快递费页 + 出库单的快递费行共用）
let EXPRESS_CARRIER_DEFAULT = ""; // 默认快递公司 id

/* ---------- 实收金额口径：客户承担的关联结算（包材 / 人工 / 快递费） ----------
   手动出库 / AI 出库：客户的付款里含包材/工时/运费 → 默认全勾，勾选后计入「实收金额」
   （后端同样记进 settle_income 与报表收入；成本侧的包材/快递照旧结转）。
   选择记在浏览器里，下一单沿用。
   注意：导入路径（聚水潭/批量/一键）不带口径，按 services.DEFAULT_SETTLE_CATS 记「客户不承担」。 */
const SETTLE_KEYS = { material: "settleMaterial", labor: "settleLabor", express: "settleExpress", fee: "settleFee" };
const SETTLE_LABEL = { material: "包材", labor: "人工", express: "快递费", fee: "固定成本" };

function settleCats() {
  return Object.keys(SETTLE_KEYS).filter((k) => $(SETTLE_KEYS[k])?.checked);
}
function setSettleAll(on) {
  Object.values(SETTLE_KEYS).forEach((id) => { if ($(id)) $(id).checked = !!on; });
  settleChanged();
}
function settleChanged() {
  try { localStorage.setItem("settleCats", JSON.stringify(settleCats())); } catch (e) { /* 隐私模式忽略 */ }
  calcOutboundTotals();
}
function settleRestore() {
  try {
    const v = JSON.parse(localStorage.getItem("settleCats") || "null");
    if (!Array.isArray(v)) return;   // 没记录过就保持表单默认（全勾）；显式存过（含全不选）才覆盖
    Object.entries(SETTLE_KEYS).forEach(([k, id]) => { if ($(id)) $(id).checked = v.includes(k); });
  } catch (e) { /* 忽略 */ }
}
/** 关联结算行归到哪一类（与后端 services.pack_settle_cat 口径一致） */
function packSettleCat(tr) {
  const m = packRowProduct(tr);
  const cat = (m?.category || "").trim();
  const name = (m?.name || "").trim();
  if (cat === "人工") return "labor";
  if (cat === "快递") return "express";
  if (name.endsWith("打包")) return "labor";
  return "material";   // 包材 / 耗材 / 包装 / 其他关联结算
}
/** 勾选的关联结算合计（= 客户代收，计入实收金额）；「固定成本」勾上时把固定费用合计也算进来 */
function settleIncomeLocal() {
  const cats = settleCats();
  let sum = 0;
  document.querySelectorAll("#outPackBody tr").forEach((tr) => {
    if (!cats.includes(packSettleCat(tr))) return;
    sum += parseFloat((tr.querySelector(".pl-amount")?.textContent || "0").replace(/[^\d.-]/g, "")) || 0;
  });
  if (cats.includes("fee")) sum += parseFloat($("outFee")?.value) || 0;
  return Math.round(sum * 100) / 100;
}
function settleCatsLabel(cats) {
  const list = Array.isArray(cats) ? cats : String(cats || "").split(",").filter(Boolean);
  return list.map((k) => SETTLE_LABEL[k] || k).join("、");
}
function initOutbound() {
  if (!$("outDate").value) $("outDate").value = today();
  if (!$("outSaleBody").children.length) addSaleRow();
  settleRestore();
  loadExpressCarrierList();   // 关联结算的快递费行要选快递公司
  loadOutbounds();
  renderJstPending();   // 顺手刷新「待办处理」卡片（没有待办会自动隐藏）
}
/** 固定费用被手动改过 → 记住，别被预览覆盖；没改过则跟随系统建议值 */
function outFeeTouched() { OUT_FEE_MANUAL = true; calcOutboundTotals(); }
/** 恢复系统建议的固定费用（按商品打包费自动算）；只填值不重绘表格，免得丢掉手动改过的结算行数量 */
function outFeeReset() {
  if (!OUT_PREVIEW) return;
  OUT_FEE_MANUAL = false;
  $("outFee").value = OUT_PREVIEW.total_fee;
  if ($("outFeeHint")) $("outFeeHint").textContent = "按商品打包费自动算出的建议值，可手动覆盖";
  calcOutboundTotals();
}
function addSaleRow() {
  const id = ++outSaleRowId;
  const tr = document.createElement("tr");
  tr.dataset.id = id;
  tr.innerHTML = `
    <td><input class="sale-pick-name" readonly placeholder="＋ 点击选择商品" onclick="openSalePicker(this)" style="cursor:pointer;background:var(--primary-50);" /></td>
    <td><select class="searchable sale-unit" onchange="saleUnitChanged(this)"></select></td>
    <td><input type="number" step="any" value="1" oninput="saleCalcRow(this)" style="width:90px;" /></td>
    <td><input type="number" step="any" value="0" oninput="saleCalcRow(this)" style="width:100px;" /></td>
    <td class="num sale-sub">¥0.00</td>
    <td><button class="btn sm danger" onclick="this.closest('tr').remove()">✕</button></td>`;
  $("outSaleBody").appendChild(tr);
  bindSearchable(tr);
}
/* ---------- 商品选择器（二级弹层：搜索 + 分类/类型筛选 + 卡片列表） ---------- */
let SALE_PICK_TR = null;
function openSalePicker(inp) {
  SALE_PICK_TR = inp.closest("tr");
  const sp = saleProducts();
  const cats = [...new Set(sp.map((p) => p.category).filter(Boolean))].sort();
  openModal(`
    <h3>选择销售商品 <button class="close" onclick="closeModal()">✕</button></h3>
    <div class="toolbar" style="margin-bottom:10px;">
      <input id="spSearch" placeholder="🔍 搜索商品名称 / 分类…（「；」任一命中，「：」同时命中）" oninput="renderSalePicker()" />
      <select id="spType" onchange="renderSalePicker()"><option value="">全部类型</option><option value="order">订单商品</option><option value="stock">库存商品</option></select>
      <select id="spCat" class="searchable" onchange="renderSalePicker()"><option value="">全部分类</option>${cats.map((c) => `<option value="${esc(c)}">${esc(c)}</option>`).join("")}</select>
    </div>
    <div class="sp-list" id="spList" style="max-height:52vh;overflow-y:auto;"></div>`);
  renderSalePicker();
}
function renderSalePicker() {
  const kws = splitSearchKeywords($("spSearch")?.value);
  const type = $("spType")?.value || "";
  const cat = $("spCat")?.value || "";
  const rows = saleProducts().filter((p) =>
    searchHit(`${p.name} ${p.category || ""}`, kws) &&
    (!type || p.product_type === type) &&
    (!cat || p.category === cat)
  );
  const list = $("spList");
  if (!rows.length) { list.innerHTML = `<div class="empty" style="padding:30px;">无匹配商品</div>`; return; }
  list.innerHTML = rows.map((p) => `
    <div class="sp-item" onclick="pickSaleProduct(${p.id})">
      <div class="grow">
        <b>${p.product_type === "order" ? '<span class="badge income">订单</span>' : '<span class="badge adjust">库存</span>'} ${esc(p.name)}</b>
        <div class="muted" style="font-size:12px;">${esc(p.category || "—")} · 单位 ${esc(p.default_unit || p.base_unit)} · 库存 ${fmtStock(p)}</div>
      </div>
      <span class="badge" style="background:var(--primary-light);color:var(--primary);">选择 ›</span>
    </div>`).join("");
}
function pickSaleProduct(id) {
  const p = PRODUCTS.find((x) => x.id === id);
  if (!p || !SALE_PICK_TR) return;
  const tr = SALE_PICK_TR;
  tr.dataset.pid = p.id;
  tr.querySelector(".sale-pick-name").value = `${p.product_type === "order" ? "[订单]" : "[库存]"} ${p.name}（${p.category || "—"}）`;
  // 单位：订单商品固定"单"；库存商品默认展示单位
  const convs = p.conversions || {};
  const du = p.product_type === "order" ? "单" : (p.default_unit || p.base_unit);
  const unitSel = tr.querySelector(".sale-unit");
  const units = Object.keys(convs).length ? Object.keys(convs) : [du || "个"];
  unitSel.innerHTML = units.map((u) => `<option value="${u}">${u}</option>`).join("");
  unitSel.value = units.includes(du) ? du : units[0];
  saleUnitChanged(unitSel);
  closeModal();
}
function saleUnitChanged(sel) {
  const tr = sel.closest("tr");
  const p = PRODUCTS.find((x) => x.id === +tr.dataset.pid);
  const unit = sel.value;
  if (p && unit) fillSalePrice(tr, p, unit);  // 自动带出参考成本单价
  saleCalcRow(tr.querySelectorAll("input[type=number]")[0]);
}
function saleCalcRow(inp) {
  const tr = inp.closest("tr");
  const qty = parseFloat(tr.querySelectorAll("input[type=number]")[0].value) || 0;
  const price = parseFloat(tr.querySelectorAll("input[type=number]")[1].value) || 0;
  tr.querySelector(".sale-sub").textContent = fmtMoney(qty * price);
}
function collectSaleLines() {
  const lines = [];
  document.querySelectorAll("#outSaleBody tr").forEach((tr) => {
    const pid = +tr.dataset.pid;
    const unitSel = tr.querySelector(".sale-unit");
    const unit = unitSel ? unitSel.value : "";
    const qty = parseFloat(tr.querySelectorAll("input[type=number]")[0].value);
    const price = parseFloat(tr.querySelectorAll("input[type=number]")[1].value);
    if (pid && unit && qty > 0) lines.push({ product_id: pid, unit, quantity: qty, price: price || 0 });
  });
  return lines;
}
/* 是否自动结算快递费（手动出库）：关掉后不再按整单毛重自动加「快递费」行 */
function autoExpressOn() { return $("outAutoExpress") ? $("outAutoExpress").checked : true; }
async function previewOutbound() {
  const lines = collectSaleLines();
  if (!lines.length) { toast("请至少添加一行销售商品"); return; }
  if (!EXPRESS_CARRIER_LIST.length) await loadExpressCarrierList();   // 快递费行要能选公司
  try {
    // 手动挑选的关联物品也带上：后端追加在自动带出的结算项后面，一起按 FIFO 算成本
    const r = await api("/api/outbounds/preview", "POST", {
      lines, auto_express: autoExpressOn(), extra_pack_lines: collectManualPackLines(),
      settle_cats: settleCats(),   // 实收含哪些关联结算（后端据此回 settle_income）
      express_fee: OUT_EXPRESS_MANUAL,   // 手动改过快递费：预览也按这个金额算，和提交保持一致
      express_carrier: outExpressCarrierId(),   // 关联结算里绑定的快递公司（不选=默认快递）
    });
    renderPackPreview(r);
  } catch (e) { toast("预览失败：" + e.message); }
}
/** 快递费行里的「快递公司」下拉选项（默认选中本行已绑定的公司） */
function expressCarrierOptions(carrierId) {
  const list = EXPRESS_CARRIER_LIST.length
    ? EXPRESS_CARRIER_LIST
    : [{ id: "", name: "（默认快递）" }];
  const cur = carrierId || OUT_EXPRESS_CARRIER || EXPRESS_CARRIER_DEFAULT;
  return list.map((c) =>
    `<option value="${esc(c.id)}"${c.id === cur ? " selected" : ""}>${esc(c.name)}</option>`
  ).join("");
}
/** 关联结算里换快递公司：按新公司的规则，用本行毛重立刻重算快递费 */
function expressCarrierPick(sel) {
  const tr = sel.closest("tr");
  OUT_EXPRESS_CARRIER = sel.value || null;
  OUT_EXPRESS_MANUAL = null;   // 换了公司：手填金额作废，改按新公司的规则算
  if (tr) tr.querySelector(".pl-exp-reset")?.remove();
  const cfg = EXPRESS_CARRIER_LIST.find((c) => c.id === OUT_EXPRESS_CARRIER);
  const w = parseFloat(tr?.dataset?.weight || "");
  if (!cfg || !(w > 0) || !tr) { previewOutbound(); return; }
  const fee = exprFee(cfg, w);
  const td = tr.querySelector("td[data-auto-fee]");
  if (td) td.dataset.autoFee = String(fee);
  const inp = tr.querySelector(".pl-up");
  if (inp) {
    inp.value = fee;
    inp.title = `按「${cfg.name}」整单毛重 ${w}kg 自动算：¥${fmtNum(fee)}/单；不对可手填本单实际快递费`;
  }
  tr.dataset.up = String(fee);
  const qty = parseFloat(tr.querySelector(".pl-qty")?.value) || 1;
  const amt = tr.querySelector(".pl-amount");
  if (amt) amt.textContent = fmtMoney(fee * qty);
  calcOutboundTotals();
  toast(`本单快递费已改按「${cfg.name}」计：${fmtMoney(fee)}`);
}
/** 本单选用的快递公司 id：
 *  用户在关联结算里显式改过 → 用它；否则沿用上一次预览算出来的那家；
 *  都没有（首次预览）→ 传 null，由后端按「商品资料绑定的快递公司 → 默认快递」决定。 */
function outExpressCarrierId() {
  if (OUT_EXPRESS_CARRIER) return OUT_EXPRESS_CARRIER;
  const sel = document.querySelector("#outPackBody tr[data-express='1'] .pl-carrier");
  return (sel && sel.value) || null;
}
function renderPackPreview(r) {
  OUT_PREVIEW = r;
  $("outPreview").style.display = "block";
  // 固定费用：手动改过就保留用户的数（服务端建议值放提示里，可一键恢复）
  if (!OUT_FEE_MANUAL) $("outFee").value = r.total_fee;
  if ($("outFeeHint")) {
    const cur = parseFloat($("outFee").value) || 0;
    $("outFeeHint").innerHTML = OUT_FEE_MANUAL && Math.abs(cur - (r.total_fee || 0)) > 1e-9
      ? `已按手填 ¥${(cur || 0).toFixed(2)} 计；系统建议 ¥${(r.total_fee || 0).toFixed(2)}（按商品打包费自动算）· <a href="javascript:outFeeReset()">恢复建议值</a>`
      : "按商品打包费自动算出的建议值，可手动覆盖";
  }
  $("outWarn").innerHTML = (r.warnings || []).map((w) => `<div class="alert warn">⚠ ${esc(w)}（仍可继续，可先补货）</div>`).join("");
  $("outPackBody").innerHTML = r.pack_lines.map((pl, i) => {
    const m = PRODUCTS.find((x) => x.id === pl.product_id);
    // 快递费行标记出来：删掉它 = 这笔不结算快递费（否则重新预览又会被自动加回来）
    const isExpress = pl.express_carrier_id != null || !!(m && m.category === "快递");
    const isAutoExpress = pl.express_weight != null;   // 按整单毛重自动算的那行 → 可以切快递公司
    const isManual = !!pl.manual;   // 手动挑选的关联物品（后端已按 FIFO 算好成本一起返回）
    // 快递公司绑定就在这一行上改：换一家立刻按它的规则重算本单快递费
    const carrierPick = isAutoExpress
      ? `<div style="margin-top:4px;"><select class="pl-carrier" style="max-width:140px;" onchange="expressCarrierPick(this)" title="这单按哪家快递公司的规则计费（在「快递费」页维护规则）">${expressCarrierOptions(pl.express_carrier_id)}</select></div>`
      : "";
    return `<tr data-idx="${i}" data-pid="${pl.product_id}" data-unit="${esc(pl.unit)}" data-up="${pl.unit_price}" data-weight="${pl.express_weight != null ? pl.express_weight : ""}"${isManual ? ' data-manual="1"' : ""}${isExpress ? ' data-express="1"' : ""}>
      <td><b>${esc(pl.product_name)}</b>${isManual ? ' <span class="badge" style="background:var(--primary-light);color:var(--primary);">手动</span>' : ""}${carrierPick}</td>
      <td><select class="searchable pl-unit" onchange="packLineUnitChanged(this)">${m ? unitOptions(m, pl.unit) : `<option>${pl.unit}</option>`}</select></td>
      <td><input class="pl-qty" type="number" step="any" value="${pl.quantity}" oninput="packLineChanged(this)" style="width:90px;" /></td>
      <td><span class="badge pack">${isExpress ? "快递费" : (isManual && m && m.category === "人工" ? "人工" : "包装消耗")}</span></td>
      ${isExpress
        ? `<td class="num mono" data-auto-fee="${pl.auto_express_fee != null ? pl.auto_express_fee : pl.unit_price}"><input class="pl-up" type="number" step="any" min="0" value="${OUT_EXPRESS_MANUAL != null ? OUT_EXPRESS_MANUAL : pl.unit_price}" oninput="expressFeeChanged(this)" style="width:100px;" title="按${pl.express_carrier ? `「${esc(pl.express_carrier)}」` : ""}整单毛重${pl.express_weight != null ? ` ${pl.express_weight}kg` : ""}自动算：¥${fmtNum(pl.auto_express_fee != null ? pl.auto_express_fee : pl.unit_price)}/单；不对可手填本单实际快递费" /> /单${OUT_EXPRESS_MANUAL != null ? ` · <a class="pl-exp-reset" href="javascript:;" onclick="outExpressReset()">恢复自动</a>` : ""}</td>`
        : `<td class="num mono">¥${fmtNum(pl.unit_price)}/${esc(pl.unit)}</td>`}
      <td class="num pl-amount">${fmtMoney(pl.amount)}</td>
      <td><button class="btn sm danger" title="删除该结算项" onclick="removePackRow(this)">✕</button></td></tr>`;
  }).join("");
  if (!r.pack_lines.length) $("outPackBody").innerHTML = `<tr><td colspan="7" class="empty">无关联结算项（该商品未配置包装清单）</td></tr>`;
  bindSearchable($("outPackBody"));
  calcOutboundTotals();
}
/** 手动挑选的关联物品：从当前表格收集，重新预览时交回后端，一起按 FIFO 算成本 */
function collectManualPackLines() {
  const out = [];
  document.querySelectorAll('#outPackBody tr[data-manual="1"]').forEach((tr) => {
    const unit = tr.querySelector(".pl-unit")?.value;
    const qty = parseFloat(tr.querySelector(".pl-qty")?.value);
    const m = packRowProduct(tr);
    if (m && unit && qty > 0) out.push({ product_id: m.id, unit, quantity: qty });
  });
  return out;
}
/* ---------- 关联出库物品：手动挑选（包材 / 人工 / 快递费等，任意商品都可选） ---------- */
function packRowProduct(tr) {
  const pid = +(tr?.dataset?.pid || 0);
  if (pid) {
    const p = PRODUCTS.find((x) => x.id === pid);
    if (p) return p;
  }
  const name = tr?.querySelector("b")?.textContent?.trim();
  return PRODUCTS.find((x) => x.name === name) || null;
}

/** 往「关联结算」表里加一行（结构与被预览带出的行一致，提交时一起收集） */
function addPackRow(m, qty = 1) {
  const body = $("outPackBody");
  if (!body || !m) return null;
  const empty = body.querySelector("tr .empty");
  if (empty) empty.closest("tr").remove();
  const unit = m.default_unit || m.base_unit;
  const factor = (m.conversions || {})[unit] || 1;
  const up = +((m.avg_cost || 0) * factor).toFixed(6);   // 估算：库存均价；重新预览后由服务端 FIFO 实算
  const tr = document.createElement("tr");
  tr.dataset.pid = m.id;
  tr.dataset.manual = "1";
  tr.dataset.unit = unit;
  tr.dataset.up = up;
  tr.innerHTML = `
    <td><b>${esc(m.name)}</b> <span class="badge" style="background:var(--primary-light);color:var(--primary);">手动</span></td>
    <td><select class="searchable pl-unit" onchange="packLineUnitChanged(this)">${unitOptions(m, unit)}</select></td>
    <td><input class="pl-qty" type="number" step="any" min="0" value="${qty}" oninput="packLineChanged(this)" style="width:90px;" /></td>
    <td><span class="badge pack">${m.category === "快递" ? "快递费" : (m.category === "人工" ? "人工" : "包装消耗")}</span></td>
    <td class="num mono" title="按库存均价估算；点「🔍 预览结算」后按 FIFO 实算">¥${fmtNum(up)}/${esc(unit)}</td>
    <td class="num pl-amount">${fmtMoney(up * qty)}</td>
    <td><button class="btn sm danger" title="删除该结算项" onclick="removePackRow(this)">✕</button></td>`;
  body.appendChild(tr);
  try { bindSearchable(tr) } catch (e) { /* 单位下拉搜索绑定失败不影响录入 */ }
  calcOutboundTotals();
  return tr;
}

function openPackItemPicker() {
  if (!$("outPreview") || $("outPreview").style.display === "none") {
    toast("先点「🔍 预览结算」，再挑关联出库物品"); return;
  }
  const cats = [...new Set(PRODUCTS.filter((p) => p.is_active).map((p) => p.category).filter(Boolean))].sort();
  openModal(`
    <h3>选择关联出库物品 <button class="close" onclick="closeModal()">✕</button></h3>
    <div class="toolbar" style="margin-bottom:10px;">
      <input id="ppSearch" placeholder="🔍 搜索商品名称 / 分类…（「；」任一命中，「：」同时命中）" oninput="renderPackItemPicker()" />
      <select id="ppCat" class="searchable" onchange="renderPackItemPicker()"><option value="">全部分类</option>${cats.map((c) => `<option value="${esc(c)}">${esc(c)}</option>`).join("")}</select>
    </div>
    <div class="sp-list" id="ppList" style="max-height:52vh;overflow-y:auto;"></div>`);
  renderPackItemPicker();
}

function renderPackItemPicker() {
  const kws = splitSearchKeywords($("ppSearch")?.value);
  const cat = $("ppCat")?.value || "";
  const rows = PRODUCTS.filter((p) => p.is_active
    && searchHit(`${p.name || ""} ${p.category || ""}`, kws)
    && (!cat || p.category === cat));
  const list = $("ppList");
  if (!list) return;
  if (!rows.length) { list.innerHTML = `<div class="empty" style="padding:30px;">无匹配商品</div>`; return; }
  list.innerHTML = rows.map((p) => `
    <div class="sp-item" onclick="pickPackItem(${p.id})">
      <div class="grow">
        <b>${esc(p.name)}</b>
        <div class="muted" style="font-size:12px;">${esc(p.category || "—")} · 单位 ${esc(p.default_unit || p.base_unit)} · 库存 ${fmtStock(p)}</div>
      </div>
      <span class="badge" style="background:var(--primary-light);color:var(--primary);">选择 ›</span>
    </div>`).join("");
}

function pickPackItem(id) {
  const p = PRODUCTS.find((x) => x.id === id);
  if (!p) return;
  closeModal();
  addPackRow(p);
  toast(`已添加关联物品：${p.name}（数量按本单用量改）`);
  previewOutbound();   // 立刻重算一次：让它按 FIFO 出准成本，而不是停留在均价估算
}
/* 删掉「快递费」行 → 同步取消「自动计快递费」，避免再次预览/提交时又被算上 */
function removePackRow(btn) {
  const tr = btn.closest("tr");
  if (tr && tr.dataset.express === "1") {
    const cb = $("outAutoExpress");
    if (cb) cb.checked = false;
    OUT_EXPRESS_MANUAL = null;   // 快递费行已删，手填金额作废
    toast("已取消「自动计快递费」，这笔出库不再计快递费");
  }
  tr.remove();
  calcOutboundTotals();
}
/** 快递费手动改：用手填的金额重算小计，预览/提交都按这个金额结算（不再按毛重自动算） */
function expressFeeChanged(inp) {
  const tr = inp.closest("tr");
  const v = parseFloat(inp.value);
  OUT_EXPRESS_MANUAL = (Number.isFinite(v) && v >= 0) ? v : null;
  if (OUT_EXPRESS_MANUAL == null) return;   // 清空/非法：等重新预览时回到自动值
  const qty = parseFloat(tr.querySelector(".pl-qty")?.value) || 0;
  tr.dataset.up = String(OUT_EXPRESS_MANUAL);
  const amt = tr.querySelector(".pl-amount");
  if (amt) amt.textContent = fmtMoney(OUT_EXPRESS_MANUAL * qty);
  calcOutboundTotals();
}
/** 恢复按整单毛重自动计算快递费 */
function outExpressReset() {
  OUT_EXPRESS_MANUAL = null;
  previewOutbound();
}
function packLineUnitChanged(sel) {
  packLineChanged(sel);
}
function packLineChanged(inp) {
  const tr = inp.closest("tr");
  // ⚠ 必须按类名取：单位下拉被 bindSearchable 换成了「筛选输入框 + 列表」，原 select 隐藏，
  //   按 querySelectorAll("input")[0] 会取到那个空的筛选框 → 数量恒为 0、小计算成 ¥0.00
  const unit = tr.querySelector(".pl-unit")?.value || "";
  const qty = parseFloat(tr.querySelector(".pl-qty")?.value) || 0;
  const m = packRowProduct(tr);
  if (m && unit) {
    // 优先按服务端预览给出的先进先出单位成本(每展示单位)重算；单位被改过则回退估计
    const up = (tr.dataset.unit === unit) ? parseFloat(tr.dataset.up) : NaN;
    const cost = (up > 0)
      ? up * qty
      : (m.avg_cost || 0) * qty * ((m.conversions || {})[unit] || 1);
    tr.querySelector(".pl-amount").textContent = fmtMoney(cost);
  }
  calcOutboundTotals();
}
function collectPackLines() {
  const lines = [];
  document.querySelectorAll("#outPackBody tr").forEach((tr) => {
    // 自动算出来的「快递费」行不提交：后端会按整单毛重自己结算（提交会被算两遍）
    if (tr.dataset.express === "1") return;
    const unit = tr.querySelector(".pl-unit")?.value;
    const qty = parseFloat(tr.querySelector(".pl-qty")?.value);
    const m = packRowProduct(tr);
    if (m && unit && qty > 0) lines.push({ product_id: m.id, unit, quantity: qty });
  });
  return lines;
}
function calcOutboundTotals() {
  let amount = 0, cogs = 0;
  let vi = 0;  // 有效销售行序号，与服务端预览 sale_lines 的顺序一致
  document.querySelectorAll("#outSaleBody tr").forEach((tr) => {
    const p = PRODUCTS.find((x) => x.id === +tr.dataset.pid);
    const unitSel = tr.querySelector(".sale-unit");
    const unit = unitSel ? unitSel.value : "";
    const qty = parseFloat(tr.querySelectorAll("input[type=number]")[0].value) || 0;
    const price = parseFloat(tr.querySelectorAll("input[type=number]")[1].value) || 0;
    amount += qty * price;
    if (p && unit && qty > 0) {
      const sl = OUT_PREVIEW && OUT_PREVIEW.sale_lines ? OUT_PREVIEW.sale_lines[vi] : null;
      // 与最近一次服务端预览一致时，直接采用后端先进先出结转成本（与保存后一致）
      if (sl && sl.product_id === p.id && sl.unit === unit && Math.abs(sl.quantity - qty) < 1e-9) {
        cogs += sl.cogs;
      } else {
        cogs += qty * (p.conversions?.[unit] || 1) * (p.avg_cost || 0);  // 估算兜底
      }
      vi++;
    }
  });
  document.querySelectorAll("#outPackBody tr").forEach((tr) => {
    const amt = parseFloat((tr.querySelector(".pl-amount")?.textContent || "0").replace(/[^\d.-]/g, "")) || 0;
    cogs += amt;
  });
  const fee = parseFloat($("outFee").value) || 0;
  const adjust = parseFloat($("outAdjust")?.value) || 0;   // 抹零/凑整：正=加收，负=抹零
  // 客户随货款一起付的关联结算（包材/人工/快递费，按上面的勾选）→ 计入实收金额与毛利
  const settleIn = settleIncomeLocal();
  const finalAmount = amount + settleIn + adjust;           // 实收金额（差额记「金额调整」其他收支）
  $("otAmount").textContent = fmtMoney(amount);
  if ($("otFinal")) {
    $("otFinal").innerHTML = fmtMoney(finalAmount) + (settleIn
      ? `<div class="muted" style="font-size:11px;">含${esc(settleCatsLabel(settleCats()))} ${fmtMoney(settleIn)}</div>` : "");
  }
  $("otCogs").textContent = fmtMoney(cogs);
  $("otGross").textContent = fmtMoney(amount + settleIn - cogs);
  // 净利按实收口径：抹零/凑整的差额已计入其他收支，这里同步扣掉，与报表口径一致
  $("otNet").textContent = fmtMoney(finalAmount - cogs - fee);
  const hint = $("settleHint");
  if (hint) {
    hint.innerHTML = settleIn
      ? `客户代收：${esc(settleCatsLabel(settleCats()))} ${fmtMoney(settleIn)} → 实收 ${fmtMoney(finalAmount)}`
      : "当前：实收 = 货款 + 调整（客户不承担关联结算）";
  }
}
function clearPreview() {
  $("outPreview").style.display = "none";
  OUT_PREVIEW = null;
  OUT_FEE_MANUAL = false;
  OUT_EXPRESS_MANUAL = null;
  OUT_EXPRESS_CARRIER = null;   // 下一单回到默认快递
  if ($("outAdjust")) $("outAdjust").value = "";
  if ($("outFeeHint")) $("outFeeHint").textContent = "";
}
/* ---------- 货款回收：同一商品快速入库 + 按销售价出库，算这一笔的净利 ---------- */
async function openQuickRecovery() {
  try {
    if (!PRODUCTS.length) PRODUCTS = await api("/api/products");
  } catch (e) { toast("商品资料加载失败：" + e.message); return; }
  const opts = PRODUCTS.filter((p) => p.is_active !== false)
    .sort((a, b) => String(a.name || "").localeCompare(String(b.name || ""), "zh"))
    .map((p) => `<option value="${p.id}">${esc(p.name)}</option>`).join("");
  if (!opts) { toast("还没有可用的商品，请先到「商品资料」新增"); return; }
  openModal(`
    <h3>货款回收 <button class="close" onclick="closeModal()">✕</button></h3>
    <div class="form-grid">
      <div class="field"><label>日期 *</label><input id="qrDate" type="date" value="${today()}" /></div>
      <div class="field"><label>商品 *</label><select id="qrProduct" class="searchable" onchange="qrProductChanged()">${opts}</select></div>
      <div class="field"><label>单位</label><select id="qrUnit" onchange="qrUnitChanged()"></select></div>
      <div class="field"><label>客户（出库单）</label><input id="qrCustomer" placeholder="可不填" /></div>
    </div>
    <h4 class="block-title">入库（采购）</h4>
    <div class="form-grid">
      <div class="field"><label>数量 *</label><input id="qrInQty" type="number" step="any" min="0" value="1" oninput="qrInQtyChanged(this)" /><div class="field-hint">填 0 = 本次不采购，只卖现有库存（成本按库存 FIFO 算）</div></div>
      <div class="field"><label>单价（元/单位）*</label><input id="qrInPrice" type="number" step="any" min="0" placeholder="0.00" oninput="qrCalc()" /><div class="field-hint" id="qrInPriceHint"></div></div>
      <div class="field"><label>运费</label><input id="qrInFreight" type="number" step="any" min="0" placeholder="0.00" oninput="qrCalc()" /></div>
      <div class="field"><label>装卸费</label><input id="qrInHandling" type="number" step="any" min="0" placeholder="0.00" oninput="qrCalc()" /></div>
      <div class="field"><label>调整（抹零/补整）</label><input id="qrInAdjust" type="number" step="any" placeholder="0.00" oninput="qrCalc()" /><div class="field-hint">正=多付给供应商，负=少付</div></div>
    </div>
    <h4 class="block-title">出库（销售）</h4>
    <div class="form-grid">
      <div class="field"><label>数量 *</label><input id="qrOutQty" type="number" step="any" min="0" value="1" oninput="this.dataset.touched='1';qrCalc()" /></div>
      <div class="field"><label>单价（元/单位）*</label><input id="qrOutPrice" type="number" step="any" min="0" placeholder="0.00" oninput="qrCalc()" /></div>
      <div class="field"><label>运费</label><input id="qrOutFreight" type="number" step="any" min="0" placeholder="0.00" oninput="qrCalc()" /></div>
      <div class="field"><label>装卸费</label><input id="qrOutHandling" type="number" step="any" min="0" placeholder="0.00" oninput="qrCalc()" /></div>
      <div class="field"><label>手续费</label><input id="qrOutFee" type="number" step="any" min="0" placeholder="0.00" oninput="qrCalc()" /></div>
      <div class="field"><label>调整（抹零/补整）</label><input id="qrOutAdjust" type="number" step="any" placeholder="0.00" oninput="qrCalc()" /><div class="field-hint">正=加收，负=抹零</div></div>
    </div>
    <div class="field">
      <label>备注</label>
      <textarea id="qrRemark" rows="2" placeholder="可选；可直接 Ctrl+V 粘贴图片 / 附件" onpaste="pasteRemarkFiles('qrRemark', event)"></textarea>
      <div class="attach-bar">
        <button type="button" class="btn sm secondary" onclick="$('qrRemarkFile').click()"><svg class="ic"><use href="#i-paperclip"/></svg> 图片 / 附件</button>
        <span class="attach-tip">支持图片、PDF、Excel 等（≤20MB），可直接 Ctrl+V 粘贴</span>
        <input type="file" id="qrRemarkFile" multiple style="display:none;" onchange="uploadRemarkFiles('qrRemark', this)" />
      </div>
      <div class="attach-list" id="qrRemarkFiles"></div>
    </div>
    <div class="alert ok" id="qrProfit" style="margin-top:12px;">净利 ¥0.00</div>
    <div class="toolbar" style="justify-content:flex-end;margin-top:12px;">
      <button class="btn secondary" onclick="closeModal()">取消</button>
      <button class="btn" onclick="submitQuickRecovery()">确认回收</button>
    </div>`);
  clearRemarkField("qrRemark");   // 每次打开清空上一次的备注附件
  QR_FIFO_COST = null; QR_FIFO_WARN = ""; QR_FIFO_KEY = ""; QR_FIFO_FAILED = "";
  const sel = $("qrProduct");
  if (sel) sel.dispatchEvent(new Event("change", { bubbles: true }));   // 初值同步到搜索框 + 带出单位
  else qrProductChanged();
}
function qrNum(id) { return parseFloat($(id)?.value) || 0; }
/* 入库数量为 0（只卖旧库存）时，成本要按库存 FIFO 实算：用出库预览接口取真实成本 */
let QR_FIFO_COST = null, QR_FIFO_WARN = "", QR_FIFO_KEY = "", QR_FIFO_FAILED = "", QR_FIFO_SEQ = 0, QR_PREVIEW_TIMER = null;
function qrFifoKey() {
  const p = PRODUCTS.find((x) => x.id === +(($("qrProduct") || {}).value || 0));
  const unit = ($("qrUnit") || {}).value || "";
  const qty = qrNum("qrOutQty");
  return (p && unit && qty > 0) ? `${p.id}|${unit}|${qty}` : "";
}
function qrScheduleFifoCost() {
  const key = qrFifoKey();
  if (key === QR_FIFO_KEY && QR_FIFO_COST != null) return;   // 同输入已算过，别重复请求
  if (key && key === QR_FIFO_FAILED) return;                // 失败过就不自动重试，改输入再试
  clearTimeout(QR_PREVIEW_TIMER);
  QR_FIFO_KEY = key;
  QR_FIFO_COST = null;
  QR_FIFO_WARN = "";
  if (!key) return;
  QR_PREVIEW_TIMER = setTimeout(async () => {
    const seq = ++QR_FIFO_SEQ;
    const p = PRODUCTS.find((x) => x.id === +(($("qrProduct") || {}).value || 0));
    const unit = $("qrUnit").value;
    const qty = qrNum("qrOutQty");
    try {
      const r = await api("/api/outbounds/preview", "POST", {
        lines: [{ product_id: p.id, unit, quantity: qty, price: qrNum("qrOutPrice") }],
        auto_express: false, extra_pack_lines: [], settle_cats: [],
      });
      if (seq !== QR_FIFO_SEQ) return;
      QR_FIFO_COST = Math.round((Number(r.total_cogs) || 0) * 100) / 100;
      QR_FIFO_WARN = (r.warnings || []).join("；");
      QR_FIFO_FAILED = "";
      qrCalc();
    } catch (e) {
      if (seq !== QR_FIFO_SEQ) return;
      QR_FIFO_COST = null;
      QR_FIFO_WARN = "成本预览失败：" + e.message;
      QR_FIFO_FAILED = key;
      qrCalc();
    }
  }, 300);
}
function qrProductChanged() {
  const p = PRODUCTS.find((x) => x.id === +(($("qrProduct") || {}).value || 0));
  const unit = p ? (p.default_unit || p.base_unit || "kg") : "kg";
  const html = p ? unitOptions(p, unit) : "";
  $("qrUnit").innerHTML = html || `<option value="${esc(unit)}">${esc(unit)}</option>`;
  qrFillInPrice();
  qrCalc();
}
/** 换单位：和入库页一样按新单位重新带出价格（最近入库价 → 参考成本） */
function qrUnitChanged() {
  qrFillInPrice();
  qrCalc();
}
/** 入库单价自动带出：优先最近一次入库价（按所选单位换算），没有则用参考成本；可手改 */
function qrFillInPrice() {
  const p = PRODUCTS.find((x) => x.id === +(($("qrProduct") || {}).value || 0));
  const inp = $("qrInPrice");
  if (!p || !inp) return;
  const unit = $("qrUnit").value || p.default_unit || p.base_unit;
  const f = (p.conversions || {})[unit] || 1;
  const lastBase = Number(p.last_in_price) || 0;
  const refBase = Number(p.unit_cost) || 0;
  const per = (base) => +(base * f).toFixed(6);
  inp.value = lastBase > 0 ? per(lastBase) : (refBase > 0 ? per(refBase) : "");
  const hint = $("qrInPriceHint");
  if (hint) {
    hint.textContent = lastBase > 0
      ? `最近入库价 ¥${fmtNum(per(lastBase))}/${unit}（${p.last_in_date || "—"}），可改`
      : (refBase > 0 ? `按参考成本 ¥${fmtNum(per(refBase))}/${unit} 填入，可改` : "还没入库过、也没设参考成本，请手动填");
  }
}
/** 入库数量改动时，出库数量跟着同步（用户手动改过出库数量后就不再联动） */
function qrInQtyChanged(inp) {
  const out = $("qrOutQty");
  if (out && out.dataset.touched !== "1") out.value = inp.value;
  qrCalc();
}
function qrCalc() {
  const inQty = qrNum("qrInQty"), inPrice = qrNum("qrInPrice");
  const inFreight = qrNum("qrInFreight"), inHandling = qrNum("qrInHandling");
  const inAdjust = qrNum("qrInAdjust");   // 入库抹零/补整：正=多付，负=少付
  const outQty = qrNum("qrOutQty"), outPrice = qrNum("qrOutPrice");
  const outAdjust = qrNum("qrOutAdjust"); // 出库抹零/补整：正=加收，负=抹零
  const outFees = qrNum("qrOutFreight") + qrNum("qrOutHandling") + qrNum("qrOutFee");
  const revenue = outQty * outPrice;
  const box = $("qrProfit");
  if (!box) return;
  if (inQty > 0) {
    // 有本次采购：成本按本批到岸价算，并作废「只卖旧库存」的 FIFO 预览结果
    QR_FIFO_KEY = ""; QR_FIFO_COST = null; QR_FIFO_WARN = ""; QR_FIFO_FAILED = "";
    const purchase = inQty * inPrice + inFreight + inHandling;
    const landed = purchase / inQty;
    const net = revenue + outAdjust - outQty * landed - outFees - inAdjust;
    box.innerHTML = `净利 <b style="font-size:18px;">${fmtMoney(net)}</b>`
      + `<span class="muted" style="margin-left:10px;">出库收入净额 ${fmtMoney(revenue + outAdjust)} − 入库成本净额 ${fmtMoney(outQty * landed + inAdjust)} − 出库费用 ${fmtMoney(outFees)}</span>`;
    return;
  }
  // 入库为 0：只卖现有库存，成本按库存 FIFO 预览
  qrScheduleFifoCost();
  if (QR_FIFO_COST == null) {
    box.innerHTML = `净利 <b style="font-size:18px;">${QR_FIFO_FAILED ? "—" : "计算中…"}</b>`
      + `<span class="muted" style="margin-left:10px;">入库填 0：按库存 FIFO 成本计算；${esc(QR_FIFO_WARN)}</span>`;
    return;
  }
  const net = revenue + outAdjust - QR_FIFO_COST - outFees;
  box.innerHTML = `净利 <b style="font-size:18px;">${fmtMoney(net)}</b>`
    + `<span class="muted" style="margin-left:10px;">出库收入净额 ${fmtMoney(revenue + outAdjust)} − 出库成本(FIFO) ${fmtMoney(QR_FIFO_COST)} − 出库费用 ${fmtMoney(outFees)}</span>`
    + (QR_FIFO_WARN ? `<div class="muted" style="font-size:11px;color:var(--amber);">⚠ ${esc(QR_FIFO_WARN)}</div>` : "");
}
async function submitQuickRecovery() {
  const p = PRODUCTS.find((x) => x.id === +(($("qrProduct") || {}).value || 0));
  if (!p) { toast("请选择商品"); return; }
  const date = $("qrDate").value || today();
  const unit = $("qrUnit").value;
  const inQty = qrNum("qrInQty"), outQty = qrNum("qrOutQty");
  if (!unit) { toast("请选择单位"); return; }
  if (inQty < 0 || outQty <= 0) { toast("出库数量要大于 0；入库数量可填 0（只卖现有库存）"); return; }
  if (inQty > 0 && outQty > inQty + 1e-9) { toast("出库数量不能大于本次入库数量"); return; }
  try {
    const r = await api("/api/outbounds/quick-recovery", "POST", {
      date, product_id: p.id, unit,
      in_quantity: inQty, in_price: qrNum("qrInPrice"),
      in_freight: qrNum("qrInFreight"), in_handling: qrNum("qrInHandling"), in_adjust: qrNum("qrInAdjust"),
      out_quantity: outQty, out_price: qrNum("qrOutPrice"),
      out_freight: qrNum("qrOutFreight"), out_handling: qrNum("qrOutHandling"), out_fee: qrNum("qrOutFee"),
      out_adjust: qrNum("qrOutAdjust"),
      customer: ($("qrCustomer").value || "").trim(),
      remark: remarkValue("qrRemark"),
    });
    closeModal();
    clearRemarkField("qrRemark");
    const warns = (r.warnings || []).length ? `\n⚠ ${r.warnings.join("；")}` : "";
    const inTip = r.inbound_code ? `入库 ${r.inbound_code} / ` : "（只出库）";
    toast(`货款回收已入账：${inTip}出库 ${r.outbound_code}，净利 ${fmtMoney(r.net_profit)}${warns}`, 4200);
    loadOutbounds(); loadInbounds(); loadStock();
  } catch (e) { toast("货款回收失败：" + e.message); }
}
async function submitOutbound() {
  const lines = collectSaleLines();
  if (!lines.length) { toast("请至少添加一行销售商品"); return; }
  const packLines = collectPackLines();
  const fee = parseFloat($("outFee").value) || 0;
  try {
    const payStatus = payOf("outPay");
    const adjust = parseFloat($("outAdjust")?.value) || 0;
    const settleIn = settleIncomeLocal();
    const r = await api("/api/outbounds", "POST", {
      customer: $("outCustomer").value, operator: $("outOperator").value,
      date: $("outDate").value, remark: remarkValue("outRemark"),
      lines, pack_lines: packLines, pack_fee_total: fee,
      auto_express: autoExpressOn(),   // 与预览一致：关掉就不再自动加快递费
      express_fee: OUT_EXPRESS_MANUAL, // 手动改过快递费：按手填金额落库（不填=后端按毛重自动算）
      express_carrier: outExpressCarrierId(),   // 关联结算里绑定的快递公司（不选=默认快递）
      pay_status: payStatus, adjust_amount: adjust,
      settle_cats: settleCats(),       // 实收含哪些关联结算（客户随货款付回来的包材/人工/运费）
    });
    const warns = (r.warnings || []).length ? "\n⚠ " + r.warnings.join("；") : "";
    const settleTip = settleIn ? `（实收含${settleCatsLabel(settleCats())} ${fmtMoney(settleIn)}）` : "";
    toast("出库成功" + (adjust ? `（调整 ${adjust > 0 ? "+" : "-"}${Math.abs(adjust).toFixed(2)}，已记其他收支）` : "") + settleTip + (payStatus === "unpaid" ? "（待付款，已进待付款账单）" : "") + warns, 3800);
    $("outSaleBody").innerHTML = ""; outSaleRowId = 0; addSaleRow();
    clearPreview();
    $("outCustomer").value = "";
    clearRemarkField("outRemark");
    setPay("outPay", "paid");
    if ($("outAutoExpress")) $("outAutoExpress").checked = true;   // 复位：下一笔仍默认自动计快递费
    if (typeof closeDrawer === "function") closeDrawer("outboundDrawer");
    loadOutbounds(); loadStock();
  } catch (e) { toast("出库失败：" + e.message); }
}
async function loadOutbounds() {
  const from = $("outDateFrom").value, to = $("outDateTo").value;
  const flat = await api(`/api/outbounds?date_from=${from || ""}&date_to=${to || ""}`);
  const kws = splitSearchKeywords($("outSearch")?.value);
  // 按批次聚合：同一 import_group 的若干单合并为一条展示行
  let rows = [];
  const groups = new Map();
  for (const o of flat) {
    if (o.import_group) {
      if (!groups.has(o.import_group)) groups.set(o.import_group, []);
      groups.get(o.import_group).push(o);
    } else {
      rows.push({ _group: false, rec: o });
    }
  }
  for (const [key, recs] of groups) {
    const g = buildOutGroup(recs);
    if (searchHit([g.code, g.customer, g.date].join(" "), kws)) rows.push({ _group: true, g });
  }
  // 兼容旧筛选：进一步按单号/客户过滤（批次行存储成员以支持检索）
  if (kws.length) rows = rows.filter((r) => r._group
    ? (r.g.records || []).some((o) => searchHit([o.code, o.customer].join(" "), kws))
    : searchHit([r.rec.code, r.rec.customer].join(" "), kws));
  const t = $("outTable");
  // 提供可排序的统一字段
  const sortable = rows.map((r) => r._group
    ? { _group: true, g: r.g, code: r.g.code, customer: r.g.customer, total_amount: r.g.total_amount,
        total_cogs: r.g.total_cogs, total_fee: r.g.total_fee, net_profit: r.g.net_profit, date: r.g.date }
    : { _group: false, rec: r.rec, code: r.rec.code, customer: r.rec.customer, total_amount: r.rec.total_amount,
        total_cogs: r.rec.total_cogs, total_fee: r.rec.total_fee, net_profit: r.rec.net_profit, date: r.rec.date });
  sortable.sort((a, b) => {
    if (t._sort) { const d = compareVal(a[t._sort.key], b[t._sort.key]) * t._sort.dir; if (d) return d; }
    return 0;
  });
  const totalOrders = flat.length;
  $("outListHint").textContent = `共 ${totalOrders} 单，合并 ${rows.length} 行`;
  t.innerHTML = `<thead><tr>
    <th class="cb-col"><input type="checkbox" onclick="toggleAll(this,'out')" /></th>
    <th data-key="code">单号/批次${sortArrow("outTable", "code")}</th>
    <th data-key="customer">客户${sortArrow("outTable", "customer")}</th>
    <th>明细</th>
    <th data-key="total_amount" class="num">收入${sortArrow("outTable", "total_amount")}</th>
    <th data-key="total_cogs" class="num">成本${sortArrow("outTable", "total_cogs")}</th>
    <th data-key="total_fee" class="num">费用${sortArrow("outTable", "total_fee")}</th>
    <th data-key="net_profit" class="num">净利${sortArrow("outTable", "net_profit")}</th>
    <th data-key="date">日期${sortArrow("outTable", "date")}</th>
    <th>备注</th>
    <th></th></tr></thead><tbody>` +
    sortable.map((r) => r._group ? renderOutGroupRow(r.g) : renderOutRow(r.rec)).join("") + `</tbody>`;
  t._rows = sortable;
  t._render = loadOutbounds;
  updateBatchBar("out");
}
function renderOutRow(o) {
  const checked = outSel.has(o.id) ? "checked" : "";
  return `<tr>
      <td class="cb-col"><input type="checkbox" value="${o.id}" ${checked} onchange="toggleSel('out',${o.id},this.checked)" /></td>
      <td class="mono">${o.code}${payTag(o.pay_status)}${o.is_return ? ' <span class="badge expense">退货</span>' : ""}${o.has_dropship ? ' <span class="badge income">含代发</span>' : ""}</td>
      <td>${esc(o.customer) || "—"}</td>
      <td><button class="detail-toggle" onclick="toggleOutDetail(${o.id})">▸ 查看明细</button></td>
      <td class="num mono">${fmtMoney(o.final_amount != null ? o.final_amount : o.total_amount)}${o.adjust_amount ? `<div class="muted" style="font-size:11px;">调整 ${o.adjust_amount > 0 ? "+" : "-"}${fmtMoney(Math.abs(o.adjust_amount))}</div>` : ""}${o.settle_income ? `<div class="muted" style="font-size:11px;" title="客户随货款一起付的关联结算（${esc(settleCatsLabel(o.settle_cats))}）：成本里已含包材/快递，这里是客户付回来的那部分">含代收 ${fmtMoney(o.settle_income)}</div>` : ""}</td>
      <td class="num mono">${fmtMoney(o.total_cogs)}${o.brush_adjust ? `<div class="muted" style="font-size:11px;">刷单 ${fmtMoney(o.brush_adjust)}</div>` : ""}</td>
      <td class="num mono">${fmtMoney(o.total_fee)}</td>
      <td class="num mono" style="color:${o.net_profit >= 0 ? "var(--green)" : "var(--red)"}">${fmtMoney(o.net_profit)}</td>
      <td>${o.date}</td>
      <td class="muted" style="max-width:140px;">${renderRemarkHtml(o.remark)}</td>
      <td style="white-space:nowrap;">${o.is_return ? "" : `<button class="btn sm secondary" onclick="returnOutbound(${o.id})" title="把客户退回的货按原成本红冲回来">退货</button> `}<button class="btn sm secondary" onclick="editOutbound(${o.id})">改</button> <button class="btn sm danger" onclick="deleteOutbound(${o.id})">删</button></td></tr>
      <tr id="od-${o.id}" style="display:none;"><td colspan="11"><div class="subtable"><table>` +
      o.lines.map((l) => `<tr>
        <td>${esc(l.product_name)}${l.is_dropship ? ' <span class="badge income">代发</span>' : ""}${l.spec ? `<div class="muted" style="font-size:11px;">规格 ${esc(l.spec)}</div>` : ""}</td>
        <td>${o.is_return ? '<span class="badge expense">退货</span>' : (l.line_type === "sale" ? '<span class="badge out">销售</span>' : '<span class="badge pack">包装消耗</span>')}</td>
        <td>${fmtNum(l.quantity)} ${l.unit}</td>
        <td>= ${fmtNum(l.quantity_base)} ${l.base_unit || ""}</td>
        <td class="num">${fmtMoney(l.amount)}</td>
        <td class="num">成本 ${fmtMoney(l.cogs)}</td>
        <td class="num">${l.pack_fee ? "费 " + fmtMoney(l.pack_fee) : ""}</td>
      </tr>`).join("") + `</table></div></td></tr>`;
}
/* ---------- 销售退货（红冲）：退回的货按原单结转成本回补库存，收入/成本反向冲减 ---------- */
let RT_INFO = null;   // 当前退货弹窗的原单信息（行 + 已退 / 还能退）

async function returnOutbound(id) {
  let info;
  try { info = await api(`/api/outbounds/${id}/returnable`); }
  catch (e) { toast("读取可退信息失败：" + e.message); return; }
  const lines = info.lines || [];
  if (!lines.length) { toast("这张单没有可退货的销售行"); return; }
  RT_INFO = info;
  const rows = lines.map((l) => `
    <tr>
      <td>${esc(l.product_name)}${l.is_dropship ? ' <span class="badge income">代发</span>' : ""}${l.spec ? `<div class="muted" style="font-size:11px;">规格 ${esc(l.spec)}</div>` : ""}</td>
      <td class="num mono">${fmtNum(l.quantity)} ${esc(l.unit)}</td>
      <td class="num mono">${fmtMoney(l.unit_price)}</td>
      <td class="num mono">${l.returned ? fmtNum(l.returned) : "—"}</td>
      <td class="num mono">${fmtNum(l.remaining)} ${esc(l.unit)}</td>
      <td style="width:130px;"><input class="rt-qty" data-line="${l.line_id}" type="number" min="0" step="any"
          placeholder="0" oninput="rtCalc()" ${l.remaining <= 0 ? "disabled" : ""} /></td>
      <td class="num mono rt-amt" data-line="${l.line_id}">0.00</td>
    </tr>`).join("");
  const oldReturns = (info.returns || []).length
    ? `<div class="muted" style="font-size:12px;margin-top:6px;">已生成退货单：${info.returns.map((r) => `${esc(r.code)}（${esc(r.date)}，${fmtMoney(r.total_amount)}）`).join("、")}</div>`
    : "";
  openModal(`
    <h3>销售退货 · 红冲 <button class="close" onclick="closeModal()">✕</button></h3>
    <div class="muted" style="margin-bottom:10px;">
      原单 ${esc(info.code)} · 客户 ${esc(info.customer) || "—"} · ${esc(info.date)}<br>
      退回的货按原单结转成本重新入库；收入与成本按数量比例反向冲减，财务报表自动净额（收入减少、成本减少、库存回来）。
    </div>
    ${oldReturns}
    <div class="subtable" style="margin-top:8px;"><table>
      <thead><tr><th>商品</th><th class="num">原数量</th><th class="num">原单价</th><th class="num">已退</th><th class="num">还能退</th><th>本次退货</th><th class="num">退货金额</th></tr></thead>
      <tbody>${rows}</tbody>
    </table></div>
    <div class="form-grid" style="margin-top:12px;">
      <div class="field"><label>退货日期 *</label><input id="rtDate" type="date" value="${today()}" /></div>
      <div class="field"><label>备注 / 原因</label><input id="rtRemark" placeholder="如：客户用剩退回 / 质量问题" /></div>
    </div>
    <p class="hint" id="rtHint"></p>
    <div class="modal-foot">
      <button class="btn secondary" onclick="closeModal()">取消</button>
      <button class="btn danger" onclick="submitReturn(${id})">✓ 确认退货</button>
    </div>`);
  $("modalBox").classList.add("wide");
  rtCalc();
}

/** 退货数量变化 → 实时算退货金额 / 冲减成本（成本按原行 FIFO 结转单价折算） */
function rtCalc() {
  if (!RT_INFO) return;
  let amt = 0, cogs = 0;
  document.querySelectorAll("#modalBox .rt-qty").forEach((el) => {
    const lid = Number(el.dataset.line);
    const l = (RT_INFO.lines || []).find((x) => x.line_id === lid);
    if (!l) return;
    let q = parseFloat(el.value) || 0;
    if (q < 0) q = 0;
    if (q > l.remaining + 1e-9) { q = l.remaining; el.value = String(q); }
    const ratio = l.quantity ? q / l.quantity : 0;
    const a = (l.amount || 0) * ratio;
    const c = (l.cogs || 0) * ratio;
    amt += a; cogs += c;
    const cell = el.closest("tr").querySelector(".rt-amt");
    if (cell) cell.textContent = fmtMoney(a);
  });
  const hint = $("rtHint");
  if (hint) hint.innerHTML = `合计：退货金额 <b>¥${fmtMoney(amt)}</b>，冲减成本 <b>¥${fmtMoney(cogs)}</b>`
    + `（按原单结转成本），毛利反向 <b>¥${fmtMoney(amt - cogs)}</b>`;
}

async function submitReturn(id) {
  const date = $("rtDate").value;
  if (!date) { toast("请选择退货日期"); return; }
  const items = [];
  document.querySelectorAll("#modalBox .rt-qty").forEach((el) => {
    const q = parseFloat(el.value) || 0;
    if (q > 0) items.push({ line_id: Number(el.dataset.line), quantity: q });
  });
  if (!items.length) { toast("请填写要退货的数量"); return; }
  try {
    const r = await api(`/api/outbounds/${id}/return`, "POST",
      { items, date, remark: ($("rtRemark").value || "").trim() });
    RT_INFO = null;
    closeModal();
    toast(`已退货，生成红冲单 ${r.code}：收入 ${fmtMoney(r.total_amount)}，成本 ${fmtMoney(r.total_cogs)}`
      + `（库存已按原成本回补）`, 4200);
    loadOutbounds(); loadStock();
    if (typeof loadReport === "function") loadReport();
  } catch (e) { toast("退货失败：" + e.message); }
}

function buildOutGroup(recs) {
  const ids = recs.map((r) => r.id);
  const customers = [...new Set(recs.map((r) => r.customer).filter(Boolean))];
  const dates = recs.map((r) => r.date).sort();
  const products = new Set();
  recs.forEach((r) => r.lines.forEach((l) => { if (l.line_type === "sale") products.add(l.product_id); }));
  return {
    import_group: recs[0].import_group,
    ids,
    records: recs,
    orders: recs.length,
    customers,
    code: `批量 · ${recs.length}单`,
    customer: customers.join(" / ") || "—",
    date: dates[0] === dates[dates.length - 1] ? dates[0] : `${dates[0]} ~ ${dates[dates.length - 1]}`,
    total_amount: recs.reduce((s, r) => s + (r.final_amount != null ? r.final_amount : (r.total_amount || 0)), 0),
    total_cogs: recs.reduce((s, r) => s + (r.total_cogs || 0), 0),
    total_fee: recs.reduce((s, r) => s + (r.total_fee || 0), 0),
    // 芳谊放单仓刷单结算（非放单单为 0）：净利已扣掉它，列表里单独标一行便于核对
    brush_adjust: recs.reduce((s, r) => s + (r.brush_adjust || 0), 0),
    net_profit: recs.reduce((s, r) => s + (r.net_profit || 0), 0),
    products: products.size,
  };
}
function renderOutGroupRow(g) {
  const allChecked = g.ids.length && g.ids.every((id) => outSel.has(id));
  return `<tr>
      <td class="cb-col"><input type="checkbox" data-ids="${g.ids.join(",")}" ${allChecked ? "checked" : ""} onchange="toggleOutGroupCB(this)" /></td>
      <td class="mono" title="${esc(g.import_group)}">${esc(g.code)}</td>
      <td>${esc(g.customer)}</td>
      <td>
        <button class="detail-toggle" onclick="openOutGroup('${esc(g.import_group)}')">▸ 查看明细</button>
        <span class="muted" style="font-size:12px;margin-left:6px;">${g.products}种商品</span>
      </td>
      <td class="num mono">${fmtMoney(g.total_amount)}</td>
      <td class="num mono">${fmtMoney(g.total_cogs)}${g.brush_adjust ? `<div class="muted" style="font-size:11px;">刷单 ${fmtMoney(g.brush_adjust)}</div>` : ""}</td>
      <td class="num mono">${fmtMoney(g.total_fee)}</td>
      <td class="num mono" style="color:${g.net_profit >= 0 ? "var(--green)" : "var(--red)"}">${fmtMoney(g.net_profit)}</td>
      <td>${g.date}</td>
      <td class="muted" style="max-width:140px;">—</td>
      <td style="white-space:nowrap;"><button class="btn sm secondary" onclick="editOutboundInGroup('${esc(g.import_group)}')">改</button> <button class="btn sm danger" onclick="deleteOutGroupKeys(['${esc(g.import_group)}'])">删</button></td></tr>`;
}
/* 打开批次二级页 */
function openOutGroup(groupKey) {
  api(`/api/outbounds?g=${encodeURIComponent(groupKey)}`).then((rows) => {
    OUT_GROUP = rows.filter((r) => r.import_group === groupKey);
    if (!OUT_GROUP.length) { toast("未找到该批次"); return; }
    goPage("outgroup");
    renderOutGroup();
  }).catch((e) => toast("加载批次失败：" + e.message));
}
/* 批次二级页渲染 */
function specMerge(s) {
  if (!s) return "";
  return s.spec || "";
}
function packOwner(o, l, saleLines, ruleName) {
  // 单一销售商品：纸箱/人工归属该销售商品；多货组合：按规则组合聚合
  if (l.sale_product_id != null) {
    const sp = saleLines.find((x) => x.product_id === l.sale_product_id);
    const sname = l.sale_product_name || (sp && sp.product_name) || l.product_name;
    const sub = [ruleName ? `规则:${ruleName}` : "", specMerge(sp)].filter(Boolean).join(" · ");
    // 命中一单多货规则时，key 需带上规则，避免同一商品不同规则的箱号被聚到一行
    const ruleKey = ruleName ? `@@${o.pack_rule_id || ruleName}` : "";
    return { key: `sp${l.sale_product_id}${ruleKey}`, name: sname, sub };
  }
  if (ruleName) {
    const name = saleLines.map((s) => s.product_name).filter(Boolean).join(" + ") || ruleName;
    const detail = saleLines.map((s) => `${s.product_name}:${specMerge(s)}`).filter(Boolean).join("；");
    const sub = [ruleName ? `规则:${ruleName}` : "", detail].filter(Boolean).join(" · ");
    return { key: `rule${o.pack_rule_id || o.id}`, name, sub };
  }
  return { key: `p${l.product_id}`, name: l.product_name, sub: "" };
}
/* 逐行成本构成小字：商品成本/代发成本 ＋ 打包人工 ＋ 耗材 ＋ 其他关联结算 ＋ 快递费（有哪项列哪项）。
   后端把关联结算拆成 labor_cogs / material_cogs / other_cogs / express_cogs；
   拿不到拆分字段时（旧接口）退回「打包人工+耗材」合并展示。 */
function costSplitText(r) {
  const goods = Number(r.goods_cogs != null ? r.goods_cogs : (r.base_cogs != null ? r.base_cogs : r.cogs)) || 0;
  const express = Number(r.express_cogs) || 0;
  const oldPack = Number(r.pack_cogs) || 0;
  const split = r.labor_cogs != null || r.material_cogs != null || r.other_cogs != null;
  const labor = split ? (Number(r.labor_cogs) || 0) : 0;
  const material = split ? (Number(r.material_cogs) || 0) : 0;
  const other = split ? (Number(r.other_cogs) || 0) : 0;
  const brush = Number(r.brush_cogs) || 0;   // 芳谊放单仓刷单结算（分摊到该商品的部分）
  const brushFee = Number(r.brush_fee_cogs) || 0;    // 刷单单手填的「快递+包装固定费」
  const brushCost = Number(r.brush_cost_cogs) || 0;  // 刷单单手填的「刷单成本」
  const isWi = !!r.is_warehouse_in;   // 入仓行：material/express 字段装的是「包材/运费」，标签要换
  const fixed = Number(r.fixed_cogs) || 0;   // 入仓品固定成本（每袋打包费 / 难量化包材）
  // 刷单结算（芳谊放单仓，口径见 app/brush.py）：优先按「快递+包装固定费 / 刷单成本」两项拆开；
  // 同一商品可能既有真实出库又有刷单单，所以刷单只作为一个分项追加，不能提前 return。
  // 拆分字段拿不到时（旧数据/旧接口）兜底显示合计，否则整行成本构成小字会变成空串、什么都不显示。
  const brushParts = [];
  if (brush) {
    const shown = brushFee + brushCost;
    if (brushFee) brushParts.push(`快递+包装 ${fmtMoney(brushFee)}`);
    if (brushCost) brushParts.push(`刷单成本 ${fmtMoney(brushCost)}`);
    if (!shown) brushParts.push(`刷单结算 ${fmtMoney(brush)}`);
    else if (Math.abs(brush - shown) >= 0.01) brushParts.push(`刷单结算 ${fmtMoney(brush - shown)}`);
  }
  const parts = [];
  if (r.is_dropship || oldPack || express || labor || material || other || fixed) {
    parts.push(`${r.is_dropship ? "代发成本" : "商品成本"} ${fmtMoney(goods)}`);
    if (split) {
      if (labor) parts.push(`打包人工 ${fmtMoney(labor)}`);
      if (material) parts.push(`${isWi ? "包材" : "耗材"} ${fmtMoney(material)}`);
      if (other) parts.push(`其他关联结算 ${fmtMoney(other)}`);
    } else if (oldPack) {
      parts.push(`打包人工+耗材 ${fmtMoney(oldPack)}`);
    }
    if (express) parts.push(`${isWi ? "运费" : "快递费"} ${fmtMoney(express)}`);
    if (fixed) parts.push(`固定成本 ${fmtMoney(fixed)}`);
  }
  return parts.concat(brushParts).join(" ＋ ");
}
function outAggBy(rows, pool) {
  // pool='sale' 汇总销售商品；pool='pack' 汇总耗材/包装(不含人工)；pool='labor' 仅人工；
  // pool='laborpack' 人工+耗材，按「销售商品 / 规则组合」溯源展示。
  const isPackPool = pool === "pack";
  const map = new Map();
  const aggKey = (l) => `${l.product_id}@@${l.unit}`;
  for (const o of rows) {
    const saleLines = (o.lines || []).filter((l) => l.line_type === "sale");
    const ruleName = o.pack_rule_name || o.multi_rule || "";
    for (const l of o.lines) {
      const isLabor = !!l.is_labor; // 人工：category=人工 或 名称以「打包」结尾
      if (pool === "sale" && l.line_type !== "sale") continue;
      if (pool === "pack" && (l.line_type !== "pack" || isLabor)) continue; // 耗材：排除人工
      if (pool === "labor" && !(l.line_type === "pack" && isLabor)) continue; // 仅人工
      if (pool === "laborpack" && l.line_type !== "pack") continue; // 人工+耗材

      let k, name, sub, unit;
      if (pool === "sale" || isPackPool) {
        k = aggKey(l);
        name = l.product_name;
        sub = "";
        unit = l.unit;
      } else {
        const own = packOwner(o, l, saleLines, ruleName);
        k = own.key; name = own.name; sub = own.sub; unit = l.unit;
      }
      if (!map.has(k)) {
        map.set(k, {
          product_id: k, pid: l.product_id, name, sub, unit,
          orders: new Set(), qty: 0, qty_base: 0, amount: 0, cogs: 0, gross_sales: 0, boxes: new Set(), hasBox: false,
          dropship_qty: 0, is_dropship: false,
        });
      }
      const a = map.get(k);
      a.orders.add(o.id);
      a.qty += l.quantity || 0;
      a.qty_base += l.quantity_base || 0;
      a.amount += l.amount || 0;
      a.cogs += l.cogs || 0;
      a.gross_sales += (l.gross_sales || l.amount || 0);
      if (!a.sub && sub) a.sub = sub;
      // 代发：不扣本仓库存（成本为代发成本），标记出来供明细页区分与单独展示成本构成
      if (pool === "sale" && l.is_dropship) {
        a.is_dropship = true;
        a.dropship_qty += l.quantity || 0;
      }
      // 「打包人工+耗材」等池：收集该销售商品/规则组合命中的纸箱/耗材型号
      if (pool === "laborpack" && l.line_type === "pack" && !isLabor) {
        a.hasBox = true;
        a.boxes.add(l.product_name);
      }
    }
  }
  return [...map.values()].map((a) => {
    const boxes = [...a.boxes];
    if (a.hasBox && boxes.length) {
      const bx = boxes.join(" + ");
      a.subSub = a.sub ? `${a.sub} · 纸箱:${bx}` : `纸箱:${bx}`;
    }
    return { ...a, boxes, order_count: a.orders.size };
  });
}
function renderOutGroup() {
  if (!OUT_GROUP) return;
  const rows = OUT_GROUP;
  const kws = splitSearchKeywords($("ogSearch")?.value);
  const t = $("ogTable");
  // 销售商品可额外按出库方式筛：输入「代发」/「库存」即可筛出对应商品
  const kwHit = (a, extra = "") => searchHit(`${a.name} ${extra}`, kws);
  const aggSale = outAggBy(rows, "sale").filter((a) => kwHit(a, a.is_dropship ? "代发 外发" : "库存出库"));
  const aggPack = outAggBy(rows, "pack").filter((a) => kwHit(a));
  const aggLabor = outAggBy(rows, "labor").filter((a) => kwHit(a));
  const aggLaborPack = outAggBy(rows, "laborpack").filter((a) => kwHit(a, a.sub || ""));
  // 「销售商品」页签的成本需包含该商品关联的打包人工+耗材+快递费成本，否则毛利虚高：
  // 直接关联的打包行带 sale_product_id；一单多货或未回填的按该单销售金额比例分摊到销售商品。
  // 快递费（category=快递）单独归入 express_cogs，与打包人工+耗材分开展示。
  {
    const byPid = new Map();
    aggSale.forEach((a) => {
      a.pack_cogs = a.pack_cogs || 0;
      a.labor_cogs = a.labor_cogs || 0;      // 打包人工
      a.material_cogs = a.material_cogs || 0; // 包材/耗材
      a.other_cogs = a.other_cogs || 0;      // 其他关联结算
      a.express_cogs = a.express_cogs || 0;  // 快递费
      a.brush_cogs = a.brush_cogs || 0;      // 芳谊放单仓刷单结算（刷单成本 + 快递+包装固定费）
      a.brush_fee_cogs = a.brush_fee_cogs || 0;   // 其中：手填的「快递+包装固定费」
      a.brush_cost_cogs = a.brush_cost_cogs || 0; // 其中：手填的「刷单成本」
      a.settle_income = a.settle_income || 0; // 客户代收的关联结算（包材/人工/快递费，按销售金额占比分摊）

      let arr = byPid.get(a.pid);
      if (!arr) { arr = []; byPid.set(a.pid, arr); }
      arr.push(a);
    });
    const spread = (pid, amt, field) => {
      const arr = byPid.get(pid) || [];
      if (!arr.length) return;
      const each = amt / arr.length;
      arr.forEach((a) => { a[field] += each; });
    };
    // 关联结算行归类：快递 / 人工 / 耗材 / 其他（与后端 report.py 的 PACK_FIELD_OF_CAT 对齐）
    const packField = (l) => {
      if (l.category === "快递") return "express_cogs";
      if (l.is_labor) return "labor_cogs";
      if (["包材", "耗材", "包装"].includes(l.category)) return "material_cogs";
      return "other_cogs";
    };
    for (const o of rows) {
      const saleLines = (o.lines || []).filter((l) => l.line_type === "sale");
      const totalAmt = saleLines.reduce((s, l) => s + (l.amount || 0), 0);
      const unowned = [];
      for (const l of o.lines || []) {
        if (l.line_type !== "pack") continue;
        if (l.sale_product_id == null) { unowned.push(l); continue; }
        spread(l.sale_product_id, l.cogs || 0, packField(l));
      }
      if (unowned.length && saleLines.length) {
        for (const l of unowned) {
          for (const sl of saleLines) {
            const share = totalAmt ? (sl.amount || 0) / totalAmt : 1 / saleLines.length;
            spread(sl.product_id, (l.cogs || 0) * share, packField(l));
          }
        }
      }
      // 芳谊放单仓刷单结算：整单金额按该单销售金额占比分摊到商品上（与后端 report.py 同口径）
      // 同时把「快递+包装固定费」和「刷单成本」分别摊出去，批次明细里能分开看到这两项
      if (o.brush_adjust && saleLines.length) {
        for (const sl of saleLines) {
          const share = totalAmt ? (sl.amount || 0) / totalAmt : 1 / saleLines.length;
          spread(sl.product_id, (o.brush_adjust || 0) * share, "brush_cogs");
          spread(sl.product_id, (o.brush_fee || 0) * share, "brush_fee_cogs");
          spread(sl.product_id, (o.brush_cost || 0) * share, "brush_cost_cogs");
        }
      }
      // 客户代收的关联结算（包材/人工/快递费）：同样按销售金额占比分摊，商品毛利算上它（与后端同口径）
      if (o.settle_income && saleLines.length) {
        for (const sl of saleLines) {
          const share = totalAmt ? (sl.amount || 0) / totalAmt : 1 / saleLines.length;
          spread(sl.product_id, (o.settle_income || 0) * share, "settle_income");
        }
      }
    }
    aggSale.forEach((a) => {
      a.pack_cogs = a.labor_cogs + a.material_cogs + a.other_cogs;
      a.base_cogs = a.cogs;
      a.cogs = a.cogs + a.pack_cogs + a.express_cogs + a.brush_cogs;
    });
  }
  const total = {
    // 收入含客户代收的关联结算（包材/人工/快递费），与出库单「实收金额」、报表收入同口径
    amt: rows.reduce((s, o) => s + (o.total_amount || 0) + (o.settle_income || 0), 0),
    cogs: rows.reduce((s, o) => s + (o.total_cogs || 0), 0),
    fee: rows.reduce((s, o) => s + (o.total_fee || 0), 0),
    // 芳谊放单仓刷单结算：净利里已扣掉，拆成「快递+包装固定费」与「刷单成本」两项便于核对
    brush: rows.reduce((s, o) => s + (o.brush_adjust || 0), 0),
    brushFee: rows.reduce((s, o) => s + (o.brush_fee || 0), 0),
    brushCost: rows.reduce((s, o) => s + (o.brush_cost || 0), 0),
  };
  const net = total.amt - total.cogs - total.fee - total.brush;
  $("ogTitle").textContent = `出库批次明细（${rows.length} 单）`;
  $("ogHint").textContent = "按商品聚合展示每种商品的单数/数量/金额或成本，可搜索、排序；耗材、人工、打包人工+耗材分开页签展示。";
  $("ogDelCount").textContent = rows.length;
  $("ogSummary").innerHTML =
    `<div class="stat"><div class="label">批次单数</div><div class="value">${rows.length}</div></div>
     <div class="stat"><div class="label">销售商品种数</div><div class="value">${outAggBy(rows, "sale").length}</div></div>
     <div class="stat"><div class="label">耗材种数</div><div class="value">${outAggBy(rows, "pack").length}</div></div>
     <div class="stat"><div class="label">人工种数</div><div class="value">${outAggBy(rows, "labor").length}</div></div>
     <div class="stat"><div class="label">销售收入</div><div class="value">${fmtMoney(total.amt)}</div></div>
     <div class="stat"><div class="label">结转成本</div><div class="value">${fmtMoney(total.cogs)}</div></div>
     ${total.brushFee ? `<div class="stat"><div class="label">快递+包装</div><div class="value" style="color:var(--red)">${fmtMoney(total.brushFee)}</div></div>` : ""}
     ${total.brushCost ? `<div class="stat"><div class="label">刷单成本</div><div class="value" style="color:var(--red)">${fmtMoney(total.brushCost)}</div></div>` : ""}
     <div class="stat success"><div class="label">净利</div><div class="value" style="color:${net >= 0 ? "var(--green)" : "var(--red)"}">${fmtMoney(net)}</div></div>`;
  const seg = segActive("ogSeg");
  let isSale = false, isLaborPack = false, emptyText = "无记录";
  let data;
  if (seg === "og-sale") { isSale = true; data = aggSale; emptyText = "无销售商品"; }
  else if (seg === "og-labor") { data = aggLabor; emptyText = "无人工记录"; }
  else if (seg === "og-laborpack") { isLaborPack = true; data = aggLaborPack; emptyText = "无打包人工/耗材记录"; }
  else { data = aggPack; emptyText = "无耗材/包装记录"; }
  data = data.map((a) => {
    const settle = Number(a.settle_income) || 0;   // 客户代收的关联结算（成本里含它，收入也要含）
    a.settle_income = settle;
    const gp = (a.amount + settle - a.cogs) || 0;
    const denom = (a.gross_sales || a.amount || 0) + settle; // 扣点前销售金额 + 代收
    a.splitText = isSale ? costSplitText(a) : "";  // 代发成本/商品成本 ＋ 打包人工 ＋ 耗材 ＋ 快递费
    const gp_rate = denom ? (gp / denom) * 100 : 0; // 毛利率 = 毛利 / （扣点前销售金额 + 代收）
    return { ...a, gp, gp_rate };
  });
  if (t._sort) data = data.slice().sort((a, b) => compareVal(a[t._sort.key], b[t._sort.key]) * t._sort.dir);
  const colSpan = isSale ? 8 : (isLaborPack ? 3 : 5);
  t.innerHTML = `<thead><tr>
    <th data-key="name">商品${sortArrow("ogTable", "name")}</th>
    <th data-key="order_count" class="num">单数${sortArrow("ogTable", "order_count")}</th>
    ${isLaborPack ? "" : `<th>单位</th>`}
    ${isLaborPack ? "" : `<th data-key="qty" class="num">${isSale ? "总数量" : "数量"}${sortArrow("ogTable", "qty")}</th>`}
    ${isSale ? `<th data-key="amount" class="num">金额${sortArrow("ogTable", "amount")}</th>` : ""}
    <th data-key="cogs" class="num">成本${sortArrow("ogTable", "cogs")}</th>
    ${isSale ? `<th data-key="gp" class="num">毛利${sortArrow("ogTable", "gp")}</th>` : ""}
    ${isSale ? `<th data-key="gp_rate" class="num">毛利率${sortArrow("ogTable", "gp_rate")}</th>` : ""}
  </tr></thead><tbody>` +
    (data.length ? data.map((a) => `<tr>
      <td>${esc(a.name)}${(a.subSub || a.sub) ? `<div class="muted" style="font-size:12px;font-weight:normal;">${esc(a.subSub || a.sub)}</div>` : ""}${a.splitText ? `<div class="muted" style="font-size:11px;color:var(--danger);">${a.splitText}</div>` : ""}</td>
      <td class="num">${a.order_count} 单</td>
      ${isLaborPack ? "" : `<td>${esc(a.unit)}</td>`}
      ${isLaborPack ? "" : `<td class="num mono">${fmtNum(a.qty)}</td>`}
      ${isSale ? `<td class="num mono">${fmtMoney(a.amount + (a.settle_income || 0))}${a.settle_income ? `<div class="muted" style="font-size:11px;">含代收 ${fmtMoney(a.settle_income)}</div>` : ""}</td>` : ""}
      <td class="num mono">${fmtMoney(a.cogs)}</td>
      ${isSale ? `<td class="num mono" style="color:${a.gp >= 0 ? "var(--green)" : "var(--red)"}">${fmtMoney(a.gp)}</td>` : ""}
      ${isSale ? `<td class="num mono">${(a.gp_rate || 0).toFixed(1)}%</td>` : ""}
    </tr>`).join("")
      : `<tr><td colspan="${colSpan}" class="muted">${emptyText}</td></tr>`) + `</tbody>`;
  // 点击表头排序
  t._rows = data;
  t._render = function () { renderOutGroup(); };
}
function segActive(segId) {
  const b = $(segId) && $(segId).querySelector(".seg-item.active");
  return b ? b.dataset.panel : "";
}
function switchOgSeg(btn) {
  const seg = btn.closest(".seg");
  if (!seg) return;
  seg.querySelectorAll(".seg-item").forEach((x) => x.classList.remove("active"));
  btn.classList.add("active");
  renderOutGroup();
}
async function deleteOutGroup() {
  if (!OUT_GROUP || !OUT_GROUP.length) return;
  deleteOutGroupKeys([OUT_GROUP[0].import_group]);
}
async function deleteOutGroupKeys(groupKeys) {
  // 通过 batch 接口删除整批
  try {
    const all = await api(`/api/outbounds?g=${groupKeys.map(encodeURIComponent).join(",")}`);
    const want = all.filter((r) => groupKeys.includes(r.import_group)).map((r) => r.id);
    if (!want.length) { toast("未找到该批次"); return; }
    if (!(await uiConfirm(`确认删除该批次 ${want.length} 张出库单？将回退库存、成本与财务记录。`))) return;
    const r = await api("/api/outbounds/batch-delete", "POST", { ids: want });
    toast(`已删除 ${r.deleted} 张出库单`);
    loadOutbounds(); loadStock();
  } catch (e) { toast("删除失败：" + e.message); }
}
function toggleOutDetail(id) {
  const tr = $("od-" + id);
  const btn = tr.previousElementSibling.querySelector(".detail-toggle");
  if (tr.style.display === "none") { tr.style.display = ""; btn.textContent = "▾ 收起明细"; }
  else { tr.style.display = "none"; btn.textContent = "▸ 查看明细"; }
}
async function deleteOutbound(id) {
  if (!(await uiConfirm("确认删除该出库单？将回退库存、成本与财务记录。"))) return;
  try { await api("/api/outbounds/" + id, "DELETE"); toast("已删除"); loadOutbounds(); loadStock(); }
  catch (e) { toast("删除失败：" + e.message); }
}
/* 在出库主列表（单条行或批次成员）里按 id 找单据 */
function findOutbound(id) {
  for (const x of ($("outTable")._rows || [])) {
    if (!x._group && x.rec && x.rec.id === id) return x.rec;
    if (x._group && x.g && x.g.records) {
      const hit = x.g.records.find((o) => o.id === id);
      if (hit) return hit;
    }
  }
  if (OUT_GROUP) { const hit = OUT_GROUP.find((o) => o.id === id); if (hit) return hit; }
  return null;
}
/* 批次行改单：先列出该批次内的单据，再选一条改 */
function editOutboundInGroup(groupKey) {
  const row = ($("outTable")._rows || []).find((x) => x._group && x.g && x.g.import_group === groupKey);
  const recs = row && row.g.records ? row.g.records : [];
  if (!recs.length) { toast("未找到该批次单据，请刷新列表"); return; }
  openModal(`
    <h3>选择要修改的出库单 <button class="close" onclick="closeModal()">✕</button></h3>
    <div class="muted" style="margin-bottom:10px;">批次 ${esc(groupKey)} · 共 ${recs.length} 单（可改 客户 / 出库日期 / 付款状态，或对某单做销售退货）</div>
    <div style="max-height:50vh;overflow:auto;">
      <table class="table"><thead><tr><th>单号</th><th>客户</th><th class="num">金额</th><th>日期</th><th></th></tr></thead><tbody>
      ${recs.map((o) => `<tr>
        <td class="mono">${esc(o.code)}${payTag(o.pay_status)}${o.is_return ? ' <span class="badge expense">退货</span>' : ""}</td>
        <td>${esc(o.customer) || "—"}</td>
        <td class="num mono">${fmtMoney(o.final_amount != null ? o.final_amount : o.total_amount)}</td>
        <td>${esc(o.date)}</td>
        <td style="white-space:nowrap;">${o.is_return ? "" : `<button class="btn sm secondary" onclick="returnOutbound(${o.id})">退货</button> `}<button class="btn sm secondary" onclick="editOutbound(${o.id})">改</button></td>
      </tr>`).join("")}
      </tbody></table>
    </div>
    <div class="modal-foot"><button class="btn secondary" onclick="closeModal()">关闭</button></div>`);
}
/* 手动修改出库单：只允许改 客户 / 出库日期 / 付款状态；保存后操作员记为修改人 */
function editOutbound(id) {
  const o = findOutbound(id);
  if (!o) { toast("未找到该出库单，请刷新列表"); return; }
  const cats = String(o.settle_cats || "").split(",").filter(Boolean);
  const box = (key) => `<label class="field-inline" style="display:inline-flex;align-items:center;gap:6px;">
      <input type="checkbox" class="ed-out-settle" value="${key}" ${cats.includes(key) ? "checked" : ""} /> ${SETTLE_LABEL[key]}
    </label>`;
  openModal(`
    <h3>修改出库单 <button class="close" onclick="closeModal()">✕</button></h3>
    <div class="muted" style="margin-bottom:12px;">
      ${esc(o.code)} · 销售收入 ${fmtMoney(o.total_amount)}${o.adjust_amount ? `（调整 ${o.adjust_amount > 0 ? "+" : "-"}${fmtMoney(Math.abs(o.adjust_amount))}）` : ""}
      ${o.settle_income ? ` · 客户代收 ${fmtMoney(o.settle_income)}` : ""} · 实收 ${fmtMoney(o.final_amount != null ? o.final_amount : o.total_amount)}
    </div>
    <div class="form-grid">
      <div class="field"><label>客户</label><input id="edOutCustomer" value="${esc(o.customer || "")}" placeholder="客户名称" /></div>
      <div class="field"><label>出库日期 *</label><input id="edOutDate" type="date" value="${esc(o.date || "")}" /></div>
      <div class="field" style="grid-column:1/-1;">
        <label>付款状态</label>
        ${payRadios("edOutPay", o.pay_status, "待付款：先进「待付款账单」，点「已支付」后才计入财务报表")}
      </div>
      <div class="field" style="grid-column:1/-1;">
        <label>实收金额包含（客户随货款一起付的关联结算）</label>
        <div class="toolbar" style="margin:0;flex-wrap:wrap;gap:14px;">
          ${box("material")}${box("labor")}${box("express")}
        </div>
        <div class="field-hint">改这里只影响「实收金额」与报表收入（实收 = 货款 + 调整 + 勾选项金额），成本与库存不变。</div>
      </div>
    </div>
    <p class="hint">以上四项可改；保存后操作员记为当前登录账号（${esc(operatorName())}）。商品 / 数量 / 价格如需更正，请删除后重新出库。</p>
    <div class="modal-foot">
      <button class="btn secondary" onclick="closeModal()">取消</button>
      <button class="btn green" onclick="saveOutboundEdit(${id})">✓ 保存</button>
    </div>`);
}
async function saveOutboundEdit(id) {
  const date = $("edOutDate").value;
  if (!date) { toast("请选择出库日期"); return; }
  const settle_cats = [...document.querySelectorAll(".ed-out-settle")].filter((x) => x.checked).map((x) => x.value);
  try {
    await api(`/api/outbounds/${id}`, "PUT", {
      customer: $("edOutCustomer").value, date, pay_status: payOf("edOutPay"), settle_cats,
    });
    closeModal();
    toast(`已保存，操作员记为 ${operatorName()}`);
    loadOutbounds();
  } catch (e) { toast("保存失败：" + e.message); }
}

/* =============== 批量操作 =============== */
async function batchDeleteProducts() {
  if (!prodSel.size) return;
  if (!(await uiConfirm(`确认删除选中的 ${prodSel.size} 个商品？已有出入库记录、被其他商品关联的商品将自动跳过。`))) return;
  try {
    const r = await api("/api/products/batch-delete", "POST", { ids: [...prodSel] });
    prodSel.clear();
    PRODUCTS = await api("/api/products");
    renderProducts();
    // 被拦下的一定要弹窗说清「被谁引用」，否则用户只知道「删不掉」
    const blocked = r.blocked_items || (r.blocked || []).map((n) => ({ name: n, sources: [] }));
    if (!blocked.length) { toast(`已删除 ${r.deleted} 个商品`); return; }
    const shown = blocked.slice(0, 20);
    const lines = shown.map((b) =>
      "- " + b.name + (b.sources && b.sources.length ? "：" + b.sources.join("；") : ""));
    showDeleteBlocked("商品",
      `已删除 ${r.deleted} 个，以下 ${blocked.length} 个仍被引用已跳过${blocked.length > shown.length ? `（只列前 ${shown.length} 个）` : ""}：\n`
      + lines.join("\n"));
  } catch (e) { toast("批量删除失败：" + e.message); }
}
function openBatchProductModal() {
  if (!prodSel.size) return;
  openModal(`
    <h3>批量修改属性（${prodSel.size} 个商品） <button class="close" onclick="closeModal()">✕</button></h3>
    <p class="hint" style="margin-bottom:12px;">仅修改填写的项，留空表示不修改。适合：把选中商品统一改分类、启用/停用等。</p>
    <div class="form-grid">
      <div class="field"><label>修改分类</label><input id="bpCategory" placeholder="如：蔬菜 / 干货 / 包材，留空不改" /></div>
      <div class="field"><label>状态</label><select id="bpActive"><option value="">保持不变</option><option value="1">启用</option><option value="0">停用</option></select></div>
      <div class="field"><label>参考成本（元/基础单位）</label><input id="bpCost" type="number" step="any" placeholder="留空不改" /><div class="field-hint">批量改价只能按基础单位算（重量类 = 元/克，计数类 = 元/个）；单个商品的价建议在商品编辑页按默认单位填</div></div>
      <div class="field"><label>默认售价（元/基础单位）</label><input id="bpPrice" type="number" step="any" placeholder="留空不改" /></div>
      <div class="field"><label>打包费（元/单）</label><input id="bpFee" type="number" step="any" placeholder="留空不改" /></div>
    </div>
    <div class="modal-foot">
      <button class="btn secondary" onclick="closeModal()">取消</button>
      <button class="btn" onclick="submitBatchProduct()">确认修改</button>
    </div>`);
}
async function submitBatchProduct() {
  const payload = { ids: [...prodSel] };
  const cat = $("bpCategory").value.trim();
  const act = $("bpActive").value;
  if (cat) payload.category = cat;
  if (act !== "") payload.is_active = act === "1";
  const cost = parseFloat($("bpCost").value);
  const price = parseFloat($("bpPrice").value);
  const fee = parseFloat($("bpFee").value);
  if (!isNaN(cost)) payload.unit_cost = cost;
  if (!isNaN(price)) payload.sale_price = price;
  if (!isNaN(fee)) payload.pack_fee = fee;
  if (Object.keys(payload).length <= 1) { toast("请至少填写一项要修改的属性"); return; }
  try {
    const r = await api("/api/products/batch-update", "POST", payload);
    closeModal(); prodSel.clear();
    PRODUCTS = await api("/api/products");
    renderProducts();
    toast(`已修改 ${r.updated} 个商品`);
  } catch (e) { toast("批量修改失败：" + e.message); }
}
/* ---------- 复制商品到其他分仓 ---------- */
async function openCopyToWarehouseModal() {
  if (!prodSel.size) { toast("请先勾选要复制的商品"); return; }
  let whs = [];
  try {
    const r = await api("/api/warehouses");
    whs = (r.warehouses || []).filter((w) => !w.is_current);
  } catch (e) { toast("读取分仓列表失败：" + e.message); return; }
  if (!whs.length) { toast("没有其他分仓可复制"); return; }
  openModal(`
    <h3>复制商品到其他仓（${prodSel.size} 个） <button class="close" onclick="closeModal()">✕</button></h3>
    <p class="hint" style="margin-bottom:12px;">把选中商品的资料复制到目标仓；目标仓已有同名商品会直接复用，不会覆盖。库存数量、均价与出入库历史不复制（但参考成本会带过去，没手填时取源仓库存均价，保证目标仓出库能算出成本）。</p>
    <div class="form-grid">
      <div class="field"><label>目标分仓</label>
        <select id="cpTargetWh">${whs.map((w) => `<option value="${esc(w.key)}">${esc(w.name)}（${esc(w.key)}）</option>`).join("")}</select>
      </div>
      <div class="field"><label>复制范围</label>
        <label style="display:flex;gap:6px;align-items:center;"><input type="checkbox" id="cpDeps" checked/> 同时复制关联商品（包材 / 人工 / 库存大类）</label>
        <div class="field-hint">不勾选时，目标仓缺少的关联商品会被丢弃，订单商品的关联结算 / 扣减库存可能不完整。</div>
      </div>
      <div class="field"><label>复制后</label>
        <label style="display:flex;gap:6px;align-items:center;"><input type="checkbox" id="cpDisable"/> 在当前仓停用选中的商品</label>
        <div class="field-hint">适合把某个商品的经营从当前仓迁到目标仓。</div>
      </div>
    </div>
    <div class="modal-foot">
      <button class="btn secondary" onclick="closeModal()">取消</button>
      <button class="btn" onclick="submitCopyToWarehouse()">开始复制</button>
    </div>`);
}
async function submitCopyToWarehouse() {
  const target = $("cpTargetWh").value;
  if (!target) { toast("请选择目标分仓"); return; }
  const payload = {
    target_wh: target,
    ids: [...prodSel],
    include_dependencies: $("cpDeps").checked,
    disable_source: $("cpDisable").checked,
  };
  try {
    const r = await api("/api/products/copy-to-warehouse", "POST", payload);
    closeModal();
    prodSel.clear();
    PRODUCTS = await api("/api/products");
    renderProducts();
    showCopyResult(r);
  } catch (e) { toast("复制失败：" + e.message); }
}
function showCopyResult(r) {
  const created = r.created || [];
  const mapped = r.mapped || [];
  const mainCreated = created.filter((x) => x.is_main).length;
  const depCreated = created.length - mainCreated;
  const mainMapped = mapped.filter((x) => x.is_main).length;
  const depMapped = mapped.length - mainMapped;
  const lines = [];
  if (mainCreated) lines.push(`新建 ${mainCreated} 个商品`);
  if (depCreated) lines.push(`新建 ${depCreated} 个关联商品（包材 / 人工 / 库存大类）`);
  if (mainMapped) lines.push(`复用目标仓已有同名商品 ${mainMapped} 个`);
  if (depMapped) lines.push(`复用目标仓已有同名关联商品 ${depMapped} 个`);
  if ((r.disabled || []).length) lines.push(`已在当前仓停用 ${r.disabled.length} 个商品`);
  const skipped = r.skipped || [];
  const warnings = r.warnings || [];
  openModal(`
    <h3>复制完成 <button class="close" onclick="closeModal()">✕</button></h3>
    <p class="hint">从「${esc(r.source.name)}」复制到「${esc(r.target.name)}」</p>
    ${lines.length ? `<ul class="copy-result" style="margin:10px 0 14px 20px;line-height:1.9;">${lines.map((x) => `<li>${esc(x)}</li>`).join("")}</ul>` : ""}
    ${skipped.length ? `<div class="alert warn" style="margin-bottom:10px;">${skipped.length} 个关联商品未复制：${esc(skipped.slice(0, 6).map((x) => x.name).join("、"))}${skipped.length > 6 ? "…" : ""}</div>` : ""}
    ${warnings.length ? `<div class="alert warn" style="margin-bottom:10px;">${warnings.slice(0, 6).map((x) => esc(x)).join("<br>")}${warnings.length > 6 ? "<br>…" : ""}</div>` : ""}
    <div class="modal-foot"><button class="btn" onclick="closeModal()">知道了</button></div>`);
}

/* ---------- 转移商品与库存到其他分仓 ---------- */
/* 选中的商品里「真正要搬库存」的那些：库存商品取它自己，订单商品取它扣减的库存大类
   （订单商品自己不存库存，账记在大类上）。关联结算清单里的包材 / 人工只复制资料，
   库存留在原仓——各仓共用的耗材不该被一起搬空。 */
function transferStockTargets(picks) {
  const ids = new Set();
  picks.forEach((p) => {
    if (p.product_type === "stock") { ids.add(p.id); return; }
    prodSchemes(p).forEach((s) => (s.links || []).forEach((l) => l && l.product_id && ids.add(l.product_id)));
  });
  return [...ids].map((id) => PRODUCTS.find((x) => x.id === id)).filter(Boolean);
}
function transferPreviewHtml(picks) {
  const list = transferStockTargets(picks);
  const moving = list.filter((p) => Number(p.stock) > 1e-6);
  const neg = list.filter((p) => Number(p.stock) < -1e-6);
  if (!moving.length && !neg.length) {
    return `<div class="field"><label>将要转移的库存</label>
      <div class="field-hint">当前仓这些商品没有库存（0），这次只复制资料。</div></div>`;
  }
  const rows = moving.map((p) =>
    `<li>${esc(p.name)}：${fmtStock(p)}，结转价值 ${fmtMoney(p.stock_value)}</li>`).join("");
  const negRows = neg.map((p) =>
    `<li>${esc(p.name)}：${fmtStock(p)} <span class="badge off">负库存</span> 不转移，只在原仓盘盈归零</li>`).join("");
  return `<div class="field"><label>将要转移的库存（${moving.length} 项）</label>
    <ul style="margin:4px 0 0 18px;line-height:1.8;max-height:160px;overflow:auto;">${rows}${negRows}</ul>
    <div class="field-hint">按原仓的库存结存成本一起转过去，两仓合计的数量与货值不变。</div></div>`;
}
async function openTransferToWarehouseModal() {
  if (!prodSel.size) { toast("请先勾选要转移的商品"); return; }
  let whs = [];
  try {
    const r = await api("/api/warehouses");
    whs = (r.warehouses || []).filter((w) => !w.is_current);
  } catch (e) { toast("读取分仓列表失败：" + e.message); return; }
  if (!whs.length) { toast("没有其他分仓可转移"); return; }
  const picks = PRODUCTS.filter((p) => prodSel.has(p.id));
  openModal(`
    <h3>转移商品与库存到其他仓（${prodSel.size} 个） <button class="close" onclick="closeModal()">✕</button></h3>
    <p class="hint" style="margin-bottom:12px;">把选中商品的资料复制到目标仓，同时把当前仓的库存按结存成本一起转过去：原仓库存清零，目标仓按同成本入账。适合「这个商品以后不在本仓做了，整个挪过去」。</p>
    <div class="form-grid">
      <div class="field"><label>目标分仓</label>
        <select id="tfTargetWh">${whs.map((w) => `<option value="${esc(w.key)}">${esc(w.name)}（${esc(w.key)}）</option>`).join("")}</select>
      </div>
      <div class="field"><label>复制范围</label>
        <label style="display:flex;gap:6px;align-items:center;"><input type="checkbox" id="tfDeps" checked/> 同时复制关联商品（包材 / 人工 / 库存大类）</label>
        <div class="field-hint">不勾选时，目标仓缺少的关联商品会被丢弃，订单商品的关联结算 / 扣减库存可能不完整。</div>
      </div>
      <div class="field"><label>转移后</label>
        <label style="display:flex;gap:6px;align-items:center;"><input type="checkbox" id="tfStock" checked/> 把当前库存一起转过去</label>
        <label style="display:flex;gap:6px;align-items:center;"><input type="checkbox" id="tfDisable" checked/> 在当前仓停用这些商品（含库存被搬走的库存大类）</label>
        <div class="field-hint">库存搬空后原仓商品停用，避免再被出库扣一次；目标仓继续正常经营。</div>
      </div>
      ${transferPreviewHtml(picks)}
    </div>
    <div class="modal-foot">
      <button class="btn secondary" onclick="closeModal()">取消</button>
      <button class="btn" onclick="submitTransferToWarehouse()">开始转移</button>
    </div>`);
}
async function submitTransferToWarehouse() {
  const target = $("tfTargetWh").value;
  if (!target) { toast("请选择目标分仓"); return; }
  if (!(await uiConfirm("确认把选中的商品连同库存转移到目标仓？原仓库存会清零，转移后不会自动回退。"))) return;
  const payload = {
    target_wh: target,
    ids: [...prodSel],
    include_dependencies: $("tfDeps").checked,
    transfer_stock: $("tfStock").checked,
    disable_source: $("tfDisable").checked,
  };
  let r = null;
  try {
    r = await api("/api/products/transfer-to-warehouse", "POST", payload);
  } catch (e) { toast("转移失败：" + e.message); return; }
  closeModal();
  prodSel.clear();
  try { await loadStock(); } catch (e) { /* 刷新失败不影响结果展示 */ }
  renderProducts();
  showTransferResult(r);
}
function showTransferResult(r) {
  const moved = r.stock_moved || [];
  const zeroed = r.stock_zeroed || [];
  const disabled = r.disabled || [];
  const stockDisabled = r.stock_disabled || [];
  const skipped = r.skipped || [];
  const warnings = r.warnings || [];
  const lines = [];
  if ((r.created || []).length) lines.push(`在「${r.target.name}」新建 ${r.created.length} 个商品`);
  if ((r.mapped || []).length) lines.push(`复用目标仓已有同名商品 ${r.mapped.length} 个`);
  if (disabled.length) lines.push(`已在原仓停用 ${disabled.length} 个选中商品`);
  if (stockDisabled.length) lines.push(`库存已搬走，另停用 ${stockDisabled.length} 个关联库存大类`);
  const movedRows = moved.map((x) => `<tr>
      <td>${esc(x.name)}</td>
      <td class="num mono">${fmtNum(x.quantity)} ${esc(x.unit)}</td>
      <td class="num mono">${fmtMoney(x.value)}</td></tr>`).join("");
  const zeroRows = zeroed.map((x) =>
    `<li>${esc(x.name)}：原 ${fmtNum(x.quantity)} ${esc(x.unit)}，不转移，原仓已盘盈归零</li>`).join("");
  openModal(`
    <h3>转移完成 <button class="close" onclick="closeModal()">✕</button></h3>
    <p class="hint">从「${esc(r.source.name)}」转到「${esc(r.target.name)}」，库存流水日期 ${esc(r.date)}</p>
    ${lines.length ? `<ul style="margin:10px 0 6px 20px;line-height:1.9;">${lines.map((x) => `<li>${esc(x)}</li>`).join("")}</ul>` : ""}
    ${movedRows ? `<div class="table-wrap"><table>
        <thead><tr><th>商品</th><th class="num">转移库存</th><th class="num">结转价值</th></tr></thead>
        <tbody>${movedRows}</tbody></table></div>` : '<div class="alert warn" style="margin-bottom:10px;">这次没有转移库存（未勾选「把当前库存一起转过去」，或原仓库存为 0）</div>'}
    ${zeroRows ? `<div class="alert warn" style="margin:10px 0;">负库存未转移（只在原仓归零）：<ul style="margin:6px 0 0 18px;line-height:1.8;">${zeroRows}</ul></div>` : ""}
    ${skipped.length ? `<div class="alert warn" style="margin-bottom:10px;">${skipped.length} 个关联商品未复制：${esc(skipped.slice(0, 6).map((x) => x.name).join("、"))}${skipped.length > 6 ? "…" : ""}</div>` : ""}
    ${warnings.length ? `<div class="alert warn" style="margin-bottom:10px;">${warnings.slice(0, 6).map((x) => esc(x)).join("<br>")}${warnings.length > 6 ? "<br>…" : ""}</div>` : ""}
    <div class="modal-foot"><button class="btn" onclick="closeModal()">知道了</button></div>`);
}

async function batchDeleteInbounds() {
  if (!inSel.size) return;
  if (!(await uiConfirm(`确认删除选中的 ${inSel.size} 条入库单？将回退库存与成本。`))) return;
  try {
    const r = await api("/api/inbounds/batch-delete", "POST", { ids: [...inSel] });
    inSel.clear();
    loadInbounds(); loadStock();
    toast(`已删除 ${r.deleted} 条入库单`);
  } catch (e) { toast("批量删除失败：" + e.message); }
}
async function batchDeleteOutbounds() {
  if (!outSel.size) return;
  if (!(await uiConfirm(`确认删除选中的 ${outSel.size} 张出库单？将回退库存、成本与财务记录。`))) return;
  try {
    const r = await api("/api/outbounds/batch-delete", "POST", { ids: [...outSel] });
    outSel.clear();
    loadOutbounds(); loadStock();
    toast(`已删除 ${r.deleted} 张出库单`);
  } catch (e) { toast("批量删除失败：" + e.message); }
}

