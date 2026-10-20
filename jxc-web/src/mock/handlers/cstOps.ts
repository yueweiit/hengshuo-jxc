/* eslint-disable @typescript-eslint/no-explicit-any */
/**
 * 11 费用分摊、成本调整、费用登记、利润。分摊舍入差额由金额最大的一行吸收。
 */
import { http } from 'msw'
import { getDb, nextId, nowIso, type Row } from '../db'
import { API, findOr404 } from '../crud'
import { audit, canDataAccess, handle, paginate, requireCountry, requireDataAccess, requireFieldAccess, requirePerm, userFieldGroups, type Ctx } from '../utils'
import { bad, docNo, nameOf, num, product, round, sum, today, withProduct } from '../services/common'
import { activeBook, assertPeriodOpen } from '../services/period'
import { applyCapitalizedAllocation, confirmCostAdjustment, convertedAmount, lineCost } from '../services/cost'
import { canDocumentDataAccess, requireDocumentDataAccess } from '../services/access'

export const PROFIT_DISCLAIMER = '按系统内已登记数据计算，未包含线下营销费用，不能称为全成本净利润。'

function splitAmount(amount: number, weights: number[], decimals = 2) {
  const total = weights.reduce((a, b) => a + b, 0)
  if (!(total > 0)) bad('分摊依据合计必须大于 0')
  const raw = weights.map((w) => (amount * w) / total)
  const rounded = raw.map((n) => round(n, decimals))
  let diff = round(amount - rounded.reduce((a, b) => a + b, 0), decimals)
  let idx = 0
  raw.forEach((n, i) => { if (n > raw[idx]) idx = i })
  rounded[idx] = round(rounded[idx] + diff, decimals)
  return rounded
}

function targetsOf(ctx: Ctx, fee: Row, basis: string, manual: Row[]) {
  const db = getDb()
  const batches = db.invBatches.filter((b) => b.shipmentId === fee.shipmentId && b.countryId === fee.countryId)
  if (!batches.length) bad('这张费用关联的运输批次还没有实收批次，不能分摊到库存')
  return batches.map((b) => {
    const p = product(b.productId)
    const cost = db.inboundCosts.find((c) => c.batchId === b.id)
    if (!cost) bad('批次尚未建立成本记录', 'CST_COST_MISSING')
    requireDataAccess(ctx, cost)
    const qty = num(cost?.qty)
    let weight = qty
    if (basis === 'WEIGHT') weight = qty * num(p?.grossWeight)
    if (basis === 'VOLUME') weight = qty * num(p?.volume)
    if (basis === 'VALUE') weight = num(cost?.basePurchaseAmount)
    if (basis === 'MANUAL') weight = num(manual.find((m) => m.batchId === b.id)?.ratio)
    return { batchId: b.id, productId: b.productId, batchNo: b.batchNo, qty, weight }
  })
}

export function buildAllocation(ctx: Ctx, body: Row, confirm: boolean) {
  requirePerm(ctx, 'cst:allocation:create')
  requireFieldAccess(ctx, 'COST')
  const db = getDb()
  const fee = db.lgsFees.find((f) => f.id === Number(body?.feeId) && f.countryId === ctx.countryId)
  if (!fee) bad('请选择费用')
  requireDocumentDataAccess(ctx, 'LGS_FEE', fee)
  if (fee.status !== 'CONFIRMED') bad('只有已确认费用可以分摊')
  if (fee.costStatus === 'PENDING_RATE' && (fee.estimateFlag === 'ACTUAL' || fee.estimateFeeId)) bad('请先在物流费用重试成本折算，再分摊实际费用', 'CST_FEE_PENDING_COST')
  const item = db.expenseItems.find(i => i.id === fee.expenseItemId && i.countryId === ctx.countryId)
  if (item?.costTreatment !== 'CAPITALIZE') bad('只有资本化费用可以分摊进入库存成本')
  if (!(Number(fee.amount) > 0)) bad('费用金额必须大于0')
  const bizDate = body.bizDate || fee.bizDate || today(ctx.countryId!)
  assertPeriodOpen(ctx.countryId!, bizDate)
  const conversion = convertedAmount(ctx.countryId!, fee.currency, Number(fee.amount), fee.bizDate || bizDate)
  const basis = body.basis || 'QTY'
  const targets = targetsOf(ctx, fee, basis, body.targets ?? [])
  const parts = splitAmount(conversion.baseAmount, targets.map((t) => t.weight), 2)
  const lines = targets.map((t, i) => ({ ...t, amount: parts[i], roundingAdj: 0 }))
  const max = lines.reduce((a, b) => (b.amount > a.amount ? b : a))
  const drift = round(conversion.baseAmount - sum(lines, (l) => l.amount))
  max.roundingAdj = drift
  max.amount = round(max.amount + drift)
  const row: Row = {
    id: nextId(), countryId: ctx.countryId, feeId: fee.id, feeNo: fee.docNo, basis, feeCurrency: fee.currency, feeAmount: num(fee.amount),
    ...conversion, bookId: activeBook(ctx.countryId!)?.id, bizDate,
    status: confirm ? 'CONFIRMED' : 'DRAFT', lines, createdAt: nowIso(),
  }
  if (confirm) {
    const prev = db.feeAllocations.find((a) => a.feeId === fee.id && a.status === 'CONFIRMED')
    if (prev) bad('这张费用已有有效分摊，请先撤销再重新分摊')
    applyCapitalizedAllocation(ctx, row, 1)
  }
  db.feeAllocations.unshift(row)
  return row
}

export function profitRows(countryId: number, from: string, to: string, ctx?: Ctx) {
  const db = getDb()
  const map = new Map<number, Row>()
  const slot = (productId: number) => {
    let row = map.get(productId)
    if (!row) {
      row = { productId, netSalesQty: 0, netSalesAmount: 0, cogsAmount: 0, directExpense: 0, periodExpense: 0, missingCost: false, estimated: false }
      map.set(productId, row)
    }
    return row
  }
  const visible = (row: Row) => !ctx || canDataAccess(ctx, row)
  for (const ob of db.salOutbounds.filter((o) => o.countryId === countryId && o.status === 'OUTBOUNDED' && o.bizDate >= from && o.bizDate <= to && visible(o))) {
    for (const line of ob.lines ?? []) {
      const row = slot(line.productId)
      row.netSalesQty += num(line.qty)
      row.netSalesAmount += num(line.amount)
      const cost = lineCost(line)
      row.missingCost ||= cost.missing
      row.cogsAmount += num(cost.amount)
      row.estimated ||= cost.estimated
    }
  }
  for (const ret of db.rtnSales.filter((r) => r.countryId === countryId && r.status === 'COMPLETED' && (r.bizDate || r.settledAt?.slice(0,10) || r.receivedAt?.slice(0,10)) >= from && (r.bizDate || r.settledAt?.slice(0,10) || r.receivedAt?.slice(0,10)) <= to && visible(r))) {
    for (const line of ret.lines ?? []) {
      const row = slot(line.productId)
      row.netSalesQty -= num(line.receivedQty ?? line.qty)
      row.netSalesAmount -= num(line.settledAmount ?? line.amount)
      row.cogsAmount -= num(line.costAmount ?? num(line.receivedQty ?? line.qty) * num(line.unitCost ?? line.costPrice))
    }
  }
  for (const adj of db.costAdjustments.filter(a => a.countryId === countryId && a.status === 'CONFIRMED' && a.target === 'COGS' && a.bizDate >= from && a.bizDate <= to && visible(a))) slot(adj.productId).cogsAmount += num(adj.amount)
  for (const exp of db.expenses.filter((e) => e.countryId === countryId && e.status === 'CONFIRMED' && e.bizDate >= from && e.bizDate <= to && visible(e))) {
    for (const line of exp.lines ?? []) {
      const row = slot(line.productId)
      if (exp.treatment === 'DIRECT_SELLING') row.directExpense += num(line.baseAmount ?? line.amount)
      if (exp.treatment === 'PERIOD_EXPENSE') row.periodExpense += num(line.baseAmount ?? line.amount)
    }
    if (!(exp.lines ?? []).length && exp.treatment === 'PERIOD_EXPENSE') {
      const row = slot(0)
      row.periodExpense += num(exp.baseAmount)
    }
  }
  return [...map.values()].map((r) => {
    const gross = round(r.netSalesAmount - r.cogsAmount)
    const contribution = round(gross - r.directExpense - r.periodExpense)
    const completeness = r.missingCost ? 'INSUFFICIENT' : r.estimated ? 'ESTIMATED' : 'COMPLETE'
    const out = withProduct({
      ...r, netSalesQty: round(r.netSalesQty, 4), netSalesAmount: round(r.netSalesAmount), cogsAmount: round(r.cogsAmount),
      directExpense: round(r.directExpense), periodExpense: round(r.periodExpense), grossProfit: gross, contributionProfit: contribution, completeness,
    })
    if (!r.productId) {
      out.productCode = '—'
      out.productName = '未分到商品的期间费用'
    }
    return out
  })
}

const allocCreate = http.post(`${API}/cst/allocations`, handle((ctx, { body }) => {
  requireCountry(ctx)
  return buildAllocation(ctx, body ?? {}, false)
}))

const allocList = http.get(`${API}/cst/allocations`, handle((ctx) => {
  requirePerm(ctx, ['cst:allocation:create', 'cst:cost:view'])
  requireFieldAccess(ctx, 'COST')
  const countryId = requireCountry(ctx)
  return paginate(getDb().feeAllocations.filter((a) => a.countryId === countryId && canDocumentDataAccess(ctx, 'COST_ALLOCATION', a)), ctx.url)
}))

const allocConfirm = http.post(`${API}/cst/allocations/:id/confirm`, handle((ctx, { params }) => {
  requirePerm(ctx, 'cst:allocation:create')
  requireFieldAccess(ctx, 'COST')
  const row = findOr404(ctx, 'feeAllocations', Number(params.id))
  requireDocumentDataAccess(ctx, 'COST_ALLOCATION', row)
  if (row.status === 'CONFIRMED') return { ...row, duplicate: true }
  if (getDb().feeAllocations.some((a) => a.feeId === row.feeId && a.status === 'CONFIRMED')) bad('这张费用已有有效分摊')
  if (row.status !== 'DRAFT') bad('只有草稿分摊可以确认')
  const fee = getDb().lgsFees.find(f => f.id === row.feeId)
  if (fee?.status !== 'CONFIRMED') bad('来源费用已变化，请重新分摊')
  applyCapitalizedAllocation(ctx, row, 1)
  row.status = 'CONFIRMED'
  audit(ctx, '确认费用分摊', 'fee-allocation', row.id, null, { feeNo: row.feeNo })
  return row
}))

const allocReverse = http.post(`${API}/cst/allocations/:id/reverse`, handle((ctx, { params }) => {
  requirePerm(ctx, 'cst:allocation:create')
  requireFieldAccess(ctx, 'COST')
  const row = findOr404(ctx, 'feeAllocations', Number(params.id))
  requireDocumentDataAccess(ctx, 'COST_ALLOCATION', row)
  if (row.status !== 'CONFIRMED') bad('只有已确认的分摊可以撤销')
  applyCapitalizedAllocation(ctx, row, -1)
  row.status = 'REVERSED'
  return row
}))

const adjList = http.get(`${API}/cst/adjustments`, handle((ctx) => {
  requirePerm(ctx, ['cst:adjustment:create', 'cst:cost:view'])
  requireFieldAccess(ctx, 'COST')
  return paginate(getDb().costAdjustments.filter((a) => a.countryId === requireCountry(ctx) && canDataAccess(ctx, a)), ctx.url)
}))

const adjCreate = http.post(`${API}/cst/adjustments`, handle((ctx, { body }) => {
  requirePerm(ctx, 'cst:adjustment:create')
  requireFieldAccess(ctx, 'COST')
  const countryId = requireCountry(ctx)
  if (!body?.reason) bad('请填写调整原因')
  const date = body.bizDate || today(countryId)
  assertPeriodOpen(countryId, date)
  const cost = getDb().inboundCosts.find(c => c.batchId === Number(body.batchId) && c.countryId === countryId)
  if (!cost) bad('请选择本国有效成本批次')
  requireDataAccess(ctx, cost)
  if (!['INVENTORY', 'COGS'].includes(body.target || 'INVENTORY')) bad('调整对象不正确')
  if (!Number.isFinite(Number(body.amount)) || Number(body.amount) === 0) bad('调整金额必须是非零有效金额')
  const row = {
    id: nextId(), countryId, docNo: docNo(countryId, 'CA'), bookId: activeBook(countryId)?.id ?? null, periodId: null,
    reason: body.reason, target: body.target || 'INVENTORY', batchId: body.batchId ?? null,
    warehouseId: cost.warehouseId, productId: cost.productId, bizDate: date,
    amount: round(num(body.amount)), status: 'DRAFT', createdAt: nowIso(),
  }
  getDb().costAdjustments.unshift(row)
  return row
}))

const adjConfirm = http.post(`${API}/cst/adjustments/:id/confirm`, handle((ctx, { params }) => {
  requirePerm(ctx, 'cst:adjustment:create')
  const row = findOr404(ctx, 'costAdjustments', Number(params.id))
  return confirmCostAdjustment(ctx, row)
}))

const expList = http.get(`${API}/cst/expenses`, handle((ctx) => {
  requirePerm(ctx, ['cst:expense:create', 'cst:profit:view'])
  requireFieldAccess(ctx, 'COST')
  return paginate(getDb().expenses.filter((e) => e.countryId === requireCountry(ctx) && canDataAccess(ctx, e)).map((e) => ({ ...e, itemName: nameOf(getDb().expenseItems, e.expenseItemId) })), ctx.url)
}))

const expCreate = http.post(`${API}/cst/expenses`, handle((ctx, { body }) => {
  requirePerm(ctx, 'cst:expense:create')
  requireFieldAccess(ctx, 'COST')
  const countryId = requireCountry(ctx)
  const item = getDb().expenseItems.find((e) => e.id === Number(body?.expenseItemId) && e.countryId === countryId)
  if (!item) bad('请选择费用项目')
  if (!['PERIOD_EXPENSE', 'DIRECT_SELLING'].includes(item.costTreatment)) bad('资本化费用请走费用分摊，不在这里登记')
  const amount = round(num(body?.amount))
  if (!(amount > 0)) bad('金额必须大于 0')
  const bizDate = body.bizDate || today(countryId)
  assertPeriodOpen(countryId, bizDate)
  const currency = body.currency || item.currency || getDb().countries.find(c => c.id === countryId)?.defaultCurrency
  const conversion = convertedAmount(countryId, currency, amount, bizDate)
  const lines = (body?.lines ?? []).map((l: Row) => ({ productId: Number(l.productId), amount: round(num(l.amount)) }))
  if (item.costTreatment === 'DIRECT_SELLING') {
    if (!lines.length) bad('直接销售费用需要分到商品')
    if (Math.abs(sum(lines, (l: Row) => l.amount) - amount) > 0.01) bad('分摊到商品的金额须等于费用金额')
  }
  if (lines.length && (lines.some((l: Row) => !(l.amount > 0)) || Math.abs(sum(lines, (l: Row) => l.amount) - amount) > 0.01)) bad('商品分摊金额须为正数且合计等于原费用')
  const converted = lines.length ? splitAmount(conversion.baseAmount, lines.map((l: Row) => l.amount), 2) : []
  lines.forEach((l: Row, i: number) => { l.baseAmount = converted[i] })
  const row = {
    id: nextId(), countryId, docNo: docNo(countryId, 'EX'), expenseItemId: item.id, treatment: item.costTreatment,
    currency, ...conversion, bookId: activeBook(countryId)?.id,
    amount, bizDate, lines, status: 'CONFIRMED', createdAt: nowIso(),
  }
  getDb().expenses.unshift(row)
  audit(ctx, '登记费用', 'expense', row.id, null, { docNo: row.docNo })
  return row
}))

const profit = http.get(`${API}/cst/profit`, handle((ctx) => {
  requirePerm(ctx, 'cst:profit:view')
  requireFieldAccess(ctx, 'PROFIT')
  const countryId = requireCountry(ctx)
  const from = ctx.url.searchParams.get('from') || `${today(countryId).slice(0, 7)}-01`
  const to = ctx.url.searchParams.get('to') || today(countryId)
  const fields = userFieldGroups(ctx.user, countryId)
  const rows = profitRows(countryId, from, to, ctx).map(row => {
    const result = { ...row }
    if (fields.COST === 'HIDDEN') for (const key of ['cogsAmount', 'directExpense', 'periodExpense', 'grossProfit', 'contributionProfit']) delete result[key]
    if (fields.ORDER_TOTAL === 'HIDDEN') for (const key of ['netSalesAmount', 'grossProfit', 'contributionProfit']) delete result[key]
    return result
  })
  return {
    from, to, currency: getDb().countries.find((c) => c.id === countryId)?.defaultCurrency, disclaimer: PROFIT_DISCLAIMER,
    rows, grossProfit: fields.COST === 'HIDDEN' || fields.ORDER_TOTAL === 'HIDDEN' ? undefined : round(sum(rows, (r) => r.grossProfit)), contributionProfit: fields.COST === 'HIDDEN' || fields.ORDER_TOTAL === 'HIDDEN' ? undefined : round(sum(rows, (r) => r.contributionProfit)),
    reconcileHint: '财务利润表来自已记账凭证。未记账的出库和未分摊费用会造成两边差异。',
  }
}))

const methodGet = http.get(`${API}/cst/method`, handle((ctx) => {
  requirePerm(ctx, ['cst:method:config', 'cst:cost:view'])
  const book = activeBook(requireCountry(ctx))
  return getDb().cstMethods.find((m) => m.bookId === book?.id && m.status === 'ACTIVE') ?? { method: 'FIFO', status: 'ACTIVE' }
}))

const methodPut = http.put(`${API}/cst/method`, handle((ctx, { body }) => {
  requirePerm(ctx, 'cst:method:config')
  const countryId = requireCountry(ctx)
  const book = activeBook(countryId)
  if (!book) bad('请先启用账套')
  requireDataAccess(ctx, book)
  if (!['FIFO', 'MOVING_AVG', 'BATCH_SPECIFIC'].includes(body?.method)) bad('计价方法不正确')
  if (getDb().finVouchers.some((v) => v.bookId === book.id && v.status === 'POSTED')) bad('已有记账数据，不能直接切换计价方法', 'CST_METHOD_LOCKED')
  const version = Math.max(0, ...getDb().cstMethods.filter(m => m.bookId === book.id).map(m => num(m.versionNo))) + 1
  const row = { id: nextId(), bookId: book.id, countryId, method: body.method, status: 'ACTIVE', versionNo: version }
  getDb().cstMethods.forEach((m) => { if (m.bookId === book.id) m.status = 'RETIRED' })
  getDb().cstMethods.push(row)
  return row
}))

export const cstOpsHandlers = [allocList, allocCreate, allocConfirm, allocReverse, adjList, adjCreate, adjConfirm, expList, expCreate, profit, methodGet, methodPut]
