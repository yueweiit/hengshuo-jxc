<script setup lang="ts">
import { computed, onMounted, reactive, ref, watch } from 'vue'
import { useRoute, useRouter } from 'vue-router'
import { ElMessage } from 'element-plus'
import { http, createCommandIntent } from '@/api/http'
import { useUserStore } from '@/stores/user'
import StatusTag from '@/components/StatusTag.vue'
import MoneyText from '@/components/MoneyText.vue'
import DateTimeText from '@/components/DateTimeText.vue'
import ApprovalPanel from '@/components/ApprovalPanel.vue'
import DocAttachment from '@/components/DocAttachment.vue'
import AuditTimeline from '@/components/AuditTimeline.vue'
import ProductCell from '@/components/biz/ProductCell.vue'
import { confirmAction } from '@/utils/action'
import { useCountryStore } from '@/stores/country'
import { formatDate, todayIn } from '@/utils/format'
import { TRANSPORT_MODES, optionText } from '@/modules/shared/bizOptions'
import PurchaseOrderForm from './PurchaseOrderForm.vue'

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

watch(id, load)
onMounted(load)
</script>

<template>
  <div v-loading="loading" class="page">
    <div class="page-card">
      <div class="page-title">
        <h2>
          <el-button link @click="router.push('/purchase/orders')"><el-icon><ArrowLeft /></el-icon></el-button>
          采购单 <span class="mono">{{ o.docNo }}</span>
          <StatusTag :status="o.status" />
        </h2>
        <div class="toolbar">
          <el-button v-if="editable && user.hasPerm(['pur:order:edit', 'pur:order:create'])" @click="form?.open(id)">编辑</el-button>
          <el-button v-if="o.status === 'DRAFT' && user.hasPerm('pur:order:submit')" type="primary" @click="submit">提交</el-button>
          <el-button v-if="['CONFIRMED', 'PARTIAL_DELIVERED'].includes(o.status) && user.hasPerm('pur:order:cancel')" @click="openCancel">部分取消</el-button>
          <el-button v-if="['CONFIRMED', 'PARTIAL_DELIVERED', 'DELIVERED'].includes(o.status) && user.hasPerm('pur:order:close')" @click="Object.assign(close, { visible: true, reason: '' })">关闭</el-button>
          <el-button v-if="o.status === 'DRAFT' && user.hasPerm('pur:order:cancel')" type="danger" plain @click="voidOrder">作废</el-button>
        </div>
      </div>
      <el-descriptions :column="3" border size="small">
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
        <el-descriptions-item label="备注" :span="3">{{ o.remark || '-' }}</el-descriptions-item>
        <el-descriptions-item v-if="o.closeReason" label="关闭原因" :span="3">{{ o.closeReason }}</el-descriptions-item>
      </el-descriptions>
    </div>

    <div class="page-card">
      <h3>行进度（基本单位）</h3>
      <div class="table-scroll">
        <el-table :data="lines" border size="small" row-key="id">
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
      <p class="muted">未交 = 订购 − 已取消 − 国内合格 − 待检。破损不抵减未交，可以继续向供应商要求补货；待检转合格或破损后进度自动更新。</p>
    </div>

    <div class="page-card">
      <el-tabs v-model="tab">
        <el-tab-pane :label="`国内收货（${data?.receipts.length ?? 0}）`" name="receipts">
          <el-table :data="data?.receipts ?? []" border size="small">
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
          <el-button link type="primary" class="mt" @click="router.push({ path: '/purchase/domestic-receipts', query: { orderId: id } })">去国内收货</el-button>
        </el-tab-pane>
        <el-tab-pane :label="`出口节点（${data?.exports.length ?? 0}）`" name="exports">
          <el-table :data="data?.exports ?? []" border size="small">
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
          <el-table :data="data?.shipments ?? []" border size="small">
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
          <el-table :data="data?.mxReceipts ?? []" border size="small">
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
          <el-table :data="data?.cancels ?? []" border size="small">
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
        <el-tab-pane label="操作日志" name="audit" lazy>
          <AuditTimeline resource-type="purchase-order" :resource-id="id" />
        </el-tab-pane>
      </el-tabs>
    </div>

    <el-dialog v-model="cancel.visible" title="部分取消" width="640px" append-to-body>
      <el-table :data="lines" border size="small">
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

    <el-dialog v-model="close.visible" title="关闭采购单" width="480px" append-to-body>
      <p class="muted">关闭后不再接收国内收货，剩余未交数量自动记为取消；已收货物的后续出口、发运不受影响。</p>
      <el-input v-model="close.reason" type="textarea" :rows="3" placeholder="关闭原因（必填）" />
      <template #footer>
        <el-button @click="close.visible = false">取消</el-button>
        <el-button type="primary" :loading="close.saving" @click="submitClose">确定关闭</el-button>
      </template>
    </el-dialog>

    <PurchaseOrderForm ref="form" @saved="load" />
  </div>
</template>

<style scoped>
h2 {
  display: flex;
  align-items: center;
  gap: 8px;
}

h3 {
  margin: 0 0 12px;
  font-size: 15px;
}

.mt {
  margin-top: 10px;
}

.warn {
  color: var(--el-color-warning);
}
</style>
