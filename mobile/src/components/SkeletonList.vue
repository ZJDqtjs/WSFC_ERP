<template>
  <!-- 列表首屏占位：比"暂无数据"更准确，避免数据未回来时误判为没数据 -->
  <div class="sk-list">
    <van-skeleton v-for="i in rows" :key="i" title :row="1" class="sk-row" />
  </div>
</template>

<script setup>
defineProps({
  /** 展示几条占位行 */
  rows: { type: Number, default: 3 },
})
</script>

<style scoped>
.sk-row { padding: 10px 0; border-bottom: 1px solid var(--c-hairline, #f5f5f5); }
.sk-row:last-child { border-bottom: none; }
</style>
