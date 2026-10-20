# 发布闭环 A01–A38 验收追踪

依据 [原始验收矩阵](../99-验收用例追踪矩阵.md)。本文件映射真实实现与可执行场景；**已留存部分原页面操作记录，最终同制品、同前端源码的双国 50 项重验尚未完成，不能宣称发布验收通过**。自动化场景是局部证据，必须补齐原用例的全部验证点。111 项 Mock 检查、历史 M4/M5 查询检查、接口测试、当前部署健康互不替代。

机器记录见 [closure-acceptance.json](evidence/closure-acceptance.json)。每条保留原始规则、真实类、精确测试方法、页面动作及空白验收证据栏；本文件不修改既有 M4/M5 统计脚本或验证格式。

## 记录方式

每个国家、操作者独立记录当前构建 SHA/制品哈希、真实页面 URL、动作、单据与凭证编号、期末数量和金额、截图/下载物及结果。前置 SQL/API 只可准备基础配置与合成账号，需单独列出，不能计作页面写入。第二国家 A37 使用同一场景参数化复用，不能复制业务代码。未完成或缺依据明确记未执行/阻塞。

## 逐项落点与页面动作

### A01 中国采购与国内节点

原规则：部分国内交付和出口登记后，`inv_stock_txn` 没有新增流水，`inv_stock_summary` 不变

实现：`jxc-server/jxc-module-pur/src/main/java/com/hs/jxc/pur/PurchaseService.java`。场景：`SupplyLogisticsIT#originalCurrencyAndServerUnitConversionSurviveAndDomesticDoesNotWriteInventory`（最终冻结制品逐方法 PostgreSQL 集成验证通过；不等于整项页面通过）。

页面：/purchase/orders/:id。执行：创建CNY采购 → 审批 → 部分国内收货 → 出口；记录前后MX库存与原币价。

状态：真实页面未执行；操作者、单据/凭证、期末数量金额及证据待记录。

### A02 发运与运输方式

原规则：海运和空运都能发运；发运后在途增加，可售数量不变；目的国、目的仓取自配置

实现：`jxc-server/jxc-module-lgs/src/main/java/com/hs/jxc/lgs/LogisticsService.java`。场景：`SupplyLogisticsIT#duplicateDomesticExportAndShipmentSourcesAreRejectedBeforeWriting`（最终冻结制品逐方法 PostgreSQL 集成验证通过；不等于整项页面通过）。

页面：/logistics/shipments/:id、/inventory/stocks。执行：分别创建海运/空运 → 发运；核对配置目的仓、在途增加、可售不变。

状态：真实页面未执行；操作者、单据/凭证、期末数量金额及证据待记录。

### A03 换柜与暂缓派送

原规则：`lgs_container` 保留原柜和新柜；暂缓记录有原因、责任人、费用；恢复后可以部分派送

实现：`jxc-server/jxc-module-lgs/src/main/java/com/hs/jxc/lgs/LogisticsService.java`。场景：`SupplyLogisticsIT#transshipDifferenceAndPartialHoldReleaseKeepEveryTransitBucketNonnegativeAndConserved`（最终冻结制品逐方法 PostgreSQL 集成验证通过；不等于整项页面通过）。

页面：/logistics/shipments/:id、/logistics/holds。执行：登记换柜 → 暂缓原因责任人费用 → 部分解除 → 部分派送；保留原柜。

状态：真实页面未执行；操作者、单据/凭证、期末数量金额及证据待记录。

### A04 MX 部分实收

原规则：派送 50 件，实收 48 件：库存只加 48 件，`lgs_discrepancy` 有 2 件短缺且状态为 OPEN

实现：`jxc-server/jxc-module-lgs/src/main/java/com/hs/jxc/lgs/LogisticsService.java`。场景：`SupplyLogisticsIT#receiptConservesFourQuantitiesAndConcurrentSameKeyCreatesOneBatchAndOneCost`（最终冻结制品逐方法 PostgreSQL 集成验证通过；不等于整项页面通过）。

页面：/logistics/receipts/:id。执行：派送50 → 实收48 → 确认；核对库存48及短缺2 OPEN。

状态：真实页面未执行；操作者、单据/凭证、期末数量金额及证据待记录。

### A05 内部代录

原规则：业务员和门店都能录 MXN 订单；系统没有客户账号、商城、营销活动单

实现：`jxc-server/jxc-module-sal/src/main/java/com/hs/jxc/sal/SalesService.java`。场景：`SalesIT#createOrderResolvesServerPriceAndDoesNotCreateReceivable`（已观察局部聚焦通过；不等于整项通过）。

页面：/sales/orders/new。执行：业务员和门店账号分别创建MXN销售草稿；确认内部代录入口。

状态：真实页面未执行；操作者、单据/凭证、期末数量金额及证据待记录。

### A06 单店与新增门店

原规则：新增第 2 家门店后，可以独立配置仓库、账号、收款账户和数据范围；第 1 家门店的人员看不到第 2 家门店的单据

实现：`jxc-server/jxc-module-sys/src/main/java/com/hs/jxc/org/OrgService.java`。场景：`FoundationIT#storeCreationIsAtomicAndSameIntentReplaysWithoutMoreWarehouses`（最终冻结制品逐方法 PostgreSQL 集成验证通过；不等于整项页面通过）。

页面：/settings/stores。执行：新增第二门店、仓、账号及收款账户 → 分配范围 → 两店互相访问应拒绝。

状态：真实页面未执行；操作者、单据/凭证、期末数量金额及证据待记录。

### A07 出库前附件

原规则：缺销售单据时返回 `SAL_ATTACHMENT_MISSING`；现款缺收款凭证或未确认足额到账时返回 `SAL_PAYMENT_NOT_CONFIRMED`；删除附件后再次拦截

实现：`jxc-server/jxc-module-sal/src/main/java/com/hs/jxc/sal/SalesService.java`。场景：`SalesIT#cashMustBeConfirmedAndSalesDocumentMustRemainValidAtConfirmation`（已观察局部聚焦通过；不等于整项通过）。

页面：/sales/orders/:id。执行：缺销售附件出库失败 → 现款未足额到账失败 → 补齐 → 删除附件后再次失败。

状态：真实页面未执行；操作者、单据/凭证、期末数量金额及证据待记录。

### A08 赊销附件

原规则：赊销有销售单据和有效审批依据时可以出库，不要求收款凭证；回款后上传凭证并核销

实现：`jxc-server/jxc-module-sal/src/main/java/com/hs/jxc/sal/SalesService.java`。场景：`SalesIT#approvalReservesThenActualPartialOutboundCreatesOnlyActualReceivableAndCogs`（已观察局部聚焦通过；不等于整项通过）。

页面：/sales/orders/:id、/ar/writeoffs。执行：赊销附单据审批 → 不上传收款凭证出库 → 后续到账凭证及核销。

状态：真实页面未执行；操作者、单据/凭证、期末数量金额及证据待记录。

### A09 用户配置授信

原规则：授权人员可以修改资格、额度、账期、逾期策略，修改生成新版本；没有 `ar:credit-rule:edit` 的用户返回 403

实现：`jxc-server/jxc-module-ar/src/main/java/com/hs/jxc/ar/ReceivablesService.java`。场景：`ReceivablesIT#customerCreditGateIsSharedAcrossBooks`（最终冻结制品逐方法 PostgreSQL 集成验证通过；不等于整项页面通过）。

页面：/ar/credit-rules。执行：修改授信资格额度账期逾期策略 → 核对新版本 → 无编辑权限账号403。

状态：真实页面未执行；操作者、单据/凭证、期末数量金额及证据待记录。

### A10 出库生成应收

原规则：订单 20 件只出库 8 件：应收只对应 8 件的金额，不需要等签收；订单未交数量为 12 件

实现：`jxc-server/jxc-module-sal/src/main/java/com/hs/jxc/sal/SalesService.java`。场景：`SalesIT#approvalReservesThenActualPartialOutboundCreatesOnlyActualReceivableAndCogs`（已观察局部聚焦通过；不等于整项通过）。

页面：/sales/orders/:id、/ar/receivables。执行：订单20审批 → 出库8 → 核对应收只含8、未交12、尚未签收。

状态：真实页面未执行；操作者、单据/凭证、期末数量金额及证据待记录。

### A11 现款预收核销

原规则：先确认足额收款，出库生成应收后自动核销；应收余额为 0，现金只记录一次，预收余额正确

实现：`jxc-server/jxc-module-ar/src/main/java/com/hs/jxc/ar/ReceivablesService.java`。场景：`SalesIT#cashMustBeConfirmedAndSalesDocumentMustRemainValidAtConfirmation`（已观察局部聚焦通过；不等于整项通过）。

页面：/ar/customers/:id。执行：现款足额到账 → 出库 → 自动核销 → 应收0且资金事实只一次。

状态：真实页面未执行；操作者、单据/凭证、期末数量金额及证据待记录。

### A12 信用预占转换

原规则：审批后有预占；出库后预占转为应收占用，已用额度不变；取消未交部分释放对应预占

实现：`jxc-server/jxc-module-ar/src/main/java/com/hs/jxc/ar/ReceivablesService.java`。场景：`SalesIT#keyEditReleasesOldReservationAndReapprovalUsesNewGeneration`（已观察局部聚焦通过；不等于整项通过）。

页面：/ar/customers/:id。执行：审批后查看信用预占 → 部分出库转换 → 取消未交 → 核对释放与已用额度。

状态：真实页面未执行；操作者、单据/凭证、期末数量金额及证据待记录。

### A13 权限上线后分配

原规则：新账号看不到任何业务数据；分配 MX 仓或门店后，页面、附件、导出、AI 取数同步遵守

实现：`jxc-server/jxc-module-sys/src/main/java/com/hs/jxc/sys/service/AuthorizationService.java`。场景：`AuthorizationIT#functionWildcardNeverGrantsDataScope`（最终冻结制品逐方法 PostgreSQL 集成验证通过；不等于整项页面通过）。

页面：/settings/users、/workbench。执行：新建账号无范围 → 列表空 → 授仓/店 → 页面附件导出AI一致 → 撤销后再读。

状态：真实页面未执行；操作者、单据/凭证、期末数量金额及证据待记录。

### A14 看单、抄送、审批

原规则：抄送人打开单据仍按原有范围校验；分仓订单只显示本仓的履约行；修改关键字段后出库返回 `WF_APPROVAL_INVALIDATED`

实现：`jxc-server/jxc-module-sys/src/main/java/com/hs/jxc/workflow/service/WorkflowService.java`。场景：`DocumentGovernanceIT#watcherAndCcConfigurationNeverAmplifyTheRecipientsAuthority`（最终冻结制品逐方法 PostgreSQL 集成验证通过；不等于整项页面通过）。

页面：/approval/todo、/sales/outbounds。执行：配置抄送 → 受限账号打开只见本仓履约 → 改关键字段后出库应失效。

状态：真实页面未执行；操作者、单据/凭证、期末数量金额及证据待记录。

### A15 差异化定价

原规则：同一 SKU 对不同客户命中不同专属价；调价后已批准订单的价格不变；退货使用原成交价

实现：`jxc-server/jxc-module-sal/src/main/java/com/hs/jxc/sal/SalesService.java`。场景：`SalesIT#pricePrecedenceAndVersionSnapshotSurviveLaterPriceChange`（已观察局部聚焦通过；不等于整项通过）。

页面：/sales/orders/new、/sales/prices。执行：同SKU两客户专属价 → 批准订单 → 调价 → 旧订单不变 → 退货原价。

状态：真实页面未执行；操作者、单据/凭证、期末数量金额及证据待记录。

### A16 现金、转账与核销

原规则：支持混合收款、多次收款；核销金额不超过已确认金额；现金日记账可查；系统没有交班功能

实现：`jxc-server/jxc-module-ar/src/main/java/com/hs/jxc/ar/ReceivablesService.java`。场景：`ReceivablesIT#concurrentWriteoffsNeverSpendReceiptTwiceAndReverseAppendsOriginalFacts`（最终冻结制品逐方法 PostgreSQL 集成验证通过；不等于整项页面通过）。

页面：/ar/receipts、/finance/ledgers。执行：现金+转账多次到账 → 分次核销 → 超额拒绝 → 查日记账。

状态：真实页面未执行；操作者、单据/凭证、期末数量金额及证据待记录。

### A17 欠款对账与退款

原规则：欠款、到账、退货、预收分别可追溯；退款需审批，不超过可退余额；重复支付登记不重复扣减

实现：`jxc-server/jxc-module-rtn/src/main/java/com/hs/jxc/rtn/ReturnsService.java`。场景：`ReturnsRefundsIT#approvedRefundPayWithRealEvidenceIsIdempotentAndEvidenceRemainsReadable`（最终冻结制品逐方法 PostgreSQL 集成验证通过；不等于整项页面通过）。

页面：/ar/customers/:id、/returns/refunds。执行：生成客户期间对账 → 原单退货 → 审批退款 → 付款重复提交 → 余额不重扣。

状态：真实页面未执行；操作者、单据/凭证、期末数量金额及证据待记录。

### A18 MX 调拨与盘点

原规则：调出、在途、实收数量不重复计算；盘点差异审批后才调整；批次成本随货保留；没有库龄字段

实现：`jxc-server/jxc-module-inv/src/main/java/com/hs/jxc/inv/service/InventoryDocuments.java`。场景：`InventoryDocumentsIT#partialTransferCloseKeepsTransitUntilDifferenceApprovalThenFreezesOriginalLossCost`（已观察局部聚焦通过；不等于整项通过）。

页面：/inventory/transfers、/inventory/stocktakes。执行：调拨出库 → 分次收货 → 盘点差异 → 审批过账；核对两仓、在途和批次成本。

状态：真实页面未执行；操作者、单据/凭证、期末数量金额及证据待记录。

### A19 库存上下限与补货

原规则：按 SKU 和仓店设置上下限，低于下限或高于上限时触发对应预警；补货待办可关联采购单或调拨单

实现：`jxc-server/jxc-module-inv/src/main/java/com/hs/jxc/inv/service/ReplenishmentService.java`。场景：`ReleaseInventoryIT#replenishmentUsesNativeTransferReceiptsAndReadOnlyLists`（最终冻结制品逐方法 PostgreSQL 集成验证通过；不等于整项页面通过）。

页面：/inventory/limits、/inventory/replenishments。执行：保存上下限 → 低/高库存预警 → 生成建议 → 人工决定 → 关联正常采购/调拨 → 分次履约 → 关闭。

状态：真实页面未执行；操作者、单据/凭证、期末数量金额及证据待记录。

### A20 库存与订单联合分类

原规则：库存相同但有效订单量不同的商品，按配置得到不同标签；高库存高订单不只凭库存判为滞销；低库存低订单不只凭库存判为畅销；可以下钻到依据和订单

实现：`jxc-server/jxc-module-inv/src/main/java/com/hs/jxc/inv/service/InventoryClassification.java`。场景：`ReleaseInventoryIT#jointClassificationUsesDemandAndLocalStockAndLogsEvidenceChanges`（最终冻结制品逐方法 PostgreSQL 集成验证通过；不等于整项页面通过）。

页面：/inventory/analysis。执行：两商品同库存不同有效需求 → 配置联合条件 → 重算 → 比较标签 → 展开依据与原订单。

状态：真实页面未执行；操作者、单据/凭证、期末数量金额及证据待记录。

### A21 CNY 至 MXN 换算

原规则：采购保留 CNY 原价；入库成本按已确认汇率折算 MXN；缺汇率时为 `PENDING_RATE`，不能确认；改汇率后历史快照不变

实现：`jxc-server/jxc-module-cst/src/main/java/com/hs/jxc/cst/service/CostValuationService.java`。场景：`CostSourcesIT#missingRateIsPendingAndLaterRateCannotRewriteFrozenOriginalFacts`（最终冻结制品逐方法 PostgreSQL 集成验证通过；不等于整项页面通过）。

页面：/cost/inbound。执行：CNY采购实收 → 缺汇率待定拒绝确认 → 确认汇率 → 确认成本 → 改汇率旧快照不变。

状态：真实页面未执行；操作者、单据/凭证、期末数量金额及证据待记录。

### A22 成本与费用分摊

原规则：分摊明细合计等于原费用（舍入差额由指定行吸收）；资本化费用不再计入期间费用；暂估与实际的差额有调整记录

实现：`jxc-server/jxc-module-cst/src/main/java/com/hs/jxc/cst/service/CostValuationService.java`。场景：`CostValuationIT#actualReplacesEstimateByDifferenceAndCannotBeCapitalizedOrReversedTwice`（最终冻结制品逐方法 PostgreSQL 集成验证通过；不等于整项页面通过）。

页面：/cost/allocations。执行：费用按数量/重量分摊 → 合计守恒尾差 → 资本化 → 实际替代暂估仅差额。

状态：真实页面未执行；操作者、单据/凭证、期末数量金额及证据待记录。

### A23 供应商与物流商对账

原规则：采购和物流的应付、预付、付款、退货、结算差额都可查；币种清楚；对账单期末等于明细合计

实现：`jxc-server/jxc-module-ap/src/main/java/com/hs/jxc/ap/PayablesService.java`。场景：`PayablesIT#statementDetailsOnlyContainTheRequestedPeriodAndReconcileOpening`（最终冻结制品逐方法 PostgreSQL 集成验证通过；不等于整项页面通过）。

页面：/ap/partners/:id。执行：供应商与物流商应付/预付/付款/退货/结算 → 生成期间对账 → 币种及期末合计。

状态：真实页面未执行；操作者、单据/凭证、期末数量金额及证据待记录。

### A24 凭证来源与记账

原规则：同一事件只生成一张待审凭证（`source_event_id` 唯一）；应收已形成不代表已记账；未审核或借贷不平的凭证不能记账

实现：`jxc-server/jxc-module-fin/src/main/java/com/hs/jxc/fin/accounting/AccountingService.java`。场景：`AccountingEventsIT#concurrentDeliveryAndManualClicksCreateOneVoucherAndSimulationDoesNotWrite`（最终冻结制品逐方法 PostgreSQL 集成验证通过；不等于整项页面通过）。

页面：/finance/events、/finance/vouchers。执行：同事件并发/重复生成凭证 → 只一张 → 未审/不平拒绝记账 → 审后记账。

状态：真实页面未执行；操作者、单据/凭证、期末数量金额及证据待记录。

### A25 凭证更正与账簿

原规则：已记账的凭证不能修改或删除，只能冲销；总账、明细账、余额表可以下钻到凭证和原业务

实现：`jxc-server/jxc-module-fin/src/main/java/com/hs/jxc/fin/ledger/LedgerService.java`。场景：`LedgerIT#manualLifecycleIsSeparatedAndLatePostingCarriesForwardAndReversalKeepsOriginal`（最终冻结制品逐方法 PostgreSQL 集成验证通过；不等于整项页面通过）。

页面：/finance/ledgers。执行：记账后改删失败 → 授权冲销 → 账簿下钻原凭证/业务。

状态：真实页面未执行；操作者、单据/凭证、期末数量金额及证据待记录。

### A26 结账前核对

原规则：未记账业务、库存成本差异、往来与总账差异都可以定位；影响本期核算的差异未处理时不能结账

实现：`jxc-server/jxc-module-fin/src/main/java/com/hs/jxc/fin/closing/ClosingService.java`。场景：`ClosingIT#closeIsAtomicIdempotentAndCheckNeverReopensClosedPeriod`（最终冻结制品逐方法 PostgreSQL 集成验证通过；不等于整项页面通过）。

页面：/finance/closing、/finance/reconcile。执行：结账检查显示未记账/成本/往来差异 → 下钻 → 未处理不能关账。

状态：真实页面未执行；操作者、单据/凭证、期末数量金额及证据待记录。

### A27 期间锁与反结账

原规则：结账后，该期间业务返回 `FIN_PERIOD_CLOSED`；授权反结账会校验后续依赖、记录原因并重新核对

实现：`jxc-server/jxc-module-fin/src/main/java/com/hs/jxc/fin/closing/ClosingService.java`。场景：`ClosingIT#reopenRetainsGenerationsAndRejectsLaterClosedPeriods`（最终冻结制品逐方法 PostgreSQL 集成验证通过；不等于整项页面通过）。

页面：/finance/closing。执行：关账 → 原期间业务拒绝 → 存在后续已关期间反结失败 → 授权写原因后重开/核对。

状态：真实页面未执行；操作者、单据/凭证、期末数量金额及证据待记录。

### A28 内部财务报表

原规则：试算平衡与总账一致；资产负债表和利润表按映射生成；现金流量表按现金银行分类生成，而不是按销售额

实现：`jxc-server/jxc-module-fin/src/main/java/com/hs/jxc/fin/report/ReportService.java`。场景：`FinancialReportsIT#reportsUsePostedOriginalFactsConfirmedOpeningEquityAndCashBankFlows`（最终冻结制品逐方法 PostgreSQL 集成验证通过；不等于整项页面通过）。

页面：/finance/reports。执行：查试算/总账/资产负债利润现金流 → 核对映射及现金银行分类 → 钻原凭证。

状态：真实页面未执行；操作者、单据/凭证、期末数量金额及证据待记录。

### A29 AI 与范围排除

原规则：盈亏分析可以追溯来源；缺成本时有标识；标明不含线下营销费；没有营销和库龄跌价功能；AI 没有写操作接口

实现：`jxc-server/jxc-module-cst/src/main/java/com/hs/jxc/cst/profit/ProfitService.java`。场景：`ProfitIT#aiUnconfiguredHasNoInventedHistoryAndRejectsAnalysisAfterCurrentPermissionCheck`（最终冻结制品逐方法 PostgreSQL 集成验证通过；不等于整项页面通过）。

页面：/analysis/ai、/analysis/profit。执行：利润查来源与缺成本 → AI未配置明确提示 → 无写入口/营销/库龄功能。

状态：真实页面未执行；操作者、单据/凭证、期末数量金额及证据待记录。

### A30 重试与导入

原规则：并发出库不超卖；重复的收货、出库、到账、核销、退款、凭证生成都不重复计算；期初导入不与未完业务重复

实现：`jxc-server/jxc-module-sys/src/main/java/com/hs/jxc/sys/imports/ImportService.java`。场景：`ReleaseInventoryIT#concurrentDifferentConfirmKeysCannotDoubleApplyTheSameSource`（已观察局部聚焦通过；不等于整项通过）。

页面：各执行页面。执行：真实文件上传预校验 → 预览 → 确认 → 重复确认/取消重验；并发出库/到账/退款/凭证各原页面重试。

状态：真实页面未执行；操作者、单据/凭证、期末数量金额及证据待记录。

### A31 有效订单数量口径

原规则：已审批订单按有效数量计入，草稿、待审、取消部分排除；部分出库不重复计数；未发的有效需求仍计入；商品件数与订单张数分别显示

实现：`jxc-server/jxc-module-sal/src/main/java/com/hs/jxc/sal/SalesStatsService.java`。场景：`ReleaseInventoryIT#approvedUnfulfilledDemandUsesApprovalDayAndSplitsWarehousesExactlyOnce`（已观察局部聚焦通过；不等于整项通过）。

页面：/inventory/analysis。执行：草稿/待审/批准/部分取消/部分出库订单 → 比较有效件数、订单张数及未交需求。

状态：真实页面未执行；操作者、单据/凭证、期末数量金额及证据待记录。

### A32 统计范围与规则配置

原规则：修改周期或阈值后按新配置更新分类；门店与仓库的统计没有重复分配；缺数据或缺规则时显示待判断；缺货不自动等于畅销；命中依据可以进入原订单

实现：`jxc-server/jxc-module-inv/src/main/java/com/hs/jxc/inv/service/InventoryClassification.java`。场景：`ReleaseInventoryIT#jointClassificationUsesDemandAndLocalStockAndLogsEvidenceChanges`（最终冻结制品逐方法 PostgreSQL 集成验证通过；不等于整项页面通过）。

页面：/inventory/classify-rules。执行：变更周期/阈值新版本 → 按仓店重算 → 缺规则待判断 → 缺货低需求不自动畅销 → 钻订单。

状态：真实页面未执行；操作者、单据/凭证、期末数量金额及证据待记录。

### A33 国家模板创建

原规则：平台管理员可以选择墨西哥模板版本，预览复制清单，生成目标国家草稿并显示缺项，补齐后启用；国家管理员调用创建接口返回 403

实现：`jxc-server/jxc-module-sys/src/main/java/com/hs/jxc/sys/service/CountryConfigurationService.java`。场景：`CountryConfigurationIT#publishedTemplateCloneRequiresLocalReviewAndDoesNotCopyPeopleBanksOrTransactions`（已观察局部聚焦通过；不等于整项通过）。

页面：/settings/countries/clone。执行：平台发布MX版本 → 克隆预览 → DRAFT缺项 → 逐项本地审核补齐 → 启用；国家管理员创建403。

状态：真实页面未执行；操作者、单据/凭证、期末数量金额及证据待记录。

### A34 跨国家权限隔离

原规则：只有墨西哥权限的账号，通过编号、搜索、链接、附件、导入导出、报表、AI 都拿不到第二国家的数据（按 ID 访问返回 404）；复制不继承墨西哥人员权限和银行资料

实现：`jxc-server/jxc-module-sys/src/main/java/com/hs/jxc/sys/service/AuthorizationService.java`。场景：`AuthorizationIT#aHeaderCannotAuthorizeAnotherCountry`（最终冻结制品逐方法 PostgreSQL 集成验证通过；不等于整项页面通过）。

页面：全部。执行：MX账号改国家header/ID/搜索/直链/附件/导入导出/报表/AI访问第二国 → 拒绝且无复制人员银行。

状态：真实页面未执行；操作者、单据/凭证、期末数量金额及证据待记录。

### A35 当地配置生效

原规则：测试国家使用本国本币、时区、仓店、财务映射；采购、销售、汇率、日结、凭证中没有错误套用 MXN 或墨西哥时区；必要配置缺失时拦截

实现：`jxc-server/jxc-module-sys/src/main/java/com/hs/jxc/sys/service/CountryConfigurationService.java`。场景：`ProfitIT#bookCurrencyAndCountryTimezoneAreReadFromCurrentBookInsteadOfAssumedMexico`（最终冻结制品逐方法 PostgreSQL 集成验证通过；不等于整项页面通过）。

页面：第二国家的各页面。执行：第二国本币时区配置 → 故意留缺项 readiness阻止 → 补齐 → 业务/汇率/日结/凭证查当地值。

状态：真实页面未执行；操作者、单据/凭证、期末数量金额及证据待记录。

### A36 库存、往来、账簿独立

原规则：复制不带墨西哥的库存、订单、欠款、收付款、凭证；第二国家的交易不改变墨西哥的数量和余额；同一 SKU 的分类只用本国数据；各国独立结账

实现：`jxc-server/jxc-module-sys/src/main/java/com/hs/jxc/sys/service/CountryConfigurationService.java`。场景：`CountryConfigurationIT#publishedTemplateCloneRequiresLocalReviewAndDoesNotCopyPeopleBanksOrTransactions`（已观察局部聚焦通过；不等于整项通过）。

页面：第二国家的各页面。执行：克隆后余额与交易空 → 第二国独立期初/业务 → MX前后数量金额一致 → 各国独立关账。

状态：真实页面未执行；操作者、单据/凭证、期末数量金额及证据待记录。

### A37 第二国家完整业务复用

原规则：不复制业务代码，用同一套核心功能完成测试国家的采购、入库、销售、出库应收、回款核销、退货、凭证、报表；同时回归墨西哥主流程

实现：`jxc-server/jxc-app/src/test/java/com/hs/jxc/it/M2FlowIT.java`。场景：`M2FlowIT#purchaseToCustomerRefundKeepsStockAmountsAndOriginalCostsConsistent`（最终冻结制品逐方法 PostgreSQL 集成验证通过；不等于整项页面通过）。

页面：与墨西哥相同的页面。执行：同一核心页面在MX和第二国各执行采购 → 入库 → 现款/赊销 → 应收核销 → 退货 → 凭证报表；逐国记录。

状态：真实页面未执行；操作者、单据/凭证、期末数量金额及证据待记录。

### A38 规则与模板版本独立

原规则：修改墨西哥的价格、库存阈值、账务模板后，第二国家不变；模板升级可以预览，按国家确认；历史订单和已记账凭证保留原版本

实现：`jxc-server/jxc-module-sys/src/main/java/com/hs/jxc/sys/api/TemplateStructureContributor.java`。场景：`TemplateStructureIT#financeStructureCopiesCodesIntoNewIdsAndPreservesLocalReviewWithoutBalances`（已观察局部聚焦通过；不等于整项通过）。

页面：/settings/countries/:id。执行：改MX价/阈值/记账模板 → 第二国不变 → 升级预览 → 目标国确认 → 历史订单凭证不变。

状态：真实页面未执行；操作者、单据/凭证、期末数量金额及证据待记录。

## 设置、导入、分类与补货浏览器操作清单

1. 登录新隔离环境，记录当前用户/国家；设置页新建第二门店与仓、当地币种/时区、账套/期间、必要编号规则和审批；新账号先验证无范围，再授权并重登。国家草稿配置与受控期初可操作，普通交易需 ACTIVE；DISABLED 保留已授权历史阅读。
2. 导入中心下载真实类型模板，上传 UTF-8 JSON 数组或粘贴数据；查看服务器哈希与 SOURCE_BYTES/CANONICAL_ROWS 标识、逐行错误。先用未知来源/未来来源/金额缺失样本验证不确认；再以显式已知期初数量成本、AR/预收、AP/预付和独立平衡 GL 分类型预览并确认。不要将未知余额当零。
3. 导入确认后核对来源→目标编号、批次尝试号；相同文件重试返回已有授权批次；取消/失败后的重新预校验保留原批次并建立前序引用。未完采购只创建正常草稿并走原审批，在途导入只能引用同截止日已批准的导入采购，后续实收使用原物流页面；不得伪造国内收货、销售、到账或付款。
4. 库存上下限按真实仓/商品保存，选择超过 200 条的后续页候选确认能选；通过真实库存/预留/冻结变动驱动预警更新。重复打开库存/预警页面，审计与任务数量不应增加。
5. 分类规则创建明确周期、统计维度、数量/张数和库存联合条件；新版本重算。准备同库存不同已批准需求、草稿、待审、部分取消、未出库及分仓订单。比较标签、件数/张数、PENDING_JUDGE，展开依据、版本与原订单；规则/证据变更有日志。
6. 补货页由预警生成建议，重复建议不新增待办；人工选择正常采购或调拨。审批及真实分次履约后查看已执行数、部分/完成状态与原单链接，最终人工关闭；全程不自动下采购。
7. 工作台查看待发运、待实收、待出库、收款确认、逾期跟进、退货及延误/暂缓复核。只读进入不得新增任务；已配置显式主体的定时任务重复执行去重，源业务解决后任务结束，撤权立即失去可见性。

## 当前自动化观测

上一完整候选回归通过 463 项（458 项 PostgreSQL 场景＋5 项纯测试），共55个测试类，失败、错误和跳过均为0；制品 SHA 为 `6b434c671bc44e880120277a80b4a5fcd5dd81fd2100b99dee7f76579afd5cee`。矩阵39条自动化场景映射已逐方法重新绑定到本次 XML，并保存展开用例名称、报告 hash 和制品 SHA。此前414/433候选保留为历史证据。该候选前端229项测试、生产构建及契约检查通过，111项原 Mock 回归保留。独立场景与参数展开分别以最终重算报告为准。用户确认原严格分仓守恒，正常已审批订单未分配统计为0。自动化通过不替代实际页面验收。 后续原页面发现实收入口幂等键、箱数与确认元数据、采购筛选以及成本调整混合映射遗漏，正在补齐并追加第40个迁移；当前改动须重新完整验证，不沿用463/229作为新源码通过结论。

## 可复用的实际页面工作负载

`evidence/scripts/release-ui-runtime.py` 只创建全新的持久隔离 PG/MinIO/API，冻结当前 jar，使用既有离线基础引导创建合成平台管理员、MX ACTIVE 主体/账套和首店首仓。凭据在工作区外 0600 私有文件；运行时使用 `jxc_app`、不传迁移凭据、Flyway 关闭。正式运行开启既有 worker，并显式配置当前 countryId:userId；迁移和离线引导时关闭 worker。业务、库存、往来、凭证与导入记录初始均为零。

`evidence/scripts/release-ui-actions.py init` 根据当前矩阵生成私有 `browser-run.json` 和 `actions.md`：原38项，以及 docs99 第5节要求在第二国复用的12项核心场景，共50条国家场景记录。`next` 给出下一条，`record` 要求实际页面截图或下载物、操作者、URL、单据/凭证编号、期末数量和金额，`summary` 保留未执行/通过/失败/阻塞数量。它不调用 HTTP/SQL，也不代替 CUA 或操作者点击页面。任何 API/SQL 准备须用 `prepare` 写到单独准备层，不能将页面用例标记通过。

示例（路径由隔离环境启动结果给出，禁止将私有凭据加入仓库）：

```sh
python3 docs/backend/evidence/scripts/release-ui-actions.py init
python3 docs/backend/evidence/scripts/release-ui-actions.py next --run /private/path/browser-run.json --country MX
python3 docs/backend/evidence/scripts/release-ui-actions.py summary --run /private/path/browser-run.json
```

## 尚未完成的验收工作

本矩阵已更新最终全量回归引用；真实页面状态仍待统一重算。持久隔离环境已完成双国独立期初核对及部分原页面写入，第二国家完整主流程与 MX 全面回归继续执行。当前未发布生产。JSON 文件不是性能/安全/财务签字，也不将未执行项转成通过。
