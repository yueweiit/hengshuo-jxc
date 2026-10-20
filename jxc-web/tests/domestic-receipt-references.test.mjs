import test from 'node:test'
import assert from 'node:assert/strict'
import { computed, reactive, ref } from 'vue'
import { loadVueScript } from './contracts/load-vue-script.mjs'

const deferred = () => { let resolve; const promise = new Promise(yes => { resolve = yes }); return { promise, resolve } }
const progress = (id, pending = 100) => ({ order: { id, supplierId: 801, supplierName: 'Local supplier', lines: [{ id: id * 10, lineNo: 1, productCode: 'SKU-A', productName: 'Native product', undeliveredQty: pending }] }, receipts: [] })
function receiptPage(get) {
  const calls = [], posts = [], warnings = [], country = reactive({ currentId: 101, epoch: 1, timezone: 'UTC' }), user = reactive({ token: 'receipt-session' })
  const page = loadVueScript(new URL('../src/modules/purchase/DomesticReceiptList.vue', import.meta.url), {
    computed, reactive, ref, useRoute: () => ({ query: {} }), useUserStore: () => user, useCountryStore: () => country,
    DOC_STATUS: [], todayIn: () => '2026-10-16', createCommandIntent: () => ({ reset() {} }),
    ElMessage: { warning: message => warnings.push(message), success() {} },
    allRecords: async () => [{ id: 592, docNo: 'PO-1', supplierId: 801, status: 'CONFIRMED' }],
    http: { get: async path => { calls.push(path); const value = await get(path); return path.endsWith('/progress') || !value.order ? value : { ...value.order, lines: value.order.lines.map(({ productCode, productName, undeliveredQty, ...line }) => line) } }, postIdem: async (path, body) => { posts.push({ path, body: JSON.parse(JSON.stringify(body)) }); return { id: 1001 } } },
  }, ['edit', 'orders', 'openCreate', 'openEdit', 'onOrderChange', 'orderLabel', 'save'])
  return { ...page, calls, posts, warnings, country, user }
}

test('domestic receipt references use the existing owner progress order and preserve all three native quantities', async () => {
  const page = receiptPage(async path => path.endsWith('/progress') ? progress(592) : { id: 592, lines: [{ id: 5920, lineNo: 1 }] })
  await page.openCreate()
  page.edit.orderId = 592
  await page.onOrderChange()
  assert.equal(page.edit.lines[0].productCode, 'SKU-A')
  assert.equal(page.edit.lines[0].undeliveredQty, 100)
  assert.equal(page.orders.value[0].supplierName, 'Local supplier')
  Object.assign(page.edit, { location: 'Synthetic collection point', remark: 'UI-only native receipt' })
  Object.assign(page.edit.lines[0], { qualifiedQty: 70, pendingInspectQty: 10, damagedQty: 5 })
  await page.save(true)
  assert.equal(page.posts[0].body.orderId, 592)
  assert.equal(page.posts[0].body.receiptDate, '2026-10-16')
  assert.equal(page.posts[0].body.location, 'Synthetic collection point')
  assert.equal(page.posts[0].body.remark, 'UI-only native receipt')
  assert.equal(page.posts[0].body.confirm, true)
  assert.equal(page.posts[0].body.lines[0].orderLineId, 5920)
  assert.equal(page.posts[0].body.lines[0].qualifiedQty, 70)
  assert.equal(page.posts[0].body.lines[0].pendingInspectQty, 10)
  assert.equal(page.posts[0].body.lines[0].damagedQty, 5)
  assert.deepEqual(page.calls, ['/pur/orders/592/progress'])
})

test('a late old order projection cannot replace the currently selected order or its native remaining quantity', async () => {
  const older = deferred(), page = receiptPage(path => path.includes('/592') ? older.promise : Promise.resolve(progress(593, 20)))
  page.edit.orderId = 592
  page.edit.lines = [{ orderLineId: 100, qualifiedQty: 1, pendingInspectQty: 0, damagedQty: 0 }]
  const first = page.onOrderChange()
  assert.deepEqual(page.edit.lines, [])
  await page.save(false)
  assert.deepEqual(page.posts, [], 'a loading source cannot submit stale lines')
  page.edit.orderId = 593
  await page.onOrderChange()
  older.resolve(progress(592, 100))
  await first
  assert.equal(page.edit.lines[0].orderLineId, 5930)
  assert.equal(page.edit.lines[0].undeliveredQty, 20)
})

test('raw order options retain an explicit supplier identifier until the owner label is loaded', async () => {
  const page = receiptPage(async () => progress(592))
  await page.openCreate()
  assert.equal(page.orderLabel(page.orders.value[0]), 'PO-1 · 供应商 #801')
  page.edit.orderId = 592
  await page.onOrderChange()
  assert.equal(page.orderLabel(page.orders.value[0]), 'PO-1 · Local supplier')
})

for (const changed of ['country', 'session']) test(`a ${changed} change discards a pending domestic receipt source`, async () => {
  const response = deferred(), page = receiptPage(() => response.promise)
  page.edit.orderId = 592
  const pending = page.onOrderChange()
  if (changed === 'country') { page.country.currentId = 183; page.country.epoch++ } else page.user.token = 'other-session'
  response.resolve(progress(592))
  await pending
  assert.deepEqual(page.edit.lines, [])
})

test('editing a draft keeps its original good, pending and damaged inputs after native reference enrichment', async () => {
  const page = receiptPage(async () => progress(592, 100))
  await page.openEdit({ id: 701, version: 4, orderId: 592, receiptDate: '2026-10-15', location: 'Existing location', remark: 'Existing remark', lines: [{ orderLineId: 5920, qualifiedQty: 70, pendingInspectQty: 10, damagedQty: 5 }] })
  assert.deepEqual(page.edit.lines.map(row => [row.productCode, row.undeliveredQty, row.qualifiedQty, row.pendingInspectQty, row.damagedQty]), [['SKU-A', 100, 70, 10, 5]])
  assert.equal(page.edit.id, 701)
  assert.equal(page.edit.version, 4)
  assert.equal(page.edit.receiptDate, '2026-10-15')
})
