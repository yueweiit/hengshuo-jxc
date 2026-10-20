<script setup lang="ts">
import { reactive, ref } from 'vue'
import { useRouter } from 'vue-router'
import { ElMessage } from 'element-plus'
import { http, createCommandIntent } from '@/api/http'
import { useUserStore } from '@/stores/user'
import CrudPage from '@/components/crud/CrudPage.vue'
import MoneyText from '@/components/MoneyText.vue'
import ProductCell from '@/components/biz/ProductCell.vue'
import type { ColumnDef, CrudPageExpose, FieldDef } from '@/components/crud/types'
import { ALL_WAREHOUSE_SOURCE } from '@/modules/shared/bizOptions'

const supplyCommandIntent = createCommandIntent()


const actionIntent = createCommandIntent()

type Row = Record<string, any> // eslint-disable-line @typescript-eslint/no-explicit-any

const router = useRouter()
const user = useUserStore()
const page = ref<CrudPageExpose>()
const sign = reactive({ visible: false, row: null as Row | null, signerName: '', qty: {} as Record<number, number>, saving: false })

const columns: ColumnDef[] = [
  { prop: 'docNo', label: '出库单', width: 180 },
  { prop: 'orderNo', label: '订单', width: 180 },
  { prop: 'customerName', label: '客户', minWidth: 150 },
  { prop: 'warehouseName', label: '仓库', width: 140 },
  { prop: 'totalQty', label: '数量', type: 'qty', width: 90 },
  { prop: 'totalAmount', label: '金额', type: 'money', currencyProp: 'currency', width: 130 },
  { prop: 'status', label: '状态', type: 'status', width: 110 },
  { prop: 'bizDate', label: '业务日', type: 'date', width: 110 },
]
const searchFields: FieldDef[] = [
  { prop: 'status', label: '状态', type: 'select', options: [{ label: '草稿', value: 'DRAFT' }, { label: '已出库', value: 'OUTBOUNDED' }, { label: '已签收', value: 'SIGNED' }, { label: '签收差异', value: 'DIFF_PENDING' }] },
  { prop: 'warehouseId', label: '仓库', type: 'select', options: ALL_WAREHOUSE_SOURCE },
]

async function confirm(row: Row) {
  await http.postIdem(`/sal/outbounds/${row.id}/confirm`, {}, actionIntent)
  ElMessage.success('已确认出库')
  page.value?.reload()
}

function openSign(row: Row) {
  Object.assign(sign, { visible: true, row, signerName: '', qty: Object.fromEntries(row.lines.map((l: Row) => [l.id, l.qty])) })
}
async function saveSign() {
  if (!sign.signerName) return ElMessage.warning('请填写签收人')
  sign.saving = true
  try {
    await http.postIdem(`/sal/outbounds/${sign.row!.id}/sign`, {
      signerName: sign.signerName,
      lines: Object.entries(sign.qty).map(([outboundLineId, signedQty]) => ({ outboundLineId: Number(outboundLineId), signedQty, diffType: 'SHORT' })),
    }, supplyCommandIntent)
    ElMessage.success('已登记签收')
    sign.visible = false
    page.value?.reload()
  } finally {
    sign.saving = false
  }
}
</script>

<template>
  <CrudPage ref="page" title="出库任务" resource="/sal/outbounds" :columns="columns" :search-fields="searchFields" :can-create="false" :can-toggle="false" :actions-width="200">
    <template #header><p class="muted">仓库人员只能看到自己仓库的出库单。确认出库时才扣库存并生成应收，重复确认不会重复记账。</p></template>
    <template #col-orderNo="{ row }"><el-link type="primary" @click="router.push(`/sales/orders/${row.orderId}`)">{{ row.orderNo }}</el-link></template>
    <template #col-totalAmount="{ row }"><MoneyText :value="row.totalAmount" :currency="row.currency" /></template>
    <template #row-actions="{ row }">
      <el-button v-if="row.status === 'DRAFT' && user.hasPerm('sal:outbound:confirm')" link type="primary" @click="confirm(row)">确认出库</el-button>
      <el-button v-if="['OUTBOUNDED', 'PARTIAL_SIGNED'].includes(row.status) && user.hasPerm('sal:sign:record')" link type="primary" @click="openSign(row)">签收</el-button>
    </template>
  </CrudPage>
  <el-dialog v-model="sign.visible" title="签收" width="640px">
    <el-form label-width="88px"><el-form-item label="签收人"><el-input v-model="sign.signerName" /></el-form-item></el-form>
    <el-table :data="sign.row?.lines ?? []" size="small">
      <el-table-column label="商品" min-width="160"><template #default="{ row }"><ProductCell :code="row.productCode" :name="row.productName" /></template></el-table-column>
      <el-table-column label="出库（基础）" width="140"><template #default="{ row }">{{ row.qty }} {{ row.unit || '单位未记录' }}</template></el-table-column>
      <el-table-column label="实收" width="140"><template #default="{ row }"><el-input-number v-model="sign.qty[row.id]" :min="0" :max="row.qty" controls-position="right" /></template></el-table-column>
    </el-table>
    <template #footer>
      <el-button @click="sign.visible = false">取消</el-button>
      <el-button type="primary" :loading="sign.saving" @click="saveSign">登记</el-button>
    </template>
  </el-dialog>
</template>
