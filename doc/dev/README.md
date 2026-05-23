# 开发说明

本文档用于承载开发者背景信息，避免用户快速开始文档 `README.md` 过重。

## 第一版边界

- 服务器不暴露删除操作。
- 服务器不暴露任意 HTTP 代理能力。
- 除版本创建和版本更新外，不暴露通用创建或更新工具。
- 一个进程只连接一个禅道实例。

## 接口注册表

接口注册表根据本地禅道 API v1 文档 `doc/zentao_api_v1_doc/` 手写维护。

这样做是有意的：本地 Markdown 文档存在编码和格式不一致的问题，自动抽取会让第一版行为超出已接受的设计边界。

## 设计文档

- [禅道 v1 MCP 设计](../design/zentao-v1-mcp-design.md)
- [查询工具多步流程决策](../design/zentao-query-tool-multistep-decision.md)

## 本地验证

```bash
npm install
npm run build
npm test
npm run smoke
```

修改特定区域时先运行聚焦测试；发布或交接前再运行完整验证集。
