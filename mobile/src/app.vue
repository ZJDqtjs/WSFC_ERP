<template>
  <!-- 二级页面：各自带 van-nav-bar，自行管理返回 -->
  <router-view v-if="!isTab" />

  <!-- 底部导航页面：统一顶栏 + 内容区 + 底部标签栏 -->
  <template v-else>
    <header class="m-header">
      <div class="m-title">{{ title }}</div>
      <div v-if="warehouse" class="wh-chip" @click="$router.push('/settings')">{{ warehouse }}</div>
    </header>
    <main class="m-main">
      <router-view v-slot="{ Component }">
        <keep-alive :include="keepAlive">
          <component :is="Component" :key="route.fullPath" />
        </keep-alive>
      </router-view>
    </main>
    <van-tabbar route active-color="#1989fa" fixed placeholder safe-area-inset-bottom>
      <van-tabbar-item to="/home" icon="wap-home-o">工作台</van-tabbar-item>
      <van-tabbar-item to="/outbound" icon="logistics">出库</van-tabbar-item>
      <van-tabbar-item to="/inbound" icon="down">入库</van-tabbar-item>
      <van-tabbar-item to="/stock" icon="shopping-cart-o">库存</van-tabbar-item>
      <van-tabbar-item to="/mine" icon="manager-o">我的</van-tabbar-item>
    </van-tabbar>
  </template>
</template>

<script setup>
import { computed, ref, onMounted } from 'vue'
import { useRoute } from 'vue-router'
import api from './api'

const route = useRoute()
const isTab = computed(() => !!route.meta.tab)
const title = computed(() => route.meta.title || '企业台账')

// 分仓标识：切仓后 token 失效，需重新登录，故只需在进入时取一次
const warehouse = ref('')
onMounted(async () => {
  try {
    const me = await api('/api/auth/me')
    if (me && me.warehouse && me.warehouse.name) warehouse.value = me.warehouse.name
  } catch (e) {}
})

// 仅缓存工作台，保证业务页每次进入都是最新数据
const keepAlive = ['home']
</script>

<style>
/* ============ 设计变量（全站色板/圆角/间距，各页面统一引用） ============ */
:root {
  --c-primary: #1989fa;
  --c-primary-bg: #e8f3ff;
  --c-success: #07c160;
  --c-danger: #ee0a24;
  --c-warn: #ff976a;
  --c-warn-bg: #fffbe8;
  --c-warn-text: #ed6a0c;
  --c-text: #323233;
  --c-text-2: #646566;
  --c-muted: #969799;
  --c-bg: #f7f8fa;
  --c-card: #ffffff;
  --c-field-bg: #f7f8fa;
  --c-line: #f2f3f5;
  --c-line-2: #ebedf0;
  --c-hairline: #f5f5f5;
  --radius: 10px;
  --radius-sm: 6px;
  --gap: 12px;
}

* { box-sizing: border-box; margin: 0; padding: 0; -webkit-tap-highlight-color: transparent; }
html { -webkit-text-size-adjust: 100%; }
body {
  font-family: -apple-system, "PingFang SC", "Microsoft YaHei", sans-serif;
  background: var(--c-bg);
  color: var(--c-text);
  font-size: 14px;
}
/* dvh 能跟随移动端浏览器地址栏的收放，避免底部出现空白条 */
#app { min-height: 100vh; min-height: 100dvh; }

/* ============ 二级页面统一外层 ============ */
.sub-page { min-height: 100vh; background: var(--c-bg); }
/* 二级页内容区：统一左右留白与"底部安全区"，避免各页面各写一套 padding */
.sub-body { padding: var(--gap) var(--gap) calc(24px + env(safe-area-inset-bottom, 0px)); }

/* ---------- 顶栏（含刘海屏安全区） ---------- */
.m-header {
  position: sticky; top: 0; z-index: 20;
  display: flex; align-items: center; justify-content: center;
  min-height: calc(46px + env(safe-area-inset-top, 0px));
  padding: env(safe-area-inset-top, 0px) 12px 0;
  background: var(--c-primary); color: #fff;
  font-weight: 600; font-size: 16px;
}
.m-header .m-title {
  flex: 1; min-width: 0; text-align: center;
  overflow: hidden; text-overflow: ellipsis; white-space: nowrap;
  /* 给右侧分仓胶囊留出位置，标题过长时省略而不是被压住 */
  padding: 0 30vw;
}
.wh-chip {
  position: absolute; right: 12px;
  max-width: 28vw; overflow: hidden; text-overflow: ellipsis; white-space: nowrap;
  font-size: 11px; font-weight: 400; padding: 2px 8px;
  background: rgba(255, 255, 255, .22); border-radius: 10px;
}
.m-main { padding: var(--gap) var(--gap) calc(24px + env(safe-area-inset-bottom, 0px)); }

/* ---------- 通用卡片 ---------- */
.card {
  background: var(--c-card); border-radius: var(--radius); padding: 14px; margin-bottom: var(--gap);
  box-shadow: 0 1px 4px rgba(0, 0, 0, .04);
}
/* 卡片标题统一：标题（可带图标）+ 说明 + 撑开的右侧操作 */
.card-title { font-weight: 600; margin-bottom: 10px; display: flex; align-items: center; gap: 6px; }
.card-title .grow { flex: 1; }
.card-sub { color: var(--c-muted); font-size: 12px; font-weight: 400; }
.card-desc { color: var(--c-muted); font-size: 12px; line-height: 1.6; margin-bottom: 10px; }

/* ---------- 布局工具类 ---------- */
.num { text-align: right; font-variant-numeric: tabular-nums; }
.muted { color: var(--c-muted); font-size: 12px; }
/* 语义色文本（避免各页面到处写死 #ee0a24 / #1989fa） */
.c-primary { color: var(--c-primary); }
.c-success { color: var(--c-success); }
.c-danger { color: var(--c-danger); }
.c-warn { color: var(--c-warn); }
/* 不可用/置灰（如已到顶的排序箭头） */
.c-disabled { color: var(--c-line-2); }
.row { display: flex; align-items: center; gap: 8px; }
.row.wrap { flex-wrap: wrap; }
.grow { flex: 1; min-width: 0; }
.ellipsis { overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.mono { font-variant-numeric: tabular-nums; }
.bold { font-weight: 600; }
.mt8 { margin-top: 8px; }
.mt12 { margin-top: 12px; }
.divider { height: 1px; background: var(--c-line); margin: 10px 0; }

/* 金额/数量统一右对齐 + 等宽数字（历史类名一并收敛，避免三种写法各走各的） */
.num-r, .io-amount, .amount, .stock-num {
  text-align: right;
  font-variant-numeric: tabular-nums;
  font-weight: 600;
  white-space: nowrap;
}
/* 单位、口径等辅助信息弱化，避免和金额抢视线 */
.unit-weak { color: var(--c-muted); font-size: 12px; font-weight: 400; }

/* ---------- 筛选行：控件换行后仍整齐 ---------- */
.filter-bar { display: flex; flex-wrap: wrap; gap: 8px; align-items: center; }
.filter-bar .van-field {
  flex: 1 1 128px; min-width: 0; padding: 6px 10px;
  background: var(--c-field-bg); border-radius: var(--radius-sm);
}
.filter-bar .van-field__label { width: auto; margin-right: 4px; font-size: 12px; }
.filter-bar .van-button { flex: none; }

/* ---------- 单据明细行（入库 / 出库 共用） ---------- */
.io-row { padding: 10px 0; border-bottom: 1px solid var(--c-hairline); }
.io-row:last-child { border-bottom: none; }
.io-name { font-weight: 600; font-size: 14px; }
.io-name .placeholder, .placeholder { color: var(--c-primary); font-weight: 500; }
.io-hint { color: var(--c-primary); font-size: 12px; }
.io-amount { min-width: 76px; font-size: 13px; }
/* 关键字搜索框：紧跟在筛选行下面单独占一行 */
.kw-field { background: var(--c-field-bg); border-radius: var(--radius-sm); margin-top: 8px; }
/* 首屏骨架屏卡片（各页统一观感） */
.skeleton-card { background: var(--c-card); border-radius: var(--radius); padding: 14px; margin-bottom: var(--gap); }
/* 行内输入框统一底色（替代各页面重复写的 style="background:#f7f8fa;border-radius:6px"） */
.field-bg { background: var(--c-field-bg); border-radius: var(--radius-sm); }

/* ---------- 批量操作条（列表多选后出现，各页统一） ---------- */
.batch-bar {
  display: flex; align-items: center; gap: 8px; flex-wrap: wrap;
  background: var(--c-warn-bg); border-radius: var(--radius-sm);
  padding: 8px 10px; margin-top: 8px;
}
.batch-bar .muted { color: var(--c-warn-text); }

/* ---------- 提示条：替代各页面手写的浅色内联盒子 ---------- */
.tip {
  font-size: 12px; line-height: 1.7; padding: 8px 10px; border-radius: var(--radius-sm);
  background: var(--c-bg); color: var(--c-text-2); word-break: break-all;
}
.tip + .tip { margin-top: 8px; }
.tip.ok { background: #f0f9eb; color: var(--c-success); }
.tip.warn { background: var(--c-warn-bg); color: var(--c-warn-text); }
.tip.err { background: #fff1f0; color: var(--c-danger); }
.tip.info { background: var(--c-primary-bg); color: var(--c-primary); }

/* ---------- 加载中（替代把"加载中/解析中"塞进 .empty 的做法） ---------- */
.loading-tip {
  display: flex; align-items: center; justify-content: center; gap: 8px;
  padding: 18px 0; color: var(--c-muted); font-size: 13px;
}
.loading-tip::before {
  content: ""; width: 14px; height: 14px; flex: none;
  border: 2px solid currentColor; border-top-color: transparent; border-radius: 50%;
  animation: spin .7s linear infinite;
}
@keyframes spin { to { transform: rotate(360deg); } }

/* ---------- 统计卡 ---------- */
.stat-grid { display: grid; grid-template-columns: repeat(3, 1fr); gap: 8px; }
.stat-grid.cols2 { grid-template-columns: repeat(2, 1fr); }
.stat-grid.cols4 { grid-template-columns: repeat(4, 1fr); }
.stat { background: var(--c-card); border-radius: var(--radius); padding: 10px; }
.stat .label { font-size: 11px; color: var(--c-muted); }
.stat .value { font-size: 15px; font-weight: 700; margin-top: 4px; font-variant-numeric: tabular-nums; word-break: break-all; }
.stat .sub { font-size: 11px; color: var(--c-muted); margin-top: 2px; }
.stat.accent .value { color: var(--c-primary); }
.stat.success .value { color: var(--c-success); }
.stat.warn .value { color: var(--c-warn); }
.stat.danger .value { color: var(--c-danger); }
.up { color: var(--c-danger); }
.down { color: var(--c-success); }

/* ---------- 列表项 ---------- */
.list-item {
  padding: 10px 0; border-bottom: 1px solid var(--c-hairline);
}
.list-item:last-child { border-bottom: none; }
.list-item:active { background: #fafafa; }
.item-title { font-weight: 600; font-size: 14px; word-break: break-all; }
.item-meta { color: var(--c-muted); font-size: 12px; margin-top: 3px; line-height: 1.5; }
.empty { color: var(--c-muted); text-align: center; padding: 22px 0; font-size: 13px; }
/* 空状态配一个线性图标，比纯文字更像"确实没数据"而不是"加载失败" */
.empty::before {
  content: "";
  display: block;
  width: 40px; height: 40px;
  margin: 0 auto 8px;
  background: currentColor;
  opacity: .3;
  -webkit-mask: url("data:image/svg+xml,%3Csvg xmlns='http://www.w3.org/2000/svg' viewBox='0 0 24 24' fill='none' stroke='black' stroke-width='1.5' stroke-linecap='round' stroke-linejoin='round'%3E%3Cpath d='M21 9.5V20a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2V9.5'/%3E%3Cpath d='M2 9.5h20l-2.4-4.3A2 2 0 0 0 17.8 4.2H6.2a2 2 0 0 0-1.8 1L2 9.5z'/%3E%3Cpath d='M2 9.5h5.2l1.4 2.8h6.8l1.4-2.8H22'/%3E%3C/svg%3E") center / contain no-repeat;
  mask: url("data:image/svg+xml,%3Csvg xmlns='http://www.w3.org/2000/svg' viewBox='0 0 24 24' fill='none' stroke='black' stroke-width='1.5' stroke-linecap='round' stroke-linejoin='round'%3E%3Cpath d='M21 9.5V20a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2V9.5'/%3E%3Cpath d='M2 9.5h20l-2.4-4.3A2 2 0 0 0 17.8 4.2H6.2a2 2 0 0 0-1.8 1L2 9.5z'/%3E%3Cpath d='M2 9.5h5.2l1.4 2.8h6.8l1.4-2.8H22'/%3E%3C/svg%3E") center / contain no-repeat;
}
/* 分页/限行提示也统一一下语气与间距 */
.list-more { text-align: center; color: #969799; font-size: 12px; padding: 8px 0 2px; }

/* ---------- 表单行 ---------- */
.form-row { display: flex; align-items: center; justify-content: space-between; padding: 9px 0; gap: 8px; }
.form-row > .lbl { color: var(--c-text-2); font-size: 13px; flex-shrink: 0; }
.form-row .van-field { padding: 0; }
.inline-field { display: flex; align-items: center; gap: 6px; }
.inline-field .van-field { padding: 4px 8px; background: var(--c-field-bg); border-radius: var(--radius-sm); }

/* ---------- 分段选择（子页签） ---------- */
.seg {
  display: flex; background: var(--c-card); border-radius: var(--radius); padding: 4px; gap: 4px;
  margin-bottom: var(--gap); overflow-x: auto; -webkit-overflow-scrolling: touch;
}
.seg::-webkit-scrollbar { display: none; }
.seg-item {
  flex: 1 0 auto; min-width: 68px; text-align: center; padding: 7px 8px; border-radius: 8px;
  font-size: 13px; color: var(--c-text-2); white-space: nowrap; border: none; background: transparent;
}
.seg-item.active { background: var(--c-primary); color: #fff; font-weight: 600; }

/* ---------- 弹层 / 选择器 ---------- */
/* 弹层内容区统一：自身滚动 + 底部安全区，底部按钮用 .sheet-foot 固定 */
.sheet-body {
  padding: 14px 16px calc(16px + env(safe-area-inset-bottom, 0px));
  height: 100%; overflow-y: auto; -webkit-overflow-scrolling: touch;
}
.sheet-title { font-weight: 600; font-size: 16px; text-align: center; margin-bottom: 12px; }
.sheet-foot { display: flex; gap: 10px; padding: 12px 0 4px; position: sticky; bottom: 0; background: var(--c-card); }
.sheet-foot .van-button { flex: 1; }
.picker-item { display: flex; align-items: center; gap: 10px; padding: 11px 4px; border-bottom: 1px solid var(--c-hairline); }
.picker-item:active { background: #f5f6f7; }
.picker-item.on { color: var(--c-primary); font-weight: 600; }

/* ---------- Vant 局部微调 ---------- */
.van-cell-group--inset { margin: 0 0 10px; }
.van-field__label { font-size: 13px; }
.van-toast { word-break: break-all; }
/* 主按钮统一圆角，避免有的页面 round 有的不是 */
.sheet-foot .van-button { border-radius: var(--radius); }
</style>
