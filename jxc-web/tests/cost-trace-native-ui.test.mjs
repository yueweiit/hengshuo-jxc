import test from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import ts from 'typescript'
import * as Vue from 'vue'
import { compile } from '@vue/compiler-dom'
import {loadVueScript, errorFeedback, feedbackText } from './contracts/load-vue-script.mjs'

const file = new URL('../src/modules/cost/CostTraceDrawer.vue', import.meta.url)
const source = readFileSync(file, 'utf8')
const helper = ts.transpileModule(readFileSync(new URL('../src/utils/finance-source.ts', import.meta.url), 'utf8'), { compilerOptions: { module: ts.ModuleKind.ESNext } }).outputText
const { financeSourcePath } = await import('data:text/javascript;base64,' + Buffer.from(helper).toString('base64'))
async function presentationModule(path) {
  const code = ts.transpileModule(readFileSync(new URL(path, import.meta.url), 'utf8'), { compilerOptions: { module: ts.ModuleKind.ESNext } }).outputText
  return import('data:text/javascript;base64,' + Buffer.from(code).toString('base64'))
}
const { SOURCE_TYPES, optionText } = await presentationModule('../src/modules/shared/bizOptions.ts')
const { statusDef } = await presentationModule('../src/utils/status.ts')
const script = ts.createSourceFile('trace.ts', source.match(/<script[^>]*>([\s\S]*?)<\/script>/)[1], ts.ScriptTarget.Latest, true)
const bindings = script.statements.flatMap(statement => ts.isVariableStatement(statement)
  ? statement.declarationList.declarations.filter(d => ts.isIdentifier(d.name)).map(d => d.name.text)
  : ts.isFunctionDeclaration(statement) && statement.name ? [statement.name.text] : [])
const native = () => ({ batchId: 2521, asOf: '2026-10-16', unitCost: '30.209333333333', costMissing: false,
  cost: { id: 2522, batchId: 2521, bookId: 6, productId: 44, warehouseId: 12, sourceType: 'LGS_RECEIPT', sourceLineId: 2512, poId: 592, qty: '30', bizDate: '2026-10-16', status: 'ADJUSTED', srcCurrency: 'CNY', baseCurrency: 'MXN', srcUnitPrice: '100', srcUnit: 'BOX', srcFactor: '10', srcAmount: '300', basePurchaseAmount: '750', rate: '2.5', rateDate: '2026-10-16', rateVersion: 1, unitCost: '30.209333333333', confirmedBy: 4, confirmedAt: '2026-10-16T14:00:00Z' },
  valuationHistory: [{ id: 2800, bookId: 6, adjustmentId: 2799, bizDate: '2026-10-16', sourceType: 'FEE_ALLOCATION', sourceId: 2813, qtyBasis: '30', amount: '156.25', inventoryAmount: '156.25', soldAmount: '0', unitDelta: '5.208333333333' }, { id: 2840, bookId: 6, adjustmentId: 2839, bizDate: '2026-10-16', sourceType: 'FEE_ALLOCATION', sourceId: 2833, qtyBasis: '30', amount: '0.03', inventoryAmount: '0.03', soldAmount: '0', unitDelta: '0.001' }] })

function page(get) {
  const country = Vue.reactive({ epoch: 0 }), user = Vue.reactive({ token: 'owner-session' }), calls = [], paths = []
  const scope = Vue.effectScope()
  const p = scope.run(() => loadVueScript(file, { ref: Vue.ref, computed: Vue.computed, watch: Vue.watch, useRouter: () => ({ push: path => paths.push(path) }), useCountryStore: () => country, useUserStore: () => user, getCountryId: () => 3, getToken: () => user.token, financeSourcePath,
    http: { get: async path => { calls.push(path); return get(path) } }, defineExpose() {}, optionText, SOURCE_TYPES, formatDate: value => value ?? '—',
  }, bindings))
  return { p, country, user, calls, paths, stop: () => scope.stop() }
}
function render(page) {
  const money = [], links = []
  const renderer = Vue.createRenderer({ createElement: tag => ({ tag, children: [] }), createText: text => ({ text }), createComment: () => ({}), setText: (n, text) => { n.text = text }, setElementText: (n, text) => { n.text = text }, insert: (n, p) => p.children.push(n), remove() {}, patchProp: (n, key, _old, value) => { n[key] = value }, parentNode: () => null, nextSibling: () => null })
  const template = source.slice(source.indexOf('<template>') + 10, source.lastIndexOf('</template>'))
  const render = new Function('Vue', ts.transpileModule(compile(template, { mode: 'function', prefixIdentifiers: true, expressionPlugins: ['typescript'] }).code, { compilerOptions: { target: ts.ScriptTarget.ES2022 } }).outputText)(Vue)
  const app = renderer.createApp({ setup: () => ({ ...page.p, financeSourcePath, optionText, SOURCE_TYPES, formatDate: value => value ?? '—' }), render })
  app.directive('loading', {})
  app.component('ElDrawer', { setup: (_, ctx) => () => Vue.h('section', ctx.slots.default?.()) })
  for (const name of ['ElIcon', 'Refresh', 'Close']) app.component(name, { setup: (_, ctx) => () => Vue.h('section', ctx.slots.default?.()) })
  app.component('ElAlert', { props: ['title'], setup: (p, ctx) => () => Vue.h('aside', [p.title, ctx.slots.title?.(), ctx.slots.default?.()]) })
  app.component('ElEmpty', { props: ['description'], setup: p => () => Vue.h('aside', p.description) })
  app.component('ElLink', { setup: (_, ctx) => () => Vue.h('button', { ...ctx.attrs, sourceLink: true }, ctx.slots.default?.()) })
  app.component('ElButton', { setup: (_, ctx) => () => Vue.h('button', ctx.attrs, ctx.slots.default?.()) })
  app.component('StatusTag', { props: ['status'], setup: p => () => Vue.h('span', statusDef(p.status).label) })
  app.component('DateTimeText', { props: ['value'], setup: p => () => Vue.h('span', p.value ?? '—') })
  app.component('MoneyText', { props: ['value', 'currency'], setup: p => { money.push({ ...p }); return () => Vue.h('span', p.value == null ? '待补' : `${p.value} ${p.currency}`) } })
  app.component('ElTable', { props: ['data'], setup: (p, ctx) => { Vue.provide('traceRows', p.data ?? []); return () => Vue.h('table', [ctx.slots.default?.(), !p.data?.length ? ctx.slots.empty?.() : null]) } })
  app.component('ElTableColumn', { props: ['prop', 'label'], setup: (p, ctx) => { const rows = Vue.inject('traceRows'); return () => Vue.h('section', [p.label, ...rows.map(row => ctx.slots.default?.({ row }) ?? String(row[p.prop] ?? '—'))]) } })
  const root = { children: [] }; app.mount(root)
  const seen = new Set()
  const walk = n => { if (seen.has(n)) return []; seen.add(n); return [n, ...(n.children ?? []).flatMap(walk)] }
  const nodes = walk(root); nodes.filter(n => n.sourceLink).forEach(n => { links.push(n) })
  const result = { text: nodes.map(n => n.text ?? '').join(''), money, links, buttons: nodes.filter(n => n.tag === 'button') }; app.unmount(); return result
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
  const dto = native(); Object.assign(dto.cost, { qty: '30.123456', srcFactor: '10.123456789' }); dto.valuationHistory[0].qtyBasis = '30.123456'
  const h = page(async () => dto); await h.p.open(2521); const view = render(h)
  assert.match(view.text, /基础数量/); assert.match(view.text, /BOX/); assert.match(view.text, /换算系数\s*10\.123456789/); assert.match(view.text, /30\.123456/)
  assert.ok(view.money.some(m => m.value === '100' && m.currency === 'CNY')); assert.ok(view.money.some(m => m.value === '300' && m.currency === 'CNY')); assert.equal(h.p.t.value.cost.qty, '30.123456'); h.stop()
})
test('known missing cost keeps null values unknown and retains the server missing-cost warning', async () => {
  const dto = native(); Object.assign(dto, { unitCost: null, costMissing: true }); Object.assign(dto.cost, { unitCost: null, basePurchaseAmount: null, rate: null }); dto.valuationHistory = []
  const h = page(async () => dto); await h.p.open(2521); const view = render(h)
  assert.match(view.text, /成本尚未完整/); assert.match(view.text, /待补/)
  assert.ok(view.money.every(m => m.value !== 0)); assert.equal(h.p.t.value.cost.basePurchaseAmount, null); h.stop()
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

test('a failed trace displays the real reason and retries the same batch instead of showing an empty result', async () => {
  for (const message of ['成本追溯服务暂不可用', '']) {
    let fail = true
    const h = page(async () => { if (fail) throw new Error(message); return native() })
    await assert.doesNotReject(h.p.open(2521))
    const failed = render(h)
    assert.match(failed.text, /尚未加载成功/); assert.match(feedbackText(), /成本追溯读取失败/); assert.doesNotMatch(failed.text, /没有找到批次|暂无估值变动/)
    if (message) { assert.ok(feedbackText().includes(message)); assert.ok(!failed.text.includes(message)) }
    const retry = failed.buttons.find(button => button['aria-label'] === '重新加载批次成本')
    assert.ok(retry, 'the failed trace must offer an accessible retry action even when the server omitted a reason')
    fail = false; await retry.onClick()
    assert.equal(h.p.t.value.batchId, 2521); assert.doesNotMatch(render(h).text, /批次成本读取失败/)
    assert.deepEqual(h.calls, ['/cst/batches/2521/cost-trace', '/cst/batches/2521/cost-trace']); h.stop()
  }
})

test('opening and refreshing a trace show loading without an empty result or duplicate refresh requests', async () => {
  let resolve
  const h = page(() => new Promise(r => { resolve = r })), pending = h.p.open(2521)
  const loading = render(h)
  assert.match(loading.text, /正在读取批次成本/); assert.doesNotMatch(loading.text, /没有找到批次|暂无估值变动/)
  const refresh = loading.buttons.find(button => button['aria-label'] === '刷新批次成本')
  assert.ok(refresh); await refresh.onClick(); assert.equal(h.calls.length, 1)
  resolve(native()); await pending
  assert.equal(h.p.loading.value, false); h.stop()
})

test('late failed responses cannot replace a newer batch or reopen a closed trace', async () => {
  for (const close of [false, true]) {
    let reject
    const h = page(path => path.includes('/1/') ? new Promise((_resolve, r) => { reject = r }) : Promise.resolve(native()))
    const old = h.p.open(1)
    if (close) h.p.close(); else await h.p.open(2521)
    reject(new Error('旧批次读取失败')); await assert.doesNotReject(old)
    assert.doesNotMatch(render(h).text, /旧批次读取失败/)
    assert.equal(h.p.visible.value, !close); assert.equal(h.p.loading.value, false)
    if (!close) assert.equal(h.p.t.value.batchId, 2521)
    h.stop()
  }
})

test('an empty valuation history is distinct from a history field that was not returned', async () => {
  for (const present of [true, false]) {
    const dto = native(); if (present) dto.valuationHistory = []; else delete dto.valuationHistory
    const h = page(async () => dto); await h.p.open(2521); const view = render(h)
    if (present) assert.match(view.text, /截至该日暂无估值变动/)
    else { assert.match(view.text, /估值变动明细未返回/); assert.doesNotMatch(view.text, /暂无估值变动/) }
    h.stop()
  }
})

test('known sources and adjusted status are readable in Chinese while an unknown source remains traceable', async () => {
  const dto = native(); dto.cost.sourceType = 'SALES_RETURN'; dto.valuationHistory[1].sourceType = 'FUTURE_COST_SOURCE'
  const h = page(async () => dto); await h.p.open(2521); const view = render(h)
  for (const value of ['销售退货', '费用分摊', '已调整', 'FUTURE_COST_SOURCE']) assert.ok(view.text.includes(value), `trace must preserve ${value}`)
  assert.doesNotMatch(view.text, /商品 #undefined|仓库 #undefined/); h.stop()
})

test('missing currencies never use a country currency or render null identities as real identifiers', async () => {
  const dto = native(); Object.assign(dto.cost, { srcCurrency: null, baseCurrency: null, warehouseId: null, productId: null, confirmedBy: null })
  const h = page(async () => dto); await h.p.open(2521); const view = render(h)
  assert.equal(view.money.length, 0, 'currencyless values must not enter MoneyText with its country fallback')
  assert.match(view.text, /币种未返回/); assert.match(view.text, /750/); assert.match(view.text, /30\.209333333333/)
  assert.doesNotMatch(view.text, /#null|#undefined|CNY|MXN/); h.stop()
})

// Errors are application-level; each case starts with a clean global presentation.
test.beforeEach(() => errorFeedback.clearErrors())
