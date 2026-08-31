<template>
  <div>
    <van-search v-model="kw" placeholder="搜索商品" shape="round" />
    <van-tabs v-model:active="tab" sticky>
      <van-tab title="库存总览">
        <van-pull-refresh v-model="refreshing" @refresh="loadStock">
          <div class="list">
            <div v-for="p in filtered" :key="p.id" class="card stock-item" @click="openMv(p.id)">
              <div class="row">
                <span class="grow">{{ p.name }}</span>
                <span class="stock-num" :class="{ low: p.stock <= 0 }">{{ fmtStock(p) }}</span>
              </div>
              <div class="muted" style="margin-top:4px;">平均成本 {{ fmt(p.avg_cost * (convFactor(p)||1)) }}/{{ p.default_unit || p.base_unit }} · 价值 {{ fmt(p.stock_value) }}</div>
            </div>
          </div>
        </van-pull-refresh>
      </van-tab>
      <van-tab title="库存流水">
        <van-pull-refresh v-model="refreshing" @refresh="loadMv">
          <div class="list">
            <div v-for="m in mvList" :key="m.id" class="card mv-item">
              <div class="row">
                <span class="grow">{{ m.product_name }}</span>
                <span :style="{ color: m.quantity_display >= 0 ? '#07c160' : '#ee0a24' }">{{ m.quantity_display >= 0 ? '+' : '' }}{{ m.quantity_display }} {{ m.unit }}</span>
              </div>
              <div class="muted">{{ m.date }} · {{ m.move_type }} · {{ m.remark }}</div>
            </div>
            <van-empty v-if="!mvList.length" description="暂无流水" />
          </div>
        </van-pull-refresh>
      </van-tab>
    </van-tabs>
  </div>
</template>

<script setup>
import { ref, computed, onMounted } from 'vue'
import { showToast } from 'vant'
import api from '../api'

const kw = ref(''), tab = ref(0), refreshing = ref(false)
const STOCK = ref([]), mvList = ref([])

const fmt = (v) => '¥' + (+v || 0).toLocaleString('zh-CN', { minimumFractionDigits: 2 })
const convFactor = (p) => { const du = p.default_unit || p.base_unit; return (p.conversions || {})[du] }
const fmtStock = (p) => {
  const du = p.default_unit || p.base_unit || ''
  const f = (p.conversions || {})[du] || 1
  return `${f && f !== 1 ? +p.stock / f : +p.stock} ${f && f !== 1 ? du : p.base_unit}`
}
const filtered = computed(() => {
  const s = (kw.value || '').trim().toLowerCase()
  return STOCK.value.filter((p) => !s || p.name.toLowerCase().includes(s) || (p.category || '').toLowerCase().includes(s))
})

async function loadStock() {
  try {
    const d = await api('/api/stock-overview')
    STOCK.value = d.filter((p) => !['人工', '快递'].includes(p.category))
  } catch (e) { showToast('加载失败') }
  refreshing.value = false
}
async function loadMv() {
  try {
    const today = new Date().toISOString().slice(0, 10)
    mvList.value = await api(`/api/movements?date_from=${today}&date_to=${today}`)
  } catch (e) { showToast('加载失败') }
  refreshing.value = false
}
function openMv(id) {
  tab.value = 1
  loadMv()
}
onMounted(() => { loadStock(); loadMv() })
</script>

<style scoped>
.list { padding: 4px 0; }
.stock-item:active { background: #f5f6f7; }
.stock-num { font-weight: 700; }
.stock-num.low { color: #ee0a24; }
.mv-item:active { background: #f5f6f7; }
</style>
