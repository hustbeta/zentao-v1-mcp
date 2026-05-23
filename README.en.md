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

## Further Reading

- [Usage Guide](doc/usage/README.en.md): full tool surface, execution-scoped bug queries, write-safety semantics.
- [Developer Notes](doc/dev/README.md): first-version boundaries, local verification commands, module layout.
- [Design Document](doc/design/zentao-v1-mcp-design.md): full first-version design.
