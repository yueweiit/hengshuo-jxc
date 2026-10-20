# 恒烁进销存真实后端 M0–M5

本工程为 Spring Boot 4.1.1 / Java 21 目标字节码的模块化单体。基础权限、期间闸门和附件范围见 `../docs/backend/contracts/m1-surface.json`；M2 已接入采购物流、库存、销售、AR/AP、退货退款及必要成本来源，受控主流程契约见 `../docs/backend/contracts/m2-surface.json`。M3 增加成本分摊/调整、映射生成、审核记账、冲销与余额核对，契约见 `../docs/backend/contracts/m3-surface.json`。M4 结账/反结账、快照、正式报表与原 Vue 双国页面见 `../docs/backend/acceptance-m4.md`。M5 离线清点、停写、备份/附件恢复与切换演练入口见 `scripts/m5/README.md`，本轮验证与生产边界见 `../docs/backend/acceptance-m5.md`。正常启动没有演示账号、通配角色、凭证或期初数据。

构建需要已正确设置 JAVA_HOME 的 Java 21+、Docker（真实 PostgreSQL/MinIO 集成测试）及可执行 shell。Maven Wrapper 固定 3.9.16，采用 Apache 官方 3.3.4 only-script 脚本并核对发行包 SHA256；首次准备构建工具和依赖需要联网，已缓存后可显式 `-o`。当前机器实际使用 Java 26.0.1 / Maven 3.9.16，编译目标为 Java 21。macOS 的 /usr/bin/java 未必能找到 Homebrew JDK；在本机验证时显式设置 JAVA_HOME=/opt/homebrew/opt/openjdk/libexec/openjdk.jdk/Contents/Home，勿把这一机器路径写入部署配置。

```sh
./mvnw --version
./mvnw -Ppg-it verify
```

`pg-it` 通过 Testcontainers 创建隔离容器，不读取已有业务库；Docker 不可用时测试失败，不能把跳过或 Mock 回归当成真实 PG 通过。`compose.test.yml` 仅供手工本地隔离环境使用，要求显式提供三个 `JXC_TEST_*` 密钥变量；不会自动写角色、人员或业务数据。PG16 与 2024 年 MinIO 摘要是当前已验证的测试镜像，不能把它们当作已批准的生产安全基线。

外部数据库首先由管理员创建专用空数据库，显式执行 `scripts/provision-db.sql` 并填写准确 `expected_database`。该脚本只新建 `jxc_owner` 与 `jxc_app`，撤销 PUBLIC 的 schema CREATE，准备扩展；重复角色即失败。使用 psql `\password` 交互设置角色密码，不把密码放在 SQL 文件或 argv。迁移身份与运行身份必须不同；应用不持有 owner 身份、不继承 owner、无 superuser/BYPASSRLS/DDL。数据库所有者不能是 `jxc_app`。

仅在明确配置目标与密钥后运行应用：JXC_DB_URL / JXC_DB_USER / JXC_DB_PASSWORD 配置运行连接；JXC_MIGRATION_USER / JXC_MIGRATION_PASSWORD 配置 Flyway。附件另外要求 JXC_STORAGE_ENDPOINT / ACCESS_KEY / SECRET_KEY / BUCKET。参考 `.env.example` 的字段，实际 secret env 文件放仓库外；脚本不会自动 source 任何 env 文件。不要把已有业务库当成本地测试目标。

首次初始化是单独、显式、离线命令。先完成迁移并构建可执行 jar，操作者将 `scripts/bootstrap.template.json` 复制到仓库外，以 0600 权限填写准确数据库名、操作人/理由、币种、国家（含显式 locale/enabledModules，不猜启用模块）、主体、账套、管理员真实凭据、具体权限、全部字段策略及 COUNTRY_ALL 范围。模板全是空值，不含可登录密码或自动通过的授权；程序不推断财务配置，不生成期间、凭证、库存或期初。

```sh
# Set these through your operator-owned environment, never place passwords in command arguments.
export JXC_BOOTSTRAP_CONFIG_FILE=/absolute/private/operator-bootstrap.json
export JXC_APP_JAR=/absolute/path/jxc-app-0.1.0-SNAPSHOT.jar
./scripts/bootstrap.sh
```

该脚本要求显式 JXC_DB_URL / JXC_DB_USER，禁用 web 与 Flyway，仅启动 `bootstrap` profile；没有 Maven、下载或 Docker 启动。程序验证配置为当前用户所有的 regular 0600 文件、目标库名称匹配、库中没有国家/账号/币种，取得全局授权排他闸门后在一个事务内写基础配置和脱敏审计。密码由 Spring BCrypt(12) 哈希；密码原文只来自 secret JSON，不进入 argv、SQL 参数或审计。具体权限必须来自已有权限目录，拒绝 `*` 或模块通配；不自动填任何字段权限。重复初始化拒绝并保留原数据，末段失败全事务回滚。

`bootstrap` 是 POSIX 0600 文件模式入口；Windows 可在支持 POSIX 权限的受控环境执行。不要把 NTFS 文件当作已验证的 0600 文件。初始化成功后删除/妥善封存明文 secret JSON，正常启动不再启用该 profile。

配置和关系见 `../docs/backend/configuration.md`，分阶段验收见 `../docs/backend/acceptance-m0-m1.md`、`acceptance-m2.md`、`acceptance-m3.md`、`acceptance-m4.md` 与 `acceptance-m5.md`。银行原始账号另需 `JXC_BANK_ENCRYPTION_KEY`，不能复用测试密钥。Wrapper 行为依据 [Apache Maven Wrapper](https://maven.apache.org/tools/wrapper/index.html)；版本发行依据 [Apache Maven 下载页](https://maven.apache.org/download.cgi)。
