# M5 离线运维入口

这些工具复用真实 PostgreSQL 事实、约束、既有 bootstrap/业务接口和 S3 附件身份，不导入 Mock，不创建余额或凭证。首次启用及历史范围复核见 `docs/backend/m5-readiness.md`；本轮实际证据见 `docs/backend/acceptance-m5.md`。恢复工具只接受独立 M5 容器、数据库和 bucket，不是生产覆盖恢复命令。

先复制由操作者维护的配置到仓库外 regular 0600 文件。`recovery.py` 配置包含 `schemaVersion:1`、规范 UUID `batchId`、`source`、`target`；连接项是准确 `container/database/adminUser/ownerRole/runtimeRole` 与 `storage:{endpoint,bucket,accessKey,secretKey}`。数据库管理员、迁移 owner 与 runtime 是三个不同角色。不要将实际配置、dump、附件字节、恢复回执或令牌提交仓库；工作目录 0700、文件 0600。配置不自动 source shell env。

1. 用 `audit.py --help` 查看只读清点入口。完整可见性不足、未知列、缺约束或未知来源不能报告为无异常。清点输出原始 NULL 与逐行问题；待汇率、待成本或待财务处理逐条复核，不填零。
2. 用 `write_gate.py status` 取得当前 epoch。显式 `freeze` 排空先写事务；所有业务表的语句触发器持控制行共享锁至事务结束，冻结修改取排他锁，之后的新写入返回 `SYS_WRITES_FROZEN`。会话登录/登出、后台诊断、幂等重放也属于停写范围；已有会话的只读查询可继续。缺单例时失败关闭。运行角色不能修改控制或执行控制函数。操作者拥有 DDL 的身份是信任边界，冻结不能防止管理员删除触发器。

```sh
python3 jxc-server/scripts/m5/write_gate.py status --config /private/recovery.json \
  --expect-target exact-container/exact_database --output /private/status.json
python3 jxc-server/scripts/m5/write_gate.py freeze --config /private/recovery.json \
  --expect-target exact-container/exact_database --expected-epoch 0 \
  --batch-id <规范UUID> --operator <操作者> --reason <停写原因> --output /private/frozen.json
```

控制文件和数据库都必须匹配；不能用静态证明代替现场状态。`resume` 只是一项显式特权操作，不是上线批准；它要求准确目标、当前 epoch、batch、操作者与原因。只有最终核对、恢复验证及目标身份复核完成后再恢复目标写入，保留旧源冻结。失败时工具不自动解冻，也不自动删除部分目标。重复控制命令使用原预期 epoch 与完全相同内容，数据库只保存一次转换记录；输出文件须换新文件名。

3. 停写后再做最终审计。`recovery.py backup` 独立持有控制行共享锁，阻止备份期间解冻；另一个 RR READ ONLY 事务导出快照，同一快照用于 dump、逐表摘要、schema/ACL/RLS/触发器/约束/序列和附件引用。附件按原 storage_key 读取、逐个核对大小与 SHA256。只备份数据库引用的附件；对象存储中未引用的私有孤儿不擅自删除，也不能声称完成整个 bucket 归档。

```sh
python3 jxc-server/scripts/m5/recovery.py backup --config /private/recovery.json \
  --freeze-proof /private/frozen.json --expect-source exact-container/exact_database \
  --output /private/new-bundle
python3 jxc-server/scripts/m5/recovery.py verify --bundle /private/new-bundle \
  --manifest-sha256 <独立封存的manifest实际SHA256>
python3 jxc-server/scripts/m5/recovery.py restore --config /private/recovery.json \
  --bundle /private/new-bundle --manifest-sha256 <同一SHA256> \
  --expect-target hengshuo-m5-target/jxc_m5_restore --receipt /private/new-receipt.json
```

4. 恢复只允许准确新空目标和空 bucket；保留 owner/ACL/FORCE RLS，不使用 `--clean`、`--no-owner` 或禁用业务触发器。数据库恢复使用单事务。恢复后核对全部表、schema、约束状态、序列及附件 hash，仍保持 FROZEN。同批回执重跑重新核对实际目标，不能只因回执存在返回成功。若数据库已恢复而对象失败，保留目标和失败证据，改用另一个新空目标重新演练；不得盲目覆盖或用 Mock 接替。
5. 使用只持有 runtime 凭据、禁用 Flyway 的服务进程启动恢复目标（`SPRING_FLYWAY_ENABLED=false`，不传迁移密码），确认运行角色安全检查、写角色与连接清单，再显式解冻目标。生产构建 `npm run build` 不含 MSW worker，原页面验收要再次登录双国并验证账套、快照、来源与附件。测试 MinIO root 凭据不作为生产存储授权方案。
6. 切换后已有新写入时，旧 bundle 只是历史恢复点，不能直接覆盖回退。先再次停写当前目标，保留新增事实和幂等记录，制作新的一致快照并恢复到另一个空目标，核对后按原 Idempotency-Key 重放已确认的请求，验证没有第二份业务效果；不能切回 Mock，也不能丢掉新增事实。本轮隔离演练采用此完整恢复路线，生产 PITR/WAL 归档、跨服务增量重放及 RPO/RTO 要按实际部署另行确定。

所有后续 Flyway 新建可写表必须安装 `jxc_write_gate` 语句触发器；`WriteFreezeIT` 检查全表覆盖。已有大表约束/并发索引的分步例子位于 `examples/online`，不会自动进入应用迁移目录。

验证：`python3 -m unittest discover -s jxc-server/scripts/m5/tests -v`；其中审计测试需要 Docker/真实 PG16。数据库全回归继续使用 `./mvnw clean verify -Ppg-it`。

## 生产材料的制品与目标绑定

`production.py check --manifest /private/release.json` 继续复用原首次初始化清单和证据 hash 校验。生产清单中的 `applicationImage`、`gatewayImage` 是已审核的不可变镜像摘要；`targetHost`、`domain` 是实际生产主机与公开入口。六个证据引用仍为 `{path,sha256}`，文件保持操作者所有的 0600 权限。以下字段由实际执行和审核填入，不能由历史本地演练结果换贴。

镜像身份接受完整小写的 `repository@sha256:<64位小写hex>` 或 Docker 实际不可变 imageId `sha256:<64位小写hex>`；拒绝 tag-only、短 hash、空白和大小写变体。经典 overlay2 Docker 存储加载 OCI 后可能以 config digest 作为实际 imageId，不能假定它仍等于 Desktop/containerd 所见的 OCI indexId。所有证据仍与本次实际清单逐字匹配，不按相同 hash 后缀折叠 repository、index、manifest 或 config 等不同身份。

固定本机 imageId 不等于镜像已在 registry 发布。部署材料须另外保留源 OCI index → linux/amd64 manifest → config/layers 的完整来源链、compressed registry blob 摘要、config 的 rootfs diffIds，以及归档传输字节与实际加载的核验证据；不得把 config SHA 写成 `repository@manifest` 摘要。最终主机上的镜像及真实页面材料绑定其实际 inspect imageId，原 indexId 留在来源链中。本门禁格式检查与逐字证据绑定不替代上述传输、镜像字节及 jar/dist 实测。

- `recoveryEvidence`、`capacityEvidence`、`permissionReview`、`pageAcceptance`、`keyCustodyEvidence` 都要记录相同 `applicationImage`、`targetHost` 和非占位的 `reviewedBy`。
- `pageAcceptance` 和 `capacityEvidence` 还要精确匹配 `gatewayImage` 与 `domain`：原页面与请求 p95 经过这份前端及真实 HTTPS／代理入口。更换网关或入口后，须重新提供这两类验收；单独复核后端不能替代。
- `recoveryEvidence`、`permissionReview`、`keyCustodyEvidence` 还要携带与清单完全相同的 `targetAllowlist`，其中包含 `container`、`database`、`systemIdentifier`、`storageEndpoint`、`storageBucket`。它标识本次审核对应的生产数据库集群与私有对象存储；独立恢复主机的实际身份应另留在恢复过程记录中。这三类审核不依赖网关字节，不要求无关的 `gatewayImage`、`domain`。

容量的 `concurrentUsers`、`transactionRows` 必须为达到申请规模的正整数实测值；不接受布尔值、浮点估算、Infinity、NaN 或字符串。`p95Seconds`、恢复的 `rtoSeconds`／`rpoSeconds` 必须是有限非布尔数，并满足 p95≤2 秒及已确认 RTO／RPO 上限。源秘密目录移除、独立接收私钥和保管人检查继续执行；独立故障域仅能按下述明确决策延期。

原 A01–A38 页面记录仍使用 `browser:{status,operator,country,evidence}`：`status` 为 `passed`，`operator` 为真实操作者标识，`country` 为正整数国家 ID 或明确国家代码，`evidence` 为非空文本引用列表。双国、双店隔离的 `evidence` 也使用此列表；空白、布尔值、字典和 TODO／TBD／PENDING 等占位不能充作凭据。引用应可供审核人定位原截图、操作记录及版本归属；格式通过不替代其真实性核验。

通过结果仍为 `MANIFEST_VALIDATED` 且 `productionReleased:false`。本入口不部署、不初始化业务、不导入期初、不记账，也不恢复写入。单独验证本门禁可运行 `python3 -B -m unittest discover -s jxc-server/scripts/m5/tests -p test_production.py -v`。

## 明确人工决策下的临时本机备份

默认继续使用 `INDEPENDENT_OFFSITE` 策略；不填 `backupPolicy` 时，仍要求独立故障域及实际异地恢复证据。小规模首发确有人工决定暂缓独立备份时，清单可显式填写 `backupPolicy:{mode:"LOCAL_ONLY_TEMPORARY",reviewedBy:<真实审核人>,decisionEvidence:{path,sha256}}`。布尔开关、单独模式字符串或占位内容不能启用此策略。

`decisionEvidence` 必须是实际人工决策的私有 JSON 记录，包含相同 `mode`、`reviewedBy`、`targetHost`、`backupLocation`，以及可定位的 `decisionReference` 和具体 `reason`；其字节按 SHA 固定。清单必须如实填写 `backupIndependentFromSourceHost:false`，`backupLocation` 为仓库外、操作者所有的 0700 绝对本机目录，不能是根目录或待定路径。

`recoveryEvidence` 保持原制品和目标绑定，另填写 `physicalOffsiteDurabilityVerified:false`、`recoveryScope:"LOCAL_HOST_AVAILABLE"`、与清单相同的 `backupLocation`，并给出 `localBackupEvidence` 的以下引用：

- `sealedBackup:{path,sha256}`：该本机目录内真实保留的 0600 加密 CMS 备份包；门禁通过 OpenSSL 只读解析 DER/CMS，拒绝把明文改扩展名充作加密包。
- `unsealedBundle:{path,manifestSha256}`：该包实际解封的 M5 目录及其 manifest pin；门禁复用原 `verify_bundle` 核对全部载荷和附件，来源必须是本次生产数据库。
- `unsealReceipt:{path,sha256}`：原 `seal.py unseal` 的回执，必须为 `UNSEALED`、`databaseRestored:false`，且 SHA 对应上一个加密包。真实 M5 包只有经过原完整校验，才附带 `manifestSha256`、`batchId`、`source`、`bundlePath`；门禁逐项与解封目录核对。通用归档和物理 PITR 包保持原回执，不冒充 M5 包。
- `restoreReceipt:{path,sha256}`：原 `recovery.py` 的 `RESTORED`／`VERIFIED_REPLAY` 回执，manifest SHA 和批次必须与上述解封包相同，还需独立目标数据库和 bucket，以及 `constraintsValid`、`schemaMatches`、`allTableDigestsMatch`、`allAttachmentHashesMatch` 全部通过的核对。门禁不调用恢复，单独解密也不能证明数据库已恢复。

该策略只延期独立备份故障域。独立密钥保管人、接收私钥、源秘密目录移除验证、真实期初、人员权限和容量仍需原样确认；未知项保持阻断，不能借此策略写成已确认。临时策略通过材料核对时，输出 `acceptedDeferrals` 中唯一的 `OFF_HOST_BACKUP_DURABILITY`、`offHostDurabilityVerified:false`、`sourceHostLossRecoveryVerified:false` 和 `productionReleased:false`，明确本机恢复依赖宿主仍可用。
