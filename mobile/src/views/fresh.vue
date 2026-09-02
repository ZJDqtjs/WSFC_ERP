<template>
  <div>
    <div class="card">
      <div class="card-title">鲜货现采</div>
      <div class="toolbar">
        <span class="muted">今日鲜货预采概览</span>
        <van-button size="small" plain type="primary" @click="loadFresh">刷新</van-button>
      </div>

      <div v-if="!items.length" class="empty">暂无鲜货商品</div>
      <div v-else class="fresh-list">
        <div
          v-for="(item, index) in items"
          :key="item.id"
          class="fresh-item"
          draggable="true"
          @dragstart="dragStart(item.id)"
          @dragover.prevent
          @drop="dropItem(index)"
        >
          <div class="row">
            <span class="drag-handle">⋮⋮</span>
            <span class="grow title">{{ item.name }}</span>
            <span class="chip">{{ item.category }}</span>
          </div>
          <div class="meta-row">
            <span>库存 {{ fmtNum(item.stock) }} {{ item.unit }}</span>
            <span>均价 {{ fmtMoney(item.avg_cost) }}/{{ item.unit }}</span>
          </div>
          <div class="meta-row">
            <span class="muted">展示顺序 {{ index + 1 }}</span>
          </div>
        </div>
      </div>
    </div>
  </div>
</template>

<script setup>
import { ref, onMounted } from 'vue'
import { showToast } from 'vant'
import api from '../api'

const items = ref([])
const refreshing = ref(false)
const dragId = ref(null)

const fmtNum = (v) => Number(v || 0).toFixed(2).replace(/\.00$/, '')
const fmtMoney = (v) => `¥${(+v || 0).toLocaleString('zh-CN', { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`

async function loadFresh() {
  try {
    refreshing.value = true
    const d = await api('/api/fresh')
    items.value = d.items || []
  } catch (e) {
    showToast(e.message || '加载失败')
  } finally {
    refreshing.value = false
  }
}

function dragStart(id) {
  dragId.value = id
}

async function dropItem(targetIndex) {
  if (dragId.value == null) return
  const fromIndex = items.value.findIndex((p) => p.id === dragId.value)
  if (fromIndex < 0 || fromIndex === targetIndex) {
    dragId.value = null
    return
  }

  const next = [...items.value]
  const [moved] = next.splice(fromIndex, 1)
  next.splice(targetIndex, 0, moved)
  items.value = next

  const ids = next.map((p) => p.id)
  dragId.value = null

  try {
    await api('/api/fresh/config', 'POST', { ids })
  } catch (e) {
    showToast('保存顺序失败：' + (e.message || '未知错误'))
  }
}

onMounted(loadFresh)
</script>

<style scoped>
.toolbar { display: flex; align-items: center; justify-content: space-between; gap: 8px; margin-bottom: 12px; }
.empty { color: #969799; text-align: center; padding: 18px 0; }
.fresh-list { display: flex; flex-direction: column; gap: 10px; }
.fresh-item {
  background: #f8f9fb; border: 1px solid #e5e7eb; border-radius: 10px; padding: 12px;
  user-select: none;
}
.fresh-item:active { opacity: 0.9; }
.row { display: flex; align-items: center; gap: 8px; }
.grow { flex: 1; }
.title { font-weight: 600; }
.drag-handle { color: #999; font-size: 18px; line-height: 1; letter-spacing: 1px; }
.chip { background: #ecf7ff; color: #1989fa; border-radius: 999px; padding: 3px 8px; font-size: 11px; }
.meta-row {
  margin-top: 8px; display: flex; justify-content: space-between; gap: 8px; color: #646566; font-size: 12px;
}
</style>
