<template>
  <div class="sub-page">
    <van-nav-bar title="扣点设置" left-arrow fixed safe-area-inset-top placeholder @click-left="goBack" />
    <div class="sub-body">
      <!-- 商品类别扣点 -->
      <div class="card">
        <div class="card-title">
          <span class="grow">商品类别扣点</span>
          <van-button size="mini" plain type="primary" icon="plus" @click="openDeduc()">新增</van-button>
        </div>
        <div class="card-desc">
          按商品类别设置入库扣点百分比；批量导入 → 入库解析「进货单价」时按 原价 × (1 − 扣点%) 折算为入库成本（影响库存均价与利润）。
        </div>
        <SkeletonList v-if="loading" :rows="3" />
        <template v-else>
          <div v-if="!list.length" class="empty">暂无类别扣点规则</div>
          <div v-for="d in list" :key="d.id" class="list-item">
            <div class="row">
              <span class="grow item-title">{{ d.category }}</span>
              <span class="num-r c-danger">{{ fmtNum(d.percent) }}%</span>
            </div>
            <div v-if="d.remark" class="item-meta">{{ d.remark }}</div>
            <div class="row" style="gap:8px;margin-top:6px;">
              <van-button size="mini" plain type="primary" @click="openDeduc(d)">编辑</van-button>
              <van-button size="mini" plain type="danger" @click="delDeduc(d)">删除</van-button>
            </div>
          </div>
        </template>
      </div>

      <!-- 店铺扣点 -->
      <div class="card">
        <div class="card-title">
          <span class="grow">店铺扣点规则</span>
          <van-button size="mini" plain type="primary" icon="plus" @click="openShop()">新增</van-button>
        </div>
        <div class="card-desc">
          聚水潭订单导入时按「店铺名称」扣减订单收入（卖家实收），保存后立即生效。
        </div>
        <div v-if="!shopRules.length" class="empty">暂无店铺扣点规则</div>
        <div v-for="r in shopRules" :key="r.shop" class="list-item">
          <div class="row">
            <span class="grow item-title">{{ r.shop }}</span>
            <span v-if="r.percent != null" class="num-r c-danger">{{ fmtNum(r.percent) }}%</span>
            <van-tag v-else type="primary" plain>按分类</van-tag>
          </div>
          <div v-if="r.categories" class="item-meta">
            <span v-for="(v, k) in r.categories" :key="k" class="cat-chip">{{ k }} {{ fmtNum(v) }}%</span>
          </div>
          <div class="row" style="gap:8px;margin-top:6px;">
            <van-button size="mini" plain type="primary" @click="openShop(r)">编辑</van-button>
            <van-button size="mini" plain type="danger" @click="delShop(r)">删除</van-button>
          </div>
        </div>
        <div class="card-desc" style="margin:8px 0 0;">配置文件：{{ shopFile || '—' }}</div>
      </div>
    </div>

    <!-- 类别扣点编辑 -->
    <van-popup v-model:show="deducShow" position="bottom" round>
      <div class="sheet-body">
        <div class="sheet-title">{{ deducForm.old ? '编辑' : '新增' }}类别扣点</div>
        <van-cell-group inset>
          <van-field
            v-model="deducForm.category"
            :readonly="!!deducForm.old"
            label="商品类别"
            placeholder="如：蔬菜"
            @click="!deducForm.old && (catPickShow = true)"
          />
          <van-field v-model="deducForm.percent" type="number" label="扣点" placeholder="0 ~ 100（不含 100）">
            <template #button><span class="muted">%</span></template>
          </van-field>
          <van-field v-model="deducForm.remark" label="备注" placeholder="可留空" />
        </van-cell-group>
        <div class="card-desc" style="padding:0 4px 8px;margin-bottom:0;">同类别的规则为「新增或更新」，重复提交会覆盖原百分比。</div>
        <div class="sheet-foot">
          <van-button block plain @click="deducShow = false">取消</van-button>
          <van-button block type="primary" :loading="saving" @click="saveDeduc">保存</van-button>
        </div>
      </div>
    </van-popup>

    <!-- 店铺扣点编辑 -->
    <van-popup v-model:show="shopShow" position="bottom" round :style="{ height: '82%' }">
      <div class="sheet-body">
        <div class="sheet-title">{{ shopForm.old ? '编辑' : '新增' }}店铺扣点</div>
        <van-cell-group inset>
          <van-field v-model="shopForm.shop" :readonly="!!shopForm.old" label="店铺名称" placeholder="如：某某旗舰店" />
          <van-field label="扣点方式">
            <template #input>
              <van-radio-group v-model="shopForm.mode" direction="horizontal">
                <van-radio name="fixed">固定扣点</van-radio>
                <van-radio name="category">按分类扣点</van-radio>
              </van-radio-group>
            </template>
          </van-field>
          <van-field v-if="shopForm.mode === 'fixed'" v-model="shopForm.percent" type="number" label="扣点" placeholder="0 ~ 100">
            <template #button><span class="muted">%</span></template>
          </van-field>
        </van-cell-group>

        <template v-if="shopForm.mode === 'category'">
          <div class="row" style="justify-content:space-between;margin:6px 0;">
            <span class="bold">分类扣点</span>
            <van-button size="mini" plain type="primary" icon="plus" @click="shopCats.push({ category: '', percent: '' })">添加分类</van-button>
          </div>
          <div v-if="!shopCats.length" class="empty" style="padding:10px 0;">尚未添加分类扣点</div>
          <div v-for="(c, i) in shopCats" :key="i" class="row" style="margin-bottom:8px;">
            <van-field v-model="c.category" placeholder="分类名" class="field-bg" />
            <van-field v-model="c.percent" type="number" placeholder="%" class="field-bg" style="max-width:96px;" />
            <van-icon name="cross" class="c-danger" @click="shopCats.splice(i, 1)" />
          </div>
        </template>

        <div class="sheet-foot">
          <van-button block plain @click="shopShow = false">取消</van-button>
          <van-button block type="primary" :loading="saving" @click="saveShop">保存</van-button>
        </div>
      </div>
    </van-popup>

    <van-action-sheet v-model:show="catPickShow" :actions="catActions" cancel-text="取消" @select="onCatPick" />
  </div>
</template>

<script setup>
import { ref, reactive, computed, onMounted } from 'vue'
import { useRouter } from 'vue-router'
import { showToast, showConfirmDialog } from 'vant'
import api from '../api'
import SkeletonList from '../components/SkeletonList.vue'
import { fmtNum, num, shrink } from '../utils/format'

const router = useRouter()
function goBack() {
  if (window.history.length > 1) router.back()
  else router.replace('/mine')
}

const list = ref([])
const shopRules = ref([])
const shopFile = ref('')
const saving = ref(false)
const loading = ref(true)
const cats = ref([])
const catActions = computed(() => cats.value.map((c) => ({ name: c, value: c })))

async function load() {
  try { list.value = await api('/api/deductions') } catch (e) { showToast(e.message || '加载扣点失败') }
  try {
    const d = await api('/api/deductions/shops')
    shopRules.value = d.rules || []
    shopFile.value = d.file || ''
  } catch (e) {}
  try {
    const ps = await api('/api/products')
    cats.value = shrink(ps.map((p) => p.category))
  } catch (e) {}
  loading.value = false
}

/* ---------- 类别扣点 ---------- */
const deducShow = ref(false)
const deducForm = reactive({ old: '', category: '', percent: '', remark: '' })
const catPickShow = ref(false)

function openDeduc(d) {
  if (d) Object.assign(deducForm, { old: d.category, category: d.category, percent: d.percent, remark: d.remark || '' })
  else Object.assign(deducForm, { old: '', category: '', percent: '', remark: '' })
  deducShow.value = true
}
function onCatPick(a) { deducForm.category = a.value }

async function saveDeduc() {
  if (!deducForm.category.trim()) { showToast('请填写商品类别'); return }
  const p = num(deducForm.percent)
  if (p < 0 || p >= 100) { showToast('扣点百分比需在 0 ~ 100 之间（不含 100）'); return }
  saving.value = true
  try {
    await api('/api/deductions', 'POST', { category: deducForm.category.trim(), percent: p, remark: deducForm.remark })
    showToast('已保存')
    deducShow.value = false
    list.value = await api('/api/deductions')
  } catch (e) { showToast(e.message || '保存失败') }
  saving.value = false
}

async function delDeduc(d) {
  try { await showConfirmDialog({ title: '删除扣点', message: `确认删除「${d.category}」的扣点规则？` }) } catch (e) { return }
  try {
    await api(`/api/deductions/${d.id}`, 'DELETE')
    showToast('已删除')
    list.value = await api('/api/deductions')
  } catch (e) { showToast(e.message || '删除失败') }
}

/* ---------- 店铺扣点 ---------- */
const shopShow = ref(false)
const shopForm = reactive({ old: '', shop: '', mode: 'fixed', percent: '' })
const shopCats = ref([])

function openShop(r) {
  if (r) {
    shopForm.old = r.shop
    shopForm.shop = r.shop
    if (r.categories) {
      shopForm.mode = 'category'
      shopForm.percent = ''
      shopCats.value = Object.entries(r.categories).map(([category, percent]) => ({ category, percent }))
    } else {
      shopForm.mode = 'fixed'
      shopForm.percent = r.percent
      shopCats.value = []
    }
  } else {
    shopForm.old = ''
    shopForm.shop = ''
    shopForm.mode = 'fixed'
    shopForm.percent = ''
    shopCats.value = []
  }
  shopShow.value = true
}

async function saveShop() {
  const shop = shopForm.shop.trim()
  if (!shop) { showToast('店铺名称不能为空'); return }
  let body
  if (shopForm.mode === 'fixed') {
    const p = num(shopForm.percent)
    if (p < 0 || p >= 100) { showToast('固定扣点需在 0 ~ 100 之间（不含 100）'); return }
    body = { shop, percent: p }
  } else {
    const categories = {}
    shopCats.value.forEach((c) => {
      const k = (c.category || '').trim()
      const v = num(c.percent)
      if (k && v > 0) categories[k] = v
    })
    if (!Object.keys(categories).length) { showToast('请至少填写一个分类扣点'); return }
    body = { shop, categories }
  }
  saving.value = true
  try {
    await api('/api/deductions/shops', 'POST', body)
    showToast('已保存')
    shopShow.value = false
    const d = await api('/api/deductions/shops')
    shopRules.value = d.rules || []
  } catch (e) { showToast(e.message || '保存失败') }
  saving.value = false
}

async function delShop(r) {
  try { await showConfirmDialog({ title: '删除店铺扣点', message: `确认删除「${r.shop}」的扣点规则？` }) } catch (e) { return }
  try {
    await api(`/api/deductions/shops/${encodeURIComponent(r.shop)}`, 'DELETE')
    showToast('已删除')
    const d = await api('/api/deductions/shops')
    shopRules.value = d.rules || []
  } catch (e) { showToast(e.message || '删除失败') }
}

onMounted(load)
</script>

<style scoped>
.cat-chip { display: inline-block; background: var(--c-line); border-radius: 10px; padding: 2px 8px; margin: 2px 4px 0 0; font-size: 11px; }
</style>
