<script setup lang="ts">
import { onMounted, reactive, ref } from 'vue'
import { ElMessage } from 'element-plus'
import { http } from '@/api/http'
import { allRecords } from '@/api/pagination'
import { useUserStore } from '@/stores/user'
import { useCountryStore } from '@/stores/country'
import CrudPage from '@/components/crud/CrudPage.vue'
import MoneyText from '@/components/MoneyText.vue'
import type { ColumnDef, CrudPageExpose } from '@/components/crud/types'

type Row = Record<string, any> // eslint-disable-line @typescript-eslint/no-explicit-any
const user = useUserStore()
const country = useCountryStore()
const page = ref<CrudPageExpose>()
const customers = ref<Row[]>([])
const groups = ref<Row[]>([])
const impact = ref<Row | null>(null)
const form = reactive({ visible: false, saving: false, id: 0, targetType: 'CUSTOMER', targetId: undefined as number | undefined, paymentMode: 'CREDIT_ALLOWED', creditLimit: 0, termDays: 30, dueBasis: 'OUTBOUND_DATE', dueExtraDays: 0, effectiveFrom: '', effectiveTo: undefined as string | undefined, overduePolicy: 'WARN', allowException: false, graceDays: 0 })
const columns: ColumnDef[] = [
  { prop: 'targetName', label: '适用对象', minWidth: 160 },
  { prop: 'targetType', label: '范围', width: 90 },
  { prop: 'paymentMode', label: '方式', type: 'status', width: 110 },
  { prop: 'creditLimit', label: '额度', width: 130 },
  { prop: 'termDays', label: '账期(天)', width: 90 },
  { prop: 'dueBasis', label: '起算', width: 140 },
  { prop: 'overduePolicy', label: '逾期策略', width: 120 },
  { prop: 'versionNo', label: '版本', width: 70 },
  { prop: 'status', label: '状态', type: 'status', width: 90 },
]
async function open(row?: Row) {
  await loadReferences()
  Object.assign(form, row ? { ...row, visible: true } : { visible: true, id: 0, targetType: 'CUSTOMER', targetId: undefined, paymentMode: 'CREDIT_ALLOWED', creditLimit: 0, termDays: 30, dueBasis: 'OUTBOUND_DATE', dueExtraDays: 0, effectiveFrom: '', effectiveTo: undefined as string | undefined, overduePolicy: 'WARN', allowException: false, graceDays: 0 })
  form.visible = true
}
async function loadReferences() {
  if (!user.hasPerm(['md:customer:view', 'md:customer:edit'])) {
    customers.value = []
    groups.value = []
    return
  }
  const epoch = country.epoch
  const [customerRows, groupRows] = await Promise.all([
    allRecords<Row>('/md/customers'), allRecords<Row>('/md/customer-groups'),
  ])
  if (country.epoch !== epoch) return
  customers.value = customerRows
  groups.value = groupRows
}
function targetLabel(row: Row) {
  const references = row.targetType === 'GROUP' ? groups.value : customers.value
  return row.targetName || references.find(target => target.id === row.targetId)?.name || `${row.targetType === 'GROUP' ? '客户组' : '客户'} #${row.targetId}`
}
onMounted(loadReferences)
async function save() {
  if (!form.effectiveFrom) return ElMessage.warning('请选择规则生效日')
  form.saving = true
  try {
    if (form.id) await http.put(`/ar/credit-rules/${form.id}`, form)
    else await http.post('/ar/credit-rules', form)
    ElMessage.success('已保存为新版本')
    form.visible = false
    page.value?.reload()
  } finally {
    form.saving = false
  }
}
async function preview(row: Row) {
  impact.value = await http.post(`/ar/credit-rules/${row.id}/preview-impact`, {})
  ElMessage.info(`仍有未出库的赊销订单 ${impact.value?.openOrderCount ?? 0} 张，新规则不追溯这些订单`)
}
</script>

<template>
  <CrudPage ref="page" title="授信规则" resource="/ar/credit-rules" :columns="columns" :can-create="false" :can-toggle="false" :actions-width="160">
    <template #toolbar><el-button v-if="user.hasPerm('ar:credit-rule:edit')" type="primary" @click="open()">新增规则</el-button></template>
    <template #header><p class="muted">客户规则优先于客户组。没有规则的客户只能现款。修改生成新版本，已发生的应收仍用当时版本算到期日。</p></template>
    <template #col-targetName="{ row }">{{ targetLabel(row) }}</template>
    <template #col-creditLimit="{ row }"><MoneyText :value="row.creditLimit" :currency="row.currency" /></template>
    <template #row-actions="{ row }">
      <el-button v-if="user.hasPerm('ar:credit-rule:edit')" link type="primary" @click="open(row)">新版本</el-button>
      <el-button v-if="row.status === 'ACTIVE'" link @click="preview(row)">影响</el-button>
    </template>
  </CrudPage>
  <el-dialog v-model="form.visible" title="授信规则" width="520px">
    <el-form label-width="100px">
      <el-form-item label="适用">
        <el-radio-group v-model="form.targetType"><el-radio-button value="CUSTOMER">客户</el-radio-button><el-radio-button value="GROUP">客户组</el-radio-button></el-radio-group>
      </el-form-item>
      <el-form-item label="对象">
        <el-select v-model="form.targetId" filterable style="width:100%">
          <el-option v-for="c in (form.targetType === 'GROUP' ? groups : customers).filter(target => target.status === 'ENABLED')" :key="c.id" :label="c.name" :value="c.id" />
        </el-select>
      </el-form-item>
      <el-form-item label="资格"><el-radio-group v-model="form.paymentMode"><el-radio-button value="CASH_ONLY">仅现款</el-radio-button><el-radio-button value="CREDIT_ALLOWED">允许赊销</el-radio-button></el-radio-group></el-form-item>
      <el-form-item label="额度"><el-input-number v-model="form.creditLimit" :min="0" :precision="2" /></el-form-item>
      <el-form-item label="账期"><el-input-number v-model="form.termDays" :min="0" /></el-form-item>
      <el-form-item label="到期起算"><el-select v-model="form.dueBasis"><el-option label="出库日" value="OUTBOUND_DATE" /><el-option label="月末加天数" value="MONTH_END_PLUS" /></el-select></el-form-item>
      <el-form-item label="逾期"><el-select v-model="form.overduePolicy"><el-option label="仅预警" value="WARN" /><el-option label="须例外审批" value="REQUIRE_APPROVAL" /><el-option label="禁止下单" value="BLOCK_ORDER" /><el-option label="禁止出库" value="BLOCK_OUTBOUND" /></el-select></el-form-item>
      <el-form-item label="宽限天数"><el-input-number v-model="form.graceDays" :min="0" :precision="0" /></el-form-item>
      <el-form-item label="超额例外"><el-switch v-model="form.allowException" /><span class="muted">允许申请，仍须审批通过</span></el-form-item>
      <el-form-item v-if="form.dueBasis === 'MONTH_END_PLUS'" label="月结加天"><el-input-number v-model="form.dueExtraDays" :min="0" /></el-form-item>
      <el-form-item label="生效日"><el-date-picker v-model="form.effectiveFrom" value-format="YYYY-MM-DD" /></el-form-item>
      <el-form-item label="失效日"><el-date-picker v-model="form.effectiveTo" clearable value-format="YYYY-MM-DD" /></el-form-item>
    </el-form>
    <template #footer>
      <el-button @click="form.visible = false">取消</el-button>
      <el-button type="primary" :loading="form.saving" @click="save">保存</el-button>
    </template>
  </el-dialog>
</template>
