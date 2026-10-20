/* eslint-disable @typescript-eslint/no-explicit-any */
/**
 * 第 2 批演示场景：通过业务函数逐步生成，数量、流水、待办、成本相互一致。
 * - PO-A：两次派送实收，覆盖待补汇率（A21）、破损冻结、短缺差异、调拨
 * - PO-B：一批海运延误（A03），一批换柜后暂缓并有派送在途（A02、A04）
 * - PO-C 草稿；PO-D 大额待业务负责人审批
 */
import { getDb, nextId, nowIso, onSeed, type Row } from './db'
import type { Ctx } from './utils'
import { systemCtx } from './services/common'
import {
  convertInspect, createDomesticReceipt, createExportNode, createOrder, shippableSources, submitOrder,
} from './handlers/pur'
import {
  confirmLgsReceipt, createDelivery, createFee, createHold, createLgsReceipt, createShipment, createTransship, dispatchShipment, recordNode,
} from './handlers/lgs'
import { createTransfer, receiveTransfer, shipTransfer } from './handlers/inv'
import { confirmInboundCost } from './services/cost'
import { evaluateAlert } from './services/inventory'
import { confirmReceipt, createReceipt, saveRule } from './handlers/ar'
import { confirmApBill, confirmApPayment, createApSettlement, createBillFromSources, savePayment } from './handlers/ap'
import { confirmOutbound, createOutbound, createSalesOrder, savePrice } from './handlers/sal'
import { recalculateClassify, suggestReplenishments } from './handlers/ana'
import { buildAllocation } from './handlers/cstOps'
import { generateVoucher, reviewAndPost, syncEvents } from './handlers/fin'
import { openingIn } from './services/inventory'

const at = (date: string, time = '15:00:00') => `${date}T${time}Z`

function build() {
  const db = getDb()
  const admin = systemCtx(1, 1)
  const buyer = systemCtx(1, 6)
  const wh = systemCtx(1, 7)
  const finance = systemCtx(1, 3)
  const pid = (code: string) => db.products.find((p) => p.productCode === code)!.id
  const item = (code: string) => db.expenseItems.find((e) => e.code === code)!.id
  const [P1, P2, P3, P4] = ['P0001', 'P0002', 'P0003', 'P0004'].map(pid)

  const orderLine = (o: Row, productId: number) => o.lines.find((l: Row) => l.productId === productId)
  const receiptLine = (r: Row, productId: number) => r.lines.find((l: Row) => l.productId === productId)
  const sourcesOf = (exportId: number) => shippableSources(1).filter((s) => db.exportNodes.find((e) => e.id === exportId)?.lines.some((l: Row) => l.id === s.sourceLineId))
  const shipLine = (sh: Row, productId: number) => sh.lines.find((l: Row) => l.productId === productId)

  // ---------- PO-A：深圳联创，P0001 + P0002 ----------
  const poA = createOrder(buyer, {
    supplierId: 701, orderDate: '2026-09-01', expectedDate: '2026-09-06', currency: 'CNY', prepayRatio: 30,
    lines: [{ productId: P1, unit: '件', qty: 1000, unitPrice: 6.8, taxRate: 0.13 }, { productId: P2, unit: '件', qty: 400, unitPrice: 48, taxRate: 0.13 }],
  })
  submitOrder(buyer, poA)
  const drA = createDomesticReceipt(buyer, {
    orderId: poA.id, receiptDate: '2026-09-05', location: '深圳龙华集货仓', confirm: true,
    lines: [
      { orderLineId: orderLine(poA, P1).id, qualifiedQty: 1000, pendingInspectQty: 0, damagedQty: 0 },
      { orderLineId: orderLine(poA, P2).id, qualifiedQty: 380, pendingInspectQty: 15, damagedQty: 5 },
    ],
  })
  convertInspect(buyer, receiptLine(drA, P2).id, { toQualifiedQty: 10, toDamagedQty: 0, remark: '复检合格' })
  const exA = createExportNode(buyer, {
    declarationNo: '531620260908001', exportPort: '深圳盐田', exportDate: '2026-09-08', confirm: true,
    lines: [{ receiptLineId: receiptLine(drA, P1).id, qty: 1000 }, { receiptLineId: receiptLine(drA, P2).id, qty: 390 }],
  })
  const shA = createShipment(buyer, {
    carrierId: 703, transportMode: 'SEA', destWarehouseId: 401, originLocation: '深圳盐田', vessel: 'COSCO SHIPPING ARIES', voyage: '052E',
    blNo: 'COSU6312345670', containerNo: 'CSNU1234567', sealNo: 'SL889001', plannedEtd: '2026-09-10', plannedEta: '2026-09-25', submit: true,
    lines: sourcesOf(exA.id).map((s) => ({ sourceLineId: s.sourceLineId, baseQty: s.remainingQty, boxes: Math.ceil(s.remainingQty / 50) })),
  })
  dispatchShipment(buyer, shA, { actualEtd: at('2026-09-10', '02:00:00'), location: '深圳盐田' })
  recordNode(buyer, shA, { nodeType: 'ARRIVED_PORT', actualAt: at('2026-09-24'), location: 'Manzanillo' })
  recordNode(buyer, shA, { nodeType: 'CUSTOMS_DECLARED', actualAt: at('2026-09-25'), location: 'Manzanillo' })
  recordNode(buyer, shA, { nodeType: 'CUSTOMS_RELEASED', actualAt: at('2026-09-26'), location: 'Manzanillo' })

  // 第一次派送：P0001 600，9 月 28 日实收；该日之前没有已确认汇率，成本待补汇率
  const dl1 = createDelivery(buyer, {
    shipmentId: shA.id, destWarehouseId: 401, vehicle: 'MX-TRK-21', driver: 'José Ramírez', plannedAt: '2026-09-27', dispatch: true, dispatchedAt: at('2026-09-27'),
    lines: [{ shipmentLineId: shipLine(shA, P1).id, dispatchQty: 600 }],
  })
  const rc1 = createLgsReceipt(wh, { deliveryId: dl1.id })
  confirmLgsReceipt(wh, rc1, { bizDate: '2026-09-28' })

  // 第二次派送：P0001 400 + P0002 390，10 月 3 日实收；P0002 破损 3、短缺 2
  const dl2 = createDelivery(buyer, {
    shipmentId: shA.id, destWarehouseId: 401, vehicle: 'MX-TRK-08', driver: 'Luis Hernández', plannedAt: '2026-10-02', dispatch: true, dispatchedAt: at('2026-10-02'),
    lines: [{ shipmentLineId: shipLine(shA, P1).id, dispatchQty: 400 }, { shipmentLineId: shipLine(shA, P2).id, dispatchQty: 390 }],
  })
  const rc2 = createLgsReceipt(wh, { deliveryId: dl2.id })
  confirmLgsReceipt(wh, rc2, {
    bizDate: '2026-10-03',
    lines: [
      { id: receiptLine(rc2, P1).id, goodQty: 400 },
      { id: receiptLine(rc2, P2).id, goodQty: 385, damagedQty: 3, pendingInspectQty: 0, shortQty: 2 },
    ],
  })
  const costP1 = db.inboundCosts.find((c) => c.receiptId === rc2.id && c.productId === P1)
  if (costP1) confirmInboundCost(finance, costP1)

  createFee(buyer, { refType: 'SHIPMENT', refId: shA.id, carrierId: 703, expenseItemId: item('FRT-SEA'), currency: 'CNY', amount: 18000, incurredLocation: 'CN', estimateFlag: 'ACTUAL', bizDate: '2026-09-10', confirm: true, remark: '40HQ 海运费' })
  createFee(buyer, { refType: 'SHIPMENT', refId: shA.id, carrierId: 704, expenseItemId: item('CUSTOMS'), currency: 'MXN', amount: 9500, incurredLocation: 'MX', estimateFlag: 'ESTIMATE', bizDate: '2026-09-26', confirm: true, remark: '清关代理暂估' })

  // ---------- 调拨：中心仓 → 一号店门店仓 ----------
  const tr = createTransfer(wh, { fromWarehouseId: 401, toWarehouseId: 402, plannedDate: '2026-10-08', remark: '门店首批铺货', lines: [{ productId: P1, qty: 120 }, { productId: P2, qty: 30 }], submit: true })
  shipTransfer(wh, tr, { bizDate: '2026-10-08', shippedAt: at('2026-10-08') })
  receiveTransfer(admin, tr, { bizDate: '2026-10-09', lines: tr.lines.map((l: Row) => ({ lineId: l.id, qty: l.qty })) })

  // ---------- 上下限：分别触发 低于下限 / 高于上限 / 缺货 ----------
  const limits: [number, number, number, number, number][] = [
    [402, P2, 40, 200, 2],
    [401, P1, 200, 800, 7],
    [402, P3, 10, 100, 2],
  ]
  for (const [warehouseId, productId, minQty, maxQty, ownerId] of limits) {
    db.stockLimits.push({ id: nextId(), countryId: 1, warehouseId, productId, minQty, maxQty, alertEnabled: true, ownerId, versionNo: 1, status: 'ACTIVE', updatedBy: 1, createdAt: at('2026-10-09') })
    evaluateAlert(1, warehouseId, productId)
  }

  // ---------- PO-B：义乌家居，P0003 + P0004 ----------
  const poB = createOrder(buyer, {
    supplierId: 702, orderDate: '2026-09-12', expectedDate: '2026-09-25', currency: 'CNY',
    lines: [{ productId: P3, unit: '件', qty: 480, unitPrice: 22.5, taxRate: 0.13 }, { productId: P4, unit: '件', qty: 200, unitPrice: 55, taxRate: 0.13 }],
  })
  submitOrder(buyer, poB)
  const drB = createDomesticReceipt(buyer, {
    orderId: poB.id, receiptDate: '2026-09-22', location: '义乌国际物流园', confirm: true,
    lines: [
      { orderLineId: orderLine(poB, P3).id, qualifiedQty: 240, pendingInspectQty: 0, damagedQty: 0 },
      { orderLineId: orderLine(poB, P4).id, qualifiedQty: 200, pendingInspectQty: 0, damagedQty: 0 },
    ],
  })
  const exB = createExportNode(buyer, {
    declarationNo: '310120260925002', exportPort: '宁波北仑', exportDate: '2026-09-25', confirm: true,
    lines: [{ receiptLineId: receiptLine(drB, P3).id, qty: 240 }, { receiptLineId: receiptLine(drB, P4).id, qty: 200 }],
  })
  const srcB = sourcesOf(exB.id)
  // SH-B：保温杯，计划 10/13 到港，至今未到 → 延误
  const shB = createShipment(buyer, {
    carrierId: 703, transportMode: 'SEA', destWarehouseId: 401, originLocation: '宁波北仑', vessel: 'MSC AURORA', voyage: '118W',
    blNo: 'MEDU2201987650', containerNo: 'MSCU7788990', plannedEtd: '2026-09-28', plannedEta: '2026-10-13', submit: true,
    lines: srcB.filter((s) => s.productId === P3).map((s) => ({ sourceLineId: s.sourceLineId, baseQty: s.remainingQty, boxes: 10 })),
  })
  dispatchShipment(buyer, shB, { actualEtd: at('2026-09-28', '04:00:00'), location: '宁波北仑' })
  // SH-C：台灯，到港后换柜、放行、部分暂缓、部分派送在途
  const shC = createShipment(buyer, {
    carrierId: 703, transportMode: 'SEA', destWarehouseId: 401, originLocation: '宁波北仑', vessel: 'ONE HARMONY', voyage: '031E',
    blNo: 'ONEY5566778890', containerNo: 'TGHU7654321', sealNo: 'SL776001', plannedEtd: '2026-09-26', plannedEta: '2026-10-09', submit: true,
    lines: srcB.filter((s) => s.productId === P4).map((s) => ({ sourceLineId: s.sourceLineId, baseQty: s.remainingQty, boxes: 200 })),
  })
  dispatchShipment(buyer, shC, { actualEtd: at('2026-09-26', '06:00:00'), location: '宁波北仑' })
  recordNode(buyer, shC, { nodeType: 'ARRIVED_PORT', actualAt: at('2026-10-08'), location: 'Lázaro Cárdenas' })
  const ts = createTransship(buyer, { shipmentId: shC.id, toContainerNo: 'MSKU1122334', toSealNo: 'SL990122', location: 'Lázaro Cárdenas 堆场', transshipAt: at('2026-10-09'), remark: '原柜破损，整柜转移' })
  recordNode(buyer, shC, { nodeType: 'CUSTOMS_RELEASED', actualAt: at('2026-10-11'), location: 'Lázaro Cárdenas' })
  const hold = createHold(buyer, {
    shipmentId: shC.id, reasonCode: 'WAREHOUSE_FULL', parkLocation: 'Lázaro Cárdenas 堆场 B-12', ownerId: 6, reviewDate: '2026-10-15', heldAt: at('2026-10-12'),
    lines: [{ shipmentLineId: shipLine(shC, P4).id, holdQty: 60 }], remark: '中心仓满仓，待腾仓',
  })
  createDelivery(buyer, {
    shipmentId: shC.id, destWarehouseId: 401, vehicle: 'MX-TRK-15', driver: 'Pedro Gómez', plannedAt: '2026-10-14', dispatch: true, dispatchedAt: at('2026-10-14'),
    lines: [{ shipmentLineId: shipLine(shC, P4).id, dispatchQty: 50 }],
  })
  createFee(buyer, { refType: 'TRANSSHIP', refId: ts.id, carrierId: 704, expenseItemId: item('TRANSSHIP'), currency: 'MXN', amount: 3200, incurredLocation: 'MX', estimateFlag: 'ACTUAL', bizDate: '2026-10-09', confirm: true })
  createFee(buyer, { refType: 'HOLD', refId: hold.id, carrierId: 704, expenseItemId: item('STORAGE'), currency: 'MXN', amount: 1200, incurredLocation: 'MX', estimateFlag: 'ESTIMATE', bizDate: '2026-10-14', remark: '堆场仓储费（按天计）' })

  // ---------- PO-C 草稿、PO-D 大额待审批 ----------
  createOrder(buyer, {
    supplierId: 701, orderDate: '2026-10-14', expectedDate: '2026-10-25', currency: 'CNY', remark: '双十一备货（草稿）',
    lines: [{ productId: P1, unit: '箱', qty: 40, unitPrice: 330, taxRate: 0.13 }],
  })
  const poD = createOrder(buyer, {
    supplierId: 701, orderDate: '2026-10-15', expectedDate: '2026-10-30', currency: 'CNY', prepayRatio: 30, remark: '耳机年底大单',
    lines: [{ productId: P2, unit: '箱', qty: 60, unitPrice: 1880, taxRate: 0.13 }, { productId: P1, unit: '箱', qty: 20, unitPrice: 330, taxRate: 0.13 }],
  })
  submitOrder(buyer, poD)

  try {
    buildBatch3({ admin, buyer, wh, finance, P1, P2, P3, P4, poA })
  } catch (e) {
    console.error('[mock] 第 3 批演示场景生成失败', e)
  }
}

function attach(bizType: string, bizId: number, category: string, fileName: string) {
  getDb().attachments.push({
    id: nextId(), countryId: 1, bizType, bizId: String(bizId), category, fileName, size: 2048, contentType: 'application/pdf',
    uploadedBy: 2, uploadedByName: '一号店店员 María', uploadedAt: nowIso(), versionNo: 1, status: 'ACTIVE',
  })
}

/** 第 3 批：价格、赊销、现款出库自动核销、缺附件出库、应付账单与对账 */
function buildBatch3(s: { admin: Ctx; buyer: Ctx; wh: Ctx; finance: Ctx; P1: number; P2: number; P3: number; P4: number; poA: Row }) {
  const db = getDb()
  const lead = systemCtx(1, 4)
  const store = systemCtx(1, 2)
  const { finance, wh, P1, P2, P3, P4, poA } = s
  const price = (body: Row) => savePrice(lead, null, { effectiveFrom: '2026-09-01', unit: '件', minQty: 1, taxMode: 'INCL', ...body })
  for (const [productId, p] of [[P1, 28], [P2, 180], [P3, 45], [P4, 90]] as [number, number][]) price({ priceType: 'BASE', productId, price: p })
  price({ priceType: 'LEVEL', levelId: 511, productId: P1, price: 24 })
  price({ priceType: 'LEVEL', levelId: 512, productId: P1, price: 26 })
  price({ priceType: 'CUSTOMER', customerId: 601, productId: P1, price: 22 })
  saveRule(lead, null, {
    targetType: 'CUSTOMER', targetId: 601, paymentMode: 'CREDIT_ALLOWED', creditLimit: 80000, termDays: 30,
    dueBasis: 'OUTBOUND_DATE', overduePolicy: 'WARN', effectiveFrom: '2026-09-01',
  })

  const cash = createSalesOrder(store, {
    customerId: 602, paymentType: 'CASH', storeId: 301, submit: true, remark: '门店现款，出库后自动核销',
    lines: [{ productId: P1, unit: '件', qty: 4, warehouseId: 401 }],
  })
  attach('SAL_ORDER', cash.id, 'SALES_DOC', 'juan-pedido.pdf')
  const receipt = createReceipt(store, {
    customerId: 602, method: 'CASH', amount: cash.totalAmount, fundAccountId: 901, storeId: 301,
    orders: [{ orderId: cash.id, plannedAmount: cash.totalAmount }],
  })
  confirmReceipt(finance, receipt.id, { arrivalDate: '2026-10-15' })
  const cashOb = createOutbound(wh, { orderId: cash.id, warehouseId: 401, lines: [{ allocId: cash.lines[0].allocs[0].id, qty: 4 }] })
  confirmOutbound(wh, cashOb, { bizDate: '2026-10-15' })

  const credit = createSalesOrder(lead, {
    customerId: 601, paymentType: 'CREDIT', submit: true, remark: '批发赊销，先出一部分',
    lines: [{ productId: P1, unit: '件', qty: 20, warehouseId: 401 }],
  })
  attach('SAL_ORDER', credit.id, 'SALES_DOC', 'norte-pedido.pdf')
  const creditOb = createOutbound(wh, { orderId: credit.id, warehouseId: 401, lines: [{ allocId: credit.lines[0].allocs[0].id, qty: 8 }] })
  confirmOutbound(wh, creditOb, { bizDate: '2026-10-15' })

  createSalesOrder(lead, {
    customerId: 601, paymentType: 'CREDIT', submit: true, remark: '超过 5 万，待业务负责人审批',
    lines: [{ productId: P1, unit: '件', qty: 2500, warehouseId: 401 }],
  })

  const bare = createSalesOrder(store, {
    customerId: 602, paymentType: 'CASH', storeId: 301, submit: true, remark: '未上传销售单据，出库应被拦住',
    lines: [{ productId: P1, unit: '件', qty: 1, warehouseId: 401 }],
  })
  const bareRc = createReceipt(store, {
    customerId: 602, method: 'CASH', amount: bare.totalAmount, fundAccountId: 901,
    orders: [{ orderId: bare.id, plannedAmount: bare.totalAmount }],
  })
  confirmReceipt(finance, bareRc.id, {})
  try {
    const bareOb = createOutbound(wh, { orderId: bare.id, warehouseId: 401, lines: [{ allocId: bare.lines[0].allocs[0].id, qty: 1 }] })
    confirmOutbound(wh, bareOb, { bizDate: '2026-10-15' })
  } catch {
    /* 缺少销售单据，保留草稿出库单供页面查看检查结果 */
  }

  const poLine = poA.lines.find((l: Row) => l.productId === P1)
  const cny = createBillFromSources(finance, {
    billDate: '2026-10-06', dueDate: '2026-11-06', partnerInvoiceNo: 'LC-2026-1006',
    sources: [{ sourceType: 'PUR_ORDER_LINE', sourceId: poLine.id, sourceNo: poA.docNo, partnerId: 701, currency: 'CNY', productId: P1, qty: 100, unitPrice: poLine.unitPrice, openQty: poLine.qty }],
  })
  confirmApBill(finance, cny.id)
  const fee = db.lgsFees.find((f) => f.amount === 9500 && f.currency === 'MXN')!
  const mx = createBillFromSources(finance, {
    billDate: '2026-10-01', dueDate: '2026-10-31',
    sources: [{ sourceType: 'LGS_FEE', sourceId: fee.id, partnerId: fee.carrierId, currency: 'MXN' }],
  })
  confirmApBill(finance, mx.id)
  const pay = savePayment(finance, { partnerId: fee.carrierId, payCurrency: 'MXN', payAmount: 9500, fundAccountId: 902, payDate: '2026-10-08', referenceNo: 'BBVA-1008' })
  confirmApPayment(finance, pay.id)
  createApSettlement(finance, {
    partnerId: fee.carrierId, bizDate: '2026-10-08',
    lines: [{ fromType: 'PAYMENT', fromId: pay.id, fromCurrency: 'MXN', billId: mx.id, billAmount: 9500 }],
  })
  void s.admin
  void s.buyer
  void P2
  void P3
  void P4
}

/** 第 4 批：分类、补货、分摊、一张已记账凭证，以及智利独立的期初和现款销售 */
function buildBatch4() {
  const db = getDb()
  const admin = systemCtx(1, 1)
  const finance = systemCtx(1, 3)
  const cl = systemCtx(2, 8)
  const p1 = db.products.find((p) => p.productCode === 'P0001')!.id
  const p4 = db.products.find((p) => p.productCode === 'P0004')!.id
  recalculateClassify(1)
  db.stockLimits.push({
    id: nextId(), countryId: 1, warehouseId: 401, productId: p4, minQty: 5, maxQty: 50, alertEnabled: true, ownerId: 7, status: 'ACTIVE', versionNo: 1, createdAt: nowIso(),
  })
  evaluateAlert(1, 401, p4)
  suggestReplenishments(admin)
  const fee = db.lgsFees.find((f) => f.currency === 'MXN' && f.amount === 9500)
  // This shipment intentionally includes a receipt without a confirmed exchange rate.
  // Keep its allocation in draft instead of capitalizing an incomplete cost basis.
  if (fee) buildAllocation(finance, { feeId: fee.id, basis: 'QTY' }, false)
  const storage = db.expenseItems.find((e) => e.countryId === 1 && e.code === 'STORAGE')
  if (storage) {
    db.expenses.unshift({
      id: nextId(), countryId: 1, docNo: 'MX-EX-261010-0001', expenseItemId: storage.id, treatment: 'PERIOD_EXPENSE',
      currency: 'MXN', amount: 800, baseAmount: 800, bizDate: '2026-10-10', lines: [], status: 'CONFIRMED', createdAt: nowIso(),
    })
  }
  syncEvents(1)
  const event = db.finEvents.find((e) => e.status === 'PENDING' && e.eventType === 'AR_RECEIPT_CONFIRMED')
  if (event) {
    const voucher = generateVoucher(admin, event.id)
    reviewAndPost(finance, voucher.id)
  }

  openingIn(cl, {
    warehouseId: 411, productId: p1, qty: 10, unitCost: 1000, batchNo: 'CL-OPEN-0001', bizDate: '2026-10-01',
    source: { type: 'OPENING', id: 2, lineId: nextId(), no: 'CL-OPEN' },
  })
  savePrice(cl, null, { priceType: 'BASE', productId: p1, unit: '件', price: 5000, effectiveFrom: '2026-10-01' })
  const order = createSalesOrder(cl, {
    customerId: 611, paymentType: 'CASH', orderDate: '2026-10-15', submit: true, warehouseId: 411,
    lines: [{ productId: p1, qty: 2, warehouseId: 411 }],
  })
  db.attachments.push({
    id: nextId(), countryId: 2, bizType: 'SAL_ORDER', bizId: String(order.id), category: 'SALES_DOC', fileName: 'boleta-cl.pdf',
    size: 1024, contentType: 'application/pdf', uploadedBy: 8, uploadedByName: '智利管理员 Camila', uploadedAt: nowIso(), versionNo: 1, status: 'ACTIVE',
  })
  const receipt = createReceipt(cl, {
    customerId: 611, method: 'CASH', amount: order.totalAmount, fundAccountId: 911, bizTime: '2026-10-15T18:00:00Z',
    orders: [{ orderId: order.id, plannedAmount: order.totalAmount }],
  })
  confirmReceipt(cl, receipt.id, { arrivalDate: '2026-10-15' })
  const outbound = createOutbound(cl, { orderId: order.id, warehouseId: 411, lines: [{ allocId: order.lines[0].allocs[0].id, qty: 2 }] })
  confirmOutbound(cl, outbound, { bizDate: '2026-10-15' })
  recalculateClassify(2)
}

onSeed(() => {
  try {
    build()
  } catch (e) {
    console.error('[mock] 第 2 批演示场景生成失败', e)
  }
  try {
    buildBatch4()
  } catch (e) {
    console.error('[mock] 第 4 批演示场景生成失败', e)
  }
})
