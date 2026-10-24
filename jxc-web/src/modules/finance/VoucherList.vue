<script setup lang="ts">
import { computed, onBeforeUnmount, onMounted, reactive, ref } from 'vue'
import { ElMessage, ElMessageBox } from 'element-plus'
import { http, createCommandIntent } from '@/api/http'
import type { PageResult } from '@/api/types'
import { allRecords } from '@/api/pagination'
import DocAttachment from '@/components/DocAttachment.vue'
import MoneyText from '@/components/MoneyText.vue'
import StatusTag from '@/components/StatusTag.vue'
import { financeSourcePath } from '@/utils/finance-source'
import { formatDate, todayIn } from '@/utils/format'
import { statusDef } from '@/utils/status'
import { getToken, getCountryId } from '@/utils/session'
import { useRoute } from 'vue-router'
import { useUserStore } from '@/stores/user'
import { useCountryStore } from '@/stores/country'
import { useOptionsStore, type OptionItem } from '@/stores/options'

type Row = Record<string, any>
const route = useRoute(), user = useUserStore(), country = useCountryStore(), options = useOptionsStore()
const mockMode = import.meta.env.MODE === 'demo' && import.meta.env.VITE_USE_MOCK === 'true'
const saveIntent = createCommandIntent(), actionIntent = createCommandIntent(), batchIntent = createCommandIntent()
const books = ref<Row[]>([]), currencies = ref<Row[]>([]), bookId = ref<number>(), status = ref('')
const rows = ref<Row[]>([]), selected = ref<Row[]>([]), total = ref(0), query = reactive({ page: 1, size: 20 })
const booksLoading = ref(false), booksError = ref(''), loading = ref(false), listError = ref('')
const current = ref<Row | null>(null), detailVisible = ref(false), detailLoading = ref(false), detailError = ref(''), detailId = ref<number>()
const dialog = ref(false), editing = ref<number | null>(null), editLoading = ref(false), editError = ref(''), saveError = ref('')
const saving = ref(false), acting = ref(false), actionError = ref(''), busy = computed(() => saving.value || acting.value)
const accounts = ref<Row[]>([]), words = ref<Row[]>([]), cashflows = ref<Row[]>([]), auxOptions = ref<Record<string, OptionItem[]>>({})
const form = reactive({ version: undefined as number | undefined, voucherDate: '', wordId: null as number | null, summary: '', lines: [] as Row[] })
const selectedBook = computed(() => books.value.find(b => b.id === bookId.value))
const baseCurrency = computed(() => selectedBook.value?.baseCurrency)
const baseDecimals = computed(() => currencies.value.find(c => c.code === baseCurrency.value)?.decimals ?? 2)
const originalDecimals = (currency: string) => currencies.value.find(c => c.code === currency)?.decimals ?? 2
const totals = computed(() => ({ debit: form.lines.reduce((n, l) => n + Number(l.debit || 0), 0), credit: form.lines.reduce((n, l) => n + Number(l.credit || 0), 0) }))
const statuses = ['DRAFT', 'PENDING_AUDIT', 'AUDITED', 'POSTED', 'REVERSED']
const sourceLabels: Record<string, string> = { MANUAL: '人工凭证', AUTO: '自动凭证', REVERSAL: '冲销凭证' }
const sourceLabel = (value?: string) => value ? sourceLabels[value] ?? value : '-'
const auxFields: Record<string, { field: string; label: string; url: string }> = {
  CUSTOMER: { field: 'customerId', label: '客户', url: '/md/customers' }, PARTNER: { field: 'partnerId', label: '供应商', url: '/md/partners' },
  FUND: { field: 'fundAccountId', label: '资金账户', url: '/md/fund-accounts' }, PRODUCT: { field: 'productId', label: '商品', url: '/md/products' },
  WAREHOUSE: { field: 'warehouseId', label: '仓库', url: '/org/warehouses' }, STORE: { field: 'storeId', label: '门店', url: '/org/stores' },
  EXPENSE: { field: 'expenseItemId', label: '费用项目', url: '/md/expense-items' }, EMPLOYEE: { field: 'employeeId', label: '员工', url: '/sys/users' },
}
const auxAliases: Record<string, string> = { customerId: 'CUSTOMER', supplierId: 'PARTNER', partnerId: 'PARTNER', fundAccountId: 'FUND', productId: 'PRODUCT', warehouseId: 'WAREHOUSE', storeId: 'STORE', expenseItemId: 'EXPENSE', employeeId: 'EMPLOYEE', SUPPLIER: 'PARTNER' }
let alive = true, listRequest = 0, detailRequest = 0, editorRequest = 0, booksRequest = 0
let editorBook: number | undefined, editTarget: Row | undefined
const scope = () => `${getToken()}:${getCountryId()}:${country.epoch}`
const context = () => ({ scope: scope(), book: bookId.value })
const isCurrent = (ctx: ReturnType<typeof context>) => alive && ctx.scope === scope() && ctx.book === bookId.value
const errorMessage = (e: unknown, fallback: string) => e instanceof Error && e.message ? e.message : fallback
function account(line: Row) { return accounts.value.find(a => a.id === line.accountId) }
function types(line: Row): string[] { return (account(line)?.auxTypes || []).map((t: string) => auxAliases[t] || t) }
async function loadAux(line: Row) {
  for (const type of types(line)) {
    const field = auxFields[type]
    if (field && !auxOptions.value[type]) auxOptions.value[type] = await options.remote(field.url, type === 'EMPLOYEE' ? 'displayName' : 'name', 'id', { size: 200 })
  }
}
async function changeAccount(line: Row) {
  line.aux = {}; line.currency = baseCurrency.value; line.origAmount = null; line.rate = 1; line.cashflowItemId = null
  const ctx = context()
  try { await loadAux(line) } catch (e) { if (isCurrent(ctx)) saveError.value = errorMessage(e, '辅助核算选项读取失败，请重新选择科目') }
}
function addLine() { form.lines.push({ accountId: null, summary: '', debit: 0, credit: 0, aux: {}, currency: baseCurrency.value, origAmount: null, rate: 1 }) }
function closeDetail() { detailRequest++; current.value = null; detailVisible.value = false; detailLoading.value = false; detailError.value = ''; actionError.value = '' }
async function load() {
  const request = ++listRequest, ctx = context()
  rows.value = []; selected.value = []; listError.value = ''; closeDetail()
  loading.value = !!ctx.book
  if (!ctx.book) { total.value = 0; return }
  try {
    const result = await http.get<PageResult<Row>>('/fin/vouchers', { bookId: ctx.book, status: status.value || undefined, ...query })
    if (request !== listRequest || !isCurrent(ctx)) return
    if (!Array.isArray(result?.records) || !Number.isSafeInteger(result.total) || result.total < 0) throw new Error('凭证分页数据不完整，请重试')
    rows.value = result.records; total.value = result.total
  } catch (e) { if (request === listRequest && isCurrent(ctx)) listError.value = errorMessage(e, '凭证读取失败，请重试') }
  finally { if (request === listRequest && isCurrent(ctx)) loading.value = false }
}
function search() { query.page = 1; total.value = 0; return load() }
function changeBook() {
  editorRequest++; dialog.value = false; editLoading.value = false; form.lines = []; auxOptions.value = {}; accounts.value = []; words.value = []; cashflows.value = []
  return search()
}
async function loadBooks() {
  const request = ++booksRequest, stamp = scope()
  booksLoading.value = true; booksError.value = ''
  try {
    const result = await http.get<Row[]>('/fin/books')
    if (!alive || stamp !== scope() || request !== booksRequest) return
    if (!Array.isArray(result)) throw new Error('账套数据不完整，请重试')
    books.value = result
    const requested = bookId.value ?? Number(route.query.bookId)
    bookId.value = result.some(b => b.id === requested) ? requested : result.length === 1 ? result[0]!.id : undefined
    await load()
  } catch (e) { if (alive && stamp === scope() && request === booksRequest) booksError.value = errorMessage(e, '账套读取失败，请重试') }
  finally { if (alive && stamp === scope() && request === booksRequest) booksLoading.value = false }
}
async function open(row: Row) {
  if (!bookId.value || busy.value) return
  const request = ++detailRequest, ctx = context()
  detailId.value = row.id; detailVisible.value = true; detailLoading.value = true; detailError.value = ''; current.value = null; actionError.value = ''
  try {
    const result = await http.get<Row>('/fin/vouchers/' + row.id, { bookId: ctx.book })
    if (request !== detailRequest || !isCurrent(ctx)) return
    if (result?.id !== row.id || !Array.isArray(result.lines)) throw new Error('凭证详情数据不完整，请重试')
    current.value = result
  } catch (e) { if (request === detailRequest && isCurrent(ctx)) detailError.value = errorMessage(e, '凭证详情读取失败，请重试') }
  finally { if (request === detailRequest && isCurrent(ctx)) detailLoading.value = false }
}
async function edit(row?: Row) {
  if (!bookId.value || busy.value || !user.hasPerm(row ? 'fin:voucher:edit' : 'fin:voucher:create') || (row && (row.status !== 'DRAFT' || row.sourceKind !== 'MANUAL'))) return
  const request = ++editorRequest, ctx = context()
  editTarget = row; editorBook = ctx.book; editing.value = row?.id ?? null; dialog.value = true; editLoading.value = true; editError.value = ''; saveError.value = ''; form.lines = []
  try {
    const [detail, accountRows, currencyRows, wordRows, flowRows] = await Promise.all([
      row ? http.get<Row>('/fin/vouchers/' + row.id, { bookId: ctx.book }) : undefined,
      allRecords<Row>('/fin/accounts', { bookId: ctx.book }), allRecords<Row>('/md/currencies'),
      mockMode ? [] : allRecords<Row>('/fin/voucher-words', { bookId: ctx.book }), mockMode ? [] : allRecords<Row>('/fin/cashflow-items', { bookId: ctx.book }),
    ])
    if (request !== editorRequest || !isCurrent(ctx)) return
    if (detail && (detail.status !== 'DRAFT' || detail.sourceKind !== 'MANUAL')) throw new Error('凭证已变更，仅人工草稿可修改，请刷新列表')
    accounts.value = accountRows.filter(a => a.isLeaf && a.status === 'ENABLED'); currencies.value = currencyRows; words.value = wordRows; cashflows.value = flowRows
    form.version = detail?.version; form.wordId = detail?.wordId ?? null; form.summary = detail?.summary || ''; form.voucherDate = detail?.voucherDate || todayIn(country.timezone)
    form.lines = detail ? JSON.parse(JSON.stringify(detail.lines)) : []
    for (const line of form.lines) if (line.aux?.supplierId) { line.aux.partnerId = line.aux.supplierId; delete line.aux.supplierId }
    if (!detail) { addLine(); addLine() }
    for (const line of form.lines) await loadAux(line)
    if (request === editorRequest && isCurrent(ctx)) saveIntent.reset()
  } catch (e) { if (request === editorRequest && isCurrent(ctx)) editError.value = errorMessage(e, '凭证编辑资料读取失败，请重试') }
  finally { if (request === editorRequest && isCurrent(ctx)) editLoading.value = false }
}
function closeEditor() { editorRequest++; dialog.value = false; editLoading.value = false }
async function save() {
  if (busy.value || editLoading.value || editError.value || !dialog.value) return
  if (!bookId.value || editorBook !== bookId.value || !baseCurrency.value || !user.hasPerm(editing.value ? 'fin:voucher:edit' : 'fin:voucher:create')) { saveError.value = '请确认账套、本位币和凭证编辑权限'; return }
  if (!form.voucherDate || form.lines.length < 2) { saveError.value = '请填写凭证日期及至少两条分录'; return }
  const ctx = context(), base = baseCurrency.value, id = editing.value
  saving.value = true; saveError.value = ''
  try {
    const payload = { ...form, lines: form.lines.map(line => line.currency === base || !account(line)?.fxEnabled ? { ...line, currency: base, origAmount: Number(line.debit || line.credit || 0), rate: 1 } : line) }
    const path = '/fin/vouchers' + (id ? '/' + id : '') + '?bookId=' + ctx.book
    const updated = id ? await http.putIdem<Row>(path, payload, saveIntent) : await http.postIdem<Row>(path, payload, saveIntent)
    if (!isCurrent(ctx)) return
    dialog.value = false; ElMessage.success('草稿已保存，审核后方可记账')
    await load()
    if (isCurrent(ctx)) { current.value = updated; detailVisible.value = true }
  } catch (e) { if (isCurrent(ctx)) saveError.value = errorMessage(e, '草稿保存失败，请重试') }
  finally { if (alive) saving.value = false }
}
const actions: Record<string, { label: string; permission: string; status: string }> = {
  '/submit': { label: '提交', permission: 'fin:voucher:create', status: 'DRAFT' },
  '/audit': { label: '审核', permission: 'fin:voucher:audit', status: 'PENDING_AUDIT' },
  '/unaudit': { label: '取消审核', permission: 'fin:voucher:unaudit', status: 'AUDITED' },
  '/post': { label: '记账', permission: 'fin:voucher:post', status: 'AUDITED' },
  '/reverse': { label: '冲销', permission: 'fin:voucher:reverse', status: 'POSTED' },
}
const canAct = (path: string) => !!current.value && current.value.status === actions[path]?.status && user.hasPerm(actions[path]!.permission)
const canEdit = computed(() => current.value?.status === 'DRAFT' && current.value.sourceKind === 'MANUAL' && user.hasPerm('fin:voucher:edit'))
function canBatch(action: 'audit' | 'post') { return !mockMode && user.hasPerm('fin:voucher:' + action) && selected.value.length > 0 && selected.value.every(r => r.status === (action === 'audit' ? 'PENDING_AUDIT' : 'AUDITED')) }
async function runAction(run: (ctx: ReturnType<typeof context>) => Promise<Row | void>, message: string) {
  if (busy.value || !bookId.value) return
  const ctx = context(); acting.value = true; actionError.value = ''
  try {
    const result = await run(ctx)
    if (!isCurrent(ctx)) return
    ElMessage.success(message); await load()
    if (result && isCurrent(ctx)) { current.value = result; detailVisible.value = true }
  } catch (e) { if (isCurrent(ctx) && e !== 'cancel' && e !== 'close') actionError.value = errorMessage(e, '凭证操作失败，请重试') }
  finally { if (alive) acting.value = false }
}
async function removeDraft() {
  if (!canEdit.value || mockMode || !current.value) return
  const row = current.value
  await runAction(async ctx => {
    await ElMessageBox.confirm('删除这张人工草稿凭证？', '删除草稿', { type: 'warning' })
    if (!isCurrent(ctx)) return
    await actionIntent.run(`${getToken()}:${getCountryId()}`, 'DELETE /fin/vouchers/' + row.id, { version: row.version, bookId: ctx.book }, key => http.delete('/fin/vouchers/' + row.id, { params: { version: row.version, bookId: ctx.book }, headers: { 'Idempotency-Key': key } }))
  }, '草稿已删除')
}
async function act(path: string) {
  if (!canAct(path) || !current.value) return
  const row = current.value
  await runAction(async ctx => {
    let body: Row = { version: row.version }
    if (path === '/unaudit') { const { value } = await ElMessageBox.prompt('填写取消审核原因', '取消审核', { inputValidator: value => !!value?.trim() || '请填写原因' }); body.reason = value }
    if (path === '/reverse') {
      const { value } = await ElMessageBox.prompt('冲销日期须在开放期间内', '冲销', { inputValue: todayIn(country.timezone), inputPattern: /^\d{4}-\d{2}-\d{2}$/, inputErrorMessage: '请填写 YYYY-MM-DD 日期' })
      const reason = await ElMessageBox.prompt('填写冲销原因', '冲销原因', { inputValidator: value => !!value?.trim() || '请填写原因' })
      body = { ...body, voucherDate: value, reason: reason.value }
    }
    if (!isCurrent(ctx)) return
    return http.postIdem<Row>('/fin/vouchers/' + row.id + path + '?bookId=' + ctx.book, body, actionIntent)
  }, actions[path]!.label + '成功')
}
async function batch(action: 'audit' | 'post') {
  if (!canBatch(action)) return
  const chosen = selected.value.map(r => ({ id: r.id, version: r.version }))
  await runAction(async ctx => {
    await ElMessageBox.confirm('对选中的 ' + chosen.length + ' 张凭证执行' + (action === 'audit' ? '审核' : '记账') + '？', '批量操作')
    if (!isCurrent(ctx)) return
    await http.postIdem('/fin/vouchers/batch-' + action + '?bookId=' + ctx.book, { ids: chosen.map(r => r.id), versions: Object.fromEntries(chosen.map(r => [r.id, r.version])) }, batchIntent)
  }, '批量操作已完成')
}
onMounted(async () => { await loadBooks(); if (bookId.value && route.query.voucherId) await open({ id: Number(route.query.voucherId) }) })
onBeforeUnmount(() => { alive = false; listRequest++; detailRequest++; editorRequest++; booksRequest++ })
</script>

<template>
  <div class="page voucher-page">
    <section class="page-card">
      <div class="page-title">
        <div><h2>凭证</h2><p class="muted">查询与核对凭证，人工草稿审核后方可记账</p></div>
        <el-button v-if="user.hasPerm('fin:voucher:create')" type="primary" :disabled="!bookId || busy || booksLoading" @click="edit()">新建人工凭证</el-button>
      </div>
      <el-alert v-if="booksError" type="error" :closable="false" show-icon class="feedback"><template #title>{{ booksError }} <el-button link type="primary" @click="loadBooks">重试</el-button></template></el-alert>
      <el-form inline class="voucher-filters" @submit.prevent="search">
        <el-form-item label="账套"><el-select v-model="bookId" filterable clearable placeholder="请选择账套" :loading="booksLoading" :disabled="busy || booksLoading" @change="changeBook"><el-option v-for="b in books" :key="b.id" :label="b.name" :value="b.id" /></el-select></el-form-item>
        <el-form-item label="状态"><el-select v-model="status" clearable placeholder="全部状态" :disabled="busy || !bookId" @change="search"><el-option v-for="value in statuses" :key="value" :label="statusDef(value, 'voucher').label" :value="value" /></el-select></el-form-item>
        <el-form-item><el-button :loading="loading" :disabled="!bookId || busy" @click="load">刷新</el-button></el-form-item>
      </el-form>
      <div class="voucher-list-heading">
        <div><strong>凭证列表</strong><span class="muted">{{ selectedBook?.name || '请先选择账套' }}<template v-if="baseCurrency"> · 本位币 {{ baseCurrency }}</template></span></div>
        <span class="muted">{{ loading ? '正在读取凭证…' : listError ? '读取失败' : `共 ${total} 张` }}</span>
      </div>
      <div v-if="!mockMode && (user.hasPerm('fin:voucher:audit') || user.hasPerm('fin:voucher:post'))" class="toolbar batch-toolbar">
        <span class="muted">已选 {{ selected.length }} 张</span>
        <el-button v-if="user.hasPerm('fin:voucher:audit')" size="small" :disabled="busy || loading || !canBatch('audit')" @click="batch('audit')">批量审核</el-button>
        <el-button v-if="user.hasPerm('fin:voucher:post')" size="small" :disabled="busy || loading || !canBatch('post')" @click="batch('post')">批量记账</el-button>
        <span class="muted batch-hint">待审核凭证可审核，已审核凭证可记账</span>
      </div>
      <el-alert v-if="listError" type="error" :closable="false" show-icon class="feedback"><template #title>{{ listError }} <el-button link type="primary" @click="load">重试</el-button></template></el-alert>
      <el-alert v-if="actionError && !detailVisible" :title="actionError" type="error" :closable="false" show-icon class="feedback" />
      <div class="table-scroll">
        <el-table v-loading="loading || booksLoading" :data="rows" border stripe row-key="id" size="small" @row-click="open" @selection-change="selected = $event">
          <el-table-column v-if="!mockMode && (user.hasPerm('fin:voucher:audit') || user.hasPerm('fin:voucher:post'))" type="selection" width="44" fixed="left" :selectable="() => !busy && !loading" />
          <el-table-column label="凭证号" min-width="190"><template #default="{ row }"><el-button link type="primary" class="mono" :disabled="busy" @click.stop="open(row)">{{ row.voucherNo }}</el-button></template></el-table-column>
          <el-table-column label="日期" width="110"><template #default="{ row }">{{ formatDate(row.voucherDate) }}</template></el-table-column>
          <el-table-column label="来源" width="110"><template #default="{ row }">{{ sourceLabel(row.sourceKind) }}</template></el-table-column>
          <el-table-column label="摘要" prop="summary" min-width="180" show-overflow-tooltip />
          <el-table-column label="借方金额" min-width="165" align="right"><template #default="{ row }"><MoneyText v-if="baseCurrency" :value="row.totalDebit" :currency="baseCurrency" /><span v-else>-</span></template></el-table-column>
          <el-table-column label="贷方金额" min-width="165" align="right"><template #default="{ row }"><MoneyText v-if="baseCurrency" :value="row.totalCredit" :currency="baseCurrency" /><span v-else>-</span></template></el-table-column>
          <el-table-column label="状态" width="100"><template #default="{ row }"><StatusTag :status="row.status" domain="voucher" /></template></el-table-column>
          <el-table-column prop="preparedByName" label="编制人" min-width="110" show-overflow-tooltip />
          <el-table-column label="操作" width="85" fixed="right"><template #default="{ row }"><el-button link type="primary" :disabled="busy" @click.stop="open(row)">查看</el-button></template></el-table-column>
          <template #empty><el-empty :image-size="56" :description="booksLoading || loading ? '正在读取凭证…' : booksError ? '账套未加载，请重试' : !books.length ? '暂无可用账套' : !bookId ? '请选择账套查看凭证' : listError ? '凭证读取失败，请重试' : status ? '当前状态下没有凭证' : '当前账套暂无凭证'" /></template>
        </el-table>
      </div>
      <div class="voucher-pagination"><el-pagination v-model:current-page="query.page" v-model:page-size="query.size" :page-sizes="[20, 50, 100]" :total="total" :pager-count="5" background layout="total, sizes, prev, pager, next" :disabled="loading || busy || !!listError || !bookId" @current-change="load" @size-change="search" /></div>
    </section>

    <el-drawer v-model="detailVisible" title="凭证详情" size="min(1080px, 100vw)" :close-on-click-modal="!busy" :close-on-press-escape="!busy" :show-close="!busy" @closed="!detailVisible && closeDetail()">
      <div v-loading="detailLoading" class="voucher-detail">
        <el-alert v-if="detailError" type="error" :closable="false" show-icon><template #title>{{ detailError }} <el-button link type="primary" @click="open({ id: detailId })">重试</el-button></template></el-alert>
        <template v-if="current">
          <div class="detail-heading"><div><h3 class="mono">{{ current.voucherNo }}</h3><span class="muted">{{ selectedBook?.name }} · {{ formatDate(current.voucherDate) }}</span></div><StatusTag :status="current.status" domain="voucher" /></div>
          <div class="toolbar detail-actions">
            <el-button v-if="canEdit" :disabled="busy" @click="edit(current)">修改草稿</el-button>
            <el-button v-for="(action, path) in actions" v-show="canAct(String(path))" :key="path" :type="['/audit', '/post', '/submit'].includes(String(path)) ? 'primary' : undefined" :loading="acting" :disabled="busy" @click="act(String(path))">{{ action.label }}</el-button>
            <el-button v-if="!mockMode && canEdit" type="danger" plain :disabled="busy" @click="removeDraft">删除草稿</el-button>
          </div>
          <el-alert v-if="actionError" :title="actionError" type="error" :closable="false" show-icon class="feedback" />
          <el-descriptions :column="2" border size="small" class="voucher-metadata">
            <el-descriptions-item label="凭证来源">{{ sourceLabel(current.sourceKind) }}</el-descriptions-item><el-descriptions-item label="编制人">{{ current.preparedByName ?? current.preparedBy ?? '-' }}</el-descriptions-item>
            <el-descriptions-item label="摘要" :span="2">{{ current.summary || '-' }}</el-descriptions-item>
            <el-descriptions-item v-if="current.sourceEventId" label="来源事件" :span="2"><router-link :to="{ path: '/finance/events', query: { bookId, eventId: current.sourceEventId } }">事件 #{{ current.sourceEventId }}</router-link></el-descriptions-item>
          </el-descriptions>
          <div class="section-heading"><h3>会计分录</h3><span class="muted">{{ current.lines.length }} 条 · 本位币 {{ baseCurrency || '未配置' }}</span></div>
          <div class="table-scroll">
            <el-table :data="current.lines" border stripe size="small">
              <el-table-column type="index" label="#" width="44" /><el-table-column prop="accountCode" label="科目编码" width="110" /><el-table-column prop="accountName" label="科目名称" min-width="140" show-overflow-tooltip /><el-table-column prop="summary" label="摘要" min-width="180" show-overflow-tooltip />
              <el-table-column label="借方金额" min-width="165" align="right"><template #default="{ row }"><MoneyText v-if="baseCurrency" :value="row.debit" :currency="baseCurrency" /><span v-else>-</span></template></el-table-column>
              <el-table-column label="贷方金额" min-width="165" align="right"><template #default="{ row }"><MoneyText v-if="baseCurrency" :value="row.credit" :currency="baseCurrency" /><span v-else>-</span></template></el-table-column>
              <el-table-column label="来源单据" min-width="160"><template #default="{ row }"><router-link v-if="financeSourcePath(row)" :to="financeSourcePath(row)!">{{ row.sourceDocType }} #{{ row.sourceDocId }}</router-link><span v-else>{{ row.sourceDocType ?? '-' }} {{ row.sourceDocId ?? '' }}</span></template></el-table-column>
            </el-table>
          </div>
          <div class="voucher-totals"><span>凭证合计</span><span>借方 <MoneyText v-if="baseCurrency" :value="current.totalDebit" :currency="baseCurrency" /></span><span>贷方 <MoneyText v-if="baseCurrency" :value="current.totalCredit" :currency="baseCurrency" /></span></div>
          <template v-if="!mockMode"><div class="section-heading"><h3>凭证附件</h3><span class="muted">人工草稿可维护附件，其他状态只读</span></div><DocAttachment :key="current.id" biz-type="FIN_VOUCHER" :biz-id="current.id" category="VOUCHER_ATTACH" :readonly="busy || !canEdit" /></template>
        </template>
        <el-empty v-else-if="detailLoading" description="正在读取凭证详情…" :image-size="56" />
      </div>
    </el-drawer>

    <el-dialog v-model="dialog" :title="editing ? '修改人工凭证草稿' : '新建人工凭证'" width="min(1180px, 96vw)" class="voucher-editor" :close-on-click-modal="false" :close-on-press-escape="!saving" :show-close="!saving" @closed="!dialog && closeEditor()">
      <div v-loading="editLoading" class="editor-body">
        <el-alert v-if="editError" type="error" :closable="false" show-icon class="feedback"><template #title>{{ editError }} <el-button link type="primary" @click="edit(editTarget)">重试</el-button></template></el-alert>
        <template v-else>
          <p class="muted editor-context">{{ selectedBook?.name }} · 本位币 {{ baseCurrency || '未配置' }} · 保存为草稿</p>
          <el-form label-position="top" :disabled="saving || editLoading" class="editor-fields">
            <el-form-item label="凭证日期" required><el-date-picker v-model="form.voucherDate" type="date" value-format="YYYY-MM-DD" placeholder="请选择凭证日期" /></el-form-item>
            <el-form-item v-if="!mockMode" label="凭证字"><el-select v-model="form.wordId" clearable placeholder="请选择凭证字"><el-option v-for="w in words" :key="w.id" :label="w.name" :value="w.id" /></el-select></el-form-item>
            <el-form-item label="摘要" class="summary-field"><el-input v-model="form.summary" placeholder="请输入凭证摘要" /></el-form-item>
          </el-form>
          <div class="section-heading"><h3>会计分录</h3><el-button link type="primary" :disabled="saving || editLoading" @click="addLine">增加分录</el-button></div>
          <el-form :disabled="saving || editLoading" class="table-scroll">
            <el-table :data="form.lines" border stripe size="small">
              <el-table-column type="index" label="#" width="44" />
              <el-table-column label="科目" min-width="210"><template #default="{ row }"><el-select v-model="row.accountId" filterable placeholder="请选择科目" @change="changeAccount(row)"><el-option v-for="a in accounts" :key="a.id" :label="a.code + ' ' + a.name" :value="a.id" /></el-select></template></el-table-column>
              <el-table-column label="摘要" min-width="180"><template #default="{ row }"><el-input v-model="row.summary" placeholder="请输入分录摘要" /></template></el-table-column>
              <el-table-column label="辅助核算" min-width="180"><template #default="{ row }"><div v-for="type in types(row)" :key="type" class="aux-field"><el-select v-if="auxFields[type]" v-model="row.aux[auxFields[type].field]" :aria-label="auxFields[type].label" :placeholder="'请选择' + auxFields[type].label" filterable><el-option v-for="o in auxOptions[type] ?? []" :key="String(o.value)" :label="o.label" :value="o.value" /></el-select></div></template></el-table-column>
              <el-table-column label="借方金额" width="145" align="right"><template #default="{ row }"><el-input-number v-model="row.debit" aria-label="借方金额" :min="0" :precision="baseDecimals" :controls="false" /></template></el-table-column>
              <el-table-column label="贷方金额" width="145" align="right"><template #default="{ row }"><el-input-number v-model="row.credit" aria-label="贷方金额" :min="0" :precision="baseDecimals" :controls="false" /></template></el-table-column>
              <el-table-column v-if="!mockMode" label="现金流项目" min-width="180"><template #default="{ row }"><el-select v-if="account(row)?.isCash || account(row)?.isBank" v-model="row.cashflowItemId" filterable placeholder="请选择现金流项目"><el-option v-for="c in cashflows" :key="c.id" :label="c.name" :value="c.id" /></el-select><span v-else class="muted">不适用</span></template></el-table-column>
              <el-table-column label="操作" width="65" fixed="right"><template #default="{ $index }"><el-button link type="danger" :disabled="saving || editLoading" @click="form.lines.splice($index, 1)">删除</el-button></template></el-table-column>
            </el-table>
          </el-form>
          <el-form :disabled="saving || editLoading" label-position="top">
            <template v-for="(line, i) in form.lines" :key="i"><div v-if="account(line)?.fxEnabled" class="fx-fields"><strong>第 {{ i + 1 }} 行外币</strong><el-form-item label="原币币种"><el-input v-model="line.currency" /></el-form-item><el-form-item label="原币金额"><el-input-number v-model="line.origAmount" :min="0" :precision="originalDecimals(line.currency)" /></el-form-item><el-form-item label="汇率"><el-input-number v-model="line.rate" :min="0" :precision="8" /></el-form-item></div></template>
          </el-form>
          <div class="voucher-totals"><span>本位币 {{ baseCurrency || '未配置' }}</span><span>借方 <MoneyText v-if="baseCurrency" :value="totals.debit" :currency="baseCurrency" /></span><span>贷方 <MoneyText v-if="baseCurrency" :value="totals.credit" :currency="baseCurrency" /></span></div>
          <p class="muted">借贷金额与辅助核算由保存时校验；保存草稿不会自动审核或记账。</p>
        </template>
        <el-alert v-if="saveError" :title="saveError" type="error" :closable="false" show-icon class="feedback" />
      </div>
      <template #footer><el-button :disabled="saving" @click="closeEditor">取消</el-button><el-button type="primary" :loading="saving" :disabled="editLoading || !!editError || !baseCurrency" @click="save">保存草稿</el-button></template>
    </el-dialog>
  </div>
</template>

<style scoped lang="scss">
.voucher-page { min-width: 0; }
.page-title { flex-wrap: wrap; }
.page-title p { margin: 4px 0 0; }
.voucher-filters { display: flex; flex-wrap: wrap; gap: 0 12px; }
.voucher-filters :deep(.el-form-item) { margin: 0 0 12px; }
.voucher-filters :deep(.el-select) { width: 200px; }
.voucher-list-heading, .section-heading, .detail-heading { display: flex; justify-content: space-between; align-items: center; flex-wrap: wrap; gap: 8px 16px; margin-bottom: 12px; }
.voucher-list-heading > div { display: flex; flex-wrap: wrap; gap: 8px 16px; }
.batch-toolbar { align-items: center; padding: 8px 12px; background: var(--el-fill-color-light); border-radius: 6px; }
.feedback { margin-bottom: 12px; }
.voucher-pagination { display: flex; justify-content: flex-end; overflow-x: auto; padding-top: 16px; }
.voucher-pagination :deep(.el-pagination) { flex-wrap: wrap; gap: 8px; }
.voucher-detail { min-height: 180px; min-width: 0; }
.detail-heading h3 { margin: 0 0 8px; font-size: 18px; overflow-wrap: anywhere; }
.detail-actions { flex-wrap: wrap; }
.detail-actions :deep(.el-button + .el-button) { margin-left: 0; }
.voucher-metadata { margin-bottom: 16px; overflow-wrap: anywhere; }
.section-heading { margin-top: 16px; }
.section-heading h3 { font-size: 14px; margin: 0; font-weight: 600; }
.voucher-totals { display: flex; flex-wrap: wrap; justify-content: flex-end; gap: 8px 24px; padding: 12px; background: var(--el-fill-color-light); margin-top: 12px; font-size: 13px; }
.voucher-totals > span:first-child { margin-right: auto; color: var(--el-text-color-secondary); }
.editor-body { min-height: 180px; }
.editor-context { margin: 0 0 16px; }
.editor-fields { display: grid; grid-template-columns: 180px 180px minmax(180px, 1fr); gap: 12px; }
.editor-fields :deep(.el-form-item) { margin-bottom: 0; min-width: 0; }
.editor-fields :deep(.el-date-editor), .editor-fields :deep(.el-select), .table-scroll :deep(.el-input-number) { width: 100%; }
.aux-field + .aux-field { margin-top: 8px; }
.fx-fields { display: flex; flex-wrap: wrap; align-items: center; gap: 12px; padding: 12px; margin-top: 12px; background: var(--el-fill-color-light); }
.fx-fields :deep(.el-form-item) { margin-bottom: 0; width: 180px; }
.voucher-page :deep(button:focus-visible) { outline: 2px solid var(--el-color-primary); outline-offset: 2px; }
@media (max-width: 768px) {
  .page-title > div, .voucher-filters :deep(.el-form-item) { width: 100%; }
  .voucher-filters :deep(.el-form-item__content) { flex: 1; }
  .voucher-filters :deep(.el-select) { width: 100%; }
  .batch-hint { width: 100%; }
  .voucher-pagination { justify-content: flex-start; }
  .editor-fields { grid-template-columns: minmax(0, 1fr); }
  .fx-fields :deep(.el-form-item) { width: 100%; }
}
</style>
