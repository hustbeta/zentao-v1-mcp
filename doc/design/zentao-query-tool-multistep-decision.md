# 禅道查询工具多步流程架构决策

## 背景

`zentao_list_bugs` 需要支持按执行、状态和指派人筛选 bug。ZenTao v1 文档只提供产品级 bug 列表接口，没有文档化的执行级 bug 列表接口。因此执行级 bug 查询必须由 MCP 内部完成多步流程：

1. 确定产品范围。
2. 分页拉取产品 bug。
3. 本地过滤执行、状态和指派人。
4. 对过滤后的结果分页并包装返回。

现有 `resolveQueryToolRequest` 的职责是把工具参数解析成单个 HTTP `ToolRequest`。执行级 bug 查询不符合这个契约。

## 方案 A：把多步流程塞进 resolveQueryToolRequest

做法：让 `resolveQueryToolRequest` 同时承担请求解析和业务执行职责。

优点：

- 入口看起来集中。
- 调用方可能改动较少。
- 如果项目只是临时脚本，短期实现快。

缺点：

- 破坏 `resolveQueryToolRequest` 作为单请求解析器的语义。
- 其他 query tool 会被迫承受 bug 工具的特殊逻辑。
- 测试边界变模糊，难以区分是在测试请求构造还是完整业务查询。
- 后续再加入类似的多步语义查询时，解析器会持续膨胀。

适合场景：

- MCP 工具数量很少。
- 后续不会继续扩展复杂查询。
- ZenTao 单产品 bug 量较小，通常只有几十到几百条。

## 方案 B：把 resolveQueryToolRequest 改成联合返回类型

做法：让解析器返回 `SingleRequest | MultiStepRequest | LocalPipeline` 之类的联合类型，再由统一执行层调度。

优点：

- 架构最统一。
- 多步工具可以共享分页、重试、限流、扫描阈值、缓存和错误格式。
- 如果后续有多个跨接口语义查询，这个方向可持续。

缺点：

- 改动面最大。
- 会影响所有 query tool 的类型、注册和测试。
- 为单个 `zentao_list_bugs` 增强提前引入框架复杂度，收益不足。

适合场景：

- MCP 要长期演进成语义查询工具平台，而不只是禅道 API 包装器。
- 后续会增加多个多步查询，例如按执行查 bug、任务、需求、构建、提交等。
- ZenTao 单产品 bug 量较大，常见几千到上万条，需要统一成本控制。

## 方案 C：保持解析器单请求契约，给 zentao_list_bugs 单独高级处理函数

做法：`resolveQueryToolRequest` 继续只负责单个 HTTP 请求。`zentao_list_bugs` 在 `registerQueryTools` 中进入专门的高级处理函数，例如 `listBugs(...)` 或 `handleListBugs(...)`。

优点：

- 改动小，边界清楚。
- 不影响其他 query tool。
- 旧的产品级 bug 查询可以保持兼容。
- 执行级 bug 查询的多步逻辑可以单独测试。
- 后续若多步工具变多，可以再抽象成方案 B 的统一流水线。

缺点：

- `registerQueryTools` 会出现一个特殊分支。
- 如果特殊分支持续增多，后续需要再抽公共流水线。
- 第一版的扫描阈值、重试和缓存会先落在 bug 处理函数内部。

适合场景：

- 当前只明确要增强 `zentao_list_bugs`。
- 目标是先稳定支持 agent 按执行筛 bug。
- 不希望因为一个常用操作重构全部 query tool 基础设施。
- ZenTao 单产品 bug 量为小到中等，通常几百到几千条。

## 数据量判断

| 单产品 bug 数量 | 推荐方案 | 说明 |
| --- | --- | --- |
| 小于 500 | 方案 C | 性能差异很小，优先保持改动小和契约清楚。 |
| 500 到 3000 | 方案 C | 需要返回扫描成本字段，并准备保护阈值。 |
| 3000 到 10000 | 方案 C 或 B | 如果只有 bug 查询，先用 C；如果多步查询变多，考虑 B。 |
| 大于 10000 且频繁查询 | 方案 B 或服务端能力 | 解析器架构不能根治数据量问题，应优先寻找服务端过滤、索引或缓存方案。 |

## 当前决策

本次实现采用方案 C。

`resolveQueryToolRequest` 保持单请求解析器契约。`zentao_list_bugs` 的执行级和过滤型查询由单独高级处理函数负责。只有当后续出现第二个、第三个多步语义查询时，再考虑把这些处理函数抽象成统一流水线或联合返回模型。

实现时需要遵守以下边界：

- `resolveQueryToolRequest("zentao_list_bugs", { product_id })` 保持产品级单请求兼容。
- `execution_id`、`status`、`assigned_to_account` 等高级过滤参数不通过 `resolveQueryToolRequest` 完整执行。
- `registerQueryTools` 可以对 `zentao_list_bugs` 做专门分支，调用高级处理函数。
- 高级处理函数独立测试分页扫描、过滤、产品推断、返回包装和错误语义。

## 重新评估触发条件

出现以下情况时，重新评估是否升级到方案 B：

- 已有三个或更多 query tool 需要多 API 聚合。
- 多个工具都需要统一的扫描阈值、缓存、超时或重试策略。
- 单产品 bug 数量经常超过 3000，且用户频繁按执行过滤。
- `registerQueryTools` 中的特殊分支开始影响可读性或测试维护。
