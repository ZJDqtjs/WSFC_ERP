<template>
  <div class="login-wrap">
    <div class="login-box">
      <div class="logo">企业台账</div>
      <p class="sub">库存 · 财务 · 一体化</p>
      <van-form @submit="doLogin">
        <van-cell-group inset>
          <van-field v-model="username" name="username" label="用户名" placeholder="请输入用户名" />
          <van-field v-model="password" type="password" name="password" label="密码" placeholder="请输入密码" />
        </van-cell-group>
        <div class="login-btn"><van-button round block type="primary" native-type="submit">登 录</van-button></div>
      </van-form>
    </div>
  </div>
</template>

<script setup>
import { ref } from 'vue'
import { showToast } from 'vant'
import { useRouter } from 'vue-router'
import api from '../api'

const router = useRouter()
const username = ref('')
const password = ref('')

async function doLogin() {
  try {
    await api('/api/auth/login', 'POST', { username: username.value, password: password.value })
    localStorage.setItem('erp_authed', '1')
    showToast('登录成功')
    router.replace('/home')
  } catch (e) { showToast('登录失败：' + e.message) }
}
</script>

<style scoped>
.login-wrap { min-height: 100vh; background: #1989fa; display: flex; align-items: center; justify-content: center; }
.login-box { width: 84%; background: #fff; border-radius: 14px; padding: 28px 8px; }
.logo { text-align: center; font-size: 22px; font-weight: 700; color: #1989fa; }
.sub { text-align: center; color: #969799; font-size: 12px; margin: 4px 0 20px; }
.login-btn { margin: 20px 18px 0; }
</style>
