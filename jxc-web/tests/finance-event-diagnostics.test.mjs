import test from 'node:test'
import assert from 'node:assert/strict'
import { ref } from 'vue'
import { loadVueScript, errorFeedback } from './contracts/load-vue-script.mjs'

class BizError extends Error {
  constructor(code, message) { super(message); this.code = code }
}

function fixture({ result, failure, refreshFailure } = {}) {
  errorFeedback.clearErrors()
  const calls = [], messages = [], intent = {}
  const refreshed = [{ id: 1207, status: 'FAILED', failReason: 'FIN_MAPPING_MISSING' }]
  const page = loadVueScript(new URL('../src/modules/finance/EventList.vue', import.meta.url), {
    ref, onMounted() {}, useRoute: () => ({ query: {} }), BizError,
    createCommandIntent: () => intent,
    reportError(error, options) { const notice = errorFeedback.reportError(error, options); if (notice) messages.push({ kind: 'error', text: notice.nextStep }) },
    http: { async postIdem(...args) {
      calls.push({ action: 'generate', args })
      if (failure) throw failure
      return result
    } },
    async allRecords(path, params) {
      calls.push({ action: 'refresh', path, params })
      if (refreshFailure) throw refreshFailure
      return refreshed
    },
    ElMessage: {
      success(text) { messages.push({ kind: 'success', text }) },
      error(text) { messages.push({ kind: 'error', text }) },
    },
  }, ['gen', 'rows', 'bookId'])
  page.bookId.value = 5
  return { page, calls, messages, intent, refreshed }
}

for (const [eventType, label] of [
  ['RTN_REFUND_PAID', '退款支付'],
  ['RTN_SALES_INSPECTED', '销售退货验收'],
  ['RTN_SALES_SETTLED', '销售退货结算'],
]) {
  test(`missing accounting configuration explains ${label} and refreshes the failed event without retrying`, async () => {
    const f = fixture({ failure: new BizError('FIN_MAPPING_MISSING', '凭证生成失败，请查看并修复事件诊断后重试') })
    await f.page.gen({ id: 1207, eventType })
    assert.deepEqual(f.calls.map(call => call.action), ['generate', 'refresh'])
    assert.equal(f.messages.length, 1)
    assert.equal(f.messages[0].kind, 'error')
    assert.match(f.messages[0].text, new RegExp(label))
    assert.match(f.messages[0].text, /记账配置.*缺失或不完整/)
    assert.match(f.messages[0].text, /凭证映射模板/)
    assert.match(f.messages[0].text, /科目.*资金账户/)
    assert.match(f.messages[0].text, /复核.*重试/)
    assert.deepEqual(f.page.rows.value, f.refreshed)
    assert.equal(f.calls[0].args[2], f.intent)
    assert.equal(f.calls[0].args[3].silent, true)
  })
}

test('a new permission, network, or unknown failure preserves its reason despite the row having an older mapping error', async () => {
  for (const failure of [
    new BizError('SYS_FORBIDDEN', '没有生成凭证的权限'),
    new BizError('FUTURE_RULE_FAILED', '来源规则发生冲突'),
    new Error('连接已断开'),
  ]) {
    const f = fixture({ failure })
    await f.page.gen({ id: 1207, eventType: 'RTN_REFUND_PAID', failReason: 'FIN_MAPPING_MISSING' })
    assert.deepEqual(f.messages, [{ kind: 'error', text: failure.message }])
    assert.deepEqual(f.calls.map(call => call.action), ['generate', 'refresh'])
  }
})

test('a diagnostic refresh failure propagates separately after reporting the original generation failure', async () => {
  const refreshFailure = new BizError('NETWORK_ERROR', '诊断列表读取超时')
  const f = fixture({ failure: new BizError('FIN_MAPPING_MISSING', '生成失败'), refreshFailure })
  await assert.rejects(f.page.gen({ id: 1207, eventType: 'RTN_REFUND_PAID' }), error => error === refreshFailure)
  assert.equal(f.messages.length, 1)
  assert.equal(f.messages[0].kind, 'error')
  assert.match(f.messages[0].text, /退款支付.*记账配置/)
  assert.deepEqual(f.calls.map(call => call.action), ['generate', 'refresh'])
})

for (const [result, expected] of [
  [{ status: 'GENERATED', voucherNo: 'V-1207' }, '已生成待审凭证 V-1207'],
  [{ status: 'GENERATED', duplicate: true }, '这张事件已经有凭证'],
  [{ status: 'NO_VOUCHER' }, '已保存复核后的无会计影响解释'],
]) {
  test(`successful generation keeps the existing message: ${expected}`, async () => {
    const f = fixture({ result })
    await f.page.gen({ id: 1207, eventType: 'RTN_REFUND_PAID' })
    assert.deepEqual(f.messages, [{ kind: 'success', text: expected }])
    assert.deepEqual(f.calls.map(call => call.action), ['generate', 'refresh'])
    assert.equal(f.calls[0].args[0], '/fin/events/1207/generate')
    assert.deepEqual(f.calls[0].args[1], { bookId: 5 })
    assert.equal(f.calls[0].args[2], f.intent)
  })
}
