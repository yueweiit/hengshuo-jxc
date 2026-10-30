import test from 'node:test'
import assert from 'node:assert/strict'
import * as vue from 'vue'
import { loadVueScript } from './contracts/load-vue-script.mjs'

const deferred = () => {
  let resolve, reject
  const promise = new Promise((yes, no) => { resolve = yes; reject = no })
  return { promise, resolve, reject }
}
function page(http, query = {}, permitted = true) {
  let dispose
  const pushes = [], messages = []
  const intent = { resets: 0, reset() { this.resets++ } }
  const p = loadVueScript(new URL('../src/modules/finance/LedgerView.vue', import.meta.url), {
    ref: vue.ref, computed: vue.computed, watch: vue.watch, onMounted() {}, onBeforeUnmount(fn) { dispose = fn },
    http, createCommandIntent: () => intent, ElMessage: { success(message) { messages.push(message) } },
    useUserStore: () => ({ hasPerm: () => permitted }), useCountryStore: () => ({ currency: 'CNY' }),
    useRouter: () => ({ push(path) { pushes.push(path) } }), useRoute: () => ({ query }),
    allRecords: async (path, q) => (await http.get(path, q)).records,
  }, ['bookId', 'periodId', 'accountId', 'fundAccountId', 'auxKey', 'tab', 'books', 'accounts', 'periods',
    'detail', 'general', 'balance', 'journal', 'loading', 'detailLoading', 'booksError', 'accountsError',
    'ledgerErrors', 'exportError', 'exporting', 'pageRows', 'currentRows', 'currentPage', 'pageSize',
    'canExport', 'loadBooks', 'loadAccounts', 'changeBook', 'load', 'loadDetail', 'changeAccount',
    'exportLedger', 'initialize'])
  p.bookId.value = 1; p.periodId.value = 2
  return { ...p, dispose: () => dispose(), pushes, messages, intent }
}
const response = path => path.endsWith('/journal') ? { lines: [] } : { rows: [] }

test('a failed general query retains its reason while balance and journal stay available; retry recovers', async () => {
  let fail = true
  const p = page({ get: async path => {
    if (path.endsWith('/general') && fail) throw new Error('无总账读取权限')
    return path.endsWith('/balance') ? { rows: [{ accountId: 10 }] } : response(path)
  } })
  await p.load()
  assert.match(p.ledgerErrors.value.general, /无总账读取权限/)
  assert.equal(p.general.value, null)
  assert.equal(p.balance.value.rows.length, 1)
  assert.deepEqual(p.journal.value, [])
  assert.equal(p.canExport.value, false)
  fail = false; await p.load()
  assert.equal(p.ledgerErrors.value.general, '')
  assert.deepEqual(p.general.value.rows, [])
  assert.equal(p.loading.value, false)
  assert.equal(p.canExport.value, true)
})

test('malformed ledger rows are a failure, while masked or absent amount fields remain absent', async () => {
  const p = page({ get: async path => path.endsWith('/general') ? { rows: null } : path.endsWith('/balance') ? { rows: [{ accountId: 10, closingDebit: null }] } : { lines: 'invalid' } })
  await p.load()
  assert.ok(p.ledgerErrors.value.general)
  assert.ok(p.ledgerErrors.value.journal)
  assert.equal(p.balance.value.rows[0].closingDebit, null)
})

test('loading clears stale rows immediately and late failures from a previous period stay invisible', async () => {
  const old = deferred()
  const p = page({ get: async (path, q) => q.periodId === 2 ? old.promise : response(path) })
  p.general.value = { rows: [{ accountId: 99 }] }
  const first = p.load()
  assert.equal(p.loading.value, true)
  assert.equal(p.general.value, null)
  p.periodId.value = 3; await p.load()
  old.reject(new Error('旧期间失败')); await first
  assert.equal(p.ledgerErrors.value.general, '')
  assert.deepEqual(p.general.value.rows, [])
})

test('detail failure remains explicit and is cleared by a successful retry or clearing the account', async () => {
  let fail = true
  const p = page({ get: async () => { if (fail) throw new Error('明细查询超时'); return { account: { id: 10 }, lines: [] } } })
  p.accountId.value = 10
  await p.loadDetail()
  assert.match(p.ledgerErrors.value.detail, /明细查询超时/)
  assert.equal(p.detailLoading.value, false)
  fail = false; await p.loadDetail()
  assert.deepEqual(p.detail.value.lines, [])
  p.accountId.value = undefined; await p.changeAccount()
  assert.equal(p.detail.value, null)
  assert.equal(p.ledgerErrors.value.detail, '')
})

test('book failures and successful empty books have distinct states, with recoverable account failure', async () => {
  let failBooks = true, failAccounts = true
  const p = page({ get: async path => {
    if (path === '/fin/books') { if (failBooks) throw new Error('账套服务不可用'); return [] }
    if (failAccounts) throw new Error('科目服务不可用')
    return { records: [{ id: 10 }] }
  } })
  await p.loadBooks(); assert.match(p.booksError.value, /账套服务不可用/)
  failBooks = false; await p.loadBooks(); assert.equal(p.booksError.value, ''); assert.deepEqual(p.books.value, [])
  p.books.value = [{ id: 1, periods: [{ id: 2, name: '十月' }] }]
  await p.changeBook(false); assert.match(p.accountsError.value, /科目服务不可用/)
  failAccounts = false; await p.changeBook(false); assert.equal(p.accountsError.value, ''); assert.equal(p.accounts.value[0].id, 10)
})

test('unknown failures still produce a visible reason instead of an empty result', async () => {
  const p = page({ get: async () => { throw new Error(' ') } })
  await p.load()
  assert.ok(p.ledgerErrors.value.general.trim())
  assert.equal(p.general.value, null)
})

test('retrying account choices preserves the selected period, account, auxiliary item and ledger rows', async () => {
  const p = page({ get: async () => ({ records: [{ id: 10 }] }) })
  p.accountId.value = 10; p.auxKey.value = 'customer:8'; p.general.value = { rows: [{ accountId: 10 }] }
  await p.loadAccounts()
  assert.equal(p.periodId.value, 2); assert.equal(p.accountId.value, 10)
  assert.equal(p.auxKey.value, 'customer:8'); assert.equal(p.general.value.rows[0].accountId, 10)
})

test('all records are filtered before paging and account/fund/tab/size changes reset the page', async () => {
  let reads = 0
  const lines = Array.from({ length: 45 }, (_, i) => ({ id: i + 1, accountId: i < 24 ? 10 : 20, aux: { fundAccountId: i < 30 ? 11 : 22 } }))
  const p = page({ get: async path => { reads++; return path.endsWith('/journal') ? { lines } : { rows: lines } } })
  await p.load(); p.tab.value = 'journal'; p.currentPage.value = 2
  assert.equal(p.currentRows.value.length, 45); assert.equal(p.pageRows.value[0].id, 21)
  p.accountId.value = 20; assert.equal(p.currentPage.value, 1)
  assert.equal(p.currentRows.value.length, 21); assert.equal(p.pageRows.value[0].id, 25)
  const before = reads
  p.currentPage.value = 2; p.fundAccountId.value = 22
  assert.equal(p.currentPage.value, 1); assert.equal(p.currentRows.value.length, 15); assert.equal(reads, before)
  p.currentPage.value = 2; p.pageSize.value = 50; assert.equal(p.currentPage.value, 1)
  p.currentPage.value = 2; p.tab.value = 'balance'; assert.equal(p.currentPage.value, 1)
})

test('unmount prevents late ledger, detail and book responses from updating the page', async () => {
  const request = deferred()
  const p = page({ get: async () => request.promise })
  p.accountId.value = 10
  const reads = [p.load(), p.loadDetail(), p.loadBooks()]
  p.dispose(); request.resolve({ account: { id: 10 }, rows: [], lines: [] }); await Promise.all(reads)
  assert.equal(p.general.value, null); assert.equal(p.detail.value, null); assert.deepEqual(p.books.value, [])
})

test('valid report deep links initialize the requested scope with one ledger fetch', async () => {
  const calls = []
  const p = page({ get: async (path, q) => {
    calls.push({ path, q })
    if (path === '/fin/books') return [{ id: 1, periods: [{ id: 2, name: '十月' }] }]
    if (path === '/fin/accounts') return { records: [{ id: 10 }] }
    if (path.endsWith('/detail')) return { account: { id: 10 }, lines: [] }
    return response(path)
  } }, { bookId: '1', periodId: '2', accountId: '10', tab: 'balance' })
  await p.initialize()
  assert.equal(p.tab.value, 'balance'); assert.equal(p.accountId.value, 10); assert.equal(p.periodId.value, 2)
  assert.equal(calls.filter(call => call.path.endsWith('/general')).length, 1)
})

test('closed-period deep links can read a historical account absent from current account choices', async () => {
  const calls = []
  const p = page({ get: async (path, q) => {
    calls.push({ path, q })
    if (path === '/fin/books') return [{ id: 1, periods: [{ id: 2 }] }]
    if (path === '/fin/accounts') return { records: [] }
    if (path.endsWith('/detail')) return { account: { id: 90 }, lines: [], source: 'CLOSED_SNAPSHOT' }
    return response(path)
  } }, { bookId: '1', periodId: '2', accountId: '90' })
  await p.initialize()
  assert.equal(p.accountId.value, 90)
  assert.equal(p.detail.value.account.id, 90)
  assert.equal(calls.find(call => call.path.endsWith('/detail')).q.accountId, 90)
})

test('export uses the full selected scope, prevents duplicates and reuses intent after failure', async () => {
  const command = deferred(), posts = []
  let fail = true
  const p = page({ get: async responsePath => response(responsePath), postIdem: async (...args) => { posts.push(args); if (fail) return command.promise } })
  await p.load(); p.tab.value = 'journal'; p.accountId.value = 10; p.fundAccountId.value = 22
  const first = p.exportLedger(); await p.exportLedger()
  assert.equal(p.exporting.value, true); assert.equal(posts.length, 1)
  assert.equal(posts[0][0], '/fin/ledgers/journal/export')
  assert.deepEqual(posts[0][1], { bookId: 1, periodId: 2, accountId: 10, auxKey: undefined, fundAccountId: 22 })
  command.reject(new Error('导出服务不可用')); await first
  assert.match(p.exportError.value, /导出服务不可用/); assert.equal(p.intent.resets, 0)
  fail = false; await p.exportLedger()
  assert.equal(posts[0][2], posts[1][2]); assert.equal(p.intent.resets, 1); assert.deepEqual(p.pushes, ['/jobs'])
})

test('export respects permission and detail account requirements before sending any command', async () => {
  let posts = 0
  const http = { get: async responsePath => response(responsePath), postIdem: async () => { posts++ } }
  const denied = page(http, {}, false); await denied.load(); await denied.exportLedger()
  const detail = page(http); await detail.load(); detail.tab.value = 'detail'; await detail.exportLedger()
  assert.equal(posts, 0)
})
