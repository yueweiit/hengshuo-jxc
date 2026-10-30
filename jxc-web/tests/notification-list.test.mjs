import test from 'node:test'
import assert from 'node:assert/strict'
import { computed, ref } from 'vue'
import { loadVueScript } from './contracts/load-vue-script.mjs'
import { readFileSync } from 'node:fs'
import * as Vue from 'vue'
import { compile } from '@vue/compiler-dom'
import { renderToString } from '@vue/server-renderer'

const file = new URL('../src/modules/workbench/NotificationList.vue', import.meta.url)
const result = (records = [], total = records.length) => ({ records, total, page: 1, size: 20 })
function setup(options = {}) {
  const calls = []
  const hooks = { mounted: [], unmounted: [] }
  const country = { current: { id: 1, name: '测试国家' }, epoch: 1 }
  class BizError extends Error { constructor(code, message) { super(message); this.code = code } }
  const p = loadVueScript(file, {
    computed, ref, BizError,
    onMounted: fn => hooks.mounted.push(fn), onBeforeUnmount: fn => hooks.unmounted.push(fn),
    useCountryStore: () => country,
    useRouter: () => ({ push: async link => { calls.push(['route', link]); await options.route?.(link) } }),
    useTodoStore: () => ({ refresh: async () => { calls.push(['summary']); await options.summary?.() } }),
    http: {
      get: async (url, query) => { calls.push(['get', url, query]); return options.get ? await options.get(url, query) : result() },
      post: async url => { calls.push(['post', url]); await options.post?.(url) },
    },
    ElMessageBox: { confirm: async (...args) => { calls.push(['confirm', ...args]); if (options.cancel) throw 'cancel'; await options.confirm?.() } },
    ElMessage: { success: message => calls.push(['success', message]) },
  }, ['load', 'open', 'readAll', 'refresh', 'changeFilter', 'changeSize', 'changePage', 'toggleContent', 'typeDef', 'longContent', 'rows', 'page', 'size', 'sizeOptions', 'total', 'allCount', 'unreadCount', 'loading', 'unreadOnly', 'readingId', 'readingAll', 'error', 'countError', 'actionError', 'summaryError', 'permissionDenied', 'expanded', 'busy', 'noCountry', 'hasList', 'canReadAll'])
  return { ...p, calls, hooks, country, BizError }
}

test('notification reads include a separate opposite-filter total using the existing endpoint', async () => {
  const p = setup()
  await p.load()
  assert.equal(p.calls.filter(call => call[0] === 'get').length, 2)
  assert.deepEqual(p.calls[1], ['get', '/sys/notifications', { unread: true, page: 1, size: 1 }])
})

test('all-read cancellation never writes notifications', async () => {
  const p = setup({ cancel: true })
  await p.readAll()
  assert.equal(p.calls.some(call => call[0] === 'confirm'), true)
  assert.equal(p.calls.some(call => call[0] === 'post'), false)
})

test('a failed read is handled locally and cannot open the business destination', async () => {
  const p = setup({ post: async () => { throw new Error('标记失败') } })
  await assert.doesNotReject(() => p.open({ id: 8, readAt: null, link: '/jobs' }))
  assert.equal(p.calls.some(call => call[0] === 'route'), false)
  assert.equal(p.actionError.value, '标记失败')
})

test('page and size are sent to the server without slicing the returned records', async () => {
  const p = setup({ get: async (_, q) => q.size === 1 ? result([], 8) : result([{ id: 21 }], 67) })
  p.page.value = 2
  await p.load()
  assert.deepEqual(p.calls[0], ['get', '/sys/notifications', { unread: undefined, page: 2, size: 20 }])
  assert.equal(p.total.value, 67)
  assert.equal(p.allCount.value, 67)
  assert.equal(p.unreadCount.value, 8)
  assert.deepEqual(p.rows.value, [{ id: 21 }])
  await p.changeSize(50)
  assert.equal(p.page.value, 1)
  assert.equal(p.size.value, 50)
  assert.equal(p.calls.filter(call => call[0] === 'get' && call[2].size !== 1).at(-1)[2].size, 50)
})

test('unread filtering resets the page and requests the complete all-notification count', async () => {
  const p = setup({ get: async (_, q) => result([], q.unread ? 8 : 67) })
  p.page.value = 4
  await p.changeFilter(true)
  assert.equal(p.page.value, 1)
  assert.equal(p.unreadOnly.value, true)
  assert.deepEqual(p.calls[0][2], { unread: true, page: 1, size: 20 })
  assert.deepEqual(p.calls[1][2], { unread: undefined, page: 1, size: 1 })
  assert.equal(p.allCount.value, 67)
  assert.equal(p.unreadCount.value, 8)
})

test('a shrinking server result reloads the last valid page', async () => {
  const p = setup({ get: async (_, q) => result(q.page > 1 ? [] : [{ id: 9 }], 9) })
  p.page.value = 4
  await p.load()
  assert.equal(p.page.value, 1)
  assert.deepEqual(p.calls.filter(call => call[0] === 'get' && call[2].size === 20).map(call => call[2].page), [4, 1])
  assert.deepEqual(p.rows.value, [{ id: 9 }])
})

test('a count failure leaves the successful list usable and the unknown count unavailable', async () => {
  const p = setup({ get: async (_, q) => { if (q.size === 1) throw new Error('计数超时'); return result([{ id: 1 }], 28) } })
  await p.load()
  assert.equal(p.error.value, '')
  assert.equal(p.countError.value, '计数超时')
  assert.equal(p.unreadCount.value, null)
  assert.equal(p.allCount.value, 28)
  assert.equal(p.rows.value.length, 1)
})

test('a failed list is distinct from a successful empty result', async () => {
  const p = setup({ get: async (_, q) => { if (q.size !== 1) throw new Error('通知查询失败'); return result() } })
  await p.load()
  assert.equal(p.error.value, '通知查询失败')
  assert.equal(p.hasList.value, false)
  assert.equal(p.allCount.value, null)
  const empty = setup()
  await empty.load()
  assert.equal(empty.error.value, '')
  assert.equal(empty.hasList.value, true)
  assert.equal(empty.total.value, 0)
  assert.equal(empty.unreadCount.value, 0)
})

test('an empty error message still shows failure rather than a successful empty list', async () => {
  const p = setup({ get: async () => { throw new Error('') } })
  await p.load()
  assert.equal(p.error.value, '通知加载失败，请重试')
  assert.equal(p.hasList.value, false)
})

test('permission failures and missing countries do not masquerade as empty notifications', async () => {
  const p = setup({ get: async () => { throw new p.BizError('SYS_FORBIDDEN', '国家尚未授权') } })
  await p.load()
  assert.equal(p.permissionDenied.value, true)
  assert.equal(p.error.value, '国家尚未授权')
  const missing = setup()
  missing.country.current = null
  await missing.load()
  assert.deepEqual(missing.calls, [])
})

test('late requests cannot replace newer records or finish their loading indicator', async () => {
  const pending = []
  const p = setup({ get: () => new Promise(resolve => pending.push(resolve)) })
  const old = p.load()
  p.page.value = 2
  const recent = p.load()
  pending[0](result([{ id: 'old' }], 67)); pending[1](result([], 8))
  await old
  assert.equal(p.loading.value, true)
  pending[2](result([{ id: 'new' }], 67)); pending[3](result([], 9))
  await recent
  assert.deepEqual(p.rows.value, [{ id: 'new' }])
  assert.equal(p.unreadCount.value, 9)
  assert.equal(p.loading.value, false)
})

test('country changes and unmounts discard pending list results', async () => {
  for (const invalidate of [p => p.country.epoch++, p => p.hooks.unmounted.forEach(fn => fn())]) {
    const pending = []
    const p = setup({ get: () => new Promise(resolve => pending.push(resolve)) })
    const request = p.load()
    invalidate(p)
    pending.forEach(resolve => resolve(result([{ id: 'old-scope' }], 1)))
    await request
    assert.deepEqual(p.rows.value, [])
    assert.equal(p.allCount.value, null)
  }
})

test('single-read completion refreshes the existing store before opening the original link', async () => {
  const p = setup()
  const row = { id: 8, readAt: null, link: '/original-document' }
  await p.open(row)
  assert.deepEqual(p.calls, [['post', '/sys/notifications/8/read'], ['summary'], ['route', '/original-document']])
  assert(row.readAt)
  assert.equal(p.readingId.value, null)
})

test('an already-read notification does not repeat its write', async () => {
  const p = setup()
  await p.open({ id: 8, readAt: '2026-10-22T12:00:00Z', link: '/jobs' })
  assert.deepEqual(p.calls, [['route', '/jobs']])
})

test('a notification without a business link expands its body and reloads the current list', async () => {
  const row = { id: 8, readAt: null, title: '通知', content: '完整正文' }
  const p = setup({ get: async () => result([row]) })
  await p.open(row)
  assert.equal(p.calls.some(call => call[0] === 'route'), false)
  assert(p.expanded.value.has(8))
  assert.equal(p.rows.value[0].content, '完整正文')
})

test('expanding and collapsing a long body never marks it as read', () => {
  const p = setup()
  assert(p.longContent({ content: '第一行\n第二行' }))
  p.toggleContent(8); assert(p.expanded.value.has(8))
  p.toggleContent(8); assert(!p.expanded.value.has(8))
  assert.deepEqual(p.calls, [])
})

test('a single read prevents duplicate writes and stops old-country navigation', async () => {
  let release
  const p = setup({ post: () => new Promise(resolve => { release = resolve }) })
  const row = { id: 8, readAt: null, link: '/jobs' }
  const first = p.open(row)
  await p.open(row)
  assert.equal(p.calls.filter(call => call[0] === 'post').length, 1)
  p.country.epoch++
  release()
  await first
  assert.equal(p.calls.some(call => call[0] === 'route'), false)
  assert.equal(row.readAt, null)
})

test('a summary refresh failure stays visible without misreporting the successful read', async () => {
  const p = setup({ summary: async () => { throw new Error('角标超时') } })
  await p.open({ id: 8, readAt: null, link: '/jobs' })
  assert.equal(p.summaryError.value, '角标超时')
  assert.equal(p.actionError.value, '')
  assert.deepEqual(p.calls.at(-1), ['route', '/jobs'])
})

test('a route failure after marking read explains which part succeeded', async () => {
  const p = setup({ route: async () => { throw new Error('路由失败') } })
  await p.open({ id: 8, readAt: null, link: '/jobs' })
  assert.match(p.actionError.value, /通知已标为已读.*路由失败/)
})

test('confirmed all-read writes once and reloads through the current filter', async () => {
  const p = setup()
  p.unreadOnly.value = true
  p.unreadCount.value = 27
  await p.readAll()
  assert.match(p.calls[0][1], /测试国家.*27 条.*其他分页/)
  assert.equal(p.calls.filter(call => call[0] === 'post').length, 1)
  assert.deepEqual(p.calls.find(call => call[0] === 'post'), ['post', '/sys/notifications/read-all'])
  assert.equal(p.calls.find(call => call[0] === 'get')[2].unread, true)
  assert.equal(p.unreadCount.value, 0)
  assert.equal(p.readingAll.value, false)
})

test('country changes during all-read confirmation never submit to the new country', async () => {
  const p = setup({ confirm: async () => { p.country.epoch++ } })
  await p.readAll()
  assert.equal(p.calls.some(call => call[0] === 'post'), false)
})

test('all-read failures retain unread counts and display an action error', async () => {
  const p = setup({ post: async () => { throw new Error('全部已读失败') } })
  p.unreadCount.value = 8
  await p.readAll()
  assert.equal(p.unreadCount.value, 8)
  assert.equal(p.actionError.value, '全部已读失败')
  assert.equal(p.readingAll.value, false)
})

test('all-read prevents repeated confirmation and writes while an operation is pending', async () => {
  let release
  const p = setup({ confirm: () => new Promise(resolve => { release = resolve }) })
  const first = p.readAll()
  await p.readAll()
  assert.equal(p.calls.filter(call => call[0] === 'confirm').length, 1)
  release(); await first
  assert.equal(p.calls.filter(call => call[0] === 'post').length, 1)
})

test('unknown types remain explicit, including inherited object-property names', () => {
  const p = setup()
  for (const value of [null, undefined, '']) assert.equal(p.typeDef(value).label, '类型未提供')
  for (const value of ['FUTURE_TYPE', 'constructor']) assert.equal(p.typeDef(value).label, value)
  assert.equal(p.typeDef('CC').label, '抄送')
})

test('unsupported sizes and invalid pages do not issue new requests', async () => {
  const p = setup()
  await p.changeSize(7)
  await p.changePage(0)
  await p.changePage(9)
  assert.deepEqual(p.calls, [])
})

const template = readFileSync(file, 'utf8').match(/<template>([\s\S]*?)<\/template>/)[1]
const render = new Function('Vue', compile(template, { mode: 'function', prefixIdentifiers: true }).code)(Vue)
async function renderPage(p) {
  const app = Vue.createSSRApp({ setup: () => p, render })
  app.component('DateTimeText', { props: ['value'], setup: props => () => Vue.h('time', { datetime: props.value }, props.value) })
  for (const name of ['el-button', 'el-icon', 'el-alert', 'el-pagination']) {
    app.component(name, { props: ['title'], setup: (props, { slots, attrs }) => () => Vue.h(name === 'el-button' ? 'button' : 'div', attrs, props.title || slots.default?.()) })
  }
  for (const name of ['Refresh', 'Check', 'Sort', 'OfficeBuilding', 'Loading', 'Lock', 'Warning', 'Bell', 'CopyDocument', 'CircleCheck']) app.component(name, () => Vue.h('span'))
  return renderToString(app)
}

test('the actual template renders escaped content, time props and explicit missing types', async () => {
  const p = setup()
  p.rows.value = [{ id: 1, title: '<img onerror=x>', content: '<script>bad</script>', createdAt: '2026-10-23T08:30:00Z', readAt: null }]
  const html = await renderPage(p)
  assert(html.includes('&lt;img onerror=x&gt;'))
  assert(!html.includes('<script>bad'))
  assert(html.includes('类型未提供'))
  assert(html.includes('datetime="2026-10-23T08:30:00Z"'))
  assert(!html.includes('HTML 审核稿'))
})

test('the actual template distinguishes failed reads, forbidden access and successful no-unread results', async () => {
  const p = setup()
  p.error.value = '服务不可用'
  let html = await renderPage(p)
  assert(html.includes('通知加载失败'))
  assert(html.includes('通知数量暂不可用'))
  assert(!html.includes('共 0 条'))
  p.permissionDenied.value = true
  html = await renderPage(p)
  assert(html.includes('暂无查看权限'))
  p.error.value = ''; p.permissionDenied.value = false; p.unreadOnly.value = true
  html = await renderPage(p)
  assert(html.includes('暂时没有未读通知'))
  assert(html.includes('共 0 条'))
})
