<script setup lang="ts">
import { computed, onBeforeUnmount, onMounted, ref } from 'vue'
import { Refresh } from '@element-plus/icons-vue'
import { useCountryStore } from '@/stores/country'
import { todayIn } from '@/utils/format'
import { http } from '@/api/http'
import MoneyText from '@/components/MoneyText.vue'
import QtyText from '@/components/QtyText.vue'

type DailySummary = {
  date: string
  orderCount?: number | null
  orderAmount?: number | string | null
  outboundQty?: number | string | null
  outboundAmount?: number | string | null
  cash?: number | string | null
  transfer?: number | string | null
  pendingConfirm?: number | string | null
  currency?: string
}
const country = useCountryStore()
const date = ref(todayIn(country.timezone))
const data = ref<DailySummary | null>(null)
const loading = ref(false)
const error = ref('')
const hasPending = computed(() => Number(data.value?.pendingConfirm) > 0)
let requestVersion = 0
let disposed = false
function current(request: number, epoch: number) {
  return !disposed && request === requestVersion && epoch === country.epoch
}
async function load() {
  if (disposed) return
  const request = ++requestVersion
  const epoch = country.epoch
  const selectedDate = date.value
  data.value = null
  error.value = ''
  if (!selectedDate) {
    loading.value = false
    error.value = '请选择统计日期'
    return
  }
  loading.value = true
  try {
    const result = await http.get<DailySummary>('/sal/store-daily', { date: selectedDate }, { silent: true })
    if (!current(request, epoch)) return
    if (result?.date !== selectedDate) throw new Error('日报返回的统计日期不匹配，请重新加载')
    data.value = result
  } catch (cause) {
    if (current(request, epoch)) {
      error.value = cause instanceof Error && cause.message.trim() ? cause.message : '门店日报读取失败，请重新加载'
    }
  } finally {
    if (current(request, epoch)) loading.value = false
  }
}
function goToday() {
  date.value = todayIn(country.timezone)
  return load()
}
onMounted(load)
onBeforeUnmount(() => { disposed = true })
</script>

<template>
  <div class="page store-daily" :aria-busy="loading">
    <header class="page-card daily-header">
      <div class="page-title">
        <div>
          <h2 id="store-daily-title">门店日报</h2>
          <p class="muted daily-description">按所选业务日期汇总当前授权范围的订单、出库和收款。</p>
        </div>
      </div>
      <div class="date-controls">
        <label for="store-daily-date">统计日期</label>
        <el-date-picker
          id="store-daily-date"
          v-model="date"
          type="date"
          format="YYYY-MM-DD"
          value-format="YYYY-MM-DD"
          :clearable="false"
          :editable="false"
          @change="load"
        />
        <el-button :disabled="loading" @click="goToday">今天</el-button>
        <el-button type="primary" :icon="Refresh" :loading="loading" @click="load">刷新</el-button>
      </div>
    </header>

    <div v-if="loading" class="page-card state-panel" role="status" aria-live="polite">
      <p class="muted">正在读取 {{ date }} 的门店日报…</p>
      <el-skeleton :rows="3" animated />
    </div>
    <div v-else-if="error" class="page-card state-panel" role="alert">
      <el-alert title="日报读取失败" :description="error" type="error" :closable="false" show-icon />
      <el-button class="retry-button" type="primary" @click="load">重新加载</el-button>
    </div>
    <template v-else-if="data">
      <section class="daily-metrics" aria-labelledby="store-daily-title">
        <article class="page-card metric-card">
          <h3>订单</h3>
          <div class="metric-value"><QtyText :value="data.orderCount" unit="单" /></div>
          <dl class="metric-detail">
            <dt>订单金额</dt>
            <dd><MoneyText :value="data.orderAmount" :currency="data.currency" /></dd>
          </dl>
        </article>
        <article class="page-card metric-card">
          <h3>出库数量</h3>
          <div class="metric-value"><QtyText :value="data.outboundQty" /></div>
          <dl class="metric-detail">
            <dt>出库金额</dt>
            <dd><MoneyText :value="data.outboundAmount" :currency="data.currency" /></dd>
          </dl>
        </article>
        <article class="page-card metric-card">
          <h3>现金收款</h3>
          <div class="metric-value"><MoneyText :value="data.cash" :currency="data.currency" /></div>
        </article>
        <article class="page-card metric-card">
          <h3>转账收款</h3>
          <div class="metric-value"><MoneyText :value="data.transfer" :currency="data.currency" /></div>
        </article>
      </section>
      <section class="page-card pending-card" :class="{ 'has-pending': hasPending }" aria-labelledby="pending-title">
        <div>
          <h3 id="pending-title">待确认到账</h3>
          <p class="muted">已包含在现金和转账收款统计中，不另行累加。</p>
        </div>
        <MoneyText class="pending-amount" :value="data.pendingConfirm" :currency="data.currency" />
      </section>
    </template>
  </div>
</template>

<style scoped>
.store-daily { min-width: 0; }
.daily-description { margin: 8px 0 0; line-height: 1.6; }
.date-controls { display: flex; align-items: center; flex-wrap: wrap; gap: 8px; }
.date-controls label { color: var(--el-text-color-regular); font-size: 14px; }
.date-controls :deep(.el-date-editor) { width: 160px; flex: 0 1 160px; }
.date-controls .el-button + .el-button { margin-left: 0; }
.daily-metrics { display: grid; grid-template-columns: repeat(4, minmax(0, 1fr)); gap: 16px; margin-bottom: 16px; }
.metric-card { min-width: 0; margin-bottom: 0; }
.metric-card h3, .pending-card h3 { margin: 0; font-size: 14px; font-weight: 500; color: var(--el-text-color-regular); }
.metric-value { margin: 12px 0; font-size: 28px; font-weight: 600; line-height: 1.4; font-variant-numeric: tabular-nums; overflow-wrap: anywhere; }
.metric-detail { display: flex; flex-wrap: wrap; align-items: baseline; justify-content: space-between; gap: 8px; margin: 0; font-size: 13px; }
.metric-detail dt { color: var(--el-text-color-secondary); }
.metric-detail dd { min-width: 0; margin: 0; text-align: right; overflow-wrap: anywhere; }
.pending-card { display: flex; align-items: center; justify-content: space-between; gap: 16px; }
.pending-card > div { min-width: 0; }
.pending-card p { margin: 8px 0 0; line-height: 1.6; }
.pending-amount { min-width: 0; font-size: 24px; font-weight: 600; text-align: right; overflow-wrap: anywhere; }
.has-pending h3, .has-pending .pending-amount { color: var(--el-color-warning-dark-2); }
.state-panel { min-height: 180px; }
.state-panel p { margin: 0 0 16px; }
.retry-button { margin-top: 12px; }
.date-controls :deep(button:focus-visible), .retry-button:focus-visible { outline: 2px solid var(--el-color-primary); outline-offset: 3px; }
@media (max-width: 1199px) {
  .daily-metrics { grid-template-columns: repeat(2, minmax(0, 1fr)); }
}
@media (max-width: 768px) {
  .daily-metrics { grid-template-columns: minmax(0, 1fr); gap: 12px; }
  .date-controls label { flex-basis: 100%; }
  .pending-card { align-items: flex-start; flex-direction: column; gap: 12px; }
  .pending-amount { text-align: left; }
}
</style>
