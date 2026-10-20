<script setup lang="ts">
import { computed, onMounted, reactive, ref, watch } from 'vue'
import { useRoute, useRouter } from 'vue-router'
import { ElMessage, ElMessageBox } from 'element-plus'
import { http, createCommandIntent } from '@/api/http'
import { allRecords } from '@/api/pagination'
import type { PageResult } from '@/api/types'
import { useUserStore } from '@/stores/user'
import { useCountryStore } from '@/stores/country'
import { getCountryId, getToken } from '@/utils/session'
import MoneyText from '@/components/MoneyText.vue'
import DateTimeText from '@/components/DateTimeText.vue'
import FieldInput from '@/components/crud/FieldInput.vue'
import ProductCell from '@/components/biz/ProductCell.vue'
import { COST_STATUS, MX_WAREHOUSE_SOURCE, PRODUCT_SOURCE, SUPPLIER_SOURCE, optionText } from '@/modules/shared/bizOptions'
import { formatDate, todayIn } from '@/utils/format'
import CostTraceDrawer from './CostTraceDrawer.vue'

type Row = Record<string, any> // eslint-disable-line @typescript-eslint/no-explicit-any

const route = useRoute()
const router = useRouter()
const user = useUserStore()
const country = useCountryStore()
const trace = ref<InstanceType<typeof CostTraceDrawer>>()
const canConfirm = computed(() => user.hasPerm('cst:cost:confirm'))
const canRate = computed(() => user.hasPerm(['md:rate:edit', 'md:rate:confirm']))
const methodIntent = createCommandIntent(), confirmIntent = createCommandIntent(), batchIntent = createCommandIntent()
const confirming = ref<number>(), batchConfirming = ref(false)
const confirmationDate = ref(todayIn(country.timezone))
const actionBusy = computed(() => confirming.value !== undefined || batchConfirming.value)
const method = reactive({ visible: false, loading: false, saving: false, books: [] as Row[], bookId: undefined as number | undefined, value: 'FIFO', effectiveFrom: todayIn(country.timezone), version: undefined as number | undefined, configured: false })
async function readMethod() {
  if (!method.bookId) { Object.assign(method, { value: 'FIFO', effectiveFrom: todayIn(country.timezone), version: undefined, configured: false }); return }
  const selected = method.bookId
  Object.assign(method, { value: 'FIFO', effectiveFrom: todayIn(country.timezone), version: undefined, configured: false })
  method.loading = true
  try {
    const current = await http.get<Row>('/cst/method', { bookId: selected })
    if (method.bookId === selected) Object.assign(method, { value: current.method ?? 'FIFO', effectiveFrom: current.effectiveFrom ?? todayIn(country.timezone), version: current.versionNo, configured: current.status !== 'UNCONFIGURED' })
  } finally { if (method.bookId === selected) method.loading = false }
}
async function openMethod() {
  method.books = (await http.get<Row[]>('/org/books')).filter(book => book.status === 'ACTIVE')
  method.bookId = method.books.length === 1 ? method.books[0]!.id : undefined
  method.visible = true
  await readMethod()
}
async function saveMethod() {
  if (method.saving) return
  if (!method.bookId || !method.effectiveFrom) return ElMessage.warning('请选择账套和生效日期')
  method.saving = true
  try {
    await http.putIdem('/cst/method?bookId=' + method.bookId, { method: method.value, effectiveFrom: method.effectiveFrom, version: method.version }, methodIntent)
    methodIntent.reset()
    ElMessage.success('计价方法已保存')
    method.visible = false
  } finally { method.saving = false }
}

const status = ref(String(route.query.status ?? ''))
const q = reactive<Row>({})
const rows = ref<Row[]>([])
const counts = ref<Record<string, number>>({})
const total = ref(0)
const pageNo = ref(1)
const size = ref(20)
const loading = ref(false)
const selection = ref<Row[]>([])
let listRequest = 0
const listContext = () => `${country.epoch}:${getCountryId()}:${getToken()}:${route.query.sourceId ?? ''}:${route.query.bookId ?? ''}`
const positiveId = (value: unknown) => /^[1-9]\d*$/.test(String(value)) && Number.isSafeInteger(Number(value)) ? Number(value) : undefined

const TAG: Record<string, 'success' | 'warning' | 'danger'> = { CONFIRMED: 'success', ESTIMATED: 'warning', PENDING_RATE: 'danger' }
const allCount = computed(() => Object.values(counts.value).reduce((s, n) => s + n, 0))

async function load() {
  const request = ++listRequest, scope = listContext(), source = route.query.sourceId
  const current = () => request === listRequest && scope === listContext()
  loading.value = true
  rows.value = []; total.value = 0; counts.value = {}; selection.value = []
  try {
    const book = positiveId(route.query.bookId), id = positiveId(source)
    if (source != null) { for (const key of Object.keys(q)) delete q[key]; status.value = '' }
    if (source != null && (!id || !book)) return
    const params = source != null ? { bookId: book } : { ...q, ...(book ? { bookId: book } : {}), status: status.value || undefined }
    const res = source != null
      ? { records: (await allRecords<Row>('/cst/inbound-costs', params)).filter(row => row.id === id && row.bookId === book), counts: {} as Record<string, number>, total: 0 }
      : await http.get<PageResult<Row> & { counts: Record<string, number> }>('/cst/inbound-costs', { ...params, page: pageNo.value, size: size.value })
    if (!current()) return
    rows.value = res.records.map(row => ({
      ...row,
      batchNo: row.batchNo ?? (row.batchId == null ? '—' : `#${row.batchId}`),
      productCode: row.productCode ?? (row.productId == null ? '—' : `#${row.productId}`),
      warehouseName: row.warehouseName ?? (row.warehouseId == null ? '—' : `#${row.warehouseId}`),
      poNo: row.poNo ?? row.sourceType ?? '—',
      receiptNo: row.receiptNo ?? (row.sourceLineId == null ? '—' : `#${row.sourceLineId}`),
      canAttemptConfirmation: row.status !== 'CONFIRMED',
    }))
    total.value = source != null ? rows.value.length : res.total
    counts.value = source != null ? rows.value.reduce<Record<string, number>>((all, row) => { all[row.status] = (all[row.status] ?? 0) + 1; return all }, {}) : res.counts ?? {}
  } catch (error) {
    if (current()) throw error
  } finally {
    if (current()) loading.value = false
  }
}
function search() {
  pageNo.value = 1
  load()
}
watch(status, () => { if (route.query.sourceId != null) { status.value = ''; return } search() })
watch(() => [route.query.sourceId, route.query.bookId, country.epoch, user.token], search)

async function confirmOne(c: Row) {
  if (actionBusy.value) return
  if (!confirmationDate.value) return ElMessage.warning('请明确成本确认日期')
  const bizDate = confirmationDate.value
  confirming.value = c.id
  try {
    try { await ElMessageBox.confirm(`确认批次 ${c.batchNo} 的入库成本？确认日期 ${bizDate}，单位成本 ${c.unitCost ?? '待补'} ${c.baseCurrency}；原入库日期与快照保留。`, '确认成本', { type: 'info' }) }
    catch { return }
    await http.postIdem(`/cst/inbound-costs/${c.id}/confirm`, { bizDate }, confirmIntent)
    ElMessage.success('已确认')
    await load()
  } finally { confirming.value = undefined }
}

const result = reactive({ visible: false, confirmed: 0, failed: [] as Row[] })
async function confirmBatch() {
  if (actionBusy.value || !selection.value.length) return
  if (!confirmationDate.value) return ElMessage.warning('请明确成本确认日期')
  const bizDate = confirmationDate.value
  batchConfirming.value = true
  try {
    const ids = [...new Set(selection.value.map((r) => r.id))].sort((a, b) => a - b)
    try { await ElMessageBox.confirm(`按确认日期 ${bizDate} 确认所选 ${ids.length} 条成本？原入库日期与快照保留。`, '批量确认成本', { type: 'info' }) }
    catch { return }
    const res = await http.postIdem<{ confirmed: number[]; failed: Row[] }>('/cst/inbound-costs/batch-confirm', { ids, bizDate }, batchIntent)
    if (res.failed.length) Object.assign(result, { visible: true, confirmed: res.confirmed.length, failed: res.failed })
    else ElMessage.success(`已确认 ${res.confirmed.length} 条`)
    await load()
  } finally { batchConfirming.value = false }
}

const canReadAssignment = computed(() => user.hasPerm('cst:cost:view') && ['READ', 'WRITE'].includes(user.fieldAccess('COST')))
const canReadBills = computed(() => user.hasPerm('ap:bill:view'))
const assignment = reactive({ visible: false, loading: false, saving: false, costId: undefined as number | undefined, data: null as Row | null, lines: [] as Row[] })
const assignmentIntent = createCommandIntent()
let assignmentRequest = 0, assignmentScope = ''
const assignmentContext = () => `${country.epoch}:${getCountryId()}:${getToken()}`
const canEditAssignment = computed(() => canReadAssignment.value && canReadBills.value && user.hasPerm('cst:cost:confirm') && user.fieldAccess('COST') === 'WRITE'
  && assignment.visible && !assignment.loading && !assignment.saving && assignment.data?.canEdit === true && !['FROZEN', 'LEGACY'].includes(assignment.data.status))
const ASSIGNMENT_STATUS: Record<string, string> = { UNASSIGNED: '未关联', DRAFT: '关联草稿', FROZEN: '已冻结', LEGACY: '历史已解释（只读）' }
const BASIS_STATUS: Record<string, string> = { WAITING: '等待账单依据', READY: '依据已就绪', INCOMPATIBLE: '依据不匹配', FROZEN: '依据已冻结', LEGACY: '历史已解释（只读）' }
function assignmentQty(value: number | string | null | undefined) {
  return value == null || value === '' ? '-' : new Intl.NumberFormat('zh-CN', { maximumFractionDigits: 6 }).format(Number(value))
}
function closeAssignment() {
  assignmentRequest++
  assignmentIntent.reset()
  Object.assign(assignment, { visible: false, loading: false, saving: false, costId: undefined, data: null, lines: [] })
}
function setAssignmentData(data: Row) {
  assignment.data = data
  assignment.lines = (data.lines ?? []).map((line: Row) => ({ billLineId: line.billLineId, baseQty: line.baseQty }))
}
async function openAssignment(row: Row) {
  if (!row.poId || !canReadAssignment.value) return
  closeAssignment()
  const request = ++assignmentRequest, scope = assignmentContext(), costId = row.id
  assignmentScope = scope
  Object.assign(assignment, { visible: true, loading: true, costId })
  try {
    const data = await http.get<Row>(`/ap/cost-assignments/${costId}`)
    if (request === assignmentRequest && scope === assignmentContext() && assignment.costId === costId && canReadAssignment.value) setAssignmentData(data)
  } finally {
    if (request === assignmentRequest && scope === assignmentContext()) assignment.loading = false
  }
}
function addAssignmentLine(candidate: Row) {
  if (!canEditAssignment.value || assignmentScope !== assignmentContext()) return
  const current = assignment.data?.candidates?.find((line: Row) => line.billLineId === candidate.billLineId)
  if (current?.compatible !== true || assignment.lines.some(line => line.billLineId === current.billLineId)) return
  assignment.lines.push({ billLineId: current.billLineId, baseQty: undefined })
}
function clearAssignmentLines() {
  if (canEditAssignment.value && assignmentScope === assignmentContext()) assignment.lines = []
}
function removeAssignmentLine(index: number) {
  if (canEditAssignment.value && assignmentScope === assignmentContext()) assignment.lines.splice(index, 1)
}
function assignmentBill(line: Row) {
  return assignment.data?.candidates?.find((candidate: Row) => candidate.billLineId === line.billLineId)
    ?? assignment.data?.lines?.find((existing: Row) => existing.billLineId === line.billLineId) ?? line
}
async function saveAssignment() {
  if (!canEditAssignment.value || assignmentScope !== assignmentContext() || assignment.costId == null || !assignment.data) return
  const lines = assignment.lines.map(line => ({ billLineId: line.billLineId, baseQty: line.baseQty }))
  if (lines.some(line => !Number.isSafeInteger(line.billLineId) || !Number.isFinite(line.baseQty) || line.baseQty <= 0)
    || new Set(lines.map(line => line.billLineId)).size !== lines.length) return ElMessage.warning('请为每个已选账单行明确填写正数基础数量')
  const body = { version: assignment.data.version, lines }, costId = assignment.costId, request = assignmentRequest, scope = assignmentScope
  assignment.saving = true
  try {
    const data = await http.putIdem<Row>(`/ap/cost-assignments/${costId}`, body, assignmentIntent)
    if (request !== assignmentRequest || scope !== assignmentContext() || assignment.costId !== costId || !assignment.visible) return
    setAssignmentData(data)
    ElMessage.success('账单依据已保存；成本确认与凭证生成请分别操作')
  } finally {
    if (request === assignmentRequest && scope === assignmentContext()) assignment.saving = false
  }
}
watch(() => [country.epoch, user.token], closeAssignment)

onMounted(load)
</script>

<template>
  <div class="page">
    <div class="page-card">
      <div class="page-title">
        <h2>入库成本</h2>
        <div class="toolbar">
          <el-button v-if="user.hasPerm('cst:method:config')" @click="openMethod">计价方法</el-button>
          <span v-if="canConfirm">确认日期</span><el-date-picker v-if="canConfirm" v-model="confirmationDate" type="date" value-format="YYYY-MM-DD" aria-label="确认日期" :disabled="actionBusy" style="width: 150px" />
          <el-button v-if="canConfirm" type="primary" :loading="batchConfirming" :disabled="!selection.length || actionBusy" @click="confirmBatch">批量确认（{{ selection.length }}）</el-button>
        </div>
      </div>
      <el-tabs v-model="status">
        <el-tab-pane :label="`全部（${allCount}）`" name="" />
        <el-tab-pane v-for="s in COST_STATUS" :key="String(s.value)" :label="`${s.label}（${counts[String(s.value)] ?? 0}）`" :name="String(s.value)" />
      </el-tabs>
      <el-form inline @submit.prevent="search">
        <el-form-item label="批次 / 单号"><el-input v-model="q.keyword" clearable style="width: 180px" /></el-form-item>
        <el-form-item label="商品"><div style="width: 200px"><FieldInput v-model="q.productId" :field="{ prop: 'productId', label: '商品', type: 'select', options: PRODUCT_SOURCE }" clearable /></div></el-form-item>
        <el-form-item label="仓库"><div style="width: 160px"><FieldInput v-model="q.warehouseId" :field="{ prop: 'warehouseId', label: '仓库', type: 'select', options: MX_WAREHOUSE_SOURCE }" clearable /></div></el-form-item>
        <el-form-item label="供应商"><div style="width: 180px"><FieldInput v-model="q.supplierId" :field="{ prop: 'supplierId', label: '供应商', type: 'select', options: SUPPLIER_SOURCE }" clearable /></div></el-form-item>
        <el-form-item label="入库日期">
          <el-date-picker v-model="q.dateFrom" type="date" value-format="YYYY-MM-DD" placeholder="起" style="width: 130px" />
          <span class="sep">~</span>
          <el-date-picker v-model="q.dateTo" type="date" value-format="YYYY-MM-DD" placeholder="止" style="width: 130px" />
        </el-form-item>
        <el-form-item><el-button type="primary" native-type="submit">查询</el-button></el-form-item>
      </el-form>
      <p class="muted">
        确认日期决定本次确认事实所属期间，保留原入库日期与既有快照。实收时冻结采购原价、入库日汇率与成本来源。缺汇率或原成本时保留待补状态，历史快照保持原值；出库保存实际消耗和计价池组成。成本调整与费用分摊使用原登记入口处理。
      </p>
      <p v-if="route.query.sourceId != null" class="muted">来源定位 #{{ route.query.sourceId }} · 账套 #{{ route.query.bookId ?? '未指定' }}；只显示当前授权范围内匹配记录。</p>

      <div class="table-scroll">
        <el-table v-loading="loading" :data="rows" border stripe row-key="id" @selection-change="(v: Row[]) => (selection = v)">
          <el-table-column v-if="canConfirm" type="selection" width="44" fixed="left" :selectable="(r: Row) => r.status !== 'CONFIRMED'" />
          <el-table-column label="批次" width="180" fixed="left">
            <template #default="{ row }"><el-link type="primary" @click="trace?.open(row.batchId)">{{ row.batchNo }}</el-link></template>
          </el-table-column>
          <el-table-column label="商品" min-width="170"><template #default="{ row }"><ProductCell :code="row.productCode" :name="row.productName" /></template></el-table-column>
          <el-table-column prop="warehouseName" label="仓库" width="120" />
          <el-table-column label="来源" min-width="200">
            <template #default="{ row }">
              <div class="mono">{{ row.poNo }}</div>
              <div class="muted">{{ row.supplierName }} · <span class="mono">{{ row.receiptNo }}</span></div>
            </template>
          </el-table-column>
          <el-table-column label="入库日" width="105"><template #default="{ row }">{{ formatDate(row.bizDate) }}</template></el-table-column>
          <el-table-column prop="qty" label="数量" width="70" align="right" />
          <el-table-column label="原币单价 / 金额" width="160" align="right">
            <template #default="{ row }">
              <MoneyText :value="row.srcUnitPrice" :currency="row.srcCurrency" />
              <div class="muted"><MoneyText :value="row.srcAmount" :currency="row.srcCurrency" /></div>
            </template>
          </el-table-column>
          <el-table-column label="汇率" width="140" align="right">
            <template #default="{ row }">
              <template v-if="row.rate != null">
                <span class="mono">{{ row.rate }}</span>
                <div class="muted">{{ row.srcCurrency }}→{{ row.baseCurrency }} · {{ row.rateDate }}</div>
              </template>
              <template v-else>
                <el-tag type="danger" size="small">缺 {{ row.srcCurrency }}→{{ row.baseCurrency }}</el-tag>
                <el-button v-if="canRate" link type="primary" size="small" @click="router.push('/master/exchange-rates')">去补录</el-button>
              </template>
            </template>
          </el-table-column>
          <el-table-column label="本位币采购额" width="140" align="right"><template #default="{ row }"><MoneyText :value="row.basePurchaseAmount" :currency="row.baseCurrency" /></template></el-table-column>
          <el-table-column label="已分摊费用" width="120" align="right"><template #default="{ row }"><MoneyText :value="row.allocFeeAmount" :currency="row.baseCurrency" /></template></el-table-column>
          <el-table-column label="单位成本" width="130" align="right"><template #default="{ row }"><b><MoneyText :value="row.unitCost" :currency="row.baseCurrency" /></b></template></el-table-column>
          <el-table-column label="状态" width="150">
            <template #default="{ row }">
              <el-tag :type="TAG[row.status]" size="small">{{ optionText(COST_STATUS, row.status) }}</el-tag>
              <div v-if="row.confirmedByName" class="muted">{{ row.confirmedByName }} · <DateTimeText :value="row.confirmedAt" /></div>
            </template>
          </el-table-column>
          <el-table-column label="操作" width="190" fixed="right">
            <template #default="{ row }">
              <el-button link type="primary" @click="trace?.open(row.batchId)">追溯</el-button>
              <el-button v-if="row.poId && canReadAssignment" link type="primary" @click="openAssignment(row)">账单依据</el-button>
              <el-tooltip v-if="canConfirm && row.canAttemptConfirmation" :disabled="row.status !== 'PENDING_RATE'" content="待补汇率；确认时按原入库日期核验，补录后可重试">
                <span><el-button link type="success" :loading="confirming === row.id" :disabled="actionBusy" @click="confirmOne(row)">确认</el-button></span>
              </el-tooltip>
            </template>
          </el-table-column>
        </el-table>
      </div>
      <el-pagination
        v-model:current-page="pageNo"
        v-model:page-size="size"
        class="pager"
        :total="total"
        :page-sizes="[20, 50, 100]"
        layout="total, sizes, prev, pager, next"
        @current-change="load"
        @size-change="search"
      />
    </div>

    <el-dialog v-model="assignment.visible" title="采购成本账单依据" width="1100px" append-to-body @close="closeAssignment">
      <el-alert title="暂缺账单依据不阻止成本确认，自动凭证等待关联" type="info" :closable="false" show-icon />
      <div v-loading="assignment.loading">
        <template v-if="assignment.data">
          <el-descriptions :column="3" border class="assignment-summary">
            <el-descriptions-item label="成本来源">{{ assignment.data.sourceNo || `#${assignment.costId}` }}</el-descriptions-item>
            <el-descriptions-item label="来源基础数量">{{ assignmentQty(assignment.data.qty) }} {{ assignment.data.baseUnit || '（基础单位）' }}</el-descriptions-item>
            <el-descriptions-item label="关联状态">{{ ASSIGNMENT_STATUS[assignment.data.status] || assignment.data.status }}</el-descriptions-item>
            <el-descriptions-item label="原币 / 本位币">{{ assignment.data.srcCurrency || '—' }} / {{ assignment.data.baseCurrency || '—' }}</el-descriptions-item>
            <el-descriptions-item label="冻结汇率">{{ assignment.data.rate ?? '—' }}</el-descriptions-item>
            <el-descriptions-item label="本位币采购额"><MoneyText v-if="assignment.data.baseCurrency" :value="assignment.data.basePurchaseAmount" :currency="assignment.data.baseCurrency" /><span v-else>—</span></el-descriptions-item>
            <el-descriptions-item label="已关联基础数量">{{ assignmentQty(assignment.data.assignedQty) }}</el-descriptions-item>
            <el-descriptions-item label="未关联基础数量">{{ assignmentQty(assignment.data.remainingQty) }}</el-descriptions-item>
            <el-descriptions-item label="依据状态">{{ BASIS_STATUS[assignment.data.basisStatus] || assignment.data.basisStatus }}</el-descriptions-item>
          </el-descriptions>
          <p v-if="assignment.data.basisReason" class="muted">{{ assignment.data.basisReason }}</p>
          <template v-if="canReadBills">
            <h3>已保存的账单依据</h3>
            <el-table :data="assignment.data.lines || []" border size="small" empty-text="尚未保存账单依据">
              <el-table-column prop="docNo" label="账单" min-width="160" />
              <el-table-column prop="billLineId" label="账单行" width="90" />
              <el-table-column label="本次基础数量" width="130"><template #default="{ row }">{{ assignmentQty(row.baseQty) }}</template></el-table-column>
              <el-table-column label="本次冻结记账本金" min-width="180"><template #default="{ row }"><span v-if="row.principalAmount == null">{{ assignment.data.status === 'LEGACY' ? '历史依据未知' : '待生成时冻结' }}</span><MoneyText v-else-if="row.baseCurrency" :value="row.principalAmount" :currency="row.baseCurrency" /><span v-else>—</span></template></el-table-column>
            </el-table>
            <template v-if="canEditAssignment || assignment.saving">
              <h3>明确选择已确认的账单行</h3>
              <p class="muted">所有数量均为基础数量，不转换原账单单位。保存关联不会确认成本或生成凭证；清空选择后保存可解除未冻结关联。金额与可用数量由服务端核验。</p>
              <el-table :data="assignment.data.candidates || []" border size="small" empty-text="没有当前可见的已确认账单行">
                <el-table-column label="账单 / 行" min-width="165"><template #default="{ row }">{{ row.docNo }} / #{{ row.billLineId }}</template></el-table-column>
                <el-table-column label="账单基础数量 / 可用" width="160"><template #default="{ row }">{{ assignmentQty(row.billQty) }} / {{ assignmentQty(row.availableQty) }}</template></el-table-column>
                <el-table-column label="账单行原币金额" width="150"><template #default="{ row }"><MoneyText v-if="row.currency" :value="row.lineAmount" :currency="row.currency" /><span v-else>—</span></template></el-table-column>
                <el-table-column label="账单行记账本金" width="160"><template #default="{ row }"><MoneyText v-if="row.baseCurrency" :value="row.principalAmount" :currency="row.baseCurrency" /><span v-else>—</span></template></el-table-column>
                <el-table-column label="整单原币 / 冻结本位" min-width="180"><template #default="{ row }"><MoneyText v-if="row.currency" :value="row.billAmount" :currency="row.currency" /><span v-else>—</span> / <MoneyText v-if="row.baseCurrency" :value="row.billBaseAmount" :currency="row.baseCurrency" /><span v-else>—</span></template></el-table-column>
                <el-table-column label="冻结汇率 / 匹配" min-width="180"><template #default="{ row }">{{ row.rate ?? '—' }}<div class="muted">{{ row.compatible ? '匹配' : row.basisReason || '依据不匹配' }}</div></template></el-table-column>
                <el-table-column label="选择" width="80"><template #default="{ row }"><el-button link type="primary" :disabled="!canEditAssignment || !row.compatible || assignment.lines.some(line => line.billLineId === row.billLineId)" @click="addAssignmentLine(row)">选择</el-button></template></el-table-column>
              </el-table>
              <h3>本次关联选择</h3>
              <el-table :data="assignment.lines" border size="small" empty-text="请明确选择账单行；不会自动选择唯一候选">
                <el-table-column label="账单 / 行" min-width="180"><template #default="{ row }">{{ assignmentBill(row).docNo || '—' }} / #{{ row.billLineId }}</template></el-table-column>
                <el-table-column label="本次基础数量" min-width="180"><template #default="{ row }"><el-input-number v-model="row.baseQty" :min="0.000001" :precision="6" :disabled="!canEditAssignment" :aria-label="`账单行${row.billLineId}本次基础数量`" /></template></el-table-column>
                <el-table-column label="移除" width="80"><template #default="{ $index }"><el-button link type="danger" :disabled="!canEditAssignment" @click="removeAssignmentLine($index)">移除</el-button></template></el-table-column>
              </el-table>
            </template>
          </template>
          <p v-else class="muted">没有查看应付账单的权限，仅显示成本来源及依据状态。</p>
          <p v-if="['FROZEN', 'LEGACY'].includes(assignment.data.status)" class="muted">该成本已解释记账，账单依据只读。</p>
        </template>
      </div>
      <template #footer>
        <el-button :disabled="assignment.saving" @click="closeAssignment">关闭</el-button>
        <el-button v-if="canEditAssignment || assignment.saving" :disabled="!canEditAssignment" @click="clearAssignmentLines">清空本次选择</el-button>
        <el-button v-if="canEditAssignment || assignment.saving" type="primary" :loading="assignment.saving" :disabled="!canEditAssignment" @click="saveAssignment">保存账单依据</el-button>
      </template>
    </el-dialog>

    <el-dialog v-model="result.visible" title="批量确认结果" width="560px" append-to-body>
      <p>成功 <b>{{ result.confirmed }}</b> 条，失败 <b class="bad">{{ result.failed.length }}</b> 条：</p>
      <el-table :data="result.failed" border size="small">
        <el-table-column prop="batchNo" label="批次" width="180" />
        <el-table-column prop="reason" label="原因" min-width="240" />
      </el-table>
      <template #footer>
        <el-button v-if="canRate" @click="router.push('/master/exchange-rates')">去补录汇率</el-button>
        <el-button type="primary" @click="result.visible = false">知道了</el-button>
      </template>
    </el-dialog>
    <el-dialog v-model="method.visible" title="账套计价方法" width="500px" append-to-body>
      <el-form v-loading="method.loading" label-width="100px" :disabled="method.saving">
        <el-form-item label="账套" required><el-select v-model="method.bookId" @change="readMethod"><el-option v-for="book in method.books" :key="book.id" :label="book.name" :value="book.id" /></el-select></el-form-item>
        <el-form-item label="计价方法" required><el-select v-model="method.value"><el-option label="先进先出" value="FIFO" /><el-option label="指定批次" value="BATCH_SPECIFIC" /><el-option label="移动平均" value="MOVING_AVG" /></el-select></el-form-item>
        <el-form-item label="生效日期" required><el-date-picker v-model="method.effectiveFrom" type="date" value-format="YYYY-MM-DD" /></el-form-item>
      </el-form>
      <p class="muted">首次实收前配置。账套已有成本事实后，计价方法保持锁定。</p>
      <template #footer><el-button @click="method.visible = false">取消</el-button><el-button type="primary" :loading="method.saving" :disabled="method.loading || !method.bookId" @click="saveMethod">保存</el-button></template>
    </el-dialog>
    <CostTraceDrawer ref="trace" />
  </div>
</template>

<style scoped>
.sep {
  margin: 0 6px;
}

.pager {
  margin-top: 12px;
  justify-content: flex-end;
}

.bad {
  color: var(--el-color-danger);
}
.assignment-summary { margin-top: 14px; }
</style>
