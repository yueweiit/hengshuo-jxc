import test from 'node:test'
import assert from 'node:assert/strict'
import { computed, ref } from 'vue'
import { loadVueScript } from './contracts/load-vue-script.mjs'

const file = new URL('../src/modules/sales/StoreDaily.vue', import.meta.url)
const summary = (date = '2026-10-24') => ({
  date, orderCount: 2, orderAmount: '120.50', outboundQty: '3.25',
  outboundAmount: '90.00', cash: '40.00', transfer: '50.00', pendingConfirm: '10.00',
})
function deferred() {
  let resolve, reject
  const promise = new Promise((yes, no) => { resolve = yes; reject = no })
  return { promise, resolve, reject }
}
function setup(get = async () => summary(), exposed = ['date', 'data', 'loading', 'error', 'load', 'goToday']) {
  const calls = []
  const hooks = { mounted: [], unmounted: [] }
  const country = { epoch: 1, timezone: 'America/Mexico_City', currency: 'MXN' }
  const clock = { date: '2026-10-24', timezones: [] }
  const page = loadVueScript(file, {
    computed, ref,
    onMounted: fn => hooks.mounted.push(fn),
    onBeforeUnmount: fn => hooks.unmounted.push(fn),
    useCountryStore: () => country,
    todayIn: timezone => { clock.timezones.push(timezone); return clock.date },
    http: { get: async (...args) => { calls.push(args); return get(...args) } },
  }, exposed)
  return { ...page, calls, hooks, country, clock }
}

test('a new date stops showing the previous date before the response arrives', async () => {
  const next = deferred()
  let count = 0
  const p = setup(() => ++count === 1 ? summary() : next.promise, ['date', 'data', 'load'])
  await p.load()
  p.date.value = '2026-10-23'
  const request = p.load()
  try { assert.equal(p.data.value, null) }
  finally { next.resolve(summary('2026-10-23')); await request }
})

test('mount queries the country-local date through the original daily endpoint', async () => {
  const p = setup()
  assert.equal(p.date.value, '2026-10-24')
  assert.deepEqual(p.clock.timezones, ['America/Mexico_City'])
  await p.hooks.mounted[0]()
  assert.deepEqual(p.calls, [['/sal/store-daily', { date: '2026-10-24' }, { silent: true }]])
  assert.equal(p.data.value.orderCount, 2)
  assert.equal(p.loading.value, false)
})

test('loading remains visible until the selected date has finished reading', async () => {
  const pending = deferred()
  const p = setup(() => pending.promise)
  const request = p.load()
  assert.equal(p.loading.value, true)
  assert.equal(p.error.value, '')
  pending.resolve(summary())
  await request
  assert.equal(p.loading.value, false)
})

test('real zeros and masked fields remain distinct without invented totals or currency', async () => {
  const p = setup(async () => ({ date: '2026-10-24', orderCount: 0, outboundQty: 0, cash: 0 }))
  await p.load()
  assert.equal(p.data.value.orderCount, 0)
  assert.equal(p.data.value.outboundQty, 0)
  assert.equal(p.data.value.cash, 0)
  assert.equal(p.data.value.orderAmount, undefined)
  assert.equal(p.data.value.pendingConfirm, undefined)
  assert.equal(p.data.value.currency, undefined)
})

test('a failed read keeps its real reason and retry can recover the same date', async () => {
  let count = 0
  const p = setup(async () => {
    if (++count === 1) throw new Error('当前账号无权查看门店日报')
    return summary()
  })
  await p.load()
  assert.equal(p.error.value, '当前账号无权查看门店日报')
  assert.equal(p.data.value, null)
  assert.equal(p.loading.value, false)
  await p.load()
  assert.equal(p.error.value, '')
  assert.equal(p.data.value.date, '2026-10-24')
})

test('an error without a message still produces a visible failure instead of a blank report', async () => {
  const p = setup(async () => { throw new Error('') })
  await p.load()
  assert.equal(p.data.value, null)
  assert.ok(p.error.value.length > 0)
  assert.equal(p.loading.value, false)
})

test('an older success cannot replace the selected day or stop its loading indicator', async () => {
  const pending = [deferred(), deferred()]
  let count = 0
  const p = setup(() => pending[count++].promise)
  const first = p.load()
  p.date.value = '2026-10-23'
  const second = p.load()
  pending[0].resolve(summary())
  await first
  assert.equal(p.data.value, null)
  assert.equal(p.loading.value, true)
  pending[1].resolve(summary('2026-10-23'))
  await second
  assert.equal(p.data.value.date, '2026-10-23')
  assert.equal(p.loading.value, false)
})

test('an older failure cannot erase a newer successful daily report', async () => {
  const pending = [deferred(), deferred()]
  let count = 0
  const p = setup(() => pending[count++].promise)
  const first = p.load()
  p.date.value = '2026-10-23'
  const second = p.load()
  pending[1].resolve(summary('2026-10-23'))
  await second
  pending[0].reject(new Error('旧日期网络超时'))
  await first
  assert.equal(p.data.value.date, '2026-10-23')
  assert.equal(p.error.value, '')
  assert.equal(p.loading.value, false)
})

test('unmount discards an unfinished response and prevents later requests', async () => {
  const pending = deferred()
  const p = setup(() => pending.promise)
  const request = p.load()
  p.hooks.unmounted[0]()
  pending.resolve(summary())
  await request
  assert.equal(p.data.value, null)
  await p.load()
  assert.equal(p.calls.length, 1)
})

test('a response from the previous country cannot populate the report', async () => {
  const pending = deferred()
  const p = setup(() => pending.promise)
  const request = p.load()
  p.country.epoch++
  pending.resolve(summary())
  await request
  assert.equal(p.data.value, null)
  assert.equal(p.error.value, '')
})

test('today is recalculated in the current country timezone before reading', async () => {
  const p = setup(async (_url, query) => summary(query.date))
  p.date.value = '2026-10-01'
  p.clock.date = '2026-10-25'
  await p.goToday()
  assert.equal(p.date.value, '2026-10-25')
  assert.equal(p.data.value.date, '2026-10-25')
  assert.deepEqual(p.clock.timezones, ['America/Mexico_City', 'America/Mexico_City'])
})

test('a successful transport with a different report date is not shown as the selected date', async () => {
  const p = setup(async () => summary('2026-10-23'))
  await p.load()
  assert.equal(p.data.value, null)
  assert.match(p.error.value, /日期/)
  assert.equal(p.loading.value, false)
})

test('an empty date is reported instead of silently requesting a default day', async () => {
  const p = setup()
  p.date.value = ''
  await p.load()
  assert.equal(p.calls.length, 0)
  assert.match(p.error.value, /日期/)
  assert.equal(p.data.value, null)
})
