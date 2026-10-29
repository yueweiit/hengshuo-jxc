import type { RouteRecordRaw } from 'vue-router'

declare module 'vue-router' {
  interface RouteMeta {
    /** i18n key */
    title?: string
    icon?: string
    /** 进入页面所需权限码，任一满足即可 */
    perm?: string | string[]
    hidden?: boolean
    /** 占位页：所属开发批次与设计文档 */
    batch?: number
    doc?: string
    desc?: string[]
    /** 是否适配手机端 */
    mobile?: boolean
    /** 国家启用模块，未启用时菜单隐藏 */
    module?: string
    /** 隐藏的详情页高亮哪个菜单 */
    activeMenu?: string
  }
}

const page = (path: string, component: RouteRecordRaw['component'], meta: RouteRecordRaw['meta']): RouteRecordRaw =>
  ({ path, component, meta }) as RouteRecordRaw

export interface MenuGroup {
  key: string
  title: string
  icon: string
  module?: string
  children: RouteRecordRaw[]
}

/** 一期导航（PRD 第 15 章），基础档案单独成组 */
export const menuGroups: MenuGroup[] = [
  {
    key: 'workbench',
    title: 'menu.group.workbench',
    icon: 'Odometer',
    children: [
      { path: '/workbench', component: () => import('@/modules/workbench/WorkbenchView.vue'), meta: { title: 'menu.workbench', mobile: true } },
      { path: '/approval/todo', component: () => import('@/modules/approval/ApprovalTaskList.vue'), props: { mode: 'todo' }, meta: { title: 'menu.approvalTodo', mobile: true } },
      { path: '/approval/done', component: () => import('@/modules/approval/ApprovalTaskList.vue'), props: { mode: 'done' }, meta: { title: 'menu.approvalDone', mobile: true } },
      { path: '/notifications', component: () => import('@/modules/workbench/NotificationList.vue'), meta: { title: 'menu.notifications', mobile: true } },
      page('/jobs', () => import('@/modules/workbench/JobList.vue'), { title: 'menu.jobs', perm: ['sys:export:view', 'fin:report:export'] }),
    ],
  },
  {
    key: 'purchase',
    title: 'menu.group.purchase',
    icon: 'Ship',
    module: 'pur',
    children: [
      page('/purchase/orders', () => import('@/modules/purchase/PurchaseOrderList.vue'), { title: 'menu.purchaseOrders', perm: 'pur:order:view' }),
      page('/purchase/orders/import', () => import('@/modules/purchase/PurchaseOrderImport.vue'), { title: 'menu.purchaseOrderImport', perm: 'pur:order:create', hidden: true, activeMenu: '/purchase/orders' }),
      page('/purchase/orders/:id', () => import('@/modules/purchase/PurchaseOrderDetail.vue'), { title: 'menu.purchaseOrderDetail', perm: 'pur:order:view', hidden: true, activeMenu: '/purchase/orders' }),
      page('/purchase/domestic-receipts', () => import('@/modules/purchase/DomesticReceiptList.vue'), { title: 'menu.domesticReceipts', perm: ['pur:receipt:create', 'pur:receipt:confirm'], mobile: true }),
      page('/purchase/export-nodes', () => import('@/modules/purchase/ExportNodeList.vue'), { title: 'menu.exportNodes', perm: ['pur:export:create', 'pur:export:confirm'] }),
      page('/logistics/shipments', () => import('@/modules/logistics/ShipmentList.vue'), { title: 'menu.shipments', perm: 'lgs:shipment:view' }),
      page('/logistics/shipments/:id', () => import('@/modules/logistics/ShipmentDetail.vue'), { title: 'menu.shipmentDetail', perm: 'lgs:shipment:view', hidden: true, activeMenu: '/logistics/shipments', mobile: true }),
      page('/logistics/holds', () => import('@/modules/logistics/HoldList.vue'), { title: 'menu.holds', perm: ['lgs:hold:create', 'lgs:hold:release'] }),
      page('/logistics/deliveries', () => import('@/modules/logistics/DeliveryList.vue'), { title: 'menu.deliveries', perm: ['lgs:delivery:create', 'lgs:delivery:dispatch'] }),
      page('/logistics/receipts', () => import('@/modules/logistics/LgsReceiptList.vue'), { title: 'menu.lgsReceipts', perm: 'lgs:receipt:confirm', mobile: true }),
      page('/logistics/receipts/:id', () => import('@/modules/logistics/LgsReceiptForm.vue'), { title: 'menu.lgsReceiptForm', perm: 'lgs:receipt:confirm', hidden: true, activeMenu: '/logistics/receipts', mobile: true }),
      page('/logistics/discrepancies', () => import('@/modules/logistics/DiscrepancyList.vue'), { title: 'menu.discrepancies', perm: ['lgs:discrepancy:handle', 'lgs:shipment:view'] }),
      page('/logistics/fees', () => import('@/modules/logistics/LgsFeeList.vue'), { title: 'menu.lgsFees', perm: ['lgs:fee:create', 'lgs:fee:confirm'] }),
      page('/logistics/in-transit', () => import('@/modules/logistics/InTransitBoard.vue'), { title: 'menu.inTransit', perm: 'lgs:shipment:view' }),
    ],
  },
  {
    key: 'inventory',
    title: 'menu.group.inventory',
    icon: 'Box',
    module: 'inv',
    children: [
      page('/inventory/stocks', () => import('@/modules/inventory/StockList.vue'), { title: 'menu.stocks', perm: 'inv:stock:view', mobile: true }),
      page('/inventory/txns', () => import('@/modules/inventory/StockTxnList.vue'), { title: 'menu.stockTxns', perm: 'inv:txn:view' }),
      page('/inventory/freezes', () => import('@/modules/inventory/FreezeList.vue'), { title: 'menu.freezes', perm: ['inv:freeze:create', 'inv:freeze:release'] }),
      page('/inventory/transfers', () => import('@/modules/inventory/TransferList.vue'), { title: 'menu.transfers', perm: ['inv:transfer:create', 'inv:transfer:ship', 'inv:transfer:receive'], mobile: true }),
      page('/inventory/stocktakes', () => import('@/modules/inventory/StocktakeList.vue'), { title: 'menu.stocktakes', perm: ['inv:stocktake:create', 'inv:stocktake:count', 'inv:stocktake:approve'], mobile: true }),
      page('/inventory/limits', () => import('@/modules/inventory/StockLimitList.vue'), { title: 'menu.stockLimits', perm: 'inv:limit:config' }),
      page('/inventory/alerts', () => import('@/modules/inventory/StockAlertList.vue'), { title: 'menu.stockAlerts', perm: 'inv:stock:view' }),
      page('/inventory/analysis', () => import('@/modules/inventory/AnalysisView.vue'), { title: 'menu.stockAnalysis', perm: 'inv:classify:view' }),
      page('/inventory/classify-rules', () => import('@/modules/inventory/ClassifyRuleList.vue'), { title: 'menu.classifyRules', perm: 'inv:classify:config' }),
      page('/inventory/replenishments', () => import('@/modules/inventory/ReplenishmentList.vue'), { title: 'menu.replenishments', perm: ['inv:replenish:create', 'inv:replenish:decide'], mobile: true }),
    ],
  },
  {
    key: 'sales',
    title: 'menu.group.sales',
    icon: 'ShoppingCart',
    module: 'sal',
    children: [
      page('/sales/orders', () => import('@/modules/sales/SalesOrderList.vue'), { title: 'menu.salesOrders', perm: 'sal:order:view', mobile: true }),
      page('/sales/orders/:id', () => import('@/modules/sales/SalesOrderDetail.vue'), { title: 'menu.salesOrderDetail', perm: 'sal:order:view', hidden: true, activeMenu: '/sales/orders', mobile: true }),
      page('/sales/outbounds', () => import('@/modules/sales/OutboundList.vue'), { title: 'menu.outbounds', perm: ['sal:outbound:create', 'sal:outbound:confirm', 'sal:order:view'], mobile: true }),
      page('/sales/signs', () => import('@/modules/sales/SignList.vue'), { title: 'menu.signs', perm: ['sal:sign:record', 'sal:order:view'], mobile: true }),
      page('/sales/prices', () => import('@/modules/sales/PriceList.vue'), { title: 'menu.prices', perm: 'sal:price:view' }),
      page('/store/daily', () => import('@/modules/sales/StoreDaily.vue'), { title: 'menu.storeDaily', perm: 'sal:order:view', mobile: true }),
    ],
  },
  {
    key: 'partners',
    title: 'menu.group.partners',
    icon: 'Wallet',
    children: [
      page('/ar/receipts', () => import('@/modules/ar/ReceiptList.vue'), { title: 'menu.arReceipts', perm: ['ar:receipt:create', 'ar:receipt:confirm', 'ar:receivable:view'], mobile: true }),
      page('/ar/receipts/confirm', () => import('@/modules/ar/ReceiptList.vue'), { title: 'menu.arReceiptConfirm', perm: 'ar:receipt:confirm' }),
      page('/ar/credit-rules', () => import('@/modules/ar/CreditRuleList.vue'), { title: 'menu.creditRules', perm: ['ar:credit-rule:view', 'ar:credit-rule:edit'] }),
      page('/ar/receivables', () => import('@/modules/ar/ReceivableList.vue'), { title: 'menu.receivables', perm: 'ar:receivable:view' }),
      page('/ar/writeoffs', () => import('@/modules/ar/WriteoffList.vue'), { title: 'menu.arWriteoffs', perm: ['ar:writeoff:create', 'ar:receivable:view'] }),
      page('/ar/statements', () => import('@/modules/ar/StatementList.vue'), { title: 'menu.arStatements', perm: 'ar:statement:view' }),
      page('/ar/customers/:id', () => import('@/modules/ar/CustomerLedger.vue'), { title: 'menu.customerLedger', perm: ['ar:receivable:view', 'sal:order:view'], hidden: true, activeMenu: '/ar/receivables' }),
      page('/ap/bills', () => import('@/modules/ap/ApBillList.vue'), { title: 'menu.apBills', perm: 'ap:bill:view' }),
      page('/ap/payments', () => import('@/modules/ap/ApPaymentList.vue'), { title: 'menu.apPayments', perm: ['ap:payment:create', 'ap:bill:view'] }),
      page('/ap/prepayments', () => import('@/modules/ap/ApPrepaymentList.vue'), { title: 'menu.apPrepayments', perm: ['ap:prepayment:create', 'ap:bill:view'] }),
      page('/ap/settlements', () => import('@/modules/ap/ApSettlementList.vue'), { title: 'menu.apSettlements', perm: ['ap:settlement:create', 'ap:bill:view'] }),
      page('/ap/partners/:id', () => import('@/modules/ap/PartnerLedger.vue'), { title: 'menu.partnerLedger', perm: 'ap:bill:view', hidden: true, activeMenu: '/ap/bills' }),
      page('/returns/sales', () => import('@/modules/returns/SalesReturnList.vue'), { title: 'menu.salesReturns', perm: ['rtn:sales:create', 'rtn:sales:receive', 'rtn:sales:settle'], mobile: true }),
      page('/returns/refunds', () => import('@/modules/returns/RefundList.vue'), { title: 'menu.refunds', perm: ['rtn:refund:create', 'rtn:refund:pay'] }),
      page('/returns/purchase', () => import('@/modules/returns/PurchaseReturnList.vue'), { title: 'menu.purchaseReturns', perm: ['rtn:purchase:create', 'rtn:purchase:ship'] }),
      page('/returns/claims', () => import('@/modules/returns/ClaimList.vue'), { title: 'menu.claims', perm: 'rtn:claim:create' }),
    ],
  },
  {
    key: 'cost',
    title: 'menu.group.cost',
    icon: 'TrendCharts',
    module: 'cst',
    children: [
      page('/cost/inbound', () => import('@/modules/cost/InboundCostList.vue'), { title: 'menu.inboundCosts', perm: 'cst:cost:view' }),
      page('/cost/allocations', () => import('@/modules/cost/AllocationList.vue'), { title: 'menu.allocations', perm: 'cst:allocation:create' }),
      page('/cost/adjustments', () => import('@/modules/cost/AdjustmentList.vue'), { title: 'menu.costAdjustments', perm: 'cst:adjustment:create' }),
      page('/cost/expenses', () => import('@/modules/cost/ExpenseList.vue'), { title: 'menu.expenses', perm: 'cst:expense:create' }),
      page('/analysis/profit', () => import('@/modules/analysis/ProfitView.vue'), { title: 'menu.profit', perm: 'cst:profit:view' }),
      page('/analysis/ai', () => import('@/modules/analysis/AiView.vue'), { title: 'menu.aiAnalysis', perm: 'ai:analysis:use' }),
    ],
  },
  {
    key: 'finance',
    title: 'menu.group.finance',
    icon: 'Notebook',
    module: 'fin',
    children: [
      page('/finance/books', () => import('@/modules/finance/BookList.vue'), { title: 'menu.books', perm: 'fin:book:config' }),
      page('/finance/accounts', () => import('@/modules/finance/AccountList.vue'), { title: 'menu.accounts', perm: 'fin:account:edit' }),
      page('/finance/opening', () => import('@/modules/finance/OpeningList.vue'), { title: 'menu.opening', perm: 'fin:opening:edit' }),
      page('/finance/mappings', () => import('@/modules/finance/MappingList.vue'), { title: 'menu.mappings', perm: 'fin:mapping:edit' }),
      page('/finance/events', () => import('@/modules/finance/EventList.vue'), { title: 'menu.finEvents', perm: 'fin:voucher:generate' }),
      page('/finance/vouchers', () => import('@/modules/finance/VoucherList.vue'), { title: 'menu.vouchers', perm: ['fin:voucher:create', 'fin:voucher:audit', 'fin:ledger:view'] }),
      page('/finance/ledgers', () => import('@/modules/finance/LedgerView.vue'), { title: 'menu.ledgers', perm: 'fin:ledger:view' }),
      page('/finance/trial-balance', () => import('@/modules/finance/TrialView.vue'), { title: 'menu.trialBalance', perm: 'fin:ledger:view' }),
      page('/finance/reconcile', () => import('@/modules/finance/ReconcileView.vue'), { title: 'menu.reconcile', perm: 'fin:ledger:view' }),
      page('/finance/closing', () => import('@/modules/finance/ClosingView.vue'), { title: 'menu.closing', perm: ['fin:period:close', 'fin:period:reopen'] }),
      page('/finance/reports', () => import('@/modules/finance/ReportView.vue'), { title: 'menu.finReports', perm: 'fin:report:view' }),
    ],
  },
  {
    key: 'master',
    title: 'menu.group.master',
    icon: 'Files',
    children: [
      { path: '/master/products', component: () => import('@/modules/master/ProductList.vue'), meta: { title: 'menu.products', perm: 'md:product:view', mobile: true } },
      { path: '/master/country-skus', component: () => import('@/modules/master/CountrySkuList.vue'), meta: { title: 'menu.countrySkus', perm: 'md:country-sku:edit' } },
      { path: '/master/customers', component: () => import('@/modules/master/CustomerList.vue'), meta: { title: 'menu.customers', perm: 'md:customer:view', mobile: true } },
      { path: '/master/customer-groups', component: () => import('@/modules/master/CustomerGroupList.vue'), meta: { title: 'menu.customerGroups', perm: 'md:customer:edit' } },
      { path: '/master/partners', component: () => import('@/modules/master/PartnerList.vue'), meta: { title: 'menu.partners', perm: 'md:partner:view' } },
      { path: '/master/expense-items', component: () => import('@/modules/master/ExpenseItemList.vue'), meta: { title: 'menu.expenseItems', perm: 'md:expense-item:edit' } },
      { path: '/master/exchange-rates', component: () => import('@/modules/master/ExchangeRateList.vue'), meta: { title: 'menu.exchangeRates', perm: ['md:rate:edit', 'md:rate:confirm'] } },
      { path: '/master/fund-accounts', component: () => import('@/modules/master/FundAccountList.vue'), meta: { title: 'menu.fundAccounts', perm: 'md:fund-account:edit' } },
      { path: '/master/dicts', component: () => import('@/modules/master/DictList.vue'), meta: { title: 'menu.dicts', perm: 'md:dict:edit' } },
    ],
  },
  {
    key: 'settings',
    title: 'menu.group.settings',
    icon: 'Setting',
    children: [
      { path: '/settings/external-services', component: () => import('@/modules/settings/integrations/ExternalServiceSettings.vue'), meta: { title: 'menu.externalServices', perm: 'sys:integration:config' } },
      { path: '/settings/countries', component: () => import('@/modules/settings/country/CountryList.vue'), meta: { title: 'menu.countries', perm: 'sys:country:view' } },
      { path: '/settings/countries/clone', component: () => import('@/modules/settings/country/CountryCloneWizard.vue'), meta: { title: 'menu.countryClone', perm: 'sys:country:create', hidden: true } },
      { path: '/settings/countries/:id', component: () => import('@/modules/settings/country/CountryDetail.vue'), meta: { title: 'menu.countryDetail', perm: 'sys:country:view', hidden: true } },
      { path: '/settings/templates', component: () => import('@/modules/settings/country/TemplateList.vue'), meta: { title: 'menu.templates', perm: 'sys:template:publish' } },
      { path: '/settings/entities', component: () => import('@/modules/settings/org/EntityList.vue'), meta: { title: 'menu.entities', perm: 'org:entity:edit' } },
      { path: '/settings/warehouses', component: () => import('@/modules/settings/org/WarehouseList.vue'), meta: { title: 'menu.warehouses', perm: 'org:warehouse:edit' } },
      { path: '/settings/stores', component: () => import('@/modules/settings/org/StoreList.vue'), meta: { title: 'menu.stores', perm: 'org:store:edit' } },
      { path: '/settings/users', component: () => import('@/modules/settings/perm/UserList.vue'), meta: { title: 'menu.users', perm: 'sys:user:edit' } },
      { path: '/settings/roles', component: () => import('@/modules/settings/perm/RoleList.vue'), meta: { title: 'menu.roles', perm: 'sys:role:edit' } },
      { path: '/settings/approval-rules', component: () => import('@/modules/settings/perm/ApprovalRuleList.vue'), meta: { title: 'menu.approvalRules', perm: 'wf:rule:edit' } },
      { path: '/settings/doc-watchers', component: () => import('@/modules/settings/perm/DocWatcherList.vue'), meta: { title: 'menu.docWatchers', perm: 'sys:watcher:edit' } },
      { path: '/settings/audit-logs', component: () => import('@/modules/settings/AuditLogList.vue'), meta: { title: 'menu.auditLogs', perm: 'sys:audit:view' } },
      page('/settings/imports', () => import('@/modules/settings/ImportCenter.vue'), { title: 'menu.imports', perm: 'sys:import:confirm' }),
    ],
  },
]

export const routes: RouteRecordRaw[] = [
  { path: '/login', component: () => import('@/modules/auth/LoginView.vue'), meta: { title: 'menu.login' } },
  {
    path: '/',
    component: () => import('@/layouts/PcLayout.vue'),
    redirect: '/workbench',
    children: [
      ...menuGroups.flatMap((g) => g.children.map((r) => ({ ...r, meta: { ...r.meta, module: r.meta?.module ?? g.module } }) as RouteRecordRaw)),
      { path: '/403', component: () => import('@/modules/error/ForbiddenView.vue'), meta: { title: 'menu.forbidden', hidden: true } },
    ],
  },
  { path: '/:pathMatch(.*)*', component: () => import('@/modules/error/NotFoundView.vue'), meta: { title: 'menu.notFound' } },
]
