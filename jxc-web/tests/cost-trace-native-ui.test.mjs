import test from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import ts from 'typescript'
import * as Vue from 'vue'
import { compile } from '@vue/compiler-dom'
import { loadVueScript } from './contracts/load-vue-script.mjs'

const file = new URL('../src/modules/cost/CostTraceDrawer.vue', import.meta.url)
const source = readFileSync(file, 'utf8')
const helper = ts.transpileModule(readFileSync(new URL('../src/utils/finance-source.ts', import.meta.url), 'utf8'), { compilerOptions: { module: ts.ModuleKind.ESNext } }).outputText
const { financeSourcePath } = await import('data:text/javascript;base64,' + Buffer.from(helper).toString('base64'))
const native = () => ({ batchId: 2521, asOf: '2026-10-16', unitCost: '30.209333333333', costMissing: false,
  cost: { id: 2522, batchId: 2521, bookId: 6, productId: 44, warehouseId: 12, sourceType: 'LGS_RECEIPT', sourceLineId: 2512, poId: 592, qty: '30', bizDate: '2026-10-16', status: 'ADJUSTED', srcCurrency: 'CNY', baseCurrency: 'MXN', srcUnitPrice: '100', srcUnit: 'BOX', srcFactor: '10', srcAmount: '300', basePurchaseAmount: '750', rate: '2.5', rateDate: '2026-10-16', rateVersion: 1, unitCost: '30.209333333333', confirmedBy: 4, confirmedAt: '2026-10-16T14:00:00Z' },
  valuationHistory: [{ id: 2800, bookId: 6, adjustmentId: 2799, bizDate: '2026-10-16', sourceType: 'FEE_ALLOCATION', sourceId: 2813, qtyBasis: '30', amount: '156.25', inventoryAmount: '156.25', soldAmount: '0', unitDelta: '5.208333333333' }, { id: 2840, bookId: 6, adjustmentId: 2839, bizDate: '2026-10-16', sourceType: 'FEE_ALLOCATION', sourceId: 2833, qtyBasis: '30', amount: '0.03', inventoryAmount: '0.03', soldAmount: '0', unitDelta: '0.001' }] })

function page(get) {
  const country = Vue.reactive({ epoch: 0 }), user = Vue.reactive({ token: 'owner-session' }), calls = [], paths = []
  const scope = Vue.effectScope()
  const p = scope.run(() => loadVueScript(file, { ref: Vue.ref, computed: Vue.computed, watch: Vue.watch, useRouter: () => ({ push: path => paths.push(path) }), useCountryStore: () => country, useUserStore: () => user, getCountryId: () => 3, getToken: () => user.token, financeSourcePath,
    http: { get: async path => { calls.push(path); return get(path) } }, defineExpose() {}, optionText: (_options, value) => value, COST_STATUS: [], BATCH_SOURCES: [], TRANSPORT_MODES: [], formatDate: value => value ?? '—',
  }, ['open', 'visible', 'loading', 't', 'go', 'close']))
  return { p, country, user, calls, paths, stop: () => scope.stop() }
}
function render(page) {
  const money = [], links = []
  const renderer = Vue.createRenderer({ createElement: tag => ({ tag, children: [] }), createText: text => ({ text }), createComment: () => ({}), setText: (n, text) => { n.text = text }, setElementText: (n, text) => { n.text = text }, insert: (n, p) => p.children.push(n), remove() {}, patchProp: (n, key, _old, value) => { n[key] = value }, parentNode: () => null, nextSibling: () => null })
  const template = source.slice(source.indexOf('<template>') + 10, source.lastIndexOf('</template>'))
  const render = new Function('Vue', ts.transpileModule(compile(template, { mode: 'function', prefixIdentifiers: true, expressionPlugins: ['typescript'] }).code, { compilerOptions: { target: ts.ScriptTarget.ES2022 } }).outputText)(Vue)
  const app = renderer.createApp({ setup: () => ({ ...page.p, financeSourcePath, optionText: (_options, value) => value, COST_STATUS: [], BATCH_SOURCES: [], TRANSPORT_MODES: [], formatDate: value => value ?? '—' }), render })
  app.directive('loading', {})
  for (const name of ['ElDrawer', 'ElDescriptions', 'ElTag', 'ElTimeline', 'ElTimelineItem', 'ProductCell']) app.component(name, { setup: (_, ctx) => () => Vue.h('section', ctx.slots.default?.()) })
  app.component('ElDescriptionsItem', { props: ['label'], setup: (p, ctx) => () => Vue.h('section', [p.label, ctx.slots.default?.()]) })
  app.component('ElAlert', { props: ['title'], setup: (p, ctx) => () => Vue.h('aside', [p.title, ctx.slots.title?.(), ctx.slots.default?.()]) })
  app.component('ElEmpty', { props: ['description'], setup: p => () => Vue.h('aside', p.description) })
  app.component('ElLink', { setup: (_, ctx) => () => Vue.h('button', ctx.attrs, ctx.slots.default?.()) })
  app.component('DateTimeText', { props: ['value'], setup: p => () => Vue.h('span', p.value ?? '—') })
  app.component('MoneyText', { props: ['value', 'currency'], setup: p => { money.push({ ...p }); return () => Vue.h('span', p.value == null ? '待补' : `${p.value} ${p.currency}`) } })
  app.component('ElTable', { props: ['data'], setup: (p, ctx) => { Vue.provide('traceRows', p.data ?? []); return () => Vue.h('table', ctx.slots.default?.()) } })
  app.component('ElTableColumn', { props: ['prop', 'label'], setup: (p, ctx) => { const rows = Vue.inject('traceRows'); return () => Vue.h('section', [p.label, ...rows.map(row => ctx.slots.default?.({ row }) ?? String(row[p.prop] ?? '—'))]) } })
  const root = { children: [] }; app.mount(root)
  const seen = new Set()
  const walk = n => { if (seen.has(n)) return []; seen.add(n); return [n, ...(n.children ?? []).flatMap(walk)] }
  const nodes = walk(root); nodes.filter(n => n.tag === 'button').forEach(n => { links.push(n) })
  const result = { text: nodes.map(n => n.text ?? '').join(''), money, links }; app.unmount(); return result
}
test('native trace renders the cost snapshot and every valuation change without a fabricated batch or logistics DTO', async () => {
  const h = page(async () => native()); await h.p.open(2521); const view = render(h)
  assert.doesNotMatch(view.text, /没有找到批次/)
  for (const value of ['2026-10-16', '30.209333333333', 'FEE_ALLOCATION', '156.25', '0.03', '5.208333333333']) assert.ok(view.text.includes(value), `native trace must show ${value}`)
  assert.ok(view.money.some(m => m.value === '750' && m.currency === 'MXN'))
  assert.deepEqual(h.calls, ['/cst/batches/2521/cost-trace']); h.stop()
})
test('trace references use real cost, purchase and adjustment header identities rather than a receipt line as a receipt ID', async () => {
  const h = page(async () => native()); await h.p.open(2521); const view = render(h)
  for (const link of view.links) { h.p.t.value = native(); link.onClick?.() }
  assert.deepEqual(h.paths, [{ path: '/cost/inbound', query: { sourceId: 2522, bookId: 6 } }, { path: '/purchase/orders/592', query: { bookId: 6 } }, ...[2799, 2839].map(sourceId => ({ path: '/cost/adjustments', query: { sourceId, bookId: 6 } }))]); h.stop()
})
test('the trace distinguishes native base quantity from the frozen BOX unit price without converting either', async () => {
  const h = page(async () => native()); await h.p.open(2521); const view = render(h)
  assert.match(view.text, /基础数量/); assert.match(view.text, /BOX/); assert.match(view.text, /换算系数\s*10/)
  assert.ok(view.money.some(m => m.value === '100' && m.currency === 'CNY')); assert.ok(view.money.some(m => m.value === '300' && m.currency === 'CNY')); assert.equal(h.p.t.value.cost.qty, '30'); h.stop()
})
test('known missing cost keeps null values unknown and retains the server missing-cost warning', async () => {
  const dto = native(); Object.assign(dto, { unitCost: null, costMissing: true }); Object.assign(dto.cost, { unitCost: null, basePurchaseAmount: null, rate: null }); dto.valuationHistory = []
  const h = page(async () => dto); await h.p.open(2521); const view = render(h)
  assert.match(view.text, /成本尚未完整/); assert.match(view.text, /待补/)
  assert.ok(view.money.some(m => m.value === null)); assert.ok(view.money.every(m => m.value !== 0)); h.stop()
})
test('field-masked native trace renders safe batch/date metadata without inventing cost details or source links', async () => {
  const h = page(async () => ({ batchId: 2521, asOf: '2026-10-16', costMissing: false, valuationHistory: [{ id: 2800, bizDate: '2026-10-16', sourceType: 'FEE_ALLOCATION' }] })); await h.p.open(2521); const view = render(h)
  assert.doesNotMatch(view.text, /没有找到批次/); assert.match(view.text, /成本字段未返回/); assert.match(view.text, /2026-10-16/)
  assert.deepEqual(h.paths, []); assert.equal(view.money.length, 0); h.stop()
})
test('a delayed earlier batch response never replaces the currently opened batch or its loading state', async () => {
  let first, second; const h = page(path => new Promise(resolve => { if (path.includes('/1/')) first = resolve; else second = resolve }))
  const old = h.p.open(1), current = h.p.open(2); first({ batchId: 1 }); await old
  assert.equal(h.p.loading.value, true); assert.notEqual(h.p.t.value.batchId, 1)
  second({ batchId: 2 }); await current; assert.equal(h.p.t.value.batchId, 2); assert.equal(h.p.loading.value, false); h.stop()
})
test('country or session changes discard an in-flight trace and clear the original drawer', async () => {
  for (const change of [h => h.country.epoch++, h => { h.user.token = 'new-session' }]) {
    let resolve; const h = page(() => new Promise(r => { resolve = r })); const request = h.p.open(2521)
    change(h); await Vue.nextTick(); resolve(native()); await request
    assert.equal(h.p.visible.value, false); assert.deepEqual(h.p.t.value, {}); assert.equal(h.p.loading.value, false); h.stop()
  }
})
