<template>
  <div>
    <div class="seg">
      <div class="seg-item" :class="{ active: tab === 'new' }" @click="tab = 'new'">新增入库单</div>
      <div class="seg-item" :class="{ active: tab === 'list' }" @click="switchList">入库记录</div>
    </div>

    <!-- ============ 新增入库单 ============ -->
    <template v-if="tab === 'new'">
      <div class="card">
        <div class="card-title">
          <span class="grow">新增入库单</span>
          <van-button size="mini" plain type="primary" icon="down" @click="batchShow = true">批量入库</van-button>
        </div>
        <van-cell-group inset>
          <van-field v-model="form.date" label="日期" type="date" />
          <van-field v-model="form.supplier" label="供应商" placeholder="可留空" />
          <OperatorField v-model="form.operator" />
          <AttachmentField v-model="form.remark" />
        </van-cell-group>

        <div class="divider"></div>
        <div class="row" style="justify-content:space-between;">
          <span class="bold">入库明细（{{ rows.length }} 行）</span>
          <span class="muted">合计 {{ fmtMoney(totalAmount) }}</span>
        </div>

        <div v-for="(r, i) in rows" :key="i" class="io-row">
          <div class="row" style="justify-content:space-between;">
            <span class="grow io-name" @click="openPicker(i)">
              <template v-if="r.product_id">{{ r.name }}</template>
              <template v-else><span class="placeholder">＋ 点击选择商品</span></template>
            </span>
            <van-icon v-if="rows.length > 1" name="delete-o" color="#ee0a24" @click="rows.splice(i, 1)" />
          </div>
          <div v-if="r.product_id" class="muted io-hint" @click="openUnit(i)">
            进货单位：{{ r.unit }}（点此切换） · 折算 {{ conversionText(r) }}
          </div>
          <div class="row mt8">
            <van-field v-model="r.qty" type="number" label="数量" @update:model-value="calcRow(r)" />
            <van-field v-model="r.price" type="number" label="单价" @update:model-value="calcRow(r)" />
            <div class="io-amount">{{ fmtMoney(rowAmount(r)) }}</div>
          </div>
        </div>

        <div class="row" style="gap:8px;margin-top:10px;">
          <van-button size="small" plain type="primary" icon="plus" @click="addRow">加一行</van-button>
          <van-button size="small" plain @click="clearRows">清空</van-button>
        </div>
      </div>

      <div class="card">
        <van-button block round type="success" :loading="saving" @click="submit">确认入库</van-button>
        <div class="muted" style="margin-top:8px;">按采购单位录入，系统自动折算到基础单位并重算先进先出成本。</div>
      </div>
    </template>

    <!-- ============ 入库记录 ============ -->
    <template v-else>
      <div class="card">
        <div class="row wrap" style="gap:6px;">
          <van-field v-model="filter.from" type="date" style="max-width:132px;background:#f7f8fa;border-radius:6px;padding:6px 10px;" />
          <van-field v-model="filter.to" type="date" style="max-width:132px;background:#f7f8fa;border-radius:6px;padding:6px 10px;" />
          <van-button size="small" type="primary" @click="loadList">筛选</van-button>
          <van-button size="small" plain @click="quick(0)">今天</van-button>
          <van-button size="small" plain @click="quick(7)">近7天</van-button>
          <van-button size="small" plain @click="quick(null)">全部</van-button>
        </div>
        <van-field v-model="kw" placeholder="筛选单号 / 商品 / 供应商" style="background:#f7f8fa;border-radius:6px;margin-top:8px;" />

        <div v-if="selected.length" class="batch-bar">
          <span class="muted">已选 {{ selected.length }} 条 · 合计 {{ fmtMoney(selectedAmount) }}</span>
          <van-button size="mini" type="danger" @click="batchDelete">批量删除</van-button>
          <van-button size="mini" plain @click="selected = []">取消</van-button>
        </div>
        <div class="row" style="justify-content:space-between;margin-top:8px;">
          <span class="muted">共 {{ list.length }} 条</span>
          <van-button size="mini" plain @click="toggleAll">{{ allSelected ? '取消全选' : '全选' }}</van-button>
        </div>

        <van-pull-refresh v-model="refreshing" @refresh="loadList">
          <div v-if="!filteredList.length" class="empty">暂无入库记录</div>
          <div v-for="r in filteredList" :key="r.id" class="list-item">
            <div class="row">
              <van-checkbox
                :model-value="selected.includes(r.id)"
                style="margin-right:8px;"
                @click="toggleSel(r.id)"
              />
              <span class="grow item-title">{{ r.product_name }}</span>
              <span class="bold">{{ fmtMoney(r.total_amount) }}</span>
            </div>
            <div class="item-meta">
              {{ r.code }} · {{ fmtNum(r.quantity) }}{{ r.unit }} × {{ fmtMoney(r.unit_price) }} · {{ r.date }}
            </div>
            <div class="item-meta">
              {{ r.supplier || '无供应商' }}{{ r.operator ? ' · ' + r.operator : '' }}
              <span style="float:right;">
                <van-button size="mini" plain type="danger" @click="del(r)">删除</van-button>
              </span>
            </div>
            <RemarkView v-if="r.remark" :remark="r.remark" />
          </div>
        </van-pull-refresh>
      </div>
    </template>

    <!-- 单位选择 -->
    <van-action-sheet v-model:show="unitShow" :actions="unitActions" cancel-text="取消" @select="onUnitSelect" />

    <ProductPicker
      v-model:show="pickerShow"
      title="选择入库商品"
      :products="pickableProducts"
      :type-tabs="false"
      @pick="onPick"
    />

    <!-- 批量入库 -->
    <van-popup v-model:show="batchShow" position="bottom" round :style="{ height: '88%' }">
      <div class="sheet-body">
        <div class="sheet-title">批量入库</div>
        <div class="muted" style="margin-bottom:10px;">
          按模板填写后上传，先解析预览（可勾选、改数量单价），确认后才真正入库。若商品类别配置了扣点，单价将按 原价×(1-扣点%) 自动折算。
        </div>
        <div class="row" style="gap:8px;margin-bottom:10px;">
          <van-button size="small" plain type="primary" icon="down" @click="downloadTpl('inbounds')">下载模板</van-button>
          <van-button size="small" plain icon="upgrade" @click="batchFile && batchFile.click()">选择 Excel</van-button>
        </div>
        <input ref="batchFile" type="file" accept=".xlsx" style="display:none" @change="parseBatch" />

        <div v-if="batchParsing" class="empty">正在解析…</div>

        <template v-if="batchItems.length">
          <div class="row" style="justify-content:space-between;margin-bottom:6px;">
            <span class="bold">解析出 {{ batchItems.length }} 行</span>
            <van-button size="mini" plain @click="toggleBatchAll">{{ batchAllOn ? '全部取消' : '全部勾选' }}</van-button>
          </div>
          <div v-for="(it, i) in batchItems" :key="i" class="io-row">
            <div class="row">
              <van-checkbox v-model="it._on" style="margin-right:8px;" />
              <span class="grow io-name">{{ it.product_name }}</span>
              <span class="muted">{{ it.unit }}</span>
            </div>
            <div class="row mt8">
              <van-field v-model="it.quantity" type="number" label="数量" />
              <van-field v-model="it.unit_price" type="number" label="单价" />
              <div class="io-amount">{{ fmtMoney(num(it.quantity) * num(it.unit_price)) }}</div>
            </div>
            <div class="muted">{{ it.supplier || '无供应商' }} · {{ it.date }}</div>
          </div>
          <div v-if="batchFailed.length" class="alert err">
            解析失败 {{ batchFailed.length }} 条：{{ batchFailed.slice(0, 5).map((f) => f.reason).join('；') }}
          </div>
        </template>

        <div class="sheet-foot">
          <van-button block plain @click="batchShow = false">关闭</van-button>
          <van-button block type="success" :disabled="!batchItems.length" :loading="batchSaving" @click="confirmBatch">
            确认入库
          </van-button>
        </div>
      </div>
    </van-popup>
  </div>
</template>

<script setup>
import { ref, reactive, computed, onMounted, onActivated } from 'vue'
import { showToast, showConfirmDialog } from 'vant'
import api, { upload, downloadFile } from '../api'
import ProductPicker from '../components/ProductPicker.vue'
import AttachmentField from '../components/AttachmentField.vue'
import RemarkView from '../components/RemarkView.vue'
import OperatorField from '../components/OperatorField.vue'
import { ensureUserName } from '../utils/user'
import { fmtMoney, fmtNum, num, defaultUnit, unitFactor, todayStr } from '../utils/format'

const tab = ref('new')
const refreshing = ref(false)

// ---------- 新增 ----------
const form = reactive({ date: todayStr(), supplier: '', operator: '', remark: '' })
const rows = ref([newRow()])
const saving = ref(false)

function newRow() {
  return { product_id: '', name: '', unit: '', qty: '1', price: '0' }
}
const totalAmount = computed(() => rows.value.reduce((s, r) => s + rowAmount(r), 0))
const rowAmount = (r) => (r.product_id ? num(r.qty) * num(r.price) : 0)
function calcRow() {}

function conversionText(r) {
  const f = num(r._factor) || 1
  const du = r.unit || ''
  if (!du) return '—'
  return `1 ${du} = ${fmtNum(f)} ${r._base_unit || ''}`
}

function addRow() { rows.value.push(newRow()) }
function clearRows() { rows.value = [newRow()] }

async function submit() {
  const lines = rows.value.filter((r) => r.product_id)
  if (!lines.length) { showToast('请至少选择一条商品'); return }
  for (const r of lines) {
    if (!(num(r.qty) > 0)) { showToast(`「${r.name}」数量必须大于 0`); return }
  }
  saving.value = true
  try {
    for (const r of lines) {
      await api('/api/inbounds', 'POST', {
        product_id: +r.product_id,
        unit: r.unit || '个',
        quantity: num(r.qty),
        unit_price: num(r.price),
        supplier: form.supplier,
        operator: form.operator,
        date: form.date,
        remark: form.remark,
      })
    }
    showToast('入库成功')
    clearRows()
    loadList()
  } catch (e) { showToast('入库失败：' + e.message) }
  saving.value = false
}

/* ---------- 商品 / 单位选择 ---------- */
const PRODUCTS = ref([])
const pickerShow = ref(false)
let pickIndex = 0
const pickableProducts = computed(() =>
  PRODUCTS.value.filter((p) => p.is_active && p.product_type === 'stock' && !['人工', '快递'].includes(p.category))
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
  r.unit = defaultUnit(p)
  r._factor = unitFactor(p, r.unit)
  r._base_unit = p.base_unit
  r._conversions = p.conversions || {}
}

const unitShow = ref(false)
let unitIndex = 0
const unitActions = ref([])
function openUnit(i) {
  const r = rows.value[i]
  if (!r.product_id) return
  unitIndex = i
  unitActions.value = Object.keys(r._conversions || {}).map((u) => ({ name: u, value: u }))
  if (!unitActions.value.length) unitActions.value = [{ name: r.unit || '个', value: r.unit || '个' }]
  unitShow.value = true
}
function onUnitSelect(a) {
  const r = rows.value[unitIndex]
  r.unit = a.value
  r._factor = num((r._conversions || {})[a.value]) || 1
  unitShow.value = false
}

/* ---------- 记录 ---------- */
const list = ref([])
const kw = ref('')
const filter = reactive({ from: '', to: '' })
const selected = ref([])

const filteredList = computed(() => {
  const s = (kw.value || '').trim().toLowerCase()
  if (!s) return list.value
  return list.value.filter((r) =>
    (r.code || '').toLowerCase().includes(s) ||
    (r.product_name || '').toLowerCase().includes(s) ||
    (r.supplier || '').toLowerCase().includes(s)
  )
})
const selectedAmount = computed(() =>
  list.value.filter((r) => selected.value.includes(r.id)).reduce((s, r) => s + num(r.total_amount), 0)
)
const allSelected = computed(() => filteredList.value.length > 0 && filteredList.value.every((r) => selected.value.includes(r.id)))

async function loadList() {
  try {
    const q = []
    if (filter.from) q.push(`date_from=${filter.from}`)
    if (filter.to) q.push(`date_to=${filter.to}`)
    list.value = await api('/api/inbounds' + (q.length ? '?' + q.join('&') : ''))
    selected.value = selected.value.filter((id) => list.value.some((r) => r.id === id))
  } catch (e) { showToast(e.message || '加载失败') }
  refreshing.value = false
}
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
function toggleSel(id) {
  const i = selected.value.indexOf(id)
  if (i >= 0) selected.value.splice(i, 1)
  else selected.value.push(id)
}
function toggleAll() {
  selected.value = allSelected.value ? [] : filteredList.value.map((r) => r.id)
}
async function del(r) {
  try {
    await showConfirmDialog({ title: '删除入库单', message: `确认删除 ${r.code}（${r.product_name}）？库存与成本会自动回退。` })
  } catch (e) { return }
  try {
    await api(`/api/inbounds/${r.id}`, 'DELETE')
    showToast('已删除')
    loadList()
  } catch (e) { showToast(e.message || '删除失败') }
}
async function batchDelete() {
  try {
    await showConfirmDialog({ title: '批量删除入库单', message: `确认删除已选 ${selected.value.length} 条入库单？` })
  } catch (e) { return }
  try {
    const r = await api('/api/inbounds/batch-delete', 'POST', { ids: selected.value })
    showToast(`已删除 ${r.deleted} 条`)
    selected.value = []
    loadList()
  } catch (e) { showToast(e.message || '删除失败') }
}

function switchList() {
  tab.value = 'list'
  loadList()
}

/* ---------- 批量入库 ---------- */
const batchShow = ref(false)
const batchFile = ref(null)
const batchParsing = ref(false)
const batchSaving = ref(false)
const batchItems = ref([])
const batchFailed = ref([])
const batchAllOn = computed(() => batchItems.value.length > 0 && batchItems.value.every((i) => i._on))

function downloadTpl(kind) {
  downloadFile(`/api/templates/${kind}`, `${kind}_template.xlsx`).catch((e) => showToast(e.message))
}

async function parseBatch(e) {
  const f = e.target.files && e.target.files[0]
  e.target.value = ''
  if (!f) return
  batchParsing.value = true
  batchItems.value = []
  batchFailed.value = []
  try {
    const r = await upload('/api/import/inbounds/preview', f)
    batchItems.value = (r.items || []).map((it) => ({ ...it, _on: true }))
    batchFailed.value = r.failed || []
    if (!batchItems.value.length) showToast('未解析出可入库的数据')
  } catch (err) { showToast('解析失败：' + err.message) }
  batchParsing.value = false
}

function toggleBatchAll() {
  const v = !batchAllOn.value
  batchItems.value.forEach((i) => { i._on = v })
}

async function confirmBatch() {
  const items = batchItems.value
    .filter((i) => i._on && num(i.quantity) > 0)
    .map((i) => ({
      product_id: i.product_id,
      product_name: i.product_name,
      unit: i.unit,
      quantity: num(i.quantity),
      unit_price: num(i.unit_price),
      supplier: i.supplier,
      date: i.date,
      operator: i.operator,
      remark: i.remark,
    }))
  if (!items.length) { showToast('没有勾选可入库的数据'); return }
  batchSaving.value = true
  try {
    const r = await api('/api/import/inbounds/confirm', 'POST', { items })
    showToast(`已入库 ${r.created} 条${r.failed_count ? `，失败 ${r.failed_count}` : ''}`)
    batchShow.value = false
    batchItems.value = []
    const dates = items.map((i) => i.date).filter(Boolean).sort()
    if (dates.length) { filter.from = dates[0]; filter.to = dates[dates.length - 1] }
    tab.value = 'list'
    loadList()
  } catch (e) { showToast('确认入库失败：' + e.message) }
  batchSaving.value = false
}

onMounted(async () => {
  form.operator = await ensureUserName()   // 操作员固定为当前登录账号
  loadList()
})
onActivated(() => { if (tab.value === 'list') loadList() })
</script>

<style scoped>
.io-row { padding: 10px 0; border-bottom: 1px solid #f5f5f5; }
.io-row:last-child { border-bottom: none; }
.io-name { font-weight: 600; font-size: 14px; }
.io-name .placeholder { color: #1989fa; font-weight: 500; }
.io-hint { color: #1989fa; font-size: 12px; cursor: pointer; }
.io-amount { min-width: 76px; text-align: right; font-weight: 600; font-variant-numeric: tabular-nums; font-size: 13px; }
.batch-bar {
  display: flex; align-items: center; gap: 8px; flex-wrap: wrap;
  background: #fff7e6; border-radius: 8px; padding: 8px 10px; margin-top: 8px;
}
.alert { border-radius: 8px; padding: 8px 10px; font-size: 12px; margin-top: 8px; }
.alert.err { background: #fff1f0; color: #ee0a24; }
</style>
