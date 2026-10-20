import test from 'node:test'
import assert from 'node:assert/strict'
import { freshDb, context, callApi } from './support.mjs'
const { finHandlers, syncEvents, reconcile } = await import('../src/mock/handlers/fin.ts')
const { getDb } = await import('../src/mock/db.ts')
const api = (method, path, body = {}, userId = 1) => callApi(finHandlers, method, path, body, { userId, countryId: 1 })
function fixture() {
  const db = freshDb()
  db.dataScopes.forEach(s => { s.effectiveFrom = '2026-01-01T00:00:00Z' })
  return { db, book: db.books.find(b => b.countryId === 1), sept: db.finPeriods.find(p => p.countryId === 1 && p.periodNo === 9), oct: db.finPeriods.find(p => p.countryId === 1 && p.periodNo === 10), account: code => db.finAccounts.find(a => a.bookId === 61 && a.code === code) }
}
async function postManual(date, amount, aux = { customerId: 601 }, currency = 'MXN', rate = 1) {
  const db = getDb(), acc = code => db.finAccounts.find(a => a.bookId === 61 && a.code === code)
  const created = await api('POST', '/fin/vouchers', { voucherDate: date, lines: [
    { accountId: acc('1122').id, aux, currency, origAmount: amount / rate, rate, debit: amount, credit: 0 },
    { accountId: acc('5001').id, currency, origAmount: amount / rate, rate, debit: 0, credit: amount },
  ] })
  assert.equal(created.status, 200, JSON.stringify(created))
  const id = created.data.id
  for (const action of ['submit', 'audit', 'post']) {
    const res = await api('POST', `/fin/vouchers/${id}/${action}`, {}, action === 'submit' ? 1 : 3)
    assert.equal(res.status, 200, JSON.stringify(res))
  }
  return id
}

test('checking a closed period preserves the lock and repeated close preserves one snapshot set', async () => {
  const { oct } = fixture()
  assert.equal((await api('POST', `/fin/periods/${oct.id}/close`)).status, 200)
  const initial = getDb().finSnapshots.length
  const checked = await api('POST', `/fin/periods/${oct.id}/close-check`)
  assert.equal(getDb().finPeriods.find(p => p.id === oct.id).status, 'CLOSED')
  assert.equal(checked.data.canClose, false)
  const again = await api('POST', `/fin/periods/${oct.id}/close`)
  assert.equal(again.status, 200)
  assert.equal(getDb().finSnapshots.length, initial)
  assert.ok(getDb().finSnapshots.some(s => s.periodId === oct.id && s.snapshotType === 'BALANCE'))
})

test('close check blocks unconfirmed allocations and approved unposted stocktakes', async () => {
  const { db, oct } = fixture()
  db.feeAllocations.push({ id: 901, countryId: 1, status: 'DRAFT', bizDate: '2026-10-10', createdAt: '2026-10-10T00:00:00Z' })
  db.stocktakes.push({ id: 902, countryId: 1, status: 'APPROVED', bizDate: '2026-10-10', lines: [] })
  const res = await api('POST', `/fin/periods/${oct.id}/close-check`)
  assert.equal(res.data.canClose, false)
  assert.ok(res.data.checks.some(c => c.checkCode === 'ALLOCATION_PENDING' && c.result === 'FAIL'))
  assert.ok(res.data.checks.some(c => c.checkCode === 'STOCKTAKE_PENDING' && c.result === 'FAIL'))
})

test('voucher workflow refuses an already closed business period', async () => {
  const { db, oct, account } = fixture()
  const res = await api('POST', '/fin/vouchers', { voucherDate: '2026-10-10', lines: [{ accountId: account('5001').id, debit: 10 }, { accountId: account('6601').id, credit: 10 }] })
  assert.equal(res.status, 200)
  oct.status = 'CLOSED'
  const submit = await api('POST', `/fin/vouchers/${res.data.id}/submit`)
  assert.equal(submit.code, 'FIN_PERIOD_CLOSED')
  assert.equal(db.finVouchers[0].status, 'DRAFT')
})

test('reversal uses a selected open period and prevents duplicate pending reversals', async () => {
  const { sept } = fixture()
  const id = await postManual('2026-09-10', 100)
  sept.status = 'CLOSED'
  const rev = await api('POST', `/fin/vouchers/${id}/reverse`, { voucherDate: '2026-10-10', reason: '更正本期' })
  assert.equal(rev.status, 200)
  assert.equal(rev.data.voucherDate, '2026-10-10')
  assert.notEqual(rev.data.periodId, sept.id)
  const repeated = await api('POST', `/fin/vouchers/${id}/reverse`, { voucherDate: '2026-10-10' })
  assert.equal(repeated.status, 200)
  assert.equal(repeated.data.id, rev.data.id)
})

test('balances carry forward per customer and aggregate correctly in the trial balance', async () => {
  const { db, oct, account } = fixture()
  await postManual('2026-09-10', 100, { customerId: 601 })
  await postManual('2026-10-10', 50, { customerId: 601 })
  await postManual('2026-10-11', 30, { customerId: 602 })
  const trial = await api('GET', '/fin/trial-balance?periodId=' + oct.id)
  const ar = trial.data.rows.find(r => r.accountId === account('1122').id)
  assert.equal(ar.openingDebit, 100)
  assert.equal(ar.closingDebit, 180)
  const balances = db.finBalances.filter(b => b.periodId === oct.id && b.accountId === account('1122').id)
  assert.deepEqual(balances.map(b => b.auxKey).sort(), ['C:601', 'C:602'])
  assert.equal(balances.find(b => b.auxKey === 'C:601').closingDebit, 150)
})

test('manual vouchers require configured auxiliary dimensions and valid foreign currency conversion', async () => {
  const { account } = fixture()
  const noAux = await api('POST', '/fin/vouchers', { voucherDate: '2026-10-10', lines: [{ accountId: account('1122').id, debit: 100 }, { accountId: account('5001').id, credit: 100 }] })
  assert.equal(noAux.code, 'FIN_AUX_MISSING')
  getDb().finAccounts.find(a => a.bookId === 61 && a.code === '1122').fxEnabled = true
  const wrong = await api('POST', '/fin/vouchers', { voucherDate: '2026-10-10', lines: [
    { accountId: account('1122').id, aux: { customerId: 601 }, currency: 'CNY', origAmount: 100, rate: 2.5, debit: 100 },
    { accountId: account('5001').id, credit: 100 },
  ] })
  assert.equal(wrong.code, 'FIN_FX_INVALID')
})

test('events include confirmed business sources and cannot silently omit negative amounts', async () => {
  const { db } = fixture()
  db.inboundCosts.push({ id: 911, countryId: 1, bizDate: '2026-10-10', status: 'CONFIRMED', basePurchaseAmount: 100, allocFeeAmount: 10, batchNo: 'B-911' })
  db.costAdjustments.push({ id: 912, countryId: 1, bizDate: '2026-10-10', status: 'CONFIRMED', amount: -20, target: 'COGS', docNo: 'CA-912' })
  db.apPayments.push({ id: 913, countryId: 1, payDate: '2026-10-10', status: 'SETTLED', payCurrency: 'MXN', payAmount: 40, docNo: 'PAY-913' })
  db.rtnRefunds.push({ id: 914, countryId: 1, paidAt: '2026-10-10T12:00:00Z', status: 'PAID', currency: 'MXN', amount: 10, docNo: 'RF-914' })
  syncEvents(1)
  for (const type of ['CST_INBOUND_COST_CONFIRMED', 'CST_COST_ADJUSTED', 'AP_PAYMENT_CONFIRMED', 'RTN_REFUND_PAID']) assert.ok(db.finEvents.some(e => e.eventType === type), type)
  assert.equal(db.finEvents.find(e => e.eventType === 'CST_COST_ADJUSTED').payload.amount, -20)
  syncEvents(1)
  assert.equal(db.finEvents.length, 4)
})

test('failed automatic generation persists diagnostics while rolling back accounting writes', async () => {
  const { db } = fixture()
  db.finEvents.push({ id: 920, countryId: 1, bookId: 61, eventType: 'MISSING_MAPPING', bizDate: '2026-10-10', status: 'PENDING', failReason: '', payload: { amount: 10 } })
  const res = await api('POST', '/fin/events/920/generate')
  assert.equal(res.code, 'FIN_MAPPING_MISSING')
  const failed = getDb().finEvents.find(e => e.id === 920)
  assert.equal(failed.status, 'FAILED')
  assert.ok(failed.failReason.includes('映射'))
  assert.equal(getDb().finVouchers.length, 0)
})

test('missing source costs block automatic vouchers rather than posting revenue without costs', async () => {
  const { db } = fixture()
  db.finEvents.push({ id: 921, countryId: 1, bookId: 61, eventType: 'SAL_OUTBOUND_CONFIRMED', bizDate: '2026-10-10', status: 'PENDING', payload: { amountExclTax: 100, cogsAmount: 0, costMissing: true, customerId: 601 } })
  const res = await api('POST', '/fin/events/921/generate')
  assert.equal(res.code, 'CST_COST_MISSING')
  assert.equal(getDb().finVouchers.length, 0)
})

test('balance sheet reads equity accounts and reports an actual imbalance', async () => {
  const { db, oct, account } = fixture()
  db.finOpenings.push({ id: 930, bookId: 61, accountId: account('1001').id, aux: { fundAccountId: 901 }, currency: 'MXN', baseAmount: 100, origAmount: 100, direction: 'DEBIT', status: 'CONFIRMED' })
  const res = await api('GET', '/fin/reports/BALANCE_SHEET?periodId=' + oct.id)
  assert.equal(res.data.balanced, false)
  const equity = res.data.lines.find(l => l.code === 'EQUITY')
  assert.equal(equity.amount, 0)
  assert.equal(res.data.difference, 100)
})

test('reconciliation uses selected period and includes prepayments, credit notes, refunds and details', async () => {
  const { db, sept } = fixture()
  db.arReceipts.push({ id: 941, countryId: 1, status: 'CONFIRMED', currency: 'MXN', amount: 100, writtenOffAmount: 0, arrivalDate: '2026-10-10', docNo: 'REC-941' })
  const res = await api('GET', '/fin/reconcile?type=CASH&periodId=' + sept.id)
  assert.equal(res.data.businessAmount, 0)
  assert.ok(Array.isArray(res.data.details))
  assert.equal(res.data.periodId, sept.id)
})

test('reopen records snapshot and later-period dependencies and invalidates prior waivers', async () => {
  const { db, sept, oct } = fixture()
  sept.status = 'CLOSED'
  db.finSnapshots.push({ id: 950, periodId: sept.id, snapshotType: 'BALANCE', content: [], createdAt: '2026-09-30T00:00:00Z' })
  db.finCloseChecks.push({ id: 951, periodId: sept.id, checkCode: 'AR_DIFF', result: 'WAIVED', waiveReason: '历史确认' })
  await postManual('2026-10-10', 50)
  const res = await api('POST', `/fin/periods/${sept.id}/reopen`, { reason: '修正来源' })
  assert.equal(res.status, 200)
  const log = db.finReopenLogs.at(-1)
  assert.equal(log.beforeSnapshotId, 950)
  assert.ok(log.dependencies.some(d => d.periodId === oct.id))
  assert.equal(db.finCloseChecks.some(c => c.periodId === sept.id && c.result === 'WAIVED'), false)
})

test('finance lists honor book scope even when function permissions allow finance access', async () => {
  const { db } = fixture()
  db.books.push({ id: 63, countryId: 1, entityId: 201, status: 'ACTIVE', baseCurrency: 'MXN' })
  db.finVouchers.push({ id: 961, countryId: 1, bookId: 61, status: 'DRAFT', lines: [] }, { id: 962, countryId: 1, bookId: 63, status: 'DRAFT', lines: [] })
  db.finEvents.push({ id: 963, countryId: 1, bookId: 63, status: 'PENDING', sourceNo: 'PRIVATE' })
  db.dataScopes = db.dataScopes.filter(s => s.userId !== 3)
  db.dataScopes.push({ id: 964, userId: 3, countryId: 1, scopeType: 'BOOK', scopeRefId: 61, effectiveFrom: '2026-01-01' })
  const vouchers = await api('GET', '/fin/vouchers', {}, 3)
  const events = await api('GET', '/fin/events', {}, 3)
  assert.deepEqual(vouchers.data.records.map(v => v.id), [961])
  assert.equal(events.data.records.some(e => e.id === 963), false)
})

test('draft vouchers can be corrected with full validation while audited ones remain locked', async () => {
  const { account } = fixture()
  const lines = amount => [{ accountId: account('1122').id, aux: { customerId: 601 }, debit: amount }, { accountId: account('5001').id, credit: amount }]
  const created = await api('POST', '/fin/vouchers', { voucherDate: '2026-10-10', lines: lines(10) })
  const edited = await api('PUT', `/fin/vouchers/${created.data.id}`, { lines: lines(20) })
  assert.equal(edited.status, 200)
  assert.equal(edited.data.totalDebit, 20)
  await api('POST', `/fin/vouchers/${created.data.id}/submit`)
  await api('POST', `/fin/vouchers/${created.data.id}/audit`, {}, 3)
  assert.notEqual((await api('PUT', `/fin/vouchers/${created.data.id}`, { lines: lines(30) })).status, 200)
})

test('closing checks the cash reconciliation and rejects waivers after closing', async () => {
  const { db, oct } = fixture()
  db.arReceipts.push({ id: 971, countryId: 1, currency: 'MXN', status: 'CONFIRMED', amount: 100, arrivalDate: '2026-10-10', docNo: 'RC-971' })
  const check = await api('POST', `/fin/periods/${oct.id}/close-check`)
  assert.ok(check.data.checks.some(c => c.checkCode === 'CASH_DIFF' && c.result === 'FAIL'))
  getDb().finPeriods.find(p => p.id === oct.id).status = 'CLOSED'
  const waiver = await api('POST', `/fin/periods/${oct.id}/waive`, { checkCode: 'CASH_DIFF', reason: '不影响本期' })
  assert.equal(waiver.code, 'FIN_PERIOD_CLOSED')
})

test('procurement and capitalized fee events do not recognize the same cost twice', async () => {
  const { db } = fixture()
  db.inboundCosts.push({ id: 981, countryId: 1, productId: db.products[0].id, status: 'ADJUSTED', bizDate: '2026-10-10', confirmedBasePurchaseAmount: 100, confirmedAllocFeeAmount: 30, basePurchaseAmount: 100, allocFeeAmount: 40 })
  db.costAdjustments.push({ id: 982, countryId: 1, status: 'CONFIRMED', bizDate: '2026-10-11', amount: 10, target: 'COGS', sourceType: 'FEE_ALLOCATION', sourceId: 983 })
  syncEvents(1)
  assert.equal(db.finEvents.find(e => e.eventType === 'CST_INBOUND_COST_CONFIRMED').payload.amount, 100)
  assert.equal(db.finEvents.find(e => e.eventType === 'CST_COST_ADJUSTED').payload.counterpart, 'INVENTORY')
})

test('cash journal filters the chosen period and retains fund auxiliary references', async () => {
  const { db, oct, account } = fixture()
  for (const [date, amount] of [['2026-09-10', 100], ['2026-10-10', 50]]) {
    const made = await api('POST', '/fin/vouchers', { voucherDate: date, lines: [{ accountId: account('1001').id, aux: { fundAccountId: 901 }, debit: amount }, { accountId: account('5001').id, credit: amount }] })
    for (const action of ['submit', 'audit', 'post']) await api('POST', `/fin/vouchers/${made.data.id}/${action}`, {}, action === 'submit' ? 1 : 3)
  }
  const res = await api('GET', '/fin/ledgers/journal?periodId=' + oct.id)
  assert.deepEqual(res.data.lines.map(l => l.debit), [50])
  assert.equal(res.data.lines[0].aux.fundAccountId, 901)
})

test('report viewers can load permitted book periods without configuration rights', async () => {
  const { db } = fixture()
  db.roles.find(r => r.id === 14).permissions = ['fin:report:view']
  const res = await api('GET', '/fin/books', {}, 3)
  assert.equal(res.status, 200)
  assert.ok(res.data[0].periods.length)
})

test('actual logistics fee events recognize only the converted estimate difference', async () => {
  const { db } = fixture()
  const item = db.expenseItems.find(i => i.costTreatment === 'CAPITALIZE')
  db.lgsFees.push({ id: 991, countryId: 1, expenseItemId: item.id, currency: 'MXN', amount: 1200, baseAmount: 1200, estimateFeeId: 990, deltaBaseAmount: 200, status: 'CONFIRMED', bizDate: '2026-10-10' })
  db.feeAllocations.push({ id: 992, countryId: 1, feeId: 991, status: 'CONFIRMED', lines: [] })
  syncEvents(1)
  assert.equal(db.finEvents.find(e => e.sourceId === 991).payload.amount, 200)
  db.lgsFees.push({ id: 993, countryId: 1, expenseItemId: item.id, currency: 'MXN', amount: 1300, baseAmount: null, costStatus: 'PENDING_RATE', estimateFeeId: 990, status: 'CONFIRMED', bizDate: '2026-10-10' })
  syncEvents(1)
  assert.equal(db.finEvents.find(e => e.sourceId === 993).payload.rateMissing, true)
})

test('return and opening cost snapshots do not become duplicate purchase inbound events', () => {
  const { db } = fixture()
  db.invBatches.push({ id: 995, countryId: 1, sourceType: 'OPENING' })
  db.inboundCosts.push(
    { id: 996, countryId: 1, batchId: 995, status: 'CONFIRMED', basePurchaseAmount: 100, bizDate: '2026-10-10' },
    { id: 997, countryId: 1, sourceType: 'RETURN', status: 'CONFIRMED', basePurchaseAmount: 50, bizDate: '2026-10-10' },
  )
  syncEvents(1)
  assert.equal(db.finEvents.some(e => e.eventType === 'CST_INBOUND_COST_CONFIRMED'), false)
})

test('settlement events use stored base amounts and include the original reversed event', () => {
  const { db } = fixture()
  db.apSettlements.push(
    { id: 1001, countryId: 1, status: 'REVERSED', bizDate: '2026-10-10', lines: [{ billCurrency: 'CNY', billAmount: 100, billBaseAmount: 250, payBaseAmount: 260, fxDiff: 10 }, { billCurrency: 'MXN', billAmount: 50, billBaseAmount: 50, payBaseAmount: 50, fxDiff: 0 }] },
    { id: 1002, countryId: 1, status: 'EFFECTIVE', reversalOfId: 1001, bizDate: '2026-10-11', lines: [{ billCurrency: 'CNY', billAmount: -100, billBaseAmount: -250, payBaseAmount: -260, fxDiff: -10 }, { billCurrency: 'MXN', billAmount: -50, billBaseAmount: -50, payBaseAmount: -50, fxDiff: 0 }] },
  )
  syncEvents(1)
  const events = db.finEvents.filter(e => e.eventType === 'AP_SETTLEMENT_DONE')
  assert.equal(events.length, 2)
  assert.deepEqual(events.map(e => e.payload.amount), [300, -300])
  assert.deepEqual(events.map(e => e.payload.payBaseAmount), [310, -310])
})

test('stocktake events use actual inventory source keys and flag missing valuation', () => {
  const { db } = fixture()
  db.stocktakes.push({ id: 1011, countryId: 1, status: 'POSTED', postedAt: '2026-10-10T00:00:00Z', warehouseId: 401 })
  db.invTxns.push({ id: 1012, countryId: 1, sourceType: 'INV_STOCKTAKE', sourceId: 1011, productId: db.products[0].id, onHandChange: -2, unitCost: 15 })
  syncEvents(1)
  assert.equal(db.finEvents.find(e => e.sourceId === 1011).payload.amount, -30)
  db.invTxns[0].unitCost = null
  syncEvents(1)
  assert.equal(db.finEvents.find(e => e.sourceId === 1011).payload.costMissing, true)
})

test('cash reconciliation retains confirmed payment conversion when rate tables change', async () => {
  const { db, oct } = fixture()
  db.apPayments.push({ id: 1021, countryId: 1, status: 'CONFIRMED', payDate: '2026-10-10', payCurrency: 'CNY', payAmount: 100, rate: 2.5, baseAmount: 250 })
  db.exchangeRates.push({ id: 1022, countryId: 1, fromCcy: 'CNY', toCcy: 'MXN', status: 'CONFIRMED', rateDate: '2026-10-10', rate: 4, versionNo: 10, scope: 'ALL' })
  const res = await api('GET', '/fin/reconcile?type=CASH&periodId=' + oct.id)
  assert.equal(res.data.businessAmount, -250)
})

test('partially valued sales returns cannot generate a complete inventory cost voucher', () => {
  const { db } = fixture()
  db.rtnSales.push({ id: 1031, countryId: 1, status: 'PENDING_SETTLE', bizDate: '2026-10-10', lines: [{ costAmount: 10 }, { costAmount: null, costMissing: true }] })
  syncEvents(1)
  assert.equal(db.finEvents.find(e => e.eventType === 'RTN_SALES_RECEIVED').payload.costMissing, true)
})

test('closed inventory reconciliation retains its closing snapshot after later cost corrections', async () => {
  const { db, sept } = fixture()
  const productId = db.products[0].id
  db.invBatches.push({ id: 1041, countryId: 1, productId, sourceType: 'OPENING', batchNo: 'OPEN-1041' })
  db.inboundCosts.push({ id: 1042, countryId: 1, productId, batchId: 1041, qty: 10, unitCost: 0, basePurchaseAmount: 0, status: 'CONFIRMED', bizDate: '2026-09-10' })
  db.invTxns.push({ id: 1043, countryId: 1, batchId: 1041, productId, onHandChange: 10, unitCost: 0, bizDate: '2026-09-10' })
  assert.equal((await api('POST', `/fin/periods/${sept.id}/close`)).status, 200)
  db.inboundCosts[0].unitCost = 10
  db.costAdjustments.push({ id: 1044, countryId: 1, batchId: 1041, productId, target: 'INVENTORY', status: 'CONFIRMED', amount: 100, bizDate: '2026-10-10' })
  const res = await api('GET', '/fin/reconcile?type=INVENTORY&periodId=' + sept.id)
  assert.equal(res.data.businessAmount, 0)
  assert.equal(res.data.snapshot, true)
})

test('later open-period cost changes do not revalue an earlier open inventory period', async () => {
  const { db, sept, oct } = fixture()
  const productId = db.products[0].id
  db.invBatches.push({ id: 1051, countryId: 1, productId, sourceType: 'OPENING', batchNo: 'OPEN-1051' })
  db.inboundCosts.push({ id: 1052, countryId: 1, productId, batchId: 1051, qty: 10, initialUnitCost: 10, unitCost: 20, basePurchaseAmount: 100, status: 'ADJUSTED', bizDate: '2026-09-10', valuationHistory: [{ bizDate: '2026-10-10', unitDelta: 10, sourceId: 1054, sourceType: 'MANUAL' }] })
  db.invTxns.push({ id: 1053, countryId: 1, batchId: 1051, productId, onHandChange: 10, unitCost: 10, bizDate: '2026-09-10' })
  const earlier = await api('GET', '/fin/reconcile?type=INVENTORY&periodId=' + sept.id)
  assert.equal(earlier.data.businessAmount, 100)
  const current = await api('GET', '/fin/reconcile?type=INVENTORY&periodId=' + oct.id)
  assert.equal(current.data.businessAmount, 200)
})

test('confirmed actual fees recover after missing rates are supplied and subsequent retries are inert', async () => {
  const { db } = fixture()
  const { lgsHandlers } = await import('../src/mock/handlers/lgs.ts')
  const { cstOpsHandlers } = await import('../src/mock/handlers/cstOps.ts')
  const productId = db.products[0].id
  db.invBatches.push({ id: 1061, countryId: 1, productId, shipmentId: 1060, batchNo: 'B-1061' })
  db.invBatchBalances.push({ id: 1062, countryId: 1, warehouseId: 401, productId, batchId: 1061, onHandQty: 10, frozenQty: 0 })
  db.inboundCosts.push({ id: 1063, countryId: 1, warehouseId: 401, productId, batchId: 1061, qty: 10, initialUnitCost: 10, unitCost: 20, allocFeeAmount: 100, basePurchaseAmount: 100, status: 'ADJUSTED', bizDate: '2026-09-10', valuationHistory: [{ bizDate: '2026-09-10', unitDelta: 10, sourceId: 1066, sourceType: 'FEE_ALLOCATION' }] })
  const item = db.expenseItems.find(i => i.costTreatment === 'CAPITALIZE')
  db.lgsFees.push(
    { id: 1064, countryId: 1, shipmentId: 1060, expenseItemId: item.id, docNo: 'EST-1064', status: 'CONFIRMED', estimateFlag: 'ESTIMATE', amount: 100, currency: 'MXN', baseAmount: 100, costStatus: 'READY', bizDate: '2026-09-10', version: 1 },
    { id: 1065, countryId: 1, shipmentId: 1060, expenseItemId: item.id, docNo: 'ACT-1065', status: 'DRAFT', estimateFlag: 'ACTUAL', estimateFeeId: 1064, amount: 50, currency: 'CNY', bizDate: '2026-09-20', version: 1 },
  )
  db.feeAllocations.push({ id: 1066, countryId: 1, bookId: 61, feeId: 1064, status: 'CONFIRMED', baseAmount: 100, bizDate: '2026-09-10', basis: 'QTY', lines: [{ batchId: 1061, productId, amount: 100 }] })
  const confirm = () => callApi(lgsHandlers, 'POST', '/lgs/fees/1065/confirm', {})
  assert.equal((await confirm()).status, 200)
  assert.equal(db.lgsFees.find(f => f.id === 1065).costStatus, 'PENDING_RATE')
  db.exchangeRates.push({ id: 1067, countryId: 1, fromCcy: 'CNY', toCcy: 'MXN', rate: 3, rateDate: '2026-09-01', scope: 'PURCHASE_COST', status: 'CONFIRMED', versionNo: 1 })
  const blocked = await callApi(cstOpsHandlers, 'POST', '/cst/allocations', { feeId: 1065, bizDate: '2026-09-20', basis: 'QTY' })
  assert.equal(blocked.code, 'CST_FEE_PENDING_COST')
  assert.equal(getDb().inboundCosts.find(c => c.id === 1063).unitCost, 20)
  const recovered = await confirm()
  assert.equal(recovered.status, 200)
  const actual = getDb().lgsFees.find(f => f.id === 1065)
  assert.equal(actual.costStatus, 'READY')
  assert.equal(actual.baseAmount, 150)
  assert.equal(actual.deltaBaseAmount, 50)
  assert.equal(getDb().inboundCosts.find(c => c.id === 1063).unitCost, 25)
  assert.equal(getDb().feeAllocations.filter(a => a.feeId === 1065 && a.status === 'CONFIRMED').length, 1)
  const before = JSON.stringify({ actual, costs: getDb().inboundCosts, allocations: getDb().feeAllocations, adjustments: getDb().costAdjustments })
  assert.equal((await confirm()).status, 200)
  assert.equal(JSON.stringify({ actual: getDb().lgsFees.find(f => f.id === 1065), costs: getDb().inboundCosts, allocations: getDb().feeAllocations, adjustments: getDb().costAdjustments }), before)
})
