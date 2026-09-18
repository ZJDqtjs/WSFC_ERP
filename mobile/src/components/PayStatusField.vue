<!-- 付款状态：已付款（默认）/ 待付款。待付款的单据先进入「待付款账单」，点「已支付」后才纳入财务报表 -->
<template>
  <van-field :label="label">
    <template #input>
      <van-radio-group v-model="status" direction="horizontal">
        <van-radio name="paid">已付款</van-radio>
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
})
const emit = defineEmits(['update:modelValue'])
const status = computed({
  get: () => (props.modelValue === 'unpaid' ? 'unpaid' : 'paid'),
  set: (v) => emit('update:modelValue', v),
})
</script>

<style scoped>
.pay-hint { padding: 0 16px 8px; font-size: 12px; color: #969799; line-height: 1.5; }
</style>
