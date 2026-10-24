<script setup lang="ts">
import { computed, onBeforeUnmount, reactive, ref } from 'vue'
import { useRouter } from 'vue-router'
import { ElMessage } from 'element-plus'
import { Search } from '@element-plus/icons-vue'
import { http, createCommandIntent } from '@/api/http'
import { allRecords } from '@/api/pagination'
import { useUserStore } from '@/stores/user'
import CrudPage from '@/components/crud/CrudPage.vue'
import MoneyText from '@/components/MoneyText.vue'
import QtyText from '@/components/QtyText.vue'
import type { ColumnDef, CrudPageExpose, FieldDef } from '@/components/crud/types'
import { AP_BILL_STATUS, PARTNER_SOURCE } from '@/modules/shared/bizOptions'

const actionIntent = createCommandIntent()

const createIntent = createCommandIntent()

type Row = Record<string, any> // eslint-disable-line @typescript-eslint/no-explicit-any
const router = useRouter()
const user = useUserStore()
const page = ref<CrudPageExpose>()
const sources = reactive({ poLines: [] as Row[], fees: [] as Row[], picked: [] as Row[] })
const visible = ref(false)
const sourceTable = ref<{ clearSelection: () => void }>()
const sourceUi = reactive({ tab: 'purchase', keyword: '', loading: false, loadError: '', saving: false, createError: '' })
let sourceRequest = 0
let disposed = false
onBeforeUnmount(() => { disposed = true; sourceRequest++ })
const currentSources = computed(() => sourceUi.tab === 'purchase' ? sources.poLines : sources.fees)
const filteredSources = computed(() => {
  const keyword = sourceUi.keyword.trim().toLocaleLowerCase()
  return currentSources.value.filter(row => !keyword || [row.sourceNo, partnerLabel(row), row.partnerId]
    .some(value => value != null && String(value).toLocaleLowerCase().includes(keyword)))
})
const hiddenSelected = computed(() => {
  const shown = new Set(filteredSources.value.map(sourceKey))
  return sources.picked.filter(row => !shown.has(sourceKey(row))).length
})
const selectionIssue = computed(() => {
  const first = sources.picked[0]
  if (!first) return ''
  if (sources.picked.some(row => !['PUR_ORDER_LINE', 'PUR_RECEIPT_LINE', 'LGS_FEE'].includes(row.sourceType)
    || !row.partnerId || typeof row.currency !== 'string' || !row.currency.trim())) {
    return '部分来源缺少有效的往来对象或币种，请重新加载后再试。'
  }
  if (sources.picked.some(row => (row.sourceType === 'LGS_FEE') !== (first.sourceType === 'LGS_FEE')
    || row.partnerId !== first.partnerId || row.currency !== first.currency)) {
    return '一张账单只能选择同一往来对象、同一币种的来源，采购与物流费用请分别生成。'
  }
  return ''
})
const canCreate = computed(() => visible.value && !sourceUi.loading && !sourceUi.loadError
  && !sourceUi.saving && sources.picked.length > 0 && !selectionIssue.value)
function sourceKey(row: Row) { return `${row.sourceType}:${row.sourceId}` }
function sourceLabel(row: Row) {
  return row.sourceType === 'PUR_ORDER_LINE' ? '采购订单' : row.sourceType === 'PUR_RECEIPT_LINE' ? '国内收货' : row.sourceType === 'LGS_FEE' ? '物流费用' : '未知来源'
}
function partnerLabel(row: Row) {
  return row.partnerName || `${row.sourceType === 'LGS_FEE' ? '物流商' : '供应商'} #${row.partnerId}`
}
function failureReason(error: unknown) { return error instanceof Error ? error.message : '发生未知错误，请重试' }
const recognitionDialog = ref(false), recognitionBusy = ref(false), executionSubjects = ref<Row[]>([]), recognitionIntent = createCommandIntent()
const recognitionForm = reactive<{ sourceKind: string; mode: string; executionSubjectUserId: number | null; version?: number }>({ sourceKind: 'PURCHASE', mode: 'BILL_CONFIRMED', executionSubjectUserId: null })
async function loadRecognition() { const rule = await http.get<Row>('/ap/recognition-rules/' + recognitionForm.sourceKind); recognitionForm.mode = rule.mode; recognitionForm.version = rule.version; recognitionForm.executionSubjectUserId = rule.executionSubjectUserId ?? null; recognitionIntent.reset() }
async function showRecognition() { await loadRecognition(); if (user.hasPerm('sys:user:view')) executionSubjects.value = (await allRecords<Row>('/sys/users')).filter(u => u.status === 'ENABLED'); recognitionDialog.value = true }
async function saveRecognition() { if (recognitionBusy.value) return; recognitionBusy.value = true; try { await http.putIdem('/ap/recognition-rules/' + recognitionForm.sourceKind, { mode: recognitionForm.mode, executionSubjectUserId: recognitionForm.mode === 'RECEIPT_CONFIRMED' ? recognitionForm.executionSubjectUserId : null, ...(recognitionForm.version ? { version: recognitionForm.version } : {}) }, recognitionIntent); await loadRecognition(); ElMessage.success('应付确认规则已保存') } finally { recognitionBusy.value = false } }
const columns: ColumnDef[] = [
  { prop: 'docNo', label: '账单', width: 180 },
  { prop: 'partnerName', label: '往来对象', minWidth: 150 },
  { prop: 'billType', label: '类型', type: 'status', width: 110 },
  { prop: 'currency', label: '币种', width: 80 },
  { prop: 'amount', label: '金额', width: 130 },
  { prop: 'openAmount', label: '未付', width: 130 },
  { prop: 'billDate', label: '账单日', type: 'date', width: 110 },
  { prop: 'dueDate', label: '到期', type: 'date', width: 110 },
  { prop: 'status', label: '状态', type: 'status', width: 100 },
]
const searchFields: FieldDef[] = [
  { prop: 'keyword', label: '单号' },
  { prop: 'partnerId', label: '往来对象', type: 'select', options: PARTNER_SOURCE },
  { prop: 'status', label: '状态', type: 'select', options: AP_BILL_STATUS },
]
function pickSources(rows: Row[]) {
  if (sourceUi.saving || sourceUi.loading) return
  sources.picked = rows
  sourceUi.createError = ''
}
function clearSelection() {
  if (sourceUi.saving) return
  sourceTable.value?.clearSelection()
  sources.picked = []
  sourceUi.createError = ''
}
async function loadSources() {
  if (sourceUi.saving || disposed) return
  const request = ++sourceRequest
  sourceUi.loading = true
  sourceUi.loadError = ''
  clearSelection()
  sources.poLines = []
  sources.fees = []
  try {
    const res = await http.get<{ poLines: Row[]; fees: Row[] } | null>('/ap/bill-sources', undefined, { silent: true })
    if (request !== sourceRequest || !visible.value || disposed) return
    if (!res || !Array.isArray(res.poLines) || !Array.isArray(res.fees)
      || [...res.poLines, ...res.fees].some(row => !row || typeof row.sourceType !== 'string' || row.sourceId == null)) {
      throw new Error('来源数据格式不正确，请重新加载；持续失败时请联系管理员。')
    }
    sources.poLines = res.poLines
    sources.fees = res.fees
    sourceUi.tab = res.poLines.length || !res.fees.length ? 'purchase' : 'logistics'
  } catch (error) {
    if (request === sourceRequest && visible.value && !disposed) sourceUi.loadError = failureReason(error)
  } finally {
    if (request === sourceRequest) sourceUi.loading = false
  }
}
async function open() {
  if (sourceUi.saving || disposed) return
  createIntent.reset()
  sourceUi.keyword = ''
  visible.value = true
  await loadSources()
}
function closeSources() {
  if (sourceUi.saving) return
  sourceRequest++
  sourceUi.loading = false
  visible.value = false
}
function beforeCloseSources(done: () => void) {
  if (!sourceUi.saving) { closeSources(); done() }
}
async function create() {
  if (sourceUi.saving) return
  if (!canCreate.value) return ElMessage.warning(selectionIssue.value || '请先加载并选择可用来源')
  sourceUi.saving = true
  sourceUi.createError = ''
  try {
    await http.postIdem('/ap/bills/from-sources', {
      sources: sources.picked.map((s) => (s.sourceType === 'LGS_FEE' ? s : { ...s, qty: Math.min(s.qty, s.openQty) })),
    }, createIntent, { silent: true })
  } catch (error) {
    if (!disposed) sourceUi.createError = failureReason(error)
    return
  } finally {
    sourceUi.saving = false
  }
  if (disposed) return
  ElMessage.success('已生成草稿账单')
  closeSources()
  try { await page.value?.reload() }
  catch (error) { ElMessage.warning(`草稿已生成，账单列表刷新失败：${failureReason(error)}。请重新查询，无需重复生成。`) }
}
async function confirm(row: Row) {
  await http.postIdem(`/ap/bills/${row.id}/confirm`, {}, actionIntent)
  ElMessage.success('已确认应付')
  page.value?.reload()
}
</script>

<template>
  <CrudPage ref="page" title="应付账单" resource="/ap/bills" :columns="columns" :search-fields="searchFields" :can-create="false" :can-toggle="false" :actions-width="160">
    <template #toolbar><el-button v-if="user.hasPerm('ap:bill:create')" type="primary" @click="open">从来源生成</el-button><el-button v-if="user.hasPerm('ap:recognition:edit')" @click="showRecognition">应付确认规则</el-button></template>
    <template #header><p class="muted">一张账单只包含同一往来对象、同一币种。物流费用不能重复进入有效账单。</p></template>
    <template #col-partnerName="{ row }"><el-link type="primary" @click="router.push({ path: `/ap/partners/${row.partnerId}`, query: { bookId: row.bookId } })">{{ row.partnerName }}</el-link></template>
    <template #col-amount="{ row }"><MoneyText :value="row.amount" :currency="row.currency" /></template>
    <template #col-openAmount="{ row }"><MoneyText :value="row.openAmount" :currency="row.currency" /></template>
    <template #row-actions="{ row }">
      <el-button v-if="row.status === 'DRAFT' && user.hasPerm('ap:bill:confirm')" link type="primary" @click="confirm(row)">确认</el-button>
    </template>
  </CrudPage>
  <el-dialog v-model="visible" title="选择账单来源" width="min(1000px, 96vw)" align-center class="source-dialog"
    :before-close="beforeCloseSources" :close-on-click-modal="false" :close-on-press-escape="!sourceUi.saving" :show-close="!sourceUi.saving" @close="closeSources">
    <template #header><h2 class="source-title">选择账单来源</h2></template>
    <div class="source-intro">
      <p>一张账单须属于同一账套、同一往来对象、同一币种。</p>
      <span>生成后为草稿，仍需在账单页确认。</span>
    </div>
    <el-tabs v-model="sourceUi.tab" class="source-tabs">
      <el-tab-pane name="purchase" :disabled="sourceUi.saving">
        <template #label>采购来源 <span class="source-tab-count">{{ sourceUi.loading || sourceUi.loadError ? '—' : sources.poLines.length }}</span></template>
      </el-tab-pane>
      <el-tab-pane name="logistics" :disabled="sourceUi.saving">
        <template #label>物流费用 <span class="source-tab-count">{{ sourceUi.loading || sourceUi.loadError ? '—' : sources.fees.length }}</span></template>
      </el-tab-pane>
    </el-tabs>
    <div class="source-search">
      <label for="ap-source-search">查找来源</label>
      <el-input id="ap-source-search" v-model="sourceUi.keyword" placeholder="来源标识、往来对象名称或 ID" :prefix-icon="Search" clearable :disabled="sourceUi.loading || sourceUi.saving || !!sourceUi.loadError" />
      <span v-if="!sourceUi.loading && !sourceUi.loadError" class="source-result-count">显示 {{ filteredSources.length }} / {{ currentSources.length }} 条</span>
    </div>
    <div v-if="sourceUi.loadError" class="source-load-error" role="alert">
      <el-alert title="来源读取失败" :description="sourceUi.loadError" type="error" show-icon :closable="false" />
      <el-button @click="loadSources">重新加载</el-button>
    </div>
    <el-table v-show="!sourceUi.loadError" ref="sourceTable" v-loading="sourceUi.loading" element-loading-text="正在读取账单来源…"
      :data="filteredSources" :row-key="sourceKey" border stripe max-height="min(420px, 45vh)" class="source-table" @selection-change="pickSources">
      <el-table-column type="selection" width="44" fixed="left" reserve-selection :selectable="() => !sourceUi.saving && !sourceUi.loading" />
      <el-table-column label="类型" width="104"><template #default="{ row }"><span class="source-type">{{ sourceLabel(row) }}</span></template></el-table-column>
      <el-table-column prop="sourceNo" :label="sourceUi.tab === 'purchase' ? '来源标识' : '费用来源'" min-width="210" show-overflow-tooltip>
        <template #default="{ row }"><span class="mono">{{ row.sourceNo }}</span></template>
      </el-table-column>
      <el-table-column :label="sourceUi.tab === 'purchase' ? '供应商' : '物流商'" min-width="160" show-overflow-tooltip>
        <template #default="{ row }">{{ partnerLabel(row) }}</template>
      </el-table-column>
      <el-table-column v-if="sourceUi.tab === 'purchase'" label="可开数量" width="130" align="right">
        <template #default="{ row }"><QtyText :value="row.openQty" :unit="row.unit" /></template>
      </el-table-column>
      <el-table-column prop="currency" label="币种" width="80" />
      <el-table-column :label="sourceUi.tab === 'purchase' ? '单价' : '金额'" width="150" align="right">
        <template #default="{ row }"><MoneyText v-if="row.currency" :value="sourceUi.tab === 'purchase' ? row.unitPrice : row.amount" :currency="row.currency" /><span v-else>币种缺失</span></template>
      </el-table-column>
      <template #empty>
        <div v-if="sourceUi.loading" class="source-empty">正在读取账单来源…</div>
        <el-empty v-else :image-size="56" :description="sourceUi.keyword.trim() ? '没有匹配的来源，请调整查找条件' : sourceUi.tab === 'purchase' ? '暂无可选择的采购来源' : '暂无可选择的物流费用'" />
      </template>
    </el-table>
    <p v-if="!sourceUi.loadError" class="source-scroll-hint">表格可左右滑动，查看往来对象、数量和金额。</p>
    <p v-if="selectionIssue" class="source-issue" role="alert">{{ selectionIssue }}</p>
    <el-alert v-if="sourceUi.createError" class="source-submit-error" title="草稿生成失败" :description="sourceUi.createError" type="error" show-icon :closable="false" />
    <template #footer>
      <div class="source-footer">
        <div class="source-selection" aria-live="polite">
          <div><span>已选 <strong>{{ sources.picked.length }}</strong> 条</span><el-button v-if="sources.picked.length" link type="primary" :disabled="sourceUi.saving" @click="clearSelection">清空选择</el-button></div>
          <span v-if="sources.picked.length && !selectionIssue" class="source-selection-context">{{ partnerLabel(sources.picked[0]!) }} · {{ sources.picked[0]!.currency }}</span>
          <span v-if="hiddenSelected" class="source-hidden-selection">其中 {{ hiddenSelected }} 条不在当前列表，生成时仍会包含</span>
        </div>
        <div class="source-actions"><el-button :disabled="sourceUi.saving" @click="closeSources">取消</el-button><el-button type="primary" :disabled="!canCreate" :loading="sourceUi.saving" @click="create">{{ sourceUi.saving ? '正在生成' : '生成草稿' }}</el-button></div>
      </div>
    </template>
  </el-dialog>
  <el-dialog v-model="recognitionDialog" title="本国家应付确认规则" width="620px" :close-on-click-modal="!recognitionBusy"><p>默认按账单确认形成应付。收货触发仅生成原生草稿账单，财务仍须在账单页确认；不会自动记账。</p><el-form label-width="110px" :disabled="recognitionBusy"><el-form-item label="来源类型"><el-select v-model="recognitionForm.sourceKind" @change="loadRecognition"><el-option label="采购" value="PURCHASE" /><el-option label="物流费用" value="LOGISTICS" /><el-option label="其他" value="OTHER" /></el-select></el-form-item><el-form-item label="规则"><el-select v-model="recognitionForm.mode"><el-option label="账单确认（默认）" value="BILL_CONFIRMED" /><el-option label="人工生成并确认" value="MANUAL" /><el-option v-if="recognitionForm.sourceKind !== 'OTHER'" label="来源确认后生成草稿" value="RECEIPT_CONFIRMED" /></el-select></el-form-item><el-form-item v-if="recognitionForm.mode === 'RECEIPT_CONFIRMED'" label="执行账号"><el-select v-if="executionSubjects.length" v-model="recognitionForm.executionSubjectUserId" filterable><el-option v-for="subject in executionSubjects" :key="subject.id" :value="subject.id" :label="subject.displayName + ' · ' + subject.username" /></el-select><el-input-number v-else v-model="recognitionForm.executionSubjectUserId" :min="1" :controls="false" placeholder="执行账号 ID" /></el-form-item></el-form><p v-if="recognitionForm.mode === 'RECEIPT_CONFIRMED'" class="muted">后台每次处理都核验执行账号当前的草稿创建、成本字段和账套范围权限。账号停用或权限撤销时停止处理。</p><template #footer><el-button @click="recognitionDialog = false">关闭</el-button><el-button type="primary" :loading="recognitionBusy" :disabled="recognitionForm.mode === 'RECEIPT_CONFIRMED' && !recognitionForm.executionSubjectUserId" @click="saveRecognition">保存配置</el-button></template></el-dialog>
</template>

<style scoped lang="scss">
.source-title { margin: 0; font-size: 18px; font-weight: 600; line-height: 1.5; color: var(--el-text-color-primary); }
.source-intro {
  margin-bottom: 16px; font-size: 13px; line-height: 1.6;
  p { margin: 0 0 4px; color: var(--el-text-color-regular); }
  > span { color: var(--el-text-color-secondary); }
}
.source-tabs :deep(.el-tabs__header) { margin-bottom: 16px; }
.source-tab-count { margin-left: 8px; color: var(--el-text-color-secondary); font-size: 13px; font-variant-numeric: tabular-nums; }
.source-search {
  display: flex; align-items: center; gap: 12px; margin-bottom: 16px;
  label { flex-shrink: 0; color: var(--el-text-color-regular); font-size: 14px; }
  .el-input { max-width: 420px; min-width: 0; }
}
.source-result-count { margin-left: auto; flex-shrink: 0; font-size: 13px; color: var(--el-text-color-secondary); }
.source-table { width: 100%; font-size: 14px; }
.source-scroll-hint { display: none; margin: 8px 0 0; font-size: 13px; line-height: 1.5; color: var(--el-text-color-secondary); }
.source-type { color: var(--el-text-color-regular); font-size: 13px; }
.source-empty { min-height: 180px; }
.source-load-error { min-height: 220px; display: flex; flex-direction: column; align-items: flex-start; gap: 12px; }
.source-issue { margin: 12px 0 0; color: var(--el-color-danger); font-size: 13px; line-height: 1.6; }
.source-submit-error { margin-top: 12px; }
.source-footer { display: flex; justify-content: space-between; align-items: center; gap: 16px; padding-top: 12px; border-top: 1px solid var(--el-border-color-lighter); text-align: left; }
.source-selection {
  display: flex; flex-direction: column; gap: 4px; min-width: 0; font-size: 14px;
  > div { display: flex; align-items: center; gap: 12px; }
  strong { color: var(--el-color-primary); font-variant-numeric: tabular-nums; }
}
.source-selection-context, .source-hidden-selection { font-size: 13px; line-height: 1.5; overflow-wrap: anywhere; color: var(--el-text-color-secondary); }
.source-actions { display: flex; align-items: center; flex-shrink: 0; }
.source-dialog :deep(button:focus-visible) { outline: 2px solid var(--el-color-primary); outline-offset: 3px; }
@media (max-width: 768px) {
  .source-search { flex-wrap: wrap; gap: 8px; }
  .source-search .el-input { flex: 1; max-width: none; }
  .source-result-count { width: 100%; text-align: right; }
  .source-scroll-hint { display: block; }
  .source-footer { flex-wrap: wrap; gap: 12px; }
  .source-selection { width: 100%; }
  .source-actions { margin-left: auto; }
}
@media (prefers-reduced-motion: reduce) {
  .source-dialog :deep(*) { transition: none !important; animation: none !important; }
}
</style>
