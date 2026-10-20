/* eslint-disable @typescript-eslint/no-explicit-any */
/**
 * 10 退货与退款。销售退货按原成交价；实收验货后才动库存；退款不超过可退余额（A15、A17）。
 */
import { http } from 'msw'
import { getDb, nextId, nowIso, type Row } from '../db'
import { API, findOr404 } from '../crud'
import { audit, handle, notFound, paginate, requireDataAccess, requirePerm, type Ctx } from '../utils'
import { onApproval, submitApproval } from '../services/approval'
import { returnIn, supplierReturnOut } from '../services/inventory'
import { bad, baseCcy, conflict, docNo, nameOf, num, product, round, sum, today, userName, warehouseOf, withProduct } from '../services/common'
import { applyCreditNoteToOrder, consumeRefundable } from './ar'
import { createApCreditNote } from './ap'
import { lineCost } from '../services/cost'
import { canDocumentDataAccess, readableBusinessFields, requireDocumentAccess } from '../services/access'

function returnOut(r: Row, ctx?: Ctx) {
  const db = getDb()
  const result = {
    ...r, customerName: nameOf(db.customers, r.customerId), orderNo: db.salOrders.find((o) => o.id === r.orderId)?.docNo ?? '',
    outboundNo: db.salOutbounds.find((o) => o.id === r.outboundId)?.docNo ?? '', warehouseName: nameOf(db.warehouses, r.returnWarehouseId),
    lines: r.lines.map(withProduct),
  }
  return ctx ? readableBusinessFields(ctx, result) : result
}

function returnableQty(outboundLine: Row) {
  const delivered = outboundLine.qty
  const signed = getDb().salSigns.flatMap((s) => s.lines).find((l: Row) => l.outboundLineId === outboundLine.id)
  const base = signed && signed.diffType === 'REJECTED' ? signed.signedQty : delivered
  const pending = sum(getDb().rtnSales.filter((r) => !['REJECTED', 'CANCELLED'].includes(r.status)), (r) => sum(r.lines.filter((l: Row) => l.outboundLineId === outboundLine.id), (l: Row) => r.status === 'COMPLETED' ? l.receivedQty : l.reqQty))
  return round(base - pending, 4)
}

/** 按原收货行或原采购批次限制退供；未完成申请也占用可退数量。数量统一为基础单位。 */
function purchaseLineRemaining(po: Row, pl: Row, stage: string, excludeId?: number) {
  const returns = getDb().rtnPurchase.filter((r) => r.poId === po.id && r.stage === stage && r.id !== excludeId && r.status !== 'CANCELLED')
  const occupied = sum(returns, (r) => sum(r.lines.filter((l: Row) => l.poLineId === pl.id), (l: Row) => l.qty))
  return Math.max(0, (stage === 'DOMESTIC' ? num(pl.baseQty ?? pl.qty) - num(pl.cancelledQty) - num(pl.shippedQty) : num(pl.arrivedMxQty)) - occupied)
}

function purchaseSources(po: Row, stage: string, excludeId?: number): Row[] {
  const db = getDb()
  const pending = db.rtnPurchase.filter((r) => r.poId === po.id && r.id !== excludeId && !['COMPLETED', 'CANCELLED'].includes(r.status))
  const requested = (lineId: number, sourceId: number, key: string) => sum(pending.filter((r) => r.stage === stage), (r) => sum(r.lines.filter((l: Row) => l.poLineId === lineId && l[key] === sourceId), (l: Row) => l.qty))
  const result: Row[] = []
  for (const pl of po.lines) {
    const cap = purchaseLineRemaining(po, pl, stage, excludeId)
    if (stage === 'DOMESTIC') {
      for (const receipt of db.domesticReceipts.filter((r) => r.orderId === po.id && r.status === 'CONFIRMED')) {
        for (const source of receipt.lines.filter((l: Row) => l.orderLineId === pl.id)) {
          const available = num(source.qualifiedQty) + num(source.convertedQualifiedQty) - num(source.exportedQty) - num(source.returnedQty) - requested(pl.id, source.id, 'sourceLineId')
          result.push({ poLineId: pl.id, sourceLineId: source.id, sourceNo: receipt.docNo ?? po.docNo, productId: pl.productId, returnableQty: Math.max(0, Math.min(cap, available)) })
        }
      }
    } else {
      for (const cost of db.inboundCosts.filter((c) => c.poId === po.id && c.poLineId === pl.id)) {
        for (const stock of db.invBatchBalances.filter((b) => b.batchId === cost.batchId && b.productId === pl.productId)) {
          const available = num(stock.onHandQty) - num(stock.reservedQty) - num(stock.frozenQty) - requested(pl.id, cost.batchId, 'batchId')
          result.push({ poLineId: pl.id, batchId: cost.batchId, sourceNo: cost.batchNo, productId: pl.productId, warehouseId: stock.warehouseId, returnableQty: Math.max(0, Math.min(cap, available)) })
        }
      }
    }
  }
  return result
}

export const rtnHandlers = [
  http.get(`${API}/rtn/sales/returnable`, handle((ctx) => {
    requirePerm(ctx, ['rtn:sales:create', 'rtn:sales:receive'])
    const ob = findOr404(ctx, 'salOutbounds', Number(ctx.url.searchParams.get('outboundId')))
    requireDataAccess(ctx, ob)
    const order = getDb().salOrders.find((o) => o.id === ob.orderId)!
    return ob.lines.map((l: Row) => {
      const ol = order.lines.find((x: Row) => x.id === l.orderLineId)
      return { ...withProduct(l), outboundLineId: l.id, orderLineId: ol.id, unitPrice: l.price, returnableQty: Math.max(0, returnableQty(l)), originPrice: l.price }
    })
  })),
  http.get(`${API}/rtn/sales`, handle((ctx) => {
    requirePerm(ctx, ['rtn:sales:create', 'rtn:sales:receive', 'rtn:sales:settle'])
    const sp = ctx.url.searchParams
    let rows = getDb().rtnSales.filter((r) => canDocumentDataAccess(ctx, 'SALES_RETURN', r))
    if (sp.get('status')) rows = rows.filter((r) => r.status === sp.get('status'))
    return paginate(rows.map((r) => returnOut(r, ctx)), ctx.url)
  })),
  http.get(`${API}/rtn/sales/:id`, handle((ctx, { params }) => returnOut(requireDocumentAccess(ctx, 'SALES_RETURN', Number(params.id)), ctx))),
  http.post(`${API}/rtn/sales`, handle((ctx, { body }) => {
    requirePerm(ctx, 'rtn:sales:create')
    const db = getDb()
    const ob = db.salOutbounds.find((o) => o.id === Number(body?.outboundId) && o.countryId === ctx.countryId)
    if (!ob || ob.status === 'DRAFT') bad('请选择已出库的出库单')
    requireDataAccess(ctx, ob)
    const order = db.salOrders.find((o) => o.id === ob.orderId)!
    warehouseOf(ctx.countryId!, Number(body.returnWarehouseId))
    requireDataAccess(ctx, { countryId: ctx.countryId, warehouseId: Number(body.returnWarehouseId) })
    if (!body.reasonCode || !body.responsibility) bad('请填写退货原因和责任方')
    const lines = (body.lines ?? []).filter((l: Row) => num(l.reqQty) > 0).map((l: Row) => {
      const oln = ob.lines.find((x: Row) => x.id === Number(l.outboundLineId))
      if (!oln) bad('出库行不存在')
      const ol = order.lines.find((x: Row) => x.id === oln.orderLineId)
      const qty = num(l.reqQty)
      const cap = returnableQty(oln)
      if (qty - cap > 0.001) bad(`退货数量不能超过可退 ${cap}`)
      const unit = oln.amount / oln.qty
      return { id: nextId(), outboundLineId: oln.id, orderLineId: ol.id, productId: ol.productId, originBatchId: oln.batchId, reqQty: qty, receivedQty: 0, goodQty: 0, frozenQty: 0, freezeType: '', unitPrice: round(unit, 4), amount: round(qty * unit) }
    })
    if (!lines.length) bad('请填写退货数量')
    if (new Set(lines.map((l: Row) => l.outboundLineId)).size !== lines.length) bad('同一出库行不能重复申请')
    const row: Row = {
      id: nextId(), countryId: ctx.countryId, docNo: docNo(ctx.countryId!, 'SR'), orderId: order.id, outboundId: ob.id, customerId: order.customerId,
      returnWarehouseId: Number(body.returnWarehouseId), reasonCode: body.reasonCode, responsibility: body.responsibility, noOriginFlag: false,
      status: 'DRAFT', approvalInstanceId: null, settledFlag: false, lines, version: 1, createdAt: nowIso(),
    }
    db.rtnSales.unshift(row)
    return body.submit ? submitReturn(ctx, row) : returnOut(row, ctx)
  })),
  http.post(`${API}/rtn/sales/:id/submit`, handle((ctx, { params }) => submitReturn(ctx, requireDocumentAccess(ctx, 'SALES_RETURN', Number(params.id))))),
  http.post(`${API}/rtn/sales/:id/receive`, handle((ctx, { params, body }) => {
    requirePerm(ctx, 'rtn:sales:receive')
    const key = ctx.request.headers.get('Idempotency-Key')
    const db = getDb()
    if (key && db.idempotency[key]) return { ...returnOut(requireDocumentAccess(ctx, 'SALES_RETURN', Number(params.id)), ctx), duplicate: true }
    const r = requireDocumentAccess(ctx, 'SALES_RETURN', Number(params.id))
    requireDataAccess(ctx, { countryId: r.countryId, warehouseId: r.returnWarehouseId })
    if (r.status !== 'PENDING_RECEIPT') conflict('当前不是待实收')
    for (const line of r.lines) {
      const input = (body.lines ?? []).find((x: Row) => x.id === line.id)
      const qty = input ? num(input.receivedQty) : line.reqQty
      if (qty < 0 || qty > line.reqQty) bad('实收不能超过申请数量')
      if (qty < line.reqQty && !body?.shortReason && !input?.shortReason) bad('实收少于申请时请填写原因')
      line.receivedQty = qty
    }
    r.status = 'PENDING_INSPECT'
    r.receivedAt = body?.receivedAt || nowIso()
    r.version += 1
    if (key) db.idempotency[key] = r.id
    return returnOut(r, ctx)
  })),
  http.post(`${API}/rtn/sales/:id/inspect`, handle((ctx, { params, body }) => {
    requirePerm(ctx, 'rtn:sales:inspect')
    const key = ctx.request.headers.get('Idempotency-Key')
    const db = getDb()
    if (key && db.idempotency[`ins:${key}`]) return { ...returnOut(requireDocumentAccess(ctx, 'SALES_RETURN', Number(params.id)), ctx), duplicate: true }
    const r = requireDocumentAccess(ctx, 'SALES_RETURN', Number(params.id))
    requireDataAccess(ctx, { countryId: r.countryId, warehouseId: r.returnWarehouseId })
    if (r.status !== 'PENDING_INSPECT') conflict('当前不是待验货')
    const bizDate = body?.bizDate || today(ctx.countryId!)
    for (const line of r.lines) {
      const input = (body.lines ?? []).find((x: Row) => x.id === line.id) ?? {}
      const good = num(input.goodQty)
      const frozen = num(input.frozenQty)
      if (Math.abs(good + frozen - line.receivedQty) > 0.001) bad(`${product(line.productId)?.productCode} 合格加冻结须等于实收 ${line.receivedQty}`)
      const freezeType = frozen > 0 ? (input.freezeType || 'RETURN_PENDING') : ''
      if (good < 0 || frozen < 0 || !['', 'RETURN_PENDING', 'DAMAGED'].includes(freezeType)) bad('验货数量或冻结类型不合法')
      const original = db.salOutbounds.find((o) => o.id === r.outboundId)?.lines.find((l: Row) => l.id === line.outboundLineId)
      if (!original || !(original.qty > 0)) bad('原出库行不存在')
      const originalCost = lineCost(original)
      const unitCost = originalCost.missing ? null : originalCost.amount / original.qty
      if (line.receivedQty > 0) {
        returnIn(ctx, { warehouseId: r.returnWarehouseId, productId: line.productId, goodQty: good, frozenQty: frozen, freezeType, source: { type: 'SALES_RETURN', id: r.id, lineId: line.id, no: r.docNo }, bizDate, reason: `${r.docNo} 退货${freezeType}`, unitCost, sourceOutboundLineId: original.id })
      }
      Object.assign(line, { goodQty: good, frozenQty: frozen, freezeType, amount: round(line.receivedQty * line.unitPrice), costAmount: unitCost == null ? null : round(unitCost * line.receivedQty), costMissing: originalCost.missing })
      const ol = db.salOrders.find((o) => o.id === r.orderId)!.lines.find((l: Row) => l.id === line.orderLineId)
      ol.returnedQty += line.receivedQty
    }
    r.status = 'PENDING_SETTLE'
    r.bizDate = bizDate
    r.inspectedAt = nowIso()
    r.version += 1
    if (key) db.idempotency[`ins:${key}`] = r.id
    return returnOut(r, ctx)
  })),
  http.post(`${API}/rtn/sales/:id/settle`, handle((ctx, { params }) => {
    requirePerm(ctx, 'rtn:sales:settle')
    const key = ctx.request.headers.get('Idempotency-Key')
    const db = getDb()
    const r = requireDocumentAccess(ctx, 'SALES_RETURN', Number(params.id))
    if (r.settledFlag) return { ...returnOut(r, ctx), duplicate: true }
    if (r.status !== 'PENDING_SETTLE') conflict('验货完成后才能处理账款')
    if (key && db.idempotency[key]) return { ...returnOut(r, ctx), duplicate: true }
    const total = round(sum(r.lines, (l: Row) => l.receivedQty * l.unitPrice))
    const note: Row = {
      id: nextId(), countryId: ctx.countryId, docNo: docNo(ctx.countryId!, 'CN'), customerId: r.customerId, sourceType: 'SALES_RETURN', sourceId: r.id,
      currency: baseCcy(ctx.countryId!), amount: total, usedAmount: 0, refundableFlag: false, createdAt: nowIso(),
    }
    db.arCreditNotes.unshift(note)
    const applied = applyCreditNoteToOrder(ctx, note, r.orderId)
    if (applied.refundable > 0) {
      const extra: Row = { ...note, id: nextId(), docNo: docNo(ctx.countryId!, 'CN'), amount: applied.refundable, usedAmount: 0, refundableFlag: true, sourceType: 'SALES_RETURN' }
      note.amount = applied.offset
      db.arCreditNotes.unshift(extra)
      r.refundableNoteId = extra.id
    }
    r.creditNoteId = note.id
    r.settledFlag = true
    r.settleAmount = total
    r.settledAmount = total
    r.settledAt = nowIso()
    for (const line of r.lines) line.settledAmount = round(line.receivedQty * line.unitPrice)
    r.arOffsetAmount = applied.offset
    r.refundableAmount = applied.refundable
    r.status = 'COMPLETED'
    if (key) db.idempotency[key] = r.id
    audit(ctx, '退货账款处理', 'sales-return', r.id, null, { offset: applied.offset, refundable: applied.refundable })
    return returnOut(r, ctx)
  })),
  http.get(`${API}/rtn/refunds`, handle((ctx) => {
    requirePerm(ctx, ['rtn:refund:create', 'rtn:refund:pay'])
    return paginate(getDb().rtnRefunds.filter((r) => canDocumentDataAccess(ctx, 'REFUND', r)).map((r) => refundOut(r, ctx)), ctx.url)
  })),
  http.post(`${API}/rtn/refunds`, handle((ctx, { body }) => {
    requirePerm(ctx, 'rtn:refund:create')
    const amount = round(num(body?.amount))
    if (!(amount > 0)) bad('金额必须大于 0')
    const customerId = Number(body.customerId)
    requireDataAccess(ctx, findOr404(ctx, 'customers', customerId))
    const open = round(sum(getDb().arCreditNotes.filter((n) => n.customerId === customerId && n.refundableFlag), (n) => n.amount - num(n.usedAmount)))
    const pending = sum(getDb().rtnRefunds.filter((r) => r.customerId === customerId && ['PENDING_APPROVAL', 'APPROVED'].includes(r.status)), (r) => r.amount)
    if (amount - (open - pending) > 0.001) bad(`超过可退款余额 ${round(open - pending)}`, 'RTN_REFUND_EXCEEDED')
    const account = getDb().fundAccounts.find((a) => a.id === Number(body.fundAccountId) && a.countryId === ctx.countryId && a.status === 'ENABLED' && a.currency === baseCcy(ctx.countryId!))
    if (!account) bad('请选择同币种的有效付款账户')
    requireDataAccess(ctx, account)
    if (!String(body.payeeInfo?.name ?? '').trim()) bad('请填写收款人姓名')
    if ((body.method || 'TRANSFER') === 'TRANSFER' && !String(body.payeeInfo?.account ?? '').trim()) bad('请填写收款账户')
    const row: Row = {
      id: nextId(), countryId: ctx.countryId, docNo: docNo(ctx.countryId!, 'RF'), customerId, currency: baseCcy(ctx.countryId!), amount, method: body.method || 'TRANSFER',
      fundAccountId: account.id, payeeInfo: body.payeeInfo, status: 'DRAFT', approvalInstanceId: null, paidAt: null, referenceNo: '', sources: [], createdAt: nowIso(),
    }
    getDb().rtnRefunds.unshift(row)
    return submitRefund(ctx, row)
  })),
  http.post(`${API}/rtn/refunds/:id/pay`, handle((ctx, { params, body }) => {
    requirePerm(ctx, 'rtn:refund:pay')
    const key = ctx.request.headers.get('Idempotency-Key')
    const db = getDb()
    const r = requireDocumentAccess(ctx, 'REFUND', Number(params.id))
    if (key && db.idempotency[key]) {
      const prev = db.rtnRefunds.find((r) => r.id === db.idempotency[key])
      if (prev && prev.id === r.id) return { ...refundOut(prev, ctx), duplicate: true }
      if (prev) bad('幂等键已用于另一张退款单')
    }
    if (r.status === 'PAID') return { ...refundOut(r, ctx), duplicate: true }
    if (r.status !== 'APPROVED') conflict('退款须先审批通过')
    if (!/^\d{4}-\d{2}-\d{2}(?:T.*)?$/.test(body?.paidAt ?? '') || !Number.isFinite(Date.parse(body.paidAt))) bad('请登记实际支付日期')
    const paidDay = body.paidAt.slice(0, 10)
    if (new Date(`${paidDay}T12:00:00Z`).toISOString().slice(0, 10) !== paidDay) bad('支付日期无效')
    if (!String(body?.referenceNo ?? '').trim()) bad('请填写支付参考号')
    if (!db.attachments.some((a) => a.bizType === 'REFUND' && String(a.bizId) === String(r.id) && a.category === 'REFUND_PROOF' && a.status === 'ACTIVE')) bad('请上传退款支付凭证')
    if (!r.payeeInfo?.name || (r.method === 'TRANSFER' && !r.payeeInfo?.account)) bad('请补齐收款人及收款账户')
    r.sources = consumeRefundable(r.customerId, r.amount)
    Object.assign(r, { status: 'PAID', paidAt: body.paidAt || nowIso(), referenceNo: body.referenceNo ?? '', paidBy: ctx.user.id })
    if (key) db.idempotency[key] = r.id
    audit(ctx, '退款支付', 'refund', r.id, null, { amount: r.amount })
    return refundOut(r, ctx)
  })),
  http.get(`${API}/rtn/purchase/returnable`, handle((ctx) => {
    requirePerm(ctx, ['rtn:purchase:create', 'rtn:purchase:ship'])
    const po = findOr404(ctx, 'purOrders', Number(ctx.url.searchParams.get('poId')))
    requireDataAccess(ctx, po)
    const stage = ctx.url.searchParams.get('stage') || 'DOMESTIC'
    return purchaseSources(po, stage).filter((s) => stage === 'DOMESTIC' || canDocumentDataAccess(ctx, 'PURCHASE_RETURN', { countryId: po.countryId, poId: po.id, warehouseId: s.warehouseId })).map(withProduct)
  })),
  http.get(`${API}/rtn/purchase`, handle((ctx) => {
    requirePerm(ctx, ['rtn:purchase:create', 'rtn:purchase:ship'])
    return paginate(getDb().rtnPurchase.filter((r) => canDocumentDataAccess(ctx, 'PURCHASE_RETURN', r)).map((r) => prOut(r, ctx)), ctx.url)
  })),
  http.post(`${API}/rtn/purchase`, handle((ctx, { body }) => {
    requirePerm(ctx, 'rtn:purchase:create')
    const po = getDb().purOrders.find((o) => o.id === Number(body?.poId) && o.countryId === ctx.countryId)
    if (!po) bad('采购单不存在')
    requireDataAccess(ctx, po)
    const stage = body.stage
    if (!['DOMESTIC', 'MX_STOCK'].includes(stage)) bad('请选择国内未发运或 MX 库存')
    if (stage === 'MX_STOCK') warehouseOf(ctx.countryId!, Number(body.warehouseId))
    if (stage === 'MX_STOCK') requireDataAccess(ctx, { countryId: ctx.countryId, warehouseId: Number(body.warehouseId) })
    const lines = (body.lines ?? []).filter((l: Row) => num(l.qty) > 0).map((l: Row) => {
      const pl = po.lines.find((x: Row) => x.id === Number(l.poLineId))
      if (!pl) bad('采购行不存在')
      const qty = num(l.qty)
      const source = purchaseSources(po, stage).find((s) => s.poLineId === pl.id && (stage === 'DOMESTIC' ? s.sourceLineId === Number(l.sourceLineId) : s.batchId === Number(l.batchId) && s.warehouseId === Number(body.warehouseId)))
      if (!source || qty > source.returnableQty + 0.001) bad('退货数量超过该来源可退数量')
      const unitPrice = num(pl.amount) / (num(pl.baseQty) || num(pl.qty))
      return { id: nextId(), poLineId: pl.id, sourceLineId: source.sourceLineId ?? null, productId: pl.productId, batchId: source.batchId ?? null, qty, unitPrice, amount: round(qty * unitPrice) }
    })
    if (!lines.length) bad('请填写退货数量')
    const sourceKeys = lines.map((l: Row) => `${l.poLineId}:${l.sourceLineId ?? l.batchId}`)
    if (new Set(sourceKeys).size !== sourceKeys.length) bad('同一退货来源不能重复选择')
    for (const pl of po.lines) if (sum(lines.filter((l: Row) => l.poLineId === pl.id), (l: Row) => l.qty) > purchaseLineRemaining(po, pl, stage) + 0.001) bad('退货合计超过采购行可退数量')
    const row: Row = {
      id: nextId(), countryId: ctx.countryId, docNo: docNo(ctx.countryId!, 'PR'), supplierId: po.supplierId, poId: po.id, poNo: po.docNo, stage,
      warehouseId: body.warehouseId ?? null, reason: body.reason ?? '', status: 'DRAFT', lines, currency: po.currency, createdAt: nowIso(),
    }
    getDb().rtnPurchase.unshift(row)
    return body.submit === false ? prOut(row, ctx) : submitPurchase(ctx, row)
  })),
  http.post(`${API}/rtn/purchase/:id/ship`, handle((ctx, { params, body }) => {
    requirePerm(ctx, 'rtn:purchase:ship')
    const key = ctx.request.headers.get('Idempotency-Key')
    const db = getDb()
    const r = requireDocumentAccess(ctx, 'PURCHASE_RETURN', Number(params.id))
    if (r.stage === 'MX_STOCK') requireDataAccess(ctx, { countryId: ctx.countryId, warehouseId: r.warehouseId })
    if (['SHIPPED_BACK', 'CREDITED', 'COMPLETED'].includes(r.status)) return { ...prOut(r, ctx), duplicate: true }
    if (r.status !== 'APPROVED') conflict('采购退货须先审批')
    const po = db.purOrders.find((o) => o.id === r.poId)!
    const bizDate = body?.bizDate || today(ctx.countryId!)
    for (const pl of po.lines) if (sum(r.lines.filter((l: Row) => l.poLineId === pl.id), (l: Row) => l.qty) > purchaseLineRemaining(po, pl, r.stage, r.id) + 0.001) bad('采购行可退数量已变化')
    for (const line of r.lines) {
      const source = purchaseSources(po, r.stage, r.id).find((s) => s.poLineId === line.poLineId && (r.stage === 'DOMESTIC' ? s.sourceLineId === line.sourceLineId : s.batchId === line.batchId && s.warehouseId === r.warehouseId))
      if (!source || line.qty > source.returnableQty + 0.001) bad('来源可退数量已变化，请核对退货单')
    }
    if (r.stage === 'MX_STOCK') {
      for (const line of r.lines) {
        supplierReturnOut(ctx, { warehouseId: r.warehouseId, productId: line.productId, qty: line.qty, batchId: line.batchId, source: { type: 'PURCHASE_RETURN', id: r.id, lineId: line.id, no: r.docNo }, bizDate })
        const pl = po.lines.find((x: Row) => x.id === line.poLineId)
        pl.returnedQty = num(pl.returnedQty) + line.qty
      }
    } else {
      for (const line of r.lines) {
        const pl = po.lines.find((x: Row) => x.id === line.poLineId)
        pl.returnedQty = num(pl.returnedQty) + line.qty
        const source = db.domesticReceipts.flatMap((rc) => rc.lines).find((l: Row) => l.id === line.sourceLineId)!
        source.returnedQty = num(source.returnedQty) + line.qty
      }
    }
    const note = createApCreditNote(ctx, { partnerId: r.supplierId, sourceType: 'PURCHASE_RETURN', sourceId: r.id, currency: r.currency, amount: round(sum(r.lines, (l: Row) => l.amount)) })
    Object.assign(r, { status: 'COMPLETED', apCreditNoteId: note.id })
    if (key) db.idempotency[key] = r.id
    return prOut(r, ctx)
  })),
  http.get(`${API}/rtn/claims`, handle((ctx) => {
    requirePerm(ctx, 'rtn:claim:create')
    return paginate(getDb().rtnClaims.filter((c) => canDocumentDataAccess(ctx, 'CLAIM', c)).map((c) => claimOut(c, ctx)), ctx.url)
  })),
  http.post(`${API}/rtn/claims`, handle((ctx, { body }) => {
    requirePerm(ctx, 'rtn:claim:create')
    if (!body?.partnerId || !(num(body.claimAmount) > 0)) bad('请填写索赔对象和金额')
    const row: Row = {
      id: nextId(), countryId: ctx.countryId, docNo: docNo(ctx.countryId!, 'CLM'), claimType: body.claimType || 'CLAIM', againstType: body.againstType || 'CARRIER',
      partnerId: Number(body.partnerId), discrepancyId: body.discrepancyId ?? null, qty: num(body.qty), claimAmount: round(num(body.claimAmount)), currency: body.currency || baseCcy(ctx.countryId!),
      result: 'PENDING', compensatedAmount: 0, remark: body.remark ?? '', createdAt: nowIso(),
    }
    if (!canDocumentDataAccess(ctx, 'CLAIM', row)) notFound()
    getDb().rtnClaims.unshift(row)
    return claimOut(row, ctx)
  })),
  http.post(`${API}/rtn/claims/:id/resolve`, handle((ctx, { params, body }) => {
    requirePerm(ctx, 'rtn:claim:create')
    const c = requireDocumentAccess(ctx, 'CLAIM', Number(params.id))
    if (c.result !== 'PENDING') conflict('索赔已有结果')
    if (!['COMPENSATED', 'REJECTED'].includes(body?.result)) bad('请选择获赔或拒赔')
    c.result = body.result
    if (body.result === 'COMPENSATED') {
      const amount = round(num(body.compensatedAmount ?? c.claimAmount))
      c.compensatedAmount = amount
      const note = createApCreditNote(ctx, { partnerId: c.partnerId, sourceType: 'CLAIM', sourceId: c.id, currency: c.currency, amount })
      c.apCreditNoteId = note.id
    }
    return claimOut(c, ctx)
  })),
]

function submitReturn(ctx: Ctx, r: Row) {
  requirePerm(ctx, 'rtn:sales:create')
  if (r.status !== 'DRAFT') conflict('只有草稿可以提交')
  const res = submitApproval(ctx, { docType: 'SALES_RETURN', docId: r.id, docNo: r.docNo, docTitle: `销售退货 ${nameOf(getDb().customers, r.customerId)}`, amount: round(sum(r.lines, (l: Row) => l.amount)), currency: baseCcy(ctx.countryId!) })
  r.approvalInstanceId = res.instance?.id ?? null
  r.status = res.status === 'APPROVED' ? 'PENDING_RECEIPT' : 'PENDING_APPROVAL'
  return { ...returnOut(r, ctx), approvalMessage: res.message }
}

onApproval('SALES_RETURN', {
  onApproved: (inst) => {
    const r = getDb().rtnSales.find((x) => x.id === inst.docId)
    if (r?.status === 'PENDING_APPROVAL') r.status = 'PENDING_RECEIPT'
  },
  onRejected: (inst) => {
    const r = getDb().rtnSales.find((x) => x.id === inst.docId)
    if (r?.status === 'PENDING_APPROVAL') r.status = 'REJECTED'
  },
})

function submitRefund(ctx: Ctx, r: Row) {
  const res = submitApproval(ctx, { docType: 'REFUND', docId: r.id, docNo: r.docNo, docTitle: `退款 ${nameOf(getDb().customers, r.customerId)}`, amount: r.amount, currency: baseCcy(ctx.countryId!) })
  r.approvalInstanceId = res.instance?.id ?? null
  r.status = res.status === 'APPROVED' ? 'APPROVED' : 'PENDING_APPROVAL'
  return { ...refundOut(r, ctx), approvalMessage: res.message }
}

onApproval('REFUND', {
  onApproved: (inst) => {
    const r = getDb().rtnRefunds.find((x) => x.id === inst.docId)
    if (r?.status === 'PENDING_APPROVAL') r.status = 'APPROVED'
  },
  onRejected: (inst) => {
    const r = getDb().rtnRefunds.find((x) => x.id === inst.docId)
    if (r?.status === 'PENDING_APPROVAL') r.status = 'REJECTED'
  },
})

function submitPurchase(ctx: Ctx, r: Row) {
  const res = submitApproval(ctx, { docType: 'PURCHASE_RETURN', docId: r.id, docNo: r.docNo, docTitle: `采购退货 ${r.poNo}`, amount: round(sum(r.lines, (l: Row) => l.amount)), currency: r.currency })
  r.status = res.status === 'APPROVED' ? 'APPROVED' : 'PENDING_APPROVAL'
  r.approvalInstanceId = res.instance?.id ?? null
  return { ...prOut(r, ctx), approvalMessage: res.message }
}

onApproval('PURCHASE_RETURN', {
  onApproved: (inst) => {
    const r = getDb().rtnPurchase.find((x) => x.id === inst.docId)
    if (r?.status === 'PENDING_APPROVAL') r.status = 'APPROVED'
  },
  onRejected: (inst) => {
    const r = getDb().rtnPurchase.find((x) => x.id === inst.docId)
    if (r?.status === 'PENDING_APPROVAL') r.status = 'CANCELLED'
  },
})

function refundOut(r: Row, ctx: Ctx) {
  return readableBusinessFields(ctx, { ...r, customerName: nameOf(getDb().customers, r.customerId), accountName: nameOf(getDb().fundAccounts, r.fundAccountId), paidByName: userName(r.paidBy) })
}

function prOut(r: Row, ctx: Ctx) {
  return readableBusinessFields(ctx, { ...r, supplierName: nameOf(getDb().partners, r.supplierId), warehouseName: nameOf(getDb().warehouses, r.warehouseId), lines: r.lines.map(withProduct) }, { amountGroup: 'COST' })
}

function claimOut(c: Row, ctx: Ctx) {
  return readableBusinessFields(ctx, { ...c, partnerName: nameOf(getDb().partners, c.partnerId) }, { amountGroup: 'COST' })
}
