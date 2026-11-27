<template>
  <button
    v-if="text"
    type="button"
    class="m-help-btn"
    :aria-label="title || '说明'"
    @click.stop="open"
  >?</button>
</template>

<script setup>
import { showDialog } from 'vant'

const props = defineProps({
  text: { type: String, default: '' },
  title: { type: String, default: '说明' },
})

function open() {
  showDialog({
    title: props.title || '说明',
    message: props.text,
    messageAlign: 'left',
    confirmButtonText: '知道了',
    confirmButtonColor: '#2563eb',
    closeOnClickOverlay: true,
  })
}
</script>

<style scoped>
.m-help-btn {
  display: inline-flex;
  align-items: center;
  justify-content: center;
  width: 18px;
  height: 18px;
  border-radius: 50%;
  border: 1px solid var(--m-border, #e2e8f0);
  background: var(--m-bg-soft, #f8fafc);
  color: var(--m-muted, #64748b);
  font-size: 11px;
  font-weight: 700;
  line-height: 1;
  padding: 0;
  margin-left: 4px;
  cursor: pointer;
  flex-shrink: 0;
  vertical-align: middle;
}
.m-help-btn:active {
  background: var(--m-primary-light, #eff6ff);
  color: var(--m-primary, #2563eb);
  border-color: var(--m-primary, #2563eb);
}
</style>
