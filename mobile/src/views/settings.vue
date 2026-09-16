<script>
// 批量导入（含聚水潭）解析结果的跨页面单例状态：
// <script setup> 的变量随页面卸载重建，用户「去新增商品」再返回会清空解析结果，
// 放到模块作用域后返回时自动恢复，可直接「重新解析」。
const batchStore = {
  kind: 'inbound',
  fileObj: null,
  fileName: '',
  orders: [],
  items: [],
  failed: [],
  unmapped: [],
  skip: {},
  aiPlan: null,
  aiSig: '',
}
</script>

<template>
  <div class="sub-page">
    <van-nav-bar title="设置" left-arrow fixed placeholder @click-left="goBack" />

    <div style="padding:12px;">
      <div class="seg" style="overflow-x:auto;">
        <div v-for="p in panels" :key="p.key" class="seg-item" :class="{ active: panel === p.key }" @click="switchPanel(p.key)">{{ p.label }}</div>
      </div>

      <!-- ==================== 分仓 ==================== -->
      <template v-if="panel === 'wh'">
        <div class="card">
          <div class="card-title">切换分仓</div>
          <div class="muted" style="margin-bottom:8px;">
            分仓只作用于你自己的登录：切换后立即生效、无需重新登录，也不会影响其他在线用户。仅管理员可操作。
          </div>
          <div v-for="w in warehouses" :key="w.key" class="list-item">
            <div class="row">
              <span class="grow item-title">{{ w.name }}</span>
              <span class="muted">{{ w.key }}</span>
              <van-tag v-if="w.is_current" type="primary">当前</van-tag>
              <van-button v-else size="mini" plain type="primary" @click="switchWh(w)">切换</van-button>
            </div>
            <div v-if="w.db" class="item-meta">{{ w.db }}</div>
          </div>
          <div v-if="!warehouses.length" class="empty">暂无分仓信息</div>
          <div class="divider"></div>
          <van-field v-model="newWhName" label="新建分仓" placeholder="如：昆明仓" />
          <van-button block round type="success" :loading="whSaving" style="margin-top:10px;" @click="createWh">新建并切换</van-button>
        </div>
      </template>

      <!-- ==================== 商品资料备份 ==================== -->
      <template v-else-if="panel === 'pdata'">
        <div class="card">
          <div class="card-title">商品资料备份（解耦维护）</div>
          <div class="muted" style="margin-bottom:8px;">
            商品资料按「数据表」拆分为 5 个 JSON 独立保存于后端 <code>backend/json</code>，商品间相互引用用「名称」表达，可跨库 / 跨设备迁移。
          </div>
          <div class="row" style="gap:8px;flex-wrap:wrap;">
            <van-button size="small" type="success" icon="passed" :loading="pdataBusy" @click="pdataExportAll">一键导出到 json 目录</van-button>
            <van-button size="small" type="primary" icon="replay" :loading="pdataBusy" @click="pdataImportAll">从 json 目录一键导入</van-button>
          </div>
          <div v-if="pdataDir" class="muted" style="margin-top:8px;">目录：{{ pdataDir }}</div>
          <div v-if="pdataMsg" class="alert ok">{{ pdataMsg }}</div>
        </div>

        <div class="card">
          <div class="card-title">5 类商品资料</div>
          <div v-for="r in pdataRows" :key="r.kind" class="list-item">
            <div class="row">
              <span class="grow item-title">{{ r.label }}</span>
              <van-tag :type="r.exists ? 'success' : 'default'" plain>{{ r.exists ? '已备份' : '无文件' }}</van-tag>
            </div>
            <div class="item-meta">
              数据库 {{ r.count_in_db }} 条 · 文件 {{ r.count_in_file }} 条
              <template v-if="r.exists"> · {{ r.mtime }}</template>
            </div>
            <div class="row" style="gap:8px;margin-top:6px;">
              <van-button size="mini" plain icon="down" @click="pdataDownload(r)">下载</van-button>
              <van-button size="mini" plain type="primary" @click="pdataImportOne(r)">从 json 导入</van-button>
            </div>
          </div>
        </div>

        <div class="card">
          <div class="card-title">从本地上传 JSON 导入</div>
          <div class="muted" style="margin-bottom:8px;">可在任意电脑编辑 JSON 后上传，按名称导入（upsert），便于手动维护与迁移。</div>
          <van-button size="small" plain icon="upgrade" @click="pdataFile && pdataFile.click()">选择 JSON 文件并导入</van-button>
          <input ref="pdataFile" type="file" accept=".json,.txt" style="display:none" @change="pdataUpload" />
          <div v-if="pdataUploadMsg" class="alert ok">{{ pdataUploadMsg }}</div>
        </div>
      </template>

      <!-- ==================== 备份与恢复 ==================== -->
      <template v-else-if="panel === 'backup'">
        <div class="card">
          <div class="card-title">自动备份设置</div>
          <div class="muted" style="margin-bottom:8px;">默认开启，每 2 小时备份一次到 data/backups，超出保留份数自动清理旧备份。</div>
          <van-field label="开启自动备份">
            <template #input><van-switch v-model="bk.enabled" size="20" /></template>
          </van-field>
          <van-field v-model="bk.interval_hours" type="number" label="备份间隔">
            <template #button><span class="muted">小时</span></template>
          </van-field>
          <van-field v-model="bk.keep" type="number" label="保留份数">
            <template #button><span class="muted">份</span></template>
          </van-field>
          <div class="row" style="gap:8px;margin-top:10px;">
            <van-button size="small" type="primary" :loading="bkSaving" @click="saveBkConfig">保存设置</van-button>
            <van-button size="small" type="success" icon="passed" :loading="bkCreating" @click="createBackup">立即备份</van-button>
          </div>
        </div>

        <div class="card">
          <div class="card-title">备份列表</div>
          <div class="muted" style="margin-bottom:8px;">恢复会用所选备份覆盖当前数据库，请谨慎操作。</div>
          <div v-if="!bkList.length" class="empty">暂无备份</div>
          <div v-for="b in bkList" :key="b.name" class="list-item">
            <div class="row">
              <span class="grow item-title ellipsis">{{ b.mtime }}</span>
              <span class="muted">{{ b.size_human }}</span>
            </div>
            <div class="muted ellipsis">{{ b.name }}</div>
            <div class="row" style="gap:8px;margin-top:6px;">
              <van-button size="mini" plain type="warning" @click="restoreBackup(b)">恢复</van-button>
              <van-button size="mini" plain type="danger" @click="delBackup(b)">删除</van-button>
            </div>
          </div>
        </div>
      </template>

      <!-- ==================== 批量导入 ==================== -->
      <template v-else-if="panel === 'import'">
        <div class="card">
          <div class="card-title">导入模板下载</div>
          <div class="row" style="gap:8px;flex-wrap:wrap;">
            <van-button size="small" plain icon="down" @click="downloadTpl('products')">商品导入模板</van-button>
            <van-button size="small" plain icon="down" @click="downloadTpl('inbounds')">入库导入模板</van-button>
            <van-button size="small" plain icon="down" @click="downloadTpl('outbounds')">出库导入模板</van-button>
          </div>
          <div class="alert ok" style="margin-top:10px;">商品模板兼容「柠檬云商品导入模板.xlsx」，整表上传自动识别（编码 / 类别 / 名称 / 规格 / 单位）。</div>
        </div>

        <div class="card">
          <div class="card-title">商品批量导入</div>
          <van-button size="small" plain icon="upgrade" @click="impProdFile && impProdFile.click()">选择 Excel 并导入</van-button>
          <input ref="impProdFile" type="file" accept=".xlsx" style="display:none" @change="importProducts" />
          <div v-if="impProdMsg" class="alert" :class="impProdOk ? 'ok' : 'err'">{{ impProdMsg }}</div>
        </div>

        <div class="card">
          <div class="card-title">入库批量导入</div>
          <div class="muted" style="margin-bottom:8px;">同「单号」自动合并为一单；先解析预览，确认后才真正入库并更新库存。若类别配置了扣点，单价按 原价×(1−扣点%) 自动折算。</div>
          <van-button size="small" plain icon="upgrade" @click="startBatch('inbound')">选择 Excel 并预览</van-button>
        </div>

        <div class="card">
          <div class="card-title">出库批量导入</div>
          <div class="muted" style="margin-bottom:8px;">同「单号」自动合并为一单，自动结转关联材料与费用。</div>
          <van-button size="small" plain icon="upgrade" @click="startBatch('outbound')">选择 Excel 并预览</van-button>
        </div>
      </template>

      <!-- ==================== 聚水潭关联 ==================== -->
      <template v-else>
        <div class="card">
          <div class="card-title">① 上传聚水潭销售出库单并自动新增关联</div>
          <div class="muted" style="margin-bottom:8px;">
            自动新增不存在的订单商品并关键词关联库存商品。需手动维护关联请前往「商品管理」调整商品的关联结算与扣减对象。
          </div>
          <div class="row" style="gap:8px;flex-wrap:wrap;">
            <van-button size="small" type="primary" icon="upgrade" :loading="mpParsing" @click="mpFile && mpFile.click()">解析并自动新增</van-button>
            <van-button size="small" plain icon="fire-o" :loading="mpAuto" @click="autoMapping">自动匹配未关联</van-button>
            <van-button size="small" plain type="danger" @click="clearMapping">清空关联</van-button>
            <van-button size="small" plain icon="down" @click="exportMappings">导出 JSON</van-button>
          </div>
          <input ref="mpFile" type="file" accept=".xlsx" style="display:none" @change="parseJushuitan" />
          <div v-if="mpInfo" class="alert ok">{{ mpInfo }}</div>
          <div v-if="mpCodes.length" class="divider"></div>
          <div v-for="c in mpCodes.slice(0, 50)" :key="c.external_code" class="list-item">
            <div class="row">
              <span class="grow item-title ellipsis">{{ c.external_code }}</span>
              <van-tag :type="c.product_id ? 'success' : 'danger'" plain>{{ c.product_id ? '已关联' : '未关联' }}</van-tag>
            </div>
            <div class="item-meta">
              {{ c.count }} 件{{ c.spec ? ' · ' + c.spec : '' }}
              · {{ c.product_name ? '→ ' + c.product_name : '（无匹配）' }}
              <template v-if="c.score != null"> · 匹配度 {{ (c.score * 100).toFixed(0) }}%</template>
            </div>
          </div>
          <div v-if="mpCodes.length > 50" class="muted" style="margin-top:6px;">共 {{ mpCodes.length }} 个编码，仅显示前 50 个</div>
        </div>

        <div class="card">
          <div class="card-title">② 导入聚水潭出库单（自动结算）</div>
          <div class="muted" style="margin-bottom:8px;">按已保存的关联生成出库单并核算成本；先解析预览，确认后才出库。</div>
          <van-button size="small" type="success" icon="upgrade" @click="startBatch('jushuitan')">选择 Excel 并预览</van-button>
        </div>
      </template>
    </div>

    <!-- ============ 批量导入预览 / 确认 ============ -->
    <van-popup v-model:show="batchShow" position="bottom" round :style="{ height: '90%' }">
      <div class="sheet-body">
        <div class="sheet-title">{{ batchCfg.title }}</div>
        <div class="row wrap" style="gap:8px;margin-bottom:8px;">
          <van-button size="small" plain icon="upgrade" @click="pickFile">选择 Excel</van-button>
          <van-button
            v-if="batchKind === 'jushuitan' && batchFileObj"
            size="small"
            plain
            icon="replay"
            :loading="batchParsing"
            @click="reparse"
          >重新解析{{ batchFileName ? '（' + batchFileName + '）' : '' }}</van-button>
        </div>
        <div v-if="batchParsing" class="empty">正在解析…</div>

        <!-- 聚水潭：不逐单展示，汇总相同商品名的总体预览 -->
        <template v-if="batchKind === 'jushuitan' && batchOrders.length">
          <div class="row" style="justify-content:space-between;margin-bottom:6px;">
            <span class="bold">共 {{ batchOrders.length }} 单 · {{ aggProducts.length }} 种商品</span>
            <span class="bold">合计 {{ fmtMoney(aggTotalAmount) }}</span>
          </div>
          <div v-for="(p, i) in aggProducts" :key="i" class="agg-row">
            <div class="row">
              <span class="grow ellipsis bold">{{ p.name }}</span>
              <span class="muted">{{ p.orders }} 单</span>
            </div>
            <div class="row">
              <span class="grow muted ellipsis">
                单位 {{ p.unit || '—' }} · 总数量 {{ fmtNum(p.qty) }} · 均价 {{ fmtMoney(p.price) }} · 每单 {{ fmtMoney(p.perOrder) }}
              </span>
              <span class="bold">{{ fmtMoney(p.amount) }}</span>
            </div>
            <div v-if="p.deduct" class="muted" style="font-size:11px;">{{ p.deduct }}</div>
          </div>
        </template>

        <template v-else-if="batchOrders.length">
          <div class="row" style="justify-content:space-between;margin-bottom:6px;">
            <span class="bold">解析出 {{ batchOrders.length }} 单</span>
            <van-button size="mini" plain @click="toggleBatchAll">{{ batchAllOn ? '全部取消' : '全部勾选' }}</van-button>
          </div>
          <div v-for="(o, oi) in batchOrders" :key="oi" class="io-row">
            <div class="row">
              <van-checkbox v-model="o._on" style="margin-right:8px;" />
              <span class="grow io-name">{{ o.doc_no || '（无单号）' }}</span>
              <span class="muted">{{ o.date }}</span>
            </div>
            <div class="muted">{{ o.customer || '—' }}{{ o.pack_fee ? ' · 打包费 ' + fmtMoney(o.pack_fee) : '' }}</div>
            <div v-for="(l, li) in o.lines" :key="li" class="batch-line">
              <span class="grow ellipsis">{{ l.product_name }}</span>
              <van-field v-model="l.quantity" type="number" style="width:74px;" />
              <van-field v-model="l.price" type="number" style="width:84px;" />
              <span class="amount">{{ fmtMoney(num(l.quantity) * num(l.price)) }}</span>
            </div>
          </div>
        </template>

        <template v-if="batchItems.length">
          <div class="row" style="justify-content:space-between;margin-bottom:6px;">
            <span class="bold">解析出 {{ batchItems.length }} 行</span>
            <van-button size="mini" plain @click="toggleBatchItemsAll">{{ batchItemsAllOn ? '全部取消' : '全部勾选' }}</van-button>
          </div>
          <div v-for="(it, i) in batchItems" :key="i" class="io-row">
            <div class="row">
              <van-checkbox v-model="it._on" style="margin-right:8px;" />
              <span class="grow io-name">{{ it.product_name }}</span>
              <span class="muted">{{ it.unit }}</span>
            </div>
            <div class="row mt8">
              <van-field v-model="it.quantity" type="number" label="数量" />
              <van-field v-model="it.unit_price" type="number" label="单价" />
              <span class="amount">{{ fmtMoney(num(it.quantity) * num(it.unit_price)) }}</span>
            </div>
            <div class="muted">{{ it.supplier || '无供应商' }} · {{ it.date }}</div>
          </div>
        </template>

        <div v-if="batchUnmapped.length" class="alert warn">
          ⚠ 未关联商品 {{ batchUnmapped.length }} 个，可点「去新增商品」按该名称新建（保存后回来点「重新解析」即按名称自动匹配）：
          <div class="unmapped-list">
            <div v-for="c in batchUnmapped" :key="c" class="unmapped-item">
              <span class="grow ellipsis">{{ c }}</span>
              <van-button size="mini" plain type="primary" icon="plus" @click="goNewProduct(c)">去新增商品</van-button>
            </div>
          </div>
          <div v-if="batchKind === 'jushuitan'" style="margin-top:8px;">
            <van-button size="mini" plain type="primary" :loading="aiPreviewing" @click="aiAutoPreview">重新生成 AI 方案</van-button>
          </div>
        </div>

        <!-- AI 自动新增方案（只试算，用户确认后才真正新增） -->
        <div v-if="batchKind === 'jushuitan' && aiPreviewing" class="alert ok">🤖 AI 正在归并商品并生成新增方案…</div>
        <div v-else-if="batchKind === 'jushuitan' && aiPlan" class="ai-plan">
          <div class="bold">🤖 AI 自动新增方案（尚未写入，确认后才生效）</div>
          <div class="muted">{{ aiPlan.message }}</div>
          <div v-if="aiNewProducts.length" style="margin-top:6px;">
            <b>将新增 {{ aiNewProducts.length }} 个库存大类</b>
            <div class="muted">{{ aiNewProducts.map((x) => `${x.name}（${x.category}）`).join('、') }}</div>
          </div>
          <div v-if="(aiPlan.mappings || []).length" style="margin-top:6px;">
            <b>将关联 {{ aiPlan.mappings.length }} 个商品名</b>
            <div v-for="m in aiPlan.mappings" :key="m.code" class="muted ellipsis">{{ m.code }} → {{ m.target }}</div>
          </div>
          <div v-if="(aiPlan.leftover || []).length" style="margin-top:6px;">
            <b>仍无法自动关联 {{ aiPlan.leftover.length }} 个</b>，请手动新增：
            <div class="unmapped-list">
              <div v-for="c in aiPlan.leftover" :key="c" class="unmapped-item">
                <span class="grow ellipsis">{{ c }}</span>
                <van-button size="mini" plain type="primary" icon="plus" @click="goNewProduct(c)">去新增商品</van-button>
              </div>
            </div>
          </div>
          <div class="row" style="gap:8px;margin-top:10px;">
            <van-button block size="small" plain :loading="aiPreviewing" @click="aiAutoPreview">重新生成方案</van-button>
            <van-button block size="small" type="primary" :loading="aiApplying" @click="aiApplyPlan">确认新增并重新解析</van-button>
          </div>
        </div>
        <div v-if="batchSkipText" class="alert warn">⚠ 跳过：{{ batchSkipText }}</div>
        <div v-if="batchFailed.length" class="alert err">
          解析失败 {{ batchFailed.length }} 条：{{ batchFailed.slice(0, 5).map((f) => f.reason).join('；') }}
        </div>
        <div v-if="batchMsg" class="alert ok">{{ batchMsg }}</div>

        <div class="sheet-foot">
          <van-button block plain @click="batchShow = false">关闭</van-button>
          <van-button
            block
            type="success"
            :disabled="!(batchOrders.length || batchItems.length)"
            :loading="batchSaving"
            @click="confirmBatch"
          >确认{{ batchKind === 'inbound' ? '入库' : '出库' }}</van-button>
        </div>
      </div>
    </van-popup>
  </div>
</template>

<script setup>
import { ref, reactive, computed, onMounted } from 'vue'
import { useRoute, useRouter } from 'vue-router'
import { showToast, showConfirmDialog } from 'vant'
import api, { upload, downloadFile, downloadJson } from '../api'
import { fmtMoney, fmtNum, num } from '../utils/format'

const route = useRoute()
const router = useRouter()
function goBack() {
  if (window.history.length > 1) router.back()
  else router.replace('/mine')
}

const panels = [
  { key: 'wh', label: '分仓' },
  { key: 'pdata', label: '商品资料备份' },
  { key: 'backup', label: '备份与恢复' },
  { key: 'import', label: '批量导入' },
  { key: 'jushuitan', label: '聚水潭关联' },
]
const panel = ref('wh')

function switchPanel(k) {
  panel.value = k
  if (k === 'pdata') loadPdata()
  if (k === 'backup') loadBackup()
  if (k === 'wh') loadWarehouses()
}

/* ==================== 分仓 ==================== */
const warehouses = ref([])
const newWhName = ref('')
const whSaving = ref(false)

async function loadWarehouses() {
  try {
    const r = await api('/api/warehouses')
    warehouses.value = r.warehouses || []
  } catch (e) { showToast(e.message || '加载分仓失败') }
}

async function switchWh(w) {
  try { await showConfirmDialog({ title: '切换分仓', message: `仅把你的登录切到「${w.name}」，其他在线用户不受影响，也无需重新登录。确认切换？` }) } catch (e) { return }
  try {
    await api('/api/warehouses/switch', 'POST', { key: w.key })
    showToast(`已切换到 ${w.name}`)
    // 分仓只随本会话生效：直接刷新页面重新加载数据，登录状态保持
    setTimeout(() => location.reload(), 600)
  } catch (e) { showToast(e.message || '切换失败') }
}

async function createWh() {
  const name = newWhName.value.trim()
  if (!name) { showToast('请输入分仓名称'); return }
  try { await showConfirmDialog({ title: '新建分仓', message: `将新建「${name}」并把你的登录切过去（会复制你当前所在仓的用户）。无需重新登录，也不影响其他在线用户。确认？` }) } catch (e) { return }
  whSaving.value = true
  try {
    await api('/api/warehouses', 'POST', { name })
    showToast(`已创建并切换到 ${name}`)
    setTimeout(() => location.reload(), 600)
  } catch (e) { showToast(e.message || '创建失败') }
  whSaving.value = false
}

/* ==================== 商品资料备份 ==================== */
const pdataRows = ref([])
const pdataDir = ref('')
const pdataBusy = ref(false)
const pdataMsg = ref('')
const pdataUploadMsg = ref('')
const pdataFile = ref(null)

async function loadPdata() {
  try {
    const d = await api('/api/product-data/status')
    pdataRows.value = d.rows || []
    pdataDir.value = d.dir || ''
  } catch (e) { showToast(e.message || '加载状态失败') }
}

async function pdataExportAll() {
  pdataBusy.value = true
  try {
    const r = await api('/api/product-data/export', 'POST')
    const n = (r.files || []).length
    pdataMsg.value = `已导出 ${n} 个文件到 json 目录（${r.exported_at || ''}）`
    showToast('已导出')
    loadPdata()
  } catch (e) { showToast('导出失败：' + e.message) }
  pdataBusy.value = false
}

async function pdataImportAll() {
  try { await showConfirmDialog({ title: '一键导入', message: '将按依赖顺序从 json 目录导入 5 类商品资料（按名称 upsert），确认？' }) } catch (e) { return }
  pdataBusy.value = true
  try {
    const r = await api('/api/product-data/import', 'POST')
    const parts = (r.results || []).map((x) => `${x.label}：新增 ${x.created} / 更新 ${x.updated}`)
    pdataMsg.value = parts.join('；') || '导入完成'
    showToast('已导入')
    loadPdata()
  } catch (e) { showToast('导入失败：' + e.message) }
  pdataBusy.value = false
}

async function pdataImportOne(r) {
  try { await showConfirmDialog({ title: '导入单类', message: `从 json 目录导入「${r.label}」（按名称 upsert），确认？` }) } catch (e) { return }
  try {
    const res = await api(`/api/product-data/import/${r.kind}`, 'POST')
    pdataMsg.value = `${r.label}：新增 ${res.created} / 更新 ${res.updated}`
    showToast('已导入')
    loadPdata()
  } catch (e) { showToast('导入失败：' + e.message) }
}

async function pdataDownload(r) {
  try {
    const data = await api(`/api/product-data/${r.kind}`)
    downloadJson(data, r.file || `${r.kind}.json`)
    showToast('已下载')
  } catch (e) { showToast('下载失败：' + e.message) }
}

async function pdataUpload(e) {
  const f = e.target.files && e.target.files[0]
  e.target.value = ''
  if (!f) return
  try {
    const text = await f.text()
    const payload = JSON.parse(text)
    const res = await api('/api/product-data/import-one', 'POST', { payload })
    pdataUploadMsg.value = `${res.label || payload.kind}：新增 ${res.created} / 更新 ${res.updated}`
    showToast('已导入')
    loadPdata()
  } catch (err) {
    pdataUploadMsg.value = ''
    showToast('导入失败：' + (err.message || 'JSON 格式错误'))
  }
}

/* ==================== 备份与恢复 ==================== */
const bk = reactive({ enabled: true, interval_hours: 2, keep: 30 })
const bkList = ref([])
const bkSaving = ref(false)
const bkCreating = ref(false)

async function loadBackup() {
  try {
    const d = await api('/api/backups')
    const c = d.config || {}
    bk.enabled = !!c.enabled
    bk.interval_hours = c.interval_hours || 2
    bk.keep = c.keep || 30
    bkList.value = d.backups || []
  } catch (e) { showToast(e.message || '加载备份失败') }
}

async function saveBkConfig() {
  bkSaving.value = true
  try {
    await api('/api/backup/config', 'POST', {
      enabled: !!bk.enabled,
      interval_hours: num(bk.interval_hours) || 2,
      keep: num(bk.keep) || 30,
    })
    showToast('已保存')
  } catch (e) { showToast(e.message || '保存失败') }
  bkSaving.value = false
}

async function createBackup() {
  bkCreating.value = true
  try {
    const r = await api('/api/backup', 'POST')
    bkList.value = r.backups || []
    showToast('备份成功')
  } catch (e) { showToast(e.message || '备份失败') }
  bkCreating.value = false
}

async function restoreBackup(b) {
  try { await showConfirmDialog({ title: '恢复备份', message: `将用 ${b.mtime} 的备份覆盖当前数据，此操作不可撤销。确认？` }) } catch (e) { return }
  try {
    await api('/api/backup/restore', 'POST', { name: b.name })
    showToast('恢复成功')
  } catch (e) { showToast(e.message || '恢复失败') }
}

async function delBackup(b) {
  try { await showConfirmDialog({ title: '删除备份', message: `确认删除 ${b.mtime} 的备份？` }) } catch (e) { return }
  try {
    const r = await api(`/api/backup/${encodeURIComponent(b.name)}`, 'DELETE')
    bkList.value = r.backups || bkList.value.filter((x) => x.name !== b.name)
    showToast('已删除')
  } catch (e) { showToast(e.message || '删除失败') }
}

/* ==================== 批量导入 ==================== */
const impProdFile = ref(null)
const impProdMsg = ref('')
const impProdOk = ref(true)

function downloadTpl(kind) {
  downloadFile(`/api/templates/${kind}`, `${kind}_template.xlsx`).catch((e) => showToast(e.message))
}

async function importProducts(e) {
  const f = e.target.files && e.target.files[0]
  e.target.value = ''
  if (!f) return
  impProdMsg.value = '正在导入…'
  try {
    const r = await upload('/api/import/products', f)
    impProdOk.value = true
    impProdMsg.value = `新增 ${r.created} 条，跳过 ${r.skipped} 条${r.failed_count ? `，失败 ${r.failed_count} 条：${(r.failed || []).slice(0, 3).map((x) => x.reason).join('；')}` : ''}`
    showToast('导入完成')
  } catch (err) {
    impProdOk.value = false
    impProdMsg.value = '导入失败：' + err.message
  }
}

/* 批量入库 / 批量出库 / 聚水潭 出库单 的预览确认 */
const BATCH_CFG = {
  inbound: {
    title: '批量入库',
    preview: '/api/import/inbounds/preview',
    confirm: '/api/import/inbounds/confirm',
    itemKey: 'items',
  },
  outbound: {
    title: '批量出库',
    preview: '/api/import/outbounds/preview',
    confirm: '/api/import/outbounds/confirm',
    itemKey: 'orders',
  },
  jushuitan: {
    title: '导入聚水潭出库单',
    preview: '/api/jushuitan/import/preview',
    confirm: '/api/jushuitan/import/confirm',
    itemKey: 'orders',
  },
}
const batchKind = ref(batchStore.kind)
const batchShow = ref(false)
const batchParsing = ref(false)
const batchSaving = ref(false)
const batchOrders = ref(batchStore.orders)
const batchItems = ref(batchStore.items)
const batchFailed = ref(batchStore.failed)
const batchUnmapped = ref(batchStore.unmapped)
const batchSkip = ref(batchStore.skip)
const batchMsg = ref('')
const batchFileObj = ref(batchStore.fileObj) // 最近一次选择的文件，供「重新解析」
const batchFileName = ref(batchStore.fileName)
const aiPlan = ref(batchStore.aiPlan)
const aiPreviewing = ref(false)
const aiApplying = ref(false)

const batchCfg = computed(() => BATCH_CFG[batchKind.value])
const batchAllOn = computed(() => batchOrders.value.length > 0 && batchOrders.value.every((o) => o._on))
const batchItemsAllOn = computed(() => batchItems.value.length > 0 && batchItems.value.every((i) => i._on))
const batchSkipText = computed(() =>
  Object.entries(batchSkip.value).filter(([, v]) => v > 0).map(([k, v]) => `${k} ${v}单`).join('、')
)
const aiNewProducts = computed(() => ((aiPlan.value && aiPlan.value.products) || []).filter((x) => x.is_new))

// 汇总相同商品名（同单位）：订单数 / 总数量 / 均价 / 每单金额 / 总金额
const aggProducts = computed(() => {
  const map = new Map()
  batchOrders.value.forEach((o) => {
    (o.lines || []).forEach((l) => {
      const key = `${l.product_name || ''}\u0000${l.unit || ''}`
      let g = map.get(key)
      if (!g) { g = { name: l.product_name, unit: l.unit, deduct: '', docs: new Set(), qty: 0, amount: 0 }; map.set(key, g) }
      g.docs.add(o.doc_no || '')
      g.qty += num(l.quantity)
      g.amount += num(l.amount)
      if (!g.deduct && l.deduct) g.deduct = l.deduct
    })
  })
  return [...map.values()].map((g) => {
    const n = g.docs.size
    return {
      name: g.name, unit: g.unit, deduct: g.deduct, orders: n, qty: g.qty, amount: g.amount,
      price: g.qty ? g.amount / g.qty : 0, perOrder: n ? g.amount / n : 0,
    }
  }).sort((a, b) => b.amount - a.amount)
})
const aggTotalAmount = computed(() => aggProducts.value.reduce((s, x) => s + x.amount, 0))

// 写回模块级单例，供离开页面（去新增商品）后返回时恢复
function syncBatch() {
  batchStore.kind = batchKind.value
  batchStore.orders = batchOrders.value
  batchStore.items = batchItems.value
  batchStore.failed = batchFailed.value
  batchStore.unmapped = batchUnmapped.value
  batchStore.skip = batchSkip.value
  batchStore.aiPlan = aiPlan.value
  batchStore.fileObj = batchFileObj.value
  batchStore.fileName = batchFileName.value
}
function resetBatch(kind) {
  batchKind.value = kind
  batchFileObj.value = null
  batchFileName.value = ''
  batchOrders.value = []
  batchItems.value = []
  batchFailed.value = []
  batchUnmapped.value = []
  batchSkip.value = {}
  aiPlan.value = null
  batchStore.aiSig = ''
  syncBatch()
}

function startBatch(kind) {
  if (batchStore.kind !== kind) resetBatch(kind) // 切换导入类型时清空上次结果
  batchKind.value = kind
  // 有上次解析结果（例如刚从「新增商品」返回）：直接打开预览，可重新解析或另选文件
  if (batchOrders.value.length || batchItems.value.length || batchUnmapped.value.length) {
    batchShow.value = true
    return
  }
  pickFile()
}
function pickFile() {
  const el = document.createElement('input')
  el.type = 'file'
  el.accept = '.xlsx'
  el.onchange = async () => {
    const f = el.files && el.files[0]
    if (!f) return
    batchFileObj.value = f
    batchFileName.value = f.name
    batchShow.value = true
    await runParse(f)
  }
  el.click()
}
async function reparse() {
  if (!batchFileObj.value) { showToast('请先选择 Excel 文件'); return }
  await runParse(batchFileObj.value)
}

async function runParse(f) {
  batchParsing.value = true
  batchOrders.value = []
  batchItems.value = []
  batchFailed.value = []
  batchUnmapped.value = []
  batchSkip.value = {}
  batchMsg.value = ''
  aiPlan.value = null
  try {
    const r = await upload(batchCfg.value.preview, f)
    const key = batchCfg.value.itemKey
    if (key === 'items') {
      batchItems.value = (r.items || []).map((it) => ({ ...it, _on: true }))
    } else {
      batchOrders.value = (r.orders || []).map((o) => ({ ...o, _on: true }))
    }
    batchFailed.value = r.failed || []
    batchUnmapped.value = r.unmapped_codes || []
    batchSkip.value = r.skip || {}
    syncBatch()
    if (!batchOrders.value.length && !batchItems.value.length) showToast('未解析出可提交的数据')
    // 聚水潭：解析后自动试算 AI 新增方案（不落库），交给用户确认；同一批未关联只自动试算一次
    if (batchKind.value === 'jushuitan' && batchUnmapped.value.length) {
      const sig = batchUnmapped.value.slice().sort().join('\u0001')
      if (sig !== batchStore.aiSig) { batchStore.aiSig = sig; aiAutoPreview() }
    }
  } catch (e) { showToast('解析失败：' + e.message) }
  batchParsing.value = false
}

/* 未关联商品 → 新页面打开「新增商品」并按该名称预填 */
function goNewProduct(code) {
  batchShow.value = false
  router.push({ path: '/products', query: { new: code } })
}

/* 只试算不落库：AI 归并库存大类，把方案展示给用户确认 */
async function aiAutoPreview() {
  const codes = batchUnmapped.value.filter(Boolean)
  if (!codes.length) { showToast('没有可关联的商品名'); return }
  aiPreviewing.value = true
  try {
    const r = await api('/api/mappings/ai-suggest', 'POST', { source: 'jushuitan', codes, apply: false })
    aiPlan.value = r
  } catch (e) {
    aiPlan.value = null
    showToast('AI 自动解析失败：' + e.message)
  }
  syncBatch()
  aiPreviewing.value = false
}

/* 用户确认后：真正新增库存大类 + 建立编码关联，然后重新解析出库单 */
async function aiApplyPlan() {
  const codes = batchUnmapped.value.filter(Boolean)
  if (!codes.length) { showToast('没有可关联的商品名'); return }
  aiApplying.value = true
  try {
    const r = await api('/api/mappings/ai-suggest', 'POST', { source: 'jushuitan', codes, apply: true })
    showToast(r.message || 'AI 关联完成')
    aiPlan.value = null
    batchStore.aiSig = '' // 允许重新解析后按新的未关联集合再自动试算
    if (batchFileObj.value) await runParse(batchFileObj.value)
  } catch (e) { showToast('AI 关联失败：' + e.message) }
  aiApplying.value = false
}

function toggleBatchAll() {
  const v = !batchAllOn.value
  batchOrders.value.forEach((o) => { o._on = v })
}
function toggleBatchItemsAll() {
  const v = !batchItemsAllOn.value
  batchItems.value.forEach((i) => { i._on = v })
}

async function confirmBatch() {
  const kind = batchKind.value
  let body
  if (kind === 'inbound') {
    const items = batchItems.value
      .filter((i) => i._on && num(i.quantity) > 0)
      .map((i) => ({
        product_id: i.product_id, product_name: i.product_name, unit: i.unit,
        quantity: num(i.quantity), unit_price: num(i.unit_price),
        supplier: i.supplier, date: i.date, operator: i.operator, remark: i.remark,
      }))
    if (!items.length) { showToast('没有勾选可入库的数据'); return }
    body = { items }
  } else {
    const orders = batchOrders.value
      .filter((o) => o._on)
      .map((o) => ({
        doc_no: o.doc_no, date: o.date, customer: o.customer, operator: o.operator, remark: o.remark,
        pack_fee: num(o.pack_fee),
        lines: (o.lines || []).filter((l) => l.product_id && num(l.quantity) > 0)
          .map((l) => ({ product_id: l.product_id, unit: l.unit, quantity: num(l.quantity), price: num(l.price), gross_sales: num(l.gross_sales) })),
        pack_rule_id: o.pack_rule_id || null,
        pack_rule_name: o.pack_rule_name || '',
        pack_lines: o.pack_lines || [],
      }))
      .filter((o) => o.lines.length)
    if (!orders.length) { showToast('没有勾选可出库的单据'); return }
    body = { orders }
  }
  batchSaving.value = true
  try {
    const r = await api(batchCfg.value.confirm, 'POST', body)
    batchMsg.value = `✓ 已创建 ${r.created} 个${kind === 'inbound' ? '入库' : '出库'}单${r.failed_count ? `，失败 ${r.failed_count}` : ''}`
    if (r.warnings && r.warnings.length) batchMsg.value += `；⚠ ${r.warnings.join('；')}`
    showToast('提交完成')
    resetBatch(batchKind.value) // 清空并同步模块级状态，避免下次进入还看到旧结果
  } catch (e) { showToast('提交失败：' + e.message) }
  batchSaving.value = false
}

/* ==================== 聚水潭关联 ==================== */
const mpFile = ref(null)
const mpParsing = ref(false)
const mpAuto = ref(false)
const mpInfo = ref('')
const mpCodes = ref([])

async function parseJushuitan(e) {
  const f = e.target.files && e.target.files[0]
  e.target.value = ''
  if (!f) return
  mpParsing.value = true
  mpInfo.value = ''
  try {
    const r = await upload('/api/jushuitan/parse', f)
    mpCodes.value = r.codes || []
    const skip = Object.entries(r.skip || {}).filter(([, v]) => v > 0).map(([k, v]) => `${k} ${v}单`).join('、')
    mpInfo.value = `解析订单 ${r.total_orders || 0} 单，识别编码 ${mpCodes.value.length} 个${skip ? `；跳过 ${skip}` : ''}`
    showToast('解析完成')
  } catch (err) { showToast('解析失败：' + err.message) }
  mpParsing.value = false
}

async function autoMapping() {
  mpAuto.value = true
  try {
    const r = await api('/api/mappings/auto', 'POST')
    mpInfo.value = `自动匹配 ${r.matched} / ${r.total} 个未关联编码`
    showToast('自动匹配完成')
  } catch (e) { showToast(e.message || '匹配失败') }
  mpAuto.value = false
}

async function clearMapping() {
  try { await showConfirmDialog({ title: '清空关联', message: '将清空聚水潭来源的全部编码关联，确认？' }) } catch (e) { return }
  try {
    await api('/api/mappings?source=jushuitan', 'DELETE')
    showToast('已清空')
    mpCodes.value = []
    mpInfo.value = '已清空聚水潭编码关联'
  } catch (e) { showToast(e.message || '清空失败') }
}

async function exportMappings() {
  try {
    const data = await api('/api/product-data/code_mappings')
    downloadJson(data, 'code_mappings.json')
    showToast('已导出')
  } catch (e) { showToast('导出失败：' + e.message) }
}

/* ==================== 初始化 ==================== */
onMounted(() => {
  const p = route.query.panel
  if (p && panels.some((x) => x.key === p)) panel.value = String(p)
  switchPanel(panel.value)
})
</script>

<style scoped>
.sub-page { min-height: 100vh; background: #f7f8fa; }
.io-row { padding: 10px 0; border-bottom: 1px solid #f5f5f5; }
.io-row:last-child { border-bottom: none; }
.io-name { font-weight: 600; font-size: 14px; }
.amount { min-width: 76px; text-align: right; font-weight: 600; font-variant-numeric: tabular-nums; font-size: 13px; }
.batch-line { display: flex; align-items: center; gap: 6px; padding: 6px 0 0 22px; }
.alert { border-radius: 8px; padding: 8px 10px; font-size: 12px; margin-top: 8px; }
.alert.ok { background: #f0f9eb; color: #07c160; }
.alert.warn { background: #fffbe8; color: #ed6a0c; }
.alert.err { background: #fff1f0; color: #ee0a24; }
.unmapped-list { margin-top: 6px; }
.unmapped-item { display: flex; align-items: center; gap: 8px; padding: 4px 0; }
.unmapped-item .ellipsis { font-size: 12px; }
.ai-plan { background: #f7f8fa; border-radius: 8px; padding: 10px; margin-top: 8px; font-size: 12px; }
.agg-row { padding: 8px 0; border-bottom: 1px solid #f5f5f5; }
.agg-row:last-child { border-bottom: none; }
.agg-row .bold { font-size: 13.5px; }
.agg-row .muted { font-size: 12px; }
code { background: #f2f3f5; padding: 1px 4px; border-radius: 3px; font-size: 11px; }
</style>
