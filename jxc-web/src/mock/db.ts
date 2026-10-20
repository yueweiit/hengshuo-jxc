/* eslint-disable @typescript-eslint/no-explicit-any */
/**
 * 浏览器内演示数据库。MSW 的处理函数运行在页面线程，数据持久化到 localStorage。
 * 只用于前端联调，字段命名与 docs 中的接口约定一致（camelCase）。
 */
export type Row = Record<string, any>

export interface Db {
  seq: number
  sessions: Record<string, number>
  users: Row[]
  roles: Row[]
  userRoles: Row[]
  dataScopes: Row[]
  countries: Row[]
  templates: Row[]
  cloneJobs: Row[]
  reviews: Row[]
  upgrades: Row[]
  books: Row[]
  entities: Row[]
  warehouses: Row[]
  stores: Row[]
  categories: Row[]
  products: Row[]
  countrySkus: Row[]
  customerGroups: Row[]
  customerLevels: Row[]
  customers: Row[]
  partners: Row[]
  expenseItems: Row[]
  currencies: Row[]
  exchangeRates: Row[]
  fundAccounts: Row[]
  dicts: Row[]
  auditLogs: Row[]
  attachments: Row[]
  approvalRules: Row[]
  docTypeConfigs: Row[]
  approvalInstances: Row[]
  approvalTasks: Row[]
  docWatchers: Row[]
  todos: Row[]
  notifications: Row[]
  idempotency: Record<string, unknown>
  docSeqs: Record<string, number>
  // 第 2 批：采购、物流、库存、入库成本
  purOrders: Row[]
  purCancels: Row[]
  domesticReceipts: Row[]
  inspectConverts: Row[]
  exportNodes: Row[]
  shipments: Row[]
  transships: Row[]
  holds: Row[]
  deliveries: Row[]
  lgsReceipts: Row[]
  discrepancies: Row[]
  lgsFees: Row[]
  invSummaries: Row[]
  invBatches: Row[]
  invBatchBalances: Row[]
  invTxns: Row[]
  invFreezes: Row[]
  transfers: Row[]
  stocktakes: Row[]
  stockLimits: Row[]
  stockAlerts: Row[]
  inboundCosts: Row[]
  // 第 3 批：销售、应收、应付、退货
  salPrices: Row[]
  salOrders: Row[]
  salOutbounds: Row[]
  salSigns: Row[]
  arCreditRules: Row[]
  arOccupations: Row[]
  arReceipts: Row[]
  arReceivables: Row[]
  arCreditNotes: Row[]
  arWriteoffs: Row[]
  arStatements: Row[]
  apBills: Row[]
  apPrepayments: Row[]
  apPayments: Row[]
  apSettlements: Row[]
  apCreditNotes: Row[]
  apStatements: Row[]
  rtnSales: Row[]
  rtnRefunds: Row[]
  rtnPurchase: Row[]
  rtnClaims: Row[]
  classifyRules: Row[]
  classifyResults: Row[]
  classifyResultLogs: Row[]
  replenishments: Row[]
  feeAllocations: Row[]
  costAdjustments: Row[]
  expenses: Row[]
  cstMethods: Row[]
  finPeriods: Row[]
  finAccounts: Row[]
  finOpenings: Row[]
  finMappings: Row[]
  finEvents: Row[]
  finVouchers: Row[]
  finBalances: Row[]
  finCloseChecks: Row[]
  finReopenLogs: Row[]
  finSnapshots: Row[]
  cashflowItems: Row[]
  aiRequests: Row[]
  importBatches: Row[]
  asyncJobs: Row[]
}

const STORAGE_KEY = 'jxc.mock.db.v6'
const NOW = '2026-10-15T09:00:00Z'

export const ALL_MODULES = ['pur', 'lgs', 'inv', 'sal', 'ar', 'ap', 'rtn', 'cst', 'fin']

export const COUNTRY_ADMIN_PERMS = [
  'sys:country:view',
  'sys:country-param:edit',
  'sys:template:upgrade',
  'org:*',
  'sys:user:edit',
  'sys:role:edit',
  'wf:rule:edit',
  'sys:watcher:edit',
  'sys:audit:view',
  'md:product:view',
  'md:country-sku:edit',
  'md:customer:view',
  'md:customer:edit',
  'md:partner:view',
  'md:partner:edit',
  'md:expense-item:edit',
  'md:rate:edit',
  'md:fund-account:edit',
  'md:dict:edit',
]

const TEMPLATE_ITEMS_V1 = [
  { itemType: 'MODULE', itemKey: 'modules', label: '启用模块（采购、物流、库存、销售、往来、成本、财务）', requiresReview: false, sensitive: false },
  { itemType: 'FORM_FIELD', itemKey: 'form-fields', label: '表单字段配置', requiresReview: false, sensitive: false },
  { itemType: 'FLOW', itemKey: 'flows', label: '业务流程结构（采购到实收、现款、赊销、退货）', requiresReview: false, sensitive: false },
  { itemType: 'ROLE_TEMPLATE', itemKey: 'roles', label: '岗位角色模板（不含人员绑定）', requiresReview: false, sensitive: false },
  { itemType: 'REPORT_DEF', itemKey: 'report-defs', label: '通用报表定义', requiresReview: false, sensitive: false },
  { itemType: 'CLASSIFY_RULE', itemKey: 'classify-rules', label: '畅销滞销规则结构（阈值需复核）', requiresReview: true, sensitive: false },
  { itemType: 'PRICE_RULE_STRUCT', itemKey: 'price-structure', label: '定价规则结构（不含当地币种价格）', requiresReview: false, sensitive: false },
  { itemType: 'CREDIT_RULE_STRUCT', itemKey: 'credit-structure', label: '授信规则结构（额度账期需复核）', requiresReview: true, sensitive: false },
  { itemType: 'APPROVAL_RULE', itemKey: 'approval-rules', label: '审批规则（金额阈值需复核）', requiresReview: true, sensitive: false },
  { itemType: 'VOUCHER_MAPPING', itemKey: 'voucher-mapping', label: '凭证映射模板', requiresReview: true, sensitive: false },
  { itemType: 'REPORT_MAPPING', itemKey: 'report-mapping', label: '财务报表映射', requiresReview: true, sensitive: false },
  { itemType: 'ACCOUNT_CHART', itemKey: 'account-chart', label: '会计科目表结构', requiresReview: true, sensitive: false },
  { itemType: 'DOC_NUMBER_RULE', itemKey: 'doc-number', label: '单据编号规则', requiresReview: false, sensitive: false },
  { itemType: 'DICT', itemKey: 'dicts', label: '业务字典', requiresReview: false, sensitive: false },
  { itemType: 'SENSITIVE', itemKey: 'mx-users', label: '墨西哥实际账号与授权', requiresReview: false, sensitive: true },
  { itemType: 'SENSITIVE', itemKey: 'mx-bank', label: '银行资料与收款账户', requiresReview: false, sensitive: true },
  { itemType: 'SENSITIVE', itemKey: 'mx-business', label: '订单、库存余额、成本余额、欠款、收付款、凭证、历史报表', requiresReview: false, sensitive: true },
]

function seed(): Db {
  let seq = 1000
  const id = () => ++seq
  const withIds = (rows: Row[]) => rows.map((r) => ({ id: id(), version: 1, createdAt: NOW, updatedAt: NOW, ...r }))

  const tplV1Items = withIds(TEMPLATE_ITEMS_V1)
  const tplV2Items = withIds([
    ...TEMPLATE_ITEMS_V1.map((i) =>
      i.itemKey === 'classify-rules' ? { ...i, label: '畅销滞销规则结构（新增订单张数辅助指标，阈值需复核）' } : i,
    ),
    { itemType: 'EXPENSE_ITEMS', itemKey: 'expense-items', label: '费用项目结构（不含科目）', requiresReview: true, sensitive: false },
  ])

  const db: Db = {
    seq: 0,
    sessions: {},
    idempotency: {},
    docSeqs: {},
    purOrders: [],
    purCancels: [],
    domesticReceipts: [],
    inspectConverts: [],
    exportNodes: [],
    shipments: [],
    transships: [],
    holds: [],
    deliveries: [],
    lgsReceipts: [],
    discrepancies: [],
    lgsFees: [],
    invSummaries: [],
    invBatches: [],
    invBatchBalances: [],
    invTxns: [],
    invFreezes: [],
    transfers: [],
    stocktakes: [],
    stockLimits: [],
    stockAlerts: [],
    inboundCosts: [],
    salPrices: [],
    salOrders: [],
    salOutbounds: [],
    salSigns: [],
    arCreditRules: [],
    arOccupations: [],
    arReceipts: [],
    arReceivables: [],
    arCreditNotes: [],
    arWriteoffs: [],
    arStatements: [],
    apBills: [],
    apPrepayments: [],
    apPayments: [],
    apSettlements: [],
    apCreditNotes: [],
    apStatements: [],
    rtnSales: [],
    rtnRefunds: [],
    rtnPurchase: [],
    rtnClaims: [],
    classifyRules: [],
    classifyResults: [],
    classifyResultLogs: [],
    replenishments: [],
    feeAllocations: [],
    costAdjustments: [],
    expenses: [],
    cstMethods: [],
    finPeriods: [],
    finAccounts: [],
    finOpenings: [],
    finMappings: [],
    finEvents: [],
    finVouchers: [],
    finBalances: [],
    finCloseChecks: [],
    finReopenLogs: [],
    finSnapshots: [],
    cashflowItems: [],
    aiRequests: [],
    importBatches: [],
    asyncJobs: [],
    users: [
      { id: 1, username: 'admin', password: 'admin123', displayName: '平台管理员', phone: '', email: 'admin@hengshuo.example', status: 'ENABLED', isPlatformAdmin: true, locale: 'zh-CN' },
      { id: 2, username: 'store01', password: '123456', displayName: '一号店店员 María', phone: '+52 55 0000 0001', email: '', status: 'ENABLED', isPlatformAdmin: false, locale: 'zh-CN' },
      { id: 3, username: 'finance01', password: '123456', displayName: '财务 李会计', phone: '', email: '', status: 'ENABLED', isPlatformAdmin: false, locale: 'zh-CN' },
      { id: 4, username: 'lead01', password: '123456', displayName: '业务负责人 王经理', phone: '', email: '', status: 'ENABLED', isPlatformAdmin: false, locale: 'zh-CN' },
      { id: 5, username: 'newbie', password: '123456', displayName: '新员工（未授权）', phone: '', email: '', status: 'ENABLED', isPlatformAdmin: false, locale: 'zh-CN' },
      { id: 6, username: 'buyer01', password: '123456', displayName: '采购物流 陈专员', phone: '+86 20 8888 1001', email: '', status: 'ENABLED', isPlatformAdmin: false, locale: 'zh-CN' },
      { id: 7, username: 'wh01', password: '123456', displayName: '中心仓仓管 Carlos', phone: '+52 55 0000 0007', email: '', status: 'ENABLED', isPlatformAdmin: false, locale: 'zh-CN' },
      { id: 8, username: 'cl01', password: '123456', displayName: '智利管理员 Camila', phone: '', email: '', status: 'ENABLED', isPlatformAdmin: false, locale: 'zh-CN' },
    ].map((u) => ({ ...u, version: 1, createdAt: NOW, updatedAt: NOW })),
    roles: [
      { id: 11, countryId: 1, code: 'SUPER', name: '演示超级管理员', roleType: 'ADMIN', status: 'ENABLED', permissions: ['*'], fieldPolicies: { COST: 'WRITE', CUSTOMER_PRICE: 'WRITE', ORDER_TOTAL: 'WRITE', BANK_INFO: 'WRITE', PROFIT: 'WRITE', CREDIT: 'WRITE' }, isTemplate: false },
      { id: 12, countryId: 1, code: 'COUNTRY_ADMIN', name: '国家管理员', roleType: 'ADMIN', status: 'ENABLED', permissions: COUNTRY_ADMIN_PERMS, fieldPolicies: {}, isTemplate: true },
      { id: 13, countryId: 1, code: 'STORE_STAFF', name: '门店员', roleType: 'BUSINESS', status: 'ENABLED', permissions: ['md:product:view', 'md:customer:view', 'md:customer:edit', 'sal:order:view', 'sal:order:create', 'sal:order:submit', 'sal:sign:record', 'ar:receipt:create', 'rtn:sales:create'], fieldPolicies: { CUSTOMER_PRICE: 'READ', ORDER_TOTAL: 'READ', CREDIT: 'READ' }, isTemplate: true },
      { id: 14, countryId: 1, code: 'FINANCE', name: '财务', roleType: 'FINANCE', status: 'ENABLED', permissions: ['md:rate:edit', 'md:rate:confirm', 'md:fund-account:edit', 'md:partner:view', 'md:partner:bank-view', 'md:customer:view', 'md:product:view', 'ar:*', 'ap:*', 'cst:*', 'fin:*', 'rtn:sales:settle', 'rtn:refund:create', 'rtn:refund:pay', 'pur:order:view', 'lgs:shipment:view', 'lgs:fee:create', 'lgs:fee:confirm', 'inv:stock:view', 'inv:txn:view', 'inv:stocktake:approve', 'sys:export:view'], fieldPolicies: { COST: 'READ', BANK_INFO: 'READ', PROFIT: 'READ', CREDIT: 'READ', ORDER_TOTAL: 'READ' }, isTemplate: true },
      { id: 15, countryId: 1, code: 'BIZ_LEAD', name: '业务负责人', roleType: 'BUSINESS', status: 'ENABLED', permissions: ['md:customer:view', 'md:customer:edit', 'md:product:view', 'sal:*', 'ar:credit-rule:view', 'ar:credit-rule:edit', 'ar:receivable:view', 'pur:order:view', 'inv:stock:view', 'inv:classify:view', 'inv:classify:config', 'inv:replenish:decide', 'cst:profit:view', 'ai:analysis:use'], fieldPolicies: { CUSTOMER_PRICE: 'WRITE', ORDER_TOTAL: 'READ', PROFIT: 'READ', CREDIT: 'READ', COST: 'READ' }, isTemplate: true },
      { id: 18, countryId: 2, code: 'COUNTRY_ADMIN', name: '智利国家管理员', roleType: 'ADMIN', status: 'ENABLED', permissions: ['*'], fieldPolicies: { COST: 'WRITE', CUSTOMER_PRICE: 'WRITE', ORDER_TOTAL: 'WRITE', BANK_INFO: 'WRITE', PROFIT: 'WRITE', CREDIT: 'WRITE' }, isTemplate: false },
      { id: 16, countryId: 1, code: 'WAREHOUSE', name: '仓库操作员', roleType: 'BUSINESS', status: 'ENABLED', permissions: ['md:product:view', 'inv:stock:view', 'inv:txn:view', 'inv:freeze:create', 'inv:transfer:create', 'inv:transfer:ship', 'inv:transfer:receive', 'inv:stocktake:create', 'inv:stocktake:count', 'inv:stocktake:submit', 'lgs:receipt:confirm', 'sal:outbound:create', 'sal:outbound:confirm', 'rtn:sales:receive', 'rtn:sales:inspect', 'inv:replenish:create'], fieldPolicies: {}, isTemplate: true },
      { id: 17, countryId: 1, code: 'PUR_LGS', name: '采购物流员', roleType: 'BUSINESS', status: 'ENABLED', permissions: ['md:product:view', 'md:partner:view', 'pur:*', 'lgs:*', 'inv:stock:view', 'inv:txn:view', 'rtn:purchase:create', 'rtn:purchase:ship', 'rtn:claim:create', 'ap:bill:view'], fieldPolicies: { COST: 'WRITE' }, isTemplate: true },
    ].map((r) => ({ ...r, version: 1, createdAt: NOW, updatedAt: NOW })),
    userRoles: [
      { userId: 1, roleId: 11, countryId: 1 },
      { userId: 2, roleId: 13, countryId: 1 },
      { userId: 3, roleId: 14, countryId: 1 },
      { userId: 4, roleId: 15, countryId: 1 },
      { userId: 6, roleId: 17, countryId: 1 },
      { userId: 7, roleId: 16, countryId: 1 },
      { userId: 8, roleId: 18, countryId: 2 },
    ],
    dataScopes: [
      { id: 21, userId: 1, countryId: 1, scopeType: 'COUNTRY_ALL', scopeRefId: null, grantedBy: 1, effectiveFrom: '2026-09-01T00:00:00Z' },
      { id: 22, userId: 2, countryId: 1, scopeType: 'STORE', scopeRefId: 301, grantedBy: 1, effectiveFrom: '2026-09-01T00:00:00Z' },
      { id: 23, userId: 3, countryId: 1, scopeType: 'COUNTRY_ALL', scopeRefId: null, grantedBy: 1, effectiveFrom: '2026-09-01T00:00:00Z' },
      { id: 24, userId: 4, countryId: 1, scopeType: 'COUNTRY_ALL', scopeRefId: null, grantedBy: 1, effectiveFrom: '2026-09-01T00:00:00Z' },
      { id: 25, userId: 6, countryId: 1, scopeType: 'COUNTRY_ALL', scopeRefId: null, grantedBy: 1, effectiveFrom: '2026-09-01T00:00:00Z' },
      { id: 26, userId: 7, countryId: 1, scopeType: 'WAREHOUSE', scopeRefId: 401, grantedBy: 1, effectiveFrom: '2026-09-01T00:00:00Z' },
      { id: 27, userId: 8, countryId: 2, scopeType: 'COUNTRY_ALL', scopeRefId: null, grantedBy: 1, effectiveFrom: '2026-09-01T00:00:00Z' },
    ],
    countries: [
      {
        id: 1, code: 'MX', name: '墨西哥', status: 'ACTIVE', defaultCurrency: 'MXN', timezone: 'America/Mexico_City',
        locale: 'es-MX', dateFormat: 'DD/MM/YYYY', numberFormat: '1,234.56', isTest: false, enabledModules: ALL_MODULES,
        addressRule: { fields: ['street', 'colonia', 'municipio', 'estado', 'cp'], required: ['street', 'estado', 'cp'] },
        sourceCountryId: null, sourceTemplateVersionId: null, activatedAt: '2026-09-01T00:00:00Z', version: 1, createdAt: NOW, updatedAt: NOW,
      },
      {
        id: 2, code: 'CL', name: '智利（测试国）', status: 'ACTIVE', defaultCurrency: 'CLP', timezone: 'America/Santiago',
        locale: 'es-CL', dateFormat: 'DD/MM/YYYY', numberFormat: '1.234', isTest: true, enabledModules: ALL_MODULES,
        addressRule: { fields: ['street', 'comuna', 'ciudad', 'region'], required: ['street', 'ciudad'] },
        sourceCountryId: 1, sourceTemplateVersionId: 52, activatedAt: '2026-10-01T00:00:00Z', version: 1, createdAt: NOW, updatedAt: NOW,
      },
    ],
    templates: [
      { id: 51, sourceCountryId: 1, versionNo: 1, status: 'PUBLISHED', publishedAt: '2026-09-01T00:00:00Z', changeNote: '墨西哥一期上线配置', items: tplV1Items },
      { id: 52, sourceCountryId: 1, versionNo: 2, status: 'PUBLISHED', publishedAt: '2026-10-10T00:00:00Z', changeNote: '分类规则增加订单张数辅助指标；新增费用项目结构', items: tplV2Items },
    ],
    cloneJobs: [],
    reviews: [],
    upgrades: [],
    books: [
      { id: 61, countryId: 1, entityId: 201, code: 'MX-B01', name: '墨西哥主账套', baseCurrency: 'MXN', status: 'ACTIVE' },
      { id: 62, countryId: 2, entityId: 202, code: 'CL-B01', name: '智利主账套', baseCurrency: 'CLP', status: 'ACTIVE' },
    ],
    entities: [
      { id: 201, countryId: 1, code: 'MX-E01', name: '恒烁墨西哥贸易', legalName: 'Hengshuo Comercio México S.A. de C.V.', taxId: 'HCM2601019A1', status: 'ENABLED', version: 1, createdAt: NOW, updatedAt: NOW },
      { id: 202, countryId: 2, code: 'CL-E01', name: '恒烁智利贸易', legalName: 'Hengshuo Chile SpA', taxId: '76.000.111-2', status: 'ENABLED', version: 1, createdAt: NOW, updatedAt: NOW },
    ],
    warehouses: [
      { id: 401, countryId: 1, entityId: 201, code: 'MX-WH01', name: '墨西哥城中心仓', type: 'WAREHOUSE', storeId: null, timezone: '', address: 'Av. Industrial 120, Tlalnepantla, Edo. Méx.', status: 'ENABLED', version: 1, createdAt: NOW, updatedAt: NOW },
      { id: 402, countryId: 1, entityId: 201, code: 'MX-ST01-WH', name: '一号店门店仓', type: 'STORE', storeId: 301, timezone: '', address: 'Av. Insurgentes Sur 1500, CDMX', status: 'ENABLED', version: 1, createdAt: NOW, updatedAt: NOW },
      { id: 411, countryId: 2, entityId: 202, code: 'CL-WH01', name: '圣地亚哥中心仓', type: 'WAREHOUSE', storeId: null, timezone: '', address: 'Av. Apoquindo 3000, Santiago', status: 'ENABLED', version: 1, createdAt: NOW, updatedAt: NOW },
    ],
    stores: [
      { id: 301, countryId: 1, entityId: 201, code: 'MX-ST01', name: '墨西哥城一号店', defaultWarehouseId: 402, timezone: '', address: 'Av. Insurgentes Sur 1500, CDMX', status: 'ENABLED', openedAt: '2026-09-01', version: 1, createdAt: NOW, updatedAt: NOW },
      { id: 311, countryId: 2, entityId: 202, code: 'CL-ST01', name: '圣地亚哥一号店', defaultWarehouseId: 411, timezone: '', address: 'Av. Providencia 1200, Santiago', status: 'ENABLED', openedAt: '2026-10-01', version: 1, createdAt: NOW, updatedAt: NOW },
    ],
    categories: withIds([
      { code: 'ELEC', name: '电子配件', parentId: null, level: 1, status: 'ENABLED' },
      { code: 'HOME', name: '家居用品', parentId: null, level: 1, status: 'ENABLED' },
    ]),
    products: [],
    countrySkus: [],
    customerGroups: [
      { id: 501, countryId: 1, code: 'WHOLESALE', name: '批发客户', status: 'ENABLED', version: 1 },
      { id: 502, countryId: 1, code: 'RETAIL', name: '零售客户', status: 'ENABLED', version: 1 },
    ],
    customerLevels: [
      { id: 511, countryId: 1, code: 'A', name: 'A 级', seq: 1, status: 'ENABLED', version: 1 },
      { id: 512, countryId: 1, code: 'B', name: 'B 级', seq: 2, status: 'ENABLED', version: 1 },
    ],
    customers: [
      { id: 601, countryId: 1, code: 'C0001', name: 'Distribuidora del Norte', customerType: 'COMPANY', groupId: 501, levelId: 511, taxId: 'DNO190312AB1', phone: '+52 81 1234 5678', email: 'compras@dnorte.mx', salesOwnerId: 4, storeId: null, status: 'ENABLED', addresses: [{ contactName: 'Luis García', contactPhone: '+52 81 1234 5678', address: 'Av. Constitución 200, Monterrey, NL, 64000', isDefault: true }] },
      { id: 602, countryId: 1, code: 'C0002', name: 'Juan Pérez', customerType: 'PERSON', groupId: 502, levelId: 512, taxId: '', phone: '+52 55 8765 4321', email: '', salesOwnerId: 2, storeId: 301, status: 'ENABLED', addresses: [] },
      { id: 603, countryId: 1, code: 'C0003', name: 'Tienda La Esquina', customerType: 'COMPANY', groupId: 501, levelId: 512, taxId: 'TLE200101XY2', phone: '+52 55 2222 3333', email: '', salesOwnerId: 2, storeId: 301, status: 'ENABLED', addresses: [] },
      { id: 611, countryId: 2, code: 'C0001', name: 'Cliente Santiago', customerType: 'COMPANY', groupId: null, levelId: null, taxId: '', phone: '+56 2 2222 0000', email: '', salesOwnerId: 8, storeId: 311, status: 'ENABLED', addresses: [] },
    ].map((r) => ({ ...r, version: 1, createdAt: NOW, updatedAt: NOW })),
    partners: [
      { id: 701, countryId: 1, code: 'S0001', name: '深圳市联创电子有限公司', partnerType: 'SUPPLIER', locatedCountry: 'CN', contact: '陈先生', phone: '+86 755 8888 0001', settleCurrency: 'CNY', paymentTerms: '30% 预付，发货前付清', status: 'ENABLED', bankName: '招商银行深圳分行', accountName: '深圳市联创电子有限公司', accountNoMasked: '**** **** 3321' },
      { id: 702, countryId: 1, code: 'S0002', name: '义乌家居用品厂', partnerType: 'SUPPLIER', locatedCountry: 'CN', contact: '吴女士', phone: '+86 579 8888 0002', settleCurrency: 'CNY', paymentTerms: '月结 30 天', status: 'ENABLED', bankName: '', accountName: '', accountNoMasked: '' },
      { id: 703, countryId: 1, code: 'L0001', name: '中墨海运物流', partnerType: 'LOGISTICS', locatedCountry: 'CN', contact: '周经理', phone: '+86 20 8888 0003', settleCurrency: 'CNY', paymentTerms: '到港后 15 天', status: 'ENABLED', bankName: '', accountName: '', accountNoMasked: '' },
      { id: 704, countryId: 1, code: 'L0002', name: 'Logística Express MX', partnerType: 'LOGISTICS', locatedCountry: 'MX', contact: 'Ana López', phone: '+52 55 4444 5555', settleCurrency: 'MXN', paymentTerms: 'Neto 15', status: 'ENABLED', bankName: '', accountName: '', accountNoMasked: '' },
    ].map((r) => ({ ...r, version: 1, createdAt: NOW, updatedAt: NOW })),
    expenseItems: withIds([
      { countryId: 1, code: 'FRT-SEA', name: '海运费', feeCategory: 'FREIGHT_SEA', costTreatment: 'CAPITALIZE', defaultAllocBasis: 'VOLUME', status: 'ENABLED' },
      { countryId: 1, code: 'FRT-AIR', name: '空运费', feeCategory: 'FREIGHT_AIR', costTreatment: 'CAPITALIZE', defaultAllocBasis: 'WEIGHT', status: 'ENABLED' },
      { countryId: 1, code: 'CUSTOMS', name: '报关清关费', feeCategory: 'CUSTOMS', costTreatment: 'CAPITALIZE', defaultAllocBasis: 'VALUE', status: 'ENABLED' },
      { countryId: 1, code: 'TRANSSHIP', name: '换柜费', feeCategory: 'TRANSSHIP', costTreatment: 'CAPITALIZE', defaultAllocBasis: 'VOLUME', status: 'ENABLED' },
      { countryId: 1, code: 'DELIVERY', name: '当地派送费', feeCategory: 'DELIVERY', costTreatment: 'CAPITALIZE', defaultAllocBasis: 'QTY', status: 'ENABLED' },
      { countryId: 1, code: 'DEMURRAGE', name: '滞港费', feeCategory: 'DEMURRAGE', costTreatment: 'PERIOD_EXPENSE', defaultAllocBasis: 'MANUAL', status: 'ENABLED' },
      { countryId: 1, code: 'STORAGE', name: '仓储费', feeCategory: 'STORAGE', costTreatment: 'PERIOD_EXPENSE', defaultAllocBasis: 'MANUAL', status: 'ENABLED' },
    ]),
    currencies: [
      { id: 1, code: 'CNY', name: '人民币', symbol: '¥', decimals: 2 },
      { id: 2, code: 'MXN', name: '墨西哥比索', symbol: '$', decimals: 2 },
      { id: 3, code: 'USD', name: '美元', symbol: '$', decimals: 2 },
      { id: 4, code: 'COP', name: '哥伦比亚比索', symbol: '$', decimals: 2 },
      { id: 5, code: 'PEN', name: '秘鲁索尔', symbol: 'S/', decimals: 2 },
      { id: 6, code: 'CLP', name: '智利比索', symbol: '$', decimals: 0 },
    ],
    exchangeRates: [
      { id: 801, countryId: 1, fromCcy: 'CNY', toCcy: 'MXN', rate: 2.5123, rateDate: '2026-10-01', scope: 'PURCHASE_COST', versionNo: 1, status: 'CONFIRMED', createdBy: 3, confirmedBy: 1, confirmedAt: '2026-10-01T15:00:00Z' },
      { id: 802, countryId: 1, fromCcy: 'CNY', toCcy: 'MXN', rate: 2.5301, rateDate: '2026-10-15', scope: 'PURCHASE_COST', versionNo: 1, status: 'DRAFT', createdBy: 3, confirmedBy: null, confirmedAt: null },
      { id: 803, countryId: 1, fromCcy: 'CNY', toCcy: 'MXN', rate: 2.52, rateDate: '2026-10-01', scope: 'SETTLEMENT', versionNo: 1, status: 'CONFIRMED', createdBy: 3, confirmedBy: 1, confirmedAt: '2026-10-01T15:00:00Z' },
    ].map((r) => ({ ...r, version: 1, createdAt: NOW, updatedAt: NOW })),
    fundAccounts: [
      { id: 901, countryId: 1, entityId: 201, storeId: 301, accountType: 'CASH', currency: 'MXN', name: '一号店现金', bankName: '', accountNoMasked: '', glAccountId: null, status: 'ENABLED' },
      { id: 902, countryId: 1, entityId: 201, storeId: null, accountType: 'BANK', currency: 'MXN', name: 'BBVA 对公账户', bankName: 'BBVA México', accountNoMasked: '**** 5678', glAccountId: null, status: 'ENABLED' },
      { id: 911, countryId: 2, entityId: 202, storeId: 311, accountType: 'CASH', currency: 'CLP', name: '圣地亚哥现金', bankName: '', accountNoMasked: '', glAccountId: null, status: 'ENABLED' },
    ].map((r) => ({ ...r, version: 1, createdAt: NOW, updatedAt: NOW })),
    dicts: withIds([
      ...[['SALESPERSON', '业务员'], ['STORE', '门店']].map(([code, label], i) => ({ countryId: 1, dictType: 'SALES_SOURCE', code, label, seq: i + 1, status: 'ENABLED' })),
      ...[['QUALITY', '质量问题'], ['WRONG_ITEM', '发错货'], ['CUSTOMER_CHANGE', '客户原因'], ['DAMAGED_IN_TRANSIT', '运输破损']].map(([code, label], i) => ({ countryId: 1, dictType: 'RETURN_REASON', code, label, seq: i + 1, status: 'ENABLED' })),
      ...[['CUSTOMS_DOC', '清关资料不全'], ['WAREHOUSE_FULL', '仓库满仓'], ['PAYMENT_PENDING', '待付款放货']].map(([code, label], i) => ({ countryId: 1, dictType: 'HOLD_REASON', code, label, seq: i + 1, status: 'ENABLED' })),
      ...[['SHORT', '短少'], ['DAMAGED', '破损'], ['NOT_ARRIVED', '未到']].map(([code, label], i) => ({ countryId: 1, dictType: 'DISCREPANCY_REASON', code, label, seq: i + 1, status: 'ENABLED' })),
      ...[['CUSTOMER', '客户'], ['COMPANY', '公司'], ['LOGISTICS', '物流商'], ['SUPPLIER', '供应商']].map(([code, label], i) => ({ countryId: 1, dictType: 'RESPONSIBILITY', code, label, seq: i + 1, status: 'ENABLED' })),
    ]),
    auditLogs: [],
    attachments: [],
    approvalRules: [
      { id: 1101, ruleKey: 'R-SO-CREDIT', countryId: 1, docType: 'SALES_ORDER', name: '赊销大额订单', priority: 10, conditions: [{ field: 'amount', op: 'gte', value: 50000 }, { field: 'paymentType', op: 'eq', value: 'CREDIT' }], nodes: [{ seq: 1, nodeName: '业务负责人审批', approverType: 'ROLE', approverRef: 'BIZ_LEAD', mode: 'ANY' }, { seq: 2, nodeName: '财务复核', approverType: 'ROLE', approverRef: 'FINANCE', mode: 'ANY' }], versionNo: 2, status: 'ACTIVE', effectiveFrom: '2026-10-01' },
      { id: 1100, ruleKey: 'R-SO-CREDIT', countryId: 1, docType: 'SALES_ORDER', name: '赊销大额订单', priority: 10, conditions: [{ field: 'amount', op: 'gte', value: 80000 }, { field: 'paymentType', op: 'eq', value: 'CREDIT' }], nodes: [{ seq: 1, nodeName: '业务负责人审批', approverType: 'ROLE', approverRef: 'BIZ_LEAD', mode: 'ANY' }], versionNo: 1, status: 'RETIRED', effectiveFrom: '2026-09-01' },
      { id: 1102, ruleKey: 'R-SO-PRICE', countryId: 1, docType: 'SALES_ORDER', name: '人工改价', priority: 20, conditions: [{ field: 'manualPrice', op: 'eq', value: true }], nodes: [{ seq: 1, nodeName: '业务负责人审批', approverType: 'ROLE', approverRef: 'BIZ_LEAD', mode: 'ANY' }], versionNo: 1, status: 'ACTIVE', effectiveFrom: '2026-09-01' },
      { id: 1103, ruleKey: 'R-REFUND', countryId: 1, docType: 'REFUND', name: '退款审批', priority: 10, conditions: [], nodes: [{ seq: 1, nodeName: '财务审批', approverType: 'ROLE', approverRef: 'FINANCE', mode: 'ANY' }], versionNo: 1, status: 'ACTIVE', effectiveFrom: '2026-09-01' },
      { id: 1104, ruleKey: 'R-PO-LARGE', countryId: 1, docType: 'PURCHASE_ORDER', name: '大额采购单', priority: 10, conditions: [{ field: 'amount', op: 'gte', value: 200000 }], nodes: [{ seq: 1, nodeName: '业务负责人审批', approverType: 'ROLE', approverRef: 'BIZ_LEAD', mode: 'ANY' }], versionNo: 1, status: 'ACTIVE', effectiveFrom: '2026-09-01' },
      { id: 1105, ruleKey: 'R-STOCKTAKE', countryId: 1, docType: 'STOCKTAKE', name: '盘点差异审批', priority: 10, conditions: [], nodes: [{ seq: 1, nodeName: '财务复核差异', approverType: 'ROLE', approverRef: 'FINANCE', mode: 'ANY' }], versionNo: 1, status: 'ACTIVE', effectiveFrom: '2026-09-01' },
      { id: 1106, ruleKey: 'R-DISC-WO', countryId: 1, docType: 'DISCREPANCY_WRITE_OFF', name: '到货差异核销', priority: 10, conditions: [], nodes: [{ seq: 1, nodeName: '财务审批', approverType: 'ROLE', approverRef: 'FINANCE', mode: 'ANY' }], versionNo: 1, status: 'ACTIVE', effectiveFrom: '2026-09-01' },
      { id: 1107, ruleKey: 'R-SR', countryId: 1, docType: 'SALES_RETURN', name: '销售退货', priority: 10, conditions: [], nodes: [{ seq: 1, nodeName: '业务负责人审批', approverType: 'ROLE', approverRef: 'BIZ_LEAD', mode: 'ANY' }], versionNo: 1, status: 'ACTIVE', effectiveFrom: '2026-09-01' },
      { id: 1108, ruleKey: 'R-PR', countryId: 1, docType: 'PURCHASE_RETURN', name: '采购退货', priority: 10, conditions: [], nodes: [{ seq: 1, nodeName: '采购确认', approverType: 'ROLE', approverRef: 'PUR_LGS', mode: 'ANY' }], versionNo: 1, status: 'ACTIVE', effectiveFrom: '2026-09-01' },
    ].map((r) => ({ ...r, version: 1, createdAt: NOW, updatedAt: NOW })),
    docTypeConfigs: [
      { countryId: 1, docType: 'SALES_ORDER', approvalRequired: false, keyFields: ['customerId', 'lines.qty', 'lines.price', 'discount', 'paymentType', 'termDays', 'warehouseId'] },
      { countryId: 1, docType: 'PURCHASE_ORDER', approvalRequired: false, keyFields: ['supplierId', 'lines.qty', 'lines.unitPrice', 'paymentTerms'] },
      { countryId: 1, docType: 'REFUND', approvalRequired: true, keyFields: ['amount', 'payee', 'method'] },
      { countryId: 1, docType: 'STOCKTAKE', approvalRequired: true, keyFields: ['lines.diffQty'] },
      { countryId: 1, docType: 'SALES_RETURN', approvalRequired: true, keyFields: ['lines.qty', 'returnWarehouseId'] },
      { countryId: 1, docType: 'PURCHASE_RETURN', approvalRequired: true, keyFields: ['lines.qty'] },
      { countryId: 1, docType: 'TRANSFER', approvalRequired: false, keyFields: ['fromWarehouseId', 'toWarehouseId', 'lines.qty'] },
      { countryId: 1, docType: 'DISCREPANCY_WRITE_OFF', approvalRequired: true, keyFields: ['qty'] },
    ],
    approvalInstances: [
      { id: 1201, countryId: 1, docType: 'SALES_ORDER', docId: 5001, docNo: 'MX-SO-261015-0001', docTitle: 'Distribuidora del Norte · 赊销 · 30 天', amount: 86500, currency: 'MXN', ruleId: 1101, ruleName: '赊销大额订单', ruleVersionNo: 2, status: 'PENDING', submittedBy: 4, submittedAt: '2026-10-15T08:30:00Z' },
      { id: 1202, countryId: 1, docType: 'SALES_ORDER', docId: 5002, docNo: 'MX-SO-261014-0007', docTitle: 'Juan Pérez · 现款 · 人工改价 -8%', amount: 4280, currency: 'MXN', ruleId: 1102, ruleName: '人工改价', ruleVersionNo: 1, status: 'PENDING', submittedBy: 2, submittedAt: '2026-10-14T22:10:00Z' },
      { id: 1203, countryId: 1, docType: 'REFUND', docId: 6001, docNo: 'MX-RF-261013-0002', docTitle: 'Tienda La Esquina · 退货退款', amount: 1560, currency: 'MXN', ruleId: 1103, ruleName: '退款审批', ruleVersionNo: 1, status: 'APPROVED', submittedBy: 2, submittedAt: '2026-10-13T17:00:00Z' },
      { id: 1204, countryId: 1, docType: 'SALES_ORDER', docId: 5003, docNo: 'MX-SO-261012-0004', docTitle: 'Tienda La Esquina · 赊销', amount: 62000, currency: 'MXN', ruleId: 1101, ruleName: '赊销大额订单', ruleVersionNo: 2, status: 'INVALIDATED', invalidReason: '审批通过后 P0001 数量由 20 改为 25', submittedBy: 4, submittedAt: '2026-10-12T16:00:00Z' },
    ],
    approvalTasks: [
      { id: 1301, instanceId: 1201, nodeSeq: 1, nodeName: '业务负责人审批', assigneeId: 1, status: 'PENDING' },
      { id: 1302, instanceId: 1201, nodeSeq: 1, nodeName: '业务负责人审批', assigneeId: 4, status: 'PENDING' },
      { id: 1303, instanceId: 1202, nodeSeq: 1, nodeName: '业务负责人审批', assigneeId: 1, status: 'PENDING' },
      { id: 1304, instanceId: 1202, nodeSeq: 1, nodeName: '业务负责人审批', assigneeId: 4, status: 'PENDING' },
      { id: 1305, instanceId: 1203, nodeSeq: 1, nodeName: '财务审批', assigneeId: 1, status: 'APPROVED', comment: '与退货验收数量一致', actedAt: '2026-10-13T18:20:00Z' },
      { id: 1306, instanceId: 1204, nodeSeq: 1, nodeName: '业务负责人审批', assigneeId: 4, status: 'APPROVED', comment: '同意', actedAt: '2026-10-12T17:00:00Z' },
      { id: 1307, instanceId: 1204, nodeSeq: 2, nodeName: '财务复核', assigneeId: 3, status: 'APPROVED', comment: '额度充足', actedAt: '2026-10-12T18:00:00Z' },
    ],
    docWatchers: withIds([
      { countryId: 1, watchType: 'VIEWER', targetType: 'WAREHOUSE_RULE', docType: 'SALES_OUTBOUND', warehouseId: 401, userId: 4, fieldGroups: [], status: 'ENABLED' },
      { countryId: 1, watchType: 'CC', targetType: 'DOC_TYPE_RULE', docType: 'REFUND', warehouseId: null, userId: 1, fieldGroups: [], status: 'ENABLED' },
    ]),
    todos: withIds([
      { countryId: 1, todoType: 'PENDING_PAYMENT_CONFIRM', title: '转账待确认：Juan Pérez MXN 3,200.00', link: '/ar/receipts/confirm', perm: 'ar:receipt:confirm', status: 'OPEN', createdAt: '2026-10-15T07:40:00Z' },
      { countryId: 1, todoType: 'PENDING_PAYMENT_CONFIRM', title: '转账待确认：Tienda La Esquina MXN 12,450.00', link: '/ar/receipts/confirm', perm: 'ar:receipt:confirm', status: 'OPEN', createdAt: '2026-10-15T06:10:00Z' },
      { countryId: 1, todoType: 'PENDING_OUTBOUND', title: 'MX-SO-261015-0003 待出库（墨西哥城中心仓）', link: '/sales/outbounds', perm: 'sal:outbound:create', status: 'OPEN', createdAt: '2026-10-15T05:00:00Z' },
      { countryId: 1, todoType: 'OUTBOUND_BLOCKED', title: 'MX-SO-261014-0009 缺销售单据，出库被拦截', link: '/sales/orders', perm: 'sal:order:view', status: 'OPEN', createdAt: '2026-10-14T20:00:00Z' },
      { countryId: 1, todoType: 'OVERDUE_FOLLOWUP', title: 'Tienda La Esquina 应收逾期 12 天（MXN 8,900.00）', link: '/ar/receivables', perm: 'ar:receivable:view', status: 'OPEN', createdAt: '2026-10-15T00:00:00Z' },
      { countryId: 1, todoType: 'PENDING_VOUCHER_AUDIT', title: '2026-10 期间待审凭证 4 张', link: '/finance/vouchers', perm: 'fin:voucher:audit', status: 'OPEN', createdAt: '2026-10-15T02:00:00Z' },
    ]),
    notifications: withIds([
      { userId: 1, countryId: 1, notifyType: 'CC', title: 'MX-SO-261015-0001 已提交审批（抄送）', content: '王经理提交了赊销订单 MXN 86,500.00，抄送给你。打开单据时按你原有的数据范围校验。', link: '/approval/todo', readAt: null },
      { userId: 1, countryId: 1, notifyType: 'SYSTEM', title: '汇率 CNY→MXN（2026-10-15）待确认', content: '财务录入了新的采购成本汇率 2.5301，确认后才能用于成本确认。', link: '/master/exchange-rates', readAt: null },
      { userId: 3, countryId: 1, notifyType: 'APPROVAL_RESULT', title: 'MX-RF-261013-0002 退款审批已通过', content: '请登记实际支付信息。', link: '/approval/done', readAt: null },
    ]),
  }

  db.products = [
    { productCode: 'P0001', name: 'Type-C 数据线 1m', categoryId: db.categories[0].id, brand: 'HS', spec: '1m / 3A', baseUnit: '件', grossWeight: 0.05, volume: 0.0002, hsCode: '8544421100', units: [{ unit: '件', factorToBase: 1, isPurchaseDefault: false, isSalesDefault: true }, { unit: '箱', factorToBase: 50, isPurchaseDefault: true, isSalesDefault: false }], barcodes: [{ barcode: '6901234500011', unit: '件' }] },
    { productCode: 'P0002', name: '蓝牙耳机 TWS', categoryId: db.categories[0].id, brand: 'HS', spec: 'BT5.3', baseUnit: '件', grossWeight: 0.12, volume: 0.0006, hsCode: '8518300000', units: [{ unit: '件', factorToBase: 1, isPurchaseDefault: false, isSalesDefault: true }, { unit: '箱', factorToBase: 40, isPurchaseDefault: true, isSalesDefault: false }], barcodes: [{ barcode: '6901234500028', unit: '件' }] },
    { productCode: 'P0003', name: '不锈钢保温杯 500ml', categoryId: db.categories[1].id, brand: 'HS Home', spec: '500ml', baseUnit: '件', grossWeight: 0.35, volume: 0.0015, hsCode: '9617001100', units: [{ unit: '件', factorToBase: 1, isPurchaseDefault: false, isSalesDefault: true }, { unit: '箱', factorToBase: 24, isPurchaseDefault: true, isSalesDefault: false }], barcodes: [{ barcode: '6901234500035', unit: '件' }] },
    { productCode: 'P0004', name: 'LED 护眼台灯', categoryId: db.categories[1].id, brand: 'HS Home', spec: '10W', baseUnit: '件', grossWeight: 0.9, volume: 0.006, hsCode: '9405210000', units: [{ unit: '件', factorToBase: 1, isPurchaseDefault: true, isSalesDefault: true }], barcodes: [{ barcode: '6901234500042', unit: '件' }] },
  ].map((p) => ({ id: id(), status: 'ENABLED', version: 1, createdAt: NOW, updatedAt: NOW, barcodeText: p.barcodes.map((b) => b.barcode).join(' '), ...p }))

  db.countrySkus = db.products.map((p) => ({
    id: id(), countryId: 1, productId: p.id, localName: '', taxCategory: 'IVA16', status: 'ENABLED', version: 1,
  }))
  for (const p of db.products) {
    db.countrySkus.push({ id: id(), countryId: 2, productId: p.id, localName: '', taxCategory: 'IVA19', status: 'ENABLED', version: 1 })
  }
  for (const e of db.expenseItems.filter((x) => x.countryId === 1)) {
    db.expenseItems.push({ ...e, id: id(), countryId: 2 })
  }

  const chart = [
    { code: '1001', name: '库存现金', category: 'ASSET', direction: 'DEBIT', isCash: true, isBank: false, auxTypes: ['FUND'] },
    { code: '1002', name: '银行存款', category: 'ASSET', direction: 'DEBIT', isCash: false, isBank: true, auxTypes: ['FUND'] },
    { code: '1122', name: '应收账款', category: 'ASSET', direction: 'DEBIT', isCash: false, isBank: false, auxTypes: ['CUSTOMER'] },
    { code: '1405', name: '库存商品', category: 'ASSET', direction: 'DEBIT', isCash: false, isBank: false, auxTypes: ['PRODUCT'] },
    { code: '2202', name: '应付账款', category: 'LIABILITY', direction: 'CREDIT', isCash: false, isBank: false, auxTypes: ['PARTNER'] },
    { code: '2203', name: '预收账款', category: 'LIABILITY', direction: 'CREDIT', isCash: false, isBank: false, auxTypes: ['CUSTOMER'] },
    { code: '5001', name: '主营业务收入', category: 'INCOME', direction: 'CREDIT', isCash: false, isBank: false, auxTypes: [] },
    { code: '5401', name: '主营业务成本', category: 'COST', direction: 'DEBIT', isCash: false, isBank: false, auxTypes: [] },
    { code: '6601', name: '销售费用', category: 'EXPENSE', direction: 'DEBIT', isCash: false, isBank: false, auxTypes: [] },
  ]
  const accountIds: Record<number, Record<string, number>> = {}
  for (const book of db.books) {
    accountIds[book.id] = {}
    for (const a of chart) {
      const row = { id: id(), bookId: book.id, countryId: book.countryId, parentId: null, level: 1, isLeaf: true, fxEnabled: false, status: 'ENABLED', ...a }
      db.finAccounts.push(row)
      accountIds[book.id][a.code] = row.id
    }
    db.cashflowItems.push({ id: id(), bookId: book.id, countryId: book.countryId, code: 'CF-IN-SALES', name: '销售商品收到的现金', category: 'OPERATING', direction: 'IN' })
    for (const [no, start, end] of [[9, '2026-09-01', '2026-09-30'], [10, '2026-10-01', '2026-10-31']] as const) {
      db.finPeriods.push({ id: id(), bookId: book.id, countryId: book.countryId, fiscalYear: 2026, periodNo: no, startDate: start, endDate: end, status: 'OPEN' })
    }
    const linesFor = (eventType: string) => {
      if (eventType === 'SAL_OUTBOUND_CONFIRMED') {
        return [
          { direction: 'DEBIT', accountRule: { type: 'FIXED', code: '1122' }, amountExpr: 'amountExclTax', aux: 'CUSTOMER', summary: '销售出库' },
          { direction: 'CREDIT', accountRule: { type: 'FIXED', code: '5001' }, amountExpr: 'amountExclTax', aux: '', summary: '销售收入' },
          { direction: 'DEBIT', accountRule: { type: 'FIXED', code: '5401' }, amountExpr: 'cogsAmount', aux: '', summary: '结转成本' },
          { direction: 'CREDIT', accountRule: { type: 'FIXED', code: '1405' }, amountExpr: 'cogsAmount', aux: '', summary: '结转成本' },
        ]
      }
      if (eventType === 'AR_RECEIPT_CONFIRMED') {
        return [
          { direction: 'DEBIT', accountRule: { type: 'FUND' }, amountExpr: 'amount', aux: 'FUND', cashflowCode: 'CF-IN-SALES', summary: '收款' },
          { direction: 'CREDIT', accountRule: { type: 'FIXED', code: '2203' }, amountExpr: 'amount', aux: 'CUSTOMER', summary: '预收' },
        ]
      }
      return [
        { direction: 'DEBIT', accountRule: { type: 'FIXED', code: '6601' }, amountExpr: 'amount', aux: '', summary: '费用' },
        { direction: 'CREDIT', accountRule: { type: 'FIXED', code: '1002' }, amountExpr: 'amount', aux: '', cashflowCode: 'CF-IN-SALES', summary: '费用支付' },
      ]
    }
    for (const eventType of ['SAL_OUTBOUND_CONFIRMED', 'AR_RECEIPT_CONFIRMED', 'CST_EXPENSE_RECORDED']) {
      db.finMappings.push({
        id: id(), bookId: book.id, countryId: book.countryId, eventType, versionNo: 1, status: 'ACTIVE', lines: linesFor(eventType), reviewedBy: 1, reviewedAt: NOW,
      })
    }
    db.cstMethods.push({ id: id(), bookId: book.id, countryId: book.countryId, method: 'FIFO', status: 'ACTIVE', versionNo: 1 })
  }
  const cashMx = db.fundAccounts.find((f) => f.id === 901)
  const bankMx = db.fundAccounts.find((f) => f.id === 902)
  const cashCl = db.fundAccounts.find((f) => f.id === 911)
  if (cashMx) cashMx.glAccountId = accountIds[61]['1001']
  if (bankMx) bankMx.glAccountId = accountIds[61]['1002']
  if (cashCl) cashCl.glAccountId = accountIds[62]['1001']

  const cond = (label: string, priority: number, stockOp: string, stockValue: number, orderOp: string, orderValue: number) =>
    ({ id: id(), label, priority, stockOp, stockValue, stockValue2: 0, orderOp, orderValue, orderValue2: 0 })
  db.classifyRules.push({
    id: id(), countryId: 1, name: '墨西哥仓联合分类', dimType: 'WAREHOUSE', periodType: 'ROLLING_DAYS', periodDays: 90,
    orderMetric: 'QTY', stockMetric: 'AVAILABLE', versionNo: 1, status: 'ACTIVE', effectiveFrom: '2026-10-01',
    conditions: [
      cond('HOT_CANDIDATE', 1, 'LTE', 80, 'GTE', 30),
      cond('SLOW_CANDIDATE', 1, 'GTE', 200, 'LTE', 40),
      cond('WATCH', 2, 'GTE', 200, 'GTE', 80),
      cond('NORMAL', 9, 'ANY', 0, 'ANY', 0),
    ],
  })
  db.classifyRules.push({
    id: id(), countryId: 2, name: '智利仓联合分类', dimType: 'WAREHOUSE', periodType: 'ROLLING_DAYS', periodDays: 30,
    orderMetric: 'QTY', stockMetric: 'AVAILABLE', versionNo: 1, status: 'ACTIVE', effectiveFrom: '2026-10-01',
    conditions: [
      cond('HOT_CANDIDATE', 1, 'LTE', 20, 'GTE', 5),
      cond('NORMAL', 9, 'ANY', 0, 'ANY', 0),
    ],
  })

  db.auditLogs = [
    { id: id(), countryId: 1, userId: 3, userName: '财务 李会计', action: '新增', resourceType: 'exchange-rate', resourceId: 802, beforeValue: null, afterValue: { rate: 2.5301, rateDate: '2026-10-15', status: 'DRAFT' }, occurredAt: '2026-10-15T08:00:00Z' },
    { id: id(), countryId: 1, userId: 1, userName: '平台管理员', action: '确认', resourceType: 'exchange-rate', resourceId: 801, beforeValue: { status: 'DRAFT' }, afterValue: { status: 'CONFIRMED' }, occurredAt: '2026-10-01T15:00:00Z' },
  ]

  db.seq = seq + 1000
  return db
}

let current: Db | null = null
const seedHooks: (() => void)[] = []

/** 业务场景数据通过服务函数生成，保证数量与流水一致；在基础数据就绪后执行 */
export function onSeed(fn: () => void) {
  seedHooks.push(fn)
}

export function getDb(): Db {
  if (current) return current
  const raw = localStorage.getItem(STORAGE_KEY)
  current = raw ? (JSON.parse(raw) as Db) : seed()
  if (!raw) {
    for (const fn of seedHooks) fn()
    saveDb()
  }
  return current
}

export function snapshotDb() {
  return JSON.stringify(getDb())
}

/** 写请求失败时整体回滚，模拟数据库事务 */
export function restoreDb(snapshot: string) {
  current = JSON.parse(snapshot) as Db
}

export function saveDb() {
  if (current) localStorage.setItem(STORAGE_KEY, JSON.stringify(current))
}

export function resetDb() {
  localStorage.removeItem(STORAGE_KEY)
  current = null
}

export function nextId() {
  const db = getDb()
  db.seq += 1
  return db.seq
}

export function nowIso() {
  return new Date().toISOString()
}
