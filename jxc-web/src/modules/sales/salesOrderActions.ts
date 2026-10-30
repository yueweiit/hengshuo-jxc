type SalesOrder = { approvalStatus?: string; fulfillmentStatus?: string; openQty?: number | null }

/** 只使用服务端按当前授权范围返回的未交数量。 */
function hasOpenSupply(order: SalesOrder | null | undefined): order is SalesOrder {
  return !!order && !['CANCELLED', 'CLOSED'].includes(order.fulfillmentStatus ?? '')
    && typeof order.openQty === 'number' && Number.isFinite(order.openQty) && order.openQty > 0
}

export function canEditSalesOrder(order: SalesOrder | null | undefined): boolean {
  return hasOpenSupply(order) && ['DRAFT', 'REJECTED', 'WITHDRAWN', 'APPROVED'].includes(order.approvalStatus ?? '')
}

export function canSubmitSalesOrder(order: SalesOrder | null | undefined): boolean {
  return hasOpenSupply(order) && ['DRAFT', 'REJECTED', 'WITHDRAWN'].includes(order.approvalStatus ?? '')
}

export function canOutboundSalesOrder(order: SalesOrder | null | undefined): boolean {
  return hasOpenSupply(order) && order.approvalStatus === 'APPROVED'
}
