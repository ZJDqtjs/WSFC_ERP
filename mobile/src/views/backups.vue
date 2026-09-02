<template>
  <div>
    <header class="b-header">
      <span class="back" @click="$router.back()">←</span>
      <span>备份与恢复</span>
    </header>

    <div class="card">
      <div class="card-title">自动备份</div>
      <van-cell title="开启自动备份" center>
        <template #right-icon><van-switch v-model="enabled" size="20" /></template>
      </van-cell>
      <div class="set-row">
        <span class="muted">备份间隔（小时）</span>
        <van-stepper v-model="interval" min="0.5" step="0.5" integer :max="72" />
      </div>
      <div class="set-row">
        <span class="muted">保留份数</span>
        <van-stepper v-model="keep" min="1" :max="100" />
      </div>
      <van-button block round type="primary" :loading="savingCfg" @click="saveCfg">保存备份配置</van-button>
    </div>

    <div class="card">
      <div class="card-title">手动备份</div>
      <van-button block round type="success" :loading="backingUp" @click="doBackup">立即备份</van-button>
    </div>

    <div class="card">
      <div class="card-title">备份列表</div>
      <div v-if="!list.length" class="empty">暂无备份</div>
      <div v-for="b in list" :key="b.name" class="bk-item">
        <div class="row">
          <span class="grow bk-name">{{ b.mtime }}</span>
          <span class="muted">{{ b.size_human }}</span>
        </div>
        <div class="row" style="margin-top:8px;gap:6px;">
          <van-button size="mini" type="warning" plain @click="restore(b)">恢复</van-button>
          <van-button size="mini" type="danger" plain @click="del(b)">删除</van-button>
        </div>
      </div>
    </div>
  </div>
</template>

<script setup>
import { ref, onMounted } from 'vue'
import { showToast, showConfirmDialog } from 'vant'
import api from '../api'

const enabled = ref(true), interval = ref(2), keep = ref(30)
const savingCfg = ref(false), backingUp = ref(false)
const list = ref([])

async function load() {
  try {
    const d = await api('/api/backups')
    const c = d.config || {}
    enabled.value = !!c.enabled
    interval.value = c.interval_hours || 2
    keep.value = c.keep || 30
    list.value = d.backups || []
  } catch (e) { showToast('加载失败') }
}
async function saveCfg() {
  savingCfg.value = true
  try {
    await api('/api/backup/config', 'POST', { enabled: enabled.value, interval_hours: interval.value, keep: keep.value })
    showToast('已保存')
  } catch (e) { showToast(e.message || '保存失败') }
  savingCfg.value = false
}
async function doBackup() {
  backingUp.value = true
  try {
    const r = await api('/api/backup', 'POST')
    list.value = r.backups || []
    showToast('备份成功')
  } catch (e) { showToast(e.message || '备份失败') }
  backingUp.value = false
}
async function restore(b) {
  try {
    await showConfirmDialog({ title: '恢复备份', message: `将用 ${b.mtime} 的备份覆盖当前数据，确认？` })
  } catch (e) { return }
  try {
    await api('/api/backup/restore', 'POST', { name: b.name })
    showToast('恢复成功')
  } catch (e) { showToast(e.message || '恢复失败') }
}
async function del(b) {
  try {
    await showConfirmDialog({ title: '删除备份', message: `确认删除 ${b.mtime}？` })
  } catch (e) { return }
  try {
    const r = await api(`/api/backup/${b.name}`, 'DELETE')
    list.value = r.backups || list.value.filter((x) => x.name !== b.name)
    showToast('已删除')
  } catch (e) { showToast(e.message || '删除失败') }
}
onMounted(load)
</script>

<style scoped>
.b-header { display: flex; align-items: center; gap: 8px; height: 46px; background: #1989fa; color: #fff; font-weight: 600; font-size: 16px; padding: 0 12px; margin: -12px -12px 12px; }
.back { cursor: pointer; font-size: 18px; }
.set-row { display: flex; align-items: center; justify-content: space-between; padding: 10px 0; }
.empty { color: #969799; text-align: center; padding: 16px 0; }
.bk-item { padding: 10px 0; border-bottom: 1px solid #f5f5f5; }
.bk-item:last-child { border-bottom: none; }
.bk-name { font-weight: 600; }
</style>