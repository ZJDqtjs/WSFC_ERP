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
        <div v-if="!rows.length" class="empty">{{ view === 'all' ? '没有账单' : '没有待结清的账单' }}</div>
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
          <span class="grow muted">共 {{ rows.length }} 笔{{ view === 'all' ? '（含已结清）' : '' }}</span>
        </div>
      </div>

      <div class="muted" style="font-size:12px;padding:4px 2px;">
        入库 / 入仓 / 出库 / 其他开支 里勾了「待付款」的单据都会汇总到这里；点「已支付」后按原日期纳入财务报表。
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
const paying = ref('')

const rows = computed(() => {
  const s = (kw.value || '').trim().toLowerCase()
  if (!s) return items.value
  return items.value.filter((r) =>
    [r.date, r.source, r.title, r.sub, r.code, r.remark, r.operator].join(' ').toLowerCase().includes(s)
  )
})

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
</style>
