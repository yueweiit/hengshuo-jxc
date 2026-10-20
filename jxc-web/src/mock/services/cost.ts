/* eslint-disable @typescript-eslint/no-explicit-any */
/**
 * 入库成本快照（docs/11 第 5.2 节）：每次 MX 实收行生成一条，保存采购原币、汇率及日期、本位币成本。
 * 缺少已确认的 PURCHASE_COST 汇率时为 PENDING_RATE，不能确认，也不能把 CNY 金额当作本位币使用（A21）。
 * 已确认快照不随汇率修改重算；后续分摊和调整记录估值历史，已售差额进入原成本调整表。
 */
import { getDb, nextId, nowIso, type Row } from '../db'
import { audit, requireDataAccess, requireFieldAccess, type Ctx } from '../utils'
import { bad, closeTodo, country, docNo, num, openTodo, round, sum, today } from './common'
import { activeBook, assertPeriodOpen, periodOf } from './period'

export function resolveRate(countryId: number, from: string, to: string, date: string, scope = 'PURCHASE_COST') {
  if (from === to) return { id: null, rate: 1, rateDate: date, versionNo: 0 }
  return (
    getDb()
      .exchangeRates.filter(
        (r) => r.countryId === countryId && r.fromCcy === from && r.toCcy === to && r.status === 'CONFIRMED' &&
          (r.scope === scope || r.scope === 'ALL') && r.rateDate <= date,
      )
      .sort((a, b) => (a.rateDate === b.rateDate ? b.versionNo - a.versionNo : b.rateDate.localeCompare(a.rateDate)))[0] ?? null
  )
}

function rateTodoKey(countryId: number, from: string, date: string) {
  return `COST_RATE:${countryId}:${from}:${date}`
}

function applyRate(c: Row) {
  const rate = resolveRate(c.countryId, c.srcCurrency, c.baseCurrency, c.bizDate)
  if (!rate) {
    Object.assign(c, { rateId: null, rate: null, rateDate: null, basePurchaseAmount: null, unitCost: null, status: 'PENDING_RATE' })
    return false
  }
  const base = round(c.srcAmount * rate.rate, 2)
  Object.assign(c, {
    rateId: rate.id, rate: rate.rate, rateDate: rate.rateDate, basePurchaseAmount: base,
    unitCost: round((base + c.allocFeeAmount) / c.qty + num(c.unitCostAdjustment), 4), status: 'ESTIMATED',
  })
  return true
}

/** 未确认的快照按最新已确认汇率重估；补齐汇率后 PENDING_RATE 转为 ESTIMATED */
export function refreshEstimate(c: Row) {
  if (['CONFIRMED', 'ADJUSTED', 'PENDING_SOURCE_COST'].includes(c.status)) return
  const was = c.status
  applyRate(c)
  if (was === 'PENDING_RATE' && c.status === 'ESTIMATED' &&
    !getDb().inboundCosts.some((x) => x.status === 'PENDING_RATE' && x.countryId === c.countryId && x.srcCurrency === c.srcCurrency && x.bizDate === c.bizDate)) {
    closeTodo(rateTodoKey(c.countryId, c.srcCurrency, c.bizDate), '汇率已补齐')
  }
}

export interface InboundCostInput {
  receipt: Row
  receiptLine: Row
  batch: Row
  po: Row
  poLine: Row
  warehouseId: number
}

export function createInboundCost(ctx: Ctx, i: InboundCostInput) {
  const db = getDb()
  if (db.inboundCosts.some((c) => c.receiptLineId === i.receiptLine.id)) return null
  const qty = i.receiptLine.goodQty + i.receiptLine.damagedQty + i.receiptLine.pendingInspectQty
  const srcUnitPrice = round(i.poLine.amount / i.poLine.baseQty, 6)
  const c: Row = {
    id: nextId(), countryId: ctx.countryId, bookId: db.books.find((b) => b.countryId === ctx.countryId)?.id ?? null,
    receiptId: i.receipt.id, receiptNo: i.receipt.docNo, receiptLineId: i.receiptLine.id, batchId: i.batch.id, batchNo: i.batch.batchNo,
    productId: i.receiptLine.productId, warehouseId: i.warehouseId, qty, poId: i.po.id, poNo: i.po.docNo, poLineId: i.poLine.id,
    supplierId: i.po.supplierId, srcCurrency: i.po.currency, srcUnitPrice, srcAmount: round(srcUnitPrice * qty, 2),
    baseCurrency: country(ctx.countryId!).defaultCurrency, allocFeeAmount: 0, bizDate: i.receipt.bizDate,
    confirmedBy: null, confirmedAt: null, createdAt: nowIso(),
  }
  applyRate(c)
  db.inboundCosts.unshift(c)
  i.batch.costId = c.id
  if (c.status === 'PENDING_RATE') {
    openTodo({
      countryId: ctx.countryId!, todoType: 'PENDING_COST_RATE', dedupKey: rateTodoKey(c.countryId, c.srcCurrency, c.bizDate),
      title: `入库成本待补汇率：${c.srcCurrency}→${c.baseCurrency}（${c.bizDate} 及之前没有已确认的采购成本汇率）`,
      link: '/cost/inbound?status=PENDING_RATE', perm: 'cst:cost:confirm',
    })
  }
  return c
}

/** 成本确认：未确认的快照按当前已确认汇率重取；仍缺汇率时拒绝（幂等） */
export function confirmInboundCost(ctx: Ctx, c: Row) {
  requireDataAccess(ctx, c)
  requireFieldAccess(ctx, 'COST')
  if (['CONFIRMED', 'ADJUSTED'].includes(c.status)) return c
  assertPeriodOpen(ctx.countryId!, c.bizDate)
  if (c.status === 'PENDING_SOURCE_COST') {
    const original = getDb().salOutbounds.flatMap(ob => ob.countryId === c.countryId ? ob.lines : []).find(l => l.id === c.sourceOutboundLineId)
    const snapshot = original ? lineCost(original) : null
    if (!snapshot || snapshot.missing || !(original!.qty > 0)) bad('原出库成本尚未补齐', 'CST_COST_MISSING')
    c.srcUnitPrice = snapshot.amount / original!.qty
    c.srcAmount = round(c.srcUnitPrice * c.qty)
  }
  if (!applyRate(c)) {
    bad(`缺少 ${c.bizDate} 及之前已确认的 ${c.srcCurrency}→${c.baseCurrency} 采购成本汇率，不能确认成本`, 'CST_RATE_MISSING')
  }
  Object.assign(c, { status: 'CONFIRMED', confirmedBy: ctx.user.id, confirmedAt: nowIso(), confirmedBasePurchaseAmount: c.basePurchaseAmount, confirmedAllocFeeAmount: c.allocFeeAmount })
  for (const t of getDb().invTxns.filter((x) => x.batchId === c.batchId && x.unitCost == null)) t.unitCost = c.unitCost
  for (const ob of getDb().salOutbounds.filter((x) => x.countryId === c.countryId && x.lines.some((l: Row) => l.batches?.some((b: Row) => b.batchId === c.batchId) || l.costSnapshot?.valuationParts?.some((b: Row) => b.batchId === c.batchId)))) {
    captureOutboundCost(ctx, ob)
  }
  if (!getDb().inboundCosts.some((x) => x.status === 'PENDING_RATE' && x.countryId === c.countryId && x.srcCurrency === c.srcCurrency && x.bizDate === c.bizDate)) {
    closeTodo(rateTodoKey(c.countryId, c.srcCurrency, c.bizDate), '汇率已补齐并确认成本')
  }
  audit(ctx, '确认入库成本', 'inbound-cost', c.id, null, { batchNo: c.batchNo, rate: c.rate, rateDate: c.rateDate, unitCost: c.unitCost })
  return c
}

/** One valuation source for profit and vouchers. Physical batch allocations remain intact. */
function costOfBatch(batchId: number, productId: number) {
  return getDb().inboundCosts.find(c => c.batchId === batchId && c.productId === productId)
}

export function lineCost(line: Row) {
  if (line.costSnapshot) return line.costSnapshot
  const parts = (line.batches?.length ? line.batches : [{ batchId: line.batchId, qty: line.qty }]).map((part: Row) => {
    const cost = costOfBatch(part.batchId, line.productId)
    return { batchId: part.batchId, qty: num(part.qty), unitCost: cost?.unitCost ?? null, costId: cost?.id, estimated: cost?.status === 'ESTIMATED' }
  })
  return {
    parts, amount: round(sum(parts, (part: Row) => num(part.qty) * num(part.unitCost))),
    missing: parts.some((part: Row) => part.unitCost == null) || Math.abs(sum(parts, (part: Row) => num(part.qty)) - num(line.qty)) > 0.0001,
    estimated: true, legacy: true,
  }
}

export function captureOutboundCost(ctx: Ctx, ob: Row) {
  const db = getDb()
  const book = db.books.find(b => b.countryId === ctx.countryId && b.status === 'ACTIVE')
  const config = db.cstMethods.find(m => m.bookId === book?.id && m.status === 'ACTIVE')
  const method = config?.method ?? 'FIFO'
  for (const line of ob.lines ?? []) {
    if (line.costSnapshot && !line.costSnapshot.missing) continue
    const previous = line.costSnapshot
    const parts = (line.batches?.length ? line.batches : [{ batchId: line.batchId, qty: line.qty }]).map((part: Row) => {
      const saved = previous?.parts.find((p: Row) => p.batchId === part.batchId)
      if (saved?.unitCost != null) return saved
      const cost = costOfBatch(part.batchId, line.productId)
      return { batchId: part.batchId, qty: num(part.qty), unitCost: cost?.unitCost ?? null, costId: cost?.id ?? null, costVersion: cost?.versionNo ?? cost?.confirmedAt ?? cost?.status, estimated: cost?.status === 'ESTIMATED' }
    })
    let valuationParts: Row[] | undefined
    let valuationMissing = false
    if ((previous?.method ?? method) === 'MOVING_AVG') {
      const balances = db.invBatchBalances.filter(b => b.countryId === ob.countryId && b.warehouseId === ob.warehouseId && b.productId === line.productId)
      const quantities = new Map<number, number>()
      for (const b of balances) quantities.set(b.batchId, num(b.onHandQty))
      for (const sibling of ob.lines.filter((l: Row) => l.productId === line.productId)) {
        for (const p of sibling.batches?.length ? sibling.batches : [{ batchId: sibling.batchId, qty: sibling.qty }]) {
          quantities.set(p.batchId, (quantities.get(p.batchId) ?? 0) + num(p.qty))
        }
      }
      const basis = previous?.valuationParts ?? [...quantities].filter(([,qty]) => qty > 0).map(([batchId, qty]) => ({ batchId, qty, unitCost: costOfBatch(batchId, line.productId)?.unitCost ?? null }))
      valuationParts = basis.map((p: Row) => ({ ...p, unitCost: p.unitCost ?? costOfBatch(p.batchId, line.productId)?.unitCost ?? null }))
      valuationMissing = valuationParts!.some(p => p.unitCost == null)
      const qty = sum(valuationParts!, p => num(p.qty))
      if (!valuationMissing && qty > 0) {
        const average = round(sum(valuationParts!, p => num(p.qty) * num(p.unitCost)) / qty, 8)
        for (const p of parts) p.unitCost = average
      }
    }
    line.costSnapshot = {
      method: previous?.method ?? method, methodVersion: previous?.methodVersion ?? config?.versionNo ?? 0, parts, valuationParts, amount: round(sum(parts, (p: Row) => p.qty * num(p.unitCost))),
      missing: valuationMissing || parts.some((p: Row) => p.unitCost == null) || Math.abs(sum(parts, (p: Row) => p.qty) - num(line.qty)) > 0.0001,
      estimated: parts.some((p: Row) => p.estimated), capturedAt: previous?.capturedAt ?? nowIso(),
    }
    for (const part of parts) {
      const txn = db.invTxns.find(t => t.sourceType === 'SAL_OUTBOUND' && t.sourceId === ob.id && t.sourceLineId === line.id && t.batchId === part.batchId)
      if (txn && txn.unitCost == null) txn.unitCost = part.unitCost
    }
  }
}

export function outboundCost(ob: Row) {
  const snapshots = (ob.lines ?? []).map(lineCost)
  return { amount: round(sum(snapshots, (s: Row) => num(s.amount))), missing: snapshots.some((s: Row) => s.missing), estimated: snapshots.some((s: Row) => s.estimated) }
}

export function costAtDate(cost: Row, cutoff: string): number | null {
  if (cost.unitCost == null) return null
  const history: Row[] = cost.valuationHistory ?? []
  const initial = cost.initialUnitCost ?? num(cost.unitCost) - sum(history, change => num(change.unitDelta))
  return initial + sum(history.filter(change => change.bizDate <= cutoff), change => num(change.unitDelta))
}

function changeValuation(cost: Row, unitDelta: number, bizDate: string, sourceType: string, sourceId: number) {
  if (cost.initialUnitCost == null) cost.initialUnitCost = cost.unitCost
  cost.valuationHistory ??= []
  cost.valuationHistory.push({ bizDate, sourceType, sourceId, unitDelta, changedAt: nowIso() })
  cost.unitCost = round(num(cost.unitCost) + unitDelta, 8)
}

export function convertedAmount(countryId: number, currency: string, amount: number, date: string, scope = 'PURCHASE_COST') {
  const baseCurrency = activeBook(countryId)?.baseCurrency ?? country(countryId).defaultCurrency
  const rate = resolveRate(countryId, currency, baseCurrency, date, scope)
  if (!rate) bad(`缺少 ${date} 及之前已确认的 ${currency}→${baseCurrency} 汇率`, 'CST_RATE_MISSING')
  return { baseCurrency, baseAmount: round(amount * num(rate.rate)), rateId: rate.id, rate: rate.rate, rateDate: rate.rateDate }
}

/** Existing adjustment records are the only place for post-sale valuation differences. */
export function confirmCostAdjustment(ctx: Ctx, row: Row) {
  requireFieldAccess(ctx, 'COST')
  requireDataAccess(ctx, row)
  if (row.status === 'CONFIRMED') return row
  const date = row.bizDate || today(ctx.countryId!)
  assertPeriodOpen(ctx.countryId!, date)
  const batch = getDb().invBatches.find(b => b.id === Number(row.batchId) && b.countryId === ctx.countryId)
  if (!batch) bad('请选择本国有效批次')
  const cost = costOfBatch(batch.id, batch.productId)
  if (!cost || cost.unitCost == null) bad('批次成本尚不完整，不能调整', 'CST_COST_MISSING')
  const amount = Number(row.amount)
  if (!Number.isFinite(amount) || amount === 0) bad('调整金额必须是非零有效金额')
  if (row.target === 'INVENTORY') {
    const remaining = sum(getDb().invBatchBalances.filter(b => b.batchId === batch.id), b => num(b.onHandQty))
    if (!(remaining > 0)) bad('此批次已无库存，请调整已售成本')
    if (num(cost.unitCost) + amount / remaining < 0) bad('调整后批次单位成本不能为负')
    cost.unitCostAdjustment = num(cost.unitCostAdjustment) + amount / remaining
    row.unitCostDelta = amount / remaining
    changeValuation(cost, row.unitCostDelta, date, 'COST_ADJUSTMENT', row.id)
    cost.status = 'ADJUSTED'
  } else if (row.target !== 'COGS') bad('成本调整对象不正确')
  Object.assign(row, { productId: batch.productId, bookId: activeBook(ctx.countryId!)?.id, periodId: periodOf(ctx.countryId!, date)?.id, bizDate: date, status: 'CONFIRMED', confirmedAt: nowIso(), confirmedBy: ctx.user.id })
  audit(ctx, '确认成本调整', 'cost-adjustment', row.id, null, { target: row.target, amount, periodId: row.periodId })
  return row
}

function applyBatchCostDelta(ctx: Ctx, alloc: Row, cost: Row, unitDelta: number, visited = new Set<number>()) {
  const db = getDb()
  const date = alloc.bizDate || today(ctx.countryId!)
  if (visited.has(cost.batchId)) bad('退货成本来源出现循环')
  visited.add(cost.batchId)
  requireDataAccess(ctx, cost)
  if (cost.unitCost == null) bad('退货来源成本尚未补齐', 'CST_COST_MISSING')
  if (num(cost.unitCost) + unitDelta < 0) bad('分摊后批次成本不能为负')
  const affected = db.salOutbounds.filter(o => o.countryId === ctx.countryId && o.status === 'OUTBOUNDED' && o.lines.some((l: Row) => l.batches?.some((p: Row) => p.batchId === cost.batchId)))
  for (const ob of affected) captureOutboundCost(ctx, ob)
  let sold = 0
  let returned = 0
  for (const ob of affected) {
    for (const line of ob.lines) {
      const consumed = sum(line.batches ?? [], (p: Row) => p.batchId === cost.batchId ? num(p.qty) : 0)
      sold += consumed
      if (!(consumed > 0) || !(line.qty > 0)) continue
      for (const child of db.inboundCosts.filter(c => c.countryId === ctx.countryId && c.sourceType === 'RETURN' && c.sourceOutboundLineId === line.id)) {
        const ratio = consumed / line.qty
        returned += num(child.qty) * ratio
        applyBatchCostDelta(ctx, alloc, child, unitDelta * ratio, new Set(visited))
        child.unitCostAdjustment = num(child.unitCostAdjustment) + unitDelta * ratio
      }
    }
  }
  changeValuation(cost, unitDelta, date, 'FEE_ALLOCATION', alloc.id)
  cost.status = ['CONFIRMED', 'ADJUSTED'].includes(cost.status) ? 'ADJUSTED' : cost.status
  const cogs = round(unitDelta * Math.max(0, Math.min(num(cost.qty), sold - returned)))
  if (cogs) {
    db.costAdjustments.push({ id: nextId(), countryId: ctx.countryId, warehouseId: cost.warehouseId, bookId: activeBook(ctx.countryId!)?.id, periodId: periodOf(ctx.countryId!, date)?.id, bizDate: date, docNo: docNo(ctx.countryId!, 'CA', date), target: 'COGS', batchId: cost.batchId, productId: cost.productId, amount: cogs, sourceType: 'FEE_ALLOCATION', sourceId: alloc.id, reason: cogs > 0 ? '费用分摊已售部分' : '撤销费用分摊已售部分', status: 'CONFIRMED', confirmedBy: ctx.user.id, confirmedAt: nowIso() })
  }
}

export function applyCapitalizedAllocation(ctx: Ctx, alloc: Row, sign: number) {
  assertPeriodOpen(ctx.countryId!, alloc.bizDate || today(ctx.countryId!))
  for (const line of alloc.lines ?? []) {
    const cost = costOfBatch(line.batchId, line.productId)
    if (!cost || !(cost.qty > 0) || cost.unitCost == null) bad('请先补齐批次成本，再确认费用分摊', 'CST_COST_MISSING')
    const delta = sign * num(line.amount)
    applyBatchCostDelta(ctx, alloc, cost, delta / cost.qty)
    cost.allocFeeAmount = round(num(cost.allocFeeAmount) + delta)
  }
}

export function createBatchCost(ctx: Ctx, batch: Row, input: { warehouseId: number; qty: number; unitCost?: number | null; bizDate: string; sourceOutboundLineId?: number; sourceType?: string }) {
  const known = input.unitCost != null && Number.isFinite(input.unitCost) && input.unitCost >= 0
  const currency = activeBook(ctx.countryId!)?.baseCurrency ?? country(ctx.countryId!).defaultCurrency
  const amount = known ? round(input.qty * input.unitCost!) : null
  const cost = {
    id: nextId(), countryId: ctx.countryId, bookId: activeBook(ctx.countryId!)?.id, batchId: batch.id, batchNo: batch.batchNo,
    productId: batch.productId, warehouseId: input.warehouseId, qty: input.qty, bizDate: input.bizDate,
    srcCurrency: currency, baseCurrency: currency, srcUnitPrice: known ? input.unitCost : null, srcAmount: amount,
    basePurchaseAmount: amount, confirmedBasePurchaseAmount: amount, confirmedAllocFeeAmount: 0, allocFeeAmount: 0,
    unitCost: known ? input.unitCost : null, rate: 1, rateId: null, rateDate: input.bizDate,
    status: known ? 'CONFIRMED' : 'PENDING_SOURCE_COST', sourceType: input.sourceType ?? 'RETURN', sourceOutboundLineId: input.sourceOutboundLineId,
    confirmedAt: known ? nowIso() : null, confirmedBy: known ? ctx.user.id : null, createdAt: nowIso(),
  }
  getDb().inboundCosts.push(cost)
  batch.costId = cost.id
  return cost
}

/** Replace an allocated estimate using its original ratios; never capitalize both totals. */
export function reconcileActualFee(ctx: Ctx, fee: Row) {
  const db = getDb()
  const date = fee.bizDate || today(ctx.countryId!)
  let current: ReturnType<typeof convertedAmount>
  try {
    current = convertedAmount(ctx.countryId!, fee.currency, num(fee.amount), date)
  } catch (error) {
    if ((error as { code?: string }).code !== 'CST_RATE_MISSING') throw error
    Object.assign(fee, { costStatus: 'PENDING_RATE', baseAmount: null, baseCurrency: activeBook(ctx.countryId!)?.baseCurrency ?? country(ctx.countryId!).defaultCurrency })
    openTodo({ countryId: ctx.countryId!, todoType: 'PENDING_COST_RATE', dedupKey: `FEE_RATE:${ctx.countryId}:${fee.id}`, title: `${fee.docNo || fee.id} 费用待补汇率`, link: '/logistics/fees', perm: 'cst:allocation:create' })
    return
  }
  Object.assign(fee, current)
  fee.costStatus = 'READY'
  closeTodo(`FEE_RATE:${ctx.countryId}:${fee.id}`, '费用汇率已补齐')
  if (!fee.estimateFeeId) return
  const estimate = db.lgsFees.find(f => f.id === fee.estimateFeeId && f.countryId === ctx.countryId)
  if (!estimate) bad('关联暂估费用不存在')
  const originalBase = estimate.baseAmount ?? convertedAmount(ctx.countryId!, estimate.currency, num(estimate.amount), estimate.bizDate || date).baseAmount
  fee.deltaBaseAmount = round(current.baseAmount - originalBase)
  const previous = db.feeAllocations.find(a => a.feeId === estimate.id && a.status === 'CONFIRMED')
  if (!previous) return
  const weights = sum(previous.lines, (l: Row) => num(l.amount))
  if (!(weights > 0)) bad('原暂估分摊没有有效比例')
  const lines = previous.lines.map((l: Row) => ({ ...l, amount: round(current.baseAmount * num(l.amount) / weights) }))
  const largest = lines.reduce((a: Row, b: Row) => a.amount >= b.amount ? a : b)
  largest.amount = round(largest.amount + current.baseAmount - sum(lines, (l: Row) => num(l.amount)))
  const row: Row = { id: nextId(), countryId: ctx.countryId, bookId: previous.bookId, feeId: fee.id, feeNo: fee.docNo, basis: previous.basis, feeAmount: fee.amount, feeCurrency: fee.currency, ...current, bizDate: date, lines, replacesAllocationId: previous.id, deltaBaseAmount: fee.deltaBaseAmount, status: 'CONFIRMED', createdAt: nowIso() }
  const differences = lines.map((l: Row) => ({ ...l, amount: round(l.amount - num(previous.lines.find((p: Row) => p.batchId === l.batchId)?.amount)) }))
  applyCapitalizedAllocation(ctx, { ...row, lines: differences }, 1)
  previous.status = 'SUPERSEDED'
  previous.replacedById = row.id
  db.feeAllocations.unshift(row)
  audit(ctx, '实际费用替换暂估分摊', 'fee-allocation', row.id, { baseAmount: originalBase }, { baseAmount: current.baseAmount, deltaBaseAmount: fee.deltaBaseAmount })
}
