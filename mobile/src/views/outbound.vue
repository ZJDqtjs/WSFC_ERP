<template>
  <div>
    <div class="seg">
      <div class="seg-item" :class="{ active: tab === 'new' }" @click="tab = 'new'">新增出库单</div>
      <div class="seg-item" :class="{ active: tab === 'list' }" @click="switchList">出库记录</div>
    </div>

    <!-- ============ 新增出库单 ============ -->
    <template v-if="tab === 'new'">
      <div class="card">
        <div class="card-title">
          <span class="grow">单据信息</span>
          <van-button size="mini" plain type="primary" icon="down" @click="openBatch('jushuitan')">聚水潭</van-button>
          <van-button size="mini" plain icon="down" @click="openBatch('outbound')">批量</van-button>
        </div>
        <van-cell-group inset>
          <van-field v-model="form.date" label="日期" type="date" />
          <van-field v-model="form.customer" label="客户" placeholder="可留空" />
          <OperatorField v-model="form.operator" />
          <AttachmentField v-model="form.remark" />
        </van-cell-group>

        <div class="divider"></div>
        <div class="row" style="justify-content:space-between;">
          <span class="bold">销售商品行（{{ rows.length }}）</span>
          <span class="muted">小计 {{ fmtMoney(saleAmount) }}</span>
        </div>

        <div v-for="(r, i) in rows" :key="i" class="io-row">
          <div class="row" style="justify-content:space-between;">
            <span class="grow io-name" @click="openPicker(i)">
              <template v-if="r.product_id">{{ r.name }}</template>
              <template v-else><span class="placeholder"><van-icon name="plus" /> 点击选择商品</span></template>
            </span>
            <van-icon v-if="rows.length > 1" name="delete-o" class="c-danger" @click="removeRow(i)" />
          </div>
          <div v-if="r.product_id" class="muted io-hint" @click="openUnit(i)">
            销售单位：{{ r.unit }}（点此切换） · 折算 {{ fmtNum(num(r.qty) * num(r._factor)) }} {{ r._base_unit }}
          </div>
          <div class="row mt8">
            <van-field v-model="r.qty" type="number" label="数量" />
            <van-field v-model="r.price" type="number" label="单价" />
            <div class="io-amount">{{ fmtMoney(rowAmount(r)) }}</div>
          </div>
        </div>
        <div class="row" style="gap:8px;margin-top:10px;">
          <van-button size="small" plain type="primary" icon="plus" @click="addRow">加一行</van-button>
          <van-button size="small" plain @click="clearRows">清空</van-button>
        </div>
        <div class="muted" style="margin-top:8px;">卖商品会自动结转关联包装材料、打包人工与快递费。</div>
      </div>

      <!-- 预览结算结果 -->
      <div v-if="preview" class="card">
        <div class="card-title">
          <span class="grow">关联结算（包装材料 / 固定费用）</span>
          <van-button size="mini" plain @click="preview = null">取消</van-button>
        </div>

        <div v-for="w in preview.warnings || []" :key="w" class="tip warn">⚠ {{ w }}（仍可继续，可先补货）</div>

        <div v-if="!(preview.pack_lines || []).length" class="empty" style="padding:12px 0;">
          该商品未配置包装清单，无需关联结算
        </div>
        <div v-for="(pl, i) in preview.pack_lines || []" :key="i" class="pack-line">
          <div class="row">
            <span class="grow item-title">{{ pl.product_name }}</span>
            <van-icon name="cross" class="c-danger" @click="removePackLine(i)" />
          </div>
          <div class="row mt8">
            <span class="muted" @click="openPackUnit(i)">
              单位 {{ pl.unit }}（点击切换）
            </span>
            <div class="grow"></div>
            <van-field v-model="pl.quantity" type="number" label="数量" @update:model-value="calcPreview" />
            <div class="io-amount">{{ fmtMoney(packLineCost(pl)) }}</div>
          </div>
          <div class="muted">{{ fmtMoney(packLineUnitPrice(pl)) }}/{{ pl.unit }} · 成本小计 {{ fmtMoney(packLineCost(pl)) }}</div>
        </div>

        <div class="divider"></div>
        <div class="form-row">
          <span class="lbl">固定费用合计（人工打包费等）</span>
          <div class="inline-field">
            <van-field v-model="packFeeTotal" type="number" style="width:96px;" @update:model-value="calcPreview" />
            <span class="muted">元</span>
          </div>
        </div>

        <div class="stat-grid cols2" style="margin-top:10px;">
          <div class="stat"><div class="label">销售收入</div><div class="value">{{ fmtMoney(totals.amount) }}</div></div>
          <div class="stat"><div class="label">结转成本</div><div class="value">{{ fmtMoney(totals.cogs) }}</div></div>
          <div class="stat success"><div class="label">毛利</div><div class="value">{{ fmtMoney(totals.gross) }}</div></div>
          <div class="stat success"><div class="label">净利</div><div class="value">{{ fmtMoney(totals.net) }}</div></div>
        </div>
        <div class="muted" style="margin-top:6px;">
          结转成本含商品成本、包装耗材与快递费；毛利 = 收入 − 成本。合计成本 {{ fmtMoney(totals.cogs) }}。
        </div>

        <van-button block round type="success" style="margin-top:12px;" :loading="saving" @click="submit">确认出库</van-button>
      </div>

      <div v-else class="card">
        <van-button block round type="primary" :loading="previewing" @click="doPreview">预览结算</van-button>
        <div class="muted" style="margin-top:8px;">建议先预览：会带出泡沫箱 / 泡沫垫 / 打包费等关联结算项与库存预警。</div>
      </div>
    </template>

    <!-- ============ 出库记录 ============ -->
    <template v-else>
      <div class="card">
        <div class="filter-bar">
          <van-field v-model="filter.from" type="date" />
          <van-field v-model="filter.to" type="date" />
          <van-button size="small" type="primary" @click="loadList">筛选</van-button>
          <van-button size="small" plain @click="quick(0)">今天</van-button>
          <van-button size="small" plain @click="quick(7)">近7天</van-button>
          <van-button size="small" plain @click="quick(null)">全部</van-button>
        </div>
        <van-field v-model="kw" placeholder="筛选单号 / 客户" class="kw-field" />

        <div v-if="selectedIds.length" class="batch-bar">
          <span class="muted">已选 {{ selectedIds.length }} 单 · 合计 {{ fmtMoney(selectedAmount) }}</span>
          <van-button size="mini" type="danger" @click="batchDelete">批量删除</van-button>
          <van-button size="mini" plain @click="selectedIds = []">取消</van-button>
        </div>
        <div class="muted" style="margin-top:8px;">
          共 {{ list.length }} 单，合并 {{ entries.length }} 行 · 收入 {{ fmtMoney(listAmount) }} · 净利 {{ fmtMoney(listNet) }}
        </div>

        <van-pull-refresh v-model="refreshing" @refresh="loadList">
          <SkeletonList v-if="loading" :rows="4" />
          <template v-else>
          <div v-if="!entries.length" class="empty">暂无出库记录</div>
          <div v-for="e in entries" :key="e.key" class="list-item">
            <div class="row">
              <van-checkbox :model-value="e.ids.every((id) => selectedIds.includes(id))" style="margin-right:8px;" @click="toggleEntry(e)" />
              <span class="grow item-title ellipsis">
                {{ e.code }}
                <van-tag v-if="e.isGroup" type="primary" plain style="margin-left:4px;">批次</van-tag>
                <van-tag v-else-if="e.rec.is_multi" type="warning" plain style="margin-left:4px;">一单多货</van-tag>
              </span>
              <span class="bold">{{ fmtMoney(e.amount) }}</span>
            </div>
            <div class="item-meta">
              {{ e.customer || '—' }} · {{ e.date }} · 成本 {{ fmtMoney(e.cogs) }} · 费用 {{ fmtMoney(e.fee) }} · 净利
              <b :class="e.net >= 0 ? 'up' : 'down'">{{ fmtMoney(e.net) }}</b>
            </div>
            <div v-if="e.isGroup" class="item-meta">
              {{ e.records.length }} 单 · {{ e.products }} 种商品
              {{ e.multiRule ? ' · 规则：' + e.multiRule : '' }}
            </div>
            <RemarkView v-else-if="e.rec.remark" :remark="e.rec.remark" />
            <div class="row" style="gap:8px;margin-top:6px;">
              <van-button v-if="e.isGroup" size="mini" plain type="primary" @click="openGroup(e)">查看批次明细</van-button>
              <van-button v-else size="mini" plain @click="toggleDetail(e)">{{ detailId === e.rec.id ? '收起明细' : '查看明细' }}</van-button>
              <div class="grow"></div>
              <van-button size="mini" plain type="danger" @click="delEntry(e)">删除</van-button>
            </div>

            <!-- 单条明细展开 -->
            <div v-if="!e.isGroup && detailId === e.rec.id" class="detail-box">
              <div v-for="(l, i) in e.rec.lines || []" :key="i" class="detail-line">
                <div class="row">
                  <span class="grow">{{ l.product_name }}</span>
                  <van-tag :type="l.line_type === 'sale' ? 'primary' : 'warning'" plain>
                    {{ l.line_type === 'sale' ? '销售' : '包装消耗' }}
                  </van-tag>
                </div>
                <div class="muted">
                  {{ fmtNum(l.quantity) }}{{ l.unit }} = {{ fmtNum(l.quantity_base) }}{{ l.base_unit || '' }}
                  · 金额 {{ fmtMoney(l.amount) }} · 成本 {{ fmtMoney(l.cogs) }}
                  <template v-if="l.pack_fee"> · 费 {{ fmtMoney(l.pack_fee) }}</template>
                  <template v-if="l.spec"> · {{ l.spec }}</template>
                </div>
              </div>
            </div>
          </div>
          </template>
        </van-pull-refresh>
      </div>
    </template>

    <!-- 销售单位选择 -->
    <van-action-sheet v-model:show="unitShow" :actions="unitActions" cancel-text="取消" @select="onUnitSelect" />
    <!-- 包材单位选择 -->
    <van-action-sheet v-model:show="packUnitShow" :actions="packUnitActions" cancel-text="取消" @select="onPackUnitSelect" />

    <ProductPicker
      v-model:show="pickerShow"
      title="选择销售商品"
      :products="pickableProducts"
      @pick="onPick"
    />

    <!-- 批量导入（批量出库 / 聚水潭） -->
    <van-popup v-model:show="batchShow" position="bottom" round :style="{ height: '90%' }">
      <div class="sheet-body">
        <div class="sheet-title">{{ batchCfg.title }}</div>
        <div class="muted" style="margin-bottom:10px;">{{ batchCfg.hint }}</div>
        <div class="row" style="gap:8px;margin-bottom:10px;">
          <van-button v-if="batchCfg.tpl" size="small" plain type="primary" icon="down" @click="downloadTpl">下载模板</van-button>
          <van-button size="small" plain icon="upgrade" @click="batchFile && batchFile.click()">选择 Excel</van-button>
        </div>
        <input ref="batchFile" type="file" accept=".xlsx" style="display:none" @change="parseBatch" />

        <div v-if="batchParsing" class="loading-tip">正在解析…</div>

        <template v-if="batchOrders.length">
          <div class="row" style="justify-content:space-between;margin-bottom:6px;">
            <span class="bold">解析出 {{ batchOrders.length }} 单</span>
            <van-button size="mini" plain @click="toggleBatchAll">{{ batchAllOn ? '全部取消' : '全部勾选' }}</van-button>
          </div>
          <div v-for="(o, oi) in batchOrders" :key="oi" class="io-row">
            <div class="row">
              <van-checkbox v-model="o._on" style="margin-right:8px;" />
              <span class="grow io-name">{{ o.doc_no || '（无单号）' }}</span>
              <span class="muted">{{ o.date }}</span>
            </div>
            <div class="muted">{{ o.customer || '—' }}{{ o.pack_fee ? ' · 打包费 ' + fmtMoney(o.pack_fee) : '' }}{{ o.pack_rule_name ? ' · 规则：' + o.pack_rule_name : '' }}</div>
            <div v-for="(l, li) in o.lines" :key="li" class="batch-line">
              <span class="grow ellipsis">{{ l.product_name }}{{ l.deduct ? `（${l.deduct}）` : '' }}</span>
              <van-field v-model="l.quantity" type="number" placeholder="数量" style="width:78px;" />
              <van-field v-model="l.price" type="number" placeholder="单价" style="width:88px;" />
              <span class="io-amount">{{ fmtMoney(num(l.quantity) * num(l.price)) }}</span>
            </div>
          </div>
        </template>

        <div v-if="batchUnmapped.length" class="tip warn">
          ⚠ 未关联商品：{{ batchUnmapped.join('、') }}
          <div v-if="batchKind === 'jushuitan'" style="margin-top:8px;">
            <van-button size="mini" plain type="primary" :loading="aiMapping" @click="aiAutoMap">AI 自动新增并关联，重新解析</van-button>
          </div>
        </div>
        <div v-if="batchSkipText" class="tip warn">⚠ 跳过：{{ batchSkipText }}</div>
        <div v-if="batchFailed.length" class="tip err">
          解析失败 {{ batchFailed.length }} 条：{{ batchFailed.slice(0, 5).map((f) => f.reason).join('；') }}
        </div>

        <div class="sheet-foot">
          <van-button block plain @click="batchShow = false">关闭</van-button>
          <van-button block type="success" :disabled="!batchOrders.length" :loading="batchSaving" @click="confirmBatch">
            确认出库
          </van-button>
        </div>
      </div>
    </van-popup>
  </div>
</template>

<script setup>
import { ref, reactive, computed, onMounted, onActivated } from 'vue'
import { useRouter } from 'vue-router'
import { showToast, showConfirmDialog } from 'vant'
import api, { upload, downloadFile } from '../api'
import ProductPicker from '../components/ProductPicker.vue'
import AttachmentField from '../components/AttachmentField.vue'
import RemarkView from '../components/RemarkView.vue'
import OperatorField from '../components/OperatorField.vue'
import SkeletonList from '../components/SkeletonList.vue'
import { ensureUserName } from '../utils/user'
import { fmtMoney, fmtNum, num, defaultUnit, unitFactor, priceOf, todayStr } from '../utils/format'

const router = useRouter()
const tab = ref('new')
const refreshing = ref(false)
const loading = ref(true)   // 记录列表首屏骨架屏

/* ---------- 新增 ---------- */
const form = reactive({ date: todayStr(), customer: '', operator: '', remark: '' })
const rows = ref([newRow()])
const saving = ref(false)
const previewing = ref(false)
const preview = ref(null)
const packFeeTotal = ref('0')

function newRow() {
  return { product_id: '', name: '', unit: '', qty: '1', price: '0', _factor: 1, _base_unit: '', _product: null }
}
const saleAmount = computed(() => rows.value.reduce((s, r) => s + rowAmount(r), 0))
const rowAmount = (r) => (r.product_id ? num(r.qty) * num(r.price) : 0)

function addRow() { rows.value.push(newRow()) }
function clearRows() { rows.value = [newRow()]; preview.value = null }
function removeRow(i) { rows.value.splice(i, 1) }

function saleLines() {
  return rows.value
    .filter((r) => r.product_id && num(r.qty) > 0)
    .map((r) => ({ product_id: +r.product_id, unit: r.unit, quantity: num(r.qty), price: num(r.price) }))
}

async function doPreview() {
  const lines = saleLines()
  if (!lines.length) { showToast('请至少添加一行销售商品'); return }
  previewing.value = true
  try {
    const r = await api('/api/outbounds/preview', 'POST', { lines })
    preview.value = r
    packFeeTotal.value = String(r.total_fee != null ? r.total_fee : 0)
  } catch (e) { showToast('预览失败：' + e.message) }
  previewing.value = false
}

/* 预览区成本重算（包材数量/单位被手动改过时）
   成本优先采用后端 build_order 给出的先进先出(FIFO)单位成本（unit_price，按展示单位），
   与保存后的出库单一致；缺失时回退「库存均价 or 参考成本 × 单位换算系数」估算。
   快递费行的商品无库存成本，直接沿用后端给出的每单费用（unit_price）。 */
function packLineBaseCost(pl) {
  const p = PRODUCTS.value.find((x) => x.id === pl.product_id)
  if (p && p.category === '快递') return 0
  return p ? (num(p.avg_cost) || num(p.unit_cost)) : 0
}
function packLineUnitPrice(pl) {
  const up = num(pl.unit_price)
  if (up > 0) return up
  const base = packLineBaseCost(pl)
  if (base > 0) {
    const p = PRODUCTS.value.find((x) => x.id === pl.product_id)
    return base * unitFactor(p, pl.unit)
  }
  return 0
}
function packLineCost(pl) {
  return packLineUnitPrice(pl) * num(pl.quantity)
}
function removePackLine(i) {
  preview.value.pack_lines.splice(i, 1)
  calcPreview()
}

const totals = computed(() => {
  const p = preview.value
  if (!p) return { amount: 0, cogs: 0, gross: 0, net: 0 }
  const amount = (p.sale_lines || []).reduce((s, l) => s + num(l.amount), 0)
  const goodsCogs = (p.sale_lines || []).reduce((s, l) => s + num(l.cogs), 0)
  const packCogs = (p.pack_lines || []).reduce((s, l) => s + packLineCost(l), 0)
  const fee = num(packFeeTotal.value)
  const cogs = goodsCogs + packCogs
  return { amount, cogs, gross: amount - cogs, net: amount - cogs - fee }
})
function calcPreview() {}

async function submit() {
  const lines = saleLines()
  if (!lines.length) { showToast('请至少添加一行销售商品'); return }
  const packLines = (preview.value?.pack_lines || [])
    .filter((l) => num(l.quantity) > 0)
    .map((l) => ({ product_id: l.product_id, unit: l.unit, quantity: num(l.quantity) }))
  saving.value = true
  try {
    const r = await api('/api/outbounds', 'POST', {
      customer: form.customer,
      operator: form.operator,
      date: form.date,
      remark: form.remark,
      lines,
      pack_lines: packLines,
      pack_fee_total: num(packFeeTotal.value),
    })
    const warns = (r.warnings || []).length ? '\n⚠ ' + r.warnings.join('；') : ''
    showToast('出库成功' + warns)
    clearRows()
    form.customer = ''
    form.remark = ''
    loadList()
  } catch (e) { showToast('出库失败：' + e.message) }
  saving.value = false
}

/* ---------- 商品 / 单位 ---------- */
const PRODUCTS = ref([])
const pickerShow = ref(false)
let pickIndex = 0
const pickableProducts = computed(() =>
  PRODUCTS.value.filter((p) => p.is_active && !['人工', '快递'].includes(p.category))
)
async function ensureProducts() {
  if (PRODUCTS.value.length) return
  try { PRODUCTS.value = await api('/api/products') } catch (e) {}
}
async function openPicker(i) {
  pickIndex = i
  await ensureProducts()
  pickerShow.value = true
}
function onPick(p) {
  const r = rows.value[pickIndex]
  r.product_id = p.id
  r.name = p.name
  r._product = p
  r.unit = p.product_type === 'order' ? '单' : defaultUnit(p)
  r._factor = p.product_type === 'order' ? 1 : unitFactor(p, r.unit)
  r._base_unit = p.base_unit
  r._conversions = p.conversions || {}
  const pr = p.product_type === 'order' ? num(p.sale_price) : priceOf(p, r.unit)
  r.price = pr > 0 ? pr.toFixed(2) : '0'
  if (preview.value) preview.value = null
}

const unitShow = ref(false)
let unitIndex = 0
const unitActions = ref([])
function openUnit(i) {
  const r = rows.value[i]
  if (!r.product_id) return
  unitIndex = i
  const convs = r._product && r._product.product_type === 'order' ? { 单: 1 } : r._conversions || {}
  unitActions.value = Object.keys(convs).map((u) => ({ name: u, value: u }))
  if (!unitActions.value.length) unitActions.value = [{ name: r.unit, value: r.unit }]
  unitShow.value = true
}
function onUnitSelect(a) {
  const r = rows.value[unitIndex]
  r.unit = a.value
  r._factor = num((r._conversions || {})[a.value]) || 1
  const pr = r._product ? priceOf(r._product, a.value) : 0
  if (pr > 0) r.price = pr.toFixed(2)
  unitShow.value = false
  if (preview.value) preview.value = null
}

const packUnitShow = ref(false)
let packIndex = 0
const packUnitActions = ref([])
function openPackUnit(i) {
  packIndex = i
  const pl = preview.value.pack_lines[i]
  const p = PRODUCTS.value.find((x) => x.id === pl.product_id)
  const convs = (p && p.conversions) || { [pl.unit]: 1 }
  packUnitActions.value = Object.keys(convs).map((u) => ({ name: u, value: u }))
  packUnitShow.value = true
}
function onPackUnitSelect(a) {
  const pl = preview.value.pack_lines[packIndex]
  pl.unit = a.value
  packUnitShow.value = false
}

/* ---------- 记录列表 ---------- */
const list = ref([])
const kw = ref('')
const filter = reactive({ from: '', to: '' })
const selectedIds = ref([])
const detailId = ref(null)

const entries = computed(() => {
  const s = (kw.value || '').trim().toLowerCase()
  const groups = new Map()
  const out = []
  for (const o of list.value) {
    if (o.import_group) {
      if (!groups.has(o.import_group)) groups.set(o.import_group, [])
      groups.get(o.import_group).push(o)
    } else {
      out.push({
        key: `s${o.id}`, isGroup: false, rec: o, ids: [o.id], code: o.code, customer: o.customer,
        date: o.date, amount: num(o.total_amount), cogs: num(o.total_cogs), fee: num(o.total_fee),
        net: num(o.net_profit), products: 0, multiRule: o.multi_rule || '',
      })
    }
  }
  for (const [key, recs] of groups) {
    const ids = recs.map((r) => r.id)
    const customers = [...new Set(recs.map((r) => r.customer).filter(Boolean))]
    const dates = recs.map((r) => r.date).sort()
    const productSet = new Set()
    recs.forEach((r) => (r.lines || []).forEach((l) => { if (l.line_type === 'sale') productSet.add(l.product_id) }))
    out.push({
      key: `g${key}`, isGroup: true, records: recs, importGroup: key, ids,
      code: `批量 · ${recs.length}单`,
      customer: customers.join(' / ') || '—',
      date: dates[0] === dates[dates.length - 1] ? dates[0] : `${dates[0]} ~ ${dates[dates.length - 1]}`,
      amount: recs.reduce((s, r) => s + num(r.total_amount), 0),
      cogs: recs.reduce((s, r) => s + num(r.total_cogs), 0),
      fee: recs.reduce((s, r) => s + num(r.total_fee), 0),
      net: recs.reduce((s, r) => s + num(r.net_profit), 0),
      products: productSet.size,
      multiRule: '',
    })
  }
  const filtered = s
    ? out.filter((e) => {
        const hay = e.isGroup
          ? [e.code, e.customer, e.date, ...e.records.map((r) => r.code), ...e.records.map((r) => r.customer || '')]
          : [e.code, e.customer || '']
        return hay.join(' ').toLowerCase().includes(s)
      })
    : out
  return filtered.sort((a, b) => (b.ids[0] || 0) - (a.ids[0] || 0))
})

async function loadList() {
  if (!list.value.length) loading.value = true
  try {
    const q = []
    if (filter.from) q.push(`date_from=${filter.from}`)
    if (filter.to) q.push(`date_to=${filter.to}`)
    list.value = await api('/api/outbounds' + (q.length ? '?' + q.join('&') : ''))
    selectedIds.value = selectedIds.value.filter((id) => list.value.some((r) => r.id === id))
  } catch (e) { showToast(e.message || '加载失败') }
  loading.value = false
  refreshing.value = false
}
/* 列表汇总：让"共 N 单"之外还能直接看到收入与净利，不用进报表 */
const listAmount = computed(() => list.value.reduce((s, o) => s + num(o.total_amount), 0))
const listNet = computed(() => list.value.reduce((s, o) => s + num(o.net_profit), 0))
const selectedAmount = computed(() => {
  const set = new Set(selectedIds.value)
  return list.value.filter((o) => set.has(o.id)).reduce((s, o) => s + num(o.total_amount), 0)
})
function switchList() { tab.value = 'list'; loadList() }
function quick(days) {
  if (days === null) { filter.from = ''; filter.to = '' }
  else {
    const d = new Date()
    d.setDate(d.getDate() - days)
    filter.from = `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`
    filter.to = todayStr()
  }
  loadList()
}
function toggleEntry(e) {
  const all = e.ids.every((id) => selectedIds.value.includes(id))
  if (all) selectedIds.value = selectedIds.value.filter((id) => !e.ids.includes(id))
  else selectedIds.value = [...new Set([...selectedIds.value, ...e.ids])]
}
function toggleDetail(e) { detailId.value = detailId.value === e.rec.id ? null : e.rec.id }
function openGroup(e) { router.push(`/ogroup/${encodeURIComponent(e.importGroup)}`) }

async function delEntry(e) {
  const msg = e.isGroup ? `确认删除该批次共 ${e.ids.length} 单？库存与成本会自动回退。` : `确认删除 ${e.code}？库存与成本会自动回退。`
  try { await showConfirmDialog({ title: '删除出库', message: msg }) } catch (err) { return }
  try {
    if (e.isGroup) await api('/api/outbounds/batch-delete', 'POST', { ids: e.ids })
    else await api(`/api/outbounds/${e.rec.id}`, 'DELETE')
    showToast('已删除')
    loadList()
  } catch (err) { showToast(err.message || '删除失败') }
}
async function batchDelete() {
  try { await showConfirmDialog({ title: '批量删除出库', message: `确认删除已选 ${selectedIds.value.length} 单？` }) } catch (e) { return }
  try {
    const r = await api('/api/outbounds/batch-delete', 'POST', { ids: selectedIds.value })
    showToast(`已删除 ${r.deleted} 单`)
    selectedIds.value = []
    loadList()
  } catch (e) { showToast(e.message || '删除失败') }
}

/* ---------- 批量导入 ---------- */
const BATCH_CFG = {
  outbound: {
    title: '批量出库',
    tpl: '/api/templates/outbounds',
    preview: '/api/import/outbounds/preview',
    confirm: '/api/import/outbounds/confirm',
    hint: '按模板填写后上传，先解析到列表供你检查（可勾选、改数量单价），确认后才真正出库。',
  },
  jushuitan: {
    title: '导入聚水潭出库单',
    tpl: '',
    preview: '/api/jushuitan/import/preview',
    confirm: '/api/jushuitan/import/confirm',
    hint: '上传聚水潭导出的「销售出库单_*.xlsx」，自动识别商品并按件数×每件规格结算。需先在「设置 → 聚水潭关联」把商品名关联到系统商品。',
  },
}
const batchKind = ref('outbound')
const batchShow = ref(false)
const batchFile = ref(null)
const batchParsing = ref(false)
const batchSaving = ref(false)
const batchOrders = ref([])
const batchFailed = ref([])
const batchUnmapped = ref([])
const batchSkip = ref({})
const aiMapping = ref(false)

const batchCfg = computed(() => BATCH_CFG[batchKind.value])
const batchAllOn = computed(() => batchOrders.value.length > 0 && batchOrders.value.every((o) => o._on))
const batchSkipText = computed(() =>
  Object.entries(batchSkip.value).filter(([, v]) => v > 0).map(([k, v]) => `${k} ${v}单`).join('、')
)

async function openBatch(kind) {
  batchKind.value = kind
  batchShow.value = true
  await ensureProducts()
}
function downloadTpl() { downloadFile(batchCfg.value.tpl, `${batchKind.value}_template.xlsx`).catch((e) => showToast(e.message)) }

async function parseBatch(e) {
  const f = e.target.files && e.target.files[0]
  e.target.value = ''
  if (!f) return
  batchParsing.value = true
  batchOrders.value = []
  batchFailed.value = []
  batchUnmapped.value = []
  batchSkip.value = {}
  try {
    const r = await upload(batchCfg.value.preview, f)
    batchOrders.value = (r.orders || []).map((o) => ({ ...o, _on: true }))
    batchFailed.value = r.failed || []
    batchUnmapped.value = r.unmapped_codes || []
    batchSkip.value = r.skip || {}
    if (!batchOrders.value.length) showToast('未解析出可出库的单据')
  } catch (err) { showToast('解析失败：' + err.message) }
  batchParsing.value = false
}

function toggleBatchAll() {
  const v = !batchAllOn.value
  batchOrders.value.forEach((o) => { o._on = v })
}

async function aiAutoMap() {
  const codes = batchUnmapped.value.filter(Boolean)
  if (!codes.length) { showToast('没有可关联的商品名'); return }
  aiMapping.value = true
  try {
    const r = await api('/api/mappings/ai-suggest', 'POST', { source: 'jushuitan', codes })
    showToast(r.message || 'AI 关联完成')
  } catch (e) { showToast('AI 关联失败：' + e.message) }
  aiMapping.value = false
}

async function confirmBatch() {
  const orders = batchOrders.value
    .filter((o) => o._on)
    .map((o) => {
      const lines = (o.lines || [])
        .filter((l) => l.product_id && num(l.quantity) > 0)
        .map((l) => ({ product_id: l.product_id, unit: l.unit, quantity: num(l.quantity), price: num(l.price), gross_sales: num(l.gross_sales) }))
      return {
        doc_no: o.doc_no, date: o.date, customer: o.customer, operator: o.operator, remark: o.remark,
        pack_fee: num(o.pack_fee), lines,
        pack_rule_id: o.pack_rule_id || null,
        pack_rule_name: o.pack_rule_name || '',
        pack_lines: o.pack_lines || [],
      }
    })
    .filter((o) => o.lines.length)
  if (!orders.length) { showToast('没有勾选可出库的单据'); return }
  batchSaving.value = true
  try {
    const r = await api(batchCfg.value.confirm, 'POST', { orders })
    let msg = `已创建 ${r.created} 个出库单`
    if (r.failed_count) msg += `，失败 ${r.failed_count}`
    showToast(msg)
    batchShow.value = false
    batchOrders.value = []
    const dates = orders.map((o) => o.date).filter(Boolean).sort()
    if (dates.length) { filter.from = dates[0]; filter.to = dates[dates.length - 1] }
    tab.value = 'list'
    loadList()
  } catch (e) { showToast('确认出库失败：' + e.message) }
  batchSaving.value = false
}

onMounted(async () => {
  ensureProducts()
  form.operator = await ensureUserName()   // 操作员固定为当前登录账号
  loadList()
})
onActivated(() => { if (tab.value === 'list') loadList() })
</script>

<style scoped>
.pack-line { padding: 8px 0; border-bottom: 1px dashed var(--c-line-2); }
.detail-box { background: var(--c-bg); border-radius: var(--radius-sm); padding: 8px 10px; margin-top: 8px; }
.detail-line { padding: 5px 0; border-bottom: 1px solid var(--c-line-2); font-size: 13px; }
.detail-line:last-child { border-bottom: none; }
.batch-line { display: flex; align-items: center; gap: 6px; padding: 6px 0 0 22px; }
</style>
