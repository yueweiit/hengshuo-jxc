import test from 'node:test'
import assert from 'node:assert/strict'
import * as Vue from 'vue'
import { loadVueScript } from './contracts/load-vue-script.mjs'

const period = (id, year = 2026) => ({ id, fiscalYear: year, periodNo: id, name: `${year}-${String(id).padStart(2, '0')}`, startDate: `${year}-01-01`, endDate: `${year}-01-31`, status: 'OPEN' })
const book = (id, status = 'ACTIVE') => ({ id, entityId: id + 100, name: `账套${id}`, baseCurrency: 'CNY', status, version: 3, periods: [period(1)] })
const deferred = () => { let resolve; const promise = new Promise(yes => { resolve = yes }); return { promise, resolve } }

function harness({ get = async () => [book(1), book(2)], post, put, confirm = async () => {}, permitted = true, demo = false, extra = [] } = {}) {
  const writes = [], messages = [], intents = [], unmounts = []
  const user = Vue.reactive({ token: 'session-a', hasPerm: () => permitted })
  const country = Vue.reactive({ epoch: 1, currentId: 1, timezone: 'Asia/Shanghai' })
  const scope = Vue.effectScope()
  const p = scope.run(() => loadVueScript(new URL('../src/modules/finance/BookList.vue', import.meta.url), {
    ref: Vue.ref, reactive: Vue.reactive, computed: Vue.computed, watch: Vue.watch, onMounted() {}, onBeforeUnmount: fn => unmounts.push(fn),
    useUserStore: () => user, useCountryStore: () => country, todayIn: () => '2026-10-24', formatDate: value => value || '-',
    importMetaEnv: demo ? { MODE: 'demo', VITE_USE_MOCK: 'true' } : {},
    createCommandIntent: () => { const intent = { reset() {} }; intents.push(intent); return intent },
    ElMessage: Object.fromEntries(['success', 'warning', 'error'].map(kind => [kind, text => messages.push({ kind, text })])),
    ElMessageBox: { confirm },
    http: {
      get,
      postIdem: async (path, body, intent) => { writes.push({ path, body: structuredClone(body), intent }); return post ? post(path, body) : { created: 4 } },
      putIdem: async (path, body, intent) => { writes.push({ path, body: structuredClone(body), intent }); return put ? put(path, body) : {} },
    },
  }, ['load', 'books', 'gen', 'busy', 'edit', 'save', 'activate', 'dialog', 'form', ...extra]))
  return { p, writes, messages, intents, user, country, stop() { unmounts.forEach(fn => fn()); scope.stop() } }
}

test('a read failure is retained for retry instead of becoming a successful empty list', async () => {
  let fail = true
  const h = harness({ get: async () => { if (fail) throw new Error('账套服务连接失败'); return [] }, extra: ['listError', 'loaded'] })
  await assert.doesNotReject(h.p.load()); assert.match(h.p.listError.value, /连接失败/); assert.equal(h.p.loaded.value, false)
  fail = false; await h.p.load(); assert.equal(h.p.listError.value, ''); assert.equal(h.p.loaded.value, true); assert.deepEqual(h.p.books.value, []); h.stop()
})

test('malformed book and period responses are reported as errors', async () => {
  for (const response of [{ records: [] }, [{ ...book(1), periods: null }]]) {
    const h = harness({ get: async () => response, extra: ['listError'] }); await h.p.load()
    assert.ok(h.p.listError.value); assert.deepEqual(h.p.books.value, []); h.stop()
  }
})

test('a newer read wins even when the older read resolves last', async () => {
  const old = deferred(); let calls = 0
  const h = harness({ get: () => ++calls === 1 ? old.promise : [book(2)] })
  const pending = h.p.load(); await h.p.load(); old.resolve([book(1)]); await pending
  assert.equal(h.p.books.value[0].id, 2); h.stop()
})

test('each book keeps its own year and first month across refresh', async () => {
  const h = harness({ extra: ['periodForms'] }); await h.p.load()
  Object.assign(h.p.periodForms[1], { fiscalYear: 2025, firstMonth: 9 }); await h.p.gen(1); await h.p.gen(2)
  assert.deepEqual(h.writes.map(w => [w.path, w.body]), [
    ['/fin/periods?bookId=1', { fiscalYear: 2025, firstMonth: 9 }],
    ['/fin/periods?bookId=2', { fiscalYear: 2026, firstMonth: 1 }],
  ]); h.stop()
})

test('missing, out-of-range and fractional period settings never reach the server', async () => {
  const h = harness({ extra: ['periodForms', 'actionError'] }); await h.p.load()
  for (const change of [{ fiscalYear: undefined }, { fiscalYear: 1899 }, { fiscalYear: 10000 }, { fiscalYear: 2026.5 }, { firstMonth: undefined }, { firstMonth: 0 }, { firstMonth: 13 }, { firstMonth: 1.5 }]) {
    Object.assign(h.p.periodForms[1], { fiscalYear: 2026, firstMonth: 1 }, change); await h.p.gen(1)
    assert.equal(h.writes.length, 0); assert.ok(h.p.actionError.value)
  }
  h.stop()
})

test('demo, missing permission, draft and unknown books cannot generate periods', async () => {
  for (const options of [{ demo: true }, { permitted: false }, { get: async () => [book(1, 'DRAFT')] }, { get: async () => [] }]) {
    const h = harness(options); await h.p.load(); await h.p.gen(1); assert.equal(h.writes.length, 0); h.stop()
  }
})

test('repeated clicks cannot submit another period command while one is pending', async () => {
  const pending = deferred(); const h = harness({ post: () => pending.promise }); await h.p.load()
  const first = h.p.gen(1); await h.p.gen(1); await h.p.gen(2); assert.equal(h.writes.length, 1); assert.equal(h.p.busy.value, true)
  pending.resolve({ created: 3 }); await first; assert.equal(h.p.busy.value, false); h.stop()
})

test('a failed period command retains its inputs and intent for an explicit retry', async () => {
  let fail = true
  const h = harness({ post: async () => { if (fail) throw new Error('期间生成超时'); return { created: 3 } }, extra: ['periodForms', 'actionError'] }); await h.p.load()
  h.p.periodForms[1].firstMonth = 10; await h.p.gen(1)
  assert.match(h.p.actionError.value, /超时/); assert.equal(h.p.periodForms[1].firstMonth, 10); assert.equal(h.p.busy.value, false)
  fail = false; await h.p.gen(1); assert.equal(h.writes[0].intent, h.writes[1].intent); assert.equal(h.p.actionError.value, ''); h.stop()
})

test('command success is preserved if the subsequent list refresh fails', async () => {
  let fail = false
  const h = harness({ get: async () => { if (fail) throw new Error('刷新失败'); return [book(1)] }, post: async () => { fail = true; return { created: 0 } }, extra: ['listError', 'actionError'] })
  await h.p.load(); await h.p.gen(1)
  assert.match(h.p.listError.value, /刷新失败/); assert.equal(h.p.actionError.value, '')
  assert.equal(h.messages.filter(m => m.kind === 'success').length, 1); assert.equal(h.writes.length, 1); h.stop()
})

test('renaming trims input, rejects blank names and preserves the fetched version', async () => {
  const h = harness({ extra: ['saveError'] }); await h.p.load(); h.p.edit(h.p.books.value[0]); h.p.form.name = '   '
  await h.p.save(); assert.equal(h.writes.length, 0); assert.ok(h.p.saveError.value)
  h.p.form.name = '  新账套  '; await h.p.save()
  assert.deepEqual(h.writes[0].body, { name: '新账套', version: 3 }); assert.equal(h.p.dialog.value, false); h.stop()
})

test('a failed rename leaves the dialog and name available for retry', async () => {
  const h = harness({ put: async () => { throw new Error('名称保存失败') }, extra: ['saveError'] }); await h.p.load(); h.p.edit(h.p.books.value[0]); h.p.form.name = '保留名称'
  await h.p.save(); assert.match(h.p.saveError.value, /保存失败/); assert.equal(h.p.dialog.value, true); assert.equal(h.p.form.name, '保留名称'); h.stop()
})

test('activation cancellation does not write or display a failure', async () => {
  const h = harness({ get: async () => [book(1, 'DRAFT')], confirm: async () => { throw 'cancel' }, extra: ['actionError'] })
  await h.p.load(); await assert.doesNotReject(h.p.activate(h.p.books.value[0]))
  assert.equal(h.writes.length, 0); assert.equal(h.p.busy.value, false); assert.equal(h.p.actionError.value, ''); h.stop()
})

test('activation retains its versioned endpoint and explicit business boundary', async () => {
  let prompt
  const h = harness({ get: async () => [book(1, 'DRAFT')], confirm: async text => { prompt = text } }); await h.p.load(); await h.p.activate(h.p.books.value[0])
  assert.deepEqual(h.writes[0].body, { version: 3 }); assert.equal(h.writes[0].path, '/fin/books/1/activate'); assert.match(prompt, /不录入期初/); h.stop()
})

test('unmounting during confirmation prevents a late activation write', async () => {
  const confirmation = deferred()
  const h = harness({ get: async () => [book(1, 'DRAFT')], confirm: () => confirmation.promise }); await h.p.load()
  const pending = h.p.activate(h.p.books.value[0]); h.stop(); confirmation.resolve(); await pending
  assert.equal(h.writes.length, 0)
})

test('year filtering happens before pagination and resets the page', async () => {
  const periods = [...Array.from({ length: 12 }, (_,i) => period(i + 1, 2025)), ...Array.from({ length: 12 }, (_,i) => period(i + 1, 2026))]
  const h = harness({ get: async () => [{ ...book(1), periods }], extra: ['tables', 'filteredPeriods', 'pagedPeriods', 'resetPage'] }); await h.p.load()
  assert.equal(h.p.filteredPeriods(h.p.books.value[0]).length, 24); assert.equal(h.p.pagedPeriods(h.p.books.value[0]).length, 20)
  h.p.tables[1].page = 2; h.p.tables[1].year = 2026; h.p.resetPage(1)
  assert.equal(h.p.tables[1].page, 1); assert.equal(h.p.filteredPeriods(h.p.books.value[0]).length, 12)
  assert.ok(h.p.pagedPeriods(h.p.books.value[0]).every(p => p.fiscalYear === 2026))
  h.p.tables[1].page = 2; h.p.tables[1].size = 50; h.p.resetPage(1); assert.equal(h.p.tables[1].page, 1); h.stop()
})

test('a stale read after unmount cannot populate the removed page', async () => {
  const read = deferred(); const h = harness({ get: () => read.promise }); const pending = h.p.load(); h.stop(); read.resolve([book(1)]); await pending
  assert.deepEqual(h.p.books.value, [])
})

test('changing country before remount blocks commands against the old book snapshot', async () => {
  const h = harness(); await h.p.load(); h.p.edit(h.p.books.value[0]); h.country.epoch++; h.country.currentId = 2
  await h.p.gen(1); await h.p.save(); assert.equal(h.writes.length, 0); h.stop()
})

test('missing or impossible created counts do not produce a success message', async () => {
  for (const response of [{}, { created: -1 }, { created: 13 }, { created: '2' }]) {
    const h = harness({ post: async () => response, extra: ['actionError'] }); await h.p.load(); await h.p.gen(1)
    assert.ok(h.p.actionError.value); assert.equal(h.messages.filter(m => m.kind === 'success').length, 0); h.stop()
  }
})

test('message-less errors still show a failure and release the command lock', async () => {
  const h = harness({ post: async () => { throw new Error('') }, extra: ['actionError'] }); await h.p.load(); await h.p.gen(1)
  assert.ok(h.p.actionError.value); assert.equal(h.p.busy.value, false); h.stop()
})
