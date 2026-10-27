<script setup lang="ts">
import { feedbackMessage } from '@/api/error-feedback'
import { canEditSalesOrder, canSubmitSalesOrder } from './salesOrderActions'
import { reactive, ref, watch, toRaw } from 'vue'
import { useRoute, useRouter } from 'vue-router'
import { ElMessage } from 'element-plus'
import { http, createCommandIntent } from '@/api/http'
import { allRecords } from '@/api/pagination'
import { useCountryStore } from '@/stores/country'
import { todayIn } from '@/utils/format'
import { useUserStore } from '@/stores/user'
import CrudPage from '@/components/crud/CrudPage.vue'
import MoneyText from '@/components/MoneyText.vue'
import StatusTag from '@/components/StatusTag.vue'
import type { ColumnDef, CrudPageExpose, FieldDef } from '@/components/crud/types'
import { confirmAction } from '@/utils/action'
import { APPROVAL_STATUS, CUSTOMER_SOURCE, FULFILLMENT_STATUS, PAYMENT_TYPES, PAY_STATUS } from '@/modules/shared/bizOptions'

const supplyCommandIntent = createCommandIntent()


type Row = Record<string, any> // eslint-disable-line @typescript-eslint/no-explicit-any

const router = useRouter()
const route = useRoute()
const user = useUserStore(), country = useCountryStore()
const books = ref<Row[]>([])
const booksLoading = ref(false)
let bookRequest = 0, createRequest = 0
const page = ref<CrudPageExpose>()
const options = reactive({ customers: [] as Row[], products: [] as Row[], warehouses: [] as Row[], categories: [] as Row[] })
const entry = reactive({ step: 1, keyword: '', categoryId: undefined as number | undefined, onlyFilled: false, quantities: {} as Record<number, string>, error: '', errorProductId: undefined as number | undefined, checking: false })
const form = reactive({ editingId: undefined as number | undefined, version: 0, bizDate: '', bookId: undefined as number | undefined, orderDate: '', visible: false, saving: false, customerId: undefined as number | undefined, paymentType: 'CASH', remark: '', lines: [] as Row[] })
const original = ref<Row | null>(null)
let formScope = ''
const scope = () => JSON.stringify([country.currentId, country.epoch, user.token])
const clone = (value: Row) => structuredClone(toRaw(value))
const priceRequests = new WeakMap<object, number>()
const lineKey = (line: Row) => JSON.stringify([line.id, line.productId, line.unit, Number(line.qty), line.warehouseId, line.allocs?.map((a: Row) => [a.id, a.warehouseId, Number(a.allocQty)]), !!line.manual, line.manual ? Number(line.price) : null])
const delivered = () => original.value?.lines.some((line: Row) => Number(line.outboundQty) > 0)

const columns: ColumnDef[] = [
  { prop: 'docNo', label: '订单号', width: 185, fixed: 'left' },
  { prop: 'customerName', label: '客户', minWidth: 160 },
  { prop: 'paymentType', label: '付款', width: 80 },
  { prop: 'totalAmount', label: '金额', type: 'money', currencyProp: 'currency', width: 130 },
  { prop: 'approvalStatus', label: '审批', type: 'status', width: 100 },
  { prop: 'fulfillmentStatus', label: '履约', type: 'status', width: 110 },
  { prop: 'paymentStatus', label: '付款状态', type: 'status', width: 100 },
  { prop: 'openQty', label: '未出库', type: 'qty', width: 90 },
]
const searchFields: FieldDef[] = [
  { prop: 'keyword', label: '单号 / 客户' },
  { prop: 'customerId', label: '客户', type: 'select', options: CUSTOMER_SOURCE },
  { prop: 'paymentType', label: '付款', type: 'select', options: PAYMENT_TYPES },
  { prop: 'approvalStatus', label: '审批', type: 'select', options: APPROVAL_STATUS },
  { prop: 'fulfillmentStatus', label: '履约', type: 'select', options: FULFILLMENT_STATUS },
  { prop: 'paymentStatus', label: '付款状态', type: 'select', options: PAY_STATUS },
]

const selectedWarehouses = () => [...new Set<number>(form.lines.flatMap(line => line.allocs?.length > 1 ? line.allocs.map((a: Row) => Number(a.warehouseId)) : [Number(line.warehouseId)]).filter(id => Number.isSafeInteger(id) && id > 0))].sort((a, b) => a - b)

async function loadBooksForWarehouses() {
  const request = ++bookRequest, epoch = country.epoch, countryId = country.currentId, token = user.token, selected = form.bookId
  const current = () => request === bookRequest && epoch === country.epoch && countryId === country.currentId && token === user.token
  const warehouseIds = selectedWarehouses()
  books.value = []
  form.bookId = undefined
  booksLoading.value = true
  try {
    const candidates = warehouseIds.length
      ? await Promise.all(warehouseIds.map(warehouseId => http.get<Row[]>('/org/books', { warehouseId })))
      : [await http.get<Row[]>('/org/books')]
    if (!current()) return
    books.value = candidates[0].filter(book => candidates.every(rows => rows.some(row => row.id === book.id)))
    form.bookId = books.value.some(book => book.id === selected) ? selected : books.value.length === 1 ? books.value[0].id : undefined
  } catch {
    // HTTP 已显示错误；保留空候选，禁止沿用上一个仓库的账套。
  } finally {
    if (request === bookRequest) booksLoading.value = false
  }
}

watch(() => selectedWarehouses().join(','), () => {
  if (form.visible) void loadBooksForWarehouses()
}, { flush: 'sync' })

async function openCreate() {
  const request = ++createRequest, epoch = country.epoch, countryId = country.currentId, token = user.token
  supplyCommandIntent.reset()
  form.visible = false
  form.saving = false
  original.value = null
  formScope = scope()
  Object.assign(form, { editingId: undefined, version: 0, bizDate: '', bookId: undefined, orderDate: todayIn(country.timezone), customerId: undefined, paymentType: 'CASH', remark: '', lines: [{ productId: undefined, qty: 1, warehouseId: undefined, price: undefined }] })
  const [, customers, products, warehouses, categories] = await Promise.all([
    loadBooksForWarehouses(),
    allRecords<Row>('/md/customers', { status: 'ENABLED' }),
    allRecords<Row>('/md/country-skus', { enabled: 'true' }),
    allRecords<Row>('/org/warehouses', { status: 'ENABLED' }),
    allRecords<Row>('/md/categories'),
  ])
  if (request !== createRequest || epoch !== country.epoch || countryId !== country.currentId || token !== user.token) return
  options.customers = customers
  options.products = products
  options.warehouses = warehouses
  options.categories = categories
  Object.assign(entry, { step: 1, keyword: '', categoryId: undefined, onlyFilled: false, quantities: {}, error: '', errorProductId: undefined, checking: false })
  form.visible = true
}

const validQuantity = (value: unknown) => /^\d+(\.\d{1,4})?$/.test(String(value)) && Number.isFinite(Number(value)) && Number(value) <= 999999999999
function catalogRows() {
  const keyword = entry.keyword.trim().toLocaleLowerCase()
  return options.products.filter(p => p.status !== 'DISABLED' && (!keyword || [p.productCode, p.name, p.label, p.spec].some(value => typeof value === 'string' && value.toLocaleLowerCase().includes(keyword))) && (!entry.categoryId || p.categoryId === entry.categoryId) && (!entry.onlyFilled || validQuantity(entry.quantities[p.productId]) && Number(entry.quantities[p.productId]) > 0))
}
function entryError(message: string, field: string, productId?: number) {
  entry.error = message; entry.errorProductId = productId
  ElMessage.warning(message)
  if (typeof document !== 'undefined') requestAnimationFrame(() => {
    const control = document.querySelector<HTMLElement>(`.sales-entry [data-entry-field="${field}"]${productId ? `[data-product="${productId}"]` : ''}`)
    const input = control?.querySelector<HTMLElement>('input,textarea') ?? control
    input?.focus(); input?.scrollIntoView({ block: 'nearest', inline: 'nearest' })
  })
  return false
}
async function validateCreate() {
  entry.error = ''
  if (!form.customerId) return entryError('请选择客户', 'customer')
  if (booksLoading.value) return entryError('正在加载发货仓对应账套，请稍后重试', 'book')
  if (!form.bookId || !books.value.some(book => book.id === form.bookId)) return entryError('请选择发货仓对应的有效账套', 'book')
  if (!form.orderDate) return entryError('请填写业务日期', 'date')
  if (!form.lines.length) return entryError('请至少为一种商品填写数量', 'qty')
  for (const line of form.lines) {
    if (line.manual && !user.hasPerm('sal:order:manual-price')) return entryError('当前账号没有人工改价权限', 'price', line.productId)
    const product = options.products.find(p => p.productId === line.productId && p.status !== 'DISABLED')
    if (!product || !validQuantity(line.qty) || Number(line.qty) <= 0) return entryError('请填写大于 0 的数量，最多 4 位小数', 'qty', line.productId)
    if (!product.baseUnit) return entryError('商品未配置基础单位，请先维护商品资料', 'qty', line.productId)
    line.unit = product.baseUnit
    if (!options.warehouses.some(w => w.id === line.warehouseId)) return entryError('请选择有效发货仓', 'warehouse', line.productId)
    if (line.manual && (typeof line.price !== 'number' || !Number.isFinite(line.price) || line.price < 0)) return entryError('请填写人工成交价；未知价格不能按零保存', 'price', line.productId)
  }
  const request = createRequest, context = scope()
  const reviewKey = () => JSON.stringify([form.bookId, form.customerId, form.orderDate, form.paymentType, form.lines.map(lineKey)])
  const reviewed = reviewKey()
  await Promise.all(form.lines.map(line => resolve(line)))
  if (request !== createRequest || context !== scope() || !form.visible) return false
  if (reviewed !== reviewKey()) return entryError('复核信息已变化，请重新确认数量、仓库和成交价', 'qty')
  const unknown = form.lines.find(line => !line.manual && (line.priceError || typeof line.price !== 'number' || !Number.isFinite(line.price) || line.price < 0))
  if (unknown) return entryError(unknown.priceError || '未能匹配成交价，请重试或由有权限的人员填写', 'price', unknown.productId)
  return true
}
async function nextEntry() {
  if (entry.checking) return
  entry.error = ''; entry.errorProductId = undefined
  if (entry.step === 1) {
    const invalid = options.products.find(p => entry.quantities[p.productId]?.trim() && !validQuantity(entry.quantities[p.productId]))
    if (invalid) { entry.keyword = ''; entry.categoryId = undefined; entry.onlyFilled = false; return entryError('请填写有效数量，最多 4 位小数', 'qty', invalid.productId) }
    const selected = options.products.filter(p => p.status !== 'DISABLED' && Number(entry.quantities[p.productId]) > 0)
    if (!selected.length) return entryError('请至少为一种商品填写数量', 'qty')
    form.lines = selected.map(p => ({ ...form.lines.find(line => line.productId === p.productId), productId: p.productId, unit: p.baseUnit, qty: Number(entry.quantities[p.productId]) }))
    entry.step = 2
  } else {
    const request = createRequest
    entry.checking = true
    try { if (await validateCreate()) entry.step = 3 } finally { if (request === createRequest) entry.checking = false }
  }
}
function backEntry() {
  entry.error = ''
  if (entry.step === 2) for (const line of form.lines) entry.quantities[line.productId] = line.qty == null ? '' : String(line.qty)
  entry.step = Math.max(1, entry.step - 1)
}
function removeEntryLine(index: number) {
  const line = form.lines[index]
  if (line?.productId) entry.quantities[line.productId] = ''
  form.lines.splice(index, 1)
}

async function openEdit(id: number) {
  if (!user.hasPerm('sal:order:edit')) return
  const request = ++createRequest, context = scope()
  form.visible = false
  form.saving = false
  original.value = null
  const [order, customers, products, warehouses] = await Promise.all([
    http.get<Row>(`/sal/orders/${id}`),
    allRecords<Row>('/md/customers', { status: 'ENABLED' }),
    allRecords<Row>('/md/country-skus', { enabled: 'true' }),
    allRecords<Row>('/org/warehouses', { status: 'ENABLED' }),
  ])
  if (request !== createRequest || context !== scope()) return
  entry.error = ''; entry.checking = false
  if (Number(order.id) !== id || order.totalQty == null || !canEditSalesOrder(order)) return ElMessage.warning('当前订单不能修改；审批中请先撤回，部分可见订单需由完整授权人员处理')
  const lines = order.lines.map((line: Row) => ({ ...clone(line), warehouseId: line.allocs?.length === 1 ? line.allocs[0].warehouseId : undefined, manual: false }))
  Object.assign(form, { editingId: id, version: order.version, bizDate: todayIn(country.timezone), bookId: order.bookId, orderDate: order.orderDate, customerId: order.customerId, paymentType: order.paymentType, remark: order.remark ?? '', lines })
  original.value = { ...clone(order), lines: clone({ lines }).lines }
  formScope = context
  options.customers = customers; options.products = products; options.warehouses = warehouses
  await loadBooksForWarehouses()
  if (request !== createRequest || context !== scope()) return
  // 原账套不可切换；候选仅用于验证实际分仓仍在当前授权下。
  if (!books.value.some(book => book.id === order.bookId)) return ElMessage.warning('当前分仓没有原账套的有效授权')
  form.bookId = order.bookId
  form.visible = true
}

async function resolve(line: Row, _force = false) {
  if (!form.customerId || !line.productId || !line.qty) return
  const old = original.value?.lines.find((item: Row) => item.id === line.id)
  if (old && form.customerId === original.value?.customerId && line.productId === old.productId && line.unit === old.unit) {
    priceRequests.set(line, (priceRequests.get(line) ?? 0) + 1)
    line.stdPrice = old.stdPrice; line.priceSource = old.priceSource
    line.priceError = ''
    if (!line.manual) line.price = old.price
    return
  }
  const request = (priceRequests.get(line) ?? 0) + 1, context = scope()
  priceRequests.set(line, request)
  line.priceError = ''
  const customerId = form.customerId, productId = line.productId, qty = line.qty, date = form.orderDate
  const current = () => context === scope() && priceRequests.get(line) === request && form.lines.includes(line) && form.customerId === customerId && line.productId === productId && line.qty === qty && form.orderDate === date
  try {
    const hit = await http.get<Row>('/sal/prices/resolve', { customerId, productId, qty, date, unit: line.unit || options.products.find(p => p.productId === productId)?.baseUnit || 'PCS' })
    if (!current()) return
    line.stdPrice = hit.price
    if (!line.manual) line.price = hit.price
    line.priceSource = hit.priceSource
  } catch (error) {
    if (!current()) return
    line.stdPrice = null
    if (!line.manual) line.price = undefined
    line.priceSource = ''
    line.priceError = feedbackMessage(error, "读取价格失败，请重试")
  }
}

async function save(submit: boolean) {
  if (form.saving || entry.checking) return
  if (!form.visible || formScope !== scope()) return ElMessage.warning('国家或登录状态已切换，请重新打开表单')
  if (!form.editingId) {
    const request = createRequest
    entry.checking = true
    try {
      if (!await validateCreate()) { if (request === createRequest && form.visible) entry.step = 2; return }
    } finally { if (request === createRequest) entry.checking = false }
  }
  if (booksLoading.value) return ElMessage.warning('正在加载发货仓对应账套，请稍后重试')
  if (!form.bookId || !books.value.some(book => book.id === form.bookId)) return ElMessage.warning('请选择账套')
  if (!form.customerId) return ElMessage.warning('请选择客户')
  if (form.lines.some((line) => line.productId && line.manual && (typeof line.price !== 'number' || !Number.isFinite(line.price)))) return ElMessage.warning('请填写人工成交价；未知价格不能按零保存')
  if (form.editingId && (!original.value || !form.bizDate)) return ElMessage.warning('请填写修改业务日期')
  if (form.editingId && form.bookId !== original.value?.bookId) return ElMessage.warning('不能切换原订单账套')
  const request = createRequest, editingId = form.editingId, context = formScope
  const current = () => request === createRequest && editingId === form.editingId && context === scope()
  form.saving = true
  try {
    if (form.editingId && original.value) {
      const body: Row = { version: form.version, bizDate: form.bizDate }
      for (const key of ['customerId', 'paymentType', 'remark'] as const) if (form[key] !== (original.value[key] ?? '')) body[key] = form[key]
      const changedLines = JSON.stringify(form.lines.map(lineKey)) !== JSON.stringify(original.value.lines.map(lineKey))
      if (changedLines || form.customerId !== original.value.customerId) body.lines = form.lines.map(line => ({
        ...(line.id ? { id: line.id } : {}), productId: line.productId, qty: line.qty, unit: line.unit || options.products.find(p => p.productId === line.productId)?.baseUnit || 'PCS',
        ...(line.allocs?.length > 1 ? { allocs: line.allocs.map((a: Row) => ({ id: a.id, warehouseId: a.warehouseId, allocQty: Number(a.allocQty) })) } : { warehouseId: line.warehouseId }),
        ...(line.manual ? { price: line.price, manualPriceFlag: true } : {}),
      }))
      if (Object.keys(body).length === 2) return ElMessage.warning('订单内容没有变化')
      const id = form.editingId
      await http.put(`/sal/orders/${id}`, body)
      if (current() && form.visible) { form.visible = false; ElMessage.success('已保存修改，原审批失效，请重新提交审核'); router.push(`/sales/orders/${id}`) }
      return
    }
    const order = await http.postIdem<Row>('/sal/orders', {
      bookId: form.bookId, orderDate: form.orderDate, customerId: form.customerId, paymentType: form.paymentType, remark: form.remark, submit,
      lines: form.lines.map((l) => ({
        productId: l.productId, qty: l.qty, unit: l.unit, warehouseId: l.warehouseId,
        price: l.manual ? l.price : undefined, manualPriceFlag: !!l.manual,
      })),
    }, supplyCommandIntent)
    if (!current() || !form.visible) return
    ElMessage.success(submit ? (order.approvalMessage || '已提交') : '已保存草稿')
    form.visible = false
    router.push(`/sales/orders/${order.id}`)
  } finally {
    if (current()) form.saving = false
  }
}

watch(() => route.query.edit, value => {
  const id = Number(value)
  if (Number.isSafeInteger(id) && id > 0) void openEdit(id)
}, { immediate: true })
watch(scope, () => { ++createRequest; ++bookRequest; form.visible = false; form.saving = false; form.bookId = undefined; books.value = []; booksLoading.value = false }, { flush: 'sync' })

async function submit(row: Row) {
  if (row.totalQty == null || !canSubmitSalesOrder(row) || !user.hasPerm('sal:order:submit')) return ElMessage.warning('订单已停止供货或没有可提交的未交数量')
  const context = scope(), orderId = row.id
  await confirmAction(`提交 ${row.docNo}？`, () => {
    if (context !== scope() || !canSubmitSalesOrder(row)) throw new Error('订单已切换、关闭或不再允许提交')
    return http.postIdem(`/sal/orders/${orderId}/submit`, undefined, supplyCommandIntent)
  }, { success: '已提交' })
  page.value?.reload()
}
</script>

<template>
  <CrudPage ref="page" title="销售订单" resource="/sal/orders" :columns="columns" :search-fields="searchFields" :can-create="false" :can-toggle="false" audit-type="sales-order" :actions-width="180">
    <template #toolbar>
      <el-button v-if="user.hasPerm('sal:order:create')" type="primary" @click="openCreate"><el-icon><Plus /></el-icon>代客录单</el-button>
    </template>
    <template #header>
      <p class="muted">价格按客户专属价、等级价、基础价依次匹配，并在订单上留下快照。审批、履约、付款三种状态分开显示。</p>
    </template>
    <template #col-docNo="{ row }"><el-link type="primary" @click="router.push(`/sales/orders/${row.id}`)">{{ row.docNo }}</el-link></template>
    <template #col-paymentType="{ row }"><StatusTag :status="row.paymentType" /></template>
    <template #col-totalAmount="{ row }"><MoneyText :value="row.totalAmount" :currency="row.currency" /></template>
    <template #row-actions="{ row }">
      <el-button link type="primary" @click="router.push(`/sales/orders/${row.id}`)">查看</el-button>
      <el-button v-if="row.totalQty != null && canEditSalesOrder(row) && user.hasPerm('sal:order:edit')" link type="primary" @click="openEdit(row.id)">修改</el-button>
      <el-button v-if="row.totalQty != null && canSubmitSalesOrder(row) && user.hasPerm('sal:order:submit')" link type="success" @click="submit(row)">提交</el-button>
    </template>
  </CrudPage>

  <el-dialog v-model="form.visible" :title="form.editingId ? '修改销售订单' : '新建销售订单'" width="1180px" class="crud-dialog sales-entry" destroy-on-close>
    <el-steps v-if="!form.editingId" :active="entry.step - 1" align-center class="entry-steps"><el-step title="选择商品" /><el-step title="复核明细" /><el-step title="备注与提交" /></el-steps>
    <el-alert v-if="entry.error" :title="entry.error" type="error" :closable="false" show-icon class="entry-error" />
    <section v-if="!form.editingId && entry.step === 1">
      <div class="catalog-filters">
        <el-input v-model="entry.keyword" clearable placeholder="商品编码 / 名称 / 规格" aria-label="商品关键词" />
        <el-select v-model="entry.categoryId" clearable placeholder="全部分类" aria-label="商品分类"><el-option v-for="c in options.categories" :key="c.id" :value="c.id" :label="c.name" /></el-select>
        <el-select v-model="entry.onlyFilled" aria-label="商品范围"><el-option :value="false" label="全部商品" /><el-option :value="true" label="已填数量" /></el-select>
        <el-button @click="entry.keyword = ''; entry.categoryId = undefined; entry.onlyFilled = false">重置筛选</el-button>
      </div>
      <p class="muted">直接填写销售数量，大于 0 的商品进入复核；空白或 0 不加入。</p>
      <el-table :data="catalogRows()" row-key="productId" border max-height="440" class="catalog-table">
        <el-table-column label="商品" min-width="240"><template #default="{ row }"><b>{{ row.name || row.label }}</b><div class="muted">{{ row.productCode }}</div></template></el-table-column>
        <el-table-column prop="spec" label="规格" min-width="140" />
        <el-table-column label="分类" min-width="140"><template #default="{ row }">{{ options.categories.find(c => c.id === row.categoryId)?.name || '未分类' }}</template></el-table-column>
        <el-table-column prop="baseUnit" label="基础单位" width="110" />
        <el-table-column label="数量" width="150" align="right"><template #default="{ row }"><el-input v-model="entry.quantities[row.productId]" :data-product="row.productId" data-entry-field="qty" inputmode="decimal" placeholder="数量" :aria-label="`${row.name || row.label} 数量`" /></template></el-table-column>
      </el-table>
    </section>
    <el-form v-show="form.editingId || entry.step === 2" :disabled="form.saving || entry.checking" label-width="88px">
      <el-form-item label="账套" required><el-select v-model="form.bookId" data-entry-field="book" :loading="booksLoading" :disabled="booksLoading || !!form.editingId" placeholder="请选择账套"><el-option v-for="b in books" :key="b.id" :label="b.name + ' · ' + b.baseCurrency" :value="b.id" /></el-select><span class="muted">按发货仓匹配；多个仓库需共用同一账套</span></el-form-item>
      <el-form-item :label="form.editingId ? '原订单日期' : '业务日期'" required><el-date-picker v-model="form.orderDate" data-entry-field="date" :disabled="!!form.editingId" value-format="YYYY-MM-DD" @change="form.lines.forEach(line => resolve(line, true))" /></el-form-item>
      <el-form-item v-if="form.editingId" label="修改日期" required><el-date-picker v-model="form.bizDate" value-format="YYYY-MM-DD" /><span class="muted">修改后回到草稿，原审批失效，需要重新提交审核。</span></el-form-item>
      <el-form-item label="客户" required>
        <el-select v-model="form.customerId" data-entry-field="customer" :disabled="delivered()" filterable style="width: 100%" @change="form.lines.forEach(line => resolve(line, true))">
          <el-option v-for="c in options.customers" :key="c.id" :label="c.name" :value="c.id" />
        </el-select>
      </el-form-item>
      <el-form-item label="付款方式">
        <el-radio-group v-model="form.paymentType" :disabled="delivered()">
          <el-radio-button value="CASH">现款</el-radio-button>
          <el-radio-button value="CREDIT">赊销</el-radio-button>
        </el-radio-group>
      </el-form-item>
      <el-table :data="form.lines" size="small">
        <el-table-column label="商品" min-width="180">
          <template #default="{ row }"><el-select v-if="form.editingId" v-model="row.productId" :disabled="!!row.id" filterable @change="resolve(row)"><el-option v-for="p in options.products" :key="p.productId" :label="p.label || p.productCode" :value="p.productId" /></el-select><b v-else>{{ options.products.find(p => p.productId === row.productId)?.label }}</b><div v-if="row.unit" class="muted">单位 {{ row.unit }}</div></template>
        </el-table-column>
        <el-table-column label="数量" width="140"><template #default="{ row }"><el-input-number v-model="row.qty" data-entry-field="qty" :data-product="row.productId" :min="0" :precision="4" :controls="false" @change="resolve(row)" /></template></el-table-column>
        <el-table-column label="发货仓 / 基础数量" min-width="210"><template #default="{ row }"><template v-if="row.allocs?.length > 1"><div v-for="allocation in row.allocs" :key="allocation.id"><span>{{ allocation.warehouseName || options.warehouses.find(w => w.id === allocation.warehouseId)?.name || '#' + allocation.warehouseId }}</span><el-input-number v-model="allocation.allocQty" :min="Number(allocation.outboundQty || 0) + Number(allocation.cancelledQty || 0)" :precision="4" controls-position="right" /></div><span class="muted">分仓合计须等于基础数量；换算与校验由原服务执行。</span></template><el-select v-else v-model="row.warehouseId" data-entry-field="warehouse" :data-product="row.productId"><el-option v-for="w in options.warehouses" :key="w.id" :label="w.name" :value="w.id" /></el-select></template></el-table-column>
        <el-table-column label="成交价" width="150">
          <template #default="{ row }">
            <el-input-number v-model="row.price" data-entry-field="price" :data-product="row.productId" placeholder="待匹配" :min="0" :precision="4" :disabled="!row.manual" :controls="false" />
            <el-checkbox v-if="user.hasPerm('sal:order:manual-price')" v-model="row.manual">改价</el-checkbox>
            <div class="muted">{{ row.priceError || row.priceSource }}</div>
          </template>
        </el-table-column>
        <el-table-column v-if="!form.editingId" label="金额" width="130" align="right"><template #default="{ row }"><MoneyText v-if="typeof row.price === 'number'" :value="row.qty * row.price" :currency="country.currency" /><span v-else>待匹配</span></template></el-table-column>
        <el-table-column v-if="!form.editingId" width="65"><template #default="{ $index }"><el-button link type="danger" @click="removeEntryLine($index)">移除</el-button></template></el-table-column>
      </el-table>
      <el-button v-if="form.editingId" class="mt" link type="primary" @click="form.lines.push({ qty: 1, warehouseId: undefined })">添加一行</el-button>
      <el-form-item v-if="form.editingId" label="备注"><el-input v-model="form.remark" /></el-form-item>
    </el-form>
    <section v-if="!form.editingId && entry.step === 3" class="entry-notes"><p>已复核 {{ form.lines.length }} 种商品</p><el-input v-model="form.remark" type="textarea" :rows="4" placeholder="填写订单备注（可选）" aria-label="订单备注" /><p class="muted">保存草稿可继续修改；保存并提交后按当前审批规则处理。</p></section>
    <template #footer>
      <el-button :disabled="form.saving || entry.checking" @click="form.visible = false">取消</el-button>
      <el-button v-if="!form.editingId && entry.step > 1" :disabled="form.saving || entry.checking" @click="backEntry">{{ entry.step === 2 ? '返回商品目录' : '返回复核' }}</el-button>
      <el-button v-if="!form.editingId && entry.step < 3" type="primary" :loading="entry.checking" @click="nextEntry">{{ entry.step === 1 ? '确认销售订单' : '下一步：备注' }}</el-button>
      <template v-else><el-button :loading="form.saving || entry.checking" :disabled="booksLoading" :type="form.editingId ? 'primary' : 'default'" @click="save(false)">{{ form.editingId ? '保存修改' : '存草稿' }}</el-button><el-button v-if="!form.editingId" type="primary" :loading="form.saving || entry.checking" :disabled="booksLoading" @click="save(true)">保存并提交</el-button></template>
    </template>
  </el-dialog>
</template>

<style scoped>
.mt { margin: 8px 0; }
.entry-steps { margin: 8px 0 24px; }
.entry-error { margin-bottom: 12px; }
.catalog-filters { display: grid; grid-template-columns: minmax(180px, 2fr) 1fr 1fr auto; gap: 12px; }
.catalog-table :deep(.el-input__inner) { text-align: right; }
.catalog-table :deep(th), .catalog-table :deep(td) { padding: 12px 0; }
.entry-notes { min-height: 260px; }
@media (max-width: 640px) { .catalog-filters { grid-template-columns: 1fr 1fr; } .catalog-filters > :first-child { grid-column: 1 / -1; } }
</style>
