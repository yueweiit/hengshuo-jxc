<script setup lang="ts">
import { computed, nextTick, onBeforeUnmount, onMounted, ref, watch } from 'vue'
import { useRoute, useRouter } from 'vue-router'
import { ElMessage, ElMessageBox } from 'element-plus'
import { http } from '@/api/http'
import { allRecords } from '@/api/pagination'
import { useCountryStore } from '@/stores/country'
import { useUserStore } from '@/stores/user'
import { todayIn } from '@/utils/format'
import PurchaseImportReviewDialog from './PurchaseImportReviewDialog.vue'
import PurchaseImportPreviewDrawer from './PurchaseImportPreviewDrawer.vue'
import PurchaseImportEditor from './PurchaseImportEditor.vue'
import PurchaseImportSources from './PurchaseImportSources.vue'
import PurchaseImportProgress from './PurchaseImportProgress.vue'
import { createPurchaseImportModel, consumeImportClearNavigation, rememberImportClearNavigation, importColumns, type ImportRow } from './purchaseImportModel'
import { purchaseImportApi } from './purchaseImportApi'
import { purchaseOrderSaveStatus } from './purchaseImportWorkflow'
import { createPurchaseImportDraftSession, purchaseImportDraftKey } from './purchaseImportDraft'

defineProps<{ downloading: boolean; downloadError: string }>()
const emit = defineEmits<{ download: [] }>()
const country = useCountryStore(), user = useUserStore(), route = useRoute(), router = useRouter()
const clearContext = () => JSON.stringify([country.currentId, country.epoch, user.token])
const clearedOnEntry = consumeImportClearNavigation(clearContext())
const page = createPurchaseImportModel(purchaseImportApi, todayIn(country.timezone), undefined, clearedOnEntry)
const state = page.state
const localDraft = createPurchaseImportDraftSession(page)
watch(() => [state.success, page.saveOrdersPending()] as const, ([message, pending]) => {
  if (!message || pending) return
  state.success = ''
  ElMessage.success({ message, duration: 3000 })
}, { flush: 'sync' })
const books = ref<{ id: number; name: string; baseCurrency: string; status: string }[]>([])
const suppliers = ref<{ id: number; name: string; settleCurrency?: string; paymentTerms?: string }[]>([])
const currencies = ref<{ code: string; name: string }[]>([])
const refsLoading = ref(false), refsError = ref(''), dialogVisible = ref(false), selected = ref<File | null>(null)
const clearConfirming = ref(false)
const fileInput = ref<HTMLInputElement>()
const importDisabled = computed(() => page.busy() || !!state.edit || page.grid.hasChanges())
const disabled = computed(() => page.busy() || refsLoading.value || !!refsError.value || page.grid.hasChanges())
const headerLocked = computed(() => state.rows.some(row => !!row.targetOrderLineId) || state.groups.some(group => ['UNKNOWN', 'CREATING'].includes(group.createStatus)))
const reviewVisible = ref(false), previewVisible = ref(false), reviewRow = ref<number | null>(null)
const reviewTab = ref<'todos' | 'match' | 'product'>('todos')
const pendingProductCount = computed(() => state.rows.filter(row => row.readiness !== 'READY' && !page.rowLocked(row)).length)
const creationEnabled = ref(false), creationLoading = ref(false), creationError = ref('')
const pendingReview = ref(false)
function review(row?: ImportRow, tab: 'todos' | 'match' | 'product' = 'todos') { reviewTab.value = tab; reviewRow.value = row?.id ?? state.rows.find(item => item.readiness !== 'READY' && !page.rowLocked(item))?.id ?? state.rows[0]?.id ?? null; reviewVisible.value = true }
function reviewPreviewRow(row: ImportRow) { previewVisible.value = false; review(row, 'product') }
async function preview() { if(await page.previewDrafts()) { reviewVisible.value = false; previewVisible.value = true } }
let active = true, refsSequence = 0, creationSequence = 0, localSequence = 0, defaultsAllowed = !clearedOnEntry
async function loadCreationCapability() {
  const request = ++creationSequence, batch = state.batchId
  creationEnabled.value = false; creationError.value = ''; creationLoading.value = false
  if (!batch) return
  creationLoading.value = true
  try {
    const result = await http.get<{ draftCreationEnabled: boolean }>('/pur/order-imports/capabilities', {}, { silent: true })
    if (!active || request !== creationSequence || state.batchId !== batch) return
    if (typeof result.draftCreationEnabled !== 'boolean') throw new Error('采购单保存能力返回格式不正确')
    creationEnabled.value = result.draftCreationEnabled
  } catch (error) { if (active && request === creationSequence) creationError.value = error instanceof Error ? error.message : '读取采购单保存能力失败' }
  finally { if (active && request === creationSequence) creationLoading.value = false }
}
watch(() => state.batchId, loadCreationCapability, { immediate:true })
let taskTimer: ReturnType<typeof setTimeout> | undefined
function scheduleTasks() {
  clearTimeout(taskTimer)
  if (active && (state.status === 'PARSING' || state.progressReloadNeeded || page.imageReviewBusy() || state.tasks.some(task => ['QUEUED', 'RUNNING'].includes(task.status))) && state.batchId) taskTimer = setTimeout(async () => { await page.refreshTasks(); if (active) scheduleTasks() }, 2000)
}
watch(() => [state.batchId, state.status, state.progressReloadNeeded, state.tasks.map(task => `${task.id}:${task.status}`).join(',')], scheduleTasks)

async function loadReferences() {
  const request = ++refsSequence
  refsLoading.value = true; refsError.value = ''
  try {
    const [availableBooks, availableSuppliers, availableCurrencies] = await Promise.all([
      http.get<typeof books.value>('/org/books'),
      allRecords<typeof suppliers.value[number]>('/md/partners', { partnerType: 'SUPPLIER', status: 'ENABLED' }),
      allRecords<typeof currencies.value[number]>('/md/currencies', { status: 'ENABLED' }),
    ])
    if (!active || request !== refsSequence) return
    if (!Array.isArray(availableBooks)) throw new Error('账套选项返回格式不正确')
    books.value = availableBooks; suppliers.value = availableSuppliers; currencies.value = availableCurrencies
    applyHeaderDefaults()
  } catch (error) {
    if (active && request === refsSequence) refsError.value = error instanceof Error ? error.message : '基础数据读取失败，请重试'
  } finally {
    if (active && request === refsSequence) refsLoading.value = false
  }
}
function applyHeaderDefaults() {
  // 旧批次即使尚未读取完成也保留其原值；无可用选项代表合法空白。
  if (!defaultsAllowed || state.batchId !== null || route.query.batchId !== undefined) return
  const book = books.value.find(item => item.status === 'ACTIVE')
  if (state.header.bookId === null && book) state.header.bookId = book.id
  if (state.header.supplierId === null && suppliers.value[0]) state.header.supplierId = suppliers.value[0].id
  supplierChanged()
  if (!state.header.currency && currencies.value.some(item => item.code === country.currency)) state.header.currency = country.currency
}
function supplierChanged() {
  const supplier = suppliers.value.find(item => item.id === state.header.supplierId)
  if (supplier && !state.header.currency && supplier.settleCurrency && currencies.value.some(item => item.code === supplier.settleCurrency)) state.header.currency = supplier.settleCurrency
  if (supplier && !state.header.paymentTerms && supplier.paymentTerms) state.header.paymentTerms = supplier.paymentTerms
}
function selectedRefsValid() {
  const header = state.header
  const message = !books.value.some(book => book.id === header.bookId) ? '请选择当前可用账套'
    : !suppliers.value.some(supplier => supplier.id === header.supplierId) ? '请选择当前可用供应商'
      : !currencies.value.some(currency => currency.code === header.currency) ? '请选择当前可用币种' : ''
  if (message) { page.failure(new Error(message)); return false }
  return true
}
function selectFile(event: Event) {
  const file = (event.target as HTMLInputElement).files?.item(0)
  selected.value = file ?? null // 用户取消文件选择代表本次没有选择，不是解析失败。
  page.clearFeedback()
}
async function submitImport() {
  if (importDisabled.value) return
  if (!selected.value) { page.failure(new Error('请先选择.xlsx文件')); return }
  const saved = await page.importFile(selected.value)
  if (saved) {
    selected.value = null
    if (fileInput.value) fileInput.value.value = ''
    try { await router.replace({ query: { ...route.query, batchId: state.batchId! } }) }
    catch (error) { if (active) page.failure(new Error(`文件已接收，但批次地址更新失败：${error instanceof Error ? error.message : '请重试读取'}`)) }
  }
}
async function saveHeader() { if (!disabled.value && selectedRefsValid()) await page.saveHeader() }
async function correctedBatch(batchId:string){try{await router.replace({query:{...route.query,batchId}})}catch(error){page.failure(new Error(`纠正批次已创建，但地址更新失败：${error instanceof Error?error.message:'请重新读取'}`))}}
async function saveOrders() {
  if (disabled.value || state.edit || creationLoading.value) return false
  if (pendingReview.value) { page.failure(new Error('预览中还有未保存的表头或费用修改，请先完成核对')); previewVisible.value = true; return false }
  if (!creationEnabled.value) { page.failure(new Error(creationError.value || '当前环境尚未启用保存采购单')); return false }
  if (!selectedRefsValid()) return false
  const saved = await page.saveOrders()
  if (!saved && state.groups.some(group => group.errors.length || group.feeTodos?.some(todo => todo.reviewStatus !== 'CONFIRMED'))) previewVisible.value = true
  return saved
}
async function remove(row: ImportRow) {
  if (importDisabled.value) return
  const context = JSON.stringify([country.currentId, country.epoch, user.token, state.batchId])
  try {
    await ElMessageBox.confirm(`确定删除第${row.rowNo}行采购明细？`, '删除明细', { type: 'warning', confirmButtonText: '删除', cancelButtonText: '取消' })
  } catch (error) {
    if (error !== 'cancel' && error !== 'close') page.failure(error)
    return
  }
  if (active && !importDisabled.value && context === JSON.stringify([country.currentId, country.epoch, user.token, state.batchId])) await page.removeRow(row)
}
function errorLabel(field?: string) { return importColumns.find(column => column.key === field)?.label ?? field }
async function syncClearedUi(confirmed = false) {
  if (!confirmed && !state.clearedBatchId && state.errorCode !== 'PUR_IMPORT_FILES_PENDING') return
  defaultsAllowed = false; selected.value = null; dialogVisible.value = false; reviewVisible.value = false; previewVisible.value = false; reviewRow.value = null
  pendingReview.value = false; ++creationSequence; creationEnabled.value = false; creationLoading.value = false; creationError.value = ''
  if (fileInput.value) fileInput.value.value = ''
  if (state.clearedBatchId && route.query.batchId !== undefined) {
    const releaseClear = rememberImportClearNavigation(clearContext())
    try { await router.replace({ query: { ...route.query, batchId: undefined } }); await nextTick() }
    catch (error) { if (active) page.failure(new Error(`数据已清空，但批次地址移除失败：${error instanceof Error ? error.message : '请重试'}`)) }
    finally { releaseClear() }
  }
}
async function clearAll() {
  if (!page.canClear() || clearConfirming.value) return
  const context = JSON.stringify([country.currentId, country.epoch, user.token, state.batchId, state.version]), file = selected.value
  clearConfirming.value = true
  try {
    await ElMessageBox.confirm(state.clearPending ? '继续按原请求清空当前批次，并重试尚未完成的文件清理？' : '确定清空当前导入批次及页面全部数据？当前批次已暂存的明细、来源文件和独占照片将永久删除，未保存的编辑也会丢弃。其他批次、正式采购单和被其他记录引用的照片会保留，必要审计记录也会保留。此操作不可撤销。', '清空当前导入', { type: 'warning', confirmButtonText: state.clearPending ? '重试清空' : '确认清空', cancelButtonText: '取消', distinguishCancelAndClose: true })
  } catch (error) { if (error !== 'cancel' && error !== 'close') page.failure(error); return }
  finally { clearConfirming.value = false }
  if (!active || !page.canClear() || selected.value !== file || context !== JSON.stringify([country.currentId, country.epoch, user.token, state.batchId, state.version])) return
  const cleared = await page.clearAll()
  if (cleared && !await localDraft.flush()) return
  await syncClearedUi(cleared)
}
async function loadRouteBatch() {
  const id = route.query.batchId
  if (typeof id === 'string' && id !== state.batchId) { await page.loadBatch(id); await syncClearedUi() }
  else if (id !== undefined && typeof id !== 'string') page.failure(new Error('批次编号格式不正确'))
}
async function openLocalDraft() {
  const request = ++localSequence, userId = user.user?.id, countryId = country.currentId
  if (!userId || !countryId) { localDraft.pause(); page.invalidate(); return }
  const routeBatch = typeof route.query.batchId === 'string' ? route.query.batchId : null
  const restored = await localDraft.open(purchaseImportDraftKey(userId, countryId, routeBatch))
  if (!active || request !== localSequence || !localDraft.view.ready) return
  defaultsAllowed = !restored && !clearedOnEntry
  if (!restored) { state.header.orderDate = clearedOnEntry ? null : todayIn(country.timezone); await loadRouteBatch() }
  else if (state.batchId && !page.grid.hasChanges() && !state.clearPending) await page.loadBatch(state.batchId)
  if (active && request === localSequence) {
    await loadReferences()
    if (active && request === localSequence && state.status === 'REVIEW' && !state.imageReviewError) await page.startImageReview()
  }
}
onMounted(() => { void openLocalDraft() })
watch(() => route.query.batchId, () => {
  if ((route.query.batchId ?? null) === state.batchId) return
  reviewVisible.value = false; previewVisible.value = false; selected.value = null; dialogVisible.value = false
  void openLocalDraft()
})
watch(() => [country.currentId, country.epoch, user.token, user.user?.id], () => {
  defaultsAllowed = true
  reviewVisible.value = false; previewVisible.value = false; selected.value = null; dialogVisible.value = false
  books.value = []; suppliers.value = []; currencies.value = []
  void openLocalDraft()
  if (route.query.batchId !== undefined) void router.replace({ query: { ...route.query, batchId: undefined } }).catch(error => { if (active) page.failure(error) })
}, { flush: 'sync' })
onBeforeUnmount(() => { localDraft.stop(); active = false; ++refsSequence; ++creationSequence; ++localSequence; clearTimeout(taskTimer); page.invalidate() })
</script>

<template>
  <main class="purchase-import-workspace" :aria-busy="page.busy() || refsLoading">
    <section class="import-section" aria-labelledby="import-header-title">
      <div class="section-heading"><h2 id="import-header-title">基础信息</h2><el-button v-if="state.batchId" :disabled="disabled || !!state.edit || headerLocked || !page.headerDirty()" :loading="state.saving && !state.edit" @click="saveHeader">保存基础信息</el-button></div>
      <el-alert v-if="refsError" type="error" :closable="false" show-icon class="import-alert"><template #title>基础数据读取失败：{{ refsError }}</template><el-button link type="primary" @click="loadReferences">重新读取</el-button></el-alert>
      <el-form :model="state.header" :disabled="disabled || !!state.edit || headerLocked" label-width="90px" class="import-header-form" @submit.prevent>
        <div class="header-grid">
          <el-form-item label="账套" required><el-select v-model="state.header.bookId" filterable placeholder="请选择账套" aria-label="账套"><el-option v-for="book in books" :key="book.id" :value="book.id" :label="`${book.name} · ${book.baseCurrency}`" :disabled="book.status !== 'ACTIVE'" /></el-select></el-form-item>
          <el-form-item label="供应商" required><el-select v-model="state.header.supplierId" filterable placeholder="请选择供应商" aria-label="供应商" @change="supplierChanged"><el-option v-for="supplier in suppliers" :key="supplier.id" :value="supplier.id" :label="supplier.name" /></el-select></el-form-item>
          <el-form-item label="币种" required><el-select v-model="state.header.currency" filterable placeholder="请选择币种" aria-label="币种"><el-option v-for="currency in currencies" :key="currency.code" :value="currency.code" :label="`${currency.code} · ${currency.name}`" /></el-select></el-form-item>
          <el-form-item label="下单日期" required><el-date-picker v-model="state.header.orderDate" type="date" value-format="YYYY-MM-DD" placeholder="请选择日期" aria-label="下单日期" /></el-form-item>
          <el-form-item label="预计交货"><el-date-picker v-model="state.header.expectedDate" type="date" value-format="YYYY-MM-DD" placeholder="请选择日期" aria-label="预计交货" /></el-form-item>
          <el-form-item label="付款条件"><el-input v-model="state.header.paymentTerms" maxlength="200" placeholder="填写付款条件" aria-label="付款条件" /></el-form-item>
          <el-form-item label="预付比例"><div class="ratio-field"><el-input v-model="state.header.prepayRatio" inputmode="decimal" placeholder="0 至 1" aria-label="预付比例" /><span class="field-hint">0～1，例如 0.3 表示 30%</span></div></el-form-item>
          <el-form-item label="账期天数"><el-input-number v-model="state.header.termDays" :min="0" :max="2147483647" :precision="0" controls-position="right" placeholder="天数" aria-label="账期天数" /></el-form-item>
          <el-form-item label="税率"><div class="ratio-field"><el-input v-model="state.header.taxRate" inputmode="decimal" placeholder="未知请留空" aria-label="税率" clearable /><span class="field-hint">0～1，例如 0.13 表示 13%；作为各行默认税率</span></div></el-form-item>
          <el-form-item label="单价口径"><el-select v-model="state.header.priceTaxBasis" placeholder="请核对供应商单价" aria-label="单价口径" clearable :value-on-clear="null"><el-option value="EXCLUSIVE" label="已核对：未含税单价" /></el-select></el-form-item>
        </div>
      </el-form>
    </section>

    <section class="import-section import-command" aria-label="文件导入">
      <div><h2>导入采购明细</h2><p>支持系统模板与供应商原始Excel；可先导入，再核对字段、商品与基础信息。</p></div>
      <div class="import-command-actions"><el-button type="primary" :disabled="importDisabled" @click="dialogVisible = true"><el-icon><Upload /></el-icon>导入文件</el-button>
      <el-button type="danger" plain :title="page.clearBlockReason()" :disabled="!page.canClear() || clearConfirming" :loading="state.clearing" @click="clearAll">{{ state.clearPending ? '重试清空' : '清空' }}</el-button></div>
    </section>

    <section class="import-section import-details" aria-labelledby="import-details-title">
      <div class="section-heading"><div class="detail-title"><h2 id="import-details-title">采购明细</h2><span class="field-hint">共 {{ page.grid.dataRows().length }} 条</span></div><el-button v-if="state.batchId || route.query.batchId" :disabled="state.importing || state.saving || state.loading || state.clearing || state.clearPending || !!state.edit || page.grid.hasChanges() || page.headerDirty()" :loading="state.loading" @click="page.loadBatch(state.batchId || String(route.query.batchId))"><el-icon><Refresh /></el-icon>重新读取</el-button></div>
      <el-alert v-if="localDraft.view.error" type="error" :closable="false" :title="localDraft.view.error" class="import-alert"><el-button link @click="localDraft.view.ready ? localDraft.flush() : openLocalDraft()">重试草稿保存与恢复</el-button></el-alert>
      <p v-else class="table-hint" role="status">{{ !localDraft.view.ready ? '正在恢复此浏览器的草稿' : localDraft.view.saving ? '正在保存草稿' : localDraft.view.saved ? '草稿已保存在此浏览器' : '编辑内容会自动保存到此浏览器' }}</p>
      <el-alert v-if="page.headerDirty()" type="warning" title="基础信息尚未保存；文件和来源明细已独立暂存，请补齐后保存基础信息。" :closable="false" show-icon class="import-alert" />
      <el-alert v-if="state.error && !dialogVisible" :title="state.error" type="error" :closable="false" show-icon class="import-alert" />
      <PurchaseImportSources :page="page" @corrected="correctedBatch" />
      <PurchaseImportProgress v-if="!dialogVisible" :page="page" />
      <p class="table-hint">点击单元格或铅笔编辑草稿；完成编辑只切换视图，点击上传后提交校验。</p>
      <div v-if="state.rows.length" class="workflow-actions"><el-badge :value="pendingProductCount" :max="9999" class="pending-product-trigger"><el-button type="danger" :disabled="importDisabled" :aria-label="`待确定是否为新商品，${pendingProductCount}行待确认`" @click="review(undefined, 'match')">待确定是否为新商品</el-button></el-badge><span class="field-hint">就绪 {{ state.rows.filter(row => row.readiness === 'READY').length }} / {{ state.rows.length }}</span><el-button type="primary" class="save-orders-button" :disabled="disabled || !!state.edit || creationLoading || !creationEnabled" :loading="state.saving && !state.edit" @click="saveOrders">保存</el-button></div>
      <p v-if="state.rows.length" class="table-hint">保存后生成对应采购单草稿及明细，并保留商品、原文件和费用来源关联。资料待核对时会提示具体原因。</p>
      <el-alert v-if="creationError" type="error" :closable="false" class="import-alert"><template #title>采购单保存暂不可用：{{ creationError }}</template><el-button link @click="loadCreationCapability">重新读取保存能力</el-button></el-alert>
      <p v-else-if="state.batchId && !creationEnabled && !creationLoading" class="table-hint">当前环境尚未启用保存采购单，可先完成资料核对。</p>
      <div v-loading="page.imageReviewBusy()" :inert="page.imageReviewBusy()" :aria-disabled="page.imageReviewBusy()" element-loading-text="AI图文核对中，请稍候"><PurchaseImportEditor :page="page" :disabled="page.busy() || !localDraft.view.ready" :persist="localDraft.flush" @remove="remove" @review="review" /></div>
      <section v-if="state.groups.length" class="saved-orders" aria-label="采购单保存结果"><h3>采购单保存结果</h3><div v-for="group in state.groups" :key="group.id"><strong>{{ group.sourceOrderNo }}</strong><router-link v-if="group.orderId" :to="`/purchase/orders/${group.orderId}`">{{ group.docNo || `采购单 ${group.orderId}` }}</router-link><span>{{ purchaseOrderSaveStatus(group) }}</span><el-button v-if="group.orderId || group.createIntent" link :disabled="page.busy()" @click="page.refreshCreation(group)">查询原保存结果</el-button><span v-if="group.errorMessage">{{ group.errorMessage }}</span></div></section>
    </section>

    <PurchaseImportReviewDialog v-if="state.batchId" v-model="reviewVisible" :page="page" :row-id="reviewRow" :initial-tab="reviewTab" @preview="preview" />
    <PurchaseImportPreviewDrawer v-if="state.batchId" v-model="previewVisible" :page="page" :books="books" :suppliers="suppliers" :currencies="currencies" :creation-enabled="creationEnabled" :creation-loading="creationLoading" :creation-error="creationError" @save="saveOrders" @review="reviewPreviewRow" @pending-review="pendingReview = $event" />
    <el-dialog v-model="dialogVisible" title="导入采购文件" width="620px" :close-on-click-modal="!state.importing" :close-on-press-escape="!state.importing" :show-close="!state.importing" append-to-body class="purchase-import-dialog">
      <el-button :loading="downloading" :disabled="state.importing" @click="emit('download')"><el-icon><Download /></el-icon>下载模板</el-button>
      <ol class="import-notices"><li>请上传不超过100 MiB的 .xlsx 文件。</li><li>系统模板直接读取；供应商原表识别后如有歧义，请核对原列与规格。</li><li>导入后先暂存明细；基础信息在保存时核验，原图归属需人工确认。</li></ol>
      <div class="file-selector"><label for="purchase-import-file">选择采购文件</label><input id="purchase-import-file" ref="fileInput" type="file" accept=".xlsx,application/vnd.openxmlformats-officedocument.spreadsheetml.sheet" :disabled="importDisabled || state.upload?.status === 'UNKNOWN'" @change="selectFile" /><span v-if="selected" class="field-hint">已选择：{{ selected.name }}</span></div>
      <PurchaseImportProgress :page="page" />
      <el-alert v-if="downloadError" :title="downloadError" type="error" :closable="false" show-icon class="import-alert" />
      <el-alert v-if="state.error" :title="state.error" type="error" :closable="false" show-icon class="import-alert" />
      <ul v-if="state.errors.length" class="import-error-list" aria-label="文件错误明细"><li v-for="(error, index) in state.errors" :key="index"><span v-if="error.rowNo">第{{ error.rowNo }}行：</span><span v-if="error.field">{{ errorLabel(error.field) }}，</span>{{ error.message }}</li></ul>
      <template #footer><el-button :disabled="state.importing" @click="dialogVisible = false">{{ state.activeTaskId ? state.status === 'PARSING' ? '收起进度' : '关闭' : '取消' }}</el-button><el-button type="primary" :loading="state.importing" :disabled="importDisabled || !selected" @click="submitImport">{{ state.upload?.status === 'UNKNOWN' ? '重试原请求' : '导入数据' }}</el-button></template>
    </el-dialog>
  </main>
</template>

<style scoped lang="scss">
.purchase-import-workspace { background: #fff; border: 1px solid var(--el-border-color-light); border-radius: 6px; }
.import-section { padding: 18px 20px; + .import-section { border-top: 1px solid var(--el-border-color-light); } }
.section-heading { display: flex; align-items: center; justify-content: space-between; gap: 12px; margin-bottom: 18px; min-height: 28px; }
h2 { margin: 0; font-size: 15px; font-weight: 600; line-height: 24px; }
.header-grid { display: grid; grid-template-columns: repeat(3, minmax(0, 1fr)); gap: 0 22px; }
.import-header-form { :deep(.el-form-item) { margin-bottom: 16px; } :deep(.el-select), :deep(.el-date-editor), :deep(.el-input-number) { width: 100%; } }
.ratio-field { width: 100%; }
.field-hint, .table-hint { color: var(--el-text-color-secondary); font-size: 12px; line-height: 20px; }
.import-command { display: flex; justify-content: space-between; align-items: center; gap: 20px; p { margin: 5px 0 0; color: var(--el-text-color-secondary); font-size: 13px; } }
.workflow-actions { display:flex;align-items:center;gap:10px;flex-wrap:wrap;margin:12px 0; }
.pending-product-trigger { margin: 7px 8px 0 0; }
.save-orders-button { margin-left:auto; }
.saved-orders { margin-top:14px;border-top:1px solid var(--el-border-color-light);padding-top:12px;font-size:13px; }
.saved-orders h3 { margin:0 0 8px;font-size:14px; }
.saved-orders > div { display:flex;align-items:center;flex-wrap:wrap;gap:12px;padding:6px 0; }
.detail-title { display: flex; align-items: baseline; gap: 12px; }
.import-details .section-heading { margin-bottom: 10px; }
.table-hint { margin: 0 0 10px; }
.import-alert { margin: 12px 0; }
.import-notices { padding-left: 22px; margin: 18px 0; color: var(--el-text-color-regular); line-height: 26px; }
.file-selector { display: flex; flex-direction: column; gap: 10px; padding: 16px; border: 1px dashed var(--el-border-color); border-radius: 4px; input { max-width: 100%; } }
.import-error-list { padding: 12px 12px 12px 30px; color: var(--el-color-danger); background: var(--el-color-danger-light-9); max-height: 180px; overflow: auto; line-height: 24px; }
@media (max-width: 1000px) { .header-grid { grid-template-columns: repeat(2, minmax(0, 1fr)); } }
@media (max-width: 640px) { .header-grid { grid-template-columns: minmax(0, 1fr); } .import-section { padding: 16px 12px; } .import-command { align-items: flex-start; flex-wrap: wrap; } }
</style>
