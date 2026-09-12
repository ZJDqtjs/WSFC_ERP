<template>
  <div>
    <div class="seg">
      <div
        v-for="t in tabs"
        :key="t.key"
        class="seg-item"
        :class="{ active: tab === t.key }"
        @click="switchTab(t.key)"
      >{{ t.label }}</div>
    </div>

    <!-- ============ 库存总览 ============ -->
    <template v-if="tab === 'overview'">
      <div class="card">
        <van-search v-model="kw" placeholder="搜索商品名称 / 分类" shape="round" />
        <div class="seg" style="margin:8px 0 4px;">
          <div class="seg-item" :class="{ active: sortDir === 'desc' }" @click="sortDir = 'desc'">库存多→少</div>
          <div class="seg-item" :class="{ active: sortDir === 'asc' }" @click="sortDir = 'asc'">库存少→多</div>
          <div class="seg-item" :class="{ active: onlyLow }" @click="onlyLow = !onlyLow">仅看缺货</div>
        </div>
        <div class="row" style="justify-content:space-between;margin:6px 0;">
          <span class="muted">共 {{ filtered.length }} 项 · 总值 {{ fmtMoney(totalValue) }}</span>
          <van-button size="mini" plain type="primary" icon="edit" @click="openAdjust()">盘点调整</van-button>
        </div>
        <van-pull-refresh v-model="refreshing" @refresh="loadStock">
          <div v-if="!filtered.length" class="empty">无匹配商品</div>
          <div v-for="p in filtered" :key="p.id" class="list-item" @click="goProductMv(p)">
            <div class="row">
              <span class="grow item-title">{{ p.name }}</span>
              <span class="stock-num" :class="{ low: num(p.stock) <= 1e-6 }">{{ p.stock_display || fmtStock(p) }}</span>
            </div>
            <div class="item-meta">
              {{ p.category || '—' }} · 均价 {{ fmtMoney(costOf(p)) }}/{{ p.default_unit || p.base_unit }} · 价值 {{ fmtMoney(p.stock_value) }}
            </div>
          </div>
        </van-pull-refresh>
      </div>
    </template>

    <!-- ============ 盘点记录 ============ -->
    <template v-else-if="tab === 'adj'">
      <div class="card">
        <div class="row wrap" style="gap:6px;">
          <van-field v-model="adjFilter.product_id" readonly placeholder="全部商品" style="flex:1;background:#f7f8fa;border-radius:6px;padding:6px 10px;" @click="openProductFilter" />
          <van-field v-model="adjFilter.from" type="date" placeholder="起" style="max-width:130px;background:#f7f8fa;border-radius:6px;padding:6px 10px;" />
          <van-field v-model="adjFilter.to" type="date" placeholder="止" style="max-width:130px;background:#f7f8fa;border-radius:6px;padding:6px 10px;" />
          <van-button size="small" type="primary" @click="loadAdjustments">查询</van-button>
        </div>
        <van-pull-refresh v-model="refreshing" @refresh="loadAdjustments">
          <div v-if="!adjList.length" class="empty">暂无盘点记录</div>
          <div v-for="a in adjList" :key="a.id" class="list-item">
            <div class="row">
              <span class="grow item-title">{{ a.product_name }}</span>
              <van-button size="mini" plain type="danger" @click="delAdjust(a)">删除回退</van-button>
            </div>
            <div class="item-meta">
              库存
              <b :class="a.quantity >= 0 ? 'up' : 'down'">{{ fmtSign(a.quantity) }}{{ a.unit }}</b>
              <template v-if="a.avg_cost_delta"> · 均价<b>{{ fmtSign(a.avg_cost_delta) }}</b>元/{{ a.unit }}</template>
              <template v-if="a.unit_cost_delta"> · 成本单价<b>{{ fmtSign(a.unit_cost_delta) }}</b>元/{{ a.unit }}</template>
            </div>
            <div class="item-meta">{{ a.date }} · {{ a.operator || '—' }}{{ a.remark ? ' · ' + a.remark : '' }}</div>
          </div>
        </van-pull-refresh>
      </div>
    </template>

    <!-- ============ 库存流水 ============ -->
    <template v-else-if="tab === 'mv'">
      <div class="card">
        <div class="row wrap" style="gap:6px;">
          <van-field v-model="mvFilter.product_id" readonly placeholder="全部商品" style="flex:1;background:#f7f8fa;border-radius:6px;padding:6px 10px;" @click="openProductFilter('mv')" />
          <van-field v-model="mvFilter.from" type="date" placeholder="起" style="max-width:130px;background:#f7f8fa;border-radius:6px;padding:6px 10px;" />
          <van-field v-model="mvFilter.to" type="date" placeholder="止" style="max-width:130px;background:#f7f8fa;border-radius:6px;padding:6px 10px;" />
          <van-button size="small" type="primary" @click="loadMovements">查询</van-button>
          <van-button size="small" plain @click="quickMv(0)">今天</van-button>
          <van-button size="small" plain @click="quickMv(7)">近7天</van-button>
          <van-button size="small" plain @click="quickMv(null)">全部</van-button>
        </div>
        <van-pull-refresh v-model="refreshing" @refresh="loadMovements">
          <div v-if="!mvList.length" class="empty">暂无流水</div>
          <div v-for="m in mvList" :key="m.id" class="list-item">
            <div class="row">
              <span class="grow item-title">{{ m.product_name }}</span>
              <span :class="m.quantity_display >= 0 ? 'up' : 'down'">
                {{ m.quantity_display >= 0 ? '+' : '' }}{{ fmtNum(m.quantity_display) }} {{ m.unit }}
              </span>
            </div>
            <div class="item-meta">
              {{ m.date }} · {{ moveTypeLabel(m.move_type) }}{{ m.amount ? ' · ' + fmtMoney(m.amount) : '' }}
              {{ m.operator ? ' · ' + m.operator : '' }}
            </div>
            <div v-if="m.remark" class="item-meta">{{ m.remark }}</div>
          </div>
        </van-pull-refresh>
      </div>
    </template>

    <!-- ============ 工作量统计 ============ -->
    <template v-else>
      <div class="card">
        <div class="row wrap" style="gap:6px;">
          <van-field v-model="wlFilter.from" type="date" style="max-width:130px;background:#f7f8fa;border-radius:6px;padding:6px 10px;" />
          <van-field v-model="wlFilter.to" type="date" style="max-width:130px;background:#f7f8fa;border-radius:6px;padding:6px 10px;" />
          <van-button size="small" type="primary" @click="loadWorkload">查询</van-button>
          <van-button size="small" plain @click="quickWl('month')">本月</van-button>
          <van-button size="small" plain @click="quickWl('all')">全部</van-button>
        </div>
        <div class="stat-grid cols2" style="margin-top:10px;">
          <div class="stat accent">
            <div class="label">总工作量</div>
            <div class="value">{{ fmtNum(wl.total_workload) }}</div>
            <div class="sub">按人工商品累计</div>
          </div>
          <div class="stat success">
            <div class="label">人工成本合计</div>
            <div class="value">{{ fmtMoney(wl.total_cost) }}</div>
          </div>
        </div>
      </div>
      <div class="card">
        <div class="card-title">按商品</div>
        <div v-if="!(wl.by_product || []).length" class="empty">暂无工作量数据</div>
        <div v-for="x in wl.by_product || []" :key="x.id" class="list-item">
          <div class="row">
            <span class="grow item-title">{{ x.name }}</span>
            <span class="bold">{{ fmtNum(x.workload) }} {{ x.unit }}</span>
          </div>
          <div class="item-meta">单价 {{ fmtMoney(x.rate) }} · 成本 {{ fmtMoney(x.cost) }}</div>
        </div>
      </div>
      <div class="card">
        <div class="card-title">按日期</div>
        <div v-if="!(wl.by_date || []).length" class="empty">暂无数据</div>
        <div v-for="d in wl.by_date || []" :key="d.date" class="list-item">
          <div class="row">
            <span class="grow">{{ d.date }}</span>
            <span class="bold">{{ fmtNum(d.workload) }}</span>
          </div>
        </div>
      </div>
    </template>

    <!-- 盘点调整弹层 -->
    <van-popup v-model:show="adjShow" position="bottom" round :style="{ height: '86%' }">
      <div class="sheet-body">
        <div class="sheet-title">盘点调整（相对增减）</div>

        <van-cell-group inset>
          <van-field v-model="adjPickedName" readonly label="商品" placeholder="点击选择" @click="openAdjProductPicker" />
        </van-cell-group>
        <div class="adj-preview">
          <div>当前库存：<b>{{ adjNowText }}</b></div>
          <div>调整后：<b class="primary">{{ adjAfterText }}</b></div>
          <div>当前均价：<b>{{ adjNowAvgText }}</b> → <b class="primary">{{ adjAfterAvgText }}</b></div>
          <div>当前成本单价：<b>{{ adjNowUcText }}</b> → <b class="primary">{{ adjAfterUcText }}</b></div>
        </div>

        <van-cell-group inset style="margin-top:10px;">
          <van-field v-model="adjForm.quantity" label="调整数量" placeholder="如 +100 / -100，留空不调整" />
          <van-field v-model="adjForm.avg_cost_adj" label="平均成本±" placeholder="如 +2 / -1，留空不调整" />
          <van-field v-model="adjForm.unit_cost_adj" label="成本单价±" placeholder="如 +2 / -1，留空不调整" />
          <van-field v-model="adjForm.date" label="日期" type="date" />
          <van-field v-model="adjForm.operator" label="操作员" placeholder="谁操作的" />
          <van-field v-model="adjForm.remark" label="原因" placeholder="如：盘点差异 / 损耗" />
        </van-cell-group>
        <div class="muted" style="padding:8px 4px;">
          数量/均价/成本单价均为「相对当前值」调整，必须以 + 或 - 开头；均留空则不产生任何变更。
        </div>

        <div class="sheet-foot">
          <van-button block plain @click="adjShow = false">取消</van-button>
          <van-button block type="primary" :loading="adjSaving" @click="submitAdjust">确认调整</van-button>
        </div>
      </div>
    </van-popup>

    <ProductPicker
      v-model:show="pickerShow"
      :title="pickerTitle"
      :products="pickerProducts"
      :type-tabs="pickerTypeTabs"
      @pick="onPick"
    />
  </div>
</template>

<script setup>
import { ref, computed, reactive, onMounted, onActivated, watch } from 'vue'
import { useRoute } from 'vue-router'
import { showToast, showConfirmDialog } from 'vant'
import api from '../api'
import ProductPicker from '../components/ProductPicker.vue'
import { fmtMoney, fmtNum, fmtSign, fmtStock, num, unitFactor, defaultUnit, moveTypeLabel, todayStr } from '../utils/format'

const route = useRoute()

const tabs = [
  { key: 'overview', label: '库存总览' },
  { key: 'adj', label: '盘点记录' },
  { key: 'mv', label: '库存流水' },
  { key: 'wl', label: '工作量' },
]
const tab = ref('overview')
const refreshing = ref(false)

const PRODUCTS = ref([])
const STOCK = ref([])
const kw = ref('')
const sortDir = ref('desc')
const onlyLow = ref(false)

const adjList = ref([])
const adjFilter = reactive({ product_id: '', from: '', to: '' })
const mvList = ref([])
const mvFilter = reactive({ product_id: '', from: '', to: '' })
const wlFilter = reactive({ from: '', to: '' })
const wl = ref({})

// 选择器：目标决定回填位置
const pickerShow = ref(false)
let pickTarget = 'adj'
const pickerTitle = computed(() => (pickTarget === 'mv' ? '选择流水商品' : '选择盘点商品'))
const pickerTypeTabs = ref(false)
const pickerProducts = ref([])

const adjShow = ref(false)
const adjSaving = ref(false)
const adjPicked = ref(null)
const adjPickedName = ref('')
const adjForm = reactive({ quantity: '', avg_cost_adj: '', unit_cost_adj: '', date: todayStr(), operator: '', remark: '' })

const totalValue = computed(() => STOCK.value.reduce((s, p) => s + num(p.stock_value), 0))
const filtered = computed(() => {
  const s = (kw.value || '').trim().toLowerCase()
  let list = STOCK.value.filter((p) =>
    (!s || (p.name || '').toLowerCase().includes(s) || (p.category || '').toLowerCase().includes(s)) &&
    (!onlyLow.value || num(p.stock) <= 1e-6)
  )
  const dir = sortDir.value === 'asc' ? 1 : -1
  return list.sort((a, b) => (stockInUnit(a) - stockInUnit(b)) * dir)
})

const stockInUnit = (p) => num(p.stock) / unitFactor(p, defaultUnit(p))
const costOf = (p) => num(p.avg_cost) * unitFactor(p, defaultUnit(p))

/* ---------- 总览 ---------- */
async function loadStock() {
  try {
    STOCK.value = await api('/api/stock-overview')
  } catch (e) { showToast(e.message || '加载失败') }
  refreshing.value = false
}

function goProductMv(p) {
  mvFilter.product_id = p.id
  tab.value = 'mv'
  loadMovements()
}

/* ---------- 盘点 ---------- */
async function loadAdjustments() {
  try {
    const q = []
    if (adjFilter.product_id) q.push(`product_id=${adjFilter.product_id}`)
    if (adjFilter.from) q.push(`date_from=${adjFilter.from}`)
    if (adjFilter.to) q.push(`date_to=${adjFilter.to}`)
    adjList.value = await api('/api/adjustments' + (q.length ? '?' + q.join('&') : ''))
  } catch (e) { showToast(e.message || '加载失败') }
  refreshing.value = false
}

async function delAdjust(a) {
  try {
    await showConfirmDialog({ title: '删除盘点记录', message: `将回退「${a.product_name}」本次调整并重算库存，确认？` })
  } catch (e) { return }
  try {
    await api(`/api/adjustments/${a.id}`, 'DELETE')
    showToast('已回退')
    loadAdjustments(); loadStock()
  } catch (e) { showToast(e.message || '操作失败') }
}

async function openAdjust(pid = 0) {
  await ensureProducts()
  adjForm.quantity = ''
  adjForm.avg_cost_adj = ''
  adjForm.unit_cost_adj = ''
  adjForm.date = todayStr()
  adjForm.operator = ''
  adjForm.remark = ''
  const p = pid ? PRODUCTS.value.find((x) => x.id === +pid) : null
  adjPicked.value = p || null
  adjPickedName.value = p ? p.name : ''
  adjShow.value = true
}

function openAdjProductPicker() {
  pickTarget = 'adj'
  pickerTypeTabs.value = false
  pickerProducts.value = PRODUCTS.value.filter((p) => p.is_active && p.product_type === 'stock' && !['人工', '快递'].includes(p.category))
  pickerShow.value = true
}

/* 盘点预览 */
const adjNowText = computed(() => {
  const p = adjPicked.value
  if (!p) return '—'
  const du = defaultUnit(p)
  return `${fmtNum(num(p.stock) / unitFactor(p, du))} ${du}`
})
const adjAfterText = computed(() => {
  const p = adjPicked.value
  if (!p) return '—'
  const du = defaultUnit(p)
  const f = unitFactor(p, du)
  const now = num(p.stock) / f
  const raw = adjForm.quantity.trim()
  if (!raw) return `${fmtNum(now)} ${du}（不调整）`
  if (!/^[+-]\d+(\.\d+)?$/.test(raw)) return '⚠ 需以 + 或 - 开头'
  return `${fmtNum(now + parseFloat(raw))} ${du}`
})
const adjNowAvgText = computed(() => {
  const p = adjPicked.value
  if (!p) return '—'
  const du = defaultUnit(p)
  return `${fmtMoney(num(p.avg_cost) * unitFactor(p, du))}/${du}`
})
const adjAfterAvgText = computed(() => {
  const p = adjPicked.value
  if (!p) return '—'
  const du = defaultUnit(p)
  const f = unitFactor(p, du)
  const now = num(p.avg_cost) * f
  const raw = adjForm.avg_cost_adj.trim()
  if (!raw) return '不调整'
  if (!/^[+-]\d+(\.\d+)?$/.test(raw)) return '⚠ 需以 + 或 - 开头'
  return `${fmtMoney(Math.max(now + parseFloat(raw), 0))}/${du}`
})
const adjNowUcText = computed(() => {
  const p = adjPicked.value
  if (!p) return '—'
  const du = defaultUnit(p)
  return `${fmtMoney(num(p.unit_cost) * unitFactor(p, du))}/${du}`
})
const adjAfterUcText = computed(() => {
  const p = adjPicked.value
  if (!p) return '—'
  const du = defaultUnit(p)
  const f = unitFactor(p, du)
  const now = num(p.unit_cost) * f
  const raw = adjForm.unit_cost_adj.trim()
  if (!raw) return '不调整'
  if (!/^[+-]\d+(\.\d+)?$/.test(raw)) return '⚠ 需以 + 或 - 开头'
  return `${fmtMoney(Math.max(now + parseFloat(raw), 0))}/${du}`
})

async function submitAdjust() {
  const p = adjPicked.value
  if (!p) { showToast('请选择商品'); return }
  const raw = adjForm.quantity.trim()
  const araw = adjForm.avg_cost_adj.trim()
  const uraw = adjForm.unit_cost_adj.trim()
  if (raw && !/^[+-]\d+(\.\d+)?$/.test(raw)) { showToast('调整数量必须以 + 或 - 开头，留空则不调整'); return }
  if (araw && !/^[+-]\d+(\.\d+)?$/.test(araw)) { showToast('平均成本必须以 + 或 - 开头，留空则不调整'); return }
  if (uraw && !/^[+-]\d+(\.\d+)?$/.test(uraw)) { showToast('成本单价必须以 + 或 - 开头，留空则不调整'); return }
  adjSaving.value = true
  try {
    const r = await api('/api/adjust', 'POST', {
      product_id: p.id,
      quantity: raw,
      unit: defaultUnit(p),
      avg_cost_adj: araw,
      unit_cost_adj: uraw,
      date: adjForm.date,
      operator: adjForm.operator,
      remark: adjForm.remark,
    })
    adjShow.value = false
    showToast(r && r.message ? r.message : (raw || araw || uraw ? '调整成功' : '未做调整'))
    loadStock(); loadAdjustments()
  } catch (e) { showToast('操作失败：' + e.message) }
  adjSaving.value = false
}

/* ---------- 流水 ---------- */
async function loadMovements() {
  try {
    const q = []
    if (mvFilter.product_id) q.push(`product_id=${mvFilter.product_id}`)
    if (mvFilter.from) q.push(`date_from=${mvFilter.from}`)
    if (mvFilter.to) q.push(`date_to=${mvFilter.to}`)
    mvList.value = await api('/api/movements' + (q.length ? '?' + q.join('&') : ''))
  } catch (e) { showToast(e.message || '加载失败') }
  refreshing.value = false
}
function quickMv(days) {
  if (days === null) { mvFilter.from = ''; mvFilter.to = '' }
  else {
    const d = new Date()
    d.setDate(d.getDate() - days)
    mvFilter.from = `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`
    mvFilter.to = todayStr()
  }
  loadMovements()
}

/* ---------- 工作量 ---------- */
async function loadWorkload() {
  try {
    const q = []
    if (wlFilter.from) q.push(`date_from=${wlFilter.from}`)
    if (wlFilter.to) q.push(`date_to=${wlFilter.to}`)
    wl.value = await api('/api/workload' + (q.length ? '?' + q.join('&') : ''))
  } catch (e) { showToast(e.message || '加载失败') }
}
function quickWl(kind) {
  if (kind === 'month') { wlFilter.from = todayStr().slice(0, 8) + '01'; wlFilter.to = todayStr() }
  else { wlFilter.from = ''; wlFilter.to = '' }
  loadWorkload()
}

/* ---------- 商品选择 ---------- */
async function ensureProducts() {
  if (PRODUCTS.value.length) return
  try { PRODUCTS.value = await api('/api/products') } catch (e) {}
}
function openProductFilter(target = 'adj') {
  pickTarget = target === 'mv' ? 'mv' : 'adj'
  pickerTypeTabs.value = false
  pickerProducts.value = PRODUCTS.value.length
    ? PRODUCTS.value
    : []
  pickerShow.value = true
  if (!PRODUCTS.value.length) {
    ensureProducts().then(() => { pickerProducts.value = PRODUCTS.value })
  }
}
function onPick(p) {
  if (pickTarget === 'mv') { mvFilter.product_id = p.id; loadMovements() }
  else {
    adjPicked.value = p
    adjPickedName.value = p.name
  }
}

function switchTab(k) {
  tab.value = k
  if (k === 'overview') loadStock()
  else if (k === 'adj') { ensureProducts(); loadAdjustments() }
  else if (k === 'mv') loadMovements()
  else loadWorkload()
}

watch(() => route.query.mv, (v) => {
  if (!v) return
  mvFilter.product_id = +v
  tab.value = 'mv'
  loadMovements()
})

onMounted(async () => {
  await Promise.all([loadStock(), loadAdjustments(), loadMovements(), loadWorkload()])
  if (route.query.mv) {
    mvFilter.product_id = +route.query.mv
    tab.value = 'mv'
    loadMovements()
  }
})
onActivated(() => { if (tab.value === 'overview') loadStock() })
</script>

<style scoped>
.stock-num { font-weight: 700; font-variant-numeric: tabular-nums; }
.stock-num.low { color: #ee0a24; }
.primary { color: #1989fa; }
.adj-preview {
  background: #f7f8fa; border-radius: 8px; padding: 10px 12px;
  font-size: 12px; line-height: 1.9; color: #646566;
}
</style>
