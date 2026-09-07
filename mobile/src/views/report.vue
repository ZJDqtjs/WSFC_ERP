<template>
  <div>
    <sub-header title="经营报表" />

    <van-cell-group inset>
      <van-field v-model="from" label="开始日期" type="date" @change="load" />
      <van-field v-model="to" label="结束日期" type="date" @change="load" />
    </van-cell-group>
    <div class="quick-range">
      <van-button size="mini" plain @click="setRange('today')">今天</van-button>
      <van-button size="mini" plain @click="setRange('week')">近7天</van-button>
      <van-button size="mini" plain @click="setRange('month')">本月</van-button>
    </div>

    <div class="stat-grid">
      <div class="stat"><div class="label">营业收入</div><div class="value">{{ fmt(d.revenue) }}</div><div class="sub">{{ d.order_count }} 单</div></div>
      <div class="stat"><div class="label">销售成本</div><div class="value">{{ fmt(d.cogs) }}</div><div class="sub">采购 {{ fmt(d.purchase) }}</div></div>
      <div class="stat green"><div class="label">毛利</div><div class="value">{{ fmt(d.gross_profit) }}</div><div class="sub">{{ rate }}%</div></div>
      <div class="stat green"><div class="label">净利</div><div class="value">{{ fmt(d.net_profit) }}</div><div class="sub">费用 {{ fmt(d.expense) }}</div></div>
    </div>

    <div class="card">
      <div class="card-title">费用构成</div>
      <div v-for="(v, k) in d.fee_breakdown || {}" :key="k" class="row line">
        <span class="grow">{{ k }}</span><b>{{ fmt(v) }}</b>
      </div>
      <div class="row line"><span class="grow">库存总值</span><b>{{ fmt(d.stock_value) }}</b></div>
    </div>

    <div class="card">
      <div class="card-title">
        <span class="grow">商品销售排行</span>
        <span class="muted">按收入</span>
      </div>
      <div v-for="(p, i) in (d.by_product || []).slice(0, topN)" :key="p.product_id" class="prod">
        <div class="row">
          <span class="rank" :class="{ top: i < 3 }">{{ i + 1 }}</span>
          <span class="grow">{{ p.name }}</span>
          <b>{{ fmt(p.amount) }}</b>
        </div>
        <div class="bar"><i :style="{ width: barW(p.amount) }" /></div>
        <div class="muted">数量 {{ p.qty }} · 成本 {{ fmt(p.cogs) }} · 毛利 {{ fmt(p.amount - p.cogs) }}</div>
      </div>
      <van-empty v-if="!(d.by_product || []).length" description="暂无销售数据" />
      <van-button
        v-if="(d.by_product || []).length > topN"
        size="small" plain block @click="topN += 20"
      >加载更多</van-button>
    </div>
  </div>
</template>

<script setup>
import { ref, computed, onMounted } from 'vue'
import { showToast } from 'vant'
import api from '../api'
import SubHeader from '../components/sub-header.vue'

const today = new Date().toISOString().slice(0, 10)
const d = ref({}), topN = ref(10)
const from = ref(today.slice(0, 8) + '01'), to = ref(today)

const fmt = (v) => '¥' + (+v || 0).toLocaleString('zh-CN', { minimumFractionDigits: 2 })
const rate = computed(() => (d.value.revenue ? ((d.value.gross_profit / d.value.revenue) * 100).toFixed(1) : '0.0'))
const maxAmount = computed(() => Math.max(1, ...(d.value.by_product || []).map((p) => p.amount)))
const barW = (v) => `${Math.max(2, (v / maxAmount.value) * 100)}%`

function setRange(kind) {
  const t = new Date()
  if (kind === 'today') { from.value = today; to.value = today }
  else if (kind === 'week') {
    const s = new Date(t.getTime() - 6 * 86400000)
    from.value = s.toISOString().slice(0, 10); to.value = today
  } else { from.value = today.slice(0, 8) + '01'; to.value = today }
  load()
}

async function load() {
  try {
    d.value = await api(`/api/report/summary?date_from=${from.value || ''}&date_to=${to.value || ''}`)
    topN.value = 10
  } catch (e) { showToast('加载失败：' + e.message) }
}
onMounted(load)
</script>

<style scoped>
.quick-range { display: flex; gap: 8px; padding: 10px 16px; }
.stat-grid { display: grid; grid-template-columns: repeat(2, 1fr); gap: 10px; margin: 12px 0; }
.stat { background: #fff; border-radius: 10px; padding: 12px; }
.stat .label { font-size: 12px; color: #969799; }
.stat .value { font-size: 17px; font-weight: 700; margin: 4px 0 2px; }
.stat.green .value { color: #07c160; }
.stat .sub { font-size: 11px; color: #969799; }
.line { padding: 8px 0; border-bottom: 1px solid #f5f5f5; }
.line:last-child { border-bottom: none; }
.prod { padding: 10px 0; border-bottom: 1px solid #f5f5f5; }
.rank { display: inline-block; width: 20px; height: 20px; line-height: 20px; text-align: center; border-radius: 4px; background: #f2f3f5; color: #646566; font-size: 11px; margin-right: 6px; }
.rank.top { background: #1989fa; color: #fff; }
.bar { height: 4px; background: #f2f3f5; border-radius: 2px; margin: 6px 0 4px; overflow: hidden; }
.bar i { display: block; height: 100%; background: #1989fa; border-radius: 2px; }
</style>
