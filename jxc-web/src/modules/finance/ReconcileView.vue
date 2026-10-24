<script setup lang="ts">
import { computed, onBeforeUnmount, onMounted, ref } from 'vue'
import { http } from '@/api/http'
import { useCountryStore } from '@/stores/country'
import { formatDate, todayIn } from '@/utils/format'
import { financeSourcePath } from '@/utils/finance-source'
import MoneyText from '@/components/MoneyText.vue'
import StatusTag from '@/components/StatusTag.vue'

type Row = Record<string, any>
type DetailTab = 'details' | 'precisionDetails' | 'unposted' | 'ungenerated'
const country = useCountryStore()
const rows = ref<Row[]>([])
const books = ref<Row[]>([])
const bookId = ref<number>()
const periodId = ref<number>()
const detail = ref<Row | null>(null)
const bookLoading = ref(false)
const bookError = ref('')
const loading = ref(false)
const error = ref('')
const queried = ref(false)
const activeTab = ref<DetailTab>('details')
const detailPage = ref(1)
const detailSize = ref(20)
const selectedBook = computed(() => books.value.find(b => b.id === bookId.value))
const periods = computed<Row[]>(() => selectedBook.value?.periods ?? [])
const selectedPeriod = computed(() => periods.value.find(p => p.id === periodId.value))
const showPrecision = computed(() => detail.value?.type === 'INVENTORY' && Object.prototype.hasOwnProperty.call(detail.value, 'sourceAccountingAmount'))
const names: Record<string, string> = { AR: '应收', AP: '应付', INVENTORY: '库存', CASH: '现金银行' }
const amountColumns = [
  { key: 'businessAmount', label: '业务子账', missing: '金额未完整' },
  { key: 'glAmount', label: '已记账总账', missing: '金额未完整' },
  { key: 'unpostedAmount', label: '已生成未记账', missing: '金额未完整' },
  { key: 'ungeneratedAmount', label: '尚未生成', missing: '待补来源或映射' },
  { key: 'diffAmount', label: '业务减总账差额', missing: '金额未完整' },
]
const detailTabs = computed(() => {
  if (!detail.value) return []
  const tabs = [{ name: 'details', label: '业务明细', count: detail.value.details.length }]
  if (showPrecision.value) tabs.push({ name: 'precisionDetails', label: '库存记账精度', count: detail.value.precisionDetails.length })
  tabs.push({ name: 'unposted', label: '已生成未记账', count: detail.value.unposted.length }, { name: 'ungenerated', label: '尚未生成凭证', count: detail.value.ungenerated.length })
  return tabs
})
// /fin/reconcile 返回完整明细数组，汇总金额仍直接使用服务端字段。
const detailRows = computed<Row[]>(() => detail.value ? detail.value[activeTab.value] : [])
const pagedDetails = computed(() => detailRows.value.slice((detailPage.value - 1) * detailSize.value, detailPage.value * detailSize.value))
let bookRequest = 0
let queryRequest = 0
let disposed = false

function displayAmount(value: unknown, missing = '金额未完整') {
  if (value === undefined) return '-'
  return value === null || value === '' ? missing : value
}
function sourcePath(row: Row) { return financeSourcePath({ ...row, bookId: bookId.value }) }
function selectDetail(row: Row) { detail.value = row; changeTab('details') }
function changeTab(name: string | number) { activeTab.value = name as DetailTab; detailPage.value = 1 }
function changeSize(size: number) { detailSize.value = size; detailPage.value = 1 }
function clearResults() { rows.value = []; detail.value = null; error.value = ''; queried.value = false; detailPage.value = 1 }
function failureMessage(failure: unknown, fallback: string) { return failure instanceof Error && failure.message.trim() ? failure.message : fallback }

async function load() {
  const request = ++queryRequest
  const book = bookId.value, period = periodId.value
  clearResults()
  loading.value = false
  if (disposed || !selectedBook.value || !selectedPeriod.value) return
  loading.value = true
  const current = () => !disposed && request === queryRequest && book === bookId.value && period === periodId.value
  try {
    const data = await http.get<Row[]>('/fin/reconcile', { type: 'ALL', bookId: book, periodId: period }, { silent: true })
    if (!current()) return
    if (!Array.isArray(data) || data.some(row => !row || !['details', 'unposted', 'ungenerated'].every(key => Array.isArray(row[key])) || (Object.prototype.hasOwnProperty.call(row, 'sourceAccountingAmount') && !Array.isArray(row.precisionDetails)))) {
      throw new Error('核对数据格式异常，请重新读取')
    }
    rows.value = data
    queried.value = true
  } catch (failure) {
    if (current()) error.value = failureMessage(failure, '核对读取失败，请重试')
  } finally {
    if (current()) loading.value = false
  }
}
async function changeBook() {
  const today = todayIn(country.timezone)
  periodId.value = periods.value.find(p => p.startDate <= today && p.endDate >= today)?.id
  await load()
}
async function loadBooks() {
  const request = ++bookRequest
  ++queryRequest
  clearResults()
  books.value = []; bookId.value = undefined; periodId.value = undefined
  loading.value = false; bookLoading.value = true; bookError.value = ''
  try {
    const data = await http.get<Row[]>('/fin/books', undefined, { silent: true })
    if (disposed || request !== bookRequest) return
    if (!Array.isArray(data) || data.some(book => !book || !Array.isArray(book.periods))) throw new Error('账套数据格式异常，请重新读取')
    books.value = data
    const active = data.filter(b => b.status === 'ACTIVE')
    bookId.value = active.length === 1 ? active[0]!.id : undefined
    bookLoading.value = false
    await changeBook()
  } catch (failure) {
    if (!disposed && request === bookRequest) bookError.value = failureMessage(failure, '账套读取失败，请重试')
  } finally {
    if (!disposed && request === bookRequest) bookLoading.value = false
  }
}
onMounted(loadBooks)
onBeforeUnmount(() => { disposed = true; ++bookRequest; ++queryRequest })
</script>

<template>
  <div class="page reconcile-page">
    <section class="page-card">
      <div class="page-title"><h2>子账与总账核对</h2><span class="muted">按会计期间核对</span></div>
      <p class="muted reconcile-intro">业务子账读取所选期间截止日的历史事实，总账只读取已记账余额；本页查询不会重建余额。</p>
      <el-form class="search-form reconcile-filters" :inline="true" label-position="top" @submit.prevent="load">
        <el-form-item label="账套">
          <el-select v-model="bookId" placeholder="请选择账套" filterable clearable :loading="bookLoading" :disabled="bookLoading || !!bookError" @change="changeBook">
            <el-option v-for="b in books" :key="b.id" :value="b.id" :label="b.name" />
          </el-select>
        </el-form-item>
        <el-form-item label="会计期间">
          <el-select v-model="periodId" placeholder="请选择会计期间" filterable clearable :disabled="!bookId || bookLoading" @change="load">
            <el-option v-for="p in periods" :key="p.id" :value="p.id" :label="p.name" />
          </el-select>
        </el-form-item>
        <el-form-item class="reconcile-query"><el-button type="primary" :loading="loading" :disabled="bookLoading || !selectedPeriod" native-type="submit">刷新核对</el-button></el-form-item>
      </el-form>
      <div v-if="selectedPeriod" class="reconcile-context muted">
        <span>{{ selectedBook?.name }}</span>
        <span>期间：{{ formatDate(selectedPeriod.startDate) }} 至 {{ formatDate(selectedPeriod.endDate) }}</span>
        <span>本位币：{{ selectedBook?.baseCurrency || '未提供' }}</span>
      </div>
      <div v-if="bookError" class="reconcile-error" role="alert">
        <el-alert :title="'账套读取失败：' + bookError" type="error" :closable="false" show-icon />
        <el-button @click="loadBooks">重新读取账套</el-button>
      </div>
      <p v-else-if="bookLoading" class="muted" role="status">正在读取账套与期间…</p>
      <div v-else-if="error" class="reconcile-error" role="alert">
        <el-alert :title="'核对读取失败：' + error" type="error" :closable="false" show-icon />
        <el-button @click="load">重新读取核对</el-button>
      </div>
      <p v-else-if="loading" class="muted" role="status">正在核对子账与总账…</p>
      <el-empty v-else-if="!books.length" description="暂无可用账套" :image-size="64" />
      <el-empty v-else-if="!bookId" description="请选择要核对的账套" :image-size="64" />
      <el-empty v-else-if="!selectedPeriod" :description="periods.length ? '请选择会计期间' : '当前账套尚无会计期间'" :image-size="64" />
      <el-empty v-else-if="queried && !rows.length" description="所选期间暂无核对项目" :image-size="64" />
      <template v-else-if="queried">
        <div class="reconcile-section-title"><h3>核对汇总</h3><span class="muted">金额按各行本位币展示，点击“查看明细”追溯来源</span></div>
        <div class="table-scroll">
          <el-table :data="rows" size="small" border stripe highlight-current-row :current-row-key="detail?.type" row-key="type" @row-click="selectDetail">
            <el-table-column label="项目" min-width="110" fixed><template #default="{ row }">{{ names[row.type] || row.type }}</template></el-table-column>
            <el-table-column prop="currency" label="本位币" width="90" />
            <el-table-column v-for="column in amountColumns" :key="column.key" :label="column.label" min-width="165" align="right">
              <template #default="{ row }">
                <MoneyText v-if="row[column.key] != null && row[column.key] !== '' && row.currency" :value="row[column.key]" :currency="row.currency" />
                <span v-else class="muted">{{ displayAmount(row[column.key], column.missing) }}{{ row[column.key] != null && !row.currency ? '（币种未提供）' : '' }}</span>
              </template>
            </el-table-column>
            <el-table-column label="操作" width="110" fixed="right"><template #default="{ row }"><el-button type="primary" link size="small" @click.stop="selectDetail(row)">查看明细</el-button></template></el-table-column>
          </el-table>
        </div>
        <p v-if="!detail" class="muted reconcile-hint">选择上方核对项目，可查看业务来源、未记账凭证及未生成凭证。</p>
      </template>
    </section>

    <section v-if="detail" class="page-card" aria-label="核对项目明细">
      <div class="page-title"><h2>{{ names[detail.type] || detail.type }} · 核对明细</h2><el-button size="small" @click="detail = null">收起明细</el-button></div>
      <p class="muted reconcile-intro">{{ selectedBook?.name }} · {{ selectedPeriod?.name }} · 本位币 {{ detail.currency || '未提供' }}</p>
      <el-alert v-if="detail.incomplete || detail.pendingRateCount" class="reconcile-notice" title="存在缺成本、汇率或待分摊的来源，业务金额尚不完整；差额暂不能作为最终结论。" type="warning" :closable="false" show-icon />
      <el-tabs :model-value="activeTab" @tab-change="changeTab"><el-tab-pane v-for="tab in detailTabs" :key="tab.name" :name="tab.name" :label="`${tab.label}（${tab.count}）`" /></el-tabs>
      <template v-if="activeTab === 'precisionDetails' && showPrecision">
        <p class="muted">来源记账金额按原业务事实的固定精度分配读取；业务减总账差额仍保留在汇总表中。以下金额保留来源小数精度。</p>
        <el-alert v-if="detail.precisionIncomplete" class="reconcile-notice" title="来源记账金额尚不完整，精度分配差额和待核差额暂不能确定。" type="warning" :closable="false" show-icon />
        <dl class="reconcile-precision">
          <div v-for="item in [{ key: 'sourceAccountingAmount', label: '来源记账金额' }, { key: 'roundingDifference', label: '记账精度分配差额' }, { key: 'accountingDiffAmount', label: '扣除精度差额后待核差额' }]" :key="item.key">
            <dt>{{ item.label }}</dt><dd class="mono">{{ detail.currency }} {{ displayAmount(detail[item.key]) }}</dd>
          </div>
        </dl>
      </template>
      <div class="table-scroll">
        <el-table :key="activeTab" :data="pagedDetails" size="small" border stripe empty-text="当前分类暂无明细">
          <template v-if="activeTab === 'unposted'">
            <el-table-column label="凭证" min-width="200"><template #default="{ row }"><router-link v-if="row.voucherId" class="reconcile-link mono" :to="{ path: '/finance/vouchers', query: { voucherId: row.voucherId, bookId } }">{{ row.voucherNo || row.voucherId }}</router-link><span v-else>-</span></template></el-table-column>
            <el-table-column label="状态" min-width="120"><template #default="{ row }"><StatusTag :status="row.status" domain="voucher" /></template></el-table-column>
          </template>
          <template v-else>
            <el-table-column prop="sourceType" label="来源类型" min-width="160" show-overflow-tooltip />
            <el-table-column label="来源单据" min-width="200" show-overflow-tooltip><template #default="{ row }"><router-link v-if="sourcePath(row)" class="reconcile-link mono" :to="sourcePath(row)!">{{ row.sourceNo || row.sourceId }}</router-link><span v-else class="mono">{{ row.sourceNo || row.sourceId || '-' }}</span></template></el-table-column>
            <el-table-column prop="sourceId" label="来源ID" min-width="100" />
            <el-table-column label="业务日期" min-width="120"><template #default="{ row }">{{ formatDate(row.bizDate) }}</template></el-table-column>
          </template>
          <template v-if="activeTab === 'details'">
            <el-table-column prop="currency" label="原币" width="90" />
            <el-table-column label="原币金额" min-width="170" align="right"><template #default="{ row }"><MoneyText v-if="row.currency && row.originalAmount != null" :value="row.originalAmount" :currency="row.currency" /><span v-else>{{ displayAmount(row.originalAmount) }}{{ row.originalAmount != null && !row.currency ? '（币种未提供）' : '' }}</span></template></el-table-column>
          </template>
          <el-table-column v-if="activeTab === 'precisionDetails'" label="原始本位币金额" min-width="180" align="right"><template #default="{ row }"><span class="mono">{{ detail.currency }} {{ displayAmount(row.originalAmount) }}</span></template></el-table-column>
          <el-table-column :label="activeTab === 'precisionDetails' ? '分配记账金额' : '本位币金额'" min-width="180" align="right">
            <template #default="{ row }">
              <span v-if="activeTab === 'precisionDetails'" class="mono">{{ detail.currency }} {{ displayAmount(row.amount) }}</span>
              <MoneyText v-else-if="row.amount != null && detail.currency" :value="row.amount" :currency="detail.currency" />
              <span v-else>{{ displayAmount(row.amount) }}{{ row.amount != null && !detail.currency ? '（币种未提供）' : '' }}</span>
            </template>
          </el-table-column>
          <template v-if="activeTab === 'ungenerated'">
            <el-table-column prop="eventType" label="事件" min-width="210" show-overflow-tooltip />
            <el-table-column label="状态" min-width="110"><template #default="{ row }"><StatusTag :status="row.status" /></template></el-table-column>
            <el-table-column prop="failReason" label="诊断" min-width="230" show-overflow-tooltip><template #default="{ row }">{{ row.failReason || '未提供诊断' }}</template></el-table-column>
            <el-table-column label="操作" width="110" fixed="right"><template #default><router-link class="reconcile-link" :to="{ path: '/finance/events', query: { bookId } }">前往事件</router-link></template></el-table-column>
          </template>
        </el-table>
      </div>
      <div class="reconcile-pagination">
        <span class="muted">共 {{ detailRows.length }} 条明细</span>
        <el-pagination v-model:current-page="detailPage" :page-size="detailSize" :page-sizes="[20, 50, 100]" :total="detailRows.length" :pager-count="5" layout="sizes, prev, pager, next" background @size-change="changeSize" />
      </div>
    </section>
  </div>
</template>

<style scoped>
.reconcile-page { min-width: 0; }
.reconcile-intro { margin: 0 0 16px; line-height: 1.6; }
.reconcile-filters { display: flex; flex-wrap: wrap; align-items: flex-end; gap: 0 12px; }
.reconcile-filters :deep(.el-form-item) { width: 220px; margin-right: 0; }
.reconcile-filters :deep(.el-select) { width: 100%; }
.reconcile-filters :deep(.reconcile-query) { width: auto; }
.reconcile-context { display: flex; flex-wrap: wrap; gap: 8px 16px; padding: 12px 0; border-top: 1px solid var(--el-border-color-lighter); }
.reconcile-error { display: flex; align-items: center; gap: 12px; margin-top: 12px; }
.reconcile-error .el-alert { flex: 1; }
.reconcile-section-title { display: flex; flex-wrap: wrap; align-items: center; gap: 8px 16px; margin: 12px 0; }
.reconcile-section-title h3 { margin: 0; font-size: 14px; font-weight: 600; }
.reconcile-hint { margin: 12px 0 0; }
.reconcile-notice { margin-bottom: 12px; }
.reconcile-precision { display: grid; grid-template-columns: repeat(3, minmax(0, 1fr)); margin: 12px 0; border: 1px solid var(--el-border-color-lighter); border-radius: 4px; }
.reconcile-precision > div { padding: 12px; min-width: 0; }
.reconcile-precision dt { font-size: 13px; color: var(--el-text-color-regular); }
.reconcile-precision dd { margin: 8px 0 0; overflow-wrap: anywhere; }
.reconcile-link { color: var(--el-color-primary); text-decoration: none; }
.reconcile-link:hover { text-decoration: underline; }
.reconcile-link:focus-visible { outline: 2px solid var(--el-color-primary); outline-offset: 3px; }
.reconcile-pagination { display: flex; flex-wrap: wrap; justify-content: space-between; align-items: center; gap: 12px; margin-top: 12px; }
.reconcile-pagination :deep(.el-pagination) { flex-wrap: wrap; gap: 8px; }
@media (max-width: 768px) {
  .reconcile-page .page-title { align-items: flex-start; flex-wrap: wrap; }
  .reconcile-filters :deep(.el-form-item) { width: 100%; }
  .reconcile-error { flex-direction: column; align-items: stretch; }
  .reconcile-precision { grid-template-columns: minmax(0, 1fr); }
  .reconcile-pagination { align-items: flex-start; flex-direction: column; }
  .reconcile-pagination :deep(.el-pagination) { max-width: 100%; }
}
</style>
