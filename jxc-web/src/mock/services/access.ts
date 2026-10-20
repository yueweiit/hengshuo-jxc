import { getDb, type Db, type Row } from '../db'
import { canDataAccess, notFound, requireDataAccess, requirePerm, scopeOf, userFieldGroups, type Ctx } from '../utils'

/** 序列化时裁剪字段，业务域可声明本模块金额对应的字段组。 */
export function readableBusinessFields(ctx: Ctx, source: Row, options: { amountGroup?: string } = {}): Row {
  const row = structuredClone(source)
  const fields = userFieldGroups(ctx.user, ctx.countryId)
  const amountGroup = options.amountGroup ?? 'ORDER_TOTAL'
  function clean(value: Row) {
    for (const key of Object.keys(value)) {
      if (fields.COST === 'HIDDEN' && /^(unitCost|cost|cogs|grossProfit|margin)/i.test(key)) delete value[key]
      if (fields.PROFIT === 'HIDDEN' && /profit/i.test(key)) delete value[key]
      if (fields[amountGroup] === 'HIDDEN' && /^(.*Amount|amount|price|unitPrice|stdPrice|manualPriceFlag|priceSource|priceRefId|priceVersionNo|rate|settleRate|fxDiff|balance|opening|increase|paid|offset|adjust|closing)$/i.test(key)) delete value[key]
      if (fields.CUSTOMER_PRICE === 'HIDDEN' && /^(customerPrice|levelPrice|stdPrice|priceSource|priceRefId|priceVersionNo)$/i.test(key)) delete value[key]
      if (fields.BANK_INFO === 'HIDDEN' && /^(bank.*|account|accountName|accountNo|accountNoMasked|fundAccountName|swiftCode|iban|payeeAccount.*|payerAccount.*)$/i.test(key)) delete value[key]
      if (fields.CREDIT === 'HIDDEN' && /^(creditLimit|creditAmount|overdueAmount|openAr|prepaid|refundable|availableCredit|occupiedCredit|used|limit|available)$/i.test(key)) delete value[key]
      const child = value[key]
      if (Array.isArray(child)) child.forEach((x) => { if (x && typeof x === 'object') clean(x) })
      else if (child && typeof child === 'object') clean(child)
    }
  }
  clean(row)
  return row
}

/** 订单归属门店可看整单；仅履约仓授权只能看本仓分配的行与数量。 */
export function readableSalesOrder(ctx: Ctx, source: Row): Row {
  requireDataAccess(ctx, source)
  const row = structuredClone(source)
  const scope = scopeOf(ctx)
  const full = scope.all || scope.stores.includes(row.storeId) || scope.entities.includes(row.entityId) || scope.books.includes(row.bookId)
  if (!full) {
    row.lines = (row.lines ?? []).flatMap((line: Row) => {
      const allocs = (line.allocs ?? []).filter((a: Row) => scope.warehouses.includes(a.warehouseId))
      if (!allocs.length) return []
      const sum = (key: string) => allocs.reduce((n: number, a: Row) => n + Number(a[key] ?? 0), 0)
      const factor = Number(line.factor) || (Number(line.qty) ? Number(line.baseQty) / Number(line.qty) : 1) || 1
      const baseQty = sum('allocQty')
      return [{ ...line, allocs, baseQty, qty: baseQty / factor, cancelledQty: sum('cancelledQty'), outboundQty: sum('outboundQty'),
        signedQty: sum('signedQty'), openQty: baseQty - sum('cancelledQty') - sum('outboundQty') }]
    })
    row.totalQty = row.lines.reduce((n: number, l: Row) => n + l.baseQty, 0)
    row.openQty = row.lines.reduce((n: number, l: Row) => n + l.openQty, 0)
    // 全单金额与付款状态也会泄露其他仓的履约金额。
    for (const key of ['totalAmount', 'paidAmount', 'unpaidAmount', 'paymentStatus', 'discountAmount']) delete row[key]
    row.partialScope = true
  }
  return readableBusinessFields(ctx, row)
}

type DocumentRule = { table: keyof Db; read: string[]; write: string[] }
const DOCS: Record<string, DocumentRule> = {
  SAL_ORDER: { table: 'salOrders', read: ['sal:order:view', 'sal:outbound:create', 'sal:outbound:confirm'], write: ['sal:order:create', 'sal:order:edit'] },
  SALES_ORDER: { table: 'salOrders', read: ['sal:order:view', 'sal:outbound:create', 'sal:outbound:confirm'], write: ['sal:order:create', 'sal:order:edit'] },
  SALES_OUTBOUND: { table: 'salOutbounds', read: ['sal:outbound:create', 'sal:outbound:confirm', 'sal:order:view'], write: ['sal:outbound:create', 'sal:outbound:confirm'] },
  SAL_OUTBOUND: { table: 'salOutbounds', read: ['sal:outbound:create', 'sal:outbound:confirm', 'sal:order:view'], write: ['sal:outbound:create', 'sal:outbound:confirm'] },
  PURCHASE_ORDER: { table: 'purOrders', read: ['pur:order:view'], write: ['pur:order:create', 'pur:order:edit'] },
  DOMESTIC_RECEIPT: { table: 'domesticReceipts', read: ['pur:receipt:create', 'pur:receipt:confirm', 'pur:order:view'], write: ['pur:receipt:create', 'pur:receipt:confirm'] },
  EXPORT_NODE: { table: 'exportNodes', read: ['pur:export:create', 'pur:export:confirm', 'pur:order:view'], write: ['pur:export:create', 'pur:export:confirm'] },
  SHIPMENT: { table: 'shipments', read: ['lgs:shipment:view'], write: ['lgs:shipment:create', 'lgs:shipment:edit'] },
  LGS_FEE: { table: 'lgsFees', read: ['lgs:fee:create', 'lgs:fee:confirm', 'lgs:shipment:view'], write: ['lgs:fee:create', 'lgs:fee:confirm'] },
  HOLD: { table: 'holds', read: ['lgs:hold:create', 'lgs:hold:release', 'lgs:shipment:view'], write: ['lgs:hold:create', 'lgs:hold:release'] },
  DELIVERY: { table: 'deliveries', read: ['lgs:delivery:create', 'lgs:receipt:confirm', 'lgs:shipment:view'], write: ['lgs:delivery:create', 'lgs:delivery:dispatch'] },
  DISCREPANCY: { table: 'discrepancies', read: ['lgs:discrepancy:handle', 'lgs:shipment:view'], write: ['lgs:discrepancy:handle'] },
  COST_ALLOCATION: { table: 'feeAllocations', read: ['cst:allocation:create', 'cst:cost:view'], write: ['cst:allocation:create'] },
  LGS_RECEIPT: { table: 'lgsReceipts', read: ['lgs:receipt:confirm', 'lgs:shipment:view'], write: ['lgs:receipt:confirm'] },
  TRANSFER: { table: 'transfers', read: ['inv:transfer:create', 'inv:transfer:ship', 'inv:transfer:receive', 'inv:stock:view'], write: ['inv:transfer:create', 'inv:transfer:ship', 'inv:transfer:receive'] },
  STOCKTAKE: { table: 'stocktakes', read: ['inv:stocktake:create', 'inv:stocktake:count', 'inv:stocktake:approve', 'inv:stock:view'], write: ['inv:stocktake:create', 'inv:stocktake:count'] },
  AR_RECEIPT: { table: 'arReceipts', read: ['ar:receipt:create', 'ar:receipt:confirm'], write: ['ar:receipt:create', 'ar:receipt:confirm'] },
  AR_RECEIVABLE: { table: 'arReceivables', read: ['ar:receivable:view'], write: ['ar:writeoff:create'] },
  AR_WRITEOFF: { table: 'arWriteoffs', read: ['ar:receivable:view', 'ar:writeoff:create'], write: ['ar:writeoff:create'] },
  AR_CREDIT_NOTE: { table: 'arCreditNotes', read: ['ar:receivable:view', 'rtn:sales:settle'], write: ['rtn:sales:settle'] },
  AP_BILL: { table: 'apBills', read: ['ap:bill:view', 'ap:bill:create'], write: ['ap:bill:create', 'ap:bill:confirm'] },
  AP_PAYMENT: { table: 'apPayments', read: ['ap:payment:create', 'ap:payment:confirm', 'ap:bill:view'], write: ['ap:payment:create', 'ap:payment:confirm'] },
  AP_PREPAYMENT: { table: 'apPrepayments', read: ['ap:prepayment:create', 'ap:bill:view'], write: ['ap:prepayment:create'] },
  AP_SETTLEMENT: { table: 'apSettlements', read: ['ap:settlement:create', 'ap:bill:view'], write: ['ap:settlement:create'] },
  AP_CREDIT_NOTE: { table: 'apCreditNotes', read: ['ap:bill:view', 'ap:settlement:create'], write: ['ap:settlement:create'] },
  SALES_RETURN: { table: 'rtnSales', read: ['rtn:sales:create', 'rtn:sales:receive', 'rtn:sales:inspect', 'rtn:sales:settle'], write: ['rtn:sales:create', 'rtn:sales:receive', 'rtn:sales:inspect'] },
  PURCHASE_RETURN: { table: 'rtnPurchase', read: ['rtn:purchase:create', 'rtn:purchase:ship'], write: ['rtn:purchase:create', 'rtn:purchase:ship'] },
  REFUND: { table: 'rtnRefunds', read: ['rtn:refund:create', 'rtn:refund:pay'], write: ['rtn:refund:create', 'rtn:refund:pay'] },
  CLAIM: { table: 'rtnClaims', read: ['rtn:claim:create'], write: ['rtn:claim:create'] },
  DISCREPANCY_WRITE_OFF: { table: 'discrepancies', read: ['lgs:discrepancy:handle', 'lgs:shipment:view'], write: ['lgs:discrepancy:handle'] },
  FIN_VOUCHER: { table: 'finVouchers', read: ['fin:voucher:view'], write: ['fin:voucher:create'] },
}

/** 同一来源链用于财务业务列表/详情和附件；无归属的金融记录只向本国全部范围开放。 */
export function canDocumentDataAccess(ctx: Ctx, bizType: string, row: Row): boolean {
  const db = getDb()
  if (ctx.countryId == null || row.countryId !== ctx.countryId) return false
  if (scopeOf(ctx).all) return true
  const find = (table: keyof Db, id: unknown) => (db[table] as Row[]).find((r) => r.id === Number(id) && r.countryId === ctx.countryId)
  const access = (type: string, source: Row | undefined) => !!source && canDocumentDataAccess(ctx, type, source)
  const own = (source = row, fields = { storeField: 'storeId', warehouseField: 'warehouseId', entityField: 'entityId', bookField: 'bookId' }) =>
    Object.values(fields).some((field) => source[field] != null) && canDataAccess(ctx, source, fields)
  const hasOwn = ['storeId', 'warehouseId', 'entityId', 'bookId'].some((key) => row[key] != null)
  const customer = () => { const c = find('customers', row.customerId); return !!c && canDataAccess(ctx, c, { storeField: 'storeId', entityField: 'entityId' }) }
  const fund = () => { const account = find('fundAccounts', row.fundAccountId); return !!account && own(account) }
  const orders = (row.orders ?? []).map((link: Row) => find('salOrders', link.orderId))
  if (bizType === 'SAL_ORDER' || bizType === 'SALES_ORDER') return canDataAccess(ctx, row)
  if (bizType === 'SAL_OUTBOUND' || bizType === 'SALES_OUTBOUND') return own()
  if (bizType === 'AR_RECEIPT') return orders.length ? orders.every((o: Row | undefined) => access('SAL_ORDER', o)) && (!hasOwn || own()) : hasOwn ? own() : customer()
  if (bizType === 'AR_RECEIVABLE') return row.orderId ? access('SAL_ORDER', find('salOrders', row.orderId)) : own() || customer()
  if (bizType === 'AR_WRITEOFF') {
    const lines: Row[] = row.lines ?? (row.receivableId ? [{ receivableId: row.receivableId }] : [])
    return lines.length > 0 && lines.every((line) => access('AR_RECEIVABLE', find('arReceivables', line.receivableId)))
  }
  if (bizType === 'AR_CREDIT_NOTE') return row.sourceType === 'SALES_RETURN' && row.sourceId ? access('SALES_RETURN', find('rtnSales', row.sourceId)) : own() || customer()
  if (bizType === 'AP_BILL') {
    if (own()) return true
    const sources: Row[] = []
    for (const line of row.lines ?? []) {
      if (line.sourceType === 'PUR_ORDER_LINE') {
        const po = db.purOrders.find((o) => o.countryId === ctx.countryId && o.lines.some((l: Row) => l.id === line.sourceId))
        if (!po) return false
        sources.push(po)
      } else if (line.sourceType === 'LGS_FEE') {
        const fee = find('lgsFees', line.sourceId)
        if (!fee) return false
        const shipment = find('shipments', fee.shipmentId ?? (fee.refType === 'SHIPMENT' ? fee.refId : null))
        if (!shipment) return false
        sources.push({ ...shipment, warehouseId: shipment.destWarehouseId })
      } else return false
    }
    return sources.length > 0 && sources.every((source) => own(source))
  }
  if (bizType === 'AP_PAYMENT' || bizType === 'AP_PREPAYMENT') return hasOwn ? own() : fund()
  if (bizType === 'AP_CREDIT_NOTE') {
    if (own()) return true
    if (row.sourceType === 'PURCHASE_RETURN') return access('PURCHASE_RETURN', find('rtnPurchase', row.sourceId))
    if (row.sourceType === 'CLAIM') return access('CLAIM', find('rtnClaims', row.sourceId))
    return false
  }
  if (bizType === 'AP_SETTLEMENT') {
    const lines: Row[] = row.lines ?? []
    return lines.length > 0 && lines.every((line) => {
      const type = line.fromType === 'PREPAYMENT' ? 'AP_PREPAYMENT' : line.fromType === 'CREDIT_NOTE' ? 'AP_CREDIT_NOTE' : 'AP_PAYMENT'
      const source = find(type === 'AP_PREPAYMENT' ? 'apPrepayments' : type === 'AP_CREDIT_NOTE' ? 'apCreditNotes' : 'apPayments', line.fromId)
      return access('AP_BILL', find('apBills', line.billId)) && access(type, source)
    })
  }
  if (bizType === 'SALES_RETURN') return own(row, { warehouseField: 'returnWarehouseId', storeField: 'storeId', entityField: 'entityId', bookField: 'bookId' }) || access('SAL_ORDER', find('salOrders', row.orderId))
  if (bizType === 'REFUND') {
    const source = find(row.sourceType === 'CREDIT_NOTE' ? 'arCreditNotes' : 'arReceipts', row.sourceId)
    return own() || (source ? access(row.sourceType === 'CREDIT_NOTE' ? 'AR_CREDIT_NOTE' : 'AR_RECEIPT', source) : customer()) || fund()
  }
  if (bizType === 'PURCHASE_RETURN') return own() || access('PURCHASE_ORDER', find('purOrders', row.poId))
  if (bizType === 'CLAIM') {
    const discrepancy = find('discrepancies', row.discrepancyId)
    const batch = db.invBatches.find((b) => b.id === row.batchId && b.countryId === ctx.countryId)
    return own() || (discrepancy ? own(discrepancy) : false) || (batch ? db.invBatchBalances.some((b) => b.batchId === batch.id && own(b)) : false)
  }
  if (bizType === 'COST_ALLOCATION') {
    const fee = find('lgsFees', row.feeId)
    const lines: Row[] = row.lines ?? []
    return access('LGS_FEE', fee) && lines.length > 0 && lines.every((line) => {
      const cost = db.inboundCosts.find((c) => c.countryId === ctx.countryId && c.batchId === line.batchId)
      return !!cost && own(cost)
    })
  }
  if (bizType === 'LGS_FEE' || bizType === 'HOLD' || bizType === 'TRANSSHIP') return access('SHIPMENT', find('shipments', row.shipmentId))
  if (bizType === 'DELIVERY') return row.destWarehouseId != null ? own({ ...row, warehouseId: row.destWarehouseId }) : access('SHIPMENT', find('shipments', row.shipmentId))
  if (bizType === 'DISCREPANCY' || bizType === 'DISCREPANCY_WRITE_OFF') return hasOwn ? own() : access('SHIPMENT', find('shipments', row.shipmentId))
  if (bizType === 'TRANSFER' || bizType === 'INV_TRANSFER') return canDataAccess(ctx, row, { warehouseField: 'fromWarehouseId' }) || canDataAccess(ctx, row, { warehouseField: 'toWarehouseId' })
  if (bizType === 'SHIPMENT') return own({ ...row, warehouseId: row.destWarehouseId })
  if (bizType === 'DOMESTIC_RECEIPT') return access('PURCHASE_ORDER', find('purOrders', row.orderId))
  if (bizType === 'EXPORT_NODE') return (row.lines ?? []).length > 0 && row.lines.every((line: Row) => access('PURCHASE_ORDER', find('purOrders', line.orderId)))
  return own()
}

export function requireDocumentDataAccess(ctx: Ctx, bizType: string, row: Row): Row {
  if (!canDocumentDataAccess(ctx, bizType, row)) notFound()
  return row
}

/** 附件、来源日志等沿原单据执行功能与数据校验，不能仅凭附件ID或国家访问。 */
export function requireDocumentAccess(ctx: Ctx, bizType: string, bizId: number | string, write = false): Row {
  const rule = DOCS[bizType === 'INV_TRANSFER' ? 'TRANSFER' : bizType]
  if (!rule) notFound()
  const row = (getDb()[rule.table] as Row[]).find((r) => r.id === Number(bizId) && r.countryId === ctx.countryId)
  if (!row) notFound()
  if (!canDocumentDataAccess(ctx, bizType, row)) notFound()
  requirePerm(ctx, write ? rule.write : rule.read)
  return row
}
