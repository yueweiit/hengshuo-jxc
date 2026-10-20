<script setup lang="ts">
import { computed, onMounted, ref } from 'vue'
import CrudPage from '@/components/crud/CrudPage.vue'
import type { ColumnDef, FieldDef } from '@/components/crud/types'
import { http } from '@/api/http'
import { allRecords } from '@/api/pagination'
import { ALLOC_BASES, COST_TREATMENTS, FEE_CATEGORIES, STATUS_OPTIONS } from './options'
const mockMode = import.meta.env.MODE === 'demo' && import.meta.env.VITE_USE_MOCK === 'true', books = ref<Record<string, any>[]>([]), bookId = ref<number>(), accounts = ref<Record<string, any>[]>([])
const treatments = mockMode ? COST_TREATMENTS : [...COST_TREATMENTS, { value: 'EXPENSE', label: '期间费用（兼容原配置）' }]
const columns: ColumnDef[] = [{ prop: 'code', label: '编码', width: 120 }, { prop: 'name', label: '名称', minWidth: 140 }, { prop: 'feeCategory', label: '费用类别', type: 'option', options: FEE_CATEGORIES, width: 110 }, { prop: 'costTreatment', label: '成本处理', type: 'option', options: treatments, width: 130 }, { prop: 'accountId', label: '会计科目 ID', width: 120 }, { prop: 'defaultAllocBasis', label: '默认分摊依据', type: 'option', options: ALLOC_BASES, width: 120 }, { prop: 'status', label: '状态', type: 'status', width: 80 }]
const searchFields: FieldDef[] = [{ prop: 'keyword', label: '关键字' }, { prop: 'feeCategory', label: '费用类别', type: 'select', options: FEE_CATEGORIES }, { prop: 'status', label: '状态', type: 'select', options: STATUS_OPTIONS }]
const formFields = computed<FieldDef[]>(() => [
  { prop: 'code', label: '编码', required: true, editDisabled: true }, { prop: 'name', label: '名称', required: true }, { prop: 'feeCategory', label: '费用类别', type: 'select', options: FEE_CATEGORIES, required: true }, { prop: 'costTreatment', label: '成本处理', type: 'select', options: treatments, required: true, default: 'CAPITALIZE' },
  ...(!mockMode ? [{ prop: 'bookId', label: '科目所属账套', type: 'select' as const, options: books.value.filter(b => b.id === bookId.value).map(b => ({ value: b.id, label: b.name })), default: bookId.value, editDisabled: true }, { prop: 'accountId', label: '会计科目', type: 'select' as const, options: accounts.value.filter(a => a.isLeaf && a.status === 'ENABLED').map(a => ({ value: a.id, label: a.code + ' ' + a.name })), tip: '按费用项目取科目时使用本关联；留空保持缺映射阻断' }] : []),
  ...(mockMode ? [{ prop: 'defaultAllocBasis', label: '默认分摊依据', type: 'select' as const, options: ALLOC_BASES, default: 'QTY' }] : []),
])
let accountRequest = 0
async function loadAccounts() { const request = ++accountRequest, selected = bookId.value; accounts.value = []; if (!selected || mockMode) return; const rows = await allRecords<Record<string, any>>('/fin/accounts', { bookId: selected }); if (request === accountRequest && selected === bookId.value) accounts.value = rows }
function beforeOpen(row: Record<string, unknown>, mode: 'create' | 'edit') { if (!mockMode && mode === 'edit' && row.bookId) { bookId.value = Number(row.bookId); void loadAccounts() } return !mockMode && !row.bookId ? { ...row, bookId: bookId.value } : row }
onMounted(async () => { if (!mockMode) { books.value = await http.get('/org/books'); if (books.value.length === 1) { bookId.value = books.value[0]!.id; await loadAccounts() } } })
</script>
<template>
  <CrudPage title="费用项目" resource="/md/expense-items" :columns="columns" :search-fields="searchFields" :form-fields="formFields" edit-perm="md:expense-item:edit" audit-type="expense-item" :before-open="beforeOpen">
    <template #header><p class="muted">费用项目直接关联本账套科目，供已复核的凭证映射使用；保存配置不会生成或记账凭证。</p><el-form v-if="!mockMode" inline><el-form-item label="配置科目的账套"><el-select v-model="bookId" @change="loadAccounts"><el-option v-for="b in books" :key="b.id" :label="b.name" :value="b.id" /></el-select></el-form-item></el-form></template>
  </CrudPage>
</template>
