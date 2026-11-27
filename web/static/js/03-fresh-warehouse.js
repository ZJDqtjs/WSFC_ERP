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
          <input id="fcSearch" placeholder="🔍 搜索名称 / 分类…（「；」任一命中，「：」同时命中）" oninput="renderFreshConfig()" style="margin-bottom:8px;" />
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
  const kws = splitSearchKeywords($("fcSearch")?.value);
  const freshOnly = !!($("fcFreshOnly") || {}).checked;
  const selSet = new Set(FC_SEL);
  const rows = FC_ALL
    .filter((p) => !freshOnly || FC_CATS.includes(p.category))   // 「只看鲜货分类」按蔬菜/干货筛
    .filter((p) => searchHit(`${p.name} ${p.category || ""}`, kws));
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
   - 运费 / 装卸费 / 手续费默认留空，填了才计入该行批次成本；
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
  const kws = splitSearchKeywords($("finSearch") ? $("finSearch").value : "");
  FIN_DONE_SET = finDoneLoad();   // 今日已入库（日期变了就自动空）
  const matched = finRowIds().filter((id) => {
    const p = finProduct(id);
    return searchHit(`${p.name} ${p.category || ""}`, kws);
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
      <th style="width:8%;">手续费</th>
      <th style="width:15%;">备注</th>
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
    <td><input class="in-freight" type="number" min="0" step="any" placeholder="留空" value="${esc(val("freight"))}" oninput="finRowCalc(this)" style="width:74px;" title="运费（默认空，选填）：计入这行的批次成本，并同步「其他收支」备查" /></td>
    <td><input class="in-handling" type="number" min="0" step="any" placeholder="留空" value="${esc(val("handling"))}" oninput="finRowCalc(this)" style="width:74px;" title="装卸费（默认空，选填）：同运费" /></td>
    <td><input class="in-fee" type="number" min="0" step="any" placeholder="留空" value="${esc(val("fee"))}" oninput="finRowCalc(this)" style="width:74px;" title="转账手续费（默认空，选填）：同运费，入成本并同步「其他收支」" /></td>
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
    handling: get(".in-handling"), fee: get(".in-fee"), remark: get(".fin-remark"),
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
  // 本行金额（与入库页同一口径：金额 + 有运费/装卸/手续费时补一行批次成本）
  const price = parseFloat((tr.querySelector(".in-price") || {}).value) || 0;
  const fee = (parseFloat((tr.querySelector(".in-freight") || {}).value) || 0)
    + (parseFloat((tr.querySelector(".in-handling") || {}).value) || 0)
    + (parseFloat((tr.querySelector(".in-fee") || {}).value) || 0);
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
    const fd = tr.querySelector(".in-fee");
    if (q && (parseFloat(q.value) || 0) > 0) n++;
    if (q) q.value = "";
    if (f) f.value = "";
    if (h) h.value = "";
    if (fd) fd.value = "";
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
      + (parseFloat((tr.querySelector(".in-handling") || {}).value) || 0)
      + (parseFloat((tr.querySelector(".in-fee") || {}).value) || 0);
  });
  const picked = FIN_PICK.size;
  const btn = $("finSubmitBtn");
  if (btn) btn.textContent = picked ? `✓ 入库选中的 ${picked} 个商品` : rows ? `✓ 全部入库（${rows} 个商品）` : "✓ 全部入库";
  const box = $("finSummary");
  if (!box) return;
  if (!rows) { box.style.display = "none"; box.innerHTML = ""; return; }
  box.style.display = "block";
  box.innerHTML = (picked ? `勾选 <b>${picked}</b> 个` : `已填 <b>${rows}</b> 个商品`) + `：货款 <b>¥${goods.toFixed(2)}</b>`
    + (fee ? ` ＋ 运费/装卸/手续费 <b>¥${fee.toFixed(2)}</b>` : "")
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
    const fee = parseFloat((tr.querySelector(".in-fee") || {}).value) || 0;
    if (isNaN(price)) { bad.push(p.name); return; }
    // 这一行自己的备注（文字 + 附件）：行备注在前，顶部那条通用备注在后，两者都保留
    const rowRemark = remarkValue(`finRemark_${p.id}`);
    items.push({
      product_id: p.id, unit, quantity: qty, unit_price: price,
      supplier, operator, date, remark: [rowRemark, remark].filter(Boolean).join("\n"), pay_status: payStatus,
      adjust_amount: 0, freight, handling, fee,
    });
  });
  if (bad.length) { toast(`这些商品没填单价：${bad.slice(0, 5).join("、")}${bad.length > 5 ? " 等" : ""}`); return; }
  if (!items.length) { toast("还没填数量：先把今天要入库的数量填进「数量」列"); return; }
  const goods = items.reduce((s, it) => s + it.quantity * it.unit_price, 0);
  const fee = items.reduce((s, it) => s + it.freight + it.handling + it.fee, 0);
  const priceWarn = inboundPriceWarnings(items);
  const baseMsg = `确认入库 ${items.length} 个商品？\n日期 ${date}，货款 ¥${goods.toFixed(2)}${fee ? ` + 运费/装卸/手续费 ¥${fee.toFixed(2)}` : ""}，共 ${items.length} 张入库单`;
  if (!(await uiConfirm(priceWarn.length ? priceConfirmText(priceWarn, baseMsg) : baseMsg))) return;
  const btn = $("finSubmitBtn");
  if (btn) { btn.disabled = true; btn.textContent = "⏳ 正在入库…"; }
  try {
    const r = await api("/api/inbounds/batch", "POST", { items });
    // 入库成功的商品记成「今日已入库」：先从列表隐藏，第二天 0 点自动回来
    finDoneAdd(items.map((it) => it.product_id));
    // 入库完清空数量 / 运费 / 装卸 / 手续费（单价保留），备注与附件也清掉，并去掉这行的勾选
    items.forEach((it) => {
      FIN_VALS[it.product_id] = { qty: "", price: "", freight: "", handling: "", fee: "", remark: "" };
      FIN_PICK.delete(it.product_id);
      clearRemarkField(`finRemark_${it.product_id}`);
    });
    await loadFreshInbound();   // 顺便刷新库存与单价
    const box = $("finSummary");
    if (box) {
      box.style.display = "block";
      box.innerHTML = `<b>✅ 已入库 ${r.created} 张单</b>（货款 ¥${goods.toFixed(2)}${fee ? ` ＋ 运费/装卸/手续费 ¥${fee.toFixed(2)}` : ""}）`
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
let WIMPORT = null;   // 贴单导入预览结果
let WI_FILE = null;   // 导入用的 Excel 文件（保持引用，便于切换工作表重新解析）
let WIN_SHEET = "常温贴单";  // 本分仓默认导入的贴单工作表（后端给：wh02=冷冻贴单，其余=常温贴单）

async function loadWarehouseIn() {
  try {
    const d = await api("/api/warehouse-in/deduction");
    WIN_DEDUCT = d.percent || 0;
    WIN_SHEET = d.sheet || "常温贴单";
    const btn = $("winSheetName");
    if (btn) btn.textContent = WIN_SHEET;   // 按钮文案随分仓变（wh02 显示「导入冷冻贴单」）
  } catch (e) {}
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
/* ---------- 入仓品「每袋净重」：单位与换算（与后端 warehouse_in._BASE_UNIT_GRAMS 同源） ---------- */
const WP_WEIGHT_UNITS = ["克", "g", "两", "斤", "公斤", "千克", "kg"];
const WP_UNIT_GRAMS = { "克": 1, "g": 1, "两": 50, "斤": 500, "公斤": 1000, "千克": 1000, "kg": 1000 };
/** 每袋净重（值 + 单位）→ kg；单位不是重量单位时返回 0（算不出重量） */
function wpToKg(v, unit) {
  const g = WP_UNIT_GRAMS[unit] || 0;
  return g ? ((Number(v) || 0) * g) / 1000 : 0;
}
/** 列表「每袋净重」：优先用资料里维护的值；否则回退按库存单位折算，非重量单位时明确提醒 */
function wpNetText(p) {
  const costLine = p.bag_weight
    ? `<div class="muted" style="font-size:11px;">成本口径 ${fmtNum(p.bag_weight)}${esc(p.stock_default_unit || "")}</div>`
    : "";
  if (p.bag_net_weight) return `${fmtNum(p.bag_net_weight)} ${esc(p.bag_net_unit || "克")}${costLine}`;
  const du = p.stock_default_unit || "";
  if (!p.bag_weight) return "—";
  if (WP_WEIGHT_UNITS.includes(du)) return `${fmtNum(p.bag_weight)} ${esc(du)}`;
  return `<span class="muted">${fmtNum(p.bag_weight)} ${esc(du || "单位")}</span>`
    + `<div class="muted" style="font-size:11px;color:var(--red);">单位非重量，重量统计显示「—」</div>`;
}
function renderWarehouseProducts() {
  const t = $("wprodTable");
  const rows = WPROD || [];
  t.innerHTML = `<thead><tr>
    <th>名称</th><th>类目</th><th class="num">箱规(袋/箱)</th><th class="num">每袋净重</th>
    <th class="num">采购价(收入/袋)</th>
    <th class="num">运费(元/袋)</th><th class="num">固定成本(元/袋)</th><th class="num">每袋成本</th>
    <th>关联库存商品</th><th>关联结算(随货包材)</th><th>保质期</th><th></th></tr></thead><tbody>` +
    rows.map((p) => `<tr>
      <td><b>${esc(p.name)}</b><div class="muted" style="font-size:12px;">${esc(p.sku) || "—"}${p.barcode ? ` · ${esc(p.barcode)}` : ""}</div></td>
      <td>${esc(p.category) || "—"}</td>
      <td class="num mono">${p.box_spec ? fmtNum(p.box_spec) : "—"}</td>
      <td class="num mono">${wpNetText(p)}</td>
      <td class="num mono">${fmtMoney(p.purchase_price)}</td>
      <td class="num mono">${p.freight ? fmtMoney(p.freight) : "—"}</td>
      <td class="num mono"${p.fixed_cost ? "" : ' style="color:var(--muted);"'}>${p.fixed_cost ? fmtMoney(p.fixed_cost) : "—"}</td>
      <td class="num mono">${p.bag_cost ? fmtMoney(p.bag_cost) : "—"}</td>
      <td>${p.stock_product_name ? esc(p.stock_product_name) : '<span class="muted">未关联（代发）</span>'}
        ${p.stock_product_id
          ? `<div class="muted" style="font-size:12px;">单位成本 ${fmtMoney(p.stock_unit_cost)}/${esc(p.stock_default_unit || "单位")}</div>`
          : `<div class="muted" style="font-size:12px;${p.dropship_cost ? "" : "color:var(--red);"}">代发成本 ${p.dropship_cost ? fmtMoney(p.dropship_cost) + "/袋" : "未填（成本按 0 计）"}</div>`}</td>
      <td>${(p.pack_items || []).length ? wprodPackText(p) : '<span class="muted">未关联</span>'}</td>
      <td>${esc(p.shelf_life) || "—"}</td>
      <td style="white-space:nowrap;">
        <button class="btn sm" onclick="wprodEdit(${p.id})">改</button>
        <button class="btn sm danger" onclick="wprodDelete(${p.id})">删</button>
      </td></tr>`).join("") + `</tbody>`;
  if (!rows.length) t.innerHTML = `<tr><td colspan="12" class="empty">暂无入仓品，可点「新增入仓品」录入</td></tr>`;
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
    .map((p) => `<option value="${p.id}">${esc(p.name)}${p.warehouse_party ? " · " + esc(p.warehouse_party) : ""}（${esc(p.category || "—")}）</option>`).join("");
  const unitSel = (m, u) => unitOptions(m, u) || `<option>${esc(u || "个")}</option>`;
  return list.map((it) => {
    const m = PRODUCTS.find((x) => x.id === it.product_id);
    return `<div class="pack-row">
      <input value="${esc(m ? m.name : it.product_id)}" data-pid="${it.product_id || ""}" readonly style="background:#f9fafb;" />
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
    .map((p) => `<option value="${p.id}">${esc(p.name)}${p.warehouse_party ? " · " + esc(p.warehouse_party) : ""}（${esc(p.category || "—")}）</option>`).join("");
  last.innerHTML = `
    <input value="${esc(m.name)}" data-pid="${m.id}" readonly style="background:#f9fafb;" />
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
      // 只读行优先读 data-pid（同名商品可能有多条）
      pid = nameInput.dataset.pid ? +nameInput.dataset.pid : null;
      if (!pid) {
        const n = nameInput.value.trim();
        const m = PRODUCTS.find((x) => x.name === n);
        pid = m ? m.id : null;
      }
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
      <div class="field"><label>运费（元/袋）</label><input id="wpFreight" type="number" step="any" min="0" value="${p.freight || ""}" placeholder="可留空，后续维护" oninput="wprodCostHint()" /></div>
      <div class="field"><label>固定成本（元/袋）<button type="button" class="help-btn" data-help="每袋打包费或额外费用，计入入仓记录成本，并并入对外 /api/open/sku-costs 的 package 口径。">?</button></label><input id="wpFixedCost" type="number" step="any" min="0" value="${p.fixed_cost || ""}" placeholder="如 每袋打包费" oninput="wprodCostHint()" /></div>
      <div class="field"><label>关联库存商品（成本来源）</label><select id="wpStock" class="searchable">${stockProductOptions(p.stock_product_id)}</select></div>
      <div class="field"><label>代发成本（元/袋）<button type="button" class="help-btn" data-help="不关联库存商品（代发）时按 数量×此值 计成本；关联库存商品时自动按库存单位成本算。">?</button></label><input id="wpDropshipCost" type="number" step="any" min="0" value="${p.dropship_cost || ""}" placeholder="不关联库存商品时填" oninput="wprodCostHint()" /></div>
      <div class="field"><label>每袋数量（库存单位）<button type="button" class="help-btn" data-help="每袋含几个关联库存商品的单位（如 1 瓶、1 公斤）；每袋成本 = 本值 × 库存单位成本。">?</button></label><input id="wpBagWeight" type="number" step="any" min="0" value="${p.bag_weight || ""}" placeholder="如 1" oninput="wprodCostHint()" /></div>
      <div class="field"><label>每袋净重 <button type="button" class="help-btn" data-help="用于报表重量(kg)统计。库存单位为瓶/个等非重量单位时必须填写，留空则按每袋数量折算。">?</button></label>
        <div class="toolbar" style="margin:0;gap:6px;">
          <input id="wpNetWeight" type="number" step="any" min="0" value="${p.bag_net_weight || ""}" placeholder="如 228" oninput="wprodCostHint()" style="flex:1;min-width:0;" />
          <select id="wpNetUnit" onchange="wprodCostHint()" style="width:92px;">
            ${(p.net_weight_units || ["克", "两", "斤", "公斤"]).map((u) =>
              `<option value="${u}"${(p.bag_net_unit || "克") === u ? " selected" : ""}>${u}</option>`).join("")}
          </select>
        </div>
      </div>
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
  const dcInput = $("wpDropshipCost");
  const dc = parseFloat(dcInput?.value) || 0;
  if (dcInput) {
    // 成本来源只能有一个：关联了库存商品就按库存推算，代发成本置灰不参与计算
    dcInput.disabled = !!sp;
    dcInput.style.background = sp ? "#f3f4f6" : "";
  }
  // 重量提示：优先用维护的「每袋净重 + 单位」；没填就看「每袋数量」能否按库存单位折算出重量
  const nw = parseFloat($("wpNetWeight")?.value) || 0;
  const nu = $("wpNetUnit")?.value || "克";
  const netKg = nw ? wpToKg(nw, nu) : 0;
  let weightLine;
  if (netKg) {
    weightLine = `<br>重量统计：每袋 <b>${fmtNum(netKg)} kg</b>（报表「重量(kg)」= 袋数 × 该值）`;
  } else if (bw && du && !WP_WEIGHT_UNITS.includes(du)) {
    weightLine = `<br><span style="color:var(--red);">库存单位「${esc(du)}」不是重量单位，报表里算不出重量 —— 请在上面填「每袋净重」（花生按瓶入就填 228 克）。</span>`;
  } else if (bw) {
    weightLine = `<br>重量统计（未填每袋净重，按库存单位折算）：每袋 <b>${fmtNum(bw)} ${esc(du)}</b>`;
  } else {
    weightLine = "";
  }
  // 每袋总成本：商品成本 ＋ 运费 ＋ 固定成本（固定成本计入入仓记录毛利，同时并入对外 sku-costs 的包材口径）
  const fr = parseFloat($("wpFreight")?.value) || 0;
  const fx = parseFloat($("wpFixedCost")?.value) || 0;
  const goodsBag = sp ? bw * uc : dc;
  const costTail = (fr || fx)
    ? `<br>每袋总成本：商品 ${fmtMoney(goodsBag)} ＋ 运费 ${fmtMoney(fr)} ＋ 固定成本 ${fmtMoney(fx)} ＝ <b>${fmtMoney(goodsBag + fr + fx)}</b>`
    : "";
  const hint = $("wpCostHint");
  if (!hint) return;
  if (!sp) {
    hint.innerHTML = dc
      ? `未关联库存商品（代发）：商品成本 = 数量 × 代发成本 <b>${fmtMoney(dc)}/袋</b>${weightLine}${costTail}`
      : `未关联库存商品（代发）：请填「代发成本」，否则入仓时商品成本按 <b>0</b> 计（毛利会虚高）。${weightLine}${costTail}`;
    return;
  }
  hint.innerHTML = `库存单位成本 ${fmtMoney(uc)}/${esc(du)}（库存均价优先，无则用参考成本）；每袋成本 = ${fmtNum(bw)} × ${fmtMoney(uc)} = ${fmtMoney(bw * uc)}${weightLine}${costTail}`;
}
async function wprodSave(id) {
  const name = ($("wpName").value || "").trim();
  if (!name) { toast("请填写名称"); return; }
  const stockId = +$("wpStock").value || null;
  const dropshipCost = parseFloat($("wpDropshipCost").value) || 0;
  // 不关联库存商品时成本只能手填；没填会让入仓成本=0、毛利虚高，先确认一句（同「代发商品」的参考成本提醒）
  if (!stockId && !dropshipCost && !(await uiConfirm("未关联库存商品且未填「代发成本」：入仓时商品成本将按 0 计（毛利会虚高）。仍要保存？"))) return;
  const body = {
    name,
    category: $("wpCat").value.trim(),
    sku: $("wpSku").value.trim(),
    barcode: $("wpBarcode").value.trim(),
    box_spec: parseFloat($("wpBoxSpec").value) || 0,
    purchase_price: parseFloat($("wpPrice").value) || 0,
    freight: parseFloat($("wpFreight").value) || 0,
    fixed_cost: parseFloat($("wpFixedCost").value) || 0,
    stock_product_id: stockId,
    bag_weight: parseFloat($("wpBagWeight").value) || 0,
    bag_net_weight: parseFloat($("wpNetWeight").value) || 0,
    bag_net_unit: $("wpNetUnit").value || "克",
    dropship_cost: dropshipCost,
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
  if (!(await uiConfirm("确认删除该入仓品？（已产生的入仓记录不受影响）"))) return;
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
  const g = {
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
    fixed: recs.reduce((s, r) => s + (r.fixed_total || 0), 0),
    profit: recs.reduce((s, r) => s + (r.profit || 0), 0),
    code: `批量 · ${recs.length}条`,
    date: dates[0] === dates[dates.length - 1] ? dates[0] : `${dates[0]} ~ ${dates[dates.length - 1]}`,
    product: pnames.length > 3 ? `${pnames.slice(0, 3).join("、")} 等${pnames.length}种` : pnames.join("、"),
    purchase_no: pns.length ? (pns.length === 1 ? pns[0] : `${pns[0]} 等${pns.length}个`) : "—",
    center: centers.length ? (centers.length === 1 ? centers[0] : `${centers[0]} 等${centers.length}个`) : "—",
  };
  // 批次毛利率按「本批次毛利 ÷ 本批次收入」重算，不是各条毛利率的平均
  g.profit_rate = g.amount ? (g.profit / g.amount) * 100 : 0;
  return g;
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
        cogs: x.g.cogs, freight: x.g.freight, pack_cost: x.g.pack_cost,
        fixed_total: x.g.fixed, profit: x.g.profit,
        profit_rate: x.g.profit_rate }
    : { _group: false, rec: x.rec, code: x.rec.code, date: x.rec.date, purchase_no: x.rec.purchase_no,
        center: x.rec.center, product: x.rec.product_name, quantity: x.rec.quantity, amount: x.rec.amount,
        cogs: x.rec.cogs, freight: x.rec.freight_total, pack_cost: x.rec.pack_cost,
        fixed_total: x.rec.fixed_total, profit: x.rec.profit,
        profit_rate: x.rec.profit_rate });
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
      `运费 <b>${fmtMoney(tot.freight)}</b> · 包材 <b>${fmtMoney(tot.pack_cost)}</b> · 固定成本 <b>${fmtMoney(tot.fixed || 0)}</b> · ` +
      `毛利 <b style="color:var(--green)">${fmtMoney(tot.profit)}</b> · 毛利率 <b style="color:var(--green)">${fmtNum(tot.profit_rate || 0)}%</b>`;
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
    <th data-key="fixed_total" class="num">固定成本${sortArrow("wInTable", "fixed_total")}</th>
    <th data-key="profit" class="num">毛利${sortArrow("wInTable", "profit")}</th>
    <th data-key="profit_rate" class="num">毛利率${sortArrow("wInTable", "profit_rate")}</th>
    <th></th></tr></thead><tbody>` +
    sortable.map((x) => x._group ? renderWinGroupRow(x.g) : renderWinRow(x.rec)).join("") + `</tbody>`;
  if (!rows.length) t.innerHTML = `<tr><td colspan="15" class="empty">该时间段暂无入仓记录，可点「导入${esc(WIN_SHEET)}」或「手动入仓」</td></tr>`;
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
      <div class="muted" style="font-size:12px;">${r.stock_product_name
        ? `${esc(r.stock_product_name)} · 净重 ${r.bag_weight ? `${fmtNum(r.bag_weight)} ${esc(r.stock_default_unit || "")}`.trim() : "—"} · 单位成本 ${fmtMoney(r.unit_cost)}/${esc(r.stock_default_unit || "单位")}`
        : `未关联库存商品（代发） · 每袋成本 ${fmtMoney(r.bag_cost)}/袋`}${r.deduction_percent ? ` · 扣点 ${fmtNum(r.deduction_percent)}%` : ""}</div>
      ${packTxt ? `<div class="muted" style="font-size:12px;">随货包材：${packTxt}</div>` : ""}
    </td>
    <td class="num mono">${fmtNum(r.quantity)}</td>
    <td class="num mono">${fmtMoney(r.amount)}</td>
    <td class="num mono">${fmtMoney(r.cogs)}</td>
    <td class="num mono">${r.freight_total ? fmtMoney(r.freight_total) : "—"}${r.freight_source === "actual"
      ? ' <span class="badge income" title="按运输账单（运输转运费）里的实际结算金额重算">实际</span>' : ""}</td>
    <td class="num mono">${r.pack_cost ? fmtMoney(r.pack_cost) : "—"}</td>
    <td class="num mono"${r.fixed_total ? "" : ' style="color:var(--muted);"'} title="${r.fixed_cost ? `每袋 ${fmtMoney(r.fixed_cost)} × ${fmtNum(r.quantity)} 袋` : "入仓品资料未维护固定成本"}">${r.fixed_total ? fmtMoney(r.fixed_total) : "—"}</td>
    <td class="num mono" style="color:${(r.profit || 0) >= 0 ? "var(--green)" : "var(--red)"}">${fmtMoney(r.profit)}</td>
    <td class="num mono" style="color:${(r.profit || 0) >= 0 ? "var(--green)" : "var(--red)"}">${fmtNum(r.profit_rate || 0)}%</td>
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
    <td class="num mono"${g.fixed ? "" : ' style="color:var(--muted);"'}>${g.fixed ? fmtMoney(g.fixed) : "—"}</td>
    <td class="num mono" style="color:${g.profit >= 0 ? "var(--green)" : "var(--red)"}">${fmtMoney(g.profit)}</td>
    <td class="num mono" style="color:${g.profit >= 0 ? "var(--green)" : "var(--red)"}">${fmtNum(g.profit_rate || 0)}%</td>
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
  if (!(await uiConfirm(`确认删除选中的 ${ids.length} 条入仓记录？`))) return;
  try {
    const r = await api("/api/warehouse-in/batch-delete", "POST", { ids });
    winSel.clear();
    toast(`已删除 ${r.deleted} 条`);
    loadWarehouseIns();
  } catch (e) { toast("删除失败：" + e.message); }
}
/* 打开批次二级页（默认按商品汇总，可切换为记录明细） */
function openWinGroup(groupKey) {
  WGROUP = (WINS || []).filter((r) => r.import_group === groupKey);
  if (!WGROUP.length) { toast("未找到该批次"); return; }
  WG_DETAIL = false;
  const t = $("wgTable");
  if (t) t._sort = null;
  goPage("wingroup");
}
/* 切换「按商品汇总 / 批次明细」视图 */
function toggleWinGroupMode() {
  WG_DETAIL = !WG_DETAIL;
  const t = $("wgTable");
  if (t) t._sort = null;   // 两种视图列不同，切换时清空排序避免错列
  renderWinGroupPage();
}
/* 按商品名汇总批次内记录：同类商品合并，不区分单号 / 采购单号 / 配送中心 */
function buildWinProductGroups(recs) {
  const map = new Map();
  for (const r of recs) {
    const key = r.product_name || "（未命名）";
    if (!map.has(key)) map.set(key, {
      product_name: key, count: 0, quantity: 0, box_count: 0,
      amount: 0, cogs: 0, freight_total: 0, pack_cost: 0, profit: 0,
      stock_product_name: r.stock_product_name || "", packs: new Map(),
    });
    const g = map.get(key);
    g.count += 1;
    g.quantity += r.quantity || 0;
    g.box_count += r.box_count || 0;
    g.amount += r.amount || 0;
    g.cogs += r.cogs || 0;
    g.freight_total += r.freight_total || 0;
    g.pack_cost += r.pack_cost || 0;
    g.profit += r.profit || 0;
    (r.pack_items || []).forEach((it) => {
      const k = `${it.name || "?"}|${it.unit || ""}`;
      g.packs.set(k, (g.packs.get(k) || 0) + (it.quantity || 0));
    });
  }
  return [...map.values()].map((g) => ({
    ...g,
    unit_price: g.quantity ? g.amount / g.quantity : 0,
    profit_rate: g.amount ? (g.profit / g.amount) * 100 : 0,
    pack_text: [...g.packs.entries()].map(([k, q]) => {
      const [name, unit] = k.split("|");
      return `${esc(name)}×${fmtNum(q)}${esc(unit)}`;
    }).join("、"),
  }));
}
/* 批次二级页渲染（支持表头排序） */
function renderWinGroupPage() {
  if (!WGROUP || !WGROUP.length) return;
  const g = buildWinGroup(WGROUP);
  const modeBtn = $("wgModeBtn");
  if (modeBtn) modeBtn.textContent = WG_DETAIL ? "按商品汇总" : "显示批次明细";
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
  if (!WG_DETAIL) { renderWinSummaryTable(t); return; }
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
    <th data-key="fixed_total" class="num">固定成本${sortArrow("wgTable", "fixed_total")}</th>
    <th data-key="profit" class="num">毛利${sortArrow("wgTable", "profit")}</th>
    <th data-key="profit_rate" class="num">毛利率${sortArrow("wgTable", "profit_rate")}</th>
    <th></th></tr></thead><tbody>` + rows.map((r) => `<tr>
    <td class="mono">${esc(r.code)}</td>
    <td>${esc(r.date)}</td>
    <td class="mono">${esc(r.purchase_no) || "—"}</td>
    <td>${esc(r.center) || "—"}</td>
    <td><b>${esc(r.product_name)}</b>
      <div class="muted" style="font-size:12px;">${r.stock_product_name
        ? `${esc(r.stock_product_name)} · 净重 ${r.bag_weight ? `${fmtNum(r.bag_weight)} ${esc(r.stock_default_unit || "")}`.trim() : "—"}`
        : `未关联库存商品（代发） · 每袋成本 ${fmtMoney(r.bag_cost)}/袋`}${r.deduction_percent ? ` · 扣点 ${fmtNum(r.deduction_percent)}%` : ""}</div>
      ${wInPackText(r) ? `<div class="muted" style="font-size:12px;">随货包材：${wInPackText(r)}</div>` : ""}</td>
    <td class="num mono">${fmtNum(r.quantity)}</td>
    <td class="num mono">${r.box_count ? fmtNum(r.box_count) : "—"}</td>
    <td class="num mono">${fmtMoney(r.unit_price)}</td>
    <td class="num mono">${fmtMoney(r.amount)}</td>
    <td class="num mono">${fmtMoney(r.cogs)}</td>
    <td class="num mono">${r.freight_total ? fmtMoney(r.freight_total) : "—"}${r.freight_source === "actual"
      ? ' <span class="badge income" title="按运输账单实际结算金额重算">实际</span>' : ""}</td>
    <td class="num mono">${r.pack_cost ? fmtMoney(r.pack_cost) : "—"}</td>
    <td class="num mono"${r.fixed_total ? "" : ' style="color:var(--muted);"'} title="${r.fixed_cost ? `每袋 ${fmtMoney(r.fixed_cost)} × ${fmtNum(r.quantity)} 袋` : "入仓品资料未维护固定成本"}">${r.fixed_total ? fmtMoney(r.fixed_total) : "—"}</td>
    <td class="num mono" style="color:${(r.profit || 0) >= 0 ? "var(--green)" : "var(--red)"}">${fmtMoney(r.profit)}</td>
    <td class="num mono" style="color:${(r.profit || 0) >= 0 ? "var(--green)" : "var(--red)"}">${fmtNum(r.profit_rate || 0)}%</td>
    <td style="white-space:nowrap;">
      <button class="btn sm" onclick="wInEdit(${r.id})">改</button>
      <button class="btn sm danger" onclick="wInDelete(${r.id})">删</button>
    </td></tr>`).join("") + `</tbody>`;
  t._rows = rows;
  t._render = renderWinGroupPage;
}
/* 默认视图：按商品名汇总（不区分单号 / 采购单号 / 配送中心） */
function renderWinSummaryTable(t) {
  const rows = applyTableSort(t, buildWinProductGroups(WGROUP));
  t.innerHTML = `<thead><tr>
    <th data-key="product_name">商品${sortArrow("wgTable", "product_name")}</th>
    <th data-key="count" class="num">记录数${sortArrow("wgTable", "count")}</th>
    <th data-key="quantity" class="num">数量(袋)${sortArrow("wgTable", "quantity")}</th>
    <th data-key="box_count" class="num">箱数${sortArrow("wgTable", "box_count")}</th>
    <th data-key="unit_price" class="num">采购价(收入/袋)${sortArrow("wgTable", "unit_price")}</th>
    <th data-key="amount" class="num">收入${sortArrow("wgTable", "amount")}</th>
    <th data-key="cogs" class="num">商品成本${sortArrow("wgTable", "cogs")}</th>
    <th data-key="freight_total" class="num">运费${sortArrow("wgTable", "freight_total")}</th>
    <th data-key="pack_cost" class="num">包材成本${sortArrow("wgTable", "pack_cost")}</th>
    <th data-key="fixed_total" class="num">固定成本${sortArrow("wgTable", "fixed_total")}</th>
    <th data-key="profit" class="num">毛利${sortArrow("wgTable", "profit")}</th>
    <th data-key="profit_rate" class="num">毛利率${sortArrow("wgTable", "profit_rate")}</th>
    </tr></thead><tbody>` + rows.map((r) => `<tr>
    <td><b>${esc(r.product_name)}</b>
      <div class="muted" style="font-size:12px;">${r.stock_product_name ? esc(r.stock_product_name) + " · " : ""}${r.count} 条记录 · 合计 ${fmtNum(r.quantity)} 袋</div>
      ${r.pack_text ? `<div class="muted" style="font-size:12px;">随货包材：${r.pack_text}</div>` : ""}</td>
    <td class="num mono">${r.count}</td>
    <td class="num mono">${fmtNum(r.quantity)}</td>
    <td class="num mono">${r.box_count ? fmtNum(r.box_count) : "—"}</td>
    <td class="num mono">${fmtMoney(r.unit_price)}</td>
    <td class="num mono">${fmtMoney(r.amount)}</td>
    <td class="num mono">${fmtMoney(r.cogs)}</td>
    <td class="num mono">${r.freight_total ? fmtMoney(r.freight_total) : "—"}</td>
    <td class="num mono">${r.pack_cost ? fmtMoney(r.pack_cost) : "—"}</td>
    <td class="num mono"${r.fixed_total ? "" : ' style="color:var(--muted);"'}>${r.fixed_total ? fmtMoney(r.fixed_total) : "—"}</td>
    <td class="num mono" style="color:${r.profit >= 0 ? "var(--green)" : "var(--red)"}">${fmtMoney(r.profit)}</td>
    <td class="num mono" style="color:${r.profit >= 0 ? "var(--green)" : "var(--red)"}">${fmtNum(r.profit_rate || 0)}%</td>
    </tr>`).join("") + `</tbody>`;
  t._rows = rows;
  t._render = renderWinGroupPage;
}
async function deleteWinGroup(groupKey) {
  const recs = (WINS || []).filter((r) => r.import_group === groupKey);
  if (!recs.length) { toast("未找到该批次"); return; }
  if (!(await uiConfirm(`确认删除该批次（共 ${recs.length} 条入仓记录）？`))) return;
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
      <div class="field"><label>固定成本（元/袋）</label><input id="wiFixedPPB" readonly title="来自入仓品资料（每袋打包费 / 难量化的包材或额外费用）" /></div>
      <div class="field"><label>固定成本合计</label><input id="wiFixedTotal" readonly /></div>
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
  sel.dataset.fixed = p0 ? (p0.fixed_cost || 0) : 0;
  wInCalc();
}
function wInPickProduct() {
  const sel = $("wiProduct");
  const p = (WPROD || []).find((x) => x.id === +sel.value);
  sel.dataset.uc = p ? (p.stock_unit_cost || 0) : 0;
  sel.dataset.fixed = p ? (p.fixed_cost || 0) : 0;
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
/** 每袋商品成本（元/袋）：与后端 warehouse_in._goods_bag_cost 同口径。
 *  关联库存商品 = 净重 × 库存单位成本；未关联（代发）= 入仓品手填的「代发成本」。 */
function wiBagCost(p, bw) {
  if (!p) return 0;
  if (!p.stock_product_id) return Number(p.dropship_cost) || 0;
  return (Number(bw) || 0) * (Number(p.stock_unit_cost) || 0);
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
  const bagCost = wiBagCost(p, bw);
  const revenue = qty * price * (1 - pct / 100);
  const cogs = qty * bagCost;   // 每袋商品成本 × 袋数（代发时即代发成本）
  const ft = qty * freight;
  const pe = wPackEstimate(p, qty);
  // 固定成本（元/袋，来自入仓品资料）：合计 = 袋数 × 每袋
  const fixedPPB = +(sel.dataset.fixed || (p ? p.fixed_cost : 0) || 0);
  const fixedTotal = qty * fixedPPB;
  $("wiAmount").value = revenue.toFixed(2);
  $("wiCogs").value = cogs.toFixed(2);
  $("wiFreightTotal").value = ft.toFixed(2);
  if ($("wiPackCost")) $("wiPackCost").value = pe.cost.toFixed(2);
  if ($("wiFixedPPB")) $("wiFixedPPB").value = fixedPPB.toFixed(2);
  if ($("wiFixedTotal")) $("wiFixedTotal").value = fixedTotal.toFixed(2);
  $("wiProfit").value = (revenue - cogs - ft - pe.cost - fixedTotal).toFixed(2);
  const hint = $("wiCostHint");
  if (hint) {
    const base = p && p.stock_product_id
      ? `收入 = 采购价 × (1 − 扣点${fmtNum(pct)}%)；成本来源：${p.stock_product_name}，单位成本 ${fmtMoney(uc)}/${p.stock_default_unit || "单位"}，每袋成本 ${fmtMoney(bagCost)}`
      : (p
        ? `扣点 ${fmtNum(pct)}%；未关联库存商品（代发）：每袋成本按入仓品的代发成本 ${fmtMoney(bagCost)}/袋 计`
        : `扣点 ${fmtNum(pct)}%；未选择入仓品：商品成本按 0 计。`);
    hint.textContent = `${base}；随货包材：${pe.text}（预估成本 ${fmtMoney(pe.cost)}）`
      + `；固定成本 ${fmtMoney(fixedPPB)}/袋 × ${fmtNum(qty)} 袋 = ${fmtMoney(fixedTotal)}`
      + `。毛利 = （收入单价 − 商品成本/袋 − 运费/袋 − 包材/袋 − 固定成本/袋）× 袋数`;
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
  if (!(await uiConfirm("确认删除该入仓记录？"))) return;
  try { await api("/api/warehouse-in/" + id, "DELETE"); toast("已删除"); refreshWinView(); }
  catch (e) { toast("删除失败：" + e.message); }
}

/* ---------- 导入《入仓配送明细》贴单（本分仓默认 常温贴单 / wh02 冷冻贴单） ---------- */
function openWarehouseInImport() {
  WIMPORT = null; WI_FILE = null;
  openModal(`
    <h3>导入《入仓配送明细》${esc(WIN_SHEET)} <button class="close" onclick="closeModal()">✕</button></h3>
    <p class="hint" style="margin-bottom:12px;">
      上传《入仓配送明细》后选择工作表（默认「${esc(WIN_SHEET)}」）；系统按每行「商品名称 + 数量」自动匹配入仓品，
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
    `<h3>导入《入仓配送明细》${esc(WIN_SHEET)} <button class="close" onclick="closeModal()">✕</button></h3>` +
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
  // 「自动」= 按当前分仓选表（奥斯迪/昆明蔬菜仓=常温贴单，wh02=冷冻贴单）
  const sheets = `<option value="" ${d.sheet_auto ? "selected" : ""}>自动（按分仓：常温贴单 / 冷冻贴单）</option>`
    + (d.sheets || []).map((s) => `<option ${(!d.sheet_auto && s === d.sheet) ? "selected" : ""}>${esc(s)}</option>`).join("");
  const opts = (selId) => ['<option value="">（不关联）</option>']
    .concat((WPROD || []).map((x) => `<option value="${x.id}" ${selId === x.id ? "selected" : ""}>${esc(x.name)}</option>`)).join("");
  const rows = d.items || [];
  box.innerHTML = `
    <div class="toolbar" style="margin:12px 0 8px;">
      <label class="muted">工作表</label>
      <select id="wiSheetSel" onchange="wImportPreview(this.value)">${sheets}</select>
      <label class="muted">日期</label>
      <input id="wiImportDate" type="date" value="${esc(dateVal || d.date || today())}" />
      <span class="muted">工作表 <b>${esc(d.sheet || "")}</b>${d.sheet_auto ? "（按分仓自动）" : ""} · 解析 <b>${rows.length}</b> 行 · 匹配 <b>${d.matched ?? 0}</b>${d.unmatched ? ` · <span style="color:var(--red)">未匹配 ${d.unmatched}</span>` : ""}${d.failed_count ? `（<span style="color:var(--red)">${d.failed_count} 行异常</span>）` : ""}</span>
      <div class="grow"></div>
      <span class="muted" id="wiImportTotal"></span>
    </div>
    <div class="table-wrap" style="max-height:46vh;overflow:auto;">
      <table id="wiImportTable">
        <thead><tr>
          <th>商品名称（贴单）</th><th>入仓品</th><th class="num">箱数</th><th class="num">数量(袋)</th>
          <th class="num">每袋净重</th><th class="num">采购价(收入)</th><th class="num">运费</th><th class="num">商品成本</th><th class="num">包材成本</th><th class="num">固定成本</th>
        </tr></thead>
        <tbody>${rows.map((r, i) => `<tr data-i="${i}" data-uc="${r.unit_cost || 0}" data-pct="${r.deduction_percent || 0}" data-pid="${r.product_id || ""}" data-fx="${r.fixed_cost || 0}">
          <td>${esc(r.product_name)}
            <div class="muted" style="font-size:12px;">${esc(r.purchase_no) || "—"} · ${esc(r.center) || "—"}${r.matched_sku ? ` · SKU ${esc(r.matched_sku)}` : ""}</div>
          </td>
          <td><select class="wi-prod" onchange="wImportPick(${i})">${opts(r.product_id)}</select>
            <div class="muted" style="font-size:12px;">${esc(r.stock_product_name) || `未关联库存商品（代发 ${fmtMoney(r.bag_cost || 0)}/袋）`}${r.deduction_percent ? ` · 扣点 ${fmtNum(r.deduction_percent)}%` : ""}</div>
            <div class="muted wi-pack" style="font-size:12px;"></div></td>
          <td><input class="wi-box" type="number" step="any" min="0" value="${r.box_count || ""}" style="width:58px;" /></td>
          <td><input class="wi-qty" type="number" step="any" min="0" value="${r.quantity}" style="width:68px;" oninput="wImportCalc()" /></td>
          <td><input class="wi-weight" type="number" step="any" min="0" value="${r.bag_weight || ""}" style="width:72px;" oninput="wImportCalc()" /></td>
          <td><input class="wi-price" type="number" step="any" min="0" value="${r.unit_price || ""}" style="width:70px;" oninput="wImportCalc()" /></td>
          <td><input class="wi-freight" type="number" step="any" min="0" value="${r.freight || ""}" style="width:64px;" oninput="wImportCalc()" /></td>
          <td class="num mono wi-cogs">—</td>
          <td class="num mono wi-packcost">—</td>
          <td class="num mono wi-fixedcost">—</td>
        </tr>`).join("")}</tbody>
      </table>
    </div>
    ${d.failed_count ? `<div class="alert err" style="margin-top:8px;">${d.failed.map((f) => `${f.sheet ? `【${esc(f.sheet)}】` : ""}第 ${f.row || "—"} 行：${esc(f.reason)}`).join("<br>")}</div>` : ""}
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
  tr.dataset.fx = p ? (p.fixed_cost || 0) : 0;
  if (p) {
    tr.querySelector(".wi-price").value = p.purchase_price || "";
    tr.querySelector(".wi-freight").value = p.freight || "";
    if (p.bag_weight) tr.querySelector(".wi-weight").value = p.bag_weight;
    const sub = tr.querySelector("td:nth-child(2) .muted");
    if (sub) sub.textContent = (p.stock_product_name || `未关联库存商品（代发 ${fmtMoney(p.dropship_cost || 0)}/袋）`) + (WIN_DEDUCT ? ` · 扣点 ${fmtNum(WIN_DEDUCT)}%` : "");
  }
  wImportCalc();
}
function wImportCalc() {
  let rev = 0, cogs = 0, ft = 0, packc = 0, fxSum = 0, qtySum = 0;
  document.querySelectorAll("#wiImportTable tbody tr").forEach((tr) => {
    const q = parseFloat(tr.querySelector(".wi-qty").value) || 0;
    const pr = parseFloat(tr.querySelector(".wi-price").value) || 0;
    const fr = parseFloat(tr.querySelector(".wi-freight").value) || 0;
    const fxPPB = parseFloat(tr.dataset.fx) || 0;   // 固定成本（元/袋，来自入仓品资料）
    const fx = fxPPB * q;
    const bw = parseFloat(tr.querySelector(".wi-weight").value) || 0;
    const pct = +(tr.dataset.pct || 0);
    const pid = +tr.dataset.pid || null;
    const p = (WPROD || []).find((x) => x.id === pid);
    const pe = wPackEstimate(p, q);
    const rowCogs = q * wiBagCost(p, bw);   // 代发（未关联库存）时 = 数量 × 代发成本
    const cell = tr.querySelector(".wi-cogs");
    if (cell) cell.textContent = fmtMoney(rowCogs);
    const pc = tr.querySelector(".wi-packcost");
    if (pc) pc.textContent = pe.cost ? fmtMoney(pe.cost) : "—";
    const fc = tr.querySelector(".wi-fixedcost");
    if (fc) fc.textContent = fx ? fmtMoney(fx) : "—";
    const packSub = tr.querySelector(".wi-pack");
    if (packSub) packSub.textContent = pe.text !== "—" ? `随货包材：${pe.text}` : "";
    rev += q * pr * (1 - pct / 100); cogs += rowCogs; ft += q * fr; packc += pe.cost; fxSum += fx; qtySum += q;
  });
  const el = $("wiImportTotal");
  if (el) el.innerHTML = `数量 <b>${fmtNum(qtySum)}</b> 袋 · 收入 <b>${fmtMoney(rev)}</b> · 成本 <b>${fmtMoney(cogs)}</b> · 运费 <b>${fmtMoney(ft)}</b> · 包材 <b>${fmtMoney(packc)}</b> · 固定成本 <b>${fmtMoney(fxSum)}</b> · 毛利 <b style="color:var(--green)">${fmtMoney(rev - cogs - ft - packc - fxSum)}</b>`;
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

/* ---------- 重算运费：按京东《运输转运费》账单里的实际结算金额重算命中采购单 ----------
   口径（与后端 routers/warehouse_in.py 的 /freight/* 一致）：
   - 账单按「采购单号」对上入仓记录；命中的记录运费 = 该采购单在账单里的结算金额合计（可勾选费用类型）；
   - 一个采购单有多条入仓记录时按「袋数」分摊（尾差由后端补到袋数最多的一条）；
   - 未命中的记录保持「入仓品资料」的每袋运费不动；重算过的记录运费列显示「实际」徽标。 */
let FR_DATA = null;        // 账单预览结果
let FR_OFF = new Set();    // 被取消勾选的费用类型名（默认全部计入）

function openFreightRecalc() {
  FR_DATA = null; FR_OFF = new Set();
  openModal(`
    <h3>重算运费 <button class="close" onclick="closeModal()">✕</button></h3>
    <p class="hint" style="margin-bottom:12px;">
      上传京东《运输转运费》账单（含「采购单号 / 费用类型 / 结算金额」列）。
      系统按<b>采购单号</b>对上入仓记录：命中的记录运费改成账单里的<b>实际结算金额</b>
      （同一采购单有多条记录时按袋数分摊）；未命中的记录保持「入仓品资料」的每袋运费不动。
    </p>
    <div class="form-grid">
      <div class="field"><label>运输账单 *</label><input type="file" id="frFile" accept=".xlsx" /></div>
    </div>
    <div class="modal-foot">
      <button class="btn secondary" onclick="closeModal()">取消</button>
      <button class="btn" onclick="frParse()">解析预览</button>
    </div>`);
}

async function frParse() {
  const f = $("frFile")?.files[0];
  if (!f) { toast("请先选择运输账单 Excel"); return; }
  $("modalBox").classList.add("wide");
  $("modalBox").innerHTML = `<h3>重算运费 <button class="close" onclick="closeModal()">✕</button></h3>
    <div class="alert ok">⏳ 正在解析账单…</div>`;
  try {
    const fd = new FormData();
    fd.append("file", f);
    const res = await fetch(routePath("/api/warehouse-in/freight/preview"), { method: "POST", body: fd });
    if (res.status === 401) { showLogin(); return; }
    if (!res.ok) { let m = "解析失败"; try { m = (await res.json()).detail || m; } catch (e) {} throw new Error(m); }
    FR_DATA = await res.json();
    FR_OFF = new Set();
    renderFrPreview();
  } catch (e) {
    $("modalBox").innerHTML = `<h3>重算运费 <button class="close" onclick="closeModal()">✕</button></h3>
      <div class="alert err">解析失败：${esc(e.message)}</div>
      <div class="modal-foot"><button class="btn secondary" onclick="openFreightRecalc()">重新选择文件</button></div>`;
  }
}

/** 某个采购单当前计入的实际运费（按勾选的费用类型累加） */
function frPoTotal(po) {
  let t = 0;
  Object.entries(po.by_type || {}).forEach(([k, v]) => { if (!FR_OFF.has(k)) t += Number(v) || 0; });
  return Math.round(t * 100) / 100;
}
function frToggleTypeByIdx(i, cb) {
  const name = ((FR_DATA?.fee_types || [])[i] || {}).name;
  if (!name) return;
  if (cb.checked) FR_OFF.delete(name); else FR_OFF.add(name);
  renderFrPreview();
}
function frTypeAll(on) {
  FR_OFF = new Set();
  if (!on) (FR_DATA?.fee_types || []).forEach((t) => FR_OFF.add(t.name));
  renderFrPreview();
}

function renderFrPreview() {
  const d = FR_DATA || {};
  const po = d.purchase_orders || [];
  const un = d.unmatched_excel || [];
  const feeTypes = d.fee_types || [];
  const typeRow = feeTypes.map((t, i) => `<label class="fr-type ${FR_OFF.has(t.name) ? "off" : ""}">
      <input type="checkbox" ${FR_OFF.has(t.name) ? "" : "checked"} onchange="frToggleTypeByIdx(${i}, this)" />
      ${esc(t.name)} <b>${fmtMoney(t.amount)}</b></label>`).join("");
  const sumNew = po.reduce((s, x) => s + frPoTotal(x), 0);
  const sumOld = po.reduce((s, x) => s + (x.old_freight_total || 0), 0);
  const delta = sumNew - sumOld;
  const rows = po.map((x) => {
    const amt = frPoTotal(x);
    const diff = amt - (x.old_freight_total || 0);
    const records = (x.records || []).map((r) => `${esc(r.product_name)}×${fmtNum(r.quantity)}袋`).join("、");
    return `<tr data-pn="${esc(x.purchase_no)}" data-old="${x.old_freight_total || 0}" data-bags="${x.bags || 0}">
      <td class="mono">${esc(x.purchase_no)}${x.waybills && x.waybills.length
        ? `<div class="muted" style="font-size:11px;">${esc(x.waybills[0])}</div>` : ""}</td>
      <td class="num mono">${x.record_count}</td>
      <td class="num mono">${fmtNum(x.bags)}</td>
      <td class="num"><input class="fr-amt" type="number" step="0.01" min="0" value="${amt.toFixed(2)}" oninput="frRecalc()" style="width:104px;text-align:right;" /></td>
      <td class="num mono fr-perbag">${x.bags ? fmtMoney(amt / x.bags) : "—"}</td>
      <td class="num mono">${fmtMoney(x.old_freight_total)}</td>
      <td class="num mono fr-diff" style="color:${diff >= 0 ? "var(--red)" : "var(--green)"}">${diff >= 0 ? "+" : ""}${fmtMoney(diff)}</td>
      <td class="muted" style="font-size:11px;max-width:260px;">${records}</td>
    </tr>`;
  }).join("");
  $("modalBox").innerHTML = `<h3>重算运费 — 账单预览 <button class="close" onclick="closeModal()">✕</button></h3>
    <div class="alert ${po.length ? "ok" : "err"}">
      账单 <b>${esc(d.sheet || "")}</b>（${d.rows || 0} 行明细）· 命中 <b>${po.length}</b> 个采购单 /
      <b>${(d.totals || {}).records || 0}</b> 条入仓记录 / <b>${fmtNum((d.totals || {}).bags || 0)}</b> 袋；
      运费 <b>${fmtMoney(sumOld)}</b> → <b id="frSumNew">${fmtMoney(sumNew)}</b>
      <span id="frSumDiff" style="color:${delta >= 0 ? "var(--red)" : "var(--green)"}">（${delta >= 0 ? "+" : ""}${fmtMoney(delta)}）</span>
      ${un.length ? `<div class="muted" style="margin-top:4px;">
        另有 <b>${un.length}</b> 个采购单在入仓记录里没找到：${un.slice(0, 6).map((x) => esc(x.purchase_no)).join("、")}${un.length > 6 ? " 等" : ""}
        ${(d.unmatched_record_count || 0) ? `；入仓记录里还有 ${d.unmatched_record_count} 个采购单不在本账单（保持不变）` : ""}
      </div>` : ""}
    </div>
    <div class="fr-types">
      <div class="row wrap" style="gap:6px;align-items:center;">
        <span class="muted">费用类型（勾选=计入实际运费）</span>
        <button class="btn sm secondary" onclick="frTypeAll(true)">全选</button>
        <button class="btn sm secondary" onclick="frTypeAll(false)">全不选</button>
      </div>
      <div style="margin-top:6px;">${typeRow || "—"}</div>
    </div>
    ${po.length ? `<div class="table-wrap" style="max-height:44vh;overflow:auto;">
      <table class="subtable" id="frTable">
        <thead><tr>
          <th>采购单号</th><th class="num">记录</th><th class="num">袋数</th>
          <th class="num">账单金额</th><th class="num">每袋</th><th class="num">原运费</th><th class="num">差额</th><th>入仓记录（按袋数分摊）</th>
        </tr></thead><tbody>${rows}</tbody>
      </table></div>`
      : `<div class="alert warn">没有命中的采购单：账单里的「采购单号」和入仓记录对不上（按全部入仓记录匹配，不受页面筛选影响）。</div>`}
    <div class="modal-foot">
      <button class="btn secondary" onclick="openFreightRecalc()">重新选择文件</button>
      <button class="btn green" onclick="frApply()" ${po.length ? "" : "disabled"}>✓ 确认重算（${po.length} 个采购单）</button>
    </div>`;
}

/** 手改某个采购单的账单金额后，重算「每袋 / 差额 / 合计」（分摊规则仍按袋数，由后端落库） */
function frRecalc() {
  let sumNew = 0, sumOld = 0;
  document.querySelectorAll("#frTable tbody tr").forEach((tr) => {
    const bags = parseFloat(tr.dataset.bags) || 0;
    const amt = parseFloat(tr.querySelector(".fr-amt").value) || 0;
    const old = parseFloat(tr.dataset.old) || 0;
    const per = tr.querySelector(".fr-perbag");
    if (per) per.textContent = bags ? fmtMoney(amt / bags) : "—";
    const diff = amt - old;
    const dc = tr.querySelector(".fr-diff");
    if (dc) {
      dc.textContent = (diff >= 0 ? "+" : "") + fmtMoney(diff);
      dc.style.color = diff >= 0 ? "var(--red)" : "var(--green)";
    }
    sumNew += amt; sumOld += old;
  });
  const sn = $("frSumNew");
  if (sn) sn.textContent = fmtMoney(sumNew);
  const sd = $("frSumDiff");
  if (sd) {
    const delta = sumNew - sumOld;
    sd.textContent = `（${delta >= 0 ? "+" : ""}${fmtMoney(delta)}）`;
    sd.style.color = delta >= 0 ? "var(--red)" : "var(--green)";
  }
}

async function frApply() {
  const rows = [...document.querySelectorAll("#frTable tbody tr")];
  const items = rows.map((tr) => ({
    purchase_no: tr.dataset.pn,
    total: Math.round((parseFloat(tr.querySelector(".fr-amt").value) || 0) * 100) / 100,
  }));
  if (!items.length) { toast("没有可重算的采购单"); return; }
  const oldSum = rows.reduce((s, tr) => s + (parseFloat(tr.dataset.old) || 0), 0);
  const newSum = items.reduce((s, x) => s + x.total, 0);
  const delta = newSum - oldSum;
  if (!(await uiConfirm(`确认按账单重算 ${items.length} 个采购单的运费？\n运费合计：${fmtMoney(oldSum)} → ${fmtMoney(newSum)}（${delta >= 0 ? "+" : ""}${fmtMoney(delta)}）\n未命中的记录保持不变。`))) return;
  try {
    const r = await api("/api/warehouse-in/freight/apply", "POST", { items });
    toast(`已重算 ${r.purchase_orders} 个采购单 / ${r.records} 条记录：运费 ${fmtMoney(r.old_freight)} → ${fmtMoney(r.new_freight)}`);
    closeModal();
    loadWarehouseIns();
  } catch (e) { toast("重算失败：" + e.message); }
}

function loadImportPage() {}

