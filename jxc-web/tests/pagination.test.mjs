import test from 'node:test'
import assert from 'node:assert/strict'
import { existsSync } from 'node:fs'
import { ref, reactive, computed } from 'vue'
import { loadVueScript } from './contracts/load-vue-script.mjs'
import { loadPagination } from './contracts/load-pagination.mjs'

test('purchase create loads complete reference pages with original unit and supplier fields', async () => {
  const calls = []
  const get = async (url, query) => {
    assert.equal(query.size, 200, 'real MD interface rejects size=500')
    calls.push([url, query.page])
    const total = 401
    return { records: Array.from({ length: Math.max(0, Math.min(200, total - (query.page - 1) * 200)) }, (_, n) => ({ id: (query.page - 1) * 200 + n + 1, units: [{ unit: 'BOX', factorToBase: 24 }], settleCurrency: 'CNY', paymentTerms: 'NET30' })), total }
  }
  const allRecords = existsSync(new URL('../src/api/pagination.ts', import.meta.url)) ? loadPagination(get) : undefined
  const page = loadVueScript(new URL('../src/modules/purchase/PurchaseOrderForm.vue', import.meta.url), { ref, reactive, computed, http: { get }, allRecords, defineEmits: () => () => {}, defineExpose() {}, createCommandIntent: () => ({}), useCountryStore: () => ({ timezone: 'UTC' }) }, ['loadRefs', 'skus', 'suppliers'])
  await page.loadRefs()
  assert.equal(page.skus.value.length, 401)
  assert.equal(page.suppliers.value.length, 401)
  assert.equal(page.skus.value[400].units[0].factorToBase, 24)
  assert.equal(page.suppliers.value[400].paymentTerms, 'NET30')
  assert.equal(calls.length, 6)
})

test('paged reads ignore caller pagination overrides and reject incomplete pages', async () => {
  const all = loadPagination(async (url, query) => { assert.equal(query.size, 200); assert.equal(query.page, 1); return { records: [], total: 1 } })
  await assert.rejects(all('/refs', { page: 99, size: 1000 }), error => error.code === 'INVALID_PAGE')
})

test('credit rule labels resolve customers beyond one page and retain a reference when the target is unavailable', async () => {
  const calls = []
  const country = { epoch: 1 }
  const get = async (url, query) => {
    calls.push([url, query.page])
    if (url === '/md/customer-groups') return { records: [{ id: 21, name: '当地客户组', status: 'DISABLED' }], total: 1 }
    return { records: Array.from({ length: query.page === 1 ? 200 : 1 }, (_, index) => ({ id: (query.page - 1) * 200 + index + 1, name: `客户${(query.page - 1) * 200 + index + 1}`, status: 'ENABLED' })), total: 201 }
  }
  const page = loadVueScript(new URL('../src/modules/ar/CreditRuleList.vue', import.meta.url), {
    ref, reactive, onMounted() {}, allRecords: loadPagination(get), useUserStore: () => ({ hasPerm: () => true }), useCountryStore: () => country,
  }, ['loadReferences', 'targetLabel'])
  await page.loadReferences()
  assert.equal(page.targetLabel({ targetType: 'CUSTOMER', targetId: 201 }), '客户201')
  assert.equal(page.targetLabel({ targetType: 'GROUP', targetId: 21 }), '当地客户组')
  assert.equal(page.targetLabel({ targetType: 'CUSTOMER', targetId: 999 }), '客户 #999')
  assert.ok(calls.some(([url, number]) => url === '/md/customers' && number === 2))
})

test('credit rule readers without master-data permission retain target references without requesting protected masters', async () => {
  const page = loadVueScript(new URL('../src/modules/ar/CreditRuleList.vue', import.meta.url), {
    ref, reactive, onMounted() {}, allRecords: async () => { throw new Error('AR read permission does not authorize MD reads') },
    useUserStore: () => ({ hasPerm: () => false }), useCountryStore: () => ({ epoch: 1 }),
  }, ['loadReferences', 'targetLabel'])
  await page.loadReferences()
  assert.equal(page.targetLabel({ targetType: 'CUSTOMER', targetId: 201 }), '客户 #201')
  assert.equal(page.targetLabel({ targetType: 'GROUP', targetId: 21 }), '客户组 #21')
})

test('paged form references reject a response from a changed country or login', async () => {
  for (const field of ['token', 'countryId']) {
    const session = { token: 'first', countryId: 101 }
    const all = loadPagination(async () => { session[field] = field === 'token' ? 'second' : 102; return { records: [{ id: 1 }], total: 1 } }, session)
    await assert.rejects(all('/refs'), error => error.code === 'CONTEXT_CHANGED')
  }
})

test('existing fund and expense forms load all native GL references and discard the previous book response', async () => {
  for (const name of ['FundAccountList', 'ExpenseItemList']) {
    let release
    const get = async (url, query) => {
      assert.equal(query.size, 200)
      if (query.bookId === 601) await new Promise(resolve => { release = resolve })
      return { records: [{ id: query.bookId, code: '1001', isLeaf: true, status: 'ENABLED' }], total: 1 }
    }
    const page = loadVueScript(new URL(`../src/modules/master/${name}.vue`, import.meta.url), {
      ref, computed, onMounted() {}, http: { get }, allRecords: loadPagination(get), useCountryStore: () => ({ currency: 'MXN' }),
      ACCOUNT_TYPES: [], CURRENCY_SOURCE: [], ENTITY_SOURCE: [], STATUS_OPTIONS: [], STORE_SOURCE: [], ALLOC_BASES: [], COST_TREATMENTS: [], FEE_CATEGORIES: [],
    }, ['bookId', 'accounts', 'loadAccounts'])
    page.bookId.value = 601
    const first = page.loadAccounts()
    page.bookId.value = 602
    await page.loadAccounts()
    release()
    await first
    assert.equal(page.accounts.value[0].id, 602)
  }
})

test('AR statement uses the selected book and exports the saved statement book with complete customer options', async () => {
  const requests = []
  const get = async (url, query) => url === '/org/books' ? [{ id: 601 }, { id: 602 }] : { records: Array.from({ length: query.page === 1 ? 200 : 1 }, (_, i) => ({ id: (query.page - 1) * 200 + i + 1 })), total: 201 }
  const page = loadVueScript(new URL('../src/modules/ar/StatementList.vue', import.meta.url), {
    ref, reactive, http: { get, postIdem: async (url, body) => { requests.push([url, body]); return { id: 700, bookId: body.bookId, identityOk: true } } },
    allRecords: loadPagination(get), createCommandIntent: () => ({ reset() {} }), useRouter: () => ({ push: async () => {} }), useUserStore: () => ({ hasPerm: () => true }), ElMessage: { success() {}, warning() {} },
  }, ['open', 'save', 'exportStatement', 'form', 'customers'])
  await page.open()
  assert.equal(page.customers.value.length, 201)
  assert.equal(page.form.bookId, undefined)
  await page.save()
  assert.equal(requests.length, 0)
  page.form.bookId = 602
  page.form.customerId = 201
  await page.save()
  assert.equal(requests[0][1].bookId, 602)
  await page.exportStatement({ id: 701, bookId: 601 })
  assert.deepEqual(requests[1], ['/ar/statements/export', { statementId: 701, bookId: 601 }])
})

test('AR writeoff option responses cannot replace a newly selected customer and book', async () => {
  let release
  const get = async (url, query) => {
    if (query.customerId === 1 && url === '/ar/receivables' && query.settleStatus === 'OPEN') await new Promise(resolve => { release = resolve })
    const rows = query.settleStatus === 'PARTIAL' ? [] : [{ id: query.customerId, bookId: 601, status: 'CONFIRMED' }]
    return { records: rows, total: rows.length }
  }
  const page = loadVueScript(new URL('../src/modules/ar/WriteoffList.vue', import.meta.url), { ref, reactive, http: { get }, allRecords: loadPagination(get), useUserStore: () => ({}), createCommandIntent: () => ({}) }, ['form', 'loadSources', 'recv'])
  page.form.bookId = 601
  page.form.customerId = 1
  const old = page.loadSources()
  page.form.customerId = 2
  await page.loadSources()
  release()
  await old
  assert.equal(page.recv.value[0].id, 2)
})
