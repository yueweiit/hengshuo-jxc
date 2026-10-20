<script setup lang="ts">
import { computed, onMounted, ref, watch } from 'vue'
import { useRoute, useRouter } from 'vue-router'
import { http } from '@/api/http'
import MoneyText from '@/components/MoneyText.vue'
import DateTimeText from '@/components/DateTimeText.vue'

type Row = Record<string, any> // eslint-disable-line @typescript-eslint/no-explicit-any
const route = useRoute()
const router = useRouter()
const id = computed(() => Number(route.params.id))
const bal = ref<Row>({})
const timeline = ref<Row[]>([])
async function load() {
  bal.value = await http.get(`/ar/customers/${id.value}/balances`)
  timeline.value = await http.get(`/ar/customers/${id.value}/timeline`)
}
watch(id, load)
onMounted(load)
</script>

<template>
  <div>
    <el-button link @click="router.push('/ar/receivables')">返回应收</el-button>
    <h2>{{ bal.customerName }}</h2>
    <el-row :gutter="12">
      <el-col :span="6"><el-card><div class="k">未结应收</div><MoneyText :value="bal.openAr" :currency="bal.currency" /></el-card></el-col>
      <el-col :span="6"><el-card><div class="k">预收余额</div><MoneyText :value="bal.prepaid" :currency="bal.currency" /></el-card></el-col>
      <el-col :span="6"><el-card><div class="k">可退款</div><MoneyText :value="bal.refundable" :currency="bal.currency" /></el-card></el-col>
      <el-col :span="6"><el-card><div class="k">授信已用 / 额度</div><MoneyText :value="bal.used" :currency="bal.currency" /> / <MoneyText :value="bal.limit" :currency="bal.currency" /></el-card></el-col>
    </el-row>
    <el-timeline class="mt">
      <el-timeline-item v-for="(t, i) in timeline" :key="i">
        <DateTimeText :value="t.at" /> {{ t.type }} {{ t.no }} <MoneyText v-if="t.amount != null" :value="t.amount" :currency="bal.currency" />
      </el-timeline-item>
    </el-timeline>
  </div>
</template>

<style scoped>
.k { color: var(--el-text-color-secondary); margin-bottom: 6px; }
.mt { margin-top: 16px; }
</style>
