<script setup lang="ts">
import { computed, reactive, ref } from 'vue'
import { useRoute } from 'vue-router'
import { ElMessage } from 'element-plus'
import { http, createCommandIntent } from '@/api/http'
import { allRecords } from '@/api/pagination'
import { useUserStore } from '@/stores/user'
import { useCountryStore } from '@/stores/country'
import CrudPage from '@/components/crud/CrudPage.vue'
import StatusTag from '@/components/StatusTag.vue'
import DateTimeText from '@/components/DateTimeText.vue'
import ProductCell from '@/components/biz/ProductCell.vue'
import DocAttachment from '@/components/DocAttachment.vue'
import type { ColumnDef, CrudPageExpose, FieldDef } from '@/components/crud/types'
import { DOC_STATUS } from '@/modules/shared/bizOptions'
import { confirmAction } from '@/utils/action'
import { todayIn } from '@/utils/format'

const supplyCommandIntent = createCommandIntent()


type Row = Record<string, any> // eslint-disable-line @typescript-eslint/no-explicit-any

const route = useRoute()
const user = useUserStore()
const country = useCountryStore()
const page = ref<CrudPageExpose>()

const columns: ColumnDef[] = [
  { prop: 'docNo', label: '收货单号', width: 170, fixed: 'left' },
  { prop: 'orderNo', label: '采购单', width: 170 },
  { prop: 'supplierName', label: '供应商', minWidth: 160 },
  { prop: 'receiptDate', label: '收货日期', type: 'date', width: 105 },
  { prop: 'location', label: '收货地点', minWidth: 130 },
  { prop: 'qty', label: '合格 / 待检 / 破损', width: 150 },
  { prop: 'status', label: '状态', type: 'status', width: 90 },
  { prop: 'createdByName', label: '登记人', width: 120 },
]
const searchFields: FieldDef[] = [
  { prop: 'keyword', label: '单号 / 地点' },
  { prop: 'status', label: '状态', type: 'select', options: DOC_STATUS },
]
const queryOrderId = route.query.orderId ? Number(route.query.orderId) : undefined
const defaultQuery = queryOrderId ? { orderId: queryOrderId } : {}

// ---------- 登记与编辑 ----------
const orders = ref<Row[]>([])
const edit = reactive({ visible: false, id: 0, version: 0, orderId: undefined as number | undefined, receiptDate: '', location: '', remark: '', lines: [] as Row[], saving: false, loadingOrder: false })
let orderRequest = 0, orderListRequest = 0, editRequest = 0
const context = () => ({ epoch: country.epoch, countryId: country.currentId, token: user.token })
const currentContext = (saved: ReturnType<typeof context>) => saved.epoch === country.epoch && saved.countryId === country.currentId && saved.token === user.token
const orderLabel = (o: Row) => `${o.docNo} · ${o.supplierName || `供应商 #${o.supplierId}`}`

async function loadOrders() {
  const request = ++orderListRequest, saved = context()
  const res = await allRecords<Row>('/pur/orders')
  if (request !== orderListRequest || !currentContext(saved)) return false
  orders.value = res.filter((o) => ['CONFIRMED', 'PARTIAL_DELIVERED'].includes(o.status))
  return true
}

async function onOrderChange() {
  const request = ++orderRequest, orderId = edit.orderId, saved = context()
  edit.lines = []
  edit.loadingOrder = !!orderId
  if (!orderId) return false
  try {
    const progress = await http.get<{ order: Row }>(`/pur/orders/${orderId}/progress`)
    if (request !== orderRequest || edit.orderId !== orderId || !currentContext(saved)) return false
    const o = progress.order
    edit.lines = o.lines.map((l: Row) => ({ orderLineId: l.id, lineNo: l.lineNo, productCode: l.productCode, productName: l.productName, undeliveredQty: l.undeliveredQty, qualifiedQty: 0, pendingInspectQty: 0, damagedQty: 0 }))
    orders.value = orders.value.map(row => row.id === o.id ? { ...row, supplierName: o.supplierName } : row)
    return true
  } finally {
    if (request === orderRequest) edit.loadingOrder = false
  }
}

async function openCreate() {
  const request = ++editRequest
  ++orderRequest
  edit.visible = false
  if (!await loadOrders() || request !== editRequest) return
  supplyCommandIntent.reset()
  Object.assign(edit, { visible: true, id: 0, version: 0, orderId: queryOrderId, receiptDate: todayIn(country.timezone), location: '', remark: '', lines: [], loadingOrder: false })
  if (edit.orderId) await onOrderChange()
}

async function openEdit(r: Row) {
  const request = ++editRequest
  ++orderRequest
  edit.visible = false
  if (!await loadOrders() || request !== editRequest) return
  Object.assign(edit, { visible: true, id: r.id, version: r.version, orderId: r.orderId, receiptDate: r.receiptDate, location: r.location, remark: r.remark, lines: [], loadingOrder: false })
  if (!await onOrderChange() || request !== editRequest) return
  for (const l of edit.lines) {
    const old = r.lines.find((x: Row) => x.orderLineId === l.orderLineId)
    if (old) Object.assign(l, { qualifiedQty: old.qualifiedQty, pendingInspectQty: old.pendingInspectQty, damagedQty: old.damagedQty })
  }
}

const overLine = (l: Row) => l.qualifiedQty + l.pendingInspectQty > l.undeliveredQty

async function save(confirm: boolean) {
  if (edit.saving) return
  if (edit.loadingOrder) return ElMessage.warning('正在读取采购行，请稍后重试')
  if (!edit.orderId) return ElMessage.warning('请选择采购单')
  if (!edit.lines.length) return ElMessage.warning('请选择有效采购行')
  if (edit.lines.some(overLine)) return ElMessage.warning('合格 + 待检不能超过未交数量')
  edit.saving = true
  try {
    const body = { orderId: edit.orderId, receiptDate: edit.receiptDate, location: edit.location, remark: edit.remark, lines: edit.lines, version: edit.version }
    if (edit.id) {
      await http.put(`/pur/domestic-receipts/${edit.id}`, body)
      if (confirm) await http.postIdem(`/pur/domestic-receipts/${edit.id}/confirm`, undefined, supplyCommandIntent)
    } else {
      await http.postIdem('/pur/domestic-receipts', { ...body, confirm }, supplyCommandIntent)
    }
    ElMessage.success(confirm ? '已确认，采购行进度已更新' : '已保存草稿')
    edit.visible = false
    page.value?.reload()
  } finally {
    edit.saving = false
  }
}

async function confirmReceipt(r: Row) {
  await confirmAction(`确认收货 ${r.docNo}？确认后回写采购单行进度（不进入库存）。`, () => http.postIdem(`/pur/domestic-receipts/${r.id}/confirm`, undefined, supplyCommandIntent), { success: '已确认' })
  page.value?.reload()
}

async function voidReceipt(r: Row) {
  await confirmAction(`作废 ${r.docNo}？${r.status === 'CONFIRMED' ? '已确认的收货作废后回退采购行进度；已被出口引用的不能作废。' : ''}`, () => http.postIdem(`/pur/domestic-receipts/${r.id}/void`, undefined, supplyCommandIntent), { success: '已作废' })
  page.value?.reload()
}

// ---------- 详情与待检转换 ----------
const detail = ref<Row | null>(null)
const detailVisible = ref(false)
async function openDetail(r: Row) {
  detail.value = await http.get<Row>(`/pur/domestic-receipts/${r.id}`)
  detailVisible.value = true
}

const conv = reactive({ visible: false, line: null as Row | null, toQualifiedQty: 0, toDamagedQty: 0, remark: '', saving: false })
function openConvert(l: Row) {
  Object.assign(conv, { visible: true, line: l, toQualifiedQty: l.remainingPendingQty, toDamagedQty: 0, remark: '' })
}
const convOver = computed(() => conv.toQualifiedQty + conv.toDamagedQty > (conv.line?.remainingPendingQty ?? 0))
async function submitConvert() {
  if (convOver.value) return ElMessage.warning('转换数量不能超过剩余待检')
  conv.saving = true
  try {
    detail.value = await http.postIdem<Row>(`/pur/domestic-receipts/lines/${conv.line!.id}/convert`, { toQualifiedQty: conv.toQualifiedQty, toDamagedQty: conv.toDamagedQty, remark: conv.remark }, supplyCommandIntent)
    ElMessage.success('已转换，采购行进度已更新')
    conv.visible = false
    page.value?.reload()
  } finally {
    conv.saving = false
  }
}
</script>

<template>
  <CrudPage
    ref="page"
    title="国内收货"
    resource="/pur/domestic-receipts"
    :columns="columns"
    :search-fields="searchFields"
    :default-query="defaultQuery"
    :can-create="false"
    :can-toggle="false"
    audit-type="domestic-receipt"
    :actions-width="220"
  >
    <template #toolbar>
      <el-button v-if="user.hasPerm('pur:receipt:create')" type="primary" @click="openCreate"><el-icon><Plus /></el-icon>登记收货</el-button>
    </template>
    <template #header>
      <el-alert type="info" :closable="false" show-icon title="国内收货只登记合格、待检、破损数量并回写采购单进度，不进入任何库存台账；运营库存在目的地实收后才增加。" class="mb" />
    </template>
    <template #col-docNo="{ row }"><el-link type="primary" @click="openDetail(row)">{{ row.docNo }}</el-link></template>
    <template #col-qty="{ row }"><span class="mono">{{ row.totalQualified }} / {{ row.totalPending }} / {{ row.totalDamaged }}</span></template>
    <template #row-actions="{ row }">
      <el-button link @click="openDetail(row)">详情</el-button>
      <el-button v-if="row.status === 'DRAFT' && user.hasPerm('pur:receipt:create')" link type="primary" @click="openEdit(row)">编辑</el-button>
      <el-button v-if="row.status === 'DRAFT' && user.hasPerm('pur:receipt:confirm')" link type="success" @click="confirmReceipt(row)">确认</el-button>
      <el-button v-if="row.status !== 'VOIDED' && user.hasPerm('pur:receipt:confirm')" link type="danger" @click="voidReceipt(row)">作废</el-button>
    </template>
  </CrudPage>

  <el-dialog v-model="edit.visible" :title="edit.id ? '编辑国内收货' : '登记国内收货'" width="860px" append-to-body destroy-on-close class="crud-dialog">
    <el-form label-width="90px">
      <el-row :gutter="12">
        <el-col :xs="24" :span="12">
          <el-form-item label="采购单" required>
            <el-select v-model="edit.orderId" filterable :disabled="!!edit.id" style="width: 100%" placeholder="已确认或部分交付的采购单" @change="onOrderChange">
              <el-option v-for="o in orders" :key="o.id" :label="orderLabel(o)" :value="o.id" />
            </el-select>
          </el-form-item>
        </el-col>
        <el-col :xs="12" :span="6">
          <el-form-item label="收货日期"><el-date-picker v-model="edit.receiptDate" type="date" value-format="YYYY-MM-DD" style="width: 100%" /></el-form-item>
        </el-col>
        <el-col :xs="12" :span="6">
          <el-form-item label="地点"><el-input v-model="edit.location" placeholder="集货仓 / 工厂" /></el-form-item>
        </el-col>
      </el-row>
    </el-form>
    <div class="table-scroll">
      <el-table v-loading="edit.loadingOrder" :data="edit.lines" border size="small" empty-text="请选择采购单">
        <el-table-column prop="lineNo" label="#" width="44" />
        <el-table-column label="商品" min-width="180"><template #default="{ row }"><ProductCell :code="row.productCode" :name="row.productName" /></template></el-table-column>
        <el-table-column prop="undeliveredQty" label="未交" width="70" align="right" />
        <el-table-column label="合格" width="110"><template #default="{ row }"><el-input-number v-model="row.qualifiedQty" :min="0" :controls="false" style="width: 100%" /></template></el-table-column>
        <el-table-column label="待检" width="110"><template #default="{ row }"><el-input-number v-model="row.pendingInspectQty" :min="0" :controls="false" style="width: 100%" /></template></el-table-column>
        <el-table-column label="破损" width="110"><template #default="{ row }"><el-input-number v-model="row.damagedQty" :min="0" :controls="false" style="width: 100%" /></template></el-table-column>
        <el-table-column width="90">
          <template #default="{ row }"><el-tag v-if="overLine(row)" type="danger" size="small">超出未交</el-tag></template>
        </el-table-column>
      </el-table>
    </div>
    <el-input v-model="edit.remark" class="mt" placeholder="备注" />
    <p class="muted">合格 + 待检不能超过未交；破损单独登记，不抵减未交，可以继续向供应商要求补货。</p>
    <template #footer>
      <el-button @click="edit.visible = false">取消</el-button>
      <el-button :loading="edit.saving" :disabled="edit.loadingOrder" @click="save(false)">保存草稿</el-button>
      <el-button v-if="user.hasPerm('pur:receipt:confirm')" type="primary" :loading="edit.saving" :disabled="edit.loadingOrder" @click="save(true)">保存并确认</el-button>
    </template>
  </el-dialog>

  <el-drawer v-model="detailVisible" :title="detail?.docNo" size="720px" destroy-on-close>
    <template v-if="detail">
      <el-descriptions :column="2" border size="small">
        <el-descriptions-item label="采购单">{{ detail.orderNo }}</el-descriptions-item>
        <el-descriptions-item label="状态"><StatusTag :status="detail.status" /></el-descriptions-item>
        <el-descriptions-item label="供应商">{{ detail.supplierName }}</el-descriptions-item>
        <el-descriptions-item label="收货日期">{{ detail.receiptDate }}</el-descriptions-item>
        <el-descriptions-item label="地点">{{ detail.location || '-' }}</el-descriptions-item>
        <el-descriptions-item label="登记人">{{ detail.createdByName }}</el-descriptions-item>
      </el-descriptions>
      <h4>明细</h4>
      <el-table :data="detail.lines" border size="small">
        <el-table-column label="商品" min-width="160"><template #default="{ row }"><ProductCell :code="row.productCode" :name="row.productName" /></template></el-table-column>
        <el-table-column prop="qualifiedQty" label="合格" width="60" align="right" />
        <el-table-column prop="pendingInspectQty" label="待检" width="60" align="right" />
        <el-table-column prop="damagedQty" label="破损" width="60" align="right" />
        <el-table-column label="待检转换" width="100" align="right">
          <template #default="{ row }">
            <span v-if="row.convertedQualifiedQty + row.convertedDamagedQty">合格 {{ row.convertedQualifiedQty }} / 破损 {{ row.convertedDamagedQty }}</span>
            <span v-else class="muted">-</span>
          </template>
        </el-table-column>
        <el-table-column prop="exportableQty" label="可出口" width="70" align="right" />
        <el-table-column width="90">
          <template #default="{ row }">
            <el-button v-if="detail.status === 'CONFIRMED' && row.remainingPendingQty > 0 && user.hasPerm('pur:receipt:confirm')" link type="primary" @click="openConvert(row)">
              检验 {{ row.remainingPendingQty }}
            </el-button>
          </template>
        </el-table-column>
      </el-table>
      <template v-if="detail.converts?.length">
        <h4>检验记录</h4>
        <el-timeline>
          <el-timeline-item v-for="c in detail.converts" :key="c.id" :timestamp="c.convertedAt">
            {{ c.productCode }}：转合格 {{ c.toQualifiedQty }}，转破损 {{ c.toDamagedQty }} · {{ c.convertedByName }} <span class="muted">{{ c.remark }}</span>
          </el-timeline-item>
        </el-timeline>
      </template>
      <h4>附件（装箱单、检验报告）</h4>
      <DocAttachment biz-type="DOMESTIC_RECEIPT" :biz-id="detail.id" category="PURCHASE_DOC" />
      <p class="muted">确认时间：<DateTimeText :value="detail.confirmedAt" /></p>
    </template>
  </el-drawer>

  <el-dialog v-model="conv.visible" title="待检转换" width="440px" append-to-body>
    <p>{{ conv.line?.productCode }} {{ conv.line?.productName }}：剩余待检 <b>{{ conv.line?.remainingPendingQty }}</b></p>
    <el-form label-width="80px">
      <el-form-item label="转合格"><el-input-number v-model="conv.toQualifiedQty" :min="0" /></el-form-item>
      <el-form-item label="转破损"><el-input-number v-model="conv.toDamagedQty" :min="0" /></el-form-item>
      <el-form-item label="说明"><el-input v-model="conv.remark" placeholder="检验结论" /></el-form-item>
    </el-form>
    <el-alert v-if="convOver" type="error" :closable="false" title="转换数量超过剩余待检" />
    <template #footer>
      <el-button @click="conv.visible = false">取消</el-button>
      <el-button type="primary" :loading="conv.saving" @click="submitConvert">确定</el-button>
    </template>
  </el-dialog>
</template>

<style scoped>
.mb {
  margin-bottom: 12px;
}

.mt {
  margin-top: 10px;
}
</style>
