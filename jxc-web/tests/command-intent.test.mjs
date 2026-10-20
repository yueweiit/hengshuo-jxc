import test from 'node:test'
import assert from 'node:assert/strict'
import { existsSync } from 'node:fs'
import './support.mjs'
import { loadVueScript } from './contracts/load-vue-script.mjs'

const helperUrl = new URL('../src/api/command-intent.ts', import.meta.url)
async function helper() {
  assert.ok(existsSync(helperUrl), 'idempotent commands need an explicit retry intent that survives failures')
  return import(helperUrl.href)
}

test('same failed intent retries with one key; success and changed JSON body create a new key', async () => {
  const { createCommandIntent } = await helper()
  let seq = 0
  const intent = createCommandIntent(() => `key-${++seq}`), keys = []
  const failure = new Error('response disconnected')
  await assert.rejects(intent.run('user1:country1', '/confirm/1', { amount: 10, lines: [1] }, async key => { keys.push(key); throw failure }), e => e === failure)
  await assert.rejects(intent.run('user1:country1', '/confirm/1', { lines: [1], amount: 10 }, async key => { keys.push(key); throw failure }), e => e === failure)
  await intent.run('user1:country1', '/confirm/1', { amount: 11, lines: [1] }, async key => keys.push(key))
  await intent.run('user1:country1', '/confirm/1', { amount: 11, lines: [1] }, async key => keys.push(key))
  assert.deepEqual(keys, ['key-1', 'key-1', 'key-2', 'key-3'])
})

test('changing trusted session/country or reopening a dialog cannot reuse the preceding intent', async () => {
  const { createCommandIntent } = await helper()
  let seq = 0
  const intent = createCommandIntent(() => `key-${++seq}`), keys = []
  const attempt = context => intent.run(context, '/pay/1', {}, async key => { keys.push(key); throw new Error('retry') })
  await assert.rejects(attempt('user1:country1'))
  await assert.rejects(attempt('user1:country2'))
  await assert.rejects(attempt('user2:country2'))
  intent.reset()
  await assert.rejects(attempt('user2:country2'))
  assert.equal(new Set(keys).size, 4)
})

test('double clicks share one in-flight request and an old success cannot clear a newer changed-body retry', async () => {
  const { createCommandIntent } = await helper()
  let seq = 0, sends = 0, release
  const intent = createCommandIntent(() => `key-${++seq}`), keys = []
  const first = intent.run('ctx', '/pay/1', { amount: 1 }, key => { keys.push(key); sends++; return new Promise(resolve => { release = resolve }) })
  const duplicate = intent.run('ctx', '/pay/1', { amount: 1 }, () => { sends++; throw new Error('must not send twice') })
  await Promise.resolve()
  assert.equal(sends, 1)
  await assert.rejects(intent.run('ctx', '/pay/1', { amount: 2 }, async key => { keys.push(key); throw new Error('failed new body') }))
  release('committed')
  assert.deepEqual(await Promise.all([first, duplicate]), ['committed', 'committed'])
  await intent.run('ctx', '/pay/1', { amount: 2 }, async key => keys.push(key))
  assert.deepEqual(keys, ['key-1', 'key-2', 'key-2'])
})

test('PUT payload carries the original fetched version even if a form transform removes or changes it', async () => {
  const { withEditVersion } = await helper()
  assert.deepEqual(withEditVersion({ name: 'changed', version: 999 }, 7), { name: 'changed', version: 7 })
  assert.deepEqual(withEditVersion({ name: 'changed' }, 7), { name: 'changed', version: 7 })
  assert.equal(withEditVersion({ name: 'legacy' }, undefined).version, undefined, 'do not invent a legacy record version')
})

test('critical page calls retain their intent object instead of creating a new key or intent on every click', async () => {
  const { readFileSync, readdirSync } = await import('node:fs')
  const ts = (await import('typescript')).default
  const pages = new URL('../src/modules/', import.meta.url)
  const walk = directory => readdirSync(directory, { withFileTypes: true }).flatMap(entry => entry.isDirectory() ? walk(new URL(`${entry.name}/`, directory)) : [new URL(entry.name, directory)])
  const offenders = []
  for (const file of walk(pages).filter(file => file.pathname.endsWith('.vue'))) {
    const content = readFileSync(file, 'utf8').match(/<script[^>]*>([\s\S]*?)<\/script>/)?.[1]
    if (!content) continue
    const source = ts.createSourceFile(file.pathname, content, ts.ScriptTarget.Latest, true)
    function visit(node) {
      if (ts.isCallExpression(node) && ts.isPropertyAccessExpression(node.expression) && node.expression.name.text === 'postIdem' && ts.isCallExpression(node.arguments[2])) offenders.push(file.pathname)
      ts.forEachChild(node, visit)
    }
    visit(source)
  }
  assert.deepEqual(offenders, [], 'retry clicks must reuse a component/dialog intent; body changes are handled by the shared helper')
})

test('a created outbound draft is reused when its confirmation response fails', async () => {
  const vue = await import('vue')
  const helpers = await helper()
  const file = new URL('../src/modules/sales/SalesOrderDetail.vue', import.meta.url)
  let creates = 0, confirmations = 0
  const order = { id: 1, lines: [{ allocs: [{ id: 10, warehouseId: 401, warehouseName: 'Warehouse', openQty: 2 }] }] }
  const http = {
    get: async url => url.endsWith('/timeline') ? [] : url.endsWith('/outbound-check') ? { checks: [] } : order,
    post: async () => ({ id: 500 + ++creates }),
    postIdem: async (url, body, intent) => {
      if (url === '/sal/outbounds') return { id: 500 + ++creates }
      confirmations++
      if (confirmations === 1) throw new Error('confirmation response lost')
      return { id: 501 }
    },
  }
  const dependencies = { computed: vue.computed, ref: vue.ref, reactive: vue.reactive, onMounted() {}, watch() {}, useRoute: () => ({ params: { id: 1 } }), useRouter: () => ({}), useUserStore: () => ({}), useCountryStore: () => ({ timezone: 'Asia/Shanghai' }), todayIn: () => '2026-10-16', ElMessage: { success() {} }, http, ...helpers, getToken: () => 'test-user', getCountryId: () => 1 }
  const scope = loadVueScript(file, dependencies, ['order', 'ob', 'openOutbound', 'confirmOut'])
  scope.order.value = order
  scope.openOutbound()
  await assert.rejects(scope.confirmOut(), /confirmation response lost/)
  await scope.confirmOut()
  assert.equal(creates, 1, 'one user intent must not create a second outbound draft merely to retry confirm')
  assert.equal(confirmations, 2)
})

test('native country SKU maintenance sends an idempotent versioned command from the original page', async () => {
  const { ref, reactive } = await import('vue')
  const { createCommandIntent } = await helper()
  const commands = []
  const page = loadVueScript(new URL('../src/modules/master/CountrySkuList.vue', import.meta.url), {
    ref, reactive, onMounted() {}, createCommandIntent, useCountryStore: () => ({}), ElMessage: { success() {} },
    http: {
      get: async () => ({ records: [], total: 0 }),
      put: async () => { throw new Error('Native writer rejects a missing UUID Idempotency-Key') },
      putIdem: async (url, body, intent) => { assert.equal(typeof intent.run, 'function'); commands.push([url, body]); return { version: 2 } },
    },
  }, ['save'])
  const row = { productId: 44, version: 1, enabled: false }
  await page.save(row, { enabled: true })
  assert.deepEqual(commands, [['/md/country-skus/44', { enabled: true, version: 1 }]])
  assert.equal(row.enabled, true)
  assert.equal(row.version, 2)
})
