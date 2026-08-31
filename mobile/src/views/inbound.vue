<template>
  <div>
    <div class="card">
      <div class="card-title">快捷入库</div>
      <van-form @submit="submit">
        <van-cell-group inset>
          <van-field v-model="date" label="日期" type="date" />
          <van-field v-model="supplier" label="供应商" placeholder="可留空" />
        </van-cell-group>
        <div class="row" v-for="(r, i) in rows" :key="i" style="padding:8px 16px;align-items:flex-start;">
          <div class="pk-cell" @click="openPicker(i)">
            <div v-if="r.product_id" class="pk-selected">{{ r.label }}</div>
            <div v-else class="pk-placeholder">＋ 选择商品</div>
          </div>
          <van-field v-model="r.qty" label="数量" type="number" placeholder="0" style="width:74px" />
          <van-field v-model="r.price" label="单价" type="number" placeholder="0" style="width:84px" />
          <van-icon name="delete-o" color="#ee0a24" @click="rows.splice(i,1)" style="margin-top:14px;" />
        </div>
        <div class="add-row"><van-button size="small" plain type="primary" @click="addRow">＋ 加一行</van-button></div>
        <div class="login-btn"><van-button round block type="primary" native-type="submit">确认入库</van-button></div>
      </van-form>
    </div>

    <!-- 商品选择二级页面 -->
    <van-popup v-model:show="showPicker" position="bottom" round style="height:86%">
      <div class="pk-head">
        <span class="pk-title">选择入库商品</span>
        <van-icon name="cross" size="18" @click="showPicker = false" />
      </div>
      <van-search v-model="pkKw" placeholder="搜索商品名称 / 分类" />
      <div class="pk-cats">
        <van-tag v-for="c in pkCats" :key="c" :type="pkCat === c ? 'primary' : 'default'" round style="cursor:pointer;" @click="pkCat = pkCat === c ? '' : c">{{ c }}</van-tag>
      </div>
      <div class="pk-list">
        <div v-for="p in pkFiltered" :key="p.id" class="pk-item" @click="pick(p)">
          <div class="grow">
            <b>〔库存〕 {{ p.name }}</b>
            <div class="muted">{{ p.category }} · 单位 {{ p.default_unit || p.base_unit }} · 库存 {{ fmtStock(p) }}</div>
          </div>
          <van-icon name="chevron-right" color="#c8c9cc" />
        </div>
        <van-empty v-if="!pkFiltered.length" description="无匹配商品" />
      </div>
    </van-popup>
  </div>
</template>

<script setup>
import { ref, computed, onMounted } from 'vue'
import { showToast } from 'vant'
import api from '../api'

const rows = ref([{ product_id: '', qty: '1', price: '0', unit: '', label: '' }])
const date = ref(new Date().toISOString().slice(0, 10))
const supplier = ref('')
const showPicker = ref(false)
const pickIdx = ref(0)
const pkKw = ref('')
const pkCat = ref('')
const pkAll = ref([])

const fmtStock = (p) => {
  const du = p.default_unit || p.base_unit || ''
  const f = (p.conversions || {})[du] || 1
  return `${f && f !== 1 ? +p.stock / f : +p.stock} ${f && f !== 1 ? du : p.base_unit}`
}
const pkCats = computed(() => [...new Set(pkAll.value.map((p) => p.category).filter(Boolean))])
const pkFiltered = computed(() => {
  const s = (pkKw.value || '').trim().toLowerCase()
  return pkAll.value.filter((p) =>
    (!s || p.name.toLowerCase().includes(s) || (p.category || '').toLowerCase().includes(s)) &&
    (!pkCat.value || p.category === pkCat.value))
})

async function loadProducts() {
  try {
    const ps = await api('/api/products')
    // 入库商品：库存商品（含包材），排除 订单/人工/快递
    pkAll.value = ps.filter((p) => p.is_active && p.product_type === 'stock' && !['人工', '快递'].includes(p.category))
  } catch (e) {}
}
onMounted(loadProducts)
const addRow = () => rows.value.push({ product_id: '', qty: '1', price: '0', unit: '', label: '' })
const openPicker = (i) => { pickIdx.value = i; showPicker.value = true }
function pick(p) {
  const r = rows.value[pickIdx.value]
  const du = p.default_unit || p.base_unit
  r.product_id = p.id
  r.unit = du
  r.label = `〔库存〕 ${p.name}（${p.category || '—'}）`
  showPicker.value = false
}

async function submit() {
  const lines = rows.value.filter((r) => r.product_id)
  if (!lines.length) { showToast('请至少选择一条商品'); return }
  try {
    for (const r of lines) {
      await api('/api/inbounds', 'POST', {
        product_id: +r.product_id, unit: r.unit || '个', quantity: +r.qty,
        unit_price: +r.price, supplier: supplier.value, date: date.value, remark: '',
      })
    }
    showToast('入库成功')
    rows.value = [{ product_id: '', qty: '1', price: '0', unit: '', label: '' }]
  } catch (e) { showToast('入库失败：' + e.message) }
}
</script>

<style scoped>
.add-row { padding: 8px 16px; }
.login-btn { margin: 16px 18px 4px; }
.pk-head { display: flex; align-items: center; justify-content: space-between; padding: 14px 16px 4px; }
.pk-title { font-weight: 600; }
.pk-cats { display: flex; flex-wrap: wrap; gap: 8px; padding: 10px 16px; }
.pk-list { max-height: 60vh; overflow-y: auto; padding: 0 4px 16px; }
.pk-item { display: flex; align-items: center; gap: 10px; padding: 12px 16px; border-bottom: 1px solid #f5f5f5; }
.pk-item:active { background: #f5f6f7; }
.pk-cell { flex: 1; min-width: 0; }
.pk-cell .pk-selected { font-size: 13px; padding: 10px 12px; background: #f7f8fa; border-radius: 8px; word-break: break-all; }
.pk-cell .pk-placeholder { color: #1989fa; padding: 10px 12px; background: #f0f8ff; border-radius: 8px; }
</style>
