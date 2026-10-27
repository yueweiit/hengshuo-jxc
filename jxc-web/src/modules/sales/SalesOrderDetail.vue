<script setup lang="ts">
import { canEditSalesOrder, canSubmitSalesOrder, canOutboundSalesOrder } from './salesOrderActions'
import { computed, onMounted, reactive, ref, watch } from 'vue'
import { useRoute, useRouter } from 'vue-router'
import { ElMessage } from 'element-plus'
import { BizError, http, createCommandIntent } from '@/api/http'
import { allRecords } from '@/api/pagination'
import { commandPayloadFingerprint } from '@/api/command-intent'
import { getToken, getCountryId } from '@/utils/session'
import { formatDate, todayIn } from '@/utils/format'
import { useCountryStore } from '@/stores/country'
import { useUserStore } from '@/stores/user'
import StatusTag from '@/components/StatusTag.vue'
import MoneyText from '@/components/MoneyText.vue'
import QtyText from '@/components/QtyText.vue'
import DateTimeText from '@/components/DateTimeText.vue'
import ApprovalPanel from '@/components/ApprovalPanel.vue'
import DocAttachment from '@/components/DocAttachment.vue'
import AuditDrawer from '@/components/AuditDrawer.vue'
import { salesOrderAudit } from './salesOrderAudit'
import OutboundPaymentCheck from './OutboundPaymentCheck.vue'
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
const auditVisible = ref(false)
const auditContext = computed(() => ({ title: '销售订单', identifier: order.value?.docNo || `记录 #${id.value}` }))
// 缺时刻、时区或格式错误的事件放到末尾，不按本机时区推测。
function timelineTime(value: unknown) {
  return typeof value === 'string' && value.includes('T') && /(?:Z|[+-]\d{2}:\d{2})$/.test(value) ? Date.parse(value) : NaN
}
const orderedTimeline = computed(() => timeline.value.map((item, index) => ({ item, index, time: timelineTime(item.at) }))
  .sort((a, b) => (Number.isFinite(a.time) ? a.time : Infinity) - (Number.isFinite(b.time) ? b.time : Infinity) || a.index - b.index).map(({ item }) => item))
const loading = ref(false)
const loadError = ref('')
const timelineError = ref('')
const timelineLoading = ref(false)
const checkError = ref('')
const checkLoading = ref(false)
const checkedWarehouseId = ref<number>()
const tab = ref('check')
const ob = reactive({ visible: false, warehouseId: undefined as number | undefined, qty: {} as Record<number, number>, saving: false, key: createCommandIntent() })
const cancelForm = reactive({ visible: false, close: false, saving: false, reason: '', bizDate: '', lines: [] as Row[], intent: createCommandIntent() })
const allocationForm = reactive({ visible: false, loading: false, saving: false, version: 0, bizDate: '', lines: [] as Row[], warehouses: [] as Row[] })
let cancellationScope = '', allocationScope = '', allocationRequest = 0
let loadRequest = 0, timelineRequest = 0, checkRequest = 0, checkedScope = ''
let checkedSelection = ''
const originalAllocations = new Map<number, string>()

let outboundAttempt: { fingerprint: string; draft: Row; bizDate: string } | null = null
const id = computed(() => Number(route.params.id))
const fullOrder = computed(() => Number(order.value?.id) === id.value && order.value?.totalQty != null)
const mutableOrder = computed(() => fullOrder.value && canEditSalesOrder(order.value))
const canSubmit = computed(() => fullOrder.value && canSubmitSalesOrder(order.value) && user.hasPerm('sal:order:submit'))
const canOutbound = computed(() => Number(order.value?.id) === id.value && canOutboundSalesOrder(order.value) && user.hasPerm('sal:outbound:create'))
const detailScope = () => JSON.stringify([id.value, getCountryId(), getToken(), country.epoch])
const allocationKey = (allocs: Row[]) => JSON.stringify(allocs.map(row => [row.id ?? null, Number(row.warehouseId), Number(row.allocQty)]).sort((a, b) => Number(a[1]) - Number(b[1])))
const warehouses = computed(() => {
  const map = new Map<number, string>()
  for (const l of order.value?.lines ?? []) for (const a of l.allocs ?? []) map.set(a.warehouseId, a.warehouseName)
  return [...map].map(([value, label]) => ({ value, label }))
})
function selectedOutboundLines() {
  const allowed = new Set((order.value?.lines ?? []).flatMap((line: Row) => line.allocs.filter((allocation: Row) => allocation.warehouseId === ob.warehouseId).map((allocation: Row) => allocation.id)))
  return Object.entries(ob.qty).filter(([allocation, qty]) => allowed.has(Number(allocation)) && Number.isFinite(qty) && qty > 0).map(([allocation, qty]) => ({ allocId: Number(allocation), qty })).sort((a, b) => a.allocId - b.allocId)
}
function checkSelection() { return JSON.stringify([detailScope(), order.value?.version, ob.warehouseId, ob.visible ? selectedOutboundLines() : null]) }
const paymentCheck = computed(() => checks.value.find(check => check.item === '现款到账'))
function canUploadSalesAttachment(field: 'BANK_INFO' | 'CUSTOMER_PRICE') {
  return user.fieldAccess(field) === 'WRITE' && user.hasPerm(['sal:order:create', 'sal:order:submit', 'sal:outbound:confirm'])
}
const canConfirmOut = computed(() => canOutbound.value && user.hasPerm('sal:outbound:confirm') && !loading.value && !checkLoading.value && !checkError.value && checkedWarehouseId.value !== undefined && checkedWarehouseId.value === ob.warehouseId && (!ob.visible || selectedOutboundLines().length > 0 && checkedSelection === checkSelection()) && checks.value.every(check => check.ok))
const canCancel = computed(() => mutableOrder.value && Number(order.value?.openQty) > 0 && user.hasPerm(['sal:order:cancel', 'sal:order:create']))
const canClose = computed(() => mutableOrder.value && Number(order.value?.openQty) > 0 && user.hasPerm(['sal:order:close', 'sal:order:create']))

function errorMessage(error: unknown) {
  return error instanceof Error && error.message.trim() ? error.message : '请求失败，请重试'
}

const priceSources: Record<string, string> = { BASE: '基础价', LEVEL: '等级价', CUSTOMER_SKU: '客户专属价', CUSTOMER: '客户价', MANUAL: '人工定价' }
function priceSourceLabel(value?: string | null) {
  // 未知来源保留原值，缺值才显示占位。
  return value ? priceSources[value] ?? value : '-'
}

function resetChecks() {
  ++checkRequest
  checks.value = []
  checkedWarehouseId.value = undefined
  checkedScope = ''
  checkError.value = ''
  checkLoading.value = false
}

async function load() {
  const request = ++loadRequest, scope = detailScope(), orderId = id.value
  ++timelineRequest
  order.value = null
  auditVisible.value = false
  timeline.value = []
  timelineError.value = ''
  timelineLoading.value = false
  loadError.value = ''
  resetChecks()
  ob.visible = cancelForm.visible = allocationForm.visible = false
  ob.warehouseId = undefined
  loading.value = true
  try {
    const result = await http.get<Row>(`/sal/orders/${orderId}`, undefined, { silent: true })
    if (request !== loadRequest || scope !== detailScope()) return
    if (!result || Number(result.id) !== orderId || !Array.isArray(result.lines)) throw new Error('订单详情返回格式不正确，请重新加载')
    order.value = result
    ob.warehouseId = warehouses.value[0]?.value
    loading.value = false
    await restoreOutboundSelection()
    await loadTimeline()
  } catch (error) {
    if (request === loadRequest && scope === detailScope()) loadError.value = errorMessage(error)
  } finally {
    if (request === loadRequest) loading.value = false
  }
}

async function loadTimeline() {
  if (Number(order.value?.id) !== id.value) return
  const request = ++timelineRequest, scope = detailScope(), orderId = id.value
  timelineLoading.value = true
  timelineError.value = ''
  try {
    const result = await http.get<Row[]>(`/sal/orders/${orderId}/timeline`, undefined, { silent: true })
    if (request !== timelineRequest || scope !== detailScope()) return
    if (!Array.isArray(result) || !result.every(item => item && typeof item === 'object' && !Array.isArray(item) && typeof item.type === 'string' && typeof item.text === 'string')) throw new Error('时间线返回格式不正确，请重新加载')
    timeline.value = result
  } catch (error) {
    if (request === timelineRequest && scope === detailScope()) timelineError.value = errorMessage(error)
  } finally {
    if (request === timelineRequest) timelineLoading.value = false
  }
}

async function runCheck() {
  const warehouseId = ob.warehouseId ?? warehouses.value[0]?.value
  ob.warehouseId = warehouseId
  resetChecks()
  if (!warehouseId || Number(order.value?.id) !== id.value || !warehouses.value.some(warehouse => warehouse.value === warehouseId)) return
  const lines = selectedOutboundLines()
  if (ob.visible && !lines.length) { checkError.value = '请至少填写一项大于零的本次出库数量'; return }
  const request = checkRequest, scope = detailScope(), orderId = id.value, selection = checkSelection()
  checkLoading.value = true
  try {
    const result = ob.visible
      ? await http.post<{ checks: Row[] }>(`/sal/orders/${orderId}/outbound-check`, { warehouseId, lines }, { silent: true })
      : await http.get<{ checks: Row[] }>(`/sal/orders/${orderId}/outbound-check`, { warehouseId }, { silent: true })
    if (request !== checkRequest || scope !== detailScope() || ob.warehouseId !== warehouseId || selection !== checkSelection()) return
    if (!result || !Array.isArray(result.checks) || result.checks.some(check => !check || typeof check.ok !== 'boolean')) throw new Error('出库检查返回格式不正确，请重新检查')
    const cash = result.checks.find(check => check.item === '现款到账')
    if (cash && (!cash.payment || typeof cash.payment.amountsVisible !== 'boolean' || typeof cash.payment.currency !== 'string' || cash.payment.amountsVisible && ['requiredAmount', 'confirmedAmount', 'shortageAmount'].some(key => cash.payment[key] == null || cash.payment[key] === '' || !Number.isFinite(Number(cash.payment[key]))))) throw new Error('收款金额明细返回不完整，请重新检查')
    checks.value = result.checks
    checkedScope = scope
    checkedSelection = selection
    checkedWarehouseId.value = warehouseId
  } catch (error) {
    if (request === checkRequest && scope === detailScope() && ob.warehouseId === warehouseId) checkError.value = errorMessage(error)
  } finally {
    if (request === checkRequest) checkLoading.value = false
  }
}

async function outboundSessionHash() {
  const bytes = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(getToken() ?? ''))
  return Array.from(new Uint8Array(bytes), value => value.toString(16).padStart(2, '0')).join('')
}
async function paymentAction(action: string) {
  if (action === 'payment-proof' || action === 'sales-doc') { ob.visible = false; tab.value = action === 'payment-proof' ? 'pay' : 'doc'; return }
  const path = action === 'confirm' ? '/ar/receipts/confirm' : '/ar/receipts'
  const owner = user.user?.id
  if (owner && typeof sessionStorage !== 'undefined') {
    const scope = detailScope()
    try {
      const sessionHash = await outboundSessionHash()
      if (scope !== detailScope()) return ElMessage.warning('国家、账号或订单已切换，请重新打开收款入口')
      sessionStorage.setItem(`jxc:outbound:${getCountryId()}:${owner}:${id.value}`, JSON.stringify({ sessionHash, version: order.value?.version, warehouseId: ob.warehouseId, qty: ob.qty, visible: ob.visible }))
    }
    catch (error) { ElMessage.warning(`无法保留出库选择，返回后请重新填写：${errorMessage(error)}`) }
  }
  router.push({ path, query: { orderId: String(id.value), source: 'sales-outbound', action } })
}
async function restoreOutboundSelection() {
  const owner = user.user?.id
  if (route.query?.resumeOutbound !== '1' || !owner || typeof sessionStorage === 'undefined') return
  const key = `jxc:outbound:${getCountryId()}:${owner}:${id.value}`
  try {
    const raw = sessionStorage.getItem(key)
    if (raw == null) return
    sessionStorage.removeItem(key)
    const saved = JSON.parse(raw)
    const scope = detailScope(), sessionHash = await outboundSessionHash()
    if (scope !== detailScope() || saved.sessionHash !== sessionHash) { ElMessage.warning('登录会话已变化，请重新选择出库仓和数量'); return }
    if (saved.version !== order.value?.version) { ElMessage.warning('订单版本已变化，请重新选择出库仓和数量'); return }
    const allocations = (order.value?.lines ?? []).flatMap((line: Row) => line.allocs).filter((allocation: Row) => allocation.warehouseId === saved.warehouseId)
    if (!allocations.length || !saved.qty || typeof saved.qty !== 'object') throw new Error('原出库选择已失效')
    const qty: Record<number, number> = {}
    for (const [key, value] of Object.entries(saved.qty)) {
      const allocation = allocations.find((row: Row) => row.id === Number(key))
      if (!allocation) continue
      if (typeof value !== 'number' || !Number.isFinite(value) || value < 0 || value > allocation.openQty) throw new Error('原出库数量已变化，请重新填写')
      qty[allocation.id] = value
    }
    Object.assign(ob, { warehouseId: saved.warehouseId, qty, visible: saved.visible === true })
    await runCheck()
  } catch (error) { ElMessage.warning(`无法恢复原出库选择：${errorMessage(error)}`) }
}

async function submit() {
  if (!canSubmit.value) return ElMessage.warning('订单已停止供货或没有可提交的未交数量')
  const orderId = id.value, scope = detailScope()
  await confirmAction('提交这张订单？', () => {
    if (scope !== detailScope() || !canSubmit.value) throw new Error('订单已切换、关闭或不再允许提交')
    return http.postIdem(`/sal/orders/${orderId}/submit`, undefined, supplyCommandIntent)
  }, { success: '已提交' })
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
  if (!mutableOrder.value || cancellationScope !== detailScope()) return ElMessage.warning('国家、登录状态或订单已切换，请重新打开操作')
  if (!cancelForm.reason.trim() || !cancelForm.bizDate) return ElMessage.warning('请填写操作日期和原因')
  const selected = cancelForm.lines.filter(line => Number(line.qty) > 0)
  if (!cancelForm.close && (!selected.length || selected.some(line => !Number.isFinite(Number(line.qty)) || Number(line.qty) > Number(line.openQty)))) return ElMessage.warning('请选择取消数量，且不能超过原订单未出库数量')
  const body = { bizDate: cancelForm.bizDate, reason: cancelForm.reason.trim(), ...(!cancelForm.close ? { lines: selected.map(line => ({ lineId: line.lineId, qty: Number(line.qty) })) } : {}) }
  const commandId = id.value, scope = cancellationScope, close = cancelForm.close, intent = cancelForm.intent
  cancelForm.saving = true
  try {
    const completed = await confirmAction(close ? '关闭这张订单的全部未交数量？已出库事实保留。' : '取消所选未交数量？原服务将释放对应库存与授信占用。', () => {
      if (!mutableOrder.value || scope !== detailScope()) throw new BizError('CONTEXT_CHANGED', '国家、登录状态或订单已切换，请重新打开操作')
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
  if (!mutableOrder.value || allocationScope !== detailScope()) return ElMessage.warning('国家、登录状态或订单已切换，请重新打开分仓')
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

async function openOutbound() {
  if (!canOutbound.value) return ElMessage.warning('订单已停止供货或没有可出库的未交数量')
  outboundAttempt = null
  const qty: Record<number, number> = {}
  for (const l of order.value?.lines ?? []) for (const a of l.allocs ?? []) if (a.openQty > 0) qty[a.id] = a.openQty
  Object.assign(ob, { visible: true, warehouseId: warehouses.value[0]?.value, qty, key: createCommandIntent() })
  await runCheck()
}

async function confirmOut() {
  if (!canConfirmOut.value || checkedScope !== detailScope()) return ElMessage.warning('请先完成当前出库仓的检查，并处理未通过的检查项')
  if (ob.saving) return
  const lines = selectedOutboundLines()
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
watch(() => ob.warehouseId, resetChecks, { flush: 'sync' })
watch(() => JSON.stringify([ob.visible, ob.qty, order.value?.version]), () => { if (ob.visible) resetChecks() }, { flush: 'sync' })
onMounted(load)
</script>

<template>
  <div v-loading="loading" class="page sales-order-detail" :aria-busy="loading">
    <div class="detail-navigation">
      <el-button link type="primary" @click="router.push('/sales/orders')">返回销售订单列表</el-button>
      <span v-if="loading" class="muted" role="status">正在读取订单…</span>
    </div>
    <div v-if="loadError" class="page-card error-panel" role="alert">
      <el-alert title="订单读取失败" :description="loadError" type="error" :closable="false" show-icon />
      <el-button :loading="loading" @click="load">重新加载订单</el-button>
    </div>
    <template v-else-if="order">
      <section class="page-card detail-summary" aria-labelledby="order-title">
        <div class="page-title detail-heading">
          <div class="order-identity">
            <h2 id="order-title">销售订单 <span class="mono">{{ order.docNo }}</span></h2>
            <p class="customer-name">{{ order.customerName || '-' }}</p>
          </div>
          <div class="toolbar detail-actions" aria-label="订单操作">
            <el-button v-if="canSubmit" type="primary" @click="submit">提交审批</el-button>
            <el-button v-if="canOutbound" type="primary" @click="openOutbound">出库</el-button>
            <el-button v-if="mutableOrder && user.hasPerm('sal:order:edit')" @click="router.push({ path: '/sales/orders', query: { edit: String(id) } })">编辑订单</el-button>
            <el-button v-if="mutableOrder && user.hasPerm('sal:order:edit')" :loading="allocationForm.loading" @click="openAllocations">编辑分仓</el-button>
            <el-button v-if="order.approvalStatus === 'PENDING' && user.hasPerm('sal:order:submit')" @click="withdraw">撤回审批</el-button>
            <el-button v-if="order.customerId" @click="router.push(`/ar/customers/${order.customerId}`)">客户往来</el-button>
            <el-button @click="auditVisible = true"><el-icon><Clock /></el-icon>操作日志</el-button>
            <el-dropdown v-if="canCancel || canClose" trigger="click">
              <el-button>更多操作 <span aria-hidden="true">⌄</span></el-button>
              <template #dropdown><el-dropdown-menu>
                <el-dropdown-item v-if="canCancel" @click="openCancel(false)">取消未交</el-dropdown-item>
                <el-dropdown-item v-if="canClose" @click="openCancel(true)">关闭未交</el-dropdown-item>
              </el-dropdown-menu></template>
            </el-dropdown>
          </div>
        </div>
        <div class="order-statuses" aria-label="订单状态">
          <div><span>付款方式</span><StatusTag :status="order.paymentType" /></div>
          <div><span>审批</span><StatusTag :status="order.approvalStatus" domain="approvalDoc" /></div>
          <div><span>履约</span><StatusTag :status="order.fulfillmentStatus" /></div>
          <div><span>付款</span><StatusTag :status="order.paymentStatus" /></div>
        </div>
        <dl class="summary-values">
          <div class="summary-key"><dt>有效金额</dt><dd><MoneyText :value="order.totalAmount" :currency="order.currency" /></dd></div>
          <div class="summary-key"><dt>未出库数量（基础）</dt><dd><QtyText :value="order.openQty" /></dd></div>
          <div><dt>业务日期</dt><dd>{{ formatDate(order.orderDate) }}</dd></div>
          <div><dt>币种</dt><dd>{{ order.currency || '-' }}</dd></div>
          <div><dt>业务员</dt><dd>{{ order.salespersonName || '-' }}</dd></div>
          <div><dt>录入人</dt><dd>{{ order.enteredByName || '-' }}</dd></div>
          <div><dt>门店</dt><dd>{{ order.storeName || '-' }}</dd></div>
          <div class="summary-remark"><dt>备注</dt><dd>{{ order.remark || '-' }}</dd></div>
        </dl>
        <p v-if="!fullOrder" class="muted scope-note">当前仅展示权限范围内的订单信息。</p>
      </section>

      <section class="page-card products-section" aria-labelledby="products-title">
        <div class="section-heading"><h3 id="products-title">商品明细</h3><span class="muted">{{ order.lines.length }} 行 · 展开商品行查看分仓</span></div>
        <p class="muted quantity-note">原下单数量按销售单位显示；基础数量的未出库 = 原基础数量 − 已取消 − 已出库。</p>
        <el-table :data="order.lines" row-key="id" border stripe size="small" class="detail-table" empty-text="当前权限范围内没有商品明细">
          <el-table-column type="expand" width="44">
            <template #default="{ row: line }">
              <div class="allocation-detail">
                <h4>分仓明细 <span class="muted">数量均为基础数量</span></h4>
                <el-table :data="line.allocs ?? []" row-key="id" border stripe size="small" class="detail-table" empty-text="没有分仓记录">
                  <el-table-column prop="warehouseName" label="发货仓" min-width="160" show-overflow-tooltip />
                  <el-table-column label="原分仓量" min-width="115" align="right"><template #default="{ row }"><QtyText :value="row.allocQty" /></template></el-table-column>
                  <el-table-column label="已取消" min-width="110" align="right"><template #default="{ row }"><QtyText :value="row.cancelledQty" /></template></el-table-column>
                  <el-table-column label="有效分仓量" min-width="115" align="right"><template #default="{ row }"><QtyText :value="row.allocQty == null || row.cancelledQty == null ? null : Number(row.allocQty) - Number(row.cancelledQty)" /></template></el-table-column>
                  <el-table-column label="已出库" min-width="110" align="right"><template #default="{ row }"><QtyText :value="row.outboundQty" /></template></el-table-column>
                  <el-table-column label="未出库" min-width="110" align="right"><template #default="{ row }"><QtyText :value="row.openQty" /></template></el-table-column>
                </el-table>
              </div>
            </template>
          </el-table-column>
          <el-table-column label="商品" min-width="220"><template #default="{ row }"><ProductCell :code="row.productCode" :name="row.productName" /></template></el-table-column>
          <el-table-column label="原下单数量" min-width="140" align="right"><template #default="{ row }"><QtyText :value="row.qty" :unit="row.unit" /></template></el-table-column>
          <el-table-column label="原基础数量" min-width="125" align="right"><template #default="{ row }"><QtyText :value="row.baseQty" /></template></el-table-column>
          <el-table-column label="成交价" min-width="130" align="right"><template #default="{ row }"><MoneyText :value="row.price" :currency="order.currency" /></template></el-table-column>
          <el-table-column label="价格来源" min-width="115" show-overflow-tooltip><template #default="{ row }">{{ priceSourceLabel(row.priceSource) }}</template></el-table-column>
          <el-table-column label="原金额" min-width="145" align="right"><template #default="{ row }"><MoneyText :value="row.lineAmount" :currency="order.currency" /></template></el-table-column>
          <el-table-column label="已取消（基础）" min-width="130" align="right"><template #default="{ row }"><QtyText :value="row.cancelledQty" /></template></el-table-column>
          <el-table-column label="已出库（基础）" min-width="130" align="right"><template #default="{ row }"><QtyText :value="row.outboundQty" /></template></el-table-column>
          <el-table-column label="未出库（基础）" min-width="130" align="right"><template #default="{ row }"><QtyText :value="row.openQty" /></template></el-table-column>
        </el-table>
      </section>

      <section class="page-card records-section" aria-labelledby="records-title">
        <div class="section-heading"><h3 id="records-title">相关记录</h3></div>
        <el-tabs v-model="tab" class="records-tabs">
      <el-tab-pane label="出库检查" name="check">
        <div class="toolbar check-toolbar">
          <label for="sales-check-warehouse">出库仓</label>
          <el-select id="sales-check-warehouse" v-model="ob.warehouseId" :disabled="!warehouses.length || ob.saving" placeholder="请选择出库仓" @change="runCheck"><el-option v-for="warehouse in warehouses" :key="warehouse.value" :label="warehouse.label" :value="warehouse.value" /></el-select>
          <el-button :loading="checkLoading" :disabled="!warehouses.length || ob.saving" @click="runCheck">{{ checkedWarehouseId === undefined && !checkError ? '开始检查' : '重新检查' }}</el-button>
        </div>
        <el-alert v-if="checkError" :title="checkError" type="error" :closable="false" show-icon class="mt" />
        <p v-if="!warehouses.length" class="muted" role="status">没有可检查的分仓。</p>
        <p v-else-if="checkLoading" class="muted" role="status">正在检查所选出库仓…</p>
        <p v-else-if="!checkError && checkedWarehouseId === undefined" class="muted">尚未检查，请先选择出库仓，再开始检查。</p>
        <p v-else-if="!checkError && !checks.length" class="muted">检查已完成，未返回检查项。</p>
        <el-table v-if="checks.length" :data="checks" row-key="item" border stripe size="small" class="detail-table mt">
          <el-table-column prop="item" label="检查项" width="140" />
          <el-table-column label="结果" width="100"><template #default="{ row }"><el-tag size="small" :disable-transitions="true" :type="row.ok ? 'success' : 'danger'">{{ row.ok ? '通过' : '未通过' }}</el-tag></template></el-table-column>
          <el-table-column prop="message" label="说明" min-width="220" show-overflow-tooltip />
        </el-table>
        <p class="muted">此处按所选仓全部未出库数量检查；出库弹窗按本次填写数量重新计算。</p>
        <OutboundPaymentCheck v-if="paymentCheck" :check="paymentCheck" @action="paymentAction" @retry="runCheck" />
        <el-button v-if="checks.some(c => !c.ok && c.code === 'SAL_PAYMENT_EVIDENCE_REQUIRED') && canUploadSalesAttachment('BANK_INFO')" link type="primary" @click="paymentAction('payment-proof')">去补收款凭证</el-button>
        <el-button v-if="checks.some(c => !c.ok && c.code === 'SAL_ATTACHMENT_MISSING') && canUploadSalesAttachment('CUSTOMER_PRICE')" link type="primary" @click="paymentAction('sales-doc')">去上传销售单据</el-button>
      </el-tab-pane>
      <el-tab-pane label="销售单据" name="doc">
        <DocAttachment v-if="order && user.fieldAccess('CUSTOMER_PRICE') !== 'HIDDEN'" biz-type="SAL_ORDER" :biz-id="id" category="SALES_DOC" :readonly="!canUploadSalesAttachment('CUSTOMER_PRICE')" />
        <p v-else class="muted">没有查看销售单据的权限</p>
      </el-tab-pane>
      <el-tab-pane label="收款凭证" name="pay">
        <DocAttachment v-if="order && user.fieldAccess('BANK_INFO') !== 'HIDDEN'" biz-type="SAL_ORDER" :biz-id="id" category="PAYMENT_PROOF" :readonly="!canUploadSalesAttachment('BANK_INFO')" />
        <p v-else class="muted">没有查看收款凭证的权限</p>
      </el-tab-pane>
      <el-tab-pane label="审批" name="approval"><ApprovalPanel v-if="order" doc-type="SALES_ORDER" :doc-id="id" /></el-tab-pane>
      <el-tab-pane label="时间线" name="time">
        <div class="timeline-heading"><div><h4>建单与出库记录</h4><span class="muted">从早到晚<span v-if="!timelineLoading && !timelineError"> · {{ timeline.length }} 条记录</span></span></div><el-button link type="primary" :disabled="timelineLoading" @click="loadTimeline"><el-icon><Refresh /></el-icon>刷新时间线</el-button></div>
        <div v-if="timelineError" class="error-panel" role="alert"><el-alert :title="timelineError" type="error" :closable="false" show-icon /><el-button :loading="timelineLoading" @click="loadTimeline">重新加载时间线</el-button></div>
        <p v-else-if="timelineLoading" class="muted" role="status">正在读取时间线…</p>
        <el-timeline v-else-if="orderedTimeline.length" class="order-timeline" aria-label="销售订单建单与出库时间线">
          <el-timeline-item v-for="(item, index) in orderedTimeline" :key="`${item.at}:${item.type}:${index}`" :type="item.type === '建单' ? 'primary' : undefined">
            <div class="timeline-time"><DateTimeText v-if="Number.isFinite(timelineTime(item.at))" :value="item.at" /><span v-else>{{ item.at ? '时间格式或时区无法识别' : '时间未记录' }}</span></div>
            <div class="timeline-event"><strong>{{ item.type }}</strong><p class="mono">{{ item.text }}</p><span v-if="item.at && !Number.isFinite(timelineTime(item.at))" class="muted">原始时间：{{ item.at }}</span></div>
          </el-timeline-item>
        </el-timeline>
        <el-empty v-else description="暂无时间线记录" :image-size="48" />
      </el-tab-pane>
        </el-tabs>
      </section>
      <AuditDrawer v-if="auditVisible && order" :key="id" v-model="auditVisible" resource-type="sales-order" :resource-id="id" :context="auditContext" :presentation="salesOrderAudit" />
    </template>

    <el-dialog v-model="cancelForm.visible" :title="cancelForm.close ? '关闭全部未交数量' : '取消指定未交数量'" width="min(700px, 96vw)">
      <el-alert type="info" :closable="false" title="只处理未交数量；已出库事实保留，库存和授信占用由原服务释放。" />
      <el-form label-width="90px" class="mt">
        <el-form-item label="操作日期" required><el-date-picker v-model="cancelForm.bizDate" type="date" value-format="YYYY-MM-DD" /></el-form-item>
        <el-form-item label="原因" required><el-input v-model="cancelForm.reason" type="textarea" /></el-form-item>
      </el-form>
      <el-table :data="cancelForm.lines" row-key="lineId" border stripe size="small" class="detail-table">
        <el-table-column label="商品"><template #default="{ row }"><ProductCell :code="row.productCode" :name="row.productName" /></template></el-table-column>
        <el-table-column label="原未出库（基础）" min-width="140" align="right"><template #default="{ row }"><QtyText :value="row.openQty" /></template></el-table-column>
        <el-table-column v-if="!cancelForm.close" label="取消数量" width="150"><template #default="{ row }"><el-input-number v-model="row.qty" :min="0" :max="row.openQty" :precision="4" :controls="false" style="width: 100%" /></template></el-table-column>
      </el-table>
      <template #footer><el-button @click="cancelForm.visible = false">取消</el-button><el-button type="primary" :loading="cancelForm.saving" @click="saveCancellation">{{ cancelForm.close ? '关闭全部未交' : '确认取消数量' }}</el-button></template>
    </el-dialog>

    <el-dialog v-model="allocationForm.visible" title="编辑原订单分仓" width="min(820px, 96vw)">
      <el-alert type="warning" :closable="false" title="修改将使原审批失效，释放未交预留并返回草稿，须重新提交审批。分仓数量包含历史已出库及已取消数量，合计须等于原基础数量。" />
      <el-form label-width="90px" class="mt"><el-form-item label="操作日期" required><el-date-picker v-model="allocationForm.bizDate" type="date" value-format="YYYY-MM-DD" /></el-form-item></el-form>
      <div v-for="line in allocationForm.lines" :key="line.id" class="mt">
        <p><ProductCell :code="line.productCode" :name="line.productName" /> 基础数量 <QtyText :value="line.baseQty" /> · 原未出库 <QtyText :value="line.openQty" /></p>
        <el-table :data="line.allocs" border stripe size="small" class="detail-table">
          <el-table-column label="发货仓" min-width="180"><template #default="{ row }"><el-select v-model="row.warehouseId" :disabled="Number(row.outboundQty ?? 0) + Number(row.cancelledQty ?? 0) > 0">
            <el-option v-for="warehouse in allocationForm.warehouses" :key="warehouse.id" :value="warehouse.id" :label="warehouse.name" />
            <el-option v-if="row.warehouseId && !allocationForm.warehouses.some(warehouse => warehouse.id === row.warehouseId)" :value="row.warehouseId" :label="row.warehouseName || `仓库#${row.warehouseId}`" />
          </el-select></template></el-table-column>
          <el-table-column label="累计分仓量" width="170"><template #default="{ row }"><el-input-number v-model="row.allocQty" :min="Number(row.outboundQty ?? 0) + Number(row.cancelledQty ?? 0)" :precision="4" :controls="false" style="width: 100%" /></template></el-table-column>
          <el-table-column label="已出库" width="100" align="right"><template #default="{ row }"><QtyText :value="row.outboundQty" /></template></el-table-column>
          <el-table-column label="已取消" width="100" align="right"><template #default="{ row }"><QtyText :value="row.cancelledQty" /></template></el-table-column>
          <el-table-column label="操作" width="70"><template #default="{ row, $index }"><el-button link type="danger" :disabled="Number(row.outboundQty ?? 0) + Number(row.cancelledQty ?? 0) > 0" @click="line.allocs.splice($index, 1)">移除</el-button></template></el-table-column>
        </el-table>
        <el-button class="mt" @click="line.allocs.push({ warehouseId: undefined, allocQty: 0 })">添加分仓</el-button>
      </div>
      <template #footer><el-button @click="allocationForm.visible = false">取消</el-button><el-button type="primary" :loading="allocationForm.saving" @click="saveAllocations">保存分仓并重新审批</el-button></template>
    </el-dialog>

    <el-dialog v-model="ob.visible" title="确认出库" width="min(640px, 96vw)" :close-on-click-modal="!ob.saving" :show-close="!ob.saving" :close-on-press-escape="!ob.saving">
      <el-form label-width="88px">
        <el-form-item label="出库仓">
          <el-select v-model="ob.warehouseId" :disabled="ob.saving" @change="runCheck"><el-option v-for="w in warehouses" :key="w.value" :label="w.label" :value="w.value" /></el-select>
        </el-form-item>
      </el-form>
      <el-table :data="(order?.lines ?? []).flatMap((l: Row) => l.allocs.filter((a: Row) => a.warehouseId === ob.warehouseId && a.openQty > 0).map((a: Row) => ({ ...a, productCode: l.productCode, productName: l.productName })))" row-key="id" border stripe size="small" class="detail-table">
        <el-table-column label="商品" min-width="160"><template #default="{ row }"><ProductCell :code="row.productCode" :name="row.productName" /></template></el-table-column>
        <el-table-column label="未出库（基础）" width="135" align="right"><template #default="{ row }"><QtyText :value="row.openQty" /></template></el-table-column>
        <el-table-column label="本次（基础）" width="160" align="right"><template #default="{ row }"><el-input-number v-model="ob.qty[row.id]" :disabled="ob.saving" :min="0" :max="row.openQty" :precision="4" controls-position="right" style="width: 100%" @change="runCheck" /></template></el-table-column>
      </el-table>
      <p v-if="checkLoading" class="muted" role="status">正在检查所选出库仓…</p>
      <div v-else-if="checkError" class="error-panel mt" role="alert"><el-alert :title="checkError" type="error" :closable="false" /><el-button @click="runCheck">重新检查</el-button></div>
      <p v-else-if="checkedWarehouseId === undefined" class="muted">尚未完成出库检查。<el-button link type="primary" :disabled="!warehouses.length" @click="runCheck">开始检查</el-button></p>
      <OutboundPaymentCheck v-if="paymentCheck" :check="paymentCheck" @action="paymentAction" @retry="runCheck" />
      <el-button v-if="checks.some(c => !c.ok && c.code === 'SAL_PAYMENT_EVIDENCE_REQUIRED') && canUploadSalesAttachment('BANK_INFO')" link type="primary" @click="paymentAction('payment-proof')">去补收款凭证</el-button>
      <el-alert v-for="c in checks.filter((x) => !x.ok && x.item !== '现款到账')" :key="c.item" class="mt" type="error" :title="`${c.item}：${c.message}`" show-icon :closable="false" />
      <el-button v-if="checks.some(c => !c.ok && c.code === 'SAL_ATTACHMENT_MISSING') && canUploadSalesAttachment('CUSTOMER_PRICE')" link type="primary" @click="paymentAction('sales-doc')">去上传销售单据</el-button>
      <template #footer>
        <el-button :disabled="ob.saving" @click="ob.visible = false">取消</el-button>
        <el-button type="primary" :loading="ob.saving" :disabled="!canConfirmOut" @click="confirmOut">确认出库</el-button>
      </template>
    </el-dialog>
  </div>
</template>

<style scoped>
.sales-order-detail { min-width: 0; }
.detail-navigation { display: flex; align-items: center; flex-wrap: wrap; gap: 8px; margin-bottom: 12px; }
.detail-heading { align-items: flex-start; flex-wrap: wrap; }
.order-identity { min-width: 0; flex: 1 1 260px; }
.order-identity h2 { line-height: 1.6; overflow-wrap: anywhere; }
.customer-name { margin: 4px 0 0; color: var(--el-text-color-regular); font-size: 14px; line-height: 1.6; overflow-wrap: anywhere; }
.detail-actions { margin-bottom: 0; justify-content: flex-end; }
.detail-actions :deep(.el-button + .el-button) { margin-left: 0; }
.detail-actions :deep(.el-button > span) { gap: 8px; }
.order-statuses { display: flex; flex-wrap: wrap; gap: 12px 16px; padding-bottom: 16px; border-bottom: 1px solid var(--el-border-color-lighter); }
.order-statuses > div { display: flex; align-items: center; gap: 8px; }
.order-statuses > div > span:first-child { color: var(--el-text-color-secondary); font-size: 13px; }
.summary-values { display: grid; grid-template-columns: repeat(4, minmax(0, 1fr)); gap: 16px; margin: 16px 0 0; }
.summary-values dt { font-size: 13px; color: var(--el-text-color-secondary); margin-bottom: 6px; }
.summary-values dd { margin: 0; font-size: 14px; line-height: 1.6; overflow-wrap: anywhere; }
.summary-key dd { font-size: 18px; font-weight: 600; }
.summary-remark { grid-column: 1 / -1; }
.summary-remark dd { white-space: pre-wrap; }
.scope-note { margin: 12px 0 0; }
.section-heading { display: flex; align-items: baseline; flex-wrap: wrap; gap: 8px 12px; margin-bottom: 12px; }
.section-heading h3 { margin: 0; font-size: 16px; font-weight: 600; }
.products-section, .records-section { min-width: 0; }
.quantity-note { margin: 0 0 12px; line-height: 1.6; }
.detail-table { width: 100%; }
.allocation-detail { padding: 12px 16px; }
.allocation-detail h4 { display: flex; align-items: baseline; flex-wrap: wrap; gap: 8px; margin: 0 0 12px; font-size: 14px; }
.allocation-detail h4 .muted { font-weight: 400; }
.check-toolbar { align-items: center; }
.check-toolbar label { color: var(--el-text-color-regular); font-size: 14px; }
.check-toolbar .el-select { width: 240px; max-width: 100%; }
.error-panel { display: flex; align-items: flex-start; flex-direction: column; gap: 12px; }
.timeline-heading { display: flex; align-items: center; justify-content: space-between; flex-wrap: wrap; gap: 8px 16px; margin-bottom: 24px; }
.timeline-heading h4 { margin: 0 0 4px; font-size: 14px; font-weight: 600; }
.timeline-heading :deep(.el-icon) { margin-right: 4px; }
.order-timeline { padding: 0; margin: 0; }
.order-timeline :deep(.el-timeline-item) { padding-bottom: 24px; }
.order-timeline :deep(.el-timeline-item__wrapper) { display: grid; grid-template-columns: 132px minmax(0, 1fr); column-gap: 42px; padding-left: 0; top: 0; }
.order-timeline :deep(.el-timeline-item__content) { display: contents; }
.order-timeline :deep(.el-timeline-item__node) { left: 148px; top: 5px; width: 10px; height: 10px; }
.order-timeline :deep(.el-timeline-item__tail) { left: 152px; top: 5px; border-left-width: 1px; }
.order-timeline :deep(.el-timeline-item:last-child) { padding-bottom: 0; }
.timeline-time { text-align: right; font-family: ui-monospace, SFMono-Regular, Menlo, monospace; font-size: 12px; line-height: 1.7; color: var(--el-text-color-secondary); overflow-wrap: anywhere; }
.timeline-event { min-width: 0; font-size: 13px; line-height: 1.7; overflow-wrap: anywhere; }
.timeline-event p { margin: 4px 0 0; color: var(--el-text-color-regular); }
@media (max-width: 520px) {
  .order-timeline :deep(.el-timeline-item__wrapper) { display: block; margin-left: 24px; }
  .order-timeline :deep(.el-timeline-item__node) { left: 0; }
  .order-timeline :deep(.el-timeline-item__tail) { left: 4px; }
  .timeline-time { margin-bottom: 5px; text-align: left; }
}
.mt { margin-top: 12px; }
@media (max-width: 1024px) {
  .summary-values { grid-template-columns: repeat(2, minmax(0, 1fr)); }
  .detail-actions { justify-content: flex-start; }
}
@media (max-width: 768px) {
  .detail-actions { width: 100%; }
  .order-identity { flex-basis: 100%; }
  .order-statuses { gap: 8px 16px; }
  .allocation-detail { padding: 12px; }
}
@media (max-width: 480px) {
  .summary-values { grid-template-columns: minmax(0, 1fr); }
  .check-toolbar .el-select { width: 100%; }
}
</style>
