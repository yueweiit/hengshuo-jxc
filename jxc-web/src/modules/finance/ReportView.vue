<script setup lang="ts">
import { computed, onMounted, reactive, ref } from 'vue'
import { ElMessage, ElMessageBox } from 'element-plus'
import { useRouter } from 'vue-router'
import { http, createCommandIntent } from '@/api/http'
import { allRecords } from '@/api/pagination'
import MoneyText from '@/components/MoneyText.vue'
import { useCountryStore } from '@/stores/country'
import { useUserStore } from '@/stores/user'
type Row = Record<string, any>
const router = useRouter(), country = useCountryStore(), user = useUserStore()
const tab = ref('BALANCE_SHEET'), books = ref<Row[]>([]), bookId = ref<number>(), periodId = ref<number>()
const data = ref<Row | null>(null), busy = ref(false), templates = ref<Row[]>([]), templateDialog = ref(false)
const templateForm = reactive<{ id?: number; version?: number; name: string; rule: string; lines: Row[] }>({ name: '', rule: 'CATEGORY_V1', lines: [] })
const templateAccounts = ref<Row[]>([])
const templateIntent = createCommandIntent(), reviewIntent = createCommandIntent(), exportIntent = createCommandIntent()
const periods = computed<Row[]>(() => books.value.find(b => b.id === bookId.value)?.periods ?? [])
const demo = import.meta.env.MODE === 'demo' && import.meta.env.VITE_USE_MOCK === 'true'
let requestSequence = 0
async function load() {
  const sequence = ++requestSequence
  data.value = null
  if (!bookId.value || !periodId.value) return
  busy.value = true
  try {
    const result = await http.get<Row>('/fin/reports/' + tab.value, { bookId: bookId.value, periodId: periodId.value })
    if (sequence === requestSequence) data.value = result
  } finally { if (sequence === requestSequence) busy.value = false }
}
function changeBook() { periodId.value = undefined; data.value = null; templates.value = []; requestSequence++ }
function openBalance(accountId: number) { router.push({ path: '/finance/ledgers', query: { bookId: bookId.value, periodId: periodId.value, accountId, tab: 'balance' } }) }
async function loadTemplates() {
  if (demo || !bookId.value || !user.hasPerm(['fin:mapping:edit', 'fin:mapping:review'])) return
  templates.value = (await allRecords<Row>('/fin/report-templates', { bookId: bookId.value, type: tab.value }))
}
function newTemplate() { templateForm.id = templateForm.version = undefined; templateForm.name = ''; templateForm.rule = 'CATEGORY_V1'; templateForm.lines = [] }
function editTemplate(row: Row) {
  templateForm.id = row.status === 'NEED_REVIEW' ? row.id : undefined; templateForm.version = templateForm.id ? row.version : undefined
  templateForm.name = row.name + (templateForm.id ? '' : ' · 新版本'); templateForm.rule = row.rule
  templateForm.lines = (row.lines ?? []).map((line: Row) => ({ code: line.code, name: line.name, formula: line.formula, sign: line.sign, category: line.category, accountIds: [...(line.accountIds ?? [])], terms: (line.terms ?? []).map((term: Row) => ({ code: term.code, sign: term.sign })) }))
}
function addTemplateLine() { templateForm.lines.push({ code: '', name: '', formula: tab.value === 'INCOME' ? 'PERIOD_NET' : 'CLOSING_NET', sign: 1, category: undefined, accountIds: [], terms: [] }) }
function changeFormula(line: Row) { line.category = undefined; line.accountIds = []; line.terms = [] }
async function showTemplates() { await loadTemplates(); templateAccounts.value = (await allRecords<Row>('/fin/accounts', { bookId: bookId.value })); newTemplate(); templateDialog.value = true }
async function createTemplate() {
  if (busy.value || !templateForm.name.trim()) return
  busy.value = true
  try {
    const payload = { bookId: bookId.value, reportType: tab.value, name: templateForm.name.trim(), rule: templateForm.rule, ...(templateForm.rule === 'ACCOUNT_MAP_V1' ? { lines: templateForm.lines } : {}), ...(templateForm.id ? { version: templateForm.version } : {}) }
    if (templateForm.id) await http.putIdem('/fin/report-templates/' + templateForm.id, payload, templateIntent)
    else await http.postIdem('/fin/report-templates', payload, templateIntent)
    newTemplate(); await loadTemplates(); ElMessage.success('模板草稿已保存，请财务复核后生效')
  } finally { busy.value = false }
}
async function reviewTemplate(row: Row) {
  if (busy.value) return
  await ElMessageBox.confirm('确认已核对本账套的科目分类、余额方向和本模板规则，复核生效该版本？', '复核报表模板')
  busy.value = true
  try { await http.postIdem('/fin/report-templates/' + row.id + '/review', { bookId: bookId.value, version: row.version }, reviewIntent); await loadTemplates() }
  finally { busy.value = false }
  await load()
}
async function exportReport() {
  if (busy.value || !bookId.value || !periodId.value) return
  busy.value = true
  try { await http.postIdem('/fin/reports/' + tab.value + '/export', { bookId: bookId.value, periodId: periodId.value }, exportIntent); ElMessage.success('导出任务已创建'); await router.push('/jobs') }
  finally { busy.value = false }
}
onMounted(async () => { books.value = await http.get('/fin/books') })
</script>
<template>
  <el-card>
    <template #header>财务报表 · {{ country.current?.name }} · {{ country.timezone }}</template>
    <el-form inline :disabled="busy"><el-form-item label="账套"><el-select v-model="bookId" placeholder="请选择账套" style="width:260px;max-width:100%" @change="changeBook"><el-option v-for="b in books" :key="b.id" :label="b.name + ' · ' + b.baseCurrency" :value="b.id" /></el-select></el-form-item><el-form-item label="期间"><el-select v-model="periodId" placeholder="请选择期间" style="width: 230px" @change="load"><el-option v-for="p in periods" :key="p.id" :value="p.id" :label="p.name + ' · ' + p.status" /></el-select></el-form-item><el-button :disabled="!periodId" @click="load">刷新</el-button><el-button v-if="!demo && user.hasPerm('fin:report:export')" :disabled="!data || data.available === false" @click="exportReport">导出报表</el-button><el-button v-if="!demo && tab !== 'CASHFLOW' && user.hasPerm(['fin:mapping:edit','fin:mapping:review'])" :disabled="!bookId" @click="showTemplates">报表模板</el-button></el-form>
    <el-radio-group v-model="tab" :disabled="busy" @change="load"><el-radio-button value="BALANCE_SHEET">资产负债表</el-radio-button><el-radio-button value="INCOME">利润表</el-radio-button><el-radio-button value="CASHFLOW">现金流量表</el-radio-button></el-radio-group>
    <template v-if="data">
      <p>{{ data.periodName }} · 本位币 {{ data.currency }} · <el-tag :type="data.source === 'SNAPSHOT' ? 'success' : 'info'">{{ data.source === 'SNAPSHOT' ? '已结账快照' : '开放期间实时数据' }}</el-tag></p>
      <p v-if="data.source === 'SNAPSHOT'" class="muted">快照 {{ data.snapshotId }} · 结账代次 {{ data.closeGeneration }} · 来源指纹 {{ data.sourceFingerprint }}</p>
      <el-alert v-if="data.available === false" :title="'缺少已复核报表配置：' + (data.missingConfigurations ?? []).map((item: any) => typeof item === 'string' ? item : item.message || item.code).join('；')" type="warning" :closable="false" />
      <el-alert v-if="data.balanced === false" :title="'资产负债表不平，差额 ' + data.difference + ' ' + data.currency" type="error" :closable="false" />
      <p v-if="data.note" class="muted">{{ data.note }}</p>
      <el-table :data="data.lines" size="small" row-key="code"><el-table-column type="expand"><template #default="{ row }"><div style="padding: 8px 35px"><span v-if="!row.accounts?.length" class="muted">该项目没有可下钻的记账科目</span><el-button v-for="account in row.accounts ?? []" :key="account.accountId" :disabled="!user.hasPerm('fin:ledger:view')" link type="primary" @click="openBalance(account.accountId)">{{ account.code }} {{ account.name }} · 科目余额</el-button></div></template></el-table-column><el-table-column prop="name" label="项目" /><el-table-column label="金额"><template #default="{ row }"><MoneyText :value="row.amount" :currency="data.currency" /></template></el-table-column></el-table>
      <p class="muted">下钻：展开项目 → 科目余额 → 明细账 → 凭证 → 业务来源。金额取自服务端的已记账事实或对应结账快照。</p>
      <p v-if="data.trial">试算：借 <MoneyText :value="data.trial.debit" :currency="data.currency" /> · 贷 <MoneyText :value="data.trial.credit" :currency="data.currency" /> · {{ data.trial.balanced ? '平衡' : '不平衡' }}</p>
    </template><el-empty v-else-if="!busy" description="请选择账套和期间" />
    <el-dialog v-model="templateDialog" title="当前账套报表模板" width="1000px" :close-on-click-modal="!busy"><p class="muted">分类规则以当前账套科目配置取数。新建模板为草稿，财务复核后才用于实时报表；已结账报表继续读取原快照。</p><el-table :data="templates" size="small"><el-table-column prop="name" label="名称" /><el-table-column prop="versionNo" label="规则版本" /><el-table-column prop="status" label="状态" /><el-table-column label="操作"><template #default="{ row }"><el-button v-if="user.hasPerm('fin:mapping:edit')" :disabled="busy" link @click="editTemplate(row)">{{ row.status === 'NEED_REVIEW' ? '编辑草稿' : '复制新版本' }}</el-button><el-button v-if="row.status !== 'ACTIVE' && row.status !== 'RETIRED' && user.hasPerm('fin:mapping:review')" :disabled="busy" link @click="reviewTemplate(row)">复核生效</el-button></template></el-table-column></el-table><el-form v-if="user.hasPerm('fin:mapping:edit')" inline style="margin-top: 16px"><el-form-item label="新版本名称"><el-input v-model="templateForm.name" :disabled="busy" /></el-form-item><el-form-item label="规则"><el-select v-model="templateForm.rule" :disabled="busy" style="width: 180px"><el-option label="按科目分类取数" value="CATEGORY_V1" /><el-option label="按科目配置报表行" value="ACCOUNT_MAP_V1" /></el-select></el-form-item><el-button :disabled="busy || !templateForm.name.trim()" @click="createTemplate">保存待复核版本</el-button><el-button :disabled="busy" @click="newTemplate">新建版本</el-button></el-form>
      <template v-if="templateForm.rule === 'ACCOUNT_MAP_V1' && user.hasPerm('fin:mapping:edit')"><p class="muted">仅支持科目期末净额、本期净发生额与前序行加减。资产负债表需 ASSET、LIABILITY、EQUITY、RETAINED_PROFIT 行，利润表需 PROFIT 行。</p>
      <el-table :data="templateForm.lines" size="small"><el-table-column label="代码 / 名称" width="180"><template #default="{ row }"><el-input v-model="row.code" placeholder="项目代码" /><el-input v-model="row.name" placeholder="项目名称" /></template></el-table-column><el-table-column label="公式" width="160"><template #default="{ row }"><el-select v-model="row.formula" @change="changeFormula(row)"><el-option label="期末净额" value="CLOSING_NET" /><el-option label="本期净发生额" value="PERIOD_NET" /><el-option label="前序行加减" value="LINE_SUM" /></el-select><el-select v-model="row.sign"><el-option label="正向" :value="1" /><el-option label="反向" :value="-1" /></el-select></template></el-table-column><el-table-column label="取数科目 / 前序行"><template #default="{ row, $index }"><template v-if="row.formula !== 'LINE_SUM'"><el-select v-model="row.category" clearable placeholder="按科目分类" @change="row.accountIds = []"><el-option v-for="category in ['ASSET','LIABILITY','EQUITY','INCOME','COST','EXPENSE','PROFIT_LOSS']" :key="category" :label="category" :value="category" /></el-select><el-select v-model="row.accountIds" multiple filterable placeholder="选择本账套科目" @change="row.category = undefined"><el-option v-for="a in templateAccounts" :key="a.id" :value="a.id" :label="a.code + ' ' + a.name" /></el-select></template><template v-else><div v-for="(term, ti) in row.terms" :key="ti"><el-select v-model="term.code" placeholder="前序行"><el-option v-for="previous in templateForm.lines.slice(0, $index)" :key="previous.code" :label="previous.code + ' ' + previous.name" :value="previous.code" /></el-select><el-select v-model="term.sign"><el-option label="加" :value="1" /><el-option label="减" :value="-1" /></el-select><el-button link @click="row.terms.splice(ti, 1)">移除</el-button></div><el-button :disabled="!$index" link @click="row.terms.push({ code: '', sign: 1 })">添加前序行</el-button></template></template></el-table-column><el-table-column width="70"><template #default="{ $index }"><el-button link @click="templateForm.lines.splice($index, 1)">删除行</el-button></template></el-table-column></el-table><el-button :disabled="busy" @click="addTemplateLine">添加报表行</el-button></template></el-dialog>
  </el-card>
</template>
