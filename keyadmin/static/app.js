/* 私钥管理工具 - 前端逻辑 */
const $ = (id) => document.getElementById(id);
let KEY_USERS = [];

function toast(msg, ms = 2400) {
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
  if (res.status === 401) {
    // 会话过期回到门禁
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
  const password = $("gatePass").value;
  if (!password) { gateErr("请输入管理员密码"); return; }
  try {
    await api("/api/login", "POST", { password });
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
    }
    // 未通过门禁则保持密码框
  } catch (e) {}
})();
