<script setup lang="ts">
import { ref } from 'vue'
import { useRoute, useRouter } from 'vue-router'
import { http, createCommandIntent } from '@/api/http'
import { useUserStore } from '@/stores/user'
import CrudPage from '@/components/crud/CrudPage.vue'
import type { ColumnDef, CrudPageExpose, FieldDef } from '@/components/crud/types'
import { DELIVERY_STATUS, MX_WAREHOUSE_SOURCE } from '@/modules/shared/bizOptions'
import { confirmAction, queryDefaults } from '@/utils/action'
import { openReceiptFor } from './receipt'

const supplyCommandIntent = createCommandIntent()


type Row = Record<string, any> // eslint-disable-line @typescript-eslint/no-explicit-any

const route = useRoute()
const router = useRouter()
const user = useUserStore()
const page = ref<CrudPageExpose>()

const columns: ColumnDef[] = [
  { prop: 'docNo', label: '派送单', width: 185, fixed: 'left' },
  { prop: 'shipmentNo', label: '运输批次', width: 185 },
  { prop: 'warehouseName', label: '目的仓', width: 130 },
  { prop: 'vehicle', label: '车辆 / 司机', minWidth: 150 },
  { prop: 'lines', label: '商品', minWidth: 170 },
  { prop: 'qty', label: '派送 / 已实收', width: 110 },
  { prop: 'dispatchedAt', label: '出发时间', type: 'datetime', width: 170 },
  { prop: 'status', label: '状态', type: 'status', width: 100 },
  { prop: 'receiptNo', label: '实收单', width: 185 },
]
const searchFields: FieldDef[] = [
  { prop: 'keyword', label: '单号 / 批次 / 车辆' },
  { prop: 'status', label: '状态', type: 'select', options: DELIVERY_STATUS },
  { prop: 'destWarehouseId', label: '目的仓', type: 'select', options: MX_WAREHOUSE_SOURCE },
]

async function dispatch(d: Row) {
  await confirmAction(`派送单 ${d.docNo} 出发？数量从当地待派送转为派送在途，目的仓收到待实收待办。`, () => http.postIdem(`/lgs/deliveries/${d.id}/dispatch`, {}, supplyCommandIntent), { success: '已出发' })
  page.value?.reload()
}
async function voidDelivery(d: Row) {
  await confirmAction(`作废草稿派送单 ${d.docNo}？`, () => http.postIdem(`/lgs/deliveries/${d.id}/void`, undefined, supplyCommandIntent), { success: '已作废', type: 'warning' })
  page.value?.reload()
}
</script>

<template>
  <CrudPage
    ref="page"
    title="派送单"
    resource="/lgs/deliveries"
    :columns="columns"
    :search-fields="searchFields"
    :default-query="queryDefaults(route.query)"
    :can-create="false"
    :can-toggle="false"
    :actions-width="160"
  >
    <template #header>
      <p class="muted">派送单在运输批次详情中创建（批次放行或换柜后）。出发后由目的仓扫码实收；仓库操作员只能看到自己仓库的派送单。</p>
    </template>
    <template #col-shipmentNo="{ row }">
      <el-link v-if="user.hasPerm('lgs:shipment:view')" type="primary" @click="router.push(`/logistics/shipments/${row.shipmentId}`)">{{ row.shipmentNo }}</el-link>
      <span v-else class="mono">{{ row.shipmentNo }}</span>
    </template>
    <template #col-vehicle="{ row }">{{ row.vehicle || '-' }} / {{ row.driver || '-' }}</template>
    <template #col-lines="{ row }">
      <div v-for="l in row.lines" :key="l.id">{{ l.productCode }} × {{ l.dispatchQty }}</div>
    </template>
    <template #col-qty="{ row }"><span class="mono">{{ row.totalQty }} / {{ row.receivedQty }}</span></template>
    <template #col-receiptNo="{ row }">
      <el-link v-if="row.receiptId" type="primary" @click="router.push(`/logistics/receipts/${row.receiptId}`)">{{ row.receiptNo }}</el-link>
      <span v-else class="muted">-</span>
    </template>
    <template #row-actions="{ row }">
      <template v-if="row.status === 'DRAFT'">
        <el-button v-if="user.hasPerm('lgs:delivery:dispatch')" link type="primary" @click="dispatch(row)">出发</el-button>
        <el-button v-if="user.hasPerm('lgs:delivery:create')" link type="danger" @click="voidDelivery(row)">作废</el-button>
      </template>
      <el-button v-if="row.status === 'DISPATCHED' && row.receiptStatus !== 'CONFIRMED' && user.hasPerm('lgs:receipt:confirm')" link type="primary" @click="openReceiptFor(router, row.id)">
        {{ row.receiptId ? '继续实收' : '去实收' }}
      </el-button>
    </template>
  </CrudPage>
</template>
