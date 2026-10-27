<script setup lang="ts">
import { reactive, ref, watch } from 'vue'
import { useRoute } from 'vue-router'
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
const route = useRoute()
const saveIntent = createCommandIntent()
const confirmation = reactive({ visible: false, saving: false, row: null as Row | null, referenceNo: '', key: createCommandIntent() })
const evidence = reactive({ visible: false, row: null as Row | null, loading: false, error: '' })
let evidenceRequest = 0
function openEvidence(row: Row) {
  evidenceRequest++
  Object.assign(evidence, { visible: true, row, loading: false, error: '' })
}
watch(() => [route.query.sourceId, country.epoch], async ([sourceId]) => {
  const request = ++evidenceRequest
  Object.assign(evidence, { visible: false, row: null, loading: false, error: '' })
  if (sourceId == null || sourceId === '') return
  const id = Number(sourceId)
  Object.assign(evidence, { visible: true, loading: true })
  if (!Number.isSafeInteger(id) || id <= 0) {
    Object.assign(evidence, { loading: false, error: '付款单来源编号无效' })
    return
  }
  try {
    const row = await http.get<Row>(`/ap/payments/${id}`)
    if (!row || row.id !== id || typeof row.docNo !== 'string' || !row.docNo.trim()) {
      throw new Error('付款单数据不完整，请重试')
    }
    if (request === evidenceRequest) evidence.row = row
  } catch (error) {
    if (request === evidenceRequest) evidence.error = error instanceof Error ? error.message : '付款单读取失败，请重试'
  } finally {
    if (request === evidenceRequest) evidence.loading = false
  }
}, { immediate: true })
const page = ref<CrudPageExpose>()
const partners = ref<Row[]>([])
const accounts = ref<Row[]>([])
const allAccounts = ref<Row[]>([]), books = ref<Row[]>([]), currencies = ref<Row[]>([])
const form = reactive({ visible: false, saving: false, bookId: undefined as number | undefined, partnerId: undefined as number | undefined, payCurrency: '', payAmount: 0, fundAccountId: undefined as number | undefined, referenceNo: '', payDate: '' })
const columns: ColumnDef[] = [
  { prop: 'docNo', label: '付款单', width: 180 },
  { prop: 'partnerName', label: '往来对象', minWidth: 150 },
  { prop: 'payCurrency', label: '币种', width: 80 },
  { prop: 'payAmount', label: '金额', width: 130 },
  { prop: 'openAmount', label: '未核销', width: 130 },
  { prop: 'accountName', label: '账户', minWidth: 140 },
  { prop: 'status', label: '状态', type: 'status', width: 120 },
  { prop: 'referenceNo', label: '参考号', width: 140 },
]
async function open() {
  saveIntent.reset()
  const [partnerRows, accountRows, bookRows, currencyRows] = await Promise.all([
    allRecords<Row>('/md/partners', { status: 'ENABLED' }), allRecords<Row>('/md/fund-accounts', { status: 'ENABLED' }),
    allRecords<Row>('/org/books', { status: 'ACTIVE' }), allRecords<Row>('/md/currencies', { status: 'ENABLED' }),
  ])
  partners.value = partnerRows; allAccounts.value = accountRows; books.value = bookRows.filter(book => book.status === 'ACTIVE'); currencies.value = currencyRows
  Object.assign(form, { visible: true, bookId: books.value.length === 1 ? books.value[0]!.id : undefined, partnerId: undefined, payCurrency: country.currency || '', payAmount: 0, fundAccountId: undefined, referenceNo: '', payDate: todayIn(country.timezone) })
  bookChanged()
}

function bookChanged() {
  form.fundAccountId = undefined
  const book = books.value.find(b => b.id === form.bookId)
  accounts.value = book ? allAccounts.value.filter(a => a.entityId === book.entityId && (a.bookId == null || a.bookId === book.id)) : []
}
async function save() {
  if (!form.bookId || !accounts.value.some(a => a.id === form.fundAccountId && a.currency === form.payCurrency)) return ElMessage.warning('请选择账套及对应币种的付款账户')
  form.saving = true
  try {
    await http.postIdem('/ap/payments', form, saveIntent)
    ElMessage.success('已登记，确认后才能核销')
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
    await http.postIdem(`/ap/payments/${confirmation.row!.id}/confirm`, { referenceNo: confirmation.referenceNo }, confirmation.key)
    ElMessage.success('已确认付款')
    confirmation.visible = false
    page.value?.reload()
  } finally { confirmation.saving = false }
}
</script>

<template>
  <CrudPage ref="page" title="付款登记" resource="/ap/payments" :columns="columns" :can-create="false" :can-toggle="false" :actions-width="160">
    <template #toolbar><el-button v-if="user.hasPerm('ap:payment:create')" type="primary" @click="open">登记付款</el-button></template>
    <template #header><p class="muted">这里只登记付款结果，不向银行发起转账。</p></template>
    <template #col-payAmount="{ row }"><MoneyText :value="row.payAmount" :currency="row.payCurrency" /></template>
    <template #col-openAmount="{ row }"><MoneyText :value="row.openAmount" :currency="row.payCurrency" /></template>
    <template #row-actions="{ row }">
      <el-button link type="primary" @click="openEvidence(row)">查看凭证</el-button>
      <el-button v-if="row.status === 'PENDING_CONFIRM' && user.hasPerm('ap:payment:confirm')" link type="primary" @click="confirm(row)">确认</el-button>
    </template>
  </CrudPage>
  <el-dialog v-model="evidence.visible" title="付款凭证" width="640px" destroy-on-close>
    <p v-if="evidence.loading" class="muted" role="status">正在读取付款单…</p>
    <p v-else-if="evidence.error" role="alert">{{ evidence.error }}</p>
    <template v-else-if="evidence.row">
      <p>{{ evidence.row.docNo }} · {{ evidence.row.referenceNo }}</p>
      <DocAttachment :key="evidence.row.id" biz-type="AP_PAYMENT" :biz-id="evidence.row.id" category="PAYMENT_OUT_PROOF" readonly />
    </template>
    <template #footer><el-button @click="evidence.visible = false">关闭</el-button></template>
  </el-dialog>
  <el-dialog v-model="form.visible" title="登记付款" width="480px">
    <el-form label-width="88px">
      <el-form-item label="账套" required><el-select v-model="form.bookId" @change="bookChanged"><el-option v-for="b in books" :key="b.id" :label="b.name" :value="b.id" /></el-select></el-form-item>
      <el-form-item label="往来对象"><el-select v-model="form.partnerId" filterable style="width:100%"><el-option v-for="p in partners" :key="p.id" :label="p.name" :value="p.id" /></el-select></el-form-item>
      <el-form-item label="币种"><el-select v-model="form.payCurrency" @change="form.fundAccountId = undefined"><el-option v-for="c in currencies" :key="c.code" :label="c.code" :value="c.code" /></el-select></el-form-item>
      <el-form-item label="付款日期" required><el-date-picker v-model="form.payDate" type="date" value-format="YYYY-MM-DD" /></el-form-item>
      <el-form-item label="金额"><el-input-number v-model="form.payAmount" :min="0.01" :precision="2" /></el-form-item>
      <el-form-item label="账户"><el-select v-model="form.fundAccountId" style="width:100%"><el-option v-for="a in accounts.filter(a => a.currency === form.payCurrency)" :key="a.id" :label="a.name" :value="a.id" /></el-select></el-form-item>
      <el-form-item label="参考号"><el-input v-model="form.referenceNo" /></el-form-item>
    </el-form>
    <template #footer>
      <el-button @click="form.visible = false">取消</el-button>
      <el-button type="primary" :loading="form.saving" @click="save">保存</el-button>
    </template>
  </el-dialog>
  <el-dialog v-model="confirmation.visible" title="确认付款" width="520px">
    <el-form label-width="88px">
      <el-form-item label="付款日期">{{ confirmation.row?.payDate }}</el-form-item>
      <el-form-item label="参考号" required><el-input v-model="confirmation.referenceNo" /></el-form-item>
    </el-form>
    <DocAttachment v-if="confirmation.row" :key="confirmation.row.id" biz-type="AP_PAYMENT" :biz-id="confirmation.row.id" category="PAYMENT_OUT_PROOF" />
    <template #footer>
      <el-button @click="confirmation.visible = false">取消</el-button>
      <el-button type="primary" :loading="confirmation.saving" @click="doConfirm">确认付款</el-button>
    </template>
  </el-dialog>
</template>
