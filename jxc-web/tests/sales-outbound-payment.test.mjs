import test from 'node:test'
import assert from 'node:assert/strict'
import { computed, reactive } from 'vue'
import { existsSync } from 'node:fs'
import { loadVueScript } from './contracts/load-vue-script.mjs'

function panel({ pending = 0, access = 'WRITE', permissions = ['ar:receipt:create', 'ar:receipt:confirm'] } = {}) {
  const file = new URL('../src/modules/sales/OutboundPaymentCheck.vue', import.meta.url)
  assert.ok(existsSync(file), '出库需要金额明细及后续操作展示')
  const props = reactive({ check: { ok: false, message: '本单已确认收款不足', payment: { currency: 'MXN', requiredAmount: 2900, confirmedAmount: 100, shortageAmount: 2800, pendingAmount: pending, canManageReceipts: true } } })
  return loadVueScript(file, { computed, defineProps: () => props, defineEmits: () => () => {}, useUserStore: () => ({ hasPerm: code => permissions.includes(code), fieldAccess: () => access }) }, ['amounts', 'actions'])
}
test('金额不足显示三项服务端金额及登记入口', () => {
  const p = panel()
  assert.deepEqual(p.amounts.value.map(row => row.value), [2900, 100, 2800])
  assert.equal(p.actions.value[0].key, 'register')
})
test('已有待确认款优先处理原单，不引导重复登记', () => {
  const p = panel({ pending: 2800 })
  assert.equal(p.actions.value[0].key, 'confirm')
  assert.equal(p.actions.value.some(row => row.key === 'register'), false)
})
test('隐藏金额或缺操作权限时不出现可写资金入口', () => {
  const hidden = panel({ access: 'HIDDEN' })
  assert.deepEqual(hidden.amounts.value, [])
  assert.equal(hidden.actions.value.some(row => ['register', 'confirm'].includes(row.key)), false)
  assert.deepEqual(panel({ permissions: [] }).actions.value, [])
})
