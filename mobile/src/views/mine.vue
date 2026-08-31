<template>
  <div>
    <div class="card">
      <div class="row">
        <van-icon name="manager" size="40" color="#1989fa" />
        <div>
          <div style="font-weight:700;font-size:17px;">{{ user.name || user.username }}</div>
          <div class="muted">{{ user.role === 'admin' ? '管理员' : '业务员' }} · 企业台账系统</div>
        </div>
      </div>
    </div>

    <van-cell-group inset title="快捷入口">
      <van-cell title="📷 拍单识别" is-link to="/home" />
      <van-cell title="备份与恢复" is-link to="/home" :label="'桌面端「备份与恢复」页可管理，自动备份每 ' + bkHours + ' 小时一次'" />
    </van-cell-group>

    <div style="margin: 24px 18px;">
      <van-button round block type="danger" @click="logout">退出登录</van-button>
    </div>

    <p class="muted" style="text-align:center;">企业台账 · 移动端 PWA · v0.1</p>
  </div>
</template>

<script setup>
import { ref, onMounted } from 'vue'
import { showConfirmDialog } from 'vant'
import { useRouter } from 'vue-router'
import api from '../api'

const router = useRouter()
const user = ref({})
const bkHours = ref(2)

onMounted(async () => {
  try {
    const me = await api('/api/auth/me')
    user.value = me
  } catch (e) {}
  try {
    const b = await api('/api/backups')
    bkHours.value = b.config.interval_hours || 2
  } catch (e) {}
})

async function logout() {
  try {
    await showConfirmDialog({ title: '退出登录', message: '确认退出当前账号？' })
  } catch (e) { return }
  try { await api('/api/auth/logout', 'POST') } catch (e) {}
  localStorage.removeItem('erp_authed')
  router.replace('/login')
}
</script>
