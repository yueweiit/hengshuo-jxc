import test from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { ref, reactive } from 'vue'
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
