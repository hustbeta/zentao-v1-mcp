# 禅道 V1 MCP 设计

日期：2026-05-22

## 目标

构建一个禅道 RESTful API v1 MCP 服务器，让 AI agent 可以查询禅道数据，并执行现有工作流需要的有限版本和需求写操作。

第一版覆盖 `doc/zentao_api_v1_doc` 下所有已文档化的 GET 接口，但不会为每个 API 接口暴露一个 MCP 工具。MCP 工具面保持在 20 个以内，通过高频、适合 agent 使用的工具和低频通用 list/get 工具组合覆盖能力。

## 非目标

- 第一版不暴露删除操作。
- 除版本创建、版本更新、需求创建、需求变更和需求其他字段更新这些专用工具外，不暴露通用创建或更新操作。
- 不暴露原始的任意 HTTP 代理工具。
- 第一版不支持多个禅道实例或多个配置档案。

## 运行时和分发

服务器是 Node.js 和 TypeScript npm 包。

主要用户运行命令：

```bash
npx -y zentao-v1-mcp
```

默认命令通过 stdio 启动 MCP 服务器。CLI 还支持：

- `serve`：显式启动 stdio MCP 服务器模式。
- `init-config`：写入一个本地示例配置文件。
- `validate-config`：校验最终生效配置，并可选测试登录。
- `print-config`：打印最终生效配置，同时隐藏敏感信息。

## 配置

服务器支持连接一个禅道实例。

配置文件位置：

- Windows: `%APPDATA%\zentao-v1-mcp\config.json`
- Linux/macOS: `~/.config/zentao-v1-mcp/config.json`

示例配置：

```json
{
  "base_url": "https://zentao.example.com",
  "account": "your-account",
  "password": "your-password",
  "timeout_seconds": 20
}
```

环境变量会覆盖配置文件：

- `ZENTAO_BASE_URL`
- `ZENTAO_ACCOUNT`
- `ZENTAO_PASSWORD`
- `ZENTAO_TIMEOUT_SECONDS`

最终生效配置绝不能以明文打印或返回密码、token。

## 认证

服务器通过以下接口登录：

- `POST /tokens`
- 请求体：`{ "account": "...", "password": "..." }`

返回的 `token` 会缓存在内存中，并通过后续请求的 `Token` 请求头发送。如果请求遇到认证类错误，客户端可以重新登录一次并重试该请求一次。一次重试上限可以避免无效凭据或权限问题变成无限循环。

## MCP 工具面

第一版暴露 18 个工具：

1. `zentao_get_current_user`
2. `zentao_list_products`
3. `zentao_list_projects`
4. `zentao_list_executions`
5. `zentao_list_stories`
6. `zentao_list_tasks`
7. `zentao_list_bugs`
8. `zentao_list_builds`
9. `zentao_get_build`
10. `zentao_create_build`
11. `zentao_update_build`
12. `zentao_create_story`
13. `zentao_change_story`
14. `zentao_update_story`
15. `zentao_list_objects`
16. `zentao_get_object`
17. `zentao_list_releases`
18. `zentao_get_task_efforts`

这个列表将暴露工具面控制在 20 个以内，同时仍覆盖所有已文档化的读接口。

## 高频查询工具

禅道接口支持分页时，所有 list 工具都支持 `page` 和 `limit`。默认值为 `page=1`、`limit=20`。

范围参数使用显式字段名，而不是通用 scope 对象：

- `product_id`
- `project_id`
- `execution_id`

规则：

- `zentao_list_stories` 只能接收 `product_id`、`project_id` 或 `execution_id` 中的一个。
- `zentao_list_tasks` 必须接收 `execution_id`。
- `zentao_list_bugs` 必须至少接收 `product_id` 或 `execution_id` 中的一个。仅产品级调用保持禅道原始产品范围响应。执行范围或带过滤条件的调用仍保留在同一个工具内，并在本地过滤产品 bug，因为禅道 v1 文档只声明了产品级 bug 列表。
- `zentao_list_builds` 只能接收 `project_id` 或 `execution_id` 中的一个。
- `zentao_list_releases` 只能接收 `product_id` 或 `project_id` 中的一个。
- `zentao_list_executions` 必须接收 `project_id`。

显式 ID 字段让 agent 调用更易读，也能直接映射到已文档化路径。

### `zentao_list_bugs` 执行范围第一版边界

- 不新增 `zentao_list_execution_bugs` 工具。执行范围 bug 过滤保留在 `zentao_list_bugs` 内，确保暴露工具面小于 20 个。
- 不新增原始 HTTP 代理工具来绕过缺失的已文档化执行级 bug 列表接口。
- 执行范围查询使用 `GET /products/{product_id}/bugs` 扫描产品 bug 列表，页大小固定为 100，并在本地过滤 `execution`、`status` 和 `assignedTo.account`。过滤结果按调用方传入的 `page`/`limit` 分页，包装响应暴露 `source.scanned_total`、`source.scan_pages` 和 `source.scan_limit`，让调用方知道 MCP 侧扫描成本。
- 仅提供 `execution_id` 时，MCP 会先尝试 `GET /executions/{id}`，读取实测存在但未文档化的 `products` 字段作为快速路径。如果该请求失败，或字段缺失、格式异常、不是唯一产品，MCP 必须回退到已文档化的 `GET /executions/{id}/stories` 和 `GET /executions/{id}/builds` 列表，并从其中的 `product` 字段推断产品。如果无法推断出唯一产品，MCP 返回可操作错误，要求调用方传入 `product_id`。
- 第一版状态枚举为 `all | unclosed | active | confirmed | resolved | closed`。`confirmed` 在真实禅道列表响应中可见，但本地 Bug 详情文档没有声明；因为线上 API 使用该状态，所以第一版支持它。其他实测存在但未文档化的状态码（如 `postponed`）不属于第一版枚举，直到后续有明确计划前，只能通过 `all` 或 `unclosed` 覆盖。
- `unclosed` 只排除 `closed`；它包含 `active`、`confirmed`、`resolved` 以及线上 API 返回的任何其他非 `closed` 状态。

## 低频通用工具

`zentao_list_objects` 通过受限的 `resource` 枚举覆盖低频列表能力。支持的资源包括：

- `users`
- `departments`
- `programs`
- `product_plans`
- `product_testcases`
- `testtasks`
- `project_testtasks`
- `feedbacks`
- `tickets`

部分低频列表由父对象限定范围：

- `product_plans` 必须接收 `product_id`。
- `product_testcases` 必须接收 `product_id`。
- `project_testtasks` 必须接收 `project_id`。
- `users`、`departments`、`programs`、`testtasks`、`feedbacks`、`tickets` 等无范围资源不能接收父 ID。这样可以保持通用列表调用显式，同时仍覆盖带范围的 GET 接口。

`zentao_get_object` 通过受限的 `resource` 枚举和 `id` 覆盖低频详情能力。支持的详情资源包括：

- `user`
- `department`
- `program`
- `product_plan`
- `product`
- `project`
- `execution`
- `story`
- `task`
- `bug`
- `testcase`
- `testtask`
- `feedback`
- `ticket`

通用工具刻意受枚举限制，它们不是原始路径调用器。

## 版本写工具

第一版只有版本创建和版本更新是写操作。

`zentao_create_build` 映射到：

- `POST /projects/{project_id}/builds`

必填字段：

- `project_id`
- `execution`
- `product`
- `name`
- `builder`

可选字段：

- `branch`
- `date`
- `scmPath`
- `filePath`
- `desc`

`zentao_update_build` 映射到：

- `PUT /builds/{build_id}`

它需要 `build_id`，并且至少包含一个更新字段。可接受的更新字段与创建版本字段集一致，因为本地 API 文档没有列出更新接口的请求体。在声称完全兼容前，必须通过真实或模拟的禅道兼容端点验证该行为。

两个写工具都需要 `confirm=true` 才会发送真实禅道请求。没有 `confirm=true` 时，工具会返回请求摘要：

- method
- path
- request body
- `requires_confirmation=true`

摘要不能包含密码或 token。

## 需求写工具

需求创建映射到：

- `POST /stories`

`zentao_create_story` 必填字段：

- `title`
- `product`
- `pri`
- `category`

可选字段：

- `spec`
- `verify`
- `source`
- `sourceNote`
- `estimate`
- `keywords`

需求内容变更映射到：

- `POST /stories/{story_id}/change`

`zentao_change_story` 需要 `story_id`，并且至少包含 `title`、`spec`、`verify` 中的一个字段。

需求其他字段更新映射到：

- `PUT /stories/{story_id}`

`zentao_update_story` 需要 `story_id`，并且至少包含 `module`、`source`、`sourceNote`、`pri`、`category`、`estimate`、`keywords` 中的一个字段。

`category` 限制为 `feature | interface | performance | safe | experience | improve | other`，`source` 限制为 `customer | user | po | market`，`pri` 限制为整数 `1..4`。`zentao_change_story` 和 `zentao_update_story` 分开暴露，因为禅道将内容变更和其他字段更新拆成两个接口；合并成一个 MCP 工具会引入多请求半成功风险。

三个需求写工具都需要 `confirm=true` 才会发送真实禅道请求。没有 `confirm=true` 时，只返回脱敏试运行摘要，不发起 HTTP 请求。第一版不暴露 `reviewer`、关闭需求、删除需求或任意 HTTP 代理。

## 接口注册表

实现使用一个小型手写接口注册表。注册表记录：

- 内部资源 key
- HTTP 方法
- 路径模板
- 支持的范围字段
- 有用时记录预期结果 key

注册表手写维护，而不是从 Markdown 生成。本地文档存在编码和格式不一致的问题，生成式接口抽取会给第一版增加不必要的风险。

## 模块布局

推荐布局：

- `src/cli.ts`：CLI 命令解析和进程入口。
- `src/server.ts`：MCP 服务器初始化和工具注册。
- `src/config.ts`：配置文件查找、环境变量覆盖、校验和脱敏。
- `src/zentao/client.ts`：HTTP 客户端、登录、token 缓存、重试和 URL 构造。
- `src/zentao/endpoints.ts`：手写接口注册表。
- `src/tools/*.ts`：工具 schema、参数校验和接口派发。
- `src/safety.ts`：写操作确认保护和脱敏请求摘要。

如果成熟 MCP SDK 模式推荐稍有不同的拆分，实现可以采用该模式，但必须保留这些职责。

## 错误处理

- 配置缺失时返回清晰的配置错误，且不打印敏感信息。
- 登录失败时返回简洁的认证或配置错误，且不打印密码。
- 权限或未找到响应保留禅道错误体，并添加 MCP 侧资源和路径。
- 范围冲突（例如同时传入 `product_id` 和 `project_id`）在发送 HTTP 请求前失败。
- 不支持的资源枚举值在发送 HTTP 请求前失败。
- 写工具没有 `confirm=true` 时返回试运行摘要，不发起 HTTP 请求。
- token 刷新每个请求最多重试一次。

## 验证标准

实现完成需要通过以下检查：

- `npm run build`
- `npm test`
- stdio `initialize` 烟测
- stdio `tools/list` 烟测
- `tools/list` 确认暴露工具少于 20 个
- 配置测试覆盖配置文件加载、环境变量覆盖、URL 规范化、必填字段缺失和密码脱敏
- HTTP 客户端测试覆盖登录、`Token` 请求头使用，以及 token 失效后只重试一次
- 工具测试覆盖范围互斥、分页默认值、资源枚举校验和接口路径选择
- 写安全测试证明所有写工具在没有 `confirm=true` 时不会发送 HTTP 请求
- 带确认的版本创建和版本更新测试证明 POST 和 PUT 请求构造正确
- 带确认的需求创建、需求变更和需求其他字段更新测试证明 POST 和 PUT 请求构造正确

## 待验证说明

版本更新 API 文档没有包含请求体字段。设计上刻意将可接受的更新字段限制为与创建版本兼容的字段集，直到真实端点行为证明是否接受更多字段。

本地 API 文档被视为该项目的权威接口边界。如果某个禅道部署与这些文档不同，应作为后续显式变更处理，而不是在第一版中隐式扩宽兼容性。
