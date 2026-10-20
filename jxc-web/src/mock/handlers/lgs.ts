/* eslint-disable @typescript-eslint/no-explicit-any */
/**
 * 05 国际物流与 MX 实收。
 * 每条批次行满足：发运 = 国际在途 + 当地待派送 + 暂缓 + 派送在途 + 已实收（合格 + 冻结）+ 差异。
 * 运输单草稿不等于实际发运；在途只表示货物位置，不计入实物与可售。
 */
import { http } from 'msw'
import { getDb, nextId, nowIso, type Row } from '../db'
import { API, crud, findOr404 } from '../crud'
import { audit, checkVersion, handle, notFound, paginate, requireCountry, requireDataAccess, requirePerm, type Ctx } from '../utils'
import { canDocumentDataAccess, readableBusinessFields, requireDocumentDataAccess } from '../services/access'
import { onApproval, submitApproval } from '../services/approval'
import { createInboundCost, reconcileActualFee } from '../services/cost'
import { assertPeriodOpen } from '../services/period'
import { inbound } from '../services/inventory'
import {
  bad, closeTodo, conflict, docNo, nameOf, num, onPeriodic, openTodo, product, round, sum, today, userName, warehouseOf, withProduct,
} from '../services/common'
import { onArrived, onShipped, shippableSources } from './pur'

const DELAY_TOLERANCE_HOURS = 24

const RANK: Record<string, number> = {
  DRAFT: 0, PENDING_DISPATCH: 1, IN_TRANSIT: 2, ARRIVED_PORT: 3, PENDING_CLEARANCE: 4, RELEASED: 5,
  PENDING_DELIVERY: 6, ON_HOLD: 6, PARTIAL_RECEIVED: 7, COMPLETED: 8,
}

export const NODE_TYPES: Record<string, string> = {
  DEPARTED: '离港', ARRIVED_PORT: '到港', CUSTOMS_DECLARED: '报关', CUSTOMS_RELEASED: '放行', TRANSSHIPPED: '换柜',
  HOLD: '暂缓', RESUMED: '恢复', DISPATCHED: '派送', RECEIVED: '实收', EXCEPTION: '异常',
}

const BUCKETS = ['intlQty', 'pendingDeliveryQty', 'onHoldQty', 'deliveringQty', 'receivedGoodQty', 'receivedFrozenQty', 'discrepancyQty']

const lineBucketSum = (l: Row) => sum(BUCKETS, (k) => l[k])

function totals(sh: Row) {
  const t: Row = { baseQty: 0, shippedQty: 0 }
  for (const k of BUCKETS) t[k] = 0
  for (const l of sh.lines) {
    t.baseQty += l.baseQty
    t.shippedQty += l.shippedQty
    for (const k of BUCKETS) t[k] += l[k]
  }
  return t
}

function delayInfo(sh: Row) {
  const now = Date.now()
  let stage = ''
  let planned: string | null = null
  if (sh.status === 'PENDING_DISPATCH' && sh.plannedEtd && !sh.actualEtd) {
    stage = '发运'
    planned = sh.plannedEtd
  } else if (sh.status === 'IN_TRANSIT' && sh.plannedEta && !sh.actualEta) {
    stage = '到港'
    planned = sh.plannedEta
  }
  if (!planned) return { delayed: false, delayHours: 0, delayStage: '' }
  const hours = Math.floor((now - Date.parse(`${planned}T23:59:59Z`)) / 3.6e6)
  return { delayed: hours > DELAY_TOLERANCE_HOURS, delayHours: Math.max(0, hours), delayStage: stage }
}

function shipmentOut(sh: Row) {
  const db = getDb()
  const t = totals(sh)
  return {
    ...sh,
    ...delayInfo(sh),
    totals: t,
    carrierName: nameOf(db.partners, sh.carrierId),
    destWarehouseName: nameOf(db.warehouses, sh.destWarehouseId),
    createdByName: userName(sh.createdBy),
    productSummary: [...new Set(sh.lines.map((l: Row) => product(l.productId)?.productCode))].join('、'),
    poNos: [...new Set(sh.lines.map((l: Row) => l.poNo))].join('、'),
    lines: sh.lines.map((l: Row) => withProduct({ ...l, identityOk: !l.shippedQty || lineBucketSum(l) === l.shippedQty })),
    nodes: [...sh.nodes].sort((a, b) => String(a.actualAt ?? a.plannedAt).localeCompare(String(b.actualAt ?? b.plannedAt))).map((n: Row) => ({ ...n, nodeLabel: NODE_TYPES[n.nodeType], operatorName: userName(n.operatorId) })),
  }
}

function pushNode(ctx: Ctx, sh: Row, nodeType: string, n: Row = {}) {
  const row = {
    id: nextId(), nodeType, plannedAt: n.plannedAt ?? null, actualAt: n.actualAt ?? nowIso(), location: n.location ?? '',
    operatorId: ctx.user.id, remark: n.remark ?? '', refType: n.refType ?? null, refId: n.refId ?? null, refNo: n.refNo ?? '',
    correctsEventId: n.correctsEventId ?? null, corrected: false, createdAt: nowIso(),
  }
  sh.nodes.push(row)
  return row
}

function refreshShipmentStatus(sh: Row) {
  if (RANK[sh.status] < RANK.RELEASED) return
  const t = totals(sh)
  const openDisc = getDb().discrepancies.some((d) => d.shipmentId === sh.id && d.status !== 'RESOLVED')
  const moving = t.intlQty + t.pendingDeliveryQty + t.onHoldQty + t.deliveringQty
  const received = t.receivedGoodQty + t.receivedFrozenQty
  if (moving === 0 && received + t.discrepancyQty > 0 && !openDisc) sh.status = 'COMPLETED'
  else if (received > 0) sh.status = 'PARTIAL_RECEIVED'
  else if (t.pendingDeliveryQty === 0 && t.deliveringQty === 0 && t.onHoldQty > 0) sh.status = 'ON_HOLD'
  else sh.status = 'PENDING_DELIVERY'
}

const shipmentOf = (ctx: Ctx, id: number) => {
  const sh = getDb().shipments.find((s) => s.id === id && s.countryId === ctx.countryId)
  if (!sh) notFound()
  requireDocumentDataAccess(ctx, 'SHIPMENT', sh)
  return sh
}

const lineOf = (sh: Row, id: number) => {
  const l = sh.lines.find((x: Row) => x.id === id)
  if (!l) bad('批次行不存在')
  return l
}

/** 同一来源必须合并为一行，创建和执行都校验，防止旧草稿累计超量。 */
function ensureUniqueSourceLines(lines: Row[], key: string) {
  const seen = new Set<string>()
  for (const line of lines) {
    const source = String(line[key])
    if (seen.has(source)) bad('同一来源行不能重复，请合并数量后再提交', 'LGS_DUPLICATE_SOURCE')
    seen.add(source)
  }
}

// ---------- 运输批次 ----------

function buildShipment(ctx: Ctx, body: Row, existing?: Row) {
  const db = getDb()
  const countryId = ctx.countryId!
  const carrier = db.partners.find((p) => p.id === body?.carrierId && p.countryId === countryId)
  if (!carrier || !['LOGISTICS', 'BOTH'].includes(carrier.partnerType)) bad('请选择物流商')
  const wh = warehouseOf(countryId, Number(body.destWarehouseId))
  requireDataAccess(ctx, { countryId, warehouseId: wh.id })
  if (wh.type !== 'WAREHOUSE') bad('目的仓必须是本国的 MX 仓（门店仓通过调拨补货）')
  const mode = body.transportMode
  if (mode === 'SEA') {
    for (const [k, label] of [['vessel', '船名'], ['voyage', '航次'], ['blNo', '提单号'], ['containerNo', '柜号']]) if (!body[k]) bad(`海运需要填写${label}`)
  } else if (mode === 'AIR') {
    for (const [k, label] of [['flightNo', '航班号'], ['awbNo', '航空运单号']]) if (!body[k]) bad(`空运需要填写${label}`)
  } else bad('请选择运输方式')
  const sources = shippableSources(countryId, existing?.id, ctx)
  ensureUniqueSourceLines(body.lines ?? [], 'sourceLineId')
  const lines = (body.lines ?? []).filter((l: Row) => num(l.baseQty) > 0).map((l: Row) => {
    const s = sources.find((x) => x.sourceLineId === l.sourceLineId)
    if (!s) bad('来源行不存在')
    if (num(l.baseQty) > s.remainingQty) bad(`${s.productCode}（${s.sourceNo}）剩余可发运 ${s.remainingQty}`, 'LGS_SOURCE_EXCEEDED')
    const qty = num(l.baseQty)
    return {
      id: nextId(), sourceType: s.sourceType, sourceLineId: s.sourceLineId, sourceNo: s.sourceNo, poId: s.poId, poNo: s.poNo, poLineId: s.poLineId,
      productId: s.productId, baseQty: qty, boxes: num(l.boxes), weight: round(qty * s.unitWeight, 3), volume: round(qty * s.unitVolume, 4),
      shippedQty: 0, ...Object.fromEntries(BUCKETS.map((k) => [k, 0])),
    }
  })
  if (!lines.length) bad('请至少选择一行来源并填写发运数量')
  return {
    carrierId: carrier.id, transportMode: mode, originLocation: body.originLocation ?? '', destWarehouseId: wh.id,
    blNo: mode === 'SEA' ? body.blNo : '', vessel: mode === 'SEA' ? body.vessel : '', voyage: mode === 'SEA' ? body.voyage : '',
    awbNo: mode === 'AIR' ? body.awbNo : '', flightNo: mode === 'AIR' ? body.flightNo : '',
    currentContainerNo: mode === 'SEA' ? body.containerNo : '', currentSealNo: mode === 'SEA' ? body.sealNo ?? '' : '',
    plannedEtd: body.plannedEtd || null, plannedEta: body.plannedEta || null, remark: body.remark ?? '',
    totalBoxes: num(body.totalBoxes) || sum(lines, (l: Row) => l.boxes), grossWeight: round(sum(lines, (l: Row) => l.weight), 3), volume: round(sum(lines, (l: Row) => l.volume), 4),
    lines,
  }
}

export function createShipment(ctx: Ctx, body: Row) {
  requirePerm(ctx, 'lgs:shipment:create')
  const data = buildShipment(ctx, body)
  const sh: Row = {
    ...data, id: nextId(), countryId: ctx.countryId, docNo: docNo(ctx.countryId!, 'SH', data.plannedEtd), status: 'DRAFT',
    actualEtd: null, actualEta: null, nodes: [], containers: [], version: 1, createdBy: ctx.user.id, createdAt: nowIso(), updatedAt: nowIso(),
  }
  if (sh.currentContainerNo) sh.containers.push({ id: nextId(), containerNo: sh.currentContainerNo, sealNo: sh.currentSealNo, activeFrom: nowIso(), activeTo: null, replacedById: null })
  getDb().shipments.unshift(sh)
  audit(ctx, '新增', 'shipment', sh.id, null, sh)
  return body.submit ? submitShipment(ctx, sh) : sh
}

export function submitShipment(ctx: Ctx, sh: Row) {
  requirePerm(ctx, ['lgs:shipment:create', 'lgs:shipment:edit'])
  requireDocumentDataAccess(ctx, 'SHIPMENT', sh)
  if (sh.status !== 'DRAFT') conflict('只有草稿可以提交')
  sh.status = 'PENDING_DISPATCH'
  sh.version += 1
  openTodo({ countryId: sh.countryId, todoType: 'PENDING_DISPATCH', dedupKey: `LGS_DISPATCH:${sh.id}`, title: `运输批次 ${sh.docNo} 待实际发运`, link: `/logistics/shipments/${sh.id}`, perm: 'lgs:shipment:dispatch' })
  audit(ctx, '提交', 'shipment', sh.id, { status: 'DRAFT' }, { status: sh.status })
  return sh
}

/** 实际发运：形成国际在途并回写 04；重复调用不重复回写（幂等） */
export function dispatchShipment(ctx: Ctx, sh: Row, body: Row) {
  requirePerm(ctx, 'lgs:shipment:dispatch')
  requireDocumentDataAccess(ctx, 'SHIPMENT', sh)
  if (RANK[sh.status] >= RANK.IN_TRANSIT) return sh
  if (sh.status !== 'PENDING_DISPATCH') conflict('请先提交运输批次')
  ensureUniqueSourceLines(sh.lines, 'sourceLineId')
  const sources = shippableSources(sh.countryId, sh.id, ctx)
  for (const l of sh.lines) {
    const s = sources.find((x) => x.sourceLineId === l.sourceLineId)
    if (!s || l.baseQty > s.remainingQty) bad(`${product(l.productId)?.productCode} 来源剩余数量不足，请修改批次后再发运`, 'LGS_SOURCE_EXCEEDED')
  }
  const actualEtd = body?.actualEtd || nowIso()
  for (const l of sh.lines) {
    l.shippedQty = l.baseQty
    l.intlQty = l.baseQty
    onShipped(l.sourceLineId, l.baseQty)
  }
  if (sh.containers.length === 1) sh.containers[0].activeFrom = actualEtd
  Object.assign(sh, { status: 'IN_TRANSIT', actualEtd, version: sh.version + 1 })
  pushNode(ctx, sh, 'DEPARTED', { plannedAt: sh.plannedEtd, actualAt: actualEtd, location: body?.location || sh.originLocation, remark: body?.remark })
  closeTodo(`LGS_DISPATCH:${sh.id}`, '已发运')
  audit(ctx, '实际发运（LGS_SHIPMENT_DISPATCHED）', 'shipment', sh.id, null, { actualEtd, qty: totals(sh).shippedQty })
  return sh
}

const MANUAL_NODES = ['ARRIVED_PORT', 'CUSTOMS_DECLARED', 'CUSTOMS_RELEASED', 'EXCEPTION']

export function recordNode(ctx: Ctx, sh: Row, body: Row) {
  requirePerm(ctx, 'lgs:node:record')
  requireDocumentDataAccess(ctx, 'SHIPMENT', sh)
  const type = body?.nodeType
  if (!MANUAL_NODES.includes(type)) bad('这个节点由对应业务动作自动记录（发运、换柜、暂缓、派送、实收）')
  if (RANK[sh.status] < RANK.IN_TRANSIT) conflict('批次尚未实际发运')
  const actualAt = body.actualAt || nowIso()
  if (type === 'ARRIVED_PORT') {
    if (sh.actualEta) conflict('已记录到港；时间有误请使用“更正”')
    for (const l of sh.lines) {
      l.pendingDeliveryQty += l.intlQty
      l.intlQty = 0
    }
    sh.actualEta = actualAt
    if (sh.status === 'IN_TRANSIT') sh.status = 'ARRIVED_PORT'
  } else if (type === 'CUSTOMS_DECLARED' || type === 'CUSTOMS_RELEASED') {
    if (!sh.actualEta) conflict('请先记录到港')
    if (type === 'CUSTOMS_DECLARED' && sh.status === 'ARRIVED_PORT') sh.status = 'PENDING_CLEARANCE'
    if (type === 'CUSTOMS_RELEASED' && RANK[sh.status] < RANK.RELEASED) {
      sh.status = 'RELEASED'
      refreshShipmentStatus(sh)
    }
  }
  const plannedAt = body.plannedAt ?? (type === 'ARRIVED_PORT' ? sh.plannedEta : null)
  const node = pushNode(ctx, sh, type, { plannedAt, actualAt, location: body.location, remark: body.remark })
  sh.version += 1
  runLgsChecks(sh.countryId)
  audit(ctx, `记录节点：${NODE_TYPES[type]}`, 'shipment', sh.id, null, node)
  return sh
}

function correctNode(ctx: Ctx, sh: Row, eventId: number, body: Row) {
  requirePerm(ctx, 'lgs:node:record')
  requireDocumentDataAccess(ctx, 'SHIPMENT', sh)
  const old = sh.nodes.find((n: Row) => n.id === eventId)
  if (!old) bad('节点事件不存在')
  if (old.corrected) conflict('该事件已被更正，请更正最新的记录')
  if (!body?.remark) bad('请填写更正原因')
  old.corrected = true
  const node = pushNode(ctx, sh, old.nodeType, {
    plannedAt: old.plannedAt, actualAt: body.actualAt || old.actualAt, location: body.location ?? old.location,
    remark: `更正：${body.remark}`, refType: old.refType, refId: old.refId, refNo: old.refNo, correctsEventId: old.id,
  })
  if (old.nodeType === 'ARRIVED_PORT') sh.actualEta = node.actualAt
  if (old.nodeType === 'DEPARTED') sh.actualEtd = node.actualAt
  sh.version += 1
  audit(ctx, `更正节点：${NODE_TYPES[old.nodeType]}`, 'shipment', sh.id, old, node)
  return sh
}

function relatedOf(ctx: Ctx, sh: Row) {
  const db = getDb()
  return {
    transships: db.transships.filter((t) => t.shipmentId === sh.id && canDocumentDataAccess(ctx, 'TRANSSHIP', t)).map(transshipOut),
    holds: db.holds.filter((h) => h.shipmentId === sh.id && canDocumentDataAccess(ctx, 'HOLD', h)).map(holdOut),
    deliveries: db.deliveries.filter((d) => d.shipmentId === sh.id && canDocumentDataAccess(ctx, 'DELIVERY', d)).map(deliveryOut),
    receipts: db.lgsReceipts.filter((r) => r.shipmentId === sh.id && canDocumentDataAccess(ctx, 'LGS_RECEIPT', r)).map(receiptOut),
    discrepancies: db.discrepancies.filter((d) => d.shipmentId === sh.id && canDocumentDataAccess(ctx, 'DISCREPANCY', d)).map(discrepancyOut),
    fees: db.lgsFees.filter((f) => f.shipmentId === sh.id && canDocumentDataAccess(ctx, 'LGS_FEE', f)).map((f) => feeOut(f, ctx)),
  }
}

const shipments = crud('/lgs/shipments', 'shipments', { viewPerm: 'lgs:shipment:view', canAccess: (row, ctx) => canDocumentDataAccess(ctx, 'SHIPMENT', row), out: shipmentOut })

const findShipment = (ctx: Ctx, id: string) => {
  requirePerm(ctx, 'lgs:shipment:view')
  return findOr404(ctx, 'shipments', Number(id), { canAccess: (row) => canDocumentDataAccess(ctx, 'SHIPMENT', row) })
}

const shipmentExtras = [
  http.get(`${API}/lgs/shipments`, handle((ctx) => {
    requirePerm(ctx, 'lgs:shipment:view')
    runLgsChecks(requireCountry(ctx))
    return listShipments(ctx)
  })),
  http.post(`${API}/lgs/shipments`, handle((ctx, { body }) => {
    requireCountry(ctx)
    return shipmentOut(createShipment(ctx, body))
  })),
  http.put(`${API}/lgs/shipments/:id`, handle((ctx, { params, body }) => {
    requirePerm(ctx, 'lgs:shipment:edit')
    const sh = findShipment(ctx, params.id)
    checkVersion(sh, body)
    if (!['DRAFT', 'PENDING_DISPATCH'].includes(sh.status)) conflict('已发运的批次不能修改行和数量；节点、换柜、暂缓请用对应操作')
    const before = structuredClone(sh)
    const data = buildShipment(ctx, body, sh)
    Object.assign(sh, data, { version: sh.version + 1, updatedAt: nowIso() })
    if (data.currentContainerNo && !sh.containers.some((c: Row) => c.containerNo === data.currentContainerNo)) {
      sh.containers = [{ id: nextId(), containerNo: data.currentContainerNo, sealNo: data.currentSealNo, activeFrom: nowIso(), activeTo: null, replacedById: null }]
    }
    audit(ctx, '修改', 'shipment', sh.id, before, sh)
    return shipmentOut(sh)
  })),
  http.post(`${API}/lgs/shipments/:id/submit`, handle((ctx, { params }) => shipmentOut(submitShipment(ctx, findShipment(ctx, params.id))))),
  http.post(`${API}/lgs/shipments/:id/dispatch`, handle((ctx, { params, body }) => shipmentOut(dispatchShipment(ctx, findShipment(ctx, params.id), body)))),
  http.post(`${API}/lgs/shipments/:id/void`, handle((ctx, { params }) => {
    requirePerm(ctx, 'lgs:shipment:edit')
    const sh = findShipment(ctx, params.id)
    if (!['DRAFT', 'PENDING_DISPATCH'].includes(sh.status)) conflict('已发运的批次不能作废')
    sh.status = 'VOIDED'
    sh.version += 1
    closeTodo(`LGS_DISPATCH:${sh.id}`, '已作废')
    audit(ctx, '作废', 'shipment', sh.id, null, { status: 'VOIDED' })
    return shipmentOut(sh)
  })),
  http.get(`${API}/lgs/shipments/:id/quantities`, handle((ctx, { params }) => {
    const sh = findShipment(ctx, params.id)
    const lines = shipmentOut(sh).lines
    return { lines, totals: totals(sh), identityOk: lines.every((l: Row) => l.identityOk) }
  })),
  http.get(`${API}/lgs/shipments/:id/related`, handle((ctx, { params }) => relatedOf(ctx, findShipment(ctx, params.id)))),
  http.post(`${API}/lgs/shipments/:id/nodes/:eventId/correct`, handle((ctx, { params, body }) => shipmentOut(correctNode(ctx, findShipment(ctx, params.id), Number(params.eventId), body)))),
  http.post(`${API}/lgs/shipments/:id/nodes`, handle((ctx, { params, body }) => shipmentOut(recordNode(ctx, findShipment(ctx, params.id), body)))),
]

function listShipments(ctx: Ctx) {
  const sp = ctx.url.searchParams
  const keyword = sp.get('keyword')?.toLowerCase()
  const rows = getDb().shipments
    .filter((r) => r.countryId === ctx.countryId && canDocumentDataAccess(ctx, 'SHIPMENT', r) && (sp.get('includeVoided') === 'true' || r.status !== 'VOIDED'))
    .filter((r) => ['status', 'transportMode', 'carrierId', 'destWarehouseId'].every((k) => !sp.get(k) || String(r[k]) === sp.get(k)))
    .filter((r) => !keyword || [r.docNo, r.currentContainerNo, r.blNo, r.awbNo, r.vessel, ...r.lines.map((l: Row) => l.poNo), ...r.containers.map((c: Row) => c.containerNo)].some((v) => String(v ?? '').toLowerCase().includes(keyword)))
    .filter((r) => sp.get('delayed') !== 'true' || delayInfo(r).delayed)
    .map(shipmentOut)
  return paginate(rows, ctx.url)
}

// ---------- 换柜 ----------

function transshipOut(t: Row) {
  return { ...t, operatorName: userName(t.operatorId), lines: t.lines.map(withProduct) }
}

export function createTransship(ctx: Ctx, body: Row) {
  requirePerm(ctx, 'lgs:transship:create')
  const db = getDb()
  const sh = shipmentOf(ctx, Number(body?.shipmentId))
  if (sh.transportMode !== 'SEA') conflict('只有海运批次有柜号')
  if (RANK[sh.status] < RANK.IN_TRANSIT || sh.status === 'COMPLETED') conflict('当前状态不能换柜')
  if (!body.toContainerNo) bad('请填写新柜号')
  const from = sh.containers.find((c: Row) => !c.activeTo)
  if (from?.containerNo === body.toContainerNo) bad('新柜号与原柜号相同')
  const at = body.transshipAt || nowIso()
  const lines = sh.lines.map((l: Row) => {
    const inContainer = l.intlQty + l.pendingDeliveryQty + l.onHoldQty
    const input = (body.lines ?? []).find((x: Row) => x.shipmentLineId === l.id)
    const moved = input ? num(input.movedQty) : inContainer
    if (moved < 0 || moved > inContainer) bad(`${product(l.productId)?.productCode} 转移数量不能超过原柜在柜数量 ${inContainer}`)
    const diff = inContainer - moved
    if (diff > l.intlQty + l.pendingDeliveryQty) bad(`${product(l.productId)?.productCode} 差异涉及暂缓数量，请先恢复暂缓`)
    return { id: nextId(), shipmentLineId: l.id, productId: l.productId, inContainerQty: inContainer, movedQty: moved, diffQty: diff }
  })
  const t: Row = {
    id: nextId(), countryId: ctx.countryId, docNo: docNo(ctx.countryId!, 'TS', at.slice(0, 10)), shipmentId: sh.id, shipmentNo: sh.docNo,
    fromContainerNo: from?.containerNo ?? '', toContainerNo: body.toContainerNo, toSealNo: body.toSealNo ?? '', location: body.location ?? '',
    transshipAt: at, operatorId: ctx.user.id, remark: body.remark ?? '', lines, createdAt: nowIso(),
  }
  const next = { id: nextId(), containerNo: body.toContainerNo, sealNo: body.toSealNo ?? '', activeFrom: at, activeTo: null, replacedById: null }
  if (from) Object.assign(from, { activeTo: at, replacedById: next.id })
  sh.containers.push(next)
  Object.assign(sh, { currentContainerNo: next.containerNo, currentSealNo: next.sealNo })
  for (const tl of lines) {
    if (!tl.diffQty) continue
    const l = lineOf(sh, tl.shipmentLineId)
    const fromPending = Math.min(tl.diffQty, l.pendingDeliveryQty)
    l.pendingDeliveryQty -= fromPending
    l.intlQty -= tl.diffQty - fromPending
    l.discrepancyQty += tl.diffQty
    createDiscrepancy(ctx, { sourceType: 'TRANSSHIP_LINE', sourceLineId: tl.id, sourceNo: t.docNo, sh, line: l, warehouseId: sh.destWarehouseId, type: 'TRANSSHIP_DIFF', qty: tl.diffQty })
  }
  if (sh.status === 'ARRIVED_PORT' || sh.status === 'PENDING_CLEARANCE') {
    for (const l of sh.lines) {
      l.pendingDeliveryQty += l.intlQty
      l.intlQty = 0
    }
    sh.status = 'RELEASED'
  }
  refreshShipmentStatus(sh)
  pushNode(ctx, sh, 'TRANSSHIPPED', { actualAt: at, location: t.location, remark: `${t.fromContainerNo} → ${t.toContainerNo}`, refType: 'TRANSSHIP', refId: t.id, refNo: t.docNo })
  sh.version += 1
  db.transships.unshift(t)
  audit(ctx, '换柜', 'shipment', sh.id, { containerNo: t.fromContainerNo }, { containerNo: t.toContainerNo, transship: t.docNo })
  return t
}

// ---------- 暂缓派送 ----------

function holdOut(h: Row) {
  const db = getDb()
  const reason = db.dicts.find((d) => d.countryId === h.countryId && d.dictType === 'HOLD_REASON' && d.code === h.reasonCode)
  const holdQty = sum(h.lines, (l: Row) => l.holdQty)
  const releasedQty = sum(h.lines, (l: Row) => l.releasedQty)
  return {
    ...h, reasonLabel: reason?.label ?? h.reasonCode, ownerName: userName(h.ownerId), createdByName: userName(h.createdBy),
    holdQty, releasedQty, activeQty: holdQty - releasedQty, overdue: h.status !== 'RELEASED' && h.reviewDate <= today(h.countryId),
    lines: h.lines.map(withProduct), releases: (h.releases ?? []).map((r: Row) => ({ ...r, releasedByName: userName(r.releasedBy) })),
    feeCount: db.lgsFees.filter((f) => f.refType === 'HOLD' && f.refId === h.id && f.status !== 'VOIDED').length,
  }
}

export function createHold(ctx: Ctx, body: Row) {
  requirePerm(ctx, 'lgs:hold:create')
  const sh = shipmentOf(ctx, Number(body?.shipmentId))
  ensureUniqueSourceLines(body.lines ?? [], 'shipmentLineId')
  for (const [k, label] of [['reasonCode', '原因'], ['parkLocation', '停放地点'], ['ownerId', '责任人'], ['reviewDate', '复查日期']]) if (!body[k]) bad(`请填写${label}`)
  const lines = (body.lines ?? []).filter((l: Row) => num(l.holdQty) > 0).map((l: Row) => {
    const sl = lineOf(sh, l.shipmentLineId)
    if (num(l.holdQty) > sl.pendingDeliveryQty) bad(`${product(sl.productId)?.productCode} 暂缓数量不能超过当地待派送 ${sl.pendingDeliveryQty}`)
    return { id: nextId(), shipmentLineId: sl.id, productId: sl.productId, holdQty: num(l.holdQty), releasedQty: 0 }
  })
  if (!lines.length) bad('请填写暂缓数量')
  for (const l of lines) {
    const sl = lineOf(sh, l.shipmentLineId)
    sl.pendingDeliveryQty -= l.holdQty
    sl.onHoldQty += l.holdQty
  }
  const h: Row = {
    id: nextId(), countryId: ctx.countryId, docNo: docNo(ctx.countryId!, 'HD'), shipmentId: sh.id, shipmentNo: sh.docNo, reasonCode: body.reasonCode,
    parkLocation: body.parkLocation, ownerId: body.ownerId, reviewDate: body.reviewDate, remark: body.remark ?? '', status: 'ACTIVE',
    lines, releases: [], version: 1, createdBy: ctx.user.id, createdAt: body.heldAt || nowIso(),
  }
  getDb().holds.unshift(h)
  refreshShipmentStatus(sh)
  pushNode(ctx, sh, 'HOLD', { actualAt: h.createdAt, location: h.parkLocation, remark: holdOut(h).reasonLabel, refType: 'HOLD', refId: h.id, refNo: h.docNo })
  sh.version += 1
  runLgsChecks(sh.countryId)
  audit(ctx, '暂缓派送', 'shipment', sh.id, null, { hold: h.docNo, lines })
  return h
}

/** 恢复派送需要单独授权，可以部分恢复（docs/05 第 5.5 节） */
export function releaseHold(ctx: Ctx, h: Row, body: Row) {
  requirePerm(ctx, 'lgs:hold:release')
  requireDocumentDataAccess(ctx, 'HOLD', h)
  if (h.status === 'RELEASED') conflict('已全部恢复')
  const sh = shipmentOf(ctx, h.shipmentId)
  const items = (body?.lines ?? []).filter((x: Row) => num(x.qty) > 0)
  if (!items.length) bad('请填写恢复数量')
  for (const it of items) {
    const hl = h.lines.find((x: Row) => x.id === it.holdLineId)
    if (!hl) bad('暂缓行不存在')
    if (num(it.qty) > hl.holdQty - hl.releasedQty) bad(`恢复数量不能超过暂缓中的 ${hl.holdQty - hl.releasedQty}`)
    hl.releasedQty += num(it.qty)
    const sl = lineOf(sh, hl.shipmentLineId)
    sl.onHoldQty -= num(it.qty)
    sl.pendingDeliveryQty += num(it.qty)
  }
  const all = h.lines.every((l: Row) => l.releasedQty >= l.holdQty)
  h.status = all ? 'RELEASED' : 'PARTIAL_RELEASED'
  h.releases.push({ releasedBy: ctx.user.id, releasedAt: nowIso(), lines: items, remark: body.remark ?? '' })
  h.version += 1
  refreshShipmentStatus(sh)
  pushNode(ctx, sh, 'RESUMED', { remark: `${h.docNo} 恢复 ${sum(items, (x: Row) => x.qty)} 件`, refType: 'HOLD', refId: h.id, refNo: h.docNo })
  if (all) closeTodo(`LGS_HOLD:${h.id}`, '已恢复派送')
  audit(ctx, '恢复派送', 'shipment', sh.id, null, { hold: h.docNo, lines: items })
  return h
}

const holds = crud('/lgs/holds', 'holds', {
  viewPerm: ['lgs:hold:create', 'lgs:hold:release', 'lgs:shipment:view'],
  canAccess: (row, ctx) => canDocumentDataAccess(ctx, 'HOLD', row),
  keywordKeys: ['docNo', 'shipmentNo', 'parkLocation'],
  filterKeys: ['status', 'shipmentId', 'ownerId'],
  out: holdOut,
})

const holdExtras = [
  http.post(`${API}/lgs/holds`, handle((ctx, { body }) => {
    requireCountry(ctx)
    return holdOut(createHold(ctx, body))
  })),
  http.post(`${API}/lgs/holds/:id/release`, handle((ctx, { params, body }) => holdOut(releaseHold(ctx, findOr404(ctx, 'holds', Number(params.id)), body)))),
]

// ---------- 派送 ----------

function deliveryOut(d: Row) {
  const db = getDb()
  const r = db.lgsReceipts.find((x) => x.deliveryId === d.id)
  return {
    ...d, warehouseName: nameOf(db.warehouses, d.destWarehouseId), createdByName: userName(d.createdBy),
    totalQty: sum(d.lines, (l: Row) => l.dispatchQty), receivedQty: sum(d.lines, (l: Row) => l.receivedQty),
    receiptId: r?.id ?? null, receiptNo: r?.docNo ?? '', receiptStatus: r?.status ?? null, lines: d.lines.map(withProduct),
  }
}

function draftDeliveryQty(shipmentLineId: number, excludeId?: number) {
  return sum(getDb().deliveries.filter((d) => d.status === 'DRAFT' && d.id !== excludeId), (d) => sum(d.lines.filter((l: Row) => l.shipmentLineId === shipmentLineId), (l: Row) => l.dispatchQty))
}

export function createDelivery(ctx: Ctx, body: Row) {
  requirePerm(ctx, 'lgs:delivery:create')
  const sh = shipmentOf(ctx, Number(body?.shipmentId))
  ensureUniqueSourceLines(body.lines ?? [], 'shipmentLineId')
  if (RANK[sh.status] < RANK.RELEASED) conflict('批次尚未放行，不能派送（换柜后可直接派送）')
  const wh = warehouseOf(ctx.countryId!, Number(body.destWarehouseId ?? sh.destWarehouseId))
  requireDataAccess(ctx, { countryId: ctx.countryId, warehouseId: wh.id })
  const lines = (body.lines ?? []).filter((l: Row) => num(l.dispatchQty) > 0).map((l: Row) => {
    const sl = lineOf(sh, l.shipmentLineId)
    const max = sl.pendingDeliveryQty - draftDeliveryQty(sl.id)
    if (num(l.dispatchQty) > max) bad(`${product(sl.productId)?.productCode} 可派送 ${max}（当地待派送 − 其他草稿派送单）`, 'LGS_DELIVERY_EXCEEDED')
    return { id: nextId(), shipmentLineId: sl.id, productId: sl.productId, poLineId: sl.poLineId, dispatchQty: num(l.dispatchQty), receivedQty: 0 }
  })
  if (!lines.length) bad('请填写派送数量')
  const d: Row = {
    id: nextId(), countryId: ctx.countryId, docNo: docNo(ctx.countryId!, 'DL', body.plannedAt), shipmentId: sh.id, shipmentNo: sh.docNo,
    destWarehouseId: wh.id, vehicle: body.vehicle ?? '', driver: body.driver ?? '', plannedAt: body.plannedAt ?? null, dispatchedAt: null,
    remark: body.remark ?? '', status: 'DRAFT', lines, version: 1, createdBy: ctx.user.id, createdAt: nowIso(),
  }
  getDb().deliveries.unshift(d)
  audit(ctx, '新增派送单', 'shipment', sh.id, null, { delivery: d.docNo, lines })
  return body.dispatch ? dispatchDelivery(ctx, d, body) : d
}

export function dispatchDelivery(ctx: Ctx, d: Row, body: Row) {
  requirePerm(ctx, 'lgs:delivery:dispatch')
  requireDocumentDataAccess(ctx, 'DELIVERY', d)
  if (d.status !== 'DRAFT') return d
  ensureUniqueSourceLines(d.lines, 'shipmentLineId')
  const sh = shipmentOf(ctx, d.shipmentId)
  for (const l of d.lines) {
    const sl = lineOf(sh, l.shipmentLineId)
    if (l.dispatchQty > sl.pendingDeliveryQty) bad(`${product(l.productId)?.productCode} 当地待派送只剩 ${sl.pendingDeliveryQty}`, 'LGS_DELIVERY_EXCEEDED')
  }
  for (const l of d.lines) {
    const sl = lineOf(sh, l.shipmentLineId)
    sl.pendingDeliveryQty -= l.dispatchQty
    sl.deliveringQty += l.dispatchQty
  }
  Object.assign(d, { status: 'DISPATCHED', dispatchedAt: body?.dispatchedAt || nowIso(), version: d.version + 1 })
  refreshShipmentStatus(sh)
  pushNode(ctx, sh, 'DISPATCHED', { actualAt: d.dispatchedAt, remark: `${d.docNo} → ${nameOf(getDb().warehouses, d.destWarehouseId)}`, refType: 'DELIVERY', refId: d.id, refNo: d.docNo })
  sh.version += 1
  openTodo({
    countryId: d.countryId, todoType: 'PENDING_RECEIPT', dedupKey: `LGS_RECEIPT:${d.id}`, perm: 'lgs:receipt:confirm',
    title: `派送单 ${d.docNo} 待实收（${sum(d.lines, (l: Row) => l.dispatchQty)} 件，${nameOf(getDb().warehouses, d.destWarehouseId)}）`,
    link: `/logistics/receipts?deliveryId=${d.id}`,
  })
  audit(ctx, '派送出发', 'shipment', sh.id, null, { delivery: d.docNo })
  return d
}

const deliveries = crud('/lgs/deliveries', 'deliveries', {
  viewPerm: ['lgs:delivery:create', 'lgs:receipt:confirm', 'lgs:shipment:view'],
  keywordKeys: ['docNo', 'shipmentNo', 'vehicle', 'driver'],
  filterKeys: ['status', 'shipmentId', 'destWarehouseId'],
  scope: { warehouseField: 'destWarehouseId' },
  canAccess: (row, ctx) => canDocumentDataAccess(ctx, 'DELIVERY', row),
  out: deliveryOut,
})

const deliveryExtras = [
  http.post(`${API}/lgs/deliveries`, handle((ctx, { body }) => {
    requireCountry(ctx)
    return deliveryOut(createDelivery(ctx, body))
  })),
  http.post(`${API}/lgs/deliveries/:id/dispatch`, handle((ctx, { params, body }) => deliveryOut(dispatchDelivery(ctx, findOr404(ctx, 'deliveries', Number(params.id), { scope: { warehouseField: 'destWarehouseId' } }), body)))),
  http.post(`${API}/lgs/deliveries/:id/void`, handle((ctx, { params }) => {
    requirePerm(ctx, 'lgs:delivery:create')
    const d = findOr404(ctx, 'deliveries', Number(params.id), { canAccess: (row) => canDocumentDataAccess(ctx, 'DELIVERY', row) })
    if (d.status !== 'DRAFT') conflict('只有草稿派送单可以作废')
    d.status = 'VOIDED'
    d.version += 1
    return deliveryOut(d)
  })),
]

// ---------- MX 实收 ----------

function receiptOut(r: Row) {
  const db = getDb()
  return {
    ...r, warehouseName: nameOf(db.warehouses, r.warehouseId), receivedByName: userName(r.receivedBy), createdByName: userName(r.createdBy),
    totalDispatch: sum(r.lines, (l: Row) => l.dispatchQty), totalGood: sum(r.lines, (l: Row) => l.goodQty),
    totalFrozen: sum(r.lines, (l: Row) => l.damagedQty + l.pendingInspectQty), totalShort: sum(r.lines, (l: Row) => l.shortQty),
    lines: r.lines.map((l: Row) => withProduct({ ...l, barcodeText: product(l.productId)?.barcodeText ?? '', batchNo: db.invBatches.find((b) => b.id === l.invBatchId)?.batchNo ?? '' })),
  }
}

const SCOPE_WH = { warehouseField: 'warehouseId' }

export function createLgsReceipt(ctx: Ctx, body: Row) {
  requirePerm(ctx, 'lgs:receipt:confirm')
  const db = getDb()
  const d = findOr404(ctx, 'deliveries', Number(body?.deliveryId), { scope: { warehouseField: 'destWarehouseId' } })
  if (d.status !== 'DISPATCHED') conflict('派送单尚未出发或已实收')
  const exist = db.lgsReceipts.find((r) => r.deliveryId === d.id)
  if (exist) return exist
  const r: Row = {
    id: nextId(), countryId: ctx.countryId, docNo: docNo(ctx.countryId!, 'RC'), deliveryId: d.id, deliveryNo: d.docNo, shipmentId: d.shipmentId,
    shipmentNo: d.shipmentNo, warehouseId: d.destWarehouseId, bizDate: today(ctx.countryId!), remark: '', status: 'DRAFT', receivedBy: null,
    lines: d.lines.map((l: Row) => ({
      id: nextId(), deliveryLineId: l.id, shipmentLineId: l.shipmentLineId, poLineId: l.poLineId, productId: l.productId, dispatchQty: l.dispatchQty,
      goodQty: l.dispatchQty, damagedQty: 0, pendingInspectQty: 0, shortQty: 0, invBatchId: null, remark: '',
    })),
    version: 1, createdBy: ctx.user.id, createdAt: nowIso(),
  }
  db.lgsReceipts.unshift(r)
  return r
}

function applyReceiptInput(r: Row, body: Row) {
  if (body?.bizDate) r.bizDate = body.bizDate
  if (body?.remark !== undefined) r.remark = body.remark
  for (const it of body?.lines ?? []) {
    const l = r.lines.find((x: Row) => x.id === it.id)
    if (!l) continue
    for (const k of ['goodQty', 'damagedQty', 'pendingInspectQty', 'shortQty']) if (it[k] !== undefined) l[k] = num(it[k])
    if (it.remark !== undefined) l.remark = it.remark
  }
}

/** 确认实收：同一请求内入库；幂等键与流水唯一键双重兜底，重复确认不会重复入库（A30） */
export function confirmLgsReceipt(ctx: Ctx, r: Row, body: Row, idemKey?: string | null) {
  requirePerm(ctx, 'lgs:receipt:confirm')
  requireDocumentDataAccess(ctx, 'LGS_RECEIPT', r)
  const db = getDb()
  if (idemKey && db.idempotency[idemKey]) {
    const prev = db.lgsReceipts.find((x) => x.id === db.idempotency[idemKey])
    if (prev) return { ...receiptOut(prev), duplicate: true }
  }
  if (r.status === 'CONFIRMED') return { ...receiptOut(r), duplicate: true }
  applyReceiptInput(r, body)
  for (const l of r.lines) {
    const parts = [l.goodQty, l.damagedQty, l.pendingInspectQty, l.shortQty]
    if (parts.some((x) => x < 0)) bad('数量不能为负数')
    if (sum(parts, (x) => x) !== l.dispatchQty) {
      bad(`${product(l.productId)?.productCode}：合格 ${l.goodQty} + 破损 ${l.damagedQty} + 待检 ${l.pendingInspectQty} + 短缺 ${l.shortQty} 必须等于派送数量 ${l.dispatchQty}`, 'LGS_RECEIPT_QTY_MISMATCH')
    }
  }
  const d = db.deliveries.find((x) => x.id === r.deliveryId)!
  const sh = shipmentOf(ctx, r.shipmentId)
  for (const l of r.lines) {
    const sl = lineOf(sh, l.shipmentLineId)
    const po = db.purOrders.find((o) => o.id === sl.poId)!
    const poLine = po.lines.find((x: Row) => x.id === sl.poLineId)
    const batch = inbound(ctx, {
      warehouseId: r.warehouseId, productId: l.productId, goodQty: l.goodQty, damagedQty: l.damagedQty, pendingInspectQty: l.pendingInspectQty,
      source: { type: 'LGS_RECEIPT', id: r.id, lineId: l.id, no: r.docNo }, bizDate: r.bizDate, shipmentId: sh.id, poLineId: sl.poLineId,
    })
    l.invBatchId = batch?.id ?? null
    const frozen = l.damagedQty + l.pendingInspectQty
    sl.deliveringQty -= l.dispatchQty
    sl.receivedGoodQty += l.goodQty
    sl.receivedFrozenQty += frozen
    sl.discrepancyQty += l.shortQty
    if (l.shortQty > 0) createDiscrepancy(ctx, { sourceType: 'RECEIPT_LINE', sourceLineId: l.id, sourceNo: r.docNo, sh, line: sl, warehouseId: r.warehouseId, type: 'SHORT', qty: l.shortQty })
    const dl = d.lines.find((x: Row) => x.id === l.deliveryLineId)
    dl.receivedQty = l.goodQty + frozen
    onArrived(sl.poLineId, l.goodQty + frozen)
    if (batch) createInboundCost(ctx, { receipt: r, receiptLine: l, batch, po, poLine, warehouseId: r.warehouseId })
  }
  Object.assign(d, { status: 'RECEIVED', version: d.version + 1 })
  Object.assign(r, { status: 'CONFIRMED', receivedBy: ctx.user.id, confirmedAt: nowIso(), version: r.version + 1 })
  refreshShipmentStatus(sh)
  pushNode(ctx, sh, 'RECEIVED', { remark: `${r.docNo}：合格 ${sum(r.lines, (l: Row) => l.goodQty)}，冻结 ${sum(r.lines, (l: Row) => l.damagedQty + l.pendingInspectQty)}，短缺 ${sum(r.lines, (l: Row) => l.shortQty)}`, refType: 'RECEIPT', refId: r.id, refNo: r.docNo, location: nameOf(db.warehouses, r.warehouseId) })
  sh.version += 1
  closeTodo(`LGS_RECEIPT:${d.id}`, '已实收')
  if (idemKey) db.idempotency[idemKey] = r.id
  audit(ctx, '确认实收（LGS_RECEIPT_CONFIRMED）', 'lgs-receipt', r.id, null, { lines: r.lines.map((l: Row) => ({ productId: l.productId, good: l.goodQty, damaged: l.damagedQty, pending: l.pendingInspectQty, short: l.shortQty })) })
  return receiptOut(r)
}

const receipts = crud('/lgs/receipts', 'lgsReceipts', {
  viewPerm: ['lgs:receipt:confirm', 'lgs:shipment:view'],
  keywordKeys: ['docNo', 'deliveryNo', 'shipmentNo'],
  filterKeys: ['status', 'warehouseId', 'shipmentId', 'deliveryId'],
  scope: SCOPE_WH,
  out: receiptOut,
})

const receiptExtras = [
  http.post(`${API}/lgs/receipts`, handle((ctx, { body }) => {
    requireCountry(ctx)
    return receiptOut(createLgsReceipt(ctx, body))
  })),
  http.put(`${API}/lgs/receipts/:id`, handle((ctx, { params, body }) => {
    requirePerm(ctx, 'lgs:receipt:confirm')
    const r = findOr404(ctx, 'lgsReceipts', Number(params.id), { scope: SCOPE_WH })
    if (r.status !== 'DRAFT') conflict('已确认的实收单不能修改')
    applyReceiptInput(r, body)
    r.version += 1
    return receiptOut(r)
  })),
  http.post(`${API}/lgs/receipts/:id/confirm`, handle((ctx, { params, body }) =>
    confirmLgsReceipt(ctx, findOr404(ctx, 'lgsReceipts', Number(params.id), { scope: SCOPE_WH }), body, ctx.request.headers.get('Idempotency-Key')),
  )),
]

// ---------- 到货差异 ----------

export const DISCREPANCY_TYPES: Record<string, string> = { SHORT: '短缺', DAMAGED: '破损', NOT_ARRIVED: '未到', TRANSSHIP_DIFF: '换柜差异' }
export const RESOLUTIONS: Record<string, string> = { LATER_ARRIVED: '后续到货', CLAIM: '转索赔', WRITE_OFF: '核销', SUPPLIER_CREDIT: '供应商贷项' }

interface DiscInput {
  sourceType: string
  sourceLineId: number
  sourceNo: string
  sh: Row
  line: Row
  warehouseId: number
  type: string
  qty: number
}

function createDiscrepancy(ctx: Ctx, i: DiscInput) {
  const d = {
    id: nextId(), countryId: ctx.countryId, docNo: docNo(ctx.countryId!, 'DS'), sourceType: i.sourceType, sourceLineId: i.sourceLineId, sourceNo: i.sourceNo,
    shipmentId: i.sh.id, shipmentNo: i.sh.docNo, shipmentLineId: i.line.id, poLineId: i.line.poLineId, productId: i.line.productId, warehouseId: i.warehouseId,
    discrepancyType: i.type, qty: i.qty, reasonCode: i.type, status: 'OPEN', resolution: null, resolutionRef: '', resolvedBy: null, resolvedAt: null,
    approvalInstanceId: null, version: 1, createdBy: ctx.user.id, createdAt: nowIso(),
  }
  getDb().discrepancies.unshift(d)
  openTodo({ countryId: d.countryId!, todoType: 'DISCREPANCY_OPEN', dedupKey: `LGS_DISC:${d.id}`, title: `${d.shipmentNo} ${product(d.productId)?.productCode} ${DISCREPANCY_TYPES[i.type]} ${i.qty} 件待处理`, link: '/logistics/discrepancies?status=OPEN', perm: 'lgs:discrepancy:handle' })
  return d
}

function discrepancyOut(d: Row) {
  const db = getDb()
  return withProduct({ ...d, typeLabel: DISCREPANCY_TYPES[d.discrepancyType], resolutionLabel: d.resolution ? RESOLUTIONS[d.resolution] : '', warehouseName: nameOf(db.warehouses, d.warehouseId), resolvedByName: userName(d.resolvedBy) })
}

function finishDiscrepancy(ctx: Ctx | null, d: Row, resolution: string, ref: string) {
  Object.assign(d, { status: 'RESOLVED', resolution, resolutionRef: ref, resolvedBy: ctx?.user.id ?? d.resolvedBy, resolvedAt: nowIso(), version: d.version + 1 })
  closeTodo(`LGS_DISC:${d.id}`, RESOLUTIONS[resolution])
  const sh = getDb().shipments.find((s) => s.id === d.shipmentId)
  if (sh) refreshShipmentStatus(sh)
}

export function resolveDiscrepancy(ctx: Ctx, d: Row, body: Row) {
  requirePerm(ctx, 'lgs:discrepancy:handle')
  requireDocumentDataAccess(ctx, 'DISCREPANCY', d)
  if (d.status !== 'OPEN') conflict('差异已处理或正在审批')
  const res = body?.resolution
  if (!RESOLUTIONS[res]) bad('请选择处理结论')
  if (!body.remark) bad('请填写处理说明')
  d.remark = body.remark
  if (res === 'LATER_ARRIVED') {
    const sh = shipmentOf(ctx, d.shipmentId)
    const sl = lineOf(sh, d.shipmentLineId)
    sl.discrepancyQty -= d.qty
    sl.pendingDeliveryQty += d.qty
    finishDiscrepancy(ctx, d, res, `${d.qty} 件回到当地待派送，可再次派送并补做实收`)
  } else if (res === 'WRITE_OFF') {
    const r = submitApproval(ctx, { docType: 'DISCREPANCY_WRITE_OFF', docId: d.id, docNo: d.docNo, docTitle: `${d.shipmentNo} ${product(d.productId)?.productCode} ${DISCREPANCY_TYPES[d.discrepancyType]} ${d.qty} 件核销`, facts: { qty: d.qty } })
    d.approvalInstanceId = r.instance?.id ?? null
    if (r.status === 'APPROVED') finishDiscrepancy(ctx, d, res, '核销（财务影响由成本与总账处理）')
    else Object.assign(d, { status: 'PENDING_APPROVAL', resolution: res, version: d.version + 1 })
    d.approvalMessage = r.message
  } else {
    finishDiscrepancy(ctx, d, res, res === 'CLAIM' ? '转索赔，由退货与索赔模块跟进' : '登记供应商贷项，由应付模块跟进')
  }
  audit(ctx, `处理差异：${RESOLUTIONS[res]}`, 'discrepancy', d.id, null, { resolution: res, remark: body.remark })
  return d
}

onApproval('DISCREPANCY_WRITE_OFF', {
  onApproved: (inst, ctx) => {
    const d = getDb().discrepancies.find((x) => x.id === inst.docId)
    if (d?.status === 'PENDING_APPROVAL') finishDiscrepancy(ctx, d, 'WRITE_OFF', '核销已审批（财务影响由成本与总账处理）')
  },
  onRejected: (inst) => {
    const d = getDb().discrepancies.find((x) => x.id === inst.docId)
    if (d?.status === 'PENDING_APPROVAL') Object.assign(d, { status: 'OPEN', resolution: null, version: d.version + 1 })
  },
  onWithdrawn: (inst) => {
    const d = getDb().discrepancies.find((x) => x.id === inst.docId)
    if (d?.status === 'PENDING_APPROVAL') Object.assign(d, { status: 'OPEN', resolution: null, version: d.version + 1 })
  },
})

const discrepancies = crud('/lgs/discrepancies', 'discrepancies', {
  viewPerm: ['lgs:discrepancy:handle', 'lgs:shipment:view'],
  canAccess: (row, ctx) => canDocumentDataAccess(ctx, 'DISCREPANCY', row),
  keywordKeys: ['docNo', 'shipmentNo', 'sourceNo'],
  filterKeys: ['status', 'discrepancyType', 'shipmentId', 'warehouseId'],
  out: discrepancyOut,
})

const discrepancyExtras = [
  http.post(`${API}/lgs/discrepancies/:id/resolve`, handle((ctx, { params, body }) => discrepancyOut(resolveDiscrepancy(ctx, findOr404(ctx, 'discrepancies', Number(params.id)), body)))),
]

// ---------- 物流费用 ----------

export const FEE_REF_TYPES: Record<string, string> = { SHIPMENT: '运输批次', TRANSSHIP: '换柜', HOLD: '暂缓派送', DELIVERY: '派送单' }

function feeOut(f: Row, ctx?: Ctx) {
  const db = getDb()
  const item = db.expenseItems.find((e) => e.id === f.expenseItemId)
  const out = {
    ...f, carrierName: nameOf(db.partners, f.carrierId), expenseItemName: item?.name ?? '', costTreatment: item?.costTreatment ?? '',
    refTypeLabel: FEE_REF_TYPES[f.refType], createdByName: userName(f.createdBy), confirmedByName: userName(f.confirmedBy),
    estimateNo: db.lgsFees.find((x) => x.id === f.estimateFeeId)?.docNo ?? '', actualNo: db.lgsFees.find((x) => x.id === f.actualFeeId)?.docNo ?? '',
  }
  return ctx ? readableBusinessFields(ctx, out, { amountGroup: 'COST' }) : out
}

function buildFee(ctx: Ctx, body: Row) {
  const db = getDb()
  const countryId = ctx.countryId!
  const tables: Record<string, Row[]> = { SHIPMENT: db.shipments, TRANSSHIP: db.transships, HOLD: db.holds, DELIVERY: db.deliveries }
  const ref = tables[body?.refType]?.find((x) => x.id === Number(body.refId) && x.countryId === countryId)
  if (!ref) bad('请选择费用关联的批次、换柜、暂缓或派送单')
  const shipmentId = body.refType === 'SHIPMENT' ? ref.id : ref.shipmentId
  requireDocumentDataAccess(ctx, body.refType, ref)
  requireDocumentDataAccess(ctx, 'LGS_FEE', { countryId, shipmentId })
  const carrier = db.partners.find((p) => p.id === body.carrierId && p.countryId === countryId)
  if (!carrier || !['LOGISTICS', 'BOTH'].includes(carrier.partnerType)) bad('请选择物流商')
  const item = db.expenseItems.find((e) => e.id === body.expenseItemId && e.countryId === countryId && e.status === 'ENABLED')
  if (!item) bad('请选择启用的费用项目')
  if (!db.currencies.some((c) => c.code === body.currency)) bad('请选择币种')
  if (!(num(body.amount) > 0)) bad('金额必须大于 0')
  if (!['ESTIMATE', 'ACTUAL'].includes(body.estimateFlag)) bad('请选择暂估或实际')
  let estimateFeeId = null
  if (body.estimateFlag === 'ACTUAL' && body.estimateFeeId) {
    const est = db.lgsFees.find((x) => x.id === Number(body.estimateFeeId) && x.countryId === countryId)
    if (!est || est.estimateFlag !== 'ESTIMATE' || est.status !== 'CONFIRMED') bad('关联的暂估费用必须是已确认的暂估记录')
    if (est.shipmentId !== shipmentId) bad('暂估与实际费用必须属于同一运输批次')
    estimateFeeId = est.id
  }
  return {
    refType: body.refType, refId: ref.id, refNo: ref.docNo, shipmentId, shipmentNo: db.shipments.find((s) => s.id === shipmentId)?.docNo ?? '',
    carrierId: carrier.id, expenseItemId: item.id, currency: body.currency, amount: round(num(body.amount), 2),
    incurredLocation: body.incurredLocation || 'MX', estimateFlag: body.estimateFlag, estimateFeeId, bizDate: body.bizDate || today(countryId), remark: body.remark ?? '',
  }
}

export function createFee(ctx: Ctx, body: Row) {
  requirePerm(ctx, 'lgs:fee:create')
  const f: Row = { ...buildFee(ctx, body), id: nextId(), countryId: ctx.countryId, docNo: docNo(ctx.countryId!, 'LF'), status: 'DRAFT', actualFeeId: null, diffAmount: null, apBillLineId: null, version: 1, createdBy: ctx.user.id, createdAt: nowIso() }
  getDb().lgsFees.unshift(f)
  audit(ctx, '新增', 'lgs-fee', f.id, null, f)
  return body.confirm ? confirmFee(ctx, f) : f
}

/** 确认费用；实际费用关联暂估时，暂估标记为已调整，差额由成本调整处理，不覆盖历史 */
export function confirmFee(ctx: Ctx, f: Row) {
  requirePerm(ctx, 'lgs:fee:confirm')
  requireDocumentDataAccess(ctx, 'LGS_FEE', f)
  const retryCost = f.status === 'CONFIRMED' && f.costStatus === 'PENDING_RATE'
  if (f.status === 'CONFIRMED' && !retryCost) return f
  if (f.status !== 'DRAFT' && !retryCost) conflict('只有草稿或待补汇率的已确认费用可以确认')
  assertPeriodOpen(ctx.countryId!, f.bizDate || today(ctx.countryId!))
  const est = f.estimateFeeId ? getDb().lgsFees.find(x => x.id === f.estimateFeeId) : null
  if (f.estimateFeeId && (!est || (est.status !== 'CONFIRMED' && !(retryCost && est.status === 'ADJUSTED' && est.actualFeeId === f.id)))) conflict('关联暂估费用已被其他实际费用使用')
  reconcileActualFee(ctx, f)
  if (est) {
    // A pending-rate confirmation reserves its estimate; recovery completes that same link.
    if (est.status === 'CONFIRMED') Object.assign(est, { status: 'ADJUSTED', actualFeeId: f.id, version: est.version + 1 })
    f.diffAmount = est.currency === f.currency ? round(f.amount - est.amount, 2) : null
  }
  if (!retryCost) Object.assign(f, { status: 'CONFIRMED', confirmedBy: ctx.user.id, confirmedAt: nowIso(), version: f.version + 1 })
  else if (f.costStatus === 'READY') f.version += 1
  if (!retryCost || f.costStatus === 'READY') audit(ctx, retryCost ? '补齐费用汇率与成本差额' : '确认（LGS_FEE_CONFIRMED）', 'lgs-fee', f.id, null, { amount: f.amount, currency: f.currency, diffAmount: f.diffAmount })
  return f
}

const fees = crud('/lgs/fees', 'lgsFees', {
  viewPerm: ['lgs:fee:create', 'lgs:fee:confirm', 'lgs:shipment:view'],
  canAccess: (row, ctx) => canDocumentDataAccess(ctx, 'LGS_FEE', row),
  keywordKeys: ['docNo', 'refNo', 'shipmentNo', 'remark'],
  filterKeys: ['status', 'estimateFlag', 'shipmentId', 'carrierId', 'refType', 'currency'],
  out: (row, ctx) => feeOut(row, ctx),
})

const feeExtras = [
  http.post(`${API}/lgs/fees`, handle((ctx, { body }) => {
    requireCountry(ctx)
    return feeOut(createFee(ctx, body), ctx)
  })),
  http.put(`${API}/lgs/fees/:id`, handle((ctx, { params, body }) => {
    requirePerm(ctx, 'lgs:fee:create')
    const f = findOr404(ctx, 'lgsFees', Number(params.id), { canAccess: (row) => canDocumentDataAccess(ctx, 'LGS_FEE', row) })
    checkVersion(f, body)
    if (f.status !== 'DRAFT') conflict('已确认的费用不能修改；金额有误请登记实际费用关联暂估')
    Object.assign(f, buildFee(ctx, body), { version: f.version + 1 })
    return feeOut(f, ctx)
  })),
  http.post(`${API}/lgs/fees/:id/confirm`, handle((ctx, { params }) => feeOut(confirmFee(ctx, findOr404(ctx, 'lgsFees', Number(params.id))), ctx))),
  http.post(`${API}/lgs/fees/:id/void`, handle((ctx, { params }) => {
    requirePerm(ctx, 'lgs:fee:create')
    const f = findOr404(ctx, 'lgsFees', Number(params.id), { canAccess: (row) => canDocumentDataAccess(ctx, 'LGS_FEE', row) })
    if (f.status !== 'DRAFT') conflict('只有草稿可以作废')
    f.status = 'VOIDED'
    f.version += 1
    return feeOut(f, ctx)
  })),
]

// ---------- 在途看板 ----------

const inTransit = http.get(`${API}/lgs/in-transit`, handle((ctx) => {
  requirePerm(ctx, 'lgs:shipment:view')
  const countryId = requireCountry(ctx)
  const db = getDb()
  const sp = ctx.url.searchParams
  const groups = new Map<string, Row>()
  for (const sh of db.shipments.filter((s) => s.countryId === countryId && canDocumentDataAccess(ctx, 'SHIPMENT', s) && RANK[s.status] >= RANK.IN_TRANSIT && s.status !== 'COMPLETED')) {
    if (sp.get('warehouseId') && String(sh.destWarehouseId) !== sp.get('warehouseId')) continue
    for (const l of sh.lines) {
      if (sp.get('productId') && String(l.productId) !== sp.get('productId')) continue
      const key = `${sh.destWarehouseId}:${l.productId}`
      if (!groups.has(key)) {
        groups.set(key, withProduct({ id: key, warehouseId: sh.destWarehouseId, warehouseName: nameOf(db.warehouses, sh.destWarehouseId), productId: l.productId, intlQty: 0, pendingDeliveryQty: 0, onHoldQty: 0, deliveringQty: 0, openDiscrepancyQty: 0, shipments: [] as Row[] }))
      }
      const g = groups.get(key)!
      const openDisc = sum(db.discrepancies.filter((d) => d.shipmentLineId === l.id && d.status !== 'RESOLVED'), (d) => d.qty)
      g.intlQty += l.intlQty
      g.pendingDeliveryQty += l.pendingDeliveryQty
      g.onHoldQty += l.onHoldQty
      g.deliveringQty += l.deliveringQty
      g.openDiscrepancyQty += openDisc
      g.shipments.push({ id: sh.id, docNo: sh.docNo, status: sh.status, intlQty: l.intlQty, pendingDeliveryQty: l.pendingDeliveryQty, onHoldQty: l.onHoldQty, deliveringQty: l.deliveringQty, openDiscrepancyQty: openDisc, plannedEta: sh.plannedEta, actualEta: sh.actualEta })
    }
  }
  const records = [...groups.values()]
    .map((g): Row => ({ ...g, totalQty: g.intlQty + g.pendingDeliveryQty + g.onHoldQty + g.deliveringQty }))
    .filter((g) => g.totalQty + g.openDiscrepancyQty > 0)
  return { records, total: records.length, page: 1, size: records.length }
}))

// ---------- 定时检查：延误、暂缓复查 ----------

export function runLgsChecks(countryId: number) {
  const db = getDb()
  for (const sh of db.shipments.filter((s) => s.countryId === countryId)) {
    const info = delayInfo(sh)
    const key = `LGS_DELAY:${sh.id}`
    if (info.delayed) openTodo({ countryId, todoType: 'LOGISTICS_DELAY', dedupKey: key, title: `${sh.docNo} ${info.delayStage}已超计划 ${info.delayHours} 小时`, link: `/logistics/shipments/${sh.id}`, perm: 'lgs:shipment:view' })
    else closeTodo(key, '节点已记录')
  }
  const now = today(countryId)
  for (const h of db.holds.filter((x) => x.countryId === countryId && x.status !== 'RELEASED' && x.reviewDate <= now)) {
    openTodo({ countryId, todoType: 'HOLD_REVIEW', dedupKey: `LGS_HOLD:${h.id}`, title: `暂缓 ${h.docNo}（${h.shipmentNo}）已到复查日期 ${h.reviewDate}`, link: '/logistics/holds', perm: 'lgs:hold:create', assigneeId: h.ownerId })
  }
}

onPeriodic(runLgsChecks)

export const lgsHandlers = [
  ...shipments.handlers(shipmentExtras),
  http.get(`${API}/lgs/transships`, handle((ctx) => {
    requirePerm(ctx, 'lgs:shipment:view')
    const sid = ctx.url.searchParams.get('shipmentId')
    return getDb().transships.filter((t) => t.countryId === requireCountry(ctx) && canDocumentDataAccess(ctx, 'TRANSSHIP', t) && (!sid || String(t.shipmentId) === sid)).map(transshipOut)
  })),
  http.post(`${API}/lgs/transships`, handle((ctx, { body }) => {
    requireCountry(ctx)
    return transshipOut(createTransship(ctx, body))
  })),
  ...holds.handlers(holdExtras),
  ...deliveries.handlers(deliveryExtras),
  ...receipts.handlers(receiptExtras),
  ...discrepancies.handlers(discrepancyExtras),
  ...fees.handlers(feeExtras),
  inTransit,
]
