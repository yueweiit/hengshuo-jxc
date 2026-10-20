# M5 首次启用与历史范围的离线复核

`jxc-server/scripts/m5/readiness.py` 只读本地 manifest 与来源文件，不连接数据库、不调用业务 API、不导入业务数据、不授予上线批准。输出 `READY_FOR_REVIEW` 表示输入完整性和显式声明通过；`productionApproved`、`businessDataImported`、`sourceDataAuthenticityVerified` 始终为 false。签字人对来源真实性、基础配置、期初金额及业务范围负责；hash 只能证明本次读到的字节与声明相同。

首次生产沿用已有 `scripts/bootstrap.sh` / `BootstrapService`：准确目标、空库、操作者所有的 regular 0600 配置、单事务基础配置与脱敏审计。期初沿用 `/api/v1/fin/opening-balances` 的既有保存及确认流程，由操作者明确复核。不得为 M5 另建通用临时表或自动把演示浏览器数据库导入 PostgreSQL。未知期初继续待确认，不填写 0、不推断账户/汇率/成本。

## 输入和复跑

Schema 见 `jxc-server/scripts/m5/readiness.schema.json`；`readiness.template.json` 故意保留未确认字段，直接执行应被拒绝。JSON Schema 方便人工/编辑器审阅，Python 校验器另外检查真实文件 hash、来源唯一性和批次冲突。

```sh
python3 jxc-server/scripts/m5/readiness.py /absolute/private/m5-manifest.json \
  --previous /absolute/private/reviewed-prior-manifest.json
```

`--previous` 可重复，必须提供保留的全部已复核批次 manifest 及其来源文件；省略它只检查当前文件，不能声称已检查全局历史重复。工具不生成权威批次账本。同 batchId 的规范化 JSON hash 相同可复跑，改变映射、确认内容或来源文件声明即冲突；同 `(sourceSystem, sourceId, kind)` 换 batchId 也冲突。key 顺序不影响规范化 hash，数组顺序及路径声明属于批次内容。先在临时文件写审查输出，成功后由操作者封存，不覆盖原始证据。

`schemaVersion=1`，`mode` 为 `FIRST_START` 或 `HISTORY_REHEARSAL`。`sourceSystem` 是批次唯一来源系统，record 同名字段须一致。`files` 至少一项，`path` 相对 manifest 所在目录或使用绝对路径，文件须 regular、非符号链接；`sha256` 是真实文件字节的小写 SHA256。`records` 可为空，表示没有已确定的记录映射，不代表期初为零。每条映射包含来源标识、kind、三个正整数安全目标 ID 和已声明文件 hash；null、0、布尔或字符串 ID 均拒绝。工具不证明目标记录存在或国家/账套关系正确，映射还须由数据库只读核对。

审查后的记录样例（hash 和 ID 必须替换为真实证据）：

```json
{
  "sourceSystem": "legacy-reviewed-erp",
  "sourceId": "opening-CNY-2026-10",
  "kind": "OPENING",
  "targetCountryId": 101,
  "targetBookId": 601,
  "targetId": 9001,
  "sourceFileSha256": "<真实来源文件的64位小写SHA256>"
}
```

三个确认 `configurationReviewed`、`openingReviewed`、`demoExcluded` 都必须明确 true，并填写 `reviewedBy`、`configurationEvidence`、`openingEvidence`。`openingStatus` 只接受 `CONFIRMED` 或经明确复核的 `NOT_APPLICABLE`；未知/null 阻断。`NOT_APPLICABLE` 不能同时映射 OPENING。证据字段填写受控证据编号或路径，不写账号密码。manifest 应引用脱敏基础配置审查材料，不复制 bootstrap 明文密码。

`FIRST_START` 必须 `dataOrigin=PRODUCTION_CONFIRMED`，拒绝 DEMO/SYNTHETIC/UNKNOWN/null，也拒绝明显 demo/mock/synthetic 来源标识，仅允许 FOUNDATION/OPENING 映射，不能附带历史范围。`HISTORY_REHEARSAL` 必须额外提供独立 `historicalScope: {"description":"本次具体期间、国家账套、单据类型及排除范围", "reviewedBy":"范围复核人"}`；可以明确为 SYNTHETIC，但仍不允许把合成证据改名为生产验收。该模式只审核范围与映射，不代表历史已导入。真正迁移历史的实现及范围另行授权。

## 已有大表：约束与并发索引分步

旧 Flyway V001–V007.3 是既有基线，不修改文件来规避 checksum。已有大表新增约束或索引须先只读清点坏数据和重复来源、取得独立目标及停写/在线变更许可。以下只是隔离演练示例，不在应用的自动 Flyway classpath：

1. 在明确的空隔离库手工执行 `jxc-server/scripts/m5/examples/online/prepare.sql`。它只生成命名为 `m5_online_example` 的合成运维样本，并以 `CHECK ... NOT VALID` 添加约束。真实 FK 同样先 `ADD CONSTRAINT ... FOREIGN KEY (...) REFERENCES ... NOT VALID`；此后新写即受约束，既有行留到独立核对后验证。UNIQUE 不支持 NOT VALID，应使用下一步。
2. 仅将 `examples/online` 显式设为隔离 Flyway location，执行 `V900__rehearsal_index.sql`。邻接同名 `V900__rehearsal_index.sql.conf` 的实际配置为 `executeInTransaction=false`。不可加 BEGIN/COMMIT，不与常规事务脚本混在一起，不启用 `group=true`，不将示例复制进正式自动迁移目录。也可手工以 autocommit 单独执行同一 CREATE INDEX CONCURRENTLY；两种执行方式择一。
3. 核对后独立执行 `validate.sql` 的 `VALIDATE CONSTRAINT`，再将已建 unique index attach 为约束。记录 `pg_constraint.convalidated` 以及 `pg_index.indisready/indisvalid`。VALIDATE 会访问既有数据，仍须评估锁、超时、复制延迟和容量，不能把 NOT VALID 当成最终完成。
4. 并发建索引中断后先查 `pg_index`、`pg_stat_progress_create_index` 和 `pg_stat_activity`。若留下 invalid index，不能依赖 `IF NOT EXISTS` 假成功：排除仍在执行的建索引，确认错误/重复源已处理，在独立 autocommit 执行 `DROP INDEX CONCURRENTLY <准确无效索引名>`，再按原批准语句重建并核对。若用 Flyway 的非事务脚本失败，只有在检查部分执行状态并人工清理后才可对准确隔离库 repair，再重跑；repair 不会修复业务数据或索引。已 attach 的约束索引不能直接按无效独立索引删除。
5. 保存前后核对、耗时、索引/约束状态和失败恢复证据；隔离示例验证结束后显式清理 `m5_online_example`。正式大表表名、键列、锁预算和验证计划必须独立评审，不能套用合成样本的耗时作为生产容量结论。

本轮已在独立 `jxc_m5_online` / PostgreSQL 16.14 执行 24 步手工 autocommit 演练，见 [实际 DDL 证据](evidence/m5-online-ddl.json)。包括事务内 CONCURRENTLY 被拒绝、非事务成功、NOT VALID 对新负数即时拒绝和旧负数验证失败、显式修正合成数据后验证通过，以及重复源产生 invalid index 后删除和重建。演练表已清空，未触及 M4 或 M5 的 source/restore/rollback 库；没有执行 Flyway runner，因此相邻 `.sql.conf` 的框架加载行为仍不是本次实测结论。

## 与切换证据的关系

此工具的成功报告只是切换证据之一。上线仍须停写并等在途事务结束，最终只读核对，制作数据库与附件一致快照，验证恢复，然后只启用已核验的服务写角色，使用关闭 Mock 的原页面验收。原 `main.ts`、`retireMockWorker` 和生产构建边界继续复用。存在切换后新写入时，恢复和重放须按核验后的方案执行；切换环境变量回 Mock 不构成恢复。本工具没有环境切换开关，也没有调用恢复或业务写接口的能力。

本地验证：`python3 -m unittest discover -s jxc-server/scripts/m5/tests -p test_readiness.py -v`。测试使用临时文件，不读取 M4 已有业务数据库。
