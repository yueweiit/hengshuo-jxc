<script setup lang="ts">
import { computed, onMounted, reactive, ref, watch } from 'vue'
import { useRoute, useRouter } from 'vue-router'
import { ElMessage } from 'element-plus'
import { http, createCommandIntent } from '@/api/http'
import { allRecords } from '@/api/pagination'
import { useCountryStore } from '@/stores/country'
import { useUserStore } from '@/stores/user'
import CrudPage from '@/components/crud/CrudPage.vue'
import MoneyText from '@/components/MoneyText.vue'
import DocAttachment from '@/components/DocAttachment.vue'
import type { ColumnDef, CrudPageExpose, FieldDef } from '@/components/crud/types'
import { CUSTOMER_SOURCE, RECEIPT_STATUS } from '@/modules/shared/bizOptions'

const actionIntent = createCommandIntent()
const createIntent = createCommandIntent()

type Row = Record<string, any> // eslint-disable-line @typescript-eslint/no-explicit-any
const route = useRoute()
const router = useRouter()
const user = useUserStore(), country = useCountryStore()
const page = ref<CrudPageExpose>()
const confirmOnly = computed(() => route.path.endsWith('/confirm'))
const options = reactive({ customers: [] as Row[], accounts: [] as Row[], orders: [] as Row[], books: [] as Row[] })
const form = reactive({ visible: false, saving: false, bookId: undefined as number | undefined, customerId: undefined as number | undefined, method: 'CASH', amount: 0, fundAccountId: undefined as number | undefined, referenceNo: '', orderId: undefined as number | undefined, plannedAmount: 0 })
const proof = reactive({ visible: false, id: 0 })
const contextOrder = ref<Row | null>(null)
const contextError = ref('')
const contextLoading = ref(false)
const showCustomerReceipts = ref(false)
const sourceOrderId = computed(() => {
  const raw = route.query?.orderId
  if (raw == null) return undefined
  const id = Number(raw)
  return typeof raw === 'string' && /^\d+$/.test(raw) && Number.isSafeInteger(id) && id > 0 ? id : undefined
})
const receiptQuery = computed(() => ({ ...(confirmOnly.value ? { status: 'PENDING_CONFIRM' } : {}), ...(contextOrder.value && showCustomerReceipts.value ? { customerId: contextOrder.value.customerId, bookId: contextOrder.value.bookId } : sourceOrderId.value ? { orderId: sourceOrderId.value } : {}) }))
let contextRequest = 0
async function loadContext() {
  const request = ++contextRequest
  contextOrder.value = null; contextError.value = ''; contextLoading.value = false; showCustomerReceipts.value = false
  if (route.query?.orderId == null) return
  if (!sourceOrderId.value) { contextError.value = '来源订单编号不合法，请返回原订单重新操作'; return }
  contextLoading.value = true
  try {
    const result = await http.get<Row>(`/ar/receipts/order-context/${sourceOrderId.value}`, undefined, { silent: true })
    if (request !== contextRequest) return
    if (!result || result.id !== sourceOrderId.value || !result.docNo) throw new Error('来源订单返回格式不正确')
    contextOrder.value = result
    if (route.query.action === 'register' && user.hasPerm('ar:receipt:create') && !confirmOnly.value) await open()
  } catch (error) {
    if (request === contextRequest) contextError.value = error instanceof Error ? error.message : '来源订单读取失败'
  } finally { if (request === contextRequest) contextLoading.value = false }
}
function returnToOrder() {
  if (contextOrder.value) router.push({ path: `/sales/orders/${contextOrder.value.id}`, query: { resumeOutbound: '1' } })
}

const columns: ColumnDef[] = [
  { prop: 'docNo', label: '收款单', width: 180 },
  { prop: 'customerName', label: '客户', minWidth: 150 },
  { prop: 'method', label: '方式', type: 'status', width: 90 },
  { prop: 'amount', label: '金额', width: 130 },
  { prop: 'openAmount', label: '未核销', width: 130 },
  { prop: 'accountName', label: '账户', minWidth: 140 },
  { prop: 'status', label: '状态', type: 'status', width: 110 },
  { prop: 'orders', label: '订单分配', minWidth: 190 },
  { prop: 'referenceNo', label: '参考号', width: 140 },
]
const searchFields: FieldDef[] = [
  { prop: 'keyword', label: '单号 / 参考号' },
  { prop: 'customerId', label: '客户', type: 'select', options: CUSTOMER_SOURCE },
  { prop: 'status', label: '状态', type: 'select', options: RECEIPT_STATUS },
  { prop: 'method', label: '方式', type: 'select', options: [{ label: '现金', value: 'CASH' }, { label: '转账', value: 'TRANSFER' }] },
]

async function open() {
  createIntent.reset()
  const scope = JSON.stringify([route.query?.orderId, country.epoch, user.user?.id])
  const [customers, accounts, orders, books] = await Promise.all([
    allRecords<Row>('/md/customers', { status: 'ENABLED' }),
    allRecords<Row>('/md/fund-accounts', { status: 'ENABLED' }),
    sourceOrderId.value ? http.get<Row>(`/ar/receipts/order-context/${sourceOrderId.value}`, undefined, { silent: true }).then(order => [order]) : allRecords<Row>('/sal/orders'),
    http.get<Row[]>('/org/books'),
  ])
  if (scope !== JSON.stringify([route.query?.orderId, country.epoch, user.user?.id])) throw new Error('国家、账号或来源订单已切换，请重新打开收款登记')
  options.customers = customers
  options.accounts = accounts
  options.books = books
  options.orders = orders
  const selected = sourceOrderId.value ? orders.find(order => order.id === sourceOrderId.value) : undefined
  if (route.query?.orderId != null && !selected) throw new Error('来源订单不可读取或无权访问，请返回原订单核对')
  Object.assign(form, { visible: true, bookId: books.length === 1 ? books[0]!.id : undefined, method: 'CASH', amount: 0, customerId: undefined, fundAccountId: undefined, referenceNo: '', orderId: undefined, plannedAmount: 0 })
  if (selected) Object.assign(form, { bookId: selected.bookId, customerId: selected.customerId, orderId: selected.id })
}
async function openFromToolbar() {
  try { await open() }
  catch (error) { ElMessage.warning(error instanceof Error ? error.message : '收款登记选项读取失败') }
}
async function save() {
  if (!form.bookId) return ElMessage.warning('请选择收款账套')
  form.saving = true
  try {
    await http.postIdem('/ar/receipts', {
      bookId: form.bookId, customerId: form.customerId, method: form.method, amount: form.amount, fundAccountId: form.fundAccountId, referenceNo: form.referenceNo,
      orders: form.orderId && form.plannedAmount > 0 ? [{ orderId: form.orderId, plannedAmount: form.plannedAmount }] : [],
    }, createIntent)
    ElMessage.success('已登记；现金和转账都需要确认到账，才能计入订单收款')
    form.visible = false
    page.value?.reload()
  } finally {
    form.saving = false
  }
}
async function confirm(row: Row) {
  await http.postIdem(`/ar/receipts/${row.id}/confirm`, { referenceNo: row.referenceNo }, actionIntent)
  ElMessage.success('已确认到账')
  page.value?.reload()
}
async function reject(row: Row) {
  await http.postIdem(`/ar/receipts/${row.id}/reject`, { reason: '金额或账户不符' }, actionIntent)
  ElMessage.success('已驳回')
  page.value?.reload()
}
watch(() => [route.query?.orderId, route.query?.action, confirmOnly.value, country.epoch, user.user?.id], () => { form.visible = false; proof.visible = false; loadContext() })
onMounted(loadContext)
</script>

<template>
  <p v-if="contextLoading" class="muted" role="status">正在读取来源订单…</p>
  <el-alert v-if="contextError" title="来源订单读取失败" :description="contextError" type="error" :closable="false" />
  <el-button v-if="contextError" @click="loadContext">重新读取来源订单</el-button>
  <div v-if="contextOrder" class="source-order"><span>当前订单：{{ contextOrder.docNo }}；处理后请返回订单重新检查出库条件。</span><el-button v-if="user.hasPerm('sal:order:view')" link type="primary" @click="returnToOrder">返回本订单</el-button><el-button link @click="showCustomerReceipts = !showCustomerReceipts">{{ showCustomerReceipts ? '只看本单收款' : '查看该客户收款（含未分配）' }}</el-button></div>
  <CrudPage v-if="route.query.orderId == null || contextOrder" :key="JSON.stringify([receiptQuery, country.epoch])" ref="page" :title="confirmOnly ? '到账确认' : '收款登记'" resource="/ar/receipts" :columns="columns" :search-fields="searchFields" :default-query="receiptQuery" :can-create="false" :can-toggle="false" :actions-width="220">
    <template #toolbar>
      <el-button v-if="!confirmOnly && user.hasPerm('ar:receipt:create')" type="primary" :disabled="!!contextError || contextLoading" @click="openFromToolbar">登记收款</el-button>
    </template>
    <template #header><p class="muted">现金和转账都先登记，再确认到账。只有已确认且分配到订单的收款才能用于现款出库；系统不连接银行。</p></template>
    <template #col-amount="{ row }"><MoneyText :value="row.amount" :currency="row.currency" /></template>
    <template #col-openAmount="{ row }"><MoneyText :value="row.openAmount" :currency="row.currency" /></template>
    <template #col-orders="{ row }"><span v-if="Array.isArray(row.orders)">{{ row.orders.length ? row.orders.map((order: Row) => order.orderNo).join('、') : '未分配到订单' }}</span><span v-else>分配信息未返回</span></template>
    <template #row-actions="{ row }">
      <el-button v-if="row.method === 'TRANSFER'" link @click="proof.id = row.id; proof.visible = true">凭证</el-button>
      <template v-if="row.status === 'PENDING_CONFIRM' && user.hasPerm('ar:receipt:confirm')">
        <el-button link type="success" @click="confirm(row)">确认到账</el-button>
        <el-button link type="danger" @click="reject(row)">驳回</el-button>
      </template>
    </template>
  </CrudPage>
  <el-dialog v-model="form.visible" title="登记收款" width="520px">
    <el-form label-width="88px">
      <el-form-item label="账套"><el-select v-model="form.bookId" style="width:100%" @change="form.fundAccountId = undefined; form.orderId = undefined"><el-option v-for="book in options.books" :key="book.id" :label="book.name" :value="book.id" /></el-select></el-form-item>
      <el-form-item label="客户"><el-select v-model="form.customerId" filterable style="width:100%"><el-option v-for="c in options.customers" :key="c.id" :label="c.name" :value="c.id" /></el-select></el-form-item>
      <el-form-item label="方式"><el-radio-group v-model="form.method"><el-radio-button value="CASH">现金</el-radio-button><el-radio-button value="TRANSFER">转账</el-radio-button></el-radio-group></el-form-item>
      <el-form-item label="金额"><el-input-number v-model="form.amount" :min="0.01" :precision="2" /></el-form-item>
      <el-form-item label="账户"><el-select v-model="form.fundAccountId" style="width:100%"><el-option v-for="a in options.accounts.filter(a => (a.bookId == null || a.bookId === form.bookId) && a.currency === (options.books.find(b => b.id === form.bookId)?.baseCurrency ?? country.currency))" :key="a.id" :label="a.name" :value="a.id" /></el-select></el-form-item>
      <el-form-item label="参考号"><el-input v-model="form.referenceNo" /></el-form-item>
      <el-form-item label="对应订单"><el-select v-model="form.orderId" clearable filterable style="width:100%"><el-option v-for="o in options.orders.filter((x) => x.customerId === form.customerId && x.bookId === form.bookId)" :key="o.id" :label="o.docNo" :value="o.id" /></el-select></el-form-item>
      <el-form-item label="分配金额"><el-input-number v-model="form.plannedAmount" :min="0" :precision="2" /></el-form-item>
    </el-form>
    <template #footer>
      <el-button @click="form.visible = false">取消</el-button>
      <el-button type="primary" :loading="form.saving" @click="save">保存</el-button>
    </template>
  </el-dialog>
  <el-dialog v-model="proof.visible" title="转账凭证" width="560px">
    <DocAttachment v-if="proof.id" biz-type="AR_RECEIPT" :biz-id="proof.id" category="PAYMENT_PROOF" />
  </el-dialog>
</template>
