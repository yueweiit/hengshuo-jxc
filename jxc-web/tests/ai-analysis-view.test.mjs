import test from 'node:test'
import assert from 'node:assert/strict'
import * as Vue from 'vue'
import { compile } from '@vue/compiler-dom'
import { readFileSync } from 'node:fs'
import { loadVueScript } from './contracts/load-vue-script.mjs'

const file = new URL('../src/modules/analysis/AiView.vue', import.meta.url)
const response = { output: '净销售与出库成本需要分别核对。', disclaimer: '仅按已登记数据解释。' }
const availableBooks = [
  { id: 6, name: '测试账套', baseCurrency: 'MXN', status: 'ACTIVE', periods: [{ id: 7, name: '2026-10' }, { id: 8, name: '2026-11' }] },
  { id: 9, name: '另一账套', baseCurrency: 'CNY', status: 'ACTIVE', periods: [{ id: 10, name: '2026-09' }] },
  { id: 11, name: '未启用账套', baseCurrency: 'MXN', status: 'DRAFT', periods: [] },
]
class BizError extends Error { constructor(code, message) { super(message); this.code = code } }
function setup(options = {}) {
  const calls = []
  const country = { current: { name: '测试国家' }, epoch: 1 }
  const hooks = { mounted: [], unmounted: [] }
  const page = loadVueScript(file, {
    reactive: Vue.reactive, ref: Vue.ref, computed: Vue.computed, BizError, useCountryStore: () => country,
    onMounted: fn => hooks.mounted.push(fn), onBeforeUnmount: fn => hooks.unmounted.push(fn),
    http: {
      get: async (...args) => { calls.push(['get', ...args]); return options.get ? options.get(...args) : availableBooks },
      post: async (url, body, config) => { calls.push(['post', url, { ...body }, config]); return options.post ? options.post(url, body) : response },
    },
  }, ['form', 'result', 'ask', 'books', 'activeBooks', 'periods', 'selectedBook', 'selectedPeriod', 'booksBusy', 'booksError', 'busy', 'error', 'errorCode', 'providerUnavailable', 'canAsk', 'loadBooks', 'changeBook', 'clearAnalysis', 'resetForm', 'useExample', 'sourceLabel', 'exampleQuestions', 'country'])
  page.books.value = availableBooks
  return { ...page, calls, country, hooks }
}
function selected(options) { const p = setup(options); Object.assign(p.form, { bookId: 6, periodId: 7 }); return p }
function deferred() { let resolve, reject; const promise = new Promise((yes, no) => { resolve = yes; reject = no }); return { promise, resolve, reject } }

test('analysis sends the explicit book and period without the unsupported product filter', async () => {
  const p = setup()
  Object.assign(p.form, { bookId: 6, periodId: 7, question: '  解释毛利  ' })
  await p.ask()
  assert.deepEqual(p.calls.find(call => call[0] === 'post')?.[2], { bookId: 6, periodId: 7, question: '解释毛利' })
})

test('analysis does not send a request before a book and period are selected', async () => {
  const p = setup()
  await p.ask()
  assert.equal(p.calls.some(call => call[0] === 'post'), false)
})

test('a successful envelope without analysis text cannot become a successful result', async () => {
  const p = setup({ post: async () => ({ disclaimer: '没有正文' }) })
  Object.assign(p.form, { bookId: 6, periodId: 7 })
  await p.ask()
  assert.equal(p.result.value, null)
  assert.match(p.error.value, /缺少有效正文/)
})

test('book loading uses the scoped existing endpoint and never guesses a selection', async () => {
  const p = setup()
  await p.hooks.mounted[0]()
  assert.deepEqual(p.calls[0], ['get', '/fin/books', undefined, { silent: true }])
  assert.equal(p.activeBooks.value.length, 2)
  assert.equal(p.form.bookId, undefined)
  assert.equal(p.booksBusy.value, false)
})

test('book failures remain visible and a successful retry replaces the failure', async () => {
  let fail = true
  const p = setup({ get: async () => { if (fail) throw new Error('账套读取超时'); return availableBooks } })
  await p.loadBooks()
  assert.equal(p.booksError.value, '账套读取超时')
  assert.deepEqual(p.books.value, [])
  fail = false
  await p.loadBooks()
  assert.equal(p.booksError.value, '')
  assert.equal(p.activeBooks.value.length, 2)
})

test('a genuine empty book list remains distinct from malformed book data', async () => {
  const p = setup({ get: async () => [] })
  await p.loadBooks()
  assert.equal(p.booksError.value, '')
  assert.equal(p.activeBooks.value.length, 0)
  const broken = setup({ get: async () => [{ ...availableBooks[0], periods: null }] })
  await broken.loadBooks()
  assert.match(broken.booksError.value, /数据格式异常/)
})

test('an inactive book or a period owned by another book cannot start analysis', async () => {
  const p = selected()
  p.form.periodId = 10
  await p.ask()
  p.form.bookId = 11
  await p.ask()
  assert.equal(p.calls.length, 0)
  assert.match(p.error.value, /请选择可用账套和会计期间/)
})

test('an optional blank question keeps the selected scope and never invents a prompt', async () => {
  const p = selected()
  await p.ask()
  assert.deepEqual(p.calls[0], ['post', '/ai/analysis', { bookId: 6, periodId: 7, question: '' }, { silent: true }])
  assert.equal(p.result.value.output, response.output)
})

test('duplicate clicks send one request and loading ends only after its response', async () => {
  const pending = deferred(), p = selected({ post: () => pending.promise })
  const first = p.ask()
  assert.equal(p.busy.value, true)
  assert.equal(p.canAsk.value, false)
  await p.ask()
  assert.equal(p.calls.length, 1)
  pending.resolve(response)
  await first
  assert.equal(p.busy.value, false)
  assert.equal(p.canAsk.value, true)
})

test('provider-not-configured remains an explicit failure with retained user input', async () => {
  const p = selected({ post: async () => { throw new BizError('AI_PROVIDER_NOT_CONFIGURED', 'AI供应商尚未配置，未生成分析或模型历史') } })
  p.form.question = '核对这个月毛利'
  await p.ask()
  assert.equal(p.providerUnavailable.value, true)
  assert.match(p.error.value, /尚未配置/)
  assert.equal(p.result.value, null)
  assert.equal(p.form.question, '核对这个月毛利')
  assert.equal(p.calls.length, 1, 'no automatic retry')
})

test('permission failures keep their actual reason and remain retryable without stale results', async () => {
  let fail = false
  const p = selected({ post: async () => { if (fail) throw new BizError('FORBIDDEN', '没有利润字段权限'); return response } })
  await p.ask()
  fail = true
  await p.ask()
  assert.equal(p.result.value, null)
  assert.equal(p.error.value, '没有利润字段权限')
  assert.equal(p.providerUnavailable.value, false)
  assert.equal(p.busy.value, false)
  fail = false
  await p.ask()
  assert.equal(p.error.value, '')
  assert.equal(p.result.value.output, response.output)
})

test('book changes clear the previous period and explanation', async () => {
  const p = selected()
  await p.ask()
  p.form.bookId = 9
  p.changeBook()
  assert.equal(p.form.periodId, undefined)
  assert.equal(p.result.value, null)
  assert.equal(p.canAsk.value, false)
  assert.deepEqual(p.periods.value.map(period => period.id), [10])
})

test('reset clears only the analysis form while retaining available book choices', async () => {
  const p = selected()
  p.form.question = '解释毛利'
  await p.ask()
  p.resetForm()
  assert.deepEqual({ ...p.form }, { bookId: undefined, periodId: undefined, question: '' })
  assert.equal(p.result.value, null)
  assert.equal(p.books.value.length, 3)
})

test('an example fills the question and invalidates old results without sending a request', async () => {
  const p = selected()
  await p.ask()
  p.useExample(p.exampleQuestions[0])
  assert.equal(p.form.question, p.exampleQuestions[0])
  assert.equal(p.result.value, null)
  assert.equal(p.calls.length, 1)
})

test('a previous-period response cannot replace a new result or stop its loading indicator', async () => {
  const old = deferred(), latest = deferred()
  const p = selected({ post: (_, body) => body.periodId === 7 ? old.promise : latest.promise })
  const first = p.ask()
  p.form.periodId = 8
  p.clearAnalysis()
  const second = p.ask()
  old.resolve({ output: '旧期间' })
  await first
  assert.equal(p.result.value, null)
  assert.equal(p.busy.value, true)
  latest.resolve({ output: '新期间' })
  await second
  assert.equal(p.result.value.output, '新期间')
  assert.equal(p.busy.value, false)
})

for (const cause of ['country', 'unmount', 'reset']) {
  test(`${cause} invalidation discards late analysis success and failure`, async () => {
    for (const fails of [false, true]) {
      const pending = deferred(), p = selected({ post: () => pending.promise })
      const request = p.ask()
      if (cause === 'country') p.country.epoch++
      else if (cause === 'unmount') p.hooks.unmounted[0]()
      else p.resetForm()
      if (fails) pending.reject(new Error('过期错误'))
      else pending.resolve({ output: '过期结果' })
      await request
      assert.equal(p.result.value, null)
      assert.equal(p.error.value, '')
    }
  })
}

test('overlapping book loads keep the latest list and its loading state', async () => {
  const old = deferred(), latest = deferred()
  let count = 0
  const p = setup({ get: () => ++count === 1 ? old.promise : latest.promise })
  const first = p.loadBooks(), second = p.loadBooks()
  old.reject(new Error('旧错误'))
  await first
  assert.equal(p.booksError.value, '')
  assert.equal(p.booksBusy.value, true)
  latest.resolve([availableBooks[1]])
  await second
  assert.equal(p.activeBooks.value[0].id, 9)
  assert.equal(p.booksBusy.value, false)
})

for (const cause of ['country', 'unmount']) {
  test(`${cause} invalidation discards a late book list or error`, async () => {
    for (const fails of [false, true]) {
      const pending = deferred(), p = setup({ get: () => pending.promise })
      const request = p.loadBooks()
      if (cause === 'country') p.country.epoch++
      else p.hooks.unmounted[0]()
      if (fails) pending.reject(new Error('过期账套错误'))
      else pending.resolve(availableBooks)
      await request
      assert.deepEqual(p.books.value, [])
      assert.equal(p.booksError.value, '')
    }
  })
}

test('invalid optional metadata cannot silently masquerade as a valid result', async () => {
  for (const extra of [{ sources: {} }, { createdAt: 42 }, { completeness: {} }]) {
    const p = selected({ post: async () => ({ ...response, ...extra }) })
    await p.ask()
    assert.equal(p.result.value, null)
    assert.match(p.error.value, /格式异常/)
  }
})

test('sources show only supplied identifiers and never invent a document destination', () => {
  const p = setup()
  assert.equal(p.sourceLabel({ sourceNo: 'OUT-71' }), 'OUT-71')
  assert.equal(p.sourceLabel({ productCode: 'SKU-8' }), 'SKU-8')
  assert.equal(p.sourceLabel({ productId: 8 }), '商品编号 #8')
  assert.equal(p.sourceLabel({}), '来源标识未提供')
})

const source = readFileSync(file, 'utf8')
const template = source.slice(source.indexOf('<template>') + 10, source.lastIndexOf('</template>'))
const render = new Function('Vue', compile(template, { mode: 'function', prefixIdentifiers: true }).code)(Vue)
function renderPage(page) {
  const renderer = Vue.createRenderer({
    createElement: tag => ({ tag, children: [] }), createText: text => ({ text }), createComment: () => ({}),
    setText: (node, text) => { node.text = text }, setElementText: (node, text) => { node.text = text },
    insert: (node, parent) => parent.children.push(node), remove() {}, patchProp: (node, key, _old, value) => { node[key] = value },
    parentNode: () => null, nextSibling: () => null,
  })
  const app = renderer.createApp({ setup: () => page, render })
  for (const name of ['ElForm', 'ElFormItem', 'ElSelect', 'ElOption', 'ElInput', 'ElButton', 'ElTag', 'ElSkeleton']) {
    app.component(name, { setup: (_, context) => () => Vue.h(name === 'ElButton' ? 'button' : 'div', context.attrs, context.slots.default?.()) })
  }
  app.component('ElAlert', { props: ['title', 'description'], setup: props => () => Vue.h('aside', [props.title, props.description]) })
  app.component('ElEmpty', { props: ['description'], setup: props => () => Vue.h('p', props.description) })
  app.component('StatusTag', { props: ['status'], setup: props => () => Vue.h('span', `完整度:${props.status}`) })
  app.component('DateTimeText', { props: ['value'], setup: props => () => Vue.h('time', props.value) })
  const root = { children: [] }
  app.mount(root)
  const walk = node => [node, ...(node.children ?? []).flatMap(walk)]
  const nodes = walk(root), text = nodes.map(node => node.text ?? '').join('')
  app.unmount()
  return { nodes, text }
}

test('the compiled template labels all inputs and initially guides the next action', () => {
  const actual = renderPage(setup())
  assert.match(actual.text, /选择账套和会计期间/)
  for (const id of ['ai-book', 'ai-period', 'ai-question']) assert.ok(actual.nodes.some(node => node.id === id))
  assert.equal(actual.nodes.some(node => node.tag === 'el-card'), false)
})

test('the compiled failure view keeps provider configuration visible instead of a success or empty state', async () => {
  const p = selected({ post: async () => { throw new BizError('AI_PROVIDER_NOT_CONFIGURED', '尚未配置模型') } })
  await p.ask()
  const actual = renderPage(p)
  assert.match(actual.text, /AI 分析暂不可用，服务尚未配置/)
  assert.match(actual.text, /尚未配置模型/)
  assert.doesNotMatch(actual.text, /选择账套和会计期间，开始查看/)
})

test('the compiled loading view and book failure keep their own status and retry guidance', async () => {
  const pending = deferred(), p = selected({ post: () => pending.promise })
  const request = p.ask()
  const loading = renderPage(p)
  assert.match(loading.text, /正在读取数据并生成解释/)
  assert.ok(loading.nodes.some(node => node['aria-busy'] === true))
  pending.resolve(response)
  await request
  const failed = setup({ get: async () => { throw new Error('无权读取账套') } })
  await failed.loadBooks()
  const actual = renderPage(failed)
  assert.match(actual.text, /账套与期间加载失败/)
  assert.match(actual.text, /无权读取账套/)
  assert.match(actual.text, /重新加载/)
  assert.doesNotMatch(actual.text, /当前没有可用账套/)
})

test('the compiled result view renders plain text and delegates provided status and time', async () => {
  const output = '<script>不能执行</script>\n真实解释'
  const p = selected({ post: async () => ({ output, completeness: 'INSUFFICIENT', createdAt: '2026-10-24T01:00:00Z', sources: [{ productCode: 'SKU-8' }] }) })
  await p.ask()
  const actual = renderPage(p)
  assert.match(actual.text, /<script>不能执行<\/script>/)
  assert.equal(actual.nodes.some(node => node.tag === 'script' || 'innerHTML' in node), false)
  assert.match(actual.text, /完整度:INSUFFICIENT/)
  assert.match(actual.text, /2026-10-24T01:00:00Z/)
  assert.match(actual.text, /SKU-8/)
  assert.match(actual.text, /未提供免责声明/)
})

test('the compiled result explicitly identifies absent time, completeness and sources', async () => {
  const p = selected()
  await p.ask()
  const actual = renderPage(p)
  assert.match(actual.text, /数据完整度未提供/)
  assert.match(actual.text, /生成时间未提供/)
  assert.match(actual.text, /未提供可核对的来源标识/)
})
