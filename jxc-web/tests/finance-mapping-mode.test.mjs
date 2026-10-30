import test from 'node:test'
import assert from 'node:assert/strict'
import * as vue from 'vue'
import { loadVueScript } from './contracts/load-vue-script.mjs'

const deferred = () => {
  let resolve, reject
  const promise = new Promise((ok, fail) => { resolve = ok; reject = fail })
  return { promise, resolve, reject }
}

function mappingPage(overrides = {}) {
  return loadVueScript(new URL('../src/modules/finance/MappingList.vue', import.meta.url), {
    ref: vue.ref, computed: vue.computed, onMounted() {},
    createCommandIntent: () => ({}), allRecords: async () => [],
    http: {}, ElMessage: { error() {} }, ElMessageBox: { confirm: async () => {} },
    getToken: () => 'token', getCountryId: () => 1,
    ...overrides,
  }, ['rows', 'books', 'bookId', 'events', 'cashflows', 'loading', 'loadError', 'booksLoading', 'booksError',
    'initialize', 'load', 'edit', 'editor', 'form', 'save', 'saving', 'saveError', 'review', 'remove', 'actionError',
    'selectTemplate', 'simulationTemplate', 'eventId', 'sim', 'simulating', 'simError', 'simulate', 'clearSimulation', 'bookCurrency', 'amountFields'])
}

test('mapping reads distinguish failure from empty data and a retry restores the selected book', async () => {
  let fails = true
  let failure = new Error('没有当前账套的读取权限')
  const page = mappingPage({ allRecords: async path => {
    if (fails && path === '/fin/mapping-templates') throw failure
    return path === '/fin/mapping-templates' ? [{ id: 10 }] : []
  } })
  page.bookId.value = 194
  await page.load()
  assert.match(page.loadError.value, /没有当前账套的读取权限/)
  assert.equal(page.loading.value, false)
  assert.deepEqual(page.rows.value, [])
  failure = new Error('')
  await page.load()
  assert.ok(page.loadError.value, '缺少错误详情时也必须显示读取失败')
  fails = false
  await page.load()
  assert.equal(page.loadError.value, '')
  assert.equal(page.rows.value[0].id, 10)
  page.bookId.value = undefined
  await page.load()
  assert.deepEqual(page.rows.value, [])
  assert.equal(page.loadError.value, '')
})

test('book switching immediately clears editor and simulation and discards obsolete read responses', async () => {
  const old = deferred()
  const page = mappingPage({ allRecords: async (path, { bookId }) => bookId === 194 ? old.promise : [{ id: 20, path }] })
  page.bookId.value = 194
  const first = page.load()
  page.edit()
  page.selectTemplate({ id: 10, eventType: 'TEST', bookId: 194 })
  page.sim.value = { lines: [{ accountCode: 'old' }] }
  page.actionError.value = '旧账套的操作失败'
  page.bookId.value = 195
  const next = page.load()
  assert.equal(page.editor.value, false)
  assert.equal(page.sim.value, null)
  assert.equal(page.simulationTemplate.value, null)
  assert.equal(page.actionError.value, '')
  assert.deepEqual(page.rows.value, [])
  await next
  old.resolve([{ id: 10 }])
  await first
  assert.equal(page.rows.value[0].id, 20)
  assert.equal(page.events.value[0].id, 20)
  assert.equal(page.cashflows.value[0].id, 20)
})

test('a late failed book read cannot replace a newer successful read with an error', async () => {
  const old = deferred()
  const page = mappingPage({ allRecords: async (_path, { bookId }) => bookId === 194 ? old.promise : [] })
  page.bookId.value = 194
  const first = page.load()
  page.bookId.value = 195
  await page.load()
  old.reject(new Error('旧账套请求失败'))
  await first
  assert.equal(page.loadError.value, '')
  assert.equal(page.loading.value, false)
})

test('book initialization can retry and never guesses a book or its base currency', async () => {
  let fails = true
  const page = mappingPage({ http: { get: async () => {
    if (fails) throw new Error('账套服务超时')
    return [{ id: 194, status: 'ACTIVE', baseCurrency: 'JPY' }, { id: 195, status: 'ACTIVE' }]
  } } })
  await page.initialize()
  assert.match(page.booksError.value, /账套服务超时/)
  assert.equal(page.booksLoading.value, false)
  fails = false
  await page.initialize()
  assert.equal(page.booksError.value, '')
  assert.equal(page.bookId.value, undefined)
  page.bookId.value = 194
  assert.equal(page.bookCurrency.value, 'JPY')
  page.bookId.value = 195
  assert.equal(page.bookCurrency.value, undefined)
})

test('changing a simulation selection clears results and ignores an in-flight result for the previous event', async () => {
  const pending = deferred()
  let requests = 0
  const page = mappingPage({ http: { post: async () => { requests++; return pending.promise } } })
  page.bookId.value = 194
  page.selectTemplate({ id: 10, bookId: 194, eventType: 'TEST' })
  page.eventId.value = 21
  const first = page.simulate()
  await page.simulate()
  assert.equal(requests, 1)
  page.eventId.value = 22
  page.clearSimulation()
  pending.resolve({ sourceNo: 'OLD', lines: [] })
  await first
  assert.equal(page.sim.value, null)
  assert.equal(page.simulating.value, false)
})

test('a failed simulation removes old results and supports retry with the exact selected event', async () => {
  const requests = []
  let fails = true
  const page = mappingPage({ http: { post: async (path, body) => {
    requests.push({ path, body })
    if (fails) throw new Error('来源金额不可读取')
    return { accountingMode: 'NO_VOUCHER', sourceNo: 'SRC001', lines: [], saved: false }
  } } })
  page.bookId.value = 194
  page.selectTemplate({ id: 10, bookId: 194, eventType: 'TEST' })
  page.eventId.value = 21
  page.sim.value = { lines: [{ debit: 1 }] }
  await page.simulate()
  assert.equal(page.sim.value, null)
  assert.match(page.simError.value, /来源金额不可读取/)
  fails = false
  await page.simulate()
  assert.equal(page.sim.value.saved, false)
  assert.equal(page.simError.value, '')
  assert.equal(requests[1].path, '/fin/mapping-templates/10/simulate?eventId=21')
  assert.deepEqual(requests[1].body, {})
})

test('saving a draft blocks duplicate clicks, retains input on failure, and retries the original version', async () => {
  const pending = deferred()
  const sent = []
  const page = mappingPage({ http: { putIdem: async (path, body) => {
    sent.push({ path, body })
    if (sent.length === 1) return pending.promise
    return {}
  } } })
  page.bookId.value = 194
  page.edit({ id: 10, bookId: 194, version: 3, eventType: 'TEST', accountingMode: 'NO_VOUCHER', noVoucherReason: '原规则', lines: [] })
  page.form.value.noVoucherReason = '已核对规则'
  const first = page.save()
  await page.save()
  assert.equal(sent.length, 1)
  assert.equal(page.saving.value, true)
  pending.reject(new Error('版本冲突，请重新核对'))
  await first
  assert.equal(page.editor.value, true)
  assert.equal(page.form.value.noVoucherReason, '已核对规则')
  assert.match(page.saveError.value, /版本冲突/)
  assert.equal(page.saving.value, false)
  await page.save()
  assert.equal(sent[1].path, '/fin/mapping-templates/10')
  assert.equal(sent[1].body.version, 3)
  assert.equal(page.editor.value, false)
})

test('auxiliary mapping rejects valid JSON that is not an object without sending a save', async () => {
  let writes = 0
  const page = mappingPage({ http: { postIdem: async () => { writes++; return {} } } })
  page.bookId.value = 194
  page.edit()
  for (const json of ['null', '[]', '1', '{invalid']) {
    page.form.value.lines[0].auxJson = json
    await page.save()
    assert.match(page.saveError.value, /JSON 对象/)
    assert.equal(page.editor.value, true)
  }
  assert.equal(writes, 0)
})

test('review uses the original version and blocks duplicate mutations until refresh completes', async () => {
  const pending = deferred()
  const sent = []
  const page = mappingPage({ http: { postIdem: async (path, body) => { sent.push({ path, body }); return pending.promise } } })
  page.bookId.value = 194
  const row = { id: 10, version: 3 }
  const first = page.review(row)
  await page.review(row)
  assert.equal(sent.length, 1)
  assert.deepEqual(sent[0], { path: '/fin/mapping-templates/10/review', body: { version: 3 } })
  pending.reject(new Error('没有复核权限'))
  await first
  assert.match(page.actionError.value, /没有复核权限/)
})

test('deletion cancellation performs no write and confirmed deletion retains its idempotency scope', async () => {
  let cancel = true
  const sent = []
  const page = mappingPage({
    ElMessageBox: { confirm: async () => { if (cancel) throw 'cancel' } },
    createCommandIntent: () => ({ run: async (scope, route, body, call) => { sent.push({ scope, route, body }); return call('idem-1') } }),
    http: { delete: async (path, options) => { sent.push({ path, options }); return {} } },
  })
  page.bookId.value = 194
  await page.remove({ id: 10, version: 3 })
  assert.equal(sent.length, 0)
  assert.equal(page.actionError.value, '')
  cancel = false
  await page.remove({ id: 10, version: 3 })
  assert.deepEqual(sent[0], { scope: 'token:1', route: 'DELETE /fin/mapping-templates/10', body: { version: 3, bookId: 194 } })
  assert.deepEqual(sent[1].options, { params: { version: 3, bookId: 194 }, headers: { 'Idempotency-Key': 'idem-1' } })
})

test('a copied no-voucher mapping becomes a voucher draft without retaining the old reason or mutating the active version', async () => {
  const calls = []
  const page = mappingPage({
    http: { postIdem: async (path, body) => { calls.push({ path, body }); return {} } },
    ElMessage: { error(message) { throw new Error(message) } },
  })
  page.bookId.value = 194
  const active = { id: 601, bookId: 194, eventType: 'CST_INBOUND_COST_CONFIRMED', version: 2, versionNo: 1, status: 'ACTIVE', accountingMode: 'NO_VOUCHER', noVoucherReason: 'Opening source is already in the independent GL opening.', lines: [] }
  page.edit(active, true)
  page.form.value.accountingMode = 'VOUCHER'
  page.form.value.lines = [
    { direction: 'DEBIT', accountRule: { type: 'FIXED', code: '1405' }, amountExpr: 'amount', auxJson: '{}', summary: 'Purchase cost', cashflowItemId: null },
    { direction: 'CREDIT', accountRule: { type: 'FIXED', code: '2202' }, amountExpr: 'apAmount', auxJson: '{"PARTNER":"partnerId"}', summary: 'Payable source', cashflowItemId: null },
  ]
  await page.save()
  assert.equal(calls[0].path, '/fin/mapping-templates')
  assert.equal(calls[0].body.accountingMode, 'VOUCHER')
  assert.equal(calls[0].body.noVoucherReason, null)
  assert.equal(calls[0].body.lines[1].auxMapping.PARTNER, 'partnerId')
  assert.equal(active.status, 'ACTIVE')
  assert.equal(active.accountingMode, 'NO_VOUCHER')
  assert.equal(active.noVoucherReason, 'Opening source is already in the independent GL opening.')
  assert.deepEqual(active.lines, [])

  page.edit(active, true)
  page.form.value.noVoucherReason = 'Locally reviewed source confirmation.'
  await page.save()
  assert.equal(calls[1].body.accountingMode, 'NO_VOUCHER')
  assert.equal(calls[1].body.noVoucherReason, 'Locally reviewed source confirmation.')
  assert.deepEqual(calls[1].body.lines, [])
})

test('the original mapping editor offers owner posting fields and preserves them when saving a reviewed-version copy', async () => {
  let sent
  const page = mappingPage({
    http: { postIdem: async (path, body) => { sent = body; return {} } },
    ElMessage: { error(message) { throw new Error(message) } },
  })
  const fields = ['postingInventoryAmount', 'postingCogsAmount', 'postingCounterpartAmount']
  for (const field of fields) assert.ok(page.amountFields.includes(field), `The editor must offer ${field} from the owner contract`)
  page.bookId.value = 194
  page.edit()
  page.form.value.eventType = 'CST_COST_ADJUSTED'
  page.form.value.lines = fields.map((amountExpr, index) => ({ direction: index === 2 ? 'CREDIT' : 'DEBIT', accountRule: { type: 'FIXED', code: ['1405', '6401', '2241'][index] }, amountExpr, auxJson: '{}', summary: 'Reviewed native posting projection' }))
  await page.save()
  assert.deepEqual(sent.lines.map(line => line.amountExpr), fields)
  assert.equal(sent.accountingMode, 'VOUCHER')
  assert.equal(sent.noVoucherReason, null)
})
