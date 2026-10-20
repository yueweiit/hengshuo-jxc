<script setup lang="ts">
import { useRouter } from 'vue-router'
import CrudPage from '@/components/crud/CrudPage.vue'
import MoneyText from '@/components/MoneyText.vue'
import type { ColumnDef, FieldDef } from '@/components/crud/types'
import { CUSTOMER_SOURCE, DUE_STATUS, AR_SETTLE_STATUS } from '@/modules/shared/bizOptions'

const router = useRouter()
const columns: ColumnDef[] = [
  { prop: 'docNo', label: '应收单', width: 180 },
  { prop: 'customerName', label: '客户', minWidth: 150 },
  { prop: 'orderNo', label: '订单', width: 180 },
  { prop: 'amount', label: '金额', width: 120 },
  { prop: 'openAmount', label: '未结', width: 120 },
  { prop: 'bizDate', label: '发生日', type: 'date', width: 110 },
  { prop: 'dueDate', label: '到期日', type: 'date', width: 110 },
  { prop: 'dueStatus', label: '到期', type: 'status', width: 100 },
  { prop: 'settleStatus', label: '结算', type: 'status', width: 100 },
]
const searchFields: FieldDef[] = [
  { prop: 'customerId', label: '客户', type: 'select', options: CUSTOMER_SOURCE },
  { prop: 'dueStatus', label: '到期', type: 'select', options: DUE_STATUS },
  { prop: 'settleStatus', label: '结算', type: 'select', options: AR_SETTLE_STATUS },
]
</script>

<template>
  <CrudPage title="应收与欠款" resource="/ar/receivables" :columns="columns" :search-fields="searchFields" :can-create="false" :can-toggle="false" :actions-width="100">
    <template #header><p class="muted">应收在出库时按本次出库金额产生。现款若已有确认收款，会自动核销，未结应为 0。</p></template>
    <template #col-customerName="{ row }"><el-link type="primary" @click="router.push(`/ar/customers/${row.customerId}`)">{{ row.customerName }}</el-link></template>
    <template #col-amount="{ row }"><MoneyText :value="row.amount" :currency="row.currency" /></template>
    <template #col-openAmount="{ row }"><MoneyText :value="row.openAmount" :currency="row.currency" /></template>
  </CrudPage>
</template>
