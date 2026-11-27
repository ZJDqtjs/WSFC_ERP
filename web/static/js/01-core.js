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
let WG_DETAIL = false; // 入仓批次明细视图：false=按商品名汇总（默认），true=按记录明细
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
/* 中文输入法（IME）友好：拼音组合输入（还没选字）期间一律不重画列表——部分浏览器/输入法会在
   每次 DOM 重画时打断组合，表现就是「怎么打字都进不去字」。等 compositionend 再筛选。
   列表改用事件委托（原来每敲一个键都重画并把每个选项重新挂一遍事件，200+ 选项时又慢又抖）。 */
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

    let composing = false;       // 输入法组合中：不动 DOM，避免打断中文输入
    let rendered = null;         // 上次渲染用的筛选词，内容没变就不重画

    function syncInput() {
      const o = sel.options[sel.selectedIndex];
      input.value = o ? o.text : "";
      rendered = null;           // 文本被外部改动，下次打开重新渲染
    }
    sel.addEventListener("change", syncInput);
    // 初始就把「当前选中项」显示出来。以前只在 change / blur / 点页面空白处才同步，
    // 所以弹窗刚打开时输入框是空的（只看到 placeholder），用户以为「关联库存商品是空的」，
    // 点一下页面才冒出文字 —— 全站所有 searchable 下拉都中招。
    syncInput();
    // options 被整体替换时（如单位下拉先建空 select 再填充、切换商品类型重填单位），
    // 同一个 select 不会重新绑定，这里跟着同步一次显示文本。
    const mo = new MutationObserver(() => {
      if (!sel.isConnected) { mo.disconnect(); return; }
      syncInput();
    });
    mo.observe(sel, { childList: true });

    function renderList(filter) {
      const f = (filter || "").toLowerCase().trim();
      if (f === rendered) return;
      rendered = f;
      const items = [];
      for (const o of sel.options) {
        const text = o.text;
        if (f && !text.toLowerCase().includes(f)) continue;
        items.push(`<div class="scombo-item" data-v="${o.value}">${esc(text)}</div>`);
      }
      list.innerHTML = items.join("") || '<div class="scombo-empty">无匹配选项</div>';
      list.scrollTop = 0;
    }
    function openList(filter) {
      list.style.display = "block";
      renderList(filter);
    }
    /** 选中某一项：写回 select、触发 change（让页面的渲染/查询跟上来） */
    function pick(it) {
      if (!it) return;
      sel.value = it.dataset.v;
      sel.dispatchEvent(new Event("change", { bubbles: true }));
      syncInput();
      list.style.display = "none";
    }
    // 事件委托：整个列表只挂一个监听，输入时不再逐项挂/摘事件
    list.addEventListener("mousedown", (e) => {
      const it = e.target.closest(".scombo-item");
      if (!it) return;
      e.preventDefault();   // 保住输入框焦点，否则 blur 会把文本重置回原选项
      pick(it);
    });
    input.addEventListener("focus", () => {
      // 不再清空文本（清空会让人以为「打不进去字」）：只全选，直接输入即可覆盖
      if (input.value) input.select();
      openList("");
    });
    input.addEventListener("blur", () => { syncInput(); });
    input.addEventListener("compositionstart", () => { composing = true; });
    input.addEventListener("compositionend", () => { composing = false; openList(input.value); });
    input.addEventListener("input", (e) => {
      if (composing || e.isComposing) return;   // 中文输入法组合中：先别动列表
      openList(input.value);
    });
    input.addEventListener("keydown", (e) => {
      if (e.key === "Escape") {
        list.style.display = "none";
        syncInput();
        input.blur();
        return;
      }
      if (e.key !== "Enter" || list.style.display === "none") return;
      const first = list.querySelector(".scombo-item");
      if (!first) return;
      e.preventDefault();
      pick(first);
    });
    document.addEventListener("click", (e) => {
      if (wrap.contains(e.target)) return;
      list.style.display = "none";
      if (!composing) syncInput();   // 输入法组合中不要改 value（程序化改 value 会取消组合）
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

/* 子路径挂载支持：整套前端可能被反向代理挂在 /jdfenxi/ 这类前缀下，
   以当前页面所在目录为根拼出 BASE（根路径部署时为空串，行为与原来一致）。 */
const BASE = (() => {
  const p = location.pathname;
  const i = p.lastIndexOf("/");
  return i > 0 ? p.slice(0, i) : "";
})();

const ROUTES = { api: BASE + "/api", uploads: BASE + "/uploads" };

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
    let msg = "请求失败", detail = null;
    try {
      const j = await res.json();
      detail = j.detail;
      // detail 可能是字符串，也可能是结构化对象（如编码冲突 {message, code_conflict}）
      msg = typeof j.detail === "string" ? j.detail : (j.detail && j.detail.message) || msg;
    } catch (e) {}
    const err = new Error(msg);
    err.status = res.status;
    err.detail = detail;   // 调用方需要时自行判断（如 409 编码冲突弹「替换」）
    throw err;
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
/* 商品的扣减方案清单：[{name, links:[{product_id, multiplier, name, default_unit, last_in_date}]}]。
   没配多方案时，把现有 stock_links 当成「方案1」返回（老数据口径不变，界面照样能编辑）。
   出库时会按各方案库存商品的「最近一次采购入库」日期自动选一套（后端 deduction_scheme）。 */
function prodSchemes(p) {
  const raw = (p && Array.isArray(p.stock_schemes)) ? p.stock_schemes.filter((s) => s && (s.links || []).length) : [];
  if (raw.length) {
    return raw.map((s, i) => ({
      name: (s.name || "").trim() || `方案${i + 1}`,
      links: (s.links || []).map((l) => ({
        product_id: l.product_id,
        multiplier: Number(l.multiplier) || 1,
        name: l.name || (PRODUCTS.find((x) => x.id === l.product_id) || {}).name || "?",
        default_unit: l.default_unit || ((PRODUCTS.find((x) => x.id === l.product_id) || {}).default_unit || ""),
        last_in_date: l.last_in_date || "",
      })),
    }));
  }
  const links = prodStockLinks(p || {});
  return links.length ? [{ name: "方案1", links }] : [];
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
function yesterday() {
  const d = new Date();
  d.setDate(d.getDate() - 1);
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
  products: "商品", report: "财务报表", adprofit: "广告利润", otherexp: "其他收支", payables: "待付款账单",
  import: "批量导入", jushuitan: "聚水潭关联",
  backup: "备份与恢复",
};
let prodForceCat = "";  // 包材 / 人工 / 快递 等独立入口强制筛选的商品分类
let prodForceType = ""; // 关联结算 等独立入口强制筛选的商品类型（order）
function setProductTabFilter(type, cat) {
  prodForceType = type || "";
  prodForceCat = cat || "";
  renderProducts();
}
function getProductTabFilter() {
  return { type: prodForceType || "", cat: prodForceCat || "" };
}
function goProducts() { prodForceCat = ""; prodForceType = ""; goPage("products"); }
function goPage(name) {
  if (typeof closeAllDrawers === "function") closeAllDrawers();
  if (typeof syncTopbarTitle === "function") syncTopbarTitle(name);
  // 高亮当前导航项
  document.querySelectorAll(".nav-item").forEach((x) => {
    const hit = x.dataset.page === name &&
      (name !== "products" || !x.dataset.cat && !x.dataset.type ||
        ((x.dataset.cat || "") === (prodForceCat || "") &&
         (x.dataset.type || "") === (prodForceType || "")));
    x.classList.toggle("active", hit);
  });
  if (name === "products" && typeof syncProdTabUI === "function") syncProdTabUI();
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
    adprofit: loadAdProfit,   // 广告利润（财务报表口径 + 挂载服务 CPS/京准通花费）
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
  else if (panel === "jstauto") {
    // 自动出库设置：聚水潭 / 京麦 两个模块，按上次停留的模块恢复显示
    switchAutoModule(AUTO_MODULE);
    if (AUTO_MODULE === "pop") { if (!POP_AUTO) loadPopAutoPage(); }
    else loadJstAutoPage();
  }
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
/* =============== 快递费规则（多快递公司） =============== */
let EXPRESS_CFG = null;        // {default_carrier, carriers:[{id,name,mode,first_kg_fee,per_extra_kg,rate_per_kg,round_up,note}]}
let EXPRESS_EDIT_ID = null;    // 正在编辑的快递公司 id（null=新增中）

function expressCarrierSummary(c) {
  return c.mode === "flat"
    ? `每 kg ¥${fmtNum(c.rate_per_kg)}`
    : `1kg 内 ¥${fmtNum(c.first_kg_fee)} + 每超 1kg ¥${fmtNum(c.per_extra_kg)}${c.round_up ? "（续重向上取整）" : ""}`;
}
function renderExpressCarrierTable() {
  const t = $("exprCarrierTable");
  if (!t) return;
  const doc = EXPRESS_CFG || { default_carrier: "", carriers: [] };
  const rows = (doc.carriers || []).map((c) => `<tr${c.id === EXPRESS_EDIT_ID ? ' style="background:var(--primary-light,#eff6ff);"' : ""}>
      <td><b>${esc(c.name)}</b>${c.id === doc.default_carrier ? ' <span class="badge" style="background:var(--primary,#2563eb);color:#fff;">默认</span>' : ""}
        ${c.note ? `<div class="muted" style="font-size:12px;">${esc(c.note)}</div>` : ""}</td>
      <td>${esc(expressCarrierSummary(c))}</td>
      <td>${c.mode === "flat" ? "每 kg 单价" : "首重 + 续重"}</td>
      <td class="line-actions">
        <button class="btn sm secondary" onclick="expressEditCarrier('${esc(c.id)}')">编辑</button>
        ${c.id === doc.default_carrier ? "" : `<button class="btn sm secondary" onclick="expressSetDefault('${esc(c.id)}')">设为默认</button>`}
        <button class="btn sm danger" onclick="expressDeleteCarrier('${esc(c.id)}')">删除</button>
      </td></tr>`).join("");
  t.innerHTML = `<thead><tr><th style="width:30%;">快递公司</th><th>计费规则</th><th>计费方式</th><th>操作</th></tr></thead>
    <tbody>${rows || `<tr><td colspan="4" class="empty">暂无快递规则，点「新增快递公司」添加（如 京东快递 / 中通 / 顺丰）</td></tr>`}</tbody>`;
}
function fillExpressForm(c) {
  EXPRESS_EDIT_ID = c ? c.id : null;
  $("expName").value = c ? c.name : "";
  $("expMode").value = c && c.mode === "flat" ? "flat" : "tiered";
  $("expFirst").value = c ? c.first_kg_fee : 3.6;
  $("expExtra").value = c ? c.per_extra_kg : 1;
  $("expRate").value = c ? c.rate_per_kg : 3.6;
  $("expRoundUp").checked = c ? !!c.round_up : true;
  $("expNote").value = c ? (c.note || "") : "";
  if ($("expCarrierTitle")) $("expCarrierTitle").textContent = c ? `编辑计费规则 · ${c.name}` : "编辑计费规则（新快递公司）";
  renderExpressCarrierTable();
  previewExpress();
}
function currentExprCfg() {
  return {
    id: EXPRESS_EDIT_ID || "",
    name: ($("expName").value || "").trim(),
    note: ($("expNote").value || "").trim(),
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
  const head = cfg.name ? `<div class="muted" style="width:100%;font-size:12px;">按「${esc(cfg.name)}」的规则：${esc(expressCarrierSummary(cfg))}</div>` : "";
  el.innerHTML = head + weights.map((w) =>
    `<div class="expr-item"><span class="expr-w">毛重 ${w}kg</span><span class="expr-fee">${fmtMoney(exprFee(cfg, w))}</span></div>`
  ).join("");
}
/** 已保存的快递公司列表（已存在的那家带上编辑区未保存的改动） */
function expressSavedDoc() {
  const cfg = currentExprCfg();
  const doc = EXPRESS_CFG || { default_carrier: "", carriers: [] };
  const list = (doc.carriers || []).map((c) => ({ ...c }));
  const i = cfg.id ? list.findIndex((c) => c.id === cfg.id) : -1;
  if (i >= 0) list[i] = { ...list[i], ...cfg };
  return { default_carrier: doc.default_carrier || (list[0] || {}).id || "", carriers: list };
}
/** 把编辑区的当前值并进快递公司列表，得到待提交的整份配置（新增时会生成 id） */
function expressDraftDoc() {
  const cfg = currentExprCfg();
  const doc = expressSavedDoc();
  if (cfg.id) return { doc, id: cfg.id };
  cfg.id = "c" + Date.now().toString(36);
  doc.carriers.push(cfg);
  if (!doc.default_carrier) doc.default_carrier = cfg.id;
  return { doc, id: cfg.id };
}
async function loadExpressPage() {
  try {
    const r = await api("/api/express/rule");
    EXPRESS_CFG = { default_carrier: r.default_carrier, carriers: r.carriers || [] };
    EXPRESS_CARRIER_LIST = EXPRESS_CFG.carriers;          // 出库单的快递费行共用这份缓存
    EXPRESS_CARRIER_DEFAULT = EXPRESS_CFG.default_carrier;
    const cur = EXPRESS_CFG.carriers.find((c) => c.id === EXPRESS_EDIT_ID)
      || EXPRESS_CFG.carriers.find((c) => c.id === EXPRESS_CFG.default_carrier)
      || EXPRESS_CFG.carriers[0] || null;
    fillExpressForm(cur);
    const defName = (EXPRESS_CFG.carriers.find((c) => c.id === EXPRESS_CFG.default_carrier) || {}).name || "—";
    $("expRateInfo").textContent = `已加载 ${EXPRESS_CFG.carriers.length} 家快递公司，默认：${defName}`;
  } catch (e) { toast("加载规则失败：" + e.message); }
}
async function saveExpressRule() {
  const cfg = currentExprCfg();
  if (!cfg.name) { toast("请填写快递公司名称"); return; }
  const bad = cfg.mode === "tiered" ? [cfg.first_kg_fee, cfg.per_extra_kg] : [cfg.rate_per_kg];
  if (bad.some((v) => isNaN(v) || v < 0)) { toast("请填写正确的费用（≥0）"); return; }
  const { doc, id } = expressDraftDoc();
  try {
    const saved = await api("/api/express/rule", "PUT", doc);
    EXPRESS_CFG = { default_carrier: saved.default_carrier, carriers: saved.carriers || [] };
    EXPRESS_CARRIER_LIST = EXPRESS_CFG.carriers;
    EXPRESS_CARRIER_DEFAULT = EXPRESS_CFG.default_carrier;
    fillExpressForm(EXPRESS_CFG.carriers.find((c) => c.id === id) || EXPRESS_CFG.carriers[0] || null);
    $("expRateInfo").textContent = "已保存，实时生效";
    toast("快递费规则已保存");
  } catch (e) { toast("保存失败：" + e.message); }
}
function expressAddCarrier() {
  const names = (EXPRESS_CFG?.carriers || []).map((c) => c.name);
  fillExpressForm(null);
  $("expName").value = "";
  $("expName").placeholder = `如 ${["京东快递", "中通", "顺丰", "圆通"].find((n) => !names.includes(n)) || "快递公司"}`;
  $("expName").focus();
  toast("填好名称与计费规则后点「保存计费规则」");
}
function expressEditCarrier(id) {
  const c = (EXPRESS_CFG?.carriers || []).find((x) => x.id === id);
  if (c) fillExpressForm(c);
}
async function expressSetDefault(id) {
  const target = id || EXPRESS_EDIT_ID;
  if (!target) { toast("请先保存这家新快递公司，再设为默认"); return; }
  const doc = expressSavedDoc();
  doc.default_carrier = target;
  try {
    const saved = await api("/api/express/rule", "PUT", doc);
    EXPRESS_CFG = { default_carrier: saved.default_carrier, carriers: saved.carriers || [] };
    renderExpressCarrierTable();
    $("expRateInfo").textContent = `已设默认快递：${(EXPRESS_CFG.carriers.find((c) => c.id === saved.default_carrier) || {}).name || ""}`;
    toast("已设为默认快递（出库默认按它计费）");
    loadExpressCarrierList();
  } catch (e) { toast("设置失败：" + e.message); }
}
async function expressDeleteCarrier(id) {
  const target = id || EXPRESS_EDIT_ID;
  const list = (EXPRESS_CFG?.carriers || []);
  const c = list.find((x) => x.id === target);
  if (!c) { toast("先选中一家快递公司"); return; }
  if (list.length <= 1) { toast("至少要保留一家快递公司"); return; }
  if (!(await uiConfirm(`确认删除「${c.name}」的计费规则？已出库单的成本不受影响。`))) return;
  // 删除时不要带上编辑区里没保存的改动：直接按已保存的列表提交
  const doc = { default_carrier: EXPRESS_CFG.default_carrier, carriers: list.filter((x) => x.id !== target) };
  try {
    const saved = await api("/api/express/rule", "PUT", doc);
    EXPRESS_CFG = { default_carrier: saved.default_carrier, carriers: saved.carriers || [] };
    fillExpressForm(EXPRESS_CFG.carriers.find((x) => x.id === saved.default_carrier) || EXPRESS_CFG.carriers[0] || null);
    toast("已删除该快递公司");
    loadExpressCarrierList();
  } catch (e) { toast("删除失败：" + e.message); }
}
/* 出库单：缓存快递公司规则（「关联结算」里的快递费行用它选公司/重算） */
async function loadExpressCarrierList() {
  try {
    const r = await api("/api/express/rule");
    EXPRESS_CARRIER_LIST = r.carriers || [];
    EXPRESS_CARRIER_DEFAULT = r.default_carrier || (EXPRESS_CARRIER_LIST[0] || {}).id || "";
  } catch (e) {
    EXPRESS_CARRIER_LIST = [];
    EXPRESS_CARRIER_DEFAULT = "";
  }
  return EXPRESS_CARRIER_LIST;
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
  if (!(await uiConfirm(`确认删除「${category}」的扣点规则？删除后该类别入库将不再折算。`))) return;
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
  if (!(await uiConfirm(`确认删除店铺「${shop}」的扣点规则？删除后该店订单不再折算。`))) return;
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
  if (!(await uiConfirm(`切换到${label}？仅你的登录会切到该分仓，其他在线用户不受影响，也无需重新登录。`))) return;
  try {
    const r = await api("/api/warehouses/switch", "POST", { key });
    toast(`已切换到 ${(r && r.warehouse && r.warehouse.name) || label}`);
    setTimeout(() => location.reload(), 400);  // 重新加载各页面数据
  } catch (e) { whErr(e.message); }
}
async function createWarehouse() {
  const name = ($("whName").value || "").trim();
  if (!name) { whErr("请输入分仓名称"); return; }
  if (!(await uiConfirm(`新建「${name}」并把你的登录切过去？无需重新登录，也不影响其他在线用户。`))) return;
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
  // 中文姓名取末字才是姓氏（「小王」→「王」）；字母账号沿用首字母惯例。
  const t = disp.trim();
  $("userAvatar").textContent = !t
    ? "管"
    : /^[A-Za-z]/.test(t)
      ? t.charAt(0).toUpperCase()
      : t.slice(-1);
  const wt = $("warehouseTag");
  if (wt) wt.textContent = u.warehouse ? u.warehouse.name : "选择分仓";
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
  JST_PENDING_N = 0;   // 聚水潭待办计数也归零，避免侧边栏角标残留上一个分仓的数字
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
/** 一组单选：用于弹窗表单（入库/入仓/出库/其他收支/手动记账统一用它） */
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
  const v = ["paid", "unpaid", "partial"].includes(value) ? value : "paid";
  document.querySelectorAll(`input[name="${name}"]`).forEach((b) => {
    b.checked = b.value === v;
    if (b.checked) payRadioSync(b);
  });
}
/** 待付款标记（列表里提示该笔还没结清） */
function payTag(status) {
  const s = status || "paid";
  if (s === "partial") return '<span class="pay-tag part">部分付款</span>';
  return s === "unpaid" ? '<span class="pay-tag">待付款</span>' : "";
}

/* ---------- 部分付款（入库单专用）：已付 / 未付 / 比例 三个输入联动 ---------- */
function round2(v) { return Math.round((+v || 0) * 100) / 100; }

/** 只写数值有变化的输入框（避免打断用户正在输入的光标） */
function setNum(el, v) {
  if (!el) return;
  const nv = round2(v);
  const cur = parseFloat(el.value);
  if (!(Math.abs(cur - nv) < 0.005)) el.value = nv ? String(nv) : "";
}

/** 入库单「付款状态」单选：比其它单据多一个「部分付款」，选中后展开金额/比例输入 */
function inboundPayRadios(name, current, paidAmount = 0, hint = "", dueFixed = null) {
  const cur = ["paid", "unpaid", "partial"].includes(current) ? current : "paid";
  const radios = [["paid", "已付款"], ["partial", "部分付款"], ["unpaid", "待付款"]].map(([v, label]) =>
    `<label class="pay-radio${cur === v ? " on" : ""}"><input type="radio" name="${name}" value="${v}"${cur === v ? " checked" : ""} onchange="payRadioSync(this); inPayToggle(this)" /> ${label}</label>`
  ).join("");
  const shown = cur === "partial";
  return `<div class="pay-radios">${radios}</div>
    <div class="pay-part"${dueFixed !== null ? ` data-due="${round2(dueFixed)}"` : ""}${shown ? "" : ' style="display:none;"'}>
      <div class="pay-part-row">
        <label>已付</label>
        <input class="pp-paid" type="number" min="0" step="any" placeholder="0.00" value="${cur === "partial" && paidAmount > 0 ? round2(paidAmount) : ""}" oninput="partialPayInput(this,'paid')" />
        <span class="pp-unit">元</span>
        <label>比例</label>
        <input class="pp-ratio" type="number" min="0" max="100" step="any" placeholder="%" oninput="partialPayInput(this,'ratio')" />
        <span class="pp-unit">%</span>
        <label>未付</label>
        <input class="pp-unpaid" type="number" min="0" step="any" placeholder="0.00" oninput="partialPayInput(this,'unpaid')" />
        <span class="pp-unit">元</span>
      </div>
      <div class="field-hint pp-hint"></div>
    </div>` + (hint ? `<div class="field-hint">${hint}</div>` : "");
}

/** 选中 / 离开「部分付款」：展开那块输入，并按当前应付合计补上默认值 */
function inPayToggle(el) {
  const field = el.closest(".field");
  if (!field) return;
  const box = field.querySelector(".pay-part");
  if (!box) return;
  const on = el.value === "partial";
  box.style.display = on ? "" : "none";
  if (on) applyPartialPay(box);
  // 入库行换了付款状态 → 本单小计与底部合计的口径（实付/应付/未付）跟着重算
  if (box.closest(".in-block")) calcInboundBlock(el);
}

/** 部分付款的应付合计：弹窗里用固定 data-due；入库行按 货款 + 调整 + 运费 + 装卸 + 手续费 实时算 */
function partialDueOf(box) {
  const fixed = box.dataset.due;
  if (fixed !== undefined && fixed !== "") return round2(parseFloat(fixed) || 0);
  const b = box.closest(".in-block");
  return b ? payDueOf(b) : 0;
}

/** 按「已付金额」重算比例/未付并刷新提示（已付是唯一真相，另两个只是快捷输入） */
function applyPartialPay(box, paidInput) {
  if (!box) return;
  const due = partialDueOf(box);
  const paidEl = box.querySelector(".pp-paid");
  const ratioEl = box.querySelector(".pp-ratio");
  const unpaidEl = box.querySelector(".pp-unpaid");
  let paid = paidInput === undefined ? parseFloat((paidEl || {}).value) : paidInput;
  if (!(paid >= 0)) paid = 0;
  paid = Math.min(round2(paid), due);
  const unpaid = round2(due - paid);
  setNum(paidEl, paid);
  setNum(ratioEl, due > 0 ? round2(paid / due * 100) : 0);
  setNum(unpaidEl, unpaid);
  const hint = box.querySelector(".pp-hint");
  if (hint) hint.innerHTML = `应付合计 <b>¥${fmtMoney(due)}</b>（货款 + 调整 + 运费/装卸/手续费）：`
    + `已付 <b>¥${fmtMoney(paid)}</b>，未付 <b>¥${fmtMoney(unpaid)}</b>`
    + (paid > 0 && unpaid > 0 ? "" : "（已付填 0 按「待付款」记，填满应付按「已付款」记）");
}

/** 三个输入互相带动：改哪个都换算成「已付金额」再同步另外两个 */
function partialPayInput(el, kind) {
  const box = el.closest(".pay-part");
  if (!box) return;
  const due = partialDueOf(box);
  const val = parseFloat(el.value) || 0;
  let paid = val;
  if (kind === "ratio") paid = round2(due * Math.min(Math.max(val, 0), 100) / 100);
  else if (kind === "unpaid") paid = round2(due - val);
  applyPartialPay(box, paid);
  // 已付金额变了 → 本单小计与底部合计跟着改（不重算这块面板，避免打断输入）
  const blk = box.closest(".in-block");
  if (blk) { renderInboundSum(blk); updateInboundTotal(); }
}

/** 应付合计变了（改数量/单价/调整/运费装卸）：已付金额不动，比例与未付跟着重算 */
function syncPartialPay(block) {
  const box = block ? block.querySelector(".pay-part") : null;
  if (!box || box.style.display === "none") return;
  applyPartialPay(box);
}

/** 入库行应付合计 = 货款 + 金额调整 + 运费 + 装卸 + 手续费（与后端「实付」口径一致） */
function payDueOf(block) {
  const v = (sel) => parseFloat((block.querySelector(sel) || {}).value) || 0;
  return round2(v(".in-qty") * v(".in-price") + v(".in-adjust") + v(".in-freight") + v(".in-handling") + v(".in-fee"));
}

