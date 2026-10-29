import test from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { computed, createSSRApp, defineComponent, h, compile } from 'vue'
import { renderToString } from '@vue/server-renderer'
import { loadTsModule } from './contracts/load-ts-module.mjs'
import { loadVueScript } from './contracts/load-vue-script.mjs'

const file = new URL('../src/modules/purchase/PurchaseImportFees.vue', import.meta.url)
const { createPurchaseImportModel } = loadTsModule(new URL('../src/modules/purchase/purchaseImportModel.ts', import.meta.url))
async function render(page) {
  const props = { page, disabled: false }
  const bindings = loadVueScript(file, { computed, defineProps: () => props }, ['locked', 'groupLocked'])
  const template = readFileSync(file, 'utf8').match(/<template>([\s\S]*)<\/template>/)[1]
  const app = createSSRApp({ setup: () => ({ ...props, ...bindings }), render: compile(template) })
  const slot = defineComponent({ inheritAttrs: false, setup: (_, ctx) => () => h('div', ctx.attrs, ctx.slots.default?.()) })
  for (const name of ['ElInput', 'ElSelect', 'ElOption', 'ElCheckbox', 'ElButton', 'ElAlert']) app.component(name, slot)
  return renderToString(app)
}
test('基础费用表在正式单号不存在时提供可编辑费用与原文件参考，不产生正式单号输入', async () => {
  const page = createPurchaseImportModel({}, '2026-10-30')
  page.state.batchId = '11111111-2222-4333-8444-555555555555'
  page.state.rows = [{ id: 1, rowNo: 1, groupId: 8 }]
  page.state.groups = [{ id: 8, sourceOrderNo: 'NY-051', header: { currency: 'USD' }, orderId: null, createStatus: 'DRAFT', feeTodos: [{ sourceRowIds: [1], amount: null, currency: null, scope: null, reason: '待核实', reviewStatus: 'UNRESOLVED' }], sourceEvidence: [{ rowId: 1, rowNo: 1 }] }]
  const html = await render(page)
  assert.match(html, /本次导入费用/); assert.match(html, /NY-051/); assert.match(html, /无需.*正式采购单号/)
  for (const name of ['费用金额', '费用币种', '费用归属', '费用来源明细', '费用核对说明', '确认本项费用']) assert.ok(html.includes(name), name)
  assert.match(html, /USD/); assert.doesNotMatch(html, /aria-label="正式采购单号"/)
  page.fees.entries()[0].items[0].amount = '29.1'; assert.equal(page.fees.dirty(), true)
})
test('尚未导入时费用区解释先导入明细即可，不要求先建采购单', async () => {
  const html = await render(createPurchaseImportModel({}, '2026-10-30'))
  assert.match(html, /本次导入费用/); assert.match(html, /导入.*明细/); assert.match(html, /无需.*正式采购单号/)
})
