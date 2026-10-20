<script setup lang="ts">
import { ref } from 'vue'
import { useRoute, useRouter } from 'vue-router'
import { http } from '@/api/http'
import { useUserStore } from '@/stores/user'
import CrudPage from '@/components/crud/CrudPage.vue'
import MoneyText from '@/components/MoneyText.vue'
import ProductCell from '@/components/biz/ProductCell.vue'
import type { ColumnDef, CrudPageExpose, FieldDef } from '@/components/crud/types'
import { ALERT_TAG, ALERT_TYPES, ALL_WAREHOUSE_SOURCE, CATEGORY_SOURCE, BATCH_SOURCES, COST_STATUS, FREEZE_TYPES, optionText } from '@/modules/shared/bizOptions'
import { formatDate } from '@/utils/format'
import CostTraceDrawer from '@/modules/cost/CostTraceDrawer.vue'
import FreezeForm from './FreezeForm.vue'
import { queryDefaults } from '@/utils/action'

type Row = Record<string, any> // eslint-disable-line @typescript-eslint/no-explicit-any

const route = useRoute()
const router = useRouter()
const initial = queryDefaults(route.query)
const user = useUserStore()
const page = ref<CrudPageExpose>()
const freeze = ref<InstanceType<typeof FreezeForm>>()
const trace = ref<InstanceType<typeof CostTraceDrawer>>()

const columns: ColumnDef[] = [
  { prop: 'warehouseName', label: '仓库', width: 130, fixed: 'left' },
  { prop: 'product', label: '商品', minWidth: 190 },
  { prop: 'onHandQty', label: '实物', type: 'qty', width: 80 },
  { prop: 'reservedQty', label: '预留', type: 'qty', width: 80 },
  { prop: 'frozenQty', label: '冻结', width: 80 },
  { prop: 'availableQty', label: '可售', width: 90 },
  { prop: 'transit', label: '在途', width: 90 },
  { prop: 'limit', label: '下限 ~ 上限', width: 110 },
  { prop: 'alerts', label: '预警', width: 110 },
  { prop: 'batchCount', label: '批次', width: 70 },
]
const searchFields: FieldDef[] = [
  { prop: 'keyword', label: '编码 / 名称 / 条码' },
  { prop: 'warehouseId', label: '仓库', type: 'select', options: ALL_WAREHOUSE_SOURCE },
  { prop: 'categoryId', label: '分类', type: 'select', options: CATEGORY_SOURCE },
  { prop: 'alert', label: '预警', type: 'select', options: [{ label: '只看有预警', value: 'true' }] },
]

const transit = (r: Row) => ['intlQty', 'pendingDeliveryQty', 'onHoldQty', 'deliveringQty', 'transferInQty'].reduce((total, key) => total + Number(r[key] ?? 0), 0)

// ---------- 批次 ----------
const drawer = ref({ visible: false, row: {} as Row, list: [] as Row[], loading: false })
async function openBatches(r: Row) {
  drawer.value = { visible: true, row: r, list: [], loading: true }
  try {
    drawer.value.list = await http.get<Row[]>(`/inv/stocks/${r.warehouseId}/${r.productId}/batches`)
  } finally {
    drawer.value.loading = false
  }
}
</script>

<template>
  <CrudPage ref="page" title="库存查询" resource="/inv/stocks" :columns="columns" :search-fields="searchFields" :default-query="initial" :can-create="false" :can-toggle="false" :actions-width="180">
    <template #toolbar>
      <el-button v-if="user.hasPerm('inv:freeze:create')" @click="freeze?.open()">手工冻结</el-button>
    </template>
    <template #header>
      <p class="muted">可售 = 实物 − 预留 − 冻结。在途（国际在途、当地待派送、暂缓、派送在途、调拨在途）不计入可售，只作为预计到货参考。正在盘点的商品带锁标记，期间不能出入库。</p>
    </template>
    <template #col-product="{ row }">
      <ProductCell :code="row.productCode" :name="row.productName" :extra="row.spec" />
      <el-tag v-if="row.locked" size="small" type="warning" class="ml"><el-icon><Lock /></el-icon> 盘点中</el-tag>
    </template>
    <template #col-frozenQty="{ row }">
      <el-tooltip v-if="row.frozenQty" placement="top">
        <template #content><div v-for="(q, k) in row.frozenByType" :key="k">{{ optionText(FREEZE_TYPES, k) }}：{{ q }}</div></template>
        <el-link type="warning" @click="router.push({ path: '/inventory/freezes', query: { warehouseId: row.warehouseId, productId: row.productId } })">{{ row.frozenQty }}</el-link>
      </el-tooltip>
      <span v-else class="zero">0</span>
    </template>
    <template #col-availableQty="{ row }"><b :class="{ danger: row.availableQty <= 0 }">{{ row.availableQty }}</b></template>
    <template #col-transit="{ row }">
      <el-tooltip v-if="transit(row)" placement="top">
        <template #content>
          国际在途 {{ row.intlQty }}<br />当地待派送 {{ row.pendingDeliveryQty }}<br />暂缓 {{ row.onHoldQty }}<br />派送在途 {{ row.deliveringQty }}<br />调拨在途 {{ row.transferInQty }}
        </template>
        <span class="link">{{ transit(row) }}</span>
      </el-tooltip>
      <span v-else class="zero">0</span>
    </template>
    <template #col-limit="{ row }">
      <span v-if="row.minQty != null || row.maxQty != null" class="mono">{{ row.minQty ?? '-' }} ~ {{ row.maxQty ?? '-' }}</span>
      <span v-else class="muted">未设置</span>
    </template>
    <template #col-alerts="{ row }">
      <span><el-tag v-for="a in row.alerts" :key="a" :type="ALERT_TAG[a]" size="small">{{ optionText(ALERT_TYPES, a) }}</el-tag></span>
    </template>
    <template #row-actions="{ row }">
      <el-button link type="primary" :disabled="!row.batchCount" @click="openBatches(row)">批次</el-button>
      <el-button v-if="user.hasPerm('inv:txn:view')" link type="primary" @click="router.push({ path: '/inventory/txns', query: { warehouseId: row.warehouseId, productId: row.productId } })">流水</el-button>
      <el-button v-if="user.hasPerm('inv:freeze:create') && row.availableQty > 0" link type="warning" @click="freeze?.open({ warehouseId: row.warehouseId, productId: row.productId })">冻结</el-button>
    </template>
  </CrudPage>

  <el-drawer v-model="drawer.visible" :title="`${drawer.row.warehouseName} · ${drawer.row.productCode} 批次`" size="840px" append-to-body>
    <el-table v-loading="drawer.loading" :data="drawer.list" border size="small">
      <el-table-column prop="batchNo" label="批次" width="170" />
      <el-table-column label="首次入库" width="105"><template #default="{ row }">{{ formatDate(row.firstInboundDate) }}</template></el-table-column>
      <el-table-column label="来源" min-width="170"><template #default="{ row }">{{ optionText(BATCH_SOURCES, row.sourceType) }} · <span class="mono">{{ row.sourceNo }}</span></template></el-table-column>
      <el-table-column prop="onHandQty" label="实物" width="64" align="right" />
      <el-table-column prop="frozenQty" label="冻结" width="64" align="right" />
      <el-table-column label="成本" width="140" align="right">
        <template #default="{ row }">
          <template v-if="row.unitCost !== undefined">
            <MoneyText v-if="row.unitCost != null" :value="row.unitCost" :currency="row.baseCurrency" />
            <div class="muted">{{ row.costStatus === 'MANUAL' ? '盘盈' : optionText(COST_STATUS, row.costStatus) }}</div>
          </template>
          <span v-else class="muted">无权查看</span>
        </template>
      </el-table-column>
      <el-table-column width="60"><template #default="{ row }"><el-button link type="primary" @click="trace?.open(row.batchId)">追溯</el-button></template></el-table-column>
    </el-table>
    <p class="muted">出库按先进先出消耗批次；同一目的仓实收行生成一个批次，批次成本来自入库成本快照。</p>
  </el-drawer>
  <FreezeForm ref="freeze" @saved="page?.reload()" />
  <CostTraceDrawer ref="trace" />
</template>

<style scoped>
.ml {
  margin-left: 4px;
}

.zero {
  color: var(--el-text-color-placeholder);
}

.danger {
  color: var(--el-color-danger);
}

.link {
  color: var(--el-color-primary);
  cursor: help;
  border-bottom: 1px dashed;
}
</style>
