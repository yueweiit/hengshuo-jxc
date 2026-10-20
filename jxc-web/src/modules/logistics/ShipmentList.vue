<script setup lang="ts">
import { ref } from 'vue'
import { useRouter } from 'vue-router'
import { useUserStore } from '@/stores/user'
import CrudPage from '@/components/crud/CrudPage.vue'
import DateTimeText from '@/components/DateTimeText.vue'
import StatusTag from '@/components/StatusTag.vue'
import type { ColumnDef, FieldDef } from '@/components/crud/types'
import { CARRIER_SOURCE, MX_WAREHOUSE_SOURCE, SHIPMENT_STATUS, TRANSPORT_MODES, optionText } from '@/modules/shared/bizOptions'
import { formatDate } from '@/utils/format'
import ShipmentForm from './ShipmentForm.vue'

const router = useRouter()
const user = useUserStore()
const form = ref<InstanceType<typeof ShipmentForm>>()

const columns: ColumnDef[] = [
  { prop: 'docNo', label: '批次号', width: 185, fixed: 'left' },
  { prop: 'mode', label: '方式 / 柜号或运单', minWidth: 170 },
  { prop: 'carrierName', label: '物流商', minWidth: 120 },
  { prop: 'destWarehouseName', label: '目的仓', width: 130 },
  { prop: 'productSummary', label: '商品', minWidth: 110 },
  { prop: 'qty', label: '发运 / 在途 / 已实收', width: 150 },
  { prop: 'schedule', label: '计划 → 实际（发运 / 到港）', minWidth: 250 },
  { prop: 'status', label: '状态', type: 'status', width: 150 },
]
const searchFields: FieldDef[] = [
  { prop: 'keyword', label: '批次 / 柜号 / 提单 / 采购单' },
  { prop: 'status', label: '状态', type: 'select', options: SHIPMENT_STATUS },
  { prop: 'transportMode', label: '方式', type: 'select', options: TRANSPORT_MODES },
  { prop: 'carrierId', label: '物流商', type: 'select', options: CARRIER_SOURCE },
  { prop: 'destWarehouseId', label: '目的仓', type: 'select', options: MX_WAREHOUSE_SOURCE },
  { prop: 'delayed', label: '延误', type: 'select', options: [{ label: '只看延误', value: 'true' }] },
]

const inTransit = (t: Record<string, number>) => t.intlQty + t.pendingDeliveryQty + t.onHoldQty + t.deliveringQty
const open = (id: number) => router.push(`/logistics/shipments/${id}`)
</script>

<template>
  <CrudPage
    title="运输批次"
    resource="/lgs/shipments"
    :columns="columns"
    :search-fields="searchFields"
    :can-create="false"
    :can-toggle="false"
    audit-type="shipment"
  >
    <template #toolbar>
      <el-button v-if="user.hasPerm('lgs:shipment:create')" type="primary" @click="form?.open()"><el-icon><Plus /></el-icon>新建运输批次</el-button>
    </template>
    <template #header>
      <p class="muted">数量恒等：发运 = 国际在途 + 当地待派送 + 暂缓 + 派送在途 + 已实收合格 + 已实收冻结 + 差异。超过计划节点 24 小时未记录即标记延误并生成待办。</p>
    </template>
    <template #col-docNo="{ row }">
      <el-link type="primary" @click="open(row.id)">{{ row.docNo }}</el-link>
    </template>
    <template #col-mode="{ row }">
      {{ optionText(TRANSPORT_MODES, row.transportMode) }} · <span class="mono">{{ row.transportMode === 'SEA' ? row.currentContainerNo : row.awbNo }}</span>
    </template>
    <template #col-qty="{ row }">
      <span class="mono">{{ row.totals.shippedQty || row.totals.baseQty }} / {{ inTransit(row.totals) }} / {{ row.totals.receivedGoodQty + row.totals.receivedFrozenQty }}</span>
    </template>
    <template #col-schedule="{ row }">
      <div>{{ formatDate(row.plannedEtd) }} → <DateTimeText v-if="row.actualEtd || (row.openingRef && row.openingSourceDate)" :value="row.actualEtd" :known-date="row.openingRef ? row.openingSourceDate : null" /><span v-else class="muted">未发运</span></div>
      <div>{{ formatDate(row.plannedEta) }} → <DateTimeText v-if="row.actualEta" :value="row.actualEta" /><span v-else class="muted">未到港</span></div>
    </template>
    <template #col-status="{ row }">
      <el-space :size="4">
        <StatusTag :status="row.status" />
        <el-tooltip v-if="row.delayed" :content="`${row.delayStage}已超计划 ${row.delayHours} 小时`">
          <el-tag type="danger" size="small" effect="dark">延误</el-tag>
        </el-tooltip>
      </el-space>
    </template>
    <template #row-actions="{ row }">
      <el-button link type="primary" @click="open(row.id)">查看</el-button>
      <el-button v-if="['DRAFT', 'PENDING_DISPATCH'].includes(row.status) && user.hasPerm('lgs:shipment:edit')" link type="primary" @click="form?.open(row)">编辑</el-button>
    </template>
  </CrudPage>
  <ShipmentForm ref="form" @saved="(s) => open(s.id)" />
</template>
