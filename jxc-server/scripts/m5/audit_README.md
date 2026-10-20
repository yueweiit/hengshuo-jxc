# M5 只读数据清点

本工具复用 V001–V007_3 的 PostgreSQL 列、来源唯一键、国家/账套复合外键与余额约束事实；另识别 V008 的写入门闸。它不导入历史、不修复数据、不调用业务命令、不生成或过账凭证，也不创建数据库对象。

```sh
python3 scripts/m5/audit.py \
  --docker-container hengshuo-m5-rehearsal-postgres \
  --database jxc_m5_source --db-user postgres \
  --output /tmp/hengshuo-m5-private/audit-initial.json
```

也可直接运行 `python3 scripts/m5/audit.py --output /protected/audit.json`，通过 libpq 的 `PGHOST/PGPORT/PGDATABASE/PGUSER` 和受保护的 passfile/环境配置连接。命令行不接收密码或连接 URI；Docker 模式使用容器内的连接配置。不要将秘密写入 shell 参数、日志或文档。

仅依赖 Python 标准库、`psql`，Docker 模式另需 Docker。Python 3.9+、PostgreSQL 16 已验证。输出 JSON 同时写入 stdout；指定报告文件采用原子替换并设置 `0600`。不要把 stdout 重定向到公共目录。失败不回显原始数据库诊断，避免连接信息意外进入报告。

每次审计在一个 `REPEATABLE READ READ ONLY` 事务中完成，并设置 `row_security=off`。存在 RLS 时，必须使用能看到全部国家记录的审计账户；建议使用仅有 SELECT 权限、具备 BYPASSRLS 的专用账户。运行时角色产生的过滤结果会失败关闭。报告包含真实快照 ID、事务隔离级别、只读状态、逐表记录数、逐行异常及结构覆盖证据。金额/汇率等 PostgreSQL 精确小数按原值字符串输出，避免 Python 浮点丢失精度；ID 与计数保留整数。

退出码：

- `0`：执行完成且所有检查均无阻断。
- `2`：执行完成，但存在异常、待复核项、结构约束缺口或未验证检查。
- `1`：连接、执行、可见范围、结构/版本或报告写入失败；`findings` 为 `null`，不会伪造零异常。

`ATTACHMENT_OBJECTS` 在 SQL 审计中明确为 `UNSUPPORTED`，因此单独运行通常返回 `2`。切换检查可用同一冻结批次的 `recovery.py` 对象实际大小/内容 hash 证据消除此限制；不能把 SQL 元数据的 PASS 等同于附件实体已验证。

稳定检查代码：

- `SCHEMA_CONSTRAINTS`：核对合同内国家/账套外键的列顺序、目标表/列，以及来源唯一索引的列和部分索引条件。原 M4/M5 profile 保持原覆盖范围；closure profile 另核对完整捕获的列属性、CHECK、触发器函数体及下述目录对象。
- `DUPLICATE_SOURCE`：按现有唯一键的 NULL/部分索引语义逐条列出重复来源，不把允许拆分的来源一概判重。
- `NEGATIVE_BALANCE`：按已有非负分量检查余额。历史数据缺少必需余额分量时逐行保留 NULL 并列为 REVIEW。
- `OVER_OCCUPATION`：库存预留/冻结、应收应付消耗与来源额度的现有界限。
- `SCOPE_REFERENCE`：缺失或跨国家/账套的复合引用。原 FK 未包含账套而关联事实的账套不同时为 REVIEW；`sys_authz_epoch` 的全局哨兵 0 按 V001 明确语义处理。
- `HISTORICAL_RATE`：缺少历史汇率/本位币估值快照。PENDING_RATE 是原有合法待处理状态，以 REVIEW 列出，不改写或填 0。
- `HISTORICAL_COST`：缺成本来源、缺金额/单价或尚未确认的 ESTIMATED 成本。复用已有 `cst_cost_confirmation` / `cst_cogs_completion` 补齐事实；金额为负的返还事实不会仅因负号被判为坏成本。
- `EVENT_VOUCHER`：核查已有凭证解释及经过复核的 NO_VOUCHER 结果；缺少解释为 REVIEW，不能直接认定必须过账。审计不重新执行原业务取数提供者。
- `ATTACHMENT_METADATA`：附件有效/可用状态、元数据、活动链接与数据库明确要求的付款/退款凭证引用。未配置的其他单据附件要求不会被猜测为通过。
- `ATTACHMENT_OBJECTS`：对象存在性、大小与内容 hash 交给恢复工具；此处不支持。
- `WRITE_GATE`：V008 单例控制状态及所有业务表的准确 `jxc_write_gate` / `public.jxc_assert_writes_open()` 触发器，必须覆盖 BEFORE STATEMENT INSERT/UPDATE/DELETE/TRUNCATE。OPEN 或 FROZEN 均可完成日常清点；切换流程另要求 FROZEN。

`audit_contract.json` 是从现有 M4 迁移结构的只读 PostgreSQL catalog 生成的固定审计合同，不含业务数据、凭据、人员或期初值。390 个国家/账套复合 FK、21 个来源唯一键只保留一份 SQL 事实；即使 legacy 数据库已移除约束，清点规则仍然执行，约束缺失也会明确列出。只支持相同字段语义的 M4/M5 结构；不同老系统需要先制定映射，不能用本工具声称已清点通过。

验证：

```sh
python3 -m unittest discover -s scripts/m5/tests -p test_audit.py -v
```

测试使用独立随机命名 `hengshuo-m5-audit-test-*` PostgreSQL 容器及独立临时端口，完成后自动移除；不会改动 M4/M5 源容器。覆盖完整受约束 schema、约束移除后的逐行 legacy 异常、数据库数据 hash 不变、只读角色、RLS 拒绝、未知结构/迁移拒绝、NULL 余额、numeric(24,6) 大额精度、同名弱约束、真实 V008 冻结及伪触发器。无 mock 数据库或新增 pip 依赖。

## Release closure profile

`audit.py` selects a pinned profile from the complete successful Flyway version/script set. The original `audit_contract.json` remains the M4/M5 profile, including the explicit V008 addition. `audit_contract_closure.json` contains the full closure schema; closure has no allowed unknown additions. Unknown migrations, tables or columns fail before any zero-findings claim.

The closure contract is generated from a disposable PostgreSQL 16 database migrated with the release SQL. It records all table columns (including nullability, default/generated expression and identity), table CHECK definitions, foreign keys, non-expression unique keys, required triggers and their enabled state, function bodies, FORCE RLS and policy definitions. The SQL inventory compares those definitions, including immutability and the I/U/D/TRUNCATE statement write gate, instead of treating a matching trigger name as proof. Closure also requires the exact captured sets of columns, CHECKs, public functions, non-internal triggers and policies: an additional permissive RLS policy, for example, must not widen country visibility unnoticed. Legitimate extension functions are included in the captured set; there is no ignore list. Only the existing narrow PostgreSQL 16 literal unbounded-varchar ARRAY dump/reparse equivalence is accepted for expressions; constants and bounded casts stay exact. The legacy profile retains its original required-object checks.

`generate_audit_contract.py` reads only catalogs and refuses targets outside the explicit `hengshuo-m5-audit-test-*` container and `audit_closure*` database prefixes. Capture an independently migrated isolated fixture, review the generated diff and rerun `python3 -m unittest discover -s scripts/m5/tests -p test_audit.py -v`. Never capture an unfamiliar production schema to make an audit pass. Recovery backup and restored verification reuse the same profile registry and reject unknown migration provenance before claiming a complete recovery.
