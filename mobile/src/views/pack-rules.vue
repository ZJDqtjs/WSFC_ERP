<template>
  <div>
    <sub-header title="一单多货规则" />

    <div class="card">
      <div class="row">
        <van-search v-model="kw" placeholder="搜索组合 / 箱型" class="grow" />
        <van-button size="small" type="primary" @click="load">刷新</van-button>
      </div>
      <div class="muted" style="margin-top:6px;">共 {{ filtered.length }} 条规则（移动端只读，编辑请在桌面端）</div>
    </div>

    <div v-for="r in filtered" :key="r.id" class="card rule" :class="{ off: !r.is_active }">
      <div class="row">
        <span class="grow name">{{ r.name }}</span>
        <span class="badge" :class="r.is_active ? 'on' : 'muted-badge'">{{ r.is_active ? '启用' : '停用' }}</span>
      </div>
      <div class="items">
        <span v-for="(it, i) in r.items" :key="i" class="item">
          {{ it.name }}<span v-if="it.quantity > 1"> ×{{ it.quantity }}</span>
        </span>
      </div>
      <div class="meta">
        <span>纸箱：<b>{{ r.box_type || '—' }}</b></span>
        <span>工人单价：<b>{{ r.labor_price == null ? '—' : fmtMoney(r.labor_price) }}</b></span>
        <span>箱单比：<b>{{ r.box_ratio }}</b></span>
      </div>
      <div v-if="r.remark" class="muted">备注：{{ r.remark }}</div>
    </div>

    <van-empty v-if="!filtered.length" description="暂无一单多货规则" />
  </div>
</template>

<script setup>
import { ref, computed, onMounted } from 'vue'
import { showToast } from 'vant'
import api from '../api'
import SubHeader from '../components/sub-header.vue'

const rules = ref([]), kw = ref('')
const fmtMoney = (v) => '¥' + (+v || 0).toLocaleString('zh-CN', { minimumFractionDigits: 2 })

const filtered = computed(() => {
  const s = kw.value.trim().toLowerCase()
  return rules.value.filter((r) =>
    !s || r.name.toLowerCase().includes(s) || (r.box_type || '').toLowerCase().includes(s))
})

async function load() {
  try { rules.value = await api('/api/pack-rules') }
  catch (e) { showToast('加载失败：' + e.message) }
}
onMounted(load)
</script>

<style scoped>
.rule { margin-bottom: 10px; }
.rule.off { opacity: .6; }
.name { font-weight: 600; font-size: 13px; word-break: break-all; }
.badge { font-size: 11px; border-radius: 4px; padding: 2px 6px; white-space: nowrap; }
.badge.on { background: #e8fff0; color: #07c160; }
.badge.muted-badge { background: #f2f3f5; color: #969799; }
.items { display: flex; flex-wrap: wrap; gap: 6px; margin: 8px 0; }
.item { background: #f2f6ff; color: #1989fa; border-radius: 4px; padding: 2px 6px; font-size: 11px; }
.meta { display: flex; flex-wrap: wrap; gap: 10px; font-size: 12px; color: #646566; }
</style>
