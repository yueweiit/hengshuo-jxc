/* eslint-disable @typescript-eslint/no-explicit-any */
/**
 * 12 内部财务：映射生成凭证、记账、冲销、账簿、核对、结账与报表。
 * 同一业务事件只生成一张凭证；已记账凭证不能改，只能冲销。
 */
import { http } from 'msw'
import { getDb, nextId, nowIso, type Row } from '../db'
import { API, findOr404 } from '../crud'
import { audit, handle, paginate, requireCountry, requirePerm, requireDataAccess, canDataAccess, MockError, type Ctx } from '../utils'
import { bad, docNo, nameOf, num, round, sum, today, userName } from '../services/common'
import { activeBook, assertPeriodOpen, periodOf } from '../services/period'
import { outboundCost, lineCost, resolveRate, costAtDate } from '../services/cost'

const WAIVABLE = new Set(['AR_DIFF', 'AP_DIFF', 'INV_DIFF', 'CASH_DIFF'])

function bookOf(countryId: number, ctx?: Ctx) {
  const db = getDb()
  const selectedPeriod = Number(ctx?.url.searchParams.get('periodId'))
  const selectedBook = Number(ctx?.url.searchParams.get('bookId')) || db.finPeriods.find(p => p.id === selectedPeriod)?.bookId
  const candidates = db.books.filter(b => b.countryId === countryId && (!selectedBook || b.id === selectedBook))
  const book = candidates.find(b => (!ctx || canDataAccess(ctx, { ...b, bookId: b.id })) && b.status === 'ACTIVE') ?? candidates.find(b => !ctx || canDataAccess(ctx, { ...b, bookId: b.id }))
  if (!book) bad('当前国家还没有账套')
  if (ctx) requireDataAccess(ctx, { countryId, bookId: book.id, entityId: book.entityId })
  return book
}

function accountByCode(bookId: number, code: string) {
  return getDb().finAccounts.find((a) => a.bookId === bookId && a.code === code && a.status === 'ENABLED')
}

/** Preserve approved source conversion; never revalue a confirmed payment from a changed rate table. */
function businessBase(countryId: number, book: Row, amount: number, currency: string, date: string, row: Row) {
  if (currency === book.baseCurrency) return { amount: round(amount), rate: 1, currency, origAmount: amount, rateMissing: false }
  const sourceAmount = num(row.payAmount ?? row.amount)
  if (row.baseAmount != null && sourceAmount !== 0) return { amount: round(amount * num(row.baseAmount) / sourceAmount), rate: num(row.baseAmount) / sourceAmount, currency, origAmount: amount, rateMissing: false }
  const rate = resolveRate(countryId, currency, book.baseCurrency, date, 'SETTLEMENT')
  return { amount: rate ? round(amount * num(rate.rate)) : 0, rate: rate?.rate ?? null, currency, origAmount: amount, rateMissing: !rate }
}

/** Reconcile retained business documents into the existing event queue, never fabricate mappings. */
export function syncEvents(countryId: number) {
  const db = getDb()
  const book = activeBook(countryId)
  if (!book) return
  const dateOf = (row: Row, ...fields: string[]) => String(fields.map(k => row[k]).find(Boolean) || row.bizDate || row.createdAt || today(countryId)).slice(0, 10)
  const base = (amount: number, currency: string, day: string, row: Row) => businessBase(countryId, book, amount, currency, day, row)
  const push = (eventType: string, sourceType: string, row: Row, day: string, payload: Row) => {
    const dedupKey = `${eventType}:${row.id}`
    const existing = db.finEvents.find(e => e.dedupKey === dedupKey)
    const value = { ...payload, docNo: row.docNo || row.batchNo || String(row.id) }
    // Failed and pending events can be repaired after missing source cost/rate is supplied.
    if (existing) {
      if (existing.status !== 'GENERATED') existing.payload = value
      return
    }
    db.finEvents.push({ id: nextId(), countryId, bookId: book.id, dedupKey, eventType, sourceType, sourceId: row.id, sourceNo: value.docNo, bizDate: day, status: 'PENDING', failReason: '', payload: value })
  }
  const each = (rows: Row[], statuses: string[]) => rows.filter(r => r.countryId === countryId && statuses.includes(r.status))
  for (const ob of each(db.salOutbounds, ['OUTBOUNDED'])) {
    const order = db.salOrders.find(o => o.id === ob.orderId)
    const cost = outboundCost(ob)
    const amountExclTax = round(sum(ob.lines ?? [], (l: Row) => l.amountExclTax != null ? num(l.amountExclTax) : num(l.amount) - num(l.taxAmount)))
    push('SAL_OUTBOUND_CONFIRMED', 'SAL_OUTBOUND', ob, dateOf(ob, 'bizDate'), { amountExclTax, taxAmount: round(sum(ob.lines ?? [], (l: Row) => num(l.taxAmount))), cogsAmount: cost.amount, costMissing: cost.missing, customerId: order?.customerId, productId: (ob.lines ?? []).length === 1 ? ob.lines[0].productId : null, costLines: (ob.lines ?? []).map((l: Row) => ({ productId: l.productId, amount: lineCost(l).amount })) })
  }
  for (const r of each(db.arReceipts, ['CONFIRMED', 'PARTIAL_WRITTEN_OFF', 'WRITTEN_OFF'])) push('AR_RECEIPT_CONFIRMED', 'AR_RECEIPT', r, dateOf(r, 'arrivalDate', 'bizDate', 'bizTime'), { ...base(num(r.amount), r.currency || book.baseCurrency, dateOf(r, 'arrivalDate', 'bizTime'), r), customerId: r.customerId, fundAccountId: r.fundAccountId })
  for (const w of each(db.arWriteoffs, ['EFFECTIVE', 'REVERSED'])) push('AR_WRITEOFF_DONE', 'AR_WRITEOFF', w, dateOf(w, 'bizDate'), { amount: round(sum(w.lines ?? [], (l: Row) => num(l.amount))), customerId: w.customerId, lines: w.lines })
  for (const c of each(db.inboundCosts, ['CONFIRMED', 'ADJUSTED']).filter(c => c.sourceType !== 'RETURN' && !['RETURN', 'OPENING', 'STOCKTAKE_GAIN'].includes(db.invBatches.find(b => b.id === c.batchId)?.sourceType))) push('CST_INBOUND_COST_CONFIRMED', 'CST_INBOUND_COST', c, dateOf(c, 'bizDate'), { amount: round(num(c.confirmedBasePurchaseAmount ?? c.basePurchaseAmount)), productId: c.productId, partnerId: c.supplierId, batchId: c.batchId })
  for (const fee of each(db.lgsFees, ['CONFIRMED', 'ADJUSTED'])) {
    const item = db.expenseItems.find(i => i.id === fee.expenseItemId)
    const allocation = db.feeAllocations.find(a => a.feeId === fee.id && a.status === 'CONFIRMED')
    const day = dateOf(fee, 'bizDate')
    const conversion = base(num(fee.amount), fee.currency || book.baseCurrency, day, fee)
    const deltaMissing = fee.estimateFeeId && fee.deltaBaseAmount == null
    const amount = fee.estimateFeeId ? num(fee.deltaBaseAmount) : fee.baseAmount != null ? num(fee.baseAmount) : conversion.amount
    push('LGS_FEE_CONFIRMED', 'LGS_FEE', fee, day, { ...conversion, amount, rateMissing: !!(conversion.rateMissing || fee.costStatus === 'PENDING_RATE' || deltaMissing), expenseItemId: fee.expenseItemId, partnerId: fee.carrierId, costTreatment: item?.costTreatment, allocationMissing: item?.costTreatment === 'CAPITALIZE' && !allocation })
  }
  for (const p of each(db.apPayments, ['CONFIRMED', 'PARTIAL_SETTLED', 'SETTLED'])) { const day = dateOf(p, 'payDate'); push('AP_PAYMENT_CONFIRMED', 'AP_PAYMENT', p, day, { ...base(num(p.payAmount), p.payCurrency || book.baseCurrency, day, p), partnerId: p.partnerId, fundAccountId: p.fundAccountId }) }
  for (const p of each(db.apPrepayments, ['CONFIRMED', 'PARTIAL_USED', 'USED'])) { const day = dateOf(p, 'bizDate', 'payDate'); push('AP_PREPAYMENT_CONFIRMED', 'AP_PREPAYMENT', p, day, { ...base(num(p.amount), p.currency || book.baseCurrency, day, p), partnerId: p.partnerId, fundAccountId: p.fundAccountId }) }
  for (const a of each(db.apSettlements, ['EFFECTIVE', 'REVERSED'])) push('AP_SETTLEMENT_DONE', 'AP_SETTLEMENT', a, dateOf(a, 'bizDate'), { amount: round(sum(a.lines ?? [], (l: Row) => num(l.billBaseAmount))), billBaseAmount: round(sum(a.lines ?? [], (l: Row) => num(l.billBaseAmount))), payBaseAmount: round(sum(a.lines ?? [], (l: Row) => num(l.payBaseAmount))), rateMissing: (a.lines ?? []).some((l: Row) => l.billBaseAmount == null || l.payBaseAmount == null), partnerId: a.partnerId, lines: a.lines, fxDiff: round(sum(a.lines ?? [], (l: Row) => num(l.fxDiff))) })
  for (const r of each(db.rtnSales, ['PENDING_SETTLE', 'COMPLETED'])) {
    const day = dateOf(r, 'receivedDate', 'bizDate', 'inspectedAt')
    push('RTN_SALES_RECEIVED', 'RTN_SALES', r, day, { amount: round(sum(r.lines ?? [], (l: Row) => num(l.costAmount ?? l.costSnapshot?.amount))), costMissing: (r.lines ?? []).some((l: Row) => l.costMissing || (l.costAmount == null && l.costSnapshot?.amount == null)), customerId: r.customerId })
    if (r.status === 'COMPLETED') push('RTN_SALES_SETTLED', 'RTN_SALES', r, dateOf(r, 'settledDate', 'bizDate'), { amount: num(r.settleAmount), customerId: r.customerId })
  }
  for (const r of each(db.rtnRefunds, ['PAID'])) { const day = dateOf(r, 'bizDate', 'paidAt'); push('RTN_REFUND_PAID', 'RTN_REFUND', r, day, { ...base(num(r.amount), r.currency || book.baseCurrency, day, r), customerId: r.customerId, fundAccountId: r.fundAccountId }) }
  for (const r of each(db.rtnPurchase, ['COMPLETED'])) { const day = dateOf(r, 'bizDate', 'completedAt'); push('RTN_PURCHASE_RETURN_DONE', 'RTN_PURCHASE', r, day, { ...base(sum(r.lines ?? [], (l: Row) => num(l.amount)), r.currency || book.baseCurrency, day, r), partnerId: r.supplierId }) }
  for (const st of each(db.stocktakes, ['POSTED'])) {
    const txns = db.invTxns.filter(t => t.sourceType === 'INV_STOCKTAKE' && t.sourceId === st.id && num(t.onHandChange) !== 0)
    push('INV_STOCKTAKE_POSTED', 'INV_STOCKTAKE', st, dateOf(st, 'bizDate', 'postedAt'), { amount: round(sum(txns, t => num(t.onHandChange) * num(t.unitCost))), costMissing: txns.some(t => t.unitCost == null), warehouseId: st.warehouseId, productId: txns.length === 1 ? txns[0].productId : null })
  }
  for (const a of each(db.costAdjustments, ['CONFIRMED'])) push('CST_COST_ADJUSTED', 'CST_ADJUSTMENT', a, dateOf(a, 'bizDate', 'confirmedAt'), { amount: num(a.amount), productId: a.productId, batchId: a.batchId, target: a.target, partnerId: a.partnerId, counterpart: a.sourceType === 'FEE_ALLOCATION' ? 'INVENTORY' : 'PAYABLE', allocationId: a.sourceType === 'FEE_ALLOCATION' ? a.sourceId : a.allocationId })
  for (const e of each(db.expenses, ['CONFIRMED'])) push('CST_EXPENSE_RECORDED', 'CST_EXPENSE', e, dateOf(e, 'bizDate'), { amount: num(e.baseAmount), expenseItemId: e.expenseItemId, fundAccountId: e.fundAccountId })
}

function resolveAccount(book: Row, rule: Row, payload: Row) {
  if (rule.accountRule?.type === 'FUND') {
    const fund = getDb().fundAccounts.find((f) => f.id === payload.fundAccountId)
    const acc = getDb().finAccounts.find((a) => a.id === fund?.glAccountId && a.bookId === book.id)
    if (!acc) bad('资金账户还没有对应的现金或银行科目', 'FIN_MAPPING_MISSING')
    return acc
  }
  const acc = accountByCode(book.id, rule.accountRule?.code)
  if (!acc) bad(`映射科目 ${rule.accountRule?.code ?? ''} 不存在`, 'FIN_MAPPING_MISSING')
  return acc
}

function eventOut(e: Row) {
  const v = getDb().finVouchers.find((x) => x.sourceEventId === e.id)
  return { ...e, voucherId: v?.id ?? null, voucherNo: v?.voucherNo ?? '', voucherStatus: v?.status ?? '' }
}

export function generateVoucher(ctx: Ctx, eventId: number): Row {
  requirePerm(ctx, 'fin:voucher:generate')
  const db = getDb()
  const event = findOr404(ctx, 'finEvents', eventId)
  try {
    const existing = db.finVouchers.find(v => v.sourceEventId === event.id)
    if (existing) return { ...voucherOut(existing), duplicate: true }
    const book = db.books.find(b => b.id === event.bookId && b.countryId === ctx.countryId) ?? bookOf(ctx.countryId!, ctx)
    requireDataAccess(ctx, { countryId: ctx.countryId, bookId: book.id, entityId: book.entityId })
    assertPeriodOpen(ctx.countryId!, event.bizDate, book.id)
    const period = db.finPeriods.find(p => p.bookId === book.id && p.startDate <= event.bizDate && p.endDate >= event.bizDate)!
    if (event.payload?.costMissing) bad('来源业务缺少已固化的出库成本', 'CST_COST_MISSING')
    if (event.payload?.rateMissing) bad('来源业务缺少已确认的本位币汇率', 'FIN_RATE_MISSING')
    if (event.payload?.allocationMissing) bad('资本化费用尚未确认分摊', 'CST_ALLOCATION_PENDING')
    const tpl = db.finMappings.filter(m => m.bookId === book.id && m.eventType === event.eventType && m.status === 'ACTIVE').sort((a, b) => b.versionNo - a.versionNo)[0]
    if (!tpl) bad('没有已复核的映射模板', 'FIN_MAPPING_MISSING')
    const raw: Row[] = []
    for (const rule of tpl.lines ?? []) {
      const payload = event.payload ?? {}
      if (payload[rule.amountExpr] == null || !Number.isFinite(Number(payload[rule.amountExpr]))) bad(`来源缺少金额字段 ${rule.amountExpr}`, 'FIN_MAPPING_MISSING')
      const amount = round(Number(payload[rule.amountExpr]))
      if (amount === 0) continue
      const acc = resolveAccount(book, rule, payload)
      const parts = (acc.auxTypes ?? []).includes('PRODUCT') && payload.costLines?.length > 1 && rule.amountExpr === 'cogsAmount' ? payload.costLines : [{ amount, productId: payload.productId }]
      for (const part of parts) {
        const lineAmount = round(num(part.amount))
        if (!lineAmount) continue
        const aux = { ...(rule.auxMapping ?? {}) }
        for (const [type, spec] of Object.entries(AUX_FIELDS)) {
          if ((acc.auxTypes ?? []).includes(type) || rule.aux === type) {
            const value = type === 'PRODUCT' ? part.productId : payload[spec.field]
            if (value != null) aux[spec.field] = value
          }
        }
        const cf = rule.cashflowCode ? db.cashflowItems.find(c => c.bookId === book.id && c.code === rule.cashflowCode) : null
        raw.push({ summary: `${rule.summary || ''} ${payload.docNo ?? ''}`.trim(), accountId: acc.id, aux, currency: book.baseCurrency, origAmount: Math.abs(lineAmount), rate: 1, debit: rule.direction === 'DEBIT' ? lineAmount : 0, credit: rule.direction === 'CREDIT' ? lineAmount : 0, cashflowItemId: cf?.id ?? null, sourceDocType: event.sourceType, sourceDocId: event.sourceId })
      }
    }
    const lines = validateLines(book, raw, true)
    const debit = round(sum(lines, l => l.debit)), credit = round(sum(lines, l => l.credit))
    const voucher: Row = { id: nextId(), countryId: ctx.countryId, bookId: book.id, periodId: period.id, voucherNo: docNo(ctx.countryId!, 'V', event.bizDate), voucherDate: event.bizDate, sourceKind: 'AUTO', sourceEventId: event.id, mappingTemplateId: tpl.id, status: 'PENDING_AUDIT', totalDebit: debit, totalCredit: credit, preparedBy: ctx.user.id, auditedBy: null, postedBy: null, reversalOfId: null, reversedById: null, lines, createdAt: nowIso() }
    db.finVouchers.unshift(voucher)
    event.status = 'GENERATED'
    event.failReason = ''
    audit(ctx, '生成凭证', 'voucher', voucher.id, null, { sourceNo: event.sourceNo })
    return voucherOut(voucher)
  } catch (error) {
    const failure = error instanceof MockError ? error : new MockError(400, 'FIN_GENERATE_FAILED', error instanceof Error ? error.message : '凭证生成失败')
    failure.persistFailure = { table: 'finEvents', id: event.id, fields: { status: 'FAILED', failReason: failure.message } }
    event.status = 'FAILED'
    event.failReason = failure.message
    throw failure
  }
}

const AUX_FIELDS: Record<string, { field: string; prefix: string; table: string }> = {
  CUSTOMER: { field: 'customerId', prefix: 'C', table: 'customers' }, PARTNER: { field: 'partnerId', prefix: 'S', table: 'partners' },
  WAREHOUSE: { field: 'warehouseId', prefix: 'W', table: 'warehouses' }, STORE: { field: 'storeId', prefix: 'ST', table: 'stores' },
  PRODUCT: { field: 'productId', prefix: 'P', table: 'products' }, EXPENSE: { field: 'expenseItemId', prefix: 'EX', table: 'expenseItems' },
  FUND: { field: 'fundAccountId', prefix: 'F', table: 'fundAccounts' }, EMPLOYEE: { field: 'employeeId', prefix: 'E', table: 'users' },
}
function auxKey(aux: Row = {}) {
  return Object.values(AUX_FIELDS).filter(s => aux[s.field] != null).map(s => `${s.prefix}:${Number(aux[s.field])}`).sort().join('|')
}
function validateLines(book: Row, raw: Row[], allowNegative = false) {
  const db = getDb()
  const lines = raw.map((line, i) => {
    const acc = db.finAccounts.find(a => a.bookId === book.id && (a.id === Number(line.accountId) || a.code === line.accountCode))
    if (!acc || acc.status !== 'ENABLED') bad('请选择启用的本账套科目', 'FIN_ACCOUNT_INVALID')
    if (!acc.isLeaf) bad(`${acc.code} 不是末级科目`, 'FIN_ACCOUNT_NOT_LEAF')
    const debit = Number(line.debit ?? 0), credit = Number(line.credit ?? 0)
    if (!Number.isFinite(debit) || !Number.isFinite(credit) || (debit !== 0 && credit !== 0) || (!allowNegative && (debit < 0 || credit < 0))) bad('每条分录须填写一个有效的借方或贷方金额', 'FIN_AMOUNT_INVALID')
    const aux: Row = { ...(line.aux ?? {}) }
    if (aux.fundId != null && aux.fundAccountId == null) aux.fundAccountId = aux.fundId
    delete aux.fundId
    for (const type of acc.auxTypes ?? []) {
      const spec = AUX_FIELDS[type]
      if (!spec || !aux[spec.field]) bad(`${acc.code} 缺少必填辅助项 ${type}`, 'FIN_AUX_MISSING')
    }
    for (const spec of Object.values(AUX_FIELDS)) {
      if (aux[spec.field] == null) continue
      const target = (db[spec.table as keyof typeof db] as Row[]).find(r => r.id === Number(aux[spec.field]))
      if (!target || (target.countryId != null && target.countryId !== book.countryId)) bad('辅助项不存在或不属于本账套国家', 'FIN_AUX_INVALID')
    }
    const currency = line.currency || book.baseCurrency
    if (!db.currencies.some(c => c.code === currency)) bad('币种不存在', 'FIN_FX_INVALID')
    const amount = round(debit - credit)
    const foreign = currency !== book.baseCurrency
    const rate = foreign ? Number(line.rate) : 1
    const origAmount = line.origAmount == null && !foreign ? Math.abs(amount) : Number(line.origAmount)
    if ((foreign && !acc.fxEnabled) || !Number.isFinite(rate) || rate <= 0 || !Number.isFinite(origAmount) || Math.abs(round(Math.abs(origAmount) * rate) - Math.abs(amount)) > 0.001) bad('外币分录的原币、汇率与本位币金额不一致', 'FIN_FX_INVALID')
    return { ...line, id: line.id ?? nextId(), seq: i + 1, accountId: acc.id, accountCode: acc.code, accountName: acc.name, aux, auxKey: auxKey(aux), currency, origAmount, rate, debit: round(debit), credit: round(credit), cashflowItemId: line.cashflowItemId ?? null }
  })
  if (!lines.length || !lines.some(l => l.debit || l.credit) || Math.abs(round(sum(lines, l => l.debit)) - round(sum(lines, l => l.credit))) > 0.001) bad('凭证借贷不平或金额为空', 'FIN_UNBALANCED')
  return lines
}

function voucherOut(v: Row) {
  const db = getDb()
  return {
    ...v,
    preparedByName: userName(v.preparedBy), auditedByName: userName(v.auditedBy), postedByName: userName(v.postedBy),
    periodName: periodName(db.finPeriods.find((p) => p.id === v.periodId)),
    lines: (v.lines ?? []).map((l: Row) => ({ ...l, accountName: l.accountName || nameOf(db.finAccounts, l.accountId) })),
  }
}

function periodName(p?: Row) {
  return p ? `${p.fiscalYear}-${String(p.periodNo).padStart(2, '0')}` : ''
}

function currentPeriod(book: Row, countryId: number, periodId?: number) {
  const db = getDb()
  if (periodId) {
    const picked = db.finPeriods.find((p) => p.id === periodId && p.bookId === book.id)
    if (!picked) bad('期间不属于当前账套', 'FIN_PERIOD_INVALID')
    return picked
  }
  const day = today(countryId)
  return db.finPeriods.find((p) => p.bookId === book.id && p.startDate <= day && p.endDate >= day)
    ?? [...db.finPeriods.filter((p) => p.bookId === book.id && p.status === 'OPEN')].sort((a, b) => b.periodNo - a.periodNo)[0]
}

/** Derive the existing balance table from posted vouchers and confirmed openings. */
function rebuildBalances(bookId: number) {
  const db = getDb(), book = db.books.find(b => b.id === bookId)!
  const retained = new Map(db.finBalances.filter(b => b.bookId === bookId).map(b => [`${b.periodId}|${b.accountId}|${b.auxKey}|${b.currency}`, b.id]))
  const keys = new Map<string, Row>()
  const keyOf = (r: Row) => `${r.accountId}|${r.auxKey || auxKey(r.aux)}|${r.currency || book.baseCurrency}`
  const openings = db.finOpenings.filter(o => o.bookId === bookId && o.status === 'CONFIRMED')
  const vouchers = db.finVouchers.filter(v => v.bookId === bookId && ['POSTED', 'REVERSED'].includes(v.status))
  for (const row of [...openings, ...vouchers.flatMap(v => v.lines ?? [])]) {
    const key = keyOf(row)
    keys.set(key, { accountId: row.accountId, aux: row.aux ?? {}, auxKey: row.auxKey || auxKey(row.aux), currency: row.currency || book.baseCurrency })
  }
  const rows: Row[] = []
  for (const period of db.finPeriods.filter(p => p.bookId === bookId).sort((a, b) => a.startDate.localeCompare(b.startDate))) {
    for (const [key, dim] of keys) {
      const initial = openings.filter(o => keyOf(o) === key && (!o.cutoffDate || o.cutoffDate <= period.startDate))
      let opening = sum(initial, o => (o.direction === 'CREDIT' ? -1 : 1) * num(o.baseAmount))
      let origOpening = sum(initial, o => (o.direction === 'CREDIT' ? -1 : 1) * num(o.origAmount ?? o.baseAmount))
      let periodDebit = 0, periodCredit = 0, origMovement = 0
      for (const voucher of vouchers.filter(v => v.voucherDate <= period.endDate)) {
        for (const line of (voucher.lines ?? []).filter((l: Row) => keyOf(l) === key)) {
          const net = num(line.debit) - num(line.credit)
          const orig = (net < 0 ? -1 : 1) * Math.abs(num(line.origAmount ?? net))
          if (voucher.voucherDate < period.startDate) { opening += net; origOpening += orig }
          else { periodDebit += num(line.debit); periodCredit += num(line.credit); origMovement += orig }
        }
      }
      const close = round(opening + periodDebit - periodCredit)
      const identity = `${period.id}|${key}`
      rows.push({ id: retained.get(identity) ?? nextId(), countryId: book.countryId, bookId, periodId: period.id, ...dim, openingDebit: opening > 0 ? round(opening) : 0, openingCredit: opening < 0 ? round(-opening) : 0, periodDebit: round(periodDebit), periodCredit: round(periodCredit), closingDebit: close > 0 ? close : 0, closingCredit: close < 0 ? -close : 0, origClosing: round(origOpening + origMovement) })
    }
  }
  db.finBalances = [...db.finBalances.filter(b => b.bookId !== bookId), ...rows]
}
function ensureBal(bookId: number, periodId: number, accountId: number, _currency: string) {
  rebuildBalances(bookId)
  const rows = getDb().finBalances.filter(b => b.bookId === bookId && b.periodId === periodId && b.accountId === accountId)
  const net = (debit: string, credit: string) => round(sum(rows, b => num(b[debit]) - num(b[credit])))
  const opening = net('openingDebit', 'openingCredit'), closing = net('closingDebit', 'closingCredit')
  return { openingDebit: Math.max(0, opening), openingCredit: Math.max(0, -opening), closingDebit: Math.max(0, closing), closingCredit: Math.max(0, -closing) }
}

export function reviewAndPost(ctx: Ctx, voucherId: number) {
  const v = findOr404(ctx, 'finVouchers', voucherId)
  if (v.preparedBy === ctx.user.id) bad('审核人不能是编制人', 'FIN_AUDITOR_CONFLICT')
  if (v.status === 'PENDING_AUDIT') {
    v.status = 'AUDITED'
    v.auditedBy = ctx.user.id
    v.auditedAt = nowIso()
  }
  return postVoucher(ctx, v)
}

function postVoucher(ctx: Ctx, v: Row) {
  if (v.status === 'POSTED') return { ...voucherOut(v), duplicate: true }
  if (v.status !== 'AUDITED') bad('只有已审核的凭证可以记账')
  if (Math.abs(num(v.totalDebit) - num(v.totalCredit)) > 0.001) bad('借贷不平，不能记账', 'FIN_UNBALANCED')
  const period = getDb().finPeriods.find((p) => p.id === v.periodId)
  if (period?.status === 'CLOSED') bad('期间已结账', 'FIN_PERIOD_CLOSED')
  assertPeriodOpen(v.countryId, v.voucherDate, v.bookId)
  const book = getDb().books.find(b => b.id === v.bookId)!
  v.lines = validateLines(book, v.lines, v.sourceKind !== 'MANUAL')
  v.status = 'POSTED'
  rebuildBalances(v.bookId)
  v.postedBy = ctx.user.id
  v.postedAt = nowIso()
  if (v.reversalOfId) {
    const orig = getDb().finVouchers.find((x) => x.id === v.reversalOfId)
    if (orig) {
      orig.status = 'REVERSED'
      orig.reversedById = v.id
    }
  }
  audit(ctx, '凭证记账', 'voucher', v.id, null, { voucherNo: v.voucherNo })
  return voucherOut(v)
}

function glNet(bookId: number, codes: string[], periodId: number) {
  const db = getDb()
  rebuildBalances(bookId)
  const ids = new Set(db.finAccounts.filter(a => a.bookId === bookId && codes.includes(a.code)).map(a => a.id))
  return round(sum(db.finBalances.filter(b => b.bookId === bookId && b.periodId === periodId && ids.has(b.accountId)), b => num(b.closingDebit) - num(b.closingCredit)))
}

export function reconcile(countryId: number, type: string, periodId?: number) {
  const db = getDb(), book = bookOf(countryId)
  const period = currentPeriod(book, countryId, periodId)
  if (!period) bad('请选择期间', 'FIN_PERIOD_NOT_OPEN')
  if (period.status === 'CLOSED') {
    const saved = db.finSnapshots.filter(s => s.periodId === period.id && s.snapshotType === 'RECONCILE').at(-1)
    const row = saved?.content.find((r: Row) => r.type === type)
    if (row) return { ...structuredClone(row), snapshot: true, snapshotAt: saved!.createdAt }
  }
  syncEvents(countryId)
  const end = period.endDate
  const dateOf = (r: Row, fields: string[]) => String(fields.map(k => r[k]).find(Boolean) || r.bizDate || r.createdAt || today(countryId)).slice(0, 10)
  const details: Row[] = []
  const add = (row: Row, sourceType: string, amount: number, currency = book.baseCurrency, fields = ['bizDate']) => {
    if (row.countryId !== countryId || dateOf(row, fields) > end) return
    const day = dateOf(row, fields)
    const conversion = businessBase(countryId, book, amount, currency || book.baseCurrency, day, row)
    details.push({ sourceType, sourceId: row.id, sourceNo: row.docNo || row.batchNo, bizDate: day, currency: conversion.currency, originalAmount: round(amount), amount: conversion.rateMissing ? null : conversion.amount, missingRate: conversion.rateMissing })
  }
  const confirmedReceipts = db.arReceipts.filter(r => ['CONFIRMED', 'PARTIAL_WRITTEN_OFF', 'WRITTEN_OFF'].includes(r.status))
  const confirmedPayments = db.apPayments.filter(p => ['CONFIRMED', 'PARTIAL_SETTLED', 'SETTLED'].includes(p.status))
  const prepayments = db.apPrepayments.filter(p => ['CONFIRMED', 'PARTIAL_USED', 'USED'].includes(p.status))
  let codes: string[]
  if (type === 'AR') {
    codes = ['1122', '2203']
    for (const r of db.arReceivables) add(r, 'AR_RECEIVABLE', num(r.amount ?? r.openAmount), r.currency)
    for (const r of confirmedReceipts) add(r, 'AR_RECEIPT', -num(r.amount), r.currency, ['arrivalDate', 'bizTime'])
    for (const w of db.arWriteoffs.filter(w => ['EFFECTIVE', 'REVERSED'].includes(w.status))) {
      const credit = sum((w.lines ?? []).filter((l: Row) => l.fromType === 'CREDIT_NOTE'), (l: Row) => num(l.amount))
      if (credit) add(w, 'AR_CREDIT_APPLIED', -credit, book.baseCurrency)
    }
  } else if (type === 'AP') {
    codes = ['2202', '1123']
    for (const b of db.apBills.filter(b => !['DRAFT', 'VOIDED'].includes(b.status))) add(b, 'AP_BILL', num(b.amount), b.currency, ['billDate'])
    for (const p of confirmedPayments) add(p, 'AP_PAYMENT', -num(p.payAmount), p.payCurrency, ['payDate'])
    for (const p of prepayments) add(p, 'AP_PREPAYMENT', -num(p.amount), p.currency, ['bizDate', 'payDate'])
    for (const n of db.apCreditNotes) add(n, 'AP_CREDIT_NOTE', -num(n.amount), n.currency)
  } else if (type === 'INVENTORY') {
    codes = ['1405']
    for (const batch of db.invBatches.filter(b => b.countryId === countryId)) {
      const txns = db.invTxns.filter(t => t.batchId === batch.id && t.countryId === countryId && t.bizDate <= end)
      const qty = sum(txns, t => num(t.onHandChange))
      if (!qty) continue
      const cost = db.inboundCosts.find(c => c.batchId === batch.id)
      const unitCost = cost ? costAtDate(cost, end) : null
      const pending = unitCost == null || cost?.status === 'PENDING_RATE'
      const amount = pending ? 0 : round(qty * num(unitCost))
      details.push({ sourceType: 'INV_BATCH', sourceId: batch.id, sourceNo: batch.batchNo, qty, unitCost, currency: book.baseCurrency, amount: pending ? null : amount, missingCost: pending })
    }
  } else {
    type = 'CASH'; codes = ['1001', '1002']
    for (const r of confirmedReceipts) add(r, 'AR_RECEIPT', num(r.amount), r.currency, ['arrivalDate', 'bizTime'])
    for (const p of confirmedPayments) add(p, 'AP_PAYMENT', -num(p.payAmount), p.payCurrency, ['payDate'])
    for (const p of prepayments) add(p, 'AP_PREPAYMENT', -num(p.amount), p.currency, ['bizDate', 'payDate'])
    for (const r of db.rtnRefunds.filter(r => r.status === 'PAID')) add(r, 'RTN_REFUND', -num(r.amount), r.currency, ['bizDate', 'paidAt'])
  }
  const businessAmount = round(sum(details, d => num(d.amount)))
  const glAmount = round((type === 'AP' ? -1 : 1) * glNet(book.id, codes, period.id))
  const accountIds = new Set(db.finAccounts.filter(a => a.bookId === book.id && codes.includes(a.code)).map(a => a.id))
  const unposted = db.finVouchers.filter(v => v.bookId === book.id && v.voucherDate <= end && !['POSTED', 'REVERSED'].includes(v.status))
  const unpostedAmount = round((type === 'AP' ? -1 : 1) * sum(unposted.flatMap(v => v.lines ?? []).filter((l: Row) => accountIds.has(l.accountId)), (l: Row) => num(l.debit) - num(l.credit)))
  const sourceTypes: Record<string, string[]> = { AR: ['SAL_OUTBOUND_CONFIRMED', 'AR_RECEIPT_CONFIRMED', 'AR_WRITEOFF_DONE', 'RTN_SALES_SETTLED'], AP: ['CST_INBOUND_COST_CONFIRMED', 'LGS_FEE_CONFIRMED', 'AP_PAYMENT_CONFIRMED', 'AP_PREPAYMENT_CONFIRMED', 'AP_SETTLEMENT_DONE', 'RTN_PURCHASE_RETURN_DONE'], INVENTORY: ['CST_INBOUND_COST_CONFIRMED', 'LGS_FEE_CONFIRMED', 'SAL_OUTBOUND_CONFIRMED', 'CST_COST_ADJUSTED', 'INV_STOCKTAKE_POSTED', 'RTN_SALES_RECEIVED', 'RTN_PURCHASE_RETURN_DONE'], CASH: ['AR_RECEIPT_CONFIRMED', 'AP_PAYMENT_CONFIRMED', 'AP_PREPAYMENT_CONFIRMED', 'RTN_REFUND_PAID'] }
  const ungenerated = db.finEvents.filter(e => e.bookId === book.id && e.bizDate <= end && e.status !== 'GENERATED' && sourceTypes[type].includes(e.eventType))
  const ungeneratedAmount = round(sum(ungenerated, e => num(type === 'INVENTORY' && e.eventType === 'SAL_OUTBOUND_CONFIRMED' ? e.payload?.cogsAmount : e.payload?.amount ?? e.payload?.amountExclTax)))
  return { type, periodId: period.id, currency: book.baseCurrency, businessAmount, glAmount, unpostedAmount, ungeneratedAmount, diffAmount: round(businessAmount - glAmount), pendingRateCount: details.filter(d => d.missingRate || d.missingCost).length, details, unposted: unposted.map(v => ({ voucherId: v.id, voucherNo: v.voucherNo, status: v.status })), ungenerated: ungenerated.map(e => ({ eventId: e.id, sourceType: e.sourceType, sourceId: e.sourceId, sourceNo: e.sourceNo, status: e.status, failReason: e.failReason })) }
}

function checkItem(period: Row, code: string, ok: boolean, message: string, detail: unknown = null) {
  const waived = getDb().finCloseChecks.find((c) => c.periodId === period.id && c.checkCode === code && c.result === 'WAIVED')
  return { checkCode: code, result: ok ? 'PASS' : waived ? 'WAIVED' : 'FAIL', message, detail, waiveReason: waived?.waiveReason ?? '' }
}

export function closeCheck(period: Row) {
  const db = getDb()
  const countryId = period.countryId
  syncEvents(countryId)
  const vouchers = db.finVouchers.filter((v) => v.periodId === period.id)
  const events = db.finEvents.filter((e) => e.countryId === countryId && e.bizDate >= period.startDate && e.bizDate <= period.endDate)
  const costs = db.inboundCosts.filter((c) => c.countryId === countryId && c.bizDate >= period.startDate && c.bizDate <= period.endDate && c.status === 'PENDING_RATE')
  const cashLines = vouchers.filter((v) => v.status === 'POSTED').flatMap((v) => v.lines ?? []).filter((l: Row) => {
    const acc = db.finAccounts.find((a) => a.id === l.accountId)
    return acc?.isCash || acc?.isBank
  })
  const ar = reconcile(countryId, 'AR', period.id)
  const ap = reconcile(countryId, 'AP', period.id)
  const inv = reconcile(countryId, 'INVENTORY', period.id)
  const cash = reconcile(countryId, 'CASH', period.id)
  return [
    checkItem(period, 'UNPOSTED', vouchers.every((v) => ['POSTED', 'REVERSED'].includes(v.status)), '本期没有未审核或未记账的凭证', vouchers.filter((v) => !['POSTED', 'REVERSED'].includes(v.status)).map((v) => v.voucherNo)),
    checkItem(period, 'UNBALANCED', vouchers.every((v) => Math.abs(num(v.totalDebit) - num(v.totalCredit)) < 0.01), '没有借贷不平的凭证'),
    checkItem(period, 'EVENTS_OPEN', events.every((e) => e.status === 'GENERATED'), '本期业务事件都已生成凭证', events.filter((e) => e.status !== 'GENERATED').map((e) => e.sourceNo)),
    checkItem(period, 'COST_PENDING', costs.length === 0, '没有待补汇率的入库成本', costs.map((c) => c.batchNo)),
    checkItem(period, 'ALLOCATION_PENDING', !db.feeAllocations.some(a => a.countryId === countryId && a.status === 'DRAFT' && String(a.bizDate || a.createdAt || '').slice(0, 10) <= period.endDate), '没有未确认的费用分摊'),
    checkItem(period, 'STOCKTAKE_PENDING', !db.stocktakes.some(st => st.countryId === countryId && ['COUNTING', 'SUBMITTED', 'APPROVED'].includes(st.status) && String(st.bizDate || st.snapshotAt || st.createdAt || '').slice(0, 10) <= period.endDate), '没有未过账的盘点调整'),
    checkItem(period, 'RECON_DATA_MISSING', [ar, ap, inv, cash].every(r => r.pendingRateCount === 0), '核对数据的成本和汇率完整'),
    checkItem(period, 'AR_DIFF', Math.abs(ar.diffAmount) < 0.05, `应收子账 ${ar.businessAmount}，总账 ${ar.glAmount}`, ar),
    checkItem(period, 'AP_DIFF', Math.abs(ap.diffAmount) < 0.05, `应付子账 ${ap.businessAmount}，总账 ${ap.glAmount}`, ap),
    checkItem(period, 'INV_DIFF', Math.abs(inv.diffAmount) < 0.05, `库存成本 ${inv.businessAmount}，总账 ${inv.glAmount}`, inv),
    checkItem(period, 'CASH_DIFF', Math.abs(cash.diffAmount) < 0.05, `现金银行子账 ${cash.businessAmount}，总账 ${cash.glAmount}`, cash),
    checkItem(period, 'CASHFLOW_MISSING', cashLines.every((l: Row) => l.cashflowItemId), '现金、银行分录都有现金流项目'),
  ]
}

function trialOf(bookId: number, periodId: number) {
  const db = getDb()
  rebuildBalances(bookId)
  const rows: Row[] = db.finAccounts.filter(a => a.bookId === bookId && a.isLeaf).map(a => {
    const balances = db.finBalances.filter(b => b.bookId === bookId && b.periodId === periodId && b.accountId === a.id)
    const total = (field: string) => round(sum(balances, b => num(b[field])))
    const opening = total('openingDebit') - total('openingCredit'), closing = total('closingDebit') - total('closingCredit')
    return { accountId: a.id, code: a.code, name: a.name, category: a.category, openingDebit: Math.max(0, opening), openingCredit: Math.max(0, -opening), periodDebit: total('periodDebit'), periodCredit: total('periodCredit'), closingDebit: Math.max(0, closing), closingCredit: Math.max(0, -closing), balances }
  }).filter(r => r.openingDebit || r.openingCredit || r.periodDebit || r.periodCredit || r.closingDebit || r.closingCredit)
  const debit = round(sum(rows, r => r.closingDebit)), credit = round(sum(rows, r => r.closingCredit))
  return { rows, debit, credit, balanced: Math.abs(debit - credit) < 0.01 }
}

function reportOf(book: Row, period: Row, type: string) {
  const trial = trialOf(book.id, period.id)
  const cat = (name: string) => round(sum(trial.rows.filter((r) => r.category === name), (r) => num(r.closingDebit) - num(r.closingCredit)))
  if (type === 'BALANCE_SHEET') {
    const assets = cat('ASSET')
    const liabilities = -cat('LIABILITY')
    const equity = -cat('EQUITY')
    const retainedProfit = round(-cat('INCOME') - cat('COST') - cat('EXPENSE'))
    const difference = round(assets - liabilities - equity - retainedProfit)
    return { type, lines: [{ code: 'ASSET', name: '资产合计', amount: assets }, { code: 'LIABILITY', name: '负债合计', amount: liabilities }, { code: 'EQUITY', name: '权益科目余额', amount: equity }, { code: 'RETAINED_PROFIT', name: '未结转损益', amount: retainedProfit }], balanced: Math.abs(difference) < 0.01, difference }
  }
  if (type === 'INCOME') {
    const revenue = round(sum(trial.rows.filter((r) => r.category === 'INCOME'), (r) => num(r.periodCredit) - num(r.periodDebit)))
    const cogs = round(sum(trial.rows.filter((r) => r.category === 'COST'), (r) => num(r.periodDebit) - num(r.periodCredit)))
    const expense = round(sum(trial.rows.filter((r) => r.category === 'EXPENSE'), (r) => num(r.periodDebit) - num(r.periodCredit)))
    return { type, lines: [{ name: '营业收入', amount: revenue }, { name: '营业成本', amount: cogs }, { name: '期间费用', amount: expense }, { name: '利润', amount: round(revenue - cogs - expense) }] }
  }
  const db = getDb()
  const lines = db.finVouchers.filter((v) => v.periodId === period.id && ['POSTED', 'REVERSED'].includes(v.status)).flatMap((v) => v.lines ?? []).filter((l: Row) => l.cashflowItemId && db.finAccounts.some(a => a.id === l.accountId && (a.isCash || a.isBank)))
  const grouped = new Map<number, number>()
  for (const l of lines) grouped.set(l.cashflowItemId, round((grouped.get(l.cashflowItemId) ?? 0) + num(l.debit) - num(l.credit)))
  const out = [...grouped.entries()].map(([id, amount]) => ({ name: nameOf(db.cashflowItems, id), amount }))
  return { type: 'CASHFLOW', lines: out.length ? out : [{ name: '本期现金银行没有已记账的现金流项目', amount: 0 }], note: '按现金银行分录汇总，不按销售额代替现金流入' }
}

const books = http.get(`${API}/fin/books`, handle((ctx) => {
  requirePerm(ctx, ['fin:book:config', 'fin:ledger:view', 'fin:report:view', 'fin:period:close', 'fin:period:reopen', 'fin:voucher:create'])
  const countryId = requireCountry(ctx)
  const db = getDb()
  return db.books.filter((b) => b.countryId === countryId && canDataAccess(ctx, { ...b, bookId: b.id })).map((b) => ({
    ...b, periods: db.finPeriods.filter((p) => p.bookId === b.id).map((p) => ({ ...p, name: periodName(p) })),
  }))
}))

const genPeriods = http.post(`${API}/fin/periods`, handle((ctx, { body }) => {
  requirePerm(ctx, 'fin:book:config')
  const book = bookOf(requireCountry(ctx), ctx)
  const year = num(body?.fiscalYear) || Number(today(ctx.countryId!).slice(0, 4))
  const db = getDb()
  let n = 0
  for (let m = 1; m <= 12; m++) {
    if (db.finPeriods.some((p) => p.bookId === book.id && p.fiscalYear === year && p.periodNo === m)) continue
    const start = `${year}-${String(m).padStart(2, '0')}-01`
    const end = new Date(Date.UTC(year, m, 0)).toISOString().slice(0, 10)
    db.finPeriods.push({ id: nextId(), bookId: book.id, countryId: ctx.countryId, fiscalYear: year, periodNo: m, startDate: start, endDate: end, status: 'OPEN' })
    n += 1
  }
  return { created: n }
}))

const accounts = http.get(`${API}/fin/accounts`, handle((ctx) => {
  requirePerm(ctx, ['fin:account:edit', 'fin:ledger:view', 'fin:voucher:create'])
  const book = bookOf(requireCountry(ctx), ctx)
  return paginate(getDb().finAccounts.filter((a) => a.bookId === book.id), ctx.url)
}))

const accountSave = http.post(`${API}/fin/accounts`, handle((ctx, { body }) => {
  requirePerm(ctx, 'fin:account:edit')
  const book = bookOf(requireCountry(ctx), ctx)
  if (!body?.code || !body?.name) bad('请填写科目编码和名称')
  if (getDb().finAccounts.some((a) => a.bookId === book.id && a.code === body.code)) bad('科目编码已存在', 'MD_DUPLICATE')
  const row = {
    id: nextId(), bookId: book.id, countryId: ctx.countryId, code: body.code, name: body.name, parentId: body.parentId ?? null, level: 1,
    category: body.category || 'ASSET', direction: body.direction || 'DEBIT', isLeaf: body.isLeaf !== false, fxEnabled: !!body.fxEnabled,
    isCash: !!body.isCash, isBank: !!body.isBank, auxTypes: body.auxTypes ?? [], status: 'ENABLED',
  }
  getDb().finAccounts.push(row)
  return row
}))

const openings = http.get(`${API}/fin/opening-balances`, handle((ctx) => {
  requirePerm(ctx, 'fin:opening:edit')
  const book = bookOf(requireCountry(ctx), ctx)
  return paginate(getDb().finOpenings.filter((o) => o.bookId === book.id).map((o) => ({ ...o, accountCode: getDb().finAccounts.find((a) => a.id === o.accountId)?.code, accountName: nameOf(getDb().finAccounts, o.accountId) })), ctx.url)
}))

const openingSave = http.post(`${API}/fin/opening-balances`, handle((ctx, { body }) => {
  requirePerm(ctx, 'fin:opening:edit')
  const book = bookOf(requireCountry(ctx), ctx)
  const acc = getDb().finAccounts.find((a) => a.id === Number(body?.accountId) && a.bookId === book.id)
  if (!acc) bad('请选择科目')
  const row = {
    id: nextId(), bookId: book.id, accountId: acc.id, currency: book.baseCurrency, origAmount: num(body.amount), baseAmount: num(body.amount),
    direction: body.direction || acc.direction, status: 'DRAFT', cutoffDate: body.cutoffDate || null,
  }
  getDb().finOpenings.push(row)
  return row
}))

const openingConfirm = http.post(`${API}/fin/opening-balances/confirm`, handle((ctx) => {
  requirePerm(ctx, 'fin:opening:edit')
  const book = bookOf(requireCountry(ctx), ctx)
  const rows = getDb().finOpenings.filter((o) => o.bookId === book.id && o.status !== 'VOID')
  const debit = round(sum(rows.filter((r) => r.direction === 'DEBIT'), (r) => num(r.baseAmount)))
  const credit = round(sum(rows.filter((r) => r.direction === 'CREDIT'), (r) => num(r.baseAmount)))
  if (Math.abs(debit - credit) > 0.01) bad(`期初借贷不平（借 ${debit} 贷 ${credit}）`, 'FIN_UNBALANCED')
  rows.forEach((r) => { r.status = 'CONFIRMED' })
  return { debit, credit, balanced: true }
}))

const mappings = http.get(`${API}/fin/mapping-templates`, handle((ctx) => {
  requirePerm(ctx, ['fin:mapping:edit', 'fin:voucher:generate'])
  const book = bookOf(requireCountry(ctx), ctx)
  return paginate(getDb().finMappings.filter((m) => m.bookId === book.id), ctx.url)
}))

const mappingReview = http.post(`${API}/fin/mapping-templates/:id/review`, handle((ctx, { params }) => {
  requirePerm(ctx, 'fin:mapping:review')
  const m = findOr404(ctx, 'finMappings', Number(params.id))
  m.status = 'ACTIVE'
  m.reviewedBy = ctx.user.id
  m.reviewedAt = nowIso()
  return m
}))

const mappingSimulate = http.post(`${API}/fin/mapping-templates/:id/simulate`, handle((ctx, { params }) => {
  requirePerm(ctx, 'fin:mapping:edit')
  const m = findOr404(ctx, 'finMappings', Number(params.id))
  syncEvents(ctx.countryId!)
  const event = getDb().finEvents.find((e) => e.countryId === ctx.countryId && e.eventType === m.eventType)
  if (!event) return { lines: [], message: '还没有可试算的业务事件' }
  const lines = (m.lines ?? []).map((rule: Row) => ({ ...rule, amount: round(num(event.payload?.[rule.amountExpr])), sourceNo: event.sourceNo }))
  return { lines, sourceNo: event.sourceNo, saved: false }
}))

const events = http.get(`${API}/fin/events`, handle((ctx) => {
  requirePerm(ctx, ['fin:voucher:generate', 'fin:ledger:view'])
  const countryId = requireCountry(ctx)
  syncEvents(countryId)
  const sp = ctx.url.searchParams
  const rows = getDb().finEvents.filter((e) => e.countryId === countryId && canDataAccess(ctx, e) && (!sp.get('status') || e.status === sp.get('status'))).map(eventOut)
  return paginate(rows, ctx.url)
}))

const eventGenerate = http.post(`${API}/fin/events/:id/generate`, handle((ctx, { params }) => generateVoucher(ctx, Number(params.id))))

const voucherList = http.get(`${API}/fin/vouchers`, handle((ctx) => {
  requirePerm(ctx, ['fin:voucher:create', 'fin:ledger:view', 'fin:voucher:audit'])
  const countryId = requireCountry(ctx)
  const sp = ctx.url.searchParams
  const rows = getDb().finVouchers.filter((v) => v.countryId === countryId && canDataAccess(ctx, v) && (!sp.get('status') || v.status === sp.get('status'))).map(voucherOut)
  return paginate(rows, ctx.url)
}))

const voucherGet = http.get(`${API}/fin/vouchers/:id`, handle((ctx, { params }) => {
  requirePerm(ctx, ['fin:voucher:create', 'fin:ledger:view'])
  return voucherOut(findOr404(ctx, 'finVouchers', Number(params.id)))
}))

const voucherCreate = http.post(`${API}/fin/vouchers`, handle((ctx, { body }) => {
  requirePerm(ctx, 'fin:voucher:create')
  const countryId = requireCountry(ctx)
  const book = bookOf(countryId, ctx)
  const day = body?.voucherDate || today(countryId)
  assertPeriodOpen(countryId, day)
  const period = periodOf(countryId, day)!
  const lines = validateLines(book, (body?.lines ?? []).map((l: Row) => ({ ...l, summary: l.summary || body?.summary || '' })))
  const debit = round(sum(lines, (l: Row) => l.debit))
  const credit = round(sum(lines, (l: Row) => l.credit))
  if (!lines.length || Math.abs(debit - credit) > 0.001) bad(`借贷不平（借 ${debit} 贷 ${credit}）`, 'FIN_UNBALANCED')
  const voucher = {
    id: nextId(), countryId, bookId: book.id, periodId: period.id, voucherNo: docNo(countryId, 'V', day), voucherDate: day,
    sourceKind: 'MANUAL', sourceEventId: null, status: 'DRAFT', totalDebit: debit, totalCredit: credit, preparedBy: ctx.user.id,
    auditedBy: null, postedBy: null, reversalOfId: null, reversedById: null, lines, createdAt: nowIso(),
  }
  getDb().finVouchers.unshift(voucher)
  return voucherOut(voucher)
}))

const voucherSubmit = http.post(`${API}/fin/vouchers/:id/submit`, handle((ctx, { params }) => {
  requirePerm(ctx, 'fin:voucher:create')
  const v = findOr404(ctx, 'finVouchers', Number(params.id))
  assertPeriodOpen(v.countryId, v.voucherDate, v.bookId)
  if (v.status !== 'DRAFT') bad('只有草稿可以提交')
  v.status = 'PENDING_AUDIT'
  return voucherOut(v)
}))

const voucherAudit = http.post(`${API}/fin/vouchers/:id/audit`, handle((ctx, { params }) => {
  requirePerm(ctx, 'fin:voucher:audit')
  const v = findOr404(ctx, 'finVouchers', Number(params.id))
  assertPeriodOpen(v.countryId, v.voucherDate, v.bookId)
  if (v.status !== 'PENDING_AUDIT') bad('只有待审核凭证可以审核')
  if (v.preparedBy === ctx.user.id) bad('审核人不能是编制人', 'FIN_AUDITOR_CONFLICT')
  v.status = 'AUDITED'
  v.auditedBy = ctx.user.id
  v.auditedAt = nowIso()
  return voucherOut(v)
}))

const voucherUnaudit = http.post(`${API}/fin/vouchers/:id/unaudit`, handle((ctx, { params, body }) => {
  requirePerm(ctx, 'fin:voucher:unaudit')
  const v = findOr404(ctx, 'finVouchers', Number(params.id))
  assertPeriodOpen(v.countryId, v.voucherDate, v.bookId)
  if (v.status !== 'AUDITED') bad('只有已审核未记账的凭证可以取消审核')
  if (!body?.reason) bad('请填写取消审核的原因')
  v.status = 'PENDING_AUDIT'
  v.unauditReason = body.reason
  return voucherOut(v)
}))

const voucherPost = http.post(`${API}/fin/vouchers/:id/post`, handle((ctx, { params }) => {
  requirePerm(ctx, 'fin:voucher:post')
  return postVoucher(ctx, findOr404(ctx, 'finVouchers', Number(params.id)))
}))

const voucherReverse = http.post(`${API}/fin/vouchers/:id/reverse`, handle((ctx, { params, body }) => {
  requirePerm(ctx, 'fin:voucher:reverse')
  const v = findOr404(ctx, 'finVouchers', Number(params.id))
  const pending = getDb().finVouchers.find(x => x.reversalOfId === v.id)
  if (pending) return { ...voucherOut(pending), duplicate: true }
  if (v.status !== 'POSTED') bad('只有已记账的凭证可以冲销')
  if (v.reversedById) bad('这张凭证已经冲销过')
  const day = body?.voucherDate || today(ctx.countryId!)
  assertPeriodOpen(v.countryId, day, v.bookId)
  const period = periodOf(v.countryId, day, v.bookId)!
  const rev = {
    ...structuredClone(v), id: nextId(), voucherDate: day, periodId: period.id, reason: body?.reason || '', voucherNo: docNo(ctx.countryId!, 'V', day), sourceKind: 'REVERSAL', sourceEventId: null,
    status: 'PENDING_AUDIT', reversalOfId: v.id, reversedById: null, preparedBy: ctx.user.id, auditedBy: null, postedBy: null, createdAt: nowIso(),
    totalDebit: -num(v.totalDebit), totalCredit: -num(v.totalCredit),
    lines: (v.lines ?? []).map((l: Row) => ({ ...l, id: nextId(), debit: -num(l.debit), credit: -num(l.credit), summary: `冲销 ${v.voucherNo} ${l.summary}` })),
  }
  getDb().finVouchers.unshift(rev)
  audit(ctx, '生成冲销凭证', 'voucher', rev.id, null, { reversalOf: v.voucherNo })
  return voucherOut(rev)
}))

const voucherUpdate = http.put(`${API}/fin/vouchers/:id`, handle((ctx, { params, body }) => {
  requirePerm(ctx, 'fin:voucher:edit')
  const v = findOr404(ctx, 'finVouchers', Number(params.id))
  assertPeriodOpen(v.countryId, v.voucherDate, v.bookId)
  if (v.status !== 'DRAFT' || v.sourceKind !== 'MANUAL') bad('只有人工草稿凭证可以修改，已记账凭证须冲销', 'FIN_POSTED_LOCKED')
  const book = getDb().books.find(b => b.id === v.bookId)!
  const day = body?.voucherDate || v.voucherDate
  assertPeriodOpen(v.countryId, day, v.bookId)
  const lines = validateLines(book, body?.lines ?? v.lines)
  Object.assign(v, { voucherDate: day, periodId: periodOf(v.countryId, day, v.bookId)!.id, lines, totalDebit: round(sum(lines, l => l.debit)), totalCredit: round(sum(lines, l => l.credit)), updatedAt: nowIso() })
  audit(ctx, '修改凭证草稿', 'voucher', v.id, null, { voucherNo: v.voucherNo })
  return voucherOut(v)
}))

const ledgerDetail = http.get(`${API}/fin/ledgers/detail`, handle((ctx) => {
  requirePerm(ctx, 'fin:ledger:view')
  const book = bookOf(requireCountry(ctx), ctx)
  const accountId = Number(ctx.url.searchParams.get('accountId'))
  const period = currentPeriod(book, ctx.countryId!, Number(ctx.url.searchParams.get('periodId')) || undefined)
  const periodId = period?.id
  const acc = getDb().finAccounts.find((a) => a.id === accountId && a.bookId === book.id)
  if (!acc) bad('请选择科目')
  const bal = ensureBal(book.id, periodId, acc.id, book.baseCurrency)
  const lines = getDb().finVouchers.filter((v) => v.periodId === periodId && ['POSTED', 'REVERSED'].includes(v.status)).flatMap((v) => (v.lines ?? []).filter((l: Row) => l.accountId === acc.id).map((l: Row) => ({
    voucherId: v.id, voucherNo: v.voucherNo, voucherDate: v.voucherDate, sourceDocType: l.sourceDocType, sourceDocId: l.sourceDocId, summary: l.summary, debit: l.debit, credit: l.credit, aux: l.aux, auxKey: l.auxKey, currency: l.currency,
  })))
  return { account: acc, openingDebit: bal.openingDebit, openingCredit: bal.openingCredit, lines, closingDebit: bal.closingDebit, closingCredit: bal.closingCredit }
}))

const ledgerGeneral = http.get(`${API}/fin/ledgers/general`, handle((ctx) => {
  requirePerm(ctx, 'fin:ledger:view')
  const countryId = requireCountry(ctx)
  const book = bookOf(countryId, ctx)
  const period = currentPeriod(book, countryId, Number(ctx.url.searchParams.get('periodId')) || undefined)
  return trialOf(book.id, period?.id ?? 0)
}))

const ledgerBalance = http.get(`${API}/fin/ledgers/balance`, handle((ctx) => {
  requirePerm(ctx, 'fin:ledger:view')
  const countryId = requireCountry(ctx)
  const book = bookOf(countryId, ctx)
  const period = currentPeriod(book, countryId, Number(ctx.url.searchParams.get('periodId')) || undefined)
  return trialOf(book.id, period?.id ?? 0)
}))

const ledgerJournal = http.get(`${API}/fin/ledgers/journal`, handle((ctx) => {
  requirePerm(ctx, 'fin:ledger:view')
  const book = bookOf(requireCountry(ctx), ctx)
  const period = currentPeriod(book, ctx.countryId!, Number(ctx.url.searchParams.get('periodId')) || undefined)
  const fundAccountId = Number(ctx.url.searchParams.get('fundAccountId')) || null
  const ids = new Set(getDb().finAccounts.filter(a => a.bookId === book.id && (a.isCash || a.isBank)).map(a => a.id))
  const lines = getDb().finVouchers.filter(v => v.bookId === book.id && v.periodId === period?.id && ['POSTED', 'REVERSED'].includes(v.status)).flatMap(v => (v.lines ?? []).filter((l: Row) => ids.has(l.accountId) && (!fundAccountId || l.aux?.fundAccountId === fundAccountId)).map((l: Row) => ({
    voucherId: v.id, voucherNo: v.voucherNo, voucherDate: v.voucherDate, accountCode: l.accountCode, accountName: l.accountName, summary: l.summary, debit: l.debit, credit: l.credit, currency: l.currency, aux: l.aux, cashflowItemId: l.cashflowItemId,
  }))).sort((a, b) => a.voucherDate.localeCompare(b.voucherDate) || a.voucherId - b.voucherId)
  return { periodId: period?.id, lines }
}))

const trial = http.get(`${API}/fin/trial-balance`, handle((ctx) => {
  requirePerm(ctx, 'fin:ledger:view')
  const countryId = requireCountry(ctx)
  const book = bookOf(countryId, ctx)
  const period = currentPeriod(book, countryId, Number(ctx.url.searchParams.get('periodId')) || undefined)
  if (!period) bad('请选择期间')
  const data = trialOf(book.id, period.id)
  return { ...data, periodId: period.id, periodName: periodName(period) }
}))

const recon = http.get(`${API}/fin/reconcile`, handle((ctx) => {
  requirePerm(ctx, 'fin:ledger:view')
  const countryId = requireCountry(ctx)
  bookOf(countryId, ctx)
  const type = ctx.url.searchParams.get('type') || 'AR'
  const periodId = Number(ctx.url.searchParams.get('periodId')) || undefined
  if (type === 'ALL') return ['AR', 'AP', 'INVENTORY', 'CASH'].map((t) => reconcile(countryId, t, periodId))
  return reconcile(countryId, type, periodId)
}))

const closeCheckApi = http.post(`${API}/fin/periods/:id/close-check`, handle((ctx, { params }) => {
  requirePerm(ctx, 'fin:period:close')
  const period = findOr404(ctx, 'finPeriods', Number(params.id))
  const checks = closeCheck(period)
  if (period.status !== 'CLOSED') period.status = checks.some((c) => c.result === 'FAIL') ? 'OPEN' : 'PENDING_CLOSE'
  return { periodId: period.id, status: period.status, checks, canClose: period.status !== 'CLOSED' && checks.every((c) => c.result !== 'FAIL') }
}))

const waive = http.post(`${API}/fin/periods/:id/waive`, handle((ctx, { params, body }) => {
  requirePerm(ctx, 'fin:period:close')
  const period = findOr404(ctx, 'finPeriods', Number(params.id))
  if (period.status === 'CLOSED') bad('期间已结账', 'FIN_PERIOD_CLOSED')
  if (!WAIVABLE.has(body?.checkCode)) bad('未记账凭证、借贷不平、未生成事件不能豁免')
  if (!body?.reason) bad('请填写确认原因')
  getDb().finCloseChecks.push({ id: nextId(), periodId: period.id, checkCode: body.checkCode, result: 'WAIVED', waiveReason: body.reason, waivedBy: ctx.user.id, checkedAt: nowIso() })
  return closeCheck(period)
}))

const close = http.post(`${API}/fin/periods/:id/close`, handle((ctx, { params }) => {
  requirePerm(ctx, 'fin:period:close')
  const period = findOr404(ctx, 'finPeriods', Number(params.id))
  if (period.status === 'CLOSED') return { period, checks: closeCheck(period), duplicate: true }
  if (!['OPEN', 'PENDING_CLOSE'].includes(period.status)) bad('该期间不能结账', 'FIN_PERIOD_NOT_OPEN')
  const checks = closeCheck(period)
  if (checks.some((c) => c.result === 'FAIL')) bad('结账检查未通过', 'FIN_CLOSE_BLOCKED', checks)
  const book = bookOf(period.countryId)
  const report = { balance: reportOf(book, period, 'BALANCE_SHEET'), income: reportOf(book, period, 'INCOME'), cashflow: reportOf(book, period, 'CASHFLOW') }
  rebuildBalances(book.id)
  getDb().finSnapshots.push({ id: nextId(), periodId: period.id, snapshotType: 'BALANCE', content: structuredClone(getDb().finBalances.filter(b => b.periodId === period.id)), createdAt: nowIso() })
  getDb().finSnapshots.push({ id: nextId(), periodId: period.id, snapshotType: 'REPORT', content: report, createdAt: nowIso() })
  getDb().finSnapshots.push({ id: nextId(), periodId: period.id, snapshotType: 'RECONCILE', content: ['AR', 'AP', 'INVENTORY', 'CASH'].map(type => reconcile(period.countryId, type, period.id)), createdAt: nowIso() })
  period.status = 'CLOSED'
  period.closedBy = ctx.user.id
  period.closedAt = nowIso()
  const nextNo = period.periodNo === 12 ? 1 : period.periodNo + 1
  const nextYear = period.periodNo === 12 ? period.fiscalYear + 1 : period.fiscalYear
  const nextPeriod = getDb().finPeriods.find(p => p.bookId === period.bookId && p.fiscalYear === nextYear && p.periodNo === nextNo)
  if (nextPeriod && nextPeriod.status === 'NOT_STARTED') nextPeriod.status = 'OPEN'
  if (!nextPeriod) {
    const start = `${nextYear}-${String(nextNo).padStart(2, '0')}-01`
    const end = new Date(Date.UTC(nextYear, nextNo, 0)).toISOString().slice(0, 10)
    getDb().finPeriods.push({ id: nextId(), bookId: period.bookId, countryId: period.countryId, fiscalYear: nextYear, periodNo: nextNo, startDate: start, endDate: end, status: 'OPEN' })
  }
  audit(ctx, '结账', 'fin-period', period.id, null, { name: periodName(period) })
  return { period, checks }
}))

const reopen = http.post(`${API}/fin/periods/:id/reopen`, handle((ctx, { params, body }) => {
  requirePerm(ctx, 'fin:period:reopen')
  const period = findOr404(ctx, 'finPeriods', Number(params.id))
  if (period.status !== 'CLOSED') bad('只有已结账期间可以反结账')
  if (!body?.reason) bad('请填写反结账原因')
  const later = getDb().finPeriods.find((p) => p.bookId === period.bookId && p.status === 'CLOSED' && (p.fiscalYear > period.fiscalYear || (p.fiscalYear === period.fiscalYear && p.periodNo > period.periodNo)))
  if (later) bad(`后续期间 ${periodName(later)} 仍已结账，不能反结账`, 'FIN_LATER_CLOSED')
  const dependencies = getDb().finPeriods.filter(p => p.bookId === period.bookId && p.startDate > period.endDate).map(p => ({ periodId: p.id, periodName: periodName(p), voucherIds: getDb().finVouchers.filter(v => v.periodId === p.id && ['POSTED', 'REVERSED'].includes(v.status)).map(v => v.id) })).filter(p => p.voucherIds.length)
  const before = getDb().finSnapshots.filter(s => s.periodId === period.id && s.snapshotType === 'BALANCE').at(-1)
  period.status = 'OPEN'
  getDb().finCloseChecks = getDb().finCloseChecks.filter(c => c.periodId !== period.id)
  rebuildBalances(period.bookId)
  const after = { id: nextId(), periodId: period.id, snapshotType: 'REOPEN_BALANCE', content: structuredClone(getDb().finBalances.filter(b => b.periodId === period.id)), createdAt: nowIso() }
  getDb().finSnapshots.push(after)
  getDb().finReopenLogs.push({ id: nextId(), periodId: period.id, reason: body.reason, dependencies, beforeSnapshotId: before?.id ?? null, afterSnapshotId: after.id, operatorId: ctx.user.id, operatedAt: nowIso() })
  audit(ctx, '反结账', 'fin-period', period.id, null, { reason: body.reason })
  return period
}))

const reports = http.get(`${API}/fin/reports/:type`, handle((ctx, { params }) => {
  requirePerm(ctx, 'fin:report:view')
  const countryId = requireCountry(ctx)
  const book = bookOf(countryId, ctx)
  const period = currentPeriod(book, countryId, Number(ctx.url.searchParams.get('periodId')) || undefined)
  if (!period) bad('请选择期间')
  return { ...reportOf(book, period, String(params.type).toUpperCase()), periodName: periodName(period), currency: book.baseCurrency }
}))

export const finHandlers = [
  books, genPeriods, accounts, accountSave, openings, openingSave, openingConfirm, mappings, mappingReview, mappingSimulate,
  events, eventGenerate, voucherList, voucherGet, voucherCreate, voucherSubmit, voucherAudit, voucherUnaudit, voucherPost, voucherReverse, voucherUpdate,
  ledgerDetail, ledgerGeneral, ledgerBalance, ledgerJournal, trial, recon, closeCheckApi, waive, close, reopen, reports,
]
