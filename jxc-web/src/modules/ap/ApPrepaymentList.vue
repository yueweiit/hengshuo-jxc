<script setup lang="ts">
import { reactive, ref } from 'vue'
import { ElMessage } from 'element-plus'
import { http, createCommandIntent } from '@/api/http'
import { allRecords } from '@/api/pagination'
import { useUserStore } from '@/stores/user'
import CrudPage from '@/components/crud/CrudPage.vue'
import MoneyText from '@/components/MoneyText.vue'
import DocAttachment from '@/components/DocAttachment.vue'
import { useCountryStore } from '@/stores/country'
import { todayIn } from '@/utils/format'
import type { ColumnDef, CrudPageExpose } from '@/components/crud/types'

type Row = Record<string, any> // eslint-disable-line @typescript-eslint/no-explicit-any
const user = useUserStore()
const country = useCountryStore()
const saveIntent = createCommandIntent()
const confirmation = reactive({ visible: false, saving: false, row: null as Row | null, referenceNo: '', key: createCommandIntent() })
const page = ref<CrudPageExpose>()
const partners = ref<Row[]>([])
const accounts = ref<Row[]>([])
const allAccounts = ref<Row[]>([]), books = ref<Row[]>([]), currencies = ref<Row[]>([])
const form = reactive({ visible: false, saving: false, bookId: undefined as number | undefined, partnerId: undefined as number | undefined, currency: '', amount: 0, fundAccountId: undefined as number | undefined, payDate: '', referenceNo: '' })
const columns: ColumnDef[] = [
  { prop: 'docNo', label: '预付单', width: 180 },
  { prop: 'partnerName', label: '往来对象', minWidth: 150 },
  { prop: 'currency', label: '币种', width: 80 },
  { prop: 'amount', label: '金额', width: 130 },
  { prop: 'openAmount', label: '余额', width: 130 },
  { prop: 'status', label: '状态', type: 'status', width: 120 },
]
async function open() {
  saveIntent.reset()
  const [partnerRows, accountRows, bookRows, currencyRows] = await Promise.all([
    allRecords<Row>('/md/partners', { status: 'ENABLED' }), allRecords<Row>('/md/fund-accounts', { status: 'ENABLED' }),
    allRecords<Row>('/org/books', { status: 'ACTIVE' }), allRecords<Row>('/md/currencies', { status: 'ENABLED' }),
  ])
  partners.value = partnerRows; allAccounts.value = accountRows; books.value = bookRows.filter(book => book.status === 'ACTIVE'); currencies.value = currencyRows
  Object.assign(form, { visible: true, bookId: books.value.length === 1 ? books.value[0]!.id : undefined, partnerId: undefined, currency: country.currency || '', amount: 0, fundAccountId: undefined, referenceNo: '', payDate: todayIn(country.timezone) })
  bookChanged()
}

function bookChanged() {
  form.fundAccountId = undefined
  const book = books.value.find(b => b.id === form.bookId)
  accounts.value = book ? allAccounts.value.filter(a => a.entityId === book.entityId && (a.bookId == null || a.bookId === book.id)) : []
}
async function save() {
  if (!form.bookId || !accounts.value.some(a => a.id === form.fundAccountId && a.currency === form.currency)) return ElMessage.warning('请选择账套及对应币种的付款账户')
  form.saving = true
  try {
    await http.postIdem('/ap/prepayments', form, saveIntent)
    ElMessage.success('已登记预付')
    form.visible = false
    page.value?.reload()
  } finally {
    form.saving = false
  }
}
function confirm(row: Row) {
  Object.assign(confirmation, { visible: true, row, referenceNo: row.referenceNo || '', key: createCommandIntent() })
}
async function doConfirm() {
  if (!confirmation.referenceNo.trim()) return ElMessage.warning('请填写实际付款参考号并上传凭证')
  confirmation.saving = true
  try {
    await http.postIdem(`/ap/prepayments/${confirmation.row!.id}/confirm`, { referenceNo: confirmation.referenceNo }, confirmation.key)
    ElMessage.success('已确认预付')
    confirmation.visible = false
    page.value?.reload()
  } finally { confirmation.saving = false }
}
</script>

<template>
  <CrudPage ref="page" title="预付款" resource="/ap/prepayments" :columns="columns" :can-create="false" :can-toggle="false" :actions-width="100">
    <template #toolbar><el-button v-if="user.hasPerm('ap:prepayment:create')" type="primary" @click="open">登记预付</el-button></template>
    <template #col-amount="{ row }"><MoneyText :value="row.amount" :currency="row.currency" /></template>
    <template #col-openAmount="{ row }"><MoneyText :value="row.openAmount" :currency="row.currency" /></template>
    <template #row-actions="{ row }">
      <el-button v-if="row.status === 'PENDING_CONFIRM' && user.hasPerm('ap:prepayment:create')" link type="primary" @click="confirm(row)">确认</el-button>
    </template>
  </CrudPage>
  <el-dialog v-model="form.visible" title="登记预付" width="460px">
    <el-form label-width="88px">
      <el-form-item label="账套" required><el-select v-model="form.bookId" @change="bookChanged"><el-option v-for="b in books" :key="b.id" :label="b.name" :value="b.id" /></el-select></el-form-item>
      <el-form-item label="往来对象"><el-select v-model="form.partnerId" filterable style="width:100%"><el-option v-for="p in partners" :key="p.id" :label="p.name" :value="p.id" /></el-select></el-form-item>
      <el-form-item label="币种"><el-select v-model="form.currency" @change="form.fundAccountId = undefined"><el-option v-for="c in currencies" :key="c.code" :label="c.code" :value="c.code" /></el-select></el-form-item>
      <el-form-item label="付款日期" required><el-date-picker v-model="form.payDate" type="date" value-format="YYYY-MM-DD" /></el-form-item>
      <el-form-item label="金额"><el-input-number v-model="form.amount" :min="0.01" :precision="2" /></el-form-item>
      <el-form-item label="账户"><el-select v-model="form.fundAccountId" style="width:100%"><el-option v-for="a in accounts.filter((a) => a.currency === form.currency)" :key="a.id" :label="a.name" :value="a.id" /></el-select></el-form-item>
      <el-form-item label="参考号"><el-input v-model="form.referenceNo" /></el-form-item>
    </el-form>
    <template #footer>
      <el-button @click="form.visible = false">取消</el-button>
      <el-button type="primary" :loading="form.saving" @click="save">保存</el-button>
    </template>
  </el-dialog>
  <el-dialog v-model="confirmation.visible" title="确认预付" width="520px">
    <el-form label-width="88px">
      <el-form-item label="付款日期">{{ confirmation.row?.payDate }}</el-form-item>
      <el-form-item label="参考号" required><el-input v-model="confirmation.referenceNo" /></el-form-item>
    </el-form>
    <DocAttachment v-if="confirmation.row" :key="confirmation.row.id" biz-type="AP_PREPAYMENT" :biz-id="confirmation.row.id" category="PAYMENT_OUT_PROOF" />
    <template #footer>
      <el-button @click="confirmation.visible = false">取消</el-button>
      <el-button type="primary" :loading="confirmation.saving" @click="doConfirm">确认预付</el-button>
    </template>
  </el-dialog>
</template>
