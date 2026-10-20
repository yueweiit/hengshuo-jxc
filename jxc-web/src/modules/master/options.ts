import type { OptionItem } from '@/stores/options'
import type { OptionSource } from '@/components/crud/types'

export const STATUS_OPTIONS: OptionItem[] = [
  { label: '启用', value: 'ENABLED' },
  { label: '停用', value: 'DISABLED' },
]

export const CUSTOMER_TYPES: OptionItem[] = [
  { label: '企业', value: 'COMPANY' },
  { label: '个人', value: 'PERSON' },
]

export const PARTNER_TYPES: OptionItem[] = [
  { label: '供应商', value: 'SUPPLIER' },
  { label: '物流商', value: 'LOGISTICS' },
  { label: '两者兼有', value: 'BOTH' },
]

export const LOCATED_COUNTRIES: OptionItem[] = [
  { label: '中国', value: 'CN' },
  { label: '墨西哥', value: 'MX' },
  { label: '哥伦比亚', value: 'CO' },
  { label: '秘鲁', value: 'PE' },
  { label: '智利', value: 'CL' },
  { label: '美国', value: 'US' },
]

export const FEE_CATEGORIES: OptionItem[] = [
  { label: '海运费', value: 'FREIGHT_SEA' },
  { label: '空运费', value: 'FREIGHT_AIR' },
  { label: '报关清关', value: 'CUSTOMS' },
  { label: '换柜', value: 'TRANSSHIP' },
  { label: '当地派送', value: 'DELIVERY' },
  { label: '滞港', value: 'DEMURRAGE' },
  { label: '仓储', value: 'STORAGE' },
  { label: '其他', value: 'OTHER' },
]

export const COST_TREATMENTS: OptionItem[] = [
  { label: '计入商品成本', value: 'CAPITALIZE' },
  { label: '期间费用', value: 'PERIOD_EXPENSE' },
  { label: '直接销售费用', value: 'DIRECT_SELLING' },
]

export const ALLOC_BASES: OptionItem[] = [
  { label: '数量', value: 'QTY' },
  { label: '重量', value: 'WEIGHT' },
  { label: '体积', value: 'VOLUME' },
  { label: '货值', value: 'VALUE' },
  { label: '手工', value: 'MANUAL' },
]

export const RATE_SCOPES: OptionItem[] = [
  { label: '采购成本', value: 'PURCHASE_COST' },
  { label: '结算', value: 'SETTLEMENT' },
  { label: '报表', value: 'REPORT' },
  { label: '全部', value: 'ALL' },
]

export const ACCOUNT_TYPES: OptionItem[] = [
  { label: '现金', value: 'CASH' },
  { label: '银行', value: 'BANK' },
]

export const DICT_TYPES: OptionItem[] = [
  { label: '销售来源', value: 'SALES_SOURCE' },
  { label: '退货原因', value: 'RETURN_REASON' },
  { label: '暂缓派送原因', value: 'HOLD_REASON' },
  { label: '到货差异原因', value: 'DISCREPANCY_REASON' },
  { label: '责任方', value: 'RESPONSIBILITY' },
]

export const CURRENCY_SOURCE: OptionSource = { remote: '/md/currencies', label: 'code', value: 'code' }
export const ENTITY_SOURCE: OptionSource = { remote: '/org/entities' }
export const STORE_SOURCE: OptionSource = { remote: '/org/stores' }
export const WAREHOUSE_SOURCE: OptionSource = { remote: '/org/warehouses' }
