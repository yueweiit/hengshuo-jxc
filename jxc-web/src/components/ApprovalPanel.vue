<script setup lang="ts">
import { feedbackMessage } from '@/api/error-feedback'
import { onBeforeUnmount, onMounted, ref } from 'vue'
import { http } from '@/api/http'
import StatusTag from './StatusTag.vue'
import DateTimeText from './DateTimeText.vue'
import { statusDef } from '@/utils/status'

interface ApprovalTaskView {
  id: number
  nodeSeq: number
  nodeName: string
  assigneeName: string
  status: string
  comment?: string | null
  actedAt?: string | null
}

export interface ApprovalInstanceView {
  id: number
  status: string
  ruleName: string
  ruleVersionNo: number
  submittedByName: string
  submittedAt: string | null
  finishedAt?: string | null
  invalidReason?: string
  tasks: ApprovalTaskView[]
}

const props = defineProps<{ docType: string; docId: number | string; presentation?: 'steps' | 'timeline' }>()

interface TimelineItem {
  key: string
  title?: string | null
  content: string
  actor?: string
  actorLabel?: string
  status?: string
  domain?: string
  comment?: string | null
  type: ReturnType<typeof statusDef>['type']
  emptyTime: string
}

function timelineItems(instance: ApprovalInstanceView): TimelineItem[] {
  const items: TimelineItem[] = [{
    key: `submit:${instance.id}`, title: instance.submittedAt, content: '提交审批',
    actor: instance.submittedByName, actorLabel: '提交人', type: 'primary', emptyTime: '提交时间未记录',
  }, ...instance.tasks.map(task => ({
    key: `task:${task.id}`, title: task.actedAt, content: task.nodeName,
    actor: task.assigneeName, actorLabel: '审批人', status: task.status, comment: task.comment,
    type: statusDef(task.status).type,
    emptyTime: task.status === 'PENDING' ? '尚未处理' : task.status === 'SKIPPED' ? '无需处理' : '处理时间未记录',
  }))]
  if (['APPROVED', 'REJECTED', 'WITHDRAWN', 'INVALIDATED'].includes(instance.status)) {
    items.push({
      key: `finish:${instance.id}`, title: instance.finishedAt, content: '审批流程结束',
      status: instance.status, domain: 'approvalDoc', type: statusDef(instance.status).type,
      emptyTime: '结束时间未记录',
    })
  }
  return items
}

const instances = ref<ApprovalInstanceView[]>([])
const loading = ref(false)
const loadError = ref('')
let requestId = 0
let disposed = false

async function load() {
  if (disposed) return
  const request = ++requestId
  loading.value = true
  loadError.value = ''
  try {
    const result = await http.get<ApprovalInstanceView[]>('/wf/instances', {
      docType: props.docType,
      docId: props.docId,
    }, { silent: props.presentation === 'timeline' })
    if (!disposed && request === requestId) instances.value = result
  } catch (error) {
    if (disposed || request !== requestId) return
    // 旧入口继续将读取错误交给调用方；时间轴入口负责就地错误与重试。
    if (props.presentation !== 'timeline') throw error
    instances.value = []
    loadError.value = feedbackMessage(error, "审批记录读取失败，请重试")
  } finally {
    if (!disposed && request === requestId) loading.value = false
  }
}

onMounted(load)
onBeforeUnmount(() => { disposed = true; requestId++ })
defineExpose({ reload: load })
</script>

<template>
  <div v-loading="props.presentation !== 'timeline' && loading" class="approval-panel">
    <div v-if="props.presentation === 'timeline' && loading" class="history-loading" role="status" aria-busy="true">
      <el-skeleton :rows="3" animated /><p class="muted">正在加载审批记录…</p>
    </div>
    <div v-else-if="props.presentation === 'timeline' && loadError" class="history-error" role="alert">
      <div  class="request-state" role="status"><p class="muted">尚未加载成功</p></div>
      <el-button @click="load">重新加载记录</el-button>
    </div>
    <el-empty v-else-if="!instances.length" :image-size="48" description="暂无审批记录" />
    <template v-else>
    <div v-for="ins in instances" :key="ins.id" class="instance" :class="{ 'timeline-instance': props.presentation === 'timeline' }">
      <div class="head">
        <StatusTag :status="ins.status" />
        <span>{{ ins.ruleName }} · v{{ ins.ruleVersionNo }}</span>
        <span v-if="props.presentation !== 'timeline'" class="muted">{{ ins.submittedByName }} 提交于 <DateTimeText :value="ins.submittedAt" /></span>
      </div>
      <el-alert
        v-if="ins.status === 'INVALIDATED'"
        type="error"
        :closable="false"
        show-icon
        :title="`审批已失效：${ins.invalidReason ?? '单据关键字段已改变'}，需重新提交`"
      />
      <el-alert
        v-if="ins.status === 'BLOCKED'"
        type="warning"
        :closable="false"
        show-icon
        title="没有匹配的审批规则或可用审批人，已生成配置待办，不会自动通过"
      />
      <el-timeline v-if="props.presentation === 'timeline'" class="approval-timeline" aria-label="审批事件时间轴">
        <el-timeline-item v-for="item in timelineItems(ins)" :key="item.key" :type="item.type" :hollow="item.status === 'PENDING'">
          <div class="timeline-time"><DateTimeText v-if="item.title" :value="item.title" /><span v-else>{{ item.emptyTime }}</span></div>
          <div class="timeline-event">
            <div class="event-title"><strong>{{ item.content }}</strong><StatusTag v-if="item.status" :status="item.status" :domain="item.domain" /></div>
            <p v-if="item.actor" class="event-actor">{{ item.actorLabel }}：{{ item.actor }}</p>
            <p v-if="item.comment" class="event-comment">{{ item.comment }}</p>
          </div>
        </el-timeline-item>
      </el-timeline>
      <el-steps v-else direction="vertical" :active="ins.tasks.filter((t) => t.status !== 'PENDING').length" class="steps">
        <el-step v-for="task in ins.tasks" :key="task.id" :title="`${task.nodeName} · ${task.assigneeName}`">
          <template #description>
            <StatusTag :status="task.status" />
            <span v-if="task.actedAt" class="muted"> <DateTimeText :value="task.actedAt" /></span>
            <div v-if="task.comment">{{ task.comment }}</div>
          </template>
        </el-step>
      </el-steps>
    </div>
    </template>
  </div>
</template>

<style scoped>
.instance + .instance {
  margin-top: 16px;
  padding-top: 16px;
  border-top: 1px dashed var(--el-border-color);
}

.head {
  display: flex;
  align-items: center;
  gap: 8px;
  flex-wrap: wrap;
  margin-bottom: 8px;
}

.steps {
  margin-top: 8px;
}

.timeline-instance + .timeline-instance { border-top-style: solid; margin-top: 24px; padding-top: 24px; }
.timeline-instance .head { gap: 8px; margin-bottom: 22px; font-size: 13px; }
.timeline-instance :deep(.el-alert) { margin-bottom: 20px; }
.approval-timeline { margin: 0; padding: 0; }
.approval-timeline :deep(.el-timeline-item) { padding-bottom: 24px; }
.approval-timeline :deep(.el-timeline-item__wrapper) { display: grid; grid-template-columns: 132px minmax(0, 1fr); column-gap: 42px; padding-left: 0; top: 0; }
.approval-timeline :deep(.el-timeline-item__content) { display: contents; }
.approval-timeline :deep(.el-timeline-item__node) { left: 148px; top: 5px; width: 10px; height: 10px; }
.approval-timeline :deep(.el-timeline-item__tail) { left: 152px; top: 5px; border-left-width: 1px; }
.approval-timeline :deep(.el-timeline-item:last-child) { padding-bottom: 0; }
.timeline-time { text-align: right; font-family: ui-monospace, SFMono-Regular, Menlo, monospace; font-size: 12px; line-height: 1.7; color: var(--el-text-color-secondary); overflow-wrap: anywhere; }
.timeline-event { min-width: 0; font-size: 13px; line-height: 1.7; overflow-wrap: anywhere; }
.event-title { display: flex; flex-wrap: wrap; align-items: center; gap: 8px; }
.event-title strong { font-weight: 600; color: var(--el-text-color-primary); }
.event-actor { margin: 3px 0 0; color: var(--el-text-color-secondary); font-size: 12px; }
.event-comment { margin: 7px 0 0; white-space: pre-wrap; color: var(--el-text-color-regular); }
.history-loading { padding: 8px 0; }
.history-error .el-button { margin-top: 12px; }
.history-error p { margin: 0; overflow-wrap: anywhere; }
@media (max-width: 520px) {
  .approval-timeline :deep(.el-timeline-item__wrapper) { display: block; margin-left: 24px; }
  .approval-timeline :deep(.el-timeline-item__node) { left: 0; }
  .approval-timeline :deep(.el-timeline-item__tail) { left: 4px; }
  .timeline-time { margin-bottom: 5px; text-align: left; }
}
</style>
