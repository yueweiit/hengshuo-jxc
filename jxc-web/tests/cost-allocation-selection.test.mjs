import test from 'node:test'
import assert from 'node:assert/strict'
import * as Vue from 'vue'
import { loadVueScript } from './contracts/load-vue-script.mjs'

const fee = (id, changes = {}) => ({ id, docNo: `FEE-${id}`, status: 'CONFIRMED', costTreatment: 'CAPITALIZE', costStatus: 'READY', baseAmount: '120.00', amount: '20.00', currency: 'USD', expenseItemName: '海运费', carrierName: '远航物流', shipmentNo: 'SEA-102', ...changes })

function setup({ selection = false, fees = [fee(7)], history = [], permissions = true, read, post } = {}) {
  const calls = [], warnings = [], scope = Vue.ref('country-1')
  const page = loadVueScript(new URL('../src/modules/cost/AllocationList.vue', import.meta.url), {
    ref: Vue.ref, reactive: Vue.reactive, computed: Vue.computed, watch: Vue.watch, onMounted() {}, onBeforeUnmount() {},
    useUserStore: () => ({ hasPerm: codes => Array.isArray(permissions) ? (Array.isArray(codes) ? codes : [codes]).some(code => permissions.includes(code)) : permissions }), getCountryId: () => scope.value, getToken: () => 'session-A',
    createCommandIntent: () => ({ reset() {} }),
    ElMessage: { warning: value => warnings.push(value), success() {}, info() {} },
    allRecords: async path => { if (read) return read(path); return path === '/lgs/fees' ? fees : history },
    http: { postIdem: async (path, body) => {
      calls.push({ path, body: structuredClone(body) })
      if (post) return post(path, body)
      return { id: 81, feeId: body?.feeId ?? 7, status: path.endsWith('/confirm') ? 'CONFIRMED' : 'DRAFT', lines: [{ batchId: 201, amount: '120.00' }] }
    } },
  }, ['run', 'load', 'form', 'preview', 'rows', ...(selection ? ['loadFees', 'feeOptions', 'filteredFees', 'filterFees', 'chooseFee', 'feesError', 'historyError', 'canConfirm', 'commandError'] : [])])
  return { page, calls, warnings, scope }
}

test('confirmation requires a viewed matching preview and sends no command without it', async () => {
  const { page, calls, warnings } = setup()
  page.form.feeId = 7
  await page.run(true)
  assert.equal(calls.length, 0)
  assert.ok(warnings.some(text => text.includes('预览')))
})

test('changing the fee or allocation basis immediately removes the previous preview', async () => {
  const { page } = setup()
  page.form.feeId = 7; await page.run(false)
  assert.ok(page.preview.value)
  page.form.basis = 'VALUE'
  assert.equal(page.preview.value, null)
  await page.run(false)
  page.form.feeId = 8
  assert.equal(page.preview.value, null)
})

test('candidates exclude invalid fees and active estimate replacements while reversed allocations allow selection', async () => {
  const { page } = setup({ selection: true, fees: [
    fee(7), fee(8, { status: 'DRAFT' }), fee(9, { costTreatment: 'PERIOD_EXPENSE' }), fee(10, { costStatus: 'PENDING_RATE', baseAmount: null }),
    fee(11, { actualFeeId: 12 }), fee(12, { estimateFeeId: 11 }), fee(13), fee(14), fee(15),
  ], history: [{ feeId: 11, status: 'CONFIRMED' }, { feeId: 13, status: 'CONFIRMED' }, { feeId: 14, status: 'REVERSED' }, { feeId: 15, status: 'DRAFT' }] })
  await page.load(); await page.loadFees()
  assert.deepEqual(page.feeOptions.value.map(item => item.id), [7, 14, 15])
})

test('fee search matches each business reference without changing the selected real fee ID', async () => {
  const { page } = setup({ selection: true, fees: [fee(7), fee(8, { docNo: 'LOCAL-8', expenseItemName: '装卸费', carrierName: '本地运输', shipmentNo: 'AIR-003' })] })
  await page.load(); await page.loadFees()
  for (const keyword of ['fee-7', '7', '海运', '远航', 'sea-102']) {
    page.filterFees(keyword)
    assert.deepEqual(page.filteredFees.value.map(item => item.id), [7], keyword)
  }
  page.chooseFee(7)
  assert.equal(page.form.feeId, 7)
  page.filterFees('不存在的费用')
  assert.deepEqual(page.filteredFees.value, [])
  assert.equal(page.form.feeId, 7)
})

test('manual selection accepts an existing positive ID and rejects text, decimals, unsafe IDs and known invalid fees', async () => {
  const { page, calls } = setup({ selection: true, fees: [fee(8, { status: 'DRAFT' })] })
  await page.load(); await page.loadFees()
  for (const value of ['新增一笔运费', '-1', '1.5', '9007199254740992', '8']) {
    page.chooseFee(value)
    assert.equal(page.form.feeId, null, value)
  }
  assert.equal(calls.length, 0)
  page.chooseFee('2736')
  await page.run(false)
  assert.deepEqual(calls[0], { path: '/cst/allocations', body: { feeId: 2736, basis: 'QTY' } })
})

test('fee-query failure is visible and retry restores candidates instead of disguising it as an empty list', async () => {
  let fail = true
  const { page } = setup({ selection: true, read: async path => {
    if (path === '/lgs/fees' && fail) throw new Error('物流费用查询超时')
    return path === '/lgs/fees' ? [fee(7)] : []
  } })
  await page.load(); await page.loadFees()
  assert.match(page.feesError.value, /查询超时/)
  fail = false; await page.loadFees()
  assert.equal(page.feesError.value, '')
  assert.deepEqual(page.feeOptions.value.map(item => item.id), [7])
})

test('a cost-only user keeps manual-ID access without attempting a forbidden logistics query', async () => {
  const reads = []
  const { page, calls } = setup({ selection: true, permissions: ['cst:allocation:create', 'cst:allocation:confirm'], read: async path => { reads.push(path); return [] } })
  await page.load(); await page.loadFees()
  assert.deepEqual(reads, ['/cst/allocations'])
  assert.match(page.feesError.value, /权限/)
  page.chooseFee('7'); await page.run(false)
  assert.equal(calls[0].body.feeId, 7)
})

test('history failure disables candidate eligibility and reports the failed query', async () => {
  const { page } = setup({ selection: true, read: async path => {
    if (path === '/cst/allocations') throw new Error('分摊记录读取失败')
    return [fee(7)]
  } })
  await page.load(); await page.loadFees()
  assert.match(page.historyError.value, /读取失败/)
  assert.deepEqual(page.feeOptions.value, [])
})

test('a delayed preview never replaces the current fee after its inputs change', async () => {
  let release
  const { page, calls } = setup({ post: () => new Promise(resolve => { release = resolve }) })
  page.form.feeId = 7
  const pending = page.run(false)
  page.form.feeId = 8
  release({ id: 81, status: 'DRAFT', feeId: 7, lines: [] })
  await pending
  assert.equal(page.preview.value, null)
  assert.equal(calls.length, 1)
})

test('matching preview enables confirmation and confirmation refreshes history and clears selection', async () => {
  const { page, calls } = setup({ selection: true })
  page.chooseFee(7); await page.run(false)
  assert.equal(page.canConfirm.value, true)
  await page.run(true)
  assert.deepEqual(calls.map(call => call.path), ['/cst/allocations', '/cst/allocations/81/confirm'])
  assert.equal(page.form.feeId, null)
  assert.equal(page.preview.value, null)
  assert.equal(page.canConfirm.value, false)
})

test('a preview from another country cannot trigger a confirmation command', async () => {
  const { page, calls, scope } = setup({ selection: true })
  page.chooseFee(7); await page.run(false)
  scope.value = 'country-2'
  await page.run(true)
  assert.equal(calls.length, 1)
})

test('a source-version rejection clears the obsolete preview so the next preview actually reloads', async () => {
  const { page, calls } = setup({ selection: true, post: async path => {
    if (path.endsWith('/confirm')) throw Object.assign(new Error('来源费用已变化，请重新预览'), { code: 'CST_FEE_CHANGED' })
    return { id: 81, status: 'DRAFT', feeId: 7, lines: [] }
  } })
  page.chooseFee(7); await page.run(false); await page.run(true)
  assert.equal(page.preview.value, null)
  assert.match(page.commandError.value, /费用已变化/)
  await page.run(false)
  assert.deepEqual(calls.map(call => call.path), ['/cst/allocations', '/cst/allocations/81/confirm', '/cst/allocations'])
})

test('a network failure retains the matching preview for retrying the same confirmation', async () => {
  let fail = true
  const { page, calls } = setup({ selection: true, post: async path => {
    if (path.endsWith('/confirm') && fail) throw new Error('连接超时')
    return { id: 81, status: path.endsWith('/confirm') ? 'CONFIRMED' : 'DRAFT', feeId: 7, lines: [] }
  } })
  page.chooseFee(7); await page.run(false); await page.run(true)
  assert.equal(page.canConfirm.value, true)
  assert.match(page.commandError.value, /连接超时/)
  fail = false; await page.run(true)
  assert.deepEqual(calls.map(call => call.path), ['/cst/allocations', '/cst/allocations/81/confirm', '/cst/allocations/81/confirm'])
})
