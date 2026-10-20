<script setup lang="ts">
import { reactive, ref } from 'vue'
import { ElMessage } from 'element-plus'
import { http, createCommandIntent } from '@/api/http'
import { allRecords } from '@/api/pagination'
import { useUserStore } from '@/stores/user'
import CrudPage from '@/components/crud/CrudPage.vue'
import MoneyText from '@/components/MoneyText.vue'
import ProductCell from '@/components/biz/ProductCell.vue'
import ApprovalPanel from '@/components/ApprovalPanel.vue'
import type { ColumnDef, CrudPageExpose, FieldDef } from '@/components/crud/types'
import { RESPONSIBILITY, RETURN_REASONS, RETURN_STATUS } from '@/modules/shared/bizOptions'

const createIntent = createCommandIntent()

type Row = Record<string, any> // eslint-disable-line @typescript-eslint/no-explicit-any
const user = useUserStore()
const page = ref<CrudPageExpose>()
const outbounds = ref<Row[]>([])
const warehouses = ref<Row[]>([])
const returnable = ref<Row[]>([])
const detail = ref<Row | null>(null)
const form = reactive({ visible: false, saving: false, outboundId: undefined as number | undefined, returnWarehouseId: undefined as number | undefined, reasonCode: 'QUALITY', responsibility: 'CUSTOMER', qty: {} as Record<number, number> })
const step = reactive({ visible: false, received: {} as Record<number, number>, good: {} as Record<number, number>, frozen: {} as Record<number, number>, shortReason: '', freezeType: 'RETURN_PENDING', key: createCommandIntent() })
const columns: ColumnDef[] = [
  { prop: 'docNo', label: '退货单', width: 180 },
  { prop: 'customerName', label: '客户', minWidth: 140 },
  { prop: 'orderNo', label: '订单', width: 170 },
  { prop: 'outboundNo', label: '出库单', width: 170 },
  { prop: 'status', label: '状态', type: 'status', width: 110 },
  { prop: 'settleAmount', label: '退货金额', width: 120 },
]
const searchFields: FieldDef[] = [{ prop: 'status', label: '状态', type: 'select', options: RETURN_STATUS }]

async function open() {
  createIntent.reset()
  const listed = await allRecords<Row>('/sal/outbounds')
  outbounds.value = listed.filter((o) => ['OUTBOUNDED', 'SIGNED', 'PARTIAL_SIGNED', 'DIFF_PENDING'].includes(o.status))
  warehouses.value = await allRecords<Row>('/org/warehouses', { status: 'ENABLED' })
  Object.assign(form, { visible: true, outboundId: undefined, returnWarehouseId: warehouses.value[0]?.id, reasonCode: 'QUALITY', responsibility: 'CUSTOMER', qty: {} })
}
async function loadReturnable() {
  if (!form.outboundId) return
  returnable.value = await http.get('/rtn/sales/returnable', { outboundId: form.outboundId })
  form.qty = Object.fromEntries(returnable.value.map((l) => [l.outboundLineId, 0]))
}
async function save() {
  form.saving = true
  try {
    await http.postIdem('/rtn/sales', {
      outboundId: form.outboundId, returnWarehouseId: form.returnWarehouseId, reasonCode: form.reasonCode, responsibility: form.responsibility, submit: true,
      lines: Object.entries(form.qty).filter(([, q]) => Number(q) > 0).map(([outboundLineId, reqQty]) => ({ outboundLineId: Number(outboundLineId), reqQty })),
    }, createIntent)
    ElMessage.success('已提交审批')
    form.visible = false
    page.value?.reload()
  } finally {
    form.saving = false
  }
}
async function openStep(row: Row) {
  detail.value = await http.get(`/rtn/sales/${row.id}`)
  const lines = detail.value?.lines ?? []
  Object.assign(step, {
    visible: true, key: createCommandIntent(), shortReason: '', freezeType: 'RETURN_PENDING',
    received: Object.fromEntries(lines.map((l: Row) => [l.id, Math.max(0, Number(l.reqQty) - Number(l.receivedQty))])),
    good: Object.fromEntries(lines.map((l: Row) => [l.id, Math.max(0, Number(l.receivedQty) - Number(l.inspectedQty || 0))])),
    frozen: Object.fromEntries(lines.map((l: Row) => [l.id, 0])),
  })
}
async function act(path: string, body: Row) {
  detail.value = await http.postIdem(`/rtn/sales/${detail.value!.id}/${path}`, body, step.key)
  if (path === 'receive') {
    step.good = Object.fromEntries((detail.value?.lines ?? []).map((l: Row) => [l.id, Math.max(0, Number(l.receivedQty) - Number(l.inspectedQty || 0))]))
    step.frozen = Object.fromEntries((detail.value?.lines ?? []).map((l: Row) => [l.id, 0]))
  }
  ElMessage.success('已保存')
  step.key = createCommandIntent()
  page.value?.reload()
}
function receive() {
  return act('receive', { shortReason: step.shortReason, lines: (detail.value?.lines ?? []).filter((l: Row) => Number(step.received[l.id]) > 0).map((l: Row) => ({ id: l.id, receivedQty: Number(l.receivedQty) + Number(step.received[l.id]) })) })
}
function inspect() {
  return act('inspect', { lines: (detail.value?.lines ?? []).map((l: Row) => ({ id: l.id, goodQty: Number(l.goodQty || 0) + Number(step.good[l.id]), frozenQty: Number(l.frozenQty || 0) + Number(step.frozen[l.id]), freezeType: step.freezeType })) })
}
function settle() {
  return act('settle', { shortReason: step.shortReason })
}
</script>

<template>
  <CrudPage ref="page" title="销售退货" resource="/rtn/sales" :columns="columns" :search-fields="searchFields" :can-create="false" :can-toggle="false" :actions-width="120">
    <template #toolbar><el-button v-if="user.hasPerm('rtn:sales:create')" type="primary" @click="open">申请退货</el-button></template>
    <template #header><p class="muted">退货价用原成交价。实收、验货之后才动库存；账款处理只做一次，先冲应收，剩下的才能退款。</p></template>
    <template #col-settleAmount="{ row }"><MoneyText v-if="row.settleAmount" :value="row.settleAmount" :currency="row.currency" /><span v-else>-</span></template>
    <template #row-actions="{ row }"><el-button link type="primary" @click="openStep(row)">处理</el-button></template>
  </CrudPage>

  <el-dialog v-model="form.visible" title="销售退货" width="680px">
    <el-form label-width="88px">
      <el-form-item label="出库单"><el-select v-model="form.outboundId" filterable style="width:100%" @change="loadReturnable"><el-option v-for="o in outbounds" :key="o.id" :label="`${o.docNo} ${o.customerName}`" :value="o.id" /></el-select></el-form-item>
      <el-form-item label="退回仓"><el-select v-model="form.returnWarehouseId" style="width:100%"><el-option v-for="w in warehouses" :key="w.id" :label="w.name" :value="w.id" /></el-select></el-form-item>
      <el-form-item label="原因"><el-select v-model="form.reasonCode"><el-option v-for="r in RETURN_REASONS" :key="String(r.value)" :label="r.label" :value="r.value" /></el-select></el-form-item>
      <el-form-item label="责任方"><el-select v-model="form.responsibility"><el-option v-for="r in RESPONSIBILITY" :key="String(r.value)" :label="r.label" :value="r.value" /></el-select></el-form-item>
    </el-form>
    <el-table :data="returnable" size="small">
      <el-table-column label="商品" min-width="160"><template #default="{ row }"><ProductCell :code="row.productCode" :name="row.productName" /></template></el-table-column>
      <el-table-column prop="returnableQty" label="可退" width="80" />
      <el-table-column label="原价" width="100"><template #default="{ row }"><MoneyText :value="row.originPrice" :currency="row.currency" /></template></el-table-column>
      <el-table-column label="本次" width="140"><template #default="{ row }"><el-input-number v-model="form.qty[row.outboundLineId]" :min="0" :max="row.returnableQty" controls-position="right" /></template></el-table-column>
    </el-table>
    <template #footer>
      <el-button @click="form.visible = false">取消</el-button>
      <el-button type="primary" :loading="form.saving" @click="save">提交</el-button>
    </template>
  </el-dialog>

  <el-drawer v-model="step.visible" :title="detail?.docNo" size="520px">
    <p>状态：{{ detail?.status }}　可退款 {{ detail?.refundableAmount ?? '-' }}</p>
    <el-table :data="detail?.lines ?? []" size="small">
      <el-table-column label="商品"><template #default="{ row }"><ProductCell :code="row.productCode" :name="row.productName" /></template></el-table-column>
      <el-table-column prop="reqQty" label="申请" width="70" />
      <el-table-column label="本次实收" width="120"><template #default="{ row }"><el-input-number v-model="step.received[row.id]" :min="0" :max="Math.max(0, Number(row.reqQty) - Number(row.receivedQty))" size="small" controls-position="right" /></template></el-table-column>
      <el-table-column label="本次合格" width="110"><template #default="{ row }"><el-input-number v-model="step.good[row.id]" :min="0" size="small" controls-position="right" /></template></el-table-column>
      <el-table-column label="本次冻结" width="110"><template #default="{ row }"><el-input-number v-model="step.frozen[row.id]" :min="0" size="small" controls-position="right" /></template></el-table-column>
    </el-table>
    <el-form class="mt" label-width="88px">
      <el-form-item v-if="['PENDING_RECEIPT', 'PENDING_SETTLE'].includes(detail?.status)" label="少收原因"><el-input v-model="step.shortReason" placeholder="实收少于申请时必填" /></el-form-item>
      <el-form-item v-if="detail?.status === 'PENDING_INSPECT'" label="冻结原因"><el-select v-model="step.freezeType"><el-option label="待检" value="RETURN_PENDING" /><el-option label="破损" value="DAMAGED" /></el-select></el-form-item>
    </el-form>
    <div class="mt">
      <el-button v-if="['PENDING_RECEIPT', 'PENDING_SETTLE'].includes(detail?.status) && (detail?.lines ?? []).some((l: Row) => Number(l.reqQty) > Number(l.receivedQty)) && user.hasPerm('rtn:sales:receive')" type="primary" @click="receive">确认实收</el-button>
      <el-button v-if="detail?.status === 'PENDING_INSPECT' && user.hasPerm('rtn:sales:inspect')" type="primary" @click="inspect">验货入库</el-button>
      <el-button v-if="detail?.status === 'PENDING_SETTLE' && user.hasPerm('rtn:sales:settle')" type="primary" @click="settle">处理账款</el-button>
    </div>
    <ApprovalPanel v-if="detail" class="mt" doc-type="SALES_RETURN" :doc-id="detail.id" />
  </el-drawer>
</template>

<style scoped>
.mt { margin-top: 12px; }
</style>
