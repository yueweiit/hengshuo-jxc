<script setup lang="ts">
import { computed, onBeforeUnmount, onMounted, reactive, ref } from 'vue'
import { ElMessage, ElMessageBox } from 'element-plus'
import { http, createCommandIntent } from '@/api/http'
import { allRecords } from '@/api/pagination'
import { getToken, getCountryId } from '@/utils/session'
import { formatDate } from '@/utils/format'
import MoneyText from '@/components/MoneyText.vue'
import StatusTag from '@/components/StatusTag.vue'
import { useUserStore } from '@/stores/user'
import { useOptionsStore, type OptionItem } from '@/stores/options'

const mockMode = import.meta.env.MODE === 'demo' && import.meta.env.VITE_USE_MOCK === 'true'
const user = useUserStore(), options = useOptionsStore()
const saveIntent = createCommandIntent(), confirmIntent = createCommandIntent()
const rows = ref<Record<string, any>[]>([]), accounts = ref<Record<string, any>[]>([])
const books = ref<Record<string, any>[]>([]), currencies = ref<Record<string, any>[]>([])
const bookId = ref<number>(), loadedBookId = ref<number>(), editing = ref<number>(), version = ref<number>()
const loading = ref(false), initializing = ref(false), saving = ref(false), loadingAux = ref(false), ready = ref(false)
const setupError = ref(''), loadError = ref(''), actionError = ref(''), auxError = ref(''), writeNotice = ref('')
const currentPage = ref(1), pageSize = ref(20)
const form = reactive({ accountId: null as number | null, amount: null as number | null, direction: 'DEBIT', cutoffDate: '', currency: '', origAmount: null as number | null, rate: 1, aux: {} as Record<string, any> })
const auxOptions = ref<Record<string, OptionItem[]>>({})
const definitions: Record<string, { label: string; url: string }> = { customerId: { label: '客户', url: '/md/customers' }, supplierId: { label: '供应商 / 物流商', url: '/md/partners' }, fundAccountId: { label: '资金账户', url: '/md/fund-accounts' }, productId: { label: '商品', url: '/md/products' }, warehouseId: { label: '仓库', url: '/org/warehouses' }, storeId: { label: '门店', url: '/org/stores' }, expenseItemId: { label: '费用项目', url: '/md/expense-items' }, employeeId: { label: '员工', url: '/sys/users' } }
const aliases: Record<string, string> = { CUSTOMER: 'customerId', PARTNER: 'supplierId', SUPPLIER: 'supplierId', FUND: 'fundAccountId', PRODUCT: 'productId', WAREHOUSE: 'warehouseId', STORE: 'storeId', EXPENSE: 'expenseItemId', EMPLOYEE: 'employeeId' }
const selectedBook = computed(() => books.value.find(b => b.id === bookId.value))
const selected = computed(() => accounts.value.find(a => a.id === form.accountId))
const auxFields = computed<string[]>(() => (selected.value?.auxTypes || []).map((t: string) => aliases[t] || t))
const baseDecimals = computed(() => currencies.value.find(c => c.code === selectedBook.value?.baseCurrency)?.decimals ?? 2)
const origDecimals = computed(() => currencies.value.find(c => c.code === form.currency)?.decimals ?? 2)
const canWrite = computed(() => user.hasPerm('fin:opening:edit') && !mockMode && ready.value && loadedBookId.value === bookId.value && !loading.value && !saving.value && !loadingAux.value && !auxError.value)
const draftCount = computed(() => rows.value.filter(r => r.status === 'DRAFT').length)
const pagedRows = computed(() => rows.value.slice((currentPage.value - 1) * pageSize.value, currentPage.value * pageSize.value))
const totals = computed(() => {
  // 金额被权限隐藏或响应缺失时，不把未知余额补成0。
  if (rows.value.some(r => r.baseAmount == null || r.baseAmount === '' || !Number.isFinite(Number(r.baseAmount)) || !['DEBIT', 'CREDIT'].includes(r.direction))) return { debit: null, credit: null }
  return {
    debit: rows.value.filter(r => r.direction === 'DEBIT').reduce((s, r) => s + Number(r.baseAmount), 0),
    credit: rows.value.filter(r => r.direction === 'CREDIT').reduce((s, r) => s + Number(r.baseAmount), 0),
  }
})
let loadSequence = 0, auxSequence = 0, disposed = false
const context = () => `${getToken()}:${getCountryId()}`
function errorText(error: unknown) { return error instanceof Error ? error.message : typeof error === 'string' ? error : '操作失败，请重试' }
function assertContext(id: number, scope: string) {
  if (disposed || bookId.value !== id || scope !== context()) throw new Error('账套、国家或登录状态已切换，请在当前页面重试')
}
function resetEditor(keepDate = false) {
  auxSequence++
  loadingAux.value = false
  auxError.value = ''
  editing.value = version.value = undefined
  Object.assign(form, { accountId: null, amount: null, direction: 'DEBIT', cutoffDate: keepDate ? form.cutoffDate : '', currency: selectedBook.value?.baseCurrency || '', origAmount: null, rate: 1, aux: {} })
  saveIntent.reset()
}
function changePageSize(size: number) { pageSize.value = size; currentPage.value = 1 }
async function load(keepDate = false) {
  const sequence = ++loadSequence, id = bookId.value, scope = context()
  loading.value = false
  ready.value = false
  loadedBookId.value = undefined
  rows.value = []
  accounts.value = []
  loadError.value = ''
  currentPage.value = 1
  resetEditor(keepDate)
  confirmIntent.reset()
  if (!id) return
  loading.value = true
  const assertCurrent = () => { assertContext(id, scope); if (sequence !== loadSequence) throw new Error('读取请求已被替换') }
  try {
    const [balances, ledgerAccounts] = await Promise.all([
      allRecords<Record<string, any>>('/fin/opening-balances', { bookId: id }, assertCurrent),
      allRecords<Record<string, any>>('/fin/accounts', { bookId: id }, assertCurrent),
    ])
    assertCurrent()
    rows.value = balances
    accounts.value = ledgerAccounts.filter(a => a.isLeaf && a.status === 'ENABLED')
    loadedBookId.value = id
    ready.value = true
  } catch (error) {
    if (!disposed && sequence === loadSequence && id === bookId.value) loadError.value = errorText(error)
  } finally { if (sequence === loadSequence) loading.value = false }
}
async function changeBook() { writeNotice.value = actionError.value = ''; await load() }
async function loadAux() {
  const sequence = ++auxSequence, id = bookId.value, accountId = form.accountId, scope = context()
  loadingAux.value = true
  auxError.value = ''
  try {
    for (const field of auxFields.value) {
      if (!definitions[field] || auxOptions.value[field]) continue
      const items = await options.remote(definitions[field].url, field === 'employeeId' ? 'displayName' : 'name', 'id', { size: 200 })
      if (!id) return
      assertContext(id, scope)
      if (sequence !== auxSequence || accountId !== form.accountId) return
      auxOptions.value[field] = items
    }
  } catch (error) { if (sequence === auxSequence && !disposed) auxError.value = errorText(error) }
  finally { if (sequence === auxSequence) loadingAux.value = false }
}
async function choose() {
  form.aux = {}
  form.currency = selectedBook.value?.baseCurrency || ''
  form.origAmount = null
  form.rate = 1
  form.direction = selected.value?.direction || 'DEBIT'
  await loadAux()
}
async function add() {
  if (!canWrite.value || !bookId.value) return
  if (!form.accountId || form.amount === null || !form.cutoffDate) { ElMessage.warning('请选择科目，明确金额和期初截止日期'); return }
  const id = bookId.value
  saving.value = true
  actionError.value = writeNotice.value = ''
  try {
    const payload = { ...form, aux: { ...form.aux }, origAmount: selected.value?.fxEnabled && form.currency !== selectedBook.value?.baseCurrency ? form.origAmount : form.amount, rate: form.currency === selectedBook.value?.baseCurrency ? 1 : form.rate }
    if (editing.value) await http.putIdem('/fin/opening-balances/' + editing.value + '?bookId=' + id, { ...payload, version: version.value }, saveIntent)
    else await http.postIdem('/fin/opening-balances?bookId=' + id, payload, saveIntent)
    writeNotice.value = '期初草稿已保存，尚未确认。若列表刷新失败，请重新加载，无需重复保存。'
    ElMessage.success('期初草稿已保存，尚未确认')
    await load(true)
  } catch (error) { actionError.value = errorText(error) }
  finally { saving.value = false }
}
async function edit(row: Record<string, any>) {
  if (!canWrite.value || row.status !== 'DRAFT') return
  editing.value = row.id
  version.value = row.version
  Object.assign(form, { accountId: row.accountId, amount: row.baseAmount, direction: row.direction, cutoffDate: row.cutoffDate, currency: row.currency, origAmount: row.origAmount, rate: row.rate, aux: { ...row.aux } })
  actionError.value = writeNotice.value = ''
  saveIntent.reset()
  await loadAux()
}
async function remove(row: Record<string, any>) {
  if (!canWrite.value || !bookId.value || row.status !== 'DRAFT') return
  const id = bookId.value, scope = context()
  saving.value = true
  actionError.value = writeNotice.value = ''
  try {
    await ElMessageBox.confirm(`删除科目 ${row.accountCode || row.accountId} 的未确认期初草稿？`, '删除期初草稿', { type: 'warning' })
    assertContext(id, scope)
    await saveIntent.run(scope, 'DELETE /fin/opening-balances/' + row.id, { version: row.version, bookId: id }, key => http.delete('/fin/opening-balances/' + row.id, { params: { version: row.version, bookId: id }, headers: { 'Idempotency-Key': key } }))
    writeNotice.value = '期初草稿已删除。若列表刷新失败，请重新加载，无需重复删除。'
    await load(true)
  } catch (error) { if (error !== 'cancel' && error !== 'close') actionError.value = errorText(error) }
  finally { saving.value = false }
}
async function confirm() {
  if (!canWrite.value || !bookId.value || !draftCount.value || totals.value.debit === null || totals.value.credit === null) return
  const id = bookId.value, scope = context()
  const debit = totals.value.debit.toFixed(baseDecimals.value), credit = totals.value.credit.toFixed(baseDecimals.value)
  saving.value = true
  actionError.value = writeNotice.value = ''
  try {
    await ElMessageBox.confirm(`确认账套「${selectedBook.value?.name}」的期初：借 ${selectedBook.value?.baseCurrency} ${debit}，贷 ${selectedBook.value?.baseCurrency} ${credit}？确认后参与账簿且不能直接修改。`, '试算并确认期初', { type: 'warning', confirmButtonText: '试算并确认', cancelButtonText: '取消' })
    assertContext(id, scope)
    await http.postIdem('/fin/opening-balances/confirm?bookId=' + id, {}, confirmIntent)
    writeNotice.value = '期初已确认。若列表刷新失败，请重新加载，无需重复确认。'
    ElMessage.success('期初已确认')
    await load(true)
  } catch (error) { if (error !== 'cancel' && error !== 'close') actionError.value = errorText(error) }
  finally { saving.value = false }
}
async function initialize() {
  initializing.value = true
  setupError.value = ''
  const scope = context()
  try {
    const [bookRows, currencyRows] = await Promise.all([http.get<Record<string, any>[]>('/fin/books'), allRecords<Record<string, any>>('/md/currencies')])
    if (disposed) return
    if (scope !== context()) throw new Error('国家或登录状态已切换，请重新加载')
    books.value = bookRows
    currencies.value = currencyRows
    if (books.value.length === 1) bookId.value = books.value[0]!.id
    await load()
  } catch (error) { if (!disposed) setupError.value = errorText(error) }
  finally { initializing.value = false }
}
onMounted(initialize)
onBeforeUnmount(() => { disposed = true; loadSequence++; auxSequence++ })
</script>

<template>
  <div class="page opening-page">
    <section class="page-card">
      <div class="page-title opening-heading">
        <div><h2>期初余额</h2><p class="muted">按账套录入并核对启账前的科目余额</p></div>
        <el-button :loading="loading || initializing" :disabled="saving" @click="setupError ? initialize() : load()">刷新</el-button>
      </div>
      <el-alert title="请以经核对的期初资料录入；保存草稿与确认期初是两个独立操作，确认后不能直接修改。" type="info" :closable="false" show-icon />
      <div v-if="setupError" class="opening-feedback" role="alert"><span>账套或币种读取失败：{{ setupError }}</span><el-button link type="primary" @click="initialize">重新加载</el-button></div>
      <el-form class="opening-book" label-position="top" @submit.prevent>
        <el-form-item label="账套">
          <el-select v-model="bookId" filterable placeholder="请选择账套" :loading="initializing" :disabled="saving || initializing || !!setupError" @change="changeBook">
            <el-option v-for="b in books" :key="b.id" :label="b.name" :value="b.id" />
          </el-select>
        </el-form-item>
        <span v-if="selectedBook" class="muted">本位币：{{ selectedBook.baseCurrency }}</span>
      </el-form>
      <div v-if="loadError" class="opening-feedback" role="alert"><span>期初明细或科目读取失败：{{ loadError }}</span><el-button link type="primary" @click="load()">重新加载</el-button></div>
      <el-alert v-if="writeNotice" class="opening-notice" :title="writeNotice" type="success" :closable="false" show-icon />
      <el-alert v-if="actionError" class="opening-notice" :title="actionError" type="error" :closable="false" show-icon role="alert" />
      <p v-if="initializing" class="opening-placeholder" role="status">正在读取账套和币种…</p>
      <el-empty v-else-if="!setupError && !books.length" description="暂无可用账套，请先完成账套配置" :image-size="64" />
      <el-empty v-else-if="!setupError && !bookId" description="请选择账套，查看并录入期初余额" :image-size="64" />

      <section v-if="user.hasPerm('fin:opening:edit') && bookId && ready" class="opening-editor" aria-labelledby="opening-editor-title">
        <div class="opening-section-title"><h3 id="opening-editor-title">{{ editing ? '修改期初草稿' : '录入期初草稿' }}</h3><span class="muted">零余额也需明确填写 0</span></div>
        <el-form label-position="top" :disabled="saving || loading || mockMode" @submit.prevent="add">
          <div class="opening-fields">
            <el-form-item label="截止日期" required><el-date-picker v-model="form.cutoffDate" type="date" value-format="YYYY-MM-DD" placeholder="请选择期初截止日期" /></el-form-item>
            <el-form-item label="科目" required><el-select v-model="form.accountId" filterable placeholder="请选择启用的末级科目" @change="choose"><el-option v-for="a in accounts" :key="a.id" :label="a.code + ' ' + a.name" :value="a.id" /></el-select></el-form-item>
            <el-form-item label="方向"><el-select v-model="form.direction"><el-option label="借方" value="DEBIT" /><el-option label="贷方" value="CREDIT" /></el-select></el-form-item>
            <el-form-item :label="'本位币金额（' + selectedBook?.baseCurrency + '）'" required><el-input-number v-model="form.amount" :min="0" :precision="baseDecimals" controls-position="right" placeholder="请明确填写金额" /></el-form-item>
            <el-form-item v-for="field in auxFields" :key="field" :label="definitions[field]?.label || field"><el-select v-model="form.aux[field]" filterable :loading="loadingAux" :disabled="loadingAux || !!auxError" :placeholder="'请选择' + (definitions[field]?.label || field)"><el-option v-for="o in auxOptions[field] || []" :key="String(o.value)" :label="o.label" :value="o.value" /></el-select></el-form-item>
            <template v-if="selected?.fxEnabled">
              <el-form-item label="原币"><el-select v-model="form.currency" filterable placeholder="请选择原币"><el-option v-for="c in currencies" :key="c.code" :label="c.code" :value="c.code" /></el-select></el-form-item>
              <el-form-item label="原币金额"><el-input-number v-model="form.origAmount" :min="0" :precision="origDecimals" controls-position="right" /></el-form-item>
              <el-form-item label="汇率"><el-input-number v-model="form.rate" :min="0" :precision="8" controls-position="right" /></el-form-item>
            </template>
          </div>
          <div v-if="auxError" class="opening-feedback" role="alert"><span>辅助项读取失败：{{ auxError }}</span><el-button link type="primary" @click="loadAux">重新加载</el-button></div>
          <div class="toolbar opening-editor-actions"><el-button type="primary" native-type="submit" :loading="saving" :disabled="!canWrite">{{ editing ? '保存修改' : '保存期初草稿' }}</el-button><el-button v-if="editing" @click="resetEditor()">取消修改</el-button></div>
        </el-form>
      </section>

      <section v-if="bookId && !setupError" class="opening-records" aria-labelledby="opening-records-title" :aria-busy="loading">
        <div class="opening-section-title"><h3 id="opening-records-title">期初明细</h3><span v-if="ready" class="muted">共 {{ rows.length }} 条 · 草稿 {{ draftCount }} 条 · 已确认 {{ rows.filter(r => r.status === 'CONFIRMED').length }} 条</span></div>
        <div v-if="ready" class="opening-reconciliation">
          <div class="opening-totals"><span>借方合计 <MoneyText :value="totals.debit" :currency="selectedBook?.baseCurrency" /></span><span>贷方合计 <MoneyText :value="totals.credit" :currency="selectedBook?.baseCurrency" /></span><span class="muted">全账套汇总，最终试算以确认为准</span></div>
          <el-button v-if="user.hasPerm('fin:opening:edit')" :disabled="!canWrite || !draftCount || totals.debit === null" :loading="saving" @click="confirm">试算并确认期初</el-button>
        </div>
        <p v-if="ready && totals.debit === null" class="muted">存在不可见或缺失金额，无法展示完整汇总，请核实金额读取权限及资料。</p>
        <p v-if="loading" class="opening-placeholder" role="status">正在读取期初明细和科目…</p>
        <div v-else-if="ready" class="table-scroll">
          <el-table :data="pagedRows" row-key="id" border stripe size="small" empty-text="当前账套暂无期初余额，请依据已核对资料录入草稿">
            <el-table-column prop="accountCode" label="科目编码" min-width="110" show-overflow-tooltip />
            <el-table-column prop="accountName" label="科目名称" min-width="160" show-overflow-tooltip />
            <el-table-column label="截止日期" width="120"><template #default="{ row }">{{ formatDate(row.cutoffDate) }}</template></el-table-column>
            <el-table-column label="方向" width="80"><template #default="{ row }">{{ row.direction === 'DEBIT' ? '借方' : row.direction === 'CREDIT' ? '贷方' : (row.direction || '-') }}</template></el-table-column>
            <el-table-column prop="auxKey" label="辅助项" min-width="180" show-overflow-tooltip />
            <el-table-column prop="currency" label="原币币种" width="100" />
            <el-table-column label="原币金额" min-width="150" align="right"><template #default="{ row }"><MoneyText :value="row.origAmount" :currency="row.currency" /></template></el-table-column>
            <el-table-column label="本位币金额" min-width="160" align="right"><template #default="{ row }"><MoneyText :value="row.baseAmount" :currency="selectedBook?.baseCurrency" /></template></el-table-column>
            <el-table-column label="状态" width="100"><template #default="{ row }"><StatusTag :status="row.status" /></template></el-table-column>
            <el-table-column v-if="!mockMode && user.hasPerm('fin:opening:edit')" label="操作" fixed="right" width="130"><template #default="{ row }"><template v-if="row.status === 'DRAFT'"><el-button link type="primary" :disabled="!canWrite" @click="edit(row)">修改</el-button><el-button link type="danger" :disabled="!canWrite" @click="remove(row)">删除</el-button></template><span v-else class="muted">只读</span></template></el-table-column>
          </el-table>
        </div>
        <div v-if="ready && rows.length" class="opening-pagination"><span class="muted">共 {{ rows.length }} 条</span><el-pagination v-model:current-page="currentPage" :page-size="pageSize" :page-sizes="[20, 50, 100]" :total="rows.length" layout="sizes, prev, pager, next" :pager-count="5" background :disabled="loading || saving" @size-change="changePageSize" /></div>
      </section>
    </section>
  </div>
</template>

<style scoped>
.opening-page { min-width: 0; }
.opening-heading { align-items: flex-start; }
.opening-heading h2, .opening-section-title h3 { margin: 0; }
.opening-heading p { margin: 6px 0 0; line-height: 1.6; }
.opening-book { display: flex; align-items: center; flex-wrap: wrap; gap: 12px; margin-top: 16px; }
.opening-book .el-form-item { width: min(320px, 100%); margin-bottom: 0; }
.opening-editor, .opening-records { margin-top: 16px; padding-top: 16px; border-top: 1px solid var(--el-border-color-lighter); }
.opening-section-title { display: flex; align-items: center; justify-content: space-between; flex-wrap: wrap; gap: 8px; margin-bottom: 12px; }
.opening-section-title h3 { font-size: 14px; font-weight: 600; color: var(--el-text-color-primary); }
.opening-fields { display: grid; grid-template-columns: repeat(4, minmax(0, 1fr)); gap: 0 12px; }
.opening-fields .el-form-item { min-width: 0; margin-bottom: 12px; }
.opening-fields :deep(.el-select), .opening-fields :deep(.el-input-number), .opening-fields :deep(.el-date-editor.el-input) { width: 100%; min-width: 0; }
.opening-editor-actions { margin: 0; }
.opening-editor-actions .el-button + .el-button { margin-left: 0; }
.opening-feedback { display: flex; align-items: center; flex-wrap: wrap; gap: 8px; margin-top: 12px; color: var(--el-color-danger); font-size: 13px; overflow-wrap: anywhere; }
.opening-notice { margin-top: 12px; }
.opening-placeholder { padding: 24px 0; text-align: center; color: var(--el-text-color-secondary); font-size: 14px; }
.opening-reconciliation { display: flex; align-items: center; justify-content: space-between; flex-wrap: wrap; gap: 12px; margin-bottom: 12px; padding: 12px; background: var(--el-fill-color-light); border-radius: 4px; }
.opening-totals { display: flex; flex-wrap: wrap; align-items: baseline; gap: 8px 24px; font-size: 14px; }
.opening-totals :deep(.mono) { margin-left: 8px; overflow-wrap: anywhere; }
.opening-pagination { display: flex; align-items: center; justify-content: space-between; flex-wrap: wrap; gap: 12px; margin-top: 16px; }
.opening-pagination :deep(.el-pagination) { flex-wrap: wrap; gap: 8px; padding: 0; }
.opening-page :deep(button:focus-visible) { outline: 2px solid var(--el-color-primary); outline-offset: 2px; }
@media (max-width: 1200px) { .opening-fields { grid-template-columns: repeat(2, minmax(0, 1fr)); } }
@media (max-width: 768px) {
  .opening-fields { grid-template-columns: minmax(0, 1fr); }
  .opening-book { align-items: flex-start; flex-direction: column; }
  .opening-book .el-form-item { width: 100%; }
  .opening-reconciliation { align-items: flex-start; }
  .opening-totals { display: grid; grid-template-columns: minmax(0, 1fr); }
  .opening-pagination { align-items: flex-start; flex-direction: column; }
}
</style>
