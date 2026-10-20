<script setup lang="ts">
import { onMounted, ref } from 'vue'
import { http } from '@/api/http'
import { useRouter } from 'vue-router'
import { useCountryStore } from '@/stores/country'
const country = useCountryStore()
const router = useRouter(), books = ref<Record<string, any>[]>([]), periods = ref<Record<string, any>[]>([]), bookId = ref<number>(), periodId = ref<number>()
const data = ref<Record<string, any> | null>(null)
async function load() { data.value = null; if (bookId.value && periodId.value) data.value = await http.get('/fin/trial-balance', { bookId: bookId.value, periodId: periodId.value }) }
function changeBook() { periodId.value = undefined; data.value = null; periods.value = books.value.find(b => b.id === bookId.value)?.periods || [] }
function openLedger(row: Record<string, any>) { router.push({ path: '/finance/ledgers', query: { bookId: bookId.value, periodId: periodId.value, accountId: row.accountId } }) }
onMounted(async () => { books.value = await http.get('/fin/books') })
</script>
<template>
  <el-card><template #header>试算平衡 {{ data?.periodName }} · {{ books.find(b => b.id === bookId)?.baseCurrency || country.currency }} · {{ country.timezone }}</template><el-form inline><el-form-item label="账套"><el-select v-model="bookId" @change="changeBook"><el-option v-for="b in books" :key="b.id" :value="b.id" :label="b.name" /></el-select></el-form-item><el-form-item label="期间"><el-select v-model="periodId" @change="load"><el-option v-for="p in periods" :key="p.id" :value="p.id" :label="p.name" /></el-select></el-form-item></el-form>
    <el-alert v-if="data" :type="data.balanced ? 'success' : 'error'" :closable="false" :title="data.balanced ? '借方合计等于贷方合计，与总账一致' : '借贷不平'" /><p v-if="data">期初：借 {{ data.openingDebit }} · 贷 {{ data.openingCredit }}；本期发生：借 {{ data.periodDebit }} · 贷 {{ data.periodCredit }}；期末：借 {{ data.debit }} · 贷 {{ data.credit }}</p>
    <el-table v-if="data" :data="data.rows" size="small" @row-click="openLedger"><el-table-column prop="code" label="科目" width="90" /><el-table-column prop="name" label="名称" /><el-table-column prop="openingDebit" label="期初借" /><el-table-column prop="openingCredit" label="期初贷" /><el-table-column prop="periodDebit" label="本期借" /><el-table-column prop="periodCredit" label="本期贷" /><el-table-column prop="closingDebit" label="借方余额" /><el-table-column prop="closingCredit" label="贷方余额" /></el-table><el-empty v-else description="请选择账套和期间" />
  </el-card>
</template>
