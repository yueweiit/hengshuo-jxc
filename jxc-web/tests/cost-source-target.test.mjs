import test from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import ts from 'typescript'
import * as Vue from 'vue'
import { loadVueScript } from './contracts/load-vue-script.mjs'

const pagination = ts.transpileModule(readFileSync(new URL('../src/api/pagination.ts', import.meta.url), 'utf8'), { compilerOptions: { module: ts.ModuleKind.ESNext } }).outputText.replace(/^import .*$/gm, '').replace(/export /g, '')
const targets = ['InboundCostList', 'AdjustmentList']
function page(name, query, fetch) {
  const calls = [], country = Vue.reactive({ epoch: 1, timezone: 'Asia/Shanghai' }), user = Vue.reactive({ token: 'session-A', hasPerm: () => true, fieldAccess: () => 'WRITE' }), route = Vue.reactive({ query })
  const http = { get: async (url, params) => { calls.push({ url, params }); return fetch(url, params) } }
  class BizError extends Error {}
  const allRecords = new Function('http', 'getCountryId', 'getToken', 'BizError', pagination + ';return allRecords;')(http, () => 183, () => user.token, BizError)
  const scope = Vue.effectScope()
  const p = scope.run(() => loadVueScript(new URL(`../src/modules/cost/${name}.vue`, import.meta.url), { ref: Vue.ref, reactive: Vue.reactive, computed: Vue.computed, watch: Vue.watch, onMounted() {}, useRoute: () => route, useRouter: () => ({}), useCountryStore: () => country, useUserStore: () => user, getCountryId: () => 183, getToken: () => user.token, createCommandIntent: () => ({ reset() {} }), todayIn: () => '2026-10-17', allRecords, http }, ['load', 'rows', ...(name === 'InboundCostList' ? ['q', 'status', 'selection'] : [])]))
  return { p, calls, route, country, user, stop: () => scope.stop() }
}
const result = (records, params) => ({ records: records.slice(((params?.page ?? 1) - 1) * (params?.size ?? 20), (params?.page ?? 1) * (params?.size ?? 20)), total: records.length, counts: {} })
test('an explicit inbound source discards unrelated status/product/warehouse filters without inheriting a previous selection', async () => {
  const h = page('InboundCostList', { sourceId: '201', bookId: '194', status: 'PENDING_RATE' }, (_url, params) => result(params.status || params.productId || params.warehouseId ? [] : [{ id: 201, bookId: 194, status: 'CONFIRMED' }], params))
  Object.assign(h.p.q, { productId: 44, warehouseId: 12, keyword: 'OLD', dateFrom: '2026-01-01' }); h.p.selection.value = [{ id: 99 }]
  await h.p.load(); assert.deepEqual(h.p.rows.value.map(row => row.id), [201]); assert.equal(h.p.status.value, ''); assert.deepEqual(h.p.q, {}); assert.deepEqual(h.p.selection.value, [])
  assert.deepEqual(h.calls[0].params, { bookId: 194, page: 1, size: 200 }); h.stop()
})
for (const name of targets) {
  test(`${name} resolves an explicit book/source target beyond the first native page using the shared paginator`, async () => {
    const records = Array.from({ length: 201 }, (_, index) => ({ id: index + 1, bookId: 194, status: 'CONFIRMED', sourceType: 'FEE_ALLOCATION' }))
    const h = page(name, { sourceId: '201', bookId: '194' }, (_url, params) => result(records, params)); await h.p.load()
    assert.deepEqual(h.p.rows.value.map(row => row.id), [201]); assert.deepEqual(h.calls.map(call => call.params.page), [1, 2]); assert.ok(h.calls.every(call => call.params.bookId === 194 && call.params.size === 200 && call.params.sourceId === undefined)); h.stop()
  })
  test(`${name} never falls back to the whole list for an invalid source, absent book, or a mismatched returned book`, async () => {
    for (const query of [{ sourceId: 'bad', bookId: '194' }, { sourceId: '-1', bookId: '194' }, { sourceId: '7' }, { sourceId: '7', bookId: 'bad' }, { sourceId: '7', bookId: '194' }]) {
      const h = page(name, query, (_url, params) => result([{ id: 7, bookId: 6, status: 'CONFIRMED' }], params)); await h.p.load(); assert.deepEqual(h.p.rows.value, []); h.stop()
    }
  })
  test(`${name} clears the previous result on same-component query changes and discards a delayed earlier source`, async () => {
    let release; const h = page(name, { sourceId: '7', bookId: '194' }, (_url, params) => h.route.query.sourceId === '7' ? new Promise(resolve => { release = resolve }) : result([{ id: 8, bookId: 194, status: 'CONFIRMED' }], params))
    h.p.rows.value = [{ id: 99, bookId: 194 }]; const old = h.p.load(); assert.deepEqual(h.p.rows.value, [])
    h.route.query = { sourceId: '8', bookId: '194' }; await new Promise(setImmediate)
    release({ records: [{ id: 7, bookId: 194, status: 'CONFIRMED' }], total: 1, counts: {} }); await old
    assert.deepEqual(h.p.rows.value.map(row => row.id), [8]); h.stop()
  })
  test(`${name} discards old session/country source responses and preserves normal non-source list loading`, async () => {
    for (const change of [h => { h.user.token = 'session-B' }, h => { h.country.epoch++ }]) {
      let release, requests = 0; const h = page(name, { sourceId: '7', bookId: '194' }, (_url, params) => ++requests === 1 ? new Promise(resolve => { release = resolve }) : result([], params)); const old = h.p.load(); change(h); await new Promise(setImmediate); release({ records: [{ id: 7, bookId: 194, status: 'CONFIRMED' }], total: 1, counts: {} }); await old; assert.deepEqual(h.p.rows.value, []); h.stop()
    }
    const h = page(name, {}, (_url, params) => result([{ id: 7, bookId: 194, status: 'CONFIRMED' }, { id: 8, bookId: 6, status: 'CONFIRMED' }], params)); await h.p.load(); assert.deepEqual(h.p.rows.value.map(row => row.id), [7, 8]); assert.equal(h.calls.length, 1); h.stop()
  })
}
