<script setup lang="ts">
import { computed, onMounted, ref } from 'vue'
import { useCountryStore } from '@/stores/country'
import MoneyText from '@/components/MoneyText.vue'
import { http } from '@/api/http'
import StatusTag from '@/components/StatusTag.vue'
import { financeSourcePath } from '@/utils/finance-source'

const country = useCountryStore()
const books = ref<Record<string, any>[]>([]), bookId = ref<number>(), periodId = ref<number>()
const data = ref<Record<string, any> | null>(null), busy = ref(false)
const periods = computed(() => books.value.find(b => b.id === bookId.value)?.periods ?? [])
let sequence = 0
function changeBook() { sequence++; periodId.value = undefined; data.value = null }
async function load() {
  const request = ++sequence
  data.value = null
  if (!bookId.value || !periodId.value) return
  busy.value = true
  try { const result = await http.get<Record<string, any>>('/cst/profit', { bookId: bookId.value, periodId: periodId.value }); if (request === sequence) data.value = result }
  finally { if (request === sequence) busy.value = false }
}
onMounted(async () => { books.value = await http.get('/fin/books') })
</script>

<template>
  <el-card>
    <template #header>单品利润 · {{ country.current?.name }}</template>
    <el-form inline :disabled="busy"><el-form-item label="账套"><el-select v-model="bookId" placeholder="请选择账套" style="width:260px;max-width:100%" @change="changeBook"><el-option v-for="b in books" :key="b.id" :label="b.name + ' · ' + b.baseCurrency" :value="b.id" /></el-select></el-form-item><el-form-item label="期间"><el-select v-model="periodId" placeholder="请选择期间" style="width:230px" @change="load"><el-option v-for="p in periods" :key="p.id" :label="p.name + ' · ' + p.status" :value="p.id" /></el-select></el-form-item><el-button :disabled="!periodId" @click="load">刷新</el-button></el-form>
    <p v-if="data" class="muted">{{ data.from }} 至 {{ data.to }} · {{ data.baseCurrency }} · {{ data.timezone }} · 来源版本 {{ data.sourceVersion }}</p>
    <el-alert v-if="data" type="warning" :closable="false" :title="data.disclaimer" />
    <p class="muted">基础毛利 = 净销售额 − 出库成本。贡献利润再减去已登记的直接销售费用和期间费用。现金到账不算收入。</p>
    <el-table v-if="data" :data="data.rows" size="small">
      <el-table-column type="expand">
        <template #default="{ row }">
          <p class="muted">业务来源明细 · 金额为空表示未提供或不可见；来源页面仍按当前权限校验。</p>
          <el-table :data="row.sources" size="small" empty-text="暂无可见来源">
            <el-table-column prop="sourceType" label="来源类型" width="150" />
            <el-table-column label="来源单号" min-width="240"><template #default="{ row: source }"><el-button v-if="financeSourcePath({ ...source, bookId })" link type="primary" @click="$router.push(financeSourcePath({ ...source, bookId })!)">{{ source.sourceNo || source.sourceId }}</el-button><span v-else>{{ source.sourceNo || source.sourceId }}</span></template></el-table-column>
            <el-table-column prop="sourceLineId" label="来源行" width="90" />
            <el-table-column prop="bizDate" label="业务日期" width="110" />
            <el-table-column label="原币成交额" width="130"><template #default="{ row: source }"><MoneyText :value="source.originalSalesAmount" :currency="source.currency || data.baseCurrency" /></template></el-table-column>
            <el-table-column v-for="field in [{ key: 'netSalesAmount', label: '净销售' }, { key: 'cogsAmount', label: '出库成本' }, { key: 'directExpense', label: '直接费用' }, { key: 'periodExpense', label: '期间费用' }]" :key="field.key" :label="field.label" width="120"><template #default="{ row: source }"><MoneyText :value="source[field.key]" :currency="data.baseCurrency" /></template></el-table-column>
            <el-table-column label="成本依据" min-width="230"><template #default="{ row: source }"><div v-for="(version, index) in source.costVersions" :key="index">{{ version.cogsId ? '出库成本 #' + version.cogsId : '入库成本 #' + version.inboundCostId }} · {{ version.method }} {{ version.methodVersion }} {{ version.completionDate }}</div><span v-if="source.estimated">含暂估</span><span v-if="source.costMissing">成本待补齐</span><span v-if="source.rateMissing">汇率待补齐</span><span v-if="source.taxBasisMissing">税口径待确认</span></template></el-table-column>
          </el-table>
        </template>
      </el-table-column>
      <el-table-column prop="productCode" label="商品" width="100" />
      <el-table-column prop="productName" label="名称" />
      <el-table-column prop="netSalesQty" label="净数量" width="90" />
      <el-table-column label="净销售" width="120"><template #default="{ row }"><MoneyText :value="row.netSalesAmount" :currency="data.baseCurrency" /></template></el-table-column>
      <el-table-column label="出库成本" width="120"><template #default="{ row }"><MoneyText :value="row.cogsAmount" :currency="data.baseCurrency" /></template></el-table-column>
      <el-table-column label="基础毛利" width="120"><template #default="{ row }"><MoneyText :value="row.grossProfit" :currency="data.baseCurrency" /></template></el-table-column>
      <el-table-column label="贡献利润" width="120"><template #default="{ row }"><MoneyText :value="row.contributionProfit" :currency="data.baseCurrency" /></template></el-table-column>
      <el-table-column label="完整度" width="100"><template #default="{ row }"><StatusTag :status="row.completeness" /></template></el-table-column>
    </el-table>
    <p v-if="data">基础毛利合计 <MoneyText :value="data.grossProfit" :currency="data.baseCurrency" />，贡献利润合计 <MoneyText :value="data.contributionProfit" :currency="data.baseCurrency" />。{{ data.reconcileHint }}</p>
    <el-empty v-else-if="!busy" description="请选择账套和期间" />
  </el-card>
</template>
