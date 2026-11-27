/* =============== 报表 =============== */
/* 报表两级视图：全仓总览（所有分仓合计）/ 单仓总览（默认当前分仓，可切换查看其他分仓） */
/* =============== 报表口径：排除其他收支（默认开启） ===============
   开启后财务报表不计入「其他收支」（经营分析 → 其他收支）的款项，只看商品售卖利润。
   偏好存在本机，web 端与 PWA 端共用同一个 localStorage key。 */
const EXCLUDE_OTHER_KEY = "erp_exclude_other_expense";
let EXCLUDE_OTHER = localStorage.getItem(EXCLUDE_OTHER_KEY) !== "0";   // 无记录时默认开启

/** 报表请求附加的口径参数（后端默认值同为「排除」，这里仍显式声明，避免依赖默认值） */
const excludeOtherQs = () => (EXCLUDE_OTHER ? "&exclude_other=1" : "&exclude_other=0");

/** 期间费用说明后缀：「广告费充值」是充进京准通的预付款，后端已从期间费用剔出，
 *  广告费只在「广告利润」页按 CPS + 京准通实际消耗扣一次；不写出来的话这里会凭空少一笔。 */
const adPrepayNote = (o) => {
  const v = Number(o && o.ad_prepay_expense) || 0;
  return Math.abs(v) < 0.005 ? "" : ` · 广告费充值 ${fmtMoney(v)} 未计入（广告费见「广告利润」）`;
};

/* =============== 报表统计区间偏好 ===============
   财务报表选过的区间存本机，其他收支页打开时直接跟随。
   默认统一为「最近 7 天」（含今天），避免一打开就停在很久以前的区间、
   新发生的收支/单据看不到。
   只有财务报表写、其他收支读：其他收支页有「全部」（清空区间），
   写回去会把财务报表也拉成无界区间，所以不反向同步。
   key 加 v2：让浏览器里旧版存下的历史区间（如 10 月整月）失效一次，
   老用户升级后也能直接落到新的「最近 7 天」默认值；之后用户改的区间照常记住。 */
const REPORT_RANGE_KEY = "erp_report_range_v2";
const DATE_STR = /^\d{4}-\d{2}-\d{2}$/;

function saveReportRange(from, to) {
  if (!from || !to) return;   // 「全部」不写回，保留上一次的有界区间
  try { localStorage.setItem(REPORT_RANGE_KEY, JSON.stringify([from, to])); } catch (e) { /* 隐私模式忽略 */ }
}

/** 已存过的报表区间；没存过或格式不对返回 null（调用方回落到各自默认值） */
function savedReportRange() {
  try {
    const v = JSON.parse(localStorage.getItem(REPORT_RANGE_KEY) || "null");
    if (Array.isArray(v) && DATE_STR.test(v[0] || "") && DATE_STR.test(v[1] || "") && v[0] <= v[1]) return v;
  } catch (e) { /* 脏数据按未存过处理 */ }
  return null;
}

/** 把本机偏好回显到两份报表页的口径开关（初始化时调用）
 *  财务报表页 excludeOtherChk + 广告利润页 adpExcludeOtherChk 必须同时回显，
 *  否则开关画的是 HTML 默认值、请求发的是 localStorage 里的真实值 —— 显示与生效不一致。 */
function syncExcludeOtherHint() {
  ["excludeOtherChk", "adpExcludeOtherChk"].forEach((id) => {
    const chk = $(id);
    if (chk) chk.checked = EXCLUDE_OTHER;
  });
}

/** 报表页口径开关：切换后持久化，并立即按新口径重算 */
function toggleExcludeOther(chk) {
  EXCLUDE_OTHER = !!chk.checked;
  localStorage.setItem(EXCLUDE_OTHER_KEY, EXCLUDE_OTHER ? "1" : "0");
  syncExcludeOtherHint();
  toast(EXCLUDE_OTHER ? "已排除其他收支：只看商品售卖利润" : "已计入其他收支：含全部期间费用");
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
 *  六个分区 tab（利润表/现金流量表/余额表/支出/商品/流水）两种视角都用：数据源由请求的 wh 决定
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
      <div class="stat blue"><div class="label">全仓销售收入</div><div class="value">${fmtMoney(tot.revenue)}</div><div class="sub">${tot.orders || 0} 单${tot.warehouse_ins ? ` · 入仓 ${tot.warehouse_ins} 条` : ""} · ${tot.warehouse_count || 0} 个分仓</div></div>
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
      <td class="num mono"><b>${fmtMoney(tot.revenue)}</b>${tot.warehouse_in_revenue ? `<div class="muted" style="font-size:11px;">含入仓 ${fmtMoney(tot.warehouse_in_revenue)}</div>` : ""}</td>
      <td class="num mono"><b>${fmtMoney(tot.cogs)}</b>${tot.warehouse_in_cogs ? `<div class="muted" style="font-size:11px;">含入仓 ${fmtMoney(tot.warehouse_in_cogs)}</div>` : ""}</td>
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
            <td class="num mono">${fmtMoney(w.revenue)}${w.warehouse_in_revenue ? `<div class="muted" style="font-size:11px;">含入仓 ${fmtMoney(w.warehouse_in_revenue)}</div>` : ""}</td>
            <td class="num mono">${fmtMoney(w.cogs)}${w.warehouse_in_cogs ? `<div class="muted" style="font-size:11px;">含入仓 ${fmtMoney(w.warehouse_in_cogs)}</div>` : ""}</td>
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
/* =============== 报表「财务流水」分区：窗口化渲染 ===============
   流水行数跟出库单一样多（每张出库单自动产一条「销售收入」流水），全仓本月实测 4.4 万行。
   以前是 finRows.map(...).join("") 一次性写进 innerHTML —— 4 万行 × 9 列 ≈ 36 万个 DOM 节点，
   主线程一冻就是几十秒，浏览器直接弹「页面无响应」；筛选框每敲一个字还要重来一遍。
   现在排序/筛选仍作用于完整数组，只是分批渲染，且筛选只重渲染、不再打接口。 */
const FIN_PAGE = 300;
// rows = 已从后端加载的流水；limit = 本地渲染窗口；total = 后端总条数（分页拉取）
const FIN = { rows: [], wh: false, limit: FIN_PAGE, total: 0, qs: "" };

function renderFinanceTable() {
  const ft = $("financeTable");
  if (!ft) return;
  const kws = splitSearchKeywords($("repSearch")?.value);
  let rows = FIN.rows;
  if (kws.length) rows = rows.filter((f) => searchHit([f.category, f.product_name, f.remark, f.operator, f.type, f.warehouse].join(" "), kws));
  rows = applyTableSort(ft, rows);
  const cols = FIN.wh ? 9 : 8;
  const shown = rows.slice(0, FIN.limit);
  const moreLocal = Math.max(0, rows.length - shown.length);          // 本地已加载但还没渲染出来的
  const moreRemote = Math.max(0, FIN.total - FIN.rows.length);       // 后端还有、本地没拉的
  ft.innerHTML = `<thead><tr>
    ${FIN.wh ? "<th>分仓</th>" : ""}
    <th>类型</th>
    <th data-key="category">分类${sortArrow("financeTable", "category")}</th>
    <th data-key="product_name">商品${sortArrow("financeTable", "product_name")}</th>
    <th data-key="amount" class="num">金额${sortArrow("financeTable", "amount")}</th>
    <th data-key="operator">操作员${sortArrow("financeTable", "operator")}</th>
    <th data-key="date">日期${sortArrow("financeTable", "date")}</th>
    <th>备注</th><th></th></tr></thead><tbody>` +
    shown.map((f) => `<tr>
      ${FIN.wh ? `<td>${esc(f.warehouse) || "—"}</td>` : ""}
      <td>${f.type === "income" ? '<span class="badge income">收入</span>' : '<span class="badge expense">支出</span>'}</td>
      <td>${esc(f.category)}</td>
      <td>${esc(f.product_name) || "—"}</td>
      <td class="num mono" style="color:${f.type === "income" ? "var(--green)" : "var(--red)"}">${f.type === "income" ? "+" : "-"}${fmtMoney(f.amount)}</td>
      <td>${esc(f.operator) || "—"}</td><td>${f.date}</td>
      <td class="muted">${esc(f.remark)}</td>
      <td>${f.ref_type === "manual" ? `<button class="btn sm danger" onclick="deleteFinance(${f.id})">删</button>` : ""}</td></tr>`).join("") +
    ((moreLocal > 0 || moreRemote > 0)
      ? `<tr><td colspan="${cols}" class="empty">已显示 ${shown.length} 条（共 ${FIN.total} 条）
        ${moreLocal > 0 ? `<button class="btn sm" onclick="finMore()">再显示 ${Math.min(FIN_PAGE, moreLocal)} 条</button>` : ""}
        ${moreRemote > 0 ? `<button class="btn sm secondary" onclick="finMore(true)">加载更多（已加载 ${FIN.rows.length}/${FIN.total}）</button>` : ""}
        ${moreRemote > 0 ? `<button class="btn sm secondary" onclick="finAll()">加载全部</button>` : ""}</td></tr>`
      : "") + `</tbody>`;
  if (!rows.length) ft.innerHTML = `<tr><td colspan="${cols}" class="empty">本期无财务流水</td></tr>`;
  ft._rows = rows;
  // 点表头排序：首屏只拉了 300 条，只排这一屏会像「排序没生效」，所以先把剩下的补全再排；
  // 后端整月结果已在 60 秒缓存里，续拉只是传输。
  ft._render = async () => {
    FIN.limit = FIN_PAGE;
    if (FIN.total > FIN.rows.length) {
      toast("正在加载全部流水用于排序…");
      try {
        const r = await api(`/api/finance?${FIN.qs}&limit=0`);
        FIN.rows = Array.isArray(r) ? r : (r.rows || FIN.rows);
        FIN.total = FIN.rows.length;
      } catch (e) { toast("加载全部流水失败：" + e.message); }
    }
    renderFinanceTable();
  };
  const hint = $("repFinHint");
  if (hint) hint.textContent = rows.length ? (kws.length ? `匹配 ${rows.length} / ${FIN.rows.length} 条` : `共 ${rows.length} 条`) : "";
}

/** 再显示一批：本地还有就直接渲染；本地没有了就向后端按 offset 续拉一批。 */
async function finMore(remote) {
  if (remote && FIN.rows.length < FIN.total) {
    try {
      const r = await api(`/api/finance?${FIN.qs}&limit=${FIN_PAGE}&offset=${FIN.rows.length}`);
      FIN.rows = FIN.rows.concat(r.rows || []);
      if (r.total != null) FIN.total = r.total;
      FIN.limit += FIN_PAGE;
      renderFinanceTable();
    } catch (e) { toast("加载更多失败：" + e.message); }
    return;
  }
  FIN.limit += FIN_PAGE;
  renderFinanceTable();
}

/** 一次性加载整月流水：明确提示耗时，避免用户误以为卡死。 */
async function finAll() {
  if (FIN.rows.length >= FIN.total) { FIN.limit = FIN.rows.length; renderFinanceTable(); return; }
  if (!(await uiConfirm(`确认加载全部 ${FIN.total} 条流水？\n数据量较大（约需数秒），期间请勿重复操作。`))) return;
  try {
    const r = await api(`/api/finance?${FIN.qs}&limit=0`);
    FIN.rows = Array.isArray(r) ? r : (r.rows || FIN.rows);
    FIN.total = FIN.rows.length;
    FIN.limit = FIN.rows.length;
    renderFinanceTable();
  } catch (e) { toast("加载失败：" + e.message); }
}

let _finSearchTimer = null;
/** 流水筛选只作用于内存里的 FIN.rows：防抖后重渲染，不再整页重新请求 */
function finSearchInput() {
  clearTimeout(_finSearchTimer);
  _finSearchTimer = setTimeout(() => { FIN.limit = FIN_PAGE; renderFinanceTable(); }, 250);
}

let REP_LOADING = false;
let REP_CASH = null;        // 现金流量表缓存（按区间+分仓 key）
let REP_CASH_KEY = "";

/** 报表加载遮罩 + 禁用「查询」按钮：重接口期间给明确反馈，避免连点（连点会在后端并发闸里排队）。 */
function repShowLoading(on) {
  const el = $("repLoading");
  if (el) el.style.display = on ? "flex" : "none";
  // 加载期间禁用报表页的查询/快捷区间/口径切换，避免「界面变了但数据没刷」的错位
  document.querySelectorAll("#page-report .toolbar .btn, #page-report .seg-item").forEach((b) => {
    b.disabled = !!on;
    if ((b.getAttribute("onclick") || "").indexOf("loadReport()") >= 0) {
      b.textContent = on ? "查询中…" : "查询";
    }
  });
}

async function loadReport() {
  // 上一次还没回来就直接忽略：后端「重汇总」是全局串行的，连点只会让两个请求排队、等更久
  if (REP_LOADING) return;
  REP_LOADING = true;
  repShowLoading(true);
  try {
    await _loadReportInner();
  } finally {
    REP_LOADING = false;
    repShowLoading(false);
  }
}

async function _loadReportInner() {
  REP_CASH = null;   // 区间/分仓变了，现金流缓存作废（切到现金流页时再按需加载）
  // 首次进入沿用上次查过的区间（存本机，其他收支页会跟着它）；没存过默认最近 7 天
  if (!reportInited) {
    reportInited = true;
    const saved = savedReportRange();
    if (!$("repDateFrom").value) $("repDateFrom").value = saved ? saved[0] : daysAgo(6);
    if (!$("repDateTo").value) $("repDateTo").value = saved ? saved[1] : today();
    await repEnsureWhOptions();
  }
  const from = $("repDateFrom").value, to = $("repDateTo").value;
  saveReportRange(from, to);
  const all = REP_SCOPE === "all";
  // 全仓总览：wh=all 让后端把各分仓（各自独立账套）的结果合并；单仓总览：可切换查看指定分仓
  const whQs = all ? "&wh=all" : (REP_WH ? `&wh=${encodeURIComponent(REP_WH)}` : "");
  let rep, finance, bal = null;
  // 余额表：全仓（wh=all）由后端逐仓汇总；单仓用所选分仓。失败只影响这张卡，不影响损益。
  const balQs = all ? "&wh=all" : (REP_WH ? `&wh=${encodeURIComponent(REP_WH)}` : "");
  try {
    [rep, finance, bal] = await Promise.all([
      api(`/api/report/summary?date_from=${from || ""}&date_to=${to || ""}${whQs}${excludeOtherQs()}`),
      // 流水先只拿一屏（300 条）：整月 5~6 万条一次性序列化 + gzip + 传输要 3 秒左右，
      // 剩下的按 offset 由「加载更多 / 加载全部」续拉（后端计算结果已进 60 秒缓存，续拉很快）
      api(`/api/finance?date_from=${from || ""}&date_to=${to || ""}${whQs}&limit=${FIN_PAGE}&offset=0`),
      api(`/api/report/balances?date_from=${from || ""}&date_to=${to || ""}${balQs}`)
          .catch((e) => { console.warn("余额表加载失败", e); return null; }),
    ]);
  } catch (e) {
    toast("加载报表失败：" + e.message);
    return;
  }
  const rh = $("repRangeHint");
  if (rh) {
    // 口径：明确「其他收支」算没算进来，避免和「其他收支」页的数字对不上
    const caliber = rep.exclude_other_expense
      ? `已排除其他收支 ${fmtMoney(rep.excluded_other_expense)}`
      : `含其他收支 ${fmtMoney(rep.excluded_other_expense)}`;
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
  // 入仓（入仓品卖到京东）：收入/成本已并入上面的口径，这里把拆分显示出来便于核对
  const wiRev = rep.warehouse_in_revenue || 0;
  const wiCogs = rep.warehouse_in_cogs || 0;
  const wiCnt = rep.warehouse_in_count || 0;
  const wiParts = [
    wiCnt ? `入仓 ${wiCnt} 条` : "",
    wiRev ? fmtMoney(wiRev) : "",
  ].filter(Boolean).join(" ");
  $("repStats").innerHTML = `
    <div class="stat blue"><div class="label">${pre}销售收入</div><div class="value">${fmtMoney(rep.revenue)}</div><div class="sub">${rep.order_count} 单${wiParts ? ` · ${wiParts}` : ""}${all ? ` · ${rep.warehouse_count || 0} 个分仓` : ""}</div></div>
    <div class="stat amber"><div class="label">${pre}结转成本</div><div class="value">${fmtMoney(rep.cogs)}</div><div class="sub">含关联结算 ${fmtMoney(packTotal)}${wiCogs ? ` · 含入仓 ${fmtMoney(wiCogs)}` : ""}</div></div>
    ${rep.brush_cost ? `<div class="stat red"><div class="label">${pre}刷单成本</div><div class="value">${fmtMoney(rep.brush_cost)}</div><div class="sub">芳谊放单仓 · 已从毛利扣减</div></div>` : ""}
    <div class="stat green"><div class="label">${pre}毛利</div><div class="value">${fmtMoney(rep.gross_profit)}</div><div class="sub">${rep.revenue ? ((rep.gross_profit / rep.revenue) * 100).toFixed(1) + "%" : "—"}</div></div>
    <div class="stat red"><div class="label">${pre}期间费用</div><div class="value">${fmtMoney(rep.expense)}</div><div class="sub">其他收支 ${fmtMoney(rep.other_expense)} · 手工记账 ${fmtMoney(rep.manual_expense)}${adPrepayNote(rep)}</div></div>
    <div class="stat ${rep.net_profit >= 0 ? "green" : "red"}"><div class="label">${pre}净利润</div><div class="value">${fmtMoney(rep.net_profit)}</div></div>
    <div class="stat"><div class="label">${pre}本期进货</div><div class="value">${fmtMoney(rep.purchase)}</div></div>
    <div class="stat red"><div class="label">${pre}本期总支出</div><div class="value">${fmtMoney(rep.total_expense)}</div><div class="sub">含采购 ${fmtMoney(rep.purchase)} · 期间费用 ${fmtMoney(rep.expense)}</div></div>
    <div class="stat blue"><div class="label">${pre}当前库存总值</div><div class="value">${fmtMoney(rep.stock_value)}</div></div>`;

  renderReportBridge(rep);
  renderBalances(bal, all);
  renderRevenueBreakdown(rep);
  renderCostBreakdown(rep);
  renderExpenseSummary(rep);
  renderFeeBreakdown(rep);
  renderExpenseTables(rep);
  renderExpenseItems(rep);

  // 商品销售明细：先缓存原始行，再由 renderReportGoods() 按「商品名称筛选」渲染（输入即过滤）
  REP_PROD_ROWS = rep.by_product || [];
  renderReportGoods();
  renderSalesBySpec(from, to, whQs);   // 出库明细：每天 × 每种规格卖了多少单（含代发数量/代发成本）

  // 流水表：数据留在内存（FIN.rows），渲染按窗口分批，见 renderFinanceTable 的注释
  FIN.rows = finance.rows || finance;          // 兼容后端未分页时返回的数组
  FIN.total = finance.total != null ? finance.total : FIN.rows.length;
  FIN.wh = !!rep.is_all;   // 全仓总览：流水来自多个分仓，需要标出来源
  FIN.qs = `date_from=${from || ""}&date_to=${to || ""}${whQs}`;
  FIN.limit = FIN_PAGE;
  renderFinanceTable();

  // 全仓总览：额外加载「各分仓收入 / 支出 / 利润」明细表（汇总分区里）
  if (all) await loadAllWarehouses(from, to);
  // 当前正停在「现金流」分区：报表重查后顺带刷新它
  const cashPanel = $("rep-panel-cash");
  if (cashPanel && cashPanel.style.display !== "none") await loadCashflow();
}

/* ---------------- 现金流量表（实收实付） ---------------- */
async function loadCashflow(force) {
  const from = $("repDateFrom") ? $("repDateFrom").value : "";
  const to = $("repDateTo") ? $("repDateTo").value : "";
  const all = REP_SCOPE === "all";
  const whQs = all ? "&wh=all" : (REP_WH ? `&wh=${encodeURIComponent(REP_WH)}` : "");
  const key = `${from}|${to}|${whQs}`;
  const t = $("repCashTable");
  if (!force && REP_CASH && REP_CASH_KEY === key) { renderCashflow(REP_CASH, all); return; }
  if (t) t.innerHTML = `<tbody><tr><td class="muted">加载中…</td></tr></tbody>`;
  try {
    const d = await api(`/api/report/cashflow?date_from=${from || ""}&date_to=${to || ""}${whQs}`);
    REP_CASH = d; REP_CASH_KEY = key;
    renderCashflow(d, all);
  } catch (e) {
    REP_CASH = null;
    if (t) t.innerHTML = `<tbody><tr><td class="muted">现金流量表加载失败：${esc(e.message)}</td></tr></tbody>`;
  }
}

function renderCashflow(d, all) {
  const t = $("repCashTable"), wt = $("repCashWhTable"), stats = $("repCashStats"), hint = $("repCashHint");
  if (!d || !d.ok) {
    if (t) t.innerHTML = `<tbody><tr><td class="muted">现金流量表加载失败</td></tr></tbody>`;
    return;
  }
  const inf = d.inflow || {}, out = d.outflow || {};
  const rng = d.range || {};
  const net = Number(d.net) || 0;
  if (hint) {
    hint.textContent = `统计区间 ${rng.date_from || "最早"} ~ ${rng.date_to || "最新"}`
      + (d.is_all ? ` · 全仓合计（${d.warehouse_count || 0} 个分仓）` : (d.warehouse && d.warehouse.name ? ` · ${d.warehouse.name}` : ""))
      + " · 只认已收付的钱";
  }
  if (stats) {
    stats.innerHTML = `
      <div class="stat blue"><div class="label">期初账面现金</div><div class="value">${fmtMoney(d.opening_cash)}</div><div class="sub">已录入流水的累计净现金流</div></div>
      <div class="stat green"><div class="label">经营流入</div><div class="value">${fmtMoney(inf.total)}</div><div class="sub">销售回款 / 入仓结算 / 其他收入</div></div>
      <div class="stat red"><div class="label">经营流出</div><div class="value">${fmtMoney(out.total)}</div><div class="sub">采购 / 代发 / 广告 / 费用</div></div>
      <div class="stat ${net >= 0 ? "green" : "red"}"><div class="label">本期净现金流</div><div class="value">${fmtMoney(net)}</div><div class="sub">流入 − 流出</div></div>
      <div class="stat blue"><div class="label">期末账面现金</div><div class="value">${fmtMoney(d.closing_cash)}</div><div class="sub">期初 + 本期净现金流</div></div>`;
  }
  const row = (label, v, desc, kind) => `<tr>
      <td>${kind ? `<span class="badge">${esc(kind)}</span>` : ""}</td>
      <td>${esc(label)}</td>
      <td class="num mono" style="color:${Number(v) < 0 ? "var(--red)" : ""};">${fmtMoney(v)}</td>
      <td class="muted">${esc(desc || "")}</td></tr>`;
  const section = (label) => `<tr><td colspan="4" class="muted" style="background:var(--bg);font-weight:600;">${esc(label)}</td></tr>`;
  t.innerHTML = `<thead><tr><th>类别</th><th>项目</th><th class="num">金额</th><th>说明</th></tr></thead><tbody>
    ${row("期初账面现金", d.opening_cash, "上期累计净现金流（不是银行余额）", "时点")}
    ${section("经营活动现金流入")}
    ${row("销售回款（退货已净掉）", inf.sales, "已回款出库单的实收金额", "流入")}
    ${row("入仓结算回款", inf.warehouse_in, "京东支付入仓货款", "流入")}
    ${row("手工记账收入", inf.manual_income, "财务流水页登记的收入", "流入")}
    ${row("其他收入（补偿/退款）", inf.other_income, "供应商补偿、负数其他收支", "流入")}
    <tr><td></td><td><b>流入合计</b></td><td class="num mono"><b>${fmtMoney(inf.total)}</b></td><td></td></tr>
    ${section("经营活动现金流出")}
    ${row("采购付款", out.purchase, "已付入库单（含运费/装卸/手续费/金额调整）", "流出")}
    ${row("代发付款", out.dropship, "已付代发账单", "流出")}
    ${row("广告充值", out.ad_prepay, "充进京准通账户的预付款", "流出")}
    ${row("其他收支支出", out.other_expense, "手工登记的其他支出与赔付", "流出")}
    ${row("人工打包费", out.pack_fee, "出库带出的打包人工费", "流出")}
    ${row("手工记账支出", out.manual_expense, "财务流水页登记的支出", "流出")}
    <tr><td></td><td><b>流出合计</b></td><td class="num mono"><b>${fmtMoney(out.total)}</b></td><td></td></tr>
    <tr><td></td><td><b>本期净现金流</b></td><td class="num mono"><b style="color:${net >= 0 ? "var(--green)" : "var(--red)"};">${fmtMoney(net)}</b></td><td></td></tr>
    ${row("期末账面现金", d.closing_cash, "期初 + 本期净现金流（不是银行余额）", "时点")}
  </tbody>`;
  const whs = d.warehouses || [];
  if (wt) {
    wt.innerHTML = (all && whs.length) ? `<thead><tr><th>分仓</th><th class="num">期初账面现金</th>
        <th class="num">本期净现金流</th><th class="num">期末账面现金</th></tr></thead><tbody>${whs.map((w) => `<tr>
          <td>${esc(w.name || w.key)}</td>
          <td class="num mono">${fmtMoney(w.opening_cash)}</td>
          <td class="num mono" style="color:${Number(w.net) >= 0 ? "var(--green)" : "var(--red)"};">${fmtMoney(w.net)}</td>
          <td class="num mono">${fmtMoney(w.closing_cash)}</td></tr>`).join("")}</tbody>` : "";
  }
}

/* 余额表：把「资产 / 往来 / 预付 / 盘点差异」从损益里独立出来。
   损益回答「这段时间赚没赚」，余额回答「钱和货现在在哪」——两张表不互相解释，只并列展示。 */
function renderBalances(bal, all) {
  const card = $("repBalCard"), t = $("repBalTable"), hint = $("repBalHint");
  const wt = $("repBalWhTable");
  if (!card || !t) return;
  card.style.display = "";          // 全仓/单仓都要显示（后端现在支持 wh=all）
  if (wt) wt.innerHTML = "";
  if (!bal || !bal.ok) {
    t.innerHTML = `<tbody><tr><td class="muted">余额表加载失败（不影响上面的损益数据；可稍后点「查询」重试）</td></tr></tbody>`;
    return;
  }
  const inv = bal.inventory || {};
  const pay = bal.payables || {};
  const rec = bal.receivables || {};
  const ad = bal.ad_prepay || {};
  const cd = bal.count_diff || {};
  const neg = Number(inv.negative_count || 0);
  const srcText = (m) => Object.entries(m || {})
    .filter(([, v]) => Math.abs(Number(v) || 0) >= 0.005)
    .map(([k, v]) => `${esc(k)} ${fmtMoney(v)}`).join(" · ");
  if (hint) {
    hint.textContent = `截至 ${bal.as_of || "今天"}`
      + (bal.warehouse && bal.warehouse.name ? ` · ${bal.warehouse.name}` : "")
      + (bal.is_all ? `（${bal.warehouse_count || 0} 个分仓）` : "")
      + (inv.basis === "as_of" ? ` · 库存已按 FIFO 重放回算到 ${bal.as_of}` : " · 库存为当前结存")
      + "；只回答「钱和货还在哪」，不改变上面的损益口径";
  }
  const stockDesc = inv.basis === "as_of"
    ? `按库存流水 FIFO 重放到 ${bal.as_of}（当前库存 ${fmtMoney(inv.stock_value_current)}）`
    : "按 FIFO 批次结存（当前库存）";
  const cf = ad.cashflow_range || {};
  const cfSpan = cf.start ? `${cf.start} ~ ${cf.end}` : "jdfenxi 广告费流水";
  const adDesc = ad.balance == null
    ? `jdfenxi 广告费流水读取失败：${(ad.warnings || [])[0] || "请到 jdfenxi「广告费流水」页刷新一次"}`
    : `来源 jdfenxi 广告费流水（${cfSpan}）；当前账户可用余额 ${fmtMoney(ad.balance_current)}`
      + (Math.abs(Number(ad.balance) - Number(ad.balance_current)) >= 0.005
        ? `，截至 ${bal.as_of} 为 ${fmtMoney(ad.balance)}` : "")
      + `；区间充值 ${fmtMoney(ad.recharged_period)} − 区间消费 ${fmtMoney(ad.spent_total)}`
      + (Number(ad.unmapped_accounts || []).length ? ` · 未映射店铺 ${esc(ad.unmapped_accounts.join("、"))}` : "");
  const rows = [
    { kind: "资产", name: "库存结存总值", value: inv.stock_value,
      desc: (neg ? `其中 ${neg} 个商品为负库存（数量 ${fmtNum(inv.negative_qty)}），说明有超卖/漏入库，需盘点冲正；` : "") + stockDesc },
    { kind: "资产", name: "广告账户可用余额（jdfenxi）", value: ad.balance == null ? null : ad.balance, desc: adDesc },
    { kind: "负债", name: "应付未付（要付出去）", value: pay.total || 0,
      desc: srcText(pay.by_source) || "没有未结清的应付款" },
    { kind: "应收", name: "应收未收（要收进来）", value: rec.total || 0,
      desc: srcText(rec.by_source) || "没有未回款的应收款" },
    { kind: "盘点", name: "区间内盘点差异（未计入损益）", value: cd.net_value || 0,
      desc: `盘盈入账 ${fmtMoney(cd.gain_value)}（${cd.gain_lines || 0} 笔） / 盘亏成本 ${fmtMoney(cd.loss_value)}（${cd.loss_lines || 0} 笔）；`
        + (cd.booked_expense ? `已记「库存损耗」费用 ${fmtMoney(cd.booked_expense)}` : "盘亏只冲库存，未记「库存损耗」费用") },
  ];
  const warn = [...(bal.warnings || []), ...(ad.warnings || [])].filter(Boolean).join("；");
  t.innerHTML = `
    <thead><tr><th>类别</th><th>项目</th><th class="num">金额</th><th>说明</th></tr></thead>
    <tbody>${rows.map((r) => `<tr>
      <td><span class="badge">${esc(r.kind)}</span></td>
      <td>${esc(r.name)}</td>
      <td class="num mono">${r.value == null ? "—" : fmtMoney(r.value)}</td>
      <td class="muted">${r.desc}</td>
    </tr>`).join("")}</tbody>
    ${warn ? `<tfoot><tr><td colspan="4" class="muted">提示：${esc(warn)}</td></tr></tfoot>` : ""}`;

  // 全仓：各分仓余额明细（避免只看一个合计数不知道来自哪个仓）
  const whs = bal.warehouses || [];
  if (wt && all && whs.length) {
    wt.innerHTML = `<thead><tr>
        <th>分仓</th><th class="num">库存结存</th><th class="num">应付未付</th>
        <th class="num">应收未收</th><th class="num">盘点差异</th><th class="num">广告预付余额</th>
      </tr></thead><tbody>${whs.map((w) => {
        const wa = w.ad_prepay || {};
        return `<tr>
          <td>${esc(w.name || w.key)}</td>
          <td class="num mono">${fmtMoney((w.inventory || {}).stock_value)}</td>
          <td class="num mono">${fmtMoney(w.payables_total)}</td>
          <td class="num mono">${fmtMoney(w.receivables_total)}</td>
          <td class="num mono">${fmtMoney((w.count_diff || {}).net_value)}</td>
          <td class="num mono">${wa.balance == null ? "—" : fmtMoney(wa.balance)}</td>
        </tr>`;
      }).join("")}</tbody>`;
  }
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
  const COLORS = { "包材耗材": "#ff976a", "人工打包费": "#7232dd", "快递运费": "#07c160", "其他关联结算": "#969799", "刷单成本": "#ee0a24", "入仓运费": "#00b8d9", "入仓包材": "#ffc400" };
  // 入仓（入仓品卖到京东）的运费/随货包材：同样已计入结转成本，单独列出让成本构成相加等于成本合计
  const wiFreight = rep.warehouse_in_freight || 0;
  const wiPack = rep.warehouse_in_pack || 0;
  const wiCost = wiFreight + wiPack;
  const rows = [
    { name: "商品成本", value: goods, color: "#1989fa", tag: "" },
    ...Object.entries(packs)
      .sort((a, b) => b[1] - a[1])
      .map(([k, v]) => ({ name: k, value: v, color: COLORS[k] || "#969799", tag: "自动结算" })),
    ...(wiFreight ? [{ name: "入仓运费", value: wiFreight, color: COLORS["入仓运费"], tag: "入仓" }] : []),
    ...(wiPack ? [{ name: "入仓包材", value: wiPack, color: COLORS["入仓包材"], tag: "入仓" }] : []),
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
          : r.tag === "入仓" ? "入仓（入仓品卖到京东）：每袋运费 / 随货包材，已计入入仓成本"
          : r.tag ? "出库时按包装清单自动结算，已计入结转成本" : "销售商品本身的先进先出成本"}</td>
      </tr>`).join("")}</tbody>
      <tfoot><tr>
        <td><b>成本合计</b></td>
        <td class="num mono"><b>${fmtMoney(total)}</b></td>
        <td class="num mono">100%</td>
        <td class="muted">关联结算 ${fmtMoney(packTotal)}${wiCost ? ` · 入仓 ${fmtMoney(wiCost)}` : ""}${brush ? ` · 刷单 ${fmtMoney(brush)}` : ""}</td>
      </tr></tfoot>
    </table></div>
    ${packTotal || wiCost ? "" : `<div class="alert warn" style="margin-top:10px;">本期没有包材 / 人工 / 快递等关联结算成本。若商品已配置包装清单，请确认出库时是否生成了关联结算行。</div>`}`;
}
/* 利润桥：与「广告利润」页同一套口径，但本页不扣广告费。
   刷单成本单列成一行（不混进结转成本），所以每一行都能直接相加减，能一路对到净利润。 */
function renderReportBridge(rep) {
  const t = $("repBridge");
  if (!t) return;
  const rev = Number(rep.revenue) || 0;
  const pctOf = (v) => (rev ? ((Number(v) || 0) / rev * 100).toFixed(1) + "%" : "—");
  const rowOf = (name, value, desc, strong) => `<tr>
      <td>${strong ? `<strong>${esc(name)}</strong>` : esc(name)}</td>
      <td class="num mono"${strong ? ' style="font-weight:700;"' : ""}>${fmtMoney(value)}</td>
      <td class="num muted">${pctOf(value)}</td>
      <td class="muted">${desc}</td>
    </tr>`;
  const settle = Number(rep.settle_income) || 0;
  const wiRev = Number(rep.warehouse_in_revenue) || 0;
  const wiCogs = Number(rep.warehouse_in_cogs) || 0;
  const brush = Number(rep.brush_cost) || 0;
  const revDesc = `商品销售 ${fmtMoney(rev - settle - wiRev)}`
    + (settle ? ` · 客户代收关联结算 ${fmtMoney(settle)}` : "")
    + (wiRev ? ` · 入仓 ${fmtMoney(wiRev)}` : "");
  const costDesc = `商品成本 ${fmtMoney(rep.goods_cogs)}`
    + (Number(rep.pack_cost_total) ? ` · 关联结算 ${fmtMoney(rep.pack_cost_total)}` : "")
    + (wiCogs ? ` · 入仓成本 ${fmtMoney(wiCogs)}` : "");
  const otherDesc = rep.exclude_other_expense
    ? `已排除其他收支 ${fmtMoney(rep.excluded_other_expense)}`
    : `其他收支 ${fmtMoney(rep.other_expense)}`;
  const pend = rep.pending || {};
  const pendNote = [];
  if (pend.payables_count) pendNote.push(`待付款 ${pend.payables_count} 笔 ${fmtMoney(pend.payables_amount)}`);
  if (pend.receivables_count) pendNote.push(`待收款 ${pend.receivables_count} 笔 ${fmtMoney(pend.receivables_amount)}`);
  t.innerHTML = `<thead><tr><th>项目</th><th class="num">金额</th><th class="num">占收入</th><th>说明</th></tr></thead><tbody>`
    + rowOf("销售收入", rev, revDesc)
    + rowOf("结转成本", -(Number(rep.cogs) || 0), costDesc)
    + (Math.abs(brush) > 0.005 ? rowOf("刷单成本", -brush, "芳谊放单仓：刷单成本 + 快递包装固定费覆盖差") : "")
    + rowOf("毛利", Number(rep.gross_profit) || 0, "销售收入 − 结转成本" + (Math.abs(brush) > 0.005 ? " − 刷单成本" : ""), true)
    + rowOf("期间费用", -(Number(rep.expense) || 0), `手工记账 ${fmtMoney(rep.manual_expense)} · ${otherDesc}${adPrepayNote(rep)}`)
    + rowOf("净利润", Number(rep.net_profit) || 0, "毛利 − 期间费用", true)
    + `</tbody>`
    + (pendNote.length ? `<tfoot><tr><td colspan="4" class="muted">以上只含「已付款」单据；另有 ${pendNote.join(" · ")} 未计入，在「待付款账单」支付后按原日期转入。</td></tr></tfoot>` : "");
}

/* 收入构成：与「销售成本构成」对称，回答「赚的从哪来」——按渠道 + 按商品 TOP10 */
function renderRevenueBreakdown(rep) {
  const box = $("repRevBreak");
  if (!box) return;
  const hint = $("repRevHint");
  const revOf = (p) => (Number(p.amount) || 0) + (Number(p.settle_income) || 0);
  const rows = (rep.by_product || []).filter((p) => revOf(p) > 0.005);
  const total = rows.reduce((a, p) => a + revOf(p), 0);
  if (!total) {
    box.innerHTML = `<div class="empty">本期无销售收入</div>`;
    if (hint) hint.textContent = "";
    return;
  }
  const CH = [
    { name: "库存出库", color: "#0067c0" },
    { name: "代发", color: "#107c10" },
    { name: "入仓", color: "#ffb900" },
  ];
  const chOf = (p) => (p.is_warehouse_in ? "入仓" : (p.is_dropship ? "代发" : "库存出库"));
  const chSum = { "库存出库": 0, "代发": 0, "入仓": 0 };
  for (const p of rows) chSum[chOf(p)] += revOf(p);
  // 商品 TOP10：同名多规格合并（报表按「商品+规格」分行，这里看商品整体）
  const byName = new Map();
  for (const p of rows) {
    const nm = p.name || "（未命名）";
    const cur = byName.get(nm) || { name: nm, rev: 0, cogs: 0 };
    cur.rev += revOf(p);
    cur.cogs += Number(p.total_cogs != null ? p.total_cogs : p.cogs) || 0;
    byName.set(nm, cur);
  }
  const top = [...byName.values()].sort((a, b) => b.rev - a.rev).slice(0, 10);
  const pct = (v) => ((v / total) * 100).toFixed(1) + "%";
  const bar = (v, color) => `<div style="height:6px;background:var(--border-light, #f0f0f0);border-radius:3px;overflow:hidden;"><div style="width:${Math.max(0, Math.min(100, (v / total) * 100))}%;height:100%;background:${color};"></div></div>`;
  if (hint) hint.textContent = `合计 ${fmtMoney(total)} · ` + CH.map((c) => `${c.name} ${pct(chSum[c.name] || 0)}`).join(" / ");
  const topRev = top.reduce((a, p) => a + p.rev, 0);
  const topGp = top.reduce((a, p) => a + (p.rev - p.cogs), 0);
  box.innerHTML = `
    <div class="cost-stack">
      ${CH.filter((c) => chSum[c.name] > 0).map((c) => `<span title="${c.name} ${fmtMoney(chSum[c.name])}" style="width:${(chSum[c.name] / total) * 100}%;background:${c.color};"></span>`).join("")}
    </div>
    <div class="table-wrap"><table>
      <thead><tr><th>渠道</th><th class="num">收入</th><th class="num">占收入</th><th style="width:22%;">占比</th></tr></thead>
      <tbody>${CH.map((c) => `<tr>
        <td><span class="cost-dot" style="background:${c.color};"></span>${c.name}</td>
        <td class="num mono">${fmtMoney(chSum[c.name] || 0)}</td>
        <td class="num mono">${pct(chSum[c.name] || 0)}</td>
        <td>${bar(chSum[c.name] || 0, c.color)}</td>
      </tr>`).join("")}</tbody>
    </table></div>
    <div class="card-head" style="margin-top:16px;"><h3 style="font-size:14px;">商品 TOP 10（按收入）</h3><span class="muted">同名多规格已合并</span></div>
    <div class="table-wrap"><table>
      <thead><tr><th>商品</th><th class="num">收入</th><th class="num">占总收入</th><th class="num">毛利</th><th class="num">毛利率</th><th style="width:18%;">占比</th></tr></thead>
      <tbody>${top.map((p) => {
        const gp = p.rev - p.cogs;
        const color = gp >= 0 ? "var(--green)" : "var(--red)";
        return `<tr>
          <td>${esc(p.name)}</td>
          <td class="num mono">${fmtMoney(p.rev)}</td>
          <td class="num mono">${pct(p.rev)}</td>
          <td class="num mono" style="color:${color}">${fmtMoney(gp)}</td>
          <td class="num mono" style="color:${color}">${p.rev ? ((gp / p.rev) * 100).toFixed(1) + "%" : "—"}</td>
          <td>${bar(p.rev, "#0067c0")}</td>
        </tr>`;
      }).join("")}</tbody>
      <tfoot><tr><td><b>TOP10 合计</b></td>
        <td class="num mono"><b>${fmtMoney(topRev)}</b></td>
        <td class="num mono"><b>${pct(topRev)}</b></td>
        <td class="num mono"><b>${fmtMoney(topGp)}</b></td>
        <td class="num"></td><td class="num muted">共 ${byName.size} 个商品</td></tr></tfoot>
    </table></div>`;
}
/* 商品销售明细表：带「商品名称筛选」（与移动端财务报表同一套口径——名称 / 规格任一包含关键词即命中）。
   输入即过滤、点表头排序都只重渲染这张表，不再请求后端；筛选词在重新查询后保留。 */
let REP_PROD_ROWS = null;   // 最近一次报表的商品明细原始行（未筛选、未排序）

/* 出库方式：入仓（入仓品卖到京东）/ 代发（别人发货，不扣本仓库存）/ 库存出库。
   来源（后端 by_product.source）：手动出库 / 聚水潭出库 / 导入出库 / 入仓
   —— 手动建单没有导入分组；聚水潭导入的备注里带「聚水潭导入」。
   搜索栏输入「入仓」「代发」「库存」「手动」「聚水潭」都能筛出对应行。 */
const isWarehouseIn = (p) => !!p.is_warehouse_in;
const wayTextOf = (p) => (isWarehouseIn(p) ? "入仓" : (p.is_dropship ? "代发" : "库存出库"));
const wayBadgeOf = (p) => (isWarehouseIn(p)
  ? '<span class="badge pack">入仓</span>'
  : (p.is_dropship ? '<span class="badge income">代发</span>' : '<span class="badge adjust">库存出库</span>'));

function renderReportGoods() {
  const pt = $("repProductTable");
  if (!pt) return;
  const all = REP_PROD_ROWS || [];
  const kwEl = $("repGoodsKw");
  const kw = ((kwEl && kwEl.value) || "").trim();
  const kws = splitSearchKeywords(kw);
  // 关键词命中：商品名 / 规格 / 出库方式 / 来源（输入「入仓」「代发」「手动」「聚水潭」都能筛）
  const hit = kws.length ? all.filter((p) =>
    searchHit(`${p.name || ""} ${p.spec || ""} ${wayTextOf(p)} ${p.source || ""}`, kws)) : all;
  const prodRows = applyTableSort(pt, hit);
  const hint = $("repGoodsHint");
  if (hint) hint.textContent = all.length ? (kws.length ? `匹配 ${prodRows.length} / ${all.length} 个商品` : `共 ${all.length} 个商品`) : "";
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
  // 重量（kg）：后端给的是净重 kg（口径与出库结算快递费一致），保留 2 位；0 用「—」占位
  const fmtKg = (v) => { const n = Number(v) || 0; return n ? n.toFixed(2) : "—"; };
  if (!prodRows.length) {
    pt.innerHTML = `<tr><td class="empty" colspan="10">${all.length ? `没有匹配「${esc(kw)}」的商品，换个关键词试试` : "本期无销售"}</td></tr>`;
    pt._rows = [];
    pt._render = renderReportGoods;
    return;
  }
  const sum = prodRows.reduce((a, p) => {
    a.qty += Number(p.qty) || 0;
    a.weight += Number(p.weight_kg) || 0;
    a.amount += Number(p.amount) || 0;
    a.settle += settleOf(p);
    a.cogs += Number(p.total_cogs != null ? p.total_cogs : p.cogs) || 0;
    a.goods += Number(p.goods_cogs) || 0;
    return a;
  }, { qty: 0, weight: 0, amount: 0, settle: 0, cogs: 0, goods: 0 });
  const sumGp = sum.amount + sum.settle - sum.cogs;
  const sumColor = sumGp >= 0 ? "var(--green)" : "var(--red)";
  const sumRevenue = sum.amount + sum.settle;
  const sumGoodsRate = sumRevenue ? (sum.goods / sumRevenue) * 100 : null;
  pt.innerHTML = `<thead><tr>
    <th data-key="name">商品${sortArrow("repProductTable", "name")}</th>
    <th data-key="is_dropship">出库方式${sortArrow("repProductTable", "is_dropship")}</th>
    <th data-key="qty" class="num">销量${sortArrow("repProductTable", "qty")}</th>
    <th data-key="weight_kg" class="num">重量(kg)${sortArrow("repProductTable", "weight_kg")}</th>
    <th data-key="amount" class="num">收入${sortArrow("repProductTable", "amount")}</th>
    <th data-key="cogs" class="num">总成本${sortArrow("repProductTable", "cogs")}</th>
    <th data-key="goods_cogs" class="num" title="商品本身的货款成本，不含快递、人工、包材">商品成本${sortArrow("repProductTable", "goods_cogs")}</th>
    <th class="num" title="货款占比 = 商品成本 ÷ 收入">货款占比</th>
    <th data-key="gross" class="num">毛利${sortArrow("repProductTable", "gross")}</th>
    <th class="num">毛利率</th></tr></thead><tbody>` +
    prodRows.map((p) => {
      const total = Number(p.total_cogs != null ? p.total_cogs : p.cogs) || 0;
      const settle = settleOf(p);   // 客户代收的关联结算（包材/人工/快递费）：成本里含它，收入也要含
      const gp = (Number(p.amount) || 0) + settle - total;
      const color = gp >= 0 ? "var(--green)" : "var(--red)";
      // 商品成本（纯货款）与货款占比：占比分母用本行展示的收入（含客户代收的关联结算）
      const goods = Number(p.goods_cogs) || 0;
      const rowRevenue = (Number(p.amount) || 0) + settle;
      const goodsRate = rowRevenue ? (goods / rowRevenue) * 100 : null;
      // 成本构成：代发行也要列出来（代发成本/商品成本 ＋ 打包人工 ＋ 耗材 ＋ 其他关联结算 ＋ 快递费）
      const splitText = costSplitText(p);
      const split = splitText ? `<div class="muted" style="font-size:11px;">${splitText}</div>` : "";
      // 出库方式：入仓 / 代发（别人发货，不扣本仓库存）/ 库存出库；
      // 下面再标一行「来源」：手动出库 / 聚水潭出库 / 导入出库（一眼看出这行是哪来的）
      const way = wayBadgeOf(p);
      const srcText = (p.source || "").trim();
      const wayCell = way + (srcText ? `<div class="muted" style="font-size:11px;">${esc(srcText)}</div>` : "");
      // 规格：同一商品可能按不同规格分行（如「大香芋头4.5斤3-5个」与「4.5斤2-3个」），
      // 不显示规格时两行看起来就是重复，必须显式标出来
      const specText = (p.spec || "").trim()
        ? `<div class="muted" style="font-size:12px;">规格 ${esc(p.spec)}</div>` : "";
      return `<tr>
      <td>${esc(p.name)}${specText}${split}</td>
      <td>${wayCell}</td>
      <td class="num mono">${fmtNum(p.qty)}${p.unit ? esc(p.unit) : ""}</td>
      <td class="num mono">${fmtKg(p.weight_kg)}</td>
      <td class="num mono">${fmtMoney((Number(p.amount) || 0) + settle)}${settle ? `<div class="muted" style="font-size:11px;" title="客户随货款一起付的包材/人工/快递费（成本里已含，收入侧也计一笔）">含代收 ${fmtMoney(settle)}</div>` : ""}</td>
      <td class="num mono">${fmtMoney(total)}</td>
      <td class="num mono">${fmtMoney(goods)}</td>
      <td class="num muted">${goodsRate == null ? "—" : goodsRate.toFixed(1) + "%"}</td>
      <td class="num mono" style="color:${color}">${fmtMoney(gp)}</td>
      <td class="num mono" style="color:${color}">${gpRateOf(p)}</td></tr>`;
    }).join("") + `</tbody>
    <tfoot><tr>
      <td><b>${kws.length ? "筛选合计" : "本期合计"}</b> <span class="muted">${prodRows.length} 个商品</span></td>
      <td></td>
      <td class="num mono"><b>${fmtNum(sum.qty)}</b></td>
      <td class="num mono"><b>${fmtKg(sum.weight)}</b></td>
      <td class="num mono"><b>${fmtMoney(sum.amount + sum.settle)}</b>${sum.settle ? `<div class="muted" style="font-size:11px;">含代收 ${fmtMoney(sum.settle)}</div>` : ""}</td>
      <td class="num mono"><b>${fmtMoney(sum.cogs)}</b></td>
      <td class="num mono"><b>${fmtMoney(sum.goods)}</b></td>
      <td class="num mono"><b>${sumGoodsRate == null ? "—" : sumGoodsRate.toFixed(1) + "%"}</b></td>
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

/* 报表分区 tab：利润表 / 现金流量表 / 余额表 / 支出 / 商品 / 流水（日期条件常驻，作用于所有分区） */
const REP_PANELS = ["rep-panel-summary", "rep-panel-cash", "rep-panel-bal", "rep-panel-expense", "rep-panel-goods", "rep-panel-flow"];
function repTab(btn) {
  btn.closest(".seg").querySelectorAll(".seg-item").forEach((x) => x.classList.toggle("active", x === btn));
  const p = btn.dataset.panel;
  REP_PANELS.forEach((id) => { const el = $(id); if (el) el.style.display = id === p ? "" : "none"; });
  if (p === "rep-panel-cash") loadCashflow();   // 现金流按需加载，不拖慢默认的汇总页
}
/* 支出下钻（二级页面）：点「按日/按月」表里的日期或金额，展开该时段该来源的逐笔构成。
   数据直接用当前区间已加载的 REP_EXP_ITEMS，不再请求接口；key 为空表示整个查询区间（合计行）。 */
const REP_DRILL_SRC = { purchase: "采购", other: "其他收支", manual: "手工记账", brush: "刷单成本" };
const REP_SRC_TABS = [["", "全部来源"], ["采购", "采购（进货）"], ["其他收支", "其他收支"],
                      ["手工记账", "手工记账"], ["刷单成本", "刷单成本"]];
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

/* 支出统计（按日 / 按月）：其他收支 + 手工记账支出，合计即「期间费用」；不含采购支出 */
function repExpSwitch(btn) {
  $("repExpSeg").querySelectorAll(".seg-item").forEach((x) => x.classList.toggle("active", x === btn));
  const p = btn.dataset.panel;
  ["rep-exp-day", "rep-exp-month"].forEach((id) => { $(id).style.display = id === p ? "" : "none"; });
}
function renderExpenseTables(rep) {
  const days = rep.expense_by_day || [];
  const months = rep.expense_by_month || [];
  const purchase = rep.purchase || 0;                                  // 采购 / 进货
  const other = rep.other_expense || 0;                                // 其他收支
  const manual = rep.manual_expense || 0;                              // 手工记账
  const period = rep.expense || 0;                                     // 期间费用（从毛利中扣减）
  const brush = rep.brush_cost || 0;                                   // 刷单成本（放单仓刷单单）
  const total = rep.total_expense != null ? rep.total_expense : purchase + period + brush;  // 全部支出（含采购与刷单）
  const MAX_DAYS = 90;
  const sumCount = (rows) => rows.reduce((a, r) => a + (r.count || 0), 0);

  const hint = $("repExpHint");
  if (hint) {
    hint.textContent = total
      ? `按日 / 按月列出各项支出，合计 ${fmtMoney(total)} ＝ 采购 ＋ 其他收支 ＋ 手工记账 ＋ 刷单成本`
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
    cell(r.other_expense, "#f97316", keyOf(r), "other", "展开其他收支构成") +
    cell(r.manual_expense, "#6366f1", keyOf(r), "manual", "展开手工记账构成") +
    cell(r.brush_expense, "#e11d48", keyOf(r), "brush", "展开刷单成本构成（放单仓刷单单）") +
    `<td class="num mono"><b>${r.total ? drill(keyOf(r), "", fmtMoney(r.total), "展开全部支出明细") : "—"}</b></td>`;
  // 合计行：key 为空 = 整个查询区间
  const totalCells = (label, rows) =>
    `<tr><td><b>${label}</b></td>` +
    `<td class="num mono" style="color:#1989fa"><b>${drill("", "purchase", fmtMoney(purchase), "展开本期采购构成")}</b></td>` +
    `<td class="num mono" style="color:#f97316"><b>${drill("", "other", fmtMoney(other), "展开本期其他收支构成")}</b></td>` +
    `<td class="num mono" style="color:#6366f1"><b>${drill("", "manual", fmtMoney(manual), "展开本期手工记账构成")}</b></td>` +
    `<td class="num mono" style="color:#e11d48"><b>${drill("", "brush", fmtMoney(brush), "展开本期刷单成本明细")}</b></td>` +
    `<td class="num mono"><b>${drill("", "", fmtMoney(total), "展开本期全部支出明细")}</b></td>` +
    `<td></td><td class="num mono"><b>${sumCount(rows)}</b></td></tr>`;

  // 按日
  const dt = $("repExpDayTable");
  const dayRows = days.slice(0, MAX_DAYS);
  dt.innerHTML = `<thead><tr>
    <th>日期</th><th class="num">采购支出</th><th class="num">其他收支</th><th class="num">手工记账</th>
    <th class="num">刷单成本</th>
    <th class="num">支出合计</th><th class="num">占比</th><th class="num">笔数</th></tr></thead><tbody>` +
    (dayRows.length
      ? dayRows.map((r) => `<tr>
          <td class="mono">${drill(jsKey(r.date), "", esc(r.date), "展开当天全部支出明细")}</td>${amountCells(r)}
          <td class="num">${bar(r.total)}<span class="muted">${pctOf(r.total).toFixed(1)}%</span></td>
          <td class="num mono">${r.count}</td></tr>`).join("")
      : `<tr><td colspan="8" class="empty">${emptyText}</td></tr>`) +
    `</tbody>` +
    (days.length ? `<tfoot>${totalCells(`合计（${days.length} 天 · ${sumCount(days)} 笔）`, days)}</tfoot>` : "");

  // 按月（多一列环比：与上个月比）
  const mt = $("repExpMonthTable");
  mt.innerHTML = `<thead><tr>
    <th>月份</th><th class="num">采购支出</th><th class="num">其他收支</th><th class="num">手工记账</th>
    <th class="num">刷单成本</th>
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
      : `<tr><td colspan="8" class="empty">${emptyText}</td></tr>`) +
    `</tbody>` +
    (months.length ? `<tfoot>${totalCells(`合计（${months.length} 个月 · ${sumCount(months)} 笔）`, months)}</tfoot>` : "");
}

/* 支出逐笔明细：采购 / 其他收支 / 手工记账 / 刷单成本，逐条列出（与「支出合计」同口径） */
const REP_EXP_SRC_COLORS = { "采购": "#1989fa", "其他收支": "#f97316", "手工记账": "#6366f1", "刷单成本": "#e11d48" };
let REP_EXP_ITEMS = [];
let REP_EXP_API_OK = true;
let REP_EXP_WITH_WH = false;   // 全仓总览：逐笔明细来自多个分仓，需要显示来源分仓列

function renderExpenseItems(rep) {
  REP_EXP_ITEMS = rep.expense_items || [];
  REP_EXP_API_OK = Array.isArray(rep.expense_items);   // 后端未升级时给出明确提示，避免"看着是空的"
  REP_EXP_WITH_WH = !!rep.is_all;
  const sel = $("repExpItemSrc");
  if (sel) sel.value = "";   // 换区间后重置筛选，避免"看不到数据"的困惑
  // 已排除其他收支时，逐笔明细里不会有该来源，把筛选项置灰并说明原因
  const optOther = sel ? sel.querySelector('option[value="其他收支"]') : null;
  if (optOther) {
    optOther.disabled = !!rep.exclude_other_expense;
    optOther.textContent = rep.exclude_other_expense ? "其他收支（已排除）" : "其他收支";
  }
  const kw = $("repExpItemSearch");
  if (kw) kw.value = "";
  renderExpenseItemRows();
}

function renderExpenseItemRows() {
  const t = $("repExpItemTable");
  if (!t) return;
  const src = ($("repExpItemSrc") || {}).value || "";
  const kws = splitSearchKeywords(($("repExpItemSearch") || {}).value);
  const withWh = REP_EXP_WITH_WH;
  let rows = REP_EXP_ITEMS;
  if (src) rows = rows.filter((r) => r.source === src);
  if (kws.length) {
    rows = rows.filter((r) =>
      searchHit([r.date, r.source, r.category, r.item, r.remark, r.operator, r.ref, r.warehouse].join(" "), kws));
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

/* 支出汇总：采购（进货）+ 其他收支 + 手工记账 = 全部支出；期间费用才是从毛利中扣减的部分 */
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

  const brush = rep.brush_cost || 0;           // 刷单成本：快递+包装固定费 + 刷单成本（已在毛利里扣过）
  const brushFee = rep.brush_fee_cost || 0;    // 其中「快递+包装固定费」（逐单手填，默认 3.6）
  const brushInput = rep.brush_input_cost || 0; // 其中「我填的刷单成本」原值
  const rows = [
    { name: "采购支出（进货）", value: purchase, color: "#1989fa", desc: "入库 / 进货金额（与「本期进货」同源，含入库运费/装卸费/手续费），已计入结转成本" },
    { name: "其他收支", value: other, color: "#f97316", desc: "网线费 / 安装费 / 机器费 / 样品费等（构成见下表）" },
    { name: "手工记账", value: manual, color: "#6366f1", desc: "财务流水里登记的支出（构成见下表）" },
    { name: "刷单成本", value: brush, color: "#e11d48", desc: "芳谊放单仓刷单单：快递+包装固定费 ＋ 刷单成本（逐单见「支出明细 / 来源=刷单成本」），已从毛利扣减，不重复计入期间费用" },
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
        <td class="muted">＝ 采购 ＋ 其他收支 ＋ 手工记账 ＋ 刷单成本</td></tr>
      <tr>
        <td>其中：期间费用</td>
        <td class="num mono">${fmtMoney(period)}</td>
        <td class="num mono">${pctOf(period).toFixed(1)}%</td>
        <td class="muted">其他收支 ＋ 手工记账；<b>毛利 − 期间费用 = 净利</b>（采购已计入结转成本、刷单成本已在毛利里扣过，都不重复扣）</td></tr>
      ${brush ? `<tr>
        <td>其中：刷单成本</td>
        <td class="num mono">${fmtMoney(brush)}</td>
        <td class="num mono">${pctOf(brush).toFixed(1)}%</td>
        <td class="muted">快递+包装固定费 ${fmtMoney(brushFee)} ＋ 刷单成本 ${fmtMoney(brushInput)}（放单仓刷单单，逐单可在「支出明细」按来源筛出）</td></tr>` : ""}
    </tfoot>`;
}

/* 期间费用构成明细：其他收支（按类型）+ 手工记账（按类别） */
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
    ...Object.entries(others).map(([name, v]) => ({ name, value: Number(v) || 0, src: "其他收支" })),
    ...Object.entries(manuals).map(([name, v]) => ({ name, value: Number(v) || 0, src: "手工记账" })),
  ].sort((a, b) => b.value - a.value);

  if (!rows.length) {
    box.innerHTML = `<div class="block-title">期间费用构成（从毛利中扣减）</div>
      <div class="empty">本期无期间费用。其他收支请到「经营分析 → 其他收支」登记；手工记账见「流水」tab 的「＋ 手动记账」</div>`;
    return;
  }
  const pctOf = (v) => (total ? (v / total) * 100 : 0);
  const COLORS = { "其他收支": "#f97316", "手工记账": "#6366f1" };
  box.innerHTML = `
    <div class="block-title">期间费用构成（其他收支 ＋ 手工记账，从毛利中扣减）</div>
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
        <td class="muted">其他收支 ${fmtMoney(otherTotal)} + 手工记账 ${fmtMoney(manualTotal)}</td>
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
  if (!(await uiConfirm("确认删除该手动财务记录？"))) return;
  try { await api("/api/finance/" + id, "DELETE"); toast("已删除"); loadReport(); }
  catch (e) { toast("失败：" + e.message); }
}

/* =============== 其他收支（仓库零散支出/收入：网线费 / 安装费 / 供应商补偿 …） ===============
   数据上收入 = 负数的 OtherExpense（如入库单「供应商补偿」镜像行、手工登记的其他收入），
   页面用「其他支出 / 其他收入」两个页签按正负分开看；报表期间费用按净额扣减。 */
let OE_ROWS = [];       // 当前区间的收支明细
let OE_STATS = null;    // 当前区间的统计（今日/本月/区间/按日/按月/按类型，净额）
let OE_EDIT_ID = null;  // 正在修改的记录 id；null = 新增
let OE_SCOPE = "expense";  // 当前页签：expense 其他支出 / income 其他收入（登记与列表都跟随它）
let oeInited = false;

/** 切「其他支出 / 其他收入」页签（页面顶部）：登记表单、统计、明细整页跟随 */
function oeScope(btn) {
  $("oeScopeSeg").querySelectorAll(".seg-item").forEach((x) => x.classList.toggle("active", x === btn));
  const next = btn.dataset.scope === "income" ? "income" : "expense";
  if (next === OE_SCOPE) return;
  OE_SCOPE = next;
  if (OE_EDIT_ID) oeResetForm();   // 换页签时若正在编辑，先收起（避免支出表单改成收入记录）
  oeApplyScope();
  loadOtherExpensePage();          // 后端按支出/收入分别返回，统计与明细整页跟随
}

/** 登记表单跟随页签：标题 / 保存按钮文案 / 付款状态（收入立即到账，不进待付款账单） */
function oeApplyScope() {
  const income = OE_SCOPE === "income";
  const title = $("oeFormTitle");
  if (title) title.textContent = income ? "登记其他收入" : "登记其他支出";
  const btn = $("oeSaveBtn");
  if (btn) btn.textContent = income ? "✓ 保存收入" : "✓ 保存开支";
  const payField = $("oePayField");
  if (payField) payField.style.display = income ? "none" : "";
  // 手续费只针对「转出去」的开支，收入侧不填（后端也会把它归 0）
  const feeField = $("oeFeeField");
  if (feeField) feeField.style.display = income ? "none" : "";
  const cat = $("oeCategory");
  if (cat) cat.placeholder = income ? "如：供应商补偿 / 返利 / 赔偿" : "如：网线费";
  const hint = $("oeScopeHint");
  if (hint) hint.textContent = income
    ? "当前：其他收入 —— 下方登记 / 统计 / 明细都只看收入（含入库单带出的供应商补偿）"
    : "当前：其他支出 —— 下方登记 / 统计 / 明细都只看支出";
}

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
    // 默认跟随财务报表查过的区间，两边对得上账；没存过默认最近 7 天
    const saved = savedReportRange();
    if (!$("oeDateFrom").value) $("oeDateFrom").value = saved ? saved[0] : daysAgo(6);
    if (!$("oeDateTo").value) $("oeDateTo").value = saved ? saved[1] : today();
  }
  if ($("oeOperator")) $("oeOperator").value = operatorName();
  const from = $("oeDateFrom").value, to = $("oeDateTo").value;
  const kindQ = `&kind=${OE_SCOPE}`;   // expense/income：后端按口径过滤并计算，整页只看一边
  try {
    const [rows, stats] = await Promise.all([
      api(`/api/other-expenses?date_from=${from || ""}&date_to=${to || ""}${kindQ}`),
      api(`/api/other-expenses/stats?date_from=${from || ""}&date_to=${to || ""}${kindQ}`),
    ]);
    OE_ROWS = rows;
    OE_STATS = stats;
    renderOeStats(stats);
    renderOeTables(stats);
    oeFillCategories(stats);
    renderOtherExpenseList();
  } catch (e) { toast("加载其他收支失败：" + e.message); }
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
  const income = OE_SCOPE === "income";
  const label = income ? "收入" : "支出";
  const top = (s.by_category || [])[0];
  $("oeStats").innerHTML = `
    <div class="stat ${income ? "green" : "red"}"><div class="label">今日${label}</div><div class="value">${fmtMoney(s.today_total)}</div><div class="sub">${esc(s.today)}</div></div>
    <div class="stat ${income ? "green" : "red"}"><div class="label">本月${label}</div><div class="value">${fmtMoney(s.month_total)}</div><div class="sub">${esc(s.month)} 月合计</div></div>
    <div class="stat amber"><div class="label">区间${label}合计</div><div class="value">${fmtMoney(s.range_total)}</div><div class="sub">${s.range_count} 笔 · 日均 ${fmtMoney(s.range_daily_avg)}</div></div>
    <div class="stat"><div class="label">区间天数</div><div class="value">${s.range_days || 0}</div><div class="sub">最大类型：${top ? esc(top.category) + " " + fmtMoney(top.amount) : "—"}</div></div>`;
  const scope = `统计区间 ${s.date_from || "最早"} ~ ${s.date_to || "至今"}`;
  $("oeStatsHint").textContent = income
    ? `${scope} · 仅统计其他收入（含入库单带出的供应商补偿；支出请切到顶部「其他支出」）`
    : `${scope} · 仅统计其他支出（其他收入请切到顶部「其他收入」）`;
  $("oeListHint").textContent = `${scope} · ${label}合计 ${fmtMoney(s.range_total)}`;
}

function renderOeTables(s) {
  const income = OE_SCOPE === "income";
  const label = income ? "收入" : "支出";
  const color = income ? "var(--green)" : "var(--red)";
  const barCls = income ? "up" : "down";       // 收入柱绿色、支出柱红色
  const empty = `该区间暂无${label}`;
  // 按日：柱状图 + 明细表
  const days = s.by_day || [];
  const box = $("oeChart");
  if (!days.length) {
    box.innerHTML = `<div class="mv-chart-title">${empty}</div>`;
  } else {
    const max = Math.max(1, ...days.map((d) => Math.abs(d.amount)));
    const ordered = [...days].reverse();  // 图表按时间正序
    box.innerHTML = `<div class="mv-chart-title">每日${label}（元，共 ${days.length} 天有${label}）</div><div class="mv-chart">` +
      ordered.map((d) => `<div class="mv-col" title="${d.date}：${fmtMoney(d.amount)}（${d.count} 笔）">
        <span class="mv-val">${Math.round(d.amount)}</span>
        <div class="mv-track"><div class="mv-bar ${barCls}" style="height:${Math.max(2, Math.round((Math.abs(d.amount) / max) * 100))}%"></div></div>
        <div class="mv-x">${d.date.slice(5)}</div></div>`).join("") + `</div>`;
  }
  const dt = $("oeDayTable");
  dt.innerHTML = `<thead><tr><th>日期</th><th class="num">笔数</th><th class="num">金额</th></tr></thead><tbody>` +
    (days.length
      ? days.map((d) => `<tr><td class="mono">${d.date}</td><td class="num mono">${d.count}</td>
          <td class="num mono" style="color:${color}">${fmtMoney(d.amount)}</td></tr>`).join("") +
        `<tr><td><b>合计</b></td><td class="num mono"><b>${s.range_count}</b></td><td class="num mono"><b>${fmtMoney(s.range_total)}</b></td></tr>`
      : `<tr><td colspan="3" class="empty">${empty}</td></tr>`) + `</tbody>`;

  const months = s.by_month || [];
  const mt = $("oeMonthTable");
  // 环比颜色：支出涨=红（花得多），收入涨=绿（收得多）
  const upColor = income ? "var(--green)" : "var(--red)";
  const downColor = income ? "var(--red)" : "var(--green)";
  mt.innerHTML = `<thead><tr><th>月份</th><th class="num">笔数</th><th class="num">金额</th><th class="num">环比</th></tr></thead><tbody>` +
    (months.length
      ? months.map((m, i) => {
        const prev = months[i + 1];  // 倒序排列，下一项即上一个月
        const delta = prev && prev.amount ? ((m.amount - prev.amount) / Math.abs(prev.amount)) * 100 : null;
        const txt = delta == null ? "—" : `${delta >= 0 ? "+" : ""}${delta.toFixed(1)}%`;
        const dcolor = delta == null ? "var(--muted)" : delta >= 0 ? upColor : downColor;
        return `<tr><td class="mono">${m.month}</td><td class="num mono">${m.count}</td>
          <td class="num mono" style="color:${color}">${fmtMoney(m.amount)}</td>
          <td class="num mono" style="color:${dcolor}">${txt}</td></tr>`;
      }).join("") +
        `<tr><td><b>合计</b></td><td class="num mono"><b>${s.range_count}</b></td><td class="num mono"><b>${fmtMoney(s.range_total)}</b></td><td></td></tr>`
      : `<tr><td colspan="4" class="empty">${empty}</td></tr>`) + `</tbody>`;

  const cats = s.by_category || [];
  const pct = (v) => (s.range_total ? (v / s.range_total) * 100 : 0);
  const ct = $("oeCatTable");
  ct.innerHTML = `<thead><tr><th>${income ? "收入类型" : "费用类型"}</th><th class="num">笔数</th><th class="num">金额</th><th class="num">占比</th></tr></thead><tbody>` +
    (cats.length
      ? cats.map((c) => `<tr><td><span class="badge ${income ? "income" : "expense"}">${esc(c.category)}</span></td><td class="num mono">${c.count}</td>
          <td class="num mono" style="color:${color}">${fmtMoney(c.amount)}</td><td class="num mono">${pct(c.amount).toFixed(1)}%</td></tr>`).join("") +
        `<tr><td><b>合计</b></td><td class="num mono"><b>${s.range_count}</b></td><td class="num mono"><b>${fmtMoney(s.range_total)}</b></td><td class="num mono">100%</td></tr>`
      : `<tr><td colspan="4" class="empty">${empty}</td></tr>`) + `</tbody>`;
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
  const income = OE_SCOPE === "income";
  const cat = $("oeFilterCat").value;
  const kws = splitSearchKeywords($("oeSearch").value);
  // 支出页签看正数（开支），收入页签看负数（供应商补偿 / 手工登记的其他收入，显示为正数金额）
  let rows = OE_ROWS.filter((r) => (income ? (Number(r.amount) || 0) < 0 : (Number(r.amount) || 0) >= 0));
  if (cat) rows = rows.filter((r) => r.category === cat);
  if (kws.length) rows = rows.filter((r) => searchHit([r.category, r.remark, r.operator, r.date].join(" "), kws));
  const t = $("oeTable");
  t.innerHTML = `<thead><tr>
    <th>日期</th><th>费用类型</th><th class="num">金额</th><th>操作员</th><th>备注</th><th style="width:120px;"></th></tr></thead><tbody>` +
    (rows.length
      ? rows.map((r) => {
        const neg = (Number(r.amount) || 0) < 0;    // 收入行（存负数）
        const amt = neg ? -Number(r.amount) : Number(r.amount);
        const fee = Math.abs(Number(r.fee) || 0);   // 其中转账手续费（已含在 amt 里）
        const badge = neg ? "income" : "expense";
        return `<tr>
        <td class="mono">${esc(r.date)}</td>
        <td><span class="badge ${badge}">${esc(r.category)}</span>${payTag(r.pay_status)}${r.ref_type ? ` <span class="badge${r.ref_type === "inbound_fee" ? " pack" : ""}" title="${r.ref_type === "inbound_fee" ? "入库单带出的运费/装卸费/手续费：已计入该批次成本（随销量在毛利中扣减），这里留档备查，报表期间费用不再重复扣" : r.ref_type === "inbound_comp" ? "入库单带出的供应商补偿：冲减期间费用、计入财务报表净利" : "单据自动带出的金额调整，只影响开支、不改成本"}">来自${r.ref_type === "inbound_fee" ? "入库单·成本" : r.ref_type === "inbound_comp" ? "入库单·补偿" : r.ref_type === "inbound" ? "入库单" : "出库单"}</span>` : ""}</td>
        <td class="num mono" style="color:${neg ? "var(--green)" : "var(--red)"}">${neg ? "+" : ""}${fmtMoney(amt)}${fee ? `<div class="muted" style="font-size:11px;font-weight:400;">含手续费 ${fmtMoney(fee)}</div>` : ""}</td>
        <td>${esc(r.operator) || "—"}</td>
        <td class="muted" style="max-width:260px;">${renderRemarkHtml(r.remark)}</td>
        <td>${r.ref_type
          ? `<span class="muted" style="font-size:12px;">随单据自动维护</span>`
          : `<button class="btn sm secondary" onclick="oeEdit(${r.id})">改</button>
             <button class="btn sm danger" onclick="oeDelete(${r.id})">删</button>`}</td></tr>`;
      }).join("")
      : `<tr><td colspan="6" class="empty">${income ? "该区间暂无其他收入（入库单的「供应商补偿」会自动出现在这里）" : "该区间暂无支出，先在上方登记一笔"}</td></tr>`) + `</tbody>`;
  const sum = rows.reduce((a, r) => a + Math.abs(Number(r.amount) || 0), 0);
  $("oeListSum").textContent = `共 ${rows.length} 笔 · ${income ? "收入" : "支出"}合计 ${fmtMoney(sum)}`;
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
  $("oeFee").value = "";
  $("oeDate").value = today();
  setPay("oePay", "paid");
  clearRemarkField("oeRemark");
  oeApplyScope();
  oeSyncTotal();
  oeAlertMsg("");
}

/* 金额 + 手续费 = 这笔开支实际入账的钱，边填边提示，避免以为手续费没算进去 */
function oeSyncTotal() {
  const hint = $("oeTotalHint");
  if (!hint) return;
  if (OE_SCOPE === "income") { hint.textContent = "转账手续费并入这笔开支，金额填「转出金额」即可"; return; }
  const amt = +$("oeAmount").value || 0, fee = +$("oeFee").value || 0;
  hint.textContent = fee
    ? `合计入账 ${fmtMoney(amt + fee)} = 金额 ${fmtMoney(amt)} + 手续费 ${fmtMoney(fee)}`
    : "转账手续费并入这笔开支，金额填「转出金额」即可";
}

function oeEdit(id) {
  const r = OE_ROWS.find((x) => x.id === id);
  if (!r) return;
  OE_EDIT_ID = id;
  // 收入行（负数）编辑时自动切到「其他收入」页签，金额按正数填
  OE_SCOPE = (Number(r.amount) || 0) < 0 ? "income" : "expense";
  $("oeScopeSeg").querySelectorAll(".seg-item").forEach((x) => x.classList.toggle("active", x.dataset.scope === OE_SCOPE));
  $("oeCategory").value = r.category;
  // 库里 amount 已含手续费，回填时拆回「转出金额 + 手续费」两个框
  const fee = Math.abs(Number(r.fee) || 0);
  $("oeAmount").value = Math.round((Math.abs(Number(r.amount) || 0) - fee) * 100) / 100;
  $("oeFee").value = fee || "";
  $("oeDate").value = r.date;
  setRemarkValue("oeRemark", r.remark);   // 已有附件拆到标签区，文本框只留纯文本
  setPay("oePay", r.pay_status);
  oeApplyScope();
  oeSyncTotal();
  $("oeSaveBtn").textContent = "✓ 保存修改";
  oeAlertMsg(`正在修改 ${r.date}「${r.category}」${fmtMoney(Math.abs(Number(r.amount) || 0))}${fee ? `（含手续费 ${fmtMoney(fee)}）` : ""}（保存后覆盖原记录）`);
  if (typeof openDrawer === "function") openDrawer("oeDrawer");
  $("oeCategory").focus();
}

async function oeSubmit() {
  const category = ($("oeCategory").value || "").trim();
  const amount = +$("oeAmount").value;
  const income = OE_SCOPE === "income";
  const fee = income ? 0 : (+($("oeFee").value) || 0);
  const date = $("oeDate").value;
  if (!category) { oeAlertMsg(income ? "请填写收入类型（如 供应商补偿 / 返利）" : "请填写费用类型（如 网线费 / 安装费 / 机器费 / 样品费）"); return; }
  if (!(amount > 0)) { oeAlertMsg("金额必须大于 0"); return; }
  if (fee < 0) { oeAlertMsg("手续费不能是负数"); return; }
  if (!date) { oeAlertMsg("请选择日期"); return; }
  const payStatus = income ? "paid" : payOf("oePay");
  // 手续费是这笔开支的一部分：入库金额 = 转出金额 + 手续费，fee 单独存一份供明细查看
  const total = Math.round((amount + fee) * 100) / 100;
  const body = { category, amount: total, fee, date, remark: remarkValue("oeRemark"), pay_status: payStatus, kind: OE_SCOPE };
  const editing = !!OE_EDIT_ID;
  try {
    if (editing) await api("/api/other-expenses/" + OE_EDIT_ID, "PUT", body);
    else await api("/api/other-expenses", "POST", body);
    // 若该日期不在当前统计区间内，自动把区间扩到能看见它（避免"保存了却看不到"）
    if ($("oeDateFrom").value && date < $("oeDateFrom").value) $("oeDateFrom").value = date;
    if ($("oeDateTo").value && date > $("oeDateTo").value) $("oeDateTo").value = date;
    const tail = (!income && payStatus === "unpaid") ? "（待付款，已进待付款账单）" : "";
    toast((editing ? "已保存修改" : `已登记${income ? "收入" : "开支"} ${category} ${fmtMoney(total)}${fee ? `（含手续费 ${fmtMoney(fee)}）` : ""}`) + tail);
    oeResetForm();
    if (typeof closeDrawer === "function") closeDrawer("oeDrawer");
    await loadOtherExpensePage();
  } catch (e) { oeAlertMsg("保存失败：" + e.message); }
}

async function oeDelete(id) {
  const r = OE_ROWS.find((x) => x.id === id);
  if (!(await uiConfirm(r ? `确认删除 ${r.date}「${r.category}」${fmtMoney(r.amount)}？` : "确认删除该开支记录？"))) return;
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
const PAY_SRC_BADGE = { "入库": "in", "入仓": "income", "出库": "out", "其他收支": "expense", "手动记账": "adjust", "代发": "pack" };

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
  const kws = splitSearchKeywords(f.kwRaw);
  let rows = PAY_ROWS;
  if (kws.length) {
    rows = rows.filter((r) =>
      searchHit([r.date, r.source, r.title, r.sub, r.code, r.remark, r.operator].join(" "), kws));
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
  return { rows, undated, active: !!(kws.length || f.from || f.to), f };
}

/** 筛选结果实时合计：笔数 + 总金额（应付 + 应收）+ 已结清拆分；关键词 / 日期一变就重算 */
function renderPaySum(rows, undated, active, f) {
  const el = $("paySum");
  if (!el) return;
  const outSum = rows.filter((r) => r.direction !== "in").reduce((a, r) => a + r.amount, 0);
  const inSum = rows.filter((r) => r.direction === "in").reduce((a, r) => a + r.amount, 0);
  // 已结清的行同样按结清金额参与汇总（后端对已结清单据返回结清值，不是剩余 0）
  const paidRows = rows.filter((r) => (r.pay_status || "paid") === "paid");
  const paidSum = paidRows.reduce((a, r) => a + (r.amount || 0), 0);
  const range = (f.from || f.to) ? `${f.from || "最早"} ~ ${f.to || "最新"}` : "";
  const cond = [range ? `日期 ${range}` : "", f.kwRaw ? `关键词「${f.kwRaw}」` : ""].filter(Boolean).join(" + ");
  el.innerHTML =
    `<span class="pay-sum-label">${active ? "筛选结果" : "当前列表"}</span>` +
    `<span><b>${rows.length}</b> 笔${rows.length === PAY_ROWS.length ? "" : ` <span class="muted">/ 共 ${PAY_ROWS.length} 笔</span>`}</span>` +
    `<span class="pay-sum-total">合计${paidRows.length ? "（含已结清）" : ""} <b class="mono">${fmtMoney(outSum + inSum)}</b></span>` +
    `<span class="muted">应付 <b class="mono" style="color:var(--danger, #dc2626);">${fmtMoney(outSum)}</b>`
    + ` ／ 应收 <b class="mono" style="color:var(--green, #16a34a);">${fmtMoney(inSum)}</b></span>` +
    (paidRows.length
      ? `<span class="muted">已结清 <b>${paidRows.length}</b> 笔 <b class="mono" style="color:var(--green, #16a34a);">${fmtMoney(paidSum)}</b></span>`
      : "") +
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
  const paidOut = t.paid_payables_amount || 0;
  const paidIn = t.paid_receivables_amount || 0;
  box.innerHTML = `
    <div class="stat red"><div class="label">待付款（应付）</div><div class="value">${fmtMoney(payable)}</div><div class="sub">要付出去的钱</div></div>
    <div class="stat"><div class="label">待收款（应收）</div><div class="value">${fmtMoney(recv)}</div><div class="sub">要收进来的钱</div></div>
    <div class="stat amber"><div class="label">待结清笔数</div><div class="value">${t.unpaid_count || 0}</div><div class="sub">合计 ${fmtMoney(payable + recv)}</div></div>
    <div class="stat"><div class="label">最近已结清</div><div class="value">${t.paid_count || 0}</div><div class="sub">应付 ${fmtMoney(paidOut)} ／ 应收 ${fmtMoney(paidIn)}（最近 30 天，可撤销）</div></div>`;
}

function renderPayables() {
  const t = $("payTable");
  if (!t) return;
  const { rows, undated, active, f } = payFilterRows();
  paySyncDatePh();
  // 已结清的行按结清金额单独汇总（后端口径：已结清返回结清值，不是剩余 0）
  const settledRows = rows.filter((r) => (r.pay_status || "paid") === "paid");
  const settledSum = settledRows.reduce((a, r) => a + (r.amount || 0), 0);
  t.innerHTML = `<thead><tr>
      <th style="width:34px;"><input type="checkbox" onchange="payToggleAll(this)" /></th>
      <th style="width:102px;">日期</th><th style="width:96px;">来源</th><th>具体事物 / 款项</th>
      <th class="num" style="width:150px;">金额</th><th style="width:88px;">操作员</th><th style="width:180px;"></th>
    </tr></thead><tbody>` +
    (rows.length
      ? rows.map((r) => {
        const paid = (r.pay_status || "paid") === "paid";   // 部分付款还没结清，仍按待办展示
        const color = r.direction === "in" ? "var(--green, #16a34a)" : "var(--danger, #dc2626)";
        const money = `${r.direction === "in" ? "应收" : "应付"} ${fmtMoney(r.amount)}`;
        return `<tr${paid ? ' style="opacity:.55;"' : ""}>
          <td><input type="checkbox" class="pay-pick" value="${esc(r.kind)}|${r.id}" /></td>
          <td class="mono">${esc(r.date)}</td>
          <td><span class="badge ${PAY_SRC_BADGE[r.source] || "adjust"}">${esc(r.source)}</span></td>
          <td><b>${esc(r.title)}</b>${r.code ? ` <span class="muted">${esc(r.code)}</span>` : ""}${payTag(r.partial ? "partial" : r.pay_status)}
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
            ／ 应收 ${fmtMoney(rows.filter((r) => r.direction === "in").reduce((a, r) => a + r.amount, 0))}</b>
            ${settledRows.length ? `<div class="muted" style="font-size:12px;font-weight:400;">其中已结清 ${settledRows.length} 笔 ${fmtMoney(settledSum)}</div>` : ""}</td>
          <td colspan="2"></td></tr></tfoot>`
      : "");
  renderPaySum(rows, undated, active, f);
}

/* ---------- 已支付确认弹窗（可顺手记一笔转账手续费 → 其他收支） ---------- */
let PAY_MODAL_OK = null;   // 当前弹窗「确认」后要执行的动作（fee, date）=> Promise

function openPayModal({ title, label, note, onOk }) {
  PAY_MODAL_OK = onOk;
  openModal(`
    <h3>${title} <button class="close" onclick="closeModal()">✕</button></h3>
    <div style="margin-bottom:8px;">${label}</div>
    ${note ? `<div class="muted" style="font-size:12.5px;margin-bottom:12px;">${note}</div>` : ""}
    <div class="form-grid">
      <div class="field">
        <label>转账手续费（选填）</label>
        <input id="payFee" type="number" min="0" step="any" placeholder="0.00" oninput="payFeeCalc()" />
        <div class="field-hint">部分转款会产生手续费：填了会自动记一笔「其他收支 → 手续费」（已付款），计入财务报表期间费用</div>
      </div>
      <div class="field">
        <label>手续费入账日期</label>
        <input id="payFeeDate" type="date" value="${today()}" onchange="payFeeCalc()" />
        <div class="field-hint">一般就是付款当天；不填手续费可以不管它</div>
      </div>
    </div>
    <p class="hint" id="payFeeTip"></p>
    <div class="modal-foot">
      <button class="btn secondary" onclick="closeModal()">取消</button>
      <button class="btn green" onclick="payModalSubmit()">✓ 确认已支付</button>
    </div>`);
  payFeeCalc();
  const el = $("payFee");
  if (el) el.focus();
}

/** 手续费输入实时提示（记到哪、多少钱） */
function payFeeCalc() {
  const tip = $("payFeeTip");
  if (!tip) return;
  const fee = parseFloat(($("payFee") || {}).value) || 0;
  const day = ($("payFeeDate") || {}).value || today();
  tip.innerHTML = fee > 0
    ? `将自动记一笔其他收支：<b>手续费 ¥${fmtMoney(fee)}</b>（${esc(day)}，已付款）`
    : "不收手续费就留空，不影响记账。";
}

async function payModalSubmit() {
  const ok = PAY_MODAL_OK;
  if (!ok) return;
  const fee = parseFloat(($("payFee") || {}).value) || 0;
  if (fee < 0) { toast("手续费不能为负数"); return; }
  const day = ($("payFeeDate") || {}).value || today();
  PAY_MODAL_OK = null;
  closeModal();
  await ok(fee, day);
}

/** 标记已支付/撤销：支付时弹窗可填手续费；支付后按原日期纳入财务报表，撤销则移出 */
async function payBill(kind, id, paid) {
  const r = PAY_ROWS.find((x) => x.kind === kind && x.id === id);
  const plain = r ? `${r.source}「${r.title}」${fmtMoney(r.amount)}` : "";
  const label = r ? `<b>${esc(r.source)}</b>「${esc(r.title)}」<b class="mono">${fmtMoney(r.amount)}</b>` : "";
  const isDs = kind === "dropship" || kind === "dropship_item";
  if (!paid) {
    if (!(await uiConfirm(`确认撤销？\n${plain}\n${isDs ? "（只撤销付款核对标记）" : "撤销后它会移出财务报表，回到待付款账单。"}`))) return;
    return submitPayDoc({ kind, id, paid: false, fee: 0 });
  }
  openPayModal({
    title: "确认已支付",
    label,
    note: isDs
      ? "代发成本只做付款核对、不影响报表的收入成本；手续费照常记入「其他收支」。"
      : "确认后这笔将按原日期计入财务报表。",
    onOk: (fee, day) => submitPayDoc({ kind, id, paid: true, fee, date: day }),
  });
}

async function submitPayDoc({ kind, id, paid, fee, date }) {
  const isDs = kind === "dropship" || kind === "dropship_item";
  try {
    const r = await api("/api/payables/pay", "POST", { kind, id, paid, fee, date });
    const tail = r && r.fee ? `；手续费 ¥${fmtMoney(r.fee)} 已记「其他收支」` : "";
    toast((paid
      ? (isDs ? "已标记代发成本已支付" : "已标记已支付，已按原日期计入财务报表")
      : (isDs ? "已撤销付款标记" : "已撤销，已移出财务报表")) + tail);
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

/** 批量标记已支付 / 撤销：支付时弹窗可填手续费（整批只记一笔），按 kind 分组提交 */
async function payBatch(paid) {
  const picked = payPicked();
  if (!picked.length) { toast("请先勾选要处理的账单"); return; }
  const amount = picked.reduce((a, p) => {
    const r = PAY_ROWS.find((x) => x.kind === p.kind && x.id === p.id);
    return a + (r ? r.amount : 0);
  }, 0);
  if (!paid) {
    if (!(await uiConfirm(`批量撤销：${picked.length} 笔，合计 ${fmtMoney(amount)}？\n撤销后会从财务报表移出（代发只撤销付款标记）。`))) return;
    return submitPayBatch(picked, false, 0, "");
  }
  openPayModal({
    title: "批量标记已支付",
    label: `<b>${picked.length}</b> 笔账单，合计 <b class="mono">${fmtMoney(amount)}</b>`,
    note: "确认后这些将按原日期计入财务报表（代发只做付款核对、不进报表）。整批只记一笔手续费。",
    onOk: (fee, day) => submitPayBatch(picked, true, fee, day),
  });
}

async function submitPayBatch(picked, paid, fee, date) {
  const byKind = new Map();
  picked.forEach((p) => {
    if (!byKind.has(p.kind)) byKind.set(p.kind, []);
    byKind.get(p.kind).push(p.id);
  });
  let updated = 0, missing = 0, feeTotal = 0, feeLeft = fee;
  try {
    for (const [kind, ids] of byKind) {
      // 手续费只随第一组提交一次（后端每收到一次就记一笔其他收支，避免按来源重复记）
      const r = await api("/api/payables/pay-batch", "POST", { kind, ids, paid, fee: feeLeft, date });
      feeLeft = 0;
      updated += r.updated || 0;
      missing += r.missing || 0;
      feeTotal += r.fee || 0;
    }
    toast(`已处理 ${updated} 笔${missing ? `，${missing} 笔已不存在` : ""}`
      + (feeTotal ? `；手续费 ¥${fmtMoney(feeTotal)} 已记「其他收支」` : ""));
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
    : "账单：入库 / 出库 / 其他收支 / 手动记账的待结清项；代发应付在「代发」页签里单独看";
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
  const kws = splitSearchKeywords($("dsSearch") ? $("dsSearch").value : "");
  const from = $("dsFrom") ? $("dsFrom").value : "";
  const to = $("dsTo") ? $("dsTo").value : "";
  let groups = DS_GROUPS;
  if (kws.length) {
    groups = groups.filter((g) =>
      searchHit([g.product_name, g.spec, g.unit, g.operator].join(" "), kws));
  }
  if (from || to) {
    groups = groups.filter((g) => {
      const a = g.date_from || g.date_to, b = g.date_to || g.date_from;
      if (!a || !b) return false;
      return (!to || a <= to) && (!from || b >= from);
    });
  }
  return { groups, active: !!(kws.length || from || to) };
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
  // 单量合计 = 各行「单量」相加（不是单据/出库单张数，两者在代发里经常不相等）
  const qtySum = groups.reduce((a, g) => a + (Number(g.quantity) || 0), 0);
  const units = new Set(groups.map((g) => (g.unit || "").trim()).filter(Boolean));
  const qtyUnit = units.size === 1 ? [...units][0] : "";
  const qtyText = `${fmtNum(qtySum)}${qtyUnit ? " " + qtyUnit : ""}`;
  const days = new Set(groups.map((g) => g.date).filter(Boolean)).size;   // 涉及多少个出库日期
  const sumEl = $("dsSum");
  if (sumEl) {
    sumEl.innerHTML =
      `<span class="pay-sum-label">${active ? "筛选结果" : "当前列表"}</span>` +
      `<span><b>${groups.length}</b> 行 <span class="muted">/ ${days} 天 / 单量合计 ${qtyText} · ${orders} 张出库单</span></span>` +
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
      <th style="width:96px;"></th>
    </tr></thead><tbody>` +
    (rows.length ? rows.join("")
      : `<tr><td colspan="7" class="empty">${active
        ? "没有符合筛选条件的代发应付（可点「清空筛选」看全部）"
        : (DS_VIEW === "all" ? "还没有代发应付账单" : "没有待结清的代发应付")}</td></tr>`) +
    `</tbody>` +
    (groups.length
      ? `<tfoot><tr>
          <td></td>
          <td><b>${active ? "筛选合计" : "列出合计"}</b></td>
          <td class="muted" colspan="3">${groups.length} 行 · ${days} 天 · 待结清 ${pend.length} 行 · 单量合计 ${qtyText}</td>
          <td class="num mono"><b>应付 ${fmtMoney(sum)}</b></td>
          <td></td>
        </tr></tfoot>`
      : "");
}

function dsToggleAll(cb) {
  document.querySelectorAll("#dsTable .ds-pick").forEach((x) => { x.checked = cb.checked; });
}

/* ---------- 代发账单核对：上传供应商单据（图片/Excel）→ 与代发成本逐日逐商品比对 ---------- */
function dsReconcileOpen() {
  openModal(`<h3>代发单据核对 <button class="close" onclick="closeModal()">✕</button></h3>
    <div class="field"><label>单据文件（图片 / Excel）</label>
      <input id="rcFile" type="file" accept="image/*,.xlsx,.xlsm,.csv" />
      <div class="field-hint">支持 PNG/JPG 图片，或含「单据日期 / 商品名称 / 数量 / 单价 / 价税合计」列的 Excel。</div>
    </div>
    <div class="field"><label>日期范围（可选）</label>
      <span class="date-range">
        <span class="date-pick"><input id="rcFrom" type="date" /><span class="date-ph">开始</span></span>
        <span class="muted">至</span>
        <span class="date-pick"><input id="rcTo" type="date" /><span class="date-ph">结束</span></span>
      </span>
      <div class="field-hint">留空则按单据里的日期自动取范围。</div>
    </div>
    <div class="field"><label>商品别名（可选，把单据商品名对应到系统商品）</label>
      <textarea id="rcText" rows="2" placeholder="如：电商果是老味道番茄，牧心果是牧心番茄"></textarea>
    </div>
    <div class="field"><label>显示范围</label>
      <label style="font-weight:400;display:flex;gap:6px;align-items:center;"><input id="rcAllSys" type="checkbox" /> 同时列出系统内其他代发商品（仅系统）</label>
      <div class="field-hint">默认只看单据涉及的商品；勾选后会把同日系统里其它代发商品也列出来。</div>
    </div>
    <div id="rcResult" style="margin-top:8px;"></div>
    <div class="modal-foot">
      <button class="btn secondary" onclick="closeModal()">取消</button>
      <button class="btn green" id="rcRun" onclick="dsReconcileRun()">开始核对</button>
    </div>`);
  datePhSync(["rcFrom", "rcTo"]);
}

async function dsReconcileRun() {
  const f = $("rcFile") && $("rcFile").files[0];
  if (!f) { toast("请先选择单据文件"); return; }
  const btn = $("rcRun");
  const out = $("rcResult");
  const old = btn.textContent;
  btn.disabled = true;
  btn.textContent = "核对中…";
  out.innerHTML = `<div class="muted">正在提取单据并与代发账单比对，请稍候…</div>`;
  try {
    const fd = new FormData();
    fd.append("file", f);
    fd.append("text", $("rcText") ? $("rcText").value : "");
    fd.append("date_from", $("rcFrom") ? $("rcFrom").value : "");
    fd.append("date_to", $("rcTo") ? $("rcTo").value : "");
    fd.append("include_only_system", $("rcAllSys") && $("rcAllSys").checked ? "1" : "0");
    const res = await fetch(routePath("/api/reconcile/dropship"), { method: "POST", body: fd });
    if (res.status === 401) { showLogin(); throw new Error("请先登录"); }
    if (!res.ok) {
      let msg = "核对失败";
      try { const j = await res.json(); msg = j.detail || msg; } catch (e) {}
      throw new Error(msg);
    }
    dsRenderReconcile(await res.json());
  } catch (e) {
    out.innerHTML = `<div class="alert warn">核对失败：${esc(e.message)}</div>`;
  } finally {
    btn.disabled = false;
    btn.textContent = old;
  }
}

function dsRenderReconcile(d) {
  const s = d.summary || {};
  const matchedDiff = s.matched_diff || 0;
  const diffOk = Math.abs(matchedDiff) <= 0.02;
  const matchedQtyDiff = s.matched_qty_diff || 0;
  const qtyOk = Math.abs(matchedQtyDiff) <= 1e-6;
  const statusStyle = {
    "一致": "background:#e8f5e9;color:#1b7f3b;",
    "金额差异": "background:#fde2e0;color:#b3261e;",
    "仅单据": "background:#fff3cd;color:#8a6d00;",
    "仅系统": "background:#e8eefc;color:#2b4a9b;",
  };
  const rows = (d.rows || []).map((r) => {
    const rowOk = Math.abs(r.amount_diff) <= 0.02;
    const qtyRowOk = Math.abs(r.qty_diff || 0) <= 1e-6;
    const unitNote = (r.doc_unit && r.system_unit && !r.qty_unit_same)
      ? '<span class="muted" title="单据单位与系统单位不同（箱/件 vs 单），按 1箱≈1单 比较">*</span>' : "";
    return `<tr>
      <td class="num mono">${esc(r.date || "")}</td>
      <td><span class="badge" style="${statusStyle[r.status] || ""}">${esc(r.status)}</span></td>
      <td>${esc((r.doc_names || []).join("、")) || '<span class="muted">—</span>'}</td>
      <td class="num mono">${esc(r.doc_unit || "")}</td>
      <td class="num mono">${fmtNum(r.doc_quantity)}</td>
      <td class="num mono">${fmtMoney(r.doc_amount)}</td>
      <td>${esc(r.system_name || "")}${r.system_spec ? `<span class="muted"> · ${esc(r.system_spec)}</span>` : ""}</td>
      <td class="num mono">${esc(r.system_unit || "")}</td>
      <td class="num mono">${fmtNum(r.system_quantity)}</td>
      <td class="num mono">${fmtMoney(r.system_amount)}</td>
      <td class="num mono"><b style="color:${qtyRowOk ? "var(--green,#16a34a)" : "var(--danger,#dc2626)"};">${fmtNum(r.qty_diff)}</b>${unitNote}</td>
      <td class="num mono"><b style="color:${rowOk ? "var(--green,#16a34a)" : "var(--danger,#dc2626)"};">${fmtMoney(r.amount_diff)}</b></td>
    </tr>`;
  }).join("");
  const aliasTxt = (d.aliases || []).map((a) => `${esc(a.from)} → ${esc(a.to)}`).join("；");
  $("rcResult").innerHTML = `
    <div class="pay-sum" style="margin-top:6px;">
      <span>单据 <b>${s.doc_rows || 0}</b> 行 / 金额 <b class="mono">${fmtMoney(s.doc_total)}</b></span>
      <span>系统代发成本（单据涉及商品） <b class="mono">${fmtMoney(s.system_total)}</b></span>
      <span>已匹配单量差异 <b class="mono" style="color:${qtyOk ? "var(--green,#16a34a)" : "var(--danger,#dc2626)"};">${fmtNum(matchedQtyDiff)}</b></span>
      <span>已匹配金额差异 <b class="mono" style="color:${diffOk ? "var(--green,#16a34a)" : "var(--danger,#dc2626)"};">${fmtMoney(matchedDiff)}</b></span>
      <span>未归类商品单量 <b class="mono">${fmtNum(s.unmatched_doc_qty_goods)}</b><span class="muted">（含包材另 ${fmtNum(s.unmatched_doc_qty_pack)}）</span></span>
      <span>未归类单据金额 <b class="mono">${fmtMoney(s.unmatched_doc_total)}</b></span>
      <span class="muted">差异 ${s.diff_groups || 0} · 仅单据 ${s.only_doc || 0} · 仅系统 ${s.only_system || 0} · 一致 ${s.same || 0}</span>
    </div>
    <div class="muted" style="font-size:12px;margin:4px 0;">日期 ${esc(d.date_from || "-")} ~ ${esc(d.date_to || "-")}${aliasTxt ? "；别名：" + aliasTxt : ""}</div>
    <div class="table-wrap" style="max-height:52vh;overflow:auto;"><table>
      <thead><tr>
        <th style="width:92px;">日期</th><th style="width:86px;">状态</th>
        <th>单据商品</th><th style="width:54px;">单位</th><th style="width:76px;">数量</th><th style="width:92px;">金额</th>
        <th>系统商品 / 规格</th><th style="width:54px;">单位</th><th style="width:76px;">数量</th><th style="width:92px;">成本</th>
        <th style="width:82px;">单量差异</th><th style="width:92px;">金额差异</th>
      </tr></thead>
      <tbody>${rows || '<tr><td colspan="12" class="empty">没有可核对的数据</td></tr>'}</tbody>
    </table></div>`;
}


/** 勾选的行 → 它们名下所有出库单的代发账单行 id（跨单合并后一行对应多张单） */
function dsPickedBillIds() {
  return [...document.querySelectorAll("#dsTable .ds-pick")].filter((x) => x.checked)
    .map((x) => DS_ROWS[Number(x.value)]).filter(Boolean)
    .flatMap((g) => g.bill_ids || []);
}

/** 代发成本付款提交（账单行可能跨多张出库单）：手续费 >0 时后端自动记一笔「其他收支 → 手续费」 */
async function submitDropshipPay(ids, paid, fee, date, okText) {
  try {
    const r = await api("/api/payables/pay-batch", "POST",
      { kind: "dropship_item", ids, paid, fee, date });
    const tail = r && r.fee ? `；手续费 ¥${fmtMoney(r.fee)} 已记「其他收支」` : "";
    toast((paid ? (okText || "已标记代发成本已支付") : "已撤销") + tail);
    await loadDropshipBills();
    await loadPayablesPage();
  } catch (e) { toast("操作失败：" + e.message); }
}

/** 标记某款商品规格（可能跨多张出库单）的代发成本已付/撤销：已支付弹窗可填转账手续费 */
async function dsMarkPaid(idx, paid) {
  const g = DS_ROWS[idx];
  if (!g) return;
  const detail = `${g.order_count} 张出库单 · 单量 ${fmtNum(g.quantity)}${g.unit || ""}`;
  const plain = `${g.product_name}${g.spec ? " · " + g.spec : ""}（${detail}，代发成本 ${fmtMoney(g.amount)}）`;
  if (!paid) {
    if (!(await uiConfirm(`确认撤销已付标记？\n${plain}\n（只影响代发付款核对，不影响财务报表）`))) return;
    return submitDropshipPay(g.bill_ids || [], false, 0, "");
  }
  openPayModal({
    title: "代发成本已支付",
    label: `<b>${esc(g.product_name)}</b>${g.spec ? " · " + esc(g.spec) : ""}（${esc(detail)}，代发成本 <b class="mono">${fmtMoney(g.amount)}</b>）`,
    note: "只影响代发付款核对，不影响报表的收入成本；手续费照常记入「其他收支」。",
    onOk: (fee, day) => submitDropshipPay(g.bill_ids || [], true, fee, day),
  });
}

/** 批量标记勾选的商品规格：已支付弹窗可填转账手续费（整批只记一笔） */
async function dsBatchPay(paid) {
  const picked = [...document.querySelectorAll("#dsTable .ds-pick")].filter((x) => x.checked)
    .map((x) => DS_ROWS[Number(x.value)]).filter(Boolean);
  const ids = picked.flatMap((g) => g.bill_ids || []);
  if (!ids.length) { toast("请先勾选要处理的商品规格"); return; }
  const amount = picked.reduce((a, g) => a + (g.amount || 0), 0);
  const orders = picked.reduce((a, g) => a + (g.order_count || 0), 0);
  if (!paid) {
    if (!(await uiConfirm(`批量撤销：${picked.length} 款商品规格 / ${orders} 张出库单，代发成本合计 ${fmtMoney(amount)}？\n（只撤销付款核对标记，不影响财务报表）`))) return;
    return submitDropshipPay(ids, false, 0, "");
  }
  openPayModal({
    title: "批量标记代发成本已支付",
    label: `<b>${picked.length}</b> 款商品规格 / <b>${orders}</b> 张出库单，代发成本合计 <b class="mono">${fmtMoney(amount)}</b>`,
    note: "只影响代发付款核对，不影响报表的收入成本；整批只记一笔手续费。",
    onOk: (fee, day) => submitDropshipPay(ids, true, fee, day),
  });
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

