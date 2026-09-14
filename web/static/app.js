/* 企业台账系统 - 前端逻辑 */
let PRODUCTS = [];
let UNITS = [];
let CURRENT_USER = null;
let MP_CODES = [];  // 聚水潭解析出的编码列表
let MAPPINGS = null;  // 聚水潭关联明细 { summary, items }

/* 批量选择状态 */
const prodSel = new Set();
const inSel = new Set();
const outSel = new Set();
const prSel = new Set();  // 一单多货批量选择
const winSel = new Set(); // 入仓记录批量选择
let OUT_GROUP = null;  // 当前打开的出库批次（array of Outbound 记录）
let WGROUP = null;     // 当前打开的入仓批次（array of WarehouseIn 记录）
let WIN_DEDUCT = 0;    // 入仓品扣点%（在「扣点」页统一维护）

/* ---------- 批量选择工具 ---------- */
function selSet(kind) {
  return kind === "prod" ? prodSel : kind === "in" ? inSel : kind === "out" ? outSel
    : kind === "win" ? winSel : prSel;
}
function selBarId(kind) {
  return kind === "prod" ? "prodBatch" : kind === "in" ? "inBatch" : kind === "out" ? "outBatch"
    : kind === "win" ? "wInBatch" : "prBatch";
}
function selCountId(kind) {
  return kind === "prod" ? "prodSelCount" : kind === "in" ? "inSelCount" : kind === "out" ? "outSelCount"
    : kind === "win" ? "wInSelCount" : "prSelCount";
}
function updateBatchBar(kind) {
  const bar = $(selBarId(kind));
  if (!bar) return;
  const set = selSet(kind);
  bar.style.display = set.size ? "flex" : "none";
  $(selCountId(kind)).textContent = set.size;
}
function toggleSel(kind, id, checked) {
  const set = selSet(kind);
  if (checked) set.add(id);
  else set.delete(id);
  updateBatchBar(kind);
}
function toggleAll(cb, kind) {
  const set = selSet(kind);
  set.clear();
  const tableId = kind === "prod" ? "prodTable" : kind === "in" ? "inTable" : kind === "out" ? "outTable"
    : kind === "win" ? "wInTable" : "prTable";
  document.querySelectorAll(`#${tableId} input[type="checkbox"][value]`).forEach((c) => {
    c.checked = cb.checked;
    if (cb.checked) set.add(+c.value);
  });
  // 批次行（整批一个选框）：data-ids 记录成员单号
  document.querySelectorAll(`#${tableId} input[type="checkbox"][data-ids]`).forEach((c) => {
    c.checked = cb.checked;
    if (cb.checked) (c.dataset.ids || "").split(",").forEach((id) => id && set.add(+id));
  });
  updateBatchBar(kind);
}
function toggleOutGroupCB(cb) {
  const set = selSet("out");
  const on = cb.checked;
  (cb.dataset.ids || "").split(",").forEach((id) => {
    if (!id) return;
    if (on) set.add(+id); else set.delete(+id);
  });
  updateBatchBar("out");
}
function clearBatch(kind) {
  selSet(kind).clear();
  if (kind === "prod") renderProducts();
  else if (kind === "in") loadInbounds();
  else if (kind === "out") loadOutbounds();
  else if (kind === "win") loadWarehouseIns();
  else renderPackRules();
}

/* ---------- 可搜索下拉（点击选择，输入可快速筛选） ---------- */
function bindSearchable(root = document) {
  root.querySelectorAll("select.searchable").forEach((sel) => {
    if (sel.dataset.scombo) return;
    sel.dataset.scombo = "1";
    const wrap = document.createElement("div");
    wrap.className = "scombo";
    const input = document.createElement("input");
    input.className = "scombo-input";
    input.placeholder = "点击选择 / 输入筛选…";
    input.autocomplete = "off";
    const list = document.createElement("div");
    list.className = "scombo-list";
    wrap.append(input, list);
    sel.style.display = "none";
    sel.parentNode.insertBefore(wrap, sel.nextSibling);

    function syncInput() {
      const o = sel.options[sel.selectedIndex];
      input.value = o ? o.text : "";
    }
    sel.addEventListener("change", syncInput);

    function renderList(filter) {
      const f = (filter || "").toLowerCase().trim();
      const items = [];
      for (const o of sel.options) {
        const text = o.text;
        if (f && !text.toLowerCase().includes(f)) continue;
        items.push(`<div class="scombo-item" data-v="${o.value}">${esc(text)}</div>`);
      }
      list.innerHTML = items.join("") || '<div class="scombo-empty">无匹配选项</div>';
      list.querySelectorAll(".scombo-item").forEach((it) => {
        it.addEventListener("mousedown", (e) => {
          e.preventDefault();
          sel.value = it.dataset.v;
          sel.dispatchEvent(new Event("change", { bubbles: true }));
          syncInput();
          list.style.display = "none";
          input.blur();
        });
      });
    }
    input.addEventListener("focus", () => {
      // 聚焦即清空旧文本，展示全部选项供选择或输入筛选（否则只剩当前选中项）
      input.value = "";
      list.style.display = "block";
      renderList("");
    });
    input.addEventListener("blur", () => { syncInput(); });
    input.addEventListener("input", () => { renderList(input.value); list.style.display = "block"; });
    document.addEventListener("click", (e) => {
      if (!wrap.contains(e.target)) { list.style.display = "none"; syncInput(); }
    });
  });
}

/* ---------- 表格列排序（点击表头升/降序） ---------- */
function sortArrow(tblId, key) {
  const tbl = $(tblId);
  const s = tbl && tbl._sort;
  if (!s || s.key !== key) return "";
  return s.dir === 1 ? " ▲" : " ▼";
}
function compareVal(a, b) {
  if (a == null || a === "") a = -Infinity;
  if (b == null || b === "") b = -Infinity;
  if (typeof a === "number" && typeof b === "number") return a - b;
  // 日期字符串（YYYY-MM-DD）按字典序排序，避免 parseFloat 将其截断为同一个年份导致排序失效
  const reDate = /^\d{4}-\d{2}-\d{2}/;
  if (reDate.test(String(a)) && reDate.test(String(b))) return String(a) < String(b) ? -1 : String(a) > String(b) ? 1 : 0;
  const na = parseFloat(a), nb = parseFloat(b);
  if (!isNaN(na) && !isNaN(nb)) return na - nb;
  return String(a).localeCompare(String(b), "zh");
}
function applyTableSort(tbl, rows) {
  if (tbl && tbl._sort && Array.isArray(rows)) {
    const k = tbl._sort.key, d = tbl._sort.dir;
    // 派生列没有原始字段，排序前按需换算，否则会拿 undefined 比较（等于没排序）
    const valOf = (r) => {
      if (k === "gross") return (Number(r.amount) || 0) - (Number(r.total_cogs != null ? r.total_cogs : r.cogs) || 0);
      return r[k];
    };
    return rows.slice().sort((a, b) => compareVal(valOf(a), valOf(b)) * d);
  }
  return rows;
}
document.addEventListener("click", (e) => {
  const th = e.target.closest("th[data-key]");
  if (!th) return;
  const tbl = th.closest("table");
  if (!tbl || typeof tbl._render !== "function") return;
  const key = th.dataset.key;
  if (tbl._sort && tbl._sort.key === key) tbl._sort.dir *= -1;
  else tbl._sort = { key, dir: 1 };
  tbl._render();
});

/* ---------- 工具 ---------- */
const $ = (id) => document.getElementById(id);
const ROUTES = { api: "/api", uploads: "/uploads" };

function routePath(path) {
  if (path.startsWith("/api")) return ROUTES.api + path.slice(4);
  if (path.startsWith("/uploads")) return ROUTES.uploads + path.slice(8);
  return path;
}

async function api(path, method = "GET", body) {
  const opt = { method, headers: { "Content-Type": "application/json" } };
  if (body !== undefined) opt.body = JSON.stringify(body);
  const res = await fetch(routePath(path), opt);
  if (res.status === 401) { showLogin(); throw new Error("请先登录"); }
  if (!res.ok) {
    let msg = "请求失败";
    try { const j = await res.json(); msg = j.detail || msg; } catch (e) {}
    throw new Error(msg);
  }
  return res.json();
}

async function apiUpload(path, file) {
  const fd = new FormData();
  fd.append("file", file);
  const res = await fetch(routePath(path), { method: "POST", body: fd });
  if (res.status === 401) { showLogin(); throw new Error("请先登录"); }
  if (!res.ok) {
    let msg = "请求失败";
    try { const j = await res.json(); msg = j.detail || msg; } catch (e) {}
    throw new Error(msg);
  }
  return res.json();
}

let toastTimer = null;
function toast(msg, ms = 2400) {
  const t = $("toast");
  t.textContent = msg;
  t.classList.add("show");
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => t.classList.remove("show"), ms);
}

function fmtMoney(v) {
  v = Number(v) || 0;
  return "¥" + v.toLocaleString("zh-CN", { minimumFractionDigits: 2, maximumFractionDigits: 2 });
}
function fmtNum(v) {
  v = Number(v) || 0;
  return Math.abs(v - Math.round(v)) < 1e-6 ? String(Math.round(v)) : String(+v.toFixed(4));
}
/* 商品默认展示/出库单位，以及用默认单位展示库存与成本 */
function defaultUnit(p) { return (p && p.default_unit) || (p && p.base_unit) || ""; }
function unitFactor(p, unit) { return (p.conversions || {})[unit] || 1; }
function fmtStock(p) {
  const du = defaultUnit(p);
  const f = unitFactor(p, du);
  if (du && f && f !== 1) return `${fmtNum(p.stock / f)} ${du}`;
  return `${fmtNum(p.stock)} ${p.base_unit}`;
}
function fmtCost(p) {
  const du = defaultUnit(p);
  const f = unitFactor(p, du);
  return `${fmtMoney(p.avg_cost * f)}/${du}`;
}
/* 参考成本（默认单位）：优先库存均价（先进先出，自动随出入库重算），无则用参考成本 */
function refCostHtml(p) {
  const du = defaultUnit(p);
  const f = unitFactor(p, du);
  if (p.avg_cost > 0) return `${fmtMoney(p.avg_cost * f)}/${du}`;
  if (p.unit_cost > 0) return `${fmtMoney(p.unit_cost * f)}/${du}`;
  return "—";
}
/* 出库默认单价：优先默认售价，其次参考成本（库存均价/参考成本，按所选单位换算） */
function fillSalePrice(tr, p, unit) {
  const factor = (p.conversions || {})[unit] || 1;
  let price = 0;
  if (p.sale_price > 0) price = p.sale_price * factor;
  else if (p.avg_cost > 0) price = p.avg_cost * factor;
  else if (p.unit_cost > 0) price = p.unit_cost * factor;
  const inp = tr.querySelectorAll("input[type=number]")[1];
  if (price > 0) inp.value = +price.toFixed(2);
}
function today() {
  const d = new Date();
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`;
}
function monthStart() {
  return today().slice(0, 8) + "01";
}
function daysAgo(n) {
  const d = new Date();
  d.setDate(d.getDate() - n);
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`;
}

/* ---------- 导航 ---------- */
const PAGE_TITLES = {
  home: "工作台", stock: "库存管理", inbound: "入库", outbound: "出库 / 销售",
  "warehouse-in": "入仓", "wingroup": "入仓批次明细",
  products: "商品", report: "财务报表", otherexp: "其他开支", import: "批量导入", jushuitan: "聚水潭关联",
  backup: "备份与恢复",
};
let prodForceCat = "";  // 包材 / 人工 / 快递 等独立入口强制筛选的商品分类
let prodForceType = ""; // 关联结算 等独立入口强制筛选的商品类型（order）
function goProducts() { prodForceCat = ""; prodForceType = ""; goPage("products"); }
function goPage(name) {
  // 高亮当前导航项（商品页按 data-cat / data-type 精确匹配）
  document.querySelectorAll(".nav-item").forEach((x) => {
    const hit = x.dataset.page === name &&
      (name !== "products" ||
        ((x.dataset.cat || "") === (prodForceCat || "") &&
         (x.dataset.type || "") === (prodForceType || "")));
    x.classList.toggle("active", hit);
  });
  document.querySelectorAll(".page").forEach((x) => x.classList.remove("active"));
  const page = $("page-" + name);
  page.classList.add("active");
  const loaders = {
    home: loadDashboard, stock: loadStock, inbound: initInbound, outbound: initOutbound,
    "warehouse-in": loadWarehouseIn, wingroup: renderWinGroupPage,
    products: renderProducts, report: loadReport, import: loadImportPage, jushuitan: loadMappingPage,
    backup: loadBackupPage, fresh: loadFresh, packrules: loadPackRules, pdata: loadPdataPage,
    deduction: loadDeductionPage, express: loadExpressPage, settings: loadSettingsPage,
    otherexp: loadOtherExpensePage,
  };
  (loaders[name] || (() => {}))();
}
/* 设置二级页面：商品资料备份 / 备份与恢复 / 批量导入 / 聚水潭关联 */
function switchSettingsTab(panel) {
  document.querySelectorAll("#settingsSeg .seg-item").forEach((x) => x.classList.toggle("active", x.dataset.panel === panel));
  document.querySelectorAll("#page-settings .settings-panel").forEach((x) => { x.style.display = x.dataset.panel === panel ? "" : "none"; });
  if (panel === "pdata") loadPdataPage();
  else if (panel === "backup") loadBackupPage();
  else if (panel === "jushuitan") loadMappingPage();
}
async function loadSettingsPage() { switchSettingsTab("pdata"); }
/* =============== 快递费规则 =============== */
function currentExprCfg() {
  return {
    mode: $("expMode").value,
    first_kg_fee: parseFloat($("expFirst").value) || 0,
    per_extra_kg: parseFloat($("expExtra").value) || 0,
    rate_per_kg: parseFloat($("expRate").value) || 0,
    round_up: $("expRoundUp").checked,
  };
}
function exprFee(cfg, w) {
  if (cfg.mode === "flat") return Math.round(w * cfg.rate_per_kg * 100) / 100;
  let over = Math.max(0, w - 1);
  if (cfg.round_up && over > 0) over = Math.ceil(over);
  return Math.round((cfg.first_kg_fee + over * cfg.per_extra_kg) * 100) / 100;
}
function previewExpress() {
  const el = $("expPreview");
  if (!el) return;
  const cfg = currentExprCfg();
  const weights = [1, 2, 3, 5, 10];
  el.innerHTML = weights.map((w) =>
    `<div class="expr-item"><span class="expr-w">毛重 ${w}kg</span><span class="expr-fee">${fmtMoney(exprFee(cfg, w))}</span></div>`
  ).join("");
}
async function loadExpressPage() {
  try {
    const r = await api("/api/express/rule");
    $("expMode").value = r.mode === "flat" ? "flat" : "tiered";
    $("expFirst").value = r.first_kg_fee;
    $("expExtra").value = r.per_extra_kg;
    $("expRate").value = r.rate_per_kg;
    $("expRoundUp").checked = !!r.round_up;
    previewExpress();
    $("expRateInfo").textContent = "已加载当前计费规则";
  } catch (e) { toast("加载规则失败：" + e.message); }
}
async function saveExpressRule() {
  const cfg = currentExprCfg();
  const bad = cfg.mode === "tiered" ? [cfg.first_kg_fee, cfg.per_extra_kg] : [cfg.rate_per_kg];
  if (bad.some((v) => isNaN(v) || v < 0)) { toast("请填写正确的费用（≥0）"); return; }
  try {
    await api("/api/express/rule", "PUT", cfg);
    previewExpress();
    $("expRateInfo").textContent = "已保存，实时生效";
    toast("快递费规则已保存");
  } catch (e) { toast("保存失败：" + e.message); }
}
/* =============== 扣点设置 =============== */
async function loadDeductionPage() {
  try {
    if (!PRODUCTS.length) PRODUCTS = await api("/api/products");
    const [list, shops] = await Promise.all([
      api("/api/deductions"),
      api("/api/deductions/shops"),
    ]);
    window.__DEDUC_LIST__ = list;
    renderDeducTable(list);
    renderShopDeducTable(shops.rules || []);
    const wh = list.find((d) => d.category === "入仓品");
    const whInp = $("whDeducPercent");
    if (whInp) whInp.value = wh ? wh.percent : 0;
  } catch (e) { toast("加载扣点失败：" + e.message); }
}
async function whDeducSave() {
  const pct = parseFloat($("whDeducPercent").value);
  if (isNaN(pct) || pct < 0 || pct >= 100) { toast("入仓品扣点需在 0 ~ 100 之间"); return; }
  try {
    await api("/api/deductions", "POST", { category: "入仓品", percent: pct, remark: "入仓品采购价（收入）扣点" });
    toast("入仓品扣点已保存（实时生效）");
    WIN_DEDUCT = pct;
    loadDeductionPage();
  } catch (e) { toast("保存失败：" + e.message); }
}
function deducCategories() {
  return [...new Set((PRODUCTS || []).map((p) => p.category).filter(Boolean))].sort();
}
function renderDeducTable(list) {
  const t = $("deducTable");
  if (!t) return;
  const rows = (list || []).filter((d) => d.category !== "入仓品");
  t.innerHTML = `<thead><tr>
    <th>商品类别</th><th class="num">扣点 %</th><th>备注</th><th>操作</th>
  </tr></thead><tbody>` +
    (rows.length ? rows.map((d) => `<tr>
      <td>${esc(d.category)}</td>
      <td class="num"><span class="badge" style="background:var(--primary,#2563eb);color:#fff;">${Number(d.percent).toFixed(2)}%</span></td>
      <td class="muted">${esc(d.remark || "")}</td>
      <td class="line-actions">
        <button class="btn sm secondary" onclick="deducEdit(${d.id})">编辑</button>
        <button class="btn sm danger" onclick="deducDelete(${d.id}, '${esc(d.category)}')">删除</button>
      </td></tr>`).join("")
      : `<tr><td colspan="4" class="empty">暂无扣点规则，点击「新增扣点」配置（如 蔬菜 7%）</td></tr>`) +
    `</tbody>`;
}
function renderShopDeducTable(rules) {
  const t = $("shopDeducTable");
  if (!t) return;
  window.__SHOP_DEDUC__ = rules || [];
  t.innerHTML = `<thead><tr>
    <th>店铺名称</th><th>扣点规则</th><th>操作</th>
  </tr></thead><tbody>` +
    (rules.length ? rules.map((r) => {
      const badge = (v) => `<span class="badge" style="background:var(--ok,#16a34a);color:#fff;">${Number(v).toFixed(2)}%</span>`;
      const desc = r.percent != null
        ? `固定扣 ${badge(r.percent)}`
        : `按扣减库存分类 ${Object.entries(r.categories || {}).map(([k, v]) => `${esc(k)} ${badge(v)}`).join("、")}`;
      return `<tr>
        <td>${esc(r.shop)}</td>
        <td>${desc}<div class="muted" style="font-size:12px;margin-top:4px;">聚水潭订单导入时按「店铺名称」从「卖家实收」中扣除</div></td>
        <td class="line-actions">
          <button class="btn sm secondary" onclick="shopDeducEdit('${esc(r.shop)}')">编辑</button>
          <button class="btn sm danger" onclick="shopDeducDelete('${esc(r.shop)}')">删除</button>
        </td>
      </tr>`;
    }).join("") : `<tr><td colspan="3" class="empty">未配置店铺扣点规则</td></tr>`) +
    `</tbody>`;
}
function deducFormHtml(d) {
  d = d || {};
  return `<h3>${d.id ? "编辑扣点" : "新增扣点"} <button class="close" onclick="closeModal()">✕</button></h3>
    <div class="field"><label>商品类别</label>
      <input id="deducCat" list="deducCatList" value="${esc(d.category || "")}" placeholder="如 蔬菜 / 干货" />
      <datalist id="deducCatList">${deducCategories().map((c) => `<option value="${esc(c)}"></option>`).join("")}</datalist>
    </div>
    <div class="field"><label>扣点百分比（0 ~ 99.99）</label>
      <input id="deducPercent" type="number" min="0" max="99.99" step="0.01" value="${d.percent != null ? d.percent : ""}" />
      <div class="field-hint">入库单价 = 进货单价 × (1 − 扣点%)，如 7% → 3.5 元按 3.255 元入库</div>
    </div>
    <div class="field"><label>备注</label><input id="deducRemark" value="${esc(d.remark || "")}" placeholder="可选" /></div>
    <div class="modal-foot">
      <button class="btn secondary" onclick="closeModal()">取消</button>
      <button class="btn green" onclick="deducSave(${d.id || 0})">保存</button>
    </div>`;
}
function deducAdd() { openModal(deducFormHtml()); }
function deducEdit(id) {
  const d = (window.__DEDUC_LIST__ || []).find((x) => x.id === id);
  openModal(deducFormHtml(d));
}
async function deducSave(id) {
  const category = ($("deducCat").value || "").trim();
  const percent = parseFloat($("deducPercent").value);
  if (!category) { toast("请填写商品类别"); return; }
  if (isNaN(percent) || percent < 0 || percent >= 100) { toast("扣点百分比需在 0 ~ 100 之间"); return; }
  try {
    await api("/api/deductions", "POST", { category, percent, remark: $("deducRemark").value || "" });
    toast("已保存扣点规则"); closeModal(); loadDeductionPage();
  } catch (e) { toast("保存失败：" + e.message); }
}
async function deducDelete(id, category) {
  if (!confirm(`确认删除「${category}」的扣点规则？删除后该类别入库将不再折算。`)) return;
  try {
    await api("/api/deductions/" + id, "DELETE");
    toast("已删除"); loadDeductionPage();
  } catch (e) { toast("删除失败：" + e.message); }
}
/* ---------- 店铺扣点：新增/编辑/删除（写入 deduction_config.json，实时生效） ---------- */
function shopDeducShopList() {
  return [...new Set((window.__SHOP_DEDUC__ || []).map((r) => r.shop))].sort();
}
function shopCatRowHtml(k, v) {
  return `<div class="shop-cat-row">
      <input class="sdc-cat" list="deducCatList" value="${esc(k || "")}" placeholder="分类，如 蔬菜" style="flex:1;" />
      <input class="sdc-pct" type="number" min="0" step="0.01" value="${v != null ? v : ""}" placeholder="%" style="width:90px;" />
      <button class="btn danger sm" onclick="this.closest('.shop-cat-row').remove()">删</button>
    </div>`;
}
function shopCatAddRow() {
  const box = $("shopDeducRows"); if (!box) return;
  box.insertAdjacentHTML("beforeend", shopCatRowHtml("", ""));
}
function shopDeducTypeChanged() {
  const fixed = $("shopDeducType").value === "fixed";
  $("shopDeducFixed").style.display = fixed ? "" : "none";
  $("shopDeducCatBox").style.display = fixed ? "none" : "";
}
function shopDeducFormHtml(r) {
  r = r || {};
  const fixed = r.percent != null;
  const shops = shopDeducShopList().map((s) => `<option value="${esc(s)}"></option>`).join("");
  return `<h3>${r.shop ? "编辑店铺扣点" : "新增店铺扣点"} <button class="close" onclick="closeModal()">✕</button></h3>
    <div class="field"><label>店铺名称</label>
      <input id="shopDeducShop" list="shopDeducList" value="${esc(r.shop || "")}" placeholder="如：梓云茶蔬菜源头直发京东自营专区" />
      <datalist id="shopDeducList">${shops}</datalist>
      <div class="field-hint">聚水潭出库单按「店铺名称」自动扣减订单收入</div>
    </div>
    <div class="field"><label>规则类型</label>
      <select id="shopDeducType" onchange="shopDeducTypeChanged()">
        <option value="fixed" ${fixed ? "selected" : ""}>固定扣点（该店所有商品统一扣 %）</option>
        <option value="category" ${!fixed ? "selected" : ""}>按扣减库存分类扣点</option>
      </select>
    </div>
    <div id="shopDeducFixed"><div class="field"><label>固定扣点 %（0 ~ 99.99）</label><input id="shopDeducPercent" type="number" min="0" step="0.01" value="${fixed ? r.percent : ""}" /></div></div>
    <div id="shopDeducCatBox" style="display:${fixed ? "none" : ""};">
      <label style="font-size:13px;color:var(--text-secondary);">按分类扣点</label>
      <div id="shopDeducRows" style="display:flex;flex-direction:column;gap:8px;">${Object.entries(r.categories || {}).map(([k, v]) => shopCatRowHtml(k, v)).join("")}</div>
      <button class="btn sm secondary" onclick="shopCatAddRow()" style="margin-top:8px;">＋ 加一行分类</button>
    </div>
    <div class="modal-foot">
      <button class="btn secondary" onclick="closeModal()">取消</button>
      <button class="btn green" onclick="shopDeducSave()">保存</button>
    </div>`;
}
function shopDeducAdd() { openModal(shopDeducFormHtml()); }
function shopDeducEdit(shop) {
  const r = (window.__SHOP_DEDUC__ || []).find((x) => (x.shop || "").trim() === (shop || "").trim());
  openModal(shopDeducFormHtml(r || { shop }));
}
async function shopDeducSave() {
  const shop = ($("shopDeducShop").value || "").trim();
  if (!shop) { toast("请填写店铺名称"); return; }
  const payload = { shop };
  if ($("shopDeducType").value === "fixed") {
    const pct = parseFloat($("shopDeducPercent").value);
    if (isNaN(pct) || pct < 0 || pct >= 100) { toast("固定扣点需在 0 ~ 100 之间（不含 100）"); return; }
    payload.percent = pct;
  } else {
    const cats = {};
    document.querySelectorAll("#shopDeducRows .shop-cat-row").forEach((row) => {
      const k = row.querySelector(".sdc-cat").value.trim();
      const v = parseFloat(row.querySelector(".sdc-pct").value);
      if (k && !isNaN(v) && v > 0) cats[k] = v;
    });
    if (!Object.keys(cats).length) { toast("请至少填写一个分类扣点"); return; }
    payload.categories = cats;
  }
  try {
    await api("/api/deductions/shops", "POST", payload);
    toast("店铺扣点已保存（实时生效）"); closeModal(); loadDeductionPage();
  } catch (e) { toast("保存失败：" + e.message); }
}
async function shopDeducDelete(shop) {
  if (!confirm(`确认删除店铺「${shop}」的扣点规则？删除后该店订单不再折算。`)) return;
  try {
    await api("/api/deductions/shops/" + encodeURIComponent(shop), "DELETE");
    toast("已删除"); loadDeductionPage();
  } catch (e) { toast("删除失败：" + e.message); }
}
document.querySelectorAll(".nav-item").forEach((b) => b.addEventListener("click", () => {
  if (b.dataset.action === "warehouses") { openWarehouseModal(); return; }
  if (b.dataset.page === "products") {
    prodForceCat = b.dataset.cat || "";
    prodForceType = b.dataset.type || "";
  }
  if (b.dataset.page) goPage(b.dataset.page);
}));

/* =============== 分仓切换 =============== */
async function openWarehouseModal() {
  openModal(`
    <h3>切换分仓 <button class="close" onclick="closeModal()">✕</button></h3>
    <div id="whErr" class="alert err" style="display:none;"></div>
    <div id="whList"></div>
    <hr />
    <div class="field"><label>新建分仓名称</label>
      <input id="whName" placeholder="如：昆明仓" onkeydown="if(event.key==='Enter')createWarehouse()" /></div>
    <div class="toolbar"><div class="grow"></div>
      <button class="btn green" onclick="createWarehouse()">＋ 新建并切换</button></div>`);
  loadWarehouses();
}
async function loadWarehouses() {
  try {
    const r = await api("/api/warehouses");
    const list = r.warehouses || [];
    $("whList").innerHTML = (list.length ? list.map((w) => `
      <div style="display:flex;align-items:center;gap:8px;padding:8px 0;border-bottom:1px solid var(--line,#eee);">
        <b>${esc(w.name)}</b><span class="muted" style="font-size:12px;">${esc(w.key)}</span>
        <div class="grow"></div>
        ${w.is_current ? '<span class="badge" style="background:var(--primary,#2563eb);color:#fff;">当前</span>'
          : `<button class="btn sm" onclick="switchWarehouse('${esc(w.key)}','${esc(w.name)}')">切换</button>`}
      </div>`).join("") : '<div class="empty">暂无分仓</div>');
  } catch (e) { whErr(e.message); }
}
async function switchWarehouse(key, name) {
  const label = `「${name || key}」`;
  // 分仓只作用于当前登录会话：不登出、不影响其他在线用户，因此切换后直接刷新即可
  if (!confirm(`切换到${label}？仅你的登录会切到该分仓，其他在线用户不受影响，也无需重新登录。`)) return;
  try {
    const r = await api("/api/warehouses/switch", "POST", { key });
    toast(`已切换到 ${(r && r.warehouse && r.warehouse.name) || label}`);
    setTimeout(() => location.reload(), 400);  // 重新加载各页面数据
  } catch (e) { whErr(e.message); }
}
async function createWarehouse() {
  const name = ($("whName").value || "").trim();
  if (!name) { whErr("请输入分仓名称"); return; }
  if (!confirm(`新建「${name}」并把你的登录切过去？无需重新登录，也不影响其他在线用户。`)) return;
  try {
    await api("/api/warehouses", "POST", { name });
    toast(`已创建并切换到 ${name}`);
    setTimeout(() => location.reload(), 400);
  } catch (e) { whErr(e.message); }
}
function whErr(msg) { const el = $("whErr"); if (!el) return; el.textContent = msg; el.style.display = "block"; }

/* 页面内分段切换 */
function switchSeg(segId, btn) {
  const seg = $(segId);
  seg.querySelectorAll(".seg-item").forEach((x) => x.classList.remove("active"));
  btn.classList.add("active");
  const panel = btn.dataset.panel;
  const pageId = seg.closest(".page").id;
  document.querySelectorAll(`#${pageId} > div`).forEach((el) => {
    if (el.classList.contains("seg")) return;
    el.style.display = el.id === panel ? "" : "none";
  });
  if (panel === "stock-adjustments") loadAdjustments();
  if (panel === "stock-movements") loadMovements();
  if (panel === "stock-workload") loadWorkload();
}

/* ---------- 认证（私钥登录） ---------- */
function showLogin() {
  $("loginMask").classList.remove("hidden");
  $("loginUser").focus();
}
function hideLogin() { $("loginMask").classList.add("hidden"); }
function setUser(u) {
  CURRENT_USER = u;
  const disp = u.name || u.username;
  $("userName").textContent = disp;
  $("userRole").textContent = u.role === "admin" ? "管理员" : "业务员";
  $("userAvatar").textContent = disp.slice(0, 1);
  const wt = $("warehouseTag");
  if (wt) wt.textContent = u.warehouse ? `当前分仓：${u.warehouse.name}` : "";
  // 操作员 = 当前登录账号：始终回填并锁定只读（服务端同样以登录账号为准，不信前端值）
  ["inOperator", "outOperator", "adjOperator", "fOperator"].forEach((id) => {
    const el = $(id);
    if (!el) return;
    el.value = disp;
    el.readOnly = true;
    el.title = "默认当前登录账号，不可修改";
  });
}
/** 当前登录账号显示名（弹层里新建的操作员输入框用） */
function operatorName() {
  return (CURRENT_USER && (CURRENT_USER.name || CURRENT_USER.username)) || "";
}
function onKeyFileChange(inputId, nameId) {
  const f = $(inputId).files[0];
  $(nameId).value = f ? f.name : "";
}
function readFileText(file) {
  return new Promise((resolve, reject) => {
    const fr = new FileReader();
    fr.onload = () => resolve(fr.result);
    fr.onerror = () => reject(new Error("读取文件失败"));
    fr.readAsText(file);
  });
}
async function doLogin() {
  const username = $("loginUser").value.trim();
  const f = $("loginKeyFile").files[0];
  if (!username) { showLoginErr("请输入用户名"); return; }
  if (!f) { showLoginErr("请选择私钥文件"); return; }
  let private_key;
  try { private_key = await readFileText(f); }
  catch (e) { showLoginErr("读取私钥文件失败：" + e.message); return; }
  try {
    const r = await fetch(routePath("/api/auth/login"), {
      method: "POST", headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ username, private_key }),
    });
    if (!r.ok) {
      let msg = r.status === 400 ? "私钥文件无法解析，请确认为 Ed25519 私钥" : "用户名或私钥不匹配";
      try { const j = await r.json(); if (j.detail) msg = j.detail; } catch (e) {}
      showLoginErr(msg);
      return;
    }
    const j = await r.json();
    setUser(j.user);
    hideLogin();
    toast("欢迎，" + (j.user.name || j.user.username));
    location.reload(); // 重新初始化所有页面数据
  } catch (e) { showLoginErr("登录失败：" + e.message); }
}
function showLoginErr(msg) {
  const el = $("loginErr");
  el.textContent = msg;
  el.style.display = "block";
}
$("logoutBtn").addEventListener("click", async () => {
  try { await fetch(routePath("/api/auth/logout"), { method: "POST" }); } catch (e) {}
  CURRENT_USER = null;
  showLogin();
});

/* ---------- 弹窗 ---------- */
function openModal(html) {
  $("modalBox").innerHTML = html;
  $("modalMask").classList.add("show");
  bindSearchable($("modalBox"));
}
function closeModal() { $("modalMask").classList.remove("show"); $("modalBox").classList.remove("wide"); const r = _aiDoneResolve; _aiDoneResolve = null; if (r) r(); }
$("modalMask").addEventListener("click", (e) => { if (e.target.id === "modalMask") closeModal(); });

/* =============== 库存 =============== */
let STOCK_OVERVIEW = [];
async function loadStock() {
  const [products, overview] = await Promise.all([api("/api/products"), api("/api/stock-overview")]);
  PRODUCTS = products;
  STOCK_OVERVIEW = overview;
  renderStock(overview);
}
function renderStock(overview) {
  if (!overview) overview = STOCK_OVERVIEW;
  if (!overview) return;
  // 分类筛选下拉
  const catSel = $("stockCategory");
  if (catSel && catSel.options.length <= 1) {
    const cats = [...new Set(overview.map((p) => p.category).filter(Boolean))];
    cats.sort();
    catSel.insertAdjacentHTML("beforeend", cats.map((c) => `<option value="${esc(c)}">${esc(c)}</option>`).join(""));
  }
  const kw = ($("stockSearch").value || "").trim().toLowerCase();
  const cat = catSel ? catSel.value : "";
  let rows = overview.filter((p) =>
    (!kw || p.name.toLowerCase().includes(kw) || p.category.toLowerCase().includes(kw)) &&
    (!cat || p.category === cat)
  );
  const t = $("stockTable");
  rows = applyTableSort(t, rows);
  if (!rows.length) {
    t.innerHTML = `<tr><td colspan="6" class="empty">暂无数据，请先到「商品管理」添加商品</td></tr>`;
    t._rows = rows;
    t._render = () => renderStock(overview);
    return;
  }
  t.innerHTML = `<thead><tr>
    <th data-key="name">商品${sortArrow("stockTable", "name")}</th>
    <th data-key="category">分类${sortArrow("stockTable", "category")}</th>
    <th data-key="stock" class="num">当前库存${sortArrow("stockTable", "stock")}</th>
    <th data-key="avg_cost" class="num">平均成本${sortArrow("stockTable", "avg_cost")}</th>
    <th data-key="stock_value" class="num">库存价值${sortArrow("stockTable", "stock_value")}</th>
    <th>操作</th></tr></thead><tbody>` +
    rows.map((p) => {
      const low = p.stock <= 0 ? '<span class="badge out">缺货</span>' : "";
      return `<tr>
        <td><b>${esc(p.name)}</b> ${low}</td>
        <td>${esc(p.category) ? `<span class="badge adjust">${esc(p.category)}</span>` : "—"}</td>
        <td class="num mono">${fmtStock(p)}</td>
        <td class="num mono">${fmtCost(p)}</td>
        <td class="num mono">${fmtMoney(p.stock_value)}</td>
        <td class="line-actions">
          <button class="btn sm secondary" onclick="viewProductMv(${p.id})">流水</button>
          <button class="btn sm" onclick="openAdjust(${p.id})">调整</button>
        </td></tr>`;
    }).join("") + `</tbody>`;
  t._rows = rows;
  t._render = () => renderStock(overview);
  $("statTypes").textContent = overview.length;
  const totalValue = overview.reduce((s, p) => s + p.stock_value, 0);
  $("statStockValue").textContent = fmtMoney(totalValue);
  $("statStockSub").textContent = `${fmtNum(totalValue)} 元库存成本`;
  $("statLow").textContent = overview.filter((p) => p.stock <= 0).length;
}

function openAdjust(pid = 0) {
  const opts = PRODUCTS.filter((p) => p.is_active && p.product_type === "stock" && !["人工", "快递"].includes(p.category))
    .map((p) => `<option value="${p.id}" ${p.id === pid ? "selected" : ""}>${esc(p.name)}</option>`).join("");
  openModal(`
    <h3>盘点调整（相对增减） <button class="close" onclick="closeModal()">✕</button></h3>
    <div class="form-grid">
      <div class="field" style="grid-column:1/-1;"><label>商品 *</label><select id="adjProduct" onchange="adjPreview()">${opts}</select></div>
      <div class="field" style="grid-column:1/-1;"><span class="muted">当前库存：<b id="adjNow">—</b></span>　→　<span class="muted">调整后：<b id="adjAfter" style="color:var(--primary)">—</b></span></div>
      <div class="field" style="grid-column:1/-1;"><label>调整数量 *（相对当前库存，必带 +/-）</label><input id="adjQty" oninput="adjPreview()" placeholder="如 +100 增加 / -100 减少；留空则不调整" style="width:100%;" /></div>
      <div class="field"><label>平均成本（相对现均价，必带 +/-）</label><input id="adjAvgCost" oninput="adjPreview()" placeholder="如 +2 / -1；留空则不调整" /></div>
      <div class="field"><label>成本单价（相对现参考成本，必带 +/-）</label><input id="adjUnitCost" oninput="adjPreview()" placeholder="如 +2 / -1；留空则不调整" /></div>
      <div class="field"><label>日期</label><input id="adjDate" type="date" value="${today()}" /></div>
      <div class="field"><label>操作员</label><input id="adjOperator" value="${esc(operatorName())}" readonly title="默认当前登录账号，不可修改" /></div>
    </div>
    <div class="field" style="grid-column:1/-1;"><span class="muted">当前均价：<b id="adjNowAvg" style="color:var(--danger)">—</b></span>　→　<span class="muted">均价调整后：<b id="adjAfterAvg" style="color:var(--primary)">—</b></span></div>
    <div class="field" style="grid-column:1/-1;"><span class="muted">当前成本单价：<b id="adjNowUc" style="color:var(--danger)">—</b></span>　→　<span class="muted">成本单价调整后：<b id="adjAfterUc" style="color:var(--primary)">—</b></span></div>
    <div class="field" style="margin-top:10px;"><label>原因</label><input id="adjRemark" placeholder="如：盘点差异/损耗" /></div>
    <div class="modal-foot">
      <button class="btn secondary" onclick="closeModal()">取消</button>
      <button class="btn" onclick="submitAdjust()">确认调整</button>
    </div>`);
  adjPreview();
}
function adjPreview() {
  const p = PRODUCTS.find((x) => x.id === +$("adjProduct").value);
  const el = (id) => $(id);
  const nowEl = el("adjNow"), afterEl = el("adjAfter");
  const nowAvg = el("adjNowAvg"), afterAvg = el("adjAfterAvg");
  const nowUc = el("adjNowUc"), afterUc = el("adjAfterUc");
  if (!p) { [nowEl, afterEl, nowAvg, afterAvg, nowUc, afterUc].forEach((e) => e && (e.textContent = "—")); return; }
  const unit = p.default_unit || p.base_unit;
  const f = (p.conversions || {})[unit] || 1;
  const now = p.stock / f;
  nowEl.textContent = `${fmtNum(now)} ${unit}`;
  const raw = ($("adjQty")?.value || "").trim();
  if (!raw) afterEl.textContent = `${fmtNum(now)} ${unit}（不调整）`;
  else if (!/^[+-]\d+(\.\d+)?$/.test(raw)) afterEl.textContent = "⚠ 需以 + 或 - 开头，如 +100 / -100";
  else afterEl.textContent = `${fmtNum(now + parseFloat(raw))} ${unit}`;

  const avg = (p.avg_cost || 0) * f;
  nowAvg.textContent = avg > 0 ? `${fmtMoney(avg)}/${unit}` : "—（无均价）";
  const araw = ($("adjAvgCost")?.value || "").trim();
  if (!araw) afterAvg.textContent = "不调整";
  else if (!/^[+-]\d+(\.\d+)?$/.test(araw)) afterAvg.textContent = "⚠ 需以 + 或 - 开头，如 +2 / -1";
  else afterAvg.textContent = `${fmtMoney(Math.max(avg + parseFloat(araw), 0))}/${unit}`;

  const uc = (p.unit_cost || 0) * f;
  nowUc.textContent = uc > 0 ? `${fmtMoney(uc)}/${unit}` : "—（无成本单价）";
  const uraw = ($("adjUnitCost")?.value || "").trim();
  if (!uraw) afterUc.textContent = "不调整";
  else if (!/^[+-]\d+(\.\d+)?$/.test(uraw)) afterUc.textContent = "⚠ 需以 + 或 - 开头，如 +2 / -1";
  else afterUc.textContent = `${fmtMoney(Math.max(uc + parseFloat(uraw), 0))}/${unit}`;
}
async function submitAdjust() {
  const get = (id) => ($(id)?.value || "").trim();
  const raw = get("adjQty"), araw = get("adjAvgCost"), uraw = get("adjUnitCost");
  if (raw && !/^[+-]\d+(\.\d+)?$/.test(raw)) { toast("调整数量必须以 + 或 - 开头（如 +100 增加 / -100 减少），留空则不调整"); return; }
  if (araw && !/^[+-]\d+(\.\d+)?$/.test(araw)) { toast("平均成本必须以 + 或 - 开头（如 +2 调高 / -1 调低），留空则不调整"); return; }
  if (uraw && !/^[+-]\d+(\.\d+)?$/.test(uraw)) { toast("成本单价必须以 + 或 - 开头（如 +2 调高 / -1 调低），留空则不调整"); return; }
  const p = PRODUCTS.find((x) => x.id === +$("adjProduct").value);
  if (!p) { toast("请选择商品"); return; }
  try {
    const r = await api("/api/adjust", "POST", {
      product_id: p.id,
      quantity: raw,
      unit: p.default_unit || p.base_unit,
      avg_cost_adj: araw,
      unit_cost_adj: uraw,
      date: $("adjDate").value,
      operator: $("adjOperator").value,
      remark: $("adjRemark").value,
    });
    closeModal();
    toast(r && r.message ? r.message : (raw || araw || uraw ? "盘点调整成功" : "无调整"));
    loadStock();
    loadAdjustments();
  } catch (e) { toast("操作失败：" + e.message); }
}

/* ---------- 盘点调整记录（查看谁盘点的，支持删除回退） ---------- */
let ADJ_PRODS = [];
function ensureAdjFilter() {
  const sel = $("adjProductFilter");
  if (!sel) return;
  // 补充盘点记录里出现但未在 PRODUCTS 中的商品（如已停用），主列表在初始化时已填充
  const existing = new Set([...sel.options].map((o) => o.value));
  ADJ_PRODS.forEach((p) => {
    if (p && p.id && !existing.has(String(p.id))) {
      sel.insertAdjacentHTML("beforeend", `<option value="${p.id}">${esc(p.name)}</option>`);
      existing.add(String(p.id));
    }
  });
}
async function loadAdjustments() {
  try { ensureAdjFilter(); } catch (e) {}
  const pid = $("adjProductFilter")?.value || "0";
  const from = $("adjDateFrom")?.value || "", to = $("adjDateTo")?.value || "";
  let rows = await api(`/api/adjustments?product_id=${pid}&date_from=${from || ""}&date_to=${to || ""}`);
  rows.forEach((r) => ADJ_PRODS.push({ id: r.product_id, name: r.product_name, is_active: true, product_type: "stock", category: "" }));
  const t = $("adjRecordTable");
  rows = applyTableSort(t, rows);
  if (!rows.length) {
    t.innerHTML = `<tr><td colspan="8" class="empty">暂无盘点调整记录</td></tr>`;
    t._render = loadAdjustments;
    t._rows = rows;
    return;
  }
  t.innerHTML = `<thead><tr>
    <th data-key="date">日期${sortArrow("adjRecordTable", "date")}</th>
    <th data-key="product_name">商品${sortArrow("adjRecordTable", "product_name")}</th>
    <th data-key="quantity" class="num">库存变动${sortArrow("adjRecordTable", "quantity")}</th>
    <th data-key="avg_cost_delta" class="num">均价调整${sortArrow("adjRecordTable", "avg_cost_delta")}</th>
    <th data-key="unit_cost_delta" class="num">成本单价${sortArrow("adjRecordTable", "unit_cost_delta")}</th>
    <th data-key="operator">操作员${sortArrow("adjRecordTable", "operator")}</th>
    <th>备注</th>
    <th>操作</th></tr></thead><tbody>` +
    rows.map((r) => {
      const deltaHtml = (v, unit) => v ? (v > 0 ? "+" : "") + fmtNum(v) + "元/" + esc(unit) : "—";
      return `<tr>
        <td class="mono">${esc(r.date)}<div class="muted" style="font-size:11px">${esc(r.created_at)}</div></td>
        <td><b>${esc(r.product_name)}</b></td>
        <td class="num">${r.quantity ? (r.quantity > 0 ? "+" : "") + fmtNum(r.quantity) + " " + esc(r.unit) : "—"}</td>
        <td class="num mono" style="color:${r.avg_cost_delta ? (r.avg_cost_delta > 0 ? "var(--green)" : "var(--red)") : ""}">${deltaHtml(r.avg_cost_delta, r.unit)}</td>
        <td class="num mono" style="color:${r.unit_cost_delta ? (r.unit_cost_delta > 0 ? "var(--green)" : "var(--red)") : ""}">${deltaHtml(r.unit_cost_delta, r.unit)}</td>
        <td>${esc(r.operator) || "—"}</td>
        <td class="muted">${esc(r.remark)}</td>
        <td class="line-actions"><button class="btn sm danger" onclick="deleteAdjustment(${r.id})">删除回退</button></td>
      </tr>`;
    }).join("") + `</tbody>`;
  t._rows = rows;
  t._render = loadAdjustments;
}
async function deleteAdjustment(gid) {
  if (!confirm("确认删除该盘点调整记录？将回退其对库存、平均成本与成本单价的影响。")) return;
  try {
    await api(`/api/adjustments/${gid}`, "DELETE");
    toast("已删除并回退调整");
    loadAdjustments();
    loadStock();
  } catch (e) { toast("删除失败：" + e.message); }
}

function viewProductMv(pid) {
  goPage("stock");
  const sel = $("mvProduct");
  sel.value = String(pid);
  // 触发 change 同步「可搜索下拉」的显示文本（否则仍显示旧商品/全部商品）
  sel.dispatchEvent(new Event("change", { bubbles: true }));
  // 默认查看该商品最近一个月的流水
  $("mvDateFrom").value = daysAgo(29);
  $("mvDateTo").value = today();
  const segBtn = document.querySelector('#stockSeg .seg-item[data-panel="stock-movements"]');
  if (segBtn) switchSeg("stockSeg", segBtn);
}

/* =============== 工作台 =============== */
async function loadDashboard() {
  try {
    const d = await api("/api/dashboard");
    const now = new Date();
    const week = ["日", "一", "二", "三", "四", "五", "六"][now.getDay()];
    $("dashGreeting").textContent = `你好，${d.user_name} 👋`;
    $("dashDate").textContent = `${d.today} 星期${week} · 欢迎回来`;
    const t = d.today_summary, m = d.month_summary;
    $("dashStats").innerHTML = `
      <div class="stat accent"><div class="label">今日收入</div><div class="value">${fmtMoney(t.revenue)}</div><div class="sub">${t.orders} 单</div></div>
      <div class="stat success"><div class="label">本月毛利</div><div class="value">${fmtMoney(m.gross)}</div><div class="sub">本月净利 ${fmtMoney(m.net)}</div></div>
      <div class="stat red"><div class="label">本月其他开支</div><div class="value">${fmtMoney(m.other_expense || 0)}</div><div class="sub">今日 ${fmtMoney(t.other_expense || 0)} · 已计入净利</div></div>
      <div class="stat"><div class="label">本月收入</div><div class="value">${fmtMoney(m.revenue)}</div><div class="sub">${m.orders} 单</div></div>
      <div class="stat accent"><div class="label">当前库存总值</div><div class="value">${fmtMoney(d.stock_value)}</div><div class="sub">${d.product_count} 种商品</div></div>
      <div class="stat ${d.low_stock.length ? "danger" : "success"}"><div class="label">缺货商品</div><div class="value">${d.low_stock.length}</div><div class="sub">${d.low_stock.length ? "需要及时补货" : "库存充足"}</div></div>`;

    const low = d.low_stock || [];
    $("dashLow").innerHTML = low.length
      ? low.slice(0, 8).map((p) => `
        <div class="activity-item">
          <div class="activity-ico" style="background:var(--red-light);">缺</div>
          <div class="activity-body">
            <div class="activity-title">${esc(p.name)}</div>
            <div class="activity-sub">当前库存 ${fmtStock(p)}</div>
          </div>
          <button class="btn sm danger" onclick="goPage('inbound')">补货</button>
        </div>`).join("") +
        (low.length > 8 ? `<div class="empty-tip">… 还有 ${low.length - 8} 种缺货</div>` : "")
      : `<div class="empty-tip">🎉 暂无缺货商品，库存状态良好</div>`;

    const acts = [];
    (d.recent_outbounds || []).forEach((o) => acts.push({
      ico: '<svg class="ic"><use href="#i-out"/></svg>', cls: "out", title: `出库 ${o.code}`,
      sub: `${o.customer || "散客"} · ${o.date}${o.operator ? " · " + o.operator : ""}`,
      amt: fmtMoney(o.amount), color: "var(--primary)",
    }));
    (d.recent_inbounds || []).forEach((i) => acts.push({
      ico: '<svg class="ic"><use href="#i-in"/></svg>', cls: "in", title: `入库 ${i.code}`,
      sub: `${i.product_name} × ${fmtNum(i.quantity)}${i.unit} · ${i.date}`,
      amt: fmtMoney(i.amount), color: "var(--green)",
    }));
    $("dashActivity").innerHTML = acts.length
      ? acts.slice(0, 8).map((a) => `
        <div class="activity-item">
          <div class="activity-ico ${a.cls}">${a.ico}</div>
          <div class="activity-body"><div class="activity-title">${a.title}</div><div class="activity-sub">${a.sub}</div></div>
          <div class="activity-amt" style="color:${a.color}">${a.amt}</div>
        </div>`).join("")
      : `<div class="empty-tip">还没有出入库记录，点击右上角开始记账吧</div>`;
  } catch (e) { /* 忽略 */ }
}

/* =============== AI 智能录入 =============== */
let AI_CTRL = null;   // 当前识别任务的 AbortController（后台挂起，可取消）
let AI_TIMER = null;  // 用时刷新定时器
let AI_START = 0;

function aiShowThinking() {
  $("aiThinking").style.display = "";
  $("aiThinkBody").textContent = "";
  AI_START = Date.now();
  clearInterval(AI_TIMER);
  AI_TIMER = setInterval(() => {
    $("aiThinkTime").textContent = `${((Date.now() - AI_START) / 1000).toFixed(0)}s`;
  }, 500);
}
function aiHideThinking() {
  clearInterval(AI_TIMER);
  AI_TIMER = null;
  $("aiThinking").style.display = "none";
}
function aiCancel() {
  if (AI_CTRL) AI_CTRL.abort();
  aiHideThinking();
  toast("已取消识别");
}
function aiAppendThink(s) {
  const el = $("aiThinkBody");
  el.textContent += s;
  el.scrollTop = el.scrollHeight;
}
function aiStartTask(btnHtml = '<svg class="ic"><use href="#i-ai"/></svg> 识别中…') {
  if (AI_CTRL) AI_CTRL.abort();           // 取消上一次任务
  AI_CTRL = new AbortController();
  $("aiBtn").disabled = true;
  $("aiBtn").innerHTML = btnHtml;
  aiShowThinking();
}
function aiResetBtn() {
  AI_CTRL = null;
  $("aiBtn").disabled = false;
  $("aiBtn").innerHTML = '<svg class="ic"><use href="#i-ai"/></svg> 识别并录入';
}
async function aiCollectStream(res) {
  if (res.status === 401) { showLogin(); throw new Error("请先登录"); }
  if (!res.ok) {
    let msg = "识别失败";
    try { const j = await res.json(); msg = j.detail || msg; } catch (e) {}
    throw new Error(msg);
  }
  const reader = res.body.getReader();
  const decoder = new TextDecoder("utf-8");
  let buf = "", result = null;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    buf += decoder.decode(value, { stream: true });
    const parts = buf.split("\n\n");
    buf = parts.pop();
    for (const part of parts) {
      const line = part.trim();
      if (!line.startsWith("data:")) continue;
      const data = line.slice(5).trim();
      if (!data) continue;
      let obj;
      try { obj = JSON.parse(data); } catch (e) { continue; }
      if (obj.delta) {
        aiAppendThink(obj.delta);          // 实时展示 AI 思考过程
      } else if (obj.result) {
        if (!result || obj.source === "quick") result = obj.result;
      } else if (obj.error) {
        throw new Error(obj.error);
      }
    }
  }
  if (!result) throw new Error("识别未返回结果");
  return result;
}
async function aiFinishOk(result) {
  aiHideThinking();
  // 刷新商品列表，保证确认框里的候选/分类下拉是最新的
  PRODUCTS = await api("/api/products");
  openAiConfirm(result);
  aiResetBtn();
}
function aiFinishErr(e) {
  if (e.name === "AbortError") return;     // 用户手动取消
  aiAppendThink("\n⚠ 识别失败：" + e.message);
  setTimeout(aiHideThinking, 2500);
  toast("识别失败：" + e.message);
  aiResetBtn();
}
async function aiParse() {
  const text = $("aiText").value.trim();
  if (!text) { toast("请输入入库/出库描述"); return; }
  aiStartTask();
  try {
    const res = await fetch(routePath("/api/ai/parse/stream"), {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ text }),
      signal: AI_CTRL.signal,
    });
    await aiFinishOk(await aiCollectStream(res));
  } catch (e) { aiFinishErr(e); }
}
function aiPickImage() { $("aiImgFile").click(); }
function aiCaptureImage() { $("aiCamFile").click(); }
function aiParseImage(src) {
  const inp = src === "cam" ? $("aiCamFile") : $("aiImgFile");
  const files = Array.from(inp.files || []);
  if (!files.length) return;
  aiParseImageFiles(files, src === "cam" ? "拍照" : "相册");
  inp.value = "";
}
let _aiDoneResolve = null;   // 批量识别时，等待当前确认框关闭后再识别下一张
async function aiParseImageFiles(files, label) {
  const total = files.length;
  if (total > 1) toast(`已选择 ${total} 张图片，逐张识别中…`);
  for (let i = 0; i < total; i++) {
    if (_batchAbort) { _batchAbort = false; break; }
    if (i > 0) await new Promise((r) => setTimeout(r, 400));
    const ok = await aiRecognizeOne(files[i], i, total, label);
    if (!ok) return;  // 识别失败或用户取消，停止剩余批次
  }
}
let _batchAbort = false;
async function aiRecognizeOne(f, idx, total, label) {
  const progress = total > 1 ? `（第 ${idx + 1}/${total} 张）` : "";
  aiStartTask(`<svg class="ic"><use href="#i-camera"/></svg> ${label}识别中 ${progress}`);
  try {
    const fd = new FormData();
    fd.append("file", f);
    const res = await fetch(routePath("/api/ai/parse-image/stream"), {
      method: "POST",
      body: fd,
      signal: AI_CTRL.signal,
    });
    const result = await aiCollectStream(res);
    await aiFinishOk(result);
    if (total > 1) await new Promise((resolve) => { _aiDoneResolve = resolve; }); // 等用户确认/取消后再识别下一张
    return true;
  } catch (e) {
    if (e.name === "AbortError") { _batchAbort = true; aiFinishErr(e); }  // 用户取消：终止整批
    else aiFinishErr(e);
    return false;
  }
}
// 支持 Ctrl+V 粘贴图片批量识别
document.addEventListener("paste", (e) => {
  const files = Array.from((e.clipboardData || {}).items || [])
    .filter((it) => it.type.startsWith("image/"))
    .map((it) => it.getAsFile())
    .filter(Boolean);
  if (files.length) { e.preventDefault(); aiParseImageFiles(files, "粘贴"); }
});
const AI_CAT_ORDER = [["stock", "库存商品"], ["order", "订单商品"], ["pack", "包材"], ["labor", "人工"]];
function aiCatOptions(selectedCat) {
  return AI_CAT_ORDER.map(([c, label]) =>
    `<option value="${c}" ${c === selectedCat ? "selected" : ""}>${label}</option>`
  ).join("");
}
// 按 AI 分类过滤商品（stock=库存商品，order=订单商品，pack=包材，labor=人工）
function aiProductsByCat(cat) {
  return (PRODUCTS || []).filter((p) => p.is_active).filter((p) => {
    const c = (p.category || "").trim();
    if (cat === "order") return p.product_type === "order";
    if (cat === "pack") return c === "包材" || c === "耗材" || c === "包装";
    if (cat === "labor") return c === "人工" || /打包$/.test(p.name);
    return p.product_type === "stock" && c !== "人工" && c !== "包材" && c !== "耗材" && c !== "包装";
  });
}
function aiProductOptions(selectedId, cat, prependHtml = "") {
  const catLabel = { stock: "库存", order: "订单", pack: "包材", labor: "人工" }[cat || "stock"] || "库存";
  const list = aiProductsByCat(cat || "stock").slice().sort((a, b) => a.name.localeCompare(b.name, "zh"));
  return prependHtml + list.map((p) =>
    `<option value="${p.id}" ${p.id === selectedId ? "selected" : ""}>〔${catLabel}〕${esc(p.name)}</option>`
  ).join("");
}
function aiCatChanged(i) {
  const tr = document.querySelector(`#aiLines tr[data-idx="${i}"]`);
  if (!tr) return;
  const cat = tr.querySelector(".ai-cat").value;
  const sel = tr.querySelector(".ai-pid");
  const line = AI_CONFIRM && AI_CONFIRM.lines ? AI_CONFIRM.lines[i] : null;
  if (line) {
    line.category = cat;
    if (line.new_product) line.new_product.category = cat;
  }
  const cur = +sel.value || 0;
  // 当前选着相似候选且分类没换：保留候选列表不动
  if (line && line.ambiguous && line.candidates && line.candidates.length
      && line.candidates.some((c) => c.product_id === cur)) return;
  const canNew = !!(line && (line.new_product || line.ambiguous));
  const keepCur = !canNew && aiProductsByCat(cat).some((p) => p.id === cur);
  const newName = (line && (line.recognized_name || line.product_name)) || "";
  const head = canNew
    ? `<option value="0" ${keepCur || cur ? "" : "selected"}>🆕 新建：${esc(newName)}</option>`
    : (keepCur ? "" : `<option value="0" selected>— 请选择商品 —</option>`);
  sel.innerHTML = aiProductOptions(keepCur ? cur : 0, cat, head);
  aiProdChanged(i);   // 重建后同步「新建名字框」显隐与单位
}
// 价格徽标：标记该行单价是否为「按最近价自动填入」
function aiPriceBadge(tr, line) {
  const cell = tr.querySelector(".ai-price-cell");
  if (!cell) return;
  let badge = cell.querySelector(".ai-price-badge");
  const on = !!(line && line.price_defaulted);
  if (on && !badge) {
    badge = document.createElement("span");
    badge.className = "ai-price-badge";
    badge.setAttribute("style", "background:var(--amber-light);color:#8a6d00;margin-left:4px;");
    badge.textContent = "已按最近价";
    cell.appendChild(badge);
  } else if (!on && badge) {
    badge.remove();
  }
}
// 切换商品（分类下拉/相似候选/新商品占位）后：若单价为空，回填该商品最近一次录入价
async function aiProdChanged(i) {
  const tr = document.querySelector(`#aiLines tr[data-idx="${i}"]`);
  if (!tr) return;
  const sel = tr.querySelector(".ai-pid");
  const pid = +sel.value || 0;
  const line = AI_CONFIRM && AI_CONFIRM.lines ? AI_CONFIRM.lines[i] : null;
  if (line) line.product_id = pid;
  // 选中「🆕 新建」：露出名字输入框，并把单位还原成票据上的原始单位（如 瓶）
  const nameEl = tr.querySelector(".ai-newname");
  if (nameEl) {
    nameEl.style.display = pid ? "none" : "";
    if (!pid && !nameEl.value) nameEl.value = (line && (line.recognized_name || line.product_name)) || "";
  }
  if (!pid && line && line.recognized_unit) {
    tr.querySelector(".ai-unit").value = line.recognized_unit;
  }
  const priceEl = tr.querySelector(".ai-price");
  if (!pid || !priceEl) { aiPriceBadge(tr, line); return; }   // 待新增商品：暂无历史价
  // 用户手填的价格不动；自动填入的价格在换商品后要跟着换成新商品的价格
  const autoFilled = !!(line && line.price_defaulted);
  if (!autoFilled && priceEl.value !== "" && +priceEl.value !== 0) { aiPriceBadge(tr, line); return; }
  let price = 0;
  const opt = sel.options[sel.selectedIndex];
  if (opt && opt.dataset && opt.dataset.price) price = +opt.dataset.price || 0;
  if (!price) {
    try {
      const d = await api(`/api/ai/last-price?product_id=${pid}&op_type=${$("aiType").value}`);
      price = (d && d.price) || 0;
    } catch (e) { price = 0; }
  }
  if (price > 0) {
    priceEl.value = price;
    if (line) line.price_defaulted = true;
  } else if (autoFilled) {
    priceEl.value = "";              // 新商品没有参考价：清掉上一条的自动价，避免带错价格
    if (line) line.price_defaulted = false;
  }
  aiPriceBadge(tr, line);
}
let AI_CONFIRM = null;   // 当前确认框对应的识别结果（供提交时标注）
function openAiConfirm(r) {
  AI_CONFIRM = r;
  const isIn = r.type === "inbound";
  const linesHtml = (r.lines || []).map((ln, i) => {
    const cat = (["stock", "order", "pack", "labor"].includes(ln.category) ? ln.category : (isIn ? "stock" : "order"));
    const np = ln.new_product || null;
    let prodSel;
    if (ln.ambiguous && ln.candidates && ln.candidates.length) {
      // 相似商品：默认选中第一个候选，并在未识别到价格时回填该商品最近一次的录入价
      if (!ln.candidates.some((c) => c.product_id === ln.product_id)) ln.product_id = ln.candidates[0].product_id;
      const cur = ln.candidates.find((c) => c.product_id === ln.product_id) || ln.candidates[0];
      if (!(+ln.unit_price) && cur.last_price) { ln.unit_price = cur.last_price; ln.price_defaulted = true; }
      prodSel = `<select class="ai-pid" style="border-color:var(--amber);" onchange="aiProdChanged(${i})">
          <option value="0">🆕 新建：${esc(ln.recognized_name || ln.product_name || "")}</option>
          ${ln.candidates.map((c) => `<option value="${c.product_id}" ${c.product_id === ln.product_id ? "selected" : ""} data-price="${c.last_price || 0}">〔${({ stock: "库存", order: "订单", pack: "包材", labor: "人工" }[c.category] || "库存")}〕${esc(c.name)}${c.last_price ? `（最近 ${c.last_price}）` : ""}</option>`).join("")}
        </select>`;
    } else if (np) {
      // 待新增商品：仅在「确认提交」后才建档，取消不会污染商品资料
      ln.product_id = 0;
      prodSel = `<select class="ai-pid" onchange="aiProdChanged(${i})">${aiProductOptions(0, cat, `<option value="0" selected>🆕 新建：${esc(np.name)}</option>`)}</select>`;
    } else {
      const head = ln.product_id ? "" : `<option value="0" selected>— 请选择商品 —</option>`;
      prodSel = `<select class="searchable ai-pid" onchange="aiProdChanged(${i})">${aiProductOptions(ln.product_id, cat, head)}</select>`;
    }
    const ambiBadge = ln.ambiguous
      ? '<span class="badge" style="background:#fff3cd;color:#8a6d00;margin-left:6px;">⚠ 相似商品待确认</span>' : "";
    const unitBadge = ln.unit_conflict
      ? '<span class="badge" style="background:#fde2e0;color:#b3261e;margin-left:6px;" title="' + esc(ln.unit_conflict_msg || "") + '">⚠ 单位不一致</span>' : "";
    return `<tr data-idx="${i}">
      <td><select class="ai-cat" onchange="aiCatChanged(${i})" style="width:92px;">${aiCatOptions(cat)}</select></td>
      <td style="min-width:250px;">${prodSel}${aiNewNameHtml(ln)}<div style="margin-top:4px;">${ambiBadge}${np ? '<span class="badge" style="background:var(--amber-light);color:#8a6d00;margin-left:6px;">🆕 提交后新增</span>' : ""}</div></td>
      <td><input type="number" step="any" class="ai-qty" value="${fmtNum(ln.quantity)}" style="width:90px;" /></td>
      <td><input class="ai-unit" value="${esc(ln.unit || "")}" style="width:70px;" />${unitBadge}</td>
      <td class="ai-price-cell"><input type="number" step="any" class="ai-price" value="${ln.unit_price ? ln.unit_price : ""}" placeholder="可留空" style="width:100px;" />${ln.price_defaulted ? '<span class="ai-price-badge" style="background:var(--amber-light);color:#8a6d00;margin-left:4px;">已按最近价</span>' : ""}</td>
      <td class="muted" style="font-size:12px;min-width:200px;">${esc(ln.hint || "")}</td>
      <td style="white-space:nowrap;"><button class="btn secondary" style="padding:4px 8px;" title="删除这一行" onclick="aiDelLine(${i})">🗑 删除</button></td>
    </tr>`;
  }).join("");
  const invImg = r.image_url
    ? `<div class="ai-invoice"><span class="muted">📎 票据凭证</span><img src="${esc(r.image_url)}" alt="票据" onclick="window.open('${esc(r.image_url)}','_blank')" /></div>`
    : "";
  openModal(`
    <h3>确认录入（${isIn ? "入库" : "出库"}） <button class="close" onclick="closeModal()">✕</button></h3>
    ${invImg}
    <p class="hint" style="margin-bottom:12px;">已自动识别以下内容，请核对（可修改/可删除行）后提交；🆕 标记的商品为新物品，点「确认提交」后才会新增商品档案（取消不会创建）。单价可留空，提交后在单据里补也行。</p>
    <div class="form-grid">
      <div class="field"><label>业务类型</label><select id="aiType" onchange="aiTypeChanged()">
        <option value="inbound" ${isIn ? "selected" : ""}>入库（进货）</option>
        <option value="outbound" ${isIn ? "" : "selected"}>出库（销售）</option>
      </select></div>
      <div class="field"><label>日期</label><input type="date" id="aiDate" value="${esc(r.date)}" /></div>
      <div class="field"><label>${isIn ? "供应商" : "客户"}</label><input id="aiParty" value="${esc(isIn ? r.supplier : r.customer)}" /></div>
      <div class="field"><label>备注</label><input id="aiRemark" value="${esc(r.remark)}" /></div>
    </div>
    <div class="table-wrap"><table>
      <thead><tr><th>分类</th><th>商品</th><th>数量</th><th>单位</th><th>${isIn ? "单价" : "售价"}</th><th>说明</th><th>操作</th></tr></thead>
      <tbody id="aiLines">${linesHtml || '<tr><td colspan="7" class="empty">未识别到明细</td></tr>'}</tbody>
    </table></div>
    <div class="modal-foot">
      <button class="btn secondary" onclick="closeModal()">取消</button>
      <button class="btn green" onclick="aiSubmit()">✓ 确认提交</button>
    </div>`);
  $("modalBox").classList.add("wide");   // 明细列多，弹窗放宽，避免信息被挤没
}
// 待新增商品的名字输入框：选中「🆕 新建」时出现，可自己改名字
function aiNewNameHtml(ln) {
  const show = !ln.product_id;
  return `<input class="ai-newname" placeholder="新商品名称（可修改）" value="${esc(ln.recognized_name || ln.product_name || "")}" style="${show ? "" : "display:none;"}margin-top:4px;width:100%;" />`;
}
// 删除明细行
function aiDelLine(i) {
  const tr = document.querySelector(`#aiLines tr[data-idx="${i}"]`);
  if (tr) tr.remove();
}
function aiTypeChanged() {
  // 切换类型时，未显式归类的行按业务类型重设默认分类（入库库存优先，出库订单优先）
  const isIn = $("aiType").value === "inbound";
  document.querySelectorAll("#aiLines tr[data-idx]").forEach((tr) => {
    const catSel = tr.querySelector(".ai-cat");
    const cat = catSel.value;
    if (!["stock", "order", "pack", "labor"].includes(cat)) catSel.value = isIn ? "stock" : "order";
    aiCatChanged(+tr.dataset.idx);
  });
}
async function aiSubmit() {
  const type = $("aiType").value;
  const date = $("aiDate").value;
  const party = $("aiParty").value.trim();
  const remark = $("aiRemark").value.trim();
  const inv = (AI_CONFIRM && AI_CONFIRM.image_url) ? `[票据] ${AI_CONFIRM.image_url}` : "";
  const autoFlags = (AI_CONFIRM && AI_CONFIRM.lines) || [];
  let rows = [...document.querySelectorAll("#aiLines tr[data-idx]")].map((tr) => {
    const idx = +tr.dataset.idx;                      // 按行号取回识别结果，删行后也不会串位
    const line = autoFlags[idx] || {};
    const pid = +tr.querySelector(".ai-pid").value || 0;
    const nameEl = tr.querySelector(".ai-newname");
    const typedName = nameEl ? nameEl.value.trim() : "";
    // 选中「🆕 新建」（或原本就是新物品）：按输入的名字建档，名字可自行修改
    const wantNew = !pid && (!!line.new_product || !!line.ambiguous || !!typedName);
    const spec = wantNew ? {
      name: typedName || line.recognized_name || line.product_name || "",
      category: line.category || "stock",
      unit: tr.querySelector(".ai-unit").value.trim() || line.recognized_unit || "个",
    } : null;
    const priceRaw = tr.querySelector(".ai-price").value.trim();
    return {
      product_id: pid,
      // 待新增商品：提交时才建档，避免用户取消也污染商品资料（含商品类型/包材）
      new_product: (spec && spec.name) ? spec : null,
      quantity: parseFloat(tr.querySelector(".ai-qty").value),
      unit: tr.querySelector(".ai-unit").value.trim(),
      unit_price: priceRaw === "" ? 0 : parseFloat(priceRaw),   // 单价允许留空，提交后可在单据里补
      auto_created: !!line.auto_created,
    };
  }).filter((r) => r.product_id || r.new_product);
  if (!rows.length) { toast("请至少填写一条商品"); return; }
  if (rows.some((r) => !(r.quantity > 0) || !r.unit)) { toast("请填写数量与单位（单价可留空，提交后在单据里补）"); return; }
  if (rows.some((r) => isNaN(r.unit_price))) { toast("单价填的不是数字，请检查"); return; }
  const op = (CURRENT_USER && (CURRENT_USER.name || CURRENT_USER.username)) || "";
  try {
    // 1) 先创建确认为新物品的商品档案（同名已存在则复用）
    const pend = rows.filter((r) => !r.product_id && r.new_product);
    if (pend.length) {
      const d = await api("/api/ai/products", "POST", {
        items: pend.map((r) => ({
          name: r.new_product.name,
          category: r.new_product.category || "stock",
          unit: r.unit || r.new_product.unit || "个",
        })),
      });
      (d.items || []).forEach((it, k) => { if (pend[k]) pend[k].product_id = it.product_id; });
      PRODUCTS = await api("/api/products");
    }
    rows = rows.filter((r) => r.product_id);
    if (!rows.length) { toast("商品创建失败，请稍后重试"); return; }
    // 2) 再写入单据
    if (type === "inbound") {
      for (const r of rows) {
        const rmk = [inv, r.auto_created ? "[AI自动新增]" : "", remark].filter(Boolean).join(" ");
        await api("/api/inbounds", "POST", { product_id: r.product_id, unit: r.unit, quantity: r.quantity, unit_price: r.unit_price, supplier: party, operator: op, date, remark: rmk });
      }
    } else {
      const lines = rows.map((r) => ({ product_id: r.product_id, unit: r.unit, quantity: r.quantity, price: r.unit_price }));
      await api("/api/outbounds", "POST", { customer: party, operator: op, date, remark: [inv, remark].filter(Boolean).join(" "), lines, pack_lines: [] });
    }
    closeModal();
    AI_CONFIRM = null;
    toast(type === "inbound" ? "入库成功" : "出库成功");
    loadDashboard(); loadStock();
    $("aiText").value = "";
  } catch (e) { toast("提交失败：" + e.message); }
}

/* =============== 备注附件 =============== */
/* 备注里以 /uploads/xxx 形式保存附件（AI 票据与手动上传的图片/文件共用同一格式）。
   字符集与后端落盘文件名一致（见 backend/app/routers/uploads.py）。 */
const REMARK_UPLOAD_RE = () => new RegExp(escRe(ROUTES.uploads) + "\\/[A-Za-z0-9_.\\-\\u4e00-\\u9fff]+", "g");

function escRe(s) { return String(s).replace(/[.*+?^${}()|[\]\\]/g, "\\$&"); }

/** 是否图片附件（决定渲染成缩略图还是下载链接） */
function isImageUrl(url) { return /\.(png|jpe?g|gif|webp|bmp|svg)$/i.test(url || ""); }

/** 附件展示名：去掉 attach_<时间戳>_ 前缀，还原可读文件名 */
function attachName(url) {
  const n = String(url || "").split("/").pop() || "附件";
  return n.replace(/^attach_\d{8}_\d{6}_\d+_/, "") || n;
}

/** 备注 → 有序段落：[{text}] 或 [{url, name, isImage}] */
function splitRemark(rmk) {
  const text = String(rmk || "");
  const re = REMARK_UPLOAD_RE();
  const segs = [];
  let last = 0, m;
  while ((m = re.exec(text))) {
    if (m.index > last) segs.push({ text: text.slice(last, m.index) });
    segs.push({ url: m[0], name: attachName(m[0]), isImage: isImageUrl(m[0]) });
    last = m.index + m[0].length;
  }
  if (last < text.length) segs.push({ text: text.slice(last) });
  return segs.filter((s) => s.url || s.text.trim());
}

/* 备注渲染：文本原样（换行转 <br>），图片附件显示缩略图，其他文件显示下载链接 */
function renderRemarkHtml(rmk) {
  if (!rmk) return "—";
  return splitRemark(rmk).map((s) => {
    if (s.text !== undefined) return esc(s.text).replace(/\n/g, "<br />");
    const u = routePath(s.url);
    if (s.isImage) {
      return `<a href="${u}" target="_blank" title="${esc(s.name)}"><img src="${u}" alt="${esc(s.name)}" style="height:34px;vertical-align:middle;border-radius:4px;margin-right:4px;border:1px solid var(--border-light);" /></a>`;
    }
    return `<a class="attach-link" href="${u}" target="_blank" title="${esc(s.name)}">📎 ${esc(s.name)}</a>`;
  }).join("");
}

/** 上传备注附件：成功后把 /uploads/xxx 追加进备注文本框，随表单一起保存 */
async function uploadRemarkFiles(textareaId, inputEl) {
  const files = Array.from(inputEl.files || []);
  inputEl.value = "";  // 允许重复选择同一个文件
  if (!files.length) return;
  try {
    for (const f of files) {
      const r = await apiUpload("/api/uploads", f);
      const ta = $(textareaId);
      ta.value = (ta.value.trim() ? ta.value.replace(/\s+$/, "") + "\n" : "") + r.url;
    }
    renderRemarkAttachments(textareaId);
    toast(`已添加 ${files.length} 个附件`);
  } catch (e) { toast("附件上传失败：" + e.message); }
}

/** 渲染已选附件的小标签（可单个删除），仅作用于新增表单 */
function renderRemarkAttachments(textareaId) {
  const box = $(textareaId + "Files");
  if (!box) return;
  const files = splitRemark($(textareaId).value).filter((s) => s.url);
  box.innerHTML = files.map((s) =>
    `<span class="attach-chip"><span>${s.isImage ? "🖼" : "📎"} ${esc(s.name)}</span><b onclick="removeRemarkAttachment('${textareaId}','${s.url}')">✕</b></span>`
  ).join("");
}

/** 从备注里移除某个附件 */
function removeRemarkAttachment(textareaId, url) {
  const ta = $(textareaId);
  ta.value = ta.value.split(url).join("").replace(/[ \t]+$/gm, "").replace(/\n{2,}/g, "\n").trim();
  renderRemarkAttachments(textareaId);
}

/* =============== 鲜货现采 =============== */
let FRESH_PLAN = null;  // 今日订单需求演算结果（不落库，仅采购参考）
async function loadFresh() {
  try {
    const d = await api("/api/fresh");
    renderFreshTable(d.items || []);
  } catch (e) { toast("加载失败：" + e.message); }
}
async function freshPlan() {
  const f = $("freshFile").files[0];
  if (!f) return;
  try {
    toast("正在演算今日订单需求…");
    const d = await apiUpload("/api/fresh/plan", f);
    FRESH_PLAN = d;
    renderFreshTable(d.items || []);
    const unmapped = d.unmapped || [];
    $("freshSummary").innerHTML =
      `今日订单 <b>${d.order_count}</b> 单，涉及 <b>${d.items.length}</b> 种蔬菜采购需求；` +
      (d.failed_count ? `另有 <b>${d.failed_count}</b> 单因未配置换算跳过；` : "") +
      (unmapped.length ? `未关联编码：<b style="color:var(--red)">${esc(unmapped.join("、"))}</b>` : "全部已关联 ✔");
    $("freshSummary").style.display = "block";
  } catch (e) { toast("演算失败：" + e.message); }
  finally { $("freshFile").value = ""; }
}
function renderFreshTable(items) {
  const planMap = {};
  (FRESH_PLAN?.items || []).forEach((i) => { planMap[i.id] = i; });
  const t = $("freshTable");
  t.innerHTML = `<thead><tr>
    <th>蔬菜</th>
    <th class="num">当前库存</th>
    <th class="num">今日订单需求</th>
    <th class="num">预计剩余</th>
    <th class="num">建议采购</th>
    <th class="num">参考成本</th>
    <th class="num">库存值</th></tr></thead><tbody>` +
    items.map((p) => {
      const pl = planMap[p.id];
      const need = pl ? `${fmtNum(pl.need)}` : "—";
      const remain = pl ? `${fmtNum(pl.remain)}` : "—";
      const suggest = pl && pl.suggest > 0 ? `<span style="color:var(--red);font-weight:600;">${fmtNum(pl.suggest)}</span>` : (pl ? "0" : "—");
      const remainColor = pl && pl.remain < 0 ? "var(--red)" : "";
      return `<tr>
        <td><b>${esc(p.name)}</b></td>
        <td class="num mono">${fmtNum(p.stock)} ${esc(p.unit)}</td>
        <td class="num mono">${need} ${esc(p.unit)}</td>
        <td class="num mono" style="color:${remainColor}">${remain} ${esc(p.unit)}</td>
        <td class="num">${suggest}</td>
        <td class="num mono">${fmtMoney(p.avg_cost)}/${esc(p.unit)}</td>
        <td class="num mono">${fmtMoney(p.stock_value)}</td></tr>`;
    }).join("") + `</tbody>`;
  if (!items.length) t.innerHTML = `<tr><td colspan="7" class="empty">暂无鲜货商品，可点「管理展示商品」添加</td></tr>`;
}

/* ---------- 鲜货展示清单管理（可自主增删/排序） ---------- */
let FC_SEL = [];   // 当前展示清单（有序商品 id）
let FC_ALL = [];   // 全部可选鲜货商品
async function openFreshConfig() {
  try {
    const [opts, cur] = await Promise.all([api("/api/fresh/options"), api("/api/fresh")]);
    FC_ALL = opts.items || [];
    FC_SEL = (cur.ids || []).slice();
    openModal(`
      <h3>管理展示商品 <button class="close" onclick="closeModal()">✕</button></h3>
      <p class="hint" style="margin-bottom:10px;">左侧勾选要展示的鲜货商品（点击顺序即展示顺序），右侧可调整顺序或移除；参考订货单品类清单。</p>
      <div class="fc-wrap">
        <div class="fc-pane">
          <div class="fc-label">候选商品</div>
          <input id="fcSearch" placeholder="🔍 搜索…" oninput="renderFreshConfig()" style="margin-bottom:8px;" />
          <div id="fcOptions" class="fc-list"></div>
        </div>
        <div class="fc-pane">
          <div class="fc-label">当前展示顺序</div>
          <div id="fcSel" class="fc-list"></div>
        </div>
      </div>
      <div class="modal-foot">
        <button class="btn secondary" onclick="closeModal()">取消</button>
        <button class="btn green" onclick="saveFreshConfig()">✓ 保存清单</button>
      </div>`);
    renderFreshConfig();
  } catch (e) { toast("加载失败：" + e.message); }
}
function renderFreshConfig() {
  const kw = ($("fcSearch")?.value || "").trim().toLowerCase();
  const selSet = new Set(FC_SEL);
  const optHtml = FC_ALL
    .filter((p) => !kw || p.name.toLowerCase().includes(kw) || (p.category || "").toLowerCase().includes(kw))
    .map((p) => `<div class="fc-opt ${selSet.has(p.id) ? "on" : ""}" onclick="fcToggle(${p.id})">${esc(p.name)} <span class="muted">${esc(p.category)}</span></div>`)
    .join("");
  $("fcOptions").innerHTML = optHtml || '<div class="empty" style="padding:14px;">无匹配商品</div>';
  const selHtml = FC_SEL.map((id, i) => {
    const p = FC_ALL.find((x) => x.id === id);
    if (!p) return "";
    return `<div class="fc-sel-item">
      <span class="grow">${i + 1}. ${esc(p.name)}</span>
      <button class="btn sm" onclick="fcMove(${i},-1)" title="上移">↑</button>
      <button class="btn sm" onclick="fcMove(${i},1)" title="下移">↓</button>
      <button class="btn sm danger" onclick="fcDel(${i})" title="移除">✕</button>
    </div>`;
  }).join("");
  $("fcSel").innerHTML = selHtml || '<div class="empty" style="padding:14px;">未选择（将展示全部）</div>';
}
function fcToggle(id) {
  const i = FC_SEL.indexOf(id);
  if (i >= 0) FC_SEL.splice(i, 1); else FC_SEL.push(id);
  renderFreshConfig();
}
function fcMove(i, d) {
  const j = i + d;
  if (j < 0 || j >= FC_SEL.length) return;
  [FC_SEL[i], FC_SEL[j]] = [FC_SEL[j], FC_SEL[i]];
  renderFreshConfig();
}
function fcDel(i) { FC_SEL.splice(i, 1); renderFreshConfig(); }
async function saveFreshConfig() {
  try {
    await api("/api/fresh/config", "POST", { ids: FC_SEL });
    toast("已保存展示清单");
    closeModal();
    loadFresh();
  } catch (e) { toast("保存失败：" + e.message); }
}

/* =============== 入仓 =============== */
let WPROD = [];       // 入仓品资料缓存
let WINS = [];        // 入仓记录缓存
let WIMPORT = null;   // 常温贴单导入预览结果
let WI_FILE = null;   // 导入用的 Excel 文件（保持引用，便于切换工作表重新解析）

async function loadWarehouseIn() {
  try { const d = await api("/api/warehouse-in/deduction"); WIN_DEDUCT = d.percent || 0; } catch (e) {}
  await Promise.all([loadWarehouseProducts(), loadWarehouseIns()]);
}

/* ---------- 入仓品资料 ---------- */
async function loadWarehouseProducts() {
  try {
    if (!PRODUCTS.length) PRODUCTS = await api("/api/products");
    WPROD = await api("/api/warehouse-in/products");
    renderWarehouseProducts();
  } catch (e) { toast("加载入仓品失败：" + e.message); }
}
function renderWarehouseProducts() {
  const t = $("wprodTable");
  const rows = WPROD || [];
  t.innerHTML = `<thead><tr>
    <th>名称</th><th>类目</th><th class="num">箱规(袋/箱)</th><th class="num">每袋净重</th>
    <th class="num">采购价(收入/袋)</th>
    <th class="num">运费(元/袋)</th><th class="num">每袋成本</th>
    <th>关联库存商品</th><th>保质期</th><th></th></tr></thead><tbody>` +
    rows.map((p) => `<tr>
      <td><b>${esc(p.name)}</b><div class="muted" style="font-size:12px;">${esc(p.sku) || "—"}${p.barcode ? ` · ${esc(p.barcode)}` : ""}</div></td>
      <td>${esc(p.category) || "—"}</td>
      <td class="num mono">${p.box_spec ? fmtNum(p.box_spec) : "—"}</td>
      <td class="num mono">${p.bag_weight ? `${fmtNum(p.bag_weight)} ${esc(p.stock_default_unit || "")}`.trim() : "—"}</td>
      <td class="num mono">${fmtMoney(p.purchase_price)}</td>
      <td class="num mono">${p.freight ? fmtMoney(p.freight) : "—"}</td>
      <td class="num mono">${p.bag_cost ? fmtMoney(p.bag_cost) : "—"}</td>
      <td>${p.stock_product_name ? esc(p.stock_product_name) : '<span class="muted">未关联</span>'}
        ${p.stock_product_id ? `<div class="muted" style="font-size:12px;">单位成本 ${fmtMoney(p.stock_unit_cost)}/${esc(p.stock_default_unit || "单位")}</div>` : ""}</td>
      <td>${esc(p.shelf_life) || "—"}</td>
      <td style="white-space:nowrap;">
        <button class="btn sm" onclick="wprodEdit(${p.id})">改</button>
        <button class="btn sm danger" onclick="wprodDelete(${p.id})">删</button>
      </td></tr>`).join("") + `</tbody>`;
  if (!rows.length) t.innerHTML = `<tr><td colspan="10" class="empty">暂无入仓品，可点「新增入仓品」录入</td></tr>`;
}
function stockProductOptions(selId) {
  const list = (PRODUCTS || []).filter((p) => p.product_type === "stock" && !["人工", "快递"].includes(p.category));
  return '<option value="">（不关联库存商品）</option>' +
    list.map((p) => `<option value="${p.id}" ${selId === p.id ? "selected" : ""}>${esc(p.name)}（${esc(p.category || "—")}）</option>`).join("");
}
function wprodEdit(id) {
  const p = (WPROD || []).find((x) => x.id === id) || {};
  openModal(`
    <h3>${id ? "编辑" : "新增"}入仓品 <button class="close" onclick="closeModal()">✕</button></h3>
    <div class="form-grid">
      <div class="field"><label>名称 *</label><input id="wpName" value="${esc(p.name || "")}" /></div>
      <div class="field"><label>类目</label><input id="wpCat" value="${esc(p.category || "")}" placeholder="如 半加工叶梅" /></div>
      <div class="field"><label>SKU</label><input id="wpSku" value="${esc(p.sku || "")}" /></div>
      <div class="field"><label>69码</label><input id="wpBarcode" value="${esc(p.barcode || "")}" /></div>
      <div class="field"><label>箱规（袋/箱）</label><input id="wpBoxSpec" type="number" step="any" min="0" value="${p.box_spec || ""}" /></div>
      <div class="field"><label>采购价（元/袋，收入）</label><input id="wpPrice" type="number" step="any" min="0" value="${p.purchase_price || ""}" /></div>
      <div class="field"><label>运费（元/袋）</label><input id="wpFreight" type="number" step="any" min="0" value="${p.freight || ""}" placeholder="可留空，后续维护" /></div>
      <div class="field"><label>关联库存商品（成本来源）</label><select id="wpStock" class="searchable">${stockProductOptions(p.stock_product_id)}</select></div>
      <div class="field"><label>每袋净重（默认单位，如 公斤）</label><input id="wpBagWeight" type="number" step="any" min="0" value="${p.bag_weight || ""}" placeholder="如 1" oninput="wprodCostHint()" /></div>
      <div class="field"><label>保质期</label><input id="wpShelf" value="${esc(p.shelf_life || "")}" placeholder="如 半年 / 一年" /></div>
      <div class="field" style="grid-column:1/-1;"><label>备注</label><input id="wpRemark" value="${esc(p.remark || "")}" /></div>
    </div>
    <p class="hint" id="wpCostHint" style="margin-top:8px;"></p>
    <div class="modal-foot">
      <button class="btn secondary" onclick="closeModal()">取消</button>
      <button class="btn green" onclick="wprodSave(${id || 0})">✓ 保存</button>
    </div>`);
  $("wpStock").addEventListener("change", wprodCostHint);
  wprodCostHint();
}
function wprodCostHint() {
  const sp = (PRODUCTS || []).find((x) => x.id === +$("wpStock").value);
  const bw = parseFloat($("wpBagWeight").value) || 0;
  const du = sp ? (sp.default_unit || sp.base_unit) : "";
  const factor = sp ? ((sp.conversions || {})[du] || 1) : 1;
  const uc = sp ? ((sp.avg_cost > 0 ? sp.avg_cost : sp.unit_cost) || 0) * factor : 0;
  const hint = $("wpCostHint");
  if (!hint) return;
  if (!sp) { hint.textContent = "未关联库存商品：商品成本将按 0 计。"; return; }
  hint.textContent = `库存单位成本 ${fmtMoney(uc)}/${du}（库存均价优先，无则用参考成本）；每袋成本 = ${fmtNum(bw)} × ${fmtMoney(uc)} = ${fmtMoney(bw * uc)}`;
}
async function wprodSave(id) {
  const name = ($("wpName").value || "").trim();
  if (!name) { toast("请填写名称"); return; }
  const body = {
    name,
    category: $("wpCat").value.trim(),
    sku: $("wpSku").value.trim(),
    barcode: $("wpBarcode").value.trim(),
    box_spec: parseFloat($("wpBoxSpec").value) || 0,
    purchase_price: parseFloat($("wpPrice").value) || 0,
    freight: parseFloat($("wpFreight").value) || 0,
    stock_product_id: +$("wpStock").value || null,
    bag_weight: parseFloat($("wpBagWeight").value) || 0,
    shelf_life: $("wpShelf").value.trim(),
    remark: $("wpRemark").value.trim(),
    is_active: true,
  };
  try {
    if (id) await api("/api/warehouse-in/products/" + id, "PUT", body);
    else await api("/api/warehouse-in/products", "POST", body);
    toast("已保存");
    closeModal();
    loadWarehouseProducts();
  } catch (e) { toast("保存失败：" + e.message); }
}
async function wprodDelete(id) {
  if (!confirm("确认删除该入仓品？（已产生的入仓记录不受影响）")) return;
  try { await api("/api/warehouse-in/products/" + id, "DELETE"); toast("已删除"); loadWarehouseProducts(); }
  catch (e) { toast("删除失败：" + e.message); }
}

/* ---------- 入仓记录 ---------- */
/* 默认显示本月；切换本月快捷按钮 */
function wInThisMonth() {
  if ($("wInDateFrom")) $("wInDateFrom").value = monthStart();
  if ($("wInDateTo")) $("wInDateTo").value = today();
  loadWarehouseIns();
}
async function loadWarehouseIns() {
  // 首次进入（两个日期都为空）默认显示本月
  if ($("wInDateFrom") && $("wInDateTo") && !$("wInDateFrom").value && !$("wInDateTo").value) {
    $("wInDateFrom").value = monthStart();
    $("wInDateTo").value = today();
  }
  const from = $("wInDateFrom")?.value || "", to = $("wInDateTo")?.value || "";
  const q = $("wInSearch")?.value || "";
  try {
    const d = await api(`/api/warehouse-in?date_from=${from}&date_to=${to}&q=${encodeURIComponent(q)}`);
    renderWarehouseIns(d);
  } catch (e) { toast("加载入仓记录失败：" + e.message); }
}
/* 按导入批次聚合：同一 import_group 的记录合并为一行 */
function buildWinGroup(recs) {
  const dates = recs.map((r) => r.date).sort();
  const pnames = [...new Set(recs.map((r) => r.product_name).filter(Boolean))];
  const pns = [...new Set(recs.map((r) => r.purchase_no).filter(Boolean))];
  const centers = [...new Set(recs.map((r) => r.center).filter(Boolean))];
  return {
    import_group: recs[0].import_group,
    ids: recs.map((r) => r.id),
    records: recs,
    count: recs.length,
    products: pnames.length,
    quantity: recs.reduce((s, r) => s + (r.quantity || 0), 0),
    amount: recs.reduce((s, r) => s + (r.amount || 0), 0),
    cogs: recs.reduce((s, r) => s + (r.cogs || 0), 0),
    freight: recs.reduce((s, r) => s + (r.freight_total || 0), 0),
    profit: recs.reduce((s, r) => s + (r.profit || 0), 0),
    code: `批量 · ${recs.length}条`,
    date: dates[0] === dates[dates.length - 1] ? dates[0] : `${dates[0]} ~ ${dates[dates.length - 1]}`,
    product: pnames.length > 3 ? `${pnames.slice(0, 3).join("、")} 等${pnames.length}种` : pnames.join("、"),
    purchase_no: pns.length ? (pns.length === 1 ? pns[0] : `${pns[0]} 等${pns.length}个`) : "—",
    center: centers.length ? (centers.length === 1 ? centers[0] : `${centers[0]} 等${centers.length}个`) : "—",
  };
}
function renderWarehouseIns(d) {
  const flat = d.items || [];
  WINS = flat;
  const t = $("wInTable");
  const groups = new Map();
  const rows = [];
  for (const r of flat) {
    if (r.import_group) {
      if (!groups.has(r.import_group)) groups.set(r.import_group, []);
      groups.get(r.import_group).push(r);
    } else {
      rows.push({ _group: false, rec: r });
    }
  }
  for (const [, recs] of groups) rows.push({ _group: true, g: buildWinGroup(recs) });
  // 统一可排序字段（批次行与单条行字段名对齐）
  const sortable = rows.map((x) => x._group
    ? { _group: true, g: x.g, code: x.g.code, date: x.g.date, purchase_no: x.g.purchase_no,
        center: x.g.center, product: x.g.product, quantity: x.g.quantity, amount: x.g.amount,
        cogs: x.g.cogs, freight: x.g.freight, profit: x.g.profit }
    : { _group: false, rec: x.rec, code: x.rec.code, date: x.rec.date, purchase_no: x.rec.purchase_no,
        center: x.rec.center, product: x.rec.product_name, quantity: x.rec.quantity, amount: x.rec.amount,
        cogs: x.rec.cogs, freight: x.rec.freight_total, profit: x.rec.profit });
  sortable.sort((a, b) => {
    if (t._sort) { const dd = compareVal(a[t._sort.key], b[t._sort.key]) * t._sort.dir; if (dd) return dd; }
    return 0;
  });
  const tot = d.total || {};
  if ($("winHint")) $("winHint").textContent = `共 ${flat.length} 条，合并 ${rows.length} 行`;
  if ($("wInSummary")) {
    $("wInSummary").innerHTML =
      `共 <b>${flat.length}</b> 条 · 数量 <b>${fmtNum(tot.quantity)}</b> 袋 · ` +
      `收入 <b>${fmtMoney(tot.amount)}</b> · 商品成本 <b>${fmtMoney(tot.cogs)}</b> · ` +
      `运费 <b>${fmtMoney(tot.freight)}</b> · 毛利 <b style="color:var(--green)">${fmtMoney(tot.profit)}</b>`;
    $("wInSummary").style.display = flat.length ? "block" : "none";
  }
  t.innerHTML = `<thead><tr>
    <th class="cb-col"><input type="checkbox" onclick="toggleAll(this,'win')" /></th>
    <th data-key="code">单号/批次${sortArrow("wInTable", "code")}</th>
    <th data-key="date">日期${sortArrow("wInTable", "date")}</th>
    <th data-key="purchase_no">采购单号${sortArrow("wInTable", "purchase_no")}</th>
    <th data-key="center">配送中心${sortArrow("wInTable", "center")}</th>
    <th data-key="product">商品${sortArrow("wInTable", "product")}</th>
    <th data-key="quantity" class="num">数量(袋)${sortArrow("wInTable", "quantity")}</th>
    <th data-key="amount" class="num">收入${sortArrow("wInTable", "amount")}</th>
    <th data-key="cogs" class="num">商品成本${sortArrow("wInTable", "cogs")}</th>
    <th data-key="freight" class="num">运费${sortArrow("wInTable", "freight")}</th>
    <th data-key="profit" class="num">毛利${sortArrow("wInTable", "profit")}</th>
    <th></th></tr></thead><tbody>` +
    sortable.map((x) => x._group ? renderWinGroupRow(x.g) : renderWinRow(x.rec)).join("") + `</tbody>`;
  if (!rows.length) t.innerHTML = `<tr><td colspan="12" class="empty">该时间段暂无入仓记录，可点「导入常温贴单」或「手动入仓」</td></tr>`;
  t._rows = sortable;
  t._render = loadWarehouseIns;
  updateBatchBar("win");
}
function renderWinRow(r) {
  const checked = winSel.has(r.id) ? "checked" : "";
  return `<tr>
    <td class="cb-col"><input type="checkbox" value="${r.id}" ${checked} onchange="toggleSel('win',${r.id},this.checked)" /></td>
    <td class="mono">${esc(r.code)}</td>
    <td>${esc(r.date)}</td>
    <td class="mono">${esc(r.purchase_no) || "—"}</td>
    <td>${esc(r.center) || "—"}</td>
    <td><b>${esc(r.product_name)}</b>${r.product_id ? "" : ' <span class="badge" style="background:#fff3cd;color:#8a6d3b;">未关联</span>'}
      <div class="muted" style="font-size:12px;">${esc(r.stock_product_name) || "未关联库存商品"} · 净重 ${r.bag_weight ? `${fmtNum(r.bag_weight)} ${esc(r.stock_default_unit || "")}`.trim() : "—"} · 单位成本 ${fmtMoney(r.unit_cost)}/${esc(r.stock_default_unit || "单位")}${r.deduction_percent ? ` · 扣点 ${fmtNum(r.deduction_percent)}%` : ""}</div>
    </td>
    <td class="num mono">${fmtNum(r.quantity)}</td>
    <td class="num mono">${fmtMoney(r.amount)}</td>
    <td class="num mono">${fmtMoney(r.cogs)}</td>
    <td class="num mono">${r.freight_total ? fmtMoney(r.freight_total) : "—"}</td>
    <td class="num mono" style="color:${(r.profit || 0) >= 0 ? "var(--green)" : "var(--red)"}">${fmtMoney(r.profit)}</td>
    <td style="white-space:nowrap;">
      <button class="btn sm" onclick="wInEdit(${r.id})">改</button>
      <button class="btn sm danger" onclick="wInDelete(${r.id})">删</button>
    </td></tr>`;
}
function renderWinGroupRow(g) {
  const allChecked = g.ids.length && g.ids.every((id) => winSel.has(id));
  return `<tr>
    <td class="cb-col"><input type="checkbox" data-ids="${g.ids.join(",")}" ${allChecked ? "checked" : ""} onchange="toggleWinGroupCB(this)" /></td>
    <td class="mono" title="${esc(g.import_group)}">${esc(g.code)}</td>
    <td>${esc(g.date)}</td>
    <td class="mono">${esc(g.purchase_no)}</td>
    <td>${esc(g.center)}</td>
    <td>${esc(g.product) || "—"}
      <div class="muted" style="font-size:12px;">${g.products} 种商品 · 合计 ${fmtNum(g.quantity)} 袋</div></td>
    <td class="num mono">${fmtNum(g.quantity)}</td>
    <td class="num mono">${fmtMoney(g.amount)}</td>
    <td class="num mono">${fmtMoney(g.cogs)}</td>
    <td class="num mono">${g.freight ? fmtMoney(g.freight) : "—"}</td>
    <td class="num mono" style="color:${g.profit >= 0 ? "var(--green)" : "var(--red)"}">${fmtMoney(g.profit)}</td>
    <td style="white-space:nowrap;">
      <button class="btn sm secondary" onclick="openWinGroup('${esc(g.import_group)}')">明细</button>
      <button class="btn sm danger" onclick="deleteWinGroup('${esc(g.import_group)}')">删</button>
    </td></tr>`;
}
function toggleWinGroupCB(cb) {
  const on = cb.checked;
  (cb.dataset.ids || "").split(",").forEach((id) => {
    if (!id) return;
    if (on) winSel.add(+id); else winSel.delete(+id);
  });
  updateBatchBar("win");
}
async function batchDeleteWarehouseIns() {
  const ids = [...winSel];
  if (!ids.length) { toast("请先勾选要删除的记录"); return; }
  if (!confirm(`确认删除选中的 ${ids.length} 条入仓记录？`)) return;
  try {
    const r = await api("/api/warehouse-in/batch-delete", "POST", { ids });
    winSel.clear();
    toast(`已删除 ${r.deleted} 条`);
    loadWarehouseIns();
  } catch (e) { toast("删除失败：" + e.message); }
}
/* 打开批次二级页 */
function openWinGroup(groupKey) {
  WGROUP = (WINS || []).filter((r) => r.import_group === groupKey);
  if (!WGROUP.length) { toast("未找到该批次"); return; }
  goPage("wingroup");
}
/* 批次二级页渲染（支持表头排序） */
function renderWinGroupPage() {
  if (!WGROUP || !WGROUP.length) return;
  const g = buildWinGroup(WGROUP);
  $("wgTitle").textContent = `入仓批次明细 · ${g.count} 条`;
  $("wgHint").textContent = `批次 ${g.import_group} · ${esc(g.date)}`;
  $("wgSummary").innerHTML = `
    <div class="stat"><div class="label">入仓数量</div><div class="value">${fmtNum(g.quantity)} 袋</div></div>
    <div class="stat"><div class="label">收入</div><div class="value">${fmtMoney(g.amount)}</div></div>
    <div class="stat"><div class="label">商品成本</div><div class="value">${fmtMoney(g.cogs)}</div></div>
    <div class="stat"><div class="label">运费</div><div class="value">${fmtMoney(g.freight)}</div></div>
    <div class="stat success"><div class="label">毛利</div><div class="value" style="color:var(--green)">${fmtMoney(g.profit)}</div></div>`;
  const t = $("wgTable");
  const rows = applyTableSort(t, WGROUP);
  t.innerHTML = `<thead><tr>
    <th data-key="code">单号${sortArrow("wgTable", "code")}</th>
    <th data-key="date">日期${sortArrow("wgTable", "date")}</th>
    <th data-key="purchase_no">采购单号${sortArrow("wgTable", "purchase_no")}</th>
    <th data-key="center">配送中心${sortArrow("wgTable", "center")}</th>
    <th data-key="product_name">商品${sortArrow("wgTable", "product_name")}</th>
    <th data-key="quantity" class="num">数量(袋)${sortArrow("wgTable", "quantity")}</th>
    <th data-key="box_count" class="num">箱数${sortArrow("wgTable", "box_count")}</th>
    <th data-key="unit_price" class="num">采购价(收入/袋)${sortArrow("wgTable", "unit_price")}</th>
    <th data-key="amount" class="num">收入${sortArrow("wgTable", "amount")}</th>
    <th data-key="cogs" class="num">商品成本${sortArrow("wgTable", "cogs")}</th>
    <th data-key="freight_total" class="num">运费${sortArrow("wgTable", "freight_total")}</th>
    <th data-key="profit" class="num">毛利${sortArrow("wgTable", "profit")}</th>
    <th></th></tr></thead><tbody>` + rows.map((r) => `<tr>
    <td class="mono">${esc(r.code)}</td>
    <td>${esc(r.date)}</td>
    <td class="mono">${esc(r.purchase_no) || "—"}</td>
    <td>${esc(r.center) || "—"}</td>
    <td><b>${esc(r.product_name)}</b>
      <div class="muted" style="font-size:12px;">${esc(r.stock_product_name) || "未关联库存商品"} · 净重 ${r.bag_weight ? `${fmtNum(r.bag_weight)} ${esc(r.stock_default_unit || "")}`.trim() : "—"}${r.deduction_percent ? ` · 扣点 ${fmtNum(r.deduction_percent)}%` : ""}</div></td>
    <td class="num mono">${fmtNum(r.quantity)}</td>
    <td class="num mono">${r.box_count ? fmtNum(r.box_count) : "—"}</td>
    <td class="num mono">${fmtMoney(r.unit_price)}</td>
    <td class="num mono">${fmtMoney(r.amount)}</td>
    <td class="num mono">${fmtMoney(r.cogs)}</td>
    <td class="num mono">${r.freight_total ? fmtMoney(r.freight_total) : "—"}</td>
    <td class="num mono" style="color:${(r.profit || 0) >= 0 ? "var(--green)" : "var(--red)"}">${fmtMoney(r.profit)}</td>
    <td style="white-space:nowrap;">
      <button class="btn sm" onclick="wInEdit(${r.id})">改</button>
      <button class="btn sm danger" onclick="wInDelete(${r.id})">删</button>
    </td></tr>`).join("") + `</tbody>`;
  t._rows = rows;
  t._render = renderWinGroupPage;
}
async function deleteWinGroup(groupKey) {
  const recs = (WINS || []).filter((r) => r.import_group === groupKey);
  if (!recs.length) { toast("未找到该批次"); return; }
  if (!confirm(`确认删除该批次（共 ${recs.length} 条入仓记录）？`)) return;
  try {
    const r = await api("/api/warehouse-in/batch-delete", "POST", { ids: recs.map((x) => x.id) });
    recs.forEach((x) => winSel.delete(x.id));
    toast(`已删除 ${r.deleted} 条`);
    if (WGROUP && WGROUP[0] && WGROUP[0].import_group === groupKey) { WGROUP = null; goPage("warehouse-in"); }
    else loadWarehouseIns();
  } catch (e) { toast("删除失败：" + e.message); }
}
/* 刷新入仓视图：列表始终刷新；若当前在批次明细页则同步刷新该批次 */
async function refreshWinView() {
  const key = WGROUP && WGROUP[0] ? WGROUP[0].import_group : null;
  await loadWarehouseIns();
  if (key && $("page-wingroup")?.classList.contains("active")) {
    WGROUP = (WINS || []).filter((r) => r.import_group === key);
    if (WGROUP.length) renderWinGroupPage();
    else { WGROUP = null; goPage("warehouse-in"); }
  }
}
function wInFormModal(rec) {
  rec = rec || {};
  const opts = ['<option value="">（不关联入仓品）</option>']
    .concat((WPROD || []).map((p) => `<option value="${p.id}" ${rec.product_id === p.id ? "selected" : ""}>${esc(p.name)}</option>`))
    .join("");
  openModal(`
    <h3>${rec.id ? "编辑" : "手动"}入仓 <button class="close" onclick="closeModal()">✕</button></h3>
    <div class="form-grid">
      <div class="field"><label>入仓品</label><select id="wiProduct" onchange="wInPickProduct()">${opts}</select></div>
      <div class="field"><label>商品名称</label><input id="wiName" value="${esc(rec.product_name || "")}" /></div>
      <div class="field"><label>日期 *</label><input id="wiDate" type="date" value="${esc(rec.date || today())}" /></div>
      <div class="field"><label>采购单号</label><input id="wiPurchaseNo" value="${esc(rec.purchase_no || "")}" /></div>
      <div class="field"><label>配送中心</label><input id="wiCenter" value="${esc(rec.center || "")}" /></div>
      <div class="field"><label>数量（袋）*</label><input id="wiQty" type="number" step="any" min="0" value="${rec.quantity ?? ""}" oninput="wInCalc()" /></div>
      <div class="field"><label>箱数</label><input id="wiBoxCount" type="number" step="any" min="0" value="${rec.box_count ?? ""}" /></div>
      <div class="field"><label>箱规（袋/箱）</label><input id="wiBoxSpec" type="number" step="any" min="0" value="${rec.box_spec ?? ""}" /></div>
      <div class="field"><label>每袋净重（默认单位）</label><input id="wiBagWeight" type="number" step="any" min="0" value="${rec.bag_weight ?? ""}" oninput="wInCalc()" /></div>
      <div class="field"><label>采购价（元/袋，收入）</label><input id="wiPrice" type="number" step="any" min="0" value="${rec.unit_price ?? ""}" oninput="wInCalc()" /></div>
      <div class="field"><label>运费（元/袋）</label><input id="wiFreight" type="number" step="any" min="0" value="${rec.freight ?? ""}" oninput="wInCalc()" /></div>
      <div class="field"><label>收入合计</label><input id="wiAmount" readonly /></div>
      <div class="field"><label>商品成本</label><input id="wiCogs" readonly /></div>
      <div class="field"><label>运费合计</label><input id="wiFreightTotal" readonly /></div>
      <div class="field"><label>毛利</label><input id="wiProfit" readonly /></div>
      <div class="field" style="grid-column:1/-1;"><label>备注</label><input id="wiRemark" value="${esc(rec.remark || "")}" /></div>
    </div>
    <p class="hint" id="wiCostHint" style="margin-top:8px;"></p>
    <div class="modal-foot">
      <button class="btn secondary" onclick="closeModal()">取消</button>
      <button class="btn green" onclick="wInSave(${rec.id || 0})">✓ 保存</button>
    </div>`);
  const sel = $("wiProduct");
  const p0 = (WPROD || []).find((x) => x.id === +sel.value);
  sel.dataset.uc = p0 ? (p0.stock_unit_cost || 0) : 0;
  wInCalc();
}
function wInPickProduct() {
  const sel = $("wiProduct");
  const p = (WPROD || []).find((x) => x.id === +sel.value);
  sel.dataset.uc = p ? (p.stock_unit_cost || 0) : 0;
  if (!p) { wInCalc(); return; }
  $("wiName").value = p.name;
  $("wiPrice").value = p.purchase_price || "";
  $("wiFreight").value = p.freight || "";
  $("wiBoxSpec").value = p.box_spec || "";
  $("wiBagWeight").value = p.bag_weight || "";
  wInCalc();
}
function wInCalc() {
  const sel = $("wiProduct");
  const p = (WPROD || []).find((x) => x.id === +sel.value);
  const uc = +(sel.dataset.uc || (p ? p.stock_unit_cost : 0) || 0);
  const pct = WIN_DEDUCT || 0;
  const qty = parseFloat($("wiQty").value) || 0;
  const price = parseFloat($("wiPrice").value) || 0;
  const freight = parseFloat($("wiFreight").value) || 0;
  const bw = parseFloat($("wiBagWeight").value) || 0;
  const revenue = qty * price * (1 - pct / 100);
  const cogs = qty * bw * uc;
  const ft = qty * freight;
  $("wiAmount").value = revenue.toFixed(2);
  $("wiCogs").value = cogs.toFixed(2);
  $("wiFreightTotal").value = ft.toFixed(2);
  $("wiProfit").value = (revenue - cogs - ft).toFixed(2);
  const hint = $("wiCostHint");
  if (hint) {
    hint.textContent = p && p.stock_product_name
      ? `收入 = 采购价 × (1 − 扣点${fmtNum(pct)}%)；成本来源：${p.stock_product_name}，单位成本 ${fmtMoney(uc)}/${p.stock_default_unit || "单位"}`
      : `扣点 ${fmtNum(pct)}%；未关联库存商品：商品成本按 0 计。`;
  }
}
async function openWarehouseInAdd() {
  if (!(WPROD || []).length) { try { WPROD = await api("/api/warehouse-in/products"); } catch (e) {} }
  if (!WPROD.length) { toast("请先新增入仓品资料"); return; }
  wInFormModal({ date: today() });
}
function wInEdit(id) {
  const r = (WINS || []).find((x) => x.id === id);
  if (r) wInFormModal(r);
}
async function wInSave(id) {
  const pid = +$("wiProduct").value || null;
  const name = ($("wiName").value || "").trim();
  const qty = parseFloat($("wiQty").value);
  if (!pid && !name) { toast("请选择入仓品或填写名称"); return; }
  if (!qty || qty <= 0) { toast("请填写有效数量"); return; }
  const body = {
    product_id: pid,
    product_name: name || (pid ? "" : name),
    purchase_no: $("wiPurchaseNo").value.trim(),
    center: $("wiCenter").value.trim(),
    quantity: qty,
    box_count: parseFloat($("wiBoxCount").value) || 0,
    box_spec: parseFloat($("wiBoxSpec").value) || 0,
    unit_price: parseFloat($("wiPrice").value) || 0,
    freight: parseFloat($("wiFreight").value) || 0,
    bag_weight: parseFloat($("wiBagWeight").value) || 0,
    date: $("wiDate").value || today(),
    remark: $("wiRemark").value.trim(),
  };
  try {
    if (id) await api("/api/warehouse-in/" + id, "PUT", body);
    else await api("/api/warehouse-in", "POST", body);
    toast("已保存");
    closeModal();
    refreshWinView();
  } catch (e) { toast("保存失败：" + e.message); }
}
async function wInDelete(id) {
  if (!confirm("确认删除该入仓记录？")) return;
  try { await api("/api/warehouse-in/" + id, "DELETE"); toast("已删除"); refreshWinView(); }
  catch (e) { toast("删除失败：" + e.message); }
}

/* ---------- 导入《入仓配送明细》常温贴单 ---------- */
function openWarehouseInImport() {
  WIMPORT = null; WI_FILE = null;
  openModal(`
    <h3>导入《入仓配送明细》常温贴单 <button class="close" onclick="closeModal()">✕</button></h3>
    <p class="hint" style="margin-bottom:12px;">
      上传《入仓配送明细》后选择工作表（默认「常温贴单」）；系统按每行「商品名称 + 数量」自动匹配入仓品，
      确认后按对应数量入仓。未匹配的行可手动选择入仓品，运费可留空后续维护。
    </p>
    <div class="form-grid">
      <div class="field"><label>Excel 文件 *</label><input type="file" id="wiFile" accept=".xlsx" /></div>
      <div class="field"><label>入仓日期</label><input id="wiImportDate" type="date" value="${today()}" /></div>
    </div>
    <div class="modal-foot">
      <button class="btn secondary" onclick="closeModal()">取消</button>
      <button class="btn" onclick="wImportStart()">解析预览</button>
    </div>`);
}
function wImportStart() {
  const f = $("wiFile")?.files[0];
  if (!f) { toast("请先选择 Excel 文件"); return; }
  WI_FILE = f;
  wImportPreview("");
}
async function wImportPreview(sheet) {
  if (!WI_FILE) { toast("请先选择 Excel 文件"); return; }
  const dateVal = $("wiImportDate")?.value || today();
  $("modalBox").innerHTML =
    `<h3>导入《入仓配送明细》常温贴单 <button class="close" onclick="closeModal()">✕</button></h3>` +
    `<div id="wiImportResult"><div class="alert ok">⏳ 正在解析…</div></div>`;
  $("modalBox").classList.add("wide");
  const out = $("wiImportResult");
  try {
    const fd = new FormData();
    fd.append("file", WI_FILE);
    fd.append("sheet", sheet || "");
    fd.append("date", dateVal);
    const res = await fetch(routePath("/api/warehouse-in/import/preview"), { method: "POST", body: fd });
    if (res.status === 401) { showLogin(); return; }
    if (!res.ok) { let m = "解析失败"; try { m = (await res.json()).detail || m; } catch (e) {} throw new Error(m); }
    const d = await res.json();
    WIMPORT = d;
    renderWImportPreview(d, dateVal);
  } catch (e) {
    out.innerHTML = `<div class="alert err">解析失败：${esc(e.message)}</div>
      <div class="modal-foot">
        <button class="btn secondary" onclick="openWarehouseInImport()">重新选择文件</button>
      </div>`;
  }
}
function renderWImportPreview(d, dateVal) {
  const box = $("wiImportResult");
  const sheets = (d.sheets || []).map((s) => `<option ${s === d.sheet ? "selected" : ""}>${esc(s)}</option>`).join("");
  const opts = (selId) => ['<option value="">（不关联）</option>']
    .concat((WPROD || []).map((x) => `<option value="${x.id}" ${selId === x.id ? "selected" : ""}>${esc(x.name)}</option>`)).join("");
  const rows = d.items || [];
  box.innerHTML = `
    <div class="toolbar" style="margin:12px 0 8px;">
      <label class="muted">工作表</label>
      <select id="wiSheetSel" onchange="wImportPreview(this.value)">${sheets}</select>
      <label class="muted">日期</label>
      <input id="wiImportDate" type="date" value="${esc(dateVal || d.date || today())}" />
      <span class="muted">解析 <b>${rows.length}</b> 行${d.failed_count ? `（<span style="color:var(--red)">${d.failed_count} 行异常</span>）` : ""}</span>
      <div class="grow"></div>
      <span class="muted" id="wiImportTotal"></span>
    </div>
    <div class="table-wrap" style="max-height:46vh;overflow:auto;">
      <table id="wiImportTable">
        <thead><tr>
          <th>商品名称（贴单）</th><th>入仓品</th><th class="num">箱数</th><th class="num">数量(袋)</th>
          <th class="num">每袋净重</th><th class="num">采购价(收入)</th><th class="num">运费</th><th class="num">商品成本</th>
        </tr></thead>
        <tbody>${rows.map((r, i) => `<tr data-i="${i}" data-uc="${r.unit_cost || 0}" data-pct="${r.deduction_percent || 0}">
          <td>${esc(r.product_name)}
            <div class="muted" style="font-size:12px;">${esc(r.purchase_no) || "—"} · ${esc(r.center) || "—"}</div>
          </td>
          <td><select class="wi-prod" onchange="wImportPick(${i})">${opts(r.product_id)}</select>
            <div class="muted" style="font-size:12px;">${esc(r.stock_product_name) || "未关联库存商品"}${r.deduction_percent ? ` · 扣点 ${fmtNum(r.deduction_percent)}%` : ""}</div></td>
          <td><input class="wi-box" type="number" step="any" min="0" value="${r.box_count || ""}" style="width:58px;" /></td>
          <td><input class="wi-qty" type="number" step="any" min="0" value="${r.quantity}" style="width:68px;" oninput="wImportCalc()" /></td>
          <td><input class="wi-weight" type="number" step="any" min="0" value="${r.bag_weight || ""}" style="width:72px;" oninput="wImportCalc()" /></td>
          <td><input class="wi-price" type="number" step="any" min="0" value="${r.unit_price || ""}" style="width:70px;" oninput="wImportCalc()" /></td>
          <td><input class="wi-freight" type="number" step="any" min="0" value="${r.freight || ""}" style="width:64px;" oninput="wImportCalc()" /></td>
          <td class="num mono wi-cogs">—</td>
        </tr>`).join("")}</tbody>
      </table>
    </div>
    ${d.failed_count ? `<div class="alert err" style="margin-top:8px;">${d.failed.map((f) => `第 ${f.row} 行：${esc(f.reason)}`).join("<br>")}</div>` : ""}
    <div class="modal-foot">
      <button class="btn secondary" onclick="openWarehouseInImport()">重新选择文件</button>
      <button class="btn secondary" onclick="closeModal()">取消</button>
      <button class="btn green" onclick="wImportConfirm()">✓ 确认入仓</button>
    </div>`;
  wImportCalc();
}
function wImportPick(i) {
  const tr = document.querySelector(`#wiImportTable tr[data-i="${i}"]`);
  if (!tr) return;
  const p = (WPROD || []).find((x) => x.id === +tr.querySelector(".wi-prod").value);
  tr.dataset.uc = p ? (p.stock_unit_cost || 0) : 0;
  if (p) {
    tr.querySelector(".wi-price").value = p.purchase_price || "";
    tr.querySelector(".wi-freight").value = p.freight || "";
    if (p.bag_weight) tr.querySelector(".wi-weight").value = p.bag_weight;
    const sub = tr.querySelector("td:nth-child(2) .muted");
    if (sub) sub.textContent = (p.stock_product_name || "未关联库存商品") + (WIN_DEDUCT ? ` · 扣点 ${fmtNum(WIN_DEDUCT)}%` : "");
  }
  wImportCalc();
}
function wImportCalc() {
  let rev = 0, cogs = 0, ft = 0, qtySum = 0;
  document.querySelectorAll("#wiImportTable tbody tr").forEach((tr) => {
    const q = parseFloat(tr.querySelector(".wi-qty").value) || 0;
    const pr = parseFloat(tr.querySelector(".wi-price").value) || 0;
    const fr = parseFloat(tr.querySelector(".wi-freight").value) || 0;
    const bw = parseFloat(tr.querySelector(".wi-weight").value) || 0;
    const uc = +(tr.dataset.uc || 0);
    const pct = +(tr.dataset.pct || 0);
    const rowCogs = q * bw * uc;
    const cell = tr.querySelector(".wi-cogs");
    if (cell) cell.textContent = fmtMoney(rowCogs);
    rev += q * pr * (1 - pct / 100); cogs += rowCogs; ft += q * fr; qtySum += q;
  });
  const el = $("wiImportTotal");
  if (el) el.innerHTML = `数量 <b>${fmtNum(qtySum)}</b> 袋 · 收入 <b>${fmtMoney(rev)}</b> · 成本 <b>${fmtMoney(cogs)}</b> · 运费 <b>${fmtMoney(ft)}</b> · 毛利 <b style="color:var(--green)">${fmtMoney(rev - cogs - ft)}</b>`;
}
async function wImportConfirm() {
  if (!WIMPORT) { toast("请先解析预览"); return; }
  const items = [];
  document.querySelectorAll("#wiImportTable tbody tr").forEach((tr) => {
    const base = WIMPORT.items[+tr.dataset.i] || {};
    const pid = +tr.querySelector(".wi-prod").value || null;
    const p = (WPROD || []).find((x) => x.id === pid);
    const q = parseFloat(tr.querySelector(".wi-qty").value) || 0;
    if (q <= 0) return;
    items.push({
      product_id: pid,
      product_name: p ? p.name : base.product_name,
      category: p ? p.category : (base.category || ""),
      unit: "袋",
      purchase_no: base.purchase_no || "",
      center: base.center || "",
      quantity: q,
      box_count: parseFloat(tr.querySelector(".wi-box").value) || 0,
      box_spec: base.box_spec || 0,
      unit_price: parseFloat(tr.querySelector(".wi-price").value) || 0,
      freight: parseFloat(tr.querySelector(".wi-freight").value) || 0,
      bag_weight: parseFloat(tr.querySelector(".wi-weight").value) || 0,
      date: $("wiImportDate")?.value || today(),
      remark: "",
    });
  });
  if (!items.length) { toast("没有可入仓的数据"); return; }
  try {
    const r = await api("/api/warehouse-in/import/confirm", "POST", { date: $("wiImportDate")?.value || today(), items });
    toast(`已入仓 ${r.created} 条${r.failed_count ? `，${r.failed_count} 条失败` : ""}`);
    closeModal();
    loadWarehouseIns();
  } catch (e) { toast("入仓失败：" + e.message); }
}

function loadImportPage() {}

/* =============== 备份与恢复 =============== */
async function loadBackupPage() {
  try {
    const d = await api("/api/backups");
    $("bkEnabled").checked = !!d.config.enabled;
    $("bkInterval").value = d.config.interval_hours;
    $("bkKeep").value = d.config.keep;
    $("bkStatus").textContent = d.config.enabled
      ? `自动备份已开启：每 ${d.config.interval_hours} 小时一次，保留最近 ${d.config.keep} 份`
      : "自动备份已关闭";
    renderBkTable(d.backups || []);
  } catch (e) { toast("加载备份失败：" + e.message); }
}
function renderBkTable(list) {
  const t = $("bkTable");
  t.innerHTML = `<thead><tr>
    <th>备份文件</th><th class="num">大小</th><th>创建时间</th><th>操作</th>
  </tr></thead><tbody>` +
    (list.length ? list.map((b) => `<tr>
      <td class="mono">${esc(b.name)}</td>
      <td class="num mono">${esc(b.size_human)}</td>
      <td class="muted mono">${esc(b.mtime)}</td>
      <td class="line-actions">
        <button class="btn sm secondary" onclick="restoreBackup('${esc(b.name)}')">恢复</button>
        <button class="btn sm danger" onclick="deleteBackup('${esc(b.name)}')">删除</button>
      </td></tr>`).join("")
      : `<tr><td colspan="4" class="empty">暂无备份，点击右上角「立即备份」</td></tr>`) +
    `</tbody>`;
}
async function createBackup() {
  try {
    const r = await api("/api/backup", "POST");
    toast("备份成功：" + r.name);
    renderBkTable(r.backups || []);
  } catch (e) { toast("备份失败：" + e.message); }
}
async function saveBkConfig() {
  try {
    await api("/api/backup/config", "POST", {
      enabled: $("bkEnabled").checked,
      interval_hours: +$("bkInterval").value || 2,
      keep: +$("bkKeep").value || 30,
    });
    toast("自动备份设置已保存");
    loadBackupPage();
  } catch (e) { toast("保存失败：" + e.message); }
}
async function restoreBackup(name) {
  if (!confirm(`确认用「${name}」恢复？\n当前数据库将被该备份覆盖，且不可撤销。`)) return;
  if (!confirm("再次确认：恢复会覆盖现有全部数据，建议先「立即备份」一份。确定继续？")) return;
  try {
    const r = await api("/api/backup/restore", "POST", { name });
    toast("恢复成功，正在刷新数据…");
    setTimeout(() => location.reload(), 800);
  } catch (e) { toast("恢复失败：" + e.message); }
}
async function deleteBackup(name) {
  if (!confirm(`确认删除备份「${name}」？`)) return;
  try {
    const r = await api("/api/backup/" + encodeURIComponent(name), "DELETE");
    toast("已删除备份");
    renderBkTable(r.backups || []);
  } catch (e) { toast("删除失败：" + e.message); }
}

/* =============== 设置 · 商品资料备份（解耦 JSON） =============== */
const PDATA_KINDS = {
  units: "units.json", products_stock: "products_stock.json",
  products_order: "products_order.json", pack_rules: "pack_rules.json",
  code_mappings: "code_mappings.json",
};
async function loadPdataPage() {
  try {
    const s = await api("/api/product-data/status");
    $("pdataDir").textContent = "json 目录：" + s.dir;
    renderPdataTable(s.rows || []);
  } catch (e) { toast("加载商品资料状态失败：" + e.message); }
}
function renderPdataTable(rows) {
  $("pdataTable").innerHTML = `<thead><tr>
    <th>类型</th><th>json 文件</th><th class="num">库内数</th><th class="num">json 数</th><th>备份状态</th><th>操作</th>
  </tr></thead><tbody>` +
    (rows.length ? rows.map((r) => {
      const state = !r.exists
        ? `<span class="badge">未备份</span>`
        : `<span class="badge" style="background:var(--ok,#16a34a);color:#fff;">已备份 ${esc(r.mtime || "")}</span>`;
      return `<tr>
        <td>${esc(r.label)}</td>
        <td class="mono">${esc(r.file)}</td>
        <td class="num mono">${r.count_in_db}</td>
        <td class="num mono">${r.exists ? r.count_in_file : "-"}</td>
        <td>${state}</td>
        <td class="line-actions">
          <button class="btn sm secondary" onclick="pdataDownload('${r.kind}')">下载</button>
          <button class="btn sm" ${r.exists ? "" : "disabled"} onclick="pdataImportOne('${r.kind}')">导入</button>
        </td>
      </tr>`;
    }).join("") : `<tr><td colspan="6" class="empty">暂无数据</td></tr>`) + `</tbody>`;
}
async function pdataExportAll() {
  try {
    const r = await api("/api/product-data/export", "POST");
    toast("已导出 " + (r.files || []).length + " 个 json 到服务器目录");
    loadPdataPage();
  } catch (e) { toast("导出失败：" + e.message); }
}
async function pdataImportAll() {
  if (!confirm("从 json 目录一键导入全部 5 类？将按名称新增/更新（upsert），不会删除已有数据。")) return;
  try {
    const r = await api("/api/product-data/import", "POST");
    renderPdataImportResult(r.results || []);
    loadPdataPage();
  } catch (e) { toast("导入失败：" + e.message); }
}
async function pdataImportOne(kind) {
  if (!confirm("从 json 目录导入「" + kind + "」？将按名称新增/更新，不会删除已有数据。")) return;
  try {
    const r = await api("/api/product-data/import/" + kind, "POST");
    renderPdataImportResult([r]);
    loadPdataPage();
  } catch (e) { toast("导入失败：" + e.message); }
}
function renderPdataImportResult(results) {
  const rows = (results || []).map((s) => `<tr>
    <td>${esc(s.label)}</td>
    <td class="num">${s.created || 0} 新增</td>
    <td class="num">${s.updated || 0} 更新</td>
    <td>${s.loaded === false ? '<span class="badge">未加载</span>' : ""}
      ${(s.warnings || []).map((w) => `<div class="hint">${esc(w)}</div>`).join("")}</td>
  </tr>`).join("");
  $("pdataResult").innerHTML = `<div class="alert ok">导入完成</div>
    <div class="table-wrap"><table>
      <thead><tr><th>类型</th><th class="num">新增</th><th class="num">更新</th><th>备注</th></tr></thead>
      <tbody>${rows}</tbody></table></div>`;
  bindSearchable($("pdataResult"));
}
async function pdataDownload(kind) {
  try {
    const data = await api("/api/product-data/" + kind);
    if (data && data.error) { toast(data.error); return; }
    downloadJson(data, PDATA_KINDS[kind]);
  } catch (e) { toast("导出失败：" + e.message); }
}
function downloadJson(obj, filename) {
  const blob = new Blob([JSON.stringify(obj, null, 2)], { type: "application/json;charset=utf-8" });
  const a = document.createElement("a");
  a.href = URL.createObjectURL(blob);
  a.download = filename;
  document.body.appendChild(a);
  a.click();
  setTimeout(() => { URL.revokeObjectURL(a.href); a.remove(); }, 200);
}
async function pdataUploadImport() {
  const f = $("pdataUploadFile").files[0];
  if (!f) { toast("请先选择 json 文件"); return; }
  let payload;
  try { payload = JSON.parse(await readFileText(f)); }
  catch (e) { toast("JSON 解析失败：" + e.message); return; }
  const kind = payload && payload.kind;
  if (!kind || !PDATA_KINDS[kind]) { toast("无法识别文件类型：json 需含 kind 字段（可在本页下载对应 json 参考结构）"); return; }
  if (!confirm(`本地上传导入「${kind}」？将按名称新增/更新，不会删除已有数据。`)) return;
  try {
    const r = await api("/api/product-data/import-one", "POST", { payload });
    renderPdataImportResult([r]);
    loadPdataPage();
    toast("导入完成");
  } catch (e) { toast("导入失败：" + e.message); }
}

/* =============== 商品 =============== */
function productOptions(selected = 0, includeAll = false) {
  const NO_STOCK_CATS = ["人工", "快递"]; // 无真实库存，不可盘点调整
  let html = includeAll ? '<option value="0">全部商品</option>' : "";
  html += PRODUCTS.filter((p) => p.is_active && !NO_STOCK_CATS.includes(p.category)).map((p) =>
    `<option value="${p.id}" ${p.id === selected ? "selected" : ""}>${esc(p.name)}</option>`
  ).join("");
  return html;
}
/* 可销售商品：排除 人工/快递（自动结算，非销售商品）；包材/订单/库存均可售 */
function saleProducts() {
  return PRODUCTS.filter((p) => p.is_active && !["人工", "快递"].includes(p.category));
}
function unitOptions(product, selected) {
  const convs = product?.conversions || {};
  return Object.keys(convs).map((u) =>
    `<option value="${u}" ${u === selected ? "selected" : ""}>${u}</option>`
  ).join("");
}

async function renderProducts() {
  if (!PRODUCTS.length) PRODUCTS = await api("/api/products");
  const EXCLUDED = ["包材", "人工", "快递"]; // 已独立成侧边栏入口的分类，商品页默认不显示
  const forced = prodForceCat || "";
  const isOrderPage = prodForceType === "order"; // 关联结算页：仅订单商品
  // 独立页：改标题、提示
  const ttl = $("prodPageTitle");
  if (ttl) ttl.textContent = isOrderPage ? "关联结算管理" : (forced ? forced + "管理" : "商品管理");
  const ph = $("prodPageHint");
  if (ph) ph.textContent = isOrderPage
    ? "仅显示订单商品，可在此维护库存扣减与关联结算清单"
    : (forced ? `仅显示「${forced}」分类，可在此新增 / 编辑 / 批量操作` : "已按分类独立管理 包材 / 人工 / 快递 / 关联结算");
  const catSel = $("prodCategory");
  if (catSel) {
    catSel.style.display = forced ? "none" : "";
    const scombo = catSel.nextElementSibling;
    if (scombo && scombo.classList.contains("scombo")) scombo.style.display = forced ? "none" : "";
    // 进入独立页时重置分类筛选，避免沿用主页面残留的分类（联动可搜索下拉文本）
    if ((forced || isOrderPage) && catSel.value) {
      catSel.value = "";
      const inp = scombo && scombo.querySelector && scombo.querySelector(".scombo-input");
      if (inp) inp.value = "";
    }
  }
  // 类型筛选下拉：独立入口（包材/人工/快递/关联结算）隐藏
  const typeSel = $("prodType");
  if (typeSel) {
    typeSel.style.display = (forced || isOrderPage) ? "none" : "";
    const tcombo = typeSel.nextElementSibling;
    if (tcombo && tcombo.classList.contains("scombo")) tcombo.style.display = (forced || isOrderPage) ? "none" : "";
  }
  // 分类筛选下拉（仅商品页展示，排除独立分类）
  if (catSel && catSel.options.length <= 1) {
    const cats = [...new Set(PRODUCTS.map((p) => p.category).filter((c) => c && !EXCLUDED.includes(c)))];
    cats.sort();
    catSel.insertAdjacentHTML("beforeend", cats.map((c) => `<option value="${esc(c)}">${esc(c)}</option>`).join(""));
  }
  const kw = ($("prodSearch")?.value || "").trim().toLowerCase();
  const cat = forced ? "" : (catSel ? catSel.value : "");
  const ptype = $("prodType")?.value || "";
  let rows = PRODUCTS.filter((p) =>
    (!kw || p.name.toLowerCase().includes(kw) || p.category.toLowerCase().includes(kw)) &&
    (!cat || p.category === cat) &&
    (isOrderPage ? p.product_type === "order"
      : (forced ? p.category === forced : !EXCLUDED.includes(p.category))) &&
    (isOrderPage || !ptype || p.product_type === ptype)
  );
  const t = $("prodTable");
  // 独立页默认按名称、商品页默认按库存升序排序（用户手动点击表头后保持其排序）
  if (!t._sort) t._sort = isOrderPage ? { key: "name", dir: 1 } : { key: "stock", dir: 1 };
  rows = applyTableSort(t, rows);
  t.innerHTML = `<thead><tr>
    <th class="cb-col"><input type="checkbox" onclick="toggleAll(this,'prod')" /></th>
    <th data-key="code">编码${sortArrow("prodTable", "code")}</th>
    <th data-key="name">商品${sortArrow("prodTable", "name")}</th>
    <th data-key="category">类型${sortArrow("prodTable", "category")}</th>
    <th>关联结算清单</th>
    <th data-key="avg_cost" class="num">参考成本(默认单位)${sortArrow("prodTable", "avg_cost")}</th>
    <th data-key="pack_fee" class="num">打包费/单${sortArrow("prodTable", "pack_fee")}</th>
    <th data-key="stock" class="num">库存(默认单位)${sortArrow("prodTable", "stock")}</th>
    <th>状态</th><th>操作</th></tr></thead><tbody>` +
    rows.map((p) => {
      const packs = (p.pack_items || []).map((it) => {
        const m = PRODUCTS.find((x) => x.id === it.product_id);
        return `${esc(m ? m.name : "?")}×${fmtNum(it.quantity)}${it.unit}`;
      }).join("，");
      const typeBadge = p.product_type === "order"
        ? '<span class="badge income">订单</span>'
        : '<span class="badge adjust">库存</span>';
      const linkInfo = p.product_type === "order"
        ? (p.stock_product_id ? `扣减：${esc(p.stock_product_name || "?")} ×${fmtNum(p.multiplier)}` : '<span style="color:var(--red)">未关联库存商品</span>')
        : (p.spec || "");
      const isLabor = p.category === "人工";
      const stockShown = p.product_type === "order" && p.stock_product_name
        ? `<span class="muted">经库存商品</span>`
        : isLabor
          ? `<span class="badge income">工作量 ${fmtNum(p.workload)} 单</span>`
          : fmtStock(p);
      return `<tr>
        <td class="cb-col"><input type="checkbox" value="${p.id}" ${prodSel.has(p.id) ? "checked" : ""} onchange="toggleSel('prod',${p.id},this.checked)" /></td>
        <td class="muted mono">${esc(p.code) || "—"}</td>
        <td><b>${typeBadge} ${esc(p.name)}</b><div class="muted" style="font-size:12px;">${esc(linkInfo)}</div></td>
        <td>${esc(p.category) ? `<span class="badge adjust">${esc(p.category)}</span>` : "—"}</td>
        <td class="muted" style="max-width:170px;">${esc(packs) || "—"}</td>
        <td class="num mono">${refCostHtml(p)}</td>
        <td class="num">${fmtMoney(p.pack_fee)}</td>
        <td class="num mono">${stockShown}</td>
        <td>${p.is_active ? '<span class="badge in">启用</span>' : '<span class="badge off">停用</span>'}</td>
        <td class="line-actions">
          <button class="btn sm secondary" onclick="openProductModal(${p.id})">编辑</button>
        </td></tr>`;
    }).join("") + `</tbody>`;
  if (!rows.length) t.innerHTML = `<tr><td colspan="10" class="empty">暂无商品</td></tr>`;
  t._rows = rows;
  t._render = renderProducts;
  updateBatchBar("prod");
}

/* ---------- 计量单位管理 ---------- */
async function openUnitsModal() {
  const units = await api("/api/units");
  openModal(`
    <h3>计量单位管理 <button class="close" onclick="closeModal()">✕</button>
      <button class="btn sm secondary" style="float:right;" onclick="pdataDownload('units')"><svg class="ic"><use href="#i-download"/></svg> 导出JSON</button></h3>
    <p class="hint" style="margin-bottom:12px;">重量类单位需填写「每单位克数」，如 斤=500克；计数类按商品自行设置换算。标准单位不可删除。</p>
    <div class="table-wrap"><table>
      <thead><tr><th>单位</th><th>类型</th><th>每单位克数</th><th></th></tr></thead>
      <tbody>${units.map((u) => `<tr>
        <td><b>${esc(u.name)}</b></td>
        <td>${u.category === "weight" ? '<span class="badge adjust">重量</span>' : '<span class="badge off">计数</span>'}</td>
        <td class="mono">${u.gram_per_unit ? `${fmtNum(u.gram_per_unit)} 克` : "—"}</td>
        <td>${u.is_standard ? "" : `<button class="btn sm danger" onclick="deleteUnit(${u.id}, '${esc(u.name)}')">删</button>`}</td>
      </tr>`).join("")}</tbody>
    </table></div>
    <hr />
    <h4 class="block-title">新增单位</h4>
    <div class="form-grid">
      <div class="field"><label>单位名称 *</label><input id="unitName" placeholder="如：提、扎" /></div>
      <div class="field"><label>类型 *</label><select id="unitCategory"><option value="count">计数（个/袋/包…）</option><option value="weight">重量（克/斤/公斤…）</option></select></div>
      <div class="field"><label>每单位克数（重量类必填）</label><input id="unitGram" type="number" step="any" placeholder="如 500" /></div>
    </div>
    <div class="modal-foot">
      <button class="btn secondary" onclick="closeModal()">取消</button>
      <button class="btn" onclick="submitUnit()">新增单位</button>
    </div>`);
}
async function submitUnit() {
  try {
    await api("/api/units", "POST", {
      name: $("unitName").value, category: $("unitCategory").value,
      gram_per_unit: $("unitCategory").value === "weight" ? (+$("unitGram").value || null) : null,
    });
    toast("单位已新增"); closeModal(); UNITS = await api("/api/units");
  } catch (e) { toast("新增失败：" + e.message); }
}
async function deleteUnit(id, name) {
  if (!confirm(`确认删除单位「${name}」？`)) return;
  try { await api("/api/units/" + id, "DELETE"); toast("已删除"); closeModal(); openUnitsModal(); }
  catch (e) { toast("删除失败：" + e.message); }
}

function packRowsHtml(packItems) {
  const items = packItems || [];
  return items.map((it, i) => {
    const m = PRODUCTS.find((x) => x.id === it.product_id);
    const unitSel = m ? unitOptions(m, it.unit) : `<option>个</option>`;
    return `<div class="pack-row">
      <input value="${esc(m ? m.name : it.product_id)}" readonly style="background:#f9fafb;" />
      <select class="pack-unit searchable" onchange="packUnitChanged(this)">${unitSel}</select>
      <input type="number" step="any" value="${it.quantity}" class="pack-qty" />
      <button class="btn danger sm" onclick="this.closest('.pack-row').remove()">删</button>
    </div>`;
  }).join("") + `
    <div class="pack-row">
      <select class="pack-product searchable" onchange="packProductChanged(this)">
        <option value="">选择关联商品…</option>
        ${PRODUCTS.filter((p) => p.is_active).map((p) => `<option value="${p.id}">${esc(p.name)}</option>`).join("")}
      </select>
      <select class="pack-unit searchable"><option>个</option></select>
      <input type="number" step="any" value="1" class="pack-qty" />
      <button class="btn secondary sm" onclick="addPackRow()">＋</button>
    </div>`;
}
function packProductChanged(sel) {
  const row = sel.closest(".pack-row");
  const m = PRODUCTS.find((x) => x.id === +sel.value);
  row.querySelector(".pack-unit").innerHTML = m ? unitOptions(m) : `<option>个</option>`;
}
function packUnitChanged(sel) {}
function addPackRow() {
  const box = $("packRows");
  const last = box.querySelector(".pack-row:last-child");
  const sel = last.querySelector(".pack-product");
  const qty = last.querySelector(".pack-qty").value;
  const unit = last.querySelector(".pack-unit").value;
  if (!sel || !sel.value || !qty) { toast("请选择关联商品并填数量"); return; }
  const m = PRODUCTS.find((x) => x.id === +sel.value);
  // 把已填的行转为只读展示，再追加一行
  last.innerHTML = `
    <input value="${esc(m.name)}" readonly style="background:#f9fafb;" />
    <select class="pack-unit" onchange="packUnitChanged(this)">${unitOptions(m, unit)}</select>
    <input type="number" step="any" value="${qty}" class="pack-qty" />
    <button class="btn danger sm" onclick="this.closest('.pack-row').remove()">删</button>`;
  box.insertAdjacentHTML("beforeend", `
    <div class="pack-row">
      <select class="pack-product" onchange="packProductChanged(this)">
        <option value="">选择关联商品…</option>
        ${PRODUCTS.filter((p) => p.is_active).map((p) => `<option value="${p.id}">${esc(p.name)}</option>`).join("")}
      </select>
      <select class="pack-unit"><option>个</option></select>
      <input type="number" step="any" value="1" class="pack-qty" />
      <button class="btn secondary sm" onclick="addPackRow()">＋</button>
    </div>`);
}

function openProductModal(pid = 0) {
  const p = pid ? PRODUCTS.find((x) => x.id === pid) : null;
  const ptype = p ? p.product_type : "stock";
  const curUnit = p ? (p.default_unit || p.base_unit) : "斤";
  const curCat = p ? p.category : (prodForceCat || ""); // 独立分类页新增时自动带上分类
  openModal(`
    <h3>${pid ? "编辑商品" : "新增商品"} <button class="close" onclick="closeModal()">✕</button></h3>
    <div class="form-grid">
      <div class="field"><label>商品编码</label><input id="pCode" value="${esc(p?.code || "")}" placeholder="如 ydj001，可留空" /></div>
      <div class="field"><label>商品名称 *</label><input id="pName" value="${esc(p?.name || "")}" placeholder="如：佛手柑大果2个" /></div>
      <div class="field"><label>分类</label><input id="pCategory" value="${esc(curCat)}" placeholder="如：蔬菜" /></div>
      <div class="field"><label>商品类型 *</label>
        <select id="pType" onchange="pTypeChanged()">
          <option value="stock" ${ptype === "stock" ? "selected" : ""}>库存商品（大类·真实库存）</option>
          <option value="order" ${ptype === "order" ? "selected" : ""}>订单商品（小类·出库销售）</option>
        </select></div>
      <div class="field"><label>单位</label><select id="pUnit" class="searchable"></select><div class="field-hint">重量类按克记账（1斤=500克），计数类按个记账；订单商品固定为「单」</div></div>
      <div class="field"><label>默认售价（每基础单位）</label><input id="pSalePrice" type="number" step="any" value="${p?.sale_price || 0}" /></div>
      <div class="field"><label>参考成本（每基础单位）</label><input id="pUnitCost" type="number" step="any" value="${p?.unit_cost || 0}" /><div class="field-hint">包材/人工等无入库时按此成本结算，如纸箱0.9元/个</div></div>
      <div class="field" id="pWeightBox"><label>单件净重（kg）</label><input id="pWeightKg" type="number" step="any" value="${p?.weight_kg || 0}" /><div class="field-hint">用于计算快递费。重量类库存自动按「扣减库存量」推导；按袋/按件等计数库存推不出重量时，就用这里手填的净重兜底（如 四神汤200g 填 0.2）</div></div>
    </div>
    <div id="pStockBox" class="form-grid" style="margin-top:10px;display:${ptype === "order" ? "grid" : "none"};">
      <div class="field"><label>关联库存商品（大类）*</label><select id="pStockLink" class="searchable"><option value="">— 加载中… —</option></select><div class="field-hint">出库时从该大类扣减库存，可输入名称快速筛选</div></div>
      <div class="field"><label>倍数（1单订单 = ? 库存单位）*</label><input id="pMultiplier" type="number" step="any" value="${p?.multiplier || 1}" /><div class="field-hint">如 佛手柑大果2个 → 倍数2：卖1单扣 2个 佛手柑大果</div></div>
    </div>
    <div class="field" style="margin-top:10px;"><label>规格说明</label><input id="pSpec" value="${esc(p?.spec || "")}" placeholder="如：每个约150克；或每袋5斤" /></div>
    <hr />
    <h3>出库关联结算清单 <span class="hint">卖1单本商品时，自动扣减这些商品的库存（包材/人工等）</span></h3>
    <div id="packRows">${packRowsHtml(p?.pack_items)}</div>
    <div class="field" style="margin-top:10px;">
      <label>固定费用（每单，如人工打包费，元）</label>
      <input id="pPackFee" type="number" step="any" value="${p?.pack_fee || 0}" />
    </div>
    ${p ? `<label style="display:flex;gap:6px;align-items:center;margin-top:10px;"><input type="checkbox" id="pActive" ${p.is_active ? "checked" : ""}/> 启用该商品</label>` : ""}
    <div class="modal-foot">
      ${p ? `<button class="btn danger" onclick="deleteProduct(${p.id})" style="margin-right:auto;">删除</button>` : ""}
      <button class="btn secondary" onclick="closeModal()">取消</button>
      <button class="btn" onclick="saveProduct(${pid || 0})">保存</button>
    </div>`);
  initProductUnitSelect(ptype, curUnit);
  // 加载库存商品（大类）列表
  if (ptype === "order") {
    api("/api/stocks").then((stocks) => {
      const sel = $("pStockLink");
      sel.innerHTML = '<option value="">— 不关联（扣减自身）—</option>' +
        stocks.map((s) => `<option value="${s.id}" ${s.id === p?.stock_product_id ? "selected" : ""}>${esc(s.name)}（${esc(s.category) || "—"}·单位${esc(s.default_unit || s.base_unit)}）</option>`).join("");
      sel.dispatchEvent(new Event("change", { bubbles: true })); // 让可搜索下拉同步显示
    }).catch(() => { $("pStockLink").innerHTML = '<option value="">— 加载失败 —</option>'; });
  } else {
    $("pStockLink").innerHTML = '<option value="">—</option>';
  }
}
function initProductUnitSelect(ptype, curUnit) {
  const units = ptype === "order" ? ["单"] : ["克", "斤", "公斤", "千克", "个", "袋", "包", "盒", "箱", "件", "份", "单"];
  const sel = $("pUnit");
  const cur = ptype === "order" ? "单" : (units.includes(curUnit) ? curUnit : "斤");
  sel.innerHTML = units.map((u) => `<option value="${u}" ${u === cur ? "selected" : ""}>${u}</option>`).join("");
}
function deriveUnitPayload(ptype, unit) {
  if (ptype === "order" || unit === "单") return { base_unit: "单", default_unit: "单", conversions: { 单: 1 } };
  if (["克", "斤", "公斤", "千克"].includes(unit))
    return { base_unit: "克", default_unit: unit, conversions: { 克: 1, 斤: 500, 公斤: 1000, 千克: 1000 } };
  const convs = { 个: 1, [unit]: 1 };
  return { base_unit: "个", default_unit: unit, conversions: convs };
}
function pTypeChanged() {
  const t = $("pType").value;
  $("pStockBox").style.display = t === "order" ? "grid" : "none";
  initProductUnitSelect(t, $("pUnit").value);
  if (t === "order" && $("pStockLink").options.length <= 1) {
    api("/api/stocks").then((stocks) => {
      const sel = $("pStockLink");
      sel.innerHTML = '<option value="">— 不关联（扣减自身）—</option>' +
        stocks.map((s) => `<option value="${s.id}">${esc(s.name)}（${esc(s.category) || "—"}·单位${esc(s.default_unit || s.base_unit)}）</option>`).join("");
    });
  }
}
function collectPacks() {
  const out = [];
  document.querySelectorAll("#packRows .pack-row").forEach((row) => {
    const nameInput = row.querySelector("input[readonly]");
    const sel = row.querySelector(".pack-product");
    let pid = null;
    if (nameInput) {
      // 只读行：需要从显示名反查，或从原数据拿 —— 用 data 属性更稳，这里从 PRODUCTS 按名匹配
      const n = nameInput.value.trim();
      const m = PRODUCTS.find((x) => x.name === n);
      pid = m ? m.id : null;
    } else if (sel) {
      pid = sel.value ? +sel.value : null;
    }
    const unit = row.querySelector(".pack-unit").value;
    const qty = parseFloat(row.querySelector(".pack-qty").value);
    if (pid && unit && qty > 0) out.push({ product_id: pid, quantity: qty, unit });
  });
  return out;
}
async function saveProduct(pid) {
  const ptype = $("pType").value;
  const unit = $("pUnit") ? $("pUnit").value : "斤";
  const unitPayload = deriveUnitPayload(ptype, unit);
  const payload = {
    code: $("pCode").value,
    name: $("pName").value,
    category: $("pCategory").value,
    product_type: ptype,
    base_unit: unitPayload.base_unit,
    default_unit: unitPayload.default_unit,
    spec: $("pSpec").value,
    sale_price: +$("pSalePrice").value || 0,
    unit_cost: +$("pUnitCost").value || 0,
    weight_kg: +($("pWeightKg").value || 0),
    conversions: unitPayload.conversions,
    pack_items: collectPacks(),
    pack_fee: +$("pPackFee").value || 0,
    stock_product_id: ptype === "order" && $("pStockLink") ? (+$("pStockLink").value || null) : null,
    multiplier: +$("pMultiplier").value || 1,
    is_active: $("pActive") ? $("pActive").checked : true,
  };
  if (!payload.name.trim()) { toast("请填写商品名称"); return; }
  if (payload.product_type === "order" && payload.stock_product_id == null) { toast("订单商品请选择关联的库存商品（大类），或改为库存商品"); return; }
  try {
    if (pid) await api("/api/products/" + pid, "PUT", payload);
    else await api("/api/products", "POST", payload);
    closeModal(); toast("商品已保存");
    PRODUCTS = await api("/api/products");
    renderProducts();
  } catch (e) { toast("保存失败：" + e.message); }
}
async function deleteProduct(pid) {
  if (!confirm("确认删除该商品？其历史单据会一并删除，请谨慎。")) return;
  try { await api("/api/products/" + pid, "DELETE"); closeModal(); toast("已删除"); PRODUCTS = await api("/api/products"); renderProducts(); }
  catch (e) { toast("删除失败：" + e.message); }
}

/* =============== 一单多货（多货合并打包规则） =============== */
let PACK_RULES = [];
async function loadPackRules() {
  if (!PRODUCTS.length) PRODUCTS = await api("/api/products");
  PACK_RULES = await api("/api/pack-rules");
  const boxes = [...new Set(PACK_RULES.map((r) => r.box_type).filter(Boolean))].sort();
  const bs = $("prBox");
  if (bs && boxes.join() !== (bs._boxes || []).join()) {
    bs._boxes = boxes;
    bs.innerHTML = '<option value="">全部纸箱型号</option>' + boxes.map((b) => `<option value="${esc(b)}">${esc(b)}</option>`).join("");
  }
  renderPackRules();
}
function prOrderProducts() { return PRODUCTS.filter((p) => p.product_type === "order"); }
function prItemOptions(selPid, orderProds) {
  return `<option value="">— 不关联（保留下方名称）—</option>` +
    orderProds.map((p) => `<option value="${p.id}" ${selPid === p.id ? "selected" : ""}>${esc(p.name)}</option>`).join("");
}
function prStockProducts() {
  return PRODUCTS.filter((p) => p.is_active && p.product_type === "stock" && !["人工", "包材", "快递"].includes(p.category));
}
function prStockOptions(selPid) {
  return `<option value="">— 按订单商品默认 —</option>` +
    prStockProducts().map((p) => `<option value="${p.id}" ${selPid === p.id ? "selected" : ""}>${esc(p.name)}（${esc(p.category) || "—"}·单位${esc(p.default_unit || p.base_unit)}）</option>`).join("");
}
function prItemRowHtml(it) {
  it = it || {};
  const orderProds = prOrderProducts();
  let pid = it.product_id || null;
  // 商品已不存在的关联，降级为原文并取消关联
  let name = it.name || "";
  if (pid && !PRODUCTS.find((x) => x.id === pid)) { pid = null; }
  if (pid) name = (PRODUCTS.find((x) => x.id === pid)?.name) || name;
  return `<div class="pr-item-row">
    <select class="pr-item-product searchable" onchange="prItemLinked(this)">${prItemOptions(pid, orderProds)}</select>
    <input class="pr-item-name" value="${esc(name)}" placeholder="商品名称（未关联时原文）" />
    <input class="pr-item-qty" type="number" step="any" value="${it.quantity != null ? it.quantity : 1}" />
    <select class="pr-item-stock searchable" title="出库扣减目标（库存大类）">${prStockOptions(it.stock_product_id)}</select>
    <input class="pr-item-mult" type="number" step="any" min="0.0001" value="${it.multiplier != null ? it.multiplier : 1}" title="每件扣减倍数（×库存默认单位）" />
    <button class="btn danger sm" onclick="this.closest('.pr-item-row').remove()">删</button>
  </div>`;
}
function prItemLinked(sel) {
  const row = sel.closest(".pr-item-row");
  const m = PRODUCTS.find((x) => x.id === +sel.value);
  if (m) row.querySelector(".pr-item-name").value = m.name;
}
function addPrItemRow() {
  $("prItems").insertAdjacentHTML("beforeend", prItemRowHtml());
}
/* 箱型号→包材纸箱 关联 */
function prBoxProducts() {
  return PRODUCTS.filter((p) => p.is_active && p.category === "包材" && (p.name.includes("箱") || p.name.includes("纸")));
}
function prModelOf(pname) {
  const n = String(pname || "");
  if (n.endsWith("纸箱")) return n.slice(0, -2);
  if (n.endsWith("号箱")) return n.slice(0, -1);
  return n;
}
function prBoxOptions(selPid) {
  return `<option value="">自定义（下方输入型号）</option>` +
    prBoxProducts().map((p) => `<option value="${p.id}" ${selPid === p.id ? "selected" : ""}>${esc(p.name)}</option>`).join("");
}
function prBoxRowHtml(bx) {
  bx = bx || {};
  let pid = bx.product_id || null;
  let name = bx.name || "";
  if (pid && !PRODUCTS.find((x) => x.id === pid)) { pid = null; }
  if (pid) name = prModelOf(PRODUCTS.find((x) => x.id === pid)?.name) || name;
  return `<div class="pr-box-row">
    <select class="pr-box-product searchable" onchange="prBoxLinked(this)">${prBoxOptions(pid)}</select>
    <input class="pr-box-name" value="${esc(name)}" placeholder="箱型号，如 3号 / 邮政6号" />
    <input class="pr-box-qty" type="number" step="any" min="1" value="${bx.quantity != null ? bx.quantity : 1}" />
    <button class="btn danger sm" onclick="this.closest('.pr-box-row').remove()">删</button>
  </div>`;
}
function prBoxLinked(sel) {
  const row = sel.closest(".pr-box-row");
  if (sel.value) {
    const m = PRODUCTS.find((x) => x.id === +sel.value);
    if (m) row.querySelector(".pr-box-name").value = prModelOf(m.name);
  }
}
function addPrBoxRow() {
  $("prBoxItems").insertAdjacentHTML("beforeend", prBoxRowHtml());
}
function collectPrBoxItems() {
  const out = [];
  document.querySelectorAll("#prBoxItems .pr-box-row").forEach((row) => {
    const sel = row.querySelector(".pr-box-product");
    const n = (row.querySelector(".pr-box-name").value || "").trim();
    const q = parseFloat(row.querySelector(".pr-box-qty").value);
    if (!n) return;
    out.push({ product_id: sel && sel.value ? +sel.value : null, name: n, quantity: q > 0 ? q : 1 });
  });
  return out;
}
function collectPrItems() {
  const out = [];
  document.querySelectorAll("#prItems .pr-item-row").forEach((row) => {
    const sel = row.querySelector(".pr-item-product");
    const n = (row.querySelector(".pr-item-name").value || "").trim();
    const q = parseFloat(row.querySelector(".pr-item-qty").value);
    if (!n) return;
    const stockSel = row.querySelector(".pr-item-stock");
    const mult = parseFloat(row.querySelector(".pr-item-mult").value);
    out.push({
      product_id: sel && sel.value ? +sel.value : null,
      name: n,
      quantity: q > 0 ? q : 1,
      stock_product_id: stockSel && stockSel.value ? +stockSel.value : null,
      multiplier: mult > 0 ? mult : 1,
    });
  });
  return out;
}
function openPackRuleModal(rid = 0) {
  const r = rid ? PACK_RULES.find((x) => x.id === rid) : null;
  const items = (r ? r.items || [] : []).map((it) => ({ product_id: it.product_id, name: it.name, quantity: it.quantity, stock_product_id: it.stock_product_id, multiplier: it.multiplier }));
  if (!items.length) items.push({ product_id: null, name: "", quantity: 1 });
  const boxes = (r ? r.box_items || [] : []).map((bx) => ({ product_id: bx.product_id, name: bx.name, quantity: bx.quantity }));
  if (!boxes.length && r && r.box_type) {
    (r.box_type || "").split("+").forEach((part) => {
      const m = part.trim().match(/^(.*?)(?:\*(\d+))?$/);
      if (m && m[1]) boxes.push({ product_id: null, name: m[1], quantity: m[2] ? +m[2] : 1 });
    });
  }
  if (!boxes.length) boxes.push({ product_id: null, name: "", quantity: 1 });
  openModal(`
    <h3>${rid ? "编辑" : "新增"}一单多货规则 <button class="close" onclick="closeModal()">✕</button></h3>
    <div class="block-title">组合商品（多货打包：一张订单含以下多种商品）</div>
    <div id="prItems">${items.map((it) => prItemRowHtml(it)).join("")}</div>
    <button class="btn secondary sm" style="margin-top:8px;" onclick="addPrItemRow()">＋ 添加组合商品</button>
    <div class="block-title" style="margin-top:16px;">纸箱型号（关联包材纸箱） <span class="hint">选择包材商品并填数量，自动生成箱型号</span></div>
    <div id="prBoxItems">${boxes.map((bx) => prBoxRowHtml(bx)).join("")}</div>
    <button class="btn secondary sm" style="margin-top:8px;" onclick="addPrBoxRow()">＋ 添加箱型</button>
    <div class="form-grid" style="margin-top:14px;">
      <div class="field"><label>工人单价（元/单）</label><input id="prLabor" type="number" step="any" value="${r?.labor_price ?? ""}" placeholder="可空" /></div>
      <div class="field"><label>箱单比</label><input id="prRatio" type="number" step="any" min="1" value="${r?.box_ratio || 1}" /></div>
      <div class="field"><label>备注</label><input id="prRemark" value="${esc(r?.remark || "")}" placeholder="可选" /></div>
    </div>
    <label style="display:flex;gap:6px;align-items:center;margin-top:10px;"><input type="checkbox" id="prActive" ${r ? (r.is_active ? "checked" : "") : "checked"}/> 启用该规则</label>
    <div class="modal-foot">
      ${r ? `<button class="btn danger" onclick="deletePackRule(${r.id})" style="margin-right:auto;">删除</button>` : ""}
      <button class="btn secondary" onclick="closeModal()">取消</button>
      <button class="btn" onclick="savePackRule(${rid || 0})">保存</button>
    </div>`);
}
async function savePackRule(rid) {
  const items = collectPrItems();
  if (!items.length) { toast("至少填写一条组合商品"); return; }
  const body = {
    items,
    box_items: collectPrBoxItems(),
    labor_price: $("prLabor").value === "" ? null : +$("prLabor").value,
    box_ratio: +$("prRatio").value || 1,
    remark: $("prRemark").value,
    is_active: $("prActive").checked,
  };
  try {
    if (rid) await api("/api/pack-rules/" + rid, "PUT", body);
    else await api("/api/pack-rules", "POST", body);
    closeModal(); toast("规则已保存");
    PACK_RULES = await api("/api/pack-rules");
    renderPackRules();
  } catch (e) { toast("保存失败：" + e.message); }
}
async function deletePackRule(rid) {
  if (!confirm("确认删除该一单多货规则？")) return;
  try { await api("/api/pack-rules/" + rid, "DELETE"); closeModal(); toast("已删除"); PACK_RULES = await api("/api/pack-rules"); renderPackRules(); }
  catch (e) { toast("删除失败：" + e.message); }
}
function renderPackRules() {
  const kw = ($("prSearch")?.value || "").trim().toLowerCase();
  const box = $("prBox")?.value || "";
  const rows = PACK_RULES.filter((r) =>
    (!kw || r.name.toLowerCase().includes(kw) ||
      (r.items || []).some((it) => (it.name || "").toLowerCase().includes(kw)) ||
      (r.box_type || "").toLowerCase().includes(kw) ||
      (r.box_items || []).some((it) => (it.name || "").toLowerCase().includes(kw))) &&
    (!box || (r.box_type || "") === box)
  );
  const t = $("prTable");
  t.innerHTML = `<thead><tr>
    <th class="cb-col"><input type="checkbox" onclick="toggleAll(this,'pr')" /></th>
    <th>组合（一单多货）</th><th>纸箱型号（关联包材）</th><th class="num">工人单价</th><th class="num">箱单比</th><th>备注</th><th>状态</th><th>操作</th>
  </tr></thead><tbody>` +
    rows.map((r) => {
      const items = (r.items || []).map((it) => {
        const m = it.product_id ? PRODUCTS.find((x) => x.id === it.product_id) : null;
        const nm = m ? m.name : (it.name || "?");
        let label = `${esc(nm)}${it.quantity != 1 ? `×${fmtNum(it.quantity)}` : ""}`;
        if (it.stock_product_id) {
          const sm = PRODUCTS.find((x) => x.id === it.stock_product_id);
          label += `　<span class="badge income" title="出库扣减目标">扣${esc(sm ? sm.name : "?")}×${fmtNum(it.multiplier)}</span>`;
        }
        return label;
      }).join("，");
      const boxChips = (r.box_items || []).map((bi) => {
        const bm = bi.product_id ? PRODUCTS.find((x) => x.id === bi.product_id) : null;
        const label = bm ? bm.name : (bi.name || "—");
        const chip = bm ? "income" : "adjust";
        return `<span class="badge ${chip}">${esc(label)}${bi.quantity != 1 ? ` ×${fmtNum(bi.quantity)}` : ""}</span>`;
      }).join(" ") || "—";
      return `<tr>
        <td class="cb-col"><input type="checkbox" value="${r.id}" ${prSel.has(r.id) ? "checked" : ""} onchange="toggleSel('pr',${r.id},this.checked)" /></td>
        <td><b>${esc(r.name)}</b><div class="muted" style="font-size:12px;">${esc(items)}</div></td>
        <td>${boxChips}</td>
        <td class="num">${r.labor_price != null ? fmtNum(r.labor_price) : "—"}</td>
        <td class="num">${r.box_ratio || 1}</td>
        <td class="muted">${esc(r.remark) || "—"}</td>
        <td>${r.is_active ? '<span class="badge in">启用</span>' : '<span class="badge off">停用</span>'}</td>
        <td class="line-actions"><button class="btn sm secondary" onclick="openPackRuleModal(${r.id})">编辑</button></td>
      </tr>`;
    }).join("") + `</tbody>`;
  if (!rows.length) t.innerHTML = `<tr><td colspan="8" class="empty">暂无一单多货规则</td></tr>`;
  updateBatchBar("pr");
}
async function batchDeletePackRules() {
  const ids = [...prSel];
  if (!ids.length) { toast("请先勾选要删除的规则"); return; }
  if (!confirm(`确认删除选中的 ${ids.length} 条一单多货规则？`)) return;
  try {
    let deleted = 0;
    for (const id of ids) { await api("/api/pack-rules/" + id, "DELETE"); deleted++; }
    prSel.clear();
    toast(`已删除 ${deleted} 条规则`);
    PACK_RULES = await api("/api/pack-rules");
    renderPackRules();
  } catch (e) { toast("删除失败：" + e.message); }
}

/* =============== 入库 =============== */
/* 入库商品池：库存商品（含包材），排除 订单/人工/快递 */
function inboundProducts() {
  return PRODUCTS.filter((p) => p.is_active && p.product_type === "stock" && !["人工", "快递"].includes(p.category));
}
function initInbound() {
  if (!$("inDate").value) $("inDate").value = today();
  $("inUnit").onchange = calcInbound;
  loadInbounds();
}
/* 入库商品选择器（二级弹层：搜索 + 分类 + 卡片列表） */
function openInboundPicker() {
  const sp = inboundProducts();
  const cats = [...new Set(sp.map((p) => p.category).filter(Boolean))].sort();
  openModal(`
    <h3>选择入库商品 <button class="close" onclick="closeModal()">✕</button></h3>
    <div class="toolbar" style="margin-bottom:10px;">
      <input id="spSearch" placeholder="🔍 搜索商品名称 / 分类..." oninput="renderInboundPicker()" />
      <select id="spType" style="display:none;"><option value="">全部类型</option><option value="stock">库存商品</option></select>
      <select id="spCat" class="searchable" onchange="renderInboundPicker()"><option value="">全部分类</option>${cats.map((c) => `<option value="${esc(c)}">${esc(c)}</option>`).join("")}</select>
    </div>
    <div class="sp-list" id="spList" style="max-height:52vh;overflow-y:auto;"></div>`);
  renderInboundPicker();
}
function renderInboundPicker() {
  const kw = ($("spSearch")?.value || "").trim().toLowerCase();
  const cat = $("spCat")?.value || "";
  const rows = inboundProducts().filter((p) =>
    (!kw || p.name.toLowerCase().includes(kw) || (p.category || "").toLowerCase().includes(kw)) &&
    (!cat || p.category === cat));
  const list = $("spList");
  if (!rows.length) { list.innerHTML = `<div class="empty" style="padding:30px;">无匹配商品</div>`; return; }
  list.innerHTML = rows.map((p) => `
    <div class="sp-item" onclick="pickInboundProduct(${p.id})">
      <div class="grow">
        <b><span class="badge adjust">库存</span> ${esc(p.name)}</b>
        <div class="muted" style="font-size:12px;">${esc(p.category || "—")} · 单位 ${esc(p.default_unit || p.base_unit)} · 库存 ${fmtStock(p)}</div>
      </div>
      <span class="badge" style="background:var(--primary-light);color:var(--primary);">选择 ›</span>
    </div>`).join("");
}
function pickInboundProduct(id) {
  const p = PRODUCTS.find((x) => x.id === id);
  if (!p) return;
  const inp = $("inProduct");
  inp.value = `[库存] ${p.name}（${p.category || "—"}）`;
  inp.dataset.pid = p.id;
  const du = p.default_unit || p.base_unit;
  $("inUnit").innerHTML = unitOptions(p, du);
  $("inUnit").value = du;
  const factor = (p.conversions || {})[du] || 1;
  $("inStockHint").textContent = `当前库存 ${fmtStock(p)}；1${du} = ${fmtNum(factor)} ${p.base_unit}`;
  closeModal();
  calcInbound();
}
function calcInbound() {
  const p = PRODUCTS.find((x) => x.id === +$("inProduct").dataset.pid);
  const unit = $("inUnit").value;
  const qty = parseFloat($("inQty").value) || 0;
  const price = parseFloat($("inPrice").value) || 0;
  $("inAmount").value = (qty * price).toFixed(2);
  if (p && unit) {
    const factor = (p.conversions || {})[unit];
    $("inUnitHint").textContent = factor ? `1${unit} = ${fmtNum(factor)} ${p.base_unit}` : "";
  } else {
    $("inUnitHint").textContent = "";
  }
}
async function submitInbound() {
  const pid = +$("inProduct").dataset.pid;
  if (!pid) { toast("请选择商品"); return; }
  const p = PRODUCTS.find((x) => x.id === pid);
  const unit = $("inUnit").value;
  const qty = parseFloat($("inQty").value);
  const price = parseFloat($("inPrice").value);
  if (!unit || !qty || qty <= 0) { toast("请填写有效的数量与单位"); return; }
  if (isNaN(price)) { toast("请填写单价"); return; }
  try {
    await api("/api/inbounds", "POST", {
      product_id: pid, unit, quantity: qty, unit_price: price,
      supplier: $("inSupplier").value, operator: $("inOperator").value,
      date: $("inDate").value, remark: $("inRemark").value,
    });
    toast(`已入库 ${fmtNum(qty)}${unit} ${p.name}`);
    $("inQty").value = ""; $("inPrice").value = ""; $("inAmount").value = ""; $("inRemark").value = "";
    renderRemarkAttachments("inRemark");
    loadInbounds(); loadStock();
  } catch (e) { toast("入库失败：" + e.message); }
}
async function loadInbounds() {
  const from = $("inDateFrom").value, to = $("inDateTo").value;
  let rows = await api(`/api/inbounds?date_from=${from || ""}&date_to=${to || ""}`);
  const kw = ($("inSearch")?.value || "").trim().toLowerCase();
  if (kw) rows = rows.filter((r) => [r.code, r.product_name, r.supplier, r.operator].join(" ").toLowerCase().includes(kw));
  const t = $("inTable");
  rows = applyTableSort(t, rows);
  $("inListHint").textContent = `共 ${rows.length} 条`;
  t.innerHTML = `<thead><tr>
    <th class="cb-col"><input type="checkbox" onclick="toggleAll(this,'in')" /></th>
    <th data-key="code">单号${sortArrow("inTable", "code")}</th>
    <th data-key="product_name">商品${sortArrow("inTable", "product_name")}</th>
    <th data-key="quantity">数量${sortArrow("inTable", "quantity")}</th>
    <th>折算</th>
    <th data-key="unit_price" class="num">单价${sortArrow("inTable", "unit_price")}</th>
    <th data-key="total_amount" class="num">金额${sortArrow("inTable", "total_amount")}</th>
    <th data-key="supplier">供应商${sortArrow("inTable", "supplier")}</th>
    <th data-key="operator">操作员${sortArrow("inTable", "operator")}</th>
    <th data-key="date">日期${sortArrow("inTable", "date")}</th>
    <th>备注</th>
    <th></th></tr></thead><tbody>` +
    rows.map((r) => `<tr>
      <td class="cb-col"><input type="checkbox" value="${r.id}" ${inSel.has(r.id) ? "checked" : ""} onchange="toggleSel('in',${r.id},this.checked)" /></td>
      <td class="mono">${r.code}</td>
      <td><b>${esc(r.product_name)}</b></td>
      <td>${fmtNum(r.quantity)} ${r.unit}</td>
      <td class="muted">= ${fmtNum(r.quantity_base)} 基础单位</td>
      <td class="num mono">${fmtMoney(r.unit_price)}/${r.unit}</td>
      <td class="num mono">${fmtMoney(r.total_amount)}</td>
      <td>${esc(r.supplier) || "—"}</td>
      <td>${esc(r.operator) || "—"}</td>
      <td>${r.date}</td>
      <td class="muted" style="max-width:150px;">${renderRemarkHtml(r.remark)}</td>
      <td><button class="btn sm danger" onclick="deleteInbound(${r.id})">删</button></td></tr>`).join("") + `</tbody>`;
  t._rows = rows;
  t._render = loadInbounds;
  updateBatchBar("in");
}
async function deleteInbound(id) {
  if (!confirm("确认删除该入库单？将回退库存与成本。")) return;
  try { await api("/api/inbounds/" + id, "DELETE"); toast("已删除"); loadInbounds(); loadStock(); }
  catch (e) { toast("删除失败：" + e.message); }
}

/* =============== 出库 =============== */
let outSaleRowId = 0;
let OUT_PREVIEW = null;  // 最近一次服务端出库预览（含先进先出结转成本），用于展示真实成本
function initOutbound() {
  if (!$("outDate").value) $("outDate").value = today();
  if (!$("outSaleBody").children.length) addSaleRow();
  loadOutbounds();
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
    <td class="muted sale-conv">—</td>
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
      <input id="spSearch" placeholder="🔍 搜索商品名称 / 分类..." oninput="renderSalePicker()" />
      <select id="spType" onchange="renderSalePicker()"><option value="">全部类型</option><option value="order">订单商品</option><option value="stock">库存商品</option></select>
      <select id="spCat" class="searchable" onchange="renderSalePicker()"><option value="">全部分类</option>${cats.map((c) => `<option value="${esc(c)}">${esc(c)}</option>`).join("")}</select>
    </div>
    <div class="sp-list" id="spList" style="max-height:52vh;overflow-y:auto;"></div>`);
  renderSalePicker();
}
function renderSalePicker() {
  const kw = ($("spSearch")?.value || "").trim().toLowerCase();
  const type = $("spType")?.value || "";
  const cat = $("spCat")?.value || "";
  const rows = saleProducts().filter((p) =>
    (!kw || p.name.toLowerCase().includes(kw) || (p.category || "").toLowerCase().includes(kw)) &&
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
  const p = PRODUCTS.find((x) => x.id === +tr.dataset.pid);
  const unitSel = tr.querySelector(".sale-unit");
  const unit = unitSel ? unitSel.value : "";
  const qty = parseFloat(tr.querySelectorAll("input[type=number]")[0].value) || 0;
  const price = parseFloat(tr.querySelectorAll("input[type=number]")[1].value) || 0;
  if (p && unit) {
    const factor = (p.conversions || {})[unit] || 1;
    const qb = qty * factor;
    if (p.product_type === "order" && p.stock_product_id) {
      tr.querySelector(".sale-conv").textContent = `扣 ${esc(p.stock_product_name || "?")} ×${fmtNum(qb * p.multiplier)}`;
    } else {
      tr.querySelector(".sale-conv").textContent = `= ${fmtNum(qb)} ${p.base_unit}`;
    }
  }
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
async function previewOutbound() {
  const lines = collectSaleLines();
  if (!lines.length) { toast("请至少添加一行销售商品"); return; }
  try {
    const r = await api("/api/outbounds/preview", "POST", { lines });
    renderPackPreview(r);
  } catch (e) { toast("预览失败：" + e.message); }
}
function renderPackPreview(r) {
  OUT_PREVIEW = r;
  $("outPreview").style.display = "block";
  $("outFee").value = r.total_fee;
  $("outWarn").innerHTML = (r.warnings || []).map((w) => `<div class="alert warn">⚠ ${esc(w)}（仍可继续，可先补货）</div>`).join("");
  $("outPackBody").innerHTML = r.pack_lines.map((pl, i) => {
    const m = PRODUCTS.find((x) => x.id === pl.product_id);
    return `<tr data-idx="${i}" data-unit="${esc(pl.unit)}" data-up="${pl.unit_price}">
      <td><b>${esc(pl.product_name)}</b></td>
      <td><select class="searchable" onchange="packLineUnitChanged(this)">${m ? unitOptions(m, pl.unit) : `<option>${pl.unit}</option>`}</select></td>
      <td><input type="number" step="any" value="${pl.quantity}" oninput="packLineChanged(this)" style="width:90px;" /></td>
      <td><span class="badge pack">包装消耗</span></td>
      <td class="num mono">${fmtMoney(pl.unit_price)}/${pl.unit}</td>
      <td class="num pl-amount">${fmtMoney(pl.amount)}</td>
      <td><button class="btn sm danger" onclick="this.closest('tr').remove()">✕</button></td></tr>`;
  }).join("");
  if (!r.pack_lines.length) $("outPackBody").innerHTML = `<tr><td colspan="7" class="empty">无关联结算项（该商品未配置包装清单）</td></tr>`;
  bindSearchable($("outPackBody"));
  calcOutboundTotals();
}
function packLineUnitChanged(sel) {
  const tr = sel.closest("tr");
  const m = PRODUCTS.find((x) => x.name === tr.querySelector("b").textContent);
  packLineChanged(sel);
}
function packLineChanged(inp) {
  const tr = inp.closest("tr");
  const unit = tr.querySelectorAll("select")[0].value;
  const qty = parseFloat(tr.querySelectorAll("input")[0].value) || 0;
  const name = tr.querySelector("b").textContent;
  const m = PRODUCTS.find((x) => x.name === name);
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
    const name = tr.querySelector("b")?.textContent;
    const unit = tr.querySelectorAll("select")[0]?.value;
    const qty = parseFloat(tr.querySelectorAll("input")[0]?.value);
    const m = PRODUCTS.find((x) => x.name === name);
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
  $("otAmount").textContent = fmtMoney(amount);
  $("otCogs").textContent = fmtMoney(cogs);
  $("otGross").textContent = fmtMoney(amount - cogs);
  $("otNet").textContent = fmtMoney(amount - cogs - fee);
}
function clearPreview() { $("outPreview").style.display = "none"; OUT_PREVIEW = null; }
async function submitOutbound() {
  const lines = collectSaleLines();
  if (!lines.length) { toast("请至少添加一行销售商品"); return; }
  const packLines = collectPackLines();
  const fee = parseFloat($("outFee").value) || 0;
  try {
    const r = await api("/api/outbounds", "POST", {
      customer: $("outCustomer").value, operator: $("outOperator").value,
      date: $("outDate").value, remark: $("outRemark").value,
      lines, pack_lines: packLines, pack_fee_total: fee,
    });
    const warns = (r.warnings || []).length ? "\n⚠ " + r.warnings.join("；") : "";
    toast("出库成功" + warns, 3800);
    $("outSaleBody").innerHTML = ""; outSaleRowId = 0; addSaleRow();
    clearPreview();
    $("outCustomer").value = ""; $("outRemark").value = "";
    renderRemarkAttachments("outRemark");
    loadOutbounds(); loadStock();
  } catch (e) { toast("出库失败：" + e.message); }
}
async function loadOutbounds() {
  const from = $("outDateFrom").value, to = $("outDateTo").value;
  const flat = await api(`/api/outbounds?date_from=${from || ""}&date_to=${to || ""}`);
  const kw = ($("outSearch")?.value || "").trim().toLowerCase();
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
    if (!kw || [g.code, g.customer, g.date].join(" ").toLowerCase().includes(kw)) rows.push({ _group: true, g });
  }
  // 兼容旧筛选：进一步按单号/客户过滤（批次行存储成员以支持检索）
  if (kw) rows = rows.filter((r) => r._group
    ? (r.g.records || []).some((o) => [o.code, o.customer].join(" ").toLowerCase().includes(kw))
    : [r.rec.code, r.rec.customer].join(" ").toLowerCase().includes(kw));
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
      <td class="mono">${o.code}</td>
      <td>${esc(o.customer) || "—"}</td>
      <td><button class="detail-toggle" onclick="toggleOutDetail(${o.id})">▸ 查看明细</button></td>
      <td class="num mono">${fmtMoney(o.total_amount)}</td>
      <td class="num mono">${fmtMoney(o.total_cogs)}</td>
      <td class="num mono">${fmtMoney(o.total_fee)}</td>
      <td class="num mono" style="color:${o.net_profit >= 0 ? "var(--green)" : "var(--red)"}">${fmtMoney(o.net_profit)}</td>
      <td>${o.date}</td>
      <td class="muted" style="max-width:140px;">${renderRemarkHtml(o.remark)}</td>
      <td><button class="btn sm danger" onclick="deleteOutbound(${o.id})">删</button></td></tr>
      <tr id="od-${o.id}" style="display:none;"><td colspan="11"><div class="subtable"><table>` +
      o.lines.map((l) => `<tr>
        <td>${esc(l.product_name)}</td>
        <td>${l.line_type === "sale" ? '<span class="badge out">销售</span>' : '<span class="badge pack">包装消耗</span>'}</td>
        <td>${fmtNum(l.quantity)} ${l.unit}</td>
        <td>= ${fmtNum(l.quantity_base)} ${l.base_unit || ""}</td>
        <td class="num">${fmtMoney(l.amount)}</td>
        <td class="num">成本 ${fmtMoney(l.cogs)}</td>
        <td class="num">${l.pack_fee ? "费 " + fmtMoney(l.pack_fee) : ""}</td>
      </tr>`).join("") + `</table></div></td></tr>`;
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
    total_amount: recs.reduce((s, r) => s + (r.total_amount || 0), 0),
    total_cogs: recs.reduce((s, r) => s + (r.total_cogs || 0), 0),
    total_fee: recs.reduce((s, r) => s + (r.total_fee || 0), 0),
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
      <td class="num mono">${fmtMoney(g.total_cogs)}</td>
      <td class="num mono">${fmtMoney(g.total_fee)}</td>
      <td class="num mono" style="color:${g.net_profit >= 0 ? "var(--green)" : "var(--red)"}">${fmtMoney(g.net_profit)}</td>
      <td>${g.date}</td>
      <td class="muted" style="max-width:140px;">—</td>
      <td><button class="btn sm danger" onclick="deleteOutGroupKeys(['${esc(g.import_group)}'])">删</button></td></tr>`;
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
  const kw = ($("ogSearch")?.value || "").trim().toLowerCase();
  const t = $("ogTable");
  const aggSale = outAggBy(rows, "sale").filter((a) => !kw || a.name.toLowerCase().includes(kw));
  const aggPack = outAggBy(rows, "pack").filter((a) => !kw || a.name.toLowerCase().includes(kw));
  const aggLabor = outAggBy(rows, "labor").filter((a) => !kw || a.name.toLowerCase().includes(kw));
  const aggLaborPack = outAggBy(rows, "laborpack").filter((a) => !kw || a.name.toLowerCase().includes(kw));
  // 「销售商品」页签的成本需包含该商品关联的打包人工+耗材+快递费成本，否则毛利虚高：
  // 直接关联的打包行带 sale_product_id；一单多货或未回填的按该单销售金额比例分摊到销售商品。
  // 快递费（category=快递）单独归入 express_cogs，与打包人工+耗材分开展示。
  {
    const byPid = new Map();
    aggSale.forEach((a) => {
      a.pack_cogs = a.pack_cogs || 0;
      a.express_cogs = a.express_cogs || 0;
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
    for (const o of rows) {
      const saleLines = (o.lines || []).filter((l) => l.line_type === "sale");
      const totalAmt = saleLines.reduce((s, l) => s + (l.amount || 0), 0);
      const unowned = [];
      for (const l of o.lines || []) {
        if (l.line_type !== "pack") continue;
        if (l.sale_product_id == null) { unowned.push(l); continue; }
        spread(l.sale_product_id, l.cogs || 0, l.category === "快递" ? "express_cogs" : "pack_cogs");
      }
      if (unowned.length && saleLines.length) {
        for (const l of unowned) {
          for (const sl of saleLines) {
            const share = totalAmt ? (sl.amount || 0) / totalAmt : 1 / saleLines.length;
            spread(sl.product_id, (l.cogs || 0) * share, l.category === "快递" ? "express_cogs" : "pack_cogs");
          }
        }
      }
    }
    aggSale.forEach((a) => { a.base_cogs = a.cogs; a.cogs = a.cogs + a.pack_cogs + (a.express_cogs || 0); });
  }
  const total = {
    amt: rows.reduce((s, o) => s + (o.total_amount || 0), 0),
    cogs: rows.reduce((s, o) => s + (o.total_cogs || 0), 0),
    fee: rows.reduce((s, o) => s + (o.total_fee || 0), 0),
  };
  const net = total.amt - total.cogs - total.fee;
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
     <div class="stat success"><div class="label">净利</div><div class="value" style="color:${net >= 0 ? "var(--green)" : "var(--red)"}">${fmtMoney(net)}</div></div>`;
  const seg = segActive("ogSeg");
  let isSale = false, isLaborPack = false, emptyText = "无记录";
  let data;
  if (seg === "og-sale") { isSale = true; data = aggSale; emptyText = "无销售商品"; }
  else if (seg === "og-labor") { data = aggLabor; emptyText = "无人工记录"; }
  else if (seg === "og-laborpack") { isLaborPack = true; data = aggLaborPack; emptyText = "无打包人工/耗材记录"; }
  else { data = aggPack; emptyText = "无耗材/包装记录"; }
  data = data.map((a) => {
    const gp = (a.amount - a.cogs) || 0;
    const denom = a.gross_sales || a.amount || 0; // 扣点前销售金额
    const gp_rate = denom ? (gp / denom) * 100 : 0; // 毛利率 = 毛利 / 扣点前销售金额
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
      <td>${esc(a.name)}${(a.subSub || a.sub) ? `<div class="muted" style="font-size:12px;font-weight:normal;">${esc(a.subSub || a.sub)}</div>` : ""}${isSale && (a.pack_cogs || a.express_cogs) ? `<div class="muted" style="font-size:11px;color:var(--danger);">商品成本 ${fmtMoney(a.base_cogs ?? a.cogs)}${a.pack_cogs ? ` ＋ 打包人工+耗材 ${fmtMoney(a.pack_cogs)}` : ""}${a.express_cogs ? ` ＋ 快递费 ${fmtMoney(a.express_cogs)}` : ""}</div>` : ""}</td>
      <td class="num">${a.order_count} 单</td>
      ${isLaborPack ? "" : `<td>${esc(a.unit)}</td>`}
      ${isLaborPack ? "" : `<td class="num mono">${fmtNum(a.qty)}</td>`}
      ${isSale ? `<td class="num mono">${fmtMoney(a.amount)}</td>` : ""}
      <td class="num mono">${fmtMoney(a.cogs)}</td>
      ${isSale ? `<td class="num mono" style="color:${(a.amount - a.cogs) >= 0 ? "var(--green)" : "var(--red)"}">${fmtMoney(a.amount - a.cogs)}</td>` : ""}
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
    if (!confirm(`确认删除该批次 ${want.length} 张出库单？将回退库存、成本与财务记录。`)) return;
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
  if (!confirm("确认删除该出库单？将回退库存、成本与财务记录。")) return;
  try { await api("/api/outbounds/" + id, "DELETE"); toast("已删除"); loadOutbounds(); loadStock(); }
  catch (e) { toast("删除失败：" + e.message); }
}

/* =============== 批量操作 =============== */
async function batchDeleteProducts() {
  if (!prodSel.size) return;
  if (!confirm(`确认删除选中的 ${prodSel.size} 个商品？已有出入库记录、被其他商品关联的商品将自动跳过。`)) return;
  try {
    const r = await api("/api/products/batch-delete", "POST", { ids: [...prodSel] });
    prodSel.clear();
    PRODUCTS = await api("/api/products");
    renderProducts();
    let msg = `已删除 ${r.deleted} 个商品`;
    if (r.blocked && r.blocked.length) msg += `；${r.blocked.length} 个因被引用已跳过（${r.blocked.slice(0, 5).join("、")}${r.blocked.length > 5 ? "…" : ""}）`;
    toast(msg, 4200);
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
      <div class="field"><label>参考成本（元/基础单位）</label><input id="bpCost" type="number" step="any" placeholder="留空不改" /></div>
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
async function batchDeleteInbounds() {
  if (!inSel.size) return;
  if (!confirm(`确认删除选中的 ${inSel.size} 条入库单？将回退库存与成本。`)) return;
  try {
    const r = await api("/api/inbounds/batch-delete", "POST", { ids: [...inSel] });
    inSel.clear();
    loadInbounds(); loadStock();
    toast(`已删除 ${r.deleted} 条入库单`);
  } catch (e) { toast("批量删除失败：" + e.message); }
}
async function batchDeleteOutbounds() {
  if (!outSel.size) return;
  if (!confirm(`确认删除选中的 ${outSel.size} 张出库单？将回退库存、成本与财务记录。`)) return;
  try {
    const r = await api("/api/outbounds/batch-delete", "POST", { ids: [...outSel] });
    outSel.clear();
    loadOutbounds(); loadStock();
    toast(`已删除 ${r.deleted} 张出库单`);
  } catch (e) { toast("批量删除失败：" + e.message); }
}

/* =============== 报表 =============== */
function quickRange(kind) {
  if (kind === "today") { $("repDateFrom").value = today(); $("repDateTo").value = today(); }
  else if (kind === "month") { $("repDateFrom").value = monthStart(); $("repDateTo").value = today(); }
  else { $("repDateFrom").value = ""; $("repDateTo").value = ""; }
  loadReport();
}
let reportInited = false;
async function loadReport() {
  // 首次进入默认显示当天数据（之后尊重手动选择的日期，「全部」可清空）
  if (!reportInited) {
    reportInited = true;
    if (!$("repDateFrom").value) $("repDateFrom").value = today();
    if (!$("repDateTo").value) $("repDateTo").value = today();
  }
  const from = $("repDateFrom").value, to = $("repDateTo").value;
  const [rep, finance] = await Promise.all([
    api(`/api/report/summary?date_from=${from || ""}&date_to=${to || ""}`),
    api(`/api/finance?date_from=${from || ""}&date_to=${to || ""}`),
  ]);
  const rh = $("repRangeHint");
  if (rh) rh.textContent = `统计区间 ${from || "最早"} ~ ${to || "最新"}`;
  const packTotal = rep.pack_cost_total || 0;
  $("repStats").innerHTML = `
    <div class="stat blue"><div class="label">销售收入</div><div class="value">${fmtMoney(rep.revenue)}</div><div class="sub">${rep.order_count} 单</div></div>
    <div class="stat amber"><div class="label">结转成本</div><div class="value">${fmtMoney(rep.cogs)}</div><div class="sub">含关联结算 ${fmtMoney(packTotal)}</div></div>
    <div class="stat green"><div class="label">毛利</div><div class="value">${fmtMoney(rep.gross_profit)}</div><div class="sub">${rep.revenue ? ((rep.gross_profit / rep.revenue) * 100).toFixed(1) + "%" : "—"}</div></div>
    <div class="stat red"><div class="label">期间费用</div><div class="value">${fmtMoney(rep.expense)}</div><div class="sub">其他开支 ${fmtMoney(rep.other_expense)} · 手工记账 ${fmtMoney(rep.manual_expense)}</div></div>
    <div class="stat ${rep.net_profit >= 0 ? "green" : "red"}"><div class="label">净利润</div><div class="value">${fmtMoney(rep.net_profit)}</div></div>
    <div class="stat"><div class="label">本期进货</div><div class="value">${fmtMoney(rep.purchase)}</div></div>
    <div class="stat red"><div class="label">本期总支出</div><div class="value">${fmtMoney(rep.total_expense)}</div><div class="sub">含采购 ${fmtMoney(rep.purchase)} · 期间费用 ${fmtMoney(rep.expense)}</div></div>
    <div class="stat blue"><div class="label">当前库存总值</div><div class="value">${fmtMoney(rep.stock_value)}</div></div>`;

  renderCostBreakdown(rep);
  renderExpenseSummary(rep);
  renderFeeBreakdown(rep);
  renderExpenseTables(rep);

  const pt = $("repProductTable");
  let prodRows = applyTableSort(pt, rep.by_product || []);
  // 成本为「总成本」= 商品成本 + 打包人工/耗材 + 快递费（后端 by_product 已按销售商品归属；
  // 无归属的快递费等按该单销售金额占比分摊）。毛利率分母用扣点前销售金额 gross_sales。
  const gpRateOf = (p) => {
    const denom = Number(p.gross_sales) || Number(p.amount) || 0;
    if (!denom) return "—";
    const total = Number(p.total_cogs != null ? p.total_cogs : p.cogs) || 0;
    const rate = p.gp_rate != null ? Number(p.gp_rate) : ((Number(p.amount) - total) / denom) * 100;
    return rate.toFixed(1) + "%";
  };
  if (!prodRows.length) pt.innerHTML = `<tr><td class="empty" colspan="6">本期无销售</td></tr>`;
  else pt.innerHTML = `<thead><tr>
    <th data-key="name">商品${sortArrow("repProductTable", "name")}</th>
    <th data-key="qty" class="num">销量${sortArrow("repProductTable", "qty")}</th>
    <th data-key="amount" class="num">收入${sortArrow("repProductTable", "amount")}</th>
    <th data-key="cogs" class="num">总成本${sortArrow("repProductTable", "cogs")}</th>
    <th data-key="gross" class="num">毛利${sortArrow("repProductTable", "gross")}</th>
    <th class="num">毛利率</th></tr></thead><tbody>` +
    prodRows.map((p) => {
      const total = Number(p.total_cogs != null ? p.total_cogs : p.cogs) || 0;
      const gp = (Number(p.amount) || 0) - total;
      const color = gp >= 0 ? "var(--green)" : "var(--red)";
      const split = (p.pack_cogs || p.express_cogs)
        ? `<div class="muted" style="font-size:11px;">商品成本 ${fmtMoney(p.goods_cogs != null ? p.goods_cogs : p.cogs)}${p.pack_cogs ? ` ＋ 打包人工+耗材 ${fmtMoney(p.pack_cogs)}` : ""}${p.express_cogs ? ` ＋ 快递费 ${fmtMoney(p.express_cogs)}` : ""}</div>`
        : "";
      return `<tr>
      <td>${esc(p.name)}${split}</td><td class="num mono">${fmtNum(p.qty)}</td>
      <td class="num mono">${fmtMoney(p.amount)}</td><td class="num mono">${fmtMoney(total)}</td>
      <td class="num mono" style="color:${color}">${fmtMoney(gp)}</td>
      <td class="num mono" style="color:${color}">${gpRateOf(p)}</td></tr>`;
    }).join("") + `</tbody>`;
  pt._rows = prodRows;
  pt._render = loadReport;

  const ft = $("financeTable");
  let finRows = finance;
  const fkw = ($("repSearch")?.value || "").trim().toLowerCase();
  if (fkw) finRows = finRows.filter((f) => [f.category, f.product_name, f.remark, f.operator, f.type].join(" ").toLowerCase().includes(fkw));
  finRows = applyTableSort(ft, finRows);
  ft.innerHTML = `<thead><tr>
    <th>类型</th>
    <th data-key="category">分类${sortArrow("financeTable", "category")}</th>
    <th data-key="product_name">商品${sortArrow("financeTable", "product_name")}</th>
    <th data-key="amount" class="num">金额${sortArrow("financeTable", "amount")}</th>
    <th data-key="operator">操作员${sortArrow("financeTable", "operator")}</th>
    <th data-key="date">日期${sortArrow("financeTable", "date")}</th>
    <th>备注</th><th></th></tr></thead><tbody>` +
    finRows.map((f) => `<tr>
      <td>${f.type === "income" ? '<span class="badge income">收入</span>' : '<span class="badge expense">支出</span>'}</td>
      <td>${esc(f.category)}</td>
      <td>${esc(f.product_name) || "—"}</td>
      <td class="num mono" style="color:${f.type === "income" ? "var(--green)" : "var(--red)"}">${f.type === "income" ? "+" : "-"}${fmtMoney(f.amount)}</td>
      <td>${esc(f.operator) || "—"}</td><td>${f.date}</td>
      <td class="muted">${esc(f.remark)}</td>
      <td>${f.ref_type === "manual" ? `<button class="btn sm danger" onclick="deleteFinance(${f.id})">删</button>` : ""}</td></tr>`).join("") + `</tbody>`;
  if (!finRows.length) ft.innerHTML = `<tr><td colspan="8" class="empty">本期无财务流水</td></tr>`;
  ft._rows = finRows;
  ft._render = loadReport;
}

/* 销售成本构成：商品成本 vs 出库自动结算的包材/人工/快递 */
function renderCostBreakdown(rep) {
  const box = $("repCostBreak");
  if (!box) return;
  const cogs = rep.cogs || 0;
  const packs = rep.pack_costs || {};
  const packTotal = rep.pack_cost_total || 0;
  const goods = rep.goods_cogs != null ? rep.goods_cogs : cogs - packTotal;
  const hint = $("repCostHint");
  if (hint) hint.textContent = cogs ? `合计 ${fmtMoney(cogs)}` : "";

  if (!cogs) {
    box.innerHTML = `<div class="empty">本期无销售成本</div>`;
    return;
  }
  const pctOf = (v) => (cogs ? (v / cogs) * 100 : 0);
  const COLORS = { "包材耗材": "#ff976a", "人工打包费": "#7232dd", "快递运费": "#07c160", "其他关联结算": "#969799" };
  const rows = [
    { name: "商品成本", value: goods, color: "#1989fa", tag: "" },
    ...Object.entries(packs)
      .sort((a, b) => b[1] - a[1])
      .map(([k, v]) => ({ name: k, value: v, color: COLORS[k] || "#969799", tag: "自动结算" })),
  ];
  box.innerHTML = `
    <div class="cost-stack">
      ${rows.filter((r) => r.value > 0).map((r) =>
        `<span title="${esc(r.name)} ${fmtMoney(r.value)}" style="width:${pctOf(r.value)}%;background:${r.color};"></span>`).join("")}
    </div>
    <div class="table-wrap"><table>
      <thead><tr><th>成本项</th><th class="num">金额</th><th class="num">占比</th><th>说明</th></tr></thead>
      <tbody>${rows.map((r) => `<tr>
        <td><span class="cost-dot" style="background:${r.color};"></span>${esc(r.name)}
          ${r.tag ? `<span class="badge pack" style="margin-left:6px;">${r.tag}</span>` : ""}</td>
        <td class="num mono">${fmtMoney(r.value)}</td>
        <td class="num mono">${pctOf(r.value).toFixed(1)}%</td>
        <td class="muted">${r.tag ? "出库时按包装清单自动结算，已计入结转成本" : "销售商品本身的先进先出成本"}</td>
      </tr>`).join("")}</tbody>
      <tfoot><tr>
        <td><b>结转成本合计</b></td>
        <td class="num mono"><b>${fmtMoney(cogs)}</b></td>
        <td class="num mono">100%</td>
        <td class="muted">关联结算合计 ${fmtMoney(packTotal)}</td>
      </tr></tfoot>
    </table></div>
    ${packTotal ? "" : `<div class="alert warn" style="margin-top:10px;">本期没有包材 / 人工 / 快递等关联结算成本。若商品已配置包装清单，请确认出库时是否生成了关联结算行。</div>`}`;
}
/* 报表分区 tab：汇总 / 支出 / 商品 / 流水（日期条件常驻，作用于所有分区） */
const REP_PANELS = ["rep-panel-summary", "rep-panel-expense", "rep-panel-goods", "rep-panel-flow"];
function repTab(btn) {
  btn.closest(".seg").querySelectorAll(".seg-item").forEach((x) => x.classList.toggle("active", x === btn));
  const p = btn.dataset.panel;
  REP_PANELS.forEach((id) => { const el = $(id); if (el) el.style.display = id === p ? "" : "none"; });
}
/* 支出统计（按日 / 按月）：其他开支 + 手工记账支出，合计即「期间费用」；不含采购支出 */
function repExpSwitch(btn) {
  $("repExpSeg").querySelectorAll(".seg-item").forEach((x) => x.classList.toggle("active", x === btn));
  const p = btn.dataset.panel;
  ["rep-exp-day", "rep-exp-month"].forEach((id) => { $(id).style.display = id === p ? "" : "none"; });
}
function renderExpenseTables(rep) {
  const days = rep.expense_by_day || [];
  const months = rep.expense_by_month || [];
  const purchase = rep.purchase || 0;                                  // 采购 / 进货
  const other = rep.other_expense || 0;                                // 其他开支
  const manual = rep.manual_expense || 0;                              // 手工记账
  const period = rep.expense || 0;                                     // 期间费用（从毛利中扣减）
  const total = rep.total_expense != null ? rep.total_expense : purchase + period;  // 全部支出（含采购）
  const MAX_DAYS = 90;
  const sumCount = (rows) => rows.reduce((a, r) => a + (r.count || 0), 0);

  const hint = $("repExpHint");
  if (hint) {
    hint.textContent = total
      ? `按日 / 按月列出各项支出，合计 ${fmtMoney(total)} ＝ 采购 ＋ 其他开支 ＋ 手工记账`
      : "本期无支出";
    if (days.length > MAX_DAYS) hint.textContent += ` · 按日仅列最近 ${MAX_DAYS} 天`;
  }

  // 自诊断：接口没返回逐日/逐月明细，或行内缺少采购字段 → 后端还是旧版
  const staleApi = !Array.isArray(rep.expense_by_day) || !Array.isArray(rep.expense_by_month)
    || days.some((r) => r.purchase == null);
  const warn = $("repExpWarn");
  if (warn) {
    warn.style.display = staleApi ? "block" : "none";
    if (staleApi) {
      warn.innerHTML = "明细数据缺失：后端未返回「按日 / 按月支出明细」或缺少采购字段，说明<b>后端服务还是旧版本</b>。"
        + "请更新并重启后端后刷新本页（服务器：bash /home/azureuser/WSFC_ERP/deploy/service.sh restart；"
        + "本机：重启 backend/run.py）。";
    }
  }
  const emptyText = staleApi
    ? "明细为空：后端未返回明细数据（请更新并重启后端服务）"
    : "本期无支出";

  const pctOf = (v) => (total ? (v / total) * 100 : 0);
  const bar = (v) => `<span class="exp-bar"><i style="width:${Math.min(100, pctOf(v)).toFixed(1)}%"></i></span>`;
  const amountCells = (r) =>
    `<td class="num mono" style="color:#1989fa">${r.purchase ? fmtMoney(r.purchase) : "—"}</td>` +
    `<td class="num mono" style="color:#f97316">${r.other_expense ? fmtMoney(r.other_expense) : "—"}</td>` +
    `<td class="num mono" style="color:#6366f1">${r.manual_expense ? fmtMoney(r.manual_expense) : "—"}</td>` +
    `<td class="num mono"><b>${fmtMoney(r.total)}</b></td>`;
  const totalCells = (label, rows) =>
    `<tr><td><b>${label}</b></td>` +
    `<td class="num mono" style="color:#1989fa"><b>${fmtMoney(purchase)}</b></td>` +
    `<td class="num mono" style="color:#f97316"><b>${fmtMoney(other)}</b></td>` +
    `<td class="num mono" style="color:#6366f1"><b>${fmtMoney(manual)}</b></td>` +
    `<td class="num mono"><b>${fmtMoney(total)}</b></td>` +
    `<td></td><td class="num mono"><b>${sumCount(rows)}</b></td></tr>`;

  // 按日
  const dt = $("repExpDayTable");
  const dayRows = days.slice(0, MAX_DAYS);
  dt.innerHTML = `<thead><tr>
    <th>日期</th><th class="num">采购支出</th><th class="num">其他开支</th><th class="num">手工记账</th>
    <th class="num">支出合计</th><th class="num">占比</th><th class="num">笔数</th></tr></thead><tbody>` +
    (dayRows.length
      ? dayRows.map((r) => `<tr>
          <td class="mono">${esc(r.date)}</td>${amountCells(r)}
          <td class="num">${bar(r.total)}<span class="muted">${pctOf(r.total).toFixed(1)}%</span></td>
          <td class="num mono">${r.count}</td></tr>`).join("")
      : `<tr><td colspan="7" class="empty">${emptyText}</td></tr>`) +
    `</tbody>` +
    (days.length ? `<tfoot>${totalCells(`合计（${days.length} 天）`, days)}</tfoot>` : "");

  // 按月（多一列环比：与上个月比）
  const mt = $("repExpMonthTable");
  mt.innerHTML = `<thead><tr>
    <th>月份</th><th class="num">采购支出</th><th class="num">其他开支</th><th class="num">手工记账</th>
    <th class="num">支出合计</th><th class="num">环比</th><th class="num">笔数</th></tr></thead><tbody>` +
    (months.length
      ? months.map((m, i) => {
        const prev = months[i + 1];  // 倒序排列，下一项即上一个月
        const delta = prev && prev.total ? ((m.total - prev.total) / prev.total) * 100 : null;
        const txt = delta == null ? "—" : `${delta >= 0 ? "+" : ""}${delta.toFixed(1)}%`;
        const color = delta == null ? "var(--muted)" : delta >= 0 ? "var(--red)" : "var(--green)";
        return `<tr>
          <td class="mono">${esc(m.month)}</td>${amountCells(m)}
          <td class="num mono" style="color:${color}">${txt}</td>
          <td class="num mono">${m.count}</td></tr>`;
      }).join("")
      : `<tr><td colspan="7" class="empty">${emptyText}</td></tr>`) +
    `</tbody>` +
    (months.length ? `<tfoot>${totalCells("合计", months)}</tfoot>` : "");
}

/* 支出汇总：采购（进货）+ 其他开支 + 手工记账 = 全部支出；期间费用才是从毛利中扣减的部分 */
function renderExpenseSummary(rep) {
  const box = $("repExpSummary");
  if (!box) return;
  const purchase = rep.purchase || 0;
  const other = rep.other_expense || 0;
  const manual = rep.manual_expense || 0;
  const period = rep.expense || 0;
  const total = rep.total_expense != null ? rep.total_expense : purchase + period;
  const pctOf = (v) => (total ? (v / total) * 100 : 0);
  const hint = $("repFeeHint");
  if (hint) hint.textContent = `统计区间 ${rep.date_from || "最早"} ~ ${rep.date_to || "最新"} · 支出合计 ${fmtMoney(total)}`;

  const rows = [
    { name: "采购支出（进货）", value: purchase, color: "#1989fa", desc: "入库 / 进货金额（与「本期进货」同源），已计入结转成本" },
    { name: "其他开支", value: other, color: "#f97316", desc: "网线费 / 安装费 / 机器费 / 样品费等（构成见下表）" },
    { name: "手工记账", value: manual, color: "#6366f1", desc: "财务流水里登记的支出（构成见下表）" },
  ];
  box.innerHTML = `<thead><tr>
      <th>支出项</th><th class="num">金额</th><th class="num">占全部支出</th><th>说明</th></tr></thead><tbody>` +
    rows.map((r) => `<tr>
      <td><span class="cost-dot" style="background:${r.color};"></span>${r.name}</td>
      <td class="num mono">${fmtMoney(r.value)}</td>
      <td class="num mono">${pctOf(r.value).toFixed(1)}%</td>
      <td class="muted">${r.desc}</td></tr>`).join("") +
    `</tbody><tfoot>
      <tr>
        <td><b>支出合计</b></td>
        <td class="num mono"><b>${fmtMoney(total)}</b></td>
        <td class="num mono"><b>100.0%</b></td>
        <td class="muted">＝ 采购 ＋ 其他开支 ＋ 手工记账</td></tr>
      <tr>
        <td>其中：期间费用</td>
        <td class="num mono">${fmtMoney(period)}</td>
        <td class="num mono">${pctOf(period).toFixed(1)}%</td>
        <td class="muted">其他开支 ＋ 手工记账；<b>毛利 − 期间费用 = 净利</b>（采购已计入结转成本，不重复扣）</td></tr>
    </tfoot>`;
}

/* 期间费用构成明细：其他开支（按类型）+ 手工记账（按类别） */
function renderFeeBreakdown(rep) {
  const box = $("repFeeBreak");
  if (!box) return;
  const others = rep.other_expenses || {};
  const manuals = rep.manual_fees || {};
  const otherTotal = rep.other_expense || 0;
  const manualTotal = rep.manual_expense != null
    ? rep.manual_expense
    : Object.values(manuals).reduce((a, b) => a + (Number(b) || 0), 0);
  const total = rep.expense != null ? rep.expense : otherTotal + manualTotal;

  const rows = [
    ...Object.entries(others).map(([name, v]) => ({ name, value: Number(v) || 0, src: "其他开支" })),
    ...Object.entries(manuals).map(([name, v]) => ({ name, value: Number(v) || 0, src: "手工记账" })),
  ].sort((a, b) => b.value - a.value);

  if (!rows.length) {
    box.innerHTML = `<div class="block-title">期间费用构成（从毛利中扣减）</div>
      <div class="empty">本期无期间费用。其他开支请到「经营分析 → 其他开支」登记；手工记账见「流水」tab 的「＋ 手动记账」</div>`;
    return;
  }
  const pctOf = (v) => (total ? (v / total) * 100 : 0);
  const COLORS = { "其他开支": "#f97316", "手工记账": "#6366f1" };
  box.innerHTML = `
    <div class="block-title">期间费用构成（其他开支 ＋ 手工记账，从毛利中扣减）</div>
    <div class="cost-stack">
      ${rows.filter((r) => r.value > 0).map((r) =>
        `<span title="${esc(r.name)} ${fmtMoney(r.value)}" style="width:${pctOf(r.value)}%;background:${COLORS[r.src]};"></span>`).join("")}
    </div>
    <div class="table-wrap"><table>
      <thead><tr><th>费用项</th><th>来源</th><th class="num">金额</th><th class="num">占比</th></tr></thead>
      <tbody>${rows.map((r) => `<tr>
        <td><span class="cost-dot" style="background:${COLORS[r.src]};"></span>${esc(r.name)}</td>
        <td class="muted">${r.src}</td>
        <td class="num mono">${fmtMoney(r.value)}</td>
        <td class="num mono">${pctOf(r.value).toFixed(1)}%</td>
      </tr>`).join("")}</tbody>
      <tfoot><tr>
        <td><b>期间费用合计</b></td>
        <td class="muted">其他开支 ${fmtMoney(otherTotal)} + 手工记账 ${fmtMoney(manualTotal)}</td>
        <td class="num mono"><b>${fmtMoney(total)}</b></td>
        <td class="num mono">100%</td>
      </tr></tfoot>
    </table></div>`;
}
function openFinanceModal() {
  openModal(`
    <h3>手动记账 <button class="close" onclick="closeModal()">✕</button></h3>
    <div class="form-grid">
      <div class="field"><label>类型</label><select id="fType"><option value="expense">支出</option><option value="income">收入</option></select></div>
      <div class="field"><label>分类</label><select id="fCategory">
        <option>人工费</option><option>房租</option><option>水电</option><option>运输费</option><option>包装耗材</option><option>其他支出</option>
      </select></div>
      <div class="field"><label>金额 *</label><input id="fAmount" type="number" step="any" /></div>
      <div class="field"><label>日期</label><input id="fDate" type="date" value="${today()}" /></div>
      <div class="field"><label>操作员</label><input id="fOperator" value="${esc(operatorName())}" readonly title="默认当前登录账号，不可修改" /></div>
    </div>
    <div class="field" style="margin-top:10px;"><label>备注</label><input id="fRemark" /></div>
    <div class="modal-foot">
      <button class="btn secondary" onclick="closeModal()">取消</button>
      <button class="btn" onclick="submitFinance()">保存</button>
    </div>`);
}
async function submitFinance() {
  try {
    await api("/api/finance", "POST", {
      type: $("fType").value, category: $("fCategory").value,
      amount: +$("fAmount").value, date: $("fDate").value,
      operator: $("fOperator").value, remark: $("fRemark").value,
    });
    closeModal(); toast("记账成功"); loadReport();
  } catch (e) { toast("失败：" + e.message); }
}
async function deleteFinance(id) {
  if (!confirm("确认删除该手动财务记录？")) return;
  try { await api("/api/finance/" + id, "DELETE"); toast("已删除"); loadReport(); }
  catch (e) { toast("失败：" + e.message); }
}

/* =============== 其他开支（仓库零散支出：网线费 / 安装费 / 机器费 / 样品费 …） =============== */
let OE_ROWS = [];       // 当前区间的开支明细
let OE_STATS = null;    // 当前区间的统计（今日/本月/区间/按日/按月/按类型）
let OE_EDIT_ID = null;  // 正在修改的记录 id；null = 新增
let oeInited = false;

function lastMonthRange() {
  const n = new Date();
  const first = new Date(n.getFullYear(), n.getMonth() - 1, 1);
  const last = new Date(n.getFullYear(), n.getMonth(), 0);
  const f = (x) => `${x.getFullYear()}-${String(x.getMonth() + 1).padStart(2, "0")}-${String(x.getDate()).padStart(2, "0")}`;
  return [f(first), f(last)];
}

async function loadOtherExpensePage() {
  if (!oeInited) {
    oeInited = true;
    if (!$("oeDate").value) $("oeDate").value = today();
    if (!$("oeDateFrom").value) $("oeDateFrom").value = monthStart();  // 默认看本月
    if (!$("oeDateTo").value) $("oeDateTo").value = today();
  }
  if ($("oeOperator")) $("oeOperator").value = operatorName();
  const from = $("oeDateFrom").value, to = $("oeDateTo").value;
  try {
    const [rows, stats] = await Promise.all([
      api(`/api/other-expenses?date_from=${from || ""}&date_to=${to || ""}`),
      api(`/api/other-expenses/stats?date_from=${from || ""}&date_to=${to || ""}`),
    ]);
    OE_ROWS = rows;
    OE_STATS = stats;
    renderOeStats(stats);
    renderOeTables(stats);
    oeFillCategories(stats);
    renderOtherExpenseList();
  } catch (e) { toast("加载其他开支失败：" + e.message); }
}

function oeQuick(kind) {
  const t = today();
  if (kind === "today") { $("oeDateFrom").value = t; $("oeDateTo").value = t; }
  else if (kind === "week") { $("oeDateFrom").value = daysAgo(6); $("oeDateTo").value = t; }
  else if (kind === "month") { $("oeDateFrom").value = monthStart(); $("oeDateTo").value = t; }
  else if (kind === "lastmonth") { const [a, b] = lastMonthRange(); $("oeDateFrom").value = a; $("oeDateTo").value = b; }
  else { $("oeDateFrom").value = ""; $("oeDateTo").value = ""; }
  loadOtherExpensePage();
}

function oeSwitchSeg(btn) {
  $("oeSeg").querySelectorAll(".seg-item").forEach((x) => x.classList.toggle("active", x === btn));
  const p = btn.dataset.panel;
  ["oe-day", "oe-month", "oe-cat"].forEach((id) => { $(id).style.display = id === p ? "" : "none"; });
}

function renderOeStats(s) {
  const top = (s.by_category || [])[0];
  $("oeStats").innerHTML = `
    <div class="stat red"><div class="label">今日开支</div><div class="value">${fmtMoney(s.today_total)}</div><div class="sub">${esc(s.today)}</div></div>
    <div class="stat red"><div class="label">本月开支</div><div class="value">${fmtMoney(s.month_total)}</div><div class="sub">${esc(s.month)} 月合计</div></div>
    <div class="stat amber"><div class="label">所选区间合计</div><div class="value">${fmtMoney(s.range_total)}</div><div class="sub">${s.range_count} 笔 · 日均 ${fmtMoney(s.range_daily_avg)}</div></div>
    <div class="stat"><div class="label">区间天数</div><div class="value">${s.range_days || 0}</div><div class="sub">最大类型：${top ? esc(top.category) + " " + fmtMoney(top.amount) : "—"}</div></div>`;
  const scope = `统计区间 ${s.date_from || "最早"} ~ ${s.date_to || "至今"}`;
  $("oeStatsHint").textContent = `${scope}（日均按区间天数计算）`;
  $("oeListHint").textContent = `${scope} · 合计 ${fmtMoney(s.range_total)}`;
}

function renderOeTables(s) {
  // 按日：柱状图（红=支出）+ 明细表
  const days = s.by_day || [];
  const box = $("oeChart");
  if (!days.length) {
    box.innerHTML = `<div class="mv-chart-title">该区间暂无开支</div>`;
  } else {
    const max = Math.max(1, ...days.map((d) => d.amount));
    const ordered = [...days].reverse();  // 图表按时间正序
    box.innerHTML = `<div class="mv-chart-title">每日开支（元，共 ${days.length} 天有支出）</div><div class="mv-chart">` +
      ordered.map((d) => `<div class="mv-col" title="${d.date}：${fmtMoney(d.amount)}（${d.count} 笔）">
        <span class="mv-val">${Math.round(d.amount)}</span>
        <div class="mv-track"><div class="mv-bar down" style="height:${Math.max(2, Math.round((d.amount / max) * 100))}%"></div></div>
        <div class="mv-x">${d.date.slice(5)}</div></div>`).join("") + `</div>`;
  }
  const dt = $("oeDayTable");
  dt.innerHTML = `<thead><tr><th>日期</th><th class="num">笔数</th><th class="num">金额</th></tr></thead><tbody>` +
    (days.length
      ? days.map((d) => `<tr><td class="mono">${d.date}</td><td class="num mono">${d.count}</td>
          <td class="num mono" style="color:var(--red)">${fmtMoney(d.amount)}</td></tr>`).join("") +
        `<tr><td><b>合计</b></td><td class="num mono"><b>${s.range_count}</b></td><td class="num mono"><b>${fmtMoney(s.range_total)}</b></td></tr>`
      : `<tr><td colspan="3" class="empty">该区间暂无开支</td></tr>`) + `</tbody>`;

  const months = s.by_month || [];
  const mt = $("oeMonthTable");
  mt.innerHTML = `<thead><tr><th>月份</th><th class="num">笔数</th><th class="num">金额</th><th class="num">环比</th></tr></thead><tbody>` +
    (months.length
      ? months.map((m, i) => {
        const prev = months[i + 1];  // 倒序排列，下一项即上一个月
        const delta = prev && prev.amount ? ((m.amount - prev.amount) / prev.amount) * 100 : null;
        const txt = delta == null ? "—" : `${delta >= 0 ? "+" : ""}${delta.toFixed(1)}%`;
        const color = delta == null ? "var(--muted)" : delta >= 0 ? "var(--red)" : "var(--green)";
        return `<tr><td class="mono">${m.month}</td><td class="num mono">${m.count}</td>
          <td class="num mono" style="color:var(--red)">${fmtMoney(m.amount)}</td>
          <td class="num mono" style="color:${color}">${txt}</td></tr>`;
      }).join("") +
        `<tr><td><b>合计</b></td><td class="num mono"><b>${s.range_count}</b></td><td class="num mono"><b>${fmtMoney(s.range_total)}</b></td><td></td></tr>`
      : `<tr><td colspan="4" class="empty">该区间暂无开支</td></tr>`) + `</tbody>`;

  const cats = s.by_category || [];
  const pct = (v) => (s.range_total ? (v / s.range_total) * 100 : 0);
  const ct = $("oeCatTable");
  ct.innerHTML = `<thead><tr><th>费用类型</th><th class="num">笔数</th><th class="num">金额</th><th class="num">占比</th></tr></thead><tbody>` +
    (cats.length
      ? cats.map((c) => `<tr><td><span class="badge expense">${esc(c.category)}</span></td><td class="num mono">${c.count}</td>
          <td class="num mono" style="color:var(--red)">${fmtMoney(c.amount)}</td><td class="num mono">${pct(c.amount).toFixed(1)}%</td></tr>`).join("") +
        `<tr><td><b>合计</b></td><td class="num mono"><b>${s.range_count}</b></td><td class="num mono"><b>${fmtMoney(s.range_total)}</b></td><td class="num mono">100%</td></tr>`
      : `<tr><td colspan="4" class="empty">该区间暂无开支</td></tr>`) + `</tbody>`;
}

/** 类型下拉建议 = 后端预设 + 已用过的自定义类型 */
function oeFillCategories(s) {
  const presets = (s && s.presets) || [];
  $("oeCategoryList").innerHTML = presets.map((c) => `<option value="${esc(c)}"></option>`).join("");
  const used = [...new Set(OE_ROWS.map((r) => r.category))].sort();
  const cur = $("oeFilterCat").value;
  $("oeFilterCat").innerHTML = `<option value="">全部类型</option>` +
    used.map((c) => `<option value="${esc(c)}">${esc(c)}</option>`).join("");
  $("oeFilterCat").value = used.includes(cur) ? cur : "";
}

function renderOtherExpenseList() {
  const cat = $("oeFilterCat").value;
  const kw = ($("oeSearch").value || "").trim().toLowerCase();
  let rows = OE_ROWS;
  if (cat) rows = rows.filter((r) => r.category === cat);
  if (kw) rows = rows.filter((r) => [r.category, r.remark, r.operator, r.date].join(" ").toLowerCase().includes(kw));
  const t = $("oeTable");
  t.innerHTML = `<thead><tr>
    <th>日期</th><th>费用类型</th><th class="num">金额</th><th>操作员</th><th>备注</th><th style="width:120px;"></th></tr></thead><tbody>` +
    (rows.length
      ? rows.map((r) => `<tr>
        <td class="mono">${r.date}</td>
        <td><span class="badge expense">${esc(r.category)}</span></td>
        <td class="num mono" style="color:var(--red)">${fmtMoney(r.amount)}</td>
        <td>${esc(r.operator) || "—"}</td>
        <td class="muted">${esc(r.remark)}</td>
        <td><button class="btn sm secondary" onclick="oeEdit(${r.id})">改</button>
            <button class="btn sm danger" onclick="oeDelete(${r.id})">删</button></td></tr>`).join("")
      : `<tr><td colspan="6" class="empty">该区间暂无开支，先在上方登记一笔</td></tr>`) + `</tbody>`;
  const sum = rows.reduce((a, r) => a + (Number(r.amount) || 0), 0);
  $("oeListSum").textContent = `共 ${rows.length} 笔 · 合计 ${fmtMoney(sum)}`;
}

function oeAlertMsg(msg) {
  const el = $("oeAlert");
  if (!el) return;
  el.textContent = msg || "";
  el.style.display = msg ? "block" : "none";
}

function oeResetForm() {
  OE_EDIT_ID = null;
  $("oeCategory").value = "";
  $("oeAmount").value = "";
  $("oeRemark").value = "";
  $("oeDate").value = today();
  $("oeSaveBtn").textContent = "✓ 保存开支";
  oeAlertMsg("");
}

function oeEdit(id) {
  const r = OE_ROWS.find((x) => x.id === id);
  if (!r) return;
  OE_EDIT_ID = id;
  $("oeCategory").value = r.category;
  $("oeAmount").value = r.amount;
  $("oeDate").value = r.date;
  $("oeRemark").value = r.remark || "";
  $("oeSaveBtn").textContent = "✓ 保存修改";
  oeAlertMsg(`正在修改 ${r.date}「${r.category}」${fmtMoney(r.amount)}（保存后覆盖原记录）`);
  $("oeCategory").focus();
}

async function oeSubmit() {
  const category = ($("oeCategory").value || "").trim();
  const amount = +$("oeAmount").value;
  const date = $("oeDate").value;
  if (!category) { oeAlertMsg("请填写费用类型（如 网线费 / 安装费 / 机器费 / 样品费）"); return; }
  if (!(amount > 0)) { oeAlertMsg("金额必须大于 0"); return; }
  if (!date) { oeAlertMsg("请选择日期"); return; }
  const body = { category, amount, date, remark: ($("oeRemark").value || "").trim() };
  const editing = !!OE_EDIT_ID;
  try {
    if (editing) await api("/api/other-expenses/" + OE_EDIT_ID, "PUT", body);
    else await api("/api/other-expenses", "POST", body);
    // 若该日期不在当前统计区间内，自动把区间扩到能看见它（避免"保存了却看不到"）
    if ($("oeDateFrom").value && date < $("oeDateFrom").value) $("oeDateFrom").value = date;
    if ($("oeDateTo").value && date > $("oeDateTo").value) $("oeDateTo").value = date;
    toast(editing ? "已保存修改" : `已登记 ${category} ${fmtMoney(amount)}`);
    oeResetForm();
    await loadOtherExpensePage();
  } catch (e) { oeAlertMsg("保存失败：" + e.message); }
}

async function oeDelete(id) {
  const r = OE_ROWS.find((x) => x.id === id);
  if (!confirm(r ? `确认删除 ${r.date}「${r.category}」${fmtMoney(r.amount)}？` : "确认删除该开支记录？")) return;
  try {
    await api("/api/other-expenses/" + id, "DELETE");
    if (OE_EDIT_ID === id) oeResetForm();
    toast("已删除");
    await loadOtherExpensePage();
  } catch (e) { toast("删除失败：" + e.message); }
}

/* =============== 库存流水 =============== */
async function loadMovements() {
  const pid = $("mvProduct").value || "0";
  const from = $("mvDateFrom").value, to = $("mvDateTo").value;
  let rows = await api(`/api/movements?product_id=${pid}&date_from=${from || ""}&date_to=${to || ""}`);
  renderMvChart(rows, +pid);
  const kw = ($("mvSearch")?.value || "").trim().toLowerCase();
  if (kw) rows = rows.filter((m) => [m.date, m.product_name, m.remark, m.operator].join(" ").toLowerCase().includes(kw));
  const t = $("mvTable");
  rows = applyTableSort(t, rows);
  const typeBadge = { in: '<span class="badge in">入库</span>', out: '<span class="badge out">出库</span>', pack_out: '<span class="badge pack">包装消耗</span>', work: '<span class="badge income">工作量</span>', adjust: '<span class="badge adjust">盘点</span>', cost: '<span class="badge adjust">均价重估</span>', avg: '<span class="badge adjust">均价重估</span>', ucost: '<span class="badge adjust">成本单价</span>' };
  t.innerHTML = `<thead><tr>
    <th data-key="date">时间${sortArrow("mvTable", "date")}</th>
    <th data-key="product_name">商品${sortArrow("mvTable", "product_name")}</th>
    <th data-key="move_type">类型${sortArrow("mvTable", "move_type")}</th>
    <th data-key="quantity_base" class="num">变动(真实单位)${sortArrow("mvTable", "quantity_base")}</th>
    <th data-key="amount" class="num">金额${sortArrow("mvTable", "amount")}</th>
    <th data-key="operator">操作员${sortArrow("mvTable", "operator")}</th>
    <th>备注</th></tr></thead><tbody>` +
    rows.map((m) => {
      const v = m.quantity_display != null ? m.quantity_display : m.quantity_base;
      const unit = m.unit || "";
      return `<tr>
      <td class="mono">${m.date}</td>
      <td>${esc(m.product_name)}</td>
      <td>${typeBadge[m.move_type] || m.move_type}</td>
      <td class="num mono" style="color:${v >= 0 ? "var(--green)" : "var(--red)"}">${v >= 0 ? "+" : ""}${fmtNum(v)} ${esc(unit)}</td>
      <td class="num mono">${fmtMoney(m.amount)}</td>
      <td>${esc(m.operator) || "—"}</td>
      <td class="muted">${esc(m.remark)}</td></tr>`;
    }).join("") + `</tbody>`;
  if (!rows.length) t.innerHTML = `<tr><td colspan="7" class="empty">暂无流水</td></tr>`;
  t._rows = rows;
  t._render = loadMovements;
}

/* 近一个月库存变动柱状图：按日聚合净变动（单商品用默认单位，全部商品用基础单位） */
function renderMvChart(rows, pid) {
  const box = $("mvChart");
  if (!box) return;
  const from = $("mvDateFrom").value, to = $("mvDateTo").value;
  const useDisp = !!pid; // 选中具体商品时按默认单位展示
  const byDate = {};
  rows.forEach((m) => {
    const v = useDisp ? (m.quantity_display != null ? m.quantity_display : m.quantity_base) : m.quantity_base;
    byDate[m.date] = (byDate[m.date] || 0) + v;
  });
  const end = to ? new Date(to + "T00:00:00") : new Date();
  const start = from ? new Date(from + "T00:00:00") : new Date(end.getTime() - 29 * 86400000);
  const days = [];
  for (let d = new Date(start); d <= end; d.setDate(d.getDate() + 1)) {
    const ds = `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`;
    days.push({ ds, v: byDate[ds] || 0 });
  }
  if (days.length > 62) days.splice(0, days.length - 62); // 防止日期范围过大
  const p = useDisp ? PRODUCTS.find((x) => x.id === pid) : null;
  const unit = p ? (p.default_unit || p.base_unit) : "基础单位";
  const max = Math.max(1, ...days.map((d) => Math.abs(d.v)));
  box.innerHTML = `<div class="mv-chart-title">近${days.length}天库存变动趋势（${unit}，绿=净入库/红=净出库）</div><div class="mv-chart">` +
    days.map((d) => {
      const h = Math.max(2, Math.round(Math.abs(d.v) / max * 100));
      const cls = d.v > 0 ? "up" : d.v < 0 ? "down" : "zero";
      const label = d.v ? (d.v > 0 ? "+" : "") + fmtNum(d.v) : "";
      return `<div class="mv-col" title="${d.ds}：${d.v ? (d.v > 0 ? "+" : "") + fmtNum(d.v) : "0"} ${unit}">
        <span class="mv-val">${label}</span>
        <div class="mv-track"><div class="mv-bar ${cls}" style="height:${h}%"></div></div>
        <div class="mv-x">${d.ds.slice(5)}</div></div>`;
    }).join("") + `</div>`;
}

/* =============== 工作量统计（人工打包） =============== */
async function loadWorkload() {
  const from = $("wlDateFrom").value, to = $("wlDateTo").value;
  const d = await api(`/api/workload?date_from=${from || ""}&date_to=${to || ""}`);
  renderWorkload(d);
}
function renderWorkload(d) {
  $("wlTotal").textContent = fmtNum(d.total_workload) + " 单";
  $("wlTotalSub").textContent = `成本 ${fmtMoney(d.total_cost)} · ${d.by_product.length} 个打包工种`;
  const max = Math.max(1, ...d.by_product.map((x) => x.workload));
  $("wlChart").innerHTML = `<div class="mv-chart-title">各人工打包工作量（${d.by_product.length ? "单" : "—"}）</div><div class="wl-bars">` +
    d.by_product.map((x) => {
      const w = Math.round(x.workload / max * 100);
      return `<div class="wl-row" title="${esc(x.name)}：${fmtNum(x.workload)} 单 · 成本 ${fmtMoney(x.cost)}">
        <span class="wl-name">${esc(x.name)}</span>
        <span class="wl-track"><span class="wl-bar" style="width:${Math.max(2, w)}%"></span></span>
        <span class="wl-val">${fmtNum(x.workload)}</span></div>`;
    }).join("") +
    (d.by_product.length ? "" : `<div class="wl-empty">该时间段暂无人工作量</div>`) + `</div>`;
  const t = $("wlTable");
  t.innerHTML = `<thead><tr>
    <th>人工工种</th><th class="num">工作量(单)</th><th class="num">单位单价</th><th class="num">成本</th></tr></thead><tbody>` +
    d.by_product.map((x) => `<tr>
      <td><b>${esc(x.name)}</b></td>
      <td class="num mono">${fmtNum(x.workload)} ${esc(x.unit)}</td>
      <td class="num mono">${fmtMoney(x.rate)}/${esc(x.unit)}</td>
      <td class="num mono">${fmtMoney(x.cost)}</td></tr>`).join("") +
    (d.by_product.length ? "" : `<tr><td colspan="4" class="empty">该时间段无人工工作量</td></tr>`) + `</tbody>`;
  t._rows = d.by_product;
  t._render = () => renderWorkload(d);
}

/* ---------- HTML 转义 ---------- */
function esc(s) {
  return String(s ?? "").replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));
}

/* ---------- 初始化 ---------- */
(async function init() {
  try {
    const cfg = await fetch("/config.json", { cache: "no-store" }).then((r) => r.json());
    Object.assign(ROUTES, cfg.routes || {});
  } catch (e) {}
  showLogin();
  try {
    const me = await api("/api/auth/me");
    setUser(me);
    hideLogin();
  } catch (e) {
    return; // 未登录，停留在登录页
  }
  // 预设默认日期范围：入库记录本月，出库记录当天
  $("inDate").value = today();
  $("outDate").value = today();
  $("inDateFrom").value = monthStart();
  $("inDateTo").value = today();
  $("outDateFrom").value = today();
  $("outDateTo").value = today();
  $("mvDateFrom").value = today(); // 库存流水默认显示当天
  $("mvDateTo").value = today();
  $("wlDateFrom").value = monthStart(); // 工作量统计默认本月
  $("wlDateTo").value = today();
  $("adjDateFrom").value = monthStart(); // 盘点记录默认本月
  $("adjDateTo").value = today();

  // 加载基础数据（失败不阻塞初始化，保证默认范围与首页可用）
  try {
    PRODUCTS = await api("/api/products");
    UNITS = await api("/api/units");
  } catch (e) { PRODUCTS = PRODUCTS || []; UNITS = UNITS || []; }
  try {
    $("mvProduct").innerHTML = `<option value="0">全部商品</option>` +
      PRODUCTS.filter((p) => !["人工", "快递"].includes(p.category)).map((p) => `<option value="${p.id}">${esc(p.name)}</option>`).join("");
    const adjF = $("adjProductFilter");
    if (adjF) adjF.innerHTML = `<option value="0">全部商品</option>` +
      PRODUCTS.filter((p) => p.is_active && p.product_type === "stock" && !["人工", "快递"].includes(p.category)).map((p) => `<option value="${p.id}">${esc(p.name)}</option>`).join("");
    $("inProduct").innerHTML = `<option value="">选择商品…</option>` +
      PRODUCTS.filter((p) => p.is_active && p.product_type === "stock").map((p) => `<option value="${p.id}">${esc(p.name)}</option>`).join("");
    $("inUnit").onchange = calcInbound;
  } catch (e) {}
  try { bindSearchable(document); } catch (e) {}
  loadDashboard();
})();

/* =============== 批量导入 =============== */
function downloadTpl(kind) {
  window.location.href = routePath(`/api/templates/${kind}`);
}
async function doImport(kind) {
  const idMap = { products: "impProdFile", inbounds: "impInFile", outbounds: "impOutFile" };
  const resMap = { products: "impProdResult", inbounds: "impInResult", outbounds: "impOutResult" };
  const file = $(idMap[kind]).files[0];
  if (!file) { toast("请先选择 Excel 文件"); return; }
  const box = $(resMap[kind]);
  box.innerHTML = `<div class="alert ok">⏳ 正在导入，请稍候…</div>`;
  try {
    const r = await apiUpload(`/api/import/${kind}`, file);
    let html = `<div class="alert ok">✓ 导入完成：成功 <b>${r.created}</b> 条` +
      (r.skipped ? `，跳过已存在 <b>${r.skipped}</b> 条` : "") +
      (r.failed_count ? `，失败 <b>${r.failed_count}</b> 条` : "") + `</div>`;
    if (r.failed && r.failed.length) {
      html += `<table class="subtable" style="width:100%;"><tr><th style="width:80px;">行/单号</th><th>原因</th></tr>` +
        r.failed.map((f) => `<tr><td>${esc(f.row)}</td><td class="muted">${esc(f.reason)}</td></tr>`).join("") + `</table>`;
    }
    if (r.warnings && r.warnings.length) {
      html += `<div class="alert warn">⚠ ${r.warnings.map(esc).join("；")}</div>`;
    }
    box.innerHTML = html;
    toast("导入完成");
    PRODUCTS = await api("/api/products");
    if (kind === "products") renderProducts();
    else loadStock();
  } catch (e) {
    box.innerHTML = `<div class="alert err">导入失败：${esc(e.message)}</div>`;
  }
}

/* =============== 批量导入弹窗（入库/出库/聚水潭） =============== */
const BATCH_MODAL = {
  inbound: {
    title: "批量入库",
    tpl: "/api/templates/inbounds",
    preview: "/api/import/inbounds/preview",
    confirm: "/api/import/inbounds/confirm",
    hint: "按模板填写后上传，先解析预览（可勾选、改数量单价），确认后才真正入库并更新库存。若商品类别配置了扣点，单价将按 原价×(1-扣点%) 自动折算。",
  },
  outbound: {
    title: "批量出库",
    tpl: "/api/templates/outbounds",
    preview: "/api/import/outbounds/preview",
    confirm: "/api/import/outbounds/confirm",
    hint: "按模板填写后上传，先解析到列表供你检查（可勾选、改数量单价），确认后才真正出库。",
  },
  jushuitan: {
    title: "导入聚水潭出库单",
    tpl: "",
    preview: "/api/jushuitan/import/preview",
    confirm: "/api/jushuitan/import/confirm",
    hint: "上传聚水潭导出的「销售出库单_*.xlsx」，自动识别商品并按件数×每件规格结算。先解析预览，确认后才出库。需先在「编码关联」中把商品名关联到系统商品。",
  },
};
function openBatchModal(kind) {
  const cfg = BATCH_MODAL[kind];
  if (!cfg) return;
  openModal(`
    <h3>${cfg.title} <button class="close" onclick="closeModal()">✕</button></h3>
    <p class="hint" style="margin-bottom:12px;">${cfg.hint}</p>
    ${cfg.tpl ? `<a class="btn secondary" href="${cfg.tpl}" download style="margin-bottom:12px;"><svg class="ic"><use href="#i-download"/></svg> 下载批量模板</a>` : ""}
    <div class="field"><label>选择 Excel 文件</label><input type="file" id="bmFile" accept=".xlsx" /></div>
    <div id="bmResult"></div>
    <div class="modal-foot">
      <button class="btn secondary" onclick="closeModal()">取消</button>
      <button class="btn" onclick="runBatchModal('${kind}')">${cfg.preview ? "解析预览" : "开始导入"}</button>
    </div>`);
}
/* 从「导入与关联」页带文件打开批量弹窗 */
function batchFromImport(kind) {
  const src = kind === "outbound" ? $("impOutFile") : kind === "inbound" ? $("impInFile") : $("mpImportFile");
  const f = src && src.files[0];
  openBatchModal(kind);
  if (f && $("bmFile")) {
    const dt = new DataTransfer();
    dt.items.add(f);
    $("bmFile").files = dt.files;
  }
}
async function runBatchModal(kind) {
  const cfg = BATCH_MODAL[kind];
  const file = ($("bmFile") && $("bmFile").files[0]) || window.__BM_FILE__;
  if (!file) { toast("请先选择 Excel 文件"); return; }
  if (kind === "jushuitan") window.__BM_FILE__ = file; // 供 AI 关联后一键重新解析
  const box = $("bmResult");
  box.innerHTML = `<div class="alert ok">⏳ 正在解析…</div>`;
  try {
    const r = await apiUpload(cfg.preview, file);
    if (kind === "inbound") renderInboundReview(kind, r);
    else renderDraftReview(kind, r);
  } catch (e) { box.innerHTML = `<div class="alert err">解析失败：${esc(e.message)}</div>`; }
}
/* AI 自动新增库存大类 + 编码关联：识别未关联商品名 → 建库存大类并关联 → 重新解析出库单 */
async function aiAutoMap(kind) {
  const codes = (window.__LAST_UNMAPPED__ || []).filter(Boolean);
  if (!codes.length) { toast("没有可关联的商品名"); return; }
  const box = $("bmResult");
  try {
    if (box) box.innerHTML = `<div class="alert ok">🤖 AI 正在归并库存大类并建立编码关联…（通常数秒）</div>`;
    const r = await api("/api/mappings/ai-suggest", "POST", { source: "jushuitan", codes });
    const add = (r.created_products || []).map((p) => p.name).join("、");
    toast(r.message || "AI 关联完成");
    if (box) box.innerHTML = `<div class="alert ok">✅ ${esc(r.message)}${add ? "（新建：" + esc(add) + "）" : ""}</div>`;
    if ((r.leftover || []).length) {
      box.innerHTML += `<div class="alert warn">仍无法关联：${r.leftover.map(esc).join("、")}，可到「编码关联」手动补充后重试。</div>`;
    }
    // 关联完成，重新解析（含已关联商品），用户可直接确认出库
    setTimeout(() => { if (window.__BM_FILE__) runBatchModal(kind); }, 300);
  } catch (e) {
    toast("AI 关联失败：" + e.message);
    if (box) box.innerHTML = `<div class="alert err">AI 关联失败：${esc(e.message)}</div>`;
  }
}
function renderDraftReview(kind, r) {
  const orders = r.orders || [];
  // 一单多货规则带出的包材/人工行：按 doc_no 记录，确认出库时一并回传
  window.__DRAFT_PACK__ = {};
  orders.forEach((o) => { if (o.pack_lines && o.pack_lines.length) window.__DRAFT_PACK__[o.doc_no] = o.pack_lines; });
  let warn = "";
  if (r.unmapped_codes && r.unmapped_codes.length) {
    window.__LAST_UNMAPPED__ = kind === "jushuitan" ? (r.unmapped_codes || []) : [];
    warn += `<div class="alert warn">⚠ 未关联商品：${r.unmapped_codes.map(esc).join("、")}` +
      (kind === "jushuitan"
        ? `<div style="margin-top:8px;"><button class="btn secondary" onclick="aiAutoMap('${kind}')">🤖 AI 自动新增并关联，重新解析</button>
           <span class="muted" style="font-size:12px;">用 AI 识别这些商品名，自动建库存大类并关联编码</span></div>`
        : `<div class="muted" style="font-size:12px;margin-top:6px;">请到「编码关联」关联后重新解析。</div>`) +
      `</div>`;
  }
  if (r.skip && Object.values(r.skip).some((v) => v > 0)) warn += `<div class="alert warn">⚠ 跳过：${Object.entries(r.skip).filter(([, v]) => v > 0).map(([k, v]) => `${k} ${v}单`).join("、")}</div>`;
  if (r.failed && r.failed.length) warn += `<div class="alert err">解析失败 ${r.failed.length} 条：${r.failed.slice(0, 5).map((f) => esc(f.reason)).join("；")}</div>`;
  if (!orders.length) {
    $("modalBox").innerHTML = `<h3>${BATCH_MODAL[kind].title} <button class="close" onclick="closeModal()">✕</button></h3>
      <div class="alert warn">未解析出可出库的单据。</div>${warn}
      <div class="modal-foot"><button class="btn secondary" onclick="openBatchModal('${kind}')">返回重新选择</button></div>`;
    return;
  }
  const body = orders.map((o, oi) => `
    <div class="draft-order" data-doc="${esc(o.doc_no)}" data-date="${esc(o.date)}" data-customer="${esc(o.customer || "")}"
         data-operator="${esc(o.operator || "")}" data-remark="${esc(o.remark || "")}" data-packfee="${o.pack_fee || 0}"
         data-packruleid="${o.pack_rule_id || ""}" data-packrulename="${esc(o.pack_rule_name || "")}">
      <div class="draft-head">
        <label style="display:flex;gap:6px;align-items:center;"><input type="checkbox" class="draft-check" checked onchange="updateDraftCount('${kind}')" /> 出库</label>
        <b>${esc(o.doc_no || "（无单号）")}</b>
        <span class="muted">${esc(o.customer || "—")} · ${esc(o.date)}${o.pack_fee ? " · 打包费 " + fmtMoney(o.pack_fee) : ""}</span>
      </div>
      <table class="subtable">
        <thead><tr><th>商品</th><th>单位</th><th>数量</th><th>单价</th><th>金额</th></tr></thead>
        <tbody>${(o.lines || []).map((l) => `
          <tr class="draft-line" data-pid="${l.product_id}" data-unit="${esc(l.unit)}" data-gross="${l.gross_sales || ""}">
            <td>${esc(l.product_name)}${l.deduct ? `<div class="muted" style="font-size:12px;">${esc(l.deduct)}</div>` : ""}</td>
            <td>${esc(l.unit)}</td>
            <td><input class="draft-qty" type="number" step="any" value="${l.quantity}" oninput="draftLineCalc(this)" style="width:80px;" /></td>
            <td><input class="draft-price" type="number" step="any" value="${l.price}" oninput="draftLineCalc(this)" style="width:90px;" /></td>
            <td class="draft-amt">${fmtMoney(l.amount)}</td>
          </tr>`).join("")}
        </tbody>
      </table>
    </div>`).join("");
  $("modalBox").innerHTML = `<h3>${BATCH_MODAL[kind].title} — 确认出库 <button class="close" onclick="closeModal()">✕</button></h3>
    <div class="alert ok">解析出 <b>${orders.length}</b> 单。可勾选、修改数量/单价后点击「确认出库」。</div>
    ${warn}
    <div class="draft-list">${body}</div>
    <div class="modal-foot">
      <button class="btn secondary" onclick="openBatchModal('${kind}')">重新选择文件</button>
      <button class="btn green" onclick="confirmDraft('${kind}')">✓ 确认出库（<span id="draftCount">${orders.length}</span> 单）</button>
    </div>`;
}
function draftLineCalc(inp) {
  const tr = inp.closest("tr");
  const qty = parseFloat(tr.querySelector(".draft-qty").value) || 0;
  const price = parseFloat(tr.querySelector(".draft-price").value) || 0;
  tr.querySelector(".draft-amt").textContent = fmtMoney(qty * price);
}
function updateDraftCount(kind) {
  const n = document.querySelectorAll("#modalBox .draft-order .draft-check:checked").length;
  $("draftCount").textContent = n;
}
async function confirmDraft(kind) {
  if (window.__CONFIRMING__) return; // 防止重复提交
  const orders = [];
  document.querySelectorAll("#modalBox .draft-order").forEach((od) => {
    if (!od.querySelector(".draft-check").checked) return;
    const lines = [];
    od.querySelectorAll(".draft-line").forEach((tr) => {
      const pid = +tr.dataset.pid;
      const unit = tr.dataset.unit;
      const qty = parseFloat(tr.querySelector(".draft-qty").value);
      const price = parseFloat(tr.querySelector(".draft-price").value) || 0;
      const gross = parseFloat(tr.dataset.gross) || 0;
      if (pid && unit && qty > 0) lines.push({ product_id: pid, unit, quantity: qty, price, gross_sales: gross });
    });
    if (!lines.length) return;
    const packMap = window.__DRAFT_PACK__ || {};
    const pid = od.dataset.packruleid ? +od.dataset.packruleid : null;
    const pname = (od.dataset.packrulename || "").trim();
    orders.push({
      doc_no: od.dataset.doc, date: od.dataset.date, customer: od.dataset.customer,
      operator: od.dataset.operator, remark: od.dataset.remark,
      pack_fee: parseFloat(od.dataset.packfee) || 0, lines,
      pack_rule_id: pid,
      pack_rule_name: pname,
      pack_lines: packMap[od.dataset.doc] || [],
    });
  });
  if (!orders.length) { toast("没有勾选任何单据"); return; }
  // 提交中等待提示：替换确认区为运行提示，防止用户反复点击
  window.__CONFIRMING__ = true;
  $("modalBox").innerHTML = `<h3>${BATCH_MODAL[kind].title} <button class="close" onclick="closeModal()">✕</button></h3>
    <div class="alert ok" style="text-align:center;">
      <div style="font-size:16px;font-weight:bold;margin-bottom:6px;">⏳ 正在提交出库，操作运行中…</div>
      <div class="muted" style="font-size:13px;">共 ${orders.length} 单，一般数秒内完成；请勿关闭窗口或重复点击。完成后将自动展示结果。</div>
    </div>`;
  try {
    const r = await api(BATCH_MODAL[kind].confirm, "POST", { orders });
    let html = `<div class="alert ok">✓ 已创建 <b>${r.created}</b> 个出库单`;
    if (r.failed_count) html += `，失败 <b>${r.failed_count}</b>`;
    html += `</div>`;
    if (r.warnings && r.warnings.length) html += `<div class="alert warn">⚠ ${r.warnings.map(esc).join("；")}</div>`;
    if (r.failed && r.failed.length) html += `<div class="alert err">失败：${r.failed.map((f) => esc(f.reason)).join("；")}</div>`;
    $("modalBox").innerHTML = `<h3>${BATCH_MODAL[kind].title} <button class="close" onclick="closeModal()">✕</button></h3>${html}
      <div class="modal-foot"><button class="btn" onclick="closeModal()">完成</button></div>`;
    // 把出库记录列表日期切到这批单据的日期范围，确保刚导入的单据可见
    const dates = orders.map((o) => o.date).filter(Boolean);
    if (dates.length) {
      const ds = [...dates].sort();
      $("outDateFrom").value = ds[0];
      $("outDateTo").value = ds[ds.length - 1];
    }
    loadOutbounds(); loadStock();
  } catch (e) { toast("确认出库失败：" + e.message); }
  finally { window.__CONFIRMING__ = false; }
}

/* ---------- 批量入库预览/确认 ---------- */
function renderInboundReview(kind, r) {
  const items = r.items || [];
  window.__INBOUND_DRAFT__ = items; // 供确认时取回完整数据
  let warn = "";
  if (r.failed && r.failed.length) warn += `<div class="alert err">解析失败 ${r.failed.length} 条：${r.failed.slice(0, 5).map((f) => esc(f.reason)).join("；")}</div>`;
  if (!items.length) {
    $("modalBox").innerHTML = `<h3>${BATCH_MODAL[kind].title} <button class="close" onclick="closeModal()">✕</button></h3>
      <div class="alert warn">未解析出可入库的数据。</div>${warn}
      <div class="modal-foot"><button class="btn secondary" onclick="openBatchModal('${kind}')">返回重新选择</button></div>`;
    return;
  }
  const rows = items.map((it, i) => `
    <tr class="draft-line" data-i="${i}">
      <td>${esc(it.product_name)}</td>
      <td>${esc(it.unit)}</td>
      <td><input class="draft-qty" type="number" step="any" value="${it.quantity}" oninput="draftLineCalc(this)" style="width:80px;" /></td>
      <td><input class="draft-price" type="number" step="any" value="${it.unit_price}" oninput="draftLineCalc(this)" style="width:90px;" /></td>
      <td class="draft-amt">${fmtMoney(it.quantity * it.unit_price)}</td>
      <td class="muted">${esc(it.supplier || "—")} · ${esc(it.date)}</td>
    </tr>`).join("");
  $("modalBox").innerHTML = `<h3>${BATCH_MODAL[kind].title} — 确认入库 <button class="close" onclick="closeModal()">✕</button></h3>
    <div class="alert ok">解析出 <b>${items.length}</b> 行。可勾选、修改数量/单价后点击「确认入库」。</div>
    ${warn}
    <table class="subtable" style="width:100%;">
      <thead><tr><th style="width:34px;"><input type="checkbox" checked onchange="toggleDraftAll(this)" /></th><th>商品</th><th>单位</th><th>数量</th><th>单价</th><th>金额</th><th>供应商 · 日期</th></tr></thead>
      <tbody>${rows}</tbody>
    </table>
    <div class="modal-foot">
      <button class="btn secondary" onclick="openBatchModal('${kind}')">重新选择文件</button>
      <button class="btn green" onclick="confirmInbound('${kind}')">✓ 确认入库（<span id="inDraftCount">${items.length}</span> 行）</button>
    </div>`;
}
function toggleDraftAll(cb) {
  document.querySelectorAll("#modalBox .draft-line").forEach((tr) => { tr.classList.toggle("draft-off", !cb.checked); });
  const n = cb.checked ? document.querySelectorAll("#modalBox .draft-line").length : 0;
  const el = $("inDraftCount");
  if (el) el.textContent = n;
}
async function confirmInbound(kind) {
  const all = document.querySelectorAll("#modalBox .draft-line");
  const items = [];
  const off = document.querySelector("#modalBox thead input[type=checkbox]")?.checked !== false;
  all.forEach((tr) => {
    if (!off) return;
    const i = +tr.dataset.i;
    const it = window.__INBOUND_DRAFT__[i];
    const qty = parseFloat(tr.querySelector(".draft-qty").value);
    const price = parseFloat(tr.querySelector(".draft-price").value) || 0;
    if (qty > 0) items.push({ ...it, quantity: qty, unit_price: price });
  });
  if (!items.length) { toast("没有可入库的数据"); return; }
  try {
    const r = await api(BATCH_MODAL[kind].confirm, "POST", { items });
    let html = `<div class="alert ok">✓ 已入库 <b>${r.created}</b> 条`;
    if (r.failed_count) html += `，失败 <b>${r.failed_count}</b>`;
    html += `</div>`;
    if (r.failed && r.failed.length) html += `<div class="alert err">失败：${r.failed.map((f) => esc(f.reason)).join("；")}</div>`;
    $("modalBox").innerHTML = `<h3>${BATCH_MODAL[kind].title} <button class="close" onclick="closeModal()">✕</button></h3>${html}
      <div class="modal-foot"><button class="btn" onclick="closeModal()">完成</button></div>`;
    const dates = items.map((it) => it.date).filter(Boolean);
    if (dates.length) {
      const ds = [...dates].sort();
      $("inDateFrom").value = ds[0];
      $("inDateTo").value = ds[ds.length - 1];
    }
    loadInbounds(); loadStock();
  } catch (e) { toast("确认入库失败：" + e.message); }
}

/* =============== 聚水潭编码关联 =============== */
async function loadMappingPage() {
  try {
    MAPPINGS = await api("/api/mappings");
    renderMappings();
  } catch (e) {
    const box = $("mpMappingStats");
    if (box) box.innerHTML = `<div class="alert err">加载关联明细失败：${esc(e.message)}</div>`;
  }
}
function renderMappings() {
  const d = MAPPINGS || { summary: {}, items: [] };
  const s = d.summary || {};
  $("mpMappingStats").innerHTML = `<div class="mp-summary">
    <div class="mp-sum-item">关联总数 <b>${s.total || 0}</b></div>
    <div class="mp-sum-item ok">已关联 <b>${s.linked || 0}</b></div>
    <div class="mp-sum-item warn">未关联 <b>${s.unlinked || 0}</b></div>
    <div class="mp-sum-item">→ 关联结算（订单商品）<b>${s.linked_order || 0}</b></div>
    <div class="mp-sum-item">→ 库存商品 <b>${s.linked_stock || 0}</b></div>
  </div>`;
  const kw = ($("mpSearch")?.value || "").trim().toLowerCase();
  const f = $("mpFilter")?.value || "";
  let items = d.items || [];
  if (kw) items = items.filter((m) =>
    (m.external_code || "").toLowerCase().includes(kw) || (m.product_name || "").toLowerCase().includes(kw));
  if (f === "linked") items = items.filter((m) => m.product_id);
  else if (f === "unlinked") items = items.filter((m) => !m.product_id);
  else if (f === "order") items = items.filter((m) => m.product_type === "order");
  else if (f === "stock") items = items.filter((m) => m.product_type === "stock");
  const tbody = items.map((m) => {
    const typeBadge = !m.product_id
      ? '<span class="badge off">未关联</span>'
      : (!m.product_name
        ? '<span class="badge off">已失效</span>'
        : (m.product_type === "order" ? '<span class="badge income">订单</span>' : '<span class="badge adjust">库存</span>'));
    const prodCell = m.product_id
      ? `<b>${esc(m.product_name || "（已删除商品）")}</b>${m.product_category ? `<div class="muted" style="font-size:12px;">${esc(m.product_category)}</div>` : ""}`
      : '<span class="muted">—</span>';
    const stockCell = !m.product_id ? "—"
      : (m.product_type === "order"
        ? (m.stock_product_name ? esc(m.stock_product_name) : '<span style="color:var(--red)">未关联库存</span>')
        : '<span class="muted">—</span>');
    return `<tr>
      <td><b>${esc(m.external_code)}</b>${m.external_name && m.external_name !== m.external_code ? `<div class="muted" style="font-size:12px;">${esc(m.external_name)}</div>` : ""}</td>
      <td>${prodCell}</td>
      <td>${typeBadge}</td>
      <td class="muted">${stockCell}</td>
      <td class="line-actions">
        <button class="btn sm secondary" onclick="mappingEdit(${m.id})">编辑</button>
        <button class="btn sm danger" onclick="mappingDelete(${m.id})">删除</button>
      </td>
    </tr>`;
  }).join("");
  $("mpMappingTable").querySelector("tbody").innerHTML =
    tbody || `<tr><td colspan="5" class="empty">暂无关联，可上传聚水潭出库单自动生成，或点击「手动新增关联」</td></tr>`;
}
function mappingAdd() { mappingEdit(null); }
async function mappingEdit(id) {
  if (!PRODUCTS.length) { try { PRODUCTS = await api("/api/products"); } catch (e) {} }
  const m = id
    ? ((MAPPINGS?.items || []).find((x) => x.id === id) || { external_code: "", product_id: null })
    : { external_code: "", product_id: null };
  const opts = ['<option value="">（不关联 / 清空）</option>']
    .concat((PRODUCTS || []).map((p) => `<option value="${p.id}" ${m.product_id === p.id ? "selected" : ""}>${esc(p.name)}（${p.product_type === "order" ? "订单" : "库存"} · ${esc(p.category || "—")}）</option>`))
    .join("");
  openModal(`
    <h3>${id ? "编辑" : "新增"}聚水潭关联 <button class="close" onclick="closeModal()">✕</button></h3>
    <div class="form-grid">
      <div class="field" style="grid-column:1/-1;"><label>聚水潭商品名（外部编码）*</label><input id="mpEditCode" value="${esc(m.external_code || "")}" placeholder="如：新鲜香蕈菌250g" /></div>
      <div class="field" style="grid-column:1/-1;"><label>关联系统商品</label><select id="mpEditProduct" class="searchable">${opts}</select>
        <div class="field-hint">导入出库单时，聚水潭商品名将按此映射结算；选「不关联」可清空</div></div>
    </div>
    <div class="modal-foot">
      <button class="btn secondary" onclick="closeModal()">取消</button>
      <button class="btn" onclick="mappingSave()">保存</button>
    </div>`);
}
async function mappingSave() {
  const external_code = ($("mpEditCode").value || "").trim();
  const pv = $("mpEditProduct").value;
  const product_id = pv ? +pv : null;
  if (!external_code) { toast("请填写聚水潭商品名"); return; }
  try {
    await api("/api/mappings", "POST", { source: "jushuitan", external_code, product_id });
    toast("已保存"); closeModal();
    MAPPINGS = await api("/api/mappings");
    renderMappings();
  } catch (e) { toast("保存失败：" + e.message); }
}
async function mappingDelete(id) {
  const m = (MAPPINGS?.items || []).find((x) => x.id === id);
  if (!confirm(`确认删除关联「${m ? m.external_code : id}」？`)) return;
  try {
    await api("/api/mappings/" + id, "DELETE");
    toast("已删除");
    MAPPINGS = await api("/api/mappings");
    renderMappings();
  } catch (e) { toast("删除失败：" + e.message); }
}
async function parseJushuitan() {
  const file = $("mpFile").files[0];
  if (!file) { toast("请先选择聚水潭出库单文件"); return; }
  try {
    const r = await apiUpload("/api/jushuitan/parse", file);
    MP_CODES = r.codes || [];
    const skip = Object.entries(r.skip).filter(([, v]) => v > 0).map(([k, v]) => `${k} ${v}单`).join("、");
    const codes = MP_CODES;
    const created = codes.filter((c) => c.status === "自动新增");
    const existed = codes.filter((c) => c.status === "已存在");
    const linked = codes.filter((c) => !!c.stock_product_name);
    const unlinked = codes.filter((c) => !c.stock_product_name);
    let html = `<div class="alert ok">共 <b>${r.total_orders}</b> 单已出库，解析出 <b>${codes.length}</b> 种订单商品` +
      (skip ? `，跳过（${skip}）` : "") + `。</div>`;
    html += `<div class="mp-summary">
      <div class="mp-sum-item ok"><b>${linked.length}</b> 种已关联库存商品${linked.length ? `（${linked.map((c) => `${esc(c.product_name)} → ${esc(c.stock_product_name)}`).join("、")}）` : ""}</div>
      <div class="mp-sum-item">本次自动新增 <b>${created.length}</b> 种订单商品${existed.length ? `，已存在未新增 ${existed.length} 种` : ""}</div>` +
      (unlinked.length ? `<div class="mp-sum-item warn">未匹配库存 <b>${unlinked.length}</b> 种：${unlinked.map((c) => esc(c.product_name)).join("、")}（可在出库页「关联结算」中维护）</div>` : "") + `
    </div>`;
    $("mpParseInfo").innerHTML = html;
  } catch (e) { $("mpParseInfo").innerHTML = `<div class="alert err">解析失败：${esc(e.message)}</div>`; }
}
async function autoMapping() {
  try {
    const r = await api("/api/mappings/auto", "POST");
    toast(`自动匹配 ${r.matched}/${r.total} 条`);
    loadMappingPage();
  } catch (e) { toast("匹配失败：" + e.message); }
}
async function clearMapping() {
  if (!confirm("确认清空全部编码关联？")) return;
  try { await api("/api/mappings", "DELETE"); toast("已清空"); loadMappingPage(); }
  catch (e) { toast("清空失败：" + e.message); }
}
async function importJushuitan() {
  const file = $("mpImportFile").files[0];
  if (!file) { toast("请先选择聚水潭出库单文件"); return; }
  $("mpImportResult").innerHTML = `<div class="alert ok">⏳ 正在导入并结算，请稍候…</div>`;
  try {
    const r = await apiUpload("/api/jushuitan/import", file);
    const skip = Object.entries(r.skip).filter(([, v]) => v > 0).map(([k, v]) => `${k} ${v}单`).join("、");
    let html = `<div class="alert ok">✓ 已生成 <b>${r.created}</b> 个出库单` +
      (skip ? `，跳过（${skip}）` : "") +
      (r.failed_count ? `，失败 <b>${r.failed_count}</b> 单` : "") + `</div>`;
    if (r.unmapped_codes && r.unmapped_codes.length) {
      html += `<div class="alert warn">⚠ 以下商品未关联，请在①中关联后重新导入：${r.unmapped_codes.map(esc).join("、")}</div>`;
    }
    if (r.warnings && r.warnings.length) {
      html += `<div class="alert warn">⚠ ${r.warnings.map(esc).join("；")}</div>`;
    }
    if (r.failed && r.failed.length) {
      html += `<table class="subtable" style="width:100%;"><tr><th style="width:140px;">出库单号</th><th>原因</th></tr>` +
        r.failed.map((f) => `<tr><td>${esc(f.doc)}</td><td class="muted">${esc(f.reason)}</td></tr>`).join("") + `</table>`;
    }
    $("mpImportResult").innerHTML = html;
    toast("导入完成");
    loadStock();
  } catch (e) {
    $("mpImportResult").innerHTML = `<div class="alert err">导入失败：${esc(e.message)}</div>`;
  }
}
