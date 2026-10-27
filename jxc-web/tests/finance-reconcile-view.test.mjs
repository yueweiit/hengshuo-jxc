import test from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import * as Vue from 'vue'
import ts from 'typescript'
import { compile } from '@vue/compiler-dom'
import {loadVueScript, errorFeedback, feedbackText } from './contracts/load-vue-script.mjs'

const file = new URL('../src/modules/finance/ReconcileView.vue', import.meta.url)
const source = readFileSync(file, 'utf8')
const period = { id: 101, name: '2026年10月', startDate: '2026-10-01', endDate: '2026-10-31' }
const book = (extra = {}) => ({ id: 61, name: '墨西哥账套', status: 'ACTIVE', baseCurrency: 'MXN', periods: [period], ...extra })
const row = (extra = {}) => ({ type: 'AR', currency: 'MXN', businessAmount: '100.01', glAmount: '80.00', unpostedAmount: '20.01', ungeneratedAmount: null, diffAmount: '20.01', details: [], unposted: [], ungenerated: [], ...extra })
const deferred = () => { let resolve, reject; const promise = new Promise((yes, no) => { resolve = yes; reject = no }); return { promise, resolve, reject } }

function setup(t, get = async path => path === '/fin/books' ? [book()] : [row()]) {
  const scope = Vue.effectScope(), calls = [], mounted = [], unmounted = []
  const names = ['books', 'rows', 'bookId', 'periodId', 'periods', 'detail', 'showPrecision', 'bookLoading', 'bookError', 'loading', 'error', 'queried', 'load', 'loadBooks', 'changeBook', 'selectDetail', 'activeTab', 'detailPage', 'detailSize', 'detailRows', 'pagedDetails', 'detailTabs', 'changeTab', 'changeSize', 'selectedBook', 'selectedPeriod', 'names', 'amountColumns', 'displayAmount', 'sourcePath', 'formatDate']
  const exposed = [...names.filter(name => new RegExp(`\\b(?:const|let|function)\\s+${name}\\b`).test(source)), 'formatDate']
  const p = scope.run(() => loadVueScript(file, {
    computed: Vue.computed, ref: Vue.ref, watch: Vue.watch,
    onMounted: fn => mounted.push(fn), onBeforeUnmount: fn => unmounted.push(fn),
    useCountryStore: () => ({ timezone: 'America/Mexico_City' }), todayIn: () => '2026-10-24',
    formatDate: date => date || '-', financeSourcePath: r => r.sourceId ? { path: '/source/' + r.sourceId, query: { bookId: r.bookId } } : undefined,
    http: { get: (...args) => { calls.push(args); return get(...args) } },
  }, exposed))
  const dispose = () => { unmounted.splice(0).forEach(fn => fn()); scope.stop() }
  t.after(dispose)
  return { ...p, calls, mounted, dispose }
}

function state(p) { assert.ok(p.bookLoading && p.bookError && p.loading && p.error && p.queried, '账套和核对读取应提供独立状态') }

// 在内存中执行真实模板；不启动浏览器，也不将此验证称为视觉验收。
function render(page) {
  const money = [], links = [], tableRows = Symbol('rows')
  const renderer = Vue.createRenderer({
    createElement: tag => ({ tag, children: [] }), createText: text => ({ text }), createComment: comment => ({ comment }),
    setText: (node, text) => { node.text = text }, setElementText: (node, text) => { node.text = text },
    insert: (node, parent) => parent.children.push(node), remove() {}, patchProp: (node, key, _, value) => { node[key] = value }, parentNode: () => null, nextSibling: () => null,
  })
  const compiled = compile(source.match(/<template>([\s\S]*)<\/template>/)[1], { mode: 'function', prefixIdentifiers: true, expressionPlugins: ['typescript'] }).code
  const code = ts.transpileModule(compiled, { compilerOptions: { target: ts.ScriptTarget.ES2022 } }).outputText
  const app = renderer.createApp({ setup: () => page, render: new Function('Vue', code)(Vue) })
  for (const [name, tag] of [['ElForm', 'form'], ['ElFormItem', 'field'], ['ElSelect', 'select'], ['ElOption', 'option'], ['ElButton', 'button'], ['ElTabs', 'tabs'], ['ElTabPane', 'tab'], ['ElPagination', 'pagination']]) {
    app.component(name, Vue.defineComponent({ setup: (_, ctx) => () => Vue.h(tag, ctx.attrs, ctx.slots.default?.()) }))
  }
  app.component('ElEmpty', Vue.defineComponent({ props: ['description'], setup: props => () => Vue.h('empty', props.description) }))
  app.component('ElAlert', Vue.defineComponent({ props: ['title'], setup: props => () => Vue.h('alert', props.title) }))
  app.component('ElTable', Vue.defineComponent({ props: ['data'], setup: (props, ctx) => { Vue.provide(tableRows, () => props.data); return () => Vue.h('table', ctx.slots.default?.()) } }))
  app.component('ElTableColumn', Vue.defineComponent({ props: ['label', 'prop'], setup: (props, ctx) => { const data = Vue.inject(tableRows); return () => Vue.h('column', [props.label, ...data().map(row => Vue.h('cell', ctx.slots.default?.({ row }) ?? String(row[props.prop] ?? '')))]) } }))
  app.component('MoneyText', Vue.defineComponent({ props: ['value', 'currency'], setup: props => { money.push({ ...props }); return () => Vue.h('money', `${props.currency} ${props.value}`) } }))
  app.component('StatusTag', Vue.defineComponent({ props: ['status'], setup: props => () => Vue.h('status', props.status) }))
  app.component('RouterLink', Vue.defineComponent({ props: ['to'], setup: (props, ctx) => { links.push(props.to); return () => Vue.h('a', ctx.slots.default?.()) } }))
  app.config.warnHandler = warning => { throw new Error(warning) }
  const root = { children: [] }; app.mount(root)
  const nodes = (function walk(node) { return [node, ...(node.children ?? []).filter(Boolean).flatMap(walk)] })(root)
  const text = nodes.map(node => node.text ?? '').join('')
  app.unmount()
  return { text, nodes, money, links }
}

test('唯一启用账套按国家当地日期选中期间，查询保持ALL和账套期间参数', async t => {
  const pending = deferred(), query = deferred(), p = setup(t, path => path === '/fin/books' ? pending.promise : query.promise)
  state(p)
  const loading = p.loadBooks()
  assert.equal(p.bookLoading.value, true)
  pending.resolve([book()])
  await new Promise(resolve => setImmediate(resolve))
  assert.equal(p.bookLoading.value, false, '账套读取结束后应解除其加载状态')
  assert.equal(p.loading.value, true, '核对请求仍独立加载')
  query.resolve([row()])
  await loading
  assert.equal(p.bookId.value, 61)
  assert.equal(p.periodId.value, 101)
  assert.deepEqual(p.calls[1], ['/fin/reconcile', { type: 'ALL', bookId: 61, periodId: 101 }, { silent: true }])
  assert.equal(p.rows.value[0].diffAmount, '20.01')
})

test('多个启用账套不擅自选择，未选期间不发核对请求', async t => {
  const p = setup(t, async () => [book(), book({ id: 62 })])
  state(p)
  await p.loadBooks()
  assert.equal(p.bookId.value, undefined)
  assert.equal(p.periodId.value, undefined)
  assert.equal(p.calls.length, 1)
  assert.equal(p.queried.value, false)
})

test('没有当前期间时不猜测历史期间', async t => {
  const p = setup(t, async () => [book({ periods: [{ ...period, endDate: '2026-10-01' }] })])
  state(p)
  await p.loadBooks()
  assert.equal(p.periodId.value, undefined)
  assert.equal(p.calls.length, 1)
})

test('账套失败保留原因，重试成功后恢复核对', async t => {
  let failed = true
  const p = setup(t, async path => { if (path === '/fin/books') { if (failed) throw new Error('账套读取被拒绝'); return [book()] } return [row()] })
  state(p)
  await p.loadBooks()
  assert.equal(p.bookError.value, '账套读取被拒绝')
  assert.equal(p.queried.value, false)
  failed = false
  await p.loadBooks()
  assert.equal(p.bookError.value, '')
  assert.equal(p.rows.value.length, 1)
})

test('错误对象没有消息时仍显示读取失败，不能留下空白页面', async t => {
  const p = setup(t, async path => { if (path === '/fin/books') return [book()]; throw new Error('') })
  await p.loadBooks()
  assert.match(p.error.value, /读取失败/)
  assert.match(feedbackText(), /读取失败/); assert.match(render(p).text, /操作未完成|尚未加载成功/)
})

test('账套及明细结构缺失时保留格式错误，不伪装为空记录', async t => {
  const p = setup(t, async () => [{ id: 61 }])
  await p.loadBooks()
  assert.match(p.bookError.value, /格式/)
  const q = setup(t, async path => path === '/fin/books' ? [book()] : [row({ details: null })])
  await q.loadBooks()
  assert.match(q.error.value, /格式/)
})

test('核对失败清空旧结果并保留原因，重试成功才成为合法空结果', async t => {
  let failed = false
  const p = setup(t, async path => { if (path === '/fin/books') return [book()]; if (failed) throw new Error('核对服务超时'); return [] })
  state(p)
  await p.loadBooks()
  p.rows.value = [row()]; p.detail.value = row(); failed = true
  await p.load()
  assert.equal(p.error.value, '核对服务超时')
  assert.deepEqual(p.rows.value, [])
  assert.equal(p.detail.value, null)
  failed = false
  await p.load()
  assert.equal(p.error.value, '')
  assert.equal(p.queried.value, true)
  assert.deepEqual(p.rows.value, [])
})

for (const outcome of ['成功', '失败']) test(`切换期间后迟到的旧请求${outcome}不覆盖新结果`, async t => {
  const old = deferred()
  let count = 0
  const q = setup(t, path => path === '/fin/books' ? Promise.resolve([book({ periods: [period, { ...period, id: 102 }] })]) : (++count === 1 ? old.promise : Promise.resolve([row({ type: 'AP' })])))
  state(q)
  const first = q.loadBooks()
  await new Promise(resolve => setImmediate(resolve))
  q.periodId.value = 102
  await q.load()
  if (outcome === '成功') old.resolve([row({ type: 'CASH' })]); else old.reject(new Error('旧期间失败'))
  await first
  assert.equal(q.rows.value[0].type, 'AP')
  assert.equal(q.error.value, '')
  assert.equal(q.loading.value, false)
})

test('切换到没有期间的账套立即清空并使旧请求失效', async t => {
  const pending = deferred(), p = setup(t, path => path === '/fin/books' ? Promise.resolve([book(), book({ id: 62, periods: [] })]) : pending.promise)
  state(p)
  await p.loadBooks()
  p.bookId.value = 61; p.periodId.value = 101
  const first = p.load()
  p.rows.value = [row()]; p.detail.value = row(); p.bookId.value = 62
  await p.changeBook()
  assert.equal(p.detail.value, null)
  assert.deepEqual(p.rows.value, [])
  pending.resolve([row()]); await first
  assert.deepEqual(p.rows.value, [])
  assert.equal(p.queried.value, false)
})

test('卸载后账套响应不再触发核对', async t => {
  const pending = deferred(), p = setup(t, () => pending.promise)
  state(p)
  const first = p.loadBooks(); p.dispose(); pending.resolve([book()]); await first
  assert.deepEqual(p.books.value, [])
  assert.equal(p.calls.length, 1)
})

for (const payload of [null, { rows: [] }]) test(`异常核对结构${JSON.stringify(payload)}不能变成成功空结果`, async t => {
  const p = setup(t, async path => path === '/fin/books' ? [book()] : payload)
  state(p)
  await p.loadBooks()
  assert.match(p.error.value, /格式/)
  assert.deepEqual(p.rows.value, [])
})

test('明细按完整来源数组分页，切换类别及条数回到第一页', async t => {
  const p = setup(t)
  assert.ok(p.selectDetail && p.pagedDetails, '需要复用完整返回明细进行分页')
  const records = Array.from({ length: 53 }, (_, index) => ({ sourceId: index + 1 }))
  p.selectDetail(row({ details: records, unposted: [{ voucherId: 1 }] }))
  assert.equal(p.pagedDetails.value.length, 20)
  p.detailPage.value = 3
  assert.equal(p.pagedDetails.value[0].sourceId, 41)
  p.changeSize(50)
  assert.equal(p.detailPage.value, 1)
  assert.equal(p.pagedDetails.value.length, 50)
  p.detailPage.value = 2; p.changeTab('unposted')
  assert.equal(p.detailPage.value, 1)
  assert.equal(p.detailRows.value.length, 1)
  p.selectDetail(row({ type: 'AP' }))
  assert.equal(p.activeTab.value, 'details')
  assert.equal(p.detailPage.value, 1)
})

test('库存精度仅在服务端提供字段时出现，金额原值及隐藏字段保持原状', t => {
  const p = setup(t)
  p.detail.value = row({ type: 'INVENTORY' })
  assert.equal(p.showPrecision.value, false)
  p.detail.value = row({ type: 'INVENTORY', sourceAccountingAmount: null, precisionDetails: [], precisionIncomplete: true })
  assert.equal(p.showPrecision.value, true)
  assert.ok(p.displayAmount, '缺失值必须显式说明')
  assert.equal(p.displayAmount(null), '金额未完整')
  assert.equal(p.displayAmount(undefined), '-')
  assert.equal(p.displayAmount('0.0001'), '0.0001')
  assert.equal(p.displayAmount(0), 0)
})

test('模板可编译，保留标注币种的金额、原始精度、状态和来源入口', () => {
  const template = source.match(/<template>([\s\S]*)<\/template>/)[1]
  assert.doesNotThrow(() => compile(template))
  assert.match(template, /<MoneyText[^>]+:currency=/)
  assert.match(template, /<StatusTag[^>]+domain="voucher"/)
  assert.match(template, /查看明细/)
  assert.match(template, /label="账套"/)
  assert.match(template, /label="会计期间"/)
  assert.match(template, /<el-pagination/)
  assert.match(template, /displayAmount\(row\.originalAmount\)/)
  assert.match(template, /v-if="bookError"/)
  assert.match(template, /v-else-if="error"/)
  assert.match(template, /sourcePath\(row\)/)
})

test('真实模板区分加载、失败和成功空结果，失败重试按钮执行原查询', async t => {
  let fail = true
  const p = setup(t, async path => { if (path === '/fin/books') return [book()]; if (fail) throw new Error('接口没有权限'); return [] })
  await p.loadBooks()
  let view = render(p)
  assert.match(feedbackText(), /接口没有权限/); assert.doesNotMatch(view.text, /接口没有权限/)
  assert.doesNotMatch(view.text, /暂无核对项目/)
  fail = false
  const retry = view.nodes.find(node => node.tag === 'button' && node.children?.some(child => /重新读取核对/.test(child.text ?? '')))
  await retry.onClick()
  assert.match(render(p).text, /暂无核对项目/)
  p.loading.value = true
  view = render(p)
  assert.match(view.text, /正在核对子账与总账/)
  assert.doesNotMatch(view.text, /暂无核对项目/)
})

test('真实模板保留服务端金额和币种、零值，隐藏金额不补零，明细入口带账套', async t => {
  const p = setup(t, async path => path === '/fin/books' ? [book()] : [row({ businessAmount: undefined, glAmount: 0, details: [{ sourceId: 701, currency: 'CNY', originalAmount: 0, amount: '0.0001' }] })])
  await p.loadBooks()
  let view = render(p)
  assert.ok(view.money.some(m => m.value === 0 && m.currency === 'MXN'))
  assert.equal(view.money.filter(m => m.value === 0).length, 1)
  const button = view.nodes.find(node => node.tag === 'button' && node.children?.some(child => /查看明细/.test(child.text ?? '')))
  button.onClick({ stopPropagation() {} })
  view = render(p)
  assert.ok(view.money.some(m => m.value === 0 && m.currency === 'CNY'))
  assert.ok(view.links.some(link => link.path === '/source/701' && link.query.bookId === 61))
  assert.match(view.text, /核对明细/)
})

test('真实模板库存精度保留四位来源小数，权限隐藏时没有精度入口', async t => {
  const p = setup(t, async path => path === '/fin/books' ? [book()] : [row({ type: 'INVENTORY', sourceAccountingAmount: '100.0001', precisionDetails: [{ originalAmount: '0.0001', amount: '0.00' }] })])
  await p.loadBooks(); p.selectDetail(p.rows.value[0]); p.changeTab('precisionDetails')
  const view = render(p)
  assert.match(view.text, /0\.0001/)
  assert.match(view.text, /100\.0001/)
  assert.equal(view.money.some(m => m.value === '0.0001'), false)
  p.selectDetail(row({ type: 'INVENTORY' }))
  assert.equal(p.detailTabs.value.some(tab => tab.name === 'precisionDetails'), false)
})

// Errors are application-level; each case starts with a clean global presentation.
test.beforeEach(() => errorFeedback.clearErrors())
