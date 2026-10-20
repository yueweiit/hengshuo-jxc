# ADR 0005：契约证据与实现状态分开

日期：2026-10-15。状态：接受。

契约来源优先复用现有 MSW handlers、通用 CRUD、browser.ts 注册顺序、Vue 请求封装与原文档。M0 使用项目已安装的 TypeScript AST 解析，不新增业务算法或第二套业务服务器。

目录记录每一条注册及生效顺序，额外保留同 method/path 被覆盖的注册。`crud.handlers(extra)` 的 extra 优先，browser.ts 的 spread 顺序与顶层 `apHandlers.push(...apRest)` 都属于契约证据。运行时逐项比对防止静态解析漏掉注册。没有 editPerm 的 CRUD 写路径即使存在 handler 也标为 blocked；不能据此声称该写能力存在。

方法和路径可从受支持的注册语法确定；权限、范围、字段、幂等、DTO、错误和同步事实只能提取局部可观察证据。调用其他函数、条件分支和动态 DTO 的完整含义统一保留 unknown/reviewRequired。生成器不把函数调用名包装成完整安全策略。前端动态请求和文档 CRUD/省略动作也明确记录需要复核。

`m1-surface.json` 是显式评审的真实服务声明，包含状态、请求/响应 schema、实现证据与限制。`planned` 不代表已实现；`implemented-foundation` 只代表列出的基础行为，真实 PG、并发、浏览器验收仍分别报告。M2/M3/M4 的业务命令在 OpenAPI 继续标 blocked。无法完成的真实写命令应默认拒绝，不能回落到 Mock 或把请求写到临时通用表冒充业务成功。

原 5 个测试文件保持原样。`mock-regressions.json` 冻结 101 个独立 test 调用点、111 个参数展开名称及来源；参数值变化不算新增业务契约。共享 JSON fixtures 保存 HTTP 输入和常量期望，Mock 继续复用原解析器/授权/事务封装，真实 Java 测试消费相同语义数据，不把 TS 算法复制为 Java 的断言。已知 Mock 幂等 hash 缺口明确记录两种期望，Mock 的 200 不能算真实后端 409 通过。

兼容退出：Mock 仍供现有演示、原 111 回归以及双实现语义对照调用；保留到 M4 完成原 Vue 双国全链路和权限验收且生产构建关闭 Mock。切换前真实服务每条必需操作完成 DTO/权限/范围/字段/幂等/事实复核；删除条件是生产无 Mock 接管、全部调用迁移且原契约数据由真实测试覆盖。不能仅靠目录、HTTP 200 或编译成功就提前删除。
