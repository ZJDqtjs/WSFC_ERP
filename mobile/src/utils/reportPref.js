/**
 * 财务报表口径偏好：是否排除「其他开支」（经营分析 → 其他开支 里登记的款项）。
 *
 * 开启（默认）：财务报表不计入其他开支，只看商品售卖利润；
 * 关闭：其他开支照旧并入期间费用，从毛利中扣减得到净利。
 *
 * 偏好存在本机 localStorage，与 web 端共用同一个 key，两端设置一致。
 */
const KEY = 'erp_exclude_other_expense'

/** 是否排除其他开支（无记录时默认开启） */
export function getExcludeOther() {
  return localStorage.getItem(KEY) !== '0'
}

export function setExcludeOther(on) {
  localStorage.setItem(KEY, on ? '1' : '0')
}

/** 报表请求附加的口径参数（后端默认含其他开支，所以这里总是显式声明） */
export function excludeOtherQs() {
  return getExcludeOther() ? '&exclude_other=1' : '&exclude_other=0'
}
