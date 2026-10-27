import test from 'node:test'
import assert from 'node:assert/strict'
import { reactive, ref } from 'vue'
import { loadVueScript, errorFeedback } from './contracts/load-vue-script.mjs'
import { loadTsModule } from './contracts/load-ts-module.mjs'
const drafts = loadTsModule(new URL('../src/modules/approval/opinion-draft.ts', import.meta.url))

const file = new URL('../src/modules/approval/ApprovalTaskList.vue', import.meta.url)
const result = (records = [], total = records.length) => ({ records, total, page: 1, size: 20 })
const task = (id = 1) => ({ id, docType: 'SALES_ORDER', docId: id, docNo: `SO-00${id}`, docTitle: '审批单据', status: 'PENDING', instanceStatus: 'PENDING', currency: 'CNY', amount: 100 })
function setup(options = {}) {
  const calls = [], unmounted = []
  const page = loadVueScript(file, {
    ...drafts,
    reactive, ref, onMounted() {}, onBeforeUnmount: fn => unmounted.push(fn),
    defineProps: () => ({ mode: options.mode ?? 'todo' }),
    useTodoStore: () => ({ refresh: async () => { calls.push(['summary']); await options.summary?.() } }),
    useUserStore: () => ({ fieldAccess: () => 'READ', hasPerm: () => true }),
    financeSourcePath: () => undefined,
    ElMessage: { success: text => calls.push(['success', text]), warning: text => calls.push(['warning', text]) },
    http: {
      get: async (url, query, config) => { calls.push(['get', url, { ...query }, config]); return options.get ? await options.get(url, query) : result() },
      post: async (url, body, config) => { calls.push(['post', url, body, config]); await options.post?.(url, body) },
    },
  }, ['query', 'applied', 'rows', 'page', 'size', 'total', 'loading', 'loadError', 'forbidden', 'summaryError', 'load', 'search', 'resetSearch', 'changePage', 'changeSize', 'refreshPage', 'openAction', 'submitAction', 'action', 'drawerVisible'])
  return { ...page, calls, unmounted }
}

test('approval pagination uses the server total, selected page and supported size', async () => {
  const p = setup({ get: async () => result([task(21)], 67) })
  assert.equal(p.size.value, 20)
  await p.changePage(2)
  assert.deepEqual(p.calls[0], ['get', '/wf/tasks/mine', { mode: 'todo', keyword: undefined, docType: undefined, page: 2, size: 20 }, { silent: true }])
  assert.equal(p.total.value, 67)
  assert.deepEqual(p.rows.value, [task(21)])
  await p.changeSize(50)
  assert.equal(p.page.value, 1)
  assert.equal(p.calls.at(-1)[2].size, 50)
  const count = p.calls.length
  await p.changeSize(999)
  assert.equal(p.calls.length, count)
  assert.equal(p.size.value, 50)
})

test('search applies trimmed server filters; editing draft inputs does not change pagination filters', async () => {
  const p = setup({ get: async () => result([], 67) })
  p.query.keyword = '  SO-0021  '; p.query.docType = 'SALES_ORDER'; p.page.value = 3
  await p.search()
  assert.equal(p.page.value, 1)
  assert.equal(p.calls.at(-1)[2].keyword, 'SO-0021')
  p.query.keyword = 'not submitted'; p.query.docType = 'REFUND'
  await p.changePage(2)
  assert.equal(p.calls.at(-1)[2].keyword, 'SO-0021')
  assert.equal(p.calls.at(-1)[2].docType, 'SALES_ORDER')
})

test('reset clears applied filters and starts from the first page', async () => {
  const p = setup()
  p.query.keyword = '退货'; p.query.docType = 'SALES_RETURN'; await p.search()
  p.page.value = 4; await p.resetSearch()
  assert.deepEqual({ ...p.query }, { keyword: '', docType: '' })
  assert.deepEqual({ ...p.applied }, { keyword: '', docType: '' })
  assert.equal(p.page.value, 1)
  assert.equal(p.calls.at(-1)[2].keyword, undefined)
})

test('a shrinking pending queue reloads the last valid page', async () => {
  const p = setup({ get: async (_, query) => query.page === 3 ? result([], 21) : result([task(21)], 21) })
  await p.changePage(3)
  assert.equal(p.page.value, 2)
  assert.deepEqual(p.calls.filter(call => call[0] === 'get').map(call => call[2].page), [3, 2])
  assert.equal(p.rows.value[0].id, 21)
})

test('failed reads clear stale actionable rows and retain an explicit retryable error', async () => {
  const p = setup({ get: async () => { throw new Error('审批查询超时') } })
  p.rows.value = [task()]; await p.load()
  assert.equal(p.loadError.value, '审批查询超时')
  assert.deepEqual(p.rows.value, [])
  assert.equal(p.loading.value, false)
  assert.equal(p.forbidden.value, false)
})

test('the actual server permission error is distinct from an empty approval queue', async () => {
  const p = setup({ get: async () => { throw Object.assign(new Error('没有该操作权限'), { code: 'SYS_FORBIDDEN' }) } })
  await p.load()
  assert.equal(p.forbidden.value, true)
  assert.equal(p.loadError.value, '没有该操作权限')
})

test('a successful empty queue and a subsequent retry clear prior failure state', async () => {
  let fail = true
  const p = setup({ get: async () => { if (fail) throw new Error('网络中断'); return result() } })
  await p.load(); fail = false; await p.load()
  assert.equal(p.loadError.value, '')
  assert.equal(p.total.value, 0)
  assert.deepEqual(p.rows.value, [])
})

test('older reads cannot replace the newest page or remove its loading state', async () => {
  const pending = []
  const p = setup({ get: () => new Promise((resolve, reject) => pending.push({ resolve, reject })) })
  const first = p.load(), second = p.changePage(2)
  pending[0].reject(new Error('旧请求失败')); await first
  assert.equal(p.loading.value, true)
  assert.equal(p.loadError.value, '')
  pending[1].resolve(result([task(21)], 60)); await second
  assert.equal(p.rows.value[0].id, 21)
  assert.equal(p.loading.value, false)
})

test('unmount discards a pending list response', async () => {
  let release
  const p = setup({ get: () => new Promise(resolve => { release = resolve }) })
  const request = p.load(); p.unmounted.forEach(fn => fn()); release(result([task()])); await request
  assert.deepEqual(p.rows.value, [])
})

test('reject requires a nonblank reason and preserves the open form', async () => {
  const p = setup()
  p.openAction(task(), 'reject'); p.action.comment = '   '; await p.submitAction()
  assert.equal(p.action.visible, true)
  assert.equal(p.action.validation, '请填写驳回原因')
  assert.equal(p.calls.some(call => call[0] === 'post'), false)
})

test('approval permits no opinion and serializes double submissions', async () => {
  let release
  const p = setup({ post: () => new Promise(resolve => { release = resolve }) })
  p.openAction(task(), 'approve')
  const first = p.submitAction(), second = p.submitAction()
  assert.equal(p.action.saving, true)
  p.openAction(task(2), 'reject')
  assert.equal(p.action.task.id, 1)
  release(); await Promise.all([first, second])
  assert.equal(p.calls.filter(call => call[0] === 'post').length, 1)
  assert.equal(p.calls.find(call => call[0] === 'post')[1], '/wf/tasks/1/approve')
  assert.equal(p.action.visible, false)
})

test('rejected requests preserve the opinion and allow an explicit retry', async () => {
  let fail = true
  const p = setup({ post: async () => { if (fail) throw new Error('单据已失效，请刷新') } })
  p.openAction(task(), 'reject'); p.action.comment = '请补充凭证'; await p.submitAction()
  assert.equal(p.action.visible, true)
  assert.equal(p.action.comment, '请补充凭证')
  assert.equal(errorFeedback.getErrors().at(-1).message, '单据已失效，请刷新')
  assert.equal(p.action.saving, false)
  fail = false; await p.submitAction()
  assert.equal(p.action.visible, false)
})

test('通过全局入口离开再返回时恢复失败意见，成功审批后清除', async () => {
  const p = setup({ post: async () => { throw new Error('库存不足') } })
  p.openAction(task(98), 'approve'); p.action.comment = '已核对单据'; await p.submitAction()
  await errorFeedback.getErrors().at(-1).beforeNavigate({ label: '查看库存' })
  p.unmounted.forEach(fn => fn())
  const returned = setup()
  returned.openAction(task(98), 'approve')
  assert.equal(returned.action.comment, '已核对单据')
  await returned.submitAction()
  const again = setup(); again.openAction(task(98), 'approve')
  assert.equal(again.action.comment, '')
})

test('successful processing refreshes list and summary; summary failure never reclassifies the write', async () => {
  const p = setup({ summary: async () => { throw new Error('汇总暂不可用') } })
  p.openAction(task(), 'approve'); await p.submitAction()
  assert.equal(p.action.visible, false)
  assert.equal(Object.hasOwn(p.action, 'error'), false, '错误只保存在全局出口，不在审批表单重复存一份')
  assert.equal(p.summaryError.value, '汇总暂不可用')
  assert.equal(p.calls.filter(call => call[0] === 'post').length, 1)
  assert.equal(p.calls.filter(call => call[0] === 'get').length, 1)
  assert.equal(p.calls.filter(call => call[0] === 'summary').length, 1)
})

test('list reload failure after a successful write remains a list error without posting twice', async () => {
  const p = setup({ get: async () => { throw new Error('列表读取失败') } })
  p.openAction(task(), 'approve'); await p.submitAction()
  assert.equal(p.action.visible, false)
  assert.equal(p.loadError.value, '列表读取失败')
  assert.equal(Object.hasOwn(p.action, 'error'), false)
  assert.equal(p.calls.filter(call => call[0] === 'post').length, 1)
})

test('processed or invalidated tasks never open an action or post from the done page', async () => {
  for (const options of [{ mode: 'done' }, {}]) {
    const p = setup(options)
    p.openAction({ ...task(), instanceStatus: options.mode ? 'PENDING' : 'INVALIDATED' }, 'approve')
    await p.submitAction()
    assert.equal(p.action.visible, false)
    assert.equal(p.calls.some(call => call[0] === 'post'), false)
  }
})

test('a response after leaving the approval page cannot close another page or refresh its counts', async () => {
  let release
  const p = setup({ post: () => new Promise(resolve => { release = resolve }) })
  p.openAction(task(), 'approve'); const request = p.submitAction()
  p.unmounted.forEach(fn => fn()); release(); await request
  assert.equal(p.calls.some(call => call[0] === 'summary' || call[0] === 'success'), false)
})
