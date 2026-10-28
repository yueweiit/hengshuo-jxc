<script setup lang="ts">
import { computed, onBeforeUnmount, onMounted, ref, watch } from 'vue'
import { useRoute, useRouter } from 'vue-router'
import { ElMessageBox } from 'element-plus'
import { http } from '@/api/http'
import { allRecords } from '@/api/pagination'
import { useCountryStore } from '@/stores/country'
import { useUserStore } from '@/stores/user'
import { todayIn } from '@/utils/format'
import PurchaseImportTable from './PurchaseImportTable.vue'
import PurchaseImportSources from './PurchaseImportSources.vue'
import PurchaseImportProductReview from './PurchaseImportProductReview.vue'
import { createPurchaseImportModel, importColumns, type ImportRow } from './purchaseImportModel'
import { purchaseImportApi } from './purchaseImportApi'

defineProps<{ downloading: boolean; downloadError: string }>()
const emit = defineEmits<{ download: [] }>()
const country = useCountryStore(), user = useUserStore(), route = useRoute(), router = useRouter()
const page = createPurchaseImportModel(purchaseImportApi, todayIn(country.timezone))
const state = page.state
const books = ref<{ id: number; name: string; baseCurrency: string }[]>([])
const suppliers = ref<{ id: number; name: string; settleCurrency?: string; paymentTerms?: string }[]>([])
const currencies = ref<{ code: string }[]>([])
const refsLoading = ref(false), refsError = ref(''), dialogVisible = ref(false), selected = ref<File | null>(null)
const fileInput = ref<HTMLInputElement>()
const disabled = computed(() => page.busy() || refsLoading.value || !!refsError.value)
let active = true, refsSequence = 0
let taskTimer: ReturnType<typeof setTimeout> | undefined
function scheduleTasks() {
  clearTimeout(taskTimer)
  if (active && state.status === 'PARSING' && state.batchId) taskTimer = setTimeout(async () => { if (await page.refreshTasks()) scheduleTasks() }, 2000)
}
watch(() => [state.batchId, state.status], scheduleTasks)

async function loadReferences() {
  const request = ++refsSequence
  refsLoading.value = true; refsError.value = ''
  try {
    const [availableBooks, availableSuppliers, availableCurrencies] = await Promise.all([
      http.get<typeof books.value>('/org/books'),
      allRecords<typeof suppliers.value[number]>('/md/partners', { partnerType: 'SUPPLIER', status: 'ENABLED' }),
      allRecords<typeof currencies.value[number]>('/md/currencies'),
    ])
    if (!active || request !== refsSequence) return
    if (!Array.isArray(availableBooks)) throw new Error('账套选项返回格式不正确')
    books.value = availableBooks; suppliers.value = availableSuppliers; currencies.value = availableCurrencies
  } catch (error) {
    if (active && request === refsSequence) refsError.value = error instanceof Error ? error.message : '基础数据读取失败，请重试'
  } finally {
    if (active && request === refsSequence) refsLoading.value = false
  }
}
function supplierChanged() {
  const supplier = suppliers.value.find(item => item.id === state.header.supplierId)
  if (supplier && !state.header.currency && supplier.settleCurrency) state.header.currency = supplier.settleCurrency
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
  if (disabled.value || !selectedRefsValid()) return
  if (!selected.value) { page.failure(new Error('请先选择.xlsx文件')); return }
  const saved = await page.importFile(selected.value)
  if (saved) {
    dialogVisible.value = false; selected.value = null
    if (fileInput.value) fileInput.value.value = ''
    try { await router.replace({ query: { ...route.query, batchId: state.batchId! } }) }
    catch (error) { if (active) page.failure(new Error(`数据已保存，但批次地址更新失败：${error instanceof Error ? error.message : '请重试读取'}`)) }
  }
}
async function saveHeader() { if (!disabled.value && selectedRefsValid()) await page.saveHeader() }
async function remove(row: ImportRow) {
  if (disabled.value || state.edit) return
  const context = JSON.stringify([country.currentId, country.epoch, user.token, state.batchId])
  try {
    await ElMessageBox.confirm(`确定删除第${row.rowNo}行采购明细？`, '删除明细', { type: 'warning', confirmButtonText: '删除', cancelButtonText: '取消' })
  } catch (error) {
    if (error !== 'cancel' && error !== 'close') page.failure(error)
    return
  }
  if (active && !disabled.value && context === JSON.stringify([country.currentId, country.epoch, user.token, state.batchId])) await page.removeRow(row)
}
function errorLabel(field?: string) { return importColumns.find(column => column.key === field)?.label ?? field }
async function loadRouteBatch() {
  const id = route.query.batchId
  if (typeof id === 'string' && id !== state.batchId) await page.loadBatch(id)
  else if (id !== undefined && typeof id !== 'string') page.failure(new Error('批次编号格式不正确'))
}
onMounted(() => { void loadReferences(); void loadRouteBatch() })
watch(() => route.query.batchId, () => {
  if (route.query.batchId === state.batchId) return
  page.invalidate(); selected.value = null; dialogVisible.value = false
  void loadRouteBatch()
})
watch(() => [country.currentId, country.epoch, user.token], () => {
  page.invalidate(); selected.value = null; dialogVisible.value = false
  state.header.orderDate = todayIn(country.timezone)
  books.value = []; suppliers.value = []; currencies.value = []
  void loadReferences()
  if (route.query.batchId !== undefined) void router.replace({ query: { ...route.query, batchId: undefined } }).catch(error => { if (active) page.failure(error) })
}, { flush: 'sync' })
onBeforeUnmount(() => { active = false; ++refsSequence; clearTimeout(taskTimer); page.invalidate() })
</script>

<template>
  <main class="purchase-import-workspace" :aria-busy="page.busy() || refsLoading">
    <section class="import-section" aria-labelledby="import-header-title">
      <div class="section-heading"><h2 id="import-header-title">基础信息</h2><el-button v-if="state.batchId" :disabled="disabled || !!state.edit || !page.headerDirty()" :loading="state.saving && !state.edit" @click="saveHeader">保存基础信息</el-button></div>
      <el-alert v-if="refsError" type="error" :closable="false" show-icon class="import-alert"><template #title>基础数据读取失败：{{ refsError }}</template><el-button link type="primary" @click="loadReferences">重新读取</el-button></el-alert>
      <el-form :model="state.header" :disabled="disabled || !!state.edit" label-width="90px" class="import-header-form" @submit.prevent>
        <div class="header-grid">
          <el-form-item label="账套" required><el-select v-model="state.header.bookId" filterable placeholder="请选择账套" aria-label="账套"><el-option v-for="book in books" :key="book.id" :value="book.id" :label="`${book.name} · ${book.baseCurrency}`" /></el-select></el-form-item>
          <el-form-item label="供应商" required><el-select v-model="state.header.supplierId" filterable placeholder="请选择供应商" aria-label="供应商" @change="supplierChanged"><el-option v-for="supplier in suppliers" :key="supplier.id" :value="supplier.id" :label="supplier.name" /></el-select></el-form-item>
          <el-form-item label="币种" required><el-select v-model="state.header.currency" filterable placeholder="请选择币种" aria-label="币种"><el-option v-for="currency in currencies" :key="currency.code" :value="currency.code" :label="currency.code" /></el-select></el-form-item>
          <el-form-item label="下单日期" required><el-date-picker v-model="state.header.orderDate" type="date" value-format="YYYY-MM-DD" placeholder="请选择日期" aria-label="下单日期" /></el-form-item>
          <el-form-item label="预计交货"><el-date-picker v-model="state.header.expectedDate" type="date" value-format="YYYY-MM-DD" placeholder="请选择日期" aria-label="预计交货" /></el-form-item>
          <el-form-item label="付款条件"><el-input v-model="state.header.paymentTerms" maxlength="200" placeholder="填写付款条件" aria-label="付款条件" /></el-form-item>
          <el-form-item label="预付比例"><div class="ratio-field"><el-input v-model="state.header.prepayRatio" inputmode="decimal" placeholder="0 至 1" aria-label="预付比例" /><span class="field-hint">0～1，例如 0.3 表示 30%</span></div></el-form-item>
          <el-form-item label="账期天数"><el-input-number v-model="state.header.termDays" :min="0" :max="2147483647" :precision="0" controls-position="right" placeholder="天数" aria-label="账期天数" /></el-form-item>
        </div>
      </el-form>
    </section>

    <section class="import-section import-command" aria-label="文件导入">
      <div><h2>导入采购明细</h2><p>使用采购模板填写，每个商品规格单独一行。</p></div>
      <el-button type="primary" :disabled="disabled || !!state.edit" @click="dialogVisible = true"><el-icon><Upload /></el-icon>导入文件</el-button>
    </section>

    <section class="import-section import-details" aria-labelledby="import-details-title">
      <div class="section-heading"><div class="detail-title"><h2 id="import-details-title">采购明细</h2><span class="field-hint">共 {{ state.rows.length }} 条</span></div><el-button v-if="state.batchId || route.query.batchId" :disabled="state.importing || state.saving || state.loading || !!state.edit || page.headerDirty()" :loading="state.loading" @click="page.loadBatch(state.batchId || String(route.query.batchId))"><el-icon><Refresh /></el-icon>重新读取</el-button></div>
      <el-alert v-if="page.headerDirty()" type="warning" title="基础信息已修改，请先保存后再编辑明细。" :closable="false" show-icon class="import-alert" />
      <el-alert v-if="state.error && !dialogVisible" :title="state.error" type="error" :closable="false" show-icon class="import-alert" />
      <el-alert v-if="state.success" :title="state.success" type="success" :closable="false" show-icon class="import-alert" />
      <PurchaseImportSources :page="page" />
      <p class="table-hint">点击单元格编辑；铅笔按钮编辑整行。保存成功后才更新记录。</p>
      <PurchaseImportTable :page="page" :disabled="disabled" @remove="remove" />
      <PurchaseImportProductReview :page="page" />
    </section>

    <el-dialog v-model="dialogVisible" title="导入采购文件" width="620px" :close-on-click-modal="!state.importing" :close-on-press-escape="!state.importing" :show-close="!state.importing" append-to-body class="purchase-import-dialog">
      <el-button :loading="downloading" :disabled="state.importing" @click="emit('download')"><el-icon><Download /></el-icon>下载模板</el-button>
      <ol class="import-notices"><li>请上传不超过100 MiB的 .xlsx 文件，保持模板列名和顺序。</li><li>请使用系统下载的采购模板填写数据。</li><li>解析保存完成后请逐项核对，原图位置需要人工确认。</li></ol>
      <div class="file-selector"><label for="purchase-import-file">选择采购文件</label><input id="purchase-import-file" ref="fileInput" type="file" accept=".xlsx,application/vnd.openxmlformats-officedocument.spreadsheetml.sheet" :disabled="state.importing" @change="selectFile" /><span v-if="selected" class="field-hint">已选择：{{ selected.name }}</span></div>
      <el-alert v-if="downloadError" :title="downloadError" type="error" :closable="false" show-icon class="import-alert" />
      <el-alert v-if="state.error" :title="state.error" type="error" :closable="false" show-icon class="import-alert" />
      <ul v-if="state.errors.length" class="import-error-list" aria-label="文件错误明细"><li v-for="(error, index) in state.errors" :key="index"><span v-if="error.rowNo">第{{ error.rowNo }}行：</span><span v-if="error.field">{{ errorLabel(error.field) }}，</span>{{ error.message }}</li></ul>
      <template #footer><el-button :disabled="state.importing" @click="dialogVisible = false">取消</el-button><el-button type="primary" :loading="state.importing" :disabled="disabled || !selected" @click="submitImport">导入并保存</el-button></template>
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
