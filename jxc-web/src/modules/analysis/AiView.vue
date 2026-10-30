<script setup lang="ts">
import { feedbackMessage } from '@/api/error-feedback'
import { computed, onBeforeUnmount, onMounted, reactive, ref } from 'vue'
import { http, BizError } from '@/api/http'
import { useCountryStore } from '@/stores/country'
import StatusTag from '@/components/StatusTag.vue'
import DateTimeText from '@/components/DateTimeText.vue'

interface AnalysisPeriod { id: number; name: string; startDate?: string; endDate?: string }
interface AnalysisBook { id: number; name: string; status: string; baseCurrency: string; periods: AnalysisPeriod[] }
interface AnalysisResult { output: string; disclaimer?: string; completeness?: string; createdAt?: string; sources?: unknown[] }

const country = useCountryStore()
const form = reactive({ bookId: undefined as number | undefined, periodId: undefined as number | undefined, question: '' })
const books = ref<AnalysisBook[]>([])
const booksBusy = ref(false), booksError = ref('')
const busy = ref(false), error = ref(''), errorCode = ref('')
const result = ref<AnalysisResult | null>(null)
const activeBooks = computed(() => books.value.filter(book => book.status === 'ACTIVE'))
const selectedBook = computed(() => activeBooks.value.find(book => book.id === form.bookId))
const periods = computed(() => selectedBook.value?.periods ?? [])
const selectedPeriod = computed(() => periods.value.find(period => period.id === form.periodId))
const providerUnavailable = computed(() => errorCode.value === 'AI_PROVIDER_NOT_CONFIGURED')
const canAsk = computed(() => !!selectedPeriod.value && !busy.value && !booksBusy.value && !booksError.value)
const exampleQuestions = ['说明本期间毛利的影响因素', '哪些数据需要补齐']
let alive = true, analysisSequence = 0, booksSequence = 0


function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value)
}
function validId(value: unknown): value is number { return typeof value === 'number' && Number.isSafeInteger(value) && value > 0 }
function clearAnalysis() {
  analysisSequence++
  busy.value = false
  result.value = null
  error.value = ''
  errorCode.value = ''
}
function changeBook() { form.periodId = undefined; clearAnalysis() }
function resetForm() { form.bookId = undefined; form.periodId = undefined; form.question = ''; clearAnalysis() }
function useExample(question: string) { form.question = question; clearAnalysis() }

async function loadBooks() {
  const request = ++booksSequence, epoch = country.epoch
  clearAnalysis()
  form.bookId = undefined
  form.periodId = undefined
  books.value = []
  booksBusy.value = true
  booksError.value = ''
  const current = () => alive && request === booksSequence && epoch === country.epoch
  try {
    const response = await http.get<unknown>('/fin/books', undefined, { silent: true })
    if (!current()) return
    if (!Array.isArray(response) || response.some(book => !isRecord(book) || !validId(book.id) ||
      typeof book.name !== 'string' || !book.name.trim() || typeof book.status !== 'string' ||
      typeof book.baseCurrency !== 'string' || !book.baseCurrency.trim() || !Array.isArray(book.periods) ||
      book.periods.some(period => !isRecord(period) || !validId(period.id) || typeof period.name !== 'string' || !period.name.trim()))) {
      throw new Error('账套或会计期间数据格式异常，请重新加载')
    }
    books.value = response
  } catch (reason) {
    if (current()) booksError.value = feedbackMessage(reason, "请求失败，未提供错误详情，请重试")
  } finally {
    if (current()) booksBusy.value = false
  }
}

async function ask() {
  if (busy.value || booksBusy.value || booksError.value) return
  if (!selectedBook.value || !selectedPeriod.value) {
    error.value = '请选择可用账套和会计期间后再开始分析'
    errorCode.value = ''
    return
  }
  const request = ++analysisSequence, epoch = country.epoch
  const payload = { bookId: form.bookId, periodId: form.periodId, question: form.question.trim() }
  const current = () => alive && request === analysisSequence && epoch === country.epoch
  result.value = null
  error.value = ''
  errorCode.value = ''
  busy.value = true
  try {
    const response = await http.post<unknown>('/ai/analysis', payload, { silent: true })
    if (!current()) return
    if (!isRecord(response) || typeof response.output !== 'string' || !response.output.trim()) {
      throw new Error('分析响应缺少有效正文，请重试')
    }
    for (const field of ['disclaimer', 'completeness', 'createdAt']) {
      if (response[field] != null && typeof response[field] !== 'string') throw new Error('分析结果附带信息格式异常，请重试')
    }
    if (response.sources != null && !Array.isArray(response.sources)) throw new Error('分析来源格式异常，请重试')
    result.value = response as unknown as AnalysisResult
  } catch (reason) {
    if (current()) {
      error.value = feedbackMessage(reason, "请求失败，未提供错误详情，请重试")
      errorCode.value = reason instanceof BizError ? reason.code : ''
    }
  } finally {
    if (current()) busy.value = false
  }
}

function sourceLabel(source: unknown) {
  if (!isRecord(source)) return '来源标识未提供'
  for (const key of ['sourceNo', 'productCode']) {
    if (typeof source[key] === 'string' && source[key].trim()) return source[key]
  }
  if (validId(source.sourceId)) return `来源编号 #${source.sourceId}`
  if (validId(source.productId)) return `商品编号 #${source.productId}`
  return '来源标识未提供'
}
onMounted(loadBooks)
onBeforeUnmount(() => { alive = false; analysisSequence++; booksSequence++ })
</script>

<template>
  <div class="page ai-analysis-page">
    <section class="page-card" aria-labelledby="ai-page-title">
      <header class="page-title ai-heading">
        <h2 id="ai-page-title">AI 盈亏解释</h2>
        <div class="ai-context"><span>{{ country.current?.name || '当前国家未提供' }}</span><el-tag type="info" size="small">只读分析</el-tag></div>
      </header>
      <p class="muted ai-intro">解释当前国家、当前权限内已登记的数据，供你核对盈亏原因。</p>

      <div v-if="booksError" class="ai-notice" role="alert">
        <div  class="request-state" role="status"><p class="muted">操作未完成，请查看全局提示。</p></div>
        <el-button size="small" @click="loadBooks">重新加载</el-button>
      </div>
      <p v-else-if="booksBusy" class="muted" role="status">正在加载账套和会计期间…</p>
      <el-alert v-else-if="!activeBooks.length" class="ai-notice" title="当前没有可用账套" description="请核对账套是否已启用，以及当前账号是否有查看权限。" type="info" :closable="false" show-icon />

      <el-form label-position="top" class="ai-form" :disabled="busy || booksBusy || !!booksError" @submit.prevent="ask">
        <div class="ai-fields">
          <el-form-item label="账套" for="ai-book">
            <el-select id="ai-book" v-model="form.bookId" placeholder="请选择账套" clearable :loading="booksBusy" @change="changeBook">
              <el-option v-for="book in activeBooks" :key="book.id" :value="book.id" :label="`${book.name} · ${book.baseCurrency}`" />
            </el-select>
          </el-form-item>
          <el-form-item label="会计期间" for="ai-period">
            <el-select id="ai-period" v-model="form.periodId" placeholder="请选择期间" clearable :disabled="!selectedBook" @change="clearAnalysis">
              <el-option v-for="period in periods" :key="period.id" :value="period.id" :label="period.name" />
            </el-select>
            <p v-if="selectedBook && !periods.length" class="muted ai-field-note">此账套暂无会计期间，请核对期间配置。</p>
          </el-form-item>
        </div>
        <el-form-item label="分析问题（可选）" for="ai-question">
          <el-input id="ai-question" v-model="form.question" type="textarea" :rows="3" resize="vertical" placeholder="例如：说明本期间毛利的影响因素" @input="clearAnalysis" />
        </el-form-item>
        <div class="ai-examples">
          <span class="muted">试着问：</span>
          <el-button v-for="question in exampleQuestions" :key="question" link type="primary" @click="useExample(question)">{{ question }}</el-button>
        </div>
        <div class="ai-actions">
          <el-button type="primary" native-type="submit" :loading="busy" :disabled="!canAsk">{{ busy ? '正在分析' : '开始分析' }}</el-button>
          <el-button :disabled="busy" @click="resetForm">重置</el-button>
          <span class="muted">仅作解释，不修改价格、库存或单据。</span>
        </div>
      </el-form>

      <section class="ai-results" aria-labelledby="ai-result-title" :aria-busy="busy" aria-live="polite">
        <div class="ai-result-heading">
          <h3 id="ai-result-title">分析结果</h3>
          <span v-if="selectedPeriod" class="muted">{{ selectedBook?.name }} · {{ selectedPeriod.name }} · {{ selectedBook?.baseCurrency }}</span>
        </div>
        <div v-if="busy" class="ai-loading" role="status"><el-skeleton :rows="3" /><p class="muted">正在读取数据并生成解释，请稍候…</p></div>
        <div v-else-if="error" class="ai-notice" role="alert">
          <div  class="request-state" role="status"><p class="muted">操作未完成，请查看全局提示。</p></div>
          <p v-if="providerUnavailable" class="muted">当前未生成分析结果。服务配置完成后，可保留这些条件重新尝试。</p>
          <el-button v-else size="small" :disabled="!canAsk" @click="ask">重新分析</el-button>
        </div>
        <template v-else-if="result">
          <div class="ai-output">{{ result.output }}</div>
          <el-alert v-if="result.disclaimer" class="ai-disclaimer" :title="result.disclaimer" type="warning" :closable="false" show-icon />
          <p v-else class="muted">本次结果未提供免责声明，请结合原始业务数据核对。</p>
          <dl class="ai-metadata">
            <div><dt>数据完整度</dt><dd><StatusTag v-if="result.completeness" :status="result.completeness" /><span v-else>未提供</span></dd></div>
            <div><dt>生成时间</dt><dd><DateTimeText v-if="result.createdAt" :value="result.createdAt" /><span v-else>未提供</span></dd></div>
          </dl>
          <div class="ai-sources"><h4>分析来源</h4><ul v-if="result.sources?.length"><li v-for="(source, index) in result.sources" :key="index">{{ sourceLabel(source) }}</li></ul><p v-else class="muted">本次结果未提供可核对的来源标识。</p></div>
        </template>
        <el-empty v-else :image-size="48" description="选择账套和会计期间，开始查看盈亏解释" />
      </section>
    </section>
  </div>
</template>

<style scoped>
.ai-heading { flex-wrap: wrap; }
.ai-context { display: flex; flex-wrap: wrap; align-items: center; gap: 8px; font-size: 13px; color: var(--el-text-color-regular); }
.ai-intro { margin: 0 0 16px; line-height: 1.6; }
.ai-fields { display: grid; grid-template-columns: repeat(2, minmax(0, 1fr)); gap: 16px; }
.ai-form :deep(.el-form-item) { margin-bottom: 16px; min-width: 0; }
.ai-form :deep(.el-select) { width: 100%; }
.ai-field-note { margin: 8px 0 0; }
.ai-examples, .ai-actions { display: flex; flex-wrap: wrap; align-items: center; gap: 8px 12px; }
.ai-examples { margin-bottom: 16px; }
.ai-examples :deep(.el-button), .ai-actions :deep(.el-button) { margin-left: 0; }
.ai-examples :deep(.el-button) { height: auto; white-space: normal; text-align: left; line-height: 1.6; }
.ai-results { margin-top: 16px; padding-top: 16px; border-top: 1px solid var(--el-border-color-lighter); min-width: 0; }
.ai-result-heading { display: flex; flex-wrap: wrap; align-items: baseline; justify-content: space-between; gap: 8px 16px; margin-bottom: 16px; }
.ai-result-heading h3 { margin: 0; font-size: 14px; font-weight: 600; }
.ai-result-heading span, .ai-context span { overflow-wrap: anywhere; }
.ai-output { white-space: pre-wrap; overflow-wrap: anywhere; font-size: 14px; line-height: 1.8; }
.ai-notice { margin-bottom: 16px; }
.ai-notice :deep(.el-alert) { align-items: flex-start; }
.ai-notice :deep(.el-alert__content) { min-width: 0; overflow-wrap: anywhere; }
.ai-notice > .el-button { margin-top: 8px; }
.ai-disclaimer { margin-top: 16px; }
.ai-metadata { display: flex; flex-wrap: wrap; gap: 12px 24px; font-size: 13px; }
.ai-metadata > div { display: flex; flex-wrap: wrap; gap: 8px; }
.ai-metadata dt { color: var(--el-text-color-secondary); }
.ai-metadata dd { margin: 0; overflow-wrap: anywhere; }
.ai-sources h4 { margin: 16px 0 8px; font-size: 13px; font-weight: 600; }
.ai-sources ul { margin: 0; padding-left: 20px; font-size: 13px; line-height: 1.8; overflow-wrap: anywhere; }
.ai-sources p, .ai-loading p { margin-bottom: 0; }
.ai-analysis-page :deep(button:focus-visible) { outline: 2px solid var(--el-color-primary); outline-offset: 3px; }
@media (max-width: 768px) {
  .ai-fields { grid-template-columns: minmax(0, 1fr); gap: 0; }
  .ai-actions > .muted { flex-basis: 100%; }
}
</style>
