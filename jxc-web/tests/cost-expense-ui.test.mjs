import test from 'node:test'
import assert from 'node:assert/strict'
import * as Vue from 'vue'
import { loadVueScript } from './contracts/load-vue-script.mjs'

const expense = { id: 7, docNo: 'EX-007', expenseItemId: 77, amount: '20.00', currency: 'CNY', baseAmount: '50.00', baseCurrency: 'MXN', treatment: 'PERIOD_EXPENSE', bizDate: '2026-10-24', status: 'CONFIRMED' }
const references = [
  { id: 77, name: '办公费', costTreatment: 'PERIOD_EXPENSE', status: 'ENABLED' },
  { id: 78, name: '销售佣金', costTreatment: 'DIRECT_SELLING', status: 'ENABLED' },
  { id: 79, name: '资本化运费', costTreatment: 'CAPITALIZE', status: 'ENABLED' },
  { id: 80, name: '停用费用', costTreatment: 'PERIOD_EXPENSE', status: 'DISABLED' },
  { id: 81, name: '兼容期间费用', costTreatment: 'EXPENSE', status: 'ENABLED' },
]
const defaults = ['cst:expense:create', 'cst:expense:confirm', 'md:product:view']
function harness({ permissions = defaults, get, refs, post, options, demo = false, access = 'WRITE' } = {}) {
  const country = Vue.reactive({ currentId: 1, epoch: 1, currency: 'CNY', timezone: 'Asia/Shanghai' })
  const user = Vue.reactive({ token: 'session-A', hasPerm: codes => (Array.isArray(codes) ? codes : [codes]).some(c => permissions.includes(c)), fieldAccess: () => access })
  const calls = [], writes = [], messages = [], resets = [], optionCalls = [], scope = Vue.effectScope()
  const exposed = ['load', 'initialize', 'loadSetup', 'loadItems', 'loadProducts', 'search', 'create', 'chooseBook', 'form', 'rows', 'items', 'books', 'currencies', 'saving', 'query', 'total', 'listError', 'itemsError', 'productError', 'setupError', 'saveError', 'created', 'loading', 'products', 'treatmentLabel']
  const dependencies = {
    ref: Vue.ref, reactive: Vue.reactive, computed: Vue.computed, watch: Vue.watch, onMounted() {}, onBeforeUnmount() {},
    importMetaEnv: demo ? { MODE: 'demo', VITE_USE_MOCK: 'true' } : {},
    useCountryStore: () => country, useUserStore: () => user, todayIn: () => '2026-10-24',
    useOptionsStore: () => ({ remote: async (...args) => { optionCalls.push(args); return options ? options(...args) : [{ value: 21, label: 'NY-01 商品一' }] } }),
    PRODUCT_SOURCE: { remote: '/md/country-skus', label: 'label', value: 'productId', params: { enabled: 'true' } },
    createCommandIntent: () => ({ reset: () => resets.push(true) }),
    ElMessage: Object.fromEntries(['success', 'warning', 'error'].map(k => [k, v => messages.push({ k, v })])),
    allRecords: async (path, params) => { calls.push({ kind: 'reference', path, params }); if (refs) return refs(path, params); if (path === '/md/expense-items') return references; if (path === '/md/currencies') return [{ code: 'CNY', decimals: 2, status: 'ENABLED' }]; if (path === '/cst/expenses') return [expense]; throw new Error('Unexpected reference ' + path) },
    http: {
      get: async (path, params) => { calls.push({ kind: 'get', path, params: { ...params } }); if (get) return get(path, params); if (path === '/org/books') return [{ id: 10, name: '账套一', status: 'ACTIVE', baseCurrency: 'CNY' }]; if (path === '/cst/expenses') return { records: [expense], total: 1 }; throw new Error('Unexpected GET ' + path) },
      postIdem: async (path, body, intent) => { writes.push({ path, body: structuredClone(body), intent }); return post ? post(path, body) : { ...expense, id: 91, docNo: 'EX-091' } },
    },
  }
  const p = scope.run(() => loadVueScript(new URL('../src/modules/cost/ExpenseList.vue', import.meta.url), dependencies, exposed))
  const validForm = () => { p.books.value = [{ id: 10, name: '账套一', status: 'ACTIVE', baseCurrency: 'CNY' }]; Object.assign(p.form, { bookId: 10, expenseItemId: 77, amount: 20, currency: 'CNY', bizDate: '2026-10-24' }) }
  return { p, country, user, calls, writes, resets, messages, optionCalls, validForm, stop: () => scope.stop() }
}

test('record lookup uses server paging and keeps the native total instead of loading every expense', async () => {
  const h = harness(); h.validForm(); await h.p.load()
  assert.deepEqual(h.calls.find(c => c.path === '/cst/expenses'), { kind: 'get', path: '/cst/expenses', params: { page: 1, size: 20, bookId: 10 } })
  h.stop()
})

test('only enabled expense treatments can be selected while capitalized and disabled references are excluded', async () => {
  const h = harness(); await h.p.loadItems()
  assert.deepEqual(h.p.items.value.map(i => i.id), [77, 78, 81]); h.stop()
})

test('incomplete or nonpositive expense input never reaches the write service', async () => {
  const h = harness(); await h.p.loadItems(); h.validForm()
  for (const change of [{ amount: 0 }, { amount: -1 }, { expenseItemId: null }, { bizDate: '' }, { currency: '' }, { bookId: undefined }]) {
    h.validForm(); Object.assign(h.p.form, change); await h.p.create()
    assert.equal(h.writes.length, 0, JSON.stringify(change))
  }
  h.stop()
})

test('direct selling requires a product before posting its full single-product allocation', async () => {
  const h = harness(); await h.p.loadItems(); h.validForm(); h.p.form.expenseItemId = 78
  await h.p.create(); assert.equal(h.writes.length, 0)
  await h.p.loadProducts(); assert.equal(h.p.products.value[0].value, 21)
  h.p.form.productId = 21; await h.p.create()
  assert.deepEqual(h.writes[0].body.lines, [{ productId: 21, amount: 20 }]); h.stop()
})

test('a reference lookup failure does not discard native expense records or reject the record refresh', async () => {
  const h = harness({ refs: async () => { throw new Error('费用项目读取失败') } })
  await assert.doesNotReject(h.p.initialize()); assert.equal(h.p.rows.value[0].id, 7)
  assert.match(h.p.itemsError.value, /费用项目读取失败/); assert.equal(h.p.rows.value[0].itemName, '#77'); h.stop()
})

test('a cost-only viewer does not query optional master references and preserves native historical names', async () => {
  const h = harness({ permissions: ['cst:cost:view'], get: async () => ({ records: [expense, { ...expense, id: 8, itemName: '原来源名称' }], total: 2 }) })
  await h.p.initialize()
  assert.deepEqual(h.calls.map(c => c.path), ['/cst/expenses'])
  assert.equal(h.p.rows.value[0].itemName, '#77'); assert.equal(h.p.rows.value[1].itemName, '原来源名称'); h.stop()
})

test('all existing reference permissions retain project names including disabled historical projects', async () => {
  for (const permission of ['md:expense-item:edit', 'pur:order:create', 'lgs:shipment:create', 'lgs:fee:create', 'ap:bill:view', 'cst:expense:create']) {
    const h = harness({ permissions: ['cst:cost:view', permission], get: async () => ({ records: [{ ...expense, expenseItemId: 80 }], total: 1 }) })
    await h.p.initialize()
    assert.equal(h.calls.filter(c => c.path === '/md/expense-items').length, 1)
    assert.equal(h.p.rows.value[0].itemName, '停用费用'); assert.deepEqual(h.p.items.value.map(i => i.id), [77, 78, 81]); h.stop()
  }
})

test('paging retains the server total and changing books resets to the first page and book currency', async () => {
  const h = harness({ get: async () => ({ records: [expense], total: 75 }) }); h.validForm()
  Object.assign(h.p.query, { page: 2, size: 50 }); await h.p.load()
  assert.deepEqual(h.calls.at(-1).params, { page: 2, size: 50, bookId: 10 }); assert.equal(h.p.total.value, 75)
  h.p.books.value.push({ id: 11, name: '账套二', status: 'ACTIVE', baseCurrency: 'MXN' }); h.p.form.bookId = 11
  const switching = h.p.chooseBook(); assert.deepEqual(h.p.rows.value, []); await switching
  assert.equal(h.p.query.page, 1); assert.equal(h.p.form.currency, 'MXN'); assert.deepEqual(h.calls.at(-1).params, { page: 1, size: 50, bookId: 11 }); h.stop()
})

test('a delayed response from the old book cannot overwrite the new book records', async () => {
  let release
  const h = harness({ get: async (path, params) => params.bookId === 10 ? new Promise(resolve => { release = resolve }) : { records: [{ ...expense, id: 8 }], total: 1 } })
  h.validForm(); const old = h.p.load(); h.p.form.bookId = 11; await h.p.load()
  release({ records: [expense], total: 1 }); await old
  assert.equal(h.p.rows.value[0].id, 8); assert.equal(h.p.loading.value, false); h.stop()
})

test('list failure and malformed pagination stay errors until a successful retry', async () => {
  let response = new Error('记录连接失败')
  const h = harness({ get: async () => { if (response instanceof Error) throw response; return response } })
  await h.p.load(); assert.match(h.p.listError.value, /连接失败/)
  response = new Error(''); await h.p.load(); assert.ok(h.p.listError.value, 'a message-less failure must not become a successful empty state')
  response = { records: [], total: 'unknown' }; await h.p.load(); assert.match(h.p.listError.value, /分页/)
  response = { records: [], total: 0 }; await h.p.load(); assert.equal(h.p.listError.value, ''); assert.equal(h.p.total.value, 0); h.stop()
})

test('single active book is selected and setup failures leave record reading available', async () => {
  const h = harness(); await h.p.initialize(); assert.equal(h.p.form.bookId, 10); assert.equal(h.p.form.currency, 'CNY'); h.stop()
  const failed = harness({ get: async path => { if (path === '/org/books') throw new Error('账套读取失败'); return { records: [expense], total: 1 } } })
  await failed.p.initialize(); assert.match(failed.p.setupError.value, /账套读取失败/); assert.equal(failed.p.rows.value.length, 1)
  await failed.p.create(); assert.equal(failed.writes.length, 0); failed.stop()
})

test('product candidates use the existing enabled-country source only with master permission and expose retry errors', async () => {
  const denied = harness({ permissions: ['cst:expense:create', 'cst:expense:confirm'] }); await denied.p.loadProducts(); assert.deepEqual(denied.optionCalls, []); denied.stop()
  let fail = true
  const h = harness({ options: async () => { if (fail) throw new Error('商品查询失败'); return [{ value: 21, label: 'NY-01 商品一' }] } })
  await h.p.loadProducts(); assert.match(h.p.productError.value, /商品查询失败/)
  fail = false; await h.p.loadProducts(); assert.equal(h.p.productError.value, ''); assert.equal(h.p.products.value[0].value, 21)
  assert.deepEqual(h.optionCalls.at(-1), ['/md/country-skus', 'label', 'productId', { enabled: 'true' }]); h.stop()
})

test('a direct expense without master permission keeps the original positive product ID entry', async () => {
  const h = harness({ permissions: ['cst:expense:create', 'cst:expense:confirm'] }); await h.p.loadItems(); h.validForm()
  h.p.form.expenseItemId = 78; h.p.form.productId = 21; await h.p.create()
  assert.equal(h.writes[0].body.lines[0].productId, 21); assert.deepEqual(h.optionCalls, []); h.stop()
})

test('changing the expense item clears the product so period expenses never carry an accidental allocation', async () => {
  const h = harness(); await h.p.loadItems(); h.validForm(); h.p.form.expenseItemId = 78; await Vue.nextTick(); h.p.form.productId = 21
  h.p.form.expenseItemId = 77; await Vue.nextTick(); assert.equal(h.p.form.productId, null)
  await h.p.create(); assert.deepEqual(h.writes[0].body.lines, []); assert.equal(h.writes[0].body.productId, null); h.stop()
})

test('permission and hidden cost restrictions stop the programmatic write boundary', async () => {
  for (const config of [{ permissions: ['cst:expense:create'] }, { access: 'HIDDEN' }, { access: 'READ' }]) {
    const h = harness(config); await h.p.loadItems(); h.validForm(); await h.p.create(); assert.equal(h.writes.length, 0); assert.ok(h.p.saveError.value); h.stop()
  }
})

test('a pending registration ignores repeated clicks and clears only the completed draft fields', async () => {
  let release
  const h = harness({ post: () => new Promise(resolve => { release = resolve }) }); await h.p.loadItems(); h.validForm()
  const pending = h.p.create(); await h.p.create(); assert.equal(h.writes.length, 1)
  release({ ...expense, docNo: 'EX-091' }); await pending
  assert.equal(h.p.created.value.docNo, 'EX-091'); assert.equal(h.p.form.amount, 0); assert.equal(h.p.form.expenseItemId, 77); assert.equal(h.p.saving.value, false); h.stop()
})

test('a failed registration keeps the draft and the same intent for a deliberate retry', async () => {
  let fail = true
  const h = harness({ post: async () => { if (fail) throw new Error('登记超时'); return { ...expense, docNo: 'EX-091' } } }); await h.p.loadItems(); h.validForm()
  await h.p.create(); assert.match(h.p.saveError.value, /超时/); assert.equal(h.p.form.amount, 20); assert.equal(h.resets.length, 0)
  fail = false; await h.p.create(); assert.equal(h.writes[0].intent, h.writes[1].intent); assert.equal(h.p.saveError.value, ''); h.stop()
})

test('successful registration remains successful when the follow-up record read fails', async () => {
  const h = harness({ get: async () => { throw new Error('记录刷新失败') } }); await h.p.loadItems(); h.validForm(); await h.p.create()
  assert.equal(h.p.created.value.docNo, 'EX-091'); assert.equal(h.p.saveError.value, ''); assert.match(h.p.listError.value, /记录刷新失败/); assert.equal(h.writes.length, 1); h.stop()
})

test('country changes discard stale record and registration results and clear the old draft', async () => {
  let releaseRead, releaseWrite
  const h = harness({ get: async () => new Promise(resolve => { releaseRead = resolve }), post: () => new Promise(resolve => { releaseWrite = resolve }) })
  await h.p.loadItems(); h.validForm(); const oldRead = h.p.load(), oldWrite = h.p.create()
  h.country.epoch++; await Vue.nextTick(); releaseRead({ records: [expense], total: 1 }); releaseWrite({ ...expense, docNo: 'OLD' }); await Promise.all([oldRead, oldWrite])
  assert.deepEqual(h.p.rows.value, []); assert.equal(h.p.created.value, null); assert.equal(h.p.form.amount, 0); assert.equal(h.p.form.bookId, undefined); h.stop()
})

test('demo registration keeps its original payload and uses the same date input state', async () => {
  const h = harness({ demo: true }); await h.p.loadItems(); h.validForm(); await h.p.create()
  assert.deepEqual(h.writes[0].body, { expenseItemId: 77, amount: 20, bizDate: '2026-10-24', productId: null, lines: [] })
  assert.equal(h.calls.find(c => c.path === '/cst/expenses').params.bookId, undefined); h.stop()
})

test('treatment labels cover the existing alias and retain an unknown code for traceability', () => {
  const h = harness()
  assert.equal(h.p.treatmentLabel('PERIOD_EXPENSE'), '期间费用'); assert.equal(h.p.treatmentLabel('EXPENSE'), '期间费用')
  assert.equal(h.p.treatmentLabel('DIRECT_SELLING'), '直接销售费用'); assert.equal(h.p.treatmentLabel('NEW_CODE'), 'NEW_CODE'); h.stop()
})

test('reference and setup responses from an obsolete context cannot repopulate cleared selectors', async () => {
  for (const kind of ['items', 'products', 'setup']) {
    let release
    const pending = () => new Promise(resolve => { release = resolve })
    const h = harness({
      ...(kind === 'items' ? { refs: pending } : {}),
      ...(kind === 'products' ? { options: pending } : {}),
      ...(kind === 'setup' ? { get: pending } : {}),
    })
    const read = h.p[{ items: 'loadItems', products: 'loadProducts', setup: 'loadSetup' }[kind]]()
    h.user.token = 'session-B'; await Vue.nextTick()
    release(kind === 'items' ? references : kind === 'products' ? [{ value: 21, label: '旧商品' }] : [{ id: 10, status: 'ACTIVE', baseCurrency: 'CNY' }]); await read
    assert.deepEqual(h.p.items.value, []); assert.deepEqual(h.p.products.value, []); assert.deepEqual(h.p.books.value, []); assert.equal(h.p.form.bookId, undefined); h.stop()
  }
})
