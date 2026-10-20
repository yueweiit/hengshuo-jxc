/* eslint-disable @typescript-eslint/no-explicit-any */
/**
 * 06 库存管理（第 2 批范围）：库存查询、流水、冻结、调拨、盘点、上下限与预警。
 * 可售 = 实物 − 预留 − 冻结；在途（国际在途、当地待派送、暂缓、派送在途、调拨在途）单独展示。
 */
import { http } from 'msw'
import { getDb, nextId, nowIso, type Row } from '../db'
import { API, crud, findOr404 } from '../crud'
import { audit, checkVersion, handle, inScope, paginate, requireCountry, requirePerm, type Ctx } from '../utils'
import { onApproval, submitApproval } from '../services/approval'
import {
  ALERT_TYPES, FREEZE_TYPES, TXN_TYPES, adjust, createFreeze, evaluateAlert, pickBatches, releaseFreeze, stockOf, transferIn, transferOut, transitMap,
} from '../services/inventory'
import {
  assertSkuEnabled, bad, closeTodo, conflict, costVisible, docNo, nameOf, num, openTodo, product, sum, today, userName, warehouseOf, withProduct,
} from '../services/common'

const WH_SCOPE = { warehouseField: 'warehouseId' }

function scopedWarehouses(ctx: Ctx) {
  return getDb().warehouses.filter((w) => w.countryId === ctx.countryId && w.status === 'ENABLED' && inScope(ctx, w, { warehouseField: 'id', storeField: 'storeId' }))
}

function assertWarehouseScope(ctx: Ctx, warehouseId: number) {
  const wh = warehouseOf(ctx.countryId!, warehouseId)
  if (!scopedWarehouses(ctx).some((w) => w.id === wh.id)) conflict(`没有仓库“${wh.name}”的数据范围`, 'SYS_FORBIDDEN')
  return wh
}

function activeFrozenByType(warehouseId: number, productId: number) {
  const out: Record<string, number> = {}
  for (const f of getDb().invFreezes.filter((x) => x.warehouseId === warehouseId && x.productId === productId && x.status !== 'RELEASED')) {
    out[f.freezeType] = (out[f.freezeType] ?? 0) + f.qty - f.releasedQty
  }
  return out
}

// ---------- 库存查询 ----------

const stocks = http.get(`${API}/inv/stocks`, handle((ctx) => {
  requirePerm(ctx, 'inv:stock:view')
  const countryId = requireCountry(ctx)
  const db = getDb()
  const sp = ctx.url.searchParams
  const whs = scopedWarehouses(ctx).filter((w) => !sp.get('warehouseId') || String(w.id) === sp.get('warehouseId'))
  const transit = transitMap(countryId)
  const keys = new Set<string>()
  for (const w of whs) {
    for (const s of db.invSummaries.filter((x) => x.warehouseId === w.id)) keys.add(`${w.id}:${s.productId}`)
    for (const l of db.stockLimits.filter((x) => x.warehouseId === w.id && x.status === 'ACTIVE')) keys.add(`${w.id}:${l.productId}`)
    for (const k of transit.keys()) if (k.startsWith(`${w.id}:`)) keys.add(k)
  }
  const keyword = sp.get('keyword')?.toLowerCase()
  const rows = [...keys]
    .map((k) => {
      const [wh, pid] = k.split(':').map(Number)
      const p = product(pid)!
      const s = stockOf(wh, pid)
      const t = transit.get(k)
      const limit = db.stockLimits.find((l) => l.warehouseId === wh && l.productId === pid && l.status === 'ACTIVE')
      return withProduct({
        id: k, warehouseId: wh, warehouseName: nameOf(db.warehouses, wh), warehouseType: db.warehouses.find((w) => w.id === wh)?.type,
        productId: pid, categoryId: p.categoryId, spec: p.spec, barcodeText: p.barcodeText,
        onHandQty: s.onHand, reservedQty: s.reserved, frozenQty: s.frozen, availableQty: s.available, frozenByType: activeFrozenByType(wh, pid),
        intlQty: t?.intlQty ?? 0, pendingDeliveryQty: t?.pendingDeliveryQty ?? 0, onHoldQty: t?.onHoldQty ?? 0, deliveringQty: t?.deliveringQty ?? 0,
        transferInQty: t?.transferInQty ?? 0, minQty: limit?.minQty ?? null, maxQty: limit?.maxQty ?? null,
        alerts: db.stockAlerts.filter((a) => a.warehouseId === wh && a.productId === pid && a.status === 'OPEN').map((a) => a.alertType),
        batchCount: db.invBatchBalances.filter((b) => b.warehouseId === wh && b.productId === pid && b.onHandQty > 0).length,
        locked: db.stocktakes.some((st) => st.warehouseId === wh && ['COUNTING', 'SUBMITTED', 'APPROVED'].includes(st.status) && st.lines.some((l: Row) => l.productId === pid)),
      })
    })
    .filter((r) => !keyword || [r.productCode, r.productName, r.barcodeText].some((v) => String(v).toLowerCase().includes(keyword)))
    .filter((r) => !sp.get('categoryId') || String(r.categoryId) === sp.get('categoryId'))
    .filter((r) => !sp.get('alert') || r.alerts.length > 0)
    .sort((a, b) => a.warehouseName.localeCompare(b.warehouseName) || a.productCode.localeCompare(b.productCode))
  return paginate(rows, ctx.url)
}))

function batchView(ctx: Ctx, b: Row) {
  const db = getDb()
  const batch = db.invBatches.find((x) => x.id === b.batchId)!
  const cost = batch.costId ? db.inboundCosts.find((c) => c.id === batch.costId) : null
  const showCost = costVisible(ctx)
  const sh = db.shipments.find((s) => s.id === batch.shipmentId)
  return {
    ...b, batchNo: batch.batchNo, sourceType: batch.sourceType, sourceNo: batch.sourceNo, firstInboundDate: batch.firstInboundDate,
    shipmentNo: sh?.docNo ?? '', costStatus: cost?.status ?? (batch.sourceType === 'STOCKTAKE_GAIN' ? 'MANUAL' : null),
    unitCost: showCost ? cost?.unitCost ?? null : undefined, baseCurrency: cost?.baseCurrency,
  }
}

const batches = http.get(`${API}/inv/stocks/:warehouseId/:productId/batches`, handle((ctx, { params }) => {
  requirePerm(ctx, 'inv:stock:view')
  requireCountry(ctx)
  const wh = assertWarehouseScope(ctx, Number(params.warehouseId))
  return getDb().invBatchBalances
    .filter((b) => b.warehouseId === wh.id && b.productId === Number(params.productId) && (b.onHandQty > 0 || ctx.url.searchParams.get('all') === 'true'))
    .map((b) => batchView(ctx, b))
    .sort((a, b) => a.firstInboundDate.localeCompare(b.firstInboundDate))
}))

// ---------- 流水 ----------

const txns = crud('/inv/txns', 'invTxns', {
  viewPerm: 'inv:txn:view',
  scope: WH_SCOPE,
  keywordKeys: ['sourceNo'],
  filterKeys: ['warehouseId', 'productId', 'txnType', 'sourceType', 'batchId'],
  filter: (r, ctx) => {
    const sp = ctx.url.searchParams
    return (!sp.get('dateFrom') || r.bizDate >= sp.get('dateFrom')!) && (!sp.get('dateTo') || r.bizDate <= sp.get('dateTo')!)
  },
  out: (r, ctx) => {
    const db = getDb()
    const out: Row = withProduct({
      ...r, txnTypeLabel: TXN_TYPES[r.txnType] ?? r.txnType, warehouseName: nameOf(db.warehouses, r.warehouseId),
      batchNo: db.invBatches.find((b) => b.id === r.batchId)?.batchNo ?? '', operatorName: userName(r.operatorId),
    })
    if (!costVisible(ctx)) delete out.unitCost
    return out
  },
})

// ---------- 冻结 ----------

function freezeOut(f: Row) {
  const db = getDb()
  return withProduct({
    ...f, freezeTypeLabel: FREEZE_TYPES[f.freezeType] ?? f.freezeType, warehouseName: nameOf(db.warehouses, f.warehouseId),
    batchNo: db.invBatches.find((b) => b.id === f.batchId)?.batchNo ?? '', activeQty: f.qty - f.releasedQty, createdByName: userName(f.createdBy),
  })
}

const freezes = crud('/inv/freezes', 'invFreezes', {
  viewPerm: ['inv:freeze:create', 'inv:freeze:release', 'inv:stock:view'],
  scope: WH_SCOPE,
  keywordKeys: ['docNo', 'sourceNo', 'reason'],
  filterKeys: ['status', 'warehouseId', 'freezeType', 'productId'],
  out: freezeOut,
})

const freezeExtras = [
  http.post(`${API}/inv/freezes`, handle((ctx, { body }) => {
    requirePerm(ctx, 'inv:freeze:create')
    requireCountry(ctx)
    const wh = assertWarehouseScope(ctx, Number(body?.warehouseId))
    const p = assertSkuEnabled(ctx.countryId!, Number(body.productId))
    const qty = num(body.qty)
    if (!(qty > 0)) bad('冻结数量必须大于 0')
    if (!body.reason) bad('请填写冻结原因')
    const allocs = pickBatches(wh.id, p.id, qty, body.batchId || null)
    const rows = allocs.map((a) => createFreeze(ctx, { warehouseId: wh.id, productId: p.id, batchId: a.batchId, qty: a.qty, freezeType: 'MANUAL', reason: body.reason, sourceType: 'MANUAL', sourceId: null, sourceNo: '' }))
    audit(ctx, '手工冻结', 'inv-freeze', rows[0].id, null, { warehouseId: wh.id, productId: p.id, qty, reason: body.reason })
    return rows.map(freezeOut)
  })),
  http.post(`${API}/inv/freezes/:id/release`, handle((ctx, { params, body }) => {
    requirePerm(ctx, 'inv:freeze:release')
    const f = findOr404(ctx, 'invFreezes', Number(params.id), { scope: WH_SCOPE })
    if (!body?.remark) bad('请填写解冻说明')
    releaseFreeze(ctx, f, num(body.qty), body.remark)
    audit(ctx, '解冻', 'inv-freeze', f.id, null, { qty: body.qty, remark: body.remark })
    return freezeOut(f)
  })),
]

// ---------- 调拨 ----------

function transferView(t: Row) {
  const db = getDb()
  return {
    ...t, fromWarehouseName: nameOf(db.warehouses, t.fromWarehouseId), toWarehouseName: nameOf(db.warehouses, t.toWarehouseId), createdByName: userName(t.createdBy),
    totalQty: sum(t.lines, (l: Row) => l.qty), shippedQty: sum(t.lines, (l: Row) => l.shippedQty), receivedQty: sum(t.lines, (l: Row) => l.receivedQty),
    inTransitQty: sum(t.lines, (l: Row) => l.shippedQty - l.receivedQty - l.diffQty), diffQty: sum(t.lines, (l: Row) => l.diffQty),
    productSummary: t.lines.map((l: Row) => product(l.productId)?.productCode).join('、'),
    lines: t.lines.map((l: Row) => withProduct({ ...l, availableAtFrom: stockOf(t.fromWarehouseId, l.productId).available, remainingQty: l.shippedQty - l.receivedQty - l.diffQty, barcodeText: product(l.productId)?.barcodeText ?? '' })),
  }
}

const transferScope = (ctx: Ctx, t: Row) => inScope(ctx, t, { warehouseField: 'fromWarehouseId' }) || inScope(ctx, t, { warehouseField: 'toWarehouseId' })

function findTransfer(ctx: Ctx, id: string) {
  return findOr404(ctx, 'transfers', Number(id), { canAccess: (row) => transferScope(ctx, row) })
}

function buildTransfer(ctx: Ctx, body: Row) {
  const countryId = ctx.countryId!
  const from = assertWarehouseScope(ctx, Number(body?.fromWarehouseId))
  const to = warehouseOf(countryId, Number(body.toWarehouseId))
  if (from.id === to.id) bad('调出仓与调入仓不能相同')
  const lines = (body.lines ?? []).map((l: Row, i: number) => {
    const p = assertSkuEnabled(countryId, Number(l.productId))
    if (!(num(l.qty) > 0)) bad(`第 ${i + 1} 行数量必须大于 0`)
    return { id: nextId(), productId: p.id, batchId: l.batchId || null, qty: num(l.qty), shippedQty: 0, receivedQty: 0, diffQty: 0, diffResolution: null, allocs: [] as Row[], received: {} as Record<string, number>, inSeq: 0 }
  })
  if (!lines.length) bad('至少需要一行商品')
  return { fromWarehouseId: from.id, toWarehouseId: to.id, plannedDate: body.plannedDate || today(countryId), remark: body.remark ?? '', lines }
}

export function createTransfer(ctx: Ctx, body: Row): Row {
  requirePerm(ctx, 'inv:transfer:create')
  const data = buildTransfer(ctx, body)
  const t: Row = { ...data, id: nextId(), countryId: ctx.countryId, docNo: docNo(ctx.countryId!, 'TR', data.plannedDate), status: 'DRAFT', shippedAt: null, receivedAt: null, approvalInstanceId: null, replenishId: null, version: 1, createdBy: ctx.user.id, createdAt: nowIso() }
  getDb().transfers.unshift(t)
  audit(ctx, '新增', 'transfer', t.id, null, t)
  if (body.submit) submitTransfer(ctx, t)
  return t
}

export function submitTransfer(ctx: Ctx, t: Row) {
  requirePerm(ctx, 'inv:transfer:create')
  if (t.status !== 'DRAFT') conflict('只有草稿可以提交')
  const r = submitApproval(ctx, { docType: 'TRANSFER', docId: t.id, docNo: t.docNo, docTitle: `${nameOf(getDb().warehouses, t.fromWarehouseId)} → ${nameOf(getDb().warehouses, t.toWarehouseId)}`, facts: { qty: sum(t.lines, (l: Row) => l.qty) } })
  t.approvalInstanceId = r.instance?.id ?? null
  t.status = r.status === 'APPROVED' ? 'APPROVED' : 'PENDING_APPROVAL'
  t.version += 1
  audit(ctx, '提交', 'transfer', t.id, null, { status: t.status, approval: r.message })
  return { ...t, approvalMessage: r.message }
}

onApproval('TRANSFER', {
  onApproved: (inst) => {
    const t = getDb().transfers.find((x) => x.id === inst.docId)
    if (t?.status === 'PENDING_APPROVAL') Object.assign(t, { status: 'APPROVED', version: t.version + 1 })
  },
  onRejected: (inst) => {
    const t = getDb().transfers.find((x) => x.id === inst.docId)
    if (t?.status === 'PENDING_APPROVAL') Object.assign(t, { status: 'DRAFT', version: t.version + 1 })
  },
  onWithdrawn: (inst) => {
    const t = getDb().transfers.find((x) => x.id === inst.docId)
    if (t?.status === 'PENDING_APPROVAL') Object.assign(t, { status: 'DRAFT', version: t.version + 1 })
  },
})

/** 调出：扣减调出仓实物，形成调拨在途；幂等 */
export function shipTransfer(ctx: Ctx, t: Row, body: Row) {
  requirePerm(ctx, 'inv:transfer:ship')
  if (['IN_TRANSIT', 'PARTIAL_RECEIVED', 'RECEIVED', 'CLOSED'].includes(t.status)) return t
  if (t.status !== 'APPROVED') conflict('调拨单尚未审批通过')
  assertWarehouseScope(ctx, t.fromWarehouseId)
  const bizDate = body?.bizDate || today(t.countryId)
  for (const l of t.lines) {
    l.allocs = transferOut(ctx, { warehouseId: t.fromWarehouseId, productId: l.productId, qty: l.qty, batchId: l.batchId, source: { type: 'INV_TRANSFER', id: t.id, lineId: l.id, no: t.docNo }, bizDate })
    l.shippedQty = l.qty
  }
  Object.assign(t, { status: 'IN_TRANSIT', shippedAt: body?.shippedAt || nowIso(), shippedBy: ctx.user.id, version: t.version + 1 })
  openTodo({ countryId: t.countryId, todoType: 'PENDING_RECEIPT', dedupKey: `INV_TRANSFER:${t.id}`, title: `调拨单 ${t.docNo} 待实收（${nameOf(getDb().warehouses, t.toWarehouseId)}）`, link: '/inventory/transfers?status=IN_TRANSIT', perm: 'inv:transfer:receive' })
  audit(ctx, '调出（INV_TRANSFER_SHIPPED）', 'transfer', t.id, null, { lines: t.lines.map((l: Row) => ({ productId: l.productId, allocs: l.allocs })) })
  return t
}

/** 实收：可以部分实收；批次沿用调出批次；幂等键防重复 */
export function receiveTransfer(ctx: Ctx, t: Row, body: Row, idemKey?: string | null) {
  requirePerm(ctx, 'inv:transfer:receive')
  const db = getDb()
  if (idemKey && db.idempotency[idemKey]) return { ...t, duplicate: true }
  if (!['IN_TRANSIT', 'PARTIAL_RECEIVED'].includes(t.status)) conflict('调拨单不在在途状态')
  assertWarehouseScope(ctx, t.toWarehouseId)
  const items = (body?.lines ?? []).filter((x: Row) => num(x.qty) > 0)
  if (!items.length) bad('请填写实收数量')
  const bizDate = body.bizDate || today(t.countryId)
  for (const it of items) {
    const l = t.lines.find((x: Row) => x.id === it.lineId)
    if (!l) bad('调拨行不存在')
    const remain = l.shippedQty - l.receivedQty - l.diffQty
    let need = num(it.qty)
    if (need > remain) bad(`${product(l.productId)?.productCode} 实收不能超过在途 ${remain}`)
    const take: { batchId: number; qty: number }[] = []
    const nextReceived = { ...l.received }
    for (const a of l.allocs) {
      const left = a.qty - (nextReceived[a.batchId] ?? 0)
      if (left <= 0 || need <= 0) continue
      const q = Math.min(left, need)
      take.push({ batchId: a.batchId, qty: q })
      nextReceived[a.batchId] = (nextReceived[a.batchId] ?? 0) + q
      need -= q
    }
    if (need > 0.000001) conflict('调拨批次分配不足，请先核对原调出记录，不能按请求数量直接确认实收', 'INV_TRANSFER_ALLOCATION_INCOMPLETE')
    transferIn(ctx, { warehouseId: t.toWarehouseId, productId: l.productId, allocs: take, source: { type: 'INV_TRANSFER', id: t.id, lineId: l.id, no: t.docNo }, seqBase: l.inSeq + 1, bizDate })
    l.received = nextReceived
    l.inSeq += take.length
    l.receivedQty += num(it.qty)
  }
  const done = t.lines.every((l: Row) => l.receivedQty + l.diffQty >= l.shippedQty)
  Object.assign(t, { status: done ? 'RECEIVED' : 'PARTIAL_RECEIVED', receivedAt: nowIso(), receivedBy: ctx.user.id, version: t.version + 1 })
  if (done) closeTodo(`INV_TRANSFER:${t.id}`, '已实收')
  if (idemKey) db.idempotency[idemKey] = t.id
  audit(ctx, '调拨实收（INV_TRANSFER_RECEIVED）', 'transfer', t.id, null, { lines: items })
  return t
}

function closeTransfer(ctx: Ctx, t: Row, body: Row) {
  requirePerm(ctx, 'inv:transfer:receive')
  if (!['PARTIAL_RECEIVED', 'RECEIVED'].includes(t.status)) conflict('只有部分实收或已实收的调拨单可以关闭')
  if (!body?.reason) bad('请填写差异原因')
  for (const l of t.lines) {
    const rest = l.shippedQty - l.receivedQty - l.diffQty
    if (rest > 0) {
      l.diffQty += rest
      l.diffResolution = body.resolution || 'LOSS_PENDING'
    }
  }
  Object.assign(t, { status: 'CLOSED', closeReason: body.reason, closedAt: nowIso(), version: t.version + 1 })
  closeTodo(`INV_TRANSFER:${t.id}`, '差异已登记并关闭')
  audit(ctx, '关闭（登记调拨差异）', 'transfer', t.id, null, { reason: body.reason, diff: t.lines.map((l: Row) => ({ productId: l.productId, diffQty: l.diffQty })) })
  return t
}

const transfers = crud('/inv/transfers', 'transfers', {
  viewPerm: ['inv:transfer:create', 'inv:transfer:ship', 'inv:transfer:receive', 'inv:stock:view'],
  keywordKeys: ['docNo', 'remark'],
  filterKeys: ['status', 'fromWarehouseId', 'toWarehouseId'],
  canAccess: (r, ctx) => transferScope(ctx, r),
  out: transferView,
})

const transferExtras = [
  http.post(`${API}/inv/transfers`, handle((ctx, { body }) => {
    requireCountry(ctx)
    return transferView(createTransfer(ctx, body))
  })),
  http.put(`${API}/inv/transfers/:id`, handle((ctx, { params, body }) => {
    requirePerm(ctx, 'inv:transfer:create')
    const t = findTransfer(ctx, params.id)
    checkVersion(t, body)
    if (t.status !== 'DRAFT') conflict('只有草稿可以修改')
    Object.assign(t, buildTransfer(ctx, body), { version: t.version + 1 })
    return transferView(t)
  })),
  http.post(`${API}/inv/transfers/:id/submit`, handle((ctx, { params }) => transferView(submitTransfer(ctx, findTransfer(ctx, params.id))))),
  http.post(`${API}/inv/transfers/:id/ship`, handle((ctx, { params, body }) => transferView(shipTransfer(ctx, findTransfer(ctx, params.id), body)))),
  http.post(`${API}/inv/transfers/:id/receive`, handle((ctx, { params, body }) => transferView(receiveTransfer(ctx, findTransfer(ctx, params.id), body, ctx.request.headers.get('Idempotency-Key'))))),
  http.post(`${API}/inv/transfers/:id/close`, handle((ctx, { params, body }) => transferView(closeTransfer(ctx, findTransfer(ctx, params.id), body)))),
  http.post(`${API}/inv/transfers/:id/void`, handle((ctx, { params }) => {
    requirePerm(ctx, 'inv:transfer:create')
    const t = findTransfer(ctx, params.id)
    if (t.status !== 'DRAFT') conflict('只有草稿可以作废')
    t.status = 'CANCELLED'
    t.version += 1
    return transferView(t)
  })),
]

// ---------- 盘点 ----------

function stocktakeView(st: Row) {
  const db = getDb()
  const counted = st.lines.filter((l: Row) => l.countedQty != null)
  return {
    ...st, warehouseName: nameOf(db.warehouses, st.warehouseId), categoryName: nameOf(db.categories, st.categoryId), createdByName: userName(st.createdBy),
    lineCount: st.lines.length, countedCount: counted.length, diffLineCount: counted.filter((l: Row) => l.countedQty !== l.bookQty).length,
    gainQty: sum(counted, (l: Row) => Math.max(0, l.countedQty - l.bookQty)), lossQty: sum(counted, (l: Row) => Math.max(0, l.bookQty - l.countedQty)),
    lines: st.lines.map((l: Row) => withProduct({ ...l, diffQty: l.countedQty == null ? null : l.countedQty - l.bookQty, barcodeText: product(l.productId)?.barcodeText ?? '' })),
  }
}

const findStocktake = (ctx: Ctx, id: string) => findOr404(ctx, 'stocktakes', Number(id), { scope: WH_SCOPE })

export function createStocktake(ctx: Ctx, body: Row) {
  requirePerm(ctx, 'inv:stocktake:create')
  const wh = assertWarehouseScope(ctx, Number(body?.warehouseId))
  const st: Row = {
    id: nextId(), countryId: ctx.countryId, docNo: docNo(ctx.countryId!, 'ST'), warehouseId: wh.id, categoryId: body.categoryId || null,
    productIds: body.productIds ?? [], remark: body.remark ?? '', status: 'DRAFT', snapshotAt: null, lines: [], approvalInstanceId: null,
    version: 1, createdBy: ctx.user.id, createdAt: nowIso(),
  }
  getDb().stocktakes.unshift(st)
  audit(ctx, '新增', 'stocktake', st.id, null, st)
  return st
}

/** 开始盘点：生成账面快照并锁定范围内 SKU */
export function startStocktake(ctx: Ctx, st: Row) {
  requirePerm(ctx, 'inv:stocktake:create')
  if (st.status !== 'DRAFT') conflict('只有草稿可以开始盘点')
  const db = getDb()
  const pids = new Set<number>()
  for (const s of db.invSummaries.filter((x) => x.warehouseId === st.warehouseId && x.onHandQty > 0)) pids.add(s.productId)
  for (const sku of db.countrySkus.filter((x) => x.countryId === st.countryId && x.status === 'ENABLED')) pids.add(sku.productId)
  const list = [...pids]
    .filter((pid) => !st.categoryId || product(pid)?.categoryId === st.categoryId)
    .filter((pid) => !st.productIds?.length || st.productIds.includes(pid))
  if (!list.length) bad('盘点范围内没有商品')
  const busy = db.stocktakes.find((x) => x.id !== st.id && x.warehouseId === st.warehouseId && ['COUNTING', 'SUBMITTED', 'APPROVED'].includes(x.status) && x.lines.some((l: Row) => list.includes(l.productId)))
  if (busy) conflict(`盘点范围与进行中的 ${busy.docNo} 重叠`)
  st.lines = list.map((pid) => ({ id: nextId(), productId: pid, batchId: null, bookQty: stockOf(st.warehouseId, pid).onHand, countedQty: null, reason: '' }))
  Object.assign(st, { status: 'COUNTING', snapshotAt: nowIso(), version: st.version + 1 })
  audit(ctx, '开始盘点（锁定范围）', 'stocktake', st.id, null, { lines: st.lines.length })
  return st
}

export function saveCounts(ctx: Ctx, st: Row, body: Row) {
  requirePerm(ctx, 'inv:stocktake:count')
  if (st.status !== 'COUNTING') conflict('只有盘点中的单据可以录入实盘')
  for (const it of body?.lines ?? []) {
    const l = st.lines.find((x: Row) => x.id === it.id)
    if (!l) continue
    if (it.countedQty !== undefined) {
      if (it.countedQty === null || it.countedQty === '') l.countedQty = null
      else if (num(it.countedQty) < 0) bad('实盘数量不能为负数')
      else l.countedQty = num(it.countedQty)
    }
    if (it.reason !== undefined) l.reason = it.reason
  }
  st.version += 1
  return st
}

export function submitStocktake(ctx: Ctx, st: Row) {
  requirePerm(ctx, 'inv:stocktake:submit')
  if (st.status !== 'COUNTING') conflict('只有盘点中的单据可以提交')
  const missing = st.lines.filter((l: Row) => l.countedQty == null)
  if (missing.length) bad(`还有 ${missing.length} 个商品没有录入实盘数量`)
  const diffs = st.lines.filter((l: Row) => l.countedQty !== l.bookQty)
  if (diffs.some((l: Row) => !l.reason)) bad('有差异的行必须填写差异原因')
  let message = '没有差异，已直接通过'
  if (!diffs.length) st.status = 'APPROVED'
  else {
    const r = submitApproval(ctx, { docType: 'STOCKTAKE', docId: st.id, docNo: st.docNo, docTitle: `${nameOf(getDb().warehouses, st.warehouseId)} 盘点差异 ${diffs.length} 行`, facts: { diffQty: sum(diffs, (l: Row) => Math.abs(l.countedQty - l.bookQty)) } })
    st.approvalInstanceId = r.instance?.id ?? null
    st.status = r.status === 'APPROVED' ? 'APPROVED' : 'SUBMITTED'
    message = r.message
  }
  st.version += 1
  audit(ctx, '提交盘点', 'stocktake', st.id, null, { status: st.status, diffLines: diffs.length })
  return { ...st, approvalMessage: message }
}

onApproval('STOCKTAKE', {
  onApproved: (inst) => {
    const st = getDb().stocktakes.find((x) => x.id === inst.docId)
    if (st?.status === 'SUBMITTED') Object.assign(st, { status: 'APPROVED', version: st.version + 1 })
  },
  onRejected: (inst) => {
    const st = getDb().stocktakes.find((x) => x.id === inst.docId)
    if (st?.status === 'SUBMITTED') Object.assign(st, { status: 'COUNTING', version: st.version + 1 })
  },
  onWithdrawn: (inst) => {
    const st = getDb().stocktakes.find((x) => x.id === inst.docId)
    if (st?.status === 'SUBMITTED') Object.assign(st, { status: 'COUNTING', version: st.version + 1 })
  },
})

/** 过账：差异审批后才生成盘盈盘亏流水，不能直接改余额 */
export function postStocktake(ctx: Ctx, st: Row) {
  requirePerm(ctx, ['inv:stocktake:approve', 'inv:stocktake:submit'])
  if (st.status === 'POSTED') return st
  if (st.status !== 'APPROVED') conflict('盘点差异尚未审批通过')
  const bizDate = today(st.countryId)
  for (const l of st.lines) {
    const diff = l.countedQty - l.bookQty
    if (diff) adjust(ctx, { warehouseId: st.warehouseId, productId: l.productId, diff, source: { type: 'INV_STOCKTAKE', id: st.id, lineId: l.id, no: st.docNo }, bizDate })
  }
  Object.assign(st, { status: 'POSTED', postedAt: nowIso(), postedBy: ctx.user.id, version: st.version + 1 })
  audit(ctx, '过账（INV_STOCKTAKE_POSTED）', 'stocktake', st.id, null, { lines: st.lines.filter((l: Row) => l.countedQty !== l.bookQty).map((l: Row) => ({ productId: l.productId, diff: l.countedQty - l.bookQty })) })
  return st
}

const stocktakes = crud('/inv/stocktakes', 'stocktakes', {
  viewPerm: ['inv:stocktake:create', 'inv:stocktake:count', 'inv:stocktake:approve', 'inv:stock:view'],
  scope: WH_SCOPE,
  keywordKeys: ['docNo', 'remark'],
  filterKeys: ['status', 'warehouseId'],
  out: stocktakeView,
})

const stocktakeExtras = [
  http.post(`${API}/inv/stocktakes`, handle((ctx, { body }) => {
    requireCountry(ctx)
    const st = createStocktake(ctx, body)
    return stocktakeView(body?.start ? startStocktake(ctx, st) : st)
  })),
  http.put(`${API}/inv/stocktakes/:id`, handle((ctx, { params, body }) => {
    requirePerm(ctx, 'inv:stocktake:create')
    const st = findStocktake(ctx, params.id)
    if (st.status !== 'DRAFT') conflict('只有草稿可以修改范围')
    const wh = assertWarehouseScope(ctx, Number(body?.warehouseId ?? st.warehouseId))
    Object.assign(st, { warehouseId: wh.id, categoryId: body.categoryId || null, remark: body.remark ?? st.remark, version: st.version + 1 })
    return stocktakeView(st)
  })),
  http.put(`${API}/inv/stocktakes/:id/lines`, handle((ctx, { params, body }) => stocktakeView(saveCounts(ctx, findStocktake(ctx, params.id), body)))),
  ...(['start', 'submit', 'post', 'cancel'] as const).map((action) =>
    http.post(`${API}/inv/stocktakes/:id/${action}`, handle((ctx, { params }) => {
      const st = findStocktake(ctx, params.id)
      if (action === 'start') return stocktakeView(startStocktake(ctx, st))
      if (action === 'submit') return stocktakeView(submitStocktake(ctx, st))
      if (action === 'post') return stocktakeView(postStocktake(ctx, st))
      requirePerm(ctx, 'inv:stocktake:create')
      if (!['DRAFT', 'COUNTING'].includes(st.status)) conflict('已提交的盘点不能取消')
      Object.assign(st, { status: 'CANCELLED', version: st.version + 1 })
      audit(ctx, '取消盘点（解除锁定）', 'stocktake', st.id, null, null)
      return stocktakeView(st)
    })),
  ),
]

// ---------- 上下限与预警 ----------

const limitsGet = http.get(`${API}/inv/limits`, handle((ctx) => {
  requirePerm(ctx, ['inv:limit:config', 'inv:stock:view'])
  const countryId = requireCountry(ctx)
  const db = getDb()
  const sp = ctx.url.searchParams
  const whs = scopedWarehouses(ctx).filter((w) => !sp.get('warehouseId') || String(w.id) === sp.get('warehouseId'))
  const skus = db.countrySkus.filter((s) => s.countryId === countryId && s.status === 'ENABLED')
  const keyword = sp.get('keyword')?.toLowerCase()
  const rows = whs.flatMap((w) =>
    skus.map((s) => {
      const l = db.stockLimits.find((x) => x.warehouseId === w.id && x.productId === s.productId && x.status === 'ACTIVE')
      const st = stockOf(w.id, s.productId)
      return withProduct({
        id: `${w.id}:${s.productId}`, warehouseId: w.id, warehouseName: w.name, productId: s.productId, minQty: l?.minQty ?? null, maxQty: l?.maxQty ?? null,
        alertEnabled: l?.alertEnabled ?? false, ownerId: l?.ownerId ?? null, ownerName: userName(l?.ownerId), versionNo: l?.versionNo ?? 0,
        onHandQty: st.onHand, availableQty: st.available, configured: !!l,
        alerts: db.stockAlerts.filter((a) => a.warehouseId === w.id && a.productId === s.productId && a.status === 'OPEN').map((a) => a.alertType),
      })
    }),
  ).filter((r) => !keyword || [r.productCode, r.productName].some((v) => String(v).toLowerCase().includes(keyword)))
    .filter((r) => sp.get('configured') !== 'true' || r.configured)
  return paginate(rows, ctx.url)
}))

const limitsPut = http.put(`${API}/inv/limits`, handle((ctx, { body }) => {
  requirePerm(ctx, 'inv:limit:config')
  const countryId = requireCountry(ctx)
  const db = getDb()
  const items: Row[] = body?.items ?? []
  if (!items.length) bad('没有要保存的设置')
  for (const it of items) {
    const wh = assertWarehouseScope(ctx, Number(it.warehouseId))
    const p = assertSkuEnabled(countryId, Number(it.productId))
    const min = it.minQty === '' || it.minQty == null ? null : num(it.minQty)
    const max = it.maxQty === '' || it.maxQty == null ? null : num(it.maxQty)
    if ((min != null && min < 0) || (max != null && max < 0)) bad(`${p.productCode}（${wh.name}）上下限不能为负数`)
    if (min != null && max != null && min > max) bad(`${p.productCode}（${wh.name}）下限不能高于上限`, 'INV_LIMIT_INVALID')
    const cur = db.stockLimits.find((x) => x.warehouseId === wh.id && x.productId === p.id && x.status === 'ACTIVE')
    const next = { minQty: min, maxQty: max, alertEnabled: !!it.alertEnabled, ownerId: it.ownerId || null }
    if (cur && ['minQty', 'maxQty', 'alertEnabled', 'ownerId'].every((k) => cur[k] === (next as Row)[k])) continue
    if (cur) Object.assign(cur, { status: 'RETIRED', retiredAt: nowIso() })
    db.stockLimits.push({ id: nextId(), countryId, warehouseId: wh.id, productId: p.id, ...next, versionNo: (cur?.versionNo ?? 0) + 1, status: 'ACTIVE', updatedBy: ctx.user.id, createdAt: nowIso() })
    evaluateAlert(countryId, wh.id, p.id)
  }
  audit(ctx, '设置库存上下限', 'stock-limit', 0, null, { items })
  return { saved: items.length }
}))

const alerts = crud('/inv/alerts', 'stockAlerts', {
  viewPerm: 'inv:stock:view',
  scope: WH_SCOPE,
  keywordKeys: [],
  filterKeys: ['status', 'alertType', 'warehouseId', 'productId'],
  filter: (r, ctx) => {
    const kw = ctx.url.searchParams.get('keyword')?.toLowerCase()
    const p = product(r.productId)
    return !kw || [p?.productCode, p?.name].some((v) => String(v).toLowerCase().includes(kw))
  },
  out: (r) => {
    const db = getDb()
    const st = stockOf(r.warehouseId, r.productId)
    return withProduct({ ...r, alertTypeLabel: ALERT_TYPES[r.alertType], warehouseName: nameOf(db.warehouses, r.warehouseId), ownerName: userName(r.ownerId), currentAvailable: st.available, onHandQty: st.onHand, reservedQty: st.reserved, frozenQty: st.frozen })
  },
})

export const invHandlers = [
  stocks,
  batches,
  ...txns.handlers(),
  ...freezes.handlers(freezeExtras),
  ...transfers.handlers(transferExtras),
  ...stocktakes.handlers(stocktakeExtras),
  limitsGet,
  limitsPut,
  ...alerts.handlers(),
]
