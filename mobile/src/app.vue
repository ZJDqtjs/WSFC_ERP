<template>
  <main v-if="isSub" class="m-main m-sub">
    <router-view />
  </main>
  <router-view v-else-if="!isTab" />
  <template v-else>
    <header class="m-header">
      <div class="m-title">{{ title }}</div>
    </header>
    <main class="m-main">
      <router-view />
    </main>
    <van-tabbar route active-color="#1989fa">
      <van-tabbar-item to="/home" icon="wap-home-o">工作台</van-tabbar-item>
      <van-tabbar-item to="/outbound" icon="logistics">出库</van-tabbar-item>
      <van-tabbar-item to="/inbound" icon="down">入库</van-tabbar-item>
      <van-tabbar-item to="/stock" icon="shopping-cart-o">库存</van-tabbar-item>
      <van-tabbar-item to="/mine" icon="manager-o">我的</van-tabbar-item>
    </van-tabbar>
  </template>
</template>

<script setup>
import { computed } from 'vue'
import { useRoute } from 'vue-router'

const route = useRoute()
const isTab = computed(() => !!route.meta.tab)
// 二级页（非 tab、非登录）：统一套内边距容器，页面内自带 sub-header
const isSub = computed(() => !route.meta.tab && route.path !== '/login')
const title = computed(() => route.meta.title || '企业台账')
</script>

<style>
* { box-sizing: border-box; margin: 0; padding: 0; }
body { font-family: -apple-system, "PingFang SC", "Microsoft YaHei", sans-serif; background: #f7f8fa; }
.m-header {
  position: sticky; top: 0; z-index: 10;
  display: flex; align-items: center; justify-content: center;
  height: 46px; background: #1989fa; color: #fff; font-weight: 600; font-size: 16px;
}
.m-main { padding: 12px 12px 66px; }
.m-sub { padding-bottom: 24px; }
.card { background: #fff; border-radius: 10px; padding: 14px; margin-bottom: 12px; box-shadow: 0 1px 4px rgba(0,0,0,.04); }
.card-title { font-weight: 600; margin-bottom: 10px; display: flex; align-items: center; gap: 6px; }
.num { text-align: right; }
.muted { color: #969799; font-size: 12px; }
.row { display: flex; align-items: center; gap: 8px; }
.grow { flex: 1; }
</style>
