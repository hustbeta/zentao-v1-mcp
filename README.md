# zentao-v1-mcp

禅道 RESTful API v1 的 MCP 服务器。它通过 stdio 运行，为 agent 提供一组小而明确的工具，用于读取禅道数据，并以受保护的方式创建或更新版本。

English documentation: [README.en.md](README.en.md)

## 快速开始

在 MCP 客户端中直接使用 npm 包：

```bash
npx -y zentao-v1-mcp
```

默认命令会启动 stdio MCP 服务器，等价于：

```bash
zentao-v1-mcp serve
```

## 配置

创建示例配置：

```bash
zentao-v1-mcp init-config
```

默认配置文件位置：

- Windows: `%APPDATA%\zentao-v1-mcp\config.json`
- Linux/macOS: `~/.config/zentao-v1-mcp/config.json`

示例：

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

常用配置检查命令：

```bash
zentao-v1-mcp validate-config
zentao-v1-mcp validate-config --login
zentao-v1-mcp print-config
```

`print-config` 会隐藏敏感信息。

## MCP 客户端示例

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

### 按执行查询 Bug

`zentao_list_bugs` 支持产品级和执行级查询。已知两个 ID 时，建议同时传入，结果最明确：

```json
{
  "product_id": 60,
  "execution_id": 1510,
  "status": "unclosed",
  "assigned_to_account": "zhuxiaokun"
}
```

如果只提供 `execution_id`，服务器会先尝试推断产品，再在本地扫描产品 bug。`status: "unclosed"` 只排除 `closed`。

完整的执行级 bug 查询行为和已知禅道 v1 API 限制见[设计说明](doc/design/zentao-v1-mcp-design.md#zentao_list_bugs-执行范围第一版边界)。

## 写操作安全

第一版只暴露版本创建和版本更新两个写操作。两者都需要 `confirm=true` 才会真正发送禅道请求。

没有 `confirm=true` 时，`zentao_create_build` 和 `zentao_update_build` 只返回带有 `requires_confirmation=true` 的试运行摘要，不会发送 HTTP 请求。

## 开发

开发背景、本地验证命令和第一版设计边界见 [doc/dev/README.md](doc/dev/README.md)。
