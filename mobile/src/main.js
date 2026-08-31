import { createApp } from 'vue'
import { createRouter, createWebHistory } from 'vue-router'
import { showToast } from 'vant'
import Vant from 'vant'
import App from './App.vue'
import routes from './router'
import 'vant/lib/index.css'

const router = createRouter({ history: createWebHistory(), routes })

router.beforeEach((to) => {
  // 后端登录 cookie 为 HttpOnly，document.cookie 读不到，改用 localStorage 记录登录态
  const authed = localStorage.getItem('erp_authed') === '1'
  if (to.path !== '/login' && !authed) return '/login'
  if (to.path === '/login' && authed) return '/home'
})

const app = createApp(App)
app.use(Vant)          // 全量注册 Vant 组件（van-field / van-button / van-tabbar 等）
app.use(router)
app.provide('toast', showToast)
app.mount('#app')
