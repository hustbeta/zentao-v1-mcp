# 使用指南

本文档面向已经按 [`README.md`](../../README.md) 完成快速开始的使用者，整理工具面、典型查询用法和写操作安全语义。

English version: [README.en.md](README.en.md)

## 工具列表

第一版暴露 15 个工具：

- `zentao_get_current_user`
- `zentao_list_products`
- `zentao_list_projects`
- `zentao_list_executions`
- `zentao_list_stories`
- `zentao_list_tasks`
- `zentao_list_bugs`
- `zentao_list_builds`
- `zentao_get_build`
- `zentao_create_build`
- `zentao_update_build`
- `zentao_list_objects`
- `zentao_get_object`
- `zentao_list_releases`
- `zentao_get_task_efforts`

工具签名、范围参数互斥规则、低频通用工具的资源枚举见[设计文档 — MCP 工具面](../design/zentao-v1-mcp-design.md#mcp-工具面)。

## 按 ID 查询对象详情

当用户已经提供具体对象 ID，并询问详情、内容或分析时，优先使用 `zentao_get_object`，不要先走同领域的列表工具。详情查询只需要对象类型和 ID，例如：

```json
{
  "resource": "bug",
  "id": 80793
}
```

`zentao_get_object` 支持以下详情资源：

| resource | 对象 |
| --- | --- |
| `user` | 用户 |
| `department` | 部门 |
| `program` | 项目集 |
| `product_plan` | 产品计划 |
| `product` | 产品 |
| `project` | 项目 |
| `execution` | 执行 |
| `story` | 需求 |
| `task` | 任务 |
| `bug` | Bug |
| `testcase` | 用例 |
| `testtask` | 测试单 |
| `feedback` | 反馈 |
| `ticket` | 工单 |

高冲突提示示例：

| 用户提示 | 推荐工具 |
| --- | --- |
| 查看 bug 80793 的详情 / 内容 / 原因分析 | `zentao_get_object` with `resource="bug"`, `id=80793` |
| 分析需求 123 | `zentao_get_object` with `resource="story"`, `id=123` |
| 看任务 456 详情 | `zentao_get_object` with `resource="task"`, `id=456` |
| 执行 1510 是什么 | `zentao_get_object` with `resource="execution"`, `id=1510` |
| 产品 60 的详情 | `zentao_get_object` with `resource="product"`, `id=60` |
| 项目 7 的内容 | `zentao_get_object` with `resource="project"`, `id=7` |

`zentao_list_bugs`、`zentao_list_stories`、`zentao_list_tasks` 等列表工具用于分页的范围列表；只有对象类型和 ID 的提示通常是详情查询。

## 按执行查询 Bug

`zentao_list_bugs` 支持产品级和执行级查询。已知两个 ID 时，建议同时传入，结果最明确：

```json
{
  "product_id": 60,
  "execution_id": 1510,
  "status": "unclosed",
  "assigned_to_account": "zhuxiaokun"
}
```

如果只提供 `execution_id`，服务器会先尝试推断产品，再在本地扫描产品 bug。`status: "unclosed"` 只排除 `closed`，会包含 `active`、`confirmed`、`resolved` 以及线上 API 返回的其他非 `closed` 状态。

执行范围查询会按页大小 100 扫描产品 bug 列表，并在本地过滤执行、状态和指派人。响应中暴露 `source.scanned_total`、`source.scan_pages`、`source.scan_limit`，可以让调用方了解 MCP 侧扫描成本。

完整的执行级 bug 查询行为和已知禅道 v1 API 限制见[设计说明](../design/zentao-v1-mcp-design.md#zentao_list_bugs-执行范围第一版边界)。多步流程的架构选择见[查询工具多步流程决策](../design/zentao-query-tool-multistep-decision.md)。

## 写操作安全

第一版只暴露版本创建和版本更新两个写操作。两者都需要 `confirm=true` 才会真正发送禅道请求。

没有 `confirm=true` 时，`zentao_create_build` 和 `zentao_update_build` 只返回带有 `requires_confirmation=true` 的试运行摘要，不会发送 HTTP 请求。摘要包含 method、path 和脱敏后的请求体，可以让 agent 或调用方先确认再提交。

```json
{
  "project_id": 1234,
  "execution": 1510,
  "product": 60,
  "name": "v1.2.0-rc1",
  "builder": "zhuxiaokun",
  "confirm": true
}
```

设计上不暴露通用创建或更新工具，也不暴露删除操作或任意 HTTP 代理。详细边界见[开发说明 — 第一版边界](../dev/README.md#第一版边界)，以及[设计文档 — 版本写工具](../design/zentao-v1-mcp-design.md#版本写工具)。
