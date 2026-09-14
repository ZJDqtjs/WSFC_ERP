import Login from './views/login.vue'
import Home from './views/home.vue'
import Fresh from './views/fresh.vue'
import Outbound from './views/outbound.vue'
import OutGroup from './views/outgroup.vue'
import Inbound from './views/inbound.vue'
import Stock from './views/stock.vue'
import Products from './views/products.vue'
import PackRules from './views/packrules.vue'
import Report from './views/report.vue'
import OtherExp from './views/otherexp.vue'
import Deduction from './views/deduction.vue'
import Express from './views/express.vue'
import Settings from './views/settings.vue'
import Mine from './views/mine.vue'

const routes = [
  { path: '/login', component: Login, meta: { title: '登录' } },
  { path: '/', redirect: '/home' },

  // 底部导航（工作台 / 出库 / 入库 / 库存 / 我的）
  { path: '/home', component: Home, meta: { tab: true, title: '工作台' } },
  { path: '/outbound', component: Outbound, meta: { tab: true, title: '出库 / 销售' } },
  { path: '/inbound', component: Inbound, meta: { tab: true, title: '入库' } },
  { path: '/stock', component: Stock, meta: { tab: true, title: '库存管理' } },
  { path: '/mine', component: Mine, meta: { tab: true, title: '我的' } },

  // 二级页面
  { path: '/ogroup/:key', component: OutGroup, meta: { title: '出库批次明细' } },
  { path: '/fresh', component: Fresh, meta: { title: '鲜货现采' } },
  { path: '/products', component: Products, meta: { title: '商品管理' } },
  { path: '/packrules', component: PackRules, meta: { title: '一单多货' } },
  { path: '/report', component: Report, meta: { title: '财务报表' } },
  { path: '/otherexp', component: OtherExp, meta: { title: '其他开支' } },
  { path: '/deduction', component: Deduction, meta: { title: '扣点设置' } },
  { path: '/express', component: Express, meta: { title: '快递费规则' } },
  { path: '/settings', component: Settings, meta: { title: '设置' } },

  { path: '/:pathMatch(.*)*', redirect: '/home' },
]

export default routes
