<script setup lang="ts">
import { computed, onBeforeUnmount, onMounted, reactive, ref, watch } from 'vue'
import { useRoute, useRouter } from 'vue-router'
import { ElMessage } from 'element-plus'
import { Close, FullScreen } from '@element-plus/icons-vue'
import { http, createCommandIntent } from '@/api/http'
import { useUserStore } from '@/stores/user'
import StatusTag from '@/components/StatusTag.vue'
import MoneyText from '@/components/MoneyText.vue'
import DateTimeText from '@/components/DateTimeText.vue'
import ApprovalPanel from '@/components/ApprovalPanel.vue'
import DocAttachment from '@/components/DocAttachment.vue'
import PurchaseOrderAudit from './PurchaseOrderAudit.vue'
import ProductCell from '@/components/biz/ProductCell.vue'
import { confirmAction } from '@/utils/action'
import { useCountryStore } from '@/stores/country'
import { formatDate, todayIn } from '@/utils/format'
import { TRANSPORT_MODES, optionText } from '@/modules/shared/bizOptions'
import PurchaseOrderForm from './PurchaseOrderForm.vue'
import {
  DEFAULT_PRODUCT_RATIO,
  ratioAtPosition,
  shouldUseNaturalFlow,
  stepProductRatio,
  toggleFocusedPane,
  workspaceContentBounds,
  type DetailPane,
  type FocusedPane,
} from './purchaseOrderDetailLayout'
import './purchase-order.scss'

const supplyCommandIntent = createCommandIntent()


type Row = Record<string, any> // eslint-disable-line @typescript-eslint/no-explicit-any

interface Progress {
  order: Row
  receipts: Row[]
  exports: Row[]
  shipments: Row[]
  mxReceipts: Row[]
  cancels: Row[]
}

const route = useRoute()
const router = useRouter()
const user = useUserStore(), country = useCountryStore()
const data = ref<Progress | null>(null)
const loading = ref(false)
const tab = ref('receipts')
const form = ref<InstanceType<typeof PurchaseOrderForm>>()
const approval = ref<InstanceType<typeof ApprovalPanel>>()
const audit = ref<InstanceType<typeof PurchaseOrderAudit>>()
const auditVisible = ref(false)
const summaryCard = ref<HTMLElement>()
const workspace = ref<HTMLElement>()
const splitter = ref<HTMLElement>()
const productRatio = ref(DEFAULT_PRODUCT_RATIO)
const focusedPane = ref<FocusedPane>(null)
const naturalFlow = ref(false)
const workspaceHeight = ref(0)
const summaryColumns = ref(3)
const resizing = ref(false)
const tableHeight = computed(() => naturalFlow.value ? undefined : '100%')
const workspaceStyle = computed(() => ({
  '--product-pane': `${productRatio.value}fr`,
  '--records-pane': `${100 - productRatio.value}fr`,
  '--workspace-height': `${workspaceHeight.value}px`,
}))
let summaryObserver: ResizeObserver | undefined

const id = computed(() => Number(route.params.id))
const o = computed(() => data.value?.order ?? {})
const lines = computed<Row[]>(() => o.value.lines ?? [])
const delivered = computed(() => lines.value.some((l) => l.qualifiedQty + l.pendingInspectQty > 0))
const editable = computed(() => o.value.status === 'DRAFT' || (o.value.status === 'CONFIRMED' && !delivered.value))

async function load() {
  loading.value = true
  try {
    data.value = await http.get<Progress>(`/pur/orders/${id.value}/progress`)
  } finally {
    loading.value = false
  }
  approval.value?.reload()
  audit.value?.reload()
}

async function submit() {
  await confirmAction('提交采购单？将按当前国家的单据设置及审批规则处理。', () => http.postIdem(`/pur/orders/${id.value}/submit`, undefined, supplyCommandIntent), { success: '已提交' })
  load()
}

async function voidOrder() {
  await confirmAction('作废这张草稿？', () => http.postIdem(`/pur/orders/${id.value}/void`, undefined, supplyCommandIntent), { success: '已作废' })
  load()
}

// ---------- 部分取消 ----------
const cancel = reactive({ visible: false, reason: '', qty: {} as Record<number, number>, saving: false })
function openCancel() {
  Object.assign(cancel, { visible: true, reason: '', qty: Object.fromEntries(lines.value.map((l) => [l.id, 0])) })
}
async function submitCancel() {
  if (!cancel.reason.trim()) return ElMessage.warning('请填写取消原因')
  cancel.saving = true
  try {
    await http.postIdem(`/pur/orders/${id.value}/cancel-lines`, {
      reason: cancel.reason, bizDate: todayIn(country.timezone),
      lines: Object.entries(cancel.qty).filter(([, q]) => q > 0).map(([lineId, qty]) => ({ orderLineId: Number(lineId), cancelQty: qty })),
    }, supplyCommandIntent)
    ElMessage.success('已取消，未交数量同步减少')
    cancel.visible = false
    load()
  } finally {
    cancel.saving = false
  }
}

// ---------- 关闭 ----------
const close = reactive({ visible: false, reason: '', saving: false })
async function submitClose() {
  if (!close.reason.trim()) return ElMessage.warning('请填写关闭原因')
  close.saving = true
  try {
    await http.postIdem(`/pur/orders/${id.value}/close`, { reason: close.reason, bizDate: todayIn(country.timezone) }, supplyCommandIntent)
    ElMessage.success('已关闭，未交数量已自动取消')
    close.visible = false
    load()
  } finally {
    close.saving = false
  }
}

function restoreWorkspace() {
  productRatio.value = DEFAULT_PRODUCT_RATIO
  focusedPane.value = null
  resizing.value = false
}

function updateWorkspaceLayout() {
  const nextNaturalFlow = shouldUseNaturalFlow(window.innerWidth, window.innerHeight)
  if (nextNaturalFlow && !naturalFlow.value) restoreWorkspace()
  naturalFlow.value = nextNaturalFlow
  summaryColumns.value = window.innerWidth > 1440 ? 4 : window.innerWidth <= 768 ? 2 : 3
  if (nextNaturalFlow || !workspace.value) {
    workspaceHeight.value = 0
    return
  }
  const top = workspace.value.getBoundingClientRect().top
  workspaceHeight.value = Math.max(360, Math.min(680, window.innerHeight - top - 32))
}

function beginResize(event: PointerEvent) {
  if (naturalFlow.value || !splitter.value) return
  event.preventDefault()
  splitter.value.setPointerCapture(event.pointerId)
  resizing.value = true
}

function resizeWorkspace(event: PointerEvent) {
  if (!splitter.value?.hasPointerCapture(event.pointerId) || !workspace.value) return
  const bounds = workspace.value.getBoundingClientRect()
  const style = window.getComputedStyle(workspace.value)
  const content = workspaceContentBounds(
    bounds.top,
    workspace.value.clientTop,
    workspace.value.clientHeight,
    Number.parseFloat(style.paddingTop) || 0,
    Number.parseFloat(style.paddingBottom) || 0,
  )
  productRatio.value = ratioAtPosition(event.clientY, content.top, content.height, splitter.value.offsetHeight)
}

function stopResize() {
  resizing.value = false
}

function adjustWorkspace(event: KeyboardEvent) {
  if (event.key === 'Escape') {
    event.preventDefault()
    restoreWorkspace()
    return
  }
  const nextRatio = stepProductRatio(productRatio.value, event.key)
  if (nextRatio === null) return
  event.preventDefault()
  productRatio.value = nextRatio
}

function focusPane(target: DetailPane) {
  if (naturalFlow.value) return
  focusedPane.value = toggleFocusedPane(focusedPane.value, target)
}

watch(id, () => { auditVisible.value = false; load() })
onMounted(() => {
  load()
  updateWorkspaceLayout()
  window.addEventListener('resize', updateWorkspaceLayout)
  if (typeof ResizeObserver !== 'undefined' && summaryCard.value) {
    summaryObserver = new ResizeObserver(updateWorkspaceLayout)
    summaryObserver.observe(summaryCard.value)
  }
})
onBeforeUnmount(() => {
  window.removeEventListener('resize', updateWorkspaceLayout)
  summaryObserver?.disconnect()
})
</script>

<template>
  <div v-loading="loading" class="page purchase-order-detail">
    <div ref="summaryCard" class="page-card detail-summary">
      <div class="page-title">
        <h2>
          <el-button link aria-label="返回采购单列表" @click="router.push('/purchase/orders')"><el-icon><ArrowLeft /></el-icon></el-button>
          采购单 <span class="mono">{{ o.docNo }}</span>
          <StatusTag :status="o.status" />
        </h2>
        <div class="toolbar">
          <el-button :disabled="loading || !o.id" @click="auditVisible = true">操作日志</el-button>
          <el-button v-if="editable && user.hasPerm(['pur:order:edit', 'pur:order:create'])" @click="form?.open(id)">编辑</el-button>
          <el-button v-if="o.status === 'DRAFT' && user.hasPerm('pur:order:submit')" type="primary" @click="submit">提交</el-button>
          <el-button v-if="['CONFIRMED', 'PARTIAL_DELIVERED'].includes(o.status) && user.hasPerm('pur:order:cancel')" @click="openCancel">部分取消</el-button>
          <el-button v-if="['CONFIRMED', 'PARTIAL_DELIVERED', 'DELIVERED'].includes(o.status) && user.hasPerm('pur:order:close')" @click="Object.assign(close, { visible: true, reason: '' })">关闭</el-button>
          <el-button v-if="o.status === 'DRAFT' && user.hasPerm('pur:order:cancel')" type="danger" plain @click="voidOrder">作废</el-button>
        </div>
      </div>
      <el-descriptions :column="summaryColumns" border size="small">
        <el-descriptions-item label="供应商">{{ o.supplierName }}</el-descriptions-item>
        <el-descriptions-item label="经营主体">{{ o.entityName }}</el-descriptions-item>
        <el-descriptions-item label="币种">{{ o.currency }}</el-descriptions-item>
        <el-descriptions-item label="下单日期">{{ formatDate(o.orderDate) }}</el-descriptions-item>
        <el-descriptions-item label="预计交货">{{ formatDate(o.expectedDate) }}</el-descriptions-item>
        <el-descriptions-item label="金额">
          <span v-if="o.costHidden" class="muted">无权查看</span>
          <MoneyText v-else :value="o.totalAmount" :currency="o.currency" />
        </el-descriptions-item>
        <el-descriptions-item label="付款条件">{{ o.paymentTerms || '-' }}</el-descriptions-item>
        <el-descriptions-item label="预付比例">{{ o.prepayRatio ?? 0 }}%</el-descriptions-item>
        <el-descriptions-item label="创建人">{{ o.createdByName }} · <DateTimeText :value="o.createdAt" /></el-descriptions-item>
        <el-descriptions-item label="备注" :span="summaryColumns">{{ o.remark || '-' }}</el-descriptions-item>
        <el-descriptions-item v-if="o.closeReason" label="关闭原因" :span="summaryColumns">{{ o.closeReason }}</el-descriptions-item>
      </el-descriptions>
    </div>

    <div
      ref="workspace"
      class="page-card detail-workspace"
      :class="{ 'is-natural': naturalFlow, 'focus-products': focusedPane === 'products', 'focus-records': focusedPane === 'records', 'is-resizing': resizing }"
      :style="workspaceStyle"
    >
      <section id="products-pane" class="products-pane" aria-label="商品明细">
        <div class="pane-heading">
          <div class="pane-title"><h3>商品明细</h3><span class="muted">{{ lines.length }} 行</span></div>
          <el-button link class="pane-focus" :aria-pressed="focusedPane === 'products'" :aria-label="focusedPane === 'products' ? '还原商品明细和关联记录' : '放大商品明细'" @click="focusPane('products')">
            <el-icon><Close v-if="focusedPane === 'products'" /><FullScreen v-else /></el-icon>
            {{ focusedPane === 'products' ? '还原布局' : '放大' }}
          </el-button>
        </div>
        <div class="product-table-region">
          <el-table :data="lines" :height="tableHeight" class="purchase-order-table" border stripe size="small" row-key="id">
          <el-table-column prop="lineNo" label="#" width="44" />
          <el-table-column label="商品" min-width="190">
            <template #default="{ row }"><ProductCell :code="row.productCode" :name="row.productName" :extra="`${row.qty} ${row.unit}（×${row.factor}）`" /></template>
          </el-table-column>
          <el-table-column v-if="!o.costHidden" label="单价" width="110" align="right">
            <template #default="{ row }"><MoneyText :value="row.unitPrice" :currency="o.currency" /></template>
          </el-table-column>
          <el-table-column v-if="!o.costHidden" label="金额" width="120" align="right">
            <template #default="{ row }"><MoneyText :value="row.amount" :currency="o.currency" /></template>
          </el-table-column>
          <el-table-column prop="baseQty" label="订购" width="72" align="right" />
          <el-table-column prop="cancelledQty" label="已取消" width="72" align="right" />
          <el-table-column prop="qualifiedQty" label="国内合格" width="82" align="right" />
          <el-table-column prop="pendingInspectQty" label="待检" width="64" align="right" />
          <el-table-column prop="damagedQty" label="破损" width="64" align="right" />
          <el-table-column label="未交" width="72" align="right">
            <template #default="{ row }"><b :class="{ warn: row.undeliveredQty > 0 }">{{ row.undeliveredQty }}</b></template>
          </el-table-column>
          <el-table-column prop="exportedQty" label="已出口" width="72" align="right" />
          <el-table-column prop="shippedQty" label="已发运" width="72" align="right" />
          <el-table-column prop="arrivedMxQty" label="目的地实收" width="76" align="right" />
          <el-table-column label="交货日期" width="105">
            <template #default="{ row }">{{ formatDate(row.deliveryDate) }}</template>
          </el-table-column>
          </el-table>
        </div>
        <p class="muted progress-note">未交 = 订购 − 已取消 − 国内合格 − 待检。破损不抵减未交，可以继续向供应商要求补货；待检转合格或破损后进度自动更新。</p>
      </section>

      <div
        ref="splitter"
        class="detail-splitter"
        role="separator"
        aria-label="调整商品明细与关联记录的区域比例"
        aria-controls="products-pane records-pane"
        aria-orientation="horizontal"
        tabindex="0"
        :aria-valuenow="productRatio"
        :aria-valuemin="35"
        :aria-valuemax="72"
        :aria-valuetext="`商品明细 ${productRatio}%，关联记录 ${100 - productRatio}%`"
        @pointerdown="beginResize"
        @pointermove="resizeWorkspace"
        @pointerup="stopResize"
        @pointercancel="stopResize"
        @lostpointercapture="stopResize"
        @dblclick="restoreWorkspace"
        @keydown="adjustWorkspace"
      >
        <span aria-hidden="true" />
      </div>

      <section id="records-pane" class="records-pane" aria-label="关联记录">
        <div class="pane-heading records-heading">
          <div class="pane-title"><h3>关联记录</h3></div>
          <div class="pane-actions">
            <el-button v-if="tab === 'receipts'" link type="primary" @click="router.push({ path: '/purchase/domestic-receipts', query: { orderId: id } })">去国内收货</el-button>
            <el-button link class="pane-focus" :aria-pressed="focusedPane === 'records'" :aria-label="focusedPane === 'records' ? '还原商品明细和关联记录' : '放大关联记录'" @click="focusPane('records')">
              <el-icon><Close v-if="focusedPane === 'records'" /><FullScreen v-else /></el-icon>
              {{ focusedPane === 'records' ? '还原布局' : '放大' }}
            </el-button>
          </div>
        </div>
        <el-tabs v-model="tab" class="records-tabs">
        <el-tab-pane :label="`国内收货（${data?.receipts.length ?? 0}）`" name="receipts">
          <el-table :data="data?.receipts ?? []" :height="tableHeight" class="purchase-order-table" border stripe size="small">
            <el-table-column prop="docNo" label="收货单" width="170" />
            <el-table-column label="日期" width="105"><template #default="{ row }">{{ formatDate(row.receiptDate) }}</template></el-table-column>
            <el-table-column prop="location" label="地点" min-width="140" />
            <el-table-column label="明细" min-width="260">
              <template #default="{ row }">
                <div v-for="l in row.lines" :key="l.id">{{ l.productCode }}：合格 {{ l.qualifiedQty }} · 待检 {{ l.pendingInspectQty }} · 破损 {{ l.damagedQty }}</div>
              </template>
            </el-table-column>
            <el-table-column label="状态" width="90"><template #default="{ row }"><StatusTag :status="row.status" /></template></el-table-column>
          </el-table>
        </el-tab-pane>
        <el-tab-pane :label="`出口节点（${data?.exports.length ?? 0}）`" name="exports">
          <el-table :data="data?.exports ?? []" :height="tableHeight" class="purchase-order-table" border stripe size="small">
            <el-table-column prop="docNo" label="出口单" width="170" />
            <el-table-column prop="declarationNo" label="报关单号" width="170" />
            <el-table-column prop="exportPort" label="口岸" width="110" />
            <el-table-column label="出口日期" width="105"><template #default="{ row }">{{ formatDate(row.exportDate) }}</template></el-table-column>
            <el-table-column label="明细" min-width="200">
              <template #default="{ row }"><div v-for="l in row.lines" :key="l.id">{{ l.productCode }} × {{ l.qty }}（已发运 {{ l.shippedQty }}）</div></template>
            </el-table-column>
            <el-table-column label="状态" width="90"><template #default="{ row }"><StatusTag :status="row.status" /></template></el-table-column>
          </el-table>
        </el-tab-pane>
        <el-tab-pane :label="`运输批次（${data?.shipments.length ?? 0}）`" name="shipments">
          <el-table :data="data?.shipments ?? []" :height="tableHeight" class="purchase-order-table" border stripe size="small">
            <el-table-column label="批次" width="170">
              <template #default="{ row }"><el-link type="primary" @click="router.push(`/logistics/shipments/${row.id}`)">{{ row.docNo }}</el-link></template>
            </el-table-column>
            <el-table-column label="方式" width="70"><template #default="{ row }">{{ optionText(TRANSPORT_MODES, row.transportMode) }}</template></el-table-column>
            <el-table-column prop="containerNo" label="当前柜号" width="130" />
            <el-table-column label="实际发运 / 到港" min-width="220">
              <template #default="{ row }"><DateTimeText :value="row.actualEtd" :known-date="row.openingRef ? row.openingSourceDate : null" /> / <DateTimeText :value="row.actualEta" /></template>
            </el-table-column>
            <el-table-column label="本单商品" min-width="200">
              <template #default="{ row }"><div v-for="l in row.lines" :key="l.id">{{ l.productCode }} × {{ l.shippedQty || l.baseQty }}</div></template>
            </el-table-column>
            <el-table-column label="状态" width="100"><template #default="{ row }"><StatusTag :status="row.status" /></template></el-table-column>
          </el-table>
        </el-tab-pane>
        <el-tab-pane :label="`目的地实收（${data?.mxReceipts.length ?? 0}）`" name="mx">
          <el-table :data="data?.mxReceipts ?? []" :height="tableHeight" class="purchase-order-table" border stripe size="small">
            <el-table-column prop="receiptNo" label="实收单" width="170" />
            <el-table-column label="日期" width="105"><template #default="{ row }">{{ formatDate(row.bizDate) }}</template></el-table-column>
            <el-table-column prop="warehouseName" label="仓库" width="140" />
            <el-table-column prop="productCode" label="商品" width="90" />
            <el-table-column prop="goodQty" label="合格" width="70" align="right" />
            <el-table-column prop="damagedQty" label="破损" width="70" align="right" />
            <el-table-column prop="pendingInspectQty" label="待检" width="70" align="right" />
            <el-table-column prop="shortQty" label="短缺" width="70" align="right" />
          </el-table>
        </el-tab-pane>
        <el-tab-pane :label="`取消记录（${data?.cancels.length ?? 0}）`" name="cancels">
          <el-table :data="data?.cancels ?? []" :height="tableHeight" class="purchase-order-table" border stripe size="small">
            <el-table-column prop="productCode" label="商品" width="100" />
            <el-table-column prop="cancelQty" label="取消数量" width="90" align="right" />
            <el-table-column prop="reason" label="原因" min-width="200" />
            <el-table-column label="操作人" min-width="200">
              <template #default="{ row }">{{ row.cancelledByName }} · <DateTimeText :value="row.cancelledAt" /></template>
            </el-table-column>
          </el-table>
        </el-tab-pane>
        <el-tab-pane label="附件" name="files" lazy>
          <DocAttachment biz-type="PURCHASE_ORDER" :biz-id="id" category="PURCHASE_DOC" />
        </el-tab-pane>
        <el-tab-pane label="审批" name="approval">
          <ApprovalPanel ref="approval" doc-type="PURCHASE_ORDER" :doc-id="id" />
        </el-tab-pane>
        </el-tabs>
      </section>
    </div>

    <el-dialog v-model="cancel.visible" title="部分取消" width="640px" class="purchase-order-dialog" append-to-body>
      <el-table :data="lines" class="purchase-order-table" border stripe size="small">
        <el-table-column label="商品" min-width="180">
          <template #default="{ row }"><ProductCell :code="row.productCode" :name="row.productName" /></template>
        </el-table-column>
        <el-table-column prop="undeliveredQty" label="可取消（未交）" width="120" align="right" />
        <el-table-column label="本次取消" width="140">
          <template #default="{ row }">
            <el-input-number v-model="cancel.qty[row.id]" :min="0" :max="row.undeliveredQty" :controls="false" style="width: 100%" />
          </template>
        </el-table-column>
      </el-table>
      <el-input v-model="cancel.reason" class="mt" type="textarea" :rows="2" placeholder="取消原因（必填），例如：供应商停产" />
      <template #footer>
        <el-button @click="cancel.visible = false">取消</el-button>
        <el-button type="primary" :loading="cancel.saving" @click="submitCancel">确定</el-button>
      </template>
    </el-dialog>

    <el-dialog v-model="close.visible" title="关闭采购单" width="480px" class="purchase-order-dialog" append-to-body>
      <p class="muted">关闭后不再接收国内收货，剩余未交数量自动记为取消；已收货物的后续出口、发运不受影响。</p>
      <el-input v-model="close.reason" type="textarea" :rows="3" placeholder="关闭原因（必填）" />
      <template #footer>
        <el-button @click="close.visible = false">取消</el-button>
        <el-button type="primary" :loading="close.saving" @click="submitClose">确定关闭</el-button>
      </template>
    </el-dialog>

    <PurchaseOrderForm ref="form" @saved="load" />
    <PurchaseOrderAudit v-if="auditVisible" :key="id" ref="audit" v-model="auditVisible" :resource-id="id" :order="o" />
  </div>
</template>

<style scoped>
.purchase-order-detail {
  min-width: 0;
}

.detail-summary {
  padding-top: 12px;
  padding-bottom: 12px;
}

.page-title {
  flex-wrap: wrap;
  gap: 8px;
  margin-bottom: 8px;
}

h2 {
  display: flex;
  align-items: center;
  flex-wrap: wrap;
  gap: 8px;
}

.page-title > .toolbar {
  margin-bottom: 0;
}

.toolbar > .el-button {
  margin-left: 0;
}

h3 {
  margin: 0;
  font-size: 14px;
}

.detail-workspace {
  --product-pane: 58fr;
  --records-pane: 42fr;
  display: grid;
  grid-template-rows: minmax(160px, var(--product-pane)) 10px minmax(120px, var(--records-pane));
  height: var(--workspace-height);
  min-height: 360px;
  overflow: hidden;
  padding: 12px 14px;
}

.products-pane,
.records-pane {
  display: flex;
  flex-direction: column;
  min-width: 0;
  min-height: 0;
  overflow: hidden;
}

.pane-heading,
.pane-title,
.pane-actions {
  display: flex;
  align-items: center;
}

.pane-heading {
  justify-content: space-between;
  gap: 12px;
  min-height: 34px;
  padding-bottom: 4px;
}

.pane-title,
.pane-actions {
  gap: 8px;
}

.pane-focus {
  flex: none;
}

.product-table-region {
  flex: 1 1 auto;
  min-width: 0;
  min-height: 0;
  overflow: hidden;
}

.product-table-region :deep(.el-table) {
  height: 100%;
}

.progress-note {
  flex: none;
  margin: 4px 0 0;
  line-height: 18px;
  font-size: 12px;
}

.detail-splitter {
  display: flex;
  align-items: center;
  justify-content: center;
  margin: 0 -14px;
  cursor: row-resize;
  touch-action: none;
  outline-offset: -2px;
}

.detail-splitter span {
  width: 36px;
  height: 3px;
  border-radius: 2px;
  background: #b8c5d6;
  transition: width 120ms ease, background-color 120ms ease;
}

.detail-splitter:hover span,
.detail-splitter:focus-visible span {
  width: 52px;
  background: var(--el-color-primary);
}

.detail-splitter:focus-visible {
  outline: 2px solid var(--el-color-primary);
}

.detail-workspace.is-resizing,
.detail-workspace.is-resizing * {
  user-select: none;
}

.records-tabs {
  display: flex;
  flex: 1 1 auto;
  flex-direction: column;
  min-height: 0;
}

.records-tabs :deep(.el-tabs__header) {
  flex: none;
  margin-bottom: 6px;
}

.records-tabs :deep(.el-tabs__nav-wrap) {
  overflow-x: auto;
}

.records-tabs :deep(.el-tabs__content) {
  flex: 1 1 auto;
  min-height: 0;
  overflow: hidden;
}

.records-tabs :deep(.el-tab-pane) {
  height: 100%;
  overflow: auto;
}

.detail-workspace.focus-products,
.detail-workspace.focus-records {
  display: block;
}

.detail-workspace.focus-products .records-pane,
.detail-workspace.focus-records .products-pane,
.detail-workspace.focus-products .detail-splitter,
.detail-workspace.focus-records .detail-splitter {
  display: none;
}

.detail-workspace.focus-products .products-pane,
.detail-workspace.focus-records .records-pane {
  height: 100%;
}

.detail-workspace.is-natural {
  display: block;
  height: auto;
  min-height: 0;
  overflow: visible;
  padding: 12px;
}

.detail-workspace.is-natural .products-pane,
.detail-workspace.is-natural .records-pane {
  display: block;
  height: auto;
  overflow: visible;
}

.detail-workspace.is-natural .detail-splitter,
.detail-workspace.is-natural .pane-focus {
  display: none;
}

.detail-workspace.is-natural .product-table-region {
  overflow-x: auto;
  overflow-y: visible;
}

.detail-workspace.is-natural .product-table-region :deep(.el-table) {
  height: auto;
}

.detail-workspace.is-natural .records-pane {
  margin-top: 16px;
}

.detail-workspace.is-natural .records-tabs {
  display: block;
  min-height: 0;
}

.detail-workspace.is-natural .records-tabs :deep(.el-tabs__content) {
  overflow: visible;
}

.detail-workspace.is-natural .records-tabs :deep(.el-tab-pane) {
  height: auto;
  overflow: visible;
}

.mt {
  margin-top: 10px;
}

.warn {
  color: var(--el-color-warning);
}

:global(.purchase-order-dialog) {
  max-width: 96vw;
}

@media (max-width: 600px) {
  .detail-summary {
    padding: 10px;
  }

  .detail-workspace.is-natural {
    padding: 10px;
  }

  .pane-heading {
    gap: 6px;
  }

  .records-heading .pane-actions {
    gap: 4px;
  }
}
</style>
