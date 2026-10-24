<script setup lang="ts">
import { computed, onBeforeUnmount, onMounted, reactive, ref, watch } from 'vue'
import { http, createCommandIntent } from '@/api/http'
import type { PageResult } from '@/api/types'
import { allRecords } from '@/api/pagination'
import FieldInput from '@/components/crud/FieldInput.vue'
import type { FieldDef } from '@/components/crud/types'
import MoneyText from '@/components/MoneyText.vue'
import StatusTag from '@/components/StatusTag.vue'
import { PRODUCT_SOURCE } from '@/modules/shared/bizOptions'
import { useOptionsStore, type OptionItem } from '@/stores/options'
import { useCountryStore } from '@/stores/country'
import { useUserStore } from '@/stores/user'
import { formatDate, todayIn } from '@/utils/format'

type Row = Record<string, any>
const user = useUserStore(), country = useCountryStore(), options = useOptionsStore()
const mockMode = import.meta.env.MODE === 'demo' && import.meta.env.VITE_USE_MOCK === 'true'
const canReadItems = computed(() => user.hasPerm(['md:expense-item:edit', 'pur:order:create', 'lgs:shipment:create', 'lgs:fee:create', 'ap:bill:view', 'cst:expense:create']))
const canReadProducts = computed(() => user.hasPerm(['md:product:view', 'md:product:edit']))
const canWrite = computed(() => user.hasPerm('cst:expense:create') && user.hasPerm('cst:expense:confirm') && user.fieldAccess('COST') === 'WRITE')
const records = ref<Row[]>([]), references = ref<Row[]>([]), books = ref<Row[]>([]), currencies = ref<Row[]>([])
const products = ref<OptionItem[]>([]), created = ref<Row | null>(null)
const loading = ref(false), itemsLoading = ref(false), productsLoading = ref(false), setupLoading = ref(false), saving = ref(false)
const listError = ref(''), itemsError = ref(''), productError = ref(''), setupError = ref(''), saveError = ref(''), contextChanged = ref(false)
const query = reactive({ page: 1, size: 20 }), total = ref(0), saveIntent = createCommandIntent()
const form = reactive({ expenseItemId: null as number | null, amount: 0 as number | null, bizDate: todayIn(country.timezone), productId: null as number | null, bookId: undefined as number | undefined, currency: country.currency })
const items = computed(() => references.value.filter(i => i.status === 'ENABLED' && ['PERIOD_EXPENSE', 'DIRECT_SELLING', 'EXPENSE'].includes(i.costTreatment)))
const rows = computed(() => records.value.map(row => ({ ...row, itemName: row.itemName ?? references.value.find(i => i.id === row.expenseItemId)?.name ?? (row.expenseItemId == null ? '—' : `#${row.expenseItemId}`) })))
const selectedItem = computed(() => items.value.find(i => i.id === form.expenseItemId))
const isDirect = computed(() => selectedItem.value?.costTreatment === 'DIRECT_SELLING')
const decimals = computed(() => currencies.value.find(c => c.code === form.currency)?.decimals ?? 2)
const treatmentLabel = (value?: string) => ({ PERIOD_EXPENSE: '期间费用', EXPENSE: '期间费用', DIRECT_SELLING: '直接销售费用' }[value ?? ''] ?? value ?? '—')
const bookField = computed<FieldDef>(() => ({ prop: 'bookId', label: '账套', type: 'select', options: books.value.map(b => ({ value: b.id, label: b.name })) }))
const itemField = computed<FieldDef>(() => ({ prop: 'expenseItemId', label: '费用项目', type: 'select', options: items.value.map(i => ({ value: i.id, label: `${i.name} · ${treatmentLabel(i.costTreatment)}` })) }))
const currencyField = computed<FieldDef>(() => ({ prop: 'currency', label: '币种', type: 'select', options: currencies.value.map(c => ({ value: c.code, label: c.code })) }))
const productField = computed<FieldDef>(() => ({ prop: 'productId', label: '商品', type: 'select', options: products.value, placeholder: '搜索商品编码或名称' }))
const scopeKey = () => `${user.token}:${country.currentId}:${country.epoch}`
const listScope = () => `${scopeKey()}:${form.bookId ?? ''}`
const errorText = (error: unknown, fallback: string) => error instanceof Error && error.message.trim() ? error.message : fallback
let listRequest = 0, itemRequest = 0, productRequest = 0, setupRequest = 0, disposed = false

async function load() {
  if (contextChanged.value) return
  const request = ++listRequest, scope = listScope()
  loading.value = true; listError.value = ''
  try {
    const result = await http.get<PageResult<Row>>('/cst/expenses', { page: query.page, size: query.size, ...(!mockMode && form.bookId ? { bookId: form.bookId } : {}) }, { silent: true })
    if (disposed || request !== listRequest || scope !== listScope()) return
    if (!Array.isArray(result.records) || !Number.isSafeInteger(result.total) || result.total < 0) throw new Error('费用记录分页数据不完整，请重试')
    records.value = result.records; total.value = result.total
  } catch (error) {
    if (!disposed && request === listRequest && scope === listScope()) { records.value = []; total.value = 0; listError.value = errorText(error, '费用记录读取失败，请重试') }
  } finally { if (!disposed && request === listRequest && scope === listScope()) loading.value = false }
}

async function loadItems() {
  if (!canReadItems.value) return
  const request = ++itemRequest, scope = scopeKey()
  itemsLoading.value = true; itemsError.value = ''
  try {
    const result = await allRecords<Row>('/md/expense-items')
    if (!disposed && request === itemRequest && scope === scopeKey()) references.value = result
  } catch (error) {
    if (!disposed && request === itemRequest && scope === scopeKey()) { references.value = []; itemsError.value = errorText(error, '费用项目读取失败，请重试') }
  } finally { if (!disposed && request === itemRequest && scope === scopeKey()) itemsLoading.value = false }
}

async function loadProducts() {
  if (!canReadProducts.value) return
  const request = ++productRequest, scope = scopeKey()
  productsLoading.value = true; productError.value = ''
  try {
    // Reuse the same enabled-country product source and scoped cache as purchase entry.
    if (!('remote' in PRODUCT_SOURCE)) throw new Error('商品选项来源配置不完整')
    const result = await options.remote(PRODUCT_SOURCE.remote, PRODUCT_SOURCE.label, PRODUCT_SOURCE.value, PRODUCT_SOURCE.params)
    if (!disposed && request === productRequest && scope === scopeKey()) products.value = result
  } catch (error) {
    if (!disposed && request === productRequest && scope === scopeKey()) { products.value = []; productError.value = errorText(error, '商品读取失败，请重试') }
  } finally { if (!disposed && request === productRequest && scope === scopeKey()) productsLoading.value = false }
}

async function loadSetup() {
  if (mockMode || !canWrite.value) return
  const request = ++setupRequest, scope = scopeKey()
  setupLoading.value = true; setupError.value = ''
  try {
    const [available, money] = await Promise.all([http.get<Row[]>('/org/books', undefined, { silent: true }), allRecords<Row>('/md/currencies')])
    if (disposed || request !== setupRequest || scope !== scopeKey()) return
    books.value = available.filter(b => b.status === 'ACTIVE'); currencies.value = money.filter(c => c.status === 'ENABLED')
    if (!books.value.some(b => b.id === form.bookId)) {
      form.bookId = books.value.length === 1 ? books.value[0]!.id : undefined
      form.currency = books.value.find(b => b.id === form.bookId)?.baseCurrency ?? country.currency
    }
  } catch (error) {
    if (!disposed && request === setupRequest && scope === scopeKey()) { books.value = []; currencies.value = []; setupError.value = errorText(error, '账套与币种读取失败，请重试') }
  } finally { if (!disposed && request === setupRequest && scope === scopeKey()) setupLoading.value = false }
}

async function initialize() {
  contextChanged.value = false
  const scope = scopeKey()
  await Promise.all([loadItems(), loadSetup().then(() => { if (!disposed && scope === scopeKey()) return load() })])
}
async function search() { query.page = 1; await load() }
async function chooseBook() {
  form.currency = books.value.find(b => b.id === form.bookId)?.baseCurrency ?? country.currency
  records.value = []; total.value = 0; created.value = null; saveError.value = ''; await search()
}

async function create() {
  if (saving.value) return
  saveError.value = ''
  if (!canWrite.value) { saveError.value = '当前账号没有登记、确认费用及成本字段写入权限'; return }
  if (contextChanged.value || setupError.value || itemsError.value || setupLoading.value || itemsLoading.value) { saveError.value = '登记资料尚未就绪，请先重试读取'; return }
  if (!mockMode && !books.value.some(b => b.id === form.bookId)) { saveError.value = '请明确选择费用所属账套'; return }
  if (!selectedItem.value) { saveError.value = '请选择已启用的期间费用或直接销售费用项目'; return }
  if (typeof form.amount !== 'number' || !Number.isFinite(form.amount) || form.amount <= 0) { saveError.value = '费用金额必须大于零'; return }
  if (!/^\d{4}-\d{2}-\d{2}$/.test(form.bizDate)) { saveError.value = '请选择业务日期'; return }
  if (!mockMode && !form.currency) { saveError.value = '请选择币种'; return }
  if (isDirect.value && (!Number.isSafeInteger(form.productId) || form.productId! <= 0)) { saveError.value = '直接销售费用需要指定商品'; return }
  if (isDirect.value && canReadProducts.value && (productsLoading.value || productError.value || !products.value.some(p => p.value === form.productId))) { saveError.value = '请在成功读取的商品候选中选择商品'; return }
  const lines = isDirect.value ? [{ productId: form.productId, amount: form.amount }] : []
  const draft = { ...form, productId: isDirect.value ? form.productId : null }
  const payload = mockMode ? { expenseItemId: draft.expenseItemId, amount: draft.amount, bizDate: draft.bizDate, productId: draft.productId, lines } : { ...draft, lines }
  const scope = listScope()
  saving.value = true; created.value = null
  try {
    const result = await http.postIdem<Row>('/cst/expenses', payload, saveIntent, { silent: true })
    if (disposed || scope !== listScope()) return
    saveIntent.reset(); created.value = result; form.amount = 0; form.productId = null
    query.page = 1; await load()
  } catch (error) {
    if (!disposed && scope === listScope()) saveError.value = errorText(error, '费用登记失败，请重试')
  } finally { if (!disposed && scope === listScope()) saving.value = false }
}

watch(() => form.expenseItemId, () => { form.productId = null; saveError.value = '' }, { flush: 'sync' })
watch([isDirect, canReadProducts], ([direct, permitted]) => { if (direct && permitted) void loadProducts() })
watch(scopeKey, () => {
  listRequest++; itemRequest++; productRequest++; setupRequest++; saveIntent.reset()
  records.value = []; references.value = []; books.value = []; currencies.value = []; products.value = []; total.value = 0; created.value = null
  Object.assign(form, { bookId: undefined, expenseItemId: null, productId: null, amount: 0, currency: country.currency, bizDate: todayIn(country.timezone) })
  loading.value = false; itemsLoading.value = false; productsLoading.value = false; setupLoading.value = false; saving.value = false
  listError.value = ''; itemsError.value = ''; productError.value = ''; setupError.value = ''; saveError.value = ''; contextChanged.value = true; query.page = 1
}, { flush: 'sync' })
onMounted(initialize)
onBeforeUnmount(() => { disposed = true; listRequest++; itemRequest++; productRequest++; setupRequest++ })
</script>

<template>
  <div class="page expense-page">
    <section class="page-card">
      <div class="page-title"><h2>费用登记</h2><el-tag type="info" effect="plain">{{ mockMode ? '演示模式' : '登记后直接生效' }}</el-tag></div>
      <p class="page-description">登记期间费用和直接销售费用。资本化费用请走费用分摊，已计入库存成本的费用不会重复扣减利润。</p>
      <div v-if="contextChanged" class="feedback" role="alert"><el-alert title="国家或登录状态已变化，请重新读取当前资料" type="warning" :closable="false" /><el-button @click="initialize">重新读取</el-button></div>
      <template v-else>
        <div v-if="setupError" class="feedback" role="alert"><el-alert :title="setupError" type="error" :closable="false" show-icon /><el-button :loading="setupLoading" @click="initialize">重试账套与币种</el-button></div>
        <div v-if="itemsError" class="feedback" role="alert"><el-alert :title="itemsError" type="error" :closable="false" show-icon /><el-button :loading="itemsLoading" @click="loadItems">重试费用项目</el-button></div>
        <el-form v-if="canWrite" label-position="top" :disabled="saving || setupLoading || itemsLoading" @submit.prevent="create">
          <div class="form-grid">
            <el-form-item v-if="!mockMode" label="所属账套" required><FieldInput v-model="form.bookId" :field="bookField" @update:model-value="chooseBook" /><div class="field-help">{{ form.bookId ? '下方记录按此账套查询' : '请选择账套；下方显示当前授权范围内的记录' }}</div></el-form-item>
            <el-form-item label="费用项目" required><FieldInput v-model="form.expenseItemId" :field="itemField" /><div class="field-help">{{ selectedItem ? treatmentLabel(selectedItem.costTreatment) : '只显示已启用的期间费用与直接销售费用' }}</div></el-form-item>
            <el-form-item label="费用金额" required><el-input-number v-model="form.amount" :min="0" :precision="mockMode ? undefined : decimals" controls-position="right" /><div class="field-help">填写大于零的原币金额{{ !mockMode && form.currency ? ' · ' + form.currency : '' }}</div></el-form-item>
            <el-form-item v-if="!mockMode" label="币种" required><FieldInput v-model="form.currency" :field="currencyField" /></el-form-item>
            <el-form-item label="业务日期" required><FieldInput v-model="form.bizDate" :field="{ prop: 'bizDate', label: '业务日期', type: 'date' }" /><div class="field-help">费用归属日期，最终登记时校验账套会计期间</div></el-form-item>
            <el-form-item v-if="isDirect" :label="canReadProducts ? '承担费用的商品' : '承担费用的商品ID'" required>
              <FieldInput v-if="canReadProducts" v-model="form.productId" :field="productField" :disabled="productsLoading" />
              <el-input-number v-else v-model="form.productId" :min="1" :precision="0" controls-position="right" placeholder="请输入商品ID" />
              <div class="field-help">{{ canReadProducts ? (productsLoading ? '正在读取商品…' : '该商品承担本笔全部费用') : '当前账号无商品档案查询权限；填写有效商品ID，登记时校验' }}</div>
              <div v-if="productError" class="field-error" role="alert">{{ productError }} <el-button link type="primary" :loading="productsLoading" @click="loadProducts">重试商品</el-button></div>
            </el-form-item>
          </div>
          <el-alert v-if="saveError" class="feedback" :title="saveError" type="error" :closable="false" show-icon role="alert" />
          <div class="form-actions"><span class="muted">登记成功即形成已确认费用，请核对项目、金额和日期。</span><el-button type="primary" native-type="submit" :loading="saving" :disabled="!!setupError || !!itemsError || (!mockMode && !form.bookId)">登记费用</el-button></div>
        </el-form>
        <el-alert v-else title="当前账号仅可查看费用记录，登记需要费用登记、确认及成本字段写入权限" type="info" :closable="false" show-icon />
        <el-alert v-if="created" class="feedback" type="success" :closable="false" show-icon><template #title>费用已登记<span v-if="created.docNo" class="mono"> · {{ created.docNo }}</span> <StatusTag :status="created.status" /></template><template #default>{{ loading ? '登记已成功，正在刷新记录…' : listError ? '登记已成功，记录刷新失败，请点击下方重试读取，无需再次登记。' : '记录已刷新，可继续登记下一笔费用。' }}</template></el-alert>
      </template>
    </section>
    <section class="page-card">
      <div class="page-title"><h2>登记记录</h2><el-button :loading="loading" :disabled="saving || contextChanged" @click="load">刷新记录</el-button></div>
      <p class="record-scope">{{ !mockMode && form.bookId ? `当前账套：${books.find(b => b.id === form.bookId)?.name ?? '#' + form.bookId}` : '当前授权范围内的费用记录' }} · 金额按各单据币种展示</p>
      <div v-if="listError" class="feedback" role="alert"><el-alert :title="listError" type="error" :closable="false" show-icon /><el-button :disabled="saving" @click="load">重试读取记录</el-button></div>
      <template v-else-if="!contextChanged">
        <div class="table-scroll" v-loading="loading" :aria-busy="loading">
          <el-table :data="rows" border stripe row-key="id" :empty-text="loading ? '正在读取费用记录…' : '暂无费用记录；登记成功后将在这里显示'">
            <el-table-column prop="docNo" label="费用单号" min-width="190" show-overflow-tooltip><template #default="{ row }"><span class="mono">{{ row.docNo ?? (row.id == null ? '—' : '#' + row.id) }}</span></template></el-table-column>
            <el-table-column prop="itemName" label="费用项目" min-width="160" show-overflow-tooltip />
            <el-table-column label="处理方式" min-width="130"><template #default="{ row }">{{ treatmentLabel(row.treatment) }}</template></el-table-column>
            <el-table-column label="业务日期" min-width="120"><template #default="{ row }">{{ formatDate(row.bizDate) }}</template></el-table-column>
            <el-table-column label="原币金额" min-width="160" align="right"><template #default="{ row }"><MoneyText v-if="row.currency" :value="row.amount" :currency="row.currency" /><span v-else class="mono">{{ row.amount ?? '—' }} <span class="muted">币种未提供</span></span></template></el-table-column>
            <el-table-column label="本位币金额" min-width="160" align="right"><template #default="{ row }"><MoneyText v-if="row.baseCurrency" :value="row.baseAmount" :currency="row.baseCurrency" /><span v-else class="mono">{{ row.baseAmount ?? '—' }} <span class="muted">币种未提供</span></span></template></el-table-column>
            <el-table-column label="状态" width="110"><template #default="{ row }"><StatusTag :status="row.status" /></template></el-table-column>
          </el-table>
        </div>
        <el-pagination v-model:current-page="query.page" v-model:page-size="query.size" class="pagination" :page-sizes="[20, 50, 100]" :pager-count="5" :total="total" :disabled="loading || saving" layout="total, sizes, prev, pager, next" @current-change="load" @size-change="search" />
      </template>
    </section>
  </div>
</template>

<style scoped>
.expense-page { min-width: 0; }
.page-description, .record-scope { margin: 0 0 16px; color: var(--el-text-color-secondary); font-size: 13px; line-height: 1.7; }
.form-grid { display: grid; grid-template-columns: repeat(2, minmax(0, 1fr)); gap: 0 16px; }
.form-grid :deep(.el-form-item__content) { display: block; min-width: 0; }
.form-grid :deep(.el-input-number), .form-grid :deep(.el-date-editor) { width: 100%; }
.field-help { margin-top: 6px; color: var(--el-text-color-secondary); font-size: 13px; line-height: 1.6; }
.field-error { color: var(--el-color-danger); font-size: 13px; line-height: 1.6; margin-top: 8px; overflow-wrap: anywhere; }
.form-actions { display: flex; justify-content: space-between; align-items: center; flex-wrap: wrap; gap: 12px; padding-top: 12px; border-top: 1px solid var(--el-border-color-lighter); }
.feedback { margin: 12px 0; display: flex; gap: 8px; align-items: center; }
.feedback :deep(.el-alert) { min-width: 0; }
.pagination { margin-top: 16px; justify-content: flex-end; flex-wrap: wrap; gap: 8px; }
.record-scope { overflow-wrap: anywhere; }
.expense-page :deep(.el-button:focus-visible) { outline: 2px solid var(--el-color-primary); outline-offset: 3px; }
@media (max-width: 768px) {
  .form-grid { grid-template-columns: minmax(0, 1fr); }
  .page-title, .feedback { flex-wrap: wrap; }
  .form-actions { align-items: stretch; }
  .form-actions > .el-button { width: 100%; margin-left: 0; }
  .pagination { justify-content: flex-start; }
}
</style>
