import test from 'node:test'
import assert from 'node:assert/strict'
import { ref } from 'vue'
import { pathToFileURL } from 'node:url'
import { loadVueScript } from './contracts/load-vue-script.mjs'

const file = process.env.JXC_TEST_INVENTORY_ANALYSIS_SOURCE_FILE
  ? pathToFileURL(process.env.JXC_TEST_INVENTORY_ANALYSIS_SOURCE_FILE)
  : new URL('../src/modules/inventory/AnalysisView.vue', import.meta.url)
function deferred() {
  let resolve, reject
  const promise = new Promise((yes, no) => { resolve = yes; reject = no })
  return { promise, resolve, reject }
}
function page({ get = async () => [], list = async () => [] } = {}) {
  const country = { epoch: 1 }
  const unmount = []
  const component = loadVueScript(file, {
    ref, onMounted() {}, onBeforeUnmount: callback => unmount.push(callback),
    useRouter: () => ({ push() {} }), useCountryStore: () => country,
    http: { get }, allRecords: list,
  }, ['load', 'show', 'rows', 'orders', 'current', 'open'])
  return { ...component, country, unmount: () => unmount.forEach(callback => callback()) }
}

test('切换仓库后迟到的第一仓订单不能覆盖当前仓库依据', async () => {
  const first = deferred(), second = deferred()
  const p = page({ get: url => url.endsWith('/11/orders') ? first.promise : second.promise })
  const oldRequest = p.show({ id: 11, dimId: 401 })
  const currentRequest = p.show({ id: 12, dimId: 402 })
  second.resolve([{ docNo: 'CURRENT-WAREHOUSE' }]); await currentRequest
  first.resolve([{ docNo: 'OLD-WAREHOUSE' }]); await oldRequest
  assert.equal(p.current.value.dimId, 402)
  assert.equal(p.orders.value[0].docNo, 'CURRENT-WAREHOUSE')
  assert.equal(p.open.value, true)
})

test('切国家后旧详情请求的上下文取消不产生未捕获错误或打开抽屉', async () => {
  const response = deferred()
  const p = page({ get: () => response.promise })
  const pending = p.show({ id: 11 })
  p.country.epoch++; p.unmount()
  response.reject(Object.assign(new Error('国家已切换'), { code: 'CONTEXT_CHANGED' }))
  await assert.doesNotReject(pending)
  assert.equal(p.open.value, false)
})

test('当前国家当前仓库的读取失败必须继续报错而不能冒充空订单', async () => {
  const failure = new Error('订单依据接口不可用')
  const p = page({ get: async () => { throw failure } })
  await assert.rejects(() => p.show({ id: 11 }), error => error === failure)
  assert.equal(p.open.value, false)
})

test('当前分类列表的真实读取失败不能转换为成功空结果', async () => {
  const failure = new Error('分类结果读取失败')
  const p = page({ list: async () => { throw failure } })
  await assert.rejects(() => p.load(), error => error === failure)
})

test('切国家后迟到的分类列表不能替换原页面状态', async () => {
  const response = deferred()
  const p = page({ list: () => response.promise })
  p.rows.value = [{ id: 'PREVIOUS-STATE' }]
  const pending = p.load()
  p.country.epoch++
  response.resolve([{ id: 'STALE-RESPONSE' }]); await pending
  assert.equal(p.rows.value[0].id, 'PREVIOUS-STATE')
})
