<script setup lang="ts">
import { computed, onBeforeUnmount, onMounted, ref } from 'vue'
import { useRouter } from 'vue-router'
import { ElMessage, ElMessageBox } from 'element-plus'
import { BizError, http } from '@/api/http'
import type { PageResult } from '@/api/types'
import { useCountryStore } from '@/stores/country'
import { useTodoStore } from '@/stores/todo'
import DateTimeText from '@/components/DateTimeText.vue'

interface NotificationRow {
  id: number
  notifyType?: string | null
  title: string
  content: string
  link?: string
  readAt: string | null
  createdAt: string
}

const types: Record<string, { label: string; tone: string; icon: string }> = {
  CC: { label: '抄送', tone: 'cc', icon: 'CopyDocument' },
  SYSTEM: { label: '系统', tone: 'system', icon: 'Bell' },
  APPROVAL_RESULT: { label: '审批结果', tone: 'approval', icon: 'CircleCheck' },
}
const sizeOptions = [20, 50, 100]

const router = useRouter()
const country = useCountryStore()
const todo = useTodoStore()
const unreadOnly = ref(false)
const rows = ref<NotificationRow[]>([])
const page = ref(1)
const size = ref(20)
const total = ref(0)
const allCount = ref<number | null>(null)
const unreadCount = ref<number | null>(null)
const loading = ref(false)
const readingId = ref<number | null>(null)
const readingAll = ref(false)
const error = ref('')
const countError = ref('')
const actionError = ref('')
const summaryError = ref('')
const permissionDenied = ref(false)
const expanded = ref(new Set<number>())
const busy = computed(() => loading.value || readingId.value !== null || readingAll.value)
const noCountry = computed(() => !country.current)
const hasList = computed(() => !noCountry.value && !loading.value && !error.value)
const canReadAll = computed(() => hasList.value && !busy.value && unreadCount.value !== 0)
let requestId = 0
let disposed = false
function current(epoch: number) { return !disposed && epoch === country.epoch }
function errorMessage(failure: unknown, fallback: string) { return failure instanceof Error && failure.message.trim() ? failure.message : fallback }
function typeDef(type?: string | null) {
  if (type == null || type === '') return { label: '类型未提供', tone: 'unknown', icon: 'Bell' }
  return Object.hasOwn(types, type) ? types[type]! : { label: type, tone: 'unknown', icon: 'Bell' }
}
function longContent(row: NotificationRow) { return row.content.length > 65 || row.content.includes('\n') }
function toggleContent(id: number) {
  if (expanded.value.has(id)) expanded.value.delete(id)
  else expanded.value.add(id)
}

async function load() {
  if (noCountry.value || disposed) return
  const request = ++requestId
  const epoch = country.epoch
  const unread = unreadOnly.value
  loading.value = true
  error.value = ''
  countError.value = ''
  permissionDenied.value = false
  allCount.value = null
  unreadCount.value = null
  try {
    // 计数复用同一接口的total，失败不伪装成零条。
    const [list, oppositeCount] = await Promise.allSettled([
      http.get<PageResult<NotificationRow>>('/sys/notifications', { unread: unread || undefined, page: page.value, size: size.value }, { silent: true }),
      http.get<PageResult<NotificationRow>>('/sys/notifications', { unread: unread ? undefined : true, page: 1, size: 1 }, { silent: true }),
    ])
    if (!current(epoch) || request !== requestId) return
    if (list.status === 'rejected') throw list.reason
    const lastPage = Math.max(1, Math.ceil(list.value.total / size.value))
    if (page.value > lastPage) {
      page.value = lastPage
      await load()
      return
    }
    rows.value = list.value.records
    total.value = list.value.total
    const activeCount = unread ? unreadCount : allCount
    const otherCount = unread ? allCount : unreadCount
    activeCount.value = list.value.total
    if (oppositeCount.status === 'fulfilled') otherCount.value = oppositeCount.value.total
    else countError.value = errorMessage(oppositeCount.reason, '通知数量加载失败，请刷新重试')
  } catch (failure) {
    if (!current(epoch) || request !== requestId) return
    rows.value = []
    total.value = 0
    permissionDenied.value = failure instanceof BizError && failure.code === 'SYS_FORBIDDEN'
    error.value = errorMessage(failure, '通知加载失败，请重试')
  } finally {
    if (current(epoch) && request === requestId) loading.value = false
  }
}

async function changeFilter(unread: boolean) {
  if (busy.value || unreadOnly.value === unread) return
  unreadOnly.value = unread
  page.value = 1
  await load()
}
async function changeSize(value: number) {
  if (busy.value || !sizeOptions.includes(value) || value === size.value) return
  size.value = value
  page.value = 1
  await load()
}
async function changePage(value: number) {
  if (busy.value || value === page.value || !Number.isInteger(value) || value < 1 || value > Math.max(1, Math.ceil(total.value / size.value))) return
  page.value = value
  await load()
}
async function refreshSummary(epoch: number) {
  summaryError.value = ''
  try { await todo.refresh() }
  catch (failure) { if (current(epoch)) summaryError.value = errorMessage(failure, '工作台角标更新失败，请刷新重试') }
}
async function refresh() {
  if (busy.value || noCountry.value) return
  const epoch = country.epoch
  actionError.value = ''
  await load()
  if (current(epoch) && !error.value) await refreshSummary(epoch)
}

async function open(row: NotificationRow) {
  if (busy.value || noCountry.value || permissionDenied.value) return
  const epoch = country.epoch
  readingId.value = row.id
  actionError.value = ''
  let marked = false
  try {
    if (!row.readAt) {
      await http.post(`/sys/notifications/${row.id}/read`, undefined, { silent: true })
      if (!current(epoch)) return
      row.readAt = new Date().toISOString()
      marked = true
      if (unreadCount.value !== null) unreadCount.value = Math.max(0, unreadCount.value - 1)
      await refreshSummary(epoch)
      if (!current(epoch)) return
    }
    if (row.link) await router.push(row.link)
    else {
      expanded.value.add(row.id)
      await load()
      if (current(epoch) && marked) ElMessage.success(unreadOnly.value ? '已标为已读，可在全部通知中查看' : '已标为已读')
    }
  } catch (failure) {
    if (current(epoch)) actionError.value = `${marked ? '通知已标为已读，但关联业务打开失败：' : ''}${errorMessage(failure, '通知打开失败，请重试')}`
  } finally { if (current(epoch)) readingId.value = null }
}

async function readAll() {
  if (busy.value || noCountry.value || permissionDenied.value || error.value || unreadCount.value === 0) return
  const epoch = country.epoch
  const scopeName = country.current?.name
  readingAll.value = true
  actionError.value = ''
  try {
    await ElMessageBox.confirm(
      `将当前${scopeName ? `「${scopeName}」` : ''}工作空间内的${unreadCount.value === null ? '全部' : ` ${unreadCount.value} 条`}未读通知标为已读？包含其他分页中的通知，不会审批或处理关联单据。`,
      '全部标为已读',
      { confirmButtonText: '确认标为已读', cancelButtonText: '取消', type: 'warning', distinguishCancelAndClose: true },
    )
    if (!current(epoch)) return
    await http.post('/sys/notifications/read-all', undefined, { silent: true })
    if (!current(epoch)) return
    unreadCount.value = 0
    for (const row of rows.value) if (!row.readAt) row.readAt = new Date().toISOString()
    ElMessage.success('全部未读通知已标为已读')
    await Promise.all([load(), refreshSummary(epoch)])
  } catch (failure) {
    // Element Plus以cancel/close明确表达用户取消，不属于接口失败。
    if (current(epoch) && failure !== 'cancel' && failure !== 'close') actionError.value = errorMessage(failure, '全部标为已读失败，请重试')
  } finally { if (current(epoch)) readingAll.value = false }
}

onMounted(load)
onBeforeUnmount(() => { disposed = true; requestId++ })
</script>

<template>
  <div class="page notifications-page">
    <section class="page-card notifications-panel" aria-labelledby="notifications-title">
      <header class="notifications-heading">
        <div><h2 id="notifications-title">通知中心</h2><p class="subtitle">集中查看抄送、审批结果与系统消息</p></div>
        <div class="notifications-actions">
          <el-button :disabled="busy || noCountry" @click="refresh"><el-icon><Refresh /></el-icon>刷新</el-button>
          <el-button type="primary" :loading="readingAll" :disabled="!canReadAll" @click="readAll"><el-icon v-if="!readingAll"><Check /></el-icon>全部标为已读</el-button>
        </div>
      </header>
      <div class="notifications-tabs">
        <div class="filter-tabs" role="group" aria-label="通知阅读状态">
          <button type="button" :aria-pressed="!unreadOnly" :disabled="busy || noCountry || permissionDenied" @click="changeFilter(false)">全部通知<span class="count">{{ allCount === null ? '—' : allCount }}</span></button>
          <button type="button" :aria-pressed="unreadOnly" :disabled="busy || noCountry || permissionDenied" @click="changeFilter(true)">未读<span class="count">{{ unreadCount === null ? '—' : unreadCount }}</span></button>
        </div>
        <span class="sort-hint"><el-icon><Sort /></el-icon>最新通知在前</span>
      </div>
      <div class="notification-feedback" aria-live="polite">
        <el-alert v-if="countError" :title="`通知数量暂不可用：${countError}`" type="warning" :closable="false" show-icon />
        <el-alert v-if="actionError" :title="actionError" type="error" :closable="false" show-icon />
        <el-alert v-if="summaryError" :title="`工作台角标暂未更新：${summaryError}`" type="warning" :closable="false" show-icon />
      </div>
      <div class="notification-region" :aria-busy="loading">
        <div v-if="noCountry" class="notification-state"><span class="state-icon"><el-icon><OfficeBuilding /></el-icon></span><strong>请先选择国家</strong><p>选择工作空间后查看对应通知。</p></div>
        <div v-else-if="loading" class="notification-state" role="status"><span class="state-icon"><el-icon class="is-loading"><Loading /></el-icon></span><strong>正在加载通知</strong><p>正在获取当前工作空间的通知，请稍候。</p></div>
        <div v-else-if="error" class="notification-state" :class="{ 'is-error': !permissionDenied }" role="alert">
          <span class="state-icon"><el-icon><Lock v-if="permissionDenied" /><Warning v-else /></el-icon></span>
          <strong>{{ permissionDenied ? '暂无查看权限' : '通知加载失败' }}</strong><p>{{ error }}</p><el-button v-if="!permissionDenied" type="primary" @click="refresh">重新加载</el-button>
        </div>
        <div v-else-if="!rows.length" class="notification-state"><span class="state-icon"><el-icon><Bell /></el-icon></span><strong>{{ unreadOnly ? '暂时没有未读通知' : '暂无通知' }}</strong><p>{{ unreadOnly ? '新收到的未读通知会显示在这里。' : '新的抄送、审批结果和系统消息会显示在这里。' }}</p><el-button v-if="unreadOnly" link type="primary" @click="changeFilter(false)">查看全部通知</el-button></div>
        <div v-else class="notification-scroll">
          <div class="notification-table" role="table" aria-label="通知列表">
            <div class="notification-table-heading" role="row"><div role="columnheader">通知类型</div><div role="columnheader">通知内容</div><div role="columnheader" class="time-heading">接收时间</div><div role="columnheader" class="status-heading">阅读状态</div><div role="columnheader" class="action-heading">操作</div></div>
            <div v-for="row in rows" :key="row.id" class="notification-row" :class="{ 'is-unread': !row.readAt }" role="row">
              <div class="notice-type" role="cell"><span class="type-tag" :class="typeDef(row.notifyType).tone"><el-icon><component :is="typeDef(row.notifyType).icon" /></el-icon>{{ typeDef(row.notifyType).label }}</span></div>
              <div class="notice-content" role="cell">
                <div class="notice-title-line"><span v-if="!row.readAt" class="unread-dot" aria-hidden="true" /><button class="notice-title" type="button" :disabled="busy" @click="open(row)">{{ row.title }}</button></div>
                <p :id="`notification-content-${row.id}`" class="notice-body" :class="{ clamped: longContent(row) && !expanded.has(row.id) }">{{ row.content }}</p>
                <button v-if="longContent(row)" class="expand-content" type="button" :aria-expanded="expanded.has(row.id)" :aria-controls="`notification-content-${row.id}`" @click="toggleContent(row.id)">{{ expanded.has(row.id) ? '收起全文' : '展开全文' }}</button>
              </div>
              <div class="notice-time" role="cell"><DateTimeText :value="row.createdAt" /></div>
              <div class="notice-status" :class="{ unread: !row.readAt }" role="cell"><el-icon v-if="row.readAt"><Check /></el-icon>{{ row.readAt ? '已读' : '未读' }}</div>
              <div class="notice-action" role="cell"><el-button link type="primary" :loading="readingId === row.id" :disabled="busy" :aria-label="`查看：${row.title}`" @click="open(row)">查看</el-button></div>
            </div>
          </div>
        </div>
      </div>
      <footer class="notifications-pagination">
        <span class="range-summary">{{ hasList ? total ? `共 ${total} 条 · 当前 ${(page - 1) * size + 1}–${Math.min(page * size, total)} 条` : '共 0 条' : loading ? '通知正在加载' : '通知数量暂不可用' }}</span>
        <el-pagination :current-page="page" :page-size="size" :page-sizes="sizeOptions" :total="total" :disabled="busy || !hasList" layout="sizes, prev, pager, next" background :pager-count="5" @current-change="changePage" @size-change="changeSize" />
      </footer>
    </section>
    <p class="notifications-hint">抄送仅供知悉，不增加单据操作权限。</p>
  </div>
</template>

<style scoped>
.notifications-panel { padding-bottom: 0; margin-bottom: 0; }
.notifications-heading { display: flex; align-items: center; justify-content: space-between; gap: 16px; padding-bottom: 20px; }
.notifications-heading h2 { margin: 0; font-size: 18px; font-weight: 600; }
.subtitle { margin: 6px 0 0; color: var(--el-text-color-regular); font-size: 13px; }
.notifications-actions { display: flex; align-items: center; gap: 8px; flex-shrink: 0; }
.notifications-actions .el-button + .el-button { margin-left: 0; }
.notifications-actions .el-icon { margin-right: 6px; }
.notifications-tabs { display: flex; justify-content: space-between; align-items: center; gap: 12px; border-bottom: 1px solid var(--el-border-color-light); }
.filter-tabs { display: flex; gap: 26px; }
.filter-tabs button { position: relative; display: flex; align-items: center; gap: 8px; min-height: 44px; padding: 0 1px 12px; border: 0; background: transparent; color: var(--el-text-color-regular); font: inherit; cursor: pointer; }
.filter-tabs button[aria-pressed='true'] { color: var(--el-color-primary); font-weight: 600; }
.filter-tabs button[aria-pressed='true']::after { content: ''; position: absolute; right: 0; bottom: -1px; left: 0; height: 2px; background: var(--el-color-primary); }
.count { min-width: 23px; padding: 0 6px; border-radius: 4px; background: var(--el-fill-color-light); color: var(--el-text-color-regular); font-size: 12px; font-weight: 400; text-align: center; font-variant-numeric: tabular-nums; }
.filter-tabs button[aria-pressed='true'] .count { background: var(--el-color-primary-light-9); color: var(--el-color-primary); }
.sort-hint { display: flex; align-items: center; gap: 5px; padding-bottom: 10px; color: var(--el-text-color-secondary); font-size: 12px; white-space: nowrap; }
.notification-feedback { display: grid; gap: 8px; }
.notification-feedback:not(:empty) { padding: 12px 0; }
.notification-scroll { max-height: max(340px, calc(100dvh - 378px)); overflow: auto; scrollbar-width: thin; }
.notification-table-heading, .notification-row { display: grid; grid-template-columns: 116px minmax(0, 1fr) 204px 76px 64px; }
.notification-table-heading { position: sticky; top: 0; z-index: 1; min-height: 40px; background: #f7f9fc; color: #7b879b; font-size: 12px; box-shadow: 0 1px var(--el-border-color-lighter); }
.notification-table-heading > div { display: flex; align-items: center; padding: 0 12px; }
.notification-table-heading > div:first-child { padding-left: 16px; }
.notification-table-heading .action-heading { justify-content: flex-end; padding-right: 16px; }
.notification-row { padding: 16px 0; border-bottom: 1px solid var(--el-border-color-lighter); }
.notification-row > div { min-width: 0; padding: 0 12px; }
.notification-row.is-unread { background: #fbfdff; }
.notification-row:hover { background: #f5f9ff; }
.notification-row .notice-type { padding-left: 16px; }
.type-tag { display: inline-flex; align-items: center; justify-content: center; gap: 6px; min-height: 26px; max-width: 100%; padding: 2px 7px; border: 1px solid var(--el-color-primary-light-8); border-radius: 4px; background: var(--el-color-primary-light-9); color: var(--el-color-primary-dark-2); font-size: 12px; overflow-wrap: anywhere; }
.type-tag .el-icon { flex-shrink: 0; font-size: 13px; }
.type-tag.approval { border-color: var(--el-color-success-light-8); background: var(--el-color-success-light-9); color: var(--el-color-success-dark-2); }
.type-tag.system, .type-tag.unknown { border-color: var(--el-color-info-light-8); background: var(--el-color-info-light-9); color: var(--el-text-color-regular); }
.notice-title-line { display: flex; align-items: baseline; gap: 7px; }
.unread-dot { flex: 0 0 6px; align-self: flex-start; width: 6px; height: 6px; margin-top: 8px; border-radius: 50%; background: var(--el-color-primary); }
.notice-title { min-width: 0; padding: 0; border: 0; background: transparent; color: var(--el-text-color-primary); font: inherit; font-size: 14px; line-height: 1.6; text-align: left; overflow-wrap: anywhere; cursor: pointer; }
.notice-title:hover { color: var(--el-color-primary); }
.is-unread .notice-title { font-weight: 600; }
.notice-body { margin: 5px 0 0; color: var(--el-text-color-regular); font-size: 13px; line-height: 1.7; white-space: pre-wrap; overflow-wrap: anywhere; }
.notice-body.clamped { display: -webkit-box; -webkit-line-clamp: 2; -webkit-box-orient: vertical; overflow: hidden; }
.expand-content { padding: 0; border: 0; background: transparent; color: var(--el-color-primary); font: inherit; font-size: 12px; line-height: 24px; cursor: pointer; }
.expand-content:hover { text-decoration: underline; text-underline-offset: 3px; }
.notification-row .notice-time { padding-top: 3px; color: #7d8a9d; font-size: 12px; font-variant-numeric: tabular-nums; white-space: nowrap; }
.notice-status { display: flex; align-items: flex-start; gap: 4px; padding-top: 2px !important; color: var(--el-text-color-secondary); font-size: 12px; white-space: nowrap; }
.notice-status .el-icon { margin-top: 3px; font-size: 13px; }
.notice-status.unread { color: var(--el-color-primary-dark-2); }
.notification-row .notice-action { padding-right: 16px; text-align: right; }
.notice-action .el-button { padding: 2px 0; font-size: 13px; }
.notifications-pagination { display: flex; align-items: center; justify-content: space-between; flex-wrap: wrap; gap: 12px; min-height: 70px; padding: 16px 0; }
.notifications-pagination .el-pagination { min-width: 0; margin-left: auto; }
.range-summary { color: var(--el-text-color-regular); font-size: 13px; }
.notifications-hint { margin: 12px 2px 0; color: var(--el-text-color-secondary); font-size: 12px; }
.notification-state { display: flex; flex-direction: column; align-items: center; justify-content: center; gap: 8px; min-height: 340px; padding: 36px 16px; text-align: center; }
.state-icon { display: grid; place-items: center; width: 56px; height: 56px; margin-bottom: 8px; border-radius: 50%; background: var(--el-fill-color-light); color: #a8b6c8; font-size: 26px; }
.notification-state strong { font-size: 15px; font-weight: 500; }
.notification-state p { max-width: 100%; margin: 0 0 8px; color: var(--el-text-color-regular); font-size: 13px; overflow-wrap: anywhere; }
.notification-state.is-error .state-icon { background: var(--el-color-danger-light-9); color: var(--el-color-danger); }
button:focus-visible { outline: 2px solid var(--el-color-primary); outline-offset: 3px; }
button:disabled { cursor: not-allowed; }
@media (min-width: 769px) and (max-width: 1100px) {
  .notifications-heading { align-items: flex-start; flex-wrap: wrap; }
  .notifications-actions { margin-left: auto; }
  .notification-table-heading, .notification-row { grid-template-columns: 105px minmax(0, 1fr) 65px; }
  .notification-table-heading .time-heading, .notification-table-heading .status-heading { display: none; }
  .notification-row { grid-template-areas: 'type content action' 'type time status'; row-gap: 8px; }
  .notice-type { grid-area: type; }
  .notice-content { grid-area: content; }
  .notice-time { grid-area: time; }
  .notice-status { grid-area: status; }
  .notice-action { grid-area: action; }
  .notification-row > div { padding-right: 8px; padding-left: 8px; }
  .notification-row .notice-status { padding-left: 0; }
}
@media (max-width: 768px) {
  .notifications-heading { display: block; padding-bottom: 12px; }
  .subtitle { font-size: 12px; }
  .notifications-actions { justify-content: flex-end; margin-top: 16px; }
  .filter-tabs { gap: 22px; }
  .sort-hint { font-size: 11px; }
  .notification-scroll { max-height: none; overflow: visible; }
  .notification-table-heading { display: none; }
  .notification-row { grid-template-columns: minmax(0, 1fr) auto; grid-template-areas: 'type status' 'content content' 'time action'; gap: 8px; padding: 14px 0; }
  .notification-row > div, .notification-row .notice-type, .notification-row .notice-action { padding: 0; }
  .notice-type { grid-area: type; }
  .notice-content { grid-area: content; }
  .notice-time { grid-area: time; }
  .notice-status { grid-area: status; justify-content: flex-end; }
  .notice-action { grid-area: action; }
  .notifications-pagination { gap: 12px; }
  .range-summary { flex-basis: 100%; }
  .notifications-pagination .el-pagination { margin-left: 0; }
  .notifications-pagination :deep(.el-pagination__sizes) { margin-right: 6px; }
  .notifications-pagination :deep(.el-pagination__sizes .el-select) { width: 94px; }
  .notifications-pagination :deep(.el-pager li), .notifications-pagination :deep(.btn-prev), .notifications-pagination :deep(.btn-next) { min-width: 26px; margin: 0 2px; }
  .notification-state { min-height: 330px; }
}
@media (prefers-reduced-motion: reduce) { .notification-state .is-loading { animation: none; } }
</style>
