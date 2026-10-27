import test from 'node:test'
import assert from 'node:assert/strict'
import { freshDb, context, callApi } from './support.mjs'

const sal = await import('../src/mock/handlers/sal.ts')
const ar = await import('../src/mock/handlers/ar.ts')
const ap = await import('../src/mock/handlers/ap.ts')
const rtn = await import('../src/mock/handlers/rtn.ts')

test('演示出库数量检查和收款定位遵守实际页面的新接口契约', async () => {
  const db = freshDb()
  const product = db.products[0]
  const order = sal.createSalesOrder(context(), { customerId: 601, paymentType: 'CASH', lines: [{ productId: product.id, unit: product.baseUnit, qty: 10, warehouseId: 401, price: 10, manualPriceFlag: true }] })
  const checked = await callApi(sal.salHandlers, 'POST', `/sal/orders/${order.id}/outbound-check`, { warehouseId: 401, lines: [{ allocId: order.lines[0].allocs[0].id, qty: 4 }] })
  assert.equal(checked.status, 200)
  assert.equal(checked.data.checks.find(row => row.item === '现款到账').payment.requiredAmount, 40)
  const selected = await callApi(ar.arHandlers, 'GET', `/ar/receipts/order-context/${order.id}`)
  assert.equal(selected.status, 200)
  assert.equal(selected.data.id, order.id)
  assert.equal(selected.data.customerId, 601)
  assert.equal(selected.data.totalAmount, undefined)
})

function creditFixture(db) {
  db.arCreditRules = [{ id: 90001, countryId: 1, targetType: 'CUSTOMER', targetId: 601, paymentMode: 'CREDIT_ALLOWED', creditLimit: 1000, currency: 'MXN', termDays: 30, dueBasis: 'OUTBOUND_DATE', overduePolicy: 'WARN', allowException: false, effectiveFrom: '2020-01-01', status: 'ACTIVE' }]
  db.arReceivables = []
  db.arOccupations = [{ id: 90002, countryId: 1, customerId: 601, occType: 'ORDER_RESERVE', refType: 'SAL_ORDER', refId: 90003, amount: 1000, releasedAmount: 0, status: 'OPEN' }]
}

test('credit recheck converts the current order reservation without counting it twice', () => {
  const db = freshDb()
  creditFixture(db)
  assert.equal(ar.evaluateCredit(1, 601, 'CREDIT', 200, 'OUTBOUND', 90003).ok, true)
  assert.equal(ar.evaluateCredit(1, 601, 'CREDIT', 200, 'OUTBOUND', 99999).ok, false)
})

for (const exception of ['overLimit', 'overdue']) test(`credit ${exception} exception cannot auto-approve when no approval rule matches`, () => {
  const db = freshDb(); creditFixture(db)
  db.arOccupations = []
  db.arCreditRules[0].allowException = true
  if (exception === 'overLimit') db.arCreditRules[0].creditLimit = 10
  else {
    db.arCreditRules[0].overduePolicy = 'REQUIRE_APPROVAL'
    db.arReceivables = [{ id: 90030, countryId: 1, customerId: 601, dueDate: '2000-01-01', dueStatus: 'OVERDUE', openAmount: 100 }]
  }
  db.approvalRules = []
  db.docTypeConfigs.find((d) => d.countryId === 1 && d.docType === 'SALES_ORDER').approvalRequired = false
  const product = db.products[0]
  db.invSummaries = [{ id: 90031, countryId: 1, warehouseId: 401, productId: product.id, onHandQty: 100, reservedQty: 0, frozenQty: 0, version: 1 }]
  const order = sal.createSalesOrder(context(), { customerId: 601, paymentType: 'CREDIT', lines: [{ productId: product.id, unit: product.baseUnit, qty: 1, warehouseId: 401, price: 100, manualPriceFlag: true }] })
  const result = sal.submitSalesOrder(context(), order)
  assert.equal(result.approvalStatus, 'PENDING')
  assert.equal(db.approvalInstances.find((i) => i.id === order.approvalInstanceId).status, 'BLOCKED')
})

test('editing an approved partly shipped order preserves line IDs and fulfillment counters', async () => {
  const db = freshDb()
  const ctx = context()
  const product = db.products.find((p) => db.countrySkus.some((s) => s.countryId === 1 && s.productId === p.id && s.status === 'ENABLED'))
  const order = sal.createSalesOrder(ctx, { customerId: 601, paymentType: 'CASH', lines: [{ productId: product.id, qty: 10, unit: product.baseUnit, warehouseId: 401, price: 10, manualPriceFlag: true }] })
  const line = order.lines[0]
  const alloc = line.allocs[0]
  order.approvalStatus = 'APPROVED'
  line.outboundQty = 4; line.signedQty = 3; line.returnedQty = 1
  alloc.outboundQty = 4
  db.invSummaries.push({ id: 90020, countryId: 1, warehouseId: 401, productId: product.id, onHandQty: 100, reservedQty: 6, frozenQty: 0, version: 1 })
  const result = await callApi(sal.salHandlers, 'PUT', `/sal/orders/${order.id}`, { customerId: 601, lines: [{ id: line.id, productId: product.id, unit: product.baseUnit, qty: 12, price: 10, manualPriceFlag: true, allocs: [{ id: alloc.id, warehouseId: 401, allocQty: 12 }] }] })
  assert.equal(result.status, 200, JSON.stringify(result.body))
  const saved = result.data.lines[0]
  assert.equal(saved.id, line.id)
  assert.equal(saved.allocs[0].id, alloc.id)
  assert.deepEqual([saved.outboundQty, saved.signedQty, saved.returnedQty, saved.allocs[0].outboundQty], [4, 3, 1, 4])
  const changedCustomer = await callApi(sal.salHandlers, 'PUT', `/sal/orders/${order.id}`, { customerId: 602, lines: [{ id: saved.id, productId: product.id, unit: product.baseUnit, qty: 12, price: 10, manualPriceFlag: true, allocs: saved.allocs }] })
  assert.equal(changedCustomer.status, 409, '已出库历史不得转移到另一客户')
})

function purchaseFixture(db) {
  db.purOrders = [{ id: 91000, countryId: 1, supplierId: 701, currency: 'CNY', status: 'APPROVED', docNo: 'PO-TEST', lines: [{ id: 91001, productId: db.products[0].id, qty: 100, baseQty: 100, unitPrice: 10, amount: 1000, shippedQty: 80, arrivedMxQty: 15, returnedQty: 0 }] }]
  db.domesticReceipts = [{ id: 91002, countryId: 1, orderId: 91000, status: 'CONFIRMED', lines: [{ id: 91003, orderLineId: 91001, qualifiedQty: 100, convertedQualifiedQty: 0, exportedQty: 80, returnedQty: 0 }] }]
  db.rtnPurchase = []
  db.apBills = []
}

test('purchase return cannot exceed the unshipped domestic source quantity', async () => {
  const db = freshDb(); purchaseFixture(db)
  const result = await callApi(rtn.rtnHandlers, 'POST', '/rtn/purchase', { poId: 91000, stage: 'DOMESTIC', submit: false, lines: [{ poLineId: 91001, sourceLineId: 91003, qty: 21 }] })
  assert.equal(result.status, 400)
  assert.equal(db.rtnPurchase.length, 0)
})

test('completed domestic returns do not reduce the separate MX return quantity', async () => {
  const db = freshDb(); purchaseFixture(db)
  db.purOrders[0].lines[0].returnedQty = 10
  db.rtnPurchase = [{ id: 91010, countryId: 1, poId: 91000, stage: 'DOMESTIC', status: 'COMPLETED', lines: [{ poLineId: 91001, qty: 10 }] }]
  db.inboundCosts = [{ id: 91011, countryId: 1, poId: 91000, poLineId: 91001, productId: db.products[0].id, batchId: 91012, batchNo: 'BATCH-TEST' }]
  db.invBatchBalances = [{ countryId: 1, warehouseId: 401, productId: db.products[0].id, batchId: 91012, onHandQty: 15, frozenQty: 0 }]
  const result = await callApi(rtn.rtnHandlers, 'GET', '/rtn/purchase/returnable?poId=91000&stage=MX_STOCK')
  assert.equal(result.data[0].returnableQty, 15)
})

test('one sales return request cannot repeat the same outbound line to exceed delivered quantity', async () => {
  const db = freshDb()
  db.salOrders = [{ id: 97001, countryId: 1, customerId: 601, lines: [{ id: 97002, productId: db.products[0].id, qty: 5, baseQty: 5, lineAmount: 50 }] }]
  db.salOutbounds = [{ id: 97003, countryId: 1, orderId: 97001, status: 'OUTBOUNDED', lines: [{ id: 97004, orderLineId: 97002, productId: db.products[0].id, qty: 5, amount: 50, price: 10 }] }]
  db.rtnSales = []
  const result = await callApi(rtn.rtnHandlers, 'POST', '/rtn/sales', { outboundId: 97003, returnWarehouseId: 401, reasonCode: 'QUALITY', responsibility: 'CUSTOMER', lines: [{ outboundLineId: 97004, reqQty: 5 }, { outboundLineId: 97004, reqQty: 5 }] })
  assert.equal(result.status, 400)
})

test('executing domestic return updates the original receipt source while preserving received history', async () => {
  const db = freshDb(); purchaseFixture(db)
  db.rtnPurchase.push({ id: 91004, countryId: 1, supplierId: 701, poId: 91000, currency: 'CNY', stage: 'DOMESTIC', status: 'APPROVED', docNo: 'PR-TEST', lines: [{ id: 91005, poLineId: 91001, sourceLineId: 91003, productId: db.products[0].id, qty: 5, amount: 50 }] })
  const result = await callApi(rtn.rtnHandlers, 'POST', '/rtn/purchase/91004/ship', {})
  assert.equal(result.status, 200)
  assert.equal(db.domesticReceipts[0].lines[0].returnedQty, 5)
  assert.equal(db.domesticReceipts[0].lines[0].qualifiedQty, 100)
})

test('AP bill creation reloads purchase price and rejects a stale duplicate source', () => {
  const db = freshDb(); purchaseFixture(db)
  const source = { sourceType: 'PUR_ORDER_LINE', sourceId: 91001, partnerId: 701, currency: 'CNY', qty: 100, openQty: 100, unitPrice: 0.01, productId: db.products[0].id }
  const bill = ap.createBillFromSources(context(), { billDate: '2026-10-15', sources: [source] })
  assert.equal(bill.amount, 1000)
  assert.throws(() => ap.createBillFromSources(context(), { sources: [source] }), /数量|来源/)
})

test('cross currency AP settlement records real base currency exchange difference', () => {
  const db = freshDb()
  db.apBills = [{ id: 92001, countryId: 1, partnerId: 701, currency: 'CNY', amount: 100, paidAmount: 0, openAmount: 100, status: 'CONFIRMED', baseCurrency: 'MXN', baseAmount: 200, rate: 2, rateId: 1 }]
  db.apPayments = [{ id: 92002, countryId: 1, partnerId: 701, payCurrency: 'MXN', payAmount: 250, settledAmount: 0, status: 'CONFIRMED', baseCurrency: 'MXN', baseAmount: 250, rate: 1, payDate: '2026-10-15' }]
  db.apSettlements = []
  const settlement = ap.createApSettlement(context(), { partnerId: 701, bizDate: '2026-10-15', lines: [{ fromType: 'PAYMENT', fromId: 92002, fromCurrency: 'MXN', billId: 92001, billAmount: 100, settleRate: 0.4, rateSource: 'ACTUAL' }] })
  assert.equal(settlement.lines[0].fxDiff, 50)
  assert.equal(settlement.lines[0].billBaseAmount, 200)
  assert.equal(settlement.lines[0].payBaseAmount, 250)
})

test('AP settlement rejects a payment belonging to another supplier', () => {
  const db = freshDb()
  db.apBills = [{ id: 92001, countryId: 1, partnerId: 701, currency: 'MXN', amount: 100, paidAmount: 0, openAmount: 100, status: 'CONFIRMED' }]
  db.apPayments = [{ id: 92002, countryId: 1, partnerId: 702, payCurrency: 'MXN', payAmount: 100, settledAmount: 0, status: 'CONFIRMED' }]
  assert.throws(() => ap.createApSettlement(context(), { partnerId: 701, lines: [{ fromType: 'PAYMENT', fromId: 92002, fromCurrency: 'MXN', billId: 92001, billAmount: 100 }] }), /往来|供应商|来源/)
})

test('reversing AR writeoff restores credit and automatic order allocation; statement still balances', async () => {
  const db = freshDb()
  db.arReceivables = [{ id: 93001, countryId: 1, customerId: 601, orderId: 93002, currency: 'MXN', amount: 100, writtenOffAmount: 100, openAmount: 0, settleStatus: 'SETTLED', bizDate: '2026-10-01' }]
  db.arOccupations = [{ id: 93003, countryId: 1, customerId: 601, occType: 'AR_OPEN', refType: 'AR_RECEIVABLE', refId: 93001, amount: 100, releasedAmount: 100, status: 'RELEASED' }]
  db.arReceipts = [{ id: 93004, countryId: 1, customerId: 601, amount: 100, writtenOffAmount: 100, status: 'WRITTEN_OFF', orders: [{ orderId: 93002, plannedAmount: 100, usedAmount: 100 }] }]
  db.arWriteoffs = [{ id: 93005, countryId: 1, customerId: 601, currency: 'MXN', docNo: 'WO-TEST', bizDate: '2026-10-01', status: 'EFFECTIVE', lines: [{ fromType: 'RECEIPT', fromId: 93004, receivableId: 93001, orderId: 93002, allocatedAmount: 100, amount: 100 }] }]
  const result = await callApi(ar.arHandlers, 'POST', '/ar/writeoffs/93005/reverse', { reason: '错误分配', bizDate: '2026-10-15' })
  assert.equal(result.status, 200)
  assert.equal(db.arOccupations[0].releasedAmount, 0)
  assert.equal(db.arOccupations[0].status, 'OPEN')
  assert.equal(db.arReceipts[0].orders[0].usedAmount, 0)
  const statement = await callApi(ar.arHandlers, 'POST', '/ar/statements', { customerId: 601, periodStart: '2026-10-01', periodEnd: '2026-10-31' })
  assert.equal(statement.data.closing, 100)
  assert.equal(statement.data.identityOk, true)
})

test('manual AR writeoff cannot spend cash already allocated to a different order', async () => {
  const db = freshDb()
  db.arReceipts = [{ id: 93501, countryId: 1, customerId: 601, currency: 'MXN', amount: 100, writtenOffAmount: 0, status: 'CONFIRMED', orders: [{ orderId: 93502, plannedAmount: 100, usedAmount: 0 }] }]
  db.arReceivables = [{ id: 93503, countryId: 1, customerId: 601, orderId: 93504, currency: 'MXN', amount: 100, writtenOffAmount: 0, openAmount: 100, status: 'OPEN' }]
  const result = await callApi(ar.arHandlers, 'POST', '/ar/writeoffs', { customerId: 601, lines: [{ fromType: 'RECEIPT', fromId: 93501, receivableId: 93503, amount: 100 }] })
  assert.equal(result.status, 400)
})

test('refund payment requires actual date, reference and active proof', async () => {
  const db = freshDb()
  db.rtnRefunds = [{ id: 94001, countryId: 1, customerId: 601, amount: 20, currency: 'MXN', method: 'TRANSFER', fundAccountId: 902, payeeInfo: { name: '客户', account: 'TEST-ACCOUNT' }, status: 'APPROVED' }]
  db.arCreditNotes = [{ id: 94002, countryId: 1, customerId: 601, currency: 'MXN', amount: 20, usedAmount: 0, refundableFlag: true }]
  const result = await callApi(rtn.rtnHandlers, 'POST', '/rtn/refunds/94001/pay', { paidAt: '2026-10-15' })
  assert.equal(result.status, 400)
  assert.equal(db.arCreditNotes[0].usedAmount, 0)
})

test('a valid refund consumes refundable balance once and preserves recipient and payment evidence', async () => {
  const db = freshDb()
  db.rtnRefunds = [{ id: 94001, countryId: 1, customerId: 601, amount: 20, currency: 'MXN', method: 'TRANSFER', fundAccountId: 902, payeeInfo: { name: '客户', account: 'TEST-ACCOUNT' }, status: 'APPROVED' }]
  db.arCreditNotes = [{ id: 94002, countryId: 1, customerId: 601, currency: 'MXN', amount: 20, usedAmount: 0, refundableFlag: true }]
  db.attachments.push({ id: 94003, countryId: 1, bizType: 'REFUND', bizId: 94001, category: 'REFUND_PROOF', status: 'ACTIVE' })
  const body = { paidAt: '2026-10-15', referenceNo: 'REFUND-TEST-1' }
  const result = await callApi(rtn.rtnHandlers, 'POST', '/rtn/refunds/94001/pay', body)
  assert.equal(result.status, 200, JSON.stringify(result.body))
  const again = await callApi(rtn.rtnHandlers, 'POST', '/rtn/refunds/94001/pay', body)
  assert.equal(again.data.duplicate, true)
  assert.equal(db.arCreditNotes[0].usedAmount, 20)
  assert.equal(db.rtnRefunds[0].payeeInfo.account, 'TEST-ACCOUNT')
  assert.equal(db.rtnRefunds[0].paidAt, body.paidAt)
})

test('AP confirmation freezes historical rate and reversal keeps supplier statement consistent', async () => {
  const db = freshDb()
  db.exchangeRates = [{ id: 96000, countryId: 1, fromCcy: 'CNY', toCcy: 'MXN', rate: 2, rateDate: '2026-10-01', scope: 'SETTLEMENT', versionNo: 1, status: 'CONFIRMED' }]
  db.apBills = [{ id: 96001, countryId: 1, partnerId: 701, currency: 'CNY', amount: 100, paidAmount: 0, openAmount: 100, status: 'DRAFT', billDate: '2026-10-01' }]
  const bill = ap.confirmApBill(context(), 96001)
  assert.equal(bill.baseAmount, 200)
  db.exchangeRates[0].rate = 3
  assert.equal(bill.baseAmount, 200)
  db.apCreditNotes = [{ id: 96002, countryId: 1, partnerId: 701, currency: 'CNY', amount: 100, usedAmount: 0, createdAt: '2026-10-15', baseCurrency: 'MXN', baseAmount: 300, rate: 3 }]
  db.apSettlements = []
  const settled = ap.createApSettlement(context(), { partnerId: 701, bizDate: '2026-10-15', lines: [{ fromType: 'CREDIT_NOTE', fromId: 96002, fromCurrency: 'CNY', billId: 96001, billAmount: 100 }] })
  assert.equal(settled.lines[0].fxDiff, 100)
  await callApi(ap.apHandlers, 'POST', `/ap/settlements/${settled.id}/reverse`, { reason: '更正', bizDate: '2026-10-15' })
  const statement = await callApi(ap.apHandlers, 'POST', '/ap/statements', { partnerId: 701, currency: 'CNY', periodStart: '2026-10-01', periodEnd: '2026-10-31' })
  assert.equal(statement.data.closing, 100)
  assert.equal(statement.data.identityOk, true)
})

test('AP prepayment and credit-note settlements can be reversed without losing history', async () => {
  const db = freshDb()
  db.apBills = [{ id: 95001, countryId: 1, partnerId: 701, currency: 'MXN', amount: 100, paidAmount: 0, openAmount: 100, status: 'CONFIRMED', baseCurrency: 'MXN', baseAmount: 100, rate: 1 }]
  db.apPrepayments = [{ id: 95002, countryId: 1, partnerId: 701, currency: 'MXN', amount: 100, usedAmount: 0, status: 'CONFIRMED', baseCurrency: 'MXN', baseAmount: 100, rate: 1 }]
  db.apSettlements = []
  const settled = ap.createApSettlement(context(), { partnerId: 701, bizDate: '2026-10-15', lines: [{ fromType: 'PREPAYMENT', fromId: 95002, fromCurrency: 'MXN', billId: 95001, billAmount: 100 }] })
  const result = await callApi(ap.apHandlers, 'POST', `/ap/settlements/${settled.id}/reverse`, { reason: '撤销错误抵扣', bizDate: '2026-10-15' })
  assert.equal(result.status, 200)
  assert.equal(db.apBills[0].openAmount, 100)
  assert.equal(db.apPrepayments[0].usedAmount, 0)
  assert.equal(db.apSettlements.find((s) => s.id === settled.id).status, 'REVERSED')
})

test('warehouse-scoped sales detail returns only its own allocations and hides whole-order totals', async () => {
  const db = freshDb()
  db.salOrders = [{ id: 98001, countryId: 1, entityId: 201, storeId: 301, customerId: 602, docNo: 'SO-SCOPE', approvalStatus: 'DRAFT', totalAmount: 100, lines: [{ id: 98002, productId: db.products[0].id, qty: 10, baseQty: 10, price: 10, lineAmount: 100, cancelledQty: 0, outboundQty: 0, signedQty: 0, allocs: [{ id: 98003, warehouseId: 401, allocQty: 4, outboundQty: 0, cancelledQty: 0 }, { id: 98004, warehouseId: 402, allocQty: 6, outboundQty: 0, cancelledQty: 0 }] }] }]
  const result = await callApi(sal.salHandlers, 'GET', '/sal/orders/98001', undefined, { userId: 7 })
  assert.equal(result.status, 200, JSON.stringify(result.body))
  assert.deepEqual(result.data.lines[0].allocs.map((a) => a.warehouseId), [401])
  assert.equal(result.data.lines[0].baseQty, 4)
  assert.equal('totalAmount' in result.data, false)
})

test('store receipt lists exclude another store even in the same country', async () => {
  const db = freshDb()
  db.arReceipts = [{ id: 98011, countryId: 1, customerId: 602, storeId: 999, currency: 'MXN', amount: 100, writtenOffAmount: 0, orders: [], status: 'CONFIRMED' }]
  const result = await callApi(ar.arHandlers, 'GET', '/ar/receipts', undefined, { userId: 2 })
  assert.equal(result.status, 200)
  assert.equal(result.data.records.length, 0)
})

for (const action of ['create', 'confirm', 'duplicate']) test(`AP prepayment ${action} response keeps COST-hidden amounts private`, async () => {
  const db = freshDb()
  db.roles.find((r) => r.id === 11).fieldPolicies.COST = 'HIDDEN'
  db.apPrepayments = []
  let result
  if (action === 'create') {
    result = await callApi(ap.apHandlers, 'POST', '/ap/prepayments', { partnerId: 701, currency: 'MXN', amount: 100, fundAccountId: 902 })
  } else {
    db.apPrepayments.push({ id: 99001, countryId: 1, partnerId: 701, currency: 'MXN', amount: 100, usedAmount: 0, fundAccountId: 902, status: action === 'duplicate' ? 'CONFIRMED' : 'PENDING_CONFIRM', baseCurrency: 'MXN', baseAmount: 100, rate: 1 })
    result = await callApi(ap.apHandlers, 'POST', '/ap/prepayments/99001/confirm', {})
  }
  assert.equal(result.status, 200, JSON.stringify(result.body))
  for (const field of ['amount', 'baseAmount', 'usedAmount', 'rate']) assert.equal(field in result.data, false, `${action} leaked ${field}`)
  if (action === 'duplicate') assert.equal(result.data.duplicate, true)
  assert.equal(db.apPrepayments[0].amount, 100, 'serialization must preserve stored business data')
})

test('cached AP statements recheck every source against the current data scope', async () => {
  const db = freshDb()
  db.dataScopes = db.dataScopes.filter((s) => s.userId !== 6)
  db.dataScopes.push({ userId: 6, countryId: 1, scopeType: 'WAREHOUSE', scopeRefId: 401 })
  db.apBills = [{ id: 99101, countryId: 1, warehouseId: 401 }, { id: 99102, countryId: 1, warehouseId: 402 }]
  db.apStatements = [
    { id: 99111, countryId: 1, partnerId: 701, closing: 10, sourceRefs: [{ bizType: 'AP_BILL', id: 99101 }] },
    { id: 99112, countryId: 1, partnerId: 701, closing: 20, sourceRefs: [{ bizType: 'AP_BILL', id: 99102 }] },
    { id: 99113, countryId: 1, partnerId: 701, closing: 30, detailSnapshot: [] },
  ]
  const result = await callApi(ap.apHandlers, 'GET', '/ap/statements', undefined, { userId: 6 })
  assert.equal(result.status, 200)
  assert.deepEqual(result.data.records.map((s) => s.id), [99111])
  const admin = await callApi(ap.apHandlers, 'GET', '/ap/statements')
  assert.equal(admin.data.records.length, 3, 'country-wide reviewers retain legacy cache access')
})

test('cached AP statements hide report summary and nested amounts when COST is hidden', async () => {
  const db = freshDb()
  db.roles.find((r) => r.id === 11).fieldPolicies.COST = 'HIDDEN'
  db.apStatements = [{ id: 99201, countryId: 1, partnerId: 701, currency: 'MXN', opening: 10, increase: 20, paid: 5, offset: 2, adjust: 1, closing: 24, detailSnapshot: [{ amount: 20 }] }]
  const result = await callApi(ap.apHandlers, 'GET', '/ap/statements')
  const statement = result.data.records[0]
  for (const key of ['opening', 'increase', 'paid', 'offset', 'adjust', 'closing']) assert.equal(key in statement, false, `cached statement leaked ${key}`)
  assert.equal('amount' in statement.detailSnapshot[0], false)
  assert.equal(db.apStatements[0].closing, 24)
})

for (const action of ['draft', 'submit', 'ship', 'duplicate']) test(`purchase return ${action} response hides COST fields recursively`, async () => {
  const db = freshDb(); purchaseFixture(db)
  db.roles.find((r) => r.id === 11).fieldPolicies.COST = 'HIDDEN'
  let result
  if (action === 'draft' || action === 'submit') {
    result = await callApi(rtn.rtnHandlers, 'POST', '/rtn/purchase', { poId: 91000, stage: 'DOMESTIC', submit: action === 'submit', lines: [{ poLineId: 91001, sourceLineId: 91003, qty: 5 }] })
  } else {
    db.rtnPurchase = [{ id: 99301, countryId: 1, supplierId: 701, poId: 91000, poNo: 'PO-TEST', currency: 'CNY', stage: 'DOMESTIC', status: action === 'ship' ? 'APPROVED' : 'COMPLETED', docNo: 'PR-TEST', lines: [{ id: 99302, poLineId: 91001, sourceLineId: 91003, productId: db.products[0].id, qty: 5, unitPrice: 10, amount: 50 }] }]
    result = await callApi(rtn.rtnHandlers, 'POST', '/rtn/purchase/99301/ship', {})
  }
  assert.equal(result.status, 200, JSON.stringify(result.body))
  assert.equal('amount' in result.data.lines[0], false, `${action} leaked line amount`)
  assert.equal('unitPrice' in result.data.lines[0], false, `${action} leaked original purchase price`)
  assert.equal(db.rtnPurchase[0].lines[0].amount, 50)
})

for (const action of ['create', 'resolve']) test(`claim ${action} response hides COST amounts`, async () => {
  const db = freshDb()
  db.roles.find((r) => r.id === 11).fieldPolicies.COST = 'HIDDEN'
  let result
  if (action === 'create') result = await callApi(rtn.rtnHandlers, 'POST', '/rtn/claims', { partnerId: 701, claimAmount: 20, currency: 'MXN' })
  else {
    db.rtnClaims = [{ id: 99401, countryId: 1, partnerId: 701, claimAmount: 20, currency: 'MXN', result: 'PENDING' }]
    result = await callApi(rtn.rtnHandlers, 'POST', '/rtn/claims/99401/resolve', { result: 'COMPENSATED', compensatedAmount: 20 })
  }
  assert.equal(result.status, 200, JSON.stringify(result.body))
  for (const key of ['claimAmount', 'compensatedAmount']) assert.equal(key in result.data, false, `${action} leaked ${key}`)
})

test('submitted refund response obeys amount and bank field permissions', async () => {
  const db = freshDb()
  Object.assign(db.roles.find((r) => r.id === 11).fieldPolicies, { ORDER_TOTAL: 'HIDDEN', BANK_INFO: 'HIDDEN' })
  db.arCreditNotes = [{ id: 99501, countryId: 1, customerId: 601, currency: 'MXN', amount: 20, usedAmount: 0, refundableFlag: true }]
  const result = await callApi(rtn.rtnHandlers, 'POST', '/rtn/refunds', { customerId: 601, amount: 20, method: 'TRANSFER', fundAccountId: 902, payeeInfo: { name: '客户', account: 'PRIVATE-ACCOUNT' } })
  assert.equal(result.status, 200, JSON.stringify(result.body))
  assert.equal('amount' in result.data, false)
  assert.equal('account' in result.data.payeeInfo, false)
  assert.equal(db.rtnRefunds[0].payeeInfo.account, 'PRIVATE-ACCOUNT')
})
