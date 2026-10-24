import test from 'node:test'
import assert from 'node:assert/strict'
import * as vue from 'vue'
import { loadVueScript } from './contracts/load-vue-script.mjs'
test('account map editor sends controlled account and prior-row formulas in a reviewed-version draft',async()=>{
 const calls=[]
 const scope=page({http:{postIdem:async(path,body)=>calls.push({path,body})}})
 scope.bookId.value=601;scope.tab.value='INCOME'
 scope.editTemplate({id:9,version:4,status:'ACTIVE',name:'Reviewed',rule:'ACCOUNT_MAP_V1',lines:[{code:'REVENUE',name:'收入',formula:'PERIOD_NET',sign:-1,accountIds:[1],terms:[]},{code:'PROFIT',name:'利润',formula:'LINE_SUM',sign:1,accountIds:[],terms:[{code:'REVENUE',sign:1}]}]})
 scope.templateForm.name='Next version';await scope.createTemplate()
 assert.equal(calls[0].path,'/fin/report-templates');assert.equal(calls[0].body.rule,'ACCOUNT_MAP_V1');assert.equal(calls[0].body.lines[1].terms[0].code,'REVENUE');assert.equal(calls[0].body.lines[0].accountIds[0],1);assert.equal(calls[0].body.version,undefined)
})

function page(overrides = {}) {
  return loadVueScript(new URL('../src/modules/finance/ReportView.vue', import.meta.url), {
    ref: vue.ref, reactive: vue.reactive, computed: vue.computed, onMounted() {}, allRecords: async () => [],
    useRouter: () => ({ push: async () => {} }), useCountryStore: () => ({}),
    useUserStore: () => ({ hasPerm: () => true }), createCommandIntent: () => ({}),
    ElMessage: { success() {} }, ElMessageBox: { confirm: async () => {} },
    http: { get: async () => ({}), postIdem: async () => ({}) }, ...overrides,
  }, ['bookId', 'periodId', 'tab', 'data', 'busy', 'load', 'changeBook', 'showTemplates',
    'templateDialog', 'templates', 'exportReport', 'reviewTemplate', 'reportError', 'templateError',
    'templatesBusy', 'commandBusy', 'commandError', 'templateForm', 'createTemplate',
    'books', 'booksBusy', 'booksError', 'loadBooks', 'editTemplate', 'loadTemplates', 'templateNotice', 'exportError'])
}

function deferred() {
  let resolve, reject
  const promise = new Promise((yes, no) => { resolve = yes; reject = no })
  return { promise, resolve, reject }
}

test('report read failure clears the previous report and leaves retry available', async () => {
  let attempt = 0
  const scope = page({ http: { get: async () => { if (++attempt === 1) throw new Error('报表读取超时'); return { periodId: 701, lines: [] } } } })
  scope.bookId.value = 601; scope.periodId.value = 701; scope.data.value = { periodName: '旧期间' }
  await assert.doesNotReject(scope.load())
  assert.equal(scope.data.value, null)
  assert.equal(scope.busy.value, false)
  assert.equal(scope.reportError.value, '报表读取超时')
  await scope.load()
  assert.equal(scope.reportError.value, '')
  assert.equal(scope.data.value.periodId, 701)
})

test('changing book releases loading and discards the pending report', async () => {
  const request = deferred()
  const scope = page({ http: { get: () => request.promise } })
  scope.bookId.value = 601; scope.periodId.value = 701
  const pending = scope.load()
  assert.equal(scope.busy.value, true)
  scope.bookId.value = 602; scope.changeBook()
  assert.equal(scope.busy.value, false)
  assert.equal(scope.periodId.value, undefined)
  request.resolve({ bookId: 601, periodId: 701, lines: [] }); await pending
  assert.equal(scope.data.value, null)
})

test('a superseded report failure cannot replace the newest report or its loading state', async () => {
  const first = deferred(), second = deferred()
  let call = 0
  const scope = page({ http: { get: () => ++call === 1 ? first.promise : second.promise } })
  scope.bookId.value = 601; scope.periodId.value = 701
  const older = scope.load()
  scope.periodId.value = 702
  const newer = scope.load()
  first.reject(new Error('旧期间超时'))
  await assert.doesNotReject(older)
  assert.equal(scope.busy.value, true)
  second.resolve({ periodId: 702, currency: 'CNY', lines: [] }); await newer
  assert.equal(scope.data.value.periodId, 702)
  assert.equal(scope.busy.value, false)
  assert.equal(scope.reportError.value, '')
})

test('template read failure opens the dialog so a persistent error and retry can be shown', async () => {
  const scope = page({ allRecords: async () => { throw new Error('模板读取无权限') } })
  scope.bookId.value = 601
  await assert.doesNotReject(scope.showTemplates())
  assert.equal(scope.templateDialog.value, true)
  assert.equal(scope.templates.value.length, 0)
  assert.equal(scope.templateError.value, '模板读取无权限')
  assert.equal(scope.templatesBusy.value, false)
})

test('reports missing configuration cannot create an export task', async () => {
  let exports = 0
  const scope = page({ http: { postIdem: async () => { exports++ } } })
  scope.bookId.value = 601; scope.periodId.value = 701
  scope.data.value = { available: false, missingConfigurations: ['FIN_REPORT_TEMPLATE_MISSING'] }
  await scope.exportReport()
  assert.equal(exports, 0)
})

test('cancelling template review makes no request and does not leave an unhandled rejection', async () => {
  let reviews = 0
  const scope = page({
    http: { postIdem: async () => { reviews++ } },
    ElMessageBox: { confirm: async () => { throw 'cancel' } },
  })
  scope.bookId.value = 601
  await assert.doesNotReject(scope.reviewTemplate({ id: 1, version: 2 }))
  assert.equal(reviews, 0)
  assert.equal(scope.busy.value, false)
  assert.equal(scope.commandBusy.value, false)
  assert.equal(scope.commandError.value, '')
})

test('book read failure is retained until a successful retry instead of becoming an empty list', async () => {
  let attempt = 0
  const scope = page({ http: { get: async () => {
    if (++attempt === 1) throw new Error('账套接口不可用')
    return [{ id: 601, name: '测试账套', baseCurrency: 'CNY', periods: [] }]
  } } })
  await scope.loadBooks()
  assert.equal(scope.booksError.value, '账套接口不可用')
  assert.equal(scope.booksBusy.value, false)
  await scope.loadBooks()
  assert.equal(scope.booksError.value, '')
  assert.equal(scope.books.value[0].id, 601)
})

test('malformed report payload is a read error rather than a successful empty report', async () => {
  const scope = page({ http: { get: async () => ({ currency: 'CNY' }) } })
  scope.bookId.value = 601; scope.periodId.value = 701
  await scope.load()
  assert.equal(scope.data.value, null)
  assert.match(scope.reportError.value, /报表返回内容不完整/)
})

test('clearing a period invalidates the pending report and resets loading', async () => {
  const request = deferred()
  const scope = page({ http: { get: () => request.promise } })
  scope.bookId.value = 601; scope.periodId.value = 701
  const pending = scope.load()
  scope.periodId.value = undefined; await scope.load()
  assert.equal(scope.busy.value, false)
  request.resolve({ periodId: 701, lines: [] }); await pending
  assert.equal(scope.data.value, null)
  assert.equal(scope.reportError.value, '')
})

test('template responses from a previous book cannot populate the current book', async () => {
  const request = deferred()
  const scope = page({ allRecords: () => request.promise })
  scope.bookId.value = 601
  const pending = scope.showTemplates()
  scope.bookId.value = 602; scope.changeBook()
  request.resolve([{ id: 9, name: '旧账套模板' }]); await pending
  assert.deepEqual(scope.templates.value, [])
  assert.equal(scope.templateError.value, '')
  assert.equal(scope.templatesBusy.value, false)
})

test('a failed template save preserves the draft and the actionable error', async () => {
  const scope = page({ http: { postIdem: async () => { throw new Error('模板版本已变化，请重新加载') } } })
  scope.bookId.value = 601; scope.templateForm.name = '本期规则草稿'
  await scope.createTemplate()
  assert.equal(scope.templateForm.name, '本期规则草稿')
  assert.equal(scope.commandError.value, '模板版本已变化，请重新加载')
  assert.equal(scope.commandBusy.value, false)
})

test('malformed book payload is not treated as a successful empty book list', async () => {
  const scope = page({ http: { get: async () => ({ records: [] }) } })
  await scope.loadBooks()
  assert.deepEqual(scope.books.value, [])
  assert.match(scope.booksError.value, /账套返回内容不完整/)
})

test('review-only users can read templates without requesting editor-only account data', async () => {
  const paths = []
  const scope = page({
    useUserStore: () => ({ hasPerm: permission => Array.isArray(permission) || permission === 'fin:mapping:review' }),
    allRecords: async path => { paths.push(path); return [{ id: 9, status: 'NEED_REVIEW' }] },
  })
  scope.bookId.value = 601
  await scope.showTemplates()
  assert.deepEqual(paths, ['/fin/report-templates'])
  assert.equal(scope.templates.value[0].id, 9)
  assert.equal(scope.templateError.value, '')
})

test('export locks duplicate clicks and sends the selected report scope before opening jobs', async () => {
  const request = deferred(), calls = [], routes = []
  const scope = page({
    http: { postIdem: (path, body) => { calls.push({ path, body }); return request.promise } },
    useRouter: () => ({ push: async path => { routes.push(path) } }),
  })
  scope.bookId.value = 601; scope.periodId.value = 701; scope.tab.value = 'INCOME'
  scope.data.value = { available: true, lines: [] }
  const pending = scope.exportReport()
  await scope.exportReport()
  assert.equal(scope.commandBusy.value, true)
  assert.deepEqual(calls, [{ path: '/fin/reports/INCOME/export', body: { bookId: 601, periodId: 701 } }])
  request.resolve({ jobId: 9 }); await pending
  assert.deepEqual(routes, ['/jobs'])
  assert.equal(scope.commandBusy.value, false)
})

test('editing a pending draft retains its ID and fetched version on the idempotent update', async () => {
  const calls = []
  const scope = page({ http: { putIdem: async (path, body) => { calls.push({ path, body }) } } })
  scope.bookId.value = 601
  scope.editTemplate({ id: 9, version: 4, status: 'NEED_REVIEW', name: '本期规则', rule: 'CATEGORY_V1', lines: [] })
  await scope.createTemplate()
  assert.deepEqual(calls, [{ path: '/fin/report-templates/9', body: {
    bookId: 601, reportType: 'BALANCE_SHEET', name: '本期规则', rule: 'CATEGORY_V1', version: 4,
  } }])
  assert.equal(scope.commandError.value, '')
})

test('a saved template followed by a list failure stays successful and retries only the read', async () => {
  let saves = 0, retry = false
  const scope = page({
    http: { postIdem: async () => { saves++ } },
    allRecords: async () => { if (!retry) throw new Error('刷新列表超时'); return [] },
  })
  scope.bookId.value = 601; scope.templateForm.name = '已保存版本'
  await scope.createTemplate()
  assert.equal(saves, 1)
  assert.match(scope.templateNotice.value, /已保存/)
  assert.equal(scope.commandError.value, '')
  assert.equal(scope.templateError.value, '刷新列表超时')
  retry = true; await scope.loadTemplates()
  assert.equal(saves, 1)
  assert.equal(scope.templateError.value, '')
})

test('failed export retains its error and reuses the command intent when retried', async () => {
  const intents = []
  const scope = page({ http: { postIdem: async (_path, _body, intent) => {
    intents.push(intent)
    if (intents.length === 1) throw new Error('导出请求超时')
  } } })
  scope.bookId.value = 601; scope.periodId.value = 701; scope.data.value = { available: true, lines: [] }
  await scope.exportReport()
  assert.equal(scope.exportError.value, '导出请求超时')
  assert.equal(scope.commandBusy.value, false)
  await scope.exportReport()
  assert.equal(scope.exportError.value, '')
  assert.equal(intents.length, 2)
  assert.equal(intents[0], intents[1])
})
