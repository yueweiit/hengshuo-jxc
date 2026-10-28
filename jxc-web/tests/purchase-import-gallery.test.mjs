import test from 'node:test'
import assert from 'node:assert/strict'
import { loadTsModule } from './contracts/load-ts-module.mjs'
const { createPurchaseImportModel } = loadTsModule(new URL('../src/modules/purchase/purchaseImportModel.ts', import.meta.url))
const batchId = '11111111-2222-4333-8444-555555555555'
function setup(extra) {
  const row = { id: 1, rowNo: 1, version: 3, sourceOrderNo: 'PO', photo: null, productSpec: 'S', purchaseQty: '1', saleUnitPrice: null, saleTotal: null, purchaseUnitPrice: '53', freight: null, landedUnitCost: null, usdUnitCost: null, usdTotal: null, matchedProductId: 501, readiness: 'READY', images: [{ id: 9, sha256: 'a'.repeat(64), status: 'CONFIRMED' }] }
  const batch = { batchId, header: { bookId: 1, supplierId: 2, currency: 'USD', orderDate: '2026-10-28', expectedDate: null, paymentTerms: '', prepayRatio: '0', termDays: 0 }, rows: [row], version: 3, status: 'REVIEW' }
  return { row, page: createPurchaseImportModel({ async load() { return batch }, ...extra }, '2026-10-28', () => batchId) }
}
test('明确发布照片失败仍保留READY，重试沿用原请求编号', async () => {
  const calls = []
  const { row, page } = setup({ async publishPhotos(_id, _row, ids, key) { calls.push([ids, key]); throw new Error('照片服务不可用') } })
  await page.loadBatch(batchId)
  await page.publishPhotos(row, [9]); await page.publishPhotos(row, [9])
  assert.deepEqual(calls[0], [[9], batchId]); assert.deepEqual(calls[0], calls[1])
  assert.equal(page.state.rows[0].readiness, 'READY'); assert.match(page.state.error, /照片服务不可用/)
})
test('只重试图库阶段不会让整个批次重新进入文件解析', async () => {
  const { page } = setup({ async retryTask(id) { return { id, status: 'QUEUED' } } })
  await page.loadBatch(batchId)
  const task = { id: batchId, kind: 'IMAGE_PUBLISH', phase: 'INDEX', status: 'FAILED' }
  page.state.tasks.push(task)
  await page.retryTask(task)
  assert.equal(page.state.status, 'REVIEW'); assert.equal(page.state.tasks[0].status, 'QUEUED')
})
test('图库读取失败明确报错，不能伪装成空图库', async () => {
  const { page } = setup({ async gallery() { throw new Error('图库权限读取失败') } })
  await page.loadBatch(batchId)
  assert.equal(await page.loadGallery(), false)
  assert.equal(page.state.gallery, null); assert.match(page.state.galleryError, /权限读取失败/)
  assert.equal(page.state.rows.length, 1)
})
