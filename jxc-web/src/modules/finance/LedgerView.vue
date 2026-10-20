<script setup lang="ts">
import { computed, onMounted, ref } from 'vue'
import { http, createCommandIntent } from '@/api/http'
import { ElMessage } from 'element-plus'
import { useUserStore } from '@/stores/user'
import { allRecords } from '@/api/pagination'
import { financeSourcePath } from '@/utils/finance-source'
import { useRouter, useRoute } from 'vue-router'
import { useCountryStore } from '@/stores/country'
const country = useCountryStore(), user = useUserStore(), exportIntent = createCommandIntent()
const router = useRouter(), route = useRoute()
const books = ref<Record<string, any>[]>([]), accounts = ref<Record<string, any>[]>([]), periods = ref<Record<string, any>[]>([])
const bookId = ref<number>(), periodId = ref<number>(), accountId = ref<number>(), fundAccountId = ref<number>(), fundAccounts = ref<Record<string, any>[]>([]), auxKey = ref(''), tab = ref('general')
const detail = ref<Record<string, any> | null>(null), general = ref<Record<string, any> | null>(null), balance = ref<Record<string, any> | null>(null), allJournal = ref<Record<string, any>[]>([])
const journal = computed(() => allJournal.value.filter(line => (!accountId.value || line.accountId === accountId.value) && (!fundAccountId.value || line.aux?.fundAccountId === fundAccountId.value)))
const balanceRows = computed(() => (balance.value?.rows ?? []).filter((row: Record<string, any>) => !accountId.value || row.accountId === accountId.value))
let bookSequence = 0, requestSequence = 0, detailSequence = 0
const generalRows = computed(() => (general.value?.rows ?? []).filter((row: Record<string, any>) => !accountId.value || row.accountId === accountId.value))
const scope = () => `${bookId.value}:${periodId.value}`
async function selectAccount(row: Record<string, any>) { accountId.value = row.accountId; auxKey.value = row.auxKey || ''; tab.value = 'detail'; await loadDetail() }
async function changeAccount() { auxKey.value = ''; await loadDetail() }
async function loadDetail() {
  const sequence = ++detailSequence, selectedScope = scope(), selectedAccount = accountId.value, selectedAux = auxKey.value
  detail.value = null
  if (!selectedAccount || !bookId.value || !periodId.value) return
  const result = await http.get<Record<string, any>>('/fin/ledgers/detail', { bookId: bookId.value, accountId: selectedAccount, periodId: periodId.value, auxKey: selectedAux || undefined })
  if (sequence === detailSequence && selectedScope === scope() && selectedAccount === accountId.value && selectedAux === auxKey.value) detail.value = result
}
async function load() {
  const sequence = ++requestSequence, selectedScope = scope(), selectedFund = fundAccountId.value
  general.value = balance.value = detail.value = null; allJournal.value = []; detailSequence++
  if (!bookId.value || !periodId.value) return
  const query = { bookId: bookId.value, periodId: periodId.value }
  const [nextGeneral, nextBalance, nextJournal] = await Promise.all([http.get<Record<string, any>>('/fin/ledgers/general', query), http.get<Record<string, any>>('/fin/ledgers/balance', query), http.get<{ lines: Record<string, any>[] }>('/fin/ledgers/journal', query)])
  if (sequence !== requestSequence || selectedScope !== scope() || selectedFund !== fundAccountId.value) return
  general.value = nextGeneral; balance.value = nextBalance
  fundAccounts.value = Array.from(new Set(nextJournal.lines.map(l => l.aux?.fundAccountId).filter(Boolean))).map(id => ({ id, name: '资金账户 ' + id }))
  allJournal.value = nextJournal.lines
  await loadDetail()
}
async function changePeriod() { fundAccountId.value = undefined; fundAccounts.value = []; auxKey.value = ''; await load() }
async function changeBook() {
  const sequence = ++bookSequence, selectedBook = bookId.value
  requestSequence++; detailSequence++; periodId.value = accountId.value = fundAccountId.value = undefined; auxKey.value = ''
  detail.value = general.value = balance.value = null; allJournal.value = []; fundAccounts.value = []; accounts.value = []
  periods.value = books.value.find(b => b.id === selectedBook)?.periods || []
  if (!selectedBook) return
  const result = await allRecords<Record<string, any>>('/fin/accounts', { bookId: selectedBook })
  if (sequence !== bookSequence || selectedBook !== bookId.value) return
  accounts.value = result
  if (periods.value.length === 1) { periodId.value = periods.value[0]!.id; await load() }
}
async function exportLedger() { if (!bookId.value || !periodId.value || tab.value === 'detail' && !accountId.value) return; await http.postIdem('/fin/ledgers/' + tab.value + '/export', { bookId: bookId.value, periodId: periodId.value, accountId: accountId.value, auxKey: tab.value === 'detail' ? auxKey.value || undefined : undefined, fundAccountId: tab.value === 'journal' ? fundAccountId.value : undefined }, exportIntent); exportIntent.reset(); ElMessage.success('导出任务已创建'); await router.push('/jobs') }
function voucher(row: Record<string, any>) { router.push({ path: '/finance/vouchers', query: { voucherId: row.voucherId, bookId: bookId.value } }) }
onMounted(async () => { books.value = await http.get('/fin/books'); bookId.value = route.query.bookId ? Number(route.query.bookId) : undefined; if (bookId.value) { await changeBook(); if (route.query.periodId) periodId.value = Number(route.query.periodId); if (route.query.accountId) { accountId.value = Number(route.query.accountId); tab.value = route.query.tab === 'balance' ? 'balance' : 'detail' } await load() } })
</script>
<template>
  <el-card><template #header>账簿 · {{ books.find(b => b.id === bookId)?.baseCurrency || country.currency }} · {{ country.timezone }}</template><el-form inline><el-form-item label="账套"><el-select v-model="bookId" @change="changeBook"><el-option v-for="b in books" :key="b.id" :value="b.id" :label="b.name" /></el-select></el-form-item><el-form-item label="期间"><el-select v-model="periodId" placeholder="请选择期间" @change="changePeriod"><el-option v-for="p in periods" :key="p.id" :value="p.id" :label="p.name" /></el-select></el-form-item><el-form-item label="科目"><el-select v-model="accountId" filterable @change="changeAccount"><el-option v-for="a in accounts" :key="a.id" :label="a.code + ' ' + a.name" :value="a.id" /></el-select></el-form-item><el-button v-if="user.hasPerm('fin:ledger:export')" :disabled="!bookId || !periodId || tab === 'detail' && !accountId" @click="exportLedger">导出当前账簿</el-button></el-form>
    <el-tabs v-model="tab"><el-tab-pane label="总账" name="general"><el-table v-if="general" :data="generalRows" size="small" @row-click="selectAccount"><el-table-column prop="code" label="科目" width="90" /><el-table-column prop="name" label="名称" /><el-table-column prop="openingDebit" label="期初借" /><el-table-column prop="openingCredit" label="期初贷" /><el-table-column prop="periodDebit" label="本期借" /><el-table-column prop="periodCredit" label="本期贷" /><el-table-column prop="closingDebit" label="期末借" /><el-table-column prop="closingCredit" label="期末贷" /></el-table></el-tab-pane>
      <el-tab-pane label="科目余额（辅助项）" name="balance"><el-table v-if="balance" :data="balanceRows" size="small" @row-click="selectAccount"><el-table-column prop="accountCode" label="科目" /><el-table-column prop="accountName" label="名称" /><el-table-column prop="auxKey" label="辅助项" /><el-table-column prop="currency" label="币种" /><el-table-column prop="openingDebit" label="期初借" /><el-table-column prop="openingCredit" label="期初贷" /><el-table-column prop="periodDebit" label="本期借" /><el-table-column prop="periodCredit" label="本期贷" /><el-table-column prop="closingDebit" label="期末借" /><el-table-column prop="closingCredit" label="期末贷" /></el-table></el-tab-pane>
      <el-tab-pane label="明细账" name="detail"><template v-if="detail"><p>{{ detail.account.code }} {{ detail.account.name }} · 期初借 {{ detail.openingDebit }} 贷 {{ detail.openingCredit }} · 期末借 {{ detail.closingDebit }} 贷 {{ detail.closingCredit }}</p><el-button v-if="auxKey" link @click="auxKey = ''; loadDetail()">查看该科目的全部辅助项</el-button><el-table :data="detail.lines" size="small"><el-table-column label="凭证"><template #default="{ row }"><el-button link type="primary" @click="voucher(row)">{{ row.voucherNo }}</el-button></template></el-table-column><el-table-column prop="voucherDate" label="日期" /><el-table-column prop="summary" label="摘要" /><el-table-column prop="auxKey" label="辅助项" /><el-table-column prop="debit" label="借方" /><el-table-column prop="credit" label="贷方" /><el-table-column label="业务来源"><template #default="{ row }"><router-link v-if="financeSourcePath(row)" :to="financeSourcePath(row)!">{{ row.sourceDocType }} #{{ row.sourceDocId }}</router-link><span v-else>{{ row.sourceDocType }} {{ row.sourceDocId }}</span></template></el-table-column></el-table></template><el-empty v-else description="选择期间与科目查看明细账" /></el-tab-pane>
      <el-tab-pane label="现金银行日记账" name="journal"><el-form inline><el-form-item label="资金账户"><el-select v-model="fundAccountId" clearable @change="load"><el-option v-for="f in fundAccounts" :key="f.id" :label="f.name" :value="f.id" /></el-select></el-form-item></el-form><el-table :data="journal" size="small"><el-table-column label="凭证"><template #default="{ row }"><el-button link type="primary" @click="voucher(row)">{{ row.voucherNo }}</el-button></template></el-table-column><el-table-column prop="voucherDate" label="日期" /><el-table-column prop="accountName" label="科目" /><el-table-column prop="summary" label="摘要" /><el-table-column prop="auxKey" label="辅助项" /><el-table-column prop="debit" label="借方" /><el-table-column prop="credit" label="贷方" /><el-table-column prop="cashflowItemId" label="现金流项目" /></el-table></el-tab-pane></el-tabs>
  </el-card>
</template>
