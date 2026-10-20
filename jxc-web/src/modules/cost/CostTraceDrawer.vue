<script setup lang="ts">
import { ref, watch } from 'vue'
import { useRouter } from 'vue-router'
import { http } from '@/api/http'
import { useCountryStore } from '@/stores/country'
import { useUserStore } from '@/stores/user'
import { getCountryId, getToken } from '@/utils/session'
import { financeSourcePath } from '@/utils/finance-source'
import MoneyText from '@/components/MoneyText.vue'
import DateTimeText from '@/components/DateTimeText.vue'
import { COST_STATUS, optionText } from '@/modules/shared/bizOptions'
import { formatDate } from '@/utils/format'

type Row = Record<string, any> // eslint-disable-line @typescript-eslint/no-explicit-any

const router = useRouter(), country = useCountryStore(), user = useUserStore()
const visible = ref(false)
const loading = ref(false)
const t = ref<Row>({})
let request = 0
const context = () => `${country.epoch}:${getCountryId()}:${getToken()}`

function close() {
  request++
  visible.value = false
  loading.value = false
  t.value = {}
}
async function open(batchId: number) {
  const current = ++request, scope = context()
  visible.value = true
  loading.value = true
  t.value = {}
  try {
    const data = await http.get<Row>(`/cst/batches/${batchId}/cost-trace`)
    if (current === request && scope === context() && visible.value) t.value = data
  } finally {
    if (current === request && scope === context()) loading.value = false
  }
}
function go(reference: Row) {
  const path = financeSourcePath(reference)
  if (!path) return
  close()
  router.push(path)
}
watch(() => [country.epoch, user.token], close)
defineExpose({ open })
</script>

<template>
  <el-drawer v-model="visible" :title="`批次成本追溯 ${t.batchId == null ? '' : '#' + t.batchId}`" size="880px" append-to-body @close="close">
    <div v-loading="loading">
      <template v-if="t.batchId != null">
        <p>批次 <span class="mono">#{{ t.batchId }}</span> · 截至 {{ formatDate(t.asOf) }}</p>
        <el-alert v-if="!t.cost" type="info" :closable="false" title="成本字段未返回，可能受字段权限限制。" />
        <template v-else>
          <el-alert v-if="t.costMissing" class="mt" type="warning" :closable="false" title="成本尚未完整，未知金额与单位成本保持待补。" />
          <el-descriptions :column="2" size="small" border class="mt">
            <el-descriptions-item label="成本来源">
              <el-link type="primary" @click="go({ sourceType: 'CST_INBOUND_COST', sourceId: t.cost.id, bookId: t.cost.bookId })">#{{ t.cost.id }}</el-link>
              · {{ t.cost.sourceType ?? '—' }} / 来源行 #{{ t.cost.sourceLineId ?? '—' }}
            </el-descriptions-item>
            <el-descriptions-item label="采购单">
              <el-link v-if="t.cost.poId" type="primary" @click="go({ sourceType: 'PURCHASE_ORDER', sourceId: t.cost.poId, bookId: t.cost.bookId })">#{{ t.cost.poId }}</el-link><span v-else>—</span>
            </el-descriptions-item>
            <el-descriptions-item label="账套">#{{ t.cost.bookId }}</el-descriptions-item>
            <el-descriptions-item label="仓库 / 商品">#{{ t.cost.warehouseId }} / #{{ t.cost.productId }}</el-descriptions-item>
            <el-descriptions-item label="原入库日期">{{ formatDate(t.cost.bizDate) }}</el-descriptions-item>
            <el-descriptions-item label="基础数量">{{ t.cost.qty ?? '—' }}</el-descriptions-item>
            <el-descriptions-item label="状态">{{ optionText(COST_STATUS, t.cost.status) }}</el-descriptions-item>
            <el-descriptions-item label="汇率">{{ t.cost.rate ?? '待补' }} · {{ t.cost.srcCurrency ?? '—' }}→{{ t.cost.baseCurrency ?? '—' }} · {{ formatDate(t.cost.rateDate) }} / 版本 {{ t.cost.rateVersion ?? '—' }}</el-descriptions-item>
            <el-descriptions-item label="原采购单位价"><MoneyText :value="t.cost.srcUnitPrice" :currency="t.cost.srcCurrency" /> / {{ t.cost.srcUnit ?? '—' }} · 换算系数 {{ t.cost.srcFactor ?? '—' }}</el-descriptions-item>
            <el-descriptions-item label="原币金额"><MoneyText :value="t.cost.srcAmount" :currency="t.cost.srcCurrency" /></el-descriptions-item>
            <el-descriptions-item label="本位币采购额"><MoneyText :value="t.cost.basePurchaseAmount" :currency="t.cost.baseCurrency" /></el-descriptions-item>
            <el-descriptions-item label="截至日单位成本"><span class="mono">{{ t.unitCost ?? '待补' }} {{ t.cost.baseCurrency ?? '—' }}</span></el-descriptions-item>
            <el-descriptions-item label="确认人 / 时间" :span="2">{{ t.cost.confirmedBy == null ? '—' : '#' + t.cost.confirmedBy }} · <DateTimeText :value="t.cost.confirmedAt" /></el-descriptions-item>
          </el-descriptions>
          <h4>截至日估值变动</h4>
          <p class="muted">沿用已保存的成本变动；来源行编号不作为收货单编号。</p>
          <el-table :data="t.valuationHistory ?? []" border size="small">
            <el-table-column label="业务日期" width="110"><template #default="{ row }">{{ formatDate(row.bizDate) }}</template></el-table-column>
            <el-table-column label="调整来源" min-width="155"><template #default="{ row }"><el-link v-if="row.adjustmentId" type="primary" @click="go({ sourceType: 'CST_ADJUSTMENT', sourceId: row.adjustmentId, bookId: row.bookId })">#{{ row.adjustmentId }}</el-link><span v-else>—</span><div>{{ row.sourceType ?? '—' }} / #{{ row.sourceId ?? '—' }}</div></template></el-table-column>
            <el-table-column prop="qtyBasis" label="数量基础" width="90" />
            <el-table-column label="变动额" min-width="115"><template #default="{ row }"><MoneyText :value="row.amount" :currency="t.cost.baseCurrency" /></template></el-table-column>
            <el-table-column label="库存部分" min-width="115"><template #default="{ row }"><MoneyText :value="row.inventoryAmount" :currency="t.cost.baseCurrency" /></template></el-table-column>
            <el-table-column label="已售部分" min-width="115"><template #default="{ row }"><MoneyText :value="row.soldAmount" :currency="t.cost.baseCurrency" /></template></el-table-column>
            <el-table-column label="单位成本变动" min-width="170"><template #default="{ row }"><span class="mono">{{ row.unitDelta ?? '待补' }}</span></template></el-table-column>
          </el-table>
        </template>
      </template>
      <el-empty v-else-if="!loading" description="没有找到批次成本" />
    </div>
  </el-drawer>
</template>

<style scoped>
.mt { margin-top: 12px; }
h4 { margin: 16px 0 8px; }
</style>
