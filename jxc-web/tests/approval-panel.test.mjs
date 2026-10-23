import test from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import ts from 'typescript'
import * as Vue from 'vue'
import { compile } from '@vue/compiler-dom'
import { loadVueScript } from './contracts/load-vue-script.mjs'

const file = new URL('../src/components/ApprovalPanel.vue', import.meta.url)
const statusCode = ts.transpileModule(readFileSync(new URL('../src/utils/status.ts', import.meta.url), 'utf8'), { compilerOptions: { module: ts.ModuleKind.ESNext } }).outputText
const { statusDef } = await import('data:text/javascript;base64,' + Buffer.from(statusCode).toString('base64'))
const instance = (override = {}) => ({ id: 10, status: 'APPROVED', ruleName: '大额赊销复核', ruleVersionNo: 3, submittedByName: '陈晓', submittedAt: '2026-10-23T01:00:00Z', finishedAt: '2026-10-23T02:00:00Z', tasks: [{ id: 11, nodeSeq: 1, nodeName: '财务复核', assigneeName: '林悦', status: 'APPROVED', comment: '额度已核对\n同意执行。', actedAt: '2026-10-23T01:59:00Z' }], ...override })

function setup(options = {}) {
  const calls = [], unmounted = []
  const page = loadVueScript(file, {
    ref: Vue.ref, onMounted() {}, onBeforeUnmount: fn => unmounted.push(fn), defineExpose() {},
    defineProps: () => ({ docType: 'SALES_ORDER', docId: 44, presentation: options.presentation ?? 'timeline' }),
    statusDef,
    http: { get: async (...args) => { calls.push(args); return options.get ? await options.get(...args) : [] } },
  }, ['props', 'instances', 'loading', 'loadError', 'load', 'timelineItems'])
  return { ...page, calls, unmounted }
}

function render(page) {
  const dates = [], statuses = []
  const renderer = Vue.createRenderer({
    createElement: tag => ({ tag, children: [] }), createText: text => ({ text }), createComment: text => ({ comment: text }),
    setText: (n, text) => { n.text = text }, setElementText: (n, text) => { n.text = text },
    insert: (n, p) => { p.children.push(n) }, remove() {}, patchProp: (n, k, _, value) => { n[k] = value }, parentNode: () => null, nextSibling: () => null,
  })
  const source = readFileSync(file, 'utf8').match(/<template>([\s\S]*)<\/template>/)[1]
  const code = compile(source, { mode: 'function', prefixIdentifiers: true }).code
  const app = renderer.createApp({ setup: () => page, render: new Function('Vue', code)(Vue) })
  for (const [name, tag] of [['ElTimeline', 'ol'], ['ElTimelineItem', 'li'], ['ElSteps', 'steps'], ['ElStep', 'step'], ['ElButton', 'button'], ['ElSkeleton', 'skeleton']]) {
    app.component(name, Vue.defineComponent({ setup: (_, c) => () => Vue.h(tag, c.attrs, [c.slots.default?.(), c.slots.description?.()]) }))
  }
  app.component('ElEmpty', Vue.defineComponent({ props: ['description'], setup: p => () => Vue.h('empty', p.description) }))
  app.component('ElAlert', Vue.defineComponent({ props: ['title'], setup: (p, c) => () => Vue.h('alert', [p.title, c.slots.default?.()]) }))
  app.component('StatusTag', Vue.defineComponent({ props: ['status', 'domain'], setup: p => { statuses.push({ ...p }); return () => Vue.h('status', p.status) } }))
  app.component('DateTimeText', Vue.defineComponent({ props: ['value'], setup: p => { dates.push(p.value); return () => Vue.h('time', p.value) } }))
  app.directive('loading', {})
  app.config.warnHandler = message => { throw new Error(message) }
  const root = { children: [] }; app.mount(root)
  const walk = node => [node, ...(node.children ?? []).filter(Boolean).flatMap(walk)]
  const nodes = walk(root)
  const text = nodes.map(n => n.text ?? '').join('')
  app.unmount()
  return { nodes, text, dates, statuses }
}

test('timeline items retain real submission, node and completion timestamps and opinions', () => {
  const p = setup(), sample = instance(), items = p.timelineItems(sample)
  assert.equal(items.length, 3)
  assert.equal(new Set(items.map(item => item.key)).size, 3)
  assert.deepEqual(items.map(item => item.title), [sample.submittedAt, sample.tasks[0].actedAt, sample.finishedAt])
  assert.equal(items[1].content, '财务复核')
  assert.equal(items[1].actor, '林悦')
  assert.equal(items[1].comment, '额度已核对\n同意执行。')
  assert.equal(items[1].type, 'success')
})

test('pending and skipped nodes keep explicit untimed labels without fabricating a completion', () => {
  const p = setup(), sample = instance({ status: 'PENDING', finishedAt: null, tasks: [
    { id: 1, nodeName: '财务复核', status: 'PENDING', assigneeName: '林悦', actedAt: null },
    { id: 2, nodeName: '主管复核', status: 'SKIPPED', assigneeName: '周明', actedAt: null },
  ] })
  const items = p.timelineItems(sample)
  assert.equal(items.length, 3)
  assert.equal(items[1].title, null)
  assert.equal(items[1].emptyTime, '尚未处理')
  assert.equal(items[2].emptyTime, '无需处理')
  assert.equal(items[1].type, 'warning')
})

test('a processed node and terminal instance with missing times remain explicitly unknown', () => {
  const p = setup(), sample = instance({ submittedAt: null, finishedAt: null, tasks: [{ id: 1, nodeName: '复核', status: 'REJECTED', assigneeName: '林悦', actedAt: null }] })
  const items = p.timelineItems(sample)
  assert.equal(items[0].emptyTime, '提交时间未记录')
  assert.equal(items[1].emptyTime, '处理时间未记录')
  assert.equal(items[2].emptyTime, '结束时间未记录')
  assert.equal(items[2].title, null)
})

test('personal approval and the instance outcome remain separate and unknown statuses stay neutral', () => {
  const p = setup(), sample = instance({ status: 'REJECTED' })
  const items = p.timelineItems(sample)
  assert.equal(items[1].status, 'APPROVED')
  assert.equal(items[2].status, 'REJECTED')
  assert.equal(items[2].type, 'danger')
  const future = p.timelineItems(instance({ status: 'FUTURE_STATUS', tasks: [{ ...sample.tasks[0], status: 'FUTURE_STATUS' }] }))
  assert.equal(future.length, 2)
  assert.equal(future[1].type, 'info')
})

test('the actual timeline template uses DateTimeText, all events and literal multiline opinions', () => {
  const p = setup(), sample = instance()
  sample.tasks[0].comment = '<img src=x onerror=alert(1)>\n请补凭证。'
  p.instances.value = [sample]
  const actual = render(p)
  assert.equal(actual.nodes.filter(n => n.tag === 'ol').length, 1)
  assert.equal(actual.nodes.filter(n => n.tag === 'li').length, 3)
  assert.equal(actual.nodes.some(n => n.tag === 'steps' || n.tag === 'img'), false)
  assert.ok(actual.text.includes(sample.tasks[0].comment))
  assert.deepEqual(actual.dates, [sample.submittedAt, sample.tasks[0].actedAt, sample.finishedAt])
})

test('the existing default steps presentation remains available to the other callers', () => {
  const p = setup({ presentation: 'steps' }); p.instances.value = [instance()]
  const actual = render(p)
  assert.equal(actual.nodes.filter(n => n.tag === 'steps').length, 1)
  assert.equal(actual.nodes.filter(n => n.tag === 'step').length, 1)
  assert.equal(actual.nodes.some(n => n.tag === 'ol'), false)
  assert.ok(actual.text.includes('额度已核对'))
})

test('all history instances and invalidated or blocked reasons survive timeline rendering', () => {
  const p = setup()
  p.instances.value = [instance({ status: 'INVALIDATED', invalidReason: '金额发生变化' }), instance({ id: 20, status: 'BLOCKED', tasks: [], finishedAt: null })]
  const actual = render(p)
  assert.equal(actual.nodes.filter(n => n.tag === 'ol').length, 2)
  assert.ok(actual.text.includes('金额发生变化'))
  assert.ok(actual.text.includes('没有匹配的审批规则或可用审批人'))
})

test('failed timeline reads clear stale records and retry through the existing endpoint', async () => {
  let fail = true
  const p = setup({ get: async () => { if (fail) throw new Error('审批记录读取超时'); return [instance()] } })
  p.instances.value = [instance()]; await p.load()
  assert.equal(p.loadError.value, '审批记录读取超时')
  assert.deepEqual(p.instances.value, [])
  let actual = render(p)
  assert.ok(actual.text.includes('审批记录加载失败'))
  assert.equal(actual.text.includes('暂无审批记录'), false)
  fail = false; await p.load(); actual = render(p)
  assert.equal(p.loadError.value, '')
  assert.equal(actual.nodes.filter(n => n.tag === 'ol').length, 1)
  assert.deepEqual(p.calls[0].slice(0, 2), ['/wf/instances', { docType: 'SALES_ORDER', docId: 44 }])
})

test('loading, successful empty history and an error are distinct states', async () => {
  let release
  const p = setup({ get: () => new Promise(resolve => { release = resolve }) })
  const request = p.load()
  const busy = render(p)
  assert.equal(busy.text.includes('暂无审批记录'), false)
  release([]); await request
  assert.equal(p.loading.value, false)
  assert.equal(p.loadError.value, '')
  assert.ok(render(p).text.includes('暂无审批记录'))
})

test('an older history response cannot replace the latest successful retry', async () => {
  const requests = []
  const p = setup({ get: () => new Promise(resolve => requests.push(resolve)) })
  const first = p.load(), second = p.load()
  requests[1]([instance({ id: 20 })]); await second
  requests[0]([instance({ id: 10 })]); await first
  assert.equal(p.instances.value[0].id, 20)
})

test('history responses after unmount are discarded', async () => {
  let release
  const p = setup({ get: () => new Promise(resolve => { release = resolve }) })
  const request = p.load(); p.unmounted.forEach(fn => fn()); release([instance()]); await request
  assert.deepEqual(p.instances.value, [])
})

test('the default steps caller keeps its existing rejected-read contract', async () => {
  const p = setup({ presentation: 'steps', get: async () => { throw new Error('无权读取') } })
  await assert.rejects(p.load(), /无权读取/)
})
