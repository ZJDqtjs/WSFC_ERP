/* 企业台账系统 - 前端逻辑 */
let PRODUCTS = [];
let UNITS = [];
let CURRENT_USER = null;
let MP_CODES = [];  // 聚水潭解析出的编码列表

/* 批量选择状态 */
const prodSel = new Set();
const inSel = new Set();
const outSel = new Set();
let OUT_GROUP = null;  // 当前打开的出库批次（array of Outbound 记录）

/* ---------- 批量选择工具 ---------- */
function selSet(kind) {
  return kind === "prod" ? prodSel : kind === "in" ? inSel : outSel;
}
function selBarId(kind) {
  return kind === "prod" ? "prodBatch" : kind === "in" ? "inBatch" : "outBatch";
}
function selCountId(kind) {
  return kind === "prod" ? "prodSelCount" : kind === "in" ? "inSelCount" : "outSelCount";
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
  const tableId = kind === "prod" ? "prodTable" : kind === "in" ? "inTable" : "outTable";
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
  else loadOutbounds();
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
  const na = parseFloat(a), nb = parseFloat(b);
  if (!isNaN(na) && !isNaN(nb)) return na - nb;
  return String(a).localeCompare(String(b), "zh");
}
function applyTableSort(tbl, rows) {
  if (tbl && tbl._sort && Array.isArray(rows)) {
    const k = tbl._sort.key, d = tbl._sort.dir;
    return rows.slice().sort((a, b) => compareVal(a[k], b[k]) * d);
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
/* 参考成本（默认单位）：优先加权平均成本（自动随入库重算），无入库则用参考成本 */
function refCostHtml(p) {
  const du = defaultUnit(p);
  const f = unitFactor(p, du);
  if (p.avg_cost > 0) return `${fmtMoney(p.avg_cost * f)}/${du}`;
  if (p.unit_cost > 0) return `${fmtMoney(p.unit_cost * f)}/${du}`;
  return "—";
}
/* 出库默认单价：优先默认售价，其次参考成本（加权平均/参考成本，按所选单位换算） */
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
  products: "商品", report: "财务报表", import: "批量导入", jushuitan: "聚水潭关联",
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
    products: renderProducts, report: loadReport, import: loadImportPage, jushuitan: loadMappingPage,
    backup: loadBackupPage, fresh: loadFresh,
  };
  (loaders[name] || (() => {}))();
}
document.querySelectorAll(".nav-item").forEach((b) => b.addEventListener("click", () => {
  if (b.dataset.page === "products") {
    prodForceCat = b.dataset.cat || "";
    prodForceType = b.dataset.type || "";
  }
  goPage(b.dataset.page);
}));

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
  ["inOperator", "outOperator", "adjOperator", "fOperator"].forEach((id) => {
    const el = $(id);
    if (el && !el.value) el.value = disp;
  });
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
function closeModal() { $("modalMask").classList.remove("show"); const r = _aiDoneResolve; _aiDoneResolve = null; if (r) r(); }
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
      <div class="field"><label>成本单价（仅盘盈用）</label><input id="adjPrice" type="number" step="any" value="0" /></div>
      <div class="field"><label>日期</label><input id="adjDate" type="date" value="${today()}" /></div>
      <div class="field"><label>操作员</label><input id="adjOperator" placeholder="谁操作的" /></div>
    </div>
    <div class="field" style="margin-top:10px;"><label>原因</label><input id="adjRemark" placeholder="如：盘点差异/损耗" /></div>
    <div class="modal-foot">
      <button class="btn secondary" onclick="closeModal()">取消</button>
      <button class="btn" onclick="submitAdjust()">确认调整</button>
    </div>`);
  adjPreview();
}
function adjPreview() {
  const p = PRODUCTS.find((x) => x.id === +$("adjProduct").value);
  const nowEl = $("adjNow"), afterEl = $("adjAfter");
  if (!p) { nowEl.textContent = "—"; afterEl.textContent = "—"; return; }
  const unit = p.default_unit || p.base_unit;
  const f = (p.conversions || {})[unit] || 1;
  const now = p.stock / f;
  nowEl.textContent = `${fmtNum(now)} ${unit}`;
  const raw = ($("adjQty").value || "").trim();
  if (!raw) { afterEl.textContent = `${fmtNum(now)} ${unit}（不调整）`; return; }
  if (!/^[+-]\d+(\.\d+)?$/.test(raw)) { afterEl.textContent = "⚠ 需以 + 或 - 开头，如 +100 / -100"; return; }
  afterEl.textContent = `${fmtNum(now + parseFloat(raw))} ${unit}`;
}
async function submitAdjust() {
  const raw = ($("adjQty").value || "").trim();
  if (raw && !/^[+-]\d+(\.\d+)?$/.test(raw)) {
    toast("调整数量必须以 + 或 - 开头（如 +100 增加 / -100 减少），不允许直接填裸数字；留空则不调整");
    return;
  }
  const p = PRODUCTS.find((x) => x.id === +$("adjProduct").value);
  if (!p) { toast("请选择商品"); return; }
  try {
    await api("/api/adjust", "POST", {
      product_id: p.id,
      quantity: raw,
      unit: p.default_unit || p.base_unit,
      unit_price: +$("adjPrice").value || 0,
      date: $("adjDate").value,
      operator: $("adjOperator").value,
      remark: $("adjRemark").value,
    });
    closeModal();
    toast(raw ? "盘点调整成功" : "数量留空，未调整库存");
    loadStock();
  } catch (e) { toast("操作失败：" + e.message); }
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
  // 可能自动新增了商品/单位，刷新后确认框才能选到新商品
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
function aiProductOptions(selectedId, orderFirst) {
  const sorted = PRODUCTS.filter((p) => p.is_active).slice().sort((a, b) =>
    orderFirst ? (b.product_type === "order") - (a.product_type === "order")
               : (a.product_type === "order") - (b.product_type === "order")
  );
  return sorted.map((p) =>
    `<option value="${p.id}" ${p.id === selectedId ? "selected" : ""}>${p.product_type === "order" ? "〔订单〕" : "〔库存〕"}${esc(p.name)}</option>`
  ).join("");
}
let AI_CONFIRM = null;   // 当前确认框对应的识别结果（供提交时标注）
function openAiConfirm(r) {
  AI_CONFIRM = r;
  const isIn = r.type === "inbound";
  const linesHtml = (r.lines || []).map((ln, i) => `
    <tr data-idx="${i}">
      <td style="min-width:220px;"><select class="searchable ai-pid">${aiProductOptions(ln.product_id, !isIn)}</select>
        ${ln.auto_created ? '<span class="badge" style="background:var(--amber-light);color:#8a6d00;margin-left:6px;">🆕 自动新增</span>' : ""}</td>
      <td><input type="number" step="any" class="ai-qty" value="${fmtNum(ln.quantity)}" style="width:90px;" /></td>
      <td><input class="ai-unit" value="${esc(ln.unit || "")}" style="width:70px;" /></td>
      <td><input type="number" step="any" class="ai-price" value="${ln.unit_price}" style="width:100px;" />${ln.price_defaulted ? '<span class="badge" style="background:var(--amber-light);color:#8a6d00;margin-left:4px;">已按上次价</span>' : ""}</td>
      <td class="muted" style="font-size:12px;">${esc(ln.hint || "")}</td>
    </tr>`).join("");
  const invImg = r.image_url
    ? `<div class="ai-invoice"><span class="muted">📎 票据凭证</span><img src="${esc(r.image_url)}" alt="票据" onclick="window.open('${esc(r.image_url)}','_blank')" /></div>`
    : "";
  openModal(`
    <h3>确认录入（${isIn ? "入库" : "出库"}） <button class="close" onclick="closeModal()">✕</button></h3>
    ${invImg}
    <p class="hint" style="margin-bottom:12px;">已自动识别以下内容，请核对（可修改）后提交；🆕 标记的商品为新物品（系统已自动新增档案）。</p>
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
      <thead><tr><th>商品</th><th>数量</th><th>单位</th><th>${isIn ? "单价" : "售价"}</th><th>说明</th></tr></thead>
      <tbody id="aiLines">${linesHtml || '<tr><td colspan="5" class="empty">未识别到明细</td></tr>'}</tbody>
    </table></div>
    <div class="modal-foot">
      <button class="btn secondary" onclick="closeModal()">取消</button>
      <button class="btn green" onclick="aiSubmit()">✓ 确认提交</button>
    </div>`);
}
function aiTypeChanged() {
  // 切换类型时重排商品下拉（出库订单优先，入库库存优先）
  const isIn = $("aiType").value === "inbound";
  document.querySelectorAll("#aiLines tr[data-idx]").forEach((tr) => {
    const sel = tr.querySelector(".ai-pid");
    const cur = +sel.value;
    sel.innerHTML = aiProductOptions(cur, !isIn);
  });
}
async function aiSubmit() {
  const type = $("aiType").value;
  const date = $("aiDate").value;
  const party = $("aiParty").value.trim();
  const remark = $("aiRemark").value.trim();
  const inv = (AI_CONFIRM && AI_CONFIRM.image_url) ? `[票据] ${AI_CONFIRM.image_url}` : "";
  const autoFlags = (AI_CONFIRM && AI_CONFIRM.lines) || [];
  const rows = [...document.querySelectorAll("#aiLines tr[data-idx]")].map((tr, i) => ({
    product_id: +tr.querySelector(".ai-pid").value,
    quantity: parseFloat(tr.querySelector(".ai-qty").value),
    unit: tr.querySelector(".ai-unit").value.trim(),
    unit_price: parseFloat(tr.querySelector(".ai-price").value),
    auto_created: !!(autoFlags[i] && autoFlags[i].auto_created),
  })).filter((r) => r.product_id);
  if (!rows.length) { toast("请至少填写一条商品"); return; }
  if (rows.some((r) => !(r.quantity > 0) || isNaN(r.unit_price) || !r.unit)) { toast("请完整填写数量、单位与金额"); return; }
  const op = (CURRENT_USER && (CURRENT_USER.name || CURRENT_USER.username)) || "";
  try {
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

/* 备注渲染：把 /uploads/xxx.jpg 票据引用转成缩略图（可点击放大） */
function renderRemarkHtml(rmk) {
  if (!rmk) return "—";
  return esc(rmk).replace(new RegExp(ROUTES.uploads.replace(/[.*+?^${}()|[\]\\]/g, "\\$&") + "\\/[\\w.\\-]+", "g"), (u) =>
    `<a href="${u}" target="_blank"><img src="${u}" alt="票据" style="height:34px;vertical-align:middle;border-radius:4px;margin-right:4px;border:1px solid var(--border-light);" /></a>`);
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
    <h3>计量单位管理 <button class="close" onclick="closeModal()">✕</button></h3>
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
  $("outPreview").style.display = "block";
  $("outFee").value = r.total_fee;
  $("outWarn").innerHTML = (r.warnings || []).map((w) => `<div class="alert warn">⚠ ${esc(w)}（仍可继续，可先补货）</div>`).join("");
  $("outPackBody").innerHTML = r.pack_lines.map((pl, i) => {
    const m = PRODUCTS.find((x) => x.id === pl.product_id);
    return `<tr data-idx="${i}">
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
    const factor = (m.conversions || {})[unit] || 1;
    const cost = (m.avg_cost || 0) * qty * factor;
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
  document.querySelectorAll("#outSaleBody tr").forEach((tr) => {
    const p = PRODUCTS.find((x) => x.id === +tr.dataset.pid);
    const unitSel = tr.querySelector(".sale-unit");
    const unit = unitSel ? unitSel.value : "";
    const qty = parseFloat(tr.querySelectorAll("input[type=number]")[0].value) || 0;
    const price = parseFloat(tr.querySelectorAll("input[type=number]")[1].value) || 0;
    amount += qty * price;
    if (p && unit) cogs += qty * (p.conversions?.[unit] || 1) * (p.avg_cost || 0);
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
function clearPreview() { $("outPreview").style.display = "none"; }
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
function outAggBy(rows, pool) {
  // pool='sale' 汇总销售商品，pool='pack' 汇总耗材/包装
  const map = new Map();
  const aggKey = (l) => `${l.product_id}@@${l.unit}`;
  for (const o of rows) {
    for (const l of o.lines) {
      if (pool === "sale" && l.line_type !== "sale") continue;
      if (pool === "pack" && l.line_type !== "pack") continue;
      const k = aggKey(l);
      if (!map.has(k)) map.set(k, { product_id: l.product_id, name: l.product_name, unit: l.unit, orders: new Set(), qty: 0, qty_base: 0, amount: 0, cogs: 0 });
      const a = map.get(k);
      a.orders.add(o.id);
      a.qty += l.quantity || 0;
      a.qty_base += l.quantity_base || 0;
      a.amount += l.amount || 0;
      a.cogs += l.cogs || 0;
    }
  }
  return [...map.values()].map((a) => ({ ...a, order_count: a.orders.size }));
}
function renderOutGroup() {
  if (!OUT_GROUP) return;
  const rows = OUT_GROUP;
  const kw = ($("ogSearch")?.value || "").trim().toLowerCase();
  const t = $("ogTable");
  const aggSale = outAggBy(rows, "sale").filter((a) => !kw || a.name.toLowerCase().includes(kw));
  const aggPack = outAggBy(rows, "pack").filter((a) => !kw || a.name.toLowerCase().includes(kw));
  const total = {
    amt: rows.reduce((s, o) => s + (o.total_amount || 0), 0),
    cogs: rows.reduce((s, o) => s + (o.total_cogs || 0), 0),
    fee: rows.reduce((s, o) => s + (o.total_fee || 0), 0),
  };
  const net = total.amt - total.cogs - total.fee;
  $("ogTitle").textContent = `出库批次明细（${rows.length} 单）`;
  $("ogHint").textContent = "按商品聚合展示每种商品的总单数 / 总数量与金额，可搜索、排序；耗材另开页签。";
  $("ogDelCount").textContent = rows.length;
  $("ogSummary").innerHTML =
    `<div class="stat"><div class="label">批次单数</div><div class="value">${rows.length}</div></div>
     <div class="stat"><div class="label">销售商品种数</div><div class="value">${outAggBy(rows, "sale").length}</div></div>
     <div class="stat"><div class="label">耗材种数</div><div class="value">${outAggBy(rows, "pack").length}</div></div>
     <div class="stat"><div class="label">销售收入</div><div class="value">${fmtMoney(total.amt)}</div></div>
     <div class="stat"><div class="label">结转成本</div><div class="value">${fmtMoney(total.cogs)}</div></div>
     <div class="stat success"><div class="label">净利</div><div class="value" style="color:${net >= 0 ? "var(--green)" : "var(--red)"}">${fmtMoney(net)}</div></div>`;
  const seg = segActive("ogSeg");
  const isSale = seg === "og-sale";
  let data = (isSale ? aggSale : aggPack).map((a) => ({ ...a, gp: (a.amount - a.cogs) || 0 }));
  if (t._sort) data = data.slice().sort((a, b) => compareVal(a[t._sort.key], b[t._sort.key]) * t._sort.dir);
  t.innerHTML = `<thead><tr>
    <th data-key="name">商品${sortArrow("ogTable", "name")}</th>
    ${isSale ? `<th data-key="order_count" class="num">单数${sortArrow("ogTable", "order_count")}</th>` : ""}
    <th>单位</th>
    <th data-key="qty" class="num">${isSale ? "总数量" : "数量"}${sortArrow("ogTable", "qty")}</th>
    <th data-key="amount" class="num">${isSale ? "金额" : "成本"}${sortArrow("ogTable", "amount")}</th>
    <th data-key="cogs" class="num">成本${sortArrow("ogTable", "cogs")}</th>
    ${isSale ? `<th data-key="gp" class="num">毛利${sortArrow("ogTable", "gp")}</th>` : ""}
  </tr></thead><tbody>` +
    (data.length ? data.map((a) => `<tr>
      <td>${esc(a.name)}</td>
      ${isSale ? `<td class="num">${a.order_count} 单</td>` : ""}
      <td>${esc(a.unit)}</td>
      <td class="num mono">${fmtNum(a.qty)}</td>
      <td class="num mono">${fmtMoney(a.amount)}</td>
      <td class="num mono">${fmtMoney(a.cogs)}</td>
      ${isSale ? `<td class="num mono" style="color:${(a.amount - a.cogs) >= 0 ? "var(--green)" : "var(--red)"}">${fmtMoney(a.amount - a.cogs)}</td>` : ""}
    </tr>`).join("")
      : `<tr><td colspan="7" class="muted">${isSale ? "无销售商品" : "无耗材/包装记录"}</td></tr>`) + `</tbody>`;
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
  $("repStats").innerHTML = `
    <div class="stat blue"><div class="label">销售收入</div><div class="value">${fmtMoney(rep.revenue)}</div><div class="sub">${rep.order_count} 单</div></div>
    <div class="stat amber"><div class="label">结转成本</div><div class="value">${fmtMoney(rep.cogs)}</div></div>
    <div class="stat green"><div class="label">毛利</div><div class="value">${fmtMoney(rep.gross_profit)}</div><div class="sub">${rep.revenue ? ((rep.gross_profit / rep.revenue) * 100).toFixed(1) + "%" : "—"}</div></div>
    <div class="stat red"><div class="label">期间费用</div><div class="value">${fmtMoney(rep.expense)}</div><div class="sub">打包费 ${fmtMoney(rep.fee_breakdown["人工打包费"])}</div></div>
    <div class="stat ${rep.net_profit >= 0 ? "green" : "red"}"><div class="label">净利润</div><div class="value">${fmtMoney(rep.net_profit)}</div></div>
    <div class="stat"><div class="label">本期进货</div><div class="value">${fmtMoney(rep.purchase)}</div></div>
    <div class="stat blue"><div class="label">当前库存总值</div><div class="value">${fmtMoney(rep.stock_value)}</div></div>`;

  const pt = $("repProductTable");
  let prodRows = applyTableSort(pt, rep.by_product || []);
  if (!prodRows.length) pt.innerHTML = `<tr><td class="empty" colspan="5">本期无销售</td></tr>`;
  else pt.innerHTML = `<thead><tr>
    <th data-key="name">商品${sortArrow("repProductTable", "name")}</th>
    <th data-key="qty" class="num">销量(基础单位)${sortArrow("repProductTable", "qty")}</th>
    <th data-key="amount" class="num">收入${sortArrow("repProductTable", "amount")}</th>
    <th data-key="cogs" class="num">成本${sortArrow("repProductTable", "cogs")}</th>
    <th data-key="gross" class="num">毛利${sortArrow("repProductTable", "gross")}</th></tr></thead><tbody>` +
    prodRows.map((p) => `<tr>
      <td>${esc(p.name)}</td><td class="num mono">${fmtNum(p.qty)}</td>
      <td class="num mono">${fmtMoney(p.amount)}</td><td class="num mono">${fmtMoney(p.cogs)}</td>
      <td class="num mono" style="color:var(--green)">${fmtMoney(p.amount - p.cogs)}</td></tr>`).join("") + `</tbody>`;
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
      <div class="field"><label>操作员</label><input id="fOperator" /></div>
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
  const typeBadge = { in: '<span class="badge in">入库</span>', out: '<span class="badge out">出库</span>', pack_out: '<span class="badge pack">包装消耗</span>', work: '<span class="badge income">工作量</span>', adjust: '<span class="badge adjust">盘点</span>' };
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
  $("mvProduct").innerHTML = `<option value="0">全部商品</option>`;
  PRODUCTS = await api("/api/products");
  UNITS = await api("/api/units");
  $("mvProduct").innerHTML = `<option value="0">全部商品</option>` +
    PRODUCTS.filter((p) => !["人工", "快递"].includes(p.category)).map((p) => `<option value="${p.id}">${esc(p.name)}</option>`).join("");
  $("inProduct").innerHTML = `<option value="">选择商品…</option>` +
    PRODUCTS.filter((p) => p.is_active && p.product_type === "stock").map((p) => `<option value="${p.id}">${esc(p.name)}</option>`).join("");
  $("inUnit").onchange = calcInbound;
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
  bindSearchable(document);
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
    hint: "按模板填写后上传，先解析预览（可勾选、改数量单价），确认后才真正入库并更新库存。",
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
  const file = $("bmFile").files[0];
  if (!file) { toast("请先选择 Excel 文件"); return; }
  const box = $("bmResult");
  box.innerHTML = `<div class="alert ok">⏳ 正在解析…</div>`;
  try {
    const r = await apiUpload(cfg.preview, file);
    if (kind === "inbound") renderInboundReview(kind, r);
    else renderDraftReview(kind, r);
  } catch (e) { box.innerHTML = `<div class="alert err">解析失败：${esc(e.message)}</div>`; }
}
function renderDraftReview(kind, r) {
  const orders = r.orders || [];
  let warn = "";
  if (r.unmapped_codes && r.unmapped_codes.length) warn += `<div class="alert warn">⚠ 未关联商品：${r.unmapped_codes.map(esc).join("、")}（请到「编码关联」关联后重新解析）</div>`;
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
         data-operator="${esc(o.operator || "")}" data-remark="${esc(o.remark || "")}" data-packfee="${o.pack_fee || 0}">
      <div class="draft-head">
        <label style="display:flex;gap:6px;align-items:center;"><input type="checkbox" class="draft-check" checked onchange="updateDraftCount('${kind}')" /> 出库</label>
        <b>${esc(o.doc_no || "（无单号）")}</b>
        <span class="muted">${esc(o.customer || "—")} · ${esc(o.date)}${o.pack_fee ? " · 打包费 " + fmtMoney(o.pack_fee) : ""}</span>
      </div>
      <table class="subtable">
        <thead><tr><th>商品</th><th>单位</th><th>数量</th><th>单价</th><th>金额</th></tr></thead>
        <tbody>${(o.lines || []).map((l) => `
          <tr class="draft-line" data-pid="${l.product_id}" data-unit="${esc(l.unit)}">
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
  const orders = [];
  document.querySelectorAll("#modalBox .draft-order").forEach((od) => {
    if (!od.querySelector(".draft-check").checked) return;
    const lines = [];
    od.querySelectorAll(".draft-line").forEach((tr) => {
      const pid = +tr.dataset.pid;
      const unit = tr.dataset.unit;
      const qty = parseFloat(tr.querySelector(".draft-qty").value);
      const price = parseFloat(tr.querySelector(".draft-price").value) || 0;
      if (pid && unit && qty > 0) lines.push({ product_id: pid, unit, quantity: qty, price });
    });
    if (!lines.length) return;
    orders.push({
      doc_no: od.dataset.doc, date: od.dataset.date, customer: od.dataset.customer,
      operator: od.dataset.operator, remark: od.dataset.remark,
      pack_fee: parseFloat(od.dataset.packfee) || 0, lines,
    });
  });
  if (!orders.length) { toast("没有勾选任何单据"); return; }
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
  // 页面已改为「解析即自动新增/关联」，这里仅展示当前关联数量供参考
  const r = await api("/api/mappings");
  $("mpParseInfo").innerHTML = r.length
    ? `<div class="alert ok">当前已保存 <b>${r.length}</b> 条商品编码关联（均指向库存商品），导入出库单时将按此关联结算。</div>`
    : `<div class="alert">暂无商品编码关联，上传聚水潭出库单后会自动新增订单商品并关联库存商品。</div>`;
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
