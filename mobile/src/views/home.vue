<template>
  <div>
    <!-- 欢迎 + 快捷入口 -->
    <div class="card welcome">
      <div class="row">
        <div class="grow">
          <div class="hello">你好，{{ userName || '管理员' }} 👋</div>
          <div class="muted">{{ todayDate }} · 库存财务一体化台账</div>
        </div>
      </div>
      <div class="quick-row">
        <van-button size="small" type="primary" icon="down" @click="$router.push('/inbound')">快速入库</van-button>
        <van-button size="small" type="success" icon="logistics" @click="$router.push('/outbound')">快速出库</van-button>
        <van-button size="small" plain type="primary" icon="plus" @click="$router.push('/products')">新增商品</van-button>
      </div>
    </div>

    <!-- AI 智能录入 -->
    <div class="card">
      <div class="card-title">
        <van-icon name="fire-o" color="#1989fa" /> AI 智能录入
      </div>
      <div class="muted" style="margin-bottom:8px;">
        用大白话描述入库/出库，AI 自动拆成系统格式；识别后可核对再提交，也可拍票据多张连传。<br />
        <b>选好图片后先预览，按回车或点「识别并录入」才开始识别</b>；拍照/传图时，上面的文字会作为补充说明一起发给 AI（如「图里的京东箱子就是纸箱：京东8号-&gt;8号纸箱」）。
      </div>
      <van-field
        v-model="aiText"
        type="textarea"
        rows="2"
        autosize
        placeholder="文字：今天入库了100斤木耳，25一斤；图片补充说明：京东8号->8号纸箱"
        @keydown.enter.exact.prevent="aiRun"
      />
      <div class="quick-row">
        <van-button size="small" type="success" icon="fire-o" :loading="busy || busyImg" @click="aiRun">识别并录入</van-button>
        <van-button size="small" plain type="primary" icon="photograph" @click="pickImages('camera')">拍照选图</van-button>
        <van-button size="small" plain type="primary" icon="photo-o" @click="pickImages('album')">相册选图</van-button>
      </div>
      <input ref="camInput" type="file" accept="image/*" capture="environment" multiple style="display:none" @change="onFiles" />
      <input ref="albumInput" type="file" accept="image/*" multiple style="display:none" @change="onFiles" />

      <!-- 待识别图片预览：选好后按回车 / 点「识别并录入」才开始识别 -->
      <div v-if="aiPending.length" class="pending-box">
        <div class="muted" style="margin:8px 0 4px;">
          🖼 待识别图片 {{ aiPending.length }} 张，按回车或点「识别并录入」开始识别
        </div>
        <div class="pending-list">
          <div v-for="(it, i) in aiPending" :key="it.url" class="pending-item">
            <img :src="it.url" alt="待识别图片" @click="previewPending(i)" />
            <van-icon name="cross" class="pending-x" @click="removePending(i)" />
          </div>
        </div>
      </div>

      <div v-if="thinking || answer || busy || busyImg" class="think-box">
        <div class="row" style="justify-content:space-between;">
          <span class="muted grow">{{ aiStage || ((busy || busyImg) ? 'AI 思考中…' : 'AI 思考过程') }}</span>
          <van-button v-if="thinking" size="mini" plain @click="thinkOpen = !thinkOpen">
            {{ thinkOpen ? '收起英文思考' : '展开英文思考' }}
          </van-button>
          <van-button v-if="busy || busyImg" size="mini" plain @click="cancelAI">取消</van-button>
        </div>
        <template v-if="thinking && thinkOpen">
          <div class="think-sub">🧠 原始思考（模型 reasoning 通道，英文）</div>
          <pre>{{ thinking }}</pre>
        </template>
        <template v-if="answer">
          <div class="think-sub">📄 识别结果（中文思路 + JSON）</div>
          <pre class="think-answer">{{ answer }}</pre>
        </template>
      </div>
    </div>

    <!-- 经营数据（点卡片直接进财务报表，并带上对应口径：today / month） -->
    <div class="stat-grid" style="margin-bottom:12px;">
      <div class="stat accent tappable" @click="$router.push('/report?quick=today&tab=summary')">
        <div class="label">今日收入</div>
        <div class="value">{{ fmtMoney(todayStats.revenue) }}</div>
        <div class="sub">{{ todayStats.orders || 0 }} 单</div>
      </div>
      <div class="stat success tappable" @click="$router.push('/report?quick=today&tab=summary')">
        <div class="label">今日毛利</div>
        <div class="value">{{ fmtMoney(todayStats.gross) }}</div>
        <div class="sub">净利 {{ fmtMoney(todayStats.net) }}</div>
      </div>
      <div class="stat tappable" @click="$router.push('/report?quick=month&tab=summary')">
        <div class="label">本月收入</div>
        <div class="value">{{ fmtMoney(month.revenue) }}</div>
        <div class="sub">{{ month.orders || 0 }} 单</div>
      </div>
    </div>
    <div class="stat-grid" style="margin-bottom:12px;">
      <div class="stat tappable" @click="$router.push('/report?quick=month&tab=summary')">
        <div class="label">本月毛利</div>
        <div class="value">{{ fmtMoney(month.gross) }}</div>
      </div>
      <div class="stat tappable" @click="$router.push('/report?quick=month&tab=summary')">
        <div class="label">本月净利</div>
        <div class="value">{{ fmtMoney(month.net) }}</div>
      </div>
      <div class="stat accent tappable" @click="$router.push('/report?quick=month&tab=summary')">
        <div class="label">库存总值</div>
        <div class="value">{{ fmtMoney(stockValue) }}</div>
        <div class="sub">{{ productCount }} 种商品</div>
      </div>
    </div>

    <!-- 其他开支（本月） -->
    <div class="card">
      <div class="row">
        <div class="grow">
          <div class="muted">本月其他开支（网线费 / 安装费 / 样品费…）</div>
          <div class="bold up" style="font-size:18px;margin-top:2px;">{{ fmtMoney(month.other_expense) }}</div>
          <div class="muted">今日 {{ fmtMoney(todayStats.other_expense) }}</div>
        </div>
        <van-button size="small" plain type="primary" @click="$router.push('/otherexp')">其他开支</van-button>
        <van-button size="small" plain type="warning" @click="$router.push('/payables')">待付款账单</van-button>
      </div>
    </div>

    <!-- 缺货预警 -->
    <div class="card">
      <div class="card-title">
        <van-icon name="warning-o" color="#ff976a" />
        <span class="grow">缺货预警</span>
        <van-button size="mini" plain type="primary" @click="$router.push('/stock')">去补货</van-button>
      </div>
      <div v-if="!lowStock.length" class="empty">库存充足，暂无缺货商品 🎉</div>
      <div
        v-for="p in lowStock.slice(0, 8)"
        :key="p.id"
        class="list-item"
        @click="$router.push({ path: '/stock', query: { mv: p.id } })"
      >
        <div class="row">
          <span class="grow item-title">{{ p.name }}</span>
          <span class="danger-text">{{ fmtStock(p) }}</span>
        </div>
        <div class="item-meta">{{ p.category || '—' }}</div>
      </div>
      <div v-if="lowStock.length > 8" class="muted" style="margin-top:8px;">共 {{ lowStock.length }} 项缺货，仅显示前 8 项</div>
    </div>

    <!-- 最近动态 -->
    <div class="card">
      <div class="card-title"><van-icon name="records" color="#1989fa" /> 最近动态</div>
      <div class="seg" style="margin-bottom:6px;">
        <div class="seg-item" :class="{ active: feedTab === 'out' }" @click="feedTab = 'out'">最近出库</div>
        <div class="seg-item" :class="{ active: feedTab === 'in' }" @click="feedTab = 'in'">最近入库</div>
      </div>
      <template v-if="feedTab === 'out'">
        <div v-if="!recentOutbounds.length" class="empty">暂无出库记录</div>
        <div v-for="(o, i) in recentOutbounds" :key="i" class="list-item" @click="$router.push('/outbound')">
          <div class="row">
            <span class="grow item-title ellipsis">{{ o.code }}</span>
            <span class="bold">{{ fmtMoney(o.amount) }}</span>
          </div>
          <div class="item-meta">{{ o.customer || '—' }} · {{ o.date }} · 净利 {{ fmtMoney(o.net) }}</div>
        </div>
      </template>
      <template v-else>
        <div v-if="!recentInbounds.length" class="empty">暂无入库记录</div>
        <div v-for="(r, i) in recentInbounds" :key="i" class="list-item" @click="$router.push('/inbound')">
          <div class="row">
            <span class="grow item-title ellipsis">{{ r.product_name }}</span>
            <span class="bold">{{ fmtMoney(r.amount) }}</span>
          </div>
          <div class="item-meta">{{ r.code }} · {{ fmtNum(r.quantity) }}{{ r.unit }} · {{ r.date }}</div>
        </div>
      </template>
    </div>

    <!-- 功能宫格 -->
    <div class="card">
      <div class="card-title"><van-icon name="apps-o" color="#1989fa" /> 全部功能</div>
      <van-grid :column-num="4" :border="false">
        <van-grid-item icon="goods-collect-o" text="商品管理" @click="$router.push('/products')" />
        <van-grid-item icon="logistics" text="一单多货" @click="$router.push('/packrules')" />
        <van-grid-item icon="bar-chart-o" text="财务报表" @click="$router.push('/report')" />
        <van-grid-item icon="bag-o" text="鲜货现采" @click="$router.push('/fresh')" />
        <van-grid-item icon="gold-coin-o" text="扣点" @click="$router.push('/deduction')" />
        <van-grid-item icon="send-gift-o" text="快递费" @click="$router.push('/express')" />
        <van-grid-item icon="setting-o" text="设置" @click="$router.push('/settings')" />
      </van-grid>
    </div>

    <!-- AI 识别确认弹层 -->
    <van-popup v-model:show="confirmShow" position="bottom" round :style="{ height: '94%' }">
      <div class="sheet-body ai-sheet">
        <div class="sheet-title">确认{{ aiForm.type === 'inbound' ? '入库' : '出库' }}</div>

        <div class="seg" style="margin-bottom:10px;">
          <div class="seg-item" :class="{ active: aiForm.type === 'inbound' }" @click="aiForm.type = 'inbound'">入库</div>
          <div class="seg-item" :class="{ active: aiForm.type === 'outbound' }" @click="aiForm.type = 'outbound'">出库</div>
        </div>

        <img v-if="aiForm.image_url" :src="assetUrl(aiForm.image_url)" class="ai-img" />

        <van-cell-group inset>
          <van-field v-model="aiForm.date" label="日期" type="date" />
          <van-field v-if="aiForm.type === 'inbound'" v-model="aiForm.supplier" label="供应商" placeholder="可留空" />
          <van-field v-else v-model="aiForm.customer" label="客户" placeholder="可留空" />
          <van-field v-model="aiForm.remark" label="备注" placeholder="可留空" />
        </van-cell-group>

        <div class="divider"></div>
        <div class="row" style="justify-content:space-between;margin-bottom:6px;">
          <span class="bold">明细（{{ aiForm.lines.length }} 行）</span>
          <span class="muted">点商品名可换成别的商品</span>
        </div>

        <div v-for="(ln, i) in aiForm.lines" :key="i" class="ai-line">
          <div class="row" style="justify-content:space-between;">
            <span class="grow ai-line-name" @click="replaceLine(i)">
              {{ ln.product_name || '未识别' }}
              <van-tag v-if="ln.new_product" type="warning" plain style="margin-left:4px;">提交后新增</van-tag>
            </span>
            <van-icon name="delete-o" color="#ee0a24" @click="aiForm.lines.splice(i, 1)" />
          </div>
          <van-field
            v-if="ln.new_product"
            v-model="ln.new_name"
            label="新商品名"
            placeholder="可修改后提交"
            style="margin-top:6px;background:#fff7e6;border-radius:6px;"
          />
          <div class="row mt8">
            <van-field v-model="ln.quantity" type="number" label="数量" />
            <van-field v-model="ln.unit" label="单位" style="max-width:86px;" />
            <van-field v-model="ln.unit_price" type="number" label="单价" placeholder="可留空" />
          </div>
          <div v-if="ln.price_defaulted" class="muted" style="margin-top:4px;">单价未识别，已按该商品最近一次录入价回填，请核对</div>
          <div v-if="ln.hint" class="muted" style="margin-top:4px;">{{ ln.hint }}</div>
          <!-- 是否已付款：滑动开关（自带开/关动画），默认已付款，关掉则这笔列入「待付款账单」 -->
          <div class="row" style="gap:10px;margin-top:8px;align-items:center;">
            <van-switch
              v-model="ln.paid"
              size="20"
              active-color="#2ea24f"
              inactive-color="#c9d1d9"
            />
            <span class="muted" style="font-size:12px;">
              <span :style="ln.paid ? 'color:#2ea24f;font-weight:600;' : 'color:#b45309;font-weight:600;'">{{ ln.paid ? '已付款' : '待付款' }}</span>
              · {{ ln.paid ? '直接进报表' : '列入待付款账单' }}
            </span>
          </div>
        </div>
        <div v-if="!aiForm.lines.length" class="empty">无明细，请重新识别</div>

        <div class="sheet-foot">
          <van-button block plain @click="confirmShow = false">取消</van-button>
          <van-button block type="primary" :loading="submitting" @click="submitAI">确认提交</van-button>
        </div>
      </div>
    </van-popup>

    <ProductPicker
      v-model:show="pickerShow"
      title="选择商品"
      :products="allProducts"
      :note-stock="false"
      @pick="onReplaceProduct"
    />
  </div>
</template>

<script setup>
import { ref, reactive, onMounted, onActivated } from 'vue'
import { showToast, showImagePreview } from 'vant'
import api, { aiStream, assetUrl } from '../api'
import ProductPicker from '../components/ProductPicker.vue'
import { fmtMoney, fmtNum, fmtStock, todayStr } from '../utils/format'

const userName = ref('')
const todayDate = todayStr()
const todayStats = ref({})
const month = ref({})
const stockValue = ref(0)
const productCount = ref(0)
const lowStock = ref([])
const recentInbounds = ref([])
const recentOutbounds = ref([])
const feedTab = ref('out')

// AI
const aiText = ref('')
const thinking = ref('')   // 模型思考过程
const answer = ref('')     // 模型正式输出（JSON）
const aiStage = ref('')    // 当前阶段提示
const busy = ref(false)
const busyImg = ref(false)
const aiPending = ref([])  // 待识别图片：[{ file, url }]（选好后先预览，确认才开始识别）
const thinkOpen = ref(false)  // 原始思考（该模型只能用英文）默认收起
const confirmShow = ref(false)
const submitting = ref(false)
const camInput = ref(null)
const albumInput = ref(null)
const allProducts = ref([])
const pickerShow = ref(false)
let replaceIndex = -1
let abortCtrl = null
let waitNext = null
let batchCancelled = false   // 取消后不再继续识别下一张（两张之间的确认框阶段没有在途请求，abort 拦不住）

const aiForm = reactive({
  type: 'inbound', date: todayStr(), supplier: '', customer: '', remark: '', lines: [], image_url: '',
})

const load = async () => {
  try {
    const d = await api('/api/dashboard')
    userName.value = d.user_name || ''
    todayStats.value = d.today_summary || {}
    month.value = d.month_summary || {}
    stockValue.value = d.stock_value || 0
    productCount.value = d.product_count || 0
    lowStock.value = d.low_stock || []
    recentInbounds.value = d.recent_inbounds || []
    recentOutbounds.value = d.recent_outbounds || []
  } catch (e) {
    showToast(e.message || '加载失败')
  }
}
onMounted(load)
onActivated(load)

async function ensureProducts() {
  if (allProducts.value.length) return
  try { allProducts.value = await api('/api/products') } catch (e) {}
}

/* ---------------- AI 识别 ---------------- */
function pickImages(src) {
  const el = src === 'camera' ? camInput.value : albumInput.value
  el && el.click()
}

/* 待识别图片：选图后先预览，按回车 / 点「识别并录入」才开始识别 */
function addPending(files) {
  const list = Array.from(files || []).filter((f) => f && /^image\//.test(f.type || ''))
  if (!list.length) return
  list.forEach((f) => aiPending.value.push({ file: f, url: URL.createObjectURL(f) }))
  showToast(`已添加 ${list.length} 张图片，按回车或点「识别并录入」开始识别`)
}
function removePending(i) {
  const it = aiPending.value.splice(i, 1)[0]
  if (it && it.url) URL.revokeObjectURL(it.url)
}
function clearPending() {
  aiPending.value.forEach((it) => { if (it && it.url) URL.revokeObjectURL(it.url) })
  aiPending.value = []
}
function previewPending(i) {
  showImagePreview({ images: aiPending.value.map((it) => it.url), startPosition: i })
}
function onFiles(e) {
  const files = Array.from(e.target.files || [])
  e.target.value = ''
  addPending(files)
}
// 回车 /「识别并录入」统一入口：有待识别图片就先识别图片，否则解析文字
async function aiRun() {
  if (busy.value || busyImg.value) { showToast('正在识别中，可先点「取消」'); return }
  if (aiPending.value.length) { await runImageBatch(aiPending.value.map((it) => it.file)); return }
  await aiParse()
}

const AI_TEXT_MAX = 8000
function _cap(t) { return t.length > AI_TEXT_MAX ? '…（前面内容略）\n' + t.slice(-AI_TEXT_MAX) : t }
// 模型原始思考（reasoning_content，该模型只能是英文）：收起时用阶段行报进度，避免"一片空白"
function pushThink(s) {
  if (!s) return
  thinking.value = _cap(thinking.value + s)
  if (!thinkOpen.value) {
    aiStage.value = `模型正在思考…（已 ${thinking.value.length} 字；原始思考为英文，中文思路稍后在下方输出）`
  }
}
function pushAnswer(s) {                 // 模型正式输出：中文「思路」+ JSON
  if (!s) return
  if (!answer.value) aiStage.value = '正在输出中文思路与识别结果…'
  answer.value = _cap(answer.value + s)
}
function resetThinking() { thinking.value = ''; answer.value = ''; aiStage.value = ''; thinkOpen.value = false }

async function aiParse() {
  const text = aiText.value.trim()
  if (!text) { showToast('请输入描述'); return }
  busy.value = true
  resetThinking()
  abortCtrl = new AbortController()
  try {
    const r = await aiStream('/api/ai/parse/stream', { text },
      (d) => pushAnswer(d), null, abortCtrl.signal,
      (t) => pushThink(t), (s) => { aiStage.value = s })
    openConfirm(r)
  } catch (e) {
    if (e.name !== 'AbortError') { aiStage.value = '识别失败'; pushThink('\n⚠ 识别失败：' + e.message); showToast('识别失败：' + e.message) }
  }
  busy.value = false
  abortCtrl = null   // 保留思考过程供回看
}

async function runImageBatch(files) {
  batchCancelled = false
  busyImg.value = true
  let aborted = false
  for (let i = 0; i < files.length; i++) {
    if (batchCancelled) break
    resetThinking()
    abortCtrl = new AbortController()
    try {
      const fd = new FormData()
      fd.append('file', files[i])
      // 输入框里的文字作为「补充说明」一起发给 AI（如「京东8号->8号纸箱」）
      const extra = aiText.value.trim()
      if (extra) fd.append('text', extra)
      const r = await aiStream('/api/ai/parse-image/stream', null,
        (d) => pushAnswer(d), fd, abortCtrl.signal,
        (t) => pushThink(t), (s) => { aiStage.value = s })
      openConfirm(r)
    } catch (err) {
      if (err.name === 'AbortError') { aborted = true; break }
      aiStage.value = '识别失败'
      pushThink(`\n⚠ 第 ${i + 1} 张识别失败：${err.message}`)
      showToast(`第 ${i + 1} 张识别失败：${err.message}`)
    }
    // 多张连传逐张确认：等用户关掉确认框再继续下一张
    if (i < files.length - 1 && confirmShow.value) {
      await new Promise((res) => { waitNext = res })
    }
  }
  busyImg.value = false
  abortCtrl = null   // 保留思考过程供回看
  if (!aborted && !batchCancelled) clearPending()   // 整批识别完成；取消则保留预览图，方便重试
}

function cancelAI() {
  batchCancelled = true
  if (abortCtrl) { try { abortCtrl.abort() } catch (e) {} }
  busy.value = false
  busyImg.value = false
  resetThinking()
  if (waitNext) { waitNext(); waitNext = null }
}

function openConfirm(r) {
  if (!r) return
  aiForm.type = r.type === 'outbound' ? 'outbound' : 'inbound'
  aiForm.date = r.date || todayStr()
  aiForm.supplier = r.supplier || ''
  aiForm.customer = r.customer || ''
  aiForm.remark = r.remark || ''
  aiForm.image_url = r.image_url || ''
  aiForm.lines = (r.lines || []).map((ln) => {
    let product_id = ln.product_id
    let unit_price = ln.unit_price
    let price_defaulted = !!ln.price_defaulted
    // 相似商品：默认选中第一个候选，并在未识别到价格时回填它最近一次的录入价
    if (ln.ambiguous && ln.candidates && ln.candidates.length) {
      if (!ln.candidates.some((c) => c.product_id === product_id)) product_id = ln.candidates[0].product_id
      const c = ln.candidates.find((c) => c.product_id === product_id)
      if (!(+unit_price) && c && c.last_price) { unit_price = c.last_price; price_defaulted = true }
    }
    return {
      product_id,
      product_name: ln.product_name,
      quantity: ln.quantity,
      unit: ln.unit,
      unit_price,
      auto_created: !!ln.auto_created,
      new_product: ln.new_product || null,   // 待新增商品：提交时才建档
      new_name: (ln.new_product && ln.new_product.name) || '',   // 新商品名字（可改）
      price_defaulted,
      hint: ln.hint || '',
      paid: true,   // 默认已付款；可关掉把该笔列入「待付款账单」
    }
  })
  confirmShow.value = true
}

async function replaceLine(i) {
  replaceIndex = i
  await ensureProducts()
  pickerShow.value = true
}
async function onReplaceProduct(p) {
  const ln = aiForm.lines[replaceIndex]
  if (!ln) return
  ln.product_id = p.id
  ln.product_name = p.name
  ln.new_product = null                     // 已改选为系统已有商品，不再新增
  if (!ln.unit) ln.unit = p.default_unit || p.base_unit
  // 单价为空、或上一版价格是自动回填的：按新商品最近一次的录入价刷新
  if (!(+ln.unit_price) || ln.price_defaulted) {
    try {
      const d = await api(`/api/ai/last-price?product_id=${p.id}&op_type=${aiForm.type}`)
      if (d && d.price) { ln.unit_price = d.price; ln.price_defaulted = true }
      else if (ln.price_defaulted) { ln.unit_price = ''; ln.price_defaulted = false }
    } catch (e) { /* 忽略 */ }
  }
}

async function submitAI() {
  const lines = aiForm.lines.filter((l) => (l.product_id || l.new_product) && +l.quantity > 0)
  if (!lines.length) { showToast('没有有效的明细行'); return }
  submitting.value = true
  const inv = aiForm.image_url ? `[票据] ${aiForm.image_url}` : ''
  try {
    // 1) 先创建确认为新物品的商品档案（取消则不会创建，避免污染商品资料）
    const pend = lines.filter((l) => !l.product_id && l.new_product)
    if (pend.length) {
      const d = await api('/api/ai/products', 'POST', {
        items: pend.map((l) => ({
          name: (l.new_name || '').trim() || l.new_product.name,
          category: l.new_product.category || 'stock',
          unit: l.unit || l.new_product.unit || '个',
        })),
      })
      ;(d.items || []).forEach((it, k) => { if (pend[k]) pend[k].product_id = it.product_id })
    }
    const ok = lines.filter((l) => l.product_id)
    if (!ok.length) { showToast('商品创建失败，请稍后重试'); submitting.value = false; return }
    // 2) 再写入单据
    if (aiForm.type === 'inbound') {
      for (const ln of ok) {
        await api('/api/inbounds', 'POST', {
          product_id: +ln.product_id,
          unit: ln.unit || '个',
          quantity: +ln.quantity,
          unit_price: +ln.unit_price || 0,
          supplier: aiForm.supplier,
          date: aiForm.date,
          remark: [inv, ln.auto_created ? '[AI自动新增]' : '', aiForm.remark].filter(Boolean).join(' '),
          pay_status: ln.paid === false ? 'unpaid' : 'paid',
        })
      }
    } else {
      // 已付款 / 待付款 分单：这样「待付款」的各笔会独立进入「待付款账单」，其余进报表
      const groups = { paid: [], unpaid: [] }
      ok.forEach((ln) => groups[ln.paid === false ? 'unpaid' : 'paid'].push(ln))
      for (const st of ['paid', 'unpaid']) {
        const g = groups[st]
        if (!g.length) continue
        await api('/api/outbounds', 'POST', {
          customer: aiForm.customer,
          date: aiForm.date,
          remark: [inv, aiForm.remark].filter(Boolean).join(' '),
          lines: g.map((ln) => ({
            product_id: +ln.product_id,
            unit: ln.unit || '个',
            quantity: +ln.quantity,
            price: +ln.unit_price || 0,
          })),
          pack_lines: [],
          pay_status: st,
        })
      }
    }
    showToast(aiForm.type === 'inbound' ? '入库成功' : '出库成功')
    confirmShow.value = false
    aiText.value = ''
    aiForm.lines = []
    load()
    if (waitNext) { waitNext(); waitNext = null }
  } catch (e) {
    showToast('提交失败：' + e.message)
  }
  submitting.value = false
}
</script>

<style scoped>
.hello { font-size: 17px; font-weight: 700; }
.quick-row { display: flex; gap: 8px; flex-wrap: wrap; margin-top: 10px; }
/* 统计卡可点击（跳财务报表）*/
.stat.tappable { cursor: pointer; transition: transform .08s ease, background .15s ease; }
.stat.tappable:active { transform: scale(.97); background: #f2f6ff; }
/* 待识别图片预览 */
.pending-box { margin-top: 8px; }
.pending-list { display: flex; flex-wrap: wrap; gap: 8px; }
.pending-item { position: relative; width: 72px; height: 72px; border: 1px solid #ebedf0; border-radius: 8px; overflow: hidden; }
.pending-item img { width: 100%; height: 100%; object-fit: cover; display: block; }
.pending-x {
  position: absolute; top: 0; right: 0; padding: 2px;
  background: rgba(0, 0, 0, .55); color: #fff;
  font-size: 12px; border-bottom-left-radius: 8px;
}
.danger-text { color: #ee0a24; font-weight: 600; font-variant-numeric: tabular-nums; }
.think-box { margin-top: 10px; background: #f2f3f5; border-radius: 8px; padding: 8px; }
.think-box pre { font-size: 12px; color: #646566; white-space: pre-wrap; word-break: break-all; max-height: 160px; overflow: auto; margin-top: 6px; }
.think-sub { font-size: 11px; font-weight: 600; color: #969799; margin-top: 8px; }
.think-answer { background: #eef6ff; border-radius: 6px; padding: 6px; color: #323233 !important; }
.ai-img { width: 100%; max-height: 200px; object-fit: contain; border-radius: 8px; margin-bottom: 10px; background: #f7f8fa; }
.ai-line { padding: 10px 0; border-bottom: 1px solid #f5f5f5; }
.ai-line-name { font-weight: 600; font-size: 14px; }
/* AI 确认弹层：撑满可用高度 + 底部按钮吸底，明细多时也不会被挤没 */
.ai-sheet { display: flex; flex-direction: column; max-height: 88vh; }
.ai-sheet .sheet-foot { position: sticky; bottom: 0; background: #fff; padding: 10px 0 4px; }
:deep(.van-grid-item__content) { padding: 10px 4px; }
:deep(.van-grid-item__text) { font-size: 12px; }
</style>
