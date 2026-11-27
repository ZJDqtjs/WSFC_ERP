<template>
  <van-config-provider :theme="vantTheme" :theme-vars="themeVars">
    <!-- 停服公告滚动条：仅在管理员发布维护公告（倒计时）期间显示 -->
    <div v-if="mtState.noticeOn" class="mt-notice" ref="noticeBarRef">
      <span class="mt-notice-ico">⚠</span>
      <div class="mt-notice-vp">
        <div class="mt-notice-track"></div>
      </div>
    </div>

    <div class="mt-wrap" :class="{ 'has-notice': mtState.noticeOn }">
      <!-- 二级页面：各自带 van-nav-bar，自行管理返回 -->
      <router-view v-if="!isTab" />

      <!-- 底部导航页面：统一磨砂顶栏 + 内容区 + 底部标签栏 -->
      <template v-else>
        <header class="m-header">
          <div class="m-header-left">
            <span class="m-title">{{ title }}</span>
          </div>
          <div class="m-header-right">
            <button
              v-if="warehouse"
              type="button"
              class="wh-chip"
              @click="$router.push({ path: '/settings', query: { panel: 'wh' } })"
            >
              <van-icon name="cluster-o" size="13" />
              <span class="ellipsis">{{ warehouse }}</span>
            </button>
            <button type="button" class="theme-btn" :title="vantTheme === 'dark' ? '浅色主题' : '暗色主题'" @click="toggleTheme">
              <van-icon :name="vantTheme === 'dark' ? 'sun-o' : 'closed-eye'" size="16" />
            </button>
          </div>
        </header>
        <main class="m-main">
          <router-view v-slot="{ Component }">
            <keep-alive :include="keepAlive">
              <component :is="Component" :key="route.fullPath" />
            </keep-alive>
          </router-view>
        </main>
        <van-tabbar route active-color="#2563eb" fixed placeholder safe-area-inset-bottom>
          <van-tabbar-item to="/home" icon="wap-home-o">工作台</van-tabbar-item>
          <van-tabbar-item to="/outbound" icon="logistics">出库</van-tabbar-item>
          <van-tabbar-item to="/inbound" icon="down">入库</van-tabbar-item>
          <van-tabbar-item to="/stock" icon="shopping-cart-o">库存</van-tabbar-item>
          <van-tabbar-item to="/mine" icon="manager-o">我的</van-tabbar-item>
        </van-tabbar>
      </template>
    </div>

    <!-- 系统维护页 -->
    <div v-if="mtState.maskOn" class="mt-mask">
      <div class="mt-box">
        <div class="mt-ico">🛠</div>
        <h2 class="mt-title">{{ maskTip.title }}</h2>
        <p class="mt-sub">{{ maskTip.sub }}</p>
        <p class="mt-info">{{ maskTip.info }}</p>
        <div class="mt-foot">
          <span class="mt-dot"></span>
          <span>{{ mtState.recovering ? '服务已恢复，正在返回…' : '正在检测服务状态，恢复后自动返回…' }}</span>
        </div>
        <van-button block round type="primary" @click="reloadPage">立即刷新</van-button>
      </div>
    </div>
  </van-config-provider>
</template>

<script setup>
import { computed, ref, onMounted, nextTick, watch } from 'vue'
import { useRoute } from 'vue-router'
import api from './api'
import { mtState, maskText, noticeText } from './utils/maintenance'

const route = useRoute()
const isTab = computed(() => !!route.meta.tab)
const title = computed(() => route.meta.title || '企业台账')

/* ---------- 主题切换（浅色 / 暗色，与桌面端一致） ---------- */
const THEME_KEY = 'erp_mobile_theme'
const sysDark = window.matchMedia && window.matchMedia('(prefers-color-scheme: dark)').matches
const savedTheme = localStorage.getItem(THEME_KEY)
const vantTheme = ref(savedTheme === 'dark' || savedTheme === 'light' ? savedTheme : (sysDark ? 'dark' : 'light'))

function syncThemeAttr(val) {
  document.documentElement.setAttribute('data-theme', val)
}
syncThemeAttr(vantTheme.value)

function toggleTheme() {
  vantTheme.value = vantTheme.value === 'dark' ? 'light' : 'dark'
  localStorage.setItem(THEME_KEY, vantTheme.value)
  syncThemeAttr(vantTheme.value)
}

const themeVars = computed(() => ({
  primaryColor: '#2563eb',
  successColor: '#059669',
  dangerColor: '#dc2626',
  warningColor: '#d97706',
  navBarTitleTextColor: vantTheme.value === 'dark' ? '#f1f5f9' : '#0f172a',
  navBarIconColor: vantTheme.value === 'dark' ? '#cbd5e1' : '#334155',
  navBarBackground: vantTheme.value === 'dark' ? 'rgba(15, 23, 42, 0.92)' : 'rgba(255, 255, 255, 0.92)',
  tabbarBackground: vantTheme.value === 'dark' ? '#0f172a' : '#ffffff',
  tabbarItemTextColor: vantTheme.value === 'dark' ? '#94a3b8' : '#64748b',
}))

const noticeLine = computed(() => (mtState.noticeOn ? noticeText() : ''))
const maskTip = computed(() => maskText())
function reloadPage() { location.reload() }

/* ---------- 公告滚动条 ---------- */
const NOTICE_SPEED = 55
const noticeBarRef = ref(null)
let noticeSpans = []

function buildNoticeTrack(text) {
  const bar = noticeBarRef.value
  if (!bar) return
  const vp = bar.querySelector('.mt-notice-vp')
  const track = bar.querySelector('.mt-notice-track')
  if (!vp || !track) return
  track.style.animation = 'none'
  track.innerHTML = ''
  const probe = document.createElement('span')
  probe.className = 'mt-notice-txt'
  probe.textContent = text
  track.appendChild(probe)
  const unitW = probe.getBoundingClientRect().width || 200
  const vpW = vp.clientWidth || 1
  const n = Math.max(1, Math.ceil((vpW + unitW) / unitW))
  track.innerHTML = ''
  noticeSpans = []
  for (let g = 0; g < 2; g++) {
    for (let i = 0; i < n; i++) {
      const s = document.createElement('span')
      s.className = 'mt-notice-txt'
      s.textContent = text
      noticeSpans.push(s)
      track.appendChild(s)
    }
  }
  const dur = Math.max(10, Math.round((n * unitW) / NOTICE_SPEED))
  track.style.animation = `mtNotice ${dur}s linear infinite`
}

function syncNotice() {
  if (!mtState.noticeOn) { noticeSpans = []; return }
  const text = noticeText()
  if (!noticeSpans.length) { nextTick(() => buildNoticeTrack(text)); return }
  noticeSpans.forEach((s) => { s.textContent = text })
}
watch(noticeLine, () => syncNotice(), { immediate: true })

let noticeResizeTimer = null
function onNoticeResize() {
  if (!mtState.noticeOn) return
  clearTimeout(noticeResizeTimer)
  noticeResizeTimer = setTimeout(() => { noticeSpans = []; syncNotice() }, 300)
}

const warehouse = ref('')
onMounted(async () => {
  window.addEventListener('resize', onNoticeResize)
  try {
    const me = await api('/api/auth/me')
    if (me && me.warehouse && me.warehouse.name) warehouse.value = me.warehouse.name
  } catch (e) {}
})

const keepAlive = ['home']
</script>

<style>
:root {
  --m-primary: #2563eb;
  --m-primary-light: #eff6ff;
  --m-green: #059669;
  --m-green-light: #ecfdf5;
  --m-red: #dc2626;
  --m-red-light: #fef2f2;
  --m-amber: #d97706;
  --m-amber-light: #fffbeb;
  --m-bg: #f1f5f9;
  --m-bg-soft: #f8fafc;
  --m-bg-subtle: #e2e8f0;
  --m-card: #ffffff;
  --m-text: #0f172a;
  --m-text-sec: #475569;
  --m-muted: #64748b;
  --m-border: #e2e8f0;
  --m-border-light: #f1f5f9;
  --m-header-bg: rgba(255, 255, 255, 0.92);
}

:root[data-theme="dark"] {
  --m-primary: #3b82f6;
  --m-primary-light: rgba(59, 130, 246, 0.16);
  --m-green: #34d399;
  --m-green-light: rgba(16, 185, 129, 0.14);
  --m-red: #f87171;
  --m-red-light: rgba(239, 68, 68, 0.14);
  --m-amber: #fbbf24;
  --m-amber-light: rgba(245, 158, 11, 0.14);
  --m-bg: #0b1120;
  --m-bg-soft: #1e293b;
  --m-bg-subtle: #1e293b;
  --m-card: #111827;
  --m-text: #f1f5f9;
  --m-text-sec: #cbd5e1;
  --m-muted: #94a3b8;
  --m-border: #1e293b;
  --m-border-light: #1e293b;
  --m-header-bg: rgba(15, 23, 42, 0.92);
}

* { box-sizing: border-box; margin: 0; padding: 0; -webkit-tap-highlight-color: transparent; }
body {
  font-family: -apple-system, "PingFang SC", "Microsoft YaHei", sans-serif;
  background: var(--m-bg);
  color: var(--m-text);
  font-size: 14px;
  -webkit-font-smoothing: antialiased;
}
#app { min-height: 100vh; }
.sub-page { min-height: 100vh; background: var(--m-bg); }

/* ---------- 统一现代磨砂顶栏 ---------- */
.m-header {
  position: sticky; top: 0; z-index: 20;
  display: flex; align-items: center; justify-content: space-between;
  height: 48px; padding: 0 14px;
  background: var(--m-header-bg);
  backdrop-filter: blur(12px);
  -webkit-backdrop-filter: blur(12px);
  border-bottom: 1px solid var(--m-border);
  color: var(--m-text);
}
.m-header-left { display: flex; align-items: center; gap: 8px; min-width: 0; }
.m-header .m-title { font-weight: 700; font-size: 16.5px; letter-spacing: -0.2px; }
.m-header-right { display: flex; align-items: center; gap: 6px; flex-shrink: 0; }
.wh-chip {
  display: inline-flex; align-items: center; gap: 4px;
  max-width: 40vw;
  font-size: 12px; font-weight: 500;
  padding: 4px 10px;
  border-radius: 999px;
  border: 1px solid var(--m-border);
  background: var(--m-primary-light);
  color: var(--m-primary);
  cursor: pointer;
}
.theme-btn {
  width: 30px; height: 30px;
  border-radius: 50%;
  border: 1px solid var(--m-border);
  background: var(--m-bg-soft);
  color: var(--m-text-sec);
  display: inline-flex; align-items: center; justify-content: center;
  cursor: pointer;
}
.m-main { padding: 12px 12px 20px; }

/* 二级页 van-nav-bar 统一磨砂底 + 细底边 */
.van-nav-bar {
  backdrop-filter: blur(12px);
  -webkit-backdrop-filter: blur(12px);
}
.van-nav-bar::after { border-bottom-color: var(--m-border) !important; }
.van-tabbar::after { border-top-color: var(--m-border) !important; }

/* ---------- 通用卡片 ---------- */
.card {
  background: var(--m-card);
  border-radius: 12px;
  padding: 14px;
  margin-bottom: 10px;
  border: 1px solid var(--m-border);
  box-shadow: 0 1px 2px rgba(15, 23, 42, 0.03);
}
.card-title {
  font-weight: 600;
  font-size: 14.5px;
  margin-bottom: 10px;
  display: flex;
  align-items: center;
  gap: 6px;
  color: var(--m-text);
}
.card-title .grow { flex: 1; }
.card-sub { color: var(--m-muted); font-size: 12px; font-weight: 400; }

/* ---------- 布局工具类 ---------- */
.num { text-align: right; font-variant-numeric: tabular-nums; }
.muted { color: var(--m-muted); font-size: 12px; }
.row { display: flex; align-items: center; gap: 8px; }
.row.wrap { flex-wrap: wrap; }
.grow { flex: 1; min-width: 0; }
.ellipsis { overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.mono { font-variant-numeric: tabular-nums; }
.bold { font-weight: 600; }
.mt8 { margin-top: 8px; }
.mt12 { margin-top: 12px; }
.divider { height: 1px; background: var(--m-border-light); margin: 10px 0; }

/* ---------- 统计卡 ---------- */
.stat-grid { display: grid; grid-template-columns: repeat(3, 1fr); gap: 8px; }
.stat-grid.cols2 { grid-template-columns: repeat(2, 1fr); }
.stat-grid.cols4 { grid-template-columns: repeat(4, 1fr); }
.stat {
  background: var(--m-card);
  border-radius: 12px;
  padding: 11px 12px;
  border: 1px solid var(--m-border);
  position: relative;
  overflow: hidden;
}
.stat::before {
  content: '';
  position: absolute;
  top: 0; left: 0; right: 0;
  height: 2.5px;
  background: var(--m-border);
}
.stat.accent::before { background: var(--m-primary); }
.stat.success::before { background: var(--m-green); }
.stat.warn::before { background: var(--m-amber); }
.stat.danger::before { background: var(--m-red); }
.stat .label { font-size: 11.5px; color: var(--m-muted); }
.stat .value { font-size: 15.5px; font-weight: 700; margin-top: 4px; font-variant-numeric: tabular-nums; word-break: break-all; color: var(--m-text); }
.stat .sub { font-size: 11px; color: var(--m-muted); margin-top: 2px; }
.stat.accent .value { color: var(--m-primary); }
.stat.success .value { color: var(--m-green); }
.stat.warn .value { color: var(--m-amber); }
.stat.danger .value { color: var(--m-red); }
.up { color: var(--m-red); }
.down { color: var(--m-green); }

/* ---------- 列表项 ---------- */
.list-item { padding: 10px 0; border-bottom: 1px solid var(--m-border-light); }
.list-item:last-child { border-bottom: none; }
.list-item:active { background: var(--m-bg-soft); border-radius: 8px; }
.item-title { font-weight: 600; font-size: 14px; word-break: break-all; color: var(--m-text); }
.item-meta { color: var(--m-muted); font-size: 12px; margin-top: 3px; line-height: 1.5; }
.empty { color: var(--m-muted); text-align: center; padding: 24px 0; font-size: 13px; }

/* ---------- 表单行 & 统一输入框 ---------- */
.form-row { display: flex; align-items: center; justify-content: space-between; padding: 8px 0; gap: 8px; }
.form-row > .lbl { color: var(--m-text-sec); font-size: 13px; flex-shrink: 0; display: inline-flex; align-items: center; }
.form-row .van-field { padding: 0; background: transparent; }
.inline-field { display: flex; align-items: center; gap: 6px; }
.inline-field .van-field { padding: 5px 9px; background: var(--m-bg-soft); border: 1px solid var(--m-border); border-radius: 8px; }
.m-input {
  background: var(--m-bg-soft) !important;
  border: 1px solid var(--m-border);
  border-radius: 8px;
  padding: 6px 10px !important;
}
.m-date {
  max-width: 132px;
  background: var(--m-bg-soft) !important;
  border: 1px solid var(--m-border);
  border-radius: 8px;
  padding: 5px 8px !important;
}

/* ---------- 轻质感分段切换（iOS 风格，消除刺眼大蓝块叠叠乐） ---------- */
.seg {
  display: flex;
  background: var(--m-bg-subtle);
  border-radius: 10px;
  padding: 3px;
  gap: 3px;
  margin-bottom: 10px;
  overflow-x: auto;
}
.seg-item {
  flex: 1 0 auto;
  text-align: center;
  padding: 6px 10px;
  border-radius: 7px;
  font-size: 13px;
  color: var(--m-text-sec);
  white-space: nowrap;
  border: none;
  background: transparent;
  transition: all 0.15s ease;
}
.seg-item.active {
  background: var(--m-card);
  color: var(--m-primary);
  font-weight: 600;
  box-shadow: 0 1px 3px rgba(15, 23, 42, 0.08);
}

/* 次级快捷胶囊行（日期快捷 / 子视图筛选，与主 Tab 区分视觉层级） */
.chip-row {
  display: flex;
  align-items: center;
  gap: 6px;
  flex-wrap: wrap;
}
.chip-btn {
  border: 1px solid var(--m-border);
  background: var(--m-bg-soft);
  color: var(--m-text-sec);
  font-size: 12px;
  padding: 4px 10px;
  border-radius: 999px;
  cursor: pointer;
}
.chip-btn.active {
  background: var(--m-primary-light);
  border-color: var(--m-primary);
  color: var(--m-primary);
  font-weight: 600;
}

/* ---------- 弹层 / 选择器 ---------- */
.sheet-body {
  padding: 14px 16px 10px;
  height: 100%;
  max-height: 90vh;
  overflow-y: auto;
  overscroll-behavior: contain;
  background: var(--m-card);
  color: var(--m-text);
}
.sheet-title { font-weight: 700; font-size: 16px; text-align: center; margin-bottom: 12px; color: var(--m-text); }
.sheet-foot {
  display: flex; gap: 10px; padding: 12px 0 6px;
  position: sticky; bottom: 0; z-index: 2;
  background: var(--m-card);
  border-top: 1px solid var(--m-border-light);
}
.sheet-foot .van-button { flex: 1; }
.picker-item { display: flex; align-items: center; gap: 10px; padding: 11px 4px; border-bottom: 1px solid var(--m-border-light); }
.picker-item:active { background: var(--m-bg-soft); }
.picker-item.on { color: var(--m-primary); font-weight: 600; }

/* 折叠高级选项 */
.m-fold {
  border: 1px solid var(--m-border);
  border-radius: 10px;
  padding: 8px 12px;
  background: var(--m-bg-soft);
  margin-top: 8px;
}
.m-fold > summary {
  cursor: pointer;
  font-size: 12.5px;
  font-weight: 500;
  color: var(--m-text-sec);
  user-select: none;
}

/* Vant 局部微调 */
.van-cell-group--inset { margin: 0 0 10px; border: 1px solid var(--m-border); border-radius: 10px; overflow: hidden; }
.card .van-cell-group--inset { margin: 0; }
.van-field__label { font-size: 13px; color: var(--m-text-sec); }
.van-toast { word-break: break-all; }
.batch-bar {
  display: flex; gap: 8px; align-items: center; flex-wrap: wrap;
  margin-top: 8px; padding: 8px 10px;
  background: var(--m-primary-light);
  border: 1px solid rgba(37, 99, 235, 0.2);
  border-radius: 8px;
}
.alert { padding: 8px 10px; border-radius: 8px; font-size: 12.5px; margin-top: 8px; line-height: 1.5; }
.alert.warn { background: var(--m-amber-light); color: var(--m-amber); }
.alert.ok { background: var(--m-green-light); color: var(--m-green); }
.alert.err { background: var(--m-red-light); color: var(--m-red); }

/* ---------- 停服公告滚动条 ---------- */
.mt-notice {
  position: fixed; top: 0; left: 0; right: 0; z-index: 3000;
  display: flex; align-items: center; gap: 8px;
  height: 34px; padding: 0 10px;
  background: linear-gradient(90deg, #b45309, #f59e0b);
  color: #fff; font-size: 12.5px;
}
.mt-notice-ico { flex: none; font-size: 13px; }
.mt-notice-vp { flex: 1; overflow: hidden; }
.mt-notice-track { display: inline-flex; white-space: nowrap; will-change: transform; animation: mtNotice 20s linear infinite; }
.mt-notice-txt { padding-right: 60px; }
@keyframes mtNotice { from { transform: translateX(0); } to { transform: translateX(-50%); } }
.mt-wrap.has-notice { padding-top: 34px; }
.mt-wrap.has-notice .m-header { top: 34px; }
.mt-wrap.has-notice .van-nav-bar--fixed { top: 34px; }

/* ---------- 系统维护页 ---------- */
.mt-mask {
  position: fixed; inset: 0; z-index: 5000;
  display: flex; padding: 20px;
  background: radial-gradient(circle at top left, #1e3a8a, #0f172a 70%);
  overflow-y: auto; overscroll-behavior: contain;
}
.mt-box {
  margin: auto; width: 100%; max-width: 420px; flex-shrink: 0;
  background: var(--m-card); border-radius: 14px; padding: 30px 22px; text-align: center;
  box-shadow: 0 12px 36px rgba(0, 0, 0, .24);
}
.mt-ico { font-size: 38px; line-height: 1; }
.mt-title { font-size: 19px; font-weight: 700; margin: 10px 0 8px; }
.mt-sub { color: var(--m-text-sec); font-size: 13.5px; line-height: 1.7; }
.mt-info { color: var(--m-text); font-size: 13.5px; margin-top: 8px; }
.mt-foot { display: flex; align-items: center; justify-content: center; gap: 7px; color: var(--m-muted); font-size: 12px; margin: 18px 0 14px; }
.mt-dot { width: 7px; height: 7px; border-radius: 50%; background: var(--m-primary); animation: mtPulse 1.4s ease-in-out infinite; }
@keyframes mtPulse { 0%, 100% { opacity: .35; transform: scale(.85); } 50% { opacity: 1; transform: scale(1); } }
</style>
