<script setup lang="ts">
import { computed, onBeforeUnmount, onMounted, ref } from 'vue'
import { useCountryStore } from '@/stores/country'
import { http } from '@/api/http'
import MoneyText from '@/components/MoneyText.vue'
import QtyText from '@/components/QtyText.vue'
import StatusTag from '@/components/StatusTag.vue'
import { financeSourcePath } from '@/utils/finance-source'
import { formatDate } from '@/utils/format'
import { statusDef } from '@/utils/status'

type Row = Record<string, any>
const country = useCountryStore()
const books = ref<Row[]>([]), bookId = ref<number>(), periodId = ref<number>()
const data = ref<Row | null>(null), busy = ref(false)
const booksLoading = ref(false), booksError = ref(''), loadError = ref('')
const selectedBook = computed(() => books.value.find(b => b.id === bookId.value))
// A missing selection has no periods; malformed book responses are rejected by loadBooks.
const periods = computed<Row[]>(() => selectedBook.value?.periods ?? [])
const moneyFields = [
  { key: 'netSalesAmount', label: '净销售额' }, { key: 'cogsAmount', label: '出库成本' },
  { key: 'directExpense', label: '直接费用' }, { key: 'periodExpense', label: '期间费用' },
  { key: 'grossProfit', label: '基础毛利' }, { key: 'contributionProfit', label: '贡献利润' },
]
const sourceNames: Record<string, string> = {
  SAL_OUTBOUND: '销售出库', SALES_RETURN_SETTLEMENT: '销售退货结算',
  SALES_RETURN_SETTLEMENT_REVERSED: '退货结算撤销', SALES_RETURN_INSPECTION: '销售退货验货',
  CST_ADJUSTMENT: '成本调整', CST_EXPENSE: '费用登记',
}
const sourceLabel = (value: string | undefined) => value == null ? '来源类型未提供' : sourceNames[value] ?? value
const periodLabel = (period: Row) => period.name + ' · ' + statusDef(period.status, 'period').label
function errorText(error: unknown) {
  const reason = error instanceof Error ? error.message : typeof error === 'string' ? error : ''
  return reason.trim() ? reason : '读取失败，服务未提供错误说明。'
}
const isRow = (value: unknown): value is Row => value != null && typeof value === 'object' && !Array.isArray(value)
const isAmount = (value: unknown) => value == null || (typeof value === 'number' && Number.isFinite(value)) || (typeof value === 'string' && value.trim() !== '' && Number.isFinite(Number(value)))
function validateProfit(value: unknown): asserts value is Row {
  const validMoney = (row: Row) => moneyFields.every(field => isAmount(row[field.key]))
  const validCurrency = (value: unknown) => value == null || (typeof value === 'string' && /^[A-Z]{3}$/.test(value))
  const validSource = (source: unknown) => isRow(source) && validMoney(source) && isAmount(source.originalSalesAmount) && validCurrency(source.currency) &&
    (source.costVersions == null || (Array.isArray(source.costVersions) && source.costVersions.every(isRow)))
  const validProduct = (row: unknown) => isRow(row) && validMoney(row) && isAmount(row.netSalesQty) &&
    (row.sources == null || (Array.isArray(row.sources) && row.sources.every(validSource)))
  if (!isRow(value) || !Array.isArray(value.rows) || !validMoney(value) || !validCurrency(value.baseCurrency) ||
    (value.differences != null && (!Array.isArray(value.differences) || !value.differences.every((item: unknown) => typeof item === 'string'))) ||
    !value.rows.every(validProduct)) {
    throw new Error('利润数据格式异常，请重新加载；如仍失败，请联系管理员。')
  }
}

let sequence = 0, booksSequence = 0, disposed = false
function changeBook() {
  sequence++
  periodId.value = undefined
  data.value = null
  loadError.value = ''
  busy.value = false
}
async function loadBooks() {
  const request = ++booksSequence
  booksLoading.value = true
  booksError.value = ''
  try {
    const result = await http.get<unknown>('/fin/books', undefined, { silent: true })
    if (disposed || request !== booksSequence) return
    if (!Array.isArray(result) || !result.every(b => isRow(b) && b.id != null && Array.isArray(b.periods) && b.periods.every((p: unknown) => isRow(p) && p.id != null))) {
      throw new Error('账套数据格式异常，请重新加载；如仍失败，请联系管理员。')
    }
    books.value = result
  } catch (error) {
    if (!disposed && request === booksSequence) booksError.value = errorText(error)
  } finally {
    if (!disposed && request === booksSequence) booksLoading.value = false
  }
}
async function load() {
  const request = ++sequence
  data.value = null
  loadError.value = ''
  busy.value = false
  if (disposed || bookId.value == null || periodId.value == null) return
  busy.value = true
  try {
    const result = await http.get<unknown>('/cst/profit', { bookId: bookId.value, periodId: periodId.value }, { silent: true })
    if (disposed || request !== sequence) return
    validateProfit(result)
    data.value = result
  } catch (error) {
    if (!disposed && request === sequence) loadError.value = errorText(error)
  } finally {
    if (!disposed && request === sequence) busy.value = false
  }
}
onMounted(loadBooks)
onBeforeUnmount(() => { disposed = true; sequence++; booksSequence++ })
</script>

<template>
  <div class="page profit-page">
    <section class="page-card">
      <header class="page-title profit-title">
        <div><h2>单品利润</h2><p class="muted profit-subtitle">按账套与会计期间核对商品利润及业务来源</p></div>
        <span class="profit-country">{{ country.current?.name }}</span>
      </header>
      <el-form class="profit-filters" label-position="top" @submit.prevent="load">
        <el-form-item label="账套">
          <el-select v-model="bookId" placeholder="请选择账套" :disabled="booksLoading || !!booksError || !books.length" @change="changeBook">
            <el-option v-for="b in books" :key="b.id" :label="b.name + (b.baseCurrency ? ' · ' + b.baseCurrency : '')" :value="b.id" />
          </el-select>
        </el-form-item>
        <el-form-item label="会计期间">
          <el-select v-model="periodId" placeholder="请选择期间" :disabled="bookId == null || booksLoading || !!booksError || !periods.length" @change="load">
            <el-option v-for="p in periods" :key="p.id" :label="periodLabel(p)" :value="p.id" />
          </el-select>
        </el-form-item>
        <el-button type="primary" :loading="busy" :disabled="booksLoading || !!booksError || bookId == null || periodId == null" native-type="submit">刷新利润</el-button>
      </el-form>
      <p class="muted profit-formula">基础毛利 = 净销售额 − 出库成本；贡献利润再减去直接销售费用和期间费用。现金到账不算收入。</p>
    </section>

    <section class="page-card profit-results" :aria-busy="booksLoading || busy" aria-label="利润查询结果">
      <div v-if="booksLoading" class="profit-loading" role="status">正在读取账套…</div>
      <div v-else-if="booksError" class="profit-error" role="alert">
        <el-alert title="账套读取失败" type="error" :closable="false" show-icon><p>{{ booksError }}</p></el-alert>
        <el-button type="primary" plain @click="loadBooks">重新加载账套</el-button>
      </div>
      <el-empty v-else-if="!books.length" :image-size="64" description="暂无可用账套，请联系管理员确认账套与访问权限" />
      <el-empty v-else-if="bookId == null" :image-size="64" description="请选择账套和会计期间，查看单品利润" />
      <el-empty v-else-if="!periods.length" :image-size="64" description="所选账套暂无会计期间，请联系财务人员确认" />
      <el-empty v-else-if="periodId == null" :image-size="64" description="请选择期间，查看该期间的利润" />
      <div v-else-if="busy" v-loading="busy" class="profit-loading" role="status">正在读取利润数据…</div>
      <div v-else-if="loadError" class="profit-error" role="alert">
        <el-alert title="利润读取失败" type="error" :closable="false" show-icon><p>{{ loadError }}</p></el-alert>
        <el-button type="primary" plain @click="load">重新加载利润</el-button>
      </div>
      <template v-else-if="data">
        <div class="profit-context">
          <strong>{{ selectedBook?.name }}</strong>
          <span>{{ formatDate(data.from) }} 至 {{ formatDate(data.to) }}</span>
          <span>本位币 {{ data.baseCurrency ?? '币种未提供' }}</span>
          <span>时区 {{ data.timezone ?? '未提供' }}</span>
        </div>
        <el-alert class="profit-disclaimer" type="warning" :closable="false" show-icon :title="data.disclaimer || '按系统内已登记数据计算，未包含线下营销费用，不能称为全成本净利润。'" />
        <dl class="profit-summary" aria-label="利润合计">
          <div><dt>基础毛利合计</dt><dd><MoneyText v-if="data.baseCurrency" :value="data.grossProfit" :currency="data.baseCurrency" /><span v-else class="muted">币种未提供</span></dd></div>
          <div><dt>贡献利润合计</dt><dd><MoneyText v-if="data.baseCurrency" :value="data.contributionProfit" :currency="data.baseCurrency" /><span v-else class="muted">币种未提供</span></dd></div>
        </dl>
        <div class="profit-section-title"><h3>商品利润明细</h3><span class="muted">本次读取 {{ data.rows.length }} 条记录</span></div>
        <p class="muted profit-note">金额为“-”表示数据未提供或受字段权限限制，不代表零；展开商品可核对来源单据。</p>
        <div class="table-scroll" tabindex="0" role="region" aria-label="商品利润明细，可横向滚动">
          <el-table :data="data.rows" row-key="productId" border stripe size="small" class="profit-table">
            <el-table-column type="expand" width="48">
              <template #default="{ row }">
                <div class="profit-sources">
                  <h4>业务来源明细 · {{ row.productName }}</h4>
                  <p class="muted">金额为空表示未提供或不可见；来源页面仍按当前权限校验。</p>
                  <el-alert v-if="row.sources == null" type="info" :closable="false" title="来源明细未返回，暂无法核对。" />
                  <el-table v-else :data="row.sources" border stripe size="small" empty-text="暂无可见来源">
                    <el-table-column label="来源类型" min-width="155" show-overflow-tooltip><template #default="{ row: source }">{{ sourceLabel(source.sourceType) }}</template></el-table-column>
                    <el-table-column label="来源单号" min-width="220" show-overflow-tooltip>
                      <template #default="{ row: source }"><el-button v-if="financeSourcePath({ ...source, bookId })" link type="primary" @click="$router.push(financeSourcePath({ ...source, bookId })!)">{{ source.sourceNo || source.sourceId }}</el-button><span v-else>{{ source.sourceNo || source.sourceId }}</span></template>
                    </el-table-column>
                    <el-table-column prop="sourceLineId" label="来源行" width="100" />
                    <el-table-column label="业务日期" width="120"><template #default="{ row: source }">{{ formatDate(source.bizDate) }}</template></el-table-column>
                    <el-table-column label="原币成交额" min-width="160" align="right"><template #default="{ row: source }"><MoneyText v-if="source.currency" :value="source.originalSalesAmount" :currency="source.currency" /><span v-else class="muted">{{ source.originalSalesAmount == null ? '-' : '币种未提供' }}</span></template></el-table-column>
                    <el-table-column v-for="field in moneyFields.slice(0, 4)" :key="field.key" :label="field.label" min-width="150" align="right"><template #default="{ row: source }"><MoneyText v-if="data.baseCurrency" :value="source[field.key]" :currency="data.baseCurrency" /><span v-else class="muted">币种未提供</span></template></el-table-column>
                    <el-table-column label="成本依据" min-width="260">
                      <template #default="{ row: source }">
                        <div v-for="(version, index) in source.costVersions" :key="index" class="profit-cost-version">
                          <span>{{ version.cogsId ? '出库成本 #' + version.cogsId : version.inboundCostId ? '入库成本 #' + version.inboundCostId : '成本编号未提供' }}</span>
                          <span v-if="version.method">{{ version.method }}<span v-if="version.methodVersion != null"> · 版本 {{ version.methodVersion }}</span></span>
                          <span v-if="version.completionDate">补齐日期 {{ formatDate(version.completionDate) }}</span>
                        </div>
                        <div class="profit-source-flags"><el-tag v-if="source.estimated" type="warning" size="small">含暂估</el-tag><el-tag v-if="source.costMissing" type="danger" size="small">成本待补齐</el-tag><el-tag v-if="source.rateMissing" type="danger" size="small">汇率待补齐</el-tag><el-tag v-if="source.taxBasisMissing" type="warning" size="small">税口径待确认</el-tag></div>
                        <span v-if="!source.costVersions?.length && !source.estimated && !source.costMissing && !source.rateMissing && !source.taxBasisMissing" class="muted">未提供</span>
                      </template>
                    </el-table-column>
                  </el-table>
                </div>
              </template>
            </el-table-column>
            <el-table-column label="商品" min-width="220" show-overflow-tooltip><template #default="{ row }"><div class="profit-product-name">{{ row.productName }}</div><span class="mono muted">{{ row.productCode }}</span></template></el-table-column>
            <el-table-column label="净数量" min-width="110" align="right"><template #default="{ row }"><QtyText :value="row.netSalesQty" /></template></el-table-column>
            <el-table-column v-for="field in moneyFields" :key="field.key" :label="field.label" min-width="150" align="right"><template #default="{ row }"><MoneyText v-if="data.baseCurrency" :value="row[field.key]" :currency="data.baseCurrency" /><span v-else class="muted">币种未提供</span></template></el-table-column>
            <el-table-column label="完整度" width="100"><template #default="{ row }"><StatusTag :status="row.completeness" /></template></el-table-column>
            <template #empty><el-empty :image-size="48" description="所选期间暂无利润记录" /></template>
          </el-table>
        </div>
        <details class="profit-explanation">
          <summary>计算口径与差异说明</summary>
          <p>{{ data.reconcileHint }}</p>
          <ul v-if="data.differences?.length"><li v-for="(difference, index) in data.differences" :key="index">{{ difference }}</li></ul>
          <p class="muted">来源版本 {{ data.sourceVersion ?? '未提供' }}</p>
        </details>
      </template>
    </section>
  </div>
</template>

<style scoped>
.profit-page, .profit-results { min-width: 0; }
.profit-title { align-items: flex-start; }
.profit-subtitle { margin: 8px 0 0; line-height: 1.6; }
.profit-country { color: var(--el-text-color-regular); font-size: 13px; line-height: 1.6; overflow-wrap: anywhere; }
.profit-filters { display: flex; flex-wrap: wrap; align-items: flex-end; gap: 12px; }
.profit-filters :deep(.el-form-item) { flex: 0 1 280px; min-width: 0; margin: 0; }
.profit-filters :deep(.el-select) { width: 100%; }
.profit-formula { margin: 12px 0 0; line-height: 1.7; }
.profit-loading { min-height: 180px; display: grid; place-items: center; color: var(--el-text-color-regular); font-size: 14px; }
.profit-error { display: grid; justify-items: start; gap: 12px; }
.profit-error :deep(.el-alert) { width: 100%; }
.profit-error p { overflow-wrap: anywhere; }
.profit-context { display: flex; flex-wrap: wrap; gap: 8px 16px; color: var(--el-text-color-regular); font-size: 13px; line-height: 1.7; overflow-wrap: anywhere; }
.profit-disclaimer { margin: 12px 0; }
.profit-summary { display: grid; grid-template-columns: repeat(2, minmax(0, 1fr)); margin: 0 0 16px; padding: 16px 0; border-bottom: 1px solid var(--el-border-color-lighter); }
.profit-summary > div { min-width: 0; padding: 0 16px; }
.profit-summary > div:first-child { padding-left: 0; border-right: 1px solid var(--el-border-color-lighter); }
.profit-summary dt { font-size: 13px; color: var(--el-text-color-regular); }
.profit-summary dd { margin: 8px 0 0; font-size: 26px; font-weight: 600; font-variant-numeric: tabular-nums; overflow-wrap: anywhere; }
.profit-section-title { display: flex; flex-wrap: wrap; align-items: center; justify-content: space-between; gap: 8px; }
.profit-section-title h3 { margin: 0; font-size: 14px; font-weight: 600; }
.profit-note { margin: 8px 0 12px; line-height: 1.6; }
.profit-table { min-width: 1380px; }
.profit-product-name { color: var(--el-text-color-primary); overflow-wrap: anywhere; }
.profit-sources { padding: 16px; }
.profit-sources h4 { margin: 0; font-size: 14px; overflow-wrap: anywhere; }
.profit-sources > p { margin: 8px 0 12px; }
.profit-cost-version { display: flex; flex-wrap: wrap; gap: 4px 8px; line-height: 1.6; }
.profit-cost-version + .profit-cost-version { margin-top: 8px; }
.profit-source-flags { display: flex; flex-wrap: wrap; gap: 4px; }
.profit-explanation { margin-top: 16px; padding-top: 12px; border-top: 1px solid var(--el-border-color-lighter); color: var(--el-text-color-regular); font-size: 13px; line-height: 1.7; }
.profit-explanation summary { cursor: pointer; color: var(--el-color-primary); width: fit-content; }
.profit-explanation ul { padding-left: 20px; }
.profit-explanation p { margin: 8px 0; }
.table-scroll:focus-visible, .profit-explanation summary:focus-visible { outline: 2px solid var(--el-color-primary); outline-offset: 3px; }
@media (max-width: 768px) {
  .profit-filters { align-items: stretch; }
  .profit-filters :deep(.el-form-item) { flex: 1 1 100%; }
  .profit-filters > :deep(.el-button) { width: 100%; margin: 0; }
  .profit-summary { grid-template-columns: minmax(0, 1fr); gap: 16px; }
  .profit-summary > div { padding: 0; }
  .profit-summary > div:first-child { border-right: 0; }
  .profit-summary dd { font-size: 24px; }
  .profit-context { flex-direction: column; gap: 4px; }
  .profit-sources { padding: 12px; }
}
</style>
