<!-- 付款状态：已付款（默认）/ 待付款；allow-partial 时多一档「部分付款」（仅入库单支持） -->
<template>
  <van-field>
    <template #label>
      <span class="pay-lbl">{{ label }}<HelpTip v-if="hint" :text="hint" title="付款状态说明" /></span>
    </template>
    <template #input>
      <van-radio-group v-model="status" direction="horizontal">
        <van-radio name="paid">已付款</van-radio>
        <van-radio v-if="allowPartial" name="partial" style="margin-left:10px;">部分付款</van-radio>
        <van-radio name="unpaid" style="margin-left:10px;">待付款</van-radio>
      </van-radio-group>
    </template>
  </van-field>
</template>

<script setup>
import { computed } from 'vue'

const props = defineProps({
  modelValue: { type: String, default: 'paid' },
  label: { type: String, default: '付款状态' },
  hint: { type: String, default: '' },
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
.pay-lbl { display: inline-flex; align-items: center; }
</style>
