<template>
  <van-popup
    :show="show"
    position="bottom"
    round
    :style="{ height: typeTabs ? '88%' : '82%' }"
    @update:show="(v) => emit('update:show', v)"
  >
    <div class="pk-head">
      <span class="pk-title">{{ title }}</span>
      <van-icon name="cross" size="18" @click="emit('update:show', false)" />
    </div>

    <van-search v-model="kw" placeholder="搜索商品名称 / 分类" />

    <van-tabs v-if="typeTabs" v-model:active="ptype" shrink>
      <van-tab title="全部" name="" />
      <van-tab title="订单" name="order" />
      <van-tab title="库存" name="stock" />
    </van-tabs>

    <div class="pk-cats">
      <van-tag
        v-for="c in cats"
        :key="c"
        :type="pcat === c ? 'primary' : 'default'"
        round
        @click="pcat = pcat === c ? '' : c"
      >{{ c }}</van-tag>
      <van-tag v-if="pcat" plain type="danger" round @click="pcat = ''">清除筛选</van-tag>
    </div>

    <div class="pk-list">
      <div v-for="p in filtered" :key="p.id" class="pk-item" @click="onPick(p)">
        <div class="grow pk-info">
          <div class="pk-name">
            <span class="pk-badge" :class="p.product_type === 'order' ? 'is-order' : 'is-stock'">
              {{ p.product_type === 'order' ? '订单' : '库存' }}
            </span>
            {{ p.name }}
          </div>
          <div class="muted">
            {{ p.category || '—' }} · 单位 {{ p.default_unit || p.base_unit || '—' }}
            <template v-if="noteStock"> · 库存 {{ stockText(p) }}</template>
            <template v-if="p.stock_product_name"> · 扣库存：{{ p.stock_product_name }}×{{ p.multiplier }}</template>
          </div>
        </div>
        <van-icon name="chevron-right" color="#c8c9cc" />
      </div>
      <van-empty v-if="!filtered.length" description="无匹配商品" />
    </div>
  </van-popup>
</template>

<script setup>
import { ref, computed } from 'vue'
import { fmtNum, defaultUnit, unitFactor, shrink } from '../utils/format'

const props = defineProps({
  show: { type: Boolean, default: false },
  title: { type: String, default: '选择商品' },
  products: { type: Array, default: () => [] },
  typeTabs: { type: Boolean, default: true },
  noteStock: { type: Boolean, default: true },
})
const emit = defineEmits(['update:show', 'pick'])

const kw = ref('')
const ptype = ref('')
const pcat = ref('')

const cats = computed(() => shrink(props.products.map((p) => p.category)))
const filtered = computed(() => {
  const s = (kw.value || '').trim().toLowerCase()
  return props.products.filter((p) =>
    (!s || (p.name || '').toLowerCase().includes(s) || (p.category || '').toLowerCase().includes(s)) &&
    (!ptype.value || p.product_type === ptype.value) &&
    (!pcat.value || p.category === pcat.value)
  )
})

function stockText(p) {
  const du = defaultUnit(p)
  return `${fmtNum((+p.stock || 0) / unitFactor(p, du))} ${du}`
}

function onPick(p) {
  emit('pick', p)
  emit('update:show', false)
}
</script>

<style scoped>
.pk-head { display: flex; align-items: center; justify-content: space-between; padding: 14px 16px 4px; }
.pk-title { font-weight: 600; font-size: 16px; }
.pk-cats { display: flex; flex-wrap: wrap; gap: 8px; padding: 10px 16px; max-height: 76px; overflow-y: auto; }
.pk-cats .van-tag { cursor: pointer; }
.pk-list { height: calc(100% - 160px); overflow-y: auto; padding: 0 4px 24px; }
.pk-item { display: flex; align-items: center; gap: 10px; padding: 12px 16px; border-bottom: 1px solid #f5f5f5; }
.pk-item:active { background: #f5f6f7; }
.pk-info { min-width: 0; }
.pk-name { font-weight: 600; font-size: 14px; margin-bottom: 2px; word-break: break-all; }
.pk-badge { display: inline-block; font-size: 10px; font-weight: 500; padding: 1px 5px; border-radius: 4px; vertical-align: 1px; }
.pk-badge.is-stock { background: #e8f3ff; color: #1989fa; }
.pk-badge.is-order { background: #fff3e8; color: #ff8f1f; }
</style>
