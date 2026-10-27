import test from 'node:test'
import assert from 'node:assert/strict'
import './support.mjs'
const { describeFailure } = await import('../src/api/error-guidance.ts')
const { visibleActions, visibleDetails } = await import('../src/api/error-feedback.ts')
function panel({ pending = 0, access = 'WRITE', permissions = ['ar:receipt:create', 'ar:receipt:confirm'] } = {}) {
  const failure = { message: '出库条件未满足', data: { kind: 'OUTBOUND_CHECK', orderId: 7, checks: [{ item: '现款到账', ok: false, message: '本单已确认收款不足', payment: { currency: 'MXN', amountsVisible: true, requiredAmount: 2900, confirmedAmount: 100, shortageAmount: 2800, pendingAmount: pending, canManageReceipts: true } }] } }
  const notice = describeFailure(failure, {})
  const hasPerm = p => !p || (Array.isArray(p) ? p : [p]).some(code => permissions.includes(code))
  return { details: visibleDetails(notice, () => access, hasPerm), actions: visibleActions(notice, hasPerm, () => access) }
}
test('金额不足由全局反馈显示三项服务端金额及登记入口', () => {
  const p = panel()
  assert.deepEqual(p.details.map(row => row.value), [2900, 100, 2800])
  assert.equal(p.actions[0].intent, 'register')
})
test('全局反馈已有待确认款优先处理原单，不引导重复登记', () => {
  const p = panel({ pending: 2800 })
  assert.equal(p.actions[0].intent, 'confirm')
  assert.equal(p.actions.some(row => row.intent === 'register'), false)
})
test('全局反馈隐藏金额或缺操作权限时不出现可写资金入口', () => {
  assert.deepEqual(panel({ access: 'HIDDEN' }).details, [])
  assert.equal(panel({ access: 'HIDDEN' }).actions.some(row => ['register', 'confirm'].includes(row.intent)), false)
  assert.deepEqual(panel({ permissions: [] }).actions, [])
})
