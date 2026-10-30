import test from 'node:test'
import assert from 'node:assert/strict'
import { freshDb, callApi } from './support.mjs'
const { lgsHandlers } = await import('../src/mock/handlers/lgs.ts')

test('demo adapter returns the same unit-aware board and paging contract used by the real page', async () => {
  const db = freshDb(), warehouse = db.warehouses.find(w => w.countryId === 1), product = db.products[0]
  db.shipments = [{ id: 7001, countryId: 1, bookId: db.books.find(b => b.countryId === 1).id, entityId: warehouse.entityId,
    destWarehouseId: warehouse.id, docNo: 'TEST-TRANSIT', status: 'IN_TRANSIT', actualEtd: '2026-10-01T00:00:00Z',
    lines: [{ id: 7101, productId: product.id, intlQty: 4, pendingDeliveryQty: 0, onHoldQty: 0, deliveringQty: 0 }],
  }]
  const response = await callApi(lgsHandlers, 'GET', '/lgs/in-transit?size=1')
  assert.equal(response.code, 'OK')
  assert.equal(response.data.size, 1)
  assert.equal(response.data.summary[0].unit, product.baseUnit)
  assert.equal(response.data.summary[0].totalQty, 4)
  assert.equal(response.data.records[0].shipments.length, 1)
})

test('demo delay view returns an explicit rule and never substitutes grouped quantities for delays', async () => {
  freshDb()
  const response = await callApi(lgsHandlers, 'GET', '/lgs/in-transit?view=delays')
  assert.equal(response.code, 'OK')
  assert.equal(response.data.rule.status, 'ACTIVE')
  assert.deepEqual(response.data.records, [])
})
