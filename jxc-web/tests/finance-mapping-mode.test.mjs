import test from 'node:test'
import assert from 'node:assert/strict'
import * as vue from 'vue'
import { loadVueScript } from './contracts/load-vue-script.mjs'

test('a copied no-voucher mapping becomes a voucher draft without retaining the old reason or mutating the active version', async () => {
  const calls = []
  const page = loadVueScript(new URL('../src/modules/finance/MappingList.vue', import.meta.url), {
    ref: vue.ref, computed: vue.computed, onMounted() {},
    createCommandIntent: () => ({}), allRecords: async () => [],
    http: { postIdem: async (path, body) => { calls.push({ path, body }); return {} } },
    ElMessage: { error(message) { throw new Error(message) } },
  }, ['edit', 'save', 'form', 'bookId'])
  page.bookId.value = 194
  const active = { id: 601, bookId: 194, eventType: 'CST_INBOUND_COST_CONFIRMED', version: 2, versionNo: 1, status: 'ACTIVE', accountingMode: 'NO_VOUCHER', noVoucherReason: 'Opening source is already in the independent GL opening.', lines: [] }
  page.edit(active, true)
  page.form.value.accountingMode = 'VOUCHER'
  page.form.value.lines = [
    { direction: 'DEBIT', accountRule: { type: 'FIXED', code: '1405' }, amountExpr: 'amount', auxJson: '{}', summary: 'Purchase cost', cashflowItemId: null },
    { direction: 'CREDIT', accountRule: { type: 'FIXED', code: '2202' }, amountExpr: 'apAmount', auxJson: '{"PARTNER":"partnerId"}', summary: 'Payable source', cashflowItemId: null },
  ]
  await page.save()
  assert.equal(calls[0].path, '/fin/mapping-templates')
  assert.equal(calls[0].body.accountingMode, 'VOUCHER')
  assert.equal(calls[0].body.noVoucherReason, null)
  assert.equal(calls[0].body.lines[1].auxMapping.PARTNER, 'partnerId')
  assert.equal(active.status, 'ACTIVE')
  assert.equal(active.accountingMode, 'NO_VOUCHER')
  assert.equal(active.noVoucherReason, 'Opening source is already in the independent GL opening.')
  assert.deepEqual(active.lines, [])

  page.edit(active, true)
  page.form.value.noVoucherReason = 'Locally reviewed source confirmation.'
  await page.save()
  assert.equal(calls[1].body.accountingMode, 'NO_VOUCHER')
  assert.equal(calls[1].body.noVoucherReason, 'Locally reviewed source confirmation.')
  assert.deepEqual(calls[1].body.lines, [])
})

test('the original mapping editor offers owner posting fields and preserves them when saving a reviewed-version copy', async () => {
  let sent
  const page = loadVueScript(new URL('../src/modules/finance/MappingList.vue', import.meta.url), {
    ref: vue.ref, computed: vue.computed, onMounted() {}, createCommandIntent: () => ({}), allRecords: async () => [],
    http: { postIdem: async (path, body) => { sent = body; return {} } },
    ElMessage: { error(message) { throw new Error(message) } },
  }, ['amountFields', 'edit', 'save', 'form', 'bookId'])
  const fields = ['postingInventoryAmount', 'postingCogsAmount', 'postingCounterpartAmount']
  for (const field of fields) assert.ok(page.amountFields.includes(field), `The editor must offer ${field} from the owner contract`)
  page.bookId.value = 194
  page.edit()
  page.form.value.eventType = 'CST_COST_ADJUSTED'
  page.form.value.lines = fields.map((amountExpr, index) => ({ direction: index === 2 ? 'CREDIT' : 'DEBIT', accountRule: { type: 'FIXED', code: ['1405', '6401', '2241'][index] }, amountExpr, auxJson: '{}', summary: 'Reviewed native posting projection' }))
  await page.save()
  assert.deepEqual(sent.lines.map(line => line.amountExpr), fields)
  assert.equal(sent.accountingMode, 'VOUCHER')
  assert.equal(sent.noVoucherReason, null)
})
