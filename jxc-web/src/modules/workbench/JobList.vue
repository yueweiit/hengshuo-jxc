<script setup lang="ts">
import { computed, onBeforeUnmount, onMounted, ref } from 'vue'
import { ElMessage } from 'element-plus'
import { http, createCommandIntent } from '@/api/http'
import { allRecords } from '@/api/pagination'
import DateTimeText from '@/components/DateTimeText.vue'
import { statusDef } from '@/utils/status'
import { useCountryStore } from '@/stores/country'
import { useUserStore } from '@/stores/user'

interface JobRow {
  id: number
  jobType: string
  status: string
  bookId?: number
  createdAt?: string | null
  expiresAt?: string | null
  lastError?: string | null
}
interface DownloadResult { filename: string; content: string; contentType?: string }

const country = useCountryStore(), user = useUserStore()
const canView = computed(() => user.hasPerm(['sys:export:view', 'fin:report:export']))
const typeLabels: Record<string, string> = { FIN_REPORT_EXPORT: '财务报表', FIN_LEDGER_EXPORT: '财务账簿', AR_STATEMENT_EXPORT: '应收对账单', AP_STATEMENT_EXPORT: '应付对账单' }
const jobStates: Record<string, { label: string; type: 'success' | 'primary' | 'warning' }> = {
  SUCCESS: { label: '已完成', type: 'success' }, COMPLETED: { label: '已完成', type: 'success' }, SUCCEEDED: { label: '已完成', type: 'success' },
  RUNNING: { label: '处理中', type: 'primary' }, QUEUED: { label: '排队中', type: 'warning' },
}
const rows = ref<JobRow[]>([]), page = ref(1), size = ref(20)
const keyword = ref(''), appliedKeyword = ref(''), typeFilter = ref(''), activeStatus = ref('all')
const loading = ref(false), listError = ref(''), listForbidden = ref(false)
const lastRefreshedAt = ref<string | null>(null)
const actionError = ref(''), retryingId = ref<number | null>(null), downloadingId = ref<number | null>(null)
const selectedRow = ref<JobRow | null>(null), detailOpen = ref(false), compact = ref(false)
const retryIntent = createCommandIntent()
const actionBusy = computed(() => retryingId.value !== null || downloadingId.value !== null)
const successStates = ['SUCCESS', 'COMPLETED', 'SUCCEEDED']
function matchesStatus(row: JobRow, status: string) {
  return status === 'all' || (status === 'active' ? ['QUEUED', 'RUNNING'].includes(row.status) : status === 'SUCCESS' ? successStates.includes(row.status) : row.status === status)
}
const statusTabs = computed(() => [
  { value: 'all', label: '全部任务' }, { value: 'active', label: '处理中' }, { value: 'SUCCESS', label: '已完成' }, { value: 'FAILED', label: '失败' }, { value: 'EXPIRED', label: '已过期' },
].map(tab => ({ ...tab, count: rows.value.filter(row => matchesStatus(row, tab.value)).length })))
const filteredRows = computed(() => rows.value.filter(row => matchesStatus(row, activeStatus.value)
  && (!typeFilter.value || row.jobType === typeFilter.value)
  && `${row.id} ${jobLabel(row.jobType)} ${row.jobType}`.toLowerCase().includes(appliedKeyword.value)))
const pageRows = computed(() => filteredRows.value.slice((page.value - 1) * size.value, page.value * size.value))
const typeOptions = computed(() => [...new Set([...Object.keys(typeLabels), ...rows.value.map(row => row.jobType)])])
function jobLabel(type: string) { return typeLabels[type] ?? type }
function jobState(status: string) { return jobStates[status] ?? statusDef(status) }
function canDownload(row: JobRow) { return successStates.includes(row.status) }
function canRetry(row: JobRow) { return ['QUEUED', 'FAILED'].includes(row.status) && row.lastError !== 'JOB_CONTEXT_CHANGED' }
function processingHint(row: JobRow) {
  if (row.status === 'EXPIRED') return { text: '导出文件已过期', detail: '请返回原业务页面重新发起导出。' }
  if (row.lastError === 'JOB_CONTEXT_CHANGED') return { text: '会计期间或结账代次已变化', detail: '请返回原业务页面重新发起导出。' }
  if (row.status === 'FAILED') return { text: '导出处理失败，可重试', detail: row.lastError ? `诊断代码：${row.lastError}` : '请重试；若仍失败，请联系管理员。' }
  if (canDownload(row)) return { text: '文件已生成，可下载', detail: '' }
  if (row.status === 'RUNNING') return { text: '正在生成导出文件', detail: '稍后刷新查看最新状态。' }
  if (row.status === 'QUEUED') return { text: '等待后台处理', detail: '如长时间未开始，可重试或联系管理员。' }
  return { text: '状态待确认', detail: row.lastError ?? '请刷新查看最新状态，或联系管理员。' }
}
function clampPage() { page.value = Math.max(1, Math.min(page.value, Math.ceil(filteredRows.value.length / size.value) || 1)) }
function search() { appliedKeyword.value = keyword.value.trim().toLowerCase(); page.value = 1 }
function resetFilters() { keyword.value = ''; typeFilter.value = ''; activeStatus.value = 'all'; search() }
function changePage(value: number) { page.value = value; clampPage() }
function changeSize(value: number) { if ([20, 50, 100].includes(value)) { size.value = value; page.value = 1 } }
function openDetail(row: JobRow) { selectedRow.value = row; actionError.value = ''; detailOpen.value = true }
function errorMessage(error: unknown, fallback: string) { return error instanceof Error && error.message ? error.message : fallback }
function isForbidden(error: unknown) { return typeof error === 'object' && error !== null && 'code' in error && error.code === 'SYS_FORBIDDEN' }

let disposed = false, listRequest = 0
function current(epoch: number) { return !disposed && country.epoch === epoch }
async function loadJobs() {
  if (!country.current || !canView.value) return
  const request = ++listRequest, epoch = country.epoch
  loading.value = true; listError.value = ''; listForbidden.value = false
  try {
    const result = await allRecords<JobRow>('/sys/jobs', {}, () => {
      if (!current(epoch) || request !== listRequest) throw new Error('任务列表所属页面已变化')
    })
    if (!current(epoch) || request !== listRequest) return
    rows.value = result; clampPage(); lastRefreshedAt.value = new Date().toISOString()
    if (selectedRow.value) {
      selectedRow.value = result.find(row => row.id === selectedRow.value?.id) ?? null
      if (!selectedRow.value) detailOpen.value = false
    }
  } catch (error) {
    if (!current(epoch) || request !== listRequest) return
    rows.value = []; selectedRow.value = null; detailOpen.value = false
    listError.value = errorMessage(error, '任务加载失败，请重试'); listForbidden.value = isForbidden(error)
  } finally { if (current(epoch) && request === listRequest) loading.value = false }
}
async function retry(row: JobRow) {
  if (!canRetry(row) || actionBusy.value || loading.value || !canView.value || !country.current) return
  const epoch = country.epoch
  retryingId.value = row.id; actionError.value = ''
  try {
    await http.postIdem(`/sys/jobs/${row.id}/retry`, {}, retryIntent, { silent: true })
    if (!current(epoch)) return
    retryIntent.reset(); ElMessage.success('重试请求已提交，任务状态以刷新结果为准')
    await loadJobs()
  } catch (error) { if (current(epoch)) actionError.value = `重试失败：${errorMessage(error, '请稍后重试')}` }
  finally { if (current(epoch)) retryingId.value = null }
}
async function download(row: JobRow) {
  if (!canDownload(row) || actionBusy.value || loading.value || !canView.value || !country.current) return
  const epoch = country.epoch
  downloadingId.value = row.id; actionError.value = ''
  try {
    const result = await http.get<DownloadResult>(`/sys/jobs/${row.id}/download`, undefined, { silent: true })
    if (!current(epoch)) return
    if (!result || typeof result.filename !== 'string' || !result.filename.trim() || typeof result.content !== 'string') throw new Error('下载响应缺少文件名或文件内容，请重试')
    // Existing export handlers return textual CSV; an absent media type keeps that explicit format.
    const url = URL.createObjectURL(new Blob([result.content], { type: result.contentType || 'text/csv; charset=UTF-8' }))
    try { const anchor = document.createElement('a'); anchor.href = url; anchor.download = result.filename; anchor.click() }
    finally { setTimeout(() => URL.revokeObjectURL(url), 1000) }
    ElMessage.success('已开始下载导出文件')
  } catch (error) { if (current(epoch)) actionError.value = `下载失败：${errorMessage(error, '请稍后重试')}` }
  finally { if (current(epoch)) downloadingId.value = null }
}

let media: MediaQueryList | undefined
function updateCompact(event: MediaQueryList | MediaQueryListEvent) { compact.value = event.matches }
onMounted(() => {
  media = window.matchMedia('(max-width: 768px)'); updateCompact(media); media.addEventListener('change', updateCompact)
  loadJobs()
})
onBeforeUnmount(() => { disposed = true; media?.removeEventListener('change', updateCompact) })
</script>

<template>
  <div class="page export-jobs">
    <div v-if="!country.current || !canView" class="page-card">
      <el-empty :description="!country.current ? '请先选择有权限的国家' : '没有导出任务查看权限'"><p class="muted">请联系管理员确认国家、角色和数据范围。</p></el-empty>
    </div>
    <template v-else>
      <section class="page-card jobs-card" aria-labelledby="jobs-title">
        <div class="page-title">
          <div><h2 id="jobs-title">导出任务</h2><p class="subtitle">查看导出进度，下载已生成的文件。</p></div>
          <el-button type="primary" :loading="loading" :disabled="actionBusy" @click="loadJobs"><el-icon v-if="!loading"><Refresh /></el-icon><span>刷新任务</span></el-button>
        </div>
        <div class="context-note"><el-icon><InfoFilled /></el-icon><span>请从已选择账套、期间的业务页面发起导出。这里只显示当前国家下你有权限查看的本人任务，下载时将重新核验权限。</span></div>
        <div class="status-tabs" role="group" aria-label="按任务状态筛选">
          <button v-for="tab in statusTabs" :key="tab.value" type="button" :aria-pressed="activeStatus === tab.value" :disabled="loading || !!listError" @click="activeStatus = tab.value; search()">{{ tab.label }}<span class="tab-count">{{ loading || listError ? '—' : tab.count }}</span></button>
        </div>
        <el-form class="filters" :inline="true" @submit.prevent="search">
          <el-form-item label="任务类型" class="type-field"><el-select v-model="typeFilter" aria-label="任务类型" :empty-values="[null, undefined]" :disabled="loading" @change="search"><el-option label="全部类型" value="" /><el-option v-for="type in typeOptions" :key="type" :label="jobLabel(type)" :value="type" /></el-select></el-form-item>
          <el-form-item label="关键词" class="keyword-field"><el-input v-model="keyword" aria-label="任务编号或类型" placeholder="任务编号 / 类型" :disabled="loading" clearable @clear="search"><template #prefix><el-icon><Search /></el-icon></template></el-input></el-form-item>
          <el-form-item class="filter-actions"><el-button native-type="submit" :disabled="loading">搜索</el-button><el-button text :disabled="loading" @click="resetFilters">重置</el-button></el-form-item>
        </el-form>
        <el-alert v-if="actionError && !detailOpen" :title="actionError" type="error" show-icon class="action-error" @close="actionError = ''" />
        <div v-if="listError" class="list-error" role="alert"><el-result icon="error" :title="listForbidden ? '没有查看权限' : '任务加载失败'" :sub-title="listError"><template v-if="!listForbidden" #extra><el-button @click="loadJobs">重新加载</el-button></template></el-result></div>
        <el-table v-else v-loading="loading" :data="pageRows" row-key="id" border stripe class="jobs-table" :max-height="compact ? 460 : 'max(300px, calc(100dvh - 570px))'" aria-label="导出任务列表">
          <el-table-column label="导出任务" :min-width="compact ? 105 : 200"><template #default="{ row }"><div class="task-name"><span class="file-symbol"><el-icon><Document /></el-icon></span><span>{{ jobLabel(row.jobType) }}</span></div><div class="task-id mono">#{{ row.id }}</div></template></el-table-column>
          <el-table-column v-if="!compact" label="发起时间" width="210"><template #default="{ row }"><DateTimeText :value="row.createdAt" /></template></el-table-column>
          <el-table-column label="状态" :width="compact ? 74 : 100"><template #default="{ row }"><el-tag :type="jobState(row.status).type" size="small" disable-transitions>{{ jobState(row.status).label }}</el-tag></template></el-table-column>
          <el-table-column v-if="!compact" label="处理提示" min-width="245"><template #default="{ row }"><div class="processing-hint" :class="{ 'failed-hint': row.status === 'FAILED' }">{{ processingHint(row).text }}</div><div v-if="canDownload(row)" class="hint-detail">有效至 <DateTimeText :value="row.expiresAt" /></div><div v-else class="hint-detail">{{ processingHint(row).detail }}</div></template></el-table-column>
          <el-table-column label="操作" :width="compact ? 100 : 140" align="right" fixed="right"><template #default="{ row }"><div class="row-actions"><el-button v-if="canDownload(row)" link type="primary" :loading="downloadingId === row.id" :disabled="actionBusy || loading" @click="download(row)">下载</el-button><el-button v-if="canRetry(row)" link type="primary" :loading="retryingId === row.id" :disabled="actionBusy || loading" @click="retry(row)">重试</el-button><el-button link type="primary" :disabled="loading" @click="openDetail(row)">详情</el-button></div></template></el-table-column>
          <template #empty><el-empty v-if="!loading" :description="rows.length ? '没有匹配的任务' : '暂无导出任务'" :image-size="60"><p class="empty-help">{{ rows.length ? '试试其他关键词、任务类型或状态。' : '请先在已选择账套、期间的业务页面发起导出。' }}</p><el-button v-if="rows.length" @click="resetFilters">清空筛选</el-button></el-empty></template>
        </el-table>
        <div class="pagination"><span class="result-total">共 <strong>{{ loading || listError ? '—' : filteredRows.length }}</strong> 条任务</span><el-pagination background :small="compact" :current-page="page" :page-size="size" :page-sizes="[20, 50, 100]" :total="filteredRows.length" :pager-count="5" layout="sizes, prev, pager, next" :disabled="loading || !!listError || !filteredRows.length" @current-change="changePage" @size-change="changeSize" /></div>
      </section>
      <div class="page-foot"><span>时间按当前国家时区显示：{{ country.timezone }}</span><span>最近刷新：<DateTimeText :value="lastRefreshedAt" /></span></div>
    </template>
    <el-drawer v-model="detailOpen" title="任务详情" size="min(480px, 100vw)" destroy-on-close>
      <template v-if="selectedRow"><div class="detail-heading"><h3>{{ jobLabel(selectedRow.jobType) }}</h3><el-tag :type="jobState(selectedRow.status).type" size="small">{{ jobState(selectedRow.status).label }}</el-tag></div><dl class="detail-list"><dt>任务编号</dt><dd class="mono">#{{ selectedRow.id }}</dd><dt>任务类型</dt><dd>{{ jobLabel(selectedRow.jobType) }}<span class="detail-subline mono">{{ selectedRow.jobType }}</span></dd><dt>账套编号</dt><dd>{{ selectedRow.bookId ?? '-' }}</dd><dt>发起时间</dt><dd><DateTimeText :value="selectedRow.createdAt" /></dd><dt>到期时间</dt><dd><DateTimeText :value="selectedRow.expiresAt" /></dd><dt>诊断代码</dt><dd class="mono">{{ selectedRow.lastError || '-' }}</dd></dl><div class="detail-note"><strong>{{ processingHint(selectedRow).text }}</strong><p>{{ processingHint(selectedRow).detail }}</p></div><el-alert v-if="actionError" :title="actionError" type="error" show-icon @close="actionError = ''" /></template>
      <template #footer><el-button @click="detailOpen = false">关闭</el-button><el-button v-if="selectedRow && canRetry(selectedRow)" type="primary" :loading="retryingId === selectedRow.id" :disabled="actionBusy || loading" @click="retry(selectedRow)">重试</el-button><el-button v-if="selectedRow && canDownload(selectedRow)" type="primary" :loading="downloadingId === selectedRow.id" :disabled="actionBusy || loading" @click="download(selectedRow)">下载</el-button></template>
    </el-drawer>
  </div>
</template>

<style scoped lang="scss">
.export-jobs { color: var(--el-text-color-primary); }
.jobs-card { padding: 20px; }
.page-title { align-items: flex-start; margin-bottom: 16px; }
.page-title .el-button { margin-top: 10px; }
.page-title .el-button span { margin-left: 6px; }
.subtitle { margin: 7px 0 0; font-size: 13px; line-height: 1.6; color: var(--el-text-color-regular); }
.context-note { display: flex; align-items: flex-start; gap: 8px; padding: 11px 12px; background: var(--el-fill-color-light); border-radius: 4px; color: var(--el-text-color-regular); font-size: 12px; line-height: 1.7; }
.context-note .el-icon { margin-top: 3px; flex: none; color: var(--el-text-color-secondary); }
.status-tabs { display: flex; gap: 24px; margin-top: 12px; border-bottom: 1px solid var(--el-border-color-lighter); overflow-x: auto; }
.status-tabs button { display: flex; align-items: center; gap: 8px; position: relative; padding: 12px 0; background: none; border: 0; color: var(--el-text-color-regular); font: inherit; font-size: 13px; white-space: nowrap; cursor: pointer; }
.status-tabs button:disabled { cursor: not-allowed; }
.status-tabs button[aria-pressed='true'] { color: var(--el-color-primary); font-weight: 600; }
.status-tabs button[aria-pressed='true']::after { content: ''; position: absolute; bottom: 0; left: 0; right: 0; height: 2px; background: var(--el-color-primary); }
.tab-count { font-size: 11px; line-height: 19px; min-width: 22px; border-radius: 4px; padding: 0 6px; background: var(--el-fill-color-light); font-variant-numeric: tabular-nums; font-weight: 400; }
[aria-pressed='true'] .tab-count { background: var(--el-color-primary-light-9); }
.status-tabs button:focus-visible { outline: 2px solid var(--el-color-primary); outline-offset: -3px; }
.filters { display: flex; flex-wrap: wrap; gap: 12px; padding: 16px 0; }
.filters :deep(.el-form-item) { margin: 0; }
.type-field { width: 235px; }
.keyword-field { width: 290px; }
.filters :deep(.el-select), .filters :deep(.el-input) { width: 100%; }
.filter-actions :deep(.el-button + .el-button) { margin-left: 4px; }
.action-error { margin-bottom: 12px; }
.jobs-table { width: 100%; font-size: 13px; }
.jobs-table :deep(th.el-table__cell) { background: var(--el-fill-color-light); font-size: 12px; font-weight: 500; }
.jobs-table :deep(td.el-table__cell) { padding: 12px 0; }
.task-name { display: flex; gap: 8px; align-items: center; color: var(--el-text-color-primary); }
.file-symbol { display: flex; align-items: center; justify-content: center; width: 28px; height: 28px; flex: none; background: var(--el-color-primary-light-9); border-radius: 4px; color: var(--el-color-primary); }
.task-id { margin-top: 2px; padding-left: 36px; font-size: 11px; color: var(--el-text-color-secondary); }
.processing-hint { font-size: 12px; line-height: 1.7; }
.failed-hint { color: var(--el-color-danger); }
.hint-detail { color: var(--el-text-color-secondary); font-size: 12px; line-height: 1.7; overflow-wrap: anywhere; }
.row-actions { display: flex; gap: 12px; justify-content: flex-end; flex-wrap: wrap; }
.row-actions :deep(.el-button + .el-button) { margin-left: 0; }
.row-actions :deep(.el-button) { font-size: 13px; }
.empty-help { font-size: 12px; color: var(--el-text-color-secondary); margin: 0 0 12px; }
.pagination { display: flex; align-items: center; justify-content: space-between; gap: 12px; padding-top: 16px; flex-wrap: wrap; }
.result-total { font-size: 12px; color: var(--el-text-color-regular); }
.page-foot { display: flex; justify-content: space-between; gap: 8px; flex-wrap: wrap; margin-top: 12px; color: var(--el-text-color-secondary); font-size: 12px; line-height: 1.7; }
.detail-heading { display: flex; justify-content: space-between; gap: 12px; margin-bottom: 24px; }
.detail-heading h3 { margin: 0; font-size: 15px; }
.detail-list { display: grid; grid-template-columns: 85px minmax(0, 1fr); gap: 16px 0; font-size: 13px; line-height: 1.7; }
.detail-list dt { color: var(--el-text-color-secondary); }
.detail-list dd { margin: 0; overflow-wrap: anywhere; }
.detail-subline { display: block; color: var(--el-text-color-secondary); font-size: 12px; }
.detail-note { padding: 12px; border-radius: 4px; background: var(--el-fill-color-light); margin: 24px 0 16px; font-size: 13px; line-height: 1.7; }
.detail-note p { margin: 4px 0 0; color: var(--el-text-color-regular); }
@media (max-width: 768px) {
  .jobs-card { padding: 16px 12px; }
  .page-title { gap: 8px; }
  .page-title .el-button { padding-left: 8px; padding-right: 8px; font-size: 12px; margin-top: 0; }
  .subtitle { font-size: 12px; }
  .status-tabs { gap: 20px; }
  .status-tabs button { font-size: 12px; }
  .filters { gap: 12px 8px; }
  .type-field { width: 100%; }
  .keyword-field { flex: 1; min-width: 100px; }
  .keyword-field :deep(.el-form-item__label) { display: none; }
  .filter-actions :deep(.el-button) { padding-left: 8px; padding-right: 8px; font-size: 12px; }
  .jobs-table :deep(.cell) { padding: 0 7px; }
  .jobs-table :deep(td.el-table__cell) { padding: 14px 0; }
  .task-name { font-size: 12px; }
  .file-symbol { display: none; }
  .task-id { padding-left: 0; }
  .row-actions { gap: 8px; }
  .row-actions :deep(.el-button) { font-size: 12px; }
  .pagination { gap: 12px; }
  .result-total { width: 100%; }
  .pagination :deep(.el-pagination) { width: 100%; flex-wrap: wrap; justify-content: flex-end; gap: 8px 0; }
  .pagination :deep(.el-pagination__sizes) { width: 100%; margin: 0; display: flex; justify-content: flex-end; }
  .page-foot { font-size: 11px; }
}
</style>
