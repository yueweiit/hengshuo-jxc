<script setup lang="ts">
import { reactive, ref } from 'vue'
import { useRouter } from 'vue-router'
import { ElMessage } from 'element-plus'
import { http, createCommandIntent } from '@/api/http'
import { allRecords } from '@/api/pagination'
import { useUserStore } from '@/stores/user'
import CrudPage from '@/components/crud/CrudPage.vue'
import MoneyText from '@/components/MoneyText.vue'
import type { ColumnDef, CrudPageExpose, FieldDef } from '@/components/crud/types'
import { AP_BILL_STATUS, PARTNER_SOURCE } from '@/modules/shared/bizOptions'

const actionIntent = createCommandIntent()

const createIntent = createCommandIntent()

type Row = Record<string, any> // eslint-disable-line @typescript-eslint/no-explicit-any
const router = useRouter()
const user = useUserStore()
const page = ref<CrudPageExpose>()
const sources = reactive({ poLines: [] as Row[], fees: [] as Row[], picked: [] as Row[] })
const visible = ref(false)
const recognitionDialog = ref(false), recognitionBusy = ref(false), executionSubjects = ref<Row[]>([]), recognitionIntent = createCommandIntent()
const recognitionForm = reactive<{ sourceKind: string; mode: string; executionSubjectUserId: number | null; version?: number }>({ sourceKind: 'PURCHASE', mode: 'BILL_CONFIRMED', executionSubjectUserId: null })
async function loadRecognition() { const rule = await http.get<Row>('/ap/recognition-rules/' + recognitionForm.sourceKind); recognitionForm.mode = rule.mode; recognitionForm.version = rule.version; recognitionForm.executionSubjectUserId = rule.executionSubjectUserId ?? null; recognitionIntent.reset() }
async function showRecognition() { await loadRecognition(); if (user.hasPerm('sys:user:view')) executionSubjects.value = (await allRecords<Row>('/sys/users')).filter(u => u.status === 'ENABLED'); recognitionDialog.value = true }
async function saveRecognition() { if (recognitionBusy.value) return; recognitionBusy.value = true; try { await http.putIdem('/ap/recognition-rules/' + recognitionForm.sourceKind, { mode: recognitionForm.mode, executionSubjectUserId: recognitionForm.mode === 'RECEIPT_CONFIRMED' ? recognitionForm.executionSubjectUserId : null, ...(recognitionForm.version ? { version: recognitionForm.version } : {}) }, recognitionIntent); await loadRecognition(); ElMessage.success('应付确认规则已保存') } finally { recognitionBusy.value = false } }
const columns: ColumnDef[] = [
  { prop: 'docNo', label: '账单', width: 180 },
  { prop: 'partnerName', label: '往来对象', minWidth: 150 },
  { prop: 'billType', label: '类型', type: 'status', width: 110 },
  { prop: 'currency', label: '币种', width: 80 },
  { prop: 'amount', label: '金额', width: 130 },
  { prop: 'openAmount', label: '未付', width: 130 },
  { prop: 'billDate', label: '账单日', type: 'date', width: 110 },
  { prop: 'dueDate', label: '到期', type: 'date', width: 110 },
  { prop: 'status', label: '状态', type: 'status', width: 100 },
]
const searchFields: FieldDef[] = [
  { prop: 'keyword', label: '单号' },
  { prop: 'partnerId', label: '往来对象', type: 'select', options: PARTNER_SOURCE },
  { prop: 'status', label: '状态', type: 'select', options: AP_BILL_STATUS },
]
function pickPo(rows: Row[]) {
  sources.picked = [...rows, ...sources.picked.filter((p) => p.sourceType === 'LGS_FEE')]
}
function pickFee(rows: Row[]) {
  sources.picked = [...sources.picked.filter((p) => p.sourceType !== 'LGS_FEE'), ...rows]
}
async function open() {
  createIntent.reset()
  const res = await http.get<{ poLines: Row[]; fees: Row[] }>('/ap/bill-sources')
  sources.poLines = res.poLines
  sources.fees = res.fees
  sources.picked = []
  visible.value = true
}
async function create() {
  if (!sources.picked.length) return ElMessage.warning('请选择来源')
  await http.postIdem('/ap/bills/from-sources', {
    sources: sources.picked.map((s) => (s.sourceType === 'LGS_FEE' ? s : { ...s, qty: Math.min(s.qty, s.openQty) })),
  }, createIntent)
  ElMessage.success('已生成草稿账单')
  visible.value = false
  page.value?.reload()
}
async function confirm(row: Row) {
  await http.postIdem(`/ap/bills/${row.id}/confirm`, {}, actionIntent)
  ElMessage.success('已确认应付')
  page.value?.reload()
}
</script>

<template>
  <CrudPage ref="page" title="应付账单" resource="/ap/bills" :columns="columns" :search-fields="searchFields" :can-create="false" :can-toggle="false" :actions-width="160">
    <template #toolbar><el-button v-if="user.hasPerm('ap:bill:create')" type="primary" @click="open">从来源生成</el-button><el-button v-if="user.hasPerm('ap:recognition:edit')" @click="showRecognition">应付确认规则</el-button></template>
    <template #header><p class="muted">一张账单只包含同一往来对象、同一币种。物流费用不能重复进入有效账单。</p></template>
    <template #col-partnerName="{ row }"><el-link type="primary" @click="router.push({ path: `/ap/partners/${row.partnerId}`, query: { bookId: row.bookId } })">{{ row.partnerName }}</el-link></template>
    <template #col-amount="{ row }"><MoneyText :value="row.amount" :currency="row.currency" /></template>
    <template #col-openAmount="{ row }"><MoneyText :value="row.openAmount" :currency="row.currency" /></template>
    <template #row-actions="{ row }">
      <el-button v-if="row.status === 'DRAFT' && user.hasPerm('ap:bill:confirm')" link type="primary" @click="confirm(row)">确认</el-button>
    </template>
  </CrudPage>
  <el-dialog v-model="visible" title="选择账单来源" width="760px">
    <h4>采购订单 / 已确认国内收货</h4>
    <el-table :data="sources.poLines" size="small" @selection-change="pickPo">
      <el-table-column type="selection" width="42" />
      <el-table-column prop="sourceNo" label="来源" width="180" />
      <el-table-column label="供应商"><template #default="{ row }">{{ row.partnerName || '#' + row.partnerId }}</template></el-table-column>
      <el-table-column label="可开数量" width="115"><template #default="{ row }">{{ row.openQty }} {{ row.unit || '' }}</template></el-table-column>
      <el-table-column prop="currency" label="币种" width="70" />
      <el-table-column prop="unitPrice" label="单价" width="90" />
    </el-table>
    <h4>物流费用</h4>
    <el-table :data="sources.fees" size="small" @selection-change="pickFee">
      <el-table-column type="selection" width="42" />
      <el-table-column prop="sourceNo" label="费用单" width="180" />
      <el-table-column prop="partnerName" label="物流商" />
      <el-table-column prop="currency" label="币种" width="70" />
      <el-table-column prop="amount" label="金额" width="120" />
    </el-table>
    <template #footer>
      <el-button @click="visible = false">取消</el-button>
      <el-button type="primary" @click="create">生成草稿</el-button>
    </template>
  </el-dialog>
  <el-dialog v-model="recognitionDialog" title="本国家应付确认规则" width="620px" :close-on-click-modal="!recognitionBusy"><p>默认按账单确认形成应付。收货触发仅生成原生草稿账单，财务仍须在账单页确认；不会自动记账。</p><el-form label-width="110px" :disabled="recognitionBusy"><el-form-item label="来源类型"><el-select v-model="recognitionForm.sourceKind" @change="loadRecognition"><el-option label="采购" value="PURCHASE" /><el-option label="物流费用" value="LOGISTICS" /><el-option label="其他" value="OTHER" /></el-select></el-form-item><el-form-item label="规则"><el-select v-model="recognitionForm.mode"><el-option label="账单确认（默认）" value="BILL_CONFIRMED" /><el-option label="人工生成并确认" value="MANUAL" /><el-option v-if="recognitionForm.sourceKind !== 'OTHER'" label="来源确认后生成草稿" value="RECEIPT_CONFIRMED" /></el-select></el-form-item><el-form-item v-if="recognitionForm.mode === 'RECEIPT_CONFIRMED'" label="执行账号"><el-select v-if="executionSubjects.length" v-model="recognitionForm.executionSubjectUserId" filterable><el-option v-for="subject in executionSubjects" :key="subject.id" :value="subject.id" :label="subject.displayName + ' · ' + subject.username" /></el-select><el-input-number v-else v-model="recognitionForm.executionSubjectUserId" :min="1" :controls="false" placeholder="执行账号 ID" /></el-form-item></el-form><p v-if="recognitionForm.mode === 'RECEIPT_CONFIRMED'" class="muted">后台每次处理都核验执行账号当前的草稿创建、成本字段和账套范围权限。账号停用或权限撤销时停止处理。</p><template #footer><el-button @click="recognitionDialog = false">关闭</el-button><el-button type="primary" :loading="recognitionBusy" :disabled="recognitionForm.mode === 'RECEIPT_CONFIRMED' && !recognitionForm.executionSubjectUserId" @click="saveRecognition">保存配置</el-button></template></el-dialog>
</template>
