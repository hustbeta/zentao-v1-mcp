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

发布前使用完整门禁：

```bash
npm run verify
```

该命令会依次执行构建、单元测试、stdio smoke、依赖审计和 `npm pack --dry-run`，用于确认 npm 包里的运行产物和文档范围。

## npm 发布流程

### 版本号规则

npm 不允许覆盖已经发布过的版本号。每次发布前必须先更新 `package.json` 中的 `version`，优先使用语义化版本：

```bash
npm version patch
```

- 修复兼容性问题使用 `patch`，例如 `0.1.0` 到 `0.1.1`。
- 新增兼容功能使用 `minor`，例如 `0.1.0` 到 `0.2.0`。
- 破坏兼容的变更使用 `major`。

### 首次手动发布

首次创建 npm 包时，GitHub trusted publishing 还无法接管，需要用 npm 账号或 granular token 手动发布一次。

如果本机 2FA 可用，可以直接带一次性验证码发布：

```bash
npm publish --access public --otp=<6位验证码>
```

如果使用 granular token，使用临时 userconfig，避免把 token 写入仓库或全局 `.npmrc`：

```powershell
$env:NPM_TOKEN = "npm_xxxxxxxxxxxxxxxxx"
$env:NPM_CONFIG_USERCONFIG = "$PWD\.npmrc.publish"
"//registry.npmjs.org/:_authToken=$env:NPM_TOKEN" | Set-Content -Encoding ascii $env:NPM_CONFIG_USERCONFIG

npm whoami
npm publish --access public

Remove-Item $env:NPM_CONFIG_USERCONFIG
Remove-Item Env:\NPM_TOKEN
Remove-Item Env:\NPM_CONFIG_USERCONFIG
```

发布成功后验证公开包：

```bash
npm view zentao-v1-mcp version
npx -y zentao-v1-mcp print-config
```

### GitHub trusted publishing

首次发布成功后，在 npm 包设置中绑定 GitHub Actions trusted publisher。当前仓库的发布 workflow 是 `.github/workflows/publish.yml`，npm 页面里 `Workflow filename` 填 `publish.yml`。

推荐配置：

- Provider: `GitHub Actions`
- Repository: 当前 GitHub 仓库
- Workflow filename: `publish.yml`
- Environment name: 留空，除非后续 workflow 显式增加 environment
- Allowed action: `npm publish`

trusted publishing 使用 GitHub OIDC，不需要在 GitHub Secrets 中保存长期 npm token。`publish.yml` 已保留 `id-token: write` 权限；不要删除该权限，否则自动发布无法换取 npm 发布凭据。

### 后续自动发布

绑定 trusted publisher 后，后续发版只需要更新版本号并推送 tag：

```bash
npm version patch
git push origin HEAD
git push origin v0.1.1
```

`v*.*.*` tag 会触发 GitHub Actions 自动执行安装、构建、测试、smoke、审计和 `npm publish --access public`。
