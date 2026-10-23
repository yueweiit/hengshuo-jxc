<script setup lang="ts">
import { computed, onBeforeUnmount, ref, watch } from 'vue'
import { http } from '@/api/http'
import type { PageResult } from '@/api/types'
import DateTimeText from './DateTimeText.vue'
import StatusTag from './StatusTag.vue'

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

export interface AuditCell { text: string; status?: string }
export interface AuditChange { label: string; from: AuditCell; to: AuditCell }
export interface AuditEntry {
  title: string
  isCreate: boolean
  summary: string[]
  status?: string
  changes: AuditChange[]
  other: AuditChange[]
  notes: string[]
  originalAction?: string
}
export type AuditPresentation = (log: AuditLog) => AuditEntry

const props = defineProps<{ resourceType: string; resourceId: number | string; presentation?: AuditPresentation }>()
const logs = ref<AuditLog[]>([])
const loading = ref(false)
const loadError = ref('')
const total = ref(0)
const entries = computed(() => logs.value.map(log => ({ log, view: props.presentation?.(log) })))
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
    <el-timeline v-else>
      <el-timeline-item v-for="entry in entries" :key="entry.log.id">
        <div class="audit-heading">
          <b>{{ entry.view ? entry.view.title : entry.log.action }}</b>
          <span>{{ entry.log.userName }}</span>
          <DateTimeText :value="entry.log.occurredAt" />
          <StatusTag v-if="entry.view?.status" :status="entry.view.status" />
        </div>
        <div v-if="entry.log.reason" class="muted">原因：{{ entry.log.reason }}</div>
        <template v-if="entry.view">
          <p v-for="text in entry.view.summary" :key="text" class="audit-summary">{{ text }}</p>
          <details v-if="entry.view.changes.length" class="audit-details">
            <summary>{{ entry.view.isCreate ? '查看单据与商品明细' : `查看变更（${entry.view.changes.length} 项）` }}</summary>
            <table class="audit-table" :class="{ 'audit-table--create': entry.view.isCreate }">
              <caption class="audit-caption">{{ entry.view.isCreate ? '创建时记录的内容' : '本次操作的业务变更' }}</caption>
              <thead><tr><th>变更内容</th><th v-if="!entry.view.isCreate">修改前</th><th>{{ entry.view.isCreate ? '记录内容' : '修改后' }}</th></tr></thead>
              <tbody>
                <tr v-for="(change, index) in entry.view.changes" :key="index">
                  <th scope="row">{{ change.label }}</th>
                  <td v-if="!entry.view.isCreate" data-label="修改前"><StatusTag v-if="change.from.status" :status="change.from.status" /><span v-else>{{ change.from.text }}</span></td>
                  <td :data-label="entry.view.isCreate ? '记录内容' : '修改后'"><StatusTag v-if="change.to.status" :status="change.to.status" /><span v-else>{{ change.to.text }}</span></td>
                </tr>
              </tbody>
            </table>
          </details>
          <details v-if="entry.view.other.length || entry.view.originalAction" class="audit-details">
            <summary>其他变更与原始动作</summary>
            <p v-if="entry.view.originalAction" class="muted">动作码：<span class="mono">{{ entry.view.originalAction }}</span></p>
            <dl class="audit-other">
              <template v-for="(change, index) in entry.view.other" :key="index">
                <dt>{{ change.label }}</dt>
                <dd>{{ entry.view.isCreate ? change.to.text : `${change.from.text} → ${change.to.text}` }}</dd>
              </template>
            </dl>
          </details>
          <p v-for="note in entry.view.notes" :key="note" class="muted audit-note">{{ note }}</p>
          <p v-if="!entry.view.isCreate && !entry.view.changes.length && !entry.view.other.length && !entry.view.notes.length" class="muted">未记录业务字段变化</p>
        </template>
        <ul v-else class="diff">
          <li v-for="d in diff(entry.log)" :key="d.key">
            <span class="mono">{{ d.key }}</span>：{{ show(d.from) }} → {{ show(d.to) }}
          </li>
        </ul>
      </el-timeline-item>
    </el-timeline>
    <p v-if="!loading && !loadError && logs.length < total" class="muted">当前仅展示最近 {{ logs.length }} 条操作日志，尚有更早记录。</p>
  </div>
</template>

<style scoped>
.audit-timeline { container-type: inline-size; font-size: 13px; }
.audit-toolbar, .audit-heading { display: flex; flex-wrap: wrap; align-items: center; gap: 4px 12px; }
.audit-toolbar { justify-content: space-between; margin-bottom: 12px; }
.audit-heading { line-height: 1.7; }
.audit-heading > :nth-child(3) { color: var(--el-text-color-secondary); }
.audit-summary, .audit-note { margin: 4px 0; line-height: 1.6; overflow-wrap: anywhere; }
.audit-error { display: flex; flex-wrap: wrap; align-items: center; gap: 8px; color: var(--el-color-danger); }
.audit-details { margin-top: 6px; }
.audit-details > summary { cursor: pointer; color: var(--el-color-primary); padding: 3px 0; }
.audit-table { width: 100%; border-collapse: collapse; table-layout: fixed; font-size: 13px; margin-top: 4px; }
.audit-table th, .audit-table td { border: 1px solid var(--el-border-color-lighter); padding: 4px 8px; line-height: 23px; text-align: left; vertical-align: top; overflow-wrap: anywhere; }
.audit-table thead { background: var(--el-fill-color-light); }
.audit-table tbody th { font-weight: 400; }
.audit-table tbody tr:nth-child(odd) { background: var(--el-bg-color); }
.audit-table tbody tr:nth-child(even) { background: var(--el-fill-color-light); }
.audit-caption { text-align: left; color: var(--el-text-color-secondary); padding: 3px 0; }
.audit-other { margin: 4px 0; overflow-wrap: anywhere; }
.audit-other dt { color: var(--el-text-color-secondary); }
.audit-other dd { margin: 2px 0 6px 12px; }
@container (max-width: 480px) {
  .audit-table, .audit-table tbody { display: block; }
  .audit-table thead { display: none; }
  .audit-table tr { display: grid; grid-template-columns: 1fr 1fr; }
  .audit-table tbody th { grid-column: 1 / -1; font-weight: 500; }
  .audit-table td::before { display: block; content: attr(data-label); color: var(--el-text-color-secondary); font-size: 12px; }
  .audit-table--create td { grid-column: 1 / -1; }
}
.diff {
  margin: 4px 0 0;
  padding-left: 16px;
  font-size: 13px;
  color: var(--el-text-color-regular);
  word-break: break-all;
}
</style>
