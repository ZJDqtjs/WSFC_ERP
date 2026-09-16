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

// 分仓标识：分仓随登录会话（切仓只重签自己的令牌、不会掉线），整页刷新后取一次即可
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
* { box-sizing: border-box; margin: 0; padding: 0; -webkit-tap-highlight-color: transparent; }
body {
  font-family: -apple-system, "PingFang SC", "Microsoft YaHei", sans-serif;
  background: #f7f8fa;
  color: #323233;
  font-size: 14px;
}
#app { min-height: 100vh; }

/* ---------- 顶栏 ---------- */
.m-header {
  position: sticky; top: 0; z-index: 20;
  display: flex; align-items: center; justify-content: center;
  height: 46px; background: #1989fa; color: #fff;
  font-weight: 600; font-size: 16px; padding: 0 12px;
}
.m-header .m-title { flex: 1; text-align: center; }
.wh-chip {
  position: absolute; right: 12px;
  max-width: 34vw; overflow: hidden; text-overflow: ellipsis; white-space: nowrap;
  font-size: 11px; font-weight: 400; padding: 2px 8px;
  background: rgba(255, 255, 255, .22); border-radius: 10px;
}
.m-main { padding: 12px 12px 16px; }

/* ---------- 通用卡片 ---------- */
.card {
  background: #fff; border-radius: 10px; padding: 14px; margin-bottom: 12px;
  box-shadow: 0 1px 4px rgba(0, 0, 0, .04);
}
.card-title { font-weight: 600; margin-bottom: 10px; display: flex; align-items: center; gap: 6px; }
.card-title .grow { flex: 1; }
.card-sub { color: #969799; font-size: 12px; font-weight: 400; }

/* ---------- 布局工具类 ---------- */
.num { text-align: right; font-variant-numeric: tabular-nums; }
.muted { color: #969799; font-size: 12px; }
.row { display: flex; align-items: center; gap: 8px; }
.row.wrap { flex-wrap: wrap; }
.grow { flex: 1; min-width: 0; }
.ellipsis { overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.mono { font-variant-numeric: tabular-nums; }
.bold { font-weight: 600; }
.mt8 { margin-top: 8px; }
.mt12 { margin-top: 12px; }
.divider { height: 1px; background: #f2f3f5; margin: 10px 0; }

/* ---------- 统计卡 ---------- */
.stat-grid { display: grid; grid-template-columns: repeat(3, 1fr); gap: 8px; }
.stat-grid.cols2 { grid-template-columns: repeat(2, 1fr); }
.stat-grid.cols4 { grid-template-columns: repeat(4, 1fr); }
.stat { background: #fff; border-radius: 10px; padding: 10px; }
.stat .label { font-size: 11px; color: #969799; }
.stat .value { font-size: 15px; font-weight: 700; margin-top: 4px; font-variant-numeric: tabular-nums; word-break: break-all; }
.stat .sub { font-size: 11px; color: #969799; margin-top: 2px; }
.stat.accent .value { color: #1989fa; }
.stat.success .value { color: #07c160; }
.stat.warn .value { color: #ff976a; }
.stat.danger .value { color: #ee0a24; }
.up { color: #ee0a24; }
.down { color: #07c160; }

/* ---------- 列表项 ---------- */
.list-item {
  padding: 10px 0; border-bottom: 1px solid #f5f5f5;
}
.list-item:last-child { border-bottom: none; }
.list-item:active { background: #fafafa; }
.item-title { font-weight: 600; font-size: 14px; word-break: break-all; }
.item-meta { color: #969799; font-size: 12px; margin-top: 3px; line-height: 1.5; }
.empty { color: #969799; text-align: center; padding: 20px 0; font-size: 13px; }

/* ---------- 表单行 ---------- */
.form-row { display: flex; align-items: center; justify-content: space-between; padding: 9px 0; gap: 8px; }
.form-row > .lbl { color: #646566; font-size: 13px; flex-shrink: 0; }
.form-row .van-field { padding: 0; }
.inline-field { display: flex; align-items: center; gap: 6px; }
.inline-field .van-field { padding: 4px 8px; background: #f7f8fa; border-radius: 6px; }

/* ---------- 分段选择（子页签） ---------- */
.seg { display: flex; background: #fff; border-radius: 10px; padding: 4px; gap: 4px; margin-bottom: 12px; overflow-x: auto; }
.seg-item {
  flex: 1 0 auto; text-align: center; padding: 7px 8px; border-radius: 8px;
  font-size: 13px; color: #646566; white-space: nowrap; border: none; background: transparent;
}
.seg-item.active { background: #1989fa; color: #fff; font-weight: 600; }

/* ---------- 弹层 / 选择器 ---------- */
/* 弹层主体自身滚动 + 底部按钮栏吸底：内容再长也不用滑到底才能点按钮 */
.sheet-body {
  padding: 14px 16px 10px;
  height: 100%;
  max-height: 90vh;
  overflow-y: auto;
  overscroll-behavior: contain;
}
.sheet-title { font-weight: 600; font-size: 16px; text-align: center; margin-bottom: 12px; }
.sheet-foot {
  display: flex; gap: 10px; padding: 12px 0 6px;
  position: sticky; bottom: 0; z-index: 2;
  background: #fff;
  box-shadow: 0 -10px 12px -12px rgba(0, 0, 0, 0.35);
}
.sheet-foot .van-button { flex: 1; }
.picker-item { display: flex; align-items: center; gap: 10px; padding: 11px 4px; border-bottom: 1px solid #f5f5f5; }
.picker-item:active { background: #f5f6f7; }
.picker-item.on { color: #1989fa; font-weight: 600; }

/* Vant 局部微调 */
.van-cell-group--inset { margin: 0 0 10px; }
.van-field__label { font-size: 13px; }
.van-toast { word-break: break-all; }
</style>
