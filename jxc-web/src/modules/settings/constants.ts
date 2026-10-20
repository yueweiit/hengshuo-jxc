import type { OptionItem } from '@/stores/options'

export const MODULES: OptionItem[] = [
  { label: '中国采购', value: 'pur' },
  { label: '国际物流', value: 'lgs' },
  { label: '库存', value: 'inv' },
  { label: '销售与门店', value: 'sal' },
  { label: '收款与应收', value: 'ar' },
  { label: '应付', value: 'ap' },
  { label: '退货退款', value: 'rtn' },
  { label: '成本与分析', value: 'cst' },
  { label: '内部财务', value: 'fin' },
]

export const TIMEZONES: OptionItem[] = [
  'America/Mexico_City',
  'America/Tijuana',
  'America/Cancun',
  'America/Bogota',
  'America/Lima',
  'America/Santiago',
  'America/Sao_Paulo',
  'America/New_York',
  'Asia/Shanghai',
  'UTC',
].map((v) => ({ label: v, value: v }))

export const COUNTRY_LOCALES: OptionItem[] = ['es-MX', 'es-CO', 'es-PE', 'es-CL', 'pt-BR', 'en-US', 'zh-CN'].map((v) => ({ label: v, value: v }))

export const DATE_FORMATS: OptionItem[] = ['DD/MM/YYYY', 'YYYY-MM-DD', 'MM/DD/YYYY'].map((v) => ({ label: v, value: v }))
export const NUMBER_FORMATS: OptionItem[] = ['1,234.56', '1.234,56'].map((v) => ({ label: v, value: v }))

export const DOC_TYPES: OptionItem[] = [
  { label: '销售订单', value: 'SALES_ORDER' },
  { label: '销售出库', value: 'SALES_OUTBOUND' },
  { label: '采购单', value: 'PURCHASE_ORDER' },
  { label: '退款', value: 'REFUND' },
  { label: '销售退货', value: 'SALES_RETURN' },
  { label: '采购退货', value: 'PURCHASE_RETURN' },
  { label: '盘点', value: 'STOCKTAKE' },
  { label: '调拨', value: 'TRANSFER' },
  { label: '调拨差异', value: 'TRANSFER_DIFFERENCE' },
  { label: '到货差异核销', value: 'DISCREPANCY_WRITE_OFF' },
]

export const ROLE_TYPES: OptionItem[] = [
  { label: '管理', value: 'ADMIN' },
  { label: '业务', value: 'BUSINESS' },
  { label: '财务', value: 'FINANCE' },
]

export const WAREHOUSE_TYPES: OptionItem[] = [
  { label: '仓库', value: 'WAREHOUSE' },
  { label: '门店仓', value: 'STORE' },
]

export const FIELD_GROUPS: OptionItem[] = [
  { label: '成本', value: 'COST' },
  { label: '客户价格', value: 'CUSTOMER_PRICE' },
  { label: '订单金额', value: 'ORDER_TOTAL' },
  { label: '银行信息', value: 'BANK_INFO' },
  { label: '利润', value: 'PROFIT' },
  { label: '授信额度', value: 'CREDIT' },
]

export const RESOURCE_TYPES: OptionItem[] = [
  { label: '国家', value: 'country' },
  { label: '国家模板', value: 'country-template' },
  { label: '用户', value: 'user' },
  { label: '角色', value: 'role' },
  { label: '审批规则', value: 'approval-rule' },
  { label: '审批', value: 'approval' },
  { label: '看单与抄送', value: 'doc-watcher' },
  { label: '经营主体', value: 'entity' },
  { label: '仓库', value: 'warehouse' },
  { label: '门店', value: 'store' },
  { label: '商品', value: 'product' },
  { label: '本国 SKU', value: 'country-sku' },
  { label: '客户', value: 'customer' },
  { label: '供应商物流商', value: 'partner' },
  { label: '费用项目', value: 'expense-item' },
  { label: '汇率', value: 'exchange-rate' },
  { label: '资金账户', value: 'fund-account' },
  { label: '字典', value: 'dict' },
]

export const labelOf = (list: OptionItem[], v: unknown) => list.find((o) => o.value === v)?.label ?? String(v ?? '-')
