<script setup lang="ts">
import { computed, onMounted, reactive, ref } from 'vue'
import { ElMessage, ElMessageBox } from 'element-plus'
import { http, createCommandIntent } from '@/api/http'
import { allRecords } from '@/api/pagination'
import DocAttachment from '@/components/DocAttachment.vue'
import { financeSourcePath } from '@/utils/finance-source'
import { getToken, getCountryId } from '@/utils/session'
import { useRoute } from 'vue-router'
const route = useRoute()
import StatusTag from '@/components/StatusTag.vue'
import { useUserStore } from '@/stores/user'
import { useCountryStore } from '@/stores/country'
import { useOptionsStore, type OptionItem } from '@/stores/options'

const mockMode = import.meta.env.MODE === 'demo' && import.meta.env.VITE_USE_MOCK === 'true'
const user = useUserStore(), country = useCountryStore(), options = useOptionsStore()
const currencies = ref<Record<string, any>[]>([])
const baseDecimals = computed(() => currencies.value.find(c => c.code === books.value.find(b => b.id === bookId.value)?.baseCurrency)?.decimals ?? 2)
const originalDecimals = (currency: string) => currencies.value.find(c => c.code === currency)?.decimals ?? 2
const saveIntent = createCommandIntent(), actionIntent = createCommandIntent(), batchIntent = createCommandIntent()
const books = ref<Record<string, any>[]>([]), words = ref<Record<string, any>[]>([]), cashflows = ref<Record<string, any>[]>([]), bookId = ref<number>(), selected = ref<Record<string, any>[]>([]), status = ref('')
const scoped = (path: string) => path + '?bookId=' + bookId.value
const rows = ref<Record<string, any>[]>([]), accounts = ref<Record<string, any>[]>([])
const current = ref<Record<string, any> | null>(null), editing = ref<number | null>(null), dialog = ref(false), saving = ref(false)
const form = reactive({ version: undefined as number | undefined, voucherDate: '', wordId: null as number | null, summary: '', lines: [] as Record<string, any>[] })
const auxOptions = ref<Record<string, OptionItem[]>>({})
const auxFields: Record<string, { field: string; label: string; url: string }> = {
  CUSTOMER: { field: 'customerId', label: '客户', url: '/md/customers' }, PARTNER: { field: 'partnerId', label: '供应商', url: '/md/partners' },
  FUND: { field: 'fundAccountId', label: '资金账户', url: '/md/fund-accounts' }, PRODUCT: { field: 'productId', label: '商品', url: '/md/products' },
  WAREHOUSE: { field: 'warehouseId', label: '仓库', url: '/org/warehouses' }, STORE: { field: 'storeId', label: '门店', url: '/org/stores' },
  EXPENSE: { field: 'expenseItemId', label: '费用项目', url: '/md/expense-items' }, EMPLOYEE: { field: 'employeeId', label: '员工', url: '/sys/users' },
}
const auxAliases: Record<string, string> = { customerId: 'CUSTOMER', supplierId: 'PARTNER', partnerId: 'PARTNER', fundAccountId: 'FUND', productId: 'PRODUCT', warehouseId: 'WAREHOUSE', storeId: 'STORE', expenseItemId: 'EXPENSE', employeeId: 'EMPLOYEE', SUPPLIER: 'PARTNER' }
function types(line: Record<string, any>): string[] { return (account(line)?.auxTypes || []).map((t: string) => auxAliases[t] || t) }
const totals = computed(() => ({ debit: form.lines.reduce((n, l) => n + Number(l.debit || 0), 0), credit: form.lines.reduce((n, l) => n + Number(l.credit || 0), 0) }))
function account(line: Record<string, any>) { return accounts.value.find(a => a.id === line.accountId) }
async function loadAux(line: Record<string, any>) {
  for (const type of types(line)) {
    const field = auxFields[type]
    if (field && !auxOptions.value[type]) auxOptions.value[type] = await options.remote(field.url, type === 'EMPLOYEE' ? 'displayName' : 'name', 'id', { size: 200 })
  }
}
async function changeAccount(line: Record<string, any>) { line.aux = {}; line.currency = books.value.find(b => b.id === bookId.value)?.baseCurrency || country.currency; line.origAmount = null; line.rate = 1; line.cashflowItemId = null; await loadAux(line) }
function addLine() { form.lines.push({ accountId: null, summary: '', debit: 0, credit: 0, aux: {}, currency: books.value.find(b => b.id === bookId.value)?.baseCurrency || country.currency, origAmount: null, rate: 1 }) }
async function load() { if (!bookId.value) return; rows.value = (await allRecords<Record<string, any>>('/fin/vouchers', { bookId: bookId.value, status: status.value || undefined })); current.value = null; selected.value = [] }
async function open(row: Record<string, any>) { current.value = await http.get('/fin/vouchers/' + row.id, { bookId: bookId.value }) }
async function edit(row?: Record<string, any>) {
  if (row) row = await http.get<Record<string, any>>('/fin/vouchers/' + row.id, { bookId: bookId.value })
  form.version = row?.version
  accounts.value = (await allRecords<Record<string, any>>('/fin/accounts', { bookId: bookId.value })).filter(a => a.isLeaf && a.status === 'ENABLED')
  if (!mockMode) { words.value = (await allRecords<Record<string, any>>('/fin/voucher-words', { bookId: bookId.value })); cashflows.value = (await allRecords<Record<string, any>>('/fin/cashflow-items', { bookId: bookId.value })) }
  form.wordId = row?.wordId ?? null; form.summary = row?.summary || ''; saveIntent.reset()
  editing.value = row?.id ?? null
  form.voucherDate = row?.voucherDate || new Intl.DateTimeFormat('en-CA', { timeZone: country.timezone }).format(new Date())
  form.lines = row ? JSON.parse(JSON.stringify(row.lines)) : []
  for (const line of form.lines) if (line.aux?.supplierId) { line.aux.partnerId = line.aux.supplierId; delete line.aux.supplierId }
  if (!row) { addLine(); addLine() }
  for (const line of form.lines) await loadAux(line)
  dialog.value = true
}
async function save() {
  saving.value = true
  try {
    const base = books.value.find(b => b.id === bookId.value)?.baseCurrency || country.currency
    const payload = { ...form, lines: form.lines.map(line => line.currency === base || !account(line)?.fxEnabled ? { ...line, currency: base, origAmount: Number(line.debit || line.credit || 0), rate: 1 } : line) }
    const updated = editing.value ? await http.putIdem(scoped('/fin/vouchers/' + editing.value), payload, saveIntent) : await http.postIdem(scoped('/fin/vouchers'), payload, saveIntent)
    dialog.value = false
    await load(); current.value = updated as Record<string, any>
    ElMessage.success('草稿已保存，审核后方可记账')
  } finally { saving.value = false }
}
async function removeDraft() { if (!current.value) return; const row = current.value; await ElMessageBox.confirm('删除这张人工草稿凭证？', '删除草稿', { type: 'warning' }); await actionIntent.run(`${getToken()}:${getCountryId()}`, 'DELETE /fin/vouchers/' + row.id, { version: row.version, bookId: bookId.value }, key => http.delete('/fin/vouchers/' + row.id, { params: { version: row.version, bookId: bookId.value }, headers: { 'Idempotency-Key': key } })); await load(); ElMessage.success('草稿已删除') }
async function act(path: string) {
  if (!current.value) return
  let body: Record<string, any> = { version: current.value.version }
  if (path === '/unaudit') { const { value } = await ElMessageBox.prompt('填写取消审核原因', '取消审核', { inputValidator: value => !!value?.trim() || '请填写原因' }); body = { ...body, reason: value } }
  if (path === '/reverse') { const { value } = await ElMessageBox.prompt('冲销日期须在开放期间内', '冲销', { inputValue: new Intl.DateTimeFormat('en-CA', { timeZone: country.timezone }).format(new Date()), inputPattern: /^\d{4}-\d{2}-\d{2}$/, inputErrorMessage: '请填写 YYYY-MM-DD 日期' }); const reason = await ElMessageBox.prompt('填写冲销原因', '冲销原因', { inputValidator: value => !!value?.trim() || '请填写原因' }); body = { ...body, voucherDate: value, reason: reason.value } }
  const updated = await http.postIdem<Record<string, any>>(scoped('/fin/vouchers/' + current.value.id + path), body, actionIntent)
  ElMessage.success('已更新')
  await load(); current.value = updated
}
async function batch(action: 'audit' | 'post') { await ElMessageBox.confirm('对选中的凭证执行' + (action === 'audit' ? '审核' : '记账') + '？', '批量操作'); await http.postIdem(scoped('/fin/vouchers/batch-' + action), { ids: selected.value.map(r => r.id), versions: Object.fromEntries(selected.value.map(r => [r.id, r.version])) }, batchIntent); await load(); ElMessage.success('批量操作已完成') }
onMounted(async () => { [books.value, currencies.value] = await Promise.all([http.get<Record<string, any>[]>('/fin/books'), allRecords<Record<string, any>>('/md/currencies')]); bookId.value = route.query.bookId ? Number(route.query.bookId) : books.value.length === 1 ? books.value[0]!.id : undefined; await load(); if (bookId.value && route.query.voucherId) await open({ id: Number(route.query.voucherId) }) })
</script>

<template>
  <el-card>
    <template #header>凭证</template>
    <el-form inline><el-form-item label="账套"><el-select v-model="bookId" @change="load"><el-option v-for="b in books" :key="b.id" :label="b.name" :value="b.id" /></el-select></el-form-item><el-form-item label="状态"><el-select v-model="status" clearable @change="load"><el-option v-for="v in ['DRAFT','PENDING_AUDIT','AUDITED','POSTED','REVERSED']" :key="v" :label="v" :value="v" /></el-select></el-form-item><el-button v-if="!mockMode && user.hasPerm('fin:voucher:audit')" :disabled="!selected.length" @click="batch('audit')">批量审核</el-button><el-button v-if="!mockMode && user.hasPerm('fin:voucher:post')" :disabled="!selected.length" @click="batch('post')">批量记账</el-button></el-form>
    <el-button v-if="user.hasPerm('fin:voucher:create')" :disabled="!bookId" type="primary" style="margin-bottom: 12px" @click="edit()">新建人工凭证</el-button>
    <el-table :data="rows" size="small" @row-click="open" @selection-change="selected = $event"><el-table-column type="selection" width="45" />
      <el-table-column prop="voucherNo" label="凭证号" width="170" /><el-table-column prop="voucherDate" label="日期" width="110" />
      <el-table-column prop="sourceKind" label="来源" width="90" /><el-table-column prop="totalDebit" label="借方" width="100" /><el-table-column prop="totalCredit" label="贷方" width="100" />
      <el-table-column label="状态" width="100"><template #default="{ row }"><StatusTag :status="row.status" domain="voucher" /></template></el-table-column><el-table-column prop="preparedByName" label="编制" />
    </el-table>
    <div v-if="current" style="margin-top: 12px">
      <p>{{ current.voucherNo }} <StatusTag :status="current.status" domain="voucher" /></p>
      <el-button v-if="current.status === 'DRAFT' && user.hasPerm('fin:voucher:edit')" @click="edit(current)">修改草稿</el-button>
      <el-button v-if="!mockMode && current.status === 'DRAFT' && current.sourceKind === 'MANUAL' && user.hasPerm('fin:voucher:edit')" type="danger" @click="removeDraft">删除草稿</el-button>
      <el-button v-if="current.status === 'DRAFT' && user.hasPerm('fin:voucher:create')" @click="act('/submit')">提交</el-button>
      <el-button v-if="user.hasPerm('fin:voucher:audit') && current.status === 'PENDING_AUDIT'" type="primary" @click="act('/audit')">审核</el-button>
      <el-button v-if="user.hasPerm('fin:voucher:unaudit') && current.status === 'AUDITED'" @click="act('/unaudit')">取消审核</el-button>
      <el-button v-if="user.hasPerm('fin:voucher:post') && current.status === 'AUDITED'" type="primary" @click="act('/post')">记账</el-button>
      <el-button v-if="user.hasPerm('fin:voucher:reverse') && current.status === 'POSTED'" @click="act('/reverse')">冲销</el-button>
      <p v-if="current.sourceEventId"><router-link :to="{ path: '/finance/events', query: { bookId, eventId: current.sourceEventId } }">来源事件 {{ current.sourceEventId }}</router-link></p>
      <DocAttachment v-if="!mockMode" :key="current.id" biz-type="FIN_VOUCHER" :biz-id="current.id" category="VOUCHER_ATTACH" :readonly="current.status !== 'DRAFT' || !user.hasPerm('fin:voucher:edit')" />
      <el-table :data="current.lines" size="small"><el-table-column prop="accountCode" label="科目" width="80" /><el-table-column prop="accountName" label="名称" /><el-table-column prop="summary" label="摘要" /><el-table-column prop="debit" label="借方" width="100" /><el-table-column prop="credit" label="贷方" width="100" /><el-table-column label="来源"><template #default="{ row }"><router-link v-if="financeSourcePath(row)" :to="financeSourcePath(row)!">{{ row.sourceDocType }} #{{ row.sourceDocId }}</router-link><span v-else>{{ row.sourceDocType }} {{ row.sourceDocId }}</span></template></el-table-column></el-table>
    </div>
    <el-dialog v-model="dialog" :title="editing ? '修改人工凭证草稿' : '新建人工凭证'" width="1000px">
      <el-form inline><el-form-item v-if="!mockMode" label="凭证字"><el-select v-model="form.wordId" clearable><el-option v-for="w in words" :key="w.id" :label="w.name" :value="w.id" /></el-select></el-form-item><el-form-item label="摘要"><el-input v-model="form.summary" /></el-form-item><el-form-item label="日期"><el-date-picker v-model="form.voucherDate" value-format="YYYY-MM-DD" /></el-form-item></el-form>
      <el-table :data="form.lines" size="small">
        <el-table-column label="科目" width="190"><template #default="{ row }"><el-select v-model="row.accountId" filterable @change="changeAccount(row)"><el-option v-for="a in accounts" :key="a.id" :label="a.code + ' ' + a.name" :value="a.id" /></el-select></template></el-table-column>
        <el-table-column label="摘要"><template #default="{ row }"><el-input v-model="row.summary" /></template></el-table-column>
        <el-table-column label="辅助项" width="190"><template #default="{ row }"><div v-for="type in types(row)" :key="type"><el-select v-if="auxFields[type]" v-model="row.aux[auxFields[type].field]" :placeholder="auxFields[type].label" filterable><el-option v-for="o in auxOptions[type] ?? []" :key="String(o.value)" :label="o.label" :value="o.value" /></el-select></div></template></el-table-column>
        <el-table-column label="借方" width="135"><template #default="{ row }"><el-input-number v-model="row.debit" :min="0" :precision="baseDecimals" :controls="false" style="width: 115px" /></template></el-table-column>
        <el-table-column label="贷方" width="135"><template #default="{ row }"><el-input-number v-model="row.credit" :min="0" :precision="baseDecimals" :controls="false" style="width: 115px" /></template></el-table-column>
        <el-table-column v-if="!mockMode" label="现金流项目" width="180"><template #default="{ row }"><el-select v-if="account(row)?.isCash || account(row)?.isBank" v-model="row.cashflowItemId" filterable><el-option v-for="c in cashflows" :key="c.id" :label="c.name" :value="c.id" /></el-select></template></el-table-column>
        <el-table-column width="60"><template #default="{ $index }"><el-button link @click="form.lines.splice($index, 1)">删除</el-button></template></el-table-column>
      </el-table>
      <div v-for="(line, i) in form.lines" :key="i" style="margin-top: 8px"><template v-if="account(line)?.fxEnabled">第 {{ i + 1 }} 行原币 <el-input v-model="line.currency" style="width: 90px" /> 原币金额 <el-input-number v-model="line.origAmount" :min="0" :precision="originalDecimals(line.currency)" /> 汇率 <el-input-number v-model="line.rate" :min="0" :precision="8" /></template></div>
      <p>本位币 {{ books.find(b => b.id === bookId)?.baseCurrency }}：借方 {{ totals.debit.toFixed(baseDecimals) }}，贷方 {{ totals.credit.toFixed(baseDecimals) }}</p>
      <el-button @click="addLine">增加分录</el-button>
      <template #footer><el-button @click="dialog = false">取消</el-button><el-button type="primary" :loading="saving" @click="save">保存草稿</el-button></template>
    </el-dialog>
  </el-card>
</template>
