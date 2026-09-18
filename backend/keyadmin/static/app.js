/* 私钥管理工具 - 前端逻辑 */
const $ = (id) => document.getElementById(id);
let KEY_USERS = [];
let MAINT = null;        // 最近一次维护状态
let MAINT_TICK = null;   // 维护倒计时定时器
let MAINT_FORM_INIT = false;
let LOG_TIMER = null;    // 网站日志自动刷新定时器
let LOG_OFFSET = 0;
let LOG_TOTAL = 0;
let CUR_PANEL = "login";
const LOG_PAGE = 100;

const PANEL_TITLES = {
  login: "登录管理",
  maint: "更新维护",
  logs: "网站日志",
  backup: "备份与恢复",
  clear: "数据清理",
};

function toast(msg, ms = 2600) {
  const t = $("toast");
  t.textContent = msg;
  t.classList.add("show");
  clearTimeout(t._timer);
  t._timer = setTimeout(() => t.classList.remove("show"), ms);
}
function esc(s) {
  return String(s ?? "").replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));
}
async function api(path, method = "GET", body) {
  const opt = { method, headers: {} };
  if (body !== undefined) { opt.headers["Content-Type"] = "application/json"; opt.body = JSON.stringify(body); }
  const res = await fetch(path, opt);
  if (res.status === 401 && path !== "/api/login") {
    // 会话过期回到门禁；登录接口自身的 401 是"账号或密码错误"，
    // 不能刷新页面，否则会把用户已填的账号和密码清空
    location.reload();
    throw new Error("未验证");
  }
  if (!res.ok) {
    let msg = "请求失败";
    try { const j = await res.json(); msg = j.detail || msg; } catch (e) {}
    throw new Error(msg);
  }
  return res.json();
}

/* ---------- 门禁 ---------- */
async function gateLogin() {
  const username = $("gateUser").value.trim();
  const password = $("gatePass").value;
  if (!username) { gateErr("请输入管理员账号"); return; }
  if (!password) { gateErr("请输入管理员密码"); return; }
  try {
    await api("/api/login", "POST", { username, password });
    location.reload();
  } catch (e) {
    gateErr(e.message);
  }
}
function gateErr(msg) {
  const el = $("gateErr");
  el.textContent = msg;
  el.style.display = "block";
}
async function logout() {
  try { await api("/api/logout", "POST"); } catch (e) {}
  location.reload();
}

/* ---------- 登录锁定查看 / 手动解锁 ---------- */
/* 失败分级锁定由后端 app/login_guard.py 统一维护（主系统与工具共用一份状态文件），
   这里只是给管理员一个"忘记密码被锁死"时的解锁入口。 */
function fmtLocks(list) {
  if (!list.length) return "（无）";
  return list.map((x) => `${x.username}：剩 ${x.left_text}，已连续失败 ${x.fails} 次`).join("\n");
}
async function showLocks() {
  try {
    const d = await api("/api/locks");
    alert(`【业务主系统】\n${fmtLocks(d.erp)}\n\n【私钥管理工具】\n${fmtLocks(d.keyadmin)}`);
  } catch (e) {
    toast("读取锁定状态失败：" + e.message);
  }
}
async function unlockLogin(scope) {
  const label = scope === "erp" ? "业务主系统" : "私钥管理工具";
  const name = prompt(`解除【${label}】的登录锁定。\n\n输入用户名解除单个账号；留空则解除该系统全部账号：`);
  if (name === null) return;
  try {
    const d = await api("/api/unlock", "POST", { scope, username: name.trim() });
    toast(d.cleared ? `已解除 ${d.cleared} 个账号的锁定` : "该账号当前没有被锁定");
  } catch (e) {
    toast("解锁失败：" + e.message);
  }
}

/* ---------- 侧边栏分区切换 ---------- */
function switchPanel(panel) {
  CUR_PANEL = panel;
  document.querySelectorAll(".side-item").forEach((b) => b.classList.toggle("active", b.dataset.panel === panel));
  document.querySelectorAll(".panel").forEach((s) => s.classList.toggle("active", s.id === "panel-" + panel));
  $("pageTitle").textContent = PANEL_TITLES[panel] || "";
  if (panel === "maint") loadMaint();
  if (panel === "logs") refreshLogs();
  if (panel === "backup") loadBackups();
  if (panel === "clear" && !$("clWarehouse").options.length) loadClearWarehouses();
  logAutoToggle();
}

/* ---------- 生成私钥 ---------- */
async function genKey() {
  const username = $("kuUsername").value.trim();
  if (!username) { toast("请输入用户名"); return; }
  try {
    const r = await api("/api/keys", "POST", {
      username, name: $("kuName").value.trim(), role: $("kuRole").value,
    });
    showKeyModal(username, r.private_key, r.fingerprint);
    $("kuUsername").value = "";
    $("kuName").value = "";
    loadUsers();
  } catch (e) { toast("生成失败：" + e.message); }
}

/* ---------- 账号列表 ---------- */
async function loadUsers() {
  try { KEY_USERS = await api("/api/users"); }
  catch (e) { toast("加载失败：" + e.message); return; }
  const t = $("kuTable");
  const rows = KEY_USERS;
  t.innerHTML = `<thead><tr>
    <th>用户名</th><th>姓名</th><th>角色</th><th>公钥指纹</th><th>密钥生成时间</th><th>操作</th>
  </tr></thead><tbody>` +
  (rows.length ? rows.map((u) => `<tr>
    <td><b>${esc(u.username)}</b></td>
    <td>${esc(u.name) || "—"}</td>
    <td>${u.role === "admin" ? '<span class="badge admin">管理员</span>' : "业务员"}</td>
    <td class="mono">${u.has_key ? esc(u.fingerprint) : '<span class="muted">未生成</span>'}</td>
    <td class="muted">${u.key_created_at ? u.key_created_at.replace("T", " ").slice(0, 19) : "—"}</td>
    <td class="line-actions">
      <button class="btn sm" onclick="regenKey(${u.id}, '${esc(u.username)}')">${u.has_key ? "重新生成" : "生成密钥"}</button>
      <button class="btn sm ghost" onclick="editUser(${u.id})">编辑</button>
      <button class="btn sm danger" onclick="delUser(${u.id}, '${esc(u.username)}')">删除</button>
    </td>
  </tr>`).join("") : `<tr><td colspan="6" class="empty">暂无账号，请先在上方输入用户名生成第一个私钥</td></tr>`) + `</tbody>`;
}
async function regenKey(id, username) {
  if (!confirm(`确认重新生成「${username}」的密钥？旧私钥将立即失效。`)) return;
  try {
    const r = await api(`/api/users/${id}/regenerate`, "POST");
    showKeyModal(username, r.private_key, r.fingerprint);
    loadUsers();
  } catch (e) { toast("操作失败：" + e.message); }
}
function editUser(id) {
  const u = KEY_USERS.find((x) => x.id === id);
  if (!u) return;
  openModal(`
    <h3>编辑账号 <button class="close" onclick="closeModal()">✕</button></h3>
    <div class="form-grid">
      <div class="field"><label>用户名</label><input value="${esc(u.username)}" disabled /></div>
      <div class="field"><label>姓名</label><input id="euName" value="${esc(u.name)}" /></div>
      <div class="field"><label>角色</label>
        <select id="euRole"><option value="user" ${u.role === "user" ? "selected" : ""}>业务员</option><option value="admin" ${u.role === "admin" ? "selected" : ""}>管理员</option></select>
      </div>
    </div>
    <div class="form-actions"><button class="btn primary" onclick="saveEditUser(${id})">保存</button></div>
  `);
}
async function saveEditUser(id) {
  try {
    await api(`/api/users/${id}`, "PUT", { name: $("euName").value.trim(), role: $("euRole").value });
    closeModal();
    toast("已保存");
    loadUsers();
  } catch (e) { toast("保存失败：" + e.message); }
}
async function delUser(id, username) {
  if (!confirm(`确认删除账号「${username}」？删除后该用户将无法登录。`)) return;
  try {
    await api(`/api/users/${id}`, "DELETE");
    toast("已删除");
    loadUsers();
  } catch (e) { toast("删除失败：" + e.message); }
}
async function syncUsers() {
  if (!confirm("确认将默认仓（奥斯迪）的全部账号与私钥同步到其他分仓？\n这样同一私钥即可登录所有分仓。")) return;
  try {
    const r = await api("/api/users/sync", "POST");
    toast(r.note || "已同步");
    loadUsers();
  } catch (e) { toast("同步失败：" + e.message); }
}

/* =============== 更新维护（停服公告 / 维护模式） =============== */
function fmtCountdown(sec) {
  sec = Math.max(0, Math.floor(sec || 0));
  const m = Math.floor(sec / 60);
  const s = sec % 60;
  return m > 0 ? `${m} 分 ${String(s).padStart(2, "0")} 秒` : `${s} 秒`;
}
function maintMode(st) {
  return st.effective_mode || st.mode || "off";
}
function maintBadge(mode) {
  if (mode === "maintenance") return { cls: "maint-badge on", text: "⛔ 维护中" };
  if (mode === "announce") return { cls: "maint-badge warn", text: "📢 停服公告中" };
  return { cls: "maint-badge off", text: "🟢 正常服务" };
}
async function loadMaint() {
  try { MAINT = await api("/api/maintenance"); }
  catch (e) { toast("加载维护状态失败：" + e.message); return; }
  if (!MAINT_FORM_INIT) {
    MAINT_FORM_INIT = true;
    if (MAINT.lead_minutes) $("mtLead").value = MAINT.lead_minutes;
    if (MAINT.eta_minutes) $("mtEta").value = MAINT.eta_minutes;
    $("mtMsg").value = MAINT.message || "";
    $("mtAutoResume").checked = MAINT.auto_resume_on_start !== false;
  }
  renderMaint();
  if (MAINT_TICK) { clearInterval(MAINT_TICK); MAINT_TICK = null; }
  if (maintMode(MAINT) === "announce" && (MAINT.remaining_seconds || 0) > 0) {
    MAINT_TICK = setInterval(() => {
      MAINT.remaining_seconds -= 1;
      if (MAINT.remaining_seconds <= 0) {
        clearInterval(MAINT_TICK); MAINT_TICK = null;
        loadMaint();
        return;
      }
      renderMaint();
    }, 1000);
  }
}
function renderMaint() {
  if (!MAINT) return;
  const mode = maintMode(MAINT);
  const b = maintBadge(mode);
  const eta = MAINT.eta_minutes || 0;
  let detail = "";
  if (mode === "announce") {
    detail = `用户端顶部正在滚动提示：<b>还有 ${fmtCountdown(MAINT.remaining_seconds)} 停机维护</b>，预计维护 ${eta} 分钟。倒计时结束自动进入维护页。`;
  } else if (mode === "maintenance") {
    detail = `用户端已显示「系统维护中」整屏页面，预计 ${eta} 分钟后恢复。${MAINT.auto_resume_on_start ? "再次启动主服务会自动结束维护。" : "需在此手动点「结束维护」。"}`;
  } else {
    detail = "系统正常对外服务。发布公告后可提前通知用户停服时间。";
  }
  if (MAINT.message) detail += `<br />公告文案：${esc(MAINT.message)}`;
  const el = $("maintStatus");
  if (el) {
    el.innerHTML = `<span class="${b.cls}">${b.text}</span><div class="ms-detail">${detail}</div>`;
  }
  const hint = $("topHint");
  if (hint) {
    hint.innerHTML = mode === "off"
      ? "当前状态：正常服务"
      : mode === "announce"
        ? `当前状态：<b style="color:#ed6a0c;">停服倒计时 ${fmtCountdown(MAINT.remaining_seconds)}</b>`
        : '当前状态：<b style="color:#d13438;">维护中</b>';
  }
}
function maintForm() {
  return {
    lead_minutes: Math.max(1, parseInt($("mtLead").value, 10) || 10),
    eta_minutes: Math.max(1, parseInt($("mtEta").value, 10) || 30),
    message: $("mtMsg").value.trim(),
    auto_resume_on_start: $("mtAutoResume").checked,
  };
}
async function maintAnnounce() {
  const f = maintForm();
  if (!confirm(
    `确认发布停服公告？\n\n· ${f.lead_minutes} 分钟后开始停服维护\n· 预计维护时长 ${f.eta_minutes} 分钟\n\n` +
    "用户端顶部将滚动提示并倒计时，倒计时结束自动显示维护页。"
  )) return;
  try {
    MAINT = await api("/api/maintenance/announce", "POST", f);
    MAINT_FORM_INIT = true;
    toast("公告已发布，开始倒计时");
    renderMaint();
  } catch (e) { toast("发布失败：" + e.message); }
}
async function maintStart() {
  const f = maintForm();
  if (!confirm(`确认立即进入维护模式？\n\n用户端会立刻显示「系统维护中」，预计 ${f.eta_minutes} 分钟完成。`)) return;
  try {
    MAINT = await api("/api/maintenance/start", "POST", f);
    MAINT_FORM_INIT = true;
    toast("已进入维护模式");
    renderMaint();
  } catch (e) { toast("操作失败：" + e.message); }
}
async function maintCancel() {
  if (!confirm("确认结束维护 / 取消公告，恢复正常访问？")) return;
  try {
    MAINT = await api("/api/maintenance/cancel", "POST");
    MAINT_FORM_INIT = false;
    toast("已恢复正常访问");
    renderMaint();
  } catch (e) { toast("操作失败：" + e.message); }
}

/* =============== 网站日志 =============== */
function statusCls(code) {
  if (!code) return "st-bad";
  if (code >= 500) return "st-bad";
  if (code >= 400) return "st-warn";
  return "st-ok";
}
function logAutoToggle() {
  if (LOG_TIMER) { clearInterval(LOG_TIMER); LOG_TIMER = null; }
  if (CUR_PANEL === "logs" && $("logAuto").checked) {
    LOG_TIMER = setInterval(() => { refreshLogs(true); }, 3000);
  }
}
async function refreshLogs(silent) {
  await loadLogSummary(silent);
  await loadLogs(false, silent);
}
async function loadLogSummary(silent) {
  let s;
  try { s = await api("/api/activity/summary?minutes=5"); }
  catch (e) { if (!silent) toast("加载概览失败：" + e.message); return; }
  const box = $("logStats");
  if (box) {
    box.innerHTML = `
      <div class="stat"><div class="stat-v">${s.online_people}</div><div class="stat-l">当前在线（账号/IP）</div></div>
      <div class="stat"><div class="stat-v">${s.online_ips}</div><div class="stat-l">活跃 IP 数</div></div>
      <div class="stat"><div class="stat-v">${s.today_requests}</div><div class="stat-l">今日请求数</div></div>
      <div class="stat"><div class="stat-v ${s.today_errors ? "danger" : ""}">${s.today_errors}</div><div class="stat-l">今日错误数</div></div>
      <div class="stat"><div class="stat-v">${s.avg_ms} ms</div><div class="stat-l">今日平均响应</div></div>
      <div class="stat"><div class="stat-v">${s.total_rows}</div><div class="stat-l">日志总数</div></div>
    `;
  }
  const t = $("onlineTable");
  if (!t) return;
  const rows = s.online || [];
  t.innerHTML = `<thead><tr><th>账号</th><th>IP</th><th>最近活动</th><th>近 5 分钟请求</th><th>最近访问</th></tr></thead><tbody>` +
    (rows.length ? rows.map((o) => `<tr>
      <td><b>${esc(o.username)}</b></td>
      <td class="mono">${esc(o.ip) || "—"}</td>
      <td class="muted">${esc(o.last_time)}</td>
      <td>${o.requests}</td>
      <td class="mono path-cell" title="${esc(o.last_path)}">${esc(o.last_path)}</td>
    </tr>`).join("") : `<tr><td colspan="5" class="empty">近 5 分钟没有任何访问（无人使用系统）</td></tr>`) + `</tbody>`;
}
async function loadLogs(reset, silent) {
  if (reset) LOG_OFFSET = 0;
  const q = $("logQ").value.trim();
  const only = $("logErr").checked;
  const minutes = $("logMinutes").value;
  let r;
  try {
    r = await api(
      `/api/activity/logs?limit=${LOG_PAGE}&offset=${LOG_OFFSET}` +
      `&q=${encodeURIComponent(q)}&only_error=${only}&minutes=${minutes}`
    );
  } catch (e) { if (!silent) toast("加载日志失败：" + e.message); return; }
  LOG_TOTAL = r.total || 0;
  const t = $("logTable");
  const items = r.items || [];
  t.innerHTML = `<thead><tr>
    <th>时间</th><th>账号</th><th>IP</th><th>方法</th><th>路径</th><th>状态</th><th>耗时</th>
  </tr></thead><tbody>` +
    (items.length ? items.map((x) => `<tr>
      <td class="muted">${esc(x.time)}</td>
      <td>${x.username ? `<b>${esc(x.username)}</b>` : '<span class="muted">未登录</span>'}</td>
      <td class="mono">${esc(x.ip)}</td>
      <td class="mono">${esc(x.method)}</td>
      <td class="mono path-cell" title="${esc(x.path + (x.query ? "?" + x.query : ""))}">${esc(x.path)}${x.query ? `<span class="muted">?${esc(x.query.slice(0, 40))}</span>` : ""}</td>
      <td class="${statusCls(x.status)}">${x.status || "—"}</td>
      <td class="muted">${x.ms} ms</td>
    </tr>`).join("") : `<tr><td colspan="7" class="empty">没有符合条件的日志</td></tr>`) + `</tbody>`;
  const start = LOG_TOTAL ? LOG_OFFSET + 1 : 0;
  $("logCount").textContent = `共 ${LOG_TOTAL} 条，显示 ${start}-${Math.min(LOG_OFFSET + LOG_PAGE, LOG_TOTAL)} 条`;
}
function logPage(dir) {
  const next = LOG_OFFSET + dir * LOG_PAGE;
  if (next < 0 || (dir > 0 && next >= LOG_TOTAL)) return;
  LOG_OFFSET = next;
  loadLogs(false);
}
function exportLogs() {
  window.location.href = `/api/activity/export?minutes=${$("logMinutes").value}`;
}
async function clearLogs() {
  if (!confirm("确认清空全部网站访问日志？该操作不可撤销。")) return;
  try {
    const r = await api("/api/activity/logs", "DELETE");
    toast(`已清空 ${r.deleted} 条日志`);
    refreshLogs();
  } catch (e) { toast("清空失败：" + e.message); }
}

/* ---------- 备份与应急抢救（后门） ---------- */
async function loadBackups() {
  try {
    const r = await api("/api/backups");
    const rows = r.backups || [];
    const t = $("bkTable");
    t.innerHTML = `<thead><tr><th>文件名</th><th>大小</th><th>备份时间</th><th>操作</th></tr></thead><tbody>` +
      (rows.length ? rows.map((b) => `<tr>
        <td class="mono">${esc(b.name)}</td>
        <td>${esc(b.size_human)}</td>
        <td class="muted">${esc(b.mtime)}</td>
        <td class="line-actions">
          <button class="btn sm danger" onclick="restoreBackup('${esc(b.name)}')">恢复</button>
          <button class="btn sm ghost" onclick="delBackup('${esc(b.name)}')">删除</button>
        </td>
      </tr>`).join("") : `<tr><td colspan="4" class="empty">暂无备份文件（data/backups）</td></tr>`) + `</tbody>`;
  } catch (e) { toast("加载备份失败：" + e.message); }
}
async function creBackup() {
  try {
    const r = await api("/api/backup", "POST");
    toast("已创建备份：" + r.name);
    loadBackups();
  } catch (e) { toast("备份失败：" + e.message); }
}
async function restoreBackup(name) {
  if (!confirm(`确认用备份「${name}」覆盖当前数据库？\n恢复后当前未保存的数据将丢失，且所有人需重新登录。`)) return;
  try {
    const r = await api("/api/backup/restore", "POST", { name });
    toast("已恢复备份：" + (r.restored || name));
    loadBackups();
    loadUsers();
  } catch (e) { toast("恢复失败：" + e.message); }
}
async function delBackup(name) {
  if (!confirm(`确认删除备份「${name}」？`)) return;
  try {
    await api(`/api/backup/${encodeURIComponent(name)}`, "DELETE");
    toast("已删除备份");
    loadBackups();
  } catch (e) { toast("删除失败：" + e.message); }
}
async function resetAdminLogin() {
  if (!confirm("确认重置初始管理员的登录私钥？\n旧私钥将立即失效；将重新生成一个用于 ERP 登录的私钥，请立即下载保存。")) return;
  try {
    const r = await api("/api/rescue/reset-admin", "POST");
    toast(r.note || "已重置");
    loadUsers();
    const it = (r.items || [])[0];
    if (it) showKeyModal(it.username, it.private_key, it.fingerprint);
    else toast("未找到初始管理员账号");
  } catch (e) { toast("重置失败：" + e.message); }
}

/* ---------- 数据清理（细化清除） ---------- */
async function loadClearWarehouses() {
  try {
    const r = await api("/api/clear/warehouses");
    const sel = $("clWarehouse");
    sel.innerHTML = (r.warehouses || []).map((w) =>
      `<option value="${esc(w.key)}">${esc(w.name)}（${esc(w.key)}）</option>`
    ).join("");
    await loadClearItems();
  } catch (e) { toast("加载分仓失败：" + e.message); }
}
async function loadClearItems() {
  const key = $("clWarehouse").value;
  if (!key) return;
  try {
    const r = await api(`/api/clear/items?key=${encodeURIComponent(key)}`);
    const box = $("clItems");
    box.innerHTML = (r.items || []).map((it) => `
      <label class="clear-item${it.count ? "" : " is-empty"}">
        <input type="checkbox" class="cl-item" value="${esc(it.key)}" />
        <span class="ci-name">${esc(it.name)}</span>
        <span class="ci-count">${it.count} 行</span>
        <span class="ci-desc">${esc(it.desc)}</span>
      </label>
    `).join("");
  } catch (e) { toast("加载清除项失败：" + e.message); }
}
function toggleAllClear(checked) {
  document.querySelectorAll(".cl-item").forEach((c) => { c.checked = checked; });
}
function selectedClearItems() {
  return [...document.querySelectorAll(".cl-item:checked")].map((c) => c.value);
}
async function runClear() {
  const key = $("clWarehouse").value;
  const items = selectedClearItems();
  if (!items.length) { toast("请先勾选要清除的数据类别"); return; }
  const names = [...document.querySelectorAll(".cl-item:checked")].map((c) =>
    c.closest(".clear-item").querySelector(".ci-name").textContent
  );
  const backup = $("clBackup").checked;
  const msg = `确认清除分仓「${key}」的以下数据？\n\n· ${names.join("\n· ")}\n\n${backup ? "清除前会自动备份数据库。" : "⚠ 已关闭自动备份！"}此操作不可撤销，请谨慎。`;
  if (!confirm(msg)) return;
  try {
    const r = await api("/api/clear", "POST", { key, items, backup });
    const detail = Object.entries(r.cleared || {}).map(([t, n]) => `${t}: ${n} 行`).join("，");
    toast(`清除完成（${r.warehouse}）：${detail || "无数据"}`);
    await loadClearItems();
  } catch (e) { toast("清除失败：" + e.message); }
}

/* ---------- 私钥弹窗 ---------- */
function openModal(html) {
  $("modalBox").innerHTML = html;
  $("modalMask").classList.add("show");
}
function closeModal() { $("modalMask").classList.remove("show"); }
$("modalMask").addEventListener("click", (e) => { if (e.target.id === "modalMask") closeModal(); });

function showKeyModal(username, privateKey, fp) {
  window._lastPrivKey = privateKey;
  window._lastPrivUser = username || "erp_key";
  openModal(`
    <h3>私钥已生成 <button class="close" onclick="closeModal()">✕</button></h3>
    <p class="hint">账号 <b>${esc(username)}</b> 的 Ed25519 私钥已生成。私钥仅显示这一次，请点击「下载」保存并妥善保管，把文件交给对方后即可在 ERP 登录页登录。</p>
    <div class="key-box"><pre>${esc(privateKey)}</pre></div>
    <div class="toolbar" style="margin-top:12px;">
      <button class="btn primary" onclick="downloadKey()">⬇ 下载私钥文件</button>
      <button class="btn ghost" onclick="copyKey()">📋 复制私钥</button>
    </div>
    <p class="hint" style="margin-top:10px;">公钥指纹：<span class="mono">${esc(fp)}</span></p>
  `);
}
function downloadKey() {
  const blob = new Blob([window._lastPrivKey || ""], { type: "application/x-pem-file" });
  const a = document.createElement("a");
  a.href = URL.createObjectURL(blob);
  a.download = (window._lastPrivUser || "erp_key") + "_id_ed25519.pem";
  a.click();
  URL.revokeObjectURL(a.href);
  toast("私钥已下载，请妥善保管");
}
function copyKey() {
  navigator.clipboard.writeText(window._lastPrivKey || "").then(() => toast("已复制到剪贴板")).catch(() => toast("复制失败，请手动选择复制"));
}

/* ---------- 初始化 ---------- */
(async function init() {
  try {
    const s = await api("/api/session");
    if (s.authed) {
      $("gate").style.display = "none";
      $("admin").style.display = "";
      await loadUsers();
      loadBackups();
      loadMaint();   // 顶栏实时显示「正常 / 倒计时 / 维护中」，后台每 5 秒同步一次
      setInterval(() => { if (CUR_PANEL !== "maint") loadMaint(); }, 5000);
    }
    // 未通过门禁则保持密码框
  } catch (e) {}
})();
