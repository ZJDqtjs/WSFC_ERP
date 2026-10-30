<template>
  <div class="sub-page">
    <van-nav-bar title="广告利润" left-arrow fixed placeholder @click-left="goBack" />
    <div style="padding:12px;">
      <!-- 区间 / 口径 -->
      <div class="card">
        <div class="row wrap" style="gap:6px;">
          <van-field v-model="df" type="date" style="max-width:132px;background:#f7f8fa;border-radius:6px;padding:6px 10px;" />
          <van-field v-model="dt" type="date" style="max-width:132px;background:#f7f8fa;border-radius:6px;padding:6px 10px;" />
          <van-button size="small" type="primary" @click="quickKey = ''; load()">查询</van-button>
        </div>
        <div class="seg" style="margin:8px 0 0;">
          <div class="seg-item" :class="{ active: quickKey === 'today' }" @click="quick('today')">今天</div>
          <div class="seg-item" :class="{ active: quickKey === 'month' }" @click="quick('month')">本月</div>
          <div class="seg-item" :class="{ active: quickKey === 'lastmonth' }" @click="quick('lastmonth')">上月</div>
        </div>

        <div class="seg" style="margin:10px 0 0;">
          <div class="seg-item" :class="{ active: scope === 'all' }" @click="setScope('all')">全仓总览</div>
          <div class="seg-item" :class="{ active: scope === 'one' }" @click="setScope('one')">当前分仓</div>
        </div>

        <div class="row" style="margin-top:10px;gap:8px;align-items:center;">
          <span class="grow" style="font-size:13px;">排除其他收支</span>
          <span class="muted" style="font-size:12px;">与财务报表口径一致</span>
          <van-switch v-model="excludeOther" size="20" @update:model-value="load()" />
        </div>

        <div class="row wrap" style="gap:8px;margin-top:10px;">
          <van-button size="small" plain :loading="loading" @click="load(true)">刷新广告缓存</van-button>
        </div>
        <div class="muted" style="font-size:12px;margin-top:8px;line-height:1.5;">{{ rangeHint }}</div>
      </div>

      <!-- 概览 -->
      <div class="card">
        <div class="card-title">
          <span class="grow">利润概览</span>
          <span class="muted" style="font-size:11px;font-weight:400;">{{ generatedAt }}</span>
        </div>
        <div v-if="loading" class="empty">加载中…</div>
        <template v-else>
          <div class="stat-grid cols2">
            <div class="stat accent"><div class="label">{{ pre }}销售收入</div><div class="value">{{ fmtMoney(erp.revenue) }}</div><div class="sub">{{ erp.order_count || 0 }} 单</div></div>
            <div class="stat success"><div class="label">{{ pre }}毛利（广告前）</div><div class="value">{{ fmtMoney(profit.gross_before_ads) }}</div><div class="sub">毛利率 {{ pctOf(profit.gross_before_ads) }}</div></div>
            <div class="stat danger"><div class="label">CPS 花费</div><div class="value">{{ fmtMoney(profit.cps_total) }}</div><div class="sub">付款佣金</div></div>
            <div class="stat danger"><div class="label">京准通花费</div><div class="value">{{ fmtMoney(profit.jzt_total) }}</div><div class="sub">投放花费</div></div>
            <div class="stat warn"><div class="label">广告费合计</div><div class="value">{{ fmtMoney(profit.ads_total) }}</div><div class="sub">占收入 {{ pctOf(profit.ads_total) }}</div></div>
            <div class="stat" :class="num(profit.gross_after_ads) >= 0 ? 'success' : 'danger'">
              <div class="label">{{ pre }}毛利（广告后）</div>
              <div class="value">{{ fmtMoney(profit.gross_after_ads) }}</div>
              <div class="sub">毛利 − 广告费</div>
            </div>
            <div class="stat danger"><div class="label">{{ pre }}净利（广告前）</div><div class="value">{{ fmtMoney(profit.net_before_ads) }}</div><div class="sub">净利率 {{ pctOf(profit.net_before_ads) }}</div></div>
            <div class="stat" :class="num(profit.net_after_ads) >= 0 ? 'success' : 'danger'">
              <div class="label">{{ pre }}净利（广告后）</div>
              <div class="value">{{ fmtMoney(profit.net_after_ads) }}</div>
              <div class="sub">净利率 {{ pctOf(profit.net_after_ads) }}</div>
            </div>
          </div>
          <div v-if="warnings.length" class="alert warn" style="margin-top:8px;">
            <div v-for="(w, i) in warnings" :key="i">⚠ {{ w }}</div>
          </div>
          <div v-if="!(summary.ads || {}).service_ok && summary.generated_at" class="alert warn" style="margin-top:8px;">
            ⚠ 广告数据读取异常，广告费按 0 计入
          </div>
        </template>
      </div>

      <!-- 利润桥 -->
      <div class="card">
        <div class="card-title">广告前后利润桥</div>
        <div class="muted" style="font-size:12px;margin-bottom:6px;">口径 = 财务报表（本页只额外扣减广告费，不改动原报表）</div>
        <div v-for="b in bridge" :key="b.name" class="bridge-row">
          <span class="grow" :class="{ bold: b.bold }">{{ b.name }}</span>
          <span class="mono" :class="[b.bold ? 'bold' : '', num(b.value) >= 0 ? 'down' : 'up']">{{ fmtMoney(b.value) }}</span>
          <span class="muted mono" style="width:64px;text-align:right;">{{ pctOf(b.value) }}</span>
        </div>
      </div>

      <!-- 按店铺账号 -->
      <div class="card">
        <div class="card-title">按店铺账号的广告费</div>
        <div class="muted" style="font-size:12px;margin-bottom:6px;">来自挂载服务「花费一览」的本地缓存（一次抓取 = 一个账号 + 一个区间）</div>
        <div v-if="!accounts.length" class="empty">所选区间没有可用的花费缓存</div>
        <div v-for="a in accounts" :key="a.label" class="list-item">
          <div class="row">
            <span class="grow bold">{{ a.label }}</span>
            <span class="bold up">{{ fmtMoney(a.total) }}</span>
          </div>
          <div class="item-meta">CPS {{ fmtMoney(a.cps) }} · 京准通 {{ fmtMoney(a.jzt) }} · 覆盖 {{ a.covered }} 天</div>
          <div v-if="a.gaps" class="item-meta" style="color:#ed6a0c;">缺口：{{ a.gaps }}</div>
        </div>
        <div class="muted" style="font-size:12px;margin-top:8px;line-height:1.5;">
          缓存只能按账号 + 区间整段读取：所选区间拼不满的日期会列在「缺口」里且不计入广告费，此时广告费会被低估，请到挂载服务按该区间补抓一次。
        </div>
      </div>

      <!-- 按 SKU 明细 -->
      <div class="card">
        <div class="card-title">按 SKU 明细</div>
        <div class="muted" style="font-size:12px;line-height:1.5;">{{ skuStat }}</div>

        <div class="row wrap" style="gap:8px;align-items:center;margin:10px 0 6px;">
          <select v-model="skuSort" class="pick">
            <option value="ads">按广告费</option>
            <option value="revenue">按销售额</option>
            <option value="gross">按广告前毛利</option>
            <option value="gross_after">按广告后毛利</option>
          </select>
          <van-switch v-model="onlyAds" size="18" />
          <span class="muted" style="font-size:12px;">只看有广告费</span>
        </div>
        <van-search v-model="skuKw" placeholder="搜索 SKU / 商品名称" shape="round" />

        <div v-if="skuLoading" class="empty">按 SKU 加载中…</div>
        <template v-else>
          <div v-if="!skuShown.length" class="empty">
            {{ skuKw || onlyAds ? '没有符合条件的 SKU' : '所选区间没有可用的 SKU 数据' }}
          </div>
          <div v-for="r in skuShown" :key="r.source + '-' + r.sku + '-' + r.name" class="sku-item">
            <div class="row">
              <span class="grow sku-name">{{ r.name || '—' }}</span>
              <van-tag v-if="r.source === 'profit'" type="warning" plain>入仓品</van-tag>
              <van-tag v-else-if="r.ad_only" type="danger" plain>未匹配 ERP</van-tag>
              <van-tag v-else-if="r.no_code" plain>未填编码</van-tag>
            </div>
            <div class="item-meta mono">{{ r.sku || '—' }}{{ r.qty ? ` · ${fmtNum(r.qty)}${r.unit || ''}` : '' }}</div>
            <div class="sku-metrics">
              <span>销售额 <b>{{ fmtMoney(r.revenue) }}</b></span>
              <span>广告前毛利 <b>{{ fmtMoney(r.gross_before) }}</b></span>
              <span>CPS <b>{{ fmtMoney(r.cps) }}</b></span>
              <span>京准通 <b>{{ fmtMoney(r.jzt) }}</b></span>
              <span>广告费 <b>{{ fmtMoney(r.ads_total) }}</b></span>
              <span>广告后 <b :class="num(r.gross_after) >= 0 ? 'down' : 'up'">{{ fmtMoney(r.gross_after) }}</b></span>
              <span class="muted">费率 {{ r.ad_rate == null ? '—' : (num(r.ad_rate) * 100).toFixed(1) + '%' }} · ROI {{ r.roi == null ? '—' : num(r.roi).toFixed(2) }}</span>
            </div>
          </div>

          <div v-if="skuRows.length" class="sku-total">
            <div class="row">
              <span class="grow bold">合计 {{ skuRows.length }} 个 SKU</span>
              <span class="bold">{{ fmtMoney(skuTotals.ads_total) }}</span>
            </div>
            <div class="muted" style="font-size:12px;line-height:1.5;">
              销售额 {{ fmtMoney(skuTotals.revenue_total != null ? skuTotals.revenue_total : skuTotals.erp_revenue) }}
              · 广告前毛利 {{ fmtMoney(skuTotals.gross_before) }}
              · 广告费 {{ fmtMoney(skuTotals.ads_total) }}
              · 广告后 {{ fmtMoney(skuTotals.gross_after) }}
            </div>
            <div v-if="num(skuTotals.warehouse_sku_count)" class="muted" style="font-size:12px;line-height:1.5;">
              其中入仓品 {{ skuTotals.warehouse_sku_count }} 个 · 成交 {{ fmtNum(skuTotals.warehouse_qty) }} 件
              · 销售额 {{ fmtMoney(skuTotals.warehouse_revenue) }}
              · 毛利 {{ fmtMoney(skuTotals.warehouse_gross) }}
              · 广告费 {{ fmtMoney(skuTotals.warehouse_ads) }}
              · 广告后 {{ fmtMoney(skuTotals.warehouse_net) }}
            </div>
          </div>
          <van-button
            v-if="skuRows.length > SKU_LIMIT && !skuFull"
            block
            size="small"
            plain
            style="margin-top:8px;"
            @click="skuFull = true"
          >显示全部（共 {{ skuRows.length }} 条）</van-button>
        </template>

        <div class="muted" style="font-size:12px;margin-top:8px;line-height:1.5;">
          广告花费按缓存段整段读取后按 SKU 汇总；ERP 商品编码需填京东 skuId 才能匹配。入仓品的成交件数与毛利取 jdfenxi「月度利润」本地缓存，利润 = 入仓品毛利 − 广告费。本表按成交口径统计，与上方财务卡片的收入口径不同。
        </div>
      </div>
    </div>
  </div>
</template>

<script setup>
import { ref, computed, onMounted } from 'vue'
import { useRouter } from 'vue-router'
import { showToast } from 'vant'
import api from '../api'
import { fmtMoney, fmtNum, num, todayStr, monthStartStr } from '../utils/format'

const router = useRouter()
function goBack() {
  if (window.history.length > 1) router.back()
  else router.replace('/mine')
}

const SKU_LIMIT = 40
const df = ref(monthStartStr())
const dt = ref(todayStr())
const quickKey = ref('month')
const scope = ref('all')          // all 全仓总览 / one 当前分仓
const excludeOther = ref(true)
const loading = ref(false)
const summary = ref({})
const sku = ref(null)
const skuLoading = ref(false)
const skuKw = ref('')
const onlyAds = ref(false)
const skuSort = ref('ads')
const skuFull = ref(false)

const erp = computed(() => summary.value.erp || {})
const profit = computed(() => summary.value.profit || {})
const warnings = computed(() => summary.value.warnings || [])
const pre = computed(() => (erp.value.is_all ? '全仓' : ''))
const generatedAt = computed(() => (summary.value.generated_at ? `数据时间 ${summary.value.generated_at}` : ''))
const rangeHint = computed(() => {
  const r = summary.value.range || {}
  if (!r.start) return '选择区间后查询'
  const caliber = erp.value.exclude_other_expense
    ? `已排除其他收支 ${fmtMoney(erp.value.excluded_other_expense)}`
    : `含其他收支 ${fmtMoney(erp.value.excluded_other_expense)}`
  const wh = erp.value.is_all ? '全仓合计' : ((erp.value.warehouse && erp.value.warehouse.name) || '当前分仓')
  return `统计区间 ${r.start} ~ ${r.end}（${r.days} 天） · ${wh} · ${caliber}`
    + (erp.value.is_all ? '' : ' · 广告费为店铺合计（店铺未与分仓映射）')
})

const pctOf = (v) => (num(erp.value.revenue) ? ((num(v) / num(erp.value.revenue)) * 100).toFixed(1) + '%' : '—')

const bridge = computed(() => {
  const e = erp.value
  const p = profit.value
  return [
    { name: '销售收入', value: num(e.revenue) },
    { name: '结转成本', value: -num(e.cogs) },
    { name: '毛利（广告前）', value: num(p.gross_before_ads), bold: true },
    { name: '期间费用', value: -num(e.expense) },
    { name: '净利润（广告前）', value: num(p.net_before_ads), bold: true },
    { name: 'CPS 花费', value: -num(p.cps_total) },
    { name: '京准通花费', value: -num(p.jzt_total) },
    { name: '广告费合计', value: -num(p.ads_total) },
    { name: '毛利（广告后）', value: num(p.gross_after_ads), bold: true },
    { name: '净利润（广告后）', value: num(p.net_after_ads), bold: true },
  ]
})

const accounts = computed(() => {
  const map = new Map()
  const merge = (kind, part) => {
    ;((part && part.accounts) || []).forEach((a) => {
      const k = a.label || a.key
      const m = map.get(k) || { label: k, cps: null, jzt: null }
      m[kind] = a
      map.set(k, m)
    })
  }
  const ads = summary.value.ads || {}
  merge('cps', ads.cps)
  merge('jzt', ads.jzt)
  return [...map.values()].map((m) => {
    const cps = m.cps ? num(m.cps.total) : 0
    const jzt = m.jzt ? num(m.jzt.total) : 0
    const gaps = []
    if (m.cps && (m.cps.gaps || []).length) gaps.push('CPS 缺 ' + m.cps.gaps.join('、'))
    if (m.jzt && (m.jzt.gaps || []).length) gaps.push('京准通 缺 ' + m.jzt.gaps.join('、'))
    return {
      label: m.label,
      cps,
      jzt,
      total: cps + jzt,
      covered: `${m.cps ? (m.cps.covered_days || 0) : '—'}${m.jzt ? ' / ' + (m.jzt.covered_days || 0) : ''}`,
      gaps: gaps.join('；'),
    }
  }).sort((a, b) => b.total - a.total)
})

const skuTotals = computed(() => (sku.value && sku.value.totals) || {})
const skuRows = computed(() => {
  const list = (sku.value && sku.value.rows) || []
  const kws = (skuKw.value || '').toLowerCase().split(/[；;\s]+/).filter(Boolean)
  const filtered = list.filter((r) => {
    if (onlyAds.value && !(num(r.ads_total) > 0)) return false
    if (!kws.length) return true
    const hay = `${r.sku || ''} ${r.name || ''}`.toLowerCase()
    return kws.some((k) => hay.includes(k))
  })
  const sorters = {
    ads: (a, b) => num(b.ads_total) - num(a.ads_total) || num(b.revenue) - num(a.revenue),
    revenue: (a, b) => num(b.revenue) - num(a.revenue) || num(b.ads_total) - num(a.ads_total),
    gross: (a, b) => num(b.gross_before) - num(a.gross_before) || num(b.ads_total) - num(a.ads_total),
    gross_after: (a, b) => num(b.gross_after) - num(a.gross_after) || num(b.ads_total) - num(a.ads_total),
  }
  return filtered.slice().sort(sorters[skuSort.value] || sorters.ads)
})
const skuShown = computed(() => (skuFull.value ? skuRows.value : skuRows.value.slice(0, SKU_LIMIT)))
const skuStat = computed(() => {
  const t = skuTotals.value
  if (!sku.value) return '按商品编码（京东 skuId）匹配挂载服务的 SKU 花费'
  const pr = (sku.value.profit_ranges || []).slice(-1)[0]
  return `${t.sku_count || 0} 个 SKU · 匹配广告 ${t.matched_skus || 0} 个 · 未匹配广告 ${t.ad_only_skus || 0} 个`
    + (num(t.warehouse_sku_count) ? ` · 入仓品 ${t.warehouse_sku_count} 个（利润缓存 ${pr || '无'}）` : '')
    + (num(t.unmatched_ads) > 0.005 ? ` · 未匹配广告费 ${fmtMoney(t.unmatched_ads)}` : '')
})

function lastMonthRange() {
  const n = new Date()
  const f = (x) => `${x.getFullYear()}-${String(x.getMonth() + 1).padStart(2, '0')}-${String(x.getDate()).padStart(2, '0')}`
  return [f(new Date(n.getFullYear(), n.getMonth() - 1, 1)), f(new Date(n.getFullYear(), n.getMonth(), 0))]
}

function quick(kind) {
  quickKey.value = kind
  const t = todayStr()
  if (kind === 'today') { df.value = t; dt.value = t }
  else if (kind === 'month') { df.value = monthStartStr(); dt.value = t }
  else { const [a, b] = lastMonthRange(); df.value = a; dt.value = b }
  load()
}

function setScope(v) {
  if (scope.value === v) return
  scope.value = v
  load()
}

async function load(refresh = false) {
  loading.value = true
  skuFull.value = false
  const qs = `date_from=${df.value || ''}&date_to=${dt.value || ''}`
    + `&exclude_other=${excludeOther.value ? 1 : 0}`
    + (scope.value === 'all' ? '&wh=all' : '')
    + (refresh ? '&refresh=1' : '')
  try {
    summary.value = await api(`/api/adprofit/summary?${qs}`)
  } catch (e) {
    showToast('加载广告利润失败：' + e.message)
    loading.value = false
    return
  }
  loading.value = false
  loadSku(qs)
}

async function loadSku(qs) {
  skuLoading.value = true
  try {
    sku.value = await api(`/api/adprofit/skus?${qs}`)
  } catch (e) {
    sku.value = null
    showToast('按 SKU 明细加载失败：' + e.message)
  }
  skuLoading.value = false
}

onMounted(() => load())
</script>

<style scoped>
.sub-page { min-height: 100vh; background: #f7f8fa; }
.mono { font-variant-numeric: tabular-nums; }
.bridge-row { display: flex; align-items: center; gap: 8px; padding: 6px 0; border-bottom: 1px solid #f5f5f5; font-size: 13px; }
.bridge-row:last-child { border-bottom: none; }
.alert { border-radius: 8px; padding: 8px 10px; font-size: 12px; line-height: 1.5; }
.alert.warn { background: #fffbe8; color: #ed6a0c; }
.pick { font-size: 13px; padding: 5px 6px; border: 1px solid #dcdee0; border-radius: 6px; background: #fff; color: #323233; }
.sku-item { padding: 10px 0; border-bottom: 1px solid #f5f5f5; }
.sku-item:last-of-type { border-bottom: none; }
.sku-name { font-weight: 600; font-size: 14px; }
.sku-metrics { display: flex; flex-wrap: wrap; gap: 4px 12px; margin-top: 6px; font-size: 12px; color: #646566; }
.sku-metrics b { color: #323233; font-variant-numeric: tabular-nums; }
.sku-total { margin-top: 8px; padding-top: 8px; border-top: 1px dashed #e5e5e5; }
</style>
