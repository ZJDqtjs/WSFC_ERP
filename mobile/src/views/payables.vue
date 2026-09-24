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
        <div v-for="r in rows" :key="r.kind + '-' + r.id" class="list-item" :style="r.pay_status === 'unpaid' ? '' : 'opacity:.55;'">
          <!-- 左边：具体事物 + 款项 -->
          <div class="row">
            <van-tag :type="TAG[r.source] || 'default'" plain>{{ r.source }}</van-tag>
            <span class="grow item-title ellipsis" style="margin-left:6px;">{{ r.title }}</span>
          </div>
          <div class="item-meta">
            {{ r.date }}{{ r.code ? ' · ' + r.code : '' }}{{ r.sub ? ' · ' + r.sub : '' }}
          </div>
          <div v-if="r.remark" class="item-meta">{{ r.remark }}</div>
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
        入库 / 入仓 / 出库 / 其他开支 里勾了「待付款」的单据都会汇总到这里；点「已支付」后按原日期纳入财务报表。已结清只载入最近 30 天。
      </div>
    </div>
  </div>
</template>

<script setup>
import { ref, computed, onMounted } from 'vue'
import { useRouter } from 'vue-router'
import { showToast, showConfirmDialog } from 'vant'
import api from '../api'
import { fmtMoney } from '../utils/format'

const router = useRouter()
function goBack() {
  if (window.history.length > 1) router.back()
  else router.replace('/mine')
}

const TAG = { 入库: 'primary', 入仓: 'success', 出库: 'warning', 其他开支: 'danger', 手动记账: 'default' }
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

/** 标记已支付（转入财务报表）/ 撤销 */
async function pay(r) {
  try {
    await showConfirmDialog({
      title: '确认已支付',
      message: `${r.source}「${r.title}」${fmtMoney(r.amount)}\n确认后这笔将按原日期计入财务报表。`,
    })
  } catch (e) { return }
  paying.value = r.kind + '-' + r.id
  try {
    await api('/api/payables/pay', 'POST', { kind: r.kind, id: r.id, paid: true })
    showToast('已标记已支付')
    await load()
  } catch (e) { showToast(e.message || '操作失败') }
  paying.value = ''
}

async function revoke(r) {
  try {
    await showConfirmDialog({
      title: '撤销已支付',
      message: `${r.source}「${r.title}」${fmtMoney(r.amount)}\n撤销后它会移出财务报表，回到待付款账单。`,
    })
  } catch (e) { return }
  paying.value = r.kind + '-' + r.id
  try {
    await api('/api/payables/pay', 'POST', { kind: r.kind, id: r.id, paid: false })
    showToast('已撤销')
    await load()
  } catch (e) { showToast(e.message || '操作失败') }
  paying.value = ''
}

function goSource(r) {
  // 移动端没有独立的入仓页，未登记路径的单据不跳转
  const path = { inbound: '/inbound', outbound: '/outbound', otherexp: '/otherexp', finance: '/report' }[r.kind]
  if (path) router.push(path)
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
</style>
