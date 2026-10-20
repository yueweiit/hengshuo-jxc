<script setup lang="ts">
import { computed, onMounted, ref } from 'vue'
import { http } from '@/api/http'
import { useCountryStore } from '@/stores/country'
import { todayIn } from '@/utils/format'
import { financeSourcePath } from '@/utils/finance-source'
type Row = Record<string, any>
const country = useCountryStore()
const rows = ref<Row[]>([]), books = ref<Row[]>([])
const bookId = ref<number>(), periodId = ref<number>(), detail = ref<Row | null>(null)
const periods = computed(() => books.value.find(b => b.id === bookId.value)?.periods ?? [])
const showPrecision = computed(() => detail.value?.type === 'INVENTORY' && Object.prototype.hasOwnProperty.call(detail.value, 'sourceAccountingAmount'))
const names: Record<string, string> = { AR: '应收', AP: '应付', INVENTORY: '库存', CASH: '现金银行' }
async function load() { detail.value = null; if (!bookId.value || !periodId.value) { rows.value = []; return }; rows.value = await http.get('/fin/reconcile', { type: 'ALL', bookId: bookId.value, periodId: periodId.value }) }
async function changeBook() { periodId.value = periods.value.find((p: Row) => p.startDate <= todayIn(country.timezone) && p.endDate >= todayIn(country.timezone))?.id; await load() }
onMounted(async () => { books.value = await http.get<Row[]>('/fin/books'); bookId.value = books.value.filter(b => b.status === 'ACTIVE').length === 1 ? books.value.find(b => b.status === 'ACTIVE')!.id : undefined; await changeBook() })
</script>
<template>
  <el-card>
    <template #header>子账与总账核对</template>
    <p class="muted">业务侧按所选期间截止日读取历史事实；总账侧只读取已记账余额。缺成本、汇率或分摊时显示金额未完整，查询不会重建余额。</p>
    <div class="toolbar"><el-select v-model="bookId" placeholder="账套" @change="changeBook"><el-option v-for="b in books" :key="b.id" :value="b.id" :label="b.name" /></el-select><el-select v-model="periodId" placeholder="选择期间" @change="load"><el-option v-for="p in periods" :key="p.id" :value="p.id" :label="p.name" /></el-select><el-button :disabled="!periodId" @click="load">刷新核对</el-button></div>
    <el-table :data="rows" size="small" @row-click="detail = $event">
      <el-table-column label="项目"><template #default="{ row }">{{ names[row.type] || row.type }}</template></el-table-column>
      <el-table-column label="业务子账"><template #default="{ row }">{{ row.businessAmount ?? '金额未完整' }}</template></el-table-column>
      <el-table-column prop="glAmount" label="已记账总账" />
      <el-table-column prop="unpostedAmount" label="已生成未记账" />
      <el-table-column label="尚未生成"><template #default="{ row }">{{ row.ungeneratedAmount ?? '待补来源或映射' }}</template></el-table-column>
      <el-table-column prop="diffAmount" label="业务减总账差额" />
    </el-table>
    <div v-if="detail">
      <h4>{{ names[detail.type] }} · {{ detail.currency }} · 业务明细</h4>
      <el-alert v-if="detail.pendingRateCount" title="存在缺成本、汇率或待分摊的来源，业务金额尚不完整。" type="error" :closable="false" />
      <el-table :data="detail.details" size="small"><el-table-column prop="sourceType" label="来源类型" /><el-table-column prop="sourceNo" label="来源单据" /><el-table-column prop="sourceId" label="来源ID" /><el-table-column prop="bizDate" label="日期" /><el-table-column prop="currency" label="原币" /><el-table-column prop="originalAmount" label="原币金额" /><el-table-column prop="amount" label="本位币金额" /></el-table>
      <section v-if="showPrecision">
        <h4>库存来源记账精度</h4>
        <p class="muted">来源记账金额按原业务事实的固定精度分配读取；上方业务减总账差额保留显示。</p>
        <el-alert v-if="detail.precisionIncomplete" title="来源记账金额尚不完整，精度分配差额和待核差额暂不能确定。" type="warning" :closable="false" />
        <el-descriptions :column="3" border>
          <el-descriptions-item label="来源记账金额">{{ detail.sourceAccountingAmount ?? '金额未完整' }}</el-descriptions-item>
          <el-descriptions-item label="记账精度分配差额">{{ detail.roundingDifference ?? '金额未完整' }}</el-descriptions-item>
          <el-descriptions-item label="扣除精度差额后待核差额">{{ detail.accountingDiffAmount ?? '金额未完整' }}</el-descriptions-item>
        </el-descriptions>
        <el-table :data="detail.precisionDetails" size="small">
          <el-table-column prop="sourceType" label="来源类型" />
          <el-table-column label="来源单据"><template #default="{ row }"><router-link v-if="financeSourcePath({ ...row, bookId })" :to="financeSourcePath({ ...row, bookId })!">{{ row.sourceNo || row.sourceId }}</router-link><span v-else>{{ row.sourceNo || row.sourceId }}</span></template></el-table-column>
          <el-table-column prop="sourceId" label="来源ID" /><el-table-column prop="bizDate" label="日期" />
          <el-table-column label="原始本位币金额"><template #default="{ row }">{{ row.originalAmount ?? '金额未完整' }}</template></el-table-column>
          <el-table-column label="分配记账金额"><template #default="{ row }">{{ row.amount ?? '金额未完整' }}</template></el-table-column>
        </el-table>
      </section>
      <h4>已生成未记账</h4>
      <el-table :data="detail.unposted" size="small"><el-table-column label="凭证"><template #default="{ row }"><router-link :to="{ path: '/finance/vouchers', query: { voucherId: row.voucherId, bookId } }">{{ row.voucherNo }}</router-link></template></el-table-column><el-table-column prop="status" label="状态" /><el-table-column prop="amount" label="影响本位币金额" /></el-table>
      <h4>尚未生成凭证</h4>
      <el-table :data="detail.ungenerated" size="small"><el-table-column prop="sourceNo" label="来源单据" /><el-table-column prop="eventType" label="事件" /><el-table-column prop="sourceId" label="来源ID" /><el-table-column prop="status" label="状态" /><el-table-column prop="amount" label="影响本位币金额" /><el-table-column prop="failReason" label="诊断" /><el-table-column width="100"><template #default><router-link :to="{ path: '/finance/events', query: { bookId } }">前往事件</router-link></template></el-table-column></el-table>
    </div>
  </el-card>
</template>
<style scoped>.toolbar { display: flex; gap: 12px; margin: 12px 0; }</style>
