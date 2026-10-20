/* eslint-disable @typescript-eslint/no-explicit-any */
/**
 * 04 中国采购：采购单、国内收货、出口节点。
 * 国内收货不进入任何库存台账，只更新采购行统计；运营库存只在 MX 实收时增加。
 */
import { http } from 'msw'
import { getDb, nextId, nowIso, type Row } from '../db'
import { API, crud, findOr404 } from '../crud'
import { audit, checkVersion, handle, requireCountry, requireDataAccess, requirePerm, type Ctx } from '../utils'
import { canDocumentDataAccess, requireDocumentDataAccess } from '../services/access'
import { cancelPendingApproval, invalidateApproval, onApproval, submitApproval } from '../services/approval'
import { resolveRate } from '../services/cost'
import { assertSkuEnabled, bad, conflict, costVisible, country, docNo, nameOf, num, product, round, sum, today, userName, withProduct } from '../services/common'

// ---------- 采购单 ----------

const undelivered = (l: Row) => Math.max(0, l.baseQty - l.cancelledQty - l.qualifiedQty - l.pendingInspectQty)

function ensureUniqueSourceLines(lines: Row[], key: string) {
  const seen = new Set<string>()
  for (const line of lines) {
    const source = String(line[key])
    if (seen.has(source)) bad('同一来源行不能重复，请合并数量后再提交', 'PUR_DUPLICATE_SOURCE')
    seen.add(source)
  }
}

function orderOut(o: Row, ctx: Ctx) {
  const db = getDb()
  const showCost = costVisible(ctx)
  const lines = o.lines.map((l: Row) => {
    const r: Row = withProduct({ ...l, undeliveredQty: undelivered(l), deliveredQty: l.qualifiedQty + l.pendingInspectQty })
    if (!showCost) {
      delete r.unitPrice
      delete r.amount
    }
    return r
  })
  const out: Row = {
    ...o,
    lines,
    supplierName: nameOf(db.partners, o.supplierId),
    entityName: nameOf(db.entities, o.entityId),
    createdByName: userName(o.createdBy),
    productSummary: lines.map((l: Row) => l.productCode).join('、'),
    deliveredQty: sum(o.lines, (l: Row) => l.qualifiedQty + l.pendingInspectQty),
    shippedQty: sum(o.lines, (l: Row) => l.shippedQty),
    arrivedMxQty: sum(o.lines, (l: Row) => l.arrivedMxQty),
    costHidden: !showCost,
  }
  if (!showCost) {
    delete out.totalAmount
    delete out.taxAmount
  }
  return out
}

function normalizeOrder(ctx: Ctx, body: Row) {
  const db = getDb()
  const countryId = ctx.countryId!
  const supplier = db.partners.find((p) => p.id === body?.supplierId && p.countryId === countryId)
  if (!supplier || !['SUPPLIER', 'BOTH'].includes(supplier.partnerType)) bad('请选择本国的供应商')
  if (supplier.status !== 'ENABLED') bad(`供应商 ${supplier.name} 已停用`, 'MD_DISABLED')
  const entityId = body.entityId ?? db.entities.find((e) => e.countryId === countryId && e.status === 'ENABLED')?.id
  if (!entityId) bad('请先维护经营主体')
  if (!db.entities.some((e) => e.id === entityId && e.countryId === countryId && e.status === 'ENABLED')) bad('经营主体不属于当前国家或已停用')
  requireDataAccess(ctx, { countryId, entityId })
  const inLines: Row[] = body.lines ?? []
  if (!inLines.length) bad('至少需要一行商品')
  const lines = inLines.map((l, i) => {
    const p = assertSkuEnabled(countryId, Number(l.productId))
    const unit = l.unit || p.units.find((u: Row) => u.isPurchaseDefault)?.unit || p.baseUnit
    const factor = Number(p.units.find((u: Row) => u.unit === unit)?.factorToBase ?? 0)
    if (!factor) bad(`第 ${i + 1} 行单位“${unit}”不存在`)
    const qty = num(l.qty)
    if (!(qty > 0)) bad(`第 ${i + 1} 行数量必须大于 0`)
    const unitPrice = num(l.unitPrice)
    if (unitPrice < 0) bad(`第 ${i + 1} 行单价不能为负数`)
    return {
      id: nextId(), lineNo: i + 1, productId: p.id, unit, factor, qty, baseQty: round(qty * factor, 4), unitPrice,
      amount: round(qty * unitPrice, 2), taxRate: num(l.taxRate), deliveryDate: l.deliveryDate || body.expectedDate || null,
      cancelledQty: 0, qualifiedQty: 0, pendingInspectQty: 0, damagedQty: 0, exportedQty: 0, shippedQty: 0, arrivedMxQty: 0, returnedQty: 0,
    }
  })
  return {
    entityId,
    supplierId: supplier.id,
    sourceCountry: body.sourceCountry || supplier.locatedCountry || 'CN',
    currency: body.currency || supplier.settleCurrency,
    orderDate: body.orderDate || today(countryId),
    expectedDate: body.expectedDate || null,
    paymentTerms: body.paymentTerms ?? supplier.paymentTerms ?? '',
    prepayRatio: num(body.prepayRatio),
    termDays: num(body.termDays),
    remark: body.remark ?? '',
    lines,
    totalQty: sum(lines, (l) => l.baseQty),
    totalAmount: round(sum(lines, (l) => l.amount), 2),
    taxAmount: round(sum(lines, (l) => l.amount * l.taxRate), 2),
  }
}

const keyFieldsOf = (o: Row) =>
  JSON.stringify({ s: o.supplierId, t: o.paymentTerms, l: o.lines.map((l: Row) => [l.productId, l.baseQty, l.unitPrice]) })

export function createOrder(ctx: Ctx, body: Row) {
  requirePerm(ctx, 'pur:order:create')
  const data = normalizeOrder(ctx, body)
  const row: Row = {
    ...data, id: nextId(), countryId: ctx.countryId, docNo: docNo(ctx.countryId!, 'PO', data.orderDate), status: 'DRAFT',
    approvalInstanceId: null, version: 1, createdBy: ctx.user.id, createdAt: nowIso(), updatedAt: nowIso(),
  }
  getDb().purOrders.unshift(row)
  audit(ctx, '新增', 'purchase-order', row.id, null, row)
  return row
}

function updateOrder(ctx: Ctx, o: Row, body: Row) {
  requirePerm(ctx, ['pur:order:edit', 'pur:order:create'])
  checkVersion(o, body)
  const delivered = o.lines.some((l: Row) => l.qualifiedQty + l.pendingInspectQty + l.damagedQty > 0)
  if (o.status !== 'DRAFT' && !(o.status === 'CONFIRMED' && !delivered)) {
    conflict('只有草稿，或尚未国内收货的已确认采购单可以修改；已交货的请用部分取消或关闭')
  }
  const before = structuredClone(o)
  const data = normalizeOrder(ctx, body)
  Object.assign(o, data, { version: o.version + 1, updatedAt: nowIso(), updatedBy: ctx.user.id })
  let needResubmit = false
  if (before.status === 'CONFIRMED' && keyFieldsOf(before) !== keyFieldsOf(o)) {
    o.status = 'DRAFT'
    invalidateApproval('PURCHASE_ORDER', o.id, '供应商、数量、单价或付款条件已修改')
    needResubmit = true
  }
  audit(ctx, needResubmit ? '修改关键字段（需重新审批）' : '修改', 'purchase-order', o.id, before, o)
  return { ...orderOut(o, ctx), needResubmit }
}

export function submitOrder(ctx: Ctx, o: Row) {
  requirePerm(ctx, 'pur:order:submit')
  requireDocumentDataAccess(ctx, 'PURCHASE_ORDER', o)
  const blocked = o.status === 'PENDING_APPROVAL' && getDb().approvalInstances.find((i) => i.id === o.approvalInstanceId)?.status === 'BLOCKED'
  if (o.status !== 'DRAFT' && !blocked) conflict('只有草稿可以提交')
  cancelPendingApproval('PURCHASE_ORDER', o.id)
  const rate = resolveRate(o.countryId, o.currency, country(o.countryId).defaultCurrency, today(o.countryId))
  const res = submitApproval(ctx, {
    docType: 'PURCHASE_ORDER', docId: o.id, docNo: o.docNo, docTitle: `${nameOf(getDb().partners, o.supplierId)} · ${o.currency} 采购`,
    amount: o.totalAmount, currency: o.currency, facts: { amount: rate ? round(o.totalAmount * rate.rate, 2) : o.totalAmount },
  })
  o.approvalInstanceId = res.instance?.id ?? null
  o.status = res.status === 'APPROVED' ? 'CONFIRMED' : 'PENDING_APPROVAL'
  if (o.status === 'CONFIRMED') o.confirmedAt = nowIso()
  o.version += 1
  audit(ctx, '提交', 'purchase-order', o.id, null, { status: o.status, approval: res.message })
  return { ...orderOut(o, ctx), approvalMessage: res.message }
}

onApproval('PURCHASE_ORDER', {
  onApproved: (inst) => {
    const o = getDb().purOrders.find((x) => x.id === inst.docId)
    if (o?.status === 'PENDING_APPROVAL') Object.assign(o, { status: 'CONFIRMED', confirmedAt: nowIso(), version: o.version + 1 })
  },
  onRejected: (inst) => {
    const o = getDb().purOrders.find((x) => x.id === inst.docId)
    if (o?.status === 'PENDING_APPROVAL') Object.assign(o, { status: 'DRAFT', version: o.version + 1 })
  },
  onWithdrawn: (inst) => {
    const o = getDb().purOrders.find((x) => x.id === inst.docId)
    if (o?.status === 'PENDING_APPROVAL') Object.assign(o, { status: 'DRAFT', version: o.version + 1 })
  },
})

function refreshOrderStatus(o: Row) {
  if (!['CONFIRMED', 'PARTIAL_DELIVERED', 'DELIVERED'].includes(o.status)) return
  const any = o.lines.some((l: Row) => l.qualifiedQty + l.pendingInspectQty + l.damagedQty > 0)
  const all = o.lines.every((l: Row) => undelivered(l) <= 0)
  o.status = any && all ? 'DELIVERED' : any ? 'PARTIAL_DELIVERED' : 'CONFIRMED'
}

function cancelLines(ctx: Ctx, o: Row, body: Row) {
  requirePerm(ctx, 'pur:order:cancel')
  requireDocumentDataAccess(ctx, 'PURCHASE_ORDER', o)
  if (!['CONFIRMED', 'PARTIAL_DELIVERED'].includes(o.status)) conflict('只有已确认或部分交付的采购单可以部分取消')
  if (!body?.reason) bad('请填写取消原因')
  const items: Row[] = (body.lines ?? []).filter((x: Row) => num(x.qty) > 0)
  if (!items.length) bad('请填写取消数量')
  for (const it of items) {
    const l = o.lines.find((x: Row) => x.id === it.lineId)
    if (!l) bad('采购行不存在')
    const max = undelivered(l)
    if (num(it.qty) > max) bad(`第 ${l.lineNo} 行最多可取消 ${max}（订购 − 已收合格 − 已收待检 − 已取消）`, 'PUR_CANCEL_EXCEEDED')
    l.cancelledQty += num(it.qty)
    getDb().purCancels.unshift({ id: nextId(), countryId: o.countryId, orderId: o.id, orderLineId: l.id, productId: l.productId, cancelQty: num(it.qty), reason: body.reason, cancelledBy: ctx.user.id, cancelledAt: nowIso() })
  }
  refreshOrderStatus(o)
  o.version += 1
  audit(ctx, '部分取消', 'purchase-order', o.id, null, { lines: items, reason: body.reason })
  return orderOut(o, ctx)
}

function closeOrder(ctx: Ctx, o: Row, body: Row) {
  requirePerm(ctx, 'pur:order:close')
  requireDocumentDataAccess(ctx, 'PURCHASE_ORDER', o)
  if (!['CONFIRMED', 'PARTIAL_DELIVERED', 'DELIVERED'].includes(o.status)) conflict('当前状态不能关闭')
  if (!body?.reason) bad('请填写关闭原因')
  for (const l of o.lines) {
    const rest = undelivered(l)
    if (rest > 0) {
      l.cancelledQty += rest
      getDb().purCancels.unshift({ id: nextId(), countryId: o.countryId, orderId: o.id, orderLineId: l.id, productId: l.productId, cancelQty: rest, reason: `关闭自动取消：${body.reason}`, cancelledBy: ctx.user.id, cancelledAt: nowIso() })
    }
  }
  Object.assign(o, { status: 'CLOSED', closeReason: body.reason, closedAt: nowIso(), version: o.version + 1 })
  audit(ctx, '关闭', 'purchase-order', o.id, null, { reason: body.reason })
  return orderOut(o, ctx)
}

function progress(ctx: Ctx, o: Row) {
  const db = getDb()
  const lineIds = new Set(o.lines.map((l: Row) => l.id))
  const receipts = db.domesticReceipts
    .filter((r) => r.orderId === o.id && r.status !== 'VOIDED')
    .map((r) => ({ ...r, lines: r.lines.map(withProduct) }))
  const exports = db.exportNodes
    .filter((e) => e.status !== 'VOIDED' && e.lines.some((l: Row) => l.orderId === o.id))
    .map((e) => ({ ...e, lines: e.lines.filter((l: Row) => l.orderId === o.id).map(withProduct) }))
  const shipments = db.shipments
    .filter((s) => s.lines.some((l: Row) => lineIds.has(l.poLineId)) && canDocumentDataAccess(ctx, 'SHIPMENT', s))
    .map((s) => ({
      id: s.id, docNo: s.docNo, status: s.status, transportMode: s.transportMode, actualEtd: s.actualEtd, actualEta: s.actualEta,
      containerNo: s.currentContainerNo, lines: s.lines.filter((l: Row) => lineIds.has(l.poLineId)).map(withProduct),
    }))
  const mxReceipts = db.lgsReceipts
    .filter((r) => r.status === 'CONFIRMED' && canDocumentDataAccess(ctx, 'LGS_RECEIPT', r))
    .flatMap((r) => r.lines.filter((l: Row) => lineIds.has(l.poLineId)).map((l: Row) => withProduct({ ...l, receiptId: r.id, receiptNo: r.docNo, bizDate: r.bizDate, warehouseName: nameOf(db.warehouses, r.warehouseId) })))
  const cancels = db.purCancels.filter((c) => c.orderId === o.id).map((c) => withProduct({ ...c, cancelledByName: userName(c.cancelledBy) }))
  return { order: orderOut(o, ctx), receipts, exports, shipments, mxReceipts, cancels }
}

const orders = crud('/pur/orders', 'purOrders', {
  viewPerm: 'pur:order:view',
  canAccess: (row, ctx) => canDocumentDataAccess(ctx, 'PURCHASE_ORDER', row),
  keywordKeys: ['docNo', 'remark'],
  filterKeys: ['status', 'supplierId'],
  filter: (r, ctx) => {
    const sp = ctx.url.searchParams
    const pid = sp.get('productId')
    return (!pid || r.lines.some((l: Row) => String(l.productId) === pid)) &&
      (!sp.get('dateFrom') || r.orderDate >= sp.get('dateFrom')!) && (!sp.get('dateTo') || r.orderDate <= sp.get('dateTo')!)
  },
  out: orderOut,
})

const findOrder = (ctx: Ctx, id: string) => {
  requirePerm(ctx, 'pur:order:view')
  return findOr404(ctx, 'purOrders', Number(id), { canAccess: (row) => canDocumentDataAccess(ctx, 'PURCHASE_ORDER', row) })
}

const orderExtras = [
  http.post(`${API}/pur/orders`, handle((ctx, { body }) => {
    requireCountry(ctx)
    const o = createOrder(ctx, body)
    return body?.submit ? submitOrder(ctx, o) : orderOut(o, ctx)
  })),
  http.put(`${API}/pur/orders/:id`, handle((ctx, { params, body }) => updateOrder(ctx, findOrder(ctx, params.id), body))),
  http.post(`${API}/pur/orders/:id/submit`, handle((ctx, { params }) => submitOrder(ctx, findOrder(ctx, params.id)))),
  http.post(`${API}/pur/orders/:id/void`, handle((ctx, { params }) => {
    requirePerm(ctx, 'pur:order:cancel')
    const o = findOrder(ctx, params.id)
    if (o.status !== 'DRAFT') conflict('只有草稿可以作废；已有收货记录的采购单只能关闭')
    o.status = 'CANCELLED'
    o.version += 1
    audit(ctx, '作废', 'purchase-order', o.id, { status: 'DRAFT' }, { status: 'CANCELLED' })
    return orderOut(o, ctx)
  })),
  http.post(`${API}/pur/orders/:id/cancel-lines`, handle((ctx, { params, body }) => cancelLines(ctx, findOrder(ctx, params.id), body))),
  http.post(`${API}/pur/orders/:id/close`, handle((ctx, { params, body }) => closeOrder(ctx, findOrder(ctx, params.id), body))),
  http.get(`${API}/pur/orders/:id/progress`, handle((ctx, { params }) => progress(ctx, findOrder(ctx, params.id)))),
]

// ---------- 国内收货 ----------

function receiptOut(r: Row) {
  const db = getDb()
  const o = db.purOrders.find((x) => x.id === r.orderId)
  return {
    ...r,
    supplierName: nameOf(db.partners, r.supplierId),
    createdByName: userName(r.createdBy),
    lines: r.lines.map((l: Row) => {
      const ol = o?.lines.find((x: Row) => x.id === l.orderLineId)
      return withProduct({
        ...l,
        lineNo: ol?.lineNo,
        orderBaseQty: ol?.baseQty,
        remainingPendingQty: l.pendingInspectQty - l.convertedQualifiedQty - l.convertedDamagedQty,
        exportableQty: l.qualifiedQty + l.convertedQualifiedQty - l.exportedQty - num(l.returnedQty),
      })
    }),
    totalQualified: sum(r.lines, (l: Row) => l.qualifiedQty + l.convertedQualifiedQty),
    totalPending: sum(r.lines, (l: Row) => l.pendingInspectQty - l.convertedQualifiedQty - l.convertedDamagedQty),
    totalDamaged: sum(r.lines, (l: Row) => l.damagedQty + l.convertedDamagedQty),
    converts: db.inspectConverts.filter((c) => c.receiptId === r.id).map((c) => withProduct({ ...c, convertedByName: userName(c.convertedBy) })),
  }
}

function receivableOrder(ctx: Ctx, orderId: number) {
  const o = getDb().purOrders.find((x) => x.id === orderId && x.countryId === ctx.countryId)
  if (!o) bad('请选择采购单')
  requireDocumentDataAccess(ctx, 'PURCHASE_ORDER', o)
  if (!['CONFIRMED', 'PARTIAL_DELIVERED'].includes(o.status)) conflict(`采购单 ${o.docNo} 当前状态不能收货`)
  return o
}

function checkReceiptLines(o: Row, lines: Row[]) {
  ensureUniqueSourceLines(lines, 'orderLineId')
  for (const l of lines) {
    const ol = o.lines.find((x: Row) => x.id === l.orderLineId)
    if (!ol) bad('采购行不存在')
    for (const k of ['qualifiedQty', 'pendingInspectQty', 'damagedQty']) if (num(l[k]) < 0) bad('数量不能为负数')
    const max = undelivered(ol)
    if (num(l.qualifiedQty) + num(l.pendingInspectQty) > max) {
      bad(`${product(ol.productId)?.productCode} 合格 + 待检不能超过未交数量 ${max}`, 'PUR_RECEIPT_EXCEEDED')
    }
  }
}

function buildReceiptLines(o: Row, body: Row) {
  const lines = (body?.lines ?? [])
    .map((l: Row) => ({
      id: nextId(), orderLineId: l.orderLineId, productId: o.lines.find((x: Row) => x.id === l.orderLineId)?.productId,
      qualifiedQty: num(l.qualifiedQty), pendingInspectQty: num(l.pendingInspectQty), damagedQty: num(l.damagedQty),
      convertedQualifiedQty: 0, convertedDamagedQty: 0, exportedQty: 0, remark: l.remark ?? '',
    }))
    .filter((l: Row) => l.qualifiedQty + l.pendingInspectQty + l.damagedQty > 0)
  if (!lines.length) bad('请至少录入一行收货数量')
  checkReceiptLines(o, lines)
  return lines
}

export function createDomesticReceipt(ctx: Ctx, body: Row) {
  requirePerm(ctx, 'pur:receipt:create')
  const o = receivableOrder(ctx, Number(body?.orderId))
  const receiptDate = body.receiptDate || today(ctx.countryId!)
  const r: Row = {
    id: nextId(), countryId: ctx.countryId, docNo: docNo(ctx.countryId!, 'DR', receiptDate), orderId: o.id, orderNo: o.docNo,
    supplierId: o.supplierId, receiptDate, location: body.location ?? '', remark: body.remark ?? '', status: 'DRAFT',
    lines: buildReceiptLines(o, body), version: 1, createdBy: ctx.user.id, createdAt: nowIso(), updatedAt: nowIso(),
  }
  getDb().domesticReceipts.unshift(r)
  audit(ctx, '新增', 'domestic-receipt', r.id, null, r)
  return body.confirm ? confirmDomesticReceipt(ctx, r) : r
}

export function confirmDomesticReceipt(ctx: Ctx, r: Row) {
  requirePerm(ctx, 'pur:receipt:confirm')
  requireDocumentDataAccess(ctx, 'DOMESTIC_RECEIPT', r)
  if (r.status === 'CONFIRMED') return r
  if (r.status !== 'DRAFT') conflict('只有草稿可以确认')
  const o = receivableOrder(ctx, r.orderId)
  checkReceiptLines(o, r.lines)
  for (const l of r.lines) {
    const ol = o.lines.find((x: Row) => x.id === l.orderLineId)
    ol.qualifiedQty += l.qualifiedQty
    ol.pendingInspectQty += l.pendingInspectQty
    ol.damagedQty += l.damagedQty
  }
  refreshOrderStatus(o)
  o.version += 1
  Object.assign(r, { status: 'CONFIRMED', confirmedBy: ctx.user.id, confirmedAt: nowIso(), version: r.version + 1 })
  audit(ctx, '确认（PUR_DOMESTIC_RECEIPT_CONFIRMED）', 'domestic-receipt', r.id, null, { status: 'CONFIRMED' })
  return r
}

function voidDomesticReceipt(ctx: Ctx, r: Row) {
  requirePerm(ctx, 'pur:receipt:confirm')
  requireDocumentDataAccess(ctx, 'DOMESTIC_RECEIPT', r)
  if (r.status === 'CONFIRMED') {
    if (r.lines.some((l: Row) => l.exportedQty > 0 || l.convertedQualifiedQty + l.convertedDamagedQty > 0)) {
      conflict('该收货已被出口节点引用或做过待检转换，不能作废')
    }
    const o = getDb().purOrders.find((x) => x.id === r.orderId)!
    for (const l of r.lines) {
      const ol = o.lines.find((x: Row) => x.id === l.orderLineId)
      ol.qualifiedQty -= l.qualifiedQty
      ol.pendingInspectQty -= l.pendingInspectQty
      ol.damagedQty -= l.damagedQty
    }
    refreshOrderStatus(o)
  } else if (r.status !== 'DRAFT') conflict('当前状态不能作废')
  const before = r.status
  r.status = 'VOIDED'
  r.version += 1
  audit(ctx, '作废', 'domestic-receipt', r.id, { status: before }, { status: 'VOIDED' })
  return r
}

export function convertInspect(ctx: Ctx, lineId: number, body: Row) {
  requirePerm(ctx, 'pur:receipt:confirm')
  const db = getDb()
  const r = db.domesticReceipts.find((x) => x.countryId === ctx.countryId && x.lines.some((l: Row) => l.id === lineId))
  if (!r) bad('收货行不存在')
  requireDocumentDataAccess(ctx, 'DOMESTIC_RECEIPT', r)
  if (r.status !== 'CONFIRMED') conflict('只有已确认的收货可以做待检转换')
  const l = r.lines.find((x: Row) => x.id === lineId)
  const q = num(body?.toQualifiedQty)
  const d = num(body?.toDamagedQty)
  const remain = l.pendingInspectQty - l.convertedQualifiedQty - l.convertedDamagedQty
  if (q < 0 || d < 0 || q + d <= 0) bad('请填写转换数量')
  if (q + d > remain) bad(`转换数量不能超过剩余待检 ${remain}`)
  l.convertedQualifiedQty += q
  l.convertedDamagedQty += d
  const ol = db.purOrders.find((x) => x.id === r.orderId)!.lines.find((x: Row) => x.id === l.orderLineId)
  ol.pendingInspectQty -= q + d
  ol.qualifiedQty += q
  ol.damagedQty += d
  db.inspectConverts.unshift({ id: nextId(), countryId: ctx.countryId, receiptId: r.id, receiptLineId: l.id, productId: l.productId, toQualifiedQty: q, toDamagedQty: d, remark: body.remark ?? '', convertedBy: ctx.user.id, convertedAt: nowIso() })
  r.version += 1
  audit(ctx, '待检转换', 'domestic-receipt', r.id, null, { productId: l.productId, toQualifiedQty: q, toDamagedQty: d })
  return receiptOut(r)
}

const receipts = crud('/pur/domestic-receipts', 'domesticReceipts', {
  viewPerm: ['pur:receipt:create', 'pur:receipt:confirm', 'pur:order:view'],
  canAccess: (row, ctx) => canDocumentDataAccess(ctx, 'DOMESTIC_RECEIPT', row),
  keywordKeys: ['docNo', 'orderNo', 'location'],
  filterKeys: ['status', 'orderId', 'supplierId'],
  out: receiptOut,
})

const findReceipt = (ctx: Ctx, id: string) => findOr404(ctx, 'domesticReceipts', Number(id), { canAccess: (row) => canDocumentDataAccess(ctx, 'DOMESTIC_RECEIPT', row) })

const receiptExtras = [
  http.post(`${API}/pur/domestic-receipts/lines/:lineId/convert`, handle((ctx, { params, body }) => convertInspect(ctx, Number(params.lineId), body))),
  http.post(`${API}/pur/domestic-receipts`, handle((ctx, { body }) => {
    requireCountry(ctx)
    return receiptOut(createDomesticReceipt(ctx, body))
  })),
  http.put(`${API}/pur/domestic-receipts/:id`, handle((ctx, { params, body }) => {
    requirePerm(ctx, 'pur:receipt:create')
    const r = findReceipt(ctx, params.id)
    checkVersion(r, body)
    if (r.status !== 'DRAFT') conflict('只有草稿可以修改')
    const o = receivableOrder(ctx, r.orderId)
    Object.assign(r, { receiptDate: body.receiptDate || r.receiptDate, location: body.location ?? r.location, remark: body.remark ?? r.remark, lines: buildReceiptLines(o, body), version: r.version + 1, updatedAt: nowIso() })
    audit(ctx, '修改', 'domestic-receipt', r.id, null, r)
    return receiptOut(r)
  })),
  http.post(`${API}/pur/domestic-receipts/:id/confirm`, handle((ctx, { params }) => receiptOut(confirmDomesticReceipt(ctx, findReceipt(ctx, params.id))))),
  http.post(`${API}/pur/domestic-receipts/:id/void`, handle((ctx, { params }) => receiptOut(voidDomesticReceipt(ctx, findReceipt(ctx, params.id))))),
]

// ---------- 出口节点 ----------

function exportSources(ctx: Ctx) {
  const db = getDb()
  return db.domesticReceipts
    .filter((r) => r.countryId === ctx.countryId && r.status === 'CONFIRMED' && canDocumentDataAccess(ctx, 'DOMESTIC_RECEIPT', r))
    .flatMap((r) =>
      r.lines
        .map((l: Row) => withProduct({
          receiptId: r.id, receiptNo: r.docNo, receiptLineId: l.id, receiptDate: r.receiptDate, orderId: r.orderId, orderNo: r.orderNo,
          orderLineId: l.orderLineId, supplierName: nameOf(db.partners, r.supplierId), productId: l.productId,
          exportableQty: l.qualifiedQty + l.convertedQualifiedQty - l.exportedQty - num(l.returnedQty),
        }))
        .filter((x: Row) => x.exportableQty > 0),
    )
}

function exportOut(e: Row) {
  return { ...e, lines: e.lines.map(withProduct), totalQty: sum(e.lines, (l: Row) => l.qty), createdByName: userName(e.createdBy), productSummary: [...new Set(e.lines.map((l: Row) => product(l.productId)?.productCode))].join('、') }
}

function buildExportLines(ctx: Ctx, body: Row) {
  ensureUniqueSourceLines(body?.lines ?? [], 'receiptLineId')
  const sources = exportSources(ctx)
  const lines = (body?.lines ?? []).filter((l: Row) => num(l.qty) > 0).map((l: Row) => {
    const s = sources.find((x) => x.receiptLineId === l.receiptLineId)
    if (!s) bad('来源收货行不存在，或已没有可出口的合格数量')
    if (num(l.qty) > s.exportableQty) bad(`${s.productCode}（${s.receiptNo}）最多可登记出口 ${s.exportableQty}`, 'PUR_EXPORT_EXCEEDED')
    return { id: nextId(), receiptId: s.receiptId, receiptNo: s.receiptNo, receiptLineId: s.receiptLineId, orderId: s.orderId, orderNo: s.orderNo, orderLineId: s.orderLineId, productId: s.productId, qty: num(l.qty), shippedQty: 0 }
  })
  if (!lines.length) bad('请至少选择一行并填写出口数量')
  return lines
}

export function createExportNode(ctx: Ctx, body: Row) {
  requirePerm(ctx, 'pur:export:create')
  if (!body?.declarationNo) bad('请填写报关单号')
  const exportDate = body.exportDate || today(ctx.countryId!)
  const e: Row = {
    id: nextId(), countryId: ctx.countryId, docNo: docNo(ctx.countryId!, 'EX', exportDate), declarationNo: body.declarationNo,
    exportPort: body.exportPort ?? '', exportDate, remark: body.remark ?? '', status: 'DRAFT', lines: buildExportLines(ctx, body),
    version: 1, createdBy: ctx.user.id, createdAt: nowIso(), updatedAt: nowIso(),
  }
  getDb().exportNodes.unshift(e)
  audit(ctx, '新增', 'export-node', e.id, null, e)
  return body.confirm ? confirmExportNode(ctx, e) : e
}

export function confirmExportNode(ctx: Ctx, e: Row) {
  requirePerm(ctx, 'pur:export:confirm')
  requireDocumentDataAccess(ctx, 'EXPORT_NODE', e)
  if (e.status === 'CONFIRMED') return e
  if (e.status !== 'DRAFT') conflict('只有草稿可以确认')
  ensureUniqueSourceLines(e.lines, 'receiptLineId')
  const sources = exportSources(ctx)
  const db = getDb()
  for (const l of e.lines) {
    const s = sources.find((x) => x.receiptLineId === l.receiptLineId)
    if (!s || l.qty > s.exportableQty) bad(`${product(l.productId)?.productCode} 可出口数量已变化，请修改后再确认`, 'PUR_EXPORT_EXCEEDED')
    const rl = db.domesticReceipts.find((r) => r.id === l.receiptId)!.lines.find((x: Row) => x.id === l.receiptLineId)
    rl.exportedQty += l.qty
    db.purOrders.find((o) => o.id === l.orderId)!.lines.find((x: Row) => x.id === l.orderLineId).exportedQty += l.qty
  }
  Object.assign(e, { status: 'CONFIRMED', confirmedBy: ctx.user.id, confirmedAt: nowIso(), version: e.version + 1 })
  audit(ctx, '确认', 'export-node', e.id, null, { status: 'CONFIRMED' })
  return e
}

const exportsCrud = crud('/pur/export-nodes', 'exportNodes', {
  viewPerm: ['pur:export:create', 'pur:export:confirm', 'pur:order:view'],
  canAccess: (row, ctx) => canDocumentDataAccess(ctx, 'EXPORT_NODE', row),
  keywordKeys: ['docNo', 'declarationNo', 'exportPort'],
  out: exportOut,
})

const exportExtras = [
  http.get(`${API}/pur/export-nodes/sources`, handle((ctx) => {
    requirePerm(ctx, 'pur:export:create')
    requireCountry(ctx)
    return exportSources(ctx)
  })),
  http.post(`${API}/pur/export-nodes`, handle((ctx, { body }) => {
    requireCountry(ctx)
    return exportOut(createExportNode(ctx, body))
  })),
  http.put(`${API}/pur/export-nodes/:id`, handle((ctx, { params, body }) => {
    requirePerm(ctx, 'pur:export:create')
    const e = findOr404(ctx, 'exportNodes', Number(params.id), { canAccess: (row) => canDocumentDataAccess(ctx, 'EXPORT_NODE', row) })
    checkVersion(e, body)
    if (e.status !== 'DRAFT') conflict('只有草稿可以修改')
    Object.assign(e, { declarationNo: body.declarationNo || e.declarationNo, exportPort: body.exportPort ?? e.exportPort, exportDate: body.exportDate || e.exportDate, remark: body.remark ?? e.remark, lines: buildExportLines(ctx, body), version: e.version + 1 })
    return exportOut(e)
  })),
  http.post(`${API}/pur/export-nodes/:id/confirm`, handle((ctx, { params }) => exportOut(confirmExportNode(ctx, findOr404(ctx, 'exportNodes', Number(params.id), { canAccess: (row) => canDocumentDataAccess(ctx, 'EXPORT_NODE', row) }))))),
  http.post(`${API}/pur/export-nodes/:id/void`, handle((ctx, { params }) => {
    requirePerm(ctx, 'pur:export:create')
    const e = findOr404(ctx, 'exportNodes', Number(params.id), { canAccess: (row) => canDocumentDataAccess(ctx, 'EXPORT_NODE', row) })
    if (e.status !== 'DRAFT') conflict('只有草稿可以作废')
    e.status = 'VOIDED'
    e.version += 1
    return exportOut(e)
  })),
]

// ---------- 对 05 开放：可发运来源与回写（PurchaseSourceApi） ----------

/** 可发运来源：已确认出口节点行的剩余数量；未发运的运输批次占用的计划数量单独列出 */
export function shippableSources(countryId: number, excludeShipmentId?: number, ctx?: Ctx) {
  const db = getDb()
  const planned = new Map<number, number>()
  for (const s of db.shipments.filter((x) => x.countryId === countryId && ['DRAFT', 'PENDING_DISPATCH'].includes(x.status) && x.id !== excludeShipmentId)) {
    for (const l of s.lines) planned.set(l.sourceLineId, (planned.get(l.sourceLineId) ?? 0) + l.baseQty)
  }
  return db.exportNodes
    .filter((e) => e.countryId === countryId && e.status === 'CONFIRMED' && (!ctx || canDocumentDataAccess(ctx, 'EXPORT_NODE', e)))
    .flatMap((e) =>
      e.lines.map((l: Row) => {
        const o = db.purOrders.find((x) => x.id === l.orderId)
        const p = product(l.productId)
        return withProduct({
          sourceType: 'EXPORT_NODE_LINE', sourceLineId: l.id, sourceNo: e.docNo, declarationNo: e.declarationNo, exportDate: e.exportDate,
          poId: l.orderId, poNo: l.orderNo, poLineId: l.orderLineId, supplierId: o?.supplierId, supplierName: nameOf(db.partners, o?.supplierId),
          productId: l.productId, qty: l.qty, shippedQty: l.shippedQty, plannedQty: planned.get(l.id) ?? 0,
          remainingQty: l.qty - l.shippedQty - (planned.get(l.id) ?? 0), unitWeight: p?.grossWeight ?? 0, unitVolume: p?.volume ?? 0,
        })
      }),
    )
}

export function onShipped(sourceLineId: number, qty: number) {
  const db = getDb()
  for (const e of db.exportNodes) {
    const l = e.lines.find((x: Row) => x.id === sourceLineId)
    if (l) {
      l.shippedQty += qty
      db.purOrders.find((o) => o.id === l.orderId)!.lines.find((x: Row) => x.id === l.orderLineId).shippedQty += qty
      return
    }
  }
}

export function onArrived(poLineId: number, qty: number) {
  for (const o of getDb().purOrders) {
    const l = o.lines.find((x: Row) => x.id === poLineId)
    if (l) {
      l.arrivedMxQty += qty
      return
    }
  }
}

const sourceHandler = http.get(`${API}/pur/shippable-sources`, handle((ctx) => {
  requirePerm(ctx, ['lgs:shipment:create', 'lgs:shipment:edit'])
  const sp = ctx.url.searchParams
  return shippableSources(requireCountry(ctx), Number(sp.get('excludeShipmentId')) || undefined, ctx)
    .filter((s) => !sp.get('supplierId') || String(s.supplierId) === sp.get('supplierId'))
    .filter((s) => !sp.get('productId') || String(s.productId) === sp.get('productId'))
    .filter((s) => s.remainingQty > 0 || sp.get('all') === 'true')
}))

export const purHandlers = [
  sourceHandler,
  ...orders.handlers(orderExtras),
  ...receipts.handlers(receiptExtras),
  ...exportsCrud.handlers(exportExtras),
]
