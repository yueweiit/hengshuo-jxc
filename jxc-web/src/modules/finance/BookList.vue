<script setup lang="ts">
import { computed, onBeforeUnmount, onMounted, reactive, ref } from 'vue'
import { ElMessage, ElMessageBox } from 'element-plus'
import { http, createCommandIntent } from '@/api/http'
import StatusTag from '@/components/StatusTag.vue'
import { useUserStore } from '@/stores/user'
import { useCountryStore } from '@/stores/country'
import { formatDate, todayIn } from '@/utils/format'

interface Period {
  id: number
  fiscalYear: number
  name: string
  startDate: string | null
  endDate: string | null
  status: string
}
interface Book {
  id: number
  entityId: number
  name: string
  baseCurrency: string
  status: string
  version: number
  periods: Period[]
}

const user = useUserStore()
const country = useCountryStore()
const mockMode = import.meta.env.MODE === 'demo' && import.meta.env.VITE_USE_MOCK === 'true'
const canConfigure = computed(() => !mockMode && user.hasPerm('fin:book:config'))
const books = ref<Book[]>([])
const loading = ref(false), loaded = ref(false), listError = ref('')
const busy = ref(false), actionBook = ref<number>(), action = ref(''), actionError = ref('')
const periodForms = reactive<Record<number, { fiscalYear: number | undefined; firstMonth: number | undefined }>>({})
const tables = reactive<Record<number, { year: number | undefined; page: number; size: number }>>({})
const intent = createCommandIntent(), editIntent = createCommandIntent(), activateIntent = createCommandIntent()
const dialog = ref(false), editing = ref<number>(), saveError = ref('')
const form = reactive({ name: '', version: 0 })
let readVersion = 0, disposed = false
const context = () => `${country.currentId}:${country.epoch}:${user.token}`
const current = (scope: string) => !disposed && scope === context()
const pageScope = context()
const errorText = (error: unknown, fallback: string) => error instanceof Error && error.message.trim() ? error.message : fallback

async function load() {
  const request = ++readVersion, scope = context()
  loading.value = true; listError.value = ''
  try {
    const result = await http.get<Book[]>('/fin/books', undefined, { silent: true })
    if (request !== readVersion || !current(scope)) return
    if (!Array.isArray(result) || result.some(b => !b || !Number.isInteger(b.id) || !Array.isArray(b.periods))) {
      throw new Error('账套或会计期间数据格式异常，请重新加载')
    }
    for (const b of result) {
      periodForms[b.id] ??= { fiscalYear: Number(todayIn(country.timezone).slice(0, 4)), firstMonth: 1 }
      tables[b.id] ??= { year: undefined, page: 1, size: 20 }
      const table = tables[b.id]!
      if (table.year !== undefined && !b.periods.some(p => p.fiscalYear === table.year)) table.year = undefined
      const count = filteredPeriods(b).length
      table.page = Math.min(table.page, Math.max(1, Math.ceil(count / table.size)))
    }
    books.value = result; loaded.value = true
  } catch (error) {
    if (request !== readVersion || !current(scope)) return
    books.value = []; loaded.value = false
    listError.value = errorText(error, '账套读取失败，请检查连接后重新加载')
  } finally {
    if (request === readVersion && current(scope)) loading.value = false
  }
}

function filteredPeriods(book: Book) {
  const year = tables[book.id]!.year
  return book.periods.filter(p => year === undefined || p.fiscalYear === year)
}
function pagedPeriods(book: Book) {
  const { page, size } = tables[book.id]!
  return filteredPeriods(book).slice((page - 1) * size, page * size)
}
function yearsFor(book: Book) { return [...new Set(book.periods.map(p => p.fiscalYear))].sort((a, b) => b - a) }
function resetPage(bookId: number) { tables[bookId]!.page = 1 }
function writable() { return current(pageScope) && canConfigure.value && !loading.value && !listError.value && !busy.value }
function startAction(bookId: number, name: string) {
  busy.value = true; actionBook.value = bookId; action.value = name; actionError.value = ''
}

function edit(row: Book) {
  if (!writable()) return
  editing.value = row.id; form.name = row.name; form.version = row.version
  saveError.value = ''; editIntent.reset(); dialog.value = true
}
async function save() {
  if (!writable() || !editing.value) return
  const name = form.name.trim()
  if (!name || name.length > 100) { saveError.value = '请填写1至100个字符的账套名称'; return }
  const bookId = editing.value, scope = context()
  startAction(bookId, 'rename'); saveError.value = ''
  try {
    await http.putIdem('/fin/books/' + bookId, { name, version: form.version }, editIntent, { silent: true })
    if (!current(scope)) return
    dialog.value = false; ElMessage.success('账套名称已保存'); await load()
  } catch (error) {
    if (current(scope)) saveError.value = errorText(error, '账套名称保存失败，请重试')
  } finally { if (current(scope)) busy.value = false }
}
async function activate(row: Book) {
  if (!writable() || row.status !== 'DRAFT') return
  const bookId = row.id, version = row.version, scope = context()
  startAction(bookId, 'activate')
  try {
    await ElMessageBox.confirm('启用后可为该账套录入业务单据；本操作不录入期初、不生成期间或凭证，也不代表完成财务启用。确认已核对经营主体和本位币？', '启用账套', { type: 'warning', confirmButtonText: '确认启用', cancelButtonText: '取消' })
    if (!current(scope) || !canConfigure.value) return
    await http.postIdem('/fin/books/' + bookId + '/activate', { version }, activateIntent, { silent: true })
    if (!current(scope)) return
    ElMessage.success('账套已启用，期间和财务配置仍须独立完成'); await load()
  } catch (error) {
    if (current(scope) && error !== 'cancel' && error !== 'close') actionError.value = errorText(error, '账套启用失败，请重试')
  } finally { if (current(scope)) busy.value = false }
}
async function gen(bookId: number) {
  if (!writable() || books.value.find(b => b.id === bookId)?.status !== 'ACTIVE') return
  const draft = periodForms[bookId]!
  if (!Number.isInteger(draft.fiscalYear) || draft.fiscalYear! < 1900 || draft.fiscalYear! > 9999 || !Number.isInteger(draft.firstMonth) || draft.firstMonth! < 1 || draft.firstMonth! > 12) {
    actionBook.value = bookId; actionError.value = '会计年度须为1900至9999的整数，首个月份须为1至12的整数'; return
  }
  const scope = context(), body = { fiscalYear: draft.fiscalYear, firstMonth: draft.firstMonth }
  startAction(bookId, 'generate')
  try {
    const res = await http.postIdem<{ created: number }>('/fin/periods?bookId=' + bookId, body, intent, { silent: true })
    if (!current(scope)) return
    if (!res || !Number.isInteger(res.created) || res.created < 0 || res.created > 13 - body.firstMonth!) throw new Error('服务器返回的期间数量异常，请刷新账套核对结果')
    ElMessage.success(res.created === 0 ? '所选范围内的期间已齐全，无需新增' : `已补齐 ${res.created} 个期间`)
    await load()
  } catch (error) {
    if (current(scope)) actionError.value = errorText(error, '会计期间补齐失败，请重试')
  } finally { if (current(scope)) busy.value = false }
}
onMounted(load)
onBeforeUnmount(() => { disposed = true; readVersion++ })
</script>

<template>
  <div class="page books-page" :aria-busy="loading">
    <header class="page-title books-title">
      <div>
        <h2>账套与会计期间</h2>
        <p class="muted">核对账套归属与本位币，维护业务使用的会计期间。</p>
      </div>
      <el-button :loading="loading" :disabled="busy" @click="load">刷新账套</el-button>
    </header>
    <el-alert v-if="mockMode" title="演示模式仅供查看，不能修改或启用账套、补齐期间。" type="info" :closable="false" class="page-notice" />
    <section v-if="listError" class="page-card" role="alert">
      <el-alert title="账套读取失败" :description="listError" type="error" :closable="false" show-icon />
      <el-button class="retry-button" :disabled="busy" :loading="loading" @click="load">重新加载</el-button>
    </section>
    <div v-else-if="loading && !loaded" class="page-card"><el-skeleton :rows="6" animated aria-label="正在读取账套与会计期间" /></div>
    <div v-else-if="loaded && !books.length" class="page-card">
      <el-empty description="当前没有可查看的账套" :image-size="48"><p class="muted">请核对当前国家的账套配置与可见范围。</p></el-empty>
    </div>
    <template v-else>
      <p v-if="loaded" class="muted book-count">当前可见 {{ books.length }} 个账套</p>
      <section v-for="b in books" :key="b.id" class="page-card book-section" :aria-labelledby="`book-${b.id}`">
        <header class="book-header">
          <div class="book-heading"><h3 :id="`book-${b.id}`">{{ b.name || '名称缺失' }}</h3><StatusTag :status="b.status" /></div>
          <div v-if="canConfigure" class="book-actions">
            <el-button link type="primary" :disabled="busy || loading" @click="edit(b)">修改名称</el-button>
            <el-button v-if="b.status === 'DRAFT'" type="primary" :disabled="busy || loading" :loading="busy && actionBook === b.id && action === 'activate'" @click="activate(b)">启用账套</el-button>
          </div>
        </header>
        <dl class="book-facts">
          <div><dt>账套编号</dt><dd class="mono">#{{ b.id }}</dd></div>
          <div><dt>经营主体编号</dt><dd class="mono">{{ b.entityId == null ? '-' : `#${b.entityId}` }}</dd></div>
          <div><dt>本位币</dt><dd class="mono">{{ b.baseCurrency || '-' }}</dd></div>
        </dl>
        <el-alert v-if="b.status === 'DRAFT'" title="账套尚未启用" description="启用仅开放业务归属，不补填未知期初金额；会计期间、计价方法和财务启用须分别配置。" type="info" :closable="false" class="book-notice" />
        <el-alert v-if="actionError && actionBook === b.id" :title="actionError" type="error" :closable="false" show-icon class="book-notice" role="alert" />
        <div v-if="canConfigure" class="period-config">
          <h4>补齐会计期间</h4>
          <el-form :model="periodForms[b.id]" label-position="top" class="period-form" @submit.prevent="gen(b.id)">
            <el-form-item label="会计年度" required :for="`fiscal-year-${b.id}`">
              <el-input-number :id="`fiscal-year-${b.id}`" v-model="periodForms[b.id]!.fiscalYear" :min="1900" :max="9999" :precision="0" :disabled="busy || loading || b.status !== 'ACTIVE'" controls-position="right" />
            </el-form-item>
            <el-form-item label="首个月份" required :for="`first-month-${b.id}`">
              <el-input-number :id="`first-month-${b.id}`" v-model="periodForms[b.id]!.firstMonth" :min="1" :max="12" :precision="0" :disabled="busy || loading || b.status !== 'ACTIVE'" controls-position="right" />
            </el-form-item>
            <el-form-item class="generate-action"><el-button type="primary" native-type="submit" :disabled="busy || loading || b.status !== 'ACTIVE'" :loading="busy && actionBook === b.id && action === 'generate'">补齐至年末期间</el-button></el-form-item>
          </el-form>
          <p class="muted config-hint">年中启用时，首个月份选择首个会计期间；期初截止日为该月开始的前一天。仅补齐所选月份至12月，不修改已有期间。</p>
        </div>
        <div class="period-header">
          <h4>会计期间 <span class="muted">{{ filteredPeriods(b).length }} 个</span></h4>
          <el-form label-position="left" class="year-filter">
            <el-form-item label="查看年度" :for="`view-year-${b.id}`">
              <el-select :id="`view-year-${b.id}`" v-model="tables[b.id]!.year" placeholder="全部年度" clearable :disabled="loading || busy" @change="resetPage(b.id)" @clear="tables[b.id]!.year = undefined; resetPage(b.id)">
                <el-option v-for="year in yearsFor(b)" :key="year" :label="String(year)" :value="year" />
              </el-select>
            </el-form-item>
          </el-form>
        </div>
        <div class="table-scroll">
          <el-table :data="pagedPeriods(b)" row-key="id" border stripe size="small" :aria-label="`${b.name}的会计期间`">
            <el-table-column prop="name" label="期间" min-width="110" show-overflow-tooltip />
            <el-table-column label="开始日期" min-width="125"><template #default="{ row }">{{ formatDate(row.startDate) }}</template></el-table-column>
            <el-table-column label="结束日期" min-width="125"><template #default="{ row }">{{ formatDate(row.endDate) }}</template></el-table-column>
            <el-table-column label="状态" min-width="90"><template #default="{ row }"><StatusTag :status="row.status" domain="period" /></template></el-table-column>
            <template #empty><el-empty :description="b.periods.length ? '所选年度没有会计期间' : '尚未生成会计期间'" :image-size="48" /></template>
          </el-table>
        </div>
        <div class="period-pagination">
          <span class="muted">共 {{ filteredPeriods(b).length }} 个期间</span>
          <el-pagination v-model:current-page="tables[b.id]!.page" v-model:page-size="tables[b.id]!.size" :page-sizes="[20, 50, 100]" :total="filteredPeriods(b).length" :pager-count="5" layout="sizes, prev, pager, next" small background :disabled="loading || busy" @size-change="resetPage(b.id)" />
        </div>
      </section>
    </template>
    <el-dialog v-model="dialog" title="修改账套名称" width="480px" class="book-name-dialog" :close-on-click-modal="false" :close-on-press-escape="!busy" :show-close="!busy">
      <el-form :model="form" label-position="top" @submit.prevent="save">
        <el-form-item label="账套名称" for="book-name" required :error="saveError"><el-input id="book-name" v-model="form.name" maxlength="100" show-word-limit :disabled="busy" /></el-form-item>
        <p class="muted">经营主体和本位币由初始化配置确定，不能通过名称编辑修改。</p>
      </el-form>
      <template #footer><el-button :disabled="busy" @click="dialog = false">取消</el-button><el-button type="primary" :loading="busy && action === 'rename'" :disabled="loading || !canConfigure" @click="save">保存名称</el-button></template>
    </el-dialog>
  </div>
</template>

<style scoped lang="scss">
.books-page { min-width: 0; }
.books-title { align-items: flex-start; flex-wrap: wrap; }
.books-title p { margin: 8px 0 0; line-height: 1.6; }
.page-notice, .book-notice { margin-bottom: 16px; }
.book-count { margin: 0 0 12px; }
.book-header, .book-heading, .book-actions, .period-header, .period-pagination { display: flex; align-items: center; gap: 12px; flex-wrap: wrap; }
.book-header, .period-header, .period-pagination { justify-content: space-between; }
.book-heading { min-width: 0; }
.book-heading h3 { margin: 0; font-size: 16px; font-weight: 600; line-height: 1.6; overflow-wrap: anywhere; }
.book-actions { flex-shrink: 0; gap: 8px; }
.book-actions :deep(.el-button + .el-button) { margin-left: 0; }
.book-facts { display: flex; flex-wrap: wrap; gap: 12px 32px; margin: 16px 0; }
.book-facts > div { display: flex; align-items: baseline; gap: 8px; min-width: 0; }
.book-facts dt { color: var(--el-text-color-secondary); font-size: 13px; }
.book-facts dd { margin: 0; overflow-wrap: anywhere; }
h4 { margin: 0; font-size: 14px; font-weight: 600; }
.period-config { padding: 16px 0; border-top: 1px solid var(--el-border-color-lighter); border-bottom: 1px solid var(--el-border-color-lighter); }
.period-form { display: flex; align-items: flex-end; flex-wrap: wrap; gap: 12px; margin-top: 12px; }
.period-form :deep(.el-form-item) { margin: 0; }
.period-form :deep(.el-input-number) { width: 160px; }
.config-hint { margin: 12px 0 0; line-height: 1.7; }
.period-header { margin: 16px 0 12px; }
.period-header h4 span { margin-left: 8px; font-weight: 400; }
.year-filter :deep(.el-form-item) { margin: 0; }
.year-filter :deep(.el-select) { width: 160px; }
.period-pagination { margin-top: 12px; }
.period-pagination :deep(.el-pagination) { flex-wrap: wrap; gap: 8px; }
.retry-button { margin-top: 12px; }
.books-page :deep(.book-name-dialog) { max-width: calc(100vw - 32px); }
.books-page :deep(button:focus-visible) { outline: 2px solid var(--el-color-primary); outline-offset: 3px; }
@media (max-width: 768px) {
  .book-actions { width: 100%; justify-content: flex-end; }
  .book-facts { gap: 12px 16px; }
  .period-form > :deep(.el-form-item) { flex: 1 1 120px; min-width: 0; }
  .period-form :deep(.el-input-number) { width: 100%; }
  .period-form > :deep(.generate-action) { flex-basis: 100%; }
  .generate-action :deep(.el-button) { width: 100%; }
  .year-filter { width: 100%; }
  .year-filter :deep(.el-select) { width: 100%; }
  .period-pagination { align-items: flex-start; }
  .period-pagination > span { width: 100%; }
  .period-pagination :deep(.el-pagination) { max-width: 100%; }
}
</style>
