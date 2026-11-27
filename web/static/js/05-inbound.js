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

/** 一行 = 原来那张完整入库单（商品/单位/数量/单价/金额/调整/运费/装卸费/手续费/供应商/日期/操作员/付款状态/备注附件） */
function inboundBlockHtml(idx) {
  return `<div class="in-block" data-idx="${idx}">
    <div class="in-block-head">
      <span class="muted">第 ${idx} 张入库单</span>
      <div class="grow"></div>
      <button class="btn sm danger in-block-del" onclick="removeInboundBlock(this)">删除</button>
    </div>
    <div class="form-grid compact-grid">
      <div class="field">
        <label>商品 *</label>
        <input class="in-pick-name" readonly placeholder="＋ 点击选择商品" onclick="openInboundPicker(this)" style="cursor:pointer;background:var(--primary-50);" />
        <div class="field-hint in-stock-hint"></div>
      </div>
      <div class="field"><label>进货单位 *</label><select class="in-unit" onchange="inBlockUnitChanged(this)"></select><div class="field-hint in-unit-hint"></div></div>
      <div class="field"><label>数量 *</label><input class="in-qty" type="number" min="0" step="any" placeholder="0（仅记费用填0）" oninput="calcInboundBlock(this)" /></div>
      <div class="field"><label>单价 *</label><input class="in-price" type="number" min="0" step="any" placeholder="0.00" oninput="calcInboundBlock(this)" /><div class="field-hint in-price-hint"></div></div>
      <div class="field"><label>金额</label><input class="in-amount" readonly /></div>
      <div class="field"><label>供应商</label><input class="in-supplier" placeholder="供应商名称" /></div>
      <div class="field"><label>日期 *</label><input class="in-date" type="date" /></div>
      <div class="field"><label>操作员</label><input class="in-operator" readonly /></div>
      <div class="field in-pay-field">
        <label>付款状态</label>
        ${inboundPayRadios("inPay_" + idx, "paid", 0, "")}
      </div>
    </div>
    <details class="adv-fold" style="margin-top:10px;">
      <summary>附加费用与备注附件（调整 / 运费 / 装卸费 / 手续费）</summary>
      <div class="form-grid compact-grid" style="margin-top:10px;">
        <div class="field"><label>金额调整（正加负减）</label><input class="in-adjust" type="number" step="any" placeholder="0.00" oninput="calcInboundBlock(this)" /><div class="field-hint in-adjust-hint"></div></div>
        <div class="field"><label>运费</label><input class="in-freight" type="number" min="0" step="any" placeholder="0.00" oninput="calcInboundBlock(this)" /><div class="field-hint in-freight-hint"></div></div>
        <div class="field"><label>装卸费</label><input class="in-handling" type="number" min="0" step="any" placeholder="0.00" oninput="calcInboundBlock(this)" /></div>
        <div class="field"><label>转账手续费</label><input class="in-fee" type="number" min="0" step="any" placeholder="0.00" oninput="calcInboundBlock(this)" /></div>
      </div>
      <div class="field" style="margin-top:8px;">
        <label>备注与附件</label>
        <textarea id="inRemark_${idx}" rows="1" placeholder="可选（支持 Ctrl+V 粘贴图片）" onpaste="pasteRemarkFiles('inRemark_${idx}', event)"></textarea>
        <div class="attach-bar">
          <button type="button" class="btn sm secondary" onclick="$('inRemarkFile_${idx}').click()"><svg class="ic"><use href="#i-paperclip"/></svg> 添加附件</button>
          <input type="file" id="inRemarkFile_${idx}" multiple style="display:none;" onchange="uploadRemarkFiles('inRemark_${idx}', this)" />
        </div>
        <div class="attach-list" id="inRemark_${idx}Files"></div>
      </div>
    </details>
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

/** 这一行的付款情况：应付 = 货款＋调整＋运费装卸手续费；已付按付款状态取（部分付款取弹开的已付金额） */
function inPaySummary(block) {
  const due = payDueOf(block);
  const status = payOf("inPay_" + (block.dataset.idx || "")) || "paid";
  let paid = due;
  if (status === "unpaid") paid = 0;
  else if (status === "partial") {
    const box = block.querySelector(".pay-part");
    const v = parseFloat(((box && box.querySelector(".pp-paid")) || {}).value) || 0;
    paid = Math.min(Math.max(v, 0), due);
  }
  return { due: round2(due), paid: round2(paid), unpaid: round2(due - paid), status };
}

/** 单行小计：已付款→实付；部分付款→应付/已付/未付；待付款→应付（进待付款账单） */
function renderInboundSum(b) {
  const sum = b.querySelector(".in-block-sum");
  if (!sum) return;
  const p = PRODUCTS.find((x) => x.id === +(b.dataset.pid || 0));
  if (!p) { sum.textContent = ""; return; }
  const unit = (b.querySelector(".in-unit") || {}).value || "";
  const qty = parseFloat((b.querySelector(".in-qty") || {}).value) || 0;
  const price = parseFloat((b.querySelector(".in-price") || {}).value) || 0;
  const base = qty * price;
  const adj = parseFloat((b.querySelector(".in-adjust") || {}).value) || 0;
  const fee = (parseFloat((b.querySelector(".in-freight") || {}).value) || 0)
    + (parseFloat((b.querySelector(".in-handling") || {}).value) || 0)
    + (parseFloat((b.querySelector(".in-fee") || {}).value) || 0);
  const info = inPaySummary(b);
  let tail = ` ＝ 实付 ${fmtMoney(info.due)}`;
  if (info.status === "partial") {
    tail = ` ＝ 应付 ${fmtMoney(info.due)}（已付 ${fmtMoney(info.paid)}，未付 ${fmtMoney(info.unpaid)} 进待付款账单）`;
  } else if (info.status === "unpaid") {
    tail = ` ＝ 应付 ${fmtMoney(info.due)}（待付款，进待付款账单）`;
  }
  sum.textContent = `本单：${fmtNum(qty)}${unit} × ${unit ? fmtMoney(price) : ""} = 货款 ${fmtMoney(base)}`
    + (fee ? ` ＋ 运费/装卸/手续费 ${fmtMoney(fee)}` : "")
    + (adj ? ` ${adj > 0 ? "＋" : "－"} 调整 ${fmtMoney(Math.abs(adj))}` : "")
    + tail;
}

/** 底部合计（统计选了商品、且（填了数量 或 填了运费等开支）的行） */
function updateInboundTotal() {
  const el = $("inTotal");
  if (!el) return;
  let n = 0, goods = 0, fee = 0, adj = 0, due = 0, paid = 0, unpaid = 0;
  inboundBlocks().forEach((b) => {
    if (!+(b.dataset.pid || 0)) return;
    const qty = parseFloat((b.querySelector(".in-qty") || {}).value) || 0;
    const feeRow = (parseFloat((b.querySelector(".in-freight") || {}).value) || 0)
      + (parseFloat((b.querySelector(".in-handling") || {}).value) || 0)
      + (parseFloat((b.querySelector(".in-fee") || {}).value) || 0);
    // 数量 0 但有运费/装卸/手续费 → 也算一张「只记开支」的入库单
    if (!(qty > 0) && feeRow <= 0) return;
    n++;
    goods += qty * (parseFloat((b.querySelector(".in-price") || {}).value) || 0);
    fee += feeRow;
    adj += parseFloat((b.querySelector(".in-adjust") || {}).value) || 0;
    const info = inPaySummary(b);
    due += info.due;
    paid += info.paid;
    unpaid += info.unpaid;
  });
  if (!n) { el.style.display = "none"; el.innerHTML = ""; return; }
  el.style.display = "block";
  el.innerHTML = `本次填了 <b>${n}</b> 张入库单：货款 <b>¥${goods.toFixed(2)}</b>`
    + (fee ? ` ＋ 运费/装卸/手续费 <b>¥${fee.toFixed(2)}</b>` : "")
    + (adj ? ` ${adj > 0 ? "＋" : "－"} 调整 <b>¥${Math.abs(adj).toFixed(2)}</b>` : "")
    + (unpaid > 0.005
      ? ` ＝ 应付 <b>¥${due.toFixed(2)}</b>，其中已付 <b>¥${paid.toFixed(2)}</b>、未付 <b>¥${unpaid.toFixed(2)}</b>（进待付款账单）`
      : ` ＝ 实付 <b>¥${due.toFixed(2)}</b>`)
    + ` <span class="muted">（没选商品、也没填运费等开支的行不会入库）</span>`;
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
    + (parseFloat((b.querySelector(".in-handling") || {}).value) || 0)
    + (parseFloat((b.querySelector(".in-fee") || {}).value) || 0);
  const amt = b.querySelector(".in-amount");
  if (amt) amt.value = base.toFixed(2);
  const setHint = (sel, html) => { const e = b.querySelector(sel); if (e) e.innerHTML = html; };
  setHint(".in-adjust-hint", adj
    ? `实付 ¥${(base + adj).toFixed(2)}（商品金额 ¥${base.toFixed(2)} ${adj > 0 ? "+" : "-"} ${Math.abs(adj).toFixed(2)}）· 差额记「金额调整」其他收支`
    : "正=多付，负=少付；差额自动记「金额调整」其他收支，商品成本不变");
  setHint(".in-freight-hint", fee > 0
    ? (qty > 0
      ? `批次成本 ¥${(base + fee).toFixed(2)}（商品 ${base.toFixed(2)} + 运费/装卸/手续费 ${fee.toFixed(2)}）· 毛利随销量扣减，并同步记入「其他收支」`
      : "数量为 0：只把运费/装卸/手续费记入「其他收支」开支，不入库存、不进批次成本")
    : "计入该批次成本 → 体现在这个品的毛利；并自动记入「其他收支」备查");
  const factor = p && unit ? (p.conversions || {})[unit] : null;
  setHint(".in-unit-hint", factor ? `1${esc(unit)} = ${fmtNum(factor)} ${esc(p.base_unit)}` : "");
  syncPartialPay(b);   // 应付合计变了：部分付款的比例 / 未付跟着重算（要先算，下面小计才读得到已付）
  renderInboundSum(b); // 本单小计：已付款=实付；部分付款=应付/已付/未付
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
      <input id="spSearch" placeholder="🔍 搜索商品名称 / 分类…（「；」任一命中，「：」同时命中）" oninput="renderInboundPicker()" />
      <select id="spType" style="display:none;"><option value="">全部类型</option><option value="stock">库存商品</option></select>
      <select id="spCat" class="searchable" onchange="renderInboundPicker()"><option value="">全部分类</option>${cats.map((c) => `<option value="${esc(c)}">${esc(c)}</option>`).join("")}</select>
    </div>
    <div class="sp-list" id="spList" style="max-height:52vh;overflow-y:auto;"></div>`);
  renderInboundPicker();
}
function renderInboundPicker() {
  const kws = splitSearchKeywords($("spSearch")?.value);
  const cat = $("spCat")?.value || "";
  const rows = inboundProducts().filter((p) =>
    searchHit(`${p.name} ${p.category || ""}`, kws) &&
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
/* 入库单价变动二次确认：本次录入价与「该商品最近一次入库价」不同时，列出差异让用户确认。
   PRODUCTS.last_in_price 是「每基础单位」价格，比较前先按本次单位换算。 */
function inboundPriceWarnings(items) {
  const out = [];
  (items || []).forEach((it) => {
    const pid = +(it.product_id || 0);
    if (!pid) return;
    const cur = Number(it.unit_price);
    if (!isFinite(cur) || cur <= 0) return;   // 未填价（AI 识别允许留空）不提示，提交后再补
    const p = PRODUCTS.find((x) => x.id === pid);
    if (!p) return;
    const u = it.unit || defaultUnit(p);
    const lastBase = Number(p.last_in_price) || 0;
    if (!(lastBase > 0)) return;               // 该商品还没入过库，不提示
    const f = (p.conversions || {})[u] || 1;
    const last = +(lastBase * f).toFixed(6);
    if (Math.abs(cur - last) <= 1e-4) return;  // 只差浮点误差，视为同价
    const pct = last ? (cur - last) / last * 100 : 0;
    out.push(`${p.name}：最近入库 ¥${fmtNum(last)}/${u}（${p.last_in_date || "日期未知"}）`
      + ` → 本次 ¥${fmtNum(cur)}/${u}（${pct >= 0 ? "涨" : "降"} ${Math.abs(pct).toFixed(1)}%）`);
  });
  return out;
}
function priceConfirmText(warnings, prefix) {
  const list = warnings.slice(0, 10);
  const more = warnings.length > list.length ? `\n…另有 ${warnings.length - list.length} 个商品存在差异` : "";
  return `⚠ 入库单价与最近一次入库价不同：\n\n${list.join("\n")}${more}\n\n`
    + (prefix ? prefix + "\n\n" : "")
    + "确认价格无误、仍按本次单价入库吗？";
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
    const fee = parseFloat((b.querySelector(".in-fee") || {}).value) || 0;
    const date = ((b.querySelector(".in-date") || {}).value || "").trim();
    const unit = ((b.querySelector(".in-unit") || {}).value || "").trim();
    const feeSum = round2(freight + handling + fee);
    // 没选商品的行直接跳过（当没填）；选了商品就得填全，否则报出来
    if (!pid) { if (qty > 0 || feeSum > 0) bad.push(`第 ${no} 行没选商品`); return; }
    if (!unit) { bad.push(`第 ${no} 行没选单位`); return; }
    const q = isNaN(qty) ? 0 : qty;
    if (q < 0) { bad.push(`第 ${no} 行数量不能为负数`); return; }
    // 数量 0 = 只记运费/装卸费等开支（不入库存），此时至少要填一项费用
    if (q <= 0 && feeSum <= 0) { bad.push(`第 ${no} 行数量为 0 时请填运费/装卸费/手续费（只记开支）`); return; }
    if (q > 0 && isNaN(price)) { bad.push(`第 ${no} 行没填单价`); return; }
    if (!date) { bad.push(`第 ${no} 行没选日期`); return; }
    if (freight < 0 || handling < 0 || fee < 0) { bad.push(`第 ${no} 行运费/装卸费/手续费不能为负`); return; }
    const idx = b.dataset.idx || no;
    // 部分付款：已付金额必须大于 0 且小于应付合计（等于 0 / 填满都该选「待付款」/「已付款」）
    const payStatus = payOf("inPay_" + idx);
    const due = payDueOf(b);
    let paidAmount = 0;
    if (payStatus === "partial") {
      paidAmount = round2(parseFloat((b.querySelector(".pp-paid") || {}).value) || 0);
      if (!(paidAmount > 0)) { bad.push(`第 ${no} 行选了「部分付款」，请填已付金额（应付 ¥${due.toFixed(2)}）`); return; }
      if (paidAmount >= due - 0.005) { bad.push(`第 ${no} 行已付金额已够 ¥${due.toFixed(2)}，付款状态请选「已付款」`); return; }
    }
    items.push({
      product_id: pid, unit, quantity: q, unit_price: isNaN(price) ? 0 : price,
      supplier: ((b.querySelector(".in-supplier") || {}).value || "").trim(),
      operator: ((b.querySelector(".in-operator") || {}).value || "").trim() || operatorName(),
      date, remark: remarkValue("inRemark_" + idx),
      pay_status: payStatus, paid_amount: paidAmount,
      adjust_amount: adjust, freight, handling, fee,
    });
    picked.push({ block: b, idx, pay_name: "inPay_" + idx });
  });
  if (bad.length) { toast(bad[0] + (bad.length > 1 ? ` 等 ${bad.length} 处要改` : "")); return; }
  if (!items.length) { toast("请先选商品并填数量（只记运费时数量填 0 并填运费）"); return; }

  const goods = items.reduce((a, it) => a + it.quantity * it.unit_price, 0);
  const fee = items.reduce((a, it) => a + it.freight + it.handling + it.fee, 0);
  const adj = items.reduce((a, it) => a + it.adjust_amount, 0);
  const priceWarn = inboundPriceWarnings(items);
  if (priceWarn.length && !(await uiConfirm(priceConfirmText(priceWarn, `共 ${items.length} 行待入库`)))) return;
  const alertBox = $("inAlert");
  if (alertBox) { alertBox.style.display = "none"; alertBox.innerHTML = ""; }
  try {
    const r = await api("/api/inbounds/batch", "POST", { items });
    const tips = [];
    if (r.created) tips.push(`已入库 ${r.created} 张单（货款 ¥${goods.toFixed(2)}${fee ? ` + 运费/装卸/手续费 ¥${fee.toFixed(2)}` : ""}${adj ? ` ${adj > 0 ? "+" : "-"} 调整 ¥${Math.abs(adj).toFixed(2)}` : ""}）`);
    if (r.failed_count) tips.push(`${r.failed_count} 行失败`);
    if (items.some((it) => it.pay_status === "unpaid")) tips.push("待付款已进「待付款账单」");
    if (items.some((it) => it.pay_status === "partial")) tips.push("部分付款的未付余额已进「待付款账单」");
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
        ["in-qty", "in-price", "in-amount", "in-adjust", "in-freight", "in-handling", "in-fee"].forEach((cls) => {
          const el = b.querySelector("." + cls);
          if (el) el.value = "";
        });
        clearRemarkField("inRemark_" + p.idx);
        setPay(p.pay_name, "paid");   // 回到默认「已付款」
        const part = b.querySelector(".pay-part");   // 部分付款那组输入也收起来、清空
        if (part) {
          part.style.display = "none";
          part.querySelectorAll("input").forEach((x) => { x.value = ""; });
        }
        calcInboundBlock(b);
      });
      // 清完的空行（没商品、没数量）收掉，只留一行空的
      const empties = inboundBlocks().filter((b) => !+(b.dataset.pid || 0));
      if (empties.length > 1) empties.slice(1).forEach((b) => b.remove());
      syncInboundBlocks();
      if (!r.failed_count && typeof closeDrawer === "function") closeDrawer("inboundDrawer");
      loadInbounds(); loadStock();
      // 刷新商品缓存：下次选这个商品时会带上「这次录入的价」（最近价实时跟着变）
      api("/api/products").then((ps) => { PRODUCTS = ps; }).catch(() => {});
    }
  } catch (e) { toast("入库失败：" + e.message); }
}
/** 入库记录汇总数字：页顶汇总条与表格页脚共用（数量按单位分组，金额按应付口径） */
function inboundSum(rows) {
  const num = (v) => Number(v) || 0;
  const sum = (k) => rows.reduce((a, r) => a + num(r[k]), 0);
  // 数量按单位分组：公斤/箱/袋不能直接相加，分别累计
  const qtyMap = new Map();
  rows.forEach((r) => {
    const u = (r.unit || "").trim();
    qtyMap.set(u, (qtyMap.get(u) || 0) + num(r.quantity));
  });
  const adjust = sum("adjust_amount");
  const freight = sum("freight");
  const handling = sum("handling");
  const fee = sum("fee");
  return {
    qtyText: [...qtyMap.entries()].map(([u, q]) => `${fmtNum(q)}${u ? " " + u : ""}`).join(" / ") || "0",
    goods: sum("total_amount"),          // 货款
    adjust, freight, handling, fee,
    due: sum("due_amount"),              // 应付合计（货款 + 调整 + 运费 + 装卸 + 手续费）
    paid: sum("paid_amount"),
    unpaid: sum("unpaid_amount"),
    pend: rows.filter((r) => (r.pay_status || "paid") !== "paid").length,
    extras: [
      adjust ? `调整 ${adjust > 0 ? "+" : "-"}${fmtMoney(Math.abs(adjust))}` : "",
      freight ? `运费 ${fmtMoney(freight)}` : "",
      handling ? `装卸 ${fmtMoney(handling)}` : "",
      fee ? `手续费 ${fmtMoney(fee)}` : "",
    ].filter(Boolean).join(" · "),
  };
}

/** 入库记录：筛选后实时汇总（页顶汇总条 + 表格页脚共用同一组数字） */
function renderInSum(rows, allCount, active, from, to) {
  const el = $("inSum");
  if (!el) return;
  const s = inboundSum(rows);
  const range = (from || to) ? `日期 ${from || "最早"} ~ ${to || "最新"}` : "";
  const kwRaw = $("inSearch") ? $("inSearch").value.trim() : "";
  const cond = [range, kwRaw ? `关键词「${kwRaw}」` : ""].filter(Boolean).join(" + ");
  el.innerHTML =
    `<span class="pay-sum-label">${active ? "筛选结果" : "当前列表"}</span>` +
    `<span><b>${rows.length}</b> 笔${rows.length === allCount ? "" : ` <span class="muted">/ 共 ${allCount} 笔</span>`}</span>` +
    `<span>数量合计 <b class="mono">${s.qtyText}</b></span>` +
    `<span class="pay-sum-total">合计（应付）<b class="mono">${fmtMoney(s.due)}</b></span>` +
    `<span class="muted">已付 <b class="mono" style="color:var(--green, #16a34a);">${fmtMoney(s.paid)}</b>`
    + ` ／ 未付 <b class="mono" style="color:var(--danger, #dc2626);">${fmtMoney(s.unpaid)}</b>`
    + (s.pend ? `（待结算 ${s.pend} 笔）` : "") + `</span>` +
    `<span class="muted">货款 <b class="mono">${fmtMoney(s.goods)}</b>${s.extras ? ` · ${s.extras}` : ""}</span>` +
    `<span class="grow"></span>` +
    (active && cond ? `<span class="muted">已按 ${cond} 筛选</span>` : "");
}

async function loadInbounds() {
  const from = $("inDateFrom").value, to = $("inDateTo").value;
  const all = await api(`/api/inbounds?date_from=${from || ""}&date_to=${to || ""}`);
  const kws = splitSearchKeywords($("inSearch")?.value);
  let rows = all;
  if (kws.length) rows = rows.filter((r) => searchHit([r.code, r.product_name, r.supplier, r.operator].join(" "), kws));
  const t = $("inTable");
  rows = applyTableSort(t, rows);
  const active = !!(kws.length || from || to);
  $("inListHint").textContent = kws.length
    ? `筛选出 ${rows.length} 条 / 共 ${all.length} 条`
    : `共 ${all.length} 条`;
  const s = inboundSum(rows);   // 页脚与页顶汇总条用同一组数字（排序不影响合计）
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
      <td>${fmtNum(r.quantity)} ${r.unit}${!(Number(r.quantity) > 0) ? ` <span class="badge" title="数量为 0：只记录运费/装卸费等开支，不入库存">仅开支</span>` : ""}</td>
      <td class="num mono">${fmtMoney(r.unit_price)}/${r.unit}</td>
      <td class="num mono">${fmtMoney(r.final_amount != null ? r.final_amount : r.total_amount)}${r.adjust_amount ? `<div class="muted" style="font-size:11px;">调整 ${r.adjust_amount > 0 ? "+" : "-"}${fmtMoney(Math.abs(r.adjust_amount))}</div>` : ""}${(r.freight || r.handling || r.fee) ? `<div class="muted" style="font-size:11px;" title="${Number(r.quantity) > 0 ? "已计入批次成本（体现在该品毛利），并同步「其他收支」备查" : "数量为 0：仅记入「其他收支」开支，不入库存成本"}">${[r.freight ? "运费 " + fmtMoney(r.freight) : "", r.handling ? "装卸 " + fmtMoney(r.handling) : "", r.fee ? "手续费 " + fmtMoney(r.fee) : ""].filter(Boolean).join(" · ")}</div>` : ""}${r.pay_status === "partial" ? `<div class="muted" style="font-size:11px;" title="应付合计 ${fmtMoney(r.due_amount)}">已付 ${fmtMoney(r.paid_amount)} · 未付 ${fmtMoney(r.unpaid_amount)}</div>` : ""}${r.compensation ? `<div class="muted" style="font-size:11px;" title="供应商补偿：已记「其他收支 → 供应商补偿」负数行，冲减期间费用、计入财务报表净利">补偿 -${fmtMoney(r.compensation)}</div>` : ""}</td>
      <td>${esc(r.supplier) || "—"}</td>
      <td>${esc(r.operator) || "—"}</td>
      <td>${r.date}</td>
      <td class="muted" style="max-width:150px;">${renderRemarkHtml(r.remark)}</td>
      <td style="white-space:nowrap;"><button class="btn sm secondary" onclick="editInbound(${r.id})">改</button> <button class="btn sm danger" onclick="deleteInbound(${r.id})">删</button></td></tr>`).join("") + `</tbody>` +
    (rows.length
      ? `<tfoot><tr>
          <td></td>
          <td colspan="2"><b>${active ? "筛选合计" : "列出合计"}</b></td>
          <td class="num mono">${s.qtyText}</td>
          <td></td>
          <td class="num mono"><b>应付 ${fmtMoney(s.due)}</b><div class="muted" style="font-size:11px;font-weight:400;">已付 ${fmtMoney(s.paid)} · 未付 ${fmtMoney(s.unpaid)}</div></td>
          <td colspan="5" class="muted">货款 ${fmtMoney(s.goods)}${s.extras ? ` · ${s.extras}` : ""}</td>
        </tr></tfoot>`
      : "");
  t._rows = rows;
  t._render = loadInbounds;
  renderInSum(rows, all.length, active, from, to);
  updateBatchBar("in");
}
async function deleteInbound(id) {
  if (!(await uiConfirm("确认删除该入库单？将回退库存与成本。"))) return;
  try { await api("/api/inbounds/" + id, "DELETE"); toast("已删除"); loadInbounds(); loadStock(); }
  catch (e) { toast("删除失败：" + e.message); }
}
/* 手动修改入库单：可改 数量 / 单价 / 供应商 / 入库日期 / 付款状态 / 运费 / 装卸费 / 手续费；
   数量、单价改动会先核算影响范围（这批货是否已被出库/包装消耗用到）：
   - 未被用到 → 提示「可快速更改」，直接改；
   - 已被用到 → 列出受影响的出库单（成本前后），确认后按 FIFO 重算这些订单的成本与毛利 */
let ED_IN_ADJUST = 0;   // 改单弹窗里的金额调整（应付合计 = 货款 + 调整 + 运费 + 装卸 + 手续费）
let ED_IN = null;           // 正在修改的入库单原值（数量 / 单价 / 日期）
let ED_IN_IMPACT = null;    // 最近一次影响评估结果
let ED_IN_IMPACT_KEY = "";  // 评估对应的输入指纹（数量|单价|日期）
let ED_IN_TIMER = null;

function editInbound(id) {
  const r = ($("inTable")._rows || []).find((x) => x.id === id);
  if (!r) { toast("未找到该入库单，请刷新列表"); return; }
  ED_IN_ADJUST = Number(r.adjust_amount) || 0;
  ED_IN = {
    id, quantity: Number(r.quantity) || 0, unit_price: Number(r.unit_price) || 0,
    date: r.date || "", total_amount: Number(r.total_amount) || 0,
    freight: Number(r.freight) || 0, handling: Number(r.handling) || 0, fee: Number(r.fee) || 0,
  };
  ED_IN_IMPACT = null;
  ED_IN_IMPACT_KEY = "";
  const unit = esc(r.unit || "");
  openModal(`
    <h3>修改入库单 <button class="close" onclick="closeModal()">✕</button></h3>
    <div class="muted" style="margin-bottom:12px;">
      ${esc(r.code)} · ${esc(r.product_name)} ${fmtNum(r.quantity)}${unit} · 金额 ${fmtMoney(r.total_amount)}${r.adjust_amount ? `（调整 ${r.adjust_amount > 0 ? "+" : "-"}${fmtMoney(Math.abs(r.adjust_amount))}）` : ""}
    </div>
    <div class="form-grid">
      <div class="field">
        <label>数量（${unit}）*</label>
        <input id="edInQty" type="number" min="0" step="any" value="${r.quantity}" oninput="edInChanged()" />
        <div class="field-hint">按单据单位；数量填 0 = 只记运费/装卸费等开支，不入库存</div>
      </div>
      <div class="field">
        <label>单价（元/${unit}）*</label>
        <input id="edInPrice" type="number" min="0" step="any" value="${r.unit_price}" oninput="edInChanged()" />
        <div class="field-hint">改数量/单价会先核算影响范围，已有出库用到这批货时会列出受影响的订单</div>
      </div>
      <div class="field" style="grid-column:1/-1;"><div id="edInImpact"></div></div>
      <div class="field"><label>供应商</label><input id="edInSupplier" value="${esc(r.supplier || "")}" placeholder="供应商名称" /></div>
      <div class="field"><label>入库日期 *</label><input id="edInDate" type="date" value="${esc(r.date || "")}" onchange="edInChanged()" /></div>
      <div class="field">
        <label>运费</label>
        <input id="edInFreight" type="number" min="0" step="any" value="${r.freight || ""}" placeholder="0.00" oninput="edInChanged()" />
        <div class="field-hint">选填；计入该批次成本（体现在这个品的毛利），并同步记入「其他收支」</div>
      </div>
      <div class="field">
        <label>装卸费</label>
        <input id="edInHandling" type="number" min="0" step="any" value="${r.handling || ""}" placeholder="0.00" oninput="edInChanged()" />
        <div class="field-hint">选填；日期随入库单日期，清零即删掉对应的「其他收支」</div>
      </div>
      <div class="field">
        <label>手续费</label>
        <input id="edInFee" type="number" min="0" step="any" value="${r.fee || ""}" placeholder="0.00" oninput="edInChanged()" />
        <div class="field-hint">选填；付款给供应商产生的转账手续费，同运费计入成本</div>
      </div>
      <div class="field">
        <label>供应商补偿</label>
        <input id="edInComp" type="number" min="0" step="any" value="${r.compensation || ""}" placeholder="0.00" oninput="edInCompHint()" />
        <div class="field-hint" id="edInCompHint"></div>
      </div>
      <div class="field" style="grid-column:1/-1;">
        <label>付款状态</label>
        ${inboundPayRadios("edInPay", r.pay_status, r.paid_amount || 0,
          "待付款：先进「待付款账单」，点「已支付」后才计入财务报表；部分付款：已付部分计入报表，未付余额留在待付款账单",
          round2((r.total_amount || 0) + (r.adjust_amount || 0) + (r.freight || 0) + (r.handling || 0) + (r.fee || 0)))}
      </div>
    </div>
    <p class="hint" id="edInHint"></p>
    <p class="hint">保存后操作员记为当前登录账号（${esc(operatorName())}）。商品如需更换请删除后重新入库；数量 / 单价可直接修改（保存前会先核算影响范围，已有出库用到这批货时列出受影响订单并重算成本）。</p>
    <div class="modal-foot">
      <button class="btn secondary" onclick="closeModal()">取消</button>
      <button class="btn green" onclick="saveInboundEdit(${id})">✓ 保存</button>
    </div>`);
  edInCalc();
  edInCompHint();
  previewInboundEdit(true);   // 打开就先算一遍：是「可快速更改」还是「会影响哪些单」
}

/** 弹窗里的数量 / 单价（按单据单位） */
function edInQtyPrice() {
  const qty = parseFloat($("edInQty")?.value);
  const price = parseFloat($("edInPrice")?.value);
  return { qty: Number.isFinite(qty) ? qty : 0, price: Number.isFinite(price) ? price : 0 };
}
/** 本单货款 = 数量 × 单价（改数量/单价时随时更新） */
function edInTotal() {
  const q = edInQtyPrice();
  return round2(q.qty * q.price);
}
/** 数量/单价/日期改动：刷新成本提示，并防抖核算影响范围 */
function edInChanged() {
  edInCalc();
  clearTimeout(ED_IN_TIMER);
  ED_IN_TIMER = setTimeout(() => previewInboundEdit(true), 400);
}

/** 调后端核算影响范围（不落库）；返回影响评估结果，失败返回 null */
async function previewInboundEdit(silent) {
  const box = $("edInImpact");
  if (!box || !ED_IN) return null;
  const { qty, price } = edInQtyPrice();
  const freight = parseFloat($("edInFreight")?.value) || 0;
  const handling = parseFloat($("edInHandling")?.value) || 0;
  const fee = parseFloat($("edInFee")?.value) || 0;
  const feeSum = round2(freight + handling + fee);
  const feeOnly = !(ED_IN.quantity > 0);   // 原单就是零数量的「只记开支」单
  let err = "";
  if (!(qty >= 0)) err = "数量不能为负数";
  else if (price < 0) err = "单价不能为负数";
  else if (qty === 0 && !feeOnly) err = "已有库存的入库单数量必须大于 0";
  else if (qty === 0 && feeSum <= 0) err = "数量为 0 时请至少填运费/装卸费/手续费";
  if (err) {
    ED_IN_IMPACT = null;
    ED_IN_IMPACT_KEY = "";
    box.innerHTML = `<div class="alert err">${err}</div>`;
    return null;
  }
  const date = $("edInDate")?.value || "";
  const key = `${qty}|${price}|${date}|${freight}|${handling}|${fee}`;
  if (key === ED_IN_IMPACT_KEY && ED_IN_IMPACT) return ED_IN_IMPACT;
  box.innerHTML = `<div class="muted" style="font-size:12px;padding:6px 0;">正在核算影响范围…</div>`;
  try {
    const r = await api(`/api/inbounds/${ED_IN.id}/impact?quantity=${qty}&unit_price=${price}`
      + `&date=${encodeURIComponent(date)}&freight=${freight}&handling=${handling}&fee=${fee}`);
    ED_IN_IMPACT = r;
    ED_IN_IMPACT_KEY = key;
    renderInboundImpact(r);
    return r;
  } catch (e) {
    ED_IN_IMPACT = null;
    ED_IN_IMPACT_KEY = "";
    box.innerHTML = `<div class="alert err">影响核算失败：${esc(e.message)}</div>`;
    if (!silent) toast("影响核算失败：" + e.message);
    return null;
  }
}

/** 影响范围面板：可快速更改（绿）/ 会影响 N 张出库单（黄，列出成本变化） */
function renderInboundImpact(r) {
  const box = $("edInImpact");
  if (!box) return;
  const bu = esc(r.base_unit || "");
  const du = esc(r.unit || bu);
  const f = Number(r.unit_factor) || 1;   // 基础单位 → 单据单位的换算系数（库存/均价按单据单位展示更好读）
  const money = (v) => fmtMoney(v || 0);
  const deltaTxt = (v) => `${v >= 0 ? "+" : "-"}${fmtMoney(Math.abs(v || 0))}`;
  const summary =
    `<div class="muted" style="font-size:12px;line-height:1.8;">
      本单金额 ${money(r.old_total_amount)} → <b>${money(r.new_total_amount)}</b>（${deltaTxt(r.amount_delta)}）<br />
      库存 ${fmtNum(r.stock_before / f)} ${du} → <b>${fmtNum(r.stock_after / f)} ${du}</b>；
      均价 ${money(r.avg_cost_before * f)}/${du} → ${money(r.avg_cost_after * f)}/${du}
    </div>`;
  const warns = (r.warnings || []).length
    ? `<div style="margin-top:6px;color:var(--danger,#dc2626);font-size:12px;">⚠ ${(r.warnings || []).map(esc).join("；")}</div>`
    : "";
  if (!r.used && !r.affected_count) {
    box.innerHTML = `<div class="alert ok"><b>可快速更改</b>：这批货还没有被出库/包装消耗用到，修改不会影响任何订单成本。${summary}${warns}</div>`;
    return;
  }
  if (!r.affected_count) {
    box.innerHTML = `<div class="alert ok"><b>这批货已有出库用到</b>，但按当前的改动，订单结转成本没有变化（改动未改变实际耗用成本）。${summary}${warns}</div>`;
    return;
  }
  const rows = (r.affected_outbounds || []).map((o) => `<tr>
      <td class="mono">${esc(o.code)}</td><td>${esc(o.date)}</td><td>${esc(o.customer) || "—"}</td>
      <td class="num mono">${money(o.cogs_before)} → ${money(o.cogs_after)}</td>
      <td class="num mono" style="color:${o.delta > 0 ? "var(--danger,#dc2626)" : o.delta < 0 ? "var(--green,#16a34a)" : ""}">${deltaTxt(o.delta)}</td>
    </tr>`).join("");
  box.innerHTML = `<div class="alert warn">
      <b>会影响 ${r.affected_count} 张出库单</b>，保存后会按 FIFO 重新结转成本并重算这些订单的毛利：
      <div style="max-height:180px;overflow:auto;margin-top:8px;">
        <table style="width:100%;border-collapse:collapse;font-size:12px;">
          <thead><tr class="muted"><th align="left">单号</th><th align="left">日期</th><th align="left">客户</th><th align="right">成本</th><th align="right">变化</th></tr></thead>
          <tbody>${rows}</tbody>
        </table>
      </div>
      ${r.affected_count > (r.affected_outbounds || []).length ? `<div class="muted" style="font-size:12px;margin-top:4px;">以上为前 ${(r.affected_outbounds || []).length} 单，共 ${r.affected_count} 单会重算</div>` : ""}
      ${summary}${warns}
    </div>`;
}

/** 供应商补偿的实时说明：记一笔负数的其他收支，冲减期间费用、计入报表净利 */
function edInCompHint() {
  const el = $("edInCompHint");
  if (!el) return;
  const v = parseFloat($("edInComp")?.value) || 0;
  el.innerHTML = v > 0
    ? `保存后自动记一笔「其他收支 → 供应商补偿 <b class="mono">-¥${fmtMoney(v)}</b>」（日期=入库日期，已付款），冲减期间费用、计入财务报表净利；不改货款与批次成本`
    : "选填：供应商退的钱 / 赔偿。保存后自动记一笔负数的其他收支计入财务报表；填 0 或清空即取消";
}

/** 改单时实时显示「货款 + 运费 + 装卸 + 手续费 = 批次到岸成本」，避免改完不知道成本变成多少 */
function edInCalc() {
  const el = $("edInHint");
  if (!el) return;
  const total = edInTotal();
  const fee = (parseFloat($("edInFreight")?.value) || 0) + (parseFloat($("edInHandling")?.value) || 0)
    + (parseFloat($("edInFee")?.value) || 0);
  el.innerHTML = fee > 0
    ? (total > 0
      ? `批次成本 = 货款 ${fmtMoney(total)} + 运费/装卸/手续费 ${fmtMoney(fee)} = <b>${fmtMoney(total + fee)}</b>（按 FIFO 随销量扣减，同步更新该品毛利与「其他收支」）`
      : `数量为 0：运费/装卸/手续费 <b>${fmtMoney(fee)}</b> 只记「其他收支」开支，不入库存、不进批次成本`)
    : "不填=没有运费/装卸/手续费（对应「其他收支」里的运费、装卸费、转账手续费记录会一并清掉）";
  // 运费/装卸费/手续费改了，部分付款的应付合计跟着变（已付金额不动，未付/比例重算）
  const box = document.querySelector("#modalBox .pay-part");
  if (box) {
    box.dataset.due = String(round2(total + ED_IN_ADJUST + fee));
    if (box.style.display !== "none") applyPartialPay(box);
  }
}
async function saveInboundEdit(id) {
  const date = $("edInDate").value;
  if (!date) { toast("请选择入库日期"); return; }
  const { qty, price } = edInQtyPrice();
  if (!(qty >= 0)) { toast("数量不能为负数"); return; }
  if (!(price >= 0)) { toast("单价不能为负数"); return; }
  const freight = parseFloat($("edInFreight").value) || 0;
  const handling = parseFloat($("edInHandling").value) || 0;
  const fee = parseFloat($("edInFee")?.value) || 0;
  if (freight < 0 || handling < 0 || fee < 0) { toast("运费 / 装卸费 / 手续费不能为负数"); return; }
  // 数量 0 = 只记开支：只允许原本就是零数量的单，且必须留一项费用
  const feeOnly = !!ED_IN && !(ED_IN.quantity > 0);
  if (qty === 0) {
    if (!feeOnly) { toast("已有库存的入库单数量必须大于 0；要撤销这笔入库请删除该单"); return; }
    if (round2(freight + handling + fee) <= 0) { toast("数量为 0 时请至少填运费/装卸费/手续费"); return; }
  }
  const qtyChanged = !!ED_IN
    && (Math.abs(qty - ED_IN.quantity) > 1e-9 || Math.abs(price - ED_IN.unit_price) > 1e-9);
  const dateChanged = !!ED_IN && date !== ED_IN.date;
  const feeChanged = !!ED_IN
    && (Math.abs(freight - ED_IN.freight) > 1e-9
      || Math.abs(handling - ED_IN.handling) > 1e-9
      || Math.abs(fee - ED_IN.fee) > 1e-9);
  // 改数量/单价/日期/费用：保存前再核算一次影响范围，有受影响的订单就先让用户确认
  let impact = null;
  if (qtyChanged || dateChanged || feeChanged) {
    impact = await previewInboundEdit(false);
    if (!impact) { toast("影响核算失败，请重试"); return; }
    const warnTxt = (impact.warnings || []).join("；");
    if (impact.affected_count > 0) {
      const list = (impact.affected_outbounds || []).slice(0, 8)
        .map((o) => `${o.code}（${o.date}${o.customer ? " · " + o.customer : ""}，成本 ${o.delta >= 0 ? "+" : "-"}${fmtMoney(Math.abs(o.delta))}）`)
        .join("\n");
      const more = impact.affected_count > 8 ? `\n…等共 ${impact.affected_count} 张` : "";
      if (!(await uiConfirm(`该批次已被出库使用，保存后会重算 ${impact.affected_count} 张出库单的成本与毛利：\n${list}${more}\n\n确认修改？`))) return;
    } else if (warnTxt && !(await uiConfirm(`注意：${warnTxt}\n\n确认继续？`))) {
      return;
    }
  }
  const compensation = round2(parseFloat($("edInComp")?.value) || 0);
  if (compensation < 0) { toast("供应商补偿不能为负数"); return; }
  // 部分付款：已付金额要大于 0 且小于应付合计
  const payStatus = payOf("edInPay");
  const partBox = document.querySelector("#modalBox .pay-part");
  const due = round2(partBox && partBox.dataset.due ? parseFloat(partBox.dataset.due) : 0);
  let paidAmount = 0;
  if (payStatus === "partial") {
    paidAmount = round2(parseFloat((partBox.querySelector(".pp-paid") || {}).value) || 0);
    if (!(paidAmount > 0)) { toast(`部分付款请填已付金额（应付 ¥${due.toFixed(2)}）`); return; }
    if (paidAmount >= due - 0.005) { toast(`已付金额已够 ¥${due.toFixed(2)}，付款状态请选「已付款」`); return; }
  }
  try {
    const payload = {
      supplier: $("edInSupplier").value, date, pay_status: payStatus, paid_amount: paidAmount,
      freight, handling, fee, compensation,
    };
    if (qtyChanged) { payload.quantity = qty; payload.unit_price = price; }
    await api(`/api/inbounds/${id}`, "PUT", payload);
    closeModal();
    toast(`已保存，操作员记为 ${operatorName()}`
      + (qtyChanged ? "；数量/单价已更新" : "")
      + (impact && impact.affected_count ? `；已重算 ${impact.affected_count} 张出库单成本` : "")
      + (freight + handling + fee > 0
        ? (qty > 0
          ? `；运费/装卸/手续费 ${fmtMoney(freight + handling + fee)} 已计入成本`
          : `；运费/装卸/手续费 ${fmtMoney(freight + handling + fee)} 已记入「其他收支」`)
        : "")
      + (compensation > 0 ? `；供应商补偿 ¥${fmtMoney(compensation)} 已计入财务报表` : ""));
    loadInbounds();
    loadStock();   // 成本变了，库存列表的均价/货值跟着刷新
    api("/api/products").then((ps) => { PRODUCTS = ps; }).catch(() => {});   // 参考成本/均价缓存同步
  } catch (e) { toast("保存失败：" + e.message); }
}

