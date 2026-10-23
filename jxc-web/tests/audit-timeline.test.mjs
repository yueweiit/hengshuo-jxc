import test from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import * as Vue from 'vue'
import { renderToString } from '@vue/server-renderer'
import { loadVueScript } from './contracts/load-vue-script.mjs'

const file = new URL('../src/components/AuditTimeline.vue', import.meta.url)
const log = { id: 1, action: 'UPDATE', userName: '张三', occurredAt: '2026-10-23T02:30:00Z', beforeValue: { remark: '旧备注', status: 'CONFIRMED' }, afterValue: { remark: '新备注', status: 'DRAFT' } }
function setup(t, get, props = {}) {
  const unmount = [], calls = [], scope = Vue.effectScope()
  const parameters = Vue.reactive({ resourceType: 'purchase-order', resourceId: 1, ...props })
  const page = scope.run(() => loadVueScript(file, {
    ref: Vue.ref, computed: Vue.computed, watch: Vue.watch,
    onMounted() {}, onBeforeUnmount: fn => unmount.push(fn),
    defineProps: () => parameters, defineExpose() {},
    http: { get: async (...args) => { calls.push(args); return get(...args) } },
  }, ['logs', 'loading', 'loadError', 'total', 'reload', 'diff', 'show']))
  t.after(() => { unmount.forEach(fn => fn()); scope.stop() })
  return { ...page, calls, props: parameters, unmount }
}
const settle = async () => { await Promise.resolve(); await Vue.nextTick(); await Promise.resolve() }

test('timeline reads on entry and exposes actual count and loading state', async t => {
  let resolve
  const page = setup(t, () => new Promise(r => { resolve = r }))
  assert.equal(page.loading.value, true)
  assert.deepEqual(page.calls[0], ['/sys/audit-logs', { resourceType: 'purchase-order', resourceId: 1, size: 100 }, { silent: true }])
  resolve({ records: [log], total: 150 }); await settle()
  assert.equal(page.loading.value, false)
  assert.equal(page.total.value, 150)
  assert.equal(page.logs.value.length, 1)
})

test('a failed read has a visible error and retry can recover without a fabricated empty success', async t => {
  let failed = true
  const page = setup(t, async () => { if (failed) throw new Error('没有查看权限'); return { records: [], total: 0 } })
  await settle()
  assert.equal(page.loadError.value, '没有查看权限')
  assert.equal(page.loading.value, false)
  failed = false; await page.reload()
  assert.equal(page.loadError.value, '')
  assert.equal(page.total.value, 0)
})

test('changing the document rejects a late old result while showing the new document', async t => {
  const pending = []
  const page = setup(t, () => new Promise(resolve => pending.push(resolve)))
  page.props.resourceId = 2; await Vue.nextTick()
  assert.equal(page.calls.length, 2)
  pending[1]({ records: [{ ...log, id: 2 }], total: 1 }); await settle()
  pending[0]({ records: [log], total: 99 }); await settle()
  assert.deepEqual(page.logs.value.map(r => r.id), [2])
  assert.equal(page.total.value, 1)
})

test('a late old error cannot replace a successful new document and unmount invalidates in-flight reads', async t => {
  const pending = []
  const page = setup(t, () => new Promise((resolve, reject) => pending.push({ resolve, reject })))
  page.props.resourceId = 2; await Vue.nextTick()
  pending[1].resolve({ records: [log], total: 1 }); await settle()
  pending[0].reject(new Error('旧单据失败')); await settle()
  assert.equal(page.loadError.value, '')
  const request = page.reload(); page.unmount.forEach(fn => fn())
  pending[2].resolve({ records: [{ ...log, id: 3 }], total: 10 }); await request
  assert.equal(page.logs.value[0].id, 1)
})

test('manual refresh reflects newly recorded actions for slotted and default consumers', async t => {
  let records = [log]
  const page = setup(t, async () => ({ records, total: records.length }))
  await settle()
  assert.equal(page.logs.value[0].action, 'UPDATE')
  records = [{ ...log, id: 2, action: 'close' }, log]
  await page.reload()
  assert.equal(page.logs.value[0].action, 'close')
  assert.equal(page.logs.value.length, 2)
})

test('default consumers retain their existing action and diff behavior without purchase mappings', async t => {
  const page = setup(t, async () => ({ records: [log], total: 1 }), { resourceType: 'sales-order' })
  await settle()
  assert.deepEqual(page.diff(log).map(d => d.key), ['remark', 'status'])
  assert.equal(page.show({ key: 1 }), '{"key":1}')
})

test('an invalid API page is an explicit protocol error rather than a successful empty history', async t => {
  const page = setup(t, async () => ({ records: [], total: '1' }))
  await settle()
  assert.match(page.loadError.value, /返回格式不正确/)
})

test('a custom drawer slot receives the existing query state without a second history request', async t => {
  const page = setup(t, async () => ({ records: [log], total: 150 }))
  await settle()
  const template = readFileSync(file, 'utf8').match(/<template>([\s\S]*?)<\/template>\s*<style/)[1]
  const component = { setup: () => ({ ...page, ...page.props }), render: Vue.compile(template) }
  const app = Vue.createSSRApp({ render: () => Vue.h(component, null, {
    layout: state => Vue.h('section', { 'data-custom-audit': true }, `${state.logs[0].id}/${state.total}/${state.loading}/${state.loadError}`),
  }) })
  for (const name of ['ElButton', 'ElTimeline', 'ElTimelineItem', 'DateTimeText']) app.component(name, { render: () => null })
  const html = await renderToString(app)
  assert.match(html, /data-custom-audit/)
  assert.match(html, /1\/150\/false\//)
  assert.equal(page.calls.length, 1)
})

test('actual shared template retains default differences, error/retry and truncation visibly', async t => {
  let failed = false
  const page = setup(t, async () => { if (failed) throw new Error('读取超时'); return { records: [log], total: 150 } })
  await settle()
  const template = readFileSync(file, 'utf8').match(/<template>([\s\S]*?)<\/template>\s*<style/)[1]
  // Vue.compile already returns the render function bound to the real runtime.
  const actualRender = Vue.compile(template)
  const component = { setup: () => ({ ...page, ...page.props }), render: actualRender }
  const app = () => {
    const instance = Vue.createSSRApp(component)
    for (const name of ['ElTimeline', 'ElTimelineItem', 'ElButton']) instance.component(name, { setup: (_, { slots }) => () => Vue.h('div', slots.default?.()) })
    instance.component('DateTimeText', { props: ['value'], setup: p => () => Vue.h('time', p.value) })
    instance.component('StatusTag', { props: ['status'], setup: p => () => Vue.h('span', p.status === 'DRAFT' ? '草稿' : '已确认') })
    return instance
  }
  const html = await renderToString(app())
  assert.match(html, /UPDATE/)
  assert.match(html, /旧备注/)
  assert.match(html, /新备注/)
  assert.match(html, /张三/)
  assert.match(html, /共 150 条/)
  assert.ok(!html.includes('beforeValue'))
  failed = true; await page.reload()
  const errorHtml = await renderToString(app())
  assert.match(errorHtml, /读取超时/)
  assert.match(errorHtml, /重试/)
  assert.ok(!errorHtml.includes('暂无操作日志'))
})
