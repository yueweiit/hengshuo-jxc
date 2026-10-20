# M5 数据迁移演练与上线门槛验收

本轮沿用已批准方案完成隔离合成数据的迁移前清点、来源映射复核、停写、一致备份、数据库和附件恢复、切换后新增数据的恢复与幂等重放，以及关闭 Mock 后的双国原页面验收。实际生产部署、真实历史迁移和期初确认不在本轮范围，未执行。原 M4 数据库未修改。

## 复用和变更

| 内容 | 复用与本轮实现 |
| --- | --- |
| 首次启用、期初和业务写入 | 继续使用已有 bootstrap、opening-balances 和业务 HTTP；不新增迁移专用业务写接口，不导入浏览器 Mock，不补造期初。 |
| 只读清点 | 固定现有迁移的结构合同，检查来源唯一性、国家/账套复合引用、余额、占用、历史汇率、成本、凭证解释与附件元数据；RR READ ONLY，一致快照，全可见性不足或未知结构失败关闭。精确小数保留字符串，NULL 原样保留。 |
| 停写 | V008 增加数据库级控制和追加日志。业务表 BEFORE STATEMENT I/U/D/TRUNCATE 触发器持控制行共享锁，冻结操作等在途事务提交后排他转换；运行角色无权控制，旧 RR 写快照不能绕过。现有 API 异常处理返回稳定 503。 |
| 一致备份和恢复 | 复用 PostgreSQL pg_dump/pg_restore 与已有 S3 attachment storage_key。同一导出快照生成 dump、全部表摘要、结构/约束/ACL/RLS/索引/序列和附件引用；逐个验证附件大小/hash。单事务恢复到新空库、空 bucket，准确目标与独立 manifest hash 必须匹配。 |
| 切换与恢复 | 原 Vue 生产构建继续使用现有请求和路由；恢复服务只持 runtime 凭据并禁用 Flyway，保留旧源冻结。切换后新增事实使用新快照恢复，并按原幂等键重放，不切回 Mock。 |
| 统计与证据 | 扩展既有 M4 统计、验证脚本的 `--phase m5`，保留 M4 默认入口；没有另建一套验收引擎。生成结构合同、截图和 JSON 证据单独计数。 |

旧 Flyway V001–V007.3 未修改。实际恢复发现旧递归 JSON CHECK helper 在 pg_restore 空 search_path 下不能解析自身调用，V008 显式固定其 search_path，并以真实 PG 红绿验证，保持原 ID 校验语义。

没有删除业务功能、Mock 离线入口或原测试；其兼容退出条件继续按原方案执行。本轮新增 49 个文件、修改 7 个、删除 0 个；另新增统计/验证清单 2 个，共新增 51 个。具体分类行数由 [当前阶段统计](evidence/change-statistics-m5.json) 生成，包含业务、迁移、运维脚本、测试、文档、生成结构合同及验收附件的独立分类；两个清单自身另列，避免自引用。其中包含 11 张浏览器截图、结构合同和逐表/逐权限 JSON 证据，生成物增长单列，不计作业务功能规模。

## 实际演练

批次 `4e94920e-1381-4d8d-94d7-7e3e39a4a2dd`，PostgreSQL 16，全部为本地独立合成环境。真实业务来源只使用 M4 已有合成单据，不读取或迁移生产数据。10 条采购、物流、销售、退货退款来源映射均核对目标国家、账套与 ID；重复批次复核保持相同 manifest，不创建业务事实。[来源映射](evidence/m5/synthetic-source-map.json)、[复核输入](evidence/m5/provenance-manifest.json)、[复核结果](evidence/m5/provenance-review.json)。`READY_FOR_REVIEW` 不代表生产批准或来源真实性认证。

[最终只读盘点](evidence/m5/audit-initial.json) 的 ERROR 为 0，有 4 条 ESTIMATED COGS 待复核：每国销售成本 40.0000、退回成本 -10.0000。它们按既有暂估业务状态保留，列入明确处理清单，不改成实际成本、不填零、不凭审计生成凭证。生产历史迁移时须逐条取得原有成本确认/补齐事实或正式复核结论；这批合成暂估不能用来批准真实历史上线。SQL 对附件实体标为 UNSUPPORTED，由同批恢复的实际对象内容/hash 验证补齐。

初次冻结后恢复完整 170 张表、1,743 条有效约束、4 个引用附件；逐表数据摘要及结构一致。恢复比较中区分有效 ACL 与原始 catalog 表达式的等价表示，保留原始差异证据；失败目标保留诊断，未执行 clean 或覆盖。最终工具的 inventoryVersion=2 增加列 ACL、索引 ready/valid/live 和角色 replication 检查，拒绝把旧版 bundle 追认为这些新检查已经通过。[备份恢复与拒绝路径证据](evidence/m5-recovery.json)。

切换后通过原 HTTP 接口新增两笔 2026-11-15 采购草稿：MX `1000001304`、CN `1000001313`，各数量 1、金额 10。未提交、未记账。相同 key 返回相同 ID，改内容返回 409，非法数量返回 400 且无半成品/失败幂等残留。再次冻结后以包含新增草稿和幂等事实的新快照恢复到新空目标，再重放原 key；各国仍只有一张该日草稿、一个有效幂等记录。14 张已记账凭证、12 份快照与 4 个附件均保留。[新增写入恢复证据](evidence/m5/post-write-recovery.json)。

恢复校验期间持冻结控制行共享锁直到数据库、对象及回执校验结束，操作者提前解冻会等待；若目标已经解冻则拒绝。备份与恢复都不自动解冻、不清理失败目标、不覆盖已存在对象。同批回执重验重新读取现场，非空目标没有匹配回执不能收养。[运维入口](../../jxc-server/scripts/m5/README.md)。

在线 DDL 在另一个独立空库运行 24 步：真实验证 CONCURRENTLY 事务内拒绝/独立 autocommit 成功、NOT VALID 对新写约束、旧数据 VALIDATE 失败、显式修复合成样本后验证，以及重复来源导致 invalid index 后删除重建。未把示例复制到自动应用迁移中，也未实际运行 Flyway runner 加载 `.sql.conf`。[在线 DDL 证据](evidence/m5-online-ddl.json)、[首次启用及范围说明](m5-readiness.md)。

业务 runtime 不是 owner、superuser、BYPASSRLS 或 replication 角色；现场枚举登录角色、表/列 DML、成员继承、控制函数 EXECUTE 和连接。owner/admin 保留受信运维权限，ACL 与当前连接清单不能证明凭据由谁持有，不能声称数据库禁止所有特权维护写入。服务进程只传 runtime 数据源、关闭 Flyway，并保持旧源冻结。[最终角色现场证据](evidence/m5-writer-role-final-review.json)、[最终运行制品](evidence/m5/runtime.json)；早期 v3 证据保留为初次切换时点，不代替最终目标。

## 验证口径

- `./mvnw clean verify -Ppg-it`：344/344，40 类；真实 PostgreSQL 337、纯 Java 7，失败/错误/跳过均 0。较 M4 新增 11 个独立 PG 场景；普通 `@Test` 331，3 个参数化方法展开 13 次，不把展开数量当成独立需求覆盖。包括在途写等待、冻结先提交、新写拒绝、旧 RR 快照、角色限制、控制幂等、失败回滚、全表准确门闸及 pg_restore JSON helper。
- `npm test`：143/143；原 5 个业务 Mock 回归文件哈希不变，101 个调用、111 次展开保持。生产构建和接口契约检查通过。既有 Vite 大块提示保留。
- M5 Python 工具 46/46 方法通过：audit 11、readiness 7、recovery 22、write_gate 6；其中真实 PG 21、真实 MinIO 1、离线安全 24。内部参数组合不另计独立方法。实际命令、方法和日志摘要单列于 [运维验收清单](evidence/m5/operations.json)，不混入上面的 Java 344。
- 双国登录后的原页面、已结账报表、恢复后的新增草稿及来源附件关联，截图和逐项记录见 [浏览器验收](evidence/m5/browser.json)。4 个附件的授权内容下载及 hash 另经 [真实 HTTP](evidence/m5/attachment-http.json) 核对；未声称验证了浏览器下载目录中的文件。业务数据准备/重放通过真实 HTTP，未声称由 UI 逐步录入。[完整验证清单](evidence/verification-m5.json)。

未运行远程 CI，未部署生产，未确认真实期初，未导入真实历史，未执行真实付款。生产目标、历史范围、基础配置/期初确认、受限 S3 凭据、密钥托管、WAL/PITR、异地备份、RPO/RTO 与业务规模下的容量验证仍须按实际部署实施。未引用对象的私有孤儿不会擅自删除，本轮验证范围是数据库引用附件。外部 AI 提供方仍未配置，沿用受控不可用响应。既有 RuntimeRoleVerifier 的广义 schema 过滤需后续统一收紧；M5 恢复使用准确 `pg_` 前缀、仅允许 public 业务 schema 并拒绝 pgx 等额外 schema，当前恢复链受此检查保护。
