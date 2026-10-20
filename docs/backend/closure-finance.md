# FIN / CST / AP 与后台任务收口

范围：原有总账、成本、应付、异步导出和工作台实现；模块迁移为 V010_1～V010_5，后续受控零额解释以 V013_8 正式追加，不改已用迁移。没有新增并行计价、核销、凭证生成或任务总线。

当前交付状态：41迁移的8b0c候选包已受控升级原隔离页面库，原事实不变；同SHA独立worker恢复/真实告警演练通过且资源清理。其后原应付选择页暴露仅PO、缺已确认收货来源的实际缺口，已完成49PG+5pure、6个实际setup及typecheck红绿；597e针对性候选尚未部署，待与独立安全复核修正合并后继续原页面。最终完整构建、最终同SHA运维演练和A01–A38验收仍待总收口。各历史包操作保留真实执行SHA，不冒充当前源码通过。

## 财务与成本行为

- 期初金额必须显式提供 `amount` 或 `baseAmount`。缺失或 `null` 返回校验错误；显式 `0` 是已知零余额。外币仍要求原币和汇率，期初确认继续使用原有整账套借贷平衡校验及原子余额初始化。
- 应付核对余额增加 `AP_SETTLEMENT` 的已实现汇差。复用 `financialSettlementLines` 的累计币种精度分配和原核销冲销分配，按核销业务日期纳入；现金余额不重复计入核销。账单本位币 250、付款本位币 200 时，核销前差额 50，核销后 0，冲销后恢复 50。
- 正常原单退货和待补成本退货共用 `ReturnCostAllocation`。以原出库冻结成本及累计退货数量分配尾差：总成本 1、数量 3，三次各退 1 分别为 0.3333、0.3334、0.3333，合计精确为 1。确认与补齐均沿用账套计价锁、原成本确认、COGS completion 和计价池重放；不修改既有 COGS。
- 部分批次补齐、整个计价池仍未齐备时，只追加带日期的零值 `COST_COMPLETION` 见证，不把未知计价池金额改成零。
- 入库成本页面明确选择“确认日期”，默认当前国家当地日期；单笔、批量和确认提示使用同一日期，调用原有 `bizDate` 命令字段。期初截止日或已关闭来源期间的成本，可以在当前开放期间形成独立确认事实，原入库日期与原始快照不移动。
- WEIGHT / VOLUME 分摊只要任何目标缺相应数值即拒绝，不能给缺值目标悄悄分配零。
- 分摊确认/撤销只认 `cst:allocation:confirm`，成本调整确认只认 `cst:adjustment:confirm`。原有费用登记直接形成确认事实，因此同时要求 `cst:expense:create` 和 `cst:expense:confirm`。没有 create 权限兜底，也没有角色自动扩权。
- 新应付账单、付款、预付、贷项、调整、核销，以及成本调整/费用、财务凭证，使用 SYS 原子编号服务。没有相应国家编号规则时失败，旧单号不改写。

## 真实期初导入

原有统一导入生命周期负责预校验、幂等、重复来源、原子确认和回滚；所有 owner 写入都在原确认事务中执行。

- `OPENING_AP`：原生 `ap_bill` 的 `OPENING` 来源，保留截止日、业务来源编号、导入批次/行引用、明确原币/本位币金额及汇率。确认后的余额可通过原核销使用。
- `OPENING_PREPAYMENT`：原生 `ap_prepayment` 的 `OPENING` 来源，可通过原核销使用。没有资金账户、付款凭证或伪造现金支出，不发付款/记账事件；现金来源查询明确排除这种期初。
- `OPENING_GL`：通过 `LedgerService` 同一份科目、辅助项、币种、金额校验建立原生期初，最后调用原有整账套平衡确认。任一行、来源或借贷平衡失败，全部回滚；存在本批之外的手工期初草稿则拒绝合并确认。
- AP 数据库约束要求确切的、持久化 `VALIDATED` 原始导入批次、已预留来源和已规范化行匹配来源、账套、往来对象、原币/本位币、金额及汇率日期。客户端来源标记不能创建这个权限。DRAFT 国家期初只走封闭导入上下文；普通交易仍须 ACTIVE。
- 总账期初与应付/预付期初独立输入和核对，不从其中一边推算另一边，不推定未知期初。

## 应付确认规则

入口位于原应付账单页面“应付确认规则”。按国家、采购/物流/其他来源配置，缺配置时默认 `BILL_CONFIRMED`。

`MANUAL` 保留人工生成与确认；`RECEIPT_CONFIRMED` 只在采购国内收货确认或物流费用确认事件后生成原生 **DRAFT** 账单。它复用原来源容量、来源占用、账单草稿和 outbox，不确认应付、不记账。

自动模式必须明确执行账号，当前须有原生账单创建、成本字段和账套范围权限。后台按 SYS 已有明确主体模型每次重查权限与范围，不创建服务账号或授权，不依赖某次配置时的交互会话永久有效。账号停用或权限撤销会停止执行并保留失败诊断。国家就绪页和启用检查通过 SYS contributor 调用同一 owner 校验，自动模式执行主体失效时显示 BLOCK。

API：`GET/PUT /api/v1/ap/recognition-rules/{PURCHASE|LOGISTICS|OTHER}`。配置使用当前版本和 UUID 幂等键，同一意图不会重复递增版本；UI 不为人工模式保留自动执行主体。

期初 AP/预付模板的 `sourceDate` 保留原来源日期，未提供时明确按截止日快照处理；晚于截止日拒绝。原生余额业务日期始终为截止日，原来源日期保存在不可变导入行。数据库例外还核对来源预留、已校验金额、原币、本位币、汇率及截止日汇率日期，不能更换已复核计价依据。

## 账簿、模板与导出

- LedgerView 使用与报表相同的请求序号及具体请求范围判定；旧账套科目、旧期间账簿、旧科目/辅助项明细响应不会覆盖当前选择。换账套清理科目、期间、辅助项、资金账户及结果；换期间清理辅助项和资金账户。日记账的科目/资金筛选与导出一致，资金选项来自完整期间数据。
- `GET /api/v1/org/books?warehouseId=...` 是仓库业务引用候选：复用原 `BookResolver` 的来源授权及主体/绑定账套筛选，返回本仓全部匹配 ACTIVE 账套的 id、code、name、baseCurrency、entityId、status。多候选仍须明确选择；默认组织/财务账套列表和整套账簿权限继续按原 `canBook` 判断，取得候选不会授予 BOOK 范围。
- AP 付款/预付表单完整读取往来对象、账户、启用账套及币种；多个账套必须明确选择，资金账户限制在当前账套主体及币种，不自动选首个账户。核销按当前往来对象完整分页读取来源，再核验账套；延迟旧往来响应不覆盖当前来源，换账套清理旧单据选择。
- 财务/成本/任务页面的完整引用集合复用 `allRecords`，按服务端合法分页读取，保留完整字段及国家/登录上下文检查。
- 原 ReportView 提供 `ACCOUNT_MAP_V1` 编辑器：本账套科目或科目分类、期末净额/本期净发生额、前序行加减、方向。已生效版本只能复制新版本；原草稿编辑、独立复核和结账快照机制保持原路径。
- `POST /api/v1/fin/ledgers/{detail|general|balance|journal|trial}/export` 使用 `FIN_LEDGER_EXPORT`，同时要求 `fin:ledger:view` / `fin:ledger:export`。
- `POST /api/v1/ap/statements/{id}/export` 使用 `AP_STATEMENT_EXPORT`，同时要求 `ap:statement:view` / `ap:statement:export`；导出已保存的 owner 对账单快照，不生成新对账单。
- 原财务报表导出继续使用 `FIN_REPORT_EXPORT`。全部复用 SYS 原 outbox / consumer / job / result / notice 和同一查询、字段掩码、账套范围。服务端排队时固定所有期间状态下的结账代次，以及关闭期间的快照编号，执行前在账套共享锁内复核；重新开放或再结账后旧排队请求以 `JOB_CONTEXT_CHANGED` 失败，需要新建请求，显式重试不会更改原上下文。执行结果保留快照编号/结账代次，下载不重算并重新检查当前身份、权限、范围和字段策略。CSV 转义共用 `CsvFiles`。

成本原快照保留来源币种、原币单价与金额，以及确定后的汇率编号、日期和版本。成本确认页面的明确确认日期用于原生成本确认事实、事件及当前期间校验；补汇率仍按原快照的来源日期取采购成本汇率，原来源日期和已确认历史金额保持不变。缺汇率或成本时，单笔及批量确认继续返回原有待补诊断。AP 的原币、本位币、核销来源及已实现汇差由原 owner 事实和对账单保留。

当前自动凭证映射读取 owner 提供的受控本位币金额字段；生成分录以账套本位币、汇率1及对应本位币金额入账。来源原币信息通过原单据快照追溯。源币分录自动映射尚未提供，不能将当前本位币自动凭证解释为该能力；手工外币分录和期初仍沿用原生外币科目、明确原币金额与汇率校验。

## 任务恢复与运行诊断

AP 命令在原幂等结果授权回调中核对明确选择的 `bookId`；来源事实属于另一账套时整笔回滚，缓存重放也同样核对。

原导出请求保持不可变。升级前没有服务端期间上下文的未执行财务导出同样需重新发起，不把新快照代次补写到旧请求。重新登录后的显式重试新增不可变 `sys_job_execution_intent`，只接受该任务当前 owner 的有效会话；执行按最近的明确意图重新授权。当前权限撤销仍失败，不能借旧请求、旧任务或已缓存文件绕过。原 consumer 保证一个结果、一个完成通知。

`GET /api/v1/sys/jobs/worker-status` 要求 `sys:worker:view`，仅返回当前国家、当前账套范围允许的技术诊断：恢复配置、owner provider、心跳、失败/过期租约/长期排队和 `actionRequired`。不输出会话摘要、原始错误或财务敏感内容。

- `jxc.jobs.enabled`、`jxc.jobs.recovery.delay-ms`、`jxc.jobs.recovery.limit` 控制统一恢复。
- SYS 技术导出可恢复历史读取任务；业务 owner provider 仅处理 ACTIVE 国家。
- `jxc.workbench.worker.assignments=countryId:userId,...` 明确配置定时待办主体。它只把原 owner 的 `LOGISTICS_DELAY` / `HOLD_REVIEW` 当前工作项写入既有 `sys_todo`，按来源/类型/账号去重，条件消失后完成。读取仍用当前 owner 权限和来源，不展示过期或重复 TIMER 行。
- 新增表均 FORCE RLS，使用国家策略和 `jxc_write_gate` BEFORE STATEMENT INSERT / UPDATE / DELETE / TRUNCATE，授予最小表权限。

真实进程演练入口：

```sh
python3 docs/backend/evidence/scripts/release-worker-rehearsal.py --jar jxc-server/jxc-app/target/jxc-app-0.1.0-SNAPSHOT.jar
```

只新建带演练标签的 PostgreSQL/MinIO 及私有 bucket，复用现有 provision 和 S3 适配器。复制固定 jar，原子排队同一幂等请求，阻塞结果插入后 SIGKILL API，确认持久租约存在而效果/通知回滚；等待实际租约过期，再以 `jxc_app` 和 Flyway 关闭的独立进程恢复。另验证当前权限撤销阻止效果及下载、原会话失效后当前 owner 新会话显式重试只产生一个结果/通知。证据记录实际 jar hash、进程退出、来源/效果计数和诊断，凭据及私有日志留在工作区之外。成功后只删除本次创建的资源。

原费用项目配置支持既有数据库和成本 owner 的 `CAPITALIZE`、`EXPENSE`、`PERIOD_EXPENSE`、`DIRECT_SELLING`。页面复用既有费用处理选项，并保留历史 `EXPENSE` 的兼容标签；原接口保存、版本更新及科目范围校验不变。`EXPENSE` 进入原生成本登记时仍规范为期间费用，直接销售费用沿用原商品分配事实。

## 原角色权限复核清单

升级不修改角色。由权限管理员按国家执行以下只读清单，逐项决定是否另外授权确认；原生角色编辑接口继续验证授权上限。

```sql
SELECT r.country_id, r.id AS role_id, r.code, r.name,
       p.create_permission, p.required_confirmation
FROM sys_role r
CROSS JOIN (VALUES
 ('cst:allocation:create','cst:allocation:confirm','cst:allocation:*'),
 ('cst:adjustment:create','cst:adjustment:confirm','cst:adjustment:*'),
 ('cst:expense:create','cst:expense:confirm','cst:expense:*')
) p(create_permission,required_confirmation,existing_wildcard)
WHERE r.country_id = :country_id AND r.status='ENABLED'
  AND r.permissions ? p.create_permission
  AND NOT (r.permissions ? p.required_confirmation
        OR r.permissions ? '*' OR r.permissions ? 'cst:*'
        OR r.permissions ? p.existing_wildcard)
ORDER BY r.country_id,r.code,p.required_confirmation;
```

## 年中首次启用期间

沿用 `POST /api/v1/fin/periods?bookId=...` 和原账套独占配置门，增加明确的 `firstMonth`（1–12，省略为1）。仅补齐该月到12月，保留原期间及原期初/发生额初始化算法，幂等审计记录年度和首月。账套页面提供“首个月份”；2026年10月启用可以先生成10–12月，以2026-09-30为真实期初截止日，无需构造1–9月结账。

期初 owner 写入继续保留截止日事实。`PeriodApi.assertOpeningCutoff` 仅接受当前已锁定、已校验导入事务的精确截止日，使用原账套门并复用 SYS 单一期间状态函数：截止日已有期间则要求其开放；没有期间时，要求本账套首期恰好从次日开始且开放。CST 只有 `OPENING_STOCK` 原生入库快照走此委派，计价方法生效日、计价锁和金额算法保持原实现。普通交易仍使用原 `assertOpen`。已完成的未完采购/在途来源后续操作，必须使用 owner 对完整持久化导入来源的证明，不能靠过去日期或客户端标记取得例外。

## 隔离页面验收的明确期初资料

页面验收使用人工明确给出的合成资料，不从业务子账倒推：截止2026-09-30，首期2026-10；各国家分别用其本位币、汇率1。库存借100（SKU-A数量10、单位成本10）、应收借200（UI-OPEN）、预付借40（UI-OPEN-SUP）；应付贷150（UI-OPEN-SUP）、预收贷30（UI-OPEN）、权益贷160，借贷各340。总账独立录入并平衡确认，再核对业务子账净应收170、净应付110、库存100。期初往来与后续 UI-CASH / UI-CREDIT / UI-SUPPLIER 分开；没有现金期初或虚构付款。库存、应收、预收由各原 owner 的导入中心页面确认；应付、预付及总账由财务页面确认。

## 验证与交付边界

针对性 PostgreSQL 红绿证据涵盖缺失/空期初、已实现汇差日期与冲销、退货累计尾差、缺维度分摊、专用确认权限、当前会话重试、当前权限下载、账簿/对账单导出、原生期初原子导入和自动应付草稿。Vue 实际 setup 延迟测试覆盖旧账套/期间/明细响应、日记账筛选、模板版本及 AP 控件；这不替代真实浏览器验收。

新增最后配置边界红绿：FoundationIT 9 + MasterDataIT 8 共17个 PostgreSQL 用例通过，覆盖 STORE 仓库候选不扩大账簿范围、四种费用项目经原 HTTP 创建/更新/读取及原生成本费用登记；费用页面选项新增1个实际 setup 回归并通过 `vue-tsc`。

重点验证：最终复核组 107 个真实 PostgreSQL 用例通过（含已有总账/结账/应付和新增延迟代次、源日期、原始计价依据、JSON 辅助项顺序、显式账套、停用国家导出及 worker 告警场景）。另有 Vue 实际 setup 延迟响应/编辑/选择器测试 12 个及 `vue-tsc` 通过；这些不替代全量 CI、真实浏览器或最终包演练。

新增：owner 导入适配器、规则、导出 handler、任务重试意图、运行诊断、进程演练与有意义回归。修改：原总账/成本/应付查询和命令、原页面、原 SYS worker。删除：旧 create 兜底确认授权及缺维度变零行为；没有删除历史凭证、原始成本或核销事实。完整测试、最终包和浏览器验收由总收口证据记录；单独的 focused 测试不称为完整 CI 或部署验收。全新目录的候选包 clean verify 已通过414个 PostgreSQL 用例，含首月范围场景；候选 jar SHA256 `fecec1c2565066e462b9e5c8bbf818e4492b2a888bed733baec57fcea49d6f42` 的独立进程恢复和实际过期/失败告警演练通过。随后页面发现库存/AR/预收真实截止日与首期间的边界缺口，已新增精确导入专用委派；后续新目录 clean verify 已通过419个 PostgreSQL 用例，包含9月30日原生期初、10月后续核销/FIFO及明确10月成本确认日期。此后追加迁移按正式版本顺序升级，保留 outOfOrder=false，不使用 repair。当前页面验收包 SHA256 `f2b3439e5554dfc1e28a477368a8a8cd6323052ae56fa7b3b0b716c9607ed1e8` 已通过新的完整 clean verify，原隔离页面库 schema-only 升级36→38且业务事实未变；同 SHA 独立 worker SIGKILL/租约到期/运行身份恢复、唯一结果通知及真实 stale/failed 告警均通过，演练资源已清理。后续 MD 并发单位登记与采购来源展示的联合修复由总收口验证后再固化新包，f2b 页面记录保留其真实执行 SHA。

实际页面新增验证：两国独立期初 Dr/Cr340 已确认，Sep30库存原成本按Oct16确认，AR170/AP110/INV100/CASH0均零差额；MX期间费20及直接销售费12.34经原事件→独立审核→记账，CN期间费20同链完成。费用贷方配置为2241应计费用（无AP核对类别），没有虚构AP账单或资金事实。CN同事件双原页面重复生成只指向同一凭证1131，未审记账与不平草稿均被原命令拒绝。原报表 ACCOUNT_MAP_V1 编辑/保存/复核与报表→账簿→凭证→来源下钻、原异步账簿/报表导出已实际操作；完整A01–A38与第二国家核心结果以共享 browser-run 逐项记录为准。截图原字节为JPEG，`.jpg`别名保持原bytes，旧`.png`文件名作为来源保留。

入库成本页对真实DTO不再依赖不存在的rateAvailable字段。未确认行允许调用原确认命令，由服务端核验来源日期汇率/成本；已确认行不允许重复操作。缺显示名称时只回退真实batch/product/warehouse/sourceLine标识。实际setup回归2个通过，覆盖本币已知成本、缺率原命令拒绝和Oct确认日不移动Sep来源；vue-tsc通过，浏览器中两国已知期初单笔确认成功。

原UI更正和期间验收：MX人工更正凭证03借贷各1，上传明确合成资料后独立审核记账，原修改/删除入口被移除；另建并独立审核红字04借贷各-1，原03保留为已冲销，明细净额恢复。MX十月全部检查PASS后真实关账生成三类快照，再由原费用页证明闭锁拒绝；十一月真实关账形成依赖，十月反结被阻断。明确原因先重开十一月再十月，重新检查代次2全部PASS，无差异豁免，最终两期OPEN供后续原业务继续。共享browser-run已分别记录MX A25/A27及第二国A24/A26，保留f2b执行SHA；未提前宣称其他案例通过。

期初供应商原页面补充核对：MX partner124 显示应付150、预付40、未核销付款0、贷项0。原页面保存 Sep30–Oct16 对账单1381（0+150−0−0+0=150），原任务 AP_STATEMENT_EXPORT 成功并下载，CSV 保留 country3/book6/partner124/source bill163/来源Sep30。预付40保持独立余额，未伪造付款或核销；A23全业务案例仍待后续真实合成来源。对应截图 `closure-finance-mx-opening-ap-statement{,-export}.jpg`，执行包 f2b3439。

CN 本地资金配置已通过原 UI 完成（f2b）：cash1399/bank1402 均绑定 store192/book194，分别科目1001/202、1002/203；银行仅合成登记，不执行转账。原科目配置页复核 OPERATING 流入 UI_IN794、流出 UI_OUT797 并保存本地名称。未创建任何资金期初、收款或付款；实际混收60现金+24银行须等待 cash order1420 的原生审批及后续来源通知。截图 `closure-finance-cn-local-{fund,cashflow}-configuration.jpg`；只读 API IDs 后核单独见 `release-cn-fund-configuration.json`，不代替UI证据。

CN采购成本 V2 已原映射页新增/复核 ACTIVE，借1405 amount、借6602 differenceAmount、贷2202 apAmount，辅助沿受控 PARTNER/partnerId；原期初 V1 RETIRED 且961既有解释不变。原列表把V1无影响依据复制显示到VOUCHER发现后，仅前端保存按模式清空新请求reason、列表按模式展示；真实setup回归先RED（旧依据误入VOUCHER body）后GREEN1，typecheck退出0，未改写历史ACTIVE配置。截图 `closure-finance-cn-purchase-cost-mapping-v2-mode-corrected.jpg`。

未完采购来源须如实阻断：本合成链若已确认AP800CNY按2.5为2000MXN，目的地仅实收58PCS×10CNY×2.5=1450，则AP核对仍差550，来自国内/待检/短少等未完成金额承接。原M3采购/运输数量事件均NONE，采购财务金额由真实实收成本确认承担；不能单改配置虚构在途本金、改账单为580、补假收货或将非零来源解释NO_VOUCHER来清差。后续A26须原页定位具体单据并保留阻断，不能把此前真实14PASS的A27窗口冒充本链最终零差异。

后续审批配置预检（仅 API CONFIG prep，f2b）：两国原SALES_RETURN/REFUND/PURCHASE_RETURN、MANUAL COST_ALLOCATION/COST_ADJUSTMENT、STOCKTAKE/TRANSFER/TRANSFER_DIFFERENCE、DISCREPANCY_WRITE_OFF/AP_ADJUSTMENT规则与doctype配置此前均空；经授权沿原WorkflowService各补ACTIVE V1、approvalRequired=true、无阈值条件、本国既有COUNTRY_ADMIN语义ROLE节点（MX role7/UI_ADMIN；CN role196/COUNTRY_ADMIN）。未复制人员ID、未新增角色/权限/范围，原PUR/SALES规则和GL独立审核人30均未动；0业务创建/0审批动作。逐国type/ruleID/role/version及原API读回见 `evidence/release-workflow-configuration-preparation.json`。这是合成流程准备，不是生产人员确认，也不是UI业务审批通过证据。

6b434候选包独立任务恢复曾通过：jar SHA256 `6b434c671bc44e880120277a80b4a5fcd5dd81fd2100b99dee7f76579afd5cee`，完整463项（458PG+5pure）由总收口确认。新建隔离PG/S3内实际SIGKILL未提交effect进程，真实30秒租约到期后以jxc_app/Flyway关闭重启，单源最终一结果一通知；当前撤权下载/重放403，新会话显式retry恢复原不可变请求，真实STALE/FAILED告警均通过。共2event/2result/2notice/0voucher，全部自建资源已移除，见 `evidence/release-worker-recovery.json`。旧f2b证据另档保留。

同包CN原AR页面混收：现金receipt1558=60CNY/account1399与银行receipt1573=24CNY/account1402，均关联原销售1420；先分别确认到账，再原UI上传银行PAYMENT_PROOF attachment1581 ACTIVE。原到账确认有参考号时允许直接确认，故未把该操作记作缺凭证拒绝；订单出库所需真实附件由原现金证据检查验证。原UI截图 `closure-finance-final-cn-{bank-proof,mixed-receipts-confirmed}.jpg`。root随后原UI删除销售附件→再次拦截→重传v2→出库4并自动两笔核销84，禁止重复生成收款或核销。

补齐原owner映射配置仅作准备：两国各16个NEED_REVIEW草稿与1901盘点差异/2242客户可退款负债配置科目，0业务/0event执行/0voucher/0旧ACTIVE版本改动，见 `evidence/release-finance-owner-mapping-preparation.json`。RTN验货成本amount本来为负值，沿Dr6401/Cr1405冲回；结算冻结offset/refundable分别对应AR/客户可退负债，退款贷原资金账户，且仅覆盖已知零税本币合成来源。当时退货自动CREDIT_NOTE核销的SOURCE_CONFIRMATION与普通RECEIPT核销尚存在同模板模式冲突；该历史限制由下述受控零额解释修正替代，后续仍须原UI复核/验证，不重复贷AR。

历史映射限制（CST/AR部分已由下述修正替代）：在新增互斥posting字段与受控零额解释之前，同一CST_COST_ADJUSTED固定模板无法兼顾手工库存本金、手工已售本金、已售重分类与零额来源确认，故原准备草稿保持NEED_REVIEW。该诊断推动下述复用原计价/渲染器的窄修，不能再作为当前源码无法覆盖CST/AR的结论。调拨FOUND/LOSS、零差盘点及非MX_STOCK采购退货的其他草稿仍须按原冻结事实逐项复核；API准备不是UI验收。没有增加在途认定或会计事实，人工编辑表仍未新增来源输入。

6b434候选包中国现款来源会计链已实际原UI完成：出库1599/sourceEvent1627→凭证1784（收入84/成本40），收款1558/1573→1797/1812（60/24），原自动核销1617/1621→1821/1830（60/24）。两份预先加载的事件页重复生成只指向1784；编制人自审、未审批量记账及确切借1贷0.5的人工草稿均被原服务拒绝，负例草稿取消未保存。独立审核人30批量审核后管理员原UI记账五张。SECOND A24曾由原helper绑定6b434记录；后续必要前端改动后总收口已将该项重置待重验，历史record保留原SHA，不冒充最新源码通过。

本阶段报表实读：收入84/成本40/期间费20/利润24；资产384=负债200+权益160+未结转利润24；试算444=444；本地经营收款现金流84。原核对AR170/AP110/库存60/现金84数值差额均0，但AR/库存“尚未生成”列仍提示待补来源/映射，未声称A26全部无阻断。报表→科目余额→明细账→已记账凭证→SAL_OUTBOUND1599来源路线已实际下钻；原出库sourceId单行页部分名称/数量仍为“-”，已报owner核查，不掩盖展示限制。A28待赊销业务后进一步区别销售额与现金流，尚未以本阶段全部记通过。

后续真实边界修正（尚待新包）：同一CST_COST_ADJUSTED事件固定映射的缺口已由原PostgreSQL场景复现。原postingCost只从同一次CostInventoryAccountingService.delta投影postingInventoryAmount/postingCogsAmount/postingCounterpartAmount：手工库存(d,0,d)、手工COGS(0,原AccountingAmounts精度值,同值)、非手工(d,-d,0)，不abs、不另算计价、不改写原始成本。原字段与valuationAmount保留，新三个字段注册COST并进入既有有限表达式和原编辑页。

原render统一返回分录/实际解释模式/依据；唯一owner明确SOURCE_CONFIRMATION且成本/率/分摊前提全通过、amount显式0、至少两条合法映射的每个引用字段与每个实际分配记账金额均0时，才原事务记录NO_VOUCHER，固定依据SOURCE_CONFIRMATION_ZERO_POSTING，保留模板版本/fact_hash/consumer/idempotency/audit。普通0、NONE、缺字段/null、非零本金、伪outbox flag、±抵消均不能借此免凭证；显式NO_VOUCHER旧规则不扩大。独立review发现parts+1/-1被顶层0掩盖后，已补真实PG RED并把原parts选择和AccountingAmounts.split抽为正常渲染/零分支共同调用的allocatedAmounts；没有第二套分配算法。当前FE实际setup2与typecheck通过，后续focused 54PG（CST35+Accounting19）及5pure全GREEN；新jar/实际UI仍待执行，见 `evidence/release-cost-posting-zero-verification.json`，6b434此前证据保留候选身份。


受控零额落库边界：组合100个PG场景暴露原V006_1守卫只接受“NO_VOUCHER模板→NO_VOUCHER结果”，故新增正例试算正确而落库失败。追加V013_8保留既有技术关联检查，并要求ACTIVE VOUCHER、固定服务端reason、无voucher、精确country/book/mapping版本/event序号/合法fact_hash及当前事务的原FIN消费执行意图。该意图只由AccountingService.generateEffect在原consumer持锁后、首次解释前以不改claim/version/lease的原行更新绑定当前事务；普通已提交租约或其他consumer不构成证明。通用M1 consumer未改。数据库证明的是技术一致性；经济零值由唯一source owner与同一个render/allocatedAmounts证明，数据库没有重算成本prefix，亦未宣称可以识别运行账号直接SQL伪造的经济依据。新guard与原生CST/AR、HTTP/worker及技术负例已完成focused 54PG+5pure验证，0失败/0错误（/tmp/closure-finance-zero-green.log）。V0138 SHA256 dc9b805e8c4e44f3f07e13fe4eecabc9fd3d2c8244aeac77d51acc51528de89a。通用M1消费器没有FIN特例；完整构建、新包升级与新行为实际页面证据仍待统一收口。

中国赊销收款后续（6b434候选原页面）：root已原AR录入100现金receipt2154与68银行receipt2163，并原手工核销2176/2182。财务仅从四个原事件生成凭证2188/2197/2206/2215（CN-FIN-VOUCHER尾09–12），经独立审核人30审核、管理员4记账，各借贷100/68。没有再次创建收款或核销，没有外部付款；原JPG/AX见candidate-cn-credit-four-{generated,independent-audited,posted}。此前收入252/现金84阶段已独立截图保留，不因后续到账而重写。


原应付来源选择窄修：国内收货源沿既有payableSourcesForReceipt/payableSource的质量、单位换算、原价和canonical claim，确认来源80PCS×10CNY=800，先认50后剩30；PO对应剩5BOX，不允许重复越过同一采购行额度。选择列表为已授权/已确认来源的只读参考，不持来源变更锁；真实创建和自动识别继续持原锁并重新核验。原页面显示采购/国内收货依据、原单位和待认定量，提交min(qty,openQty)，未改源数量。真实PG先2失败/0错误，随后49PG+5pure全通过，包含跨范围/草稿排除/COST遮罩及持锁时读可见、创建必须等待的并发场景；Vue先80≠30失败后6通过，typecheck通过。候选597e尚未部署，不把该focused结果当成原页面已闭环，见evidence/release-ap-receipt-selector-verification.json。

8b0c原页面已完成MX SEA首30缺率窗口：receipt2511/line2512/batch2521显示CNY300、本位金额未知、PENDING_RATE；明确Oct16确认日期后原确认命令拒绝“缺少已确认的采购成本汇率”。原JPEG/AX为closure-finance-final41-mx-sea30-{pending-rate,confirm-refused-missing-rate}。随后来源已实际累计SEA30+18、短2及AIR10；由root按已授权顺序确认Oct16 ALL2.5，再冻结成本，不回改历史汇率伪造新包缺率重演。


8b0c实际页面成本/费用冻结窗口：明确Oct16确认A三批30/18/10件对应750/450/250MXN及B68件340MXN，均rate2.5，期初100仍原值。唯一HOLD2395→SEA2318暂估fee2736=100CNY/250MXN，原数量分摊2813按30:18为156.25+93.75；实际fee2829=100.02CNY/250.05MXN原生替换为2833，156.28+93.77，原2813 SUPERSEDED。此国家原币种精度2位，因此实际增量.03+.02=.05，取代此前预估四位.0313+.0187，未更改算法或精度。原UI随后显式确认A应付610=800CNY/base2000、B2672=136/base340、仅实际费用账单2882=100.02/base250.05，均冻结2.5；没有为暂估再建账单。原JPEG/AX与独立只读nativeAPI后核见release-mx-cost-fee-postcheck.json。2.0只在此窗口后新版本确认，用于后续真实部分付款，不重算以上历史。


bf998针对性候选同41迁移换包后，原CN应付来源页面已实际展示PO10BOX×100与receipt80PCS×10；只勾已确认收货1394生成草稿3003（CN-AP-BILL尾01）800CNY，再原按钮显式确认。再次来源选择该收货已耗尽、同canonical父1375只剩2BOX；没有1000账单、没有API代办、不改当地默认规则。真实JPEG/AX及独立只读后核见release-ap-receipt-selector-verification.json/release-cn-receipt-ap-postcheck.json。bf998是针对性候选，最终完整构建和同SHA运维仍待统一收口。

分摊页沿真实DTO补业务号优先/真实feeId与batchId回退，批次复用CostTraceDrawer追溯；不猜编号或改金额。实际setup先RED（undefined而非#2736）后3GREEN，typecheck通过，原业务对象未改。该前端修正在最终FE与真实页面回读中统一复验。


实际CN返货成本2293已按Oct16确认10CNY后，现行采购模板V2解释该SOURCE_CONFIRMATION时暴露FIN_AMOUNT_MISSING，原FAILED事件保留且0凭证。原owner无poId分支已明确无采购本金，但早退未投影模板引用的apAmount/differenceAmount；新增两个字段严格沿原确认值已知→0、未知→null，估值/raw/amount/costMissing不变，不设payableRecognition，不放宽renderer。原生PG先复现known return同模板缺字段、unknown explicitnull两项RED，随后65PG（CST37/Accounting19/Sources9）+5pure全GREEN；真实采购非零仍GENERATED、已知返货确认NO且唯一、未知成本和伪outboxzero仍拒绝，原source/COGS不改。见release-return-cost-confirmation-zero-verification.json。最终包后须重试同一FAILED2293，不能新造事件代替，当前bf998仍为修前候选。

采购本金归组真实未决风险：原native PG已新增且保留同一PO 2PCS×0.005=0.01、两次真实实收各1的两种账单场景。一张确认账单base0.01时，原两成本事件生成2202本金合计0.0200，明确期望0.01而proper RED；两张独立确认账单base各0.005时，各自账簿本金0.01、合计0.02对照GREEN。运行2项=1断言失败/0错误/0跳过，另5pure通过，日志及SHA256见evidence/release-purchase-principal-grouping-risk.json。未改生产归组、原事实或凭证，未skip风险测试；自动触发口径等待用户决定，不以此前65PG或修前完整候选消除此风险。

推荐路线目前仅只读设计：复用AP原bill/line冻结本位金额与rate、Supply原canonical claim/baseQty及AccountingAmounts.split，但现有claim只约束额度，没有CST实收数量对应哪张bill的不可变归组关系。若选择关联后自动记账，需要AP owner窄port及最小显式冻结关联/本金分配事实，不能把第二次容量claim塞进ap_source_claim；库存delta继续原唯一prefix。未关联/歧义/未知率应阻生成，成本确认仍可继续。已生成或已记账历史不重算、不按最新bill回填，纠正走原显式冲销/人工复核且留原版本/fact_hash；旧canonical claims无法无损倒推归组。尚未实施该路线。

bf998针对性候选实际CN会计后续：原成本页按Oct16确认SEA18/180、AIR10/100与返货1/10；来源Sep30/Oct16原日期不动。返货验货/账款/退款及两后收成本的五张CN凭证尾13–17，由独立user30原UI审核、user4记账；返货成本确认2293本身仍FAILED并等待上述窄补新候选。原报表实读收入231、成本110、期间费20、利润101，经营现金流252流入减退款21=231；资产1041=负债780+权益160+未结转利润101、试算1171=1171。原收入→6001贷252/借21→已记账3807→原完成退货2272路线已下钻，SECOND A28由原helper按bf998明确记录，不冒称最终包。

同阶段CN原核对AR170、库存570、现金231均与GL相等，应付业务910对GL690仍差220，原800账单与独立期初150/预付40可定位；未完成22PCS的时点承接未被伪造。原结账检查AP_DIFF、EVENTS_OPEN未通过、结账按钮禁用，无waive/无close；包含FAILED2293及其他原数量通知待解释。SECOND A26记录的是必要差异定位与阻断行为通过，不是本期已可结账。记录与JPEG/AX均绑定bf998，最终制品复验仍待用户口径决定后的统一收口。

上述“未决/只读设计/尚未实施”均为用户决定前的历史状态。用户现已明确选择：成本继续确认，无法对应已确认账单冻结本金时暂停新自动记账，显式关联后再生成。新增AP owner关联头/行及原成本页“账单依据”入口，不自动选择唯一账单，保存关联、确认成本、生成凭证分别操作；原canonical claim仍是账单来源额度，没有第二次claim。

本金分配复用AccountingAmounts.split：整张已确认账单按不可变原行顺序分配记账本金；每行按“累计含本次数量的本金前缀－已FROZEN实际本金”，末笔取实际剩余。DRAFT只占数量、不参与已使用金额前缀，因此后位先生成、前位草稿解除也不移动原冻结金额。原库存计价前缀不变。首次新解释才在原FIN事务绑定消费意图、冻结经济快照，再取owner fact、使用原renderer并保存原凭证/result/audit；既有结果在新hook之前幂等返回，仍复核当前来源/账套/字段权限。账单operational version不构成新的经济依据，旧凭证/result/fact_hash不重算或倒推回填。

关联适用边界：冻结原币、本位币或rate不兼容时继续等待人工复核，不把此差异都称为精度差或已实现汇差，不增加FX算法。期初AP/预付仍是原专用子账，不能伪造成PURCHASE账单；期初在途续接没有可对应canonical已确认账单时，继续等待或原人工复核，不重复形成期初AP、不按ref猜关联、不从GL反推。已知无PO返货确认继续原受控NO，未知仍null/costMissing。零价采购成本可确认，但原AP金额必须正数的规则不扩：无合法bill依据仍WAITING，不能补假零账单清gate。

本轮首次2个PG proper RED验证未关联仍生成/GET404，仓库安全查看1个proper RED验证预期200实际404，零价来源1个proper RED验证SQL CHECK而非业务拒绝；随后主112PG+5pure与附加多行账单/10BOX→100PCS两项2PG+5pure均通过。独立review继续发现反向result→FROZEN关联及CST正本金必须实际进入AP分类的两个约束缺口，正在补proper RED与窄修；当前不能把上一轮focused GREEN当最终冻结。新政策完整构建、42迁移审计、制品与原页面验收待总收口。见evidence/release-confirmed-bill-cost-assignment-verification.json，原风险RED日志不删除、不skip。

f3 focused原页面补记：原CN FAILED事件3626/source2293重试为NO_VOUCHER/SOURCE_CONFIRMATION_ZERO_POSTING，刷新仅一结果、无新凭证，失败阶段及原事件保留。MX付款3609、核销3618及既有收款/返货/退款/盘亏来源生成凭证尾15–24，经独立user30审核、user4记账；bill100CNY冻结250与付款200产生原核销汇差−50，没有重建业务。返货3700成本确认只记零额通知。盘亏10记1901待处理资产，没有称为期间费用。日记账224为84+100−21=163、232为68、334原CNY付款本位贷200。

同f3阶段原报表实读收入231/COGS332.30/期间费−17.66/利润−83.64，资产2078.75、负债2002.39、权益160、未结转利润−83.64；试算2611.05=2611.05。AR170/库存1797.75/现金31与GL相等，应付业务2450.05对GL1900.05仍差550，22PCS未完成时点承接继续阻断；CN220同类差异保留。opening supplier124对账单150与独立未分配预付40分开列示，不称对账单110。原账簿CSV68、供应商statement4401闭合936−100=836CNY、现金流252−221=31均实际导出，本人重新登录后下载；所有现有任务均SUCCESS，没有可点真实FAILED，UI旧会话失败重试分支未执行，另保留PG/隔离kill恢复证据，不制造失败。收入231→6001的168+84−21→已记账返货凭证→原完成来源3679已下钻。证据见evidence/release-finance-f3-ui.json，均为隔离合成focused候选，不冒称新政策已经部署或最终生产放行。

最后两项独立review已完成proper RED→GREEN并冻结源码：新增purchase CST结果必须存在同country/book/cost/event的FROZEN关联，原header→result deferred也保留，形成双向技术约束；原已存在结果不回填。新CST purchase的payableRecognition还须无条件验证实际reconcile_type='AP'分录净额等于冻结本金，不能用贷任意非AP科目的平衡凭证消耗关联。合法本金0尾笔不要求写零额AP分录，其他来源及原PRECISION_PAYABLE/GRNI对照未扩大约束。正确AP科目fixture明确配置核对类别，测试按AP语义求和，不再只按2202编码验证。

最终focused集中120PG（CST61/Accounting20/AP25/Sources9/Opening5）+5pure全GREEN，另1个不重复的原SQL诊断用例明确断言AP_COST_ASSIGNMENT_REQUIRED且事务完整回滚；总计本轮121个不同PG用例，旧112/附加2及重复pure不再次累加。V0139 SHA256为499c8e2b3b07671334717949b34cd7a47063907e6ff8360e51ab09764bd274b7。原生GENERATED/NO正例、raw SQL绕hook负例、AP净额、已知零、旧结果幂等、权限、并发void与末段回滚均通过；源码已冻结供唯一最终clean full、42合同审计及受控升级。新政策真实原页面尚未执行，既有f3图片/记录保留原SHA/前端阶段，不冒充42制品证据。

最后完整回归的M2旧夹具已按确认政策仅调整测试安排：原三次BOX3尾差链显式建立原生bill1及基础量3关联，继续验证.3333/.3334/.3333、每次库存核对与总COGS1；原采购至退款链先确认成本并保留完整source/COGS快照，首次生成明确CST_PAYABLE_BASIS_REQUIRED且无bill/result/voucher，然后才声明合成输入原PO来源4.5BOX=9PCS、45CNY/SETTLEMENT2.5、bill本金112.5及显式关联。原7事件/7凭证、同key重放、独立审核记账、数量/退款/原COGS及AR/库存/现金零差断言全部保留，AP改为该明确账单与GL本金同额。未改主代码或SQL，也没有自动推导账单。新外部regular-file export显式包含共用http-scenarios.json后，M2两项+契约8项=10PG及5pure全GREEN；原首轮full RED不覆盖，后续仍需唯一fresh full与42制品原页面验证。证据见evidence/release-m2-confirmed-bill-fixture-verification.json。

当前d1e3（42结构，完整528项由总收口确认）原页面新口径已执行独立CN合成链：PO4447的2PCS×0.005CNY，原国内/出口/空运4467及两实收4492/4523各1，成本4498/4530先确认；原事件4552首次生成明确CST_PAYABLE_BASIS_REQUIRED且无结果，保留FAILED诊断后才通过原应付来源创建唯一bill4560=0.01、原成本dialog各关联基础量1。反序先4530冻结本金.01生成4578、后4498冻结本金0生成4587；库存仍沿原固定prefix，分录分别费用+.01/AP+.01与库存+.01/费用−.01，因此第二笔本金0并不意味着逐项0，不错误免凭证。独立user30审核、user4记账两张，原三purchase LEGACY保持只读不回填。CN原库存41+18=59；核对AR170、库存570.01、现金231双侧一致，AP910.01对690.01仍差220，原22件未完成不变。新链全部CUA原页，未用API/SQL业务预填；详情与原执行FE归属见evidence/release-confirmed-bill-cost-assignment-native-ui.json。最后前端来源展开修正后仍须统一原终态只读复验/记录。

同d1e3真实独立worker重演已PASSED：沿原脚本新建1PG+S3，实际SIGKILL未提交effect、租约到期runtime-only恢复，单event/result/notice；当前撤权下载/重放403，新本人session显式retry同job成功，STALE/FAILED实际告警均已验证。原两准确owned容器独立inspect均不存在，slot交SYS容器验证；旧8b证据另档不改SHA。见evidence/release-worker-recovery.json及/tmp/closure-worker-final-d1e3.log。

最后前端原页只读复验发现并修正CostTraceDrawer与唯一原生cost-trace DTO不一致：原组件依赖不存在的batch/purchase/receipt/stock复合对象而空白。现在仅展示原cost、valuationHistory、asOf、unitCost及costMissing，来源行ID不冒充单据头；原srcUnit/srcFactor与基础数量明确区分，不在前端换算。被字段mask的成本不猜补，未知金额保持待补。成本来源/调整来源两个新下钻目标复用原授权列表和allRecords，仅来源定位分支跨页读取并精确匹配id+book；非法/错账套空而不退全量，旧query/国家/session响应不能覆盖。其它旧来源列表导航未扩展为通用定位引擎。纯成本只读费用页按原MD允许权限跳过可选项目引用，无权时用真实#expenseItemId，未扩大MD访问。新增原setup/模板proper RED后，成本相关55项focused全部GREEN、vue-tsc0；主代码/SQL及经济事实未变。原c51的UI截图/记录保留原指纹，最终FE构建重绑后再只读复验，不将这组测试替代浏览器通过。证据见evidence/release-cost-native-trace-ui-verification.json。

总收口独审另补来源定位旧筛选反例：PENDING_RATE/商品/仓库旧筛选不能遮蔽显式已确认成本来源；新proper RED后只在source定位分支清旧q/status/selection，仅按明确book读取原owner已授权列表再匹配真实id。普通列表原筛选分页保持。本轮最后针对性总数更新为56项全部GREEN、vue-tsc0；原55项属上一中间状态不重复累计，尚待总FE最终构建/指纹与实际只读复验。

最终285前端/cce59995与d1e3原页复验：Trace2521展示原BOX单价100/系数10、基础量30、原币300、本位750、截止单位成本30.209333333333及两变动156.25+.03；实际点击成本2522与调整2819各精确一行、PO592原详情，均新JPEG/AX。原分工20countrycase已原helper记录：MX7通过+A27主book6当前阻断，SECOND12终态复验通过，所有历史动作保留原执行制品归属。MX原收入231/成本332.30/费−17.66/利润−83.64、trial2611.05、现金252−221=31，核对AP550阻断；CNtiny后库存59/金额570.01、AR170/现金231零差，AP220仍阻断。20项本次只读终态与技术核对，没有重复经济单据。ROOT另明确授权独立无历史非经营CLOSE_REHEARSAL账套补当前制品A27正向原UI流程，准备/执行将独立列示，不能豁免主book6差异。见evidence/release-finance-final285-ui.json。

追加A27独立CLOSE_REHEARSAL补演在0配置/0grant/0经济写状态暂停：SYS原生API预检确认当前没有新增fin_book命令，不用SQL或新国家克隆绕过。原f2b阳性确属同一持久country3/book6、period17/18，snapshot1238/1239/1240/gen1及按原因Nov→Oct重开历史保留；ClosingService/View相对基线未改。当前285同book6 OPEN、已持久close_generation=1（下次native check显示代次2），但原ClosingView只持本次close响应快照，不能从OPEN页重新打开gen1/旧原因，因此不称当前已重新close/reopen，也不豁免AP550。最终20读核记录保持MX7passed+主A27blocked、SECOND12passed；全部财务UI请求已停止（tab about:blank、未logout），交ROOT协调非空恢复。

### A30 追加原页面二次命令（d1e3 / 最终 FE285，独立阶段）

ROOT 在原20个财务/SECOND案例读核完成后，明确授权新增隔离 MX 合成 A1 链补真实 UI 重复到账、核销和退款。原页面创建 order4718（MX-SALES-ORDER-20261016000008），customer96、SKU-A44、W1仓12、1PCS，原 CUSTOMER_SKU 成交价21MXN；按原人工审批及销售附件要求出库一次（OUTBOUND…000003），没有扩授信、改价或 API/SQL 业务预填。

- 收款 RECEIPT…000004：TRANSFER、fund232、21MXN，合成 PAYMENT_PROOF 先上传。两标签页都先加载同一 PENDING_CONFIRM 行，再依次点击原“确认到账”按钮（原页面没有确认弹窗）；最终两页均为同一已确认收款，之后该笔只核销一次。第二次按钮确实执行，但其即时 toast 未保存；误取首标签的 `receipt21-second-command` 文件不计入合格证据，另存第二标签最终已确认状态。这里不声称并行或 UI 已观察到具体 UUID。
- 核销 WRITEOFF…000004：两原弹窗在首提交前均选 RECEIPT…000004 / RECEIVABLE…000003 / 21；首次生效，第二原表单实际提交拒绝“核销超过应收未结金额”。原列表从3条到4条，未产生第5条。
- 退货 RTN-SALES…000002：仅自己 order4718 / OUTBOUND…000003 的1件，原审批、实收1、合格验货入W1、账款处理一次，COMPLETED、可退款21。
- 退款 RTN-REFUND…000002：TRANSFER/fund232、21MXN，原审批与 REFUND_PROOF v1；两原支付弹窗预加载同一单、Oct16及同一合成参考号。首登记 PAID，第二实际提交拒绝“退款未获有效审批或已支付”，最终只有该单21的一次支付登记，不涉及外部付款。

完整 JPG/AX、操作者/原单号/页面/步骤/哈希见 `docs/backend/evidence/release-finance-a30-native-duplicates.json`。它只提供三个真实命令的追加证据，不代 ROOT 把聚合 A30 判通过。ROOT 明确要求这组新增 FIN 事件保持待解释，不再生成/独审/记账；原20案例期末金额属于这组新事实之前，不能冒充当前期末。INV 的独立 order4864 与 ROOT receipt4748 是另有来源的合成事实，不用于掩盖或抵销本链差额。全部截图仍归属实际运行 d1e3/FE285，不随未来候选重贴 SHA。两财务标签已导航 about:blank，停止 UI/API 请求，供后续受控恢复窗口。

### 最终 0f242 / FE285 原页面读核与晚阶段分界

最终同库42制品 `0f24261156a434ce88dc830c08716838401ad18aa18711cf0815489182ed8439`、FE指纹 `cce5999554d752baa7bde4b9d2eba44ca97141bf3fb612cd658089f91aced1f2` 上，MX A21–A28八项与 SECOND 十二项（A01/A02/A04/A07/A08/A10/A11/A12/A17/A24/A26/A28）已逐原页面读核，并用原带flock工具追加20条当前包记录。旧169条历史记录保留原SHA；旧创建/确认/审批/独审/记账未为验收重放。证据与逐case准确语义见 `release-finance-0f242-final-ui-readback.json` / `release-finance-0f242-final-readback-spec.json`。

唯一新命令为ROOT明确许可的 receipt4918 原 event4929：两个原页先各加载PENDING，同本人4依次实际生成。首建 voucher5146 / MX-FIN-VOUCHER-20261016000025，真实状态 **PENDING_AUDIT**；第二页 toast “这张事件已经有凭证”并回同5146。未审核/记账，也未解释其余17个晚阶段事件。d1e3的18PENDING/0result独立readback是前阶段，不因新一条解释覆盖旧证据。

晚阶段原核对：MX AR170/170、AP2450.05/1900.05差550、库存1817.75/1797.75差20、现金31/31；收款待审21与尚未生成退款−21原列分开。ROOT新增 receipt4748 的 batch4791为1件、当前2.0冻结已知20MXN**暂估未确认**，另两个退货批次仍暂估。本次没有补0或自动清账。原关账检查真实执行，UNPOSTED/EVENTS_OPEN/AP_DIFF/INV_DIFF阻断，关闭禁用；COST_PENDING/RECON_DATA_MISSING通过，不能把已知估值暂估误写成金额unknown。已记账报表仍收入231/COGS332.30/费用−17.66/利润−83.64、现金252−221=31、资产2078.75、试算2611.05平衡；这些明确只是**已记账口径**，不是声称全部晚阶段业务已解释。A57（W1 45/W2 12）/B68另引用INV原页面读核。

CN没有新经济命令，原tiny4530/4498冻结本金.01/0、原凭证4578/4587均POSTED，LEGACY1934无回填。本位库存570.01/数量59；AR170、CASH231核对零差，AP910.01/690.01差220继续阻断；已记账利润101、资产1041.01/负债780.01/权益160、试算1171.01保持。复制模板待复核项没有为验收自动启用。

A27此次按ROOT批准作**分阶段passed**：早期同book6原f2b完整阳性操作保持原归属；新包原AuditLogList搜“结账”实际回读4条，并展开十月reopen17的原snapshotRefs1238/1240/1239、previousGeneration1及FACT_VALIDATED；SYS整历史表hash与原快照相同。当前仍OPEN、持久close_generation1，下次check代次2，不声称新包再次正向close/reopen，也不声称OPEN的ClosingView有历史snapshot浏览入口。

统计校正：旧d1e3完整528应为**521真实PG + 7纯Java**（InputBoundaryIT两项虽跑Failsafe仍是pure），之前523+5为collector分类错误。旧原报告不改写，此处追加校正；本轮浏览器不计入自动化用例数。

两财务标签已 about:blank，正式停止全部UI/API请求，未logout、未启动Maven/Docker、无main/test/SQL/FE变更。交ROOT/SYS安排非空financialGraph恢复窗口。
