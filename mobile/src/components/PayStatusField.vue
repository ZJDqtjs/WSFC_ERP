<!-- 付款状态：已付款（默认）/ 待付款；allow-partial 时多一档「部分付款」（仅入库单支持） -->
<template>
  <van-field :label="label">
    <template #input>
      <van-radio-group v-model="status" direction="horizontal">
        <van-radio name="paid">已付款</van-radio>
        <van-radio v-if="allowPartial" name="partial" style="margin-left:12px;">部分付款</van-radio>
        <van-radio name="unpaid" style="margin-left:12px;">待付款</van-radio>
      </van-radio-group>
    </template>
  </van-field>
  <div v-if="hint" class="pay-hint">{{ hint }}</div>
</template>

<script setup>
import { computed } from 'vue'

const props = defineProps({
  modelValue: { type: String, default: 'paid' },
  label: { type: String, default: '付款状态' },
  hint: { type: String, default: '' },
  // 部分付款只有入库单支持：已付部分计入报表，未付余额留在待付款账单
  allowPartial: { type: Boolean, default: false },
})
const emit = defineEmits(['update:modelValue'])
const status = computed({
  get: () => {
    const v = props.modelValue || 'paid'
    if (v === 'partial') return props.allowPartial ? 'partial' : 'unpaid'
    return v === 'unpaid' ? 'unpaid' : 'paid'
  },
  set: (v) => emit('update:modelValue', v),
})
</script>

<style scoped>
.pay-hint { padding: 0 16px 8px; font-size: 12px; color: #969799; line-height: 1.5; }
</style>
