import test from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import * as Vue from 'vue'
import { renderToString } from '@vue/server-renderer'
import { ElTimeline, ElTimelineItem } from 'element-plus'
import { Close } from '@element-plus/icons-vue'
import { loadVueScript } from './contracts/load-vue-script.mjs'
import { loadTsModule } from './contracts/load-ts-module.mjs'
const base = new URL('../src/modules/purchase/', import.meta.url)
const { purchaseOrderAudit, formatAuditTime } = loadTsModule(new URL('purchaseOrderAudit.ts', base))
const line = { id: 429, lineNo: 1, productId: 21, unit: '条', baseUnit: '条', factor: 1, qty: 35, baseQty: 35, unitPrice: 60, amount: 2100, taxRate: 0.13, deliveryDate: null, qualifiedQty: 0 }
const snapshot = { docNo: 'T01PO-20261022000002', currency: 'CNY', supplierId: 50, status: 'DRAFT', lines: [line] }
const create = { id: 435, action: 'CREATE', beforeValue: null, afterValue: snapshot, userName: '测试管理员', occurredAt: '2026-10-22T06:43:26Z' }
const update = { ...create, id: 447, action: 'UPDATE', beforeValue: { ...snapshot, status: 'CONFIRMED' }, afterValue: { ...snapshot, lines: [{ ...line, id: 440 }] } }

function records(t, overrides = {}) {
  const props = Vue.reactive({ logs: [update, create], current: {}, resourceId: 428, ...overrides })
  const scope = Vue.effectScope()
  const page = scope.run(() => loadVueScript(new URL('PurchaseOrderAuditRecords.vue', base), {
    ref: Vue.ref, computed: Vue.computed, watch: Vue.watch, useId: ()=>'audit-test', defineProps: () => props, purchaseOrderAudit,
    useCountryStore:()=>({timezone:'America/Mexico_City'}), formatAuditTime,
  }, ['props', 'entries', 'active', 'selectedId', 'select', 'close', 'contentId', 'country', 'formatAuditTime']))
  t.after(() => scope.stop())
  return { ...page, parameters: props }
}
function component(filename, setup) {
  const source = readFileSync(new URL(filename, base), 'utf8').match(/<template>([\s\S]*)<\/template>/)[1]
  return { setup: () => setup, render: Vue.compile(source, { prefixIdentifiers: true }) }
}
function registerTimeline(app) {
  app.component('ElTimeline', ElTimeline)
  app.component('ElTimelineItem', ElTimelineItem)
  app.component('ElTooltip', { props: ['content', 'placement'], setup: (_, { slots }) => () => slots.default?.() })
  app.component('ElIcon', { setup: (_, { slots }) => () => Vue.h('i', slots.default?.()) })
  app.component('Close', Close)
}
async function render(page) {
  const app = Vue.createSSRApp(component('PurchaseOrderAuditRecords.vue', page))
  registerTimeline(app)
  app.component('DateTimeText', { props: ['value'], setup: p => () => Vue.h('time', p.value) })
  app.component('StatusTag', { props: ['status'], setup: p => () => Vue.h('span', p.status === 'DRAFT' ? '草稿' : '已确认') })
  app.component('PurchaseOrderAuditSnapshot', { props: ['snapshot', 'productsOnly'], setup: p => () => Vue.h(component('PurchaseOrderAuditSnapshot.vue', { props:p, snapshot:p.snapshot, productsOnly:p.productsOnly })) })
  return renderToString(app)
}

test('initial entry renders the timeline with no selected record or detail pane', async t => {
  const p = records(t)
  assert.equal(p.active.value, undefined)
  const html = await render(p)
  assert.match(html, /操作日志时间轴/)
  assert.equal((html.match(/<li class="el-timeline-item(?:\s|\")/g) || []).length, 2)
  assert.ok(!html.includes('purchase-audit-content'))
  assert.ok(!html.includes('60.0000'))
  assert.ok(!html.includes('aria-expanded="true"'))
})

test('a timeline entry opens its details, another switches them, and repeating the entry closes them', async t => {
  const p = records(t)
  p.select(435); assert.equal(p.active.value.log.id, 435)
  p.select(447); assert.equal(p.active.value.log.id, 447)
  assert.match(await render(p), /aria-expanded="true"/)
  p.select(447); assert.equal(p.active.value, undefined)
  const html = await render(p)
  assert.ok(!html.includes('purchase-audit-content'))
  assert.equal((html.match(/<li class="el-timeline-item(?:\s|\")/g) || []).length, 2)
})

test('refresh preserves a valid open selection and never reopens a closed detail pane', async t => {
  const p = records(t)
  p.select(447)
  p.parameters.logs = [{ ...update }, { ...create }]; await Vue.nextTick()
  assert.equal(p.active.value.log.id, 447)
  const html = await render(p)
  assert.match(html, /aria-label="收起明细"/)
  p.close(); assert.equal(p.active.value, undefined)
  p.parameters.logs = [{ ...update }, { ...create }]; await Vue.nextTick()
  assert.equal(p.active.value, undefined)
})

test('changing the order resets the selected timeline event to collapsed', async t => {
  const p = records(t)
  p.select(447)
  p.parameters.resourceId = 429; await Vue.nextTick()
  assert.equal(p.active.value, undefined)
})

test('a selection removed by refresh stays collapsed even if that record returns later', async t => {
  const p = records(t)
  p.select(435)
  p.parameters.logs = [update]; await Vue.nextTick()
  assert.equal(p.active.value, undefined)
  p.parameters.logs = [update, create]; await Vue.nextTick()
  assert.equal(p.active.value, undefined)
})

test('actual timeline node, entry button and detail close events update the selection without bubbling twice', async t => {
  const p = records(t)
  const renderer = Vue.createRenderer({
    createElement: tag => ({ tag, children: [] }), createText: text => ({ text }), createComment: text => ({ comment: text }),
    setText: (node, text) => { node.text = text }, setElementText: (node, text) => { node.text = text },
    insert(node, parent, anchor = null) { node.parent = parent; const index = anchor ? parent.children.indexOf(anchor) : -1; parent.children.splice(index < 0 ? parent.children.length : index, 0, node) },
    remove(node) { const index = node.parent?.children.indexOf(node); if (index >= 0) node.parent.children.splice(index, 1) },
    patchProp: (node, key, _before, value) => { node[key] = value },
    parentNode: node => node.parent, nextSibling: node => node.parent?.children[node.parent.children.indexOf(node) + 1] ?? null,
  })
  const app = renderer.createApp(component('PurchaseOrderAuditRecords.vue', p))
  registerTimeline(app)
  app.component('StatusTag', { setup: () => () => Vue.h('span') })
  app.component('PurchaseOrderAuditSnapshot', { setup: () => () => Vue.h('section') })
  const root = { children: [] }
  app.mount(root); t.after(() => app.unmount())
  const walk = node => [node, ...(node.children || []).flatMap(walk)]
  const find = predicate => walk(root).find(predicate)
  find(node => node.tag === 'li').onClick()
  assert.equal(p.active.value.log.id, 447)
  await Vue.nextTick()
  let stopped = false
  find(node => node.class === 'audit-timeline-entry').onClick({ stopPropagation() { stopped = true } })
  assert.equal(stopped, true)
  assert.equal(p.active.value, undefined)
  find(node => node.class === 'audit-timeline-entry').onClick({ stopPropagation() {} })
  await Vue.nextTick()
  find(node => node['aria-label'] === '收起明细').onClick()
  assert.equal(p.active.value, undefined)
})

test('actual purchase template renders product columns, stripes-ready rows, names and secondary delivery records', async t => {
  const p = records(t, { current: { supplierId: 50, supplierName: '当前供应商', lines: [{ productId: 21, productName: '工装牛仔裤', productCode: 'TC01-A-M' }] } })
  p.select(435)
  const html = await render(p)
  for (const value of ['采购数量','60.0000','2,100.00','13%','未填写','当前资料','TC01-A-M','历史标识 #21','单位换算与交付数量','当前名称：当前供应商','2026-10-22 00:43:26 GMT-6']) assert.ok(html.includes(value), value)
  assert.ok(!html.includes('beforeValue'))
  assert.ok(!html.includes('交易单位：条；'))
})

test('state-only update shows the actual comparison and unchanged products, not a fake product edit', async t => {
  const p = records(t); p.select(447)
  const html = await render(p)
  for (const value of ['操作前','操作后','已确认','草稿','商品明细保持一致','查看操作后的单据与商品明细']) assert.ok(html.includes(value), value)
  assert.ok(!html.includes('移除商品'))
})

test('masked snapshot renders no price or amount column and no fabricated financial totals', async t => {
  const masked = { ...line }; delete masked.unitPrice; delete masked.amount
  const p = records(t, { logs: [{ ...create, afterValue: { lines:[masked] } }] })
  p.select(435)
  const html = await render(p)
  assert.ok(!html.includes('单价'))
  assert.ok(!html.includes('金额'))
  assert.ok(!html.includes('0.00'))
})

function reference(t, get, overrides={}) {
  const props=Vue.reactive({resourceId:428,...overrides}), hooks=[],scope=Vue.effectScope()
  const p=scope.run(()=>loadVueScript(new URL('PurchaseOrderAudit.vue',base),{
    ref:Vue.ref,computed:Vue.computed,watch:Vue.watch,onBeforeUnmount:fn=>hooks.push(fn),defineProps:()=>props,defineExpose(){},
    http:{get},
  },['current','referenceError','loadReference','props']))
  t.after(()=>{hooks.forEach(f=>f());scope.stop()})
  return {...p,parameters:props}
}
const settle=async()=>{await Promise.resolve();await Vue.nextTick();await Promise.resolve()}

test('detail reuses its loaded order and performs no second reference request', t=>{
  let calls=0
  const p=reference(t,async()=>{calls++;throw Error('unexpected')},{order:{supplierId:50}})
  assert.equal(calls,0);assert.equal(p.current.value.supplierId,50)
})

test('reference failure stays explicit and a later request recovers without hiding logs', async t=>{
  let fail=true
  const p=reference(t,async()=>{if(fail)throw Error('参考资料无权查看');return {order:{supplierId:50}}})
  await settle();assert.equal(p.referenceError.value,'参考资料无权查看')
  fail=false;await p.loadReference();assert.equal(p.current.value.supplierId,50);assert.equal(p.referenceError.value,'')
})

test('late current-name response cannot decorate another order', async t=>{
  const pending=[]
  const p=reference(t,()=>new Promise(resolve=>pending.push(resolve)))
  p.parameters.resourceId=429;await Vue.nextTick()
  pending[1]({order:{supplierId:51}});await settle()
  pending[0]({order:{supplierId:50}});await settle()
  assert.equal(p.current.value.supplierId,51)
})

test('shared audit slot renders purchase records with no template warnings', async t => {
  const p = records(t)
  p.select(435)
  const sharedFile = new URL('../src/components/AuditTimeline.vue', import.meta.url)
  const sharedTemplate = readFileSync(sharedFile, 'utf8').match(/<template>([\s\S]*)<\/template>/)[1]
  const shared = {
    setup: () => ({ logs: p.parameters.logs, loading: false, loadError: '', total: 2, reload() {} }),
    render: Vue.compile(sharedTemplate, { prefixIdentifiers: true }),
  }
  const app = Vue.createSSRApp({
    setup: () => () => Vue.h(shared, null, { default: ({ logs }) => Vue.h(component('PurchaseOrderAuditRecords.vue', { ...p, logs })) }),
  })
  app.component('ElButton', { setup: (_, { slots }) => () => Vue.h('button', slots.default?.()) })
  registerTimeline(app)
  app.component('DateTimeText', { props: ['value'], setup: p => () => Vue.h('time', p.value) })
  app.component('StatusTag', { props: ['status'], setup: p => () => Vue.h('span', p.status) })
  app.component('PurchaseOrderAuditSnapshot', { props: ['snapshot', 'productsOnly'], setup: p => () => Vue.h(component('PurchaseOrderAuditSnapshot.vue', p)) })
  const warnings = []
  app.config.warnHandler = message => warnings.push(message)
  const html = await renderToString(app)
  assert.match(html, /操作日志时间轴/)
  assert.match(html, /60\.0000/)
  assert.match(html, /共 2 条/)
  assert.deepEqual(warnings, [])
})
