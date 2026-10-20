<script setup lang="ts">
import { onMounted, ref } from 'vue'
import { useRouter } from 'vue-router'
import { http } from '@/api/http'
import type { PageResult } from '@/api/types'
import { useTodoStore } from '@/stores/todo'
import DateTimeText from '@/components/DateTimeText.vue'

interface NotificationRow {
  id: number
  notifyType: string
  title: string
  content: string
  link?: string
  readAt: string | null
  createdAt: string
}

const TYPE_LABEL: Record<string, string> = { CC: '抄送', SYSTEM: '系统', APPROVAL_RESULT: '审批结果' }

const router = useRouter()
const todo = useTodoStore()
const unreadOnly = ref(false)
const rows = ref<NotificationRow[]>([])
const page = ref(1)
const total = ref(0)
const loading = ref(false)

async function load() {
  loading.value = true
  try {
    const res = await http.get<PageResult<NotificationRow>>('/sys/notifications', { unread: unreadOnly.value || undefined, page: page.value, size: 20 })
    rows.value = res.records
    total.value = res.total
  } finally {
    loading.value = false
  }
}

async function open(n: NotificationRow) {
  if (!n.readAt) {
    await http.post(`/sys/notifications/${n.id}/read`)
    todo.refresh()
  }
  if (n.link) router.push(n.link)
  else load()
}

async function readAll() {
  await http.post('/sys/notifications/read-all')
  todo.refresh()
  load()
}

onMounted(load)
</script>

<template>
  <div class="page">
    <div class="page-card">
      <div class="page-title">
        <h2>通知中心</h2>
        <div class="toolbar">
          <el-switch v-model="unreadOnly" active-text="只看未读" @change="() => ((page = 1), load())" />
          <el-button @click="readAll">全部标为已读</el-button>
        </div>
      </div>
      <el-table v-loading="loading" :data="rows" row-key="id" @row-click="open">
        <el-table-column width="90">
          <template #default="{ row }">
            <el-badge is-dot :hidden="!!row.readAt">
              <el-tag size="small">{{ TYPE_LABEL[row.notifyType] ?? row.notifyType }}</el-tag>
            </el-badge>
          </template>
        </el-table-column>
        <el-table-column label="内容" min-width="300">
          <template #default="{ row }">
            <div :class="{ unread: !row.readAt }">{{ row.title }}</div>
            <div class="muted">{{ row.content }}</div>
          </template>
        </el-table-column>
        <el-table-column label="时间" width="200">
          <template #default="{ row }"><DateTimeText :value="row.createdAt" /></template>
        </el-table-column>
      </el-table>
      <el-pagination v-model:current-page="page" :total="total" :page-size="20" layout="total, prev, pager, next" class="pager" @current-change="load" />
    </div>
  </div>
</template>

<style scoped>
.unread {
  font-weight: 600;
}

.pager {
  margin-top: 12px;
  justify-content: flex-end;
}
</style>
