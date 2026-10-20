import test from 'node:test'
import assert from 'node:assert/strict'
import * as Vue from 'vue'
import { loadVueScript } from './contracts/load-vue-script.mjs'

function setup(permissions) {
  const calls = []
  const p = loadVueScript(new URL('../src/modules/cost/ExpenseList.vue', import.meta.url), {
    ref: Vue.ref, reactive: Vue.reactive, computed: Vue.computed, onMounted() {}, useCountryStore: () => ({ currency: 'CNY', timezone: 'Asia/Shanghai' }), todayIn: () => '2026-10-17', createCommandIntent: () => ({ reset() {} }),
    useUserStore: () => ({ hasPerm: codes => (Array.isArray(codes) ? codes : [codes]).some(code => permissions.includes(code)) }),
    allRecords: async path => { calls.push(path); return path === '/cst/expenses' ? [{ id: 7, expenseItemId: 77, amount: '20', currency: 'CNY' }, { id: 8, expenseItemId: 78, itemName: '原来源名称' }] : [{ id: 77, name: '期间费用', costTreatment: 'PERIOD_EXPENSE' }, { id: 79, name: '资本化', costTreatment: 'CAPITALIZE' }] },
  }, ['load', 'rows', 'items'])
  return { p, calls }
}
test('a cost-only viewer reads native expenses without attempting a forbidden optional MD reference lookup', async () => {
  const { p, calls } = setup(['cst:cost:view']); await p.load()
  assert.deepEqual(calls, ['/cst/expenses']); assert.equal(p.rows.value[0].itemName, '#77'); assert.equal(p.rows.value[1].itemName, '原来源名称'); assert.deepEqual(p.items.value, [])
})
test('each existing MD-reference permission retains the paginated owner lookup and real names without enabling capitalized expense choices', async () => {
  for (const permission of ['md:expense-item:edit', 'pur:order:create', 'lgs:shipment:create', 'lgs:fee:create', 'ap:bill:view', 'cst:expense:create']) {
    const { p, calls } = setup(['cst:cost:view', permission]); await p.load()
    assert.deepEqual(calls, ['/cst/expenses', '/md/expense-items']); assert.equal(p.rows.value[0].itemName, '期间费用'); assert.equal(p.rows.value[1].itemName, '原来源名称'); assert.deepEqual(p.items.value.map(item => item.id), [77])
  }
})
