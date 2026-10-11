/**
 * 工作台「全部功能」宫格的可显隐入口清单（对应桌面端「设置 → 模块显示」）。
 *
 * 偏好存在本机 localStorage：只影响这台设备上工作台宫格的显示，
 * 不改服务端数据、也不影响其他人。
 */
const NAV_KEY = 'erp_nav_hidden'

export const NAV_MODULES = [
  { key: 'products', label: '商品管理', icon: 'goods-collect-o', to: '/products' },
  { key: 'packrules', label: '一单多货', icon: 'logistics', to: '/packrules' },
  { key: 'report', label: '财务报表', icon: 'bar-chart-o', to: '/report' },
  { key: 'fresh', label: '鲜货现采', icon: 'bag-o', to: '/fresh' },
  { key: 'fresh_in', label: '鲜货入库', icon: 'shop-o', to: '/fresh?tab=in' },
  { key: 'deduction', label: '扣点', icon: 'gold-coin-o', to: '/deduction' },
  { key: 'express', label: '快递费', icon: 'send-gift-o', to: '/express' },
  { key: 'settings', label: '设置', icon: 'setting-o', to: '/settings' },
]

/** 被隐藏的模块 key（存坏 / 旧值一律当没有） */
export function getHiddenNav() {
  try {
    const v = JSON.parse(localStorage.getItem(NAV_KEY) || '[]')
    return Array.isArray(v) ? v.filter((k) => NAV_MODULES.some((m) => m.key === k)) : []
  } catch (e) { return [] }
}

export function setHiddenNav(keys) {
  const clean = (keys || []).filter((k) => NAV_MODULES.some((m) => m.key === k))
  try { localStorage.setItem(NAV_KEY, JSON.stringify(clean)) } catch (e) { /* 隐私模式忽略 */ }
  return clean
}
