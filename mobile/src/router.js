import Login from './views/Login.vue'
import Home from './views/Home.vue'
import Outbound from './views/Outbound.vue'
import Inbound from './views/Inbound.vue'
import Stock from './views/Stock.vue'
import Mine from './views/Mine.vue'

const routes = [
  { path: '/login', component: Login },
  { path: '/', redirect: '/home' },
  { path: '/home', component: Home, meta: { tab: true, title: '工作台' } },
  { path: '/outbound', component: Outbound, meta: { tab: true, title: '出库' } },
  { path: '/inbound', component: Inbound, meta: { tab: true, title: '入库' } },
  { path: '/stock', component: Stock, meta: { tab: true, title: '库存' } },
  { path: '/mine', component: Mine, meta: { tab: true, title: '我的' } },
]

export default routes
