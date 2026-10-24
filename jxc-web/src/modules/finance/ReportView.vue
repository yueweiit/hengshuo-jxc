<script setup lang="ts">
import { computed, onMounted, reactive, ref } from 'vue'
import { ElMessage, ElMessageBox } from 'element-plus'
import { useRouter } from 'vue-router'
import { http, createCommandIntent } from '@/api/http'
import { allRecords } from '@/api/pagination'
import MoneyText from '@/components/MoneyText.vue'
import StatusTag from '@/components/StatusTag.vue'
import { statusDef } from '@/utils/status'
import { useCountryStore } from '@/stores/country'
import { useUserStore } from '@/stores/user'
type Row = Record<string, any>
const router = useRouter(), country = useCountryStore(), user = useUserStore()
const tab = ref('BALANCE_SHEET'), books = ref<Row[]>([]), bookId = ref<number>(), periodId = ref<number>()
const data = ref<Row | null>(null), busy = ref(false), templates = ref<Row[]>([]), templateDialog = ref(false)
const booksBusy = ref(false), booksError = ref(''), reportError = ref(''), exportError = ref('')
const templatesBusy = ref(false), templateError = ref(''), commandBusy = ref(false), commandError = ref(''), templateNotice = ref('')
const templateForm = reactive<{ id?: number; version?: number; name: string; rule: string; lines: Row[] }>({ name: '', rule: 'CATEGORY_V1', lines: [] })
const templateAccounts = ref<Row[]>([])
const templateIntent = createCommandIntent(), reviewIntent = createCommandIntent(), exportIntent = createCommandIntent()
const periods = computed<Row[]>(() => books.value.find(b => b.id === bookId.value)?.periods ?? [])
const selectedBook = computed(() => books.value.find(b => b.id === bookId.value))
const reportTypes = [
  { value: 'BALANCE_SHEET', label: '资产负债表' },
  { value: 'INCOME', label: '利润表' },
  { value: 'CASHFLOW', label: '现金流量表' },
]
const reportTitle = computed(() => reportTypes.find(item => item.value === tab.value)?.label)
const working = computed(() => busy.value || commandBusy.value || templatesBusy.value)
const canManageTemplates = computed(() => !demo && user.hasPerm(['fin:mapping:edit', 'fin:mapping:review']))
const demo = import.meta.env.MODE === 'demo' && import.meta.env.VITE_USE_MOCK === 'true'
let requestSequence = 0
let templateSequence = 0
function failureMessage(error: unknown) { return error instanceof Error ? error.message : String(error) }
async function loadBooks() {
  booksBusy.value = true; booksError.value = ''
  try {
    const result = await http.get<Row[]>('/fin/books', {}, { silent: true })
    if (!Array.isArray(result)) throw new Error('账套返回内容不完整，请重新加载')
    books.value = result
  }
  catch (error) { booksError.value = failureMessage(error) }
  finally { booksBusy.value = false }
}
async function load() {
  const sequence = ++requestSequence
  data.value = null; reportError.value = ''; exportError.value = ''; busy.value = false
  if (!bookId.value || !periodId.value) return
  busy.value = true
  try {
    const result = await http.get<Row>('/fin/reports/' + tab.value, { bookId: bookId.value, periodId: periodId.value }, { silent: true })
    if (!result || !Array.isArray(result.lines)) throw new Error('报表返回内容不完整，请重新加载')
    if (sequence === requestSequence) data.value = result
  } catch (error) {
    if (sequence === requestSequence) reportError.value = failureMessage(error)
  } finally { if (sequence === requestSequence) busy.value = false }
}
function changeBook() {
  periodId.value = undefined; data.value = null; templates.value = []; templateAccounts.value = []
  reportError.value = ''; exportError.value = ''; templateError.value = ''; commandError.value = ''; templateNotice.value = ''
  busy.value = false; templatesBusy.value = false; requestSequence++; templateSequence++
}
function openBalance(accountId: number) { router.push({ path: '/finance/ledgers', query: { bookId: bookId.value, periodId: periodId.value, accountId, tab: 'balance' } }) }
async function loadTemplates() {
  if (demo || !bookId.value || !user.hasPerm(['fin:mapping:edit', 'fin:mapping:review'])) return
  const sequence = ++templateSequence, selectedBookId = bookId.value, selectedType = tab.value
  templatesBusy.value = true; templateError.value = ''; templates.value = []; templateAccounts.value = []
  try {
    const [rows, accounts] = await Promise.all([
      allRecords<Row>('/fin/report-templates', { bookId: selectedBookId, type: selectedType }),
      user.hasPerm('fin:mapping:edit') ? allRecords<Row>('/fin/accounts', { bookId: selectedBookId }) : Promise.resolve([]),
    ])
    if (sequence === templateSequence && selectedBookId === bookId.value && selectedType === tab.value) {
      templates.value = rows; templateAccounts.value = accounts
    }
  } catch (error) {
    if (sequence === templateSequence && selectedBookId === bookId.value && selectedType === tab.value) templateError.value = failureMessage(error)
  } finally { if (sequence === templateSequence) templatesBusy.value = false }
}
function newTemplate() { templateForm.id = templateForm.version = undefined; templateForm.name = ''; templateForm.rule = 'CATEGORY_V1'; templateForm.lines = [] }
function editTemplate(row: Row) {
  templateForm.id = row.status === 'NEED_REVIEW' ? row.id : undefined; templateForm.version = templateForm.id ? row.version : undefined
  templateForm.name = row.name + (templateForm.id ? '' : ' · 新版本'); templateForm.rule = row.rule
  templateForm.lines = (row.lines ?? []).map((line: Row) => ({ code: line.code, name: line.name, formula: line.formula, sign: line.sign, category: line.category, accountIds: [...(line.accountIds ?? [])], terms: (line.terms ?? []).map((term: Row) => ({ code: term.code, sign: term.sign })) }))
}
function addTemplateLine() { templateForm.lines.push({ code: '', name: '', formula: tab.value === 'INCOME' ? 'PERIOD_NET' : 'CLOSING_NET', sign: 1, category: undefined, accountIds: [], terms: [] }) }
function changeFormula(line: Row) { line.category = undefined; line.accountIds = []; line.terms = [] }
async function showTemplates() {
  if (!bookId.value || !canManageTemplates.value || tab.value === 'CASHFLOW') return
  newTemplate(); commandError.value = ''; templateNotice.value = ''; templateDialog.value = true
  await loadTemplates()
}
async function createTemplate() {
  if (working.value || templateError.value || !bookId.value || !user.hasPerm('fin:mapping:edit') || !templateForm.name.trim()) return
  commandBusy.value = true; commandError.value = ''; templateNotice.value = ''
  try {
    const payload = { bookId: bookId.value, reportType: tab.value, name: templateForm.name.trim(), rule: templateForm.rule, ...(templateForm.rule === 'ACCOUNT_MAP_V1' ? { lines: templateForm.lines } : {}), ...(templateForm.id ? { version: templateForm.version } : {}) }
    if (templateForm.id) await http.putIdem('/fin/report-templates/' + templateForm.id, payload, templateIntent)
    else await http.postIdem('/fin/report-templates', payload, templateIntent)
    newTemplate(); templateNotice.value = '模板草稿已保存，请财务复核后生效'; ElMessage.success(templateNotice.value); await loadTemplates()
  } catch (error) { commandError.value = failureMessage(error) }
  finally { commandBusy.value = false }
}
async function reviewTemplate(row: Row) {
  if (working.value || !bookId.value || !user.hasPerm('fin:mapping:review')) return
  commandBusy.value = true; commandError.value = ''; templateNotice.value = ''
  try {
    await ElMessageBox.confirm('确认已核对本账套的科目分类、余额方向和本模板规则，复核生效该版本？', '复核报表模板', { type: 'warning' })
    await http.postIdem('/fin/report-templates/' + row.id + '/review', { bookId: bookId.value, version: row.version }, reviewIntent)
    templateNotice.value = '模板已复核生效'; await loadTemplates(); await load()
  } catch (error) {
    if (error !== 'cancel' && error !== 'close') commandError.value = failureMessage(error)
  } finally { commandBusy.value = false }
}
async function exportReport() {
  if (working.value || !bookId.value || !periodId.value || !data.value || data.value.available === false || demo || !user.hasPerm('fin:report:export')) return
  commandBusy.value = true; exportError.value = ''
  try { await http.postIdem('/fin/reports/' + tab.value + '/export', { bookId: bookId.value, periodId: periodId.value }, exportIntent); ElMessage.success('导出任务已创建'); await router.push('/jobs') }
  catch (error) { exportError.value = failureMessage(error) }
  finally { commandBusy.value = false }
}
onMounted(loadBooks)
</script>
<template>
  <div class="page report-page">
    <section class="page-card">
      <header class="page-title report-title">
        <div>
          <h2>财务报表</h2>
          <p class="muted report-subtitle">按账套与会计期间核对报表，展开项目可查看科目余额</p>
        </div>
        <div class="toolbar report-actions">
          <el-button v-if="canManageTemplates && tab !== 'CASHFLOW'" :disabled="!bookId || working" @click="showTemplates">报表模板</el-button>
          <el-button v-if="!demo && user.hasPerm('fin:report:export')" type="primary" :loading="commandBusy && !templateDialog" :disabled="!data || data.available === false || working" @click="exportReport">导出报表</el-button>
        </div>
      </header>
      <el-form class="report-filters" label-position="top" :disabled="booksBusy || commandBusy || templatesBusy" @submit.prevent="load">
        <el-form-item label="账套">
          <el-select v-model="bookId" placeholder="请选择账套" :loading="booksBusy" :disabled="!!booksError" @change="changeBook">
            <el-option v-for="b in books" :key="b.id" :label="b.name + ' · ' + b.baseCurrency" :value="b.id" />
          </el-select>
        </el-form-item>
        <el-form-item label="会计期间">
          <el-select v-model="periodId" placeholder="请选择期间" :disabled="!bookId" @change="load">
            <el-option v-for="p in periods" :key="p.id" :value="p.id" :label="p.name + ' · ' + statusDef(p.status, 'period').label" />
          </el-select>
        </el-form-item>
        <el-form-item class="report-refresh">
          <el-button :loading="busy" :disabled="!bookId || !periodId" @click="load">刷新报表</el-button>
        </el-form-item>
      </el-form>
      <p class="muted report-context">{{ country.current?.name ?? '未选择国家' }} · {{ country.timezone }}</p>
    </section>

    <section class="page-card report-results" :aria-busy="booksBusy || busy" aria-label="财务报表结果">
      <el-radio-group v-model="tab" class="report-tabs" aria-label="报表类型" :disabled="commandBusy || templatesBusy" @change="load">
        <el-radio-button v-for="item in reportTypes" :key="item.value" :value="item.value">{{ item.label }}</el-radio-button>
      </el-radio-group>
      <div v-if="booksBusy" class="report-loading" role="status"><el-skeleton :rows="3" animated /><span class="muted">正在读取账套…</span></div>
      <div v-else-if="booksError" class="report-feedback" role="alert">
        <el-alert title="账套读取失败" type="error" :closable="false" show-icon><p>{{ booksError }}</p></el-alert>
        <el-button @click="loadBooks">重新加载账套</el-button>
      </div>
      <el-empty v-else-if="!books.length" description="当前国家没有可用账套" :image-size="64" />
      <el-empty v-else-if="!bookId" description="请选择账套和会计期间" :image-size="64" />
      <el-empty v-else-if="!periods.length" description="当前账套没有会计期间，请先在账套管理中配置" :image-size="64" />
      <div v-else-if="busy" class="report-loading" role="status"><el-skeleton :rows="5" animated /><span class="muted">正在读取{{ reportTitle }}…</span></div>
      <div v-else-if="reportError" class="report-feedback" role="alert">
        <el-alert title="报表读取失败" type="error" :closable="false" show-icon><p>{{ reportError }}</p></el-alert>
        <el-button @click="load">重新加载报表</el-button>
      </div>
      <template v-else-if="data">
        <header class="report-heading">
          <div><h3>{{ reportTitle }}</h3><p class="muted">{{ selectedBook?.name }} · {{ data.periodName }} · 本位币 {{ data.currency }}</p></div>
          <el-tag size="small" disable-transitions :type="data.source === 'SNAPSHOT' ? 'success' : 'info'">{{ data.source === 'SNAPSHOT' ? '已结账快照' : data.source === 'LIVE' ? '开放期间实时数据' : (data.source ?? '来源未提供') }}</el-tag>
        </header>
        <p v-if="data.source === 'SNAPSHOT'" class="muted report-snapshot">快照 {{ data.snapshotId }} · 结账代次 {{ data.closeGeneration }} · 来源指纹 <span class="mono">{{ data.sourceFingerprint }}</span></p>
        <el-alert v-if="data.available === false" class="report-alert" title="报表配置待补充或复核，暂不可导出" type="warning" :closable="false" show-icon>
          <p>请核对当前账套的已复核报表模板或现金流项目配置。</p>
          <ul v-if="data.missingConfigurations?.length" class="report-missing"><li v-for="(item, index) in data.missingConfigurations" :key="index">{{ typeof item === 'string' ? item : (item.message || item.code) }}</li></ul>
        </el-alert>
        <el-alert v-if="data.balanced === false" class="report-alert" title="资产负债表不平" type="error" :closable="false" show-icon>
          <span>差额 <MoneyText :value="data.difference" :currency="data.currency" /></span>
        </el-alert>
        <p v-if="data.note" class="muted report-note">{{ data.note }}</p>
        <div class="table-scroll">
          <el-table :data="data.lines" border stripe row-key="code" empty-text="当前期间没有报表项目">
            <el-table-column type="expand" width="44">
              <template #default="{ row }">
                <div class="report-accounts">
                  <span class="muted">{{ row.name }} · 科目余额</span>
                  <span v-if="!row.accounts?.length" class="muted">该项目没有可下钻的记账科目</span>
                  <div v-else class="report-account-links">
                    <el-button v-for="account in row.accounts" :key="account.accountId" :disabled="!user.hasPerm('fin:ledger:view')" size="small" link type="primary" @click="openBalance(account.accountId)">{{ account.code }} {{ account.name }} · 科目余额</el-button>
                  </div>
                  <span v-if="row.accounts?.length && !user.hasPerm('fin:ledger:view')" class="muted">当前账号没有查看科目余额的权限</span>
                </div>
              </template>
            </el-table-column>
            <el-table-column prop="name" label="报表项目" min-width="200" show-overflow-tooltip />
            <el-table-column label="金额" min-width="200" align="right" header-align="right"><template #default="{ row }"><MoneyText :value="row.amount" :currency="data.currency" /></template></el-table-column>
          </el-table>
        </div>
        <div v-if="data.trial" class="report-trial">
          <span>试算平衡</span><span>借方 <MoneyText :value="data.trial.debit" :currency="data.currency" /></span><span>贷方 <MoneyText :value="data.trial.credit" :currency="data.currency" /></span>
          <el-tag size="small" disable-transitions :type="data.trial.balanced === true ? 'success' : data.trial.balanced === false ? 'danger' : 'info'">{{ data.trial.balanced === true ? '平衡' : data.trial.balanced === false ? '不平衡' : '平衡状态未提供' }}</el-tag>
        </div>
        <p class="muted report-note">金额取自已记账事实或对应结账快照。下钻路径：报表项目 → 科目余额 → 明细账 → 凭证 → 业务来源。</p>
      </template>
      <el-empty v-else description="请选择会计期间查看报表" :image-size="64" />
      <el-alert v-if="exportError" class="report-alert" title="导出操作失败" type="error" :closable="false" show-icon><p>{{ exportError }}</p></el-alert>
    </section>

    <el-dialog v-model="templateDialog" class="report-template-dialog" title="当前账套报表模板" width="min(1000px, calc(100vw - 24px))" :close-on-click-modal="!working" :close-on-press-escape="!working" :show-close="!working">
      <p class="report-template-context">{{ selectedBook?.name }} · {{ reportTitle }}</p>
      <p class="muted report-note">新版本先保存为草稿，财务复核后用于实时报表；已结账报表继续读取原快照。</p>
      <el-alert v-if="templateNotice" class="report-alert" :title="templateNotice" type="success" :closable="false" show-icon />
      <el-alert v-if="commandError" class="report-alert" title="模板操作失败" type="error" :closable="false" show-icon><p>{{ commandError }}</p></el-alert>
      <div v-if="templatesBusy" class="report-loading" role="status"><el-skeleton :rows="3" animated /><span class="muted">正在读取模板与所需科目…</span></div>
      <div v-else-if="templateError" class="report-feedback" role="alert">
        <el-alert title="模板或科目读取失败" type="error" :closable="false" show-icon><p>{{ templateError }}</p><span v-if="templateNotice">上述操作已成功，无需重复提交，请重新加载列表。</span></el-alert>
        <el-button @click="loadTemplates">重新加载模板</el-button>
      </div>
      <template v-else>
        <section class="report-template-section" aria-label="已有模板版本">
          <h3>模板版本</h3>
          <div class="table-scroll">
            <el-table :data="templates" border stripe row-key="id" size="small" empty-text="当前报表尚无模板版本">
              <el-table-column prop="name" label="名称" min-width="200" show-overflow-tooltip />
              <el-table-column prop="versionNo" label="规则版本" width="100" />
              <el-table-column label="状态" width="100"><template #default="{ row }"><StatusTag :status="row.status" /></template></el-table-column>
              <el-table-column label="操作" min-width="200"><template #default="{ row }">
                <el-button v-if="user.hasPerm('fin:mapping:edit')" :disabled="working" size="small" link type="primary" @click="editTemplate(row)">{{ row.status === 'NEED_REVIEW' ? '编辑草稿' : '复制新版本' }}</el-button>
                <el-button v-if="row.status === 'NEED_REVIEW' && user.hasPerm('fin:mapping:review')" :disabled="working" size="small" link type="primary" @click="reviewTemplate(row)">复核生效</el-button>
              </template></el-table-column>
            </el-table>
          </div>
        </section>
        <el-form v-if="user.hasPerm('fin:mapping:edit')" class="report-template-section" label-position="top" :disabled="working" @submit.prevent="createTemplate">
          <h3>{{ templateForm.id ? '编辑待复核草稿' : '新建模板版本' }}</h3>
          <div class="report-template-fields">
            <el-form-item label="版本名称" required><el-input v-model="templateForm.name" maxlength="200" placeholder="输入便于识别的版本名称" /></el-form-item>
            <el-form-item label="取数规则"><el-select v-model="templateForm.rule"><el-option label="按科目分类取数" value="CATEGORY_V1" /><el-option label="按科目配置报表行" value="ACCOUNT_MAP_V1" /></el-select></el-form-item>
          </div>
          <template v-if="templateForm.rule === 'ACCOUNT_MAP_V1'">
            <p class="muted report-note">支持科目期末净额、本期净发生额与前序行加减。{{ tab === 'INCOME' ? '利润表需包含 PROFIT 行。' : '资产负债表需包含 ASSET、LIABILITY、EQUITY、RETAINED_PROFIT 行。' }}</p>
            <div class="table-scroll report-formula-scroll">
              <el-table :data="templateForm.lines" class="report-formula-table" border stripe size="small" empty-text="尚未配置报表行，请添加报表行">
                <el-table-column label="代码 / 名称" width="190"><template #default="{ row, $index }"><div class="report-line-fields">
                  <el-input v-model="row.code" placeholder="项目代码" :aria-label="'第' + ($index + 1) + '行项目代码'" />
                  <el-input v-model="row.name" placeholder="项目名称" :aria-label="'第' + ($index + 1) + '行项目名称'" />
                </div></template></el-table-column>
                <el-table-column label="公式 / 方向" width="170"><template #default="{ row, $index }"><div class="report-line-fields">
                  <el-select v-model="row.formula" :aria-label="'第' + ($index + 1) + '行公式'" @change="changeFormula(row)"><el-option label="期末净额" value="CLOSING_NET" /><el-option label="本期净发生额" value="PERIOD_NET" /><el-option label="前序行加减" value="LINE_SUM" /></el-select>
                  <el-select v-model="row.sign" :aria-label="'第' + ($index + 1) + '行方向'"><el-option label="正向" :value="1" /><el-option label="反向" :value="-1" /></el-select>
                </div></template></el-table-column>
                <el-table-column label="取数科目 / 前序行" min-width="320"><template #default="{ row, $index }">
                  <div v-if="row.formula !== 'LINE_SUM'" class="report-line-fields">
                    <el-select v-model="row.category" clearable placeholder="按科目分类" :aria-label="'第' + ($index + 1) + '行科目分类'" @change="row.accountIds = []"><el-option v-for="category in ['ASSET','LIABILITY','EQUITY','INCOME','COST','EXPENSE','PROFIT_LOSS']" :key="category" :label="category" :value="category" /></el-select>
                    <el-select v-model="row.accountIds" multiple filterable collapse-tags collapse-tags-tooltip placeholder="选择本账套科目" :aria-label="'第' + ($index + 1) + '行取数科目'" @change="row.category = undefined"><el-option v-for="a in templateAccounts" :key="a.id" :value="a.id" :label="a.code + ' ' + a.name" /></el-select>
                  </div>
                  <div v-else class="report-line-fields">
                    <div v-for="(term, ti) in row.terms" :key="ti" class="report-term">
                      <el-select v-model="term.code" placeholder="前序行" :aria-label="'第' + ($index + 1) + '行第' + (Number(ti) + 1) + '项前序行'"><el-option v-for="previous in templateForm.lines.slice(0, $index)" :key="previous.code" :label="previous.code + ' ' + previous.name" :value="previous.code" /></el-select>
                      <el-select v-model="term.sign" :aria-label="'第' + ($index + 1) + '行第' + (Number(ti) + 1) + '项运算'"><el-option label="加" :value="1" /><el-option label="减" :value="-1" /></el-select>
                      <el-button size="small" link type="danger" @click="row.terms.splice(ti, 1)">移除</el-button>
                    </div>
                    <el-button :disabled="!$index" size="small" link type="primary" @click="row.terms.push({ code: '', sign: 1 })">添加前序行</el-button>
                  </div>
                </template></el-table-column>
                <el-table-column label="操作" width="80"><template #default="{ $index }"><el-button size="small" link type="danger" @click="templateForm.lines.splice($index, 1)">删除行</el-button></template></el-table-column>
              </el-table>
            </div>
            <el-button class="report-add-line" :disabled="working" @click="addTemplateLine">添加报表行</el-button>
          </template>
          <div class="toolbar report-template-actions">
            <el-button type="primary" :loading="commandBusy" :disabled="working || !templateForm.name.trim()" @click="createTemplate">保存待复核版本</el-button>
            <el-button :disabled="working" @click="newTemplate">新建版本</el-button>
          </div>
        </el-form>
      </template>
      <template #footer><el-button :disabled="working" @click="templateDialog = false">关闭</el-button></template>
    </el-dialog>
  </div>
</template>

<style scoped>
.report-page { min-width: 0; }
.report-title { flex-wrap: wrap; align-items: flex-start; }
.report-subtitle { margin: 8px 0 0; line-height: 1.6; }
.report-actions { margin-bottom: 0; }
.report-actions :deep(.el-button + .el-button),
.report-account-links :deep(.el-button + .el-button),
.report-template-actions :deep(.el-button + .el-button) { margin-left: 0; }
.report-filters { display: grid; grid-template-columns: minmax(200px, 320px) minmax(200px, 280px) auto; align-items: end; gap: 12px; }
.report-filters :deep(.el-form-item) { min-width: 0; margin: 0; }
.report-filters :deep(.el-select), .report-template-fields :deep(.el-select) { width: 100%; }
.report-context { margin: 12px 0 0; overflow-wrap: anywhere; }
.report-tabs { display: flex; flex-wrap: wrap; margin-bottom: 16px; }
.report-heading { display: flex; justify-content: space-between; align-items: flex-start; gap: 12px; flex-wrap: wrap; margin-bottom: 12px; }
.report-heading h3, .report-template-section h3 { margin: 0; font-size: 15px; font-weight: 600; }
.report-heading p { margin: 8px 0 0; overflow-wrap: anywhere; }
.report-snapshot { margin: 0 0 12px; overflow-wrap: anywhere; line-height: 1.6; }
.report-alert { margin: 12px 0; }
.report-alert p, .report-feedback p { margin: 0; white-space: pre-wrap; overflow-wrap: anywhere; }
.report-missing { margin: 8px 0 0; padding-left: 20px; overflow-wrap: anywhere; }
.report-loading { display: grid; gap: 16px; padding: 16px 0; }
.report-feedback { display: grid; justify-items: start; gap: 12px; padding: 12px 0; }
.report-accounts { display: grid; gap: 8px; padding: 12px 16px; }
.report-account-links { display: flex; flex-wrap: wrap; gap: 8px 16px; }
.report-account-links :deep(.el-button) { height: auto; white-space: normal; text-align: left; line-height: 1.6; }
.report-trial { display: flex; flex-wrap: wrap; align-items: center; gap: 8px 16px; padding: 12px 0; border-bottom: 1px solid var(--el-border-color-lighter); font-size: 13px; font-variant-numeric: tabular-nums; }
.report-note { margin: 12px 0; line-height: 1.7; overflow-wrap: anywhere; }
.report-template-context { margin: 0; font-weight: 600; overflow-wrap: anywhere; }
.report-template-section { margin-top: 16px; }
.report-template-section h3 { margin-bottom: 12px; }
.report-template-fields { display: grid; grid-template-columns: minmax(0, 1fr) minmax(0, 1fr); gap: 12px; }
.report-template-fields :deep(.el-form-item) { min-width: 0; margin-bottom: 0; }
.report-formula-table { min-width: 760px; }
.report-line-fields { display: grid; gap: 8px; padding: 4px 0; }
.report-line-fields :deep(.el-select) { width: 100%; }
.report-term { display: grid; grid-template-columns: minmax(120px, 1fr) 70px auto; align-items: center; gap: 8px; }
.report-add-line { margin-top: 12px; }
.report-template-actions { margin-top: 16px; margin-bottom: 0; }
.report-page :deep(.el-button:focus-visible) { outline: 2px solid var(--el-color-primary); outline-offset: 3px; }
@media (max-width: 768px) {
  .report-filters, .report-template-fields { grid-template-columns: minmax(0, 1fr); }
  .report-actions { width: 100%; }
  .report-refresh :deep(.el-form-item__content), .report-refresh :deep(.el-button) { width: 100%; }
  .report-tabs { gap: 8px; }
  .report-tabs :deep(.el-radio-button__inner) { border: 1px solid var(--el-border-color); border-radius: 4px; box-shadow: none; }
}
</style>
