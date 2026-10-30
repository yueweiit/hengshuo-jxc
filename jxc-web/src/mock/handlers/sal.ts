/* eslint-disable @typescript-eslint/no-explicit-any */
/**
 * 07 销售与门店：代录、三级定价、分仓出库、签收。审批、履约、付款三种状态分开。
 */
import { http } from 'msw'
import { getDb, nextId, nowIso, type Row } from '../db'
import { API, findOr404 } from '../crud'
import { audit, canDataAccess, handle, hasPerm, inScope, paginate, requireDataAccess, requirePerm, type Ctx } from '../utils'
import { onApproval, submitApproval, cancelPendingApproval, invalidateApproval } from '../services/approval'
import { changeReserve, salesOutbound } from '../services/inventory'
import {
  assertSkuEnabled, bad, baseCcy, conflict, docNo, nameOf, num, round, sum, today, userName, warehouseOf, withProduct,
} from '../services/common'
import { assertPeriodOpen } from '../services/period'
import { captureOutboundCost } from '../services/cost'
import { canDocumentDataAccess, readableBusinessFields, readableSalesOrder } from '../services/access'
import {
  activeCreditRule, autoWriteoffFromPrepaid, cashReady, confirmedAllocated, createReceivableFromOutbound, evaluateCredit, releaseCredit, reserveCredit,
} from './ar'

function priceRows(countryId: number) {
  return getDb().salPrices.filter((p) => p.countryId === countryId && p.status === 'ACTIVE')
}

function matchPrice(rows: Row[], productId: number, unit: string, taxMode: string, qty: number, date: string) {
  return rows
    .filter((p) => p.productId === productId && p.unit === unit && p.taxMode === taxMode && p.minQty <= qty && p.effectiveFrom <= date && (!p.effectiveTo || p.effectiveTo >= date))
    .sort((a, b) => b.minQty - a.minQty || b.versionNo - a.versionNo)[0]
}

export function resolvePrice(countryId: number, customerId: number, productId: number, unit: string, qty: number, taxMode = 'INCL', date = today(countryId)) {
  const db = getDb()
  const customer = db.customers.find((c) => c.id === customerId)
  const all = priceRows(countryId)
  const hit = matchPrice(all.filter((p) => p.priceType === 'CUSTOMER' && p.customerId === customerId), productId, unit, taxMode, qty, date)
    ?? matchPrice(all.filter((p) => p.priceType === 'LEVEL' && p.levelId === customer?.levelId), productId, unit, taxMode, qty, date)
    ?? matchPrice(all.filter((p) => p.priceType === 'BASE'), productId, unit, taxMode, qty, date)
  if (!hit) return null
  const source = hit.priceType === 'CUSTOMER' ? 'CUSTOMER_SKU' : hit.priceType
  return { price: hit.price, stdPrice: hit.price, priceSource: source, priceRefId: hit.id, priceVersionNo: hit.versionNo, currency: hit.currency }
}

function lineAmount(qty: number, price: number, discountAmount = 0) {
  return round(qty * price - discountAmount)
}

function orderHash(o: Row) {
  return JSON.stringify({
    customerId: o.customerId, paymentType: o.paymentType,
    lines: o.lines.map((l: Row) => ({ id: l.id, qty: l.qty, price: l.price, allocs: l.allocs.map((a: Row) => [a.warehouseId, a.allocQty]) })),
  })
}

function refreshPayment(o: Row) {
  const paid = confirmedAllocated(o.id)
  o.paymentStatus = paid <= 0 ? 'UNPAID' : paid + 0.001 >= o.totalAmount ? 'PAID' : 'PARTIAL'
}

function refreshFulfillment(o: Row) {
  const lines = o.lines as Row[]
  const active = (l: Row) => l.baseQty - l.cancelledQty
  const outbound = sum(lines, (l) => l.outboundQty)
  const signed = sum(lines, (l) => l.signedQty)
  const left = sum(lines, (l) => active(l) - l.outboundQty)
  if (outbound <= 0) {
    const ready = getDb().attachments.some((a) => a.bizType === 'SAL_ORDER' && String(a.bizId) === String(o.id) && a.category === 'SALES_DOC' && a.status === 'ACTIVE')
    o.fulfillmentStatus = o.approvalStatus === 'APPROVED' ? (ready ? 'PENDING_OUTBOUND' : 'PENDING_PREPARE') : 'PENDING_PREPARE'
  } else if (left > 0) o.fulfillmentStatus = 'PARTIAL_OUTBOUND'
  else if (signed <= 0) o.fulfillmentStatus = 'OUTBOUNDED'
  else if (signed + 0.001 < outbound) o.fulfillmentStatus = 'PARTIAL_SIGNED'
  else o.fulfillmentStatus = 'SIGNED'
}

function orderOut(o: Row, _ctx?: Ctx) {
  refreshPayment(o)
  refreshFulfillment(o)
  const db = getDb()
  const result = {
    ...o,
    customerName: nameOf(db.customers, o.customerId),
    storeName: nameOf(db.stores, o.storeId),
    salespersonName: userName(o.salespersonId),
    enteredByName: userName(o.enteredBy),
    openQty: sum(o.lines, (l: Row) => l.baseQty - l.cancelledQty - l.outboundQty),
    lines: o.lines.map((l: Row) => ({
      ...withProduct(l),
      openQty: l.baseQty - l.cancelledQty - l.outboundQty,
      allocs: l.allocs.map((a: Row) => ({ ...a, warehouseName: nameOf(db.warehouses, a.warehouseId), openQty: a.allocQty - a.cancelledQty - a.outboundQty })),
    })),
  }
  return _ctx ? readableSalesOrder(_ctx, result) : result
}

function buildLines(ctx: Ctx, body: Row, customerId: number, previous: Row[] = [], preservePrices = true) {
  const taxMode = body.taxMode || 'INCL'
  const date = (body.orderDate || today(ctx.countryId!)).slice(0, 10)
  const lines = (body.lines ?? []).filter((l: Row) => num(l.qty) > 0).map((l: Row, i: number) => {
    const old = previous.find((x) => l.id != null ? x.id === Number(l.id) : x.productId === Number(l.productId) && previous.filter((y) => y.productId === x.productId).length === 1)
    const p = assertSkuEnabled(ctx.countryId!, Number(l.productId))
    const unit = l.unit || p.baseUnit
    const factor = p.units.find((u: Row) => u.unit === unit)?.factorToBase ?? 1
    const qty = num(l.qty)
    const keepPrice = old && preservePrices && old.productId === p.id && old.unit === unit && (l.price == null || num(l.price) === old.price) && num(l.discountAmount ?? old.discountAmount) === num(old.discountAmount)
    const resolved = keepPrice ? { price: old.price, stdPrice: old.stdPrice, priceSource: old.priceSource, priceRefId: old.priceRefId, priceVersionNo: old.priceVersionNo } : resolvePrice(ctx.countryId!, customerId, p.id, unit, qty, taxMode, date)
    const manual = l.manualPriceFlag || (l.price != null && (!resolved || Number(l.price) !== resolved.price))
    if (!resolved && !l.manualPriceFlag && l.price == null) bad(`${p.productCode} 没有可用价格`, 'SAL_PRICE_NOT_FOUND')
    if (manual && !keepPrice && !requireManual(ctx)) bad('人工改价需要 sal:order:manual-price 权限', 'SYS_FORBIDDEN')
    const price = manual ? round(num(l.price)) : resolved!.price
    if (price < 0 || num(l.discountAmount) < 0 || num(l.discountAmount) > qty * price) bad('单价、折扣金额不合法')
    const baseQty = qty * factor
    if (old && baseQty < num(old.outboundQty) + num(old.cancelledQty)) bad('数量不能低于已出库与已取消数量')
    if (old && (old.productId !== p.id || old.unit !== unit) && (old.outboundQty > 0 || old.cancelledQty > 0)) bad('已履约行不能更换商品或单位')
    const allocs = (l.allocs?.length ? l.allocs : [{ warehouseId: l.warehouseId ?? body.warehouseId, allocQty: baseQty }])
      .filter((a: Row) => num(a.allocQty) > 0)
      .map((a: Row) => {
        const prior = old?.allocs.find((x: Row) => a.id != null ? x.id === Number(a.id) : x.warehouseId === Number(a.warehouseId))
        if (prior && (prior.warehouseId !== Number(a.warehouseId) || num(a.allocQty) < num(prior.outboundQty) + num(prior.cancelledQty))) bad('分仓数量不能低于该仓已出库与已取消数量')
        return { id: prior?.id ?? nextId(), warehouseId: Number(a.warehouseId), allocQty: num(a.allocQty), outboundQty: num(prior?.outboundQty), cancelledQty: num(prior?.cancelledQty) }
      })
    if (new Set(allocs.map((a: Row) => a.warehouseId)).size !== allocs.length) bad('同一商品的发货仓不能重复')
    if (old?.allocs.some((a: Row) => (a.outboundQty > 0 || a.cancelledQty > 0) && !allocs.some((x: Row) => x.id === a.id))) bad('不能删除已有履约记录的分仓')
    if (!allocs.length) bad(`${p.productCode} 请指定发货仓`)
    if (round(sum(allocs, (a: Row) => a.allocQty)) !== baseQty) bad(`${p.productCode} 分仓数量须等于行数量`)
    for (const a of allocs) warehouseOf(ctx.countryId!, a.warehouseId)
    return {
      id: old?.id ?? nextId(), lineNo: i + 1, productId: p.id, unit, qty, baseQty, price, stdPrice: resolved?.stdPrice ?? price,
      priceSource: manual ? 'MANUAL' : resolved!.priceSource, priceRefId: resolved?.priceRefId ?? null, priceVersionNo: resolved?.priceVersionNo ?? 0,
      manualPriceFlag: keepPrice ? !!old.manualPriceFlag : !!manual, discountAmount: round(num(l.discountAmount ?? old?.discountAmount)), taxRate: num(l.taxRate ?? old?.taxRate),
      lineAmount: lineAmount(qty, price, num(l.discountAmount ?? old?.discountAmount)), cancelledQty: num(old?.cancelledQty), outboundQty: num(old?.outboundQty), signedQty: num(old?.signedQty), returnedQty: num(old?.returnedQty), allocs,
    }
  })
  if (!lines.length) bad('请至少添加一行商品')
  return lines
}

function requireManual(ctx: Ctx) {
  return requirePermSafe(ctx, 'sal:order:manual-price')
}

function requirePermSafe(ctx: Ctx, code: string) {
  try {
    requirePerm(ctx, code)
    return true
  } catch {
    return false
  }
}

function totals(lines: Row[]) {
  return { totalQty: sum(lines, (l) => l.baseQty - num(l.cancelledQty)), totalAmount: round(sum(lines, (l) => l.lineAmount * (l.baseQty - num(l.cancelledQty)) / l.baseQty)) }
}

const unshippedAmount = (o: Row) => round(sum(o.lines, (l: Row) => Math.max(0, l.baseQty - l.cancelledQty - l.outboundQty) * l.lineAmount / l.baseQty))

export function createSalesOrder(ctx: Ctx, body: Row) {
  requirePerm(ctx, 'sal:order:create')
  const db = getDb()
  const customer = db.customers.find((c) => c.id === Number(body?.customerId) && c.countryId === ctx.countryId && c.status === 'ENABLED')
  if (!customer) bad('请选择启用的客户')
  const paymentType = body.paymentType || 'CASH'
  if (!['CASH', 'CREDIT'].includes(paymentType)) bad('请选择现款或赊销')
  const orderDate = (body.orderDate || today(ctx.countryId!)).slice(0, 10)
  assertPeriodOpen(ctx.countryId!, orderDate)
  const lines = buildLines(ctx, body, customer.id)
  const storeId = body.storeId ?? customer.storeId ?? null
  const entity = db.entities.find((e) => e.countryId === ctx.countryId)
  const o: Row = {
    id: nextId(), countryId: ctx.countryId, docNo: docNo(ctx.countryId!, 'SO', orderDate), entityId: entity?.id ?? null, storeId,
    salespersonId: body.salespersonId ?? customer.salesOwnerId ?? ctx.user.id, enteredBy: ctx.user.id, salesSource: body.salesSource || (storeId ? 'STORE' : 'SALESPERSON'),
    customerId: customer.id, shipAddress: body.shipAddress || customer.addresses?.find((a: Row) => a.isDefault) || customer.addresses?.[0] || null,
    currency: baseCcy(ctx.countryId!), taxMode: body.taxMode || 'INCL', paymentType, creditRuleVersionId: null, termDays: null, dueBasis: null,
    deliveryDate: body.deliveryDate || null, ...totals(lines), approvalStatus: 'DRAFT', fulfillmentStatus: 'PENDING_PREPARE', paymentStatus: 'UNPAID',
    approvalInstanceId: null, approvedHash: '', docVersion: 1, remark: body.remark ?? '', lines, version: 1, createdAt: nowIso(),
  }
  requireDataAccess(ctx, o)
  db.salOrders.unshift(o)
  audit(ctx, '新增销售订单', 'sales-order', o.id, null, { docNo: o.docNo })
  return (body.submit ? submitSalesOrder(ctx, o) : o) as Row
}

function applyApproved(ctx: Ctx, o: Row) {
  o.approvalStatus = 'APPROVED'
  o.approvedHash = orderHash(o)
  o.approvedAt = nowIso()
  o.creditExceptionApproved = !!o.creditEvaluation?.requiresApproval && getDb().approvalInstances.some((i) => i.id === o.approvalInstanceId && i.status === 'APPROVED')
  o.creditExceptionRuleId = o.creditExceptionApproved ? o.creditEvaluation.ruleId : null
  for (const l of o.lines) {
    for (const a of l.allocs) {
      const open = a.allocQty - a.cancelledQty - a.outboundQty
      if (open > 0) changeReserve(a.warehouseId, l.productId, open)
    }
  }
  if (o.paymentType === 'CREDIT') {
    const rule = evaluateCredit(ctx.countryId!, o.customerId, 'CREDIT', unshippedAmount(o), 'ORDER')
    o.creditRuleVersionId = rule.ok ? activeCreditRule(ctx.countryId!, o.customerId)?.id ?? null : null
    reserveCredit(ctx.countryId!, o.customerId, o.id, unshippedAmount(o))
  }
  refreshFulfillment(o)
}

export function submitSalesOrder(ctx: Ctx, o: Row) {
  requirePerm(ctx, 'sal:order:submit')
  if (!['DRAFT', 'REJECTED', 'WITHDRAWN'].includes(o.approvalStatus)) conflict('当前状态不能提交')
  let creditFacts = { overLimit: false, overdue: false, requiresApproval: false }
  if (o.paymentType === 'CREDIT') {
    const credit = evaluateCredit(ctx.countryId!, o.customerId, 'CREDIT', unshippedAmount(o), 'ORDER')
    if (!credit.ok) bad(credit.message, credit.code)
    creditFacts = { overLimit: !!credit.overLimit, overdue: !!credit.overdue, requiresApproval: !!credit.requiresApproval }
  }
  o.creditEvaluation = { ...creditFacts, ruleId: activeCreditRule(ctx.countryId!, o.customerId)?.id ?? null }
  o.creditExceptionApproved = false
  cancelPendingApproval('SALES_ORDER', o.id)
  const res = submitApproval(ctx, {
    docType: 'SALES_ORDER', docId: o.id, docNo: o.docNo, docTitle: `${nameOf(getDb().customers, o.customerId)} · ${o.paymentType === 'CREDIT' ? '赊销' : '现款'}`,
    amount: o.totalAmount, currency: o.currency, facts: { amount: o.totalAmount, paymentType: o.paymentType, manualPrice: o.lines.some((l: Row) => l.manualPriceFlag), overLimit: creditFacts.overLimit, overdue: creditFacts.overdue }, forceRequired: creditFacts.requiresApproval,
  })
  o.approvalInstanceId = res.instance?.id ?? null
  if (res.status === 'APPROVED') applyApproved(ctx, o)
  else o.approvalStatus = 'PENDING'
  o.version += 1
  audit(ctx, '提交销售订单', 'sales-order', o.id, null, { approval: res.message })
  return { ...orderOut(o, ctx), approvalMessage: res.message }
}

onApproval('SALES_ORDER', {
  onApproved: (inst, ctx) => {
    const o = getDb().salOrders.find((x) => x.id === inst.docId)
    if (o?.approvalStatus === 'PENDING') applyApproved(ctx, o)
  },
  onRejected: (inst) => {
    const o = getDb().salOrders.find((x) => x.id === inst.docId)
    if (o?.approvalStatus === 'PENDING') o.approvalStatus = 'REJECTED'
  },
  onWithdrawn: (inst) => {
    const o = getDb().salOrders.find((x) => x.id === inst.docId)
    if (o?.approvalStatus === 'PENDING') o.approvalStatus = 'WITHDRAWN'
  },
})

export function outboundCheck(ctx: Ctx, o: Row, warehouseId: number, lines: { allocId: number; qty: number }[], explain = false) {
  const checks: { item: string; ok: boolean; code?: string; message: string; payment?: Row }[] = []
  const approved = o.approvalStatus === 'APPROVED' && o.approvedHash === orderHash(o)
  checks.push({ item: '审批有效', ok: approved, code: approved ? undefined : 'WF_APPROVAL_INVALIDATED', message: approved ? '审批通过且关键字段未改' : '审批未通过或已因修改失效' })
  const doc = getDb().attachments.some((a) => a.bizType === 'SAL_ORDER' && String(a.bizId) === String(o.id) && a.category === 'SALES_DOC' && a.status === 'ACTIVE')
  checks.push({ item: '销售单据', ok: doc, code: doc ? undefined : 'SAL_ATTACHMENT_MISSING', message: doc ? '已上传销售单据' : '缺少销售单据附件' })
  const thisAmount = round(sum(lines, (x) => {
    const alloc = o.lines.flatMap((l: Row) => l.allocs.map((a: Row) => ({ ...a, unitAmount: l.lineAmount / l.baseQty }))).find((a: Row) => a.id === x.allocId)
    return alloc ? x.qty * alloc.unitAmount : 0
  }))
  const shippedAmount = round(sum(getDb().salOutbounds.filter((ob) => ob.orderId === o.id && ob.status !== 'DRAFT'), (ob) => sum(ob.lines, (l: Row) => l.amount)))
  if (o.paymentType === 'CASH') {
    const ready = cashReady(o.id, o.customerId)
    const covered = confirmedAllocated(o.id) + 0.001 >= shippedAmount + thisAmount
    const amountsVisible = Object.hasOwn(readableSalesOrder(ctx, o), 'totalAmount')
    const payment: Row = { currency: o.currency, amountsVisible, canManageReceipts: hasPerm(ctx, ['ar:receipt:create', 'ar:receipt:confirm']) }
    if (amountsVisible) Object.assign(payment, { outboundAmount: thisAmount, shippedAmount, requiredAmount: round(shippedAmount + thisAmount), confirmedAmount: confirmedAllocated(o.id), shortageAmount: round(Math.max(shippedAmount + thisAmount - confirmedAllocated(o.id), 0)), pendingAmount: sum(getDb().arReceipts.filter(receipt => receipt.countryId === ctx.countryId && receipt.customerId === o.customerId && receipt.status === 'PENDING_CONFIRM' && canDocumentDataAccess(ctx, 'AR_RECEIPT', receipt)), receipt => sum((receipt.orders ?? []).filter((allocation: Row) => allocation.orderId === o.id), (allocation: Row) => num(allocation.plannedAmount))) })
    checks.push({ item: '现款到账', ok: covered, code: covered ? undefined : 'SAL_PAYMENT_NOT_CONFIRMED', message: covered ? '已确认到账覆盖本次出库' : '本单已确认并分配的收款不足', ...(explain ? { payment } : {}) })
    checks.push({ item: '收款凭证', ok: ready, code: ready ? undefined : 'SAL_PAYMENT_EVIDENCE_REQUIRED', message: ready ? '收款证据有效' : '缺少有效收款凭证或已确认现金收款记录' })
  } else {
    const credit = evaluateCredit(ctx.countryId!, o.customerId, 'CREDIT', thisAmount, 'OUTBOUND', o.id)
    const exceptionApproved = !credit.requiresApproval || (o.creditExceptionApproved && o.creditExceptionRuleId === activeCreditRule(ctx.countryId!, o.customerId)?.id)
    const ok = credit.ok && exceptionApproved
    checks.push({ item: '赊销额度', ok, code: ok ? undefined : (credit.code || 'AR_CREDIT_BLOCKED'), message: exceptionApproved ? credit.message : '须先完成当前授信规则下的例外审批' })
  }
  const scoped = inScope(ctx, { warehouseId }, { warehouseField: 'warehouseId' })
  checks.push({ item: '仓库权限', ok: scoped, code: scoped ? undefined : 'SYS_FORBIDDEN', message: scoped ? '有该仓数据范围' : '没有该出库仓的权限' })
  let qtyOk = true
  let qtyMsg = '未超过未出库数量'
  for (const x of lines) {
    const alloc = o.lines.flatMap((l: Row) => l.allocs).find((a: Row) => a.id === x.allocId)
    const open = alloc ? alloc.allocQty - alloc.cancelledQty - alloc.outboundQty : 0
    if (!alloc || x.qty > open) {
      qtyOk = false
      qtyMsg = `出库数量超过未出库 ${open}`
    }
  }
  checks.push({ item: '出库数量', ok: qtyOk && lines.length > 0, code: qtyOk ? undefined : 'SAL_QTY_EXCEEDED', message: lines.length ? qtyMsg : '请填写出库数量' })
  return checks
}

export function confirmOutbound(ctx: Ctx, ob: Row, body: Row) {
  requirePerm(ctx, 'sal:outbound:confirm')
  requireDataAccess(ctx, ob)
  const key = ctx.request.headers.get('Idempotency-Key')
  const db = getDb()
  if (key && db.idempotency[key]) {
    const prev = db.salOutbounds.find((x) => x.id === db.idempotency[key])
    if (prev && prev.id === ob.id) return { ...outboundOut(prev, ctx), duplicate: true }
    if (prev) bad('幂等键已用于另一张出库单')
  }
  if (ob.status !== 'DRAFT') return { ...outboundOut(ob, ctx), duplicate: true }
  const o = db.salOrders.find((x) => x.id === ob.orderId)!
  const req = ob.lines.map((l: Row) => ({ allocId: l.allocId, qty: l.qty }))
  const checks = outboundCheck(ctx, o, ob.warehouseId, req)
  const failed = checks.find((c) => !c.ok)
  ob.checkResult = checks
  if (failed) bad(failed.message, failed.code)
  const bizDate = body?.bizDate || today(ctx.countryId!)
  assertPeriodOpen(ctx.countryId!, bizDate)
  for (const line of ob.lines) {
    const ol = o.lines.find((l: Row) => l.id === line.orderLineId)
    const alloc = ol.allocs.find((a: Row) => a.id === line.allocId)
    const allocs = salesOutbound(ctx, { warehouseId: ob.warehouseId, productId: ol.productId, qty: line.qty, source: { type: 'SAL_OUTBOUND', id: ob.id, lineId: line.id, no: ob.docNo }, bizDate })
    line.batches = allocs
    line.batchId = allocs[0]?.batchId ?? null
    alloc.outboundQty += line.qty
    ol.outboundQty += line.qty
  }
  ob.bizDate = bizDate
  captureOutboundCost(ctx, ob)
  const amount = round(sum(ob.lines, (l: Row) => l.amount))
  const receivable = createReceivableFromOutbound(ctx, { customerId: o.customerId, orderId: o.id, outboundId: ob.id, amount, bizDate, paymentType: o.paymentType })
  if (o.paymentType === 'CASH') autoWriteoffFromPrepaid(ctx, o.id, receivable)
  Object.assign(ob, { status: 'OUTBOUNDED', outboundAt: nowIso(), bizDate, operatorId: ctx.user.id, carrier: body?.carrier ?? ob.carrier, trackingNo: body?.trackingNo ?? '', driver: body?.driver ?? '', receivableId: receivable.id, version: ob.version + 1 })
  for (const line of ob.lines) line.receivableId = receivable.id
  refreshFulfillment(o)
  if (key) db.idempotency[key] = ob.id
  audit(ctx, '确认出库', 'sales-outbound', ob.id, null, { amount, receivable: receivable.docNo })
  return outboundOut(ob, ctx)
}

function outboundOut(ob: Row, ctx?: Ctx) {
  const db = getDb()
  const o = db.salOrders.find((x) => x.id === ob.orderId)
  const result = {
    ...ob, orderNo: o?.docNo ?? '', customerName: nameOf(db.customers, o?.customerId), warehouseName: nameOf(db.warehouses, ob.warehouseId),
    operatorName: userName(ob.operatorId), totalQty: sum(ob.lines, (l: Row) => l.qty), totalAmount: round(sum(ob.lines, (l: Row) => l.amount)),
    lines: ob.lines.map((l: Row) => withProduct(l)),
  }
  return ctx ? readableBusinessFields(ctx, result) : result
}

function orderVisible(ctx: Ctx, o: Row) {
  return canDataAccess(ctx, o)
}

function findOrder(ctx: Ctx, id: number) {
  const o = findOr404(ctx, 'salOrders', id)
  requireDataAccess(ctx, o)
  return o
}

export const salHandlers = [
  http.get(`${API}/sal/prices/resolve`, handle((ctx) => {
    requirePerm(ctx, ['sal:order:create', 'sal:price:view'])
    const sp = ctx.url.searchParams
    const hit = resolvePrice(ctx.countryId!, Number(sp.get('customerId')), Number(sp.get('productId')), sp.get('unit') || '件', num(sp.get('qty') || 1), sp.get('taxMode') || 'INCL', sp.get('date') || today(ctx.countryId!))
    if (!hit) bad('没有匹配的价格', 'SAL_PRICE_NOT_FOUND')
    return hit
  })),
  http.get(`${API}/sal/prices`, handle((ctx) => {
    requirePerm(ctx, 'sal:price:view')
    const sp = ctx.url.searchParams
    const db = getDb()
    let rows = db.salPrices.filter((p) => p.countryId === ctx.countryId)
    if (sp.get('priceType')) rows = rows.filter((p) => p.priceType === sp.get('priceType'))
    if (sp.get('status')) rows = rows.filter((p) => p.status === sp.get('status'))
    return paginate(rows.map((p) => ({ ...withProduct(p), customerName: nameOf(db.customers, p.customerId), levelName: nameOf(db.customerLevels, p.levelId) })), ctx.url)
  })),
  http.post(`${API}/sal/prices`, handle((ctx, { body }) => savePrice(ctx, null, body))),
  http.put(`${API}/sal/prices/:id`, handle((ctx, { params, body }) => {
    const old = findOr404(ctx, 'salPrices', Number(params.id))
    old.status = 'RETIRED'
    old.effectiveTo = today(ctx.countryId!)
    return savePrice(ctx, old, { ...old, ...body, effectiveFrom: body.effectiveFrom || today(ctx.countryId!) })
  })),
  http.get(`${API}/sal/orders`, handle((ctx) => {
    requirePerm(ctx, 'sal:order:view')
    const sp = ctx.url.searchParams
    let rows = getDb().salOrders.filter((o) => o.countryId === ctx.countryId && orderVisible(ctx, o))
    for (const key of ['approvalStatus', 'fulfillmentStatus', 'paymentStatus', 'paymentType', 'customerId', 'storeId']) {
      if (sp.get(key)) rows = rows.filter((o) => String(o[key]) === sp.get(key))
    }
    if (sp.get('keyword')) {
      const k = sp.get('keyword')!.toLowerCase()
      rows = rows.filter((o) => o.docNo.toLowerCase().includes(k) || nameOf(getDb().customers, o.customerId).toLowerCase().includes(k))
    }
    return paginate(rows.map((o) => orderOut(o, ctx)), ctx.url)
  })),
  http.get(`${API}/sal/orders/:id`, handle((ctx, { params }) => {
    requirePerm(ctx, ['sal:order:view', 'sal:outbound:create', 'sal:outbound:confirm'])
    return orderOut(findOrder(ctx, Number(params.id)), ctx)
  })),
  http.post(`${API}/sal/orders`, handle((ctx, { body }) => orderOut(createSalesOrder(ctx, body), ctx))),
  http.put(`${API}/sal/orders/:id`, handle((ctx, { params, body }) => {
    requirePerm(ctx, ['sal:order:create', 'sal:order:edit'])
    const o = findOrder(ctx, Number(params.id))
    if (o.approvalStatus === 'PENDING') conflict('审批中不能修改，请先撤回')
    if (o.lines.some((l: Row) => l.outboundQty > 0) && (Number(body.customerId ?? o.customerId) !== o.customerId || (body.paymentType ?? o.paymentType) !== o.paymentType)) conflict('已有出库的订单不能更换客户或付款类型，请通过退货或关联调整处理')
    const lines = buildLines(ctx, { ...body, lines: body.lines ?? o.lines, taxMode: o.taxMode }, Number(body.customerId ?? o.customerId), o.lines, Number(body.customerId ?? o.customerId) === o.customerId)
    for (const old of o.lines) {
      const next = lines.find((l: Row) => l.id === old.id)
      if ((old.outboundQty > 0 || old.cancelledQty > 0) && (!next || next.baseQty < old.outboundQty + old.cancelledQty)) bad('已有出库或取消记录的行不能删除或改少')
      if (old.outboundQty > 0 && next && (next.price !== old.price || next.discountAmount !== old.discountAmount)) conflict('已出库行的成交价与折扣不能重写，请通过退货或关联调整处理')
    }
    if (o.approvalStatus === 'APPROVED') {
      for (const l of o.lines) for (const a of l.allocs) {
        const open = a.allocQty - a.cancelledQty - a.outboundQty
        if (open > 0) changeReserve(a.warehouseId, l.productId, -open)
      }
      if (o.paymentType === 'CREDIT') releaseCredit(o.id, o.totalAmount)
      invalidateApproval('SALES_ORDER', o.id, '修改了客户、数量、价格或付款条件')
      o.approvalStatus = 'DRAFT'
      o.approvedHash = ''
    }
    Object.assign(o, { customerId: Number(body.customerId ?? o.customerId), paymentType: body.paymentType ?? o.paymentType, deliveryDate: body.deliveryDate ?? o.deliveryDate, remark: body.remark ?? o.remark, lines, ...totals(lines), docVersion: o.docVersion + 1, version: o.version + 1 })
    audit(ctx, '修改销售订单', 'sales-order', o.id, null, { docVersion: o.docVersion })
    return orderOut(o, ctx)
  })),
  http.post(`${API}/sal/orders/:id/submit`, handle((ctx, { params }) => submitSalesOrder(ctx, findOrder(ctx, Number(params.id))))),
  http.post(`${API}/sal/orders/:id/withdraw`, handle((ctx, { params }) => {
    requirePerm(ctx, 'sal:order:submit')
    const o = findOrder(ctx, Number(params.id))
    if (o.approvalStatus !== 'PENDING') conflict('只有待审批的订单可以撤回')
    cancelPendingApproval('SALES_ORDER', o.id)
    o.approvalStatus = 'WITHDRAWN'
    return orderOut(o, ctx)
  })),
  http.post(`${API}/sal/orders/:id/cancel-lines`, handle((ctx, { params, body }) => {
    requirePerm(ctx, 'sal:order:create')
    const o = findOrder(ctx, Number(params.id))
    for (const it of body?.lines ?? []) {
      const l = o.lines.find((x: Row) => x.id === Number(it.lineId))
      if (!l) bad('订单行不存在')
      const open = l.baseQty - l.cancelledQty - l.outboundQty
      const qty = num(it.qty)
      if (qty <= 0 || qty > open) bad(`取消数量不能超过未出库 ${open}`)
      const base = qty
      if (o.approvalStatus === 'APPROVED') {
        let left = base
        for (const a of l.allocs) {
          const room = a.allocQty - a.cancelledQty - a.outboundQty
          const take = Math.min(room, left)
          if (take > 0) {
            changeReserve(a.warehouseId, l.productId, -take)
            a.cancelledQty += take
            left -= take
          }
        }
        if (o.paymentType === 'CREDIT') releaseCredit(o.id, round((qty / l.baseQty) * l.lineAmount))
      } else {
        let left = base
        for (const a of l.allocs) {
          const room = a.allocQty - a.cancelledQty - a.outboundQty
          const take = Math.min(room, left)
          a.cancelledQty += take
          left -= take
        }
      }
      l.cancelledQty += qty
    }
    Object.assign(o, totals(o.lines))
    refreshFulfillment(o)
    o.version += 1
    return orderOut(o, ctx)
  })),
  http.get(`${API}/sal/orders/:id/outbound-check`, handle((ctx, { params }) => {
    requirePerm(ctx, ['sal:outbound:create', 'sal:order:view'])
    const o = findOrder(ctx, Number(params.id))
    const warehouseId = Number(ctx.url.searchParams.get('warehouseId'))
    const lines = o.lines.flatMap((l: Row) => l.allocs.filter((a: Row) => a.warehouseId === warehouseId && a.allocQty - a.cancelledQty - a.outboundQty > 0).map((a: Row) => ({ allocId: a.id, qty: a.allocQty - a.cancelledQty - a.outboundQty })))
    return readableBusinessFields(ctx, { checks: outboundCheck(ctx, o, warehouseId, lines, true), lines })
  })),
  http.post(`${API}/sal/orders/:id/outbound-check`, handle((ctx, { params, body }) => {
    requirePerm(ctx, ['sal:outbound:create', 'sal:order:view'])
    const o = findOrder(ctx, Number(params.id))
    if (!Array.isArray(body.lines) || !body.lines.length) bad('请填写本次出库数量')
    return readableBusinessFields(ctx, { checks: outboundCheck(ctx, o, Number(body.warehouseId), body.lines, true), lines: body.lines })
  })),
  http.get(`${API}/sal/orders/:id/timeline`, handle((ctx, { params }) => {
    requirePerm(ctx, ['sal:order:view', 'sal:outbound:create', 'sal:outbound:confirm'])
    const o = findOrder(ctx, Number(params.id))
    const db = getDb()
    const items: Row[] = [{ at: o.createdAt, type: '建单', text: o.docNo }]
    for (const i of db.approvalInstances.filter((x) => x.docType === 'SALES_ORDER' && x.docId === o.id)) items.push({ at: i.submittedAt, type: '审批', text: `${i.ruleName} ${i.status}` })
    for (const ob of db.salOutbounds.filter((x) => x.orderId === o.id && canDocumentDataAccess(ctx, 'SAL_OUTBOUND', x))) items.push({ at: ob.outboundAt || ob.createdAt, type: '出库', text: `${ob.docNo} ${sum(ob.lines, (l: Row) => l.qty)} 件` })
    for (const s of db.salSigns.filter((x) => db.salOutbounds.some((ob) => ob.id === x.outboundId && ob.orderId === o.id && canDocumentDataAccess(ctx, 'SAL_OUTBOUND', ob)))) items.push({ at: s.signedAt, type: '签收', text: s.signerName })
    for (const r of db.arReceipts.filter((x) => canDocumentDataAccess(ctx, 'AR_RECEIPT', x) && (x.orders ?? []).some((a: Row) => a.orderId === o.id))) items.push({ at: r.createdAt, type: '收款', text: r.docNo, amount: r.amount })
    return items.sort((a, b) => String(a.at).localeCompare(String(b.at))).map((r) => readableBusinessFields(ctx, r))
  })),
  http.get(`${API}/sal/outbounds`, handle((ctx) => {
    requirePerm(ctx, ['sal:outbound:create', 'sal:outbound:confirm', 'sal:order:view'])
    const sp = ctx.url.searchParams
    let rows = getDb().salOutbounds.filter((o) => o.countryId === ctx.countryId && inScope(ctx, o, { warehouseField: 'warehouseId' }))
    if (sp.get('status')) rows = rows.filter((o) => o.status === sp.get('status'))
    if (sp.get('warehouseId')) rows = rows.filter((o) => o.warehouseId === Number(sp.get('warehouseId')))
    if (sp.get('orderId')) rows = rows.filter((o) => o.orderId === Number(sp.get('orderId')))
    return paginate(rows.map((r) => outboundOut(r, ctx)), ctx.url)
  })),
  http.post(`${API}/sal/outbounds`, handle((ctx, { body }) => {
    const ob = createOutbound(ctx, body)
    return body?.confirm ? confirmOutbound(ctx, ob, body) : outboundOut(ob, ctx)
  })),
  http.post(`${API}/sal/outbounds/:id/confirm`, handle((ctx, { params, body }) => confirmOutbound(ctx, findOr404(ctx, 'salOutbounds', Number(params.id), { scope: { warehouseField: 'warehouseId' } }), body))),
  http.post(`${API}/sal/outbounds/:id/sign`, handle((ctx, { params, body }) => {
    requirePerm(ctx, 'sal:sign:record')
    const ob = findOr404(ctx, 'salOutbounds', Number(params.id))
    requireDataAccess(ctx, ob)
    if (!['OUTBOUNDED', 'PARTIAL_SIGNED'].includes(ob.status)) conflict('只有已出库的单据可以签收')
    const o = getDb().salOrders.find((x) => x.id === ob.orderId)!
    const lines = ob.lines.map((l: Row) => {
      const input = (body.lines ?? []).find((x: Row) => x.outboundLineId === l.id)
      const signed = input ? num(input.signedQty) : l.qty
      if (signed < 0 || signed > l.qty) bad('签收数量不能超过出库数量')
      const diff = l.qty - signed
      return { outboundLineId: l.id, productId: l.productId, signedQty: signed, diffQty: diff, diffType: diff > 0 ? (input?.diffType || 'SHORT') : null, diffStatus: diff > 0 ? 'OPEN' : null, resolution: '' }
    })
    const sign: Row = { id: nextId(), countryId: ctx.countryId, outboundId: ob.id, signedAt: body?.signedAt || nowIso(), signerName: body?.signerName || '', remark: body?.remark ?? '', lines, createdBy: ctx.user.id }
    getDb().salSigns.unshift(sign)
    for (const sl of lines) {
      const ol = o.lines.find((l: Row) => l.id === ob.lines.find((x: Row) => x.id === sl.outboundLineId).orderLineId)
      ol.signedQty += sl.signedQty
    }
    const diff = lines.some((l: Row) => l.diffQty > 0)
    ob.status = diff ? 'DIFF_PENDING' : 'SIGNED'
    refreshFulfillment(o)
    audit(ctx, '签收', 'sales-outbound', ob.id, null, { signer: sign.signerName, diff })
    return { ...sign, lines: sign.lines.map(withProduct), outboundNo: ob.docNo }
  })),
  http.get(`${API}/sal/signs`, handle((ctx) => {
    requirePerm(ctx, ['sal:sign:record', 'sal:order:view'])
    const db = getDb()
    return paginate(db.salSigns.filter((s) => s.countryId === ctx.countryId && canDocumentDataAccess(ctx, 'SAL_OUTBOUND', db.salOutbounds.find((o) => o.id === s.outboundId) ?? {})).map((s) => {
      const ob = db.salOutbounds.find((o) => o.id === s.outboundId)
      return { ...s, outboundNo: ob?.docNo ?? '', orderNo: db.salOrders.find((o) => o.id === ob?.orderId)?.docNo ?? '', diffQty: sum(s.lines, (l: Row) => l.diffQty), lines: s.lines.map(withProduct) }
    }), ctx.url)
  })),
  http.post(`${API}/sal/sign-diffs/:id/resolve`, handle((ctx, { params, body }) => {
    requirePerm(ctx, 'sal:sign:record')
    const sign = getDb().salSigns.find((s) => s.lines.some((l: Row) => l.outboundLineId === Number(params.id)) || s.id === Number(params.id))
    if (!sign) bad('签收差异不存在')
    requireDataAccess(ctx, getDb().salOutbounds.find((o) => o.id === sign.outboundId) ?? {})
    const line = sign.lines.find((l: Row) => l.diffQty > 0 && (l.outboundLineId === Number(params.id) || sign.id === Number(params.id)))
    if (!line) bad('没有待处理差异')
    if (!body?.resolution) bad('请选择处理方式')
    line.resolution = body.resolution
    line.diffStatus = 'RESOLVED'
    return sign
  })),
  http.get(`${API}/sal/store-daily`, handle((ctx) => {
    requirePerm(ctx, 'sal:order:view')
    const sp = ctx.url.searchParams
    const date = sp.get('date') || today(ctx.countryId!)
    const storeId = sp.get('storeId') ? Number(sp.get('storeId')) : null
    const db = getDb()
    const orders = db.salOrders.filter((o) => o.countryId === ctx.countryId && o.createdAt.slice(0, 10) === date && (storeId == null || o.storeId === storeId) && inScope(ctx, o, { storeField: 'storeId' }))
    const outs = db.salOutbounds.filter((o) => o.countryId === ctx.countryId && canDocumentDataAccess(ctx, 'SAL_OUTBOUND', o) && o.bizDate === date && (storeId == null || db.warehouses.find((w) => w.id === o.warehouseId)?.storeId === storeId))
    const receipts = db.arReceipts.filter((r) => canDocumentDataAccess(ctx, 'AR_RECEIPT', r) && r.bizTime.slice(0, 10) === date && (storeId == null || r.storeId === storeId) && !['VOIDED', 'REJECTED'].includes(r.status))
    return {
      date, orderCount: orders.length, orderAmount: round(sum(orders, (o) => o.totalAmount)),
      outboundQty: sum(outs, (o) => sum(o.lines, (l: Row) => l.qty)), outboundAmount: round(sum(outs, (o) => sum(o.lines, (l: Row) => l.amount))),
      cash: round(sum(receipts.filter((r) => r.method === 'CASH'), (r) => r.amount)),
      transfer: round(sum(receipts.filter((r) => r.method === 'TRANSFER'), (r) => r.amount)),
      pendingConfirm: round(sum(receipts.filter((r) => r.status === 'PENDING_CONFIRM'), (r) => r.amount)),
    }
  })),
]

export function createOutbound(ctx: Ctx, body: Row) {
  requirePerm(ctx, 'sal:outbound:create')
  const o = findOrder(ctx, Number(body?.orderId))
  const warehouseId = Number(body.warehouseId)
  warehouseOf(ctx.countryId!, warehouseId)
  if (!inScope(ctx, { warehouseId }, { warehouseField: 'warehouseId' })) conflict('没有该出库仓的权限', 'SYS_FORBIDDEN')
  const lines = (body.lines ?? []).filter((l: Row) => num(l.qty) > 0).map((l: Row) => {
    const ol = o.lines.find((x: Row) => x.allocs.some((a: Row) => a.id === Number(l.allocId)))
    const alloc = ol?.allocs.find((a: Row) => a.id === Number(l.allocId))
    if (!ol || !alloc || alloc.warehouseId !== warehouseId) bad('分仓行不存在')
    const qty = num(l.qty)
    if (qty > alloc.allocQty - alloc.cancelledQty - alloc.outboundQty) bad('超过未出库数量', 'SAL_QTY_EXCEEDED')
    const unitPrice = ol.lineAmount / ol.baseQty
    return { id: nextId(), orderLineId: ol.id, allocId: alloc.id, productId: ol.productId, qty, price: round(unitPrice, 4), amount: round(qty * unitPrice), batches: [] }
  })
  if (!lines.length) bad('请填写出库数量')
  const ob: Row = {
    id: nextId(), countryId: ctx.countryId, docNo: docNo(ctx.countryId!, 'OB'), orderId: o.id, warehouseId, status: 'DRAFT',
    outboundAt: null, bizDate: null, operatorId: null, carrier: body.carrier ?? '', trackingNo: body.trackingNo ?? '', driver: body.driver ?? '',
    lines, checkResult: null, version: 1, createdAt: nowIso(),
  }
  getDb().salOutbounds.unshift(ob)
  return ob
}

export function savePrice(ctx: Ctx, previous: Row | null, body: Row) {
  requirePerm(ctx, 'sal:price:edit')
  const p = assertSkuEnabled(ctx.countryId!, Number(body?.productId ?? previous?.productId))
  if (!(num(body.price) > 0)) bad('价格必须大于 0')
  const type = body.priceType || previous?.priceType
  if (!['BASE', 'LEVEL', 'CUSTOMER'].includes(type)) bad('请选择价格类型')
  if (type === 'LEVEL' && !body.levelId && !previous?.levelId) bad('请选择客户等级')
  if (type === 'CUSTOMER' && !body.customerId && !previous?.customerId) bad('请选择客户')
  const row: Row = {
    id: nextId(), countryId: ctx.countryId, priceType: type, customerId: type === 'CUSTOMER' ? Number(body.customerId ?? previous?.customerId) : null,
    levelId: type === 'LEVEL' ? Number(body.levelId ?? previous?.levelId) : null, productId: p.id, unit: body.unit || p.baseUnit,
    taxMode: body.taxMode || 'INCL', minQty: num(body.minQty ?? previous?.minQty ?? 1) || 1, price: round(num(body.price), 4), currency: baseCcy(ctx.countryId!),
    effectiveFrom: body.effectiveFrom || today(ctx.countryId!), effectiveTo: body.effectiveTo || null, versionNo: (previous?.versionNo ?? 0) + 1,
    status: 'ACTIVE', createdBy: ctx.user.id, createdAt: nowIso(),
  }
  getDb().salPrices.unshift(row)
  audit(ctx, previous ? '价格新版本' : '新增价格', 'price', row.id, previous, row)
  return { ...withProduct(row) }
}
