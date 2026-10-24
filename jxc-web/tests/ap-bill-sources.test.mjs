import test from 'node:test'
import assert from 'node:assert/strict'
import * as Vue from 'vue'
import { loadVueScript } from './contracts/load-vue-script.mjs'

const file = new URL('../src/modules/ap/ApBillList.vue', import.meta.url)
const purchase = (overrides = {}) => ({ sourceType: 'PUR_ORDER_LINE', sourceId: 11, sourceNo: '采购订单行 #11', partnerId: 81, currency: 'CNY', qty: 80, openQty: 30, unit: 'PCS', unitPrice: 10, amount: 800, ...overrides })
const fee = { sourceType: 'LGS_FEE', sourceId: 11, sourceNo: '物流费用 #11', partnerId: 81, currency: 'CNY', qty: 1, openQty: 1, unitPrice: 200, amount: 200 }
const deferred = () => { let resolve, reject; const promise = new Promise((a, b) => { resolve = a; reject = b }); return { promise, resolve, reject } }

function page(http, extra = []) {
  let unmount
  const warnings = [], successes = [], intent = { reset() {} }
  const result = loadVueScript(file, {
    ref: Vue.ref, reactive: Vue.reactive, computed: Vue.computed,
    onBeforeUnmount: callback => { unmount = callback },
    useRouter: () => ({ push() {} }), useUserStore: () => ({ hasPerm: () => true }),
    createCommandIntent: () => intent, AP_BILL_STATUS: [], PARTNER_SOURCE: [],
    ElMessage: { warning: message => warnings.push(message), success: message => successes.push(message) }, http,
  }, ['open', 'create', 'visible', 'sources', 'page', ...extra])
  return { ...result, warnings, successes, intent, unmount: () => unmount?.() }
}

test('opening shows the dialog immediately while the source request is pending', async () => {
  const response = deferred(), p = page({ get: () => response.promise })
  const opening = p.open()
  assert.equal(p.visible.value, true, 'users must see loading feedback before the API returns')
  response.resolve({ poLines: [], fees: [] })
  await opening
})

test('loading failures remain errors and retry can load the only available category', async () => {
  let attempts = 0
  const p = page({ get: async () => { if (++attempts === 1) throw new Error('来源服务连接超时'); return { poLines: [], fees: [fee] } } }, ['sourceUi', 'loadSources'])
  await p.open()
  assert.match(p.sourceUi.loadError, /连接超时/)
  assert.equal(p.sourceUi.loading, false)
  assert.equal(p.visible.value, true)
  await p.loadSources()
  assert.equal(p.sourceUi.loadError, '')
  assert.equal(p.sourceUi.tab, 'logistics')
  assert.deepEqual(p.sources.fees.map(row => row.sourceId), [11])
})

test('malformed source envelopes cannot be presented as a successful empty list', async () => {
  for (const body of [null, {}, { poLines: [], fees: null }]) {
    const p = page({ get: async () => body }, ['sourceUi'])
    await p.open()
    assert.ok(p.sourceUi.loadError, 'invalid payload must retain an explicit error')
    assert.equal(p.sourceUi.loading, false)
  }
})

test('closing and reopening discards both stale successful and failed source responses', async () => {
  for (const staleFails of [false, true]) {
    const old = deferred(); let calls = 0
    const p = page({ get: () => ++calls === 1 ? old.promise : Promise.resolve({ poLines: [purchase({ sourceId: 22 })], fees: [] }) }, ['sourceUi', 'closeSources'])
    const first = p.open(); p.closeSources(); await p.open()
    if (staleFails) old.reject(new Error('旧请求失败')); else old.resolve({ poLines: [purchase()], fees: [] })
    await first
    assert.deepEqual(p.sources.poLines.map(row => row.sourceId), [22])
    assert.equal(p.sourceUi.loadError, '')
    assert.equal(p.sourceUi.loading, false)
  }
})

test('unmounting invalidates an unfinished source request', async () => {
  const pending = deferred(), p = page({ get: () => pending.promise })
  const loading = p.open(); p.unmount()
  pending.resolve({ poLines: [purchase()], fees: [] }); await loading
  assert.deepEqual(p.sources.poLines, [])
})

test('search uses the active category and real labels or IDs without fabricating partner names', async () => {
  const p = page({ get: async () => ({ poLines: [purchase(), purchase({ sourceId: 12, sourceNo: 'PO-000012', partnerId: 82, partnerName: '杭州供应商' })], fees: [fee] }) }, ['sourceUi', 'filteredSources', 'partnerLabel'])
  await p.open()
  p.sourceUi.keyword = '  杭州  '
  assert.deepEqual(p.filteredSources.value.map(row => row.sourceId), [12])
  p.sourceUi.keyword = '81'
  assert.deepEqual(p.filteredSources.value.map(row => row.sourceId), [11])
  assert.equal(p.partnerLabel(p.sources.poLines[0]), '供应商 #81')
  assert.equal(p.partnerLabel(fee), '物流商 #81')
  p.sourceUi.tab = 'logistics'; p.sourceUi.keyword = 'PO-000012'
  assert.deepEqual(p.filteredSources.value, [])
})

test('selection keys distinguish purchase and logistics IDs and selected rows survive filtering', async () => {
  const p = page({ get: async () => ({ poLines: [purchase()], fees: [fee] }) }, ['sourceUi', 'pickSources', 'clearSelection', 'sourceKey'])
  await p.open(); p.pickSources([p.sources.poLines[0]])
  p.sourceUi.keyword = 'no match'; p.sourceUi.tab = 'logistics'
  assert.deepEqual(p.sources.picked.map(row => row.sourceType), ['PUR_ORDER_LINE'])
  assert.notEqual(p.sourceKey(p.sources.poLines[0]), p.sourceKey(fee))
  p.clearSelection()
  assert.deepEqual(p.sources.picked, [])
})

test('known partner, currency and category conflicts cannot create one bill', async () => {
  for (const other of [purchase({ sourceId: 12, partnerId: 82 }), purchase({ sourceId: 12, currency: 'USD' }), fee]) {
    let writes = 0
    const p = page({ get: async () => ({ poLines: [purchase()], fees: [fee] }), postIdem: async () => { writes++ } }, ['pickSources', 'selectionIssue'])
    await p.open(); p.pickSources([p.sources.poLines[0], other]); await p.create()
    assert.ok(p.selectionIssue.value)
    assert.equal(writes, 0)
    assert.equal(p.warnings.length, 1)
  }
})

test('an empty selection or unavailable source currency cannot be submitted', async () => {
  let writes = 0
  const p = page({ get: async () => ({ poLines: [purchase({ currency: '' })], fees: [] }), postIdem: async () => { writes++ } }, ['pickSources', 'canCreate'])
  await p.open(); await p.create(); assert.equal(p.canCreate.value, false)
  p.pickSources(p.sources.poLines); await p.create()
  assert.equal(p.canCreate.value, false)
  assert.equal(writes, 0)
})

test('submission rejects repeated clicks and freezes selection and closing until the result arrives', async () => {
  const pending = deferred(); let writes = 0, reloads = 0
  const p = page({ get: async () => ({ poLines: [purchase()], fees: [] }), postIdem: async () => { writes++; return pending.promise } }, ['pickSources', 'sourceUi', 'closeSources', 'clearSelection'])
  p.page.value = { reload() { reloads++ } }
  await p.open(); p.pickSources(p.sources.poLines)
  const saving = p.create(); await p.create(); p.closeSources(); p.clearSelection(); p.pickSources([])
  assert.equal(writes, 1)
  assert.equal(p.sourceUi.saving, true)
  assert.equal(p.visible.value, true)
  assert.equal(p.sources.picked.length, 1)
  pending.resolve({ id: 99 }); await saving
  assert.equal(p.sourceUi.saving, false)
  assert.equal(p.visible.value, false)
  assert.equal(reloads, 1)
  assert.equal(p.successes.length, 1)
})

test('failed generation retains the selection and can retry using the same command intent', async () => {
  const calls = []; let attempts = 0
  const p = page({ get: async () => ({ poLines: [purchase()], fees: [] }), postIdem: async (path, body, intent) => { calls.push({ path, body, intent }); if (++attempts === 1) throw new Error('账套已关闭') } }, ['pickSources', 'sourceUi'])
  await p.open(); p.pickSources(p.sources.poLines); await p.create()
  assert.equal(p.visible.value, true)
  assert.equal(p.sources.picked.length, 1)
  assert.match(p.sourceUi.createError, /账套已关闭/)
  assert.equal(p.sourceUi.saving, false)
  await p.create()
  assert.equal(calls.length, 2)
  assert.equal(calls[0].intent, calls[1].intent)
  assert.deepEqual(calls[1].body, calls[0].body)
  assert.equal(p.visible.value, false)
})

test('closing and opening resets earlier selection, query and draft errors', async () => {
  const p = page({ get: async () => ({ poLines: [purchase()], fees: [] }) }, ['pickSources', 'sourceUi', 'closeSources'])
  await p.open(); p.pickSources(p.sources.poLines)
  p.sourceUi.keyword = 'old search'; p.sourceUi.createError = 'old error'; p.closeSources(); await p.open()
  assert.deepEqual(p.sources.picked, [])
  assert.equal(p.sourceUi.keyword, '')
  assert.equal(p.sourceUi.createError, '')
})
