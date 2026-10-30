<script setup lang="ts">
import { feedbackMessage } from '@/api/error-feedback'
import { computed, onBeforeUnmount, onMounted, reactive, watch } from 'vue'
import { useRoute, useRouter } from 'vue-router'
import { http } from '@/api/http'
import MoneyText from '@/components/MoneyText.vue'
import DateTimeText from '@/components/DateTimeText.vue'
import { statusDef } from '@/utils/status'

type Amount = number | string | null
interface CustomerBalance {
  customerName?: string | null
  currency?: string | null
  openAr?: Amount
  prepaid?: Amount
  refundable?: Amount
  used?: Amount
  limit?: Amount
  available?: Amount
}
interface LedgerEvent {
  id?: number | string
  type?: string | null
  no?: string | null
  docNo?: string | null
  at?: string | null
  bizDate?: string | null
  currency?: string | null
  amount?: Amount
  status?: string | null
}
interface ReadState<T> {
  data: T | null
  loading: boolean
  error: string
  requestId: number
}

const route = useRoute()
const router = useRouter()
const id = computed(() => Number(route.params.id))
const balance = reactive<ReadState<CustomerBalance>>({ data: null, loading: false, error: '', requestId: 0 })
const records = reactive<ReadState<LedgerEvent[]>>({ data: null, loading: false, error: '', requestId: 0 })
const currency = computed(() => balance.data?.currency?.trim() || '')
const customerName = computed(() => balance.data?.customerName?.trim()
  || (Number.isSafeInteger(id.value) && id.value > 0 ? `客户 #${id.value}` : '客户详情'))
const metrics = [
  { key: 'openAr', label: '未结应收', help: '尚未核销的应收金额' },
  { key: 'prepaid', label: '预收余额', help: '已确认、尚未核销的收款等余额' },
  { key: 'refundable', label: '可退款余额', help: '当前标记为可退的余额' },
] as const
const creditFields = [{ key: 'used', label: '已用' }, { key: 'limit', label: '额度' }, { key: 'available', label: '可用' }] as const
let active = true

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value)
}
function hasTextFields(value: Record<string, unknown>, keys: string[]) {
  return keys.every(key => value[key] == null || typeof value[key] === 'string')
}
function isAmount(value: unknown) {
  return value == null || value === ''
    || (typeof value === 'number' && Number.isFinite(value))
    || (typeof value === 'string' && value.trim() !== '' && Number.isFinite(Number(value)))
}
function parseBalance(value: unknown): CustomerBalance {
  if (!isRecord(value) || !hasTextFields(value, ['customerName', 'currency'])
    || ![...metrics, ...creditFields].every(({ key }) => isAmount(value[key]))) {
    throw new Error('客户余额返回格式不正确，请重试')
  }
  return value as CustomerBalance
}
function parseRecords(value: unknown): LedgerEvent[] {
  if (!Array.isArray(value) || !value.every(row => isRecord(row)
    && hasTextFields(row, ['type', 'no', 'docNo', 'at', 'bizDate', 'currency', 'status']) && isAmount(row.amount))) {
    throw new Error('往来记录返回格式不正确，请重试')
  }
  return value as LedgerEvent[]
}

// 两个区域共享读取规则，但保留各自的失败、重试和请求顺序。
async function readSection<T>(state: ReadState<T>, view: string, parse: (value: unknown) => T) {
  const customerId = id.value
  const requestId = ++state.requestId
  const current = () => active && requestId === state.requestId && customerId === id.value
  state.data = null
  state.error = ''
  state.loading = true
  try {
    if (!Number.isSafeInteger(customerId) || customerId <= 0) throw new Error('客户编号无效，请返回应收列表重新进入')
    const result = await http.get<unknown>(`/ar/customers/${customerId}/${view}`, undefined, { silent: true })
    if (current()) state.data = parse(result)
  } catch (error) {
    if (active && requestId === state.requestId) {
      state.error = feedbackMessage(error, '客户往来读取失败，请重试')
    }
  } finally {
    if (active && requestId === state.requestId) state.loading = false
  }
}
async function load(section: 'all' | 'balance' | 'records' = 'all') {
  const requests: Promise<void>[] = []
  if (section !== 'records') requests.push(readSection(balance, 'balances', parseBalance))
  if (section !== 'balance') requests.push(readSection(records, 'timeline', parseRecords))
  await Promise.all(requests)
}
function eventCurrency(event: LedgerEvent) {
  return event.currency?.trim() || currency.value
}
function eventStatus(event: LedgerEvent) {
  return event.type === '贷项' && event.status === 'ACTIVE'
    ? { label: '已生效', type: 'success' as const }
    : statusDef(event.status)
}

watch(id, () => { void load() }, { flush: 'sync' })
onMounted(() => { void load() })
onBeforeUnmount(() => { active = false })
</script>

<template>
  <div class="customer-ledger">
    <header class="page-title ledger-header">
      <div class="customer-identity">
        <div class="ledger-title-row">
          <h2>客户往来</h2>
          <span id="customer-name" class="customer-name">{{ customerName }}</span>
        </div>
        <p class="customer-context muted">
          <span>客户编号 <span class="mono">{{ Number.isSafeInteger(id) && id > 0 ? id : '-' }}</span></span>
          <span>查询币种 <span class="ledger-currency">{{ currency || '未提供' }}</span></span>
        </p>
      </div>
      <div class="ledger-actions">
        <el-button @click="router.push('/ar/receivables')">返回应收</el-button>
        <el-button :loading="balance.loading || records.loading" @click="load()">刷新</el-button>
      </div>
    </header>

    <section class="page-card ledger-overview" aria-label="客户余额" :aria-busy="balance.loading">
      <div v-if="balance.loading" class="ledger-loading" role="status">
        <el-skeleton :rows="2" animated />
        <p class="muted">正在读取客户余额…</p>
      </div>
      <div v-else-if="balance.error" class="request-state" role="status"><p class="muted">操作未完成，请查看全局提示。</p><p class="ledger-error">操作未完成，请查看全局提示。</p><el-button size="small" :loading="balance.loading" @click="load('balance')">重新读取余额</el-button></div>
      <template v-else-if="balance.data">
        <p v-if="!currency" class="muted">币种未提供，余额金额暂不展示。</p>
        <dl class="balance-grid">
          <div v-for="metric in metrics" :key="metric.key" class="balance-item">
            <dt class="balance-label">
              <span>{{ metric.label }}</span>
              <details class="balance-help">
                <summary :aria-label="`${metric.label}说明`">说明</summary>
                <p>{{ metric.help }}</p>
              </details>
            </dt>
            <dd class="balance-value">
              <MoneyText v-if="currency" :value="balance.data[metric.key]" :currency="currency" />
              <span v-else class="mono">-</span>
            </dd>
          </div>
        </dl>
        <div class="credit-strip">
          <span class="credit-title">授信额度</span>
          <dl class="credit-fields">
            <div v-for="field in creditFields" :key="field.key" class="credit-field">
              <dt>{{ field.label }}</dt>
              <dd>
                <MoneyText v-if="currency" :value="balance.data[field.key]" :currency="currency" />
                <span v-else class="mono">-</span>
              </dd>
            </div>
          </dl>
        </div>
      </template>
    </section>

    <section class="page-card ledger-records" aria-labelledby="ledger-records-title" :aria-busy="records.loading">
      <header class="records-header">
        <div>
          <h3 id="ledger-records-title">往来记录</h3>
          <p class="muted">按发生时间从近到远</p>
        </div>
        <span v-if="records.data && !records.loading && !records.error" class="muted">本次读取 {{ records.data.length }} 条</span>
      </header>

      <div v-if="records.loading" class="ledger-loading" role="status">
        <el-skeleton :rows="3" animated />
        <p class="muted">正在读取往来记录…</p>
      </div>
      <div v-else-if="records.error" class="request-state" role="status"><p class="muted">操作未完成，请查看全局提示。</p><p class="ledger-error">操作未完成，请查看全局提示。</p><el-button size="small" :loading="records.loading" @click="load('records')">重新读取记录</el-button></div>
      <el-empty v-else-if="records.data?.length === 0" description="暂无往来记录" :image-size="64" />
      <table v-else-if="records.data" class="ledger-table" role="table" aria-labelledby="ledger-records-title">
        <thead role="rowgroup">
          <tr role="row">
            <th class="time-column" scope="col" role="columnheader">发生时间</th>
            <th class="type-column" scope="col" role="columnheader">业务类型</th>
            <th class="number-column" scope="col" role="columnheader">单据编号</th>
            <th class="status-column" scope="col" role="columnheader">状态</th>
            <th class="amount-column" scope="col" role="columnheader">单据金额</th>
          </tr>
        </thead>
        <tbody role="rowgroup">
          <tr v-for="(event, index) in records.data" :key="`${event.type}:${event.id ?? event.no ?? index}:${event.at ?? ''}`" role="row">
            <td class="record-time" role="cell"><DateTimeText :value="event.at" :known-date="event.bizDate" /></td>
            <td class="record-type" role="cell">{{ event.type || '类型未提供' }}</td>
            <td class="record-number mono" role="cell">{{ event.no || event.docNo || '单号未提供' }}</td>
            <td class="record-status" role="cell">
              <el-tag v-if="event.status" :type="eventStatus(event).type" size="small" disable-transitions>{{ eventStatus(event).label }}</el-tag>
            </td>
            <td class="record-amount" role="cell">
              <MoneyText v-if="event.amount != null && event.amount !== '' && eventCurrency(event)" :value="event.amount" :currency="eventCurrency(event)" />
              <span v-else class="muted">{{ event.amount == null || event.amount === '' ? '金额未提供' : '币种未提供' }}</span>
            </td>
          </tr>
        </tbody>
      </table>
    </section>
  </div>
</template>

<style scoped>
.customer-ledger { min-width: 0; max-width: 1280px; margin: 0 auto; }
.ledger-header { align-items: flex-start; flex-wrap: wrap; margin-bottom: 16px; }
.customer-identity { min-width: 0; flex: 1; }
.ledger-title-row { display: flex; align-items: baseline; flex-wrap: wrap; gap: 8px 12px; }
.ledger-title-row h2 { flex-shrink: 0; }
.customer-name { min-width: 0; padding-left: 12px; border-left: 1px solid var(--el-border-color); font-size: 16px; font-weight: 600; overflow-wrap: anywhere; }
.customer-context { display: flex; flex-wrap: wrap; gap: 4px 16px; margin: 6px 0 0; }
.ledger-currency { color: var(--el-text-color-regular); }
.ledger-actions { display: flex; flex-shrink: 0; align-items: center; gap: 8px; }
.ledger-actions :deep(.el-button + .el-button) { margin-left: 0; }
.balance-grid { display: grid; grid-template-columns: repeat(3, minmax(0, 1fr)); gap: 16px; margin: 0; }
.balance-item { min-width: 0; padding-right: 16px; border-right: 1px solid var(--el-border-color-lighter); }
.balance-item:last-child { border-right: 0; padding-right: 0; }
.balance-label { display: flex; align-items: baseline; flex-wrap: wrap; gap: 4px 12px; color: var(--el-text-color-regular); font-size: 14px; }
.balance-value { margin: 8px 0 0; font-size: 24px; font-weight: 600; line-height: 1.4; font-variant-numeric: tabular-nums; overflow-wrap: anywhere; }
.balance-help { position: relative; font-size: 12px; font-weight: 400; }
.balance-help summary { color: var(--el-text-color-secondary); cursor: pointer; }
.balance-help p { position: absolute; z-index: 1; top: 100%; left: 0; width: 200px; max-width: calc(100vw - 64px); margin: 8px 0 0; padding: 12px; border: 1px solid var(--el-border-color-light); border-radius: 6px; background: var(--el-bg-color); color: var(--el-text-color-regular); line-height: 1.6; }
.credit-strip { display: flex; align-items: baseline; flex-wrap: wrap; gap: 8px 24px; margin-top: 16px; padding-top: 12px; border-top: 1px solid var(--el-border-color-lighter); font-size: 13px; }
.credit-title { flex-shrink: 0; font-weight: 500; }
.credit-fields { display: flex; flex: 1; flex-wrap: wrap; gap: 8px 24px; min-width: 0; margin: 0; }
.credit-field { display: flex; align-items: baseline; flex-wrap: wrap; gap: 4px 8px; min-width: 0; }
.credit-field dt { color: var(--el-text-color-regular); }
.credit-field dd { min-width: 0; margin: 0; overflow-wrap: anywhere; }
.records-header { display: flex; align-items: center; justify-content: space-between; flex-wrap: wrap; gap: 8px 16px; margin-bottom: 12px; }
.records-header h3 { margin: 0; font-size: 16px; font-weight: 600; }
.records-header p { margin: 4px 0 0; }
.ledger-loading { padding: 8px 0; }
.ledger-loading p { margin: 12px 0 0; }
.ledger-error { margin: 4px 0 12px; white-space: pre-wrap; overflow-wrap: anywhere; }
.ledger-table { width: 100%; border-collapse: collapse; table-layout: fixed; font-size: 14px; }
.ledger-table th, .ledger-table td { padding: 11px 12px; border-bottom: 1px solid var(--el-border-color-lighter); text-align: left; line-height: 22px; overflow-wrap: anywhere; }
.ledger-table th { background: var(--el-fill-color-light); color: var(--el-text-color-regular); font-size: 13px; font-weight: 500; }
.ledger-table tbody tr:last-child td { border-bottom: 0; }
.time-column { width: 22%; }
.type-column { width: 10%; }
.number-column { width: 36%; }
.status-column { width: 12%; }
.amount-column { width: 20%; }
.record-time { color: var(--el-text-color-regular); font-size: 13px; }
.record-type { font-weight: 500; }
.record-status :deep(.el-tag) { height: auto; min-height: 20px; white-space: normal; overflow-wrap: anywhere; }
.ledger-table .amount-column, .ledger-table .record-amount { text-align: right; font-variant-numeric: tabular-nums; }
.customer-ledger :deep(.el-button:focus-visible), .balance-help summary:focus-visible { outline: 2px solid var(--el-color-primary); outline-offset: 3px; }
@media (prefers-reduced-motion: reduce) {
  .customer-ledger :deep(.el-skeleton.is-animated .el-skeleton__item) { animation: none; }
}
@media (max-width: 760px) {
  .ledger-table, .ledger-table tbody { display: block; }
  .ledger-table thead { position: absolute; width: 1px; height: 1px; overflow: hidden; clip-path: inset(50%); white-space: nowrap; }
  .ledger-table tbody tr { display: grid; grid-template-columns: repeat(2, minmax(0, 1fr)); grid-template-areas: "type status" "number number" "time amount"; gap: 6px 12px; padding: 12px 0; border-bottom: 1px solid var(--el-border-color-lighter); }
  .ledger-table tbody tr:last-child { padding-bottom: 0; border-bottom: 0; }
  .ledger-table td { min-width: 0; padding: 0; border: 0; }
  .record-type { grid-area: type; }
  .ledger-table .record-status { grid-area: status; text-align: right; }
  .record-number { grid-area: number; }
  .record-time { grid-area: time; font-size: 12px; }
  .record-amount { grid-area: amount; }
  .balance-help p { position: static; width: auto; max-width: none; padding: 8px 0 0; border: 0; margin: 0; }
}
@media (max-width: 480px) {
  .customer-identity { flex-basis: 100%; }
  .customer-name { width: 100%; padding-left: 0; border-left: 0; }
  .balance-grid { grid-template-columns: minmax(0, 1fr); gap: 12px; }
  .balance-item { padding: 0 0 12px; border-right: 0; border-bottom: 1px solid var(--el-border-color-lighter); }
  .balance-item:last-child { padding-bottom: 0; border-bottom: 0; }
  .balance-value { margin-top: 4px; }
  .credit-strip { gap: 8px 16px; }
  .credit-fields { flex-basis: 100%; display: grid; gap: 8px; }
  .credit-field { justify-content: space-between; }
}
</style>
