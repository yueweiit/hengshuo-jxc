# 单体容器部署手册

本目录复用现有模块化单体、前端、Flyway、worker 和 M5 恢复工具。公开仓库提供通用部署模板，不含生产主机、数据库身份、现场配置、运行数据、密码或证书。`erp.example.com` 是占位域名，部署前必须替换并核验实际归属。

公开源码与已部署制品的对应关系由 [源码绑定清单](../../docs/releases/2026-10-20-source-binding.json) 单独记录。测试通过、制品构建、实际部署、页面验收和业务放行分别记录；不能使用旧截图或旧测试替代当前制品验证。

## 部署边界

- 普通业务通过现有采购、物流、库存、销售、往来和退货接口操作，继续受原权限、审批、账套、国家生命周期、期间和幂等约束。
- 国家和账套表示经营归属，不限制供应商来源国或采购币种。中国供应商及 CNY 采购可服务于 MX 经营端；不需要为此额外建立中国账套。
- 财务暂未启用时，使用现有 [小规模 override](compose.configuration-preview.yml) 关闭会计 worker，通过原角色不授予记账、冲销、结账和反结账权限，并安装 [入口限制模板](host-proxy.nginx.conf)。普通库存执行及业务单据关闭仍沿用原接口，不能按动作名称一概拦截。
- 未知金额保持未知；真实主档、期初和未完业务使用原维护、核对及导入入口，不以虚构订单、收付款或零金额代替。国家／账套启用和开放期间不表示已确认零期初。
- Mock 仅用于独立演示和回归。生产构建使用 `VITE_USE_MOCK=false`，不得接管、回退或双写。

## 制品准备

1. 在受控构建环境执行后端 `./mvnw clean verify -Ppg-it`、前端 `npm ci`、`npm test`、`npm run build` 及契约检查。保留源码清单、完整结果和失败记录。
2. 将验证通过的可执行 jar 命名为 `app.jar`，与 `dist/` 放入仓库外的新私有目录。记录逐文件 SHA-256，构建后再从镜像提取并比对。
3. 使用 `--build-context release-artifacts=<私有制品目录>` 构建现有 `application-verified` 和 `gateway-verified` target。`application`／`gateway` 为源码重编译入口，新生成制品须独立验证。
4. 分别审核应用、网关、PostgreSQL 和对象存储镜像。`config.example.env` 只填写已审核的完整 `sha256:<64位小写hex>` 目标 imageId 或 `repository@sha256:<manifest摘要>`，不使用可变 tag 或短 hash。来源 index、child manifest 与实际 configId 分列记录。
5. 使用标准 Docker 构建代理能力，不将代理凭据或秘密写入镜像。

## 配置与身份

复制 [config.example.env](config.example.env) 到仓库外的运维私有目录，设置 `0600`，填写经过核实的镜像、精确数据库、网络、卷、bucket、worker 国家／身份及绑定端口。Compose 的空项检查必须保留。

[compose.yml](compose.yml) 承担应用、网关及一次性迁移；[compose.infrastructure.yml](compose.infrastructure.yml) 承担 PostgreSQL 与对象存储。两者使用同一个专属外部 backend 网络，不接入其他业务容器。应用、数据库和对象存储不发布公网端口，仅网关按已核定的 loopback 地址暴露。

小规模环境可叠加 [compose.small.infrastructure.yml](compose.small.infrastructure.yml) 和 [compose.configuration-preview.yml](compose.configuration-preview.yml)。四个长期服务总上限为 2.5 CPU／4 GiB；该预算需要结合实际请求、附件增长及宿主余量验证，不等于容量或性能验收。小规模设施保留完整 WAL 段归档，只取消定时切段；这不构成 PITR 或 RPO 承诺。

所有秘密由独立托管位置安装到仓库外 `0700` 目录，不提交、不打印、不通过命令行明文传入。Linux Compose 文件型 secrets 的 `uid/mode` 不保证转换宿主文件权限，须核验实际身份可读：

- 应用的 `runtime_password`、`bank_key`、`storage_access_key`、`storage_secret_key`：UID/GID `10001:10001`，`0400`。
- `migration_password`：同一迁移容器身份读取，只挂载到一次性 migrate 服务；长期应用不得持有 owner 秘密。
- 网关 `tls_certificate`、`tls_key`：UID/GID `101:101`，私钥不向其他身份开放。
- PostgreSQL 管理员和对象初始化身份：仅受控初始化时使用，依实际镜像身份核验，之后从长期服务移除。

`bank_key` 为独立托管的 32 字节 Base64 密钥。运行数据库角色不得拥有 SUPERUSER、BYPASSRLS、建库／建角色权限、关系所有权或高权限成员关系。角色创建与授权复用 [数据库初始化脚本](../../jxc-server/scripts/provision-db.sql)，owner 与 runtime 使用不同密码。

## 对象存储

现有 `Dockerfile.objects` 固定上游源码及安全补丁，通过原 S3/MinIO Java SDK 和 M5 `recovery.S3` 接口连接。部署前重新核定源码、补丁、构建记录、镜像漏洞和同镜像恢复结果，不能将本地安全构建称为官方发布镜像。

对象服务以 UID/GID `1000:1000` 运行。仅对全新、已确认归属的卷执行受控初始化，目录 `0700`，不使用其他业务卷或 `0777`。`object_s3_runtime.json` 由秘密托管服务安装，实际所有者 `1000:1000`、文件 `0400`，仅包含应用专用 bucket 的 Read/List/Write 权限，例如：

```json
{"identities":[{"name":"jxc-runtime","credentials":[{"accessKey":"<secret-store-access-key>","secretKey":"<secret-store-secret-key>"}],"actions":["Read:jxc-attachments","List:jxc-attachments","Write:jxc-attachments"]}]}
```

首次建 bucket 使用独立、短期初始化身份，建桶后移除该身份和初始化配置。长期对象服务只挂 runtime 配置，不传自动建桶参数。核验运行身份可读写本 bucket、旧初始化身份与匿名访问被拒、其他 bucket 及 bucket policy 操作被拒。

mini 的内部 HTTP／RPC 位于可信 backend 网络中；网关不代理存储，不发布对象宿主端口。现有关闭遥测、管理 UI、WebDAV、IAM、TUS 等参数保留；它们不提供同网 peer 隔离。附件可见性仍由原应用权限控制。

## 迁移与启动

1. 核验精确目标数据库、系统身份、专属网络、持久卷和私有 bucket；对旧目标不得重复 bootstrap 或清空。
2. 停写窗口和备份确认后，以独立 migrate 服务执行已审核迁移。`MigrationMain` 必须保持精确目标校验，禁止 clean、baseline 和乱序迁移。
3. 使用完整 schema 审计合同核对迁移历史、全表清单、列、约束、函数、触发器、RLS 和停写门，未知对象应使检查失败。
4. 启动长期应用，固定 runtime-only、Flyway-off、非 root、只读根目录和最小能力；核验 owner 秘密未挂载。
5. 只在 DNS、证书归属和 loopback 网关就绪后安装主机代理模板。保留固定 Host、TLS upstream 校验及清理外来 forwarded headers 的规则，运行配置检查后再 reload 专属站点。
6. 核验 HTTPS、readiness、真实登录、业务表单、角色／字段／数据范围及受限财务路径。仅健康检查成功不能证明业务配置、恢复或交易整链已验收。

## Worker 与日常运维

`JXC_WORKBENCH_WORKER_ASSIGNMENTS` 使用明确的现有国家／技术身份，不能借管理员满足就绪检查。财务未启用时会计 worker 保持关闭，其他作业仍按原当前会话、权限及数据范围执行。

记录最近成功时间、失败次数、积压年龄和告警；用隔离环境验证真实终止、租约到期、重启唯一效果以及本人新会话重试。内部告警记录不代替外部接收、值守和处置验收。日志轮转、磁盘容量、证书续期及密钥轮换各有明确负责人。

## 备份与恢复

默认使用独立故障域，分别落实全量备份、连续 WAL/PITR、对象保留、独立接收密钥及源秘密丢失后的解封。若业务明确选择临时本机策略，只能按现有 M5 的 `LOCAL_ONLY_TEMPORARY` 审核规则办理，不宣称主机丢失可恢复。

复用 [M5 运维工具](../../jxc-server/scripts/m5/README.md)，保留隔离目标前缀和准确白名单保护。生产目标单独核验身份，恢复前及持有目标 guard 后重复检查；恢复目标保持 FROZEN，完成原页面和财务核对后再单独授权开放。不要通过忽略未知表、重算历史成本或补零来获得通过结果。

实际演练分别记录空库机制、非空业务事实、源保留与源丢失的范围，以及备份停写、锁等待、导出积压和恢复耗时。合成演练时间不能代替生产 RPO/RTO。

## 启用前材料

使用 [通用启用清单](launch-readiness.md) 确认人员、审批、账套、汇率、计价、主档、期初和运行责任。各项能力按实际资料和授权单独启用；普通业务开放不自动授权财务记账或结账。生产现场证据、秘密和原始执行记录保存在非公开受控位置。
