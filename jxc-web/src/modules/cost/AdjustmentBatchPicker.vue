<script setup lang="ts">
import { onBeforeUnmount, reactive, ref, watch } from 'vue'
import { http } from '@/api/http'
import { useCountryStore } from '@/stores/country'
import { useUserStore } from '@/stores/user'
import { getCountryId, getToken } from '@/utils/session'
import ProductCell from '@/components/biz/ProductCell.vue'
import QtyText from '@/components/QtyText.vue'
import { formatDate } from '@/utils/format'
import { COST_STATUS, optionText } from '@/modules/shared/bizOptions'

type Row = Record<string, any> // eslint-disable-line @typescript-eslint/no-explicit-any
type Result = { records: Row[]; total: number; books: Row[]; warehouses: Row[] }
const props = defineProps<{ target: string; bookId?: number }>()
const emit = defineEmits<{ select: [row: Row] }>()
const country = useCountryStore(), user = useUserStore()
const visible = ref(false), loading = ref(false), error = ref('')
const rows = ref<Row[]>([]), total = ref(0), books = ref<Row[]>([]), warehouses = ref<Row[]>([])
const query = reactive({ keyword: '', bookId: undefined as number | undefined, warehouseId: undefined as number | undefined, page: 1, size: 20 })
let request = 0
const context = () => `${country.epoch}:${getCountryId()}:${getToken()}:${props.target}:${props.bookId}`

function close() {
  request++; visible.value = false; loading.value = false; error.value = ''
  rows.value = []; total.value = 0; books.value = []; warehouses.value = []
}
async function open() {
  Object.assign(query, { keyword: '', bookId: props.bookId, warehouseId: undefined, page: 1 })
  visible.value = true
  await load()
}
async function load() {
  const currentRequest = ++request, scope = context()
  const current = () => currentRequest === request && scope === context() && visible.value
  loading.value = true; error.value = ''; rows.value = []; total.value = 0
  try {
    const data = await http.get<Result>('/cst/adjustment-batches', { ...query, target: props.target }, { silent: true })
    if (!current()) return
    if (!Array.isArray(data.records) || !Number.isFinite(data.total) || !Array.isArray(data.books) || !Array.isArray(data.warehouses)) throw new Error('批次查询返回格式不正确，请重试')
    rows.value = data.records; total.value = data.total; books.value = data.books; warehouses.value = data.warehouses
  } catch (failure) {
    if (current()) error.value = failure instanceof Error ? failure.message : '批次查询失败，请重试'
  } finally { if (current()) loading.value = false }
}
function search() { query.page = 1; load() }
function choose(row: Row) {
  if (loading.value || !visible.value || row.selectable !== true || !Number.isSafeInteger(row.batchId) || row.batchId <= 0) return
  emit('select', row); close()
}
watch(() => [country.epoch, user.token, props.target, props.bookId], close)
onBeforeUnmount(close)
defineExpose({ open })
</script>

<template>
  <el-dialog v-model="visible" title="选择成本批次" width="min(1100px, 96vw)" destroy-on-close @close="close">
    <p class="picker-intro">{{ props.target === 'INVENTORY' ? '选择仍有库存、成本完整的批次。' : '选择需要调整已售成本的来源批次，已无库存的历史批次也可选择。' }} 库存数量包含冻结部分。</p>
    <el-form inline class="search-form" :disabled="loading" @submit.prevent="search">
      <el-form-item label="批次 / 商品"><el-input v-model="query.keyword" placeholder="批次号、商品编码或名称" clearable class="keyword" /></el-form-item>
      <el-form-item label="账套"><el-select v-model="query.bookId" placeholder="全部账套" clearable :disabled="props.bookId != null" @change="search"><el-option v-for="book in books" :key="book.id" :label="book.name" :value="book.id" /></el-select></el-form-item>
      <el-form-item label="来源仓库"><el-select v-model="query.warehouseId" placeholder="全部来源仓库" clearable @change="search"><el-option v-for="warehouse in warehouses" :key="warehouse.id" :label="warehouse.name" :value="warehouse.id" /></el-select></el-form-item>
      <el-form-item><el-button type="primary" native-type="submit" :loading="loading">查询</el-button></el-form-item>
    </el-form>
    <div v-if="error" class="query-error" role="alert"><el-alert :title="error" type="error" :closable="false" show-icon /><el-button @click="load">重新加载</el-button></div>
    <template v-else>
      <div class="table-scroll" v-loading="loading" :aria-busy="loading">
        <el-table :data="rows" row-key="batchId" border stripe max-height="440" :empty-text="loading ? '正在读取批次…' : query.keyword || query.bookId || query.warehouseId ? '没有匹配的成本批次，请调整筛选条件' : '当前授权范围内没有成本批次'">
          <el-table-column label="批次 / 原入库日期" min-width="180"><template #default="{ row }"><span class="mono">{{ row.batchNo }}</span><div class="muted">{{ formatDate(row.bizDate) }} · #{{ row.batchId }}</div></template></el-table-column>
          <el-table-column label="商品" min-width="200"><template #default="{ row }"><ProductCell :code="row.productCode" :name="row.productName" :extra="row.spec" /></template></el-table-column>
          <el-table-column label="账套 / 来源仓库" min-width="160"><template #default="{ row }">{{ row.bookName }}<div class="muted">{{ row.warehouseName }}</div></template></el-table-column>
          <el-table-column label="当前库存" width="125" align="right"><template #default="{ row }"><QtyText :value="row.onHandQty" :unit="row.baseUnit" /></template></el-table-column>
          <el-table-column label="单位成本" min-width="190" align="right"><template #default="{ row }"><span class="mono">{{ row.unitCost ?? '待补' }}</span> {{ row.baseCurrency }}<div class="muted">{{ optionText(COST_STATUS, row.costStatus) }}</div></template></el-table-column>
          <el-table-column label="操作" min-width="180" fixed="right"><template #default="{ row }"><el-button link type="primary" :disabled="loading || !row.selectable" @click="choose(row)">选择此批次</el-button><div v-if="!row.selectable" class="unavailable">{{ row.unavailableReason }}</div></template></el-table-column>
        </el-table>
      </div>
      <el-pagination v-model:current-page="query.page" v-model:page-size="query.size" class="pagination" :page-sizes="[20, 50, 100]" :total="total" :disabled="loading" layout="total, sizes, prev, pager, next" @current-change="load" @size-change="search" />
    </template>
    <template #footer><span class="footer-note">选择批次后，返回表单填写调整金额和原因。</span><el-button @click="close">取消</el-button></template>
  </el-dialog>
</template>

<style scoped>
.picker-intro { margin: 0 0 16px; color: var(--el-text-color-regular); line-height: 1.6; }
.search-form .el-select { width: 150px; }
.keyword { width: 230px; }
.pagination { margin-top: 16px; justify-content: flex-end; flex-wrap: wrap; gap: 8px; }
.query-error { display: flex; align-items: center; gap: 12px; }
.unavailable { font-size: 12px; line-height: 1.5; color: var(--el-color-warning-dark-2); }
.footer-note { margin-right: 16px; color: var(--el-text-color-secondary); font-size: 13px; }
@media (max-width: 768px) {
  .search-form .el-form-item, .search-form .el-select, .keyword { width: 100%; }
  .footer-note { display: block; margin: 0 0 12px; text-align: left; }
  .query-error { flex-wrap: wrap; }
}
</style>
