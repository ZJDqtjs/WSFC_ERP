<template>
  <!-- 操作员固定为当前登录账号：只读，不允许自行更改（服务端同样以登录账号为准） -->
  <van-field :model-value="modelValue || userName" label="操作员" readonly />
</template>

<script setup>
import { onMounted } from 'vue'
import { userName, ensureUserName } from '../utils/user'

defineProps({
  modelValue: { type: String, default: '' },
})

onMounted(ensureUserName)
</script>
