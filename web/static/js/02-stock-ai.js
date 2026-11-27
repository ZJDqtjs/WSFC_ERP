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
  const kws = splitSearchKeywords($("stockSearch")?.value);
  const cat = catSel ? catSel.value : "";
  let rows = overview.filter((p) =>
    searchHit(`${p.name || ""} ${p.category || ""}`, kws) &&
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
let ADJ_SUBMITTING = false;   // 防连点：提交中再点不重复发请求（曾出现连点 7 次写 7 条盘盈）
async function submitAdjust() {
  const get = (id) => ($(id)?.value || "").trim();
  const raw = get("adjQty"), araw = get("adjAvgCost"), uraw = get("adjUnitCost");
  if (raw && !/^[+-]\d+(\.\d+)?$/.test(raw)) { toast("调整数量必须以 + 或 - 开头（如 +100 增加 / -100 减少），留空则不调整"); return; }
  if (araw && !/^[+-]\d+(\.\d+)?$/.test(araw)) { toast("平均成本必须以 + 或 - 开头（如 +2 调高 / -1 调低），留空则不调整"); return; }
  if (uraw && !/^[+-]\d+(\.\d+)?$/.test(uraw)) { toast("成本单价必须以 + 或 - 开头（如 +2 调高 / -1 调低），留空则不调整"); return; }
  const p = PRODUCTS.find((x) => x.id === +$("adjProduct").value);
  if (!p) { toast("请选择商品"); return; }
  if (ADJ_SUBMITTING) return;
  ADJ_SUBMITTING = true;
  const btn = document.querySelector('.modal-foot button[onclick="submitAdjust()"]');
  if (btn) btn.disabled = true;
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
  finally { ADJ_SUBMITTING = false; if (btn) btn.disabled = false; }
}

/* ---------- 盘点调整记录（查看谁盘点的，支持删除回退） ---------- */
/* 商品维度的「下拉选一个商品」已去掉（列表太长、选起来麻烦）：直接用关键词搜索过滤，
   商品名 / 备注 / 操作员 / 日期 都能匹配。 */
let ADJ_ROWS = [];   // 当前拉到的盘点记录（关键词筛选在本地做，不重新请求）
async function loadAdjustments() {
  const from = $("adjDateFrom")?.value || "", to = $("adjDateTo")?.value || "";
  ADJ_ROWS = await api(`/api/adjustments?date_from=${from}&date_to=${to}`);
  renderAdjustments();
}
/** 渲染盘点记录（带关键词筛选：商品名 / 备注 / 操作员 / 日期，纯前端过滤，不用再点查询） */
function renderAdjustments() {
  const t = $("adjRecordTable");
  if (!t) return;
  const kws = splitSearchKeywords($("adjSearch")?.value);
  let rows = ADJ_ROWS;
  if (kws.length) {
    rows = rows.filter((r) =>
      searchHit([r.product_name, r.remark, r.operator, r.date, r.created_at].join(" "), kws));
  }
  rows = applyTableSort(t, rows);
  if (!rows.length) {
    t.innerHTML = `<tr><td colspan="8" class="empty">${ADJ_ROWS.length ? "没有符合筛选条件的盘点记录（清空关键词试试）" : "暂无盘点调整记录"}</td></tr>`;
    t._render = renderAdjustments;
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
  t._render = renderAdjustments;
}
async function deleteAdjustment(gid) {
  if (!(await uiConfirm("确认删除该盘点调整记录？将回退其对库存、平均成本与成本单价的影响。"))) return;
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
      <div class="stat red"><div class="label">本月其他收支</div><div class="value">${fmtMoney(m.other_expense || 0)}</div><div class="sub">今日 ${fmtMoney(t.other_expense || 0)} · 已计入净利</div></div>
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
      } else if (obj.memory) {
        // 后端把这次说的「X就是Y / 一件X=13公斤」这类规则自动记下了：提示一下并刷新记忆列表
        if (obj.memory.added || obj.memory.reactivated) {
          toast(`🧠 已记住：${obj.memory.text}`);
          if (typeof loadAiMemories === "function") loadAiMemories(true);
        }
      } else if (obj.image_url) {
        // 后端一开始就把「已存下的票据地址」回执过来：识别中途失败/重试时靠它取回原图
        if (out.image_url) out.image_url(obj.image_url);
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
/* ---------- AI 记忆：补充说明里说过的别名 / 装箱换算，自动记住并在之后的识别里带上 ---------- */
let AI_MEM = [];
async function loadAiMemories(silent) {
  const box = $("aiMemList");
  if (!box) return;
  try {
    AI_MEM = await api("/api/ai/memories");
    renderAiMemories();
  } catch (e) {
    if (!silent) toast("读取 AI 记忆失败：" + e.message);
    box.innerHTML = `<span class="muted">读取失败：${esc(e.message)}</span>`;
  }
}
function renderAiMemories() {
  const box = $("aiMemList");
  if (!box) return;
  const cnt = $("aiMemCount");
  if (cnt) cnt.textContent = AI_MEM.length ? `　共 ${AI_MEM.length} 条` : "";
  if (!AI_MEM.length) {
    box.innerHTML = `<span class="muted">还没有记忆。识别时在补充说明里写「京东8号就是8号纸箱」「一件清芹就是13公斤」这类规则，会自动记下来（普通业务描述不会记）。</span>`;
    return;
  }
  box.innerHTML = AI_MEM.map((m) => `<div class="ai-mem-item">
      <span class="ai-mem-text">${esc(m.text)}</span>
      <span class="muted ai-mem-meta">${m.source === "manual" ? "手动添加" : (m.source === "hint" ? "追问时记下" : "识别时自动记")}${m.created_at ? " · " + esc(m.created_at) : ""}</span>
      <button class="btn secondary ai-mem-x" title="删除这条记忆（历史单据不受影响）" onclick="aiMemDel(${m.id})">✕</button>
    </div>`).join("");
}
async function aiMemAdd() {
  const el = $("aiMemText");
  const t = ((el && el.value) || "").trim();
  if (!t) { toast("先写一条要记住的规则，如「清芹就是水果西芹」"); return; }
  try {
    await api("/api/ai/memories", "POST", { text: t });
    if (el) el.value = "";
    toast("🧠 已记住，之后每次识别都会带上");
    await loadAiMemories(true);
  } catch (e) { toast("保存失败：" + e.message); }
}
async function aiMemDel(id) {
  if (!(await uiConfirm("删除这条记忆？删除后 AI 不再按它识别（历史单据不受影响）"))) return;
  try {
    await api(`/api/ai/memories/${id}`, "DELETE");
    await loadAiMemories(true);
    toast("已删除这条记忆");
  } catch (e) { toast("删除失败：" + e.message); }
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
  if (line) {
    line.product_id = pid;
    // 记住选中商品的名称：待办卡片/说明/单据里显示这个名字；切回「🆕 新建」时改回识别名
    if (pid) {
      const pp = PRODUCTS.find((x) => x.id === pid);
      if (pp) line.product_name = pp.name;
      line.manual_pick = true;          // 用户手选过已有商品（暂存时据此保留选择、不再当成待新增）
    } else if (line.new_product && line.new_product.name) {
      line.product_name = line.new_product.name;
      line.manual_pick = false;
    }
  }
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
  // 已选中真实商品：去掉「🆕 提交后新增」徽标（它是按识别时的"待新增"渲染的，换商品后就不对了）；
  // 切回「🆕 新建」时再补回来（暂存后重开的行已选真实商品，当时没渲染这个徽标）
  const newBadge = tr.querySelector(".ai-newbadge");
  if (newBadge) newBadge.style.display = pid ? "none" : "";
  else if (!pid && line && line.new_product) {
    const badgeWrap = tr.querySelector("td:nth-child(2) div");
    if (badgeWrap) badgeWrap.insertAdjacentHTML("beforeend", '<span class="badge ai-newbadge" style="background:var(--amber-light);color:#8a6d00;margin-left:6px;">🆕 提交后新增</span>');
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
    // 用户在确认框里手动选过别的商品（不在候选里）→ 不能再被候选列表改回去（暂存后重新打开也要保留）
    const manualOutside = ln.product_id && !(ln.candidates || []).some((c) => c.product_id === ln.product_id);
    if (ln.ambiguous && ln.candidates && ln.candidates.length && !manualOutside) {
      // 相似商品：默认选中第一个候选，并在未识别到价格时回填该商品最近一次的录入价
      if (!ln.product_id) ln.product_id = ln.candidates[0].product_id;
      const cur = ln.candidates.find((c) => c.product_id === ln.product_id) || ln.candidates[0];
      if (!(+ln.unit_price) && cur.last_price) { ln.unit_price = cur.last_price; ln.price_defaulted = true; }
      // searchable：和普通下拉一样支持「点击选择 / 输入筛选」（漏了它就只能滚原生下拉，无法输入搜索）
      prodSel = `<select class="searchable ai-pid" style="border-color:var(--amber);" onchange="aiProdChanged(${i})">
          <option value="0">🆕 新建：${esc(ln.recognized_name || ln.product_name || "")}</option>
          ${ln.candidates.map((c) => `<option value="${c.product_id}" ${c.product_id === ln.product_id ? "selected" : ""} data-price="${c.last_price || 0}">〔${({ stock: "库存", order: "订单", pack: "包材", labor: "人工" }[c.category] || "库存")}〕${esc(c.name)}${c.last_price ? `（最近 ${c.last_price}）` : ""}</option>`).join("")}
        </select>`;
    } else if (np && !ln.product_id) {
      // 待新增商品：仅在「确认提交」后才建档，取消不会污染商品资料
      prodSel = `<select class="searchable ai-pid" onchange="aiProdChanged(${i})">${aiProductOptions(0, cat, `<option value="0" selected>🆕 新建：${esc(np.name)}</option>`)}</select>`;
    } else if (np) {
      // 待新增行里用户已经选了已有商品（暂存后重新打开也要保留这个选择）：
      // 正常列出已有商品并选中它，同时保留「🆕 新建」选项，随时可以切回去
      prodSel = `<select class="searchable ai-pid" onchange="aiProdChanged(${i})">${aiProductOptions(ln.product_id, cat, `<option value="0">🆕 新建：${esc(np.name)}</option>`)}</select>`;
    } else if (!isIn && !isStock && !ln.product_id && !ln.category) {
      // AI 没说是什么商品（也没能判断分类）：订单商品与库存大类一起列，选完下面的包材/快递会自动算
      prodSel = `<select class="searchable ai-pid" onchange="aiProdChanged(${i})">${aiProductOptionsWide(ln.product_id, '<option value="0" selected>— 请选择商品（订单 / 库存都在这里）—</option>')}</select>`;
    } else {
      // 已选真实商品、但这一行原本是「待新增 / 相似候选」时，保留一个「🆕 新建」选项，随时能切回去
      const newLabel = np ? np.name : (ln.ambiguous ? (ln.recognized_name || ln.product_name || "") : "");
      const keepNew = (ln.product_id && newLabel) ? `<option value="0">🆕 新建：${esc(newLabel)}</option>` : "";
      const head = ln.product_id ? keepNew : `<option value="0" selected>— 请选择商品 —</option>`;
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
      <td style="min-width:250px;">${prodSel}${aiNewNameHtml(ln)}<div style="margin-top:4px;">${ambiBadge}${np && !ln.product_id ? '<span class="badge ai-newbadge" style="background:var(--amber-light);color:#8a6d00;margin-left:6px;">🆕 提交后新增</span>' : ""}</div></td>
      <td><input type="date" class="ai-date" value="${esc(ln.date || docDate)}" style="width:138px;" title="这一行的单据日期（对账单/送货单逐行日期）" /></td>
      ${qtyCell}
      <td><input class="ai-unit" list="aiUnitList-${i}" value="${esc(ln.unit || (ln.matched ? "" : "个"))}" style="width:84px;" title="单位：可下拉选该商品已有单位，也可手填；改动会立即重算库存；未匹配到商品的待新增行若票据没写单位，默认「个」" onchange="aiUnitChanged(${i})" /><datalist id="aiUnitList-${i}">${aiUnitSuggest(ln.product_id, ln.unit)}</datalist>${unitBadge}</td>
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
    <div class="ai-followup">
      <h4 class="block-title" style="margin:0 0 6px;">🤖 识别得不对？跟 AI 说一句，让它重新识别</h4>
      <div class="row" style="gap:8px;align-items:flex-start;">
        <textarea id="aiFollowText" rows="1" style="flex:1;min-width:220px;"
          placeholder="例如：灵芝是按公斤算不是按袋 ｜ 第 3 行应该是白拇指袋子 ｜ 这单其实是入库 ｜ 单价不对，按 12.5 一斤 ｜ 快递费应该是 12"></textarea>
        <button class="btn" id="aiFollowBtn" onclick="aiFollowup()">让 AI 重认</button>
      </div>
      <div class="field-hint" id="aiFollowStage">会在原来的文字 / 票据基础上，按你的要求重新识别，结果直接更新到这条待办；可以连续追问多次。</div>
      ${aiFollowHistoryHtml()}
    </div>
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
  // AI 出库也是手动单（客户随货款付回包材/人工/快递费），没识别到口径时兜底全勾
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
    // 待新增行里已经选了已有商品：单位若不在该商品换算表里（如占位的「袋」），按商品默认单位保存 ——
    // 否则重新打开后「当前库存 / 增减量」会按错单位算（与 aiProdChanged 里同一套规则）
    if (ln.product_id) {
      const p = PRODUCTS.find((x) => x.id === ln.product_id) || null;
      if (p) {
        const conv = p.conversions || {};
        const cur = (ln.unit || "").trim();
        const valid = !!cur && (cur in conv || cur === defaultUnit(p) || cur === p.base_unit);
        if (!valid) {
          const du = defaultUnit(p);
          const fOld = +conv[cur] || 0, fNew = +conv[du] || 0;
          if (du && du !== cur) {
            if (ln.stock_counted != null && !ln.stock_count_cleared && fOld && fNew) {
              ln.stock_counted = +((ln.stock_counted * fOld) / fNew).toFixed(4);
              ln.unit_note = `单位已按商品「${p.name}」改为「${du}」（原单位「${cur || "空"}」不适用），数量已按换算表同步换算`;
            } else {
              ln.unit_note = `单位已按商品「${p.name}」改为「${du}」（原单位「${cur || "空"}」不适用），数量请核对`;
            }
            ln.unit = du;
            ln.stock_unit = du;
          }
        }
      }
    }
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

/* =============== 连续对话：不满意就让 AI 按你的要求重新识别 =============== */
/** 这条待办问过几次（追问历史，显示在确认框里） */
function aiFollowHistoryHtml() {
  const job = aiCurrentJob();
  const chat = (job && job.chat) || [];
  if (!chat.length) return "";
  return `<div class="ai-follow-hist">` + chat.map((c, i) =>
    `<div>· 第 ${i + 1} 次追问：${esc(c.text)}<span class="muted">（${esc((c.at || "").slice(11, 16))} 已重认）</span></div>`
  ).join("") + `</div>`;
}
/** 当前确认框各行的紧凑 JSON（含你在界面上的手改）——追问时作为「上一次结果」发给模型 */
function aiConfirmPrevJson() {
  const r = AI_CONFIRM || {};
  const type = (($("aiType") || {}).value) || r.type || "";
  const o = {
    type,
    date: (($("aiDate") || {}).value) || r.date || "",
    lines: (r.lines || []).filter((ln) => !ln._deleted).map((ln) => ({
      product: ln.product_name || ln.recognized_name || "",
      quantity: ln.stock_counted != null ? ln.stock_counted : ln.quantity,
      unit: ln.unit || "",
      unit_price: ln.unit_price || 0,
      date: ln.date || "",
      category: ln.category || "",
    })),
  };
  const partyEl = $("aiParty");
  if (partyEl) {
    if (type === "outbound") o.customer = partyEl.value.trim();
    else if (type === "inbound") o.supplier = partyEl.value.trim();
  }
  return JSON.stringify(o);
}
/** 重识别/追问用的原图：优先内存里的 File（当次粘贴的），没了就用识别时存下的票据地址取回来。
    识别成功后原图 File 会被释放（省内存），此时靠 result.image_url 再取一次，所以「重试」不会丢图。 */
async function aiJobImageFile(job) {
  const f = AI_QUEUE_FILES.get(job.id);
  if (f) return f;
  const url = job.image_url || (job.result && job.result.image_url) || "";
  if (!url) throw new Error("原图已丢失，请回到工作台重新粘贴这张图片");
  const res = await fetch(routePath(url));
  if (!res.ok) throw new Error("取回原图失败（HTTP " + res.status + "）");
  const blob = await res.blob();
  const file = new File([blob], job.image_name || "invoice.jpg", { type: blob.type || "image/jpeg" });
  AI_QUEUE_FILES.set(job.id, file);   // 缓存回来：再点一次重试不用重新下载
  return file;
}
/** 连续对话：按用户这次的要求重新识别，结果直接更新到这条待办（可连续追问） */
async function aiFollowup() {
  const job = aiCurrentJob();
  const askEl = $("aiFollowText");
  const btn = $("aiFollowBtn");
  const stage = $("aiFollowStage");
  if (!job || !askEl) { toast("这条识别结果不在待办队列里，无法追问"); return; }
  const ask = (askEl.value || "").trim();
  if (!ask) { toast("先写一句要让 AI 改什么，例如「灵芝是按公斤算的」"); return; }
  const prev = aiConfirmPrevJson();
  const setStage = (s) => { if (stage) stage.textContent = s; };
  if (btn) { btn.disabled = true; btn.textContent = "重新识别中…"; }
  setStage("已把你的要求发给 AI，正在重新识别…（票据可能要 1~2 分钟）");
  const abort = new AbortController();
  AI_QUEUE_CTRL = abort;
  let thinkBuf = "";
  const sink = {
    think: (s) => {
      thinkBuf = (thinkBuf + (s || "")).slice(-160);
      setStage("AI 思考中… " + thinkBuf.replace(/\s+/g, " ").slice(-90));
    },
    stage: (s) => setStage(s),
    answer: () => {},
  };
  try {
    let result;
    if (job.kind === "image") {
      const f = await aiJobImageFile(job);
      const fd = new FormData();
      fd.append("file", f);
      fd.append("text", job.text || "");
      fd.append("hint", ask);
      fd.append("prev", prev);
      const res = await fetch(routePath("/api/ai/parse-image/stream"), { method: "POST", body: fd, signal: abort.signal });
      result = await aiCollectStream(res, sink);
    } else {
      const res = await fetch(routePath("/api/ai/parse/stream"), {
        method: "POST", headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ text: job.text || "", hint: ask, prev }), signal: abort.signal,
      });
      result = await aiCollectStream(res, sink);
    }
    // 更新这条待办（结果替换成新的、记下这次追问），重新打开能看到历史
    job.result = result;
    job.status = "done";
    job.error = "";
    job.think = "";
    job.answer = "";
    job.chat = [...(job.chat || []), { text: ask, at: new Date().toISOString() }];
    job.draft_at = "";
    aiQueueSave();
    refreshEvaBadge();
    AI_CONFIRM = null;   // 先清掉：避免 closeModal 的自动暂存把旧明细写回去
    closeModal();
    openAiConfirm(result);
    toast("✅ 已按你的要求重新识别，核对后再提交");
  } catch (e) {
    if (e && e.name === "AbortError") toast("已取消这次追问");
    else toast("重新识别失败：" + (e && e.message ? e.message : e));
    if (btn) { btn.disabled = false; btn.textContent = "让 AI 重认"; }
    setStage("重新识别失败，可以改改说法再试一次");
  } finally {
    AI_QUEUE_CTRL = null;
  }
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
    if (n === null) { toast("已取消：入库单价与最近价不同，请改回原价或确认后再提交"); return; }
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
      image_url: j.image_url || "",      // 原图地址：File 释放/刷新后仍能重试
      status: j.status, result: j.result || null, error: j.error || "",
      think: (j.think || "").slice(-AI_QUEUE_THINK_KEEP), answer: (j.answer || "").slice(-4000),
      created_at: j.created_at, finished_at: j.finished_at || "", submitted_at: j.submitted_at || "",
      elapsed: j.elapsed || 0, draft_at: j.draft_at || "",
      chat: j.chat || [],                 // 连续对话的追问历史（重新打开还能看到问过什么）
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
    // 图片任务：原图 File 只在内存里，但后端存下的票据地址（image_url）能让它续跑/重试；
    // 连地址都没有（还没开始就刷新了）才算丢图
    if (j.kind === "image" && ["waiting", "running"].includes(j.status) && !j.image_url) {
      j.status = "error";
      j.error = "页面刷新后原图已丢失，请回到工作台重新粘贴这张图片";
    }
  });
  refreshEvaBadge();
}
/** 入队：文字或图片（图片需把 File 传进来，内部登记到 AI_QUEUE_FILES） */
function aiQueueAdd(job) {
  const j = {
    id: aiQueueUid(), kind: job.kind, text: job.text || "", image_name: job.image_name || "",
    image_url: "",                    // 后端存下的票据地址（识别一开始就回执，重试靠它取回原图）
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
    // 后端存好图就回执地址：即使这次识别失败，重试也能凭它取回原图
    image_url: (u) => { job.image_url = u; aiQueueSave(); },
    answer: (s) => {
      job.answer = (job.answer + s).slice(-4000);
      aiAppendAnswer(s);
      evaRenderLive();
    },
  };
  try {
    let result;
    if (job.kind === "image") {
      // 内存里的 File 没了（识别成功后已释放 / 页面刷新过）→ 用识别时存下的票据地址取回原图
      const f = await aiJobImageFile(job);
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
    if (result && result.image_url) job.image_url = result.image_url;   // 兜底：早期回执没收到也补上
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
/** 待办数变了：刷新出库页那个「待办处理（N）」按钮与 AI 队列条 */
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
function loadEva() {
  renderEva();
  evaTab(EVA_TAB);
  loadAiMemories(true);   // 待办页的「🧠 AI 记忆」（别名 / 装箱换算）
}
function evaRefresh() { renderEva(); refreshEvaBadge(); aiQueueTick(); loadAiMemories(true); }
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
async function evaDelete(id) {
  const j = AI_QUEUE.find((x) => x.id === id);
  if (!j) return;
  if (!(await uiConfirm(`删除这条待办？\n${evaTitle(j)}`))) return;
  AI_QUEUE = AI_QUEUE.filter((x) => x.id !== id);
  AI_QUEUE_FILES.delete(id);
  aiQueueSave(); renderEva(); refreshEvaBadge();
}
function evaRetry(id) {
  const j = AI_QUEUE.find((x) => x.id === id);
  if (!j) return;
  if (j.status === "running") { toast("这条正在识别中，等这次跑完再重试"); return; }
  // 原图：内存里的 File 优先；识别成功后会释放，此时用当时存下的票据地址（result.image_url）再取回来
  const savedUrl = j.image_url || (j.result && j.result.image_url) || "";
  if (j.kind === "image" && !AI_QUEUE_FILES.has(j.id) && !savedUrl) {
    toast("原图已丢失（没存下票据地址），请回到工作台重新粘贴这张图片");
    return;
  }
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
  const baseMsg = `批量提交 ${jobs.length} 条${label}待办？\n（按识别结果直接提交${tip}；要改明细请点「审核提交」）`;
  // 入库批量提交：把所有待提交行的单价与最近入库价差异合并成一次确认，避免逐条弹框
  const priceWarn = type === "inbound"
    ? inboundPriceWarnings(jobs.flatMap((j) => evaRowsOf(j)))
    : [];
  if (!(await uiConfirm(priceWarn.length ? priceConfirmText(priceWarn, baseMsg) : baseMsg))) return;
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
        skipPriceCheck: true,   // 上面已按整批差异确认过
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
async function submitDocRows({ type, party, remark, imageUrl, rows, op, charges, skipPriceCheck = false }) {
  const inv = imageUrl ? `[票据] ${imageUrl}` : "";
  // 入库单价变动确认放在「创建新商品」之前：用户取消时不会留下半成品商品档案
  if (type === "inbound" && !skipPriceCheck) {
    const priceWarn = inboundPriceWarnings(rows.map((r) => ({
      product_id: r.product_id, unit: r.unit, unit_price: r.unit_price,
    })));
    if (priceWarn.length && !(await uiConfirm(priceConfirmText(priceWarn, `${rows.length} 行入库`)))) return null;
  }
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
    // ⚠️ 必须先取文件、再清空 value：给 input.value 赋空串会同时清空 FileList，
    // 反过来的话取出的是空数组 → 直接 return，用户看到的就是「选了文件没反应」。
    files = Array.from(source.files || []);
    source.value = "";            // 允许重复选择同一个文件（必须在取值之后清空）
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

