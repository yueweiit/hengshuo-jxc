<script setup lang="ts">
import { computed, onMounted, ref } from 'vue'
import { ElMessageBox } from 'element-plus'
import { getToken, getCountryId } from '@/utils/session'
import { http, createCommandIntent } from '@/api/http'
import { allRecords } from '@/api/pagination'
import StatusTag from '@/components/StatusTag.vue'
import MoneyText from '@/components/MoneyText.vue'

type Row = Record<string, any>
const intent = createCommandIntent()
const rows = ref<Row[]>([]), books = ref<Row[]>([]), events = ref<Row[]>([]), cashflows = ref<Row[]>([])
const bookId = ref<number>(), eventId = ref<number>(), sim = ref<Row | null>(null), editor = ref(false)
const editingId = ref<number>(), form = ref<Row>({})
const simulationTemplate = ref<Row | null>(null)
const selectedEvents = computed(() => events.value.filter(e => e.eventType === simulationTemplate.value?.eventType))
const bookCurrency = computed(() => books.value.find(b => b.id === bookId.value)?.baseCurrency)
const loading = ref(false), loadError = ref(''), booksLoading = ref(false), booksError = ref('')
const saving = ref(false), saveError = ref(''), action = ref(''), actionError = ref('')
const simulating = ref(false), simError = ref('')
const busy = computed(() => saving.value || !!action.value)
let readSequence = 0, simulationSequence = 0
const errorText = (error: unknown) => error instanceof Error && error.message.trim() ? error.message : '请求失败，未收到有效的错误说明，请重试'
const amountFields = ['postingInventoryAmount', 'postingCogsAmount', 'postingCounterpartAmount', 'differenceAmount', 'apAmount', 'costAmount', 'amount', 'amountExclTax', 'taxAmount', 'cogsAmount', 'billBaseAmount', 'payBaseAmount', 'fxDiff', 'inventoryAmount', 'soldAmount', 'baseAmount', 'purchaseAmount', 'feeAmount', 'offsetAmount', 'refundableAmount']
const newLine = () => ({ direction: 'DEBIT', accountRule: { type: 'FIXED', code: '' }, amountExpr: 'amount', auxJson: '{}', summary: '', cashflowItemId: null })
function clearSimulation() {
  simulationSequence++
  sim.value = null
  simError.value = ''
  simulating.value = false
}
function selectTemplate(row: Row) {
  clearSimulation()
  simulationTemplate.value = row
  eventId.value = undefined
}
async function load() {
  const sequence = ++readSequence, selectedBook = bookId.value
  rows.value = []; events.value = []; cashflows.value = []
  simulationTemplate.value = null; eventId.value = undefined; editor.value = false
  clearSimulation()
  loadError.value = ''
  actionError.value = ''
  loading.value = false
  if (!selectedBook) return
  const current = () => sequence === readSequence && selectedBook === bookId.value
  const assertCurrent = () => { if (!current()) throw new Error('账套读取已过期') }
  loading.value = true
  try {
    const [templates, sourceEvents, items] = await Promise.all([
      allRecords<Row>('/fin/mapping-templates', { bookId: selectedBook }, assertCurrent),
      allRecords<Row>('/fin/events', { bookId: selectedBook }, assertCurrent),
      allRecords<Row>('/fin/cashflow-items', { bookId: selectedBook }, assertCurrent),
    ])
    if (!current()) return
    rows.value = templates; events.value = sourceEvents; cashflows.value = items
  } catch (error) {
    if (current()) loadError.value = errorText(error)
  } finally {
    if (current()) loading.value = false
  }
}
async function initialize() {
  if (booksLoading.value) return
  booksLoading.value = true; booksError.value = ''
  try {
    books.value = await http.get<Row[]>('/fin/books', undefined, { silent: true })
    const active = books.value.filter(b => b.status === 'ACTIVE')
    bookId.value = active.length === 1 ? active[0]!.id : undefined
    await load()
  } catch (error) {
    books.value = []; bookId.value = undefined
    await load()
    booksError.value = errorText(error)
  } finally {
    booksLoading.value = false
  }
}
function edit(row?: Row, newVersion = false) {
  saveError.value = ''
  editingId.value = newVersion ? undefined : row?.id
  form.value = row ? JSON.parse(JSON.stringify(row)) : { bookId: bookId.value, eventType: '', accountingMode: 'VOUCHER', noVoucherReason: '', lines: [newLine(), { ...newLine(), direction: 'CREDIT' }] }
  form.value.lines = form.value.lines.map((l: Row) => ({ ...l, auxJson: JSON.stringify(l.auxMapping ?? {}, null, 2) }))
  editor.value = true
}
async function save() {
  if (busy.value || loading.value || !bookId.value) return
  saveError.value = ''
  let lines: Row[]
  try {
    lines = form.value.accountingMode === 'NO_VOUCHER' ? [] : form.value.lines.map((l: Row) => {
      const auxMapping = JSON.parse(l.auxJson)
      if (!auxMapping || Array.isArray(auxMapping) || typeof auxMapping !== 'object') throw new Error('辅助映射必须是对象')
      return { direction: l.direction, accountRule: l.accountRule, amountExpr: l.amountExpr, auxMapping, summary: l.summary, cashflowItemId: l.cashflowItemId || null }
    })
  } catch {
    saveError.value = '辅助映射须填写 JSON 对象，例如 {"CUSTOMER":"customerId"}'
    return
  }
  const body = { bookId: bookId.value, eventType: form.value.eventType, accountingMode: form.value.accountingMode, noVoucherReason: form.value.accountingMode === 'NO_VOUCHER' ? form.value.noVoucherReason : null, version: form.value.version, lines }
  saving.value = true
  try {
    if (editingId.value) await http.putIdem('/fin/mapping-templates/' + editingId.value, body, intent, { silent: true })
    else await http.postIdem('/fin/mapping-templates', body, intent, { silent: true })
    editor.value = false
    await load()
  } catch (error) {
    saveError.value = errorText(error)
  } finally {
    saving.value = false
  }
}
async function runAction(row: Row, name: string, execute: () => Promise<unknown>) {
  if (busy.value || loading.value) return
  action.value = `${name}:${row.id}`; actionError.value = ''
  try {
    await execute()
    await load()
  } catch (error) {
    if (error !== 'cancel' && error !== 'close') actionError.value = errorText(error)
  } finally {
    action.value = ''
  }
}
async function review(row: Row) {
  await runAction(row, 'review', () => http.postIdem('/fin/mapping-templates/' + row.id + '/review', { version: row.version }, intent, { silent: true }))
}
async function remove(row: Row) {
  await runAction(row, 'remove', async () => {
    await ElMessageBox.confirm('删除这份尚未复核的映射草稿？', '删除映射草稿', { type: 'warning', confirmButtonText: '删除草稿', cancelButtonText: '取消' })
    return intent.run(`${getToken()}:${getCountryId()}`, 'DELETE /fin/mapping-templates/' + row.id, { version: row.version, bookId: bookId.value }, key => http.delete('/fin/mapping-templates/' + row.id, { params: { version: row.version, bookId: bookId.value }, headers: { 'Idempotency-Key': key } }))
  })
}
async function simulate() {
  if (!simulationTemplate.value || !eventId.value || simulating.value || busy.value || loading.value) return
  const templateId = simulationTemplate.value.id, selectedEvent = eventId.value, selectedBook = bookId.value
  clearSimulation()
  const sequence = simulationSequence
  const current = () => sequence === simulationSequence && selectedBook === bookId.value && templateId === simulationTemplate.value?.id && selectedEvent === eventId.value
  simulating.value = true
  try {
    const result = await http.post<Row>('/fin/mapping-templates/' + templateId + '/simulate?eventId=' + selectedEvent, {}, { silent: true })
    if (current()) sim.value = result
  } catch (error) {
    if (current()) simError.value = errorText(error)
  } finally {
    if (current()) simulating.value = false
  }
}
onMounted(initialize)
</script>

<template>
  <div class="page mapping-page">
    <section class="page-card" aria-labelledby="mapping-title">
      <div class="page-title">
        <h2 id="mapping-title">凭证映射</h2>
        <el-button type="primary" :disabled="!bookId || booksLoading || loading || !!loadError || busy" @click="edit()">新增映射</el-button>
      </div>
      <p class="muted mapping-note">维护业务事件的记账规则，每次变更建立独立版本，复核后才生效。</p>
      <div class="toolbar mapping-toolbar">
        <label class="book-filter">
          <span>账套</span>
          <el-select v-model="bookId" filterable clearable placeholder="请选择账套" aria-label="账套" :loading="booksLoading" :disabled="booksLoading || busy || editor" @change="load">
            <el-option v-for="b in books" :key="b.id" :value="b.id" :label="b.name" />
          </el-select>
        </label>
        <el-button :loading="booksLoading || loading" :disabled="busy || editor" @click="booksError ? initialize() : load()">刷新</el-button>
        <span v-if="bookId && !loading && !loadError" class="muted">共 {{ rows.length }} 个映射版本</span>
      </div>
      <el-alert v-if="booksError" class="mapping-alert" type="error" title="账套读取失败" :description="booksError" :closable="false" show-icon>
        <template #default><p>{{ booksError }}</p><el-button :loading="booksLoading" @click="initialize">重试读取账套</el-button></template>
      </el-alert>
      <el-alert v-else-if="loadError" class="mapping-alert" type="error" title="映射与试算资料读取失败" :closable="false" show-icon>
        <template #default><p>{{ loadError }}</p><el-button @click="load">重试读取</el-button></template>
      </el-alert>
      <el-alert v-if="actionError" class="mapping-alert" type="error" title="操作未完成" :description="actionError" :closable="false" show-icon />
      <div v-if="booksLoading || loading" class="mapping-loading" role="status" aria-live="polite">{{ booksLoading ? '正在读取账套…' : '正在读取映射与试算资料…' }}<el-skeleton :rows="4" animated /></div>
      <el-empty v-else-if="!booksError && !bookId" :description="books.length ? '请先选择账套，再查看凭证映射' : '暂无可用账套，请先维护账套'" :image-size="72" />
      <div v-else-if="!booksError && !loadError" class="table-scroll">
        <el-table :data="rows" size="small" border stripe row-key="id">
          <el-table-column prop="eventType" label="业务事件" min-width="240" show-overflow-tooltip><template #default="{ row }"><span class="mono">{{ row.eventType }}</span></template></el-table-column>
          <el-table-column label="版本" width="76" align="center"><template #default="{ row }">V{{ row.versionNo }}</template></el-table-column>
          <el-table-column label="会计解释" width="130"><template #default="{ row }">{{ row.accountingMode === 'NO_VOUCHER' ? '无会计影响' : '生成待审凭证' }}</template></el-table-column>
          <el-table-column label="状态" width="100"><template #default="{ row }"><StatusTag :status="row.status" /></template></el-table-column>
          <el-table-column label="无会计影响依据" min-width="210" show-overflow-tooltip><template #default="{ row }">{{ row.accountingMode === 'NO_VOUCHER' ? row.noVoucherReason : '—' }}</template></el-table-column>
          <el-table-column label="操作" width="330" fixed="right">
            <template #default="{ row }">
              <div class="row-actions">
                <el-button link type="primary" :disabled="busy" @click="selectTemplate(row)">事件试算</el-button>
                <template v-if="row.status === 'NEED_REVIEW'">
                  <el-button link type="primary" :disabled="busy" @click="edit(row)">编辑</el-button>
                  <el-button link type="warning" :loading="action === `review:${row.id}`" :disabled="busy" @click="review(row)">复核生效</el-button>
                  <el-button link type="danger" :loading="action === `remove:${row.id}`" :disabled="busy" @click="remove(row)">删除</el-button>
                </template>
                <el-button v-else link type="primary" :disabled="busy" @click="edit(row, true)">新增版本</el-button>
              </div>
            </template>
          </el-table-column>
          <template #empty><el-empty description="当前账套暂无映射，可新增待复核版本" :image-size="72" /></template>
        </el-table>
      </div>
    </section>

    <section v-if="simulationTemplate" class="page-card simulation-section" aria-labelledby="simulation-title">
      <div class="page-title"><h2 id="simulation-title">业务事件试算</h2><el-button :disabled="simulating" @click="simulationTemplate = null; clearSimulation()">收起试算</el-button></div>
      <p class="muted mapping-note">读取所选真实事件进行试算，不保存解释或凭证。金额按当前账套本位币展示。</p>
      <div class="simulation-context"><span class="mono">{{ simulationTemplate.eventType }}</span><span>V{{ simulationTemplate.versionNo }}</span><StatusTag :status="simulationTemplate.status" /></div>
      <div class="toolbar mapping-toolbar">
        <label class="event-filter"><span>业务事件</span>
          <el-select v-model="eventId" filterable clearable placeholder="选择同类业务事件" aria-label="业务事件" :disabled="busy" @change="clearSimulation">
            <el-option v-for="e in selectedEvents" :key="e.id" :value="e.id" :label="`${e.sourceNo ?? '来源单号未记录'} · ${e.bizDate ?? '业务日期未记录'} · #${e.id}`" />
          </el-select>
        </label>
        <el-button type="primary" plain :disabled="!eventId || busy" :loading="simulating" @click="simulate">{{ simError ? '重新试算' : '开始试算' }}</el-button>
      </div>
      <el-alert v-if="!selectedEvents.length" title="当前账套没有同类业务事件，暂时无法试算" type="info" :closable="false" show-icon />
      <el-alert v-if="simError" class="mapping-alert" title="试算失败" :description="simError" type="error" :closable="false" show-icon />
      <p v-if="simulating" class="muted" role="status" aria-live="polite">正在读取所选事件并试算…</p>
      <template v-if="sim">
        <p class="simulation-source">试算来源：<span class="mono">{{ sim.sourceNo ?? '来源单号未记录' }}</span></p>
        <el-alert v-if="sim.accountingMode === 'NO_VOUCHER'" title="本次试算为无会计影响，未保存解释或凭证" type="info" :closable="false" show-icon />
        <template v-else>
          <el-alert v-if="!bookCurrency" class="mapping-alert" title="账套本位币未提供，以下保留原始金额，请核对账套配置" type="warning" :closable="false" show-icon />
          <div class="table-scroll">
            <el-table :data="sim.lines" size="small" border stripe>
              <el-table-column prop="accountCode" label="科目编码" min-width="140" show-overflow-tooltip><template #default="{ row }"><span class="mono">{{ row.accountCode }}</span></template></el-table-column>
              <el-table-column label="借方金额" min-width="180" align="right"><template #default="{ row }"><MoneyText v-if="bookCurrency" :value="row.debit" :currency="bookCurrency" /><span v-else class="mono">{{ row.debit ?? '—' }}</span></template></el-table-column>
              <el-table-column label="贷方金额" min-width="180" align="right"><template #default="{ row }"><MoneyText v-if="bookCurrency" :value="row.credit" :currency="bookCurrency" /><span v-else class="mono">{{ row.credit ?? '—' }}</span></template></el-table-column>
              <el-table-column prop="summary" label="摘要" min-width="240" show-overflow-tooltip />
              <template #empty>本次试算没有分录</template>
            </el-table>
          </div>
        </template>
      </template>
    </section>

    <el-dialog v-model="editor" class="mapping-editor" :title="editingId ? '编辑待复核映射' : '新增映射版本'" width="min(1180px, calc(100vw - 24px))" top="5vh" :close-on-click-modal="!saving" :close-on-press-escape="!saving" :show-close="!saving">
      <p class="muted mapping-note">{{ books.find(b => b.id === bookId)?.name }} · 保存为待复核版本，复核后才生效。</p>
      <el-alert v-if="saveError" class="mapping-alert" title="保存未完成" :description="saveError" type="error" :closable="false" show-icon />
      <el-form label-position="top" :disabled="saving" @submit.prevent="save">
        <div class="editor-fields">
          <el-form-item label="事件类型"><el-input v-model="form.eventType" :disabled="!!editingId" placeholder="例如 AR_RECEIPT_CONFIRMED" /></el-form-item>
          <el-form-item label="会计解释"><el-radio-group v-model="form.accountingMode"><el-radio-button value="VOUCHER">生成待审凭证</el-radio-button><el-radio-button value="NO_VOUCHER">无会计影响</el-radio-button></el-radio-group></el-form-item>
        </div>
        <el-form-item v-if="form.accountingMode === 'NO_VOUCHER'" label="复核依据"><el-input v-model="form.noVoucherReason" type="textarea" :rows="4" placeholder="说明纯数量动作或已由其他事件承接会计确认的依据" /></el-form-item>
        <template v-if="form.accountingMode === 'VOUCHER'">
          <div class="entry-heading"><h3>分录规则</h3><span class="muted">共 {{ form.lines.length }} 条</span><el-button @click="form.lines.push(newLine())">增加分录</el-button></div>
          <p class="muted mapping-note">金额选择来源字段；辅助映射填写 JSON 对象，例如 {"CUSTOMER":"customerId","FUND":"fundAccountId"}。</p>
          <div class="table-scroll">
            <el-table :data="form.lines" size="small" border stripe>
              <el-table-column label="方向" width="110"><template #default="{ row }"><el-select v-model="row.direction" aria-label="分录方向"><el-option value="DEBIT" label="借方" /><el-option value="CREDIT" label="贷方" /></el-select></template></el-table-column>
              <el-table-column label="科目规则" width="140"><template #default="{ row }"><el-select v-model="row.accountRule.type" aria-label="科目规则"><el-option value="FIXED" label="固定科目" /><el-option value="FUND" label="资金账户" /><el-option value="EXPENSE" label="费用项目" /><el-option value="CATEGORY" label="商品分类" /></el-select></template></el-table-column>
              <el-table-column label="科目编码 / 分类用途" width="170"><template #default="{ row }"><el-input v-if="row.accountRule.type === 'FIXED'" v-model="row.accountRule.code" aria-label="科目编码" placeholder="填写科目编码" /><el-select v-else-if="row.accountRule.type === 'CATEGORY'" v-model="row.accountRule.purpose" aria-label="分类用途"><el-option value="INVENTORY" label="库存" /><el-option value="REVENUE" label="收入" /><el-option value="COGS" label="销售成本" /></el-select><span v-else class="muted">按来源项目取科目</span></template></el-table-column>
              <el-table-column label="金额字段" width="220"><template #default="{ row }"><el-select v-model="row.amountExpr" filterable aria-label="金额字段"><el-option v-for="f in amountFields" :key="f" :value="f" /></el-select></template></el-table-column>
              <el-table-column label="辅助映射" min-width="220"><template #default="{ row }"><el-input v-model="row.auxJson" type="textarea" :rows="2" aria-label="辅助映射 JSON 对象" /></template></el-table-column>
              <el-table-column label="现金流项目" width="185"><template #default="{ row }"><el-select v-model="row.cashflowItemId" filterable clearable placeholder="选择项目" aria-label="现金流项目"><el-option v-for="item in cashflows" :key="item.id" :value="item.id" :label="`${item.code} ${item.name}`" /></el-select></template></el-table-column>
              <el-table-column label="摘要" min-width="180"><template #default="{ row }"><el-input v-model="row.summary" aria-label="分录摘要" /></template></el-table-column>
              <el-table-column label="操作" width="72" fixed="right"><template #default="{ $index }"><el-button link type="danger" :aria-label="`移除第 ${$index + 1} 条分录`" @click="form.lines.splice($index, 1)">移除</el-button></template></el-table-column>
            </el-table>
          </div>
        </template>
      </el-form>
      <template #footer><div class="editor-footer"><el-button :disabled="saving" @click="editor = false">取消</el-button><el-button type="primary" :loading="saving" @click="save">保存待复核版本</el-button></div></template>
    </el-dialog>
  </div>
</template>

<style scoped>
.mapping-page { min-width: 0; }
.mapping-note { margin: 0 0 16px; line-height: 1.6; overflow-wrap: anywhere; }
.mapping-toolbar { align-items: center; }
.mapping-toolbar > .el-button, .row-actions > .el-button { margin-left: 0; }
.book-filter, .event-filter { display: flex; align-items: center; gap: 8px; min-width: 0; color: var(--el-text-color-regular); font-size: 13px; }
.book-filter > span, .event-filter > span { flex-shrink: 0; }
.book-filter .el-select { width: 260px; }
.event-filter { flex: 0 1 560px; }
.event-filter .el-select { flex: 1; min-width: 0; }
.mapping-alert { margin-bottom: 12px; }
.mapping-alert p { margin: 0 0 8px; white-space: pre-wrap; overflow-wrap: anywhere; }
.mapping-loading { display: grid; gap: 16px; padding: 16px 0; color: var(--el-text-color-secondary); font-size: 13px; }
.row-actions { display: flex; align-items: center; gap: 8px; }
.simulation-context { display: flex; align-items: center; flex-wrap: wrap; gap: 12px; margin-bottom: 16px; font-size: 13px; }
.simulation-context .mono { overflow-wrap: anywhere; }
.simulation-source { font-size: 13px; color: var(--el-text-color-regular); overflow-wrap: anywhere; }
.editor-fields { display: grid; grid-template-columns: minmax(0, 1fr) minmax(0, 1fr); gap: 16px; }
.editor-fields > * { min-width: 0; }
.entry-heading { display: flex; align-items: center; gap: 12px; margin: 8px 0 12px; }
.entry-heading h3 { margin: 0; font-size: 14px; font-weight: 600; }
.entry-heading > .el-button { margin-left: auto; }
.editor-footer { display: flex; justify-content: flex-end; flex-wrap: wrap; gap: 8px; }
.editor-footer > .el-button { margin-left: 0; }
@media (max-width: 768px) {
  .mapping-page .page-title { align-items: flex-start; flex-wrap: wrap; }
  .book-filter, .event-filter { flex-basis: 100%; width: 100%; }
  .book-filter .el-select { flex: 1; width: 0; }
  .editor-fields { grid-template-columns: minmax(0, 1fr); gap: 0; }
}
</style>
