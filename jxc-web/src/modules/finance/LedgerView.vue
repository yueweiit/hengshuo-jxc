<script setup lang="ts">
import { feedbackMessage } from '@/api/error-feedback'
import { computed, onBeforeUnmount, onMounted, ref, watch } from 'vue'
import { http, createCommandIntent } from '@/api/http'
import { ElMessage } from 'element-plus'
import { useUserStore } from '@/stores/user'
import { allRecords } from '@/api/pagination'
import { financeSourcePath } from '@/utils/finance-source'
import { formatDate } from '@/utils/format'
import MoneyText from '@/components/MoneyText.vue'
import { useRouter, useRoute } from 'vue-router'
import { useCountryStore } from '@/stores/country'

type Row = Record<string, any>
type LedgerTab = 'general' | 'balance' | 'detail' | 'journal'
const country = useCountryStore(), user = useUserStore(), exportIntent = createCommandIntent()
const router = useRouter(), route = useRoute()
const books = ref<Row[]>([]), accounts = ref<Row[]>([]), periods = ref<Row[]>([])
const bookId = ref<number>(), periodId = ref<number>(), accountId = ref<number>(), fundAccountId = ref<number>()
const fundAccounts = ref<Row[]>([]), auxKey = ref(''), tab = ref<LedgerTab>('general')
const detail = ref<Row | null>(null), general = ref<Row | null>(null), balance = ref<Row | null>(null), journalData = ref<Row | null>(null)
const allJournal = ref<Row[]>([])
const loading = ref(false), detailLoading = ref(false), booksLoading = ref(false), accountsLoading = ref(false), exporting = ref(false)
const booksError = ref(''), accountsError = ref(''), exportError = ref(''), navigationError = ref('')
const ledgerErrors = ref<Record<LedgerTab, string>>({ general: '', balance: '', detail: '', journal: '' })
const currentPage = ref(1), pageSize = ref(20)
watch([tab, accountId, fundAccountId, auxKey, pageSize], () => { currentPage.value = 1 }, { flush: 'sync' })
const tabs: { name: LedgerTab; label: string }[] = [
  { name: 'general', label: '总账' }, { name: 'balance', label: '科目余额（辅助项）' },
  { name: 'detail', label: '明细账' }, { name: 'journal', label: '现金银行日记账' },
]
const amountGroups = [
  { key: 'opening', label: '期初余额' }, { key: 'period', label: '本期发生' }, { key: 'closing', label: '期末余额' },
]
const detailAmounts = [
  { key: 'openingDebit', label: '期初借方' }, { key: 'openingCredit', label: '期初贷方' },
  { key: 'closingDebit', label: '期末借方' }, { key: 'closingCredit', label: '期末贷方' },
]
const journal = computed(() => allJournal.value.filter(line =>
  (accountId.value == null || line.accountId === accountId.value) &&
  (fundAccountId.value == null || line.aux?.fundAccountId === fundAccountId.value)))
// A null response means not loaded; only successful validated responses supply rows.
const generalRows = computed<Row[]>(() => (general.value?.rows ?? []).filter((row: Row) => accountId.value == null || row.accountId === accountId.value))
const balanceRows = computed<Row[]>(() => (balance.value?.rows ?? []).filter((row: Row) => accountId.value == null || row.accountId === accountId.value))
const activeData = computed(() => ({ general: general.value, balance: balance.value, detail: detail.value, journal: journalData.value })[tab.value])
const currentRows = computed<Row[]>(() => tab.value === 'general' ? generalRows.value : tab.value === 'balance' ? balanceRows.value : tab.value === 'journal' ? journal.value : detail.value?.lines ?? [])
// Ledger endpoints return complete results; filter the complete response before local pagination.
const pageRows = computed(() => currentRows.value.slice((currentPage.value - 1) * pageSize.value, currentPage.value * pageSize.value))
const activeLoading = computed(() => loading.value || tab.value === 'detail' && detailLoading.value)
const activeError = computed(() => ledgerErrors.value[tab.value])
const baseCurrency = computed(() => activeData.value?.currency ?? books.value.find(b => b.id === bookId.value)?.baseCurrency)
const selectedBook = computed(() => books.value.find(b => b.id === bookId.value))
const selectedPeriod = computed(() => periods.value.find(p => p.id === periodId.value))
const isSummary = computed(() => tab.value === 'general' || tab.value === 'balance')
const canExport = computed(() => user.hasPerm('fin:ledger:export') && bookId.value != null && periodId.value != null &&
  (tab.value !== 'detail' || accountId.value != null) && !!activeData.value && !activeError.value && !activeLoading.value && !exporting.value)
const sourceText = computed(() => activeData.value?.source === 'CLOSED_SNAPSHOT' ? '已结账快照' : activeData.value?.source === 'POSTED_FACTS' ? '已过账凭证' : '')
let bookSequence = 0, accountsSequence = 0, requestSequence = 0, detailSequence = 0, booksSequence = 0, disposed = false
const scope = () => `${bookId.value}:${periodId.value}`
const isRow = (value: unknown): value is Row => value != null && typeof value === 'object' && !Array.isArray(value)

function validateLedger(value: unknown, type: LedgerTab): asserts value is Row {
  const rows = isRow(value) ? value[type === 'journal' || type === 'detail' ? 'lines' : 'rows'] : undefined
  if (!isRow(value) || !Array.isArray(rows) || !rows.every(isRow) || type === 'detail' && !isRow(value.account)) {
    throw new Error('账簿数据格式异常，请重新加载；如仍失败，请联系管理员。')
  }
}
async function selectAccount(row: Row) {
  accountId.value = row.accountId
  auxKey.value = typeof row.auxKey === 'string' ? row.auxKey : ''
  tab.value = 'detail'
  await loadDetail()
}
async function changeAccount() { auxKey.value = ''; await loadDetail() }
async function clearAux() { auxKey.value = ''; await loadDetail() }
async function loadDetail() {
  const sequence = ++detailSequence, selectedScope = scope(), selectedAccount = accountId.value, selectedAux = auxKey.value
  const current = () => !disposed && sequence === detailSequence && selectedScope === scope() && selectedAccount === accountId.value && selectedAux === auxKey.value
  detail.value = null; ledgerErrors.value.detail = ''; detailLoading.value = false
  if (disposed || selectedAccount == null || bookId.value == null || periodId.value == null) return
  detailLoading.value = true
  try {
    const result = await http.get<unknown>('/fin/ledgers/detail', { bookId: bookId.value, accountId: selectedAccount, periodId: periodId.value, auxKey: selectedAux || undefined }, { silent: true })
    if (!current()) return
    validateLedger(result, 'detail'); detail.value = result
  } catch (error) {
    if (current()) ledgerErrors.value.detail = feedbackMessage(error, "读取或操作失败，服务未提供错误说明，请重试。")
  } finally {
    if (current()) detailLoading.value = false
  }
}
async function load() {
  const sequence = ++requestSequence, selectedScope = scope()
  const current = () => !disposed && sequence === requestSequence && selectedScope === scope()
  general.value = balance.value = detail.value = journalData.value = null
  allJournal.value = []; fundAccounts.value = []; detailSequence++; detailLoading.value = false
  ledgerErrors.value = { general: '', balance: '', detail: '', journal: '' }
  currentPage.value = 1; loading.value = false
  if (disposed || bookId.value == null || periodId.value == null) return
  loading.value = true
  const query = { bookId: bookId.value, periodId: periodId.value }
  const types = ['general', 'balance', 'journal'] as const
  const results = await Promise.allSettled(types.map(async type => {
    const result = await http.get<unknown>('/fin/ledgers/' + type, query, { silent: true })
    validateLedger(result, type)
    return result
  }))
  if (!current()) return
  results.forEach((result, index) => {
    const type = types[index]!
    if (result.status === 'rejected') { ledgerErrors.value[type] = feedbackMessage(result.reason, "读取或操作失败，服务未提供错误说明，请重试。"); return }
    if (type === 'general') general.value = result.value
    else if (type === 'balance') balance.value = result.value
    else {
      journalData.value = result.value; allJournal.value = result.value.lines
      fundAccounts.value = Array.from(new Set(allJournal.value.map(line => line.aux?.fundAccountId).filter(id => id != null)))
        .map(id => ({ id, name: '资金账户 #' + id }))
    }
  })
  loading.value = false
  await loadDetail()
}
async function changePeriod() { fundAccountId.value = undefined; auxKey.value = ''; await load() }
async function changeBook(autoLoad = true) {
  const sequence = ++bookSequence, selected = bookId.value
  const current = () => !disposed && sequence === bookSequence && selected === bookId.value
  requestSequence++; detailSequence++; accountsSequence++
  periodId.value = accountId.value = fundAccountId.value = undefined; auxKey.value = ''
  detail.value = general.value = balance.value = journalData.value = null
  allJournal.value = []; fundAccounts.value = []; accounts.value = []
  ledgerErrors.value = { general: '', balance: '', detail: '', journal: '' }; accountsError.value = ''; navigationError.value = ''
  loading.value = detailLoading.value = accountsLoading.value = false; currentPage.value = 1
  periods.value = books.value.find(b => b.id === selected)?.periods ?? []
  if (disposed || selected == null) return
  await loadAccounts()
  if (current() && periods.value.length === 1) {
    periodId.value = periods.value[0]!.id
    if (autoLoad) await load()
  }
}
async function loadAccounts() {
  const sequence = ++accountsSequence, selected = bookId.value
  const current = () => !disposed && sequence === accountsSequence && selected === bookId.value
  accountsError.value = ''; accountsLoading.value = false
  if (disposed || selected == null) return
  accountsLoading.value = true
  try {
    const result = await allRecords<Row>('/fin/accounts', { bookId: selected }, () => { if (!current()) throw new Error('账套已切换') })
    if (!current()) return
    if (!Array.isArray(result) || !result.every(row => isRow(row) && row.id != null)) throw new Error('科目数据格式异常，请重新加载。')
    accounts.value = result
  } catch (error) {
    if (current()) accountsError.value = feedbackMessage(error, "读取或操作失败，服务未提供错误说明，请重试。")
  } finally {
    if (current()) accountsLoading.value = false
  }
}
async function loadBooks() {
  const sequence = ++booksSequence
  booksLoading.value = true; booksError.value = ''
  try {
    const result = await http.get<unknown>('/fin/books', undefined, { silent: true })
    if (disposed || sequence !== booksSequence) return
    if (!Array.isArray(result) || !result.every(book => isRow(book) && book.id != null && Array.isArray(book.periods) && book.periods.every((p: unknown) => isRow(p) && p.id != null))) {
      throw new Error('账套数据格式异常，请重新加载。')
    }
    books.value = result
  } catch (error) {
    if (!disposed && sequence === booksSequence) booksError.value = feedbackMessage(error, "读取或操作失败，服务未提供错误说明，请重试。")
  } finally {
    if (!disposed && sequence === booksSequence) booksLoading.value = false
  }
}
async function initialize() {
  await loadBooks()
  if (disposed || booksError.value || route.query.bookId == null) return
  const requestedBook = Number(route.query.bookId)
  if (!books.value.some(book => book.id === requestedBook)) { navigationError.value = '链接中的账套不可用，请重新选择账套。'; return }
  bookId.value = requestedBook
  await changeBook(false)
  if (disposed || bookId.value !== requestedBook) return
  if (route.query.periodId != null) {
    const requestedPeriod = Number(route.query.periodId)
    periodId.value = periods.value.some(p => p.id === requestedPeriod) ? requestedPeriod : undefined
    if (periodId.value == null) navigationError.value = '链接中的期间不属于当前账套，请重新选择期间。'
  }
  if (route.query.accountId != null) {
    const requestedAccount = Number(route.query.accountId)
    // Closed snapshots can reference historical accounts absent from current choices.
    // The ledger endpoint validates the supplied account in its authoritative scope.
    if (Number.isSafeInteger(requestedAccount) && requestedAccount > 0) {
      accountId.value = requestedAccount; tab.value = route.query.tab === 'balance' ? 'balance' : 'detail'
    } else navigationError.value = '链接中的科目不可用，请重新选择科目。'
  }
  await load()
}
async function exportLedger() {
  if (!canExport.value) return
  exporting.value = true; exportError.value = ''
  const selectedTab = tab.value
  try {
    await http.postIdem('/fin/ledgers/' + selectedTab + '/export', {
      bookId: bookId.value, periodId: periodId.value, accountId: accountId.value,
      auxKey: selectedTab === 'detail' ? auxKey.value || undefined : undefined,
      fundAccountId: selectedTab === 'journal' ? fundAccountId.value : undefined,
    }, exportIntent)
    exportIntent.reset()
  } catch (error) {
    if (!disposed) exportError.value = feedbackMessage(error, "读取或操作失败，服务未提供错误说明，请重试。")
    return
  } finally {
    if (!disposed) exporting.value = false
  }
  if (disposed) return
  ElMessage.success('导出任务已创建')
  try { await router.push('/jobs') }
  catch (error) { exportError.value = '导出任务已创建，无需重复导出；打开任务中心失败：' + feedbackMessage(error, "读取或操作失败，服务未提供错误说明，请重试。") }
}
function voucher(row: Row) { router.push({ path: '/finance/vouchers', query: { voucherId: row.voucherId, bookId: bookId.value } }) }
onMounted(initialize)
onBeforeUnmount(() => { disposed = true; bookSequence++; accountsSequence++; requestSequence++; detailSequence++; booksSequence++ })
</script>

<template>
  <div class="page ledger-page">
    <section class="page-card">
      <div class="page-title ledger-heading">
        <div>
          <h2>账簿</h2>
          <p class="muted ledger-description">按账套与会计期间核对科目余额，追溯凭证与业务来源。</p>
        </div>
        <div class="ledger-actions">
          <el-button :loading="loading || booksLoading" :disabled="exporting || accountsLoading || booksLoading || loading" @click="bookId && periodId ? load() : loadBooks()">刷新</el-button>
          <el-button v-if="user.hasPerm('fin:ledger:export')" type="primary" :loading="exporting" :disabled="!canExport" @click="exportLedger">导出当前账簿</el-button>
        </div>
      </div>
      <el-form class="ledger-filters" label-position="top" @submit.prevent>
        <el-form-item label="账套">
          <el-select v-model="bookId" placeholder="请选择账套" clearable filterable :loading="booksLoading" :disabled="booksLoading || exporting" @change="changeBook()">
            <el-option v-for="book in books" :key="book.id" :value="book.id" :label="book.name" />
          </el-select>
        </el-form-item>
        <el-form-item label="会计期间">
          <el-select v-model="periodId" placeholder="请选择期间" clearable :disabled="!bookId || booksLoading || accountsLoading || exporting" @change="changePeriod">
            <el-option v-for="period in periods" :key="period.id" :value="period.id" :label="period.name" />
          </el-select>
        </el-form-item>
        <el-form-item label="会计科目">
          <el-select v-model="accountId" placeholder="全部科目；明细账需选择科目" clearable filterable :loading="accountsLoading" :disabled="!bookId || accountsLoading || !!accountsError || exporting" @change="changeAccount">
            <el-option v-for="account in accounts" :key="account.id" :label="account.code + ' ' + account.name" :value="account.id" />
          </el-select>
        </el-form-item>
      </el-form>
      <div class="ledger-context muted">
        <span>{{ selectedBook?.name ?? '尚未选择账套' }}</span>
        <span>期间：{{ selectedPeriod?.name ?? '尚未选择' }}</span>
        <span>本位币：{{ baseCurrency ?? '未提供' }}</span>
        <span>国家时区：{{ country.timezone }}</span>
      </div>
      <div v-if="booksError" class="request-state" role="status"><p class="muted">操作未完成，请查看全局提示。</p><el-button link type="primary" @click="initialize">重新加载账套</el-button></div>
      <div v-if="accountsError" class="request-state" role="status"><p class="muted">操作未完成，请查看全局提示。</p><el-button link type="primary" :loading="accountsLoading" @click="loadAccounts">重新加载科目</el-button></div>
      <div v-if="navigationError" class="request-state" role="status"><p class="muted">操作未完成，请查看全局提示。</p></div>
      <div v-if="exportError" class="request-state" role="status"><p class="muted">操作未完成，请查看全局提示。</p><el-button link type="primary" @click="router.push('/jobs')">打开任务中心</el-button></div>
      <el-tabs v-model="tab" class="ledger-tabs">
        <el-tab-pane v-for="item in tabs" :key="item.name" :label="item.label" :name="item.name" />
      </el-tabs>
      <div class="ledger-result" aria-live="polite" :aria-busy="activeLoading">
        <div v-if="booksLoading" class="ledger-state muted" role="status">正在读取账套…</div>
        <el-empty v-else-if="!booksError && !books.length" :image-size="64" description="当前没有可用账套" />
        <el-empty v-else-if="!bookId || !periodId" :image-size="64" description="请选择账套与会计期间查看账簿" />
        <div v-else-if="activeLoading" class="ledger-state muted" role="status">正在读取{{ tabs.find(item => item.name === tab)?.label }}…</div>
        <div v-else-if="activeError" class="request-state" role="status"><p class="muted">操作未完成，请查看全局提示。</p><el-button link type="primary" @click="tab === 'detail' ? loadDetail() : load()">重新加载账簿</el-button></div>
        <el-empty v-else-if="tab === 'detail' && !accountId" :image-size="64" description="请选择会计科目，或从总账、科目余额查看明细" />
        <template v-else-if="activeData">
          <div class="ledger-result-heading">
            <span v-if="tab === 'detail' && detail" class="ledger-account"><span class="mono">{{ detail.account.code }}</span> {{ detail.account.name }}</span>
            <span v-else class="muted">{{ sourceText }}<template v-if="sourceText"> · </template>共 {{ currentRows.length }} 条<template v-if="isSummary">，可查看科目明细</template></span>
            <span v-if="tab === 'detail'" class="muted">{{ sourceText }} · 共 {{ currentRows.length }} 条</span>
          </div>
          <div v-if="tab === 'detail' && detail" class="ledger-balances">
            <div v-for="amount in detailAmounts" :key="amount.key">
              <span class="muted">{{ amount.label }}</span>
              <MoneyText v-if="baseCurrency" :value="detail[amount.key]" :currency="baseCurrency" />
              <span v-else>{{ detail[amount.key] ?? '-' }}（币种未提供）</span>
            </div>
          </div>
          <div v-if="tab === 'detail' && auxKey" class="ledger-aux">
            <span class="muted">当前辅助项：<span class="mono">{{ auxKey }}</span></span>
            <el-button link type="primary" @click="clearAux">查看该科目的全部辅助项</el-button>
          </div>
          <el-form v-if="tab === 'journal'" class="ledger-journal-filter" inline @submit.prevent>
            <el-form-item label="资金账户">
              <el-select v-model="fundAccountId" placeholder="全部资金账户" clearable filterable :disabled="exporting">
                <el-option v-for="fund in fundAccounts" :key="fund.id" :label="fund.name" :value="fund.id" />
              </el-select>
            </el-form-item>
          </el-form>
          <div class="table-scroll">
            <el-table :key="tab" :data="pageRows" border stripe size="small" empty-text="当前期间及筛选条件下暂无记录">
              <template v-if="isSummary">
                <el-table-column :prop="tab === 'general' ? 'code' : 'accountCode'" label="科目编码" min-width="120" show-overflow-tooltip />
                <el-table-column :prop="tab === 'general' ? 'name' : 'accountName'" label="科目名称" min-width="180" show-overflow-tooltip />
                <el-table-column v-if="tab === 'balance'" prop="auxKey" label="辅助项" min-width="160" show-overflow-tooltip />
                <el-table-column v-if="tab === 'balance'" prop="currency" label="原币币种" min-width="90" />
                <el-table-column v-for="group in amountGroups" :key="group.key" :label="group.label" align="center">
                  <el-table-column v-for="side in [{ key: 'Debit', label: '借方' }, { key: 'Credit', label: '贷方' }]" :key="side.key" :label="side.label" min-width="150" align="right">
                    <template #default="{ row }"><MoneyText v-if="baseCurrency" :value="row[group.key + side.key]" :currency="baseCurrency" /><span v-else>{{ row[group.key + side.key] ?? '-' }}</span></template>
                  </el-table-column>
                </el-table-column>
                <el-table-column label="操作" width="100" fixed="right" align="right">
                  <template #default="{ row }"><el-button link type="primary" size="small" @click="selectAccount(row)">查看明细</el-button></template>
                </el-table-column>
              </template>
              <template v-else>
                <el-table-column label="凭证编号" min-width="160" show-overflow-tooltip>
                  <template #default="{ row }"><el-button v-if="row.voucherId != null" link type="primary" size="small" @click="voucher(row)">{{ row.voucherNo ?? '#' + row.voucherId }}</el-button><span v-else>{{ row.voucherNo ?? '-' }}</span></template>
                </el-table-column>
                <el-table-column label="凭证日期" width="120"><template #default="{ row }">{{ formatDate(row.voucherDate) }}</template></el-table-column>
                <el-table-column v-if="tab === 'journal'" prop="accountName" label="科目名称" min-width="160" show-overflow-tooltip />
                <el-table-column prop="summary" label="摘要" min-width="220" show-overflow-tooltip />
                <el-table-column prop="auxKey" label="辅助项" min-width="160" show-overflow-tooltip />
                <el-table-column v-for="side in [{ key: 'debit', label: '借方' }, { key: 'credit', label: '贷方' }]" :key="side.key" :label="side.label" min-width="150" align="right">
                  <template #default="{ row }"><MoneyText v-if="baseCurrency" :value="row[side.key]" :currency="baseCurrency" /><span v-else>{{ row[side.key] ?? '-' }}</span></template>
                </el-table-column>
                <el-table-column v-if="tab === 'journal'" prop="cashflowItemId" label="现金流项目" min-width="120" />
                <el-table-column v-else label="业务来源" min-width="200" show-overflow-tooltip>
                  <template #default="{ row }"><router-link v-if="financeSourcePath(row)" :to="financeSourcePath(row)!">{{ row.sourceDocType }} #{{ row.sourceDocId }}</router-link><span v-else>{{ row.sourceDocType ?? '-' }}<template v-if="row.sourceDocId != null"> #{{ row.sourceDocId }}</template></span></template>
                </el-table-column>
              </template>
            </el-table>
          </div>
          <div class="ledger-pagination">
            <span class="muted">共 {{ currentRows.length }} 条 · 金额按本位币展示</span>
            <el-pagination v-model:current-page="currentPage" v-model:page-size="pageSize" :page-sizes="[20, 50, 100]" :total="currentRows.length" :pager-count="5" layout="sizes, prev, pager, next" background />
          </div>
        </template>
      </div>
    </section>
  </div>
</template>

<style scoped>
.ledger-page, .ledger-result { min-width: 0; }
.ledger-heading { align-items: flex-start; flex-wrap: wrap; }
.ledger-description { margin: 8px 0 0; line-height: 1.6; }
.ledger-actions, .ledger-context, .ledger-result-heading, .ledger-aux, .ledger-pagination { display: flex; flex-wrap: wrap; align-items: center; gap: 8px 16px; }
.ledger-actions { gap: 8px; }
.ledger-actions .el-button + .el-button { margin-left: 0; }
.ledger-filters { display: grid; grid-template-columns: minmax(160px, 1fr) minmax(160px, 1fr) minmax(240px, 2fr); gap: 0 16px; }
.ledger-filters .el-form-item { min-width: 0; margin-bottom: 12px; }
.ledger-filters .el-select { width: 100%; }
.ledger-context { padding: 12px 0; border-top: 1px solid var(--el-border-color-lighter); line-height: 1.6; overflow-wrap: anywhere; }
.ledger-page .el-alert { margin: 8px 0 12px; }
.ledger-tabs { min-width: 0; }
.ledger-result-heading { justify-content: space-between; margin-bottom: 12px; line-height: 1.6; }
.ledger-account { font-weight: 600; overflow-wrap: anywhere; }
.ledger-state { padding: 48px 12px; text-align: center; }
.ledger-balances { display: grid; grid-template-columns: repeat(4, minmax(0, 1fr)); gap: 12px; margin-bottom: 16px; padding: 12px; background: var(--el-fill-color-light); border-radius: 4px; }
.ledger-balances > div { display: flex; flex-direction: column; gap: 8px; overflow-wrap: anywhere; }
.ledger-aux { margin-bottom: 12px; overflow-wrap: anywhere; }
.ledger-journal-filter .el-form-item { margin: 0 0 12px; }
.ledger-journal-filter .el-select { width: 240px; max-width: 100%; }
.ledger-pagination { justify-content: space-between; margin-top: 16px; }
.ledger-pagination .el-pagination { flex-wrap: wrap; row-gap: 8px; }
.ledger-result a { color: var(--el-color-primary); text-decoration: none; }
.ledger-result a:hover { text-decoration: underline; }
.ledger-page :deep(button:focus-visible), .ledger-page a:focus-visible { outline: 2px solid var(--el-color-primary); outline-offset: 3px; }
@media (max-width: 1024px) {
  .ledger-filters { grid-template-columns: repeat(2, minmax(0, 1fr)); }
  .ledger-filters .el-form-item:last-child { grid-column: 1 / -1; }
  .ledger-balances { grid-template-columns: repeat(2, minmax(0, 1fr)); }
}
@media (max-width: 768px) {
  .ledger-filters { grid-template-columns: minmax(0, 1fr); }
  .ledger-context { gap: 8px 12px; }
  .ledger-actions { width: 100%; }
  .ledger-journal-filter .el-form-item { display: flex; margin-right: 0; }
  .ledger-journal-filter .el-select { width: 100%; }
  .ledger-pagination { gap: 12px; }
  .ledger-pagination :deep(.el-pagination__sizes) { margin-right: 8px; }
  .ledger-pagination :deep(.el-pager li) { min-width: 24px; margin: 0 2px; }
}
</style>
