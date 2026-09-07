<template>
  <div>
    <!-- 概览 -->
    <div class="stat-grid">
      <div class="stat"><div class="label">今日收入</div><div class="value">{{ fmt(today.revenue) }}</div><div class="sub">{{ today.orders }} 单</div></div>
      <div class="stat green"><div class="label">本月毛利</div><div class="value">{{ fmt(month.gross) }}</div><div class="sub">净利 {{ fmt(month.net) }}</div></div>
      <div class="stat"><div class="label">库存总值</div><div class="value">{{ fmt(stockValue) }}</div><div class="sub">{{ productCount }} 种商品</div></div>
    </div>

    <div class="card">
      <div class="card-title">快捷入口</div>
      <div class="quick-grid">
        <div class="quick" @click="$router.push('/fresh')"><span class="qi">🥬</span>鲜货现采</div>
        <div class="quick" @click="$router.push('/records')"><span class="qi">📋</span>出入库记录</div>
        <div class="quick" @click="$router.push('/pack-rules')"><span class="qi">📦</span>一单多货</div>
        <div class="quick" @click="$router.push('/report')"><span class="qi">📊</span>经营报表</div>
      </div>
    </div>

    <!-- AI 智能录入 -->
    <div class="card">
      <div class="card-title">AI 智能录入</div>
      <van-field v-model="aiText" type="textarea" rows="2" autosize placeholder="例如：今天入库了100斤木耳，25一斤；或 出库2单七彩土豆3斤，每单15元" />
      <div class="row" style="margin-top:10px;">
        <van-button type="primary" block round :loading="busy" :disabled="busyImg" @click="aiParse">🤖 识别并录入</van-button>
        <van-button type="success" block round :loading="busyImg" :disabled="busy" @click="pickShow = true">📷 拍单识别</van-button>
        <input ref="cameraFile" type="file" accept="image/*" capture="environment" style="display:none" @change="onFiles" />
        <input ref="albumFile" type="file" accept="image/*" multiple style="display:none" @change="onFiles" />
      </div>
      <van-action-sheet v-model:show="pickShow" :actions="pickActions" cancel-text="取消" @select="onPick" />
      <div v-if="batchTip" class="batch-tip">{{ batchTip }}</div>
      <div v-if="thinking" class="think-box"><pre>{{ thinking }}</pre></div>
    </div>

    <!-- 最近出入库（对齐桌面端：默认展示记录） -->
    <div class="card" v-if="recentOut.length || recentIn.length">
      <div class="card-title">
        <span class="grow">最近记录</span>
        <span class="muted link" @click="$router.push('/records')">全部 ›</span>
      </div>
      <van-tabs v-model:active="recTab" shrink>
        <van-tab title="出库">
          <div v-for="(o, i) in recentOut" :key="'o' + i" class="rec">
            <div class="row"><span class="grow">{{ o.code }}</span><b>{{ fmt(o.amount) }}</b></div>
            <div class="muted">{{ o.date }} · {{ o.customer || '—' }} · 净利 {{ fmt(o.net) }}</div>
          </div>
          <van-empty v-if="!recentOut.length" description="暂无出库" />
        </van-tab>
        <van-tab title="入库">
          <div v-for="(r, i) in recentIn" :key="'i' + i" class="rec">
            <div class="row"><span class="grow">{{ r.product_name }}</span><b>{{ fmt(r.amount) }}</b></div>
            <div class="muted">{{ r.date }} · {{ r.quantity }} {{ r.unit }}</div>
          </div>
          <van-empty v-if="!recentIn.length" description="暂无入库" />
        </van-tab>
      </van-tabs>
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

    <ai-confirm v-model:show="confirmShow" :result="aiResult" @done="onConfirmed" />
  </div>
</template>

<script setup>
import { ref, watch, onMounted } from 'vue'
import { showToast } from 'vant'
import api, { aiStream } from '../api'
import AiConfirm from '../components/ai-confirm.vue'
import { loadProducts } from '../store/products'

const today = ref({}), month = ref({}), stockValue = ref(0), productCount = ref(0), lowStock = ref([])
const recentIn = ref([]), recentOut = ref([]), recTab = ref(0)
const aiText = ref(''), thinking = ref(''), busy = ref(false), busyImg = ref(false), batchTip = ref('')
const cameraFile = ref(null), albumFile = ref(null), pickShow = ref(false)
const confirmShow = ref(false), aiResult = ref(null)
const pickActions = [
  { name: '📷 拍照', source: 'camera' },
  { name: '🖼️ 从相册选择（可多选）', source: 'album' },
]

// 批量识别队列：确认框关闭后再识别下一张（对齐桌面端 _aiDoneResolve）
let queueResolve = null

const fmt = (v) => '¥' + (+v || 0).toLocaleString('zh-CN', { minimumFractionDigits: 2 })
const fmtStock = (p) => {
  if (p.stock_display) return p.stock_display
  const du = p.default_unit || p.base_unit || ''
  const f = (p.conversions || {})[du] || 1
  return `${f && f !== 1 ? +p.stock / f : +p.stock} ${f && f !== 1 ? du : p.base_unit}`
}

async function load() {
  try {
    const d = await api('/api/dashboard')
    today.value = d.today_summary || {}
    month.value = d.month_summary || {}
    stockValue.value = d.stock_value || 0
    productCount.value = d.product_count || 0
    lowStock.value = d.low_stock || []
    recentIn.value = d.recent_inbounds || []
    recentOut.value = d.recent_outbounds || []
  } catch (e) {}
}
onMounted(() => { load(); loadProducts() })

function openConfirm(r) {
  aiResult.value = r
  confirmShow.value = true
}
function onConfirmed() {
  aiText.value = ''; thinking.value = ''
  load(); loadProducts(true)
  if (queueResolve) { const f = queueResolve; queueResolve = null; f() }
}

async function aiParse() {
  const text = aiText.value.trim()
  if (!text) { showToast('请输入描述'); return }
  busy.value = true; thinking.value = ''
  try {
    const r = await aiStream('/api/ai/parse/stream', { text }, (d) => { thinking.value += d })
    openConfirm(r)
  } catch (e) { showToast('识别失败：' + e.message) } finally { busy.value = false }
}

function onPick(action) {
  pickShow.value = false
  const el = action.source === 'camera' ? cameraFile.value : albumFile.value
  el && el.click()
}

async function onFiles(e) {
  const files = Array.from(e.target.files || [])
  e.target.value = ''
  if (!files.length) return
  thinking.value = ''
  busyImg.value = true
  for (let i = 0; i < files.length; i++) {
    batchTip.value = files.length > 1 ? `识别中（第 ${i + 1}/${files.length} 张）…` : '识别中…'
    try {
      const fd = new FormData(); fd.append('file', files[i])
      const r = await aiStream('/api/ai/parse-image/stream', null, (d) => { thinking.value += d }, fd)
      openConfirm(r)
      // 多张时等本张确认/取消完成后再识别下一张，避免确认框互相覆盖
      if (files.length > 1) await waitConfirmClosed()
    } catch (err) {
      showToast(files.length > 1 ? `第 ${i + 1} 张识别失败：${err.message}` : `识别失败：${err.message}`)
      break   // 识别失败终止剩余批次（对齐桌面端）
    }
  }
  batchTip.value = ''
  busyImg.value = false
}

/** 等待确认框关闭（提交或取消都算完成） */
function waitConfirmClosed() {
  return new Promise((resolve) => {
    queueResolve = resolve
    const stop = watch(confirmShow, (v) => {
      if (!v) { stop(); if (queueResolve) { queueResolve = null; resolve() } }
    })
  })
}
</script>

<style scoped>
.stat-grid { display: grid; grid-template-columns: repeat(3, 1fr); gap: 10px; margin-bottom: 12px; }
.stat { background: #fff; border-radius: 10px; padding: 12px; }
.stat .label { font-size: 12px; color: #969799; }
.stat .value { font-size: 16px; font-weight: 700; margin: 4px 0 2px; }
.stat.green .value { color: #07c160; }
.stat .sub { font-size: 11px; color: #969799; }
.quick-grid { display: grid; grid-template-columns: repeat(4, 1fr); gap: 8px; }
.quick { text-align: center; font-size: 12px; color: #323233; padding: 8px 2px; border-radius: 8px; background: #f7f8fa; }
.quick:active { background: #eef1f5; }
.quick .qi { display: block; font-size: 20px; margin-bottom: 4px; }
.rec { padding: 10px 0; border-bottom: 1px solid #f5f5f5; }
.rec:last-child { border-bottom: none; }
.link { color: #1989fa; }
.batch-tip { margin-top: 8px; font-size: 12px; color: #1989fa; }
.think-box { margin-top: 10px; background: #f2f3f5; border-radius: 8px; padding: 8px; max-height: 160px; overflow: auto; }
.think-box pre { font-size: 12px; color: #646566; white-space: pre-wrap; word-break: break-all; font-family: monospace; }
</style>
