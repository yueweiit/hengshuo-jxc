<script setup lang="ts">
import { computed, onMounted, reactive, ref, watch } from 'vue'
import { useRoute } from 'vue-router'
import { ElMessage } from 'element-plus'
import { http, createCommandIntent } from '@/api/http'
import { allRecords } from '@/api/pagination'
import type { PageResult } from '@/api/types'
import StatusTag from '@/components/StatusTag.vue'
import ApprovalPanel from '@/components/ApprovalPanel.vue'
import MoneyText from '@/components/MoneyText.vue'
import QtyText from '@/components/QtyText.vue'
import ProductCell from '@/components/biz/ProductCell.vue'
import { useCountryStore } from '@/stores/country'
import { useUserStore } from '@/stores/user'
import { formatDate, todayIn } from '@/utils/format'
import { getCountryId, getToken } from '@/utils/session'
import AdjustmentBatchPicker from './AdjustmentBatchPicker.vue'
import CostTraceDrawer from './CostTraceDrawer.vue'

type Row = Record<string, any> // eslint-disable-line @typescript-eslint/no-explicit-any
const country = useCountryStore(), user = useUserStore(), mockMode = import.meta.env.MODE === 'demo' && import.meta.env.VITE_USE_MOCK === 'true'
const route = useRoute()
const rows = ref<Row[]>([]), loading = ref(false), listError = ref(''), total = ref(0)
const query = reactive({ target: '', status: '', page: 1, size: 20 })
const form = reactive({ reason: '', target: 'INVENTORY', amount: 0, batchId: null as number | null, bizDate: todayIn(country.timezone) })
const selectedBatch = ref<Row | null>(null), picker = ref<InstanceType<typeof AdjustmentBatchPicker>>(), trace = ref<InstanceType<typeof CostTraceDrawer>>()
const formError = ref(''), mutationError = ref(''), busy = ref(false), detail = ref<Row | null>(null), created = ref<Row | null>(null)
const saveIntent = createCommandIntent(), confirmIntent = createCommandIntent()
const mockDraft = ref<Row | null>(null), mockDraftInput = ref('')
const canWrite = computed(() => user.hasPerm('cst:adjustment:create') && user.fieldAccess('COST') === 'WRITE')
const positiveId = (value: unknown) => /^[1-9]\d*$/.test(String(value)) && Number.isSafeInteger(Number(value)) ? Number(value) : undefined
const activeBook = computed(() => positiveId(route.query.bookId))
let listRequest = 0
const listContext = () => `${country.epoch}:${getCountryId()}:${getToken()}:${route.query.sourceId ?? ''}:${route.query.bookId ?? ''}`

async function load() {
  const request = ++listRequest, scope = listContext(), source = route.query.sourceId
  const current = () => request === listRequest && scope === listContext()
  rows.value = []; detail.value = null; total.value = 0; loading.value = true; listError.value = ''
  try {
    const id = positiveId(source), book = positiveId(route.query.bookId)
    if (source != null && (!id || !book)) { listError.value = '来源单据或账套编号不正确，无法定位调整记录'; return }
    const params = { ...(book ? { bookId: book } : {}), target: query.target || undefined, status: query.status || undefined }
    const result = source != null
      ? { records: (await allRecords<Row>('/cst/adjustments', book ? { bookId: book } : {})).filter(row => row.id === id && row.bookId === book), total: 1 }
      : await http.get<PageResult<Row>>('/cst/adjustments', { ...params, page: query.page, size: query.size }, { silent: true })
    if (!current()) return
    if (!mockMode) await Promise.all(result.records.filter(row => row.sourceType === 'MANUAL' && row.status !== 'CONFIRMED').map(async row => {
      const instances = await http.get<Row[]>('/wf/instances', { docType: 'COST_ADJUSTMENT', docId: row.id }, { silent: true })
      row.approvalStatus = instances[0]?.status
    }))
    if (!current()) return
    rows.value = result.records; total.value = source != null ? result.records.length : result.total
    if (created.value) created.value = result.records.find(row => row.id === created.value?.id) ?? created.value
  } catch (error) { if (current()) listError.value = error instanceof Error ? error.message : '调整记录读取失败，请重试' }
  finally { if (current()) loading.value = false }
}
function search() { query.page = 1; load() }
function clearBatch() { selectedBatch.value = null; form.batchId = null; formError.value = '' }
function selectBatch(row: Row) {
  if (busy.value || row.selectable !== true || !positiveId(row.batchId) || (activeBook.value && row.bookId !== activeBook.value)) return
  selectedBatch.value = row; form.batchId = row.batchId; formError.value = ''
}
watch(() => form.target, () => { clearBatch(); form.amount = 0 })
watch(() => [route.query.sourceId, route.query.bookId, country.epoch, user.token], () => {
  clearBatch(); created.value = null; mockDraft.value = null; mockDraftInput.value = ''; busy.value = false; mutationError.value = ''
  form.amount = 0; form.reason = ''; form.bizDate = todayIn(country.timezone); query.page = 1
  saveIntent.reset(); confirmIntent.reset(); load()
})
async function create() {
  if (busy.value) return
  formError.value = ''; mutationError.value = ''
  if (!selectedBatch.value || !form.batchId) { formError.value = '请先选择成本批次'; return }
  if (!Number.isFinite(form.amount) || form.amount === 0) { formError.value = '请填写非零调整金额，正数调增、负数调减'; return }
  if (!form.reason.trim()) { formError.value = '请填写调整原因'; return }
  if (!form.bizDate) { formError.value = '请选择业务日期'; return }
  if (!canWrite.value) { formError.value = '需要成本调整权限及成本字段修改权限'; return }
  busy.value = true
  const scope = listContext()
  try {
    const payload = { ...form, reason: form.reason.trim() }, fingerprint = JSON.stringify(payload)
    const row = mockMode && mockDraft.value && mockDraftInput.value === fingerprint ? mockDraft.value : await http.postIdem<Row>('/cst/adjustments', payload, saveIntent, { silent: true })
    if (scope !== listContext()) return
    created.value = row; saveIntent.reset()
    if (mockMode) {
      mockDraft.value = row; mockDraftInput.value = fingerprint
      const confirmed = await http.postIdem<Row>('/cst/adjustments/' + row.id + '/confirm', {}, confirmIntent, { silent: true })
      if (scope !== listContext()) return
      created.value = confirmed; confirmIntent.reset(); mockDraft.value = null; mockDraftInput.value = ''
    }
    form.amount = 0; form.reason = ''; clearBatch()
    await load()
    if (scope === listContext()) ElMessage.success(created.value?.status === 'CONFIRMED' ? '调整已确认' : '调整已保存，请完成审批后确认')
  } catch (error) { if (scope === listContext()) mutationError.value = error instanceof Error ? error.message : '保存调整失败，请重试' }
  finally { if (scope === listContext()) busy.value = false }
}
async function confirm(row: Row) {
  if (busy.value) return
  busy.value = true; mutationError.value = ''
  const scope = listContext()
  try {
    const updated = await http.postIdem<Row>('/cst/adjustments/' + row.id + '/confirm', {}, confirmIntent, { silent: true })
    if (scope !== listContext()) return
    confirmIntent.reset(); created.value = updated; await load()
    if (scope !== listContext()) return
    if (updated.status === 'CONFIRMED') ElMessage.success('调整已确认')
    else ElMessage.info('调整尚未确认，请查看审批状态')
  } catch (error) { if (scope === listContext()) mutationError.value = error instanceof Error ? error.message : '确认调整失败，请重试' }
  finally { if (scope === listContext()) busy.value = false }
}
const displayStatus = (row: Row) => row.status === 'CONFIRMED' ? row.status : row.approvalStatus && row.approvalStatus !== 'PENDING' ? row.approvalStatus : row.status
const targetLabel = (value: string) => ({ INVENTORY: '库存成本', COGS: '已售成本', MIXED: '库存与已售成本' }[value] ?? value)
const reasonLabel = (value: string) => ({ ACTUAL_VS_ESTIMATE: '暂估与实际差额', MANUAL: '手工调整', RATE_CORRECTION: '汇率更正' }[value] ?? value)
onMounted(load)
</script>

<template>
  <div class="page adjustment-page">
    <section class="page-card">
      <div class="page-title"><h2>成本调整</h2><el-tag type="info" effect="plain">{{ mockMode ? '演示模式' : '审批后确认生效' }}</el-tag></div>
      <p class="page-description">为指定批次补记成本差额。库存部分调整批次成本，已售部分计入当期已售成本。</p>
      <el-alert v-if="created" :type="created.status === 'CONFIRMED' ? 'success' : 'info'" :closable="false" class="feedback"><template #title>调整 {{ created.docNo }} <StatusTag :status="displayStatus(created)" />{{ created.status === 'CONFIRMED' ? '；已确认。' : '；已保存，审批通过后仍须确认才会生效。' }}</template></el-alert>
      <el-alert v-if="mutationError" :title="mutationError" type="error" :closable="false" class="feedback" show-icon />
      <el-alert v-if="!canWrite" title="当前账号缺少成本调整或成本字段修改权限，可查看已有记录。" type="warning" :closable="false" class="feedback" />
      <el-form label-position="top" :disabled="busy || !canWrite" @submit.prevent="create">
        <div class="form-grid">
          <el-form-item label="调整对象" required><el-select v-model="form.target"><el-option label="库存成本" value="INVENTORY" /><el-option label="已售成本" value="COGS" /></el-select></el-form-item>
          <el-form-item label="业务日期" required><el-date-picker v-model="form.bizDate" type="date" value-format="YYYY-MM-DD" placeholder="选择开放期间内的日期" /></el-form-item>
          <el-form-item class="batch-field" label="成本批次" required>
            <div class="batch-choice">
              <el-button type="primary" plain :disabled="busy || !canWrite" @click="picker?.open()">{{ selectedBatch ? '重新选择批次' : '选择批次' }}</el-button>
              <span v-if="selectedBatch" class="mono">{{ selectedBatch.batchNo }} <span class="muted">#{{ selectedBatch.batchId }}</span></span>
              <span v-else class="muted">从已有成本批次中选择，无需填写内部编号</span>
            </div>
          </el-form-item>
        </div>
        <div v-if="selectedBatch" class="batch-summary">
          <div><span class="summary-label">商品</span><ProductCell :code="selectedBatch.productCode" :name="selectedBatch.productName" :extra="selectedBatch.spec" /></div>
          <div><span class="summary-label">账套 / 来源仓库</span>{{ selectedBatch.bookName }} · {{ selectedBatch.warehouseName }}</div>
          <div><span class="summary-label">全批次当前库存</span><QtyText :value="selectedBatch.onHandQty" :unit="selectedBatch.baseUnit" /><div class="muted">{{ selectedBatch.currentWarehouses || '当前无库存存放仓库' }}</div></div>
          <div><span class="summary-label">来源单位成本</span><span class="mono">{{ selectedBatch.unitCost ?? '待补' }} {{ selectedBatch.baseCurrency }}</span></div>
        </div>
        <p class="scope-note">{{ form.target === 'INVENTORY' ? '库存调整会按该批次各仓库存量分配，来源仓库筛选仅用于查找批次；冻结库存也包含在内。' : '已售成本调整允许选择已无库存的历史批次，不会改写原出库成本快照。' }} 最终确认时会重新校验库存、成本及业务期间。</p>
        <div class="form-grid">
          <el-form-item label="调整金额" required><el-input-number v-model="form.amount" :precision="4" :step="1" controls-position="right" /><div class="field-help">{{ selectedBatch ? selectedBatch.baseCurrency : '按所选批次的本位币' }} · 填写总调整额；正数调增，负数调减</div></el-form-item>
          <el-form-item label="调整原因" required><el-input v-model="form.reason" maxlength="500" placeholder="例如：补记实际运费与暂估的差额" /></el-form-item>
        </div>
        <el-alert v-if="formError" :title="formError" type="warning" :closable="false" class="feedback" show-icon />
        <div class="form-actions"><span class="muted">提交后进入原审批流程，不改动已结账期间。</span><el-button type="primary" native-type="submit" :loading="busy" :disabled="!canWrite">{{ mockMode ? '确认调整' : '保存并提交审批' }}</el-button></div>
      </el-form>
    </section>

    <section class="page-card">
      <div class="page-title"><h2>调整记录</h2><div class="record-actions"><router-link v-if="!mockMode" to="/approval/todo">审批待办</router-link><el-button :loading="loading" :disabled="busy" @click="load">刷新记录</el-button></div></div>
      <p v-if="route.query.sourceId != null" class="muted">来源定位 #{{ route.query.sourceId }} · 账套 #{{ route.query.bookId ?? '未指定' }}；仅显示授权范围内的匹配记录。</p>
      <el-form v-else inline class="search-form" :disabled="loading || busy" @submit.prevent="search">
        <el-form-item label="调整对象"><el-select v-model="query.target" clearable placeholder="全部对象" @change="search"><el-option label="库存成本" value="INVENTORY" /><el-option label="已售成本" value="COGS" /><el-option label="库存与已售成本" value="MIXED" /></el-select></el-form-item>
        <el-form-item label="单据状态"><el-select v-model="query.status" clearable placeholder="全部状态" @change="search"><el-option label="待审批 / 确认" value="PENDING_APPROVAL" /><el-option label="已确认" value="CONFIRMED" /></el-select></el-form-item>
      </el-form>
      <div v-if="listError" class="query-error" role="alert"><el-alert :title="listError" type="error" :closable="false" show-icon /><el-button @click="load">重新加载</el-button></div>
      <template v-else>
        <div class="table-scroll" v-loading="loading" :aria-busy="loading">
          <el-table :data="rows" border stripe row-key="id" :empty-text="loading ? '正在读取调整记录…' : '没有匹配的调整记录'">
            <el-table-column prop="docNo" label="调整单号" min-width="185" fixed="left" show-overflow-tooltip />
            <el-table-column label="批次 / 商品" min-width="220"><template #default="{ row }"><el-button v-if="user.hasPerm('cst:cost:view') && row.batchId" link type="primary" @click="trace?.open(row.batchId)">{{ row.batchNo ?? '#' + row.batchId }}</el-button><span v-else class="mono">{{ row.batchNo ?? (row.batchId == null ? '未记录' : '#' + row.batchId) }}</span><ProductCell v-if="row.productCode || row.productName" :code="row.productCode" :name="row.productName" /></template></el-table-column>
            <el-table-column label="调整对象" min-width="110"><template #default="{ row }">{{ targetLabel(row.target) }}</template></el-table-column>
            <el-table-column label="调整金额" min-width="150" align="right"><template #default="{ row }"><MoneyText v-if="row.baseCurrency" :value="row.amount" :currency="row.baseCurrency" /><span v-else class="mono">{{ row.amount ?? '待补' }} <span class="muted">币种未提供</span></span></template></el-table-column>
            <el-table-column label="业务日期" width="120"><template #default="{ row }">{{ formatDate(row.bizDate) }}</template></el-table-column>
            <el-table-column label="调整原因" min-width="200" show-overflow-tooltip><template #default="{ row }">{{ reasonLabel(row.reason) }}</template></el-table-column>
            <el-table-column label="状态" width="120"><template #default="{ row }"><StatusTag :status="displayStatus(row)" /></template></el-table-column>
            <el-table-column v-if="!mockMode" label="操作" min-width="180" fixed="right"><template #default="{ row }"><el-button v-if="row.sourceType === 'MANUAL'" link :disabled="busy" @click="detail = row">审批记录</el-button><el-button v-if="row.status !== 'CONFIRMED' && row.approvalStatus === 'APPROVED' && user.hasPerm('cst:adjustment:confirm')" link type="primary" :disabled="busy" @click="confirm(row)">确认调整</el-button></template></el-table-column>
          </el-table>
        </div>
        <el-pagination v-if="route.query.sourceId == null" v-model:current-page="query.page" v-model:page-size="query.size" class="pagination" :page-sizes="[20, 50, 100]" :total="total" :disabled="loading || busy" layout="total, sizes, prev, pager, next" @current-change="load" @size-change="search" />
      </template>
    </section>
    <AdjustmentBatchPicker ref="picker" :target="form.target" :book-id="activeBook" @select="selectBatch" />
    <CostTraceDrawer ref="trace" />
    <el-drawer :model-value="!!detail" title="成本调整审批" size="min(640px, 100vw)" destroy-on-close @close="detail = null"><ApprovalPanel v-if="detail" :key="detail.id" doc-type="COST_ADJUSTMENT" :doc-id="detail.id" /></el-drawer>
  </div>
</template>

<style scoped>
.page-description { margin: 0 0 20px; color: var(--el-text-color-regular); line-height: 1.6; }
.form-grid { display: grid; grid-template-columns: repeat(2, minmax(0, 1fr)); gap: 0 20px; }
.form-grid :deep(.el-select), .form-grid :deep(.el-date-editor), .form-grid :deep(.el-input-number) { width: 100%; }
.batch-field { grid-column: 1 / -1; }
.batch-choice { display: flex; justify-content: flex-start; align-items: center; flex-wrap: wrap; width: 100%; gap: 12px; }
.batch-summary { display: grid; grid-template-columns: repeat(2, minmax(0, 1fr)); gap: 16px 20px; margin-bottom: 12px; padding: 16px; background: var(--el-fill-color-light); border-radius: 4px; font-size: 14px; line-height: 1.6; overflow-wrap: anywhere; }
.summary-label { display: block; margin-bottom: 4px; font-size: 12px; color: var(--el-text-color-secondary); }
.scope-note, .field-help { font-size: 13px; color: var(--el-text-color-regular); line-height: 1.6; }
.scope-note { margin: 0 0 20px; }
.field-help { margin-top: 6px; }
.form-actions { display: flex; justify-content: space-between; align-items: center; gap: 16px; border-top: 1px solid var(--el-border-color-lighter); padding-top: 16px; }
.feedback { margin-bottom: 16px; }
.record-actions, .query-error { display: flex; align-items: center; gap: 12px; }
.record-actions a { font-size: 14px; color: var(--el-color-primary); text-decoration: none; }
.search-form .el-select { width: 160px; }
.pagination { margin-top: 16px; justify-content: flex-end; flex-wrap: wrap; gap: 8px; }
@media (max-width: 768px) {
  .form-grid, .batch-summary { grid-template-columns: minmax(0, 1fr); }
  .form-actions, .query-error { align-items: stretch; flex-direction: column; }
  .search-form .el-select { width: 100%; }
  .record-actions { flex-wrap: wrap; justify-content: flex-end; }
}
</style>
