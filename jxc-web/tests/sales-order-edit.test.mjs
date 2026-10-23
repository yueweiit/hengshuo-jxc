import test from 'node:test'
import assert from 'node:assert/strict'
import { reactive, ref, watch, toRaw, nextTick } from 'vue'
import { loadVueScript } from './contracts/load-vue-script.mjs'

const deferred = () => { let resolve; const promise = new Promise(yes => { resolve = yes }); return { promise, resolve } }
const settle = async () => { await nextTick(); await new Promise(resolve => setImmediate(resolve)) }
const original = () => ({ id: 77, version: 9, bookId: 6, orderDate: '2026-10-01', customerId: 93, paymentType: 'CREDIT', remark: 'before', totalQty: 20, approvalStatus: 'APPROVED', fulfillmentStatus: 'PENDING_OUTBOUND', deliveryDate: '2026-11-01', shipAddress: { city: 'MX' }, lines: [{ id: 78, productId: 44, qty: 2, unit: 'BOX', factor: 10, price: 19.73, stdPrice: 20, manualPriceFlag: true, priceSource: 'MANUAL', priceRefId: 88, priceVersionNo: 1, discountAmount: 1, taxRate: 16, outboundQty: 0, cancelledQty: 0, allocs: [{ id: 79, warehouseId: 12, allocQty: 12 }, { id: 80, warehouseId: 151, allocQty: 8 }] }] })
function setup({ order = original(), getOrder = async () => order, price = async () => ({ price: 99, priceSource: 'BASE' }), put = async () => ({ id: 77 }), post = async () => ({ id: 100 }) } = {}) {
  const country = reactive({ currentId: 3, epoch: 1, timezone: 'America/Mexico_City' }), user = reactive({ token: 'owner', hasPerm: () => true })
  const puts = [], posts = [], prices = [], warnings = [], pushes = []
  const api = loadVueScript(new URL('../src/modules/sales/SalesOrderList.vue', import.meta.url), {
    reactive, ref, watch, toRaw, useRoute: () => reactive({ query: {} }), useRouter: () => ({ push: value => pushes.push(value) }),
    useCountryStore: () => country, useUserStore: () => user, todayIn: () => '2026-10-16', createCommandIntent: () => ({ reset() {} }),
    ElMessage: { warning: message => warnings.push(message), success() {} }, APPROVAL_STATUS: [], CUSTOMER_SOURCE: [], FULFILLMENT_STATUS: [], PAYMENT_TYPES: [], PAY_STATUS: [],
    allRecords: async path => path === '/md/customers' ? [{ id: 93 }, { id: 94 }] : path === '/md/country-skus' ? [{ productId: 44, baseUnit: 'PCS' }] : [{ id: 12 }, { id: 151 }],
    http: {
      get: async (path, params) => { if (path === '/org/books') return [{ id: 6, name: 'MX' }]; if (path === '/sal/prices/resolve') { prices.push(params); return price(params) } return getOrder(path) },
      put: async (path, body) => { puts.push({ path, body: structuredClone(body) }); return put(path, body) },
      postIdem: async (...args) => { posts.push(args); return post(...args) },
    },
  }, ['form', 'books', 'openCreate', 'openEdit', 'save', 'resolve'])
  return { ...api, country, user, puts, posts, prices, warnings, pushes }
}

test('header edit uses native versioned PUT and preserves original business fields and price snapshots', async () => {
  const p = setup(); await p.openEdit(77)
  assert.equal(p.form.lines[0].unit, 'BOX'); assert.equal(p.form.lines[0].price, 19.73)
  assert.deepEqual(p.form.lines[0].allocs.map(a => a.id), [79, 80]); assert.deepEqual(p.prices, [])
  p.form.remark = 'after'; await p.save(false)
  assert.deepEqual(p.puts, [{ path: '/sal/orders/77', body: { version: 9, bizDate: '2026-10-16', remark: 'after' } }])
  assert.deepEqual(p.posts, []); assert.deepEqual(p.pushes, ['/sales/orders/77'])
})

test('saving an unchanged approved order does not invalidate approval or release its reservations', async () => {
  const p = setup(); await p.openEdit(77); await p.save(false)
  assert.deepEqual(p.puts, []); assert.deepEqual(p.posts, [])
  assert.equal(p.form.visible, true); assert.match(p.warnings[0], /没有变化/)
})

test('quantity edit retains BOX and both allocation identities, leaving price and tax to native snapshot rules', async () => {
  const p = setup(); await p.openEdit(77)
  p.form.lines[0].qty = 3; p.form.lines[0].allocs[1].allocQty = 18
  await p.resolve(p.form.lines[0]); assert.deepEqual(p.prices, [], 'same customer/SKU/unit uses original frozen price')
  await p.save(false)
  assert.deepEqual(p.puts[0].body.lines, [{ id: 78, productId: 44, unit: 'BOX', qty: 3, allocs: [{ id: 79, warehouseId: 12, allocQty: 12 }, { id: 80, warehouseId: 151, allocQty: 18 }] }])
  assert.equal('price' in p.puts[0].body.lines[0], false)
  assert.equal('taxRate' in p.puts[0].body.lines[0], false)
})

test('manual change is explicit; unchanged manual snapshot is never silently reset', async () => {
  const p = setup(); await p.openEdit(77)
  p.form.lines[0].manual = true; p.form.lines[0].price = 18.25; await p.save(false)
  assert.equal(p.puts[0].body.lines[0].price, 18.25)
  assert.equal(p.puts[0].body.lines[0].manualPriceFlag, true)
})

for (const operation of ['create', 'edit']) for (const price of [undefined, null]) test(`manual ${operation} rejects unknown price ${String(price)} without writing or submitting`, async () => {
  const p = setup()
  if (operation === 'edit') await p.openEdit(77)
  else { await p.openCreate(); p.form.customerId = 93; p.form.lines[0].productId = 44; p.form.lines[0].warehouseId = 12; await settle() }
  p.form.lines[0].manual = true; p.form.lines[0].price = price
  await p.save(true)
  assert.deepEqual(p.puts, []); assert.deepEqual(p.posts, [])
  assert.equal(p.form.visible, true); assert.match(p.warnings[0], /人工成交价/)
})

for (const operation of ['create', 'edit']) test(`manual ${operation} preserves an explicitly entered zero price`, async () => {
  const p = setup()
  if (operation === 'edit') await p.openEdit(77)
  else { await p.openCreate(); p.form.customerId = 93; p.form.lines[0].productId = 44; p.form.lines[0].warehouseId = 12; await settle() }
  p.form.lines[0].manual = true; p.form.lines[0].price = 0
  await p.save(false)
  const body = operation === 'edit' ? p.puts[0].body : p.posts[0][1]
  assert.equal(body.lines[0].price, 0); assert.equal(body.lines[0].manualPriceFlag, true)
  assert.deepEqual(p.warnings, [])
})

for (const invalid of [{ totalQty: null }, { approvalStatus: 'PENDING' }, { fulfillmentStatus: 'CLOSED' }]) test(`original unavailable/immutable order cannot open editor: ${JSON.stringify(invalid)}`, async () => {
  const p = setup({ order: { ...original(), ...invalid } }); await p.openEdit(77)
  assert.equal(p.form.visible, false); assert.deepEqual(p.puts, []); assert.ok(p.warnings.length)
})

for (const change of ['country', 'session']) test(`late editor response and save cannot cross ${change}`, async () => {
  const old = deferred(), p = setup({ getOrder: () => old.promise }); const loading = p.openEdit(77)
  if (change === 'country') { p.country.currentId = 183; p.country.epoch++ } else p.user.token = 'replacement'
  old.resolve(original()); await loading; assert.equal(p.form.visible, false)
  const q = setup(); await q.openEdit(77)
  if (change === 'country') { q.country.currentId = 183; q.country.epoch++ } else q.user.token = 'replacement'
  q.form.remark = 'late'; await q.save(false); assert.deepEqual(q.puts, [])
})

test('version conflict retains original version and user input without an automatic retry or submit', async () => {
  const p = setup({ put: async () => { throw new Error('VERSION_CONFLICT') } }); await p.openEdit(77); p.form.remark = 'retained'
  await assert.rejects(p.save(false), /VERSION_CONFLICT/)
  assert.equal(p.form.visible, true); assert.equal(p.form.version, 9); assert.equal(p.form.remark, 'retained')
  assert.equal(p.puts.length, 1); assert.deepEqual(p.posts, [])
})

test('price resolution pins original order date and rejects a slower old customer result', async () => {
  const first = deferred(), p = setup({ price: params => params.customerId === 94 ? first.promise : Promise.resolve({ price: 25, priceSource: 'CUSTOMER' }) })
  await p.openEdit(77); p.form.customerId = 94
  const slow = p.resolve(p.form.lines[0], true); p.form.customerId = 95; await p.resolve(p.form.lines[0], true)
  first.resolve({ price: 99, priceSource: 'BASE' }); await slow; await settle()
  assert.equal(p.form.lines[0].price, 25); assert.equal(p.prices[0].date, '2026-10-01'); assert.equal(p.prices[0].unit, 'BOX')
})

test('changing back to the original customer restores the frozen manual price instead of previewing a new current price', async () => {
  const p = setup(); await p.openEdit(77); p.form.customerId = 94; await p.resolve(p.form.lines[0], true)
  assert.equal(p.form.lines[0].price, 99)
  p.form.customerId = 93; await p.resolve(p.form.lines[0], true)
  assert.equal(p.form.lines[0].price, 19.73); assert.equal(p.form.lines[0].priceSource, 'MANUAL')
  assert.equal(p.prices.length, 1); await p.save(false); assert.deepEqual(p.puts, [])
})


test('a slow saved edit cannot close, redirect, or clear the saving state of another editor', async () => {
  const first = deferred(), second = deferred()
  const p = setup({
    getOrder: async path => ({ ...original(), id: Number(path.split('/').at(-1)) }),
    put: path => path.endsWith('/77') ? first.promise : second.promise,
  })
  await p.openEdit(77); p.form.remark = 'first authorized change'
  const savingFirst = p.save(false)
  p.form.visible = false
  await p.openEdit(88)
  assert.equal(p.form.saving, false, 'a new editor owns its own operation state')
  p.form.remark = 'second authorized change'
  const savingSecond = p.save(false)
  assert.equal(p.puts.length, 2)
  first.resolve({ id: 77 }); await savingFirst
  assert.equal(p.form.visible, true); assert.equal(p.form.editingId, 88)
  assert.equal(p.form.remark, 'second authorized change'); assert.equal(p.form.saving, true)
  assert.deepEqual(p.pushes, [])
  second.resolve({ id: 88 }); await savingSecond
  assert.equal(p.form.saving, false); assert.deepEqual(p.pushes, ['/sales/orders/88'])
})

test('a cancelled editor stays closed without navigation when its authorized write completes', async () => {
  const write = deferred(), p = setup({ put: () => write.promise })
  await p.openEdit(77); p.form.remark = 'saved before cancellation'
  const saving = p.save(false); p.form.visible = false
  write.resolve({ id: 77 }); await saving
  assert.equal(p.puts.length, 1); assert.equal(p.form.visible, false)
  assert.equal(p.form.saving, false); assert.deepEqual(p.pushes, [])
})

test('late create completion cannot close a new editor in the same country and session', async () => {
  const write = deferred(), p = setup({ post: () => write.promise })
  await p.openCreate(); p.form.customerId = 93
  Object.assign(p.form.lines[0], { productId: 44, warehouseId: 12 }); await settle()
  const saving = p.save(false)
  await settle()
  assert.equal(p.posts.length, 1)
  p.form.visible = false; await p.openEdit(77); p.form.remark = 'preserve new input'
  write.resolve({ id: 100 }); await saving
  assert.equal(p.form.visible, true); assert.equal(p.form.editingId, 77)
  assert.equal(p.form.remark, 'preserve new input'); assert.deepEqual(p.pushes, [])
})
