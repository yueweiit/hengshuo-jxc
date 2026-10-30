import test from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { ref, reactive, computed } from 'vue'
import './support.mjs'
import { loadVueScript } from './contracts/load-vue-script.mjs'
import { loadTsModule } from './contracts/load-ts-module.mjs'
const drafts = loadTsModule(new URL('../src/modules/approval/opinion-draft.ts', import.meta.url))
const feedback = await import('../src/api/error-feedback.ts')
const file = new URL('../src/modules/approval/ApprovalTaskList.vue', import.meta.url)
test('审批失败交给全局出口，意见与当前审批弹窗保留，业务状态不能冒充成功', async () => {
  feedback.clearErrors()
  const error = Object.assign(new Error('可售库存不足'), { code: 'INV_INSUFFICIENT_AVAILABLE' })
  const scope = loadVueScript(file, { ...feedback, ...drafts, ref, reactive, defineProps: () => ({ mode: 'todo' }), useTodoStore: () => ({}), useUserStore: () => ({}), onBeforeUnmount() {}, onMounted() {}, http: { post: async () => { throw error } }, useRouter: () => ({ push() {} }), financeSourcePath: () => '/sales/orders/7', getToken: () => 'user', getCountryId: () => 3 }, ['openAction', 'submitAction', 'action'])
  scope.openAction({ id: 1, status: 'PENDING', instanceStatus: 'PENDING', docType: 'SALES_ORDER', docId: 7 }, 'approve')
  scope.action.comment = '核对后的意见'
  await scope.submitAction()
  assert.equal(feedback.getErrors().length, 1)
  assert.match(feedback.getErrors()[0].title, /审批/)
  assert.equal(scope.action.comment, '核对后的意见')
  assert.equal(scope.action.visible, true)
  assert.equal(scope.action.saving, false)
  assert.doesNotMatch(readFileSync(file, 'utf8'), /<el-alert[^>]*v-if="action\.error"/)
})

test('缺货明细及金额反馈复用全局组件，不保留内嵌金额错误组件', () => {
  const source = readFileSync(new URL('../src/modules/sales/SalesOrderDetail.vue', import.meta.url), 'utf8')
  assert.doesNotMatch(source, /<OutboundPaymentCheck/)
  assert.doesNotMatch(source, /<el-alert[^>]*:title="checkError"/)
})

test('切到另一订单后，旧通知按固定原单入口导航，不读取新单号或覆盖新选择', async () => {
  feedback.clearErrors()
  const pushed = [], route = reactive({ params: { id: '7' } })
  const page = loadVueScript(new URL('../src/modules/sales/SalesOrderDetail.vue', import.meta.url), {
    ...feedback, ref, reactive, computed, watch() {}, onMounted() {},
    useRoute: () => route, useRouter: () => ({ push: p => pushed.push(p) }),
    useCountryStore: () => ({ epoch: 1 }), useUserStore: () => ({ hasPerm: () => true, fieldAccess: () => 'WRITE' }),
    getCountryId: () => 3, getToken: () => 'same-user', createCommandIntent: () => ({}),
  }, ['showOutboundFailure', 'checks', 'order', 'ob'])
  page.order.value = { id: 7 }; page.ob.warehouseId = 33; page.ob.qty = { 1: 2 }
  page.checks.value = [{ item: '现款到账', ok: false, payment: { amountsVisible: true, canManageReceipts: true, requiredAmount: 20, confirmedAmount: 10, shortageAmount: 10, currency: 'MXN' } }]
  page.showOutboundFailure()
  const notice = feedback.getErrors().at(-1), action = notice.actions.find(a => a.intent === 'register')
  assert.ok(action); assert.match(action.to, /orderId=7/)
  route.params.id = '9'
  const handled = await notice.beforeNavigate(action)
  if (handled !== false) pushed.push(action.to) // 与真实宿主相同的默认站内导航。
  assert.deepEqual(pushed, [action.to])
  assert.deepEqual({ ...page.ob.qty }, { 1: 2 })
})
