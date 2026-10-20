import type { RouteLocationRaw } from 'vue-router'

/** One source reference convention shared by events, vouchers and ledgers. */
export function financeSourcePath(row: Record<string, any>): RouteLocationRaw | undefined {
  if (row.eventType === 'INV_STOCK_CHANGED' && !row.sourceDocId) return undefined
  const type = String(row.sourceDocType ?? row.sourceType ?? '')
  const id = row.sourceDocId ?? row.sourceId
  if (!id) return undefined
  const detail: Record<string, string> = { SALES_ORDER: '/sales/orders/', PURCHASE_ORDER: '/purchase/orders/', SHIPMENT: '/logistics/shipments/', LGS_SHIPMENT: '/logistics/shipments/', LGS_RECEIPT: '/logistics/receipts/' }
  if (detail[type]) return { path: detail[type] + id, query: row.bookId ? { bookId: row.bookId } : {} }
  const lists: Record<string, string> = {
    AR_RECEIPT: '/ar/receipts', AR_RECEIVABLE: '/ar/receivables', AR_WRITEOFF: '/ar/writeoffs', SAL_OUTBOUND: '/sales/outbounds',
    AP_BILL: '/ap/bills', AP_PAYMENT: '/ap/payments', AP_SETTLEMENT: '/ap/settlements', AP_PREPAYMENT: '/ap/prepayments',
    LGS_FEE: '/logistics/fees', CST_INBOUND_COST: '/cost/inbound', CST_ADJUSTMENT: '/cost/adjustments', CST_EXPENSE: '/cost/expenses', CST_ALLOCATION: '/cost/allocations',
    INV_STOCKTAKE: '/inventory/stocktakes', INV_TRANSFER: '/inventory/transfers', PUR_DOMESTIC_RECEIPT: '/purchase/domestic-receipts', DOMESTIC_RECEIPT: '/purchase/domestic-receipts',
    RTN_SALES: '/returns/sales', SALES_RETURN: '/returns/sales', SALES_RETURN_SETTLEMENT: '/returns/sales', SALES_RETURN_SETTLEMENT_REVERSED: '/returns/sales', SALES_RETURN_INSPECTION: '/returns/sales', RTN_REFUND: '/returns/refunds', REFUND: '/returns/refunds', RTN_PURCHASE: '/returns/purchase', PURCHASE_RETURN: '/returns/purchase', CLAIM: '/returns/claims',
  }
  return lists[type] ? { path: lists[type], query: { sourceId: id, ...(row.bookId ? { bookId: row.bookId } : {}) } } : undefined
}
