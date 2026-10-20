import test from 'node:test'
import assert from 'node:assert/strict'
import { freshDb, context, callApi } from './support.mjs'
const costs = await import('../src/mock/services/cost.ts')
const { cstOpsHandlers, profitRows, buildAllocation } = await import('../src/mock/handlers/cstOps.ts')
const { anaHandlers, recalculateClassify } = await import('../src/mock/handlers/ana.ts')
const { purHandlers } = await import('../src/mock/handlers/pur.ts')
const { cstHandlers } = await import('../src/mock/handlers/cst.ts')
const { confirmFee } = await import('../src/mock/handlers/lgs.ts')
const { returnIn, adjust } = await import('../src/mock/services/inventory.ts')
const { getDb } = await import('../src/mock/db.ts')
const api = (method, path, body = {}) => callApi(cstOpsHandlers, method, path, body)

function fixture() {
  const db = freshDb()
  db.seq = 50000
  const productId = db.products[0].id
  const batches = [
    { id: 20001, countryId: 1, productId, batchNo: 'COST-A', shipmentId: 8001, firstInboundDate: '2026-10-01', costId: 21001 },
    { id: 20002, countryId: 1, productId, batchNo: 'COST-B', shipmentId: 8001, firstInboundDate: '2026-10-02', costId: 21002 },
  ]
  db.invBatches.push(...batches)
  db.inboundCosts.push(...batches.map((b, index) => ({ id: b.costId, countryId: 1, bookId: 61, batchId: b.id, warehouseId: 401, productId, qty: index ? 5 : 10, srcCurrency: 'MXN', baseCurrency: 'MXN', srcAmount: 100, basePurchaseAmount: 100, allocFeeAmount: 0, unitCost: index ? 20 : 10, status: 'CONFIRMED', bizDate: '2026-10-01' })))
  db.invBatchBalances.push(...batches.map((b, index) => ({ id: 22001 + index, countryId: 1, warehouseId: 401, productId, batchId: b.id, onHandQty: index ? 5 : 10, frozenQty: 0 })))
  const outbound = { id: 23001, countryId: 1, warehouseId: 401, orderId: 24001, status: 'OUTBOUNDED', bizDate: '2026-10-10', docNo: 'OB-COST', lines: [{ id: 23002, productId, qty: 15, amount: 750, batchId: 20001, batches: [{ batchId: 20001, qty: 10 }, { batchId: 20002, qty: 5 }] }] }
  db.salOutbounds.push(outbound)
  return { db, productId, outbound }
}

test('profit uses every consumed batch rather than first batch times total quantity', () => {
  const { productId } = fixture()
  assert.equal(profitRows(1, '2026-10-01', '2026-10-31').find(r => r.productId === productId).cogsAmount, 200)
})

test('captured outbound cost remains stable when an inbound cost later changes', () => {
  const { db, outbound } = fixture()
  costs.captureOutboundCost(context(), outbound)
  assert.equal(costs.outboundCost(outbound).amount, 200)
  db.inboundCosts[0].unitCost = 90
  assert.equal(costs.outboundCost(outbound).amount, 200)
  assert.equal(profitRows(1, '2026-10-01', '2026-10-31')[0].cogsAmount, 200)
})

test('returns outside selected business period do not reduce that period profit', () => {
  const { db, productId } = fixture()
  db.rtnSales.push({ id: 25001, countryId: 1, status: 'COMPLETED', bizDate: '2026-09-15', settledAt: '2026-09-15T12:00:00Z', lines: [{ productId, qty: 2, amount: 100, unitCost: 10 }] })
  assert.equal(profitRows(1, '2026-10-01', '2026-10-31')[0].netSalesAmount, 750)
})

for (const [label, status, treatment] of [['draft', 'DRAFT', 'CAPITALIZE'], ['period expense', 'CONFIRMED', 'PERIOD_EXPENSE']]) {
  test(`inventory allocation rejects ${label} fee`, () => {
    const { db } = fixture()
    const item = db.expenseItems.find(i => i.countryId === 1)
    item.costTreatment = treatment
    db.lgsFees.push({ id: 26001, countryId: 1, shipmentId: 8001, expenseItemId: item.id, amount: 100, currency: 'MXN', status, bizDate: '2026-10-10' })
    assert.throws(() => buildAllocation(context(), { feeId: 26001 }, true))
  })
}

test('capitalized foreign fee is converted once and allocation conserves base amount', () => {
  const { db } = fixture()
  const item = db.expenseItems.find(i => i.countryId === 1)
  item.costTreatment = 'CAPITALIZE'
  db.exchangeRates.push({ id: 27001, countryId: 1, fromCcy: 'CNY', toCcy: 'MXN', rateDate: '2026-10-10', scope: 'PURCHASE_COST', rate: 2.5, versionNo: 99, status: 'CONFIRMED' })
  db.lgsFees.push({ id: 26001, countryId: 1, shipmentId: 8001, expenseItemId: item.id, amount: 100, currency: 'CNY', status: 'CONFIRMED', bizDate: '2026-10-10' })
  const alloc = buildAllocation(context(), { feeId: 26001 }, true)
  assert.equal(alloc.baseAmount, 250)
  assert.equal(Math.round(alloc.lines.reduce((s, l) => s + l.amount, 0) * 100), 25000)
  assert.equal(Math.round(db.inboundCosts.reduce((s, c) => s + c.allocFeeAmount, 0) * 100), 25000)
})

test('COGS adjustment changes current profit once without rewriting historical outbound snapshot', async () => {
  const { outbound, productId } = fixture()
  costs.captureOutboundCost(context(), outbound)
  const created = await api('POST', '/cst/adjustments', { reason: '实际运费差额', target: 'COGS', batchId: 20001, productId, amount: 50, bizDate: '2026-10-12' })
  assert.equal(created.status, 200, JSON.stringify(created))
  for (let i = 0; i < 2; i++) assert.equal((await api('POST', `/cst/adjustments/${created.data.id}/confirm`)).status, 200)
  assert.equal(profitRows(1, '2026-10-01', '2026-10-31')[0].cogsAmount, 250)
  assert.equal(costs.outboundCost(outbound).amount, 200)
  assert.ok(getDb().costAdjustments[0].periodId)
})

test('cost writes reject closed period and adjusted snapshot is never re-estimated', async () => {
  const { db } = fixture()
  db.finPeriods.find(p => p.countryId === 1 && p.periodNo === 10).status = 'CLOSED'
  const result = await api('POST', '/cst/adjustments', { reason: '调整', target: 'INVENTORY', batchId: 20001, amount: 50, bizDate: '2026-10-12' })
  assert.equal(result.code, 'FIN_PERIOD_CLOSED')
  const cost = getDb().inboundCosts[0]
  cost.status = 'ADJUSTED'
  cost.unitCost = 50
  costs.refreshEstimate(cost)
  assert.equal(cost.unitCost, 50)
})

test('warehouse and store classification allocate only their own effective demand', () => {
  const { db, productId } = fixture()
  const date = new Date().toISOString()
  db.salOrders.push({ id: 28001, countryId: 1, storeId: 501, approvalStatus: 'APPROVED', approvedAt: date, status: 'APPROVED', lines: [{ productId, baseQty: 10, qty: 10, cancelledQty: 0, outboundQty: 2, allocs: [{ warehouseId: 401, allocQty: 3, cancelledQty: 0, outboundQty: 1 }, { warehouseId: 402, allocQty: 7, cancelledQty: 0, outboundQty: 1 }] }] })
  db.classifyRules = [{ id: 28002, countryId: 1, name: '测试', status: 'ACTIVE', versionNo: 1, dimType: 'WAREHOUSE', periodType: 'ROLLING_DAYS', periodDays: 30, orderMetric: 'QTY', stockMetric: 'AVAILABLE', conditions: [] }]
  recalculateClassify(1)
  const rows = db.classifyResults.filter(r => r.productId === productId)
  assert.equal(rows.find(r => r.dimId === 401).orderQty, 3)
  assert.equal(rows.find(r => r.dimId === 402).orderQty, 7)
})

test('replenishment counts only linked purchase line arrival up to linked quantity', async () => {
  const { db, productId } = fixture()
  db.purOrders.push({ id: 29001, countryId: 1, lines: [{ id: 29002, productId, arrivedMxQty: 8 }, { id: 29003, productId, arrivedMxQty: 50 }] })
  db.replenishments.push({ id: 29004, countryId: 1, warehouseId: 401, productId, reqQty: 10, status: 'LINKED', links: [{ execDocType: 'PUR_ORDER', execDocId: 29001, execLineId: 29002, qty: 5 }] })
  const result = await callApi(anaHandlers, 'GET', '/inv/replenishments')
  assert.equal(result.status, 200)
  assert.equal(result.data.records[0].fulfilledQty, 5)
})

test('domestic purchase return is excluded from available export source quantity', async () => {
  const { db, productId } = fixture()
  db.domesticReceipts.push({ id: 30001, countryId: 1, status: 'CONFIRMED', lines: [{ id: 30002, productId, qualifiedQty: 10, convertedQualifiedQty: 0, exportedQty: 2, returnedQty: 3 }] })
  const result = await callApi(purHandlers, 'GET', '/pur/export-nodes/sources')
  assert.equal(result.status, 200)
  assert.equal(result.data[0].exportableQty, 5)
})

test('moving average remains pending if any inventory valuation component lacks cost', () => {
  const { db, outbound } = fixture()
  db.cstMethods.find(m => m.bookId === 61).method = 'MOVING_AVG'
  outbound.lines[0].qty = 10
  outbound.lines[0].batches = [{ batchId: 20001, qty: 10 }]
  db.invBatchBalances.find(b => b.batchId === 20001).onHandQty = 0
  db.inboundCosts.find(c => c.batchId === 20002).unitCost = null
  costs.captureOutboundCost(context(), outbound)
  assert.equal(costs.outboundCost(outbound).missing, true)
  db.inboundCosts.find(c => c.batchId === 20002).unitCost = 20
  costs.captureOutboundCost(context(), outbound)
  assert.equal(costs.outboundCost(outbound).missing, false)
  assert.equal(costs.outboundCost(outbound).amount, 133.33)
})

test('return inventory inherits original sale unit cost rather than zero', () => {
  const { db, productId } = fixture()
  const batch = returnIn(context(), { warehouseId: 401, productId, goodQty: 2, frozenQty: 0, freezeType: 'RETURN_PENDING', source: { type: 'RTN_SALES', id: 35001, lineId: 35002, no: 'SR-TEST' }, bizDate: '2026-10-12', reason: '退货', unitCost: 13.333333, sourceOutboundLineId: 23002 })
  const cost = db.inboundCosts.find(c => c.batchId === batch[0].batchId)
  assert.ok(cost)
  assert.equal(cost.unitCost, 13.333333)
  assert.equal(cost.basePurchaseAmount, 26.67)
})

test('actual freight replaces allocated estimate by difference without changing sale snapshot', () => {
  const { db, outbound } = fixture()
  const item = db.expenseItems.find(i => i.countryId === 1)
  item.costTreatment = 'CAPITALIZE'
  db.invBatchBalances.find(b => b.batchId === 20001).onHandQty = 5
  outbound.lines[0].qty = 5
  outbound.lines[0].batches = [{ batchId: 20001, qty: 5 }]
  costs.captureOutboundCost(context(), outbound)
  db.lgsFees.push({ id: 36001, countryId: 1, shipmentId: 8001, expenseItemId: item.id, amount: 100, currency: 'MXN', estimateFlag: 'ESTIMATE', status: 'CONFIRMED', bizDate: '2026-10-10' })
  buildAllocation(context(), { feeId: 36001 }, true)
  const soldCost = costs.outboundCost(outbound).amount
  const actual = { id: 36002, countryId: 1, shipmentId: 8001, expenseItemId: item.id, amount: 160, currency: 'MXN', estimateFlag: 'ACTUAL', estimateFeeId: 36001, status: 'DRAFT', version: 1, bizDate: '2026-10-12' }
  db.lgsFees.push(actual)
  confirmFee(context(), actual)
  assert.equal(actual.deltaBaseAmount, 60)
  assert.equal(Math.round(db.inboundCosts.reduce((s,c)=>s+c.allocFeeAmount,0)), 160)
  assert.equal(costs.outboundCost(outbound).amount, soldCost)
  assert.equal(db.feeAllocations.filter(a=>a.status==='CONFIRMED').length, 1)
})

test('cost trace cannot read another warehouse and COST hidden blocks detailed cost endpoint', async () => {
  const { db } = fixture()
  db.roles.push({ id: 37001, countryId: 1, status: 'ENABLED', permissions: ['cst:cost:view', 'inv:stock:view'], fieldPolicies: { COST: 'HIDDEN' } })
  db.users.push({ id: 37002, username: 'limited-cost', status: 'ENABLED' })
  db.userRoles.push({ userId: 37002, countryId: 1, roleId: 37001 })
  db.dataScopes.push({ userId: 37002, countryId: 1, scopeType: 'WAREHOUSE', scopeRefId: 402 })
  const trace = await callApi(cstHandlers, 'GET', '/cst/batches/20001/cost-trace', undefined, { userId: 37002 })
  assert.equal(trace.status, 404)
  const list = await callApi(cstHandlers, 'GET', '/cst/inbound-costs', undefined, { userId: 37002 })
  assert.equal(list.status, 403)
})

test('logistics fee confirmation preserves original currency while cost waits for rate', () => {
  const { db } = fixture()
  db.exchangeRates = []
  const fee = { id: 38001, countryId: 1, amount: 100, currency: 'CNY', status: 'DRAFT', version: 1, bizDate: '2026-09-10' }
  db.lgsFees.push(fee)
  confirmFee(context(), fee)
  assert.equal(fee.status, 'CONFIRMED')
  assert.equal(fee.costStatus, 'PENDING_RATE')
  assert.equal(fee.baseAmount, null)
})

test('moving average restores all same-SKU outbound lines before valuing any line', () => {
  const { db, outbound, productId } = fixture()
  db.cstMethods.find(m => m.bookId === 61).method = 'MOVING_AVG'
  db.inboundCosts.find(c => c.batchId === 20002).qty = 10
  db.invBatchBalances.find(b => b.batchId === 20001).onHandQty = 0
  db.invBatchBalances.find(b => b.batchId === 20002).onHandQty = 10
  outbound.lines = [1, 2].map(i => ({ id: 40000+i, productId, qty: 5, batches: [{ batchId: 20001, qty: 5 }], amount: 250 }))
  costs.captureOutboundCost(context(), outbound)
  assert.equal(costs.outboundCost(outbound).amount, 150)
})

test('late capitalized fee follows returned inventory and only net sold quantity reaches COGS', () => {
  const { db, outbound, productId } = fixture()
  outbound.lines[0].qty = 10
  outbound.lines[0].batches = [{ batchId: 20001, qty: 10 }]
  db.invBatchBalances.find(b=>b.batchId===20001).onHandQty = 0
  costs.captureOutboundCost(context(), outbound)
  const returnedBatch = { id: 41001, countryId: 1, productId, sourceType: 'RETURN' }
  db.invBatches.push(returnedBatch)
  const returnedCost = costs.createBatchCost(context(), returnedBatch, { warehouseId: 401, qty: 2, unitCost: 10, bizDate: '2026-10-11', sourceOutboundLineId: outbound.lines[0].id })
  db.invBatchBalances.push({ id:41002, countryId:1, warehouseId:401, productId, batchId:41001, onHandQty:2, frozenQty:0 })
  const item = db.expenseItems.find(i=>i.countryId===1)
  item.costTreatment = 'CAPITALIZE'
  db.lgsFees.push({ id:41003,countryId:1,shipmentId:8001,expenseItemId:item.id,amount:150,currency:'MXN',status:'CONFIRMED',bizDate:'2026-10-12' })
  buildAllocation(context(), {feeId:41003}, true)
  assert.equal(returnedCost.unitCost, 20)
  assert.equal(db.costAdjustments.filter(a=>a.sourceType==='FEE_ALLOCATION').reduce((s,a)=>s+a.amount,0), 80)
})

test('allocation preview rejects the whole shipment when any target cost is outside scope', async () => {
  const { db } = fixture()
  db.inboundCosts.find(c=>c.batchId===20002).warehouseId=402
  db.roles.push({ id:42001,countryId:1,status:'ENABLED',permissions:['cst:allocation:create'],fieldPolicies:{COST:'READ'} })
  db.users.push({ id:42002,status:'ENABLED' })
  db.userRoles.push({ userId:42002,roleId:42001,countryId:1 })
  db.dataScopes.push({ userId:42002,countryId:1,scopeType:'WAREHOUSE',scopeRefId:401 })
  const item=db.expenseItems.find(i=>i.countryId===1);item.costTreatment='CAPITALIZE'
  db.shipments.push({id:8001,countryId:1,destWarehouseId:401})
  db.lgsFees.push({id:42003,countryId:1,shipmentId:8001,expenseItemId:item.id,amount:150,currency:'MXN',status:'CONFIRMED',bizDate:'2026-10-12'})
  const response=await callApi(cstOpsHandlers,'POST','/cst/allocations',{feeId:42003},{userId:42002})
  assert.equal(response.status,404)
})

test('stocktake gains create a valued batch using the latest eligible warehouse cost', () => {
  const { db, productId } = fixture()
  db.inboundCosts.find(c=>c.batchId===20002).bizDate='2026-10-02'
  adjust(context(), {warehouseId:401,productId,diff:2,source:{type:'INV_STOCKTAKE',id:43001,lineId:43002,no:'ST-GAIN'},bizDate:'2026-10-12'})
  const batch=db.invBatches.find(b=>b.sourceType==='STOCKTAKE_GAIN')
  const cost=db.inboundCosts.find(c=>c.batchId===batch.id)
  assert.ok(cost)
  assert.equal(cost.unitCost,20)
  assert.equal(cost.sourceType,'STOCKTAKE_GAIN')
})

test('classification order drilldown does not reveal other warehouse allocated quantity', async () => {
  const { db, productId } = fixture()
  db.users.push({id:44001,status:'ENABLED'})
  db.roles.push({id:44002,countryId:1,status:'ENABLED',permissions:['inv:classify:view'],fieldPolicies:{}})
  db.userRoles.push({userId:44001,roleId:44002,countryId:1})
  db.dataScopes.push({userId:44001,countryId:1,scopeType:'WAREHOUSE',scopeRefId:401})
  db.salOrders.push({id:44003,countryId:1,storeId:null,lines:[{productId,qty:10,baseQty:10,cancelledQty:0,outboundQty:0,allocs:[{warehouseId:401,allocQty:3},{warehouseId:402,allocQty:7}]}]})
  db.classifyResults.push({id:44004,countryId:1,dimType:'WAREHOUSE',dimId:401,productId,orderIds:[44003]})
  const response=await callApi(anaHandlers,'GET','/inv/classify-results/44004/orders',undefined,{userId:44001})
  assert.equal(response.status,200)
  assert.equal(response.data[0].qty,3)
})

for (const path of ['/cst/allocations', '/cst/adjustments', '/cst/expenses']) {
  test(`COST-hidden users cannot obtain amounts from ${path}`, async () => {
    const { db } = fixture()
    db.users.push({id:45001,status:'ENABLED'})
    db.roles.push({id:45002,countryId:1,status:'ENABLED',permissions:['cst:*'],fieldPolicies:{COST:'HIDDEN'}})
    db.userRoles.push({userId:45001,roleId:45002,countryId:1})
    db.dataScopes.push({userId:45001,countryId:1,scopeType:'COUNTRY_ALL'})
    const result=await callApi(cstOpsHandlers,'GET',path,undefined,{userId:45001})
    assert.equal(result.status,403)
  })
}
