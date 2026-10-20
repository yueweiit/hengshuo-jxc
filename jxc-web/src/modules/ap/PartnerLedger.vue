<script setup lang="ts">
import { computed, onMounted, reactive, ref, watch } from 'vue'
import { useRoute, useRouter } from 'vue-router'
import { ElMessage } from 'element-plus'
import { useCountryStore } from '@/stores/country'
import { useUserStore } from '@/stores/user'
import { allRecords } from '@/api/pagination'
import { http, createCommandIntent } from '@/api/http'
import MoneyText from '@/components/MoneyText.vue'
import DateTimeText from '@/components/DateTimeText.vue'

const country = useCountryStore(), user = useUserStore(), exportIntent = createCommandIntent()
const books = ref<Row[]>([]), currencies = ref<Row[]>([])
type Row = Record<string, any> // eslint-disable-line @typescript-eslint/no-explicit-any
const statementIntent = createCommandIntent()
const route = useRoute()
const router = useRouter()
const id = computed(() => Number(route.params.id))
const bal = ref<Row>({})
const timeline = ref<Row[]>([])
const form = reactive({ bookId: undefined as number | undefined, currency: country.currency, periodStart: '', periodEnd: '', result: null as Row | null })
async function load() {
  bal.value = await http.get(`/ap/partners/${id.value}/balances`)
  timeline.value = await http.get(`/ap/partners/${id.value}/timeline`)
}
async function statement() {
  if (!form.bookId) return ElMessage.warning('请选择对账账套')
  form.result = await http.postIdem('/ap/statements', { bookId: form.bookId, partnerId: id.value, currency: form.currency, periodStart: form.periodStart, periodEnd: form.periodEnd }, statementIntent)
  ElMessage.success(form.result?.identityOk ? '期初与期间明细已核对' : '已生成，请核对')
}
async function exportStatement() { const result = form.result; if (!result?.id || !result.bookId) return; await http.postIdem('/ap/statements/' + result.id + '/export', { bookId: result.bookId }, exportIntent); exportIntent.reset(); ElMessage.success('导出任务已创建'); await router.push('/jobs') }
watch(id, () => { form.result = null; load() })
onMounted(async () => { [books.value, currencies.value] = await Promise.all([http.get<Row[]>('/org/books'), allRecords<Row>('/md/currencies')]); form.bookId = route.query.bookId ? Number(route.query.bookId) : books.value.length === 1 ? books.value[0]!.id : undefined; await load() })
</script>

<template>
  <div>
    <el-button link @click="router.push('/ap/bills')">返回账单</el-button>
    <h2>{{ bal.partnerName }}</h2>
    <el-table :data="bal.byCurrency ?? []" size="small">
      <el-table-column prop="currency" label="币种" width="80" />
      <el-table-column label="未付应付"><template #default="{ row }"><MoneyText :value="row.openAp" :currency="row.currency" /></template></el-table-column>
      <el-table-column label="预付余额"><template #default="{ row }"><MoneyText :value="row.prepaid" :currency="row.currency" /></template></el-table-column>
      <el-table-column label="付款未核销"><template #default="{ row }"><MoneyText :value="row.paymentOpen" :currency="row.currency" /></template></el-table-column>
      <el-table-column label="贷项"><template #default="{ row }"><MoneyText :value="row.creditOpen" :currency="row.currency" /></template></el-table-column>
    </el-table>
    <el-form inline class="mt">
      <el-form-item label="账套"><el-select v-model="form.bookId" @change="form.result = null"><el-option v-for="book in books" :key="book.id" :label="book.name" :value="book.id" /></el-select></el-form-item><el-form-item label="币种"><el-select v-model="form.currency" style="width: 100px"><el-option v-for="currency in currencies" :key="currency.code" :label="currency.code" :value="currency.code" /></el-select></el-form-item>
      <el-form-item label="期间"><el-date-picker v-model="form.periodStart" value-format="YYYY-MM-DD" /><span> 至 </span><el-date-picker v-model="form.periodEnd" value-format="YYYY-MM-DD" /></el-form-item>
      <el-button type="primary" :disabled="!form.bookId" @click="statement">生成对账单</el-button><el-button v-if="form.result && user.hasPerm('ap:statement:export')" @click="exportStatement">导出已保存对账单</el-button>
    </el-form>
    <el-alert v-if="form.result" :type="form.result.identityOk ? 'success' : 'warning'" :title="`期初 ${form.result.opening} + 账单 ${form.result.increase} − 付款核销 ${form.result.paid} − 抵扣 ${form.result.offset} + 调整 ${form.result.adjust} = 期末 ${form.result.closing}`" show-icon :closable="false" />
    <el-timeline class="mt">
      <el-timeline-item v-for="(t, i) in timeline" :key="i"><DateTimeText :value="t.at" /> {{ t.type }} {{ t.no }} {{ t.currency }} {{ t.amount }}</el-timeline-item>
    </el-timeline>
  </div>
</template>

<style scoped>
.mt { margin-top: 16px; }
</style>
