<script setup lang="ts">
import { reactive, ref } from 'vue'
import { ElMessage } from 'element-plus'
import { useCountryStore } from '@/stores/country'
import { todayIn } from '@/utils/format'
import { http, createCommandIntent } from '@/api/http'
import { allRecords } from '@/api/pagination'
import CrudPage from '@/components/crud/CrudPage.vue'
import MoneyText from '@/components/MoneyText.vue'
import type { ColumnDef, CrudPageExpose } from '@/components/crud/types'

const createIntent = createCommandIntent()
const resolveIntent = createCommandIntent()

const country = useCountryStore()
type Row = Record<string, any> // eslint-disable-line @typescript-eslint/no-explicit-any
const page = ref<CrudPageExpose>()
const partners = ref<Row[]>([])
const books = ref<Row[]>([])
const form = reactive({ bookId: undefined as number | undefined, bizDate: '', visible: false, saving: false, partnerId: undefined as number | undefined, claimType: 'DAMAGE', againstType: 'CARRIER', claimAmount: 0, currency: country.currency, remark: '' })
const columns: ColumnDef[] = [
  { prop: 'docNo', label: '索赔单', width: 180 },
  { prop: 'partnerName', label: '对象', minWidth: 150 },
  { prop: 'claimType', label: '类型', width: 100 },
  { prop: 'currency', label: '币种', width: 70 },
  { prop: 'claimAmount', label: '索赔额', width: 120 },
  { prop: 'compensatedAmount', label: '获赔', width: 120 },
  { prop: 'result', label: '结果', type: 'status', width: 100 },
]
async function open() {
  createIntent.reset()
  books.value = await allRecords<Row>('/org/books')
  Object.assign(form, { bookId: books.value.length === 1 ? books.value[0]?.id : undefined, bizDate: todayIn(country.timezone), partnerId: undefined, currency: country.currency })
  await loadPartners()
  form.visible = true
}
async function loadPartners() {
  form.partnerId = undefined
  partners.value = await allRecords<Row>('/md/partners', { status: 'ENABLED', partnerType: form.againstType === 'SUPPLIER' ? 'SUPPLIER' : 'LOGISTICS' })
}
async function save() {
  if (!form.bookId || !form.bizDate) return ElMessage.warning('请选择账套与业务日期')
  form.saving = true
  try {
    await http.postIdem('/rtn/claims', form, createIntent)
    ElMessage.success('已登记索赔')
    form.visible = false
    page.value?.reload()
  } finally {
    form.saving = false
  }
}
async function resolve(row: Row, result: string) {
  await http.postIdem(`/rtn/claims/${row.id}/resolve`, { result, compensatedAmount: row.claimAmount }, resolveIntent)
  ElMessage.success(result === 'COMPENSATED' ? '已获赔并生成贷项' : '已拒赔')
  page.value?.reload()
}
</script>

<template>
  <CrudPage ref="page" title="货损索赔" resource="/rtn/claims" :columns="columns" :can-create="false" :can-toggle="false" :actions-width="160">
    <template #toolbar><el-button type="primary" @click="open">登记索赔</el-button></template>
    <template #header><p class="muted">货损和索赔单独记账，不并进采购退货。</p></template>
    <template #col-claimAmount="{ row }"><MoneyText :value="row.claimAmount" :currency="row.currency" /></template>
    <template #col-compensatedAmount="{ row }"><MoneyText :value="row.compensatedAmount" :currency="row.currency" /></template>
    <template #row-actions="{ row }">
      <template v-if="row.result === 'PENDING'">
        <el-button link type="success" @click="resolve(row, 'COMPENSATED')">获赔</el-button>
        <el-button link type="danger" @click="resolve(row, 'REJECTED')">拒赔</el-button>
      </template>
    </template>
  </CrudPage>
  <el-dialog v-model="form.visible" title="登记索赔" width="460px">
    <el-form label-width="88px">
      <el-form-item label="账套" required><el-select v-model="form.bookId" style="width:100%"><el-option v-for="b in books" :key="b.id" :label="b.name" :value="b.id" /></el-select></el-form-item>
      <el-form-item label="业务日期" required><el-date-picker v-model="form.bizDate" type="date" value-format="YYYY-MM-DD" /></el-form-item>
      <el-form-item label="对象类型"><el-select v-model="form.againstType" @change="loadPartners"><el-option label="供应商" value="SUPPLIER" /><el-option label="物流商" value="CARRIER" /></el-select></el-form-item>
      <el-form-item label="对象"><el-select v-model="form.partnerId" filterable style="width:100%"><el-option v-for="p in partners" :key="p.id" :label="p.name" :value="p.id" /></el-select></el-form-item>
      <el-form-item label="类型"><el-select v-model="form.claimType"><el-option label="货损" value="DAMAGE" /><el-option label="其他索赔" value="CLAIM" /></el-select></el-form-item>
      <el-form-item label="币种"><el-input v-model="form.currency" maxlength="3" placeholder="已配置币种代码" /></el-form-item>
      <el-form-item label="金额"><el-input-number v-model="form.claimAmount" :min="0.01" :precision="2" /></el-form-item>
      <el-form-item label="说明"><el-input v-model="form.remark" /></el-form-item>
    </el-form>
    <template #footer>
      <el-button @click="form.visible = false">取消</el-button>
      <el-button type="primary" :loading="form.saving" @click="save">保存</el-button>
    </template>
  </el-dialog>
</template>
