<script setup lang="ts">
import { onMounted, reactive, ref, watch } from 'vue'
import { ElMessage } from 'element-plus'
import { http, createCommandIntent } from '@/api/http'
import StatusTag from '@/components/StatusTag.vue'
import { useCountryStore } from '@/stores/country'

const country = useCountryStore()
const intent = createCommandIntent()
const form = reactive({ importType: '', cutoffDate: '', text: '' })
const batch = ref<Record<string, any> | null>(null)
const types = ref<string[]>([])
const columns = ref<string[]>([])
const history = ref<Record<string, any>[]>([])
const busy = ref(false)
const labels: Record<string, string> = { PRODUCT: '商品、单位、条码', CUSTOMER: '客户、地址', SUPPLIER: '供应商', LOGISTICS_PROVIDER: '物流商', PRODUCT_UNIT: '商品单位', PRODUCT_BARCODE: '商品条码', CUSTOMER_ADDRESS: '客户地址', PRICE: '价格表', STOCK_LIMIT: '库存上下限', CREDIT_RULE: '授信规则', OPENING_STOCK: '期初库存', OPENING_AR: '期初应收', OPENING_ADVANCE: '期初预收', OPENING_AP: '期初应付', OPENING_PREPAYMENT: '期初预付', OPENING_GL: '期初科目余额', OPENING_PURCHASE: '期初未完采购', OPENING_TRANSIT: '期初在途' }
async function load() {
  types.value = await http.get<string[]>('/sys/import-types')
  history.value = (await http.get<{ records: Record<string, any>[] }>('/sys/imports')).records
  if (!types.value.includes(form.importType)) form.importType = types.value[0] ?? ''
}
watch(() => form.importType, async (type) => {
  batch.value = null
  intent.reset()
  columns.value = type ? (await http.get<{ columns: string[] }>('/sys/import-templates/' + type)).columns : []
})
watch(() => country.epoch, () => { batch.value = null; form.text = ''; form.cutoffDate = ''; load() })
function download(value: unknown, name: string) {
  const url = URL.createObjectURL(new Blob([JSON.stringify(value, null, 2)], { type: 'application/json;charset=utf-8' }))
  const a = document.createElement('a'); a.href = url; a.download = name; a.click(); URL.revokeObjectURL(url)
}
function template() { download([Object.fromEntries(columns.value.map((column) => [column, null]))], form.importType + '-template.json') }
async function upload(event: Event) {
  const input = event.target as HTMLInputElement
  const file = input.files?.[0]
  if (!file) return
  if (file.size > 2_000_000) { ElMessage.warning('文件不能超过 2 MB'); return }
  form.text = await file.text()
  batch.value = null
}
async function validate() {
  let rows: unknown
  try { rows = JSON.parse(form.text) } catch { ElMessage.warning('请上传或填写 JSON 行数组，数值不加引号'); return }
  if (!Array.isArray(rows)) { ElMessage.warning('导入内容须为行数组'); return }
  busy.value = true
  try {
    batch.value = await http.post('/sys/imports', { importType: form.importType, cutoffDate: form.cutoffDate || null, rows, sourceFileText: form.text })
    intent.reset()
    await load()
  } finally { busy.value = false }
}
async function confirm() {
  if (!batch.value) return
  busy.value = true
  try { batch.value = await http.postIdem('/sys/imports/' + batch.value.id + '/confirm', {}, intent); ElMessage.success('导入完成，来源及目标已冻结'); await load() } finally { busy.value = false }
}
async function cancel() {
  if (!batch.value) return
  batch.value = await http.post('/sys/imports/' + batch.value.id + '/cancel', {})
  await load()
}
async function select(row: Record<string, any>) { batch.value = await http.get('/sys/imports/' + row.id); intent.reset() }
onMounted(load)
</script>

<template>
  <el-card v-loading="busy">
    <template #header>导入中心</template>
    <p class="muted">数据只进入当前国家。期初填写截止日期、来源编号及来源日期；未知金额请保留待核实。预校验不写业务数据，确认后不能覆盖原始来源。失败或取消后可用同一文件再次预校验，原批次保留。</p>
    <p v-if="form.importType === 'OPENING_PURCHASE'" class="muted">未完采购导入形成采购草稿，沿用正常审批；在途导入只能引用已通过审批且截止日期相同的期初采购行。</p>
    <el-form label-width="100px">
      <el-form-item label="类型"><el-select v-model="form.importType"><el-option v-for="type in types" :key="type" :label="labels[type] ?? type" :value="type" /></el-select><el-button :disabled="!columns.length" @click="template">下载模板</el-button></el-form-item>
      <el-form-item v-if="form.importType.startsWith('OPENING_')" label="截止日期"><el-date-picker v-model="form.cutoffDate" type="date" value-format="YYYY-MM-DD" /></el-form-item>
      <el-form-item label="上传文件"><input type="file" accept=".json,application/json" @change="upload" /></el-form-item>
      <el-form-item label="行数据"><el-input v-model="form.text" type="textarea" :rows="7" placeholder='[{"bookId": 1, "refNo": "原始来源编号", ...}]' /></el-form-item>
      <p class="muted">模板字段：{{ columns.join('、') }}。ID、数量、金额使用 JSON 数值，日期使用 YYYY-MM-DD，布尔字段使用 true / false。</p>
      <el-button :disabled="!form.importType || !form.text" @click="validate">预校验</el-button>
      <el-button type="primary" :disabled="batch?.status !== 'VALIDATED'" @click="confirm">确认导入</el-button>
      <el-button v-if="batch && ['VALIDATED', 'VALIDATION_FAILED'].includes(batch.status)" @click="cancel">取消批次</el-button>
    </el-form>
    <template v-if="batch">
      <p>批次 {{ batch.id }}（第 {{ batch.attemptNo }} 次校验）· <StatusTag :status="batch.status" /> · {{ batch.validRows }} / {{ batch.totalRows }} 行通过</p>
      <p v-if="batch.duplicate">文件已有待处理或完成的批次，当前显示该批次。</p>
      <p class="muted">服务端文件摘要：{{ batch.fileSha256 }}（{{ batch.hashBasis }}）</p>
      <el-button v-if="batch.errors?.length" @click="download(batch.errors, 'import-errors-' + batch.id + '.json')">下载错误报告</el-button>
      <el-table v-if="batch.errors?.length" :data="batch.errors" size="small"><el-table-column prop="rowNo" label="行" width="60" /><el-table-column prop="message" label="错误" /></el-table>
      <el-table :data="batch.preview" size="small"><el-table-column prop="rowNo" label="行" width="60" /><el-table-column label="预览"><template #default="{ row }"><code>{{ JSON.stringify(row.values) }}</code></template></el-table-column><el-table-column prop="targetType" label="目标类型" width="150" /><el-table-column prop="targetId" label="目标编号" width="150" /></el-table>
    </template>
  </el-card>
  <el-card class="history"><template #header>历史批次</template><el-table :data="history" size="small" @row-click="select"><el-table-column prop="id" label="批次" width="150" /><el-table-column prop="importType" label="类型" /><el-table-column prop="status" label="状态" /><el-table-column prop="createdAt" label="创建时间" /></el-table></el-card>
</template>
<style scoped>.history { margin-top: 16px; } code { white-space: pre-wrap; overflow-wrap: anywhere; }</style>
