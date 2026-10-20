import test from 'node:test'
import assert from 'node:assert/strict'
import { reactive, ref } from 'vue'
import { loadVueScript } from './contracts/load-vue-script.mjs'

const rate = { id: 91, version: 3, fromCcy: 'CNY', toCcy: 'MXN', rate: 2.5, rateDate: '2026-10-16', scope: 'ALL' }
const deferred = () => { let resolve; const promise = new Promise(yes => { resolve = yes }); return { promise, resolve } }
function setup({ dialog = async () => {}, write = async () => ({ id: 91 }) } = {}) {
  const country = reactive({ currentId: 3, epoch: 1, timezone: 'America/Mexico_City' }), user = reactive({ token: 'current', hasPerm: () => true })
  const calls = [], notices = [], intent = { testIntent: 'original-rate-command' }
  let reloads = 0
  const page = loadVueScript(new URL('../src/modules/master/ExchangeRateList.vue', import.meta.url), {
    ref, useCountryStore: () => country, useUserStore: () => user, CURRENCY_SOURCE: [], RATE_SCOPES: [], todayIn: () => '2026-10-16',
    createCommandIntent: () => intent,
    ElMessageBox: { confirm: dialog }, ElMessage: { info() {}, warning: text => notices.push(text), success: text => notices.push(text) },
    http: {
      post: async () => { throw new Error('Original confirm lacks required Idempotency-Key') },
      postIdem: async (...args) => { calls.push(args); return write(...args) },
    },
  }, ['confirm'])
  return { ...page, country, user, calls, notices, intent, reload: () => { reloads++ }, reloads: () => reloads }
}

test('native rate confirmation uses the existing idempotent command and selected row version', async () => {
  const p = setup(); await p.confirm(rate, p.reload)
  assert.equal(p.calls.length, 1)
  assert.deepEqual(p.calls[0].slice(0, 2), ['/md/exchange-rates/91/confirm', { version: 3 }])
  assert.equal(p.calls[0][2], p.intent); assert.equal(p.reloads(), 1)
})

test('failed confirmation retains the original command intent for an explicit retry', async () => {
  let attempts = 0
  const p = setup({ write: async () => { if (++attempts === 1) throw new Error('connection lost'); return { id: 91 } } })
  await assert.rejects(p.confirm(rate, p.reload), /connection lost/)
  await p.confirm(rate, p.reload)
  assert.equal(p.calls.length, 2); assert.equal(p.calls[0][2], p.calls[1][2]); assert.equal(p.reloads(), 1)
})

test('confirm dialog and late rate responses cannot cross the current country or login session', async () => {
  const question = deferred(), p = setup({ dialog: () => question.promise })
  const confirming = p.confirm(rate, p.reload)
  p.country.currentId = 183; p.country.epoch++; question.resolve(); await confirming
  assert.equal(p.calls.length, 0); assert.equal(p.reloads(), 0)
  const response = deferred(), q = setup({ write: () => response.promise })
  const writing = q.confirm(rate, q.reload); await new Promise(resolve => setImmediate(resolve))
  q.user.token = 'new-login'; response.resolve({ id: 91 }); await writing
  assert.equal(q.calls.length, 1); assert.equal(q.reloads(), 0); assert.equal(q.notices.length, 0)
})
