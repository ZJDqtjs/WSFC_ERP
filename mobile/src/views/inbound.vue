<template>
  <div>
    <div class="card">
      <div class="card-title">快捷入库</div>
      <van-form @submit="submit">
        <van-cell-group inset>
          <van-field v-model="date" label="日期" type="date" />
          <van-field v-model="supplier" label="供应商" placeholder="可留空" />
          <van-field v-model="remark" label="备注" placeholder="可留空" />
        </van-cell-group>

        <div class="row" v-for="(r, i) in rows" :key="r._key" style="padding:8px 16px;align-items:flex-start;">
          <div class="pk-cell" @click="openPicker(i)">
            <div v-if="r.product_id" class="pk-selected">{{ r.label }}</div>
            <div v-else class="pk-placeholder">＋ 选择商品</div>
          </div>
          <van-field v-model="r.qty" label="数量" type="number" placeholder="0" style="width:74px" />
          <van-field v-model="r.price" label="单价" type="number" placeholder="0" style="width:84px" />
          <van-icon name="delete-o" color="#ee0a24" @click="rows.splice(i,1)" style="margin-top:14px;" />
        </div>
        <div class="add-row"><van-button size="small" plain type="primary" @click="addRow">＋ 加一行</van-button></div>

        <div class="sum-row"><span class="muted">采购合计</span><b>{{ fmtMoney(total) }}</b></div>
        <div class="login-btn">
          <van-button round block type="primary" :loading="submitting" loading-text="入库中…" native-type="submit">确认入库</van-button>
        </div>
      </van-form>
    </div>

    <product-picker v-model:show="showPicker" title="选择入库商品" :list="inList" @pick="pick" />
  </div>
</template>

<script setup>
import { ref, computed, onMounted } from 'vue'
import { showToast } from 'vant'
import api from '../api'
import ProductPicker from '../components/product-picker.vue'
import { loadProducts, inboundProducts } from '../store/products'

let _id = 0
const rows = ref([{ _key: ++_id, product_id: '', qty: '1', price: '0', unit: '', label: '' }])
const date = ref(new Date().toISOString().slice(0, 10))
const supplier = ref(''), remark = ref('')
const showPicker = ref(false), submitting = ref(false)
const pickIdx = ref(0)
const inList = ref([])

const fmtMoney = (v) => '¥' + (+v || 0).toLocaleString('zh-CN', { minimumFractionDigits: 2 })
const total = computed(() => rows.value.reduce((s, r) => s + (+r.qty || 0) * (+r.price || 0), 0))

async function loadList() {
  await loadProducts()
  inList.value = inboundProducts()
}
onMounted(loadList)

const addRow = () => rows.value.push({ _key: ++_id, product_id: '', qty: '1', price: '0', unit: '', label: '' })
const openPicker = (i) => { pickIdx.value = i; showPicker.value = true }

function pick(p) {
  const r = rows.value[pickIdx.value]
  const du = p.default_unit || p.base_unit
  r.product_id = p.id
  r.unit = du
  r.label = `〔库存〕 ${p.name}（${p.category || '—'}）`
  // 带出参考采购单价：优先加权平均成本，其次参考成本（按所选单位换算）
  const factor = (p.conversions || {})[du] || 1
  const cost = (p.avg_cost > 0 ? p.avg_cost : p.unit_cost) * factor
  if (cost > 0 && (!r.price || r.price === '0')) r.price = cost.toFixed(2)
  showPicker.value = false
}

async function submit() {
  if (submitting.value) return   // 防重复提交
  const lines = rows.value.filter((r) => r.product_id)
  if (!lines.length) { showToast('请至少选择一条商品'); return }
  if (lines.some((r) => !(+r.qty > 0))) { showToast('数量必须大于 0'); return }
  submitting.value = true
  const failed = []
  try {
    for (const r of lines) {
      try {
        await api('/api/inbounds', 'POST', {
          product_id: +r.product_id, unit: r.unit || '个', quantity: +r.qty,
          unit_price: +r.price, supplier: supplier.value, date: date.value, remark: remark.value,
        })
      } catch (e) { failed.push(`${r.label}：${e.message}`) }
    }
    if (failed.length) {
      showToast({ message: `部分失败（${failed.length}/${lines.length}）：${failed[0]}`, duration: 3800 })
    } else {
      showToast('入库成功')
      rows.value = [{ _key: ++_id, product_id: '', qty: '1', price: '0', unit: '', label: '' }]
      supplier.value = ''; remark.value = ''
      loadProducts(true)
    }
  } finally { submitting.value = false }
}
</script>

<style scoped>
.add-row { padding: 8px 16px; }
.login-btn { margin: 8px 18px 4px; }
.sum-row { display: flex; justify-content: space-between; padding: 10px 18px 0; }
.pk-cell { flex: 1; min-width: 0; }
.pk-cell .pk-selected { font-size: 13px; padding: 10px 12px; background: #f7f8fa; border-radius: 8px; word-break: break-all; }
.pk-cell .pk-placeholder { color: #1989fa; padding: 10px 12px; background: #f0f8ff; border-radius: 8px; }
</style>