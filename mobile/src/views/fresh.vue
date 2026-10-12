<template>
  <div class="sub-page">
    <van-nav-bar title="鲜货现采" left-arrow fixed placeholder @click-left="goBack" />

    <div style="padding:12px;">
      <div class="seg" style="margin-bottom:12px;">
        <div class="seg-item" :class="{ active: tab === 'view' }" @click="tab = 'view'">鲜货现采</div>
        <div class="seg-item" :class="{ active: tab === 'in' }" @click="openInbound">鲜货入库</div>
      </div>

      <template v-if="tab === 'view'">
      <div class="card">
        <div class="card-title">
          <span class="grow">今日鲜货概览</span>
          <van-button size="mini" plain type="primary" icon="setting-o" @click="openConfig">管理清单</van-button>
        </div>
        <div class="muted" style="margin-bottom:8px;">
          展示鲜货（蔬菜 / 干货）库存与均价；导入今日订单可预演算消耗需求（仅采购参考，不实际扣库存）。
        </div>
        <div class="row" style="gap:8px;">
          <van-button size="small" plain type="primary" icon="down" @click="planFile && planFile.click()">导入今日订单</van-button>
          <input ref="planFile" type="file" accept=".xlsx" style="display:none" @change="doPlan" />
          <van-button size="small" plain icon="replay" @click="load">刷新</van-button>
        </div>
      </div>

      <!-- 预演算结果 -->
      <div v-if="planItems.length" class="card">
        <div class="card-title">
          <span class="grow">今日订单需求预演算</span>
          <van-button size="mini" plain @click="planItems = []">清空</van-button>
        </div>
        <div class="row" style="gap:10px;flex-wrap:wrap;margin-bottom:8px;">
          <span class="muted">解析订单 {{ planCount }} 单</span>
          <span class="muted">跳过 {{ planSkip }} 单</span>
          <span v-if="planFailed" class="muted">失败 {{ planFailed }} 条</span>
        </div>
        <div v-if="planUnmapped.length" class="alert warn">
          ⚠ 未关联编码：{{ planUnmapped.slice(0, 8).join('、') }}{{ planUnmapped.length > 8 ? ' 等' : '' }}
          <div class="muted" style="margin-top:4px;">到「设置 → 聚水潭关联」关联后重新导入。</div>
        </div>
        <div v-for="p in planItems" :key="p.id" class="list-item">
          <div class="row">
            <span class="grow item-title">{{ p.name }}</span>
            <span v-if="p.suggest > 0" class="suggest">建议采购 {{ fmtNum(p.suggest) }} {{ p.unit }}</span>
            <span v-else class="ok">库存充足</span>
          </div>
          <div class="item-meta">
            库存 {{ fmtNum(p.stock) }} · 需求 {{ fmtNum(p.need) }} · 剩余
            <b :class="p.remain < 0 ? 'up' : 'down'">{{ fmtNum(p.remain) }}</b> {{ p.unit }}
          </div>
        </div>
      </div>

      <!-- 鲜货库存 -->
      <div class="card">
        <div class="card-title">
          <span class="grow">鲜货库存（按展示清单顺序）</span>
          <span class="muted">{{ items.length }} 项</span>
        </div>
        <div v-if="!items.length" class="empty">暂无鲜货商品</div>
        <div v-for="(item, index) in items" :key="item.id" class="list-item">
          <div class="row">
            <span class="order-idx">{{ index + 1 }}</span>
            <span class="grow item-title">{{ item.name }}</span>
            <van-tag plain>{{ item.category }}</van-tag>
          </div>
          <div class="item-meta">
            库存 {{ fmtNum(item.stock) }} {{ item.unit }} · 均价 {{ fmtMoney(item.avg_cost) }}/{{ item.unit }}
            · 价值 {{ fmtMoney(item.stock_value) }}
          </div>
        </div>
      </div>
      </template>

      <!-- ============ 鲜货入库 ============ -->
      <template v-else>
        <div class="card">
          <div class="card-title">
            <span class="grow">鲜货入库</span>
            <van-button size="mini" plain type="primary" icon="setting-o" @click="openConfig">管理展示商品</van-button>
            <van-button size="mini" plain icon="replay" @click="loadInbound">刷新</van-button>
          </div>
          <div class="muted" style="margin-bottom:8px;">
            只有在「管理展示商品」里挑过的商品才会出现在下面；填数量即可入库，单价自动带出（最近入库价 → 参考成本，可改），运费 / 装卸费默认空。
          </div>
          <van-cell-group inset>
            <van-field v-model="inForm.date" label="日期" type="date" />
            <van-field v-model="inForm.supplier" label="供应商" placeholder="可留空" />
            <OperatorField v-model="inForm.operator" />
            <PayStatusField v-model="inForm.pay_status" hint="待付款：先进「待付款账单」，点「已支付」后才计入财务报表" />
            <van-field v-model="inForm.remark" label="备注" placeholder="本次入库的每一张单共用（可选）" />
          </van-cell-group>
        </div>

        <div class="card">
          <van-field v-model="inKw" placeholder="筛选商品（只影响显示，已填数量不会丢）" style="background:#f7f8fa;border-radius:6px;" />
          <div class="row" style="gap:8px;margin-top:8px;">
            <van-button size="mini" plain @click="inClearQty">清空已填数量</van-button>
            <span class="muted" style="flex:1;">填了数量的行会高亮；没填数量的行不会入库</span>
          </div>
          <div v-if="doneCount" class="muted" style="margin-top:6px;">
            今日已入库 {{ doneCount }} 个商品已隐藏（明天 0 点自动回来）
            <van-button size="mini" plain @click="showDone = !showDone">{{ showDone ? '隐藏它们' : '显示今日已入库' }}</van-button>
          </div>

          <div v-if="!inRows.length" class="empty">
            {{ inList.length ? '今天的鲜货都入完啦 ✅（也可以点上面「显示今日已入库」核对）' : '还没挑商品：点「管理展示商品」把要入库的商品挑进来' }}
          </div>
          <div
            v-for="r in inRows"
            :key="r.id"
            class="in-row"
            :class="{ on: num(r.qty) > 0, done: doneIds.includes(r.id) }"
          >
            <div class="row">
              <van-checkbox :model-value="pickIds.includes(r.id)" style="margin-right:8px;" @click="togglePick(r.id)" />
              <span class="grow item-title ellipsis">{{ r.name }}</span>
              <van-tag v-if="doneIds.includes(r.id)" plain type="primary">今日已入库</van-tag>
              <span class="bold" style="margin-left:6px;">{{ fmtMoney(num(r.qty) * num(r.price)) }}</span>
            </div>
            <div class="muted" style="margin-top:2px;">
              {{ r.category || '—' }}
              <template v-if="convText(r)"> · {{ convText(r) }}</template>
              <template v-if="num(r.freight) || num(r.handling)">
                · 批次成本 {{ fmtMoney(num(r.qty) * num(r.price) + num(r.freight) + num(r.handling)) }}
              </template>
            </div>
            <div class="row mt8">
              <span class="muted" @click="openInUnit(r)">单位 {{ r.unit }}（点击切换）</span>
              <div class="grow"></div>
              <van-field v-model="r.qty" type="number" label="数量" placeholder="0" />
              <van-field v-model="r.price" type="number" label="单价" placeholder="0.00" />
            </div>
            <div class="row mt8">
              <van-field v-model="r.freight" type="number" label="运费" placeholder="留空" />
              <van-field v-model="r.handling" type="number" label="装卸费" placeholder="留空" />
            </div>
            <AttachmentField v-if="num(r.qty) > 0" v-model="r.remark" />
            <div class="row" style="gap:8px;margin-top:6px;justify-content:flex-end;">
              <van-button v-if="doneIds.includes(r.id)" size="mini" plain @click="doneUndo(r.id)">恢复</van-button>
              <van-button size="mini" plain type="primary" :loading="rowSaving === r.id" @click="submitRow(r)">入库</van-button>
            </div>
          </div>
        </div>

        <div v-if="inSummary.rows" class="card">
          <div class="bold">
            {{ pickIds.length ? `勾选 ${pickIds.length} 个` : `已填 ${inSummary.rows} 个商品` }}：货款 {{ fmtMoney(inSummary.goods) }}<template v-if="inSummary.fee"> ＋ 运费/装卸 {{ fmtMoney(inSummary.fee) }}</template> ＝ 实付 {{ fmtMoney(inSummary.goods + inSummary.fee) }}
          </div>
          <div class="muted" style="margin-top:4px;">
            每个填了数量的商品各生成一张入库单；只勾了几个就只入那几个，也可以点行尾「入库」单独入一行。
          </div>
          <van-button block type="success" style="margin-top:10px;" :loading="inSaving" @click="submitAll">
            {{ pickIds.length ? `入库选中的 ${pickIds.length} 个商品` : `全部入库（${inSummary.rows} 个商品）` }}
          </van-button>
        </div>
      </template>
    </div>

    <!-- ============ 展示清单配置 ============ -->
    <van-popup v-model:show="cfgShow" position="bottom" round :style="{ height: '88%' }">
      <div class="sheet-body">
        <div class="sheet-title">管理展示清单</div>
        <div class="muted" style="margin-bottom:8px;">清单内商品按顺序展示在最前，清单外鲜货自动追加在末尾。未配置时按名称排序展示全部。</div>

        <div class="divider"></div>
        <div class="row" style="justify-content:space-between;">
          <span class="bold">已选（{{ sel.length }}）</span>
          <van-button size="mini" plain @click="sel = []">清空</van-button>
        </div>
        <div v-if="!sel.length" class="empty" style="padding:10px 0;">未配置，将展示全部鲜货</div>
        <div v-for="(s, i) in sel" :key="s.id" class="picker-item">
          <span class="order-idx">{{ i + 1 }}</span>
          <span class="grow">{{ s.name }}</span>
          <van-icon name="arrow-up" :color="i === 0 ? '#dcdee0' : '#1989fa'" @click="move(i, -1)" />
          <van-icon name="arrow-down" :color="i === sel.length - 1 ? '#dcdee0' : '#1989fa'" @click="move(i, 1)" />
          <van-icon name="cross" color="#ee0a24" @click="sel.splice(i, 1)" />
        </div>

        <div class="divider"></div>
        <div class="bold" style="margin-bottom:6px;">全部可选鲜货（{{ all.length }}）</div>
        <van-field v-model="cfgKw" placeholder="搜索商品" style="background:#f7f8fa;border-radius:6px;margin-bottom:8px;" />
        <div v-for="a in allFiltered" :key="a.id" class="picker-item" :class="{ on: isSel(a.id) }" @click="toggle(a)">
          <van-checkbox :model-value="isSel(a.id)" style="margin-right:4px;" />
          <span class="grow">{{ a.name }}</span>
          <span class="muted">{{ a.category }} · {{ a.unit }}</span>
        </div>

        <div class="sheet-foot">
          <van-button block plain @click="cfgShow = false">取消</van-button>
          <van-button block type="primary" :loading="cfgSaving" @click="saveConfig">保存清单</van-button>
        </div>
      </div>
    </van-popup>

    <!-- 鲜货入库：进货单位选择 -->
    <van-action-sheet v-model:show="inUnitShow" :actions="inUnitActions" cancel-text="取消" @select="onInUnitSelect" />
  </div>
</template>

<script setup>
import { ref, reactive, computed, onMounted } from 'vue'
import { useRoute, useRouter } from 'vue-router'
import { showToast, showConfirmDialog } from 'vant'
import api, { upload } from '../api'
import AttachmentField from '../components/AttachmentField.vue'
import OperatorField from '../components/OperatorField.vue'
import PayStatusField from '../components/PayStatusField.vue'
import { fmtMoney, fmtNum, num, defaultUnit, unitFactor, todayStr } from '../utils/format'

const router = useRouter()
const route = useRoute()
function goBack() {
  if (window.history.length > 1) router.back()
  else router.replace('/mine')
}

const items = ref([])
const planItems = ref([])
const planCount = ref(0)
const planSkip = ref(0)
const planFailed = ref(0)
const planUnmapped = ref([])
const planFile = ref(null)

async function load() {
  try {
    const d = await api('/api/fresh')
    items.value = d.items || []
  } catch (e) { showToast(e.message || '加载失败') }
}

async function doPlan(e) {
  const f = e.target.files && e.target.files[0]
  e.target.value = ''
  if (!f) return
  try {
    const r = await upload('/api/fresh/plan', f)
    planItems.value = r.items || []
    planCount.value = r.order_count || 0
    planSkip.value = typeof r.skip === 'object' ? Object.values(r.skip || {}).reduce((s, v) => s + v, 0) : (r.skip || 0)
    planFailed.value = r.failed_count || 0
    planUnmapped.value = r.unmapped || []
    if (!planItems.value.length) showToast('未解析出需要采购的鲜货')
  } catch (err) { showToast('预演算失败：' + err.message) }
}

/* ---------- 展示清单 ---------- */
const cfgShow = ref(false)
const cfgSaving = ref(false)
const cfgKw = ref('')
const all = ref([])
const sel = ref([])

const allFiltered = computed(() => {
  const s = (cfgKw.value || '').trim().toLowerCase()
  return s ? all.value.filter((a) => (a.name || '').toLowerCase().includes(s) || (a.category || '').toLowerCase().includes(s)) : all.value
})
const isSel = (id) => sel.value.some((x) => x.id === id)

async function openConfig() {
  cfgShow.value = true
  try {
    const [opts, cur] = await Promise.all([api('/api/fresh/options'), api('/api/fresh')])
    all.value = opts.items || []
    const ids = cur.ids && cur.ids.length ? cur.ids : (cur.items || []).map((x) => x.id)
    const byId = new Map(all.value.map((a) => [a.id, a]))
    sel.value = ids.map((id) => byId.get(id)).filter(Boolean)
  } catch (e) { showToast(e.message || '加载清单失败') }
}

function toggle(a) {
  const i = sel.value.findIndex((x) => x.id === a.id)
  if (i >= 0) sel.value.splice(i, 1)
  else sel.value.push(a)
}
function move(i, d) {
  const j = i + d
  if (j < 0 || j >= sel.value.length) return
  const arr = sel.value
  const tmp = arr[i]
  arr.splice(i, 1)
  arr.splice(j, 0, tmp)
}

async function saveConfig() {
  cfgSaving.value = true
  try {
    await api('/api/fresh/config', 'POST', { ids: sel.value.map((s) => s.id) })
    showToast('已保存')
    cfgShow.value = false
    await load()
    if (tab.value === 'in') await loadInbound()   // 入库页签的清单跟着更新
  } catch (e) { showToast(e.message || '保存失败') }
  cfgSaving.value = false
}

/* =============== 鲜货入库 ===============
   只在「管理展示商品」里挑过的商品才会出现；填数量即可入库，单价自动带出（最近入库价 → 参考成本）。
   每个填了数量的商品各生成一张入库单（走 /api/inbounds/batch）。 */
const tab = ref('view')
const PROD = ref([])
const inList = ref([])          // 展示清单里的商品 id（顺序）
const inForm = reactive({ date: todayStr(), supplier: '', operator: '', remark: '', pay_status: 'paid' })
const inKw = ref('')
const pickIds = ref([])         // 勾选的商品 id：勾了就只入这些
const showDone = ref(false)     // 是否连「今日已入库」的行一起显示
const doneIds = ref([])         // 今日已入库的商品 id
const inSaving = ref(false)
const rowSaving = ref(0)
const whKey = ref('')           // 分仓 key：「今日已入库」按分仓隔离
const rowsMap = reactive({})    // {商品id: {qty, price, freight, handling, remark, unit, ...}}

const DONE_KEY = 'wsfc_fin_done'
const doneKey = () => (whKey.value ? `${DONE_KEY}:${whKey.value}` : DONE_KEY)
function loadDone() {
  try {
    const raw = JSON.parse(localStorage.getItem(doneKey()) || 'null')
    // 存的日期不是今天就当没有 → 天然实现「第二天 0 点恢复」
    if (raw && raw.date === todayStr() && Array.isArray(raw.ids)) return raw.ids.map(Number).filter(Boolean)
  } catch (e) { /* 存坏了就当没有 */ }
  return []
}
function saveDone(ids) {
  try { localStorage.setItem(doneKey(), JSON.stringify({ date: todayStr(), ids })) } catch (e) { /* 忽略 */ }
}

const prodById = computed(() => new Map(PROD.value.map((p) => [p.id, p])))
const inRows = computed(() => {
  const kw = (inKw.value || '').trim().toLowerCase()
  const matched = inList.value
    .map((id) => rowsMap[id])
    .filter((r) => r && prodById.value.get(r.id))
    .filter((r) => {
      const p = prodById.value.get(r.id)
      return !kw || `${p.name} ${p.category || ''}`.toLowerCase().includes(kw)
    })
  return showDone.value ? matched : matched.filter((r) => !doneIds.value.includes(r.id))
})
const doneCount = computed(() => inList.value.filter((id) => doneIds.value.includes(id)).length)

function buildRow(p) {
  return {
    id: p.id, name: p.name, category: p.category, unit: defaultUnit(p),
    qty: '', price: '', freight: '', handling: '', remark: '',
  }
}
/** 单价自动带出：优先「最近一次录入的入库价」（按所选单位换算），没有入库记录时用参考成本 */
function setPrice(r, p) {
  if (!p) return
  const f = unitFactor(p, r.unit)
  const base = num(p.last_in_price) > 0 ? num(p.last_in_price) : num(p.unit_cost)
  r.price = base > 0 ? String(+(base * f).toFixed(6)) : ''
}
async function loadInbound() {
  try {
    if (!PROD.value.length) PROD.value = await api('/api/products')
    // only_list=true：只取「管理展示商品」里挑过的商品，没挑过的鲜货不会自己冒出来
    const cur = await api('/api/fresh?only_list=true')
    inList.value = (cur.items || []).map((x) => x.id)
    doneIds.value = loadDone()
  } catch (e) { showToast(e.message || '加载鲜货清单失败'); return }
  inList.value.forEach((id) => {
    const p = prodById.value.get(id)
    if (!p) return
    if (!rowsMap[id]) {
      rowsMap[id] = buildRow(p)
      setPrice(rowsMap[id], p)
    }
  })
}
function openInbound() { tab.value = 'in'; loadInbound() }

/** 商品列小字：分类（换过单位时补一句换算，和基础单位相同就不啰嗦） */
function convText(r) {
  const p = prodById.value.get(r.id)
  if (!p || !r.unit || r.unit === p.base_unit) return r.category || ''
  const f = unitFactor(p, r.unit)
  return f && f !== 1 ? `1${r.unit}=${fmtNum(f)}${p.base_unit}` : ''
}

const inUnitShow = ref(false)
const inUnitActions = ref([])
let inUnitRow = null
function openInUnit(r) {
  inUnitRow = r
  const p = prodById.value.get(r.id)
  const keys = Object.keys((p && p.conversions) || {})
  inUnitActions.value = (keys.length ? keys : [r.unit]).map((u) => ({ name: u, value: u }))
  inUnitShow.value = true
}
function onInUnitSelect(a) {
  if (!inUnitRow) return
  inUnitRow.unit = a.value
  inUnitRow.price = ''      // 换单位后单价要按新单位重算
  setPrice(inUnitRow, prodById.value.get(inUnitRow.id))
  inUnitShow.value = false
}

function togglePick(id) {
  pickIds.value = pickIds.value.includes(id) ? pickIds.value.filter((x) => x !== id) : [...pickIds.value, id]
}
/** 合计：填了数量的行才计入（没填数量的不会入库） */
const inSummary = computed(() => {
  let rows = 0, goods = 0, fee = 0
  inRows.value.forEach((r) => {
    const qty = num(r.qty)
    if (!(qty > 0)) return
    rows++
    goods += qty * num(r.price)
    fee += num(r.freight) + num(r.handling)
  })
  return { rows, goods, fee }
})
function inClearQty() {
  let n = 0
  inRows.value.forEach((r) => {
    if (num(r.qty) > 0) n++
    r.qty = ''
    r.freight = ''
    r.handling = ''
  })
  showToast(n ? `已清空 ${n} 个商品的数量` : '本来就没填数量')
}
function doneUndo(id) {
  doneIds.value = doneIds.value.filter((x) => x !== id)
  saveDone(doneIds.value)
}

/** 入库：传 list 只入这些行（行尾「入库」）；不传就按勾选 / 全部已填行 */
async function submitRows(list) {
  const targets = list && list.length
    ? list
    : (pickIds.value.length ? inRows.value.filter((r) => pickIds.value.includes(r.id)) : inRows.value)
  const items = []
  const bad = []
  targets.forEach((r) => {
    const qty = num(r.qty)
    if (!(qty > 0)) return   // 没填数量 = 今天不入库
    const raw = String(r.price == null ? '' : r.price).trim()
    if (raw === '' || isNaN(parseFloat(raw))) { bad.push(r.name); return }
    items.push({
      product_id: r.id, unit: r.unit, quantity: qty, unit_price: num(r.price),
      supplier: inForm.supplier, operator: inForm.operator, date: inForm.date,
      remark: r.remark || '', pay_status: inForm.pay_status,
      adjust_amount: 0, freight: num(r.freight), handling: num(r.handling),
    })
  })
  if (bad.length) { showToast(`这些商品没填单价：${bad.slice(0, 5).join('、')}${bad.length > 5 ? ' 等' : ''}`); return }
  if (!items.length) { showToast('还没填数量：先把今天要入库的数量填进「数量」'); return }
  const goods = items.reduce((s, it) => s + it.quantity * it.unit_price, 0)
  const fee = items.reduce((s, it) => s + it.freight + it.handling, 0)
  try {
    await showConfirmDialog({
      title: '确认入库',
      message: `确认入库 ${items.length} 个商品？\n日期 ${inForm.date}，货款 ${fmtMoney(goods)}${fee ? ` + 运费/装卸 ${fmtMoney(fee)}` : ''}，共 ${items.length} 张入库单`,
    })
  } catch (e) { return }
  try {
    const r = await api('/api/inbounds/batch', 'POST', { items })
    // 入库成功的商品记成「今日已入库」：先从列表隐藏，第二天 0 点自动回来
    doneIds.value = [...new Set([...doneIds.value, ...items.map((it) => it.product_id)])]
    saveDone(doneIds.value)
    items.forEach((it) => {
      const row = rowsMap[it.product_id]
      if (row) { row.qty = ''; row.freight = ''; row.handling = ''; row.remark = '' }
    })
    pickIds.value = pickIds.value.filter((x) => !items.some((it) => it.product_id === x))
    await loadInbound()   // 顺便刷新库存与单价
    showToast(`已入库 ${r.created} 张单${r.failed_count ? `，${r.failed_count} 行失败` : ''}`)
  } catch (e) { showToast('入库失败：' + e.message) }
}
async function submitAll() {
  inSaving.value = true
  await submitRows(null)
  inSaving.value = false
}
async function submitRow(r) {
  if (!(num(r.qty) > 0)) { showToast('先把这一行要入库的数量填上'); return }
  rowSaving.value = r.id
  await submitRows([r])
  rowSaving.value = 0
}

onMounted(async () => {
  if (route.query.tab === 'in') tab.value = 'in'   // 工作台「鲜货入库」可直接定位到入库页签
  await load()
  try {
    const me = await api('/api/auth/me')
    whKey.value = (me && me.warehouse && (me.warehouse.key || me.warehouse.name)) || ''
  } catch (e) { /* 取不到就按全局 key 记 */ }
  if (tab.value === 'in') await loadInbound()
})
</script>

<style scoped>
.sub-page { min-height: 100vh; background: #f7f8fa; }
.order-idx {
  display: inline-flex; align-items: center; justify-content: center;
  min-width: 18px; height: 18px; border-radius: 50%; flex-shrink: 0;
  background: #e8f3ff; color: #1989fa; font-size: 11px; font-weight: 600; margin-right: 6px;
}
.suggest { color: #ee0a24; font-weight: 600; font-size: 12px; }
.ok { color: #07c160; font-size: 12px; }
.alert { border-radius: 8px; padding: 8px 10px; font-size: 12px; margin-bottom: 8px; }
.alert.warn { background: #fffbe8; color: #ed6a0c; }

/* 鲜货入库 */
.in-row { padding: 10px 0; border-bottom: 1px dashed #f0f0f0; }
.in-row.on { background: #f6ffed; border-radius: 8px; padding-left: 8px; padding-right: 8px; }
.in-row.done { opacity: .6; }
</style>
