# zentao-v1-mcp

MCP server for ZenTao RESTful API v1. It runs over stdio and gives agents a small, documented tool surface for reading ZenTao data plus guarded build create/update operations.

Chinese documentation: [README.md](README.md)

## Quick Start

Use the package directly from an MCP client:

```bash
npx -y zentao-v1-mcp
```

The default command starts the stdio MCP server and is equivalent to:

```bash
zentao-v1-mcp serve
```

## Configuration

Create an example config:

```bash
zentao-v1-mcp init-config
```

Default config file locations:

- Windows: `%APPDATA%\zentao-v1-mcp\config.json`
- Linux/macOS: `~/.config/zentao-v1-mcp/config.json`

Example:

```json
{
  "base_url": "https://zentao.example.com",
  "account": "your-account",
  "password": "your-password",
  "timeout_seconds": 20
}
```

Environment variables override the config file:

- `ZENTAO_BASE_URL`
- `ZENTAO_ACCOUNT`
- `ZENTAO_PASSWORD`
- `ZENTAO_TIMEOUT_SECONDS`

Useful config checks:

```bash
zentao-v1-mcp validate-config
zentao-v1-mcp validate-config --login
zentao-v1-mcp print-config
```

`print-config` redacts secrets.

## MCP Client Example

```json
{
  "mcpServers": {
    "zentao-v1": {
      "command": "npx",
      "args": ["-y", "zentao-v1-mcp"],
      "env": {
        "ZENTAO_BASE_URL": "https://zentao.example.com",
        "ZENTAO_ACCOUNT": "your-account",
        "ZENTAO_PASSWORD": "your-password"
      }
    }
  }
}
```

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

### Query Bugs By Execution

`zentao_list_bugs` supports product-level and execution-level queries. When both IDs are known, pass both for the most deterministic result:

```json
{
  "product_id": 60,
  "execution_id": 1510,
  "status": "unclosed",
  "assigned_to_account": "zhuxiaokun"
}
```

If only `execution_id` is provided, the server tries to infer the product before scanning product bugs locally. `status: "unclosed"` excludes only `closed`.

See [the design notes](doc/design/zentao-v1-mcp-design.md#zentao_list_bugs-执行范围第一版边界) for the full execution-scoped bug query behavior and known ZenTao v1 API limits.

## Write Safety

Only build creation and build update are exposed as write operations. Both require `confirm=true` to send a real ZenTao request.

Without `confirm=true`, `zentao_create_build` and `zentao_update_build` return a dry-run summary with `requires_confirmation=true` and do not send an HTTP request.

## Development

Developer background, local verification commands, and first-version design boundaries live in [doc/dev/README.md](doc/dev/README.md).
