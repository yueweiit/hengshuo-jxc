import test from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import * as Vue from 'vue'
import { renderToString } from '@vue/server-renderer'
import { loadVueScript } from './contracts/load-vue-script.mjs'
import { loadTsModule } from './contracts/load-ts-module.mjs'

const base = new URL('../src/modules/purchase/', import.meta.url)
const model = loadTsModule(new URL('purchaseOrderAudit.ts', base))
const shared = loadTsModule(new URL('../src/components/auditPresentation.ts', import.meta.url))
const line = { id: 429, lineNo: 1, productId: 21, unit: '条', baseUnit: '条', factor: 1, qty: 35, baseQty: 35, unitPrice: 60, amount: 2100, taxRate: 0.13, deliveryDate: null, qualifiedQty: 0 }
const snapshot = { docNo: 'T01PO-20261022000002', currency: 'CNY', supplierId: 50, status: 'DRAFT', totalAmount: 2100, lines: [line] }
const create = { id: 435, resourceType: 'purchase-order', resourceId: 428, action: 'CREATE', beforeValue: null, afterValue: snapshot, userName: '测试管理员', occurredAt: '2026-10-22T06:43:26Z' }
const update = { ...create, id: 447, action: 'UPDATE', beforeValue: { ...snapshot, status: 'CONFIRMED' }, afterValue: { ...snapshot, lines: [{ ...line, id: 440 }] } }
function presentation(log, current) {
  assert.equal(typeof model.purchaseOrderDrawerPresentation, 'function', '采购日志尚未适配公共抽屉')
  return model.purchaseOrderDrawerPresentation(log, current)
}
const template = file => readFileSync(file, 'utf8').match(/<template>([\s\S]*)<\/template>/)[1]
const settle = async () => { await Promise.resolve(); await Vue.nextTick(); await Promise.resolve() }

test('公共快照保留采购商品分列、四位单价、交付数量与标明来源的当前名称', () => {
  const view = presentation(create, { supplierId: 50, supplierName: '当前供应商', lines: [{ productId: 21, productName: '工装牛仔裤', productCode: 'TC01-A-M' }] })
  const values = view.snapshot.rows[0].cells.map(cell => cell.text)
  for (const value of ['60.0000', '2,100.00', '13%', '未填写']) assert.ok(values.includes(value), value)
  for (const value of ['工装牛仔裤', 'TC01-A-M', '当前资料', '历史标识 #21']) assert.ok(values.some(text => text.includes(value)), value)
  assert.ok(view.snapshot.columns.some(column => column.label === '合格数量'))
  assert.ok(view.snapshot.fields.some(field => field.reference === '当前名称：当前供应商'))
  assert.ok(view.snapshot.fields.some(field => field.label === '采购总金额' && field.value.text === '2,100.00 CNY'))
})

test('状态变化与重建明细ID继续使用原配对，不产生虚假的商品增删', () => {
  const view = presentation(update)
  assert.ok(view.changes.some(change => change.label === '单据状态' && change.from.status === 'CONFIRMED' && change.to.status === 'DRAFT'))
  assert.deepEqual(view.extraSnapshots, [])
  assert.ok(view.notes.some(note => note.includes('商品明细保持一致') && note.includes('1 行')))
})

test('商品增删保留各自明确标签的快照，不合并成整行长串', () => {
  const view = presentation({ ...update, beforeValue: snapshot, afterValue: { ...snapshot, lines: [{ ...line, id: 900, productId: 22 }] } })
  assert.deepEqual(view.extraSnapshots.map(panel => panel.label), ['列入商品 1 行', '移除商品 1 行'])
  assert.ok(view.extraSnapshots[0].snapshot.rows[0].cells.some(cell => cell.text.includes('#22')))
  assert.ok(view.extraSnapshots[1].snapshot.rows[0].cells.some(cell => cell.text.includes('#21')))
  assert.ok(view.extraSnapshots.every(panel => panel.snapshot.fields.length === 0))
})

test('缺失、明确空明细、格式异常与未知字段保留不同证据', () => {
  const absent = presentation({ ...create, afterValue: {} })
  const empty = presentation({ ...create, afterValue: { lines: [] } })
  assert.match(absent.snapshot.emptyMessage, /未提供可识别/)
  assert.match(empty.snapshot.emptyMessage, /明确记录为无商品/)
  const malformed = presentation({ ...create, action: 'FUTURE_ACTION', afterValue: { lines: '错误内容', future: { flag: '<script>' } } })
  assert.ok(malformed.notes.some(note => note.includes('无法识别')))
  assert.equal(malformed.originalAction, 'FUTURE_ACTION')
  assert.ok(malformed.otherChanges.some(change => change.label === 'future.flag'))
})

test('隐藏的金额和单价不会被当前参考资料补回', () => {
  const masked = { ...line }; delete masked.unitPrice; delete masked.amount
  const view = presentation({ ...create, afterValue: { lines: [masked] } }, snapshot)
  assert.ok(!view.snapshot.columns.some(column => /单价|金额/.test(column.label)))
  assert.ok(!view.snapshot.fields.some(field => /金额/.test(field.label)))
  assert.ok(!view.snapshot.rows.flatMap(row => row.cells).some(cell => cell.text === '60.0000'))
})

test('采购附件直接沿用公共文件卡片，不丢失文件名或分类', () => {
  const view = presentation({ ...create, action: 'ATTACHMENT_UPLOAD', afterValue: { fileName: '采购合同.pdf', category: 'PURCHASE_DOC', attachmentId: 1358, versionNo: 1 } })
  assert.equal(view.attachment.fileName, '采购合同.pdf')
  assert.equal(view.attachment.category, '采购单据')
  assert.equal(view.title, '上传附件')
})

async function renderRecords(t, logs, current = {}) {
  const file = new URL('../src/components/AuditDrawerRecords.vue', import.meta.url)
  const props = Vue.reactive({ logs, timezone: 'America/Mexico_City', presentation: log => presentation(log, current), loading: false, loadError: '', total: logs.length })
  const scope = Vue.effectScope()
  const page = scope.run(() => loadVueScript(file, {
    ref: Vue.ref, computed: Vue.computed, watch: Vue.watch, defineProps: () => props, defineEmits: () => () => {},
    groupAuditLogs: shared.groupAuditLogs, rawAuditRecord: shared.rawAuditRecord,
  }, ['groups', 'allExpanded', 'toggleAll', 'isOpen', 'onToggle', 'snapshotPanels', 'changeGroups', 'rawAuditRecord']))
  t.after(() => scope.stop())
  const app = Vue.createSSRApp({ setup: () => ({ ...props, ...page }), render: Vue.compile(template(file), { prefixIdentifiers: true }) })
  for (const name of ['ElIcon', 'ElButton']) app.component(name, { setup: (_, { slots }) => () => Vue.h('span', slots.default?.()) })
  for (const name of ['Calendar', 'Paperclip', 'Check', 'DocumentAdd', 'EditPen', 'Document', 'ArrowRight']) app.component(name, { render: () => null })
  app.component('StatusTag', { props: ['status'], setup: p => () => Vue.h('span', p.status === 'DRAFT' ? '草稿' : p.status === 'CONFIRMED' ? '已确认' : p.status) })
  const warnings = []; app.config.warnHandler = message => warnings.push(message)
  return { page, props, html: async () => { const html = await renderToString(app); assert.deepEqual(warnings, []); return html } }
}

test('实际公共模板渲染采购日期分组、秒级时间、字段对照与商品分列表格', async t => {
  const page = await renderRecords(t, [update, create])
  const html = await page.html()
  for (const text of ['全部记录', '2026 年 10 月 22 日', '00:43:26', '创建采购单', '采购数量', '60.0000', '草稿', '已确认', '商品明细保持一致', 'America/Mexico_City']) assert.ok(html.includes(text), text)
  assert.ok(!html.includes('purchase-audit-workspace'))
  assert.ok(!/<details class="audit-raw"[^>]*\bopen\b/.test(html))
})

test('采购附加商品面板与其他字段参与统一展开收起，换单重置', async t => {
  const changed = { ...update, beforeValue: snapshot, afterValue: { ...snapshot, future: '新字段', lines: [{ ...line, id: 900, productId: 22 }] } }
  const p = await renderRecords(t, [changed])
  const html = await p.html()
  for (const text of ['列入商品 1 行', '移除商品 1 行', '其他字段变化', 'future']) assert.ok(html.includes(text), text)
  assert.equal(p.page.allExpanded.value, false)
  p.page.toggleAll(); assert.equal(p.page.allExpanded.value, true)
  for (const part of ['details', 'added', 'removed', 'other', 'raw']) assert.equal(p.page.isOpen(changed.id, part), true, part)
  p.page.toggleAll(); assert.equal(p.page.allExpanded.value, false)
  p.props.logs = [{ ...create, id: 901, resourceId: 999 }]; await Vue.nextTick()
  assert.equal(p.page.isOpen(changed.id, 'added'), false)
})

function reference(t, get, overrides = {}) {
  const props = Vue.reactive({ modelValue: true, resourceId: 428, ...overrides }), hooks = [], scope = Vue.effectScope()
  const p = scope.run(() => loadVueScript(new URL('PurchaseOrderAudit.vue', base), {
    ref: Vue.ref, computed: Vue.computed, watch: Vue.watch, onBeforeUnmount: fn => hooks.push(fn), defineProps: () => props, defineExpose() {}, defineEmits: () => () => {},
    http: { get }, auditDocumentContext: shared.auditDocumentContext, purchaseOrderDrawerPresentation: model.purchaseOrderDrawerPresentation,
  }, ['current', 'referenceError', 'loadReference', 'context', 'audit', 'reload', 'presentation']))
  t.after(() => { hooks.forEach(fn => fn()); scope.stop() })
  return { ...p, parameters: props }
}

test('关闭的抽屉不加载参考资料，打开后才按选中单据读取', async t => {
  const calls = []
  const p = reference(t, async url => { calls.push(url); return { order: snapshot } }, { modelValue: false })
  assert.deepEqual(calls, [])
  p.parameters.modelValue = true; await settle()
  assert.deepEqual(calls, ['/pur/orders/428/progress'])
  assert.equal(p.context.value.identifier, snapshot.docNo)
})

test('详情直接复用完整采购单，列表单号上下文独立于参考资料加载', t => {
  let calls = 0
  const p = reference(t, async () => { calls++; throw Error('unexpected') }, { order: snapshot })
  assert.equal(calls, 0); assert.equal(p.current.value, p.parameters.order)
  assert.equal(p.context.value.identifier, snapshot.docNo)
  const list = reference(t, () => new Promise(() => {}), { context: { title: '采购单', identifier: 'PO-LIST', status: 'CONFIRMED' } })
  assert.equal(list.context.value.identifier, 'PO-LIST')
})

test('参考资料失败可单独重试，不能把权限错误伪装为空资料', async t => {
  let fail = true
  const p = reference(t, async () => { if (fail) throw Error('参考资料无权查看'); return { order: snapshot } })
  await settle(); assert.equal(p.referenceError.value, '参考资料无权查看')
  fail = false; await p.loadReference()
  assert.equal(p.current.value.docNo, snapshot.docNo); assert.equal(p.referenceError.value, '')
})

test('参考资料返回异常结构明确报告格式错误', async t => {
  const p = reference(t, async () => ({ order: [] }))
  await settle(); assert.match(p.referenceError.value, /返回格式不正确/)
  assert.equal(p.current.value, undefined)
})

test('没有消息的参考资料异常仍明确展示读取失败', async t => {
  const p = reference(t, async () => { throw new Error() })
  await settle(); assert.equal(p.referenceError.value, '当前商品资料读取失败')
})

test('换单和关闭后迟到的名称资料都不能污染当前抽屉', async t => {
  const pending = []
  const p = reference(t, () => new Promise(resolve => pending.push(resolve)))
  p.parameters.resourceId = 429; await Vue.nextTick()
  pending[1]({ order: { supplierId: 51 } }); await settle()
  pending[0]({ order: { supplierId: 50 } }); await settle()
  assert.equal(p.current.value.supplierId, 51)
  const closing = reference(t, () => new Promise(resolve => pending.push(resolve)))
  closing.parameters.modelValue = false; await Vue.nextTick()
  pending[2]({ order: snapshot }); await settle()
  assert.equal(closing.current.value, undefined)
})

test('采购包装复用公共抽屉的刷新，不再保留第二个日志查询器', async t => {
  const p = reference(t, async () => ({ order: snapshot }), { order: snapshot })
  let reloads = 0; p.audit.value = { reload() { reloads++ } }
  p.reload(); assert.equal(reloads, 1)
  const warnings = []
  const props = { ...p, modelValue: true, resourceId: 428 }
  const app = Vue.createSSRApp({ setup: () => props, render: Vue.compile(template(new URL('PurchaseOrderAudit.vue', base)), { prefixIdentifiers: true }) })
  app.component('AuditDrawer', { props: ['resourceType', 'context'], setup: (p, { slots }) => () => Vue.h('aside', [p.resourceType, p.context.identifier, slots.notice?.()]) })
  app.component('ElButton', { setup: (_, { slots }) => () => Vue.h('button', slots.default?.()) })
  app.config.warnHandler = message => warnings.push(message)
  assert.match(await renderToString(app), /purchase-order.*T01PO-/)
  assert.deepEqual(warnings, [])
})

test('列表选择的采购单传给统一日志入口，详情旧日志页签已移除', () => {
  const p = loadVueScript(new URL('PurchaseOrderList.vue', base), {
    ref: Vue.ref, computed: Vue.computed, useRouter: () => ({}), useUserStore: () => ({ hasPerm: () => false }), createCommandIntent: () => ({}),
    PO_STATUS: [], PRODUCT_SOURCE: [], SUPPLIER_SOURCE: [], auditDocumentContext: shared.auditDocumentContext,
  }, ['openAudit', 'auditOrder', 'auditVisible', 'auditContext'])
  p.openAudit({ id: 428, docNo: snapshot.docNo, status: 'CONFIRMED' })
  assert.equal(p.auditVisible.value, true)
  assert.equal(p.auditOrder.value.id, 428)
  assert.equal(p.auditContext.value.identifier, snapshot.docNo)
  const list = template(new URL('PurchaseOrderList.vue', base)), detail = template(new URL('PurchaseOrderDetail.vue', base))
  assert.ok(!list.includes('#audit=')); assert.ok(!list.includes('audit-width='))
  assert.match(list, /<PurchaseOrderAudit\b/); assert.match(detail, /<PurchaseOrderAudit\b/)
  assert.ok(!detail.includes('name="audit"'))
  assert.match(detail, /@click="auditVisible = true"[^>]*>操作日志/)
})
