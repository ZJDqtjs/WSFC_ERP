<template>
  <div class="sub-page">
    <van-nav-bar title="快递费规则" left-arrow fixed safe-area-inset-top placeholder @click-left="goBack" />
    <div class="sub-body">
      <div class="card">
        <div class="card-title">计费规则</div>
        <div class="card-desc">
          出库时按「整单毛重」自动计算快递费并计入销售成本。整单毛重 = 商品净重之和 + 每单箱体 0.1kg；
          商品净重由「扣减库存量」推导（重量类），推不出时使用商品资料里手填的单件净重。
        </div>

        <van-cell-group inset>
          <van-field label="计费方式">
            <template #input>
              <van-radio-group v-model="cfg.mode" direction="vertical">
                <van-radio name="tiered">首重 + 续重（1kg 内一个价，每超 1kg 加收）</van-radio>
                <van-radio name="flat">每 kg 单价</van-radio>
              </van-radio-group>
            </template>
          </van-field>

          <template v-if="cfg.mode === 'tiered'">
            <van-field v-model="cfg.first_kg_fee" type="number" label="1kg 以内" placeholder="首重，如 3.6" required>
              <template #button><span class="muted">元</span></template>
            </van-field>
            <van-field v-model="cfg.per_extra_kg" type="number" label="每超 1kg" placeholder="续重，如 1" required>
              <template #button><span class="muted">元</span></template>
            </van-field>
            <van-field label="续重按整 kg 向上取整">
              <template #input><van-switch v-model="cfg.round_up" size="20" /></template>
            </van-field>
            <div class="card-desc" style="padding:0 16px 8px;margin-bottom:0;">如 1.5kg 按 2kg 计费（仅对超出部分取整）。</div>
          </template>

          <van-field v-else v-model="cfg.rate_per_kg" type="number" label="每 1kg 单价" placeholder="如 3.6" required>
            <template #button><span class="muted">元</span></template>
          </van-field>
        </van-cell-group>

        <div class="row" style="gap:10px;margin-top:12px;">
          <van-button class="grow" type="primary" :loading="saving" @click="save">保存计费规则</van-button>
          <van-button class="grow" plain :disabled="saving" @click="load">撤销修改</van-button>
        </div>
        <div class="card-desc" style="margin:8px 0 0;">{{ info }}</div>
      </div>

      <div class="card">
        <div class="card-title">计费预览（毛重 = 净重 + 0.1kg 箱重）</div>
        <div v-for="w in weights" :key="w" class="list-item">
          <div class="row">
            <span class="grow">毛重 {{ w }} kg</span>
            <span class="num-r">{{ fmtMoney(fee(w)) }}</span>
          </div>
        </div>
      </div>
    </div>
  </div>
</template>

<script setup>
import { ref, reactive, onMounted } from 'vue'
import { useRouter } from 'vue-router'
import { showToast } from 'vant'
import api from '../api'
import { fmtMoney, num } from '../utils/format'

const router = useRouter()
function goBack() {
  if (window.history.length > 1) router.back()
  else router.replace('/mine')
}

const weights = [1, 2, 3, 5, 10]
const cfg = reactive({ mode: 'tiered', first_kg_fee: 3.6, per_extra_kg: 1, rate_per_kg: 3.6, round_up: true })
const saving = ref(false)
const info = ref('')

/** 与后端 compute_express_fee 口径一致 */
function fee(w) {
  if (cfg.mode === 'flat') return Math.round(num(w) * num(cfg.rate_per_kg) * 100) / 100
  let over = Math.max(0, num(w) - 1)
  if (cfg.round_up && over > 0) over = Math.ceil(over)
  return Math.round((num(cfg.first_kg_fee) + over * num(cfg.per_extra_kg)) * 100) / 100
}

async function load() {
  try {
    const r = await api('/api/express/rule')
    cfg.mode = r.mode === 'flat' ? 'flat' : 'tiered'
    cfg.first_kg_fee = r.first_kg_fee
    cfg.per_extra_kg = r.per_extra_kg
    cfg.rate_per_kg = r.rate_per_kg
    cfg.round_up = !!r.round_up
    info.value = '已加载当前计费规则'
  } catch (e) { showToast('加载规则失败：' + e.message) }
}

async function save() {
  const bad = cfg.mode === 'tiered'
    ? [num(cfg.first_kg_fee), num(cfg.per_extra_kg)]
    : [num(cfg.rate_per_kg)]
  if (bad.some((v) => !Number.isFinite(v) || v < 0)) { showToast('请填写正确的费用（≥ 0）'); return }
  saving.value = true
  try {
    await api('/api/express/rule', 'PUT', {
      mode: cfg.mode,
      first_kg_fee: num(cfg.first_kg_fee),
      per_extra_kg: num(cfg.per_extra_kg),
      rate_per_kg: num(cfg.rate_per_kg),
      round_up: !!cfg.round_up,
    })
    info.value = '已保存，实时生效'
    showToast('快递费规则已保存')
  } catch (e) { showToast('保存失败：' + e.message) }
  saving.value = false
}

onMounted(load)
</script>

<style scoped>
/* .sub-page / .sub-body 已提升为 app.vue 全局样式 */
</style>
