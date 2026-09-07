<template>
  <div>
    <sub-header title="出入库记录" />

    <van-cell-group inset>
      <van-field v-model="from" label="开始日期" type="date" @change="load" />
      <van-field v-model="to" label="结束日期" type="date" @change="load" />
    </van-cell-group>

    <van-tabs v-model:active="tab" sticky @change="load">
      <van-tab title="出库记录">
        <van-pull-refresh v-model="refreshing" @refresh="load">
          <div class="list">
            <div v-for="o in outList" :key="o.id" class="card rec">
              <div class="row">
                <span class="grow bold">{{ o.code }}</span>
                <span v-if="o.is_multi" class="badge multi">一单多货</span>
                <b>{{ fmtMoney(o.total_amount) }}</b>
              </div>
              <div class="muted">{{ o.date }} · {{ o.customer || '—' }} · {{ o.operator || '—' }}</div>
              <div class="muted">
                毛利 <span class="green">{{ fmtMoney(o.gross_profit) }}</span> ·
                净利 <span class="green">{{ fmtMoney(o.net_profit) }}</span> ·
                费用 {{ fmtMoney(o.total_fee) }}
              </div>
              <div v-if="o.multi_rule" class="muted">规则：{{ o.multi_rule }}</div>

              <div class="lines">
                <div v-for="(l, i) in o.lines" :key="i" class="line" :class="l.line_type">
                  <span class="grow">
                    <span v-if="l.line_type === 'pack'" class="badge pack">{{ l.is_labor ? '人工' : '包材' }}</span>
                    {{ l.product_name }}
                    <span v-if="l.sale_product_name && l.line_type === 'pack'" class="muted">← {{ l.sale_product_name }}</span>
                  </span>
                  <span class="muted">{{ l.quantity }} {{ l.unit }}</span>
                  <span class="num">{{ fmtMoney(l.amount) }}</span>
                </div>
              </div>

              <div class="acts">
                <van-button size="mini" type="danger" plain @click="delOut(o)">删除</van-button>
              </div>
            </div>
            <van-empty v-if="!outList.length" description="暂无出库记录" />
          </div>
        </van-pull-refresh>
      </van-tab>

      <van-tab title="入库记录">
        <van-pull-refresh v-model="refreshing" @refresh="load">
          <div class="list">
            <div v-for="r in inList" :key="r.id" class="card rec">
              <div class="row">
                <span class="grow bold">{{ r.product_name }}</span>
                <b>{{ fmtMoney(r.total_amount) }}</b>
              </div>
              <div class="muted">{{ r.date }} · {{ r.quantity }} {{ r.unit }} @ {{ fmtMoney(r.unit_price) }} · {{ r.supplier || '—' }}</div>
              <div v-if="r.remark" class="muted">备注：{{ r.remark }}</div>
              <div class="acts">
                <van-button size="mini" type="danger" plain @click="delIn(r)">删除</van-button>
              </div>
            </div>
            <van-empty v-if="!inList.length" description="暂无入库记录" />
          </div>
        </van-pull-refresh>
      </van-tab>
    </van-tabs>
  </div>
</template>

<script setup>
import { ref, onMounted } from 'vue'
import { showToast, showConfirmDialog } from 'vant'
import api from '../api'
import SubHeader from '../components/sub-header.vue'

const today = new Date().toISOString().slice(0, 10)
const monthStart = today.slice(0, 8) + '01'
const tab = ref(0), refreshing = ref(false)
const from = ref(monthStart), to = ref(today)
const outList = ref([]), inList = ref([])

const fmtMoney = (v) => '¥' + (+v || 0).toLocaleString('zh-CN', { minimumFractionDigits: 2 })

async function load() {
  const q = `?date_from=${from.value || ''}&date_to=${to.value || ''}`
  try {
    if (tab.value === 0) outList.value = await api('/api/outbounds' + q)
    else inList.value = await api('/api/inbounds' + q)
  } catch (e) { showToast('加载失败：' + e.message) } finally { refreshing.value = false }
}
onMounted(load)

async function delOut(o) {
  try { await showConfirmDialog({ title: '删除出库单', message: `确认删除 ${o.code}？库存与成本会一并回滚。` }) } catch (e) { return }
  try { await api(`/api/outbounds/${o.id}`, 'DELETE'); showToast('已删除'); load() }
  catch (e) { showToast('删除失败：' + e.message) }
}
async function delIn(r) {
  try { await showConfirmDialog({ title: '删除入库单', message: `确认删除「${r.product_name}」入库？库存与成本会一并回滚。` }) } catch (e) { return }
  try { await api(`/api/inbounds/${r.id}`, 'DELETE'); showToast('已删除'); load() }
  catch (e) { showToast('删除失败：' + e.message) }
}
</script>

<style scoped>
.list { padding: 4px 0 12px; }
.rec { margin-bottom: 10px; }
.bold { font-weight: 600; }
.green { color: #07c160; }
.badge { font-size: 11px; border-radius: 4px; padding: 1px 5px; margin-right: 4px; }
.badge.multi { background: #e8f3ff; color: #1989fa; }
.badge.pack { background: #f2f3f5; color: #646566; }
.lines { margin-top: 8px; border-top: 1px dashed #ebedf0; padding-top: 6px; }
.line { display: flex; gap: 6px; font-size: 12px; padding: 3px 0; }
.line.pack { color: #969799; }
.line .num { flex: 0 0 66px; text-align: right; }
.acts { margin-top: 8px; display: flex; justify-content: flex-end; }
</style>