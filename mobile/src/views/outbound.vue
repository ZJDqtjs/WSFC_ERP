<template>
  <div>
    <div class="card">
      <div class="card-title">快捷出库 / 销售</div>
      <van-form @submit="submit">
        <van-cell-group inset>
          <van-field v-model="date" label="日期" type="date" />
          <van-field v-model="customer" label="客户" placeholder="可留空" />
          <van-field v-model="remark" label="备注" placeholder="可留空" />
        </van-cell-group>

        <div class="row" v-for="(r, i) in rows" :key="r._key" style="padding:8px 16px;align-items:flex-start;">
          <div class="pk-cell" @click="openPicker(i)">
            <div v-if="r.product_id" class="pk-selected">{{ r.label }}</div>
            <div v-else class="pk-placeholder">＋ 选择商品</div>
          </div>
          <van-field v-model="r.qty" label="数量" type="number" placeholder="0" style="width:74px" />
          <van-field v-model="r.price" label="售价" type="number" placeholder="0" style="width:84px" />
          <van-icon name="delete-o" color="#ee0a24" @click="rows.splice(i,1)" style="margin-top:14px;" />
        </div>
        <div class="add-row"><van-button size="small" plain type="primary" @click="addRow">＋ 加一行</van-button></div>

        <van-button round block type="primary" plain @click="preview" style="margin:6px 18px 0;">🔍 预览结算</van-button>
      </van-form>
    </div>

    <!-- 预览结算面板 -->
    <div v-if="previewResult" class="card">
      <div class="card-title">结算预览</div>
      <div v-for="w in previewResult.warnings" :key="w" class="alert-warn">⚠ {{ w }}</div>

      <div class="p-table">
        <div class="p-row th"><span>商品</span><span class="muted">单位</span><span class="num">数量</span><span class="num">金额</span></div>
        <div v-for="l in previewResult.sale_lines" :key="l.product_id" class="p-row">
          <span>{{ l.product_name }}</span><span class="muted">{{ l.unit }}</span><span class="num">{{ l.quantity }}</span><span class="num">{{ fmtMoney(l.amount) }}</span>
        </div>
      </div>

      <div class="p-table" v-if="previewResult.pack_lines.length">
        <div class="p-row th"><span>包装材料</span><span class="muted">单位</span><span class="num">数量</span><span class="num">成本</span></div>
        <div v-for="l in previewResult.pack_lines" :key="l.product_id" class="p-row">
          <span>{{ l.product_name }}</span><span class="muted">{{ l.unit }}</span><span class="num">{{ l.quantity }}</span><span class="num">{{ fmtMoney(l.amount) }}</span>
        </div>
      </div>

      <div class="p-totals">
        <div class="p-row"><span>销售合计</span><span class="num">{{ fmtMoney(previewResult.total_amount) }}</span></div>
        <div class="p-row"><span>成本合计</span><span class="num">{{ fmtMoney(previewResult.total_cogs) }}</span></div>
        <div class="p-row"><span>毛利</span><span class="num green">{{ fmtMoney(previewResult.gross_profit) }}</span></div>
        <div class="p-row"><span>费用</span><span class="num"><van-field v-model="fee" type="number" placeholder="0" style="width:80px;display:inline-block;" /></span></div>
        <div class="p-row" style="font-weight:700;"><span>净利</span><span class="num green">{{ fmtMoney(previewResult.total_amount - previewResult.total_cogs - fee) }}</span></div>
      </div>

      <van-button round block type="primary" :loading="submitting" loading-text="出库中…" @click="submit">✓ 确认出库</van-button>
    </div>

    <product-picker v-model:show="showPicker" title="选择销售商品" :list="saleList" :show-type-tabs="true" @pick="pick" />
  </div>
</template>

<script setup>
import { ref, computed, onMounted } from 'vue'
import { showToast } from 'vant'
import api from '../api'
import ProductPicker from '../components/product-picker.vue'
import { loadProducts, saleProducts } from '../store/products'

let _id = 0
const rows = ref([{ _key: ++_id, product_id: '', qty: '1', price: '0', unit: '', label: '' }])
const date = ref(new Date().toISOString().slice(0, 10))
const customer = ref(''), remark = ref(''), fee = ref(0)
const showPicker = ref(false), submitting = ref(false)
const pickIdx = ref(0)
const previewResult = ref(null)
const saleList = ref([])

const fmtMoney = (v) => '¥' + (+v || 0).toLocaleString('zh-CN', { minimumFractionDigits: 2 })

async function loadProductsList() {
  await loadProducts()
  saleList.value = saleProducts()
}
onMounted(loadProductsList)

const addRow = () => rows.value.push({ _key: ++_id, product_id: '', qty: '1', price: '0', unit: '', label: '' })
const openPicker = (i) => { pickIdx.value = i; showPicker.value = true }

function pick(p) {
  const r = rows.value[pickIdx.value]
  const du = p.product_type === 'order' ? '单' : (p.default_unit || p.base_unit)
  r.product_id = p.id
  r.unit = du
  r.label = `${p.product_type === 'order' ? '[订单]' : '[库存]'} ${p.name}（${p.category || '—'}）`
  // 自动带出参考售价（对齐桌面端）
  const factor = (p.conversions || {})[du] || 1
  let price = 0
  if (p.sale_price > 0) price = p.sale_price * factor
  else if (p.avg_cost > 0) price = p.avg_cost * factor
  else if (p.unit_cost > 0) price = p.unit_cost * factor
  r.price = price > 0 ? price.toFixed(2) : '0'
  showPicker.value = false
  previewResult.value = null  // 商品变更后清除旧预览
}

function collectLines() {
  return rows.value
    .filter((r) => r.product_id)
    .map((r) => ({ product_id: +r.product_id, unit: r.unit || '个', quantity: +r.qty, price: +r.price }))
}

async function preview() {
  const lines = collectLines()
  if (!lines.length) { showToast('请至少添加一行销售商品'); return }
  try {
    previewResult.value = await api('/api/outbounds/preview', 'POST', { lines })
    fee.value = previewResult.value.total_fee || 0   // 按后端算出的关联结算费用预填（对齐桌面端 outFee）
  } catch (e) { showToast('预览失败：' + e.message) }
}

async function submit() {
  if (submitting.value) return   // 防重复提交（出库弹窗等待）
  const lines = collectLines()
  if (!lines.length) { showToast('请至少添加一行销售商品'); return }
  submitting.value = true
  try {
    const r = await api('/api/outbounds', 'POST', {
      customer: customer.value, date: date.value, remark: remark.value,
      lines, pack_lines: [], pack_fee_total: +fee.value || 0,
    })
    const warns = (r.warnings || [])
    showToast(warns.length ? '⚠ ' + warns.join('；') : '出库成功', { duration: warns.length ? 3800 : undefined })
    rows.value = [{ _key: ++_id, product_id: '', qty: '1', price: '0', unit: '', label: '' }]
    previewResult.value = null
    customer.value = ''; remark.value = ''; fee.value = 0
  } catch (e) { showToast('出库失败：' + e.message) } finally { submitting.value = false }
}
</script>

<style scoped>
.add-row { padding: 8px 16px; }
.pk-cell { flex: 1; min-width: 0; }
.pk-cell .pk-selected { font-size: 13px; padding: 10px 12px; background: #f7f8fa; border-radius: 8px; word-break: break-all; }
.pk-cell .pk-placeholder { color: #1989fa; padding: 10px 12px; background: #f0f8ff; border-radius: 8px; }
.alert-warn { background: #fffbe6; border: 1px solid #ffe58f; border-radius: 6px; padding: 8px 12px; margin-bottom: 10px; font-size: 12px; color: #8a6d00; }
.p-table { font-size: 13px; }
.p-row { display: flex; gap: 6px; padding: 6px 0; border-bottom: 1px solid #f5f5f5; }
.p-row.th { font-weight: 600; color: #969799; font-size: 12px; }
.p-row > span { flex: 1; }
.p-row .num { flex: 0 0 60px; text-align: right; }
.p-totals { margin-top: 8px; }
.p-totals .p-row { border-bottom: none; }
.green { color: #07c160; }
</style>