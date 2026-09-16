<template>
  <div class="sub-page">
    <van-nav-bar title="其他开支" left-arrow fixed placeholder @click-left="goBack" />
    <div style="padding:12px;">
      <!-- 统计区间 -->
      <div class="card">
        <div class="row wrap" style="gap:6px;">
          <van-field v-model="df" type="date" placeholder="起" style="max-width:132px;background:#f7f8fa;border-radius:6px;padding:6px 10px;" />
          <van-field v-model="dt" type="date" placeholder="止" style="max-width:132px;background:#f7f8fa;border-radius:6px;padding:6px 10px;" />
          <van-button size="small" type="primary" @click="load">查询</van-button>
        </div>
        <div class="seg" style="margin:8px 0 0;">
          <div v-for="q in QUICKS" :key="q.key" class="seg-item" :class="{ active: quickKey === q.key }" @click="quick(q.key)">{{ q.label }}</div>
        </div>
      </div>

      <!-- 汇总 -->
      <div class="stat-grid cols2" style="margin-bottom:12px;">
        <div class="stat danger"><div class="label">今日开支</div><div class="value">{{ fmtMoney(stats.today_total) }}</div><div class="sub">{{ stats.today || '—' }}</div></div>
        <div class="stat danger"><div class="label">本月开支</div><div class="value">{{ fmtMoney(stats.month_total) }}</div><div class="sub">{{ stats.month || '—' }} 月合计</div></div>
        <div class="stat warn"><div class="label">所选区间合计</div><div class="value">{{ fmtMoney(stats.range_total) }}</div><div class="sub">{{ stats.range_count || 0 }} 笔 · 日均 {{ fmtMoney(stats.range_daily_avg) }}</div></div>
        <div class="stat accent"><div class="label">区间天数</div><div class="value">{{ stats.range_days || 0 }}</div><div class="sub">最大类型：{{ topCatText }}</div></div>
      </div>

      <!-- 分区 tab：统计 / 明细（避免统计与长列表堆在同一页里） -->
      <div class="seg">
        <div class="seg-item" :class="{ active: oeTab === 'stat' }" @click="oeTab = 'stat'">统计</div>
        <div class="seg-item" :class="{ active: oeTab === 'list' }" @click="oeTab = 'list'">明细</div>
      </div>

      <!-- 统计 -->
      <template v-if="oeTab === 'stat'">
      <div class="card">
        <div class="seg" style="margin-bottom:8px;">
          <div v-for="p in PANELS" :key="p.key" class="seg-item" :class="{ active: panel === p.key }" @click="panel = p.key">{{ p.label }}</div>
        </div>

        <template v-if="panel === 'day'">
          <div v-if="!(stats.by_day || []).length" class="empty">该区间暂无开支</div>
          <template v-else>
            <div v-for="d in stats.by_day || []" :key="d.date" class="bar-row">
              <span class="bar-x">{{ d.date.slice(5) }}</span>
              <span class="bar-track"><span class="bar-fill" :style="{ width: barW(d.amount) }" /></span>
              <span class="bar-val">{{ fmtMoney(d.amount) }}</span>
            </div>
            <div class="divider"></div>
            <div class="row"><span class="grow bold">合计（{{ stats.range_count || 0 }} 笔 / {{ (stats.by_day || []).length }} 天）</span><span class="bold up">{{ fmtMoney(stats.range_total) }}</span></div>
          </template>
        </template>

        <template v-else-if="panel === 'month'">
          <div v-if="!(stats.by_month || []).length" class="empty">该区间暂无开支</div>
          <div v-for="(m, i) in stats.by_month || []" :key="m.month" class="list-item">
            <div class="row">
              <span class="grow item-title">{{ m.month }}</span>
              <span class="bold up">{{ fmtMoney(m.amount) }}</span>
            </div>
            <div class="item-meta">
              {{ m.count }} 笔
              <template v-if="momText(i) !== '—'"> · 环比 <b :class="mom(i) >= 0 ? 'up' : 'down'">{{ momText(i) }}</b></template>
            </div>
          </div>
          <template v-if="(stats.by_month || []).length">
            <div class="divider"></div>
            <div class="row"><span class="grow bold">合计</span><span class="bold up">{{ fmtMoney(stats.range_total) }}</span></div>
          </template>
        </template>

        <template v-else>
          <div v-if="!(stats.by_category || []).length" class="empty">该区间暂无开支</div>
          <div v-for="c in stats.by_category || []" :key="c.category" class="list-item">
            <div class="row">
              <van-tag type="danger" plain>{{ c.category }}</van-tag>
              <span class="grow"></span>
              <span class="bold up">{{ fmtMoney(c.amount) }}</span>
            </div>
            <div class="item-meta">{{ c.count }} 笔 · 占比 {{ pctOf(c.amount).toFixed(1) }}%</div>
            <div class="bar-track" style="margin-top:6px;"><span class="bar-fill" :style="{ width: Math.max(3, pctOf(c.amount)) + '%' }" /></div>
          </div>
          <template v-if="(stats.by_category || []).length">
            <div class="divider"></div>
            <div class="row"><span class="grow bold">合计</span><span class="bold up">{{ fmtMoney(stats.range_total) }}</span></div>
          </template>
        </template>
      </div>

      </template>

      <!-- 明细 -->
      <template v-else>
      <div class="card">
        <div class="card-title">
          <span class="grow">开支明细</span>
          <van-button size="mini" type="primary" icon="plus" @click="openForm()">登记</van-button>
        </div>
        <van-field v-model="kw" placeholder="筛选类型 / 备注 / 操作员" style="background:#f7f8fa;border-radius:6px;" />
        <div v-if="!filteredRows.length" class="empty">该区间暂无开支，点右上角「登记」新增</div>
        <div v-for="r in filteredRows" :key="r.id" class="list-item">
          <div class="row">
            <van-tag type="danger" plain>{{ r.category }}</van-tag>
            <van-tag v-if="r.pay_status === 'unpaid'" type="warning" plain style="margin-left:6px;">待付款</van-tag>
            <span class="grow"></span>
            <span class="bold up">{{ fmtMoney(r.amount) }}</span>
          </div>
          <div class="item-meta">{{ r.date }}{{ r.operator ? ' · ' + r.operator : '' }}</div>
          <RemarkView v-if="r.remark" :remark="r.remark" />
          <div class="row" style="gap:8px;margin-top:6px;">
            <van-button size="mini" plain type="primary" @click="openForm(r)">编辑</van-button>
            <van-button size="mini" plain type="danger" @click="delRow(r)">删除</van-button>
          </div>
        </div>
        <div v-if="filteredRows.length" class="row" style="margin-top:8px;">
          <span class="grow muted">共 {{ filteredRows.length }} 笔</span>
          <span class="bold up">合计 {{ fmtMoney(filteredSum) }}</span>
        </div>
      </div>
      </template>
    </div>

    <!-- 登记 / 编辑 -->
    <van-popup v-model:show="show" position="bottom" round>
      <div class="sheet-body">
        <div class="sheet-title">{{ form.id ? '编辑' : '登记' }}其他开支</div>
        <van-cell-group inset>
          <van-field v-model="form.category" label="费用类型" placeholder="如 网线费 / 安装费 / 机器费 / 样品费" />
          <van-field v-model="form.amount" type="number" label="金额" placeholder="0.00">
            <template #button><span class="muted">元</span></template>
          </van-field>
          <van-field v-model="form.date" label="日期" type="date" />
          <OperatorField v-model="form.operator" />
          <PayStatusField v-model="form.pay_status" hint="待付款：登记后先进「待付款账单」，点「已支付」才计入期间费用" />
          <AttachmentField v-model="form.remark" placeholder="可留空，如收款方 / 用途（支持图片 / 附件）" />
        </van-cell-group>
        <template v-if="presets.length">
          <div class="muted" style="padding:0 4px 6px;">常用类型（点选填入）</div>
          <div class="row wrap" style="gap:6px;padding:0 4px 8px;">
            <van-tag
              v-for="c in presets"
              :key="c"
              :type="form.category === c ? 'primary' : 'default'"
              :plain="form.category !== c"
              size="medium"
              @click="form.category = c"
            >{{ c }}</van-tag>
          </div>
        </template>
        <div class="muted" style="padding:0 4px 8px;">保存后计入财务报表「期间费用」，并从毛利中扣减得到净利。</div>
        <div class="sheet-foot">
          <van-button block plain @click="show = false">取消</van-button>
          <van-button block type="primary" :loading="saving" @click="save">保存</van-button>
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
import OperatorField from '../components/OperatorField.vue'
import PayStatusField from '../components/PayStatusField.vue'
import AttachmentField from '../components/AttachmentField.vue'
import RemarkView from '../components/RemarkView.vue'
import { fmtMoney, num, todayStr, monthStartStr, daysAgoStr } from '../utils/format'
import { ensureUserName } from '../utils/user'

const router = useRouter()
function goBack() {
  if (window.history.length > 1) router.back()
  else router.replace('/mine')
}

const QUICKS = [
  { key: 'today', label: '今天' },
  { key: 'week', label: '近7天' },
  { key: 'month', label: '本月' },
  { key: 'lastmonth', label: '上月' },
  { key: 'all', label: '全部' },
]
const PANELS = [
  { key: 'day', label: '按日' },
  { key: 'month', label: '按月' },
  { key: 'cat', label: '按类型' },
]

const df = ref(monthStartStr())
const dt = ref(todayStr())
const quickKey = ref('month')
const oeTab = ref('stat')    // stat 统计 / list 明细
const panel = ref('day')
const stats = ref({})
const rows = ref([])
const kw = ref('')
const show = ref(false)
const saving = ref(false)
const form = reactive({ id: null, category: '', amount: '', date: todayStr(), operator: '', remark: '', pay_status: 'paid' })

const presets = computed(() => stats.value.presets || [])
const topCatText = computed(() => {
  const t = (stats.value.by_category || [])[0]
  return t ? `${t.category} ${fmtMoney(t.amount)}` : '—'
})
const filteredRows = computed(() => {
  const s = (kw.value || '').trim().toLowerCase()
  if (!s) return rows.value
  return rows.value.filter((r) =>
    [r.category, r.remark, r.operator, r.date].join(' ').toLowerCase().includes(s)
  )
})
const filteredSum = computed(() => filteredRows.value.reduce((a, r) => a + num(r.amount), 0))
const maxDay = computed(() => Math.max(1, ...(stats.value.by_day || []).map((d) => num(d.amount))))
const barW = (v) => Math.max(3, Math.round((num(v) / maxDay.value) * 100)) + '%'
const pctOf = (v) => (num(stats.value.range_total) ? (num(v) / num(stats.value.range_total)) * 100 : 0)

/** 环比：by_month 为倒序，下一项即上一个月 */
function mom(i) {
  const list = stats.value.by_month || []
  const cur = list[i]
  const prev = list[i + 1]
  if (!cur || !prev || !num(prev.amount)) return null
  return ((num(cur.amount) - num(prev.amount)) / num(prev.amount)) * 100
}
function momText(i) {
  const d = mom(i)
  return d == null ? '—' : `${d >= 0 ? '+' : ''}${d.toFixed(1)}%`
}

function lastMonthRange() {
  const n = new Date()
  const f = (x) => `${x.getFullYear()}-${String(x.getMonth() + 1).padStart(2, '0')}-${String(x.getDate()).padStart(2, '0')}`
  return [f(new Date(n.getFullYear(), n.getMonth() - 1, 1)), f(new Date(n.getFullYear(), n.getMonth(), 0))]
}

async function load() {
  const qs = `date_from=${df.value || ''}&date_to=${dt.value || ''}`
  try {
    const [s, list] = await Promise.all([
      api(`/api/other-expenses/stats?${qs}`),
      api(`/api/other-expenses?${qs}`),
    ])
    stats.value = s || {}
    rows.value = list || []
  } catch (e) { showToast(e.message || '加载失败') }
}

function quick(kind) {
  quickKey.value = kind
  const t = todayStr()
  if (kind === 'today') { df.value = t; dt.value = t }
  else if (kind === 'week') { df.value = daysAgoStr(6); dt.value = t }
  else if (kind === 'month') { df.value = monthStartStr(); dt.value = t }
  else if (kind === 'lastmonth') { const [a, b] = lastMonthRange(); df.value = a; dt.value = b }
  else { df.value = ''; dt.value = '' }
  load()
}

async function openForm(r) {
  if (r) {
    Object.assign(form, {
      id: r.id, category: r.category, amount: r.amount, date: r.date, remark: r.remark || '', operator: '',
      pay_status: r.pay_status === 'unpaid' ? 'unpaid' : 'paid',
    })
  } else {
    Object.assign(form, {
      id: null, category: '', amount: '', date: dt.value || todayStr(), remark: '', operator: '', pay_status: 'paid',
    })
  }
  form.operator = await ensureUserName()
  show.value = true
}

async function save() {
  const category = (form.category || '').trim()
  if (!category) { showToast('请填写费用类型'); return }
  if (!(num(form.amount) > 0)) { showToast('金额必须大于 0'); return }
  if (!form.date) { showToast('请选择日期'); return }
  saving.value = true
  const editing = !!form.id
  try {
    const body = {
      category, amount: num(form.amount), date: form.date, remark: (form.remark || '').trim(),
      pay_status: form.pay_status,   // paid 已付款（默认）/ unpaid 待付款
    }
    if (editing) await api(`/api/other-expenses/${form.id}`, 'PUT', body)
    else await api('/api/other-expenses', 'POST', body)
    // 该日期若不在当前统计区间内，自动扩区间，避免"登记了却看不到"
    if (df.value && form.date < df.value) df.value = form.date
    if (dt.value && form.date > dt.value) dt.value = form.date
    showToast((editing ? '已保存修改' : '已登记') + (form.pay_status === 'unpaid' ? '（待付款，已进待付款账单）' : ''))
    show.value = false
    await load()
  } catch (e) { showToast(e.message || '保存失败') }
  saving.value = false
}

async function delRow(r) {
  try { await showConfirmDialog({ title: '删除开支', message: `确认删除 ${r.date}「${r.category}」${fmtMoney(r.amount)}？` }) } catch (e) { return }
  try {
    await api(`/api/other-expenses/${r.id}`, 'DELETE')
    showToast('已删除')
    load()
  } catch (e) { showToast(e.message || '删除失败') }
}

onMounted(load)
</script>

<style scoped>
.sub-page { min-height: 100vh; background: #f7f8fa; }
.bar-row { display: flex; align-items: center; gap: 8px; padding: 4px 0; }
.bar-x { width: 44px; flex: none; font-size: 11px; color: #969799; font-variant-numeric: tabular-nums; }
.bar-track { flex: 1; height: 14px; background: #f2f3f5; border-radius: 7px; overflow: hidden; display: block; }
.bar-fill { display: block; height: 100%; background: #ee0a24; border-radius: 7px; min-width: 3px; }
.bar-val { width: 84px; flex: none; text-align: right; font-size: 12px; color: #ee0a24; font-variant-numeric: tabular-nums; }
</style>
