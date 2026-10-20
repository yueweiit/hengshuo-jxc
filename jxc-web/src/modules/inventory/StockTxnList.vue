<script setup lang="ts">
import { useRoute } from 'vue-router'
import CrudPage from '@/components/crud/CrudPage.vue'
import MoneyText from '@/components/MoneyText.vue'
import ProductCell from '@/components/biz/ProductCell.vue'
import type { ColumnDef, FieldDef } from '@/components/crud/types'
import { ALL_WAREHOUSE_SOURCE, PRODUCT_SOURCE, SOURCE_TYPES, TXN_TYPES, optionText } from '@/modules/shared/bizOptions'
import { queryDefaults } from '@/utils/action'

const route = useRoute()
const initial = queryDefaults(route.query)

const columns: ColumnDef[] = [
  { prop: 'occurredAt', label: '发生时间', type: 'datetime', width: 170, fixed: 'left' },
  { prop: 'bizDate', label: '业务日期', type: 'date', width: 112 },
  { prop: 'txnTypeLabel', label: '类型', width: 100 },
  { prop: 'warehouseName', label: '仓库', width: 130 },
  { prop: 'product', label: '商品', minWidth: 170 },
  { prop: 'batchNo', label: '批次', width: 170 },
  { prop: 'onHandChange', label: '实物变动', width: 90 },
  { prop: 'frozenChange', label: '冻结变动', width: 90 },
  { prop: 'unitCost', label: '单位成本', width: 120 },
  { prop: 'source', label: '来源单', width: 200 },
  { prop: 'operatorName', label: '操作人', width: 110 },
]
const searchFields: FieldDef[] = [
  { prop: 'keyword', label: '来源单号' },
  { prop: 'warehouseId', label: '仓库', type: 'select', options: ALL_WAREHOUSE_SOURCE },
  { prop: 'productId', label: '商品', type: 'select', options: PRODUCT_SOURCE },
  { prop: 'txnType', label: '类型', type: 'select', options: TXN_TYPES },
  { prop: 'sourceType', label: '来源', type: 'select', options: SOURCE_TYPES },
  { prop: 'dateFrom', label: '业务日期起', type: 'date' },
  { prop: 'dateTo', label: '业务日期止', type: 'date' },
]
</script>

<template>
  <CrudPage title="库存流水" resource="/inv/txns" :columns="columns" :search-fields="searchFields" :default-query="initial" :can-create="false" :can-toggle="false" :actions-width="1">
    <template #header>
      <p class="muted">流水只追加不修改：每次实收、冻结、解冻、调拨、盘盈盘亏都生成一条，按来源行唯一，重复提交不会重复记账。余额由流水汇总得出。</p>
    </template>
    <template #col-product="{ row }"><ProductCell :code="row.productCode" :name="row.productName" /></template>
    <template #col-onHandChange="{ row }"><span :class="row.onHandChange > 0 ? 'pos' : row.onHandChange < 0 ? 'neg' : 'zero'">{{ row.onHandChange > 0 ? '+' : '' }}{{ row.onHandChange }}</span></template>
    <template #col-frozenChange="{ row }"><span :class="row.frozenChange ? 'frozen' : 'zero'">{{ row.frozenChange > 0 ? '+' : '' }}{{ row.frozenChange }}</span></template>
    <template #col-unitCost="{ row }">
      <span v-if="!('unitCost' in row)" class="muted">无权查看</span>
      <MoneyText v-else-if="row.unitCost != null" :value="row.unitCost" />
      <span v-else class="muted">-</span>
    </template>
    <template #col-source="{ row }">{{ optionText(SOURCE_TYPES, row.sourceType) }} · <span class="mono">{{ row.sourceNo }}</span></template>
  </CrudPage>
</template>

<style scoped>
.pos {
  color: var(--el-color-success);
  font-weight: 600;
}

.neg {
  color: var(--el-color-danger);
  font-weight: 600;
}

.frozen {
  color: var(--el-color-warning);
}

.zero {
  color: var(--el-text-color-placeholder);
}
</style>
