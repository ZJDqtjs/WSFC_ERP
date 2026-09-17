/**
 * 安卓返回键（物理键 / 手势返回）接入 —— 仅在 Capacitor 原生容器内生效
 *
 * 背景：capacitor/ 是「远程加载已部署 PWA」的套壳工程。原生侧没有装 @capacitor/app 时，
 * 返回键走 Android 默认行为（finish Activity），表现为「直接回到桌面」而不是上一页。
 * 装好 App 插件后由本模块接管返回键，优先级与原生 App 一致：
 *   1) 先关掉页面上打开的弹层（Dialog / Popup / ActionSheet）；
 *   2) 应用内还有上一页 => router.back()（上一页 / 上一步）；
 *   3) 已在栈底（工作台等首页）=> 提示「再按一次退出应用」，2 秒内再按才退出。
 */
import { Capacitor } from '@capacitor/core'
import { App } from '@capacitor/app'
import { showToast } from 'vant'

const EXIT_INTERVAL = 2000

/** 元素是否真的可见（弹层有关闭动画，关闭后仍短暂留在 DOM 里） */
function isVisible(el) {
  return !!el && (el.getClientRects().length > 0 || el.offsetWidth > 0 || el.offsetHeight > 0)
}

/** 取最后一个可见的匹配元素（弹层是叠加的，最后渲染的在最上层） */
function lastVisible(selector) {
  const list = document.querySelectorAll(selector)
  for (let i = list.length - 1; i >= 0; i--) {
    if (isVisible(list[i])) return list[i]
  }
  return null
}

/**
 * 关掉最上层弹层，关掉了返回 true。
 * - van-dialog（确认框）默认点遮罩不关闭，且这里的确认动作多为「恢复备份 / 删除 / 清空」，
 *   必须点「取消」，绝不能误触确认按钮。
 * - van-popup / van-action-sheet 默认 close-on-click-overlay，点遮罩即关闭。
 */
function closeTopOverlay() {
  const dialog = lastVisible('.van-dialog')
  if (dialog) {
    const cancel = dialog.querySelector('.van-dialog__cancel')
    if (cancel) cancel.click()
    return true
  }
  const overlay = lastVisible('.van-overlay')
  if (overlay) {
    overlay.click()
    return true
  }
  return false
}

/** 应用内是否还有上一页：vue-router 会把上一页写在 history.state.back，栈底为 null */
function hasInAppHistory() {
  const state = window.history.state
  if (!state) return false
  if (state.back != null) return true
  return typeof state.position === 'number' && state.position > 0
}

/**
 * 原生容器里是否真的注册了 App 插件。
 * 套壳是「远程加载 /mobile/」的：网页总是最新的，老版本 APK 里没有 App 插件，
 * 此时直接跳过，避免调用不存在的插件报错。
 */
function hasAppPlugin() {
  const headers = window.Capacitor && window.Capacitor.PluginHeaders
  if (!Array.isArray(headers)) return true  // 拿不到插件表就不拦
  return headers.some((h) => h && h.name === 'App')
}

/**
 * 接管安卓返回键。
 * @param {import('vue-router').Router} router 应用路由实例
 */
export function setupNativeBack(router) {
  if (!Capacitor.isNativePlatform()) return  // 浏览器 / PWA 保持浏览器默认返回
  if (!hasAppPlugin()) return

  let lastBackAt = 0

  try {
    const registered = App.addListener('backButton', () => {
      if (closeTopOverlay()) return

      if (hasInAppHistory()) {
        router.back()
        return
      }

      const now = Date.now()
      if (now - lastBackAt < EXIT_INTERVAL) {
        App.exitApp()
        return
      }
      lastBackAt = now
      showToast('再按一次退出应用')
    })
    if (registered && typeof registered.catch === 'function') registered.catch(() => {})
  } catch (e) {
    // 极端情况（插件不可用）下安静降级，不影响 App 启动
  }
}
