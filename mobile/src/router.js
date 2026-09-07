import Login from './views/login.vue'
import Home from './views/home.vue'
import Fresh from './views/fresh.vue'
import Outbound from './views/outbound.vue'
import Inbound from './views/inbound.vue'
import Stock from './views/stock.vue'
import Mine from './views/mine.vue'
import Backups from './views/backups.vue'
import Records from './views/records.vue'
import PackRules from './views/pack-rules.vue'
import Report from './views/report.vue'

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
  { path: '/records', component: Records, meta: { title: '出入库记录' } },
  { path: '/pack-rules', component: PackRules, meta: { title: '一单多货规则' } },
  { path: '/report', component: Report, meta: { title: '经营报表' } },
]

export default routes
