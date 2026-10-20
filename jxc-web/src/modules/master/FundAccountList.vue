<script setup lang="ts">
import { computed, onMounted, ref } from 'vue'
import CrudPage from '@/components/crud/CrudPage.vue'
import type { ColumnDef, FieldDef, OptionSource } from '@/components/crud/types'
import { http } from '@/api/http'
import { allRecords } from '@/api/pagination'
import { useCountryStore } from '@/stores/country'
import { ACCOUNT_TYPES, CURRENCY_SOURCE, ENTITY_SOURCE, STATUS_OPTIONS, STORE_SOURCE } from './options'
const country = useCountryStore(), mockMode = import.meta.env.MODE === 'demo' && import.meta.env.VITE_USE_MOCK === 'true'
const books = ref<Record<string, any>[]>([]), bookId = ref<number>(), accounts = ref<Record<string, any>[]>([])
const bookOptions = computed(() => books.value.map(b => ({ value: b.id, label: b.name })))
const accountOptions = computed(() => accounts.value.filter(a => a.isLeaf && a.status === 'ENABLED' && (a.isCash || a.isBank)).map(a => ({ value: a.id, label: a.code + ' ' + a.name + (a.isCash ? '（现金）' : '（银行）') })))
const limited = (source: OptionSource): OptionSource => !Array.isArray(source) && 'remote' in source ? { ...source, params: { ...source.params, size: 200 } } : source
const columns: ColumnDef[] = [
  { prop: 'name', label: '账户名称', minWidth: 160 }, { prop: 'accountType', label: '类型', type: 'option', options: ACCOUNT_TYPES, width: 80 }, { prop: 'currency', label: '币种', width: 80 },
  { prop: 'entityName', label: '所属主体', minWidth: 140 }, { prop: 'storeName', label: '所属门店', minWidth: 140 }, { prop: 'bookId', label: '账套 ID', width: 100 }, { prop: 'glAccountId', label: '会计科目 ID', width: 120 },
  { prop: 'bankName', label: '开户行', minWidth: 130 }, { prop: 'accountNoMasked', label: '账号', width: 120 }, { prop: 'status', label: '状态', type: 'status', width: 80 },
]
const searchFields: FieldDef[] = [{ prop: 'keyword', label: '关键字' }, { prop: 'accountType', label: '类型', type: 'select', options: ACCOUNT_TYPES }, { prop: 'storeId', label: '门店', type: 'select', options: limited(STORE_SOURCE) }, { prop: 'status', label: '状态', type: 'select', options: STATUS_OPTIONS }]
const formFields = computed<FieldDef[]>(() => [
  { prop: 'name', label: '账户名称', required: true }, { prop: 'accountType', label: '类型', type: 'select', options: ACCOUNT_TYPES, required: true, default: 'BANK' }, { prop: 'currency', label: '币种', type: 'select', options: limited(CURRENCY_SOURCE), required: true },
  { prop: 'entityId', label: '所属主体', type: 'select', options: limited(ENTITY_SOURCE), required: true }, { prop: 'storeId', label: '所属门店', type: 'select', options: limited(STORE_SOURCE), tip: '须与账套主体一致；留空表示公司账户' },
  ...(!mockMode ? [{ prop: 'bookId', label: '所属账套', type: 'select' as const, options: bookOptions.value.filter(b => b.value === bookId.value), required: true, editDisabled: true, default: bookId.value }, { prop: 'glAccountId', label: '会计科目', type: 'select' as const, options: accountOptions.value, tip: '仅选择本账套现金/银行科目；留空时自动凭证将阻断并提示缺映射' }] : []),
  { prop: 'bankName', label: '开户行' }, { prop: 'accountNo', label: '银行账号', placeholder: '留空表示不修改', tip: '加密保存，只显示后四位' },
])
let accountRequest = 0
async function loadAccounts() { const request = ++accountRequest, selected = bookId.value; accounts.value = []; if (!selected || mockMode) return; const rows = await allRecords<Record<string, any>>('/fin/accounts', { bookId: selected }); if (request === accountRequest && selected === bookId.value) accounts.value = rows }
function beforeOpen(row: Record<string, unknown>, mode: 'create' | 'edit'): Record<string, unknown> { if (!mockMode && mode === 'edit' && row.bookId) { bookId.value = Number(row.bookId); void loadAccounts() } return mode === 'create' ? { ...row, currency: country.currency, ...(!mockMode ? { bookId: bookId.value, entityId: books.value.find(b => b.id === bookId.value)?.entityId } : {}) } : { ...row, ...(!mockMode && !row.bookId ? { bookId: bookId.value } : {}) } }
onMounted(async () => { if (!mockMode) { books.value = await http.get('/org/books'); if (books.value.length === 1) { bookId.value = books.value[0]!.id; await loadAccounts() } } })
</script>
<template>
  <CrudPage title="银行与现金账户" resource="/md/fund-accounts" :columns="columns" :search-fields="searchFields" :form-fields="formFields" edit-perm="md:fund-account:edit" audit-type="fund-account" :before-open="beforeOpen" :can-create="mockMode || !!bookId">
    <template #header><p class="muted">系统只登记收付款，不执行银行转账。科目关联由人工配置，账户创建不会产生期初或记账。</p><el-form v-if="!mockMode" inline><el-form-item label="新增 / 未绑定账户的配置账套"><el-select v-model="bookId" @change="loadAccounts"><el-option v-for="b in books" :key="b.id" :label="b.name" :value="b.id" /></el-select></el-form-item></el-form></template>
  </CrudPage>
</template>
