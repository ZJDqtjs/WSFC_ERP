<template>
  <div>
    <div class="card">
      <div class="row">
        <van-icon name="manager" size="40" color="#1989fa" />
        <div class="grow">
          <div style="font-weight:700;font-size:17px;">{{ user.name || user.username || '—' }}</div>
          <div class="muted">{{ roleText }} · 企业台账系统</div>
        </div>
        <van-tag v-if="user.warehouse" type="primary" plain>{{ user.warehouse.name }}</van-tag>
      </div>
    </div>

    <van-cell-group inset title="业务管理">
      <van-cell title="商品管理" icon="goods-collect-o" is-link to="/products" />
      <van-cell title="一单多货（多货打包规则）" icon="logistics" is-link to="/packrules" />
      <van-cell title="鲜货现采" icon="bag-o" is-link to="/fresh" />
    </van-cell-group>

    <van-cell-group inset title="经营分析">
      <van-cell title="财务报表" icon="bar-chart-o" is-link to="/report" />
      <van-cell title="其他开支" icon="balance-list-o" is-link to="/otherexp" />
      <van-cell :title="`库存管理（缺货 ${lowStockCount} 项）`" icon="shopping-cart-o" is-link to="/stock" />
    </van-cell-group>

    <van-cell-group inset title="规则设置">
      <van-cell title="扣点设置" icon="gold-coin-o" is-link to="/deduction" />
      <van-cell title="快递费规则" icon="send-gift-o" is-link to="/express" />
    </van-cell-group>

    <van-cell-group inset title="数据与系统">
      <van-cell title="设置（分仓 / 备份 / 批量导入 / 聚水潭）" icon="setting-o" is-link to="/settings" />
      <van-cell title="切换分仓" icon="cluster-o" is-link @click="$router.push({ path: '/settings', query: { panel: 'wh' } })" />
    </van-cell-group>

    <div style="margin: 20px 16px;">
      <van-button round block type="danger" plain @click="logout">退出登录</van-button>
    </div>

    <p class="muted" style="text-align:center;padding-bottom:12px;">
      企业台账 · 移动端 PWA · v{{ version }}
    </p>
  </div>
</template>

<script setup>
import { ref, computed, onMounted } from 'vue'
import { showConfirmDialog, showToast } from 'vant'
import { useRouter } from 'vue-router'
import api from '../api'

const router = useRouter()
const user = ref({})
const lowStockCount = ref(0)
const version = '0.2.0'

const roleText = computed(() => (user.value.role === 'admin' ? '管理员' : '业务员'))

onMounted(async () => {
  try { user.value = await api('/api/auth/me') } catch (e) {}
  try {
    const d = await api('/api/dashboard')
    lowStockCount.value = (d.low_stock || []).length
  } catch (e) {}
})

async function logout() {
  try {
    await showConfirmDialog({ title: '退出登录', message: '确认退出当前账号？' })
  } catch (e) { return }
  try { await api('/api/auth/logout', 'POST') } catch (e) {}
  localStorage.removeItem('erp_authed')
  showToast('已退出')
  router.replace('/login')
}
</script>
