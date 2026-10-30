import test from 'node:test'
import assert from 'node:assert/strict'
import { computed, effectScope, nextTick, reactive, ref, watch } from 'vue'
import { createMemoryHistory, createRouter } from 'vue-router'
import { loadVueScript, errorFeedback } from './contracts/load-vue-script.mjs'

async function setup(t, initialPath = '/workbench') {
  const router = createRouter({
    history: createMemoryHistory(),
    routes: [
      ['/workbench', 'menu.workbench'],
      ['/purchase/orders', 'menu.purchaseOrders'],
      ['/inventory/stocks', 'menu.stocks'],
      ['/sales/orders/:id', 'menu.salesOrderDetail'],
      ['/403', 'menu.forbidden'],
    ].map(([path, title]) => ({ path, meta: { title }, component: { render: () => null } })),
  })
  router.onError(() => {}) // Expected navigation errors are asserted through the UI message below.
  await router.push(initialPath)
  const country = reactive({ epoch: 0, switching: false })
  const errors = []
  const scope = effectScope()
  t.after(() => scope.stop())
  // useRoute exposes reactive getters backed by currentRoute in the mounted application.
  const route = new Proxy({}, { get: (_, key) => router.currentRoute.value[key] })
  const api = scope.run(() => loadVueScript(new URL('../src/layouts/components/RouteTabs.vue', import.meta.url), {
    computed, ref, watch,
    useRoute: () => route,
    useRouter: () => router,
    useCountryStore: () => country,
    useI18n: () => ({ t: key => key }),
    ElMessage: { error: message => errors.push(message) },
    reportError(error, options) { const notice = errorFeedback.reportError(error, options); if (notice) errors.push(notice.message) },
  }, ['items', 'activeKey', 'activateTab', 'removeTab']))
  const open = async path => { await router.push(path); await nextTick() }
  return { ...api, router, country, errors, open }
}

test('a direct business link starts with a fixed workbench and the current page', async t => {
  const p = await setup(t, '/purchase/orders?status=DRAFT')
  assert.deepEqual(p.items.value.map(tab => [tab.key, tab.closable]), [
    ['/workbench', false], ['/purchase/orders', true],
  ])
  assert.equal(p.items.value[1].title, 'menu.purchaseOrders')
  assert.equal(p.activeKey.value, '/purchase/orders')
})

test('external navigation deduplicates the page and tab switching restores its latest query', async t => {
  const p = await setup(t)
  await p.open('/purchase/orders?status=DRAFT')
  await p.open('/purchase/orders?status=APPROVED')
  await p.open('/inventory/stocks')
  assert.deepEqual(p.items.value.map(tab => tab.key), ['/workbench', '/purchase/orders', '/inventory/stocks'])
  assert.equal(await p.activateTab('/purchase/orders'), true)
  assert.equal(p.router.currentRoute.value.fullPath, '/purchase/orders?status=APPROVED')
  assert.equal(p.activeKey.value, '/purchase/orders')
})

test('different document addresses open distinct tabs and revisiting one creates no duplicate', async t => {
  const p = await setup(t)
  await p.open('/sales/orders/71')
  await p.open('/sales/orders/72')
  await p.open('/sales/orders/71')
  assert.deepEqual(p.items.value.map(tab => tab.key), ['/workbench', '/sales/orders/71', '/sales/orders/72'])
  assert.equal(p.activeKey.value, '/sales/orders/71')
})

test('closing an inactive tab leaves the current page and its address intact', async t => {
  const p = await setup(t)
  await p.open('/purchase/orders')
  await p.open('/inventory/stocks?warehouseId=9')
  await p.removeTab('/purchase/orders')
  assert.deepEqual(p.items.value.map(tab => tab.key), ['/workbench', '/inventory/stocks'])
  assert.equal(p.router.currentRoute.value.fullPath, '/inventory/stocks?warehouseId=9')
})

test('closing the active tab returns to the left neighbor before removing it', async t => {
  const p = await setup(t)
  await p.open('/purchase/orders')
  await p.open('/inventory/stocks')
  await p.removeTab('/inventory/stocks')
  assert.equal(p.router.currentRoute.value.path, '/purchase/orders')
  assert.equal(p.activeKey.value, '/purchase/orders')
  assert.deepEqual(p.items.value.map(tab => tab.key), ['/workbench', '/purchase/orders'])
})

test('the last business tab returns to workbench and workbench cannot be removed', async t => {
  const p = await setup(t, '/purchase/orders')
  await p.removeTab('/workbench')
  assert.equal(p.items.value.length, 2)
  assert.equal(p.router.currentRoute.value.path, '/purchase/orders')
  await p.removeTab('/purchase/orders')
  await p.removeTab('/workbench')
  assert.deepEqual(p.items.value.map(tab => tab.key), ['/workbench'])
  assert.equal(p.activeKey.value, '/workbench')
  assert.equal(p.router.currentRoute.value.path, '/workbench')
})

test('a cancelled tab switch keeps the route and active tab together', async t => {
  const p = await setup(t, '/purchase/orders')
  p.router.beforeEach(to => to.path === '/workbench' ? false : true)
  assert.equal(await p.activateTab('/workbench'), false)
  assert.equal(p.activeKey.value, '/purchase/orders')
  assert.equal(p.router.currentRoute.value.path, '/purchase/orders')
})

test('a cancelled close keeps the active tab available', async t => {
  const p = await setup(t, '/purchase/orders')
  p.router.beforeEach(to => to.path === '/workbench' ? false : true)
  await p.removeTab('/purchase/orders')
  assert.deepEqual(p.items.value.map(tab => tab.key), ['/workbench', '/purchase/orders'])
  assert.equal(p.activeKey.value, '/purchase/orders')
})

test('a guard redirect activates the actual destination instead of a denied tab', async t => {
  const p = await setup(t)
  await p.open('/purchase/orders')
  await p.open('/inventory/stocks')
  p.router.beforeEach(to => to.path === '/purchase/orders' ? '/403' : true)
  assert.equal(await p.activateTab('/purchase/orders'), false)
  assert.equal(p.router.currentRoute.value.path, '/403')
  assert.equal(p.activeKey.value, '/403')
  assert.equal(p.items.value.at(-1).title, 'menu.forbidden')
})

test('a navigation exception is shown and does not pretend the current tab was closed', async t => {
  const p = await setup(t, '/purchase/orders')
  p.router.beforeEach(() => { throw new Error('页面加载失败') })
  await p.removeTab('/purchase/orders')
  assert.deepEqual(p.errors, ['页面加载失败'])
  assert.deepEqual(p.items.value.map(tab => tab.key), ['/workbench', '/purchase/orders'])
  assert.equal(p.activeKey.value, '/purchase/orders')
})

test('country switching clears old tabs and registers only the final destination', async t => {
  const p = await setup(t)
  await p.open('/purchase/orders')
  await p.open('/inventory/stocks')
  p.country.switching = true
  p.country.epoch++
  await nextTick()
  assert.deepEqual(p.items.value.map(tab => tab.key), ['/workbench'])
  assert.equal(await p.activateTab('/purchase/orders'), false)
  await p.open('/purchase/orders')
  assert.deepEqual(p.items.value.map(tab => tab.key), ['/workbench'])
  p.country.switching = false
  await nextTick()
  assert.deepEqual(p.items.value.map(tab => tab.key), ['/workbench', '/purchase/orders'])
  assert.equal(p.activeKey.value, '/purchase/orders')
})

test('a direct country epoch change clears history while retaining the current page', async t => {
  const p = await setup(t)
  await p.open('/purchase/orders')
  await p.open('/inventory/stocks')
  p.country.epoch++
  await nextTick()
  assert.deepEqual(p.items.value.map(tab => tab.key), ['/workbench', '/inventory/stocks'])
  assert.equal(p.activeKey.value, '/inventory/stocks')
})

test('a delayed close from the old country cannot remove a tab reopened in the new country', async t => {
  const p = await setup(t, '/purchase/orders')
  let release
  const pending = new Promise(resolve => { release = resolve })
  let entered
  const guardEntered = new Promise(resolve => { entered = resolve })
  p.router.beforeEach(async to => {
    if (to.path === '/workbench') { entered(); await pending }
  })
  const closing = p.removeTab('/purchase/orders')
  await guardEntered
  p.country.switching = true
  p.country.epoch++
  p.country.switching = false
  await nextTick()
  release()
  await closing
  assert.deepEqual(p.items.value.map(tab => tab.key), ['/workbench', '/purchase/orders'])
  assert.equal(p.router.currentRoute.value.path, '/workbench')
})
