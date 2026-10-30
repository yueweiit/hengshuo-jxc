import test from 'node:test'
import assert from 'node:assert/strict'
import { existsSync, readFileSync } from 'node:fs'
import * as Vue from 'vue'
import { renderToString } from '@vue/server-renderer'
import { loadTsModule } from './contracts/load-ts-module.mjs'
import { loadVueScript } from './contracts/load-vue-script.mjs'

const modelFile = new URL('../src/components/auditPresentation.ts', import.meta.url)
function model() {
  assert.ok(existsSync(modelFile), '公共日志抽屉展示尚未实现')
  return loadTsModule(modelFile)
}
const log = (patch = {}) => ({ id: 1, action: 'CONFIRM', userName: '测试管理员', resourceType: 'DOMESTIC_RECEIPT', resourceId: 464, occurredAt: '2026-10-22T06:44:47Z', beforeValue: { status: 'DRAFT' }, afterValue: { status: 'CONFIRMED' }, ...patch })

test('generic history translates known state changes but retains unfamiliar actions and original data', () => {
  const { defaultAuditPresentation, rawAuditRecord, auditCell } = model()
  const source = log({ action: 'FUTURE_ACTION', afterValue: { status: 'UNRECOGNIZED', extra: { key: '<script>' } } })
  const view = defaultAuditPresentation(source)
  assert.equal(view.originalAction, 'FUTURE_ACTION')
  assert.equal(view.changes[0].to.text, 'UNRECOGNIZED')
  assert.equal(JSON.parse(rawAuditRecord(source)).afterValue.extra.key, '<script>')
  assert.deepEqual([undefined, null, '', 0].map(v => auditCell(v).text), ['未记录', '未填写', '空白', '0'])
})

test('drawer context identifies its own row and never substitutes a related purchase order', () => {
  const { auditDocumentContext } = model()
  assert.deepEqual(auditDocumentContext({ id: 464, docNo: 'DR-003', orderNo: 'PO-222', status: 'CONFIRMED' }, '国内收货'), { title: '国内收货', identifier: 'DR-003', status: 'CONFIRMED' })
  assert.equal(auditDocumentContext({ id: 464, orderNo: 'PO-222' }, '国内收货').identifier, '记录 #464')
  assert.equal(auditDocumentContext({ id: 2, code: '0002', name: '国家名称' }, '国家').identifier, '0002')
})

test('date grouping follows the country timezone and preserves server order within the same minute', () => {
  const { groupAuditLogs } = model()
  const rows = [log({ id: 2, occurredAt: '2026-10-22T06:44:59Z' }), log(), log({ id: 3, occurredAt: '2026-10-22T05:59:59Z' })]
  const groups = groupAuditLogs(rows, 'America/Mexico_City')
  assert.deepEqual(groups.map(g => g.key), ['2026-10-22', '2026-10-21'])
  assert.deepEqual(groups[0].entries.map(e => e.log.id), [2, 1])
  assert.match(groups[0].entries[0].fullTime, /2026-10-22 00:44/)
  assert.match(groups[0].entries[0].fullTime, /00:44:59/)
  assert.ok(!groups[0].entries[0].time.includes('2026-10-22'))
  assert.equal(groupAuditLogs([log({ occurredAt: 'broken' })], 'Asia/Shanghai')[0].entries[0].time, '时间格式无法识别')
})

test('the CRUD log entry preserves the business audit slot and opens generic logs with the selected context', async () => {
  const file = new URL('../src/components/crud/CrudPage.vue', import.meta.url)
  const props = { title: '国内收货', resource: '/pur/domestic-receipts', auditType: 'DOMESTIC_RECEIPT', auditPresentation: undefined, defaultQuery: {} }
  const page = loadVueScript(file, {
    ref: Vue.ref, computed: Vue.computed, reactive: Vue.reactive, onMounted() {},
    withDefaults: p => p, defineProps: () => props, defineEmits: () => () => {}, defineExpose() {},
    useI18n: () => ({ t: text => text }), useUserStore: () => ({}), useOptionsStore: () => ({}),
    createCommandIntent: () => ({}), createCrudApi: () => ({}), auditDocumentContext: model().auditDocumentContext,
  }, ['openAudit', 'auditVisible', 'auditContext', 'auditRowId'])
  page.openAudit({ id: 464, docNo: 'DR-464', orderNo: 'PO-222', status: 'CONFIRMED' })
  assert.equal(page.auditVisible.value, true)
  assert.equal(page.auditRowId.value, 464)
  assert.equal(page.auditContext.value.identifier, 'DR-464')
  const template = readFileSync(file, 'utf8').match(/<el-drawer v-if="auditType[\s\S]*?<AuditDrawer[^>]+\/>/)[0]
  const component = { setup: () => ({ ...page, ...props, auditWidth: '1320px', t: v => v }), render: Vue.compile(template) }
  async function render(custom) {
    const app = Vue.createSSRApp({ render: () => Vue.h(component, null, custom ? { audit: state => Vue.h('p', `专用采购日志 ${state.resourceId}`) } : {}) })
    app.component('ElDrawer', { setup: (_, { slots }) => () => Vue.h('aside', slots.default?.()) })
    app.component('AuditDrawer', { props: ['resourceId', 'context'], setup: p => () => Vue.h('section', `通用日志 ${p.resourceId} ${p.context.identifier}`) })
    return renderToString(app)
  }
  const generic = await render(false), purchase = await render(true)
  assert.match(generic, /通用日志 464 DR-464/)
  assert.ok(!generic.includes('专用采购日志'))
  assert.match(purchase, /专用采购日志 464/)
  assert.ok(!purchase.includes('通用日志'))
})

function records(t, props = {}) {
  const file = new URL('../src/components/AuditDrawerRecords.vue', import.meta.url)
  assert.ok(existsSync(file), '日志事件组件尚未实现')
  const scope = Vue.effectScope()
  const parameters = Vue.reactive({ logs: [log()], timezone: 'America/Mexico_City', loading: false, loadError: '', total: 1, ...props })
  const page = scope.run(() => loadVueScript(file, {
    ref: Vue.ref, computed: Vue.computed, watch: Vue.watch,
    defineProps: () => parameters, defineExpose() {}, defineEmits: () => () => {},
    groupAuditLogs: model().groupAuditLogs, rawAuditRecord: model().rawAuditRecord,
  }, ['groups', 'opened', 'allExpanded', 'toggleAll', 'setOpen', 'isOpen', 'snapshotPanels', 'changeGroups', 'onToggle', 'rawAuditRecord']))
  t.after(() => scope.stop())
  const template = readFileSync(file, 'utf8').match(/<template>([\s\S]*?)<\/template>\s*<style/)[1]
  const component = { setup: () => ({ ...page, ...parameters }), render: Vue.compile(template) }
  async function html() {
    const app = Vue.createSSRApp(component)
    app.component('StatusTag', { props: ['status'], setup: p => () => Vue.h('span', p.status === 'DRAFT' ? '草稿' : p.status === 'CONFIRMED' ? '已确认' : p.status) })
    for (const name of ['ElIcon', 'ElButton']) app.component(name, { setup: (_, { slots }) => () => Vue.h('span', slots.default?.()) })
    for (const name of ['Calendar', 'Paperclip', 'Check', 'DocumentAdd', 'EditPen', 'Document', 'ArrowRight']) app.component(name, { render: () => null })
    return renderToString(app)
  }
  return { ...page, props: parameters, html }
}

test('actual event template renders Chinese state comparison and keeps raw records collapsed and escaped', async t => {
  const page = records(t, { logs: [log({ userName: '<script>alert(1)</script>' })] })
  const html = await page.html()
  assert.match(html, /确认单据/)
  assert.match(html, /单据状态/)
  assert.match(html, /草稿/)
  assert.match(html, /已确认/)
  assert.match(html, /查看原始记录/)
  assert.ok(!/<details[^>]*\bopen\b/.test(html))
  assert.ok(!html.includes('<script>alert'))
  assert.match(html, /&lt;script&gt;/)
})

test('expand all, individual collapse and resource replacement keep expansion state truthful', async t => {
  const page = records(t)
  assert.equal(page.allExpanded.value, false)
  page.toggleAll()
  assert.equal(page.allExpanded.value, true)
  assert.equal(page.isOpen(1, 'raw'), true)
  page.setOpen(1, 'raw', false)
  assert.equal(page.allExpanded.value, false)
  page.toggleAll()
  page.props.logs = [log({ id: 2, resourceId: 999 })]
  await Vue.nextTick()
  assert.equal(page.isOpen(2, 'raw'), false)
  assert.equal(page.opened.value.size, 0)
})

test('the drawer template distinguishes loading, empty success, failure and truncated history', async t => {
  const page = records(t, { total: 150 })
  assert.match(await page.html(), /共 150 条/)
  page.props.loading = true
  assert.match(await page.html(), /正在加载操作日志/)
  page.props.loading = false
  page.props.loadError = '没有查看权限'
  const errorHtml = await page.html()
  assert.doesNotMatch(errorHtml, /没有查看权限/); assert.match(errorHtml, /操作未完成|尚未加载成功/)
  assert.ok(!errorHtml.includes('暂无操作日志'))
  assert.ok(!errorHtml.includes('已显示全部'))
  page.props.loadError = ''
  page.props.logs = []
  page.props.total = 0
  await Vue.nextTick()
  assert.match(await page.html(), /暂无操作日志/)
})

test('receipt cards and actual product columns render from the same real event template', async t => {
  const file = new URL('../src/modules/purchase/domesticReceiptAudit.ts', import.meta.url)
  assert.ok(existsSync(file), '国内收货日志展示尚未实现')
  const { domesticReceiptAudit } = loadTsModule(file)
  const page = records(t, { presentation: domesticReceiptAudit, logs: [
    log({ id: 2, action: 'ATTACHMENT_UPLOAD', beforeValue: null, afterValue: { fileName: '屏幕截图(2).png', category: 'PURCHASE_DOC', attachmentId: 1358, versionNo: 1 } }),
    log({ action: 'CREATE', beforeValue: null, afterValue: { status: 'DRAFT', lines: [{ productId: 21, qualifiedQty: 2, pendingInspectQty: 0, damagedQty: 0 }] } }),
  ] })
  const html = await page.html()
  assert.match(html, /屏幕截图\(2\).png/)
  assert.match(html, /采购单据/)
  assert.match(html, /版本 1/)
  assert.match(html, /<th[^>]*>商品<\/th>/)
  assert.match(html, /<th[^>]*>合格<\/th>/)
  assert.match(html, /商品 #21/)
})

test('the actual shared drawer refresh and retry each reload once and notify the business reference reader', async () => {
  const file = new URL('../src/components/AuditDrawer.vue', import.meta.url)
  const props = { modelValue: true, resourceType: 'purchase-order', resourceId: 428, context: { title: '采购单', identifier: 'PO-428' }, presentation: undefined }
  const events = [], clicks = []
  const page = loadVueScript(file, {
    ref: Vue.ref, defineProps: () => props, defineExpose() {},
    defineEmits: () => name => events.push(name), useCountryStore: () => ({ timezone: 'Asia/Shanghai' }),
  }, ['timeline', 'reload', 'emit', 'country'])
  let queries = 0, retry
  page.timeline.value = { reload() { queries++ } }
  const source = readFileSync(file, 'utf8').match(/<template>([\s\S]*)<\/template>/)[1]
  const component = { setup: () => ({ ...props, ...page }), render: Vue.compile(source) }
  const app = Vue.createSSRApp({ render: () => Vue.h(component, null, { notice: () => Vue.h('p', { role: 'alert' }, '参考资料读取失败') }) })
  app.component('ElDrawer', { setup: (_, { slots }) => () => Vue.h('aside', slots.default?.()) })
  app.component('AuditTimeline', { setup: (_, { slots }) => () => Vue.h('div', slots.layout({ logs: [], loading: false, loadError: '', total: 0 })) })
  app.component('AuditDrawerRecords', { setup: (_, { attrs }) => { retry = attrs.onReload; return () => null } })
  app.component('ElButton', { setup: (_, { attrs, slots }) => { clicks.push(attrs.onClick); return () => Vue.h('button', slots.default?.()) } })
  app.component('ElIcon', { setup: (_, { slots }) => () => Vue.h('i', slots.default?.()) })
  app.component('StatusTag', { render: () => null })
  for (const name of ['Clock', 'Refresh', 'Close']) app.component(name, { render: () => null })
  const warnings = []; app.config.warnHandler = message => warnings.push(message)
  const html = await renderToString(app)
  assert.match(html, /PO-428/); assert.match(html, /role="alert">参考资料读取失败/)
  clicks[0](); retry()
  assert.equal(queries, 2); assert.deepEqual(events, ['reload', 'reload'])
  assert.deepEqual(warnings, [])
})
