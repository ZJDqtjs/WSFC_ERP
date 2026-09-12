<template>
  <div class="sub-page">
    <van-nav-bar title="鲜货现采" left-arrow fixed placeholder @click-left="goBack" />

    <div style="padding:12px;">
      <div class="card">
        <div class="card-title">
          <span class="grow">今日鲜货概览</span>
          <van-button size="mini" plain type="primary" icon="setting-o" @click="openConfig">管理清单</van-button>
        </div>
        <div class="muted" style="margin-bottom:8px;">
          展示鲜货（蔬菜 / 干货）库存与均价；导入今日订单可预演算消耗需求（仅采购参考，不实际扣库存）。
        </div>
        <div class="row" style="gap:8px;">
          <van-button size="small" plain type="primary" icon="down" @click="planFile && planFile.click()">导入今日订单</van-button>
          <input ref="planFile" type="file" accept=".xlsx" style="display:none" @change="doPlan" />
          <van-button size="small" plain icon="replay" @click="load">刷新</van-button>
        </div>
      </div>

      <!-- 预演算结果 -->
      <div v-if="planItems.length" class="card">
        <div class="card-title">
          <span class="grow">今日订单需求预演算</span>
          <van-button size="mini" plain @click="planItems = []">清空</van-button>
        </div>
        <div class="row" style="gap:10px;flex-wrap:wrap;margin-bottom:8px;">
          <span class="muted">解析订单 {{ planCount }} 单</span>
          <span class="muted">跳过 {{ planSkip }} 单</span>
          <span v-if="planFailed" class="muted">失败 {{ planFailed }} 条</span>
        </div>
        <div v-if="planUnmapped.length" class="alert warn">
          ⚠ 未关联编码：{{ planUnmapped.slice(0, 8).join('、') }}{{ planUnmapped.length > 8 ? ' 等' : '' }}
          <div class="muted" style="margin-top:4px;">到「设置 → 聚水潭关联」关联后重新导入。</div>
        </div>
        <div v-for="p in planItems" :key="p.id" class="list-item">
          <div class="row">
            <span class="grow item-title">{{ p.name }}</span>
            <span v-if="p.suggest > 0" class="suggest">建议采购 {{ fmtNum(p.suggest) }} {{ p.unit }}</span>
            <span v-else class="ok">库存充足</span>
          </div>
          <div class="item-meta">
            库存 {{ fmtNum(p.stock) }} · 需求 {{ fmtNum(p.need) }} · 剩余
            <b :class="p.remain < 0 ? 'up' : 'down'">{{ fmtNum(p.remain) }}</b> {{ p.unit }}
          </div>
        </div>
      </div>

      <!-- 鲜货库存 -->
      <div class="card">
        <div class="card-title">
          <span class="grow">鲜货库存（按展示清单顺序）</span>
          <span class="muted">{{ items.length }} 项</span>
        </div>
        <div v-if="!items.length" class="empty">暂无鲜货商品</div>
        <div v-for="(item, index) in items" :key="item.id" class="list-item">
          <div class="row">
            <span class="order-idx">{{ index + 1 }}</span>
            <span class="grow item-title">{{ item.name }}</span>
            <van-tag plain>{{ item.category }}</van-tag>
          </div>
          <div class="item-meta">
            库存 {{ fmtNum(item.stock) }} {{ item.unit }} · 均价 {{ fmtMoney(item.avg_cost) }}/{{ item.unit }}
            · 价值 {{ fmtMoney(item.stock_value) }}
          </div>
        </div>
      </div>
    </div>

    <!-- ============ 展示清单配置 ============ -->
    <van-popup v-model:show="cfgShow" position="bottom" round :style="{ height: '88%' }">
      <div class="sheet-body">
        <div class="sheet-title">管理展示清单</div>
        <div class="muted" style="margin-bottom:8px;">清单内商品按顺序展示在最前，清单外鲜货自动追加在末尾。未配置时按名称排序展示全部。</div>

        <div class="divider"></div>
        <div class="row" style="justify-content:space-between;">
          <span class="bold">已选（{{ sel.length }}）</span>
          <van-button size="mini" plain @click="sel = []">清空</van-button>
        </div>
        <div v-if="!sel.length" class="empty" style="padding:10px 0;">未配置，将展示全部鲜货</div>
        <div v-for="(s, i) in sel" :key="s.id" class="picker-item">
          <span class="order-idx">{{ i + 1 }}</span>
          <span class="grow">{{ s.name }}</span>
          <van-icon name="arrow-up" :color="i === 0 ? '#dcdee0' : '#1989fa'" @click="move(i, -1)" />
          <van-icon name="arrow-down" :color="i === sel.length - 1 ? '#dcdee0' : '#1989fa'" @click="move(i, 1)" />
          <van-icon name="cross" color="#ee0a24" @click="sel.splice(i, 1)" />
        </div>

        <div class="divider"></div>
        <div class="bold" style="margin-bottom:6px;">全部可选鲜货（{{ all.length }}）</div>
        <van-field v-model="cfgKw" placeholder="搜索商品" style="background:#f7f8fa;border-radius:6px;margin-bottom:8px;" />
        <div v-for="a in allFiltered" :key="a.id" class="picker-item" :class="{ on: isSel(a.id) }" @click="toggle(a)">
          <van-checkbox :model-value="isSel(a.id)" style="margin-right:4px;" />
          <span class="grow">{{ a.name }}</span>
          <span class="muted">{{ a.category }} · {{ a.unit }}</span>
        </div>

        <div class="sheet-foot">
          <van-button block plain @click="cfgShow = false">取消</van-button>
          <van-button block type="primary" :loading="cfgSaving" @click="saveConfig">保存清单</van-button>
        </div>
      </div>
    </van-popup>
  </div>
</template>

<script setup>
import { ref, computed, onMounted } from 'vue'
import { useRouter } from 'vue-router'
import { showToast } from 'vant'
import api, { upload } from '../api'
import { fmtMoney, fmtNum } from '../utils/format'

const router = useRouter()
function goBack() {
  if (window.history.length > 1) router.back()
  else router.replace('/mine')
}

const items = ref([])
const planItems = ref([])
const planCount = ref(0)
const planSkip = ref(0)
const planFailed = ref(0)
const planUnmapped = ref([])
const planFile = ref(null)

async function load() {
  try {
    const d = await api('/api/fresh')
    items.value = d.items || []
  } catch (e) { showToast(e.message || '加载失败') }
}

async function doPlan(e) {
  const f = e.target.files && e.target.files[0]
  e.target.value = ''
  if (!f) return
  try {
    const r = await upload('/api/fresh/plan', f)
    planItems.value = r.items || []
    planCount.value = r.order_count || 0
    planSkip.value = typeof r.skip === 'object' ? Object.values(r.skip || {}).reduce((s, v) => s + v, 0) : (r.skip || 0)
    planFailed.value = r.failed_count || 0
    planUnmapped.value = r.unmapped || []
    if (!planItems.value.length) showToast('未解析出需要采购的鲜货')
  } catch (err) { showToast('预演算失败：' + err.message) }
}

/* ---------- 展示清单 ---------- */
const cfgShow = ref(false)
const cfgSaving = ref(false)
const cfgKw = ref('')
const all = ref([])
const sel = ref([])

const allFiltered = computed(() => {
  const s = (cfgKw.value || '').trim().toLowerCase()
  return s ? all.value.filter((a) => (a.name || '').toLowerCase().includes(s) || (a.category || '').toLowerCase().includes(s)) : all.value
})
const isSel = (id) => sel.value.some((x) => x.id === id)

async function openConfig() {
  cfgShow.value = true
  try {
    const [opts, cur] = await Promise.all([api('/api/fresh/options'), api('/api/fresh')])
    all.value = opts.items || []
    const ids = cur.ids && cur.ids.length ? cur.ids : (cur.items || []).map((x) => x.id)
    const byId = new Map(all.value.map((a) => [a.id, a]))
    sel.value = ids.map((id) => byId.get(id)).filter(Boolean)
  } catch (e) { showToast(e.message || '加载清单失败') }
}

function toggle(a) {
  const i = sel.value.findIndex((x) => x.id === a.id)
  if (i >= 0) sel.value.splice(i, 1)
  else sel.value.push(a)
}
function move(i, d) {
  const j = i + d
  if (j < 0 || j >= sel.value.length) return
  const arr = sel.value
  const tmp = arr[i]
  arr.splice(i, 1)
  arr.splice(j, 0, tmp)
}

async function saveConfig() {
  cfgSaving.value = true
  try {
    await api('/api/fresh/config', 'POST', { ids: sel.value.map((s) => s.id) })
    showToast('已保存')
    cfgShow.value = false
    await load()
  } catch (e) { showToast(e.message || '保存失败') }
  cfgSaving.value = false
}

onMounted(load)
</script>

<style scoped>
.sub-page { min-height: 100vh; background: #f7f8fa; }
.order-idx {
  display: inline-flex; align-items: center; justify-content: center;
  min-width: 18px; height: 18px; border-radius: 50%; flex-shrink: 0;
  background: #e8f3ff; color: #1989fa; font-size: 11px; font-weight: 600; margin-right: 6px;
}
.suggest { color: #ee0a24; font-weight: 600; font-size: 12px; }
.ok { color: #07c160; font-size: 12px; }
.alert { border-radius: 8px; padding: 8px 10px; font-size: 12px; margin-bottom: 8px; }
.alert.warn { background: #fffbe8; color: #ed6a0c; }
</style>
