<script setup lang="ts">
import { onMounted, ref } from 'vue'
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

onMounted(async () => {
  const res = await http.get<PageResult<AuditLog>>('/sys/audit-logs', {
    resourceType: props.resourceType,
    resourceId: props.resourceId,
    size: 100,
  })
  logs.value = res.records
})
</script>

<template>
  <el-empty v-if="!logs.length" :image-size="48" description="暂无操作日志" />
  <el-timeline v-else>
    <el-timeline-item v-for="log in logs" :key="log.id">
      <div>
        <b>{{ log.action }}</b> · {{ log.userName }} · <DateTimeText :value="log.occurredAt" />
      </div>
      <div v-if="log.reason" class="muted">原因：{{ log.reason }}</div>
      <ul class="diff">
        <li v-for="d in diff(log)" :key="d.key">
          <span class="mono">{{ d.key }}</span>：{{ show(d.from) }} → {{ show(d.to) }}
        </li>
      </ul>
    </el-timeline-item>
  </el-timeline>
</template>

<style scoped>
.diff {
  margin: 4px 0 0;
  padding-left: 16px;
  font-size: 13px;
  color: var(--el-text-color-regular);
  word-break: break-all;
}
</style>
