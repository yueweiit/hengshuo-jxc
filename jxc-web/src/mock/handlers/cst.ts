/* eslint-disable @typescript-eslint/no-explicit-any */
/**
 * 11 成本核算（第 2 批只做入库成本）：入库成本快照列表、确认、批量确认，以及批次成本追溯。
 */
import { http } from 'msw'
import { getDb, type Row } from '../db'
import { API, findOr404 } from '../crud'
import { MockError, canDataAccess, handle, inScope, paginate, requireCountry, requireDataAccess, requireFieldAccess, requirePerm, type Ctx } from '../utils'
import { confirmInboundCost, refreshEstimate, resolveRate } from '../services/cost'
import { costVisible, nameOf, userName, withProduct } from '../services/common'
import { TXN_TYPES } from '../services/inventory'

const WH_SCOPE = { warehouseField: 'warehouseId' }

function costOut(c: Row) {
  const db = getDb()
  return withProduct({
    ...c, warehouseName: nameOf(db.warehouses, c.warehouseId), supplierName: nameOf(db.partners, c.supplierId), confirmedByName: userName(c.confirmedBy),
    rateAvailable: c.status === 'CONFIRMED' || !!resolveRate(c.countryId, c.srcCurrency, c.baseCurrency, c.bizDate),
  })
}

const list = http.get(`${API}/cst/inbound-costs`, handle((ctx) => {
  requirePerm(ctx, 'cst:cost:view')
  requireFieldAccess(ctx, 'COST')
  const countryId = requireCountry(ctx)
  const sp = ctx.url.searchParams
  const keyword = sp.get('keyword')?.toLowerCase()
  const all = getDb().inboundCosts.filter((c) => c.countryId === countryId && inScope(ctx, c, WH_SCOPE))
  all.forEach(refreshEstimate)
  const rows = all
    .filter((c) => ['status', 'productId', 'warehouseId', 'supplierId'].every((k) => !sp.get(k) || String(c[k]) === sp.get(k)))
    .filter((c) => !keyword || [c.batchNo, c.poNo, c.receiptNo].some((v) => String(v).toLowerCase().includes(keyword)))
    .filter((c) => (!sp.get('dateFrom') || c.bizDate >= sp.get('dateFrom')!) && (!sp.get('dateTo') || c.bizDate <= sp.get('dateTo')!))
    .map(costOut)
  const counts: Record<string, number> = {}
  for (const c of all) counts[c.status] = (counts[c.status] ?? 0) + 1
  return { ...paginate(rows, ctx.url), counts }
}))

const confirm = http.post(`${API}/cst/inbound-costs/:id/confirm`, handle((ctx, { params }) => {
  requirePerm(ctx, 'cst:cost:confirm')
  return costOut(confirmInboundCost(ctx, findOr404(ctx, 'inboundCosts', Number(params.id), { scope: WH_SCOPE })))
}))

/** 批量确认：逐条处理，缺汇率的条目返回失败原因，不影响其他条目 */
const batchConfirm = http.post(`${API}/cst/inbound-costs/batch-confirm`, handle((ctx, { body }) => {
  requirePerm(ctx, 'cst:cost:confirm')
  requireCountry(ctx)
  const confirmed: number[] = []
  const failed: { id: number; batchNo: string; reason: string }[] = []
  for (const id of (body?.ids ?? []) as number[]) {
    const c = getDb().inboundCosts.find((x) => x.id === id && x.countryId === ctx.countryId)
    if (!c) {
      failed.push({ id, batchNo: '', reason: '记录不存在' })
      continue
    }
    try {
      confirmInboundCost(ctx, c)
      confirmed.push(id)
    } catch (e) {
      failed.push({ id, batchNo: c.batchNo, reason: e instanceof MockError ? e.message : String(e) })
    }
  }
  return { confirmed, failed }
}))

/** 批次成本追溯：采购单 → 国内收货 → 出口 → 运输批次 → MX 实收 → 入库成本 → 库存余额与流水 */
function costTrace(ctx: Ctx, batchId: number) {
  const db = getDb()
  const batch = db.invBatches.find((b) => b.id === batchId && b.countryId === ctx.countryId)
  if (!batch) throw new MockError(404, 'SYS_NOT_FOUND', '批次不存在')
  const showCost = costVisible(ctx)
  const cost = batch.costId ? db.inboundCosts.find((c) => c.id === batch.costId) : null
  const owned = db.invBatchBalances.filter(b => b.batchId === batch.id)
  if (!owned.some(b => canDataAccess(ctx, b))) requireDataAccess(ctx, { countryId: ctx.countryId, warehouseId: cost?.warehouseId ?? -1 })
  if (cost) refreshEstimate(cost)
  const po = cost ? db.purOrders.find((p) => p.id === cost.poId) : null
  const poLine = po?.lines.find((l: Row) => l.id === cost?.poLineId)
  const sh = db.shipments.find((s) => s.id === batch.shipmentId)
  const receipt = cost ? db.lgsReceipts.find((r) => r.id === cost.receiptId) : null
  const rLine = receipt?.lines.find((l: Row) => l.id === cost?.receiptLineId)
  const domestic = poLine ? db.domesticReceipts.filter((r) => r.orderId === po!.id && r.status === 'CONFIRMED' && r.lines.some((l: Row) => l.orderLineId === poLine.id)) : []
  const exportsList = poLine ? db.exportNodes.filter((n) => n.status === 'CONFIRMED' && n.lines.some((l: Row) => l.orderLineId === poLine.id)) : []
  const mask = (v: unknown) => (showCost ? v : undefined)
  return {
    batch: withProduct({ ...batch }),
    costHidden: !showCost,
    purchase: po && poLine ? {
      poId: po.id, poNo: po.docNo, orderDate: po.orderDate, supplierName: nameOf(db.partners, po.supplierId), lineNo: poLine.lineNo,
      currency: po.currency, unitPrice: mask(poLine.unitPrice), unit: poLine.unit, factor: poLine.factor,
    } : null,
    domesticReceipts: domestic.map((r) => ({ id: r.id, docNo: r.docNo, receiptDate: r.receiptDate, location: r.location })),
    exportNodes: exportsList.map((n) => ({ id: n.id, docNo: n.docNo, exportDate: n.exportDate, declarationNo: n.declarationNo, exportPort: n.exportPort })),
    shipment: sh ? {
      id: sh.id, docNo: sh.docNo, transportMode: sh.transportMode, containerNos: sh.containers.map((c: Row) => c.containerNo),
      actualEtd: sh.actualEtd, actualEta: sh.actualEta, carrierName: nameOf(db.partners, sh.carrierId),
    } : null,
    receipt: receipt && rLine ? {
      id: receipt.id, docNo: receipt.docNo, bizDate: receipt.bizDate, warehouseName: nameOf(db.warehouses, receipt.warehouseId),
      goodQty: rLine.goodQty, damagedQty: rLine.damagedQty, pendingInspectQty: rLine.pendingInspectQty, shortQty: rLine.shortQty,
    } : null,
    cost: cost ? {
      id: cost.id, status: cost.status, qty: cost.qty, srcCurrency: cost.srcCurrency, baseCurrency: cost.baseCurrency, bizDate: cost.bizDate,
      rate: cost.rate, rateDate: cost.rateDate, confirmedAt: cost.confirmedAt, confirmedByName: userName(cost.confirmedBy),
      srcUnitPrice: mask(cost.srcUnitPrice), srcAmount: mask(cost.srcAmount), basePurchaseAmount: mask(cost.basePurchaseAmount),
      allocFeeAmount: mask(cost.allocFeeAmount), unitCost: mask(cost.unitCost),
    } : null,
    balances: owned.filter(b => canDataAccess(ctx, b)).map((b) => ({ ...b, warehouseName: nameOf(db.warehouses, b.warehouseId) })),
    txns: db.invTxns.filter((t) => t.batchId === batch.id && canDataAccess(ctx, t)).map((t) => ({
      id: t.id, txnType: t.txnType, txnTypeLabel: TXN_TYPES[t.txnType] ?? t.txnType, warehouseName: nameOf(db.warehouses, t.warehouseId),
      onHandChange: t.onHandChange, frozenChange: t.frozenChange, sourceType: t.sourceType, sourceNo: t.sourceNo, bizDate: t.bizDate, occurredAt: t.occurredAt,
    })),
  }
}

const trace = http.get(`${API}/cst/batches/:batchId/cost-trace`, handle((ctx, { params }) => {
  requirePerm(ctx, ['cst:cost:view', 'inv:stock:view'])
  requireCountry(ctx)
  return costTrace(ctx, Number(params.batchId))
}))

export const cstHandlers = [list, batchConfirm, confirm, trace]
