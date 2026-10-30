import test from 'node:test'
import assert from 'node:assert/strict'
import * as Vue from 'vue'
import { loadVueScript } from './contracts/load-vue-script.mjs'

const candidate = (batchId = 41) => ({ batchId, batchNo: `BATCH-${batchId}`, bookId: 61, bookName: 'MX账套', productCode: 'NY-01', productName: '商品', onHandQty: '8', unitCost: '12.345678901234', baseCurrency: 'MXN', selectable: true })
function harness(name, fetch = async () => ({ records: [], total: 0, books: [], warehouses: [] })) {
  const country = Vue.reactive({ epoch: 1, timezone: 'America/Mexico_City' })
  const user = Vue.reactive({ token: 'session-A', hasPerm: () => true, fieldAccess: () => 'WRITE' })
  const route = Vue.reactive({ query: {} }), props = Vue.reactive({ target: 'INVENTORY', bookId: undefined })
  const calls = [], events = [], messages = [], writes = [], scope = Vue.effectScope()
  const exposed = name === 'AdjustmentBatchPicker'
    ? ['open', 'load', 'close', 'choose', 'query', 'rows', 'total', 'error', 'loading', 'visible']
    : ['create', 'confirm', 'load', 'selectBatch', 'selectedBatch', 'form', 'rows', 'busy', 'listError', 'created']
  const p = scope.run(() => loadVueScript(new URL(`../src/modules/cost/${name}.vue`, import.meta.url), {
    ref: Vue.ref, reactive: Vue.reactive, computed: Vue.computed, watch: Vue.watch, onMounted() {}, onBeforeUnmount() {},
    useRoute: () => route, useCountryStore: () => country, useUserStore: () => user,
    getCountryId: () => 1, getToken: () => user.token, todayIn: () => '2026-10-24',
    defineProps: () => props, defineEmits: () => (...args) => events.push(args), defineExpose() {},
    createCommandIntent: () => ({ reset() {} }),
    ElMessage: Object.fromEntries(['success', 'info', 'warning', 'error'].map(k => [k, value => messages.push({ k, value })])),
    allRecords: async (path, params) => (await fetch(path, params)).records,
    http: { get: async (path, params) => { calls.push({ path, params: { ...params } }); return fetch(path, params) },
      postIdem: async (path, body) => { writes.push({ path, body: { ...body } }); return { id: 91, docNo: 'CA-91', sourceType: 'MANUAL', status: 'PENDING_APPROVAL' } } },
  }, exposed))
  return { p, props, country, user, route, calls, events, messages, writes, stop: () => scope.stop() }
}

test('picker sends filters and server paging and preserves the full candidate cost precision', async () => {
  const h = harness('AdjustmentBatchPicker', async () => ({ records: [candidate()], total: 43, books: [], warehouses: [] }))
  await h.p.open(); Object.assign(h.p.query, { keyword: 'NY', warehouseId: 12, bookId: 61, page: 2, size: 20 }); await h.p.load()
  assert.deepEqual(h.calls.at(-1), { path: '/cst/adjustment-batches', params: { keyword: 'NY', warehouseId: 12, bookId: 61, page: 2, size: 20, target: 'INVENTORY' } })
  assert.equal(h.p.total.value, 43); assert.equal(h.p.rows.value[0].unitCost, '12.345678901234')
  h.p.choose(h.p.rows.value[0]); assert.equal(h.events[0][0], 'select'); assert.equal(h.events[0][1].batchId, 41); assert.equal(h.p.visible.value, false); h.stop()
})

test('picker refuses disabled rows and never emits a batch for missing cost', async () => {
  const h = harness('AdjustmentBatchPicker'); await h.p.open()
  h.p.choose({ ...candidate(), selectable: false, unitCost: null, unavailableReason: '成本待补' })
  assert.equal(h.events.length, 0); assert.equal(h.p.visible.value, true); h.stop()
})

test('picker failure remains an error until a successful retry, rather than an empty result', async () => {
  let fail = true
  const h = harness('AdjustmentBatchPicker', async () => { if (fail) throw new Error('批次查询连接失败'); return { records: [candidate()], total: 1, books: [], warehouses: [] } })
  await h.p.open(); assert.match(h.p.error.value, /连接失败/); assert.deepEqual(h.p.rows.value, []); assert.equal(h.p.loading.value, false)
  fail = false; await h.p.load(); assert.equal(h.p.error.value, ''); assert.equal(h.p.rows.value.length, 1); h.stop()
})

test('picker ignores a delayed earlier search response', async () => {
  let release, count = 0
  const h = harness('AdjustmentBatchPicker', () => ++count === 1 ? new Promise(r => { release = r }) : Promise.resolve({ records: [candidate(42)], total: 1, books: [], warehouses: [] }))
  const old = h.p.open(); await h.p.load(); release({ records: [candidate(41)], total: 1, books: [], warehouses: [] }); await old
  assert.equal(h.p.rows.value[0].batchId, 42); assert.equal(h.p.loading.value, false); h.stop()
})

test('picker closes and discards responses when the country, account or adjustment target changes', async () => {
  for (const change of [h => h.country.epoch++, h => { h.user.token = 'session-B' }, h => { h.props.target = 'COGS' }]) {
    let release; const h = harness('AdjustmentBatchPicker', () => new Promise(r => { release = r })); const pending = h.p.open()
    change(h); await Vue.nextTick(); release({ records: [candidate()], total: 1, books: [], warehouses: [] }); await pending
    assert.equal(h.p.visible.value, false); assert.deepEqual(h.p.rows.value, []); h.stop()
  }
})

test('adjustment validates selection, nonzero amount, reason and business date before calling the write service', async () => {
  const h = harness('AdjustmentList')
  await h.p.create(); assert.equal(h.writes.length, 0)
  h.p.selectBatch(candidate()); await h.p.create(); assert.equal(h.writes.length, 0)
  h.p.form.amount = -25.5; h.p.form.reason = '实际运费差额'; h.p.form.bizDate = ''; await h.p.create(); assert.equal(h.writes.length, 0)
  h.p.form.bizDate = '2026-10-24'; await h.p.create()
  assert.deepEqual(h.writes, [{ path: '/cst/adjustments', body: { target: 'INVENTORY', amount: -25.5, reason: '实际运费差额', batchId: 41, bizDate: '2026-10-24' } }])
  assert.equal(h.p.selectedBatch.value, null); assert.equal(h.p.created.value.status, 'PENDING_APPROVAL'); h.stop()
})

test('changing target or country clears selected batch and prevents accidental reuse', async () => {
  const h = harness('AdjustmentList'); h.p.selectBatch(candidate()); h.p.form.target = 'COGS'; await Vue.nextTick()
  assert.equal(h.p.selectedBatch.value, null); assert.equal(h.p.form.batchId, null)
  h.p.selectBatch(candidate()); h.country.epoch++; await Vue.nextTick(); assert.equal(h.p.selectedBatch.value, null); assert.equal(h.p.form.amount, 0); h.stop()
})

test('record query errors remain visible and can be retried without resaving the adjustment', async () => {
  let fail = true
  const h = harness('AdjustmentList', async () => { if (fail) throw new Error('记录查询失败'); return { records: [], total: 0 } })
  await h.p.load(); assert.match(h.p.listError.value, /查询失败/)
  fail = false; await h.p.load(); assert.equal(h.p.listError.value, ''); assert.deepEqual(h.writes, []); h.stop()
})
