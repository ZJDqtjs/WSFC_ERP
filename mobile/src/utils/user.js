/**
 * 当前登录账号：操作员字段统一取这里的值（只读展示）。
 * 只请求一次 /api/auth/me；切仓/重登会整页刷新，缓存无需失效处理。
 */
import { ref } from 'vue'
import api from '../api'

export const userName = ref('')
let pending = null

/** 确保已拿到当前登录账号显示名（取不到时返回空串，不影响主流程）。 */
export async function ensureUserName() {
  if (userName.value) return userName.value
  if (!pending) {
    pending = api('/api/auth/me')
      .then((u) => {
        userName.value = (u && (u.name || u.username)) || ''
        return userName.value
      })
      .catch(() => '')
      .finally(() => { pending = null })
  }
  return pending
}
