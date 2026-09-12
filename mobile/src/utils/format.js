/** 金额 / 数量 / 单位换算的统一格式化工具（与桌面端 app.js 口径一致）。 */

export const num = (v) => {
  const n = typeof v === 'number' ? v : parseFloat(v)
  return Number.isFinite(n) ? n : 0
}

/** 金额：¥1,234.50 */
export const fmtMoney = (v) =>
  '¥' + num(v).toLocaleString('zh-CN', { minimumFractionDigits: 2, maximumFractionDigits: 2 })

/** 数量：最多 4 位小数，去掉无意义的尾随 0（100 / 1.5 / 0.0025） */
export const fmtNum = (v) => {
  const n = num(v)
  const s = n.toFixed(4).replace(/\.?0+$/, '')
  return s === '' || s === '-' || s === '-0' ? '0' : s
}

/** 带正负号的差异展示：+2 / -1.5 */
export const fmtSign = (v) => {
  const n = num(v)
  return (n > 0 ? '+' : '') + fmtNum(n)
}

export const defaultUnit = (p) => (p && (p.default_unit || p.base_unit)) || ''

export const unitFactor = (p, unit) => num(((p && p.conversions) || {})[unit]) || 1

/** 基础单位数量 → 展示单位字符串，如 “95 公斤” */
export const fmtStock = (p) => {
  if (!p) return '—'
  if (p.stock_display) return p.stock_display
  const du = defaultUnit(p)
  const f = unitFactor(p, du)
  return `${fmtNum(num(p.stock) / f)} ${du}`
}

/** 基础单位单价 → 展示单位单价字符串，如 “¥3.00/公斤” */
export const fmtCost = (p, field = 'avg_cost') => {
  const du = defaultUnit(p)
  const f = unitFactor(p, du)
  return `${fmtMoney(num(p && p[field]) * f)}/${du}`
}

/** 商品在某单位下的售价（基础单位单价 × 换算系数） */
export const priceOf = (p, unit) => {
  if (!p) return 0
  const f = unitFactor(p, unit)
  if (num(p.sale_price) > 0) return num(p.sale_price) * f
  if (num(p.avg_cost) > 0) return num(p.avg_cost) * f
  if (num(p.unit_cost) > 0) return num(p.unit_cost) * f
  return 0
}

export const pad2 = (n) => String(n).padStart(2, '0')

export const todayStr = () => {
  const d = new Date()
  return `${d.getFullYear()}-${pad2(d.getMonth() + 1)}-${pad2(d.getDate())}`
}

export const monthStartStr = () => todayStr().slice(0, 8) + '01'

export const daysAgoStr = (n) => {
  const d = new Date()
  d.setDate(d.getDate() - n)
  return `${d.getFullYear()}-${pad2(d.getMonth() + 1)}-${pad2(d.getDate())}`
}

/** 是否为合法的相对调整串：+100 / -1.5 */
export const isRelAdjust = (s) => /^[+-]\d+(\.\d+)?$/.test((s || '').trim())

export const moveTypeLabel = (t) =>
  ({ in: '入库', out: '出库', pack_out: '关联扣减', adjust: '盘点', cost: '均价重估', ucost: '成本单价' }[t] || t || '')

export const shrink = (arr) => [...new Set((arr || []).filter(Boolean))]
