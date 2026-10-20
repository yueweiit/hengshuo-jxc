<script setup lang="ts">
import { reactive, ref } from 'vue'
import { ElMessage } from 'element-plus'
import { http, createCommandIntent } from '@/api/http'
import { allRecords } from '@/api/pagination'
import CrudPage from '@/components/crud/CrudPage.vue'
import MoneyText from '@/components/MoneyText.vue'
import { useRouter } from 'vue-router'
import { useUserStore } from '@/stores/user'
import type { ColumnDef, CrudPageExpose } from '@/components/crud/types'

type Row = Record<string, any> // eslint-disable-line @typescript-eslint/no-explicit-any
const page = ref<CrudPageExpose>()
const createIntent = createCommandIntent(), exportIntent = createCommandIntent()
const router = useRouter(), user = useUserStore()
const books = ref<Row[]>([])
const customers = ref<Row[]>([])
const form = reactive({ visible: false, saving: false, bookId: undefined as number | undefined, customerId: undefined as number | undefined, periodStart: '', periodEnd: '' })
const columns: ColumnDef[] = [
  { prop: 'customerName', label: '客户', minWidth: 150 },
  { prop: 'periodStart', label: '开始', type: 'date', width: 110 },
  { prop: 'periodEnd', label: '结束', type: 'date', width: 110 },
  { prop: 'opening', label: '期初', width: 120 },
  { prop: 'increase', label: '增加', width: 120 },
  { prop: 'decrease', label: '减少', width: 120 },
  { prop: 'closing', label: '期末', width: 120 },
]
async function open() {
  createIntent.reset()
  customers.value = await allRecords<Row>('/md/customers', { status: 'ENABLED' })
  books.value = await http.get<Row[]>('/org/books')
  form.bookId = books.value.length === 1 ? books.value[0]!.id : undefined
  form.visible = true
}
async function save() {
  if (!form.bookId) return ElMessage.warning('请选择对账账套')
  form.saving = true
  try {
    const res = await http.postIdem<Row>('/ar/statements', { bookId: form.bookId, customerId: form.customerId, periodStart: form.periodStart, periodEnd: form.periodEnd }, createIntent)
    ElMessage.success(res.identityOk ? '对账单已生成，期末等于明细合计' : '已生成，请核对期末与明细')
    form.visible = false
    page.value?.reload()
  } finally {
    form.saving = false
  }
}
async function exportStatement(row: Row) { if (!row.id || !row.bookId) return; await http.postIdem('/ar/statements/export', { statementId: row.id, bookId: row.bookId }, exportIntent); exportIntent.reset(); ElMessage.success('导出任务已创建'); await router.push('/jobs') }
</script>

<template>
  <CrudPage ref="page" title="客户对账单" resource="/ar/statements" :columns="columns" :can-create="false" :can-toggle="false" :actions-width="120">
    <template #toolbar><el-button type="primary" @click="open">生成对账单</el-button></template>
    <template #row-actions="{ row }"><el-button v-if="user.hasPerm('ar:statement:export')" link @click="exportStatement(row)">导出已保存对账单</el-button></template>
    <template #header><p class="muted">期末 = 期初 + 本期增加 − 本期减少，并与明细合计核对。</p></template>
    <template #col-opening="{ row }"><MoneyText :value="row.opening" :currency="row.currency" /></template>
    <template #col-increase="{ row }"><MoneyText :value="row.increase" :currency="row.currency" /></template>
    <template #col-decrease="{ row }"><MoneyText :value="row.decrease" :currency="row.currency" /></template>
    <template #col-closing="{ row }"><MoneyText :value="row.closing" :currency="row.currency" /></template>
  </CrudPage>
  <el-dialog v-model="form.visible" title="生成对账单" width="460px">
    <el-form label-width="88px">
      <el-form-item label="账套"><el-select v-model="form.bookId" style="width:100%"><el-option v-for="book in books" :key="book.id" :label="book.name" :value="book.id" /></el-select></el-form-item>
      <el-form-item label="客户"><el-select v-model="form.customerId" filterable style="width:100%"><el-option v-for="c in customers" :key="c.id" :label="c.name" :value="c.id" /></el-select></el-form-item>
      <el-form-item label="开始"><el-date-picker v-model="form.periodStart" value-format="YYYY-MM-DD" /></el-form-item>
      <el-form-item label="结束"><el-date-picker v-model="form.periodEnd" value-format="YYYY-MM-DD" /></el-form-item>
    </el-form>
    <template #footer>
      <el-button @click="form.visible = false">取消</el-button>
      <el-button type="primary" :loading="form.saving" @click="save">生成</el-button>
    </template>
  </el-dialog>
</template>
