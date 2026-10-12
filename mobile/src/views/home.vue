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
        <van-grid-item
          v-for="m in navModules"
          :key="m.key"
          :icon="m.icon"
          :text="m.label"
          @click="$router.push(m.to)"
        />
      </van-grid>
      <div v-if="!navModules.length" class="muted">
        全部功能入口都隐藏了，可到「设置 → 模块显示」恢复
      </div>
    </div>

    <!-- AI 识别确认弹层 -->
    <van-popup v-model:show="confirmShow" position="bottom" round :style="{ height: '94%' }">
      <div class="sheet-body ai-sheet">
        <div class="sheet-title">{{ aiTitle }}</div>

        <div class="seg" style="margin-bottom:10px;">
          <div class="seg-item" :class="{ active: aiForm.type === 'inbound' }" @click="setAiType('inbound')">入库</div>
          <div class="seg-item" :class="{ active: aiForm.type === 'outbound' }" @click="setAiType('outbound')">出库</div>
          <div class="seg-item" :class="{ active: aiForm.type === 'stocktake' }" @click="setAiType('stocktake')">盘点</div>
        </div>

        <img v-if="aiForm.image_url" :src="assetUrl(aiForm.image_url)" class="ai-img" />

        <van-cell-group inset>
          <van-field v-model="aiForm.date" label="整单日期" type="date">
            <template #button>
              <van-button size="mini" plain @click="applyDateAll">应用到所有行</van-button>
            </template>
          </van-field>
          <div v-if="dateCount > 1" class="muted" style="padding:0 16px 8px;">
            已按票据逐行取日期：{{ dateRange[0] }} ~ {{ dateRange[dateRange.length - 1] }}（共 {{ dateCount }} 天），每行可单独改
          </div>
          <van-field v-if="aiForm.type === 'inbound'" v-model="aiForm.supplier" label="供应商" placeholder="可留空" />
          <van-field v-else-if="aiForm.type === 'outbound'" v-model="aiForm.customer" label="客户" placeholder="可留空" />
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
          <div v-if="aiForm.type === 'stocktake'" class="row mt8">
            <van-field
              v-model="ln.counted"
              type="number"
              label="实盘数"
              placeholder="改成实际盘到的数"
              @update:model-value="recalcStock(i)"
            />
            <van-field v-model="ln.unit" label="单位" style="max-width:86px;" @update:model-value="recalcStock(i)" />
          </div>
          <div v-else class="row mt8">
            <van-field v-model="ln.quantity" type="number" label="数量" />
            <van-field v-model="ln.unit" label="单位" style="max-width:86px;" />
            <van-field v-model="ln.unit_price" type="number" label="单价" placeholder="可留空" />
          </div>
          <div v-if="aiForm.type === 'stocktake'" class="muted" style="margin-top:4px;">
            {{ ln.stockHint || '改成你实际盘到的数，提交时按「实盘数 − 当前库存」调整库存' }}
          </div>
          <!-- 该行的单据日期（对账单/送货单逐行日期），提交时按它生成单据 -->
          <div class="row mt8">
            <van-field v-model="ln.date" type="date" label="单据日期" style="max-width:210px;" />
          </div>
          <div v-if="aiForm.type !== 'stocktake' && ln.price_defaulted" class="muted" style="margin-top:4px;">单价未识别，已按该商品最近一次录入价回填，请核对</div>
          <div v-if="aiForm.type !== 'stocktake' && ln.hint" class="muted" style="margin-top:4px;">{{ ln.hint }}</div>
          <!-- 是否已付款：滑动开关（自带开/关动画），默认已付款，关掉则这笔列入「待付款账单」 -->
          <div v-if="aiForm.type !== 'stocktake'" class="row" style="gap:10px;margin-top:8px;align-items:center;">
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

        <!-- AI 出库：关联结算（包材 / 快递）+ 固定成本 + 实收金额核对，口径与提交一致 -->
        <template v-if="aiForm.type === 'outbound' && aiOut">
          <div class="divider"></div>
          <div class="bold">包材 / 人工 / 快递（识别到的费用项，可改）</div>
          <div class="muted" style="margin-top:4px;">
            商品没挂对就在「商品」里改；工时 / 胶带这类改成「固定成本」按金额记，金额会写进备注。
          </div>
          <div v-if="aiOut.previewHint" class="alert" :class="aiOut.preview ? 'ok' : 'warn'">{{ aiOut.previewHint }}</div>
          <div v-if="!aiOut.charges.length" class="muted" style="margin-top:6px;">没识别到费用项（气泡膜、泡沫箱这类可点下面「＋ 添加」手动加）。</div>
          <div v-for="(c, ci) in aiOut.charges" :key="ci" class="ai-charge">
            <div class="row">
              <van-field v-model="c.name" label="项目" placeholder="如 泡沫箱" />
              <van-icon name="delete-o" color="#ee0a24" @click="aiOut.charges.splice(ci, 1)" />
            </div>
            <div class="row mt8" style="gap:8px;align-items:center;">
              <span class="muted">记到哪</span>
              <select class="pick" v-model="c.kind">
                <option value="pack">包材 / 耗材</option>
                <option value="labor">人工</option>
                <option value="express">快递费</option>
                <option value="fee">固定成本（按金额）</option>
              </select>
              <div class="grow"></div>
              <van-field v-model="c.amount" type="number" label="金额" style="max-width:150px;" />
            </div>
            <div v-if="c.kind === 'pack' || c.kind === 'labor'" class="row mt8" style="gap:8px;align-items:center;">
              <span class="muted grow ellipsis" @click="openChargeProduct(ci)">商品：{{ chargeProdName(c) }}（点击选择）</span>
              <van-field v-model="c.quantity" type="number" label="数量" style="max-width:150px;" />
            </div>
          </div>
          <div class="row" style="gap:8px;margin-top:8px;flex-wrap:wrap;">
            <van-button size="mini" plain @click="aiAddCharge">＋ 添加包材 / 人工</van-button>
            <van-button size="mini" plain :loading="aiRecalcBusy" @click="aiChargesRefresh">重算（改完商品 / 数量点一下）</van-button>
          </div>
          <div class="muted" style="margin-top:6px;">固定成本合计 {{ fmtMoney(aiFeeSum) }}</div>

          <div class="divider"></div>
          <div class="bold">商品包装清单自动带出 / 按重量算的快递费</div>
          <div v-if="!aiAutoPack.length" class="muted" style="margin-top:4px;">无（该商品没有包装清单，也没有自动快递费）</div>
          <div v-for="(p, pi) in aiAutoPack" :key="pi" class="list-item">
            <div class="row">
              <span class="grow">{{ p.product_name }}</span>
              <span class="muted">{{ fmtNum(p.quantity) }}{{ p.unit }} · {{ fmtMoney(p.amount) }}</span>
            </div>
            <div class="muted">{{ settleCatLabel(p.settle_cat) }}</div>
          </div>

          <div class="divider"></div>
          <div class="bold">实收金额包含（客户随货款一起付的）</div>
          <van-checkbox-group v-model="aiOut.settleCats" direction="horizontal" style="margin-top:6px;">
            <van-checkbox
              v-for="c in SETTLE_OPTS"
              :key="c.key"
              :name="c.key"
              shape="square"
              style="margin:0 12px 6px 0;"
            >{{ c.label }}</van-checkbox>
          </van-checkbox-group>
          <div class="muted">{{ aiSettleText }}</div>
        </template>

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

    <!-- 费用项商品选择（包材 / 人工 / 快递费） -->
    <ProductPicker
      v-model:show="chargePickerShow"
      title="选择费用项商品"
      :products="chargeProducts"
      :type-tabs="false"
      :note-stock="false"
      @pick="onChargeProductPick"
    />
  </div>
</template>

<script setup>
import { ref, reactive, computed, onMounted, onActivated } from 'vue'
import { showToast, showImagePreview } from 'vant'
import api, { aiStream, assetUrl } from '../api'
import ProductPicker from '../components/ProductPicker.vue'
import { fmtMoney, fmtNum, fmtStock, num, unitFactor, defaultUnit, todayStr } from '../utils/format'
import { NAV_MODULES, getHiddenNav } from '../utils/navModules'

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

// 工作台「全部功能」宫格：按本机偏好显隐（设置 → 模块显示）
const navHidden = ref(getHiddenNav())
const navModules = computed(() => NAV_MODULES.filter((m) => !navHidden.value.includes(m.key)))

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
    await openConfirm(r)
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
      await openConfirm(r)
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

const aiTitle = computed(() => ({
  inbound: '确认入库',
  outbound: '确认出库',
  stocktake: '确认盘点（按实盘数调整库存）',
}[aiForm.type] || '确认'))

/** 切换业务类型（入库 / 出库 / 盘点）：切到盘点要按当前库存把每行的增减量算出来 */
function setAiType(t) {
  aiForm.type = t
  if (t === 'stocktake') {
    ensureProducts().then(() => aiForm.lines.forEach((ln, i) => recalcStock(i)))
  }
}

/* ---------- AI 出库：关联结算 / 固定成本 / 实收金额（口径与提交完全一致） ---------- */
const SETTLE_OPTS = [
  { key: 'material', label: '包材 / 耗材' },
  { key: 'labor', label: '人工（打包费）' },
  { key: 'express', label: '快递费' },
  { key: 'fee', label: '固定成本' },
]
const SETTLE_LABEL = { material: '包材', labor: '人工', express: '快递费', fee: '固定成本' }
const settleCatLabel = (k) => SETTLE_LABEL[k] || '其他'
const aiOut = ref(null)
const aiRecalcBusy = ref(false)
const chargePickerShow = ref(false)
let chargeIndex = -1

/** 费用项可选商品：包材 / 耗材 / 包装 / 人工 */
const chargeProducts = computed(() => allProducts.value.filter((p) => {
  if (!p.is_active) return false
  const c = (p.category || '').trim()
  return ['包材', '耗材', '包装', '人工'].includes(c) || /打包$/.test(p.name || '')
}))
/** 商品包装清单自动带出 / 按重量算的快递费（识别出来的费用项在 charges 里） */
const aiAutoPack = computed(() => ((aiOut.value && aiOut.value.packLines) || []).filter((p) => p.source !== '识别'))
/** 固定成本合计（「记到哪 = 固定成本」的那些之和） */
const aiFeeSum = computed(() => {
  const list = ((aiOut.value && aiOut.value.charges) || []).filter((c) => c.kind === 'fee')
  return Math.round(list.reduce((s, c) => s + num(c.amount), 0) * 100) / 100
})
/** 客户代收 = 勾选类别的关联结算行金额 ＋（勾了固定成本时）固定成本合计 */
const aiSettleIncome = computed(() => {
  const o = aiOut.value
  if (!o) return 0
  const cats = o.settleCats || []
  let sum = 0
  ;(o.packLines || []).forEach((p) => {
    if (cats.includes(p.settle_cat || 'material')) sum += num(p.amount)
  })
  if (cats.includes('fee')) sum += aiFeeSum.value
  return Math.round(sum * 100) / 100
})
const aiSettleText = computed(() => {
  const o = aiOut.value
  if (!o || !o.preview) return '货价 / 结转成本以服务端预览为准，改动后点「重算」'
  const amount = num(o.preview.amount)
  const cogs = num(o.preview.cogs)
  const settle = aiSettleIncome.value
  return `货价 ${fmtMoney(amount)} ＋ 代收 ${fmtMoney(settle)} = 实收 ${fmtMoney(amount + settle)} · 结转成本 ${fmtMoney(cogs)} · 毛利 ${fmtMoney(amount + settle - cogs)}`
})

function initAiOut(r) {
  const cats = String((r && r.settle_cats) || '').split(',').filter(Boolean)
  aiOut.value = {
    charges: ((r && r.charges) || []).map((c) => ({ ...c })),
    packLines: (r && r.pack_lines) || [],
    preview: (r && r.preview) || null,
    previewHint: (r && r.preview_hint) || '',
    extraPackLines: (r && r.extra_pack_lines) || [],
    autoExpress: !r || r.auto_express !== false,
    // AI 出库也是手动单（客户随货款付回包材 / 人工 / 快递费），没识别到口径时兜底全勾
    settleCats: cats.length ? cats : ['material', 'labor', 'express'],
  }
}
function aiAddCharge() {
  if (!aiOut.value) return
  aiOut.value.charges.push({ name: '', kind: 'pack', product_id: 0, unit: '', quantity: 0, amount: 0 })
}
function chargeProdName(c) {
  if (c.product_name) return c.product_name
  const p = allProducts.value.find((x) => x.id === +c.product_id)
  return p ? p.name : '未选'
}
function openChargeProduct(ci) {
  chargeIndex = ci
  ensureProducts().then(() => { chargePickerShow.value = true })
}
function onChargeProductPick(p) {
  const c = aiOut.value && aiOut.value.charges[chargeIndex]
  if (!c) return
  c.product_id = p.id
  c.product_name = p.name
  c.unit = c.unit || defaultUnit(p)
}
/** 当前确认框里的出库行（供重算用；与提交口径一致） */
function aiOutboundLines() {
  return aiForm.lines
    .filter((l) => (l.product_id || l.product_name) && num(l.quantity) > 0)
    .map((l) => ({
      product_id: +l.product_id || 0, product_name: l.product_name || '',
      unit: l.unit, quantity: num(l.quantity), unit_price: num(l.unit_price),
    }))
}
/** 改完商品 / 数量后点「重算」：按服务端口径重算关联结算、固定成本与实收金额 */
async function aiChargesRefresh() {
  const o = aiOut.value
  if (!o) return
  aiRecalcBusy.value = true
  try {
    const d = await api('/api/ai/outbound-preview', 'POST', {
      lines: aiOutboundLines(),
      charges: (o.charges || []).filter((c) => c.name && (num(c.amount) > 0 || num(c.quantity) > 0)),
      fee_total: aiFeeSum.value,
    })
    o.packLines = d.pack_lines || []
    o.preview = d.preview || null
    o.previewHint = d.preview_hint || ''
    o.extraPackLines = d.extra_pack_lines || []
    o.autoExpress = d.auto_express !== false
    if ((d.charges || []).length) o.charges = d.charges
    if ((d.warnings || []).length) showToast('⚠ ' + d.warnings.join('；'))
  } catch (e) { showToast('重算失败：' + e.message) }
  aiRecalcBusy.value = false
}
/** 提交出库时带的附加项（提交要带完整结算清单，否则后端不再自动补商品包装清单） */
function aiChargesForSubmit() {
  const o = aiOut.value
  if (!o) return { pack_lines: [], fee_total: 0, settle_cats: [], auto_express: true, remark: '' }
  // 商品包装清单自动带出的行（服务端会重算，但要一起传）
  const auto = (o.packLines || [])
    .filter((p) => p.source !== '识别')
    .map((p) => ({ product_id: p.product_id, unit: p.unit, quantity: num(p.quantity), cogs: null }))
  // 识别 / 用户改过的项目（含按金额反推数量的：用服务端算好的显式成本）
  const extra = (o.extraPackLines || []).map((p) => ({
    product_id: p.product_id, unit: p.unit, quantity: num(p.quantity),
    cogs: p.cogs != null ? p.cogs : null,
  }))
  const feeItems = (o.charges || []).filter((c) => c.kind === 'fee' && num(c.amount) > 0)
  const feeSum = Math.round(feeItems.reduce((s, c) => s + num(c.amount), 0) * 100) / 100
  return {
    pack_lines: [...auto, ...extra],
    fee_total: feeSum,
    settle_cats: o.settleCats || [],
    auto_express: o.autoExpress !== false,
    // 固定成本写进备注，方便对着结算表核对
    remark: feeItems.length
      ? `【包材人工固定成本】${feeItems.map((c) => `${c.name} ${fmtMoney(num(c.amount))}`).join('、')}（合计 ${fmtMoney(feeSum)}）`
      : '',
  }
}

/** 同种商品的多行合并成一行（数量累加）——与后端 _merge_duplicate_lines 同一口径。
   盘点是「一个商品一个实盘数」：分开提交会在同一商品上反复调整（+3500 再 −16000），净额就错了。 */
function aiMergeDupLines(lines, type) {
  const list = (lines || []).map((x) => ({ ...x }))
  if (list.length < 2) return list
  const isStock = type === 'stocktake'
  const seen = new Map()
  const out = []
  list.forEach((ln) => {
    const pid = +ln.product_id || 0
    if (!pid) { out.push(ln); return }   // 待新增 / 未匹配：可能对应不同档案，不合并
    const key = isStock
      ? `s|${pid}|${ln.stock_unit || ln.unit || ''}`
      : `d|${pid}|${ln.unit || ''}|${+(ln.unit_price || 0)}|${ln.date || ''}|${ln.paid !== false}`
    const first = seen.get(key)
    if (!first) { seen.set(key, ln); out.push(ln); return }
    first.quantity = +(((+first.quantity || 0) + (+ln.quantity || 0)).toFixed(4))
    if (first.stock_counted != null && ln.stock_counted != null) {
      first.stock_counted = +((+first.stock_counted + +ln.stock_counted).toFixed(4))
    }
    first.merged_count = (+first.merged_count || 1) + 1
  })
  out.forEach((ln) => {
    const n = +ln.merged_count || 1
    if (n <= 1) return
    const tip = `已把 ${n} 行合并为一行（${isStock ? '实盘数' : '数量'}累加）`
    ln.hint = ln.hint ? `${ln.hint}；${tip}` : tip
  })
  return out
}

/** 盘点行：按「实盘数 − 当前库存」算增减量（换商品 / 换单位 / 改实盘数都要重算） */
function recalcStock(i) {
  const ln = aiForm.lines[i]
  if (!ln) return
  const p = allProducts.value.find((x) => x.id === +ln.product_id) || null
  const unit = (ln.unit || '').trim()
  // 商品库存按基础单位存，按当前行单位换算（如商品按公斤记录、行单位是斤 → 1公斤=2斤）
  const before = p ? +((num(p.stock) || 0) / (unitFactor(p, unit) || 1)).toFixed(4) : +(num(ln.stock_before) || 0)
  ln.stock_before = before
  const raw = String(ln.counted == null ? '' : ln.counted).trim()
  const counted = raw === '' ? null : parseFloat(raw)
  const valid = counted != null && !isNaN(counted)
  const adj = valid ? +(counted - before).toFixed(4) : 0
  ln.stock_adjust = adj
  ln.stock_after = +(before + adj).toFixed(4)
  ln.stockHint = valid
    ? `当前库存 ${fmtNum(before)}${unit} → 调整 ${adj > 0 ? '+' : ''}${fmtNum(adj)} → 盘点后 ${fmtNum(ln.stock_after)}${unit}`
    : `未填实盘数：该行不调整（当前库存保持 ${fmtNum(before)}${unit}）`
}

async function openConfirm(r) {
  if (!r) return
  const type = ['outbound', 'stocktake'].includes(r.type) ? r.type : 'inbound'
  aiForm.type = type
  aiForm.date = r.date || todayStr()
  aiForm.supplier = r.supplier || ''
  aiForm.customer = r.customer || ''
  aiForm.remark = r.remark || ''
  aiForm.image_url = r.image_url || ''
  aiForm.lines = aiMergeDupLines(r.lines, type).map((ln) => {
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
      date: ln.date || aiForm.date,   // 该行的单据日期（票据逐行日期）
      // 盘点：实盘数（界面可改）→ 提交时按「实盘数 − 当前库存」走 /api/adjust 的增减模式
      counted: ln.stock_counted != null ? String(ln.stock_counted) : (ln.quantity != null ? String(ln.quantity) : ''),
      stock_before: ln.stock_before != null ? +ln.stock_before : null,
      stock_adjust: 0,
      stock_after: null,
      stockHint: '',
    }
  })
  confirmShow.value = true
  // 出库：带上识别阶段算好的包材 / 快递 / 固定成本，供确认框核对与提交
  if (type === 'outbound') initAiOut(r)
  else aiOut.value = null
  if (type === 'stocktake') {
    await ensureProducts()   // 盘点要按「当前库存」算增减量
    aiForm.lines.forEach((ln, i) => recalcStock(i))
  }
}

// 逐行日期统计（对账单常常一行一个日期）
const dateCount = computed(() => new Set(aiForm.lines.map((l) => l.date || aiForm.date)).size)
const dateRange = computed(() => [...new Set(aiForm.lines.map((l) => l.date || aiForm.date))].sort())
function applyDateAll() {
  aiForm.lines.forEach((l) => { l.date = aiForm.date })
  showToast('已把整单日期应用到所有行')
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
  // 识别到的单位不在该商品的可选单位里（如占位的「袋」vs 商品的「公斤」）→ 换成商品默认单位，
  // 否则商品的「公斤」会被「袋」盖住，库存与增减量全按错单位算
  const conv = p.conversions || {}
  const du = defaultUnit(p)
  if (!ln.unit || !(ln.unit in conv || ln.unit === du || ln.unit === p.base_unit)) {
    if (du) ln.unit = du
  }
  // 单价为空、或上一版价格是自动回填的：按新商品最近一次的录入价刷新（盘点没有单价）
  if (aiForm.type !== 'stocktake' && (!(+ln.unit_price) || ln.price_defaulted)) {
    try {
      const d = await api(`/api/ai/last-price?product_id=${p.id}&op_type=${aiForm.type}`)
      if (d && d.price) { ln.unit_price = d.price; ln.price_defaulted = true }
      else if (ln.price_defaulted) { ln.unit_price = ''; ln.price_defaulted = false }
    } catch (e) { /* 忽略 */ }
  }
  recalcStock(replaceIndex)   // 盘点：换了商品必须按新商品的库存重算增减量
}

async function submitAI() {
  const isStock = aiForm.type === 'stocktake'
  const lines = isStock
    ? aiForm.lines.filter((l) => l.product_id && num(l.stock_adjust) !== 0)
    : aiForm.lines.filter((l) => (l.product_id || l.new_product) && +l.quantity > 0)
  if (!lines.length) {
    showToast(isStock ? '没有需要调整的行（实盘数与当前库存一致）' : '没有有效的明细行')
    return
  }
  submitting.value = true
  const inv = aiForm.image_url ? `[票据] ${aiForm.image_url}` : ''
  try {
    // 1) 先创建确认为新物品的商品档案（取消则不会创建，避免污染商品资料）
    const pend = isStock ? [] : lines.filter((l) => !l.product_id && l.new_product)
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
    if (isStock) {
      // 盘点：走既有「库存 → 盘点调整」的相对增减接口（一行一次，增减为 0 的行已在上方过滤）
      let n = 0
      for (const ln of ok) {
        const d = num(ln.stock_adjust)
        await api('/api/adjust', 'POST', {
          product_id: +ln.product_id,
          date: ln.date || aiForm.date,
          quantity: `${d > 0 ? '+' : ''}${+d.toFixed(6)}`,   // 接口要求带符号的相对调整串
          unit: ln.unit,
          operator: userName.value || '',
          remark: [aiForm.remark, inv].filter(Boolean).join(' ') || 'AI盘点',
        })
        n++
      }
      showToast(`盘点完成（调整 ${n} 行）`)
    } else if (aiForm.type === 'inbound') {
      for (const ln of ok) {
        await api('/api/inbounds', 'POST', {
          product_id: +ln.product_id,
          unit: ln.unit || '个',
          quantity: +ln.quantity,
          unit_price: +ln.unit_price || 0,
          supplier: aiForm.supplier,
          date: ln.date || aiForm.date,   // 逐行用各自的单据日期
          remark: [inv, ln.auto_created ? '[AI自动新增]' : '', aiForm.remark].filter(Boolean).join(' '),
          pay_status: ln.paid === false ? 'unpaid' : 'paid',
        })
      }
      showToast('入库成功')
    } else {
      // 按「日期 + 已付款/待付款」分单：日期不同的各成一单，待付款的独立进「待付款账单」
      const groups = new Map()
      ok.forEach((ln) => {
        const key = `${ln.date || aiForm.date}|${ln.paid === false ? 'unpaid' : 'paid'}`
        if (!groups.has(key)) groups.set(key, { date: ln.date || aiForm.date, pay: ln.paid === false ? 'unpaid' : 'paid', lines: [] })
        groups.get(key).lines.push(ln)
      })
      // 关联结算 / 固定成本 / 实收口径（与确认框里核对的一致）
      const charges = aiChargesForSubmit()
      for (const g of groups.values()) {
        await api('/api/outbounds', 'POST', {
          customer: aiForm.customer,
          date: g.date,
          remark: [inv, aiForm.remark, charges.remark].filter(Boolean).join(' '),
          lines: g.lines.map((ln) => ({
            product_id: +ln.product_id,
            unit: ln.unit || '个',
            quantity: +ln.quantity,
            price: +ln.unit_price || 0,
          })),
          pack_lines: charges.pack_lines,
          pack_fee_total: charges.fee_total,
          auto_express: charges.auto_express,
          settle_cats: charges.settle_cats,
          pay_status: g.pay,
        })
      }
      showToast('出库成功')
    }
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
/* AI 出库：费用项 / 实收核对 */
.ai-charge { padding: 8px 0; border-bottom: 1px dashed #f0f0f0; }
.pick {
  font-size: 13px; padding: 3px 6px; border: 1px solid #dcdee0;
  border-radius: 6px; background: #fff; color: #323233; max-width: 46%;
}
.alert { border-radius: 8px; padding: 8px 10px; font-size: 12px; margin-top: 8px; }
.alert.ok { background: #f0f9eb; color: #07c160; }
.alert.warn { background: #fffbe8; color: #ed6a0c; }
:deep(.van-grid-item__content) { padding: 10px 4px; }
:deep(.van-grid-item__text) { font-size: 12px; }
</style>
