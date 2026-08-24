# zentao-v1-mcp

本项目是基于禅道 RESTful API v1 的 MCP 服务器，运行后通过 stdio 为 agent 提供一组小而明确的工具，用于读取禅道数据，并以受保护的方式创建或更新版本。

English documentation: [README.en.md](README.en.md)

## 快速开始

### 安装

```bash
npm install -g zentao-v1-mcp
```

### 配置

创建示例配置：

```bash
zentao-v1-mcp init-config
```

默认配置文件位置：

- Windows: `%APPDATA%\zentao-v1-mcp\config.json`
- Linux/macOS: `~/.config/zentao-v1-mcp/config.json`

示例文件替换为实际环境配置：

```json
{
  "base_url": "https://zentao.example.com/zentao/api.php/v1",
  "account": "your-account",
  "password": "your-password",
  "timeout_seconds": 20
}
```

`base_url` 推荐填写以 `/api.php/v1` 结尾的完整禅道 REST API v1 基础地址。例如禅道安装在 `https://zentao.example.com/zentao`，应填写 `https://zentao.example.com/zentao/api.php/v1`。旧配置中的禅道站点地址仍然兼容，程序会为其追加固定 API 路径；自定义 URL rewrite API 路径暂不支持。

配置完毕后进行登录测试，确认配置正确：

```bash
zentao-v1-mcp validate-config --login
```

## MCP 客户端配置示例

```json
{
  "mcpServers": {
    "zentao-v1": {
      "command": "npx",
      "args": ["-y", "zentao-v1-mcp"],
      "env": {
        "ZENTAO_BASE_URL": "https://zentao.example.com/zentao/api.php/v1",
        "ZENTAO_ACCOUNT": "your-account",
        "ZENTAO_PASSWORD": "your-password"
      }
    }
  }
}
```

## 进一步阅读

- [使用指南](doc/usage/README.md)：完整工具列表、按执行查询 Bug、写操作安全等高级用法。
- [开发说明](doc/dev/README.md)：第一版边界、本地验证命令、模块布局等开发者背景。
- [设计文档](doc/design/zentao-v1-mcp-design.md)：禅道 v1 MCP 第一版完整设计。
