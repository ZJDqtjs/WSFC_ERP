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
    // 表格还可以自带 _sortVal（见 renderProducts）：把「显示出来那一格的值」换成排序值
    const derive = tbl._sortVal;
    const valOf = (r) => {
      const v = derive ? derive(r, k) : undefined;
      if (v !== undefined) return v;
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
/* 「成本」格的悬停说明：这格优先显示库存均价（随出入库自动重算），没有均价才用它手填的参考成本。
   （用户容易以为这格就是自己填的参考成本，所以鼠标停上去要说清楚） */
function refCostTitle(p) {
  const du = defaultUnit(p);
  const f = unitFactor(p, du);
  const ref = p.unit_cost > 0 ? `${fmtMoney(p.unit_cost * f)}/${du}` : "未设置";
  if (p.avg_cost > 0) {
    return `显示的是库存均价 ${fmtMoney(p.avg_cost * f)}/${du}（随出入库自动重算）；你手填的参考成本：${ref}`;
  }
  return p.unit_cost > 0
    ? `该商品还没有入库均价，显示的是你手填的参考成本 ${ref}`
    : "未设置成本：可到商品编辑页按默认单位填「参考成本」，或入库后自动形成均价";
}
/* 参考成本那一格的「排序值」：与 refCostHtml 的显示规则完全一致（均价优先，无则参考成本，按默认单位换算）。
   两者都为 0 时这一格显示「—」，排序时按空值处理（详见 compareVal），免得点了表头却看不出变化。 */
function refCostValue(p) {
  const c = Number(p.avg_cost) > 0 ? Number(p.avg_cost) : (Number(p.unit_cost) || 0);
  if (!(c > 0)) return null;
  return c * (unitFactor(p, defaultUnit(p)) || 1);
}
/* 库存那一格的「排序值」：与列表里这一格显示的内容对齐——
   订单商品这一格显示的是「经库存商品」（库存记在它关联的库存商品上），故取该库存商品的现有库存；
   人工显示的是工作量；其余按默认单位换算后的库存。 */
/* 订单商品的扣减库存商品清单（支持多个；兼容旧的单关联字段） */
function prodStockLinks(p) {
  const raw = Array.isArray(p.stock_links) && p.stock_links.length
    ? p.stock_links
    : (p.stock_product_id ? [{ product_id: p.stock_product_id, multiplier: p.multiplier || 1 }] : []);
  return raw.map((l) => ({
    product_id: l.product_id,
    multiplier: Number(l.multiplier) || 1,
    name: l.name || (PRODUCTS.find((x) => x.id === l.product_id) || {}).name || "?",
    default_unit: l.default_unit || ((PRODUCTS.find((x) => x.id === l.product_id) || {}).default_unit || ""),
  }));
}
function stockSortValue(p) {
  if (p.product_type === "order") {
    const links = prodStockLinks(p);
    if (!links.length) return 0; // 代发（未关联库存商品）：本仓不持有该商品库存
    const sp = PRODUCTS.find((x) => x.id === links[0].product_id);
    if (!sp) return 0;
    return (Number(sp.stock) || 0) / (unitFactor(sp, defaultUnit(sp)) || 1);
  }
  if (p.category === "人工") return Number(p.workload) || 0;
  return (Number(p.stock) || 0) / (unitFactor(p, defaultUnit(p)) || 1);
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
  home: "工作台", stock: "库存管理",   inbound: "入库", outbound: "出库 / 销售",
  "warehouse-in": "入仓", "wingroup": "入仓批次明细", eva: "待办处理",
  products: "商品", report: "财务报表", otherexp: "其他开支", payables: "待付款账单",
  import: "批量导入", jushuitan: "聚水潭关联",
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
  if (!page) return;   // 老书签/失效深链（如 #/eva）不再报错
  page.classList.add("active");
  const loaders = {
    home: loadDashboard, stock: loadStock, inbound: initInbound, outbound: initOutbound,
    "warehouse-in": loadWarehouseIn, wingroup: renderWinGroupPage,
    products: renderProducts, report: loadReport, import: loadImportPage, jushuitan: loadMappingPage,
    backup: loadBackupPage, fresh: loadFresh, packrules: loadPackRules, pdata: loadPdataPage,
    "fresh-in": loadFreshInbound,   // 鲜货入库（二级页，从出库/销售页进入，也可用 #/fresh-in 深链）
    deduction: loadDeductionPage, express: loadExpressPage, settings: loadSettingsPage,
    otherexp: loadOtherExpensePage, payables: loadPayablesPage,
    eva: loadEva,   // 待办处理（AI 识别队列 / 入库待办 / 出库待办），也可用 #/eva 深链
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
  else if (panel === "jstauto") loadJstAutoPage();
  else if (panel === "modules") renderNavModulesPanel();
}
async function loadSettingsPage() { switchSettingsTab("pdata"); }

/* ---------- 模块显示调整（侧边栏功能显隐，记忆化到本机浏览器） ---------- */
const NAV_HIDDEN_KEY = "erp_nav_hidden"; // 本机偏好前缀；实际按分仓隔离，见 navHiddenKey()
/** 侧边栏导航项的稳定标识：页面 + 分类/类型限定，保证「商品 / 关联结算 / 包材」各自独立 */
function navModKey(el) {
  const parts = [el.dataset.page || (el.dataset.action ? "action:" + el.dataset.action : "?")];
  if (el.dataset.cat) parts.push("cat=" + el.dataset.cat);
  if (el.dataset.type) parts.push("type=" + el.dataset.type);
  return parts.join("|");
}
/** 侧边栏显隐偏好按分仓隔离：key = erp_nav_hidden:<分仓key>，未取到分仓时退回全局 */
function navHiddenKey() {
  const wh = (CURRENT_USER && CURRENT_USER.warehouse && CURRENT_USER.warehouse.key) || "";
  return wh ? `${NAV_HIDDEN_KEY}:${wh}` : NAV_HIDDEN_KEY;
}
function getHiddenNavMods() {
  try { return new Set(JSON.parse(localStorage.getItem(navHiddenKey()) || "[]")); }
  catch (e) { return new Set(); }
}
function setHiddenNavMods(set) { localStorage.setItem(navHiddenKey(), JSON.stringify([...set])); }
/** 按本机偏好应用侧边栏显隐；「设置」入口锁定常显，避免把自己锁死 */
function applyNavVisibility() {
  const nav = document.querySelector(".side-nav");
  if (!nav) return;
  const hidden = getHiddenNavMods();
  nav.querySelectorAll(":scope > .nav-item").forEach((el) => {
    const locked = el.dataset.page === "settings";
    el.style.display = (!locked && hidden.has(navModKey(el))) ? "none" : "";
  });
  // 分组内功能全被隐藏时，连带隐藏该分组标题
  let group = null, hasVisible = false;
  const flush = () => { if (group) group.style.display = hasVisible ? "" : "none"; };
  nav.querySelectorAll(":scope > .nav-group, :scope > .nav-item").forEach((el) => {
    if (el.classList.contains("nav-group")) { flush(); group = el; hasVisible = false; }
    else if (el.style.display !== "none") hasVisible = true;
  });
  flush();
}
/** 设置页「模块显示」面板：按侧边栏分组列出各功能的显示开关 */
function renderNavModulesPanel() {
  const box = $("navModList");
  const nav = document.querySelector(".side-nav");
  if (!box || !nav) return;
  const hidden = getHiddenNavMods();
  const groups = [];
  let cur = { name: "", items: [] };
  nav.querySelectorAll(":scope > .nav-group, :scope > .nav-item").forEach((el) => {
    if (el.classList.contains("nav-group")) {
      if (cur.items.length) groups.push(cur);
      cur = { name: el.textContent.trim(), items: [] };
    } else {
      const locked = el.dataset.page === "settings";
      cur.items.push({ key: navModKey(el), label: el.textContent.trim(), locked });
    }
  });
  if (cur.items.length) groups.push(cur);
  box.innerHTML = groups.map((g) => `
    <div class="card" style="margin-bottom:10px;">
      <div class="card-head"><h3>${esc(g.name || "其他")}</h3><span class="hint">勾选后在侧边栏显示</span></div>
      <div class="form-grid">
        ${g.items.map((it) => `
          <label class="check-inline" ${it.locked ? 'title="设置入口固定显示，不可隐藏"' : ""}>
            <input type="checkbox" ${hidden.has(it.key) ? "" : "checked"} ${it.locked ? "disabled" : ""}
              onchange="toggleNavModule('${it.key}', this.checked)" /> ${esc(it.label)}
          </label>`).join("")}
      </div>
    </div>`).join("") + `
    <p class="hint">当前分仓：<b>${esc((CURRENT_USER && CURRENT_USER.warehouse && CURRENT_USER.warehouse.name) || "未指定分仓")}</b>。
    显隐设置<b>按分仓各自独立保存</b>，切换分仓后互不影响；隐藏只影响左侧菜单的显示，不影响数据与权限；「设置」入口始终保留，方便随时回来调整。</p>`;
}
function toggleNavModule(key, visible) {
  const hidden = getHiddenNavMods();
  if (visible) hidden.delete(key); else hidden.add(key);
  setHiddenNavMods(hidden);
  applyNavVisibility();
  toast(visible ? "已显示该模块" : "已隐藏该模块");
}
function resetNavModules() {
  setHiddenNavMods(new Set());
  applyNavVisibility();
  renderNavModulesPanel();
  toast("已恢复显示全部模块");
}
/* 支持通过地址栏 hash 深链到二级页（用于「未关联商品」跳转新标签手动新增商品）
   例：#/products/new?name=新鲜香蕈菌250g */
function applyHashRoute() {
  const raw = (location.hash || "").replace(/^#\/?/, "");
  if (!raw) return;
  const [path, qs] = raw.split("?");
  const params = new URLSearchParams(qs || "");
  const segs = path.split("/").filter(Boolean);
  const page = segs[0] || "";
  if (!page) return;
  if (page === "settings") {
    goPage("settings");
    switchSettingsTab(segs[1] || params.get("tab") || "pdata");
  } else if (page === "products" && segs[1] === "new") {
    goPage("products");
    const name = params.get("name") || "";
    setTimeout(() => openProductModal(0, name), 80);
  } else {
    goPage(page);
  }
}
window.addEventListener("hashchange", applyHashRoute);
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
  ["inOperator", "outOperator", "adjOperator", "fOperator", "finOperator"].forEach((id) => {
    const el = $(id);
    if (!el) return;
    el.value = disp;
    el.readOnly = true;
    el.title = "默认当前登录账号，不可修改";
  });
  // 入库页每一行（可多行）的操作员同样回填并锁定
  document.querySelectorAll(".in-operator").forEach((el) => {
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
  // 待办按分仓隔离：退出后不留上一个分仓的待办与角标（数据仍在各自分仓的存储里，下次登录照旧）
  AI_QUEUE = [];
  AI_QUEUE_FILES.clear();
  AI_QUEUE_CURRENT = null;
  AI_CONFIRM = null;
  try { refreshEvaBadge(); renderEva(); } catch (e) {}
  showLogin();
});

/* ---------- 弹窗 ---------- */
function openModal(html) {
  $("modalBox").innerHTML = html;
  $("modalMask").classList.add("show");
  bindSearchable($("modalBox"));
}
function closeModal() {
  // 关掉 AI 确认框前先把改过的明细自动暂存回待办（localStorage 持久化），
  // 避免误点 ✕ / 点遮罩 / 中途离开就把辛苦改的行全丢了（已提交的任务不动）
  try {
    if (AI_CONFIRM && $("aiLines")) { aiSaveDraft(true); AI_CONFIRM = null; }
  } catch (e) { /* 暂存失败不影响关闭 */ }
  $("modalMask").classList.remove("show");
  $("modalBox").classList.remove("wide");
  AI_QUEUE_CURRENT = null;   // 关掉确认框就不再认为"正在提交某条待办"
}
$("modalMask").addEventListener("click", (e) => { if (e.target.id === "modalMask") closeModal(); });

/* ---------- 付款状态（已付款 / 待付款，默认已付款）---------- */
/** 一组单选：用于弹窗表单（入库/入仓/出库/其他开支/手动记账统一用它） */
function payRadios(name, current, hint) {
  const cur = current === "unpaid" ? "unpaid" : "paid";
  return `<div class="pay-radios">` + [["paid", "已付款"], ["unpaid", "待付款"]].map(([v, label]) =>
    `<label class="pay-radio${cur === v ? " on" : ""}"><input type="radio" name="${name}" value="${v}"${cur === v ? " checked" : ""} onchange="payRadioSync(this)" /> ${label}</label>`
  ).join("") + `</div>` + (hint ? `<div class="field-hint">${hint}</div>` : "");
}
function payRadioSync(el) {
  const box = el.closest(".pay-radios");
  if (box) box.querySelectorAll(".pay-radio").forEach((l) => l.classList.toggle("on", l.querySelector("input").checked));
}
/** 读当前选中的付款状态（默认已付款） */
function payOf(name) {
  const el = document.querySelector(`input[name="${name}"]:checked`);
  return el ? el.value : "paid";
}
/** 回填付款状态（编辑时） */
function setPay(name, value) {
  const v = value === "unpaid" ? "unpaid" : "paid";
  document.querySelectorAll(`input[name="${name}"]`).forEach((b) => {
    b.checked = b.value === v;
    if (b.checked) payRadioSync(b);
  });
}
/** 待付款标记（列表里提示该笔还没结清） */
function payTag(status) {
  return (status || "paid") === "unpaid" ? '<span class="pay-tag">待付款</span>' : "";
}

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
    (!kw || (p.name || "").toLowerCase().includes(kw) || (p.category || "").toLowerCase().includes(kw)) &&
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
    <div class="field" style="margin-top:10px;"><label>原因 / 备注（可贴盘点照片）</label>
      <textarea id="adjRemark" rows="1" placeholder="如：盘点差异/损耗；可直接 Ctrl+V 粘贴图片" onpaste="pasteRemarkFiles('adjRemark', event)"></textarea>
      <div class="attach-bar">
        <button type="button" class="btn sm secondary" onclick="$('adjRemarkFile').click()"><svg class="ic"><use href="#i-paperclip"/></svg> 图片 / 附件</button>
        <span class="attach-tip">支持图片、PDF、Excel 等（≤20MB），可直接 Ctrl+V 粘贴</span>
        <input type="file" id="adjRemarkFile" multiple style="display:none;" onchange="uploadRemarkFiles('adjRemark', this)" />
      </div>
      <div class="attach-list" id="adjRemarkFiles"></div>
    </div>
    <div class="modal-foot">
      <button class="btn secondary" onclick="closeModal()">取消</button>
      <button class="btn" onclick="submitAdjust()">确认调整</button>
    </div>`);
  clearRemarkField("adjRemark");   // 每次打开都清空上一次的附件
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
      remark: remarkValue("adjRemark"),   // 纯文本 + 附件路径（图片/PDF），与其它单据备注同一格式
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
        <td class="muted">${renderRemarkHtml(r.remark)}</td>
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
  refreshPayBadge();   // 侧边栏「待付款账单」角标
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
let AI_THINK_TEXT = "";    // 累计的「思考过程」原文（确认框里可展开回看）
let AI_ANSWER_TEXT = "";   // 累计的模型正式输出（中文「思路」+ JSON）
const AI_THINK_MAX = 20000; // 面板最多保留的字符数（票据识别的思考常有 1.5 万字），超出只留尾部
let AI_THINK_OPEN = false;  // 原始思考（该模型只能用英文）默认收起，点「展开英文思考」才看
function aiShowThinking() {
  AI_THINK_TEXT = "";
  AI_ANSWER_TEXT = "";
  AI_THINK_OPEN = false;
  $("aiThinking").classList.remove("done");
  $("aiThinking").style.display = "";
  $("aiThinkWrap").style.display = "";
  $("aiThinkBody").textContent = "";
  $("aiThinkBody").style.display = "none";   // 英文原始思考默认收起
  $("aiAnswerBody").textContent = "";
  $("aiAnswerBody").style.display = "none";
  $("aiAnswerHead").style.display = "none";
  $("aiThinkStage").textContent = "已开始识别…";
  $("aiThinkTitle").textContent = "AI 思考中";
  $("aiThinkToggle").style.display = "none";
  $("aiThinkToggle").textContent = "展开英文思考";
  $("aiCancelBtn").style.display = "";
  AI_START = Date.now();
  clearInterval(AI_TIMER);
  AI_TIMER = setInterval(() => {
    $("aiThinkTime").textContent = `${((Date.now() - AI_START) / 1000).toFixed(0)}s`;
  }, 500);
}
// 识别结束：不直接隐藏，保留「思考过程」供查看；标题转完成态、隐藏取消、给出收起按钮
function aiFinishThinking(title) {
  clearInterval(AI_TIMER);
  AI_TIMER = null;
  $("aiThinking").classList.add("done");
  $("aiThinkTitle").textContent = title || "AI 思考过程";
  $("aiThinkToggle").style.display = "";
  $("aiCancelBtn").style.display = "none";
}
function aiHideThinking() {   // 彻底隐藏（用户主动取消时）
  clearInterval(AI_TIMER);
  AI_TIMER = null;
  $("aiThinking").style.display = "none";
}
function aiToggleThink() {
  AI_THINK_OPEN = !AI_THINK_OPEN;
  $("aiThinkBody").style.display = AI_THINK_OPEN ? "" : "none";
  $("aiThinkToggle").textContent = AI_THINK_OPEN ? "收起英文思考" : "展开英文思考";
}
function aiSetStage(s) {
  if (s) $("aiThinkStage").textContent = s;
}
function _aiFill(el, text) {
  el.textContent = text.length > AI_THINK_MAX ? "…（前面内容略）\n" + text.slice(-AI_THINK_MAX) : text;
  el.scrollTop = el.scrollHeight;
}
function aiAppendThink(s) {           // 模型原始思考（该模型 reasoning 通道只能用英文）
  if (!s) return;
  AI_THINK_TEXT += s;
  _aiFill($("aiThinkBody"), AI_THINK_TEXT);
  $("aiThinkToggle").style.display = "";
  if (!AI_THINK_OPEN) {
    // 收起状态：用阶段行报告进度，避免看起来"一片空白"
    aiSetStage(`模型正在思考…（已 ${AI_THINK_TEXT.length} 字；原始思考为英文，中文思路稍后在下方输出）`);
  }
}
function aiAppendAnswer(s) {          // 模型正式输出：中文「思路」+ JSON
  if (!s) return;
  if (!AI_ANSWER_TEXT) aiSetStage("正在输出中文思路与识别结果…");
  AI_ANSWER_TEXT += s;
  $("aiAnswerHead").style.display = "";
  $("aiAnswerBody").style.display = "";
  _aiFill($("aiAnswerBody"), AI_ANSWER_TEXT);
}
function aiCancel() {
  if (AI_QUEUE_CTRL) AI_QUEUE_CTRL.abort();   // 队列里正在跑的那条（识别中的取消按钮）
  if (AI_CTRL) AI_CTRL.abort();
  aiHideThinking();
  aiResetBtn();          // 取消后按钮恢复可用
  toast("已取消识别");
}
function aiResetBtn() {
  AI_CTRL = null;
  $("aiBtn").disabled = false;
  $("aiBtn").innerHTML = '<svg class="ic"><use href="#i-ai"/></svg> 识别并录入';
}
/**
 * 读取识别接口的 SSE 流。
 * sink 可注入：默认把思考/结果写进工作台的「AI 思考」面板；队列识别时会传入自己的 sink，
 * 把内容同时写到任务对象（待办页展示）而不打开确认框。
 */
async function aiCollectStream(res, sink) {
  const out = sink || {
    think: (s) => aiAppendThink(s),
    answer: (s) => aiAppendAnswer(s),
    stage: (s) => aiSetStage(s),
  };
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
      if (obj.think) {
        out.think(obj.think);              // 模型的思考过程，实时逐字展示
      } else if (obj.stage) {
        out.stage(obj.stage);              // 当前阶段提示
      } else if (obj.delta) {
        out.answer(obj.delta);             // 模型正式输出（中文思路 + JSON）
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
/* 注：原来「识别完立刻弹确认框」的 aiParse / aiRecognizeOne 已由队列识别取代
   （见下方「AI 识别队列 · 待办处理」：入队 → 后台识别 → /eva 审核提交）。 */
function aiPickImage() { $("aiImgFile").click(); }
function aiCaptureImage() { $("aiCamFile").click(); }

/* ---------- 待识别图片：粘贴/选图后先预览，回车或点「识别并录入」才开始识别 ---------- */
let AI_PENDING = [];         // [{ file, url }]
let AI_PENDING_LABEL = "";   // 来源标签：粘贴 / 相册 / 拍照
function aiAddPending(files, label) {
  const list = Array.from(files || []).filter((f) => f && /^image\//.test(f.type || ""));
  if (!list.length) return;
  AI_PENDING_LABEL = label || "";
  list.forEach((f) => AI_PENDING.push({ file: f, url: URL.createObjectURL(f) }));
  aiRenderPending();
  toast(`已添加 ${list.length} 张图片，按回车或点「识别并录入」开始识别`);
}
function aiRemovePending(i) {
  const it = AI_PENDING.splice(i, 1)[0];
  if (it && it.url) URL.revokeObjectURL(it.url);
  aiRenderPending();
}
function aiClearPending() {
  AI_PENDING.forEach((it) => { if (it && it.url) URL.revokeObjectURL(it.url); });
  AI_PENDING = [];
  aiRenderPending();
}
function aiRenderPending() {
  const box = $("aiPending");
  if (!box) return;
  if (!AI_PENDING.length) { box.style.display = "none"; box.innerHTML = ""; return; }
  const withText = !!$("aiText").value.trim();
  box.style.display = "";
  box.innerHTML =
    `<div class="ai-pending-head">🖼 待识别图片 ${AI_PENDING.length} 张` +
    `<span class="muted">按回车或点「识别并录入」开始识别${withText ? "（输入框文字会作为补充说明一起发给 AI）" : ""}</span></div>` +
    `<div class="ai-pending-list">` + AI_PENDING.map((it, i) =>
      `<div class="ai-pending-item">` +
        `<img src="${it.url}" alt="待识别图片" title="点击放大" onclick="openAttachmentPreview('${it.url}','待识别图片')" />` +
        `<button type="button" class="ai-pending-x" title="移除这张" onclick="aiRemovePending(${i})">✕</button>` +
      `</div>`).join("") +
    `</div>`;
}
function aiParseImage(src) {
  const inp = src === "cam" ? $("aiCamFile") : $("aiImgFile");
  const files = Array.from(inp.files || []);
  inp.value = "";
  if (!files.length) return;
  aiAddPending(files, src === "cam" ? "拍照" : "相册");
}
// 回车 /「识别并录入」：把当前输入加入队列，AI 后台识别；识别完到「待办处理」批量审核提交
function aiRun() {
  const text = $("aiText").value.trim();
  if (AI_PENDING.length) {
    const files = AI_PENDING.map((it) => it.file);
    const label = AI_PENDING_LABEL || "已选";
    files.forEach((f) => aiQueueAdd({ kind: "image", text, image_name: f.name, source: label, file: f }));
    aiClearPending();
    $("aiText").value = "";     // 补充说明已随任务带走，清空方便继续录入
    toast(`已加入队列 ${files.length} 张图片，AI 后台识别中（可继续录入）`);
    return;
  }
  if (!text) { toast("请输入入库/出库描述，或先粘贴/选择票据图片"); return; }
  aiQueueAdd({ kind: "text", text, source: "文字" });
  $("aiText").value = "";
  toast("已加入队列，AI 后台识别中（可继续录入）");
}
// Ctrl+V 粘贴图片：只加入「待识别」预览，按回车或点「识别并录入」加入队列（不再粘贴即识别）
document.addEventListener("paste", (e) => {
  // 粘贴目标若是「备注/附件」输入框：交给其自身 onpaste 走附件上传，不加入 AI 待识别
  const _pt = e.target;
  if (_pt && _pt.closest && _pt.closest("textarea[onpaste]")) return;
  const files = Array.from((e.clipboardData || {}).items || [])
    .filter((it) => it.type.startsWith("image/"))
    .map((it) => it.getAsFile())
    .filter(Boolean);
  if (!files.length) return;
  // 只在「工作台」页（AI 录入卡片可见）接管，避免在别的页面误触发、顶掉正在填的表单
  const box = $("aiText");
  if (!box || !box.offsetParent) { toast("图片已忽略：请到「工作台 → AI 智能录入」粘贴票据"); return; }
  e.preventDefault();
  aiAddPending(files, "粘贴");
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
/** 出库行「没识别到商品」时的下拉：订单商品 + 库存大类一起列。
 *  用户常直接卖库存大类（如「天麻大果」按公斤），不必先切分类才能选到。 */
function aiProductOptionsWide(selectedId, prependHtml = "") {
  const list = [...aiProductsByCat("order"), ...aiProductsByCat("stock")]
    .sort((a, b) => a.name.localeCompare(b.name, "zh"));
  return prependHtml + list.map((p) =>
    `<option value="${p.id}" ${p.id === selectedId ? "selected" : ""}>〔${p.product_type === "order" ? "订单" : "库存"}〕${esc(p.name)}</option>`
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
/**
 * 兜底补价：把「已命中已有商品、但单价为空」的行按该商品最近一次录入价填上。
 * 正常后端在识别时就会填（_normalize_line），这里覆盖漏填的情形：
 * 从待办页打开的历史结果、单位没能换算的行、以前存下的旧结果等。
 * 只填空行，票据/用户已填的价一律不动；待新增商品（pid=0）没有历史价，跳过。
 */
async function aiFillMissingPrices() {
  const rows = [...document.querySelectorAll("#aiLines tr[data-idx]")];
  for (const tr of rows) {
    const sel = tr.querySelector(".ai-pid");
    const priceEl = tr.querySelector(".ai-price");
    if (!sel || !priceEl) continue;
    const pid = +sel.value || 0;
    if (!pid) continue;
    const line = AI_CONFIRM && AI_CONFIRM.lines ? AI_CONFIRM.lines[+tr.dataset.idx] : null;
    // 手动填的、票据带来的价不动；之前是「自动按最近价」填的，换入库/出库口径后允许刷新
    if (!(line && line.price_defaulted) && priceEl.value !== "" && +priceEl.value !== 0) continue;
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
      const line = AI_CONFIRM && AI_CONFIRM.lines ? AI_CONFIRM.lines[+tr.dataset.idx] : null;
      if (line) line.price_defaulted = true;
      aiPriceBadge(tr, line);
    }
  }
}
/* ---------- 盘点行：换商品后重算「当前库存 → 盘点后」与增减量 ----------
 * 后端只在识别时按「当时匹配到的商品」算过一遍；用户在确认框里手动换成别的商品后必须重算，
 * 否则会拿新商品的实盘数去减旧商品的库存（甚至是新建商品的 0），增减量就完全不对了
 * （例：识别成"小香菇"、实盘 135，当前库存算成 0 → +135；换回"香菇干货"应变成 135 − 420 = −285）。 */
function aiStockRefresh(i, opts) {
  const tr = document.querySelector(`#aiLines tr[data-idx="${i}"]`);
  const line = AI_CONFIRM && AI_CONFIRM.lines ? AI_CONFIRM.lines[i] : null;
  const typeSel = $("aiType");
  if (!tr || !line || !typeSel || typeSel.value !== "stocktake") return;
  const countEl = tr.querySelector(".ai-count");   // 实盘数（界面上可改）
  const hidEl = tr.querySelector(".ai-qty");       // 增减量（提交用，隐藏）
  const sel = tr.querySelector(".ai-pid");
  const cell = tr.querySelector(".ai-stock-cell");
  const pid = sel ? (+sel.value || 0) : 0;
  const p = PRODUCTS.find((x) => x.id === pid) || null;
  const unit = (tr.querySelector(".ai-unit") || {}).value || line.stock_unit || "";
  // 商品库存以基础单位存，按当前行单位换算（如商品按公斤记录、行单位是斤 → 1公斤=2斤）
  const before = p ? +((Number(p.stock) || 0) / (unitFactor(p, unit) || 1)).toFixed(4) : 0;
  line.product_id = pid;
  line.stock_before = before;
  line.stock_unit = unit;
  // 实盘数：优先「识别/手填的实盘数」；用户说的是增减（stock_rel）时按当前库存折算成实盘数
  // （更早的结果没有 stock_counted，就用 quantity —— 盘点行它就是识别到的实盘数）
  let counted = line.stock_counted != null ? +line.stock_counted : null;
  if (counted == null && !line.stock_count_cleared) {
    if (line.stock_rel) counted = +(before + (+line.quantity || 0)).toFixed(4);
    else if (line.quantity != null) counted = +line.quantity;
  }
  // 用户正在输入时不要覆盖他敲进去的内容
  if (countEl && !(opts && opts.keepCount)) countEl.value = counted == null ? "" : fmtNum(counted);
  // 实盘数被清空 → 该行不调整（避免拿上一次的增减量提交出去）
  const adj = line.stock_count_cleared ? 0
    : (counted == null ? (+((hidEl || {}).value) || 0) : +(counted - before).toFixed(4));
  line.stock_adjust = adj;
  line.stock_after = +(before + adj).toFixed(4);
  line.hint = [
    line.stock_count_cleared
      ? `未填实盘数：该行不调整（当前库存保持 ${fmtNum(before)}${unit}）`
      : `当前库存 ${fmtNum(before)}${unit}，实盘 ${counted == null ? "—" : fmtNum(counted)}${unit}，调整 ${adj > 0 ? "+" : ""}${fmtNum(adj)}${unit} → 盘点后 ${fmtNum(line.stock_after)}${unit}`,
    line.unit_note || ""].filter(Boolean).join("；");
  if (cell) {
    cell.innerHTML = `当前 <b>${fmtNum(before)}</b> → 调整 <b>${adj > 0 ? "+" : ""}${fmtNum(adj)}</b> → 盘点后 <b>${fmtNum(line.stock_after)}</b> ${esc(unit)}`;
  }
  const hintEl = tr.querySelector(".ai-hint");
  if (hintEl) hintEl.textContent = line.hint;
  if (hidEl) hidEl.value = fmtNum(adj);
}
/* 盘点行：手改「实盘数」→ 立刻重算增减量，并刷新「当前 → 调整 → 盘点后」与说明
   （以前只有增减量输入框、且改了不刷新库存对比，看起来像被 AI 的结果定死了） */
function aiCountChanged(i) {
  const tr = document.querySelector(`#aiLines tr[data-idx="${i}"]`);
  const line = AI_CONFIRM && AI_CONFIRM.lines ? AI_CONFIRM.lines[i] : null;
  const el = tr ? tr.querySelector(".ai-count") : null;
  if (!line || !el) return;
  const raw = (el.value || "").trim();
  const v = parseFloat(raw);
  line.stock_count_cleared = (raw === "" || isNaN(v));   // 清空 = 该行不调整
  line.stock_counted = line.stock_count_cleared ? null : v;
  line.stock_rel = false;   // 用户给了绝对实盘数，不再是「多了/少了」的相对量
  line.unit_note = "";      // 已手改，去掉上一次的换算提示
  aiStockRefresh(i, { keepCount: true });
}
/* 单位候选（datalist）：商品换算表里的单位 + 基础/默认单位 + 当前值（可下拉选，也可手填别的） */
function aiUnitSuggest(pid, curUnit) {
  const p = PRODUCTS.find((x) => x.id === (+pid || 0)) || null;
  const set = [];
  const push = (u) => { u = String(u || "").trim(); if (u && !set.includes(u)) set.push(u); };
  if (p) {
    Object.keys(p.conversions || {}).forEach(push);
    push(p.base_unit);
    push(p.default_unit);
  }
  push(curUnit);
  return set.map((u) => `<option value="${esc(u)}"></option>`).join("");
}
/* 手动改单位：能换算就按换算表把「实盘数」一起换（92袋 × 25公斤/袋 → 2300公斤），并重算库存基线 */
function aiUnitChanged(i) {
  const tr = document.querySelector(`#aiLines tr[data-idx="${i}"]`);
  const line = AI_CONFIRM && AI_CONFIRM.lines ? AI_CONFIRM.lines[i] : null;
  if (!tr || !line) return;
  const inp = tr.querySelector(".ai-unit");
  const unit = (inp ? inp.value : "").trim();
  const oldUnit = (line.stock_unit || line.unit || "").trim();
  if (unit && unit !== oldUnit) {
    const p = PRODUCTS.find((x) => x.id === (+tr.querySelector(".ai-pid").value || 0)) || null;
    const conv = (p && p.conversions) || {};
    const fOld = +conv[oldUnit] || 0, fNew = +conv[unit] || 0;
    if (fOld && fNew && line.stock_counted != null) {
      line.stock_counted = +((line.stock_counted * fOld) / fNew).toFixed(4);
      line.unit_note = `单位「${oldUnit}」→「${unit}」，数量已按换算表同步换算`;
    } else {
      line.unit_note = `单位「${oldUnit || "空"}」→「${unit}」，数量请核对（该商品换算表里没有这两个单位，无法自动换算）`;
    }
    line.unit = unit;
    line.stock_unit = unit;
    aiStockRefresh(i);
  } else if (line) {
    line.unit = unit;
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
  // 换成真实商品：识别到的单位若不在该商品的可选单位里（如占位的「袋」 vs 商品的「公斤」），
  // 自动改成商品的默认单位 —— 否则商品的「公斤」会被「袋」盖住，库存与增减量全按错单位算
  if (pid) {
    const p = PRODUCTS.find((x) => x.id === pid) || null;
    const unitInp = tr.querySelector(".ai-unit");
    const cur = (unitInp && unitInp.value || "").trim();
    const conv = (p && p.conversions) || {};
    const valid = !!cur && (cur in conv || cur === defaultUnit(p) || cur === (p && p.base_unit));
    if (p && unitInp && !valid) {
      const du = defaultUnit(p);
      const fOld = +conv[cur] || 0, fNew = +conv[du] || 0;
      if (du && du !== cur) {
        if (fOld && fNew && line && line.stock_counted != null) {
          line.stock_counted = +((line.stock_counted * fOld) / fNew).toFixed(4);
          line.unit_note = `单位已按商品「${p.name}」改为「${du}」（识别单位「${cur || "空"}」不适用），数量已按换算表同步换算`;
        } else if (line) {
          line.unit_note = `单位已按商品「${p.name}」改为「${du}」（识别单位「${cur || "空"}」不适用），数量请核对`;
        }
        unitInp.value = du;
        if (line) line.unit = du;
      }
    }
    // 单位候选（datalist）跟着商品更新：换商品后可选单位不同
    const dl = tr.querySelector("datalist");
    if (dl) dl.innerHTML = aiUnitSuggest(pid, (unitInp && unitInp.value) || "");
  }
  // 盘点行：换了商品/分类就必须重算「当前库存 → 盘点后」与增减量
  aiStockRefresh(i);
  // 已选中真实商品：去掉「🆕 提交后新增」徽标（它是按识别时的"待新增"渲染的，换商品后就不对了）
  const newBadge = tr.querySelector(".ai-newbadge");
  if (newBadge) newBadge.style.display = pid ? "none" : "";
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
/* 同种商品的多行合并成一行（数量累加）——与后端 _merge_duplicate_lines 同一口径。
   盘点是「一个商品一个实盘数」：分开提交会在同一个商品上反复调整（+3500 再 −16000），净额就错了。
   后端识别时已经合并；这里再兜一次，是为了队列里已经存下的老结果也能正确合并与提交。 */
function aiMergeDupLines(r) {
  if (!r || !Array.isArray(r.lines) || r.lines.length < 2) return r;
  const isStock = r.type === "stocktake";
  const seen = new Map();
  // 合并 = 把被并掉的行标记 _deleted，数组本身不缩短：
  // 行上的 data-idx 就是数组下标，数组一变短，下面各行改商品时就会取到「下一行」的商品与库存
  r.lines.forEach((ln) => {
    if (ln._deleted) return;
    const pid = +ln.product_id || 0;
    if (!pid) return;                          // 待新增/未匹配：可能对应不同档案，不合并
    const key = isStock
      ? `s|${pid}|${ln.stock_unit || ln.unit || ""}`
      : `d|${pid}|${ln.unit || ""}|${+(ln.unit_price || 0)}|${ln.date || ""}|${ln.paid !== false}`;
    const first = seen.get(key);
    if (!first) { seen.set(key, ln); return; }
    first.quantity = +(((+first.quantity || 0) + (+ln.quantity || 0)).toFixed(4));
    if (first.stock_counted != null && ln.stock_counted != null) {
      first.stock_counted = +((+first.stock_counted + +ln.stock_counted).toFixed(4));
    }
    first.merged_count = (+first.merged_count || 1) + 1;
    ln._deleted = true;                        // 被合并掉的行不再显示，但下标原位保留
  });
  // 合并过的行：按累加后的数量重算（提交读的是 stock_adjust / quantity）
  r.lines.forEach((ln) => {
    if (ln._deleted) return;
    const n = +ln.merged_count || 1;
    if (n <= 1) return;
    if (isStock) {
      const before = +ln.stock_before || 0;
      const du = ln.stock_unit || ln.unit || "";
      if (ln.stock_counted != null) {
        ln.stock_adjust = +((ln.stock_counted - before).toFixed(4));
        ln.stock_after = +(before + ln.stock_adjust).toFixed(4);
        ln.hint = `已把 ${n} 行合并为一行（实盘数累加）：当前库存 ${fmtNum(before)}${du}，实盘 ${fmtNum(ln.stock_counted)}${du}，调整 ${ln.stock_adjust > 0 ? "+" : ""}${fmtNum(ln.stock_adjust)}${du} → 盘点后 ${fmtNum(ln.stock_after)}${du}`;
      } else {
        ln.stock_adjust = +(+(ln.quantity || 0)).toFixed(4);
        ln.stock_after = +(before + ln.stock_adjust).toFixed(4);
        ln.hint = `已把 ${n} 行合并为一行（增减量累加）：调整 ${ln.stock_adjust > 0 ? "+" : ""}${fmtNum(ln.stock_adjust)}${du} → 盘点后 ${fmtNum(ln.stock_after)}${du}`;
      }
    } else {
      ln.hint = (ln.hint || "") + `；已把 ${n} 行合并为一行（数量累加）`;
    }
  });
  return r;
}
function openAiConfirm(r) {
  AI_CONFIRM = aiMergeDupLines(r);
  const isIn = r.type === "inbound";
  const isStock = r.type === "stocktake";   // 盘点：用识别到的数量覆盖当前库存（不是入/出库）
  const docDate = r.date || today();
  // 逐行日期：票据每行各有单据日期时，这里按行显示、可单独修改
  (r.lines || []).forEach((ln) => { ln.date = ln.date || docDate; });
  const dateSet = [...new Set((r.lines || []).map((ln) => ln.date || docDate))].sort();
  const dateHint = dateSet.length > 1
    ? `<span class="badge" style="background:var(--primary-light);color:var(--primary);margin-left:6px;">已按票据逐行取日期：${esc(dateSet[0])} ~ ${esc(dateSet[dateSet.length - 1])}（共 ${dateSet.length} 天）</span>`
    : "";
  const linesHtml = (r.lines || []).map((ln, i) => {
    // 删除的行只标记不摘除：行上的 data-idx 必须与数组下标一一对应，
    // 否则删过行之后，下面各行再改商品/单位就会取到「下一行」的商品与库存
    if (ln._deleted) return "";
    const cat = (["stock", "order", "pack", "labor"].includes(ln.category) ? ln.category : (isIn ? "stock" : "order"));
    const np = ln.new_product || null;
    let prodSel;
    if (ln.ambiguous && ln.candidates && ln.candidates.length) {
      // 相似商品：默认选中第一个候选，并在未识别到价格时回填该商品最近一次的录入价
      if (!ln.candidates.some((c) => c.product_id === ln.product_id)) ln.product_id = ln.candidates[0].product_id;
      const cur = ln.candidates.find((c) => c.product_id === ln.product_id) || ln.candidates[0];
      if (!(+ln.unit_price) && cur.last_price) { ln.unit_price = cur.last_price; ln.price_defaulted = true; }
      // searchable：和普通下拉一样支持「点击选择 / 输入筛选」（漏了它就只能滚原生下拉，无法输入搜索）
      prodSel = `<select class="searchable ai-pid" style="border-color:var(--amber);" onchange="aiProdChanged(${i})">
          <option value="0">🆕 新建：${esc(ln.recognized_name || ln.product_name || "")}</option>
          ${ln.candidates.map((c) => `<option value="${c.product_id}" ${c.product_id === ln.product_id ? "selected" : ""} data-price="${c.last_price || 0}">〔${({ stock: "库存", order: "订单", pack: "包材", labor: "人工" }[c.category] || "库存")}〕${esc(c.name)}${c.last_price ? `（最近 ${c.last_price}）` : ""}</option>`).join("")}
        </select>`;
    } else if (np) {
      // 待新增商品：仅在「确认提交」后才建档，取消不会污染商品资料
      ln.product_id = 0;
      prodSel = `<select class="searchable ai-pid" onchange="aiProdChanged(${i})">${aiProductOptions(0, cat, `<option value="0" selected>🆕 新建：${esc(np.name)}</option>`)}</select>`;
    } else if (!isIn && !isStock && !ln.product_id && !ln.category) {
      // AI 没说是什么商品（也没能判断分类）：订单商品与库存大类一起列，选完下面的包材/快递会自动算
      prodSel = `<select class="searchable ai-pid" onchange="aiProdChanged(${i})">${aiProductOptionsWide(ln.product_id, '<option value="0" selected>— 请选择商品（订单 / 库存都在这里）—</option>')}</select>`;
    } else {
      const head = ln.product_id ? "" : `<option value="0" selected>— 请选择商品 —</option>`;
      prodSel = `<select class="searchable ai-pid" onchange="aiProdChanged(${i})">${aiProductOptions(ln.product_id, cat, head)}</select>`;
    }
    const ambiBadge = ln.ambiguous
      ? '<span class="badge" style="background:#fff3cd;color:#8a6d00;margin-left:6px;">⚠ 相似商品待确认</span>' : "";
    const unitBadge = ln.unit_conflict
      ? '<span class="badge" style="background:#fde2e0;color:#b3261e;margin-left:6px;" title="' + esc(ln.unit_conflict_msg || "") + '">⚠ 单位不一致</span>' : "";
    // 盘点：数量列 = 「实盘数」（直接改成你盘到的数，系统自动算增减量去调整），
    // 单价列换成「当前 → 调整 → 盘点后」；提交时读隐藏的 .ai-qty（增减量，走既有 adjust 接口）
    const counted = ln.stock_counted != null
      ? ln.stock_counted
      : (ln.stock_rel ? +(((ln.stock_before || 0) + (+ln.quantity || 0))).toFixed(4) : ln.quantity);
    const qtyCell = isStock
      ? `<td><input type="number" step="any" class="ai-count" value="${fmtNum(counted)}" style="width:104px;" title="实盘数量（= 盘点后的库存数）：改成你实际盘到的数即可，提交时按「实盘数 − 当前库存」走增减调整" oninput="aiCountChanged(${i})" />
           <input type="hidden" class="ai-qty" value="${fmtNum(ln.stock_adjust || 0)}" /></td>`
      : `<td><input type="number" step="any" class="ai-qty" value="${fmtNum(ln.quantity)}" style="width:90px;" /></td>`;
    const stockCellHtml = `当前 <b>${fmtNum(ln.stock_before || 0)}</b> → 调整 <b>${(ln.stock_adjust || 0) > 0 ? "+" : ""}${fmtNum(ln.stock_adjust || 0)}</b> → 盘点后 <b>${fmtNum(ln.stock_after || 0)}</b> ${esc(ln.stock_unit || ln.unit || "")}`;
    const priceCell = isStock
      ? `<td class="muted ai-stock-cell" style="white-space:nowrap;" title="当前库存 → 调整 → 盘点后">${stockCellHtml}</td>`
      : `<td class="ai-price-cell"><input type="number" step="any" class="ai-price" value="${ln.unit_price ? ln.unit_price : ""}" placeholder="可留空" style="width:100px;" />${ln.price_defaulted ? '<span class="ai-price-badge" style="background:var(--amber-light);color:#8a6d00;margin-left:4px;">已按最近价</span>' : ""}</td>`;
    const payCell = isStock ? "" : `<td>${aiPayHtml(ln, i)}</td>`;
    return `<tr data-idx="${i}">
      <td><select class="ai-cat" onchange="aiCatChanged(${i})" style="width:92px;">${aiCatOptions(cat)}</select></td>
      <td style="min-width:250px;">${prodSel}${aiNewNameHtml(ln)}<div style="margin-top:4px;">${ambiBadge}${np ? '<span class="badge ai-newbadge" style="background:var(--amber-light);color:#8a6d00;margin-left:6px;">🆕 提交后新增</span>' : ""}</div></td>
      <td><input type="date" class="ai-date" value="${esc(ln.date || docDate)}" style="width:138px;" title="这一行的单据日期（对账单/送货单逐行日期）" /></td>
      ${qtyCell}
      <td><input class="ai-unit" list="aiUnitList-${i}" value="${esc(ln.unit || "")}" style="width:84px;" title="单位：可下拉选该商品已有单位，也可手填；改动会立即重算库存" onchange="aiUnitChanged(${i})" /><datalist id="aiUnitList-${i}">${aiUnitSuggest(ln.product_id, ln.unit)}</datalist>${unitBadge}</td>
      ${priceCell}
      ${payCell}
      <td class="muted ai-hint" style="font-size:12px;min-width:200px;">${esc(ln.hint || "")}</td>
      <td style="white-space:nowrap;"><button class="btn secondary" style="padding:4px 8px;" title="删除这一行" onclick="aiDelLine(${i})">🗑 删除</button></td>
    </tr>`;
  }).join("");
  const invImg = r.image_url
    ? `<div class="ai-invoice"><span class="muted">📎 票据凭证（点击预览）</span><img src="${esc(r.image_url)}" alt="票据" onclick="openAttachmentPreview('${r.image_url}','票据凭证')" /></div>`
    : "";
  // 识别时的「思考过程」也放进确认框，方便回看 AI 是怎么判断的
  const thinkHtml = AI_THINK_TEXT.trim()
    ? `<details class="ai-think-details"><summary>🧠 查看模型原始思考（英文 reasoning，${AI_THINK_TEXT.length} 字，点击展开）</summary>
         <pre>${esc(AI_THINK_TEXT.length > 12000 ? "…（前面内容略）\n" + AI_THINK_TEXT.slice(-12000) : AI_THINK_TEXT)}</pre></details>`
    : "";
  openModal(`
    <h3>确认${isStock ? "盘点（调整库存）" : (isIn ? "入库" : "出库")} <button class="close" onclick="closeModal()">✕</button></h3>
    ${invImg}
    <p class="hint" style="margin-bottom:12px;">已自动识别以下内容，请核对（可修改/可删除行）后提交；🆕 标记的商品为新物品，点「确认提交」后才会新增商品档案（取消不会创建）。单价可留空，提交后在单据里补也行。<b>每行日期取自票据该行的「单据日期」</b>，可逐行改；对账单等多日期票据会按各自日期生成单据。每行默认<b>已付款</b>，可点成「待付款」把该笔列入「待付款账单」。</p>
    ${thinkHtml}
    <div class="form-grid">
      <div class="field"><label>业务类型</label><select id="aiType" onchange="aiTypeChanged()">
        <option value="inbound" ${r.type === "inbound" ? "selected" : ""}>入库（进货）</option>
        <option value="outbound" ${r.type === "outbound" ? "selected" : ""}>出库（销售）</option>
        <option value="stocktake" ${isStock ? "selected" : ""}>盘点（增减调整库存）</option>
      </select></div>
      <div class="field"><label>整单日期</label>
        <input type="date" id="aiDate" value="${esc(docDate)}" />${dateHint}
        <button class="btn-link" style="font-size:12px;margin-left:6px;" onclick="aiApplyDateAll()">应用到所有行</button>
      </div>
      ${isStock ? "" : `<div class="field"><label>${isIn ? "供应商" : "客户"}</label><input id="aiParty" value="${esc(isIn ? r.supplier : r.customer)}" /></div>`}
      <div class="field"><label>备注（可贴盘点照片）</label>
        <textarea id="aiRemark" rows="1" placeholder="可选；可直接 Ctrl+V 粘贴图片" onpaste="pasteRemarkFiles('aiRemark', event)"></textarea>
        <div class="attach-bar">
          <button type="button" class="btn sm secondary" onclick="$('aiRemarkFile').click()"><svg class="ic"><use href="#i-paperclip"/></svg> 图片 / 附件</button>
          <span class="attach-tip">识别到的票据也会显示在这里，可再加图</span>
          <input type="file" id="aiRemarkFile" multiple style="display:none;" onchange="uploadRemarkFiles('aiRemark', this)" />
        </div>
        <div class="attach-list" id="aiRemarkFiles"></div>
      </div>
    </div>
    <div class="table-wrap"><table>
      <thead><tr><th>分类</th><th>商品</th><th>日期</th><th>${isStock ? "实盘数" : "数量"}</th><th>单位</th><th>${isStock ? "当前 → 调整 → 盘点后" : (isIn ? "单价" : "售价")}</th>${isStock ? "" : "<th>付款</th>"}<th>说明</th><th>操作</th></tr></thead>
      <tbody id="aiLines">${linesHtml || `<tr><td colspan="${isStock ? 8 : 9}" class="empty">未识别到明细</td></tr>`}</tbody>
    </table></div>
    ${aiChargeWrapHtml(r)}
    <div class="modal-foot">
      <span class="muted" style="margin-right:auto;">改完可先点「暂存修改」；直接关掉也会自动暂存，中途离开 / 刷新都不会丢</span>
      <button class="btn secondary" onclick="closeModal()">取消</button>
      <button class="btn" onclick="aiSaveDraft(false)">💾 暂存修改</button>
      <button class="btn green" onclick="aiSubmit()">✓ 确认提交</button>
    </div>`);
  $("modalBox").classList.add("wide");   // 明细列多，弹窗放宽，避免信息被挤没
  setRemarkValue("aiRemark", r.remark);  // 备注里的 /uploads/xxx（如识别票据）拆成可点开的附件标签
  if (r.type === "outbound") aiSettleRecalc();   // 出库：算好「实收金额」给用户核对（含包材/快递/固定成本）
  // 盘点行按「当前库存」重新刷一遍（暂存/重新打开时库存可能已变，避免显示过期对比）
  if (isStock) setTimeout(() => {
    document.querySelectorAll("#aiLines tr[data-idx]").forEach((tr) => aiStockRefresh(+tr.dataset.idx));
  }, 40);
  // 打开后兜底补价：已命中商品但单价为空的行，自动带出最近录入价（票据自带的价不动）
  setTimeout(() => aiFillMissingPrices(), 60);
}
/* ---------- AI 出库：关联结算（包材/快递）+ 固定成本 + 实收金额 ----------
   只说了商品名（甚至没说商品）也能出库：包材/快递按服务端口径自动算出来核对；
   「工时、胶带」这类不好量化的项目不要求建商品，直接汇总进「固定成本」，金额写进备注，
   这样对着结算表（货价 + 各项 = 合计金额）一眼就能核完再提交。 */
const AI_SETTLE_LABELS = { material: "包材", labor: "人工", express: "快递费", fee: "固定成本" };

function aiSettleCatsOf(r) {
  const cats = String((r || {}).settle_cats || "").split(",").filter(Boolean);
  return cats.length ? cats : ["material", "labor", "express"];
}
/** 当前「按金额记」的固定成本项：确认框开着时以表格里用户改过的为准，否则用识别结果 */
function aiFeeItems() {
  const rows = document.querySelectorAll("#aiChargeBody tr[data-ci]");
  if (rows.length) {
    const out = [];
    rows.forEach((tr) => {
      if (tr.querySelector(".ai-ch-kind").value !== "fee") return;
      const amt = parseFloat(tr.querySelector(".ai-ch-amt").value) || 0;
      if (amt > 0) out.push({ name: tr.querySelector(".ai-ch-name").value.trim() || "固定成本", amount: amt });
    });
    return out;
  }
  return ((AI_CONFIRM && AI_CONFIRM.charges) || []).filter((c) => c.kind === "fee" && (+c.amount || 0) > 0);
}
/** 固定成本明细（工时/胶带…）文本 + 合计 */
function aiChargeFeeNote() {
  const items = aiFeeItems();
  const sum = Math.round(items.reduce((a, c) => a + (+c.amount || 0), 0) * 100) / 100;
  return {
    text: items.map((c) => `${c.name} ${fmtMoney(+c.amount)}`).join("、"),
    sum,
  };
}
/** 固定成本写进备注（用户要求「备注清楚金额」） */
function aiChargeRemark() {
  const items = aiFeeItems();
  const sum = Math.round(items.reduce((a, c) => a + (+c.amount || 0), 0) * 100) / 100;
  if (sum <= 0) return "";
  return `【包材人工固定成本】${items.map((c) => `${c.name} ${fmtMoney(+c.amount)}`).join("、")}（合计 ${fmtMoney(sum)}）`;
}
function aiSettleChecked(box) {
  return [...(box || document).querySelectorAll(".ai-settle:checked")].map((x) => x.value);
}
/** 固定成本合计（确认框里以表格为准） */
function aiFeeSum() {
  return Math.round(aiFeeItems().reduce((a, c) => a + (+c.amount || 0), 0) * 100) / 100;
}
function aiSettleBoxes(cats) {
  return Object.keys(AI_SETTLE_LABELS).map((k) => `<label class="field-inline" style="display:inline-flex;align-items:center;gap:6px;">
      <input type="checkbox" class="ai-settle" value="${k}" ${cats.includes(k) ? "checked" : ""} onchange="aiSettleRecalc()" /> ${AI_SETTLE_LABELS[k]}
    </label>`).join("");
}
/** 关联结算区块（出库才有）；preview 由服务端算好，改了商品/数量点「重算」即可 */
function aiChargeWrapHtml(r) {
  if (!r || r.type !== "outbound") return "";
  return `<div id="aiChargeWrap">${aiChargeHtml(r)}</div>`;
}
/** 费用项「记到哪」的可选项（用户可改，改完点重算/直接提交按新口径算） */
const AI_CHARGE_KINDS = [
  ["pack", "包材 / 耗材"], ["labor", "人工"], ["express", "快递费"], ["fee", "固定成本（按金额）"],
];
/** 某个商品能挂到「包材/人工」里的候选：先给识别候选，再给同类商品 */
function aiChargeProdOptions(c, kind) {
  const want = kind === "labor" ? "labor" : "pack";
  const list = [];
  const seen = new Set();
  const push = (p) => { if (p && !seen.has(p.id)) { seen.add(p.id); list.push(p); } };
  (c.candidates || []).forEach((x) => push(PRODUCTS.find((p) => p.id === x.product_id)));
  PRODUCTS.filter((p) => p.is_active).forEach((p) => { if (aiProductsByCat(want).some((x) => x.id === p.id)) push(p); });
  return list.map((p) => {
    const du = p.default_unit || p.base_unit || "";
    const cost = (p.avg_cost || p.unit_cost || 0) * ((p.conversions || {})[du] || 1);
    return `<option value="${p.id}" ${p.id === (c.product_id || 0) ? "selected" : ""}>〔${({ stock: "库存", order: "订单", pack: "包材", labor: "人工" }[aiProductCat(p)] || "其他")}〕${esc(p.name)}${cost ? `（${fmtNum(cost)}/${esc(du)}）` : ""}</option>`;
  }).join("");
}
function aiProductCat(p) {
  const c = (p.category || "").trim();
  if (c === "人工" || /打包$/.test(p.name || "")) return "labor";
  if (["包材", "耗材", "包装"].includes(c)) return "pack";
  if (c === "快递") return "express";
  return p.product_type === "order" ? "order" : "stock";
}
/** 一行费用项：项目名 / 记到哪 / 商品（可改） / 单位 / 数量 / 金额 / 删除
 *  工时不强制选商品 —— 记到哪选「固定成本」就按金额记，并写进备注。 */
function aiChargeRowHtml(c, i) {
  const kind = c.kind || "fee";
  const needProd = kind === "pack" || kind === "labor";
  const kindSel = `<select class="ai-ch-kind" onchange="aiChargeKind(${i}, this)">` +
    AI_CHARGE_KINDS.map(([v, t]) => `<option value="${v}" ${v === kind ? "selected" : ""}>${t}</option>`).join("") + `</select>`;
  const prodSel = needProd
    ? `<select class="searchable ai-ch-pid" onchange="aiChargeProd(${i}, this)">
         <option value="0" ${c.product_id ? "" : "selected"}>— 选商品 —</option>${aiChargeProdOptions(c, kind)}
       </select>`
    : `<span class="muted" style="font-size:12px;">${kind === "express" ? "按下面的金额记快递费" : "按金额记进固定成本"}</span>`;
  const est = c.qty_est ? `<span class="badge" style="background:var(--amber-light);color:#8a6d00;margin-left:4px;" title="结算表只给了金额，按 ${fmtNum(c.unit_cost)} / ${esc(c.unit)} 反推数量；金额仍按结算表记">按金额反推</span>` : "";
  return `<tr data-ci="${i}">
    <td><input class="ai-ch-name" value="${esc(c.name || "")}" style="width:110px;" oninput="aiChargeTouch()" /></td>
    <td>${kindSel}</td>
    <td style="min-width:190px;">${prodSel}</td>
    <td><input class="ai-ch-unit" value="${esc(c.unit || "")}" style="width:64px;" ${needProd ? "" : "disabled"} /></td>
    <td><input class="ai-ch-qty" type="number" step="any" value="${c.quantity ? fmtNum(c.quantity) : ""}" placeholder="—" style="width:80px;" ${needProd ? "" : "disabled"} oninput="aiChargeTouch()" />${est}</td>
    <td><input class="ai-ch-amt" type="number" step="any" min="0" value="${c.amount ? fmtNum(c.amount) : ""}" style="width:88px;" oninput="aiChargeTouch()" /></td>
    <td><button type="button" class="btn sm danger" title="删除这一项" onclick="aiChargeDel(${i})">✕</button></td>
  </tr>`;
}
function aiChargeHtml(r) {
  const cats = aiSettleCatsOf(r);
  const charges = r.charges || [];
  const feeSum = Math.round(charges.filter((c) => c.kind === "fee").reduce((a, c) => a + (+c.amount || 0), 0) * 100) / 100;
  const feeNote = aiChargeFeeNote();
  const auto = (r.pack_lines || []).filter((p) => p.source !== "识别");
  const autoHtml = auto.map((p) => `<tr>
      <td>${esc(p.product_name)} <span class="badge pack">自动</span></td>
      <td>${esc(p.unit)}</td><td class="num mono">${fmtNum(p.quantity)}</td>
      <td class="num mono">${fmtMoney(p.amount)}</td>
      <td class="muted" style="font-size:12px;">${esc(AI_SETTLE_LABELS[p.settle_cat] || "其他")}</td>
    </tr>`).join("");
  const rowsHtml = charges.map((c, i) => aiChargeRowHtml(c, i)).join("");
  return `<h4 class="block-title" style="margin-top:14px;">包材 / 人工 / 快递（识别到的费用项，可改）<span class="muted" style="font-weight:normal;font-size:12px;">· 商品没挂对就在下拉里改，工时/胶带改成「固定成本」按金额记</span></h4>
    <div id="aiPreviewHint" class="alert ${r.preview ? "ok" : "warn"}" style="margin:6px 0;${r.preview_hint ? "" : "display:none;"}">${esc(r.preview_hint || "")}</div>
    ${rowsHtml
      ? `<div class="table-wrap"><table><thead><tr><th>项目</th><th>记到哪</th><th>商品（可改）</th><th>单位</th><th class="num">数量</th><th class="num">金额</th><th></th></tr></thead><tbody id="aiChargeBody">${rowsHtml}</tbody></table></div>`
      : `<div class="muted" style="margin:6px 0;">没识别到费用项（气泡膜、泡沫箱这类可点下面「＋ 添加」手动加）。</div>`}
    <div class="toolbar" style="margin:8px 0;">
      <button type="button" class="btn sm secondary" onclick="aiChargeAdd()">＋ 添加包材 / 人工</button>
      <button type="button" class="btn sm secondary" onclick="aiChargesRefresh()">🔄 重算（改完商品/数量点一下）</button>
      <span class="muted">固定成本合计 <b id="aiFeeSum">${fmtMoney(feeSum)}</b>${feeNote.text ? `（${esc(feeNote.text)}）` : ""}</span>
    </div>
    <h4 class="block-title">商品包装清单自动带出 / 按重量算的快递费</h4>
    <div class="table-wrap"><table><thead><tr><th>项目</th><th>单位</th><th class="num">数量</th><th class="num">金额</th><th>归属</th></tr></thead>
      <tbody id="aiAutoPackBody">${autoHtml || `<tr><td colspan="5" class="muted">无（该商品没有包装清单，也没有自动快递费）</td></tr>`}</tbody></table></div>
    <div class="form-grid" style="margin-top:10px;">
      <div class="field"><label>实收金额包含（客户随货款一起付的）</label>
        <div class="toolbar" style="margin:0;flex-wrap:wrap;gap:12px;">${aiSettleBoxes(cats)}</div>
        <div class="field-hint">勾了才计入「实收金额」与报表收入；包材/快递成本照旧结转，毛利不会被吃掉</div>
      </div>
      <div class="field"><label>金额核对</label><span id="aiChargeSum"></span></div>
    </div>`;
}
/** 收集费用项表里（用户改过）的内容：重算与提交都按这个走 */
function aiChargePick() {
  const rows = [];
  document.querySelectorAll("#aiChargeBody tr[data-ci]").forEach((tr) => {
    const i = +tr.dataset.ci;
    const base = ((AI_CONFIRM && AI_CONFIRM.charges) || [])[i] || {};
    const kind = tr.querySelector(".ai-ch-kind").value;
    const pid = +(tr.querySelector(".ai-ch-pid")?.value || 0);
    rows.push({
      name: tr.querySelector(".ai-ch-name").value.trim() || base.name || "",
      kind,
      product_id: pid,
      unit: (tr.querySelector(".ai-ch-unit").value || "").trim(),
      quantity: parseFloat(tr.querySelector(".ai-ch-qty").value) || 0,
      amount: parseFloat(tr.querySelector(".ai-ch-amt").value) || 0,
    });
  });
  return rows.filter((c) => c.name && (c.amount > 0 || c.quantity > 0));
}
/** 切换「记到哪」：换商品/单位/数量列显隐；改成固定成本就按金额记 */
function aiChargeKind(i, sel) {
  const c = ((AI_CONFIRM && AI_CONFIRM.charges) || [])[i];
  if (!c) return;
  c.kind = sel.value;
  if (c.kind !== "pack" && c.kind !== "labor") { c.product_id = 0; }
  aiChargeRender();
}
function aiChargeProd(i, sel) {
  const c = ((AI_CONFIRM && AI_CONFIRM.charges) || [])[i];
  if (!c) return;
  c.product_id = +sel.value || 0;
  const p = PRODUCTS.find((x) => x.id === c.product_id);
  if (p) { c.unit = p.default_unit || p.base_unit || c.unit || ""; c.product_name = p.name; }
  aiChargeRender();
}
function aiChargeDel(i) {
  const r = AI_CONFIRM || {};
  const list = (r.charges || []).slice();
  list.splice(i, 1);
  r.charges = list;
  aiChargeRender();
}
function aiChargeAdd() {
  const r = AI_CONFIRM || {};
  const list = (r.charges || []).slice();
  list.push({ name: "", kind: "pack", product_id: 0, unit: "", quantity: 0, amount: 0, candidates: [] });
  r.charges = list;
  aiChargeRender();
}
/** 重绘费用项表（保持已填内容），并刷新金额核对 */
function aiChargeRender() {
  const r = AI_CONFIRM || {};
  if ($("aiChargeBody")) {
    $("aiChargeBody").innerHTML = (r.charges || []).map((c, i) => aiChargeRowHtml(c, i)).join("");
    bindSearchable($("aiChargeBody"));
  }
  if ($("aiFeeSum")) $("aiFeeSum").textContent = fmtMoney(aiFeeSum());
  aiSettleRecalc();
}
/** 把当前勾选/固定成本代入，算「实收金额 / 毛利」给用户核对（口径与后端一致） */
function aiSettleRecalc() {
  const r = AI_CONFIRM || {};
  const pv = r.preview || {};
  const cats = aiSettleChecked();
  const fee = aiFeeSum();
  let settle = 0;
  (r.pack_lines || []).forEach((p) => { if (cats.includes(p.settle_cat)) settle += (+p.amount || 0); });
  if (cats.includes("fee")) settle += fee;
  settle = Math.round(settle * 100) / 100;
  const amount = +pv.amount || 0, cogs = +pv.cogs || 0;
  const el = $("aiChargeSum");
  if (!el) return;
  if (!r.preview) { el.textContent = ""; return; }
  el.innerHTML = `货价 ${fmtMoney(amount)} ＋ 代收 ${fmtMoney(settle)} = <b>实收 ${fmtMoney(amount + settle)}</b>`
    + ` · 结转成本 ${fmtMoney(cogs)} · <b style="color:${amount + settle - cogs >= 0 ? "var(--green)" : "var(--red)"}">毛利 ${fmtMoney(amount + settle - cogs)}</b>`;
}
/** 收集确认框里的出库行（供重算 / 提交） */
function aiOutboundLines() {
  return [...document.querySelectorAll("#aiLines tr[data-idx]")].map((tr) => {
    const idx = +tr.dataset.idx;
    const line = ((AI_CONFIRM && AI_CONFIRM.lines) || [])[idx] || {};
    const priceEl = tr.querySelector(".ai-price");
    return {
      product_id: +tr.querySelector(".ai-pid").value || 0,
      product_name: line.product_name || line.recognized_name || "",
      unit: tr.querySelector(".ai-unit").value.trim(),
      quantity: parseFloat(tr.querySelector(".ai-qty").value) || 0,
      unit_price: priceEl ? (parseFloat(priceEl.value) || 0) : (+line.unit_price || 0),
      _deleted: false,
    };
  }).filter((l) => l.product_id || l.product_name);
}
/** 商品/数量/费用项改过以后重算包材/快递/固定成本/实收金额（服务端口径）。
 *  keepRows=true 时保留用户正在编辑的费用项行（只刷新自动带出的行与金额），避免打字时被重绘打断。 */
async function aiChargesRefresh(keepRows) {
  const r = AI_CONFIRM || {};
  if (!r || r.type !== "outbound") return;
  try {
    const rows = document.querySelectorAll("#aiChargeBody tr[data-ci]").length ? aiChargePick() : (r.charges || []);
    const d = await api("/api/ai/outbound-preview", "POST", {
      lines: aiOutboundLines(),
      charges: rows,
    });
    Object.assign(r, {
      pack_lines: d.pack_lines || [], preview: d.preview || null, preview_hint: d.preview_hint || "",
      fee_total: d.fee_total || 0, settle_cats: d.settle_cats || "", extra_pack_lines: d.extra_pack_lines || [],
      auto_express: d.auto_express !== false,
      charges: (d.charges || []).length ? d.charges : (r.charges || []),
    });
    if (keepRows) {
      // 只刷新「自动带出」的表与金额，费用项行保持用户输入不动
      const auto = (r.pack_lines || []).filter((p) => p.source !== "识别");
      if ($("aiAutoPackBody")) {
        $("aiAutoPackBody").innerHTML = auto.length ? auto.map((p) => `<tr>
            <td>${esc(p.product_name)} <span class="badge pack">自动</span></td>
            <td>${esc(p.unit)}</td><td class="num mono">${fmtNum(p.quantity)}</td>
            <td class="num mono">${fmtMoney(p.amount)}</td>
            <td class="muted" style="font-size:12px;">${esc(AI_SETTLE_LABELS[p.settle_cat] || "其他")}</td>
          </tr>`).join("") : `<tr><td colspan="5" class="muted">无（该商品没有包装清单，也没有自动快递费）</td></tr>`;
      }
      if ($("aiFeeSum")) $("aiFeeSum").textContent = fmtMoney(aiFeeSum());
      if ($("aiPreviewHint")) {
        $("aiPreviewHint").innerHTML = esc(r.preview_hint || "");
        $("aiPreviewHint").style.display = r.preview_hint ? "" : "none";
      }
      aiSettleRecalc();
    } else if ($("aiChargeWrap")) {
      $("aiChargeWrap").innerHTML = aiChargeHtml(r);
      bindSearchable($("aiChargeWrap"));
      aiSettleRecalc();
    }
    if ((d.warnings || []).length) toast("⚠ " + d.warnings.join("；"), 3600);
  } catch (e) { toast("重算失败：" + e.message); }
}
/** 费用项输入变化：防抖重算（保留正在编辑的行） */
let AI_CHARGE_TIMER = null;
function aiChargeTouch() {
  clearTimeout(AI_CHARGE_TIMER);
  AI_CHARGE_TIMER = setTimeout(() => aiChargesRefresh(true), 600);
}
/** 从识别结果取提交用的附加项（待办页批量提交也用这套口径）。
 *  注意：提交要带上完整结算清单（商品包装清单自动带出的 + 识别到的），
 *  因为一旦传了 pack_lines，后端就不再自动补商品包装清单了；
 *  自动算出来的「快递费」行不传（后端按整单毛重自己结算），识别到的运费则按金额传。 */
function aiChargesFromResult(r) {
  if (!r || r.type !== "outbound") return null;
  // 商品包装清单自动带出的行（服务端会重新算，但要一起传，否则不再自动补）
  const auto = (r.pack_lines || [])
    .filter((p) => p.source !== "识别")
    .map((p) => ({ product_id: p.product_id, unit: p.unit, quantity: p.quantity, cogs: null }));
  // 识别/用户改过的项目（含按金额反推数量的：用服务端算好的显式成本，金额与结算表一致）
  const extra = (r.extra_pack_lines || []).map((p) => ({
    product_id: p.product_id, unit: p.unit, quantity: p.quantity,
    cogs: p.cogs != null ? p.cogs : null,
  }));
  const packs = [...auto, ...extra];
  return {
    pack_lines: packs,
    fee_total: +r.fee_total || 0,
    settle_cats: aiSettleCatsOf(r).join(","),
    auto_express: r.auto_express !== false,
    remark: aiChargeRemark(),
  };
}
/** 确认框里收集提交用的附加项（用户可能改过勾选） */
function aiChargesFromModal() {
  const r = AI_CONFIRM || {};
  if (!r || r.type !== "outbound") return null;
  const base = aiChargesFromResult(r);
  if (!base) return null;
  base.fee_total = aiFeeSum();   // 固定成本 = 费用项里「记到哪=固定成本」的那些之和（与备注一致）
  const cats = aiSettleChecked();
  base.settle_cats = Object.keys(AI_SETTLE_LABELS).filter((k) => cats.includes(k)).join(",");
  return base;
}

/** 当前确认框对应的那条队列待办（暂存 / 提交标记用） */
function aiCurrentJob() {
  if (AI_QUEUE_CURRENT) {
    const j = AI_QUEUE.find((x) => x.id === AI_QUEUE_CURRENT);
    if (j) return j;
  }
  return AI_QUEUE.find((x) => x.result && x.result === AI_CONFIRM) || null;
}
/** 暂存：把确认框里的当前修改写回待办队列（localStorage 持久化），中途离开 / 刷新都不丢 */
function aiSaveDraft(silent) {
  const body = $("aiLines");
  const typeSel = $("aiType");
  const job = aiCurrentJob();
  if (!AI_CONFIRM || !body || !typeSel || !job || job.status === "submitted") {
    if (!silent) toast("这条识别结果不在待办队列里，改完直接点「确认提交」即可");
    return false;
  }
  // 逐行把界面上的值写回「同一个行对象」（按 data-idx 取，下标与数组一一对应）
  [...body.querySelectorAll("tr[data-idx]")].forEach((tr) => {
    const ln = (AI_CONFIRM.lines || [])[+tr.dataset.idx];
    if (!ln) return;
    ln.product_id = +tr.querySelector(".ai-pid").value || 0;
    const catEl = tr.querySelector(".ai-cat");
    if (catEl) ln.category = catEl.value;
    const dateEl = tr.querySelector(".ai-date");
    if (dateEl && dateEl.value) ln.date = dateEl.value;
    const unitEl = tr.querySelector(".ai-unit");
    if (unitEl && unitEl.value.trim()) ln.unit = unitEl.value.trim();
    const countEl = tr.querySelector(".ai-count");      // 盘点：实盘数（可改）
    if (countEl) {
      const v = parseFloat(countEl.value);
      ln.stock_count_cleared = (countEl.value.trim() === "" || isNaN(v));
      ln.stock_counted = ln.stock_count_cleared ? null : v;
      if (!ln.stock_count_cleared) ln.stock_rel = false;
      const hid = tr.querySelector(".ai-qty");
      const d = hid ? parseFloat(hid.value) : NaN;
      ln.stock_adjust = isNaN(d) ? 0 : d;
    } else {
      const q = tr.querySelector(".ai-qty");
      if (q) ln.quantity = parseFloat(q.value) || 0;
    }
    const priceEl = tr.querySelector(".ai-price");
    if (priceEl) ln.unit_price = priceEl.value.trim() === "" ? 0 : (parseFloat(priceEl.value) || 0);
    const payEl = tr.querySelector(".ai-sw-in");
    if (payEl) ln.paid = !!payEl.checked;
    const nameEl = tr.querySelector(".ai-newname");
    if (nameEl && !ln.product_id) ln.recognized_name = nameEl.value.trim() || ln.recognized_name;
    const hintEl = tr.querySelector(".ai-hint");
    if (hintEl) ln.hint = hintEl.textContent;
  });
  job.result = job.result || {};
  job.result.type = typeSel.value;      // 类型可能被改过（入库/出库/盘点）
  const topDate = $("aiDate");
  if (topDate && topDate.value) job.result.date = topDate.value;
  const partyEl = $("aiParty");
  if (partyEl) {
    if (typeSel.value === "outbound") job.result.customer = partyEl.value.trim();
    else job.result.supplier = partyEl.value.trim();
  }
  const rmEl = $("aiRemark");
  if (rmEl) job.result.remark = remarkValue("aiRemark");   // 含附件（票据 / 新加的图），重开后按同一套拆成标签
  // 注意：这里不替换 lines 数组（上面已按 data-idx 原地写回），
  // 数组一换长度，行上的 data-idx 与数组下标就会错位，改商品时会取到下一行的商品/库存
  job.draft_at = new Date().toISOString();
  aiQueueSave();
  if (!silent) toast("✅ 已暂存：中途离开或刷新后，打开这条待办还能接着改");
  return true;
}
// 每行「是否已付款」开关：默认已付款；点成「待付款」后该笔提交时计入「待付款账单」
function aiPayHtml(ln, i) {
  const paid = ln.paid !== false;
  const st = paid ? "on" : "off";
  return `<label class="ai-sw" title="已付款：直接进报表 / 待付款：列入待付款账单（点开关切换）">
    <input type="checkbox" class="ai-sw-in" ${paid ? "checked" : ""} onchange="aiTogglePay(${i})" />
    <span class="ai-sw-track"></span>
    <span class="ai-sw-label ${st}">${paid ? "已付款" : "待付款"}</span>
  </label>`;
}
function aiTogglePay(i) {
  const line = AI_CONFIRM && AI_CONFIRM.lines ? AI_CONFIRM.lines[i] : null;
  const input = document.querySelector(`#aiLines tr[data-idx="${i}"] .ai-sw-in`);
  if (!input) return;
  const next = input.checked;
  const lbl = document.querySelector(`#aiLines tr[data-idx="${i}"] .ai-sw-label`);
  if (lbl) {
    lbl.textContent = next ? "已付款" : "待付款";
    lbl.classList.toggle("on", next);
    lbl.classList.toggle("off", !next);
  }
  if (line) line.paid = next;
}
// 把顶部「整单日期」应用到所有明细行（识别日期不对时一键统一）
function aiApplyDateAll() {
  const d = $("aiDate").value;
  if (!d) { toast("请先选日期"); return; }
  document.querySelectorAll("#aiLines tr[data-idx] .ai-date").forEach((el) => { el.value = d; });
  toast("已把 " + d + " 应用到所有明细行");
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
  // 只标记删除、不从数组里摘掉：数组下标要始终与行的 data-idx 对齐
  const line = AI_CONFIRM && AI_CONFIRM.lines ? AI_CONFIRM.lines[i] : null;
  if (line) line._deleted = true;
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
  // 入库/出库切换后价格口径不同：重新给空单价的已命中行补价
  setTimeout(() => aiFillMissingPrices(), 60);
}
async function aiSubmit() {
  const type = $("aiType").value;
  const date = $("aiDate").value;
  const partyEl = $("aiParty");                       // 盘点模式没有供应商/客户输入框
  const party = partyEl ? partyEl.value.trim() : "";
  const remark = remarkValue("aiRemark");   // 纯文本 + 附件（含识别票据），与其它单据备注同一格式
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
    const priceEl2 = tr.querySelector(".ai-price");           // 盘点模式没有单价输入框
    const priceRaw = priceEl2 ? priceEl2.value.trim() : "";
    return {
      product_id: pid,
      // 待新增商品：提交时才建档，避免用户取消也污染商品资料（含商品类型/包材）
      new_product: (spec && spec.name) ? spec : null,
      quantity: parseFloat(tr.querySelector(".ai-qty").value),
      unit: tr.querySelector(".ai-unit").value.trim(),
      unit_price: priceRaw === "" ? 0 : parseFloat(priceRaw),   // 单价允许留空，提交后可在单据里补
      auto_created: !!line.auto_created,
      paid: line.paid !== false,   // 默认已付款；点成「待付款」则这笔入「待付款账单」
      date: (tr.querySelector(".ai-date") || {}).value || date,   // 该行单据日期（对账单逐行日期）
    };
  }).filter((r) => r.product_id || r.new_product);
  if (!rows.length) { toast("请至少填写一条商品"); return; }
  if (rows.some((r) => !r.date)) { toast("每行都要有日期，请检查"); return; }
  if (type === "stocktake") {
    // 盘点填的是「实盘数」，换算出的增减量允许为 0（= 实盘数与当前库存一致，该行不调整、提交时跳过）
    if (rows.some((r) => isNaN(r.quantity) || !r.unit)) { toast("请填写实盘数与单位"); return; }
  } else if (rows.some((r) => !(r.quantity > 0) || !r.unit)) {
    toast("请填写数量与单位（单价可留空，提交后在单据里补）"); return;
  }
  if (type !== "stocktake" && rows.some((r) => isNaN(r.unit_price))) { toast("单价填的不是数字，请检查"); return; }
  const op = (CURRENT_USER && (CURRENT_USER.name || CURRENT_USER.username)) || "";
  try {
    // 出库：提交前按「当前行」重算一次包材/快递/固定成本（换过商品、改过数量也不会拿旧清单）
    if (type === "outbound") await aiChargesRefresh();
    const n = await submitDocRows({
      type, party, remark, imageUrl: (AI_CONFIRM && AI_CONFIRM.image_url) || "", rows, op,
      charges: type === "outbound" ? aiChargesFromModal() : null,   // 包材/快递/固定成本（服务端口径）
    });
    // 这次是从「待办处理」打开的：提交成功就把该待办标记为已完成，从待办列表消失
    if (AI_QUEUE_CURRENT) {
      const job = AI_QUEUE.find((x) => x.id === AI_QUEUE_CURRENT);
      if (job) { job.status = "submitted"; job.submitted_at = new Date().toISOString(); aiQueueSave(); }
      AI_QUEUE_CURRENT = null;
    }
    closeModal();
    AI_CONFIRM = null;
    toast(type === "stocktake" ? `盘点完成（调整 ${n} 行）`
      : (type === "inbound" ? `入库成功（${n} 行）` : `出库成功（${n} 行）`));
    loadDashboard(); loadStock(); refreshEvaBadge();
    $("aiText").value = "";
  } catch (e) { toast("提交失败：" + e.message); }
}

/* =============== AI 识别队列 · 待办处理（#/eva） ===============
   粘贴/输入不再直接弹确认框，而是入队（localStorage 持久化，刷新不丢已识别结果）；
   后台一次只跑一条，跑完自动取下一条；识别成功的按业务类型落到「入库待办 / 出库待办」，
   在 /eva 逐条审核或批量提交（提交逻辑与确认框共用 submitDocRows）。 */
const AI_QUEUE_KEY = "ai_queue_v1";  // 旧版全局 key：只用于把老数据迁到分仓维度
/** AI 识别待办按分仓隔离：key = ai_queue_v1:<分仓key>。
 *  否则在 A 仓识别的盘点/入库待办会串到 B 仓（词条对不上，还容易被误删）。 */
function aiQueueKey() {
  const wh = (CURRENT_USER && CURRENT_USER.warehouse && CURRENT_USER.warehouse.key) || "";
  return wh ? `${AI_QUEUE_KEY}:${wh}` : AI_QUEUE_KEY;
}
const AI_QUEUE_MAX = 60;            // 队列最多保留条数（超出丢最早的）
const AI_QUEUE_THINK_KEEP = 4000;   // 每条任务最多保留的思考字数（持久化用）
let AI_QUEUE = [];                  // [{id,kind,text,image_name,source,status,result,error,think,answer,...}]
const AI_QUEUE_FILES = new Map();   // id -> File（图片任务原图，只在内存；刷新后需重选）
let AI_QUEUE_CTRL = null;           // 正在识别那条的 AbortController
let AI_QUEUE_TICKING = false;
let AI_QUEUE_CURRENT = null;        // 从待办页打开确认框时记录任务 id，提交成功后标记该待办已完成
let AI_QUEUE_LIVE_T = null;

function aiQueueUid() { return Date.now().toString(36) + Math.random().toString(36).slice(2, 7); }
function evaTitle(j) {
  if (j.kind === "image") return (j.image_name || "票据图片") + (j.text ? ` · ${j.text.slice(0, 16)}` : "");
  return (j.text || "").slice(0, 30) || "（空描述）";
}
function evaMoney(j) {
  return ((j.result && j.result.lines) || []).reduce((a, ln) => a + (+ln.quantity || 0) * (+ln.unit_price || 0), 0);
}
function evaDateSpan(j) {
  const r = j.result || {};
  const ds = [...new Set((r.lines || []).map((ln) => ln.date || r.date || ""))].filter(Boolean).sort();
  if (!ds.length) return "—";
  return ds.length > 1 ? `${ds[0]} ~ ${ds[ds.length - 1]}（${ds.length} 天）` : ds[0];
}
function aiQueueSave() {
  try {
    const items = AI_QUEUE.slice(-AI_QUEUE_MAX).map((j) => ({
      id: j.id, kind: j.kind, text: j.text || "", image_name: j.image_name || "", source: j.source || "",
      status: j.status, result: j.result || null, error: j.error || "",
      think: (j.think || "").slice(-AI_QUEUE_THINK_KEEP), answer: (j.answer || "").slice(-4000),
      created_at: j.created_at, finished_at: j.finished_at || "", submitted_at: j.submitted_at || "",
      elapsed: j.elapsed || 0, draft_at: j.draft_at || "",
    }));
    localStorage.setItem(aiQueueKey(), JSON.stringify(items));
  } catch (e) { /* 配额满等：不影响主流程 */ }
}
function aiQueueLoad() {
  const key = aiQueueKey();
  try {
    let raw = localStorage.getItem(key);
    // 旧版没分仓（key 无后缀）：只迁一次到当前分仓，避免继续串仓
    if (raw == null && key !== AI_QUEUE_KEY) {
      const legacy = localStorage.getItem(AI_QUEUE_KEY);
      if (legacy) {
        localStorage.setItem(key, legacy);
        localStorage.removeItem(AI_QUEUE_KEY);
        raw = legacy;
        const whName = (CURRENT_USER && CURRENT_USER.warehouse && CURRENT_USER.warehouse.name) || "";
        setTimeout(() => toast(`已把旧版未分仓的 AI 待办归到当前分仓${whName ? "（" + whName + "）" : ""}；之后各分仓的待办互不可见`), 900);
      }
    }
    const arr = JSON.parse(raw || "[]");
    AI_QUEUE = Array.isArray(arr) ? arr.filter((j) => j && j.id) : [];
  } catch (e) { AI_QUEUE = []; }
  AI_QUEUE.forEach((j) => {
    if (j.status === "running") j.status = "waiting";            // 上次没跑完 → 重新排队
    if (j.kind === "image" && ["waiting", "running"].includes(j.status)) {
      j.status = "error";                                        // 原图只在内存里，刷新后无法续跑
      j.error = "页面刷新后原图已丢失，请回到工作台重新粘贴这张图片";
    }
  });
  refreshEvaBadge();
}
/** 入队：文字或图片（图片需把 File 传进来，内部登记到 AI_QUEUE_FILES） */
function aiQueueAdd(job) {
  const j = {
    id: aiQueueUid(), kind: job.kind, text: job.text || "", image_name: job.image_name || "",
    source: job.source || "", status: "waiting", result: null, error: "", think: "", answer: "",
    created_at: new Date().toISOString(), finished_at: "", submitted_at: "", elapsed: 0,
  };
  AI_QUEUE.push(j);
  if (job.file) AI_QUEUE_FILES.set(j.id, job.file);
  aiQueueSave();
  refreshEvaBadge();
  aiQueueTick();
  return j.id;
}
/** 后台逐条识别：一次一条，跑完自动取下一条（不占用工作台的「识别中」按钮，可继续录入） */
async function aiQueueTick() {
  if (AI_QUEUE_TICKING) return;
  const job = AI_QUEUE.find((j) => j.status === "waiting");
  if (!job) { renderAiQueueBar(); refreshEvaBadge(); return; }
  AI_QUEUE_TICKING = true;
  job.status = "running";
  job.think = "";
  job.answer = "";
  job.error = "";
  aiQueueSave();
  refreshEvaBadge();
  if ($("page-eva").classList.contains("active")) renderEva();

  AI_QUEUE_CTRL = new AbortController();
  const started = Date.now();
  aiShowThinking();                       // 工作台的面板同步显示当前这条
  aiSetStage(`队列识别中：${evaTitle(job)}`);
  const sink = {
    think: (s) => {
      job.think = (job.think + s).slice(-AI_QUEUE_THINK_KEEP);
      aiAppendThink(s);
      evaRenderLive();
    },
    stage: (s) => { job.stage = s; aiSetStage(s); evaRenderLive(); },
    answer: (s) => {
      job.answer = (job.answer + s).slice(-4000);
      aiAppendAnswer(s);
      evaRenderLive();
    },
  };
  try {
    let result;
    if (job.kind === "image") {
      const f = AI_QUEUE_FILES.get(job.id);
      if (!f) throw new Error("页面刷新后原图已丢失，请重新粘贴/选择这张图片");
      const fd = new FormData();
      fd.append("file", f);
      if (job.text) fd.append("text", job.text);
      const res = await fetch(routePath("/api/ai/parse-image/stream"), { method: "POST", body: fd, signal: AI_QUEUE_CTRL.signal });
      result = await aiCollectStream(res, sink);
    } else {
      const res = await fetch(routePath("/api/ai/parse/stream"), {
        method: "POST", headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ text: job.text }), signal: AI_QUEUE_CTRL.signal,
      });
      result = await aiCollectStream(res, sink);
    }
    job.status = "done";
    job.result = result;
    job.finished_at = new Date().toISOString();
    job.elapsed = Math.round((Date.now() - started) / 1000);
    aiFinishThinking("队列识别完成");
    AI_QUEUE_FILES.delete(job.id);        // 原图用完即弃，避免内存堆积
  } catch (e) {
    job.status = "error";
    if (e && e.name === "AbortError") { job.error = "已取消"; aiHideThinking(); }
    else { job.error = (e && e.message) || String(e); aiFinishThinking("队列识别失败"); }
  } finally {
    AI_QUEUE_CTRL = null;
    AI_QUEUE_TICKING = false;
    aiQueueSave();
    refreshEvaBadge();
    if ($("page-eva").classList.contains("active")) renderEva();
    setTimeout(aiQueueTick, 300);         // 接着跑下一条
  }
}
/** 待办页「正在识别」卡片（节流 400ms，只更新这一块，避免整页重绘） */
function evaRenderLive() {
  if (AI_QUEUE_LIVE_T) return;
  AI_QUEUE_LIVE_T = setTimeout(() => {
    AI_QUEUE_LIVE_T = null;
    const card = $("evaLiveCard");
    if (!card) return;
    const job = AI_QUEUE.find((j) => j.status === "running");
    if (!job) { card.style.display = "none"; return; }
    card.style.display = "";
    $("evaLiveHead").textContent = `${evaTitle(job)}${job.source ? "（" + job.source + "）" : ""}`;
    $("evaLiveStage").textContent = job.stage || "识别中…";
    const t = $("evaLiveThink");
    if (t) { t.textContent = (job.think || "").slice(-600) || "（等待模型输出…）"; t.scrollTop = t.scrollHeight; }
  }, 400);
}
function renderAiQueueBar() {
  const el = $("aiQueueBar");
  if (!el) return;
  const waiting = AI_QUEUE.filter((j) => j.status === "waiting").length;
  const running = AI_QUEUE.filter((j) => j.status === "running").length;
  const done = AI_QUEUE.filter((j) => j.status === "done").length;
  const errs = AI_QUEUE.filter((j) => j.status === "error").length;
  if (!(waiting + running + done + errs)) { el.style.display = "none"; el.innerHTML = ""; return; }
  el.style.display = "";
  el.innerHTML =
    `<span class="grow">${running ? "⏳ 正在识别… · " : ""}排队 ${waiting} 项 · <b>待处理 ${done} 项</b>${errs ? ` · 失败 ${errs} 项` : ""}</span>` +
    `<button class="btn sm" onclick="goPage('eva')">去待办处理 →</button>`;
}
/** AI 识别待办条数：排队 / 识别中 / 待审核（不含已提交与失败） */
function aiQueuePendingCount() {
  return AI_QUEUE.filter((j) => ["waiting", "running", "done"].includes(j.status)).length;
}
/** 待办总数（既有「待办处理」按钮上显示）：聚水潭待办 + AI 识别待办 */
function evaPendingTotal() { return (JST_PENDING_N || 0) + aiQueuePendingCount(); }
function refreshEvaBadge() {
  jstPendingBtnState();   // 出库页那个「待办处理（N）」按钮：N = 聚水潭 + AI
  renderAiQueueBar();
}

/* ---------- 待办页渲染 ---------- */
let EVA_TAB = "ai";   // 顶部三个横向按钮：ai 识别队列 / in 入库待办 / out 出库待办
function evaTab(tab) {
  EVA_TAB = ["ai", "in", "out", "st"].includes(tab) ? tab : "ai";
  document.querySelectorAll("#evaSeg .seg-item").forEach((b) => b.classList.toggle("active", b.dataset.tab === EVA_TAB));
  [["ai", "evaPanelAi"], ["in", "evaPanelIn"], ["out", "evaPanelOut"], ["st", "evaPanelSt"]].forEach(([k, id]) => {
    const el = $(id);
    if (el) el.style.display = k === EVA_TAB ? "" : "none";
  });
  if (EVA_TAB !== "ai") { const c = $("evaLiveCard"); if (c) c.style.display = "none"; }
  else evaRenderLive();
}
function loadEva() { renderEva(); evaTab(EVA_TAB); }
function evaRefresh() { renderEva(); refreshEvaBadge(); aiQueueTick(); }
function evaRunQueue() {
  const waiting = AI_QUEUE.filter((j) => j.status === "waiting").length;
  toast(waiting ? `队列里还有 ${waiting} 项，继续识别…` : "队列已全部识别完");
  aiQueueTick();
}
function evaCancelCurrent() { if (AI_QUEUE_CTRL) { AI_QUEUE_CTRL.abort(); toast("已取消当前识别"); } }
function renderEva() {
  const running = AI_QUEUE.filter((j) => j.status === "running");
  const waiting = AI_QUEUE.filter((j) => j.status === "waiting");
  const errors = AI_QUEUE.filter((j) => j.status === "error");
  const done = AI_QUEUE.filter((j) => j.status === "done");
  const ins = done.filter((j) => !["outbound", "stocktake"].includes((j.result || {}).type));
  const outs = done.filter((j) => (j.result || {}).type === "outbound");
  const stocks = done.filter((j) => (j.result || {}).type === "stocktake");
  const submitted = AI_QUEUE.filter((j) => j.status === "submitted").length;
  $("evaStats").innerHTML = `
    <div class="stat"><div class="label">识别中 / 排队</div><div class="value">${running.length} / ${waiting.length}</div></div>
    <div class="stat accent"><div class="label">入库待办</div><div class="value">${ins.length}</div></div>
    <div class="stat warn"><div class="label">出库待办</div><div class="value">${outs.length}</div></div>
    <div class="stat"><div class="label">盘点待办</div><div class="value">${stocks.length}</div></div>
    <div class="stat ${errors.length ? "danger" : "success"}"><div class="label">识别失败</div><div class="value">${errors.length}</div><div class="sub">已提交 ${submitted} 条</div></div>`;
  // 顶部三个横向按钮上的角标（没活就不显示，一眼看出哪一类有待办）
  const setBadge = (id, n) => { const el = $(id); if (!el) return; el.textContent = String(n); el.style.display = n ? "" : "none"; };
  setBadge("evaTabAi", running.length + waiting.length + errors.length);
  setBadge("evaTabIn", ins.length);
  setBadge("evaTabOut", outs.length);
  setBadge("evaTabSt", stocks.length);
  const aiItems = [...running, ...waiting, ...errors];
  // 任务一律「按钮左右排列」，点按钮才展开处理，避免纵向堆一大片
  const row = (items, zone, empty) => items.length
    ? `<div class="eva-btn-row">${items.map((j) => evaItemHtml(j, zone)).join("")}</div>`
    : `<div class="empty">${empty}</div>`;
  $("evaAiList").innerHTML = row(aiItems, "ai", "队列为空。回到「工作台 → AI 智能录入」粘贴票据或输入描述，会自动加入这里。");
  $("evaInList").innerHTML = row(ins, "inbound", "暂无待审核的入库识别结果");
  $("evaOutList").innerHTML = row(outs, "outbound", "暂无待审核的出库识别结果");
  $("evaStList").innerHTML = row(stocks, "stocktake", "暂无待审核的盘点结果（说「盘点…」或传盘点表就会出现在这里）");
  // 聚水潭待办（新商品没规则 / 要验证码）：在既有待办弹层里处理，这里只做入口与计数
  const jb = $("evaJstBtn");
  if (jb) {
    jb.textContent = JST_PENDING_N ? `聚水潭待办（${JST_PENDING_N}）` : "聚水潭待办";
    jb.className = JST_PENDING_N ? "btn danger" : "btn secondary";
  }
  evaRenderLive();
}
/** 一条待办 = 一个按钮（左右排列）；点主按钮打开审核/详情，旁边的 ↻ 重试、✕ 删除 */
function evaItemHtml(j, zone) {
  const r0 = j.result || {};
  const isStockJob = r0.type === "stocktake";
  const stockSum = (r0.lines || []).reduce((a, ln) => a + (+ln.stock_adjust || 0), 0);
  const meta = j.status === "done"
    ? (isStockJob
        ? `${(r0.lines || []).length} 行 · 净调整 ${stockSum >= 0 ? "+" : ""}${fmtNum(stockSum)} · ${evaDateSpan(j)}`
        : `${(r0.lines || []).length} 行 · ${fmtMoney(evaMoney(j))} · ${evaDateSpan(j)}`)
    : (j.status === "running" ? "识别中…" : (j.status === "waiting" ? "等待识别…" : ""));
  const draftTag = (j.status === "done" && j.draft_at) ? " · ✎已暂存" : "";   // 你改过并暂存过（打开会带着修改）
  const ck = zone === "ai" ? "" : `<input type="checkbox" class="eva-ck" data-id="${j.id}" title="勾选后可批量提交" />`;
  const side = zone === "ai"
    ? `<button class="btn sm secondary eva-chip-mini" title="重新识别" onclick="evaRetry('${j.id}')">↻</button>
       <button class="btn sm secondary eva-chip-mini" title="删除这条待办" onclick="evaDelete('${j.id}')">✕</button>`
    : `<button class="btn sm secondary eva-chip-mini" title="删除这条待办" onclick="evaDelete('${j.id}')">✕</button>`;
  const label = `${esc(j.source || (j.kind === "image" ? "票据" : "文字"))} · ${esc(evaTitle(j).slice(0, 16))}`;
  return `<span class="eva-chip s-${j.status}">
      ${ck}
      <button class="eva-chip-main" title="${esc(j.error || "点开核对 / 提交：" + evaTitle(j))}" onclick="evaOpen('${j.id}')">${label}<span class="muted">${esc(meta + draftTag)}</span></button>
      ${side}
    </span>`;
}
/** 点待办按钮：已识别好的直接打开审核框；失败的重试；其余只是提示 */
function evaOpen(id) {
  const j = AI_QUEUE.find((x) => x.id === id);
  if (!j) return;
  if (j.status === "done") evaReview(id);
  else if (j.status === "error") evaRetry(id);
  else toast(j.status === "running" ? "这条正在识别中…" : "这条还在排队，识别完会自动出现在待办里");
}
function evaReview(id) {
  const j = AI_QUEUE.find((x) => x.id === id);
  if (!j || !j.result) return;
  AI_QUEUE_CURRENT = id;
  AI_THINK_TEXT = j.think || "";        // 让确认框里的「思考过程」显示这条任务的
  openAiConfirm(j.result);
}
function evaDelete(id) {
  const j = AI_QUEUE.find((x) => x.id === id);
  if (!j) return;
  if (!confirm(`删除这条待办？\n${evaTitle(j)}`)) return;
  AI_QUEUE = AI_QUEUE.filter((x) => x.id !== id);
  AI_QUEUE_FILES.delete(id);
  aiQueueSave(); renderEva(); refreshEvaBadge();
}
function evaRetry(id) {
  const j = AI_QUEUE.find((x) => x.id === id);
  if (!j) return;
  if (j.kind === "image" && !AI_QUEUE_FILES.has(j.id)) { toast("原图已丢失，请回到工作台重新粘贴这张图片"); return; }
  j.status = "waiting"; j.error = ""; j.think = ""; j.answer = "";
  aiQueueSave(); renderEva(); refreshEvaBadge(); aiQueueTick();
}
/** 待办结果 → 提交用的明细行（与确认框里的行结构一致） */
function evaRowsOf(job) {
  const r = job.result || {};
  aiMergeDupLines(r);   // 老结果兜底：同种商品合并成一行（数量累加），批量提交才不会在同一商品上反复调整
  return (r.lines || []).filter((ln) => !ln._deleted && (ln.product_id || ln.new_product)).map((ln) => ({
    product_id: ln.product_id || 0,
    new_product: ln.product_id ? null : (ln.new_product || { name: ln.recognized_name || ln.product_name || "", category: ln.category || "stock", unit: ln.unit || "个" }),
    // 盘点：数量用「增减量」（后端已按 实盘数 − 当前库存 算好）
    quantity: r.type === "stocktake" ? (+ln.stock_adjust || 0) : (+ln.quantity || 0),
    unit: (r.type === "stocktake" ? (ln.stock_unit || ln.unit) : ln.unit) || "个",
    unit_price: +ln.unit_price || 0,
    paid: ln.paid !== false,
    date: ln.date || r.date || today(),
    auto_created: !!ln.auto_created,
  }));
}
/** 勾选后批量提交（入库/出库各自成单；出库按「日期+付款状态」分单） */
async function evaSubmitChecked(type) {
  const boxId = { inbound: "evaInList", outbound: "evaOutList", stocktake: "evaStList" }[type] || "evaInList";
  const label = { inbound: "入库", outbound: "出库", stocktake: "盘点" }[type] || "入库";
  const ids = [...document.querySelectorAll(`#${boxId} .eva-ck:checked`)].map((x) => x.dataset.id);
  if (!ids.length) { toast("请先勾选要提交的待办（也可以在每条上点「审核提交」逐个核对）"); return; }
  const jobs = ids.map((id) => AI_QUEUE.find((j) => j.id === id)).filter((j) => j && j.result);
  if (!jobs.length) return;
  const bad = jobs.filter((j) => !evaRowsOf(j).length);
  if (bad.length) { toast(`有 ${bad.length} 条没有可提交的明细行，请先逐条审核`); return; }
  const tip = type === "stocktake"
    ? "：按增减量调整库存（可在「库存 → 盘点记录」回退）"
    : "，日期用每行自己的单据日期";
  if (!confirm(`批量提交 ${jobs.length} 条${label}待办？\n（按识别结果直接提交${tip}；要改明细请点「审核提交」）`)) return;
  const op = (CURRENT_USER && (CURRENT_USER.name || CURRENT_USER.username)) || "";
  let okN = 0;
  for (const j of jobs) {
    const r = j.result || {};
    try {
      await submitDocRows({
        type,
        party: type === "outbound" ? (r.customer || "") : (type === "inbound" ? (r.supplier || "") : ""),   // 盘点不需要客户/供应商
        remark: r.remark || "", imageUrl: r.image_url || "", rows: evaRowsOf(j), op,
        // 出库：带上识别阶段算好的包材/快递/固定成本（口径与确认框一致）
        charges: type === "outbound" ? aiChargesFromResult(r) : null,
      });
      j.status = "submitted";
      j.submitted_at = new Date().toISOString();
      aiQueueSave();
      okN++;
    } catch (e) {
      toast(`「${evaTitle(j)}」提交失败：${e.message}`);
      break;
    }
  }
  toast(`已提交 ${okN}/${jobs.length} 条`);
  renderEva(); refreshEvaBadge(); loadDashboard(); loadStock();
}

/* ---------- 提交单据（确认框 & 待办批量提交共用） ----------
   rows: [{ product_id, new_product, quantity, unit, unit_price, paid, date, auto_created }] */
async function submitDocRows({ type, party, remark, imageUrl, rows, op, charges }) {
  const inv = imageUrl ? `[票据] ${imageUrl}` : "";
  // 1) 先创建确认为新物品的商品档案（同名已存在则复用）
  const pend = rows.filter((r) => !r.product_id && r.new_product);
  if (pend.length) {
    const d = await api("/api/ai/products", "POST", {
      items: pend.map((r) => ({
        name: (r.new_product.name || "").trim(),
        category: r.new_product.category || "stock",
        unit: r.unit || r.new_product.unit || "个",
      })),
    });
    (d.items || []).forEach((it, k) => { if (pend[k]) pend[k].product_id = it.product_id; });
    PRODUCTS = await api("/api/products");
  }
  const ok = rows.filter((r) => r.product_id);
  if (!ok.length) throw new Error("商品创建失败，请稍后重试");
  // 2) 写单据：盘点走既有「盘点调整」的 +/- 增减模式；入库逐行建单；出库按「日期 + 付款状态」分单
  if (type === "stocktake") {
    let n = 0;
    for (const r of ok) {
      const d = +r.quantity || 0;                       // 增减量（±，按展示单位）
      if (!d) continue;                                 // 增减为 0：等于没调整，跳过
      // 既有接口是「库存 → 盘点调整」用的 POST /api/adjust（相对增减），别再写错路径（曾误写 /api/inventory/adjust → 404）
      await api("/api/adjust", "POST", {
        product_id: r.product_id,
        date: r.date,
        quantity: `${d > 0 ? "+" : ""}${+d.toFixed(6)}`,  // 既有接口要求带符号的相对调整串
        unit: r.unit,
        remark: [remark, inv].filter(Boolean).join(" ") || "AI盘点",
      });
      n++;
    }
    return n;
  }
  if (type === "inbound") {
    for (const r of ok) {
      const rmk = [inv, r.auto_created ? "[AI自动新增]" : "", remark].filter(Boolean).join(" ");
      await api("/api/inbounds", "POST", {
        product_id: r.product_id, unit: r.unit, quantity: r.quantity, unit_price: r.unit_price,
        supplier: party, operator: op, date: r.date, remark: rmk, pay_status: r.paid ? "paid" : "unpaid",
      });
    }
  } else {
    const groups = new Map();
    ok.forEach((r) => {
      const key = `${r.date}|${r.paid ? "paid" : "unpaid"}`;
      if (!groups.has(key)) groups.set(key, { date: r.date, pay: r.paid ? "paid" : "unpaid", rows: [] });
      groups.get(key).rows.push(r);
    });
    // 附加项（包材/快递/固定成本）只挂在「只有一张单」的情况下；多张单（不同日期/付款状态）
    // 时按整单算的金额没法分摊，就不自动挂，避免把一笔包材记到每张单上重复计。
    const useCharges = charges && groups.size === 1 ? charges : null;
    for (const g of groups.values()) {
      const lines = g.rows.map((r) => ({ product_id: r.product_id, unit: r.unit, quantity: r.quantity, price: r.unit_price }));
      const payload = {
        customer: party, operator: op, date: g.date,
        remark: [inv, remark, useCharges && useCharges.remark].filter(Boolean).join(" "),
        lines, pack_lines: useCharges ? useCharges.pack_lines : [], pay_status: g.pay,
      };
      if (useCharges) {
        // 固定成本（工时/胶带等按金额记的）与实收口径一起提交，口径与确认框显示的一致
        payload.pack_fee_total = useCharges.fee_total || 0;
        payload.settle_cats = String(useCharges.settle_cats || "").split(",").filter(Boolean);
        payload.auto_express = useCharges.auto_express !== false;
      }
      await api("/api/outbounds", "POST", payload);
    }
  }
  return ok.length;
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

/* 备注渲染：文本原样（换行转 <br>），图片附件显示缩略图，其他文件显示下载链接。
   opts.compact=true：附件只出标签、不加载缩略图（列表页一屏几十条备注全是票据图时，
   浏览器会连发几十个图片请求、把接口请求都挤慢；点标签照样能预览）。 */
function renderRemarkHtml(rmk, opts) {
  if (!rmk) return "—";
  const compact = !!(opts && opts.compact);
  return splitRemark(rmk).map((s) => {
    if (s.text !== undefined) return esc(s.text).replace(/\n/g, "<br />");
    const u = routePath(s.url);
    if (!s.isImage) {
      return `<a class="attach-link" href="${u}" target="_blank" title="${esc(s.name)} — 点击预览" onclick="openAttachmentPreview('${s.url}','${esc(s.name)}');return false;">📎 ${esc(s.name)}</a>`;
    }
    if (compact) {
      return `<a class="attach-link" href="${u}" title="${esc(s.name)} — 点击预览" onclick="openAttachmentPreview('${s.url}','${esc(s.name)}');return false;">🖼 ${esc(s.name)}</a>`;
    }
    return `<span style="cursor:zoom-in;display:inline-block;vertical-align:middle;" onclick="openAttachmentPreview('${s.url}','${esc(s.name)}')" title="${esc(s.name)} — 点击预览"><img src="${u}" alt="${esc(s.name)}" loading="lazy" decoding="async" style="height:34px;vertical-align:middle;border-radius:4px;margin-right:4px;border:1px solid var(--border-light);" /></span>`;
  }).join("");
}
/* 附件点击预览：图片全屏浮层预览（点遮罩或按 Esc 关闭），非图片（PDF/Excel 等）新标签打开 */
let __prevLayer = null;
function __prevKeydown(e) { if (e.key === "Escape") closeAttachmentPreview(); }
function closeAttachmentPreview() {
  if (__prevLayer) { __prevLayer.remove(); __prevLayer = null; }
  document.removeEventListener("keydown", __prevKeydown);
}
function openAttachmentPreview(url, name) {
  const u = routePath(url);
  const label = name || "附件";
  // blob:/data: 是本地预览图（如 AI 待识别图片），同样走全屏图片浮层
  if (!/^(blob|data):/i.test(u) && !/\.(png|jpe?g|gif|webp|bmp|svg)$/i.test(u)) { window.open(u, "_blank"); return; }
  closeAttachmentPreview();
  const lay = document.createElement("div");
  lay.className = "attach-preview";
  const img = document.createElement("img");
  img.className = "attach-preview-img";   // 显式宽高 auto，避免被其它 img 规则影响而"全黑"
  img.alt = label;
  img.src = u;
  const cap = document.createElement("div");
  cap.className = "attach-preview-cap";
  cap.textContent = label;
  img.addEventListener("click", (ev) => ev.stopPropagation());   // 点图片自身不关闭
  img.addEventListener("error", () => { cap.textContent = "图片加载失败：" + label + "（" + u + "）"; });
  lay.appendChild(img);
  lay.appendChild(cap);
  lay.addEventListener("click", closeAttachmentPreview);
  document.body.appendChild(lay);
  document.addEventListener("keydown", __prevKeydown);
  __prevLayer = lay;
}

/* 备注附件与文本分离存放：文本框只保留用户输入的纯文本，附件统一以标签展示；
   提交时再拼接为「纯文本\n/uploads/xxx」，与后端存储格式保持一致（列表/移动端读取不受影响）。 */
const REMARK_ATTACH = {};   // textareaId -> [{ url, name, isImage }]

/** 备注最终值（提交用）：纯文本 + 附件路径，与历史数据格式一致 */
function remarkValue(textareaId) {
  const ta = $(textareaId);
  const text = ((ta && ta.value) || "").trim();
  const urls = (REMARK_ATTACH[textareaId] || []).map((f) => f.url);
  return [text, ...urls].filter(Boolean).join("\n");
}

/** 回填备注（编辑场景）：把已有 /uploads/xxx 拆到附件区，文本框只留纯文本 */
function setRemarkValue(textareaId, remark) {
  const ta = $(textareaId);
  if (!ta) return;
  const segs = splitRemark(remark || "");
  REMARK_ATTACH[textareaId] = segs.filter((s) => s.url).map((s) => ({ url: s.url, name: s.name, isImage: s.isImage }));
  ta.value = segs.filter((s) => s.text !== undefined).map((s) => s.text).join("").trim();
  renderRemarkAttachments(textareaId);
}

/** 清空备注及其附件 */
function clearRemarkField(textareaId) {
  const ta = $(textareaId);
  if (ta) ta.value = "";
  REMARK_ATTACH[textareaId] = [];
  renderRemarkAttachments(textareaId);
}

/** 上传备注附件：只登记到附件区并展示标签，不写入文本框。
     source 可以是文件选择 input 元素，或粘贴传入的 FileList / File[]。 */
async function uploadRemarkFiles(textareaId, source) {
  let files;
  if (source && typeof source.files !== "undefined") {
    source.value = "";            // 允许重复选择同一个文件
    files = Array.from(source.files || []);
  } else if (source && typeof source[Symbol.iterator] === "function") {
    files = Array.from(source);   // 粘贴：FileList / File[]
  } else {
    files = [];
  }
  if (!files.length) return;
  const list = REMARK_ATTACH[textareaId] = REMARK_ATTACH[textareaId] || [];
  try {
    for (const f of files) {
      const r = await apiUpload("/api/uploads", f);
      list.push({ url: r.url, name: r.name || attachName(r.url), isImage: r.is_image });
    }
    renderRemarkAttachments(textareaId);
    toast(`已添加 ${files.length} 个附件`);
  } catch (e) { toast("附件上传失败：" + e.message); }
}

/** 备注栏支持 Ctrl+V 粘贴图片 / 文件；剪贴板无附件时维持默认文本粘贴 */
function pasteRemarkFiles(textareaId, event) {
  const items = (event.clipboardData && event.clipboardData.items) || [];
  const text = (event.clipboardData && typeof event.clipboardData.getData === "function")
    ? (event.clipboardData.getData("text/plain") || "")
    : "";
  const files = [];
  for (const it of items) {
    if (it.kind !== "file") continue;
    const f = typeof it.getAsFile === "function" ? it.getAsFile() : null;
    if (f) files.push(f);
  }
  // 剪贴板带真实文件（图片/PDF/Excel 等）：阻止把文本写入备注，作为附件上传
  if (files.length) {
    if (event.cancelable) event.preventDefault();
    uploadRemarkFiles(textareaId, files);
    return;
  }
  // 剪贴板只有「本地文件路径」文本（资源管理器复制文件 / 右键「复制为路径」）：阻止写入备注
  if (looksLikeLocalPath(text)) {
    if (event.cancelable) event.preventDefault();
    toast("检测到本地文件路径，已取消写入备注；如需挂附件，请用「图片/附件」按钮重新选择该文件。");
    return;
  }
  // 无附件：维持默认文本粘贴
}
/** 判断文本是否像本地文件路径：兼容带引号的「复制为路径」、UNC、file://、Unix 绝对路径 */
function looksLikeLocalPath(s) {
  let t = String(s || "").trim();
  t = t.replace(/^["'“”«»]+/, "").replace(/["'“”«»]+$/, "").trim();   // 去掉成对引号
  if (!t) return false;
  if (/^(?:[A-Za-z]:[\\/]|\\\\|\/\/|file:\/\/)/i.test(t)) return true;  // C:\ ; \\server ; // ; file://
  if (/^\/[^\/\s]/.test(t)) return true;                                // /usr/local/...
  return /[A-Za-z]:[\\/]/.test(t);                                      // 文本中夹带的 C:\ 或 C:/
}

/** 渲染已选附件的小标签（可点击预览、可单个删除），仅作用于新增/编辑表单 */
function renderRemarkAttachments(textareaId) {
  const box = $(textareaId + "Files");
  if (!box) return;
  const files = REMARK_ATTACH[textareaId] || [];
  box.innerHTML = files.map((s, i) =>
    `<span class="attach-chip"><span style="cursor:pointer;" onclick="openAttachmentPreview('${s.url}','${esc(s.name)}')">${s.isImage ? "🖼" : "📎"} ${esc(s.name)}</span><b onclick="removeRemarkAttachment('${textareaId}',${i})">✕</b></span>`
  ).join("");
}

/** 从附件区移除某个附件 */
function removeRemarkAttachment(textareaId, index) {
  const list = REMARK_ATTACH[textareaId] || [];
  if (index >= 0 && index < list.length) list.splice(index, 1);
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

/* ---------- 展示清单管理（可自主增删/排序） ---------- */
let FC_SEL = [];   // 当前展示清单（有序商品 id）
let FC_ALL = [];   // 全部可选商品（所有在用库存商品，不限分类）
let FC_CATS = [];  // 鲜货分类（蔬菜/干货），供「只看鲜货分类」筛选
async function openFreshConfig() {
  try {
    // scope=all：候选商品列出全部在用商品（不再只限蔬菜/干货），任意商品都能加进清单
    const [opts, cur] = await Promise.all([api("/api/fresh/options?scope=all"), api("/api/fresh")]);
    FC_ALL = opts.items || [];
    FC_CATS = opts.fresh_cats || [];
    FC_SEL = (cur.ids || []).slice();
    openModal(`
      <h3>管理展示商品 <button class="close" onclick="closeModal()">✕</button></h3>
      <p class="hint" style="margin-bottom:10px;">左侧列出的是<b>全部在用商品</b>（与「商品」页口径一致，不含 包材/人工/快递，可搜索）；勾选即加入展示清单，点击顺序即展示顺序，右侧可调整顺序或移除。清单里的商品会出现在「鲜货入库」表格里，可随时调整。</p>
      <div class="fc-wrap">
        <div class="fc-pane">
          <div class="fc-label">
            候选商品（<b id="fcCount">0</b> 个）
            <label style="float:right;font-weight:400;cursor:pointer;"><input type="checkbox" id="fcFreshOnly" onchange="renderFreshConfig()" /> 只看鲜货分类</label>
          </div>
          <input id="fcSearch" placeholder="🔍 搜索名称 / 分类…" oninput="renderFreshConfig()" style="margin-bottom:8px;" />
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
  const freshOnly = !!($("fcFreshOnly") || {}).checked;
  const selSet = new Set(FC_SEL);
  const rows = FC_ALL
    .filter((p) => !freshOnly || FC_CATS.includes(p.category))   // 「只看鲜货分类」按蔬菜/干货筛
    .filter((p) => !kw || p.name.toLowerCase().includes(kw) || (p.category || "").toLowerCase().includes(kw));
  const optHtml = rows
    .map((p) => `<div class="fc-opt ${selSet.has(p.id) ? "on" : ""}" onclick="fcToggle(${p.id})">${esc(p.name)} <span class="muted">${esc(p.category)}</span></div>`)
    .join("");
  const cnt = $("fcCount");
  if (cnt) cnt.textContent = rows.length;
  $("fcOptions").innerHTML = optHtml || '<div class="empty" style="padding:14px;">无匹配商品</div>';
  const selHtml = FC_SEL.map((id, i) => {
    const p = FC_ALL.find((x) => x.id === id);
    // 已停用 / 不在候选里的（历史清单遗留）也给出来，方便直接移除
    const label = p ? esc(p.name) : `<span class="muted">（包材/人工/快递 或已停用 #${id}）</span>`;
    return `<div class="fc-sel-item">
      <span class="grow">${i + 1}. ${label}</span>
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
    // 鲜货入库页用的是同一份展示清单，正处于该页时一并刷新
    if ($("page-fresh-in") && $("page-fresh-in").classList.contains("active")) loadFreshInbound();
  } catch (e) { toast("保存失败：" + e.message); }
}

/* =============== 鲜货入库（二级页） ===============
   每天把要入库的鲜货数量填进去，提交后每个填了数量的商品各生成一张入库单。
   - 陈列清单 = 「鲜货现采 → 管理展示商品」那份（按展示顺序），也可临时「加一个商品」；
   - 单价自动带出：最近一次入库价 → 参考成本（与入库页同一套规则，可改）；
   - 运费 / 装卸费默认留空，填了才计入该行批次成本；
   - 已填的值记在 FIN_VALS 里，切页 / 筛选 / 刷新都不会丢。 */
let FIN_LIST = [];      // 已陈列的鲜货（/api/fresh?only_list=true：展示顺序 + 库存），表格只显示这些
let FIN_VALS = {};      // {商品id: {qty, price, freight, handling}} 本次填的值
let FIN_PICK = new Set(); // 勾选的行（商品id）：勾了「全部入库」就只入这些；再点行尾「入库」可单独入一行

/* 今日已入库：点「入库」后把这个商品记在浏览器里（只记当天），这一行就先从表里隐藏——
   表里剩下的就都是「还没入库」的，一眼能看出还差哪些货；第二天 0 点自动恢复成默认列表。 */
const FIN_DONE_KEY = "wsfc_fin_done";   // 旧版全局 key：只用于把老数据迁到分仓维度
/** 「今日已入库」按分仓隔离：记的是商品 id，而商品 id 是分仓维度的，
 *  串仓会把另一个分仓的同 id 商品也隐藏掉。 */
function finDoneKey() {
  const wh = (CURRENT_USER && CURRENT_USER.warehouse && CURRENT_USER.warehouse.key) || "";
  return wh ? `${FIN_DONE_KEY}:${wh}` : FIN_DONE_KEY;
}
let FIN_DONE_SHOW = false;     // true = 连「今日已入库」的行也显示（灰显，可点行尾「恢复」放回）
let FIN_DONE_SET = new Set();  // 今日已入库的商品 id（每次渲染从浏览器读一遍）
let FIN_MIDNIGHT_TIMER = null; // 跨 0 点的定时器

/** 读「今日已入库」：存的日期不是今天就当没有（天然实现「第二天 0 点恢复」） */
function finDoneLoad() {
  try {
    const raw = JSON.parse(localStorage.getItem(finDoneKey()) || "null");
    if (raw && raw.date === today() && Array.isArray(raw.ids)) return new Set(raw.ids.map(Number).filter(Boolean));
  } catch (e) { /* 存坏了就当没有 */ }
  return new Set();
}
function finDoneSave(set) {
  try { localStorage.setItem(finDoneKey(), JSON.stringify({ date: today(), ids: [...set] })); } catch (e) {}
}
/** 入库成功后调用：把这些商品记成「今日已入库」（表里随后隐藏） */
function finDoneAdd(ids) {
  const set = finDoneLoad();
  ids.forEach((id) => set.add(+id));
  finDoneSave(set);
  FIN_DONE_SET = set;
}
/** 「恢复」：把这一行放回列表（今天还想再入一次 / 点错了） */
function finDoneUndo(id) {
  const set = finDoneLoad();
  set.delete(+id);
  finDoneSave(set);
  FIN_DONE_SET = set;
  renderFreshInbound();
}
/** 「显示 / 隐藏今日已入库」开关 */
function finToggleDoneShow() { FIN_DONE_SHOW = !FIN_DONE_SHOW; renderFreshInbound(); }
/** 跨 0 点：到点重新渲染一次，把昨天隐藏的行放回来（按日期判断，电脑休眠也不会错） */
function finScheduleMidnight() {
  clearTimeout(FIN_MIDNIGHT_TIMER);
  const now = new Date();
  const next = new Date(now.getFullYear(), now.getMonth(), now.getDate() + 1, 0, 0, 3);
  FIN_MIDNIGHT_TIMER = setTimeout(() => {
    if ($("finTable")) { FIN_DONE_SET = finDoneLoad(); renderFreshInbound(); }
    finScheduleMidnight();
  }, Math.max(1000, Math.min(next - now, 2147480000)));
}

function openFreshInbound() { goPage("fresh-in"); }   // 加载交给 goPage 的 loader
function finProduct(id) { return PRODUCTS.find((x) => x.id === id) || null; }
function finUnit(p) { return p.default_unit || p.base_unit; }
function finRowEls() { return [...document.querySelectorAll("#finTable tr.fin-row")]; }

async function loadFreshInbound() {
  try {
    if (!PRODUCTS.length) PRODUCTS = await api("/api/products");
    // only_list=true：只取「管理展示商品」里挑过的商品，没挑过的鲜货不会自己冒出来
    const cur = await api("/api/fresh?only_list=true");
    FIN_LIST = cur.items || [];
    if ($("finDate") && !$("finDate").value) $("finDate").value = today();
    renderFreshInbound();
  } catch (e) { toast("加载鲜货清单失败：" + e.message); }
}

function finRowIds() {
  return FIN_LIST.map((x) => x.id).filter((id) => finProduct(id));
}

function renderFreshInbound() {
  const t = $("finTable");
  if (!t) return;
  const kw = ($("finSearch") ? $("finSearch").value : "").trim().toLowerCase();
  FIN_DONE_SET = finDoneLoad();   // 今日已入库（日期变了就自动空）
  const matched = finRowIds().filter((id) => {
    const p = finProduct(id);
    return !kw || `${p.name} ${p.category || ""}`.toLowerCase().includes(kw);
  });
  // 今日已入库的先隐藏，让表里只剩「还没入库」的；点了「显示」才灰显列出来
  const hidden = matched.filter((id) => FIN_DONE_SET.has(id));
  const ids = FIN_DONE_SHOW ? matched : matched.filter((id) => !FIN_DONE_SET.has(id));
  t.innerHTML = `<thead><tr>
      <th class="cb-col" style="width:34px;"><input type="checkbox" onchange="payToggleAll(this)" title="全选 / 全不选（勾选后只入库勾中的那些）" /></th>
      <th style="width:21%;">商品</th>
      <th style="width:9%;">进货单位</th>
      <th style="width:9%;">数量</th>
      <th style="width:10%;">单价</th>
      <th class="num" style="width:10%;">金额</th>
      <th style="width:8%;">运费</th>
      <th style="width:8%;">装卸费</th>
      <th style="width:19%;">备注</th>
      <th></th>
    </tr></thead><tbody>`
    + (hidden.length ? finDoneBarHtml(hidden.length) : "")
    + (ids.length ? ids.map(finRowHtml).join("")
      : `<tr><td colspan="10" class="empty">${hidden.length
        ? `今天的鲜货都入完啦 ✅（${hidden.length} 个商品已入库、先从列表隐藏，明天 0 点自动回来；也可以点上面「显示今日已入库」核对）`
        : "还没挑商品：点右上「管理展示商品」把要入库的商品挑进来（候选含全部在用商品，不限分类），这里就会出现"}</td></tr>`)
    + `</tbody>`;
  // 单价没填过的行先自动带出（最近入库价 → 参考成本），再算一遍金额
  ids.forEach((id) => {
    const tr = t.querySelector(`tr[data-pid="${id}"]`);
    if (!tr) return;
    const v = FIN_VALS[id] || {};
    // 备注回填：文字取记住的值，图片/附件取附件表（都按商品 id 存，刷新/筛选不丢）
    const ta = t.querySelector(`#finRemark_${id}`);
    if (ta) { ta.value = v.remark || ""; renderRemarkAttachments(`finRemark_${id}`); }
    if (v.price == null || v.price === "") { try { fillInboundRowPrice(tr); } catch (e) { /* 价格带不出来不影响手填 */ } }
    // 单位用原生下拉（可选单位就几个，原生下拉能直接把当前单位显示出来，不用再点一次）
    finRowCalc(tr.querySelector(".in-qty") || tr, true);
  });
  finSummary();
  finScheduleMidnight();   // 到第二天 0 点自动刷新，把隐藏的行放回来
}

/* 表格顶部那条「今日已入库」提示 + 显示 / 隐藏开关 */
function finDoneBarHtml(n) {
  const tip = FIN_DONE_SHOW
    ? `已显示今日已入库的 <b>${n}</b> 个商品（灰显，点行尾「恢复」可放回列表）`
    : `今日已入库 <b>${n}</b> 个商品，已从列表隐藏（明天 0 点自动回来）`;
  return `<tr class="fin-done-bar"><td colspan="10"><span class="muted">${tip}</span>`
    + `<button class="btn sm secondary" onclick="finToggleDoneShow()">${FIN_DONE_SHOW ? "隐藏它们" : "显示今日已入库"}</button>`
    + `</td></tr>`;
}

function finRowHtml(id) {
  const p = finProduct(id);
  if (!p) return "";
  const unit = finUnit(p);
  const v = FIN_VALS[id] || {};
  const val = (k) => (v[k] == null ? "" : String(v[k]));
  const done = FIN_DONE_SET.has(id);   // 今日已入库（只有点「显示今日已入库」时才会渲染出来）
  return `<tr class="fin-row${done ? " fin-row-done" : ""}" data-pid="${id}">
    <td class="cb-col"><input type="checkbox" class="fin-pick" value="${id}" ${FIN_PICK.has(id) ? "checked" : ""} onchange="finPickToggle(this)" title="勾选后可「入库选中的」" /></td>
    <td><b>${esc(p.name)}</b>${done ? ' <span class="badge income">今日已入库</span>' : ""}
      <div class="muted fin-unit-hint" style="font-size:11px;">${esc(p.category || "—")}</div></td>
    <td><select class="in-unit" onchange="finUnitChanged(this)">${unitOptions(p, unit)}</select></td>
    <td><input class="in-qty" type="number" min="0" step="any" placeholder="0" value="${esc(val("qty"))}" oninput="finRowCalc(this)" style="width:84px;" /></td>
    <td><input class="in-price" type="number" min="0" step="any" placeholder="0.00" value="${esc(val("price"))}" oninput="finRowCalc(this)" style="width:92px;" /></td>
    <td class="num in-amount-cell">—</td>
    <td><input class="in-freight" type="number" min="0" step="any" placeholder="留空" value="${esc(val("freight"))}" oninput="finRowCalc(this)" style="width:74px;" title="运费（默认空，选填）：计入这行的批次成本，并同步「其他开支」备查" /></td>
    <td><input class="in-handling" type="number" min="0" step="any" placeholder="留空" value="${esc(val("handling"))}" oninput="finRowCalc(this)" style="width:74px;" title="装卸费（默认空，选填）：同运费" /></td>
    <td class="fin-remark-cell">
      <textarea id="finRemark_${id}" class="fin-remark" rows="1" placeholder="备注（可 Ctrl+V 粘贴图片）" oninput="finRemember(this)" onpaste="pasteRemarkFiles('finRemark_${id}', event)"></textarea>
      <div class="attach-bar">
        <button type="button" class="btn sm secondary" onclick="$('finRemarkFile_${id}').click()" title="添加图片 / 附件">📎 图片</button>
        <input type="file" id="finRemarkFile_${id}" multiple style="display:none;" onchange="uploadRemarkFiles('finRemark_${id}', this)" />
      </div>
      <div class="attach-list" id="finRemark_${id}Files"></div>
    </td>
    <td style="white-space:nowrap;"><button class="btn sm secondary" onclick="finSubmitRow(this)" title="单独入库这一行">入库</button>${done ? ` <button class="btn sm secondary" onclick="finDoneUndo(${id})" title="把这一行放回列表（今天还想再入一次）">恢复</button>` : ""}</td>
  </tr>`;
}

/* 记住这一行填了什么（切页 / 筛选 / 刷新都不丢）；
   入参可以是行 <tr>，也可以是行内的某个输入框（备注框 oninput 直接传自己） */
function finRemember(el) {
  const tr = el && el.closest ? (el.closest("tr") || el) : null;
  if (!tr) return;
  const id = +(tr.dataset.pid || 0);
  if (!id) return;
  const get = (sel) => { const x = tr.querySelector(sel); return x ? x.value : ""; };
  FIN_VALS[id] = {
    qty: get(".in-qty"), price: get(".in-price"), freight: get(".in-freight"),
    handling: get(".in-handling"), remark: get(".fin-remark"),
  };
}

/** 商品列小字：分类（换过单位时补一句换算，和基础单位相同就不啰嗦） */
function finUnitHint(tr) {
  const el = tr.querySelector(".fin-unit-hint");
  const p = finProduct(+(tr.dataset.pid || 0));
  if (!el || !p) return;
  const unit = (tr.querySelector(".in-unit") || {}).value || finUnit(p);
  const f = (p.conversions || {})[unit] || 1;
  const conv = (unit && unit !== p.base_unit && f) ? ` · 1${unit}=${fmtNum(f)}${p.base_unit}` : "";
  el.textContent = `${p.category || "—"}${conv}`;
}

/** 逐行算金额 + 高亮已填的行 + 刷新合计（onlyCalc=true 时只算不记，用于渲染后的初始化） */
function finRowCalc(el, onlyCalc) {
  const tr = el && el.closest ? el.closest("tr") : null;
  if (!tr) return;
  if (!onlyCalc) finRemember(tr);
  const qty = parseFloat((tr.querySelector(".in-qty") || {}).value) || 0;
  // 本行金额（与入库页同一口径：金额 + 有运费/装卸时补一行批次成本）
  const price = parseFloat((tr.querySelector(".in-price") || {}).value) || 0;
  const fee = (parseFloat((tr.querySelector(".in-freight") || {}).value) || 0)
    + (parseFloat((tr.querySelector(".in-handling") || {}).value) || 0);
  const cell = tr.querySelector(".in-amount-cell");
  if (cell) {
    const base = qty * price;
    cell.innerHTML = `<b>¥${base.toFixed(2)}</b>`
      + (fee ? `<div class="muted" style="font-size:11px;">批次成本 ¥${(base + fee).toFixed(2)}</div>` : "");
  }
  tr.classList.toggle("fin-on", qty > 0);
  finUnitHint(tr);
  finSummary();
}

function finUnitChanged(sel) {
  const tr = sel.closest("tr");
  if (!tr) return;
  const id = +(tr.dataset.pid || 0);
  if (FIN_VALS[id]) FIN_VALS[id].price = "";   // 换单位后单价要按新单位重算
  try { fillInboundRowPrice(tr); } catch (e) { /* 带不出来就手填 */ }
  finRowCalc(sel);
}

/* ---------- 勾选与单行入库 ---------- */
/** 勾选 / 取消勾选一行（记在 FIN_PICK 里，筛选或刷新后仍保留） */
function finPickToggle(cb) {
  const id = +(cb.closest("tr").dataset.pid || 0);
  if (!id) return;
  if (cb.checked) FIN_PICK.add(id); else FIN_PICK.delete(id);
  finSummary();
}
/** 清空勾选 */
function finClearPick() {
  FIN_PICK.clear();
  document.querySelectorAll("#finTable .fin-pick").forEach((c) => { c.checked = false; });
  const all = document.querySelector("#finTable thead input[type=checkbox]");
  if (all) all.checked = false;
  finSummary();
}
/** 「全部入库」时要提交的行：勾了勾选框就只交勾中的，否则交所有行（没填数量的会跳过） */
function finSubmitTargets() {
  const rows = finRowEls();
  if (!FIN_PICK.size) return rows;
  return rows.filter((tr) => FIN_PICK.has(+(tr.dataset.pid || 0)));
}
/** 行尾「入库」：单独入库这一行 */
async function finSubmitRow(btn) {
  const tr = btn && btn.closest ? btn.closest("tr") : null;
  if (!tr) return;
  const qty = parseFloat((tr.querySelector(".in-qty") || {}).value) || 0;
  if (!(qty > 0)) {
    toast("先把这一行要入库的数量填上");
    const q = tr.querySelector(".in-qty");
    if (q) q.focus();
    return;
  }
  await submitFreshInbound([tr]);
}

/** 清空所有已填数量（单价保留，方便重填） */
function finClearAllQty() {
  let n = 0;
  finRowEls().forEach((tr) => {
    const q = tr.querySelector(".in-qty");
    const f = tr.querySelector(".in-freight");
    const h = tr.querySelector(".in-handling");
    if (q && (parseFloat(q.value) || 0) > 0) n++;
    if (q) q.value = "";
    if (f) f.value = "";
    if (h) h.value = "";
    finRowCalc(tr.querySelector(".in-qty") || tr);
  });
  toast(n ? `已清空 ${n} 个商品的数量` : "本来就没填数量");
}

/* 合计：填了数量的行才计入（没填数量的不会入库） */
function finSummary() {
  let rows = 0, goods = 0, fee = 0;
  finRowEls().forEach((tr) => {
    const q = tr.querySelector(".in-qty");
    const qty = parseFloat(q ? q.value : 0) || 0;
    if (!(qty > 0)) return;
    const price = parseFloat((tr.querySelector(".in-price") || {}).value) || 0;
    rows++;
    goods += qty * price;
    fee += (parseFloat((tr.querySelector(".in-freight") || {}).value) || 0)
      + (parseFloat((tr.querySelector(".in-handling") || {}).value) || 0);
  });
  const picked = FIN_PICK.size;
  const btn = $("finSubmitBtn");
  if (btn) btn.textContent = picked ? `✓ 入库选中的 ${picked} 个商品` : rows ? `✓ 全部入库（${rows} 个商品）` : "✓ 全部入库";
  const box = $("finSummary");
  if (!box) return;
  if (!rows) { box.style.display = "none"; box.innerHTML = ""; return; }
  box.style.display = "block";
  box.innerHTML = (picked ? `勾选 <b>${picked}</b> 个` : `已填 <b>${rows}</b> 个商品`) + `：货款 <b>¥${goods.toFixed(2)}</b>`
    + (fee ? ` ＋ 运费/装卸 <b>¥${fee.toFixed(2)}</b>` : "")
    + ` ＝ 实付 <b>¥${(goods + fee).toFixed(2)}</b> <span class="muted">（每个填了数量的商品各生成一张入库单；只勾了几个就只入那几个，也可以点行尾「入库」单独入一行）</span>`
    + (picked ? ` <button class="btn sm secondary" onclick="finClearPick()">取消勾选</button>` : "");
}

/** 入库：rows 传了只入这些行（行尾「入库」/勾选入库），不传就按当前可提交的行（见 finSubmitTargets） */
async function submitFreshInbound(rows) {
  const date = ($("finDate") && $("finDate").value) || today();
  const supplier = ($("finSupplier") && $("finSupplier").value || "").trim();
  const operator = operatorName();
  const remark = ($("finRemark") && $("finRemark").value || "").trim();
  const checked = document.querySelector('input[name="finPay"]:checked');
  const payStatus = checked ? checked.value : "paid";
  const items = [], bad = [];
  (Array.isArray(rows) ? rows : finSubmitTargets()).forEach((tr) => {
    const p = finProduct(+(tr.dataset.pid || 0));
    if (!p) return;
    const qty = parseFloat((tr.querySelector(".in-qty") || {}).value) || 0;
    if (!(qty > 0)) return;   // 没填数量 = 今天不入库
    const unit = (tr.querySelector(".in-unit") || {}).value || finUnit(p);
    const price = parseFloat((tr.querySelector(".in-price") || {}).value);
    const freight = parseFloat((tr.querySelector(".in-freight") || {}).value) || 0;
    const handling = parseFloat((tr.querySelector(".in-handling") || {}).value) || 0;
    if (isNaN(price)) { bad.push(p.name); return; }
    // 这一行自己的备注（文字 + 附件）：行备注在前，顶部那条通用备注在后，两者都保留
    const rowRemark = remarkValue(`finRemark_${p.id}`);
    items.push({
      product_id: p.id, unit, quantity: qty, unit_price: price,
      supplier, operator, date, remark: [rowRemark, remark].filter(Boolean).join("\n"), pay_status: payStatus,
      adjust_amount: 0, freight, handling,
    });
  });
  if (bad.length) { toast(`这些商品没填单价：${bad.slice(0, 5).join("、")}${bad.length > 5 ? " 等" : ""}`); return; }
  if (!items.length) { toast("还没填数量：先把今天要入库的数量填进「数量」列"); return; }
  const goods = items.reduce((s, it) => s + it.quantity * it.unit_price, 0);
  const fee = items.reduce((s, it) => s + it.freight + it.handling, 0);
  if (!confirm(`确认入库 ${items.length} 个商品？\n日期 ${date}，货款 ¥${goods.toFixed(2)}${fee ? ` + 运费/装卸 ¥${fee.toFixed(2)}` : ""}，共 ${items.length} 张入库单`)) return;
  const btn = $("finSubmitBtn");
  if (btn) { btn.disabled = true; btn.textContent = "⏳ 正在入库…"; }
  try {
    const r = await api("/api/inbounds/batch", "POST", { items });
    // 入库成功的商品记成「今日已入库」：先从列表隐藏，第二天 0 点自动回来
    finDoneAdd(items.map((it) => it.product_id));
    // 入库完清空数量 / 运费 / 装卸（单价保留），备注与附件也清掉，并去掉这行的勾选
    items.forEach((it) => {
      FIN_VALS[it.product_id] = { qty: "", price: "", freight: "", handling: "", remark: "" };
      FIN_PICK.delete(it.product_id);
      clearRemarkField(`finRemark_${it.product_id}`);
    });
    await loadFreshInbound();   // 顺便刷新库存与单价
    const box = $("finSummary");
    if (box) {
      box.style.display = "block";
      box.innerHTML = `<b>✅ 已入库 ${r.created} 张单</b>（货款 ¥${goods.toFixed(2)}${fee ? ` ＋ 运费/装卸 ¥${fee.toFixed(2)}` : ""}）`
        + (r.failed_count ? `<div class="alert err" style="margin-top:8px;">失败 ${r.failed_count} 行：${(r.failed || []).slice(0, 5).map((f) => esc(f.reason)).join("；")}</div>` : "")
        + `<div style="margin-top:8px;"><button class="btn sm secondary" onclick="goPage('inbound');loadInbounds()">去入库列表查看</button></div>`;
    }
    toast(`已入库 ${r.created} 张单${r.failed_count ? `，${r.failed_count} 行失败` : ""}`);
  } catch (e) {
    toast("入库失败：" + e.message);
    if (btn) btn.disabled = false;
    finSummary();
  }
  if (btn) btn.disabled = false;
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
function wprodPackText(p) {
  return (p.pack_items || []).map((it) => `${esc(it.name || "?")}×${fmtNum(it.quantity)}${esc(it.unit || "")}`).join("、") || "—";
}
function renderWarehouseProducts() {
  const t = $("wprodTable");
  const rows = WPROD || [];
  t.innerHTML = `<thead><tr>
    <th>名称</th><th>类目</th><th class="num">箱规(袋/箱)</th><th class="num">每袋净重</th>
    <th class="num">采购价(收入/袋)</th>
    <th class="num">运费(元/袋)</th><th class="num">每袋成本</th>
    <th>关联库存商品</th><th>关联结算(随货包材)</th><th>保质期</th><th></th></tr></thead><tbody>` +
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
      <td>${(p.pack_items || []).length ? wprodPackText(p) : '<span class="muted">未关联</span>'}</td>
      <td>${esc(p.shelf_life) || "—"}</td>
      <td style="white-space:nowrap;">
        <button class="btn sm" onclick="wprodEdit(${p.id})">改</button>
        <button class="btn sm danger" onclick="wprodDelete(${p.id})">删</button>
      </td></tr>`).join("") + `</tbody>`;
  if (!rows.length) t.innerHTML = `<tr><td colspan="11" class="empty">暂无入仓品，可点「新增入仓品」录入</td></tr>`;
}
function stockProductOptions(selId) {
  const list = (PRODUCTS || []).filter((p) => p.is_active && p.product_type === "stock" && !["人工", "快递"].includes(p.category));
  return '<option value="">（不关联库存商品）</option>' +
    list.map((p) => `<option value="${p.id}" ${selId === p.id ? "selected" : ""}>${esc(p.name)}（${esc(p.category || "—")}）</option>`).join("");
}
/* ---------- 入仓品关联结算（随货包材）编辑 ---------- */
function wPackRowsHtml(items) {
  const list = items || [];
  const opts = PRODUCTS.filter((p) => p.is_active)
    .map((p) => `<option value="${p.id}">${esc(p.name)}（${esc(p.category || "—")}）</option>`).join("");
  const unitSel = (m, u) => unitOptions(m, u) || `<option>${esc(u || "个")}</option>`;
  return list.map((it) => {
    const m = PRODUCTS.find((x) => x.id === it.product_id);
    return `<div class="pack-row">
      <input value="${esc(m ? m.name : it.product_id)}" readonly style="background:#f9fafb;" />
      <select class="pack-unit" onchange="packUnitChanged(this)">${unitSel(m, it.unit)}</select>
      <input type="number" step="any" value="${it.quantity}" class="pack-qty" />
      <button class="btn danger sm" onclick="this.closest('.pack-row').remove()">删</button>
    </div>`;
  }).join("") + `
    <div class="pack-row">
      <select class="pack-product searchable" onchange="wPackProductChanged(this)">
        <option value="">选择随货包材…</option>${opts}
      </select>
      <select class="pack-unit searchable"><option>个</option></select>
      <input type="number" step="any" value="1" class="pack-qty" />
      <button class="btn secondary sm" onclick="wPackAddRow()">＋</button>
    </div>`;
}
function wPackProductChanged(sel) {
  const row = sel.closest(".pack-row");
  const m = PRODUCTS.find((x) => x.id === +sel.value);
  row.querySelector(".pack-unit").innerHTML = m ? (unitOptions(m) || `<option>个</option>`) : `<option>个</option>`;
}
function wPackAddRow() {
  const box = $("wpackRows");
  const last = box.querySelector(".pack-row:last-child");
  const sel = last.querySelector(".pack-product");
  const qty = last.querySelector(".pack-qty").value;
  const unit = last.querySelector(".pack-unit").value;
  if (!sel || !sel.value || !(parseFloat(qty) > 0)) { toast("请选择随货包材并填数量"); return; }
  const m = PRODUCTS.find((x) => x.id === +sel.value);
  const opts = PRODUCTS.filter((p) => p.is_active)
    .map((p) => `<option value="${p.id}">${esc(p.name)}（${esc(p.category || "—")}）</option>`).join("");
  last.innerHTML = `
    <input value="${esc(m.name)}" readonly style="background:#f9fafb;" />
    <select class="pack-unit" onchange="packUnitChanged(this)">${unitOptions(m, unit) || `<option>${esc(unit)}</option>`}</select>
    <input type="number" step="any" value="${qty}" class="pack-qty" />
    <button class="btn danger sm" onclick="this.closest('.pack-row').remove()">删</button>`;
  box.insertAdjacentHTML("beforeend", `
    <div class="pack-row">
      <select class="pack-product searchable" onchange="wPackProductChanged(this)">
        <option value="">选择随货包材…</option>${opts}
      </select>
      <select class="pack-unit searchable"><option>个</option></select>
      <input type="number" step="any" value="1" class="pack-qty" />
      <button class="btn secondary sm" onclick="wPackAddRow()">＋</button>
    </div>`);
  // 新追加的行同样要转成「点击选择 / 输入筛选」的下拉，否则只能下拉不能输入搜索
  bindSearchable(box);
}
function wCollectPacks() {
  const out = [];
  document.querySelectorAll("#wpackRows .pack-row").forEach((row) => {
    const nameInput = row.querySelector("input[readonly]");
    const sel = row.querySelector(".pack-product");
    let pid = null;
    if (nameInput) {
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
    <hr />
    <h3>关联结算（随货包材） <span class="hint">每袋入仓品配套消耗的包材，入仓时按「每袋用量 × 袋数」扣减包材库存并计入入仓成本</span></h3>
    <div id="wpackRows">${wPackRowsHtml(p.pack_items)}</div>
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
    pack_items: wCollectPacks(),
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
    pack_cost: recs.reduce((s, r) => s + (r.pack_cost || 0), 0),
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
        cogs: x.g.cogs, freight: x.g.freight, pack_cost: x.g.pack_cost, profit: x.g.profit }
    : { _group: false, rec: x.rec, code: x.rec.code, date: x.rec.date, purchase_no: x.rec.purchase_no,
        center: x.rec.center, product: x.rec.product_name, quantity: x.rec.quantity, amount: x.rec.amount,
        cogs: x.rec.cogs, freight: x.rec.freight_total, pack_cost: x.rec.pack_cost, profit: x.rec.profit });
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
      `运费 <b>${fmtMoney(tot.freight)}</b> · 包材 <b>${fmtMoney(tot.pack_cost)}</b> · 毛利 <b style="color:var(--green)">${fmtMoney(tot.profit)}</b>`;
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
    <th data-key="pack_cost" class="num">包材成本${sortArrow("wInTable", "pack_cost")}</th>
    <th data-key="profit" class="num">毛利${sortArrow("wInTable", "profit")}</th>
    <th></th></tr></thead><tbody>` +
    sortable.map((x) => x._group ? renderWinGroupRow(x.g) : renderWinRow(x.rec)).join("") + `</tbody>`;
  if (!rows.length) t.innerHTML = `<tr><td colspan="13" class="empty">该时间段暂无入仓记录，可点「导入常温贴单」或「手动入仓」</td></tr>`;
  t._rows = sortable;
  t._render = loadWarehouseIns;
  updateBatchBar("win");
}
function wInPackText(r) {
  return (r.pack_items || []).map((it) => `${esc(it.name || "?")}×${fmtNum(it.quantity)}${esc(it.unit || "")}`).join("、");
}
function renderWinRow(r) {
  const checked = winSel.has(r.id) ? "checked" : "";
  const packTxt = wInPackText(r);
  return `<tr>
    <td class="cb-col"><input type="checkbox" value="${r.id}" ${checked} onchange="toggleSel('win',${r.id},this.checked)" /></td>
    <td class="mono">${esc(r.code)}</td>
    <td>${esc(r.date)}</td>
    <td class="mono">${esc(r.purchase_no) || "—"}</td>
    <td>${esc(r.center) || "—"}</td>
    <td><b>${esc(r.product_name)}</b>${r.product_id ? "" : ' <span class="badge" style="background:#fff3cd;color:#8a6d3b;">未关联</span>'}
      <div class="muted" style="font-size:12px;">${esc(r.stock_product_name) || "未关联库存商品"} · 净重 ${r.bag_weight ? `${fmtNum(r.bag_weight)} ${esc(r.stock_default_unit || "")}`.trim() : "—"} · 单位成本 ${fmtMoney(r.unit_cost)}/${esc(r.stock_default_unit || "单位")}${r.deduction_percent ? ` · 扣点 ${fmtNum(r.deduction_percent)}%` : ""}</div>
      ${packTxt ? `<div class="muted" style="font-size:12px;">随货包材：${packTxt}</div>` : ""}
    </td>
    <td class="num mono">${fmtNum(r.quantity)}</td>
    <td class="num mono">${fmtMoney(r.amount)}</td>
    <td class="num mono">${fmtMoney(r.cogs)}</td>
    <td class="num mono">${r.freight_total ? fmtMoney(r.freight_total) : "—"}</td>
    <td class="num mono">${r.pack_cost ? fmtMoney(r.pack_cost) : "—"}</td>
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
    <td class="num mono">${g.pack_cost ? fmtMoney(g.pack_cost) : "—"}</td>
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
    <div class="stat"><div class="label">包材成本</div><div class="value">${fmtMoney(g.pack_cost)}</div></div>
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
    <th data-key="pack_cost" class="num">包材成本${sortArrow("wgTable", "pack_cost")}</th>
    <th data-key="profit" class="num">毛利${sortArrow("wgTable", "profit")}</th>
    <th></th></tr></thead><tbody>` + rows.map((r) => `<tr>
    <td class="mono">${esc(r.code)}</td>
    <td>${esc(r.date)}</td>
    <td class="mono">${esc(r.purchase_no) || "—"}</td>
    <td>${esc(r.center) || "—"}</td>
    <td><b>${esc(r.product_name)}</b>
      <div class="muted" style="font-size:12px;">${esc(r.stock_product_name) || "未关联库存商品"} · 净重 ${r.bag_weight ? `${fmtNum(r.bag_weight)} ${esc(r.stock_default_unit || "")}`.trim() : "—"}${r.deduction_percent ? ` · 扣点 ${fmtNum(r.deduction_percent)}%` : ""}</div>
      ${wInPackText(r) ? `<div class="muted" style="font-size:12px;">随货包材：${wInPackText(r)}</div>` : ""}</td>
    <td class="num mono">${fmtNum(r.quantity)}</td>
    <td class="num mono">${r.box_count ? fmtNum(r.box_count) : "—"}</td>
    <td class="num mono">${fmtMoney(r.unit_price)}</td>
    <td class="num mono">${fmtMoney(r.amount)}</td>
    <td class="num mono">${fmtMoney(r.cogs)}</td>
    <td class="num mono">${r.freight_total ? fmtMoney(r.freight_total) : "—"}</td>
    <td class="num mono">${r.pack_cost ? fmtMoney(r.pack_cost) : "—"}</td>
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
      <div class="field"><label>随货包材成本</label><input id="wiPackCost" readonly /></div>
      <div class="field"><label>毛利</label><input id="wiProfit" readonly /></div>
      <div class="field" style="grid-column:1/-1;"><label>备注</label><input id="wiRemark" value="${esc(rec.remark || "")}" /></div>
      <div class="field" style="grid-column:1/-1;">
        <label>付款状态</label>
        ${payRadios("winPay", rec.pay_status, "待付款：先进「待付款账单」，点「已支付」后纳入财务报表")}
      </div>
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
/* 随货包材预估：按每袋用量 × 袋数折算数量与成本（单位成本按库存均价优先，回退参考成本） */
function wPackEstimate(p, qty) {
  const items = (p && p.pack_items) || [];
  let cost = 0;
  const parts = [];
  items.forEach((it) => {
    const m = PRODUCTS.find((x) => x.id === it.product_id);
    if (!m) return;
    const factor = (m.conversions || {})[it.unit] || 1;
    const base = ((m.avg_cost > 0 ? m.avg_cost : m.unit_cost) || 0);
    const tq = (it.quantity || 0) * qty;
    cost += tq * factor * base;
    parts.push(`${esc(m.name)}×${fmtNum(tq)}${esc(it.unit)}`);
  });
  return { text: parts.join("、") || "—", cost };
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
  const pe = wPackEstimate(p, qty);
  $("wiAmount").value = revenue.toFixed(2);
  $("wiCogs").value = cogs.toFixed(2);
  $("wiFreightTotal").value = ft.toFixed(2);
  if ($("wiPackCost")) $("wiPackCost").value = pe.cost.toFixed(2);
  $("wiProfit").value = (revenue - cogs - ft - pe.cost).toFixed(2);
  const hint = $("wiCostHint");
  if (hint) {
    const base = p && p.stock_product_name
      ? `收入 = 采购价 × (1 − 扣点${fmtNum(pct)}%)；成本来源：${p.stock_product_name}，单位成本 ${fmtMoney(uc)}/${p.stock_default_unit || "单位"}`
      : `扣点 ${fmtNum(pct)}%；未关联库存商品：商品成本按 0 计。`;
    hint.textContent = `${base}；随货包材：${pe.text}（预估成本 ${fmtMoney(pe.cost)}）`;
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
    pay_status: payOf("winPay"),
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
          <th class="num">每袋净重</th><th class="num">采购价(收入)</th><th class="num">运费</th><th class="num">商品成本</th><th class="num">包材成本</th>
        </tr></thead>
        <tbody>${rows.map((r, i) => `<tr data-i="${i}" data-uc="${r.unit_cost || 0}" data-pct="${r.deduction_percent || 0}" data-pid="${r.product_id || ""}">
          <td>${esc(r.product_name)}
            <div class="muted" style="font-size:12px;">${esc(r.purchase_no) || "—"} · ${esc(r.center) || "—"}</div>
          </td>
          <td><select class="wi-prod" onchange="wImportPick(${i})">${opts(r.product_id)}</select>
            <div class="muted" style="font-size:12px;">${esc(r.stock_product_name) || "未关联库存商品"}${r.deduction_percent ? ` · 扣点 ${fmtNum(r.deduction_percent)}%` : ""}</div>
            <div class="muted wi-pack" style="font-size:12px;"></div></td>
          <td><input class="wi-box" type="number" step="any" min="0" value="${r.box_count || ""}" style="width:58px;" /></td>
          <td><input class="wi-qty" type="number" step="any" min="0" value="${r.quantity}" style="width:68px;" oninput="wImportCalc()" /></td>
          <td><input class="wi-weight" type="number" step="any" min="0" value="${r.bag_weight || ""}" style="width:72px;" oninput="wImportCalc()" /></td>
          <td><input class="wi-price" type="number" step="any" min="0" value="${r.unit_price || ""}" style="width:70px;" oninput="wImportCalc()" /></td>
          <td><input class="wi-freight" type="number" step="any" min="0" value="${r.freight || ""}" style="width:64px;" oninput="wImportCalc()" /></td>
          <td class="num mono wi-cogs">—</td>
          <td class="num mono wi-packcost">—</td>
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
  tr.dataset.pid = p ? p.id : "";
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
  let rev = 0, cogs = 0, ft = 0, packc = 0, qtySum = 0;
  document.querySelectorAll("#wiImportTable tbody tr").forEach((tr) => {
    const q = parseFloat(tr.querySelector(".wi-qty").value) || 0;
    const pr = parseFloat(tr.querySelector(".wi-price").value) || 0;
    const fr = parseFloat(tr.querySelector(".wi-freight").value) || 0;
    const bw = parseFloat(tr.querySelector(".wi-weight").value) || 0;
    const uc = +(tr.dataset.uc || 0);
    const pct = +(tr.dataset.pct || 0);
    const pid = +tr.dataset.pid || null;
    const p = (WPROD || []).find((x) => x.id === pid);
    const pe = wPackEstimate(p, q);
    const rowCogs = q * bw * uc;
    const cell = tr.querySelector(".wi-cogs");
    if (cell) cell.textContent = fmtMoney(rowCogs);
    const pc = tr.querySelector(".wi-packcost");
    if (pc) pc.textContent = pe.cost ? fmtMoney(pe.cost) : "—";
    const packSub = tr.querySelector(".wi-pack");
    if (packSub) packSub.textContent = pe.text !== "—" ? `随货包材：${pe.text}` : "";
    rev += q * pr * (1 - pct / 100); cogs += rowCogs; ft += q * fr; packc += pe.cost; qtySum += q;
  });
  const el = $("wiImportTotal");
  if (el) el.innerHTML = `数量 <b>${fmtNum(qtySum)}</b> 袋 · 收入 <b>${fmtMoney(rev)}</b> · 成本 <b>${fmtMoney(cogs)}</b> · 运费 <b>${fmtMoney(ft)}</b> · 包材 <b>${fmtMoney(packc)}</b> · 毛利 <b style="color:var(--green)">${fmtMoney(rev - cogs - ft - packc)}</b>`;
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
    $("bkRemoteEnabled").checked = !!d.config.remote_enabled;
    $("bkJsonEnabled").checked = d.config.json_backup_enabled !== false;
    $("bkRemoteUrl").value = d.config.remote_url || "";
    toggleRemoteBackup();
    let s = d.config.enabled
      ? `自动备份已开启：每 ${d.config.interval_hours} 小时一次，保留最近 ${d.config.keep} 份`
      : "自动备份已关闭";
    if (d.config.remote_enabled && d.config.remote_url) {
      s += `；远程备份已开启 → ${d.config.remote_url}（远程保留 ${d.config.remote_keep || 100} 份）`;
      const rs = d.remote_status || {};
      if (rs.time) s += `｜上次推送 ${rs.time}：${rs.ok ? "成功" : "失败 " + (rs.message || "")}`;
    }
    const jb = (d.json_backups || [])[0];
    if (d.config.json_backup_enabled !== false) {
      s += jb
        ? `｜json 目录：最近 ${jb.mtime}（${jb.size_human}，共 ${d.json_backups.length} 份）`
        : "｜json 目录：暂无备份（内容无变化时不生成）";
    }
    $("bkStatus").textContent = s;
    renderBkTable(d.backups || []);
  } catch (e) { toast("加载备份失败：" + e.message); }
}
/* 远程备份：勾选后展开地址输入与部署脚本下载区 */
function toggleRemoteBackup() {
  const on = $("bkRemoteEnabled").checked;
  $("bkRemoteBox").style.display = on ? "" : "none";
}
/* 下载远程接收端部署/停止脚本（后端生成，含端口/路径/密钥） */
async function downloadRemoteScript(kind) {
  const isStop = kind === "stop";
  const url = routePath("/api/backup/remote/" + (isStop ? "stop-script" : "deploy-script"));
  const filename = isStop ? "stop_erp_backup_receiver.sh" : "deploy_erp_backup_receiver.sh";
  try {
    if (!isStop && !$("bkRemoteUrl").value.trim()) { toast("请先填写目标服务器地址"); return; }
    const res = await fetch(url);
    if (res.status === 401) { showLogin(); return; }
    if (!res.ok) throw new Error("HTTP " + res.status);
    const text = await res.text();
    const blob = new Blob([text], { type: "text/x-shellscript;charset=utf-8" });
    const a = document.createElement("a");
    a.href = URL.createObjectURL(blob);
    a.download = filename;
    document.body.appendChild(a);
    a.click();
    setTimeout(() => { URL.revokeObjectURL(a.href); a.remove(); }, 200);
    toast(`已下载 ${filename}，上传到备份服务器执行即可`);
  } catch (e) { toast("下载失败：" + e.message); }
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
    toast(r.json_backup ? `备份成功：${r.name}＋${r.json_backup}` : "备份成功：" + r.name);
    renderBkTable(r.backups || []);
    loadBackupPage();
  } catch (e) { toast("备份失败：" + e.message); }
}
async function saveBkConfig() {
  const remoteEnabled = $("bkRemoteEnabled").checked;
  const remoteUrl = $("bkRemoteUrl").value.trim();
  if (remoteEnabled && !remoteUrl) { toast("请填写目标服务器地址，如 1.2.3.4:8080/cloudback"); return; }
  try {
    await api("/api/backup/config", "POST", {
      enabled: $("bkEnabled").checked,
      interval_hours: +$("bkInterval").value || 2,
      keep: +$("bkKeep").value || 30,
      remote_enabled: remoteEnabled,
      remote_url: remoteUrl,
      remote_keep: 100,
      json_backup_enabled: $("bkJsonEnabled").checked,
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
    ensureUnits(0);   // 导入的 units.json 可能带进新单位，刷新前端缓存
  } catch (e) { toast("导入失败：" + e.message); }
}
async function pdataImportOne(kind) {
  if (!confirm("从 json 目录导入「" + kind + "」？将按名称新增/更新，不会删除已有数据。")) return;
  try {
    const r = await api("/api/product-data/import/" + kind, "POST");
    renderPdataImportResult([r]);
    loadPdataPage();
    ensureUnits(0);   // 导入的 units.json 可能带进新单位，刷新前端缓存
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
    ensureUnits(0);   // 导入的 units.json 可能带进新单位，刷新前端缓存
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
  // 关键词匹配：名称 / 分类 / 规格 / 编码 / 单位 / 出库方式（代发、扣减库存）/ 关联结算商品名
  // 这样输入「代发」就能筛出未关联库存大类的订单商品。
  const kwHit = (p) => {
    if (!kw) return true;
    if ((p.name || "").toLowerCase().includes(kw) || (p.category || "").toLowerCase().includes(kw)) return true;
    // 代发的关键词刻意不含「库存」二字：这样搜「库存」只出库存/扣减库存的商品，搜「代发」只出代发商品
    const way = p.product_type === "order"
      ? (prodStockLinks(p).length ? `订单 扣减库存 ${prodStockLinks(p).map((l) => l.name).join(" ")}` : "订单 代发 外发")
      : "库存商品";
    const packs = (p.pack_items || [])
      .map((it) => (PRODUCTS.find((x) => x.id === it.product_id) || {}).name || "")
      .join(" ");
    return [p.spec, p.code, p.unit, p.base_unit, way, packs].join(" ").toLowerCase().includes(kw);
  };
  let rows = PRODUCTS.filter((p) =>
    kwHit(p) &&
    (!cat || p.category === cat) &&
    (isOrderPage ? p.product_type === "order"
      : (forced ? p.category === forced : !EXCLUDED.includes(p.category))) &&
    (isOrderPage || !ptype || p.product_type === ptype)
  );
  const t = $("prodTable");
  // 「参考成本」和「库存」这两格显示的不是商品原始字段（参考成本可能是均价回退到参考成本，
  // 库存对订单商品显示的是它关联的库存商品），排序时按显示值换算，否则点表头会看不出升/降序。
  t._sortVal = (p, k) => (k === "avg_cost" ? refCostValue(p) : k === "stock" ? stockSortValue(p) : undefined);
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
      // linkInfo 允许含 HTML（代发徽章），所以文本分支这里自己先 esc，渲染时不能再 esc 一次
      const links = p.product_type === "order" ? prodStockLinks(p) : [];
      const linkInfo = p.product_type === "order"
        ? (links.length
          ? `扣减：${links.map((l) => `${esc(l.name)} ×${fmtNum(l.multiplier)}`).join("、")}`
          : '<span class="badge income">代发</span> <span class="muted">不扣库存，只统计代发数量/成本</span>')
        : esc(p.spec || "");
      const isLabor = p.category === "人工";
      const stockShown = p.product_type === "order" && links.length
        ? `<span class="muted">经库存商品</span>`
        : isLabor
          ? `<span class="badge income">工作量 ${fmtNum(p.workload)} 单</span>`
          : fmtStock(p);
      return `<tr>
        <td class="cb-col"><input type="checkbox" value="${p.id}" ${prodSel.has(p.id) ? "checked" : ""} onchange="toggleSel('prod',${p.id},this.checked)" /></td>
        <td class="muted mono">${esc(p.code) || "—"}</td>
        <td><b>${typeBadge} ${esc(p.name)}</b><div class="muted" style="font-size:12px;">${linkInfo}</div></td>
        <td>${esc(p.category) ? `<span class="badge adjust">${esc(p.category)}</span>` : "—"}</td>
        <td class="muted" style="max-width:170px;">${esc(packs) || "—"}</td>
        <td class="num mono" title="${esc(refCostTitle(p))}">${refCostHtml(p)}</td>
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
/* 单位表缓存。除了「计量单位管理」，AI 识图建商品、商品资料导入等入口也会往单位表加单位，
   所以打开商品弹窗前统一按 TTL 取一次最新，避免出现「新增了却在商品里找不到」。 */
let UNITS_TS = 0;
async function ensureUnits(maxAgeMs = 30000) {
  if (UNITS.length && Date.now() - UNITS_TS < maxAgeMs) return UNITS;
  try {
    UNITS = await api("/api/units");
    UNITS_TS = Date.now();
  } catch (e) { /* 拉取失败沿用旧缓存，不阻塞弹窗 */ }
  return UNITS;
}
async function openUnitsModal() {
  const units = await ensureUnits();
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
    await ensureUnits(0);   // 强制刷新：新单位要立刻能在商品表单里选到
    toast("单位已新增"); closeModal();
  } catch (e) { toast("新增失败：" + e.message); }
}
async function deleteUnit(id, name) {
  if (!confirm(`确认删除单位「${name}」？`)) return;
  try { await api("/api/units/" + id, "DELETE"); await ensureUnits(0); toast("已删除"); closeModal(); openUnitsModal(); }
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
    <select class="pack-unit searchable" onchange="packUnitChanged(this)">${unitOptions(m, unit)}</select>
    <input type="number" step="any" value="${qty}" class="pack-qty" />
    <button class="btn danger sm" onclick="this.closest('.pack-row').remove()">删</button>`;
  box.insertAdjacentHTML("beforeend", `
    <div class="pack-row">
      <select class="pack-product searchable" onchange="packProductChanged(this)">
        <option value="">选择关联商品…</option>
        ${PRODUCTS.filter((p) => p.is_active).map((p) => `<option value="${p.id}">${esc(p.name)}</option>`).join("")}
      </select>
      <select class="pack-unit searchable"><option>个</option></select>
      <input type="number" step="any" value="1" class="pack-qty" />
      <button class="btn secondary sm" onclick="addPackRow()">＋</button>
    </div>`);
  // 新追加的行同样要转成「点击选择 / 输入筛选」的下拉（原先漏了这台转换，导致只能下拉不能输入搜索）
  bindSearchable(box);
}

async function openProductModal(pid = 0, prefillName = "") {
  await ensureUnits();   // 先取最新单位表，否则刚新增的单位不会出现在「单位（默认单位）」下拉里
  const p = pid ? PRODUCTS.find((x) => x.id === pid) : null;
  const ptype = p ? p.product_type : "stock";
  const curUnit = p ? (p.default_unit || p.base_unit) : "斤";
  const curCat = p ? p.category : (prodForceCat || ""); // 独立分类页新增时自动带上分类
  const curName = p?.name || prefillName || "";
  // 售价/成本一律按「默认单位」填（以前按基础单位，如 元/克，太反直觉）；
  // 内部仍按基础单位存库，这里只是显示与录入时做一次换算。
  PM_EDIT_P = p;   // 记住正在编辑的原商品：保留它原有的单位，不因一次保存而丢
  const up0 = deriveUnitPayload(ptype, curUnit, p);
  const du0 = up0.default_unit || up0.base_unit;
  const f0 = (up0.conversions || {})[du0] || 1;
  PM_UNIT_F = f0;
  PM_SALE_BASE = p ? (+p.sale_price || 0) : 0;
  PM_COST_BASE = p ? (+p.unit_cost || 0) : 0;
  const saleDisp = +(PM_SALE_BASE * f0).toFixed(6);
  const costDisp = +(PM_COST_BASE * f0).toFixed(6);
  // 商品表单字段多，用加宽弹窗（字段自动多列排布）减少上下滚动
  $("modalBox").classList.add("wide");
  openModal(`
    <h3>${pid ? "编辑商品" : "新增商品"} <button class="close" onclick="closeModal()">✕</button></h3>
    <div class="form-grid">
      <div class="field"><label>商品编码</label><input id="pCode" value="${esc(p?.code || "")}" placeholder="如 ydj001，可留空" /></div>
      <div class="field"><label>商品名称 *</label><input id="pName" value="${esc(curName)}" placeholder="如：佛手柑大果2个" /></div>
      <div class="field"><label>分类</label><input id="pCategory" value="${esc(curCat)}" placeholder="如：蔬菜" /></div>
      <div class="field"><label>商品类型 *</label>
        <select id="pType" onchange="pTypeChanged()">
          <option value="stock" ${ptype === "stock" ? "selected" : ""}>库存商品（大类·真实库存）</option>
          <option value="order" ${ptype === "order" ? "selected" : ""}>订单商品（小类·出库销售）</option>
        </select></div>
      <div class="field"><label>单位（默认单位）</label><select id="pUnit" class="searchable"></select><div class="field-hint">重量类按克记账（1斤=500克），计数类按个记账；订单商品固定为「单」。<b>下面的售价与成本都按这个单位填</b></div></div>
      <div class="field"><label id="pSalePriceLabel">默认售价（元/${esc(du0)}）</label><input id="pSalePrice" type="number" step="any" value="${saleDisp}" /><div class="field-hint" id="pSalePriceHint"></div></div>
      <div class="field"><label id="pUnitCostLabel">参考成本（元/${esc(du0)}）</label><input id="pUnitCost" type="number" step="any" value="${costDisp}" /><div class="field-hint" id="pUnitCostHint"></div></div>
      <div class="field" id="pWeightBox"><label>单件净重（kg）</label><input id="pWeightKg" type="number" step="any" value="${p?.weight_kg || 0}" /><div class="field-hint">用于计算快递费。重量类库存自动按「扣减库存量」推导；按袋/按件等计数库存推不出重量时，就用这里手填的净重兜底（如 四神汤200g 填 0.2）。<b>代发商品填了净重也会按净重结算快递费</b>（不填=代发方包邮，不计快递费）</div></div>
    </div>
    <div id="pStockBox" class="form-grid" style="margin-top:10px;display:${ptype === "order" ? "grid" : "none"};">
      <div class="field" style="grid-column:1/-1;">
        <label>关联库存商品（可多个，出库时全部扣减）</label>
        <div id="stockLinkRows"></div>
        <button class="btn secondary sm" onclick="addStockLinkRow()">＋ 添加扣减库存商品</button>
        <div class="field-hint">卖 1 单本商品时，从下面每个库存大类按其倍数扣减库存（可输入名称快速筛选）；如 礼盒 = 苹果1斤 + 梨1斤。一个都不填 = <b>代发</b>：本仓不扣任何库存，只统计代发数量与代发成本（按下面「参考成本」计）</div>
      </div>
    </div>
    <div class="field" style="margin-top:10px;"><label>规格说明</label><input id="pSpec" value="${esc(p?.spec || "")}" placeholder="如：每个约150克；或每袋5斤" /></div>
    <hr />
    <h3>出库关联结算清单 <span class="hint">卖1单本商品时，自动扣减这些商品的库存（包材/人工等）</span></h3>
    <div id="packRows">${packRowsHtml(p?.pack_items)}</div>
    <div class="field" style="margin-top:10px;">
      <label>固定费用（每单，如人工打包费，元）</label>
      <input id="pPackFee" type="number" step="any" value="${p?.pack_fee || 0}" />
    </div>
    <label style="display:flex;gap:6px;align-items:center;margin-top:10px;"><input type="checkbox" id="pFreeShip" ${p?.free_shipping ? "checked" : ""}/> 包邮（出库不计快递费：该商品的运费不再自动结算）</label>
    ${p ? `<label style="display:flex;gap:6px;align-items:center;margin-top:10px;"><input type="checkbox" id="pActive" ${p.is_active ? "checked" : ""}/> 启用该商品</label>` : ""}
    <div class="modal-foot">
      ${p ? `<button class="btn danger" onclick="deleteProduct(${p.id})" style="margin-right:auto;">删除</button>` : ""}
      <button class="btn secondary" onclick="closeModal()">取消</button>
      <button class="btn" onclick="saveProduct(${pid || 0})">保存</button>
    </div>`);
  initProductUnitSelect(ptype, curUnit);
  updateProductPriceLabels(du0, f0, up0.base_unit);   // 价格字段标签/提示按默认单位显示
  // 加载库存商品（大类）列表，并渲染「扣减库存商品」多行（支持 + 号新增）
  if (ptype === "order") {
    api("/api/stocks").then((stocks) => {
      STOCKS = stocks || [];
      renderStockLinkRows(prodStockLinks(p || {}));
    }).catch(() => { $("stockLinkRows").innerHTML = '<div class="muted">库存商品加载失败</div>'; });
  } else {
    $("stockLinkRows").innerHTML = "";
  }
}
/* 商品表单的单位一律取自「计量单位管理」(/api/units)，用户新增的单位要能直接选到。
   以前这里是写死的清单，所以新增单位后在商品里根本找不到。 */
let PM_EDIT_P = null;   // 当前弹窗正在编辑的原商品（新增为 null），用于保留它原有的单位
const FALLBACK_UNITS = {
  weight: ["克", "斤", "公斤", "千克"],
  count: ["个", "袋", "包", "盒", "箱", "件", "份"],
};
function unitMeta(name) {
  return (UNITS || []).find((u) => u.name === name) || null;
}
/* 是否重量类单位：优先看单位表，单位表没加载时按内置标准单位兜底 */
function isWeightUnitName(name) {
  const m = unitMeta(name);
  if (m) return m.category === "weight";
  return FALLBACK_UNITS.weight.includes(name);
}
/* 某类别的换算表：重量类以「克」为基础（系数取单位表里的每单位克数），计数类以「个」为基础 */
function unitConversions(category) {
  const convs = {};
  (UNITS || []).forEach((u) => {
    if (u.category !== category) return;
    const f = category === "weight" ? Number(u.gram_per_unit) : 1;
    if (f > 0) convs[u.name] = f;
  });
  const fb = category === "weight" ? { 克: 1, 斤: 500, 公斤: 1000, 千克: 1000 } : { 个: 1 };
  Object.entries(fb).forEach(([k, v]) => { if (!(k in convs)) convs[k] = v; });
  return convs;
}
/* 商品表单可选单位名（订单商品固定「单」）；extra = 老商品当前单位，保证它一定在选项里 */
function productUnitNames(ptype, extra) {
  if (ptype === "order") return ["单"];
  const names = (UNITS || []).map((u) => u.name).filter(Boolean);
  const base = names.length ? names : [...FALLBACK_UNITS.weight, ...FALLBACK_UNITS.count];
  return (extra && !base.includes(extra)) ? base.concat(extra) : base;
}
function initProductUnitSelect(ptype, curUnit) {
  const units = productUnitNames(ptype, curUnit);
  const sel = $("pUnit");
  const cur = ptype === "order" ? "单" : (units.includes(curUnit) ? curUnit : (units.includes("斤") ? "斤" : units[0]));
  sel.innerHTML = units.map((u) => `<option value="${u}" ${u === cur ? "selected" : ""}>${u}</option>`).join("");
  sel.onchange = pUnitChanged;   // 换默认单位时，价格字段按新单位重算显示
}
/* 商品弹窗里的价格：对外按默认单位，内部按基础单位（PM_* 存的就是基础单位值） */
let PM_UNIT_F = 1;
let PM_SALE_BASE = 0;
let PM_COST_BASE = 0;
function updateProductPriceLabels(du, f, bu) {
  const conv = f !== 1 ? `（1${du} = ${fmtNum(f)}${bu}）` : "";
  if ($("pSalePriceLabel")) $("pSalePriceLabel").textContent = `默认售价（元/${du}）`;
  if ($("pUnitCostLabel")) $("pUnitCostLabel").textContent = `参考成本（元/${du}）`;
  if ($("pSalePriceHint")) $("pSalePriceHint").textContent = `按默认单位填${conv}；出库时按这个价带出`;
  if ($("pUnitCostHint")) $("pUnitCostHint").textContent = `按默认单位填${conv}；包材/人工等无入库时按此成本结算（如纸箱 0.9 元/个）`;
}
/* 切换默认单位：先把手填的值折回基础单位，再按新单位显示，避免价格被单位搞乱 */
function pUnitChanged() {
  const up = deriveUnitPayload($("pType").value, $("pUnit").value, PM_EDIT_P);
  const du = up.default_unit || up.base_unit;
  const f = (up.conversions || {})[du] || 1;
  const back = (id) => {
    const el = $(id);
    const v = el ? parseFloat(el.value) : NaN;
    return isFinite(v) ? v / (PM_UNIT_F || 1) : 0;
  };
  PM_SALE_BASE = back("pSalePrice");
  PM_COST_BASE = back("pUnitCost");
  PM_UNIT_F = f;
  if ($("pSalePrice")) $("pSalePrice").value = +(PM_SALE_BASE * f).toFixed(6);
  if ($("pUnitCost")) $("pUnitCost").value = +(PM_COST_BASE * f).toFixed(6);
  updateProductPriceLabels(du, f, up.base_unit);
}
/* 由「默认单位」推出基础单位与换算表：重量类归「克」、计数类归「个」，
   换算系数取自单位表（新增的重量类单位按它填的每单位克数参与换算）。 */
function deriveUnitPayload(ptype, unit, prev) {
  let payload;
  if (ptype === "order" || unit === "单") {
    payload = { base_unit: "单", default_unit: "单", conversions: { 单: 1 } };
  } else if (isWeightUnitName(unit)) {
    payload = { base_unit: "克", default_unit: unit, conversions: unitConversions("weight") };
  } else {
    payload = { base_unit: "个", default_unit: unit, conversions: unitConversions("count") };
  }
  // 编辑同基础单位的老商品时，保留它原有的其它单位（如导入产生的 g/kg），避免一编辑就少单位
  if (prev && prev.base_unit === payload.base_unit) {
    Object.entries(prev.conversions || {}).forEach(([u, f]) => {
      if (!(u in payload.conversions) && Number(f) > 0) payload.conversions[u] = Number(f);
    });
  }
  if (!(unit in payload.conversions)) payload.conversions[unit] = 1;   // 兜底：单位表没加载时也要能存
  return payload;
}
function pTypeChanged() {
  const t = $("pType").value;
  $("pStockBox").style.display = t === "order" ? "grid" : "none";
  initProductUnitSelect(t, $("pUnit").value);
  if (t === "order" && !STOCKS.length) {
    api("/api/stocks").then((stocks) => {
      STOCKS = stocks || [];
      if ($("stockLinkRows") && !$("stockLinkRows").querySelector(".stock-link-row")) renderStockLinkRows([]);
    });
  }
}

/* ---------- 订单商品「扣减库存商品」多行（支持 + 号新增多个） ---------- */
let STOCKS = [];   // 库存商品（大类）缓存，供关联行下拉使用
function stockLinkOptions(selId) {
  const list = STOCKS.length ? STOCKS : PRODUCTS.filter((p) => p.is_active && p.product_type === "stock");
  return '<option value="">选择库存商品（大类）…</option>' + list.map((s) => {
    const du = s.default_unit || s.base_unit || s.unit || "";
    return `<option value="${s.id}" ${Number(selId) === s.id ? "selected" : ""}>${esc(s.name)}（${esc(s.category || "—")}${du ? "·单位" + esc(du) : ""}）</option>`;
  }).join("");
}
function stockLinkRowHtml(link) {
  return `<div class="stock-link-row">
    <select class="stock-link searchable">${stockLinkOptions(link && link.product_id)}</select>
    <input type="number" step="any" min="0" class="stock-mult" value="${link ? (Number(link.multiplier) || 1) : 1}" placeholder="倍数（1单=？库存单位）" />
    <button class="btn danger sm" onclick="this.closest('.stock-link-row').remove()">删</button>
  </div>`;
}
function renderStockLinkRows(links) {
  const box = $("stockLinkRows");
  if (!box) return;
  box.innerHTML = (links || []).map((l) => stockLinkRowHtml(l)).join("");
  bindSearchable(box);
}
function addStockLinkRow() {
  const box = $("stockLinkRows");
  if (!box) return;
  box.insertAdjacentHTML("beforeend", stockLinkRowHtml(null));
  bindSearchable(box); // 新追加行的下拉也需支持输入筛选
}
function collectStockLinks() {
  const out = [];
  document.querySelectorAll("#stockLinkRows .stock-link-row").forEach((row) => {
    const sel = row.querySelector(".stock-link");
    const pid = sel && sel.value ? +sel.value : null;
    const mult = parseFloat(row.querySelector(".stock-mult").value);
    if (pid && mult > 0) out.push({ product_id: pid, multiplier: mult });
  });
  return out;
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
  const unitPayload = deriveUnitPayload(ptype, unit, PM_EDIT_P);
  // 订单商品可关联多个扣减库存商品（stock_links）；stock_product_id/multiplier 保留首项以兼容旧逻辑（扣点分类等）
  const stockLinks = ptype === "order" ? collectStockLinks() : [];
  const payload = {
    code: $("pCode").value,
    name: $("pName").value,
    category: $("pCategory").value,
    product_type: ptype,
    base_unit: unitPayload.base_unit,
    default_unit: unitPayload.default_unit,
    spec: $("pSpec").value,
    // 界面上售价/成本按「默认单位」填，存库要折回基础单位；
    // PM_UNIT_F 就是当前显示单位对应的换算系数（打开弹窗时设置，切换单位时同步更新）
    sale_price: +((+$("pSalePrice").value || 0) / (PM_UNIT_F || 1)).toFixed(8),
    unit_cost: +((+$("pUnitCost").value || 0) / (PM_UNIT_F || 1)).toFixed(8),
    weight_kg: +($("pWeightKg").value || 0),
    conversions: unitPayload.conversions,
    pack_items: collectPacks(),
    pack_fee: +$("pPackFee").value || 0,
    stock_product_id: stockLinks.length ? stockLinks[0].product_id : null,
    multiplier: stockLinks.length ? stockLinks[0].multiplier : 1,
    stock_links: stockLinks,
    free_shipping: $("pFreeShip") ? $("pFreeShip").checked : false,
    is_active: $("pActive") ? $("pActive").checked : true,
  };
  if (!payload.name.trim()) { toast("请填写商品名称"); return; }
  // 订单商品可以不关联库存大类 = 代发（本仓不扣库存，只统计代发数量与代发成本）；
  // 但代发成本按「参考成本」计，没填就会算成 0，这里给个提醒（不拦保存）。
  if (payload.product_type === "order" && !stockLinks.length && !payload.unit_cost) {
    if (!confirm("该订单商品未关联库存商品（= 代发），但「参考成本」为 0，代发成本会按 0 计。仍要保存吗？")) return;
  }
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
  const box = $("prItems");
  box.insertAdjacentHTML("beforeend", prItemRowHtml());
  bindSearchable(box); // 新追加行的下拉也需支持输入筛选
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
  const box = $("prBoxItems");
  box.insertAdjacentHTML("beforeend", prBoxRowHtml());
  bindSearchable(box); // 新追加行的下拉也需支持输入筛选
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
  if (!inboundBlocks().length) addInboundBlock();
  updateInboundTotal();
  loadInbounds();
}
/* ---------- 入库单行（原来的整块样式：一行 = 一张入库单，各行独立填） ---------- */
let IN_BLOCK_SEQ = 0;      // 行的唯一序号（备注 / 附件按它生成唯一 id）
let IN_PICK_BLOCK = null;  // 商品选择器当前作用在哪一行

function inboundBlocks() { return [...document.querySelectorAll("#inBlocks .in-block")]; }
function inBlockOf(el) { return el && el.closest ? el.closest(".in-block") : null; }

/** 一行 = 原来那张完整入库单（商品/单位/数量/单价/金额/调整/运费/装卸费/供应商/日期/操作员/付款状态/备注附件） */
function inboundBlockHtml(idx) {
  return `<div class="in-block" data-idx="${idx}">
    <div class="in-block-head">
      <span class="muted">第 ${idx} 张入库单</span>
      <div class="grow"></div>
      <button class="btn sm danger in-block-del" onclick="removeInboundBlock(this)">删除这一行</button>
    </div>
    <div class="form-grid">
      <div class="field">
        <label>商品 *</label>
        <input class="in-pick-name" readonly placeholder="＋ 点击选择商品" onclick="openInboundPicker(this)" style="cursor:pointer;background:var(--primary-50);" />
        <div class="field-hint in-stock-hint"></div>
      </div>
      <div class="field"><label>进货单位 *</label><select class="in-unit" onchange="inBlockUnitChanged(this)"></select><div class="field-hint in-unit-hint"></div></div>
      <div class="field"><label>数量 *</label><input class="in-qty" type="number" min="0" step="any" placeholder="0" oninput="calcInboundBlock(this)" /></div>
      <div class="field"><label>单价（所选单位）*</label><input class="in-price" type="number" min="0" step="any" placeholder="0.00" oninput="calcInboundBlock(this)" /><div class="field-hint in-price-hint"></div></div>
      <div class="field"><label>金额</label><input class="in-amount" readonly /></div>
      <div class="field">
        <label>调整（抹零 / 凑整）</label>
        <input class="in-adjust" type="number" step="any" placeholder="0.00" oninput="calcInboundBlock(this)" />
        <div class="field-hint in-adjust-hint">正=多付，负=少付；差额自动记「金额调整」其他开支，商品成本不变</div>
      </div>
      <div class="field">
        <label>运费（选填）</label>
        <input class="in-freight" type="number" min="0" step="any" placeholder="0.00" oninput="calcInboundBlock(this)" />
        <div class="field-hint in-freight-hint">计入该批次成本 → 体现在这个品的毛利；并自动记入「其他开支」备查</div>
      </div>
      <div class="field">
        <label>装卸费（选填）</label>
        <input class="in-handling" type="number" min="0" step="any" placeholder="0.00" oninput="calcInboundBlock(this)" />
        <div class="field-hint">同运费：入成本、进「其他开支」，不强制填</div>
      </div>
      <div class="field"><label>供应商</label><input class="in-supplier" placeholder="供应商名称" /></div>
      <div class="field"><label>日期 *</label><input class="in-date" type="date" /></div>
      <div class="field"><label>操作员</label><input class="in-operator" readonly title="默认当前登录账号，不可修改" /></div>
      <div class="field">
        <label>付款状态</label>
        ${payRadios("inPay_" + idx, "paid", "待付款：先进「待付款账单」，点「已支付」后才计入财务报表")}
      </div>
    </div>
    <div class="field" style="margin-top:12px;">
      <label>备注</label>
      <textarea id="inRemark_${idx}" rows="1" placeholder="可选" onpaste="pasteRemarkFiles('inRemark_${idx}', event)"></textarea>
      <div class="attach-bar">
        <button type="button" class="btn sm secondary" onclick="$('inRemarkFile_${idx}').click()"><svg class="ic"><use href="#i-paperclip"/></svg> 图片 / 附件</button>
        <span class="attach-tip">支持图片、PDF、Excel 等（≤20MB），可直接 Ctrl+V 粘贴</span>
        <input type="file" id="inRemarkFile_${idx}" multiple style="display:none;" onchange="uploadRemarkFiles('inRemark_${idx}', this)" />
      </div>
      <div class="attach-list" id="inRemark_${idx}Files"></div>
    </div>
    <div class="muted in-block-sum" style="font-size:12px;"></div>
  </div>`;
}

function addInboundBlock() {
  const box = $("inBlocks");
  if (!box) return null;
  const idx = ++IN_BLOCK_SEQ;
  const wrap = document.createElement("div");
  wrap.innerHTML = inboundBlockHtml(idx);
  const block = wrap.firstElementChild;
  box.appendChild(block);
  block.querySelector(".in-date").value = today();
  block.querySelector(".in-operator").value = operatorName();
  syncInboundBlocks();
  return block;
}

function removeInboundBlock(btn) {
  const b = inBlockOf(btn);
  if (!b) return;
  REMARK_ATTACH["inRemark_" + b.dataset.idx] = [];   // 顺手清掉这行的附件缓存
  b.remove();
  if (!inboundBlocks().length) addInboundBlock();     // 至少留一行
  syncInboundBlocks();
}

/** 序号文案 + 「删除这一行」显隐（只剩一行时不显示删除）+ 底部合计 */
function syncInboundBlocks() {
  const blocks = inboundBlocks();
  blocks.forEach((b, i) => {
    const label = b.querySelector(".in-block-head .muted");
    if (label) label.textContent = `第 ${i + 1} 张入库单`;
    const del = b.querySelector(".in-block-del");
    if (del) del.style.display = blocks.length > 1 ? "" : "none";
  });
  updateInboundTotal();
}

/** 底部合计（只统计选了商品且填了数量的行） */
function updateInboundTotal() {
  const el = $("inTotal");
  if (!el) return;
  let n = 0, goods = 0, fee = 0, adj = 0;
  inboundBlocks().forEach((b) => {
    if (!+(b.dataset.pid || 0)) return;
    const qty = parseFloat((b.querySelector(".in-qty") || {}).value) || 0;
    if (!(qty > 0)) return;
    n++;
    goods += qty * (parseFloat((b.querySelector(".in-price") || {}).value) || 0);
    fee += (parseFloat((b.querySelector(".in-freight") || {}).value) || 0)
      + (parseFloat((b.querySelector(".in-handling") || {}).value) || 0);
    adj += parseFloat((b.querySelector(".in-adjust") || {}).value) || 0;
  });
  if (!n) { el.style.display = "none"; el.innerHTML = ""; return; }
  const pay = goods + fee + adj;
  el.style.display = "block";
  el.innerHTML = `本次填了 <b>${n}</b> 张入库单：货款 <b>¥${goods.toFixed(2)}</b>`
    + (fee ? ` ＋ 运费/装卸 <b>¥${fee.toFixed(2)}</b>` : "")
    + (adj ? ` ${adj > 0 ? "＋" : "－"} 调整 <b>¥${Math.abs(adj).toFixed(2)}</b>` : "")
    + ` ＝ 实付 <b>¥${pay.toFixed(2)}</b> <span class="muted">（没选商品或没填数量的行不会入库）</span>`;
}

/** 换单位：价格要跟着换算，所以按新单位重填一次（用户改过就保留） */
function inBlockUnitChanged(sel) {
  const b = inBlockOf(sel);
  fillInboundRowPrice(b);
  calcInboundBlock(b);
}

/** 逐行算金额与提示（就是原来单张入库单的口径：金额 / 调整 / 运费装卸批次成本 / 单位换算 / 本单小计） */
function calcInboundBlock(el) {
  const b = inBlockOf(el);
  if (!b) return;
  const p = PRODUCTS.find((x) => x.id === +(b.dataset.pid || 0));
  const unit = (b.querySelector(".in-unit") || {}).value || "";
  const qty = parseFloat((b.querySelector(".in-qty") || {}).value) || 0;
  const price = parseFloat((b.querySelector(".in-price") || {}).value) || 0;
  const base = qty * price;
  const adj = parseFloat((b.querySelector(".in-adjust") || {}).value) || 0;
  const fee = (parseFloat((b.querySelector(".in-freight") || {}).value) || 0)
    + (parseFloat((b.querySelector(".in-handling") || {}).value) || 0);
  const amt = b.querySelector(".in-amount");
  if (amt) amt.value = base.toFixed(2);
  const setHint = (sel, html) => { const e = b.querySelector(sel); if (e) e.innerHTML = html; };
  setHint(".in-adjust-hint", adj
    ? `实付 ¥${(base + adj).toFixed(2)}（商品金额 ¥${base.toFixed(2)} ${adj > 0 ? "+" : "-"} ${Math.abs(adj).toFixed(2)}）· 差额记「金额调整」其他开支`
    : "正=多付，负=少付；差额自动记「金额调整」其他开支，商品成本不变");
  setHint(".in-freight-hint", fee > 0
    ? `批次成本 ¥${(base + fee).toFixed(2)}（商品 ${base.toFixed(2)} + 运费/装卸 ${fee.toFixed(2)}）· 毛利随销量扣减，并同步记入「其他开支」`
    : "计入该批次成本 → 体现在这个品的毛利；并自动记入「其他开支」备查");
  const factor = p && unit ? (p.conversions || {})[unit] : null;
  setHint(".in-unit-hint", factor ? `1${esc(unit)} = ${fmtNum(factor)} ${esc(p.base_unit)}` : "");
  const sum = b.querySelector(".in-block-sum");
  if (sum) {
    sum.textContent = p
      ? `本单：${fmtNum(qty)}${unit} × ${unit ? fmtMoney(price) : ""} = 货款 ${fmtMoney(base)}`
        + (fee ? ` ＋ 运费/装卸 ${fmtMoney(fee)}` : "")
        + (adj ? ` ${adj > 0 ? "＋" : "－"} 调整 ${fmtMoney(Math.abs(adj))}` : "")
        + ` ＝ 实付 ${fmtMoney(base + fee + adj)}`
      : "";
  }
  updateInboundTotal();
}
/* 入库商品选择器（二级弹层：搜索 + 分类 + 卡片列表）；选好后填到对应的那一行 */
function openInboundPicker(inp) {
  IN_PICK_BLOCK = inBlockOf(inp);
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
  const b = IN_PICK_BLOCK;
  if (!p || !b) return;
  b.dataset.pid = p.id;
  const inp = b.querySelector(".in-pick-name");
  inp.value = `[库存] ${p.name}（${p.category || "—"}）`;
  const du = p.default_unit || p.base_unit;
  const sel = b.querySelector(".in-unit");
  sel.innerHTML = unitOptions(p, du);
  sel.value = du;
  const factor = (p.conversions || {})[du] || 1;
  inp.title = `当前库存 ${fmtStock(p)}；1${du} = ${fmtNum(factor)} ${p.base_unit}`;
  const sh = b.querySelector(".in-stock-hint");
  if (sh) sh.textContent = `当前库存 ${fmtStock(p)}；1${du} = ${fmtNum(factor)} ${p.base_unit}`;
  closeModal();
  fillInboundRowPrice(b);   // 自动带出上次的价（没有入库记录就用参考成本），用户可改
  calcInboundBlock(b);
}

/* 一键改用参考成本（当最近入库价不是你想要的时候） */
function useInboundRefCost(btn) {
  const b = inBlockOf(btn);
  if (!b) return;
  const p = PRODUCTS.find((x) => x.id === +(b.dataset.pid || 0));
  if (!p) return;
  const unit = (b.querySelector(".in-unit") || {}).value || defaultUnit(p);
  const v = (Number(p.unit_cost) || 0) * ((p.conversions || {})[unit] || 1);
  b.querySelector(".in-price").value = v > 0 ? +v.toFixed(6) : "";
  calcInboundBlock(b);
  toast("已改用参考成本，可直接修改");
}
/* 单价自动带出：优先用「最近一次录入的入库价」（按所选单位换算），没有入库记录时用参考成本。
   只在重新选商品 / 换单位时重填，用户改了或清空后不再覆盖（真正落库由 submitInbound 校验）。
   传进来的 scope 可以是入库页的整行 .in-block，也可以是「鲜货入库」页的一行（两处共用同一套价口径）。 */
function fillInboundRowPrice(scope) {
  if (!scope) return;
  const p = PRODUCTS.find((x) => x.id === +(scope.dataset.pid || 0));
  const inp = scope.querySelector(".in-price");
  if (!p || !inp) return;
  const unit = (scope.querySelector(".in-unit") || {}).value || defaultUnit(p);
  const f = (p.conversions || {})[unit] || 1;
  const lastBase = Number(p.last_in_price) || 0;   // 最近一次入库价（按基础单位）
  const refBase = Number(p.unit_cost) || 0;        // 参考成本（按基础单位）
  const per = (base) => +(base * f).toFixed(6);
  if (lastBase > 0) {
    inp.value = per(lastBase);
  } else if (refBase > 0) {
    inp.value = per(refBase);
  } else {
    inp.value = "";
  }
  const money = (v) => `¥${fmtNum(+v.toFixed(4))}/${unit}`;
  if (lastBase > 0) {
    inp.title = `最近入库价 ${money(per(lastBase))}（${p.last_in_date || "—"}）`
      + (refBase > 0 ? `；参考成本 ${money(per(refBase))}` : "")
      + "。可改可清，改了下次入库自动用新价";
  } else if (refBase > 0) {
    inp.title = `该商品还没入库过，按参考成本填 ${money(per(refBase))}；保存后即记住这个价`;
  } else {
    inp.title = "该商品还没入库过、也没设参考成本，请手动填单价";
  }
  // 入库页单价下面那行小字（原样式）：最近入库价 / 参考成本 + 一键改用参考成本
  const hint = scope.querySelector(".in-price-hint");
  if (hint) {
    if (lastBase > 0) {
      hint.innerHTML = `最近入库价 ${esc(money(per(lastBase)))}（${esc(p.last_in_date || "")}）`
        + (refBase > 0 ? `　参考成本 ${esc(money(per(refBase)))} <button class="btn sm ghost" onclick="useInboundRefCost(this)">用参考成本</button>` : "")
        + `<div class="muted" style="font-size:11px;">可改可清；改了下次入库自动用新价</div>`;
    } else if (refBase > 0) {
      hint.innerHTML = `按参考成本填 ${esc(money(per(refBase)))}<div class="muted" style="font-size:11px;">该商品还没入库过；保存后即记住这个价</div>`;
    } else {
      hint.textContent = "该商品还没入库过、也没设参考成本，请手动填单价";
    }
  }
}
async function submitInbound() {
  const blocks = inboundBlocks();
  if (!blocks.length) { toast("请先点「＋ 添加一行」"); return; }
  const items = [], bad = [], picked = [];
  blocks.forEach((b, i) => {
    const no = i + 1;
    const pid = +(b.dataset.pid || 0);
    const qty = parseFloat((b.querySelector(".in-qty") || {}).value);
    const price = parseFloat((b.querySelector(".in-price") || {}).value);
    const adjust = parseFloat((b.querySelector(".in-adjust") || {}).value) || 0;
    const freight = parseFloat((b.querySelector(".in-freight") || {}).value) || 0;
    const handling = parseFloat((b.querySelector(".in-handling") || {}).value) || 0;
    const date = ((b.querySelector(".in-date") || {}).value || "").trim();
    const unit = ((b.querySelector(".in-unit") || {}).value || "").trim();
    // 没选商品的行直接跳过（当没填）；选了商品就得填全，否则报出来
    if (!pid) { if (qty > 0) bad.push(`第 ${no} 行没选商品`); return; }
    if (!unit || !(qty > 0)) { bad.push(`第 ${no} 行数量/单位没填全`); return; }
    if (isNaN(price)) { bad.push(`第 ${no} 行没填单价`); return; }
    if (!date) { bad.push(`第 ${no} 行没选日期`); return; }
    if (freight < 0 || handling < 0) { bad.push(`第 ${no} 行运费/装卸费不能为负`); return; }
    const idx = b.dataset.idx || no;
    items.push({
      product_id: pid, unit, quantity: qty, unit_price: price,
      supplier: ((b.querySelector(".in-supplier") || {}).value || "").trim(),
      operator: ((b.querySelector(".in-operator") || {}).value || "").trim() || operatorName(),
      date, remark: remarkValue("inRemark_" + idx),
      pay_status: payOf("inPay_" + idx), adjust_amount: adjust, freight, handling,
    });
    picked.push({ block: b, idx, pay_name: "inPay_" + idx });
  });
  if (bad.length) { toast(bad[0] + (bad.length > 1 ? ` 等 ${bad.length} 处要改` : "")); return; }
  if (!items.length) { toast("请先选商品并填数量（一行 = 一张入库单）"); return; }

  const goods = items.reduce((a, it) => a + it.quantity * it.unit_price, 0);
  const fee = items.reduce((a, it) => a + it.freight + it.handling, 0);
  const adj = items.reduce((a, it) => a + it.adjust_amount, 0);
  const alertBox = $("inAlert");
  if (alertBox) { alertBox.style.display = "none"; alertBox.innerHTML = ""; }
  try {
    const r = await api("/api/inbounds/batch", "POST", { items });
    const tips = [];
    if (r.created) tips.push(`已入库 ${r.created} 张单（货款 ¥${goods.toFixed(2)}${fee ? ` + 运费/装卸 ¥${fee.toFixed(2)}` : ""}${adj ? ` ${adj > 0 ? "+" : "-"} 调整 ¥${Math.abs(adj).toFixed(2)}` : ""}）`);
    if (r.failed_count) tips.push(`${r.failed_count} 行失败`);
    if (items.some((it) => it.pay_status === "unpaid")) tips.push("待付款已进「待付款账单」");
    toast(tips.join("，") || "已提交");
    if (r.failed_count) {
      const box = $("inAlert");
      if (box) {
        box.className = "alert err";
        box.style.display = "block";
        box.innerHTML = "以下行没入库成功（已保留，改完可再提交）：<br>"
          + r.failed.map((f) => `第 ${f.row} 行：${esc(f.reason)}`).join("<br>");
      }
    }
    if (r.created) {
      // 提交成功的行清空（失败的行原样保留好改），商品 / 单位 / 供应商 / 日期 不动
      const badRows = new Set((r.failed || []).map((f) => f.row));
      picked.forEach((p, i) => {
        if (badRows.has(i + 1)) return;   // 只按成功/失败的行号清
        const b = p.block;
        ["in-qty", "in-price", "in-amount", "in-adjust", "in-freight", "in-handling"].forEach((cls) => {
          const el = b.querySelector("." + cls);
          if (el) el.value = "";
        });
        clearRemarkField("inRemark_" + p.idx);
        setPay(p.pay_name, "paid");   // 回到默认「已付款」
        calcInboundBlock(b);
      });
      // 清完的空行（没商品、没数量）收掉，只留一行空的
      const empties = inboundBlocks().filter((b) => !+(b.dataset.pid || 0));
      if (empties.length > 1) empties.slice(1).forEach((b) => b.remove());
      syncInboundBlocks();
      loadInbounds(); loadStock();
      // 刷新商品缓存：下次选这个商品时会带上「这次录入的价」（最近价实时跟着变）
      api("/api/products").then((ps) => { PRODUCTS = ps; }).catch(() => {});
    }
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
    <th data-key="unit_price" class="num">单价${sortArrow("inTable", "unit_price")}</th>
    <th data-key="total_amount" class="num">金额${sortArrow("inTable", "total_amount")}</th>
    <th data-key="supplier">供应商${sortArrow("inTable", "supplier")}</th>
    <th data-key="operator">操作员${sortArrow("inTable", "operator")}</th>
    <th data-key="date">日期${sortArrow("inTable", "date")}</th>
    <th>备注</th>
    <th></th></tr></thead><tbody>` +
    rows.map((r) => `<tr>
      <td class="cb-col"><input type="checkbox" value="${r.id}" ${inSel.has(r.id) ? "checked" : ""} onchange="toggleSel('in',${r.id},this.checked)" /></td>
      <td class="mono">${r.code}${payTag(r.pay_status)}</td>
      <td><b>${esc(r.product_name)}</b></td>
      <td>${fmtNum(r.quantity)} ${r.unit}</td>
      <td class="num mono">${fmtMoney(r.unit_price)}/${r.unit}</td>
      <td class="num mono">${fmtMoney(r.final_amount != null ? r.final_amount : r.total_amount)}${r.adjust_amount ? `<div class="muted" style="font-size:11px;">调整 ${r.adjust_amount > 0 ? "+" : "-"}${fmtMoney(Math.abs(r.adjust_amount))}</div>` : ""}${(r.freight || r.handling) ? `<div class="muted" style="font-size:11px;" title="已计入批次成本（体现在该品毛利），并同步「其他开支」备查">${r.freight ? "运费 " + fmtMoney(r.freight) : ""}${r.freight && r.handling ? " · " : ""}${r.handling ? "装卸 " + fmtMoney(r.handling) : ""}</div>` : ""}</td>
      <td>${esc(r.supplier) || "—"}</td>
      <td>${esc(r.operator) || "—"}</td>
      <td>${r.date}</td>
      <td class="muted" style="max-width:150px;">${renderRemarkHtml(r.remark)}</td>
      <td style="white-space:nowrap;"><button class="btn sm secondary" onclick="editInbound(${r.id})">改</button> <button class="btn sm danger" onclick="deleteInbound(${r.id})">删</button></td></tr>`).join("") + `</tbody>`;
  t._rows = rows;
  t._render = loadInbounds;
  updateBatchBar("in");
}
async function deleteInbound(id) {
  if (!confirm("确认删除该入库单？将回退库存与成本。")) return;
  try { await api("/api/inbounds/" + id, "DELETE"); toast("已删除"); loadInbounds(); loadStock(); }
  catch (e) { toast("删除失败：" + e.message); }
}
/* 手动修改入库单：可改 供应商 / 入库日期 / 付款状态 / 运费 / 装卸费；保存后操作员记为修改人 */
function editInbound(id) {
  const r = ($("inTable")._rows || []).find((x) => x.id === id);
  if (!r) { toast("未找到该入库单，请刷新列表"); return; }
  openModal(`
    <h3>修改入库单 <button class="close" onclick="closeModal()">✕</button></h3>
    <div class="muted" style="margin-bottom:12px;">
      ${esc(r.code)} · ${esc(r.product_name)} ${fmtNum(r.quantity)}${esc(r.unit || "")} · 金额 ${fmtMoney(r.total_amount)}${r.adjust_amount ? `（调整 ${r.adjust_amount > 0 ? "+" : "-"}${fmtMoney(Math.abs(r.adjust_amount))}）` : ""}
    </div>
    <div class="form-grid">
      <div class="field"><label>供应商</label><input id="edInSupplier" value="${esc(r.supplier || "")}" placeholder="供应商名称" /></div>
      <div class="field"><label>入库日期 *</label><input id="edInDate" type="date" value="${esc(r.date || "")}" /></div>
      <div class="field">
        <label>运费</label>
        <input id="edInFreight" type="number" min="0" step="any" value="${r.freight || ""}" placeholder="0.00" oninput="edInCalc(${r.total_amount || 0})" />
        <div class="field-hint">选填；计入该批次成本（体现在这个品的毛利），并同步记入「其他开支」</div>
      </div>
      <div class="field">
        <label>装卸费</label>
        <input id="edInHandling" type="number" min="0" step="any" value="${r.handling || ""}" placeholder="0.00" oninput="edInCalc(${r.total_amount || 0})" />
        <div class="field-hint">选填；日期随入库单日期，清零即删掉对应的「其他开支」</div>
      </div>
      <div class="field" style="grid-column:1/-1;">
        <label>付款状态</label>
        ${payRadios("edInPay", r.pay_status, "待付款：先进「待付款账单」，点「已支付」后才计入财务报表")}
      </div>
    </div>
    <p class="hint" id="edInHint"></p>
    <p class="hint">保存后操作员记为当前登录账号（${esc(operatorName())}）。数量 / 单价 / 商品如需更正，请删除后重新入库；运费与装卸费之后随时可改（会重算该批次成本与该品毛利）。</p>
    <div class="modal-foot">
      <button class="btn secondary" onclick="closeModal()">取消</button>
      <button class="btn green" onclick="saveInboundEdit(${id})">✓ 保存</button>
    </div>`);
  edInCalc(Number(r.total_amount) || 0);
}

/** 改单时实时显示「货款 + 运费 + 装卸 = 批次到岸成本」，避免改完不知道成本变成多少 */
function edInCalc(total) {
  const el = $("edInHint");
  if (!el) return;
  const fee = (parseFloat($("edInFreight")?.value) || 0) + (parseFloat($("edInHandling")?.value) || 0);
  el.innerHTML = fee > 0
    ? `批次成本 = 货款 ${fmtMoney(total)} + 运费/装卸 ${fmtMoney(fee)} = <b>${fmtMoney(total + fee)}</b>（按 FIFO 随销量扣减，同步更新该品毛利与「其他开支」）`
    : "不填=没有运费/装卸费（对应「其他开支」里的运费、装卸费记录会一并清掉）";
}
async function saveInboundEdit(id) {
  const date = $("edInDate").value;
  if (!date) { toast("请选择入库日期"); return; }
  const freight = parseFloat($("edInFreight").value) || 0;
  const handling = parseFloat($("edInHandling").value) || 0;
  if (freight < 0 || handling < 0) { toast("运费 / 装卸费不能为负数"); return; }
  try {
    await api(`/api/inbounds/${id}`, "PUT", {
      supplier: $("edInSupplier").value, date, pay_status: payOf("edInPay"), freight, handling,
    });
    closeModal();
    toast(`已保存，操作员记为 ${operatorName()}${freight + handling > 0 ? `；运费/装卸 ${fmtMoney(freight + handling)} 已计入成本` : ""}`);
    loadInbounds();
    loadStock();   // 成本变了，库存列表的均价/货值跟着刷新
  } catch (e) { toast("保存失败：" + e.message); }
}

/* =============== 出库 =============== */
let outSaleRowId = 0;
let OUT_PREVIEW = null;  // 最近一次服务端出库预览（含先进先出结转成本），用于展示真实成本
let OUT_FEE_MANUAL = false;  // 固定费用合计是否被手动改过（改过就别让「预览结算」覆盖掉）

/* ---------- 实收金额口径：客户承担的关联结算（包材 / 人工 / 快递费） ----------
   客户的付款里含包材/工时/运费 → 勾选后计入「实收金额」（后端同样记进 settle_income 与报表收入）；
   成本侧的包材/快递照旧结转，所以毛利不会被包材吃掉。选择记在浏览器里，下一单沿用。 */
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
    if (!Array.isArray(v) || !v.length) return;   // 没记录过就保持默认（全勾）
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
  try {
    // 手动挑选的关联物品也带上：后端追加在自动带出的结算项后面，一起按 FIFO 算成本
    const r = await api("/api/outbounds/preview", "POST", {
      lines, auto_express: autoExpressOn(), extra_pack_lines: collectManualPackLines(),
      settle_cats: settleCats(),   // 实收含哪些关联结算（后端据此回 settle_income）
    });
    renderPackPreview(r);
  } catch (e) { toast("预览失败：" + e.message); }
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
    const isExpress = !!(m && m.category === "快递");
    const isManual = !!pl.manual;   // 手动挑选的关联物品（后端已按 FIFO 算好成本一起返回）
    return `<tr data-idx="${i}" data-pid="${pl.product_id}" data-unit="${esc(pl.unit)}" data-up="${pl.unit_price}"${isManual ? ' data-manual="1"' : ""}${isExpress ? ' data-express="1"' : ""}>
      <td><b>${esc(pl.product_name)}</b>${isManual ? ' <span class="badge" style="background:var(--primary-light);color:var(--primary);">手动</span>' : ""}</td>
      <td><select class="searchable pl-unit" onchange="packLineUnitChanged(this)">${m ? unitOptions(m, pl.unit) : `<option>${pl.unit}</option>`}</select></td>
      <td><input class="pl-qty" type="number" step="any" value="${pl.quantity}" oninput="packLineChanged(this)" style="width:90px;" /></td>
      <td><span class="badge pack">${isExpress ? "快递费" : (isManual && m && m.category === "人工" ? "人工" : "包装消耗")}</span></td>
      <td class="num mono">¥${fmtNum(pl.unit_price)}/${esc(pl.unit)}</td>
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
      <input id="ppSearch" placeholder="🔍 搜索商品名称 / 分类..." oninput="renderPackItemPicker()" />
      <select id="ppCat" class="searchable" onchange="renderPackItemPicker()"><option value="">全部分类</option>${cats.map((c) => `<option value="${esc(c)}">${esc(c)}</option>`).join("")}</select>
    </div>
    <div class="sp-list" id="ppList" style="max-height:52vh;overflow-y:auto;"></div>`);
  renderPackItemPicker();
}

function renderPackItemPicker() {
  const kw = ($("ppSearch")?.value || "").trim().toLowerCase();
  const cat = $("ppCat")?.value || "";
  const rows = PRODUCTS.filter((p) => p.is_active
    && (!kw || (p.name || "").toLowerCase().includes(kw) || (p.category || "").toLowerCase().includes(kw))
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
    toast("已取消「自动计快递费」，这笔出库不再计快递费");
  }
  tr.remove();
  calcOutboundTotals();
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
  const finalAmount = amount + settleIn + adjust;           // 实收金额（差额记「金额调整」其他开支）
  $("otAmount").textContent = fmtMoney(amount);
  if ($("otFinal")) {
    $("otFinal").innerHTML = fmtMoney(finalAmount) + (settleIn
      ? `<div class="muted" style="font-size:11px;">含${esc(settleCatsLabel(settleCats()))} ${fmtMoney(settleIn)}</div>` : "");
  }
  $("otCogs").textContent = fmtMoney(cogs);
  $("otGross").textContent = fmtMoney(amount + settleIn - cogs);
  // 净利按实收口径：抹零/凑整的差额已计入其他开支，这里同步扣掉，与报表口径一致
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
  if ($("outAdjust")) $("outAdjust").value = "";
  if ($("outFeeHint")) $("outFeeHint").textContent = "";
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
      pay_status: payStatus, adjust_amount: adjust,
      settle_cats: settleCats(),       // 实收含哪些关联结算（客户随货款付回来的包材/人工/运费）
    });
    const warns = (r.warnings || []).length ? "\n⚠ " + r.warnings.join("；") : "";
    const settleTip = settleIn ? `（实收含${settleCatsLabel(settleCats())} ${fmtMoney(settleIn)}）` : "";
    toast("出库成功" + (adjust ? `（调整 ${adjust > 0 ? "+" : "-"}${Math.abs(adjust).toFixed(2)}，已记其他开支）` : "") + settleTip + (payStatus === "unpaid" ? "（待付款，已进待付款账单）" : "") + warns, 3800);
    $("outSaleBody").innerHTML = ""; outSaleRowId = 0; addSaleRow();
    clearPreview();
    $("outCustomer").value = "";
    clearRemarkField("outRemark");
    setPay("outPay", "paid");
    if ($("outAutoExpress")) $("outAutoExpress").checked = true;   // 复位：下一笔仍默认自动计快递费
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
      <td class="mono">${o.code}${payTag(o.pay_status)}${o.has_dropship ? ' <span class="badge income">含代发</span>' : ""}</td>
      <td>${esc(o.customer) || "—"}</td>
      <td><button class="detail-toggle" onclick="toggleOutDetail(${o.id})">▸ 查看明细</button></td>
      <td class="num mono">${fmtMoney(o.final_amount != null ? o.final_amount : o.total_amount)}${o.adjust_amount ? `<div class="muted" style="font-size:11px;">调整 ${o.adjust_amount > 0 ? "+" : "-"}${fmtMoney(Math.abs(o.adjust_amount))}</div>` : ""}${o.settle_income ? `<div class="muted" style="font-size:11px;" title="客户随货款一起付的关联结算（${esc(settleCatsLabel(o.settle_cats))}）：成本里已含包材/快递，这里是客户付回来的那部分">含代收 ${fmtMoney(o.settle_income)}</div>` : ""}</td>
      <td class="num mono">${fmtMoney(o.total_cogs)}${o.brush_adjust ? `<div class="muted" style="font-size:11px;">刷单 ${fmtMoney(o.brush_adjust)}</div>` : ""}</td>
      <td class="num mono">${fmtMoney(o.total_fee)}</td>
      <td class="num mono" style="color:${o.net_profit >= 0 ? "var(--green)" : "var(--red)"}">${fmtMoney(o.net_profit)}</td>
      <td>${o.date}</td>
      <td class="muted" style="max-width:140px;">${renderRemarkHtml(o.remark)}</td>
      <td style="white-space:nowrap;"><button class="btn sm secondary" onclick="editOutbound(${o.id})">改</button> <button class="btn sm danger" onclick="deleteOutbound(${o.id})">删</button></td></tr>
      <tr id="od-${o.id}" style="display:none;"><td colspan="11"><div class="subtable"><table>` +
      o.lines.map((l) => `<tr>
        <td>${esc(l.product_name)}${l.is_dropship ? ' <span class="badge income">代发</span>' : ""}${l.spec ? `<div class="muted" style="font-size:11px;">规格 ${esc(l.spec)}</div>` : ""}</td>
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
  if (!(r.is_dropship || oldPack || express || labor || material || other || brush)) return "";
  const parts = [`${r.is_dropship ? "代发成本" : "商品成本"} ${fmtMoney(goods)}`];
  if (split) {
    if (labor) parts.push(`打包人工 ${fmtMoney(labor)}`);
    if (material) parts.push(`耗材 ${fmtMoney(material)}`);
    if (other) parts.push(`其他关联结算 ${fmtMoney(other)}`);
  } else if (oldPack) {
    parts.push(`打包人工+耗材 ${fmtMoney(oldPack)}`);
  }
  if (express) parts.push(`快递费 ${fmtMoney(express)}`);
  if (brush) parts.push(`刷单成本 ${fmtMoney(brush)}`);
  return parts.join(" ＋ ");
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
  const kw = ($("ogSearch")?.value || "").trim().toLowerCase();
  const t = $("ogTable");
  // 销售商品可额外按出库方式筛：输入「代发」/「库存」即可筛出对应商品
  const kwHit = (a, extra = "") => !kw || `${a.name} ${extra}`.toLowerCase().includes(kw);
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
      a.brush_cogs = a.brush_cogs || 0;      // 芳谊放单仓刷单结算（刷单成本 + 固定费覆盖差）
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
      if (o.brush_adjust && saleLines.length) {
        for (const sl of saleLines) {
          const share = totalAmt ? (sl.amount || 0) / totalAmt : 1 / saleLines.length;
          spread(sl.product_id, (o.brush_adjust || 0) * share, "brush_cogs");
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
    // 芳谊放单仓刷单结算（刷单成本 + 固定费覆盖差）：净利里已扣掉，单独列出便于核对
    brush: rows.reduce((s, o) => s + (o.brush_adjust || 0), 0),
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
     ${total.brush ? `<div class="stat"><div class="label">刷单成本</div><div class="value" style="color:var(--red)">${fmtMoney(total.brush)}</div></div>` : ""}
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
    <div class="muted" style="margin-bottom:10px;">批次 ${esc(groupKey)} · 共 ${recs.length} 单（只能改 客户 / 出库日期 / 付款状态）</div>
    <div style="max-height:50vh;overflow:auto;">
      <table class="table"><thead><tr><th>单号</th><th>客户</th><th class="num">金额</th><th>日期</th><th></th></tr></thead><tbody>
      ${recs.map((o) => `<tr>
        <td class="mono">${esc(o.code)}${payTag(o.pay_status)}</td>
        <td>${esc(o.customer) || "—"}</td>
        <td class="num mono">${fmtMoney(o.final_amount != null ? o.final_amount : o.total_amount)}</td>
        <td>${esc(o.date)}</td>
        <td><button class="btn sm secondary" onclick="editOutbound(${o.id})">改</button></td>
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
/* 报表两级视图：全仓总览（所有分仓合计）/ 单仓总览（默认当前分仓，可切换查看其他分仓） */
/* =============== 报表口径：排除其他开支（默认开启） ===============
   开启后财务报表不计入「其他开支」（经营分析 → 其他开支）的款项，只看商品售卖利润。
   偏好存在本机，web 端与 PWA 端共用同一个 localStorage key。 */
const EXCLUDE_OTHER_KEY = "erp_exclude_other_expense";
let EXCLUDE_OTHER = localStorage.getItem(EXCLUDE_OTHER_KEY) !== "0";   // 无记录时默认开启

/** 报表请求附加的口径参数（前后端都默认含其他开支，所以这里总是显式声明） */
const excludeOtherQs = () => (EXCLUDE_OTHER ? "&exclude_other=1" : "&exclude_other=0");

/** 把本机偏好回显到报表页的口径开关（初始化时调用） */
function syncExcludeOtherHint() {
  const chk = $("excludeOtherChk");
  if (chk) chk.checked = EXCLUDE_OTHER;
}

/** 报表页口径开关：切换后持久化，并立即按新口径重算 */
function toggleExcludeOther(chk) {
  EXCLUDE_OTHER = !!chk.checked;
  localStorage.setItem(EXCLUDE_OTHER_KEY, EXCLUDE_OTHER ? "1" : "0");
  syncExcludeOtherHint();
  toast(EXCLUDE_OTHER ? "已排除其他开支：只看商品售卖利润" : "已计入其他开支：含全部期间费用");
  loadReport();
}

let REP_SCOPE = "one";   // all 全仓总览 / one 单仓总览
let REP_WH = "";         // 单仓总览查看的分仓 key；"" = 当前分仓
let repWhLoaded = false;

/** 填充「查看分仓」下拉（默认选中当前分仓） */
async function repEnsureWhOptions() {
  if (repWhLoaded) return;
  const sel = $("repWhSel");
  if (!sel) return;
  try {
    const d = await api("/api/warehouses");
    const list = d.warehouses || [];
    REP_WH = REP_WH || d.current || "";
    sel.innerHTML = list.map((w) =>
      `<option value="${esc(w.key)}"${w.key === REP_WH ? " selected" : ""}>${esc(w.name)}${w.is_current ? "（当前分仓）" : ""}</option>`
    ).join("");
    repWhLoaded = true;
  } catch (e) { /* 拿不到分仓列表时按"当前分仓"看，不影响报表 */ }
}

/** 顶层切换：全仓总览 / 单仓总览
 *  四个分区 tab（汇总/支出/商品/流水）两种视角都用：数据源由请求的 wh 决定
 *  （全仓 = wh=all，后端把各分仓独立账套的结果合并）。 */
function repScope(btn) {
  btn.closest(".seg").querySelectorAll(".seg-item").forEach((x) => x.classList.toggle("active", x === btn));
  REP_SCOPE = btn.dataset.scope === "all" ? "all" : "one";
  applyRepScopeUi();
  loadReport();
}
function applyRepScopeUi() {
  const all = REP_SCOPE === "all";
  $("repWhBar").style.display = all ? "none" : "";       // 全仓总览不需要选分仓
  $("rep-panel-all").style.display = all ? "" : "none";  // 各分仓明细表只在全仓总览的「汇总」里出现
  $("repAllStats").style.display = "none";               // 全仓统计卡统一用「汇总」里的 repStats（带「全仓」前缀），避免两套重复
}

function repWhChange() {
  REP_WH = $("repWhSel").value || "";
  loadReport();
}

/** 从全仓总览点某分仓 → 回到单仓总览看它的明细 */
function repViewWarehouse(key) {
  REP_WH = key || "";
  const sel = $("repWhSel");
  if (sel) sel.value = REP_WH;
  const btn = document.querySelector('#repScopeSeg .seg-item[data-scope="one"]');
  if (btn) repScope(btn);
  else loadReport();
}

/** 全仓总览：各分仓收入 / 支出 / 利润 */
async function loadAllWarehouses(from, to) {
  const t = $("repAllTable");
  try {
    const d = await api(`/api/report/all-warehouses?date_from=${from || ""}&date_to=${to || ""}${excludeOtherQs()}`);
    const items = d.items || [];
    const tot = d.total || {};
    const rate = (v, base) => (base ? ((v / base) * 100).toFixed(1) + "%" : "—");
    $("repAllStats").innerHTML = `
      <div class="stat blue"><div class="label">全仓销售收入</div><div class="value">${fmtMoney(tot.revenue)}</div><div class="sub">${tot.orders || 0} 单 · ${tot.warehouse_count || 0} 个分仓</div></div>
      <div class="stat amber"><div class="label">全仓结转成本</div><div class="value">${fmtMoney(tot.cogs)}</div><div class="sub">全仓毛利 ${fmtMoney(tot.gross)}（${rate(tot.gross, tot.revenue)}）</div></div>
      <div class="stat red"><div class="label">全仓支出</div><div class="value">${fmtMoney(tot.total_expense)}</div><div class="sub">采购 ${fmtMoney(tot.purchase)} ＋ 期间费用 ${fmtMoney(tot.expense)}</div></div>
      <div class="stat ${(tot.net_profit || 0) >= 0 ? "green" : "red"}"><div class="label">全仓净利润</div><div class="value">${fmtMoney(tot.net_profit)}</div><div class="sub">净利率 ${rate(tot.net_profit, tot.revenue)}</div></div>
      <div class="stat"><div class="label">全仓库存总值</div><div class="value">${fmtMoney(tot.stock_value)}</div><div class="sub">本期进货 ${fmtMoney(tot.purchase)}</div></div>`;
    const pend = tot.pending || {};
    $("repAllHint").textContent = `共 ${items.length} 个分仓 · 每个分仓独立账套，只统计「已付款」单据`
      + ((pend.payables_amount || pend.receivables_amount)
        ? `；另有 ${pend.payables_count || 0} 笔待付款 ${fmtMoney(pend.payables_amount)} / ${pend.receivables_count || 0} 笔待收款 ${fmtMoney(pend.receivables_amount)} 未计入`
        : "");
    const warn = $("repAllWarn");
    const bad = items.filter((x) => x.error);
    if (warn) {
      warn.style.display = bad.length ? "block" : "none";
      warn.textContent = bad.map((x) => `${x.name}：${x.error}`).join("；");
    }
    const rows = items.filter((x) => !x.error);
    const totalRow = `<tr>
      <td><b>全仓合计</b></td>
      <td class="num mono"><b>${fmtMoney(tot.revenue)}</b></td>
      <td class="num mono"><b>${fmtMoney(tot.cogs)}</b></td>
      <td class="num mono"><b>${fmtMoney(tot.gross)}</b></td>
      <td class="num mono">${rate(tot.gross, tot.revenue)}</td>
      <td class="num mono"><b>${fmtMoney(tot.expense)}</b></td>
      <td class="num mono"><b>${fmtMoney(tot.purchase)}</b></td>
      <td class="num mono" style="color:${(tot.net_profit || 0) >= 0 ? "var(--green)" : "var(--red)"}"><b>${fmtMoney(tot.net_profit)}</b></td>
      <td class="num mono">${tot.orders || 0}</td>
      <td class="num mono">${fmtMoney(tot.stock_value)}</td>
      <td></td></tr>`;
    t.innerHTML = `<thead><tr>
        <th>分仓</th>
        <th class="num">销售收入</th><th class="num">结转成本</th><th class="num">毛利</th><th class="num">毛利率</th>
        <th class="num">期间费用</th><th class="num">本期进货</th><th class="num">净利润</th>
        <th class="num">订单数</th><th class="num">库存总值</th><th></th>
      </tr></thead><tbody>` +
      (rows.length
        ? rows.map((w) => {
          const cur = w.key === d.current;
          const p = w.pending || {};
          const pendTip = (p.payables_amount || p.receivables_amount)
            ? `<div class="muted" style="font-size:11px;">待付款 ${fmtMoney(p.payables_amount)} · 待收款 ${fmtMoney(p.receivables_amount)}（未计入）</div>`
            : "";
          return `<tr${cur ? ' style="background:var(--primary-50,#eff6ff);"' : ""}>
            <td><b>${esc(w.name)}</b>${cur ? ' <span class="badge" style="background:var(--primary,#2563eb);color:#fff;">当前</span>' : ""}${pendTip}</td>
            <td class="num mono">${fmtMoney(w.revenue)}</td>
            <td class="num mono">${fmtMoney(w.cogs)}</td>
            <td class="num mono">${fmtMoney(w.gross)}</td>
            <td class="num mono">${rate(w.gross, w.revenue)}</td>
            <td class="num mono">${fmtMoney(w.expense)}</td>
            <td class="num mono">${fmtMoney(w.purchase)}</td>
            <td class="num mono" style="color:${(w.net_profit || 0) >= 0 ? "var(--green)" : "var(--red)"}"><b>${fmtMoney(w.net_profit)}</b></td>
            <td class="num mono">${w.orders || 0}</td>
            <td class="num mono">${fmtMoney(w.stock_value)}</td>
            <td><button class="btn sm secondary" onclick="repViewWarehouse('${esc(w.key)}')">看单仓明细</button></td></tr>`;
        }).join("")
        : `<tr><td colspan="11" class="empty">暂无分仓数据</td></tr>`) +
      `</tbody>` + (rows.length ? `<tfoot>${totalRow}</tfoot>` : "");
  } catch (e) {
    t.innerHTML = `<tbody><tr><td class="empty">加载失败：${esc(e.message)}</td></tr></tbody>`;
  }
}

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
    await repEnsureWhOptions();
  }
  const from = $("repDateFrom").value, to = $("repDateTo").value;
  const all = REP_SCOPE === "all";
  // 全仓总览：wh=all 让后端把各分仓（各自独立账套）的结果合并；单仓总览：可切换查看指定分仓
  const whQs = all ? "&wh=all" : (REP_WH ? `&wh=${encodeURIComponent(REP_WH)}` : "");
  let rep, finance;
  try {
    [rep, finance] = await Promise.all([
      api(`/api/report/summary?date_from=${from || ""}&date_to=${to || ""}${whQs}${excludeOtherQs()}`),
      api(`/api/finance?date_from=${from || ""}&date_to=${to || ""}${whQs}`),
    ]);
  } catch (e) {
    toast("加载报表失败：" + e.message);
    return;
  }
  const rh = $("repRangeHint");
  if (rh) {
    // 口径：明确「其他开支」算没算进来，避免和「其他开支」页的数字对不上
    const caliber = rep.exclude_other_expense
      ? `已排除其他开支 ${fmtMoney(rep.excluded_other_expense)}`
      : `含其他开支 ${fmtMoney(rep.excluded_other_expense)}`;
    rh.textContent = `统计区间 ${from || "最早"} ~ ${to || "最新"}`
      + (all
        ? ` · 全仓合计${rep.warehouse_count ? `（${rep.warehouse_count} 个分仓）` : ""}`
        : (rep.warehouse ? ` · ${rep.warehouse.name}${rep.is_current ? "（当前分仓）" : ""}` : ""))
      + ` · ${caliber}`;
  }
  if (!all) {
    const whHint = $("repWhHint");
    if (whHint) {
      whHint.textContent = rep.warehouse && !rep.is_current
        ? `正在查看「${rep.warehouse.name}」的数据（仅查看，不会改变你的工作分仓）`
        : "默认是你当前所在分仓；换一个只是换看谁的数据，不会改变你的工作分仓";
    }
  }
  const packTotal = rep.pack_cost_total || 0;
  const pre = all ? "全仓" : "";   // 全仓总览给统计卡加前缀，避免和单仓混淆
  $("repStats").innerHTML = `
    <div class="stat blue"><div class="label">${pre}销售收入</div><div class="value">${fmtMoney(rep.revenue)}</div><div class="sub">${rep.order_count} 单${all ? ` · ${rep.warehouse_count || 0} 个分仓` : ""}</div></div>
    <div class="stat amber"><div class="label">${pre}结转成本</div><div class="value">${fmtMoney(rep.cogs)}</div><div class="sub">含关联结算 ${fmtMoney(packTotal)}</div></div>
    ${rep.brush_cost ? `<div class="stat red"><div class="label">${pre}刷单成本</div><div class="value">${fmtMoney(rep.brush_cost)}</div><div class="sub">芳谊放单仓 · 已从毛利扣减</div></div>` : ""}
    <div class="stat green"><div class="label">${pre}毛利</div><div class="value">${fmtMoney(rep.gross_profit)}</div><div class="sub">${rep.revenue ? ((rep.gross_profit / rep.revenue) * 100).toFixed(1) + "%" : "—"}</div></div>
    <div class="stat red"><div class="label">${pre}期间费用</div><div class="value">${fmtMoney(rep.expense)}</div><div class="sub">其他开支 ${fmtMoney(rep.other_expense)} · 手工记账 ${fmtMoney(rep.manual_expense)}</div></div>
    <div class="stat ${rep.net_profit >= 0 ? "green" : "red"}"><div class="label">${pre}净利润</div><div class="value">${fmtMoney(rep.net_profit)}</div></div>
    <div class="stat"><div class="label">${pre}本期进货</div><div class="value">${fmtMoney(rep.purchase)}</div></div>
    <div class="stat red"><div class="label">${pre}本期总支出</div><div class="value">${fmtMoney(rep.total_expense)}</div><div class="sub">含采购 ${fmtMoney(rep.purchase)} · 期间费用 ${fmtMoney(rep.expense)}</div></div>
    <div class="stat blue"><div class="label">${pre}当前库存总值</div><div class="value">${fmtMoney(rep.stock_value)}</div></div>`;

  renderCostBreakdown(rep);
  renderExpenseSummary(rep);
  renderFeeBreakdown(rep);
  renderExpenseTables(rep);
  renderExpenseItems(rep);

  // 商品销售明细：先缓存原始行，再由 renderReportGoods() 按「商品名称筛选」渲染（输入即过滤）
  REP_PROD_ROWS = rep.by_product || [];
  renderReportGoods();
  renderSalesBySpec(from, to, whQs);   // 出库明细：每天 × 每种规格卖了多少单（含代发数量/代发成本）

  const ft = $("financeTable");
  let finRows = finance;
  const fkw = ($("repSearch")?.value || "").trim().toLowerCase();
  if (fkw) finRows = finRows.filter((f) => [f.category, f.product_name, f.remark, f.operator, f.type, f.warehouse].join(" ").toLowerCase().includes(fkw));
  finRows = applyTableSort(ft, finRows);
  const finWh = !!rep.is_all;   // 全仓总览：流水来自多个分仓，需要标出来源
  ft.innerHTML = `<thead><tr>
    ${finWh ? "<th>分仓</th>" : ""}
    <th>类型</th>
    <th data-key="category">分类${sortArrow("financeTable", "category")}</th>
    <th data-key="product_name">商品${sortArrow("financeTable", "product_name")}</th>
    <th data-key="amount" class="num">金额${sortArrow("financeTable", "amount")}</th>
    <th data-key="operator">操作员${sortArrow("financeTable", "operator")}</th>
    <th data-key="date">日期${sortArrow("financeTable", "date")}</th>
    <th>备注</th><th></th></tr></thead><tbody>` +
    finRows.map((f) => `<tr>
      ${finWh ? `<td>${esc(f.warehouse) || "—"}</td>` : ""}
      <td>${f.type === "income" ? '<span class="badge income">收入</span>' : '<span class="badge expense">支出</span>'}</td>
      <td>${esc(f.category)}</td>
      <td>${esc(f.product_name) || "—"}</td>
      <td class="num mono" style="color:${f.type === "income" ? "var(--green)" : "var(--red)"}">${f.type === "income" ? "+" : "-"}${fmtMoney(f.amount)}</td>
      <td>${esc(f.operator) || "—"}</td><td>${f.date}</td>
      <td class="muted">${esc(f.remark)}</td>
      <td>${f.ref_type === "manual" ? `<button class="btn sm danger" onclick="deleteFinance(${f.id})">删</button>` : ""}</td></tr>`).join("") + `</tbody>`;
  if (!finRows.length) ft.innerHTML = `<tr><td colspan="${finWh ? 9 : 8}" class="empty">本期无财务流水</td></tr>`;
  ft._rows = finRows;
  ft._render = loadReport;

  // 全仓总览：额外加载「各分仓收入 / 支出 / 利润」明细表（汇总分区里）
  if (all) await loadAllWarehouses(from, to);
}

/* 销售成本构成：商品成本 vs 出库自动结算的包材/人工/快递 */
function renderCostBreakdown(rep) {
  const box = $("repCostBreak");
  if (!box) return;
  const cogs = rep.cogs || 0;
  const packs = rep.pack_costs || {};
  const packTotal = rep.pack_cost_total || 0;
  const goods = rep.goods_cogs != null ? rep.goods_cogs : cogs - packTotal;
  // 芳谊放单仓刷单结算：不在 cogs 里（cogs 仍是商品/包材/快递的结转成本），单独一项展示并计入合计口径
  const brush = rep.brush_cost || 0;
  const total = cogs + brush;
  const hint = $("repCostHint");
  if (hint) hint.textContent = total ? `合计 ${fmtMoney(total)}${brush ? `（含刷单 ${fmtMoney(brush)}）` : ""}` : "";

  if (!total) {
    box.innerHTML = `<div class="empty">本期无销售成本</div>`;
    return;
  }
  const pctOf = (v) => (total ? (v / total) * 100 : 0);
  const COLORS = { "包材耗材": "#ff976a", "人工打包费": "#7232dd", "快递运费": "#07c160", "其他关联结算": "#969799", "刷单成本": "#ee0a24" };
  const rows = [
    { name: "商品成本", value: goods, color: "#1989fa", tag: "" },
    ...Object.entries(packs)
      .sort((a, b) => b[1] - a[1])
      .map(([k, v]) => ({ name: k, value: v, color: COLORS[k] || "#969799", tag: "自动结算" })),
    ...(brush ? [{ name: "刷单成本", value: brush, color: COLORS["刷单成本"], tag: "放单仓" }] : []),
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
        <td class="muted">${r.name === "刷单成本"
          ? "芳谊放单仓：导入确认时按单填写的刷单成本（+ 快递包装固定费覆盖差），已从毛利扣减"
          : r.tag ? "出库时按包装清单自动结算，已计入结转成本" : "销售商品本身的先进先出成本"}</td>
      </tr>`).join("")}</tbody>
      <tfoot><tr>
        <td><b>成本合计</b></td>
        <td class="num mono"><b>${fmtMoney(total)}</b></td>
        <td class="num mono">100%</td>
        <td class="muted">关联结算 ${fmtMoney(packTotal)}${brush ? ` · 刷单 ${fmtMoney(brush)}` : ""}</td>
      </tr></tfoot>
    </table></div>
    ${packTotal ? "" : `<div class="alert warn" style="margin-top:10px;">本期没有包材 / 人工 / 快递等关联结算成本。若商品已配置包装清单，请确认出库时是否生成了关联结算行。</div>`}`;
}
/* 商品销售明细表：带「商品名称筛选」（与移动端财务报表同一套口径——名称 / 规格任一包含关键词即命中）。
   输入即过滤、点表头排序都只重渲染这张表，不再请求后端；筛选词在重新查询后保留。 */
let REP_PROD_ROWS = null;   // 最近一次报表的商品明细原始行（未筛选、未排序）
function renderReportGoods() {
  const pt = $("repProductTable");
  if (!pt) return;
  const all = REP_PROD_ROWS || [];
  const kwEl = $("repGoodsKw");
  const kw = ((kwEl && kwEl.value) || "").trim();
  const k = kw.toLowerCase();
  const hit = k ? all.filter((p) => `${p.name || ""} ${p.spec || ""}`.toLowerCase().includes(k)) : all;
  const prodRows = applyTableSort(pt, hit);
  const hint = $("repGoodsHint");
  if (hint) hint.textContent = all.length ? (k ? `匹配 ${prodRows.length} / ${all.length} 个商品` : `共 ${all.length} 个商品`) : "";
  // 成本为「总成本」= 商品成本 + 打包人工/耗材 + 快递费（后端 by_product 已按销售商品归属；
  // 无归属的快递费等按该单销售金额占比分摊）。收入含客户代收的关联结算 settle_income，
  // 毛利率分母用 扣点前销售金额 + 代收（与后端 gp_rate 同口径）。
  const settleOf = (p) => Number(p.settle_income) || 0;
  const gpRateOf = (p) => {
    const settle = settleOf(p);
    const denom = (Number(p.gross_sales) || Number(p.amount) || 0) + settle;
    if (!denom) return "—";
    if (p.gp_rate != null) return Number(p.gp_rate).toFixed(1) + "%";
    const total = Number(p.total_cogs != null ? p.total_cogs : p.cogs) || 0;
    const rate = ((Number(p.amount) + settle - total) / denom) * 100;
    return rate.toFixed(1) + "%";
  };
  if (!prodRows.length) {
    pt.innerHTML = `<tr><td class="empty" colspan="8">${all.length ? `没有匹配「${esc(kw)}」的商品，换个关键词试试` : "本期无销售"}</td></tr>`;
    pt._rows = [];
    pt._render = renderReportGoods;
    return;
  }
  const sum = prodRows.reduce((a, p) => {
    a.qty += Number(p.qty) || 0;
    a.amount += Number(p.amount) || 0;
    a.settle += settleOf(p);
    a.cogs += Number(p.total_cogs != null ? p.total_cogs : p.cogs) || 0;
    return a;
  }, { qty: 0, amount: 0, settle: 0, cogs: 0 });
  const sumGp = sum.amount + sum.settle - sum.cogs;
  const sumColor = sumGp >= 0 ? "var(--green)" : "var(--red)";
  pt.innerHTML = `<thead><tr>
    <th data-key="name">商品${sortArrow("repProductTable", "name")}</th>
    <th data-key="spec">规格${sortArrow("repProductTable", "spec")}</th>
    <th data-key="is_dropship">出库方式${sortArrow("repProductTable", "is_dropship")}</th>
    <th data-key="qty" class="num">销量${sortArrow("repProductTable", "qty")}</th>
    <th data-key="amount" class="num">收入${sortArrow("repProductTable", "amount")}</th>
    <th data-key="cogs" class="num">总成本${sortArrow("repProductTable", "cogs")}</th>
    <th data-key="gross" class="num">毛利${sortArrow("repProductTable", "gross")}</th>
    <th class="num">毛利率</th></tr></thead><tbody>` +
    prodRows.map((p) => {
      const total = Number(p.total_cogs != null ? p.total_cogs : p.cogs) || 0;
      const settle = settleOf(p);   // 客户代收的关联结算（包材/人工/快递费）：成本里含它，收入也要含
      const gp = (Number(p.amount) || 0) + settle - total;
      const color = gp >= 0 ? "var(--green)" : "var(--red)";
      // 成本构成：代发行也要列出来（代发成本/商品成本 ＋ 打包人工 ＋ 耗材 ＋ 其他关联结算 ＋ 快递费）
      const splitText = costSplitText(p);
      const split = splitText ? `<div class="muted" style="font-size:11px;">${splitText}</div>` : "";
      // 出库方式：代发（别人发货，不扣本仓库存）单独标出，不和库存商品混在一起
      const way = p.is_dropship
        ? '<span class="badge income">代发</span>'
        : '<span class="badge adjust">库存出库</span>';
      return `<tr>
      <td>${esc(p.name)}${split}</td>
      <td class="muted">${esc(p.spec) || "—"}</td>
      <td>${way}</td>
      <td class="num mono">${fmtNum(p.qty)}</td>
      <td class="num mono">${fmtMoney((Number(p.amount) || 0) + settle)}${settle ? `<div class="muted" style="font-size:11px;" title="客户随货款一起付的包材/人工/快递费（成本里已含，收入侧也计一笔）">含代收 ${fmtMoney(settle)}</div>` : ""}</td>
      <td class="num mono">${fmtMoney(total)}</td>
      <td class="num mono" style="color:${color}">${fmtMoney(gp)}</td>
      <td class="num mono" style="color:${color}">${gpRateOf(p)}</td></tr>`;
    }).join("") + `</tbody>
    <tfoot><tr>
      <td><b>${k ? "筛选合计" : "本期合计"}</b> <span class="muted">${prodRows.length} 个商品</span></td>
      <td></td><td></td>
      <td class="num mono"><b>${fmtNum(sum.qty)}</b></td>
      <td class="num mono"><b>${fmtMoney(sum.amount + sum.settle)}</b>${sum.settle ? `<div class="muted" style="font-size:11px;">含代收 ${fmtMoney(sum.settle)}</div>` : ""}</td>
      <td class="num mono"><b>${fmtMoney(sum.cogs)}</b></td>
      <td class="num mono" style="color:${sumColor}"><b>${fmtMoney(sumGp)}</b></td>
      <td class="num mono" style="color:${sumColor}"><b>${sum.amount + sum.settle ? ((sumGp / (sum.amount + sum.settle)) * 100).toFixed(1) + "%" : "—"}</b></td>
    </tr></tfoot>`;
  pt._rows = prodRows;
  pt._render = renderReportGoods;   // 点表头排序 / 再输入关键词都只重渲染这张表
}
/** 清空商品名称筛选 */
function clearRepGoodsKw() {
  const el = $("repGoodsKw");
  if (el) el.value = "";
  renderReportGoods();
}

/** 出库明细：每天 × 每种规格卖了多少单（含代发行的代发数量/代发成本） */
async function renderSalesBySpec(from, to, whQs) {
  const t = $("repSpecTable");
  if (!t) return;
  try {
    const d = await api(`/api/report/sales-by-spec?date_from=${from || ""}&date_to=${to || ""}${whQs || ""}`);
    const specs = d.specs || [];
    const rows = d.rows || [];
    const tot = d.totals || {};
    const hint = $("repSpecHint");
    if (hint) {
      const drop = (tot.dropship_qty || tot.dropship_cogs)
        ? ` · 其中代发 ${fmtNum(tot.dropship_qty)} / 代发成本 ${fmtMoney(tot.dropship_cogs)}`
        : "";
      hint.textContent = `共 ${tot.days || 0} 天 · ${tot.orders || 0} 单 · ${specs.length} 种规格${drop}`
        + " · 含全部出库单（不区分是否已收款）";
    }
    if (!rows.length) {
      t.innerHTML = `<tr><td class="empty">本期无出库</td></tr>`;
      return;
    }
    const cellTd = (c) => (c
      ? `<td class="num mono">${c.orders} 单<div class="muted" style="font-size:11px;">${fmtNum(c.qty)}${esc(c.unit)}${c.dropship_qty ? ` · 代发${fmtNum(c.dropship_qty)}` : ""}</div></td>`
      : `<td class="num mono">—</td>`);
    t.innerHTML = `<thead><tr><th>日期</th>` +
      specs.map((s) => `<th class="num">${esc(s.name)}${s.dropship_qty ? ' <span class="badge income">代发</span>' : ""}<div class="muted" style="font-size:11px;font-weight:400;">${s.orders} 单 · ${fmtNum(s.qty)}${esc(s.unit)}${s.dropship_qty ? ` · 代发${fmtNum(s.dropship_qty)}` : ""}</div></th>`).join("") +
      `<th class="num">当天单数</th><th class="num">当天数量</th><th class="num">当天金额</th><th class="num">代发数量</th><th class="num">代发成本</th></tr></thead><tbody>` +
      rows.map((r) => `<tr><td class="mono">${esc(r.date)}</td>` +
        specs.map((s) => cellTd(r.cells[s.name])).join("") +
        `<td class="num mono"><b>${r.orders}</b></td><td class="num mono">${fmtNum(r.qty)}</td><td class="num mono">${fmtMoney(r.amount)}</td>
         <td class="num mono" style="color:var(--danger)">${r.dropship_qty ? fmtNum(r.dropship_qty) : "—"}</td>
         <td class="num mono" style="color:var(--danger)">${r.dropship_cogs ? fmtMoney(r.dropship_cogs) : "—"}</td></tr>`).join("") +
      `</tbody><tfoot><tr><td><b>合计</b></td>` +
      specs.map((s) => `<td class="num mono"><b>${s.orders} 单</b><div class="muted" style="font-size:11px;font-weight:400;">${fmtNum(s.qty)}${esc(s.unit)}</div></td>`).join("") +
      `<td class="num mono"><b>${tot.orders || 0}</b></td><td class="num mono"><b>${fmtNum(tot.qty)}</b></td><td class="num mono"><b>${fmtMoney(tot.amount)}</b></td>
       <td class="num mono"><b>${tot.dropship_qty ? fmtNum(tot.dropship_qty) : "—"}</b></td>
       <td class="num mono"><b>${tot.dropship_cogs ? fmtMoney(tot.dropship_cogs) : "—"}</b></td></tr></tfoot>`;
  } catch (e) {
    t.innerHTML = `<tr><td class="empty">加载失败：${esc(e.message)}</td></tr>`;
  }
}

/* 报表分区 tab：汇总 / 支出 / 商品 / 流水（日期条件常驻，作用于所有分区） */
const REP_PANELS = ["rep-panel-summary", "rep-panel-expense", "rep-panel-goods", "rep-panel-flow"];
function repTab(btn) {
  btn.closest(".seg").querySelectorAll(".seg-item").forEach((x) => x.classList.toggle("active", x === btn));
  const p = btn.dataset.panel;
  REP_PANELS.forEach((id) => { const el = $(id); if (el) el.style.display = id === p ? "" : "none"; });
}
/* 支出下钻（二级页面）：点「按日/按月」表里的日期或金额，展开该时段该来源的逐笔构成。
   数据直接用当前区间已加载的 REP_EXP_ITEMS，不再请求接口；key 为空表示整个查询区间（合计行）。 */
const REP_DRILL_SRC = { purchase: "采购", other: "其他开支", manual: "手工记账" };
const REP_SRC_TABS = [["", "全部来源"], ["采购", "采购（进货）"], ["其他开支", "其他开支"], ["手工记账", "手工记账"]];
let REP_DRILL = null;

function openExpDrill(key, kind) {
  key = key || "";
  const keyName = /^\d{4}-\d{2}$/.test(key) ? "month" : "date";
  const items = REP_EXP_ITEMS.filter((r) => {
    if (!key) return true;   // 合计行：整个查询区间
    const v = keyName === "month" ? (r.date || "").slice(0, 7) : r.date;
    return v === key;
  });
  REP_DRILL = { key, keyName, source: REP_DRILL_SRC[kind] || "", items };
  renderExpDrill();
}

function repDrillSource(src) {
  if (!REP_DRILL) return;
  REP_DRILL.source = src;
  renderExpDrill();
}

function renderExpDrill() {
  const d = REP_DRILL;
  if (!d) return;
  const title = d.key ? `${d.key}${d.keyName === "month" ? "（整月）" : ""} 支出明细` : "本期（查询区间）支出明细";
  const rows = d.source ? d.items.filter((r) => r.source === d.source) : d.items;
  const sum = rows.reduce((a, r) => a + (r.amount || 0), 0);
  const withWh = rows.some((r) => r.warehouse);   // 全仓总览：标出来源分仓
  const chips = REP_SRC_TABS
    .map(([v, label]) => `<button class="btn sm ${d.source === v ? "" : "secondary"}" onclick="repDrillSource('${v}')">${label}</button>`)
    .join("");
  const body = rows.length
    ? rows.map((r) => `<tr>
        ${withWh ? `<td>${esc(r.warehouse) || "—"}</td>` : ""}
        <td class="mono">${esc(r.date)}</td>
        <td><span class="cost-dot" style="background:${REP_EXP_SRC_COLORS[r.source] || "var(--muted)"};"></span>${esc(r.source)}${r.auto ? '<span class="muted"> 自动</span>' : ""}</td>
        <td>${esc(r.item || r.category)}${r.ref ? ` <span class="muted">${esc(r.ref)}</span>` : ""}</td>
        <td class="num mono"><b>${fmtMoney(r.amount)}</b></td>
        <td>${esc(r.operator) || "—"}</td>
        <td class="muted" style="max-width:260px;">${renderRemarkHtml(r.remark)}</td></tr>`).join("")
    : `<tr><td colspan="${withWh ? 7 : 6}" class="empty">${REP_EXP_API_OK
        ? "该时段没有此类支出"
        : "后端未返回逐笔明细字段（expense_items）：请更新并重启后端服务后刷新"}</td></tr>`;

  openModal(`
    <div class="card-head" style="margin-bottom:8px;">
      <h3>${esc(title)}</h3>
      <div class="grow"></div>
      <span class="muted">共 ${rows.length} 笔 · 合计 <b>${fmtMoney(sum)}</b></span>
    </div>
    <div class="toolbar" style="margin-bottom:8px;">${chips}</div>
    <div class="table-wrap"><table>
      <thead><tr>${withWh ? "<th>分仓</th>" : ""}<th>日期</th><th>来源</th><th>项目</th><th class="num">金额</th><th>操作员</th><th>备注</th></tr></thead>
      <tbody>${body}</tbody>
      ${rows.length ? `<tfoot><tr>${withWh ? "<td></td>" : ""}<td><b>合计</b></td>
        <td class="muted" colspan="2">${esc(d.source || "全部来源")} · ${rows.length} 笔</td>
        <td class="num mono"><b>${fmtMoney(sum)}</b></td><td colspan="2"></td></tr></tfoot>` : ""}
    </table></div>
    <div class="modal-foot">
      <button class="btn secondary" onclick="repDrillToItems()">在「支出明细（逐笔）」中查看</button>
      <button class="btn" onclick="closeModal()">关闭</button>
    </div>`);
  $("modalBox").classList.add("wide");   // 明细列较多，弹窗放宽
}

function repDrillToItems() {
  const d = REP_DRILL;
  if (d) {
    const sel = $("repExpItemSrc");
    if (sel) sel.value = d.source;
    const kw = $("repExpItemSearch");
    if (kw) kw.value = d.key;   // 日期/月份前缀即关键词，逐笔表会筛出同一批记录
    renderExpenseItemRows();
  }
  closeModal();
  const t = $("repExpItemTable");
  if (t) t.scrollIntoView({ behavior: "smooth", block: "center" });
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
        + " · 点日期或金额可展开该日/该月的构成明细"
      : "本期无支出";
    if (days.length > MAX_DAYS) hint.textContent += ` · 按日仅列最近 ${MAX_DAYS} 天`;
    // 待付款不在报表里：明确提示，避免"钱去哪了"
    const pend = rep.pending || {};
    const pAmt = pend.payables_amount || 0;
    const rAmt = pend.receivables_amount || 0;
    if (pAmt || rAmt) {
      hint.textContent += ` · 另有 ${pend.payables_count || 0} 笔待付款 ${fmtMoney(pAmt)}`
        + (rAmt ? ` / ${pend.receivables_count || 0} 笔待收款 ${fmtMoney(rAmt)}` : "")
        + " 未计入（到「待付款账单」点「已支付」后按原日期计入）";
    }
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
  // 金额/日期可点：下钻到该时段该来源的构成明细（二级页面）。0 元不给点，避免弹出空表。
  const jsKey = (s) => String(s || "").replace(/[^0-9A-Za-z-]/g, "");   // 只留日期/月份字符，避免注入 onclick
  const keyOf = (r) => jsKey(r.date || r.month);
  const drill = (key, kind, text, title) =>
    `<span class="exp-link" onclick="openExpDrill('${key}','${kind}')" title="${title}">${text}</span>`;
  const cell = (v, color, key, kind, title) => (v
    ? `<td class="num mono" style="color:${color}">${drill(key, kind, fmtMoney(v), title)}</td>`
    : `<td class="num mono" style="color:${color}">—</td>`);
  const amountCells = (r) =>
    cell(r.purchase, "#1989fa", keyOf(r), "purchase", "展开采购支出构成") +
    cell(r.other_expense, "#f97316", keyOf(r), "other", "展开其他开支构成") +
    cell(r.manual_expense, "#6366f1", keyOf(r), "manual", "展开手工记账构成") +
    `<td class="num mono"><b>${r.total ? drill(keyOf(r), "", fmtMoney(r.total), "展开全部支出明细") : "—"}</b></td>`;
  // 合计行：key 为空 = 整个查询区间
  const totalCells = (label, rows) =>
    `<tr><td><b>${label}</b></td>` +
    `<td class="num mono" style="color:#1989fa"><b>${drill("", "purchase", fmtMoney(purchase), "展开本期采购构成")}</b></td>` +
    `<td class="num mono" style="color:#f97316"><b>${drill("", "other", fmtMoney(other), "展开本期其他开支构成")}</b></td>` +
    `<td class="num mono" style="color:#6366f1"><b>${drill("", "manual", fmtMoney(manual), "展开本期手工记账构成")}</b></td>` +
    `<td class="num mono"><b>${drill("", "", fmtMoney(total), "展开本期全部支出明细")}</b></td>` +
    `<td></td><td class="num mono"><b>${sumCount(rows)}</b></td></tr>`;

  // 按日
  const dt = $("repExpDayTable");
  const dayRows = days.slice(0, MAX_DAYS);
  dt.innerHTML = `<thead><tr>
    <th>日期</th><th class="num">采购支出</th><th class="num">其他开支</th><th class="num">手工记账</th>
    <th class="num">支出合计</th><th class="num">占比</th><th class="num">笔数</th></tr></thead><tbody>` +
    (dayRows.length
      ? dayRows.map((r) => `<tr>
          <td class="mono">${drill(jsKey(r.date), "", esc(r.date), "展开当天全部支出明细")}</td>${amountCells(r)}
          <td class="num">${bar(r.total)}<span class="muted">${pctOf(r.total).toFixed(1)}%</span></td>
          <td class="num mono">${r.count}</td></tr>`).join("")
      : `<tr><td colspan="7" class="empty">${emptyText}</td></tr>`) +
    `</tbody>` +
    (days.length ? `<tfoot>${totalCells(`合计（${days.length} 天 · ${sumCount(days)} 笔）`, days)}</tfoot>` : "");

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
          <td class="mono">${drill(jsKey(m.month), "", esc(m.month), "展开当月全部支出明细")}</td>${amountCells(m)}
          <td class="num mono" style="color:${color}">${txt}</td>
          <td class="num mono">${m.count}</td></tr>`;
      }).join("")
      : `<tr><td colspan="7" class="empty">${emptyText}</td></tr>`) +
    `</tbody>` +
    (months.length ? `<tfoot>${totalCells(`合计（${months.length} 个月 · ${sumCount(months)} 笔）`, months)}</tfoot>` : "");
}

/* 支出逐笔明细：采购 / 其他开支 / 手工记账，逐条列出（与「支出合计」同口径） */
const REP_EXP_SRC_COLORS = { "采购": "#1989fa", "其他开支": "#f97316", "手工记账": "#6366f1" };
let REP_EXP_ITEMS = [];
let REP_EXP_API_OK = true;
let REP_EXP_WITH_WH = false;   // 全仓总览：逐笔明细来自多个分仓，需要显示来源分仓列

function renderExpenseItems(rep) {
  REP_EXP_ITEMS = rep.expense_items || [];
  REP_EXP_API_OK = Array.isArray(rep.expense_items);   // 后端未升级时给出明确提示，避免"看着是空的"
  REP_EXP_WITH_WH = !!rep.is_all;
  const sel = $("repExpItemSrc");
  if (sel) sel.value = "";   // 换区间后重置筛选，避免"看不到数据"的困惑
  // 已排除其他开支时，逐笔明细里不会有该来源，把筛选项置灰并说明原因
  const optOther = sel ? sel.querySelector('option[value="其他开支"]') : null;
  if (optOther) {
    optOther.disabled = !!rep.exclude_other_expense;
    optOther.textContent = rep.exclude_other_expense ? "其他开支（已排除）" : "其他开支";
  }
  const kw = $("repExpItemSearch");
  if (kw) kw.value = "";
  renderExpenseItemRows();
}

function renderExpenseItemRows() {
  const t = $("repExpItemTable");
  if (!t) return;
  const src = ($("repExpItemSrc") || {}).value || "";
  const kw = (($("repExpItemSearch") || {}).value || "").trim().toLowerCase();
  const withWh = REP_EXP_WITH_WH;
  let rows = REP_EXP_ITEMS;
  if (src) rows = rows.filter((r) => r.source === src);
  if (kw) {
    rows = rows.filter((r) =>
      [r.date, r.source, r.category, r.item, r.remark, r.operator, r.ref, r.warehouse].join(" ").toLowerCase().includes(kw));
  }
  const MAX = 200;
  const shown = rows.slice(0, MAX);
  const sum = rows.reduce((a, r) => a + (r.amount || 0), 0);
  const sumEl = $("repExpItemSum");
  const needRestart = "后端未返回逐笔明细字段（expense_items）：请更新并重启后端服务后刷新";
  if (sumEl) {
    sumEl.textContent = REP_EXP_API_OK
      ? `共 ${rows.length} 笔 · 合计 ${fmtMoney(sum)}`
        + (rows.length > MAX ? `（仅列最近 ${MAX} 笔，可用筛选缩小范围）` : "")
      : needRestart;
  }

  t.innerHTML = `<thead><tr>
    ${withWh ? "<th>分仓</th>" : ""}
    <th>日期</th><th>来源</th><th>项目</th><th class="num">金额</th><th>操作员</th><th>备注</th>
    </tr></thead><tbody>` +
    (shown.length
      ? shown.map((r) => `<tr>
          ${withWh ? `<td>${esc(r.warehouse) || "—"}</td>` : ""}
          <td class="mono">${esc(r.date)}</td>
          <td><span class="cost-dot" style="background:${REP_EXP_SRC_COLORS[r.source] || "var(--muted)"};"></span>${esc(r.source)}${r.auto ? '<span class="muted"> 自动</span>' : ""}</td>
          <td>${esc(r.item || r.category)}${r.ref ? ` <span class="muted">${esc(r.ref)}</span>` : ""}</td>
          <td class="num mono"><b>${fmtMoney(r.amount)}</b></td>
          <td>${esc(r.operator) || "—"}</td>
          <td class="muted" style="max-width:280px;">${renderRemarkHtml(r.remark)}</td></tr>`).join("")
      : `<tr><td colspan="${withWh ? 7 : 6}" class="empty">${!REP_EXP_API_OK ? needRestart : (REP_EXP_ITEMS.length ? "没有符合筛选条件的支出" : "本期无支出")}</td></tr>`) +
    `</tbody>` +
    (rows.length
      ? `<tfoot><tr>
          ${withWh ? "<td></td>" : ""}
          <td><b>合计</b></td>
          <td class="muted" colspan="2">${esc(src || "全部来源")} · ${rows.length} 笔</td>
          <td class="num mono"><b>${fmtMoney(sum)}</b></td>
          <td colspan="2"></td></tr></tfoot>`
      : "");
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
    { name: "采购支出（进货）", value: purchase, color: "#1989fa", desc: "入库 / 进货金额（与「本期进货」同源，含入库运费/装卸费），已计入结转成本" },
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
      <div class="field">
        <label>付款状态</label>
        ${payRadios("finPay", "paid", "待付款：先进「待付款账单」，点「已支付」后才计入财务报表")}
      </div>
    </div>
    <div class="field" style="margin-top:10px;"><label>备注</label><input id="fRemark" /></div>
    <div class="modal-foot">
      <button class="btn secondary" onclick="closeModal()">取消</button>
      <button class="btn" onclick="submitFinance()">保存</button>
    </div>`);
}
async function submitFinance() {
  try {
    const payStatus = payOf("finPay");
    await api("/api/finance", "POST", {
      type: $("fType").value, category: $("fCategory").value,
      amount: +$("fAmount").value, date: $("fDate").value,
      operator: $("fOperator").value, remark: $("fRemark").value,
      pay_status: payStatus,
    });
    closeModal(); toast(payStatus === "unpaid" ? "已记入待付款账单" : "记账成功"); loadReport();
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
        <td class="mono">${esc(r.date)}</td>
        <td><span class="badge expense">${esc(r.category)}</span>${payTag(r.pay_status)}${r.ref_type ? ` <span class="badge${r.ref_type === "inbound_fee" ? " pack" : ""}" title="${r.ref_type === "inbound_fee" ? "入库单带出的运费/装卸费：已计入该批次成本（随销量在毛利中扣减），这里留档备查，报表期间费用不再重复扣" : "单据自动带出的金额调整，只影响开支、不改成本"}">来自${r.ref_type === "inbound_fee" ? "入库单·成本" : r.ref_type === "inbound" ? "入库单" : "出库单"}</span>` : ""}</td>
        <td class="num mono" style="color:var(--red)">${fmtMoney(r.amount)}</td>
        <td>${esc(r.operator) || "—"}</td>
        <td class="muted" style="max-width:260px;">${renderRemarkHtml(r.remark)}</td>
        <td>${r.ref_type
          ? `<span class="muted" style="font-size:12px;">随单据自动维护</span>`
          : `<button class="btn sm secondary" onclick="oeEdit(${r.id})">改</button>
             <button class="btn sm danger" onclick="oeDelete(${r.id})">删</button>`}</td></tr>`).join("")
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
  $("oeDate").value = today();
  setPay("oePay", "paid");
  clearRemarkField("oeRemark");
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
  setRemarkValue("oeRemark", r.remark);   // 已有附件拆到标签区，文本框只留纯文本
  setPay("oePay", r.pay_status);
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
  const payStatus = payOf("oePay");
  const body = { category, amount, date, remark: remarkValue("oeRemark"), pay_status: payStatus };
  const editing = !!OE_EDIT_ID;
  try {
    if (editing) await api("/api/other-expenses/" + OE_EDIT_ID, "PUT", body);
    else await api("/api/other-expenses", "POST", body);
    // 若该日期不在当前统计区间内，自动把区间扩到能看见它（避免"保存了却看不到"）
    if ($("oeDateFrom").value && date < $("oeDateFrom").value) $("oeDateFrom").value = date;
    if ($("oeDateTo").value && date > $("oeDateTo").value) $("oeDateTo").value = date;
    const tail = payStatus === "unpaid" ? "（待付款，已进待付款账单）" : "";
    toast((editing ? "已保存修改" : `已登记 ${category} ${fmtMoney(amount)}`) + tail);
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

/* =============== 待付款账单（各处勾了「待付款」的单据汇总） =============== */
let PAY_ROWS = [];       // 当前列表（待结清 ± 最近已结清）
let PAY_VIEW = "unpaid"; // unpaid 只看待结清 / all 含最近已结清
const PAY_SRC_BADGE = { "入库": "in", "入仓": "income", "出库": "out", "其他开支": "expense", "手动记账": "adjust", "代发": "pack" };

async function loadPayablesPage() {
  try {
    const d = await api(`/api/payables?include_paid=${PAY_VIEW === "all" ? 1 : 0}`);
    PAY_ROWS = d.items || [];
    renderPayStats(d.total || {});
    renderPayables();
    renderPayBadge(d.total || {});
    payAlertMsg("");
    // 停在「代发」页签时，刷新按钮/其它页面的操作都要让代发列表同步刷新
    if (DS_LOADED && $("pay-panel-dropship") && $("pay-panel-dropship").style.display !== "none") loadDropshipBills();
  } catch (e) {
    payAlertMsg("加载待付款账单失败：" + e.message);
    $("payTable").innerHTML = `<tbody><tr><td class="empty">加载失败：${esc(e.message)}</td></tr></tbody>`;
  }
}

function paySwitchView(btn) {
  $("paySeg").querySelectorAll(".seg-item").forEach((x) => x.classList.toggle("active", x === btn));
  PAY_VIEW = btn.dataset.view === "all" ? "all" : "unpaid";
  loadPayablesPage();   // 切视图重新拉取，关键词 / 日期筛选条件保留，列表与合计立即重算
}

/** 当前筛选条件：关键词 + 日期区间（起止都按单据日期 YYYY-MM-DD 比较） */
function payFilter() {
  return {
    kwRaw: ($("paySearch") ? $("paySearch").value : "").trim(),
    from: $("payFrom") ? $("payFrom").value : "",
    to: $("payTo") ? $("payTo").value : "",
  };
}

/** 日期框有空值 / 有值时切换 .has-value：空值显示自己的占位文案，避免露出浏览器自带的「年/月/日」掩码 */
function datePhSync(ids) {
  ids.forEach((id) => {
    const el = $(id);
    if (el && el.parentElement) el.parentElement.classList.toggle("has-value", !!el.value);
  });
}

function paySyncDatePh() {
  datePhSync(["payFrom", "payTo"]);
}

/** 清空关键词与日期区间，恢复到全部账单 */
function payClearFilter() {
  if ($("paySearch")) $("paySearch").value = "";
  if ($("payFrom")) $("payFrom").value = "";
  if ($("payTo")) $("payTo").value = "";
  renderPayables();
}

/** 先按关键词、再按日期区间过滤出要展示的账单（同时报告被排除的「无日期」笔数） */
function payFilterRows() {
  const f = payFilter();
  const kw = f.kwRaw.toLowerCase();
  let rows = PAY_ROWS;
  if (kw) {
    rows = rows.filter((r) =>
      [r.date, r.source, r.title, r.sub, r.code, r.remark, r.operator].join(" ").toLowerCase().includes(kw));
  }
  let undated = 0;
  if (f.from || f.to) {
    const keep = [];
    rows.forEach((r) => {
      if (!r.date) { undated += 1; return; }   // 没日期的单据无法证明落在区间内，不计入合计
      if ((!f.from || r.date >= f.from) && (!f.to || r.date <= f.to)) keep.push(r);
    });
    rows = keep;
  }
  return { rows, undated, active: !!(kw || f.from || f.to), f };
}

/** 筛选结果实时合计：笔数 + 总金额（应付 + 应收）+ 拆分；关键词 / 日期一变就重算 */
function renderPaySum(rows, undated, active, f) {
  const el = $("paySum");
  if (!el) return;
  const outSum = rows.filter((r) => r.direction !== "in").reduce((a, r) => a + r.amount, 0);
  const inSum = rows.filter((r) => r.direction === "in").reduce((a, r) => a + r.amount, 0);
  const range = (f.from || f.to) ? `${f.from || "最早"} ~ ${f.to || "最新"}` : "";
  const cond = [range ? `日期 ${range}` : "", f.kwRaw ? `关键词「${f.kwRaw}」` : ""].filter(Boolean).join(" + ");
  el.innerHTML =
    `<span class="pay-sum-label">${active ? "筛选结果" : "当前列表"}</span>` +
    `<span><b>${rows.length}</b> 笔${rows.length === PAY_ROWS.length ? "" : ` <span class="muted">/ 共 ${PAY_ROWS.length} 笔</span>`}</span>` +
    `<span class="pay-sum-total">合计 <b class="mono">${fmtMoney(outSum + inSum)}</b></span>` +
    `<span class="muted">应付 <b class="mono" style="color:var(--danger, #dc2626);">${fmtMoney(outSum)}</b>`
    + ` ／ 应收 <b class="mono" style="color:var(--green, #16a34a);">${fmtMoney(inSum)}</b></span>` +
    (undated ? `<span class="muted">${undated} 笔无日期未计入</span>` : "") +
    `<span class="grow"></span>` +
    (cond ? `<span class="muted">已按 ${cond} 筛选</span>` : "");
}

function payAlertMsg(msg) {
  const el = $("payAlert");
  if (!el) return;
  el.textContent = msg || "";
  el.style.display = msg ? "block" : "none";
}

function renderPayStats(t) {
  const box = $("payStats");
  if (!box) return;
  const payable = t.payables_amount || 0;
  const recv = t.receivables_amount || 0;
  box.innerHTML = `
    <div class="stat red"><div class="label">待付款（应付）</div><div class="value">${fmtMoney(payable)}</div><div class="sub">要付出去的钱</div></div>
    <div class="stat"><div class="label">待收款（应收）</div><div class="value">${fmtMoney(recv)}</div><div class="sub">要收进来的钱</div></div>
    <div class="stat amber"><div class="label">待结清笔数</div><div class="value">${t.unpaid_count || 0}</div><div class="sub">合计 ${fmtMoney(payable + recv)}</div></div>
    <div class="stat"><div class="label">最近已结清</div><div class="value">${t.paid_count || 0}</div><div class="sub">最近 30 天内（可撤销）</div></div>`;
}

function renderPayables() {
  const t = $("payTable");
  if (!t) return;
  const { rows, undated, active, f } = payFilterRows();
  paySyncDatePh();
  t.innerHTML = `<thead><tr>
      <th style="width:34px;"><input type="checkbox" onchange="payToggleAll(this)" /></th>
      <th style="width:102px;">日期</th><th style="width:96px;">来源</th><th>具体事物 / 款项</th>
      <th class="num" style="width:150px;">金额</th><th style="width:88px;">操作员</th><th style="width:180px;"></th>
    </tr></thead><tbody>` +
    (rows.length
      ? rows.map((r) => {
        const paid = r.pay_status !== "unpaid";
        const color = r.direction === "in" ? "var(--green, #16a34a)" : "var(--danger, #dc2626)";
        const money = `${r.direction === "in" ? "应收" : "应付"} ${fmtMoney(r.amount)}`;
        return `<tr${paid ? ' style="opacity:.55;"' : ""}>
          <td><input type="checkbox" class="pay-pick" value="${esc(r.kind)}|${r.id}" /></td>
          <td class="mono">${esc(r.date)}</td>
          <td><span class="badge ${PAY_SRC_BADGE[r.source] || "adjust"}">${esc(r.source)}</span></td>
          <td><b>${esc(r.title)}</b>${r.code ? ` <span class="muted">${esc(r.code)}</span>` : ""}
            <div class="muted" style="font-size:12px;">${esc(r.sub)}${r.remark ? " · " + renderRemarkHtml(r.remark, { compact: true }) : ""}</div></td>
          <td class="num mono"><b style="color:${color};">${money}</b></td>
          <td>${esc(r.operator) || "—"}</td>
          <td class="num">${paid
            ? `<span class="muted">已结清 ${esc(r.paid_at)}</span>
               <button class="btn sm secondary" onclick="payBill('${r.kind}',${r.id},false)">撤销</button>`
            : `<span class="pay-actions">
                 <button class="btn sm secondary" onclick="goPage('${r.page}')">查看</button>
                 <button class="btn sm green" onclick="payBill('${r.kind}',${r.id},true)">已支付</button>
               </span>`}</td>
        </tr>`;
      }).join("")
      : `<tr><td colspan="7" class="empty">${active && PAY_ROWS.length
        ? "没有符合筛选条件的账单（可点「清空筛选」看全部）"
        : (PAY_VIEW === "all" ? "没有账单" : "没有待结清的账单")}</td></tr>`) +
    `</tbody>` +
    (rows.length
      ? `<tfoot><tr>
          <td></td>
          <td><b>${active ? "筛选合计" : "列出合计"}</b></td>
          <td class="muted" colspan="2">${rows.length} 笔${PAY_VIEW === "all" ? "（含已结清）" : ""}</td>
          <td class="num mono"><b>应付 ${fmtMoney(rows.filter((r) => r.direction !== "in").reduce((a, r) => a + r.amount, 0))}
            ／ 应收 ${fmtMoney(rows.filter((r) => r.direction === "in").reduce((a, r) => a + r.amount, 0))}</b></td>
          <td colspan="2"></td></tr></tfoot>`
      : "");
  renderPaySum(rows, undated, active, f);
}

/** 标记已支付/撤销：支付后按原日期纳入财务报表，撤销则移出 */
async function payBill(kind, id, paid) {
  const r = PAY_ROWS.find((x) => x.kind === kind && x.id === id);
  const label = r ? `${r.source}「${r.title}」${fmtMoney(r.amount)}` : "";
  const isDs = kind === "dropship";
  if (paid && !confirm(`确认已支付？\n${label}\n${isDs ? "（代发成本只做付款核对，不影响财务报表）" : "确认后这笔将按原日期计入财务报表。"}`)) return;
  if (!paid && !confirm(`确认撤销？\n${label}\n${isDs ? "（只撤销付款核对标记）" : "撤销后它会移出财务报表，回到待付款账单。"}`)) return;
  try {
    await api("/api/payables/pay", "POST", { kind, id, paid });
    toast(paid
      ? (isDs ? "已标记代发成本已支付" : "已标记已支付，已按原日期计入财务报表")
      : (isDs ? "已撤销付款标记" : "已撤销，已移出财务报表"));
    await loadPayablesPage();
    if (DS_LOADED) loadDropshipBills();   // 代发页签同源，跟着刷新
  } catch (e) { toast("操作失败：" + e.message); }
}

/* ---------- 列表的批量勾选（待付款账单 / 鲜货入库共用） ---------- */
/** 表头那个勾选框：勾/取消它所在表格里的所有行（.pay-pick 账单 / .fin-pick 鲜货入库） */
function payToggleAll(cb) {
  const checked = !!(cb && cb.checked);
  const table = cb && cb.closest ? cb.closest("table") : null;
  (table || document).querySelectorAll(".pay-pick, .fin-pick").forEach((x) => { x.checked = checked; });
  // 鲜货入库页：把勾选同步到 FIN_PICK，并刷新合计与按钮文案
  if (table && table.id === "finTable") {
    FIN_PICK.clear();
    if (checked) {
      document.querySelectorAll("#finTable .fin-pick").forEach((x) => {
        const id = +x.value;
        if (id) FIN_PICK.add(id);
      });
    }
    finSummary();
  }
}

/** 勾选的账单 → [{kind, id}]（复选框值形如 "inbound|12"） */
function payPicked() {
  return [...document.querySelectorAll("#payTable .pay-pick")].filter((x) => x.checked).map((x) => {
    const [kind, id] = String(x.value).split("|");
    return { kind, id: Number(id) };
  }).filter((x) => x.kind && Number.isFinite(x.id));
}

/** 批量标记已支付 / 撤销：按 kind 分组提交（代发按出库单整单结清，其余按单据自身） */
async function payBatch(paid) {
  const picked = payPicked();
  if (!picked.length) { toast("请先勾选要处理的账单"); return; }
  const amount = picked.reduce((a, p) => {
    const r = PAY_ROWS.find((x) => x.kind === p.kind && x.id === p.id);
    return a + (r ? r.amount : 0);
  }, 0);
  const tip = paid
    ? "确认后这些将按原日期计入财务报表（代发只做付款核对、不进报表）。"
    : "撤销后会从财务报表移出（代发只撤销付款标记）。";
  if (!confirm(`${paid ? "批量标记已支付" : "批量撤销"}：${picked.length} 笔，合计 ${fmtMoney(amount)}？\n${tip}`)) return;
  const byKind = new Map();
  picked.forEach((p) => {
    if (!byKind.has(p.kind)) byKind.set(p.kind, []);
    byKind.get(p.kind).push(p.id);
  });
  let updated = 0, missing = 0;
  try {
    for (const [kind, ids] of byKind) {
      const r = await api("/api/payables/pay-batch", "POST", { kind, ids, paid });
      updated += r.updated || 0;
      missing += r.missing || 0;
    }
    toast(`已处理 ${updated} 笔${missing ? `，${missing} 笔已不存在` : ""}`);
    await loadPayablesPage();
    if (DS_LOADED) loadDropshipBills();
  } catch (e) { toast("批量操作失败：" + e.message); }
}

/* ---------- 待付款账单：代发页签 ----------
   出库单里命中「代发商品」（关联结算没挂库存大类）的成本自动登记成应付给代发方的账单；
   这里按出库单分组，逐规格列「单价 × 单量 = 金额」，方便核对付款。付款状态不影响财务报表。 */
let DS_GROUPS = [];      // 当前代发列表（按「商品 + 规格 + 单位」跨单合并）
let DS_VIEW = "unpaid";  // unpaid 只看待结清 / all 含已结清
let DS_LOADED = false;   // 是否已拉取过（切回来时无需重复拉取，除非有操作）
let DS_TOTAL = {};
let DS_TRUNCATED = false;   // 后端只回最近 N 行（避免上万行把页面拖垮）
let DS_LIMIT = 0;

function payTab(btn) {
  const panel = btn.dataset.panel;
  document.querySelectorAll("#payTabSeg .seg-item").forEach((x) => x.classList.toggle("active", x === btn));
  if ($("pay-panel-bill")) $("pay-panel-bill").style.display = panel === "pay-panel-bill" ? "" : "none";
  if ($("pay-panel-dropship")) $("pay-panel-dropship").style.display = panel === "pay-panel-dropship" ? "" : "none";
  const hint = $("payTabHint");
  if (hint) hint.textContent = panel === "pay-panel-dropship"
    ? "代发：按「商品 + 规格 + 出库日期」分行，按天核对「单价 × 单量 = 代发成本」"
    : "账单：入库 / 出库 / 其他开支 / 手动记账的待结清项；代发应付在「代发」页签里单独看";
  if (panel === "pay-panel-dropship") loadDropshipBills();
}

async function loadDropshipBills() {
  try {
    const from = $("dsFrom") ? $("dsFrom").value : "";
    const to = $("dsTo") ? $("dsTo").value : "";
    // 日期区间交给服务端过滤：这样被截断（只回最近 N 行）时也能查到更早的日期
    const qs = new URLSearchParams({ include_paid: DS_VIEW === "all" ? "1" : "0" });
    if (from) qs.set("date_from", from);
    if (to) qs.set("date_to", to);
    const d = await api(`/api/payables/dropship?${qs.toString()}`);
    DS_GROUPS = d.groups || [];
    DS_TOTAL = d.total || {};
    DS_TRUNCATED = !!d.truncated;
    DS_LIMIT = d.limit || 0;
    DS_LOADED = true;
    // 列表被截断时给一句提示（合计仍按全部算），并说明缩小范围的办法
    dsAlert(d.truncated
      ? `共 ${DS_TOTAL.groups || 0} 行（按商品+规格+日期分行），这里只列最近 ${DS_LIMIT} 行；待结清合计 ${fmtMoney(DS_TOTAL.pending_amount || 0)}。用上面的日期区间可以缩小范围。`
      : "");
    renderDropshipBills();
  } catch (e) {
    dsAlert("加载代发应付失败：" + e.message);
    const t = $("dsTable");
    if (t) t.innerHTML = `<tbody><tr><td colspan="8" class="empty">加载失败：${esc(e.message)}</td></tr></tbody>`;
  }
}

function dsSwitchView(btn) {
  $("dsSeg").querySelectorAll(".seg-item").forEach((x) => x.classList.toggle("active", x === btn));
  DS_VIEW = btn.dataset.view === "all" ? "all" : "unpaid";
  loadDropshipBills();
}

function dsClearFilter() {
  if ($("dsSearch")) $("dsSearch").value = "";
  if ($("dsFrom")) $("dsFrom").value = "";
  if ($("dsTo")) $("dsTo").value = "";
  loadDropshipBills();   // 日期是服务端过滤，清空后要重新拉取
}

function dsAlert(msg) {
  const el = $("dsAlert");
  if (!el) return;
  el.style.display = msg ? "block" : "none";
  el.textContent = msg || "";
}

/** 关键词 / 日期筛选（行 = 商品+规格+日期；日期已由服务端过滤，这里再兜一次防漏） */
function dsFilterGroups() {
  const kw = ($("dsSearch") ? $("dsSearch").value : "").trim().toLowerCase();
  const from = $("dsFrom") ? $("dsFrom").value : "";
  const to = $("dsTo") ? $("dsTo").value : "";
  let groups = DS_GROUPS;
  if (kw) {
    groups = groups.filter((g) =>
      [g.product_name, g.spec, g.unit, g.operator].join(" ").toLowerCase().includes(kw));
  }
  if (from || to) {
    groups = groups.filter((g) => {
      const a = g.date_from || g.date_to, b = g.date_to || g.date_from;
      if (!a || !b) return false;
      return (!to || a <= to) && (!from || b >= from);
    });
  }
  return { groups, active: !!(kw || from || to) };
}

const DS_NUM4 = (v) => { const s = Number(v || 0).toFixed(4).replace(/0+$/, "").replace(/\.$/, ""); return s || "0"; };

let DS_ROWS = [];   // 当前渲染（筛选后）的行，勾选项用它的下标索引

function renderDropshipBills() {
  const t = $("dsTable");
  if (!t) return;
  datePhSync(["dsFrom", "dsTo"]);   // 选了日期要收起占位，否则日期文字被占位/掩码盖住看不见
  const { groups, active } = dsFilterGroups();
  DS_ROWS = groups;
  const sum = groups.reduce((a, g) => a + (g.amount || 0), 0);
  const pend = groups.filter((g) => g.pay_status === "unpaid");
  const pendAmt = pend.reduce((a, g) => a + (g.amount || 0), 0);
  const orders = groups.reduce((a, g) => a + (g.order_count || 0), 0);
  const days = new Set(groups.map((g) => g.date).filter(Boolean)).size;   // 涉及多少个出库日期
  const sumEl = $("dsSum");
  if (sumEl) {
    sumEl.innerHTML =
      `<span class="pay-sum-label">${active ? "筛选结果" : "当前列表"}</span>` +
      `<span><b>${groups.length}</b> 行 <span class="muted">/ ${days} 天 / ${orders} 单</span></span>` +
      `<span class="pay-sum-total">合计 <b class="mono">${fmtMoney(sum)}</b></span>` +
      `<span class="muted">待结清 <b class="mono" style="color:var(--danger, #dc2626);">${fmtMoney(pendAmt)}</b></span>` +
      (DS_VIEW === "all" ? `<span class="muted">已结清 <b class="mono" style="color:var(--green, #16a34a);">${fmtMoney(sum - pendAmt)}</b></span>` : "") +
      `<span class="grow"></span>` +
      (active ? `<span class="muted">已按 ${[$("dsFrom")?.value || $("dsTo")?.value ? "日期" : "", $("dsSearch")?.value.trim() ? "关键词" : ""].filter(Boolean).join(" + ")} 筛选</span>` : "");
  }

  const rows = groups.map((g, idx) => {
    const paid = g.pay_status !== "unpaid";
    // 规格已经写在商品名里（如「雪莲果大果8斤」）就不重复显示
    const specTxt = g.spec && !(g.product_name || "").includes(g.spec) ? ` <span class="muted">· ${esc(g.spec)}</span>` : "";
    return `<tr${paid ? ' style="opacity:.55;"' : ""}>
      <td><input type="checkbox" class="ds-pick" value="${idx}" /></td>
      <td class="num mono">${esc(g.date || g.date_from || g.date_to || "")}</td>
      <td><b>${esc(g.product_name || "代发商品")}</b>${specTxt}
        <div class="muted" style="font-size:11px;color:var(--danger);">代发成本 ${fmtMoney(g.amount)}</div></td>
      <td class="num mono">${DS_NUM4(g.quantity)}${esc(g.unit || "")}</td>
      <td class="num mono">${fmtMoney(g.unit_price)}</td>
      <td class="num mono"><b style="color:var(--danger, #dc2626);">${fmtMoney(g.amount)}</b></td>
      <td class="num muted">${g.order_count} 单</td>
      <td class="num">${paid
        ? `<button class="btn sm secondary" title="已付 ${esc(g.paid_at || "")}，点此撤销" onclick="dsMarkPaid(${idx}, false)">已付·撤销</button>`
        : `<button class="btn sm green" onclick="dsMarkPaid(${idx}, true)">已支付</button>`}</td>
    </tr>`;
  });

  t.innerHTML = `<thead><tr>
      <th style="width:34px;"><input type="checkbox" onchange="dsToggleAll(this)" /></th>
      <th class="num" style="width:110px;">日期</th>
      <th>商品 / 规格</th>
      <th class="num" style="width:110px;">单量</th>
      <th class="num" style="width:100px;">单价</th>
      <th class="num" style="width:140px;">应付金额</th>
      <th class="num" style="width:96px;">单据</th>
      <th style="width:96px;"></th>
    </tr></thead><tbody>` +
    (rows.length ? rows.join("")
      : `<tr><td colspan="8" class="empty">${active
        ? "没有符合筛选条件的代发应付（可点「清空筛选」看全部）"
        : (DS_VIEW === "all" ? "还没有代发应付账单" : "没有待结清的代发应付")}</td></tr>`) +
    `</tbody>` +
    (groups.length
      ? `<tfoot><tr>
          <td></td>
          <td><b>${active ? "筛选合计" : "列出合计"}</b></td>
          <td class="muted" colspan="3">${groups.length} 行 · ${days} 天 · 待结清 ${pend.length} 行 · ${orders} 单</td>
          <td class="num mono"><b>应付 ${fmtMoney(sum)}</b></td>
          <td colspan="2"></td>
        </tr></tfoot>`
      : "");
}

function dsToggleAll(cb) {
  document.querySelectorAll("#dsTable .ds-pick").forEach((x) => { x.checked = cb.checked; });
}

/** 勾选的行 → 它们名下所有出库单的代发账单行 id（跨单合并后一行对应多张单） */
function dsPickedBillIds() {
  return [...document.querySelectorAll("#dsTable .ds-pick")].filter((x) => x.checked)
    .map((x) => DS_ROWS[Number(x.value)]).filter(Boolean)
    .flatMap((g) => g.bill_ids || []);
}

/** 标记某款商品规格（可能跨多张出库单）的代发成本已付/撤销 */
async function dsMarkPaid(idx, paid) {
  const g = DS_ROWS[idx];
  if (!g) return;
  const label = `${g.product_name}${g.spec ? " · " + g.spec : ""}（${g.order_count} 单，代发成本 ${fmtMoney(g.amount)}）`;
  if (!confirm(`${paid ? "确认这批代发成本已付清？" : "确认撤销已付标记？"}\n${label}\n（只影响代发付款核对，不影响财务报表）`)) return;
  try {
    await api("/api/payables/pay-batch", "POST", { kind: "dropship_item", ids: g.bill_ids || [], paid });
    toast(paid ? "已标记代发成本已支付" : "已撤销");
    await loadDropshipBills();
    await loadPayablesPage();
  } catch (e) { toast("操作失败：" + e.message); }
}

/** 批量标记勾选的商品规格 */
async function dsBatchPay(paid) {
  const picked = [...document.querySelectorAll("#dsTable .ds-pick")].filter((x) => x.checked)
    .map((x) => DS_ROWS[Number(x.value)]).filter(Boolean);
  const ids = picked.flatMap((g) => g.bill_ids || []);
  if (!ids.length) { toast("请先勾选要处理的商品规格"); return; }
  const amount = picked.reduce((a, g) => a + (g.amount || 0), 0);
  const orders = picked.reduce((a, g) => a + (g.order_count || 0), 0);
  if (!confirm(`${paid ? "批量标记已支付" : "批量撤销"}：${picked.length} 款商品规格 / ${orders} 张出库单，代发成本合计 ${fmtMoney(amount)}？\n（只影响代发付款核对，不影响财务报表）`)) return;
  try {
    const r = await api("/api/payables/pay-batch", "POST", { kind: "dropship_item", ids, paid });
    toast(`已处理 ${r.updated ?? ids.length} 行${r.missing ? `，${r.missing} 行已不存在` : ""}`);
    await loadDropshipBills();
    await loadPayablesPage();
  } catch (e) { toast("批量操作失败：" + e.message); }
}

/** 侧边栏角标：待结清笔数 */
function renderPayBadge(t) {
  const el = $("payNavBadge");
  if (!el) return;
  const n = (t && t.unpaid_count) || 0;
  el.textContent = n ? String(n) : "";
  el.style.display = n ? "" : "none";
}
async function refreshPayBadge() {
  try { const d = await api("/api/payables"); renderPayBadge(d.total || {}); } catch (e) { /* 忽略：不影响主流程 */ }
}

/* =============== 自动出库设置（聚水潭定时导出 + 导入当前分仓） =============== */
let JST_AUTO = null;         // 最近一次读到的设置
let JST_WH_OPTS = new Map(); // co_id -> 聚水潭分仓名（拉取到的 + 已保存的）
let JST_POLL = null;         // 运行状态轮询

function jstSetText(id, text) { const el = $(id); if (el) el.textContent = text; }
function jstNum(id, dft) { const v = Number($(id)?.value); return Number.isFinite(v) && v > 0 ? v : dft; }

/* 聚水潭分仓多选：选项 = 已保存的 + 拉取到的（已保存的勾选状态保留） */
function renderJstTargets(saved) {
  const sel = $("jstTargets");
  if (!sel) return;
  (saved || []).forEach((t) => { if (t && t.co_id && !JST_WH_OPTS.has(String(t.co_id))) JST_WH_OPTS.set(String(t.co_id), t.name || String(t.co_id)); });
  const picked = new Set((saved || []).map((t) => String(t.co_id)));
  sel.innerHTML = [...JST_WH_OPTS.entries()].map(
    ([co, name]) => `<option value="${esc(co)}" data-name="${esc(name)}"${picked.has(co) ? " selected" : ""}>${esc(name)}（${esc(co)}）</option>`
  ).join("") || `<option value="" disabled>先点「拉取聚水潭分仓列表」</option>`;
}

function jstWindowChanged() {
  const fixedFrom = $("jstFixedFrom")?.value || "", fixedTo = $("jstFixedTo")?.value || "";
  jstSetText("jstWindowHelp", fixedFrom && fixedTo ? "　⚠ 已填固定区间，将覆盖上面的时间段规则" : "");
}

function renderJstStatus(st, last) {
  const lines = [];
  if (st && st.scheduler === false) {
    lines.push("⚠ 定时调度未启动：重启一次后端服务即可恢复（手动「立即执行一次」不受影响）");
  }
  if (st && st.running) {
    lines.push(`⏳ 正在执行：${st.warehouse || ""} · ${st.step || ""}（${st.started_at || ""} 开始，触发：${st.trigger || ""}）`);
  }
  const r = (st && st.last && st.last.message) ? st.last : last;
  if (r && r.message) {
    lines.push(`${r.ok ? "✅" : "❌"} 最近一次（${r.at || ""} · ${r.trigger || ""}）：${r.message}`);
    if (r.window) lines.push(`　　区间：${r.window}`);
    if (r.files && r.files.length) lines.push(`　　文件：${r.files.join("、")}`);
    const s = r.stats || {};
    if (s.unmapped && s.unmapped.length) {
      lines.push(`　　未关联商品 ${s.unmapped.length} 种：${s.unmapped.slice(0, 6).join("、")}${s.unmapped.length > 6 ? " …" : ""}（到「聚水潭关联」页补关联）`);
    }
    if (s.failed && s.failed.length) {
      lines.push(`　　失败 ${s.failed.length} 条：${s.failed.slice(0, 3).map((f) => `${f.doc || ""} ${f.reason || ""}`).join("；")}`);
    }
  }
  // 出库记录列表默认只筛「今天」，而自动出库常导昨天/前几天的单，容易被误判成"没建单"：
  // 这里按本次导出区间给一个直达按钮（区间结束是次日 00:00，展示时回退一天）。
  const rng = String((r && r.window) || "").match(/(\d{4}-\d{2}-\d{2})[^~]*~\s*(\d{4}-\d{2}-\d{2})/);
  let jump = "";
  if (rng) {
    const end = new Date(rng[2] + "T00:00:00");
    end.setDate(end.getDate() - 1);
    const endStr = `${end.getFullYear()}-${String(end.getMonth() + 1).padStart(2, "0")}-${String(end.getDate()).padStart(2, "0")}`;
    if (endStr >= rng[1]) {
      jump = `<div style="margin-top:6px;">
        <button class="btn sm" onclick="gotoOutbounds('${rng[1]}','${endStr}')">▸ 去出库记录看这批单（${rng[1]} ~ ${endStr}）</button>
        <span class="muted" style="margin-left:6px;">出库记录默认只看今天，记得把日期改到这天</span></div>`;
    }
  }
  if (JST_PENDING_N) {
    jump = `<div style="margin-top:6px;"><button class="btn sm danger" onclick="jstScrollPending()">⚠ 有 ${JST_PENDING_N} 项待办要处理 → 去处理</button></div>` + jump;
  }
  const box = $("jstRunStatus");
  if (box) box.innerHTML = (lines.map((l) => `<div>${esc(l)}</div>`).join("") || "<div>还没有执行记录</div>") + jump;
}

/* 跳到出库记录页并把日期筛选设成本次导出区间（否则默认只看今天，看不到昨天的单） */
function gotoOutbounds(from, to) {
  if ($("outDateFrom")) $("outDateFrom").value = from;
  if ($("outDateTo")) $("outDateTo").value = to;
  goPage("outbound");
}

function startJstPoll() {
  stopJstPoll();
  JST_POLL = setInterval(async () => {
    try {
      const st = await api("/api/jst-auto/status");
      renderJstStatus(st, {});
      if (!st.running) { stopJstPoll(); loadJstHistory(); }
    } catch (e) { stopJstPoll(); } // 轮询失败就停掉，避免刷屏报错
  }, 3000);
}
function stopJstPoll() { if (JST_POLL) { clearInterval(JST_POLL); JST_POLL = null; } }

function fillJstAuto(d) {
  JST_AUTO = d || {};
  const g = JST_AUTO.globals || {};
  const wh = JST_AUTO.warehouse || {};
  jstSetText("jstWhName", JST_AUTO.warehouse_name || JST_AUTO.warehouse_key || "—");
  jstSetText("jstWhName2", JST_AUTO.warehouse_name || JST_AUTO.warehouse_key || "—");
  if ($("jstAccount")) $("jstAccount").value = g.account || "";
  if ($("jstPassword")) { $("jstPassword").value = ""; $("jstPassword").placeholder = g.has_password ? "已设置（留空 = 不修改）" : "留空 = 不修改"; }
  if ($("jstOwner")) $("jstOwner").value = g.owner_co_id || "";
  if ($("jstMinInterval")) $("jstMinInterval").value = g.min_interval ?? 10;
  if ($("jstTimeout")) $("jstTimeout").value = g.timeout ?? 120;
  if ($("jstRetries")) $("jstRetries").value = g.max_retries ?? 3;
  if ($("jstCookie")) $("jstCookie").value = "";
  jstSetText("jstCookieHint", g.has_cookie
    ? `已保存 Cookie（${g.cookie_len} 字符），留空 = 继续用它；点「清空 Cookie」可删除`
    : "还没保存 Cookie：填好账号密码保存后，执行时会自动登录并把 Cookie 存下来");
  const sel = $("jstWindow");
  if (sel && !sel.options.length) {
    sel.innerHTML = (JST_AUTO.windows || []).map((w) => `<option value="${esc(w.value)}">${esc(w.label)}</option>`).join("");
  }
  if (sel && wh.window) sel.value = wh.window;
  if ($("jstEnabled")) $("jstEnabled").checked = !!wh.enabled;
  if ($("jstFixedFrom")) $("jstFixedFrom").value = String(wh.fixed_from || "").replace(" ", "T").slice(0, 16);
  if ($("jstFixedTo")) $("jstFixedTo").value = String(wh.fixed_to || "").replace(" ", "T").slice(0, 16);
  if ($("jstSchedule")) $("jstSchedule").value = (wh.schedule || []).join(",");
  if ($("jstJitter")) $("jstJitter").value = Number(wh.jitter_minutes || 0);
  if ($("jstOperator")) $("jstOperator").value = wh.operator || "";
  if ($("jstAutoImport")) $("jstAutoImport").checked = wh.auto_import !== false;
  if ($("jstSkipImported")) $("jstSkipImported").checked = wh.skip_imported !== false;
  if ($("jstNotifyWebhook")) $("jstNotifyWebhook").value = g.notify_webhook || "";
  if ($("jstNotifyUsers")) $("jstNotifyUsers").value = (g.notify_users || []).join(",");
  JST_PENDING_N = JST_AUTO.pending_count || 0;   // 状态区据此显示「去处理」按钮
  renderJstTargets(wh.targets || []);
  jstWindowChanged();
  const jit = Number(wh.jitter_minutes || 0);
  jstSetText("jstNextRuns", (JST_AUTO.next_runs || []).length
    ? `下次执行：${JST_AUTO.next_runs.join("、")}` + (jit ? `（已开启 ±${jit} 分钟随机浮动）` : "")
    : (wh.enabled ? "⚠ 已启用定时但没填执行时间，不会自动跑" : "未启用定时（仍可手动执行）"));
  renderJstStatus(JST_AUTO.status || {}, JST_AUTO.last_run || {});
  if ((JST_AUTO.status || {}).running) startJstPoll(); else loadJstHistory();
}

async function loadJstAutoPage() {
  stopJstPoll();
  try {
    fillJstAuto(await api("/api/jst-auto/settings"));
  } catch (e) { toast("加载自动出库设置失败：" + e.message); }
}

async function saveJstAuto(opts) {
  const o = opts || {};
  if (o.clearCookie && !confirm("确认清空已保存的聚水潭 Cookie？（下次执行会用账号密码重新登录）")) return;
  const g = (JST_AUTO && JST_AUTO.globals) || {};
  const sel = $("jstTargets");
  const payload = {
    globals: {
      account: ($("jstAccount")?.value || "").trim(),
      password: $("jstPassword")?.value || "",
      cookie: ($("jstCookie")?.value || "").trim(),
      owner_co_id: ($("jstOwner")?.value || "").trim(),
      min_interval: jstNum("jstMinInterval", 10),
      timeout: jstNum("jstTimeout", 120),
      max_retries: jstNum("jstRetries", 3),
      io_date_field: g.io_date_field || "io_date",
      filename_template: g.filename_template || "",
      clear_cookie: !!o.clearCookie,
      notify_webhook: ($("jstNotifyWebhook")?.value || "").trim(),
      notify_users: ($("jstNotifyUsers")?.value || "").split(",").map((s) => s.trim()).filter(Boolean),
    },
    warehouse: {
      enabled: !!$("jstEnabled")?.checked,
      targets: [...(sel?.selectedOptions || [])]
        .filter((x) => x.value)
        .map((x) => ({ co_id: x.value, name: x.dataset.name || x.textContent })),
      window: $("jstWindow")?.value || "yesterday",
      fixed_from: ($("jstFixedFrom")?.value || "").replace("T", " "),
      fixed_to: ($("jstFixedTo")?.value || "").replace("T", " "),
      schedule: ($("jstSchedule")?.value || "").split(",").map((s) => s.trim()).filter(Boolean),
      jitter_minutes: Number($("jstJitter")?.value || 0),
      auto_import: !!$("jstAutoImport")?.checked,
      skip_imported: !!$("jstSkipImported")?.checked,
      operator: ($("jstOperator")?.value || "").trim(),
    },
  };
  try {
    fillJstAuto(await api("/api/jst-auto/settings", "POST", payload));
    toast(o.clearCookie ? "已清空 Cookie" : "已保存自动出库设置");
  } catch (e) { toast("保存失败：" + e.message); }
}

async function checkJstLogin() {
  jstSetText("jstCheckResult", "检查中…（聚水潭有限速，可能要十几秒）");
  try {
    const r = await api("/api/jst-auto/check", "POST");
    jstSetText("jstCheckResult", (r.ok ? "✅ " : "❌ ") + (r.message || ""));
  } catch (e) { jstSetText("jstCheckResult", "❌ " + e.message); }
}

async function loadJstWarehouseOptions() {
  jstSetText("jstCheckResult", "正在拉取聚水潭分仓列表…");
  try {
    const r = await api("/api/jst-auto/jst-warehouses", "POST");
    if (!r.ok) { jstSetText("jstCheckResult", "❌ " + (r.message || "拉取失败")); return; }
    const cur = [...($("jstTargets")?.selectedOptions || [])].map((x) => ({ co_id: x.value, name: x.dataset.name || x.textContent }));
    (r.warehouses || []).forEach((w) => JST_WH_OPTS.set(String(w.co_id), w.name));
    renderJstTargets(cur);
    jstSetText("jstCheckResult", `✅ 拉到 ${(r.warehouses || []).length} 个聚水潭分仓；勾选后点「保存设置」`);
  } catch (e) { jstSetText("jstCheckResult", "❌ " + e.message); }
}

async function runJstAuto(dry) {
  if (dry && !confirm("只导出试跑：会真的去聚水潭导出文件，但不会在本分仓建出库单。继续？")) return;
  if (!dry && !confirm("立即执行：按当前设置导出并直接在本分仓建出库单。继续？")) return;
  try {
    const r = await api("/api/jst-auto/run", "POST", { do_import: !dry });
    toast(r.message || "已开始执行");
    renderJstStatus({ running: true, warehouse: r.warehouse, step: "已启动", trigger: dry ? "手动试跑" : "手动", started_at: new Date().toLocaleString() }, {});
    startJstPoll();
  } catch (e) { toast("启动失败：" + e.message); }
}

async function refreshJstStatus() {
  try {
    const st = await api("/api/jst-auto/status");
    renderJstStatus(st, {});
    if (st.running) startJstPoll(); else loadJstHistory();
  } catch (e) { toast("读取状态失败：" + e.message); }
}

async function loadJstHistory() {
  const t = $("jstHistoryTable");
  if (!t) return;
  try {
    const d = await api("/api/jst-auto/history?limit=20");
    const rows = d.runs || [];
    t.innerHTML = `<thead><tr>
        <th>时间</th><th>触发</th><th>结果</th><th>导出区间</th>
        <th class="num">建单</th><th class="num">跳过重复</th><th>文件 / 说明</th>
      </tr></thead><tbody>` +
      (rows.length ? rows.map((r) => {
        const s = r.stats || {};
        return `<tr>
          <td class="mono">${esc(r.at || "")}</td>
          <td>${esc(r.trigger || "")}</td>
          <td>${r.ok ? '<span class="badge in">成功</span>' : '<span class="badge out">失败</span>'}</td>
          <td class="mono">${esc(r.window || "")}</td>
          <td class="num">${s.created != null ? s.created : "—"}</td>
          <td class="num">${s.duplicate_skipped != null ? s.duplicate_skipped : "—"}</td>
          <td>${esc(r.message || "")}${(r.files || []).length ? `<div class="muted mono" style="font-size:11px;">${esc(r.files.join("、"))}</div>` : ""}</td>
        </tr>`;
      }).join("") : `<tr><td colspan="7" class="empty">还没有执行记录</td></tr>`) + `</tbody>`;
  } catch (e) { /* 忽略：历史读不到不影响设置 */ }
}

/* =============== 待办处理（挂在「设置 → 自动出库设置」页里，不单开侧边栏） ===============
   自动出库需要人工介入的两类事：新商品没规则匹配（补关联）、聚水潭要验证码（填码/贴 Cookie）。 */
let EVA_TASKS = [];
let JST_PENDING_N = 0;          // 当前分仓待办数（设置页状态区据此提示）
let JST_PENDING_POPPED = false; // 本次登录只弹一次

/* 出库页那个「待办处理」按钮：待办数 = 聚水潭待办（新商品没规则匹配 / 要验证码）+ AI 识别待办 */
function jstPendingBtnState() {
  const b = $("jstPendingBtn");
  if (!b) return;
  const jst = JST_PENDING_N || 0;
  const ai = aiQueuePendingCount();
  const n = jst + ai;
  b.className = n ? "btn danger" : "btn secondary";
  b.textContent = n ? `⚠ 待办处理（${n}）` : "待办处理";
  b.title = n
    ? [
        jst ? `聚水潭待办 ${jst} 项（新商品没规则匹配 / 要验证码）` : "",
        ai ? `AI 识别待办 ${ai} 项（识别完待审核提交）` : "",
        "点这里处理",
      ].filter(Boolean).join("；")
    : "暂无待办；聚水潭遇到新商品没规则匹配、或需要验证码，以及 AI 识别完待审核时，都会在这里处理";
}

/* 打开待办弹层（出库页按钮、登录弹窗「去处理」、自动出库设置页的提示都走这里） */
async function openJstPending() {
  const d = await checkJstPending(false);
  EVA_TASKS = (d && d.tasks) || [];
  $("modalBox").classList.add("wide");
  openModal(`<h3>待办处理 <span class="muted">${EVA_TASKS.length ? `（${EVA_TASKS.length} 项待处理）` : ""}</span>
      <button class="close" onclick="closeModal()">✕</button></h3>
    <div class="hint" style="margin-bottom:10px;">自动出库 / 导入聚水潭出库单时遇到「新商品没有规则匹配」「聚水潭要验证码」都在这里处理；
      处理完点各项下面的按钮，系统会自动接着重跑（商品资料类只重新导入已下载的文件，不再去聚水潭导一遍）。</div>
    <div id="jstPendingList"></div>
    <div class="modal-foot">
      <button class="btn secondary" onclick="openJstPending()">刷新</button>
      <button class="btn" onclick="closeModal()">关闭</button>
    </div>`);
  renderEvaTasks(EVA_TASKS);
  if (d && d.running) startJstPoll();
}
/* 兼容旧调用名（状态区提示、登录弹窗「去处理」） */
function jstScrollPending() { openJstPending(); }

function evaProductOptions() {
  return ['<option value="">（选择系统商品…）</option>']
    .concat((PRODUCTS || []).filter((p) => p.is_active !== false).map((p) =>
      `<option value="${p.id}">${esc(p.name)}（${p.product_type === "order" ? "订单" : "库存"} · ${esc(p.category || "—")}）</option>`))
    .join("");
}

/* 候选商品一键选进下拉框 */
function evaSuggest(btn, pid) {
  const sel = btn.closest("tr") ? btn.closest("tr").querySelector("select.eva-pick") : null;
  if (sel) { sel.value = String(pid); toast("已选中候选商品，记得点「完成并重新导入」"); }
}

/* 收集这条待办里用户选好的关联 */
function evaCollect(tid) {
  const box = $("eva-body-" + tid);
  if (!box) return [];
  return [...box.querySelectorAll("select.eva-pick")]
    .map((s) => ({ external_code: s.dataset.code, product_id: s.value ? +s.value : null }))
    .filter((m) => m.external_code && m.product_id);
}

function evaUnmappedCard(t) {
  const opts = evaProductOptions();
  const rows = (t.items || []).map((it) => {
    const sug = (it.suggest || []).slice(0, 3).map((s) =>
      `<button class="btn sm ghost" style="margin:2px 4px 0 0;" onclick="evaSuggest(this, ${s.product_id})">${esc(s.name)}${s.score ? `（${Math.round(s.score * 100)}%）` : ""}</button>`).join("");
    return `<tr>
      <td><b>${esc(it.external_code)}</b>
        ${it.spec ? `<div class="muted" style="font-size:11px;">规格 ${esc(it.spec)}</div>` : ""}
        ${it.reason ? `<div class="muted" style="font-size:11px;">${esc(it.reason)}</div>` : ""}</td>
      <td class="num">${it.count || 0}</td>
      <td>
        <select class="searchable eva-pick" data-code="${esc(it.external_code)}" style="min-width:240px;">${opts}</select>
        ${sug ? `<div class="field-hint">候选：${sug}</div>` : ""}
      </td>
    </tr>`;
  }).join("");
  return `<div class="card" style="border:1px solid var(--amber, #f59e0b);">
    <div class="card-head">
      <h3>🆕 商品资料待补全（${(t.items || []).length} 种）</h3>
      <span class="hint">${esc(t.message)}</span>
    </div>
    <div id="eva-body-${t.id}">
      <div class="table-wrap"><table>
        <thead><tr><th style="width:42%;">聚水潭商品名</th><th class="num" style="width:80px;">出现次数</th><th>关联到系统商品</th></tr></thead>
        <tbody>${rows || `<tr><td colspan="3" class="empty">没有明细</td></tr>`}</tbody>
      </table></div>
    </div>
    <div class="toolbar" style="margin-top:10px;">
      <button class="btn green" onclick="evaResolve('${t.id}')">✔ 完成并重新导入</button>
      <button class="btn" title="商品资料维护好之后点它：只自动关联名称/编码 100% 完全一致的商品，不做相似度猜测"
        onclick="evaRematch('${t.id}')">⚡ 重新完全匹配（100% 同名，自动出库）</button>
      <button class="btn secondary" onclick="location.hash='#/settings?tab=jushuitan';">去「聚水潭关联」维护</button>
      <button class="btn sm ghost" onclick="evaDismiss('${t.id}')">忽略</button>
      <span class="muted">区间 ${esc(t.window || "")} · 文件 ${esc((t.files || []).join("、"))} · ${esc(t.created_at || "")}</span>
    </div>
  </div>`;
}

function evaCaptchaCard(t) {
  const reason = t.reason === "not_logged_in" ? "聚水潭登录态失效" : "聚水潭要求验证码 / 二次校验";
  return `<div class="card" style="border:1px solid var(--red, #dc2626);">
    <div class="card-head">
      <h3>🔐 ${reason}</h3>
      <span class="hint">${esc(t.message)}</span>
    </div>
    <div class="form-grid">
      <div class="field">
        <label>验证码${t.has_verify_code ? "（已填过一次，可重填）" : ""}</label>
        <input id="evaCode-${t.id}" placeholder="聚水潭发来的验证码（最新一条）" />
        ${t.sms_verifiable ? '<div class="field-hint">提交后会先把验证码交给聚水潭校验，通过才重新导出；<b>请填最新一条短信</b>（旧码会被后发的新码顶掉）</div>' : ""}
      </div>
      <div class="field">
        <label>或粘贴浏览器 Cookie（最稳，推荐）</label>
        <textarea id="evaCookie-${t.id}" rows="2" placeholder="浏览器登录 erp321 → F12 → Network → 任一请求 → 复制 Cookie 整段粘这里"></textarea>
        <div class="field-hint">粘贴 Cookie 不用等验证码，提交后立刻带着它重新导出</div>
      </div>
    </div>
    <div class="form-actions">
      <button class="btn green" onclick="evaResolve('${t.id}')">提交并重试</button>
      <button class="btn sm ghost" onclick="evaDismiss('${t.id}')">忽略</button>
      <span class="muted">区间 ${esc(t.window || "")} · 目标分仓 ${esc((t.targets || []).map((x) => x.name || x.co_id).join("、"))} · ${esc(t.created_at || "")}</span>
    </div>
  </div>`;
}

/* 待办弹层：任务按钮左右排列，点哪个就在下面显示哪个的详情（不再把所有卡片纵向堆起来） */
function evaTaskLabel(t) {
  const kind = t.type === "unmapped" ? "新商品没规则" : "要验证码";
  const name = (t.message || "").replace(/\s+/g, " ").slice(0, 16);
  return `⚠ ${kind}${name ? "：" + name : ""}`;
}
function renderEvaTasks(tasks) {
  const box = $("jstPendingList");
  if (!box) return;
  // ① AI 识别待办：一条一个按钮，左右排列；待审核的直接进审核框，其余进待办页
  const aiItems = AI_QUEUE.filter((j) => ["waiting", "running", "done", "error"].includes(j.status));
  const aiBlock = aiItems.length
    ? `<div class="eva-sec-title">AI 识别待办（${aiItems.length}）</div>
       <div class="eva-btn-row">` +
      aiItems.slice(0, 30).map((j) => {
        const st = j.status === "done" ? "待审核" : (j.status === "running" ? "识别中" : (j.status === "waiting" ? "排队中" : "失败"));
        const click = j.status === "done" ? `evaReviewFromModal('${j.id}')` : "openEvaPage()";
        return `<button class="btn sm ${j.status === "done" ? "" : "secondary"}" title="${esc(j.error || evaTitle(j))}" onclick="${click}">${esc(st)}·${esc(evaTitle(j).slice(0, 14))}</button>`;
      }).join("") + `</div>`
    : "";
  const aiFoot = aiItems.length
    ? `<div class="row" style="margin:-2px 0 10px;"><button class="btn sm secondary" onclick="openEvaPage()">打开 AI 待办页（批量审核 / 提交）→</button></div>`
    : "";
  if (!tasks.length) {
    box.innerHTML = aiBlock + aiFoot +
      `<div class="empty">${aiItems.length ? "聚水潭待办已清空 🎉" : "当前没有待办 🎉　自动出库正常时这里是空的。"}</div>`;
    return;
  }
  box.innerHTML = aiBlock + aiFoot +
    `<div class="eva-sec-title">聚水潭待办（${tasks.length}）</div>` +
    `<div class="alert warn">有 ${tasks.length} 项待处理，点按钮切换要处理的那条，处理完点下面的按钮，系统会自动接着重跑。</div>` +
    `<div class="eva-btn-row" id="evaTaskBtns">` +
    tasks.map((t, i) => `<button class="btn sm ${i === 0 ? "" : "secondary"}" data-i="${i}" onclick="evaShowTask(${i})">${esc(evaTaskLabel(t))}</button>`).join("") +
    `</div><div id="evaTaskDetail"></div>`;
  evaShowTask(0);
}
/** 切换待办弹层里当前显示的哪一条 */
function evaShowTask(i) {
  const box = $("evaTaskDetail");
  const t = (EVA_TASKS || [])[i];
  if (!box || !t) return;
  box.innerHTML = t.type === "unmapped" ? evaUnmappedCard(t) : evaCaptchaCard(t);
  document.querySelectorAll("#evaTaskBtns .btn").forEach((b) => {
    b.className = "btn sm" + (+b.dataset.i === i ? "" : " secondary");
  });
  try { bindSearchable(box); } catch (e) {}
}
function openEvaPage() { closeModal(); goPage("eva"); }
function evaReviewFromModal(id) { closeModal(); goPage("eva"); evaReview(id); }

/* 刷新待办：更新按钮上的条数；弹层开着就顺带刷新里面的内容 */
async function renderJstPending() {
  if (!PRODUCTS.length) { try { PRODUCTS = await api("/api/products"); } catch (e) {} }
  const d = await checkJstPending(false);   // 里面会同步按钮状态
  EVA_TASKS = (d && d.tasks) || [];
  renderEvaTasks(EVA_TASKS);                // 弹层没开时 $("jstPendingList") 不存在，自动跳过
  if (d && d.running) startJstPoll();
}

async function evaResolve(tid) {
  const task = (EVA_TASKS || []).find((t) => t.id === tid);
  if (!task) { toast("待办已变化，请刷新后重试"); return; }
  const payload = { mappings: [], verify_code: "", cookie: "", note: "" };
  if (task.type === "unmapped") {
    payload.mappings = evaCollect(tid);
    if (!payload.mappings.length && !confirm("还没选任何商品关联，仍要按现有配置重跑一次吗？")) return;
  } else {
    payload.verify_code = ($("evaCode-" + tid)?.value || "").trim();
    payload.cookie = ($("evaCookie-" + tid)?.value || "").trim();
    if (!payload.verify_code && !payload.cookie) { toast("请填验证码，或粘贴浏览器 Cookie"); return; }
  }
  try {
    const r = await api(`/api/jst-auto/pending/${encodeURIComponent(tid)}/resolve`, "POST", payload);
    toast(r.message || "已提交，正在重跑");
    startJstPoll();
    setTimeout(() => { renderJstPending(); checkJstPending(false); }, 2500);
  } catch (e) { toast("提交失败：" + e.message); }
}

/* 重新完全匹配：商品资料维护好后一键按「100% 同名」自动关联并重新出库（不做相似度猜测）
 * 后端只认名称/编码完全一致（忽略空格与大小写），命中的自动关联并立即重新导入，
 * 其余仍留在待办里等人工选择；对已经在待办里的老任务同样有效（按名字匹配，不依赖任务创建时间）。 */
async function evaRematch(tid) {
  if (!confirm("按「名称 / 编码 100% 完全相同」重新匹配这条待办？\n\n"
    + "· 只自动关联与系统商品完全同名的项（忽略空格/大小写）\n"
    + "· 不做任何相似度猜测，避免像「新鲜百合 50%」那种误配\n"
    + "· 命中的立即自动重新导入出库，其余仍留在待办里人工选择")) return;
  try {
    const r = await api(`/api/jst-auto/pending/${encodeURIComponent(tid)}/rematch`, "POST", { dry_run: false });
    const ms = (r.matched || []).map((x) => `· ${x.external_code} → ${x.product_name}`).join("\n");
    const ls = (r.left || []).map((x) => `· ${x.external_code}`).join("\n");
    toast(r.message || "已提交");
    if (ms) {
      alert(`100% 同名自动关联 ${r.matched.length} 种：\n${ms}`
        + (ls ? `\n\n仍未匹配（请手工选择）：\n${ls}` : "")
        + (r.started ? "\n\n已开始重新导入出库，可点「刷新」看进度。" : ""));
    }
    if (r.started) {
      startJstPoll();
      setTimeout(() => { renderJstPending(); checkJstPending(false); }, 2500);
    } else {
      renderJstPending(); checkJstPending(false);
    }
  } catch (e) { toast("重新匹配失败：" + e.message); }
}

async function evaDismiss(tid) {
  if (!confirm("忽略这条待办？不再提醒（已导入的数据不受影响）")) return;
  try {
    await api(`/api/jst-auto/pending/${encodeURIComponent(tid)}/dismiss`, "POST");
    toast("已忽略");
    renderJstPending(); checkJstPending(false);
  } catch (e) { toast("操作失败：" + e.message); }
}

/* 登录后/打开设置页时检查待办：有就弹窗提醒（站内，不依赖短信或邮箱） */
async function checkJstPending(popup) {
  try {
    const d = await api("/api/jst-auto/pending");
    JST_PENDING_N = d.count || 0;
    jstPendingBtnState();   // 同步出库页那个按钮（有待办时变红显示条数）
    if (popup !== false && JST_PENDING_N && d.notify && !JST_PENDING_POPPED) {
      JST_PENDING_POPPED = true;
      const kinds = [...new Set(d.tasks.map((t) => (t.type === "unmapped" ? "商品资料待补全" : "聚水潭要验证码")))];
      openModal(`<h3>有 ${JST_PENDING_N} 项待办要处理 <button class="close" onclick="closeModal()">✕</button></h3>
        <div class="muted">${esc(d.warehouse_name)}：${esc(kinds.join(" / "))}</div>
        <ul style="margin:10px 0 0 20px;line-height:1.8;">${d.tasks.slice(0, 5).map((t) => `<li>${esc(t.message)}</li>`).join("")}</ul>
        <div class="modal-foot">
          <button class="btn secondary" onclick="closeModal()">稍后处理</button>
          <button class="btn primary" onclick="closeModal(); jstScrollPending();">去处理（设置 → 自动出库设置）</button>
        </div>`);
    }
    return d;
  } catch (e) { return null; }
}

/* =============== 库存流水 =============== */
/* 明细表分页状态：翻页 / 搜索 / 排序 / 合并出库都在后端做（只有后端知道总数），
   这里只记住「第几页、每页多少条」。以前明细接口写死 limit(500)，
   而 wh01 近 30 天就有 1.9 万条流水 —— 等于 96% 静默看不到，现在改成完整翻页。 */
let mvPage = 0;
let mvSize = 100;

function mvResetPage() { mvPage = 0; }
function mvSetPage(n) { mvPage = Math.max(0, +n || 0); loadMovements(); }
function mvSetSize(v) { mvSize = +v || 100; mvPage = 0; loadMovements(); }

/* 搜索由后端做，所以输入要防抖，否则每敲一个字都发一次请求 */
let mvSearchTimer = null;
function onMvSearch() {
  clearTimeout(mvSearchTimer);
  mvSearchTimer = setTimeout(() => { mvPage = 0; loadMovements(); }, 300);
}

async function loadMovements() {
  const pid = $("mvProduct").value || "0";
  const from = $("mvDateFrom").value, to = $("mvDateTo").value;
  const t = $("mvTable");
  // 表头点击由通用处理器写进 t._sort（dir: 1 升 / -1 降）
  const s = t._sort || { key: "date", dir: -1 };
  const mergeOut = $("mvMergeOut") ? $("mvMergeOut").checked : true;
  const qs = new URLSearchParams({
    product_id: pid, date_from: from || "", date_to: to || "",
    keyword: (($("mvSearch") && $("mvSearch").value) || "").trim(),
    merge_out: mergeOut ? "true" : "false",
    sort: s.key, dir: s.dir === 1 ? "asc" : "desc",
    limit: String(mvSize), offset: String(mvPage * mvSize),
  });
  // 明细与图表分开取：图表走聚合接口，口径只含真实库存进出，且不受分页影响
  const [res, chart] = await Promise.all([
    api(`/api/movements?${qs}`),
    api(`/api/movements/chart?product_id=${pid}&date_from=${from || ""}&date_to=${to || ""}`),
  ]);
  mvChartData = chart;
  renderMvChart(chart);
  renderMvTable(res);
  renderMvPager(res);
}

function renderMvTable(res) {
  const t = $("mvTable");
  const rows = (res && res.rows) || [];
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
      const mg = m._merged;   // 合并行由后端给出（同一商品 + 同一每单扣减量）
      const v = m.quantity_display != null ? m.quantity_display : m.quantity_base;
      const unit = m.unit || "";
      // 变动列：合并行显示「每单扣减量 × 单数 = 合计」
      const changeCell = mg
        ? `<td class="num mono" style="color:var(--red)">-${fmtNum(Math.abs(mg.per))} ${esc(unit)}/单 × ${mg.count} 单`
          + `<div style="font-weight:600;">合计 -${fmtNum(Math.abs(mg.total))} ${esc(unit)}</div></td>`
        : `<td class="num mono" style="color:${v >= 0 ? "var(--green)" : "var(--red)"}">${v >= 0 ? "+" : ""}${fmtNum(v)} ${esc(unit)}</td>`;
      const typeCell = mg
        ? `${typeBadge.out}<div class="muted" style="font-size:11px;">×${mg.count} 单</div>`
        : (typeBadge[m.move_type] || m.move_type);
      const noteCell = mg
        ? `<span class="muted">已合并 ${mg.count} 笔${mg.days > 1 ? `（跨 ${mg.days} 天）` : ""}</span>`
          + `<div class="muted" style="font-size:11px;" title="${esc(mg.codes.join("、"))}${mg.more ? `（另有 ${mg.more} 个单号）` : ""}">`
          + `${esc(mg.codes.slice(0, 3).join("、"))}${mg.codes.length > 3 ? " …" : ""}</div>`
        : `<span class="muted">${esc(m.remark)}</span>`;
      return `<tr${mg ? ' class="mv-merged"' : ""}>
      <td class="mono">${esc(m.date)}</td>
      <td>${esc(m.product_name)}</td>
      <td>${typeCell}</td>
      ${changeCell}
      <td class="num mono">${fmtMoney(m.amount)}</td>
      <td>${esc(m.operator) || "—"}</td>
      <td>${noteCell}</td></tr>`;
    }).join("") + `</tbody>`;
  if (!rows.length) {
    const kw = (($("mvSearch") && $("mvSearch").value) || "").trim();
    t.innerHTML = `<tr><td colspan="7" class="empty">${kw ? `没有匹配「${esc(kw)}」的流水` : "该条件暂无流水"}</td></tr>`;
  }
  t._rows = rows;
  t._render = loadMovements;   // 点表头排序 → 重新请求（排序在后端做，保证全局有序）
}

/* 分页条：总数 / 页码 / 每页条数。顺带写明口径 ——
   表格是完整流水（含工作量、包装消耗），图表只统计真实库存进出。 */
function renderMvPager(res) {
  const p = $("mvPager");
  if (!p) return;
  const total = (res && res.total) || 0;
  const size = (res && res.limit) || mvSize;
  const off = (res && res.offset) || 0;
  const pages = Math.max(1, Math.ceil(total / size));
  const cur = Math.min(pages, Math.floor(off / size) + 1);
  const nav = (label, target, disabled) =>
    `<button class="btn sm secondary"${disabled ? " disabled" : ""} onclick="mvSetPage(${target})">${label}</button>`;
  p.innerHTML =
    `<span class="muted">第 ${fmtNum(total ? off + 1 : 0)}–${fmtNum(Math.min(off + size, total))} 条，`
    + `共 <b>${fmtNum(total)}</b> 条${res && res.merged ? "（出库已合并）" : ""}`
    + ` · 表格为完整流水，图表只统计真实库存进出</span>`
    + `<span class="pager-nav">`
    + nav("‹ 上一页", cur - 2, cur <= 1)
    + `<span class="pager-cur">第 ${cur} / ${pages} 页</span>`
    + nav("下一页 ›", cur, cur >= pages)
    + `<select onchange="mvSetSize(this.value)">${[50, 100, 200, 500, 1000]
      .map((n) => `<option value="${n}"${n === size ? " selected" : ""}>每页 ${n} 条</option>`).join("")}</select>`
    + `</span>`
    + (res && res.truncated
      ? `<span class="pager-warn">区间内流水过多，本次只处理了最新的一部分，请缩小时间范围</span>`
      : "");
}

/* 库存变动柱状图：数据来自 /api/movements/chart（后端按「日期 × 单位」聚合）。
   单商品 → 一组（该商品默认单位，如 公斤）；
   全部商品 → 每个展示单位一组（重量类后端已统一折算成公斤，个 / 瓶等计数单位各自一组）。
   单位不同就不能相加，所以每组各自成图、独立刻度，并在图上醒目地标出单位；
   只有零星几天有变动、占比也很小的单位不单独绘图，改为在图下用文字列出。

   注：出库行的「按扣减量合并」已挪到后端 /api/movements —— 合并必须发生在分页之前，
   否则「合计出库 N 单」会随翻页变化（同一批出库在不同页显示成不同的单数）。 */
let mvChartData = null;   // 最近一次图表数据，供切换刻度时原地重绘
let mvSplitScale = true;  // 上下是否各自独立刻度

const MV_FLAT_DAYS = 2; // 非零天数 ≤ 此值且占比很小的单位不单独绘图（画不出趋势）
const MV_FLAT_SHARE = 0.05;
const MV_WAN = 10000;

function mvToggleScale() {
  mvSplitScale = !mvSplitScale;
  if (mvChartData) renderMvChart(mvChartData);
}

/* 是否值得单独画一张图：每组独立刻度，所以关键看「有没有趋势」而不是「量大量小」 */
function mvHasTrend(s, grand) {
  const active = s.days.filter((d) => d.in || d.out).length;
  return active > MV_FLAT_DAYS || (s.total_in + s.total_out) / grand >= MV_FLAT_SHARE;
}

/* 柱顶数字用「万 / 亿」缩写，避免 9px 字号下长数字挤在一起（完整值见悬停提示） */
function fmtQtyShort(v) {
  v = Number(v) || 0;
  const a = Math.abs(v);
  if (a >= 1e8) return (v / 1e8).toFixed(a >= 1e9 ? 0 : 1).replace(/\.0$/, "") + "亿";
  if (a >= MV_WAN) return (v / MV_WAN).toFixed(a >= 1e6 ? 0 : 1).replace(/\.0$/, "") + "万";
  return fmtNum(Math.round(v));
}

/* 一组柱：上半绿=入库（贴中线向上）、下半红=出库（贴中线向下），柱顶标当天净变动。

   刻度有两种，用标题上的按钮切换（默认「上下独立」）：
   - 独立（默认）：两半各自按自己的峰值铺满。入库通常比出库大一个量级
     （aosidi 公斤 峰值 入 8,829 / 出 396，同一刻度时红柱只有 4.5% 高，等于看不见），
     独立刻度才能看清出库走势；代价是两向高度不能直接比。
   - 同一：两向共用峰值刻度，高度可比，但小量级那一向会被压平。 */
function mvColumns(days, unit) {
  const peakIn = Math.max(1, ...days.map((d) => d.in || 0));
  const peakOut = Math.max(1, ...days.map((d) => d.out || 0));
  const shared = Math.max(1, peakIn, peakOut);
  const maxOf = (side) => (mvSplitScale ? (side === "in" ? peakIn : peakOut) : shared);
  const h = (v, side) => (v > 0 ? Math.max(2, Math.round((v / maxOf(side)) * 100)) : 0);
  return days.map((d) => {
    const net = (d.in || 0) - (d.out || 0);
    const cls = net > 0 ? "up" : net < 0 ? "down" : "flat";
    const label = net ? (net > 0 ? "+" : "-") + fmtQtyShort(Math.abs(net)) : "";
    const tip = `${d.date}：入库 +${fmtNum(d.in)} ${unit} / 出库 -${fmtNum(d.out)} ${unit}`
      + ` / 净 ${net >= 0 ? "+" : "-"}${fmtNum(Math.abs(net))} ${unit}`;
    return `<div class="mv-col" title="${esc(tip)}">
        <span class="mv-val ${cls}">${label}</span>
        <div class="mv-pos"><div class="mv-bar" style="height:${h(d.in, "in")}%"></div></div>
        <div class="mv-neg"><div class="mv-bar down" style="height:${h(d.out, "out")}%"></div></div>
        <div class="mv-x">${d.date.slice(5)}</div></div>`;
  }).join("");
}

function renderMvChart(chart) {
  const box = $("mvChart");
  if (!box) return;
  const series = (chart && chart.series) || [];
  if (!series.length) {
    box.innerHTML = `<div class="mv-chart-title">该区间没有库存变动流水</div>`;
    return;
  }
  const grand = series.reduce((s, x) => s + x.total_in + x.total_out, 0) || 1;
  let mains = series.filter((s) => mvHasTrend(s, grand));
  let flat = series.filter((s) => !mvHasTrend(s, grand));
  if (!mains.length) { mains = [series[0]]; flat = series.slice(1); } // 极端情况兜底

  const head = (s) => {
    const peakIn = Math.max(0, ...s.days.map((d) => d.in || 0));
    const peakOut = Math.max(0, ...s.days.map((d) => d.out || 0));
    const scale = mvSplitScale
      ? `上下各自独立刻度（上半满格=入 ${fmtQtyShort(peakIn)}，下半满格=出 ${fmtQtyShort(peakOut)}，两向高度不可直接比）`
      : `上下同一刻度（满格=${fmtQtyShort(Math.max(peakIn, peakOut))}，两向高度可比）`;
    return `<div class="mv-chart-title">
        <span class="mv-unit-chip">单位：${esc(s.unit)}</span>
        <span class="mv-legend"><i class="up"></i>入库<i class="down"></i>出库</span>
        <span class="muted">柱顶=当天净变动 · ${scale}</span>
        <button class="btn-link mv-scale-btn" onclick="mvToggleScale()">刻度：${mvSplitScale ? "上下独立" : "上下同一"}（点此切换）</button>
      </div>`;
  };
  box.innerHTML =
    mains.map((s) => `<div class="mv-block">${head(s)}<div class="mv-chart">${mvColumns(s.days, s.unit)}</div></div>`).join("")
    + (flat.length
      ? `<div class="mv-note">另有 ${flat.map((s) => `${esc(s.unit)}：入 ${fmtNum(s.total_in)} / 出 ${fmtNum(s.total_out)}`).join("、")}`
        + `（只有零星几天有变动，未单独绘图，明细见下表）</div>`
      : "")
    + `<div class="mv-note muted">区间 ${esc(chart.date_from)} ~ ${esc(chart.date_to)}`
    + `；口径：只统计真实库存进出（不含人工/快递工作量、成本流水，也不含单位为「单」的单数流水）</div>`;
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

/* =============== 停服公告 / 系统维护页 =============== */
/* 状态由私钥管理后台（keyadmin「更新维护」）写入，经 GET /api/maintenance/status 下发：
   - announce    ：顶部滚动提示「还有 X 分钟停机维护」并倒计时，归零自动进维护页
   - maintenance ：整屏维护页，服务恢复（主服务再次启动）后自动返回
   - 接口 5xx / 不可达（主服务已停）：同样进维护页，恢复后自动返回 */
const MT_STATE = {
  timer: null, tick: null, misses: 0, maskOn: false, recovering: false,
  remaining: 0, eta: 0, message: "",
};
function mtEls() {
  return {
    bar: document.getElementById("noticeBar"),
    mask: document.getElementById("maintainMask"),
  };
}
async function mtFetchStatus() {
  const ctl = new AbortController();
  const to = setTimeout(() => ctl.abort(), 8000);
  try {
    const res = await fetch(routePath("/api/maintenance/status"), { cache: "no-store", signal: ctl.signal });
    if (!res.ok) return { ok: false, status: res.status };
    return { ok: true, data: await res.json() };
  } catch (e) {
    return { ok: false, status: 0 };
  } finally {
    clearTimeout(to);
  }
}
function mtStopTick() {
  if (MT_STATE.tick) { clearInterval(MT_STATE.tick); MT_STATE.tick = null; }
}
function mtPollInterval(ms) {
  if (MT_STATE.timer) clearInterval(MT_STATE.timer);
  MT_STATE.timer = setInterval(mtCheck, ms);
}
function mtNoticeText() {
  const sec = Math.max(0, Math.floor(MT_STATE.remaining));
  const m = Math.floor(sec / 60);
  const s = sec % 60;
  const eta = MT_STATE.eta ? `（预计维护 ${MT_STATE.eta} 分钟完成）` : "";
  const head = MT_STATE.message ? `${MT_STATE.message}　` : "";
  if (sec <= 0) return `${head}系统即将停机维护${eta}，请立即保存当前工作并退出，以免数据丢失。`;
  const left = m > 0 ? `${m} 分 ${String(s).padStart(2, "0")} 秒` : `${s} 秒`;
  return `${head}系统将于 ${left} 后停机维护${eta}，请及时保存当前工作并退出，以免数据丢失。`;
}
const MT_NOTICE_SPEED = 55; // 滚动速度（像素/秒）：与窗口宽度无关，宽屏窄屏观感一致

/* 按实际宽度铺满公告文本，保证「无论窗口多宽都在滚、且没有空白段」：
   把文本复制 n 份组成一组，轨道里放两组，位移一组宽度（-50%）即无缝循环。
   n 取到「一组宽度 ≥ 视口宽度 + 一份宽度」，宽屏时自动多铺几份。 */
function mtBuildNoticeTrack(text) {
  const { bar } = mtEls();
  if (!bar) return;
  const vp = bar.querySelector(".notice-viewport");
  const track = bar.querySelector(".notice-track");
  if (!vp || !track) return;

  track.style.animation = "none";
  track.innerHTML = "";
  const probe = document.createElement("span");
  probe.className = "notice-text";
  probe.textContent = text;
  track.appendChild(probe);
  const unitW = probe.getBoundingClientRect().width || 200;
  const vpW = vp.clientWidth || 1;
  const n = Math.max(1, Math.ceil((vpW + unitW) / unitW));

  track.innerHTML = "";
  const spans = [];
  for (let g = 0; g < 2; g++) {
    for (let i = 0; i < n; i++) {
      const s = document.createElement("span");
      s.className = "notice-text";
      s.textContent = text;
      spans.push(s);
      track.appendChild(s);
    }
  }
  track._spans = spans;
  const dur = Math.max(10, Math.round((n * unitW) / MT_NOTICE_SPEED));
  track.style.animation = `noticeScroll ${dur}s linear infinite`;
}

function mtShowNotice() {
  const { bar } = mtEls();
  if (!bar) return;
  const t = mtNoticeText();
  bar.style.display = "flex";
  document.body.classList.add("notice-on");
  const track = bar.querySelector(".notice-track");
  if (!track) return;
  if (!track._spans || !track._spans.length) {
    mtBuildNoticeTrack(t); // 首次显示 / 窗口尺寸变化后重建轨道
    return;
  }
  // 只改文字、不重建节点，滚动动画不会被打断（倒计时每秒都在变）
  track._spans.forEach((s) => { s.textContent = t; });
}

/* 窗口尺寸变化后按新宽度重新铺文本（窄屏 → 宽屏时原本可能只剩几份） */
let mtResizeTimer = null;
function mtOnResize() {
  if (!MT_STATE.noticeOn) return;
  clearTimeout(mtResizeTimer);
  mtResizeTimer = setTimeout(() => {
    const track = document.querySelector(".notice-track");
    if (track) track._spans = null;
    mtShowNotice();
  }, 300);
}
function mtHideNotice() {
  const { bar } = mtEls();
  if (bar) bar.style.display = "none";
  document.body.classList.remove("notice-on");
}
function mtEnterMaintenance(opts) {
  opts = opts || {};
  mtStopTick();
  mtHideNotice();
  const { mask } = mtEls();
  if (!mask) return;
  const title = document.getElementById("mtTitle");
  const sub = document.getElementById("mtSub");
  const info = document.getElementById("mtInfo");
  const foot = document.getElementById("mtFoot");
  if (opts.offline) {
    title.textContent = "系统暂时不可用";
    sub.textContent = "系统正在进行维护，请稍后再试。";
    info.innerHTML = "页面会自动检测服务状态，恢复后自动返回，无需手动刷新。";
  } else {
    title.textContent = "系统维护中";
    sub.textContent = opts.message || "系统正在停机维护，给您带来不便敬请谅解。";
    info.innerHTML = opts.eta ? `预计维护时长约 <b>${opts.eta} 分钟</b>，请稍后重新访问。` : "请稍后重新访问。";
  }
  if (foot) foot.textContent = "正在检测服务状态，服务恢复后会自动返回…";
  mask.style.display = "flex";
  MT_STATE.maskOn = true;
  MT_STATE.recovering = false;
  mtPollInterval(3000); // 维护中加快检测频率
}
function mtRecover() {
  if (MT_STATE.recovering) return;
  MT_STATE.recovering = true;
  mtStopTick();
  const foot = document.getElementById("mtFoot");
  if (foot) foot.textContent = "服务已恢复，正在返回系统…";
  setTimeout(() => location.reload(), 1200);
}
function mtStartCountdown(st) {
  MT_STATE.remaining = st.remaining_seconds || 0;
  MT_STATE.eta = st.eta_minutes || 0;
  MT_STATE.message = st.message || "";
  mtShowNotice();
  if (MT_STATE.tick) return;
  MT_STATE.tick = setInterval(() => {
    MT_STATE.remaining -= 1;
    if (MT_STATE.remaining <= 0) {
      mtStopTick();
      mtCheck(); // 以服务端为准：到期服务端会返回 maintenance
      return;
    }
    mtShowNotice();
  }, 1000);
}
async function mtCheck() {
  const r = await mtFetchStatus();
  if (!r.ok) {
    MT_STATE.misses += 1;
    // 502/503/504：后端已停（典型停服场景）→ 立刻上维护页；网络抖动则连续 2 次再上
    if (!MT_STATE.maskOn && (r.status >= 500 || MT_STATE.misses >= 2)) {
      mtEnterMaintenance({ offline: true });
    }
    return;
  }
  MT_STATE.misses = 0;
  const st = r.data || {};
  const mode = st.mode || "off";
  if (mode === "maintenance") {
    mtEnterMaintenance({ eta: st.eta_minutes, message: st.message });
    return;
  }
  if (mode === "announce" && (st.remaining_seconds || 0) > 0) {
    if (MT_STATE.maskOn) { mtRecover(); return; } // 维护计划被取消，直接返回
    mtPollInterval(15000);
    mtStartCountdown(st);
    return;
  }
  if (MT_STATE.maskOn) { mtRecover(); return; }
  mtStopTick();
  mtHideNotice();
}
function startMaintenanceWatch() {
  if (MT_STATE.timer) return;
  window.addEventListener("resize", mtOnResize);
  mtPollInterval(15000);
  mtCheck();
}

/* ---------- 初始化 ---------- */
(async function init() {
  try {
    const cfg = await fetch("/config.json", { cache: "no-store" }).then((r) => r.json());
    Object.assign(ROUTES, cfg.routes || {});
  } catch (e) {}
  startMaintenanceWatch(); // 停服公告 / 系统维护页：先于登录检测，维护中不暴露登录界面
  showLogin();
  try {
    const me = await api("/api/auth/me");
    setUser(me);
    hideLogin();
  } catch (e) {
    return; // 未登录，停留在登录页
  }
  // 预设默认日期范围：入库记录本月，出库记录当天（入库单的日期在每行里各自默认今天）
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
    await ensureUnits(0);   // 单位表走统一入口，顺带记下时间戳
  } catch (e) { PRODUCTS = PRODUCTS || []; UNITS = UNITS || []; }
  try {
    $("mvProduct").innerHTML = `<option value="0">全部商品</option>` +
      PRODUCTS.filter((p) => !["人工", "快递"].includes(p.category)).map((p) => `<option value="${p.id}">${esc(p.name)}</option>`).join("");
    const adjF = $("adjProductFilter");
    if (adjF) adjF.innerHTML = `<option value="0">全部商品</option>` +
      PRODUCTS.filter((p) => p.is_active && p.product_type === "stock" && !["人工", "快递"].includes(p.category)).map((p) => `<option value="${p.id}">${esc(p.name)}</option>`).join("");
  } catch (e) {}
  try { bindSearchable(document); } catch (e) {}
  applyNavVisibility();     // 侧边栏按本机偏好显隐（设置 → 模块显示）
  syncExcludeOtherHint();   // 报表页「排除其他开支」开关按本机偏好回显（默认开启）
  loadDashboard();
  aiQueueLoad();    // AI 识别队列（待办处理）：恢复上次未处理完的识别结果，并继续跑排队中的任务
  aiQueueTick();
  applyHashRoute(); // 支持深链：登录后跳转到指定二级页
  checkJstPending(); // 自动出库待办（商品资料待补全 / 需要验证码）：有就弹窗提醒
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
    hint: "上传聚水潭导出的「销售出库单_*.xlsx」，自动识别商品并按件数×每件规格结算。先解析预览（自动试算 AI 新增方案），确认后才出库。未关联商品可点「去新增商品」在新标签页新建，或一键确认 AI 自动新增。「仓储方」为芳谊放单仓的订单，确认框里会逐单让你填刷单成本，并核算结算价与最终利润。",
  },
};
/* 放单仓名单（后端下发，见 backend/app/brush.py 的 BRUSH_WAREHOUSES）：
   这些「仓储方」的聚水潭订单要在确认框里逐单填刷单成本，核算结算价与最终利润。 */
let __BRUSH_WH__ = [];
let __BRUSH_HIT__ = [];   // 本次解析里真正命中的放单仓（有它就不自动跑 AI 归并）
function isBrushOrder(o) { return !!o && !!o.warehouse && __BRUSH_WH__.includes(o.warehouse); }
function isBrushBatch() { return (__BRUSH_HIT__ || []).length > 0; }
function openBatchModal(kind) {
  const cfg = BATCH_MODAL[kind];
  if (!cfg) return;
  $("modalBox").classList.remove("wide"); // 汇总预览会加宽弹窗，回到选文件界面时还原
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
  // 结果预览会把 modalBox 内容整体替换掉，此时 #bmResult 已不存在（旧代码在这里抛错 → 点「重新解析」没反应），
  // 故进度提示回退到弹窗主体。
  const box = $("bmResult") || $("modalBox");
  if (box) box.innerHTML = `<div class="alert ok">⏳ 正在解析…（同一文件）</div>`;
  try {
    const r = await apiUpload(cfg.preview, file);
    if (kind === "jushuitan") {
      __BRUSH_WH__ = r.brush_warehouse_names || [];   // 放单仓名单（配置）
      __BRUSH_HIT__ = r.brush_warehouses || [];       // 本次解析命中的放单仓
    }
    if (kind === "inbound") renderInboundReview(kind, r);
    else renderDraftReview(kind, r);
  } catch (e) {
    if (box) box.innerHTML = `<div class="alert err">解析失败：${esc(e.message)}</div>`;
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
    if (kind === "jushuitan") {
      // 每个未关联商品名都带「去新增商品」按钮：新标签页打开「商品」页并按该名称预填新增弹窗。
      // AI 自动新增在页面渲染后自动试算（不落库），把方案展示出来，用户确认后才真正新增。
      const unmapDetail = {};
      (r.unmapped || []).forEach((u) => { unmapDetail[u.external_code] = u; });
      const hasStockOnly = (r.unmapped || []).some((u) => u.stock_product_name);
      warn += `<div class="alert warn">
        <div>⚠ 未关联商品 <b>${r.unmapped_codes.length}</b> 个。可点「去新增商品」在新标签页按该名称新建商品（保存后回到本页点「↻ 重新解析」即按名称自动匹配），或等下方 AI 方案出来后一键新增：</div>
        ${hasStockOnly ? `<div class="muted" style="font-size:12px;margin:4px 0;">带「缺关联结算小类」标签的，是平台商品名只匹配到了库存大类（未扣任何库存）—— 新建订单小类并关联该大类后重新解析即可正常结算。</div>` : ""}
        <div class="unmapped-list">${r.unmapped_codes.map((c) => unmappedChip(c, unmapDetail[c])).join("")}</div>
        <div id="bmAiBox"></div>
      </div>`;
    } else {
      warn += `<div class="alert warn">⚠ 未关联商品：${r.unmapped_codes.map(esc).join("、")}` +
        `<div class="muted" style="font-size:12px;margin-top:6px;">请到「编码关联」关联后重新解析。</div></div>`;
    }
  } else {
    window.__LAST_UNMAPPED__ = [];
  }
  if (r.skip && Object.values(r.skip).some((v) => v > 0)) warn += `<div class="alert warn">⚠ 跳过：${Object.entries(r.skip).filter(([, v]) => v > 0).map(([k, v]) => `${k} ${v}单`).join("、")}</div>`;
  if (r.failed && r.failed.length) warn += `<div class="alert err">解析失败 ${r.failed.length} 条：${r.failed.slice(0, 5).map((f) => esc(f.reason)).join("；")}</div>`;
  if (!orders.length) {
    $("modalBox").innerHTML = `<h3>${BATCH_MODAL[kind].title} <button class="close" onclick="closeModal()">✕</button></h3>
      <div class="alert warn">未解析出可出库的单据。</div>${warn}
      <div class="modal-foot"><button class="btn secondary" onclick="openBatchModal('${kind}')">返回重新选择</button>` +
      (kind === "jushuitan" ? `<button class="btn" onclick="runBatchModal('jushuitan')">↻ 重新解析（同一文件）</button>` : "") +
      `</div>`;
    scheduleAiAutoPreview(kind);
    return;
  }
  // 聚水潭：不逐单展示，改为汇总相同商品名的总体预览
  if (kind === "jushuitan") {
    renderAggregateReview(kind, orders, warn);
    scheduleAiAutoPreview(kind);
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
      ${kind === "jushuitan" ? `<button class="btn secondary" onclick="runBatchModal('jushuitan')">↻ 重新解析（同一文件）</button>` : ""}
      <button class="btn green" onclick="confirmDraft('${kind}')">✓ 确认出库（<span id="draftCount">${orders.length}</span> 单）</button>
    </div>`;
  scheduleAiAutoPreview(kind);
}
/* 汇总相同商品名（同单位）的明细：订单数 / 总数量 / 均价 / 每单金额 / 总金额 */
function aggregateDraftLines(orders) {
  const map = new Map();
  orders.forEach((o) => {
    (o.lines || []).forEach((l) => {
      const key = (l.product_name || "") + "\u0000" + (l.unit || "");
      let g = map.get(key);
      if (!g) {
        g = { name: l.product_name, unit: l.unit, deduct: "", docs: new Set(), qty: 0, amount: 0 };
        map.set(key, g);
      }
      g.docs.add(o.doc_no || "");
      g.qty += +l.quantity || 0;
      g.amount += +l.amount || 0;
      if (!g.deduct && l.deduct) g.deduct = l.deduct;
    });
  });
  return [...map.values()].map((g) => {
    const n = g.docs.size;
    return {
      name: g.name, unit: g.unit, deduct: g.deduct, orders: n, qty: g.qty, amount: g.amount,
      price: g.qty ? g.amount / g.qty : 0, perOrder: n ? g.amount / n : 0,
    };
  }).sort((a, b) => b.amount - a.amount);
}
/* 芳谊放单仓：逐单刷单结算表（结算价 = 结算收入 − 快递+包装固定费；利润 = 结算价 − 刷单成本）
   每单一行：单号 / 日期 / 商品 / 结算收入（已扣店铺扣点） / 固定费（可改，默认系统自动值）/ 刷单成本（我填）/ 利润 */
function brushRowsHtml(orders) {
  return orders.map((o) => {
    const lines = o.lines || [];
    const income = lines.reduce((s, l) => s + (+l.amount || 0), 0);
    const goods = lines.map((l) => `${l.product_name || ""} × ${fmtNum(l.quantity)}${esc(l.unit || "")}`).join(" ／ ");
    const fee = +(o.brush_fee_auto || 0);
    return `<tr class="brush-row" data-doc="${esc(o.doc_no || "")}" data-income="${income.toFixed(2)}">
      <td class="mono">${esc(o.doc_no || "（无单号）")}</td>
      <td class="muted" style="white-space:nowrap;">${esc(o.date || "")}</td>
      <td>${goods || "—"}</td>
      <td class="num mono">${fmtMoney(income)}</td>
      <td class="num"><input class="brush-fee" type="number" step="0.01" min="0" value="${fee.toFixed(2)}" oninput="brushCalc()" /></td>
      <td class="num"><input class="brush-cost" type="number" step="0.01" min="0" placeholder="我刷这单的成本" oninput="brushCalc()" /></td>
      <td class="num mono brush-profit">—</td>
    </tr>`;
  }).join("");
}
/* 实时算每单利润（结算收入 − 固定费 − 刷单成本）与合计 */
function brushCalc() {
  let income = 0, fee = 0, cost = 0, profit = 0;
  document.querySelectorAll("#modalBox tr.brush-row").forEach((tr) => {
    const inc = parseFloat(tr.dataset.income) || 0;
    const f = parseFloat(tr.querySelector(".brush-fee")?.value) || 0;
    const c = parseFloat(tr.querySelector(".brush-cost")?.value) || 0;
    const gp = inc - f - c;
    const cell = tr.querySelector(".brush-profit");
    cell.textContent = fmtMoney(gp);
    cell.style.color = gp >= 0 ? "var(--green)" : "var(--red)";
    income += inc; fee += f; cost += c; profit += gp;
  });
  const set = (id, text, color) => {
    const el = $(id);
    if (!el) return;
    el.textContent = text;
    if (color) el.style.color = color;
  };
  set("brushSumIncome", fmtMoney(income));
  set("brushSumFee", fmtMoney(fee));
  set("brushSumCost", fmtMoney(cost));
  set("brushSumProfit", fmtMoney(profit), profit >= 0 ? "var(--green)" : "var(--red)");
  const filled = [...document.querySelectorAll("#modalBox tr.brush-cost")].filter((i) => parseFloat(i.value) > 0).length;
  const c = $("brushFilled");
  if (c) c.textContent = filled;
}
/* 一键批量把同一个「刷单成本」填到放单仓各单（onlyBlank=true 时只补还没填的），填完立即重算利润 */
function brushApply(onlyBlank) {
  const box = $("brushBatchCost");
  const v = parseFloat(box && box.value);
  if (!(v >= 0)) { toast("请先填一个刷单成本，如 1475"); if (box) box.focus(); return; }
  let n = 0;
  document.querySelectorAll("#modalBox tr.brush-row").forEach((tr) => {
    const inp = tr.querySelector(".brush-cost");
    if (!inp) return;
    if (onlyBlank && parseFloat(inp.value) > 0) return;
    inp.value = v;
    n++;
  });
  brushCalc();
  toast(n ? `已把刷单成本 ${fmtMoney(v)} 填到 ${n} 单` : "没有需要填的单（都已填过）");
}
/* 只填「本次刷单总成本」，按结算收入占比（推荐）或平均分摊到各单，不用逐单输。
   尾差（四舍五入差几毛）落在最大的一单上，保证各单之和 == 你填的总额。 */
function brushDistribute() {
  const box = $("brushBatchTotal");
  const total = parseFloat(box && box.value);
  if (!(total >= 0)) { toast("请先填本次刷单总成本，如 3000"); if (box) box.focus(); return; }
  const rows = [...document.querySelectorAll("#modalBox tr.brush-row")];
  if (!rows.length) return;
  const mode = ($("brushSplitMode") || {}).value || "revenue";
  const w = rows.map((tr) => (mode === "avg" ? 1 : (parseFloat(tr.dataset.income) || 0)));
  if (mode !== "avg" && !w.some((x) => x > 0)) { toast("这些单没有结算收入，请改用「平均分摊」"); return; }
  const sum = w.reduce((s, x) => s + x, 0) || 1;
  const vals = w.map((x) => Math.round(total * (x / sum) * 100) / 100);
  const diff = Math.round((total - vals.reduce((s, x) => s + x, 0)) * 100) / 100;
  if (diff) {
    let k = 0;
    vals.forEach((v, i) => { if (v > vals[k]) k = i; });
    vals[k] = Math.round((vals[k] + diff) * 100) / 100;
  }
  rows.forEach((tr, i) => {
    const inp = tr.querySelector(".brush-cost");
    if (inp) inp.value = vals[i];
  });
  brushCalc();
  toast(`已按${mode === "avg" ? "平均" : "结算收入占比"}把总额 ${fmtMoney(total)} 分摊到 ${rows.length} 单`);
}
/* 清空全部刷单成本（填错了从头来） */
function brushApplyBlankClear() {
  let n = 0;
  document.querySelectorAll("#modalBox tr.brush-row .brush-cost").forEach((inp) => {
    if (parseFloat(inp.value) > 0) { inp.value = ""; n++; }
  });
  brushCalc();
  toast(n ? `已清空 ${n} 单的刷单成本` : "本来就没填");
}
function renderAggregateReview(kind, orders, warn) {
  window.__DRAFT_ORDERS__ = orders; // 汇总视图不再逐单编辑，确认时按原单据整批出库
  const rows = aggregateDraftLines(orders);
  const sumQty = rows.reduce((s, x) => s + x.qty, 0);
  const sumAmt = rows.reduce((s, x) => s + x.amount, 0);
  const packFee = orders.reduce((s, o) => s + (+o.pack_fee || 0), 0);
  const dates = orders.map((o) => o.date).filter(Boolean).sort();
  const range = dates.length ? (dates[0] === dates[dates.length - 1] ? dates[0] : `${dates[0]} ~ ${dates[dates.length - 1]}`) : "";
  const body = rows.map((x) => `<tr>
      <td>${esc(x.name)}${x.deduct ? `<div class="muted" style="font-size:12px;">${esc(x.deduct)}</div>` : ""}</td>
      <td>${esc(x.unit || "—")}</td>
      <td class="num">${x.orders}</td>
      <td class="num">${fmtNum(x.qty)}</td>
      <td class="num">${fmtMoney(x.price)}</td>
      <td class="num">${fmtMoney(x.perOrder)}</td>
      <td class="num"><b>${fmtMoney(x.amount)}</b></td>
    </tr>`).join("");
  // 芳谊放单仓：逐单核算刷单成本（结算价 / 利润），确认时随单据一起落库并进报表
  const brushOrders = orders.filter(isBrushOrder);
  const brushSection = brushOrders.length ? `
    <div class="brush-box">
      <div class="brush-head">
        💳 芳谊放单仓 · 逐单刷单结算（共 <b>${brushOrders.length}</b> 单）
        <span class="muted" style="font-weight:normal;">结算价 = 结算收入（已扣店铺扣点） − 快递+包装固定费；利润 = 结算价 − 我刷这单的成本</span>
      </div>
      <div class="muted" style="font-size:12px;margin:6px 0;">
        下面每一单都要填「刷单成本」（也可以只填本次总成本、用下面的「按总额分摊」自动摊到各单）；
        「快递+包装」默认按系统出库时自动结算的快递费+包材+人工（可改），改了只影响这一单的结算口径。
        已填 <b id="brushFilled">0</b> / ${brushOrders.length} 单。这些金额会写进出库单，报表里一并从利润扣掉。
      </div>
      <!-- 一键批量：① 每单同一个成本；② 只填「本次刷单总成本」自动分摊，都不用逐单输 -->
      <div class="brush-batch">
        <span class="muted" style="font-size:12px;white-space:nowrap;">每单同一个成本</span>
        <input id="brushBatchCost" type="number" step="0.01" min="0" placeholder="如 1475"
               onkeydown="if(event.key==='Enter'){event.preventDefault();brushApply(false);}" />
        <button class="btn sm" onclick="brushApply(false)">应用到全部 ${brushOrders.length} 单</button>
        <button class="btn sm secondary" onclick="brushApply(true)">只填未填的</button>
        <button class="btn sm secondary" onclick="brushApplyBlankClear()">清空成本</button>
      </div>
      <div class="brush-batch">
        <span class="muted" style="font-size:12px;white-space:nowrap;">本次刷单总成本</span>
        <input id="brushBatchTotal" type="number" step="0.01" min="0" placeholder="如 3000"
               onkeydown="if(event.key==='Enter'){event.preventDefault();brushDistribute();}" />
        <select id="brushSplitMode" title="总成本怎么摊到各单">
          <option value="revenue">按结算收入占比分摊</option>
          <option value="avg">平均分摊</option>
        </select>
        <button class="btn sm" onclick="brushDistribute()">按总额分摊到 ${brushOrders.length} 单</button>
      </div>
      <div class="table-wrap brush-wrap">
        <table class="subtable brush-table" style="width:100%;">
          <thead><tr>
            <th>出库单号</th><th style="width:96px;">日期</th><th>商品</th>
            <th class="num" style="width:96px;">结算收入</th>
            <th class="num" style="width:104px;">快递+包装</th>
            <th class="num" style="width:132px;">刷单成本</th>
            <th class="num" style="width:96px;">利润</th>
          </tr></thead>
          <tbody>${brushRowsHtml(brushOrders)}</tbody>
          <tfoot><tr>
            <td colspan="3" class="muted">合计 ${brushOrders.length} 单</td>
            <td class="num"><b id="brushSumIncome">—</b></td>
            <td class="num"><b id="brushSumFee">—</b></td>
            <td class="num"><b id="brushSumCost">—</b></td>
            <td class="num"><b id="brushSumProfit">—</b></td>
          </tr></tfoot>
        </table>
      </div>
    </div>` : "";
  $("modalBox").classList.add("wide");
  $("modalBox").innerHTML = `<h3>${BATCH_MODAL[kind].title} — 商品汇总预览 <button class="close" onclick="closeModal()">✕</button></h3>
    <div class="alert ok">共 <b>${orders.length}</b> 单${range ? `（${esc(range)}）` : ""}，商品 <b>${rows.length}</b> 种，合计金额 <b>${fmtMoney(sumAmt)}</b>${packFee ? `（另有打包费 ${fmtMoney(packFee)}）` : ""}。确认后按原单据整批出库。</div>
    ${warn}
    ${brushSection}
    <div class="draft-list">
      <table class="subtable agg-table" style="width:100%;">
        <thead><tr>
          <th>商品</th><th style="width:64px;">单位</th>
          <th class="num" style="width:74px;">订单数</th>
          <th class="num" style="width:100px;">总数量</th>
          <th class="num" style="width:96px;">均价</th>
          <th class="num" style="width:100px;">每单金额</th>
          <th class="num" style="width:110px;">总金额</th>
        </tr></thead>
        <tbody>${body}</tbody>
        <tfoot><tr>
          <td colspan="3" class="muted">合计 ${rows.length} 种商品 · ${orders.length} 单</td>
          <td class="num"><b>${fmtNum(sumQty)}</b></td>
          <td class="num muted">—</td>
          <td class="num muted">—</td>
          <td class="num"><b>${fmtMoney(sumAmt)}</b></td>
        </tr></tfoot>
      </table>
    </div>
    <div class="modal-foot">
      <button class="btn secondary" onclick="openBatchModal('${kind}')">重新选择文件</button>
      <button class="btn secondary" onclick="runBatchModal('jushuitan')">↻ 重新解析（同一文件）</button>
      <button class="btn green" onclick="confirmAggregate('${kind}')">✓ 确认出库（${orders.length} 单）</button>
    </div>`;
  if (brushOrders.length) brushCalc();   // 初始化逐单利润与合计
}
/* 未关联商品：名称 + 「去新增商品」新标签页跳转按钮（新标签页直接打开新增商品弹窗并预填名称） */
function openProductTab(name) {
  const url = location.origin + location.pathname + "#/products/new?name=" + encodeURIComponent(name || "");
  const w = window.open(url, "_blank");
  if (!w) toast("浏览器拦截了新标签页，请允许弹出窗口");
}
function unmappedChip(code, info) {
  // info.reason / info.stock_product_name 由后端带回：平台商品名只匹配到库存大类（无关联结算清单）
  const why = info && info.stock_product_name
    ? `<span class="muted" style="font-size:12px;">缺关联结算小类（只匹配到大类：${esc(info.stock_product_name)}）</span>`
    : "";
  const title = info && info.reason ? ` title="${esc(info.reason)}"` : "";
  return `<span class="unmapped-chip"${title}><span class="unmapped-name">${esc(code)}</span>${why}` +
    `<button class="btn sm secondary" data-name="${esc(code)}" onclick="openProductTab(this.dataset.name)">` +
    `<svg class="ic"><use href="#i-plus"/></svg> 去新增商品</button></span>`;
}
/* 自动 AI 试算：同一批未关联商品只自动解析一次，避免每次重渲染都请求大模型 */
let __AI_AUTO_SIG__ = "";
function scheduleAiAutoPreview(kind) {
  if (kind !== "jushuitan") return;
  const codes = (window.__LAST_UNMAPPED__ || []).filter(Boolean);
  if (!codes.length) return;
  // 放单仓单据（仓储方=芳谊放单仓）不自动跑 AI 归并：平台商品名多是放单仓的占位名，
  // 自动新增会建出一批垃圾商品；需要时点下面那个按钮手动跑一次。
  if (isBrushBatch()) { renderAiBrushHint(); return; }
  const sig = codes.slice().sort().join("\u0001");
  if (sig === __AI_AUTO_SIG__) return;
  __AI_AUTO_SIG__ = sig;
  setTimeout(() => aiAutoPreview(kind), 0);
}
/* 放单仓单据：AI 位置改成提示 + 手动按钮（不自动触发） */
function renderAiBrushHint() {
  const box = $("bmAiBox");
  if (!box) return;
  box.innerHTML = `<div class="muted" style="font-size:12px;margin-top:6px;">
    本文件含放单仓单据（${esc((__BRUSH_HIT__ || []).join("、"))}），已<b>不自动</b>跑 AI 归并（放单仓商品名多是占位名，自动新增会建出垃圾商品）。
    这些商品请点「去新增商品」新建，或到「聚水潭关联」页手动关联。
    <button class="btn sm secondary" onclick="aiAutoPreview('jushuitan')">🤖 仍要跑一次 AI 归并</button></div>`;
}
/* 只试算不落库：调用 AI 归并库存大类，把方案展示给用户确认 */
async function aiAutoPreview(kind) {
  const box = $("bmAiBox");
  if (!box) return;
  const codes = (window.__LAST_UNMAPPED__ || []).filter(Boolean);
  if (!codes.length) { box.innerHTML = ""; return; }
  box.innerHTML = `<div class="alert ok">🤖 AI 正在自动归并这些商品并生成新增方案…（通常数秒，请稍候）</div>`;
  try {
    const r = await api("/api/mappings/ai-suggest", "POST", { source: "jushuitan", codes, apply: false });
    if (!PRODUCTS.length) { try { PRODUCTS = await api("/api/products"); } catch (e) { /* 下拉候选拉不到不影响方案展示 */ } }
    renderAiPlan(box, kind, r);
  } catch (e) {
    box.innerHTML = `<div class="alert err">AI 自动解析失败：${esc(e.message)}
      <div style="margin-top:8px;"><button class="btn sm secondary" onclick="aiAutoPreview('${kind}')">重试</button></div></div>`;
  }
}
/* 目标库存大类候选（可搜索）：现有库存大类 + AI 建议新建的大类名 */
function aiStockOptions(selectedId, newName) {
  const EXCL = ["包材", "人工", "快递"];
  const stocks = (PRODUCTS || []).filter((p) => p.product_type === "stock" && !EXCL.includes(p.category));
  let html = "";
  if (newName) {
    html += `<option value="new:${esc(newName)}" data-name="${esc(newName)}" selected>➕ 新建：${esc(newName)}</option>`;
  }
  html += stocks.map((p) => `<option value="${p.id}" data-name="${esc(p.name)}"${p.id === selectedId ? " selected" : ""}>` +
    `${esc(p.name)}${p.default_unit ? `（${esc(p.default_unit)}）` : ""}</option>`).join("");
  return html;
}
/* 读取用户在方案表里改过的「目标大类 / 每单扣减倍数」 */
function collectAiPlanEdits() {
  const rows = [...document.querySelectorAll("#bmAiBox .ai-plan tbody tr[data-code]")];
  if (!rows.length) return null;
  return rows.map((tr) => {
    const sel = tr.querySelector("select.ai-target");
    const v = sel ? String(sel.value || "") : "";
    const isNew = v.startsWith("new:");
    const opt = sel && sel.selectedOptions.length ? sel.selectedOptions[0] : null;
    const mult = parseFloat(tr.querySelector("input.ai-mult")?.value);
    return {
      code: tr.dataset.code,
      stock_product_id: isNew ? null : (Number(v) || null),
      target: isNew ? v.slice(4) : ((opt && opt.dataset.name) || (opt ? opt.textContent : "")),
      target_new: isNew,
      multiplier: isNaN(mult) ? 0 : mult,
    };
  });
}
/* 展示 AI 方案（新增哪些库存大类 / 关联去向 / 仍无法关联的），等用户确认 */
function renderAiPlan(box, kind, r) {
  const items = r.products || [];
  const maps = r.mappings || [];
  const leftover = r.leftover || [];
  const news = items.filter((x) => x.is_new);
  if (!news.length && !maps.length) {
    box.innerHTML = `<div class="alert warn">🤖 AI 未能自动归并出可新增的库存大类，以下商品请手动新增商品或关联：` +
      `<div class="unmapped-list">${leftover.map((c) => unmappedChip(c)).join("")}</div></div>`;
    return;
  }
  const mapsTable = maps.map((m) => `<tr data-code="${esc(m.code)}">
      <td>${esc(m.code)}</td>
      <td class="muted">→</td>
      <td><select class="searchable ai-target">${aiStockOptions(m.stock_product_id, m.target_new ? m.target : "")}</select></td>
      <td class="num" style="white-space:nowrap;"><input class="ai-mult" type="number" step="0.01" min="0" value="${esc(String(m.multiplier))}" style="width:86px;" /> <span class="muted">${esc(m.unit || "")}</span></td>
      <td class="muted">${m.order_exists ? "更新小类" : "新建小类"}</td>
    </tr>`).join("");
  window.__AI_PLAN__ = r;   // 确认时原样回传，照用户所见新增（不再问一次大模型）
  box.innerHTML = `<div class="ai-plan">
    <div class="ai-plan-head">🤖 AI 自动新增方案（尚未写入，确认后才生效）</div>
    <div class="muted" style="font-size:12.5px;margin-bottom:8px;">${esc(r.message || "")}</div>
    <div class="muted" style="font-size:12px;margin-bottom:8px;">下面两列都可以改：<b>关联到</b>点一下可选其他库存大类（支持输入搜索，含 AI 建议新建的），<b>每单扣减</b>填 1 单该商品扣多少库存默认单位。</div>
    ${news.length ? `<div class="ai-plan-sec"><b>将新增 ${news.length} 个库存大类</b>（其余匹配到已有大类）
      <ul class="ai-plan-list">${news.map((x) => `<li>${esc(x.name)} <span class="muted">· ${esc(x.category)}</span></li>`).join("")}</ul></div>` : ""}
    ${maps.length ? `<div class="ai-plan-sec"><b>将关联 ${maps.length} 个商品名</b>（建/更新为订单商品「小类」，按其规格倍数扣减对应大类库存）
      <div class="table-wrap" style="max-height:260px;overflow:auto;"><table class="subtable" style="width:100%;">
        <thead><tr><th>未关联商品名</th><th></th><th>关联到（库存大类，可改）</th><th>每单扣减（可改）</th><th>订单小类</th></tr></thead><tbody>${mapsTable}</tbody></table></div></div>` : ""}
    ${leftover.length ? `<div class="ai-plan-sec"><b>仍无法自动关联 ${leftover.length} 个</b>，请手动补充
      <div class="unmapped-list">${leftover.map((c) => unmappedChip(c)).join("")}</div></div>` : ""}
    <div class="modal-foot" style="margin:0;padding-top:10px;">
      <button class="btn secondary" onclick="aiAutoPreview('${kind}')">重新生成方案</button>
      <button class="btn green" onclick="aiApplyPlan('${kind}')">✓ 确认新增并重新解析</button>
    </div>
  </div>`;
  bindSearchable(box);   // 目标大类下拉变成「点击选择 / 输入筛选」
}
/* 用户确认后：真正新增库存大类 + 建立编码关联，然后重新解析出库单 */
async function aiApplyPlan(kind) {
  const codes = (window.__LAST_UNMAPPED__ || []).filter(Boolean);
  if (!codes.length) { toast("没有可关联的商品名"); return; }
  const box = $("bmAiBox");
  const btn = document.querySelector("#bmAiBox .btn.green");
  if (btn) { btn.disabled = true; btn.textContent = "⏳ 正在新增…"; }
  try {
    const edits = collectAiPlanEdits();   // 用户可能改过目标大类 / 倍数，以页面上的为准
    const plan = window.__AI_PLAN__
      ? { ...window.__AI_PLAN__, mappings: edits || window.__AI_PLAN__.mappings, edited: !!edits }
      : null;
    const r = await api("/api/mappings/ai-suggest", "POST", {
      source: "jushuitan", codes, apply: true, plan,
    });
    const add = (r.created_products || []).map((p) => p.name).join("、");
    const addOrder = (r.created_orders || []).map((p) => p.name).join("、");
    toast(r.message || "AI 关联完成");
    if (box) box.innerHTML = `<div class="alert ok">✅ ${esc(r.message)}` +
      `${add ? `<div class="muted" style="font-size:12px;margin-top:4px;">新增大类：${esc(add)}</div>` : ""}` +
      `${addOrder ? `<div class="muted" style="font-size:12px;">新建订单小类：${esc(addOrder)}</div>` : ""}</div>`;
    window.__AI_PLAN__ = null;
    __AI_AUTO_SIG__ = ""; // 允许重新解析后按新的未关联集合再自动试算
    setTimeout(() => { if (window.__BM_FILE__) runBatchModal(kind); }, 400);
  } catch (e) {
    toast("AI 关联失败：" + e.message);
    if (btn) { btn.disabled = false; btn.textContent = "✓ 确认新增并重新解析"; }
    if (box) box.innerHTML = `<div class="alert err">AI 关联失败：${esc(e.message)}</div>`;
  }
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
  submitDraftOrders(kind, orders);
}
/* 汇总视图确认：按解析出的原单据整批出库（不逐单编辑） */
async function confirmAggregate(kind) {
  if (window.__CONFIRMING__) return; // 防止重复提交
  const packMap = window.__DRAFT_PACK__ || {};
  // 芳谊放单仓逐单填的「刷单成本 / 快递+包装固定费」（按单号取回）
  const brushMap = {};
  document.querySelectorAll("#modalBox tr.brush-row").forEach((tr) => {
    brushMap[tr.dataset.doc || ""] = {
      cost: parseFloat(tr.querySelector(".brush-cost")?.value) || 0,
      fee: parseFloat(tr.querySelector(".brush-fee")?.value) || 0,
    };
  });
  const orders = (window.__DRAFT_ORDERS__ || []).map((o) => ({
    doc_no: o.doc_no, date: o.date, customer: o.customer || "",
    operator: o.operator || "", remark: o.remark || "",
    pack_fee: +o.pack_fee || 0,
    // 放单仓：仓储方 + 刷单成本 + 结算用的「快递+包装固定费」（其余单据为空值，口径不变）
    warehouse: o.warehouse || "",
    brush_cost: brushMap[o.doc_no || ""]?.cost || 0,
    brush_fee: brushMap[o.doc_no || ""]?.fee || 0,
    pack_rule_id: o.pack_rule_id || null,
    pack_rule_name: o.pack_rule_name || "",
    pack_lines: packMap[o.doc_no] || [],
    lines: (o.lines || [])
      .filter((l) => l.product_id && l.unit && +l.quantity > 0)
      .map((l) => ({
        product_id: +l.product_id, unit: l.unit, quantity: +l.quantity,
        price: +l.price || 0, gross_sales: +l.gross_sales || 0,
      })),
  })).filter((o) => o.lines.length);
  if (!orders.length) { toast("没有可出库的单据"); return; }
  submitDraftOrders(kind, orders);
}
async function submitDraftOrders(kind, orders) {
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
    renderJstPending();   // 导入完立刻刷新「待办处理」（有新商品没关联 / 要验证码时马上就能看到）
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
      <td><input class="draft-freight" type="number" step="any" min="0" value="${it.freight || ""}" placeholder="0" title="运费（选填）：计入批次成本，体现在该品毛利，并同步记入「其他开支」" style="width:64px;" /></td>
      <td><input class="draft-handling" type="number" step="any" min="0" value="${it.handling || ""}" placeholder="0" title="装卸费（选填）：同运费" style="width:64px;" /></td>
      <td class="muted">${esc(it.supplier || "—")} · ${esc(it.date)}</td>
    </tr>`).join("");
  $("modalBox").innerHTML = `<h3>${BATCH_MODAL[kind].title} — 确认入库 <button class="close" onclick="closeModal()">✕</button></h3>
    <div class="alert ok">解析出 <b>${items.length}</b> 行。可勾选、修改数量/单价/运费/装卸后点击「确认入库」；运费与装卸费会计入批次成本并同步「其他开支」。</div>
    ${warn}
    <table class="subtable" style="width:100%;">
      <thead><tr><th style="width:34px;"><input type="checkbox" checked onchange="toggleDraftAll(this)" /></th><th>商品</th><th>单位</th><th>数量</th><th>单价</th><th>金额</th><th>运费</th><th>装卸</th><th>供应商 · 日期</th></tr></thead>
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
    const fee = Math.max(0, parseFloat(tr.querySelector(".draft-freight")?.value) || 0);
    const hand = Math.max(0, parseFloat(tr.querySelector(".draft-handling")?.value) || 0);
    if (qty > 0) items.push({ ...it, quantity: qty, unit_price: price, freight: fee, handling: hand });
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
let _mappingLoadPromise = null;
function loadMappingPage() {
  // 并发调用复用同一请求（深链跳转时 switchSettingsTab 与预填弹窗会同时触发）
  if (!_mappingLoadPromise) {
    _mappingLoadPromise = (async () => {
      try {
        MAPPINGS = await api("/api/mappings");
        renderMappings();
      } catch (e) {
        const box = $("mpMappingStats");
        if (box) box.innerHTML = `<div class="alert err">加载关联明细失败：${esc(e.message)}</div>`;
      } finally {
        _mappingLoadPromise = null;
      }
    })();
  }
  return _mappingLoadPromise;
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
