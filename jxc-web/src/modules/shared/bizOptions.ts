import type { OptionItem } from '@/stores/options'
import type { OptionSource } from '@/components/crud/types'

/** 第 2 批业务单据共用的下拉来源与枚举 */

export const PRODUCT_SOURCE: OptionSource = { remote: '/md/country-skus', label: 'label', value: 'productId', params: { enabled: 'true' } }
export const SUPPLIER_SOURCE: OptionSource = { remote: '/md/partners', params: { partnerType: 'SUPPLIER', status: 'ENABLED' } }
export const CARRIER_SOURCE: OptionSource = { remote: '/md/partners', params: { partnerType: 'LOGISTICS', status: 'ENABLED' } }
export const MX_WAREHOUSE_SOURCE: OptionSource = { remote: '/org/warehouses', params: { type: 'WAREHOUSE', status: 'ENABLED' } }
export const ALL_WAREHOUSE_SOURCE: OptionSource = { remote: '/org/warehouses', params: { status: 'ENABLED' } }
export const USER_SOURCE: OptionSource = { remote: '/sys/user-options', label: 'displayName' }
export const EXPENSE_ITEM_SOURCE: OptionSource = { remote: '/md/expense-items', params: { status: 'ENABLED' } }
export const CATEGORY_SOURCE: OptionSource = { remote: '/md/categories' }
export const HOLD_REASON_SOURCE: OptionSource = { remote: '/md/dicts', label: 'label', value: 'code', params: { dictType: 'HOLD_REASON', status: 'ENABLED' } }

export const PO_STATUS: OptionItem[] = [
  { label: '草稿', value: 'DRAFT' },
  { label: '待审批', value: 'PENDING_APPROVAL' },
  { label: '已确认', value: 'CONFIRMED' },
  { label: '部分交付', value: 'PARTIAL_DELIVERED' },
  { label: '已交付', value: 'DELIVERED' },
  { label: '已关闭', value: 'CLOSED' },
  { label: '已作废', value: 'CANCELLED' },
]

export const DOC_STATUS: OptionItem[] = [
  { label: '草稿', value: 'DRAFT' },
  { label: '已确认', value: 'CONFIRMED' },
  { label: '已作废', value: 'VOIDED' },
]

export const TRANSPORT_MODES: OptionItem[] = [
  { label: '海运', value: 'SEA' },
  { label: '空运', value: 'AIR' },
]

export const SHIPMENT_STATUS: OptionItem[] = [
  { label: '草稿', value: 'DRAFT' },
  { label: '待发运', value: 'PENDING_DISPATCH' },
  { label: '在途', value: 'IN_TRANSIT' },
  { label: '已到港', value: 'ARRIVED_PORT' },
  { label: '清关中', value: 'PENDING_CLEARANCE' },
  { label: '已放行', value: 'RELEASED' },
  { label: '待派送', value: 'PENDING_DELIVERY' },
  { label: '暂缓中', value: 'ON_HOLD' },
  { label: '部分实收', value: 'PARTIAL_RECEIVED' },
  { label: '已完成', value: 'COMPLETED' },
]

/** 运输批次数量桶，顺序即恒等式：发运 = 各桶之和 */
export const BUCKETS: { prop: string; label: string }[] = [
  { prop: 'intlQty', label: '国际在途' },
  { prop: 'pendingDeliveryQty', label: '当地待派送' },
  { prop: 'onHoldQty', label: '暂缓' },
  { prop: 'deliveringQty', label: '派送在途' },
  { prop: 'receivedGoodQty', label: '已实收合格' },
  { prop: 'receivedFrozenQty', label: '已实收冻结' },
  { prop: 'discrepancyQty', label: '差异' },
]

export const MANUAL_NODES: OptionItem[] = [
  { label: '到港', value: 'ARRIVED_PORT' },
  { label: '报关', value: 'CUSTOMS_DECLARED' },
  { label: '放行', value: 'CUSTOMS_RELEASED' },
  { label: '异常', value: 'EXCEPTION' },
]

export const HOLD_STATUS: OptionItem[] = [
  { label: '暂缓中', value: 'ACTIVE' },
  { label: '部分恢复', value: 'PARTIAL_RELEASED' },
  { label: '已恢复', value: 'RELEASED' },
]

export const DELIVERY_STATUS: OptionItem[] = [
  { label: '草稿', value: 'DRAFT' },
  { label: '已出发', value: 'DISPATCHED' },
  { label: '已实收', value: 'RECEIVED' },
  { label: '已作废', value: 'VOIDED' },
]

export const DISCREPANCY_TYPES: OptionItem[] = [
  { label: '短缺', value: 'SHORT' },
  { label: '破损', value: 'DAMAGED' },
  { label: '未到', value: 'NOT_ARRIVED' },
  { label: '换柜差异', value: 'TRANSSHIP_DIFF' },
]

export const DISCREPANCY_STATUS: OptionItem[] = [
  { label: '待处理', value: 'OPEN' },
  { label: '审批中', value: 'PENDING_APPROVAL' },
  { label: '已处理', value: 'RESOLVED' },
]

export const RESOLUTIONS: OptionItem[] = [
  { label: '后续到货（回到待派送）', value: 'LATER_ARRIVED' },
  { label: '转索赔', value: 'CLAIM' },
  { label: '核销（需审批）', value: 'WRITE_OFF' },
  { label: '供应商贷项', value: 'SUPPLIER_CREDIT' },
]

export const FEE_REF_TYPES: OptionItem[] = [
  { label: '运输批次', value: 'SHIPMENT' },
  { label: '换柜', value: 'TRANSSHIP' },
  { label: '暂缓派送', value: 'HOLD' },
  { label: '派送单', value: 'DELIVERY' },
]

export const ESTIMATE_FLAGS: OptionItem[] = [
  { label: '暂估', value: 'ESTIMATE' },
  { label: '实际', value: 'ACTUAL' },
]

export const FEE_STATUS: OptionItem[] = [
  { label: '草稿', value: 'DRAFT' },
  { label: '已确认', value: 'CONFIRMED' },
  { label: '已调整', value: 'ADJUSTED' },
  { label: '已入账单', value: 'BILLED' },
  { label: '已作废', value: 'VOIDED' },
]

export const FREEZE_TYPES: OptionItem[] = [
  { label: '待检', value: 'PENDING_INSPECT' },
  { label: '破损', value: 'DAMAGED' },
  { label: '待处理退货', value: 'RETURN_PENDING' },
  { label: '手工冻结', value: 'MANUAL' },
]

export const FREEZE_STATUS: OptionItem[] = [
  { label: '冻结中', value: 'ACTIVE' },
  { label: '部分解冻', value: 'PARTIAL_RELEASED' },
  { label: '已解冻', value: 'RELEASED' },
]

export const TXN_TYPES: OptionItem[] = [
  { label: '实收入库', value: 'RECEIPT_IN' },
  { label: '冻结', value: 'FREEZE' },
  { label: '解冻', value: 'UNFREEZE' },
  { label: '调拨出库', value: 'TRANSFER_OUT' },
  { label: '调拨入库', value: 'TRANSFER_IN' },
  { label: '盘盈', value: 'STOCKTAKE_GAIN' },
  { label: '盘亏', value: 'STOCKTAKE_LOSS' },
]

export const SOURCE_TYPES: OptionItem[] = [
  { label: '目的仓实收', value: 'LGS_RECEIPT' },
  { label: '调拨', value: 'INV_TRANSFER' },
  { label: '盘点', value: 'INV_STOCKTAKE' },
  { label: '冻结单', value: 'INV_FREEZE' },
]

export const BATCH_SOURCES: OptionItem[] = [
  { label: '目的仓实收', value: 'MX_RECEIPT' },
  { label: '调拨', value: 'TRANSFER' },
  { label: '退货', value: 'RETURN' },
  { label: '盘盈', value: 'STOCKTAKE_GAIN' },
  { label: '期初', value: 'OPENING' },
]

export const TRANSFER_STATUS: OptionItem[] = [
  { label: '草稿', value: 'DRAFT' },
  { label: '待审批', value: 'PENDING_APPROVAL' },
  { label: '已审批', value: 'APPROVED' },
  { label: '在途', value: 'IN_TRANSIT' },
  { label: '部分实收', value: 'PARTIAL_RECEIVED' },
  { label: '已实收', value: 'RECEIVED' },
  { label: '已关闭', value: 'CLOSED' },
  { label: '已取消', value: 'CANCELLED' },
]

export const STOCKTAKE_STATUS: OptionItem[] = [
  { label: '草稿', value: 'DRAFT' },
  { label: '盘点中', value: 'COUNTING' },
  { label: '待审批', value: 'SUBMITTED' },
  { label: '已审批', value: 'APPROVED' },
  { label: '已过账', value: 'POSTED' },
  { label: '已取消', value: 'CANCELLED' },
]

export const ALERT_TYPES: OptionItem[] = [
  { label: '缺货', value: 'OUT_OF_STOCK' },
  { label: '低于下限', value: 'BELOW_MIN' },
  { label: '高于上限', value: 'ABOVE_MAX' },
]

export const ALERT_TAG: Record<string, 'danger' | 'warning' | 'info'> = { OUT_OF_STOCK: 'danger', BELOW_MIN: 'warning', ABOVE_MAX: 'info' }

export const COST_STATUS: OptionItem[] = [
  { label: '待补汇率', value: 'PENDING_RATE' },
  { label: '暂估', value: 'ESTIMATED' },
  { label: '已确认', value: 'CONFIRMED' },
]

export const optionText = (items: OptionItem[], v: unknown) => items.find((i) => i.value === v)?.label ?? (v == null ? '-' : String(v))

export const CUSTOMER_SOURCE: OptionSource = { remote: '/md/customers', params: { status: 'ENABLED' } }
export const LEVEL_SOURCE: OptionSource = { remote: '/md/customer-levels', params: { status: 'ENABLED' } }
export const GROUP_SOURCE: OptionSource = { remote: '/md/customer-groups', params: { status: 'ENABLED' } }
export const FUND_ACCOUNT_SOURCE: OptionSource = { remote: '/md/fund-accounts', params: { status: 'ENABLED' } }
export const STORE_SOURCE: OptionSource = { remote: '/org/stores', params: { status: 'ENABLED' } }
export const PARTNER_SOURCE: OptionSource = { remote: '/md/partners', params: { status: 'ENABLED' } }
export const PO_SOURCE: OptionSource = { remote: '/pur/orders' }

export const PAYMENT_TYPES: OptionItem[] = [
  { label: '现款', value: 'CASH' },
  { label: '赊销', value: 'CREDIT' },
]
export const APPROVAL_STATUS: OptionItem[] = [
  { label: '草稿', value: 'DRAFT' },
  { label: '待审批', value: 'PENDING' },
  { label: '已通过', value: 'APPROVED' },
  { label: '已驳回', value: 'REJECTED' },
  { label: '已撤回', value: 'WITHDRAWN' },
]
export const FULFILLMENT_STATUS: OptionItem[] = [
  { label: '待备货', value: 'PENDING_PREPARE' },
  { label: '待出库', value: 'PENDING_OUTBOUND' },
  { label: '部分出库', value: 'PARTIAL_OUTBOUND' },
  { label: '已出库', value: 'OUTBOUNDED' },
  { label: '部分签收', value: 'PARTIAL_SIGNED' },
  { label: '已签收', value: 'SIGNED' },
  { label: '已取消', value: 'CANCELLED' },
]
export const PAY_STATUS: OptionItem[] = [
  { label: '未付款', value: 'UNPAID' },
  { label: '部分付款', value: 'PARTIAL' },
  { label: '已付清', value: 'PAID' },
]
export const RECEIPT_STATUS: OptionItem[] = [
  { label: '待确认', value: 'PENDING_CONFIRM' },
  { label: '已确认', value: 'CONFIRMED' },
  { label: '部分核销', value: 'PARTIAL_WRITTEN_OFF' },
  { label: '已核销', value: 'WRITTEN_OFF' },
  { label: '已驳回', value: 'REJECTED' },
  { label: '已作废', value: 'VOIDED' },
]
export const DUE_STATUS: OptionItem[] = [
  { label: '未到期', value: 'NOT_DUE' },
  { label: '即将到期', value: 'DUE_SOON' },
  { label: '已逾期', value: 'OVERDUE' },
]
export const PRICE_TYPES: OptionItem[] = [
  { label: '基础价', value: 'BASE' },
  { label: '等级价', value: 'LEVEL' },
  { label: '客户专属价', value: 'CUSTOMER' },
]
export const AR_SETTLE_STATUS: OptionItem[] = [
  { label: '未结', value: 'OPEN' },
  { label: '部分结清', value: 'PARTIAL' },
  { label: '已结清', value: 'SETTLED' },
]
export const AP_BILL_STATUS: OptionItem[] = [
  { label: '草稿', value: 'DRAFT' },
  { label: '已确认', value: 'CONFIRMED' },
  { label: '部分付款', value: 'PARTIAL_PAID' },
  { label: '已付清', value: 'PAID' },
  { label: '已作废', value: 'VOIDED' },
]
export const RETURN_STATUS: OptionItem[] = [
  { label: '草稿', value: 'DRAFT' },
  { label: '待审批', value: 'PENDING_APPROVAL' },
  { label: '待实收', value: 'PENDING_RECEIPT' },
  { label: '待验货', value: 'PENDING_INSPECT' },
  { label: '待账款', value: 'PENDING_SETTLE' },
  { label: '已完成', value: 'COMPLETED' },
  { label: '已驳回', value: 'REJECTED' },
]
export const RETURN_REASONS: OptionItem[] = [
  { label: '质量问题', value: 'QUALITY' },
  { label: '发错货', value: 'WRONG_ITEM' },
  { label: '客户原因', value: 'CUSTOMER_CHANGE' },
  { label: '运输破损', value: 'DAMAGED_IN_TRANSIT' },
]
export const RESPONSIBILITY: OptionItem[] = [
  { label: '客户', value: 'CUSTOMER' },
  { label: '我方', value: 'SELF' },
  { label: '物流', value: 'CARRIER' },
  { label: '供应商', value: 'SUPPLIER' },
]
