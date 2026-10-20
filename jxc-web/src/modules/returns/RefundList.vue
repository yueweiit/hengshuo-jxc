<script setup lang="ts">
import { computed, reactive, ref, watch } from 'vue'
import { useRoute } from 'vue-router'
import { ElMessage } from 'element-plus'
import { http, createCommandIntent } from '@/api/http'
import { getCountryId, getToken } from '@/utils/session'
import { allRecords } from '@/api/pagination'
import { useUserStore } from '@/stores/user'
import { useCountryStore } from '@/stores/country'
import { todayIn } from '@/utils/format'
import CrudPage from '@/components/crud/CrudPage.vue'
import MoneyText from '@/components/MoneyText.vue'
import ApprovalPanel from '@/components/ApprovalPanel.vue'
import DocAttachment from '@/components/DocAttachment.vue'
import type { ColumnDef, CrudPageExpose } from '@/components/crud/types'

const createIntent = createCommandIntent()

type Row = Record<string, any> // eslint-disable-line @typescript-eslint/no-explicit-any
const user = useUserStore(), country = useCountryStore()
const route = useRoute()
const books = ref<Row[]>([])
const page = ref<CrudPageExpose>()
const customers = ref<Row[]>([])
const accounts = ref<Row[]>([])
const form = reactive({ bookId: undefined as number | undefined, bizDate: '', visible: false, saving: false, customerId: undefined as number | undefined, amount: 0, fundAccountId: undefined as number | undefined, method: 'TRANSFER', payeeInfo: { name: '', account: '' } })
const pay = reactive({ readonly: false, visible: false, row: null as Row | null, referenceNo: '', paidAt: '', key: createCommandIntent() })
const canReadRefundProof = computed(() => ['BANK_INFO', 'ORDER_TOTAL'].every(group => user.fieldAccess(group) !== 'HIDDEN') && user.hasPerm(['rtn:refund:create', 'rtn:refund:pay']))
let detailRequest = 0
const detailScope = () => JSON.stringify([route.query.sourceId, getCountryId(), getToken(), country.epoch])
const columns: ColumnDef[] = [
  { prop: 'docNo', label: '退款单', width: 180 },
  { prop: 'customerName', label: '客户', minWidth: 150 },
  { prop: 'amount', label: '金额', width: 120 },
  { prop: 'method', label: '方式', type: 'status', width: 90 },
  { prop: 'status', label: '状态', type: 'status', width: 120 },
  { prop: 'referenceNo', label: '参考号', width: 140 },
]
async function open() {
  createIntent.reset()
  books.value = await allRecords<Row>('/org/books')
  customers.value = await allRecords<Row>('/md/customers', { status: 'ENABLED' })
  accounts.value = await allRecords<Row>('/md/fund-accounts', { status: 'ENABLED' })
  Object.assign(form, { bookId: books.value.length === 1 ? books.value[0]?.id : undefined, bizDate: todayIn(country.timezone), visible: true, customerId: undefined, amount: 0, method: 'TRANSFER', fundAccountId: undefined, payeeInfo: { name: '', account: '' } })
}
async function save() {
  if (!form.bookId || !form.bizDate) return ElMessage.warning('请选择账套与业务日期')
  form.saving = true
  try {
    await http.postIdem('/rtn/refunds', form, createIntent)
    ElMessage.success('已提交退款审批')
    form.visible = false
    page.value?.reload()
  } finally {
    form.saving = false
  }
}
function openPay(row: Row) {
  ++detailRequest
  Object.assign(pay, { readonly: false, visible: true, row, referenceNo: '', paidAt: '', key: createCommandIntent() })
}
async function openDetail(id: number) {
  const request = ++detailRequest, scope = detailScope()
  Object.assign(pay, { visible: false, row: null, readonly: true })
  const row = await http.get<Row>(`/rtn/refunds/${id}`)
  if (request !== detailRequest || scope !== detailScope()) return
  Object.assign(pay, { visible: true, row, readonly: true })
}
watch(() => [country.epoch, user.token], () => {
  ++detailRequest
  Object.assign(pay, { visible: false, row: null })
})
watch(() => route.query.sourceId, async (value) => {
  const id = Number(value)
  if (Number.isSafeInteger(id) && id > 0) await openDetail(id)
}, { immediate: true })
async function doPay() {
  if (!pay.paidAt || !pay.referenceNo.trim()) return ElMessage.warning('请填写实际支付日期与参考号，并上传退款凭证')
  await http.postIdem(`/rtn/refunds/${pay.row!.id}/pay`, { referenceNo: pay.referenceNo, paidAt: pay.paidAt }, pay.key)
  ElMessage.success('已登记支付。用同一个操作再点一次不会多退。')
  pay.visible = false
  page.value?.reload()
}
</script>

<template>
  <CrudPage ref="page" title="退款单" resource="/rtn/refunds" :columns="columns" :can-create="false" :can-toggle="false" :actions-width="160">
    <template #toolbar><el-button v-if="user.hasPerm('rtn:refund:create')" type="primary" @click="open">申请退款</el-button></template>
    <template #header><p class="muted">退款不能超过可退余额。支付登记带幂等键，重复提交只扣一次。</p></template>
    <template #col-amount="{ row }"><MoneyText :value="row.amount" :currency="row.currency" /></template>
    <template #row-actions="{ row }">
      <el-button link type="primary" @click="openDetail(row.id)">详情</el-button>
      <el-button v-if="row.status === 'APPROVED' && user.hasPerm('rtn:refund:pay')" link type="primary" @click="openPay(row)">登记支付</el-button>
    </template>
  </CrudPage>
  <el-dialog v-model="form.visible" title="申请退款" width="460px">
    <el-form label-width="88px">
      <el-form-item label="账套" required><el-select v-model="form.bookId" style="width:100%"><el-option v-for="b in books" :key="b.id" :label="b.name" :value="b.id" /></el-select></el-form-item>
      <el-form-item label="业务日期" required><el-date-picker v-model="form.bizDate" type="date" value-format="YYYY-MM-DD" /></el-form-item>
      <el-form-item label="客户"><el-select v-model="form.customerId" filterable style="width:100%"><el-option v-for="c in customers" :key="c.id" :label="c.name" :value="c.id" /></el-select></el-form-item>
      <el-form-item label="金额"><el-input-number v-model="form.amount" :min="0.01" :precision="2" /></el-form-item>
      <el-form-item label="方式"><el-radio-group v-model="form.method"><el-radio-button value="CASH">现金</el-radio-button><el-radio-button value="TRANSFER">转账</el-radio-button></el-radio-group></el-form-item>
      <el-form-item label="账户"><el-select v-model="form.fundAccountId" style="width:100%"><el-option v-for="a in accounts.filter(a => !a.bookId || a.bookId === form.bookId)" :key="a.id" :label="a.name" :value="a.id" /></el-select></el-form-item>
      <el-form-item label="收款人" required><el-input v-model="form.payeeInfo.name" /></el-form-item>
      <el-form-item v-if="form.method === 'TRANSFER'" label="收款账户" required><el-input v-model="form.payeeInfo.account" /></el-form-item>
    </el-form>
    <template #footer>
      <el-button @click="form.visible = false">取消</el-button>
      <el-button type="primary" :loading="form.saving" @click="save">提交审批</el-button>
    </template>
  </el-dialog>
  <el-dialog v-model="pay.visible" :title="pay.readonly ? '退款详情' : '登记退款支付'" width="480px">
    <el-descriptions v-if="pay.readonly && pay.row" :column="1" border>
      <el-descriptions-item label="退款单">{{ pay.row.docNo }}</el-descriptions-item>
      <el-descriptions-item label="客户">{{ pay.row.customerName }}</el-descriptions-item>
      <el-descriptions-item label="金额"><MoneyText :value="pay.row.amount" :currency="pay.row.currency" /></el-descriptions-item>
      <el-descriptions-item label="方式">{{ pay.row.method }}</el-descriptions-item>
      <el-descriptions-item label="状态">{{ pay.row.status }}</el-descriptions-item>
    </el-descriptions>
    <el-form v-else label-width="88px">
      <el-form-item label="实际支付日" required><el-date-picker v-model="pay.paidAt" type="date" value-format="YYYY-MM-DD" /></el-form-item>
      <el-form-item label="参考号" required><el-input v-model="pay.referenceNo" /></el-form-item>
    </el-form>
    <DocAttachment v-if="pay.row && canReadRefundProof" biz-type="REFUND" :biz-id="pay.row.id" category="REFUND_PROOF" :readonly="pay.readonly || ['BANK_INFO', 'ORDER_TOTAL'].some(group => user.fieldAccess(group) !== 'WRITE') || !user.hasPerm(['rtn:refund:create', 'rtn:refund:pay'])" />
    <p v-else-if="pay.row" class="muted">退款凭证需要银行信息及单据金额读取权限。</p>
    <ApprovalPanel v-if="pay.row" doc-type="REFUND" :doc-id="pay.row.id" />
    <template #footer>
      <el-button @click="pay.visible = false">取消</el-button>
      <el-button v-if="!pay.readonly" type="primary" @click="doPay">确认支付</el-button>
    </template>
  </el-dialog>
</template>
