/**
 * 停服公告 / 系统维护页（移动端 PWA）。
 *
 * 与桌面端共用同一套后端状态（keyadmin 写入 data/maintenance.json，
 * 主服务经 GET /api/maintenance/status 下发，免登录）：
 *  - announce    ：顶部滚动提示「还有 X 分钟停机维护」并秒级倒计时，归零自动进维护页
 *  - maintenance ：整屏维护页，直到主服务再次启动（或后台手动结束维护）
 *  - 接口不可达（主服务已停 / nginx 502）：同样进维护页，服务恢复后自动返回
 */
import { reactive } from 'vue'
import { apiPath } from '../api'

export const mtState = reactive({
  noticeOn: false,    // 顶部滚动公告
  maskOn: false,      // 整屏维护页
  offline: false,     // 维护页是否由「服务不可达」触发
  message: '',        // 自定义公告文案
  eta: 0,             // 预计维护时长（分钟）
  remaining: 0,       // 公告倒计时剩余秒数
  recovering: false,
})

const POLL_NORMAL = 15000
const POLL_MAINT = 3000

let timer = null
let tick = null
let misses = 0
let started = false

function setPoll(ms) {
  if (timer) clearInterval(timer)
  timer = setInterval(check, ms)
}

async function fetchStatus() {
  const ctl = new AbortController()
  const to = setTimeout(() => ctl.abort(), 8000)
  try {
    const res = await fetch(apiPath('/api/maintenance/status'), { cache: 'no-store', signal: ctl.signal })
    if (!res.ok) return { ok: false, status: res.status }
    return { ok: true, data: await res.json() }
  } catch (e) {
    return { ok: false, status: 0 }
  } finally {
    clearTimeout(to)
  }
}

function stopTick() {
  if (tick) { clearInterval(tick); tick = null }
}

function hideNotice() {
  mtState.noticeOn = false
}

function enterMask(offline, eta, message) {
  stopTick()
  hideNotice()
  mtState.maskOn = true
  mtState.offline = !!offline
  mtState.eta = eta || 0
  mtState.message = message || ''
  mtState.recovering = false
  setPoll(POLL_MAINT)
}

function recover() {
  if (mtState.recovering) return
  mtState.recovering = true
  stopTick()
  setTimeout(() => location.reload(), 1200)
}

function startTick(st) {
  mtState.noticeOn = true
  mtState.remaining = st.remaining_seconds || 0
  mtState.eta = st.eta_minutes || 0
  mtState.message = st.message || ''
  if (tick) return
  tick = setInterval(() => {
    mtState.remaining -= 1
    if (mtState.remaining <= 0) {
      stopTick()
      check() // 以服务端为准：到期后服务端会返回 maintenance
      return
    }
  }, 1000)
}

async function check() {
  const r = await fetchStatus()
  if (!r.ok) {
    misses += 1
    // 502/503/504：后端已停（典型停服场景）→ 立刻上维护页；网络抖动则连续 2 次再上
    if (!mtState.maskOn && (r.status >= 500 || misses >= 2)) enterMask(true, mtState.eta, mtState.message)
    return
  }
  misses = 0
  const st = r.data || {}
  const mode = st.mode || 'off'
  if (mode === 'maintenance') {
    enterMask(false, st.eta_minutes, st.message)
    return
  }
  if (mode === 'announce' && (st.remaining_seconds || 0) > 0) {
    if (mtState.maskOn) { recover(); return } // 维护计划被取消，直接返回
    setPoll(POLL_NORMAL)
    startTick(st)
    return
  }
  if (mtState.maskOn) { recover(); return }
  stopTick()
  hideNotice()
}

/** 启动维护状态监听（应用启动时调用一次）。 */
export function startMaintenanceWatch() {
  if (started) return
  started = true
  setPoll(POLL_NORMAL)
  check()
}

/** 公告文案（组件用 computed 包一层即可实时刷新）。 */
export function noticeText() {
  const sec = Math.max(0, Math.floor(mtState.remaining))
  const m = Math.floor(sec / 60)
  const s = sec % 60
  const eta = mtState.eta ? `（预计维护 ${mtState.eta} 分钟完成）` : ''
  const head = mtState.message ? `${mtState.message}　` : ''
  if (sec <= 0) return `${head}系统即将停机维护${eta}，请立即保存当前工作并退出。`
  const left = m > 0 ? `${m} 分 ${String(s).padStart(2, '0')} 秒` : `${s} 秒`
  return `${head}系统将于 ${left} 后停机维护${eta}，请及时保存并退出，以免数据丢失。`
}

/** 维护页文案。 */
export function maskText() {
  if (mtState.offline) {
    return {
      title: '系统暂时不可用',
      sub: '系统正在进行维护，请稍后再试。',
      info: '页面会自动检测服务状态，恢复后自动返回。',
    }
  }
  return {
    title: '系统维护中',
    sub: mtState.message || '系统正在停机维护，给您带来不便敬请谅解。',
    info: mtState.eta ? `预计维护时长约 ${mtState.eta} 分钟，请稍后重新访问。` : '请稍后重新访问。',
  }
}
