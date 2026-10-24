import test from 'node:test'
import assert from 'node:assert/strict'
import { freshDb, callApi } from './support.mjs'
const { cstOpsHandlers } = await import('../src/mock/handlers/cstOps.ts')

function fixture() {
  const db = freshDb(), productId = db.products[0].id
  db.invBatches.push({ id: 47001, countryId: 1, productId, batchNo: 'SELECT-001' })
  db.inboundCosts.push({ id: 47002, countryId: 1, bookId: 61, batchId: 47001, productId, warehouseId: 401, unitCost: 10, baseCurrency: 'MXN', status: 'CONFIRMED', bizDate: '2026-10-01' })
  db.invBatchBalances.push({ id: 47003, countryId: 1, batchId: 47001, productId, warehouseId: 401, onHandQty: 0, frozenQty: 0 })
  return db
}

test('demo batch selection includes sold-out history and explains the inventory restriction', async () => {
  fixture()
  const inventory = await callApi(cstOpsHandlers, 'GET', '/cst/adjustment-batches?target=INVENTORY&keyword=SELECT-001')
  assert.equal(inventory.status, 200); assert.equal(inventory.data.total, 1); assert.equal(inventory.data.records[0].selectable, false)
  const sold = await callApi(cstOpsHandlers, 'GET', '/cst/adjustment-batches?target=COGS&keyword=SELECT-001')
  assert.equal(sold.data.records[0].selectable, true); assert.equal(sold.data.records[0].baseCurrency, 'MXN')
})

test('demo candidate search keeps missing costs unknown and rejects malformed pagination', async () => {
  const db = fixture(); db.inboundCosts.find(row => row.id === 47002).unitCost = null
  const response = await callApi(cstOpsHandlers, 'GET', '/cst/adjustment-batches?target=COGS&keyword=SELECT-001')
  assert.equal(response.data.records[0].selectable, false); assert.equal(response.data.records[0].unitCost, null)
  const invalid = await callApi(cstOpsHandlers, 'GET', '/cst/adjustment-batches?page=bad')
  assert.equal(invalid.status, 400)
})
