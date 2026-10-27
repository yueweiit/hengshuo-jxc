/* eslint-disable @typescript-eslint/no-explicit-any */
/**
 * 08 收款、授信与客户应收。出库时形成应收；现款用已确认收款自动核销（A10、A11、A12）。
 */
import { http } from 'msw'
import { getDb, nextId, nowIso, type Row } from '../db'
import { API, findOr404 } from '../crud'
import { audit, handle, notFound, paginate, requireCountry, requireDataAccess, requirePerm, type Ctx } from '../utils'
import { bad, baseCcy, conflict, docNo, nameOf, num, openTodo, round, sum, today, userName } from '../services/common'
import { assertPeriodOpen } from '../services/period'
import { canDocumentDataAccess, readableBusinessFields, requireDocumentAccess } from '../services/access'

const addDays = (date: string, days: number) => {
  const d = new Date(`${date}T12:00:00Z`)
  d.setUTCDate(d.getUTCDate() + days)
  return d.toISOString().slice(0, 10)
}

export function activeCreditRule(countryId: number, customerId: number, date = today(countryId)) {
  const db = getDb()
  const customer = db.customers.find((c) => c.id === customerId)
  const rules = db.arCreditRules.filter((r) => r.countryId === countryId && r.status === 'ACTIVE' && r.effectiveFrom <= date && (!r.effectiveTo || r.effectiveTo >= date))
  return rules.find((r) => r.targetType === 'CUSTOMER' && r.targetId === customerId)
    ?? rules.find((r) => r.targetType === 'GROUP' && r.targetId === customer?.groupId)
    ?? null
}

function occupations(customerId: number) {
  return getDb().arOccupations.filter((o) => o.customerId === customerId && o.status === 'OPEN')
}

export function creditView(countryId: number, customerId: number) {
  const rule = activeCreditRule(countryId, customerId)
  const used = round(sum(occupations(customerId), (o) => o.amount - o.releasedAmount))
  const limit = rule?.paymentMode === 'CREDIT_ALLOWED' ? num(rule.creditLimit) : 0
  return { rule, used, limit, available: round(limit - used), currency: rule?.currency ?? baseCcy(countryId) }
}

export function evaluateCredit(countryId: number, customerId: number, paymentType: string, amount: number, stage: 'ORDER' | 'OUTBOUND', orderId?: number) {
  if (paymentType !== 'CREDIT') return { ok: true, message: '现款，不占用额度' }
  const view = creditView(countryId, customerId)
  if (!view.rule || view.rule.paymentMode !== 'CREDIT_ALLOWED') return { ok: false, code: 'AR_CREDIT_BLOCKED', message: '该客户没有赊销资格，只能现款' }
  const overdueBefore = addDays(today(countryId), -num(view.rule.graceDays))
  const overdue = getDb().arReceivables.some((r) => r.countryId === countryId && r.customerId === customerId && r.openAmount > 0 && (r.dueDate ? r.dueDate < overdueBefore : r.dueStatus === 'OVERDUE'))
  const policy = view.rule.overduePolicy
  if (overdue && ((stage === 'ORDER' && policy === 'BLOCK_ORDER') || (stage === 'OUTBOUND' && ['BLOCK_ORDER', 'BLOCK_OUTBOUND'].includes(policy)))) {
    return { ok: false, code: 'AR_CREDIT_BLOCKED', message: '客户有逾期应收，当前策略禁止继续赊销' }
  }
  // 本次出库把本单的预占转成应收，不是再申请一次信用额度。
  const ownReserve = stage === 'OUTBOUND' && orderId != null ? sum(occupations(customerId).filter((o) => o.occType === 'ORDER_RESERVE' && o.refType === 'SAL_ORDER' && o.refId === orderId), (o) => o.amount - o.releasedAmount) : 0
  const available = round(view.available + ownReserve)
  if (amount > available + 0.001 && !view.rule.allowException) return { ok: false, code: 'AR_CREDIT_BLOCKED', message: `超出可用额度 ${available}` }
  const overLimit = amount > available + 0.001
  const requiresApproval = overLimit || (overdue && policy === 'REQUIRE_APPROVAL')
  return { ok: true, message: requiresApproval ? '超额度或逾期，须有已通过的例外审批' : '额度充足', overLimit, overdue, requiresApproval }
}

function occupy(countryId: number, customerId: number, occType: string, refType: string, refId: number, amount: number) {
  if (!(amount > 0)) return
  getDb().arOccupations.unshift({
    id: nextId(), countryId, customerId, currency: baseCcy(countryId), occType, refType, refId, amount: round(amount), releasedAmount: 0, status: 'OPEN', createdAt: nowIso(),
  })
}

function releaseOcc(refType: string, refId: number, occType: string, amount: number) {
  let left = round(amount)
  for (const o of getDb().arOccupations.filter((x) => x.refType === refType && x.refId === refId && x.occType === occType && x.status === 'OPEN')) {
    if (left <= 0) break
    const open = round(o.amount - o.releasedAmount)
    const take = Math.min(open, left)
    o.releasedAmount = round(o.releasedAmount + take)
    if (o.releasedAmount >= o.amount - 0.001) o.status = 'RELEASED'
    left = round(left - take)
  }
}

export function reserveCredit(countryId: number, customerId: number, orderId: number, amount: number) {
  occupy(countryId, customerId, 'ORDER_RESERVE', 'SAL_ORDER', orderId, amount)
}

export function releaseCredit(orderId: number, amount: number) {
  releaseOcc('SAL_ORDER', orderId, 'ORDER_RESERVE', amount)
}

function dueDateOf(rule: Row | null, bizDate: string) {
  const days = rule?.termDays ?? 0
  if (rule?.dueBasis === 'MONTH_END_PLUS') {
    const d = new Date(`${bizDate}T12:00:00Z`)
    const end = new Date(Date.UTC(d.getUTCFullYear(), d.getUTCMonth() + 1, 0))
    return addDays(end.toISOString().slice(0, 10), rule.dueExtraDays ?? days)
  }
  return addDays(bizDate, days)
}

function refreshDue(r: Row) {
  if (r.openAmount <= 0) return
  const todayStr = today(r.countryId)
  const soon = addDays(todayStr, 7)
  r.dueStatus = r.dueDate < todayStr ? 'OVERDUE' : r.dueDate <= soon ? 'DUE_SOON' : 'NOT_DUE'
}

export function createReceivableFromOutbound(ctx: Ctx, o: { customerId: number; orderId: number; outboundId: number; amount: number; bizDate: string; paymentType: string }) {
  const db = getDb()
  const exist = db.arReceivables.find((r) => r.sourceType === 'SAL_OUTBOUND' && r.sourceId === o.outboundId)
  if (exist) return exist
  const rule = o.paymentType === 'CREDIT' ? activeCreditRule(ctx.countryId!, o.customerId, o.bizDate) : null
  const amount = round(o.amount)
  const row: Row = {
    id: nextId(), countryId: ctx.countryId, docNo: docNo(ctx.countryId!, 'AR', o.bizDate), customerId: o.customerId, orderId: o.orderId,
    sourceType: 'SAL_OUTBOUND', sourceId: o.outboundId, currency: baseCcy(ctx.countryId!), amount, writtenOffAmount: 0, openAmount: amount,
    bizDate: o.bizDate, dueDate: o.paymentType === 'CREDIT' ? dueDateOf(rule, o.bizDate) : o.bizDate,
    creditRuleVersionId: rule?.id ?? null, settleStatus: 'OPEN', dueStatus: 'NOT_DUE', createdAt: nowIso(),
  }
  refreshDue(row)
  db.arReceivables.unshift(row)
  if (o.paymentType === 'CREDIT') {
    releaseCredit(o.orderId, amount)
    occupy(ctx.countryId!, o.customerId, 'AR_OPEN', 'AR_RECEIVABLE', row.id, amount)
  }
  return row
}

function applyWriteoff(ctx: Ctx, customerId: number, fromType: string, fromId: number, receivable: Row, amount: number, reason: string) {
  const take = round(amount)
  if (!(take > 0)) return null
  const db = getDb()
  const wo: Row = {
    id: nextId(), countryId: ctx.countryId, docNo: docNo(ctx.countryId!, 'WO'), customerId, currency: baseCcy(ctx.countryId!), bizDate: today(ctx.countryId!),
    status: 'EFFECTIVE', reversalOfId: null, reason, lines: [{ fromType, fromId, receivableId: receivable.id, amount: take }], createdBy: ctx.user.id, createdAt: nowIso(),
  }
  receivable.writtenOffAmount = round(receivable.writtenOffAmount + take)
  receivable.openAmount = round(receivable.amount - receivable.writtenOffAmount)
  receivable.settleStatus = receivable.openAmount <= 0.001 ? 'SETTLED' : 'PARTIAL'
  if (receivable.settleStatus === 'SETTLED') releaseOcc('AR_RECEIVABLE', receivable.id, 'AR_OPEN', take)
  else {
    const occ = db.arOccupations.find((o) => o.refType === 'AR_RECEIVABLE' && o.refId === receivable.id && o.occType === 'AR_OPEN' && o.status === 'OPEN')
    if (occ) occ.releasedAmount = round(occ.releasedAmount + take)
  }
  if (fromType === 'RECEIPT') {
    const receipt = db.arReceipts.find((r) => r.id === fromId)
    if (receipt) {
      receipt.writtenOffAmount = round(num(receipt.writtenOffAmount) + take)
      const open = round(receipt.amount - receipt.writtenOffAmount)
      if (!['VOIDED', 'REJECTED'].includes(receipt.status)) receipt.status = open <= 0.001 ? 'WRITTEN_OFF' : 'PARTIAL_WRITTEN_OFF'
    }
  } else {
    const note = db.arCreditNotes.find((n) => n.id === fromId)
    if (note) note.usedAmount = round(num(note.usedAmount) + take)
  }
  db.arWriteoffs.unshift(wo)
  return wo
}

/** 现款：用分配到本订单的已确认收款核销刚生成的应收，现金不重复记（A11） */
export function autoWriteoffFromPrepaid(ctx: Ctx, orderId: number, receivable: Row) {
  const db = getDb()
  let left = receivable.openAmount
  for (const receipt of db.arReceipts.filter((r) => ['CONFIRMED', 'PARTIAL_WRITTEN_OFF'].includes(r.status))) {
    if (left <= 0) break
    for (const alloc of receipt.orders ?? []) {
      if (alloc.orderId !== orderId || left <= 0) continue
      const plannedLeft = round(num(alloc.plannedAmount) - num(alloc.usedAmount))
      const receiptLeft = round(receipt.amount - num(receipt.writtenOffAmount))
      const take = Math.min(left, plannedLeft, receiptLeft)
      if (take > 0) {
        const wo = applyWriteoff(ctx, receivable.customerId, 'RECEIPT', receipt.id, receivable, take, `出库自动核销 ${receivable.docNo}`)
        if (wo) Object.assign(wo.lines[0], { orderId, allocatedAmount: take })
        alloc.usedAmount = round(num(alloc.usedAmount) + take)
        left = receivable.openAmount
      }
    }
  }
  return receivable
}

export function applyCreditNoteToOrder(ctx: Ctx, note: Row, orderId: number) {
  let left = round(note.amount - num(note.usedAmount))
  const targets = getDb().arReceivables.filter((r) => r.orderId === orderId && r.openAmount > 0)
  let offset = 0
  for (const r of targets) {
    if (left <= 0) break
    const take = Math.min(left, r.openAmount)
    applyWriteoff(ctx, note.customerId, 'CREDIT_NOTE', note.id, r, take, `退货冲减 ${note.docNo}`)
    offset += take
    left -= take
  }
  return { offset: round(offset), refundable: round(left) }
}

function hasCategory(bizType: string, bizId: number, category: string) {
  return getDb().attachments.some((a) => a.bizType === bizType && String(a.bizId) === String(bizId) && a.category === category && a.status === 'ACTIVE')
}

export function confirmedAllocated(orderId: number) {
  const receipts = getDb().arReceipts.filter((r) => ['CONFIRMED', 'PARTIAL_WRITTEN_OFF', 'WRITTEN_OFF'].includes(r.status))
  return round(sum(receipts, (r) => sum((r.orders ?? []).filter((a: Row) => a.orderId === orderId), (a: Row) => {
    const used = Math.min(num(a.plannedAmount), num(a.usedAmount))
    const usable = Math.min(Math.max(0, num(a.plannedAmount) - used), Math.max(0, r.amount - num(r.writtenOffAmount)))
    return used + usable
  })))
}

export function cashReady(orderId: number, customerId: number) {
  const receipts = getDb().arReceipts.filter((r) => r.customerId === customerId && ['CONFIRMED', 'PARTIAL_WRITTEN_OFF', 'WRITTEN_OFF'].includes(r.status) && (r.orders ?? []).some((a: Row) => a.orderId === orderId))
  const cash = receipts.some((r) => r.method === 'CASH')
  const proof = hasCategory('SAL_ORDER', orderId, 'PAYMENT_PROOF') || receipts.some((r) => hasCategory('AR_RECEIPT', r.id, 'PAYMENT_PROOF'))
  return cash || proof
}

function receiptOut(r: Row, ctx?: Ctx) {
  const db = getDb()
  const result = {
    ...r, customerName: nameOf(db.customers, r.customerId), storeName: nameOf(db.stores, r.storeId), accountName: nameOf(db.fundAccounts, r.fundAccountId),
    receivedByName: userName(r.receivedBy), confirmedByName: userName(r.confirmedBy),
    openAmount: round(r.amount - num(r.writtenOffAmount)),
    orders: (r.orders ?? []).map((a: Row) => ({ ...a, orderNo: db.salOrders.find((o) => o.id === a.orderId)?.docNo ?? '' })),
  }
  return ctx ? readableBusinessFields(ctx, result) : result
}

function receivableOut(r: Row, ctx?: Ctx) {
  refreshDue(r)
  const db = getDb()
  const result = { ...r, customerName: nameOf(db.customers, r.customerId), orderNo: db.salOrders.find((o) => o.id === r.orderId)?.docNo ?? '' } as Row
  return ctx ? readableBusinessFields(ctx, result, { amountGroup: 'CREDIT' }) : result
}

export const arHandlers = [
  http.get(`${API}/ar/receipts/order-context/:id`, handle((ctx, { params }) => {
    requirePerm(ctx, ['ar:receipt:create', 'ar:receipt:confirm'])
    const order = getDb().salOrders.find(order => order.countryId === ctx.countryId && order.id === Number(params.id))
    if (!order || !canDocumentDataAccess(ctx, 'SAL_ORDER', order)) notFound()
    return { id: order.id, docNo: order.docNo, bookId: order.bookId, customerId: order.customerId, currency: order.currency }
  })),
  http.get(`${API}/ar/receipts`, handle((ctx) => {
    requirePerm(ctx, ['ar:receipt:create', 'ar:receipt:confirm', 'ar:receivable:view'])
    const sp = ctx.url.searchParams
    let rows = getDb().arReceipts.filter((r) => canDocumentDataAccess(ctx, 'AR_RECEIPT', r))
    if (sp.get('status')) rows = rows.filter((r) => r.status === sp.get('status'))
    if (sp.get('method')) rows = rows.filter((r) => r.method === sp.get('method'))
    if (sp.get('customerId')) rows = rows.filter((r) => r.customerId === Number(sp.get('customerId')))
    if (sp.get('bookId')) rows = rows.filter((r) => r.bookId === Number(sp.get('bookId')))
    if (sp.get('orderId')) rows = rows.filter((r) => (r.orders ?? []).some((allocation: Row) => allocation.orderId === Number(sp.get('orderId'))))
    if (sp.get('keyword')) {
      const k = sp.get('keyword')!.toLowerCase()
      rows = rows.filter((r) => r.docNo.toLowerCase().includes(k) || String(r.referenceNo ?? '').toLowerCase().includes(k))
    }
    return paginate(rows.map((r) => receiptOut(r, ctx)), ctx.url)
  })),
  http.post(`${API}/ar/receipts`, handle((ctx, { body }) => receiptOut(createReceipt(ctx, body), ctx))),
  http.post(`${API}/ar/receipts/:id/confirm`, handle((ctx, { params, body }) => receiptOut(confirmReceipt(ctx, Number(params.id), body), ctx))),
  http.post(`${API}/ar/receipts/:id/reject`, handle((ctx, { params, body }) => {
    requirePerm(ctx, 'ar:receipt:confirm')
    const r = requireDocumentAccess(ctx, 'AR_RECEIPT', Number(params.id))
    if (r.status !== 'PENDING_CONFIRM') conflict('只有待确认的收款可以驳回')
    Object.assign(r, { status: 'REJECTED', voidReason: body?.reason ?? '', version: r.version + 1 })
    return receiptOut(r, ctx)
  })),
  http.post(`${API}/ar/receipts/:id/void`, handle((ctx, { params, body }) => {
    requirePerm(ctx, 'ar:receipt:confirm')
    const r = requireDocumentAccess(ctx, 'AR_RECEIPT', Number(params.id))
    if (num(r.writtenOffAmount) > 0) conflict('已核销的收款须先撤销核销')
    if (!['CONFIRMED', 'PENDING_CONFIRM'].includes(r.status)) conflict('当前状态不能作废')
    if (!body?.reason) bad('请填写作废原因')
    Object.assign(r, { status: 'VOIDED', voidReason: body.reason, version: r.version + 1 })
    return receiptOut(r, ctx)
  })),
  http.get(`${API}/ar/credit-rules`, handle((ctx) => {
    requirePerm(ctx, ['ar:credit-rule:view', 'ar:credit-rule:edit'])
    const db = getDb()
    return paginate(db.arCreditRules.filter((r) => r.countryId === ctx.countryId).map((r) => ({
      ...r, targetName: r.targetType === 'CUSTOMER' ? nameOf(db.customers, r.targetId) : nameOf(db.customerGroups, r.targetId),
    })), ctx.url)
  })),
  http.post(`${API}/ar/credit-rules`, handle((ctx, { body }) => {
    requirePerm(ctx, 'ar:credit-rule:edit')
    return saveRule(ctx, null, body)
  })),
  http.put(`${API}/ar/credit-rules/:id`, handle((ctx, { params, body }) => {
    requirePerm(ctx, 'ar:credit-rule:edit')
    const old = findOr404(ctx, 'arCreditRules', Number(params.id))
    old.status = 'RETIRED'
    old.effectiveTo = today(ctx.countryId!)
    return saveRule(ctx, old, body)
  })),
  http.post(`${API}/ar/credit-rules/:id/preview-impact`, handle((ctx, { params }) => {
    requirePerm(ctx, 'ar:credit-rule:edit')
    const rule = findOr404(ctx, 'arCreditRules', Number(params.id))
    const orders = getDb().salOrders.filter((o) => o.countryId === ctx.countryId && o.paymentType === 'CREDIT' && o.approvalStatus === 'APPROVED' && o.fulfillmentStatus !== 'CLOSED' && matchesRule(o.customerId, rule))
    const open = orders.filter((o) => sum(o.lines, (l: Row) => l.qty - l.cancelledQty - l.outboundQty) > 0)
    return { openOrderCount: open.length, orderNos: open.map((o) => o.docNo) }
  })),
  http.get(`${API}/ar/customers/:id/credit`, handle((ctx, { params }) => {
    requirePerm(ctx, ['ar:receivable:view', 'sal:order:view', 'ar:credit-rule:view'])
    requireDataAccess(ctx, findOr404(ctx, 'customers', Number(params.id)))
    return readableBusinessFields(ctx, creditView(ctx.countryId!, Number(params.id)), { amountGroup: 'CREDIT' })
  })),
  http.get(`${API}/ar/customers/:id/balances`, handle((ctx, { params }) => {
    requirePerm(ctx, ['ar:receivable:view', 'sal:order:view'])
    requireDataAccess(ctx, findOr404(ctx, 'customers', Number(params.id)))
    return readableBusinessFields(ctx, balances(ctx.countryId!, Number(params.id), ctx), { amountGroup: 'CREDIT' })
  })),
  http.get(`${API}/ar/customers/:id/timeline`, handle((ctx, { params }) => {
    requirePerm(ctx, ['ar:receivable:view', 'sal:order:view'])
    requireDataAccess(ctx, findOr404(ctx, 'customers', Number(params.id)))
    return timeline(ctx.countryId!, Number(params.id), ctx)
  })),
  http.get(`${API}/ar/receivables`, handle((ctx) => {
    requirePerm(ctx, 'ar:receivable:view')
    const sp = ctx.url.searchParams
    let rows = getDb().arReceivables.filter((r) => canDocumentDataAccess(ctx, 'AR_RECEIVABLE', r)).map((r) => receivableOut(r, ctx))
    if (sp.get('dueStatus')) rows = rows.filter((r) => r.dueStatus === sp.get('dueStatus'))
    if (sp.get('customerId')) rows = rows.filter((r) => r.customerId === Number(sp.get('customerId')))
    if (sp.get('settleStatus')) rows = rows.filter((r) => r.settleStatus === sp.get('settleStatus'))
    return paginate(rows, ctx.url)
  })),
  http.get(`${API}/ar/credit-notes`, handle((ctx) => {
    requirePerm(ctx, ['ar:writeoff:create', 'ar:receivable:view'])
    const sp = ctx.url.searchParams
    return getDb().arCreditNotes.filter((n) => canDocumentDataAccess(ctx, 'AR_CREDIT_NOTE', n) && (!sp.get('customerId') || n.customerId === Number(sp.get('customerId')))).map((n) => ({
      ...n, openAmount: round(n.amount - num(n.usedAmount)), customerName: nameOf(getDb().customers, n.customerId),
    })).map((n) => readableBusinessFields(ctx, n, { amountGroup: 'CREDIT' }))
  })),
  http.post(`${API}/ar/writeoffs`, handle((ctx, { body }) => {
    requirePerm(ctx, 'ar:writeoff:create')
    const key = ctx.request.headers.get('Idempotency-Key')
    const db = getDb()
    if (key && db.idempotency[key]) {
      const prev = db.arWriteoffs.find((w) => w.id === db.idempotency[key])
      if (prev) {
        if (!canDocumentDataAccess(ctx, 'AR_WRITEOFF', prev)) notFound()
        if (prev.customerId !== Number(body.customerId)) bad('幂等键已用于另一客户')
        return readableBusinessFields(ctx, { ...prev, duplicate: true }, { amountGroup: 'CREDIT' })
      }
    }
    const customerId = Number(body?.customerId)
    const lines = body?.lines ?? []
    if (!lines.length) bad('请分配核销金额')
    const created: Row[] = []
    for (const line of lines) {
      const amount = round(num(line.amount))
      if (!(amount > 0)) continue
      const receivable = db.arReceivables.find((r) => r.id === Number(line.receivableId) && r.customerId === customerId)
      if (!receivable) bad('应收不存在')
      if (!canDocumentDataAccess(ctx, 'AR_RECEIVABLE', receivable)) notFound()
      if (amount - receivable.openAmount > 0.001) bad(`核销不能超过未结金额 ${receivable.openAmount}`)
      let receiptAllocation: Row | undefined
      let allocatedAmount = 0
      if (line.fromType === 'RECEIPT') {
        const receipt = db.arReceipts.find((r) => r.id === Number(line.fromId) && r.customerId === customerId)
        if (!receipt || !['CONFIRMED', 'PARTIAL_WRITTEN_OFF'].includes(receipt.status)) bad('只能核销已确认的收款')
        if (!canDocumentDataAccess(ctx, 'AR_RECEIPT', receipt)) notFound()
        if (receipt.currency !== receivable.currency) bad('不同币种不能直接核销')
        const open = round(receipt.amount - num(receipt.writtenOffAmount))
        if (amount - open > 0.001) bad(`超过收款未分配金额 ${open}`)
        const reservedElsewhere = sum((receipt.orders ?? []).filter((a: Row) => a.orderId !== receivable.orderId), (a: Row) => Math.max(0, num(a.plannedAmount) - num(a.usedAmount)))
        if (amount > open - reservedElsewhere + 0.001) bad('收款余额已分配到其他订单，不能挪用核销')
        receiptAllocation = receipt.orders?.find((a: Row) => a.orderId === receivable.orderId)
        allocatedAmount = receiptAllocation ? Math.min(amount, Math.max(0, num(receiptAllocation.plannedAmount) - num(receiptAllocation.usedAmount))) : 0
      } else if (line.fromType === 'CREDIT_NOTE') {
        const note = db.arCreditNotes.find((n) => n.id === Number(line.fromId) && n.customerId === customerId)
        if (!note) bad('贷项不存在')
        if (!canDocumentDataAccess(ctx, 'AR_CREDIT_NOTE', note)) notFound()
        if (note.currency !== receivable.currency) bad('不同币种不能直接核销')
        const open = round(note.amount - num(note.usedAmount))
        if (amount - open > 0.001) bad(`超过贷项可用金额 ${open}`)
      } else bad('核销来源不正确')
      const wo = applyWriteoff(ctx, customerId, line.fromType, Number(line.fromId), receivable, amount, body.reason ?? '手工核销')
      if (wo && receiptAllocation && allocatedAmount > 0) {
        receiptAllocation.usedAmount = round(num(receiptAllocation.usedAmount) + allocatedAmount)
        Object.assign(wo.lines[0], { orderId: receivable.orderId, allocatedAmount })
      }
      if (wo) created.push(wo)
    }
    if (!created.length) bad('没有可核销的金额')
    if (key) db.idempotency[key] = created[0].id
    return readableBusinessFields(ctx, { records: created }, { amountGroup: 'CREDIT' })
  })),
  http.post(`${API}/ar/writeoffs/:id/reverse`, handle((ctx, { params, body }) => {
    requirePerm(ctx, 'ar:writeoff:reverse')
    const wo = requireDocumentAccess(ctx, 'AR_WRITEOFF', Number(params.id))
    if (wo.reversalOfId) conflict('反向记录不能再次撤销，请重新核销')
    if (wo.status === 'REVERSED') return { ...wo, duplicate: true }
    if (wo.status !== 'EFFECTIVE') conflict('该核销不可撤销')
    if (!body?.reason) bad('请填写撤销原因')
    const bizDate = body.bizDate || today(ctx.countryId!)
    assertPeriodOpen(ctx.countryId!, bizDate)
    const line = wo.lines[0]
    const receivable = getDb().arReceivables.find((r) => r.id === line.receivableId)!
    receivable.writtenOffAmount = round(receivable.writtenOffAmount - line.amount)
    receivable.openAmount = round(receivable.amount - receivable.writtenOffAmount)
    receivable.settleStatus = receivable.writtenOffAmount <= 0 ? 'OPEN' : 'PARTIAL'
    for (const occ of getDb().arOccupations.filter((o) => o.refType === 'AR_RECEIVABLE' && o.refId === receivable.id && o.occType === 'AR_OPEN')) {
      occ.releasedAmount = round(Math.max(0, num(occ.releasedAmount) - line.amount))
      occ.status = 'OPEN'
    }
    if (line.fromType === 'RECEIPT') {
      const receipt = getDb().arReceipts.find((r) => r.id === line.fromId)
      if (receipt) {
        receipt.writtenOffAmount = round(num(receipt.writtenOffAmount) - line.amount)
        receipt.status = num(receipt.writtenOffAmount) <= 0 ? 'CONFIRMED' : 'PARTIAL_WRITTEN_OFF'
        const allocated = line.allocatedAmount ?? (String(wo.reason).startsWith('出库自动核销') ? line.amount : 0)
        const allocation = receipt.orders?.find((a: Row) => a.orderId === (line.orderId ?? receivable.orderId))
        if (allocation && allocated > 0) allocation.usedAmount = round(Math.max(0, num(allocation.usedAmount) - allocated))
      }
    } else {
      const note = getDb().arCreditNotes.find((n) => n.id === line.fromId)
      if (note) note.usedAmount = round(num(note.usedAmount) - line.amount)
    }
    wo.status = 'REVERSED'
    const rev: Row = { ...wo, id: nextId(), docNo: docNo(ctx.countryId!, 'WO'), bizDate, status: 'EFFECTIVE', reversalOfId: wo.id, reason: body.reason, createdAt: nowIso() }
    rev.lines = wo.lines.map((l: Row) => ({ ...l, amount: -l.amount }))
    getDb().arWriteoffs.unshift(rev)
    return readableBusinessFields(ctx, rev, { amountGroup: 'CREDIT' })
  })),
  http.get(`${API}/ar/writeoffs`, handle((ctx) => {
    requirePerm(ctx, ['ar:writeoff:create', 'ar:receivable:view'])
    return paginate(getDb().arWriteoffs.filter((w) => canDocumentDataAccess(ctx, 'AR_WRITEOFF', w)).map((w) => readableBusinessFields(ctx, w, { amountGroup: 'CREDIT' })), ctx.url)
  })),
  http.post(`${API}/ar/statements`, handle((ctx, { body }) => {
    requirePerm(ctx, 'ar:statement:view')
    return readableBusinessFields(ctx, buildStatement(ctx, Number(body?.customerId), body?.periodStart, body?.periodEnd), { amountGroup: 'CREDIT' })
  })),
  http.get(`${API}/ar/statements`, handle((ctx) => {
    requirePerm(ctx, 'ar:statement:view')
    const db = getDb()
    return paginate(db.arStatements.filter((s) => canDocumentDataAccess(ctx, 'AR_RECEIVABLE', s)).map((s) => readableBusinessFields(ctx, { ...s, customerName: nameOf(db.customers, s.customerId) }, { amountGroup: 'CREDIT' })), ctx.url)
  })),
  http.get(`${API}/ar/store-receipts`, handle((ctx) => {
    requirePerm(ctx, ['ar:receipt:create', 'sal:order:view'])
    const sp = ctx.url.searchParams
    const date = sp.get('date') || today(ctx.countryId!)
    const storeId = sp.get('storeId') ? Number(sp.get('storeId')) : null
    const rows = getDb().arReceipts.filter((r) => canDocumentDataAccess(ctx, 'AR_RECEIPT', r) && r.bizTime.slice(0, 10) === date && (storeId == null || r.storeId === storeId) && r.status !== 'VOIDED' && r.status !== 'REJECTED')
    return {
      date, cash: round(sum(rows.filter((r) => r.method === 'CASH'), (r) => r.amount)),
      transfer: round(sum(rows.filter((r) => r.method === 'TRANSFER'), (r) => r.amount)),
      pending: round(sum(rows.filter((r) => r.status === 'PENDING_CONFIRM'), (r) => r.amount)),
      records: rows.map((r) => receiptOut(r, ctx)),
    }
  })),
]

function matchesRule(customerId: number, rule: Row) {
  const c = getDb().customers.find((x) => x.id === customerId)
  return (rule.targetType === 'CUSTOMER' && rule.targetId === customerId) || (rule.targetType === 'GROUP' && rule.targetId === c?.groupId)
}

export function createReceipt(ctx: Ctx, body: Row) {
  requireCountry(ctx)
  requirePerm(ctx, 'ar:receipt:create')
  const db = getDb()
  const account = db.fundAccounts.find((a) => a.id === Number(body?.fundAccountId) && a.countryId === ctx.countryId)
  if (!account) bad('请选择收款账户')
  requireDataAccess(ctx, account)
  requireDataAccess(ctx, findOr404(ctx, 'customers', Number(body.customerId)))
  const bizDay = (body.bizTime || nowIso()).slice(0, 10)
  assertPeriodOpen(ctx.countryId!, bizDay)
  if (account.currency !== baseCcy(ctx.countryId!)) bad('销售收款账户币种须与交易币种一致')
  const amount = round(num(body.amount))
  if (!(amount > 0)) bad('金额必须大于 0')
  const method = body.method
  if (!['CASH', 'TRANSFER'].includes(method)) bad('请选择现金或转账')
  const orders = (body.orders ?? []).filter((a: Row) => num(a.plannedAmount) > 0).map((a: Row) => ({ orderId: Number(a.orderId), plannedAmount: round(num(a.plannedAmount)), usedAmount: 0 }))
  if (new Set(orders.map((a: Row) => a.orderId)).size !== orders.length) bad('同一订单只能分配一次收款')
  if (round(sum(orders, (a: Row) => a.plannedAmount)) - amount > 0.001) bad('分配到订单的金额不能超过收款金额')
  for (const a of orders) {
    const o = db.salOrders.find((x) => x.id === a.orderId && x.countryId === ctx.countryId)
    if (!o) bad('订单不存在')
    requireDataAccess(ctx, o)
    if (o.customerId !== Number(body.customerId)) bad('收款客户与订单客户不一致')
  }
  const row: Row = {
    id: nextId(), countryId: ctx.countryId, docNo: docNo(ctx.countryId!, 'RC'), storeId: body.storeId ?? account.storeId ?? null,
    customerId: Number(body.customerId), method, currency: baseCcy(ctx.countryId!), amount, fundAccountId: account.id, payerName: body.payerName ?? '',
    transferDate: body.transferDate ?? null, referenceNo: body.referenceNo ?? '', receivedBy: ctx.user.id, bizTime: body.bizTime || nowIso(),
    status: 'PENDING_CONFIRM', confirmedBy: null, confirmedAt: null, arrivalDate: null, writtenOffAmount: 0, orders, voidReason: '', version: 1, createdAt: nowIso(),
  }
  db.arReceipts.unshift(row)
  if (method === 'TRANSFER') openTodo({ countryId: ctx.countryId!, todoType: 'PENDING_PAYMENT_CONFIRM', dedupKey: `AR_RECEIPT:${row.id}`, perm: 'ar:receipt:confirm', title: `${row.docNo} 转账待确认到账`, link: '/ar/receipts/confirm' })
  audit(ctx, '登记收款', 'ar-receipt', row.id, null, row)
  return row
}

export function confirmReceipt(ctx: Ctx, id: number, body: Row = {}) {
  requirePerm(ctx, 'ar:receipt:confirm')
  const r = requireDocumentAccess(ctx, 'AR_RECEIPT', id)
  const key = ctx.request.headers.get('Idempotency-Key')
  const db = getDb()
  if (key && db.idempotency[key]) {
    const prev = db.arReceipts.find((r) => r.id === db.idempotency[key])
    if (prev && prev.id === r.id) return { ...prev, duplicate: true }
    if (prev) bad('幂等键已用于另一张收款单')
  }
  if (r.status !== 'PENDING_CONFIRM') return { ...r, duplicate: r.status !== 'REJECTED' }
  if (r.method === 'TRANSFER' && !hasCategory('AR_RECEIPT', r.id, 'PAYMENT_PROOF') && !body?.referenceNo && !r.referenceNo) bad('转账确认需要参考号或转账凭证')
  Object.assign(r, { status: 'CONFIRMED', confirmedBy: ctx.user.id, confirmedAt: nowIso(), arrivalDate: body?.arrivalDate || today(ctx.countryId!), referenceNo: body?.referenceNo || r.referenceNo, version: r.version + 1 })
  if (key) db.idempotency[key] = r.id
  audit(ctx, '确认到账', 'ar-receipt', r.id, null, { arrivalDate: r.arrivalDate })
  return r
}

export function saveRule(ctx: Ctx, previous: Row | null, body: Row) {
  if (!body?.targetType || !body.targetId) bad('请选择适用客户或客户组')
  if (!['CASH_ONLY', 'CREDIT_ALLOWED'].includes(body.paymentMode)) bad('请选择付款方式')
  const row: Row = {
    id: nextId(), countryId: ctx.countryId, targetType: body.targetType, targetId: Number(body.targetId), paymentMode: body.paymentMode,
    creditLimit: round(num(body.creditLimit)), currency: baseCcy(ctx.countryId!), termDays: num(body.termDays), dueBasis: body.dueBasis || 'OUTBOUND_DATE',
    dueExtraDays: num(body.dueExtraDays), overduePolicy: body.overduePolicy || 'WARN', graceDays: num(body.graceDays), allowException: !!body.allowException,
    effectiveFrom: body.effectiveFrom || today(ctx.countryId!), effectiveTo: body.effectiveTo || null, versionNo: (previous?.versionNo ?? 0) + 1,
    status: 'ACTIVE', createdBy: ctx.user.id, createdAt: nowIso(),
  }
  getDb().arCreditRules.unshift(row)
  audit(ctx, previous ? '授信规则新版本' : '新增授信规则', 'credit-rule', row.id, previous, row)
  return row
}

export function balances(countryId: number, customerId: number, ctx?: Ctx) {
  const db = getDb()
  const recv = db.arReceivables.filter((r) => r.countryId === countryId && r.customerId === customerId && (!ctx || canDocumentDataAccess(ctx, 'AR_RECEIVABLE', r)))
  const receipts = db.arReceipts.filter((r) => r.countryId === countryId && r.customerId === customerId && (!ctx || canDocumentDataAccess(ctx, 'AR_RECEIPT', r)) && ['CONFIRMED', 'PARTIAL_WRITTEN_OFF', 'WRITTEN_OFF'].includes(r.status))
  const notes = db.arCreditNotes.filter((n) => n.countryId === countryId && n.customerId === customerId && (!ctx || canDocumentDataAccess(ctx, 'AR_CREDIT_NOTE', n)))
  const openAr = round(sum(recv, (r) => r.openAmount))
  const prepaid = round(sum(receipts, (r) => r.amount - num(r.writtenOffAmount)))
  const refundable = round(sum(notes.filter((n) => n.refundableFlag), (n) => n.amount - num(n.usedAmount)))
  return { openAr, prepaid, refundable, ...creditView(countryId, customerId), customerName: nameOf(db.customers, customerId) }
}

export function consumeRefundable(customerId: number, amount: number) {
  let left = round(amount)
  const used: { creditNoteId: number; amount: number }[] = []
  for (const n of getDb().arCreditNotes.filter((x) => x.customerId === customerId && x.refundableFlag)) {
    if (left <= 0) break
    const open = round(n.amount - num(n.usedAmount))
    const take = Math.min(open, left)
    if (take > 0) {
      n.usedAmount = round(num(n.usedAmount) + take)
      used.push({ creditNoteId: n.id, amount: take })
      left = round(left - take)
    }
  }
  if (left > 0.001) conflict(`超过可退款余额，还差 ${left}`, 'RTN_REFUND_EXCEEDED')
  return used
}

function timeline(countryId: number, customerId: number, ctx?: Ctx) {
  const db = getDb()
  const items: Row[] = []
  const visible = (type: string, row: Row) => row.countryId === countryId && (!ctx || canDocumentDataAccess(ctx, type, row))
  for (const o of db.salOrders.filter((x) => x.customerId === customerId && visible('SAL_ORDER', x))) items.push({ at: o.createdAt, type: '销售订单', no: o.docNo, amount: o.totalAmount, id: o.id, link: `/sales/orders/${o.id}` })
  for (const ob of db.salOutbounds.filter((x) => db.salOrders.find((o) => o.id === x.orderId)?.customerId === customerId && visible('SAL_OUTBOUND', x))) items.push({ at: ob.outboundAt || ob.createdAt, type: '出库', no: ob.docNo, amount: sum(ob.lines, (l: Row) => l.amount) })
  for (const r of db.arReceivables.filter((x) => x.customerId === customerId && visible('AR_RECEIVABLE', x))) items.push({ at: r.createdAt, type: '应收', no: r.docNo, amount: r.amount })
  for (const r of db.arReceipts.filter((x) => x.customerId === customerId && visible('AR_RECEIPT', x))) items.push({ at: r.confirmedAt || r.createdAt, type: '收款', no: r.docNo, amount: r.amount, status: r.status })
  for (const w of db.arWriteoffs.filter((x) => x.customerId === customerId && visible('AR_WRITEOFF', x))) items.push({ at: w.createdAt, type: '核销', no: w.docNo, amount: sum(w.lines, (l: Row) => l.amount) })
  for (const n of db.arCreditNotes.filter((x) => x.customerId === customerId && visible('AR_CREDIT_NOTE', x))) items.push({ at: n.createdAt, type: '贷项', no: n.docNo, amount: n.amount })
  for (const f of db.rtnRefunds.filter((x) => x.customerId === customerId && visible('REFUND', x))) items.push({ at: f.paidAt || f.createdAt, type: '退款', no: f.docNo, amount: f.amount, status: f.status })
  return items.sort((a, b) => String(b.at).localeCompare(String(a.at))).map((r) => ctx ? readableBusinessFields(ctx, r, { amountGroup: 'CREDIT' }) : r)
}

function buildStatement(ctx: Ctx, customerId: number, periodStart: string, periodEnd: string) {
  if (!customerId || !periodStart || !periodEnd) bad('请选择客户和期间')
  requireDataAccess(ctx, findOr404(ctx, 'customers', customerId))
  const db = getDb()
  const inPeriod = (d: string) => d >= periodStart && d <= periodEnd
  const recv = db.arReceivables.filter((r) => r.customerId === customerId && canDocumentDataAccess(ctx, 'AR_RECEIVABLE', r))
  const increase = round(sum(recv.filter((r) => inPeriod(r.bizDate)), (r) => r.amount))
  const writeoffs = db.arWriteoffs.filter((w) => canDocumentDataAccess(ctx, 'AR_WRITEOFF', w) && w.customerId === customerId && ['EFFECTIVE', 'REVERSED'].includes(w.status))
  const opening = round(sum(recv.filter((r) => r.bizDate < periodStart), (r) => r.amount) - sum(writeoffs.filter((w) => w.bizDate < periodStart), (w) => sum(w.lines, (l: Row) => l.amount)))
  const decrease = round(sum(writeoffs.filter((w) => inPeriod(w.bizDate)), (w) => sum(w.lines, (l: Row) => l.amount)))
  const closing = round(opening + increase - decrease)
  const detail = [
    ...recv.filter((r) => inPeriod(r.bizDate)).map((r) => ({ type: '应收', no: r.docNo, date: r.bizDate, amount: r.amount })),
    ...writeoffs.filter((w) => inPeriod(w.bizDate)).map((w) => ({ type: w.reversalOfId ? '撤销核销' : '核销', no: w.docNo, date: w.bizDate, amount: -sum(w.lines, (l: Row) => l.amount) })),
  ]
  const row = {
    id: nextId(), countryId: ctx.countryId, customerId, currency: baseCcy(ctx.countryId!), periodStart, periodEnd, opening, increase, decrease, closing,
    detailSnapshot: detail, generatedBy: ctx.user.id, createdAt: nowIso(),
  }
  db.arStatements.unshift(row)
  const sumDetail = round(detail.reduce((s, d) => s + d.amount, 0))
  return { ...row, customerName: nameOf(db.customers, customerId), identityOk: Math.abs(round(opening + sumDetail) - closing) < 0.02 }
}
