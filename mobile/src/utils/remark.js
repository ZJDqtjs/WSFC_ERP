/**
 * 备注附件解析：备注文本里以 /uploads/xxx 形式保存附件（与桌面端、AI 票据共用同一格式）。
 * 字符集必须与后端落盘文件名保持一致（见 backend/app/routers/uploads.py）。
 */
import { upload, assetUrl } from '../api'

const UPLOAD_RE = /\/uploads\/[A-Za-z0-9_.\-\u4e00-\u9fff]+/g
const IMAGE_EXT_RE = /\.(png|jpe?g|gif|webp|bmp|svg)$/i
const NAME_PREFIX_RE = /^attach_\d{8}_\d{6}_\d+_/

const isImageUrl = (url) => IMAGE_EXT_RE.test(url || '')

/** 附件展示名：去掉 attach_<时间戳>_ 前缀，还原可读文件名 */
function attachName(url) {
  const n = String(url || '').split('/').pop() || '附件'
  return n.replace(NAME_PREFIX_RE, '') || n
}

/** 备注 → 有序段落：[{ type:'text', text }] 或 [{ type:'file', url, name, isImage, src }] */
export function parseRemark(remark) {
  const text = String(remark || '')
  const segs = []
  let last = 0
  let m
  UPLOAD_RE.lastIndex = 0
  while ((m = UPLOAD_RE.exec(text))) {
    if (m.index > last) segs.push({ type: 'text', text: text.slice(last, m.index) })
    const url = m[0]
    segs.push({ type: 'file', url, name: attachName(url), isImage: isImageUrl(url), src: assetUrl(url) })
    last = m.index + url.length
  }
  if (last < text.length) segs.push({ type: 'text', text: text.slice(last) })
  return segs.filter((s) => s.type === 'file' || s.text.trim())
}

/** 上传一批本地文件并追加到备注末尾，返回新的备注字符串 */
export async function uploadToRemark(files, remark) {
  let text = String(remark || '')
  for (const f of files) {
    const r = await upload('/api/uploads', f)
    text = text.trim() ? `${text.trim()}\n${r.url}` : r.url
  }
  return text
}

/** 从备注里移除某个附件 URL */
export function removeFromRemark(remark, url) {
  return String(remark || '')
    .split(url).join('')
    .replace(/[ \t]+$/gm, '')
    .replace(/\n{2,}/g, '\n')
    .trim()
}
