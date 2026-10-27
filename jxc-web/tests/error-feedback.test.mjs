import test from 'node:test'
import assert from 'node:assert/strict'
import { existsSync } from 'node:fs'
import './support.mjs'
const url = new URL('../src/api/error-feedback.ts', import.meta.url)
async function center() {
  assert.ok(existsSync(url), '全局错误提示需要一个公共出口')
  const api = await import(url.href)
  api.clearErrors()
  localStorage.clear()
  return api
}

test('一个失败事件只报告一次，新的一次失败仍可报告且不自动执行动作', async () => {
  const c = await center(), error = new Error('审批失败')
  let runs = 0
  c.reportError(error, { title: '审批未完成', actions: [{ label: '查看原单', run: () => runs++ }] })
  c.reportError(error)
  c.reportError(new Error('审批失败'))
  assert.equal(c.getErrors().length, 2)
  assert.equal(runs, 0)
  assert.equal(c.getErrors()[0].title, '审批未完成')
  c.dismissError(c.getErrors()[0].id)
  assert.equal(c.getErrors().length, 1)
})

test('取消、旧身份响应和主动中止不冒充操作失败', async () => {
  const c = await center()
  for (const error of ['cancel', 'close', { code: 'ERR_CANCELED' }, { code: 'CONTEXT_CHANGED' }, { name: 'AbortError' }]) c.reportError(error)
  assert.deepEqual(c.getErrors(), [])
})

test('切换账号或国家后不能保留或执行旧错误的动作', async () => {
  const c = await center()
  localStorage.setItem('jxc.token', 'user-one')
  localStorage.setItem('jxc.countryId', '3')
  const notice = c.reportError(new Error('旧账号失败'))
  localStorage.setItem('jxc.token', 'user-two')
  assert.deepEqual(c.getErrors(), [])
  assert.equal(c.isCurrentError(notice.id), false)
})

test('错误关闭和订阅使用同一个反馈集合', async () => {
  const c = await center(), events = []
  const stop = c.subscribeErrors(items => events.push(items.length))
  const notice = c.reportError(new Error('读取失败'))
  c.dismissError(notice.id)
  stop()
  assert.deepEqual(events, [0, 1, 0])
})

test('后台相同读取键更新原通知，不影响独立失败', async () => {
  const c = await center()
  c.reportError(new Error('第一次断开'), { key: 'workbench:todos' })
  c.reportError(new Error('仍然断开'), { key: 'workbench:todos' })
  c.reportError(new Error('另一个操作失败'))
  assert.equal(c.getErrors().length, 2)
  assert.equal(c.getErrors()[0].message, '仍然断开')
})

test('未知错误提供真实原因及下一步，不把异常转为成功', async () => {
  const c = await center()
  const failure = Object.assign(new Error('服务暂不可用'), { code: 'SYS_UNEXPECTED', traceId: 'safe-trace' })
  const item = c.reportError(failure)
  assert.equal(item.message, '服务暂不可用')
  assert.ok(item.nextStep)
  assert.equal(item.traceId, 'safe-trace')
  assert.equal(c.feedbackMessage(failure), '服务暂不可用')
  assert.equal(c.getErrors().length, 1)
})

test('写请求超时提示先核对结果，不能提供自动再次提交', async () => {
  const c = await center()
  const failure = Object.assign(new Error('timeout'), { code: 'ECONNABORTED' })
  const item = c.reportError(failure, { method: 'POST' })
  assert.match(item.nextStep, /核对|查看/)
  assert.match(item.nextStep, /结果|状态/)
  assert.ok(item.actions.every(a => !a.run))
})

test('相同错误的后续业务补充不重复显示，保留更具体的标题和入口', async () => {
  const c = await center(), error = new Error('库存不足')
  c.reportError(error)
  c.reportError(error, { title: '销售订单审批未通过', actions: [{ label: '打开销售订单', to: '/sales/orders/7' }] })
  assert.equal(c.getErrors().length, 1)
  assert.equal(c.getErrors()[0].title, '销售订单审批未通过')
  assert.equal(c.getErrors()[0].actions[0].to, '/sales/orders/7')
})

test('服务端任意网址不成为全局操作入口，问题信息不包含凭据', async () => {
  const c = await center()
  const item = c.reportError({ code: 'UNKNOWN', message: '失败', data: { url: 'https://evil.example', password: 'secret-value' } })
  assert.ok(item.actions.every(a => !a.to?.startsWith('http')))
  assert.ok(!JSON.stringify(item).includes('secret-value'))
})
test('权限后来撤销时，已存在的库存明细也必须从全局提示隐藏', async () => {
  const { describeFailure } = await import('../src/api/error-guidance.ts')
  const { visibleDetails } = await center()
  const notice = describeFailure({ message: '库存不足', data: { kind: 'STOCK_SHORTAGE', detailsVisible: true, shortages: [{ productCode: 'P', warehouseName: 'B仓', warehouseId: 33, requiredQty: 20, availableQty: 10, shortageQty: 10, unit: '条' }] } }, {})
  assert.deepEqual(visibleDetails(notice, () => 'WRITE', () => false), [])
})
