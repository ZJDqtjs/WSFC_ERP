<template>
  <van-field
    v-model="text"
    label="备注"
    type="textarea"
    rows="1"
    autosize
    :placeholder="placeholder"
    maxlength="500"
    @paste="onPaste"
  />
  <div class="attach-bar">
    <van-button size="mini" plain type="primary" icon="plus" :loading="uploading" @click="pick">
      图片 / 附件
    </van-button>
    <span class="attach-tip">支持图片、PDF、Excel 等，可直接粘贴</span>
    <input ref="fileEl" type="file" multiple style="display:none" @change="onFiles" />
  </div>
  <div v-if="files.length" class="attach-chips">
    <div v-for="f in files" :key="f.url" class="attach-chip">
      <span class="ellipsis" @click="open(f)">{{ f.isImage ? '🖼' : '📎' }} {{ f.name }}</span>
      <van-icon name="cross" @click="remove(f.url)" />
    </div>
  </div>
</template>

<script setup>
import { ref, computed } from 'vue'
import { showToast, showImagePreview } from 'vant'
import { parseRemark, uploadToRemark, removeFromRemark } from '../utils/remark'

const props = defineProps({
  modelValue: { type: String, default: '' },
  placeholder: { type: String, default: '可留空' },
})
const emit = defineEmits(['update:modelValue'])

const text = computed({
  get: () => props.modelValue,
  set: (v) => emit('update:modelValue', v),
})

const fileEl = ref(null)
const uploading = ref(false)
const files = computed(() => parseRemark(text.value).filter((s) => s.type === 'file'))

function pick() {
  fileEl.value && fileEl.value.click()
}

async function onFiles(e) {
  const list = Array.from(e.target.files || [])
  e.target.value = ''
  uploadFiles(list)
}

/** 支持在备注栏直接粘贴图片 / 附件；剪贴板无附件时维持默认文本粘贴 */
function onPaste(e) {
  const items = (e.clipboardData && e.clipboardData.items) || []
  const files = []
  for (const it of items) {
    if (it.kind !== 'file') continue
    const f = typeof it.getAsFile === 'function' ? it.getAsFile() : null
    if (f) files.push(f)
  }
  if (files.length) {
    if (e.cancelable) e.preventDefault()   // 有附件：阻止把文件以文本形式插入备注
    uploadFiles(files)
    return
  }
  // 无附件：若剪贴板是本地文件路径文本（资源管理器复制文件 / 「复制为路径」），阻止其污染备注
  const text = (e.clipboardData && typeof e.clipboardData.getData === 'function')
    ? (e.clipboardData.getData('text/plain') || '') : ''
  if (looksLikeLocalPath(text)) {
    if (e.cancelable) e.preventDefault()
    showToast('检测到本地文件路径，已取消写入备注；如需挂附件请点「图片 / 附件」')
  }
}

/** 判断文本是否像本地文件路径（兼容带引号、UNC、file://、Unix 绝对路径） */
function looksLikeLocalPath(s) {
  let t = String(s || '').trim()
  t = t.replace(/^["'“”«»]+/, '').replace(/["'“”«»]+$/, '').trim()
  if (!t) return false
  if (/^(?:[A-Za-z]:[\\/]|\\\\|\/\/|file:\/\/)/i.test(t)) return true
  if (/^\/[^\/\s]/.test(t)) return true
  return /[A-Za-z]:[\\/]/.test(t)
}

async function uploadFiles(list) {
  if (!list.length) return
  uploading.value = true
  try {
    text.value = await uploadToRemark(list, text.value)
    showToast(`已添加 ${list.length} 个附件`)
  } catch (err) {
    showToast('上传失败：' + err.message)
  }
  uploading.value = false
}

function remove(url) {
  text.value = removeFromRemark(text.value, url)
}

function open(f) {
  if (f.isImage) {
    showImagePreview({ images: files.value.filter((x) => x.isImage).map((x) => x.src) })
  } else {
    const a = document.createElement('a')
    a.href = f.src
    a.target = '_blank'
    a.rel = 'noopener'
    a.click()
  }
}
</script>

<style scoped>
.attach-bar { display: flex; align-items: center; gap: 8px; padding: 8px 16px 0; }
.attach-tip { color: #969799; font-size: 12px; }
.attach-chips { display: flex; flex-wrap: wrap; gap: 6px; padding: 8px 16px 10px; }
.attach-chip {
  display: inline-flex; align-items: center; gap: 6px; max-width: 60vw;
  padding: 3px 8px; border: 1px solid #e5e6eb; border-radius: 6px;
  background: #f0f8ff; font-size: 12px; color: #646566;
}
.attach-chip .ellipsis { max-width: 46vw; }
</style>
