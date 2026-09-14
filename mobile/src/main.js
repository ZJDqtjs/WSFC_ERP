import { createApp } from 'vue'
import { createRouter, createWebHistory } from 'vue-router'
import { showToast } from 'vant'
import Vant from 'vant'
import App from './app.vue'
import routes from './router'
import 'vant/lib/index.css'

const router = createRouter({ history: createWebHistory(import.meta.env.BASE_URL), routes })

router.beforeEach((to) => {
  // 后端登录 cookie 为 HttpOnly，document.cookie 读不到，改用 localStorage 记录登录态
  const authed = localStorage.getItem('erp_authed') === '1'
  if (to.path !== '/login' && !authed) return { path: '/login' }
  if (to.path === '/login' && authed) return { path: '/home' }
})

// 标题跟随页面：手机多任务/添加到主屏后，能一眼分辨当前在哪个页面
router.afterEach((to) => {
  document.title = to.path === '/login' ? '登录 · 企业台账' : `${to.meta.title || '企业台账'} · 企业台账`
  // 切换页面回到顶部，否则从长列表进二级页会停在半中间
  window.scrollTo(0, 0)
})

const app = createApp(App)
app.use(Vant)          // 全量注册 Vant 组件（van-field / van-button / van-tabbar 等）
app.use(router)
app.provide('toast', showToast)
app.mount('#app')
