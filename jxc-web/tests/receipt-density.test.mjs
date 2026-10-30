import test from 'node:test'
import assert from 'node:assert/strict'
import { computed, reactive, ref, watch, nextTick } from 'vue'
import { loadVueScript, errorFeedback } from './contracts/load-vue-script.mjs'

const line = (id, overrides = {}) => ({ id, productId: id, productCode: `SKU-${id}`, productName: `商品${id}`, spec: '标准', dispatchQty: 10, goodQty: 10, damagedQty: 0, pendingInspectQty: 0, shortQty: 0, ...overrides })
const doc = (lines, id = 71) => ({ id, status: 'DRAFT', version: 1, lines })
function page(data = doc([line(1)]), read, beforeConfirm) {
  const route = reactive({ params: { id: '71' } }), errors = [], calls = [], stops = [], scrolled = [], warnings = [], successes = []
  let confirmText = ''
  const p = loadVueScript(new URL('../src/modules/logistics/LgsReceiptForm.vue', import.meta.url), {
    computed, ref, nextTick, watch: (...args) => { const stop = watch(...args); stops.push(stop); return stop }, onMounted() {}, onBeforeUnmount() {},
    useRoute: () => route, useRouter: () => ({}), useUserStore: () => ({ hasPerm: () => true }), useCountryStore: () => ({ timezone: 'America/Mexico_City' }),
    getCountryId: () => 2, getToken: () => 'session', createCommandIntent: () => ({}),
    reportError(error, options) { const notice = errorFeedback.reportError(error, options); if (notice) errors.push(notice.message) },
    BizError: class extends Error {}, ElMessage: { error: text => errors.push(text), success: text => successes.push(text), warning: text => warnings.push(text) }, ElMessageBox: { confirm: async text => { confirmText = text; await beforeConfirm?.() } },
    document: { getElementById: id => ({ scrollIntoView: () => scrolled.push(id) }) },
    matchBarcode: (row, code) => row.productCode === code || (row.barcodeText ?? '').split(/\s+/).includes(code),
    http: { get: async () => read ? read() : data, put: async (url, body) => { calls.push({ url, body }); return {} }, postIdem: async (url, body) => { calls.push({ url, body }); return {} } },
  }, ['r', 'lineQuery', 'lineFilter', 'linePage', 'linePageSize', 'filteredLines', 'pagedLines', 'totals', 'filteredTotals', 'checked', 'active', 'onScan', 'balanced', 'autoGood', 'allBalanced', 'load', 'loadError', 'editable', 'saveDraft', 'confirm'])
  p.r.value = data
  return { ...p, route, errors, calls, scrolled, warnings, successes, confirmText: () => confirmText, dispose: () => stops.forEach(stop => stop()) }
}

test('filtering and totals use all matching lines before pagination and preserve repeated SKU source lines', async () => {
  const p = page(doc(Array.from({ length: 25 }, (_, i) => line(i + 1, { productId: 1, productCode: 'SAME', goodQty: 9, shortQty: 1 }))))
  p.linePage.value = 2
  assert.equal(p.pagedLines.value.length, 5)
  assert.equal(p.filteredTotals.value.dispatch, 250)
  assert.equal(p.totals.value.skus, 1)
  p.lineQuery.value = '商品25'; await nextTick()
  assert.equal(p.linePage.value, 1)
  assert.deepEqual(p.pagedLines.value.map(row => row.id), [25])
  assert.equal(p.filteredTotals.value.short, 1)
  p.dispose()
})

test('exception filter includes damage, pending, shortage and unbalanced rows; size changes reset page', async () => {
  const p = page(doc([line(1), line(2, { goodQty: 9, damagedQty: 1 }), line(3, { goodQty: 9, pendingInspectQty: 1 }), line(4, { goodQty: 9, shortQty: 1 }), line(5, { goodQty: 8 })]))
  p.lineFilter.value = 'exception'; await nextTick()
  assert.deepEqual(p.filteredLines.value.map(row => row.id), [2, 3, 4, 5])
  p.linePage.value = 2; p.linePageSize.value = 50; await nextTick()
  assert.equal(p.linePage.value, 1)
  p.dispose()
})

test('scan clears blocking filters, reveals the target page and checks duplicate SKU lines one at a time', async () => {
  const p = page(doc([...Array.from({ length: 20 }, (_, i) => line(i + 1)), line(21, { productCode: 'DUP', barcodeText: 'BAR-21' }), line(22, { productCode: 'DUP', barcodeText: 'BAR-21' })]))
  p.lineQuery.value = 'invisible'; p.lineFilter.value = 'exception'; await nextTick()
  await p.onScan('BAR-21')
  assert.equal(p.lineQuery.value, ''); assert.equal(p.lineFilter.value, 'all'); assert.equal(p.linePage.value, 2)
  assert.equal(p.active.value, 21); assert.deepEqual([...p.checked.value], [21]); assert.deepEqual(p.scrolled, ['line-21'])
  await p.onScan('DUP'); assert.equal(p.active.value, 22); assert.deepEqual([...p.checked.value], [21, 22])
  await p.onScan('MISSING'); assert.equal(p.errors.length, 1); assert.equal(p.checked.value.size, 2)
  p.dispose()
})

test('quantity conservation supports four decimals and rejects blank, negative or nonfinite inputs', () => {
  const p = page()
  assert.equal(p.balanced(line(1, { dispatchQty: 0.3, goodQty: 0.1, damagedQty: 0.2 })), true)
  const edited = line(1, { dispatchQty: 0.3, pendingInspectQty: 0.1, shortQty: 0.1 }); p.autoGood(edited)
  assert.equal(edited.goodQty, 0.1); assert.equal(p.balanced(edited), true)
  for (const goodQty of [null, undefined, NaN, Infinity, -1, 0.12345]) assert.equal(p.balanced(line(1, { goodQty })), false)
  p.dispose()
})

test('confirmation validates the full document and submits every line despite filters or pagination', async () => {
  const p = page(doc([line(1), line(2, { goodQty: 9 })]))
  p.lineQuery.value = '商品1'; await nextTick(); await p.confirm()
  assert.equal(p.calls.length, 0); assert.equal(p.errors.length, 1)
  p.r.value.lines[1].goodQty = 10; await p.confirm()
  assert.equal(p.calls[0].body.lines.length, 2); assert.match(p.confirmText(), /2 行未扫码/)
  p.dispose()
})

test('read failure is explicit, blocks stale editing, preserves draft until successful retry', async () => {
  let fail = true
  const p = page(doc([line(1)]), () => { if (fail) throw new Error('网络中断'); return doc([line(2)]) })
  await p.load(); assert.match(p.loadError.value, /网络中断/); assert.equal(p.editable.value, false)
  assert.equal(p.r.value.lines[0].id, 1)
  fail = false; await p.load(); assert.equal(p.loadError.value, ''); assert.equal(p.editable.value, true); assert.equal(p.r.value.lines[0].id, 2)
  p.dispose()
})

test('switching receipts clears scan and filter state before another document is loaded', async () => {
  const p = page()
  p.checked.value.add(1); p.active.value = 1; p.lineQuery.value = 'old'
  p.route.params.id = '72'; await nextTick()
  assert.equal(p.checked.value.size, 0); assert.equal(p.active.value, null); assert.equal(p.lineQuery.value, '')
  p.dispose()
})

test('confirmation dialog locks duplicate commands and draft edits until a decision is made', async () => {
  let decide
  const p = page(doc([line(1)]), undefined, () => new Promise(resolve => { decide = resolve }))
  const first = p.confirm()
  assert.equal(p.editable.value, false)
  await p.confirm(); await p.saveDraft(); assert.equal(p.calls.length, 0)
  decide(); await first; assert.equal(p.calls.length, 1)
  p.dispose()
})

test('a successful command followed by failed read reports saved state and blocks stale retry commands', async () => {
  const p = page(doc([line(1)]), () => { throw new Error('refresh failed') })
  await p.saveDraft()
  assert.equal(p.calls.length, 1); assert.equal(p.successes.length, 0); assert.match(p.warnings[0], /已暂存/)
  await p.saveDraft(); assert.equal(p.calls.length, 1)
  p.dispose()
})
