<script setup lang="ts">
import { computed, onMounted, ref } from 'vue'
import { ElMessage, ElMessageBox } from 'element-plus'
import { http, createCommandIntent } from '@/api/http'
import StatusTag from '@/components/StatusTag.vue'
import MoneyText from '@/components/MoneyText.vue'
import { financeSourcePath } from '@/utils/finance-source'
import { useUserStore } from '@/stores/user'
import { useCountryStore } from '@/stores/country'

type Row = Record<string, any>
const user = useUserStore(), country = useCountryStore()
const books = ref<Row[]>([]), bookId = ref<number>(), periodId = ref<number>()
const checks = ref<Row[]>([]), canClose = ref(false), busy = ref(false)
const closeGeneration = ref<number>(), snapshots = ref<Row[]>([]), impact = ref<Row | null>(null)
const checkIntent = createCommandIntent(), waiveIntent = createCommandIntent(), closeIntent = createCommandIntent(), reopenIntent = createCommandIntent()
const periods = computed<Row[]>(() => books.value.find(b => b.id === bookId.value)?.periods ?? [])
const selected = computed(() => periods.value.find(p => p.id === periodId.value))
const currency = computed(() => books.value.find(b => b.id === bookId.value)?.baseCurrency)
function detailPath(check: Row, item: Row) {
  if (check.checkCode === 'EVENTS_OPEN' && item.id) return { path: '/finance/events', query: { bookId: bookId.value, eventId: item.id } }
  if (check.checkCode === 'UNPOSTED' && item.id) return { path: '/finance/vouchers', query: { bookId: bookId.value, voucherId: item.id } }
  return financeSourcePath(item)
}
const demo = import.meta.env.MODE === 'demo' && import.meta.env.VITE_USE_MOCK === 'true'
function clearChecks() {
  checks.value = []; canClose.value = false; closeGeneration.value = undefined; snapshots.value = []; impact.value = null
  for (const intent of [checkIntent, waiveIntent, closeIntent, reopenIntent]) intent.reset()
}
function changeBook() { periodId.value = undefined; clearChecks() }
async function loadBooks() { books.value = await http.get('/fin/books') }
onMounted(loadBooks)
async function run() {
  if (busy.value || !bookId.value || !periodId.value) return
  busy.value = true
  try {
    const res = await http.postIdem<Row>('/fin/periods/' + periodId.value + '/close-check', { bookId: bookId.value }, checkIntent)
    checks.value = res.checks; canClose.value = res.canClose; closeGeneration.value = res.closeGeneration
    impact.value = null
    await loadBooks()
  } finally { busy.value = false }
}
async function waive(row: Row) {
  if (busy.value || !user.hasPerm('fin:period:close')) return
  const { value } = await ElMessageBox.prompt('说明该差异为什么不影响本期核算。确认仅适用于本次检查来源指纹与结账代次。', '确认差异', { inputValidator: value => !!value?.trim() || '请填写原因' })
  busy.value = true
  try {
    await http.postIdem('/fin/periods/' + periodId.value + '/waive', { bookId: bookId.value, checkCode: row.checkCode, reason: value.trim(), fingerprint: row.fingerprint, closeGeneration: row.closeGeneration ?? closeGeneration.value }, waiveIntent)
  } finally { busy.value = false }
  await run()
}
async function close() {
  if (busy.value || !canClose.value || !user.hasPerm('fin:period:close')) return
  await ElMessageBox.confirm('结账将由服务端重新核对，保存余额和三张报表快照，并锁定该期间业务。', '确认结账')
  busy.value = true
  try {
    const res = await http.postIdem<Row>('/fin/periods/' + periodId.value + '/close', { bookId: bookId.value }, closeIntent)
    checks.value = res.checks; snapshots.value = res.snapshots ?? []; closeGeneration.value = res.closeGeneration; canClose.value = false
    await loadBooks()
    ElMessage.success('已结账，该期间已锁定')
  } finally { busy.value = false }
}
async function previewReopen() {
  if (busy.value || !periodId.value || !user.hasPerm('fin:period:reopen')) return
  busy.value = true
  try { impact.value = await http.get('/fin/periods/' + periodId.value + '/reopen-impact', { bookId: bookId.value }) }
  finally { busy.value = false }
}
async function reopen() {
  if (busy.value || !user.hasPerm('fin:period:reopen')) return
  if (!demo && !impact.value) { await previewReopen(); return }
  if (impact.value?.canReopen === false) return
  const { value } = await ElMessageBox.prompt('填写反结账原因。已展示的后续期间依赖将由服务端重新验证，更正后须重新检查。', '反结账', { inputValidator: value => !!value?.trim() || '请填写原因' })
  busy.value = true
  try {
    const res = await http.postIdem<Row>('/fin/periods/' + periodId.value + '/reopen', { bookId: bookId.value, reason: value.trim() }, reopenIntent)
    clearChecks(); impact.value = { ...res, canReopen: false }
    await loadBooks()
    ElMessage.success('已反结账，请重新执行检查')
  } finally { busy.value = false }
}
</script>

<template>
  <el-card>
    <template #header>结账 · {{ country.current?.name }} · {{ currency || country.currency }} · {{ country.timezone }}</template>
    <el-form inline :disabled="busy">
      <el-form-item label="账套"><el-select v-model="bookId" placeholder="请选择账套" style="width:260px;max-width:100%" @change="changeBook"><el-option v-for="b in books" :key="b.id" :label="b.name + ' · ' + b.baseCurrency" :value="b.id" /></el-select></el-form-item>
      <el-form-item label="期间"><el-select v-model="periodId" placeholder="请选择期间" style="width: 250px" @change="clearChecks"><el-option v-for="p in periods" :key="p.id" :label="p.name + ' · ' + p.status" :value="p.id" /></el-select></el-form-item>
      <el-button v-if="user.hasPerm('fin:period:close')" type="primary" :loading="busy" :disabled="!periodId" @click="run">检查 / 重试</el-button>
      <el-button v-if="user.hasPerm('fin:period:close')" :disabled="busy || !canClose || selected?.status === 'CLOSED'" @click="close">结账</el-button>
      <el-button v-if="!demo && user.hasPerm('fin:period:reopen')" :disabled="busy || selected?.status !== 'CLOSED'" @click="previewReopen">查看反结账影响</el-button>
      <el-button v-if="user.hasPerm('fin:period:reopen')" :disabled="busy || selected?.status !== 'CLOSED' || (!demo && !impact?.canReopen)" @click="reopen">反结账</el-button>
    </el-form>
    <el-alert v-if="selected?.status === 'CLOSED'" title="期间已结账并锁定。重新检查不会解除锁定，报表读取结账快照。" type="success" :closable="false" />
    <p v-if="closeGeneration != null" class="muted">检查所属结账代次 {{ closeGeneration }}；来源数据变化后须重新检查和确认差异。</p>
    <el-table :data="checks" size="small">
      <el-table-column type="expand"><template #default="{ row }"><div style="padding: 8px 30px"><p v-if="!row.detail?.length" class="muted">此项检查通过，没有待处理来源。</p><el-table v-else :data="row.detail" size="small"><el-table-column label="来源 / 核对类型" min-width="200"><template #default="{ row: item }"><router-link v-if="detailPath(row, item)" :to="detailPath(row, item)!">{{ item.sourceNo || item.voucherNo || item.eventType || item.type || item.message || item.code || ('来源 #' + (item.sourceId || item.id)) }}</router-link><span v-else>{{ item.sourceNo || item.voucherNo || item.eventType || item.type || item.message || item.code || '来源资料' }}</span></template></el-table-column><el-table-column label="业务金额"><template #default="{ row: item }"><MoneyText :value="item.businessAmount" :currency="currency" /></template></el-table-column><el-table-column label="总账金额"><template #default="{ row: item }"><MoneyText :value="item.glAmount" :currency="currency" /></template></el-table-column><el-table-column label="差额"><template #default="{ row: item }"><MoneyText :value="item.diffAmount" :currency="currency" /></template></el-table-column><el-table-column label="状态 / 说明"><template #default="{ row: item }">{{ item.lastError || item.message || item.consumerStatus || item.status || (item.incomplete ? '来源资料不完整' : '') }}</template></el-table-column></el-table><p v-if="row.waiveReason">差异确认依据：{{ row.waiveReason }}</p></div></template></el-table-column>
      <el-table-column prop="checkCode" label="检查项" width="175" /><el-table-column prop="message" label="结果" />
      <el-table-column label="状态" width="100"><template #default="{ row }"><StatusTag :status="row.result" /></template></el-table-column>
      <el-table-column width="100"><template #default="{ row }"><el-button v-if="row.result === 'FAIL' && row.waivable && user.hasPerm('fin:period:close') && selected?.status !== 'CLOSED'" :disabled="busy" link @click="waive(row)">确认差异</el-button></template></el-table-column>
    </el-table>
    <section v-if="snapshots.length"><h4>已保存快照</h4><el-table :data="snapshots" size="small"><el-table-column prop="id" label="快照 ID" /><el-table-column prop="snapshotType" label="类型" /><el-table-column prop="closeGeneration" label="结账代次" /><el-table-column prop="sourceFingerprint" label="来源指纹" /></el-table></section>
    <section v-if="impact"><h4>反结账影响</h4><el-alert v-if="impact.canReopen === false && impact.closedDependencies?.length" title="存在后续已结账期间，不能反结账。" type="error" :closable="false" /><p class="muted">后续开放期间依赖 {{ impact.dependencies?.length ?? 0 }} 项；后续已结账期间 {{ impact.closedDependencies?.length ?? 0 }} 项。反结账后的旧快照保留供审计，差异确认失效。</p><el-table :data="[...(impact.dependencies ?? []), ...(impact.closedDependencies ?? [])]" size="small"><el-table-column prop="id" label="期间 ID" /><el-table-column prop="startDate" label="开始日期" /><el-table-column prop="status" label="状态" /></el-table></section>
  </el-card>
</template>
