import test from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import ts from 'typescript'
import { compile } from '@vue/compiler-dom'
import * as Vue from 'vue'
import { loadVueScript } from './contracts/load-vue-script.mjs'

const voucher = (extra = {}) => ({ id: 7, bookId: 10, version: 3, voucherNo: '记-0007', voucherDate: '2026-10-24', sourceKind: 'MANUAL', status: 'DRAFT', totalDebit: '20.00', totalCredit: '20.00', summary: '人工调整', lines: [{ accountId: 1, accountCode: '1001', accountName: '现金', summary: '', aux: {}, debit: 20, credit: 0, currency: 'CNY' }, { accountId: 2, accountCode: '6001', accountName: '收入', summary: '', aux: {}, debit: 0, credit: 20, currency: 'CNY' }], ...extra })
const deferred = () => { let resolve, reject; const promise = new Promise((yes, no) => { resolve = yes; reject = no }); return { promise, resolve, reject } }
async function loadUtility(path) {
  const code = ts.transpileModule(readFileSync(new URL(path, import.meta.url), 'utf8'), { compilerOptions: { module: ts.ModuleKind.ESNext } }).outputText
  return import('data:text/javascript;base64,' + Buffer.from(code).toString('base64'))
}
const { statusDef } = await loadUtility('../src/utils/status.ts')
const { financeSourcePath } = await loadUtility('../src/utils/finance-source.ts')
function setup(t, { get, post, refs, permissions = ['*'] } = {}) {
  const calls = [], writes = [], resets = [], mounted = [], unmounted = []
  const country = Vue.reactive({ epoch: 0, currency: 'MXN', timezone: 'Asia/Shanghai' })
  const user = { hasPerm: code => permissions.includes('*') || permissions.includes(code) }
  const dependencies = {
    ref: Vue.ref, reactive: Vue.reactive, computed: Vue.computed, watch: Vue.watch,
    onMounted: fn => mounted.push(fn), onBeforeUnmount: fn => unmounted.push(fn),
    useRoute: () => ({ query: {} }), useCountryStore: () => country, useUserStore: () => user,
    useOptionsStore: () => ({ remote: async () => [] }), getToken: () => 'session', getCountryId: () => 1,
    todayIn: () => '2026-10-24', formatDate: v => v || '-', statusDef, financeSourcePath,
    ElMessage: { success() {}, warning() {}, error() {} },
    ElMessageBox: { confirm: async () => 'confirm', prompt: async () => ({ value: '2026-10-24' }) },
    createCommandIntent: () => ({ reset: () => resets.push(true), run: async (_scope, _path, _body, run) => run('intent-key') }),
    allRecords: async path => {
      if (refs) return refs(path)
      if (path === '/fin/vouchers') return [voucher()]
      if (path === '/fin/accounts') return [{ id: 1, code: '1001', name: '现金', isLeaf: true, status: 'ENABLED' }]
      if (path === '/md/currencies') return [{ code: 'CNY', decimals: 2 }]
      return []
    },
    http: {
      get: async (path, params) => { calls.push({ path, params: { ...params } }); if (get) return get(path, params); return path === '/fin/books' ? [{ id: 10, baseCurrency: 'CNY', name: '账套一' }] : path === '/fin/vouchers' ? { records: [voucher()], total: 41 } : voucher() },
      postIdem: async (path, body, intent) => { writes.push({ path, body: JSON.parse(JSON.stringify(body)), intent }); return post ? post(path, body) : voucher() },
      putIdem: async (path, body, intent) => { writes.push({ path, body: JSON.parse(JSON.stringify(body)), intent }); return post ? post(path, body) : voucher() },
      delete: async path => { writes.push({ path }); return {} },
    },
  }
  const exposed = ['books', 'bookId', 'currencies', 'rows', 'selected', 'current', 'status', 'load', 'open', 'edit', 'save', 'form', 'saving', 'dialog', 'act', 'batch', 'removeDraft', 'query', 'total', 'listError', 'booksError', 'loadBooks', 'loading', 'detailVisible', 'detailLoading', 'detailError', 'closeDetail', 'editLoading', 'editError', 'saveError', 'acting', 'actionError', 'search', 'changeBook', 'closeEditor', 'user', 'mockMode', 'busy', 'booksLoading', 'selectedBook', 'baseCurrency', 'baseDecimals', 'statuses', 'sourceLabel', 'statusDef', 'formatDate', 'canBatch', 'canAct', 'canEdit', 'actions', 'detailId', 'editTarget', 'editing', 'totals', 'words', 'accounts', 'auxFields', 'auxOptions', 'types', 'changeAccount', 'cashflows', 'account', 'originalDecimals', 'financeSourcePath', 'addLine']
  const scope = Vue.effectScope()
  const p = scope.run(() => loadVueScript(new URL('../src/modules/finance/VoucherList.vue', import.meta.url), dependencies, exposed))
  p.books.value = [{ id: 10, name: '账套一', baseCurrency: 'CNY' }, { id: 11, name: '账套二', baseCurrency: 'JPY' }]; p.bookId.value = 10
  t.after(() => { unmounted.forEach(fn => fn()); scope.stop() })
  return { p, calls, writes, resets, country, mounted, unmounted }
}

// Render the actual template with a tiny host, so assertions exercise page bindings without a browser.
function render(p) {
  const money = [], attachments = [], links = []
  const renderer = Vue.createRenderer({
    createElement: tag => ({ tag, style: {}, children: [] }), createText: text => ({ text }), createComment: () => ({}),
    setText: (node, text) => { node.text = text }, setElementText: (node, text) => { node.text = text },
    insert: (node, parent) => parent.children.push(node), remove() {}, patchProp: (node, key, _, value) => { node[key] = value }, parentNode: () => null, nextSibling: () => null,
  })
  const source = readFileSync(new URL('../src/modules/finance/VoucherList.vue', import.meta.url), 'utf8')
  const code = ts.transpileModule(compile(source.match(/<template>([\s\S]*)<\/template>/)[1], { mode: 'function', prefixIdentifiers: true, expressionPlugins: ['typescript'] }).code, { compilerOptions: { target: ts.ScriptTarget.ES2022 } }).outputText
  const app = renderer.createApp({ setup: () => p, render: new Function('Vue', code)(Vue) })
  for (const name of ['ElForm', 'ElFormItem', 'ElSelect', 'ElOption', 'ElPagination', 'ElDescriptions', 'ElDescriptionsItem', 'ElInput', 'ElDatePicker', 'ElInputNumber']) {
    app.component(name, { setup: (_, ctx) => () => Vue.h(name, ctx.attrs, ctx.slots.default?.()) })
  }
  for (const name of ['ElDialog', 'ElDrawer']) app.component(name, { props: ['modelValue'], setup: (p, ctx) => () => Vue.h(name, ctx.attrs, p.modelValue ? [ctx.slots.default?.(), ctx.slots.footer?.()] : []) })
  app.component('ElButton', { setup: (_, ctx) => () => Vue.h('button', ctx.attrs, ctx.slots.default?.()) })
  app.component('ElEmpty', { props: ['description'], setup: p => () => Vue.h('empty', p.description) })
  app.component('ElAlert', { props: ['title'], setup: (p, ctx) => () => Vue.h('alert', [p.title, ctx.slots.title?.()]) })
  app.component('ElTable', { props: ['data'], setup: (p, ctx) => { Vue.provide('rows', p.data); return () => Vue.h('table', p.data.length ? ctx.slots.default?.() : ctx.slots.empty?.()) } })
  app.component('ElTableColumn', { props: ['prop', 'label'], setup: (p, ctx) => { const rows = Vue.inject('rows'); return () => Vue.h('column', [p.label, ...rows.map((row, $index) => ctx.slots.default?.({ row, $index }) ?? String(row[p.prop] ?? '-'))]) } })
  app.component('MoneyText', { props: ['value', 'currency'], setup: p => { money.push({ ...p }); return () => Vue.h('money', p.value == null ? '-' : `${p.currency} ${p.value}`) } })
  app.component('StatusTag', { props: ['status', 'domain'], setup: p => () => Vue.h('tag', statusDef(p.status, p.domain).label) })
  app.component('DocAttachment', { setup: (_, ctx) => { attachments.push({ ...ctx.attrs }); return () => Vue.h('attachments') } })
  app.component('RouterLink', { props: ['to'], setup: (p, ctx) => { links.push(p.to); return () => Vue.h('a', ctx.slots.default?.()) } })
  app.directive('loading', {}); app.config.warnHandler = warning => { throw new Error(warning) }
  const root = { children: [] }; app.mount(root)
  const nodes = (function walk(node) { return [node, ...(node.children ?? []).filter(Boolean).flatMap(walk)] })(root)
  const text = nodes.map(n => n.text ?? '').join(''); app.unmount()
  return { nodes, text, money, attachments, links }
}

test('凭证列表按服务端分页读取并携带账套和状态', async t => {
  const { p, calls } = setup(t); p.status.value = 'PENDING_AUDIT'; await p.load()
  assert.deepEqual(calls[0], { path: '/fin/vouchers', params: { bookId: 10, status: 'PENDING_AUDIT', page: 1, size: 20 } })
  assert.equal(p.rows.value[0].voucherNo, '记-0007')
})

test('清空账套立即移除旧列表、详情和勾选', async t => {
  const { p } = setup(t); p.rows.value = [voucher()]; p.current.value = voucher(); p.selected.value = [voucher()]
  p.bookId.value = undefined; await p.load()
  assert.deepEqual(p.rows.value, []); assert.equal(p.current.value, null); assert.deepEqual(p.selected.value, [])
})

test('切换账套后旧列表响应不能覆盖新账套结果', async t => {
  const old = deferred(); const { p } = setup(t, { get: (_path, params) => params.bookId === 10 ? old.promise : { records: [voucher({ id: 8, bookId: 11 })], total: 1 } })
  const pending = p.load(); p.bookId.value = 11; await p.load(); old.resolve({ records: [voucher()], total: 1 }); await pending
  assert.equal(p.rows.value[0].id, 8)
})

test('先后打开两张凭证只展示最后一张详情', async t => {
  const old = deferred(); const { p } = setup(t, { get: path => path.endsWith('/7') ? old.promise : voucher({ id: 8 }) })
  const pending = p.open({ id: 7 }); await p.open({ id: 8 }); old.resolve(voucher()); await pending
  assert.equal(p.current.value.id, 8)
})

test('无编辑权限或非人工草稿不会进入编辑读取', async t => {
  const denied = setup(t, { permissions: [] }); await denied.p.edit(voucher()); assert.equal(denied.calls.length, 0); assert.equal(denied.p.dialog.value, false)
  const auto = setup(t); await auto.p.edit(voucher({ sourceKind: 'AUTO' })); assert.equal(auto.calls.length, 0); assert.equal(auto.p.dialog.value, false)
})

test('保存中重复点击只发送一次并保持原账套及version', async t => {
  const pending = deferred(); const { p, writes } = setup(t, { post: () => pending.promise }); await p.edit(voucher())
  const first = p.save(), second = p.save(); pending.resolve(voucher()); await Promise.all([first, second])
  assert.equal(writes.length, 1); assert.equal(writes[0].body.version, 3); assert.equal(writes[0].path, '/fin/vouchers/7?bookId=10')
})

test('保存失败保留草稿与同一幂等意图供主动重试', async t => {
  let fail = true; const { p, writes } = setup(t, { post: async () => { if (fail) throw new Error('保存超时'); return voucher() } }); await p.edit(voucher())
  await p.save(); assert.equal(p.dialog.value, true); assert.equal(p.form.lines[0].debit, 20); assert.equal(p.saving.value, false)
  fail = false; await p.save(); assert.equal(writes[0].intent, writes[1].intent); assert.equal(p.dialog.value, false)
})

test('批量动作只允许对应状态并锁定选中版本', async t => {
  const { p, writes } = setup(t); p.selected.value = [voucher()]; await p.batch('audit'); assert.equal(writes.length, 0)
  p.selected.value = [voucher({ status: 'PENDING_AUDIT' })]; await p.batch('audit')
  assert.deepEqual(writes[0].body, { ids: [7], versions: { 7: 3 } })
})

test('翻页读取期间保留总数，修改条数与账套后从第一页查询', async t => {
  const pending = deferred(); let first = true
  const { p, calls } = setup(t, { get: () => { if (first) { first = false; return { records: [voucher()], total: 41 } } return pending.promise } })
  await p.load(); p.query.page = 2; const reading = p.load()
  assert.equal(p.total.value, 41, '分页读取中不能把total清零而将页码夹回第一页')
  pending.resolve({ records: [voucher({ id: 8 })], total: 41 }); await reading
  assert.equal(calls[1].params.page, 2)
  p.query.size = 50; await p.search(); assert.equal(calls.at(-1).params.page, 1); assert.equal(calls.at(-1).params.size, 50)
  p.query.page = 3; p.bookId.value = 11; p.dialog.value = true; p.form.lines = [{ debit: 99 }]; await p.changeBook()
  assert.equal(calls.at(-1).params.bookId, 11); assert.equal(p.query.page, 1); assert.equal(p.dialog.value, false); assert.deepEqual(p.form.lines, [])
})

test('读取失败与损坏分页保持错误，成功重试后才显示无记录', async t => {
  let result = new Error('网络超时'); const { p } = setup(t, { get: () => { if (result instanceof Error) throw result; return result } })
  await p.load(); assert.match(p.listError.value, /网络超时/); assert.equal(p.loading.value, false)
  result = { records: [], total: 'unknown' }; await p.load(); assert.match(p.listError.value, /分页/)
  result = new Error(''); await p.load(); assert.ok(p.listError.value)
  result = { records: [], total: 0 }; await p.load(); assert.equal(p.listError.value, ''); assert.deepEqual(p.rows.value, [])
})

test('详情失败保留原因并可重试，损坏响应不能当作空详情', async t => {
  let result = new Error('凭证无权访问'); const { p } = setup(t, { get: () => { if (result instanceof Error) throw result; return result } })
  await p.open({ id: 7 }); assert.match(p.detailError.value, /无权访问/); assert.equal(p.current.value, null); assert.equal(p.detailLoading.value, false)
  result = {}; await p.open({ id: 7 }); assert.ok(p.detailError.value)
  result = voucher(); await p.open({ id: 7 }); assert.equal(p.detailError.value, ''); assert.equal(p.current.value.id, 7)
})

test('关闭详情和卸载页面后不再接收旧读取结果', async t => {
  const detail = deferred(); const h = setup(t, { get: () => detail.promise }); const opening = h.p.open({ id: 7 }); h.p.closeDetail()
  detail.resolve(voucher()); await opening; assert.equal(h.p.current.value, null); assert.equal(h.p.detailVisible.value, false)
  const list = deferred(); const unmounted = setup(t, { get: () => list.promise }); const reading = unmounted.p.load(); unmounted.unmounted.forEach(fn => fn())
  list.resolve({ records: [voucher()], total: 1 }); await reading; assert.deepEqual(unmounted.p.rows.value, [])
})

test('账套响应损坏时展示错误且不破坏已有选项结构', async t => {
  const { p } = setup(t, { get: () => ({ records: [] }) }); await p.loadBooks()
  assert.ok(p.booksError.value); assert.ok(Array.isArray(p.books.value))
})

test('编辑资料失败可重试，迟到编辑结果不会重新打开已取消的窗口', async t => {
  let fail = true; const h = setup(t, { refs: () => { if (fail) throw new Error('科目读取失败'); return [] } })
  await h.p.edit(); assert.match(h.p.editError.value, /科目读取失败/); assert.equal(h.p.editLoading.value, false)
  fail = false; await h.p.edit(); assert.equal(h.p.editError.value, ''); assert.equal(h.p.form.lines.length, 2)
  const pending = deferred(); const stale = setup(t, { get: () => pending.promise }); const editing = stale.p.edit(voucher()); stale.p.closeEditor()
  pending.resolve(voucher()); await editing; assert.equal(stale.p.dialog.value, false); assert.deepEqual(stale.p.form.lines, [])
})

test('保存成功后列表刷新失败仍保持成功详情与明确读取错误', async t => {
  const h = setup(t, { get: path => { if (path === '/fin/vouchers') throw new Error('列表刷新失败'); return voucher() } }); await h.p.edit(voucher()); await h.p.save()
  assert.equal(h.p.dialog.value, false); assert.equal(h.p.current.value.id, 7); assert.equal(h.p.saveError.value, ''); assert.match(h.p.listError.value, /列表刷新失败/)
})

test('无权限或状态不符时不发送单张动作，执行中阻止重复点击', async t => {
  const denied = setup(t, { permissions: [] }); denied.p.current.value = voucher(); await denied.p.act('/submit'); assert.equal(denied.writes.length, 0)
  const wrong = setup(t); wrong.p.current.value = voucher(); await wrong.p.act('/post'); assert.equal(wrong.writes.length, 0)
  const pending = deferred(); const h = setup(t, { post: () => pending.promise }); h.p.current.value = voucher({ status: 'PENDING_AUDIT' })
  const first = h.p.act('/audit'); await h.p.act('/audit'); assert.equal(h.writes.length, 1); assert.deepEqual(h.writes[0].body, { version: 3 })
  pending.resolve(voucher({ status: 'AUDITED', version: 4 })); await first; assert.equal(h.p.current.value.status, 'AUDITED'); assert.equal(h.p.acting.value, false)
})

test('列表按账套币种传递金额并保留缺失值，状态与来源使用中文', t => {
  const { p } = setup(t); p.bookId.value = 11; p.rows.value = [voucher({ sourceKind: 'AUTO', status: 'PENDING_AUDIT', totalDebit: null, totalCredit: '12345' })]
  const view = render(p)
  assert.deepEqual(view.money, [{ value: null, currency: 'JPY' }, { value: '12345', currency: 'JPY' }])
  assert.match(view.text, /自动凭证/); assert.match(view.text, /待审核/)
})

test('详情保留来源跳转和附件权限，金额取服务端合计', t => {
  const { p } = setup(t); p.current.value = voucher({ totalDebit: '999.00', sourceEventId: 101, lines: [{ sourceDocType: 'SALES_ORDER', sourceDocId: 99, bookId: 10, debit: null, credit: '20.00' }] }); p.detailVisible.value = true
  const view = render(p)
  assert.deepEqual(view.links, [{ path: '/finance/events', query: { bookId: 10, eventId: 101 } }, { path: '/sales/orders/99', query: { bookId: 10 } }])
  assert.equal(view.attachments[0]['biz-type'], 'FIN_VOUCHER'); assert.equal(view.attachments[0]['biz-id'], 7); assert.equal(view.attachments[0].readonly, false)
  assert.ok(view.money.some(m => m.value === '999.00' && m.currency === 'CNY'))
  p.current.value.status = 'POSTED'; assert.equal(render(p).attachments[0].readonly, true)
})

test('已关闭抽屉的迟到动画回调不能清除重新打开的详情', t => {
  const { p } = setup(t); p.current.value = voucher(); p.detailVisible.value = true
  const view = render(p), drawer = view.nodes.find(n => n.tag === 'ElDrawer')
  drawer.onClosed(); assert.equal(p.current.value.id, 7); assert.equal(p.detailVisible.value, true)
})
