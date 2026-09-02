const BASE = import.meta.env.BASE_URL.replace(/\/$/, '')
const API_BASE = __API_BASE__

function apiPath(path) {
  return path.startsWith('/api') ? API_BASE + path.slice(4) : path
}

async function api(path, method = 'GET', body, formData) {
  const opt = { method, headers: {} }
  if (body !== undefined) { opt.headers['Content-Type'] = 'application/json'; opt.body = JSON.stringify(body) }
  if (formData) opt.body = formData
  const res = await fetch(apiPath(path), opt)
  if (res.status === 401) { localStorage.removeItem('erp_authed'); location.href = `${BASE}/login`; throw new Error('未登录') }
  if (!res.ok) {
    let msg = '请求失败'
    try { const j = await res.json(); msg = j.detail || msg } catch (e) {}
    throw new Error(msg)
  }
  return res.json()
}

/** 流式读取 SSE（AI 识别），onDelta 实时回调，返回最终 result；formData 传 FormData 则按 multipart 上传 */
export async function aiStream(path, body, onDelta, formData) {
  const opt = { method: 'POST' }
  if (formData) opt.body = formData
  else { opt.headers = { 'Content-Type': 'application/json' }; opt.body = JSON.stringify(body) }
  const res = await fetch(apiPath(path), opt)
  if (res.status === 401) { localStorage.removeItem('erp_authed'); location.href = `${BASE}/login`; throw new Error('未登录') }
  if (!res.ok) {
    let msg = '请求失败'
    try { const j = await res.json(); msg = j.detail || msg } catch (e) {}
    throw new Error(msg)
  }
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
      if (obj.delta) onDelta && onDelta(obj.delta)
      else if (obj.result) {
        if (!result || obj.source === 'quick') result = obj.result
      }
      else if (obj.error) throw new Error(obj.error)
    }
  }
  if (!result) throw new Error('识别未返回结果')
  return result
}

export default api
