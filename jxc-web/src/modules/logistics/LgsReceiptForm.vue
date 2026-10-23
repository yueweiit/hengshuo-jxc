<script setup lang="ts">
import { computed, nextTick, onBeforeUnmount, onMounted, ref, watch } from 'vue'
import { useRoute, useRouter } from 'vue-router'
import { ElMessage, ElMessageBox } from 'element-plus'
import { BizError, http, createCommandIntent } from '@/api/http'
import { getCountryId, getToken } from '@/utils/session'
import { useUserStore } from '@/stores/user'
import { useCountryStore } from '@/stores/country'
import StatusTag from '@/components/StatusTag.vue'
import DateTimeText from '@/components/DateTimeText.vue'
import QtyText from '@/components/QtyText.vue'
import ProductCell from '@/components/biz/ProductCell.vue'
import ScanInput from '@/components/biz/ScanInput.vue'
import DocAttachment from '@/components/DocAttachment.vue'
import AuditTimeline from '@/components/AuditTimeline.vue'
import AuditDrawerRecords from '@/components/AuditDrawerRecords.vue'
import { receiptAudit } from './receiptAudit'
import { matchBarcode } from '@/utils/action'

type Row = Record<string, any> // eslint-disable-line @typescript-eslint/no-explicit-any

const route = useRoute()
const router = useRouter()
const user = useUserStore()
const country = useCountryStore()
const r = ref<Row>({})
const loading = ref(false)
const loadError = ref('')
const saving = ref(false)
const confirming = ref(false)
const audit = ref<InstanceType<typeof AuditTimeline>>()
const auditVisible = ref(false)
const lineQuery = ref('')
const lineFilter = ref('all')
const linePage = ref(1)
const linePageSize = ref(20)
const active = ref<number | null>(null)
const checked = ref<Set<number>>(new Set())
const scan = ref<InstanceType<typeof ScanInput>>()
/** 相同内容的失败重试复用幂等键；改变数量或成功后开始新意图 */
const idemKey = createCommandIntent()

const id = computed(() => Number(route.params.id))
const receiptScope = () => JSON.stringify([id.value, getCountryId(), getToken()])
let loadRequest = 0
const lines = computed<Row[]>(() => r.value.lines ?? [])
const editable = computed(() => !loading.value && !loadError.value && !saving.value && !confirming.value && r.value.status === 'DRAFT' && user.hasPerm('lgs:receipt:confirm'))
const timezone = computed(() => r.value.warehouseTimezone || country.timezone)
const quantityFields = ['goodQty', 'damagedQty', 'pendingInspectQty', 'shortQty'] as const
const roundQty = (value: number) => Math.round(value * 10000) / 10000
const validQty = (value: unknown): value is number => typeof value === 'number' && Number.isFinite(value) && value >= 0 && Math.abs(value * 10000 - Math.round(value * 10000)) < 0.000001
const lineSum = (l: Row) => roundQty(quantityFields.reduce((sum, key) => sum + (l[key] ?? 0), 0))
const balanced = (l: Row) => validQty(l.dispatchQty) && quantityFields.every(key => validQty(l[key])) && lineSum(l) === l.dispatchQty
const exceptional = (l: Row) => !balanced(l) || l.damagedQty > 0 || l.pendingInspectQty > 0 || l.shortQty > 0
const allBalanced = computed(() => lines.value.length > 0 && lines.value.every(balanced))
function summarize(rows: Row[]) {
  const sum = (key: string) => roundQty(rows.reduce((total, row) => total + (row[key] ?? 0), 0))
  return { count: rows.length, skus: new Set(rows.map(row => row.productId)).size, dispatch: sum('dispatchQty'), good: sum('goodQty'), damaged: sum('damagedQty'), pending: sum('pendingInspectQty'), frozen: roundQty(sum('damagedQty') + sum('pendingInspectQty')), short: sum('shortQty') }
}
const totals = computed(() => summarize(lines.value))
const filteredLines = computed(() => {
  const query = lineQuery.value.trim().toLowerCase()
  return lines.value.filter(line => (lineFilter.value !== 'exception' || exceptional(line)) && (!query || [line.productCode, line.productName, line.spec, line.barcodeText, line.batchNo].some(value => typeof value === 'string' && value.toLowerCase().includes(query))))
})
const filteredTotals = computed(() => summarize(filteredLines.value))
const pagedLines = computed(() => filteredLines.value.slice((linePage.value - 1) * linePageSize.value, linePage.value * linePageSize.value))
const remainingChecks = computed(() => lines.value.filter(line => !checked.value.has(line.id)).length)
watch([lineQuery, lineFilter, linePageSize], () => { linePage.value = 1 })
watch(() => filteredLines.value.length, count => { linePage.value = Math.min(linePage.value, Math.max(1, Math.ceil(count / linePageSize.value))) })

async function load() {
  const request = ++loadRequest, scope = receiptScope(), receiptId = id.value
  loading.value = true
  loadError.value = ''
  try {
    const result = await http.get<Row>(`/lgs/receipts/${receiptId}`)
    if (request !== loadRequest || scope !== receiptScope()) return false
    if (!result || result.id !== receiptId || !Array.isArray(result.lines)) throw new Error('实收单返回格式不正确，请重试')
    r.value = result
    return true
  } catch (error) {
    if (request === loadRequest && scope === receiptScope()) loadError.value = error instanceof Error ? error.message : '实收单读取失败，请重试'
    return false
  } finally {
    if (request === loadRequest) {
      loading.value = false
      if (!loadError.value) void nextTick(() => scan.value?.focus())
    }
  }
}

async function onScan(code: string) {
  if (!editable.value) return
  const scope = receiptScope()
  const matches = lines.value.filter(x => matchBarcode(x, code))
  const l = matches.find(x => !checked.value.has(x.id)) ?? matches[0]
  if (!l) return ElMessage.error(`${code} 不在这张派送单上，请单独登记为异常`)
  lineQuery.value = ''
  lineFilter.value = 'all'
  await nextTick()
  if (scope !== receiptScope()) return
  linePage.value = Math.floor(lines.value.indexOf(l) / linePageSize.value) + 1
  active.value = l.id
  checked.value.add(l.id)
  await nextTick()
  if (scope !== receiptScope()) return
  document.getElementById(`line-${l.id}`)?.scrollIntoView({ behavior: 'smooth', block: 'center' })
}

/** 改了破损、待检、短缺后，合格数自动补齐差额，减少手工计算 */
function autoGood(l: Row) {
  l.goodQty = roundQty(Math.max(0, l.dispatchQty - (l.damagedQty ?? 0) - (l.pendingInspectQty ?? 0) - (l.shortQty ?? 0)))
}

const payload = () => ({
  version: r.value.version,
  bizDate: r.value.bizDate,
  lines: lines.value.map((l) => ({ id: l.id, goodQty: l.goodQty, damagedQty: l.damagedQty, pendingInspectQty: l.pendingInspectQty, shortQty: l.shortQty })),
})

async function saveDraft() {
  if (!editable.value) return
  if (lines.value.some(line => quantityFields.some(key => !validQty(line[key])))) return ElMessage.error('数量必须为非负数，最多四位小数')
  const scope = receiptScope(), receiptId = id.value
  saving.value = true
  try {
    await http.put<Row>(`/lgs/receipts/${receiptId}`, payload())
    if (scope !== receiptScope()) throw new BizError('CONTEXT_CHANGED', '国家、登录状态或实收单已切换，请重新打开')
    if (await load()) ElMessage.success('已暂存')
    else ElMessage.warning('数量已暂存，详情读取失败，请重试读取')
    audit.value?.reload()
  } finally {
    saving.value = false
  }
}

async function confirm() {
  if (!editable.value) return
  if (!allBalanced.value) return ElMessage.error('每行的合格 + 破损 + 待检 + 短缺必须等于派送数量')
  const scope = receiptScope(), receiptId = id.value, body = payload()
  const unchecked = lines.value.filter((l) => !checked.value.has(l.id)).length
  const msg = [
    `合格数量 ${totals.value.good} 入可用库存`,
    totals.value.frozen ? `破损/待检数量 ${totals.value.frozen} 入冻结库存` : '',
    totals.value.short ? `短缺数量 ${totals.value.short} 将生成到货差异` : '',
    unchecked ? `还有 ${unchecked} 行未扫码核对` : '',
  ].filter(Boolean).join('；')
  confirming.value = true
  try {
    await ElMessageBox.confirm(`${msg}。确认后不能修改。`, '确认实收', { type: unchecked ? 'warning' : 'info' })
  } catch {
    return
  } finally {
    confirming.value = false
  }
  saving.value = true
  try {
    if (scope !== receiptScope()) throw new BizError('CONTEXT_CHANGED', '国家、登录状态或实收单已切换，请重新打开')
    const res = await http.postIdem<Row>(`/lgs/receipts/${receiptId}/confirm`, body, idemKey)
    if (scope !== receiptScope()) throw new BizError('CONTEXT_CHANGED', '国家、登录状态或实收单已切换，请重新打开')
    if (await load()) ElMessage.success(res.duplicate ? '这张实收单已确认过，没有重复入库' : '实收已确认，库存已增加')
    else ElMessage.warning('确认已成功，详情读取失败，请重试读取')
    audit.value?.reload()
  } finally {
    saving.value = false
  }
}

watch(id, () => {
  r.value = {}; checked.value = new Set(); active.value = null
  lineQuery.value = ''; lineFilter.value = 'all'; linePage.value = 1; auditVisible.value = false
  void load()
})
onBeforeUnmount(() => { loadRequest++ })
onMounted(load)
</script>

<template>
  <div v-loading="loading" class="page receipt" :aria-busy="loading">
    <header class="receipt-heading">
      <div class="receipt-identity">
        <el-tooltip content="返回实收验收"><el-button text circle aria-label="返回实收验收" @click="router.push('/logistics/receipts')"><el-icon><ArrowLeft /></el-icon></el-button></el-tooltip>
        <h2>实收验收 <span class="mono">{{ r.docNo || `#${id}` }}</span></h2>
        <StatusTag v-if="r.status" :status="r.status" />
      </div>
      <el-tooltip content="重新读取"><el-button text circle aria-label="重新读取" :disabled="loading || saving" @click="load"><el-icon><Refresh /></el-icon></el-button></el-tooltip>
    </header>
    <div v-if="loadError" class="receipt-read-error" role="alert"><span>实收单读取失败：{{ loadError }}</span><el-button type="primary" link @click="load">重试读取</el-button></div>
    <template v-else-if="r.id">
      <section class="receipt-info" aria-label="基础资料">
        <dl>
          <div><dt>派送单</dt><dd class="mono">{{ r.deliveryNo || '未记录' }}</dd></div>
          <div><dt>运输批次</dt><dd class="mono">{{ r.shipmentNo || '未记录' }}</dd></div>
          <div><dt>收货仓库</dt><dd>{{ r.warehouseName || '未记录' }}</dd></div>
          <div><dt>业务日期</dt><dd>{{ r.bizDate || '未记录' }}</dd></div>
          <div><dt>柜号</dt><dd class="mono">{{ r.containerNo || '未记录' }}</dd></div>
          <div><dt>车辆 / 司机</dt><dd>{{ [r.vehicle, r.driver].filter(Boolean).join(' / ') || '未记录' }}</dd></div>
          <div><dt>确认人</dt><dd>{{ r.status === 'CONFIRMED' ? (r.receivedByName || '历史确认人未记录') : '待确认' }}</dd></div>
          <div><dt>确认时间</dt><dd><DateTimeText v-if="r.confirmedAt" :value="r.confirmedAt" :tz="timezone" /><span v-else>{{ r.status === 'CONFIRMED' ? '历史确认时刻未记录' : '待确认' }}</span></dd></div>
        </dl>
      </section>
      <section class="receipt-summary" aria-label="整单数量">
        <div><span>明细 / SKU</span><b>{{ totals.count }} <small>行 /</small> {{ totals.skus }} <small>种</small></b></div>
        <div><span>派送</span><b><QtyText :value="totals.dispatch" /></b></div>
        <div class="good"><span>合格</span><b><QtyText :value="totals.good" /></b></div>
        <div :class="{ warning: totals.damaged > 0 }"><span>破损</span><b><QtyText :value="totals.damaged" /></b></div>
        <div :class="{ warning: totals.pending > 0 }"><span>待检</span><b><QtyText :value="totals.pending" /></b></div>
        <div :class="{ danger: totals.short > 0 }"><span>短缺</span><b><QtyText :value="totals.short" /></b></div>
      </section>
      <section class="receipt-lines" aria-labelledby="receipt-lines-title">
        <div class="receipt-section-heading"><h3 id="receipt-lines-title">验收明细 <span>{{ lines.length }} 行</span></h3><span v-if="r.status === 'DRAFT'" class="receipt-muted">已扫码 {{ lines.length - remainingChecks }} / {{ lines.length }} 行</span><span v-else class="receipt-muted">已确认 · 只读</span></div>
        <div class="receipt-toolbar">
          <el-input v-model="lineQuery" aria-label="搜索商品、规格、条码或批次" placeholder="商品 / 规格 / 条码 / 批次" clearable :prefix-icon="'Search'" size="small" class="receipt-search" />
          <el-radio-group v-model="lineFilter" size="small" aria-label="明细范围"><el-radio-button value="all">全部</el-radio-button><el-radio-button value="exception">仅异常</el-radio-button></el-radio-group>
          <ScanInput v-if="r.status === 'DRAFT' && user.hasPerm('lgs:receipt:confirm')" ref="scan" class="receipt-scan" :disabled="!editable" @scan="onScan" />
        </div>
        <div class="receipt-table-scroll" tabindex="0" aria-label="验收明细表">
          <table class="receipt-table" :class="{ 'is-editing': r.status === 'DRAFT' && user.hasPerm('lgs:receipt:confirm') }">
            <colgroup><col class="receipt-index-col"><col class="receipt-product-col"><col class="receipt-unit-col"><col v-for="n in 5" :key="n" class="receipt-qty-col"><col class="receipt-balance-col"><col class="receipt-batch-col"></colgroup>
            <thead><tr><th scope="col">序号</th><th scope="col">商品 / 规格</th><th scope="col">单位</th><th scope="col" class="numeric">派送</th><th scope="col" class="numeric">合格</th><th scope="col" class="numeric">破损</th><th scope="col" class="numeric">待检</th><th scope="col" class="numeric">短缺</th><th scope="col">数量核对</th><th scope="col">入库批次</th></tr></thead>
            <tbody>
              <tr v-for="(l, index) in pagedLines" :id="`line-${l.id}`" :key="l.id" :class="{ active: active === l.id, unbalanced: !balanced(l) }">
                <td class="receipt-row-index">{{ (linePage - 1) * linePageSize + index + 1 }}<el-icon v-if="checked.has(l.id)" class="good" title="已扫码" aria-label="已扫码"><CircleCheck /></el-icon></td>
                <td><ProductCell :code="l.productCode" :name="l.productName" :extra="l.spec" /><div v-if="l.remark" class="receipt-muted">{{ l.remark }}</div></td>
                <td>{{ l.baseUnit || '未记录' }}</td>
                <td class="numeric"><QtyText :value="l.dispatchQty" /></td>
                <td v-for="(field, column) in quantityFields" :key="field" class="numeric" :class="{ good: field === 'goodQty', warning: (field === 'damagedQty' || field === 'pendingInspectQty') && l[field] > 0, danger: field === 'shortQty' && l[field] > 0 }">
                  <el-input-number v-if="r.status === 'DRAFT' && user.hasPerm('lgs:receipt:confirm')" v-model="l[field]" :aria-label="`${l.productCode} 第${(linePage - 1) * linePageSize + index + 1}行${['合格','破损','待检','短缺'][column]}`" :min="0" :max="l.dispatchQty" :precision="4" :controls="false" :disabled="!editable" size="small" @change="field !== 'goodQty' && autoGood(l)" />
                  <QtyText v-else :value="l[field]" />
                </td>
                <td><span v-if="balanced(l)" class="receipt-balance good"><el-icon><CircleCheck /></el-icon>一致</span><span v-else class="danger">差额 <QtyText :value="roundQty(l.dispatchQty - lineSum(l))" /></span></td>
                <td class="mono receipt-batch">{{ l.batchNo || (r.status === 'DRAFT' ? '确认后生成' : '未生成') }}</td>
              </tr>
              <tr v-if="!pagedLines.length"><td colspan="10" class="receipt-empty">{{ lines.length ? '没有符合条件的明细' : '暂无验收明细' }}</td></tr>
            </tbody>
            <tfoot v-if="filteredLines.length"><tr><th colspan="3" scope="row">筛选合计 · {{ filteredLines.length }} 行</th><td class="numeric"><QtyText :value="filteredTotals.dispatch" /></td><td class="numeric good"><QtyText :value="filteredTotals.good" /></td><td class="numeric"><QtyText :value="filteredTotals.damaged" /></td><td class="numeric"><QtyText :value="filteredTotals.pending" /></td><td class="numeric"><QtyText :value="filteredTotals.short" /></td><td colspan="2"></td></tr></tfoot>
          </table>
        </div>
        <div class="receipt-pagination"><span class="receipt-muted">共 {{ filteredLines.length }} 行<span v-if="filteredLines.length !== lines.length"> / 整单 {{ lines.length }} 行</span></span><el-pagination v-model:current-page="linePage" v-model:page-size="linePageSize" :page-sizes="[20, 50, 100]" :total="filteredLines.length" :pager-count="5" layout="sizes, prev, pager, next" small background /></div>
      </section>
      <div class="receipt-support">
        <section class="receipt-evidence" aria-labelledby="receipt-evidence-title">
          <div class="receipt-section-heading"><h3 id="receipt-evidence-title">凭证与备注</h3></div>
          <div class="receipt-remark"><span class="receipt-muted">备注</span><span>{{ r.remark || '无' }}</span></div>
          <DocAttachment :key="r.id" biz-type="LGS_RECEIPT" :biz-id="r.id" category="RECEIPT_PHOTO" :readonly="!editable" @change="audit?.reload()" />
        </section>
        <section class="receipt-audit" aria-label="操作记录">
          <AuditTimeline :key="r.id" ref="audit" resource-type="LGS_RECEIPT" :resource-id="r.id">
            <template #layout="state">
              <div class="receipt-section-heading"><h3>操作记录 <span v-if="!state.loading && !state.loadError">{{ state.total }} 条</span></h3><div class="receipt-audit-tools"><el-tooltip content="刷新日志"><el-button text circle size="small" aria-label="刷新日志" :disabled="state.loading" @click="state.reload"><el-icon><Refresh /></el-icon></el-button></el-tooltip><el-button link type="primary" @click="auditVisible = true">全部记录<el-icon><ArrowRight /></el-icon></el-button></div></div>
              <p v-if="state.loading" class="receipt-muted" role="status">正在读取操作记录…</p>
              <div v-else-if="state.loadError" class="receipt-log-error" role="alert">{{ state.loadError }}<el-button link type="primary" @click="state.reload">重试</el-button></div>
              <p v-else-if="!state.logs.length" class="receipt-muted">暂无操作记录</p>
              <ol v-else class="receipt-log-list"><li v-for="log in state.logs.slice(0, 3)" :key="log.id"><span class="receipt-log-dot"></span><div><b>{{ receiptAudit(log).title }}</b><span class="receipt-muted">{{ log.userName || '操作人未记录' }}</span></div><DateTimeText :value="log.occurredAt" :tz="timezone" /></li></ol>
              <el-drawer v-model="auditVisible" title="操作日志" size="min(640px, 100vw)" append-to-body destroy-on-close class="receipt-audit-drawer">
                <div class="receipt-audit-context"><span>实收验收</span><b class="mono">{{ r.docNo }}</b><StatusTag :status="r.status" /></div>
                <AuditDrawerRecords :logs="state.logs" :loading="state.loading" :load-error="state.loadError" :total="state.total" :timezone="timezone" :presentation="receiptAudit" @reload="state.reload" />
              </el-drawer>
            </template>
          </AuditTimeline>
        </section>
      </div>
      <footer class="receipt-actions">
        <template v-if="r.status === 'DRAFT' && user.hasPerm('lgs:receipt:confirm')"><span :class="allBalanced ? 'receipt-muted' : 'danger'">{{ allBalanced ? `待确认 · ${remainingChecks} 行未扫码核对` : '数量未平衡，请核对整单明细' }}</span><div><el-button :disabled="!editable" :loading="saving" @click="saveDraft"><el-icon><DocumentChecked /></el-icon>暂存</el-button><el-button type="primary" :disabled="!editable || !allBalanced" :loading="saving" @click="confirm"><el-icon><Check /></el-icon>确认实收</el-button></div></template>
        <template v-else-if="r.status === 'CONFIRMED'"><span class="receipt-result"><el-icon class="good"><CircleCheckFilled /></el-icon>已入库<span class="receipt-muted">{{ totals.short ? '短缺已生成到货差异' : totals.frozen ? '破损 / 待检已入冻结库存' : '数量与派送一致' }}</span></span><div><el-button v-if="user.hasPerm('inv:stock:view')" @click="router.push('/inventory/stocks')">查看库存</el-button><el-button v-if="totals.short && user.hasPerm('lgs:discrepancy:handle')" type="primary" @click="router.push({ path: '/logistics/discrepancies', query: { status: 'OPEN' } })">处理差异</el-button><el-button type="primary" plain @click="router.push('/logistics/receipts')">继续收下一单</el-button></div></template>
        <span v-else class="receipt-muted">当前单据只读</span>
      </footer>
    </template>
  </div>
</template>
<style scoped src="./receipt-density.scss" lang="scss"></style>
