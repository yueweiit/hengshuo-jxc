<script setup lang="ts">
import { computed, onMounted, reactive, ref } from 'vue'
import { useRouter } from 'vue-router'
import { http } from '@/api/http'
import type { PageResult } from '@/api/types'
import FieldInput from '@/components/crud/FieldInput.vue'
import ProductCell from '@/components/biz/ProductCell.vue'
import StatusTag from '@/components/StatusTag.vue'
import { MX_WAREHOUSE_SOURCE, PRODUCT_SOURCE } from '@/modules/shared/bizOptions'
import { formatDate } from '@/utils/format'

type Row = Record<string, any> // eslint-disable-line @typescript-eslint/no-explicit-any

const router = useRouter()
const rows = ref<Row[]>([])
const delayed = ref<Row[]>([])
const loading = ref(false)
const q = reactive<{ warehouseId?: number; productId?: number }>({})

const COLS = [
  { prop: 'intlQty', label: '国际在途', color: '#409eff' },
  { prop: 'pendingDeliveryQty', label: '当地待派送', color: '#67c23a' },
  { prop: 'onHoldQty', label: '暂缓', color: '#e6a23c' },
  { prop: 'deliveringQty', label: '派送在途', color: '#909399' },
] as const

const totals = computed(() => Object.fromEntries([...COLS.map((c) => c.prop), 'openDiscrepancyQty', 'totalQty'].map((k) => [k, rows.value.reduce((s, r) => s + (r[k] || 0), 0)])))

async function load() {
  loading.value = true
  try {
    const [res, d] = await Promise.all([
      http.get<PageResult<Row>>('/lgs/in-transit', { ...q }),
      http.get<PageResult<Row>>('/lgs/shipments', { delayed: 'true', size: 50 }),
    ])
    rows.value = res.records
    delayed.value = d.records
  } finally {
    loading.value = false
  }
}

onMounted(load)
</script>

<template>
  <div v-loading="loading" class="page">
    <div class="page-card">
      <div class="page-title">
        <h2>在途看板</h2>
        <div class="toolbar">
          <FieldInput v-model="q.warehouseId" :field="{ prop: 'warehouseId', label: '目的仓', type: 'select', options: MX_WAREHOUSE_SOURCE }" style="width: 180px" @update:model-value="load" />
          <FieldInput v-model="q.productId" :field="{ prop: 'productId', label: '商品', type: 'select', options: PRODUCT_SOURCE }" style="width: 220px" @update:model-value="load" />
          <el-button @click="load"><el-icon><Refresh /></el-icon></el-button>
        </div>
      </div>
      <div class="stats">
        <div v-for="c in COLS" :key="c.prop" class="stat" :style="{ borderColor: c.color }">
          <span class="muted">{{ c.label }}</span><b>{{ totals[c.prop] }}</b>
        </div>
        <div class="stat" style="border-color: #f56c6c"><span class="muted">未结差异</span><b>{{ totals.openDiscrepancyQty }}</b></div>
      </div>
      <p class="muted">在途不计入可用库存。按目的仓 + 商品汇总已发运但尚未实收的数量；补货和缺货判断可以参考这里的预计到货。</p>
    </div>

    <div class="page-card">
      <div class="table-scroll">
        <el-table :data="rows" border size="small" row-key="id">
          <el-table-column type="expand">
            <template #default="{ row }">
              <el-table :data="row.shipments" size="small" class="inner">
                <el-table-column label="批次" width="190"><template #default="{ row: s }"><el-link type="primary" @click="router.push(`/logistics/shipments/${s.id}`)">{{ s.docNo }}</el-link></template></el-table-column>
                <el-table-column label="状态" width="110"><template #default="{ row: s }"><StatusTag :status="s.status" /></template></el-table-column>
                <el-table-column label="计划 / 实际到港" width="200"><template #default="{ row: s }">{{ formatDate(s.plannedEta) }} / {{ s.actualEta ? formatDate(s.actualEta) : '未到港' }}</template></el-table-column>
                <el-table-column v-for="c in COLS" :key="c.prop" :prop="c.prop" :label="c.label" width="96" align="right" />
                <el-table-column prop="openDiscrepancyQty" label="未结差异" width="90" align="right" />
              </el-table>
            </template>
          </el-table-column>
          <el-table-column prop="warehouseName" label="目的仓" width="140" />
          <el-table-column label="商品" min-width="180"><template #default="{ row }"><ProductCell :code="row.productCode" :name="row.productName" :extra="row.spec" /></template></el-table-column>
          <el-table-column label="分布" min-width="200">
            <template #default="{ row }">
              <div class="bar">
                <span v-for="c in COLS" v-show="row[c.prop]" :key="c.prop" :style="{ flex: row[c.prop], background: c.color }" :title="`${c.label} ${row[c.prop]}`" />
              </div>
            </template>
          </el-table-column>
          <el-table-column v-for="c in COLS" :key="c.prop" :prop="c.prop" :label="c.label" width="96" align="right" />
          <el-table-column prop="totalQty" label="在途合计" width="90" align="right" />
          <el-table-column prop="openDiscrepancyQty" label="未结差异" width="90" align="right" />
          <el-table-column label="批次数" width="70" align="right"><template #default="{ row }">{{ row.shipments.length }}</template></el-table-column>
        </el-table>
      </div>
    </div>

    <div class="page-card">
      <h3>延误批次（{{ delayed.length }}）</h3>
      <el-empty v-if="!delayed.length" description="没有延误批次" :image-size="60" />
      <el-table v-else :data="delayed" border size="small">
        <el-table-column label="批次" width="190"><template #default="{ row }"><el-link type="primary" @click="router.push(`/logistics/shipments/${row.id}`)">{{ row.docNo }}</el-link></template></el-table-column>
        <el-table-column prop="carrierName" label="物流商" min-width="140" />
        <el-table-column prop="destWarehouseName" label="目的仓" width="140" />
        <el-table-column label="延误" min-width="160"><template #default="{ row }"><el-tag type="danger" size="small">{{ row.delayStage }}超 {{ row.delayHours }} 小时</el-tag></template></el-table-column>
        <el-table-column label="状态" width="110"><template #default="{ row }"><StatusTag :status="row.status" /></template></el-table-column>
      </el-table>
    </div>
  </div>
</template>

<style scoped>
.stats {
  display: grid;
  grid-template-columns: repeat(auto-fit, minmax(140px, 1fr));
  gap: 12px;
  margin-bottom: 8px;
}

.stat {
  border-left: 4px solid;
  background: var(--el-fill-color-lighter);
  padding: 10px 12px;
  display: flex;
  flex-direction: column;
}

.stat b {
  font-size: 22px;
}

.bar {
  display: flex;
  height: 14px;
  border-radius: 7px;
  overflow: hidden;
  background: var(--el-fill-color);
}

.inner {
  margin: 0 12px 0 48px;
  width: auto;
}

h3 {
  margin: 0 0 12px;
  font-size: 15px;
}
</style>
