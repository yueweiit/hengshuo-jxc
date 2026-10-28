import test from 'node:test'
import assert from 'node:assert/strict'
import { loadTsModule } from './contracts/load-ts-module.mjs'
const { createPurchaseImportModel } = loadTsModule(new URL('../src/modules/purchase/purchaseImportModel.ts', import.meta.url))
const batchId = '11111111-2222-4333-8444-555555555555'
function setup(extra = {}, matchResult = null) {
  const row = { id: 1, rowNo: 1, version: 3, sourceOrderNo: 'PO', photo: null, productSpec: 'S', purchaseQty: '1', saleUnitPrice: null, saleTotal: null, purchaseUnitPrice: '53', freight: null, landedUnitCost: null, usdUnitCost: null, usdTotal: null, readiness: 'UNRESOLVED', matchResult }
  const batch = { batchId, header: { bookId: 1, supplierId: 2, currency: 'USD', orderDate: '2026-10-28', expectedDate: null, paymentTerms: '', prepayRatio: '0', termDays: 0 }, rows: [row], version: 3, status: 'REVIEW' }
  return { row, batch, page: createPurchaseImportModel({ async load() { return batch }, ...extra }, '2026-10-28', () => batchId) }
}
test('候选启动失败沿用原请求，成功只登记任务且不自动确认商品', async () => {
  const calls = []
  const { page, batch } = setup({ async startMatches(_id, version, ids, key) { calls.push([version, ids, key]); if (calls.length === 1) throw new Error('连接失败'); return { ...batch, taskIds: [batchId], tasks: [{ id: batchId, kind: 'MATCH', status: 'QUEUED' }] } } })
  await page.loadBatch(batchId)
  assert.equal(await page.startMatches([1]), false)
  assert.equal(await page.startMatches([1]), true)
  assert.deepEqual(calls[0], calls[1]); assert.equal(page.state.rows[0].readiness, 'UNRESOLVED')
})
test('补充文字沿用明细保存并保留11列，不把未知字段变成猜测值', async () => {
  let received
  const { page, row } = setup({ async saveRow(_id, saved, values, matchInputs) { received = { values, matchInputs }; return { ...saved, ...values, ...matchInputs, version: 4, batchVersion: 4 } } })
  await page.loadBatch(batchId)
  assert.equal(await page.saveMatchInputs(row, { suppliedProductCode: ' SKU ', suppliedProductName: '', supplierProductCode: '' }), true)
  assert.equal(received.values.productSpec, 'S'); assert.equal(received.values.purchaseUnitPrice, '53')
  assert.deepEqual(received.matchInputs, { suppliedProductCode: 'SKU', suppliedProductName: null, supplierProductCode: null })
})
test('坏候选响应明确失败并保留原行，过期候选不允许重试解释', async () => {
  let explains = 0
  const { page, batch } = setup({ async load() { return { ...batch, rows: [{ ...batch.rows[0], matchResult: { format: 'MatchRunV1', candidates: [{ productId: 'fake' }] } }] } }, async explain() { explains++ } })
  assert.equal(await page.loadBatch(batchId), false); assert.match(page.state.error, /候选/)
  page.state.batchId = batchId; page.state.rows = [{ ...batch.rows[0], matchResult: { inputRevision: 1 } }]
  assert.equal(await page.explainMatch(page.state.rows[0]), false); assert.equal(explains, 0)
})
