<script setup lang="ts">
import { feedbackMessage } from '@/api/error-feedback'
import { computed, onMounted, reactive, ref, watch } from 'vue'
import { useRoute, useRouter } from 'vue-router'
import { ElMessage } from 'element-plus'
import { http, createCommandIntent } from '@/api/http'
import { useUserStore } from '@/stores/user'
import { useCountryStore } from '@/stores/country'
import StatusTag from '@/components/StatusTag.vue'
import MoneyText from '@/components/MoneyText.vue'
import QtyText from '@/components/QtyText.vue'
import DateTimeText from '@/components/DateTimeText.vue'
import DocAttachment from '@/components/DocAttachment.vue'
import AuditDrawer from '@/components/AuditDrawer.vue'
import ProductCell from '@/components/biz/ProductCell.vue'
import FieldInput from '@/components/crud/FieldInput.vue'
import { confirmAction } from '@/utils/action'
import { formatDate, countryDateTimeInput, countryDateTimeToIso } from '@/utils/format'
import { nowMs } from '@/utils/datetime'
import { BUCKETS, HOLD_REASON_SOURCE, MANUAL_NODES, MX_WAREHOUSE_SOURCE, TRANSPORT_MODES, HOLD_OWNER_SOURCE, optionText } from '@/modules/shared/bizOptions'
import ShipmentForm from './ShipmentForm.vue'
import FeeForm from './FeeForm.vue'
import './shipment-detail.scss'

const supplyCommandIntent = createCommandIntent()


type Row = Record<string, any> // eslint-disable-line @typescript-eslint/no-explicit-any

const RANK: Record<string, number> = {
  DRAFT: 0, PENDING_DISPATCH: 1, IN_TRANSIT: 2, ARRIVED_PORT: 3, PENDING_CLEARANCE: 4, RELEASED: 5,
  PENDING_DELIVERY: 6, ON_HOLD: 6, PARTIAL_RECEIVED: 7, COMPLETED: 8, VOIDED: -1,
}

const route = useRoute()
const router = useRouter()
const user = useUserStore()
const country = useCountryStore()
const nowCountryTime = () => countryDateTimeInput(new Date(nowMs()).toISOString(), country.timezone) ?? ''
const sh = ref<Row>({})
const related = ref<Row>({})
const loading = ref(false)
const loadError = ref('')
const tab = ref('deliveries')
const lineQuery = ref('')
const quantityExpanded = ref(true)
const linePage = ref(1)
const linePageSize = ref(10)
const expandedNodeIds = ref<number[]>([])
const form = ref<InstanceType<typeof ShipmentForm>>()
const feeForm = ref<InstanceType<typeof FeeForm>>()

const id = computed(() => Number(route.params.id))
const lines = computed<Row[]>(() => sh.value.lines ?? [])
const auditVisible = ref(false)
const auditContext = computed(() => ({
  title: '运输批次',
  identifier: String(sh.value.docNo ?? `#${id.value}`),
  status: sh.value.status,
}))
function openAudit() {
  auditVisible.value = true
}
const filteredLines = computed(() => {
  const query = lineQuery.value.trim().toLowerCase()
  return query ? lines.value.filter(line => [line.productCode, line.productName, line.poNo, line.sourceNo]
    .some(value => typeof value === 'string' && value.toLowerCase().includes(query))) : lines.value
})
const pagedLines = computed(() => filteredLines.value.slice((linePage.value - 1) * linePageSize.value, linePage.value * linePageSize.value))
const rank = computed(() => RANK[sh.value.status] ?? 0)
const identityOk = computed(() => lines.value.every((l) => l.identityOk))
const pendingTotal = computed(() => sh.value.totals?.pendingDeliveryQty ?? 0)
function summary({ columns }: { columns: { property: string }[] }) {
  return columns.map((c, i) => (i === 0 ? '合计' : c.property === 'boxes' && filteredLines.value.some(line => line.boxes == null) ? '未维护' : c.property ? String(filteredLines.value.reduce((s, l) => s + (Number(l[c.property]) || 0), 0)) : ''))
}
const NODE_QUANTITY_SOURCES: Record<string, { recordsKey: string; timeField: string; label: string; statuses?: string[] }> = {
  DISPATCHED: { recordsKey: 'deliveries', timeField: 'dispatchedAt', label: '派送单', statuses: ['DISPATCHED', 'RECEIVED'] },
  HOLD: { recordsKey: 'holds', timeField: 'createdAt', label: '暂缓单' },
  TRANSSHIPPED: { recordsKey: 'transships', timeField: 'transshipAt', label: '换柜单', statuses: ['CONFIRMED'] },
  RECEIVED: { recordsKey: 'receipts', timeField: 'confirmedAt', label: '实收单', statuses: ['CONFIRMED'] },
}
const NODE_QUANTITY_FIELDS: Record<string, { label: string; key: string }[]> = {
  DISPATCHED: [{ label: '派送', key: 'dispatchQty' }],
  HOLD: [{ label: '暂缓', key: 'holdQty' }],
  TRANSSHIPPED: [{ label: '转移', key: 'movedQty' }, { label: '差异', key: 'diffQty' }],
  RECEIVED: [
    { label: '派送', key: 'dispatchQty' }, { label: '合格', key: 'goodQty' }, { label: '破损', key: 'damagedQty' },
    { label: '待检', key: 'pendingInspectQty' }, { label: '短缺', key: 'shortQty' },
  ],
}
function sameInstant(left: unknown, right: unknown) {
  if (typeof left !== 'string' || typeof right !== 'string') return false
  const leftTime = Date.parse(left)
  return Number.isFinite(leftTime) && leftTime === Date.parse(right)
}
function nodeQuantityInfo(event: Row) {
  const source = NODE_QUANTITY_SOURCES[event.nodeType]
  if (!source) {
    const label = event.nodeType === 'RESUMED' ? '恢复数量仅有累计记录，无法对应到本次节点' : '节点本身未记录数量'
    return { state: 'unrecorded', label, records: [] as Row[] }
  }

  const records = ((related.value[source.recordsKey] ?? []) as Row[]).filter((record) =>
    (!source.statuses || source.statuses.includes(record.status)) && Array.isArray(record.lines) && record.lines.length > 0)
  const sameTypeNodes = ((sh.value.nodes ?? []) as Row[]).filter((item) => item.nodeType === event.nodeType)
  const matchingRecords = records.filter((record) => sameInstant(event.actualAt, record[source.timeField]))
  const matchingNodes = sameTypeNodes.filter((item) => sameInstant(item.actualAt, event.actualAt))

  if (matchingRecords.length === 1 && matchingNodes.length === 1) {
    return { state: 'linked', label: source.label, records: matchingRecords }
  }
  if (records.length === 1 && sameTypeNodes.length === 1) {
    return { state: 'linked', label: source.label, records }
  }
  if (!records.length) return { state: 'unrecorded', label: `未找到关联${source.label}数量明细`, records: [] as Row[] }
  return { state: 'ambiguous', label: '未能唯一关联数量明细', records: [] as Row[] }
}
function nodeQuantityValues(nodeType: string, line: Row) {
  return (NODE_QUANTITY_FIELDS[nodeType] ?? [])
    .filter((field) => line[field.key] !== undefined && line[field.key] !== null)
    .map((field) => ({ label: field.label, value: line[field.key] }))
}
const nodes = computed<Row[]>(() => [...(sh.value.nodes ?? [])].reverse().map((event) => ({
  ...event,
  quantityInfo: nodeQuantityInfo(event),
})))
const allNodesExpanded = computed(() => nodes.value.length > 0 && nodes.value.every(node => expandedNodeIds.value.includes(node.id)))
function toggleAllNodes() {
  expandedNodeIds.value = allNodesExpanded.value ? [] : nodes.value.map(node => node.id)
}
function setNodeExpanded(nodeId: number, event: Event) {
  const open = (event.target as HTMLDetailsElement).open
  if (open && !expandedNodeIds.value.includes(nodeId)) expandedNodeIds.value.push(nodeId)
  else if (!open && expandedNodeIds.value.includes(nodeId)) expandedNodeIds.value = expandedNodeIds.value.filter(id => id !== nodeId)
}

let loadRequest = 0
async function load() {
  const request = ++loadRequest
  loading.value = true
  loadError.value = ''
  try {
    const [s, r] = await Promise.all([http.get<Row>(`/lgs/shipments/${id.value}`), http.get<Row>(`/lgs/shipments/${id.value}/related`)])
    if (request !== loadRequest) return
    sh.value = s
    related.value = r
  } catch (error) {
    if (request === loadRequest) loadError.value = feedbackMessage(error, "运输批次读取失败，请重试")
  } finally {
    if (request === loadRequest) loading.value = false
  }
}

async function run(fn: () => Promise<unknown>, success: string, dialog?: { visible: boolean; saving: boolean }) {
  if (dialog) dialog.saving = true
  try {
    await fn()
    ElMessage.success(success)
    if (dialog) dialog.visible = false
    load()
  } finally {
    if (dialog) dialog.saving = false
  }
}

async function submit() {
  await confirmAction('提交后等待实际发运，系统会生成“待实际发运”待办。', () => http.postIdem(`/lgs/shipments/${id.value}/submit`, undefined, supplyCommandIntent), { success: '已提交' })
  load()
}
async function voidShipment() {
  await confirmAction('作废这个运输批次？占用的出口计划数量会释放。', () => http.postIdem(`/lgs/shipments/${id.value}/void`, undefined, supplyCommandIntent), { success: '已作废', type: 'warning' })
  load()
}

// ---------- 实际发运 ----------
const dispatch = reactive({ visible: false, saving: false, actualEtd: nowCountryTime(), location: '', remark: '' })
function openDispatch() {
  Object.assign(dispatch, { visible: true, actualEtd: nowCountryTime(), location: sh.value.originLocation, remark: '' })
}
const submitDispatch = () => run(() => http.postIdem(`/lgs/shipments/${id.value}/dispatch`, { actualEtd: countryDateTimeToIso(dispatch.actualEtd, country.timezone), location: dispatch.location, remark: dispatch.remark }, supplyCommandIntent), '已发运，形成国际在途', dispatch)

// ---------- 节点 ----------
const node = reactive({ visible: false, saving: false, nodeType: 'ARRIVED_PORT', actualAt: nowCountryTime(), location: '', remark: '' })
function openNode() {
  const next = !sh.value.actualEta ? 'ARRIVED_PORT' : sh.value.status === 'ARRIVED_PORT' ? 'CUSTOMS_DECLARED' : rank.value < RANK.RELEASED ? 'CUSTOMS_RELEASED' : 'EXCEPTION'
  Object.assign(node, { visible: true, nodeType: next, actualAt: nowCountryTime(), location: '', remark: '' })
}
const submitNode = () => run(() => http.postIdem(`/lgs/shipments/${id.value}/nodes`, { nodeType: node.nodeType, actualAt: countryDateTimeToIso(node.actualAt, country.timezone), location: node.location, remark: node.remark }, supplyCommandIntent), '节点已记录', node)

const correct = reactive({ visible: false, saving: false, event: {} as Row, actualAt: '', location: '', remark: '' })
function openCorrect(e: Row) {
  Object.assign(correct, { visible: true, event: e, actualAt: countryDateTimeInput(e.actualAt, country.timezone) ?? '', location: e.location, remark: '' })
}
function submitCorrect() {
  if (!correct.remark.trim()) return ElMessage.warning('请填写更正原因')
  run(() => http.postIdem(`/lgs/shipments/${id.value}/nodes/${correct.event.id}/correct`, { actualAt: countryDateTimeToIso(correct.actualAt, country.timezone), location: correct.location, remark: correct.remark }, supplyCommandIntent), '已更正，原记录保留', correct)
}

// ---------- 换柜 ----------
const ts = reactive({ visible: false, saving: false, toContainerNo: '', toSealNo: '', location: '', transshipAt: nowCountryTime(), remark: '', moved: {} as Record<number, number> })
const inContainer = (l: Row) => l.intlQty + l.pendingDeliveryQty + l.onHoldQty
function openTransship() {
  Object.assign(ts, { visible: true, toContainerNo: '', toSealNo: '', location: '', transshipAt: nowCountryTime(), remark: '', moved: Object.fromEntries(lines.value.map((l) => [l.id, inContainer(l)])) })
}
function submitTransship() {
  if (!ts.toContainerNo.trim()) return ElMessage.warning('请填写新柜号')
  run(() => http.postIdem('/lgs/transships', {
    shipmentId: id.value, toContainerNo: ts.toContainerNo.trim(), toSealNo: ts.toSealNo, location: ts.location, transshipAt: countryDateTimeToIso(ts.transshipAt, country.timezone), remark: ts.remark,
    lines: lines.value.map((l) => ({ shipmentLineId: l.id, movedQty: ts.moved[l.id] ?? 0 })),
  }, supplyCommandIntent), '换柜完成，原柜号已保留在历史中', ts)
}

// ---------- 暂缓 ----------
const hold = reactive({ visible: false, saving: false, reasonCode: '', parkLocation: '', ownerId: undefined as number | undefined, reviewDate: '', remark: '', qty: {} as Record<number, number> })
function openHold() {
  Object.assign(hold, { visible: true, reasonCode: '', parkLocation: '', ownerId: user.user?.id, reviewDate: '', remark: '', qty: Object.fromEntries(lines.value.map((l) => [l.id, 0])) })
}
function submitHold() {
  run(() => http.postIdem('/lgs/holds', {
    shipmentId: id.value, reasonCode: hold.reasonCode, parkLocation: hold.parkLocation, ownerId: hold.ownerId, reviewDate: hold.reviewDate, remark: hold.remark,
    lines: Object.entries(hold.qty).map(([k, v]) => ({ shipmentLineId: Number(k), holdQty: v })),
  }, supplyCommandIntent), '已暂缓，数量转入暂缓桶', hold)
}

// ---------- 派送 ----------
const dl = reactive({ visible: false, saving: false, destWarehouseId: undefined as number | undefined, vehicle: '', driver: '', plannedAt: nowCountryTime(), dispatch: true, remark: '', qty: {} as Record<number, number> })
function openDelivery() {
  Object.assign(dl, { visible: true, destWarehouseId: sh.value.destWarehouseId, vehicle: '', driver: '', plannedAt: nowCountryTime(), dispatch: true, remark: '', qty: Object.fromEntries(lines.value.map((l) => [l.id, l.pendingDeliveryQty])) })
}
function submitDelivery() {
  run(() => http.postIdem('/lgs/deliveries', {
    shipmentId: id.value, destWarehouseId: dl.destWarehouseId, vehicle: dl.vehicle, driver: dl.driver, plannedAt: countryDateTimeToIso(dl.plannedAt, country.timezone), dispatch: dl.dispatch, remark: dl.remark,
    lines: Object.entries(dl.qty).map(([k, v]) => ({ shipmentLineId: Number(k), dispatchQty: v })),
  }, supplyCommandIntent), dl.dispatch ? '已派送出发，目的仓收到待实收待办' : '派送单已保存为草稿', dl)
}

const canNode = computed(() => user.hasPerm('lgs:node:record') && rank.value >= RANK.IN_TRANSIT && sh.value.status !== 'COMPLETED')
const canTransship = computed(() => user.hasPerm('lgs:transship:create') && sh.value.transportMode === 'SEA' && rank.value >= RANK.IN_TRANSIT && sh.value.status !== 'COMPLETED')
const canHold = computed(() => pendingTotal.value > 0 && user.hasPerm('lgs:hold:create'))
const canVoid = computed(() => ['DRAFT', 'PENDING_DISPATCH'].includes(sh.value.status) && user.hasPerm('lgs:shipment:edit'))

watch([lineQuery, linePageSize], () => { linePage.value = 1 })
watch(() => filteredLines.value.length, total => {
  linePage.value = Math.min(linePage.value, Math.max(1, Math.ceil(total / linePageSize.value)))
})
watch(id, () => {
  lineQuery.value = ''
  linePage.value = 1
  tab.value = 'deliveries'
  auditVisible.value = false
  expandedNodeIds.value = []
  sh.value = {}
  related.value = {}
  load()
})
onMounted(load)
</script>

<template>
  <div v-loading="loading" class="page shipment-detail">
    <div v-if="loadError" class="request-state" role="status"><p class="muted">尚未加载成功</p><el-button size="small" @click="load">重新加载</el-button></div>
    <template v-else>
    <section class="shipment-section shipment-overview" aria-label="运输批次基础资料">
      <div class="shipment-heading">
        <div class="shipment-title">
          <el-tooltip content="返回运输批次" placement="bottom"><el-button link aria-label="返回运输批次" @click="router.push('/logistics/shipments')"><el-icon><ArrowLeft /></el-icon></el-button></el-tooltip>
          <h2>运输批次 <span class="mono">{{ sh.docNo }}</span></h2>
          <StatusTag :status="sh.status" />
          <el-tag v-if="sh.delayed" type="danger" effect="dark" size="small">{{ sh.delayStage }}延误 {{ sh.delayHours }} 小时</el-tag>
        </div>
        <div class="shipment-actions">
          <el-button v-if="['DRAFT', 'PENDING_DISPATCH'].includes(sh.status) && user.hasPerm('lgs:shipment:edit')" size="small" @click="form?.open(sh)">编辑</el-button>
          <el-button v-if="sh.status === 'DRAFT'" size="small" type="primary" @click="submit">提交</el-button>
          <el-button v-if="sh.status === 'PENDING_DISPATCH' && user.hasPerm('lgs:shipment:dispatch')" size="small" type="primary" @click="openDispatch">实际发运</el-button>
          <el-button v-if="canNode" size="small" @click="openNode">记录节点</el-button>
          <el-button v-if="rank >= 1 && user.hasPerm('lgs:fee:create')" size="small" @click="feeForm?.open({ refType: 'SHIPMENT', refId: id })">登记费用</el-button>
          <el-button v-if="pendingTotal > 0 && rank >= RANK.RELEASED && user.hasPerm('lgs:delivery:create')" size="small" type="primary" @click="openDelivery">派送到仓</el-button>
          <el-dropdown v-if="canTransship || canHold || canVoid" trigger="click">
            <el-button size="small" aria-label="更多操作" title="更多操作"><el-icon><MoreFilled /></el-icon></el-button>
            <template #dropdown><el-dropdown-menu>
              <el-dropdown-item v-if="canTransship" @click="openTransship">换柜</el-dropdown-item>
              <el-dropdown-item v-if="canHold" @click="openHold">暂缓派送</el-dropdown-item>
              <el-dropdown-item v-if="canVoid" @click="voidShipment"><span class="shipment-danger">作废</span></el-dropdown-item>
            </el-dropdown-menu></template>
          </el-dropdown>
        </div>
      </div>
      <dl class="shipment-facts">
        <div class="shipment-fact"><dt>物流商</dt><dd>{{ sh.carrierName }}</dd></div>
        <div class="shipment-fact"><dt>运输方式</dt><dd>{{ optionText(TRANSPORT_MODES, sh.transportMode) }}</dd></div>
        <div class="shipment-fact"><dt>目的仓</dt><dd>{{ sh.destWarehouseName }}</dd></div>
        <div class="shipment-fact"><dt>起运地</dt><dd>{{ sh.originLocation || '-' }}</dd></div>
        <template v-if="sh.transportMode === 'SEA'">
          <div class="shipment-fact"><dt>船名航次</dt><dd>{{ sh.vessel }} / {{ sh.voyage }}</dd></div>
          <div class="shipment-fact"><dt>提单号</dt><dd class="mono">{{ sh.blNo }}</dd></div>
          <div class="shipment-fact"><dt>当前柜号</dt><dd class="mono">{{ sh.currentContainerNo }}</dd></div>
          <div class="shipment-fact"><dt>封号</dt><dd class="mono">{{ sh.currentSealNo || '-' }}</dd></div>
        </template>
        <template v-else>
          <div class="shipment-fact"><dt>航班号</dt><dd>{{ sh.flightNo }}</dd></div>
          <div class="shipment-fact shipment-fact--wide"><dt>运单号</dt><dd class="mono">{{ sh.awbNo }}</dd></div>
        </template>
        <div class="shipment-fact shipment-fact--date" data-field="departure"><dt>发运时间</dt><dd class="shipment-date-pair"><span><small>计划</small><DateTimeText :value="sh.plannedEtd" /></span><span><small>实际</small><DateTimeText v-if="sh.actualEtd || (sh.openingRef && sh.openingSourceDate)" :value="sh.actualEtd" :known-date="sh.openingRef ? sh.openingSourceDate : null" /><span v-else class="muted">未发运</span></span></dd></div>
        <div class="shipment-fact shipment-fact--date"><dt>到港时间</dt><dd class="shipment-date-pair"><span><small>计划</small><DateTimeText :value="sh.plannedEta" /></span><span><small>实际</small><DateTimeText v-if="sh.actualEta" :value="sh.actualEta" /><span v-else class="muted">未到港</span></span></dd></div>
        <div class="shipment-fact"><dt>装载信息</dt><dd>{{ sh.totalBoxes ?? '未维护' }} 箱 · {{ sh.grossWeight ?? '未维护' }} kg<span class="shipment-subline">{{ sh.volume ?? '未维护' }} m³</span></dd></div>
        <div class="shipment-fact shipment-fact--wide"><dt>采购单</dt><dd class="mono">{{ sh.poNos }}</dd></div>
        <div class="shipment-fact"><dt>创建信息</dt><dd>{{ sh.createdByName }}<span class="shipment-subline"><DateTimeText :value="sh.createdAt" /></span></dd></div>
      </dl>
      <p v-if="sh.remark" class="shipment-remark"><span>备注</span>{{ sh.remark }}</p>
    </section>

    <section class="shipment-section shipment-quantities" aria-labelledby="shipment-quantity-title">
      <div class="shipment-section-heading shipment-quantity-heading">

        <div class="shipment-heading-text"><h3 id="shipment-quantity-title">数量分桶</h3><span class="muted">{{ filteredLines.length }} / {{ lines.length }} 条明细</span><el-tag v-if="rank >= RANK.IN_TRANSIT" :type="identityOk ? 'success' : 'danger'" effect="plain" size="small">{{ identityOk ? '数量恒等校验通过' : '数量不平，请检查' }}</el-tag></div>
        <div class="shipment-quantity-controls">
          <el-input v-model="lineQuery" clearable size="small" placeholder="商品编码 / 名称 / 来源" aria-label="筛选商品" class="shipment-line-search"><template #prefix><el-icon><Search /></el-icon></template></el-input>
        </div>
        <button type="button" class="shipment-quantity-toggle" :aria-expanded="quantityExpanded" aria-controls="shipment-quantity-body" :aria-label="quantityExpanded ? '收起数量分桶' : '展开数量分桶'" :title="quantityExpanded ? '收起数量分桶' : '展开数量分桶'" @click="quantityExpanded = !quantityExpanded"><el-icon class="shipment-collapse-icon" aria-hidden="true"><ArrowRight /></el-icon></button>
      
      </div>
      <div v-show="quantityExpanded" id="shipment-quantity-body" class="shipment-quantity-body">
        <div class="table-scroll">
          <el-table :data="pagedLines" class="shipment-quantity-table" max-height="400" border stripe size="small" row-key="id" show-summary :summary-method="summary" :empty-text="lineQuery.trim() ? '没有匹配的商品' : '暂无商品明细'">
            <el-table-column label="商品 / 采购来源" min-width="250"><template #default="{ row }"><ProductCell :code="row.productCode" :name="row.productName" :extra="`${row.poNo} · ${row.sourceNo}`" /></template></el-table-column>
            <el-table-column prop="boxes" label="箱数" width="66" align="right" show-overflow-tooltip><template #default="{ row }">{{ row.boxes ?? '未维护' }}</template></el-table-column>
            <el-table-column prop="baseQty" label="计划" width="68" align="right" show-overflow-tooltip />
            <el-table-column prop="shippedQty" label="已发运" width="74" align="right" show-overflow-tooltip />
            <el-table-column v-for="b in BUCKETS" :key="b.prop" :prop="b.prop" :label="b.label" width="80" align="right" show-overflow-tooltip>
              <template #default="{ row }"><span :class="{ zero: !row[b.prop], warn: b.prop === 'discrepancyQty' && row[b.prop] > 0 }">{{ row[b.prop] }}</span></template>
            </el-table-column>
            <el-table-column label="恒等" width="52" align="center">
              <template #default="{ row }"><el-icon v-if="row.identityOk" color="var(--el-color-success)" role="img" aria-label="数量恒等校验通过"><CircleCheck /></el-icon><el-icon v-else color="var(--el-color-danger)" role="img" aria-label="数量不平"><Warning /></el-icon></template>
            </el-table-column>
          </el-table>
        </div>
        <div class="shipment-quantity-footer">
          <details class="shipment-rules"><summary>数量核对规则</summary><p>已发运 = 国际在途 + 当地待派送 + 暂缓 + 派送在途 + 已实收合格 + 已实收冻结 + 差异。到港把国际在途转为当地待派送；放行（或换柜）后才能派送；实收后进入目的仓库存。合计按当前筛选结果的全部明细计算。</p></details>
          <el-pagination v-model:current-page="linePage" v-model:page-size="linePageSize" size="small" :page-sizes="[10, 20, 50]" :pager-count="5" layout="total, sizes, prev, pager, next" :total="filteredLines.length" />
        </div>
      </div>
    </section>

    <div class="shipment-lower">
      <section class="shipment-section shipment-nodes" aria-labelledby="shipment-nodes-title">
        <div class="shipment-section-heading"><div class="shipment-heading-text"><h3 id="shipment-nodes-title">节点时间线</h3><span class="muted">最新在前</span></div><el-button v-if="nodes.length" link type="primary" size="small" @click="toggleAllNodes">{{ allNodesExpanded ? '收起全部' : '展开全部' }}</el-button></div>
        <el-empty v-if="!nodes.length" description="暂无节点记录" :image-size="48" />
        <div v-else class="shipment-node-list">
          <details v-for="n in nodes" :key="n.id" class="shipment-node" :class="{ 'is-corrected': n.corrected, 'is-exception': n.nodeType === 'EXCEPTION' }" :open="expandedNodeIds.includes(n.id)" @toggle="setNodeExpanded(n.id, $event)">
            <summary><span class="shipment-node-name">{{ n.nodeLabel }}</span><DateTimeText :value="n.actualAt" /><el-tag v-if="n.correctsEventId" size="small" type="warning">更正</el-tag><el-tag v-if="n.corrected" size="small" type="info">已被更正</el-tag></summary>
            <div class="shipment-node-content">
                <div>{{ n.location || '-' }} · {{ n.operatorName || '-' }}</div>
                <div v-if="n.plannedAt" class="muted">计划 <DateTimeText :value="n.plannedAt" /></div>
                <div v-if="n.refNo" class="mono">{{ n.refNo }}</div>
                <div v-if="n.remark">{{ n.remark }}</div>
                <div v-if="n.quantityInfo.state === 'linked'" class="shipment-node-quantity">
                  <div class="shipment-node-quantity-source">关联数量 · {{ n.quantityInfo.label }}</div>
                  <div v-for="record in n.quantityInfo.records" :key="record.id" class="shipment-node-quantity-record">
                    <div class="shipment-node-quantity-doc">{{ record.docNo || `单据 #${record.id}` }}</div>
                    <div v-for="line in record.lines" :key="line.id" class="shipment-node-quantity-line">
                      <ProductCell :code="line.productCode" :name="line.productName" />
                      <div class="shipment-node-quantity-values"><span v-for="quantity in nodeQuantityValues(n.nodeType, line)" :key="quantity.label">{{ quantity.label }} <QtyText :value="quantity.value" /></span></div>
                    </div>
                  </div>
                </div>
                <div v-else class="shipment-node-quantity-empty">{{ n.quantityInfo.label }}</div>
                <el-button v-if="canNode && !n.corrected && ['DEPARTED', 'ARRIVED_PORT', 'CUSTOMS_DECLARED', 'CUSTOMS_RELEASED', 'EXCEPTION'].includes(n.nodeType)" link type="primary" size="small" class="ml" @click="openCorrect(n)">更正</el-button>
            </div>
          </details>
        </div>
        <div class="shipment-node-footer"><span>共 {{ nodes.length }} 条节点</span><el-button v-if="canNode" link type="primary" size="small" @click="openNode">记录节点</el-button></div>
      </section>

    <details open class="shipment-section shipment-records" aria-labelledby="shipment-records-title">
      <summary class="shipment-section-heading shipment-collapse-summary">
        <h3 id="shipment-records-title">关联记录</h3>
        <el-icon class="shipment-collapse-icon" aria-hidden="true"><ArrowRight /></el-icon>
      </summary>
      <div class="shipment-record-body">
      <el-tabs v-model="tab">
        <el-tab-pane :label="`派送（${related.deliveries?.length ?? 0}）`" name="deliveries">
          <el-table :data="related.deliveries ?? []" border size="small">
            <el-table-column prop="docNo" label="派送单" width="185" />
            <el-table-column prop="warehouseName" label="目的仓" width="130" />
            <el-table-column label="车辆 / 司机" min-width="150"><template #default="{ row }">{{ row.vehicle || '-' }} / {{ row.driver || '-' }}</template></el-table-column>
            <el-table-column label="出发时间" width="170"><template #default="{ row }"><DateTimeText :value="row.dispatchedAt" /></template></el-table-column>
            <el-table-column label="派送 / 已实收" width="110" align="right"><template #default="{ row }">{{ row.totalQty }} / {{ row.receivedQty }}</template></el-table-column>
            <el-table-column label="状态" width="100"><template #default="{ row }"><StatusTag :status="row.status" /></template></el-table-column>
            <el-table-column label="实收单" width="185">
              <template #default="{ row }">
                <el-link v-if="row.receiptId" type="primary" @click="router.push(`/logistics/receipts/${row.receiptId}`)">{{ row.receiptNo }}</el-link>
                <el-link v-else-if="row.status === 'DISPATCHED'" type="primary" @click="router.push({ path: '/logistics/receipts', query: { deliveryId: row.id } })">去实收</el-link>
              </template>
            </el-table-column>
          </el-table>
          <el-button link type="primary" class="mt" @click="router.push({ path: '/logistics/deliveries', query: { shipmentId: id } })">在派送单页查看</el-button>
        </el-tab-pane>
        <el-tab-pane :label="`暂缓（${related.holds?.length ?? 0}）`" name="holds">
          <el-table :data="related.holds ?? []" border size="small">
            <el-table-column prop="docNo" label="暂缓单" width="185" />
            <el-table-column prop="reasonLabel" label="原因" width="120" />
            <el-table-column prop="parkLocation" label="停放地点" min-width="140" />
            <el-table-column prop="ownerName" label="责任人" width="100" />
            <el-table-column label="复查日期" width="110"><template #default="{ row }"><span :class="{ warn: row.overdue }">{{ formatDate(row.reviewDate) }}</span></template></el-table-column>
            <el-table-column label="暂缓 / 已恢复" width="110" align="right"><template #default="{ row }">{{ row.holdQty }} / {{ row.releasedQty }}</template></el-table-column>
            <el-table-column label="状态" width="100"><template #default="{ row }"><StatusTag :status="row.status" domain="hold" /></template></el-table-column>
          </el-table>
          <el-button link type="primary" class="mt" @click="router.push({ path: '/logistics/holds', query: { shipmentId: id } })">去暂缓管理恢复派送</el-button>
        </el-tab-pane>
        <el-tab-pane :label="`换柜（${related.transships?.length ?? 0}）`" name="transships">
          <el-table :data="related.transships ?? []" border size="small">
            <el-table-column prop="docNo" label="换柜单" width="185" />
            <el-table-column label="原柜 → 新柜" min-width="220"><template #default="{ row }"><span class="mono">{{ row.fromContainerNo }} → {{ row.toContainerNo }}</span></template></el-table-column>
            <el-table-column prop="location" label="地点" width="120" />
            <el-table-column label="时间" width="170"><template #default="{ row }"><DateTimeText :value="row.transshipAt" /></template></el-table-column>
            <el-table-column label="在柜 / 转移 / 差异" min-width="200">
              <template #default="{ row }"><div v-for="l in row.lines" :key="l.id">{{ l.productCode }}：{{ l.inContainerQty }} / {{ l.movedQty }} / <span :class="{ warn: l.diffQty }">{{ l.diffQty }}</span></div></template>
            </el-table-column>
            <el-table-column prop="operatorName" label="操作人" width="100" />
          </el-table>
        </el-tab-pane>
        <el-tab-pane :label="`实收（${related.receipts?.length ?? 0}）`" name="receipts">
          <el-table :data="related.receipts ?? []" border size="small">
            <el-table-column label="实收单" width="185"><template #default="{ row }"><el-link type="primary" @click="router.push(`/logistics/receipts/${row.id}`)">{{ row.docNo }}</el-link></template></el-table-column>
            <el-table-column prop="warehouseName" label="仓库" width="130" />
            <el-table-column label="派送 / 合格 / 冻结 / 短缺" min-width="180"><template #default="{ row }"><span class="mono">{{ row.totalDispatch }} / {{ row.totalGood }} / {{ row.totalFrozen }} / {{ row.totalShort }}</span></template></el-table-column>
            <el-table-column label="确认" min-width="200"><template #default="{ row }">{{ row.receivedByName || '-' }} · <DateTimeText :value="row.confirmedAt" /></template></el-table-column>
            <el-table-column label="状态" width="100"><template #default="{ row }"><StatusTag :status="row.status" /></template></el-table-column>
          </el-table>
        </el-tab-pane>
        <el-tab-pane :label="`差异（${related.discrepancies?.length ?? 0}）`" name="discrepancies">
          <el-table :data="related.discrepancies ?? []" border size="small">
            <el-table-column prop="docNo" label="差异单" width="185" />
            <el-table-column prop="typeLabel" label="类型" width="100" />
            <el-table-column prop="productCode" label="商品" width="90" />
            <el-table-column prop="qty" label="数量" width="70" align="right" />
            <el-table-column prop="sourceNo" label="来源" width="185" />
            <el-table-column label="处理" min-width="160"><template #default="{ row }">{{ row.resolutionLabel || '-' }}</template></el-table-column>
            <el-table-column label="状态" width="100"><template #default="{ row }"><StatusTag :status="row.status" domain="discrepancy" /></template></el-table-column>
            <el-table-column width="70"><template #default="{ row }"><el-button link type="primary" @click="router.push({ path: '/logistics/discrepancies', query: { id: row.id } })">处理</el-button></template></el-table-column>
          </el-table>
        </el-tab-pane>
        <el-tab-pane :label="`费用（${related.fees?.length ?? 0}）`" name="fees">
          <el-table :data="related.fees ?? []" border size="small">
            <el-table-column prop="docNo" label="费用单" width="185" />
            <el-table-column label="关联" width="200"><template #default="{ row }">{{ row.refTypeLabel }} · <span class="mono">{{ row.refNo }}</span></template></el-table-column>
            <el-table-column prop="expenseItemName" label="费用项目" min-width="120" />
            <el-table-column label="金额" width="140" align="right"><template #default="{ row }"><MoneyText :value="row.amount" :currency="row.currency" /></template></el-table-column>
            <el-table-column label="暂估/实际" width="90"><template #default="{ row }">{{ row.estimateFlag === 'ESTIMATE' ? '暂估' : '实际' }}</template></el-table-column>
            <el-table-column label="状态" width="100"><template #default="{ row }"><StatusTag :status="row.status" /></template></el-table-column>
          </el-table>
          <el-button link type="primary" class="mt" @click="router.push({ path: '/logistics/fees', query: { shipmentId: id } })">在费用页管理</el-button>
        </el-tab-pane>
        <el-tab-pane v-if="sh.transportMode === 'SEA'" :label="`柜号历史（${sh.containers?.length ?? 0}）`" name="containers">
          <el-table :data="sh.containers ?? []" border size="small">
            <el-table-column label="柜号" min-width="130"><template #default="{ row }"><span class="mono">{{ row.containerNo }}</span><el-tag v-if="!row.activeTo" size="small" type="success" class="ml">当前</el-tag></template></el-table-column>
            <el-table-column prop="sealNo" label="封号" width="110" />
            <el-table-column label="启用 → 停用" min-width="260">
              <template #default="{ row }"><DateTimeText :value="sh.openingRef && row.id === sh.containers?.[0]?.id && row.bizDate === sh.cutoffDate ? null : row.activeFrom" :known-date="sh.openingRef && row.id === sh.containers?.[0]?.id && row.bizDate === sh.cutoffDate ? sh.openingSourceDate : null" /><template v-if="row.activeTo"> → <DateTimeText :value="row.activeTo" /></template></template>
            </el-table-column>
          </el-table>
          <p class="muted">按旧柜号搜索批次仍能找到这个批次。</p>
        </el-tab-pane>
        <el-tab-pane label="附件" name="files" lazy>
          <DocAttachment biz-type="SHIPMENT" :biz-id="id" category="LOGISTICS_DOC" />
        </el-tab-pane>
        <el-tab-pane label="操作日志" name="audit" lazy>
          <el-button type="primary" plain size="small" @click="openAudit"><el-icon><Clock /></el-icon>查看操作日志</el-button>
        </el-tab-pane>
      </el-tabs>
      </div>
      <AuditDrawer v-if="auditVisible" v-model="auditVisible" resource-type="shipment" :resource-id="id" :context="auditContext" />
    </details>
    </div>
    </template>

    <el-dialog v-model="dispatch.visible" title="实际发运" width="480px" class="shipment-dialog" append-to-body>
      <el-form label-width="90px">
        <el-form-item :label="`离港时间（${country.timezone}）`"><el-date-picker v-model="dispatch.actualEtd" type="datetime" value-format="YYYY-MM-DD HH:mm:ss.SSS" style="width: 100%" /></el-form-item>
        <el-form-item label="地点"><el-input v-model="dispatch.location" /></el-form-item>
        <el-form-item label="备注"><el-input v-model="dispatch.remark" /></el-form-item>
      </el-form>
      <p class="muted">发运后计划数量转为国际在途，并回写采购单“已发运”。重复点击不会重复回写。</p>
      <template #footer>
        <el-button @click="dispatch.visible = false">取消</el-button>
        <el-button type="primary" :loading="dispatch.saving" @click="submitDispatch">确认发运</el-button>
      </template>
    </el-dialog>

    <el-dialog v-model="node.visible" title="记录节点" width="520px" class="shipment-dialog" append-to-body>
      <el-form label-width="90px">
        <el-form-item label="节点">
          <el-radio-group v-model="node.nodeType">
            <el-radio-button v-for="o in MANUAL_NODES" :key="String(o.value)" :value="o.value">{{ o.label }}</el-radio-button>
          </el-radio-group>
        </el-form-item>
        <el-form-item :label="`实际时间（${country.timezone}）`"><el-date-picker v-model="node.actualAt" type="datetime" value-format="YYYY-MM-DD HH:mm:ss.SSS" style="width: 100%" /></el-form-item>
        <el-form-item label="地点"><el-input v-model="node.location" /></el-form-item>
        <el-form-item label="备注"><el-input v-model="node.remark" type="textarea" :rows="2" /></el-form-item>
      </el-form>
      <p class="muted">到港后国际在途转为当地待派送；放行后可以派送。发运、换柜、暂缓、派送、实收由对应操作自动记录。</p>
      <template #footer>
        <el-button @click="node.visible = false">取消</el-button>
        <el-button type="primary" :loading="node.saving" @click="submitNode">记录</el-button>
      </template>
    </el-dialog>

    <el-dialog v-model="correct.visible" :title="`更正节点：${correct.event.nodeLabel}`" width="480px" class="shipment-dialog" append-to-body>
      <el-form label-width="90px">
        <el-form-item label="原时间"><DateTimeText :value="correct.event.actualAt" /></el-form-item>
        <el-form-item :label="`正确时间（${country.timezone}）`"><el-date-picker v-model="correct.actualAt" type="datetime" value-format="YYYY-MM-DD HH:mm:ss.SSS" style="width: 100%" /></el-form-item>
        <el-form-item label="地点"><el-input v-model="correct.location" /></el-form-item>
        <el-form-item label="更正原因" required><el-input v-model="correct.remark" type="textarea" :rows="2" /></el-form-item>
      </el-form>
      <template #footer>
        <el-button @click="correct.visible = false">取消</el-button>
        <el-button type="primary" :loading="correct.saving" @click="submitCorrect">提交更正</el-button>
      </template>
    </el-dialog>

    <el-dialog v-model="ts.visible" title="换柜" width="720px" class="shipment-dialog" append-to-body>
      <el-form label-width="90px">
        <el-row :gutter="12">
          <el-col :span="12"><el-form-item label="原柜号"><span class="mono">{{ sh.currentContainerNo }}</span></el-form-item></el-col>
          <el-col :span="12"><el-form-item :label="`换柜时间（${country.timezone}）`"><el-date-picker v-model="ts.transshipAt" type="datetime" value-format="YYYY-MM-DD HH:mm:ss.SSS" style="width: 100%" /></el-form-item></el-col>
          <el-col :span="12"><el-form-item label="新柜号" required><el-input v-model="ts.toContainerNo" placeholder="MSKU1234567" /></el-form-item></el-col>
          <el-col :span="12"><el-form-item label="新封号"><el-input v-model="ts.toSealNo" /></el-form-item></el-col>
          <el-col :span="12"><el-form-item label="地点"><el-input v-model="ts.location" /></el-form-item></el-col>
          <el-col :span="12"><el-form-item label="备注"><el-input v-model="ts.remark" /></el-form-item></el-col>
        </el-row>
      </el-form>
      <el-table :data="lines" max-height="320" border size="small">
        <el-table-column label="商品" min-width="160"><template #default="{ row }"><ProductCell :code="row.productCode" :name="row.productName" /></template></el-table-column>
        <el-table-column label="原柜在柜" width="90" align="right"><template #default="{ row }">{{ inContainer(row) }}</template></el-table-column>
        <el-table-column label="转入新柜" width="130">
          <template #default="{ row }"><el-input-number v-model="ts.moved[row.id]" :min="0" :max="inContainer(row)" :controls="false" style="width: 100%" /></template>
        </el-table-column>
        <el-table-column label="差异" width="70" align="right"><template #default="{ row }"><span :class="{ warn: inContainer(row) - (ts.moved[row.id] ?? 0) > 0 }">{{ inContainer(row) - (ts.moved[row.id] ?? 0) }}</span></template></el-table-column>
      </el-table>
      <p class="muted">转移数量少于在柜数量时，差额转入差异桶并自动生成“换柜差异”，需要物流负责人处理。</p>
      <template #footer>
        <el-button @click="ts.visible = false">取消</el-button>
        <el-button type="primary" :loading="ts.saving" @click="submitTransship">确认换柜</el-button>
      </template>
    </el-dialog>

    <el-dialog v-model="hold.visible" title="暂缓派送" width="720px" class="shipment-dialog" append-to-body>
      <el-form label-width="90px">
        <el-row :gutter="12">
          <el-col :span="12">
            <el-form-item label="原因" required>
              <FieldInput v-model="hold.reasonCode" :field="{ prop: 'reasonCode', label: '原因', type: 'select', options: HOLD_REASON_SOURCE }" />
            </el-form-item>
          </el-col>
          <el-col :span="12"><el-form-item label="停放地点" required><el-input v-model="hold.parkLocation" placeholder="例如：曼萨尼约港外堆场 B 区" /></el-form-item></el-col>
          <el-col :span="12">
            <el-form-item label="责任人" required>
              <FieldInput v-model="hold.ownerId" :field="{ prop: 'ownerId', label: '责任人', type: 'select', options: HOLD_OWNER_SOURCE }" />
            </el-form-item>
          </el-col>
          <el-col :span="12"><el-form-item label="复查日期" required><el-date-picker v-model="hold.reviewDate" type="date" value-format="YYYY-MM-DD" style="width: 100%" /></el-form-item></el-col>
          <el-col :span="24"><el-form-item label="备注"><el-input v-model="hold.remark" /></el-form-item></el-col>
        </el-row>
      </el-form>
      <el-table :data="lines" max-height="320" border size="small">
        <el-table-column label="商品" min-width="160"><template #default="{ row }"><ProductCell :code="row.productCode" :name="row.productName" /></template></el-table-column>
        <el-table-column prop="pendingDeliveryQty" label="当地待派送" width="100" align="right" />
        <el-table-column label="暂缓数量" width="130">
          <template #default="{ row }"><el-input-number v-model="hold.qty[row.id]" :min="0" :max="row.pendingDeliveryQty" :controls="false" style="width: 100%" /></template>
        </el-table-column>
      </el-table>
      <p class="muted">暂缓的货不能派送；到复查日期会提醒责任人。停放产生的仓储费可以在费用中关联这张暂缓单。</p>
      <template #footer>
        <el-button @click="hold.visible = false">取消</el-button>
        <el-button type="primary" :loading="hold.saving" @click="submitHold">确认暂缓</el-button>
      </template>
    </el-dialog>

    <el-dialog v-model="dl.visible" title="派送到仓" width="720px" class="shipment-dialog" append-to-body>
      <el-form label-width="90px">
        <el-row :gutter="12">
          <el-col :span="12">
            <el-form-item label="目的仓" required>
              <FieldInput v-model="dl.destWarehouseId" :field="{ prop: 'destWarehouseId', label: '目的仓', type: 'select', options: MX_WAREHOUSE_SOURCE }" />
            </el-form-item>
          </el-col>
          <el-col :span="12"><el-form-item :label="`计划时间（${country.timezone}）`"><el-date-picker v-model="dl.plannedAt" type="datetime" value-format="YYYY-MM-DD HH:mm:ss.SSS" style="width: 100%" /></el-form-item></el-col>
          <el-col :span="12"><el-form-item label="车辆"><el-input v-model="dl.vehicle" placeholder="车牌号" /></el-form-item></el-col>
          <el-col :span="12"><el-form-item label="司机"><el-input v-model="dl.driver" /></el-form-item></el-col>
          <el-col :span="24"><el-form-item label="备注"><el-input v-model="dl.remark" /></el-form-item></el-col>
        </el-row>
      </el-form>
      <el-table :data="lines" max-height="320" border size="small">
        <el-table-column label="商品" min-width="160"><template #default="{ row }"><ProductCell :code="row.productCode" :name="row.productName" /></template></el-table-column>
        <el-table-column prop="pendingDeliveryQty" label="当地待派送" width="100" align="right" />
        <el-table-column label="本次派送" width="130">
          <template #default="{ row }"><el-input-number v-model="dl.qty[row.id]" :min="0" :max="row.pendingDeliveryQty" :controls="false" style="width: 100%" /></template>
        </el-table-column>
      </el-table>
      <el-checkbox v-if="user.hasPerm('lgs:delivery:dispatch')" v-model="dl.dispatch" class="mt">保存后立即出发（转为派送在途，并通知目的仓实收）</el-checkbox>
      <template #footer>
        <el-button @click="dl.visible = false">取消</el-button>
        <el-button type="primary" :loading="dl.saving" @click="submitDelivery">确定</el-button>
      </template>
    </el-dialog>

    <ShipmentForm ref="form" @saved="load" />
    <FeeForm ref="feeForm" @saved="load" />
  </div>
</template>
