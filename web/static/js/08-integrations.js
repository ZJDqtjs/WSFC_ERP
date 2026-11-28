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
  // 出库记录列表默认只筛「昨天」，而自动出库导的可能是前几天的单，容易被误判成"没建单"：
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
        <span class="muted" style="margin-left:6px;">出库记录默认只看昨天，记得把日期改到这天</span></div>`;
    }
  }
  if (JST_PENDING_N) {
    jump = `<div style="margin-top:6px;"><button class="btn sm danger" onclick="jstScrollPending()">⚠ 有 ${JST_PENDING_N} 项待办要处理 → 去处理</button></div>` + jump;
  }
  const box = $("jstRunStatus");
  if (box) box.innerHTML = (lines.map((l) => `<div>${esc(l)}</div>`).join("") || "<div>还没有执行记录</div>") + jump;
}

/* 跳到出库记录页并把日期筛选设成本次导出区间（否则默认只看昨天，看不到这几天的单） */
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
  if (o.clearCookie && !(await uiConfirm("确认清空已保存的聚水潭 Cookie？（下次执行会用账号密码重新登录）"))) return;
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
  if (dry && !(await uiConfirm("只导出试跑：会真的去聚水潭导出文件，但不会在本分仓建出库单。继续？"))) return;
  if (!dry && !(await uiConfirm("立即执行：按当前设置导出并直接在本分仓建出库单。继续？"))) return;
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

/* =============== 自动出库设置：模块切换（聚水潭 / 京麦 · POP 店） =============== */
let AUTO_MODULE = "jst";
let POP_AUTO = null;
let POP_POLL = null;

/* 顶部模块切换按钮：两套设置各管各的，切换只切显示，互不覆盖 */
function switchAutoModule(mod) {
  AUTO_MODULE = mod === "pop" ? "pop" : "jst";
  document.querySelectorAll("#autoModuleSeg .seg-item").forEach((x) => {
    x.classList.toggle("active", x.dataset.mod === AUTO_MODULE);
  });
  document.querySelectorAll("#page-settings .auto-module").forEach((x) => {
    x.style.display = x.dataset.mod === AUTO_MODULE ? "" : "none";
  });
  const hint = $("autoModuleHint");
  if (hint) {
    hint.textContent = AUTO_MODULE === "pop"
      ? "京麦：定时从 jdfenxi 拉京东 POP 店订单，按供货价（再扣店铺扣点）建出库单；订单取消可自动红冲。"
      : "聚水潭：定时导出销售出库单（xlsx），下载后直接在本分仓建出库单。";
  }
  if (AUTO_MODULE === "pop" && !POP_AUTO) loadPopAutoPage();
}

/* ---------- 京麦（POP 店） ---------- */
async function loadPopAutoPage() {
  try {
    fillPopAuto(await api("/api/pop-auto/settings"));
  } catch (e) { toast("加载京麦设置失败：" + e.message); }
}

function popAccountsText(list) {
  return (list || []).map((a) => `${a.account}=${a.customer || a.label || ""}`).join("\n");
}

function popParseAccounts(text) {
  return String(text || "").split("\n").map((s) => s.trim()).filter(Boolean).map((line) => {
    const m = line.split(/[=＝]/);
    const account = (m[0] || "").trim();
    const customer = (m[1] || "").trim();
    return { account, customer: customer || account, label: customer || account };
  }).filter((x) => x.account);
}

function fillPopAuto(d) {
  POP_AUTO = d;
  const wh = d.warehouse || {};
  if ($("jstWhName")) $("jstWhName").textContent = d.warehouse_name || d.warehouse_key || "—";
  if ($("popWhName")) $("popWhName").textContent = d.warehouse_name || d.warehouse_key || "—";
  if ($("popServiceUrl")) $("popServiceUrl").value = d.service_url || "";
  if ($("popServiceHint")) {
    $("popServiceHint").textContent = "默认：" + (d.service_url_default || "127.0.0.1:18011")
      + "（与「广告利润」页读的是同一个挂载服务）";
  }
  if ($("popAccounts")) $("popAccounts").value = popAccountsText(wh.accounts);
  const pm = $("popPriceMode");
  if (pm) {
    pm.innerHTML = (d.price_modes || []).map((m) =>
      `<option value="${esc(m.value)}"${wh.price_mode === m.value ? " selected" : ""}>${esc(m.label)}</option>`).join("");
  }
  if ($("popDays")) $("popDays").value = wh.days || 7;
  if ($("popCutoff")) $("popCutoff").value = wh.day_cutoff_hour ?? 16;
  if ($("popOperator")) $("popOperator").value = wh.operator || "";
  if ($("popSchedule")) $("popSchedule").value = (wh.schedule || []).join(",");
  if ($("popJitter")) $("popJitter").value = wh.jitter_minutes ?? 10;
  if ($("popEnabled")) $("popEnabled").checked = !!wh.enabled;
  if ($("popAutoExpress")) $("popAutoExpress").checked = wh.auto_express !== false;
  if ($("popAutoReverse")) $("popAutoReverse").checked = wh.auto_reverse !== false;
  if ($("popSkipImported")) $("popSkipImported").checked = wh.skip_imported !== false;

  const box = $("popStatusBox");
  if (box) {
    const cur = new Set((wh.statuses || []).map(Number));
    box.innerHTML = (d.statuses || []).map((s) => {
      const cancel = Number(s.code) === 29;   // 已取消只用于红冲判断，不能当「可导入」勾
      return `<label class="check-inline"${cancel ? ' title="已取消不导入，只用于把已建的单自动红冲"' : ""}>
        <input type="checkbox" class="pop-status" value="${s.code}"${(!cancel && cur.has(Number(s.code))) ? " checked" : ""}${cancel ? " disabled" : ""} />
        ${esc(s.label)}(${s.code})</label>`;
    }).join("");
  }

  const dh = $("popDeductionHint");
  if (dh) {
    const rows = (wh.accounts || []).map((a) => {
      const dd = a.deduction || {};
      const mark = dd.matched ? "✅" : "⚠";
      return `<div>${mark} ${esc(a.customer || a.account)}：${esc(dd.note || "")}</div>`;
    });
    dh.innerHTML = rows.length
      ? "扣点规则（deduction_config.json）：" + rows.join("")
      : "还没有配置 POP 店铺账号 —— 填「账号=店铺名」后保存，店铺名要和扣点设置里的店铺名一致。";
  }
  const nr = $("popNextRuns");
  if (nr) nr.textContent = (d.next_runs || []).length ? "接下来：" + d.next_runs.join("、") : "未设定时";
  renderPopStatus(d.status || {});
  loadPopPending(d);
  loadPopHistory();
}

async function savePopAuto() {
  const payload = {
    service_url: ($("popServiceUrl")?.value || "").trim(),
    enabled: !!$("popEnabled")?.checked,
    accounts: popParseAccounts($("popAccounts")?.value),
    price_mode: $("popPriceMode")?.value || "supply",
    statuses: [...document.querySelectorAll(".pop-status:checked")].map((x) => Number(x.value)),
    day_cutoff_hour: Number($("popCutoff")?.value || 0),
    days: Number($("popDays")?.value || 7),
    schedule: ($("popSchedule")?.value || "").split(",").map((s) => s.trim()).filter(Boolean),
    jitter_minutes: Number($("popJitter")?.value || 0),
    auto_express: !!$("popAutoExpress")?.checked,
    auto_reverse: !!$("popAutoReverse")?.checked,
    skip_imported: !!$("popSkipImported")?.checked,
    operator: ($("popOperator")?.value || "").trim(),
  };
  try {
    fillPopAuto(await api("/api/pop-auto/settings", "POST", payload));
    toast("已保存京麦设置");
  } catch (e) { toast("保存失败：" + e.message); }
}

async function checkPopSource() {
  const el = $("popCheckResult");
  if (el) el.textContent = "检测中…（只读缓存，不会触发浏览器抓取）";
  try {
    const r = await api("/api/pop-auto/check", "POST", { service_url: ($("popServiceUrl")?.value || "").trim() });
    if (el) el.textContent = (r.ok ? "✅ " : "❌ ") + (r.message || "");
  } catch (e) { if (el) el.textContent = "❌ " + e.message; }
}

function renderPopStatus(st) {
  const el = $("popRunStatus");
  if (!el) return;
  const s = st || {};
  const stats = s.stats || {};
  const lines = [];
  if (s.running) lines.push(`⏳ 正在执行（${s.trigger || ""}）· ${s.step || ""} ${s.message || ""}`);
  else if (s.finished_at) {
    lines.push(`${s.ok === false ? "❌" : "✅"} 上次执行 ${s.finished_at}（${s.trigger || ""}）`);
    if (s.error) lines.push("错误：" + s.error);
  }
  if (stats && (stats.created != null)) {
    lines.push(`建单 ${stats.created || 0} · 跳过重复 ${stats.duplicate_skipped || 0} · 红冲 ${stats.reversed || 0}`
      + ` · 未匹配 ${stats.unmapped || 0} · 状态跳过 ${stats.status_skipped || 0}`
      + (stats.dry_run ? ` · 试算 ${stats.dry_run}` : ""));
  }
  if (s.message && !s.running) lines.push(s.message);
  el.textContent = lines.join("\n");
}

async function runPopAuto(dry) {
  if (!dry && !(await uiConfirm("立即导入：按当前设置拉 POP 订单并在本分仓建出库单。继续？"))) return;
  const body = {
    start: $("popRunFrom")?.value || "",
    end: $("popRunTo")?.value || "",
    dry_run: !!dry,
  };
  try {
    const r = await api("/api/pop-auto/run", "POST", body);
    toast(r.message || "已开始执行");
    renderPopStatus({ running: true, step: "已启动", trigger: dry ? "试算" : "手动" });
    startPopPoll();
  } catch (e) { toast("启动失败：" + e.message); }
}

function startPopPoll() {
  stopPopPoll();
  POP_POLL = setInterval(async () => {
    try {
      const st = await api("/api/pop-auto/status");
      renderPopStatus(st);
      if (!st.running) { stopPopPoll(); loadPopHistory(); loadPopAutoPage(); }
    } catch (e) { stopPopPoll(); }
  }, 3000);
}

function stopPopPoll() {
  if (POP_POLL) { clearInterval(POP_POLL); POP_POLL = null; }
}

async function refreshPopStatus() {
  try {
    const st = await api("/api/pop-auto/status");
    renderPopStatus(st);
    if (st.running) startPopPoll(); else loadPopHistory();
  } catch (e) { toast("读取状态失败：" + e.message); }
}

async function loadPopHistory() {
  const t = $("popHistoryTable");
  if (!t) return;
  try {
    const d = await api("/api/pop-auto/history?limit=20");
    const rows = d.runs || [];
    t.innerHTML = `<thead><tr>
        <th>时间</th><th>触发</th><th>结果</th><th>订单区间</th>
        <th class="num">建单</th><th class="num">跳过重复</th><th class="num">红冲</th><th class="num">未匹配</th><th>说明</th>
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
          <td class="num">${s.reversed != null ? s.reversed : "—"}</td>
          <td class="num">${s.unmapped != null ? s.unmapped : "—"}</td>
          <td>${esc(r.message || r.error || "")}${(r.warnings || []).length ? `<div class="muted" style="font-size:11px;">${esc(r.warnings.slice(0, 3).join("；"))}</div>` : ""}</td>
        </tr>`;
      }).join("") : `<tr><td colspan="9" class="empty">还没有执行记录</td></tr>`) + `</tbody>`;
  } catch (e) { /* 历史读不到不影响设置 */ }
}

async function loadPopPending(d) {
  if (!d) {
    try { d = await api("/api/pop-auto/settings"); } catch (e) { return; }
  }
  const box = $("popPendingBox");
  if (!box) return;
  const list = d.pending || [];
  if (!list.length) { box.innerHTML = '<div class="hint" style="margin:0;">暂无待办</div>'; return; }
  if (!PRODUCTS.length) { try { PRODUCTS = await api("/api/products"); } catch (e) { /* 下拉拉不到也能看清单 */ } }
  const opts = PRODUCTS.filter((p) => p.is_active !== false)
    .sort((a, b) => String(a.name || "").localeCompare(String(b.name || ""), "zh"))
    .map((p) => `<option value="${p.id}">${esc(p.name)}${p.code ? "（" + esc(p.code) + "）" : ""}</option>`).join("");
  box.innerHTML = list.map((t) => {
    const head = `<div style="display:flex;gap:8px;align-items:baseline;flex-wrap:wrap;">
        <b>${esc(t.title || "待办")}</b><span class="muted">${esc(t.message || "")}</span>
      </div>`;
    if (t.type !== "pop_unmapped") {
      const names = (t.items || []).map((it) => it.name).filter(Boolean);
      return `<div style="border:1px solid var(--line);border-radius:10px;padding:10px 12px;margin-bottom:10px;">
        ${head}
        <div class="mono" style="font-size:12px;margin-top:6px;">${esc(names.join("、"))}</div>
        <div class="toolbar" style="margin-top:6px;">
          <button class="btn sm ghost" onclick="closePopPending('${esc(t.id)}')">知道了</button>
        </div>
      </div>`;
    }
    const items = (t.items || []).map((it) => `<tr>
        <td class="mono">${esc(it.sku || "")}</td>
        <td>${esc(it.name || "")}</td>
        <td class="num">${it.count || 0}</td>
        <td><select class="pop-map" data-sku="${esc(it.sku || "")}"><option value="">（选择系统商品…）</option>${opts}</select></td>
      </tr>`).join("");
    return `<div style="border:1px solid var(--line);border-radius:10px;padding:10px 12px;margin-bottom:10px;">
      ${head}
      <div class="table-wrap"><table><thead><tr>
        <th>京东 SKU</th><th>商品</th><th class="num">出现次数</th><th>关联到系统商品</th>
      </tr></thead><tbody>${items}</tbody></table></div>
      <div class="toolbar" style="margin-top:6px;">
        <button class="btn green sm" onclick="resolvePopPending('${esc(t.id)}')">保存关联</button>
        <button class="btn sm ghost" onclick="closePopPending('${esc(t.id)}')">忽略这条</button>
        <span class="muted" style="font-size:11px;">保存后点「立即导入」重跑，跳过重复不会重复建单</span>
      </div>
    </div>`;
  }).join("");
}

async function resolvePopPending(id) {
  const mappings = [...document.querySelectorAll(".pop-map")].map((s) => ({
    external_code: s.dataset.sku || "",
    product_id: Number(s.value || 0),
  })).filter((m) => m.external_code && m.product_id);
  if (!mappings.length) { toast("请先给至少一个 SKU 选择系统商品"); return; }
  try {
    const r = await api("/api/pop-auto/pending/resolve", "POST", { mappings, close_id: id || "" });
    toast(`已保存 ${r.saved} 条关联，可重新导入`);
    loadPopAutoPage();
  } catch (e) { toast("保存失败：" + e.message); }
}

async function closePopPending(id) {
  try { await api("/api/pop-auto/pending/close", "POST", { id, status: "ignored" }); toast("已忽略"); loadPopAutoPage(); }
  catch (e) { toast("操作失败：" + e.message); }
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
      `<button class="btn sm ghost" style="margin:2px 4px 0 0;" onclick="evaSuggest(this, ${s.id ?? s.product_id})">${esc(s.name)}${s.score ? `（${Math.round(s.score * 100)}%）` : ""}</button>`).join("");
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
      <button class="btn" title="这些商品在本仓没有关联结算、但别的分仓（如 wh01）里有：把本待办涉及的单推到那个分仓建出库单"
        onclick="evaPushOther('${t.id}')">📦 推其他仓出库</button>
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
    if (!payload.mappings.length && !(await uiConfirm("还没选任何商品关联，仍要按现有配置重跑一次吗？"))) return;
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
  if (!(await uiConfirm("按「名称 / 编码 100% 完全相同」重新匹配这条待办？\n\n"
    + "· 只自动关联与系统商品完全同名的项（忽略空格/大小写）\n"
    + "· 不做任何相似度猜测，避免像「新鲜百合 50%」那种误配\n"
    + "· 命中的立即自动重新导入出库，其余仍留在待办里人工选择"))) return;
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
  if (!(await uiConfirm("忽略这条待办？不再提醒（已导入的数据不受影响）"))) return;
  try {
    await api(`/api/jst-auto/pending/${encodeURIComponent(tid)}/dismiss`, "POST");
    toast("已忽略");
    renderJstPending(); checkJstPending(false);
  } catch (e) { toast("操作失败：" + e.message); }
}

/* =============== 推其他仓出库 ===============
   这些单的商品在本仓没有商品资料 / 关联结算，但同样的商品在别的分仓（如 wh01）早就维护好了
   （货其实是从那个仓发走的）。这里直接拿待办里已下载的聚水潭原始文件，用**目标分仓自己的**
   商品 / 编码关联 / 打包规则重新解析建单，本仓数据不动。 */
async function evaPushOther(tid) {
  const t = (EVA_TASKS || []).find((x) => x.id === tid);
  if (!t) { toast("待办已变化，请刷新后重试"); return; }
  let list = [];
  try {
    const r = await api("/api/warehouses");
    list = (r.warehouses || []).filter((w) => !w.is_current);
  } catch (e) { toast("读取分仓列表失败：" + e.message); return; }
  if (!list.length) { toast("只有当前分仓，没有其它分仓可推"); return; }
  const items = t.items || [];
  const names = items.slice(0, 3).map((it) => it.external_code).join("、");
  const opts = list.map((w) => `<option value="${esc(w.key)}">${esc(w.name)}（${esc(w.key)}）</option>`).join("");
  $("modalBox").classList.remove("wide");
  openModal(`<h3>📦 推其他仓出库 <button class="close" onclick="closeModal()">✕</button></h3>
    <div class="hint" style="margin-bottom:10px;">
      把这条待办涉及的单推到别的分仓建出库单：用那个仓<b>自己的</b>商品资料与关联结算重新解析，
      本仓的数据不动。<br>
      · 只推「含有这些未关联商品」的单：${esc(names)}${items.length > 3 ? ` 等 ${items.length} 种` : ""}<br>
      · 目标仓已经建过的单按出库单号自动跳过，重复点不会建两份。<br>
      · 目标仓<b>也没有关联</b>的商品：那一行不会建（整张单一行都建不了就不建单）。先「试算」，下面会列出来让你现场选对应商品。
    </div>
    <div class="form-grid">
      <div class="field"><label>推到哪个分仓出库</label>
        <select id="pushWhSel" class="searchable">${opts}</select>
        <div class="field-hint">建议先「试算」看一眼能建几张、目标仓还缺哪些关联，再「确认推送」。</div>
      </div>
    </div>
    <div id="pushWhOut" style="margin:12px 0;"></div>
    <div class="modal-foot">
      <button class="btn secondary" id="pushWhTrial" onclick="evaPushOtherRun('${t.id}', true)">试算（不写库）</button>
      <button class="btn green" id="pushWhGo" onclick="evaPushOtherRun('${t.id}', false)">确认推送</button>
      <button class="btn" onclick="closeModal(); openJstPending();">返回待办</button>
    </div>`);
}

async function evaPushOtherRun(tid, dryRun) {
  const sel = $("pushWhSel");
  const target = sel ? sel.value : "";
  if (!target) { toast("请选择要推送到的分仓"); return; }
  const out = $("pushWhOut");
  const maps = evaPushCollectMaps();   // 试算时选的「目标仓关联」一起提交（也用于重算后回填）
  const btns = [$("pushWhTrial"), $("pushWhGo")].filter(Boolean);
  btns.forEach((b) => { b.disabled = true; });
  if (out) out.innerHTML = `<div class="muted">${dryRun ? "正在试算" : "正在推送"}…（单多时可能要几十秒，别关窗口）</div>`;
  try {
    const r = await api(`/api/jst-auto/pending/${encodeURIComponent(tid)}/push-warehouse`, "POST",
      { target_key: target, dry_run: !!dryRun, mappings: maps });
    if (out) {
      out.innerHTML = evaPushResultHtml(r) + (dryRun ? evaPushMapHtml(r) : "");
      if (dryRun) evaPushApplyMaps(maps);            // 重新试算后把刚才选好的关联填回去
      try { bindSearchable(out); } catch (e) {}   // 补关联的下拉框也要能用搜索
    }
    // 推送后仍有单没建成：自动试算一次，把「补选关联」的选择框直接给出来（不用自己去点试算）
    if (!dryRun && (r.unmapped || []).length) {
      if (out) out.innerHTML = evaPushResultHtml(r) + `<div class="muted" style="margin-top:8px;">还有 ${r.unmapped.length} 种商品在目标仓没有关联，相关单没建成（待办已保留）。正在准备补选选项…</div>`;
      try {
        const r2 = await api(`/api/jst-auto/pending/${encodeURIComponent(tid)}/push-warehouse`, "POST",
          { target_key: target, dry_run: true, mappings: maps });
        if (out) {
          out.innerHTML = evaPushResultHtml(r) + evaPushMapHtml(r2);
          evaPushApplyMaps(maps);
          try { bindSearchable(out); } catch (e) {}
        }
      } catch (e) { /* 自动试算失败不影响推送结果，用户可手动点「试算」 */ }
    }
    toast(r.message || "已处理");
    // 推送后待办可能被保留（部分单没建成），刷新一下让状态同步
    if (!dryRun) setTimeout(() => { renderJstPending(); checkJstPending(false); }, 800);
  } catch (e) {
    if (out) out.innerHTML = `<div class="alert err">${esc(e.message)}</div>`;
  } finally {
    btns.forEach((b) => { b.disabled = false; });
  }
}

/* 目标仓还缺关联的商品：在弹窗里直接选对应商品（保存到目标仓的聚水潭关联，之后自动带上） */
function evaPushMapHtml(r) {
  const items = r.unmapped_detail || [];
  if (!items.length) return "";
  const prods = r.products || [];
  const label = (p) => `${p.name}${p.type === "order"
    ? (p.settle ? "（订单·扣库存）" : "（订单·代发，无关联结算）")
    : "（库存大类）"}`;
  const opts = ['<option value="">（不关联，这些行不建）</option>']
    .concat(prods.map((p) => `<option value="${p.id}">${esc(label(p))}</option>`)).join("");
  const rows = items.map((it) => {
    const sug = (it.suggest || []).slice(0, 3).map((s) =>
      `<button class="btn sm ghost" style="margin:2px 4px 0 0;" onclick="pushPickSuggest(this, ${s.id ?? s.product_id})">${esc(s.name)}${s.score ? `（${Math.round(s.score * 100)}%）` : ""}</button>`).join("");
    return `<tr class="push-map-row">
      <td><b>${esc(it.external_code)}</b>
        ${it.reason ? `<div class="muted" style="font-size:11px;">${esc(it.reason)}</div>` : ""}</td>
      <td>
        <select class="searchable push-map" data-code="${esc(it.external_code)}" style="min-width:260px;">${opts}</select>
        ${sug ? `<div class="field-hint">目标仓候选：${sug}</div>` : ""}
      </td>
    </tr>`;
  }).join("");
  return `<div class="card" style="border:1px solid var(--amber, #f59e0b);margin-top:10px;">
    <div class="card-head">
      <h3>目标仓还缺 ${items.length} 种商品的关联</h3>
      <span class="hint">选好后点上面「确认推送」，会一起保存到「${esc(r.target_name || "")}」的聚水潭关联</span>
    </div>
    <div class="table-wrap"><table>
      <thead><tr><th style="width:44%;">聚水潭商品名</th><th>在目标仓关联到</th></tr></thead>
      <tbody>${rows}</tbody></table></div>
    <div class="field-hint">「订单·扣库存」会按该商品自己的关联结算扣库存并结转成本；
      「订单·代发」不扣任何库存、成本按参考成本计；选「库存大类」会因没有关联结算建单失败。</div>
  </div>`;
}

/** 收集弹窗里补选的目标仓关联 */
function evaPushCollectMaps() {
  return [...document.querySelectorAll("#pushWhOut select.push-map")]
    .map((s) => ({ external_code: s.dataset.code || "", product_id: s.value ? +s.value : null }))
    .filter((m) => m.external_code && m.product_id);
}

/** 重新试算后把刚才选好的关联填回下拉框（避免每点一次「试算」就得重选） */
function evaPushApplyMaps(maps) {
  const byCode = new Map((maps || []).map((m) => [m.external_code, String(m.product_id)]));
  document.querySelectorAll("#pushWhOut select.push-map").forEach((sel) => {
    const v = byCode.get(sel.dataset.code);
    if (v) sel.value = v;
  });
}

/** 点候选商品 → 选中该行的下拉（真正保存要等「确认推送」） */
function pushPickSuggest(btn, pid) {
  const row = btn.closest(".push-map-row");
  const sel = row ? row.querySelector("select.push-map") : null;
  if (!sel) return;
  sel.value = String(pid);
  sel.dispatchEvent(new Event("change", { bubbles: true }));
  toast("已选中候选商品，点「确认推送」生效");
}

/* 推送结果 / 试算结果的展示 */
function evaPushResultHtml(r) {
  if (!r) return "";
  const willCreate = Math.max(0, (r.requested || 0) - (r.duplicate_skipped || 0));
  const line = (k, v, colorVar) => `<div style="display:flex;gap:8px;padding:3px 0;">
      <span class="muted" style="min-width:130px;">${k}</span>
      <span${colorVar ? ` style="color:var(--${colorVar})"` : ""}>${v}</span></div>`;
  const un = (r.unmapped || []).slice(0, 5).map((x) => esc(x)).join("、");
  const fails = (r.failed || []).slice(0, 3)
    .map((f) => `${esc(f.doc || "")}${f.reason ? "：" + esc(f.reason) : ""}`).join("；");
  return `<div class="card" style="border:1px solid ${r.dry_run ? "var(--line,#e5e7eb)" : "var(--green,#16a34a)"};">
    <div class="card-head"><h3>${r.dry_run ? "试算结果（未写库）" : "推送结果"}</h3>
      <span class="hint">${esc(r.message || "")}</span></div>
    ${line("目标分仓", `<b>${esc(r.target_name || r.target || "")}</b>`)}
    ${line("文件里的单", `${r.orders_in_file || 0} 张（涉及未关联商品 ${r.affected || 0} 张）`)}
    ${line(r.dry_run ? "预计新建" : "已新建", `<b>${r.dry_run ? willCreate : (r.created || 0)} 张</b>`,
      (r.dry_run ? willCreate : (r.created || 0)) ? "green" : "")}
    ${line("目标仓已建过跳过", `${r.duplicate_skipped || 0} 张`)}
    ${r.mappings_saved ? line("补存到目标仓的关联", `${r.mappings_saved} 条`, "green") : ""}
    ${(r.unmapped || []).length
      ? line("目标仓仍缺关联", `<b>${r.unmapped.length} 种</b>：${un}${r.unmapped.length > 5 ? " 等" : ""}（这些单没建成）`, "red")
      : ""}
    ${(r.failed || []).length ? line("解析失败", `${r.failed.length} 条：${fails}`, "red") : ""}
    ${(r.already_in_source || []).length
      ? line("本仓已建过的单", `${r.already_in_source.length} 张（多是只结算了已关联商品的部分单，建议核对后再决定是否红冲）`, "red")
      : ""}
    ${(r.skipped_files || []).length ? line("跳过的文件", esc(r.skipped_files.join("；"))) : ""}
    <div class="muted" style="margin-top:6px;font-size:12px;">${r.dry_run
      ? "试算不写库；确认无误后点下面「确认推送」。"
      : `已用「${esc(r.target_name || r.target || "")}」的商品资料建单，可去那个分仓的「出库」页核对。`}</div>
  </div>`;
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
        : (m.ref_type === "transfer"
          ? '<span class="badge adjust">转移</span>'   // 分仓转移：本质是盘点增减，但口径要能一眼分开
          : (typeBadge[m.move_type] || m.move_type));
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
    const scaleTip = mvSplitScale
      ? `上下独立刻度（入峰值 ${fmtQtyShort(peakIn)}，出峰值 ${fmtQtyShort(peakOut)}）`
      : `上下同一刻度（满格 ${fmtQtyShort(Math.max(peakIn, peakOut))}）`;
    return `<div class="mv-chart-title">
        <span class="mv-unit-chip">${esc(s.unit)}</span>
        <span class="mv-legend"><i class="up"></i>入库<i class="down"></i>出库</span>
        <button type="button" class="help-btn" data-help="${esc(scaleTip)}；只统计真实库存进出（不含人工/快递及按「单」流水）。">?</button>
        <div class="grow"></div>
        <button class="btn sm ghost mv-scale-btn" onclick="mvToggleScale()">刻度：${mvSplitScale ? "上下独立" : "上下同一"}</button>
      </div>`;
  };
  box.innerHTML =
    mains.map((s) => `<div class="mv-block">${head(s)}<div class="mv-chart">${mvColumns(s.days, s.unit)}</div></div>`).join("")
    + (flat.length
      ? `<div class="mv-note">另有零星变动：${flat.map((s) => `${esc(s.unit)}（入 ${fmtNum(s.total_in)} / 出 ${fmtNum(s.total_out)}）`).join("、")}</div>`
      : "");
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
    // config.json 同样按 BASE 取（子路径挂载时走 /jdfenxi/config.json）；
    // 只把接口前缀补上 BASE，不能直接 Object.assign，否则会抹掉前缀。
    const cfg = await fetch(BASE + "/config.json", { cache: "no-store" }).then((r) => r.json());
    const routes = cfg.routes || {};
    if (routes.api) ROUTES.api = BASE + String(routes.api).replace(/\/+$/, "");
    if (routes.uploads) ROUTES.uploads = BASE + String(routes.uploads).replace(/\/+$/, "");
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
  // 预设默认日期范围：入库记录本月，出库记录昨天（入库单的日期在每行里各自默认今天）
  $("outDate").value = today();
  $("inDateFrom").value = monthStart();
  $("inDateTo").value = today();
  $("outDateFrom").value = yesterday();
  $("outDateTo").value = yesterday();
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
  } catch (e) {}
  try { bindSearchable(document); } catch (e) {}
  applyNavVisibility();     // 侧边栏按本机偏好显隐（设置 → 模块显示）
  syncExcludeOtherHint();   // 报表页「排除其他收支」开关按本机偏好回显（默认开启）
  loadDashboard();
  aiQueueLoad();    // AI 识别队列（待办处理）：恢复上次未处理完的识别结果，并继续跑排队中的任务
  aiQueueTick();
  refreshEvaBadge(); // 侧边栏「待办处理」角标：开机恢复的队列立刻可见
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
  brush: {
    title: "刷单出库",
    tpl: "",
    preview: "/api/brush-out/preview",
    confirm: "/api/brush-out/confirm",
    hint: "放单仓刷单专用：上传聚水潭导出的「销售出库单_*.xlsx」，全部按刷单口径入账（不扣库存、不耗包材，成本 = 刷单成本 + 快递+包装固定费）。仓储方是芳谊放单仓的直接按刷单流程走；若是别的仓（如自持干货打单仓）且这些单已被自动出库当正常单出了库，会先回冲原单（删单回滚库存，并在「盘点记录」里留回冲明细），再建刷单单 —— 收入只保留刷单这一份。",
  },
};
/* 放单仓名单（后端下发，见 backend/app/brush.py 的 BRUSH_WAREHOUSES）：
   这些「仓储方」的聚水潭订单要在确认框里逐单填刷单成本，核算结算价与最终利润。 */
let __BRUSH_WH__ = [];
let __BRUSH_HIT__ = [];   // 本次解析里真正命中的放单仓（有它就不自动跑 AI 归并）
/* 刷单出库专用（见 backend/app/routers/brush_out.py）：需要先回冲的已入账出库单 */
let __BRUSH_REVERT__ = [];
function isBrushOrder(o) { return !!o && !!o.warehouse && __BRUSH_WH__.includes(o.warehouse); }
function isBrushBatch() { return (__BRUSH_HIT__ || []).length > 0; }
/* 聚水潭出库单两种入口：正常导入（jushuitan）/ 刷单出库（brush），解析与预览结构一致 */
function isJstLike(kind) { return kind === "jushuitan" || kind === "brush"; }
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
  if (isJstLike(kind)) window.__BM_FILE__ = file; // 供 AI 关联后一键重新解析
  // 结果预览会把 modalBox 内容整体替换掉，此时 #bmResult 已不存在（旧代码在这里抛错 → 点「重新解析」没反应），
  // 故进度提示回退到弹窗主体。
  const box = $("bmResult") || $("modalBox");
  if (box) box.innerHTML = `<div class="alert ok">⏳ 正在解析…（同一文件）</div>`;
  try {
    const r = await apiUpload(cfg.preview, file);
    if (isJstLike(kind)) {
      __BRUSH_WH__ = r.brush_warehouse_names || [];   // 放单仓名单（配置）
      __BRUSH_HIT__ = r.brush_warehouses || [];       // 本次解析命中的放单仓
      __BRUSH_REVERT__ = r.revert || [];              // 刷单出库：需要先回冲的已入账出库单
    }
    if (kind === "inbound") renderInboundReview(kind, r);
    else renderDraftReview(kind, r);
  } catch (e) {
    if (box) box.innerHTML = `<div class="alert err">解析失败：${esc(e.message)}</div>`;
  }
}
function renderDraftReview(kind, r) {
  const orders = r.orders || [];
  // 放单仓「快递+包装」默认值（后端给，见 brush.DEFAULT_BRUSH_FEE）：逐单预填，用户可改
  window.__BRUSH_DEFAULT_FEE__ = +(r.brush_default_fee || 0);
  // 一单多货规则带出的包材/人工行：按 doc_no 记录，确认出库时一并回传
  window.__DRAFT_PACK__ = {};
  orders.forEach((o) => { if (o.pack_lines && o.pack_lines.length) window.__DRAFT_PACK__[o.doc_no] = o.pack_lines; });
  let warn = "";
  if (r.unmapped_codes && r.unmapped_codes.length) {
    window.__LAST_UNMAPPED__ = isJstLike(kind) ? (r.unmapped_codes || []) : [];
    if (isJstLike(kind)) {
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
      (isJstLike(kind) ? `<button class="btn" onclick="runBatchModal('${kind}')">↻ 重新解析（同一文件）</button>` : "") +
      `</div>`;
    scheduleAiAutoPreview(kind);
    return;
  }
  // 聚水潭 / 刷单出库：不逐单展示，改为汇总相同商品名的总体预览
  if (isJstLike(kind)) {
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
      ${isJstLike(kind) ? `<button class="btn secondary" onclick="runBatchModal('${kind}')">↻ 重新解析（同一文件）</button>` : ""}
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
    // 「快递+包装」默认预填（后端 brush_fee_auto = brush.DEFAULT_BRUSH_FEE，通常 3.6），可逐单改
    const fee = +(o.brush_fee_auto || 0) || +(window.__BRUSH_DEFAULT_FEE__ || 0);
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
        「快递+包装」已按默认值 <b>${fmtMoney(window.__BRUSH_DEFAULT_FEE__ || 0)}</b>/单预填（可逐单改），只影响这一单的结算口径。
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
  // 刷单出库：仓储方推错仓时，这些单已被自动出库当正常单出了库 → 确认时先回冲（删原单回滚库存 +
  // 盘点记录留回冲明细），再按刷单口径重建，收入只保留刷单单这一份（见 routers/brush_out.py）
  const revertRows = (__BRUSH_REVERT__ || []);
  const revertSection = revertRows.length ? `
    <div class="alert warn">
      <div>⚠ 有 <b>${revertRows.length}</b> 张单已在系统里按「正常出库」入过账（仓储方推错仓，自动出库误识别）。
        确认后将先<b>回冲</b>：删除这些原出库单（库存与成本随之精确回滚），并在「库存 → 盘点记录」里为每个商品留一条
        <b>回冲明细</b>；随后再按刷单口径重建出库单，<b>收入只保留刷单这一份</b>。</div>
      <div class="table-wrap" style="margin-top:8px;">
        <table class="subtable" style="width:100%;">
          <thead><tr><th>聚水潭单号</th><th>原出库单</th><th style="width:96px;">日期</th><th>回冲商品</th>
            <th class="num" style="width:96px;">原收入</th><th class="num" style="width:96px;">原成本</th></tr></thead>
          <tbody>${revertRows.map((r) => `<tr>
            <td class="mono">${esc(r.doc_no || "")}</td>
            <td class="mono">${esc(r.code || "")}${r.has_return ? `<div class="muted" style="font-size:11px;color:var(--red);">有退货单，需先删除</div>` : ""}</td>
            <td class="muted">${esc(r.date || "")}</td>
            <td class="muted">${(r.lines || []).map((l) => `${esc(l.product_name)} ×${fmtNum(l.quantity)}${esc(l.unit || "")}`).join("　") || "—"}</td>
            <td class="num mono">${fmtMoney(r.total_amount || 0)}</td>
            <td class="num mono">${fmtMoney(r.total_cogs || 0)}</td>
          </tr>`).join("")}</tbody>
        </table>
      </div>
    </div>` : "";
  $("modalBox").classList.add("wide");
  $("modalBox").innerHTML = `<h3>${BATCH_MODAL[kind].title} — 商品汇总预览 <button class="close" onclick="closeModal()">✕</button></h3>
    <div class="alert ok">共 <b>${orders.length}</b> 单${range ? `（${esc(range)}）` : ""}，商品 <b>${rows.length}</b> 种，合计金额 <b>${fmtMoney(sumAmt)}</b>${packFee ? `（另有打包费 ${fmtMoney(packFee)}）` : ""}。确认后按原单据整批出库。</div>
    ${warn}
    ${revertSection}
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
      <button class="btn secondary" onclick="runBatchModal('${kind}')">↻ 重新解析（同一文件）</button>
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
    const payload = { orders };
    // 聚水潭（古法/手动导入）：带上来源文件名，后端会往「自动出库设置 → 执行记录」记一条
    // 「古法导入」记录（见 imports._log_manual_jst_import）
    if (isJstLike(kind)) payload.source = (window.__BM_FILE__ && window.__BM_FILE__.name) || "";
    const r = await api(BATCH_MODAL[kind].confirm, "POST", payload);
    let html = `<div class="alert ok">✓ 已创建 <b>${r.created}</b> 个出库单`;
    if (r.failed_count) html += `，失败 <b>${r.failed_count}</b>`;
    html += `</div>`;
    // 刷单出库：推错仓的原单已回冲（删单回滚库存，盘点记录留明细）
    if (r.revert_note) html += `<div class="alert ok">↩ ${esc(r.revert_note)}：原出库单已删除、库存与成本已回滚，「库存 → 盘点记录」里已留回冲明细。</div>`;
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
    if (r.revert_note) loadAdjustments();   // 刷单出库回冲后，盘点记录里刚写入的回冲明细马上可见
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
      <td><input class="draft-freight" type="number" step="any" min="0" value="${it.freight || ""}" placeholder="0" title="运费（选填）：计入批次成本，体现在该品毛利，并同步记入「其他收支」" style="width:64px;" /></td>
      <td><input class="draft-handling" type="number" step="any" min="0" value="${it.handling || ""}" placeholder="0" title="装卸费（选填）：同运费" style="width:64px;" /></td>
      <td><input class="draft-fee" type="number" step="any" min="0" value="${it.fee || ""}" placeholder="0" title="转账手续费（选填）：同运费" style="width:64px;" /></td>
      <td class="muted">${esc(it.supplier || "—")} · ${esc(it.date)}</td>
    </tr>`).join("");
  $("modalBox").innerHTML = `<h3>${BATCH_MODAL[kind].title} — 确认入库 <button class="close" onclick="closeModal()">✕</button></h3>
    <div class="alert ok">解析出 <b>${items.length}</b> 行。可勾选、修改数量/单价/运费/装卸/手续费后点击「确认入库」；这几项费用会计入批次成本并同步「其他收支」。</div>
    ${warn}
    <table class="subtable" style="width:100%;">
      <thead><tr><th style="width:34px;"><input type="checkbox" checked onchange="toggleDraftAll(this)" /></th><th>商品</th><th>单位</th><th>数量</th><th>单价</th><th>金额</th><th>运费</th><th>装卸</th><th>手续费</th><th>供应商 · 日期</th></tr></thead>
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
    const tf = Math.max(0, parseFloat(tr.querySelector(".draft-fee")?.value) || 0);
    if (qty > 0) items.push({ ...it, quantity: qty, unit_price: price, freight: fee, handling: hand, fee: tf });
  });
  if (!items.length) { toast("没有可入库的数据"); return; }
  const priceWarn = inboundPriceWarnings(items);
  if (priceWarn.length && !(await uiConfirm(priceConfirmText(priceWarn, `共 ${items.length} 行批量入库`)))) return;
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
  const kws = splitSearchKeywords($("mpSearch")?.value);
  const f = $("mpFilter")?.value || "";
  let items = d.items || [];
  if (kws.length) items = items.filter((m) =>
    searchHit(`${m.external_code || ""} ${m.product_name || ""}`, kws));
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
  if (!(await uiConfirm(`确认删除关联「${m ? m.external_code : id}」？`))) return;
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
  if (!(await uiConfirm("确认清空全部编码关联？"))) return;
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

/* ==================== 广告利润（财务报表口径 + 挂载服务 CPS / 京准通花费） ==================== */
let ADP_SCOPE = "all";   // all 全仓总览（默认） / one 单仓总览
let ADP_WH = "";         // 单仓总览查看的分仓 key；"" = 当前分仓
let ADP_SKU = null;      // 按 SKU 明细接口的返回（搜索/排序只在前端重排，不重复请求）
let ADP_SKU_FULL = false; // 是否展开「显示全部」
let ADP_SUMMARY = null;   // 利润概览接口的返回：财务口径 + 入仓台账明细
let ADP_SKU_ERROR = "";   // 成交口径（SKU）加载失败原因，避免页面一直显示「加载中」
let adpInited = false;
let ADP_BF_TIMER = null;  // 补抓进度轮询定时器
let adpWhLoaded = false;

const adpYmd = (d) => `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`;
const adpPct = (v) => (v == null || isNaN(Number(v))) ? "—" : (Number(v) * 100).toFixed(1) + "%";

async function adpEnsureWhOptions() {
  if (adpWhLoaded) return;
  const sel = $("adpWhSel");
  if (!sel) return;
  try {
    const d = await api("/api/warehouses");
    const list = d.warehouses || [];
    ADP_WH = ADP_WH || d.current || "";
    sel.innerHTML = list.map((w) =>
      `<option value="${esc(w.key)}"${w.key === ADP_WH ? " selected" : ""}>${esc(w.name)}${w.is_current ? "（当前分仓）" : ""}</option>`
    ).join("");
    adpWhLoaded = true;
  } catch (e) { /* 拿不到分仓列表时按「当前分仓」看，不影响页面 */ }
}

function adpScope(btn) {
  btn.closest(".seg").querySelectorAll(".seg-item").forEach((x) => x.classList.toggle("active", x === btn));
  ADP_SCOPE = btn.dataset.scope === "all" ? "all" : "one";
  $("adpWhBar").style.display = ADP_SCOPE === "all" ? "none" : "";
  if (ADP_SCOPE === "one") adpEnsureWhOptions();
  loadAdProfit();
}

function adpWhChange() {
  ADP_WH = $("adpWhSel").value || "";
  loadAdProfit();
}

function adpToggleExcludeOther(chk) {
  EXCLUDE_OTHER = !!chk.checked;
  localStorage.setItem(EXCLUDE_OTHER_KEY, EXCLUDE_OTHER ? "1" : "0");
  syncExcludeOtherHint();
  loadAdProfit();
}

function adpQuick(kind) {
  const d = new Date();
  if (kind === "today") {
    $("adpDateFrom").value = today();
    $("adpDateTo").value = today();
  } else if (kind === "lastmonth") {
    $("adpDateFrom").value = adpYmd(new Date(d.getFullYear(), d.getMonth() - 1, 1));
    $("adpDateTo").value = adpYmd(new Date(d.getFullYear(), d.getMonth(), 0));
  } else {
    $("adpDateFrom").value = monthStart();
    $("adpDateTo").value = today();
  }
  loadAdProfit();
}

function adpOpenAdService() {
  window.open("/jdfenxi/", "_blank");
}

/* 页内视图切换：财务口径 / 入仓台账 / 成交口径（SKU 明细）。
   三块按口径完全分开：财务口径含入仓台账；入仓台账单独列；成交口径才是 SKU 合计。 */
function adpView(btn) {
  const view = btn.dataset.view || "overview";
  btn.closest(".seg").querySelectorAll(".seg-item").forEach((x) => x.classList.toggle("active", x === btn));
  $("adpOverviewCard").classList.toggle("adp-collapsed", view !== "overview");
  ["adpOverviewBody", "adpBridgeCard", "adpAccountsCard", "adpFinanceGrid"].forEach((id) => {
    const el = $(id);
    if (el) el.style.display = view === "overview" ? "" : "none";
  });
  $("adpWhInCard").style.display = view === "whin" ? "" : "none";
  $("adpDealCard").style.display = view === "sku" ? "" : "none";
  $("adpSkuCard").style.display = view === "sku" ? "" : "none";
  if (view === "whin") renderAdpWhIn();
  if (view === "sku") {
    renderAdpDealTable();
    renderAdProfitSku();
  }
}

async function loadAdProfit(refresh) {
  if (!adpInited) {
    adpInited = true;
    if (!$("adpDateFrom").value) $("adpDateFrom").value = monthStart();
    if (!$("adpDateTo").value) $("adpDateTo").value = today();
    syncExcludeOtherHint();
    if (ADP_SCOPE === "one") await adpEnsureWhOptions();
  }
  const from = $("adpDateFrom").value, to = $("adpDateTo").value;
  const whQs = ADP_SCOPE === "all" ? "&wh=all" : (ADP_WH ? `&wh=${encodeURIComponent(ADP_WH)}` : "");
  const hint = $("adpStatHint");
  if (hint) hint.textContent = "加载中…";
  // 区间/分仓变了，上一轮的 SKU 合计不能继续显示，等新数据回来再填
  ADP_SKU = null;
  ADP_SKU_ERROR = "";
  let d;
  try {
    d = await api(`/api/adprofit/summary?date_from=${from}&date_to=${to}${whQs}${excludeOtherQs()}${refresh ? "&refresh=1" : ""}`);
  } catch (e) {
    if (hint) hint.textContent = "";
    toast("加载广告利润失败：" + e.message);
    return;
  }
  renderAdProfit(d);
  loadAdProfitSku(from, to, whQs, refresh);
}

/* ---------------- 缺失花费自动补抓（调用 jdfenxi 抓取接口） ---------------- */
async function adpBackfill() {
  if (ADP_BF_TIMER) return;
  const from = $("adpDateFrom").value, to = $("adpDateTo").value;
  const btn = $("adpBackfillBtn"), hint = $("adpBfHint");
  if (btn) btn.disabled = true;
  if (hint) hint.textContent = "正在检查缺失区间…";
  let d;
  try {
    d = await api(`/api/adprofit/backfill?date_from=${from}&date_to=${to}`, "POST");
  } catch (e) {
    if (btn) btn.disabled = false;
    if (hint) hint.textContent = "";
    toast("补抓启动失败：" + e.message);
    return;
  }
  if (!d.ok) {
    if (btn) btn.disabled = false;
    if (hint) hint.textContent = "";
    toast(d.error || "补抓启动失败");
    return;
  }
  if (!d.count) {
    if (btn) btn.disabled = false;
    if (hint) hint.textContent = d.message || "所选区间没有缺失的花费缓存";
    toast(d.message || "所选区间没有缺失的花费缓存");
    return;
  }
  if (hint) hint.textContent = `已启动 ${d.count} 个补抓任务…`;
  toast(`开始补抓 ${d.count} 个缺失区间（jdfenxi 会打开浏览器抓取，可能要几分钟）`);
  ADP_BF_TIMER = setInterval(adpBackfillPoll, 3000);
  adpBackfillPoll();
}

async function adpBackfillPoll() {
  const btn = $("adpBackfillBtn"), hint = $("adpBfHint");
  let s;
  try {
    s = await api("/api/adprofit/backfill/status");
  } catch (e) {
    stopAdpBackfillPoll();
    if (btn) btn.disabled = false;
    toast("查询补抓进度失败：" + e.message);
    return;
  }
  if (s.running) {
    if (hint) hint.textContent = s.message || `补抓中 ${s.done}/${s.total}`;
    return;
  }
  stopAdpBackfillPoll();
  if (btn) btn.disabled = false;
  const fails = (s.results || []).filter((r) => !r.ok);
  if (hint) {
    hint.textContent = (s.message || "补抓完成")
      + (fails.length ? `；失败：${fails.map((f) => `${f.label}·${f.account_label} ${f.start}~${f.end}`).join("、")}` : "");
  }
  toast(s.message || "补抓完成");
  loadAdProfit(true);
}

function stopAdpBackfillPoll() {
  if (ADP_BF_TIMER) {
    clearInterval(ADP_BF_TIMER);
    ADP_BF_TIMER = null;
  }
}

/* ---------------- 按 SKU 明细 ---------------- */

async function loadAdProfitSku(from, to, whQs, refresh) {
  const stat = $("adpSkuStat");
  if (stat) stat.textContent = "按 SKU 加载中…";
  try {
    const d = await api(`/api/adprofit/skus?date_from=${from}&date_to=${to}${whQs}${excludeOtherQs()}${refresh ? "&refresh=1" : ""}`);
    ADP_SKU = d;
    ADP_SKU_FULL = false;
    renderAdProfitSku();
  } catch (e) {
    ADP_SKU = null;
    ADP_SKU_ERROR = e.message || "接口请求失败";
    const t = $("adpSkuTable");
    if (t) t.innerHTML = `<tbody><tr><td class="empty">按 SKU 明细加载失败：${esc(e.message)}</td></tr></tbody>`;
    if (stat) stat.textContent = "";
    renderAdpDealTable();
  }
}

/* 下拉里的「常用列」→ 行字段；点列头可以按任意列排，两者共用 adpSkuTable._sort 一份状态 */
const ADP_SKU_SORT_COLS = { ads: "ads_total", revenue: "revenue", gross: "gross_before", gross_after: "gross_after" };

function adpSkuSortBySel() {
  const sel = $("adpSkuSort");
  $("adpSkuTable")._sort = { key: ADP_SKU_SORT_COLS[sel.value] || "ads_total", dir: -1 };
  renderAdProfitSku();
}

function renderAdProfitSku() {
  const t = $("adpSkuTable");
  if (!t) return;
  t._render = renderAdProfitSku;   // 供表头点击排序的通用派发器回调重绘
  const stat = $("adpSkuStat");
  if (!ADP_SKU) {
    t.innerHTML = `<tbody><tr><td class="empty">暂无数据</td></tr></tbody>`;
    return;
  }
  const kws = splitSearchKeywords($("adpSkuSearch").value);
  const onlyAds = $("adpSkuOnlyAds").checked;
  const onlyLoss = $("adpSkuOnlyLoss").checked;
  const all = ADP_SKU.rows || [];
  // 毛利/广告费：广告前毛利 ÷ 广告费（ROAS 看收入，这一列看毛利，做保本判断更直接）
  for (const r of all) {
    const ads = Number(r.ads_total) || 0;
    r.gp_ads = ads ? (Number(r.gross_before) || 0) / ads : null;
    // 毛利率 = 广告后毛利 ÷ 销售额（纯广告行没有销售额，显示 —）
    const rev = Number(r.revenue) || 0;
    r.gp_rate = rev ? (Number(r.gross_after) || 0) / rev : null;
  }
  // 名称后展示的标签也参与搜索（如「入仓品」「未匹配ERP」「未填编码」），空格写法与无空格写法都算命中
  const tagTextOf = (r) => {
    if (r.source === "profit") return "入仓品";
    if (r.ad_only) {
      return "未匹配ERP 未匹配 ERP" + (r.is_warehouse_in ? " 入仓品 入仓品无利润缓存" : "");
    }
    return r.no_code ? "未填编码" : "";
  };
  let rows = all.filter((r) =>
    (!onlyAds || r.ads_total > 0) &&
    (!onlyLoss || (Number(r.gross_after) < -0.005 && !r.ad_only)) &&
    searchHit(`${r.sku || ""} ${r.name || ""} ${tagTextOf(r)}`, kws)
  );
  if (!t._sort) t._sort = { key: "ads_total", dir: -1 };
  const sel = $("adpSkuSort");
  const preset = Object.keys(ADP_SKU_SORT_COLS).find((k) => ADP_SKU_SORT_COLS[k] === t._sort.key);
  if (sel) sel.value = preset || "__col";   // 点列头选了非快捷列时，下拉显示「按列头排序」
  rows = applyTableSort(t, rows);

  const totals = ADP_SKU.totals || {};
  // 广告后亏损的分层：未匹配 ERP 的行收入记 0、天然为负，不计入亏损清单，避免误导
  const negRows = all.filter((r) => !r.ad_only && Number(r.gross_after) < -0.005);
  const negSum = negRows.reduce((a, r) => a + Number(r.gross_after), 0);
  if (stat) {
    const un = Number(totals.unmatched_ads) || 0;
    const pr = (ADP_SKU.profit_ranges || []).slice(-1)[0];
    stat.innerHTML = `${totals.sku_count || 0} 个 SKU · 匹配广告 ${totals.matched_skus || 0} 个 · 未匹配广告 ${totals.ad_only_skus || 0} 个`
      + (Number(totals.warehouse_sku_count) ? ` · 入仓品 ${totals.warehouse_sku_count} 个（利润缓存 ${esc(pr || "无")}）` : "")
      + (un > 0.005 ? ` · <span style="color:var(--red);">未匹配广告费 ${fmtMoney(un)}</span>` : "")
      + (negRows.length ? ` · <span style="color:var(--red);">${negRows.length} 个 SKU 广告后亏损，合计 ${fmtMoney(negSum)}</span>` : "");
  }

  const LIMIT = 80;
  const shown = ADP_SKU_FULL ? rows : rows.slice(0, LIMIT);
  const qtyOf = (r) => (r.qty ? `${fmtNum(r.qty)}${r.unit ? " " + esc(r.unit) : ""}` : "—");
  const tagOf = (r) => {
    if (r.source === "profit") return ` <span class="badge pack" title="入仓品：成交件数/毛利取自 jdfenxi 月度利润缓存">入仓品</span>`;
    if (r.ad_only) {
      return ` <span class="badge out" title="有广告花费，但 ERP 商品明细里没有这个编码（京东 skuId）的销售记录">未匹配 ERP</span>`
        + (r.is_warehouse_in ? ` <span class="badge pack" title="入仓品，但该月没有利润缓存，成交件数/毛利未补全">入仓品无利润缓存</span>` : "");
    }
    return r.no_code ? ` <span class="badge pack" title="商品资料没填编码，无法匹配广告花费">未填编码</span>` : "";
  };
  const body = shown.length ? shown.map((r) => `<tr>
      <td class="mono">${esc(r.sku || "—")}</td>
      <td>${esc(r.name || "—")}${tagOf(r)}</td>
      <td class="num">${qtyOf(r)}</td>
      <td class="num mono">${fmtMoney(r.revenue)}</td>
      <td class="num mono">${fmtMoney(r.gross_before)}</td>
      <td class="num mono">${fmtMoney(r.cps)}</td>
      <td class="num mono">${fmtMoney(r.jzt)}</td>
      <td class="num mono"><strong>${fmtMoney(r.ads_total)}</strong></td>
      <td class="num mono" style="color:${r.gross_after >= 0 ? "var(--green)" : "var(--red)"};">${fmtMoney(r.gross_after)}</td>
      <td class="num mono" style="color:${r.gp_rate == null ? "" : (r.gp_rate >= 0 ? "var(--green)" : "var(--red)")};">${adpPct(r.gp_rate)}</td>
      <td class="num muted">${adpPct(r.ad_rate)}</td>
      <td class="num muted">${r.roi == null ? "—" : Number(r.roi).toFixed(2)}</td>
      <td class="num" style="color:${r.gp_ads != null && r.gp_ads < 0 ? "var(--red)" : ""}">${r.gp_ads == null ? "—" : Number(r.gp_ads).toFixed(2)}</td>
    </tr>`).join("") : `<tr><td colspan="13" class="empty">${kws.length || onlyAds || onlyLoss ? "没有符合条件的 SKU" : "所选区间没有可用的 SKU 数据"}</td></tr>`;

  const filtered = kws.length > 0 || onlyAds || onlyLoss;
  // 筛选生效时合计必须跟着筛，否则「只看亏损 28 个」下面却挂着全量广告费，会误导
  const sumF = (k) => Math.round(rows.reduce((a, r) => a + (Number(r[k]) || 0), 0) * 100) / 100;
  const revenueTotal = filtered ? sumF("revenue") : (totals.revenue_total != null ? totals.revenue_total : totals.erp_revenue);
  const grossAfterTotal = filtered ? sumF("gross_after") : totals.gross_after;
  const marginTotal = revenueTotal ? grossAfterTotal / revenueTotal : null;

  t.innerHTML = `<thead><tr>
      <th data-key="sku">SKU${sortArrow("adpSkuTable", "sku")}</th>
      <th data-key="name">商品名称${sortArrow("adpSkuTable", "name")}</th>
      <th class="num" data-key="qty">销量 / 成交件数${sortArrow("adpSkuTable", "qty")}</th>
      <th class="num" data-key="revenue">销售额${sortArrow("adpSkuTable", "revenue")}</th>
      <th class="num" data-key="gross_before">广告前毛利${sortArrow("adpSkuTable", "gross_before")}</th>
      <th class="num" data-key="cps">CPS 花费${sortArrow("adpSkuTable", "cps")}</th>
      <th class="num" data-key="jzt">京准通花费${sortArrow("adpSkuTable", "jzt")}</th>
      <th class="num" data-key="ads_total">广告费合计${sortArrow("adpSkuTable", "ads_total")}</th>
      <th class="num" data-key="gross_after">广告后毛利${sortArrow("adpSkuTable", "gross_after")}</th>
      <th class="num" data-key="gp_rate" title="毛利率 = 广告后毛利 ÷ 销售额">毛利率${sortArrow("adpSkuTable", "gp_rate")}</th>
      <th class="num" data-key="ad_rate">广告费率${sortArrow("adpSkuTable", "ad_rate")}</th>
      <th class="num" data-key="roi" title="销售额 ÷ 广告费（ROAS，不是利润率）">ROAS${sortArrow("adpSkuTable", "roi")}</th>
      <th class="num" data-key="gp_ads" title="广告前毛利 ÷ 广告费：小于 1 说明这批广告带来的毛利还不够付广告费">毛利/广告费${sortArrow("adpSkuTable", "gp_ads")}</th>
    </tr></thead><tbody>${body}</tbody>` +
    `<tfoot><tr>
      <td><strong>${filtered ? "筛选合计" : "合计"}</strong></td><td class="muted">共 ${rows.length} 个 SKU</td>
      <td class="num"></td>
      <td class="num mono"><strong>${fmtMoney(revenueTotal)}</strong></td>
      <td class="num mono"><strong>${fmtMoney(filtered ? sumF("gross_before") : totals.gross_before)}</strong></td>
      <td class="num mono"><strong>${fmtMoney(filtered ? sumF("cps") : totals.cps_total)}</strong></td>
      <td class="num mono"><strong>${fmtMoney(filtered ? sumF("jzt") : totals.jzt_total)}</strong></td>
      <td class="num mono"><strong>${fmtMoney(filtered ? sumF("ads_total") : totals.ads_total)}</strong></td>
      <td class="num mono"><strong>${fmtMoney(grossAfterTotal)}</strong></td>
      <td class="num mono"><strong>${adpPct(marginTotal)}</strong></td>
      <td class="num"></td><td class="num"></td><td class="num"></td>
    </tr>${Number(totals.warehouse_sku_count) ? `<tr><td colspan="13" class="muted">其中入仓品 ${totals.warehouse_sku_count} 个 · 成交 ${fmtNum(totals.warehouse_qty)} 件 · 销售额 ${fmtMoney(totals.warehouse_revenue)} · 毛利 ${fmtMoney(totals.warehouse_gross)} · 广告费 ${fmtMoney(totals.warehouse_ads)} · 广告后毛利 ${fmtMoney(totals.warehouse_net)}</td></tr>` : ""}${(!ADP_SKU_FULL && rows.length > LIMIT) ? `<tr><td colspan="13" class="muted">已显示前 ${LIMIT} 条，共 ${rows.length} 条 · <a href="javascript:;" onclick="ADP_SKU_FULL=true;renderAdProfitSku();">显示全部</a></td></tr>` : ""}</tfoot>`;
  renderAdpDealTable();
}

function renderAdProfit(d) {
  ADP_SUMMARY = d;
  const erp = d.erp || {}, p = d.profit || {}, ads = d.ads || {};
  const rng = d.range || {};
  const rev = Number(erp.revenue) || 0;
  const pre = erp.is_all ? "全仓" : "";

  const rh = $("adpRangeHint");
  if (rh) {
    const caliber = erp.exclude_other_expense
      ? `已排除其他收支 ${fmtMoney(erp.excluded_other_expense)}`
      : `含其他收支 ${fmtMoney(erp.excluded_other_expense)}`;
    rh.textContent = `统计区间 ${rng.start} ~ ${rng.end}（${rng.days} 天）`
      + (erp.is_all ? " · 全仓合计" : (erp.warehouse && erp.warehouse.name ? ` · ${erp.warehouse.name}` : ""))
      + ` · ${caliber}`
      + (erp.is_all ? "" : " · 广告费为店铺合计（店铺未与分仓做映射）");
  }
  const gen = $("adpGeneratedAt");
  if (gen) gen.textContent = d.generated_at ? `数据时间 ${d.generated_at}` : "";
  const hint = $("adpStatHint");
  if (hint) hint.textContent = ads.service_ok ? "" : "广告数据读取异常，广告费按 0 计入";

  // ---- 概览统计 ----
  const netAfter = Number(p.net_after_ads) || 0;
  // 广告缓存拼不满区间时，广告费被低估 → 净利润（广告后）偏高，必须在卡片上直接标出来
  const gapDays = [ads.cps, ads.jzt].reduce((a, part) =>
    a + ((part && part.accounts) || []).reduce((b, x) => b + ((x.gaps || []).length), 0), 0);
  $("adpStats").innerHTML = `
    <div class="stat blue"><div class="label">${pre}销售收入</div><div class="value">${fmtMoney(erp.revenue)}</div><div class="sub">${erp.order_count} 单</div></div>
    <div class="stat green"><div class="label">${pre}毛利（广告前）</div><div class="value">${fmtMoney(p.gross_before_ads)}</div><div class="sub">毛利率 ${rev ? ((Number(p.gross_before_ads) / rev) * 100).toFixed(1) + "%" : "—"}</div></div>
    <div class="stat red"><div class="label">CPS 花费</div><div class="value">${fmtMoney(p.cps_total)}</div><div class="sub">付款佣金（挂载服务缓存）</div></div>
    <div class="stat red"><div class="label">京准通花费</div><div class="value">${fmtMoney(p.jzt_total)}</div><div class="sub">投放花费（挂载服务缓存）</div></div>
    <div class="stat amber"><div class="label">广告费合计</div><div class="value">${fmtMoney(p.ads_total)}</div><div class="sub">占收入 ${adpPct(p.ad_rate)}</div></div>
    <div class="stat ${Number(p.gross_after_ads) >= 0 ? "green" : "red"}"><div class="label">${pre}毛利（广告后）</div><div class="value">${fmtMoney(p.gross_after_ads)}</div><div class="sub">毛利 − 广告费</div></div>
    <div class="stat red"><div class="label">${pre}净利润（广告前）</div><div class="value">${fmtMoney(p.net_before_ads)}</div><div class="sub">净利率 ${adpPct(p.net_margin_before)}</div></div>
    <div class="stat ${netAfter >= 0 ? "green" : "red"}"><div class="label">${pre}净利润（广告后）</div><div class="value">${fmtMoney(netAfter)}</div><div class="sub">净利率 ${adpPct(p.net_margin_after)}${gapDays ? ` · <span style="color:var(--red)">缺 ${gapDays} 天广告数据，本行偏高</span>` : ""}</div></div>`;

  // ---- 告警：缺口 / 服务不可用 / 未抓取 ----
  const warnBox = $("adpWarn");
  const warns = d.warnings || [];
  if (warnBox) {
    warnBox.style.display = warns.length ? "" : "none";
    warnBox.innerHTML = warns.map((w) => `⚠ ${esc(w)}`).join("<br>");
  }

  // ---- 利润桥 ----
  const pctOf = (v) => rev ? ((Number(v) || 0) / rev * 100).toFixed(1) + "%" : "—";
  const rowOf = (name, value, desc) =>
    `<tr><td>${esc(name)}</td><td class="num mono">${fmtMoney(value)}</td><td class="num muted">${pctOf(value)}</td><td class="muted">${esc(desc)}</td></tr>`;
  $("adpBridge").innerHTML = `<thead><tr><th>项目</th><th class="num">金额</th><th class="num">占收入</th><th>说明</th></tr></thead><tbody>` +
    rowOf("销售收入", erp.revenue, "商品销售 + 客户代收的关联结算") +
    rowOf("结转成本", -(Number(erp.cogs) || 0), `商品成本 ${fmtMoney(erp.goods_cogs)}` + (erp.brush_cost ? ` · 刷单成本 ${fmtMoney(erp.brush_cost)}` : "")) +
    rowOf("毛利（广告前）", p.gross_before_ads, "财务报表口径") +
    rowOf("期间费用", -(Number(erp.expense) || 0), `手工记账 ${fmtMoney(erp.manual_expense)} · 其他收支 ${fmtMoney(erp.other_expense)}${adPrepayNote(erp)}`) +
    rowOf("净利润（广告前）", p.net_before_ads, "毛利 − 期间费用") +
    rowOf("CPS 花费", -(Number(p.cps_total) || 0), "付款佣金") +
    rowOf("京准通花费", -(Number(p.jzt_total) || 0), "京东京准通投放") +
    rowOf("广告费合计", -(Number(p.ads_total) || 0), "CPS + 京准通") +
    `<tr><td><strong>毛利（广告后）</strong></td><td class="num mono"><strong>${fmtMoney(p.gross_after_ads)}</strong></td><td class="num muted">${pctOf(p.gross_after_ads)}</td><td class="muted">毛利 − 广告费</td></tr>` +
    `<tr><td><strong>净利润（广告后）</strong></td><td class="num mono" style="color:${netAfter >= 0 ? "var(--green)" : "var(--red)"};font-weight:700;">${fmtMoney(netAfter)}</td><td class="num muted">${pctOf(netAfter)}</td><td class="muted">净利润 − 广告费</td></tr>` +
    `</tbody>`;

  // ---- 按店铺账号的广告费 ----
  renderAdAccounts(ads, rng.days);
  // ---- 入仓台账 / 成交口径：只在切换对应视图时展示，但数据随概览一起更新 ----
  renderAdpWhIn();
  renderAdpDealTable();
}

/* 入仓台账（备货结算）单独一张表：财务口径里含它，但成交口径不含它 */
function renderAdpWhIn() {
  const t = $("adpWhInTable");
  if (!t) return;
  const d = ADP_SUMMARY;
  if (!d) {
    t.innerHTML = `<tbody><tr><td class="empty">暂无数据</td></tr></tbody>`;
    return;
  }
  const wi = d.warehouse_in || {};
  const rows = wi.rows || [];
  const body = rows.map((r) => `<tr>
      <td>${esc(r.name || "")}</td>
      <td class="num mono">${fmtNum(r.qty)}${r.unit ? " " + esc(r.unit) : ""}</td>
      <td class="num mono">${fmtMoney(r.revenue)}</td>
      <td class="num mono">${fmtMoney(r.cogs)}</td>
      <td class="num mono">${fmtMoney(r.gross)}</td>
    </tr>`).join("");
  t.innerHTML = `<thead><tr>
      <th>入仓品</th><th class="num">数量</th><th class="num">入仓收入</th>
      <th class="num">入仓成本</th><th class="num">入仓毛利</th>
    </tr></thead><tbody>${body || `<tr><td colspan="5" class="empty">所选区间没有入仓台账</td></tr>`}</tbody>
    <tfoot><tr>
      <td><strong>合计</strong> <span class="muted">共 ${Number(wi.count) || 0} 单</span></td>
      <td class="num mono"><strong>${fmtNum(wi.qty)}</strong></td>
      <td class="num mono"><strong>${fmtMoney(wi.revenue)}</strong></td>
      <td class="num mono"><strong>${fmtMoney(wi.cogs)}</strong></td>
      <td class="num mono"><strong>${fmtMoney(wi.gross)}</strong></td>
    </tr></tfoot>`;
}

/* 成交口径利润表 + 与财务口径的对账：所有数字都来自接口合计，不在前端另算口径 */
function renderAdpDealTable() {
  const t = $("adpDealTable");
  if (!t) return;
  if (!ADP_SKU) {
    const msg = ADP_SKU_ERROR
      ? `成交口径加载失败：${esc(ADP_SKU_ERROR)}`
      : (ADP_SUMMARY ? "按 SKU 明细加载中…" : "暂无数据");
    t.innerHTML = `<tbody><tr><td class="empty">${msg}</td></tr></tbody>`;
    return;
  }
  const tot = ADP_SKU.totals || {};
  const rev = Number(tot.revenue_total) || 0;
  const gross = Number(tot.gross_before) || 0;
  const cogs = rev - gross;
  const ads = Number(tot.ads_total) || 0;
  const after = Number(tot.gross_after) || 0;

  const f = ADP_SUMMARY || {};
  const fp = f.profit || {};
  const fwi = f.warehouse_in || {};
  const fe = f.erp || {};
  const fGross = Number(fp.gross_before_ads) || 0;
  const fAfter = Number(fp.gross_after_ads) || 0;
  const whGross = Number(fwi.gross) || 0;
  const dealWhGross = Number(tot.warehouse_gross) || 0;
  const expense = Number(fe.expense) || 0;

  const line = (name, value, desc, cls = "") =>
    `<tr class="${cls}"><td>${esc(name)}</td><td class="num mono">${fmtMoney(value)}</td><td class="muted">${esc(desc)}</td></tr>`;
  const section = (title) => `<tr><td colspan="3" class="muted" style="background:var(--bg-soft,#f7f8fa);font-weight:600;">${esc(title)}</td></tr>`;

  t.innerHTML = `<thead><tr><th>项目</th><th class="num">金额</th><th>说明</th></tr></thead><tbody>` +
    section("一、利润表（成交口径）") +
    line("销售收入", rev, "ERP 出库销售 + 入仓品京东实际成交") +
    line("结转成本", -cogs, "商品成本 + 打包/快递 + 刷单结算") +
    line("毛利（广告前）", gross, "销售收入 − 结转成本") +
    line("广告费合计", -ads, "CPS + 京准通（与财务口径同一份缓存）") +
    `<tr><td><strong>广告后毛利</strong></td><td class="num mono"><strong>${fmtMoney(after)}</strong></td><td class="muted">毛利 − 广告费</td></tr>` +
    section("二、与财务口径对账（差额来源）") +
    line("财务口径毛利（广告前）", fGross, "含入仓台账备货结算") +
    line("减：入仓台账毛利", -whGross, "备货入仓/结算，不在成交口径") +
    line("加：入仓品京东成交毛利", dealWhGross, "入仓品实际卖出部分（jdfenxi 月度利润）") +
    `<tr><td><strong>成交口径毛利（广告前）</strong></td><td class="num mono"><strong>${fmtMoney(gross)}</strong></td><td class="muted">与第一节一致（0.01 尾差为逐行四舍五入）</td></tr>` +
    line("广告费差异", ads - (Number(fp.ads_total) || 0), "两边读同一份花费缓存，应为 0") +
    line("广告后毛利差额（财务 − 成交）", fAfter - after, "= 入仓台账毛利 − 入仓品成交毛利") +
    line("财务口径净利润（广告后）另扣期间费用", expense, "净利润 = 毛利 − 期间费用；成交口径只到毛利") +
    `</tbody>`;
}

function renderAdAccounts(ads, days) {
  const t = $("adpAccTable");
  if (!t) return;
  const map = new Map();
  // 先放入挂载服务里配置的全部店铺：新加的店铺即使还没有花费缓存也要显示出来，
  // 否则页面会一直停留在「老几个」，用户以为没有同步。
  ((ads && ads.all_accounts) || []).forEach((a) => {
    const k = a.label || a.key;
    if (!map.has(k)) map.set(k, { label: k, cps: null, jzt: null, configured: true });
  });
  const merge = (kind, part) => {
    ((part && part.accounts) || []).forEach((a) => {
      const k = a.label || a.key;
      const m = map.get(k) || { label: k, cps: null, jzt: null };
      m[kind] = a;
      map.set(k, m);
    });
  };
  merge("cps", ads.cps);
  merge("jzt", ads.jzt);
  const rows = Array.from(map.values()).sort((a, b) =>
    ((b.cps ? b.cps.total : 0) + (b.jzt ? b.jzt.total : 0)) -
    ((a.cps ? a.cps.total : 0) + (a.jzt ? a.jzt.total : 0))
  );
  const totalOf = (r) => (r.cps ? r.cps.total : 0) + (r.jzt ? r.jzt.total : 0);
  const covered = (a) => a ? `${a.covered_days}/${days}` : "—";
  const gapOf = (r) => {
    if (!r.cps && !r.jzt) return r.configured ? "无花费缓存（去 jdfenxi 抓取）" : "";
    const g = [];
    if (r.cps && r.cps.gaps && r.cps.gaps.length) g.push(`CPS 缺 ${r.cps.gaps.join("、")}`);
    if (r.jzt && r.jzt.gaps && r.jzt.gaps.length) g.push(`京准通缺 ${r.jzt.gaps.join("、")}`);
    return g.join("；");
  };
  const total = rows.reduce((s, r) => s + totalOf(r), 0);
  t.innerHTML = `<thead><tr>
      <th>店铺账号</th>
      <th class="num">CPS 花费</th><th class="num">覆盖</th>
      <th class="num">京准通花费</th><th class="num">覆盖</th>
      <th class="num">合计</th><th>缺口</th>
    </tr></thead><tbody>` +
    (rows.length ? rows.map((r) => `<tr>
      <td>${esc(r.label)}</td>
      <td class="num mono">${fmtMoney(r.cps ? r.cps.total : 0)}</td>
      <td class="num muted">${covered(r.cps)} 天</td>
      <td class="num mono">${fmtMoney(r.jzt ? r.jzt.total : 0)}</td>
      <td class="num muted">${covered(r.jzt)} 天</td>
      <td class="num mono"><strong>${fmtMoney(totalOf(r))}</strong></td>
      <td class="muted">${gapOf(r) ? `<span style="color:var(--red);">${esc(gapOf(r))}</span>` : "—"}</td>
    </tr>`).join("") : `<tr><td colspan="7" class="empty">所选区间没有可用的花费缓存</td></tr>`) +
    `</tbody>` + (rows.length ? `<tfoot><tr>
      <td><strong>合计</strong></td>
      <td class="num mono"></td><td></td><td class="num mono"></td><td></td>
      <td class="num mono"><strong>${fmtMoney(total)}</strong></td><td></td>
    </tr></tfoot>` : "");
}


