<template>
  <header class="s-header">
    <span class="back" @click="$router.back()">←</span>
    <span class="grow">{{ title }}</span>
    <slot name="right" />
  </header>
</template>

<script setup>
defineProps({ title: { type: String, default: '' } })
</script>

<style scoped>
.s-header {
  display: flex; align-items: center; gap: 8px;
  height: 46px; background: #1989fa; color: #fff; font-weight: 600; font-size: 16px;
  padding: 0 12px; margin: -12px -12px 12px;
  position: sticky; top: 0; z-index: 20;
}
.back { cursor: pointer; font-size: 18px; }
.grow { flex: 1; }
</style>
