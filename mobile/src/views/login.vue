<template>
  <div class="login-wrap">
    <div class="login-box">
      <div class="logo">企业台账</div>
      <p class="sub">库存 · 财务 · 一体化</p>

      <van-field
        v-model="username"
        label="用户名"
        placeholder="请输入用户名"
        autocomplete="username"
        @keyup.enter="doLogin"
      />

      <div class="key-row">
        <van-field
          v-model="keyName"
          readonly
          label="私钥文件"
          placeholder="点击选择 Ed25519 私钥"
          @click="pickFile"
        />
        <van-button size="small" type="primary" plain @click="pickFile">选择</van-button>
      </div>
      <input ref="fileInput" type="file" accept=".pem,.key,.txt,text/plain" style="display:none" @change="onFileChange" />

      <p class="key-hint">
        用户名必须与私钥文件一一对应（由管理员用私钥管理工具分发，文件名里的名字通常就是用户名）。
      </p>

      <!-- 失败原因常驻展示：用 toast 会一闪而过，用户看不到到底错在哪 -->
      <div v-if="errMsg" class="login-err">{{ errMsg }}</div>

      <div class="login-btn">
        <van-button round block type="primary" :loading="busy" @click="doLogin">登 录</van-button>
      </div>

      <p class="key-foot">请使用管理员分发的私钥文件登录</p>
    </div>
  </div>
</template>

<script setup>
import { ref, onMounted } from 'vue'
import { showToast } from 'vant'
import { useRouter } from 'vue-router'
import { login } from '../api'

const router = useRouter()
const username = ref('')
const keyName = ref('')
const keyFile = ref(null)
const fileInput = ref(null)
const errMsg = ref('')
const busy = ref(false)

// 记住上次登录的用户名，省得每次重敲
const LAST_USER_KEY = 'erp_last_user'

onMounted(() => {
  const last = localStorage.getItem(LAST_USER_KEY)
  if (last) username.value = last
  // 从"登录失效被踢回来"进入时，给个明确提示（切仓已不再导致掉线，故只可能是会话过期/账号被停用）
  if (sessionStorage.getItem('erp_kicked')) {
    sessionStorage.removeItem('erp_kicked')
    errMsg.value = '登录状态已失效（会话已过期或账号被停用），请重新登录。'
  }
})

function pickFile() {
  fileInput.value && fileInput.value.click()
}
function onFileChange(e) {
  const f = e.target.files && e.target.files[0]
  keyFile.value = f || null
  keyName.value = f ? f.name : ''
  errMsg.value = ''
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
  if (busy.value) return
  errMsg.value = ''
  const uname = username.value.trim()
  if (!uname) { errMsg.value = '请输入用户名'; return }
  if (!keyFile.value) { errMsg.value = '请选择私钥文件'; return }

  let privateKey
  try {
    privateKey = await readFile(keyFile.value)
  } catch (e) {
    errMsg.value = '读取私钥失败：' + e.message
    return
  }

  busy.value = true
  try {
    const r = await login(uname, privateKey)
    localStorage.setItem(LAST_USER_KEY, uname)
    localStorage.setItem('erp_authed', '1')
    const who = (r.user && (r.user.name || r.user.username)) || uname
    const wh = r.warehouse && r.warehouse.name ? `（${r.warehouse.name}）` : ''
    router.replace('/home')
    showToast(`欢迎，${who}${wh}`)
  } catch (e) {
    const msg = e.message || '登录失败'
    // 最常见的两种踩坑：用户名与私钥不是同一份分配记录；误用历史账号 admin1
    const extra = /不匹配/.test(msg)
      ? '。请确认用户名与私钥出自同一份分配记录；admin1 是历史账号，不能用私钥登录'
      : ''
    errMsg.value = '登录失败：' + msg + extra
  } finally {
    busy.value = false
  }
}
</script>

<style scoped>
.login-wrap { min-height: 100vh; background: #1989fa; display: flex; align-items: center; justify-content: center; }
.login-box { width: 86%; background: #fff; border-radius: 14px; padding: 28px 8px 18px; }
.logo { text-align: center; font-size: 22px; font-weight: 700; color: #1989fa; }
.sub { text-align: center; color: #969799; font-size: 12px; margin: 4px 0 20px; }
.key-row { display: flex; align-items: center; }
.key-row .van-field { flex: 1; }
.key-row .van-button { margin: 0 8px 0 4px; }
.key-hint { color: #969799; font-size: 11px; line-height: 1.6; padding: 6px 18px 0; }
.login-err {
  margin: 10px 16px 0; padding: 8px 10px; border-radius: 8px;
  background: #fff1f0; color: #ee0a24; font-size: 12px; line-height: 1.6; word-break: break-all;
}
.login-btn { margin: 16px 18px 0; }
.key-foot { text-align: center; color: #c8c9cc; font-size: 11px; margin-top: 14px; }
</style>
