import Login from './views/login.vue'
import Home from './views/home.vue'
import Fresh from './views/fresh.vue'
import Outbound from './views/outbound.vue'
import Inbound from './views/inbound.vue'
import Stock from './views/stock.vue'
import Mine from './views/mine.vue'
import Backups from './views/backups.vue'

const routes = [
  { path: '/login', component: Login },
  { path: '/', redirect: '/home' },
  { path: '/home', component: Home, meta: { tab: true, title: '工作台' } },
  { path: '/fresh', component: Fresh, meta: { title: '鲜货现采' } },
  { path: '/outbound', component: Outbound, meta: { tab: true, title: '出库' } },
  { path: '/inbound', component: Inbound, meta: { tab: true, title: '入库' } },
  { path: '/stock', component: Stock, meta: { tab: true, title: '库存' } },
  { path: '/mine', component: Mine, meta: { tab: true, title: '我的' } },
  { path: '/backups', component: Backups, meta: { title: '备份与恢复' } },
]

export default routes
