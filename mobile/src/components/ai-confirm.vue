<template>
  <van-popup :show="show" position="bottom" round style="height:92%" @update:show="close">
    <div class="ai-wrap">
      <div class="ai-head">
        <span class="ai-title">确认录入（{{ isIn ? '入库' : '出库' }}）</span>
        <van-icon name="cross" size="18" @click="close(false)" />
      </div>

      <div class="ai-body">
        <p class="hint">
          已自动识别以下内容，请核对（可修改）后提交；🆕 标记为系统自动新增的新商品，
          ⚠ 标记的行需要你确认商品或单位。
        </p>

        <div v-if="form.image_url" class="ai-invoice">
          <span class="muted">📎 票据凭证</span>
          <img :src="form.image_url" alt="票据" @click="preview(form.image_url)" />
        </div>

        <van-cell-group inset>
          <van-field label="业务类型">
            <template #input>
              <van-radio-group v-model="form.type" direction="horizontal" @change="typeChanged">
                <van-radio name="inbound">入库</van-radio>
                <van-radio name="outbound">出库</van-radio>
              </van-radio-group>
            </template>
          </van-field>
          <van-field v-model="form.date" label="日期" type="date" />
          <van-field v-model="form.party" :label="isIn ? '供应商' : '客户'" placeholder="可留空" />
          <van-field v-model="form.remark" label="备注" placeholder="可留空" />
        </van-cell-group>

        <div v-for="(ln, i) in form.lines" :key="i" class="ai-line" :class="{ warn: ln.ambiguous || ln.unit_conflict }">
          <div class="ai-line-head">
            <span class="idx">#{{ i + 1 }}</span>
            <span class="grow name">{{ ln.product_name || '未匹配商品' }}</span>
            <van-icon name="delete-o" color="#ee0a24" @click="form.lines.splice(i, 1)" />
          </div>

          <div class="badges">
            <span v-if="ln.auto_created" class="badge new">🆕 自动新增</span>
            <span v-if="ln.ambiguous" class="badge amber">⚠ 相似商品待确认</span>
            <span v-if="ln.unit_conflict" class="badge red">⚠ 单位不一致</span>
            <span v-if="ln.price_defaulted" class="badge amber">已按上次价</span>
          </div>

          <!-- 相似商品候选：优先让用户在候选里挑选（对齐桌面端） -->
          <div v-if="ln.ambiguous && ln.candidates && ln.candidates.length" class="cand-box">
            <div class="cand-tip">识别到多个相似商品，请选择正确的一个：</div>
            <van-radio-group v-model="ln.product_id">
              <van-radio v-for="c in ln.candidates" :key="c.product_id" :name="c.product_id" class="cand">
                〔{{ AI_CAT_SHORT[c.category] || '库存' }}〕{{ c.name }}
              </van-radio>
            </van-radio-group>
            <van-button size="mini" plain type="primary" @click="ln.ambiguous = false">都不是，手动选择</van-button>
          </div>

          <template v-else>
            <van-field
              is-link readonly label="分类" :model-value="catLabel(ln.category)"
              @click="openCat(i)"
            />
            <van-field
              is-link readonly label="商品" :model-value="ln.product_name || '请选择'"
              @click="openProd(i)"
            />
          </template>

          <div class="num-row">
            <van-field v-model="ln.quantity" label="数量" type="number" />
            <van-field v-model="ln.unit" label="单位" />
            <van-field v-model="ln.unit_price" :label="isIn ? '单价' : '售价'" type="number" />
          </div>
          <div v-if="ln.hint" class="muted line-hint">{{ ln.hint }}</div>
        </div>

        <van-empty v-if="!form.lines.length" description="未识别到明细" />
        <div class="add-row">
          <van-button size="small" plain type="primary" @click="addLine">＋ 手动加一行</van-button>
        </div>

        <div class="totals">
          <span>合计金额</span><b>{{ fmtMoney(total) }}</b>
        </div>
      </div>

      <div class="ai-foot">
        <van-button block round @click="close(false)">取消</van-button>
        <van-button block round type="primary" :loading="submitting" loading-text="提交中…" @click="submit">✓ 确认提交</van-button>
      </div>
    </div>

    <van-action-sheet v-model:show="catShow" :actions="catActions" cancel-text="取消" @select="pickCat" />
    <product-picker v-model:show="prodShow" title="选择商品" :list="prodList" @pick="pickProd" />
    <van-image-preview v-model:show="imgShow" :images="imgList" />
  </van-popup>
</template>

<script setup>
import { ref, reactive, computed, watch } from 'vue'
import { showToast } from 'vant'
import api from '../api'
import ProductPicker from './product-picker.vue'
import { AI_CAT_ORDER, AI_CAT_SHORT, productsByCat, loadProducts } from '../store/products'

const props = defineProps({ show: Boolean, result: Object })
const emit = defineEmits(['update:show', 'done'])

const submitting = ref(false)
const catShow = ref(false), prodShow = ref(false), imgShow = ref(false)
const editIdx = ref(0), imgList = ref([])

const form = reactive({ type: 'inbound', date: '', party: '', remark: '', image_url: '', lines: [] })
const isIn = computed(() => form.type === 'inbound')
const catActions = AI_CAT_ORDER.map(([value, name]) => ({ name, value }))
const prodList = computed(() => productsByCat(form.lines[editIdx.value]?.category || 'stock'))
const total = computed(() => form.lines.reduce((s, l) => s + (+l.quantity || 0) * (+l.unit_price || 0), 0))

const fmtMoney = (v) => '¥' + (+v || 0).toLocaleString('zh-CN', { minimumFractionDigits: 2 })
const catLabel = (c) => (AI_CAT_ORDER.find(([v]) => v === c) || [, '库存商品'])[1]

watch(() => props.show, (v) => { if (v) reset() })

function reset() {
  const r = props.result || {}
  loadProducts()
  form.type = r.type === 'outbound' ? 'outbound' : 'inbound'
  form.date = r.date || new Date().toISOString().slice(0, 10)
  form.party = (form.type === 'inbound' ? r.supplier : r.customer) || ''
  form.remark = r.remark || ''
  form.image_url = r.image_url || ''
  form.lines = (r.lines || []).map((ln) => ({
    ...ln,
    category: ['stock', 'order', 'pack', 'labor'].includes(ln.category)
      ? ln.category
      : (form.type === 'inbound' ? 'stock' : 'order'),
    quantity: String(ln.quantity ?? ''),
    unit_price: String(ln.unit_price ?? ''),
  }))
}

function typeChanged() {
  // 切换类型时，未显式归类的行按业务类型重设默认分类（对齐桌面端 aiTypeChanged）
  form.lines.forEach((ln) => {
    if (!['stock', 'order', 'pack', 'labor'].includes(ln.category)) {
      ln.category = isIn.value ? 'stock' : 'order'
    }
  })
}

const openCat = (i) => { editIdx.value = i; catShow.value = true }
const openProd = (i) => { editIdx.value = i; prodShow.value = true }
function pickCat(action) {
  catShow.value = false
  const ln = form.lines[editIdx.value]
  ln.category = action.value
  // 切换分类后原商品可能不在新分类内：清空待重选（对齐桌面端 aiCatChanged）
  if (!productsByCat(action.value).some((p) => p.id === +ln.product_id)) {
    ln.product_id = 0
    ln.product_name = ''
  }
}
function pickProd(p) {
  prodShow.value = false
  const ln = form.lines[editIdx.value]
  ln.product_id = p.id
  ln.product_name = p.name
  ln.ambiguous = false
  ln.candidates = []
  if (!ln.unit) ln.unit = p.default_unit || p.base_unit
}
function addLine() {
  form.lines.push({
    product_id: 0, product_name: '', category: isIn.value ? 'stock' : 'order',
    quantity: '1', unit: '', unit_price: '0', hint: '',
    ambiguous: false, candidates: [], auto_created: false,
  })
}
function preview(url) { imgList.value = [url]; imgShow.value = true }
function close(v) { if (v !== true) emit('update:show', false) }

async function submit() {
  if (submitting.value) return   // 防重复提交（对齐桌面端出库等待）
  const rows = form.lines.map((ln) => ({
    product_id: +ln.product_id,
    quantity: parseFloat(ln.quantity),
    unit: (ln.unit || '').trim(),
    unit_price: parseFloat(ln.unit_price),
    auto_created: !!ln.auto_created,
  })).filter((r) => r.product_id)
  if (!rows.length) { showToast('请至少选择一条商品'); return }
  if (rows.some((r) => !(r.quantity > 0) || isNaN(r.unit_price) || !r.unit)) {
    showToast('请完整填写数量、单位与金额'); return
  }
  const inv = form.image_url ? `[票据] ${form.image_url}` : ''
  submitting.value = true
  try {
    if (isIn.value) {
      for (const r of rows) {
        await api('/api/inbounds', 'POST', {
          product_id: r.product_id, unit: r.unit, quantity: r.quantity, unit_price: r.unit_price,
          supplier: form.party, date: form.date,
          remark: [inv, r.auto_created ? '[AI自动新增]' : '', form.remark].filter(Boolean).join(' '),
        })
      }
    } else {
      const lines = rows.map((r) => ({ product_id: r.product_id, unit: r.unit, quantity: r.quantity, price: r.unit_price }))
      const res = await api('/api/outbounds', 'POST', {
        customer: form.party, date: form.date,
        remark: [inv, form.remark].filter(Boolean).join(' '),
        lines, pack_lines: [],
      })
      const warns = (res.warnings || [])
      if (warns.length) showToast({ message: '⚠ ' + warns.join('；'), duration: 3800 })
    }
    if (!isIn.value) showToast('出库成功')
    else showToast('入库成功')
    emit('update:show', false)
    emit('done')
  } catch (e) {
    showToast('提交失败：' + e.message)
  } finally {
    submitting.value = false
  }
}
</script>

<style scoped>
.ai-wrap { display: flex; flex-direction: column; height: 100%; }
.ai-head { display: flex; align-items: center; justify-content: space-between; padding: 14px 16px 8px; border-bottom: 1px solid #f2f3f5; }
.ai-title { font-weight: 600; font-size: 16px; }
.ai-body { flex: 1; overflow-y: auto; padding: 10px 12px 16px; }
.ai-foot { display: flex; gap: 10px; padding: 10px 14px calc(10px + env(safe-area-inset-bottom)); border-top: 1px solid #f2f3f5; background: #fff; }
.hint { font-size: 12px; color: #969799; margin-bottom: 10px; line-height: 1.6; }
.ai-invoice { background: #fff; border-radius: 10px; padding: 10px; margin-bottom: 10px; }
.ai-invoice img { display: block; max-height: 140px; margin-top: 6px; border-radius: 6px; }
.ai-line { background: #fff; border-radius: 10px; padding: 10px 0 8px; margin-top: 10px; border: 1px solid transparent; }
.ai-line.warn { border-color: #ffd591; background: #fffbf0; }
.ai-line-head { display: flex; align-items: center; gap: 8px; padding: 0 14px 6px; }
.ai-line-head .idx { color: #969799; font-size: 12px; }
.ai-line-head .name { font-weight: 600; }
.grow { flex: 1; min-width: 0; }
.badges { display: flex; flex-wrap: wrap; gap: 6px; padding: 0 14px 6px; }
.badge { font-size: 11px; border-radius: 4px; padding: 2px 6px; }
.badge.new { background: #fff7e6; color: #8a6d00; }
.badge.amber { background: #fff3cd; color: #8a6d00; }
.badge.red { background: #fde2e0; color: #b3261e; }
.cand-box { margin: 4px 14px 8px; background: #fffbe6; border-radius: 8px; padding: 10px; }
.cand-tip { font-size: 12px; color: #8a6d00; margin-bottom: 8px; }
.cand { padding: 5px 0; font-size: 13px; }
.num-row { display: flex; gap: 4px; }
.num-row :deep(.van-field) { padding-left: 10px; padding-right: 6px; }
.line-hint { padding: 2px 14px 0; font-size: 11px; line-height: 1.5; }
.add-row { padding: 12px 2px; }
.totals { display: flex; justify-content: space-between; padding: 10px 14px; background: #fff; border-radius: 10px; font-size: 14px; }
.muted { color: #969799; font-size: 12px; }
</style>
