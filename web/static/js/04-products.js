/* =============== 备份与恢复 =============== */
async function loadBackupPage() {
  try {
    const d = await api("/api/backups");
    $("bkEnabled").checked = !!d.config.enabled;
    $("bkInterval").value = d.config.interval_hours;
    $("bkKeep").value = d.config.keep;
    $("bkRemoteEnabled").checked = !!d.config.remote_enabled;
    $("bkJsonEnabled").checked = d.config.json_backup_enabled !== false;
    $("bkRemoteUrl").value = d.config.remote_url || "";
    toggleRemoteBackup();
    let s = d.config.enabled
      ? `自动备份已开启：每 ${d.config.interval_hours} 小时一次，保留最近 ${d.config.keep} 份`
      : "自动备份已关闭";
    if (d.config.remote_enabled && d.config.remote_url) {
      s += `；远程备份已开启 → ${d.config.remote_url}（远程保留 ${d.config.remote_keep || 100} 份）`;
      const rs = d.remote_status || {};
      if (rs.time) s += `｜上次推送 ${rs.time}：${rs.ok ? "成功" : "失败 " + (rs.message || "")}`;
    }
    const jb = (d.json_backups || [])[0];
    if (d.config.json_backup_enabled !== false) {
      s += jb
        ? `｜json 目录：最近 ${jb.mtime}（${jb.size_human}，共 ${d.json_backups.length} 份）`
        : "｜json 目录：暂无备份（内容无变化时不生成）";
    }
    $("bkStatus").textContent = s;
    renderBkTable(d.backups || []);
  } catch (e) { toast("加载备份失败：" + e.message); }
}
/* 远程备份：勾选后展开地址输入与部署脚本下载区 */
function toggleRemoteBackup() {
  const on = $("bkRemoteEnabled").checked;
  $("bkRemoteBox").style.display = on ? "" : "none";
}
/* 下载远程接收端部署/停止脚本（后端生成，含端口/路径/密钥） */
async function downloadRemoteScript(kind) {
  const isStop = kind === "stop";
  const url = routePath("/api/backup/remote/" + (isStop ? "stop-script" : "deploy-script"));
  const filename = isStop ? "stop_erp_backup_receiver.sh" : "deploy_erp_backup_receiver.sh";
  try {
    if (!isStop && !$("bkRemoteUrl").value.trim()) { toast("请先填写目标服务器地址"); return; }
    const res = await fetch(url);
    if (res.status === 401) { showLogin(); return; }
    if (!res.ok) throw new Error("HTTP " + res.status);
    const text = await res.text();
    const blob = new Blob([text], { type: "text/x-shellscript;charset=utf-8" });
    const a = document.createElement("a");
    a.href = URL.createObjectURL(blob);
    a.download = filename;
    document.body.appendChild(a);
    a.click();
    setTimeout(() => { URL.revokeObjectURL(a.href); a.remove(); }, 200);
    toast(`已下载 ${filename}，上传到备份服务器执行即可`);
  } catch (e) { toast("下载失败：" + e.message); }
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
    toast(r.json_backup ? `备份成功：${r.name}＋${r.json_backup}` : "备份成功：" + r.name);
    renderBkTable(r.backups || []);
    loadBackupPage();
  } catch (e) { toast("备份失败：" + e.message); }
}
async function saveBkConfig() {
  const remoteEnabled = $("bkRemoteEnabled").checked;
  const remoteUrl = $("bkRemoteUrl").value.trim();
  if (remoteEnabled && !remoteUrl) { toast("请填写目标服务器地址，如 1.2.3.4:8080/cloudback"); return; }
  try {
    await api("/api/backup/config", "POST", {
      enabled: $("bkEnabled").checked,
      interval_hours: +$("bkInterval").value || 2,
      keep: +$("bkKeep").value || 30,
      remote_enabled: remoteEnabled,
      remote_url: remoteUrl,
      remote_keep: 100,
      json_backup_enabled: $("bkJsonEnabled").checked,
    });
    toast("自动备份设置已保存");
    loadBackupPage();
  } catch (e) { toast("保存失败：" + e.message); }
}
async function restoreBackup(name) {
  if (!(await uiConfirm(`确认用「${name}」恢复？\n当前数据库将被该备份覆盖，且不可撤销。`))) return;
  if (!(await uiConfirm("再次确认：恢复会覆盖现有全部数据，建议先「立即备份」一份。确定继续？"))) return;
  try {
    const r = await api("/api/backup/restore", "POST", { name });
    toast("恢复成功，正在刷新数据…");
    setTimeout(() => location.reload(), 800);
  } catch (e) { toast("恢复失败：" + e.message); }
}
async function deleteBackup(name) {
  if (!(await uiConfirm(`确认删除备份「${name}」？`))) return;
  try {
    const r = await api("/api/backup/" + encodeURIComponent(name), "DELETE");
    toast("已删除备份");
    renderBkTable(r.backups || []);
  } catch (e) { toast("删除失败：" + e.message); }
}

/* =============== 设置 · 商品资料备份（解耦 JSON） =============== */
const PDATA_KINDS = {
  units: "units.json", products_stock: "products_stock.json",
  products_order: "products_order.json", pack_rules: "pack_rules.json",
  code_mappings: "code_mappings.json",
};
async function loadPdataPage() {
  try {
    const s = await api("/api/product-data/status");
    $("pdataDir").textContent = "json 目录：" + s.dir;
    renderPdataTable(s.rows || []);
  } catch (e) { toast("加载商品资料状态失败：" + e.message); }
}
function renderPdataTable(rows) {
  $("pdataTable").innerHTML = `<thead><tr>
    <th>类型</th><th>json 文件</th><th class="num">库内数</th><th class="num">json 数</th><th>备份状态</th><th>操作</th>
  </tr></thead><tbody>` +
    (rows.length ? rows.map((r) => {
      const state = !r.exists
        ? `<span class="badge">未备份</span>`
        : `<span class="badge" style="background:var(--ok,#16a34a);color:#fff;">已备份 ${esc(r.mtime || "")}</span>`;
      return `<tr>
        <td>${esc(r.label)}</td>
        <td class="mono">${esc(r.file)}</td>
        <td class="num mono">${r.count_in_db}</td>
        <td class="num mono">${r.exists ? r.count_in_file : "-"}</td>
        <td>${state}</td>
        <td class="line-actions">
          <button class="btn sm secondary" onclick="pdataDownload('${r.kind}')">下载</button>
          <button class="btn sm" ${r.exists ? "" : "disabled"} onclick="pdataImportOne('${r.kind}')">导入</button>
        </td>
      </tr>`;
    }).join("") : `<tr><td colspan="6" class="empty">暂无数据</td></tr>`) + `</tbody>`;
}
async function pdataExportAll() {
  try {
    const r = await api("/api/product-data/export", "POST");
    toast("已导出 " + (r.files || []).length + " 个 json 到服务器目录");
    loadPdataPage();
  } catch (e) { toast("导出失败：" + e.message); }
}
async function pdataImportAll() {
  if (!(await uiConfirm("从 json 目录一键导入全部 5 类？将按名称新增/更新（upsert），不会删除已有数据。"))) return;
  try {
    const r = await api("/api/product-data/import", "POST");
    renderPdataImportResult(r.results || []);
    loadPdataPage();
    ensureUnits(0);   // 导入的 units.json 可能带进新单位，刷新前端缓存
  } catch (e) { toast("导入失败：" + e.message); }
}
async function pdataImportOne(kind) {
  if (!(await uiConfirm("从 json 目录导入「" + kind + "」？将按名称新增/更新，不会删除已有数据。"))) return;
  try {
    const r = await api("/api/product-data/import/" + kind, "POST");
    renderPdataImportResult([r]);
    loadPdataPage();
    ensureUnits(0);   // 导入的 units.json 可能带进新单位，刷新前端缓存
  } catch (e) { toast("导入失败：" + e.message); }
}
function renderPdataImportResult(results) {
  const rows = (results || []).map((s) => `<tr>
    <td>${esc(s.label)}</td>
    <td class="num">${s.created || 0} 新增</td>
    <td class="num">${s.updated || 0} 更新</td>
    <td>${s.loaded === false ? '<span class="badge">未加载</span>' : ""}
      ${(s.warnings || []).map((w) => `<div class="hint">${esc(w)}</div>`).join("")}</td>
  </tr>`).join("");
  $("pdataResult").innerHTML = `<div class="alert ok">导入完成</div>
    <div class="table-wrap"><table>
      <thead><tr><th>类型</th><th class="num">新增</th><th class="num">更新</th><th>备注</th></tr></thead>
      <tbody>${rows}</tbody></table></div>`;
  bindSearchable($("pdataResult"));
}
async function pdataDownload(kind) {
  try {
    const data = await api("/api/product-data/" + kind);
    if (data && data.error) { toast(data.error); return; }
    downloadJson(data, PDATA_KINDS[kind]);
  } catch (e) { toast("导出失败：" + e.message); }
}
function downloadJson(obj, filename) {
  const blob = new Blob([JSON.stringify(obj, null, 2)], { type: "application/json;charset=utf-8" });
  const a = document.createElement("a");
  a.href = URL.createObjectURL(blob);
  a.download = filename;
  document.body.appendChild(a);
  a.click();
  setTimeout(() => { URL.revokeObjectURL(a.href); a.remove(); }, 200);
}
async function pdataUploadImport() {
  const f = $("pdataUploadFile").files[0];
  if (!f) { toast("请先选择 json 文件"); return; }
  let payload;
  try { payload = JSON.parse(await readFileText(f)); }
  catch (e) { toast("JSON 解析失败：" + e.message); return; }
  const kind = payload && payload.kind;
  if (!kind || !PDATA_KINDS[kind]) { toast("无法识别文件类型：json 需含 kind 字段（可在本页下载对应 json 参考结构）"); return; }
  if (!(await uiConfirm(`本地上传导入「${kind}」？将按名称新增/更新，不会删除已有数据。`))) return;
  try {
    const r = await api("/api/product-data/import-one", "POST", { payload });
    renderPdataImportResult([r]);
    loadPdataPage();
    ensureUnits(0);   // 导入的 units.json 可能带进新单位，刷新前端缓存
    toast("导入完成");
  } catch (e) { toast("导入失败：" + e.message); }
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

/** 把搜索框内容拆成关键词分组（小写）。
    外层「；」分开的是平行条件：任一命中即显示，每个词都从整张表里找（例：「牛油果；代发」）。
    同一段里用「：」「:」、空格（含全角）、逗号、顿号、竖线分开的是递进条件：全部命中才显示（例：「牛油果：进口」）。
    返回拍平后的全部关键词数组（.length 与旧版一致），分组挂在 .groups 上。 */
function splitSearchKeywords(raw) {
  const groups = String(raw || "")
    .toLowerCase()
    .split(/[；;]+/)
    .map((g) => g.split(/[：:，,、\s|｜]+/).filter(Boolean))
    .filter((g) => g.length);
  const flat = groups.flat();
  flat.groups = groups;
  return flat;
}
/** 多关键词匹配：组内每个词都要命中（递进），组间任一命中即可（平行）。关键词为空视为全部命中。 */
function searchHit(hay, kws) {
  const text = String(hay || "").toLowerCase();
  const groups = (kws && kws.groups) || (kws && kws.length ? [kws] : []);
  return !groups.length || groups.some((g) => g.every((k) => text.includes(k)));
}
/** 商品列表「编码」格：主编码 + 多端商品的其它编码（悬停看全部） */
function codeCellHtml(p) {
  const extra = ((p && p.multi_code) ? (p.codes || []) : []).filter((x) => x && x.code);
  const main = esc((p && p.code) || "") || "—";
  if (!extra.length) return main;
  const tip = extra.map((x) => `${x.code}${x.shop ? "（" + x.shop + "）" : ""}`).join("\n");
  return `${main} <span class="badge income" title="${esc(tip)}">多端商品 +${extra.length}</span>`;
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
  // 搜索词：支持多关键词（用「：」「:」、空格、逗号、顿号、竖线分隔），多个关键词需**同时**命中。
  // 例：「牛油果：代发」= 名称/分类等含「牛油果」，且出库方式含「代发」。
  const kws = splitSearchKeywords($("prodSearch")?.value);
  // 单个商品的「可搜索文本」：名称 / 分类 / 规格 / 编码 / 单位 / 出库方式 / 关联结算商品名 / 随货包材。
  // 代发这一档刻意不含「库存」二字：搜「库存」只出扣减库存的商品，搜「代发」只出代发商品。
  const hayOf = (p) => {
    const schemes = p.product_type === "order" ? prodSchemes(p) : [];
    const way = p.product_type === "order"
      ? (schemes.length
        // 方案名也进搜索文本：搜「四合一」能筛出用了这套方案的商品
        ? `订单 扣减库存 ${schemes.map((s) => `${s.name} ${s.links.map((l) => l.name).join(" ")}`).join(" ")}`
        : "订单 代发 外发")
      : "库存商品";
    const packs = (p.pack_items || [])
      .map((it) => (PRODUCTS.find((x) => x.id === it.product_id) || {}).name || "")
      .join(" ");
    // 多端商品的其它编码 / 店铺名也进搜索：搜店铺能筛出它的商品，搜副编码也能找到
    const extraCodes = p.multi_code
      ? (p.codes || []).map((it) => `${it.code || ""} ${it.shop || ""}`).join(" ")
      : "";
    return [p.name, p.category, p.spec, p.code, extraCodes, p.warehouse_party || "", p.unit, p.base_unit, way, packs]
      .join(" ").toLowerCase();
  };
  const kwHit = (p) => searchHit(hayOf(p), kws);   // 多个关键词：全部命中才算匹配
  const cat = forced ? "" : (catSel ? catSel.value : "");
  const ptype = $("prodType")?.value || "";
  let rows = PRODUCTS.filter((p) =>
    kwHit(p) &&
    (!cat || p.category === cat) &&
    (isOrderPage ? p.product_type === "order"
      : (forced ? p.category === forced : !EXCLUDED.includes(p.category))) &&
    (isOrderPage || !ptype || p.product_type === ptype)
  );
  const t = $("prodTable");
  // 「参考成本」和「库存」这两格显示的不是商品原始字段（参考成本可能是均价回退到参考成本，
  // 库存对订单商品显示的是它关联的库存商品），排序时按显示值换算，否则点表头会看不出升/降序。
  t._sortVal = (p, k) => (k === "avg_cost" ? refCostValue(p) : k === "stock" ? stockSortValue(p) : undefined);
  // 独立页默认按名称、商品页默认按库存升序排序（用户手动点击表头后保持其排序）
  if (!t._sort) t._sort = isOrderPage ? { key: "name", dir: 1 } : { key: "stock", dir: 1 };
  rows = applyTableSort(t, rows);
  // 停用的资料统一排到最后，不与启用的混在一起（商品 / 关联结算 / 包材 / 人工 / 快递共用这张表）；
  // 用稳定排序，停用组内仍保持上面选的排序。
  rows.sort((a, b) => (a.is_active === false ? 1 : 0) - (b.is_active === false ? 1 : 0));
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
      // linkInfo 允许含 HTML（代发徽章 / 方案名），所以文本分支这里自己先 esc，渲染时不能再 esc 一次
      const schemes = p.product_type === "order" ? prodSchemes(p) : [];
      const linkInfo = p.product_type === "order"
        ? (schemes.length
          // 配了多套方案时把方案名标出来（如「四合一蔬菜 四合一蔬菜×2；方案1 西芹×0.5」）
          ? `扣减：${schemes.map((s) => (schemes.length > 1 ? `<b>${esc(s.name)}</b> ` : "")
            + s.links.map((l) => `${esc(l.name)} ×${fmtNum(l.multiplier)}`).join("、")).join("；")}`
          : '<span class="badge income">代发</span> <span class="muted">不扣库存，只统计代发数量/成本</span>')
        : esc(p.spec || "");
      const isLabor = p.category === "人工";
      // 订单商品：配了扣减方案（关联了库存商品）就不在这里重复显示库存，标「经库存商品」
      const stockShown = p.product_type === "order" && schemes.length
        ? `<span class="muted">经库存商品</span>`
        : isLabor
          ? `<span class="badge income">工作量 ${fmtNum(p.workload)} 单</span>`
          : fmtStock(p);
      return `<tr>
        <td class="cb-col"><input type="checkbox" value="${p.id}" ${prodSel.has(p.id) ? "checked" : ""} onchange="toggleSel('prod',${p.id},this.checked)" /></td>
        <td class="muted mono">${codeCellHtml(p)}</td>
        <td><b>${typeBadge} ${esc(p.name)}</b>${p.warehouse_party
          ? ` <span class="badge adjust" title="仓储方：聚水潭导入按它区分同名商品">${esc(p.warehouse_party)}</span>` : ""}<div class="muted" style="font-size:12px;">${linkInfo}</div></td>
        <td>${esc(p.category) ? `<span class="badge adjust">${esc(p.category)}</span>` : "—"}</td>
        <td class="muted" style="max-width:170px;">${esc(packs) || "—"}</td>
        <td class="num mono" title="${esc(refCostTitle(p))}">${refCostHtml(p)}</td>
        <td class="num">${fmtMoney(p.pack_fee)}</td>
        <td class="num mono">${stockShown}</td>
        <td>${p.is_active ? '<span class="badge in">启用</span>' : '<span class="badge off">停用</span>'}</td>
        <td class="line-actions">
          <button class="btn sm secondary" onclick="openProductModal(${p.id})">编辑</button>
        </td></tr>`;
    }).join("") + `</tbody>`;
  if (!rows.length) {
    // 空结果时把命中的关键词逐个写出来，方便发现「某个关键词打错了」（平行条件用「或」连，递进条件用「+」连）
    const kwsHtml = (kws.groups || []).map((g) => g.map((k) => `「${esc(k)}」`).join("+")).join(" 或 ");
    t.innerHTML = kws.length
      ? `<tr><td colspan="10" class="empty">${kws.groups.length > 1 ? "没有匹配任一组" : "没有同时匹配"} ${kwsHtml} 的商品</td></tr>`
      : `<tr><td colspan="10" class="empty">暂无商品</td></tr>`;
  }
  t._rows = rows;
  t._render = renderProducts;
  updateBatchBar("prod");
}

/* ---------- 计量单位管理 ---------- */
/* 单位表缓存。除了「计量单位管理」，AI 识图建商品、商品资料导入等入口也会往单位表加单位，
   所以打开商品弹窗前统一按 TTL 取一次最新，避免出现「新增了却在商品里找不到」。 */
let UNITS_TS = 0;
async function ensureUnits(maxAgeMs = 30000) {
  if (UNITS.length && Date.now() - UNITS_TS < maxAgeMs) return UNITS;
  try {
    UNITS = await api("/api/units");
    UNITS_TS = Date.now();
  } catch (e) { /* 拉取失败沿用旧缓存，不阻塞弹窗 */ }
  return UNITS;
}
async function openUnitsModal() {
  const units = await ensureUnits();
  openModal(`
    <h3>计量单位管理 <button class="close" onclick="closeModal()">✕</button>
      <button class="btn sm secondary" style="float:right;" onclick="pdataDownload('units')"><svg class="ic"><use href="#i-download"/></svg> 导出JSON</button></h3>
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
    await ensureUnits(0);   // 强制刷新：新单位要立刻能在商品表单里选到
    toast("单位已新增"); closeModal();
  } catch (e) { toast("新增失败：" + e.message); }
}
async function deleteUnit(id, name) {
  if (!(await uiConfirm(`确认删除单位「${name}」？`))) return;
  try { await api("/api/units/" + id, "DELETE"); await ensureUnits(0); toast("已删除"); closeModal(); openUnitsModal(); }
  catch (e) { toast("删除失败：" + e.message); }
}

function packRowsHtml(packItems) {
  const items = packItems || [];
  return items.map((it, i) => {
    const m = PRODUCTS.find((x) => x.id === it.product_id);
    const unitSel = m ? unitOptions(m, it.unit) : `<option>个</option>`;
    return `<div class="pack-row">
      <input value="${esc(m ? m.name : it.product_id)}" data-pid="${it.product_id || ""}" readonly style="background:#f9fafb;" />
      <select class="pack-unit searchable" onchange="packUnitChanged(this)">${unitSel}</select>
      <input type="number" step="any" value="${it.quantity}" class="pack-qty" />
      <button class="btn danger sm" onclick="this.closest('.pack-row').remove()">删</button>
    </div>`;
  }).join("") + `
    <div class="pack-row">
      <select class="pack-product searchable" onchange="packProductChanged(this)">
        <option value="">选择关联商品…</option>
        ${PRODUCTS.filter((p) => p.is_active).map((p) => `<option value="${p.id}">${esc(p.name)}${p.warehouse_party ? " · " + esc(p.warehouse_party) : ""}</option>`).join("")}
      </select>
      <select class="pack-unit searchable"><option>个</option></select>
      <input type="number" step="any" value="1" class="pack-qty" />
      <button class="btn secondary sm" onclick="addProductPackRow()">＋</button>
    </div>`;
}
function packProductChanged(sel) {
  const row = sel.closest(".pack-row");
  const m = PRODUCTS.find((x) => x.id === +sel.value);
  row.querySelector(".pack-unit").innerHTML = m ? unitOptions(m) : `<option>个</option>`;
}
function packUnitChanged(sel) {}
/** 商品弹窗「出库关联结算清单」里点「＋」：把当前填写行转成只读展示，再追加一个空行。
    注意函数名不能叫 addPackRow —— 出库页「关联结算」也有同名的 addPackRow(m, qty)，
    同名会被后者覆盖，导致这里点＋（无参调用）走到那边直接 return、毫无反应。 */
function addProductPackRow() {
  const box = $("packRows");
  const last = box.querySelector(".pack-row:last-child");
  const sel = last.querySelector(".pack-product");
  const qty = last.querySelector(".pack-qty").value;
  const unit = last.querySelector(".pack-unit").value;
  if (!sel || !sel.value || !qty) { toast("请选择关联商品并填数量"); return; }
  const m = PRODUCTS.find((x) => x.id === +sel.value);
  // 把已填的行转为只读展示，再追加一行
  last.innerHTML = `
    <input value="${esc(m.name)}" data-pid="${m.id}" readonly style="background:#f9fafb;" />
    <select class="pack-unit searchable" onchange="packUnitChanged(this)">${unitOptions(m, unit)}</select>
    <input type="number" step="any" value="${qty}" class="pack-qty" />
    <button class="btn danger sm" onclick="this.closest('.pack-row').remove()">删</button>`;
  box.insertAdjacentHTML("beforeend", `
    <div class="pack-row">
      <select class="pack-product searchable" onchange="packProductChanged(this)">
        <option value="">选择关联商品…</option>
        ${PRODUCTS.filter((p) => p.is_active).map((p) => `<option value="${p.id}">${esc(p.name)}${p.warehouse_party ? " · " + esc(p.warehouse_party) : ""}</option>`).join("")}
      </select>
      <select class="pack-unit searchable"><option>个</option></select>
      <input type="number" step="any" value="1" class="pack-qty" />
      <button class="btn secondary sm" onclick="addProductPackRow()">＋</button>
    </div>`);
  // 新追加的行同样要转成「点击选择 / 输入筛选」的下拉（原先漏了这台转换，导致只能下拉不能输入搜索）
  bindSearchable(box);
}

/** 勾了「包邮」→ 快递公司下拉置灰（包邮的商品出库不计快递费，选公司没意义） */
function pFreeShipChanged() {
  const box = $("pFreeShip"), sel = $("pExpressCarrier");
  if (!box || !sel) return;
  sel.disabled = !!box.checked;
  sel.title = box.checked ? "该商品已勾「包邮」，出库不计快递费" : "";
}
async function openProductModal(pid = 0, prefillName = "", draft = null) {
  await ensureUnits();   // 先取最新单位表，否则刚新增的单位不会出现在「单位（默认单位）」下拉里
  if (!EXPRESS_CARRIER_LIST.length) await loadExpressCarrierList();   // 快递公司下拉要选项
  // draft：点「复制」时带进来的商品信息（字段与保存 payload 同构），按「新增商品」打开并预填
  const p = draft || (pid ? PRODUCTS.find((x) => x.id === pid) : null);
  const ptype = p ? p.product_type : "stock";
  const curUnit = p ? (p.default_unit || p.base_unit) : "斤";
  const curCat = p ? p.category : (prodForceCat || ""); // 独立分类页新增时自动带上分类
  const curName = p?.name || prefillName || "";
  // 售价/成本一律按「默认单位」填（以前按基础单位，如 元/克，太反直觉）；
  // 内部仍按基础单位存库，这里只是显示与录入时做一次换算。
  PM_EDIT_P = p;   // 记住正在编辑的原商品：保留它原有的单位，不因一次保存而丢
  const up0 = deriveUnitPayload(ptype, curUnit, p);
  const du0 = up0.default_unit || up0.base_unit;
  const f0 = (up0.conversions || {})[du0] || 1;
  PM_UNIT_F = f0;
  PM_SALE_BASE = p ? (+p.sale_price || 0) : 0;
  PM_COST_BASE = p ? (+p.unit_cost || 0) : 0;
  const saleDisp = +(PM_SALE_BASE * f0).toFixed(6);
  const costDisp = +(PM_COST_BASE * f0).toFixed(6);
  // 这个商品默认发哪家快递：选项来自「快递费」页配置的快递公司（空=跟随默认快递）
  const curCarrier = p?.express_carrier || "";
  const carrierOpts = `<option value="">（默认快递${EXPRESS_CARRIER_LIST.length ? "：" + esc((EXPRESS_CARRIER_LIST.find((c) => c.id === EXPRESS_CARRIER_DEFAULT) || {}).name || "") : ""}）</option>`
    + EXPRESS_CARRIER_LIST.map((c) =>
      `<option value="${esc(c.id)}"${c.id === curCarrier ? " selected" : ""}>${esc(c.name)}</option>`).join("");
  // 「复制」：以当前商品信息新建一条（编辑态才有）。方便复用同类商品再改几处，不用从头填
  const copyBtn = (pid && !draft)
    ? `<button class="btn secondary sm" type="button" onclick="duplicateProduct()" title="按当前填写的商品信息新建一条（编码要另填）">复制</button>`
    : "";
  const title = draft ? "新增商品（复制）" : (pid ? "编辑商品" : "新增商品");
  // 商品表单字段多，用加宽弹窗（字段自动多列排布）减少上下滚动
  $("modalBox").classList.add("wide");
  openModal(`
    <h3><span>${title}</span><span style="display:flex;gap:8px;align-items:center;">${copyBtn}<button class="close" onclick="closeModal()">✕</button></span></h3>
    <div class="form-grid">
      <div class="field"><label>商品编码</label><input id="pCode" value="${esc(p?.code || "")}" placeholder="如 ydj001，可留空" />
        <div class="field-hint">主编码：没匹配到店铺的订单都归它</div>
      </div>
      <div class="field"><label>商品名称 *</label><input id="pName" value="${esc(curName)}" placeholder="如：佛手柑大果2个" /></div>
      <div class="field" id="pMultiBox" style="grid-column:1/-1;">
        <label style="display:flex;gap:6px;align-items:center;">
          <input type="checkbox" id="pMultiCode" ${p?.multi_code ? "checked" : ""} onchange="pMultiToggle()" />
          多端商品（同一规格在多个店铺/端各有一个编码，如京东多家店的 skuId）
        </label>
        <div class="field-hint">开启后可填「编码 + 店铺」多条：对外成本表 <code>/api/open/sku-costs</code> 按出库单的客户/店铺名把销量算到对应编码上（每个 SKU 拿到自己店铺的结算价与成本）；没填店铺的是通用编码。店铺名建议从下拉选（出库单存的是完整店铺名，填简称也能包含匹配）。编码全局唯一（主编码 + 这里的编码）</div>
        <div id="pCodesBox" style="margin-top:8px;display:${p?.multi_code ? "" : "none"};">
          <div id="pCodeRows"></div>
          <datalist id="shopList"></datalist>
          <button class="btn secondary sm" type="button" onclick="addCodeRow()">＋ 新增编码</button>
        </div>
        <div class="field" style="margin-top:12px;">
          <label>仓储方</label>
          <input id="pWarehouseParty" list="warehousePartyList" value="${esc(p?.warehouse_party || "")}" placeholder="如 云南芳谊昆明（干货）仓；多个用、分隔；留空=不限" />
          <datalist id="warehousePartyList"></datalist>
          <div class="field-hint">聚水潭出库单的「仓储方」列。出库单没有 SKU 时，系统只能靠商品名称找商品；
            <b>同名商品</b>（如 松茸干片50g 既在芳谊仓代发、又在自营仓扣库存）请建两条，并在这里填不同的仓储方，
            导入时按每行的仓储方精确匹配。留空 = 不限（任何仓储方都能匹配）。</div>
        </div>
      </div>
      <div class="field"><label>分类</label><input id="pCategory" value="${esc(curCat)}" placeholder="如：蔬菜" /></div>
      <div class="field"><label>商品类型 *</label>
        <select id="pType" onchange="pTypeChanged()">
          <option value="stock" ${ptype === "stock" ? "selected" : ""}>库存商品（大类·真实库存）</option>
          <option value="order" ${ptype === "order" ? "selected" : ""}>订单商品（小类·出库销售）</option>
        </select></div>
      <div class="field"><label>默认单位 <button type="button" class="help-btn" data-help="重量类按克记账（1斤=500克），计数类按个记账；订单商品固定为「单」。售价与成本均按此单位填写。">?</button></label><select id="pUnit" class="searchable"></select></div>
      <div class="field"><label id="pSalePriceLabel">默认售价（元/${esc(du0)}）</label><input id="pSalePrice" type="number" step="any" value="${saleDisp}" /><div class="field-hint" id="pSalePriceHint"></div></div>
      <div class="field"><label id="pUnitCostLabel">参考成本（元/${esc(du0)}）</label><input id="pUnitCost" type="number" step="any" value="${costDisp}" /><div class="field-hint" id="pUnitCostHint"></div></div>
      <div class="field" id="pUnitChangeBox" style="display:none;grid-column:1/-1;">
        <label id="pUnitChangeLabel">换计量单位的换算关系</label>
        <input id="pUnitRatio" type="number" step="any" min="0" placeholder="如 300" style="max-width:200px;" />
        <div class="field-hint" id="pUnitChangeHint"></div>
      </div>
      <div class="field" id="pWeightBox"><label>单件净重（kg）<button type="button" class="help-btn" data-help="用于计快递费：重量类自动推导，计数类兜底用此净重；代发商品填净重也按净重算快递（不填=代发包邮）。">?</button></label><input id="pWeightKg" type="number" step="any" value="${p?.weight_kg || 0}" /></div>
    </div>
    <div id="pStockBox" class="form-grid" style="margin-top:10px;display:${ptype === "order" ? "grid" : "none"};">
      <div class="field" style="grid-column:1/-1;">
        <label>关联库存商品 <button type="button" class="help-btn" data-help="每套方案 = 若干「库存商品 × 倍数」，出库时按各方案最近采购入库日期自动选最新一套；不配方案则视为「代发」（不扣本仓库存，按参考成本计代发成本）。">?</button></label>
        <div id="stockSchemeList"></div>
        <button class="btn secondary sm" onclick="addStockScheme()">＋ 新增扣减方案</button>
      </div>
    </div>
    <div class="field" style="margin-top:10px;"><label>规格说明</label><input id="pSpec" value="${esc(p?.spec || "")}" placeholder="如：每个约150克；或每袋5斤" /></div>
    <hr />
    <h3>出库关联结算清单 <button type="button" class="help-btn" data-help="每售出 1 单本商品时，自动扣减这些包材/人工等关联商品库存。">?</button></h3>
    <div id="packRows">${packRowsHtml(p?.pack_items)}</div>
    <div class="form-grid compact-grid" style="margin-top:10px;">
      <div class="field"><label>固定费用（元/单）</label><input id="pPackFee" type="number" step="any" value="${p?.pack_fee || 0}" /></div>
      <div class="field"><label>快递公司 <button type="button" class="help-btn" data-help="出库默认按此快递计费，选「默认快递」跟随快递费页默认设置；勾选包邮则不计快递费。">?</button></label><select id="pExpressCarrier">${carrierOpts}</select></div>
    </div>
    <div class="toolbar" style="margin-top:10px;margin-bottom:0;">
      <label class="check-inline"><input type="checkbox" id="pFreeShip" onchange="pFreeShipChanged()" ${p?.free_shipping ? "checked" : ""}/> 包邮（不计快递费）</label>
      ${p && !draft ? `<label class="check-inline"><input type="checkbox" id="pActive" ${p.is_active ? "checked" : ""}/> 启用该商品</label>` : ""}
    </div>
    <div class="modal-foot">
      ${p && !draft ? `<button class="btn danger" onclick="deleteProduct(${p.id})" style="margin-right:auto;">删除</button>` : ""}
      <button class="btn secondary" onclick="closeModal()">取消</button>
      <button class="btn" onclick="saveProduct(${draft ? 0 : (pid || 0)})">保存</button>
    </div>`);
  initProductUnitSelect(ptype, curUnit);
  initCodeRows(p?.codes || [], !!(p && p.multi_code));   // 多端商品：多店铺多编码回填
  ensureProductShops();                                   // 店铺名下拉候选（出库单里出现过的客户名）
  ensureProductWarehouses();                              // 仓储方下拉候选（同名商品按它区分渠道）
  if ($("pMultiBox")) $("pMultiBox").style.display = ptype === "order" ? "" : "none";
  updateProductPriceLabels(du0, f0, up0.base_unit);   // 价格字段标签/提示按默认单位显示
  updateUnitChangeBox(up0);                            // 跨类别换单位时显示「换算关系」输入框（初始=没换，隐藏）
  pFreeShipChanged();                                  // 包邮时快递公司下拉置灰（包邮就不计快递费）
  // 加载库存商品（大类）列表，并渲染「扣减方案」（每套方案多行，支持 + 号新增方案/扣减项）
  if (ptype === "order") {
    api("/api/stocks").then((stocks) => {
      STOCKS = stocks || [];
      renderStockSchemes(prodSchemes(p || {}));
    }).catch(() => { $("stockSchemeList").innerHTML = '<div class="muted">库存商品加载失败</div>'; });
  } else {
    $("stockSchemeList").innerHTML = "";
  }
}
/* 商品表单的单位一律取自「计量单位管理」(/api/units)，用户新增的单位要能直接选到。
   以前这里是写死的清单，所以新增单位后在商品里根本找不到。 */
let PM_EDIT_P = null;   // 当前弹窗正在编辑的原商品（新增为 null），用于保留它原有的单位
const FALLBACK_UNITS = {
  weight: ["克", "斤", "公斤", "千克"],
  count: ["个", "袋", "包", "盒", "箱", "件", "份"],
};
function unitMeta(name) {
  return (UNITS || []).find((u) => u.name === name) || null;
}
/* 是否重量类单位：优先看单位表，单位表没加载时按内置标准单位兜底 */
function isWeightUnitName(name) {
  const m = unitMeta(name);
  if (m) return m.category === "weight";
  return FALLBACK_UNITS.weight.includes(name);
}
/* 某类别的换算表：重量类以「克」为基础（系数取单位表里的每单位克数），计数类以「个」为基础 */
function unitConversions(category) {
  const convs = {};
  (UNITS || []).forEach((u) => {
    if (u.category !== category) return;
    const f = category === "weight" ? Number(u.gram_per_unit) : 1;
    if (f > 0) convs[u.name] = f;
  });
  const fb = category === "weight" ? { 克: 1, 斤: 500, 公斤: 1000, 千克: 1000 } : { 个: 1 };
  Object.entries(fb).forEach(([k, v]) => { if (!(k in convs)) convs[k] = v; });
  return convs;
}
/* 商品表单可选单位名（订单商品固定「单」）；extra = 老商品当前单位，保证它一定在选项里 */
function productUnitNames(ptype, extra) {
  if (ptype === "order") return ["单"];
  const names = (UNITS || []).map((u) => u.name).filter(Boolean);
  const base = names.length ? names : [...FALLBACK_UNITS.weight, ...FALLBACK_UNITS.count];
  return (extra && !base.includes(extra)) ? base.concat(extra) : base;
}
function initProductUnitSelect(ptype, curUnit) {
  const units = productUnitNames(ptype, curUnit);
  const sel = $("pUnit");
  const cur = ptype === "order" ? "单" : (units.includes(curUnit) ? curUnit : (units.includes("斤") ? "斤" : units[0]));
  sel.innerHTML = units.map((u) => `<option value="${u}" ${u === cur ? "selected" : ""}>${u}</option>`).join("");
  sel.onchange = pUnitChanged;   // 换默认单位时，价格字段按新单位重算显示
}
/* 商品弹窗里的价格：对外按默认单位，内部按基础单位（PM_* 存的就是基础单位值） */
let PM_UNIT_F = 1;
let PM_SALE_BASE = 0;
let PM_COST_BASE = 0;
function updateProductPriceLabels(du, f, bu) {
  const conv = f !== 1 ? `（1${du} = ${fmtNum(f)}${bu}）` : "";
  if ($("pSalePriceLabel")) $("pSalePriceLabel").textContent = `默认售价（元/${du}）`;
  if ($("pUnitCostLabel")) $("pUnitCostLabel").textContent = `参考成本（元/${du}）`;
  if ($("pSalePriceHint")) $("pSalePriceHint").textContent = `按默认单位填${conv}；出库时按这个价带出`;
  if ($("pUnitCostHint")) {
    let t = `按默认单位填${conv}；包材/人工等无入库时按此成本结算（如纸箱 0.9 元/个）`;
    // 商品列表的「参考成本」格有库存均价时优先显示均价（不是这里填的参考成本），
    // 不说清楚就会出现「编辑页 16.5、列表 5000」这种对不上的观感
    const avg = PM_EDIT_P ? (Number(PM_EDIT_P.avg_cost) || 0) : 0;
    if (avg > 0) t += `。<b>注意</b>：该商品已有库存均价 ${fmtMoney(avg * f)}/${esc(du)}（由出入库自动形成），列表「参考成本」格优先显示它、出库成本也按它算，改这里不会立刻改变均价`;
    $("pUnitCostHint").innerHTML = t;
  }
}
/* 换「计量单位」若跨了类别（计数「个」↔ 重量「克」），基础单位会跟着换（重量→克、计数→个），
   历史数量与成本必须按换算关系折算，否则均价会被放大成倍数（个→公斤 就是 ×1000）。
   这里在编辑已有商品时显示换算关系输入框；没有历史数据时留空即可（后端会忽略）。 */
function pUnitCat(base) {
  return (base === "克" || base === "g") ? "weight" : "count";
}
function updateUnitChangeBox(up) {
  const box = $("pUnitChangeBox");
  if (!box) return;
  const oldBase = PM_EDIT_P ? (PM_EDIT_P.base_unit || "") : "";
  const newBase = (up && up.base_unit) || "";
  const changed = !!(PM_EDIT_P && oldBase && newBase && pUnitCat(oldBase) !== pUnitCat(newBase));
  box.style.display = changed ? "" : "none";
  if (!changed) return;
  const label = $("pUnitChangeLabel");
  const hint = $("pUnitChangeHint");
  if (label) label.textContent = `换计量单位的换算关系：1 ${oldBase} = ? ${newBase}`;
  if (hint) {
    hint.innerHTML = `从「${esc(oldBase)}」换到「${esc(newBase)}」不是一个类别，历史数量与成本要按这个关系折算`
      + `（如 1 个 = 300 克）。<b>该商品已有单据时必填</b>，否则会被按新单位重新解读、均价被放大成倍数；`
      + `如果它还没有入库/出库记录，留空即可。`;
  }
}
/* 切换默认单位：先把手填的值折回基础单位，再按新单位显示，避免价格被单位搞乱 */
function pUnitChanged() {
  const up = deriveUnitPayload($("pType").value, $("pUnit").value, PM_EDIT_P);
  const du = up.default_unit || up.base_unit;
  const f = (up.conversions || {})[du] || 1;
  const back = (id) => {
    const el = $(id);
    const v = el ? parseFloat(el.value) : NaN;
    return isFinite(v) ? v / (PM_UNIT_F || 1) : 0;
  };
  PM_SALE_BASE = back("pSalePrice");
  PM_COST_BASE = back("pUnitCost");
  PM_UNIT_F = f;
  if ($("pSalePrice")) $("pSalePrice").value = +(PM_SALE_BASE * f).toFixed(6);
  if ($("pUnitCost")) $("pUnitCost").value = +(PM_COST_BASE * f).toFixed(6);
  updateProductPriceLabels(du, f, up.base_unit);
  updateUnitChangeBox(up);
}
/* 由「默认单位」推出基础单位与换算表：重量类归「克」、计数类归「个」，
   换算系数取自单位表（新增的重量类单位按它填的每单位克数参与换算）。 */
function deriveUnitPayload(ptype, unit, prev) {
  let payload;
  if (ptype === "order" || unit === "单") {
    payload = { base_unit: "单", default_unit: "单", conversions: { 单: 1 } };
  } else if (isWeightUnitName(unit)) {
    payload = { base_unit: "克", default_unit: unit, conversions: unitConversions("weight") };
  } else {
    payload = { base_unit: "个", default_unit: unit, conversions: unitConversions("count") };
  }
  // 编辑同基础单位的老商品时，保留它原有的其它单位（如导入产生的 g/kg），避免一编辑就少单位
  if (prev && prev.base_unit === payload.base_unit) {
    Object.entries(prev.conversions || {}).forEach(([u, f]) => {
      if (!(u in payload.conversions) && Number(f) > 0) payload.conversions[u] = Number(f);
    });
  }
  if (!(unit in payload.conversions)) payload.conversions[unit] = 1;   // 兜底：单位表没加载时也要能存
  return payload;
}
function pTypeChanged() {
  const t = $("pType").value;
  $("pStockBox").style.display = t === "order" ? "grid" : "none";
  // 多端商品（多店铺多编码）只对订单商品有意义（平台 SKU 是卖出商品的编码）
  if ($("pMultiBox")) $("pMultiBox").style.display = t === "order" ? "" : "none";
  initProductUnitSelect(t, $("pUnit").value);
  // 切换类型会改变默认单位（订单商品固定「单」），必须同步换算系数与价格标签，
  // 否则 PM_UNIT_F 还停留在旧单位（如 斤=500），保存时售价/参考成本会被按旧单位折回基础单位（除以 500）。
  pUnitChanged();
  if (t === "order" && !STOCKS.length) {
    api("/api/stocks").then((stocks) => {
      STOCKS = stocks || [];
      const box = $("stockSchemeList");
      if (box && !box.querySelector(".stock-scheme")) renderStockSchemes([]);   // 还没渲染过就补一套空方案
    });
  }
}

/* ---------- 订单商品「扣减方案」多套（每套 = 若干 库存商品 × 倍数） ---------- */
let STOCKS = [];   // 库存商品（大类）缓存，供关联行下拉使用
function stockLinkOptions(selId) {
  const list = STOCKS.length ? STOCKS : PRODUCTS.filter((p) => p.is_active && p.product_type === "stock");
  return '<option value="">选择库存商品（大类）…</option>' + list.map((s) => {
    const du = s.default_unit || s.base_unit || s.unit || "";
    return `<option value="${s.id}" ${Number(selId) === s.id ? "selected" : ""}>${esc(s.name)}（${esc(s.category || "—")}${du ? "·单位" + esc(du) : ""}）</option>`;
  }).join("");
}
/* ---------- 订单商品「扣减方案」多套（每套 = 若干 库存商品 × 倍数） ----------
   出库时后端按各方案库存商品的「最近一次采购入库」日期自动选一套（都不/并列 → 第一套）。
   这里只负责编辑：方案卡片可增删，卡片内扣减项可增删；名称留空自动叫「方案N」。 */
function schemeLinkRowHtml(link) {
  const hint = link && link.last_in_date
    ? `<span class="muted" style="font-size:12px;white-space:nowrap;">最近入库 ${esc(link.last_in_date)}</span>` : "";
  return `<div class="stock-link-row">
    <select class="stock-link searchable">${stockLinkOptions(link && link.product_id)}</select>
    <input type="number" step="any" min="0" class="stock-mult" value="${link ? (Number(link.multiplier) || 1) : 1}" placeholder="倍数（1单=？库存单位）" />
    ${hint}
    <button class="btn danger sm" onclick="this.closest('.stock-link-row').remove()">删</button>
  </div>`;
}
function schemeBlockHtml(scheme, idx) {
  const links = (scheme && scheme.links) || [];
  const lastDates = links.map((l) => l.last_in_date).filter(Boolean).sort();
  const latest = lastDates.length ? lastDates[lastDates.length - 1] : "";
  return `<div class="stock-scheme" style="border:1px solid var(--line,#e5e7eb);border-radius:8px;padding:8px;margin-bottom:8px;">
    <div style="display:flex;gap:8px;align-items:center;margin-bottom:6px;">
      <input class="scheme-name" value="${esc((scheme && scheme.name) || `方案${idx + 1}`)}" placeholder="方案名，如 四合一蔬菜" style="max-width:220px;" />
      <span class="muted" style="font-size:12px;">${latest ? `本方案最近入库 ${esc(latest)}` : "本方案暂无入库记录"}</span>
      <button class="btn danger sm" style="margin-left:auto;" onclick="this.closest('.stock-scheme').remove()">删除方案</button>
    </div>
    <div class="scheme-links">${links.map((l) => schemeLinkRowHtml(l)).join("")}</div>
    <button class="btn secondary sm" onclick="addSchemeLink(this)">＋ 添加扣减库存商品</button>
  </div>`;
}
function renderStockSchemes(schemes) {
  const box = $("stockSchemeList");
  if (!box) return;
  const list = (schemes || []).length ? schemes : [{ name: "方案1", links: [] }];
  box.innerHTML = list.map((s, i) => schemeBlockHtml(s, i)).join("");
  bindSearchable(box);
}
function addStockScheme() {
  const box = $("stockSchemeList");
  if (!box) return;
  const idx = box.querySelectorAll(".stock-scheme").length;
  box.insertAdjacentHTML("beforeend", schemeBlockHtml({ name: `方案${idx + 1}`, links: [{}] }, idx));
  bindSearchable(box);
}
function addSchemeLink(btn) {
  const block = btn.closest(".stock-scheme");
  if (!block) return;
  block.querySelector(".scheme-links").insertAdjacentHTML("beforeend", schemeLinkRowHtml(null));
  bindSearchable(block);
}
/** 收集多套方案 → [{name, links:[{product_id, multiplier}]}]（空方案/空行自动丢掉） */
function collectStockSchemes() {
  const out = [];
  document.querySelectorAll("#stockSchemeList .stock-scheme").forEach((block, i) => {
    const links = [];
    block.querySelectorAll(".stock-link-row").forEach((row) => {
      const sel = row.querySelector(".stock-link");
      const pid = sel && sel.value ? +sel.value : null;
      const mult = parseFloat(row.querySelector(".stock-mult").value);
      if (pid && mult > 0) links.push({ product_id: pid, multiplier: mult });
    });
    if (!links.length) return;      // 空方案不提交（后端也要求至少一项）
    const name = (block.querySelector(".scheme-name").value || "").trim() || `方案${i + 1}`;
    out.push({ name, links });
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
      // 只读行：优先读 data-pid（同名商品可以有多条，按名称反查会取错）
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
/* ---------- 多端商品（同一规格多店铺多编码，如京东多家店 skuId） ---------- */
function codeRowHtml(code = "", shop = "") {
  return `<div class="code-row" style="display:flex;gap:8px;align-items:center;margin-bottom:6px;">
    <input class="pc-code" placeholder="编码（如京东 skuId 100157104844）" value="${esc(code)}" style="flex:1;" />
    <input class="pc-shop" list="shopList" placeholder="店铺名（选或填，留空=通用）" value="${esc(shop)}" style="flex:1;" />
    <button class="btn sm danger" type="button" onclick="this.closest('.code-row').remove()">删</button>
  </div>`;
}

/* 出库单里出现过的店铺名（供「店铺」下拉候选：出库单存的是完整店铺名，手打简称会匹配不上） */
let PRODUCT_SHOPS = [];
async function ensureProductShops() {
  try {
    if (!PRODUCT_SHOPS.length) {
      const rows = await api("/api/product-shops");
      PRODUCT_SHOPS = (rows || []).map((x) => x.name).filter(Boolean);
    }
  } catch (e) { /* 拉不到就退化成手填，不阻塞弹窗 */ }
  const dl = $("shopList");
  if (dl) dl.innerHTML = PRODUCT_SHOPS.map((s) => `<option value="${esc(s)}"></option>`).join("");
  return PRODUCT_SHOPS;
}

/* 商品里已经用过的「仓储方」（聚水潭出库单的列）候选：同名商品靠它区分渠道，手打不一致就匹配不上 */
let PRODUCT_WAREHOUSES = [];
async function ensureProductWarehouses() {
  try {
    if (!PRODUCT_WAREHOUSES.length) {
      const rows = await api("/api/product-warehouses");
      PRODUCT_WAREHOUSES = (rows || []).map((x) => x.name).filter(Boolean);
    }
  } catch (e) { /* 拉不到就退化成手填，不阻塞弹窗 */ }
  const dl = $("warehousePartyList");
  if (dl) dl.innerHTML = PRODUCT_WAREHOUSES.map((s) => `<option value="${esc(s)}"></option>`).join("");
  return PRODUCT_WAREHOUSES;
}

/** 弹窗打开时回填编码行；开关打开但一条都没有时先给一行空输入 */
function initCodeRows(codes, multi) {
  const box = $("pCodeRows");
  if (!box) return;
  const list = Array.isArray(codes) ? codes.filter((x) => x && x.code) : [];
  box.innerHTML = list.map((it) => codeRowHtml(it.code || "", it.shop || "")).join("");
  if (multi && !list.length) addCodeRow();
}

function addCodeRow(code = "", shop = "") {
  const box = $("pCodeRows");
  if (!box) return;
  box.insertAdjacentHTML("beforeend", codeRowHtml(code, shop));
  const rows = box.querySelectorAll(".code-row");
  const last = rows[rows.length - 1];
  const inp = last && last.querySelector(".pc-code");
  if (inp && !code) inp.focus();
}

function pMultiToggle() {
  const on = $("pMultiCode") ? $("pMultiCode").checked : false;
  const box = $("pCodesBox");
  if (box) box.style.display = on ? "" : "none";
  if (on && $("pCodeRows") && !$("pCodeRows").children.length) addCodeRow();
}

/** 读编码行 → [{code, shop}]（丢掉空编码） */
function collectCodes() {
  const box = $("pCodeRows");
  if (!box) return [];
  return [...box.querySelectorAll(".code-row")].map((row) => ({
    code: ((row.querySelector(".pc-code") || {}).value || "").trim(),
    shop: ((row.querySelector(".pc-shop") || {}).value || "").trim(),
  })).filter((x) => x.code);
}

/** 从商品弹窗当前填写的内容收集保存 payload（「保存」与「复制」共用，保证两者口径一致）。 */
function collectProductPayload(opts) {
  const ptype = $("pType").value;
  const unit = $("pUnit") ? $("pUnit").value : "斤";
  const unitPayload = deriveUnitPayload(ptype, unit, PM_EDIT_P);
  // 订单商品可配多套扣减方案（stock_schemes）；stock_links / stock_product_id / multiplier 仍写第一套
  // 方案，兼容报表、移动端、需求预演算等只认单方案的旧消费方。
  const schemes = ptype === "order" ? collectStockSchemes() : [];
  const stockLinks = schemes.length ? schemes[0].links : [];
  const multiCode = !!($("pMultiCode") && $("pMultiCode").checked);
  const payload = {
    code: $("pCode").value,
    // 编码冲突时点「替换编码」→ 传 true：把占用该编码的原商品编码清空，改给当前商品
    code_takeover: !!(opts && opts.takeover),
    // 多端商品：多店铺多编码（开关关着时后端不使用这些编码，但仍然保存，重新打开不用重填）
    multi_code: multiCode,
    codes: collectCodes(),
    // 仓储方：聚水潭导入按它区分同名商品（空 = 不限）
    warehouse_party: (($("pWarehouseParty") || {}).value || "").trim(),
    name: $("pName").value,
    category: $("pCategory").value,
    product_type: ptype,
    base_unit: unitPayload.base_unit,
    default_unit: unitPayload.default_unit,
    spec: $("pSpec").value,
    // 界面上售价/成本按「默认单位」填，存库要折回基础单位；
    // PM_UNIT_F 就是当前显示单位对应的换算系数（打开弹窗时设置，切换单位时同步更新）
    sale_price: +((+$("pSalePrice").value || 0) / (PM_UNIT_F || 1)).toFixed(8),
    unit_cost: +((+$("pUnitCost").value || 0) / (PM_UNIT_F || 1)).toFixed(8),
    // 跨类别换单位（个↔克）时的换算关系：1 旧基础单位 = N 新基础单位；没换/无历史数据时留空
    unit_change_ratio: parseFloat($("pUnitRatio") ? $("pUnitRatio").value : "") || null,
    weight_kg: +($("pWeightKg").value || 0),
    conversions: unitPayload.conversions,
    pack_items: collectPacks(),
    pack_fee: +$("pPackFee").value || 0,
    stock_product_id: stockLinks.length ? stockLinks[0].product_id : null,
    multiplier: stockLinks.length ? stockLinks[0].multiplier : 1,
    stock_links: stockLinks,
    stock_schemes: schemes,   // 多套扣减方案（[] = 清空，只剩上面的 stock_links）
    free_shipping: $("pFreeShip") ? $("pFreeShip").checked : false,
    // 这个商品出库默认按哪家快递公司计费（空 = 默认快递）
    express_carrier: $("pExpressCarrier") ? $("pExpressCarrier").value : "",
    is_active: $("pActive") ? $("pActive").checked : true,
  };
  return payload;
}
/** 「复制」：把当前弹窗里的商品信息（含还没保存的改动）原样带进「新增商品」表单，
    改个编码/名称即可存成一条新商品 —— 关联结算这类同类商品多，不用再从头填一遍。
    编码全局唯一，复制品必须另填，这里清空（多店铺编码同理）。 */
function duplicateProduct() {
  const draft = collectProductPayload();
  if (!(draft.name || "").trim()) { toast("请先填写商品名称"); return; }
  draft.code = "";
  draft.codes = [];
  draft.code_takeover = false;
  draft.unit_change_ratio = null;   // 换单位换算关系是原商品的历史迁移参数，复制品用不上
  draft.is_active = true;
  openProductModal(0, "", draft);
}
async function saveProduct(pid, opts) {
  const payload = collectProductPayload(opts);
  if (!payload.name.trim()) { toast("请填写商品名称"); return; }
  // 订单商品可以不关联库存大类 = 代发（本仓不扣库存，只统计代发数量与代发成本）；
  // 但代发成本按「参考成本」计，没填就会算成 0，这里给个提醒（不拦保存）。
  if (payload.product_type === "order" && !(payload.stock_links || []).length && !payload.unit_cost) {
    if (!(await uiConfirm("该订单商品未关联库存商品（= 代发），但「参考成本」为 0，代发成本会按 0 计。仍要保存吗？"))) return;
  }
  try {
    if (pid) await api("/api/products/" + pid, "PUT", payload);
    else await api("/api/products", "POST", payload);
    closeModal(); toast("商品已保存");
    PRODUCTS = await api("/api/products");
    renderProducts();
  } catch (e) {
    // 编码已被别的商品占用（编码一对一）：不关弹窗、不动已填内容，就地给「替换编码」按钮
    const conflict = e.detail && e.detail.code_conflict;
    if (e.status === 409 && conflict) { showCodeConflict(pid, conflict); return; }
    // 换单位的换算关系没填：后端消息是分行的说明，toast 看不全，用弹窗
    if (/换算关系/.test(e.message || "")) alert(e.message);
    else toast("保存失败：" + e.message);
  }
}
/** 编码冲突：在「商品编码」输入框下面挂一条提示 + 「替换编码」按钮（表单内容不丢）。
    点替换 = 把占用该编码的商品编码清空、改给当前商品（后端 code_takeover=true 原子完成）。 */
function showCodeConflict(pid, c) {
  const input = $("pCode");
  if (!input) { toast(`编码被「${c.name}」占用`); return; }
  const field = input.closest(".field") || input.parentElement;
  let box = $("pCodeWarn");
  if (!box) {
    box = document.createElement("div");
    box.id = "pCodeWarn";
    box.className = "alert warn";
    box.style.marginTop = "8px";
    field.appendChild(box);
  }
  box.innerHTML = `编码 <b>${esc(c.code)}</b> 已被商品「<b>${esc(c.name)}</b>」使用（编码一对一）。
    <div style="margin-top:6px;display:flex;gap:8px;align-items:center;flex-wrap:wrap;">
      <button class="btn sm" onclick="saveProduct(${pid || 0}, {takeover: true})">
        <svg class="ic"><use href="#i-check"/></svg> 替换编码（原商品改回空编码）
      </button>
      <span class="muted" style="font-size:12px;">或者自己换一个不重复的编码再保存</span>
    </div>`;
  box.scrollIntoView({ block: "nearest" });
}
async function deleteProduct(pid) {
  if (!(await uiConfirm("确认删除该商品？其历史单据会一并删除，请谨慎。"))) return;
  try { await api("/api/products/" + pid, "DELETE"); closeModal(); toast("已删除"); PRODUCTS = await api("/api/products"); renderProducts(); }
  catch (e) { showDeleteBlocked("商品", e.message); }
}

/** 删除被拒时弹窗：后端把「引用来源」逐行放在 detail 里（首行是结论，其余以「- 」开头），逐条列出来 */
function showDeleteBlocked(subject, message) {
  const lines = String(message || "").split("\n").map((x) => x.trim()).filter(Boolean);
  const head = lines.length ? lines[0] : `${subject}仍被引用，无法删除`;
  const items = lines.slice(1).map((x) => `<li>${esc(x.replace(/^[-•]\s*/, ""))}</li>`).join("");
  openModal(`
    <h3>${esc(subject)}无法删除 <button class="close" onclick="closeModal()">✕</button></h3>
    <p style="margin:10px 0 6px;">${esc(head)}</p>
    ${items ? `<ul style="margin:0 0 14px 20px;line-height:1.9;">${items}</ul>` : ""}
    <div class="field-hint">提示：清掉上面的引用后即可删除；只想让它在列表里不再出现，也可以把商品改成「停用」。</div>
    <div class="modal-foot"><button class="btn" onclick="closeModal()">知道了</button></div>`);
}

/* =============== 一单多货（多货合并打包规则） =============== */
let PACK_RULES = [];
async function loadPackRules() {
  if (!PRODUCTS.length) PRODUCTS = await api("/api/products");
  PACK_RULES = await api("/api/pack-rules");
  const boxes = [...new Set(PACK_RULES.map((r) => r.box_type).filter(Boolean))].sort();
  const bs = $("prBox");
  if (bs && boxes.join() !== (bs._boxes || []).join()) {
    bs._boxes = boxes;
    bs.innerHTML = '<option value="">全部纸箱型号</option>' + boxes.map((b) => `<option value="${esc(b)}">${esc(b)}</option>`).join("");
  }
  renderPackRules();
}
function prOrderProducts() { return PRODUCTS.filter((p) => p.product_type === "order"); }
function prItemOptions(selPid, orderProds) {
  return `<option value="">— 不关联（保留下方名称）—</option>` +
    orderProds.map((p) => `<option value="${p.id}" ${selPid === p.id ? "selected" : ""}>${esc(p.name)}</option>`).join("");
}
function prStockProducts() {
  return PRODUCTS.filter((p) => p.is_active && p.product_type === "stock" && !["人工", "包材", "快递"].includes(p.category));
}
function prStockOptions(selPid) {
  return `<option value="">— 按订单商品默认 —</option>` +
    prStockProducts().map((p) => `<option value="${p.id}" ${selPid === p.id ? "selected" : ""}>${esc(p.name)}（${esc(p.category) || "—"}·单位${esc(p.default_unit || p.base_unit)}）</option>`).join("");
}
function prItemRowHtml(it) {
  it = it || {};
  const orderProds = prOrderProducts();
  let pid = it.product_id || null;
  // 商品已不存在的关联，降级为原文并取消关联
  let name = it.name || "";
  if (pid && !PRODUCTS.find((x) => x.id === pid)) { pid = null; }
  if (pid) name = (PRODUCTS.find((x) => x.id === pid)?.name) || name;
  return `<div class="pr-item-row">
    <select class="pr-item-product searchable" onchange="prItemLinked(this)">${prItemOptions(pid, orderProds)}</select>
    <input class="pr-item-name" value="${esc(name)}" placeholder="商品名称（未关联时原文）" />
    <input class="pr-item-qty" type="number" step="any" value="${it.quantity != null ? it.quantity : 1}" />
    <select class="pr-item-stock searchable" title="出库扣减目标（库存大类）">${prStockOptions(it.stock_product_id)}</select>
    <input class="pr-item-mult" type="number" step="any" min="0.0001" value="${it.multiplier != null ? it.multiplier : 1}" title="每件扣减倍数（×库存默认单位）" />
    <button class="btn danger sm" onclick="this.closest('.pr-item-row').remove()">删</button>
  </div>`;
}
function prItemLinked(sel) {
  const row = sel.closest(".pr-item-row");
  const m = PRODUCTS.find((x) => x.id === +sel.value);
  if (m) row.querySelector(".pr-item-name").value = m.name;
}
function addPrItemRow() {
  const box = $("prItems");
  box.insertAdjacentHTML("beforeend", prItemRowHtml());
  bindSearchable(box); // 新追加行的下拉也需支持输入筛选
}
/* 箱型号→包材纸箱 关联 */
function prBoxProducts() {
  return PRODUCTS.filter((p) => p.is_active && p.category === "包材" && (p.name.includes("箱") || p.name.includes("纸")));
}
function prModelOf(pname) {
  const n = String(pname || "");
  if (n.endsWith("纸箱")) return n.slice(0, -2);
  if (n.endsWith("号箱")) return n.slice(0, -1);
  return n;
}
function prBoxOptions(selPid) {
  return `<option value="">自定义（下方输入型号）</option>` +
    prBoxProducts().map((p) => `<option value="${p.id}" ${selPid === p.id ? "selected" : ""}>${esc(p.name)}</option>`).join("");
}
function prBoxRowHtml(bx) {
  bx = bx || {};
  let pid = bx.product_id || null;
  let name = bx.name || "";
  if (pid && !PRODUCTS.find((x) => x.id === pid)) { pid = null; }
  if (pid) name = prModelOf(PRODUCTS.find((x) => x.id === pid)?.name) || name;
  return `<div class="pr-box-row">
    <select class="pr-box-product searchable" onchange="prBoxLinked(this)">${prBoxOptions(pid)}</select>
    <input class="pr-box-name" value="${esc(name)}" placeholder="箱型号，如 3号 / 邮政6号" />
    <input class="pr-box-qty" type="number" step="any" min="1" value="${bx.quantity != null ? bx.quantity : 1}" />
    <button class="btn danger sm" onclick="this.closest('.pr-box-row').remove()">删</button>
  </div>`;
}
function prBoxLinked(sel) {
  const row = sel.closest(".pr-box-row");
  if (sel.value) {
    const m = PRODUCTS.find((x) => x.id === +sel.value);
    if (m) row.querySelector(".pr-box-name").value = prModelOf(m.name);
  }
}
function addPrBoxRow() {
  const box = $("prBoxItems");
  box.insertAdjacentHTML("beforeend", prBoxRowHtml());
  bindSearchable(box); // 新追加行的下拉也需支持输入筛选
}
function collectPrBoxItems() {
  const out = [];
  document.querySelectorAll("#prBoxItems .pr-box-row").forEach((row) => {
    const sel = row.querySelector(".pr-box-product");
    const n = (row.querySelector(".pr-box-name").value || "").trim();
    const q = parseFloat(row.querySelector(".pr-box-qty").value);
    if (!n) return;
    out.push({ product_id: sel && sel.value ? +sel.value : null, name: n, quantity: q > 0 ? q : 1 });
  });
  return out;
}
function collectPrItems() {
  const out = [];
  document.querySelectorAll("#prItems .pr-item-row").forEach((row) => {
    const sel = row.querySelector(".pr-item-product");
    const n = (row.querySelector(".pr-item-name").value || "").trim();
    const q = parseFloat(row.querySelector(".pr-item-qty").value);
    if (!n) return;
    const stockSel = row.querySelector(".pr-item-stock");
    const mult = parseFloat(row.querySelector(".pr-item-mult").value);
    out.push({
      product_id: sel && sel.value ? +sel.value : null,
      name: n,
      quantity: q > 0 ? q : 1,
      stock_product_id: stockSel && stockSel.value ? +stockSel.value : null,
      multiplier: mult > 0 ? mult : 1,
    });
  });
  return out;
}
function openPackRuleModal(rid = 0) {
  const r = rid ? PACK_RULES.find((x) => x.id === rid) : null;
  const items = (r ? r.items || [] : []).map((it) => ({ product_id: it.product_id, name: it.name, quantity: it.quantity, stock_product_id: it.stock_product_id, multiplier: it.multiplier }));
  if (!items.length) items.push({ product_id: null, name: "", quantity: 1 });
  const boxes = (r ? r.box_items || [] : []).map((bx) => ({ product_id: bx.product_id, name: bx.name, quantity: bx.quantity }));
  if (!boxes.length && r && r.box_type) {
    (r.box_type || "").split("+").forEach((part) => {
      const m = part.trim().match(/^(.*?)(?:\*(\d+))?$/);
      if (m && m[1]) boxes.push({ product_id: null, name: m[1], quantity: m[2] ? +m[2] : 1 });
    });
  }
  if (!boxes.length) boxes.push({ product_id: null, name: "", quantity: 1 });
  openModal(`
    <h3>${rid ? "编辑" : "新增"}一单多货规则 <button class="close" onclick="closeModal()">✕</button></h3>
    <div class="block-title">组合商品（多货打包：一张订单含以下多种商品）</div>
    <div id="prItems">${items.map((it) => prItemRowHtml(it)).join("")}</div>
    <button class="btn secondary sm" style="margin-top:8px;" onclick="addPrItemRow()">＋ 添加组合商品</button>
    <div class="block-title" style="margin-top:16px;">纸箱型号（关联包材纸箱） <span class="hint">选择包材商品并填数量，自动生成箱型号</span></div>
    <div id="prBoxItems">${boxes.map((bx) => prBoxRowHtml(bx)).join("")}</div>
    <button class="btn secondary sm" style="margin-top:8px;" onclick="addPrBoxRow()">＋ 添加箱型</button>
    <div class="form-grid" style="margin-top:14px;">
      <div class="field"><label>工人单价（元/单）</label><input id="prLabor" type="number" step="any" value="${r?.labor_price ?? ""}" placeholder="可空" /></div>
      <div class="field"><label>箱单比</label><input id="prRatio" type="number" step="any" min="1" value="${r?.box_ratio || 1}" /></div>
      <div class="field"><label>备注</label><input id="prRemark" value="${esc(r?.remark || "")}" placeholder="可选" /></div>
    </div>
    <label style="display:flex;gap:6px;align-items:center;margin-top:10px;"><input type="checkbox" id="prActive" ${r ? (r.is_active ? "checked" : "") : "checked"}/> 启用该规则</label>
    <div class="modal-foot">
      ${r ? `<button class="btn danger" onclick="deletePackRule(${r.id})" style="margin-right:auto;">删除</button>` : ""}
      <button class="btn secondary" onclick="closeModal()">取消</button>
      <button class="btn" onclick="savePackRule(${rid || 0})">保存</button>
    </div>`);
}
async function savePackRule(rid) {
  const items = collectPrItems();
  if (!items.length) { toast("至少填写一条组合商品"); return; }
  const body = {
    items,
    box_items: collectPrBoxItems(),
    labor_price: $("prLabor").value === "" ? null : +$("prLabor").value,
    box_ratio: +$("prRatio").value || 1,
    remark: $("prRemark").value,
    is_active: $("prActive").checked,
  };
  try {
    if (rid) await api("/api/pack-rules/" + rid, "PUT", body);
    else await api("/api/pack-rules", "POST", body);
    closeModal(); toast("规则已保存");
    PACK_RULES = await api("/api/pack-rules");
    renderPackRules();
  } catch (e) { toast("保存失败：" + e.message); }
}
async function deletePackRule(rid) {
  if (!(await uiConfirm("确认删除该一单多货规则？"))) return;
  try { await api("/api/pack-rules/" + rid, "DELETE"); closeModal(); toast("已删除"); PACK_RULES = await api("/api/pack-rules"); renderPackRules(); }
  catch (e) { toast("删除失败：" + e.message); }
}
function renderPackRules() {
  const kws = splitSearchKeywords($("prSearch")?.value);
  const box = $("prBox")?.value || "";
  const rows = PACK_RULES.filter((r) => {
    const hay = [
      r.name, r.box_type,
      (r.items || []).map((it) => it.name || "").join(" "),
      (r.box_items || []).map((it) => it.name || "").join(" "),
    ].join(" ");
    return searchHit(hay, kws) && (!box || (r.box_type || "") === box);
  });
  // 停用的规则排到最后，不与启用的混在一起
  rows.sort((a, b) => (a.is_active === false ? 1 : 0) - (b.is_active === false ? 1 : 0));
  const t = $("prTable");
  t.innerHTML = `<thead><tr>
    <th class="cb-col"><input type="checkbox" onclick="toggleAll(this,'pr')" /></th>
    <th>组合（一单多货）</th><th>纸箱型号（关联包材）</th><th class="num">工人单价</th><th class="num">箱单比</th><th>备注</th><th>状态</th><th>操作</th>
  </tr></thead><tbody>` +
    rows.map((r) => {
      const items = (r.items || []).map((it) => {
        const m = it.product_id ? PRODUCTS.find((x) => x.id === it.product_id) : null;
        const nm = m ? m.name : (it.name || "?");
        let label = `${esc(nm)}${it.quantity != 1 ? `×${fmtNum(it.quantity)}` : ""}`;
        if (it.stock_product_id) {
          const sm = PRODUCTS.find((x) => x.id === it.stock_product_id);
          label += `　<span class="badge income" title="出库扣减目标">扣${esc(sm ? sm.name : "?")}×${fmtNum(it.multiplier)}</span>`;
        }
        return label;
      }).join("，");
      const boxChips = (r.box_items || []).map((bi) => {
        const bm = bi.product_id ? PRODUCTS.find((x) => x.id === bi.product_id) : null;
        const label = bm ? bm.name : (bi.name || "—");
        const chip = bm ? "income" : "adjust";
        return `<span class="badge ${chip}">${esc(label)}${bi.quantity != 1 ? ` ×${fmtNum(bi.quantity)}` : ""}</span>`;
      }).join(" ") || "—";
      return `<tr>
        <td class="cb-col"><input type="checkbox" value="${r.id}" ${prSel.has(r.id) ? "checked" : ""} onchange="toggleSel('pr',${r.id},this.checked)" /></td>
        <td><b>${esc(r.name)}</b><div class="muted" style="font-size:12px;">${esc(items)}</div></td>
        <td>${boxChips}</td>
        <td class="num">${r.labor_price != null ? fmtNum(r.labor_price) : "—"}</td>
        <td class="num">${r.box_ratio || 1}</td>
        <td class="muted">${esc(r.remark) || "—"}</td>
        <td>${r.is_active ? '<span class="badge in">启用</span>' : '<span class="badge off">停用</span>'}</td>
        <td class="line-actions"><button class="btn sm secondary" onclick="openPackRuleModal(${r.id})">编辑</button></td>
      </tr>`;
    }).join("") + `</tbody>`;
  if (!rows.length) t.innerHTML = `<tr><td colspan="8" class="empty">暂无一单多货规则</td></tr>`;
  updateBatchBar("pr");
}
async function batchDeletePackRules() {
  const ids = [...prSel];
  if (!ids.length) { toast("请先勾选要删除的规则"); return; }
  if (!(await uiConfirm(`确认删除选中的 ${ids.length} 条一单多货规则？`))) return;
  try {
    let deleted = 0;
    for (const id of ids) { await api("/api/pack-rules/" + id, "DELETE"); deleted++; }
    prSel.clear();
    toast(`已删除 ${deleted} 条规则`);
    PACK_RULES = await api("/api/pack-rules");
    renderPackRules();
  } catch (e) { toast("删除失败：" + e.message); }
}

