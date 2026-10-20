<script setup lang="ts">
import { onMounted, ref } from 'vue'
import { useCountryStore } from '@/stores/country'
import { todayIn } from '@/utils/format'
import { http } from '@/api/http'
import MoneyText from '@/components/MoneyText.vue'

type Row = Record<string, any> // eslint-disable-line @typescript-eslint/no-explicit-any
const country = useCountryStore()
const date = ref(todayIn(country.timezone))
const data = ref<Row>({})
async function load() {
  data.value = await http.get('/sal/store-daily', { date: date.value })
}
onMounted(load)
</script>

<template>
  <div>
    <div class="head">
      <h2>门店日报</h2>
      <el-date-picker v-model="date" value-format="YYYY-MM-DD" @change="load" />
    </div>
    <p class="muted">按自然日汇总本范围的订单、出库和收款。这是日报，不是交班。</p>
    <el-row :gutter="12">
      <el-col :span="6"><el-card><div class="k">订单</div><div class="v">{{ data.orderCount ?? 0 }}</div><MoneyText :value="data.orderAmount" :currency="data.currency" /></el-card></el-col>
      <el-col :span="6"><el-card><div class="k">出库数量</div><div class="v">{{ data.outboundQty ?? 0 }}</div><MoneyText :value="data.outboundAmount" :currency="data.currency" /></el-card></el-col>
      <el-col :span="6"><el-card><div class="k">现金</div><MoneyText :value="data.cash" :currency="data.currency" /></el-card></el-col>
      <el-col :span="6"><el-card><div class="k">转账</div><MoneyText :value="data.transfer" :currency="data.currency" /><div class="muted">待确认 <MoneyText :value="data.pendingConfirm" :currency="data.currency" /></div></el-card></el-col>
    </el-row>
  </div>
</template>

<style scoped>
.head { display: flex; justify-content: space-between; align-items: center; }
.k { color: var(--el-text-color-secondary); }
.v { font-size: 28px; margin: 6px 0; }
</style>
