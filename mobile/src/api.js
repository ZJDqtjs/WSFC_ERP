const BASE = import.meta.env.BASE_URL.replace(/\/$/, '')
const API_BASE = __API_BASE__

/** 把 /api/xxx 解析为真实请求地址（后端可能被部署到独立域名/端口）。 */
export function apiPath(path) {
  return path.startsWith('/api') ? API_BASE + path.slice(4) : path
}

/** 静态资源（/uploads/xxx.png）可直接用于 <img src> 或 <a download href>。 */
export function assetUrl(path) {
  if (!path) return ''
  if (/^https?:\/\//i.test(path)) return path
  // /uploads 与 /api 同源（nginx 统一反代），去掉 API_BASE 的 /api 尾巴再拼前缀
  const uploadsBase = API_BASE.replace(/\/api\/?$/, '')
  return path.startsWith('/uploads') ? uploadsBase + path : path
}

function onUnauthorized() {
  localStorage.removeItem('erp_authed')
  // 打标记，登录页据此解释"为什么被踢回来"（会话过期 / 账号被停用）
  try { sessionStorage.setItem('erp_kicked', '1') } catch (e) {}
  // 已经在登录页时不要再整页跳转一次，否则登录失败会被刷成"没反应"，
  // 而且会把刚填的用户名/已选私钥一起清空。
  if (/\/login\/?$/.test(location.pathname)) return
  location.href = `${BASE}/login`
}

async function readError(res, fallback = '请求失败') {
  let msg = fallback
  try {
    const j = await res.json()
    if (j && j.detail) msg = typeof j.detail === 'string' ? j.detail : JSON.stringify(j.detail)
  } catch (e) {}
  return msg
}

/** JSON 请求：api('/api/products', 'GET' | 'POST' | 'PUT' | 'DELETE', body) */
async function api(path, method = 'GET', body) {
  const opt = { method, headers: {} }
  if (body !== undefined) {
    opt.headers['Content-Type'] = 'application/json'
    opt.body = JSON.stringify(body)
  }
  const res = await fetch(apiPath(path), opt)
  if (res.status === 401) { onUnauthorized(); throw new Error('未登录') }
  if (!res.ok) throw new Error(await readError(res))
  if (res.status === 204) return {}
  return res.json()
}

/**
 * 登录专用入口。
 * 不走 api() 的 401 分支：登录失败时后端返回的正是 401「用户名或私钥不匹配」，
 * 用 api() 会把真实原因替换成「未登录」并整页刷新，导致用户只看到页面闪一下。
 * 这里把后端的真实 detail 原样抛出。
 */
export async function login(username, privateKey) {
  const res = await fetch(apiPath('/api/auth/login'), {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ username, private_key: privateKey }),
  })
  if (!res.ok) {
    const fallback = res.status === 400
      ? '私钥文件无法解析，请确认为 Ed25519 私钥'
      : '用户名或私钥不匹配'
    throw new Error(await readError(res, fallback))
  }
  return res.json()
}

/** multipart/form-data 上传，返回 JSON。file 为 File 对象，fields 为附加表单字段。 */
export async function upload(path, file, fields = {}, method = 'POST') {
  const fd = new FormData()
  if (file) {
    fd.append('file', file)
    Object.entries(fields || {}).forEach(([k, v]) => {
      if (v !== undefined && v !== null) fd.append(k, v)
    })
  }
  const res = await fetch(apiPath(path), { method, body: fd })
  if (res.status === 401) { onUnauthorized(); throw new Error('未登录') }
  if (!res.ok) throw new Error(await readError(res))
  return res.json()
}

/** GET 一个文件流并触发浏览器下载（模板下载 / 备份下载 / JSON 导出）。 */
export async function downloadFile(path, filename) {
  const res = await fetch(apiPath(path))
  if (res.status === 401) { onUnauthorized(); throw new Error('未登录') }
  if (!res.ok) throw new Error(await readError(res, '下载失败'))
  const blob = await res.blob()
  const url = URL.createObjectURL(blob)
  const a = document.createElement('a')
  a.href = url
  a.download = filename || path.split('/').pop() || 'download'
  document.body.appendChild(a)
  a.click()
  document.body.removeChild(a)
  setTimeout(() => URL.revokeObjectURL(url), 1000)
}

/** 把一个 JS 对象保存为本地 JSON 文件。 */
export function downloadJson(obj, filename) {
  const blob = new Blob([JSON.stringify(obj, null, 2)], { type: 'application/json' })
  const url = URL.createObjectURL(blob)
  const a = document.createElement('a')
  a.href = url
  a.download = filename
  document.body.appendChild(a)
  a.click()
  document.body.removeChild(a)
  setTimeout(() => URL.revokeObjectURL(url), 1000)
}

/**
 * 流式读取 SSE（AI 识别）。
 * @param onDelta 正式输出（JSON）增量回调
 * @param onThink 模型「思考过程」增量回调（reasoning_content）
 * @param onStage 阶段提示回调（如「正在调用大模型识别…」）
 * 返回最终 result；formData 传 FormData 则按 multipart 上传。
 */
export async function aiStream(path, body, onDelta, formData, signal, onThink, onStage) {
  const opt = { method: 'POST' }
  if (signal) opt.signal = signal
  if (formData) opt.body = formData
  else { opt.headers = { 'Content-Type': 'application/json' }; opt.body = JSON.stringify(body) }
  const res = await fetch(apiPath(path), opt)
  if (res.status === 401) { onUnauthorized(); throw new Error('未登录') }
  if (!res.ok) throw new Error(await readError(res))
  const reader = res.body.getReader()
  const decoder = new TextDecoder('utf-8')
  let buf = '', result = null
  for (;;) {
    const { done, value } = await reader.read()
    if (done) break
    buf += decoder.decode(value, { stream: true })
    const parts = buf.split('\n\n')
    buf = parts.pop()
    for (const part of parts) {
      const line = part.trim()
      if (!line.startsWith('data:')) continue
      const data = line.slice(5).trim()
      if (!data) continue
      let obj
      try { obj = JSON.parse(data) } catch (e) { continue }
      if (obj.think) onThink && onThink(obj.think)
      else if (obj.stage) onStage && onStage(obj.stage)
      else if (obj.delta) onDelta && onDelta(obj.delta)
      // 本地快速识别（quick）优先于大模型精修（llm）覆盖
      else if (obj.result) { if (!result || obj.source === 'quick') result = obj.result }
      else if (obj.error) throw new Error(obj.error)
    }
  }
  if (!result) throw new Error('识别未返回结果')
  return result
}

export default api
