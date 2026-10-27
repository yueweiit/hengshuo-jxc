import test from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import * as Vue from 'vue'
import { compile } from '@vue/compiler-dom'
import { loadVueScript } from './contracts/load-vue-script.mjs'

const file = new URL('../src/modules/ap/PartnerLedger.vue', import.meta.url)
const source = readFileSync(file, 'utf8')
const balances = () => ({ partnerId: 211, partnerName: '测试供应商', byCurrency: [
  { currency: 'CNY', openAp: '1200.50', prepaid: 0, paymentOpen: null, creditOpen: '20.00' },
  { currency: 'MXN', openAp: 40, prepaid: 500, paymentOpen: 0, creditOpen: null },
] })
const entry = (extra = {}) => ({ at: '2026-10-27T00:43:00Z', type: '账单', no: 'AB-00002', currency: 'MXN', amount: 40, ...extra })
const saved = () => ({ id: 91, bookId: 6, partnerId: 211, currency: 'MXN', periodStart: '2026-10-01', periodEnd: '2026-10-27', opening: 10, increase: 40, paid: 20, offset: 0, adjust: 0, closing: 30, identityOk: true })
const deferred = () => { let resolve, reject; const promise = new Promise((yes, no) => { resolve = yes; reject = no }); return { promise, resolve, reject } }
const tick = () => new Promise(resolve => setImmediate(resolve))

function setup(t, options = {}) {
  const scope = Vue.effectScope(), route = Vue.reactive({ params: { id: 211 }, query: { bookId: '6' } })
  const mounted = [], unmounted = [], calls = [], posts = [], messages = [], navigation = []
  const get = options.get ?? (async path => path.endsWith('/balances') ? balances() : path.endsWith('/timeline') ? [entry()] : [{ id: 6, name: '墨西哥账套' }])
  const names = ['balance', 'records', 'references', 'actions', 'books', 'currencies', 'form', 'load', 'loadReferences', 'statement', 'exportStatement', 'router', 'user', 'partnerName', 'balanceColumns', 'statementFields']
  const exposed = names.filter(name => new RegExp(`\\b(?:const|let|function)\\s+${name}\\b`).test(source))
  const page = scope.run(() => loadVueScript(file, {
    ref: Vue.ref, reactive: Vue.reactive, computed: Vue.computed, watch: Vue.watch,
    onMounted: fn => mounted.push(fn), onBeforeUnmount: fn => unmounted.push(fn),
    useRoute: () => route, useRouter: () => ({ push: async path => { navigation.push(path) } }),
    useCountryStore: () => ({ currency: 'MXN' }), useUserStore: () => ({ hasPerm: () => true }),
    createCommandIntent: () => ({ reset() {} }),
    ElMessage: { success: text => messages.push(text), warning: text => messages.push(text) },
    allRecords: options.allRecords ?? (async () => [{ code: 'CNY' }, { code: 'MXN' }]),
    http: {
      get: (...args) => { calls.push(args); return get(...args) },
      postIdem: (...args) => { posts.push(args); return options.post ? options.post(...args) : Promise.resolve(saved()) },
    },
  }, exposed))
  const dispose = () => { unmounted.splice(0).forEach(fn => fn()); scope.stop() }
  t.after(dispose)
  return { ...page, route, calls, posts, mounted, messages, navigation, dispose }
}
function states(p) { assert.ok(p.balance && p.records && p.actions && p.references, '需要独立读取和操作状态') }
function conditions(p) { Object.assign(p.form, { bookId: 6, currency: 'MXN', periodStart: '2026-10-01', periodEnd: '2026-10-27' }) }

// 执行真实模板，只替换浏览器与外部组件边界，不断言源文件文字或CSS结构。
function render(page) {
  const money = [], dates = []
  const renderer = Vue.createRenderer({
    createElement: tag => ({ tag, children: [] }), createText: text => ({ text }), createComment: () => ({}),
    setText: (node, text) => { node.text = text }, setElementText: (node, text) => { node.text = text },
    insert: (node, parent) => parent.children.push(node), remove() {}, patchProp: (node, key, _, value) => { node[key] = value }, parentNode: () => null, nextSibling: () => null,
  })
  const code = compile(source.match(/<template>([\s\S]*)<\/template>/)[1], { mode: 'function', prefixIdentifiers: true }).code
  const app = renderer.createApp({ setup: () => page, render: new Function('Vue', code)(Vue) })
  for (const [name, tag] of [['ElButton', 'button'], ['ElForm', 'form'], ['ElFormItem', 'field'], ['ElSelect', 'select'], ['ElOption', 'option'], ['ElDatePicker', 'date'], ['ElSkeleton', 'skeleton'], ['ElTag', 'tag']]) {
    app.component(name, Vue.defineComponent({ setup: (_, ctx) => () => Vue.h(tag, ctx.attrs, ctx.slots.default?.()) }))
  }
  app.component('ElTable', Vue.defineComponent({ props: ['data'], setup: (props, ctx) => { Vue.provide('tableRows', Vue.computed(() => props.data ?? [])); return () => Vue.h('table', [ctx.slots.default?.(), props.data?.length ? null : ctx.slots.empty?.()]) } }))
  app.component('ElTableColumn', Vue.defineComponent({ props: ['label', 'prop'], setup: (props, ctx) => { const rows = Vue.inject('tableRows'); return () => Vue.h('column', [props.label, ...rows.value.map(row => Vue.h('cell', ctx.slots.default ? ctx.slots.default({ row }) : String(row[props.prop] ?? '-')))]) } }))
  app.component('ElEmpty', Vue.defineComponent({ props: ['description'], setup: props => () => Vue.h('empty', props.description) }))
  app.component('ElAlert', Vue.defineComponent({ props: ['title', 'description'], setup: props => () => Vue.h('alert', [props.title, props.description]) }))
  app.component('MoneyText', Vue.defineComponent({ props: ['value', 'currency'], setup: props => { money.push({ ...props }); return () => Vue.h('money', props.value == null || props.value === '' ? '-' : `${props.currency} ${props.value}`) } }))
  app.component('DateTimeText', Vue.defineComponent({ props: ['value'], setup: props => { dates.push({ ...props }); return () => Vue.h('time', props.value || '-') } }))
  app.directive('loading', {})
  app.config.warnHandler = warning => { throw new Error(warning) }
  const root = { children: [] }
  app.mount(root)
  const nodes = (function walk(node) { return [node, ...(node.children ?? []).filter(Boolean).flatMap(walk)] })(root)
  const text = nodes.map(node => node.text ?? '').join('')
  app.unmount()
  return { text, money, dates, nodes }
}

test('余额和记录同时读取，下拉引用未完成也不会阻塞往来内容', async t => {
  const refs = deferred(), pending = deferred()
  const p = setup(t, { get: path => path === '/org/books' ? refs.promise : pending.promise })
  states(p)
  p.mounted.forEach(fn => fn())
  assert.equal(p.balance.loading, true)
  assert.equal(p.records.loading, true)
  assert.equal(p.calls.filter(([path]) => path.includes('/ap/partners/211/')).length, 2)
  assert.doesNotMatch(render(p).text, /暂无往来记录/)
  pending.resolve([]); refs.resolve([])
  await tick()
})

test('余额失败仍显示往来记录，只重试余额不重复读取记录', async t => {
  let fail = true
  const p = setup(t, { get: async path => { if (path.endsWith('/timeline')) return [entry()]; if (fail) throw new Error('余额服务不可用'); return balances() } })
  states(p)
  await p.load()
  assert.equal(p.balance.error, '余额服务不可用')
  assert.deepEqual(p.records.data, [entry()])
  fail = false
  await p.load('balance')
  assert.equal(p.balance.error, '')
  assert.equal(p.balance.data.partnerName, '测试供应商')
  assert.equal(p.calls.filter(([path]) => path.endsWith('/timeline')).length, 1)
})

test('成功无记录与记录读取失败分别呈现，失败后可单独恢复', async t => {
  let result = []
  const p = setup(t, { get: async path => path.endsWith('/balances') ? balances() : result })
  states(p)
  await p.load()
  assert.match(render(p).text, /暂无往来记录/)
  result = { records: [] }
  await p.load('records')
  assert.match(p.records.error, /格式/)
  assert.doesNotMatch(render(p).text, /暂无往来记录/)
  assert.equal(p.balance.data.partnerName, '测试供应商')
  result = [entry()]
  await p.load('records')
  assert.equal(p.records.error, '')
  assert.equal(p.records.data[0].no, 'AB-00002')
})

for (const [label, payload] of [['余额结构缺失', {}], ['余额金额非法', { byCurrency: [{ currency: 'CNY', openAp: '未知' }] }]]) {
  test(`${label}必须报告格式错误，不能当成零余额`, async t => {
    const p = setup(t, { get: async path => path.endsWith('/balances') ? payload : [] })
    states(p)
    await p.load()
    assert.match(p.balance.error, /格式/)
    assert.equal(p.balance.data, null)
    assert.equal(p.records.error, '')
  })
}

test('切换对象立即清空旧内容，旧成功与旧失败都不覆盖新对象', async t => {
  const oldBalance = deferred(), oldRecords = deferred()
  const p = setup(t, { get: path => path.includes('/211/') ? (path.endsWith('/balances') ? oldBalance.promise : oldRecords.promise) : Promise.resolve(path.endsWith('/balances') ? { ...balances(), partnerName: '新供应商' } : [entry({ no: 'NEW' })]) })
  states(p)
  const old = p.load()
  p.form.result = saved()
  p.route.params.id = 212
  assert.equal(p.balance.data, null)
  assert.equal(p.records.data, null)
  assert.equal(p.form.result, null)
  await tick()
  oldBalance.resolve(balances()); oldRecords.reject(new Error('旧对象失败'))
  await old
  assert.equal(p.balance.data.partnerName, '新供应商')
  assert.equal(p.records.data[0].no, 'NEW')
  assert.equal(p.records.error, '')
})

test('同一对象连续刷新时只接受最新结果，卸载后忽略响应', async t => {
  const pending = deferred()
  let slow = true
  const p = setup(t, { get: path => slow ? pending.promise : Promise.resolve(path.endsWith('/balances') ? balances() : [entry({ no: 'LATEST' })]) })
  states(p)
  const old = p.load()
  slow = false
  await p.load()
  pending.resolve([]); await old
  assert.equal(p.records.data[0].no, 'LATEST')
  assert.equal(p.balance.error, '')
  slow = true
  const abandoned = p.load()
  p.dispose(); await abandoned
  assert.equal(p.balance.data, null)
})

test('引用读取失败可以重试，并沿用入口账套预选', async t => {
  let fail = true
  const p = setup(t, { get: async path => { if (path !== '/org/books') return path.endsWith('/balances') ? balances() : []; if (fail) throw new Error('账套读取失败'); return [{ id: 6, name: '墨西哥账套' }] } })
  states(p)
  await Promise.all([p.load(), p.loadReferences()])
  assert.equal(p.references.error, '账套读取失败')
  assert.equal(p.balance.data.partnerName, '测试供应商')
  fail = false; await p.loadReferences()
  assert.equal(p.references.error, '')
  assert.equal(p.form.bookId, 6)
  assert.equal(p.currencies.value.length, 2)
})

test('实际表格按原币展示缺失和零金额，未知币种不套用国家币种', async t => {
  const rows = [entry({ no: 'CNY-001', currency: 'CNY', amount: null }), entry({ no: 'ZERO', amount: 0 }), entry({ no: 'UNKNOWN', currency: null, amount: 888 })]
  const p = setup(t, { get: async path => path.endsWith('/balances') ? balances() : rows })
  states(p); await p.load()
  const view = render(p)
  assert.match(view.text, /CNY-001/)
  assert.match(view.text, /币种未提供/)
  assert.ok(view.money.some(item => item.value === null && item.currency === 'CNY'))
  assert.ok(view.money.some(item => item.value === 0 && item.currency === 'MXN'))
  assert.ok(!view.money.some(item => item.value === 888))
  assert.equal(view.dates.length, 3)
})

test('生成中的重复点击只发一次，提交原对象账套币种与期间', async t => {
  const pending = deferred(), p = setup(t, { post: () => pending.promise })
  states(p); conditions(p)
  const first = p.statement(), second = p.statement()
  assert.equal(p.actions.generating, true)
  assert.equal(p.posts.length, 1)
  assert.deepEqual(p.posts[0][1], { bookId: 6, partnerId: 211, currency: 'MXN', periodStart: '2026-10-01', periodEnd: '2026-10-27' })
  pending.resolve(saved()); await Promise.all([first, second])
  assert.equal(p.actions.generating, false)
  assert.equal(p.form.result.id, 91)
})

test('条件变化清除已保存展示，生成中改变条件不接收旧对账单', async t => {
  const pending = deferred(), p = setup(t, { post: () => pending.promise })
  states(p); conditions(p)
  p.form.result = saved(); p.form.currency = 'CNY'
  assert.equal(p.form.result, null)
  p.form.currency = 'MXN'
  const first = p.statement()
  p.form.periodEnd = '2026-10-28'
  pending.resolve(saved()); await first
  assert.equal(p.form.result, null)
  assert.equal(p.messages.length, 0)
})

test('生成失败保留真实原因且恢复可重试状态', async t => {
  let fail = true
  const p = setup(t, { post: async () => { if (fail) throw new Error('对账期间已关闭'); return saved() } })
  states(p); conditions(p)
  await p.statement()
  assert.equal(p.actions.generating, false)
  assert.equal(p.actions.error, '对账期间已关闭')
  assert.equal(p.form.result, null)
  fail = false; await p.statement()
  assert.equal(p.actions.error, '')
  assert.equal(p.form.result.id, 91)
})

test('条件改动后即使改回原值，也不能接收改动前生成的对账单', async t => {
  const pending = deferred(), p = setup(t, { post: () => pending.promise })
  states(p); conditions(p)
  const first = p.statement()
  p.form.currency = 'CNY'; p.form.currency = 'MXN'
  pending.resolve(saved()); await first
  assert.equal(p.form.result, null)
  assert.equal(p.messages.length, 0)
})

test('同一供应商从不同账套入口进入时，及时切换账套并清除旧对账单', async t => {
  const p = setup(t, { get: async () => [{ id: 6, name: '墨西哥账套' }, { id: 7, name: '中国账套' }] })
  states(p); await p.loadReferences()
  p.form.result = saved()
  p.route.query.bookId = '7'
  assert.equal(p.form.bookId, 7)
  assert.equal(p.form.result, null)
})

test('导出中的重复点击只创建一个任务，失败可重试且成功跳任务页', async t => {
  const pending = deferred()
  let fail = true
  const p = setup(t, { post: () => fail ? pending.promise : Promise.resolve({ id: 8 }) })
  states(p); conditions(p); p.form.result = saved()
  const first = p.exportStatement(), second = p.exportStatement()
  assert.equal(p.actions.exporting, true)
  assert.equal(p.posts.length, 1)
  pending.reject(new Error('导出服务不可用')); await Promise.all([first, second])
  assert.equal(p.actions.exporting, false)
  assert.equal(p.actions.error, '导出服务不可用')
  fail = false; await p.exportStatement()
  assert.deepEqual(p.navigation, ['/jobs'])
  assert.equal(p.actions.error, '')
})

test('没有对账单权限时不展示操作入口，也不能提交导出', async t => {
  const p = setup(t)
  states(p); conditions(p); p.form.result = saved()
  p.user.hasPerm = () => false
  const buttons = render(p).nodes.filter(node => node.tag === 'button')
    .map(node => node.children.map(child => child.text ?? '').join(''))
  assert.ok(!buttons.includes('生成对账单'))
  assert.ok(!buttons.includes('导出已保存对账单'))
  await p.exportStatement()
  assert.equal(p.posts.length, 0)
  assert.match(p.messages[0], /权限/)
})

test('切换对账条件后，旧导出失败不污染新条件或跳转任务页', async t => {
  const pending = deferred(), p = setup(t, { post: () => pending.promise })
  states(p); conditions(p); p.form.result = saved()
  const first = p.exportStatement()
  p.form.currency = 'CNY'
  pending.reject(new Error('旧对账单导出失败')); await first
  assert.equal(p.actions.error, '')
  assert.equal(p.actions.exporting, false)
  assert.deepEqual(p.navigation, [])
})
