<script setup lang="ts">
import { onMounted, ref } from 'vue'
import { useRoute, useRouter } from 'vue-router'
import { http } from '@/api/http'
import type { PageResult } from '@/api/types'
import { useUserStore } from '@/stores/user'
import CrudPage from '@/components/crud/CrudPage.vue'
import DateTimeText from '@/components/DateTimeText.vue'
import type { ColumnDef, FieldDef } from '@/components/crud/types'
import { DOC_STATUS, MX_WAREHOUSE_SOURCE } from '@/modules/shared/bizOptions'
import { openReceiptFor } from './receipt'

type Row = Record<string, any> // eslint-disable-line @typescript-eslint/no-explicit-any

const route = useRoute()
const router = useRouter()
const user = useUserStore()
const tab = ref(route.query.tab === 'list' ? 'list' : 'pending')
const pending = ref<Row[]>([])
const loading = ref(false)

async function loadPending() {
  loading.value = true
  try {
    const res = await http.get<PageResult<Row>>('/lgs/deliveries', { status: 'DISPATCHED', size: 200 })
    pending.value = res.records.filter((d) => d.receiptStatus !== 'CONFIRMED')
  } finally {
    loading.value = false
  }
}

const columns: ColumnDef[] = [
  { prop: 'docNo', label: '实收单', width: 185, fixed: 'left' },
  { prop: 'deliveryNo', label: '派送单', width: 185 },
  { prop: 'shipmentNo', label: '运输批次', width: 185 },
  { prop: 'warehouseName', label: '仓库', width: 130 },
  { prop: 'qty', label: '派送 / 合格 / 冻结 / 短缺', width: 190 },
  { prop: 'bizDate', label: '业务日期', type: 'date', width: 112 },
  { prop: 'receivedByName', label: '确认人', width: 100 },
  { prop: 'status', label: '状态', type: 'status', width: 95 },
]
const searchFields: FieldDef[] = [
  { prop: 'keyword', label: '实收单 / 派送单 / 批次' },
  { prop: 'status', label: '状态', type: 'select', options: DOC_STATUS },
  { prop: 'warehouseId', label: '仓库', type: 'select', options: MX_WAREHOUSE_SOURCE },
]

onMounted(async () => {
  if (route.query.deliveryId && user.hasPerm('lgs:receipt:confirm')) return openReceiptFor(router, Number(route.query.deliveryId))
  loadPending()
})
</script>

<template>
  <div class="page">
    <el-tabs v-model="tab" class="page-card">
      <el-tab-pane :label="`待实收（${pending.length}）`" name="pending">
        <div v-loading="loading">
          <el-empty v-if="!pending.length" description="没有待实收的派送单" />
          <div class="cards">
            <div v-for="d in pending" :key="d.id" class="card">
              <div class="card-head">
                <span class="mono">{{ d.docNo }}</span>
                <el-tag v-if="d.receiptId" size="small" type="warning">已开始</el-tag>
              </div>
              <div class="muted">{{ d.shipmentNo }} → {{ d.warehouseName }}</div>
              <div class="muted">{{ d.vehicle || '-' }} · {{ d.driver || '-' }} · 出发 <DateTimeText :value="d.dispatchedAt" /></div>
              <div class="lines">
                <span v-for="l in d.lines" :key="l.id" class="chip">{{ l.productCode }} × {{ l.dispatchQty }}</span>
              </div>
              <el-button v-if="user.hasPerm('lgs:receipt:confirm')" type="primary" class="go" @click="openReceiptFor(router, d.id)">
                {{ d.receiptId ? '继续实收' : '开始实收' }}（{{ d.totalQty }} 件）
              </el-button>
            </div>
          </div>
        </div>
      </el-tab-pane>
      <el-tab-pane label="实收单" name="list" lazy>
        <CrudPage title="目的仓实收单" resource="/lgs/receipts" :columns="columns" :search-fields="searchFields" :can-create="false" :can-toggle="false" audit-type="lgs-receipt">
          <template #header>
            <p class="muted">只有实收确认后才增加可用库存；破损与待检进入冻结库存，短缺自动生成到货差异。</p>
          </template>
          <template #col-docNo="{ row }">
            <el-link type="primary" @click="router.push(`/logistics/receipts/${row.id}`)">{{ row.docNo }}</el-link>
          </template>
          <template #col-qty="{ row }">
            <span class="mono">{{ row.totalDispatch }} / {{ row.totalGood }} / {{ row.totalFrozen }} / <span :class="{ warn: row.totalShort }">{{ row.totalShort }}</span></span>
          </template>
          <template #row-actions="{ row }">
            <el-button link type="primary" @click="router.push(`/logistics/receipts/${row.id}`)">{{ row.status === 'DRAFT' ? '继续' : '查看' }}</el-button>
          </template>
        </CrudPage>
      </el-tab-pane>
    </el-tabs>
  </div>
</template>

<style scoped>
.cards {
  display: grid;
  grid-template-columns: repeat(auto-fill, minmax(280px, 1fr));
  gap: 12px;
}

.card {
  border: 1px solid var(--el-border-color);
  border-radius: 8px;
  padding: 12px;
  display: flex;
  flex-direction: column;
  gap: 6px;
}

.card-head {
  display: flex;
  justify-content: space-between;
  font-weight: 600;
}

.lines {
  display: flex;
  flex-wrap: wrap;
  gap: 4px;
}

.chip {
  background: var(--el-fill-color-light);
  border-radius: 4px;
  padding: 2px 6px;
  font-size: 12px;
}

.go {
  margin-top: 4px;
  width: 100%;
}

.warn {
  color: var(--el-color-danger);
  font-weight: 600;
}
</style>
