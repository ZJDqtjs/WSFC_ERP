<template>
  <div class="login-wrap">
    <div class="login-box">
      <div class="logo">企业台账</div>
      <p class="sub">库存 · 财务 · 一体化</p>
      <van-field v-model="username" label="用户名" placeholder="请输入用户名" @keyup.enter="doLogin" />
      <div class="key-row">
        <van-field v-model="keyName" readonly label="私钥文件" placeholder="点击选择 Ed25519 私钥" @click="pickFile" />
        <van-button size="small" type="primary" plain @click="pickFile">选择</van-button>
      </div>
      <p class="key-hint">选择由私钥管理工具生成的私钥文件（.pem / id_ed25519）</p>
      <input ref="fileInput" type="file" accept=".pem,.key,.txt,text/plain" style="display:none" @change="onFileChange" />
      <div class="login-btn"><van-button round block type="primary" @click="doLogin">登 录</van-button></div>
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
const keyName = ref('')
const keyFile = ref(null)
const fileInput = ref(null)

function pickFile() {
  fileInput.value && fileInput.value.click()
}
function onFileChange(e) {
  const f = e.target.files && e.target.files[0]
  keyFile.value = f || null
  keyName.value = f ? f.name : ''
}
function readFile(file) {
  return new Promise((resolve, reject) => {
    const fr = new FileReader()
    fr.onload = () => resolve(fr.result)
    fr.onerror = () => reject(new Error('读取文件失败'))
    fr.readAsText(file)
  })
}
async function doLogin() {
  const uname = username.value.trim()
  if (!uname) { showToast('请输入用户名'); return; }
  if (!keyFile.value) { showToast('请选择私钥文件'); return; }
  let private_key
  try { private_key = await readFile(keyFile.value) }
  catch (e) { showToast('读取私钥失败：' + e.message); return; }
  try {
    await api('/api/auth/login', 'POST', { username: uname, private_key })
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
.key-row { display: flex; align-items: center; }
.key-row .van-field { flex: 1; }
.key-row .van-button { margin: 0 8px 0 4px; }
.key-hint { color: #969799; font-size: 11px; padding: 4px 18px 0; }
.login-btn { margin: 20px 18px 0; }
</style>
