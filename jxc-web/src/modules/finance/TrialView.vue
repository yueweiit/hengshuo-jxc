<script setup lang="ts">
import { computed, onBeforeUnmount, onMounted, ref, watch } from 'vue'
import { http } from '@/api/http'
import { useRouter } from 'vue-router'
import { useCountryStore } from '@/stores/country'
import MoneyText from '@/components/MoneyText.vue'
import StatusTag from '@/components/StatusTag.vue'

type Row = Record<string, any>
const country = useCountryStore(), router = useRouter()
const books = ref<Row[]>([]), bookId = ref<number>(), periodId = ref<number>()
const data = ref<Row | null>(null), busy = ref(false), booksLoading = ref(false)
const booksError = ref(''), loadError = ref(''), navigationError = ref('')
const keyword = ref(''), currentPage = ref(1), pageSize = ref(20)
const selectedBook = computed(() => books.value.find(book => book.id === bookId.value))
// An unselected book has no periods; malformed responses are rejected in loadBooks.
const periods = computed<Row[]>(() => selectedBook.value?.periods ?? [])
const selectedPeriod = computed(() => periods.value.find(period => period.id === periodId.value))
const canQuery = computed(() => !!selectedBook.value && !!selectedPeriod.value && !booksLoading.value && !booksError.value)
const baseCurrency = computed(() => data.value?.currency ?? selectedBook.value?.baseCurrency)
const groups = [
  { label: '期初余额', amounts: [{ label: '借方', summary: 'openingDebit', row: 'openingDebit' }, { label: '贷方', summary: 'openingCredit', row: 'openingCredit' }] },
  { label: '本期发生', amounts: [{ label: '借方', summary: 'periodDebit', row: 'periodDebit' }, { label: '贷方', summary: 'periodCredit', row: 'periodCredit' }] },
  { label: '期末余额', amounts: [{ label: '借方', summary: 'debit', row: 'closingDebit' }, { label: '贷方', summary: 'credit', row: 'closingCredit' }] },
]
const resultState = computed(() => {
  if (data.value?.balanced === true) return {
    type: 'success' as const, title: '试算平衡',
    description: '本期发生及期末余额的借贷合计一致。期初金额单独列示，可结合科目明细核对。',
  }
  if (data.value?.balanced === false) return {
    type: 'error' as const, title: '借贷不平',
    description: '本期发生或期末余额存在借贷不一致，请查看科目明细核对。',
  }
  return { type: 'info' as const, title: '平衡状态未提供', description: '请重新查询或联系管理员核实；已返回的金额和科目明细仍可查看。' }
})
const sourceText = computed(() => {
  const source = data.value?.source
  if (source === 'POSTED_FACTS') return '已过账凭证'
  if (source === 'CLOSED_SNAPSHOT') return '已结账快照'
  return source == null || source === '' ? '来源未提供' : String(source)
})
const filteredRows = computed<Row[]>(() => {
  const query = keyword.value.trim().toLowerCase()
  // Null data is not loaded; the template checks loading/error before showing rows.
  const rows: Row[] = data.value?.rows ?? []
  // Missing optional labels contribute no searchable text; no identity is inferred.
  return query ? rows.filter(row => `${row.code ?? ''} ${row.name ?? ''}`.toLowerCase().includes(query)) : rows
})
// The endpoint returns complete rows, so search the full result before local pagination.
const pageRows = computed(() => filteredRows.value.slice((currentPage.value - 1) * pageSize.value, currentPage.value * pageSize.value))
watch([keyword, pageSize], () => { currentPage.value = 1 }, { flush: 'sync' })
let requestSequence = 0, booksSequence = 0, disposed = false
const scope = () => `${bookId.value}:${periodId.value}`
const isRow = (value: unknown): value is Row => value != null && typeof value === 'object' && !Array.isArray(value)
const validId = (value: unknown) => typeof value === 'number' && Number.isSafeInteger(value) && value > 0
const validCurrency = (value: unknown) => value == null || typeof value === 'string' && /^[A-Z]{3}$/.test(value)
const validAmount = (value: unknown) => value == null || typeof value === 'number' && Number.isFinite(value) ||
  typeof value === 'string' && value.trim() !== '' && Number.isFinite(Number(value))
function errorText(error: unknown) {
  const reason = error instanceof Error ? error.message : typeof error === 'string' ? error : ''
  return reason.trim() ? reason : '读取失败，服务未提供错误说明，请重试。'
}
function validateTrial(value: unknown, book: number, period: number): asserts value is Row {
  const summaryKeys = groups.flatMap(group => group.amounts.map(amount => amount.summary))
  const rowKeys = groups.flatMap(group => group.amounts.map(amount => amount.row))
  if (!isRow(value) || !Array.isArray(value.rows) || !value.rows.every(row => isRow(row) && rowKeys.every(key => validAmount(row[key]))) ||
    !summaryKeys.every(key => validAmount(value[key])) || !validCurrency(value.currency) || value.balanced != null && typeof value.balanced !== 'boolean') {
    throw new Error('试算数据格式异常，请重新查询；如仍失败，请联系管理员。')
  }
  if (value.bookId != null && value.bookId !== book || value.periodId != null && value.periodId !== period) {
    throw new Error('返回结果与所选账套或期间不一致，请重新查询。')
  }
}
async function loadBooks() {
  const sequence = ++booksSequence
  booksLoading.value = true; booksError.value = ''
  try {
    const result = await http.get<unknown>('/fin/books', undefined, { silent: true })
    if (disposed || sequence !== booksSequence) return
    if (!Array.isArray(result) || !result.every(book => isRow(book) && validId(book.id) && validCurrency(book.baseCurrency) &&
      Array.isArray(book.periods) && book.periods.every((period: unknown) => isRow(period) && validId(period.id)))) {
      throw new Error('账套或期间数据格式异常，请重新加载。')
    }
    books.value = result
    if (bookId.value != null && (!selectedBook.value || periodId.value != null && !selectedPeriod.value)) {
      if (!selectedBook.value) bookId.value = undefined
      changeBook()
    }
  } catch (error) {
    if (!disposed && sequence === booksSequence) booksError.value = errorText(error)
  } finally {
    if (!disposed && sequence === booksSequence) booksLoading.value = false
  }
}
async function load() {
  const sequence = ++requestSequence, selectedScope = scope(), selectedBookId = bookId.value, selectedPeriodId = periodId.value
  const current = () => !disposed && sequence === requestSequence && selectedScope === scope()
  data.value = null; loadError.value = ''; navigationError.value = ''; busy.value = false; currentPage.value = 1
  if (disposed || selectedBookId == null || selectedPeriodId == null) return
  if (!canQuery.value) { loadError.value = '请选择当前账套内的有效期间后查询。'; return }
  busy.value = true
  try {
    const result = await http.get<unknown>('/fin/trial-balance', { bookId: selectedBookId, periodId: selectedPeriodId }, { silent: true })
    if (!current()) return
    validateTrial(result, selectedBookId, selectedPeriodId)
    data.value = result
  } catch (error) {
    if (current()) loadError.value = errorText(error)
  } finally {
    if (current()) busy.value = false
  }
}
function changeBook() {
  requestSequence++; periodId.value = undefined; data.value = null; busy.value = false
  loadError.value = ''; navigationError.value = ''; keyword.value = ''; currentPage.value = 1
}
async function changePeriod() { keyword.value = ''; await load() }
function openLedger(row: Row) {
  if (disposed || !data.value || busy.value || !canQuery.value) return
  if (!validId(row.accountId)) { navigationError.value = '该行未提供有效科目引用，无法打开明细账，请重新查询。'; return }
  navigationError.value = ''
  router.push({ path: '/finance/ledgers', query: { bookId: bookId.value, periodId: periodId.value, accountId: row.accountId } })
}
onMounted(loadBooks)
onBeforeUnmount(() => { disposed = true; requestSequence++; booksSequence++ })
</script>

<template>
  <div class="page trial-page">
    <section class="page-card">
      <div class="page-title trial-heading">
        <div>
          <h2>试算平衡</h2>
          <p class="muted trial-description">核对本期发生与期末借贷余额，按科目追溯明细账。</p>
        </div>
        <el-button type="primary" :loading="busy" :disabled="!canQuery || busy" @click="load">重新查询</el-button>
      </div>
      <el-form class="trial-filters" label-position="top" @submit.prevent>
        <el-form-item label="账套">
          <el-select v-model="bookId" clearable filterable placeholder="请选择账套" :loading="booksLoading" :disabled="booksLoading" @change="changeBook">
            <el-option v-for="book in books" :key="book.id" :value="book.id" :label="book.name ?? '账套 #' + book.id" />
          </el-select>
        </el-form-item>
        <el-form-item label="会计期间">
          <el-select v-model="periodId" clearable placeholder="请选择期间" :disabled="!bookId || booksLoading" @change="changePeriod">
            <el-option v-for="period in periods" :key="period.id" :value="period.id" :label="period.name ?? '期间 #' + period.id" />
          </el-select>
        </el-form-item>
        <el-form-item label="科目搜索">
          <el-input v-model="keyword" clearable placeholder="搜索科目编码或名称" :disabled="!data || busy || booksLoading" />
        </el-form-item>
      </el-form>
      <div class="trial-context muted">
        <span>{{ selectedBook?.name ?? '尚未选择账套' }}</span>
        <span class="trial-period">期间：{{ data?.periodName ?? selectedPeriod?.name ?? '尚未选择' }} <StatusTag v-if="selectedPeriod?.status != null" :status="selectedPeriod.status" domain="period" /></span>
        <span>本位币：{{ baseCurrency ?? '未提供' }}</span>
        <span>国家时区：{{ country.timezone }}</span>
      </div>
      <div class="trial-content" aria-live="polite" :aria-busy="busy || booksLoading">
        <div v-if="booksLoading" class="trial-state muted" role="status">正在读取账套与期间…</div>
        <el-alert v-else-if="booksError" type="error" :closable="false" show-icon :title="'账套读取失败：' + booksError">
          <el-button link type="primary" @click="loadBooks">重新加载账套</el-button>
        </el-alert>
        <el-empty v-else-if="!books.length" :image-size="64" description="当前没有可用账套" />
        <el-empty v-else-if="!bookId || !periodId" :image-size="64" description="请选择账套与会计期间查看试算结果" />
        <div v-else-if="busy" class="trial-state muted" role="status">正在读取试算结果…</div>
        <el-alert v-else-if="loadError" type="error" :closable="false" show-icon :title="'试算结果读取失败：' + loadError">
          <el-button link type="primary" @click="load">重新查询</el-button>
        </el-alert>
        <template v-else-if="data">
          <el-alert :type="resultState.type" :title="resultState.title" :description="resultState.description" :closable="false" show-icon />
          <div class="trial-summary-heading">
            <h3>本期间全部科目汇总</h3>
            <span class="muted">{{ sourceText }}<template v-if="data.source === 'CLOSED_SNAPSHOT' && data.snapshotId != null"> · 快照 #{{ data.snapshotId }}</template></span>
          </div>
          <div class="trial-summaries">
            <div v-for="group in groups" :key="group.label" class="trial-summary">
              <h4>{{ group.label }}</h4>
              <div v-for="amount in group.amounts" :key="amount.summary" class="trial-amount">
                <span class="muted">{{ amount.label }}</span>
                <MoneyText v-if="baseCurrency" :value="data[amount.summary]" :currency="baseCurrency" />
                <span v-else class="mono">{{ data[amount.summary] ?? '-' }}</span>
              </div>
            </div>
          </div>
          <div class="trial-detail-heading">
            <h3>科目明细</h3>
            <span class="muted">共 {{ data.rows.length }} 个科目<template v-if="keyword.trim()">，匹配 {{ filteredRows.length }} 个</template>；搜索与分页不改变上方汇总</span>
          </div>
          <el-alert v-if="navigationError" type="error" :closable="false" show-icon :title="navigationError" />
          <div class="table-scroll">
            <el-table :data="pageRows" border stripe size="small" :empty-text="data.rows.length ? '没有匹配的科目，可调整或清空搜索条件' : '当前期间暂无科目余额记录'">
              <el-table-column label="科目编码" min-width="120" show-overflow-tooltip><template #default="{ row }"><span class="mono">{{ row.code ?? '-' }}</span></template></el-table-column>
              <el-table-column label="科目名称" min-width="180" show-overflow-tooltip><template #default="{ row }">{{ row.name ?? '-' }}</template></el-table-column>
              <el-table-column v-for="group in groups" :key="group.label" :label="group.label" align="center">
                <el-table-column v-for="amount in group.amounts" :key="amount.row" :label="amount.label" min-width="150" align="right">
                  <template #default="{ row }"><MoneyText v-if="baseCurrency" :value="row[amount.row]" :currency="baseCurrency" /><span v-else class="mono">{{ row[amount.row] ?? '-' }}</span></template>
                </el-table-column>
              </el-table-column>
              <el-table-column label="操作" min-width="130" fixed="right" align="right">
                <template #default="{ row }"><el-button v-if="validId(row.accountId)" link type="primary" size="small" :aria-label="'查看科目 ' + (row.code ?? row.accountId) + ' 的明细账'" @click="openLedger(row)">查看明细</el-button><span v-else class="muted">科目引用未提供</span></template>
              </el-table-column>
            </el-table>
          </div>
          <div class="trial-pagination">
            <span class="muted">共 {{ filteredRows.length }} 条 · 金额按本位币展示</span>
            <el-pagination v-model:current-page="currentPage" v-model:page-size="pageSize" :page-sizes="[20, 50, 100]" :total="filteredRows.length" :pager-count="5" layout="sizes, prev, pager, next" background />
          </div>
        </template>
      </div>
    </section>
  </div>
</template>

<style scoped>
.trial-page, .trial-content { min-width: 0; }
.trial-heading { align-items: flex-start; flex-wrap: wrap; }
.trial-description { margin: 8px 0 0; line-height: 1.6; }
.trial-filters { display: grid; grid-template-columns: minmax(160px, 1fr) minmax(160px, 1fr) minmax(220px, 1fr); gap: 0 16px; }
.trial-filters .el-form-item { min-width: 0; margin-bottom: 12px; }
.trial-filters .el-select { width: 100%; }
.trial-context { display: flex; flex-wrap: wrap; align-items: center; gap: 8px 16px; padding: 12px 0; border-top: 1px solid var(--el-border-color-lighter); line-height: 1.6; overflow-wrap: anywhere; }
.trial-period { display: inline-flex; flex-wrap: wrap; align-items: center; gap: 8px; }
.trial-state { padding: 48px 12px; text-align: center; }
.trial-content > .el-alert { margin: 8px 0 16px; }
.trial-summary-heading, .trial-detail-heading { display: flex; flex-wrap: wrap; align-items: center; justify-content: space-between; gap: 8px 16px; margin: 16px 0 12px; line-height: 1.6; }
.trial-content h3, .trial-content h4 { margin: 0; font-size: 14px; font-weight: 600; }
.trial-summaries { display: grid; grid-template-columns: repeat(3, minmax(0, 1fr)); background: var(--el-fill-color-light); border-radius: 4px; }
.trial-summary { min-width: 0; padding: 12px 16px; }
.trial-summary + .trial-summary { border-left: 1px solid var(--el-border-color-lighter); }
.trial-summary h4 { margin-bottom: 12px; }
.trial-amount { display: flex; flex-wrap: wrap; align-items: baseline; justify-content: space-between; gap: 8px 12px; line-height: 1.6; overflow-wrap: anywhere; }
.trial-amount + .trial-amount { margin-top: 8px; }
.trial-amount :deep(.mono) { text-align: right; }
.trial-pagination { display: flex; flex-wrap: wrap; align-items: center; justify-content: space-between; gap: 12px; margin-top: 16px; }
.trial-pagination .el-pagination { flex-wrap: wrap; row-gap: 8px; }
.trial-page :deep(button:focus-visible) { outline: 2px solid var(--el-color-primary); outline-offset: 3px; }
@media (max-width: 1024px) {
  .trial-filters { grid-template-columns: repeat(2, minmax(0, 1fr)); }
  .trial-filters .el-form-item:last-child { grid-column: 1 / -1; }
}
@media (max-width: 768px) {
  .trial-filters { grid-template-columns: minmax(0, 1fr); }
  .trial-summaries { grid-template-columns: minmax(0, 1fr); }
  .trial-summary { padding: 12px; }
  .trial-summary + .trial-summary { border-left: 0; border-top: 1px solid var(--el-border-color-lighter); }
  .trial-pagination :deep(.el-pagination__sizes) { margin-right: 8px; }
  .trial-pagination :deep(.el-pager li) { min-width: 24px; margin: 0 2px; }
}
</style>
