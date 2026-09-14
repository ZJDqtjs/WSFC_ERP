<template>
  <div class="remark-view">
    <template v-for="(s, i) in segments" :key="i">
      <span v-if="s.type === 'text'" class="remark-text">{{ s.text.trim() }}</span>
      <img v-else-if="s.isImage" :src="s.src" class="remark-thumb" @click="openImage(s)" />
      <a v-else class="remark-file" @click.prevent="openFile(s)">
        <van-icon name="description" /> {{ s.name }}
      </a>
    </template>
  </div>
</template>

<script setup>
import { computed } from 'vue'
import { showImagePreview } from 'vant'
import { parseRemark } from '../utils/remark'

const props = defineProps({
  remark: { type: String, default: '' },
})

const segments = computed(() => parseRemark(props.remark))
const images = computed(() => segments.value.filter((s) => s.isImage).map((s) => s.src))

function openImage(s) {
  showImagePreview({ images: images.value, startPosition: images.value.indexOf(s.src) })
}

function openFile(s) {
  const a = document.createElement('a')
  a.href = s.src
  a.target = '_blank'
  a.rel = 'noopener'
  a.click()
}
</script>

<style scoped>
.remark-view { margin-top: 3px; line-height: 1.6; }
.remark-text { color: var(--c-muted); font-size: 12px; }
.remark-thumb { height: 40px; border-radius: 4px; margin: 2px 4px 0 0; vertical-align: middle; border: 1px solid var(--c-line-2); }
.remark-file { display: inline-flex; align-items: center; gap: 2px; color: var(--c-primary); font-size: 12px; margin-right: 6px; }
</style>
