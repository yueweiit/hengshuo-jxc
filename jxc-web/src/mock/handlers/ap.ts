/* eslint-disable @typescript-eslint/no-explicit-any */
/**
 * 09 供应商与物流商应付：账单确认形成应付，付款核销，对账单期末等于明细合计（A23）。
 */
import { http } from 'msw'
import { getDb, nextId, nowIso, type Row } from '../db'
import { API, findOr404 } from '../crud'
import { audit, handle, notFound, paginate, requireDataAccess, requirePerm, scopeOf, type Ctx } from '../utils'
import { bad, baseCcy, conflict, docNo, nameOf, num, round, sum, today, userName } from '../services/common'
import { resolveRate } from '../services/cost'
import { assertPeriodOpen } from '../services/period'
import { canDocumentDataAccess, readableBusinessFields, requireDocumentAccess } from '../services/access'

function billOut(b: Row, ctx?: Ctx) {
  const db = getDb()
  const result = { ...b, partnerName: nameOf(db.partners, b.partnerId), openAmount: round(b.amount - num(b.paidAmount)), lines: b.lines }
  return ctx ? readableBusinessFields(ctx, result, { amountGroup: 'COST' }) : result
}

function touchBill(b: Row) {
  b.openAmount = round(b.amount - num(b.paidAmount))
  if (b.status === 'VOIDED' || b.status === 'DRAFT') return
  b.status = b.openAmount <= 0.001 ? 'PAID' : num(b.paidAmount) > 0 ? 'PARTIAL_PAID' : 'CONFIRMED'
}

export function createApCreditNote(ctx: Ctx, n: { partnerId: number; sourceType: string; sourceId: number; currency: string; amount: number; remark?: string }) {
  const exist = getDb().apCreditNotes.find((x) => x.sourceType === n.sourceType && x.sourceId === n.sourceId)
  if (exist) return exist
  const row: Row = {
    id: nextId(), countryId: ctx.countryId, docNo: docNo(ctx.countryId!, 'APC'), partnerId: n.partnerId, sourceType: n.sourceType, sourceId: n.sourceId,
    currency: n.currency, amount: round(n.amount), usedAmount: 0, remark: n.remark ?? '', createdAt: nowIso(),
  }
  getDb().apCreditNotes.unshift(row)
  return row
}

function sourceTaken(sourceType: string, sourceId: number, excludeBillId?: number) {
  return sum(getDb().apBills.filter((b) => b.status !== 'VOIDED' && b.id !== excludeBillId), (b) => sum((b.lines ?? []).filter((l: Row) => l.sourceType === sourceType && l.sourceId === sourceId), (l: Row) => l.sourceType === 'LGS_FEE' ? 1 : l.qty))
}

function rateSnapshot(countryId: number, currency: string, amount: number, date: string) {
  const baseCurrency = baseCcy(countryId)
  const rate = resolveRate(countryId, currency, baseCurrency, date, 'SETTLEMENT')
  if (!rate || !(rate.rate > 0)) bad(`缺少 ${date} 及之前已确认的 ${currency}→${baseCurrency} 结算汇率`, 'AP_RATE_MISSING')
  return { baseCurrency, rateId: rate.id, rate: rate.rate, rateDate: rate.rateDate, baseAmount: round(amount * rate.rate), rateSource: rate.id == null ? 'IDENTITY' : 'CONFIRMED_RATE' }
}

function paymentAccount(ctx: Ctx, id: number, currency: string) {
  const account = findOr404(ctx, 'fundAccounts', id)
  requireDataAccess(ctx, account)
  if (account.status !== 'ENABLED' || account.currency !== currency) bad('付款账户须启用且与付款币种一致')
  return account
}

function statementAccessible(ctx: Ctx, statement: Row) {
  if (statement.countryId !== ctx.countryId) return false
  if (scopeOf(ctx).all) return true
  // 历史快照没有保存来源，无法证明当前授权覆盖其期初与本期金额。
  if (!Array.isArray(statement.sourceRefs) || !statement.sourceRefs.length) return false
  return statement.sourceRefs.every((ref: Row) => {
    const rows = ref.bizType === 'AP_BILL' ? getDb().apBills : ref.bizType === 'AP_SETTLEMENT' ? getDb().apSettlements : []
    const source = rows.find((r) => r.id === Number(ref.id))
    return source != null && canDocumentDataAccess(ctx, ref.bizType, source)
  })
}

function settlementSource(ctx: Ctx, type: string, id: number, partnerId: number) {
  const db = getDb()
  const rows = type === 'PAYMENT' ? db.apPayments : type === 'PREPAYMENT' ? db.apPrepayments : type === 'CREDIT_NOTE' ? db.apCreditNotes : []
  const row = rows.find((r) => r.id === id && r.countryId === ctx.countryId && r.partnerId === partnerId)
  if (!row) bad('核销来源不属于本国同一往来对象')
  const bizType = type === 'PAYMENT' ? 'AP_PAYMENT' : type === 'PREPAYMENT' ? 'AP_PREPAYMENT' : 'AP_CREDIT_NOTE'
  if (!canDocumentDataAccess(ctx, bizType, row)) notFound()
  return { row, currency: String(row.payCurrency ?? row.currency), amount: num(row.payAmount ?? row.amount) }
}

export const apHandlers = [
  http.get(`${API}/ap/bills`, handle((ctx) => {
    requirePerm(ctx, 'ap:bill:view')
    const sp = ctx.url.searchParams
    let rows = getDb().apBills.filter((b) => canDocumentDataAccess(ctx, 'AP_BILL', b))
    if (sp.get('status')) rows = rows.filter((b) => b.status === sp.get('status'))
    if (sp.get('partnerId')) rows = rows.filter((b) => b.partnerId === Number(sp.get('partnerId')))
    if (sp.get('billType')) rows = rows.filter((b) => b.billType === sp.get('billType'))
    if (sp.get('keyword')) rows = rows.filter((b) => b.docNo.toLowerCase().includes(sp.get('keyword')!.toLowerCase()))
    return paginate(rows.map((b) => billOut(b, ctx)), ctx.url)
  })),
  http.get(`${API}/ap/bills/:id`, handle((ctx, { params }) => billOut(requireDocumentAccess(ctx, 'AP_BILL', Number(params.id)), ctx))),
  http.get(`${API}/ap/bill-sources`, handle((ctx) => {
    requirePerm(ctx, 'ap:bill:view')
    const db = getDb()
    const poLines = db.purOrders.filter((o) => canDocumentDataAccess(ctx, 'PURCHASE_ORDER', o) && o.status !== 'DRAFT' && o.status !== 'CANCELLED').flatMap((o) =>
      o.lines.map((l: Row) => ({ sourceType: 'PUR_ORDER_LINE', sourceId: l.id, sourceNo: o.docNo, partnerId: o.supplierId, partnerName: nameOf(db.partners, o.supplierId), currency: o.currency, productId: l.productId, qty: l.qty, unitPrice: l.unitPrice, openQty: l.qty - sourceTaken('PUR_ORDER_LINE', l.id), amount: round(l.qty * l.unitPrice) })))
      .filter((l: Row) => l.openQty > 0)
    const fees = db.lgsFees.filter((f) => f.countryId === ctx.countryId && f.status === 'CONFIRMED' && sourceTaken('LGS_FEE', f.id) === 0 && canDocumentDataAccess(ctx, 'AP_BILL', { countryId: ctx.countryId, lines: [{ sourceType: 'LGS_FEE', sourceId: f.id }] }))
      .map((f) => ({ sourceType: 'LGS_FEE', sourceId: f.id, sourceNo: f.docNo, partnerId: f.carrierId, partnerName: nameOf(db.partners, f.carrierId), currency: f.currency, qty: 1, unitPrice: f.amount, openQty: 1, amount: f.amount, expenseItemId: f.expenseItemId }))
    return readableBusinessFields(ctx, { poLines, fees }, { amountGroup: 'COST' })
  })),
  http.post(`${API}/ap/bills/from-sources`, handle((ctx, { body }) => billOut(createBillFromSources(ctx, body), ctx))),
  http.post(`${API}/ap/bills/:id/confirm`, handle((ctx, { params }) => billOut(confirmApBill(ctx, Number(params.id)), ctx))),
  http.post(`${API}/ap/bills/:id/void`, handle((ctx, { params }) => {
    requirePerm(ctx, 'ap:bill:create')
    const b = requireDocumentAccess(ctx, 'AP_BILL', Number(params.id))
    if (num(b.paidAmount) > 0) conflict('已核销的账单不能作废')
    if (!['DRAFT', 'CONFIRMED'].includes(b.status)) conflict('当前状态不能作废')
    b.status = 'VOIDED'
    return billOut(b, ctx)
  })),
]

export function createBillFromSources(ctx: Ctx, body: Row) {
  requirePerm(ctx, 'ap:bill:create')
  const sources = body?.sources ?? []
    if (!sources.length) bad('请选择来源')
    const db = getDb()
    const used = new Set<string>()
    let partnerId = 0
    let currency = ''
    const bindSource = (partner: number, ccy: string) => {
      if (partnerId && (partner !== partnerId || ccy !== currency)) bad('一张账单只能包含同一往来对象、同一币种')
      partnerId = partner; currency = ccy
    }
    const lines = sources.map((s: Row) => {
      const key = `${s.sourceType}:${s.sourceId}`
      if (used.has(key)) bad('同一来源不能在账单中重复选择')
      used.add(key)
      if (s.sourceType === 'LGS_FEE') {
        if (sourceTaken('LGS_FEE', Number(s.sourceId)) > 0) bad('该物流费用已进入有效账单')
        const fee = db.lgsFees.find((f) => f.id === Number(s.sourceId) && f.countryId === ctx.countryId && f.status === 'CONFIRMED')
        if (!fee) bad('物流费用不存在')
        bindSource(fee.carrierId, fee.currency)
        return { id: nextId(), sourceType: 'LGS_FEE', sourceId: fee.id, sourceNo: fee.docNo, qty: 1, unitPrice: fee.amount, amount: fee.amount, expenseItemId: fee.expenseItemId, productId: null }
      }
      if (s.sourceType !== 'PUR_ORDER_LINE') bad('账单来源类型不支持')
      const po = db.purOrders.find((o) => o.countryId === ctx.countryId && !['DRAFT', 'CANCELLED'].includes(o.status) && o.lines.some((l: Row) => l.id === Number(s.sourceId)))
      const pl = po?.lines.find((l: Row) => l.id === Number(s.sourceId))
      if (!po || !pl) bad('有效采购来源不存在')
      requireDataAccess(ctx, po)
      bindSource(po.supplierId, po.currency)
      const qty = num(s.qty)
      const factor = num(pl.baseQty) / num(pl.qty) || 1
      const open = pl.qty - num(pl.cancelledQty) / factor - sourceTaken('PUR_ORDER_LINE', pl.id)
      if (qty <= 0 || qty > open) bad('开票数量超过剩余可开数量')
      return { id: nextId(), sourceType: 'PUR_ORDER_LINE', sourceId: pl.id, sourceNo: po.docNo, productId: pl.productId, qty, unitPrice: num(pl.unitPrice), amount: round(qty * num(pl.unitPrice)), expenseItemId: null }
    })
    const bill: Row = {
      id: nextId(), countryId: ctx.countryId, docNo: docNo(ctx.countryId!, 'APB'), entityId: db.entities.find((e) => e.countryId === ctx.countryId && e.status === 'ENABLED')?.id ?? null, partnerId, billType: lines.some((l: Row) => l.sourceType === 'LGS_FEE') && lines.every((l: Row) => l.sourceType === 'LGS_FEE') ? 'LOGISTICS' : 'PURCHASE',
      currency, amount: round(sum(lines, (l: Row) => l.amount)), taxAmount: 0, billDate: body.billDate || today(ctx.countryId!), dueDate: body.dueDate || today(ctx.countryId!),
      paidAmount: 0, openAmount: 0, status: 'DRAFT', partnerInvoiceNo: body.partnerInvoiceNo ?? '', lines, version: 1, createdAt: nowIso(),
    }
    bill.openAmount = bill.amount
    if (!canDocumentDataAccess(ctx, 'AP_BILL', bill)) notFound()
    db.apBills.unshift(bill)
    audit(ctx, '生成应付账单', 'ap-bill', bill.id, null, { docNo: bill.docNo })
    return bill
}

export function confirmApBill(ctx: Ctx, id: number) {
  requirePerm(ctx, 'ap:bill:confirm')
  const b = requireDocumentAccess(ctx, 'AP_BILL', id)
  const key = ctx.request.headers.get('Idempotency-Key')
    const db = getDb()
    if (key && db.idempotency[key] === id) return { ...b, duplicate: true }
    if (b.status !== 'DRAFT') return { ...b, duplicate: true }
    assertPeriodOpen(ctx.countryId!, b.billDate)
    Object.assign(b, rateSnapshot(ctx.countryId!, b.currency, b.amount, b.billDate))
    b.status = 'CONFIRMED'
    b.version += 1
    if (key) db.idempotency[key] = b.id
    audit(ctx, '确认应付', 'ap-bill', b.id, null, { amount: b.amount })
    return b
}

const apRest = [
  http.get(`${API}/ap/payments`, handle((ctx) => {
    requirePerm(ctx, ['ap:payment:create', 'ap:bill:view'])
    return paginate(getDb().apPayments.filter((p) => canDocumentDataAccess(ctx, 'AP_PAYMENT', p)).map((p) => readableBusinessFields(ctx, payOut(p), { amountGroup: 'COST' })), ctx.url)
  })),
  http.post(`${API}/ap/payments`, handle((ctx, { body }) => readableBusinessFields(ctx, payOut(savePayment(ctx, body)), { amountGroup: 'COST' }))),
  http.post(`${API}/ap/payments/:id/confirm`, handle((ctx, { params }) => readableBusinessFields(ctx, payOut(confirmApPayment(ctx, Number(params.id))), { amountGroup: 'COST' }))),
  http.get(`${API}/ap/prepayments`, handle((ctx) => {
    requirePerm(ctx, ['ap:prepayment:create', 'ap:bill:view'])
    return paginate(getDb().apPrepayments.filter((p) => canDocumentDataAccess(ctx, 'AP_PREPAYMENT', p)).map((p) => readableBusinessFields(ctx, { ...p, partnerName: nameOf(getDb().partners, p.partnerId), openAmount: round(p.amount - num(p.usedAmount)) }, { amountGroup: 'COST' })), ctx.url)
  })),
  http.post(`${API}/ap/prepayments`, handle((ctx, { body }) => {
    requirePerm(ctx, 'ap:prepayment:create')
    const account = paymentAccount(ctx, Number(body.fundAccountId), body.currency)
    const row: Row = {
      id: nextId(), countryId: ctx.countryId, docNo: docNo(ctx.countryId!, 'APP'), partnerId: Number(body.partnerId), currency: body.currency, amount: round(num(body.amount)),
      usedAmount: 0, poId: body.poId ?? null, fundAccountId: account.id, entityId: account.entityId, storeId: account.storeId, payDate: body.payDate || today(ctx.countryId!), status: 'PENDING_CONFIRM', createdAt: nowIso(),
    }
    if (!(row.amount > 0)) bad('金额必须大于 0')
    getDb().apPrepayments.unshift(row)
    return readableBusinessFields(ctx, row, { amountGroup: 'COST' })
  })),
  http.post(`${API}/ap/prepayments/:id/confirm`, handle((ctx, { params }) => {
    requirePerm(ctx, 'ap:prepayment:create')
    const p = requireDocumentAccess(ctx, 'AP_PREPAYMENT', Number(params.id))
    if (p.status !== 'PENDING_CONFIRM') return readableBusinessFields(ctx, { ...p, duplicate: true }, { amountGroup: 'COST' })
    Object.assign(p, rateSnapshot(ctx.countryId!, p.currency, p.amount, p.payDate || today(ctx.countryId!)))
    p.status = 'CONFIRMED'
    return readableBusinessFields(ctx, p, { amountGroup: 'COST' })
  })),
  http.get(`${API}/ap/settlements`, handle((ctx) => {
    requirePerm(ctx, ['ap:settlement:create', 'ap:bill:view'])
    return paginate(getDb().apSettlements.filter((s) => canDocumentDataAccess(ctx, 'AP_SETTLEMENT', s)).map((s) => readableBusinessFields(ctx, s, { amountGroup: 'COST' })), ctx.url)
  })),
  http.post(`${API}/ap/settlements`, handle((ctx, { body }) => readableBusinessFields(ctx, createApSettlement(ctx, body), { amountGroup: 'COST' }))),
  http.post(`${API}/ap/settlements/:id/reverse`, handle((ctx, { params, body }) => readableBusinessFields(ctx, reverseApSettlement(ctx, Number(params.id), body), { amountGroup: 'COST' }))),
  http.get(`${API}/ap/partners/:id/balances`, handle((ctx, { params }) => {
    requirePerm(ctx, 'ap:bill:view')
    requireDataAccess(ctx, findOr404(ctx, 'partners', Number(params.id)))
    return readableBusinessFields(ctx, partnerBalances(ctx.countryId!, Number(params.id), ctx), { amountGroup: 'COST' })
  })),
  http.get(`${API}/ap/partners/:id/timeline`, handle((ctx, { params }) => {
    requirePerm(ctx, 'ap:bill:view')
    requireDataAccess(ctx, findOr404(ctx, 'partners', Number(params.id)))
    return partnerTimeline(ctx.countryId!, Number(params.id), ctx).map((r) => readableBusinessFields(ctx, r, { amountGroup: 'COST' }))
  })),
  http.post(`${API}/ap/statements`, handle((ctx, { body }) => readableBusinessFields(ctx, buildApStatement(ctx, Number(body.partnerId), body.currency, body.periodStart, body.periodEnd), { amountGroup: 'COST' }))),
  http.get(`${API}/ap/statements`, handle((ctx) => {
    requirePerm(ctx, 'ap:bill:view')
    return paginate(getDb().apStatements.filter((s) => statementAccessible(ctx, s)).map((s) => readableBusinessFields(ctx, { ...s, partnerName: nameOf(getDb().partners, s.partnerId) }, { amountGroup: 'COST' })), ctx.url)
  })),
  http.get(`${API}/ap/payables`, handle((ctx) => {
    requirePerm(ctx, 'ap:bill:view')
    const dueBefore = ctx.url.searchParams.get('dueBefore')
    return getDb().apBills.filter((b) => canDocumentDataAccess(ctx, 'AP_BILL', b) && ['CONFIRMED', 'PARTIAL_PAID'].includes(b.status) && (!dueBefore || b.dueDate <= dueBefore)).map((b) => billOut(b, ctx))
  })),
  http.get(`${API}/ap/credit-notes`, handle((ctx) => {
    requirePerm(ctx, 'ap:bill:view')
    return getDb().apCreditNotes.filter((n) => canDocumentDataAccess(ctx, 'AP_CREDIT_NOTE', n)).map((n) => readableBusinessFields(ctx, { ...n, openAmount: round(n.amount - num(n.usedAmount)), partnerName: nameOf(getDb().partners, n.partnerId) }, { amountGroup: 'COST' }))
  })),
]

apHandlers.push(...apRest)

function consumeFrom(fromType: string, fromId: number, amount: number) {
  const db = getDb()
  if (fromType === 'PAYMENT') {
    const p = db.apPayments.find((x) => x.id === fromId)
    if (!p || p.status === 'PENDING_CONFIRM' || p.status === 'VOIDED') bad('付款尚未确认')
    const open = round(p.payAmount - num(p.settledAmount))
    if (amount - open > 0.001) bad(`超过付款未核销金额 ${open}`)
    p.settledAmount = round(num(p.settledAmount) + amount)
    p.status = p.settledAmount + 0.001 >= p.payAmount ? 'SETTLED' : 'PARTIAL_SETTLED'
  } else if (fromType === 'PREPAYMENT') {
    const p = db.apPrepayments.find((x) => x.id === fromId)
    if (!p || !['CONFIRMED', 'PARTIAL_USED'].includes(p.status)) bad('预付尚未确认')
    const open = round(p.amount - num(p.usedAmount))
    if (amount - open > 0.001) bad(`超过预付余额 ${open}`)
    p.usedAmount = round(num(p.usedAmount) + amount)
    p.status = p.usedAmount + 0.001 >= p.amount ? 'USED' : 'PARTIAL_USED'
  } else if (fromType === 'CREDIT_NOTE') {
    const n = db.apCreditNotes.find((x) => x.id === fromId)
    if (!n) bad('贷项不存在')
    const open = round(n.amount - num(n.usedAmount))
    if (amount - open > 0.001) bad(`超过贷项余额 ${open}`)
    n.usedAmount = round(num(n.usedAmount) + amount)
  } else bad('核销来源不正确')
}

export function confirmApPayment(ctx: Ctx, id: number) {
  requirePerm(ctx, 'ap:payment:confirm')
  const p = requireDocumentAccess(ctx, 'AP_PAYMENT', id)
  if (p.status !== 'PENDING_CONFIRM') return { ...p, duplicate: true }
  assertPeriodOpen(ctx.countryId!, p.payDate)
  Object.assign(p, rateSnapshot(ctx.countryId!, p.payCurrency, p.payAmount, p.payDate))
  Object.assign(p, { status: 'CONFIRMED', confirmedBy: ctx.user.id, confirmedAt: nowIso() })
  return p
}

export function savePayment(ctx: Ctx, body: Row) {
  requirePerm(ctx, 'ap:payment:create')
  const amount = round(num(body?.payAmount))
  if (!(amount > 0)) bad('付款金额必须大于 0')
  if (!body.partnerId || !body.payCurrency || !body.fundAccountId) bad('请填写往来对象、币种和付款账户')
  const account = paymentAccount(ctx, Number(body.fundAccountId), body.payCurrency)
  const row: Row = {
    id: nextId(), countryId: ctx.countryId, docNo: docNo(ctx.countryId!, 'APY'), partnerId: Number(body.partnerId), payCurrency: body.payCurrency, payAmount: amount,
    fundAccountId: account.id, entityId: account.entityId, storeId: account.storeId, payDate: body.payDate || today(ctx.countryId!), referenceNo: body.referenceNo ?? '', status: 'PENDING_CONFIRM',
    settledAmount: 0, confirmedBy: null, confirmedAt: null, createdAt: nowIso(),
  }
  getDb().apPayments.unshift(row)
  return row
}

export function createApSettlement(ctx: Ctx, body: Row) {
  requirePerm(ctx, 'ap:settlement:create')
  const key = ctx.request.headers.get('Idempotency-Key')
  const db = getDb()
  if (key && db.idempotency[key]) {
    const prev = db.apSettlements.find((s) => s.id === db.idempotency[key])
    if (prev) {
      if (!canDocumentDataAccess(ctx, 'AP_SETTLEMENT', prev)) notFound()
      if (prev.partnerId !== Number(body.partnerId)) bad('幂等键已用于另一往来对象')
      return { ...prev, duplicate: true }
    }
  }
  const lines = (body.lines ?? []).filter((l: Row) => num(l.billAmount) > 0)
  if (!lines.length) bad('请分配核销金额')
  const bizDate = body.bizDate || today(ctx.countryId!)
  assertPeriodOpen(ctx.countryId!, bizDate)
  const partnerId = Number(body.partnerId)
  const settled: Row[] = []
  for (const line of lines) {
    const bill = db.apBills.find((b) => b.id === Number(line.billId) && b.countryId === ctx.countryId)
    if (!bill || !['CONFIRMED', 'PARTIAL_PAID'].includes(bill.status)) bad('只能核销已确认的账单')
    if (!canDocumentDataAccess(ctx, 'AP_BILL', bill)) notFound()
    if (bill.partnerId !== partnerId) bad('账单不属于该往来对象')
    const source = settlementSource(ctx, line.fromType, Number(line.fromId), partnerId)
    if (line.fromCurrency && line.fromCurrency !== source.currency) bad('核销币种必须使用来源实际币种')
    const billAmount = round(num(line.billAmount))
    if (billAmount - bill.openAmount > 0.001) bad(`超过账单未付 ${bill.openAmount}`)
    let fromAmount = billAmount
    let rate = 1
    if (source.currency !== bill.currency) {
      rate = num(line.settleRate)
      if (!(rate > 0)) bad('跨币种核销必须填写结算汇率')
      fromAmount = round(billAmount / rate)
    }
    if (bill.baseAmount == null) Object.assign(bill, rateSnapshot(ctx.countryId!, bill.currency, bill.amount, bill.billDate || bizDate))
    if (source.row.baseAmount == null) Object.assign(source.row, rateSnapshot(ctx.countryId!, source.currency, source.amount, source.row.payDate || source.row.createdAt?.slice(0, 10) || bizDate))
    const billBaseAmount = round(billAmount * bill.baseAmount / bill.amount)
    const payBaseAmount = round(fromAmount * source.row.baseAmount / source.amount)
    consumeFrom(line.fromType, Number(line.fromId), fromAmount)
    bill.paidAmount = round(num(bill.paidAmount) + billAmount)
    touchBill(bill)
    const fx = round(payBaseAmount - billBaseAmount)
    settled.push({ fromType: line.fromType, fromId: Number(line.fromId), fromCurrency: source.currency, fromAmount, billId: bill.id, billCurrency: bill.currency, billAmount, settleRate: rate, rateSource: source.currency === bill.currency ? 'IDENTITY' : (line.rateSource || 'ACTUAL'), rateId: source.row.rateId, baseCurrency: bill.baseCurrency, billBaseAmount, payBaseAmount, fxDiff: fx })
  }
  const row = { id: nextId(), countryId: ctx.countryId, docNo: docNo(ctx.countryId!, 'APS'), partnerId, bizDate, status: 'EFFECTIVE', reversalOfId: null, lines: settled, createdAt: nowIso() }
  db.apSettlements.unshift(row)
  if (key) db.idempotency[key] = row.id
  return row
}

function reverseApSettlement(ctx: Ctx, id: number, body: Row) {
  requirePerm(ctx, 'ap:settlement:reverse')
  const db = getDb()
  const original = requireDocumentAccess(ctx, 'AP_SETTLEMENT', id)
  if (original.reversalOfId) conflict('反向记录不能再次撤销，请重新核销')
  if (original.status === 'REVERSED') return { ...original, duplicate: true }
  if (!String(body?.reason ?? '').trim()) bad('请填写撤销原因')
  const bizDate = body.bizDate || today(ctx.countryId!)
  assertPeriodOpen(ctx.countryId!, bizDate)
  for (const line of original.lines) {
    const bill = db.apBills.find((b) => b.id === line.billId && b.countryId === ctx.countryId)
    if (!bill) bad('原账单不存在')
    const { row } = settlementSource(ctx, line.fromType, line.fromId, original.partnerId)
    bill.paidAmount = round(num(bill.paidAmount) - line.billAmount)
    touchBill(bill)
    if (line.fromType === 'PAYMENT') {
      row.settledAmount = round(num(row.settledAmount) - line.fromAmount)
      row.status = row.settledAmount > 0 ? 'PARTIAL_SETTLED' : 'CONFIRMED'
    } else {
      row.usedAmount = round(num(row.usedAmount) - line.fromAmount)
      if (line.fromType === 'PREPAYMENT') row.status = row.usedAmount > 0 ? 'PARTIAL_USED' : 'CONFIRMED'
    }
  }
  original.status = 'REVERSED'
  const reverse: Row = {
    ...original, id: nextId(), docNo: docNo(ctx.countryId!, 'APS'), bizDate, status: 'EFFECTIVE', reversalOfId: original.id,
    reason: body.reason, createdAt: nowIso(), lines: original.lines.map((l: Row) => ({ ...l, fromAmount: -l.fromAmount, billAmount: -l.billAmount, billBaseAmount: -l.billBaseAmount, payBaseAmount: -l.payBaseAmount, fxDiff: -l.fxDiff })),
  }
  db.apSettlements.unshift(reverse)
  audit(ctx, '撤销应付核销', 'ap-settlement', original.id, null, { reversalId: reverse.id, reason: body.reason })
  return reverse
}

function payOut(p: Row) {
  return { ...p, partnerName: nameOf(getDb().partners, p.partnerId), accountName: nameOf(getDb().fundAccounts, p.fundAccountId), confirmedByName: userName(p.confirmedBy), openAmount: round(p.payAmount - num(p.settledAmount)) }
}

function partnerBalances(countryId: number, partnerId: number, ctx?: Ctx) {
  const db = getDb()
  const visible = (type: string, row: Row) => row.countryId === countryId && row.partnerId === partnerId && (!ctx || canDocumentDataAccess(ctx, type, row))
  const bills = db.apBills.filter((r) => visible('AP_BILL', r))
  const payments = db.apPayments.filter((r) => visible('AP_PAYMENT', r))
  const prepayments = db.apPrepayments.filter((r) => visible('AP_PREPAYMENT', r))
  const notes = db.apCreditNotes.filter((r) => visible('AP_CREDIT_NOTE', r))
  const currencies = [...new Set([
    ...bills.map((b) => b.currency), ...payments.map((p) => p.payCurrency), ...prepayments.map((p) => p.currency), ...notes.map((n) => n.currency),
  ])]
  return {
    partnerName: nameOf(db.partners, partnerId),
    byCurrency: currencies.map((currency) => ({
      currency,
      openAp: round(sum(bills.filter((b) => b.currency === currency && b.status !== 'VOIDED' && b.status !== 'DRAFT'), (b) => b.amount - num(b.paidAmount))),
      prepaid: round(sum(prepayments.filter((p) => p.currency === currency && ['CONFIRMED', 'PARTIAL_USED'].includes(p.status)), (p) => p.amount - num(p.usedAmount))),
      paymentOpen: round(sum(payments.filter((p) => p.payCurrency === currency && ['CONFIRMED', 'PARTIAL_SETTLED'].includes(p.status)), (p) => p.payAmount - num(p.settledAmount))),
      creditOpen: round(sum(notes.filter((n) => n.currency === currency), (n) => n.amount - num(n.usedAmount))),
    })),
  }
}

function partnerTimeline(countryId: number, partnerId: number, ctx?: Ctx) {
  const db = getDb()
  const items: Row[] = []
  const visible = (type: string, row: Row) => row.countryId === countryId && row.partnerId === partnerId && (!ctx || canDocumentDataAccess(ctx, type, row))
  for (const b of db.apBills.filter((x) => visible('AP_BILL', x))) items.push({ at: b.createdAt, type: '账单', no: b.docNo, currency: b.currency, amount: b.amount, status: b.status })
  for (const p of db.apPayments.filter((x) => visible('AP_PAYMENT', x))) items.push({ at: p.confirmedAt || p.createdAt, type: '付款', no: p.docNo, currency: p.payCurrency, amount: p.payAmount, status: p.status })
  for (const p of db.apPrepayments.filter((x) => visible('AP_PREPAYMENT', x))) items.push({ at: p.createdAt, type: '预付', no: p.docNo, currency: p.currency, amount: p.amount })
  for (const n of db.apCreditNotes.filter((x) => visible('AP_CREDIT_NOTE', x))) items.push({ at: n.createdAt, type: '贷项', no: n.docNo, currency: n.currency, amount: n.amount })
  for (const s of db.apSettlements.filter((x) => visible('AP_SETTLEMENT', x))) items.push({ at: s.createdAt, type: '核销', no: s.docNo, currency: '', amount: sum(s.lines, (l: Row) => l.billAmount) })
  return items.sort((a, b) => String(b.at).localeCompare(String(a.at)))
}

function buildApStatement(ctx: Ctx, partnerId: number, currency: string, periodStart: string, periodEnd: string) {
  requirePerm(ctx, 'ap:bill:view')
  if (!partnerId || !currency || !periodStart || !periodEnd) bad('请选择往来对象、币种和期间')
  requireDataAccess(ctx, findOr404(ctx, 'partners', partnerId))
  const db = getDb()
  const inPeriod = (d: string) => d >= periodStart && d <= periodEnd
  const bills = db.apBills.filter((b) => canDocumentDataAccess(ctx, 'AP_BILL', b) && b.partnerId === partnerId && b.currency === currency && b.status !== 'VOIDED')
  const settlements = db.apSettlements.filter((s) => canDocumentDataAccess(ctx, 'AP_SETTLEMENT', s) && s.partnerId === partnerId)
  const increase = round(sum(bills.filter((b) => b.status !== 'DRAFT' && inPeriod(b.billDate)), (b) => b.amount))
  const openingBills = round(sum(bills.filter((b) => b.status !== 'DRAFT' && b.billDate < periodStart), (b) => b.amount))
  const paidBefore = round(sum(settlements.filter((s) => s.bizDate < periodStart), (s) => sum(s.lines.filter((l: Row) => l.billCurrency === currency), (l: Row) => l.billAmount)))
  const paid = round(sum(settlements.filter((s) => inPeriod(s.bizDate)), (s) => sum(s.lines.filter((l: Row) => l.billCurrency === currency), (l: Row) => l.billAmount)))
  const opening = round(openingBills - paidBefore)
  const closing = round(opening + increase - paid)
  const detail = [
    ...bills.filter((b) => b.status !== 'DRAFT' && inPeriod(b.billDate)).map((b) => ({ type: '账单', no: b.docNo, date: b.billDate, amount: b.amount })),
    ...settlements.filter((s) => inPeriod(s.bizDate)).flatMap((s) => s.lines.filter((l: Row) => l.billCurrency === currency).map((l: Row) => ({ type: s.reversalOfId ? '撤销核销' : '核销', no: s.docNo, date: s.bizDate, amount: -l.billAmount }))),
  ]
  const detailSum = round(detail.reduce((s, d) => s + d.amount, 0))
  const sourceRefs = [
    ...bills.filter((b) => b.status !== 'DRAFT' && b.billDate <= periodEnd).map((b) => ({ bizType: 'AP_BILL', id: b.id })),
    ...settlements.filter((s) => s.bizDate <= periodEnd && s.lines.some((l: Row) => l.billCurrency === currency)).map((s) => ({ bizType: 'AP_SETTLEMENT', id: s.id })),
  ]
  const row = { id: nextId(), countryId: ctx.countryId, partnerId, currency, periodStart, periodEnd, opening, increase, paid, offset: 0, adjust: 0, closing, detailSnapshot: detail, sourceRefs, createdAt: nowIso() }
  db.apStatements.unshift(row)
  return { ...row, partnerName: nameOf(db.partners, partnerId), identityOk: Math.abs(round(opening + detailSum) - closing) < 0.02 }
}
