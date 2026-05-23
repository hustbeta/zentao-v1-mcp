# Usage Guide

This guide is for users who have completed the quick start in [`README.en.md`](../../README.en.md). It covers the tool surface, common query usage, and write-safety semantics.

Chinese version: [README.md](README.md)

## Tools

The first version exposes 15 tools:

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

Tool signatures, scope-parameter exclusivity rules, and the resource enums for the generic tools are documented in [Design — MCP Tool Surface](../design/zentao-v1-mcp-design.md#mcp-工具面).

## Query Bugs By Execution

`zentao_list_bugs` supports product-level and execution-level queries. When both IDs are known, pass both for the most deterministic result:

```json
{
  "product_id": 60,
  "execution_id": 1510,
  "status": "unclosed",
  "assigned_to_account": "zhuxiaokun"
}
```

If only `execution_id` is provided, the server tries to infer the product before scanning product bugs locally. `status: "unclosed"` excludes only `closed`; it includes `active`, `confirmed`, `resolved`, and any other non-`closed` status the live API returns.

Execution-scoped queries scan the product bug list at page size 100, then filter execution, status, and assignee locally. The response exposes `source.scanned_total`, `source.scan_pages`, and `source.scan_limit` so callers can see the MCP-side scan cost.

For the full execution-scoped behavior and known ZenTao v1 API limits, see the [design notes](../design/zentao-v1-mcp-design.md#zentao_list_bugs-执行范围第一版边界). The architectural choice for the multi-step flow is in [Query Tool Multi-Step Decision](../design/zentao-query-tool-multistep-decision.md).

## Write Safety

Only build creation and build update are exposed as write operations. Both require `confirm=true` to send a real ZenTao request.

Without `confirm=true`, `zentao_create_build` and `zentao_update_build` return a dry-run summary with `requires_confirmation=true` and do not send an HTTP request. The summary includes the method, path, and a redacted request body so an agent or caller can confirm before committing.

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

By design no generic create/update tool, delete operation, or arbitrary HTTP proxy is exposed. See [Developer Notes — First-Version Boundaries](../dev/README.md#第一版边界) and [Design — Build Write Tools](../design/zentao-v1-mcp-design.md#版本写工具) for the boundary rationale.
