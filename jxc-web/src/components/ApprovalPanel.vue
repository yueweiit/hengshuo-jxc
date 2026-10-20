<script setup lang="ts">
import { onMounted, ref } from 'vue'
import { http } from '@/api/http'
import StatusTag from './StatusTag.vue'
import DateTimeText from './DateTimeText.vue'

interface ApprovalTaskView {
  id: number
  nodeSeq: number
  nodeName: string
  assigneeName: string
  status: string
  comment?: string
  actedAt?: string
}

export interface ApprovalInstanceView {
  id: number
  status: string
  ruleName: string
  ruleVersionNo: number
  submittedByName: string
  submittedAt: string
  invalidReason?: string
  tasks: ApprovalTaskView[]
}

const props = defineProps<{ docType: string; docId: number | string }>()

const instances = ref<ApprovalInstanceView[]>([])
const loading = ref(false)

async function load() {
  loading.value = true
  try {
    instances.value = await http.get<ApprovalInstanceView[]>('/wf/instances', {
      docType: props.docType,
      docId: props.docId,
    })
  } finally {
    loading.value = false
  }
}

onMounted(load)
defineExpose({ reload: load })
</script>

<template>
  <div v-loading="loading">
    <el-empty v-if="!instances.length" :image-size="48" description="暂无审批记录" />
    <div v-for="ins in instances" :key="ins.id" class="instance">
      <div class="head">
        <StatusTag :status="ins.status" />
        <span>{{ ins.ruleName }} · v{{ ins.ruleVersionNo }}</span>
        <span class="muted">{{ ins.submittedByName }} 提交于 <DateTimeText :value="ins.submittedAt" /></span>
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
      <el-steps direction="vertical" :active="ins.tasks.filter((t) => t.status !== 'PENDING').length" class="steps">
        <el-step v-for="task in ins.tasks" :key="task.id" :title="`${task.nodeName} · ${task.assigneeName}`">
          <template #description>
            <StatusTag :status="task.status" />
            <span v-if="task.actedAt" class="muted"> <DateTimeText :value="task.actedAt" /></span>
            <div v-if="task.comment">{{ task.comment }}</div>
          </template>
        </el-step>
      </el-steps>
    </div>
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
</style>
