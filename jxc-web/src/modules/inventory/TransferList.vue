<script setup lang="ts">
import { onMounted, reactive, ref } from 'vue'
import { useRoute } from 'vue-router'
import { ElMessage } from 'element-plus'
import { http, createCommandIntent } from '@/api/http'
import { useUserStore } from '@/stores/user'
import CrudPage from '@/components/crud/CrudPage.vue'
import StatusTag from '@/components/StatusTag.vue'
import DateTimeText from '@/components/DateTimeText.vue'
import ApprovalPanel from '@/components/ApprovalPanel.vue'
import AuditTimeline from '@/components/AuditTimeline.vue'
import DocAttachment from '@/components/DocAttachment.vue'
import ProductCell from '@/components/biz/ProductCell.vue'
import ScanInput from '@/components/biz/ScanInput.vue'
import type { ColumnDef, CrudPageExpose, FieldDef } from '@/components/crud/types'
import { ALL_WAREHOUSE_SOURCE, TRANSFER_STATUS } from '@/modules/shared/bizOptions'
import { confirmAction, matchBarcode } from '@/utils/action'
import { formatDate } from '@/utils/format'
import TransferForm from './TransferForm.vue'

type Row = Record<string, any> // eslint-disable-line @typescript-eslint/no-explicit-any

const intent = createCommandIntent()
const route = useRoute()
const user = useUserStore()
const page = ref<CrudPageExpose>()
const form = ref<InstanceType<typeof TransferForm>>()
const { id: focusId, ...initialQuery } = route.query

const columns: ColumnDef[] = [
  { prop: 'docNo', label: '调拨单', width: 185, fixed: 'left' },
  { prop: 'route', label: '调出 → 调入', minWidth: 230 },
  { prop: 'productSummary', label: '商品', minWidth: 120 },
  { prop: 'qty', label: '计划 / 调出 / 实收 / 差异', width: 200 },
  { prop: 'plannedDate', label: '计划日期', type: 'date', width: 112 },
  { prop: 'createdByName', label: '创建人', width: 110 },
  { prop: 'status', label: '状态', type: 'status', width: 100 },
]
const searchFields: FieldDef[] = [
  { prop: 'keyword', label: '单号 / 备注' },
  { prop: 'status', label: '状态', type: 'select', options: TRANSFER_STATUS },
  { prop: 'fromWarehouseId', label: '调出仓', type: 'select', options: ALL_WAREHOUSE_SOURCE },
  { prop: 'toWarehouseId', label: '调入仓', type: 'select', options: ALL_WAREHOUSE_SOURCE },
]

const act = async (t: Row, path: string, msg: string, success: string, body?: object) => {
  if (await confirmAction(msg, () => http.postIdem(`/inv/transfers/${t.id}/${path}`, body ?? {}, intent), { success })) page.value?.reload()
}

// ---------- 实收 ----------
const rcv = reactive({ visible: false, saving: false, t: {} as Row, qty: {} as Record<number, number>, key: createCommandIntent(), active: 0 })
function openReceive(t: Row) {
  Object.assign(rcv, { visible: true, t, key: createCommandIntent(), active: 0, qty: Object.fromEntries(t.lines.map((l: Row) => [l.id, l.remainingQty])) })
}
function onScan(code: string) {
  const l = (rcv.t.lines as Row[]).find((x) => matchBarcode(x, code))
  if (!l) return ElMessage.error(`${code} 不在这张调拨单上`)
  rcv.active = l.id
}
async function submitReceive() {
  rcv.saving = true
  try {
    const res = await http.postIdem<Row>(`/inv/transfers/${rcv.t.id}/receive`, { lines: Object.entries(rcv.qty).map(([k, v]) => ({ lineId: Number(k), qty: v })) }, rcv.key)
    ElMessage.success(res.duplicate ? '这次实收已提交过，没有重复入库' : res.status === 'RECEIVED' ? '已全部实收' : '已部分实收，剩余数量仍在途')
    rcv.visible = false
    page.value?.reload()
  } finally {
    rcv.saving = false
  }
}

// ---------- 关闭 ----------
const cls = reactive({ visible: false, saving: false, t: {} as Row, reason: '', resolution: 'LOSS' })
async function submitClose() {
  if (!cls.reason.trim() && cls.t.differenceStatus !== 'APPROVED') return ElMessage.warning('请填写差异原因')
  cls.saving = true
  try {
    const result = await http.postIdem<Row>(`/inv/transfers/${cls.t.id}/close`, { reason: cls.reason, resolution: cls.resolution }, intent)
    ElMessage.success(result.status === 'CLOSED' ? '差异已处理，调拨单已关闭' : '已提交差异审批，未到数量仍在途')
    cls.visible = false
    page.value?.reload()
  } finally {
    cls.saving = false
  }
}

// ---------- 详情 ----------
const detail = reactive({ visible: false, t: {} as Row, tab: 'lines' })
async function openDetail(id: number) {
  Object.assign(detail, { visible: true, tab: 'lines', t: await http.get<Row>(`/inv/transfers/${id}`) })
}

onMounted(() => {
  if (focusId) openDetail(Number(focusId))
})
</script>

<template>
  <CrudPage ref="page" title="调拨单" resource="/inv/transfers" :columns="columns" :search-fields="searchFields" :default-query="initialQuery" :can-create="false" :can-toggle="false" audit-type="transfer" :actions-width="220">
    <template #toolbar>
      <el-button v-if="user.hasPerm('inv:transfer:create')" type="primary" @click="form?.open()"><el-icon><Plus /></el-icon>新建调拨单</el-button>
    </template>
    <template #header>
      <p class="muted">流程：草稿 → 审批 → 调出（扣减调出仓，形成调拨在途）→ 调入仓实收（可分次）→ 完成；未到数量先登记差异，审批后确认找回或报损。</p>
    </template>
    <template #col-docNo="{ row }"><el-link type="primary" @click="openDetail(row.id)">{{ row.docNo }}</el-link></template>
    <template #col-route="{ row }">{{ row.fromWarehouseName }} → {{ row.toWarehouseName }}</template>
    <template #col-qty="{ row }">
      <span class="mono">{{ row.totalQty }} / {{ row.shippedQty }} / {{ row.receivedQty }} / <span :class="{ warn: row.diffQty }">{{ row.diffQty }}</span></span>
    </template>
    <template #row-actions="{ row }">
      <template v-if="row.status === 'DRAFT' && user.hasPerm('inv:transfer:create')">
        <el-button link type="primary" @click="form?.open(row)">编辑</el-button>
        <el-button link type="success" @click="act(row, 'submit', `提交调拨单 ${row.docNo}？`, '已提交')">提交</el-button>
        <el-button link type="danger" @click="act(row, 'void', `作废草稿 ${row.docNo}？`, '已作废')">作废</el-button>
      </template>
      <el-button v-if="row.status === 'APPROVED' && user.hasPerm('inv:transfer:ship')" link type="primary" @click="act(row, 'ship', `从 ${row.fromWarehouseName} 调出 ${row.totalQty} 件？调出后扣减调出仓实物。`, '已调出，形成调拨在途')">调出</el-button>
      <el-button v-if="['IN_TRANSIT', 'PARTIAL_RECEIVED'].includes(row.status) && !['PENDING_APPROVAL', 'APPROVED'].includes(row.differenceStatus) && user.hasPerm('inv:transfer:receive')" link type="primary" @click="openReceive(row)">实收</el-button>
      <el-button v-if="['PARTIAL_RECEIVED', 'IN_TRANSIT', 'RECEIVED'].includes(row.status) && user.hasPerm('inv:transfer:receive')" link type="warning" :disabled="row.differenceStatus === 'PENDING_APPROVAL'" @click="Object.assign(cls, { visible: true, t: row, reason: row.differenceReason ?? '', resolution: row.differenceResolution ?? 'LOSS' })">{{ row.differenceStatus === 'APPROVED' ? '确认差异处理' : row.differenceStatus === 'PENDING_APPROVAL' ? '差异待审批' : '关闭差异' }}</el-button>
    </template>
  </CrudPage>

  <el-dialog v-model="rcv.visible" :title="`调拨实收 ${rcv.t.docNo}`" width="640px" append-to-body>
    <ScanInput class="mb" @scan="onScan" />
    <el-table :data="rcv.t.lines ?? []" border size="small" :row-class-name="({ row }: { row: Row }) => (row.id === rcv.active ? 'active-row' : '')">
      <el-table-column label="商品" min-width="170"><template #default="{ row }"><ProductCell :code="row.productCode" :name="row.productName" /></template></el-table-column>
      <el-table-column prop="shippedQty" label="调出" width="70" align="right" />
      <el-table-column prop="receivedQty" label="已收" width="70" align="right" />
      <el-table-column prop="remainingQty" label="在途" width="70" align="right" />
      <el-table-column label="本次实收" width="130">
        <template #default="{ row }"><el-input-number v-model="rcv.qty[row.id]" :min="0" :max="row.remainingQty" :controls="false" style="width: 100%" /></template>
      </el-table-column>
    </el-table>
    <p class="muted">可以分次实收；剩余数量保持在途。确认后批次沿用调出批次进入调入仓。</p>
    <template #footer>
      <el-button @click="rcv.visible = false">取消</el-button>
      <el-button type="primary" :loading="rcv.saving" @click="submitReceive">确认实收</el-button>
    </template>
  </el-dialog>

  <el-dialog v-model="cls.visible" :title="`关闭调拨单 ${cls.t.docNo}`" width="480px" append-to-body>
    <p v-if="cls.t.inTransitQty">未到数量 <b>{{ cls.t.inTransitQty }}</b> 件。差异审批前持续在途；审批后确认找回或报损。</p>
    <el-radio-group v-if="cls.t.inTransitQty" v-model="cls.resolution" :disabled="cls.t.differenceStatus === 'APPROVED'"><el-radio value="LOSS">报损</el-radio><el-radio value="FOUND">找回并实收</el-radio></el-radio-group>
    <el-input v-model="cls.reason" type="textarea" :rows="3" placeholder="差异原因（必填），例如：运输途中遗失 2 件" />
    <template #footer>
      <el-button @click="cls.visible = false">取消</el-button>
      <el-button type="primary" :loading="cls.saving" @click="submitClose">{{ cls.t.differenceStatus === 'APPROVED' || !cls.t.inTransitQty ? '确认处理并关闭' : '提交差异审批' }}</el-button>
    </template>
  </el-dialog>

  <el-drawer v-model="detail.visible" :title="`调拨单 ${detail.t.docNo ?? ''}`" size="720px" append-to-body>
    <el-descriptions :column="2" border size="small">
      <el-descriptions-item label="状态"><StatusTag :status="detail.t.status" /></el-descriptions-item>
      <el-descriptions-item label="计划日期">{{ formatDate(detail.t.plannedDate) }}</el-descriptions-item>
      <el-descriptions-item label="调出仓">{{ detail.t.fromWarehouseName }}</el-descriptions-item>
      <el-descriptions-item label="调入仓">{{ detail.t.toWarehouseName }}</el-descriptions-item>
      <el-descriptions-item label="调出时间"><DateTimeText :value="detail.t.shippedAt" /></el-descriptions-item>
      <el-descriptions-item label="实收时间"><DateTimeText :value="detail.t.receivedAt" /></el-descriptions-item>
      <el-descriptions-item label="备注" :span="2">{{ detail.t.remark || '-' }}</el-descriptions-item>
      <el-descriptions-item v-if="detail.t.closeReason" label="关闭原因" :span="2">{{ detail.t.closeReason }}</el-descriptions-item>
    </el-descriptions>
    <el-tabs v-model="detail.tab" class="mt">
      <el-tab-pane label="明细" name="lines">
        <el-table :data="detail.t.lines ?? []" border size="small">
          <el-table-column label="商品" min-width="170"><template #default="{ row }"><ProductCell :code="row.productCode" :name="row.productName" /></template></el-table-column>
          <el-table-column prop="qty" label="计划" width="64" align="right" />
          <el-table-column prop="shippedQty" label="调出" width="64" align="right" />
          <el-table-column prop="receivedQty" label="实收" width="64" align="right" />
          <el-table-column prop="remainingQty" label="在途" width="64" align="right" />
          <el-table-column prop="diffQty" label="差异" width="64" align="right" />
        </el-table>
      </el-tab-pane>
      <el-tab-pane v-if="detail.t.differenceId" label="差异审批" name="difference"><ApprovalPanel doc-type="TRANSFER_DIFFERENCE" :doc-id="detail.t.differenceId" /></el-tab-pane>
      <el-tab-pane v-if="detail.t.id" label="审批" name="approval"><ApprovalPanel doc-type="TRANSFER" :doc-id="detail.t.id" /></el-tab-pane>
      <el-tab-pane v-if="detail.t.id" label="附件" name="files" lazy><DocAttachment biz-type="TRANSFER" :biz-id="detail.t.id" category="INVENTORY_DOC" /></el-tab-pane>
      <el-tab-pane v-if="detail.t.id" label="操作日志" name="audit" lazy><AuditTimeline resource-type="transfer" :resource-id="detail.t.id" /></el-tab-pane>
    </el-tabs>
  </el-drawer>
  <TransferForm ref="form" @saved="page?.reload()" />
</template>

<style scoped>
.mb {
  margin-bottom: 10px;
}

.mt {
  margin-top: 12px;
}

.warn {
  color: var(--el-color-danger);
  font-weight: 600;
}

:deep(.active-row) {
  --el-table-tr-bg-color: var(--el-color-primary-light-9);
}
</style>
