import test from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import ts from 'typescript'
import * as Vue from 'vue'
import { compile } from '@vue/compiler-dom'
import { loadVueScript } from './contracts/load-vue-script.mjs'

const file = new URL('../src/modules/ar/CustomerLedger.vue', import.meta.url)
const source = readFileSync(file, 'utf8')
const statusCode = ts.transpileModule(readFileSync(new URL('../src/utils/status.ts', import.meta.url), 'utf8'), { compilerOptions: { module: ts.ModuleKind.ESNext } }).outputText
const { statusDef } = await import('data:text/javascript;base64,' + Buffer.from(statusCode).toString('base64'))
const balances = (extra = {}) => ({ customerName: '华南商贸', currency: 'MXN', openAr: '1200.50', prepaid: 0, refundable: null, used: 800, limit: 1000, available: 200, ...extra })
const entry = (extra = {}) => ({ id: 3, type: '收款', no: 'RC-00003', at: '2026-10-24T01:00:00Z', amount: 100, status: 'CONFIRMED', ...extra })
const deferred = () => { let resolve, reject; const promise = new Promise((yes, no) => { resolve = yes; reject = no }); return { promise, resolve, reject } }
const tick = () => new Promise(resolve => setImmediate(resolve))

function setup(t, get = async path => path.endsWith('/balances') ? balances() : [entry()], customerId = 601) {
  const scope = Vue.effectScope(), route = Vue.reactive({ params: { id: customerId } }), calls = [], mounted = [], unmounted = [], navigation = []
  const names = ['load', 'balance', 'records', 'customerName', 'currency', 'eventCurrency', 'eventStatus', 'router', 'id', 'metrics', 'creditFields']
  const exposed = names.filter(name => new RegExp(`\\b(?:const|let|function)\\s+${name}\\b`).test(source))
  const page = scope.run(() => loadVueScript(file, {
    computed: Vue.computed, ref: Vue.ref, reactive: Vue.reactive, watch: Vue.watch,
    onMounted: fn => mounted.push(fn), onBeforeUnmount: fn => unmounted.push(fn),
    useRoute: () => route, useRouter: () => ({ push: path => navigation.push(path) }), statusDef,
    http: { get: (...args) => { calls.push(args); return get(...args) } },
  }, exposed))
  const dispose = () => { unmounted.splice(0).forEach(fn => fn()); scope.stop() }
  t.after(dispose)
  return { ...page, route, calls, mounted, dispose, navigation }
}

function states(page) {
  assert.ok(page.balance && page.records, '余额和往来记录需要独立的读取状态')
}

function render(page) {
  const money = [], dates = []
  const renderer = Vue.createRenderer({
    createElement: tag => ({ tag, children: [] }), createText: text => ({ text }), createComment: comment => ({ comment }),
    setText: (node, text) => { node.text = text }, setElementText: (node, text) => { node.text = text },
    insert: (node, parent) => parent.children.push(node), remove() {}, patchProp: (node, key, _, value) => { node[key] = value }, parentNode: () => null, nextSibling: () => null,
  })
  const code = compile(source.match(/<template>([\s\S]*)<\/template>/)[1], { mode: 'function', prefixIdentifiers: true }).code
  const app = renderer.createApp({ setup: () => page, render: new Function('Vue', code)(Vue) })
  for (const [name, tag] of [['ElButton', 'button'], ['ElTimeline', 'ol'], ['ElTimelineItem', 'li'], ['ElTag', 'tag'], ['ElSkeleton', 'skeleton']]) {
    app.component(name, Vue.defineComponent({ setup: (_, ctx) => () => Vue.h(tag, ctx.attrs, ctx.slots.default?.()) }))
  }
  app.component('ElEmpty', Vue.defineComponent({ props: ['description'], setup: props => () => Vue.h('empty', props.description) }))
  app.component('ElAlert', Vue.defineComponent({ props: ['title'], setup: (props, ctx) => () => Vue.h('alert', [props.title, ctx.slots.default?.()]) }))
  app.component('MoneyText', Vue.defineComponent({ props: ['value', 'currency'], setup: props => { money.push({ ...props }); return () => Vue.h('money', props.value == null || props.value === '' ? '-' : `${props.currency} ${props.value}`) } }))
  app.component('DateTimeText', Vue.defineComponent({ props: ['value', 'knownDate'], setup: props => { dates.push({ ...props }); return () => Vue.h('time', props.value || (props.knownDate ? `来源日期 ${props.knownDate}（时刻未知）` : '-')) } }))
  app.config.warnHandler = warning => { throw new Error(warning) }
  const root = { children: [] }
  app.mount(root)
  const nodes = (function walk(node) { return [node, ...(node.children ?? []).filter(Boolean).flatMap(walk)] })(root)
  const text = nodes.map(node => node.text ?? '').join('')
  app.unmount()
  return { nodes, text, money, dates }
}

test('进入页面同时读取余额和记录，未完成时展示加载而非空记录', async t => {
  const pending = deferred(), p = setup(t, () => pending.promise)
  states(p)
  p.mounted.forEach(fn => fn())
  assert.equal(p.calls.length, 2)
  assert.equal(p.balance.loading, true)
  assert.equal(p.records.loading, true)
  assert.doesNotMatch(render(p).text, /暂无往来记录/)
  assert.ok(p.calls.every(args => args[2]?.silent === true))
  pending.resolve([])
  await tick()
})

test('余额失败不阻断往来记录，单独重试余额保留已读记录', async t => {
  let fail = true
  const p = setup(t, async path => { if (path.endsWith('/timeline')) return [entry()]; if (fail) throw new Error('余额服务暂不可用'); return balances() })
  states(p)
  await p.load()
  assert.equal(p.balance.error, '余额服务暂不可用')
  assert.deepEqual(p.records.data, [entry()])
  assert.match(render(p).text, /余额服务暂不可用/)
  fail = false
  const retry = render(p).nodes.find(node => node.tag === 'button' && node.children?.some(child => /重新读取余额/.test(child.text ?? '')))
  await retry.onClick()
  assert.equal(p.balance.error, '')
  assert.equal(p.balance.data.customerName, '华南商贸')
  assert.equal(p.calls.filter(([path]) => path.endsWith('/timeline')).length, 1)
})

test('记录失败保留余额且不能伪装为空记录，单独重试可以恢复', async t => {
  let fail = true
  const p = setup(t, async path => { if (path.endsWith('/balances')) return balances(); if (fail) throw new Error('没有往来查看权限'); return [] })
  states(p)
  await p.load()
  assert.equal(p.balance.data.openAr, '1200.50')
  const failed = render(p)
  assert.match(failed.text, /没有往来查看权限/)
  assert.doesNotMatch(failed.text, /暂无往来记录/)
  fail = false
  const retry = failed.nodes.find(node => node.tag === 'button' && node.children?.some(child => /重新读取记录/.test(child.text ?? '')))
  await retry.onClick()
  assert.match(render(p).text, /暂无往来记录/)
  assert.equal(p.calls.filter(([path]) => path.endsWith('/balances')).length, 1)
})

test('切换客户立刻清空旧数据，迟到的旧客户成功和失败都不覆盖新客户', async t => {
  const oldBalance = deferred(), oldRecords = deferred()
  const p = setup(t, path => path.includes('/601/') ? (path.endsWith('/balances') ? oldBalance.promise : oldRecords.promise) : Promise.resolve(path.endsWith('/balances') ? balances({ customerName: '新客户' }) : [entry({ no: 'NEW' })]))
  states(p)
  const old = p.load()
  p.balance.data = balances()
  p.records.data = [entry()]
  p.route.params.id = 602
  assert.equal(p.balance.data, null)
  assert.equal(p.records.data, null)
  await tick()
  oldBalance.resolve(balances({ customerName: '旧客户' }))
  oldRecords.reject(new Error('旧客户失败'))
  await old
  assert.equal(p.balance.data.customerName, '新客户')
  assert.equal(p.records.data[0].no, 'NEW')
  assert.equal(p.records.error, '')
  assert.equal(p.balance.loading, false)
})

test('同一客户重复刷新仅接受最新请求结果', async t => {
  const old = deferred()
  let round = 0
  const p = setup(t, path => ++round <= 2 ? old.promise : Promise.resolve(path.endsWith('/balances') ? balances({ openAr: 25 }) : []))
  states(p)
  const first = p.load()
  await p.load()
  old.resolve(balances({ openAr: 999 }))
  await first
  assert.equal(p.balance.data.openAr, 25)
  assert.deepEqual(p.records.data, [])
  assert.equal(p.records.error, '')
})

test('卸载后不再写入未完成请求结果', async t => {
  const pending = deferred(), p = setup(t, () => pending.promise)
  states(p)
  const request = p.load()
  p.dispose()
  pending.resolve(balances())
  await request
  assert.equal(p.balance.data, null)
  assert.equal(p.records.data, null)
})

test('无效客户编号显示错误且不发送请求', async t => {
  const p = setup(t, undefined, '无效编号')
  states(p)
  await p.load()
  assert.equal(p.calls.length, 0)
  assert.match(p.balance.error, /客户编号/)
  assert.match(p.records.error, /客户编号/)
})

test('接口格式错误明确失败，不能用空数组或空余额掩盖', async t => {
  const p = setup(t, async path => path.endsWith('/balances') ? [] : { records: [] })
  states(p)
  await p.load()
  assert.match(p.balance.error, /格式/)
  assert.match(p.records.error, /格式/)
  assert.doesNotMatch(render(p).text, /暂无往来记录/)
  assert.equal(p.records.data, null)
})

test('事件币种类型和金额格式异常显示读取错误，避免渲染崩溃或伪造零值', async t => {
  for (const invalid of [entry({ currency: 123 }), entry({ amount: '金额异常' }), null]) {
    const p = setup(t, async path => path.endsWith('/balances') ? balances({ openAr: ' ' }) : [invalid])
    states(p)
    await p.load()
    assert.match(p.balance.error, /格式/)
    assert.match(p.records.error, /格式/)
    assert.doesNotMatch(render(p).text, /暂无往来记录/)
  }
})

test('缺少事件金额保持缺失，零金额仍显示并显式传入查询币种', async t => {
  const p = setup(t)
  states(p)
  p.balance.data = balances()
  p.records.data = [entry({ no: 'ZERO', amount: 0 }), entry({ no: 'MISSING', amount: undefined })]
  const result = render(p)
  assert.match(result.text, /华南商贸/)
  assert.match(result.text, /客户编号/)
  assert.match(result.text, /本次读取 2 条/)
  assert.match(result.text, /授信/)
  assert.match(result.text, /金额未提供/)
  assert.ok(result.money.some(item => item.value === 0 && item.currency === 'MXN'))
  assert.ok(result.money.every(item => item.currency === 'MXN'))
  assert.equal(result.money.filter(item => item.value === 100).length, 0)
})

test('查询币种未知时不触发金额组件的默认币种，并可使用事件明确币种', t => {
  const p = setup(t)
  states(p)
  p.balance.data = balances({ currency: undefined })
  p.records.data = [entry(), entry({ id: 4, currency: 'USD' })]
  const result = render(p)
  assert.equal(result.money.length, 1)
  assert.equal(result.money[0].currency, 'USD')
  assert.match(result.text, /币种未提供/)
})

test('仅有来源日期时交给现有时间组件表达时刻未知', t => {
  const p = setup(t)
  states(p)
  p.balance.data = balances()
  p.records.data = [entry({ at: null, bizDate: '2026-10-23' })]
  const result = render(p)
  assert.deepEqual(result.dates, [{ value: null, knownDate: '2026-10-23' }])
  assert.match(result.text, /来源日期 2026-10-23（时刻未知）/)
})

test('贷项生效、收款确认与未知状态分别保留准确业务语义', t => {
  const p = setup(t)
  states(p)
  p.balance.data = balances()
  p.records.data = [entry({ type: '贷项', status: 'ACTIVE' }), entry(), entry({ id: 4, status: 'FUTURE_STATUS' })]
  const result = render(p)
  assert.match(result.text, /已生效/)
  assert.match(result.text, /已确认/)
  assert.match(result.text, /FUTURE_STATUS/)
  assert.equal(result.nodes.find(node => node.tag === 'tag' && node.children?.some(child => child.text === 'FUTURE_STATUS'))?.type, 'info')
})

test('无客户名称时保留实际客户标识，页面命令调用现有返回和刷新入口', async t => {
  const p = setup(t)
  states(p)
  p.balance.data = balances({ customerName: null })
  p.records.data = []
  const result = render(p)
  assert.match(result.text, /客户 #601/)
  const buttons = result.nodes.filter(node => node.tag === 'button')
  buttons.find(node => node.children?.some(child => /返回应收/.test(child.text ?? ''))).onClick()
  assert.deepEqual(p.navigation, ['/ar/receivables'])
  await buttons.find(node => node.children?.some(child => /刷新/.test(child.text ?? ''))).onClick()
  assert.equal(p.calls.length, 2)
})
