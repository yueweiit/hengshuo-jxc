<script setup lang="ts">
import { computed, onMounted, reactive, ref, watch } from 'vue'
import { useRoute, useRouter } from 'vue-router'
import { ElMessage } from 'element-plus'
import { BizError, http, createCommandIntent } from '@/api/http'
import { allRecords } from '@/api/pagination'
import { commandPayloadFingerprint } from '@/api/command-intent'
import { getToken, getCountryId } from '@/utils/session'
import { formatQty, todayIn } from '@/utils/format'
import { useCountryStore } from '@/stores/country'
import { useUserStore } from '@/stores/user'
import StatusTag from '@/components/StatusTag.vue'
import MoneyText from '@/components/MoneyText.vue'
import DateTimeText from '@/components/DateTimeText.vue'
import ApprovalPanel from '@/components/ApprovalPanel.vue'
import DocAttachment from '@/components/DocAttachment.vue'
import AuditTimeline from '@/components/AuditTimeline.vue'
import ProductCell from '@/components/biz/ProductCell.vue'
import { confirmAction } from '@/utils/action'

const supplyCommandIntent = createCommandIntent()


type Row = Record<string, any> // eslint-disable-line @typescript-eslint/no-explicit-any

const route = useRoute()
const router = useRouter()
const user = useUserStore(), country = useCountryStore()
const order = ref<Row | null>(null)
const checks = ref<Row[]>([])
const timeline = ref<Row[]>([])
const loading = ref(false)
const tab = ref('lines')
const ob = reactive({ visible: false, warehouseId: undefined as number | undefined, qty: {} as Record<number, number>, saving: false, key: createCommandIntent() })
const cancelForm = reactive({ visible: false, close: false, saving: false, reason: '', bizDate: '', lines: [] as Row[], intent: createCommandIntent() })
const allocationForm = reactive({ visible: false, loading: false, saving: false, version: 0, bizDate: '', lines: [] as Row[], warehouses: [] as Row[] })
let cancellationScope = '', allocationScope = '', allocationRequest = 0
const originalAllocations = new Map<number, string>()

let outboundAttempt: { fingerprint: string; draft: Row; bizDate: string } | null = null
const id = computed(() => Number(route.params.id))
const fullOrder = computed(() => Number(order.value?.id) === id.value && order.value?.totalQty != null)
const mutableOrder = computed(() => fullOrder.value && order.value?.approvalStatus !== 'PENDING' && order.value?.fulfillmentStatus !== 'CLOSED')
const detailScope = () => JSON.stringify([id.value, getCountryId(), getToken(), country.epoch])
const allocationKey = (allocs: Row[]) => JSON.stringify(allocs.map(row => [row.id ?? null, Number(row.warehouseId), Number(row.allocQty)]).sort((a, b) => Number(a[1]) - Number(b[1])))
const warehouses = computed(() => {
  const map = new Map<number, string>()
  for (const l of order.value?.lines ?? []) for (const a of l.allocs ?? []) map.set(a.warehouseId, a.warehouseName)
  return [...map].map(([value, label]) => ({ value, label }))
})

async function load() {
  loading.value = true
  try {
    order.value = await http.get<Row>(`/sal/orders/${id.value}`)
    timeline.value = await http.get<Row[]>(`/sal/orders/${id.value}/timeline`)
    checks.value = []
  } finally {
    loading.value = false
  }
}

async function runCheck() {
  const warehouseId = ob.warehouseId || warehouses.value[0]?.value
  if (!warehouseId) return
  const res = await http.get<{ checks: Row[] }>(`/sal/orders/${id.value}/outbound-check`, { warehouseId })
  checks.value = res.checks
}

async function submit() {
  await confirmAction('提交这张订单？', () => http.postIdem(`/sal/orders/${id.value}/submit`, undefined, supplyCommandIntent), { success: '已提交' })
  load()
}
async function withdraw() {
  await confirmAction('撤回审批？', () => http.postIdem(`/sal/orders/${id.value}/withdraw`, undefined, supplyCommandIntent), { success: '已撤回' })
  load()
}

function openCancel(close: boolean) {
  if (!mutableOrder.value || !user.hasPerm(close ? ['sal:order:close', 'sal:order:create'] : ['sal:order:cancel', 'sal:order:create'])) return
  cancellationScope = detailScope()
  Object.assign(cancelForm, { visible: true, close, saving: false, reason: '', bizDate: todayIn(country.timezone), intent: createCommandIntent(), lines: (order.value?.lines ?? []).filter((line: Row) => Number(line.openQty) > 0).map((line: Row) => ({ lineId: line.id, productCode: line.productCode, productName: line.productName, openQty: Number(line.openQty), qty: 0 })) })
}

async function saveCancellation() {
  if (cancellationScope !== detailScope()) return ElMessage.warning('国家、登录状态或订单已切换，请重新打开操作')
  if (!cancelForm.reason.trim() || !cancelForm.bizDate) return ElMessage.warning('请填写操作日期和原因')
  const selected = cancelForm.lines.filter(line => Number(line.qty) > 0)
  if (!cancelForm.close && (!selected.length || selected.some(line => !Number.isFinite(Number(line.qty)) || Number(line.qty) > Number(line.openQty)))) return ElMessage.warning('请选择取消数量，且不能超过原订单未出库数量')
  const body = { bizDate: cancelForm.bizDate, reason: cancelForm.reason.trim(), ...(!cancelForm.close ? { lines: selected.map(line => ({ lineId: line.lineId, qty: Number(line.qty) })) } : {}) }
  const commandId = id.value, scope = cancellationScope, close = cancelForm.close, intent = cancelForm.intent
  cancelForm.saving = true
  try {
    const completed = await confirmAction(close ? '关闭这张订单的全部未交数量？已出库事实保留。' : '取消所选未交数量？原服务将释放对应库存与授信占用。', () => {
      if (scope !== detailScope()) throw new BizError('CONTEXT_CHANGED', '国家、登录状态或订单已切换，请重新打开操作')
      return http.postIdem(`/sal/orders/${commandId}/${close ? 'close' : 'cancel-lines'}`, body, intent)
    }, { success: close ? '已关闭未交数量' : '已取消所选未交数量' })
    if (completed && scope === detailScope()) { cancelForm.visible = false; await load() }
  } finally { cancelForm.saving = false }
}

async function openAllocations() {
  if (!mutableOrder.value || !user.hasPerm('sal:order:edit')) return
  const request = ++allocationRequest, scope = detailScope()
  allocationScope = scope; allocationForm.loading = true; originalAllocations.clear()
  allocationForm.lines = (order.value?.lines ?? []).map((line: Row) => ({ ...line, allocs: line.allocs.map((allocation: Row) => ({ ...allocation, allocQty: Number(allocation.allocQty) })) }))
  for (const line of allocationForm.lines) originalAllocations.set(Number(line.id), allocationKey(line.allocs))
  allocationForm.version = order.value?.version
  allocationForm.bizDate = todayIn(country.timezone)
  try {
    const rows = await allRecords<Row>('/org/warehouses', { status: 'ENABLED' })
    if (request !== allocationRequest || scope !== detailScope()) return
    allocationForm.warehouses = rows; allocationForm.visible = true
  } finally { if (request === allocationRequest) allocationForm.loading = false }
}

async function saveAllocations() {
  if (allocationScope !== detailScope()) return ElMessage.warning('国家、登录状态或订单已切换，请重新打开分仓')
  if (!allocationForm.bizDate) return ElMessage.warning('请填写分仓操作日期')
  const changed = allocationForm.lines.filter(line => allocationKey(line.allocs) !== originalAllocations.get(Number(line.id)))
  if (!changed.length) return ElMessage.warning('分仓没有变化')
  for (const line of changed) {
    const allocations = line.allocs as Row[], sum = allocations.reduce((total, allocation) => total + Number(allocation.allocQty), 0)
    if (allocations.some(allocation => !allocation.warehouseId || !Number.isFinite(Number(allocation.allocQty)) || Number(allocation.allocQty) <= 0 || Number(allocation.allocQty) < Number(allocation.outboundQty ?? 0) + Number(allocation.cancelledQty ?? 0)) || new Set(allocations.map(allocation => allocation.warehouseId)).size !== allocations.length || sum.toFixed(4) !== Number(line.baseQty).toFixed(4)) return ElMessage.warning('分仓合计必须等于原基础数量；已出库及已取消分仓不能减少或删除')
  }
  allocationForm.saving = true
  try {
    await http.put(`/sal/orders/${id.value}/allocations`, { version: allocationForm.version, bizDate: allocationForm.bizDate, lines: changed.map(line => ({ lineId: line.id, allocs: line.allocs.map((allocation: Row) => ({ ...(allocation.id ? { id: allocation.id } : {}), warehouseId: allocation.warehouseId, allocQty: Number(allocation.allocQty) })) })) })
    if (allocationScope === detailScope()) { allocationForm.visible = false; ElMessage.success('分仓已修改，原审批失效，请重新提交审批'); await load() }
  } finally { allocationForm.saving = false }
}

function openOutbound() {
  outboundAttempt = null
  const qty: Record<number, number> = {}
  for (const l of order.value?.lines ?? []) for (const a of l.allocs ?? []) if (a.openQty > 0) qty[a.id] = a.openQty
  Object.assign(ob, { visible: true, warehouseId: warehouses.value[0]?.value, qty, key: createCommandIntent() })
  runCheck()
}

async function confirmOut() {
  const selected = new Set((order.value?.lines ?? []).flatMap((l: Row) => l.allocs.filter((a: Row) => a.warehouseId === ob.warehouseId).map((a: Row) => a.id)))
  const lines = Object.entries(ob.qty).filter(([allocId, q]) => selected.has(Number(allocId)) && q > 0).map(([allocId, qty]) => ({ allocId: Number(allocId), qty }))
  ob.saving = true
  try {
    const body = { orderId: id.value, warehouseId: ob.warehouseId, lines }
    const fingerprint = commandPayloadFingerprint([getToken(), getCountryId(), body])
    if (outboundAttempt?.fingerprint !== fingerprint) {
      const draft = await http.postIdem<Row>('/sal/outbounds', body, ob.key)
      outboundAttempt = { fingerprint, draft, bizDate: todayIn(country.timezone) }
    }
    await http.postIdem(`/sal/outbounds/${outboundAttempt.draft.id}/confirm`, { bizDate: outboundAttempt.bizDate }, ob.key)
    outboundAttempt = null
    ElMessage.success('已出库，并按本次数量生成应收')
    ob.visible = false
    load()
  } finally {
    ob.saving = false
  }
}

watch(() => route.params.id, load)
onMounted(load)
</script>

<template>
  <div v-loading="loading">
    <div class="head">
      <div>
        <el-button link @click="router.push('/sales/orders')">返回列表</el-button>
        <h2>{{ order?.docNo }} <span class="muted">{{ order?.customerName }}</span></h2>
        <StatusTag :status="order?.paymentType" />
        <StatusTag :status="order?.approvalStatus" />
        <StatusTag :status="order?.fulfillmentStatus" />
        <StatusTag :status="order?.paymentStatus" />
      </div>
      <div>
        <el-button v-if="mutableOrder && user.hasPerm('sal:order:edit')" @click="router.push({ path: '/sales/orders', query: { edit: String(id) } })">编辑订单</el-button>
        <el-button v-if="mutableOrder && user.hasPerm('sal:order:edit')" :loading="allocationForm.loading" @click="openAllocations">编辑分仓</el-button>
        <el-button v-if="mutableOrder && Number(order?.openQty) > 0 && user.hasPerm(['sal:order:cancel', 'sal:order:create'])" @click="openCancel(false)">取消未交</el-button>
        <el-button v-if="mutableOrder && Number(order?.openQty) > 0 && user.hasPerm(['sal:order:close', 'sal:order:create'])" @click="openCancel(true)">关闭未交</el-button>
        <el-button v-if="['DRAFT', 'REJECTED', 'WITHDRAWN'].includes(order?.approvalStatus) && user.hasPerm('sal:order:submit')" type="primary" @click="submit">提交</el-button>
        <el-button v-if="order?.approvalStatus === 'PENDING' && user.hasPerm('sal:order:submit')" @click="withdraw">撤回</el-button>
        <el-button v-if="order?.approvalStatus === 'APPROVED' && user.hasPerm('sal:outbound:create')" type="primary" @click="openOutbound">出库</el-button>
        <el-button v-if="order?.customerId" @click="router.push(`/ar/customers/${order.customerId}`)">客户往来</el-button>
      </div>
    </div>
    <el-descriptions :column="4" border>
      <el-descriptions-item label="有效金额"><MoneyText :value="order?.totalAmount" :currency="order?.currency" /></el-descriptions-item>
      <el-descriptions-item label="未出库">{{ order?.openQty }}</el-descriptions-item>
      <el-descriptions-item label="业务员">{{ order?.salespersonName }}</el-descriptions-item>
      <el-descriptions-item label="录入">{{ order?.enteredByName }}</el-descriptions-item>
      <el-descriptions-item label="备注" :span="4">{{ order?.remark || '-' }}</el-descriptions-item>
    </el-descriptions>

    <el-tabs v-model="tab" class="mt">
      <el-tab-pane label="商品" name="lines">
        <el-table :data="order?.lines ?? []" size="small">
          <el-table-column label="商品" min-width="180"><template #default="{ row }"><ProductCell :code="row.productCode" :name="row.productName" /></template></el-table-column>
          <el-table-column label="原下单数量" width="110"><template #default="{ row }">{{ row.qty }} {{ row.unit }}</template></el-table-column>
          <el-table-column prop="baseQty" label="原基础数量" width="105" />
          <el-table-column label="成交价" width="110"><template #default="{ row }"><MoneyText :value="row.price" :currency="order?.currency" /></template></el-table-column>
          <el-table-column prop="priceSource" label="价格来源" width="130" />
          <el-table-column label="原金额" width="120"><template #default="{ row }"><MoneyText :value="row.lineAmount" :currency="order?.currency" /></template></el-table-column>
          <el-table-column prop="cancelledQty" label="已取消（基础）" width="115" />
          <el-table-column prop="outboundQty" label="已出库（基础）" width="115" />
          <el-table-column prop="openQty" label="未出库（基础）" width="115" />
          <el-table-column label="分仓（基础）" min-width="260"><template #default="{ row }"><span v-for="a in row.allocs" :key="a.id" class="tag">{{ a.warehouseName }} · 原 {{ formatQty(a.allocQty) }} / 取消 {{ formatQty(a.cancelledQty) }} / 有效 {{ formatQty(a.allocQty == null || a.cancelledQty == null ? null : Number(a.allocQty) - Number(a.cancelledQty)) }}</span></template></el-table-column>
        </el-table>
      </el-tab-pane>
      <el-tab-pane label="出库检查" name="check">
        <el-button @click="runCheck">按首个仓库检查</el-button>
        <el-table :data="checks" size="small" class="mt">
          <el-table-column prop="item" label="检查项" width="140" />
          <el-table-column label="结果" width="90"><template #default="{ row }"><el-tag :type="row.ok ? 'success' : 'danger'">{{ row.ok ? '通过' : '未通过' }}</el-tag></template></el-table-column>
          <el-table-column prop="message" label="说明" />
        </el-table>
      </el-tab-pane>
      <el-tab-pane label="销售单据" name="doc">
        <DocAttachment v-if="order && user.fieldAccess('CUSTOMER_PRICE') !== 'HIDDEN'" biz-type="SAL_ORDER" :biz-id="id" category="SALES_DOC" :readonly="user.fieldAccess('CUSTOMER_PRICE') !== 'WRITE' || !user.hasPerm(['sal:order:create', 'sal:order:submit', 'sal:outbound:confirm'])" />
        <p v-else class="muted">没有查看销售单据的权限</p>
      </el-tab-pane>
      <el-tab-pane label="收款凭证" name="pay">
        <DocAttachment v-if="order && user.fieldAccess('BANK_INFO') !== 'HIDDEN'" biz-type="SAL_ORDER" :biz-id="id" category="PAYMENT_PROOF" :readonly="user.fieldAccess('BANK_INFO') !== 'WRITE' || !user.hasPerm(['sal:order:create', 'sal:order:submit', 'sal:outbound:confirm'])" />
        <p v-else class="muted">没有查看收款凭证的权限</p>
      </el-tab-pane>
      <el-tab-pane label="审批" name="approval"><ApprovalPanel v-if="order" doc-type="SALES_ORDER" :doc-id="id" /></el-tab-pane>
      <el-tab-pane label="时间线" name="time">
        <el-timeline>
          <el-timeline-item v-for="(t, i) in timeline" :key="i" :timestamp="t.at"><DateTimeText :value="t.at" /> {{ t.type }} {{ t.text }}</el-timeline-item>
        </el-timeline>
      </el-tab-pane>
      <el-tab-pane label="日志" name="audit"><AuditTimeline resource-type="sales-order" :resource-id="id" /></el-tab-pane>
    </el-tabs>

    <el-dialog v-model="cancelForm.visible" :title="cancelForm.close ? '关闭全部未交数量' : '取消指定未交数量'" width="700px">
      <el-alert type="info" :closable="false" title="只处理未交数量；已出库事实保留，库存和授信占用由原服务释放。" />
      <el-form label-width="90px" class="mt">
        <el-form-item label="操作日期" required><el-date-picker v-model="cancelForm.bizDate" type="date" value-format="YYYY-MM-DD" /></el-form-item>
        <el-form-item label="原因" required><el-input v-model="cancelForm.reason" type="textarea" /></el-form-item>
      </el-form>
      <el-table :data="cancelForm.lines" size="small">
        <el-table-column label="商品"><template #default="{ row }"><ProductCell :code="row.productCode" :name="row.productName" /></template></el-table-column>
        <el-table-column prop="openQty" label="原未出库" width="110" />
        <el-table-column v-if="!cancelForm.close" label="取消数量" width="150"><template #default="{ row }"><el-input-number v-model="row.qty" :min="0" :max="row.openQty" :precision="4" :controls="false" style="width: 100%" /></template></el-table-column>
      </el-table>
      <template #footer><el-button @click="cancelForm.visible = false">取消</el-button><el-button type="primary" :loading="cancelForm.saving" @click="saveCancellation">{{ cancelForm.close ? '关闭全部未交' : '确认取消数量' }}</el-button></template>
    </el-dialog>

    <el-dialog v-model="allocationForm.visible" title="编辑原订单分仓" width="820px">
      <el-alert type="warning" :closable="false" title="修改将使原审批失效，释放未交预留并返回草稿，须重新提交审批。分仓数量包含历史已出库及已取消数量，合计须等于原基础数量。" />
      <el-form label-width="90px" class="mt"><el-form-item label="操作日期" required><el-date-picker v-model="allocationForm.bizDate" type="date" value-format="YYYY-MM-DD" /></el-form-item></el-form>
      <div v-for="line in allocationForm.lines" :key="line.id" class="mt">
        <p><ProductCell :code="line.productCode" :name="line.productName" /> 基础数量 {{ line.baseQty }} · 原未出库 {{ line.openQty }}</p>
        <el-table :data="line.allocs" size="small">
          <el-table-column label="发货仓"><template #default="{ row }"><el-select v-model="row.warehouseId" :disabled="Number(row.outboundQty ?? 0) + Number(row.cancelledQty ?? 0) > 0">
            <el-option v-for="warehouse in allocationForm.warehouses" :key="warehouse.id" :value="warehouse.id" :label="warehouse.name" />
            <el-option v-if="row.warehouseId && !allocationForm.warehouses.some(warehouse => warehouse.id === row.warehouseId)" :value="row.warehouseId" :label="row.warehouseName || `仓库#${row.warehouseId}`" />
          </el-select></template></el-table-column>
          <el-table-column label="累计分仓量" width="170"><template #default="{ row }"><el-input-number v-model="row.allocQty" :min="Number(row.outboundQty ?? 0) + Number(row.cancelledQty ?? 0)" :precision="4" :controls="false" style="width: 100%" /></template></el-table-column>
          <el-table-column prop="outboundQty" label="已出库" width="85" />
          <el-table-column prop="cancelledQty" label="已取消" width="85" />
          <el-table-column label="操作" width="70"><template #default="{ row, $index }"><el-button link type="danger" :disabled="Number(row.outboundQty ?? 0) + Number(row.cancelledQty ?? 0) > 0" @click="line.allocs.splice($index, 1)">移除</el-button></template></el-table-column>
        </el-table>
        <el-button class="mt" @click="line.allocs.push({ warehouseId: undefined, allocQty: 0 })">添加分仓</el-button>
      </div>
      <template #footer><el-button @click="allocationForm.visible = false">取消</el-button><el-button type="primary" :loading="allocationForm.saving" @click="saveAllocations">保存分仓并重新审批</el-button></template>
    </el-dialog>

    <el-dialog v-model="ob.visible" title="确认出库" width="640px">
      <el-form label-width="88px">
        <el-form-item label="出库仓">
          <el-select v-model="ob.warehouseId" @change="runCheck"><el-option v-for="w in warehouses" :key="w.value" :label="w.label" :value="w.value" /></el-select>
        </el-form-item>
      </el-form>
      <el-table :data="(order?.lines ?? []).flatMap((l: Row) => l.allocs.filter((a: Row) => a.warehouseId === ob.warehouseId && a.openQty > 0).map((a: Row) => ({ ...a, productCode: l.productCode, productName: l.productName })))" size="small">
        <el-table-column label="商品" min-width="160"><template #default="{ row }"><ProductCell :code="row.productCode" :name="row.productName" /></template></el-table-column>
        <el-table-column prop="openQty" label="未出库" width="90" />
        <el-table-column label="本次" width="140"><template #default="{ row }"><el-input-number v-model="ob.qty[row.id]" :min="0" :max="row.openQty" controls-position="right" /></template></el-table-column>
      </el-table>
      <el-alert v-for="c in checks.filter((x) => !x.ok)" :key="c.item" class="mt" type="error" :title="`${c.item}：${c.message}`" show-icon :closable="false" />
      <template #footer>
        <el-button @click="ob.visible = false">取消</el-button>
        <el-button type="primary" :loading="ob.saving" :disabled="checks.some((c) => !c.ok)" @click="confirmOut">确认出库</el-button>
      </template>
    </el-dialog>
  </div>
</template>

<style scoped>
.head { display: flex; justify-content: space-between; align-items: flex-start; margin-bottom: 12px; }
h2 { margin: 4px 0 8px; }
.mt { margin-top: 12px; }
.tag { margin-right: 8px; }
</style>
