<template>
  <van-popup :show="show" position="bottom" round style="height:86%" @update:show="$emit('update:show', $event)">
    <div class="pk-head">
      <span class="pk-title">{{ title }}</span>
      <van-icon name="cross" size="18" @click="$emit('update:show', false)" />
    </div>
    <van-search v-model="kw" placeholder="搜索商品名称 / 分类" />
    <van-tabs v-if="showTypeTabs" v-model:active="type" shrink>
      <van-tab title="全部" name="" />
      <van-tab title="订单" name="order" />
      <van-tab title="库存" name="stock" />
    </van-tabs>
    <div class="pk-cats">
      <van-tag
        v-for="c in cats"
        :key="c"
        :type="cat === c ? 'primary' : 'default'"
        round
        @click="cat = cat === c ? '' : c"
      >{{ c }}</van-tag>
    </div>
    <div class="pk-list">
      <div v-for="p in filtered" :key="p.id" class="pk-item" @click="$emit('pick', p)">
        <div class="grow">
          <b>{{ typeLabel(p) }} {{ p.name }}</b>
          <div class="muted">{{ p.category || '—' }} · 单位 {{ p.default_unit || p.base_unit }} · 库存 {{ fmtStock(p) }}</div>
        </div>
        <van-icon name="chevron-right" color="#c8c9cc" />
      </div>
      <van-empty v-if="!filtered.length" description="无匹配商品" />
    </div>
  </van-popup>
</template>

<script setup>
import { ref, computed, watch } from 'vue'

const props = defineProps({
  show: Boolean,
  title: { type: String, default: '选择商品' },
  list: { type: Array, default: () => [] },
  showTypeTabs: { type: Boolean, default: false },
})
defineEmits(['update:show', 'pick'])

const kw = ref(''), type = ref(''), cat = ref('')
watch(() => props.show, (v) => { if (v) { kw.value = ''; cat.value = '' } })

const typeLabel = (p) => (p.product_type === 'order' ? '〔订单〕' : '〔库存〕')
const fmtStock = (p) => {
  if (p.stock_display) return p.stock_display
  const du = p.default_unit || p.base_unit || ''
  const f = (p.conversions || {})[du] || 1
  return `${f && f !== 1 ? +p.stock / f : +p.stock} ${f && f !== 1 ? du : p.base_unit}`
}
const cats = computed(() => [...new Set(props.list.map((p) => p.category).filter(Boolean))])
const filtered = computed(() => {
  const s = (kw.value || '').trim().toLowerCase()
  return props.list.filter((p) =>
    (!s || p.name.toLowerCase().includes(s) || (p.category || '').toLowerCase().includes(s)) &&
    (!type.value || p.product_type === type.value) &&
    (!cat.value || p.category === cat.value))
})
</script>

<style scoped>
.pk-head { display: flex; align-items: center; justify-content: space-between; padding: 14px 16px 4px; }
.pk-title { font-weight: 600; }
.pk-cats { display: flex; flex-wrap: wrap; gap: 8px; padding: 10px 16px; }
.pk-cats .van-tag { cursor: pointer; }
.pk-list { max-height: 56vh; overflow-y: auto; padding: 0 4px 16px; }
.pk-item { display: flex; align-items: center; gap: 10px; padding: 12px 16px; border-bottom: 1px solid #f5f5f5; }
.pk-item:active { background: #f5f6f7; }
.grow { flex: 1; min-width: 0; }
.muted { color: #969799; font-size: 12px; }
</style>
