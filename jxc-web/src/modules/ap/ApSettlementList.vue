<script setup lang="ts">
import { computed, reactive, ref } from 'vue'
import { ElMessage, ElMessageBox } from 'element-plus'
import { http, createCommandIntent } from '@/api/http'
import { allRecords } from '@/api/pagination'
import { useUserStore } from '@/stores/user'
import CrudPage from '@/components/crud/CrudPage.vue'
import type { ColumnDef, CrudPageExpose } from '@/components/crud/types'

const actionIntent = createCommandIntent()

type Row = Record<string, any> // eslint-disable-line @typescript-eslint/no-explicit-any
const user = useUserStore()
const page = ref<CrudPageExpose>()
const partners = ref<Row[]>([])
const books = ref<Row[]>([])
let selectionRequest = 0
const bills = ref<Row[]>([])
const payments = ref<Row[]>([])
const prepayments = ref<Row[]>([])
const credits = ref<Row[]>([])
const form = reactive({ visible: false, saving: false, bookId: undefined as number | undefined, partnerId: undefined as number | undefined, fromType: 'PAYMENT', fromId: undefined as number | undefined, billId: undefined as number | undefined, billAmount: 0, settleRate: 1, key: createCommandIntent() })
const columns: ColumnDef[] = [
  { prop: 'docNo', label: '核销单', width: 180 },
  { prop: 'bizDate', label: '日期', type: 'date', width: 110 },
  { prop: 'status', label: '状态', type: 'status', width: 100 },
  { prop: 'fxDiff', label: '汇兑差额(本位币)', width: 150 },
]
const sources = computed(() => form.fromType === 'PREPAYMENT' ? prepayments.value : form.fromType === 'CREDIT_NOTE' ? credits.value : payments.value)
const selectedSource = computed(() => sources.value.find((s) => s.id === form.fromId))
const selectedBill = computed(() => bills.value.find((b) => b.id === form.billId))
const crossCurrency = computed(() => selectedSource.value && selectedBill.value && (selectedSource.value.payCurrency || selectedSource.value.currency) !== selectedBill.value.currency)
const preview = computed(() => {
  const source = selectedSource.value, bill = selectedBill.value
  if (!source || !bill || source.baseAmount == null || bill.baseAmount == null) return null
  const fromAmount = form.billAmount / (crossCurrency.value ? form.settleRate : 1)
  const payBase = fromAmount * source.baseAmount / (source.payAmount ?? source.amount)
  const billBase = form.billAmount * bill.baseAmount / bill.amount
  return { fromAmount: fromAmount.toFixed(2), fxDiff: (payBase - billBase).toFixed(2), currency: bill.baseCurrency }
})
function clearSelection() {
  selectionRequest++; bills.value = []; payments.value = []; prepayments.value = []; credits.value = []
  form.fromId = undefined; form.billId = undefined
}
async function open() {
  clearSelection()
  const [partnerRows, bookRows] = await Promise.all([allRecords<Row>('/md/partners', { status: 'ENABLED' }), allRecords<Row>('/org/books', { status: 'ACTIVE' })])
  partners.value = partnerRows; books.value = bookRows.filter(book => book.status === 'ACTIVE')
  Object.assign(form, { visible: true, bookId: books.value.length === 1 ? books.value[0]!.id : undefined, partnerId: undefined, fromType: 'PAYMENT', fromId: undefined, billId: undefined, billAmount: 0, settleRate: 1, key: createCommandIntent() })
}
async function load() {
  clearSelection()
  const book = form.bookId, partner = form.partnerId, request = selectionRequest
  if (!book || !partner) return
  const q = { bookId: book, partnerId: partner }
  const [billRows, paymentRows, prepaymentRows, creditRows] = await Promise.all([
    http.get<Row[]>('/ap/payables', q), allRecords<Row>('/ap/payments', q), allRecords<Row>('/ap/prepayments', q), http.get<Row[]>('/ap/credit-notes', q),
  ])
  if (request !== selectionRequest || form.bookId !== book || form.partnerId !== partner) return
  const matching = (r: Row) => r.bookId === book && r.partnerId === partner && Number(r.openAmount) > 0
  bills.value = billRows.filter(matching)
  payments.value = paymentRows.filter(r => matching(r) && ['CONFIRMED', 'PARTIAL_SETTLED'].includes(r.status))
  prepayments.value = prepaymentRows.filter(r => matching(r) && ['CONFIRMED', 'PARTIAL_USED'].includes(r.status))
  credits.value = creditRows.filter(matching)
}
async function save() {
  const bill = bills.value.find((b) => b.id === form.billId)
  const pay = selectedSource.value
  if (!form.bookId || !bill || !pay || bill.bookId !== form.bookId || pay.bookId !== form.bookId) return ElMessage.warning('请选择当前账套的来源单和账单')
  form.saving = true
  try {
    await http.postIdem('/ap/settlements', {
      bookId: form.bookId, partnerId: form.partnerId,
      lines: [{ fromType: form.fromType, fromId: form.fromId, fromCurrency: pay?.payCurrency || pay?.currency || bill?.currency, billId: form.billId, billAmount: form.billAmount, settleRate: form.settleRate, rateSource: 'ACTUAL' }],
    }, form.key)
    ElMessage.success('已核销')
    form.visible = false
    page.value?.reload()
  } finally {
    form.saving = false
  }
}
async function reverse(row: Row) {
  const { value } = await ElMessageBox.prompt('撤销原因', '撤销应付核销', { inputValidator: (v) => !!v?.trim() || '请填写原因' })
  await http.postIdem(`/ap/settlements/${row.id}/reverse`, { reason: value }, actionIntent)
  ElMessage.success('已撤销，来源余额与应付已恢复')
  page.value?.reload()
}
</script>

<template>
  <CrudPage ref="page" title="应付核销" resource="/ap/settlements" :columns="columns" :can-create="false" :can-toggle="false">
    <template #toolbar><el-button v-if="user.hasPerm('ap:settlement:create')" type="primary" @click="open">核销</el-button></template>
    <template #header><p class="muted">付款币种和账单币种不同时必须填写结算汇率。汇率差记在本张核销上。</p></template>
    <template #col-fxDiff="{ row }">{{ row.lines.reduce((total: number, line: Row) => total + Number(line.fxDiff || 0), 0).toFixed(2) }} {{ row.lines[0]?.baseCurrency }}</template>
    <template #row-actions="{ row }"><el-button v-if="row.status === 'EFFECTIVE' && !row.reversalOfId && user.hasPerm('ap:settlement:reverse')" link type="danger" @click="reverse(row)">撤销</el-button></template>
  </CrudPage>
  <el-dialog v-model="form.visible" title="核销应付" width="520px">
    <el-form label-width="100px">
      <el-form-item label="账套" required><el-select v-model="form.bookId" @change="load"><el-option v-for="b in books" :key="b.id" :label="b.name" :value="b.id" /></el-select></el-form-item>
      <el-form-item label="往来对象"><el-select v-model="form.partnerId" filterable style="width:100%" @change="load"><el-option v-for="p in partners" :key="p.id" :label="p.name" :value="p.id" /></el-select></el-form-item>
      <el-form-item label="抵扣来源"><el-select v-model="form.fromType" @change="form.fromId = undefined"><el-option label="已确认付款" value="PAYMENT" /><el-option label="预付款" value="PREPAYMENT" /><el-option label="退货/索赔贷项" value="CREDIT_NOTE" /></el-select></el-form-item>
      <el-form-item label="来源单"><el-select v-model="form.fromId" style="width:100%"><el-option v-for="p in sources" :key="p.id" :label="`${p.docNo} ${p.payCurrency || p.currency} 余 ${p.openAmount}`" :value="p.id" /></el-select></el-form-item>
      <el-form-item label="账单"><el-select v-model="form.billId" style="width:100%"><el-option v-for="b in bills" :key="b.id" :label="`${b.docNo} ${b.currency} 未付 ${b.openAmount}`" :value="b.id" /></el-select></el-form-item>
      <el-form-item label="账单金额"><el-input-number v-model="form.billAmount" :min="0.01" :precision="2" /></el-form-item>
      <el-form-item v-if="crossCurrency" label="实际结算汇率"><el-input-number v-model="form.settleRate" :min="0.0001" :precision="4" /><div class="muted">按「账单币种金额 / 来源币种金额」。</div></el-form-item>
      <el-form-item v-if="preview" label="换算预览">来源消耗 {{ preview.fromAmount }}；汇兑差额 {{ preview.fxDiff }} {{ preview.currency }}</el-form-item>
    </el-form>
    <template #footer>
      <el-button @click="form.visible = false">取消</el-button>
      <el-button type="primary" :loading="form.saving" @click="save">确认</el-button>
    </template>
  </el-dialog>
</template>
