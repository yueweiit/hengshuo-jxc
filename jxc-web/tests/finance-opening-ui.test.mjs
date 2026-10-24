import test from 'node:test'
import assert from 'node:assert/strict'
import * as vue from 'vue'
import { loadVueScript } from './contracts/load-vue-script.mjs'

const file = new URL('../src/modules/finance/OpeningList.vue', import.meta.url)
const books = [{ id: 1, name: '账套一', baseCurrency: 'CNY' }, { id: 2, name: '账套二', baseCurrency: 'USD' }]
const account = { id: 11, code: '1001', name: '现金', isLeaf: true, status: 'ENABLED', direction: 'DEBIT', auxTypes: [] }
const draft = { id: 21, version: 3, accountId: 11, baseAmount: 100, origAmount: 100, rate: 1, currency: 'CNY', direction: 'DEBIT', status: 'DRAFT', cutoffDate: '2026-09-30', aux: {} }
function deferred() { let resolve, reject; const promise = new Promise((a, b) => { resolve = a; reject = b }); return { promise, resolve, reject } }
function page(overrides = {}, extra = []) {
  const writes = [], messages = []
  const deps = {
    ref: vue.ref, computed: vue.computed, reactive: vue.reactive, onMounted() {}, onBeforeUnmount() {},
    useUserStore: () => ({ hasPerm: () => true }), useOptionsStore: () => ({ remote: async () => [] }),
    getToken: () => 'token', getCountryId: () => '1',
    createCommandIntent: () => ({ reset() {}, run: async (_scope, _endpoint, _body, action) => action('key') }),
    ElMessage: { success: m => messages.push(m), warning: m => messages.push(m), error: m => messages.push(m) },
    ElMessageBox: { confirm: async () => 'confirm' },
    http: {
      get: async () => books,
      postIdem: async (...args) => { writes.push(['POST', ...args]); return { debit: 100, credit: 100 } },
      putIdem: async (...args) => { writes.push(['PUT', ...args]) },
      delete: async (...args) => { writes.push(['DELETE', ...args]) },
    },
    allRecords: async path => path === '/fin/accounts' ? [account] : path === '/md/currencies' ? [{ code: 'CNY', decimals: 2 }] : [draft],
    ...overrides,
  }
  const p = loadVueScript(file, deps, ['books', 'bookId', 'rows', 'accounts', 'form', 'editing', 'version', 'saving', 'totals', 'load', 'add', 'edit', 'remove', 'confirm', ...extra])
  p.books.value = books
  p.bookId.value = 1
  return { p, writes, messages }
}

test('读取失败保留具体原因并允许重试，不把失败当作空列表', async () => {
  let failed = true
  const { p } = page({ allRecords: async path => { if (failed) throw new Error('无权读取期初'); return path === '/fin/accounts' ? [account] : [] } }, ['loadError', 'ready'])
  await p.load()
  assert.match(p.loadError.value, /无权读取期初/)
  assert.equal(p.ready.value, false)
  failed = false
  await p.load()
  assert.equal(p.loadError.value, '')
  assert.equal(p.ready.value, true)
  assert.deepEqual(p.rows.value, [])
})

test('切换账套立即清除旧数据，迟到响应不能覆盖新账套', async () => {
  const old = deferred()
  const { p } = page({ allRecords: async (path, params) => path === '/fin/accounts' ? [account] : params.bookId === 1 ? old.promise : [{ ...draft, id: 22, currency: 'USD' }] })
  p.rows.value = [draft]
  const first = p.load()
  p.bookId.value = 2
  const second = p.load()
  assert.deepEqual(p.rows.value, [])
  await second
  old.resolve([draft])
  await first
  assert.equal(p.rows.value[0].id, 22)
  assert.equal(p.form.currency, 'USD')
})

test('完整结果分页，翻页和条数调整不改变全账套借贷汇总', async () => {
  const records = Array.from({ length: 25 }, (_, i) => ({ ...draft, id: i + 1 }))
  const { p } = page({ allRecords: async path => path === '/fin/accounts' ? [account] : records }, ['currentPage', 'pageSize', 'pagedRows', 'changePageSize'])
  await p.load()
  assert.equal(p.pagedRows.value.length, 20)
  p.currentPage.value = 2
  assert.deepEqual(p.pagedRows.value.map(r => r.id), [21, 22, 23, 24, 25])
  assert.equal(p.totals.value.debit, 2500)
  p.changePageSize(50)
  assert.equal(p.currentPage.value, 1)
  assert.equal(p.pageSize.value, 50)
  assert.equal(p.pagedRows.value.length, 25)
})

test('隐藏或缺失金额使汇总不可用，不伪装成零余额', async () => {
  const { p } = page({ allRecords: async path => path === '/fin/accounts' ? [account] : [{ ...draft, baseAmount: null }] })
  await p.load()
  assert.equal(p.totals.value.debit, null)
  assert.equal(p.totals.value.credit, null)
})

test('保存草稿保留显式零余额且不会自动调用确认', async () => {
  const { p, writes } = page()
  await p.load()
  Object.assign(p.form, { accountId: 11, amount: 0, cutoffDate: '2026-09-30' })
  await p.add()
  assert.equal(writes.length, 1)
  assert.equal(writes[0][1], '/fin/opening-balances?bookId=1')
  assert.equal(writes[0][2].amount, 0)
  assert.equal(writes[0][2].origAmount, 0)
  assert.equal(p.form.amount, null)
})

test('修改草稿携带原版本和外币数据；已确认记录不可进入编辑', async () => {
  const { p, writes } = page({ allRecords: async path => path === '/fin/accounts' ? [{ ...account, fxEnabled: true }] : [draft] })
  await p.load()
  await p.edit({ ...draft, currency: 'USD', origAmount: 10, rate: 10 })
  await p.add()
  assert.equal(writes[0][0], 'PUT')
  assert.equal(writes[0][2].version, 3)
  assert.equal(writes[0][2].origAmount, 10)
  assert.equal(writes[0][2].rate, 10)
  await p.edit({ ...draft, status: 'CONFIRMED' })
  assert.equal(p.editing.value, undefined)
})

test('取消确认不发请求也不留下失败提示', async () => {
  const { p, writes } = page({ ElMessageBox: { confirm: async () => { throw 'cancel' } } }, ['actionError'])
  await p.load()
  await p.confirm()
  assert.equal(writes.length, 0)
  assert.equal(p.saving.value, false)
  assert.equal(p.actionError.value, '')
})

test('确认弹窗期间防止重复提交，并阻止账套切换后提交旧确认', async () => {
  const answer = deferred()
  const { p, writes } = page({ ElMessageBox: { confirm: () => answer.promise } })
  await p.load()
  const first = p.confirm()
  const duplicate = p.confirm()
  p.bookId.value = 2
  answer.resolve('confirm')
  await Promise.all([first, duplicate])
  assert.equal(writes.length, 0)
  assert.equal(p.saving.value, false)
})

test('保存成功后刷新失败保留成功事实并禁止重复保存旧表单', async () => {
  let fail = false
  const { p, writes, messages } = page({ allRecords: async path => { if (fail) throw new Error('刷新超时'); return path === '/fin/accounts' ? [account] : [draft] } }, ['loadError', 'ready'])
  await p.load()
  Object.assign(p.form, { accountId: 11, amount: 100, cutoffDate: '2026-09-30' })
  fail = true
  await p.add()
  assert.equal(writes.length, 1)
  assert.ok(messages.some(m => /已保存/.test(m)))
  assert.match(p.loadError.value, /刷新超时/)
  assert.equal(p.ready.value, false)
  assert.equal(p.form.amount, null)
  await p.add()
  assert.equal(writes.length, 1)
})

test('写入失败保留草稿与原因，重试前不会重置幂等意图', async () => {
  let resets = 0
  const { p } = page({ http: { postIdem: async () => { throw new Error('保存超时') } }, createCommandIntent: () => ({ reset() { resets++ } }) }, ['actionError'])
  await p.load()
  const before = resets
  Object.assign(p.form, { accountId: 11, amount: 100, cutoffDate: '2026-09-30' })
  await p.add()
  assert.match(p.actionError.value, /保存超时/)
  assert.equal(p.form.amount, 100)
  assert.equal(p.saving.value, false)
  assert.equal(resets, before)
})

test('未明确金额时不保存，避免将空值默认为零', async () => {
  const { p, writes } = page()
  await p.load()
  Object.assign(p.form, { accountId: 11, cutoffDate: '2026-09-30' })
  await p.add()
  assert.equal(writes.length, 0)
  assert.equal(p.form.amount, null)
})

test('删除草稿沿用版本、账套与幂等键，已确认记录不能删除', async () => {
  const { p, writes } = page()
  await p.load()
  await p.remove({ ...draft, status: 'CONFIRMED' })
  assert.equal(writes.length, 0)
  await p.remove(draft)
  assert.equal(writes.length, 1)
  assert.equal(writes[0][1], '/fin/opening-balances/21')
  assert.deepEqual(writes[0][2].params, { version: 3, bookId: 1 })
  assert.equal(writes[0][2].headers['Idempotency-Key'], 'key')
})

test('确认只由独立操作触发，并在服务器确认后更新状态', async () => {
  const { p, writes, messages } = page({}, ['writeNotice'])
  await p.load()
  await p.confirm()
  assert.equal(writes.length, 1)
  assert.equal(writes[0][1], '/fin/opening-balances/confirm?bookId=1')
  assert.ok(messages.includes('期初已确认'))
  assert.match(p.writeNotice.value, /已确认/)
})

test('没有编辑权限时保存、修改、删除与确认均不写入', async () => {
  const { p, writes } = page({ useUserStore: () => ({ hasPerm: () => false }) })
  await p.load()
  Object.assign(p.form, { accountId: 11, amount: 100, cutoffDate: '2026-09-30' })
  await p.add()
  await p.edit(draft)
  await p.remove(draft)
  await p.confirm()
  assert.equal(writes.length, 0)
  assert.equal(p.editing.value, undefined)
})

test('辅助项读取失败可重试，保留已选科目且失败期间不能保存', async () => {
  let fail = true
  const { p, writes } = page({
    allRecords: async path => path === '/fin/accounts' ? [{ ...account, auxTypes: ['CUSTOMER'] }] : [draft],
    useOptionsStore: () => ({ remote: async () => { if (fail) throw new Error('客户列表读取失败'); return [{ label: '客户甲', value: 7 }] } }),
  }, ['choose', 'loadAux', 'auxError', 'auxOptions'])
  await p.load()
  Object.assign(p.form, { accountId: 11, amount: 100, cutoffDate: '2026-09-30' })
  await p.choose()
  assert.match(p.auxError.value, /客户列表读取失败/)
  await p.add()
  assert.equal(writes.length, 0)
  fail = false
  await p.loadAux()
  assert.equal(p.auxError.value, '')
  assert.equal(p.form.accountId, 11)
  assert.equal(p.auxOptions.value.customerId[0].value, 7)
})

test('初始账套或币种读取失败有明确状态，重试恢复后自动选择唯一账套', async () => {
  let fail = true
  const { p } = page({ http: { get: async () => { if (fail) throw new Error('账套读取失败'); return [books[0]] } } }, ['initialize', 'setupError', 'initializing', 'ready'])
  await p.initialize()
  assert.match(p.setupError.value, /账套读取失败/)
  assert.equal(p.initializing.value, false)
  fail = false
  await p.initialize()
  assert.equal(p.setupError.value, '')
  assert.equal(p.bookId.value, 1)
  assert.equal(p.ready.value, true)
})

test('取消编辑直接清空表单，不重新读取或写入', async () => {
  let reads = 0
  const { p, writes } = page({ allRecords: async path => { reads++; return path === '/fin/accounts' ? [account] : [draft] } }, ['resetEditor'])
  await p.load()
  await p.edit(draft)
  const before = reads
  p.resetEditor()
  assert.equal(reads, before)
  assert.equal(writes.length, 0)
  assert.equal(p.editing.value, undefined)
  assert.equal(p.form.amount, null)
  assert.deepEqual(p.form.aux, {})
})

test('国家切换后丢弃旧列表，不显示前一个国家的余额', async () => {
  const pending = deferred()
  let country = '1'
  const { p } = page({ getCountryId: () => country, allRecords: async path => path === '/fin/accounts' ? [account] : pending.promise }, ['ready', 'loadError'])
  const reading = p.load()
  country = '2'
  pending.resolve([draft])
  await reading
  assert.equal(p.ready.value, false)
  assert.deepEqual(p.rows.value, [])
  assert.match(p.loadError.value, /国家或登录状态已切换/)
})

test('确认弹窗及请求期间重复点击只发出一次确认', async () => {
  const answer = deferred(), response = deferred()
  let requests = 0
  const { p } = page({ ElMessageBox: { confirm: () => answer.promise }, http: { postIdem: async () => { requests++; return response.promise } } })
  await p.load()
  const first = p.confirm()
  await p.confirm()
  answer.resolve('confirm')
  await new Promise(resolve => setImmediate(resolve))
  await p.confirm()
  assert.equal(requests, 1)
  response.resolve({ debit: 100, credit: 100 })
  await first
  assert.equal(p.saving.value, false)
})
