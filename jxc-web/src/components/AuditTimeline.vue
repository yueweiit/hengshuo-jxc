<script setup lang="ts">
import { onBeforeUnmount, ref, watch } from 'vue'
import { http } from '@/api/http'
import type { PageResult } from '@/api/types'
import DateTimeText from './DateTimeText.vue'

export interface AuditLog {
  id: number
  action: string
  userName: string
  resourceType: string
  resourceId: number
  beforeValue: Record<string, unknown> | null
  afterValue: Record<string, unknown> | null
  reason?: string
  occurredAt: string
}

const props = defineProps<{ resourceType: string; resourceId: number | string }>()
const logs = ref<AuditLog[]>([])
const loading = ref(false)
const loadError = ref('')
const total = ref(0)
let requestSequence = 0

function diff(log: AuditLog) {
  const before = log.beforeValue ?? {}
  const after = log.afterValue ?? {}
  const keys = new Set([...Object.keys(before), ...Object.keys(after)])
  return [...keys]
    .filter((k) => JSON.stringify(before[k]) !== JSON.stringify(after[k]) && !['updatedAt', 'version'].includes(k))
    .map((k) => ({ key: k, from: before[k], to: after[k] }))
}

function show(v: unknown) {
  if (v === undefined || v === null || v === '') return '空'
  return typeof v === 'object' ? JSON.stringify(v) : String(v)
}

async function reload() {
  const sequence = ++requestSequence
  loading.value = true
  loadError.value = ''
  try {
    const res = await http.get<PageResult<AuditLog>>('/sys/audit-logs', {
      resourceType: props.resourceType, resourceId: props.resourceId, size: 100,
    }, { silent: true })
    if (sequence !== requestSequence) return
    if (!res || !Array.isArray(res.records) || !Number.isInteger(res.total) || res.total < res.records.length) {
      throw new Error('操作日志返回格式不正确，请重试')
    }
    logs.value = res.records
    total.value = res.total
  } catch (error) {
    if (sequence !== requestSequence) return
    loadError.value = error instanceof Error && error.message ? error.message : '操作日志读取失败，请重试'
  } finally {
    if (sequence === requestSequence) loading.value = false
  }
}
watch(() => [props.resourceType, props.resourceId], reload, { immediate: true })
onBeforeUnmount(() => { requestSequence++ })
defineExpose({ reload })
</script>

<template>
  <div class="audit-timeline" :aria-busy="loading">
    <div class="audit-toolbar">
      <span v-if="!loading && !loadError" class="muted">
        {{ logs.length < total ? '已显示最近' : '已显示' }} {{ logs.length }} 条，共 {{ total }} 条
      </span>
      <el-button link type="primary" :disabled="loading" @click="reload">刷新日志</el-button>
    </div>
    <p v-if="loading" role="status" class="muted">正在加载操作日志…</p>
    <div v-else-if="loadError" role="alert" class="audit-error">
      <span>操作日志读取失败：{{ loadError }}</span>
      <el-button link type="primary" @click="reload">重试</el-button>
    </div>
    <p v-else-if="!logs.length" class="muted">暂无操作日志</p>
    <div v-if="logs.length" v-show="!loading && !loadError">
    <slot :logs="logs">
    <el-timeline>
      <el-timeline-item v-for="log in logs" :key="log.id">
        <div class="audit-heading">
          <b>{{ log.action }}</b>
          <span>{{ log.userName }}</span>
          <DateTimeText :value="log.occurredAt" />
        </div>
        <div v-if="log.reason" class="muted">原因：{{ log.reason }}</div>
        <ul class="diff">
          <li v-for="d in diff(log)" :key="d.key">
            <span class="mono">{{ d.key }}</span>：{{ show(d.from) }} → {{ show(d.to) }}
          </li>
        </ul>
      </el-timeline-item>
    </el-timeline>
    </slot>
    </div>
    <p v-if="!loading && !loadError && logs.length < total" class="muted">当前仅展示最近 {{ logs.length }} 条操作日志，尚有更早记录。</p>
  </div>
</template>

<style scoped>
.audit-timeline { container-type: inline-size; font-size: 13px; }
.audit-toolbar, .audit-heading { display: flex; flex-wrap: wrap; align-items: center; gap: 4px 12px; }
.audit-toolbar { justify-content: space-between; margin-bottom: 12px; }
.audit-heading { line-height: 1.7; }
.audit-heading > :nth-child(3) { color: var(--el-text-color-secondary); }
.audit-error { display: flex; flex-wrap: wrap; align-items: center; gap: 8px; color: var(--el-color-danger); }
.diff {
  margin: 4px 0 0;
  padding-left: 16px;
  font-size: 13px;
  color: var(--el-text-color-regular);
  word-break: break-all;
}
</style>
