<template>
  <div>
    <!-- 概览 -->
    <div class="stat-grid">
      <div class="stat"><div class="label">今日收入</div><div class="value">{{ fmt(today.revenue) }}</div><div class="sub">{{ today.orders }} 单</div></div>
      <div class="stat green"><div class="label">本月毛利</div><div class="value">{{ fmt(month.gross) }}</div><div class="sub">净利 {{ fmt(month.net) }}</div></div>
      <div class="stat"><div class="label">库存总值</div><div class="value">{{ fmt(stockValue) }}</div><div class="sub">{{ productCount }} 种商品</div></div>
    </div>

    <div class="card">
      <div class="card-title">鲜货现采</div>
      <van-button type="primary" block round icon="shop-o" @click="$router.push('/fresh')">查看今日鲜货预采</van-button>
    </div>

    <!-- AI 智能录入 -->
    <div class="card">
      <div class="card-title">AI 智能录入</div>
      <van-field v-model="aiText" type="textarea" rows="2" autosize placeholder="例如：今天入库了100斤木耳，25一斤；或 出库2单七彩土豆3斤，每单15元" />
      <div class="row" style="margin-top:10px;">
        <van-button type="primary" block round :loading="busy" @click="aiParse">🤖 识别并录入</van-button>
        <van-button type="success" block round :loading="busyImg" @click="file && file.click()">📷 拍单识别</van-button>
        <input ref="file" type="file" accept="image/*" style="display:none" @change="aiParseImage" />
      </div>
      <div v-if="thinking" class="think-box"><pre>{{ thinking }}</pre></div>
    </div>

    <!-- 缺货预警 -->
    <div class="card" v-if="lowStock.length">
      <div class="card-title">缺货预警</div>
      <div v-for="p in lowStock.slice(0, 6)" :key="p.id" class="row" style="padding:8px 0;border-bottom:1px solid #f5f5f5;">
        <span class="grow">{{ p.name }}</span>
        <span class="muted">{{ fmtStock(p) }}</span>
        <van-button size="mini" type="danger" plain @click="$router.push('/inbound')">补货</van-button>
      </div>
    </div>
  </div>
</template>

<script setup>
import { ref, onMounted } from 'vue'
import { showToast } from 'vant'
import { useRouter } from 'vue-router'
import api, { aiStream } from '../api'

const router = useRouter()
const today = ref({}), month = ref({}), stockValue = ref(0), productCount = ref(0), lowStock = ref([])
const aiText = ref(''), thinking = ref(''), busy = ref(false), busyImg = ref(false), file = ref(null)

const fmt = (v) => '¥' + (+v || 0).toLocaleString('zh-CN', { minimumFractionDigits: 2 })
const fmtStock = (p) => {
  if (p.stock_display) return p.stock_display
  const du = p.default_unit || p.base_unit || ''
  const f = (p.conversions || {})[du] || 1
  const n = f && f !== 1 ? (+p.stock / f) : +p.stock
  return `${n} ${f && f !== 1 ? du : p.base_unit}`
}

async function load() {
  try {
    const d = await api('/api/dashboard')
    today.value = d.today_summary || {}
    month.value = d.month_summary || {}
    stockValue.value = d.stock_value || 0
    productCount.value = d.product_count || 0
    lowStock.value = d.low_stock || []
  } catch (e) {}
}
onMounted(load)

async function aiParse() {
  const text = aiText.value.trim()
  if (!text) { showToast('请输入描述'); return }
  busy.value = true; thinking.value = ''
  try {
    const r = await aiStream('/api/ai/parse/stream', { text }, (d) => { thinking.value += d })
    busy.value = false
    showAiConfirm(r)
  } catch (e) { busy.value = false; showToast('识别失败：' + e.message) }
}
async function aiParseImage() {
  const f = file.value && file.value.files[0]
  if (!f) return
  busyImg.value = true; thinking.value = ''
  try {
    const fd = new FormData(); fd.append('file', f)
    const r = await aiStream('/api/ai/parse-image/stream', null, (d) => { thinking.value += d }, fd)
    busyImg.value = false
    showAiConfirm(r)
  } catch (e) { busyImg.value = false; showToast('识别失败：' + e.message) }
  if (file.value) file.value.value = ''
}

function showAiConfirm(r) {
  const isIn = r.type === 'inbound'
  const lines = (r.lines || []).map((ln) => ({
    ...ln,
    label: `${ln.product_name || '?'}${ln.auto_created ? '（新）' : ''}`,
  }))
  const text = (isIn ? '入库：' : '出库：') + lines.map((l) => `${l.label} ${l.quantity}${l.unit} @${l.unit_price}`).join('；')
  if (window.confirm(`确认录入？\n${text}\n\n确定后提交。`)) submitAi(r)
}
async function submitAi(r) {
  const isIn = r.type === 'inbound'
  const inv = r.image_url ? `[票据] ${r.image_url}` : ''
  try {
    if (isIn) {
      for (const ln of r.lines || []) {
        await api('/api/inbounds', 'POST', {
          product_id: ln.product_id, unit: ln.unit, quantity: ln.quantity,
          unit_price: ln.unit_price, supplier: r.supplier, date: r.date,
          remark: [inv, ln.auto_created ? '[AI自动新增]' : ''].filter(Boolean).join(' '),
        })
      }
    } else {
      const lines = (r.lines || []).map((ln) => ({ product_id: ln.product_id, unit: ln.unit, quantity: ln.quantity, price: ln.unit_price }))
      await api('/api/outbounds', 'POST', { customer: r.customer, date: r.date, remark: [inv, r.remark].filter(Boolean).join(' '), lines, pack_lines: [] })
    }
    showToast(isIn ? '入库成功' : '出库成功')
    aiText.value = ''; thinking.value = ''
    load()
  } catch (e) { showToast('提交失败：' + e.message) }
}
</script>

<style scoped>
.stat-grid { display: grid; grid-template-columns: repeat(3, 1fr); gap: 10px; margin-bottom: 12px; }
.stat { background: #fff; border-radius: 10px; padding: 12px; }
.stat .label { font-size: 12px; color: #969799; }
.stat .value { font-size: 16px; font-weight: 700; margin: 4px 0 2px; }
.stat.green .value { color: #07c160; }
.stat .sub { font-size: 11px; color: #969799; }
.think-box { margin-top: 10px; background: #f2f3f5; border-radius: 8px; padding: 8px; max-height: 160px; overflow: auto; }
.think-box pre { font-size: 12px; color: #646566; white-space: pre-wrap; word-break: break-all; font-family: monospace; }
</style>
