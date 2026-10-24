import test from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { computed, nextTick, reactive, ref, watch } from 'vue'
import { loadVueScript } from './contracts/load-vue-script.mjs'

const file = new URL('../src/modules/sales/SalesOrderDetail.vue', import.meta.url)
const source = readFileSync(file, 'utf8')
const fixture = (id = 71) => ({ id, docNo: `SO-${id}`, totalQty: 20, totalAmount: 200, currency: 'MXN', approvalStatus: 'APPROVED', fulfillmentStatus: 'PARTIAL_OUTBOUND', lines: [{ id: 11, productCode: 'SKU-11', productName: '商品', qty: 20, unit: 'PCS', baseQty: 20, cancelledQty: 4, outboundQty: 8, openQty: 8, allocs: [{ id: 31, warehouseId: 401, warehouseName: 'A仓', allocQty: 12, cancelledQty: 4, outboundQty: 4, openQty: 4 }, { id: 32, warehouseId: 402, warehouseName: 'B仓', allocQty: 8, cancelledQty: 0, outboundQty: 4, openQty: 4 }] }] })
const passed = { checks: [{ item: '仓库权限', ok: true, message: '有该仓数据范围' }] }
function deferred() {
  let resolve, reject
  const promise = new Promise((yes, no) => { resolve = yes; reject = no })
  return { promise, resolve, reject }
}
function detail(read) {
  const route = reactive({ params: { id: '71' } }), country = { epoch: 1, timezone: 'America/Mexico_City' }
  const calls = [], writes = [], warnings = [], stops = []
  const names = ['order', 'loading', 'load', 'loadError', 'timeline', 'timelineError', 'timelineLoading', 'loadTimeline', 'ob', 'checks', 'runCheck', 'checkError', 'checkLoading', 'checkedWarehouseId', 'canConfirmOut', 'confirmOut', 'fullOrder', 'warehouses']
  const page = loadVueScript(file, {
    computed, reactive, ref, watch: (...args) => { const stop = watch(...args); stops.push(stop); return stop }, onMounted() {},
    useRoute: () => route, useRouter: () => ({}), useCountryStore: () => country,
    useUserStore: () => ({ hasPerm: () => true, fieldAccess: () => 'WRITE' }),
    createCommandIntent: () => ({}), getCountryId: () => 2, getToken: () => 'owner', todayIn: () => '2026-10-24',
    commandPayloadFingerprint: value => JSON.stringify(value),
    ElMessage: { warning: value => warnings.push(value), success() {} },
    http: {
      get: async (url, params) => { calls.push({ url, params }); return read ? read(url, params) : url.endsWith('/timeline') ? [] : url.endsWith('/outbound-check') ? passed : fixture(Number(url.split('/').at(-1))) },
      postIdem: async (url, body) => { writes.push({ url, body }); return { id: 99 } },
    },
  }, names.filter(name => new RegExp(`(?:function|const|let)\\s+${name}\\b`).test(source)))
  return { ...page, route, country, calls, writes, warnings, dispose: () => stops.forEach(stop => stop()) }
}

test('订单读取失败清除旧订单并保留原因，重试后恢复详情', async t => {
  let failed = true
  const p = detail(url => url.endsWith('/timeline') ? [] : failed ? Promise.reject(new Error('没有查看此订单的权限')) : fixture())
  t.after(p.dispose); p.order.value = fixture(70)
  await p.load()
  assert.equal(p.order.value, null)
  assert.match(p.loadError?.value ?? '', /没有查看此订单的权限/)
  assert.equal(p.loading.value, false)
  failed = false; await p.load()
  assert.equal(p.order.value.id, 71)
  assert.equal(p.loadError.value, '')
})

test('时间线失败不丢失订单，独立重试不重新请求订单', async t => {
  let failed = true
  const p = detail(url => url.endsWith('/timeline') ? failed ? Promise.reject(new Error('时间线服务暂不可用')) : [{ at: '2026-10-24T08:00:00Z', type: '建单', text: 'SO-71' }] : fixture())
  t.after(p.dispose); await p.load()
  assert.equal(p.order.value.id, 71)
  assert.match(p.timelineError?.value ?? '', /时间线服务暂不可用/)
  assert.equal(p.loadError.value, '')
  const count = p.calls.filter(call => call.url === '/sal/orders/71').length
  failed = false; await p.loadTimeline()
  assert.equal(p.timeline.value.length, 1)
  assert.equal(p.timelineError.value, '')
  assert.equal(p.calls.filter(call => call.url === '/sal/orders/71').length, count)
})

test('较慢的旧订单响应不能覆盖新订单或加载状态', async t => {
  const old = deferred()
  const p = detail(url => url.endsWith('/timeline') ? [] : url.endsWith('/71') ? old.promise : fixture(72))
  t.after(p.dispose)
  const pending = p.load(); p.route.params.id = '72'; await p.load()
  old.resolve(fixture()); await pending
  assert.equal(p.order.value.id, 72)
  assert.equal(p.loading.value, false)
  assert.equal(p.loadError?.value, '')
})

test('旧订单请求失败不会污染新订单的错误提示', async t => {
  const old = deferred()
  const p = detail(url => url.endsWith('/timeline') ? [] : url.endsWith('/71') ? old.promise : fixture(72))
  t.after(p.dispose)
  const pending = p.load(); p.route.params.id = '72'; await p.load()
  old.reject(new Error('旧订单连接断开')); await pending
  assert.equal(p.order.value.id, 72)
  assert.equal(p.loadError?.value, '')
})

test('旧时间线响应不能出现在新订单下', async t => {
  const old = deferred()
  const p = detail(url => url === '/sal/orders/71/timeline' ? old.promise : url.endsWith('/timeline') ? [{ type: '建单', text: 'SO-72' }] : fixture(Number(url.split('/').at(-1))))
  t.after(p.dispose)
  const pending = p.load(); await nextTick(); await Promise.resolve()
  p.route.params.id = '72'; await p.load()
  old.resolve([{ type: '建单', text: 'SO-71' }]); await pending
  assert.deepEqual(p.timeline.value.map(item => item.text), ['SO-72'])
})

test('出库检查使用所选分仓，切仓后旧结果立即失效', async t => {
  const p = detail(); t.after(p.dispose); p.order.value = fixture()
  p.ob.warehouseId = 401; await p.runCheck()
  assert.deepEqual(p.calls.at(-1), { url: '/sal/orders/71/outbound-check', params: { warehouseId: 401 } })
  assert.equal(p.checkedWarehouseId?.value, 401)
  assert.equal(p.canConfirmOut.value, true)
  p.ob.warehouseId = 402; await nextTick()
  assert.deepEqual(p.checks.value, [])
  assert.equal(p.checkedWarehouseId.value, undefined)
  assert.equal(p.canConfirmOut.value, false)
})

test('慢仓库检查不能覆盖新仓库结果', async t => {
  const old = deferred()
  const p = detail((_url, params) => params.warehouseId === 401 ? old.promise : { checks: [{ item: 'B仓', ok: false, message: '缺少销售单据' }] })
  t.after(p.dispose); p.order.value = fixture(); p.ob.warehouseId = 401
  const pending = p.runCheck(); p.ob.warehouseId = 402; await p.runCheck()
  old.resolve(passed); await pending
  assert.equal(p.checkedWarehouseId?.value, 402)
  assert.equal(p.checks.value[0].item, 'B仓')
  assert.equal(p.canConfirmOut.value, false)
})

test('检查失败保留原因；成功空记录与失败状态分开', async t => {
  let failed = true
  const p = detail(() => failed ? Promise.reject(new Error('检查接口超时')) : { checks: [] })
  t.after(p.dispose); p.order.value = fixture(); p.ob.warehouseId = 401
  await p.runCheck()
  assert.match(p.checkError?.value ?? '', /检查接口超时/)
  assert.equal(p.canConfirmOut.value, false)
  failed = false; await p.runCheck()
  assert.equal(p.checkError.value, '')
  assert.equal(p.checkedWarehouseId.value, 401)
  assert.deepEqual(p.checks.value, [])
})

test('检查返回格式异常不能作为通过检查的依据', async t => {
  const p = detail(() => ({ checks: [{ item: '仓库权限', message: '缺少结果字段' }] }))
  t.after(p.dispose); p.order.value = fixture(); p.ob.warehouseId = 401
  await p.runCheck()
  assert.match(p.checkError?.value ?? '', /格式/)
  assert.equal(p.checkedWarehouseId.value, undefined)
  assert.equal(p.canConfirmOut.value, false)
})

test('没有可见分仓时不发送检查请求', async t => {
  const p = detail(); t.after(p.dispose)
  p.order.value = { ...fixture(), lines: [] }; await p.runCheck()
  assert.equal(p.calls.length, 0)
  assert.equal(p.canConfirmOut?.value, false)
})

test('检查中和检查失败不能发出出库命令', async t => {
  const check = deferred()
  const p = detail(() => check.promise)
  t.after(p.dispose); p.order.value = fixture(); p.ob.warehouseId = 401
  const pending = p.runCheck()
  await p.confirmOut()
  assert.deepEqual(p.writes, [])
  check.reject(new Error('检查服务失败')); await pending
  await p.confirmOut()
  assert.deepEqual(p.writes, [])
})

test('国家上下文变化后检查响应不生效', async t => {
  const check = deferred()
  const p = detail(() => check.promise)
  t.after(p.dispose); p.order.value = fixture(); p.ob.warehouseId = 401
  const pending = p.runCheck(); p.country.epoch++
  check.resolve(passed); await pending
  assert.equal(p.checkedWarehouseId?.value, undefined)
  assert.equal(p.canConfirmOut?.value, false)
})

test('授权仓库明细不反推被服务端移除的整单汇总', async t => {
  const restricted = fixture(); delete restricted.totalQty; delete restricted.totalAmount
  const p = detail(url => url.endsWith('/timeline') ? [] : restricted)
  t.after(p.dispose); await p.load()
  assert.equal(p.fullOrder.value, false)
  assert.equal(p.order.value.totalQty, undefined)
  assert.equal(p.order.value.totalAmount, undefined)
  assert.equal(p.order.value.lines.length, 1)
})
