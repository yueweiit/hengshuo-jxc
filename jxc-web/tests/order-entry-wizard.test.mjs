import test from 'node:test'
import assert from 'node:assert/strict'
import { reactive, ref, computed, watch, toRaw, nextTick } from 'vue'
import { loadVueScript } from './contracts/load-vue-script.mjs'

const products = [21, 22, 23].map((productId, index) => ({ productId, id: productId, name: `牛仔裤${index}`, productCode: `TC-${index}`, label: `TC-${index} 牛仔裤${index}`, spec: `M${index}`, categoryId: 4, baseUnit: '条', status: 'ENABLED', units: [{ unit: '条', factorToBase: 1, isPurchaseDefault: true }] }))
const settle = async () => { await nextTick(); await new Promise(resolve => setImmediate(resolve)) }
function setup(kind, { price = async () => ({ price: 20, priceSource: 'BASE' }), post = async () => ({ id: 80, status: 'DRAFT' }), manualPermission = true } = {}) {
  const country = reactive({ currentId: 2, epoch: 0, timezone: 'UTC' }), user = reactive({ token: 'local-test', hasPerm: permission => permission !== 'sal:order:manual-price' || manualPermission })
  const writes = [], warnings = []
  const page = loadVueScript(new URL(`../src/modules/${kind === 'purchase' ? 'purchase/PurchaseOrderForm' : 'sales/SalesOrderList'}.vue`, import.meta.url), {
    reactive, ref, computed, watch, toRaw, nextTick, defineEmits: () => () => {}, defineExpose() {},
    useCountryStore: () => country, useUserStore: () => user, useRoute: () => ({ query: {} }), useRouter: () => ({ push() {} }),
    todayIn: () => '2026-10-23', createCommandIntent: () => ({ reset() {} }),
    ElMessage: { warning: message => warnings.push(message), success() {} }, ElMessageBox: { alert: async () => {} },
    APPROVAL_STATUS: [], CUSTOMER_SOURCE: [], FULFILLMENT_STATUS: [], PAYMENT_TYPES: [], PAY_STATUS: [],
    allRecords: async path => path === '/md/country-skus' ? structuredClone(products) : path === '/md/categories' ? [{ id: 4, name: '牛仔裤' }] : path === '/org/warehouses' ? [{ id: 12, name: '仓库' }] : [{ id: 9, name: '往来单位', settleCurrency: 'CNY', paymentTerms: '' }],
    http: { get: async path => path === '/org/books' ? [{ id: 6, name: '账套', baseCurrency: 'CNY' }] : price(), postIdem: async (path, body) => { writes.push({ path, body: JSON.parse(JSON.stringify(body)) }); return post() } },
  }, kind === 'purchase' ? ['open', 'model', 'entry', 'catalogRows', 'nextEntry', 'backEntry', 'removeEntryLine', 'save', 'visible', 'formRef'] : ['openCreate', 'form', 'entry', 'catalogRows', 'nextEntry', 'backEntry', 'removeEntryLine', 'save', 'resolve'])
  const model = kind === 'purchase' ? page.model : page.form
  const open = kind === 'purchase' ? page.open : page.openCreate
  async function complete() {
    page.entry.quantities[21] = '2'; await page.nextEntry()
    Object.assign(model, { bookId: 6, supplierId: 9, customerId: 9, currency: 'CNY' })
    Object.assign(model.lines[0], { unitPrice: 10, warehouseId: 12 })
    await settle(); await page.nextEntry()
  }
  return { ...page, model, open, complete, writes, warnings, country, user }
}

for (const kind of ['purchase', 'sales']) {
  test(`${kind} catalog quantities select only positive products and preserve values through filters and back`, async () => {
    const p = setup(kind); await p.open()
    assert.equal(p.entry.step, 1)
    Object.assign(p.entry.quantities, { 21: '2', 22: '0', 23: '' })
    p.entry.keyword = 'TC-1'; assert.equal(p.catalogRows().length, 1)
    await p.nextEntry(); assert.equal(p.entry.step, 2)
    assert.deepEqual(p.model.lines.map(line => [line.productId, line.qty]), [[21, 2]])
    Object.assign(p.model.lines[0], { qty: 3, unitPrice: 11 })
    p.backEntry(); assert.equal(p.entry.quantities[21], '3')
    p.entry.keyword = ''; await p.nextEntry()
    assert.equal(p.model.lines[0].unitPrice, 11)
    p.removeEntryLine(0); assert.equal(p.model.lines.length, 0)
    p.backEntry(); assert.equal(p.entry.quantities[21], '')
  })
  test(`${kind} hidden invalid quantity blocks review and blank catalogs cannot advance`, async () => {
    const p = setup(kind); await p.open(); await p.nextEntry(); assert.equal(p.entry.step, 1)
    for (const qty of ['-1', '1.00001', 'abc', 'Infinity']) {
      Object.assign(p.entry.quantities, { 21: qty, 22: '2' }); p.entry.keyword = 'TC-1'
      await p.nextEntry(); assert.equal(p.entry.step, 1); assert.match(p.entry.error, /数量/)
      assert.equal(p.entry.keyword, ''); assert.equal(p.entry.errorProductId, 21)
    }
  })
  test(`${kind} review retains incomplete rows and final save revalidates changed details`, async () => {
    const p = setup(kind); await p.open(); await p.complete(); assert.equal(p.entry.step, 3)
    p.model.lines[0].qty = undefined; await p.save(false)
    assert.equal(p.entry.step, 2); assert.equal(p.model.lines.length, 1); assert.deepEqual(p.writes, [])
  })
  test(`${kind} saves via its existing endpoint and retains input on failure`, async () => {
    const p = setup(kind, { post: async () => { throw new Error('save rejected') } }); await p.open(); await p.complete()
    p.model.remark = '保留备注'
    await assert.rejects(p.save(false), /save rejected/)
    assert.equal(p.model.remark, '保留备注'); assert.equal(p.model.lines[0].qty, 2)
    assert.equal(p.writes.length, 1); assert.equal(p.writes[0].path, kind === 'purchase' ? '/pur/orders' : '/sal/orders')
    assert.equal(p.writes[0].body.lines.length, 1)
  })
  test(`${kind} rapid repeated save sends a single command`, async () => {
    let finish
    const response = new Promise(resolve => { finish = resolve })
    const p = setup(kind, { post: () => response }); await p.open(); await p.complete()
    const first = p.save(false), second = p.save(false); await settle()
    const count = p.writes.length
    finish({ id: 80, status: 'DRAFT' }); await Promise.all([first, second])
    assert.equal(count, 1)
  })
}

test('sales blocks a failed automatic price and unauthorized manual price', async () => {
  const p = setup('sales', { price: async () => { throw Object.assign(new Error('价格服务不可用'), { code: 'NETWORK_ERROR' }) }, manualPermission: false })
  await p.open(); await p.complete(); assert.equal(p.entry.step, 2)
  assert.match(p.entry.error, /价格/); assert.deepEqual(p.writes, [])
  Object.assign(p.model.lines[0], { manual: true, price: 0 }); await p.save(false)
  assert.deepEqual(p.writes, []); assert.match(p.warnings.at(-1), /权限/)
})

test('purchase uses configured units and rejects a prepayment ratio outside 0 to 1', async () => {
  const p = setup('purchase'); await p.open(); await p.complete()
  assert.equal(p.model.lines[0].unit, '条')
  p.model.prepayRatio = 30; await p.save(false)
  assert.deepEqual(p.writes, []); assert.match(p.entry.error, /预付比例/)
})

test('purchase cannot write after its pending form validation crosses country scope', async () => {
  const p = setup('purchase'); await p.open(); await p.complete()
  let finish
  p.formRef.value = { validate: () => new Promise(resolve => { finish = resolve }) }
  const saving = p.save(false); p.country.epoch++; finish(true); await saving
  assert.deepEqual(p.writes, [])
})

test('sales cannot save a review changed while its price validation is pending', async () => {
  let wait = false, finish
  const pending = new Promise(resolve => { finish = resolve })
  const p = setup('sales', { price: () => wait ? pending : Promise.resolve({ price: 20 }) }); await p.open(); await p.complete()
  wait = true; const saving = p.save(false)
  p.model.lines[0].qty = 5; finish({ price: 30 }); await saving
  assert.deepEqual(p.writes, []); assert.equal(p.entry.step, 2)
})
