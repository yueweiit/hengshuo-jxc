<script setup lang="ts">
import { computed, onBeforeUnmount, onMounted, reactive, ref } from 'vue'
import { ElMessage } from 'element-plus'
import { http, createCommandIntent } from '@/api/http'
import { allRecords } from '@/api/pagination'
import StatusTag from '@/components/StatusTag.vue'
import { useUserStore } from '@/stores/user'

type Row = Record<string, any>
type Option = { value: string; label: string }
const mockMode = import.meta.env.MODE === 'demo' && import.meta.env.VITE_USE_MOCK === 'true'
const user = useUserStore(), intent = createCommandIntent()
const canEdit = computed(() => !mockMode && user.hasPerm('fin:account:edit'))
const rows = ref<Row[]>([]), accounts = ref<Row[]>([]), categories = ref<Row[]>([]), books = ref<Row[]>([])
const bookId = ref<number>(), resource = ref('accounts'), dialog = ref(false), saving = ref(false), editing = ref<number>()
const loading = ref(false), booksLoading = ref(false)
const booksError = ref(''), loadError = ref(''), referenceError = ref(''), saveError = ref(''), savedNotice = ref(false)
const keyword = ref(''), page = ref(1), pageSize = ref(20)
const resources = [{ value: 'accounts', label: '会计科目' }, { value: 'cashflow-items', label: '现金流项目' }, { value: 'voucher-words', label: '凭证字' }, { value: 'category-account-maps', label: '商品分类科目映射' }]
const accountCategories = [{ value: 'ASSET', label: '资产' }, { value: 'LIABILITY', label: '负债' }, { value: 'EQUITY', label: '所有者权益' }, { value: 'COST', label: '成本' }, { value: 'EXPENSE', label: '费用' }, { value: 'INCOME', label: '收入' }, { value: 'PROFIT_LOSS', label: '损益' }]
const cashflowCategories = [{ value: 'OPERATING', label: '经营活动' }, { value: 'INVESTING', label: '投资活动' }, { value: 'FINANCING', label: '筹资活动' }]
const directions = [{ value: 'DEBIT', label: '借方' }, { value: 'CREDIT', label: '贷方' }, { value: 'IN', label: '流入' }, { value: 'OUT', label: '流出' }, { value: 'BOTH', label: '双向' }]
const purposes = [{ value: 'INVENTORY', label: '存货' }, { value: 'REVENUE', label: '销售收入' }, { value: 'COGS', label: '销售成本' }]
const reconcileTypes = [{ value: 'AR', label: '应收' }, { value: 'AP', label: '应付' }, { value: 'INVENTORY', label: '库存' }, { value: 'CASH', label: '现金与银行' }]
const auxTypes = [{ value: 'customerId', label: '客户' }, { value: 'supplierId', label: '供应商 / 物流商' }, { value: 'fundAccountId', label: '资金账户' }, { value: 'productId', label: '商品' }, { value: 'warehouseId', label: '仓库' }, { value: 'storeId', label: '门店' }, { value: 'expenseItemId', label: '费用项目' }, { value: 'employeeId', label: '员工' }]
const form = reactive<Row>({})
const resourceLabel = computed(() => labelFor(resources, resource.value))
const filteredRows = computed(() => {
  const text = keyword.value.trim().toLocaleLowerCase()
  if (!text) return rows.value
  return rows.value.filter(row => {
    const values = resource.value === 'category-account-maps'
      ? [row.categoryId, categoryName(row.categoryId), row.accountId, accountName(row.accountId), labelFor(purposes, row.purpose)]
      : [row.code, row.name]
    return values.some(value => value != null && String(value).toLocaleLowerCase().includes(text))
  })
})
const pageRows = computed(() => filteredRows.value.slice((page.value - 1) * pageSize.value, page.value * pageSize.value))
let alive = true, listRequest = 0, booksRequest = 0
let editorContext: { book: number; resource: string } | undefined

function labelFor(options: Option[], value: unknown) {
  return options.find(option => option.value === value)?.label ?? (value == null || value === '' ? '—' : String(value))
}
function categoryName(id: number) { return categories.value.find(row => row.id === id)?.name ?? `分类 ID ${id}` }
function accountName(id: number) {
  const account = accounts.value.find(row => row.id === id)
  return account ? `${account.code} ${account.name}` : `科目 ID ${id}`
}
function reason(error: unknown) { return error instanceof Error ? error.message : String(error) }
function resetPage() { page.value = 1 }

async function loadBooks() {
  const request = ++booksRequest
  booksLoading.value = true; booksError.value = ''; books.value = []
  try {
    const result = await http.get<Row[]>('/fin/books')
    if (!alive || request !== booksRequest) return
    books.value = result
    if (!result.some(book => book.id === bookId.value)) bookId.value = result.length === 1 ? result[0]!.id : undefined
    await changeContext()
  } catch (error) {
    if (alive && request === booksRequest) booksError.value = reason(error)
  } finally {
    if (alive && request === booksRequest) booksLoading.value = false
  }
}

async function load() {
  const request = ++listRequest, book = bookId.value, type = resource.value
  rows.value = []; accounts.value = []; categories.value = []; loadError.value = ''; referenceError.value = ''; loading.value = false
  if (!book) return
  const current = () => alive && request === listRequest && book === bookId.value && type === resource.value
  const assertCurrent = () => { if (!current()) throw new Error('配置已切换') }
  loading.value = true
  try {
    const [result, accountOptions, categoryOptions] = await Promise.allSettled([
      allRecords<Row>('/fin/' + type, { bookId: book }, assertCurrent),
      type === 'category-account-maps' ? allRecords<Row>('/fin/accounts', { bookId: book }, assertCurrent) : Promise.resolve([]),
      type === 'category-account-maps' ? allRecords<Row>('/md/categories', {}, assertCurrent) : Promise.resolve([]),
    ])
    if (!current()) return
    if (result.status === 'rejected') throw result.reason
    rows.value = result.value
    accounts.value = type === 'accounts' ? result.value : accountOptions.status === 'fulfilled' ? accountOptions.value : []
    categories.value = categoryOptions.status === 'fulfilled' ? categoryOptions.value : []
    referenceError.value = [accountOptions.status === 'rejected' ? '会计科目：' + reason(accountOptions.reason) : '', categoryOptions.status === 'rejected' ? '商品分类：' + reason(categoryOptions.reason) : ''].filter(Boolean).join('；')
    page.value = Math.min(page.value, Math.max(1, Math.ceil(filteredRows.value.length / pageSize.value)))
  } catch (error) {
    if (current()) loadError.value = reason(error)
  } finally {
    if (current()) loading.value = false
  }
}

async function changeContext() {
  dialog.value = false; editorContext = undefined; saveError.value = ''; savedNotice.value = false
  keyword.value = ''; resetPage()
  await load()
}

function edit(row?: Row) {
  if (!canEdit.value || !bookId.value || loading.value || loadError.value || referenceError.value || booksLoading.value || booksError.value || saving.value) return
  Object.keys(form).forEach(key => delete form[key])
  Object.assign(form, row ? JSON.parse(JSON.stringify(row)) : { code: '', name: '', category: resource.value === 'cashflow-items' ? 'OPERATING' : 'ASSET', direction: resource.value === 'cashflow-items' ? 'BOTH' : 'DEBIT', isLeaf: true, fxEnabled: false, isCash: false, isBank: false, auxTypes: [], status: 'ENABLED', numberRule: 'DATE_SEQUENCE', purpose: 'INVENTORY', reconcileType: null })
  editorContext = { book: bookId.value, resource: resource.value }
  editing.value = row?.id; intent.reset(); saveError.value = ''; dialog.value = true
}

async function save() {
  if (!canEdit.value || saving.value || !dialog.value) return
  const context = editorContext
  if (!context || context.book !== bookId.value || context.resource !== resource.value) {
    saveError.value = '账套或配置类型已变化，请重新打开配置'; return
  }
  saveError.value = ''
  if (context.resource === 'category-account-maps') {
    if (!form.categoryId || !form.accountId || !form.purpose) { saveError.value = '请选择商品分类、用途和会计科目'; return }
  } else if (!String(form.code ?? '').trim() || !String(form.name ?? '').trim()) {
    saveError.value = '请填写编码和名称'; return
  }
  const payload = JSON.parse(JSON.stringify(form))
  const path = '/fin/' + context.resource + (editing.value ? '/' + editing.value : '') + '?bookId=' + context.book
  saving.value = true
  try {
    if (editing.value) await http.putIdem(path, payload, intent)
    else await http.postIdem(path, payload, intent)
  } catch (error) {
    if (alive && editorContext === context) saveError.value = reason(error)
    return
  } finally {
    saving.value = false
  }
  if (!alive || editorContext !== context || context.book !== bookId.value || context.resource !== resource.value) return
  dialog.value = false; savedNotice.value = true; ElMessage.success('配置已保存')
  await load()
}

onMounted(loadBooks)
onBeforeUnmount(() => { alive = false; listRequest++; booksRequest++ })
</script>

<template>
  <div class="page-card accounts-page">
    <div class="page-title accounts-heading">
      <div><h2>会计科目与核算配置</h2><p class="muted">按账套维护科目、现金流项目、凭证字与商品分类科目映射。</p></div>
      <el-button v-if="canEdit" type="primary" :disabled="!bookId || loading || booksLoading || !!booksError || !!loadError || !!referenceError || saving" @click="edit()">新增{{ resourceLabel }}</el-button>
    </div>
    <el-alert v-if="mockMode" class="accounts-notice" title="演示模式保留科目查询；核算配置使用真实服务维护。" type="info" :closable="false" />
    <el-alert v-if="booksError" class="accounts-notice" title="账套加载失败" type="error" :closable="false" show-icon>
      <p>{{ booksError }}</p><el-button @click="loadBooks">重新加载账套</el-button>
    </el-alert>
    <el-form class="accounts-filters" label-position="top" @submit.prevent>
      <el-form-item label="账套">
        <el-select v-model="bookId" filterable placeholder="请选择账套" :loading="booksLoading" :disabled="booksLoading || saving || !!booksError" @change="changeContext">
          <el-option v-for="book in books" :key="book.id" :label="book.name" :value="book.id" />
        </el-select>
      </el-form-item>
      <el-form-item v-if="!mockMode" label="配置类型">
        <el-select v-model="resource" :disabled="saving" @change="changeContext"><el-option v-for="item in resources" :key="item.value" :label="item.label" :value="item.value" /></el-select>
      </el-form-item>
      <el-form-item label="关键词">
        <el-input v-model="keyword" :placeholder="resource === 'category-account-maps' ? '分类、科目或用途' : '输入编码或名称'" clearable :disabled="!bookId || loading || !!loadError" @input="resetPage" @clear="resetPage" />
      </el-form-item>
      <el-form-item label="列表操作" class="accounts-refresh"><el-button :loading="loading" :disabled="!bookId || booksLoading || !!booksError || saving" @click="load">刷新</el-button></el-form-item>
    </el-form>

    <el-alert v-if="loadError" class="accounts-notice" :title="savedNotice ? '配置已保存，列表刷新失败，无需重复保存' : '配置加载失败'" type="error" :closable="false" show-icon>
      <p>{{ loadError }}</p><el-button :loading="loading" @click="load">重新加载</el-button>
    </el-alert>
    <el-alert v-if="referenceError" class="accounts-notice" title="关联资料加载失败，部分名称显示为 ID，暂不能编辑" type="warning" :closable="false" show-icon>
      <p>{{ referenceError }}</p><el-button :loading="loading" @click="load">重新加载</el-button>
    </el-alert>
    <div class="accounts-list-heading"><h3>{{ resourceLabel }}</h3><span v-if="bookId && !loading && !loadError && !booksError" class="muted">{{ filteredRows.length }} 条{{ keyword.trim() ? '匹配记录' : '配置' }}</span></div>
    <div class="table-scroll">
      <el-table v-loading="loading || booksLoading" :data="pageRows" row-key="id" border stripe>
        <template #empty>
          <span v-if="loading || booksLoading">正在加载配置…</span>
          <span v-else-if="booksError || loadError">读取失败，请重新加载</span>
          <el-empty v-else :image-size="48" :description="!bookId ? (books.length ? '请选择账套后查看配置' : '暂无可用账套') : keyword.trim() ? '没有匹配的配置，请调整关键词' : '暂无' + resourceLabel + '配置'" />
        </template>
        <template v-if="resource !== 'category-account-maps'">
          <el-table-column prop="code" label="编码" min-width="130" show-overflow-tooltip><template #default="{ row }"><span class="mono">{{ row.code }}</span></template></el-table-column>
          <el-table-column prop="name" label="名称" min-width="200" show-overflow-tooltip />
        </template>
        <template v-if="resource === 'accounts'">
          <el-table-column label="类别" min-width="115"><template #default="{ row }">{{ labelFor(accountCategories, row.category) }}</template></el-table-column>
          <el-table-column label="余额方向" min-width="100"><template #default="{ row }">{{ labelFor(directions, row.direction) }}</template></el-table-column>
          <el-table-column label="核算属性" min-width="180"><template #default="{ row }">{{ [row.isLeaf == null ? '' : row.isLeaf ? '末级' : '非末级', row.fxEnabled ? '外币' : '', row.isCash ? '现金' : '', row.isBank ? '银行' : ''].filter(Boolean).join(' · ') || '—' }}</template></el-table-column>
          <el-table-column label="辅助核算" min-width="200" show-overflow-tooltip><template #default="{ row }">{{ Array.isArray(row.auxTypes) && row.auxTypes.length ? row.auxTypes.map((value: string) => labelFor(auxTypes, value)).join('、') : '—' }}</template></el-table-column>
          <el-table-column label="核对用途" min-width="120"><template #default="{ row }">{{ labelFor(reconcileTypes, row.reconcileType) }}</template></el-table-column>
        </template>
        <template v-if="resource === 'cashflow-items'">
          <el-table-column label="活动类别" min-width="150"><template #default="{ row }">{{ labelFor(cashflowCategories, row.category) }}</template></el-table-column>
          <el-table-column label="收支方向" min-width="120"><template #default="{ row }">{{ labelFor(directions, row.direction) }}</template></el-table-column>
        </template>
        <el-table-column v-if="resource === 'voucher-words'" label="编号规则" min-width="230"><template #default="{ row }">{{ row.numberRule === 'DATE_SEQUENCE' ? '凭证字 + 日期 + 唯一序号' : row.numberRule ?? '—' }}</template></el-table-column>
        <template v-if="resource === 'category-account-maps'">
          <el-table-column label="商品分类" min-width="220" show-overflow-tooltip><template #default="{ row }">{{ categoryName(row.categoryId) }}<div class="muted mono">ID {{ row.categoryId }}</div></template></el-table-column>
          <el-table-column label="用途" min-width="130"><template #default="{ row }">{{ labelFor(purposes, row.purpose) }}</template></el-table-column>
          <el-table-column label="会计科目" min-width="240" show-overflow-tooltip><template #default="{ row }">{{ accountName(row.accountId) }}<div class="muted mono">ID {{ row.accountId }}</div></template></el-table-column>
        </template>
        <el-table-column v-if="resource !== 'category-account-maps'" label="状态" width="100"><template #default="{ row }"><StatusTag :status="row.status" /></template></el-table-column>
        <el-table-column v-if="canEdit" label="操作" width="90" fixed="right"><template #default="{ row }"><el-button type="primary" link :disabled="loading || saving || !!referenceError" @click="edit(row)">编辑</el-button></template></el-table-column>
      </el-table>
    </div>
    <div class="accounts-pagination">
      <span class="muted">共 {{ filteredRows.length }} 条</span>
      <el-pagination v-model:current-page="page" v-model:page-size="pageSize" :page-sizes="[20, 50, 100]" :total="filteredRows.length" layout="sizes, prev, pager, next" :pager-count="5" background :disabled="loading || booksLoading || !!loadError || !!booksError || !bookId" @size-change="resetPage" />
    </div>

    <el-dialog v-model="dialog" :title="(editing ? '编辑' : '新增') + resourceLabel" width="min(720px, 94vw)" :close-on-click-modal="!saving" :close-on-press-escape="!saving" :show-close="!saving">
      <el-alert v-if="saveError" class="accounts-notice" title="配置未保存" type="error" :closable="false" show-icon><p>{{ saveError }}</p></el-alert>
      <el-form class="accounts-editor" label-position="top" :disabled="saving" @submit.prevent="save">
        <div v-if="resource !== 'category-account-maps'" class="accounts-form-grid">
          <el-form-item label="编码" required><el-input v-model="form.code" placeholder="请输入编码" /></el-form-item>
          <el-form-item label="名称" required><el-input v-model="form.name" placeholder="请输入名称" /></el-form-item>
          <el-form-item label="状态"><el-select v-model="form.status"><el-option label="启用" value="ENABLED" /><el-option label="停用" value="DISABLED" /></el-select></el-form-item>
        </div>
        <template v-if="resource === 'accounts'">
          <h3 class="accounts-section">核算规则</h3>
          <p class="muted accounts-help">已被凭证或期初引用的科目，核算规则的修改受限制。</p>
          <div class="accounts-form-grid">
            <el-form-item label="上级科目"><el-select v-model="form.parentId" filterable clearable placeholder="无上级科目"><el-option v-for="item in accounts.filter(item => !item.isLeaf && item.id !== editing)" :key="item.id" :value="item.id" :label="item.code + ' ' + item.name" /></el-select></el-form-item>
            <el-form-item label="科目类别"><el-select v-model="form.category"><el-option v-for="item in accountCategories" :key="item.value" :value="item.value" :label="item.label" /></el-select></el-form-item>
            <el-form-item label="余额方向"><el-select v-model="form.direction"><el-option label="借方" value="DEBIT" /><el-option label="贷方" value="CREDIT" /></el-select></el-form-item>
            <el-form-item label="核对用途"><el-select v-model="form.reconcileType" clearable placeholder="不指定核对用途"><el-option v-for="item in reconcileTypes" :key="item.value" :value="item.value" :label="item.label" /></el-select></el-form-item>
          </div>
          <el-form-item label="核算属性"><div class="accounts-checkboxes"><el-checkbox v-model="form.isLeaf">末级科目</el-checkbox><el-checkbox v-model="form.fxEnabled">外币核算</el-checkbox><el-checkbox v-model="form.isCash">现金</el-checkbox><el-checkbox v-model="form.isBank">银行</el-checkbox></div></el-form-item>
          <el-form-item label="辅助核算"><el-select v-model="form.auxTypes" multiple placeholder="不启用辅助核算"><el-option v-for="item in auxTypes" :key="item.value" :value="item.value" :label="item.label" /></el-select></el-form-item>
        </template>
        <div v-if="resource === 'cashflow-items'" class="accounts-form-grid">
          <el-form-item label="活动类别"><el-select v-model="form.category"><el-option v-for="item in cashflowCategories" :key="item.value" :value="item.value" :label="item.label" /></el-select></el-form-item>
          <el-form-item label="收支方向"><el-select v-model="form.direction"><el-option label="流入" value="IN" /><el-option label="流出" value="OUT" /><el-option label="双向" value="BOTH" /></el-select></el-form-item>
        </div>
        <template v-if="resource === 'voucher-words'">
          <el-alert class="accounts-notice" title="凭证号按凭证字、日期和唯一序号生成" type="info" :closable="false" />
          <el-form-item label="编号规则"><el-input :model-value="form.numberRule === 'DATE_SEQUENCE' ? '凭证字 + 日期 + 唯一序号' : form.numberRule" readonly /></el-form-item>
        </template>
        <template v-if="resource === 'category-account-maps'">
          <el-form-item label="商品分类" required><el-select v-model="form.categoryId" filterable placeholder="请选择商品分类"><el-option v-for="item in categories" :key="item.id" :label="item.name" :value="item.id" /></el-select></el-form-item>
          <el-form-item label="用途" required><el-select v-model="form.purpose"><el-option v-for="item in purposes" :key="item.value" :label="item.label" :value="item.value" /></el-select></el-form-item>
          <el-form-item label="会计科目" required><el-select v-model="form.accountId" filterable placeholder="请选择末级科目"><el-option v-for="item in accounts.filter(item => item.isLeaf)" :key="item.id" :label="item.code + ' ' + item.name" :value="item.id" /></el-select></el-form-item>
        </template>
      </el-form>
      <template #footer><el-button :disabled="saving" @click="dialog = false">取消</el-button><el-button type="primary" :loading="saving" @click="save">保存</el-button></template>
    </el-dialog>
  </div>
</template>

<style scoped lang="scss">
.accounts-page { min-width: 0; }
.accounts-heading { align-items: flex-start; flex-wrap: wrap; }
.accounts-heading p { margin: 8px 0 0; line-height: 1.6; }
.accounts-notice { margin-bottom: 16px; }
.accounts-notice p { margin: 4px 0 8px; overflow-wrap: anywhere; }
.accounts-filters { display: grid; grid-template-columns: minmax(180px, 1fr) minmax(180px, 1fr) minmax(200px, 1.2fr) auto; gap: 12px; }
.accounts-filters :deep(.el-form-item) { min-width: 0; margin-bottom: 12px; }
.accounts-page :deep(.el-select), .accounts-editor :deep(.el-select) { width: 100%; }
.accounts-list-heading { display: flex; align-items: center; flex-wrap: wrap; gap: 12px; margin: 4px 0 12px; }
.accounts-list-heading h3, .accounts-section { font-size: 14px; font-weight: 600; margin: 0; }
.accounts-pagination { display: flex; justify-content: space-between; align-items: center; gap: 12px; flex-wrap: wrap; margin-top: 16px; }
.accounts-pagination :deep(.el-pagination) { flex-wrap: wrap; gap: 8px; }
.accounts-form-grid { display: grid; grid-template-columns: repeat(2, minmax(0, 1fr)); column-gap: 16px; }
.accounts-section { padding-top: 12px; border-top: 1px solid var(--el-border-color-lighter); }
.accounts-help { margin: 8px 0 16px; line-height: 1.6; }
.accounts-checkboxes { display: flex; gap: 8px 16px; flex-wrap: wrap; }
.accounts-checkboxes :deep(.el-checkbox) { margin-right: 0; }
.accounts-page :deep(button:focus-visible) { outline: 2px solid var(--el-color-primary); outline-offset: 3px; }
@media (max-width: 1024px) { .accounts-filters { grid-template-columns: repeat(2, minmax(0, 1fr)); } }
@media (max-width: 768px) {
  .accounts-filters, .accounts-form-grid { grid-template-columns: minmax(0, 1fr); }
  .accounts-heading > div { width: 100%; }
  .accounts-pagination > span { width: 100%; }
  .accounts-pagination :deep(.el-pagination__sizes) { width: 100%; margin: 0; }
}
</style>
