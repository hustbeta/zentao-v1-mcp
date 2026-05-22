# Zentao V1 MCP Design

Date: 2026-05-22

## Goal

Build a ZenTao RESTful API v1 MCP server that lets AI agents query ZenTao data and perform the limited version-management writes needed by existing workflows.

The first version covers all documented GET endpoints under `doc/zentao_api_v1_doc`, but it does not expose one MCP tool per API endpoint. The MCP surface stays under 20 tools by combining high-frequency, agent-friendly tools with generic low-frequency list/get tools.

## Non-Goals

- Do not expose delete operations in the first version.
- Do not expose general create/update operations other than build creation and build update.
- Do not expose a raw arbitrary HTTP proxy tool.
- Do not support multiple ZenTao instances or profiles in the first version.

## Runtime And Distribution

The server is a Node.js and TypeScript npm package.

Primary user-facing run command:

```bash
npx -y zentao-v1-mcp
```

The default command starts the MCP server over stdio. The CLI also supports:

- `serve`: explicit stdio MCP server mode.
- `init-config`: write an example local configuration file.
- `validate-config`: validate effective configuration and optionally test login.
- `print-config`: print effective configuration with secrets redacted.

## Configuration

The server supports one ZenTao instance.

Configuration file locations:

- Windows: `%APPDATA%\zentao-v1-mcp\config.json`
- Linux/macOS: `~/.config/zentao-v1-mcp/config.json`

Example configuration:

```json
{
  "base_url": "https://zentao.example.com",
  "account": "your-account",
  "password": "your-password",
  "timeout_seconds": 20
}
```

Environment variables override the configuration file:

- `ZENTAO_BASE_URL`
- `ZENTAO_ACCOUNT`
- `ZENTAO_PASSWORD`
- `ZENTAO_TIMEOUT_SECONDS`

The effective configuration must never print or return the password or token in plaintext.

## Authentication

The server logs in with:

- `POST /tokens`
- Body: `{ "account": "...", "password": "..." }`

The returned `token` is cached in memory and sent to later requests in the `Token` header. If a request fails with an authentication-style error, the client may re-login once and retry the request once. The one-retry limit prevents an invalid credential or permission problem from becoming an infinite loop.

## MCP Tool Surface

The first version exposes about 15 tools:

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
12. `zentao_list_objects`
13. `zentao_get_object`
14. `zentao_list_releases`
15. `zentao_get_task_efforts`

This list keeps the exposed surface under 20 tools while still covering all documented read endpoints.

## High-Frequency Query Tools

All list tools support `page` and `limit` where the ZenTao endpoint supports pagination. Defaults are `page=1` and `limit=20`.

Scope parameters use explicit names instead of a generic scope object:

- `product_id`
- `project_id`
- `execution_id`

Rules:

- `zentao_list_stories` accepts exactly one of `product_id`, `project_id`, or `execution_id`.
- `zentao_list_tasks` requires `execution_id`.
- `zentao_list_bugs` requires `product_id`.
- `zentao_list_builds` accepts exactly one of `project_id` or `execution_id`.
- `zentao_list_releases` accepts exactly one of `product_id` or `project_id`.
- `zentao_list_executions` requires `project_id`.

The explicit ID fields make agent calls easier to read and map directly to the documented paths.

## Generic Low-Frequency Tools

`zentao_list_objects` provides low-frequency list coverage through a constrained `resource` enum. Supported resources include:

- `users`
- `departments`
- `programs`
- `product_plans`
- `product_testcases`
- `testtasks`
- `project_testtasks`
- `feedbacks`
- `tickets`

Some low-frequency lists are scoped by a parent object:

- `product_plans` requires `product_id`.
- `product_testcases` requires `product_id`.
- `project_testtasks` requires `project_id`.
- Unscoped resources such as `users`, `departments`, `programs`, `testtasks`, `feedbacks`, and `tickets` must not receive a parent ID. This keeps generic list calls explicit while still covering scoped GET endpoints.

`zentao_get_object` provides low-frequency details through a constrained `resource` enum and an `id`. Supported detail resources include:

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

The generic tools are deliberately enum-constrained. They are not raw path callers.

## Version Write Tools

Only build creation and build update are write operations in the first version.

`zentao_create_build` maps to:

- `POST /projects/{project_id}/builds`

Required fields:

- `project_id`
- `execution`
- `product`
- `name`
- `builder`

Optional fields:

- `branch`
- `date`
- `scmPath`
- `filePath`
- `desc`

`zentao_update_build` maps to:

- `PUT /builds/{build_id}`

It requires `build_id` and at least one update field. The accepted update fields mirror the create-build field set, because the local API document does not list a request body for the update endpoint. This behavior must be verified against a real or mocked ZenTao-compatible endpoint before claiming full compatibility.

Both write tools require `confirm=true` to send a real ZenTao request. Without `confirm=true`, the tool returns a request summary with:

- method
- path
- request body
- `requires_confirmation=true`

The summary must not include password or token values.

## Endpoint Registry

The implementation uses a small handwritten endpoint registry. The registry records:

- internal resource key
- HTTP method
- path template
- supported scope fields
- expected result key when useful

The registry is handwritten rather than generated from Markdown. The local documentation has encoding and formatting inconsistencies, so generated endpoint extraction would add unnecessary first-version risk.

## Module Layout

Recommended layout:

- `src/cli.ts`: CLI command parsing and process entry.
- `src/server.ts`: MCP server initialization and tool registration.
- `src/config.ts`: config-file lookup, environment override, validation, and redaction.
- `src/zentao/client.ts`: HTTP client, login, token cache, retry, URL construction.
- `src/zentao/endpoints.ts`: handwritten endpoint registry.
- `src/tools/*.ts`: tool schemas, parameter validation, and endpoint dispatch.
- `src/safety.ts`: write confirmation guard and redacted request summaries.

If a mature MCP SDK pattern recommends a slightly different split, the implementation may follow that pattern while preserving these responsibilities.

## Error Handling

- Missing configuration returns a clear config error and does not print secrets.
- Login failure returns a concise authentication/configuration error and does not print the password.
- Permission or not-found responses preserve the ZenTao error body and add the MCP-side resource and path.
- Scope conflicts, such as both `product_id` and `project_id`, fail before any HTTP request.
- Unsupported resource enum values fail before any HTTP request.
- Write tools without `confirm=true` return a dry-run summary and do not make an HTTP request.
- Token refresh retries at most once per request.

## Verification Criteria

Implementation is complete when these checks pass:

- `npm run build`
- `npm test`
- stdio smoke test for `initialize`
- stdio smoke test for `tools/list`
- `tools/list` confirms fewer than 20 exposed tools
- config tests cover config-file loading, environment overrides, URL normalization, missing required fields, and password redaction
- HTTP client tests cover login, `Token` header use, and one retry after token invalidation
- tool tests cover scope exclusivity, pagination defaults, resource enum validation, and endpoint path selection
- write-safety tests prove that `zentao_create_build` and `zentao_update_build` do not send HTTP requests without `confirm=true`
- confirmed build-create and build-update tests prove that POST and PUT requests are constructed correctly

## Open Validation Notes

The update-build API document does not include request-body fields. The design intentionally limits accepted update fields to the create-build-compatible field set until real endpoint behavior proves whether more fields are accepted.

The local API documents are treated as the authoritative endpoint boundary for this project. If a ZenTao deployment differs from those documents, compatibility should be handled as a later explicit change rather than hidden broadening in the first version.
