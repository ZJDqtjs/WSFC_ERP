import { ref } from 'vue'
import api from '../api'

/** 全局商品缓存（与桌面端 PRODUCTS 对齐），供选择器 / AI 确认框共用 */
export const PRODUCTS = ref([])

let loading = null

export async function loadProducts(force = false) {
  if (PRODUCTS.value.length && !force) return PRODUCTS.value
  if (loading && !force) return loading
  loading = api('/api/products')
    .then((ps) => { PRODUCTS.value = ps || []; return PRODUCTS.value })
    .catch(() => PRODUCTS.value)
    .finally(() => { loading = null })
  return loading
}

/** AI 分类标签（与后端 ai.py 的 stock/order/pack/labor 对齐） */
export const AI_CAT_ORDER = [
  ['stock', '库存商品'],
  ['order', '订单商品'],
  ['pack', '包材'],
  ['labor', '人工'],
]
export const AI_CAT_SHORT = { stock: '库存', order: '订单', pack: '包材', labor: '人工' }

/** 按 AI 分类过滤商品（复刻桌面端 aiProductsByCat） */
export function productsByCat(cat) {
  return PRODUCTS.value.filter((p) => p.is_active).filter((p) => {
    const c = (p.category || '').trim()
    if (cat === 'order') return p.product_type === 'order'
    if (cat === 'pack') return c === '包材' || c === '耗材' || c === '包装'
    if (cat === 'labor') return c === '人工' || /打包$/.test(p.name)
    return p.product_type === 'stock' && !['人工', '包材', '耗材', '包装'].includes(c)
  }).slice().sort((a, b) => a.name.localeCompare(b.name, 'zh'))
}

/** 销售可选商品：排除 人工/快递（自动结算项，不可单独销售） */
export function saleProducts() {
  return PRODUCTS.value.filter((p) => p.is_active && !['人工', '快递'].includes(p.category))
}

/** 入库可选商品：库存商品（含包材），排除 订单/人工/快递 */
export function inboundProducts() {
  return PRODUCTS.value.filter(
    (p) => p.is_active && p.product_type === 'stock' && !['人工', '快递'].includes(p.category),
  )
}

export const findProduct = (id) => PRODUCTS.value.find((p) => p.id === +id)
