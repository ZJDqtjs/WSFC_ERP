<template>
  <div class="sub-page">
    <van-nav-bar title="待付款账单" left-arrow fixed placeholder @click-left="goBack" />
    <div style="padding:12px;">
      <!-- 汇总 -->
      <div class="stat-grid cols2" style="margin-bottom:12px;">
        <div class="stat danger"><div class="label">待付款（应付）</div><div class="value">{{ fmtMoney(total.payables_amount) }}</div><div class="sub">要付出去的钱</div></div>
        <div class="stat accent"><div class="label">待收款（应收）</div><div class="value">{{ fmtMoney(total.receivables_amount) }}</div><div class="sub">要收进来的钱</div></div>
        <div class="stat warn"><div class="label">待结清笔数</div><div class="value">{{ total.unpaid_count || 0 }}</div><div class="sub">合计 {{ fmtMoney((total.payables_amount || 0) + (total.receivables_amount || 0)) }}</div></div>
        <div class="stat"><div class="label">最近已结清</div><div class="value">{{ total.paid_count || 0 }}</div><div class="sub">最近 30 天内（可撤销）</div></div>
      </div>

      <!-- 页签：账单 / 代发 -->
      <div class="seg" style="margin-bottom:8px;">
        <div class="seg-item" :class="{ active: tab === 'bill' }" @click="tab = 'bill'">账单</div>
        <div class="seg-item" :class="{ active: tab === 'ds' }" @click="openDs">代发</div>
      </div>

      <template v-if="tab === 'bill'">
      <!-- 视图 -->
      <div class="seg" style="margin-bottom:8px;">
        <div class="seg-item" :class="{ active: view === 'unpaid' }" @click="setView('unpaid')">待结清</div>
        <div class="seg-item" :class="{ active: view === 'all' }" @click="setView('all')">含最近已结清</div>
      </div>

      <div class="card">
        <van-field v-model="kw" placeholder="筛选 款项 / 单据 / 客户 / 操作员" style="background:#f7f8fa;border-radius:6px;" />
        <div class="row wrap" style="gap:6px;align-items:center;margin-top:8px;">
          <div class="date-pick" :class="{ 'has-value': df }">
            <van-field v-model="df" type="date" style="max-width:132px;background:#f7f8fa;border-radius:6px;padding:6px 10px;" />
            <span class="date-ph">开始</span>
          </div>
          <div class="date-pick" :class="{ 'has-value': dt }">
            <van-field v-model="dt" type="date" style="max-width:132px;background:#f7f8fa;border-radius:6px;padding:6px 10px;" />
            <span class="date-ph">结束</span>
          </div>
          <van-button size="small" plain :disabled="!filtered" @click="clearFilter">清空筛选</van-button>
        </div>
        <div class="muted" style="font-size:12px;margin-top:6px;">
          按日期区间 / 关键词筛选，下面的合计实时更新
        </div>
        <div v-if="undatedCount" class="muted" style="font-size:12px;">{{ undatedCount }} 笔无日期的账单未计入</div>
      </div>

      <!-- 筛选结果实时合计 -->
      <div class="pay-sum">
        <div class="row">
          <span class="muted">{{ filtered ? '筛选结果' : '当前账单' }} <b>{{ rows.length }}</b> 笔<template v-if="rows.length !== items.length"> / 共 {{ items.length }} 笔</template></span>
          <span class="grow"></span>
          <span>合计 <b class="sum">{{ fmtMoney(sumOut + sumIn) }}</b></span>
        </div>
        <div class="muted" style="font-size:12px;margin-top:2px;white-space:nowrap;">
          应付 <b class="down">{{ fmtMoney(sumOut) }}</b> ／ 应收 <b class="up">{{ fmtMoney(sumIn) }}</b>
        </div>
        <div v-if="filtered" class="muted" style="font-size:12px;margin-top:2px;">已按 {{ filterDesc }} 筛选</div>
      </div>

      <div class="card">
        <div v-if="!rows.length" class="empty">{{ filtered ? '没有符合筛选条件的账单' : (view === 'all' ? '没有账单' : '没有待结清的账单') }}</div>
        <div v-if="picked.length" class="batch-bar">
          <span class="muted">已选 {{ picked.length }} 笔 · 合计 {{ fmtMoney(pickedAmount) }}</span>
          <van-button size="mini" type="success" :loading="batchPaying" @click="batchPay(true)">批量已支付</van-button>
          <van-button size="mini" plain :loading="batchPaying" @click="batchPay(false)">批量撤销</van-button>
          <van-button size="mini" plain @click="picked = []">取消</van-button>
        </div>
        <div v-for="r in rows" :key="r.kind + '-' + r.id" class="list-item" :style="r.pay_status === 'unpaid' ? '' : 'opacity:.55;'">
          <!-- 左边：具体事物 + 款项 -->
          <div class="row">
            <van-checkbox :model-value="picked.includes(r.kind + '-' + r.id)" style="margin-right:8px;" @click="togglePick(r)" />
            <van-tag :type="TAG[r.source] || 'default'" plain>{{ r.source }}</van-tag>
            <van-tag v-if="r.partial" type="warning" plain style="margin-left:4px;">部分付款</van-tag>
            <span class="grow item-title ellipsis" style="margin-left:6px;">{{ r.title }}</span>
          </div>
          <div class="item-meta">
            {{ r.date }}{{ r.code ? ' · ' + r.code : '' }}{{ r.sub ? ' · ' + r.sub : '' }}
          </div>
          <div v-if="r.remark" class="item-meta">{{ r.remark }}</div>
          <div v-if="r.partial" class="item-meta" style="color:#b45309;">
            应付 {{ fmtMoney(r.due_amount) }} · 已付 {{ fmtMoney(r.paid_amount) }} · 未付 {{ fmtMoney(r.amount) }}
          </div>
          <div class="item-meta">
            操作员 {{ r.operator || '—' }} · <span :class="r.direction === 'in' ? 'up' : 'down'">{{ r.direction === 'in' ? '应收' : '应付' }} {{ fmtMoney(r.amount) }}</span>
          </div>
          <!-- 右边：已支付按钮 -->
          <div class="row" style="margin-top:6px;justify-content:flex-end;gap:8px;">
            <template v-if="r.pay_status === 'unpaid'">
              <van-button size="small" plain @click="goSource(r)">查看</van-button>
              <van-button size="small" type="success" :loading="paying === r.kind + '-' + r.id" @click="pay(r)">已支付</van-button>
            </template>
            <template v-else>
              <span class="muted" style="font-size:12px;">已结清 {{ r.paid_at }}</span>
              <van-button size="small" plain :loading="paying === r.kind + '-' + r.id" @click="revoke(r)">撤销</van-button>
            </template>
          </div>
        </div>
        <div v-if="rows.length" class="row" style="margin-top:8px;">
          <span class="grow muted">{{ view === 'all' ? '含最近已结清（最近 30 天，可撤销）' : '只列未结清的账单' }}</span>
        </div>
      </div>

      <div class="muted" style="font-size:12px;padding:4px 2px;">
        入库 / 入仓 / 出库 / 其他收支 里勾了「待付款」的单据都会汇总到这里；点「已支付」后按原日期纳入财务报表。已结清只载入最近 30 天。
      </div>
      </template>

      <!-- ============ 代发 ============ -->
      <template v-else>
        <div class="seg" style="margin-bottom:8px;">
          <div class="seg-item" :class="{ active: dsView === 'unpaid' }" @click="setDsView('unpaid')">待结清</div>
          <div class="seg-item" :class="{ active: dsView === 'all' }" @click="setDsView('all')">含已结清</div>
        </div>

        <div class="card">
          <van-field v-model="dsKw" placeholder="筛选 商品 / 规格 / 操作员" style="background:#f7f8fa;border-radius:6px;" />
          <div class="row wrap" style="gap:6px;align-items:center;margin-top:8px;">
            <div class="date-pick" :class="{ 'has-value': dsFrom }">
              <van-field v-model="dsFrom" type="date" style="max-width:132px;background:#f7f8fa;border-radius:6px;padding:6px 10px;" @update:model-value="loadDs" />
              <span class="date-ph">开始</span>
            </div>
            <div class="date-pick" :class="{ 'has-value': dsTo }">
              <van-field v-model="dsTo" type="date" style="max-width:132px;background:#f7f8fa;border-radius:6px;padding:6px 10px;" @update:model-value="loadDs" />
              <span class="date-ph">结束</span>
            </div>
            <van-button size="small" plain :disabled="!dsFiltered" @click="clearDsFilter">清空筛选</van-button>
          </div>
          <div class="muted" style="font-size:12px;margin-top:6px;">
            按「商品 + 规格 + 出库日期」分行，按天核对「单价 × 单量 = 代发成本」；日期区间在服务端过滤
          </div>
          <div v-if="dsTruncated" class="alert warn">
            共 {{ dsTotal.groups || 0 }} 行，这里只列最近 {{ dsLimit }} 行；用日期区间可以缩小范围
          </div>
        </div>

        <div class="pay-sum">
          <div class="row">
            <span class="muted">{{ dsFiltered ? '筛选结果' : '当前列表' }} <b>{{ dsRows.length }}</b> 行 / {{ dsDays }} 天 / {{ dsOrders }} 单</span>
            <span class="grow"></span>
            <span>合计 <b class="sum">{{ fmtMoney(dsSum) }}</b></span>
          </div>
          <div class="muted" style="font-size:12px;margin-top:2px;white-space:nowrap;">
            待结清 <b class="down">{{ fmtMoney(dsPendingAmount) }}</b>
            <template v-if="dsView === 'all'"> ／ 已结清 <b class="up">{{ fmtMoney(dsSum - dsPendingAmount) }}</b></template>
          </div>
        </div>

        <div class="card">
          <div v-if="dsSelected.length" class="batch-bar">
            <span class="muted">已选 {{ dsSelected.length }} 款规格</span>
            <van-button size="mini" type="success" :loading="dsPaying" @click="dsBatchPay(true)">批量标记已支付</van-button>
            <van-button size="mini" plain :loading="dsPaying" @click="dsBatchPay(false)">批量撤销</van-button>
            <van-button size="mini" plain @click="dsSelected = []">取消</van-button>
          </div>
          <div v-if="!dsRows.length" class="empty">
            {{ dsFiltered ? '没有符合筛选条件的代发应付' : (dsView === 'all' ? '还没有代发应付账单' : '没有待结清的代发应付') }}
          </div>
          <div
            v-for="(g, i) in dsRows"
            :key="g.product_id + '-' + (g.spec || '') + '-' + (g.unit || '') + '-' + (g.date || '')"
            class="list-item"
            :style="g.pay_status === 'unpaid' ? '' : 'opacity:.55;'"
          >
            <div class="row">
              <van-checkbox :model-value="dsSelected.includes(i)" style="margin-right:8px;" @click="dsToggle(i)" />
              <span class="grow item-title ellipsis">
                {{ g.product_name || '代发商品' }}
                <span v-if="g.spec && !(g.product_name || '').includes(g.spec)" class="muted"> · {{ g.spec }}</span>
              </span>
              <span class="bold down-text">{{ fmtMoney(g.amount) }}</span>
            </div>
            <div class="item-meta">
              {{ g.date }} · {{ fmtNum(g.quantity) }}{{ g.unit }} × {{ fmtMoney(g.unit_price) }} = 代发成本 {{ fmtMoney(g.amount) }} · {{ g.order_count }} 单
            </div>
            <div class="row" style="margin-top:6px;justify-content:flex-end;gap:8px;">
              <template v-if="g.pay_status === 'unpaid'">
                <van-button size="small" type="success" :loading="dsPayingOne === i" @click="dsPay(g, i, true)">已支付</van-button>
              </template>
              <template v-else>
                <span class="muted" style="font-size:12px;">已付 {{ g.paid_at }}</span>
                <van-button size="small" plain :loading="dsPayingOne === i" @click="dsPay(g, i, false)">撤销</van-button>
              </template>
            </div>
          </div>
        </div>

        <div class="muted" style="font-size:12px;padding:4px 2px;">
          同一种商品和规格按「出库日期」分别成行；应付 = 成本单价 × 单量 = 代发成本（已计入结转成本、毛利口径不变）。这里只做「付给代发方」的核对，付款状态不影响财务报表。
        </div>
      </template>
    </div>

    <!-- 已支付确认：可顺手记一笔转账手续费 → 其他收支 -->
    <van-popup v-model:show="payShow" position="bottom" round>
      <div class="sheet-body">
        <div class="sheet-title">{{ payForm.title }}</div>
        <div class="muted" style="margin-bottom:10px;line-height:1.5;">{{ payForm.label }}<br />{{ payForm.note }}</div>
        <van-cell-group inset>
          <van-field v-model="payForm.fee" type="number" label="转账手续费" placeholder="0.00（选填）">
            <template #button><span class="muted">元</span></template>
          </van-field>
          <van-field v-model="payForm.date" label="手续费日期" type="date" />
        </van-cell-group>
        <div class="muted" style="font-size:12px;padding:6px 4px 8px;">
          填了会自动记一笔「其他收支 → 手续费」（已付款），计入财务报表期间费用；不收手续费留空即可。
        </div>
        <div class="sheet-foot">
          <van-button block plain @click="payShow = false">取消</van-button>
          <van-button block type="success" :loading="paySubmitting" @click="confirmPayModal">确认已支付</van-button>
        </div>
      </div>
    </van-popup>
  </div>
</template>

<script setup>
import { ref, reactive, computed, onMounted } from 'vue'
import { useRouter } from 'vue-router'
import { showToast, showConfirmDialog } from 'vant'
import api from '../api'
import { fmtMoney, fmtNum, num, todayStr } from '../utils/format'

const router = useRouter()
function goBack() {
  if (window.history.length > 1) router.back()
  else router.replace('/mine')
}

const TAG = { 入库: 'primary', 入仓: 'success', 出库: 'warning', 其他收支: 'danger', 手动记账: 'default' }
const view = ref('unpaid')      // unpaid 只看待结清 / all 含最近已结清
const items = ref([])
const total = ref({})
const kw = ref('')
const df = ref('')              // 日期区间起（含）
const dt = ref('')              // 日期区间止（含）
const paying = ref('')

/** 只按关键词筛（日期区间之外的部分，用来统计被日期挡掉的无日期笔数） */
const kwRows = computed(() => {
  const s = (kw.value || '').trim().toLowerCase()
  if (!s) return items.value
  return items.value.filter((r) =>
    [r.date, r.source, r.title, r.sub, r.code, r.remark, r.operator].join(' ').toLowerCase().includes(s)
  )
})

/** 关键词 + 日期区间（起止都含；按 YYYY-MM-DD 字符串比较，没日期的单据不计入） */
const rows = computed(() => {
  if (!df.value && !dt.value) return kwRows.value
  return kwRows.value.filter((r) => r.date && (!df.value || r.date >= df.value) && (!dt.value || r.date <= dt.value))
})

const undatedCount = computed(() => (df.value || dt.value ? kwRows.value.filter((r) => !r.date).length : 0))
const filtered = computed(() => !!(kw.value.trim() || df.value || dt.value))
/** 筛选后的实时合计：应付（要付出去）/ 应收（要收进来） */
const sumOut = computed(() => rows.value.filter((r) => r.direction !== 'in').reduce((s, r) => s + (r.amount || 0), 0))
const sumIn = computed(() => rows.value.filter((r) => r.direction === 'in').reduce((s, r) => s + (r.amount || 0), 0))
const filterDesc = computed(() => {
  const range = df.value || dt.value ? `日期 ${df.value || '最早'}~${dt.value || '最新'}` : ''
  const k = kw.value.trim() ? `关键词「${kw.value.trim()}」` : ''
  return [range, k].filter(Boolean).join(' + ')
})

function clearFilter() {
  kw.value = ''
  df.value = ''
  dt.value = ''
}

async function load() {
  try {
    const d = await api(`/api/payables?include_paid=${view.value === 'all' ? 1 : 0}`)
    items.value = d.items || []
    total.value = d.total || {}
  } catch (e) { showToast(e.message || '加载失败') }
}

function setView(v) {
  view.value = v
  load()
}

/** 标记已支付（弹窗可填转账手续费）/ 撤销 */
function pay(r) {
  openPayModal({
    title: '确认已支付',
    label: `${r.source}「${r.title}」${fmtMoney(r.amount)}`,
    note: r.partial
      ? '这是该单未付的余额；确认后按原日期计入财务报表，未付余额结清。'
      : '确认后这笔将按原日期计入财务报表。',
    onOk: (fee, date) => submitPay({ kind: r.kind, id: r.id, paid: true, fee, date }, '已标记已支付'),
  })
}

async function submitPay(body, okText = '已标记已支付') {
  paying.value = body.kind + '-' + body.id
  let ok = true
  try {
    const res = await api('/api/payables/pay', 'POST', body)
    showToast(okText + (res && res.fee ? `；手续费 ${fmtMoney(res.fee)} 已记「其他收支」` : ''))
    await load()
  } catch (e) { ok = false; showToast(e.message || '操作失败') }
  paying.value = ''
  return ok
}

async function revoke(r) {
  try {
    await showConfirmDialog({
      title: '撤销已支付',
      message: `${r.source}「${r.title}」${fmtMoney(r.amount)}\n撤销后它会移出财务报表，回到待付款账单。`,
    })
  } catch (e) { return }
  await submitPay({ kind: r.kind, id: r.id, paid: false, fee: 0, date: '' }, '已撤销，已移出财务报表')
}

/* ---------- 账单页签：勾选批量结清 / 撤销 ---------- */
const picked = ref([])
const batchPaying = ref(false)
const pickedRows = computed(() => rows.value.filter((r) => picked.value.includes(r.kind + '-' + r.id)))
const pickedAmount = computed(() => pickedRows.value.reduce((s, r) => s + (r.amount || 0), 0))

function togglePick(r) {
  const k = r.kind + '-' + r.id
  picked.value = picked.value.includes(k) ? picked.value.filter((x) => x !== k) : [...picked.value, k]
}

async function batchPay(paid) {
  const list = pickedRows.value
  if (!list.length) { showToast('请先勾选要处理的账单'); return }
  const amount = list.reduce((s, r) => s + (r.amount || 0), 0)
  if (!paid) {
    try {
      await showConfirmDialog({
        title: '批量撤销',
        message: `${list.length} 笔，合计 ${fmtMoney(amount)}？\n撤销后会从财务报表移出。`,
      })
    } catch (e) { return }
    await submitBatch(list, false, 0, '')
    return
  }
  openPayModal({
    title: '批量标记已支付',
    label: `${list.length} 笔账单，合计 ${fmtMoney(amount)}`,
    note: '确认后这些将按原日期计入财务报表。整批只记一笔手续费。',
    onOk: (fee, date) => submitBatch(list, true, fee, date),
  })
}

async function submitBatch(list, paid, fee, date) {
  batchPaying.value = true
  let ok = true
  try {
    const byKind = new Map()
    list.forEach((r) => {
      if (!byKind.has(r.kind)) byKind.set(r.kind, [])
      byKind.get(r.kind).push(r.id)
    })
    let updated = 0, missing = 0, feeTotal = 0, feeLeft = fee
    for (const [kind, ids] of byKind) {
      // 手续费只随第一组提交一次（后端每收到一次就记一笔其他收支）
      const res = await api('/api/payables/pay-batch', 'POST', { kind, ids, paid, fee: feeLeft, date })
      feeLeft = 0
      updated += res.updated || 0
      missing += res.missing || 0
      feeTotal += res.fee || 0
    }
    showToast(`已处理 ${updated} 笔${missing ? `，${missing} 笔已不存在` : ''}`
      + (feeTotal ? `；手续费 ${fmtMoney(feeTotal)} 已记「其他收支」` : ''))
    picked.value = []
    await load()
  } catch (e) { ok = false; showToast(e.message || '批量操作失败') }
  batchPaying.value = false
  return ok
}

/* ---------- 已支付确认弹窗：可顺手记一笔转账手续费 → 其他收支 ---------- */
const payShow = ref(false)
const paySubmitting = ref(false)
const payForm = reactive({ title: '', label: '', note: '', fee: '', date: todayStr() })
let payAction = null

function openPayModal(cfg) {
  Object.assign(payForm, { title: '', label: '', note: '', fee: '', date: todayStr() }, cfg)
  payAction = cfg.onOk
  payShow.value = true
}

async function confirmPayModal() {
  const fee = num(payForm.fee)
  if (fee < 0) { showToast('手续费不能为负数'); return }
  if (!payAction) return
  paySubmitting.value = true
  try {
    const ok = await payAction(fee, payForm.date || todayStr())
    if (ok !== false) payShow.value = false
  } finally { paySubmitting.value = false }
}

function goSource(r) {
  // 移动端没有独立的入仓页，未登记路径的单据不跳转
  const path = { inbound: '/inbound', outbound: '/outbound', otherexp: '/otherexp', finance: '/report' }[r.kind]
  if (path) router.push(path)
}

/* ---------- 代发页签：出库单里命中代发商品的成本，按「商品 + 规格 + 出库日期」分行 ----------
   金额 = 代发成本（出库行 cogs = 成本单价 × 基础数量），本来就已计入该单结转成本；
   这里只做「付给代发方」的付款核对，付款状态独立于出库单（不影响财务报表）。 */
const tab = ref('bill')
const dsView = ref('unpaid')
const dsGroups = ref([])
const dsTotal = ref({})
const dsTruncated = ref(false)
const dsLimit = ref(0)
const dsKw = ref('')
const dsFrom = ref('')     // 按出库单日期筛选（服务端过滤）
const dsTo = ref('')
const dsSelected = ref([]) // 当前渲染行的下标（勾选批量）
const dsPaying = ref(false)
const dsPayingOne = ref(-1)

async function loadDs() {
  try {
    const qs = new URLSearchParams({ include_paid: dsView.value === 'all' ? '1' : '0' })
    // 日期区间交给服务端过滤：列表被截断（只回最近 N 行）时也能查到更早的日期
    if (dsFrom.value) qs.set('date_from', dsFrom.value)
    if (dsTo.value) qs.set('date_to', dsTo.value)
    const d = await api(`/api/payables/dropship?${qs.toString()}`)
    dsGroups.value = d.groups || []
    dsTotal.value = d.total || {}
    dsTruncated.value = !!d.truncated
    dsLimit.value = d.limit || 0
    dsSelected.value = []
  } catch (e) { showToast(e.message || '加载代发应付失败') }
}
function openDs() { tab.value = 'ds'; loadDs() }
function setDsView(v) { dsView.value = v; loadDs() }
function clearDsFilter() { dsKw.value = ''; dsFrom.value = ''; dsTo.value = ''; loadDs() }

/** 关键词筛选（日期已由服务端过滤） */
const dsRows = computed(() => {
  const s = (dsKw.value || '').trim().toLowerCase()
  if (!s) return dsGroups.value
  return dsGroups.value.filter((g) =>
    [g.product_name, g.spec, g.unit, g.operator].join(' ').toLowerCase().includes(s)
  )
})
const dsFiltered = computed(() => !!(dsKw.value.trim() || dsFrom.value || dsTo.value))
const dsSum = computed(() => dsRows.value.reduce((s, g) => s + num(g.amount), 0))
const dsPendingAmount = computed(() =>
  dsRows.value.filter((g) => g.pay_status === 'unpaid').reduce((s, g) => s + num(g.amount), 0)
)
const dsOrders = computed(() => dsRows.value.reduce((s, g) => s + (g.order_count || 0), 0))
const dsDays = computed(() => new Set(dsRows.value.map((g) => g.date).filter(Boolean)).size)

function dsToggle(i) {
  dsSelected.value = dsSelected.value.includes(i)
    ? dsSelected.value.filter((x) => x !== i)
    : [...dsSelected.value, i]
}

/** 代发成本付款提交：手续费 >0 时后端自动记一笔「其他收支 → 手续费」 */
async function submitDs(ids, paid, fee, date) {
  let ok = true
  try {
    const r = await api('/api/payables/pay-batch', 'POST', { kind: 'dropship_item', ids, paid, fee, date })
    showToast((paid ? '已标记代发成本已支付' : '已撤销')
      + (r && r.fee ? `；手续费 ${fmtMoney(r.fee)} 已记「其他收支」` : ''))
    await loadDs()
    await load()
  } catch (e) { ok = false; showToast(e.message || '操作失败') }
  return ok
}

/** 标记某款商品规格（可能跨多张出库单）的代发成本已付/撤销 */
async function dsPay(g, i, paid) {
  const plain = `${g.product_name}${g.spec ? ' · ' + g.spec : ''}（${g.order_count} 单，代发成本 ${fmtMoney(g.amount)}）`
  if (!paid) {
    try {
      await showConfirmDialog({ title: '撤销已付标记', message: `${plain}\n只影响代发付款核对，不影响财务报表。` })
    } catch (e) { return }
    dsPayingOne.value = i
    await submitDs(g.bill_ids || [], false, 0, '')
    dsPayingOne.value = -1
    return
  }
  openPayModal({
    title: '代发成本已支付',
    label: plain,
    note: '只影响代发付款核对，不影响报表的收入成本；手续费照常记入「其他收支」。',
    onOk: async (fee, date) => {
      dsPayingOne.value = i
      const ok = await submitDs(g.bill_ids || [], true, fee, date)
      dsPayingOne.value = -1
      return ok
    },
  })
}

async function dsBatchPay(paid) {
  const picked = dsSelected.value.map((i) => dsRows.value[i]).filter(Boolean)
  const ids = picked.flatMap((g) => g.bill_ids || [])
  if (!ids.length) { showToast('请先勾选要处理的商品规格'); return }
  const amount = picked.reduce((a, g) => a + num(g.amount), 0)
  const orders = picked.reduce((a, g) => a + (g.order_count || 0), 0)
  if (!paid) {
    try {
      await showConfirmDialog({
        title: '批量撤销',
        message: `${picked.length} 款商品规格 / ${orders} 张出库单，代发成本合计 ${fmtMoney(amount)}？\n（只撤销付款核对标记，不影响财务报表）`,
      })
    } catch (e) { return }
    dsPaying.value = true
    await submitDs(ids, false, 0, '')
    dsPaying.value = false
    return
  }
  openPayModal({
    title: '批量标记代发成本已支付',
    label: `${picked.length} 款商品规格 / ${orders} 张出库单，代发成本合计 ${fmtMoney(amount)}`,
    note: '只影响代发付款核对，不影响报表的收入成本；整批只记一笔手续费。',
    onOk: async (fee, date) => {
      dsPaying.value = true
      const ok = await submitDs(ids, true, fee, date)
      dsPaying.value = false
      return ok
    },
  })
}

onMounted(load)
</script>

<style scoped>
.sub-page { min-height: 100vh; background: #f7f8fa; }

/* 日期框为空时，隐藏浏览器自带的「yyyy/mm/日」掩码，改用自己的占位文案 */
.date-pick {
  position: relative;
  display: inline-flex;
  align-items: center;
}
.date-pick .date-ph {
  position: absolute;
  left: 12px;
  font-size: 13px;
  color: #c8c9cc;
  pointer-events: none;
}
/* 已有值时不显示占位；聚焦时收起占位，露出原生掩码 */
.date-pick.has-value .date-ph,
.date-pick:focus-within .date-ph { display: none; }
.date-pick:not(.has-value) :deep(.van-field__control:not(:focus))::-webkit-datetime-edit { color: transparent; }

/* 筛选结果实时合计条 */
.pay-sum {
  padding: 10px 12px;
  margin-bottom: 8px;
  border: 1px solid #e8f0fb;
  border-radius: 8px;
  background: #f0f8ff;
  font-size: 13px;
  color: #323233;
}
.pay-sum b.sum { font-size: 17px; color: #0067c0; }
.pay-sum b.down { color: #d13438; }
.pay-sum b.up { color: #107c10; }

/* 代发页签 */
.batch-bar {
  display: flex; align-items: center; gap: 8px; flex-wrap: wrap;
  background: #fff7e6; border-radius: 8px; padding: 8px 10px; margin-bottom: 8px;
}
.alert { border-radius: 8px; padding: 8px 10px; font-size: 12px; margin-top: 8px; }
.alert.warn { background: #fffbe8; color: #ed6a0c; }
.down-text { color: #d13438; }
</style>
