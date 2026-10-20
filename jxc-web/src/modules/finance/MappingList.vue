<script setup lang="ts">
import { computed, onMounted, ref } from 'vue'
import { ElMessage, ElMessageBox } from 'element-plus'
import { getToken, getCountryId } from '@/utils/session'
import { http, createCommandIntent } from '@/api/http'
import { allRecords } from '@/api/pagination'
import StatusTag from '@/components/StatusTag.vue'

type Row = Record<string, any>
const intent = createCommandIntent()
const rows = ref<Row[]>([]), books = ref<Row[]>([]), events = ref<Row[]>([]), cashflows = ref<Row[]>([])
const bookId = ref<number>(), eventId = ref<number>(), sim = ref<Row | null>(null), editor = ref(false)
const editingId = ref<number>(), form = ref<Row>({})
const simulationTemplate = ref<Row | null>(null)
const selectedEvents = computed(() => events.value.filter(e => e.eventType === simulationTemplate.value?.eventType))
const amountFields = ['postingInventoryAmount', 'postingCogsAmount', 'postingCounterpartAmount', 'differenceAmount', 'apAmount', 'costAmount', 'amount', 'amountExclTax', 'taxAmount', 'cogsAmount', 'billBaseAmount', 'payBaseAmount', 'fxDiff', 'inventoryAmount', 'soldAmount', 'baseAmount', 'purchaseAmount', 'feeAmount', 'offsetAmount', 'refundableAmount']
const newLine = () => ({ direction: 'DEBIT', accountRule: { type: 'FIXED', code: '' }, amountExpr: 'amount', auxJson: '{}', summary: '', cashflowItemId: null })
async function load() {
  if (!bookId.value) return
  rows.value = (await allRecords<Row>('/fin/mapping-templates', { bookId: bookId.value }))
  events.value = (await allRecords<Row>('/fin/events', { bookId: bookId.value }))
  cashflows.value = (await allRecords<Row>('/fin/cashflow-items', { bookId: bookId.value }))
  sim.value = null
}
function edit(row?: Row, newVersion = false) {
  editingId.value = newVersion ? undefined : row?.id
  form.value = row ? JSON.parse(JSON.stringify(row)) : { bookId: bookId.value, eventType: '', accountingMode: 'VOUCHER', noVoucherReason: '', lines: [newLine(), { ...newLine(), direction: 'CREDIT' }] }
  form.value.lines = form.value.lines.map((l: Row) => ({ ...l, auxJson: JSON.stringify(l.auxMapping ?? {}, null, 2) }))
  editor.value = true
}
async function save() {
  let lines: Row[]
  try { lines = form.value.accountingMode === 'NO_VOUCHER' ? [] : form.value.lines.map((l: Row) => ({ direction: l.direction, accountRule: l.accountRule, amountExpr: l.amountExpr, auxMapping: JSON.parse(l.auxJson), summary: l.summary, cashflowItemId: l.cashflowItemId || null })) }
  catch { ElMessage.error('辅助映射须填写 JSON 对象，例如 {"CUSTOMER":"customerId"}'); return }
  const body = { bookId: bookId.value, eventType: form.value.eventType, accountingMode: form.value.accountingMode, noVoucherReason: form.value.accountingMode === 'NO_VOUCHER' ? form.value.noVoucherReason : null, version: form.value.version, lines }
  if (editingId.value) await http.putIdem('/fin/mapping-templates/' + editingId.value, body, intent)
  else await http.postIdem('/fin/mapping-templates', body, intent)
  editor.value = false; await load()
}
async function review(row: Row) { await http.postIdem('/fin/mapping-templates/' + row.id + '/review', { version: row.version }, intent); await load() }
async function remove(row: Row) {
  await ElMessageBox.confirm('删除这份尚未复核的映射草稿？', '删除映射草稿')
  await intent.run(`${getToken()}:${getCountryId()}`, 'DELETE /fin/mapping-templates/' + row.id, { version: row.version, bookId: bookId.value }, key => http.delete('/fin/mapping-templates/' + row.id, { params: { version: row.version, bookId: bookId.value }, headers: { 'Idempotency-Key': key } }))
  await load()
}
async function simulate() {
  if (!simulationTemplate.value || !eventId.value) return
  sim.value = await http.post('/fin/mapping-templates/' + simulationTemplate.value.id + '/simulate?eventId=' + eventId.value, {})
}
onMounted(async () => { books.value = await http.get<Row[]>('/fin/books'); bookId.value = books.value.filter(b => b.status === 'ACTIVE').length === 1 ? books.value.find(b => b.status === 'ACTIVE')!.id : undefined; await load() })
</script>

<template>
  <el-card>
    <template #header>凭证映射</template>
    <p class="muted">每次变更建立独立版本，复核后才生效；试算读取选中的真实事件，不保存凭证。</p>
    <div class="toolbar">
      <el-select v-model="bookId" placeholder="账套" @change="load"><el-option v-for="b in books" :key="b.id" :value="b.id" :label="b.name" /></el-select>
      <el-button type="primary" :disabled="!bookId" @click="edit()">新增映射</el-button>
    </div>
    <el-table :data="rows" size="small">
      <el-table-column prop="eventType" label="事件" min-width="210" />
      <el-table-column prop="versionNo" label="版本" width="70" />
      <el-table-column label="会计解释" width="120"><template #default="{ row }">{{ row.accountingMode === 'NO_VOUCHER' ? '无会计影响' : '生成待审凭证' }}</template></el-table-column>
      <el-table-column label="状态" width="110"><template #default="{ row }"><StatusTag :status="row.status" /></template></el-table-column>
      <el-table-column label="无会计影响依据" min-width="150"><template #default="{ row }">{{ row.accountingMode === 'NO_VOUCHER' ? row.noVoucherReason : '—' }}</template></el-table-column>
      <el-table-column label="操作" width="310"><template #default="{ row }">
        <el-button link @click="simulationTemplate = row; eventId = undefined; sim = null">选择事件试算</el-button>
        <el-button v-if="row.status === 'NEED_REVIEW'" link @click="edit(row)">编辑</el-button>
        <el-button v-if="row.status === 'NEED_REVIEW'" link @click="review(row)">复核生效</el-button><el-button v-if="row.status === 'NEED_REVIEW'" link type="danger" @click="remove(row)">删除</el-button>
        <el-button v-else link @click="edit(row, true)">新增版本</el-button>
      </template></el-table-column>
    </el-table>
    <div v-if="simulationTemplate" class="toolbar">
      <span>{{ simulationTemplate.eventType }} · V{{ simulationTemplate.versionNo }}</span>
      <el-select v-model="eventId" placeholder="选择同类业务事件" style="width: 300px"><el-option v-for="e in selectedEvents" :key="e.id" :value="e.id" :label="`${e.sourceNo} · ${e.bizDate} · #${e.id}`" /></el-select>
      <el-button :disabled="!eventId" @click="simulate">试算</el-button>
    </div>
    <el-alert v-if="sim?.accountingMode === 'NO_VOUCHER'" title="已按所选映射试算为无会计影响；本次未保存解释或凭证。" type="info" :closable="false" />
    <el-table v-if="sim" :data="sim.lines" size="small"><el-table-column prop="accountCode" label="科目" /><el-table-column prop="debit" label="借方" /><el-table-column prop="credit" label="贷方" /><el-table-column prop="summary" label="摘要" /></el-table>
  </el-card>
  <el-dialog v-model="editor" :title="editingId ? '编辑待复核映射' : '新增映射版本'" width="1050px">
    <el-form label-width="110px">
      <el-form-item label="事件类型"><el-input v-model="form.eventType" :disabled="!!editingId" placeholder="例如 AR_RECEIPT_CONFIRMED" /></el-form-item>
      <el-form-item label="会计解释"><el-radio-group v-model="form.accountingMode"><el-radio-button value="VOUCHER">生成待审凭证</el-radio-button><el-radio-button value="NO_VOUCHER">无会计影响</el-radio-button></el-radio-group></el-form-item>
      <el-form-item v-if="form.accountingMode === 'NO_VOUCHER'" label="复核依据"><el-input v-model="form.noVoucherReason" type="textarea" placeholder="说明纯数量动作或已由其他事件承接会计确认的依据" /></el-form-item>
    </el-form>
    <template v-if="form.accountingMode === 'VOUCHER'">
      <p class="muted">金额只能选择来源金额字段；辅助映射示例：{"CUSTOMER":"customerId","FUND":"fundAccountId"}。</p>
      <el-table :data="form.lines" size="small">
        <el-table-column label="方向" width="100"><template #default="{ row }"><el-select v-model="row.direction"><el-option value="DEBIT" label="借方" /><el-option value="CREDIT" label="贷方" /></el-select></template></el-table-column>
        <el-table-column label="科目规则" width="135"><template #default="{ row }"><el-select v-model="row.accountRule.type"><el-option value="FIXED" label="固定科目" /><el-option value="FUND" label="资金账户" /><el-option value="EXPENSE" label="费用项目" /><el-option value="CATEGORY" label="商品分类" /></el-select></template></el-table-column>
        <el-table-column label="科目编码 / 分类用途" width="150"><template #default="{ row }"><el-input v-if="row.accountRule.type === 'FIXED'" v-model="row.accountRule.code" /><el-select v-else-if="row.accountRule.type === 'CATEGORY'" v-model="row.accountRule.purpose"><el-option v-for="p in ['INVENTORY','REVENUE','COGS']" :key="p" :value="p" /></el-select></template></el-table-column>
        <el-table-column label="金额字段" width="165"><template #default="{ row }"><el-select v-model="row.amountExpr"><el-option v-for="f in amountFields" :key="f" :value="f" /></el-select></template></el-table-column>
        <el-table-column label="辅助映射" min-width="150"><template #default="{ row }"><el-input v-model="row.auxJson" /></template></el-table-column>
        <el-table-column label="现金流项目" width="150"><template #default="{ row }"><el-select v-model="row.cashflowItemId" clearable placeholder="选择项目"><el-option v-for="item in cashflows" :key="item.id" :value="item.id" :label="`${item.code} ${item.name}`" /></el-select></template></el-table-column>
        <el-table-column label="摘要" min-width="100"><template #default="{ row }"><el-input v-model="row.summary" /></template></el-table-column>
        <el-table-column width="55"><template #default="{ $index }"><el-button link type="danger" @click="form.lines.splice($index, 1)">移除</el-button></template></el-table-column>
      </el-table>
      <el-button class="add-line" @click="form.lines.push(newLine())">增加分录</el-button>
    </template>
    <template #footer><el-button @click="editor = false">取消</el-button><el-button type="primary" @click="save">保存待复核版本</el-button></template>
  </el-dialog>
</template>
<style scoped>.toolbar { display: flex; gap: 12px; align-items: center; margin: 12px 0; }.add-line { margin-top: 12px; }</style>
