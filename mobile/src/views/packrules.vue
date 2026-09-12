<template>
  <div class="sub-page">
    <van-nav-bar title="一单多货（多货打包规则）" left-arrow fixed placeholder @click-left="goBack">
      <template #right><van-icon name="plus" size="18" @click="openRule()" /></template>
    </van-nav-bar>

    <div style="padding:12px;">
      <div class="card">
        <div class="muted" style="margin-bottom:8px;">
          区别于「关联结算 / 人工」的一单一货；此处维护一张订单含多种商品时的合并打包规则（纸箱 + 人工）。
        </div>
        <van-field v-model="kw" placeholder="搜索组合 / 商品 / 纸箱" style="background:#f7f8fa;border-radius:6px;" />
        <div class="row" style="gap:6px;margin-top:8px;flex-wrap:wrap;">
          <van-button size="mini" plain icon="down" @click="exportJson">导出 JSON</van-button>
          <van-button size="mini" plain icon="plus" @click="openRule()">新增规则</van-button>
        </div>

        <div v-if="selected.length" class="batch-bar">
          <span class="muted">已选 {{ selected.length }} 条</span>
          <van-button size="mini" type="danger" @click="batchDelete">批量删除</van-button>
          <van-button size="mini" plain @click="selected = []">取消</van-button>
        </div>

        <div v-if="!filtered.length" class="empty">暂无一单多货规则</div>
        <div v-for="r in filtered" :key="r.id" class="list-item">
          <div class="row">
            <van-checkbox :model-value="selected.includes(r.id)" style="margin-right:8px;" @click="toggleSel(r.id)" />
            <span class="grow item-title">{{ r.name }}</span>
            <van-tag v-if="!r.is_active" type="danger" plain>停用</van-tag>
          </div>
          <div class="item-meta">
            组合：{{ (r.items || []).map((it) => `${it.name}×${fmtNum(it.quantity)}`).join(' + ') || '—' }}
          </div>
          <div class="item-meta">
            扣减：
            {{ (r.items || []).map((it) => `${nameOf(it.stock_product_id) || it.name}×${fmtNum(it.multiplier)}`).join('、') || '—' }}
          </div>
          <div class="item-meta">
            箱型：{{ r.box_type || '—' }}
            <template v-if="r.box_ratio && r.box_ratio !== 1"> · 箱比 {{ fmtNum(r.box_ratio) }}</template>
            <template v-if="r.labor_price"> · 人工 {{ fmtMoney(r.labor_price) }}/单</template>
          </div>
          <div v-if="r.remark" class="item-meta">{{ r.remark }}</div>
          <div class="row" style="gap:8px;margin-top:6px;">
            <van-button size="mini" plain type="primary" @click="openRule(r)">编辑</van-button>
            <van-button size="mini" plain type="danger" @click="delRule(r)">删除</van-button>
          </div>
        </div>
      </div>
    </div>

    <!-- ============ 规则编辑 ============ -->
    <van-popup v-model:show="editShow" position="bottom" round :style="{ height: '92%' }">
      <div class="sheet-body">
        <div class="sheet-title">{{ form.id ? '编辑规则' : '新增一单多货规则' }}</div>

        <div class="row" style="justify-content:space-between;">
          <span class="bold">组合商品</span>
          <van-button size="mini" plain type="primary" icon="plus" @click="addItem">添加商品</van-button>
        </div>
        <div class="muted" style="margin-bottom:6px;">选择订单商品时会自动带出名称；「扣减库存大类」决定出库时从哪个库存大类扣减。</div>

        <div v-if="!form.items.length" class="empty" style="padding:10px 0;">请至少添加一条组合商品</div>
        <div v-for="(it, i) in form.items" :key="i" class="edit-row">
          <div class="row">
            <span class="grow pick-name" @click="openOrderPicker(i)">{{ it.name || '＋ 选择订单商品' }}</span>
            <van-icon name="delete-o" color="#ee0a24" @click="form.items.splice(i, 1)" />
          </div>
          <div class="row mt8">
            <van-field v-model="it.quantity" type="number" label="数量" />
            <van-field v-model="it.multiplier" type="number" label="倍数" />
          </div>
          <div class="row mt8">
            <span class="muted grow" @click="openStockPicker(i)">
              扣减库存大类：{{ nameOf(it.stock_product_id) || '（未设置，按商品自身扣减）' }}
            </span>
            <van-icon name="arrow" color="#c8c9cc" @click="openStockPicker(i)" />
          </div>
        </div>

        <div class="divider"></div>
        <div class="row" style="justify-content:space-between;">
          <span class="bold">箱型 / 包材</span>
          <van-button size="mini" plain type="primary" icon="plus" @click="addBox">添加箱型</van-button>
        </div>
        <div class="muted" style="margin-bottom:6px;">选择包材纸箱商品；箱型显示名会自动按商品名推导（如「3号纸箱」→「3号」）。</div>

        <div v-if="!form.box_items.length" class="empty" style="padding:10px 0;">未配置箱型</div>
        <div v-for="(bx, i) in form.box_items" :key="i" class="edit-row">
          <div class="row">
            <span class="grow pick-name" @click="openBoxPicker(i)">{{ bx.name || '＋ 选择包材纸箱' }}</span>
            <van-icon name="delete-o" color="#ee0a24" @click="form.box_items.splice(i, 1)" />
          </div>
          <div class="row mt8">
            <van-field v-model="bx.quantity" type="number" label="数量" />
          </div>
        </div>

        <van-cell-group inset style="margin-top:12px;">
          <van-field v-model="form.labor_price" type="number" label="人工价/单" placeholder="元，可留空" />
          <van-field v-model="form.box_ratio" type="number" label="箱比" placeholder="默认 1" />
          <van-field v-model="form.remark" label="备注" placeholder="可留空" />
          <van-field v-if="form.id" label="启用该规则">
            <template #input><van-switch v-model="form.is_active" size="20" /></template>
          </van-field>
        </van-cell-group>

        <div class="sheet-foot">
          <van-button block plain @click="editShow = false">取消</van-button>
          <van-button block type="primary" :loading="saving" @click="save">保存</van-button>
        </div>
      </div>
    </van-popup>

    <ProductPicker v-model:show="orderPickerShow" title="选择订单商品" :products="orderProducts" @pick="onOrderPick" />
    <ProductPicker v-model:show="stockPickerShow" title="选择扣减的库存大类" :products="stockProducts" :type-tabs="false" @pick="onStockPick" />
    <ProductPicker v-model:show="boxPickerShow" title="选择包材纸箱" :products="boxProducts" :type-tabs="false" @pick="onBoxPick" />
  </div>
</template>

<script setup>
import { ref, reactive, computed, onMounted } from 'vue'
import { useRouter } from 'vue-router'
import { showToast, showConfirmDialog } from 'vant'
import api, { downloadJson } from '../api'
import ProductPicker from '../components/ProductPicker.vue'
import { fmtMoney, fmtNum, num } from '../utils/format'

const router = useRouter()
function goBack() {
  if (window.history.length > 1) router.back()
  else router.replace('/mine')
}

const PRODUCTS = ref([])
const RULES = ref([])
const kw = ref('')
const selected = ref([])
const saving = ref(false)

const nameOf = (pid) => (PRODUCTS.value.find((p) => p.id === +pid) || {}).name || ''
const orderProducts = computed(() => PRODUCTS.value.filter((p) => p.product_type === 'order'))
const stockProducts = computed(() => PRODUCTS.value.filter((p) => p.product_type === 'stock' && !['人工', '快递'].includes(p.category)))
const boxProducts = computed(() => PRODUCTS.value.filter((p) => p.product_type === 'stock' && ['包材', '耗材', '包装'].includes(p.category)))

const filtered = computed(() => {
  const s = (kw.value || '').trim().toLowerCase()
  if (!s) return RULES.value
  return RULES.value.filter((r) =>
    `${r.name || ''} ${r.box_type || ''} ${(r.items || []).map((i) => i.name).join(' ')}`.toLowerCase().includes(s)
  )
})

async function load() {
  try { PRODUCTS.value = await api('/api/products') } catch (e) {}
  try { RULES.value = await api('/api/pack-rules') } catch (e) { showToast(e.message || '加载失败') }
}

function toggleSel(id) {
  const i = selected.value.indexOf(id)
  if (i >= 0) selected.value.splice(i, 1)
  else selected.value.push(id)
}

async function exportJson() {
  try {
    const data = await api('/api/product-data/pack_rules')
    downloadJson(data, 'pack_rules.json')
    showToast('已导出')
  } catch (e) { showToast('导出失败：' + e.message) }
}

/* ---------- 编辑 ---------- */
const editShow = ref(false)
const form = reactive({ id: 0, items: [], box_items: [], labor_price: '', box_ratio: 1, remark: '', is_active: true })

function openRule(r) {
  if (!r) {
    Object.assign(form, { id: 0, items: [{ product_id: null, name: '', quantity: 1, stock_product_id: null, multiplier: 1 }], box_items: [], labor_price: '', box_ratio: 1, remark: '', is_active: true })
  } else {
    Object.assign(form, {
      id: r.id,
      items: (r.items || []).map((it) => ({
        product_id: it.product_id || null, name: it.name || '', quantity: it.quantity || 1,
        stock_product_id: it.stock_product_id || null, multiplier: it.multiplier || 1,
      })),
      box_items: (r.box_items || []).map((bx) => ({ product_id: bx.product_id || null, name: bx.name || '', quantity: bx.quantity || 1 })),
      labor_price: r.labor_price != null ? r.labor_price : '',
      box_ratio: r.box_ratio || 1,
      remark: r.remark || '',
      is_active: r.is_active !== false,
    })
  }
  editShow.value = true
}

function addItem() { form.items.push({ product_id: null, name: '', quantity: 1, stock_product_id: null, multiplier: 1 }) }
function addBox() { form.box_items.push({ product_id: null, name: '', quantity: 1 }) }

const orderPickerShow = ref(false)
const stockPickerShow = ref(false)
const boxPickerShow = ref(false)
let idx = 0

function openOrderPicker(i) { idx = i; orderPickerShow.value = true }
function onOrderPick(p) {
  const it = form.items[idx]
  if (!it) return
  it.product_id = p.id
  it.name = p.name
  if (p.stock_product_id && !it.stock_product_id) it.stock_product_id = p.stock_product_id
  if (p.multiplier && (!it.multiplier || num(it.multiplier) === 1)) it.multiplier = p.multiplier
}
function openStockPicker(i) { idx = i; stockPickerShow.value = true }
function onStockPick(p) {
  const it = form.items[idx]
  if (it) it.stock_product_id = p.id
}
function openBoxPicker(i) { idx = i; boxPickerShow.value = true }
function onBoxPick(p) {
  const bx = form.box_items[idx]
  if (!bx) return
  bx.product_id = p.id
  bx.name = p.name
}

async function save() {
  if (!form.items.length) { showToast('请至少添加一条组合商品'); return }
  for (const it of form.items) {
    if (!(it.name || '').trim()) { showToast('组合商品名不能为空'); return }
    if (!(num(it.quantity) > 0)) { showToast(`「${it.name}」的数量必须大于 0`); return }
    if (!(num(it.multiplier) > 0)) { showToast(`「${it.name}」的扣减倍数必须大于 0`); return }
  }
  saving.value = true
  const body = {
    items: form.items.map((it) => ({
      product_id: it.product_id ? +it.product_id : null,
      name: it.name.trim(),
      quantity: num(it.quantity),
      stock_product_id: it.stock_product_id ? +it.stock_product_id : null,
      multiplier: num(it.multiplier) || 1,
    })),
    box_items: form.box_items
      .filter((bx) => bx.name)
      .map((bx) => ({ product_id: bx.product_id ? +bx.product_id : null, name: bx.name, quantity: num(bx.quantity) || 1 })),
    box_type: '',
    labor_price: form.labor_price === '' ? null : num(form.labor_price),
    box_ratio: num(form.box_ratio) || 1,
    remark: form.remark,
    is_active: form.is_active !== false,
  }
  try {
    if (form.id) await api(`/api/pack-rules/${form.id}`, 'PUT', body)
    else await api('/api/pack-rules', 'POST', body)
    showToast('规则已保存')
    editShow.value = false
    RULES.value = await api('/api/pack-rules')
  } catch (e) { showToast('保存失败：' + e.message) }
  saving.value = false
}

async function delRule(r) {
  try { await showConfirmDialog({ title: '删除规则', message: `确认删除「${r.name}」？` }) } catch (e) { return }
  try {
    await api(`/api/pack-rules/${r.id}`, 'DELETE')
    showToast('已删除')
    RULES.value = await api('/api/pack-rules')
  } catch (e) { showToast('删除失败：' + e.message) }
}

async function batchDelete() {
  try { await showConfirmDialog({ title: '批量删除', message: `确认删除已选 ${selected.value.length} 条规则？` }) } catch (e) { return }
  let ok = 0
  for (const id of selected.value) {
    try { await api(`/api/pack-rules/${id}`, 'DELETE'); ok++ } catch (e) {}
  }
  showToast(`已删除 ${ok} 条`)
  selected.value = []
  RULES.value = await api('/api/pack-rules')
}

onMounted(load)
</script>

<style scoped>
.sub-page { min-height: 100vh; background: #f7f8fa; }
.batch-bar { display: flex; align-items: center; gap: 6px; flex-wrap: wrap; background: #fff7e6; border-radius: 8px; padding: 8px 10px; margin-top: 8px; }
.edit-row { padding: 8px 0; border-bottom: 1px dashed #f0f0f0; }
.pick-name { font-weight: 600; font-size: 13px; color: #1989fa; }
</style>
