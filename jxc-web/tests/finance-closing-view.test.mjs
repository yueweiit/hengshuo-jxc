import test from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import ts from 'typescript'
import * as Vue from 'vue'
import { compile } from '@vue/compiler-dom'
import {loadVueScript, errorFeedback, feedbackText } from './contracts/load-vue-script.mjs'

const file = new URL('../src/modules/finance/ClosingView.vue', import.meta.url)
const source = readFileSync(file, 'utf8')
const statusCode = ts.transpileModule(readFileSync(new URL('../src/utils/status.ts', import.meta.url), 'utf8'), { compilerOptions: { module: ts.ModuleKind.ESNext } }).outputText
const { statusDef } = await import('data:text/javascript;base64,' + Buffer.from(statusCode).toString('base64'))
const book = () => ({ id: 1, name: '中国账套', baseCurrency: 'CNY', periods: [
  { id: 11, name: '2026-10', startDate: '2026-10-01', endDate: '2026-10-31', status: 'OPEN' },
  { id: 12, name: '2026-11', startDate: '2026-11-01', endDate: '2026-11-30', status: 'OPEN' },
] })
const check = (extra = {}) => ({ checkCode: 'AR_DIFF', result: 'PASS', message: '往来核对', detail: [], ...extra })
const checked = (extra = {}) => ({ checks: [check()], canClose: true, closeGeneration: 2, status: 'PENDING_CLOSE', ...extra })
const impactResult = (extra = {}) => ({ canReopen: true, dependencies: [], closedDependencies: [], snapshotRefs: [], ...extra })
const deferred = () => { let resolve, reject; const promise = new Promise((a, b) => { resolve = a; reject = b }); return { promise, resolve, reject } }

function setup(t, options = {}) {
  const scope = Vue.effectScope(), calls = [], messages = [], mounted = [], unmounted = [], intents = []
  const permissions = new Set(options.permissions ?? ['fin:period:close', 'fin:period:reopen'])
  const names = ['books', 'bookId', 'periodId', 'checks', 'canClose', 'busy', 'booksLoading', 'booksError', 'operationError', 'impactError', 'hasChecked', 'summary', 'readyToClose', 'snapshots', 'impact', 'closeGeneration', 'loadBooks', 'run', 'waive', 'close', 'previewReopen', 'reopen', 'detailPath', 'sourceName', 'checkName', 'periodLabel', 'snapshotName', 'selected', 'currency', 'periods', 'action', 'demo', 'user', 'country', 'statusDef', 'dependencyRows']
  const exposed = names.filter(name => new RegExp(`\\b${name}\\b`).test(source.split('</script>')[0]))
  const page = scope.run(() => loadVueScript(file, {
    computed: Vue.computed, ref: Vue.ref, watch: Vue.watch,
    onMounted: fn => mounted.push(fn), onBeforeUnmount: fn => unmounted.push(fn),
    useUserStore: () => ({ hasPerm: permission => permissions.has(permission) }),
    useCountryStore: () => ({ current: { name: '中国' }, currency: 'CNY', timezone: 'Asia/Shanghai' }),
    statusDef,
    financeSourcePath: item => item.sourceId ? { path: '/source/' + item.sourceId } : null,
    createCommandIntent: () => { const intent = { resets: 0, reset() { this.resets++ } }; intents.push(intent); return intent },
    ElMessage: { success: value => messages.push(value) },
    ElMessageBox: {
      confirm: (...args) => options.confirm?.(...args) ?? Promise.resolve(),
      prompt: (...args) => options.prompt?.(...args) ?? Promise.resolve({ value: '  不影响本期核算  ' }),
    },
    http: {
      get: (...args) => { calls.push(['get', ...args]); return options.get?.(...args) ?? Promise.resolve(args[0] === '/fin/books' ? [book()] : impactResult()) },
      postIdem: (...args) => { calls.push(['post', ...args]); return options.post?.(...args) ?? Promise.resolve(checked()) },
    },
  }, exposed))
  const dispose = () => { unmounted.splice(0).forEach(fn => fn()); scope.stop() }
  t.after(dispose)
  return { ...page, calls, messages, mounted, permissions, intents, dispose }
}
async function select(p, status = 'OPEN') {
  await p.loadBooks()
  p.bookId.value = 1
  p.periodId.value = 11
  p.books.value[0].periods[0].status = status
  await Vue.nextTick()
}
function states(p) {
  assert.ok(p.booksError && p.operationError && p.impactError, '读取、命令和影响预览应有明确的持久错误状态')
}
function render(p, audit = {}) {
  const renderer = Vue.createRenderer({
    createElement: tag => ({ tag, children: [] }), createText: text => ({ text }), createComment: comment => ({ comment }),
    setText: (node, text) => { node.text = text }, setElementText: (node, text) => { node.text = text },
    insert: (node, parent) => parent.children.push(node), remove() {}, patchProp: (node, key, _, value) => { node[key] = value }, parentNode: () => null, nextSibling: () => null,
  })
  const code = compile(source.match(/<template>([\s\S]*)<\/template>/)[1], { mode: 'function', prefixIdentifiers: true }).code
  const renderCode = ts.transpileModule(code, { compilerOptions: { target: ts.ScriptTarget.ES2022 } }).outputText
  const app = renderer.createApp({ setup: () => p, render: new Function('Vue', renderCode)(Vue) })
  for (const name of ['ElButton', 'ElForm', 'ElFormItem', 'ElSelect', 'ElOption', 'ElTag', 'ElSkeleton', 'StatusTag', 'RouterLink']) {
    app.component(name, Vue.defineComponent({ setup: (_, ctx) => () => Vue.h(name, ctx.attrs, ctx.slots.default?.()) }))
  }
  app.component('ElAlert', Vue.defineComponent({ props: ['title'], setup: (props, ctx) => () => Vue.h('alert', [props.title, ctx.slots.default?.()]) }))
  app.component('ElEmpty', Vue.defineComponent({ props: ['description'], setup: props => () => Vue.h('empty', props.description) }))
  app.component('ElTable', Vue.defineComponent({ props: ['data'], setup: (props, ctx) => {
    Vue.provide('closing-test-rows', Vue.computed(() => props.data))
    return () => Vue.h('table', ctx.slots.default?.())
  } }))
  app.component('ElTableColumn', Vue.defineComponent({ props: ['prop', 'label'], setup: (props, ctx) => {
    const rows = Vue.inject('closing-test-rows')
    return () => Vue.h('column', [props.label, ...rows.value.map(row => ctx.slots.default?.({ row }) ?? String(row[props.prop] ?? ''))])
  } }))
  app.component('MoneyText', Vue.defineComponent({ props: ['value', 'currency'], setup: props => {
    ;(audit.money ??= []).push({ ...props })
    return () => Vue.h('money', props.value == null ? '-' : `${props.currency} ${props.value}`)
  } }))
  app.directive('loading', {})
  app.config.warnHandler = warning => { throw new Error(warning) }
  const root = { children: [] }
  app.mount(root)
  const text = (function walk(n) { return (n.text ?? '') + (n.children ?? []).map(walk).join('') })(root)
  app.unmount()
  return text
}

test('账套首次读取展示加载；失败保留原因，重新读取恢复且不伪装无账套', async t => {
  const pending = deferred(); let round = 0
  const p = setup(t, { get: () => ++round === 1 ? pending.promise : Promise.resolve([book()]) })
  states(p)
  const loading = p.loadBooks()
  assert.equal(p.booksLoading.value, true)
  assert.doesNotMatch(render(p), /暂无可用账套/)
  pending.reject(new Error('账套服务超时'))
  await loading
  assert.equal(p.booksError.value, '账套服务超时')
  assert.match(feedbackText(), /账套服务超时/); assert.doesNotMatch(render(p), /账套服务超时/)
  assert.doesNotMatch(render(p), /暂无可用账套/)
  await p.loadBooks()
  assert.equal(p.booksError.value, '')
  assert.equal(p.books.value.length, 1)
})

test('成功空账套与损坏响应分别显示空态和响应错误', async t => {
  let result = []
  const p = setup(t, { get: async () => result })
  states(p)
  await p.loadBooks()
  assert.match(render(p), /暂无可用账套/)
  result = {}
  await p.loadBooks()
  assert.match(p.booksError.value, /账套.*格式/)
  assert.doesNotMatch(render(p), /暂无可用账套/)
})

test('较晚返回的旧账套请求不得覆盖最新账套', async t => {
  const pending = deferred(); let round = 0
  const p = setup(t, { get: () => ++round === 1 ? pending.promise : Promise.resolve([{ ...book(), name: '最新账套' }]) })
  const old = p.loadBooks()
  await p.loadBooks()
  pending.resolve([{ ...book(), name: '旧账套' }]); await old
  assert.equal(p.books.value[0].name, '最新账套')
})

test('检查失败清除旧检查及可结账标记，空错误消息仍显示明确失败', async t => {
  const p = setup(t, { post: async () => { throw new Error('') } })
  states(p); await select(p)
  p.checks.value = [check()]; p.canClose.value = true
  await p.run()
  assert.deepEqual(p.checks.value, [])
  assert.equal(p.canClose.value, false)
  assert.match(p.operationError.value, /检查.*失败/)
  assert.equal(p.busy.value, false)
})

test('切换期间立即清理检查、快照和影响，并丢弃迟到的检查响应', async t => {
  const pending = deferred(), p = setup(t, { post: () => pending.promise })
  await select(p)
  const old = p.run()
  p.snapshots.value = [{ id: 5 }]; p.impact.value = impactResult()
  p.periodId.value = 12
  assert.deepEqual(p.checks.value, [])
  assert.deepEqual(p.snapshots.value, [])
  assert.equal(p.impact.value, null)
  pending.resolve(checked()); await old
  assert.deepEqual(p.checks.value, [])
  assert.equal(p.canClose.value, false)
})

test('切换账套同步清理期间，卸载后旧请求不回写', async t => {
  const pending = deferred(), p = setup(t, { post: () => pending.promise })
  await select(p)
  const old = p.run()
  p.bookId.value = 2
  assert.equal(p.periodId.value, undefined)
  p.dispose(); pending.resolve(checked()); await old
  assert.deepEqual(p.checks.value, [])
})

test('检查保留服务端可结账条件，未知结果不会计入通过', async t => {
  const p = setup(t, { post: async () => checked({ canClose: false, checks: [check(), check({ result: 'FAIL' }), check({ result: 'WAIVED' }), check({ result: 'FUTURE' })] }) })
  await select(p); await p.run()
  assert.ok(p.summary && p.readyToClose, '摘要与可结账状态应可核查')
  assert.deepEqual(p.summary.value, { total: 4, passed: 1, failed: 1, waived: 1, unknown: 1 })
  assert.equal(p.readyToClose.value, false)
  assert.match(render(p), /待处理|未通过/)
})

test('无结账权限或期间不属于当前账套时不发送检查', async t => {
  const p = setup(t, { permissions: [] })
  await select(p); await p.run()
  assert.equal(p.calls.filter(([method]) => method === 'post').length, 0)
  p.permissions.add('fin:period:close'); p.periodId.value = 99
  await p.run()
  assert.equal(p.calls.filter(([method]) => method === 'post').length, 0)
})

test('格式损坏的检查响应不能冒充成功检查', async t => {
  const p = setup(t, { post: async () => ({ canClose: true, checks: null }) })
  states(p); await select(p); await p.run()
  assert.match(p.operationError.value, /检查.*格式/)
  assert.equal(p.canClose.value, false)
  assert.equal(p.hasChecked.value, false)
})

test('影响预览失败撤销旧可反结账结果，重试可恢复', async t => {
  let fail = true
  const p = setup(t, { get: async path => { if (path === '/fin/books') return [book()]; if (fail) throw new Error('无法读取后续期间'); return impactResult() } })
  states(p); await select(p, 'CLOSED'); p.impact.value = impactResult()
  await p.previewReopen()
  assert.equal(p.impact.value, null)
  assert.equal(p.impactError.value, '无法读取后续期间')
  fail = false; await p.previewReopen()
  assert.equal(p.impact.value.canReopen, true)
  assert.equal(p.impactError.value, '')
})

test('影响响应迟到或依赖数组缺失均不能允许反结账', async t => {
  const pending = deferred(), p = setup(t, { get: path => path === '/fin/books' ? Promise.resolve([book()]) : pending.promise })
  states(p); await select(p, 'CLOSED')
  const old = p.previewReopen(); p.periodId.value = 12
  pending.resolve(impactResult()); await old
  assert.equal(p.impact.value, null)
  p.periodId.value = 11
  // 同一已结束 promise 可复用为下一次已知响应。
  await p.previewReopen()
  assert.equal(p.impact.value.canReopen, true)
  const broken = setup(t, { get: async path => path === '/fin/books' ? [book()] : { canReopen: true } })
  await select(broken, 'CLOSED'); await broken.previewReopen()
  assert.equal(broken.impact.value, null)
  assert.match(broken.impactError.value, /影响.*格式/)
})

test('取消差异确认和结账都不会发送命令或留下失败提示', async t => {
  const p = setup(t, { prompt: () => Promise.reject('cancel'), confirm: () => Promise.reject('close') })
  states(p); await select(p); await p.run()
  const before = p.calls.length
  await p.waive(check({ result: 'FAIL', waivable: true, fingerprint: 'fp', closeGeneration: 2 }))
  await p.close()
  assert.equal(p.calls.length, before)
  assert.equal(p.operationError.value, '')
  assert.equal(p.busy.value, false)
})

test('确认框打开即锁定操作，切期间后确认不得误向新期间结账', async t => {
  const confirmation = deferred(), p = setup(t, { confirm: () => confirmation.promise })
  await select(p); await p.run()
  const pending = p.close()
  assert.equal(p.busy.value, true)
  await p.close()
  p.periodId.value = 12
  confirmation.resolve(); await pending
  assert.equal(p.calls.filter(([, path]) => path.endsWith('/close')).length, 0)
})

test('差异确认复用原指纹、代次、原因及命令意图，成功后重新检查', async t => {
  const p = setup(t)
  await select(p)
  const row = check({ result: 'FAIL', waivable: true, fingerprint: 'original-fp', closeGeneration: 3 })
  p.checks.value = [row]
  await p.waive(p.checks.value[0])
  const call = p.calls.find(([, path]) => path.endsWith('/waive'))
  assert.ok(call)
  assert.deepEqual(call[2], { bookId: 1, checkCode: 'AR_DIFF', reason: '不影响本期核算', fingerprint: 'original-fp', closeGeneration: 3 })
  assert.equal(call[3], p.intents[1])
  assert.ok(p.calls.some(([, path]) => path.endsWith('/close-check')))
})

test('结账成功后账套刷新失败仍保留已结账状态、快照和成功反馈', async t => {
  let refreshFails = false
  const p = setup(t, {
    get: async () => { if (refreshFails) throw new Error('刷新期间超时'); return [book()] },
    post: async path => { if (!path.endsWith('/close')) return checked(); refreshFails = true; return { period: { ...book().periods[0], status: 'CLOSED' }, checks: [check()], snapshots: [{ id: 8, snapshotType: 'REPORT', closeGeneration: 2 }], closeGeneration: 2 } },
  })
  states(p); await select(p); await p.run(); await p.close()
  assert.equal(p.selected.value.status, 'CLOSED')
  assert.equal(p.snapshots.value[0].id, 8)
  assert.equal(p.booksError.value, '刷新期间超时')
  assert.equal(p.operationError.value, '')
  assert.deepEqual(p.messages, ['已结账，该期间已锁定'])
  assert.equal(p.readyToClose.value, false)
})

test('后续期间已结账阻止反结账；成功反结账后清除旧检查并提示重查', async t => {
  const p = setup(t, { post: async () => ({ period: { ...book().periods[0], status: 'OPEN' }, previousGeneration: 2, dependencies: [], snapshotRefs: [{ id: 9 }] }) })
  await select(p, 'CLOSED')
  p.impact.value = impactResult({ canReopen: false, closedDependencies: [{ id: 12 }] })
  await p.reopen()
  assert.equal(p.calls.filter(([method]) => method === 'post').length, 0)
  p.impact.value = impactResult()
  p.checks.value = [check()]; p.canClose.value = true
  await p.reopen()
  assert.equal(p.selected.value.status, 'OPEN')
  assert.deepEqual(p.checks.value, [])
  assert.equal(p.canClose.value, false)
  assert.equal(p.snapshots.value[0].id, 9)
  assert.deepEqual(p.messages, ['已反结账，请重新执行检查'])
})

test('中文检查与期间名称保留未知代码，来源下钻继续携带当前账套', async t => {
  const p = setup(t); await select(p)
  assert.ok(p.checkName, '检查项需要中文名称')
  assert.equal(p.checkName('AR_DIFF'), '应收与总账核对')
  assert.equal(p.checkName('NEW_CHECK'), 'NEW_CHECK')
  assert.equal(p.snapshotName('REPORT'), '财务报表')
  assert.equal(p.periodLabel?.('NOT_STARTED'), '未开始')
  assert.equal(p.periodLabel('OPEN'), '开放')
  assert.equal(p.periodLabel('NEW_STATUS'), 'NEW_STATUS')
  assert.deepEqual(p.detailPath(check({ checkCode: 'EVENTS_OPEN' }), { id: 30 }), { path: '/finance/events', query: { bookId: 1, eventId: 30 } })
  assert.deepEqual(p.detailPath(check({ checkCode: 'UNPOSTED' }), { id: 20 }), { path: '/finance/vouchers', query: { bookId: 1, voucherId: 20 } })
})

test('反结账成功重置原四个命令意图，避免重用旧代次失败请求', async t => {
  const p = setup(t, { post: async () => ({ period: { ...book().periods[0], status: 'OPEN' }, snapshotRefs: [] }) })
  await select(p, 'CLOSED'); p.impact.value = impactResult()
  const before = p.intents.map(intent => intent.resets)
  await p.reopen()
  assert.deepEqual(p.intents.map((intent, index) => intent.resets - before[index]), [1, 1, 1, 1])
})

test('真实反结账响应缺快照引用时保留明确错误，不冒充成功', async t => {
  const p = setup(t, { post: async () => ({ period: { ...book().periods[0], status: 'OPEN' } }) })
  await select(p, 'CLOSED'); p.impact.value = impactResult()
  await p.reopen()
  assert.match(p.operationError.value, /反结账响应.*不完整/)
  assert.deepEqual(p.messages, [])
})

test('失败检查没有明细时不写成通过，金额原样交给MoneyText且缺失金额不补零', async t => {
  const p = setup(t); await select(p)
  p.hasChecked.value = true
  p.checks.value = [check({ result: 'FAIL', detail: [] }), check({ checkCode: 'AP_DIFF', result: 'FAIL', detail: [{ sourceNo: 'AP-0001', businessAmount: '12.34', glAmount: null, diffAmount: '-0.01' }] })]
  const audit = {}, text = render(p, audit)
  assert.match(text, /服务端未返回来源明细/)
  assert.doesNotMatch(text, /此项检查通过/)
  assert.deepEqual(audit.money, [{ value: '12.34', currency: 'CNY' }, { value: null, currency: 'CNY' }, { value: '-0.01', currency: 'CNY' }])
})

test('账套刷新移除当前期间时清理全部旧结果', async t => {
  let removed = false
  const p = setup(t, { get: async () => [{ ...book(), periods: removed ? [] : book().periods }] })
  await select(p); p.checks.value = [check()]; p.canClose.value = true; p.snapshots.value = [{ id: 9 }]
  removed = true; await p.loadBooks()
  assert.equal(p.periodId.value, undefined)
  assert.deepEqual(p.checks.value, [])
  assert.deepEqual(p.snapshots.value, [])
  assert.equal(p.canClose.value, false)
})

test('期间未开放、已关闭或含未知结果时，服务端可结账标记也不能绕过页面限制', async t => {
  const p = setup(t); await select(p)
  p.hasChecked.value = true; p.canClose.value = true; p.checks.value = [check()]
  assert.equal(p.readyToClose.value, true)
  for (const status of ['NOT_STARTED', 'CLOSED']) {
    p.selected.value.status = status
    assert.equal(p.readyToClose.value, false)
  }
  p.selected.value.status = 'OPEN'; p.checks.value = [check({ result: 'UNKNOWN' })]
  assert.equal(p.readyToClose.value, false)
  p.checks.value = []; assert.equal(p.readyToClose.value, false)
})

// Errors are application-level; each case starts with a clean global presentation.
test.beforeEach(() => errorFeedback.clearErrors())
