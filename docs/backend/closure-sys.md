# SYS / ORG 发布收口

本范围基线为 `0cea5ed`，实现位于共享 `codex/release-closure` 工作区。所有自动验证只使用新建的隔离 PostgreSQL / 合成资料；没有连接或修改原 M4 数据库，也没有清理业务数据。

## 当前状态（2026-10-17）

当前完整后端 `0f24261156a434ce88dc830c08716838401ad18aa18711cf0815489182ed8439` 已通过56类531项（524真实PG + 7纯Java），0失败/错误/跳过；新外部副本334项Maven源及共享HTTP fixture逐字一致，42迁移和合同未变。原库存流水查询3项proper RED/50 PG + 5 pure聚焦GREEN及独立review后，来源/日期筛选、分页总数和原类型/批次/操作者呈现已纳入该full；原COST遮罩、未知人员与GET无写入均覆盖。没有改库存写入、其他query kind、FE或迁移。

三方明确暂停后，原same42切包已真实完成：193全表及两序列逐项完全相同，42历史保留，未执行DDL/MigrationMain，旧65621和延迟探针86909退出后当时以PID86929运行新包/UP，runtime-only/Flyway关闭/原3秒worker恢复。见 `evidence/release-ui-stock-query-final-runtime.json`。下述非空恢复后当前PID为90551；此前d1的41→42升级记录仍保留原SHA，不给旧结果重贴身份。

同0f包默认source-loss逻辑恢复23.085秒、9项live安全测试通过（193表/50合成行/1附件）；财务表为空，不冒称非空冻结本金关联恢复。worker真实中断/过期恢复、当前撤权403和新会话retry亦通过，两准确容器和七进程已确认退出。同0f+FE285/cce59995新stage、应用镜像和容器验证12.532秒通过，183dist与jar逐字匹配，15本轮资源独立清理确认。三个新同包proof均以 `*-stock-query-final.json` 保存，旧d1证据已归档。

新增 `release-ui-financial-recovery.py` 保持15轻量安全测试及独立复核的原字节，已在ROOT/FIN/INV明确全员暂停后实际恢复非空UI财务图，31.994秒通过：冻结时193表4209行、两序列、19引用附件全部hash/replay一致，2FROZEN/2lines/2GENERATED/4凭证明细无断链。源保留，目标FROZEN核验后两个准确容器及私有目录清理；源仅本轮CAS OPEN0→FROZEN1→OPEN2，三技术对象实差异公开，非技术SHA84113952…17084保持不变，旧86929退出，新PID90551/UP/同0f及原3秒worker。见 `evidence/release-ui-financial-recovery-final.json`。这不是source-loss或生产RTO/RPO。A27历史快照/反结四整表与原f2b捕获hash相同；A30 d1原UI命令后的只读唯一效果另存，保留当时18PENDING/0新财务结果状态。ROOT后来在新0f原页面仅解释event4929生成待审voucher5146，旧readback不冒充此后状态。没有生产操作。

ROOT已完成同0f/FE285的50个case-country组合最新原页面记录，169条历史记录逐字保留；最终矩阵、源码/制品一致性和汇总由ROOT统一校验。本范围文档不代替原页面证据，真实生产参数与部署仍未放行。

## 历史候选与放行边界（下述“当前”指当时）

历史完整构建曾按Surefire/Failsafe插件归类，将不依赖PG的 `InputBoundaryIT` 两项误计为PG。总用例数和原XML不变；按实际依赖，d1的528项为521真实PG + 7纯Java。下述历史原计数保留该更正说明，不改旧日志或执行身份。当前50 PG + 5 pure聚焦没有包含该纯Java类，不受此更正影响。

当前 UI 已按 ROOT 另行授权切换为 `f3f24f007e62cc31f1f03fd01e2cfe495efdff4e7c493127c1f4bb65a1e07db7` focused candidate，PID45269/UP；该包 INV/SAL 52 PG + 5 pure 聚焦通过，含 FIN 已独立验证的无 PO 字段窄补，不合计为 full。实际41结构17项技术审计通过（92.618秒）；same41 jar-only 保留191全表、两序列和原历史，无DDL/MigrationMain，runtime-only/Flyway关闭，原3秒worker恢复。交接前 event3626/source2293仍为FAILED，后续重试由原UI操作者另记，不续用该交接状态。证据 `evidence/release-focused-runtime-candidate-f3f24f00.json` 明确 NOT_FINAL_FULL。采购本金口径现已由用户确认：成本继续确认，无法对应已确认账单冻结本金时暂停自动记账，显式关联后再生成；V013_9/42的AP关联两表及owner实现已完成FIN聚焦120 PG + 5 pure和追加1项直接SQL诊断，未合计为完整应用回归。最终42合同实际捕获并通过18项隔离PG审计（145.396秒），40项非Docker运维边界和12项验收工具测试全绿。合同SHA6c06c0b7a8de0c1f46a65a3ee9429423a4c4c7688d1193af9dc3aa49b2019057、V0139 SHA499c8e2b3b07671334717949b34cd7a47063907e6ff8360e51ab09764bd274b7。42尚未升级原UI库，最后full/同包ops/stage/生产仍未完成，旧records与492/8b证据不重贴SHA。详见 `evidence/release-schema-audit-42.json` 与 `evidence/release-ops-unit-42.json`。

### 前一候选窗口记录（其中“当前”指当时）

当前原页面运行的是 `bf99806f0691dc140e3a2ad112a6d653ca3eeafe33a41155e64475e57048f6e9` focused candidate，41 条迁移；71 个去重 PG 聚焦场景与 5 个纯计算场景通过，不能替代最后一次完整回归。其后新外部完整构建 `3ea03c17659fb3ad18ccb94c79dca1afdc6f8d6920339d03a18a1e1972e904fb` 通过 492 项（487 PG + 5 pure），属于原 CN 退货入库两个不适用金额字段修正前候选；该 owner 窄补随后 65 PG + 5 pure 聚焦通过，但尚未完整重验或换入 UI。更早 `8b0c955f9d16d3c091b18cb5c11e48641fa706190f07f9c50df3aa76780bc192` 的 482 项和逻辑/worker/API 演练是该 SHA 的历史候选证据，8b 容器从未开始；现有容器证据仍属于 6b434/39 结构，不能拼成当前制品通过。

新增真实经济 P2 仍阻上线：同 PO 两次实收各 0.005 的采购本金，若各自入库凭证贷 AP 0.01，则合计 0.02；但账单记账本金随合单/分单可为 0.01/累计 0.02，裸 PO 无法确定账单归组。ROOT 已向用户提交口径选择：推荐成本继续确认，未具备已确认账单对应关系时暂停自动记账；另一选择是保留原自动凭证，由原人工凭证复核尾差。两者均为待决定方案，不能猜测、不能把非零改成 NO_VOUCHER 或删除失败/历史事实。492 项候选、252 项前端结果及上述聚焦 GREEN 不能拼为当前 final；新 full、17 项结构审计、同包运维及换包继续暂停，待业务决定与对应修正冻结。

原合成验收库已保留全部事实从 39 升至 41，之后 bf998 仅同结构换 jar。生产未部署，真实生产参数和页面验收未闭合；最终验证命令、资源清理顺序及 A35/A36/A38 材料缺口见 [第六批运维收口](closure-sys-operations.md)。下文按发生顺序保留历史测试记录，历史段落中的“最终”只指当时冻结的候选，不能覆盖本节状态。

## 已实现

- `PUT /sys/users/{id}/grants` 在同一权限策略门、事务、用户版本 CAS 和审计中替换角色及数据范围。原独立 PUT 复用同一实现并保持公开兼容；用户授权页面只发送一个命令，演示处理器也复用原有权限校验。
- 门店创建通过 SYS `StoreFundAccountPort` 调用原 MD `FundAccountService`；删除 ORG 的资金账户原始 INSERT。账户与门店同事务，沿用 BANK_INFO WRITE、明确账套、主体/门店/币种及可选会计科目校验、加密和审计。
- 启动数据库角色检查复用 M5 role_audit 语义：精确 `pg_` 前缀、高权限角色成员关系，以及所有应用关系（含序列、索引等）的所有权。
- 国家配置、模板发布、复制向导、组织与账套、明确管理员选择、复制清单、复核、启用及独立版本升级均使用持久化真实接口。复制入口只调服务器注册的配置结构贡献器；FIN/MD/INV 贡献器按 `order()` 顺序执行。复制不带订单、余额、交易事实、人员绑定或银行账户；当地配置必须复核，审批草稿移除原人员 ID 和条件金额。
- 国家配置与受控期初允许 DRAFT，普通交易必须 ACTIVE；DISABLED 保留授权历史读取。应用 PeriodGuard 与数据库生命周期触发器共享这条边界。期初例外仅由锁定、已校验的统一导入批次建立，限定国家和截止日；普通客户端来源标记不能建立上下文。GL 首期间验证只接受 OPENING_GL 的截止日次日；提交时延迟投影校验只接受已完成批次的不可变行、来源占用与真实 GL 目标逐项匹配，不延长导入上下文。历史导出使用原有任务、当前会话和来源证明，只允许技术元数据写入。
- 发布/退役模板的配置及清单、已应用复制选择和已复核依据在数据库内冻结；允许原发布、退役、启用及新版本升级流程，不能用运行角色 SQL 改写已经确认的快照。
- 单据编号统一调用 `jxc_next_doc_number`，在原单据事务内原子发号。缺少规则时报配置阻断，没有生产默认规则。修改规则不清零计数；已发号不能改变重置周期；格式必须包含重置周期以避免重复。国家详情页可维护规则。旧单号不重写。
- 看单/抄送配置不扩大接收人的功能、数据范围或字段权限。抄送进入原工作台，并在读取时再次校验来源权限。限时审批代理不转移角色；实际执行人、原审批人、当前单据访问与代理有效期均校验并审计；撤销/到期不可执行。
- 用户下拉独立提供安全选项接口。权限目录显示已注册导入类型及全部现有原生命令代码，静态比对主代码的文字权限引用无遗漏；没有给现有角色自动增加权限。国家管理员按语义角色类型识别并保留旧编码兼容，不依赖本地角色名称。
- Bootstrap 检查所有应用表，只有明确的迁移历史、写入控制及其审计与初始授权门可以预先存在，不再仅检查三个基础表。
- 就绪检查通过 SYS 窄扩展调用 AP 原执行主体校验；自动应付配置失去当前权限、字段或范围后，国家页、就绪接口和启用均阻断。没有引入 SYS→AP 依赖。
- M5 增加独立 closure 模式及隔离目录生成器，保留旧 M4/M5 合同；未知迁移/表/列拒绝审计。全量外键、唯一键、FORCE RLS、策略、触发器及函数定义形成固定目录证据；恢复复用同一模式选择及目录检查，缺失外键也会拒绝备份。当前42迁移完整合同覆盖192张业务表、2482列、716个CHECK、662个外键、375个唯一键、594个触发器、304个函数和181个策略；真实18项PG审计及40项运维、12项验收工具测试通过，原41合同和旧审计日志独立保留。详见 `evidence/release-schema-audit-42.json` 与 `evidence/release-ops-unit-42.json`，不能只换hash冒称重新执行。
- V013_4 使受控原生期初保留真实截止日期：有截止日期期间时仍沿用原校验；没有时只接受首个 OPEN 期间恰好从次日开始，不补历史期间。库存、成本/移动、应收、预收 INSERT 及库存事件必须逐项匹配同事务的已校验批次、不可变来源行、来源占用和经济字段。原普通交易检查与应收/预收后续余额更新白名单保持原样；库存及采购/在途的后续原生业务由各所有者复用现有命令。

## 验证证据

下列按发生顺序保留各阶段原记录；历史段落的“最终”“当前”只指当时制品。通用文件名后续可能另有当前版本，历史身份以各阶段已归档日志和pin为准；最新0f/42及非空恢复结果以上述当前状态和专用文件为准。

- RED：`/tmp/hengshuo-closure-shared-red.log` 捕获缺失原子 PUT、账户写权限绕过、数据库角色风险、模板路由/表缺失与 Bootstrap 漏检。
- RED：`/tmp/hengshuo-finance-coordinated-red.log` 捕获 DRAFT 普通交易未拦截及不完整审批草稿可启用。
- GREEN：`/tmp/hengshuo-sys-final-green.log`，55 个真实 PG 测试通过：Authorization17、RuntimeRole4、Bootstrap5、FinancialConfiguration6、CountryConfiguration2、DocumentGovernance2、Workflow14、PeriodIdempotency5。包括完整 CN/CNY/Asia-Shanghai 模板流程、升级复核、禁用历史读、并发发号、代理撤销/到期、实际执行人及 CC 权限回收。
- 最新协作 GREEN：`/tmp/hengshuo-finance-release-green2.log`，92 个真实 PG 测试通过，包含重新编译后的 CountryConfiguration2 和 DRAFT GL/AP opening2；完整导入提交后普通交易仍拒绝。`/tmp/hengshuo-finance-release-green.log` 中 WorkbenchJobs12 与 PeriodIdempotency5 通过，覆盖禁用国家历史账簿导出和后台告警。
- 最终协作 GREEN：`/tmp/hengshuo-finance-review-green.log`（以主任务收录日志为准），107 个真实 PG 测试通过，新增覆盖已发布模板/复制结果/复核依据的运行角色篡改、原 Foundation 门店原子重放，以及 AP 已复核汇率/本位币/日期证明。
- 最后就绪集成 GREEN：`/tmp/hengshuo-ap-readiness-green.log`，38/38 通过，包含 AP 当前主体复核、国家/模板、原门店基础流程、MD、期初及历史导出。
- 语义管理员 RED `/tmp/hengshuo-admin-role-red.log` → GREEN `/tmp/hengshuo-admin-role-green.log`，24/24 通过；自定义角色编码配合 `COUNTRY_ADMIN` 类型可以启用国家，目录新增的原生命令不会扩大现有角色。
- 前端复用测试：`/tmp/hengshuo-sys-web-settings.log`，授权版本与权限场景合计 32/32 通过；账套选项改用授权范围内的 `/org/books`，按有效账套和所选主体筛选，最新类型检查与同组 32 个测试均通过。完整前端构建与浏览器验收由主任务统一执行。
- M5 RED：`/tmp/hengshuo-closure-audit-red.log` 明确拒绝旧合同不认识的新表；`/tmp/hengshuo-closure-recovery-fk-red.log` 捕获恢复遗漏外键检查。对应修复 GREEN：`/tmp/hengshuo-closure-recovery-fk-green.log`。36 个迁移目录的真实 PG 审计 14/14 通过 `/tmp/hengshuo-closure-audit-final-stable.log`；其余运维非 Docker 用例 33/33 通过：readiness7、write-gate6、recovery13、production4、seal3（`/tmp/hengshuo-closure-*-unit-final.log`）。后续 SQL 审查修正若发生，必须重新捕获目录并复跑。
- 前轮逻辑恢复实际使用当时冻结的 jar `fecec1c2565066e462b9e5c8bbf818e4492b2a888bed733baec57fcea49d6f42`。新建隔离源通过原 `MigrationMain` 完成 36 个迁移，原恢复核心备份/恢复 191 张表（含 Flyway）、44 行合成资料和一个真实引用附件。删除源容器及源密钥目录后，独立接收密钥解封、精确集群白名单恢复、重放验证和 9 个真实恢复安全用例全部通过，写门保持 FROZEN，演练 23.723 秒。新期初修正后的 jar 尚待主任务重新冻结，随后必须重跑；不能把此旧制品记录当作新制品证据，也没有把同机隔离演练表述为异地物理持久性或生产恢复。
- 上述演练暴露并修复两项运维兼容缺口：模板目录只对明确的 `jxc_period_closing_guard` 当前用户占位符绑定经过校验的运行角色，函数其余字节仍逐字比较；PG16 转储重解析生成列时，复用原约束规范化处理精确的常量 varchar 数组文本转换，保留原始目录差异。错误角色、不同常量及窄字符转换仍拒绝。对应生成表达式单元 RED/GREEN 为 `/tmp/hengshuo-closure-generated-expression-{red,green}.txt`。最终重新执行真实 PG 审计 14/14 与运维非 Docker 33/33 通过；`evidence/release-schema-audit.json` 固定当前完整迁移、目录、脚本及实际审计日志的哈希。
- 本轮真实期初边界 RED `/tmp/closure-opening-cutoff-red.log` → 所有者 GREEN `/tmp/closure-opening-cutoff-green5.log`（63 PG + 5 pure）。新覆盖首期间前一天的库存/应收/预收、后续 FIFO/核销、采购/在途与收货/节点更正，以及经济字段/单位换算漂移回滚。38 个迁移重新捕获后，审计 14/14 通过 `/tmp/hengshuo-closure-audit-final38-append.txt`（42.314 秒，保持正常前向迁移顺序），对应最新 `evidence/release-schema-audit.json` / `.txt`。
- 额外目录对象 RED `evidence/release-schema-extra-catalog-red.txt` 捕获 6 个真实漏报：额外 permissive RLS 策略、非内部触发器、public 函数分别被原审计与恢复预检接受。共享目录谓词现要求 closure 的这三类对象完整集合精确相同，合法扩展函数包含在原始捕获集合中；旧 M5 profile 保持原行为。最新真实 PG 审计 15/15 通过（66.636 秒），并验证移除额外对象即可恢复合法目录。合同与 38 个迁移字节未变；当前 `evidence/release-schema-audit.json` / `.txt` 记录本轮日志和工具/测试哈希。
- 最终 jar `f2b3439e5554dfc1e28a477368a8a8cd6323052ae56fa7b3b0b716c9607ed1e8` 的完整逻辑恢复重演已通过（21.696 秒）：38 个正常顺序迁移、191 张表、46 行合成资料、1 个真实引用附件及 1922 个约束恢复匹配，独立接收密钥、源容器/源密钥消失、精确外部白名单、写门 FROZEN、重放和原 9 项真实恢复安全测试均通过。当前运维非 Docker 单测亦 33/33 通过；全部本轮资源已清理。实际记录为 `evidence/release-logical-recovery.json` / `.txt` 与 `evidence/release-ops-unit.txt`，旧候选恢复记录另存并明确标识为候选。
- 同一最终 jar 的本地容器验证已实际通过（37.014 秒）：镜像提取 jar 与当前 183 个前端文件哈希一致，运行进程 UID 10001、网关 UID 101、只读根文件系统及 0400 密钥卷均实测；运行容器拒绝 owner 凭据，Flyway 关闭，真实 one-shot 迁移在只读精确历史预检后执行 0 项，错误数据库拒绝且迁移历史不变。HTTPS 使用新建合成 CA 严格验证，未受信 CA 失败，readiness 为 UP，外部 actuator 被阻断。`evidence/release-container-runtime.json` / `.txt` 明确记录手工 Docker 语义验证及生产 Compose 配置检查，没有执行生产 Compose 或生产部署；所有本轮容器、网络、密钥卷和临时密钥已清理。
- 随后独立复核发现原生库存单位登记与成本锁的新等待环，已获主任务授权完成窄修复。原实现四种跨仓并发均真实死锁；仅改共享商品锁后，首次使用的两种场景仍因唯一键等待死锁。现复用 MD 唯一单位登记能力，在同事务提交前按商品/单位顺序统一写入，两个正式入口共享一个事务资源与同步器，预览不登记。登记先于最终授权时限检查，新增延迟登记跨会话到期的 RED/GREEN，并保留提交登记失败时库存/成本/来源全部回滚。聚焦验证 64 PG + 5 pure 全通过，证据 `evidence/release-unit-usage-concurrency.json`；本次无 DDL。此前 f2b 恢复/容器证据仍仅对应该候选制品，新的完整构建与同制品演练由主任务重新冻结后执行。
- A34 原生只读 API 候选控制 19/19 通过：MX-only 用户的国家仅 MX，本国应付/门店/账套存在；读取已由实际 CN 页面建立的应付、预付、客户、账套 ID 和原页面成功导出任务 1111 的详情/下载链接、INCOME 账簿 194/期间 256 均拒绝且无数据，普通业务、导入列表、真实报表和 AI 历史接口在本国为 200、CN 国家头为 403。`evidence/release-a34-api-candidate.json` 明确是 f2b 候选的 API 层，未生成业务/导出/AI，也未记录任何 UI 通过。最终新制品及跨国附件/导出对象就绪后须重新执行相应控制。

- A35 本国日历聚焦 RED `/tmp/hengshuo-country-calendar-red2.txt`：11 个真实 PG 断言失败、0 个错误，捕获编号/订单/价格/店日报/分类日键/窗口及显式预留释放日期被宿主日期覆盖。复用既有国家时区规则提取 `CountryCalendar`，只在授权事务内计算业务日，同一事务使用一个 Clock instant，跨事务重新取时；授权到期和后台心跳仍使用数据库真实时钟。聚焦 GREEN `/tmp/hengshuo-country-calendar-green.txt`：53 PG + 5 pure，通过同一瞬间墨西哥 9/30、中国 10/1 及同事务跨午夜用例；FIN 独立只读复核无阻断。PUR/LGS 同类默认日期的两项断言 RED 后复用共享日历，最终组合 GREEN 为 `/tmp/hengshuo-country-calendar-combined-green.txt`，88 PG + 5 pure、0 失败/错误/跳过。当前 `evidence/release-country-calendar.json` 固定测试源码、受测源文件与三份 RED/GREEN 日志的哈希。本轮没有 DDL，显式历史来源日期和带 offset 的发生时间保持原值。
- 审批摘要 RED `/tmp/closure-source-pages-red.log` 后，原待办/已处理接口只投影冻结金额、原币种、旧规则版本和历史提交人/时间，并按单据类型复用 COST 或 ORDER_TOTAL 字段遮罩；不返回原始快照 JSON。COST_ALLOCATION 只配对冻结的 baseAmount/baseCurrency；COST_ADJUSTMENT 缺币种仍为未知。原审批、代理、来源访问权限没有扩大。
- 带 offset 期间边界与手工分摊摘要 RED `/tmp/closure-source-period-proper-red.log` 捕获 7 个真实断言失败、0 个错误。共享 `CountryCalendar.day` 将同一发生瞬间归到国家业务日，原时间戳不改写，物流/退货复用它校验期间。SEA 期初柜续接另捕获原期间错误；前向 V013_6 只允许匹配 COMPLETED 导入完整证明的原柜关闭，除 active_to/version 外全等，并对实际关闭时间的国家日执行原 ACTIVE/OPEN 守卫。技术 active_from 不冒充实际历史入柜时刻。组合 GREEN `/tmp/closure-source-period-combined-green2.log`：94 PG + 5 pure，包含 Calendar13、审批摘要/权限、原柜正向及篡改/关闭期间/重开负向；39 版本 M5 目录审计 15/15 通过，77.311 秒，记录于 `evidence/release-schema-audit.json` / `.txt`。
- 原审批模板的销售/退款下钻复用现有来源路由；退款通过原生 GET 打开只读详情，先前请求、国家/会话切换及支付表单可取消旧响应。附件仅使用原模块已注册的 bizType/category 和当前功能/字段权限；未知类别明确不可用，不发无效请求。聚焦实际模板测试 15/15、类型检查通过；准备 JSON 与这些测试均不作为实际 UI 通过。完整前端构建由主任务统一记录。
- `release-ui-restart.py` 默认仍只允许相同迁移字节换包；明确指定 V013_6 才接受受审计的 38→39 唯一追加，并调用原 MigrationMain，检查历史只追加一行、190 张业务表与序列不变，再以纯运行凭据启动延迟探针和恢复原 worker 参数。旧 f2b 页面数据、旧 browser records 与旧制品证据保留。先前全量候选因独立复核发现分仓命令遗漏显式日期而按主任务要求中断，已记录 interrupted，未宣称失败测试或完整通过；修复后的最终结果见下。
- 最终外部源码导出 `hengshuo-release-clean-fya8ge2a` 全新 `clean verify -Ppg-it` 通过：55 类、463 个展开用例（458 PG + 5 pure），0 失败/错误/跳过，原始 XML 哈希见 `evidence/release-final-backend.json`。最终 jar SHA 为 `6b434c671bc44e880120277a80b4a5fcd5dd81fd2100b99dee7f76579afd5cee`；FE 完整验证由主任务记录为 229/229、构建和合同检查通过。
- 同一制品已实际完成原 UI 库受控 38→39 升级。一次只读快照因可选 pgcrypto digest 不存在而在迁移前失败，旧 f2b 自动恢复，失败证据保留；改用 PG16 内置 SHA256，无新增扩展或 DDL，并用共享快照函数逐表校准。之后原 MigrationMain 只执行 V013_6 一项，全部旧迁移历史保持，190 张业务表及 2 个序列未变；新包延迟探针的全部 191 表及序列相同。最终 PID 5204、health UP、运行身份无迁移密钥/Flyway 关闭，原 3 秒后台参数恢复。`evidence/release-ui-schema-upgrade-runtime.json` / `release-ui-snapshot-validation.json` 固定实证。browser-run 仅绑定新制品并把旧 6 项通过重置待重验，所有旧 record 原样保留，未替它们改执行 SHA。
- 当时冻结的 6b434 候选制品完整逻辑恢复重演通过，23.159 秒，39 个迁移、191 张表、1922 个约束及真实附件匹配；源容器/源密钥消失、独立接收密钥、错误集群无 effects、严格允许目标、重放/FROZEN 与原 9 个恢复安全测试均验证。所有本次资源已清理，记录另存 `evidence/release-logical-recovery-candidate-6b434.json` / `.txt`。同制品 A34 API 正反向控制 19/19 也只属于该历史候选，未创建业务/导出/AI，不能代替浏览器通过。
- 最终同 SHA 的容器语义验证通过，12.342 秒，183 个当前前端文件及 jar 镜像提取哈希匹配；非 root、只读根目录、运行密钥隔离、Flyway 关闭、严格 CA HTTPS、错误 CA 拒绝、readiness、原 MigrationMain 精确 39 项历史/0 待执行/错误目标拒绝及 owner 密钥拒绝均实测。生产 Compose 只做配置检查；未部署生产，全部本次资源已清理。`evidence/release-container-runtime.json` / `.txt` 固定结果。
- 后续真实原页面暴露箱数/尺寸快照及收货确认历史缺项，INV 追加 V013_7 五个可空列，旧事实不回填；另 FIN 正在补同事件的受控 posting 金额与严格逐项零值解释。因此上述 6b434/463/229 及其同包演练保留为历史候选，不能重贴为下一制品结果。40 版结构合同已从独立 PG 捕获，包含 2459 列的可空性/default/generated/identity、707 个 CHECK、652 FK、583 trigger 与 295 function。真实列属性/CHECK 篡改、专用 NULL 追加均先 RED 后 GREEN，完整审计 17/17、99.958 秒，非 Docker ops 33/33、2.878 秒；39 审计单独保留。默认换包仍要求迁移逐字相同；39→40 明确只接受 V013_7 唯一追加，旧列逐表 hash/行数/序列全等、旧行五列均 NULL、新目录精确匹配完整合同，启动后再比较完整 40 版行 hash。此刻仅完成工具与隔离 PG 验证，原 UI 库尚未执行 39→40，下一完整制品、受控升级及同包演练待主任务冻结后执行。

- 后续会计组合验证发现原 DB 模式守卫拒绝 VOUCHER 模板下的受控零解释，按原信任边界追加 V013_8：应用原 owner 与唯一 renderer（含逐分摊项）负责金额，DB 只校验精确映射/来源版本、账套、固定解释依据与当前 FIN 消费事务，不另抄 SQL 计价。41 合同真实审计 17/17、108.192 秒，运维边界 34/34、3.494 秒。新外部 `clean verify -Ppg-it` 为 56 类、482 项（477 PG + 5 pure）全通过，源文件及导出 364 项逐字一致；制品 `8b0c955f9d16d3c091b18cb5c11e48641fa706190f07f9c50df3aa76780bc192`。
- 已实际在同一验收库完成 39→41 两项受控追加：旧 39 项历史全等、190 张业务表旧列及 2 个序列全等、五新列旧行全 NULL，完整 41 目录和延迟探针全列快照通过。PID 21280、health UP、Flyway 关闭、无 owner 密钥、原 3 秒 worker 参数恢复。browser-run 只重绑制品和最终 FE/env 指纹，50 项仍待实页重验，旧 records 不改写、不补 country/执行字段。8b 同制品逻辑恢复 23.989 秒及原 9 个 live 安全用例、FIN 后台恢复、A34 19 项 API 控制已通过并清理隔离资源；这些是候选结果，不能替代 UI 验收。实际原页又发现 AP 来源列表未投影已有确认收货来源，主任务授权窄补后统一冻结；尚未开始的 8b 容器验证暂停，已完成结果独立保存在 `evidence/release-ops-candidate-8b0c955.json`，不重贴未来制品 SHA。41 结构与本次原库事实保留证明继续有效。

## 变化与兼容

新增国家/模板/复核、编号规则/计数、看单及代理表，全部 FORCE RLS，并安装真正 I/U/D/TRUNCATE BEFORE STATEMENT 写入门；只增加前向迁移，不修改既有 V001–V008。新增结构贡献器、生命周期与导入上下文是模块间窄接口，不引入 SYS→MD/FIN Maven 依赖。

修改现有授权、组织编排、资金账户、审批、国家页面及 M5 审计/恢复。删除门店原始账户 SQL 和前端两阶段授权写入；未删除仍公开支持的独立授权 PUT。当前前端已迁移，外部消费者尚无完整清单，因此兼容接口保留至正式 API 弃用并确认外部调用消失。测试复用原 PG 基础设施和既有授权/审批/资金账户用例，新增的是独立业务风险，不是复制生产算法。

生成的目录快照与手写代码分开统计。SYS 没有引入第二套授权、财务账户、审批或工作台通知算法。尚未处理的邻接技术债：复制贡献器尚不支持的将来模块必须注册新的配置结构贡献器后才可复制；现有历史兼容 API 尚未进入正式弃用周期。生产上线、独立备份/恢复演练和已登录浏览器业务验收不由本文件冒充完成。

- 最终权限/导入窄复核修正：原 `SystemManagementService.write` 统一复用 `CountryLifecycle.requireConfigurationWritable`，DRAFT/ACTIVE 配置语义保留；DISABLED 的账号创建、资料、状态与密码重置均拒绝，历史读取不变，原国家复启路径仍单独受控。库存期初稳定来源身份为国家/账套/仓库/商品/原批号，截止日不再形成新来源；确认沿用原国家独占授权 gate、全行预校验和唯一来源 claim 原子事务，原 `inv_batch` 查询跨截止日覆盖旧已确认来源，未新增引擎或迁移。
- 来源键兼容调用者与退出：旧 `COMPLETED` 批次及 date-key claim 的调用者是原导入历史/错误详情与审计查询，随原审计保留策略保留且永不原地改写；旧 `VALIDATED` 批次由原确认入口按 `SYS_IMPORT_STALE` 失败关闭，原操作人应先取消，再以同一原始文件重新创建预校验、确认。新 attempt 继续保留原 file hash 与 previousBatchId，旧记录不变；旧待确认状态保留至操作人完成取消重验，退出条件为不存在未处理的旧 date-key VALIDATED 批次，不增加需未来删除的兼容写旁路。隔离 PG 已覆盖同源跨截止日并发、旧完成批次防重、同原始文件取消重验恢复、不同批号/仓库/账套及国家复启；focused 回归与最终全量/运维/真实页面验收分别记录。

- 2026-10-16 13:53 UTC：经三方暂停，bf99806f focused candidate 在原隔离验收库41结构上完成严格 jar-only 换包（PID29917/UP）。363源文件逐字匹配、41迁移与审计合同一致；190业务表、flyway历史及两序列完全保留，无DDL/MigrationMain，runtime-only/Flyway关闭/原3秒worker恢复。仅用于继续原UI验证，未宣称最终full/ops/browser通过；8b候选及39→41升级证据保留，browser历史记录未改。证据见 `evidence/release-focused-runtime-candidate-bf998.json`。
- 2026-10-16 14:19 UTC：外部 `hengshuo-release-clean-kbfcu8y_` 完整 clean verify 通过 56 类、492 项（487 PG + 5 pure），0 失败/错误/跳过；364 源文件及导出字节一致，41 迁移相同。制品 `3ea03c17…` 在原页面新发现的无 PO 入库来源确认字段修正前冻结，记录为 `evidence/release-backend-full-candidate-3ea03c17.json`；按主任务要求不进入后续审计/运维/换包，Maven token 已交 FIN 聚焦修复。逻辑清理 P2 已在原运维测试先 RED 后 GREEN（38 项非 Docker 用例），独立 ROOT/FIN 复核通过；最终真实清理与结构审计源码 pin 仍待新冻结后执行。
