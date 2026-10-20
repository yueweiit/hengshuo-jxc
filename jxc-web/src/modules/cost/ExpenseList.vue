<script setup lang="ts">
import { computed, onMounted, reactive, ref } from 'vue'
import { ElMessage } from 'element-plus'
import { http, createCommandIntent } from '@/api/http'
import { allRecords } from '@/api/pagination'
import StatusTag from '@/components/StatusTag.vue'
import { useCountryStore } from '@/stores/country'
import { useUserStore } from '@/stores/user'
import { todayIn } from '@/utils/format'

const user = useUserStore()
const canReadItems = computed(() => user.hasPerm(['md:expense-item:edit', 'pur:order:create', 'lgs:shipment:create', 'lgs:fee:create', 'ap:bill:view', 'cst:expense:create']))
const mockMode = import.meta.env.MODE === 'demo' && import.meta.env.VITE_USE_MOCK === 'true', country = useCountryStore()
const rows = ref<Record<string, any>[]>([])
const items = ref<Record<string, any>[]>([])
const books = ref<Record<string, any>[]>([]), currencies = ref<Record<string, any>[]>([]), saving = ref(false), saveIntent = createCommandIntent()
const form = reactive({ expenseItemId: null as number | null, amount: 0, bizDate: todayIn(country.timezone), productId: null as number | null, bookId: undefined as number | undefined, currency: country.currency })
const decimals = computed(() => currencies.value.find(c => c.code === form.currency)?.decimals ?? 2)
async function load() {
  rows.value = (await allRecords<Record<string, any>>('/cst/expenses', { ...(!mockMode && form.bookId ? { bookId: form.bookId } : {}) }))
  const res = canReadItems.value ? await allRecords<Record<string, any>>('/md/expense-items') : []
  items.value = res.filter((i) => i.costTreatment !== 'CAPITALIZE')
  for (const row of rows.value) row.itemName ??= items.value.find(i => i.id === row.expenseItemId)?.name ?? (row.expenseItemId == null ? '—' : `#${row.expenseItemId}`)
}
async function create() {
  if (saving.value) return
  if (!mockMode && !form.bookId) return ElMessage.warning('请明确选择费用所属账套')
  saving.value = true
  try {
    const item = items.value.find((i) => i.id === form.expenseItemId)
    const lines = item?.costTreatment === 'DIRECT_SELLING' ? [{ productId: form.productId, amount: form.amount }] : []
    const payload = mockMode ? { expenseItemId: form.expenseItemId, amount: form.amount, bizDate: form.bizDate, productId: form.productId, lines } : { ...form, lines }
    await http.postIdem('/cst/expenses', payload, saveIntent)
    saveIntent.reset(); form.amount = 0; form.productId = null
    ElMessage.success('费用已登记'); await load()
  } finally { saving.value = false }
}
async function chooseBook() { form.currency = books.value.find(b => b.id === form.bookId)?.baseCurrency || country.currency; await load() }
onMounted(async () => {
  if (!mockMode) {
    const [available, money] = await Promise.all([http.get<Record<string, any>[]>('/org/books'), allRecords<Record<string, any>>('/md/currencies')])
    books.value = available.filter(b => b.status === 'ACTIVE'); currencies.value = money.filter(c => c.status === 'ENABLED')
    if (books.value.length === 1) { form.bookId = books.value[0]!.id; form.currency = books.value[0]!.baseCurrency }
  }
  await load()
})
</script>

<template>
  <el-card>
    <template #header>费用登记</template>
    <p class="muted">资本化费用走分摊。这里只登记期间费用和直接销售费用，已进入库存成本的费用不会在利润里再扣一次。</p>
    <el-form inline :disabled="saving">
      <el-form-item v-if="!mockMode" label="账套"><el-select v-model="form.bookId" placeholder="请选择账套" @change="chooseBook"><el-option v-for="b in books" :key="b.id" :label="b.name" :value="b.id" /></el-select></el-form-item>
      <el-form-item label="项目">
        <el-select v-model="form.expenseItemId" style="width: 180px"><el-option v-for="i in items" :key="i.id" :label="i.name" :value="i.id" /></el-select>
      </el-form-item>
      <el-form-item v-if="!mockMode" label="币种"><el-select v-model="form.currency" style="width: 110px"><el-option v-for="c in currencies" :key="c.code" :label="c.code" :value="c.code" /></el-select></el-form-item>
      <el-form-item label="金额"><el-input-number v-model="form.amount" :min="0" :precision="mockMode ? undefined : decimals" /></el-form-item>
      <el-form-item label="日期"><el-input v-if="mockMode" v-model="form.bizDate" :placeholder="todayIn(country.timezone)" style="width: 130px" /><el-date-picker v-else v-model="form.bizDate" value-format="YYYY-MM-DD" /></el-form-item>
      <el-form-item label="商品"><el-input-number v-model="form.productId" /></el-form-item>
      <el-button v-if="user.hasPerm('cst:expense:create') && user.hasPerm('cst:expense:confirm')" type="primary" :loading="saving" :disabled="!mockMode && !form.bookId" @click="create">登记</el-button>
    </el-form>
    <el-table :data="rows" size="small">
      <el-table-column prop="docNo" label="单号" />
      <el-table-column prop="itemName" label="项目" />
      <el-table-column prop="treatment" label="处理" />
      <el-table-column prop="amount" label="金额" />
      <el-table-column prop="currency" label="币种" width="80" />
      <el-table-column label="状态" width="100"><template #default="{ row }"><StatusTag :status="row.status" /></template></el-table-column>
    </el-table>
  </el-card>
</template>
