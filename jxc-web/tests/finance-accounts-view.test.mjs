import test from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import ts from 'typescript'
import * as Vue from 'vue'
import { compile } from '@vue/compiler-dom'
import {loadVueScript, errorFeedback, feedbackText } from './contracts/load-vue-script.mjs'

const file = new URL('../src/modules/finance/AccountList.vue', import.meta.url)
const source = readFileSync(file, 'utf8')
const deferred = () => { let resolve, reject; const promise = new Promise((yes, no) => { resolve = yes; reject = no }); return { promise, resolve, reject } }
const book = { id: 6, name: '经营账套' }
const account = (id = 1, extra = {}) => ({ id, code: String(1000 + id), name: `科目${id}`, category: 'ASSET', direction: 'DEBIT', isLeaf: true, auxTypes: [], status: 'ENABLED', ...extra })

function setup(t, overrides = {}) {
  const mounted = [], unmounted = [], messages = [], writes = [], calls = [], resets = []
  const names = ['rows', 'accounts', 'categories', 'books', 'bookId', 'resource', 'dialog', 'saving', 'editing', 'form', 'load', 'edit', 'save', 'loadBooks', 'changeContext', 'loading', 'booksLoading', 'booksError', 'loadError', 'referenceError', 'saveError', 'savedNotice', 'keyword', 'page', 'pageSize', 'filteredRows', 'pageRows', 'resetPage', 'resourceLabel', 'resources', 'accountCategories', 'cashflowCategories', 'directions', 'purposes', 'reconcileTypes', 'auxTypes', 'labelFor', 'categoryName', 'accountName', 'mockMode', 'canEdit']
  const script = source.match(/<script[^>]*>([\s\S]*?)<\/script>/)[1]
  const page = loadVueScript(file, {
    computed: Vue.computed, ref: Vue.ref, reactive: Vue.reactive,
    onMounted: fn => mounted.push(fn), onBeforeUnmount: fn => unmounted.push(fn),
    useUserStore: () => ({ hasPerm: () => overrides.permission !== false }),
    createCommandIntent: () => ({ reset: () => resets.push(true) }),
    ElMessage: { success: text => messages.push(text) },
    importMetaEnv: overrides.demo ? { MODE: 'demo', VITE_USE_MOCK: 'true' } : {},
    allRecords: async (path, query, assertCurrent) => { calls.push({ path, query }); const result = await (overrides.read?.(path, query) ?? Promise.resolve(path === '/fin/accounts' ? [account()] : [])); assertCurrent?.(); return result },
    http: {
      get: async () => overrides.books ? overrides.books() : [book],
      postIdem: async (...args) => { writes.push({ method: 'POST', args }); return overrides.write?.(...args) },
      putIdem: async (...args) => { writes.push({ method: 'PUT', args }); return overrides.write?.(...args) },
    },
  }, names.filter(name => new RegExp(`\\b${name}\\b`).test(script)))
  const dispose = () => unmounted.splice(0).forEach(fn => fn())
  t.after(dispose)
  return { ...page, mounted, calls, writes, messages, resets, dispose }
}

function states(p) { assert.ok(p.loading && p.booksError && p.loadError && p.saveError && p.loadBooks, '需要独立的读取、保存状态和账套重试入口') }
async function select(p, value = 'accounts') { p.bookId.value = 6; p.resource.value = value; await p.load() }
function complete(p) { Object.assign(p.form, { code: '1001', name: '库存现金' }) }

test('account reference data reuses the full list instead of requesting it twice', async t => {
  const p = setup(t); await select(p)
  assert.equal(p.calls.filter(c => c.path === '/fin/accounts').length, 1)
  assert.deepEqual(p.accounts.value, p.rows.value)
})

test('book failure is visible and retry selects the only book', async t => {
  let fail = true
  const p = setup(t, { books: async () => { if (fail) throw new Error('账套无读取权限'); return [book] } }); states(p)
  await p.loadBooks(); assert.match(p.booksError.value, /账套无读取权限/); assert.equal(p.booksLoading.value, false)
  fail = false; await p.loadBooks(); assert.equal(p.bookId.value, 6); assert.equal(p.booksError.value, ''); assert.equal(p.rows.value.length, 1)
})

test('multiple books require selection and no list request is sent without a book', async t => {
  const p = setup(t, { books: async () => [book, { id: 7, name: '另一账套' }] }); states(p)
  await p.loadBooks(); assert.equal(p.bookId.value, undefined); assert.equal(p.calls.length, 0)
})

test('list failure clears old rows and retries without pretending it is empty success', async t => {
  let fail = true
  const p = setup(t, { read: async () => { if (fail) throw new Error('读取超时'); return [account()] } }); states(p)
  p.rows.value = [account(99)]; await select(p)
  assert.equal(p.rows.value.length, 0); assert.match(p.loadError.value, /读取超时/); assert.equal(p.loading.value, false)
  fail = false; await p.load(); assert.equal(p.loadError.value, ''); assert.equal(p.rows.value.length, 1)
})

test('switching book clears the editor and a late response cannot overwrite the new book', async t => {
  const old = deferred()
  const p = setup(t, { read: (_path, q) => q.bookId === 6 ? old.promise : Promise.resolve([account(7)]) }); states(p)
  p.bookId.value = 6; const pending = p.load(); p.dialog.value = true; p.bookId.value = 7
  await p.changeContext(); old.resolve([account(6)]); await pending
  assert.equal(p.dialog.value, false); assert.equal(p.rows.value[0].id, 7); assert.equal(p.loadError.value, '')
})

test('changing resource discards a late failed response', async t => {
  const old = deferred()
  const p = setup(t, { read: path => path === '/fin/accounts' ? old.promise : Promise.resolve([{ id: 4, code: '收', name: '收款凭证' }]) }); states(p)
  p.bookId.value = 6; const pending = p.load(); p.resource.value = 'voucher-words'; await p.changeContext()
  old.reject(new Error('旧请求失败')); await pending
  assert.equal(p.rows.value[0].id, 4); assert.equal(p.loadError.value, '')
})

test('unmounted page ignores pending reads', async t => {
  const later = deferred(), p = setup(t, { read: () => later.promise }); states(p)
  p.bookId.value = 6; const pending = p.load(); p.dispose(); later.resolve([account()]); await pending
  assert.equal(p.rows.value.length, 0)
})

test('keyword filtering covers all records before pagination, including after the first 200', async t => {
  const p = setup(t, { read: async () => Array.from({ length: 225 }, (_, i) => account(i + 1)) }); states(p)
  await select(p); assert.equal(p.filteredRows.value.length, 225); assert.equal(p.pageRows.value.length, 20)
  p.page.value = 12; assert.equal(p.pageRows.value.length, 5)
  p.keyword.value = '科目225'; p.resetPage(); assert.equal(p.page.value, 1); assert.equal(p.pageRows.value[0].id, 225)
  p.keyword.value = '不存在'; p.resetPage(); assert.equal(p.filteredRows.value.length, 0)
})

test('mapping rows resolve names, retain unknown identities and search names', async t => {
  const p = setup(t, { read: async path => path === '/md/categories' ? [{ id: 8, name: '家具' }] : path === '/fin/accounts' ? [account(9)] : [{ id: 2, categoryId: 8, accountId: 9, purpose: 'INVENTORY' }] }); states(p)
  await select(p, 'category-account-maps')
  assert.equal(p.categoryName(8), '家具'); assert.match(p.accountName(9), /科目9/)
  assert.match(p.categoryName(88), /88/); assert.match(p.accountName(99), /99/)
  p.keyword.value = '家具'; assert.equal(p.filteredRows.value.length, 1)
})

test('mapping reference failure preserves readable mappings and blocks editing with the actual cause', async t => {
  const p = setup(t, { read: async path => { if (path === '/md/categories') throw new Error('商品分类访问被拒绝'); return path === '/fin/accounts' ? [account()] : [{ id: 2, categoryId: 8, accountId: 1, purpose: 'INVENTORY' }] } }); states(p)
  await select(p, 'category-account-maps'); await p.edit()
  assert.equal(p.loadError.value, ''); assert.equal(p.rows.value.length, 1)
  assert.match(p.referenceError.value, /商品分类访问被拒绝/); assert.equal(p.dialog.value, false)
  const view = render(p); assert.match(feedbackText(), /商品分类访问被拒绝/); assert.doesNotMatch(view.text, /商品分类访问被拒绝/); assert.match(view.text, /分类 ID 8/)
})

test('all four existing resources retain their defaults and endpoint contracts', async t => {
  for (const resource of ['accounts', 'cashflow-items', 'voucher-words', 'category-account-maps']) {
    const p = setup(t); await select(p, resource); await p.edit(); complete(p)
    if (resource === 'cashflow-items') { assert.equal(p.form.category, 'OPERATING'); assert.equal(p.form.direction, 'BOTH') }
    if (resource === 'voucher-words') assert.equal(p.form.numberRule, 'DATE_SEQUENCE')
    if (resource === 'category-account-maps') Object.assign(p.form, { categoryId: 8, accountId: 9 })
    const view = render(p)
    assert.ok(view.nodes.some(node => node.label === (resource === 'accounts' ? '核算属性' : resource === 'cashflow-items' ? '活动类别' : resource === 'voucher-words' ? '编号规则' : '商品分类')))
    if (resource === 'voucher-words' || resource === 'category-account-maps') assert.ok(!view.nodes.some(node => node.label === '余额方向'))
    await p.save(); assert.equal(p.writes.length, 1); assert.equal(p.writes[0].args[0], `/fin/${resource}?bookId=6`)
  }
})

test('edit saves the original version and cloned auxiliary rules', async t => {
  const p = setup(t); await select(p)
  const row = account(3, { version: 12, auxTypes: ['customerId'] }); await p.edit(row); p.form.auxTypes.push('supplierId')
  assert.deepEqual(row.auxTypes, ['customerId']); await p.save()
  assert.equal(p.writes[0].method, 'PUT'); assert.equal(p.writes[0].args[0], '/fin/accounts/3?bookId=6'); assert.equal(p.writes[0].args[1].version, 12)
})

test('required fields block writes with a visible validation reason', async t => {
  const p = setup(t); states(p); await select(p); await p.edit(); await p.save()
  assert.equal(p.writes.length, 0); assert.match(p.saveError.value, /编码|名称/)
  await select(p, 'category-account-maps'); await p.edit(); await p.save()
  assert.equal(p.writes.length, 0); assert.match(p.saveError.value, /商品分类|科目/)
})

test('save failure retains the editor and reason; retry retains the same intent', async t => {
  let fail = true
  const p = setup(t, { write: async () => { if (fail) throw new Error('已引用科目的核算规则不可修改') } }); states(p)
  await select(p); await p.edit(); complete(p); await p.save()
  assert.equal(p.dialog.value, true); assert.match(p.saveError.value, /已引用/); assert.equal(p.saving.value, false)
  fail = false; await p.save(); assert.equal(p.dialog.value, false); assert.equal(p.writes[0].args[2], p.writes[1].args[2]); assert.equal(p.resets.length, 1)
})

test('duplicate save clicks send once while saving', async t => {
  const later = deferred(), p = setup(t, { write: () => later.promise }); await select(p); await p.edit(); complete(p)
  const pending = p.save(), duplicate = p.save(); const count = p.writes.length
  later.resolve({}); await Promise.all([pending, duplicate]); assert.equal(count, 1)
})

test('save refuses an editor opened for a different book', async t => {
  const p = setup(t); states(p); await select(p); await p.edit(); complete(p); p.bookId.value = 7; await p.save()
  assert.equal(p.writes.length, 0); assert.match(p.saveError.value, /账套|配置.*变化|重新打开/)
})

test('successful save remains successful when refreshing the list fails', async t => {
  let fail = false
  const p = setup(t, { read: async () => { if (fail) throw new Error('刷新超时'); return [account()] } }); states(p)
  await select(p); await p.edit(); complete(p); fail = true; await p.save()
  assert.equal(p.dialog.value, false); assert.equal(p.saveError.value, ''); assert.match(p.loadError.value, /刷新超时/)
  assert.ok(p.savedNotice.value); assert.equal(p.messages.length, 1); assert.equal(p.writes.length, 1)
})

test('demo mode and missing edit permission reject direct write actions', async t => {
  for (const options of [{ demo: true }, { permission: false }]) {
    const p = setup(t, options); await select(p); await p.edit(); assert.equal(p.dialog.value, false)
    complete(p); await p.save(); assert.equal(p.writes.length, 0)
  }
})

test('display labels translate known codes and preserve unknown values', t => {
  const p = setup(t); assert.ok(p.labelFor, '需要中文业务标签')
  assert.equal(p.labelFor(p.accountCategories, 'ASSET'), '资产'); assert.equal(p.labelFor(p.directions, 'DEBIT'), '借方')
  assert.equal(p.labelFor(p.purposes, 'INVENTORY'), '存货'); assert.equal(p.labelFor(p.accountCategories, 'FUTURE_CODE'), 'FUTURE_CODE')
})

function render(p) {
  const renderer = Vue.createRenderer({ createElement: tag => ({ tag, children: [] }), createText: text => ({ text }), createComment: () => ({}), setText: (n, text) => { n.text = text }, setElementText: (n, text) => { n.text = text }, insert: (n, parent) => parent.children.push(n), remove() {}, patchProp: (n, key, _, value) => { n[key] = value }, parentNode: () => null, nextSibling: () => null })
  const code = ts.transpileModule(compile(source.match(/<template>([\s\S]*)<\/template>/)[1], { mode: 'function', prefixIdentifiers: true, expressionPlugins: ['typescript'] }).code, { compilerOptions: { target: ts.ScriptTarget.ES2022 } }).outputText
  const app = renderer.createApp({ setup: () => p, render: new Function('Vue', code)(Vue) })
  for (const name of ['ElForm', 'ElFormItem', 'ElSelect', 'ElOption', 'ElInput', 'ElButton', 'ElCheckbox', 'ElPagination']) app.component(name, { setup: (_, ctx) => () => Vue.h(name, ctx.attrs, ctx.slots.default?.()) })
  app.component('ElAlert', { props: ['title'], setup: (props, ctx) => () => Vue.h('alert', [props.title, ctx.slots.default?.()]) })
  app.component('ElEmpty', { props: ['description'], setup: props => () => Vue.h('empty', props.description) })
  app.component('ElDialog', { props: ['modelValue'], setup: (props, ctx) => () => props.modelValue ? Vue.h('dialog', [ctx.slots.default?.(), ctx.slots.footer?.()]) : null })
  app.component('ElTable', { props: ['data'], setup: (props, ctx) => { Vue.provide('rows', props.data); return () => Vue.h('table', props.data.length ? ctx.slots.default?.() : ctx.slots.empty?.()) } })
  app.component('ElTableColumn', { props: ['label', 'prop'], setup: (props, ctx) => { const rows = Vue.inject('rows'); return () => Vue.h('column', [props.label, ...rows.map(row => ctx.slots.default?.({ row }) ?? String(row[props.prop] ?? '-'))]) } })
  app.component('StatusTag', { props: ['status'], setup: props => () => Vue.h('tag', props.status) }); app.directive('loading', {})
  app.config.warnHandler = warning => { throw new Error(warning) }
  const root = { children: [] }; app.mount(root)
  const nodes = (function walk(n) { return [n, ...(n.children ?? []).filter(Boolean).flatMap(walk)] })(root)
  const text = nodes.map(n => n.text ?? '').join(''); app.unmount(); return { nodes, text }
}

test('compiled template separates no-book, no-data, no-match and failure states with labels', async t => {
  const p = setup(t); states(p); p.books.value = [book]
  let view = render(p); assert.match(view.text, /请选择账套/)
  assert.ok(view.nodes.some(n => n.label === '账套')); assert.ok(view.nodes.some(n => n.label === '配置类型'))
  await select(p); p.rows.value = []; view = render(p); assert.match(view.text, /暂无.*配置|暂无.*科目/)
  p.rows.value = [account()]; p.keyword.value = '不存在'; view = render(p); assert.match(view.text, /没有匹配/)
  p.loadError.value = '服务超时'; view = render(p); assert.doesNotMatch(view.text, /服务超时/); assert.match(view.text, /操作未完成|尚未加载成功/); assert.match(view.text, /重新加载/)
})

// Errors are application-level; each case starts with a clean global presentation.
test.beforeEach(() => errorFeedback.clearErrors())
