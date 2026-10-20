<script setup lang="ts">
import { reactive, ref } from 'vue'
import { ElMessage } from 'element-plus'
import { http, createCommandIntent } from '@/api/http'
import { allRecords } from '@/api/pagination'
import { useUserStore } from '@/stores/user'
import CrudPage from '@/components/crud/CrudPage.vue'
import ProductCell from '@/components/biz/ProductCell.vue'
import type { ColumnDef, CrudPageExpose } from '@/components/crud/types'

const actionIntent = createCommandIntent()

const createIntent = createCommandIntent()

type Row = Record<string, any> // eslint-disable-line @typescript-eslint/no-explicit-any
const user = useUserStore()
const page = ref<CrudPageExpose>()
const orders = ref<Row[]>([])
const warehouses = ref<Row[]>([])
const sources = ref<Row[]>([])
const form = reactive({ visible: false, saving: false, poId: undefined as number | undefined, stage: 'MX_STOCK', warehouseId: undefined as number | undefined, reason: '', qty: {} as Record<number, number> })
const columns: ColumnDef[] = [
  { prop: 'docNo', label: '退货单', width: 180 },
  { prop: 'supplierName', label: '供应商', minWidth: 150 },
  { prop: 'poNo', label: '采购单', width: 180 },
  { prop: 'stage', label: '阶段', width: 110 },
  { prop: 'currency', label: '币种', width: 70 },
  { prop: 'status', label: '状态', type: 'status', width: 120 },
]
const sourceKey = (s: Row) => Number(s.sourceLineId ?? s.batchId)
const visibleSources = () => sources.value.filter((s) => form.stage === 'DOMESTIC' || s.warehouseId === form.warehouseId)
async function loadSources() {
  form.qty = {}
  sources.value = form.poId ? await http.get<Row[]>('/rtn/purchase/returnable', { poId: form.poId, stage: form.stage }) : []
}
async function open() {
  createIntent.reset()
  orders.value = await allRecords<Row>('/pur/orders')
  warehouses.value = await allRecords<Row>('/org/warehouses', { status: 'ENABLED' })
  Object.assign(form, { visible: true, poId: undefined, stage: 'MX_STOCK', warehouseId: warehouses.value[0]?.id, reason: '', qty: {} })
  sources.value = []
}
async function save() {
  form.saving = true
  try {
    await http.postIdem('/rtn/purchase', {
      poId: form.poId, stage: form.stage, warehouseId: form.warehouseId, reason: form.reason, submit: true,
      lines: visibleSources().filter((l: Row) => form.qty[sourceKey(l)] > 0).map((l: Row) => ({ poLineId: l.poLineId, sourceLineId: l.sourceLineId, batchId: l.batchId, qty: form.qty[sourceKey(l)] })),
    }, createIntent)
    ElMessage.success('已提交采购退货')
    form.visible = false
    page.value?.reload()
  } finally {
    form.saving = false
  }
}
async function ship(row: Row) {
  await http.postIdem(`/rtn/purchase/${row.id}/ship`, {}, actionIntent)
  ElMessage.success(row.stage === 'MX_STOCK' ? '已退库并生成供应商贷项' : '已减少可发运数量并生成贷项')
  page.value?.reload()
}
</script>

<template>
  <CrudPage ref="page" title="采购退货" resource="/rtn/purchase" :columns="columns" :can-create="false" :can-toggle="false" :actions-width="100">
    <template #toolbar><el-button v-if="user.hasPerm('rtn:purchase:create')" type="primary" @click="open">新建</el-button></template>
    <template #header><p class="muted">国内未发运只减少可发运数量，不扣 MX 库存。已在墨西哥的货才做出库。贷项按原采购价。</p></template>
    <template #row-actions="{ row }">
      <el-button v-if="row.status === 'APPROVED' && user.hasPerm('rtn:purchase:ship')" link type="primary" @click="ship(row)">执行退货</el-button>
    </template>
  </CrudPage>
  <el-dialog v-model="form.visible" title="采购退货" width="640px">
    <el-form label-width="88px">
      <el-form-item label="采购单"><el-select v-model="form.poId" filterable style="width:100%" @change="loadSources"><el-option v-for="o in orders" :key="o.id" :label="`${o.docNo} ${o.supplierName || ''}`" :value="o.id" /></el-select></el-form-item>
      <el-form-item label="阶段"><el-radio-group v-model="form.stage" @change="loadSources"><el-radio-button value="DOMESTIC">国内未发运</el-radio-button><el-radio-button value="MX_STOCK">MX 库存</el-radio-button></el-radio-group></el-form-item>
      <el-form-item v-if="form.stage === 'MX_STOCK'" label="仓库"><el-select v-model="form.warehouseId"><el-option v-for="w in warehouses" :key="w.id" :label="w.name" :value="w.id" /></el-select></el-form-item>
      <el-form-item label="原因"><el-input v-model="form.reason" /></el-form-item>
    </el-form>
    <el-table :data="visibleSources()" size="small">
      <el-table-column label="商品"><template #default="{ row }"><ProductCell :code="row.productCode" :name="row.productName" /></template></el-table-column>
      <el-table-column prop="sourceNo" label="原收货/批次" min-width="130" />
      <el-table-column prop="returnableQty" label="可退" width="80" />
      <el-table-column label="退货" width="140"><template #default="{ row }"><el-input-number v-model="form.qty[sourceKey(row)]" :min="0" :max="row.returnableQty" controls-position="right" /></template></el-table-column>
    </el-table>
    <template #footer>
      <el-button @click="form.visible = false">取消</el-button>
      <el-button type="primary" :loading="form.saving" @click="save">提交</el-button>
    </template>
  </el-dialog>
</template>
