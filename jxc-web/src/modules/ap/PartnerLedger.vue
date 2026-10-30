<script setup lang="ts">
import { feedbackMessage } from '@/api/error-feedback'
import { computed, onBeforeUnmount, onMounted, reactive, ref, watch } from 'vue'
import { useRoute, useRouter } from 'vue-router'
import { ElMessage } from 'element-plus'
import { useCountryStore } from '@/stores/country'
import { useUserStore } from '@/stores/user'
import { allRecords } from '@/api/pagination'
import { http, createCommandIntent } from '@/api/http'
import MoneyText from '@/components/MoneyText.vue'
import DateTimeText from '@/components/DateTimeText.vue'

type Amount = number | string | null
interface CurrencyBalance { currency?: string | null; openAp?: Amount; prepaid?: Amount; paymentOpen?: Amount; creditOpen?: Amount }
interface PartnerBalance { partnerName?: string | null; byCurrency: CurrencyBalance[] }
interface LedgerEvent { at?: string | null; type?: string | null; no?: string | null; currency?: string | null; amount?: Amount }
interface SavedStatement {
  id: number; bookId: number; currency?: string; identityOk?: boolean
  opening?: Amount; increase?: Amount; paid?: Amount; offset?: Amount; adjust?: Amount; closing?: Amount
}
interface ReadState<T> { data: T | null; loading: boolean; error: string; requestId: number }
interface Book { id: number; name: string }
interface Currency { code: string }

const country = useCountryStore()
const user = useUserStore()
const route = useRoute()
const router = useRouter()
const id = computed(() => Number(route.params.id))
const balance = reactive<ReadState<PartnerBalance>>({ data: null, loading: true, error: '', requestId: 0 })
const records = reactive<ReadState<LedgerEvent[]>>({ data: null, loading: true, error: '', requestId: 0 })
const references = reactive({ loading: false, error: '' })
const actions = reactive({ generating: false, exporting: false, error: '' })
const books = ref<Book[]>([])
const currencies = ref<Currency[]>([])
const form = reactive({ bookId: undefined as number | undefined, currency: country.currency, periodStart: '', periodEnd: '', result: null as SavedStatement | null })
const statementIntent = createCommandIntent()
const exportIntent = createCommandIntent()
const partnerName = computed(() => balance.data?.partnerName?.trim() || `往来对象 #${route.params.id}`)
const balanceColumns = [
  { key: 'openAp', label: '未付应付' }, { key: 'prepaid', label: '预付余额' },
  { key: 'paymentOpen', label: '付款未核销' }, { key: 'creditOpen', label: '贷项' },
] as const
const statementFields = [
  { key: 'opening', label: '期初余额' }, { key: 'increase', label: '+ 期间账单' },
  { key: 'paid', label: '− 付款核销' }, { key: 'offset', label: '− 抵扣' },
  { key: 'adjust', label: '+ 调整' }, { key: 'closing', label: '= 期末余额' },
] as const
let active = true
let referenceRequest = 0
let statementRevision = 0

function isRecord(value: unknown): value is Record<string, unknown> { return value !== null && typeof value === 'object' && !Array.isArray(value) }
function isText(value: unknown) { return value == null || typeof value === 'string' }
function isAmount(value: unknown) {
  return value == null || value === '' || (typeof value === 'number' && Number.isFinite(value))
    || (typeof value === 'string' && value.trim() !== '' && Number.isFinite(Number(value)))
}

function parseBalance(value: unknown): PartnerBalance {
  if (!isRecord(value) || !isText(value.partnerName) || !Array.isArray(value.byCurrency)
    || !value.byCurrency.every(row => isRecord(row) && isText(row.currency) && balanceColumns.every(({ key }) => isAmount(row[key])))) {
    throw new Error('往来余额返回格式不正确，请重试')
  }
  return value as unknown as PartnerBalance
}
function parseRecords(value: unknown): LedgerEvent[] {
  if (!Array.isArray(value) || !value.every(row => isRecord(row)
    && ['at', 'type', 'no', 'currency'].every(key => isText(row[key])) && isAmount(row.amount)
    && (!row.at || Number.isFinite(Date.parse(row.at as string))))) {
    throw new Error('往来记录返回格式不正确，请重试')
  }
  return value as LedgerEvent[]
}

// 两个区域共用读取流程，失败与重试互不影响；迟到响应只能更新其原始对象和请求。
async function readSection<T>(state: ReadState<T>, view: string, parse: (value: unknown) => T) {
  const partnerId = id.value, requestId = ++state.requestId
  const current = () => active && requestId === state.requestId && Object.is(partnerId, id.value)
  state.data = null
  state.error = ''
  state.loading = true
  try {
    if (!Number.isSafeInteger(partnerId) || partnerId <= 0) throw new Error('往来对象编号无效，请返回账单重新进入')
    const result = await http.get<unknown>(`/ap/partners/${partnerId}/${view}`, undefined, { silent: true })
    if (current()) state.data = parse(result)
  } catch (error) {
    if (current()) state.error = feedbackMessage(error, "操作未完成，请重试")
  } finally {
    if (current()) state.loading = false
  }
}
async function load(section: 'all' | 'balance' | 'records' = 'all') {
  await Promise.all([
    ...(section === 'records' ? [] : [readSection(balance, 'balances', parseBalance)]),
    ...(section === 'balance' ? [] : [readSection(records, 'timeline', parseRecords)]),
  ])
}
function selectBook(preferred: number | undefined) {
  form.bookId = books.value.some(book => book.id === preferred) ? preferred : books.value.length === 1 ? books.value[0]!.id : undefined
}
async function loadReferences() {
  const requestId = ++referenceRequest
  references.loading = true
  references.error = ''
  try {
    const [bookRows, currencyRows] = await Promise.all([http.get<unknown>('/org/books', undefined, { silent: true }), allRecords<Currency>('/md/currencies')])
    if (!active || requestId !== referenceRequest) return
    if (!Array.isArray(bookRows) || !bookRows.every(book => isRecord(book) && Number.isSafeInteger(book.id) && typeof book.name === 'string')
      || !currencyRows.every(currency => typeof currency.code === 'string' && currency.code.trim())) throw new Error('账套或币种返回格式不正确，请重试')
    books.value = bookRows as Book[]
    currencies.value = currencyRows
    selectBook(form.bookId ?? Number(route.query.bookId))
  } catch (error) {
    if (active && requestId === referenceRequest) references.error = feedbackMessage(error, "操作未完成，请重试")
  } finally {
    if (active && requestId === referenceRequest) references.loading = false
  }
}
const statementContext = () => JSON.stringify([id.value, form.bookId, form.currency, form.periodStart, form.periodEnd])
async function statement() {
  if (!active || actions.generating || actions.exporting) return
  if (!form.bookId) return ElMessage.warning('请选择对账账套')
  const revision = statementRevision
  const current = () => active && revision === statementRevision
  const body = { bookId: form.bookId, partnerId: id.value, currency: form.currency, periodStart: form.periodStart, periodEnd: form.periodEnd }
  actions.generating = true
  actions.error = ''
  form.result = null
  try {
    const result = await http.postIdem<SavedStatement>('/ap/statements', body, statementIntent, { silent: true })
    if (!current()) return
    if (!isRecord(result) || !Number.isSafeInteger(result.id) || result.bookId !== body.bookId || typeof result.currency !== 'string'
      || !statementFields.every(({ key }) => isAmount(result[key]))) throw new Error('对账单返回格式不正确，请先核查已保存的对账单')
    form.result = result
    ElMessage.success(result.identityOk ? '期初与期间明细已核对' : '已生成，请核对')
  } catch (error) {
    if (current()) actions.error = feedbackMessage(error, "操作未完成，请重试")
  } finally {
    if (active) actions.generating = false
  }
}
async function exportStatement() {
  if (!active || actions.exporting || actions.generating) return
  const result = form.result, revision = statementRevision
  const current = () => active && revision === statementRevision
  if (!result?.id || !result.bookId) return ElMessage.warning('请先生成对账单')
  if (!user.hasPerm('ap:statement:export')) return ElMessage.warning('没有导出对账单权限')
  actions.exporting = true
  actions.error = ''
  try {
    await http.postIdem('/ap/statements/' + result.id + '/export', { bookId: result.bookId }, exportIntent, { silent: true })
    exportIntent.reset()
    if (!current()) return
    ElMessage.success('导出任务已创建')
    await router.push('/jobs')
  } catch (error) {
    if (current()) actions.error = feedbackMessage(error, "操作未完成，请重试")
  } finally {
    if (active) actions.exporting = false
  }
}
watch(statementContext, () => { statementRevision++; form.result = null; actions.error = '' }, { flush: 'sync' })
watch(() => route.query.bookId, () => { selectBook(Number(route.query.bookId)) }, { flush: 'sync' })
watch(id, () => { void load() }, { flush: 'sync' })
onMounted(() => { void load(); void loadReferences() })
onBeforeUnmount(() => { active = false })
</script>

<template>
  <div class="page partner-ledger">
    <div class="ledger-content">
      <header class="page-title ledger-header">
        <div><el-button link type="primary" @click="router.push('/ap/bills')">返回账单</el-button><h2>供应商往来</h2></div>
        <el-button :loading="balance.loading || records.loading" @click="load()">刷新往来</el-button>
      </header>

      <section class="page-card" aria-labelledby="balance-title">
        <div class="section-heading"><div><h3 id="balance-title">往来余额</h3><p class="partner-name">{{ partnerName }}</p></div><span class="muted">各币种分别列示</span></div>
        <div v-if="balance.loading" class="section-loading" role="status">正在读取余额…</div>
        <div v-else-if="balance.error" class="section-error" role="alert"><div  class="request-state" role="status"><p class="muted">操作未完成，请查看全局提示。</p></div><el-button @click="load('balance')">重新读取余额</el-button></div>
        <el-table v-else-if="balance.data" :data="balance.data.byCurrency" border stripe class="ledger-table">
          <el-table-column label="币种" width="110"><template #default="{ row }">{{ row.currency?.trim() || '币种未提供' }}</template></el-table-column>
          <el-table-column v-for="column in balanceColumns" :key="column.key" :label="column.label" min-width="170" align="right"><template #default="{ row }"><MoneyText v-if="row.currency?.trim()" :value="row[column.key]" :currency="row.currency" /><span v-else class="muted">币种未提供</span></template></el-table-column>
          <template #empty><el-empty :image-size="48" description="暂无往来余额" /></template>
        </el-table>
      </section>

      <section class="page-card" aria-labelledby="statement-title">
        <div class="section-heading"><h3 id="statement-title">生成对账单</h3><span class="muted">以下条件仅用于生成对账单</span></div>
        <div v-if="references.loading" class="reference-loading" role="status">正在读取账套与币种…</div>
        <div v-if="references.error" class="section-error" role="alert"><div  class="request-state" role="status"><p class="muted">操作未完成，请查看全局提示。</p></div><el-button @click="loadReferences">重新读取选项</el-button></div>
        <el-form label-position="top" class="statement-form" :disabled="references.loading || !!references.error || actions.generating || actions.exporting">
          <el-form-item label="账套" required><el-select v-model="form.bookId" placeholder="请选择对账账套"><el-option v-for="book in books" :key="book.id" :label="book.name" :value="book.id" /></el-select></el-form-item>
          <el-form-item label="币种" required><el-select v-model="form.currency" placeholder="请选择币种"><el-option v-for="currency in currencies" :key="currency.code" :label="currency.code" :value="currency.code" /></el-select></el-form-item>
          <el-form-item label="开始日期"><el-date-picker v-model="form.periodStart" type="date" value-format="YYYY-MM-DD" placeholder="选择开始日期" /></el-form-item>
          <el-form-item label="结束日期"><el-date-picker v-model="form.periodEnd" type="date" value-format="YYYY-MM-DD" placeholder="选择结束日期" /></el-form-item>
        </el-form>
        <div class="statement-actions">
          <el-button v-if="user.hasPerm('ap:statement:view')" type="primary" :disabled="!form.bookId || references.loading || !!references.error || actions.exporting" :loading="actions.generating" @click="statement">生成对账单</el-button>
          <el-button v-if="form.result && user.hasPerm('ap:statement:export')" :loading="actions.exporting" :disabled="actions.generating" @click="exportStatement">导出已保存对账单</el-button>
          <span v-if="!references.loading && !references.error && !books.length" class="muted">暂无可选账套</span>
        </div>
        <div v-if="actions.error" class="request-state" role="status"><p class="muted">操作未完成，请查看全局提示。</p></div>
        <div v-if="form.result" class="statement-result">
          <el-alert :type="form.result.identityOk ? 'success' : 'warning'" :title="form.result.identityOk ? '对账单已生成，期初与期间明细已核对' : '对账单已生成，请核对期末余额'" show-icon :closable="false" />
          <dl class="statement-values"><div v-for="field in statementFields" :key="field.key"><dt>{{ field.label }}</dt><dd><MoneyText v-if="form.result.currency" :value="form.result[field.key]" :currency="form.result.currency" /><span v-else>币种未提供</span></dd></div></dl>
        </div>
      </section>

      <section class="page-card" aria-labelledby="records-title">
        <div class="section-heading"><h3 id="records-title">往来明细</h3><span v-if="records.data" class="muted">本次读取 {{ records.data.length }} 条</span></div>
        <div v-if="records.loading" class="section-loading" role="status">正在读取往来记录…</div>
        <div v-else-if="records.error" class="section-error" role="alert"><div  class="request-state" role="status"><p class="muted">操作未完成，请查看全局提示。</p></div><el-button @click="load('records')">重新读取记录</el-button></div>
        <el-table v-else-if="records.data" :data="records.data" border stripe class="ledger-table">
          <el-table-column label="发生时间" min-width="210"><template #default="{ row }"><DateTimeText :value="row.at" /></template></el-table-column>
          <el-table-column label="业务类型" width="100"><template #default="{ row }">{{ row.type || '类型未提供' }}</template></el-table-column>
          <el-table-column label="单据编号" min-width="260" show-overflow-tooltip><template #default="{ row }"><span class="mono">{{ row.no || '单号未提供' }}</span></template></el-table-column>
          <el-table-column label="币种" width="110"><template #default="{ row }">{{ row.currency?.trim() || '币种未提供' }}</template></el-table-column>
          <el-table-column label="单据金额" min-width="170" align="right"><template #default="{ row }"><MoneyText v-if="row.currency?.trim()" :value="row.amount" :currency="row.currency" /><span v-else class="muted">币种未提供</span></template></el-table-column>
          <template #empty><el-empty :image-size="48" description="暂无往来记录" /></template>
        </el-table>
      </section>
    </div>
  </div>
</template>

<style scoped>
.ledger-content { width: 100%; max-width: 1360px; min-width: 0; }
.ledger-header > div { display: flex; align-items: center; flex-wrap: wrap; gap: 12px; }
.section-heading { display: flex; align-items: center; justify-content: space-between; flex-wrap: wrap; gap: 8px 16px; margin-bottom: 16px; }
.section-heading h3 { margin: 0; font-size: 16px; font-weight: 600; }
.partner-name { margin: 8px 0 0; font-size: 18px; font-weight: 600; overflow-wrap: anywhere; }
.section-loading { padding: 24px 0; color: var(--el-text-color-regular); font-size: 14px; }
.section-error { display: grid; justify-items: start; gap: 12px; }
.section-error .el-alert { width: 100%; }
.ledger-table { width: 100%; font-size: 14px; }
.ledger-table :deep(.el-table__cell) { padding: 11px 0; }
.ledger-table :deep(th.el-table__cell) { background: var(--el-fill-color-light); color: var(--el-text-color-regular); }
.ledger-table :deep(.mono) { font-variant-numeric: tabular-nums; }
.statement-form { display: grid; grid-template-columns: minmax(180px, 1.3fr) minmax(110px, .7fr) repeat(2, minmax(170px, 1fr)); gap: 0 16px; }
.statement-form :deep(.el-form-item) { min-width: 0; margin-bottom: 16px; }
.statement-form :deep(.el-select), .statement-form :deep(.el-date-editor.el-input) { width: 100%; }
.statement-actions { display: flex; align-items: center; flex-wrap: wrap; gap: 8px; }
.statement-actions :deep(.el-button + .el-button) { margin-left: 0; }
.reference-loading { margin-bottom: 12px; font-size: 13px; color: var(--el-text-color-regular); }
.action-error, .statement-result { margin-top: 16px; }
.statement-values { display: grid; grid-template-columns: repeat(6, minmax(0, 1fr)); gap: 16px; margin: 16px 0 0; }
.statement-values > div { min-width: 0; }
.statement-values dt { margin-bottom: 8px; font-size: 13px; color: var(--el-text-color-regular); }
.statement-values dd { margin: 0; font-size: 14px; overflow-wrap: anywhere; }
.statement-values > div:last-child dd { font-weight: 600; }
.partner-ledger :deep(.el-button:focus-visible) { outline: 2px solid var(--el-color-primary); outline-offset: 3px; }
@media (max-width: 1000px) {
  .statement-form { grid-template-columns: repeat(2, minmax(0, 1fr)); }
  .statement-values { grid-template-columns: repeat(3, minmax(0, 1fr)); }
}
@media (max-width: 600px) {
  .ledger-header { align-items: flex-start; flex-wrap: wrap; }
  .statement-form { grid-template-columns: minmax(0, 1fr); }
  .statement-values { grid-template-columns: repeat(2, minmax(0, 1fr)); }
  .partner-name { font-size: 16px; }
}
</style>
