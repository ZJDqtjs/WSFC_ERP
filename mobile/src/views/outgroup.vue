<template>
  <div class="og-page">
    <van-nav-bar title="出库批次明细" left-arrow fixed placeholder @click-left="goBack" />

    <div v-if="loading" class="empty">加载中…</div>
    <template v-else-if="rows.length">
      <div class="stat-grid cols2" style="padding:0 12px;">
        <div class="stat accent"><div class="label">批次单数</div><div class="value">{{ rows.length }}</div></div>
        <div class="stat"><div class="label">销售商品种数</div><div class="value">{{ aggSale.length }}</div></div>
        <div class="stat"><div class="label">耗材种数</div><div class="value">{{ aggPack.length }}</div></div>
        <div class="stat"><div class="label">人工种数</div><div class="value">{{ aggLabor.length }}</div></div>
        <div class="stat"><div class="label">销售收入</div><div class="value">{{ fmtMoney(total.amount) }}</div></div>
        <div class="stat"><div class="label">结转成本</div><div class="value">{{ fmtMoney(total.cogs) }}</div></div>
        <div v-if="total.brush" class="stat danger"><div class="label">刷单成本</div><div class="value">{{ fmtMoney(total.brush) }}</div></div>
        <div class="stat success"><div class="label">净利</div><div class="value">{{ fmtMoney(total.net) }}</div></div>
      </div>

      <div class="seg" style="margin:12px;">
        <div
          v-for="s in segs"
          :key="s.key"
          class="seg-item"
          :class="{ active: seg === s.key }"
          @click="seg = s.key"
        >{{ s.label }}</div>
      </div>

      <div class="card" style="margin:0 12px 12px;">
        <van-search v-model="kw" placeholder="搜索商品" shape="round" />
        <div v-if="!current.length" class="empty">无记录</div>

        <!-- 销售商品：卡片展示单数/数量/金额/毛利/毛利率 -->
        <template v-if="seg === 'sale'">
          <div v-for="(a, i) in current" :key="i" class="list-item">
            <div class="row">
              <span class="grow item-title">{{ a.name }}</span>
              <van-tag type="primary" plain>{{ a.order_count }} 单</van-tag>
            </div>
            <div class="item-meta">
              {{ fmtNum(a.qty) }} {{ a.unit }} · 金额 {{ fmtMoney(a.amount) }}
              <template v-if="a.dropship_qty"> · <van-tag type="warning" plain>代发 {{ fmtNum(a.dropship_qty) }}</van-tag></template>
            </div>
            <div v-if="(a.specs || []).length" class="item-meta faint">规格 {{ a.specs.join(' / ') }}</div>
            <div class="item-meta">
              成本 {{ fmtMoney(a.cogs) }} · 毛利
              <b :class="a.amount - a.cogs >= 0 ? 'up' : 'down'">{{ fmtMoney(a.amount - a.cogs) }}</b>
              · 毛利率 {{ (a.gpRate || 0).toFixed(1) }}%
            </div>
            <!-- 成本构成：代发成本/商品成本 ＋ 打包人工 ＋ 耗材 ＋ 快递费（有哪项列哪项） -->
            <div v-if="costSplitText(a)" class="item-meta faint">{{ costSplitText(a) }}</div>
          </div>
        </template>

        <!-- 耗材 / 人工 / 打包人工+耗材：卡片展示归属、单数、数量、成本 -->
        <template v-else>
          <div v-for="(a, i) in current" :key="i" class="list-item">
            <div class="row">
              <span class="grow item-title">{{ a.name }}</span>
              <van-tag type="warning" plain>{{ a.order_count }} 单</van-tag>
            </div>
            <div v-if="seg !== 'laborpack'" class="item-meta">
              {{ fmtNum(a.qty) }} {{ a.unit }} · 成本 {{ fmtMoney(a.cogs) }}
            </div>
            <div v-else class="item-meta">
              成本 {{ fmtMoney(a.cogs) }}
            </div>
            <div v-if="a.subSub || a.sub" class="item-meta faint">{{ a.subSub || a.sub }}</div>
          </div>
        </template>
      </div>

      <div style="padding:0 12px 24px;">
        <van-button block round type="danger" plain :loading="deleting" @click="deleteBatch">
          删除本批（{{ rows.length }} 单）
        </van-button>
      </div>
    </template>
    <van-empty v-else description="未找到该批次" />
  </div>
</template>

<script setup>
import { ref, computed, onMounted } from 'vue'
import { useRoute, useRouter } from 'vue-router'
import { showToast, showConfirmDialog } from 'vant'
import api from '../api'
import { fmtMoney, fmtNum, num } from '../utils/format'

const route = useRoute()
const router = useRouter()
const loading = ref(true)
const deleting = ref(false)
const rows = ref([])
const kw = ref('')
const seg = ref('sale')

/** 成本构成小字：代发成本/商品成本 ＋ 打包人工 ＋ 耗材 ＋ 其他关联结算 ＋ 快递费 ＋ 刷单成本（有哪项列哪项） */
function costSplitText(a) {
  const express = num(a.express_cogs)
  const labor = num(a.labor_cogs)
  const material = num(a.material_cogs)
  const other = num(a.other_cogs)
  const brush = num(a.brush_cogs)   // 芳谊放单仓刷单结算
  if (!(a.is_dropship || labor || material || other || express || brush)) return ''
  const goods = num(a.base_cogs != null ? a.base_cogs : a.cogs)
  const parts = [`${a.is_dropship ? '代发成本' : '商品成本'} ${fmtMoney(goods)}`]
  if (labor) parts.push(`打包人工 ${fmtMoney(labor)}`)
  if (material) parts.push(`耗材 ${fmtMoney(material)}`)
  if (other) parts.push(`其他关联结算 ${fmtMoney(other)}`)
  if (express) parts.push(`快递费 ${fmtMoney(express)}`)
  if (brush) parts.push(`刷单成本 ${fmtMoney(brush)}`)
  return parts.join(' ＋ ')
}

const segs = [
  { key: 'sale', label: '销售商品' },
  { key: 'pack', label: '耗材/包装' },
  { key: 'labor', label: '人工' },
  { key: 'laborpack', label: '打包+耗材' },
]

function goBack() {
  if (window.history.length > 1) router.back()
  else router.replace('/outbound')
}

const total = computed(() => {
  const amount = rows.value.reduce((s, o) => s + num(o.total_amount), 0)
  const cogs = rows.value.reduce((s, o) => s + num(o.total_cogs), 0)
  const fee = rows.value.reduce((s, o) => s + num(o.total_fee), 0)
  // 芳谊放单仓刷单结算（刷单成本 + 固定费覆盖差）：净利里已扣掉，单独列出便于核对
  const brush = rows.value.reduce((s, o) => s + num(o.brush_adjust), 0)
  return { amount, cogs, fee, brush, net: amount - cogs - fee - brush }
})

/* ---------------- 聚合（与桌面端口径一致） ---------------- */
function packOwner(o, l, saleLines, ruleName) {
  if (l.sale_product_id != null) {
    const sp = saleLines.find((x) => x.product_id === l.sale_product_id)
    const sname = l.sale_product_name || (sp && sp.product_name) || l.product_name
    const sub = [ruleName ? `规则:${ruleName}` : '', (sp && sp.spec) || ''].filter(Boolean).join(' · ')
    const ruleKey = ruleName ? `@@${o.pack_rule_id || ruleName}` : ''
    return { key: `sp${l.sale_product_id}${ruleKey}`, name: sname, sub }
  }
  if (ruleName) {
    const name = saleLines.map((s) => s.product_name).filter(Boolean).join(' + ') || ruleName
    const detail = saleLines.map((s) => `${s.product_name}:${s.spec || ''}`).filter(Boolean).join('；')
    const sub = [`规则:${ruleName}`, detail].filter(Boolean).join(' · ')
    return { key: `rule${o.pack_rule_id || o.id}`, name, sub }
  }
  return { key: `p${l.product_id}`, name: l.product_name, sub: '' }
}

function outAggBy(list, pool) {
  const isPackPool = pool === 'pack'
  const map = new Map()
  const aggKey = (l) => `${l.product_id}@@${l.unit}`
  for (const o of list) {
    const saleLines = (o.lines || []).filter((l) => l.line_type === 'sale')
    const ruleName = o.pack_rule_name || o.multi_rule || ''
    for (const l of o.lines || []) {
      const isLabor = !!l.is_labor
      if (pool === 'sale' && l.line_type !== 'sale') continue
      if (pool === 'pack' && (l.line_type !== 'pack' || isLabor)) continue
      if (pool === 'labor' && !(l.line_type === 'pack' && isLabor)) continue
      if (pool === 'laborpack' && l.line_type !== 'pack') continue

      let k, name, sub, unit
      if (pool === 'sale' || isPackPool) {
        k = aggKey(l); name = l.product_name; sub = ''; unit = l.unit
      } else {
        const own = packOwner(o, l, saleLines, ruleName)
        k = own.key; name = own.name; sub = own.sub; unit = l.unit
      }
      if (!map.has(k)) {
        map.set(k, { pid: l.product_id, name, sub, unit, orders: new Set(), qty: 0, amount: 0, cogs: 0, gross_sales: 0, boxes: new Set(), hasBox: false, specs: new Set(), dropship_qty: 0, is_dropship: false })
      }
      const a = map.get(k)
      a.orders.add(o.id)
      a.qty += num(l.quantity)
      a.amount += num(l.amount)
      a.cogs += num(l.cogs)
      a.gross_sales += num(l.gross_sales) || num(l.amount)
      if (pool === 'sale') {
        if (l.spec) a.specs.add(l.spec)
        if (l.is_dropship) {
          a.is_dropship = true
          a.dropship_qty += num(l.quantity)   // 代发：不扣库存，只记代发数量
        }
      }
      if (!a.sub && sub) a.sub = sub
      if (pool === 'laborpack' && l.line_type === 'pack' && !isLabor) {
        a.hasBox = true
        a.boxes.add(l.product_name)
      }
    }
  }
  return [...map.values()].map((a) => {
    const boxes = [...a.boxes]
    let subSub = ''
    if (a.hasBox && boxes.length) {
      const bx = boxes.join(' + ')
      subSub = a.sub ? `${a.sub} · 纸箱:${bx}` : `纸箱:${bx}`
    }
    return { ...a, boxes, specs: [...(a.specs || [])], order_count: a.orders.size, subSub }
  })
}

const aggSale = computed(() => {
  const data = outAggBy(rows.value, 'sale')
  // 销售商品成本需含其关联的打包人工+耗材+快递费，否则毛利虚高
  const byPid = new Map()
  data.forEach((a) => {
    a.labor_cogs = 0
    a.material_cogs = 0
    a.other_cogs = 0
    a.express_cogs = 0
    a.brush_cogs = 0   // 芳谊放单仓刷单结算（刷单成本 + 固定费覆盖差）
    if (!byPid.has(a.pid)) byPid.set(a.pid, [])
    byPid.get(a.pid).push(a)
  })
  // 关联结算行归类：快递 / 人工 / 耗材 / 其他（与后端 report.py 的 PACK_FIELD_OF_CAT 对齐）
  const packField = (l) => {
    if (l.category === '快递') return 'express_cogs'
    if (l.is_labor) return 'labor_cogs'
    if (['包材', '耗材', '包装'].includes(l.category)) return 'material_cogs'
    return 'other_cogs'
  }
  const spread = (pid, amt, field) => {
    const arr = byPid.get(pid) || []
    if (!arr.length) return
    const each = amt / arr.length
    arr.forEach((a) => { a[field] += each })
  }
  for (const o of rows.value) {
    const saleLines = (o.lines || []).filter((l) => l.line_type === 'sale')
    const totalAmt = saleLines.reduce((s, l) => s + num(l.amount), 0)
    const unowned = []
    for (const l of o.lines || []) {
      if (l.line_type !== 'pack') continue
      if (l.sale_product_id == null) { unowned.push(l); continue }
      spread(l.sale_product_id, num(l.cogs), packField(l))
    }
    if (unowned.length && saleLines.length) {
      for (const l of unowned) {
        for (const sl of saleLines) {
          const share = totalAmt ? num(sl.amount) / totalAmt : 1 / saleLines.length
          spread(sl.product_id, num(l.cogs) * share, packField(l))
        }
      }
    }
    // 芳谊放单仓刷单结算：整单金额按该单销售金额占比分摊到商品（与后端 report.py 同口径）
    if (num(o.brush_adjust) && saleLines.length) {
      for (const sl of saleLines) {
        const share = totalAmt ? num(sl.amount) / totalAmt : 1 / saleLines.length
        spread(sl.product_id, num(o.brush_adjust) * share, 'brush_cogs')
      }
    }
  }
  return data.map((a) => {
    const base_cogs = a.cogs
    a.pack_cogs = a.labor_cogs + a.material_cogs + a.other_cogs   // 兼容旧字段：人工+耗材
    const cogs = base_cogs + a.pack_cogs + a.express_cogs + a.brush_cogs
    const denom = a.gross_sales || a.amount || 0
    const gp = a.amount - cogs
    return { ...a, base_cogs, cogs, gpRate: denom ? (gp / denom) * 100 : 0 }
  })
})
const aggPack = computed(() => outAggBy(rows.value, 'pack'))
const aggLabor = computed(() => outAggBy(rows.value, 'labor'))
const aggLaborPack = computed(() => outAggBy(rows.value, 'laborpack'))

const current = computed(() => {
  const src = seg.value === 'sale' ? aggSale.value
    : seg.value === 'pack' ? aggPack.value
      : seg.value === 'labor' ? aggLabor.value : aggLaborPack.value
  const s = (kw.value || '').trim().toLowerCase()
  if (!s) return src
  const isSale = seg.value === 'sale'
  // 销售商品可额外按出库方式筛：输入「代发」/「库存」即可筛出对应商品
  return src.filter((a) => `${a.name || ''} ${a.sub || ''} ${isSale ? (a.is_dropship ? '代发 外发' : '库存出库') : ''}`
    .toLowerCase().includes(s))
})

async function load() {
  loading.value = true
  try {
    const key = decodeURIComponent(route.params.key || '')
    const all = await api(`/api/outbounds?g=${encodeURIComponent(key)}`)
    rows.value = all.filter((r) => r.import_group === key)
    if (!rows.value.length) showToast('未找到该批次')
  } catch (e) { showToast('加载批次失败：' + e.message) }
  loading.value = false
}

async function deleteBatch() {
  try {
    await showConfirmDialog({ title: '删除本批', message: `确认删除本批共 ${rows.value.length} 单？库存与成本会自动回退。` })
  } catch (e) { return }
  deleting.value = true
  try {
    await api('/api/outbounds/batch-delete', 'POST', { ids: rows.value.map((r) => r.id) })
    showToast('已删除')
    router.replace('/outbound')
  } catch (e) { showToast('删除失败：' + e.message) }
  deleting.value = false
}

onMounted(load)
</script>

<style scoped>
.og-page { min-height: 100vh; background: #f7f8fa; }
.faint { color: #a6a8ab; }
</style>
