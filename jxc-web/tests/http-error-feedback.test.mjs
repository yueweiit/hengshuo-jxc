import test from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import ts from 'typescript'
import './support.mjs'
const feedback = await import('../src/api/error-feedback.ts')

function api(send) {
  const module = { exports: {} }, messages = [], redirects = []
  const source = ts.transpileModule(readFileSync(new URL('../src/api/http.ts', import.meta.url), 'utf8'), { compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022, esModuleInterop: true } }).outputText
  const deps = {
    axios: { create: () => ({ request: send }) },
    'element-plus': { ElMessage: { error: m => messages.push(m) } },
    '@/utils/session': { getToken: () => localStorage.getItem('jxc.token'), getCountryId: () => Number(localStorage.getItem('jxc.countryId')), clearSession: () => localStorage.removeItem('jxc.token') },
    '@/router': { router: { currentRoute: { value: { fullPath: '/approvals/mine' } }, replace: p => redirects.push(p) } },
    '@/api/error-feedback': feedback,
    './command-intent': {}, './attachment-download': {},
  }
  new Function('require', 'module', 'exports', source)(name => { assert.ok(name in deps, name); return deps[name] }, module, module.exports)
  return { ...module.exports, messages, redirects, route: deps['@/router'].router.currentRoute }
}
test.beforeEach(() => { feedback.clearErrors(); localStorage.clear() })
test('HTTP失败使用全局反馈且继续抛出原业务错误和追踪号', async () => {
  const { http, messages } = api(async () => { throw { response: { status: 409, data: { code: 'INV_INSUFFICIENT_AVAILABLE', message: '库存不足', traceId: 'trace-7' } }, config: {} } })
  await assert.rejects(http.post('/wf/tasks/7/approve', {}), e => e.code === 'INV_INSUFFICIENT_AVAILABLE')
  assert.equal(feedback.getErrors().length, 1)
  assert.equal(feedback.getErrors()[0].traceId, 'trace-7')
  assert.deepEqual(messages, [])
})
test('HTTP200业务失败和HTTP失败走同一个出口', async () => {
  const { http } = api(async () => ({ data: { code: 'SYS_FORBIDDEN', message: '没有权限', data: null, traceId: 'trace-8' } }))
  await assert.rejects(http.get('/test'), e => e.code === 'SYS_FORBIDDEN')
  assert.equal(feedback.getErrors().length, 1)
  assert.match(feedback.getErrors()[0].nextStep, /权限/)
})
test('静默请求保留当前页面有效性判断，页面报告时也能获得请求上下文', async () => {
  const { http } = api(async () => { throw { code: 'ECONNABORTED', message: 'timeout', config: {} } })
  let failure
  try { await http.post('/ar/receipts', {}, { silent: true }) } catch (e) { failure = e }
  assert.deepEqual(feedback.getErrors(), [])
  feedback.reportError(failure)
  assert.match(feedback.getErrors()[0].nextStep, /可能已经成功/)
})
test('已切换身份的迟到请求不弹全局错误', async () => {
  localStorage.setItem('jxc.token', 'old')
  const { http } = api(async () => { localStorage.setItem('jxc.token', 'new'); throw { message: 'old error', config: {} } })
  await assert.rejects(http.get('/test'), e => e.code === 'CONTEXT_CHANGED')
  assert.deepEqual(feedback.getErrors(), [])
})

test('离开页面后的迟到读取失败不报告，但写请求失败仍指向原页面', async () => {
  let reject
  const client = api(() => new Promise((_, no) => { reject = no }))
  const read = client.http.get('/test')
  client.route.value.fullPath = '/inventory/stocks'
  reject({ message: '旧读取失败' })
  await assert.rejects(read)
  assert.deepEqual(feedback.getErrors(), [])
  client.route.value.fullPath = '/approvals/mine'
  const write = client.http.post('/test', {})
  client.route.value.fullPath = '/inventory/stocks'
  reject({ code: 'ECONNABORTED', message: '写入结果未知' })
  await assert.rejects(write)
  assert.equal(feedback.getErrors().length, 1)
  assert.ok(feedback.getErrors()[0].actions.some(a => a.to === '/approvals/mine'))
})
