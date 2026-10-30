<script setup lang="ts">
import { feedbackMessage } from '@/api/error-feedback'
import { computed, onBeforeUnmount, onMounted, ref } from 'vue'
import { ElMessage } from 'element-plus'
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
const sizeOptions = [10, 20, 50]
const sizeKey = 'jxc.workbench.page-size'

function readPageSize() {
  try {
    const saved = Number(localStorage.getItem(sizeKey))
    return sizeOptions.includes(saved) ? saved : 10
  } catch {
    // Storage is optional: the explicit default remains 10 rows per page.
    return 10
  }
}

const page = ref(1)
const size = ref(readPageSize())
const total = ref(0)
const query = ref('')
const order = ref<'asc' | 'desc'>('desc')
const activeType = ref('')
const todos = ref<TodoRow[]>([])
const notifications = ref<NotificationRow[]>([])
const loading = ref(false)
const noticesLoading = ref(false)
const refreshing = ref(false)
const readingNotice = ref(false)
const todoError = ref('')
const noticeError = ref('')
const summaryError = ref('')
const now = ref(new Date().toISOString())
const compact = ref(false)

const noCountry = computed(() => !country.current)
const noRole = computed(() => !!country.current && user.permissions.length === 0)
const shortcuts = computed(() => [
  { path: '/approval/todo', title: '审批待办', description: '待审业务单据', icon: 'Finished' },
  { path: '/notifications', title: '通知中心', description: '抄送、审批结果与系统消息', icon: 'Bell' },
  ...(user.hasPerm(['sys:export:view', 'fin:report:export'])
    ? [{ path: '/jobs', title: '导出任务', description: '导出记录与文件', icon: 'Download' }] : []),
])

let todoRequest = 0
let noticeRequest = 0
let disposed = false
function current(epoch: number) { return !disposed && country.epoch === epoch }


async function loadTodos() {
  const request = ++todoRequest
  const epoch = country.epoch
  loading.value = true
  todoError.value = ''
  try {
    const res = await http.get<PageResult<TodoRow>>('/sys/todos', {
      type: activeType.value || undefined,
      keyword: query.value.trim() || undefined,
      order: order.value,
      page: page.value,
      size: size.value,
    }, { silent: true })
    if (!current(epoch) || request !== todoRequest) return
    const lastPage = Math.max(1, Math.ceil(res.total / size.value))
    if (page.value > lastPage) {
      page.value = lastPage
      await loadTodos()
      return
    }
    todos.value = res.records
    total.value = res.total
  } catch (error) {
    if (!current(epoch) || request !== todoRequest) return
    todos.value = []
    total.value = 0
    todoError.value = feedbackMessage(error, '待办加载失败，请重试')
  } finally {
    if (current(epoch) && request === todoRequest) loading.value = false
  }
}

async function loadNotifications() {
  const request = ++noticeRequest
  const epoch = country.epoch
  noticesLoading.value = true
  noticeError.value = ''
  try {
    const res = await http.get<PageResult<NotificationRow>>('/sys/notifications', { unread: true, size: 5 }, { silent: true })
    if (current(epoch) && request === noticeRequest) notifications.value = res.records
  } catch (error) {
    if (!current(epoch) || request !== noticeRequest) return
    notifications.value = []
    noticeError.value = feedbackMessage(error, '通知加载失败，请重试')
  } finally {
    if (current(epoch) && request === noticeRequest) noticesLoading.value = false
  }
}

async function refreshSummary() {
  const epoch = country.epoch
  summaryError.value = ''
  try { await todo.refresh() }
  catch (error) { if (current(epoch)) summaryError.value = feedbackMessage(error, '待办数量刷新失败，请重试') }
}

async function refreshWorkbench() {
  refreshing.value = true
  try { await Promise.all([loadTodos(), loadNotifications(), refreshSummary()]) }
  finally { if (!disposed) refreshing.value = false }
}

async function changePage(value: number) {
  if (value === page.value) return
  page.value = value
  await loadTodos()
}

async function changeSize(value: number) {
  size.value = value
  page.value = 1
  try { localStorage.setItem(sizeKey, String(value)) }
  catch { ElMessage.warning('每页条数已生效，浏览器未允许保存设置') }
  await loadTodos()
}

async function search() {
  page.value = 1
  await loadTodos()
}

async function toggleOrder() {
  order.value = order.value === 'desc' ? 'asc' : 'desc'
  await search()
}

async function openCard(item: { type: string; link: string }) {
  if (item.type === 'APPROVAL' || item.type === 'CONFIG_MISSING') {
    await router.push(item.link)
    return
  }
  activeType.value = activeType.value === item.type ? '' : item.type
  await search()
}

async function showAll() {
  activeType.value = ''
  query.value = ''
  await search()
}

async function openTodo(row: TodoRow) { await router.push(row.link) }

async function openNotification(n: NotificationRow) {
  if (readingNotice.value) return
  const epoch = country.epoch
  readingNotice.value = true
  try {
    await http.post(`/sys/notifications/${n.id}/read`, undefined, { silent: true })
    if (!current(epoch)) return
    await refreshSummary()
    if (!current(epoch)) return
    if (n.link) await router.push(n.link)
    else await loadNotifications()
  } catch (error) {
    if (current(epoch)) noticeError.value = feedbackMessage(error, '通知打开失败，请重试')
  } finally { if (current(epoch)) readingNotice.value = false }
}

let timer: ReturnType<typeof setInterval> | undefined
let media: MediaQueryList | undefined
function updateCompact(event: MediaQueryList | MediaQueryListEvent) { compact.value = event.matches }
onMounted(() => {
  if (noCountry.value || noRole.value) return
  media = window.matchMedia('(max-width: 768px)')
  updateCompact(media)
  media.addEventListener('change', updateCompact)
  loadTodos()
  loadNotifications()
  timer = setInterval(() => (now.value = new Date().toISOString()), 30_000)
})
onBeforeUnmount(() => { disposed = true; clearInterval(timer); media?.removeEventListener('change', updateCompact) })
</script>

<template>
  <div class="page workbench">
    <div v-if="noCountry || noRole" class="page-card">
      <el-empty :description="noCountry ? '你的账号还没有被分配到任何国家' : `你在${country.current?.name}还没有被分配角色`">
        <p class="muted">请联系平台管理员或国家管理员在「系统设置 → 用户与授权」中为你分配国家、角色和数据范围。</p>
      </el-empty>
    </div>

    <template v-else>
      <section class="workspace-overview" aria-label="当前国家与工作概览">
        <div class="workspace-country">
          <div class="country-symbol" aria-hidden="true">{{ country.current?.code }}</div>
          <div class="country-copy">
            <div class="eyebrow">当前工作空间</div>
            <div class="country-name">
              <h1>{{ country.current?.name }}</h1>
              <el-tag v-if="country.current?.isTest" type="warning" size="small">测试国家</el-tag>
              <el-tag v-if="country.current?.status === 'DRAFT'" type="info" size="small">草稿（未启用）</el-tag>
            </div>
            <div class="country-meta">币种 <strong>{{ country.currency }}</strong><span aria-hidden="true">·</span>当地时间 {{ formatDateTime(now, country.timezone) }}</div>
          </div>
        </div>
        <div class="workspace-summary">
          <button class="summary-item" type="button" @click="showAll">
            <span class="summary-number">{{ todo.total }}</span><span><strong>待办事项</strong><small>待处理工作</small></span>
          </button>
          <button class="summary-item" type="button" @click="router.push('/notifications')">
            <span class="summary-number" :class="{ zero: !todo.unreadNotifications }">{{ todo.unreadNotifications }}</span><span><strong>未读通知</strong><small>{{ todo.unreadNotifications ? '有新消息' : '暂无新消息' }}</small></span>
          </button>
        </div>
      </section>
      <div v-if="summaryError" class="request-state" role="status"><p class="muted">操作未完成，请查看全局提示。</p></div>

      <div class="workbench-grid">
        <section class="workbench-panel todo-panel" aria-labelledby="todo-title">
          <header class="panel-heading">
            <div><div class="heading-title"><h2 id="todo-title">待办事项</h2><span class="count-badge">{{ total }}</span></div><p>需要你关注和处理的工作</p></div>
            <el-button :loading="refreshing" @click="refreshWorkbench"><el-icon v-if="!refreshing"><Refresh /></el-icon><span>刷新</span></el-button>
          </header>
          <div class="todo-toolbar">
            <div class="type-filters" role="group" aria-label="待办类型">
              <button type="button" :aria-pressed="!activeType" @click="activeType = ''; search()">全部待办 <span>{{ todo.total }}</span></button>
              <button v-for="item in todo.summary" :key="item.type" type="button" :aria-pressed="activeType === item.type" :class="{ 'alert-type': item.type === 'CONFIG_MISSING' || item.type === 'OUTBOUND_BLOCKED' }" @click="openCard(item)">
                {{ item.label }} <span>{{ item.count }}</span><el-icon v-if="item.type === 'APPROVAL' || item.type === 'CONFIG_MISSING'"><ArrowRight /></el-icon>
              </button>
            </div>
            <div class="query-controls"><el-input v-model="query" class="todo-search" placeholder="搜索待办标题或编号" aria-label="搜索待办标题或编号" clearable @keyup.enter="search" @clear="search">
              <template #append><el-button aria-label="搜索待办" title="搜索待办" @click="search"><el-icon><Search /></el-icon></el-button></template>
            </el-input><el-tooltip v-if="compact" :content="order === 'desc' ? '最新创建优先' : '最早创建优先'"><el-button :aria-label="`创建时间排序：${order === 'desc' ? '最新优先' : '最早优先'}`" @click="toggleOrder"><el-icon><SortDown v-if="order === 'desc'" /><SortUp v-else /></el-icon></el-button></el-tooltip></div>
          </div>
          <div v-if="todoError" class="load-error" role="alert"><el-icon><Warning /></el-icon><span>操作未完成，请查看全局提示。</span><el-button link type="primary" @click="loadTodos">重试</el-button></div>
          <el-table v-else v-loading="loading" :data="todos" class="todo-table" :max-height="'max(320px, calc(100dvh - 470px))'" :empty-text="loading ? '正在加载待办' : query || activeType ? '没有匹配的待办' : '当前没有待办'">
            <el-table-column label="待办事项" :min-width="compact ? 180 : 230">
              <template #default="{ row }">
                <div class="todo-name"><span class="todo-icon"><el-icon><Document /></el-icon></span><div class="todo-copy"><el-link underline="never" @click="openTodo(row)">{{ row.title }}</el-link><div class="source-id">#{{ row.id }}</div></div></div>
              </template>
            </el-table-column>
            <el-table-column v-if="!compact" label="业务类型" min-width="150"><template #default="{ row }"><span class="type-label">{{ row.typeLabel }}</span></template></el-table-column>
            <el-table-column v-if="!compact" min-width="185">
              <template #header><button class="time-sort" type="button" :title="order === 'desc' ? '最新创建优先' : '最早创建优先'" :aria-label="`创建时间排序：${order === 'desc' ? '最新优先' : '最早优先'}`" @click="toggleOrder">创建时间<el-icon><SortDown v-if="order === 'desc'" /><SortUp v-else /></el-icon></button></template>
              <template #default="{ row }"><span class="todo-time"><DateTimeText :value="row.createdAt" /></span></template>
            </el-table-column>
            <el-table-column label="操作" :width="compact ? 80 : 85" align="right"><template #default="{ row }"><el-button link type="primary" @click="openTodo(row)">处理<el-icon><Right /></el-icon></el-button></template></el-table-column>
          </el-table>
          <div class="todo-pagination">
            <el-pagination :current-page="page" :page-size="size" :page-sizes="sizeOptions" :total="total" :disabled="loading || !!todoError" :pager-count="5" layout="total, sizes, prev, pager, next, jumper" background @current-change="changePage" @size-change="changeSize" />
          </div>
        </section>

        <aside class="workbench-sidebar" aria-label="通知与常用入口">
          <section class="workbench-panel notice-panel" aria-labelledby="notice-title">
            <header class="panel-heading"><div class="heading-title"><h2 id="notice-title">未读通知</h2><span class="count-badge">{{ todo.unreadNotifications }}</span></div><el-button link type="primary" @click="router.push('/notifications')">全部<el-icon><ArrowRight /></el-icon></el-button></header>
            <div v-if="noticeError" class="load-error" role="alert"><span>操作未完成，请查看全局提示。</span><el-button link type="primary" @click="loadNotifications">重试</el-button></div>
            <div v-else v-loading="noticesLoading" class="notices">
              <div v-if="!notifications.length" class="notice-empty"><span class="notice-illustration" aria-hidden="true"><el-icon><Bell /></el-icon><span class="notice-check"><el-icon><Check /></el-icon></span></span><strong>{{ noticesLoading ? '正在加载通知' : '暂时没有未读通知' }}</strong><span>{{ country.current?.name }}</span></div>
              <button v-for="n in notifications" :key="n.id" class="notice" type="button" :disabled="readingNotice" @click="openNotification(n)"><strong>{{ n.title }}</strong><span>{{ n.content }}</span><small><DateTimeText :value="n.createdAt" /></small></button>
            </div>
            <div v-if="!noticeError && !noticesLoading && !notifications.length" class="notice-footer"><el-icon><CircleCheck /></el-icon>当前工作空间暂无未读消息</div>
          </section>
          <section class="workbench-panel shortcut-panel" aria-labelledby="shortcut-title">
            <header class="panel-heading"><h2 id="shortcut-title">常用入口</h2></header>
            <div class="shortcuts"><button v-for="item in shortcuts" :key="item.path" class="shortcut" type="button" @click="router.push(item.path)"><span class="shortcut-icon"><el-icon><component :is="item.icon" /></el-icon></span><span class="shortcut-copy"><strong>{{ item.title }}</strong><small>{{ item.description }}</small></span><el-icon><ArrowRight /></el-icon></button></div>
          </section>
          <p class="scope-note"><el-icon><Lock /></el-icon><span>当前国家 · 按你的权限与数据范围展示</span></p>
        </aside>
      </div>
    </template>
  </div>
</template>

<style scoped lang="scss">
.workbench { --workbench-line: #e6ebf3; --workbench-muted: #7b879b; color: #283850; }
.workspace-overview { display: flex; align-items: center; justify-content: space-between; gap: 24px; min-height: 112px; padding: 20px 24px; margin-bottom: 18px; background: #fff; border: 1px solid var(--workbench-line); border-radius: 8px; }
.workspace-country { display: flex; align-items: center; gap: 16px; min-width: 0; }
.country-symbol { display: grid; place-items: center; flex-shrink: 0; min-width: 50px; max-width: 90px; min-height: 54px; padding: 8px; border-radius: 8px; background: #193362; color: #fff; font-weight: 600; font-size: 16px; overflow-wrap: anywhere; }
.country-copy { min-width: 0; }
.eyebrow { color: var(--workbench-muted); font-size: 11px; margin-bottom: 7px; }
.country-name { display: flex; align-items: center; gap: 9px; flex-wrap: wrap; }
h1 { font-size: 21px; line-height: 1.5; margin: 0; overflow-wrap: anywhere; }
.country-meta { display: flex; align-items: center; gap: 8px; flex-wrap: wrap; margin-top: 7px; color: var(--workbench-muted); font-size: 12px; line-height: 1.6; strong { font-weight: 500; color: #536682; } }
.workspace-summary { display: flex; align-items: center; gap: 28px; padding-left: 30px; border-left: 1px solid var(--workbench-line); }
.summary-item { display: flex; align-items: center; gap: 14px; border: 0; background: none; padding: 4px 0; cursor: pointer; text-align: left; color: inherit; white-space: nowrap; span:last-child { display: grid; gap: 7px; } strong { font-size: 13px; font-weight: 500; } small { font-size: 11px; color: var(--workbench-muted); } }
.summary-number { font-size: 38px; line-height: 1; font-weight: 600; color: var(--el-color-primary); font-variant-numeric: tabular-nums; &.zero { color: #7c8aa2; } }
.summary-error { margin-bottom: 16px; }
.workbench-grid { display: grid; grid-template-columns: minmax(0, 1fr) 300px; gap: 18px; align-items: start; }
.workbench-panel { background: #fff; border: 1px solid var(--workbench-line); border-radius: 8px; min-width: 0; overflow: hidden; }
.panel-heading { display: flex; align-items: center; justify-content: space-between; gap: 12px; padding: 20px 22px 16px; p { color: var(--workbench-muted); font-size: 12px; margin: 7px 0 0; } }
.heading-title { display: flex; align-items: center; gap: 8px; }
h2 { font-size: 17px; margin: 0; font-weight: 600; }
.count-badge { padding: 2px 7px; border-radius: 4px; color: #7385a5; background: #f0f3f8; font-size: 12px; font-variant-numeric: tabular-nums; }
.todo-toolbar { display: flex; align-items: center; justify-content: space-between; flex-wrap: wrap; gap: 12px; padding: 0 22px 16px; }
.type-filters { display: flex; flex-wrap: wrap; align-items: center; gap: 4px; min-width: 0; button { display: inline-flex; align-items: center; gap: 6px; max-width: 100%; min-height: 32px; border: 1px solid transparent; border-radius: 5px; padding: 7px 10px; font: inherit; font-size: 12px; line-height: 1.5; color: #748198; background: #f4f6fa; cursor: pointer; text-align: left; span { font-variant-numeric: tabular-nums; } &[aria-pressed='true'] { color: var(--el-color-primary); border-color: #d8e5ff; background: #eff5ff; } &:hover { background: #edf2fb; } &.alert-type { color: #bb751e; } } }
.todo-search { width: 235px; flex-shrink: 0; }
.query-controls { display: flex; align-items: center; gap: 8px; min-width: 0; }
.todo-table { width: 100%; :deep(th.el-table__cell) { background: #f7f9fc; font-weight: 400; color: #8190a5; font-size: 12px; } :deep(.el-table__cell) { padding: 11px 0; } :deep(.el-table__cell:first-child .cell) { padding-left: 22px; } :deep(.el-table__cell:last-child .cell) { padding-right: 22px; } :deep(.el-table__inner-wrapper::before) { display: none; } }
.todo-name { display: flex; align-items: center; gap: 11px; }
.todo-icon { display: grid; place-items: center; width: 30px; height: 34px; flex-shrink: 0; border: 1px solid #e1e9fa; border-radius: 5px; background: #f5f8ff; color: #7d9bdc; }
.todo-copy { min-width: 0; :deep(.el-link) { color: #31425c; text-align: left; line-height: 1.6; font-size: 13px; &:hover { color: var(--el-color-primary); } } }
.source-id { font-size: 11px; color: #8f9bb0; line-height: 1.5; margin-top: 2px; font-variant-numeric: tabular-nums; }
.type-label { display: inline-flex; align-items: center; gap: 7px; color: #748198; font-size: 12px; &::before { content: ''; flex-shrink: 0; width: 5px; height: 5px; border-radius: 50%; background: #d69c4b; } }
.todo-time { color: #7d8a9d; font-size: 12px; font-variant-numeric: tabular-nums; }
.time-sort { display: inline-flex; align-items: center; gap: 4px; font: inherit; color: inherit; border: 0; background: none; padding: 0; cursor: pointer; }
.todo-pagination { border-top: 1px solid var(--workbench-line); padding: 17px 20px; :deep(.el-pagination) { justify-content: flex-end; flex-wrap: wrap; gap: 8px 0; font-weight: 400; --el-pagination-font-size: 12px; } :deep(.el-pagination__total) { margin-right: auto; padding-right: 12px; } }
.load-error { display: flex; flex-wrap: wrap; align-items: center; justify-content: center; gap: 10px; min-height: 180px; padding: 24px; color: #bf4e4e; font-size: 13px; overflow-wrap: anywhere; }
.workbench-sidebar { display: grid; gap: 18px; }
.notice-panel .panel-heading { padding-bottom: 10px; }
.notices { min-height: 200px; }
.notice-empty { display: flex; flex-direction: column; align-items: center; gap: 12px; padding: 25px 16px 32px; color: #98a5ba; font-size: 12px; text-align: center; strong { font-size: 13px; font-weight: 400; color: #79879d; } }
.notice-illustration { position: relative; display: grid; place-items: center; width: 76px; height: 76px; background: #f3f6fc; border-radius: 50%; margin: 4px 0 6px; > .el-icon { font-size: 42px; color: #9bb4e3; } }
.notice-check { display: grid; place-items: center; position: absolute; top: 9px; right: 3px; width: 21px; height: 21px; color: #5d9b83; background: #ecf6f0; border: 1px solid #c8dfd3; border-radius: 50%; font-size: 12px; }
.notice { display: grid; gap: 7px; width: calc(100% - 40px); margin: 0 20px; border: 0; border-bottom: 1px solid var(--workbench-line); padding: 14px 0; background: none; text-align: left; font: inherit; cursor: pointer; overflow-wrap: anywhere; strong { font-size: 13px; font-weight: 500; color: #3c4f6b; } span { font-size: 12px; color: var(--workbench-muted); line-height: 1.6; } small { font-size: 11px; color: #94a0b3; } &:last-child { border-bottom: 0; } &:hover strong { color: var(--el-color-primary); } &:disabled { cursor: wait; opacity: .6; } }
.notice-footer { display: flex; align-items: center; gap: 6px; margin: 0 22px; border-top: 1px solid var(--workbench-line); padding: 13px 0; font-size: 11px; color: #919fb2; .el-icon { color: #7da997; } }
.shortcuts { padding: 0 15px 12px; }
.shortcut { display: flex; align-items: center; gap: 10px; width: 100%; border: 0; border-top: 1px solid #f0f3f8; padding: 13px 7px; color: #7c8ba4; background: none; text-align: left; font: inherit; cursor: pointer; &:hover { background: #f7f9fe; } > .el-icon { font-size: 12px; } }
.shortcut-icon { display: grid; place-items: center; width: 30px; height: 30px; flex-shrink: 0; border: 1px solid var(--workbench-line); border-radius: 6px; }
.shortcut-copy { display: grid; flex: 1; min-width: 0; gap: 5px; strong { font-weight: 500; font-size: 13px; color: #3d4f6b; } small { font-size: 11px; color: #95a1b3; overflow-wrap: anywhere; } }
.scope-note { display: flex; align-items: flex-start; gap: 6px; margin: 0; padding: 0 7px; color: #9aa6b8; font-size: 11px; line-height: 1.8; .el-icon { margin-top: 3px; flex-shrink: 0; } }
button:focus-visible { outline: 2px solid var(--el-color-primary); outline-offset: 3px; }
@media (max-width: 1250px) {
  .workspace-overview { flex-wrap: wrap; }
  .workspace-summary { margin-left: auto; }
  .workbench-grid { grid-template-columns: minmax(0, 1fr); }
  .workbench-sidebar { grid-template-columns: repeat(2, minmax(0, 1fr)); align-items: start; }
  .scope-note { grid-column: 1 / -1; }
}
@media (max-width: 768px) {
  .workspace-overview { padding: 18px; gap: 18px; }
  .workspace-country { width: 100%; }
  .country-symbol { display: none; }
  h1 { font-size: 19px; }
  .country-meta { font-size: 11px; gap: 6px; }
  .workspace-summary { width: 100%; justify-content: space-around; margin: 0; padding: 16px 0 0; border-left: 0; border-top: 1px solid var(--workbench-line); gap: 14px; }
  .summary-number { font-size: 32px; }
  .summary-item { white-space: normal; gap: 10px; strong { font-size: 12px; } }
  .panel-heading { padding: 18px 16px 14px; }
  .todo-toolbar { padding: 0 16px 15px; }
  .query-controls { width: 100%; }
  .todo-search { width: auto; flex: 1; }
  .todo-table { :deep(.el-table__cell:first-child .cell) { padding-left: 16px; } :deep(.el-table__cell:last-child .cell) { padding-right: 16px; } }
  .todo-pagination { padding: 14px 12px; :deep(.el-pagination) { justify-content: flex-start; gap: 10px 0; } :deep(.el-pagination__total) { width: 100%; } :deep(.el-pagination__jump) { margin-left: 0; } }
  .workbench-sidebar { grid-template-columns: minmax(0, 1fr); }
}
</style>
