import test from 'node:test'
import assert from 'node:assert/strict'
import * as vue from 'vue'
import { loadVueScript } from './contracts/load-vue-script.mjs'

function deferred() {
  let resolve, reject
  const promise = new Promise((yes, no) => { resolve = yes; reject = no })
  return { promise, resolve, reject }
}
const books = () => [
  { id: 1, name: '账套一', baseCurrency: 'USD', periods: [{ id: 2, name: '十月' }, { id: 3, name: '十一月' }] },
  { id: 4, name: '账套二', periods: [{ id: 5, name: '十二月' }] },
]
const result = (extra = {}) => ({ rows: [{ accountId: 10, code: '1001', name: '库存现金' }], balanced: true, currency: 'MXN', debit: 900, credit: 900, ...extra })
function page(http) {
  let dispose
  const pushes = []
  const p = loadVueScript(new URL('../src/modules/finance/TrialView.vue', import.meta.url), {
    ref: vue.ref, computed: vue.computed, watch: vue.watch, onMounted() {}, onBeforeUnmount(fn) { dispose = fn },
    http, useRouter: () => ({ push(value) { pushes.push(value) } }), useCountryStore: () => ({ currency: 'CNY', timezone: 'Asia/Shanghai' }),
  }, ['books', 'periods', 'bookId', 'periodId', 'data', 'busy', 'booksLoading', 'booksError', 'loadError', 'navigationError',
    'keyword', 'currentPage', 'pageSize', 'filteredRows', 'pageRows', 'baseCurrency', 'resultState', 'loadBooks', 'load', 'changeBook', 'changePeriod', 'openLedger'])
  p.books.value = books(); p.bookId.value = 1; p.periodId.value = 2
  return { ...p, dispose: () => dispose(), pushes }
}

test('book loading separates failure, successful empty results and a successful retry', async () => {
  let value = new Error('账套读取超时')
  const request = deferred()
  const p = page({ get: async () => { await request.promise; if (value instanceof Error) throw value; return value } })
  const first = p.loadBooks(); assert.equal(p.booksLoading.value, true)
  request.resolve(); await first
  assert.match(p.booksError.value, /账套读取超时/); assert.equal(p.booksLoading.value, false)
  value = []; await p.loadBooks(); assert.equal(p.booksError.value, ''); assert.deepEqual(p.books.value, [])
  value = books(); await p.loadBooks(); assert.equal(p.books.value.length, 2)
})

test('malformed book periods are an explicit failure and blank failure messages stay visible', async () => {
  let value = [{ id: 1, periods: null }]
  const p = page({ get: async () => { if (value instanceof Error) throw value; return value } })
  await p.loadBooks(); assert.ok(p.booksError.value)
  value = new Error(' '); await p.loadBooks(); assert.ok(p.booksError.value.trim())
})

test('a refreshed book list invalidates results whose selected book or period is no longer available', async () => {
  let value = [books()[1]]
  const p = page({ get: async () => value })
  p.data.value = result(); await p.loadBooks()
  assert.equal(p.bookId.value, undefined); assert.equal(p.periodId.value, undefined); assert.equal(p.data.value, null)
  p.books.value = books(); p.bookId.value = 1; p.periodId.value = 2; p.data.value = result()
  value = [{ ...books()[0], periods: [{ id: 3, name: '十一月' }] }]; await p.loadBooks()
  assert.equal(p.bookId.value, 1); assert.equal(p.periodId.value, undefined); assert.equal(p.data.value, null)
})

test('missing or foreign scope does not request a trial result', async () => {
  let requests = 0
  const p = page({ get: async () => { requests++; return result() } })
  p.periodId.value = undefined; await p.load(); assert.equal(requests, 0)
  p.periodId.value = 5; await p.load(); assert.equal(requests, 0); assert.ok(p.loadError.value)
  p.bookId.value = undefined; await p.load(); assert.equal(requests, 0)
})

test('loading clears stale results immediately, passes the selected scope and retains a retryable failure', async () => {
  const pending = deferred(), calls = []
  let fail = true
  const p = page({ get: async (path, query) => { calls.push({ path, query }); if (fail) return pending.promise; return result() } })
  p.data.value = result(); p.currentPage.value = 2
  const first = p.load(); assert.equal(p.busy.value, true); assert.equal(p.data.value, null)
  assert.equal(p.currentPage.value, 1); assert.deepEqual(calls[0], { path: '/fin/trial-balance', query: { bookId: 1, periodId: 2 } })
  pending.reject(new Error('已结账期间缺少余额快照')); await first
  assert.match(p.loadError.value, /缺少余额快照/); assert.equal(p.data.value, null); assert.equal(p.busy.value, false)
  fail = false; await p.load(); assert.equal(p.loadError.value, ''); assert.equal(p.data.value.currency, 'MXN')
})

test('late successful responses from the prior period cannot replace the current result', async () => {
  const old = deferred()
  const p = page({ get: async (_path, query) => query.periodId === 2 ? old.promise : result({ periodId: 3, periodName: '十一月' }) })
  const first = p.load(); p.periodId.value = 3; await p.changePeriod()
  old.resolve(result({ periodId: 2, periodName: '十月' })); await first
  assert.equal(p.data.value.periodName, '十一月'); assert.equal(p.busy.value, false)
})

test('late prior-period failures cannot add an error or stop the current request loading state', async () => {
  const old = deferred(), next = deferred()
  const p = page({ get: async (_path, query) => query.periodId === 2 ? old.promise : next.promise })
  const first = p.load(); p.periodId.value = 3; const second = p.changePeriod()
  old.reject(new Error('旧请求失败')); await first
  assert.equal(p.loadError.value, ''); assert.equal(p.busy.value, true)
  next.resolve(result({ periodId: 3 })); await second; assert.equal(p.busy.value, false)
})

test('changing book clears the prior period, search and results while invalidating an in-flight result', async () => {
  const pending = deferred()
  const p = page({ get: async () => pending.promise })
  p.keyword.value = '旧科目'; p.currentPage.value = 2
  const first = p.load(); p.bookId.value = 4; p.changeBook()
  assert.equal(p.periodId.value, undefined); assert.equal(p.keyword.value, ''); assert.equal(p.data.value, null)
  assert.deepEqual(p.periods.value.map(item => item.id), [5]); assert.equal(p.busy.value, false)
  pending.resolve(result()); await first; assert.equal(p.data.value, null)
})

test('unmount discards both book and trial responses', async () => {
  const pendingBooks = deferred(), pendingTrial = deferred()
  const p = page({ get: async path => path === '/fin/books' ? pendingBooks.promise : pendingTrial.promise })
  const initialBooks = p.books.value
  const requests = [p.loadBooks(), p.load()]; p.dispose()
  pendingBooks.resolve([]); pendingTrial.resolve(result()); await Promise.all(requests)
  assert.equal(p.books.value, initialBooks); assert.equal(p.data.value, null)
})

test('malformed rows and amounts fail visibly while a successful empty response remains a result', async () => {
  let value = result({ rows: null })
  const p = page({ get: async () => value })
  await p.load(); assert.ok(p.loadError.value); assert.equal(p.data.value, null)
  value = result({ debit: 'invalid' }); await p.load(); assert.ok(p.loadError.value); assert.equal(p.data.value, null)
  value = result({ rows: [], debit: 0, credit: 0 }); await p.load()
  assert.equal(p.loadError.value, ''); assert.deepEqual(p.data.value.rows, []); assert.equal(p.data.value.debit, 0)
})

test('a response carrying a different book or period is rejected instead of displayed', async () => {
  let value = result({ bookId: 4, periodId: 2 })
  const p = page({ get: async () => value })
  await p.load(); assert.equal(p.data.value, null); assert.ok(p.loadError.value)
  value = result({ bookId: 1, periodId: 5 }); await p.load(); assert.equal(p.data.value, null); assert.ok(p.loadError.value)
})

test('trial conclusion keeps true, false and unknown distinct and does not recompute from visible amounts', async () => {
  let value = result({ openingDebit: 1, openingCredit: 2, rows: [{ accountId: 10, closingDebit: 7, closingCredit: 3 }] })
  const p = page({ get: async () => value })
  await p.load(); assert.equal(p.resultState.value.type, 'success')
  value = result({ balanced: false }); await p.load(); assert.equal(p.resultState.value.type, 'error')
  value = result({ balanced: undefined }); await p.load(); assert.equal(p.resultState.value.type, 'info')
  value = result({ balanced: 'false' }); await p.load(); assert.ok(p.loadError.value); assert.equal(p.data.value, null)
})

test('masked amounts stay missing and currency comes from response or selected book, never country defaults', async () => {
  let value = result({ debit: null, credit: undefined })
  const p = page({ get: async () => value })
  await p.load(); assert.equal(p.data.value.debit, null); assert.equal(p.data.value.credit, undefined); assert.equal(p.baseCurrency.value, 'MXN')
  value = result({ currency: undefined }); await p.load(); assert.equal(p.baseCurrency.value, 'USD')
  p.books.value[0].baseCurrency = undefined; assert.equal(p.baseCurrency.value, undefined)
})

test('search filters the complete result before pagination without changing authoritative totals', async () => {
  const rows = Array.from({ length: 45 }, (_, index) => ({ accountId: index + 1, code: 'A' + (index + 1), name: index >= 24 ? '现金科目' : '银行科目' }))
  const p = page({ get: async () => result({ rows }) })
  await p.load(); p.currentPage.value = 2; assert.equal(p.pageRows.value[0].accountId, 21)
  p.keyword.value = '现金'; assert.equal(p.currentPage.value, 1); assert.equal(p.filteredRows.value.length, 21)
  assert.equal(p.pageRows.value[0].accountId, 25); assert.equal(p.data.value.debit, 900)
  p.currentPage.value = 2; assert.equal(p.pageRows.value.length, 1)
  p.keyword.value = ' a45 '; assert.equal(p.filteredRows.value[0].accountId, 45)
  p.keyword.value = '不存在'; assert.equal(p.filteredRows.value.length, 0); assert.equal(p.data.value.debit, 900)
  p.keyword.value = ''; p.currentPage.value = 2; p.pageSize.value = 50
  assert.equal(p.currentPage.value, 1); assert.equal(p.pageRows.value.length, 45)
})

test('ledger drilldown carries the full selected scope and blocks missing account references', async () => {
  const p = page({ get: async () => result() })
  await p.load(); p.openLedger({ accountId: 10 })
  assert.deepEqual(p.pushes, [{ path: '/finance/ledgers', query: { bookId: 1, periodId: 2, accountId: 10 } }])
  p.openLedger({}); assert.equal(p.pushes.length, 1); assert.ok(p.navigationError.value)
  p.changeBook(); p.openLedger({ accountId: 10 }); assert.equal(p.pushes.length, 1)
})
