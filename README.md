# 恒烁跨国进销存系统

采购物流、库存、销售、客户／供应商往来、退货退款、成本与内部总账的模块化单体。前端采用 Vue、TypeScript、Element Plus；后端采用 Spring Boot、Java 21目标字节码和PostgreSQL。生产访问真实后端，Mock仅供独立演示。

## 源码与文档

- `jxc-web/`：前端源码、独立演示、契约生成器和前端回归。
- `jxc-server/`：完整后端模块、42条数据库迁移、真实PostgreSQL集成测试及M5运维工具。
- `docs/`：业务规则、模块说明、验收定义和已复核接口契约。
- `deploy/production/`：通用容器交付、反向代理和受限小规模配置模板；实际环境参数与秘密放在仓库外。
- `docs/backend/evidence/scripts/`：通用隔离验收工具源码。运行结果不随源码发布；初始化方法见该目录README。

公开仓库以当前完整源码建立独立初始提交，保留所有现行模块和测试。旧的本机Git历史、执行快照、业务导出、生产配置、密码、密钥、数据库及附件不在公开历史中。测试和Mock内明确标识的合成数据用于隔离验证，不是生产资料。

## 本地验证

前端需要Node.js和npm；按锁文件安装依赖：

```sh
cd jxc-web
npm ci
npm test
npm run build
node scripts/contracts/generate.mjs --check
```

真实后端需要已配置的Java 21+、Maven Wrapper以及可用Docker：

```sh
cd jxc-server
./mvnw clean verify -Ppg-it
```

`pg-it`创建隔离数据库和对象服务，不读取生产数据库；Docker不可用时不能用跳过代替验证。初始化、外部数据库角色和秘密文件要求见[jxc-server/README.md](jxc-server/README.md)。运行应用不会自动建立演示账号、期初、库存或凭证。

## 发布对应关系

[源码与已部署制品的去敏核对记录](docs/releases/2026-10-20-source-binding.json)保存JAR、前端清单和源码输入摘要。应用源码与本次核对的线上版本一致；公开化只调整文档、现场模板、私有文件排除和未执行验收模板，不改变业务Java、Vue或数据库迁移。该记录证明现有制品字节与已验证构建输入对应，不声称不同构建环境能重现完全相同的JAR字节。

阶段能力以原[验收矩阵](docs/99-验收用例追踪矩阵.md)和`docs/backend/contracts/`为准。源码回归、隔离恢复、生产登录及实际业务验收分别记录。当前部署的财务记账和结账保持受限；未知期初不能补零。新环境应按其真实资料和授权配置，不继承现场人员、余额或密钥。

## 部署

参见[通用部署说明](deploy/production/README.md)和[启用检查清单](deploy/production/launch-readiness.md)。示例域名、空白身份、密钥路径及资源上限必须由部署人核实填写。迁移与长期运行身份分离，长期应用关闭Flyway；生产禁止Mock接管、回退和双写。
