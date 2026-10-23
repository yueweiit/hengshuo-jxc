import test from 'node:test'
import assert from 'node:assert/strict'
import { reactive, ref, watch, toRaw, nextTick } from 'vue'
import { loadVueScript } from './contracts/load-vue-script.mjs'

const book = id => ({ id, code: `B${id}`, name: `Book ${id}`, baseCurrency: 'MXN', entityId: 301, status: 'ACTIVE' })
const deferred = () => { let resolve, reject; const promise = new Promise((yes, no) => { resolve = yes; reject = no }); return { promise, resolve, reject } }
const settled = async () => { await nextTick(); await new Promise(resolve => setImmediate(resolve)); await nextTick() }

function salesPage({ defaultBooks = [], warehouseBooks = async () => [] } = {}) {
  const calls = [], posts = [], warnings = [], country = reactive({ currentId: 101, epoch: 1, timezone: 'UTC' }), user = reactive({ token: 'test-session', hasPerm: () => true })
  const page = loadVueScript(new URL('../src/modules/sales/SalesOrderList.vue', import.meta.url), {
    reactive, ref, watch, toRaw, useRoute: () => ({ query: {} }), useRouter: () => ({ push() {} }), useUserStore: () => user, useCountryStore: () => country,
    createCommandIntent: () => ({ reset() {} }), todayIn: () => '2026-10-16',
    ElMessage: { warning: value => warnings.push(value), success() {} },
    APPROVAL_STATUS: [], CUSTOMER_SOURCE: [], FULFILLMENT_STATUS: [], PAYMENT_TYPES: [], PAY_STATUS: [],
    allRecords: async path => path === '/org/warehouses' ? [{ id: 401 }, { id: 402 }] : path === '/md/customers' ? [{ id: 93 }] : [{ productId: 44, baseUnit: 'PCS' }],
    http: {
      get: async (path, params) => { if (path === '/sal/prices/resolve') return { price: 20, priceSource: 'BASE' }; calls.push({ path, params }); assert.equal(path, '/org/books'); return params?.warehouseId ? warehouseBooks(params.warehouseId) : defaultBooks },
      postIdem: async (path, body) => { posts.push({ path, body }); return { id: 1001 } },
    },
  }, ['openCreate', 'books', 'form', 'save'])
  return { ...page, calls, posts, warnings, country, user }
}

test('STORE sales entry loads its warehouse books without requiring a separate BOOK scope', async () => {
  const page = salesPage({ warehouseBooks: async warehouse => warehouse === 401 ? [book(601)] : [] })
  await page.openCreate()
  assert.deepEqual(page.books.value, [])
  page.form.lines[0].warehouseId = 401
  await settled()
  assert.deepEqual(page.calls.map(call => call.params?.warehouseId), [undefined, 401])
  assert.deepEqual(page.books.value.map(row => row.id), [601])
  assert.equal(page.form.bookId, 601)
  assert.deepEqual(page.posts, [])
})

test('selected warehouses use a deduplicated intersection and clear an incompatible book', async () => {
  const page = salesPage({ warehouseBooks: async warehouse => warehouse === 401 ? [book(601), book(602)] : [book(602), book(603)] })
  await page.openCreate()
  page.form.lines[0].warehouseId = 401
  await settled()
  assert.deepEqual(page.books.value.map(row => row.id), [601, 602])
  assert.equal(page.form.bookId, undefined, 'ambiguous candidates require an explicit choice')
  page.form.bookId = 601
  page.form.lines.push({ warehouseId: 401, qty: 1 }, { warehouseId: 402, qty: 1 })
  await settled()
  assert.deepEqual(page.books.value.map(row => row.id), [602])
  assert.equal(page.form.bookId, 602)
  assert.deepEqual(page.calls.slice(2).map(call => call.params.warehouseId), [401, 402])
})

test('warehouse changes remove stale choices and a late old response cannot replace the current candidates', async () => {
  const older = deferred(), newer = deferred()
  const page = salesPage({ defaultBooks: [book(600)], warehouseBooks: warehouse => warehouse === 401 ? older.promise : newer.promise })
  await page.openCreate()
  page.form.bookId = 600
  page.form.lines[0].warehouseId = 401
  await settled()
  assert.equal(page.form.bookId, undefined)
  assert.deepEqual(page.books.value, [])
  page.form.customerId = 93
  await page.save(false)
  assert.deepEqual(page.posts, [], 'pending candidates cannot submit a stale book')
  page.form.lines[0].warehouseId = 402
  await settled()
  newer.resolve([book(602)])
  await settled()
  older.resolve([book(601)])
  await settled()
  assert.deepEqual(page.books.value.map(row => row.id), [602])
  assert.equal(page.form.bookId, 602)
})

test('warehouses with no common book leave no selectable or submittable book', async () => {
  const page = salesPage({ warehouseBooks: async warehouse => [book(warehouse === 401 ? 601 : 602)] })
  await page.openCreate()
  page.form.lines[0].warehouseId = 401
  await settled()
  assert.equal(page.form.bookId, 601)
  page.form.lines.push({ warehouseId: 402, qty: 1 })
  await settled()
  assert.deepEqual(page.books.value, [])
  assert.equal(page.form.bookId, undefined)
  page.form.customerId = 93
  await page.save(false)
  assert.deepEqual(page.posts, [])
})

for (const changed of ['country', 'session']) test(`a ${changed} change discards pending warehouse candidates`, async () => {
  const response = deferred(), page = salesPage({ warehouseBooks: () => response.promise })
  await page.openCreate()
  page.form.lines[0].warehouseId = 401
  await settled()
  assert.equal(page.calls.some(call => call.params?.warehouseId === 401), true)
  if (changed === 'country') { page.country.currentId = 183; page.country.epoch++ } else page.user.token = 'other-test-session'
  response.resolve([book(601)])
  await settled()
  assert.deepEqual(page.books.value, [])
  assert.equal(page.form.bookId, undefined)
})

test('an unavailable warehouse candidate cannot retain or submit a previous book', async () => {
  const page = salesPage({ defaultBooks: [book(600)], warehouseBooks: async () => { throw new Error('warehouse no longer visible') } })
  await page.openCreate()
  page.form.bookId = 600
  page.form.customerId = 93
  page.form.lines[0].productId = 44
  page.form.lines[0].warehouseId = 401
  await settled()
  assert.equal(page.form.bookId, undefined)
  assert.deepEqual(page.books.value, [])
  await page.save(false)
  assert.deepEqual(page.posts, [])
})

test('the existing admin book entry remains available and an explicitly valid choice survives warehouse resolution', async () => {
  const page = salesPage({ defaultBooks: [book(601), book(602)], warehouseBooks: async () => [book(601), book(602)] })
  await page.openCreate()
  assert.deepEqual(page.books.value.map(row => row.id), [601, 602])
  assert.equal(page.form.bookId, undefined)
  page.form.bookId = 602
  page.form.lines[0].warehouseId = 401
  await settled()
  assert.equal(page.calls.some(call => call.params?.warehouseId === 401), true)
  assert.equal(page.form.bookId, 602)
  page.form.customerId = 93
  page.form.lines[0].productId = 44
  await page.save(false)
  assert.equal(page.posts[0].body.bookId, 602)
  assert.equal(page.posts[0].body.lines[0].warehouseId, 401)
  assert.equal(page.posts[0].body.lines[0].qty, 1)
})
