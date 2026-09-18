<template>
  <div class="sub-page">
    <van-nav-bar title="商品管理" left-arrow fixed placeholder @click-left="goBack">
      <template #right>
        <van-icon name="plus" size="18" @click="openProduct()" />
      </template>
    </van-nav-bar>

    <div style="padding:12px;">
      <div class="card">
        <div class="seg" style="margin-bottom:8px;">
          <div
            v-for="t in typeTabs"
            :key="t.key"
            class="seg-item"
            :class="{ active: ptype === t.key }"
            @click="ptype = t.key"
          >{{ t.label }}</div>
        </div>
        <van-field v-model="kw" placeholder="搜索商品名称 / 分类 / 编码" style="background:#f7f8fa;border-radius:6px;" />
        <div class="row wrap" style="gap:6px;margin-top:8px;">
          <van-tag v-for="c in cats" :key="c" :type="pcat === c ? 'primary' : 'default'" round @click="pcat = pcat === c ? '' : c">{{ c }}</van-tag>
        </div>
        <div class="row" style="gap:6px;margin-top:8px;flex-wrap:wrap;">
          <van-button size="mini" plain icon="ruler" @click="openUnits">计量单位管理</van-button>
          <van-button size="mini" plain icon="down" @click="exportJson('products_stock')">导出库存JSON</van-button>
          <van-button size="mini" plain icon="down" @click="exportJson('products_order')">导出订单JSON</van-button>
        </div>

        <div v-if="selected.length" class="batch-bar">
          <span class="muted">已选 {{ selected.length }} 项</span>
          <van-button size="mini" plain type="primary" @click="batchEditShow = true">批量修改属性</van-button>
          <van-button size="mini" type="danger" @click="batchDelete">批量删除</van-button>
          <van-button size="mini" plain @click="selected = []">取消</van-button>
        </div>
        <div class="row" style="justify-content:space-between;margin-top:8px;">
          <span class="muted">共 {{ filtered.length }} 项</span>
          <van-button size="mini" plain @click="toggleAll">{{ allSel ? '取消全选' : '全选' }}</van-button>
        </div>
      </div>

      <div class="card">
        <div v-if="!filtered.length" class="empty">无匹配商品</div>
        <div v-for="p in filtered" :key="p.id" class="list-item">
          <div class="row">
            <van-checkbox :model-value="selected.includes(p.id)" style="margin-right:8px;" @click="toggleSel(p.id)" />
            <span class="grow item-title">{{ p.name }}</span>
            <van-tag :type="p.product_type === 'order' ? 'warning' : 'primary'" plain>
              {{ p.product_type === 'order' ? '订单' : '库存' }}
            </van-tag>
          </div>
          <div class="item-meta">
            {{ p.category || '—' }}{{ p.code ? ' · 编码 ' + p.code : '' }} · 单位 {{ p.default_unit || p.base_unit }}
            <template v-if="p.product_type === 'stock'"> · 库存 {{ fmtStock(p) }}</template>
          </div>
          <div class="item-meta">
            售价 {{ fmtMoney(unitPrice(p, 'sale_price')) }} · 参考成本 {{ fmtMoney(unitPrice(p, 'unit_cost')) }}
            <template v-if="p.product_type === 'stock'"> · 均价 {{ fmtMoney(unitPrice(p, 'avg_cost')) }}</template>
            · {{ p.is_active ? '启用' : '停用' }}
          </div>
          <div v-if="p.product_type === 'order'" class="item-meta">
            <template v-if="orderLinks(p).length">
              关联库存：{{ orderLinks(p).map((l) => `${l.name} × ${fmtNum(l.multiplier)}`).join('、') }}
            </template>
            <template v-else><van-tag type="warning" plain>代发</van-tag> 不扣库存，只统计代发数量/成本</template>
          </div>
          <div v-if="(p.pack_items || []).length || p.pack_fee" class="item-meta">
            关联结算：{{ (p.pack_items || []).map((it) => `${it.quantity}${it.unit} ${nameOf(it.product_id)}`).join('、') || '无' }}
            <template v-if="p.pack_fee"> · 固定费用 {{ fmtMoney(p.pack_fee) }}/单</template>
          </div>
          <div class="row" style="gap:8px;margin-top:6px;">
            <van-button size="mini" plain type="primary" @click="openProduct(p)">编辑</van-button>
            <van-button size="mini" plain type="danger" @click="delProduct(p)">删除</van-button>
          </div>
        </div>
      </div>
    </div>

    <!-- ============ 商品编辑弹层 ============ -->
    <van-popup v-model:show="editShow" position="bottom" round :style="{ height: '92%' }">
      <div class="sheet-body">
        <div class="sheet-title">{{ form.id ? '编辑商品' : '新增商品' }}</div>

        <van-cell-group inset>
          <van-field v-model="form.code" label="商品编码" placeholder="如 ydj001，可留空" />
          <van-field v-model="form.name" label="商品名称" placeholder="如：佛手柑大果2个" required />
          <van-field v-model="form.category" label="分类" placeholder="如：蔬菜">
            <template #button>
              <van-button size="mini" plain @click="catPickShow = true">选择</van-button>
            </template>
          </van-field>
          <van-field label="商品类型">
            <template #input>
              <van-radio-group v-model="form.product_type" direction="horizontal" @change="onTypeChange">
                <van-radio name="stock">库存商品（大类）</van-radio>
                <van-radio name="order">订单商品（小类）</van-radio>
              </van-radio-group>
            </template>
          </van-field>
          <van-field :model-value="form.unit" readonly label="单位" placeholder="点击选择" @click="unitPickShow = true" />
          <van-field v-model="form.sale_price" type="number" label="默认售价" placeholder="每基础单位" />
          <van-field v-model="form.unit_cost" type="number" label="参考成本" placeholder="每基础单位" />
          <van-field v-model="form.weight_kg" type="number" label="单件净重" placeholder="kg，用于算快递费">
            <template #button><span class="muted">kg</span></template>
          </van-field>
          <van-field v-model="form.spec" label="规格说明" placeholder="如：每个约150克；或每袋5斤" />
        </van-cell-group>
        <div class="muted" style="padding:0 4px 8px;">
          重量类按克记账（1斤=500克），计数类按个记账；订单商品固定为「单」。单位换算表由所选单位自动生成。
        </div>

        <template v-if="form.product_type === 'order'">
          <van-cell-group inset title="关联库存商品（出库扣减对象·可多个）">
            <div v-if="!form.stock_links.length" class="muted" style="padding:8px 4px;">未关联任何库存商品 = <b>代发</b>：不扣库存，只统计代发数量与代发成本</div>
            <div v-for="(l, i) in form.stock_links" :key="i" class="row" style="gap:8px;align-items:center;padding:6px 4px;">
              <span class="grow pack-name" @click="openStockLinkPicker(i)">{{ nameOf(l.product_id) || '＋ 选择库存商品' }}</span>
              <van-field v-model="l.multiplier" type="number" label="倍数" style="max-width:160px;" />
              <van-icon name="delete-o" color="#ee0a24" @click="form.stock_links.splice(i, 1)" />
            </div>
            <van-button size="mini" plain type="primary" icon="plus" style="margin:8px 4px;" @click="addStockLink">添加扣减库存商品</van-button>
          </van-cell-group>
          <div class="muted" style="padding:0 4px 8px;">
            卖 1 单本商品时，从下面每个库存大类按其倍数扣减库存（如 礼盒 = 苹果1斤 + 梨1斤）；
            一个都不填 = <b>代发</b>：本仓不扣库存，只统计代发数量与代发成本（按「参考成本」计）。
          </div>
        </template>

        <div class="divider"></div>
        <div class="row" style="justify-content:space-between;">
          <span class="bold">出库关联结算清单</span>
          <van-button size="mini" plain type="primary" icon="plus" @click="addPack">添加</van-button>
        </div>
        <div class="muted" style="margin-bottom:6px;">卖 1 单本商品时，自动扣减这些商品（包材 / 人工等）的库存。</div>

        <div v-if="!form.pack_items.length" class="empty" style="padding:10px 0;">未配置关联结算项</div>
        <div v-for="(it, i) in form.pack_items" :key="i" class="pack-edit-row">
          <div class="row">
            <span class="grow pack-name" @click="openPackPicker(i)">{{ nameOf(it.product_id) || '＋ 选择商品' }}</span>
            <van-icon name="delete-o" color="#ee0a24" @click="form.pack_items.splice(i, 1)" />
          </div>
          <div class="row mt8">
            <van-field v-model="it.quantity" type="number" label="数量" />
            <van-field :model-value="it.unit" readonly label="单位" style="max-width:110px;" @click="openPackUnit(i)" />
          </div>
        </div>

        <van-cell-group inset style="margin-top:10px;">
          <van-field v-model="form.pack_fee" type="number" label="固定费用/单" placeholder="如人工打包费，元" />
          <van-field v-if="form.id" label="启用该商品">
            <template #input><van-switch v-model="form.is_active" size="20" /></template>
          </van-field>
        </van-cell-group>

        <div class="sheet-foot">
          <van-button v-if="form.id" block plain type="danger" @click="delProductById(form.id)">删除</van-button>
          <van-button block plain @click="editShow = false">取消</van-button>
          <van-button block type="primary" :loading="saving" @click="save">保存</van-button>
        </div>
      </div>
    </van-popup>

    <!-- ============ 批量修改属性 ============ -->
    <van-popup v-model:show="batchEditShow" position="bottom" round>
      <div class="sheet-body">
        <div class="sheet-title">批量修改 {{ selected.length }} 个商品</div>
        <div class="muted" style="margin-bottom:8px;">留空表示不修改该字段。</div>
        <van-cell-group inset>
          <van-field v-model="batchForm.category" label="分类" placeholder="留空不修改" />
          <van-field :model-value="batchForm.default_unit" readonly label="默认单位" placeholder="留空不修改" @click="batchUnitPickShow = true">
            <template #button><van-icon name="cross" v-if="batchForm.default_unit" @click.stop="batchForm.default_unit = ''" /></template>
          </van-field>
          <van-field v-model="batchForm.sale_price" type="number" label="售价" placeholder="留空不修改" />
          <van-field v-model="batchForm.unit_cost" type="number" label="参考成本" placeholder="留空不修改" />
          <van-field v-model="batchForm.pack_fee" type="number" label="固定费用" placeholder="留空不修改" />
          <van-field label="启用状态">
            <template #input>
              <van-radio-group v-model="batchForm.is_active" direction="horizontal">
                <van-radio :name="''">不修改</van-radio>
                <van-radio :name="true">启用</van-radio>
                <van-radio :name="false">停用</van-radio>
              </van-radio-group>
            </template>
          </van-field>
        </van-cell-group>
        <div class="sheet-foot">
          <van-button block plain @click="batchEditShow = false">取消</van-button>
          <van-button block type="primary" :loading="batchSaving" @click="submitBatchEdit">确认修改</van-button>
        </div>
      </div>
    </van-popup>

    <!-- ============ 计量单位管理 ============ -->
    <van-popup v-model:show="unitsShow" position="bottom" round :style="{ height: '76%' }">
      <div class="sheet-body">
        <div class="sheet-title">计量单位管理</div>
        <van-cell-group inset>
          <van-field v-model="newUnit.name" label="单位名称" placeholder="如：箱" />
          <van-field label="类型">
            <template #input>
              <van-radio-group v-model="newUnit.category" direction="horizontal">
                <van-radio name="count">计数类</van-radio>
                <van-radio name="weight">重量类</van-radio>
              </van-radio-group>
            </template>
          </van-field>
          <van-field
            v-if="newUnit.category === 'weight'"
            v-model="newUnit.gram_per_unit"
            type="number"
            label="每单位克数"
            placeholder="如 500"
          />
        </van-cell-group>
        <van-button block type="primary" :loading="unitSaving" style="margin-bottom:12px;" @click="addUnit">新增单位</van-button>

        <div v-for="u in unitList" :key="u.id" class="list-item">
          <div class="row">
            <span class="grow item-title">{{ u.name }}</span>
            <van-tag plain>{{ u.category === 'weight' ? '重量' : '计数' }}</van-tag>
            <span class="muted" v-if="u.gram_per_unit">{{ u.gram_per_unit }}g</span>
            <van-button size="mini" plain type="danger" @click="delUnit(u)">删除</van-button>
          </div>
        </div>
      </div>
    </van-popup>

    <ProductPicker v-model:show="packPickerShow" title="选择关联结算商品" :products="PRODUCTS" @pick="onPackPick" />
    <ProductPicker v-model:show="stockLinkPickShow" title="选择库存商品（大类）" :products="stockProducts" :type-tabs="false" @pick="onStockLinkPick" />

    <van-action-sheet v-model:show="catPickShow" :actions="catActions" cancel-text="取消" @select="onCatPick" />
    <van-action-sheet v-model:show="unitPickShow" :actions="unitActions" cancel-text="取消" @select="onUnitPick" />
    <van-action-sheet v-model:show="packUnitPickShow" :actions="packUnitActions" cancel-text="取消" @select="onPackUnitPick" />
    <van-action-sheet v-model:show="batchUnitPickShow" :actions="batchUnitActions" cancel-text="取消" @select="onBatchUnitPick" />
  </div>
</template>

<script setup>
import { ref, reactive, computed, onMounted } from 'vue'
import { useRouter, useRoute } from 'vue-router'
import { showToast, showConfirmDialog } from 'vant'
import api, { downloadFile } from '../api'
import ProductPicker from '../components/ProductPicker.vue'
import { fmtMoney, fmtNum, num, defaultUnit, unitFactor, fmtStock, shrink } from '../utils/format'

const router = useRouter()
const route = useRoute()
function goBack() {
  if (window.history.length > 1) router.back()
  else router.replace('/mine')
}

const PRODUCTS = ref([])
const UNITS = ref([])
const kw = ref('')
const ptype = ref('')
const pcat = ref('')
const selected = ref([])
const saving = ref(false)

const typeTabs = [
  { key: '', label: '全部类型' },
  { key: 'stock', label: '库存商品' },
  { key: 'order', label: '订单商品' },
  { key: 'pack', label: '包材' },
  { key: 'labor', label: '人工' },
  { key: 'express', label: '快递' },
]

const cats = computed(() => shrink(PRODUCTS.value.map((p) => p.category)))
const filtered = computed(() => {
  const s = (kw.value || '').trim().toLowerCase()
  return PRODUCTS.value.filter((p) => {
    if (s) {
      // 关键词：名称 / 分类 / 编码 / 规格 / 单位 / 出库方式（代发、扣减库存）/ 关联结算商品名
      // 这样搜「代发」就能筛出未关联库存大类的订单商品
      // 代发的关键词刻意不含「库存」二字：搜「库存」只出库存/扣减库存的商品，搜「代发」只出代发商品
      const way = p.product_type === 'order'
        ? (orderLinks(p).length ? `订单 扣减库存 ${orderLinks(p).map((l) => l.name).join(' ')}` : '订单 代发 外发')
        : '库存商品'
      const packs = (p.pack_items || []).map((it) => nameOf(it.product_id)).join(' ')
      const hit = `${p.name || ''} ${p.category || ''} ${p.code || ''} ${p.spec || ''} ${p.unit || ''} ${p.base_unit || ''} ${way} ${packs}`
      if (!hit.toLowerCase().includes(s)) return false
    }
    if (ptype.value === 'pack' || ptype.value === 'labor' || ptype.value === 'express') {
      const label = { pack: '包材', labor: '人工', express: '快递' }[ptype.value]
      if (p.category !== label) return false
    } else if (ptype.value === 'stock') {
      if (p.product_type !== 'stock') return false
    } else if (ptype.value === 'order') {
      if (p.product_type !== 'order') return false
    }
    if (pcat.value && p.category !== pcat.value) return false
    return true
  })
})
const allSel = computed(() => filtered.value.length > 0 && filtered.value.every((p) => selected.value.includes(p.id)))
const stockProducts = computed(() => PRODUCTS.value.filter((p) => p.product_type === 'stock'))

const nameOf = (pid) => (PRODUCTS.value.find((p) => p.id === +pid) || {}).name || ''
const unitPrice = (p, field) => num(p[field]) * unitFactor(p, defaultUnit(p))
/* 订单商品的扣减库存商品清单（支持多个；兼容旧的单关联字段） */
function orderLinks(p) {
  const raw = (p.stock_links && p.stock_links.length)
    ? p.stock_links
    : (p.stock_product_id ? [{ product_id: p.stock_product_id, multiplier: p.multiplier || 1 }] : [])
  return raw.map((l) => ({
    product_id: l.product_id,
    multiplier: num(l.multiplier) || 1,
    name: l.name || nameOf(l.product_id),
  }))
}

async function load() {
  try { PRODUCTS.value = await api('/api/products') } catch (e) { showToast(e.message || '加载失败') }
  try { UNITS.value = await api('/api/units') } catch (e) {}
}

/* ---------- 选择 ---------- */
function toggleSel(id) {
  const i = selected.value.indexOf(id)
  if (i >= 0) selected.value.splice(i, 1)
  else selected.value.push(id)
}
function toggleAll() { selected.value = allSel.value ? [] : filtered.value.map((p) => p.id) }

/* ---------- 导出 ---------- */
async function exportJson(kind) {
  try {
    const data = await api(`/api/product-data/${kind}`)
    downloadJson(data, `${kind}.json`)
    showToast('已导出')
  } catch (e) { showToast('导出失败：' + e.message) }
}

/* ---------- 商品编辑 ---------- */
const editShow = ref(false)
const form = reactive({
  id: 0, code: '', name: '', category: '', product_type: 'stock', unit: '斤',
  sale_price: 0, unit_cost: 0, weight_kg: 0, spec: '', pack_items: [], pack_fee: 0,
  stock_links: [], is_active: true, base_unit: '克', conversions: {},
})

const stockUnitOptions = ['克', '斤', '公斤', '千克', '个', '袋', '包', '盒', '箱', '件', '份', '单']
function deriveUnitPayload(pt, unit) {
  if (pt === 'order' || unit === '单') return { base_unit: '单', default_unit: '单', conversions: { 单: 1 } }
  if (['克', '斤', '公斤', '千克'].includes(unit))
    return { base_unit: '克', default_unit: unit, conversions: { 克: 1, 斤: 500, 公斤: 1000, 千克: 1000 } }
  return { base_unit: '个', default_unit: unit, conversions: { 个: 1, [unit]: 1 } }
}

function openProduct(p, prefillName = '') {
  if (!p) {
    Object.assign(form, {
      id: 0, code: '', name: prefillName || '', category: pcat.value || '', product_type: 'stock', unit: '斤',
      sale_price: 0, unit_cost: 0, weight_kg: 0, spec: '', pack_items: [], pack_fee: 0,
      stock_links: [], is_active: true,
    })
  } else {
    const u = p.default_unit || p.base_unit
    Object.assign(form, {
      id: p.id, code: p.code || '', name: p.name || '', category: p.category || '',
      product_type: p.product_type || 'stock',
      unit: p.product_type === 'order' ? '单' : (stockUnitOptions.includes(u) ? u : '斤'),
      sale_price: p.sale_price || 0, unit_cost: p.unit_cost || 0, weight_kg: p.weight_kg || 0,
      spec: p.spec || '', pack_fee: p.pack_fee || 0,
      stock_links: orderLinks(p).map((l) => ({ product_id: l.product_id, multiplier: l.multiplier })),
      is_active: p.is_active !== false,
      pack_items: (p.pack_items || []).map((it) => ({ product_id: it.product_id, quantity: it.quantity, unit: it.unit })),
    })
  }
  editShow.value = true
}

function onTypeChange(v) {
  if (v === 'order') { form.unit = '单'; form.conversions = { 单: 1 }; form.base_unit = '单' }
  else if (form.unit === '单') { form.unit = '斤'; form.stock_links = [] }
}

async function save() {
  if (!form.name.trim()) { showToast('请填写商品名称'); return }
  const payload = deriveUnitPayload(form.product_type, form.unit)
  // 订单商品的扣减库存商品（可多个）：存在空行/倍数非法时拦住，避免保存出无效关联
  if (form.product_type === 'order' && form.stock_links.some((l) => !l.product_id || !(num(l.multiplier) > 0))) {
    showToast('关联库存商品存在无效行（商品/倍数需完整）')
    return
  }
  // 订单商品不关联任何库存大类 = 代发（本仓不扣库存，只统计代发数量与代发成本）；
  // 代发成本按「参考成本」计，没填会按 0 计，这里提醒但不拦保存。
  if (form.product_type === 'order' && !form.stock_links.length && !num(form.unit_cost)) {
    try {
      await showConfirmDialog({ title: '代发商品', message: '未关联库存大类（= 代发）且「参考成本」为 0，代发成本会按 0 计。仍要保存吗？' })
    } catch (e) { return }
  }
  if (form.pack_items.some((it) => !it.product_id || !(num(it.quantity) > 0) || !it.unit)) {
    showToast('关联结算清单存在无效行（商品/单位/数量需完整）')
    return
  }
  saving.value = true
  const body = {
    code: form.code,
    name: form.name,
    category: form.category,
    product_type: form.product_type,
    base_unit: payload.base_unit,
    default_unit: payload.default_unit,
    spec: form.spec,
    sale_price: num(form.sale_price),
    unit_cost: num(form.unit_cost),
    weight_kg: num(form.weight_kg),
    conversions: payload.conversions,
    pack_items: form.pack_items.map((it) => ({ product_id: +it.product_id, quantity: num(it.quantity), unit: it.unit })),
    pack_fee: num(form.pack_fee),
    // 多扣减关联；stock_product_id/multiplier 保留首项，兼容旧逻辑（扣点分类等）
    stock_links: form.product_type === 'order'
      ? form.stock_links.map((l) => ({ product_id: +l.product_id, multiplier: num(l.multiplier) || 1 }))
      : [],
    stock_product_id: form.product_type === 'order' && form.stock_links.length ? +form.stock_links[0].product_id : null,
    multiplier: form.product_type === 'order' && form.stock_links.length ? (num(form.stock_links[0].multiplier) || 1) : 1,
    is_active: form.is_active !== false,
  }
  try {
    if (form.id) await api(`/api/products/${form.id}`, 'PUT', body)
    else await api('/api/products', 'POST', body)
    showToast('商品已保存')
    editShow.value = false
    await load()
  } catch (e) { showToast('保存失败：' + e.message) }
  saving.value = false
}

async function delProduct(p) { delProductById(p.id, p.name) }
async function delProductById(id, name) {
  const nm = name || nameOf(id) || '该商品'
  try {
    await showConfirmDialog({ title: '删除商品', message: `确认删除「${nm}」？被单据或关联引用的商品将无法删除。` })
  } catch (e) { return }
  try {
    await api(`/api/products/${id}`, 'DELETE')
    showToast('已删除')
    editShow.value = false
    await load()
  } catch (e) { showToast('删除失败（可能已被引用，请用批量删除查看原因）') }
}

/* 关联结算清单选择 */
const packPickerShow = ref(false)
let packIndex = 0
function addPack() { form.pack_items.push({ product_id: null, quantity: 1, unit: '个' }) }
function openPackPicker(i) {
  packIndex = i
  packPickerShow.value = true
}
function onPackPick(p) {
  const it = form.pack_items[packIndex]
  if (!it) return
  it.product_id = p.id
  it.unit = p.default_unit || p.base_unit || '个'
}
const packUnitPickShow = ref(false)
const packUnitActions = ref([])
function openPackUnit(i) {
  packIndex = i
  const it = form.pack_items[i]
  const p = PRODUCTS.value.find((x) => x.id === +it.product_id)
  const convs = (p && p.conversions) || { 个: 1 }
  packUnitActions.value = Object.keys(convs).map((u) => ({ name: u, value: u }))
  packUnitPickShow.value = true
}
function onPackUnitPick(a) {
  const it = form.pack_items[packIndex]
  if (it) it.unit = a.value
}

/* 分类 / 单位 选择 */
const catPickShow = ref(false)
const catActions = computed(() => cats.value.map((c) => ({ name: c, value: c })))
function onCatPick(a) { form.category = a.value }

const unitPickShow = ref(false)
const unitActions = computed(() =>
  (form.product_type === 'order' ? ['单'] : stockUnitOptions).map((u) => ({ name: u, value: u }))
)
function onUnitPick(a) { form.unit = a.value }

/* 库存大类选择（支持多个扣减关联：按行索引回填） */
const stockLinkPickShow = ref(false)
const stockLinkIndex = ref(-1)
function addStockLink() {
  form.stock_links.push({ product_id: null, multiplier: 1 })
}
function openStockLinkPicker(i) {
  stockLinkIndex.value = i
  stockLinkPickShow.value = true
}
function onStockLinkPick(p) {
  const i = stockLinkIndex.value
  const it = i >= 0 ? form.stock_links[i] : null
  if (!it) return
  it.product_id = p.id
  if (!(num(it.multiplier) > 0)) it.multiplier = 1
}

/* ---------- 批量修改 ---------- */
const batchEditShow = ref(false)
const batchSaving = ref(false)
const batchForm = reactive({ category: '', default_unit: '', sale_price: '', unit_cost: '', pack_fee: '', is_active: '' })
const batchUnitPickShow = ref(false)
const batchUnitActions = computed(() => ['', ...stockUnitOptions].map((u) => ({ name: u || '不修改', value: u })))
function onBatchUnitPick(a) { batchForm.default_unit = a.value; batchUnitPickShow.value = false }

async function submitBatchEdit() {
  const body = { ids: selected.value }
  if (batchForm.category.trim()) body.category = batchForm.category.trim()
  if (batchForm.default_unit) body.default_unit = batchForm.default_unit
  if (batchForm.is_active !== '') body.is_active = batchForm.is_active
  if (batchForm.sale_price !== '') body.sale_price = num(batchForm.sale_price)
  if (batchForm.unit_cost !== '') body.unit_cost = num(batchForm.unit_cost)
  if (batchForm.pack_fee !== '') body.pack_fee = num(batchForm.pack_fee)
  if (Object.keys(body).length <= 1) { showToast('请至少填写一个要修改的字段'); return }
  batchSaving.value = true
  try {
    const r = await api('/api/products/batch-update', 'POST', body)
    showToast(`已修改 ${r.updated} 项`)
    batchEditShow.value = false
    selected.value = []
    Object.assign(batchForm, { category: '', default_unit: '', sale_price: '', unit_cost: '', pack_fee: '', is_active: '' })
    await load()
  } catch (e) { showToast('修改失败：' + e.message) }
  batchSaving.value = false
}

async function batchDelete() {
  try {
    await showConfirmDialog({ title: '批量删除商品', message: `确认删除已选 ${selected.value.length} 项？被引用的商品会自动跳过。` })
  } catch (e) { return }
  try {
    const r = await api('/api/products/batch-delete', 'POST', { ids: selected.value })
    let msg = `已删除 ${r.deleted} 项`
    if (r.blocked && r.blocked.length) msg += `；${r.blocked.length} 项被引用未删除：${r.blocked.slice(0, 5).join('、')}`
    showToast(msg)
    selected.value = []
    await load()
  } catch (e) { showToast('删除失败：' + e.message) }
}

/* ---------- 计量单位 ---------- */
const unitsShow = ref(false)
const unitSaving = ref(false)
const newUnit = reactive({ name: '', category: 'count', gram_per_unit: '' })
const unitList = computed(() => UNITS.value)
async function openUnits() {
  unitsShow.value = true
  try { UNITS.value = await api('/api/units') } catch (e) {}
}
async function addUnit() {
  if (!newUnit.name.trim()) { showToast('请填写单位名称'); return }
  if (newUnit.category === 'weight' && !(num(newUnit.gram_per_unit) > 0)) { showToast('重量类单位必须填写每单位克数'); return }
  unitSaving.value = true
  try {
    await api('/api/units', 'POST', {
      name: newUnit.name.trim(),
      category: newUnit.category,
      gram_per_unit: newUnit.category === 'weight' ? num(newUnit.gram_per_unit) : null,
    })
    showToast('已新增')
    newUnit.name = ''
    newUnit.gram_per_unit = ''
    UNITS.value = await api('/api/units')
  } catch (e) { showToast(e.message || '新增失败') }
  unitSaving.value = false
}
async function delUnit(u) {
  try { await showConfirmDialog({ title: '删除单位', message: `确认删除单位「${u.name}」？标准单位不可删除。` }) } catch (e) { return }
  try {
    await api(`/api/units/${u.id}`, 'DELETE')
    showToast('已删除')
    UNITS.value = await api('/api/units')
  } catch (e) { showToast(e.message || '删除失败') }
}

onMounted(async () => {
  await load()
  // 批量导入未关联商品时跳转过来：?new=商品名，直接打开新增弹窗并预填名称
  const nm = route.query.new
  if (nm) openProduct(null, Array.isArray(nm) ? nm[0] : String(nm))
})
</script>

<style scoped>
.sub-page { min-height: 100vh; background: #f7f8fa; }
.batch-bar { display: flex; align-items: center; gap: 6px; flex-wrap: wrap; background: #fff7e6; border-radius: 8px; padding: 8px 10px; margin-top: 8px; }
.pack-edit-row { padding: 8px 0; border-bottom: 1px dashed #f0f0f0; }
.pack-name { font-weight: 600; font-size: 13px; color: #1989fa; }
</style>
