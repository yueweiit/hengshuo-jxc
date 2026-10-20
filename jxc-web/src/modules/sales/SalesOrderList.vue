<script setup lang="ts">
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
const options = reactive({ customers: [] as Row[], products: [] as Row[], warehouses: [] as Row[] })
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
  const [, customers, products, warehouses] = await Promise.all([
    loadBooksForWarehouses(),
    allRecords<Row>('/md/customers', { status: 'ENABLED' }),
    allRecords<Row>('/md/country-skus', { enabled: 'true' }),
    allRecords<Row>('/org/warehouses', { status: 'ENABLED' }),
  ])
  if (request !== createRequest || epoch !== country.epoch || countryId !== country.currentId || token !== user.token) return
  options.customers = customers
  options.products = products
  options.warehouses = warehouses
  form.visible = true
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
  if (Number(order.id) !== id || order.totalQty == null || order.approvalStatus === 'PENDING' || order.fulfillmentStatus === 'CLOSED') return ElMessage.warning('当前订单不能修改；审批中请先撤回，部分可见订单需由完整授权人员处理')
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
    if (!line.manual) line.price = old.price
    return
  }
  const request = (priceRequests.get(line) ?? 0) + 1, context = scope()
  priceRequests.set(line, request)
  const customerId = form.customerId, productId = line.productId, qty = line.qty, date = form.orderDate
  const current = () => context === scope() && priceRequests.get(line) === request && form.lines.includes(line) && form.customerId === customerId && line.productId === productId && line.qty === qty && form.orderDate === date
  try {
    const hit = await http.get<Row>('/sal/prices/resolve', { customerId, productId, qty, date, unit: line.unit || options.products.find(p => p.productId === productId)?.baseUnit || 'PCS' })
    if (!current()) return
    line.stdPrice = hit.price
    if (!line.manual) line.price = hit.price
    line.priceSource = hit.priceSource
  } catch {
    if (!current()) return
    line.stdPrice = null
    line.priceSource = 'SAL_PRICE_NOT_FOUND'
  }
}

async function save(submit: boolean) {
  if (form.saving) return
  if (!form.visible || formScope !== scope()) return ElMessage.warning('国家或登录状态已切换，请重新打开表单')
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
      lines: form.lines.filter((l) => l.productId && l.qty > 0).map((l) => ({
        productId: l.productId, qty: l.qty, unit: options.products.find(p => p.productId === l.productId)?.baseUnit || 'PCS', warehouseId: l.warehouseId,
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
  await confirmAction(`提交 ${row.docNo}？`, () => http.postIdem(`/sal/orders/${row.id}/submit`, undefined, supplyCommandIntent), { success: '已提交' })
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
      <el-button v-if="row.approvalStatus !== 'PENDING' && row.fulfillmentStatus !== 'CLOSED' && user.hasPerm('sal:order:edit')" link type="primary" @click="openEdit(row.id)">修改</el-button>
      <el-button v-if="['DRAFT', 'REJECTED', 'WITHDRAWN'].includes(row.approvalStatus) && user.hasPerm('sal:order:submit')" link type="success" @click="submit(row)">提交</el-button>
    </template>
  </CrudPage>

  <el-dialog v-model="form.visible" :title="form.editingId ? '修改销售订单' : '代客录单'" width="900px">
    <el-form label-width="88px">
      <el-form-item label="账套" required><el-select v-model="form.bookId" :loading="booksLoading" :disabled="booksLoading || !!form.editingId" placeholder="请选择账套"><el-option v-for="b in books" :key="b.id" :label="b.name + ' · ' + b.baseCurrency" :value="b.id" /></el-select><span class="muted">按发货仓匹配；多个仓库需共用同一账套</span></el-form-item>
      <el-form-item :label="form.editingId ? '原订单日期' : '业务日期'" required><el-date-picker v-model="form.orderDate" :disabled="!!form.editingId" value-format="YYYY-MM-DD" @change="form.lines.forEach(line => resolve(line, true))" /></el-form-item>
      <el-form-item v-if="form.editingId" label="修改日期" required><el-date-picker v-model="form.bizDate" value-format="YYYY-MM-DD" /><span class="muted">修改后回到草稿，原审批失效，需要重新提交审核。</span></el-form-item>
      <el-form-item label="客户" required>
        <el-select v-model="form.customerId" :disabled="delivered()" filterable style="width: 100%" @change="form.lines.forEach(line => resolve(line, true))">
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
          <template #default="{ row }"><el-select v-model="row.productId" :disabled="!!row.id" filterable @change="resolve(row)"><el-option v-for="p in options.products" :key="p.productId" :label="p.label || p.productCode" :value="p.productId" /></el-select><span v-if="row.unit" class="muted">原单位 {{ row.unit }}</span></template>
        </el-table-column>
        <el-table-column label="数量" width="110"><template #default="{ row }"><el-input-number v-model="row.qty" :min="0.0001" :precision="4" controls-position="right" @change="resolve(row)" /></template></el-table-column>
        <el-table-column label="发货仓 / 基础数量" min-width="210"><template #default="{ row }"><template v-if="row.allocs?.length > 1"><div v-for="allocation in row.allocs" :key="allocation.id"><span>{{ allocation.warehouseName || options.warehouses.find(w => w.id === allocation.warehouseId)?.name || '#' + allocation.warehouseId }}</span><el-input-number v-model="allocation.allocQty" :min="Number(allocation.outboundQty || 0) + Number(allocation.cancelledQty || 0)" :precision="4" controls-position="right" /></div><span class="muted">分仓合计须等于基础数量；换算与校验由原服务执行。</span></template><el-select v-else v-model="row.warehouseId"><el-option v-for="w in options.warehouses" :key="w.id" :label="w.name" :value="w.id" /></el-select></template></el-table-column>
        <el-table-column label="成交价" width="150">
          <template #default="{ row }">
            <el-input-number v-model="row.price" placeholder="请填写" :min="0" :precision="4" :disabled="!row.manual" controls-position="right" />
            <el-checkbox v-if="user.hasPerm('sal:order:manual-price')" v-model="row.manual">改价</el-checkbox>
            <div class="muted">{{ row.priceSource || '' }}</div>
          </template>
        </el-table-column>
      </el-table>
      <el-button class="mt" link type="primary" @click="form.lines.push({ qty: 1, warehouseId: undefined })">添加一行</el-button>
      <el-form-item label="备注"><el-input v-model="form.remark" /></el-form-item>
    </el-form>
    <template #footer>
      <el-button @click="form.visible = false">取消</el-button>
      <el-button :loading="form.saving" :disabled="booksLoading" :type="form.editingId ? 'primary' : 'default'" @click="save(false)">{{ form.editingId ? '保存修改' : '存草稿' }}</el-button>
      <el-button v-if="!form.editingId" type="primary" :loading="form.saving" :disabled="booksLoading" @click="save(true)">保存并提交</el-button>
    </template>
  </el-dialog>
</template>

<style scoped>
.mt { margin: 8px 0; }
</style>
