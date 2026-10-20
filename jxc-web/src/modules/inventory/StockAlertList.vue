<script setup lang="ts">
import { useRoute, useRouter } from 'vue-router'
import { useUserStore } from '@/stores/user'
import CrudPage from '@/components/crud/CrudPage.vue'
import ProductCell from '@/components/biz/ProductCell.vue'
import type { ColumnDef, FieldDef } from '@/components/crud/types'
import { ALERT_TAG, ALERT_TYPES, ALL_WAREHOUSE_SOURCE, PRODUCT_SOURCE } from '@/modules/shared/bizOptions'

const route = useRoute()
const router = useRouter()
const user = useUserStore()

const columns: ColumnDef[] = [
  { prop: 'alertType', label: '预警类型', width: 110, fixed: 'left' },
  { prop: 'warehouseName', label: '仓库', width: 130 },
  { prop: 'product', label: '商品', minWidth: 190 },
  { prop: 'stock', label: '当前实物 / 预留 / 冻结 / 可售', width: 220 },
  { prop: 'availableQty', label: '评估时可售', width: 110 },
  { prop: 'threshold', label: '阈值', width: 80 },
  { prop: 'ownerName', label: '负责人', width: 110 },
  { prop: 'firstTriggeredAt', label: '首次触发', type: 'datetime', width: 170 },
  { prop: 'lastEvaluatedAt', label: '最近评估', type: 'datetime', width: 170 },
  { prop: 'closedAt', label: '消除时间', type: 'datetime', width: 170 },
  { prop: 'status', label: '状态', type: 'status', statusDomain: 'alert', width: 95 },
]
const searchFields: FieldDef[] = [
  { prop: 'keyword', label: '商品编码 / 名称' },
  { prop: 'status', label: '状态', type: 'select', options: [{ label: '预警中', value: 'OPEN' }, { label: '已消除', value: 'CLOSED' }] },
  { prop: 'alertType', label: '类型', type: 'select', options: ALERT_TYPES },
  { prop: 'warehouseId', label: '仓库', type: 'select', options: ALL_WAREHOUSE_SOURCE },
  { prop: 'productId', label: '商品', type: 'select', options: PRODUCT_SOURCE },
]
</script>

<template>
  <CrudPage title="库存预警" resource="/inv/alerts" :columns="columns" :search-fields="searchFields" :default-query="{ status: 'OPEN', ...route.query }" :can-create="false" :can-toggle="false">
    <template #toolbar>
      <el-button v-if="user.hasPerm('inv:limit:config')" @click="router.push('/inventory/limits')">设置上下限</el-button>
    </template>
    <template #header>
      <p class="muted">每次库存变动后重新评估；同一仓库同一商品同一类型只保留一条进行中的预警，恢复正常后自动消除，并通知负责人。</p>
    </template>
    <template #col-alertType="{ row }"><el-tag :type="ALERT_TAG[row.alertType]" size="small">{{ row.alertTypeLabel || ALERT_TYPES.find(option => option.value === row.alertType)?.label || row.alertType || '-' }}</el-tag></template>
    <template #col-product="{ row }"><ProductCell :code="row.productCode" :name="row.productName" /></template>
    <template #col-stock="{ row }"><span class="mono">{{ row.onHandQty ?? '-' }} / {{ row.reservedQty ?? '-' }} / {{ row.frozenQty ?? '-' }} / <b>{{ row.currentAvailable ?? '-' }}</b></span></template>
    <template #col-ownerName="{ row }">{{ row.ownerName || (row.ownerId ? '#' + row.ownerId : '-') }}</template>
    <template #row-actions="{ row }">
      <el-button link type="primary" @click="router.push({ path: '/inventory/stocks', query: { warehouseId: row.warehouseId } })">看库存</el-button>
      <el-button v-if="user.hasPerm('lgs:shipment:view')" link type="primary" @click="router.push('/logistics/in-transit')">看在途</el-button>
    </template>
  </CrudPage>
</template>
