import test from 'node:test'
import assert from 'node:assert/strict'
import { loadTsModule } from './contracts/load-ts-module.mjs'
import { watch } from 'vue'

const model = () => loadTsModule(new URL('../src/modules/purchase/purchaseImportModel.ts', import.meta.url))
const batchId = '11111111-2222-4333-8444-555555555555'
const copy = value => JSON.parse(JSON.stringify(value))
const header = { bookId: 1, supplierId: 2, currency: 'USD', orderDate: '2026-10-30', expectedDate: null, paymentTerms: '', prepayRatio: null, termDays: null }
const row = { id: 1, version: 1, rowNo: 1, groupId: 8, sourceOrderNo: 'NY-051', photo: null, productSpec: 'S', purchaseQty: '1', saleUnitPrice: null, saleTotal: null, purchaseUnitPrice: '53', freight: '29.1', landedUnitCost: null, usdUnitCost: null, usdTotal: null }
const todo = { format: 'FeeTodoV1', todoId: batchId, sourceRowIds: [1], sourceRows: [{ rowId: 1 }], scope: null, amount: null, currency: null, reason: '运费待核对', confirm: false, reviewStatus: 'UNRESOLVED', status: 'PENDING', registeredReference: null }
const group = () => ({ id: 8, version: 1, sourceOrderNo: 'NY-051', header: { ...header }, createStatus: 'DRAFT', verifyStatus: 'NOT_CHECKED', previewToken: null, orderId: null, errors: [], preview: null, feeTodosVersion: 1, sourceBasisHash: 'a'.repeat(64), feeTodos: [copy(todo)], sourceEvidence: [{ rowId: 1, rowNo: 1, currentValues: { ...row } }] })
async function setup(options = {}) {
  const server = { batchId, version: 1, status: 'REVIEW', header: { ...header }, rows: [{ ...row }], groups: options.ungrouped ? [] : [group()] }
  if (options.ungrouped) server.rows[0].groupId = null
  const calls = []
  const api = {
    load: async () => copy(server),
    saveHeader: async (_id, value) => { calls.push('header'); server.header = copy(value); server.version++; server.rows[0].version++; for (const g of server.groups) { g.header = copy(value); g.sourceBasisHash = 'b'.repeat(64) } return copy(server) },
    previews: async () => { calls.push('prepare'); if (!server.groups.length) { server.groups = [group()]; server.rows[0].groupId = 8 } return copy(server) },
    saveFeeTodos: async (_id, g, items) => { calls.push(['fees', g.sourceBasisHash, copy(items)]); if (options.feeFailure?.()) throw new Error('费用保存网络中断'); const target = server.groups.find(item => item.id === g.id); target.feeTodosVersion++; target.feeTodos = items.map(item => ({ ...copy(todo), ...copy(item), reviewStatus: item.confirm ? 'CONFIRMED' : 'UNRESOLVED' })); return copy(target) },
    ...options.api,
  }
  const page = model().createPurchaseImportModel(api, '2026-10-30'); await page.loadBatch(batchId)
  return { page, server, calls }
}
const fill = page => Object.assign(page.fees.entries()[0].items[0], { amount: '29.1', scope: 'ORDER', confirm: true })

test('正式采购单尚未创建也能填写本次费用，缺省币种建议不冒充确认或零金额', async () => {
  const { page } = await setup(), entry = page.fees.entries()[0]
  assert.equal(entry.group.orderId, null); assert.equal(entry.group.docNo, undefined)
  assert.equal(entry.items[0].currency, 'USD'); assert.equal(entry.items[0].amount, null)
  assert.equal(entry.items[0].scope, null); assert.equal(entry.items[0].confirm, false)
  assert.equal(page.fees.dirty(), false)
})

test('已保存费用币种和手动选择不会被采购币种建议覆盖', async () => {
  const { page } = await setup(); page.state.groups[0].feeTodos[0].currency = 'CNY'
  page.fees.reset(); assert.equal(page.fees.entries()[0].items[0].currency, 'CNY')
  page.fees.entries()[0].items[0].currency = 'MXN'; page.state.header.currency = 'EUR'
  assert.equal(page.fees.entries()[0].items[0].currency, 'MXN'); assert.equal(page.fees.dirty(), true)
})

test('读取未修改费用不产生反复草稿写入或渲染更新', async () => {
  const { page } = await setup(); let writes = 0
  const stop = watch(() => page.exportLocalDraft(), () => { writes++ }, { deep: true, flush: 'sync' })
  page.fees.entries(); page.fees.entries(); page.fees.dirty()
  stop(); assert.equal(writes, 0)
})

test('准备费用使用原预览且保留未保存表头，不需要正式订单或有效税务字段', async () => {
  const { page, calls } = await setup({ ungrouped: true }); page.state.header.paymentTerms = '尚未保存的条款'
  assert.equal(await page.fees.prepare(), true); assert.equal(page.state.header.paymentTerms, '尚未保存的条款')
  assert.equal(page.headerDirty(), true); assert.equal(page.fees.entries().length, 1); assert.deepEqual(calls, ['prepare'])
})

test('一次基础保存先保存表头再用最新来源版本保存费用，不建立正式采购单', async () => {
  const { page, calls } = await setup(); fill(page); page.state.header.paymentTerms = '月结'
  assert.equal(await page.fees.save(), true)
  assert.equal(calls[0], 'header'); assert.equal(calls[1][0], 'fees'); assert.equal(calls[1][1], 'b'.repeat(64))
  assert.equal(page.state.groups[0].feeTodos[0].reviewStatus, 'CONFIRMED'); assert.equal(page.fees.dirty(), false)
  assert.equal(page.state.groups[0].orderId, null)
})

test('费用保存失败如实报告部分成功，保留填写内容供重试且不重复保存成功表头', async () => {
  let fail = true
  const { page, calls } = await setup({ feeFailure: () => fail }); fill(page); page.state.header.paymentTerms = '月结'
  assert.equal(await page.fees.save(), false); assert.match(page.state.error, /基础信息已保存.*费用.*网络中断/)
  assert.equal(page.headerDirty(), false); assert.equal(page.fees.entries()[0].items[0].amount, '29.1')
  fail = false; assert.equal(await page.fees.save(), true); assert.equal(calls.filter(c => c === 'header').length, 1)
})

test('来源变化保留已填金额并要求重新确认，不能沿用过期勾选', async () => {
  const { page } = await setup(); fill(page)
  page.state.groups[0].sourceBasisHash = 'c'.repeat(64)
  const entry = page.fees.entries()[0]
  assert.equal(entry.items[0].amount, '29.1'); assert.equal(entry.items[0].confirm, false); assert.equal(entry.stale, true)
})

test('费用草稿随本地草稿恢复，旧快照兼容，清空后不串批次', async () => {
  const { page } = await setup(); fill(page)
  const saved = page.exportLocalDraft(), restored = model().createPurchaseImportModel({}, '2026-10-30')
  restored.restoreLocalDraft(saved); assert.equal(restored.fees.entries()[0].items[0].amount, '29.1'); assert.equal(restored.fees.dirty(), true)
  delete saved.fees; const legacy = model().createPurchaseImportModel({}, '2026-10-30'); legacy.restoreLocalDraft(saved)
  assert.equal(legacy.fees.entries()[0].items[0].amount, null)
  restored.invalidate(); assert.deepEqual(restored.fees.entries(), [])
})

test('已勾确认时具体缺项阻止费用保存，明确零金额可以确认', async () => {
  const { page, calls } = await setup(); page.fees.entries()[0].items[0].confirm = true
  assert.equal(await page.fees.save(), false); assert.match(page.state.error, /费用金额|费用归属/); assert.equal(calls.length, 0)
  Object.assign(page.fees.entries()[0].items[0], { amount: '0', scope: 'ORDER', confirm: true })
  assert.equal(await page.fees.save(), true); assert.equal(page.state.groups[0].feeTodos[0].reviewStatus, 'CONFIRMED')
})

test('保存期间切换批次，旧请求不得继续保存新批次费用', async () => {
  let release
  const { page, calls } = await setup({ api: { saveHeader: () => new Promise(resolve => { release = resolve }) } })
  fill(page); page.state.header.paymentTerms = '月结'; const saving = page.fees.save()
  while (!release) await new Promise(resolve => setImmediate(resolve))
  page.invalidate(); release({ batchId, version: 2, status: 'REVIEW', header, rows: [row], groups: [group()] })
  assert.equal(await saving, false); assert.equal(page.state.batchId, null); assert.equal(calls.length, 0)
})
