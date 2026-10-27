import test from 'node:test'
import assert from 'node:assert/strict'
import { computed, reactive, ref } from 'vue'
import { loadVueScript } from './contracts/load-vue-script.mjs'
import { feeTreatmentLabel, supportsLogisticsFee } from '../src/modules/logistics/feeTreatment.ts'

class BizError extends Error {}
function fixture(send = async () => ({}), includeOptions = false) {
  const calls = [], messages = []
  const items = [
    { id: 1, name: '海运费', status: 'ENABLED', costTreatment: 'CAPITALIZE' },
    { id: 2, name: '期间物流经营费用', status: 'ENABLED', costTreatment: 'PERIOD_EXPENSE' },
    { id: 3, name: '旧期间费用', status: 'ENABLED', costTreatment: 'EXPENSE' },
    { id: 4, name: '直接销售费', status: 'ENABLED', costTreatment: 'DIRECT_SELLING' },
    { id: 5, name: '停用海运费', status: 'DISABLED', costTreatment: 'CAPITALIZE' },
  ]
  const page = loadVueScript(new URL('../src/modules/logistics/FeeForm.vue', import.meta.url), {
    computed, reactive, ref, watch() {}, defineEmits: () => () => {}, defineExpose() {},
    useCountryStore: () => ({ currency: 'MXN', timezone: 'America/Mexico_City' }), useUserStore: () => ({}),
    todayIn: () => '2026-10-27', createCommandIntent: () => ({}), BizError, feeTreatmentLabel, supportsLogisticsFee,
    COST_TREATMENTS: [{ value: 'CAPITALIZE', label: '计入商品成本' }, { value: 'PERIOD_EXPENSE', label: '期间费用' }],
    ElMessage: { warning: x => messages.push(x), success: x => messages.push(x) },
    allRecords: async path => path === '/md/expense-items' ? items : [{ id: 7, docNo: 'SH7' }],
    http: { postIdem: async (...args) => { calls.push(args); return send(...args) } },
  }, ['open', 'save', 'm', 'visible', 'saving', ...(includeOptions ? ['expenseItemOptions'] : [])])
  return { page, calls, messages }
}
test('logistics candidates include period and legacy expenses, label their treatment and exclude other types', async () => {
  const { page } = fixture(undefined, true)
  await page.open({ refId: 7 })
  assert.deepEqual(page.expenseItemOptions.value.map(o => o.value), [1, 2, 3])
  assert.match(page.expenseItemOptions.value[1].label, /期间物流经营费用.*期间费用/)
  assert.match(page.expenseItemOptions.value[2].label, /期间费用/)
})
test('thirty MXN is sent through the original logistics command and an in-flight click does not duplicate it', async () => {
  let finish
  const f = fixture(() => new Promise(resolve => { finish = resolve }))
  await f.page.open({ refId: 7 })
  Object.assign(f.page.m, { carrierId: 8, expenseItemId: 2, amount: 30 })
  const first = f.page.save(true)
  const duplicate = f.page.save(true)
  await Promise.resolve()
  assert.equal(f.calls.length, 1)
  assert.equal(f.calls[0][0], '/lgs/fees')
  assert.equal(f.calls[0][1].amount, 30)
  assert.equal(f.calls[0][1].currency, 'MXN')
  finish({}); await first; await duplicate
  assert.equal(f.page.visible.value, false)
})
test('a business failure already displayed by http retains input without a second toast or uncaught rejection', async () => {
  const f = fixture(async () => { throw new BizError('该项目属于直接销售费用，请到费用登记页面登记') })
  await f.page.open({ refId: 7 })
  Object.assign(f.page.m, { carrierId: 8, expenseItemId: 2, amount: 30 })
  await f.page.save(true)
  assert.equal(f.page.visible.value, true)
  assert.equal(f.page.m.amount, 30)
  assert.equal(f.page.saving.value, false)
  assert.deepEqual(f.messages, [])
})
test('a changed login or country context is explained because the HTTP scope guard has no toast', async () => {
  const f = fixture(async () => { throw Object.assign(new BizError('国家或登录状态已切换，请重试'), { code: 'CONTEXT_CHANGED' }) })
  await f.page.open({ refId: 7 })
  Object.assign(f.page.m, { carrierId: 8, expenseItemId: 2, amount: 30 })
  await f.page.save(true)
  assert.deepEqual(f.messages, ['国家或登录状态已切换，请重试'])
  assert.equal(f.page.visible.value, true)
})
