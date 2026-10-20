<script setup lang="ts">
import { onMounted, reactive, ref, watch } from 'vue'
import { useRoute } from 'vue-router'
import { ElMessage } from 'element-plus'
import { http, createCommandIntent } from '@/api/http'
import { allRecords } from '@/api/pagination'
import StatusTag from '@/components/StatusTag.vue'
import ApprovalPanel from '@/components/ApprovalPanel.vue'
import { useCountryStore } from '@/stores/country'
import { useUserStore } from '@/stores/user'
import { todayIn } from '@/utils/format'
import { getCountryId, getToken } from '@/utils/session'

const country = useCountryStore(), user = useUserStore(), mockMode = import.meta.env.MODE === 'demo' && import.meta.env.VITE_USE_MOCK === 'true'
const route = useRoute()
const rows = ref<Record<string, any>[]>([])
const form = reactive({ reason: 'ACTUAL_VS_ESTIMATE', target: 'COGS', amount: 0, batchId: null as number | null, bizDate: todayIn(country.timezone) })
const busy = ref(false), saveIntent = createCommandIntent(), confirmIntent = createCommandIntent(), detail = ref<Record<string, any> | null>(null)
const created = ref<Record<string, any> | null>(null)
const mockDraft = ref<Record<string, any> | null>(null), mockDraftInput = ref('')
let listRequest = 0
const listContext = () => `${country.epoch}:${getCountryId()}:${getToken()}:${route.query.sourceId ?? ''}:${route.query.bookId ?? ''}`
const positiveId = (value: unknown) => /^[1-9]\d*$/.test(String(value)) && Number.isSafeInteger(Number(value)) ? Number(value) : undefined
async function load() {
  const request = ++listRequest, scope = listContext(), source = route.query.sourceId
  const current = () => request === listRequest && scope === listContext()
  rows.value = []; detail.value = null
  try {
    const id = positiveId(source), book = positiveId(route.query.bookId)
    if (source != null && (!id || !book)) return
    let result = await allRecords<Record<string, any>>('/cst/adjustments', book ? { bookId: book } : {})
    if (!current()) return
    if (source != null) result = result.filter(row => row.id === id && row.bookId === book)
    if (!mockMode) await Promise.all(result.filter(row => row.sourceType === 'MANUAL' && row.status !== 'CONFIRMED').map(async row => {
      const instances = await http.get<Record<string, any>[]>('/wf/instances', { docType: 'COST_ADJUSTMENT', docId: row.id })
      row.approvalStatus = instances[0]?.status
    }))
    if (!current()) return
    rows.value = result
    if (created.value) created.value = result.find(row => row.id === created.value?.id) ?? created.value
  } catch (error) { if (current()) throw error }
}
watch(() => [route.query.sourceId, route.query.bookId, country.epoch, user.token], () => { created.value = null; load() })
async function create() {
  if (busy.value) return
  busy.value = true
  try {
    const payload = { ...form }, fingerprint = JSON.stringify(payload)
    const row = mockMode && mockDraft.value && mockDraftInput.value === fingerprint ? mockDraft.value : await http.postIdem<Record<string, any>>('/cst/adjustments', payload, saveIntent)
    created.value = row; saveIntent.reset()
    if (mockMode) { mockDraft.value = row; mockDraftInput.value = fingerprint; created.value = await http.postIdem<Record<string, any>>('/cst/adjustments/' + row.id + '/confirm', {}, confirmIntent); mockDraft.value = null; mockDraftInput.value = '' }
    form.amount = 0; form.batchId = null
    await load()
    ElMessage.success(created.value?.status === 'CONFIRMED' ? '调整已确认' : '调整已保存，请完成审批后确认')
  } finally { busy.value = false }
}
async function confirm(row: Record<string, any>) {
  if (busy.value) return
  busy.value = true
  try {
    const updated = await http.postIdem<Record<string, any>>('/cst/adjustments/' + row.id + '/confirm', {}, confirmIntent)
    created.value = updated; await load()
    if (updated.status === 'CONFIRMED') ElMessage.success('调整已确认')
    else ElMessage.info('调整尚未确认，请查看审批状态')
  } finally { busy.value = false }
}
const displayStatus = (row: Record<string, any>) => row.status === 'CONFIRMED' ? row.status : row.approvalStatus && row.approvalStatus !== 'PENDING' ? row.approvalStatus : row.status
onMounted(load)
</script>

<template>
  <el-card>
    <template #header>成本调整</template>
    <p class="muted">暂估和实际的差额：库存还在的部分调批次成本，已售出的部分调当期已售成本，不改已结账期间。</p>
    <p v-if="route.query.sourceId != null" class="muted">来源定位 #{{ route.query.sourceId }} · 账套 #{{ route.query.bookId ?? '未指定' }}；只显示当前授权范围内匹配记录。</p>
    <el-alert v-if="created && created.status !== 'CONFIRMED'" :type="created.approvalStatus === 'BLOCKED' ? 'warning' : 'info'" :closable="false" style="margin-bottom: 12px"><template #title>调整 {{ created.docNo }} <StatusTag :status="displayStatus(created)" />；审批通过后仍须确认，才会产生成本调整。</template></el-alert>
    <el-form inline :disabled="busy">
      <el-form-item label="原因"><el-input v-model="form.reason" /></el-form-item>
      <el-form-item label="对象"><el-select v-model="form.target" style="width: 140px"><el-option label="库存" value="INVENTORY" /><el-option label="已售成本" value="COGS" /></el-select></el-form-item>
      <el-form-item label="金额"><el-input-number v-model="form.amount" /></el-form-item>
      <el-form-item label="批次"><el-input-number v-model="form.batchId" /></el-form-item>
      <el-form-item v-if="!mockMode" label="业务日期"><el-date-picker v-model="form.bizDate" value-format="YYYY-MM-DD" /></el-form-item>
      <el-button type="primary" :loading="busy" @click="create">{{ mockMode ? '确认调整' : '保存并提交审批' }}</el-button>
    </el-form>
    <p v-if="!mockMode"><router-link to="/approval/todo">打开原审批待办</router-link> · <el-button link :disabled="busy" @click="load">刷新审批结果</el-button></p>
    <el-table :data="rows" size="small">
      <el-table-column prop="docNo" label="单号" />
      <el-table-column prop="reason" label="原因" />
      <el-table-column prop="target" label="对象" />
      <el-table-column prop="amount" label="金额" />
      <el-table-column label="状态" width="110"><template #default="{ row }"><StatusTag :status="displayStatus(row)" /></template></el-table-column>
      <el-table-column v-if="!mockMode" label="操作" width="170"><template #default="{ row }"><el-button v-if="row.sourceType === 'MANUAL'" link @click="detail = row">审批记录</el-button><el-button v-if="row.status !== 'CONFIRMED' && row.approvalStatus === 'APPROVED' && user.hasPerm('cst:adjustment:confirm')" link type="primary" :disabled="busy" @click="confirm(row)">确认调整</el-button></template></el-table-column>
    </el-table>
    <el-drawer :model-value="!!detail" title="成本调整审批" size="560px" destroy-on-close @close="detail = null"><ApprovalPanel v-if="detail" :key="detail.id" doc-type="COST_ADJUSTMENT" :doc-id="detail.id" /></el-drawer>
  </el-card>
</template>
