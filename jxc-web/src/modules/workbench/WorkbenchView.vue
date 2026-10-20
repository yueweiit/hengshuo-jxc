<script setup lang="ts">
import { computed, onBeforeUnmount, onMounted, ref } from 'vue'
import { useRouter } from 'vue-router'
import { http } from '@/api/http'
import type { PageResult } from '@/api/types'
import { useCountryStore } from '@/stores/country'
import { useTodoStore } from '@/stores/todo'
import { useUserStore } from '@/stores/user'
import DateTimeText from '@/components/DateTimeText.vue'
import { formatDateTime } from '@/utils/format'

interface TodoRow {
  id: number
  todoType: string
  typeLabel: string
  title: string
  link: string
  createdAt: string
}

interface NotificationRow {
  id: number
  title: string
  content: string
  link?: string
  readAt: string | null
  createdAt: string
}

const router = useRouter()
const country = useCountryStore()
const todo = useTodoStore()
const user = useUserStore()

const activeType = ref<string>('')
const todos = ref<TodoRow[]>([])
const notifications = ref<NotificationRow[]>([])
const loading = ref(false)
const now = ref(new Date().toISOString())

const noCountry = computed(() => !country.current)
const noRole = computed(() => !!country.current && user.permissions.length === 0)

async function loadTodos() {
  loading.value = true
  try {
    const res = await http.get<PageResult<TodoRow>>('/sys/todos', { type: activeType.value || undefined, size: 20 })
    todos.value = res.records
  } finally {
    loading.value = false
  }
}

async function loadNotifications() {
  const res = await http.get<PageResult<NotificationRow>>('/sys/notifications', { unread: true, size: 5 })
  notifications.value = res.records
}

function openCard(item: { type: string; link: string }) {
  if (item.type === 'APPROVAL' || item.type === 'CONFIG_MISSING') {
    router.push(item.link)
    return
  }
  activeType.value = activeType.value === item.type ? '' : item.type
  loadTodos()
}

async function openNotification(n: NotificationRow) {
  await http.post(`/sys/notifications/${n.id}/read`)
  todo.refresh()
  if (n.link) router.push(n.link)
  else loadNotifications()
}

let timer: ReturnType<typeof setInterval> | undefined
onMounted(() => {
  if (noCountry.value || noRole.value) return
  loadTodos()
  loadNotifications()
  timer = setInterval(() => (now.value = new Date().toISOString()), 30_000)
})
onBeforeUnmount(() => clearInterval(timer))
</script>

<template>
  <div class="page">
    <div v-if="noCountry || noRole" class="page-card">
      <el-empty :description="noCountry ? '你的账号还没有被分配到任何国家' : `你在${country.current?.name}还没有被分配角色`">
        <p class="muted">请联系平台管理员或国家管理员在「系统设置 → 用户与授权」中为你分配国家、角色和数据范围。</p>
      </el-empty>
    </div>

    <template v-else>
      <div class="page-card country-bar">
        <div>
          <strong>{{ country.current?.name }}</strong>
          <el-tag v-if="country.current?.isTest" type="warning" size="small" class="ml">测试国家</el-tag>
          <el-tag v-if="country.current?.status === 'DRAFT'" type="info" size="small" class="ml">草稿（未启用）</el-tag>
        </div>
        <div class="muted">
          币种 {{ country.currency }} · 当地时间 {{ formatDateTime(now, country.timezone) }}
        </div>
      </div>

      <div class="cards">
        <div
          v-for="item in todo.summary"
          :key="item.type"
          class="card"
          :class="{ active: activeType === item.type, alert: item.type === 'CONFIG_MISSING' || item.type === 'OUTBOUND_BLOCKED' }"
          @click="openCard(item)"
        >
          <div class="count">{{ item.count }}</div>
          <div class="label">{{ item.label }}</div>
        </div>
        <el-empty v-if="!todo.summary.length" description="当前没有待办" :image-size="60" class="cards-empty" />
      </div>

      <el-row :gutter="12">
        <el-col :xs="24" :md="15">
          <div class="page-card">
            <div class="page-title">
              <h2>待办事项</h2>
              <el-tag v-if="activeType" closable @close="openCard({ type: activeType, link: '' })">
                {{ todo.summary.find((i) => i.type === activeType)?.label }}
              </el-tag>
            </div>
            <el-table v-loading="loading" :data="todos" :show-header="false" empty-text="没有待办">
              <el-table-column min-width="240">
                <template #default="{ row }">
                  <el-link type="primary" @click="router.push(row.link)">{{ row.title }}</el-link>
                  <div class="muted small">{{ row.typeLabel }} · <DateTimeText :value="row.createdAt" /></div>
                </template>
              </el-table-column>
            </el-table>
          </div>
        </el-col>
        <el-col :xs="24" :md="9">
          <div class="page-card">
            <div class="page-title">
              <h2>未读通知</h2>
              <el-button link type="primary" @click="router.push('/notifications')">全部</el-button>
            </div>
            <el-empty v-if="!notifications.length" description="没有未读通知" :image-size="60" />
            <div v-for="n in notifications" :key="n.id" class="notice" @click="openNotification(n)">
              <div class="notice-title">{{ n.title }}</div>
              <div class="muted small">{{ n.content }}</div>
              <div class="muted small"><DateTimeText :value="n.createdAt" /></div>
            </div>
          </div>
        </el-col>
      </el-row>
    </template>
  </div>
</template>

<style scoped lang="scss">
.country-bar {
  display: flex;
  justify-content: space-between;
  align-items: center;
  flex-wrap: wrap;
  gap: 8px;
}

.ml {
  margin-left: 8px;
}

.cards {
  display: grid;
  grid-template-columns: repeat(auto-fill, minmax(150px, 1fr));
  gap: 12px;
  margin-bottom: 12px;
}

.cards-empty {
  grid-column: 1 / -1;
  background: #fff;
  border-radius: 6px;
  padding: 8px;
}

.card {
  background: #fff;
  border-radius: 6px;
  padding: 14px 16px;
  cursor: pointer;
  border: 1px solid transparent;
  transition: border-color 0.15s;

  &:hover,
  &.active {
    border-color: var(--el-color-primary);
  }

  &.alert .count {
    color: var(--el-color-danger);
  }

  .count {
    font-size: 26px;
    font-weight: 600;
    color: var(--el-color-primary);
  }

  .label {
    color: var(--el-text-color-regular);
    font-size: 13px;
  }
}

.small {
  font-size: 12px;
}

.notice {
  padding: 8px 0;
  border-bottom: 1px solid var(--el-border-color-lighter);
  cursor: pointer;

  &:last-child {
    border-bottom: none;
  }
}

.notice-title {
  font-weight: 500;
}
</style>
