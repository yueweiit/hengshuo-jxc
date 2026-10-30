<script setup lang="ts">
import { feedbackMessage } from '@/api/error-feedback'
import { computed, onBeforeUnmount, onMounted, ref, watch } from 'vue'
import { ElMessage, ElMessageBox } from 'element-plus'
import { http, createCommandIntent } from '@/api/http'
import StatusTag from '@/components/StatusTag.vue'
import MoneyText from '@/components/MoneyText.vue'
import { statusDef } from '@/utils/status'
import { financeSourcePath } from '@/utils/finance-source'
import { useUserStore } from '@/stores/user'
import { useCountryStore } from '@/stores/country'

type Row = Record<string, any>
type Action = '' | 'check' | 'waive' | 'close' | 'preview' | 'reopen'
type Target = { bookId: number; periodId: number }
const user = useUserStore(), country = useCountryStore()
const books = ref<Row[]>([]), bookId = ref<number>(), periodId = ref<number>()
const booksLoading = ref(false), booksError = ref(''), operationError = ref(''), impactError = ref('')
const checks = ref<Row[]>([]), canClose = ref(false), hasChecked = ref(false), action = ref<Action>('')
const closeGeneration = ref<number>(), snapshots = ref<Row[]>([]), impact = ref<Row | null>(null)
const checkIntent = createCommandIntent(), waiveIntent = createCommandIntent(), closeIntent = createCommandIntent(), reopenIntent = createCommandIntent()
const demo = import.meta.env.MODE === 'demo' && import.meta.env.VITE_USE_MOCK === 'true'
const periods = computed<Row[]>(() => books.value.find(b => b.id === bookId.value)?.periods ?? [])
const selected = computed(() => periods.value.find(p => p.id === periodId.value))
const currency = computed(() => books.value.find(b => b.id === bookId.value)?.baseCurrency)
const busy = computed(() => action.value !== '')
const readyToClose = computed(() => !busy.value && !booksLoading.value && !booksError.value && hasChecked.value && canClose.value &&
  user.hasPerm('fin:period:close') && ['OPEN', 'PENDING_CLOSE'].includes(selected.value?.status) &&
  checks.value.length > 0 && checks.value.every(row => ['PASS', 'WAIVED'].includes(row.result)))
const summary = computed(() => ({
  total: checks.value.length,
  passed: checks.value.filter(row => row.result === 'PASS').length,
  failed: checks.value.filter(row => row.result === 'FAIL').length,
  waived: checks.value.filter(row => row.result === 'WAIVED').length,
  unknown: checks.value.filter(row => !['PASS', 'FAIL', 'WAIVED'].includes(row.result)).length,
}))
// 只有已验证的影响响应才包含两类依赖；未读取时不推断为零项。
const dependencyRows = computed<Row[]>(() => impact.value ? [...impact.value.dependencies, ...impact.value.closedDependencies] : [])
const CHECK_NAMES: Record<string, string> = {
  UNPOSTED: '凭证审核与记账', UNBALANCED: '凭证借贷平衡', EVENTS_OPEN: '业务事件会计处理',
  COST_PENDING: '成本与汇率资料', ALLOCATION_PENDING: '费用分摊确认', STOCKTAKE_PENDING: '盘点调整过账',
  RECON_DATA_MISSING: '核对资料完整性', AR_DIFF: '应收与总账核对', AP_DIFF: '应付与总账核对',
  INV_DIFF: '库存与总账核对', CASH_DIFF: '资金与总账核对', CASHFLOW_MISSING: '现金流项目',
  REPORT_CONFIG: '财务报表配置', NEXT_PERIOD: '下一期间连续性',
}
function checkName(code: string) { return CHECK_NAMES[code] ?? code }
// 公共期间映射尚未包含NOT_STARTED，只在本页补充这个已知状态的文案。
function periodLabel(status: string) { return status === 'NOT_STARTED' ? '未开始' : statusDef(status, 'period').label }
function snapshotName(type: string) { return ({ BALANCE: '科目余额', REPORT: '财务报表', RECONCILE: '业务核对' } as Record<string, string>)[type] ?? type }
function detailPath(check: Row, item: Row) {
  if (check.checkCode === 'EVENTS_OPEN' && item.id) return { path: '/finance/events', query: { bookId: bookId.value, eventId: item.id } }
  if (check.checkCode === 'UNPOSTED' && item.id) return { path: '/finance/vouchers', query: { bookId: bookId.value, voucherId: item.id } }
  return financeSourcePath(item)
}
function sourceName(item: Row) {
  return item.sourceNo || item.voucherNo || item.eventType || item.type || item.message || item.code ||
    (item.sourceId || item.id ? '来源 #' + (item.sourceId || item.id) : '来源资料')
}

let revision = 0, booksRequest = 0, disposed = false
function resetIntents() {
  for (const intent of [checkIntent, waiveIntent, closeIntent, reopenIntent]) intent.reset()
}
function clearChecks() {
  revision++
  checks.value = []; canClose.value = false; hasChecked.value = false
  closeGeneration.value = undefined; snapshots.value = []; impact.value = null
  operationError.value = ''; impactError.value = ''; action.value = ''
  resetIntents()
}
watch(bookId, () => { periodId.value = undefined; clearChecks() }, { flush: 'sync' })
watch(periodId, clearChecks, { flush: 'sync' })
onBeforeUnmount(() => { disposed = true; revision++; booksRequest++ })

async function loadBooks() {
  const request = ++booksRequest
  booksLoading.value = true; booksError.value = ''
  try {
    const result = await http.get<Row[]>('/fin/books', undefined, { silent: true })
    if (disposed || request !== booksRequest) return
    if (!Array.isArray(result) || result.some(book => !book || !Array.isArray(book.periods))) throw new Error('账套响应格式不完整，请重新加载')
    books.value = result
    if (bookId.value != null && !result.some(book => book.id === bookId.value)) bookId.value = undefined
    if (periodId.value != null && !selected.value) periodId.value = undefined
  } catch (error) {
    if (!disposed && request === booksRequest) booksError.value = feedbackMessage(error, '账套读取失败，请重新加载')
  } finally {
    if (!disposed && request === booksRequest) booksLoading.value = false
  }
}
onMounted(loadBooks)

function available(permission: string) {
  return !disposed && !busy.value && !booksLoading.value && !booksError.value && !!selected.value && !!bookId.value && user.hasPerm(permission)
}
async function perform(kind: Exclude<Action, ''>, work: (target: Target, current: () => boolean) => Promise<void>) {
  if (busy.value || bookId.value == null || periodId.value == null) return false
  const target = { bookId: bookId.value, periodId: periodId.value }, version = revision
  const current = () => !disposed && version === revision
  action.value = kind
  if (kind === 'preview') impactError.value = ''; else operationError.value = ''
  try { await work(target, current); return current() }
  catch (error) {
    if (current() && error !== 'cancel' && error !== 'close') {
      const labels = { check: '结账检查', waive: '差异确认', close: '结账', preview: '反结账影响读取', reopen: '反结账' }
      const message = feedbackMessage(error, labels[kind] + '失败，请核实后重试')
      if (kind === 'preview') impactError.value = message
      else { operationError.value = message; canClose.value = false }
    }
    return false
  } finally { if (current()) action.value = '' }
}
function applyPeriod(result: Row) {
  if (selected.value && (result?.period?.status || result?.status)) Object.assign(selected.value, result.period ?? { status: result.status })
}
function applyChecks(result: Row) {
  if (!result || !Array.isArray(result.checks) || result.checks.some((row: Row) => !row || typeof row.checkCode !== 'string' || typeof row.result !== 'string') || typeof result.canClose !== 'boolean') {
    throw new Error('结账检查响应格式不完整，请重新检查')
  }
  checks.value = result.checks; canClose.value = result.canClose; closeGeneration.value = result.closeGeneration
  hasChecked.value = true; applyPeriod(result)
}
async function run() {
  if (!available('fin:period:close')) return
  await perform('check', async (target, current) => {
    checks.value = []; canClose.value = false; hasChecked.value = false; closeGeneration.value = undefined; impact.value = null; impactError.value = ''
    const result = await http.postIdem<Row>(`/fin/periods/${target.periodId}/close-check`, { bookId: target.bookId }, checkIntent, { silent: true })
    if (!current()) return
    applyChecks(result)
    await loadBooks()
  })
}
async function waive(row: Row) {
  if (!available('fin:period:close') || row.result !== 'FAIL' || !row.waivable || selected.value?.status === 'CLOSED' || !checks.value.includes(row)) return
  const succeeded = await perform('waive', async (target, current) => {
    const { value } = await ElMessageBox.prompt('说明该差异为什么不影响本期核算。确认仅适用于本次检查来源指纹与结账代次。', '确认差异', {
      inputValidator: value => !value?.trim() ? '请填写原因' : value.trim().length <= 1000 || '原因不能超过1000字', inputType: 'textarea',
      confirmButtonText: '确认差异', cancelButtonText: '取消',
    })
    if (!current() || !user.hasPerm('fin:period:close')) return
    await http.postIdem(`/fin/periods/${target.periodId}/waive`, { bookId: target.bookId, checkCode: row.checkCode, reason: value.trim(), fingerprint: row.fingerprint, closeGeneration: row.closeGeneration ?? closeGeneration.value }, waiveIntent, { silent: true })
    if (current()) { canClose.value = false; ElMessage.success('差异已确认，正在重新检查') }
  })
  if (succeeded) await run()
}
async function close() {
  if (!readyToClose.value) return
  await perform('close', async (target, current) => {
    await ElMessageBox.confirm('结账将由服务端重新核对，保存余额和三张报表快照，并锁定该期间业务。', '确认结账', {
      type: 'warning', confirmButtonText: '确认结账', cancelButtonText: '取消',
    })
    if (!current() || !user.hasPerm('fin:period:close')) return
    const result = await http.postIdem<Row>(`/fin/periods/${target.periodId}/close`, { bookId: target.bookId }, closeIntent, { silent: true })
    if (!current()) return
    canClose.value = false
    applyPeriod(result)
    if (!result || !Array.isArray(result.checks) || (!demo && (!Array.isArray(result.snapshots) || result.period?.status !== 'CLOSED'))) throw new Error('结账响应格式不完整，请重新加载期间状态核实结果')
    // 原演示接口不返回快照；只在演示模式允许缺省，真实接口缺失会明确报错。
    checks.value = result.checks; snapshots.value = result.snapshots ?? []; closeGeneration.value = result.closeGeneration
    hasChecked.value = true; impact.value = null; impactError.value = ''
    ElMessage.success('已结账，该期间已锁定')
    await loadBooks()
  })
}
async function previewReopen() {
  if (!available('fin:period:reopen') || selected.value?.status !== 'CLOSED') return
  await perform('preview', async (target, current) => {
    impact.value = null
    const result = await http.get<Row>(`/fin/periods/${target.periodId}/reopen-impact`, { bookId: target.bookId }, { silent: true })
    if (!current()) return
    if (!result || typeof result.canReopen !== 'boolean' || !Array.isArray(result.dependencies) || !Array.isArray(result.closedDependencies)) throw new Error('反结账影响响应格式不完整，请重新读取')
    impact.value = result
  })
}
async function reopen() {
  if (!available('fin:period:reopen') || selected.value?.status !== 'CLOSED') return
  if (!demo && !impact.value) { await previewReopen(); return }
  if (impact.value?.canReopen === false || impact.value?.closedDependencies.length) return
  await perform('reopen', async (target, current) => {
    const { value } = await ElMessageBox.prompt('填写反结账原因。后续期间依赖将由服务端重新验证，更正后须重新检查。', '反结账', {
      inputValidator: value => !value?.trim() ? '请填写原因' : value.trim().length <= 1000 || '原因不能超过1000字', inputType: 'textarea',
      confirmButtonText: '确认反结账', cancelButtonText: '取消',
    })
    if (!current() || !user.hasPerm('fin:period:reopen')) return
    const result = await http.postIdem<Row>(`/fin/periods/${target.periodId}/reopen`, { bookId: target.bookId, reason: value.trim() }, reopenIntent, { silent: true })
    if (!current()) return
    applyPeriod(result)
    if (!result || (!demo && (!Array.isArray(result.snapshotRefs) || result.period?.status !== 'OPEN'))) throw new Error('反结账响应格式不完整，请重新加载期间状态核实结果')
    checks.value = []; canClose.value = false; hasChecked.value = false; closeGeneration.value = undefined; impact.value = null
    resetIntents()
    snapshots.value = Array.isArray(result.snapshotRefs) ? result.snapshotRefs : []
    ElMessage.success('已反结账，请重新执行检查')
    await loadBooks()
  })
}
</script>

<template>
  <div class="page closing-page">
    <section class="page-card" aria-labelledby="closing-title">
      <div class="page-title">
        <div>
          <h2 id="closing-title">结账工作台</h2>
          <p class="muted page-description">先核对本期业务与账务，再完成结账并锁定期间。</p>
        </div>
        <div class="context-meta"><span>{{ country.current?.name || '国家未提供' }}</span><span>{{ currency || '请选择账套查看币种' }}</span><span>{{ country.timezone }}</span></div>
      </div>
      <div v-if="booksError" class="request-state" role="status"><p class="muted">操作未完成，请查看全局提示。</p><p>账套或期间状态未刷新，请重新加载后再操作。已成功执行的操作无需重复提交。</p><el-button :disabled="busy" :loading="booksLoading" @click="loadBooks">重新加载账套</el-button></div>
      <el-skeleton v-if="booksLoading && !books.length" :rows="2" animated aria-label="正在读取账套与期间" />
      <el-empty v-else-if="!booksError && !books.length" description="暂无可用账套，请先在账套管理中配置" :image-size="64" />
      <template v-if="books.length">
        <el-form class="closing-filters" label-position="top" :disabled="busy || booksLoading || !!booksError">
          <el-form-item label="账套">
            <el-select v-model="bookId" filterable clearable placeholder="请选择账套">
              <el-option v-for="book in books" :key="book.id" :label="book.name + ' · ' + (book.baseCurrency || '币种未提供')" :value="book.id" />
            </el-select>
          </el-form-item>
          <el-form-item label="会计期间">
            <el-select v-model="periodId" filterable clearable :disabled="!bookId" placeholder="请选择期间">
              <el-option v-for="period in periods" :key="period.id" :label="period.name + ' · ' + periodLabel(period.status)" :value="period.id" />
            </el-select>
          </el-form-item>
          <div v-if="selected" class="period-context">
            <el-tag v-if="selected.status === 'NOT_STARTED'" type="info" size="small" disable-transitions>未开始</el-tag>
            <StatusTag v-else :status="selected.status" domain="period" />
            <span class="muted">{{ selected.startDate || '开始日期未提供' }} 至 {{ selected.endDate || '结束日期未提供' }}</span>
          </div>
        </el-form>
        <div class="toolbar closing-actions">
          <el-button v-if="user.hasPerm('fin:period:close')" type="primary" :loading="action === 'check'" :disabled="busy || booksLoading || !!booksError || !selected" @click="run">{{ hasChecked ? '重新检查' : '执行结账检查' }}</el-button>
          <el-button v-if="user.hasPerm('fin:period:close')" :loading="action === 'close'" :disabled="!readyToClose" @click="close">确认结账</el-button>
          <el-button v-if="!demo && user.hasPerm('fin:period:reopen')" :loading="action === 'preview'" :disabled="busy || booksLoading || !!booksError || selected?.status !== 'CLOSED'" @click="previewReopen">查看反结账影响</el-button>
          <el-button v-if="user.hasPerm('fin:period:reopen')" :loading="action === 'reopen'" :disabled="busy || booksLoading || !!booksError || selected?.status !== 'CLOSED' || (!demo && !impact?.canReopen)" @click="reopen">反结账</el-button>
        </div>
        <p v-if="!user.hasPerm('fin:period:close')" class="muted">当前账号无结账检查及结账权限。</p>
        <el-alert v-if="selected?.status === 'CLOSED'" title="期间已结账并锁定。重新检查不会解除锁定，报表读取结账快照。" type="success" :closable="false" show-icon />
        <p v-else-if="bookId && !periods.length" class="muted">当前账套暂无会计期间，请先在账套管理中生成期间。</p>
        <p v-else-if="selected?.status === 'NOT_STARTED'" class="muted">该期间尚未开放，不能结账。</p>
      </template>
      <div v-if="operationError" class="request-state" role="status"><p class="muted">操作未完成，请查看全局提示。</p>
        请核实当前期间与检查结果后重试；如果提交结果不确定，可先重新检查期间状态。
      </div>
    </section>

    <section class="page-card" aria-labelledby="checks-title" :aria-busy="action === 'check'">
      <div class="section-heading">
        <h3 id="checks-title">结账检查</h3>
        <span v-if="closeGeneration != null" class="muted">结账代次 {{ closeGeneration }}</span>
      </div>
      <p class="muted section-note">来源数据变化后须重新检查和确认差异。展开检查项可查看待处理来源。</p>
      <div v-if="hasChecked" class="check-summary" aria-live="polite">
        <span>检查项 <strong>{{ summary.total }}</strong></span>
        <span>已通过 <strong>{{ summary.passed }}</strong></span>
        <span class="failed-count">待处理 <strong>{{ summary.failed }}</strong></span>
        <span>已确认差异 <strong>{{ summary.waived }}</strong></span>
        <span v-if="summary.unknown">未知结果 <strong>{{ summary.unknown }}</strong></span>
      </div>
      <el-alert v-if="hasChecked && selected?.status !== 'CLOSED'" :title="readyToClose ? '检查已通过，可以确认结账。服务端将在结账时再次核对。' : '当前尚不可结账，请核实待处理项、期间状态及最新检查结果。'" :type="readyToClose ? 'success' : 'warning'" :closable="false" show-icon />
      <div v-if="action === 'check' || hasChecked" v-loading="action === 'check'" class="table-scroll checks-table">
        <el-table :data="checks" row-key="checkCode" border stripe size="small" empty-text="本次检查未返回检查项，请重新检查" style="min-width: 720px">
          <el-table-column type="expand" width="44">
            <template #default="{ row }">
              <div class="check-detail">
                <p v-if="!row.detail?.length" class="muted">{{ row.result === 'PASS' ? '此项检查通过，没有待处理来源。' : '服务端未返回来源明细，请核实检查说明及对应业务资料。' }}</p>
                <div v-else class="table-scroll">
                  <el-table :data="row.detail" border stripe size="small" style="min-width: 820px">
                    <el-table-column label="来源 / 核对类型" min-width="220">
                      <template #default="{ row: item }"><router-link v-if="detailPath(row, item)" :to="detailPath(row, item)!" class="source-link mono">{{ sourceName(item) }}</router-link><span v-else>{{ sourceName(item) }}</span></template>
                    </el-table-column>
                    <el-table-column v-for="column in [{ prop: 'businessAmount', label: '业务金额' }, { prop: 'glAmount', label: '总账金额' }, { prop: 'diffAmount', label: '差额' }]" :key="column.prop" :label="column.label" align="right" min-width="150">
                      <template #default="{ row: item }"><MoneyText v-if="currency" :value="item[column.prop]" :currency="currency" /><span v-else>币种未提供</span></template>
                    </el-table-column>
                    <el-table-column label="状态 / 说明" min-width="200"><template #default="{ row: item }">{{ item.lastError || item.message || item.consumerStatus || item.status || (item.incomplete ? '来源资料不完整' : '未提供说明') }}</template></el-table-column>
                  </el-table>
                </div>
                <p v-if="row.waiveReason" class="waiver-reason">差异确认依据：{{ row.waiveReason }}</p>
              </div>
            </template>
          </el-table-column>
          <el-table-column label="检查项" min-width="210"><template #default="{ row }"><div>{{ checkName(row.checkCode) }}</div><div class="check-code mono">{{ row.checkCode }}</div></template></el-table-column>
          <el-table-column prop="message" label="检查说明" min-width="280" />
          <el-table-column label="状态" width="100"><template #default="{ row }"><StatusTag :status="row.result" /></template></el-table-column>
          <el-table-column label="操作" width="115"><template #default="{ row }"><el-button v-if="row.result === 'FAIL' && row.waivable && user.hasPerm('fin:period:close') && selected?.status !== 'CLOSED'" :disabled="busy || booksLoading || !!booksError" :loading="action === 'waive'" type="primary" size="small" link @click="waive(row)">确认差异</el-button><span v-else class="muted">—</span></template></el-table-column>
        </el-table>
      </div>
      <el-empty v-else :description="operationError ? '检查未完成，请按上方错误提示处理后重试' : !user.hasPerm('fin:period:close') ? '当前账号没有结账检查权限' : selected ? '尚未执行检查，请点击“执行结账检查”' : '请选择账套与会计期间后执行检查'" :image-size="64" />
    </section>

    <section v-if="snapshots.length" class="page-card" aria-labelledby="snapshots-title">
      <div class="section-heading"><h3 id="snapshots-title">结账快照</h3><span class="muted">本次操作返回 {{ snapshots.length }} 份</span></div>
      <p class="muted section-note">旧代次快照保留供审计；这里只展示本次操作返回的快照引用。</p>
      <div class="table-scroll">
        <el-table :data="snapshots" border stripe size="small" style="min-width: 680px">
          <el-table-column prop="id" label="快照编号" width="120" />
          <el-table-column label="类型" width="140"><template #default="{ row }">{{ snapshotName(row.snapshotType) }}</template></el-table-column>
          <el-table-column prop="closeGeneration" label="结账代次" width="110" />
          <el-table-column label="来源指纹" min-width="300"><template #default="{ row }"><span class="fingerprint mono">{{ row.sourceFingerprint || '本次响应未提供' }}</span></template></el-table-column>
        </el-table>
      </div>
    </section>

    <section v-if="!demo && user.hasPerm('fin:period:reopen') && (selected?.status === 'CLOSED' || impactError)" class="page-card" aria-labelledby="impact-title">
      <div class="section-heading"><h3 id="impact-title">反结账影响</h3><span class="muted">先查看依赖，再填写原因</span></div>
      <div v-if="impactError" class="request-state" role="status"><p class="muted">操作未完成，请查看全局提示。</p><el-button :disabled="busy || !!booksError" @click="previewReopen">重新读取影响</el-button></div>
      <el-skeleton v-else-if="action === 'preview'" :rows="2" animated aria-label="正在读取反结账影响" />
      <template v-else-if="impact">
        <el-alert :title="impact.canReopen ? '未发现后续已结账期间；反结账时服务端仍会重新核对依赖。' : '当前不能反结账，请先处理后续已结账期间或核实期间状态。'" :type="impact.canReopen ? 'warning' : 'error'" :closable="false" show-icon />
        <p class="muted section-note">后续开放期间 {{ impact.dependencies.length }} 项，后续已结账期间 {{ impact.closedDependencies.length }} 项。反结账后旧快照保留，原差异确认失效。</p>
        <div class="table-scroll"><el-table :data="dependencyRows" border stripe size="small" empty-text="没有后续开放或已结账期间依赖" style="min-width: 580px">
          <el-table-column prop="id" label="期间编号" width="120" />
          <el-table-column prop="startDate" label="开始日期" min-width="160" />
          <el-table-column prop="endDate" label="结束日期" min-width="160" />
          <el-table-column label="状态" width="120"><template #default="{ row }"><StatusTag :status="row.status" domain="period" /></template></el-table-column>
        </el-table></div>
      </template>
      <p v-else class="muted section-note">尚未读取影响，请点击“查看反结账影响”。读取前不能确认反结账。</p>
    </section>
  </div>
</template>

<style scoped lang="scss">
.closing-page { min-width: 0; color: var(--el-text-color-primary); }
.page-description { margin: 6px 0 0; line-height: 1.6; }
.context-meta { display: flex; flex-wrap: wrap; justify-content: flex-end; gap: 8px 16px; font-size: 13px; color: var(--el-text-color-secondary); overflow-wrap: anywhere; }
.closing-filters { display: flex; flex-wrap: wrap; align-items: flex-end; gap: 12px 16px; margin-top: 16px; }
.closing-filters :deep(.el-form-item) { flex: 0 1 280px; min-width: 0; margin: 0; }
.closing-filters :deep(.el-select) { width: 100%; }
.period-context { display: flex; flex-wrap: wrap; align-items: center; gap: 8px 12px; min-height: 32px; }
.closing-actions { margin-top: 16px; }
.closing-actions :deep(.el-button + .el-button) { margin-left: 0; }
.section-heading { display: flex; justify-content: space-between; align-items: center; flex-wrap: wrap; gap: 8px 16px; }
.section-heading h3 { margin: 0; font-size: 16px; font-weight: 600; }
.section-note { margin: 8px 0 12px; line-height: 1.7; }
.check-summary { display: flex; flex-wrap: wrap; gap: 12px 24px; margin: 12px 0; padding: 12px 0; border-block: 1px solid var(--el-border-color-lighter); font-size: 13px; color: var(--el-text-color-regular); }
.check-summary strong { margin-left: 6px; font-variant-numeric: tabular-nums; }
.failed-count { color: var(--el-color-danger); }
.checks-table, .state-message { margin-top: 12px; }
.check-detail { padding: 12px 20px; }
.check-code { margin-top: 2px; font-size: 12px; color: var(--el-text-color-secondary); }
.source-link { color: var(--el-color-primary); text-decoration: none; overflow-wrap: anywhere; }
.source-link:hover { text-decoration: underline; }
.source-link:focus-visible { outline: 2px solid var(--el-color-primary); outline-offset: 3px; }
.waiver-reason { margin: 12px 0 0; color: var(--el-text-color-regular); overflow-wrap: anywhere; }
.fingerprint { overflow-wrap: anywhere; }
.closing-page :deep(.el-alert__description) { line-height: 1.7; }
.closing-page :deep(.el-alert__description p) { margin: 0 0 8px; }
.closing-page :deep(.el-table .cell) { overflow-wrap: anywhere; }
@media (max-width: 768px) {
  .closing-page .page-title { align-items: flex-start; flex-direction: column; }
  .context-meta { justify-content: flex-start; gap: 6px 12px; }
  .closing-filters { flex-direction: column; align-items: stretch; }
  .closing-filters :deep(.el-form-item) { flex: none; width: 100%; }
  .closing-actions { align-items: stretch; }
  .closing-actions :deep(.el-button) { flex: 1 1 140px; }
  .check-detail { padding: 8px; }
}
</style>
