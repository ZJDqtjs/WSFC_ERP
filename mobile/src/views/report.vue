<template>
  <div class="sub-page">
    <van-nav-bar title="财务报表" left-arrow fixed placeholder @click-left="goBack" />
    <div style="padding:12px;">
      <!-- 查询条件 -->
      <div class="card">
        <div class="row wrap" style="gap:6px;">
          <van-field v-model="df" type="date" placeholder="起" style="max-width:132px;background:#f7f8fa;border-radius:6px;padding:6px 10px;" />
          <van-field v-model="dt" type="date" placeholder="止" style="max-width:132px;background:#f7f8fa;border-radius:6px;padding:6px 10px;" />
          <van-button size="small" type="primary" @click="load">查询</van-button>
        </div>
        <div class="seg" style="margin:8px 0 0;">
          <div class="seg-item" :class="{ active: quickKey === 'today' }" @click="quick('today')">今天</div>
          <div class="seg-item" :class="{ active: quickKey === 'month' }" @click="quick('month')">本月</div>
          <div class="seg-item" :class="{ active: quickKey === 'all' }" @click="quick('all')">全部</div>
        </div>
      </div>

      <!-- 分区 tab：一次只看一类，避免把多天/多月的记录竖向堆在一页 -->
      <div class="seg">
        <div class="seg-item" :class="{ active: tab === 'summary' }" @click="tab = 'summary'">汇总</div>
        <div class="seg-item" :class="{ active: tab === 'expense' }" @click="tab = 'expense'">支出</div>
        <div class="seg-item" :class="{ active: tab === 'goods' }" @click="tab = 'goods'">商品</div>
        <div class="seg-item" :class="{ active: tab === 'flow' }" @click="tab = 'flow'">流水</div>
      </div>

      <!-- 汇总 -->
      <template v-if="tab === 'summary'">
      <div class="stat-grid" style="margin-bottom:12px;">
        <div class="stat accent"><div class="label">销售收入</div><div class="value">{{ fmtMoney(rep.revenue) }}</div><div class="sub">{{ rep.order_count || 0 }} 单</div></div>
        <div class="stat warn"><div class="label">结转成本</div><div class="value">{{ fmtMoney(rep.cogs) }}</div><div class="sub">含关联结算 {{ fmtMoney(rep.pack_cost_total) }}</div></div>
        <div class="stat success"><div class="label">毛利</div><div class="value">{{ fmtMoney(rep.gross_profit) }}</div><div class="sub">{{ rep.revenue ? ((rep.gross_profit / rep.revenue) * 100).toFixed(1) + '%' : '—' }}</div></div>
        <div class="stat danger"><div class="label">期间费用</div><div class="value">{{ fmtMoney(rep.expense) }}</div><div class="sub">其他开支 {{ fmtMoney(rep.other_expense) }} · 手工 {{ fmtMoney(rep.manual_expense) }}</div></div>
        <div class="stat" :class="rep.net_profit >= 0 ? 'success' : 'danger'"><div class="label">净利润</div><div class="value">{{ fmtMoney(rep.net_profit) }}</div></div>
        <div class="stat"><div class="label">本期进货</div><div class="value">{{ fmtMoney(rep.purchase) }}</div></div>
        <div class="stat danger"><div class="label">本期总支出</div><div class="value">{{ fmtMoney(rep.total_expense) }}</div><div class="sub">含采购 {{ fmtMoney(rep.purchase) }}</div></div>
      </div>
      <div class="stat-grid cols2" style="margin-bottom:12px;">
        <div class="stat accent"><div class="label">当前库存总值</div><div class="value">{{ fmtMoney(rep.stock_value) }}</div></div>
        <div class="stat"><div class="label">本期入库单数</div><div class="value">{{ rep.inbound_count || 0 }}</div></div>
      </div>

      <!-- 销售成本构成 -->
      <div class="card">
        <div class="card-title"><span class="grow">销售成本构成</span><span class="muted">{{ rep.cogs ? '合计 ' + fmtMoney(rep.cogs) : '' }}</span></div>
        <div v-if="!rep.cogs" class="empty">本期无销售成本</div>
        <template v-else>
          <div class="cost-stack">
            <span
              v-for="(r, i) in costRows.filter((x) => x.value > 0)"
              :key="i"
              :style="{ width: pctOf(r.value) + '%', background: r.color }"
            ></span>
          </div>
          <div v-for="(r, i) in costRows" :key="i" class="list-item">
            <div class="row">
              <span class="dot" :style="{ background: r.color }"></span>
              <span class="grow item-title">
                {{ r.name }}
                <van-tag v-if="r.tag" type="warning" plain style="margin-left:4px;">{{ r.tag }}</van-tag>
              </span>
              <span class="bold">{{ fmtMoney(r.value) }}</span>
            </div>
            <div class="item-meta">
              {{ pctOf(r.value).toFixed(1) }}% · {{ r.tag ? '出库时按包装清单自动结算，已计入结转成本' : '销售商品本身的先进先出成本' }}
            </div>
          </div>
          <div class="divider"></div>
          <div class="row">
            <span class="grow bold">结转成本合计</span>
            <span class="bold">{{ fmtMoney(rep.cogs) }}</span>
          </div>
          <div v-if="!rep.pack_cost_total" class="alert warn">
            本期没有包材 / 人工 / 快递等关联结算成本。若商品已配置包装清单，请确认出库时是否生成了关联结算行。
          </div>
        </template>
      </div>

      </template>

      <!-- 支出（期间费用 = 其他开支 + 手工记账） -->
      <template v-else-if="tab === 'expense'">
      <div class="card">
        <div class="card-title">
          <span class="grow">支出</span>
          <span class="bold up">{{ fmtMoney(rep.total_expense) }}</span>
        </div>
        <div class="muted" style="margin-bottom:8px;">
          采购 {{ fmtMoney(rep.purchase) }} + 其他开支 {{ fmtMoney(rep.other_expense) }} + 手工记账 {{ fmtMoney(rep.manual_expense) }}；
          其中期间费用 {{ fmtMoney(rep.expense) }} 从毛利中扣减（采购已计入结转成本，不重复扣）
        </div>
        <div v-if="staleApi" class="alert warn" style="margin-bottom:8px;">
          明细数据缺失：后端未返回「按日 / 按月支出明细」或缺少采购字段，说明后端服务还是旧版本，请更新并重启后端后刷新。
        </div>
        <div class="seg" style="margin-bottom:8px;">
          <div class="seg-item" :class="{ active: expTab === 'cat' }" @click="expTab = 'cat'">按类型</div>
          <div class="seg-item" :class="{ active: expTab === 'day' }" @click="expTab = 'day'">按日</div>
          <div class="seg-item" :class="{ active: expTab === 'month' }" @click="expTab = 'month'">按月</div>
        </div>

        <!-- 按类型：其他开支 + 手工记账 -->
        <template v-if="expTab === 'cat'">
          <div v-if="!rep.purchase && !Object.keys(rep.other_expenses || {}).length && !Object.keys(rep.manual_fees || {}).length" class="empty">本期无支出</div>
          <div v-if="rep.purchase" class="muted" style="margin:4px 0;">采购支出（进货）</div>
          <div v-if="rep.purchase" class="list-item">
            <div class="row">
              <van-tag type="primary" plain>采购支出</van-tag>
              <span class="grow"></span>
              <span class="bold up">{{ fmtMoney(rep.purchase) }}</span>
            </div>
          </div>
          <div v-if="Object.keys(rep.other_expenses || {}).length" class="muted" style="margin:8px 0 4px;">其他开支（网线费 / 安装费 / 机器费 / 样品费…）</div>
          <div v-for="(v, k) in rep.other_expenses || {}" :key="'o' + k" class="list-item">
            <div class="row">
              <van-tag type="danger" plain>{{ k }}</van-tag>
              <span class="grow"></span>
              <span class="bold up">{{ fmtMoney(v) }}</span>
            </div>
          </div>
          <div v-if="Object.keys(rep.manual_fees || {}).length" class="muted" style="margin:8px 0 4px;">手工记账（财务流水中的支出）</div>
          <div v-for="(v, k) in rep.manual_fees || {}" :key="'m' + k" class="list-item">
            <div class="row">
              <van-tag plain>{{ k }}</van-tag>
              <span class="grow"></span>
              <span class="bold up">{{ fmtMoney(v) }}</span>
            </div>
          </div>
        </template>

        <!-- 按日 -->
        <template v-else-if="expTab === 'day'">
          <div v-if="!expDays.length" class="empty">本期无支出</div>
          <div v-for="d in expDays" :key="d.date" class="list-item">
            <div class="row">
              <span class="grow item-title">{{ d.date }}</span>
              <span class="bold up">{{ fmtMoney(d.total) }}</span>
            </div>
            <div class="item-meta">
              采购 {{ fmtMoney(d.purchase) }} · 其他开支 {{ fmtMoney(d.other_expense) }} · 手工记账 {{ fmtMoney(d.manual_expense) }} · {{ d.count }} 笔
            </div>
            <div class="exp-track" style="margin-top:6px;"><span class="exp-fill" :style="{ width: pctOfExp(d.total) + '%' }" /></div>
          </div>
          <div v-if="expDayTruncated" class="muted">共有 {{ (rep.expense_by_day || []).length }} 天支出，仅显示最近 {{ MAX_EXP_DAYS }} 天</div>
        </template>

        <!-- 按月 -->
        <template v-else>
          <div v-if="!(rep.expense_by_month || []).length" class="empty">本期无支出</div>
          <div v-for="(m, i) in rep.expense_by_month || []" :key="m.month" class="list-item">
            <div class="row">
              <span class="grow item-title">{{ m.month }}</span>
              <span class="bold up">{{ fmtMoney(m.total) }}</span>
            </div>
            <div class="item-meta">
              采购 {{ fmtMoney(m.purchase) }} · 其他开支 {{ fmtMoney(m.other_expense) }} · 手工记账 {{ fmtMoney(m.manual_expense) }} · {{ m.count }} 笔
              <template v-if="expMomText(i) !== '—'"> · 环比 <b :class="expMom(i) >= 0 ? 'up' : 'down'">{{ expMomText(i) }}</b></template>
            </div>
          </div>
        </template>

        <div class="divider"></div>
        <div class="row">
          <span class="grow bold">支出合计（采购＋其他＋手工）</span>
          <span class="bold up">{{ fmtMoney(rep.total_expense) }}</span>
        </div>
        <div class="row" style="margin-top:2px;">
          <span class="grow muted">其中期间费用（从毛利中扣减，采购已计入结转成本）</span>
          <span class="muted">{{ fmtMoney(rep.expense) }}</span>
        </div>
        <div class="row" style="margin-top:8px;">
          <span class="grow"></span>
          <van-button size="mini" plain type="primary" @click="$router.push('/otherexp')">去登记其他开支</van-button>
        </div>
      </div>
      </template>

      <!-- 商品 -->
      <template v-else-if="tab === 'goods'">
      <div class="card">
        <div class="card-title">
          <span class="grow">商品销售明细</span>
          <span class="muted">成本为总成本</span>
        </div>
        <div v-if="!(rep.by_product || []).length" class="empty">本期无销售</div>
        <div v-for="p in rep.by_product || []" :key="p.product_id" class="list-item">
          <div class="row">
            <span class="grow item-title">{{ p.name }}</span>
            <span class="bold">{{ fmtMoney(p.amount) }}</span>
          </div>
          <div class="item-meta">销量 {{ fmtNum(p.qty) }}</div>
          <div class="item-meta">
            总成本 {{ fmtMoney(totalCogsOf(p)) }} · 毛利
            <b :class="grossProfitOf(p) >= 0 ? 'up' : 'down'">{{ fmtMoney(grossProfitOf(p)) }}</b>
            · 毛利率
            <b :class="grossProfitOf(p) >= 0 ? 'up' : 'down'">{{ gpRateText(p) }}</b>
          </div>
          <div v-if="p.pack_cogs || p.express_cogs" class="item-meta cost-split">
            商品成本 {{ fmtMoney(p.goods_cogs != null ? p.goods_cogs : p.cogs) }}<template v-if="p.pack_cogs"> ＋ 打包人工+耗材 {{ fmtMoney(p.pack_cogs) }}</template><template v-if="p.express_cogs"> ＋ 快递费 {{ fmtMoney(p.express_cogs) }}</template>
          </div>
        </div>
      </div>
      </template>

      <!-- 流水 -->
      <template v-else>
      <div class="card">
        <div class="card-title">
          <span class="grow">财务流水</span>
          <van-button size="mini" plain type="primary" icon="plus" @click="openFinance">手动记账</van-button>
        </div>
        <van-field v-model="fkw" placeholder="筛选分类 / 商品 / 备注 / 操作员" style="background:#f7f8fa;border-radius:6px;" />
        <div v-if="!financeFiltered.length" class="empty">本期无财务流水</div>
        <div v-for="f in financeFiltered" :key="f.id" class="list-item">
          <div class="row">
            <van-tag :type="f.type === 'income' ? 'success' : 'danger'" plain>{{ f.type === 'income' ? '收入' : '支出' }}</van-tag>
            <span class="grow item-title" style="margin-left:6px;">{{ f.category }}</span>
            <span :class="f.type === 'income' ? 'down' : 'up'">{{ f.type === 'income' ? '+' : '-' }}{{ fmtMoney(f.amount) }}</span>
          </div>
          <div class="item-meta">
            {{ f.date }}{{ f.product_name ? ' · ' + f.product_name : '' }}{{ f.operator ? ' · ' + f.operator : '' }}
            <template v-if="f.ref_type !== 'manual'"> · 单据自动生成</template>
          </div>
          <div v-if="f.remark" class="item-meta">{{ f.remark }}</div>
          <div v-if="f.ref_type === 'manual'" class="row" style="margin-top:6px;">
            <van-button size="mini" plain type="danger" @click="delFinance(f)">删除</van-button>
          </div>
        </div>
      </div>
      </template>
    </div>

    <!-- 手动记账 -->
    <van-popup v-model:show="finShow" position="bottom" round>
      <div class="sheet-body">
        <div class="sheet-title">手动记账</div>
        <van-cell-group inset>
          <van-field label="类型">
            <template #input>
              <van-radio-group v-model="fin.type" direction="horizontal">
                <van-radio name="expense">支出</van-radio>
                <van-radio name="income">收入</van-radio>
              </van-radio-group>
            </template>
          </van-field>
          <van-field v-model="fin.category" label="分类" placeholder="如 人工费 / 房租 / 其他支出" />
          <van-field v-model="fin.amount" type="number" label="金额" placeholder="0.00" />
          <van-field v-model="fin.date" label="日期" type="date" />
          <OperatorField v-model="fin.operator" />
          <van-field v-model="fin.remark" label="备注" placeholder="可留空" />
        </van-cell-group>
        <div class="sheet-foot">
          <van-button block plain @click="finShow = false">取消</van-button>
          <van-button block type="primary" :loading="finSaving" @click="submitFinance">保存</van-button>
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
import { fmtMoney, fmtNum, num, todayStr } from '../utils/format'
import { userName, ensureUserName } from '../utils/user'

const router = useRouter()
function goBack() {
  if (window.history.length > 1) router.back()
  else router.replace('/mine')
}

const df = ref(todayStr())
const dt = ref(todayStr())
const quickKey = ref('today')
const rep = ref({})
const finance = ref([])
const fkw = ref('')
let inited = false

const COST_COLORS = { 包材耗材: '#ff976a', 人工打包费: '#7232dd', 快递运费: '#07c160', 其他关联结算: '#969799' }
const pctOf = (v) => (rep.value.cogs ? (v / rep.value.cogs) * 100 : 0)

// 商品总成本：后端 by_product.total_cogs（商品成本 + 打包人工/耗材 + 快递费），
// 旧版后端不返回该字段，回退到 cogs（此时等于商品本身成本），避免整列显示成 ¥0.00
const totalCogsOf = (p) => num(p.total_cogs != null ? p.total_cogs : p.cogs)
const grossProfitOf = (p) => num(p.amount) - totalCogsOf(p)

// 毛利率分母用扣点前销售金额（gross_sales），无值时回退实收金额——与出库批次页口径一致
function gpRateText(p) {
  const denom = num(p.gross_sales) || num(p.amount)
  if (!denom) return '—'
  const rate = p.gp_rate != null ? num(p.gp_rate) : (grossProfitOf(p) / denom) * 100
  return rate.toFixed(1) + '%'
}

const costRows = computed(() => {
  const goods = rep.value.goods_cogs != null ? rep.value.goods_cogs : num(rep.value.cogs) - num(rep.value.pack_cost_total)
  const packs = rep.value.pack_costs || {}
  const rows = [{ name: '商品成本', value: goods, color: '#1989fa', tag: '' }]
  Object.entries(packs)
    .sort((a, b) => b[1] - a[1])
    .forEach(([k, v]) => rows.push({ name: k, value: v, color: COST_COLORS[k] || '#969799', tag: '自动结算' }))
  return rows
})

/* ---------- 报表分区 tab（汇总 / 支出 / 商品 / 流水）与支出子页签 ---------- */
const tab = ref('summary')
const expTab = ref('cat')   // cat 按类型 / day 按日 / month 按月
const MAX_EXP_DAYS = 90
const expDays = computed(() => (rep.value.expense_by_day || []).slice(0, MAX_EXP_DAYS))
const expDayTruncated = computed(() => (rep.value.expense_by_day || []).length > MAX_EXP_DAYS)

/** 后端未更新时（没返回逐日/逐月明细，或行内缺少采购字段）给出明确提示 */
const staleApi = computed(() =>
  !Array.isArray(rep.value.expense_by_day) || !Array.isArray(rep.value.expense_by_month)
  || (rep.value.expense_by_day || []).some((r) => r.purchase == null)
)

/** 单日/单月支出占本期「全部支出（含采购）」的百分比（用于占比条） */
function pctOfExp(v) {
  const t = num(rep.value.total_expense)
  return t ? Math.min(100, (num(v) / t) * 100).toFixed(1) : '0.0'
}

/** 环比：expense_by_month 为倒序，下一项即上一个月 */
function expMom(i) {
  const list = rep.value.expense_by_month || []
  const cur = list[i]
  const prev = list[i + 1]
  if (!cur || !prev || !num(prev.total)) return null
  return ((num(cur.total) - num(prev.total)) / num(prev.total)) * 100
}
function expMomText(i) {
  const d = expMom(i)
  return d == null ? '—' : `${d >= 0 ? '+' : ''}${d.toFixed(1)}%`
}

const financeFiltered = computed(() => {
  const s = (fkw.value || '').trim().toLowerCase()
  if (!s) return finance.value
  return finance.value.filter((f) =>
    [f.category, f.product_name, f.remark, f.operator, f.type].join(' ').toLowerCase().includes(s)
  )
})

async function load() {
  try {
    const [r1, r2] = await Promise.all([
      api(`/api/report/summary?date_from=${df.value}&date_to=${dt.value}`),
      api(`/api/finance?date_from=${df.value}&date_to=${dt.value}`),
    ])
    rep.value = r1
    finance.value = r2
    inited = true
  } catch (e) { showToast(e.message || '加载失败') }
}

function quick(kind) {
  quickKey.value = kind
  if (kind === 'today') { df.value = todayStr(); dt.value = todayStr() }
  else if (kind === 'month') { df.value = todayStr().slice(0, 8) + '01'; dt.value = todayStr() }
  else { df.value = ''; dt.value = '' }
  load()
}

/* ---------- 手动记账 ---------- */
const finShow = ref(false)
const finSaving = ref(false)
const fin = reactive({ type: 'expense', category: '其他支出', amount: '', date: todayStr(), operator: '', remark: '' })

async function openFinance() {
  fin.type = 'expense'
  fin.category = '其他支出'
  fin.amount = ''
  fin.date = dt.value || todayStr()
  fin.operator = await ensureUserName()   // 操作员固定为当前登录账号
  fin.remark = ''
  finShow.value = true
}

async function submitFinance() {
  if (!(num(fin.amount) > 0)) { showToast('金额必须大于 0'); return }
  finSaving.value = true
  try {
    await api('/api/finance', 'POST', {
      type: fin.type,
      category: fin.category.trim() || (fin.type === 'income' ? '销售收入' : '其他支出'),
      amount: num(fin.amount),
      date: fin.date,
      operator: fin.operator || userName.value,
      remark: fin.remark,
    })
    showToast('已记账')
    finShow.value = false
    load()
  } catch (e) { showToast(e.message || '保存失败') }
  finSaving.value = false
}

async function delFinance(f) {
  try { await showConfirmDialog({ title: '删除财务记录', message: `确认删除 ${f.date} ${f.category} ${fmtMoney(f.amount)}？` }) } catch (e) { return }
  try {
    await api(`/api/finance/${f.id}`, 'DELETE')
    showToast('已删除')
    load()
  } catch (e) { showToast(e.message || '删除失败') }
}

onMounted(() => { if (!inited) load() })
</script>

<style scoped>
.sub-page { min-height: 100vh; background: #f7f8fa; }
.cost-stack { display: flex; height: 12px; border-radius: 6px; overflow: hidden; background: #f2f3f5; margin-bottom: 10px; }
.dot { width: 8px; height: 8px; border-radius: 50%; display: inline-block; margin-right: 6px; flex-shrink: 0; }
.cost-split { color: #969799; font-size: 11px; }
.exp-track { height: 6px; background: #f2f3f5; border-radius: 3px; overflow: hidden; display: block; }
.exp-fill { display: block; height: 100%; background: #f97316; border-radius: 3px; min-width: 2px; }
.alert { border-radius: 8px; padding: 8px 10px; font-size: 12px; margin-top: 8px; }
.alert.warn { background: #fffbe8; color: #ed6a0c; }
</style>
