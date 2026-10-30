import test from 'node:test'
import assert from 'node:assert/strict'
import { computed, ref } from 'vue'
import { loadVueScript } from './contracts/load-vue-script.mjs'

const file = new URL('../src/modules/workbench/WorkbenchView.vue', import.meta.url)
const result = (records = [], total = records.length) => ({ records, total, page: 1, size: 10 })
function setup(options = {}) {
  const calls = []
  const hooks = { mounted: [], unmounted: [] }
  const storage = new Map(options.saved ? [['jxc.workbench.page-size', options.saved]] : [])
  const country = { current: { id: 1, code: 'MX', name: '测试国家' }, epoch: 1, currency: 'CNY', timezone: 'America/Mexico_City' }
  const user = { permissions: ['sys:todo:view'], hasPerm: () => false }
  const todo = { total: 67, unreadNotifications: 0, summary: [{ type: 'FIN_EVENT', label: '财务事件待处理', count: 67, link: '/finance/events' }], refresh: async () => { calls.push(['summary']); await options.refresh?.() } }
  const page = loadVueScript(file, {
    computed, ref,
    onMounted: fn => hooks.mounted.push(fn), onBeforeUnmount: fn => hooks.unmounted.push(fn),
    useRouter: () => ({ push: path => { calls.push(['route', path]) } }),
    useCountryStore: () => country, useTodoStore: () => todo, useUserStore: () => user,
    http: {
      get: async (url, query) => { calls.push(['get', url, query]); return await options.get?.(url, query) ?? result() },
      post: async url => { calls.push(['post', url]); await options.post?.(url) },
    },
    localStorage: { getItem: key => storage.get(key), setItem: (key, value) => { if (options.storageFails) throw new Error('storage denied'); storage.set(key, value) } },
    ElMessage: { warning: message => calls.push(['warning', message]) },
    setInterval: () => 42, clearInterval: () => {},
  }, ['page', 'size', 'total', 'todos', 'notifications', 'query', 'order', 'activeType', 'loading', 'todoError', 'noticeError', 'summaryError', 'loadTodos', 'loadNotifications', 'changePage', 'changeSize', 'search', 'openCard', 'openTodo', 'openNotification', 'refreshWorkbench', 'shortcuts'])
  return { ...page, calls, hooks, storage, country, todo, user }
}

test('todo pagination sends current page and size and retains server total', async () => {
  const p = setup({ get: async () => result([{ id: 11 }], 67) })
  await p.changePage(2)
  assert.deepEqual(p.calls[0], ['get', '/sys/todos', { type: undefined, keyword: undefined, order: 'desc', page: 2, size: 10 }])
  assert.equal(p.total.value, 67)
  assert.deepEqual(p.todos.value, [{ id: 11 }])
  assert.equal(p.loading.value, false)
})

test('page-size preferences accept only supported values and size changes reset page', async () => {
  for (const saved of ['20', '50', '200', 'broken']) {
    const p = setup({ saved })
    assert.equal(p.size.value, ['20', '50'].includes(saved) ? Number(saved) : 10)
    p.page.value = 5
    await p.changeSize(20)
    assert.equal(p.page.value, 1)
    assert.equal(p.calls.at(-1)[2].size, 20)
    assert.equal(p.storage.get('jxc.workbench.page-size'), '20')
  }
})

test('storage denial still applies page size and explicitly reports preference was not saved', async () => {
  const p = setup({ storageFails: true })
  await p.changeSize(50)
  assert.equal(p.size.value, 50)
  assert.equal(p.calls.some(call => call[0] === 'warning'), true)
})

test('search and sorting apply to the server query and restart at the first page', async () => {
  const p = setup()
  p.page.value = 5
  p.query.value = '  凭证  '
  p.order.value = 'asc'
  await p.search()
  assert.equal(p.page.value, 1)
  assert.equal(p.calls.at(-1)[2].keyword, '凭证')
  assert.equal(p.calls.at(-1)[2].order, 'asc')
})

test('type selection resets the page and selecting it again clears only that filter', async () => {
  const p = setup()
  p.query.value = '凭证'
  p.page.value = 4
  await p.openCard({ type: 'FIN_EVENT', link: '/finance/events' })
  assert.equal(p.page.value, 1)
  assert.equal(p.calls.at(-1)[2].type, 'FIN_EVENT')
  await p.openCard({ type: 'FIN_EVENT', link: '/finance/events' })
  assert.equal(p.calls.at(-1)[2].type, undefined)
  assert.equal(p.query.value, '凭证')
})

test('approval and missing-configuration summary actions keep their original destinations', async () => {
  const p = setup()
  for (const type of ['APPROVAL', 'CONFIG_MISSING']) await p.openCard({ type, link: '/original-source' })
  assert.deepEqual(p.calls, [['route', '/original-source'], ['route', '/original-source']])
})

test('late responses cannot replace the latest page or stop its loading indicator', async () => {
  const pending = []
  const p = setup({ get: () => new Promise(resolve => pending.push(resolve)) })
  const old = p.loadTodos()
  const current = p.changePage(2)
  pending[0](result([{ id: 'old' }], 67))
  await old
  assert.equal(p.loading.value, true)
  pending[1](result([{ id: 'current' }], 67))
  await current
  assert.deepEqual(p.todos.value, [{ id: 'current' }])
  assert.equal(p.loading.value, false)
})

test('a backlog shrink returns to the last valid page and reloads its records', async () => {
  const p = setup({ get: async (_, q) => q.page === 7 ? result([], 12) : result([{ id: 12 }], 12) })
  await p.changePage(7)
  assert.equal(p.page.value, 2)
  assert.deepEqual(p.calls.filter(call => call[0] === 'get').map(call => call[2].page), [7, 2])
  assert.deepEqual(p.todos.value, [{ id: 12 }])
})

test('failed todo reads show a retryable failure rather than a successful empty result', async () => {
  const p = setup({ get: async () => { throw new Error('待办查询超时') } })
  await p.loadTodos()
  assert.equal(p.todoError.value, '待办查询超时')
  assert.equal(p.loading.value, false)
  assert.deepEqual(p.todos.value, [])
})

test('a successful empty todo read is distinct from a failure', async () => {
  const p = setup()
  await p.loadTodos()
  assert.equal(p.todoError.value, '')
  assert.equal(p.total.value, 0)
})

test('country changes and unmounts discard pending todo responses', async () => {
  for (const invalidate of [p => p.country.epoch++, p => p.hooks.unmounted.forEach(fn => fn())]) {
    let release
    const p = setup({ get: () => new Promise(resolve => { release = resolve }) })
    const request = p.loadTodos()
    invalidate(p)
    release(result([{ id: 'old-country' }], 1))
    await request
    assert.deepEqual(p.todos.value, [])
  }
})

test('notification failures have their own error state and do not pretend every message was read', async () => {
  const p = setup({ get: async () => { throw new Error('通知加载失败') } })
  await p.loadNotifications()
  assert.equal(p.noticeError.value, '通知加载失败')
})

test('notification opens mark read before refreshing and navigating to its existing link', async () => {
  const p = setup()
  await p.openNotification({ id: 8, link: '/original-document' })
  assert.deepEqual(p.calls, [['post', '/sys/notifications/8/read'], ['summary'], ['route', '/original-document']])
})

test('notification write failures never navigate and retain a visible error', async () => {
  const p = setup({ post: async () => { throw new Error('标为已读失败') } })
  await p.openNotification({ id: 8, link: '/original-document' })
  assert.equal(p.noticeError.value, '标为已读失败')
  assert.equal(p.calls.some(call => call[0] === 'route'), false)
})

test('a notification without a business link reloads the unread list', async () => {
  const p = setup()
  await p.openNotification({ id: 8 })
  assert.equal(p.calls.at(-1)[1], '/sys/notifications')
})

test('refresh preserves active pagination while updating todos, unread notifications and counts', async () => {
  const p = setup({ refresh: async () => { throw new Error('待办数量刷新失败') } })
  p.page.value = 2
  await p.refreshWorkbench()
  assert.equal(p.calls.find(call => call[1] === '/sys/todos')[2].page, 2)
  assert.equal(p.calls.some(call => call[1] === '/sys/notifications'), true)
  assert.equal(p.summaryError.value, '待办数量刷新失败')
})

test('missing-country or missing-role pages make no protected API reads', async () => {
  for (const invalidate of [p => { p.country.current = null }, p => { p.user.permissions = [] }]) {
    const p = setup()
    invalidate(p)
    for (const mount of p.hooks.mounted) await mount()
    assert.deepEqual(p.calls, [])
  }
})

test('shortcuts reuse existing routes and gate exports by the existing permission check', () => {
  const p = setup()
  assert.deepEqual(p.shortcuts.value.map(item => item.path), ['/approval/todo', '/notifications'])
  const allowed = setup()
  allowed.user.hasPerm = () => true
  assert.equal(allowed.shortcuts.value.some(item => item.path === '/jobs'), true)
})

test('todo actions use the supplied original link without a synthetic detail route', async () => {
  const p = setup()
  await p.openTodo({ link: '/finance/events' })
  assert.deepEqual(p.calls, [['route', '/finance/events']])
})
