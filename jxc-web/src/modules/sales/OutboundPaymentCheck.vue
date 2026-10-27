<script setup lang="ts">
import { computed } from 'vue'
import { useUserStore } from '@/stores/user'
import MoneyText from '@/components/MoneyText.vue'

type Amount = number | string
interface Payment {
  currency: string
  amountsVisible?: boolean
  requiredAmount?: Amount
  confirmedAmount?: Amount
  shortageAmount?: Amount
  shippedAmount?: Amount
  outboundAmount?: Amount
  pendingAmount?: Amount
  canManageReceipts?: boolean
}
const props = defineProps<{ check: { ok?: boolean; message?: string; payment?: Payment } }>()
defineEmits<{ action: [action: string]; retry: [] }>()
const user = useUserStore()
const amounts = computed(() => {
  const payment = props.check.payment
  if (!payment || payment.amountsVisible === false || user.fieldAccess('ORDER_TOTAL') === 'HIDDEN') return []
  const rows = [
    { key: 'requiredAmount', label: '出库后累计需要', value: payment.requiredAmount },
    { key: 'confirmedAmount', label: '本单已确认并分配', value: payment.confirmedAmount },
    { key: 'shortageAmount', label: '尚差已确认收款', value: payment.shortageAmount },
  ]
  return rows.every(row => row.value != null && row.value !== '' && Number.isFinite(Number(row.value))) ? rows : []
})
const actions = computed(() => {
  const payment = props.check.payment
  if (!payment?.canManageReceipts || !amounts.value.length) return []
  const actions: { key: string; label: string }[] = []
  const pending = payment.pendingAmount != null && Number(payment.pendingAmount) > 0
  const bankWritable = user.fieldAccess('BANK_INFO') === 'WRITE'
  if (!props.check.ok && pending && user.hasPerm('ar:receipt:confirm') && bankWritable) actions.push({ key: 'confirm', label: '去确认到账' })
  if (!props.check.ok && !pending && user.hasPerm('ar:receipt:create') && bankWritable && user.fieldAccess('ORDER_TOTAL') === 'WRITE') actions.push({ key: 'register', label: '去登记收款' })
  if (user.hasPerm('ar:receipt:create') || user.hasPerm('ar:receipt:confirm')) actions.push({ key: 'view', label: '查看本单收款' })
  return actions
})
</script>

<template>
  <section class="payment-check mt" :role="check.ok ? 'status' : 'alert'" aria-label="出库收款检查">
    <strong :class="{ shortage: !check.ok }">{{ check.ok ? '本单已确认收款满足出库金额' : '暂不能出库：本单已确认收款不足' }}</strong>
    <dl v-if="amounts.length" class="amounts">
      <div v-for="row in amounts" :key="row.key">
        <dt>{{ row.label }}</dt>
        <dd :class="{ shortage: row.key === 'shortageAmount' && Number(row.value) > 0 }">
          <span v-if="Number(row.value) !== 0 && Math.abs(Number(row.value)) < 0.01">{{ check.payment!.currency }} {{ Number(row.value).toFixed(4) }}</span>
          <MoneyText v-else :value="row.value" :currency="check.payment!.currency" />
        </dd>
      </div>
    </dl>
    <p v-else class="muted">{{ check.payment?.amountsVisible === false || user.fieldAccess('ORDER_TOTAL') === 'HIDDEN' ? '当前账号没有本订单金额查看权限，请财务核对收款条件。' : '金额明细未完整返回，请重新检查。' }}</p>
    <p v-if="amounts.length && Number(check.payment?.shippedAmount) > 0" class="muted">累计需要 = 此前已出库 <MoneyText :value="check.payment?.shippedAmount" :currency="check.payment?.currency" /> + 本次出库 <MoneyText :value="check.payment?.outboundAmount" :currency="check.payment?.currency" /></p>
    <p v-if="amounts.length && Number(check.payment?.pendingAmount) > 0" class="muted">本单另有待确认收款 <MoneyText :value="check.payment?.pendingAmount" :currency="check.payment?.currency" />，尚未计入。请先核对原收款，避免重复登记。</p>
    <p class="muted">只计入已确认且分配到本订单的收款。已收款但未确认，或尚未分配到本单，都不能计入。</p>
    <p v-if="!check.ok && !actions.some(action => action.key === 'register' || action.key === 'confirm')" class="muted">请有收款登记或到账确认权限的人员处理，可复制页面上的订单号交给财务核对。</p>
    <div class="payment-actions">
      <el-button v-for="(action, index) in actions" :key="action.key" :type="index === 0 ? 'primary' : 'default'" @click="$emit('action', action.key)">{{ action.label }}</el-button>
      <el-button @click="$emit('retry')">重新检查</el-button>
    </div>
  </section>
</template>

<style scoped>
.payment-check { border: 1px solid var(--el-border-color-light); border-radius: 4px; padding: 16px; }
.amounts { margin: 14px 0; display: grid; grid-template-columns: repeat(3, minmax(0, 1fr)); gap: 16px; }
.amounts dt { color: var(--el-text-color-secondary); font-size: 13px; }
.amounts dd { margin: 6px 0 0; font-variant-numeric: tabular-nums; font-weight: 600; text-align: right; overflow-wrap: anywhere; }
.shortage { color: var(--el-color-danger); }
.payment-actions { display: flex; gap: 8px; flex-wrap: wrap; }
.payment-actions .el-button { margin: 0; }
@media (max-width: 560px) { .amounts { grid-template-columns: 1fr; gap: 10px; } .amounts > div { display: flex; justify-content: space-between; gap: 12px; } .amounts dd { margin: 0; } }
</style>
