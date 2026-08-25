/* 企业台账系统 - 前端逻辑 */
let PRODUCTS = [];
let UNITS = [];
let CURRENT_USER = null;
let MP_CODES = [];  // 聚水潭解析出的编码列表

/* ---------- 工具 ---------- */
const $ = (id) => document.getElementById(id);

async function api(path, method = "GET", body) {
  const opt = { method, headers: { "Content-Type": "application/json" } };
  if (body !== undefined) opt.body = JSON.stringify(body);
  const res = await fetch(path, opt);
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
  const res = await fetch(path, { method: "POST", body: fd });
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
function today() {
  const d = new Date();
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`;
}
function monthStart() {
  return today().slice(0, 8) + "01";
}

/* ---------- 导航 ---------- */
const PAGE_TITLES = {
  home: "工作台", stock: "库存管理", inbound: "入库", outbound: "出库 / 销售",
  products: "商品", report: "财务报表", import: "导入与关联",
};
function goPage(name) {
  document.querySelectorAll(".nav-item").forEach((x) => x.classList.toggle("active", x.dataset.page === name));
  document.querySelectorAll(".page").forEach((x) => x.classList.remove("active"));
  const page = $("page-" + name);
  page.classList.add("active");
  const loaders = {
    home: loadDashboard, stock: loadStock, inbound: initInbound, outbound: initOutbound,
    products: renderProducts, report: loadReport, import: loadImportPage,
  };
  (loaders[name] || (() => {}))();
}
document.querySelectorAll(".nav-item").forEach((b) => b.addEventListener("click", () => goPage(b.dataset.page)));

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
  if (panel === "import-jst") loadMappingPage();
}

/* ---------- 认证 ---------- */
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
async function doLogin() {
  const username = $("loginUser").value.trim();
  const password = $("loginPass").value;
  if (!username || !password) { showLoginErr("请输入用户名和密码"); return; }
  try {
    const r = await fetch("/api/auth/login", {
      method: "POST", headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ username, password }),
    });
    if (!r.ok) { showLoginErr("用户名或密码错误"); return; }
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
  try { await fetch("/api/auth/logout", { method: "POST" }); } catch (e) {}
  CURRENT_USER = null;
  showLogin();
});

/* ---------- 弹窗 ---------- */
function openModal(html) {
  $("modalBox").innerHTML = html;
  $("modalMask").classList.add("show");
}
function closeModal() { $("modalMask").classList.remove("show"); }
$("modalMask").addEventListener("click", (e) => { if (e.target.id === "modalMask") closeModal(); });

/* =============== 库存 =============== */
async function loadStock() {
  const [products, overview] = await Promise.all([api("/api/products"), api("/api/stock-overview")]);
  PRODUCTS = products;
  renderStock(overview);
}
function renderStock(overview) {
  if (!overview) return;
  const kw = ($("stockSearch").value || "").trim().toLowerCase();
  const rows = overview.filter((p) =>
    !kw || p.name.toLowerCase().includes(kw) || p.category.toLowerCase().includes(kw)
  );
  const t = $("stockTable");
  if (!rows.length) {
    t.innerHTML = `<tr><td colspan="5" class="empty">暂无数据，请先到「商品管理」添加商品</td></tr>`;
    return;
  }
  t.innerHTML = `<thead><tr><th>商品</th><th>分类</th><th class="num">当前库存</th><th class="num">平均成本</th><th class="num">库存价值</th><th>操作</th></tr></thead><tbody>` +
    rows.map((p) => {
      const low = p.stock <= 0 ? '<span class="badge out">缺货</span>' : "";
      return `<tr>
        <td><b>${esc(p.name)}</b> ${low}</td>
        <td>${esc(p.category) || "—"}</td>
        <td class="num mono">${fmtNum(p.stock)} ${p.base_unit}</td>
        <td class="num mono">${fmtMoney(p.avg_cost)}/${p.base_unit}</td>
        <td class="num mono">${fmtMoney(p.stock_value)}</td>
        <td class="line-actions">
          <button class="btn sm secondary" onclick="viewProductMv(${p.id})">流水</button>
          <button class="btn sm" onclick="openAdjust(${p.id})">调整</button>
        </td></tr>`;
    }).join("") + `</tbody>`;
  $("statTypes").textContent = overview.length;
  const totalValue = overview.reduce((s, p) => s + p.stock_value, 0);
  $("statStockValue").textContent = fmtMoney(totalValue);
  $("statStockSub").textContent = `${fmtNum(totalValue)} 元库存成本`;
  $("statLow").textContent = overview.filter((p) => p.stock <= 0).length;
}

function openAdjust(pid = 0) {
  openModal(`
    <h3>盘点调整 <button class="close" onclick="closeModal()">✕</button></h3>
    <div class="form-grid">
      <div class="field"><label>商品 *</label><select id="adjProduct">${productOptions(pid)}</select></div>
      <div class="field"><label>调整数量（基础单位，正盘盈/负盘亏）*</label><input id="adjQty" type="number" step="any" placeholder="如 -5" /></div>
      <div class="field"><label>成本单价（仅盘盈用）</label><input id="adjPrice" type="number" step="any" value="0" /></div>
      <div class="field"><label>日期</label><input id="adjDate" type="date" value="${today()}" /></div>
      <div class="field"><label>操作员</label><input id="adjOperator" placeholder="谁操作的" /></div>
    </div>
    <div class="field" style="margin-top:10px;"><label>原因</label><input id="adjRemark" placeholder="如：盘点差异/损耗" /></div>
    <div class="modal-foot">
      <button class="btn secondary" onclick="closeModal()">取消</button>
      <button class="btn" onclick="submitAdjust()">确认调整</button>
    </div>`);
}
async function submitAdjust() {
  try {
    await api("/api/adjust", "POST", {
      product_id: +$("adjProduct").value,
      quantity: +$("adjQty").value,
      unit_price: +$("adjPrice").value || 0,
      date: $("adjDate").value,
      operator: $("adjOperator").value,
      remark: $("adjRemark").value,
    });
    closeModal(); toast("盘点调整成功"); loadStock();
  } catch (e) { toast("操作失败：" + e.message); }
}

function viewProductMv(pid) {
  goPage("stock");
  $("mvProduct").value = String(pid);
  const segBtn = document.querySelector('#stockSeg .seg-item[data-panel="stock-movements"]');
  if (segBtn) switchSeg("stockSeg", segBtn);
  loadMovements();
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
            <div class="activity-sub">当前库存 ${fmtNum(p.stock)} ${p.base_unit}</div>
          </div>
          <button class="btn sm danger" onclick="goPage('inbound')">补货</button>
        </div>`).join("") +
        (low.length > 8 ? `<div class="empty-tip">… 还有 ${low.length - 8} 种缺货</div>` : "")
      : `<div class="empty-tip">🎉 暂无缺货商品，库存状态良好</div>`;

    const acts = [];
    (d.recent_outbounds || []).forEach((o) => acts.push({
      ico: "⬆️", cls: "out", title: `出库 ${o.code}`,
      sub: `${o.customer || "散客"} · ${o.date}${o.operator ? " · " + o.operator : ""}`,
      amt: fmtMoney(o.amount), color: "var(--primary)",
    }));
    (d.recent_inbounds || []).forEach((i) => acts.push({
      ico: "⬇️", cls: "in", title: `入库 ${i.code}`,
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

function loadImportPage() {}

/* =============== 商品 =============== */
function productOptions(selected = 0, includeAll = false) {
  let html = includeAll ? '<option value="0">全部商品</option>' : "";
  html += PRODUCTS.filter((p) => p.is_active).map((p) =>
    `<option value="${p.id}" ${p.id === selected ? "selected" : ""}>${esc(p.name)}</option>`
  ).join("");
  return html;
}
function unitOptions(product, selected) {
  const convs = product?.conversions || {};
  return Object.keys(convs).map((u) =>
    `<option value="${u}" ${u === selected ? "selected" : ""}>${u}</option>`
  ).join("");
}

async function renderProducts() {
  if (!PRODUCTS.length) PRODUCTS = await api("/api/products");
  const kw = ($("prodSearch")?.value || "").trim().toLowerCase();
  const rows = PRODUCTS.filter((p) => !kw || p.name.toLowerCase().includes(kw));
  const t = $("prodTable");
  t.innerHTML = `<thead><tr>
    <th>编码</th><th>商品</th><th>分类</th><th>基础单位</th><th>单位换算</th><th>关联结算清单</th>
    <th class="num">打包费/单</th><th class="num">库存</th><th>状态</th><th>操作</th></tr></thead><tbody>` +
    rows.map((p) => {
      const convs = Object.entries(p.conversions || {})
        .map(([u, f]) => `1${u}=${fmtNum(f)}${p.base_unit}`).join("，");
      const packs = (p.pack_items || []).map((it) => {
        const m = PRODUCTS.find((x) => x.id === it.product_id);
        return `${esc(m ? m.name : "?")}×${fmtNum(it.quantity)}${it.unit}`;
      }).join("，");
      return `<tr>
        <td class="muted mono">${esc(p.code) || "—"}</td>
        <td><b>${esc(p.name)}</b>${p.spec ? `<div class="muted" style="font-size:12px;">${esc(p.spec)}</div>` : ""}</td>
        <td>${esc(p.category) || "—"}</td>
        <td>${p.base_unit}</td>
        <td class="muted" style="max-width:200px;">${esc(convs) || "—"}</td>
        <td class="muted" style="max-width:200px;">${esc(packs) || "—"}</td>
        <td class="num">${fmtMoney(p.pack_fee)}</td>
        <td class="num mono">${fmtNum(p.stock)} ${p.base_unit}</td>
        <td>${p.is_active ? '<span class="badge in">启用</span>' : '<span class="badge off">停用</span>'}</td>
        <td class="line-actions">
          <button class="btn sm secondary" onclick="openProductModal(${p.id})">编辑</button>
        </td></tr>`;
    }).join("") + `</tbody>`;
  if (!rows.length) t.innerHTML = `<tr><td colspan="10" class="empty">暂无商品</td></tr>`;
}

function convRowsHtml(convs, baseUnit) {
  const entries = Object.entries(convs || {});
  return entries.map(([u, f], i) => `
    <div class="conv-row">
      <input value="${esc(u)}" placeholder="单位" class="conv-unit" />
      <div class="field"><input type="number" step="any" value="${f}" class="conv-factor" /></div>
      <div class="muted">1 ${esc(u)} = ${fmtNum(f)} ${baseUnit}</div>
      <button class="btn danger sm" onclick="this.closest('.conv-row').remove()">删</button>
    </div>`).join("") + `
    <div class="conv-row">
      <input placeholder="新单位，如 包" class="conv-unit" />
      <input type="number" step="any" placeholder="折算系数" class="conv-factor" />
      <div class="muted">1 新单位 = ? ${baseUnit}</div>
      <button class="btn secondary sm" onclick="addConvRow()">＋</button>
    </div>`;
}
function addConvRow() {
  const last = document.querySelector(".conv-row:last-child");
  const u = last.querySelector(".conv-unit").value.trim();
  const f = parseFloat(last.querySelector(".conv-factor").value);
  if (!u || !f) { toast("请先填写单位与系数"); return; }
  last.querySelector(".conv-unit").value = u;
  last.querySelector(".conv-factor").value = f;
  last.innerHTML = `
    <input value="${esc(u)}" placeholder="单位" class="conv-unit" />
    <div class="field"><input type="number" step="any" value="${f}" class="conv-factor" /></div>
    <div class="muted">1 ${esc(u)} = ${fmtNum(f)} ${$("pBaseUnit").value}</div>
    <button class="btn danger sm" onclick="this.closest('.conv-row').remove()">删</button>`;
  addConvRowBlank();
}
function addConvRowBlank() {
  const box = $("convRows");
  box.insertAdjacentHTML("beforeend", `
    <div class="conv-row">
      <input placeholder="新单位，如 包" class="conv-unit" />
      <input type="number" step="any" placeholder="折算系数" class="conv-factor" />
      <div class="muted">1 新单位 = ? ${$("pBaseUnit").value}</div>
      <button class="btn secondary sm" onclick="addConvRow()">＋</button>
    </div>`);
}

function packRowsHtml(packItems) {
  const items = packItems || [];
  return items.map((it, i) => {
    const m = PRODUCTS.find((x) => x.id === it.product_id);
    const unitSel = m ? unitOptions(m, it.unit) : `<option>个</option>`;
    return `<div class="pack-row">
      <input value="${esc(m ? m.name : it.product_id)}" readonly style="background:#f9fafb;" />
      <select class="pack-unit" onchange="packUnitChanged(this)">${unitSel}</select>
      <input type="number" step="any" value="${it.quantity}" class="pack-qty" />
      <button class="btn danger sm" onclick="this.closest('.pack-row').remove()">删</button>
    </div>`;
  }).join("") + `
    <div class="pack-row">
      <select class="pack-product" onchange="packProductChanged(this)">
        <option value="">选择关联商品…</option>
        ${PRODUCTS.filter((p) => p.is_active).map((p) => `<option value="${p.id}">${esc(p.name)}</option>`).join("")}
      </select>
      <select class="pack-unit"><option>个</option></select>
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
  const baseUnit = p ? p.base_unit : "克";
  openModal(`
    <h3>${pid ? "编辑商品" : "新增商品"} <button class="close" onclick="closeModal()">✕</button></h3>
    <div class="form-grid">
      <div class="field"><label>商品编码</label><input id="pCode" value="${esc(p?.code || "")}" placeholder="如 ydj001，可留空" /></div>
      <div class="field"><label>商品名称 *</label><input id="pName" value="${esc(p?.name || "")}" placeholder="如：番茄" /></div>
      <div class="field"><label>分类</label><input id="pCategory" value="${esc(p?.category || "")}" placeholder="如：蔬菜" /></div>
      <div class="field"><label>基础单位 *</label>
        <select id="pBaseUnit" onchange="baseUnitChanged()">
          <option value="克" ${baseUnit === "克" ? "selected" : ""}>克（重量类）</option>
          <option value="个" ${baseUnit === "个" ? "selected" : ""}>个（计数类）</option>
        </select></div>
      <div class="field"><label>默认售价（每基础单位）</label><input id="pSalePrice" type="number" step="any" value="${p?.sale_price || 0}" /></div>
    </div>
    <div class="field" style="margin-top:10px;"><label>规格说明</label><input id="pSpec" value="${esc(p?.spec || "")}" placeholder="如：每个约150克；或每袋5斤" /></div>
    <hr />
    <h3>单位换算 <span class="hint">1个=多少基础单位？重量类固定 1斤=500克、1公斤=1000克</span></h3>
    <div id="convRows">${convRowsHtml(p?.conversions, baseUnit)}</div>
    <hr />
    <h3>出库关联结算清单 <span class="hint">卖1单本商品时，自动扣减这些商品的库存</span></h3>
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
}
function baseUnitChanged() {
  const bu = $("pBaseUnit").value;
  // 清空换算行重新给默认值
  const defs = bu === "克" ? { 克: 1, 斤: 500, 公斤: 1000, 千克: 1000 } : { 个: 1 };
  $("convRows").innerHTML = convRowsHtml(defs, bu);
}
function collectConvs() {
  const out = {};
  document.querySelectorAll("#convRows .conv-row").forEach((row) => {
    const u = row.querySelector(".conv-unit").value.trim();
    const f = parseFloat(row.querySelector(".conv-factor").value);
    if (u && f > 0) out[u] = f;
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
  const payload = {
    code: $("pCode").value,
    name: $("pName").value,
    category: $("pCategory").value,
    base_unit: $("pBaseUnit").value,
    spec: $("pSpec").value,
    sale_price: +$("pSalePrice").value || 0,
    conversions: collectConvs(),
    pack_items: collectPacks(),
    pack_fee: +$("pPackFee").value || 0,
    is_active: $("pActive") ? $("pActive").checked : true,
  };
  if (!payload.name.trim()) { toast("请填写商品名称"); return; }
  if (!Object.keys(payload.conversions).length) { toast("请至少配置一个单位换算"); return; }
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
function initInbound() {
  if (!$("inProduct").options.length) {
    $("inProduct").innerHTML = `<option value="">选择商品…</option>` +
      PRODUCTS.filter((p) => p.is_active).map((p) => `<option value="${p.id}">${esc(p.name)}</option>`).join("");
  }
  if (!$("inDate").value) $("inDate").value = today();
  $("inProduct").onchange = inProductChanged;
  $("inUnit").onchange = calcInbound;
  loadInbounds();
}
function inProductChanged() {
  const p = PRODUCTS.find((x) => x.id === +$("inProduct").value);
  $("inUnit").innerHTML = p ? unitOptions(p) : `<option value="">—</option>`;
  $("inStockHint").textContent = p ? `当前库存 ${fmtNum(p.stock)} ${p.base_unit}` : "";
  calcInbound();
}
function calcInbound() {
  const p = PRODUCTS.find((x) => x.id === +$("inProduct").value);
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
  const pid = +$("inProduct").value;
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
  const rows = await api(`/api/inbounds?date_from=${from || ""}&date_to=${to || ""}`);
  $("inListHint").textContent = `共 ${rows.length} 条`;
  $("inTable").innerHTML = `<thead><tr>
    <th>单号</th><th>商品</th><th>数量</th><th>折算</th><th class="num">单价</th><th class="num">金额</th>
    <th>供应商</th><th>操作员</th><th>日期</th><th></th></tr></thead><tbody>` +
    rows.map((r) => `<tr>
      <td class="mono">${r.code}</td>
      <td><b>${esc(r.product_name)}</b></td>
      <td>${fmtNum(r.quantity)} ${r.unit}</td>
      <td class="muted">= ${fmtNum(r.quantity_base)} 基础单位</td>
      <td class="num mono">${fmtMoney(r.unit_price)}/${r.unit}</td>
      <td class="num mono">${fmtMoney(r.total_amount)}</td>
      <td>${esc(r.supplier) || "—"}</td>
      <td>${esc(r.operator) || "—"}</td>
      <td>${r.date}</td>
      <td><button class="btn sm danger" onclick="deleteInbound(${r.id})">删</button></td></tr>`).join("") + `</tbody>`;
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
    <td><select onchange="saleProductChanged(this)">${productOptions()}</select></td>
    <td><select onchange="saleUnitChanged(this)"></select></td>
    <td><input type="number" step="any" value="1" oninput="saleCalcRow(this)" style="width:90px;" /></td>
    <td><input type="number" step="any" value="0" oninput="saleCalcRow(this)" style="width:100px;" /></td>
    <td class="muted sale-conv">—</td>
    <td class="num sale-sub">¥0.00</td>
    <td><button class="btn sm danger" onclick="this.closest('tr').remove()">✕</button></td>`;
  $("outSaleBody").appendChild(tr);
}
function saleProductChanged(sel) {
  const tr = sel.closest("tr");
  const p = PRODUCTS.find((x) => x.id === +sel.value);
  const unitSel = tr.querySelectorAll("select")[1];
  unitSel.innerHTML = p ? unitOptions(p) : "";
  saleUnitChanged(unitSel);
}
function saleUnitChanged(sel) {
  const tr = sel.closest("tr");
  const p = PRODUCTS.find((x) => x.id === +tr.querySelectorAll("select")[0].value);
  const unit = sel.value;
  if (p && unit && p.sale_price > 0) {
    const factor = (p.conversions || {})[unit] || 1;
    tr.querySelectorAll("input")[1].value = +(p.sale_price * factor).toFixed(2);
  }
  saleCalcRow(tr.querySelectorAll("input")[0]);
}
function saleCalcRow(inp) {
  const tr = inp.closest("tr");
  const p = PRODUCTS.find((x) => x.id === +tr.querySelectorAll("select")[0].value);
  const unit = tr.querySelectorAll("select")[1].value;
  const qty = parseFloat(tr.querySelectorAll("input")[0].value) || 0;
  const price = parseFloat(tr.querySelectorAll("input")[1].value) || 0;
  if (p && unit) {
    const factor = (p.conversions || {})[unit] || 1;
    const qb = qty * factor;
    tr.querySelector(".sale-conv").textContent = `= ${fmtNum(qb)} ${p.base_unit}`;
  }
  tr.querySelector(".sale-sub").textContent = fmtMoney(qty * price);
}
function collectSaleLines() {
  const lines = [];
  document.querySelectorAll("#outSaleBody tr").forEach((tr) => {
    const pid = +tr.querySelectorAll("select")[0].value;
    const unit = tr.querySelectorAll("select")[1].value;
    const qty = parseFloat(tr.querySelectorAll("input")[0].value);
    const price = parseFloat(tr.querySelectorAll("input")[1].value);
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
      <td><select onchange="packLineUnitChanged(this)">${m ? unitOptions(m, pl.unit) : `<option>${pl.unit}</option>`}</select></td>
      <td><input type="number" step="any" value="${pl.quantity}" oninput="packLineChanged(this)" style="width:90px;" /></td>
      <td><span class="badge pack">包装消耗</span></td>
      <td class="num mono">${fmtMoney(pl.unit_price)}/${pl.unit}</td>
      <td class="num pl-amount">${fmtMoney(pl.amount)}</td>
      <td><button class="btn sm danger" onclick="this.closest('tr').remove()">✕</button></td></tr>`;
  }).join("");
  if (!r.pack_lines.length) $("outPackBody").innerHTML = `<tr><td colspan="7" class="empty">无关联结算项（该商品未配置包装清单）</td></tr>`;
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
    const p = PRODUCTS.find((x) => x.id === +tr.querySelectorAll("select")[0].value);
    const unit = tr.querySelectorAll("select")[1].value;
    const qty = parseFloat(tr.querySelectorAll("input")[0].value) || 0;
    const price = parseFloat(tr.querySelectorAll("input")[1].value) || 0;
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
  const rows = await api(`/api/outbounds?date_from=${from || ""}&date_to=${to || ""}`);
  $("outListHint").textContent = `共 ${rows.length} 单`;
  $("outTable").innerHTML = `<thead><tr>
    <th>单号</th><th>客户</th><th>明细</th><th class="num">收入</th><th class="num">成本</th><th class="num">费用</th><th class="num">净利</th><th>日期</th><th></th></tr></thead><tbody>` +
    rows.map((o) => `<tr>
      <td class="mono">${o.code}</td>
      <td>${esc(o.customer) || "—"}</td>
      <td><button class="detail-toggle" onclick="toggleOutDetail(${o.id})">▸ 查看明细</button></td>
      <td class="num mono">${fmtMoney(o.total_amount)}</td>
      <td class="num mono">${fmtMoney(o.total_cogs)}</td>
      <td class="num mono">${fmtMoney(o.total_fee)}</td>
      <td class="num mono" style="color:${o.net_profit >= 0 ? "var(--green)" : "var(--red)"}">${fmtMoney(o.net_profit)}</td>
      <td>${o.date}</td>
      <td><button class="btn sm danger" onclick="deleteOutbound(${o.id})">删</button></td></tr>
      <tr id="od-${o.id}" style="display:none;"><td colspan="9"><div class="subtable"><table>` +
      o.lines.map((l) => `<tr>
        <td>${esc(l.product_name)}</td>
        <td>${l.line_type === "sale" ? '<span class="badge out">销售</span>' : '<span class="badge pack">包装消耗</span>'}</td>
        <td>${fmtNum(l.quantity)} ${l.unit}</td>
        <td>= ${fmtNum(l.quantity_base)} ${l.base_unit || ""}</td>
        <td class="num">${fmtMoney(l.amount)}</td>
        <td class="num">成本 ${fmtMoney(l.cogs)}</td>
        <td class="num">${l.pack_fee ? "费 " + fmtMoney(l.pack_fee) : ""}</td>
      </tr>`).join("") + `</table></div></td></tr>`).join("") + `</tbody>`;
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

/* =============== 报表 =============== */
function quickRange(kind) {
  if (kind === "today") { $("repDateFrom").value = today(); $("repDateTo").value = today(); }
  else if (kind === "month") { $("repDateFrom").value = monthStart(); $("repDateTo").value = today(); }
  else { $("repDateFrom").value = ""; $("repDateTo").value = ""; }
  loadReport();
}
async function loadReport() {
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
  if (!rep.by_product.length) pt.innerHTML = `<tr><td class="empty" colspan="4">本期无销售</td></tr>`;
  else pt.innerHTML = `<thead><tr><th>商品</th><th class="num">销量(基础单位)</th><th class="num">收入</th><th class="num">成本</th><th class="num">毛利</th></tr></thead><tbody>` +
    rep.by_product.map((p) => `<tr>
      <td>${esc(p.name)}</td><td class="num mono">${fmtNum(p.qty)}</td>
      <td class="num mono">${fmtMoney(p.amount)}</td><td class="num mono">${fmtMoney(p.cogs)}</td>
      <td class="num mono" style="color:var(--green)">${fmtMoney(p.amount - p.cogs)}</td></tr>`).join("") + `</tbody>`;

  const ft = $("financeTable");
  ft.innerHTML = `<thead><tr><th>类型</th><th>分类</th><th>商品</th><th class="num">金额</th><th>操作员</th><th>日期</th><th>备注</th><th></th></tr></thead><tbody>` +
    finance.map((f) => `<tr>
      <td>${f.type === "income" ? '<span class="badge income">收入</span>' : '<span class="badge expense">支出</span>'}</td>
      <td>${esc(f.category)}</td>
      <td>${esc(f.product_name) || "—"}</td>
      <td class="num mono" style="color:${f.type === "income" ? "var(--green)" : "var(--red)"}">${f.type === "income" ? "+" : "-"}${fmtMoney(f.amount)}</td>
      <td>${esc(f.operator) || "—"}</td><td>${f.date}</td>
      <td class="muted">${esc(f.remark)}</td>
      <td>${f.ref_type === "manual" ? `<button class="btn sm danger" onclick="deleteFinance(${f.id})">删</button>` : ""}</td></tr>`).join("") + `</tbody>`;
  if (!finance.length) ft.innerHTML = `<tr><td colspan="8" class="empty">本期无财务流水</td></tr>`;
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
  const rows = await api(`/api/movements?product_id=${pid}&date_from=${from || ""}&date_to=${to || ""}`);
  const typeBadge = { in: '<span class="badge in">入库</span>', out: '<span class="badge out">出库</span>', pack_out: '<span class="badge pack">包装消耗</span>', adjust: '<span class="badge adjust">盘点</span>' };
  $("mvTable").innerHTML = `<thead><tr>
    <th>时间</th><th>商品</th><th>类型</th><th class="num">变动(基础单位)</th><th class="num">金额</th><th>操作员</th><th>备注</th></tr></thead><tbody>` +
    rows.map((m) => `<tr>
      <td class="mono">${m.date}</td>
      <td>${esc(m.product_name)}</td>
      <td>${typeBadge[m.move_type] || m.move_type}</td>
      <td class="num mono" style="color:${m.quantity_base >= 0 ? "var(--green)" : "var(--red)"}">${m.quantity_base >= 0 ? "+" : ""}${fmtNum(m.quantity_base)}</td>
      <td class="num mono">${fmtMoney(m.amount)}</td>
      <td>${esc(m.operator) || "—"}</td>
      <td class="muted">${esc(m.remark)}</td></tr>`).join("") + `</tbody>`;
  if (!rows.length) $("mvTable").innerHTML = `<tr><td colspan="7" class="empty">暂无流水</td></tr>`;
}

/* ---------- HTML 转义 ---------- */
function esc(s) {
  return String(s ?? "").replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));
}

/* ---------- 初始化 ---------- */
(async function init() {
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
    PRODUCTS.map((p) => `<option value="${p.id}">${esc(p.name)}</option>`).join("");
  $("inProduct").innerHTML = `<option value="">选择商品…</option>` +
    PRODUCTS.filter((p) => p.is_active).map((p) => `<option value="${p.id}">${esc(p.name)}</option>`).join("");
  $("inProduct").onchange = inProductChanged;
  $("inUnit").onchange = calcInbound;
  $("inDate").value = today();
  $("outDate").value = today();
  $("inDateFrom").value = monthStart();
  $("inDateTo").value = today();
  loadDashboard();
})();

/* =============== 批量导入 =============== */
function downloadTpl(kind) {
  window.location.href = `/api/templates/${kind}`;
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

/* =============== 聚水潭编码关联 =============== */
async function loadMappingPage() {
  populateMpNewProduct();
  const r = await api("/api/mappings");
  renderSavedMappings(r);
  $("mpParseInfo").innerHTML = "";
  $("mpTable").innerHTML = "";
  if (r.length) {
    $("mpParseInfo").innerHTML = `<div class="alert ok">已保存 <b>${r.length}</b> 条关联记录，可在「② 已保存的关联关系」中查看修改。</div>`;
  }
}
function populateMpNewProduct() {
  $("mpNewProduct").innerHTML = `<option value="">选择关联到系统商品…</option>` +
    PRODUCTS.map((p) => `<option value="${p.id}">${esc(p.name)}</option>`).join("");
}
function renderSavedMappings(rows) {
  const t = $("mpSavedTable");
  if (!rows.length) {
    t.innerHTML = `<tr><td class="empty" colspan="4">暂无已保存的关联关系。可在上方①解析后保存，或在此手动新增。</td></tr>`;
    return;
  }
  const optHtml = (pid) =>
    `<option value="">— 不关联 —</option>` +
    PRODUCTS.map((p) => `<option value="${p.id}" ${String(p.id) === String(pid) ? "selected" : ""}>${esc(p.name)}</option>`).join("");
  t.innerHTML = `<thead><tr>
    <th>外部商品编码（聚水潭）</th><th>关联到系统商品</th><th>来源</th><th>操作</th></tr></thead><tbody>` +
    rows.map((m) => `<tr data-id="${m.id}">
      <td><b>${esc(m.external_code)}</b></td>
      <td><select class="saved-select" data-code="${esc(m.external_code)}">${optHtml(m.product_id)}</select></td>
      <td class="muted">${m.auto_score ? `自动匹配 ${Math.round(m.auto_score * 100)}%` : "手动"}</td>
      <td><button class="btn sm danger" onclick="deleteMappingRow(${m.id}, '${esc(m.external_code)}')">删除</button></td></tr>`).join("") + `</tbody>`;
}
async function saveSavedMappings() {
  const items = [];
  document.querySelectorAll("#mpSavedTable .saved-select").forEach((sel) => {
    if (sel.value) items.push({ external_code: sel.dataset.code, product_id: +sel.value });
  });
  if (!items.length) { toast("没有有效的关联（未选择商品）"); return; }
  try {
    const r = await api("/api/mappings/bulk", "POST", { source: "jushuitan", items });
    toast(`已保存修改 ${r.saved} 条`);
    loadMappingPage();
  } catch (e) { toast("保存失败：" + e.message); }
}
async function deleteMappingRow(id, code) {
  if (!confirm(`确认删除关联「${code}」？`)) return;
  try { await api("/api/mappings/" + id, "DELETE"); toast("已删除"); loadMappingPage(); }
  catch (e) { toast("删除失败：" + e.message); }
}
async function addMappingRow() {
  const code = $("mpNewCode").value.trim();
  const pid = $("mpNewProduct").value;
  if (!code) { toast("请输入外部商品编码"); return; }
  if (!pid) { toast("请选择要关联的系统商品"); return; }
  try {
    await api("/api/mappings", "POST", { source: "jushuitan", external_code: code, product_id: +pid });
    toast("已新增关联");
    $("mpNewCode").value = "";
    loadMappingPage();
  } catch (e) { toast("新增失败：" + e.message); }
}
async function parseJushuitan() {
  const file = $("mpFile").files[0];
  if (!file) { toast("请先选择聚水潭出库单文件"); return; }
  try {
    const r = await apiUpload("/api/jushuitan/parse", file);
    MP_CODES = r.codes;
    const skip = Object.entries(r.skip).filter(([, v]) => v > 0).map(([k, v]) => `${k} ${v}单`).join("、");
    $("mpParseInfo").innerHTML = `<div class="alert ok">共 <b>${r.total_orders}</b> 单已出库，解析出 <b>${r.codes.length}</b> 种商品${skip ? `，跳过（${skip}）` : ""}。系统已自动推荐匹配，请核对后「保存全部关联」。</div>`;
    renderMpTable(r.codes);
  } catch (e) { $("mpParseInfo").innerHTML = `<div class="alert err">解析失败：${esc(e.message)}</div>`; }
}
function renderMpTable(codes) {
  const optHtml = (pid) =>
    `<option value="">— 不关联 —</option>` +
    PRODUCTS.map((p) => `<option value="${p.id}" ${String(p.id) === String(pid) ? "selected" : ""}>${esc(p.name)}</option>`).join("");
  $("mpTable").innerHTML = `<thead><tr>
    <th>聚水潭商品</th><th class="num">出现次数</th><th>推荐匹配</th><th>关联到系统商品</th><th>状态</th></tr></thead><tbody>` +
    codes.map((c) => {
      const matched = !!c.product_id;
      const selId = c.product_id || c.suggest_id || "";
      const score = c.score;
      const tag = matched
        ? `<span class="badge in">已关联</span>`
        : (selId ? `<span class="badge adjust">建议匹配</span>` : `<span class="badge off">待关联</span>`);
      return `<tr>
        <td><b>${esc(c.external_code)}</b></td>
        <td class="num">${c.count}</td>
        <td class="muted">${c.suggest_name ? `${esc(c.suggest_name)} <span class="muted">(${Math.round(score * 100)}%)</span>` : "—"}</td>
        <td><select class="mp-select" data-code="${esc(c.external_code)}" onchange="mpSelectChanged(this)">${optHtml(selId)}</select></td>
        <td>${tag}</td></tr>`;
    }).join("") + `</tbody>`;
  // 未保存过的：匹配度>=50% 的自动选中，弱匹配留待人工确认
  document.querySelectorAll("#mpTable .mp-select").forEach((sel) => {
    const c = MP_CODES.find((x) => x.external_code === sel.dataset.code);
    if (c && !c.product_id && c.suggest_id && (c.score || 0) >= 0.5) sel.value = String(c.suggest_id);
  });
}
function mpSelectChanged(sel) {
  const c = MP_CODES.find((x) => x.external_code === sel.dataset.code);
  if (c) c.product_id = sel.value ? +sel.value : null;
}
async function saveMappings() {
  // 以表格下拉框的实际选择为准（自动选中的推荐项也在其中）
  const items = [];
  document.querySelectorAll("#mpTable .mp-select").forEach((sel) => {
    if (sel.value) items.push({ external_code: sel.dataset.code, product_id: +sel.value });
  });
  if (!items.length) { toast("没有可保存的关联，请先在列表中选择要关联的商品"); return; }
  try {
    const r = await api("/api/mappings/bulk", "POST", { source: "jushuitan", items });
    toast(`已保存 ${r.saved} 条关联`);
    loadMappingPage();
  } catch (e) { toast("保存失败：" + e.message); }
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
