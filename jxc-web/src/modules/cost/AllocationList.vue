<script setup lang="ts">
import { computed, onBeforeUnmount, onMounted, reactive, ref, watch } from 'vue'
import { ElMessage } from 'element-plus'
import { http, createCommandIntent } from '@/api/http'
import { useUserStore } from '@/stores/user'
import { allRecords } from '@/api/pagination'
import { getCountryId, getToken } from '@/utils/session'
import StatusTag from '@/components/StatusTag.vue'
import MoneyText from '@/components/MoneyText.vue'
import CostTraceDrawer from './CostTraceDrawer.vue'

type Row = Record<string, any>
const rows = ref<Row[]>([]), fees = ref<Row[]>([])
const preview = ref<Row | null>(null)
const form = reactive({ feeId: null as number | null, basis: 'QTY' })
const feeSelection = ref<number | string>(), keyword = ref('')
const feesLoading = ref(false), historyLoading = ref(false), historyReady = ref(false)
const feesError = ref(''), historyError = ref(''), commandError = ref('')
const user = useUserStore()
const busy = ref(false), previewIntent = createCommandIntent(), confirmIntent = createCommandIntent(), reverseIntent = createCommandIntent()
const previewInput = ref('')
const trace = ref<InstanceType<typeof CostTraceDrawer>>()
const bases = [{ value: 'QTY', label: '按数量' }, { value: 'WEIGHT', label: '按重量' }, { value: 'VOLUME', label: '按体积' }, { value: 'VALUE', label: '按货值' }]
let disposed = false, feesRequest = 0, historyRequest = 0
const scope = () => JSON.stringify([getCountryId(), getToken()])
const inputKey = () => JSON.stringify([scope(), form.feeId, form.basis])
const canConfirm = computed(() => !!preview.value && previewInput.value === inputKey() && ['DRAFT', 'APPROVED'].includes(preview.value.status))
const selectedFee = computed(() => fees.value.find(f => f.id === form.feeId))
const feeOptions = computed(() => {
  if (!historyReady.value) return []
  const allocated = new Set(rows.value.filter(r => r.status === 'CONFIRMED').map(r => r.feeId))
  return fees.value.filter(f => ['CONFIRMED', 'ADJUSTED'].includes(f.status) && f.costTreatment === 'CAPITALIZE'
    && f.costStatus === 'READY' && f.baseAmount != null && f.actualFeeId == null
    && !allocated.has(f.id) && (f.estimateFeeId == null || !allocated.has(f.estimateFeeId)))
})
const filteredFees = computed(() => {
  const query = keyword.value.trim().toLocaleLowerCase()
  return feeOptions.value.filter(f => [f.id, f.docNo, f.expenseItemName, f.carrierName, f.shipmentNo]
    .some(value => value != null && String(value).toLocaleLowerCase().includes(query)))
})
const errorText = (error: unknown) => error instanceof Error ? error.message : '读取失败，请重试'
const basisLabel = (basis: string) => bases.find(b => b.value === basis)?.label ?? (basis === 'MANUAL' ? '人工比例' : basis)
const feeLabel = (fee: Row) => `${fee.docNo ?? `#${fee.id}`} · ${fee.expenseItemName ?? '未提供费用项目'} · ${fee.amount ?? '金额未提供'} ${fee.currency ?? ''}`

function clearPreview() {
  preview.value = null; previewInput.value = ''; commandError.value = ''
  previewIntent.reset(); confirmIntent.reset()
}
watch(() => [form.feeId, form.basis], clearPreview, { flush: 'sync' })
function filterFees(query: string) { keyword.value = query }
function chooseFee(value: number | string | undefined) {
  if (value == null || value === '') { form.feeId = null; feeSelection.value = undefined; return }
  const text = String(value).trim()
  const matches = fees.value.filter(f => f.docNo != null && String(f.docNo).toLocaleLowerCase() === text.toLocaleLowerCase())
  const id = matches.length === 1 ? matches[0]!.id : /^\d+$/.test(text) ? Number(text) : NaN
  if (!Number.isSafeInteger(id) || id <= 0) {
    form.feeId = null; feeSelection.value = undefined
    return ElMessage.warning('请选择已有费用，或输入有效的正整数费用 ID')
  }
  if (fees.value.some(f => f.id === id) && !feeOptions.value.some(f => f.id === id)) {
    form.feeId = null; feeSelection.value = undefined
    return ElMessage.warning('该费用当前不符合分摊条件，请重新选择')
  }
  form.feeId = id; feeSelection.value = id; keyword.value = ''
}

function allocationView(row: Row): Row {
  return {
    ...row,
    feeNo: row.feeNo ?? (row.feeId == null ? '—' : `#${row.feeId}`),
    lines: (row.lines ?? []).map((line: Record<string, any>) => ({ ...line, batchNo: line.batchNo ?? (line.batchId == null ? '—' : `#${line.batchId}`) })),
  }
}

async function load() {
  const request = ++historyRequest, context = scope()
  historyLoading.value = true; historyError.value = ''; historyReady.value = false
  try {
    const result = await allRecords<Row>('/cst/allocations')
    if (disposed || request !== historyRequest || context !== scope()) return
    rows.value = result.map(allocationView); historyReady.value = true
  } catch (error) {
    if (!disposed && request === historyRequest) historyError.value = errorText(error)
  } finally { if (request === historyRequest) historyLoading.value = false }
}
async function loadFees() {
  const request = ++feesRequest, context = scope()
  feesLoading.value = true; feesError.value = ''; fees.value = []
  try {
    if (!user.hasPerm(['lgs:shipment:view', 'lgs:fee:create', 'lgs:fee:confirm'])) {
      feesError.value = '当前账号没有物流费用列表查看权限。可输入已知费用 ID 后预览校验。'
      return
    }
    const result = await allRecords<Row>('/lgs/fees')
    if (disposed || request !== feesRequest || context !== scope()) return
    fees.value = result
  } catch (error) {
    if (!disposed && request === feesRequest) feesError.value = errorText(error)
  } finally { if (request === feesRequest) feesLoading.value = false }
}
async function refresh() {
  clearPreview()
  await Promise.all([load(), loadFees()])
}
async function run(confirm: boolean) {
  if (busy.value) return
  if (!Number.isSafeInteger(form.feeId) || form.feeId! <= 0) return ElMessage.warning('请先选择物流费用，或输入有效费用 ID')
  if (confirm && !canConfirm.value) return ElMessage.warning('请先预览当前费用与分摊依据，再确认分摊')
  busy.value = true; commandError.value = ''
  const fingerprint = inputKey()
  try {
    if (!confirm) {
      if (preview.value && previewInput.value === fingerprint) return
      const result = await http.postIdem<Row>('/cst/allocations', { ...form }, previewIntent)
      if (disposed || fingerprint !== inputKey()) return
      preview.value = allocationView(result)
      previewInput.value = fingerprint
      previewIntent.reset()
    } else {
      const confirmed = allocationView(await http.postIdem<Row>('/cst/allocations/' + preview.value!.id + '/confirm', {}, confirmIntent))
      if (disposed || fingerprint !== inputKey()) return
      preview.value = confirmed
      if (confirmed.status === 'CONFIRMED') {
        ElMessage.success('费用分摊已确认')
        chooseFee(undefined); clearPreview()
        await Promise.all([load(), loadFees()])
      } else ElMessage.info('当前状态：' + confirmed.status)
    }
  } catch (error) {
    if (!disposed && fingerprint === inputKey()) {
      if (error instanceof Error && 'code' in error && ['CST_FEE_CHANGED', 'CST_ESTIMATE_REPLACED', 'CST_ALLOCATION_EXISTS'].includes(String(error.code))) clearPreview()
      commandError.value = errorText(error)
    }
  } finally { busy.value = false }
}
async function reverse(row: Record<string, any>) {
  if (busy.value) return
  busy.value = true
  try { await http.postIdem('/cst/allocations/' + row.id + '/reverse', {}, reverseIntent); ElMessage.success('已撤销'); reverseIntent.reset(); await refresh() }
  finally { busy.value = false }
}
onMounted(refresh)
onBeforeUnmount(() => { disposed = true; feesRequest++; historyRequest++ })
</script>

<template>
  <div class="allocation-page">
    <el-card shadow="never" class="allocation-workbench">
      <template #header>
        <div class="section-heading"><div><h2>费用分摊</h2><p>选择物流费用，预览批次与金额后再确认。</p></div><el-button :disabled="busy" :loading="feesLoading || historyLoading" @click="refresh">刷新费用与记录</el-button></div>
      </template>
      <ol class="allocation-flow" aria-label="费用分摊步骤">
        <li :class="{ active: !form.feeId }"><span>1</span>选择费用</li>
        <li :class="{ active: !!form.feeId && !canConfirm }"><span>2</span>预览明细</li>
        <li :class="{ active: canConfirm }"><span>3</span>确认分摊</li>
      </ol>
      <el-alert v-if="feesError" class="state-message" type="warning" :closable="false" show-icon :title="feesError"><template #default><el-button link type="primary" :disabled="feesLoading || busy" @click="loadFees">重试读取费用</el-button></template></el-alert>
      <el-form class="allocation-form" label-position="top" :disabled="busy" @submit.prevent>
        <el-form-item label="物流费用" class="fee-field">
          <el-select v-model="feeSelection" filterable allow-create default-first-option clearable :filter-method="filterFees" :loading="feesLoading" placeholder="输入单号、项目、物流商、运输批次或费用 ID" @change="chooseFee">
            <el-option v-if="form.feeId && !selectedFee" :value="form.feeId" :label="`费用 ID #${form.feeId}（待预览校验）`" />
            <el-option v-for="fee in filteredFees" :key="fee.id" :value="fee.id" :label="feeLabel(fee)" class="allocation-fee-option">
              <div class="fee-option-main"><strong>{{ fee.docNo ?? `#${fee.id}` }}</strong><span>{{ fee.amount ?? '金额未提供' }} {{ fee.currency }}</span></div>
              <div class="fee-option-detail">{{ fee.expenseItemName ?? '未提供费用项目' }} · {{ fee.shipmentNo ?? '未提供运输批次' }} · {{ fee.carrierName ?? '未提供物流商' }}</div>
            </el-option>
            <template #empty><div class="fee-empty">{{ historyError ? '分摊记录读取失败，请先重试' : feesError ? '费用列表未成功读取，请查看上方提示' : '没有匹配的候选费用；可输入已知费用 ID 后回车' }}</div></template>
          </el-select>
          <div class="field-help">可输入关键词搜索并选取；手动输入已有费用 ID 后按回车。</div>
        </el-form-item>
        <el-form-item label="分摊依据" class="basis-field"><el-select v-model="form.basis"><el-option v-for="basis in bases" :key="basis.value" v-bind="basis" /></el-select></el-form-item>
        <div class="allocation-actions">
          <el-button :disabled="!form.feeId" :loading="busy" @click="run(false)">预览分摊</el-button>
          <el-button v-if="user.hasPerm('cst:allocation:confirm')" type="primary" :disabled="!canConfirm" :loading="busy" @click="run(true)">确认分摊</el-button>
        </div>
      </el-form>
      <div v-if="selectedFee" class="fee-summary">
        <div><span>费用单号</span><strong class="mono">{{ selectedFee.docNo ?? `#${selectedFee.id}` }}</strong></div>
        <div><span>费用项目</span><strong>{{ selectedFee.expenseItemName ?? '未提供' }}</strong></div>
        <div><span>原币金额</span><MoneyText :value="selectedFee.amount" :currency="selectedFee.currency" /></div>
        <div><span>运输批次</span><strong class="mono">{{ selectedFee.shipmentNo ?? '未提供' }}</strong></div>
      </div>
      <p v-else-if="form.feeId" class="muted">已输入费用 ID #{{ form.feeId }}，请预览核对费用来源与分摊明细。</p>
      <el-alert v-if="commandError" class="state-message" :title="commandError" type="error" :closable="false" show-icon />
      <section v-if="preview" class="allocation-preview" aria-label="分摊预览">
        <div class="preview-heading"><div><h3>分摊预览</h3><p>{{ selectedFee?.docNo ?? preview.feeNo }} · {{ basisLabel(preview.basis ?? form.basis) }} · {{ preview.lines.length }} 个批次</p></div><div class="preview-total"><span>分摊合计</span><MoneyText :value="preview.baseAmount" :currency="preview.baseCurrency" /></div></div>
        <p class="preview-source">原费用 <MoneyText :value="preview.feeAmount" :currency="preview.feeCurrency" />，请核对各批次分摊金额后确认。</p>
        <el-table :data="preview.lines" size="small" stripe>
          <el-table-column label="入库批次" min-width="180"><template #default="{ row }"><el-link type="primary" @click="trace?.open(row.batchId)">{{ row.batchNo }}</el-link></template></el-table-column>
          <el-table-column label="依据值" min-width="120" align="right"><template #default="{ row }">{{ row.basisValue ?? row.weight ?? '—' }}</template></el-table-column>
          <el-table-column label="分摊金额" min-width="180" align="right"><template #default="{ row }"><MoneyText :value="row.amount" :currency="preview.baseCurrency" /></template></el-table-column>
        </el-table>
      </section>
      <div v-else class="preview-placeholder"><span>分摊预览</span><p>选择费用和分摊依据后，点击“预览分摊”查看各批次金额。</p></div>
    </el-card>
    <el-card shadow="never" class="allocation-history">
      <template #header><div class="section-heading"><h3>分摊记录 <span class="record-count">{{ rows.length }}</span></h3><el-button link type="primary" :disabled="busy || historyLoading" @click="load">刷新记录</el-button></div></template>
      <el-alert v-if="historyError" class="state-message" :title="historyError" type="error" :closable="false" show-icon><template #default><el-button link type="primary" :disabled="busy" @click="load">重试读取分摊记录</el-button></template></el-alert>
      <el-table v-loading="historyLoading" :data="rows" size="small" stripe :empty-text="historyError ? '分摊记录读取失败' : '暂无分摊记录；确认分摊后将在这里显示'">
        <el-table-column label="物流费用" min-width="220"><template #default="{ row }"><span class="mono">{{ fees.find(f => f.id === row.feeId)?.docNo ?? row.feeNo }}</span></template></el-table-column>
        <el-table-column label="分摊依据" min-width="110"><template #default="{ row }">{{ basisLabel(row.basis) }}</template></el-table-column>
        <el-table-column label="原费用" min-width="170" align="right"><template #default="{ row }"><MoneyText :value="row.feeAmount" :currency="row.feeCurrency" /></template></el-table-column>
        <el-table-column label="分摊金额" min-width="170" align="right"><template #default="{ row }"><MoneyText :value="row.baseAmount" :currency="row.baseCurrency" /></template></el-table-column>
        <el-table-column label="状态" width="110"><template #default="{ row }"><StatusTag :status="row.status" /></template></el-table-column>
        <el-table-column label="操作" width="90" fixed="right"><template #default="{ row }"><el-button v-if="row.status === 'CONFIRMED' && user.hasPerm('cst:allocation:confirm')" link :disabled="busy" @click="reverse(row)">撤销</el-button><span v-else class="muted">—</span></template></el-table-column>
      </el-table>
    </el-card>
    <CostTraceDrawer ref="trace" />
  </div>
</template>

<style scoped>
.allocation-page { display: grid; gap: 16px; }
.section-heading, .preview-heading { display: flex; align-items: center; justify-content: space-between; gap: 16px; }
h2, h3, p { margin: 0; }
h2 { font-size: 18px; font-weight: 600; }
h3 { font-size: 15px; font-weight: 600; }
.section-heading p, .preview-heading p { margin-top: 6px; color: var(--el-text-color-secondary); font-size: 13px; }
.allocation-flow { display: flex; flex-wrap: wrap; gap: 28px; list-style: none; padding: 0; margin: 0 0 24px; color: var(--el-text-color-secondary); font-size: 13px; }
.allocation-flow li { display: flex; gap: 8px; align-items: center; }
.allocation-flow li span { display: grid; place-items: center; width: 23px; height: 23px; border: 1px solid var(--el-border-color); border-radius: 50%; font-size: 12px; }
.allocation-flow .active { color: var(--el-color-primary); font-weight: 600; }
.allocation-flow .active span { background: var(--el-color-primary-light-9); border-color: var(--el-color-primary-light-5); }
.allocation-form { display: grid; grid-template-columns: minmax(280px, 1fr) 160px auto; gap: 16px; align-items: start; }
.allocation-form :deep(.el-form-item) { margin-bottom: 0; }
.allocation-form :deep(.el-select) { width: 100%; }
.allocation-actions { display: flex; padding-top: 30px; }
.field-help { width: 100%; margin-top: 6px; color: var(--el-text-color-secondary); line-height: 1.6; font-size: 12px; }
.allocation-fee-option { height: auto; padding-top: 9px; padding-bottom: 9px; line-height: 1.6; }
.fee-option-main { display: flex; gap: 20px; justify-content: space-between; font-size: 13px; }
.fee-option-main strong { font-weight: 500; }
.fee-option-detail { color: var(--el-text-color-secondary); font-size: 12px; }
.fee-empty { padding: 20px; color: var(--el-text-color-secondary); font-size: 13px; }
.fee-summary { display: grid; grid-template-columns: repeat(4, minmax(0, 1fr)); gap: 16px; padding: 16px; margin-top: 18px; background: var(--el-fill-color-light); border-radius: 4px; }
.fee-summary > div { display: grid; gap: 7px; font-size: 14px; overflow-wrap: anywhere; }
.fee-summary > div > span:first-child { color: var(--el-text-color-secondary); font-size: 12px; }
.fee-summary strong { font-weight: 500; }
.allocation-preview { margin-top: 24px; border-top: 1px solid var(--el-border-color-lighter); padding-top: 20px; }
.preview-total { display: grid; gap: 5px; text-align: right; }
.preview-total > span:first-child { font-size: 12px; color: var(--el-text-color-secondary); }
.preview-total :deep(.mono) { font-size: 22px; font-weight: 600; color: var(--el-color-primary); }
.preview-source { margin: 12px 0 16px; font-size: 13px; color: var(--el-text-color-secondary); }
.preview-placeholder { margin-top: 22px; padding: 24px; text-align: center; background: var(--el-fill-color-lighter); border: 1px dashed var(--el-border-color); border-radius: 4px; }
.preview-placeholder > span { font-size: 14px; color: var(--el-text-color-regular); }
.preview-placeholder p { margin-top: 8px; font-size: 13px; color: var(--el-text-color-secondary); }
.record-count { margin-left: 6px; font-size: 13px; font-weight: 400; color: var(--el-text-color-secondary); }
.state-message { margin-bottom: 16px; }
@media (max-width: 1000px) { .allocation-form { grid-template-columns: minmax(200px, 1fr) 150px; } .allocation-actions { grid-column: 1 / -1; padding-top: 0; } }
@media (max-width: 600px) { .section-heading { align-items: flex-start; flex-direction: column; gap: 12px; } .allocation-flow { gap: 16px; } .allocation-form { grid-template-columns: 1fr; } .fee-summary { grid-template-columns: 1fr 1fr; } .preview-heading { align-items: flex-start; } }
</style>
