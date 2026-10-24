<script setup lang="ts">
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
      state.error = error instanceof Error && error.message ? error.message : '读取失败，请重试'
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
      <div class="ledger-navigation">
        <el-button link type="primary" @click="router.push('/ar/receivables')">返回应收</el-button>
        <h2>客户往来</h2>
      </div>
      <el-button :loading="balance.loading || records.loading" @click="load()">刷新</el-button>
    </header>

    <section class="page-card ledger-overview" aria-labelledby="customer-name" :aria-busy="balance.loading">
      <header class="customer-summary">
        <div class="customer-identity">
          <h3 id="customer-name">{{ customerName }}</h3>
          <p class="customer-context muted">
            <span>客户编号 <span class="mono">{{ Number.isSafeInteger(id) && id > 0 ? id : '-' }}</span></span>
            <span>查询币种 <span class="ledger-currency">{{ currency || '未提供' }}</span></span>
          </p>
        </div>
        <span class="muted">客户余额概览</span>
      </header>

      <div v-if="balance.loading" class="ledger-loading" role="status">
        <el-skeleton :rows="2" animated />
        <p class="muted">正在读取客户余额…</p>
      </div>
      <el-alert v-else-if="balance.error" title="客户余额读取失败" type="error" :closable="false" show-icon>
        <p class="ledger-error">{{ balance.error }}</p>
        <el-button size="small" :loading="balance.loading" @click="load('balance')">重新读取余额</el-button>
      </el-alert>
      <template v-else-if="balance.data">
        <p v-if="!currency" class="muted">币种未提供，余额金额暂不展示。</p>
        <dl class="balance-grid">
          <div v-for="metric in metrics" :key="metric.key" class="balance-item">
            <dt>{{ metric.label }}</dt>
            <dd class="balance-value">
              <MoneyText v-if="currency" :value="balance.data[metric.key]" :currency="currency" />
              <span v-else class="mono">-</span>
            </dd>
            <dd class="balance-help muted">{{ metric.help }}</dd>
          </div>
          <div class="balance-item credit-item">
            <dt>授信额度</dt>
            <dd v-for="field in creditFields" :key="field.key" class="credit-line">
              <span class="muted">{{ field.label }}</span>
              <MoneyText v-if="currency" :value="balance.data[field.key]" :currency="currency" />
              <span v-else class="mono">-</span>
            </dd>
          </div>
        </dl>
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
      <el-alert v-else-if="records.error" title="往来记录读取失败" type="error" :closable="false" show-icon>
        <p class="ledger-error">{{ records.error }}</p>
        <el-button size="small" :loading="records.loading" @click="load('records')">重新读取记录</el-button>
      </el-alert>
      <el-empty v-else-if="records.data?.length === 0" description="暂无往来记录" :image-size="64" />
      <el-timeline v-else-if="records.data" class="ledger-timeline">
        <el-timeline-item v-for="(event, index) in records.data" :key="`${event.type}:${event.id ?? event.no ?? index}:${event.at ?? ''}`" type="primary" hollow>
          <div class="record-content">
            <div class="record-details">
              <div class="record-heading">
                <span class="record-type">{{ event.type || '类型未提供' }}</span>
                <el-tag v-if="event.status" :type="eventStatus(event).type" size="small" disable-transitions>{{ eventStatus(event).label }}</el-tag>
              </div>
              <p class="record-number mono">{{ event.no || event.docNo || '单号未提供' }}</p>
              <p class="record-time muted"><DateTimeText :value="event.at" :known-date="event.bizDate" /></p>
            </div>
            <div class="record-amount">
              <span class="muted">单据金额</span>
              <MoneyText v-if="event.amount != null && event.amount !== '' && eventCurrency(event)" :value="event.amount" :currency="eventCurrency(event)" />
              <span v-else class="muted">{{ event.amount == null || event.amount === '' ? '金额未提供' : '币种未提供' }}</span>
            </div>
          </div>
        </el-timeline-item>
      </el-timeline>
    </section>
  </div>
</template>

<style scoped>
.customer-ledger { min-width: 0; }
.ledger-header { flex-wrap: wrap; }
.ledger-navigation { display: flex; align-items: center; flex-wrap: wrap; gap: 16px; min-width: 0; }
.customer-summary, .records-header { display: flex; align-items: flex-start; justify-content: space-between; flex-wrap: wrap; gap: 12px; }
.customer-summary { padding-bottom: 16px; margin-bottom: 16px; border-bottom: 1px solid var(--el-border-color-lighter); }
.customer-identity { min-width: 0; flex: 1; }
.customer-summary h3 { margin: 0; font-size: 18px; font-weight: 600; overflow-wrap: anywhere; }
.customer-context { display: flex; flex-wrap: wrap; gap: 8px 16px; margin: 8px 0 0; }
.ledger-currency { color: var(--el-text-color-regular); }
.balance-grid { display: grid; grid-template-columns: repeat(4, minmax(0, 1fr)); gap: 24px 16px; margin: 0; }
.balance-item { min-width: 0; padding-right: 16px; border-right: 1px solid var(--el-border-color-lighter); }
.balance-item:last-child { border-right: 0; padding-right: 0; }
.balance-item dt { color: var(--el-text-color-regular); font-size: 13px; }
.balance-item dd { margin-left: 0; overflow-wrap: anywhere; }
.balance-value { margin-top: 12px; font-size: 26px; font-weight: 600; line-height: 1.4; font-variant-numeric: tabular-nums; }
.balance-help { margin-top: 8px; margin-bottom: 0; font-size: 12px; line-height: 1.6; }
.credit-line { display: flex; justify-content: space-between; flex-wrap: wrap; gap: 4px 12px; margin-top: 8px; margin-bottom: 0; font-size: 14px; }
.credit-line > :last-child { min-width: 0; margin-left: auto; text-align: right; overflow-wrap: anywhere; }
.records-header { align-items: center; margin-bottom: 24px; }
.records-header h3 { margin: 0; font-size: 16px; font-weight: 600; }
.records-header p { margin: 6px 0 0; }
.ledger-loading { padding: 8px 0; }
.ledger-loading p { margin: 12px 0 0; }
.ledger-error { margin: 4px 0 12px; white-space: pre-wrap; overflow-wrap: anywhere; }
.ledger-timeline { padding-left: 4px; margin: 0; }
.record-content { display: flex; align-items: flex-start; justify-content: space-between; gap: 16px; padding-bottom: 16px; border-bottom: 1px solid var(--el-border-color-lighter); }
.ledger-timeline :deep(.el-timeline-item:last-child .record-content) { padding-bottom: 0; border-bottom: 0; }
.record-details { flex: 1; min-width: 0; }
.record-heading { display: flex; align-items: center; flex-wrap: wrap; gap: 8px; }
.record-type { font-size: 14px; font-weight: 600; }
.record-number { margin: 8px 0; font-size: 13px; overflow-wrap: anywhere; }
.record-time { margin: 0; line-height: 1.6; overflow-wrap: anywhere; }
.record-amount { display: flex; flex-direction: column; gap: 8px; max-width: 50%; min-width: 0; text-align: right; font-size: 14px; overflow-wrap: anywhere; }
.record-amount > .muted { font-size: 12px; }
.customer-ledger :deep(.el-button:focus-visible) { outline: 2px solid var(--el-color-primary); outline-offset: 3px; }
@media (prefers-reduced-motion: reduce) {
  .customer-ledger :deep(.el-skeleton.is-animated .el-skeleton__item) { animation: none; }
}
@media (max-width: 1100px) {
  .balance-grid { grid-template-columns: repeat(2, minmax(0, 1fr)); }
  .balance-item:nth-child(2n) { padding-right: 0; border-right: 0; }
}
@media (max-width: 600px) {
  .record-content { flex-direction: column; gap: 12px; }
  .record-amount { max-width: 100%; text-align: left; }
}
@media (max-width: 480px) {
  .balance-grid { grid-template-columns: minmax(0, 1fr); gap: 16px; }
  .balance-item { padding: 0 0 16px; border-right: 0; border-bottom: 1px solid var(--el-border-color-lighter); }
  .balance-item:last-child { padding-bottom: 0; border-bottom: 0; }
  .balance-value { font-size: 24px; margin-top: 8px; }
  .ledger-navigation { gap: 12px; }
}
</style>
