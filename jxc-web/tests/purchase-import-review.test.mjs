import test from 'node:test'
import assert from 'node:assert/strict'
import { loadTsModule } from './contracts/load-ts-module.mjs'

const { createPurchaseImportModel } = loadTsModule(new URL('../src/modules/purchase/purchaseImportModel.ts', import.meta.url))
const batchId = '11111111-2222-4333-8444-555555555555'
function fixture(extra = {}) {
  const header = { bookId: 1, supplierId: 2, currency: 'USD', orderDate: '2026-10-28', expectedDate: null, paymentTerms: '', prepayRatio: '0', termDays: null }
  const row = { id: 1, rowNo: 1, version: 1, sourceOrderNo: 'PO', photo: null, productSpec: 'S', purchaseQty: '10', saleUnitPrice: null, saleTotal: null, purchaseUnitPrice: '53', freight: null, landedUnitCost: null, usdUnitCost: null, usdTotal: null, readiness: 'UNRESOLVED', decision: 'UNRESOLVED' }
  const api = { async load() { return { batchId, header, version: 1, status: 'REVIEW', rows: [row] } }, ...extra }
  return { page: createPurchaseImportModel(api, '2026-10-28'), api }
}
test('人工确认采用服务端真实商品与READY，不依据候选或图片自动确认', async () => {
  const { page } = fixture({ async decide(_batch, row, input) { return { ...row, version: 2, batchVersion: 2, matchedProductId: input.productId, purchaseUnit: input.unit, decision: 'EXISTING', readiness: 'READY' } } })
  await page.loadBatch(batchId)
  assert.equal(await page.decideProduct(page.state.rows[0], { decision: 'EXISTING', productId: 501, unit: 'PCS' }), true)
  assert.equal(page.state.rows[0].readiness, 'READY')
  assert.equal(page.state.rows[0].matchedProductId, 501)
})
test('单位或本国未配置时显示待设置，不能在前端升级为READY', async () => {
  const { page } = fixture({ async decide(_batch, row) { return { ...row, version: 2, batchVersion: 2, readiness: 'NEEDS_SETUP', setupReasons: ['商品尚未在本国启用'] } } })
  await page.loadBatch(batchId)
  await page.decideProduct(page.state.rows[0], { decision: 'EXISTING', productId: 501, unit: 'PCS' })
  assert.equal(page.state.rows[0].readiness, 'NEEDS_SETUP')
  assert.match(page.state.rows[0].setupReasons[0], /本国/)
})
test('新品部分成功保留真实ID与版本，重试沿用原请求', async () => {
  const calls = []
  const body = { version: 1, confirmNew: true, product: { productCode: 'N1', name: '新品', baseUnit: 'PCS', spec: 'S' }, unit: 'PCS' }
  const { page } = fixture({ async createProduct(_batch, row, request, key) { calls.push([structuredClone(request), key]); if (calls.length === 1) throw Object.assign(new Error('缺本国经营权限'), { data: { partialResult: { productId: 909, rowId: 1, rowVersion: 2, readiness: 'NEEDS_SETUP', requestId: key } } }); return { ...row, version: 3, matchedProductId: 909, readiness: 'READY' } } })
  await page.loadBatch(batchId)
  assert.equal(await page.createProduct(page.state.rows[0], body, batchId), false)
  assert.equal(page.state.rows[0].matchedProductId, 909)
  assert.equal(page.state.rows[0].version, 2)
  assert.equal(page.state.rows[0].readiness, 'NEEDS_SETUP')
  assert.equal(await page.createProduct(page.state.rows[0], body, batchId), true)
  assert.deepEqual(calls[0], calls[1])
})
test('商品确认失败保留原行并拒绝错误编号响应', async () => {
  const { page } = fixture({ async decide(_batch, row) { return { ...row, id: 2, version: 2, readiness: 'READY' } } })
  await page.loadBatch(batchId)
  assert.equal(await page.decideProduct(page.state.rows[0], { decision: 'DEFERRED' }), false)
  assert.equal(page.state.rows[0].readiness, 'UNRESOLVED')
  assert.match(page.state.error, /确认/)
})
