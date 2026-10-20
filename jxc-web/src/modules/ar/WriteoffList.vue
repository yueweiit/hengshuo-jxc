<script setup lang="ts">
import { reactive, ref } from 'vue'
import { ElMessage, ElMessageBox } from 'element-plus'
import { http, createCommandIntent } from '@/api/http'
import { allRecords } from '@/api/pagination'
import { useUserStore } from '@/stores/user'
import CrudPage from '@/components/crud/CrudPage.vue'
import type { ColumnDef, CrudPageExpose } from '@/components/crud/types'

type Row = Record<string, any> // eslint-disable-line @typescript-eslint/no-explicit-any
const user = useUserStore()
const reverseIntent = createCommandIntent()
const page = ref<CrudPageExpose>()
const customers = ref<Row[]>([]), books = ref<Row[]>([])
const recv = ref<Row[]>([])
const sources = ref<Row[]>([])
const form = reactive({ visible: false, saving: false, bookId: undefined as number | undefined, customerId: undefined as number | undefined, fromType: 'RECEIPT', fromId: undefined as number | undefined, receivableId: undefined as number | undefined, amount: 0, key: createCommandIntent() })
const columns: ColumnDef[] = [
  { prop: 'docNo', label: '核销单', width: 180 },
  { prop: 'bizDate', label: '日期', type: 'date', width: 110 },
  { prop: 'reason', label: '说明', minWidth: 180 },
  { prop: 'status', label: '状态', type: 'status', width: 100 },
]
async function open() {
  customers.value = await allRecords<Row>('/md/customers', { status: 'ENABLED' })
  books.value = await http.get<Row[]>('/org/books')
  Object.assign(form, { visible: true, bookId: books.value.length === 1 ? books.value[0]!.id : undefined, customerId: undefined, fromType: 'RECEIPT', fromId: undefined, receivableId: undefined, amount: 0, key: createCommandIntent() })
}
let sourceRequest = 0
async function loadSources() {
  const request = ++sourceRequest, customer = form.customerId, book = form.bookId, type = form.fromType
  recv.value = []; sources.value = []; form.fromId = undefined; form.receivableId = undefined
  if (!customer || !book) return
  const [open, partial, available] = await Promise.all([
    allRecords<Row>('/ar/receivables', { customerId: customer, settleStatus: 'OPEN' }),
    allRecords<Row>('/ar/receivables', { customerId: customer, settleStatus: 'PARTIAL' }),
    allRecords<Row>(type === 'RECEIPT' ? '/ar/receipts' : '/ar/credit-notes', { customerId: customer }),
  ])
  if (request !== sourceRequest || customer !== form.customerId || book !== form.bookId || type !== form.fromType) return
  recv.value = [...open, ...partial].filter(row => row.bookId === book)
  sources.value = available.filter(row => row.bookId === book && (type !== 'RECEIPT' || ['CONFIRMED', 'PARTIAL_WRITTEN_OFF'].includes(row.status)))
}
async function save() {
  if (!form.bookId || !form.fromId || !form.receivableId) return ElMessage.warning('请选择同一账套的来源和应收')
  form.saving = true
  try {
    await http.postIdem('/ar/writeoffs', { customerId: form.customerId, lines: [{ fromType: form.fromType, fromId: form.fromId, receivableId: form.receivableId, amount: form.amount }] }, form.key)
    ElMessage.success('已核销')
    form.visible = false
    page.value?.reload()
  } finally {
    form.saving = false
  }
}
async function reverse(row: Row) {
  const { value } = await ElMessageBox.prompt('撤销原因', '撤销核销')
  await http.postIdem(`/ar/writeoffs/${row.id}/reverse`, { reason: value }, reverseIntent)
  ElMessage.success('已撤销')
  page.value?.reload()
}
</script>

<template>
  <CrudPage ref="page" title="应收核销" resource="/ar/writeoffs" :columns="columns" :can-create="false" :can-toggle="false" :actions-width="100">
    <template #toolbar><el-button v-if="user.hasPerm('ar:writeoff:create')" type="primary" @click="open">核销</el-button></template>
    <template #header><p class="muted">只能核销已确认的收款或贷项，金额不能超过来源余额和应收未结。撤销会把两边余额加回去。</p></template>
    <template #row-actions="{ row }">
      <el-button v-if="row.status === 'EFFECTIVE' && user.hasPerm('ar:writeoff:reverse')" link type="danger" @click="reverse(row)">撤销</el-button>
    </template>
  </CrudPage>
  <el-dialog v-model="form.visible" title="核销应收" width="520px">
    <el-form label-width="88px">
      <el-form-item label="账套"><el-select v-model="form.bookId" style="width:100%" @change="loadSources"><el-option v-for="book in books" :key="book.id" :label="book.name" :value="book.id" /></el-select></el-form-item>
      <el-form-item label="客户"><el-select v-model="form.customerId" filterable style="width:100%" @change="loadSources"><el-option v-for="c in customers" :key="c.id" :label="c.name" :value="c.id" /></el-select></el-form-item>
      <el-form-item label="来源"><el-radio-group v-model="form.fromType" @change="loadSources"><el-radio-button value="RECEIPT">收款</el-radio-button><el-radio-button value="CREDIT_NOTE">贷项</el-radio-button></el-radio-group></el-form-item>
      <el-form-item label="来源单"><el-select v-model="form.fromId" style="width:100%"><el-option v-for="s in sources" :key="s.id" :label="`${s.docNo} 余 ${s.openAmount}`" :value="s.id" /></el-select></el-form-item>
      <el-form-item label="应收"><el-select v-model="form.receivableId" style="width:100%"><el-option v-for="r in recv" :key="r.id" :label="`${r.docNo} 未结 ${r.openAmount}`" :value="r.id" /></el-select></el-form-item>
      <el-form-item label="金额"><el-input-number v-model="form.amount" :min="0.01" :precision="2" /></el-form-item>
    </el-form>
    <template #footer>
      <el-button @click="form.visible = false">取消</el-button>
      <el-button type="primary" :loading="form.saving" @click="save">确认核销</el-button>
    </template>
  </el-dialog>
</template>
