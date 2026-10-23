<script setup lang="ts">
import { ref } from 'vue'
import { useRouter } from 'vue-router'
import { http, createCommandIntent } from '@/api/http'
import { useUserStore } from '@/stores/user'
import CrudPage from '@/components/crud/CrudPage.vue'
import MoneyText from '@/components/MoneyText.vue'
import type { ColumnDef, CrudPageExpose, FieldDef } from '@/components/crud/types'
import { PO_STATUS, PRODUCT_SOURCE, SUPPLIER_SOURCE } from '@/modules/shared/bizOptions'
import { confirmAction } from '@/utils/action'
import PurchaseOrderForm from './PurchaseOrderForm.vue'
import './purchase-order.scss'

const supplyCommandIntent = createCommandIntent()


interface Order {
  id: number
  docNo: string
  status: string
  version: number
  supplierName: string
  currency: string
  totalAmount?: number
  totalQty: number
  deliveredQty: number
  shippedQty: number
  arrivedMxQty: number
  costHidden: boolean
  lines: { qualifiedQty: number; pendingInspectQty: number }[]
}

const router = useRouter()
const user = useUserStore()
const page = ref<CrudPageExpose>()
const form = ref<InstanceType<typeof PurchaseOrderForm>>()

const columns: ColumnDef[] = [
  { prop: 'docNo', label: '采购单号', width: 185, fixed: 'left' },
  { prop: 'supplierName', label: '供应商', minWidth: 170 },
  { prop: 'orderDate', label: '下单日期', type: 'date', width: 112 },
  { prop: 'productSummary', label: '商品', minWidth: 130 },
  { prop: 'totalAmount', label: '金额', type: 'money', currencyProp: 'currency', width: 150 },
  { prop: 'progress', label: '订购 / 国内已交 / 已发运 / 目的地实收', minWidth: 230 },
  { prop: 'status', label: '状态', type: 'status', width: 95 },
  { prop: 'createdByName', label: '创建人', width: 120 },
]

const searchFields: FieldDef[] = [
  { prop: 'keyword', label: '单号' },
  { prop: 'status', label: '状态', type: 'select', options: PO_STATUS },
  { prop: 'supplierId', label: '供应商', type: 'select', options: SUPPLIER_SOURCE },
  { prop: 'productId', label: '商品', type: 'select', options: PRODUCT_SOURCE },
]

const delivered = (o: Order) => o.lines.some((l) => l.qualifiedQty + l.pendingInspectQty > 0)
const editable = (o: Order) => o.status === 'DRAFT' || (o.status === 'CONFIRMED' && !delivered(o))

async function submit(o: Order) {
  await confirmAction(`提交采购单 ${o.docNo}？提交后按审批规则流转，无匹配规则时直接确认。`, async () => {
    await http.postIdem(`/pur/orders/${o.id}/submit`, undefined, supplyCommandIntent)
  }, { success: '已提交' })
  page.value?.reload()
}

async function voidOrder(o: Order) {
  await confirmAction(`作废草稿 ${o.docNo}？`, () => http.postIdem(`/pur/orders/${o.id}/void`, undefined, supplyCommandIntent), { success: '已作废' })
  page.value?.reload()
}

function onSaved(o: { id: number }) {
  page.value?.reload()
  router.push(`/purchase/orders/${o.id}`)
}
</script>

<template>
  <CrudPage
    ref="page"
    class="purchase-order-list"
    title="采购单"
    resource="/pur/orders"
    :columns="columns"
    :search-fields="searchFields"
    :can-create="false"
    :can-toggle="false"
    audit-type="purchase-order"
    :actions-width="220"
  >
    <template #toolbar>
      <el-button v-if="user.hasPerm('pur:order:create')" type="primary" @click="form?.open()">
        <el-icon><Plus /></el-icon>新建采购单
      </el-button>
    </template>
    <template #header>
      <p class="muted purchase-list-note">采购单按供应商币种（通常 CNY）下单；国内收货不进入任何库存，运营库存只在目的地实收后增加。</p>
    </template>
    <template #col-docNo="{ row }">
      <el-link type="primary" @click="router.push(`/purchase/orders/${row.id}`)">{{ row.docNo }}</el-link>
    </template>
    <template #col-totalAmount="{ row }">
      <span v-if="row.costHidden" class="muted">无权查看</span>
      <MoneyText v-else :value="row.totalAmount" :currency="row.currency" />
    </template>
    <template #col-progress="{ row }">
      <span class="mono">{{ row.totalQty }} / {{ row.deliveredQty }} / {{ row.shippedQty }} / {{ row.arrivedMxQty }}</span>
    </template>
    <template #row-actions="{ row }">
      <el-button link type="primary" @click="router.push(`/purchase/orders/${row.id}`)">查看</el-button>
      <template v-if="user.hasPerm(['pur:order:edit', 'pur:order:create']) && editable(row)">
        <el-button link type="primary" @click="form?.open(row.id)">编辑</el-button>
      </template>
      <el-button v-if="row.status === 'DRAFT' && user.hasPerm('pur:order:submit')" link type="success" @click="submit(row)">提交</el-button>
      <el-button v-if="row.status === 'DRAFT' && user.hasPerm('pur:order:cancel')" link type="danger" @click="voidOrder(row)">作废</el-button>
    </template>
  </CrudPage>
  <PurchaseOrderForm ref="form" @saved="onSaved" />
</template>

<style scoped>
.purchase-order-list {
  min-width: 0;
}

.purchase-order-list :deep(.page-title) {
  flex-wrap: wrap;
  gap: 8px;
  margin-bottom: 8px;
}

.purchase-order-list :deep(.page-title > .toolbar) {
  margin-bottom: 0;
}

.purchase-list-note {
  margin: 0 0 12px;
  line-height: 20px;
}

.purchase-order-list :deep(.search-form) {
  display: flex;
  flex-wrap: wrap;
  gap: 0 12px;
}

.purchase-order-list :deep(.search-form .el-form-item) {
  margin-right: 0;
  margin-bottom: 8px;
}

@media (max-width: 768px) {
  .purchase-order-list :deep(.search-form .el-form-item__content > div) {
    width: 100% !important;
  }
}
</style>
