/* eslint-disable @typescript-eslint/no-explicit-any */
/**
 * 06 畅销滞销联合分类与补货待办。有效订购数量只计已审批未取消的订单，分批出库不重复计数。
 */
import { http } from 'msw'
import { getDb, nextId, nowIso, type Row } from '../db'
import { API, findOr404 } from '../crud'
import { audit, canDataAccess, handle, paginate, requireCountry, requireDataAccess, requirePerm, scopeOf, type Ctx } from '../utils'
import { bad, country, docNo, nameOf, num, product, round, sum, today, userName, warehouseOf, withProduct } from '../services/common'
import { stockOf } from '../services/inventory'
import { readableSalesOrder } from '../services/access'

const INF = 1e12

function localDate(iso: string, tz: string) {
  if (!iso) return ''
  const d = new Date(iso)
  if (Number.isNaN(d.getTime())) return String(iso).slice(0, 10)
  return new Intl.DateTimeFormat('en-CA', { timeZone: tz }).format(d)
}

function addDays(day: string, delta: number) {
  const d = new Date(`${day}T12:00:00Z`)
  d.setUTCDate(d.getUTCDate() + delta)
  return d.toISOString().slice(0, 10)
}

function rangeOf(op: string, a: number, b: number) {
  if (op === 'ANY') return { lo: -INF, hi: INF }
  if (op === 'LT') return { lo: -INF, hi: a - 1e-6 }
  if (op === 'LTE') return { lo: -INF, hi: a }
  if (op === 'GT') return { lo: a + 1e-6, hi: INF }
  if (op === 'GTE') return { lo: a, hi: INF }
  if (op === 'BETWEEN') return { lo: Math.min(a, b), hi: Math.max(a, b) }
  bad('比较符只支持 LT / LTE / GT / GTE / BETWEEN / ANY')
}

function overlaps(x: { lo: number; hi: number }, y: { lo: number; hi: number }) {
  return x.lo <= y.hi && y.lo <= x.hi
}

function hits(op: string, value: number, a: number, b: number) {
  if (op === 'ANY') return true
  if (op === 'LT') return value < a
  if (op === 'LTE') return value <= a
  if (op === 'GT') return value > a
  if (op === 'GTE') return value >= a
  if (op === 'BETWEEN') return value >= Math.min(a, b) && value <= Math.max(a, b)
  return false
}

export function classifyConflicts(conditions: Row[]) {
  const conflicts: { left: string; right: string; priority: number }[] = []
  for (let i = 0; i < conditions.length; i++) {
    for (let j = i + 1; j < conditions.length; j++) {
      const a = conditions[i]
      const b = conditions[j]
      if (Number(a.priority) !== Number(b.priority) || a.label === b.label) continue
      const stock = overlaps(rangeOf(a.stockOp, num(a.stockValue), num(a.stockValue2)), rangeOf(b.stockOp, num(b.stockValue), num(b.stockValue2)))
      const order = overlaps(rangeOf(a.orderOp, num(a.orderValue), num(a.orderValue2)), rangeOf(b.orderOp, num(b.orderValue), num(b.orderValue2)))
      if (stock && order) conflicts.push({ left: a.label, right: b.label, priority: Number(a.priority) })
    }
  }
  return conflicts
}

function periodOf(rule: Row, countryId: number) {
  const end = today(countryId)
  if (rule.periodType === 'CALENDAR_MONTH') return { start: `${end.slice(0, 7)}-01`, end }
  if (rule.periodType === 'CALENDAR_WEEK') return { start: addDays(end, -6), end }
  const days = Math.max(1, num(rule.periodDays) || 30)
  return { start: addDays(end, -(days - 1)), end }
}

function demand(countryId: number, productId: number, start: string, end: string, dimType: string, dimId: number) {
  const db = getDb()
  const tz = country(countryId).timezone
  const orders = db.salOrders.filter((o) => {
    if (o.countryId !== countryId || o.approvalStatus !== 'APPROVED') return false
    if (dimType === 'STORE' && o.storeId !== dimId) return false
    if (['CANCELLED', 'REJECTED', 'DRAFT'].includes(o.status)) return false
    const day = localDate(o.approvedAt || o.updatedAt || o.createdAt, tz)
    return day >= start && day <= end && o.lines.some((l: Row) => l.productId === productId)
  })
  const lines: { order: Row; line: Row; qty: number }[] = []
  for (const o of orders) {
    for (const l of o.lines.filter((x: Row) => x.productId === productId)) {
      const allocs = (l.allocs ?? []).filter((a: Row) => dimType !== 'WAREHOUSE' || a.warehouseId === dimId)
      const qty = dimType === 'WAREHOUSE'
        ? sum(allocs, (a: Row) => Math.max(0, num(a.allocQty) - num(a.cancelledQty)))
        : Math.max(0, num(l.baseQty) - num(l.cancelledQty))
      if (qty > 0) lines.push({ order: o, line: dimType === 'WAREHOUSE' ? { ...l, allocs, outboundQty: sum(allocs, (a: Row) => num(a.outboundQty)), returnedQty: sum(allocs, (a: Row) => num(a.returnedQty)) } : l, qty })
    }
  }
  return { lines, orderQty: round(sum(lines, (x) => x.qty), 4), orderCount: new Set(lines.map((x) => x.order.id)).size }
}

function stockSnapshot(countryId: number, dimType: string, dimId: number, productId: number) {
  const db = getDb()
  if (dimType === 'WAREHOUSE') return stockOf(dimId, productId)
  if (dimType === 'STORE') {
    const wh = db.warehouses.find((w) => w.storeId === dimId)
    return wh ? stockOf(wh.id, productId) : { onHand: 0, reserved: 0, frozen: 0, available: 0 }
  }
  const whs = db.warehouses.filter((w) => w.countryId === countryId)
  return whs.reduce(
    (a, w) => {
      const s = stockOf(w.id, productId)
      return { onHand: a.onHand + s.onHand, reserved: a.reserved + s.reserved, frozen: a.frozen + s.frozen, available: a.available + s.available }
    },
    { onHand: 0, reserved: 0, frozen: 0, available: 0 },
  )
}

function dimObjects(countryId: number, dimType: string) {
  const db = getDb()
  if (dimType === 'WAREHOUSE') return db.warehouses.filter((w) => w.countryId === countryId && w.status === 'ENABLED').map((w) => ({ id: w.id, name: w.name }))
  if (dimType === 'STORE') return db.stores.filter((s) => s.countryId === countryId && s.status === 'ENABLED').map((s) => ({ id: s.id, name: s.name }))
  const c = country(countryId)
  return [{ id: countryId, name: c.name }]
}

function matchLabel(rule: Row, stockValue: number, orderValue: number) {
  const conds = [...(rule.conditions ?? [])].sort((a, b) => num(a.priority) - num(b.priority) || num(a.id) - num(b.id))
  for (const c of conds) {
    if (hits(c.stockOp, stockValue, num(c.stockValue), num(c.stockValue2)) && hits(c.orderOp, orderValue, num(c.orderValue), num(c.orderValue2))) return c
  }
  return null
}

export function recalculateClassify(countryId: number, ruleId?: number) {
  const db = getDb()
  const rules = db.classifyRules.filter((r) => r.countryId === countryId && r.status === 'ACTIVE' && (ruleId == null || r.id === ruleId))
  const skus = db.countrySkus.filter((s) => s.countryId === countryId && s.status === 'ENABLED')
  let count = 0
  for (const rule of rules) {
    const period = periodOf(rule, countryId)
    for (const dim of dimObjects(countryId, rule.dimType)) {
      for (const sku of skus) {
        const dem = demand(countryId, sku.productId, period.start, period.end, rule.dimType, dim.id)
        const stock = stockSnapshot(countryId, rule.dimType, dim.id, sku.productId)
        const stockValue = rule.stockMetric === 'ON_HAND' ? stock.onHand : stock.available
        const orderValue = rule.orderMetric === 'ORDER_COUNT' ? dem.orderCount : dem.orderQty
        const unassigned = round(sum(dem.lines, (x) => Math.max(0, x.qty - sum(x.line.allocs ?? [], (a: Row) => num(a.allocQty) - num(a.cancelledQty)))), 4)
        const outboundQty = round(sum(dem.lines, (x) => num(x.line.outboundQty)), 4)
        const returnedQty = round(sum(dem.lines, (x) => num(x.line.returnedQty)), 4)
        const hit = matchLabel(rule, stockValue, orderValue)
        const label = hit?.label ?? 'PENDING_JUDGE'
        const prev = db.classifyResults.find((r) => r.ruleId === rule.id && r.dimType === rule.dimType && r.dimId === dim.id && r.productId === sku.productId)
        const basis = { stockValue, orderValue, condId: hit?.id ?? null, orderIds: dem.lines.map((x) => x.order.id) }
        if (prev && prev.label !== label) {
          db.classifyResultLogs = db.classifyResultLogs ?? []
          db.classifyResultLogs.unshift({ id: nextId(), resultId: prev.id, oldLabel: prev.label, newLabel: label, trigger: 'RULE', changedAt: nowIso(), basis })
        }
        const row = {
          id: prev?.id ?? nextId(), countryId, ruleId: rule.id, ruleName: rule.name, ruleVersionNo: rule.versionNo,
          dimType: rule.dimType, dimId: dim.id, dimName: dim.name, productId: sku.productId,
          warehouseId: rule.dimType === 'WAREHOUSE' ? dim.id : null, storeId: rule.dimType === 'STORE' ? dim.id : null,
          periodStart: period.start, periodEnd: period.end, stockSnapshotAt: nowIso(),
          availableQty: stock.available, onHandQty: stock.onHand, reservedQty: stock.reserved, frozenQty: stock.frozen,
          orderQty: dem.orderQty, orderCount: dem.orderCount, unassignedQty: unassigned, outboundQty, returnedQty,
          label, hitCondId: hit?.id ?? null, hitText: hit ? `${hit.stockOp} ${hit.stockValue} 且 ${hit.orderOp} ${hit.orderValue}` : '没有命中条件',
          orderIds: basis.orderIds, computedAt: nowIso(),
        }
        if (prev) Object.assign(prev, row)
        else db.classifyResults.unshift(row)
        count += 1
      }
    }
  }
  if (!rules.length) {
    for (const sku of skus) {
      const row = {
        id: nextId(), countryId, ruleId: null, ruleName: '', ruleVersionNo: 0, dimType: 'COUNTRY', dimId: countryId, dimName: country(countryId).name,
        productId: sku.productId, periodStart: null, periodEnd: null, stockSnapshotAt: nowIso(),
        availableQty: null, onHandQty: null, reservedQty: null, frozenQty: null, orderQty: null, orderCount: null,
        unassignedQty: null, outboundQty: null, returnedQty: null, label: 'PENDING_JUDGE', hitCondId: null, hitText: '没有生效的分类规则', orderIds: [], computedAt: nowIso(),
      }
      const previous = db.classifyResults.find(r => r.countryId === countryId && r.ruleId == null && r.productId === sku.productId)
      if (previous) Object.assign(previous, { ...row, id: previous.id })
      else db.classifyResults.unshift(row)
      count += 1
    }
  }
  return count
}

function ruleOut(r: Row) {
  return { ...r, updatedByName: userName(r.updatedBy) }
}

function saveRule(ctx: Ctx, previous: Row | null, body: Row) {
  requirePerm(ctx, 'inv:classify:config')
  const countryId = requireCountry(ctx)
  const conditions = (body.conditions ?? previous?.conditions ?? []) as Row[]
  if (!conditions.length) bad('请至少配置一条组合条件')
  const conflicts = classifyConflicts(conditions)
  if (conflicts.length) bad('同一优先级下库存区间和订单区间重叠，但标签不同', 'INV_CLASSIFY_CONFLICT', conflicts)
  const conds = conditions.map((c, i) => ({
    id: c.id ?? i + 1, label: c.label, priority: num(c.priority) || i + 1,
    stockOp: c.stockOp, stockValue: num(c.stockValue), stockValue2: num(c.stockValue2),
    orderOp: c.orderOp, orderValue: num(c.orderValue), orderValue2: num(c.orderValue2),
  }))
  if (previous) {
    if (previous.status === 'RETIRED') bad('历史规则不能修改，请编辑当前版本')
    const next = { ...structuredClone(previous), id: nextId(),
      name: body.name ?? previous.name, dimType: body.dimType ?? previous.dimType, periodType: body.periodType ?? previous.periodType,
      periodDays: num(body.periodDays ?? previous.periodDays), orderMetric: body.orderMetric ?? previous.orderMetric,
      stockMetric: body.stockMetric ?? previous.stockMetric, conditions: conds, versionNo: previous.versionNo + 1,
      status: body.status || 'ACTIVE', updatedBy: ctx.user.id, updatedAt: nowIso(),
    }
    previous.status = 'RETIRED'
    getDb().classifyRules.unshift(next)
    recalculateClassify(countryId, next.id)
    audit(ctx, '更新分类规则', 'classify-rule', next.id, { versionNo: previous.versionNo }, { versionNo: next.versionNo })
    return ruleOut(next)
  }
  const row: Row = {
    id: nextId(), countryId, name: body.name || '联合分类', dimType: body.dimType || 'WAREHOUSE', periodType: body.periodType || 'ROLLING_DAYS',
    periodDays: num(body.periodDays) || 90, orderMetric: body.orderMetric || 'QTY', stockMetric: body.stockMetric || 'AVAILABLE',
    versionNo: 1, status: 'ACTIVE', effectiveFrom: body.effectiveFrom || today(countryId), conditions: conds,
    updatedBy: ctx.user.id, createdAt: nowIso(),
  }
  getDb().classifyRules.unshift(row)
  recalculateClassify(countryId, row.id)
  audit(ctx, '新增分类规则', 'classify-rule', row.id, null, null)
  return ruleOut(row)
}

function resultOut(r: Row) {
  return withProduct({ ...r })
}

const ruleList = http.get(`${API}/inv/classify-rules`, handle((ctx) => {
  requirePerm(ctx, ['inv:classify:config', 'inv:classify:view'])
  const countryId = requireCountry(ctx)
  return paginate(getDb().classifyRules.filter((r) => r.countryId === countryId && r.status !== 'RETIRED' && canDataAccess(ctx, r)).map(ruleOut), ctx.url)
}))

const ruleCreate = http.post(`${API}/inv/classify-rules`, handle((ctx, { body }) => saveRule(ctx, null, body ?? {})))

const ruleUpdate = http.put(`${API}/inv/classify-rules/:id`, handle((ctx, { params, body }) => {
  const row = findOr404(ctx, 'classifyRules', Number(params.id))
  return saveRule(ctx, row, body ?? {})
}))

const ruleValidate = http.post(`${API}/inv/classify-rules/:id/validate`, handle((ctx, { params, body }) => {
  requirePerm(ctx, 'inv:classify:config')
  const row = findOr404(ctx, 'classifyRules', Number(params.id))
  const conditions = body?.conditions ?? row.conditions
  const conflicts = classifyConflicts(conditions)
  return { ok: conflicts.length === 0, conflicts }
}))

const ruleRecalc = http.post(`${API}/inv/classify-rules/:id/recalculate`, handle((ctx, { params }) => {
  requirePerm(ctx, ['inv:classify:config', 'inv:classify:view'])
  const row = findOr404(ctx, 'classifyRules', Number(params.id))
  const count = recalculateClassify(ctx.countryId!, row.id)
  return { count, ruleVersionNo: row.versionNo }
}))

const results = http.get(`${API}/inv/classify-results`, handle((ctx) => {
  requirePerm(ctx, 'inv:classify:view')
  const countryId = requireCountry(ctx)
  const db = getDb()
  db.classifyResults = db.classifyResults ?? []
  recalculateClassify(countryId)
  const active = new Set(db.classifyRules.filter(r => r.countryId === countryId && r.status === 'ACTIVE').map(r => r.id))
  const sp = ctx.url.searchParams
  const rows = getDb().classifyResults
    .filter((r) => r.countryId === countryId)
    .filter(r => active.size ? active.has(r.ruleId) : r.ruleId == null)
    .filter(r => r.dimType === 'COUNTRY' ? scopeOf(ctx).all : canDataAccess(ctx, r, r.dimType === 'STORE' ? { storeField: 'dimId' } : { warehouseField: 'dimId' }))
    .filter((r) => ['label', 'dimType', 'productId', 'ruleId'].every((k) => !sp.get(k) || String(r[k]) === sp.get(k)))
    .map(resultOut)
  return paginate(rows, ctx.url)
}))

const resultOrders = http.get(`${API}/inv/classify-results/:id/orders`, handle((ctx, { params }) => {
  requirePerm(ctx, 'inv:classify:view')
  const row = findOr404(ctx, 'classifyResults', Number(params.id))
  requireDataAccess(ctx, row, row.dimType === 'STORE' ? { storeField: 'dimId' } : row.dimType === 'WAREHOUSE' ? { warehouseField: 'dimId' } : { warehouseField: '__country_only__' })
  if (row.dimType === 'COUNTRY' && !scopeOf(ctx).all) bad('没有全国汇总权限', 'SYS_FORBIDDEN')
  const db = getDb()
  const ids = new Set(row.orderIds ?? [])
  return db.salOrders.filter((o) => ids.has(o.id) && canDataAccess(ctx, o)).map(o => readableSalesOrder(ctx, o)).map((o) => ({
    id: o.id, docNo: o.docNo, customerName: nameOf(db.customers, o.customerId), approvalStatus: o.approvalStatus,
    fulfillmentStatus: o.fulfillmentStatus, qty: round(sum(o.lines.filter((l: Row) => l.productId === row.productId), (l: Row) => row.dimType === 'WAREHOUSE' ? sum(l.allocs.filter((a: Row) => a.warehouseId === row.dimId), (a: Row) => num(a.allocQty)-num(a.cancelledQty)) : num(l.baseQty) - num(l.cancelledQty)), 4),
    outboundQty: round(sum(o.lines.filter((l: Row) => l.productId === row.productId), (l: Row) => row.dimType === 'WAREHOUSE' ? sum(l.allocs.filter((a: Row) => a.warehouseId === row.dimId), (a: Row) => num(a.outboundQty)) : num(l.outboundQty)), 4),
  }))
}))

function openReplenish(r: Row) {
  return !['CLOSED', 'FULFILLED'].includes(r.status)
}

function refreshReplenish(r: Row) {
  const db = getDb()
  let got = 0
  for (const link of r.links ?? []) {
    if (link.execDocType === 'INV_TRANSFER') {
      const t = db.transfers.find((x) => x.id === link.execDocId && x.countryId === r.countryId && x.toWarehouseId === r.warehouseId)
      const quantity = sum((t?.lines ?? []).filter((l: Row) => l.productId === r.productId && (!link.execLineId || l.id === link.execLineId)), (l: Row) => num(l.receivedQty))
      got += Math.min(num(link.qty), quantity)
    } else {
      const po = db.purOrders.find((x) => x.id === link.execDocId && x.countryId === r.countryId)
      const quantity = sum((po?.lines ?? []).filter((l: Row) => l.productId === r.productId && (!link.execLineId || l.id === link.execLineId)), (l: Row) => num(l.arrivedMxQty))
      got += Math.min(num(link.qty), quantity)
    }
  }
  r.fulfilledQty = round(Math.min(num(r.reqQty), got), 4)
  if (['LINKED', 'PARTIAL', 'FULFILLED'].includes(r.status)) {
    if (r.fulfilledQty >= num(r.reqQty) && num(r.reqQty) > 0) r.status = 'FULFILLED'
    else if (r.fulfilledQty > 0) r.status = 'PARTIAL'
  }
}

function replenishOut(r: Row) {
  refreshReplenish(r)
  const db = getDb()
  return withProduct({ ...r, warehouseName: nameOf(db.warehouses, r.warehouseId), decidedByName: userName(r.decidedBy) })
}

export function suggestReplenishments(ctx: Ctx) {
  const db = getDb()
  const countryId = ctx.countryId!
  let created = 0
  for (const alert of db.stockAlerts.filter((a) => a.countryId === countryId && a.status === 'OPEN' && ['BELOW_MIN', 'OUT_OF_STOCK'].includes(a.alertType))) {
    if (db.replenishments.some((r) => openReplenish(r) && r.warehouseId === alert.warehouseId && r.productId === alert.productId && r.alertId === alert.id)) continue
    const others = db.warehouses.filter((w) => w.countryId === countryId && w.id !== alert.warehouseId)
    const canTransfer = others.some((w) => stockOf(w.id, alert.productId).available > 0)
    db.replenishments.unshift({
      id: nextId(), countryId, docNo: docNo(countryId, 'RP'), warehouseId: alert.warehouseId, productId: alert.productId,
      reqQty: Math.max(1, num(alert.threshold) - num(alert.availableQty)), needDate: today(countryId),
      reason: alert.alertType === 'OUT_OF_STOCK' ? '缺货预警' : '低于下限', suggestedSource: canTransfer ? 'TRANSFER' : 'PURCHASE',
      decidedSource: null, alertId: alert.id, status: 'PENDING', decidedBy: null, decisionNote: '', fulfilledQty: 0, links: [], createdAt: nowIso(),
    })
    created += 1
  }
  return created
}

const repList = http.get(`${API}/inv/replenishments`, handle((ctx) => {
  requirePerm(ctx, ['inv:replenish:create', 'inv:replenish:decide', 'inv:stock:view'])
  const countryId = requireCountry(ctx)
  const sp = ctx.url.searchParams
  const rows = getDb().replenishments.filter((r) => r.countryId === countryId && canDataAccess(ctx, r)).map(replenishOut).filter((r) => !sp.get('status') || r.status === sp.get('status'))
  return paginate(rows, ctx.url)
}))

const repCreate = http.post(`${API}/inv/replenishments`, handle((ctx, { body }) => {
  requirePerm(ctx, 'inv:replenish:create')
  const countryId = requireCountry(ctx)
  const wh = warehouseOf(countryId, Number(body?.warehouseId))
  requireDataAccess(ctx, { countryId, warehouseId: wh.id })
  const p = product(Number(body?.productId))
  if (!p) bad('请选择商品')
  if (!(num(body?.reqQty) > 0)) bad('需求数量必须大于 0')
  const row: Row = {
    id: nextId(), countryId, docNo: docNo(countryId, 'RP'), warehouseId: wh.id, productId: p.id, reqQty: num(body.reqQty),
    needDate: body.needDate || today(countryId), reason: body.reason || '手工申请', suggestedSource: body.suggestedSource || 'PURCHASE',
    decidedSource: null, alertId: body.alertId ?? null, status: 'PENDING', decidedBy: null, decisionNote: '', fulfilledQty: 0, links: [], createdAt: nowIso(),
  }
  getDb().replenishments.unshift(row)
  audit(ctx, '提交补货待办', 'replenishment', row.id, null, { docNo: row.docNo })
  return replenishOut(row)
}))

const repSuggest = http.post(`${API}/inv/replenishments/suggest`, handle((ctx) => {
  requirePerm(ctx, ['inv:replenish:create', 'inv:replenish:decide'])
  requireCountry(ctx)
  return { created: suggestReplenishments(ctx) }
}))

const repDecide = http.post(`${API}/inv/replenishments/:id/decide`, handle((ctx, { params, body }) => {
  requirePerm(ctx, 'inv:replenish:decide')
  const r = findOr404(ctx, 'replenishments', Number(params.id))
  requireDataAccess(ctx, r)
  if (r.status !== 'PENDING') bad('只有待处理的补货可以审批')
  if (body?.reject) {
    r.status = 'CLOSED'
    r.decisionNote = body.note || '无需补货'
  } else {
    if (!['TRANSFER', 'PURCHASE'].includes(body?.decidedSource)) bad('请选择调拨或中国采购')
    r.status = 'APPROVED'
    r.decidedSource = body.decidedSource
    r.decisionNote = body.note ?? ''
  }
  r.decidedBy = ctx.user.id
  audit(ctx, '处理补货待办', 'replenishment', r.id, null, { status: r.status })
  return replenishOut(r)
}))

const repLink = http.post(`${API}/inv/replenishments/:id/link`, handle((ctx, { params, body }) => {
  requirePerm(ctx, 'inv:replenish:decide')
  const r = findOr404(ctx, 'replenishments', Number(params.id))
  requireDataAccess(ctx, r)
  if (!['APPROVED', 'LINKED', 'PARTIAL'].includes(r.status)) bad('请先批准并选择来源，再关联执行单')
  const db = getDb()
  const docType = body?.execDocType
  const docId = Number(body?.execDocId)
  const doc = docType === 'INV_TRANSFER' ? db.transfers.find((t) => t.id === docId && t.countryId === ctx.countryId) : db.purOrders.find((t) => t.id === docId && t.countryId === ctx.countryId)
  if (!doc) bad('执行单不存在')
  if (!['PUR_ORDER', 'INV_TRANSFER'].includes(docType)) bad('执行单类型不正确')
  if (docType === 'INV_TRANSFER' && doc.toWarehouseId !== r.warehouseId) bad('调拨目标仓与补货仓不一致')
  if (docType === 'PUR_ORDER' && r.decidedSource !== 'PURCHASE') bad('来源不是中国采购，不能关联采购单')
  if (docType === 'INV_TRANSFER' && r.decidedSource !== 'TRANSFER') bad('来源不是调拨，不能关联调拨单')
  r.links = r.links ?? []
  const lines = doc.lines.filter((l: Row) => l.productId === r.productId && (!body?.execLineId || l.id === Number(body.execLineId)))
  if (lines.length !== 1) bad('请选择唯一的商品执行行')
  const execLineId = lines[0].id
  if (!r.links.some((l: Row) => l.execDocType === docType && l.execDocId === docId && l.execLineId === execLineId)) {
    const qty = Number(body?.qty ?? r.reqQty)
    if (!(qty > 0) || qty > num(r.reqQty) - sum(r.links, (l: Row) => num(l.qty))) bad('关联数量不能超过剩余补货需求')
    const alreadyLinked = sum(db.replenishments.flatMap(x => x.links ?? []).filter((l: Row) => l.execDocType === docType && l.execDocId === docId && l.execLineId === execLineId), (l: Row) => num(l.qty))
    const capacity = num(lines[0].baseQty ?? lines[0].qty) - num(lines[0].cancelledQty)
    if (qty + alreadyLinked > capacity) bad('执行行已被其它补货待办占用，关联数量超出可执行数量')
    r.links.push({ id: nextId(), execDocType: docType, execDocId: docId, execLineId, execNo: doc.docNo, qty })
  }
  if (r.status === 'APPROVED') r.status = 'LINKED'
  audit(ctx, '关联补货执行单', 'replenishment', r.id, null, { execDocType: docType, execNo: doc.docNo })
  return replenishOut(r)
}))

const repClose = http.post(`${API}/inv/replenishments/:id/close`, handle((ctx, { params, body }) => {
  requirePerm(ctx, 'inv:replenish:decide')
  const r = findOr404(ctx, 'replenishments', Number(params.id))
  requireDataAccess(ctx, r)
  if (!body?.note) bad('请填写关闭结论')
  r.status = 'CLOSED'
  r.decisionNote = body.note
  return replenishOut(r)
}))

export const anaHandlers = [
  ruleList, ruleCreate, ruleValidate, ruleRecalc, ruleUpdate, results, resultOrders,
  repSuggest, repList, repCreate, repDecide, repLink, repClose,
]
