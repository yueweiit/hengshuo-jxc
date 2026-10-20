/* eslint-disable @typescript-eslint/no-explicit-any */
/**
 * InventoryApi（docs/06 第 5.1 节）：所有库存变动的唯一入口。
 * 汇总层 invSummaries（仓 + SKU）与批次层 invBatchBalances（仓 + 批次）在同一请求内一起更新，
 * 流水 invTxns 以 (sourceType, sourceLineId, txnType, seq) 去重，重复请求不会重复入库或扣减。
 */
import { getDb, nextId, nowIso, type Row } from '../db'
import type { Ctx } from '../utils'
import { closeTodo, conflict, docNo, nameOf, openTodo, product, today } from './common'
import { createBatchCost } from './cost'
import { assertPeriodOpen } from './period'

export interface StockSource {
  type: string
  id: number
  lineId: number
  no: string
}

export const TXN_TYPES: Record<string, string> = {
  RECEIPT_IN: 'MX 实收入库',
  SALES_OUT: '销售出库',
  TRANSFER_OUT: '调拨调出',
  TRANSFER_IN: '调拨调入',
  STOCKTAKE_GAIN: '盘盈',
  STOCKTAKE_LOSS: '盘亏',
  FREEZE: '冻结',
  UNFREEZE: '解冻',
  RETURN_IN: '退货入库',
  SUPPLIER_RETURN_OUT: '采购退货出库',
  SCRAP_OUT: '报废出库',
  OPENING_IN: '期初入库',
}

export const FREEZE_TYPES: Record<string, string> = {
  PENDING_INSPECT: '待检',
  DAMAGED: '破损',
  RETURN_PENDING: '待处理退货',
  MANUAL: '手工冻结',
}

function summaryRow(countryId: number, warehouseId: number, productId: number) {
  const db = getDb()
  let s = db.invSummaries.find((x) => x.warehouseId === warehouseId && x.productId === productId)
  if (!s) {
    s = { id: nextId(), countryId, warehouseId, productId, onHandQty: 0, reservedQty: 0, frozenQty: 0, version: 0 }
    db.invSummaries.push(s)
  }
  return s
}

function balanceRow(countryId: number, warehouseId: number, productId: number, batchId: number) {
  const db = getDb()
  let b = db.invBatchBalances.find((x) => x.warehouseId === warehouseId && x.batchId === batchId)
  if (!b) {
    b = { id: nextId(), countryId, warehouseId, productId, batchId, onHandQty: 0, frozenQty: 0, version: 0 }
    db.invBatchBalances.push(b)
  }
  return b
}

export function stockOf(warehouseId: number, productId: number) {
  const s = getDb().invSummaries.find((x) => x.warehouseId === warehouseId && x.productId === productId)
  const onHand = s?.onHandQty ?? 0
  const reserved = s?.reservedQty ?? 0
  const frozen = s?.frozenQty ?? 0
  return { onHand, reserved, frozen, available: onHand - reserved - frozen }
}

/** 盘点冻结作业：盘点范围内的 SKU 不允许出入库（docs/06 第 5.6 节） */
export function assertNotLocked(warehouseId: number, productId: number) {
  const st = getDb().stocktakes.find(
    (s) => s.warehouseId === warehouseId && ['COUNTING', 'SUBMITTED', 'APPROVED'].includes(s.status) && s.lines.some((l: Row) => l.productId === productId),
  )
  if (st) conflict(`${product(productId)?.productCode} 正在盘点（${st.docNo}），盘点期间不能出入库`, 'INV_STOCKTAKE_LOCKED')
}

const txnKey = (source: StockSource, txnType: string, seq: number) => `${source.type}|${source.lineId}|${txnType}|${seq}`

export function txnExists(source: StockSource, txnType: string, seq = 1) {
  const key = txnKey(source, txnType, seq)
  return getDb().invTxns.some((t) => t.key === key)
}

export interface TxnInput {
  warehouseId: number
  productId: number
  batchId: number
  txnType: string
  onHand: number
  frozen: number
  source: StockSource
  seq?: number
  bizDate?: string
  ignoreLock?: boolean
}

/** 写一条流水并更新两层余额；同一唯一键重复调用返回 null */
export function postTxn(ctx: Ctx, t: TxnInput): Row | null {
  const db = getDb()
  const countryId = ctx.countryId!
  const seq = t.seq ?? 1
  const key = txnKey(t.source, t.txnType, seq)
  if (db.invTxns.some((x) => x.key === key)) return null
  assertPeriodOpen(countryId, t.bizDate ?? today(countryId))
  if (!t.ignoreLock) assertNotLocked(t.warehouseId, t.productId)

  const bal = balanceRow(countryId, t.warehouseId, t.productId, t.batchId)
  const sum = summaryRow(countryId, t.warehouseId, t.productId)
  const p = product(t.productId)
  const nextOnHand = bal.onHandQty + t.onHand
  const nextFrozen = bal.frozenQty + t.frozen
  if (nextOnHand < 0 || nextFrozen < 0 || nextFrozen > nextOnHand) {
    conflict(`${p?.productCode} 批次数量不足，不能出现负库存`, 'INV_NEGATIVE')
  }
  const nextAvailable = sum.onHandQty + t.onHand - sum.reservedQty - (sum.frozenQty + t.frozen)
  if (t.onHand < 0 || t.frozen > 0) {
    if (nextAvailable < 0) conflict(`${p?.productCode} 可售数量不足（当前可售 ${sum.onHandQty - sum.reservedQty - sum.frozenQty}）`, 'INV_INSUFFICIENT_AVAILABLE')
  }
  bal.onHandQty = nextOnHand
  bal.frozenQty = nextFrozen
  bal.version += 1
  sum.onHandQty += t.onHand
  sum.frozenQty += t.frozen
  sum.version += 1

  const batch = db.invBatches.find((b) => b.id === t.batchId)
  const cost = batch?.costId ? db.inboundCosts.find((c) => c.id === batch.costId) : null
  const txn = {
    id: nextId(), countryId, key, warehouseId: t.warehouseId, productId: t.productId, batchId: t.batchId, txnType: t.txnType,
    onHandChange: t.onHand, frozenChange: t.frozen, sourceType: t.source.type, sourceId: t.source.id, sourceLineId: t.source.lineId,
    sourceNo: t.source.no, seq, bizDate: t.bizDate ?? today(countryId), occurredAt: nowIso(), operatorId: ctx.user.id,
    unitCost: cost?.status === 'CONFIRMED' ? cost.unitCost : null,
  }
  db.invTxns.unshift(txn)
  evaluateAlert(countryId, t.warehouseId, t.productId)
  return txn
}

export interface BatchInput {
  productId: number
  sourceType: 'MX_RECEIPT' | 'TRANSFER' | 'RETURN' | 'STOCKTAKE_GAIN' | 'OPENING'
  source: StockSource
  shipmentId?: number | null
  poLineId?: number | null
  bizDate: string
}

export function createBatch(ctx: Ctx, b: BatchInput) {
  const row = {
    id: nextId(), countryId: ctx.countryId!, productId: b.productId, batchNo: docNo(ctx.countryId!, 'B', b.bizDate),
    sourceType: b.sourceType, sourceRefId: b.source.lineId, sourceNo: b.source.no, shipmentId: b.shipmentId ?? null,
    poLineId: b.poLineId ?? null, firstInboundDate: b.bizDate, costId: null as number | null, createdAt: nowIso(),
  }
  getDb().invBatches.push(row)
  return row
}

export interface InboundInput {
  warehouseId: number
  productId: number
  goodQty: number
  damagedQty: number
  pendingInspectQty: number
  source: StockSource
  bizDate: string
  shipmentId?: number | null
  poLineId?: number | null
}

/** 期初入库：生成 OPENING 批次、期初流水和已确认的成本快照（docs/13） */
export function openingIn(ctx: Ctx, input: { warehouseId: number; productId: number; qty: number; unitCost: number; batchNo?: string; bizDate: string; source: StockSource }) {
  if (!(input.qty > 0)) return null
  const batch = createBatch(ctx, { productId: input.productId, sourceType: 'OPENING', source: input.source, bizDate: input.bizDate })
  if (input.batchNo) batch.batchNo = input.batchNo
  postTxn(ctx, { warehouseId: input.warehouseId, productId: input.productId, batchId: batch.id, txnType: 'OPENING_IN', onHand: input.qty, frozen: 0, source: input.source, bizDate: input.bizDate })
  const db = getDb()
  const ccy = db.countries.find((c) => c.id === ctx.countryId)?.defaultCurrency ?? ''
  const cost = {
    id: nextId(), countryId: ctx.countryId, bookId: db.books.find((b) => b.countryId === ctx.countryId)?.id ?? null,
    receiptLineId: input.source.lineId, batchId: batch.id, productId: input.productId, warehouseId: input.warehouseId, qty: input.qty,
    srcCurrency: ccy, srcUnitPrice: input.unitCost, srcAmount: input.qty * input.unitCost, rate: 1, rateDate: input.bizDate,
    baseCurrency: ccy, basePurchaseAmount: input.qty * input.unitCost, allocFeeAmount: 0, unitCost: input.unitCost,
    status: 'CONFIRMED', bizDate: input.bizDate, batchNo: batch.batchNo, poNo: '', receiptNo: input.source.no,
    confirmedBy: ctx.user.id, confirmedAt: nowIso(),
  }
  db.inboundCosts.push(cost)
  batch.costId = cost.id
  return batch
}

/** MX 实收入库：合格可售；破损、待检计入实物并冻结；短缺不入库（docs/05 第 5.6 节） */
export function inbound(ctx: Ctx, i: InboundInput) {
  const total = i.goodQty + i.damagedQty + i.pendingInspectQty
  if (total <= 0 || txnExists(i.source, 'RECEIPT_IN')) return null
  const batch = createBatch(ctx, { productId: i.productId, sourceType: 'MX_RECEIPT', source: i.source, shipmentId: i.shipmentId, poLineId: i.poLineId, bizDate: i.bizDate })
  postTxn(ctx, { warehouseId: i.warehouseId, productId: i.productId, batchId: batch.id, txnType: 'RECEIPT_IN', onHand: total, frozen: 0, source: i.source, bizDate: i.bizDate })
  const frozen: [string, number][] = [['DAMAGED', i.damagedQty], ['PENDING_INSPECT', i.pendingInspectQty]]
  for (const [freezeType, qty] of frozen) {
    if (qty > 0) createFreeze(ctx, { warehouseId: i.warehouseId, productId: i.productId, batchId: batch.id, qty, freezeType, reason: `${i.source.no} 实收${FREEZE_TYPES[freezeType]}`, sourceType: i.source.type, sourceId: i.source.id, sourceNo: i.source.no, bizDate: i.bizDate })
  }
  return batch
}

export interface FreezeInput {
  warehouseId: number
  productId: number
  batchId: number
  qty: number
  freezeType: string
  reason: string
  sourceType: string
  sourceId: number | null
  sourceNo: string
  bizDate?: string
}

export function createFreeze(ctx: Ctx, f: FreezeInput) {
  const row = {
    id: nextId(), countryId: ctx.countryId!, docNo: docNo(ctx.countryId!, 'FZ', f.bizDate), warehouseId: f.warehouseId, productId: f.productId,
    batchId: f.batchId, freezeType: f.freezeType, qty: f.qty, releasedQty: 0, reason: f.reason, sourceType: f.sourceType,
    sourceId: f.sourceId, sourceNo: f.sourceNo, status: 'ACTIVE', releases: [] as Row[], createdBy: ctx.user.id, createdAt: nowIso(),
  }
  getDb().invFreezes.unshift(row)
  postTxn(ctx, { warehouseId: f.warehouseId, productId: f.productId, batchId: f.batchId, txnType: 'FREEZE', onHand: 0, frozen: f.qty, source: { type: 'INV_FREEZE', id: row.id, lineId: row.id, no: row.docNo }, bizDate: f.bizDate })
  return row
}

/** 部分或全部解冻为可售；报废出库需要审批，随退货与成本模块提供 */
export function releaseFreeze(ctx: Ctx, fz: Row, qty: number, remark: string) {
  const remain = fz.qty - fz.releasedQty
  if (!(qty > 0) || qty > remain) conflict(`解冻数量须大于 0 且不超过未解冻数量 ${remain}`)
  const seq = fz.releases.length + 1
  postTxn(ctx, { warehouseId: fz.warehouseId, productId: fz.productId, batchId: fz.batchId, txnType: 'UNFREEZE', onHand: 0, frozen: -qty, source: { type: 'INV_FREEZE', id: fz.id, lineId: fz.id, no: fz.docNo }, seq })
  fz.releasedQty += qty
  fz.releases.push({ seq, qty, remark, by: ctx.user.id, at: nowIso() })
  fz.status = fz.releasedQty >= fz.qty ? 'RELEASED' : 'PARTIAL_RELEASED'
}

/** 先进先出挑选批次，只用未冻结的数量；也可以指定批次 */
export function pickBatches(warehouseId: number, productId: number, qty: number, batchId?: number | null) {
  const db = getDb()
  const p = product(productId)
  const stock = stockOf(warehouseId, productId)
  if (qty > stock.available) conflict(`${p?.productCode} 可售数量不足：需要 ${qty}，可售 ${stock.available}`, 'INV_INSUFFICIENT_AVAILABLE')
  const balances = db.invBatchBalances
    .filter((b) => b.warehouseId === warehouseId && b.productId === productId && b.onHandQty - b.frozenQty > 0 && (!batchId || b.batchId === batchId))
    .map((b) => ({ b, batch: db.invBatches.find((x) => x.id === b.batchId)! }))
    .sort((x, y) => x.batch.firstInboundDate.localeCompare(y.batch.firstInboundDate) || x.batch.id - y.batch.id)
  const allocs: { batchId: number; batchNo: string; qty: number }[] = []
  let need = qty
  for (const { b, batch } of balances) {
    if (need <= 0) break
    const take = Math.min(need, b.onHandQty - b.frozenQty)
    allocs.push({ batchId: b.batchId, batchNo: batch.batchNo, qty: take })
    need -= take
  }
  if (need > 0) conflict(`${p?.productCode} ${batchId ? '指定批次' : '各批次'}未冻结数量不足`, 'INV_INSUFFICIENT_AVAILABLE')
  return allocs
}

export function transferOut(ctx: Ctx, o: { warehouseId: number; productId: number; qty: number; batchId?: number | null; source: StockSource; bizDate?: string }) {
  const allocs = pickBatches(o.warehouseId, o.productId, o.qty, o.batchId)
  allocs.forEach((a, i) =>
    postTxn(ctx, { warehouseId: o.warehouseId, productId: o.productId, batchId: a.batchId, txnType: 'TRANSFER_OUT', onHand: -a.qty, frozen: 0, source: o.source, seq: i + 1, bizDate: o.bizDate }),
  )
  return allocs
}

/** 销售审批通过后预留；取消未出库部分时释放（docs/07 第 5.3 节） */
export function changeReserve(warehouseId: number, productId: number, delta: number) {
  const db = getDb()
  const countryId = db.warehouses.find((w) => w.id === warehouseId)?.countryId
  if (!countryId) conflict('仓库不存在')
  const s = summaryRow(countryId, warehouseId, productId)
  const next = s.reservedQty + delta
  if (next < 0) conflict('预留数量不能为负')
  if (delta > 0 && s.onHandQty - next - s.frozenQty < 0) {
    conflict(`${product(productId)?.productCode} 可售不足，无法预留 ${delta}（可售 ${s.onHandQty - s.reservedQty - s.frozenQty}）`, 'INV_INSUFFICIENT_AVAILABLE')
  }
  s.reservedQty = next
  s.version += 1
}

/** 销售出库：先释放对应预留，再按先进先出扣实物 */
export function salesOutbound(ctx: Ctx, o: { warehouseId: number; productId: number; qty: number; source: StockSource; bizDate?: string }) {
  changeReserve(o.warehouseId, o.productId, -o.qty)
  const allocs = pickBatches(o.warehouseId, o.productId, o.qty)
  allocs.forEach((a, i) =>
    postTxn(ctx, { warehouseId: o.warehouseId, productId: o.productId, batchId: a.batchId, txnType: 'SALES_OUT', onHand: -a.qty, frozen: 0, source: o.source, seq: i + 1, bizDate: o.bizDate }),
  )
  return allocs
}

/** 销售退货入库：新批次，合格可售，待检或破损冻结 */
export function returnIn(ctx: Ctx, i: { warehouseId: number; productId: number; goodQty: number; frozenQty: number; freezeType: string; source: StockSource; bizDate: string; reason: string; unitCost?: number | null; sourceOutboundLineId?: number }) {
  const total = i.goodQty + i.frozenQty
  if (total <= 0) return []
  const batch = createBatch(ctx, { productId: i.productId, sourceType: 'RETURN', source: i.source, bizDate: i.bizDate })
  createBatchCost(ctx, batch, { warehouseId: i.warehouseId, qty: total, unitCost: i.unitCost, bizDate: i.bizDate, sourceOutboundLineId: i.sourceOutboundLineId })
  postTxn(ctx, { warehouseId: i.warehouseId, productId: i.productId, batchId: batch.id, txnType: 'RETURN_IN', onHand: total, frozen: 0, source: i.source, bizDate: i.bizDate })
  if (i.frozenQty > 0) {
    createFreeze(ctx, { warehouseId: i.warehouseId, productId: i.productId, batchId: batch.id, qty: i.frozenQty, freezeType: i.freezeType, reason: i.reason, sourceType: i.source.type, sourceId: i.source.id, sourceNo: i.source.no, bizDate: i.bizDate })
  }
  return [{ batchId: batch.id, qty: total }]
}

/** 已在 MX 的采购退货：按批次扣减实物，不能只改采购数量 */
export function supplierReturnOut(ctx: Ctx, o: { warehouseId: number; productId: number; qty: number; batchId?: number | null; source: StockSource; bizDate?: string }) {
  const allocs = pickBatches(o.warehouseId, o.productId, o.qty, o.batchId)
  allocs.forEach((a, i) =>
    postTxn(ctx, { warehouseId: o.warehouseId, productId: o.productId, batchId: a.batchId, txnType: 'SUPPLIER_RETURN_OUT', onHand: -a.qty, frozen: 0, source: o.source, seq: i + 1, bizDate: o.bizDate }),
  )
  return allocs
}

/** 调入沿用调出批次，批次与成本随货转移（docs/06 第 5.5 节） */
export function transferIn(ctx: Ctx, o: { warehouseId: number; productId: number; allocs: { batchId: number; qty: number }[]; source: StockSource; seqBase: number; bizDate?: string }) {
  o.allocs.forEach((a, i) =>
    postTxn(ctx, { warehouseId: o.warehouseId, productId: o.productId, batchId: a.batchId, txnType: 'TRANSFER_IN', onHand: a.qty, frozen: 0, source: o.source, seq: o.seqBase + i, bizDate: o.bizDate }),
  )
}

/** 盘点过账：盘亏按先进先出扣减批次，盘盈生成新批次 */
export function adjust(ctx: Ctx, a: { warehouseId: number; productId: number; diff: number; source: StockSource; bizDate: string; unitCost?: number }) {
  if (a.diff < 0) {
    const allocs = pickBatches(a.warehouseId, a.productId, -a.diff)
    allocs.forEach((x, i) =>
      postTxn(ctx, { warehouseId: a.warehouseId, productId: a.productId, batchId: x.batchId, txnType: 'STOCKTAKE_LOSS', onHand: -x.qty, frozen: 0, source: a.source, seq: i + 1, bizDate: a.bizDate, ignoreLock: true }),
    )
  } else if (a.diff > 0) {
    const latest = getDb().inboundCosts.filter(c => c.countryId === ctx.countryId && c.warehouseId === a.warehouseId && c.productId === a.productId && ['CONFIRMED','ADJUSTED'].includes(c.status) && c.unitCost != null && c.bizDate <= a.bizDate).sort((x,y) => y.bizDate.localeCompare(x.bizDate) || y.id-x.id)[0]
    const unitCost = a.unitCost ?? latest?.unitCost
    if (unitCost == null || !Number.isFinite(unitCost) || unitCost < 0) conflict('盘盈缺少有效单位成本，请先补齐该仓商品成本', 'CST_COST_MISSING')
    const batch = createBatch(ctx, { productId: a.productId, sourceType: 'STOCKTAKE_GAIN', source: a.source, bizDate: a.bizDate })
    createBatchCost(ctx, batch, { warehouseId: a.warehouseId, qty: a.diff, unitCost, bizDate: a.bizDate, sourceType: 'STOCKTAKE_GAIN' })
    postTxn(ctx, { warehouseId: a.warehouseId, productId: a.productId, batchId: batch.id, txnType: 'STOCKTAKE_GAIN', onHand: a.diff, frozen: 0, source: a.source, bizDate: a.bizDate, ignoreLock: true })
  }
}

// ---------- 上下限预警（docs/06 第 5.7 节） ----------

export const ALERT_TYPES: Record<string, string> = {
  BELOW_MIN: '低于下限',
  ABOVE_MAX: '高于上限',
  OUT_OF_STOCK: '缺货',
}

export function evaluateAlert(countryId: number, warehouseId: number, productId: number) {
  const db = getDb()
  const limit = db.stockLimits.find((l) => l.warehouseId === warehouseId && l.productId === productId && l.status === 'ACTIVE')
  const { available } = stockOf(warehouseId, productId)
  const hits = new Map<string, number | null>()
  if (limit?.alertEnabled) {
    if (available <= 0) hits.set('OUT_OF_STOCK', 0)
    else if (limit.minQty != null && available < limit.minQty) hits.set('BELOW_MIN', limit.minQty)
    if (limit.maxQty != null && available > limit.maxQty) hits.set('ABOVE_MAX', limit.maxQty)
  }
  const p = product(productId)
  const whName = nameOf(db.warehouses, warehouseId)
  for (const type of Object.keys(ALERT_TYPES)) {
    const open = db.stockAlerts.find((a) => a.warehouseId === warehouseId && a.productId === productId && a.alertType === type && a.status === 'OPEN')
    const dedupKey = `STOCK_ALERT:${warehouseId}:${productId}:${type}`
    if (hits.has(type)) {
      const threshold = hits.get(type)
      if (open) Object.assign(open, { availableQty: available, threshold, lastEvaluatedAt: nowIso(), ownerId: limit?.ownerId ?? null })
      else {
        db.stockAlerts.unshift({
          id: nextId(), countryId, warehouseId, productId, alertType: type, availableQty: available, threshold, status: 'OPEN',
          ownerId: limit?.ownerId ?? null, firstTriggeredAt: nowIso(), lastEvaluatedAt: nowIso(), closedAt: null,
        })
      }
      openTodo({
        countryId, todoType: 'STOCK_ALERT', dedupKey, link: '/inventory/alerts', perm: 'inv:stock:view', assigneeId: limit?.ownerId ?? null,
        title: `${p?.productCode} ${p?.name}：${whName}${ALERT_TYPES[type]}（可售 ${available}${threshold != null && type !== 'OUT_OF_STOCK' ? `，${type === 'BELOW_MIN' ? '下限' : '上限'} ${threshold}` : ''}）`,
      })
    } else if (open) {
      Object.assign(open, { status: 'CLOSED', availableQty: available, lastEvaluatedAt: nowIso(), closedAt: nowIso() })
      closeTodo(dedupKey, '条件已消失，自动关闭')
    }
  }
}

// ---------- 在途（只展示，不计入实物与可售） ----------

export interface TransitQty {
  intlQty: number
  pendingDeliveryQty: number
  onHoldQty: number
  deliveringQty: number
  transferInQty: number
}

export function transitMap(countryId: number) {
  const db = getDb()
  const map = new Map<string, TransitQty>()
  const get = (wh: number, pid: number) => {
    const k = `${wh}:${pid}`
    if (!map.has(k)) map.set(k, { intlQty: 0, pendingDeliveryQty: 0, onHoldQty: 0, deliveringQty: 0, transferInQty: 0 })
    return map.get(k)!
  }
  for (const sh of db.shipments.filter((s) => s.countryId === countryId)) {
    for (const l of sh.lines) {
      if (!l.shippedQty) continue
      const t = get(sh.destWarehouseId, l.productId)
      t.intlQty += l.intlQty
      t.pendingDeliveryQty += l.pendingDeliveryQty
      t.onHoldQty += l.onHoldQty
      t.deliveringQty += l.deliveringQty
    }
  }
  for (const tr of db.transfers.filter((x) => x.countryId === countryId && ['IN_TRANSIT', 'PARTIAL_RECEIVED'].includes(x.status))) {
    for (const l of tr.lines) get(tr.toWarehouseId, l.productId).transferInQty += l.shippedQty - l.receivedQty - l.diffQty
  }
  return map
}
