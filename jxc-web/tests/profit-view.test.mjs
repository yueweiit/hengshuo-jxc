import test from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import ts from 'typescript'
import * as Vue from 'vue'
import { compile } from '@vue/compiler-dom'
import { loadVueScript } from './contracts/load-vue-script.mjs'

const file = new URL('../src/modules/analysis/ProfitView.vue', import.meta.url)
const source = readFileSync(file, 'utf8')
const statusCode = ts.transpileModule(readFileSync(new URL('../src/utils/status.ts', import.meta.url), 'utf8'), { compilerOptions: { module: ts.ModuleKind.ESNext } }).outputText
const { statusDef } = await import('data:text/javascript;base64,' + Buffer.from(statusCode).toString('base64'))
const books = () => [{ id: 6, name: '经营账套', baseCurrency: 'MXN', periods: [{ id: 7, name: '2026-10', status: 'CLOSED' }] }]
const row = (extra = {}) => ({ productId: 1, productCode: 'P-001', productName: '商品一', netSalesQty: 2, netSalesAmount: '100', cogsAmount: '40', directExpense: '3', periodExpense: '2', grossProfit: '60', contributionProfit: '55', completeness: 'COMPLETE', sources: [], ...extra })
const result = (extra = {}) => ({ baseCurrency: 'MXN', from: '2026-10-01', to: '2026-10-31', timezone: 'America/Mexico_City', sourceVersion: 'profit-facts-v1', grossProfit: '123.45', contributionProfit: '111.10', rows: [row()], disclaimer: '未包含线下营销费用，不能称为全成本净利润。', reconcileHint: '未记账业务会造成差异', differences: ['暂估成本及税口径差异'], ...extra })
const deferred = () => { let resolve, reject; const promise = new Promise((yes, no) => { resolve = yes; reject = no }); return { promise, resolve, reject } }

function setup(t, get = async path => path === '/fin/books' ? books() : result()) {
  const mounted = [], unmounted = [], calls = []
  const names = ['books', 'bookId', 'periodId', 'periods', 'selectedBook', 'data', 'busy', 'booksLoading', 'booksError', 'loadError', 'loadBooks', 'load', 'changeBook', 'moneyFields', 'sourceLabel', 'periodLabel', 'formatDate', 'financeSourcePath', 'country']
  const page = loadVueScript(file, {
    computed: Vue.computed, ref: Vue.ref,
    onMounted: fn => mounted.push(fn), onBeforeUnmount: fn => unmounted.push(fn),
    useCountryStore: () => ({ current: { name: '墨西哥' } }), statusDef,
    formatDate: value => value || '-', financeSourcePath: () => undefined,
    http: { get: (...args) => { calls.push(args); return get(...args) } },
  }, names)
  const dispose = () => unmounted.splice(0).forEach(fn => fn())
  t.after(dispose)
  return { ...page, calls, mounted, dispose }
}

function states(page) {
  assert.ok(page.booksLoading && page.booksError && page.loadError && page.loadBooks, '账套和利润读取需要独立加载与错误状态')
}
function select(page) { page.books.value = books(); page.bookId.value = 6; page.periodId.value = 7 }
function render(page) {
  const money = [], quantities = []
  const renderer = Vue.createRenderer({
    createElement: tag => ({ tag, children: [] }), createText: text => ({ text }), createComment: () => ({}),
    setText: (node, text) => { node.text = text }, setElementText: (node, text) => { node.text = text },
    insert: (node, parent) => parent.children.push(node), remove() {}, patchProp: (node, key, _, value) => { node[key] = value }, parentNode: () => null, nextSibling: () => null,
  })
  const code = ts.transpileModule(compile(source.match(/<template>([\s\S]*)<\/template>/)[1], { mode: 'function', prefixIdentifiers: true, expressionPlugins: ['typescript'] }).code, { compilerOptions: { target: ts.ScriptTarget.ES2022 } }).outputText
  const app = renderer.createApp({ setup: () => page, render: new Function('Vue', code)(Vue) })
  for (const name of ['ElCard', 'ElForm', 'ElFormItem', 'ElSelect', 'ElOption', 'ElTag']) {
    app.component(name, { setup: (_, ctx) => () => Vue.h('div', ctx.attrs, ctx.slots.default?.()) })
  }
  app.component('ElButton', { setup: (_, ctx) => () => Vue.h('button', ctx.attrs, ctx.slots.default?.()) })
  app.component('ElEmpty', { props: ['description'], setup: p => () => Vue.h('empty', p.description) })
  app.component('ElAlert', { props: ['title'], setup: (p, ctx) => () => Vue.h('alert', [p.title, ctx.slots.default?.()]) })
  app.component('ElTable', { props: ['data'], setup: (p, ctx) => { Vue.provide('profitRows', p.data); return () => Vue.h('table', p.data.length ? ctx.slots.default?.() : ctx.slots.empty?.()) } })
  app.component('ElTableColumn', { props: ['prop', 'label'], setup: (p, ctx) => { const rows = Vue.inject('profitRows'); return () => Vue.h('column', [p.label, ...rows.map(row => ctx.slots.default?.({ row }) ?? String(row[p.prop] ?? '-'))]) } })
  app.component('MoneyText', { props: ['value', 'currency'], setup: p => { money.push({ ...p }); return () => Vue.h('money', p.value == null ? '-' : `${p.currency} ${p.value}`) } })
  app.component('QtyText', { props: ['value'], setup: p => { quantities.push(p.value); return () => Vue.h('qty', p.value == null ? '-' : String(p.value)) } })
  app.component('StatusTag', { props: ['status'], setup: p => () => Vue.h('tag', statusDef(p.status).label) })
  app.directive('loading', {})
  app.config.warnHandler = warning => { throw new Error(warning) }
  const root = { children: [] }; app.mount(root)
  const nodes = (function walk(n) { return [n, ...(n.children ?? []).filter(Boolean).flatMap(walk)] })(root)
  const text = nodes.map(n => n.text ?? '').join('')
  app.unmount()
  return { text, money, quantities, nodes }
}

test('挂载读取账套时展示加载，未完成前不提示无账套', async t => {
  const pending = deferred(), p = setup(t, () => pending.promise)
  states(p)
  const tasks = p.mounted.map(fn => fn())
  assert.equal(p.booksLoading.value, true)
  assert.match(render(p).text, /正在读取账套/)
  assert.doesNotMatch(render(p).text, /暂无可用账套/)
  pending.resolve(books()); await Promise.all(tasks)
  assert.equal(p.booksLoading.value, false)
  assert.deepEqual(p.books.value, books())
})

test('账套读取失败保留实际原因，重试后恢复选择', async t => {
  let fail = true
  const p = setup(t, async () => { if (fail) throw new Error('账套服务暂不可用'); return books() })
  states(p)
  await p.loadBooks()
  assert.match(p.booksError.value, /账套服务暂不可用/)
  assert.doesNotMatch(render(p).text, /暂无可用账套/)
  fail = false; await p.loadBooks()
  assert.equal(p.booksError.value, '')
  assert.match(render(p).text, /请选择账套/)
})

test('账套与期间成功无结果和未选择分别给出明确提示', async t => {
  const p = setup(t, async () => [])
  states(p)
  await p.loadBooks(); assert.match(render(p).text, /暂无可用账套/)
  p.books.value = books(); assert.match(render(p).text, /请选择账套/)
  p.bookId.value = 6; assert.match(render(p).text, /请选择期间/)
  p.books.value[0].periods = []; assert.match(render(p).text, /暂无会计期间/)
})

test('选择不完整时不发送利润请求', async t => {
  const p = setup(t); states(p)
  await p.load(); p.bookId.value = 6; await p.load()
  assert.equal(p.calls.length, 0)
  assert.equal(p.busy.value, false)
})

test('切换账套清空期间、结果和忙碌状态，旧查询不得回填', async t => {
  const pending = deferred(), p = setup(t, () => pending.promise)
  states(p); select(p)
  const task = p.load()
  assert.equal(p.busy.value, true)
  p.bookId.value = 8; p.changeBook()
  assert.equal(p.periodId.value, undefined)
  assert.equal(p.busy.value, false)
  pending.resolve(result()); await task
  assert.equal(p.data.value, null)
})

test('利润失败保留真实原因并允许重试，不冒充未选择', async t => {
  let fail = true
  const p = setup(t, async () => { if (fail) throw new Error('没有当前账套的读取权限'); return result() })
  states(p); select(p)
  await p.load()
  const view = render(p)
  assert.match(view.text, /没有当前账套的读取权限/)
  assert.doesNotMatch(view.text, /请选择账套|请选择期间|暂无利润记录/)
  assert.equal(p.busy.value, false)
  fail = false; await p.load()
  assert.equal(p.loadError.value, '')
  assert.equal(p.data.value.grossProfit, '123.45')
  assert.deepEqual(p.calls[1], ['/cst/profit', { bookId: 6, periodId: 7 }, { silent: true }])
})

test('新期间完成后，旧期间的失败不能覆盖结果或错误', async t => {
  const older = deferred(), newer = deferred()
  const p = setup(t, (_, params) => params.periodId === 7 ? older.promise : newer.promise)
  states(p); select(p)
  const first = p.load(); p.periodId.value = 8; const second = p.load()
  newer.resolve(result({ periodId: 8 })); await second
  older.reject(new Error('旧请求失败')); await first
  assert.equal(p.data.value.periodId, 8)
  assert.equal(p.loadError.value, '')
  assert.equal(p.busy.value, false)
})

test('组件卸载后账套和利润的异步响应均失效', async t => {
  const bookRequest = deferred(), profitRequest = deferred()
  const p = setup(t, path => path === '/fin/books' ? bookRequest.promise : profitRequest.promise)
  states(p); select(p)
  const a = p.loadBooks(), b = p.load()
  p.dispose(); bookRequest.resolve([{ ...books()[0], name: '旧响应' }]); profitRequest.resolve(result())
  await Promise.all([a, b])
  assert.equal(p.books.value[0].name, '经营账套')
  assert.equal(p.data.value, null)
})

test('利润成功无行展示期间空结果并保留真实零合计', async t => {
  const p = setup(t, async () => result({ rows: [], grossProfit: 0, contributionProfit: 0 }))
  states(p); select(p); await p.load()
  const view = render(p)
  assert.match(view.text, /所选期间暂无利润记录/)
  assert.doesNotMatch(view.text, /请选择账套|读取失败/)
  assert.ok(view.money.some(m => m.value === 0 && m.currency === 'MXN'))
})

test('概览使用接口合计，费用构成和未分配费用行均保留', async t => {
  const p = setup(t, async () => result({ rows: [row(), row({ productId: 0, productCode: '—', productName: '未分到商品的期间费用' })] }))
  states(p); select(p); await p.load()
  const view = render(p)
  assert.ok(view.money.some(m => m.value === '123.45'))
  assert.ok(view.money.some(m => m.value === '111.10'))
  assert.ok(view.quantities.includes(2))
  assert.match(view.text, /直接费用/); assert.match(view.text, /期间费用/)
  assert.match(view.text, /未分到商品的期间费用/)
  assert.ok(view.nodes.some(n => n.label === '2026-10 · 已结账'))
  assert.match(view.text, /未包含线下营销费用/)
  assert.match(view.text, /未记账业务会造成差异/)
})

test('字段权限缺失与未知金额保持缺失，不从明细恢复利润', async t => {
  const p = setup(t, async () => result({ grossProfit: undefined, contributionProfit: null, rows: [row({ cogsAmount: undefined, grossProfit: undefined, contributionProfit: null })] }))
  states(p); select(p); await p.load()
  const view = render(p)
  assert.ok(view.money.some(m => m.value === undefined))
  assert.ok(view.money.some(m => m.value === null))
  assert.equal(view.money.filter(m => m.value === 0).length, 0)
  assert.match(view.text, /权限/)
})

test('本位币未提供时不调用金额组件默认币种', async t => {
  const p = setup(t, async () => result({ baseCurrency: undefined }))
  states(p); select(p); await p.load()
  const view = render(p)
  assert.equal(view.money.length, 0)
  assert.match(view.text, /币种未提供/)
})

test('异常利润结构与非法数值必须显示格式错误，不能伪装空记录', async t => {
  for (const invalid of [null, { rows: {} }, result({ rows: [null] }), result({ rows: [row({ sources: {} })] }), result({ grossProfit: '坏金额' }), result({ rows: [row({ netSalesQty: ' ' })] })]) {
    const p = setup(t, async () => invalid); states(p); select(p); await p.load()
    assert.match(p.loadError.value, /格式/)
    assert.equal(p.data.value, null)
    assert.doesNotMatch(render(p).text, /暂无利润记录/)
  }
})

test('账套缺少期间结构时明确报错，不能视为没有会计期间', async t => {
  const p = setup(t, async () => [{ id: 6, name: '经营账套' }]); states(p); await p.loadBooks()
  assert.match(p.booksError.value, /格式/)
  assert.doesNotMatch(render(p).text, /暂无会计期间|暂无可用账套/)
})
