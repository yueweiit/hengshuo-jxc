import test from 'node:test'
import assert from 'node:assert/strict'
import { computed, reactive, ref } from 'vue'
import * as Vue from 'vue'
import { readFileSync } from 'node:fs'
import { parse } from '@vue/compiler-sfc'
import { compile } from '@vue/compiler-dom'
import { renderToString } from '@vue/server-renderer'
import { loadVueScript } from './contracts/load-vue-script.mjs'

const phases = ['intlQty', 'pendingDeliveryQty', 'onHoldQty', 'deliveringQty'].map(prop => ({ prop, label: prop }))
const qty = { unit: 'PCS', intlQty: 10, pendingDeliveryQty: 2, onHoldQty: 1, deliveringQty: 3, totalQty: 16, openDiscrepancyQty: 2 }
const result = (records = [], total = records.length) => ({ records: records.map(row => ({ ...qty, shipments: [], ...row })), total, page: 1, size: 20, summary: [{ ...qty }], rule: { status: 'ACTIVE', toleranceHours: 24, message: '' } })
function setup(options = {}) {
  const calls = [], hooks = { unmount: [] }, country = { epoch: 1 }
  const p = loadVueScript(new URL('../src/modules/logistics/InTransitBoard.vue', import.meta.url), {
    computed, reactive, ref, onMounted() {}, onBeforeUnmount: fn => hooks.unmount.push(fn),
    useRouter: () => ({ push() {} }), useCountryStore: () => country,
    BUCKETS: phases, MX_WAREHOUSE_SOURCE: {}, PRODUCT_SOURCE: {},
    http: { get: async (url, q, config) => { calls.push({ url, query: { ...q }, config }); return options.get ? options.get(url, q) : result() } },
  }, ['draft', 'applied', 'rows', 'summary', 'page', 'size', 'total', 'delayed', 'delayPage', 'delaySize', 'delayTotal', 'delayRule', 'loading', 'delayLoading', 'boardError', 'delayError', 'loadBoard', 'loadDelays', 'search', 'reset', 'refresh', 'changePage', 'changeSize', 'changeDelayPage', 'changeDelaySize', 'metrics', 'phases', 'filtered', 'open', 'MX_WAREHOUSE_SOURCE', 'PRODUCT_SOURCE'])
  return { ...p, calls, hooks, country }
}

test('search commits one filter snapshot, resets both pages and keeps edits separate until submitted', async () => {
  const p = setup()
  p.page.value = 3; p.delayPage.value = 4
  p.draft.warehouseId = 401; p.draft.productId = 501
  await p.search()
  assert.equal(p.page.value, 1); assert.equal(p.delayPage.value, 1)
  assert.equal(p.calls.length, 2)
  for (const c of p.calls) assert.deepEqual([c.query.warehouseId, c.query.productId], [401, 501])
  p.draft.productId = 502
  await p.changePage(2)
  assert.equal(p.calls.at(-1).query.productId, 501)
  assert.equal(p.calls.at(-1).query.page, 2)
})

test('server totals and unit summaries remain independent of the current page rows', async () => {
  const p = setup({ get: async () => result([{ id: 'one-row' }], 71) })
  await p.loadBoard()
  assert.equal(p.total.value, 71)
  assert.equal(p.rows.value.length, 1)
  assert.equal(p.summary.value[0].totalQty, 16)
  assert.equal(p.summary.value[0].openDiscrepancyQty, 2)
})

test('read failures keep summary unknown and do not turn a failed delay read into no delays', async () => {
  const p = setup({ get: async () => { throw new Error('在途查询超时') } })
  await p.refresh()
  assert.equal(p.boardError.value, '在途查询超时')
  assert.equal(p.delayError.value, '在途查询超时')
  assert.equal(p.summary.value, null)
  assert.equal(p.delayRule.value, null)
  assert.equal(p.loading.value, false); assert.equal(p.delayLoading.value, false)
})

test('main and delay reads fail and retry independently', async () => {
  let fails = true
  const p = setup({ get: async (_, q) => {
    if (q.view === 'delays' && fails) throw new Error('延误查询失败')
    return result([], 0)
  } })
  await p.refresh()
  assert.equal(p.boardError.value, ''); assert.equal(p.delayError.value, '延误查询失败')
  fails = false; await p.loadDelays()
  assert.equal(p.delayError.value, ''); assert.equal(p.delayTotal.value, 0)
})

test('late responses cannot replace a later page or finish its loading state', async () => {
  const pending = []
  const p = setup({ get: () => new Promise(resolve => pending.push(resolve)) })
  const old = p.loadBoard(), current = p.changePage(2)
  pending[0](result([{ id: 'old' }])); await old
  assert.equal(p.loading.value, true)
  pending[1]({ ...result([{ id: 'current' }], 40), page: 2 }); await current
  assert.equal(p.rows.value[0].id, 'current'); assert.equal(p.loading.value, false)
})

test('reset clears filters and both page-size changes restart their own pagination', async () => {
  const p = setup()
  p.draft.productId = 501; await p.search()
  p.page.value = 3; p.delayPage.value = 4
  await p.changeSize(50); await p.changeDelaySize(100)
  assert.equal(p.page.value, 1); assert.equal(p.delayPage.value, 1)
  assert.equal(p.calls.at(-1).query.view, 'delays'); assert.equal(p.calls.at(-1).query.size, 100)
  await p.reset()
  assert.equal(p.applied.productId, undefined); assert.equal(p.draft.productId, undefined)
})

test('successful empty results and missing delay configuration remain distinct', async () => {
  const p = setup({ get: async () => ({ ...result(), rule: { status: 'MISSING', toleranceHours: null, message: '尚未配置延误容忍时长' } }) })
  await p.refresh()
  assert.equal(p.boardError.value, ''); assert.deepEqual(p.rows.value, [])
  assert.equal(p.delayError.value, ''); assert.equal(p.delayRule.value.status, 'MISSING')
})

test('missing summary and missing quantities are explicit failures rather than zero defaults', async () => {
  for (const data of [{ ...result(), summary: undefined }, { ...result(), summary: [{ unit: 'PCS' }] }]) {
    const p = setup({ get: async () => data })
    await p.loadBoard()
    assert.match(p.boardError.value, /汇总|数量/)
    assert.equal(p.summary.value, null)
  }
})

test('an active delay rule without a valid tolerance or complete records is a read failure', async () => {
  for (const data of [{ ...result(), rule: { status: 'ACTIVE', toleranceHours: null } }, { ...result([{ id: 1 }]) }]) {
    const p = setup({ get: async () => data })
    await p.loadDelays()
    assert.match(p.delayError.value, /延误/)
    assert.equal(p.delayRule.value, null)
  }
})

const template = parse(readFileSync(new URL('../src/modules/logistics/InTransitBoard.vue', import.meta.url), 'utf8')).descriptor.template.content
const render = new Function('Vue', compile(template, { mode: 'function', prefixIdentifiers: true }).code)(Vue)
async function renderPage(p) {
  const app = Vue.createSSRApp({ setup: () => p, render })
  app.directive('loading', { getSSRProps: () => ({}) })
  for (const name of ['el-form', 'el-form-item', 'el-button', 'el-icon', 'el-tag', 'el-pagination', 'el-alert']) {
    app.component(name, { props: ['label', 'title', 'description'], setup: (props, { slots }) => () => Vue.h(name === 'el-button' ? 'button' : 'div', {}, [props.label, props.title, props.description, slots.default?.()]) })
  }
  app.component('el-table', { props: ['data', 'emptyText'], setup(props, { slots }) { Vue.provide('testRows', props.data); return () => Vue.h('div', {}, props.data?.length ? slots.default?.() : props.emptyText) } })
  app.component('el-table-column', { props: ['label'], setup(props, { slots }) { const rows = Vue.inject('testRows'); return () => Vue.h('div', {}, [props.label, ...rows.map(row => slots.default?.({ row }))]) } })
  app.component('QtyText', { props: ['value', 'unit'], setup: props => () => Vue.h('span', {}, `${props.value} ${props.unit}`) })
  app.component('FieldInput', () => Vue.h('input'))
  app.component('Refresh', () => Vue.h('span'))
  for (const name of ['StatusTag', 'DateTimeText', 'ProductCell']) app.component(name, () => Vue.h('span'))
  return renderToString(app)
}

test('the real template keeps mixed units in separate quantity displays', async () => {
  const p = setup()
  p.summary.value = [{ ...qty, unit: 'PCS' }, { ...qty, unit: 'KG', totalQty: 3 }]
  const html = await renderPage(p)
  assert.match(html, /16 PCS/); assert.match(html, /3 KG/)
})

test('the real template renders failure and missing-rule messages without successful-empty claims', async () => {
  const p = setup()
  p.boardError.value = '网络断开'
  p.delayRule.value = { status: 'MISSING', toleranceHours: null, message: '尚未配置物流延误容忍时长' }
  const html = await renderPage(p)
  assert.match(html, /在途数量读取失败/); assert.match(html, /网络断开/)
  assert.match(html, /尚未配置物流延误容忍时长/)
  assert.doesNotMatch(html, /当前没有延误批次|当前没有在途或未结差异/)
})

for (const invalidate of ['country', 'unmount']) {
  test(`${invalidate} invalidates pending main and delay responses`, async () => {
    const pending = []
    const p = setup({ get: () => new Promise(resolve => pending.push(resolve)) })
    const request = p.refresh()
    if (invalidate === 'country') p.country.epoch++
    else p.hooks.unmount.forEach(fn => fn())
    pending.forEach(resolve => resolve(result([{ id: 'stale' }], 1)))
    await request
    assert.deepEqual(p.rows.value, []); assert.deepEqual(p.delayed.value, [])
  })
}
