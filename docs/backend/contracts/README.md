# M0–M4 契约基线

M0 已冻结原有 Mock 的公开表面，真实服务实施状态单独声明。目录、OpenAPI 和 Mock 回归通过不能替代真实 PostgreSQL、并发或登录后浏览器验收。

在 `jxc-web` 中运行：

```sh
node scripts/contracts/generate.mjs
node scripts/contracts/generate.mjs --check
node --test tests/contract-baseline.test.mjs
node --test tests/amounts.test.mjs tests/cost-inventory.test.mjs tests/finance.test.mjs tests/permissions.test.mjs tests/scenario.test.mjs
```

生成命令只写本目录下的 5 份生成 JSON；`--check` 不写文件，发现内容或注册次序漂移即退出 1。不要通过不审阅地重生成来接受权限、路径或财务规则变化。

- `route-catalog.json`：459 条有序注册、437 个独立 method/path；22 条后注册项被覆盖，56 条只读 CRUD 隐藏写入口仍登记 blocked。`registrations` 保留来源/顺序/覆盖及 `policyOperationIndex`；有效策略证据集中在 `operations`，避免复制同一份分析。
- `openapi.json`：OpenAPI 3.1 JSON。每项包含阶段、Mock/真实后端状态与权限、范围、字段、幂等、事实证据。保留现有 envelope；未复核 DTO 使用明确 unknown 描述，不以空对象暗示任意输入已获支持。
- `mock-regressions.json`：原 5 个测试文件的 101 个独立 test 调用点、111 个展开用例名、参数值、来源和 HTTP/直接 TS 分类。原测试不改动、不删除。
- `request-evidence.json`：页面/TS 的直接 http 调用和 createCrudApi 候选，以及文档 API 表格。动态路径、CRUD 简写、未注册和 blocked 分开记录；不是任意调用链的完备分析。
- `controller-mappings.json`：真实 Java Controller 注解的有界清点，支持字面量、数组路径、有限枚举正则的组合展开（含连字符）；与 M1/M2/M3/M4 声明逐路由比对，未知正则拒绝。它不是 Java AST 或策略推导，条件组合须继续核对服务实现。
- `m1-surface.json`：64 条实际映射、47 个复用 schema，手工复核的 M1 路径、请求/响应 schema、状态、实现证据及限制。`planned` 不是成功交付；已按实际 Controller/服务及精确测试方法引用复核。implemented-foundation 只代表基础代码已实现；证据中区分服务测试、HTTP 和浏览器。没有真实服务声明的业务操作继续 blocked。
- `m2-surface.json`：受控采购、物流、库存、销售、往来与退货退款主流程声明及精确 PG 测试方法引用，状态为 implemented-business-foundation。共用 schema 仅约束共享边界，来源特有必填字段和完整 DTO 仍以现有接口及服务校验为准，不能当作完整 SDK 生成输入。仅扫描到 Controller 的其他操作标记 registered-gated；注册存在不等于该动作已经验收。M3 成本分摊、调整及财务主流程的当前状态见独立声明，M2 文件保留历史范围。

生成器复用现有 TypeScript 编译器，不执行源代码来“推导”策略。支持 http 注册、命名数组、spread、crud.handlers(extra)、常量 map 动作与顶层 push/unshift。未知导出注册语法直接失败；一个聚焦测试把解析结果与真实 MSW 导出数组逐项比对，包含 AP 的后追加数组，防止静态解析安静漏项。相同 method/path 按首个匹配生效；路径模式之间的全部值域覆盖、条件策略和服务内数据流仍需人工复核，不能把 AST 当成安全证明。

共享 fixture 位于 `jxc-web/tests/contracts/http-scenarios.json`：7 个场景、8 次 Request/Response 断言，覆盖登录封装、字段策略、版本冲突、跨国拒绝、期间拒绝及幂等冲突目标。runner 调用现有 MSW resolver/handle 与 Request/Response；它不是网络部署验收，也没有复制权限、计价或期间算法。原有场景抽取只增加跨语言数据形式，不将其重复计为新业务覆盖；新增独立风险是同 key 不同 body 的明确契约缺口。

Java 测试可读取同一 fixture 的 `expect.backend`，并将演示逻辑 ID 映射到隔离测试库中受控创建的用户/国家/档案。M1 尚未开放的字段或期间业务路径仍属于后续阶段，必须拒绝或跳过并说明，不能篡改 fixture 让其假通过。现 Mock 通用 CRUD 不绑定幂等 hash，因此对应场景明确冻结 Mock 两次 200 与真实服务第二次 409 的不同目标；Mock 通过不等于真实幂等通过。

技术决策见 `../decisions/0001` 至 `0005`。金额/ID、唯一账套、零影响事件和敏感下载的边界必须先于相应业务写入实现。真实部署和生产数据迁移不在本次契约工作范围内。

- `m3-surface.json`：沿用共享边界 schema 的成本分摊/调整、映射、凭证、审核记账、冲销和核对声明；每项保留 Controller 与聚焦 PG 证据，不能把通用服务覆盖当成每条 DTO/HTTP 组合均已验收。此文件保留 M3 阶段交付快照，其中后续阶段的历史限制不能解释为当前 M4 状态。
- `m4-surface.json`：26 个显式操作，涵盖结账检查/差异确认/结账、反结账影响与执行、正式报表及模板复核、业务利润、导出任务/通知/工作台和审计查询。生成器将其与真实 Controller 逐路由比对；接口继续使用当前授权、范围、字段与幂等边界。AI 接口只声明受控的未配置/不可用行为，不代表已有外部模型分析能力。当前实现与实际 PG、构建、浏览器证据见 `../acceptance-m4.md`；单独的契约校验不代表目标环境全部页面或生产迁移已验收。
