# 禅道需求描述图片上传设计

## 1. 结论

禅道 17.4 的 v1 API 可以完成“上传图片并写入需求描述”，只是上传入口没有出现在常用 API 文档中。实现应扩展现有 `zentao_change_story`，依次调用：

1. `POST /api.php/v1/files?uid=...` 上传图片；
2. 将上传响应中的 URL 替换进 `spec`；
3. `POST /api.php/v1/stories/{id}/change` 修改需求，并携带同一个 `uid`；
4. 重新读取需求，验证图片归属和描述内容。

不需要调用禅道 Web 路由，也不需要模拟浏览器表单。整个写入流程只使用 v1 API。

17.4 中，`POST /tokens` 返回的 Token 和浏览器 Cookie `zentaosid` 的值本质上都是 PHP session ID；但二者的线上承载方式不同：v1 API 使用 `Token` 请求头，Web 使用 Cookie。实现只复用“同一会话”的语义，不拼装 Cookie，也不依赖二者在后续版本继续等价。

## 2. 目标与非目标

### 2.1 目标

- 让 MCP 调用方把已经落盘的本地图片插入需求 `spec`。
- 支持一次修改中按声明顺序上传最多 5 张图片。
- 保留 `zentao_change_story` 现有的确认机制和无图片调用行为。
- 上传前检测需求并发修改；有冲突时保证没有图片或需求写入。
- 对上传非原子性给出可判定、可恢复的结构化结果。

### 2.2 非目标

- 不直接读取 Windows 剪贴板。
- 不接收图片二进制、base64、data URL 或远程 URL 作为上传源。
- 不要求或控制调用 MCP 的工具软件把临时图片放在哪个目录。
- 不增加目录白名单、配置项、依赖、MCP 工具或通用文件上传抽象。
- 不检查文件真实签名、真实 MIME、像素、尺寸，也不计算文件哈希。
- 不改变调用中已有的 `<img>`、外部图片 URL 或其他 HTML。
- 不为失败上传自动删除禅道文件；禅道 17.4 的这组接口不提供事务能力。

常见桌面工具在粘贴剪贴板图片后，可能把图片保存为临时文件、只向模型暴露附件对象，或直接传递图片内容。MCP 协议和宿主工具对此没有统一格式。本设计只约定本地绝对路径：宿主若能把附件映射为本地路径即可调用；若宿主只暴露图片内容而不提供路径，本版本明确不支持。

## 3. 禅道 17.4 源码依据

本地 `D:\UserData\src\others\zentaopms` 工作区当前是 22.4，因此结论以 Git 标签 `zentaopms_17.4` 为准，而不是当前工作区文件。

| 17.4 源码位置 | 结论 |
| --- | --- |
| `config/routes.php:16` | v1 注册了 `/files` 路由。 |
| `api/v1/entries/files.php:20-32` | 读取查询参数 `uid`，调用 `file.ajaxUpload`，返回 `id` 和 `url`。 |
| `module/file/control.php:49-90` | multipart 字段名是 `imgFile`；保存图片记录，并按 `uid` 写入会话相册。 |
| `api/v1/entries/storychange.php:25-28` | change 入口向业务层传递 `uid`、`title`、`spec` 和 `verify`。 |
| `module/story/model.php:699-753` | 修改需求时处理描述中的图片，并使用 `uid` 关联文件。 |
| `module/file/model.php:728-762,869-880` | 重写图片 URL，并把文件的 `objectType/objectID` 关联到需求。 |
| `api/v1/entries/tokens.php:28-32` | API Token 来自 `session_id()`。 |
| `framework/base/router.class.php:1010-1017` | `HTTP_TOKEN` 被设置为 PHP session ID。 |
| `config/config.php:36` | Web Cookie/session 名是 `zentaosid`。 |

后续禅道版本已经出现 API 与 Web 会话存储拆分，因此不得把 Cookie 兼容性当作长期接口契约。未来升级只需重新验证 v1 `/files`、`uid` 关联和 Token 会话语义，不增加 Web fallback。

## 4. MCP 输入契约

只扩展 `zentao_change_story`：

```json
{
  "story_id": 123,
  "spec": "登录页现状：\n\n{{image:current_ui}}\n\n目标效果：\n\n{{image:target_ui}}",
  "images": [
    {
      "key": "current_ui",
      "path": "C:\\Users\\me\\AppData\\Local\\Temp\\pasted-1.png",
      "alt": "当前登录页"
    },
    {
      "key": "target_ui",
      "path": "D:\\screenshots\\target.bin",
      "filename": "target.jpg"
    }
  ],
  "expected_revision": "sha256:...",
  "confirm": true
}
```

新增字段：

| 字段 | 规则 |
| --- | --- |
| `images` | 可选数组；空数组按未提供处理。非空时 `spec` 必填。最多 5 项。 |
| `images[].key` | 非空，仅允许 ASCII 字母、数字、`_`、`-`，区分大小写；数组内唯一。 |
| `images[].path` | 必填，本机 Windows 绝对路径。 |
| `images[].alt` | 可选；未提供时使用有效上传文件名去掉最后一个扩展名后的文本。显式空字符串保留为空。 |
| `images[].filename` | 可选；提供时作为上传文件名和声明类型的唯一依据。 |
| `expected_revision` | 图片确认调用必填；图片 dry-run 返回。无图片调用不使用该字段。 |

`title`、`spec`、`verify` 和 `confirm` 继续遵守现有定义。未提供 `images` 或提供空数组时，工具的请求、dry-run 和响应与当前版本完全一致。

## 5. 预检规则

### 5.1 占位符

- 占位符固定为 `{{image:<key>}}`，例如 `{{image:current_ui}}`。
- 每个 `images[].key` 必须在 `spec` 中恰好出现一次。
- `spec` 中每个图片占位符必须有对应的 `images` 声明。
- 重复、缺失、未声明或格式错误的图片占位符均在上传前拒绝。
- 占位符按纯文本精确替换，不引入 HTML 解析器；调用方应把占位符放在允许出现 `<img>` 的正文位置。
- 已有 `<img>`、普通链接和外部 URL 不参与扫描或改写。

上传成功后，占位符替换为：

```html
<img src="上传接口返回的 URL" alt="转义后的 alt">
```

`src` 和 `alt` 都按 HTML 属性转义。`alt` 至少转义 `&`、`<`、`>`、`"`、`'`。上传响应必须包含正整数 `id` 和非空 `url`，否则该次上传结果视为未知或失败，不生成 `<img>`。

### 5.2 本地文件

- 路径必须是绝对路径；不展开 glob，不接受目录。
- 使用 `lstat` 检查最终路径，只接受普通文件；拒绝最终路径为符号链接、junction 或 Node 在 Windows 上识别为链接的 reparse link。
- 不删除、移动或修改源文件。
- 单文件最大 10 MiB，全部图片合计最大 25 MiB。
- 不限制像素和图片尺寸。
- 不读取文件内容来识别类型，不计算哈希。

读取文件与上传之间仍有很小的 TOCTOU 窗口。确认调用会重新执行 `lstat` 和大小检查，并在打开文件后使用该文件句柄上传，但不承诺识别同路径、同大小、同 mtime 的内容替换；这是“不计算文件哈希”的已接受剩余风险。

### 5.3 文件名与声明类型

有效上传文件名为 `filename ?? path.basename(path)`。

- `filename` 一旦提供就是权威值，不和源路径扩展名比较。
- 文件名必须是单一文件名：非空，不得包含 `/`、`\`、控制字符，不得是 `.` 或 `..`。
- 只接受大小写不敏感的 `.png`、`.jpg`、`.jpeg`、`.gif`。
- multipart 的 MIME 仅按有效文件名扩展名声明为 `image/png`、`image/jpeg` 或 `image/gif`。
- 不验证扩展名、声明 MIME 与真实内容是否一致。
- multipart 固定字段名为 `imgFile`；由原生 `FormData` 生成 `Content-Type` 和 boundary，禁止手工拼 boundary。

## 6. dry-run 与并发保护

图片调用在 `confirm` 不为 `true` 时执行 dry-run：

1. 完成占位符、路径、文件名、数量和大小预检；
2. 读取当前需求；
3. 返回每个文件的规范化绝对路径、字节数、mtime，以及需求的 `expected_revision`；
4. 不调用 `/files` 或 `/stories/{id}/change`。

为读取需求，客户端可能需要建立或刷新登录 session；这里的“零写入”指不创建禅道文件、不修改需求及其业务数据，不把认证 session 的建立计为业务写入。

`expected_revision` 使用 Node 标准库 SHA-256 计算，只代表需求快照，不代表图片内容：

```text
sha256(JSON.stringify([
  story.id,
  story.version ?? null,
  story.lastEditedDate ?? null,
  story.title ?? "",
  story.spec ?? "",
  story.verify ?? ""
]))
```

确认调用必须提供 dry-run 返回的 `expected_revision`。在任何上传前重新读取需求并计算当前 revision：

- 相等：继续；
- 不相等：返回 `CONFLICT/preflight`，且没有远端业务写入；
- 缺失：返回 `REJECTED/preflight`。

本设计不为本地文件生成确认 token。调用方可以展示 dry-run 的 path/size/mtime 供用户核对；确认时以重新预检得到的本地文件为准。

## 7. 确认写入流程

```text
本地预检
  -> GET 当前需求并校验 expected_revision
  -> 固定当前 Token，生成一次 uid
  -> 按 images 数组顺序逐张 POST /files?uid=同一个值
  -> 用已知 URL 替换全部占位符
  -> POST /stories/{id}/change，携带相同 uid
  -> GET 需求并验证
```

详细规则：

1. 在首次上传前允许正常登录或一次认证刷新。
2. 为本次确认操作生成一个不可预测的 `uid`；同一次操作的所有上传和 change 使用同一 `uid`。
3. 所有上传和 change 固定使用同一个 Token/session。
4. 图片严格按 `images` 数组顺序上传；任一失败立即停止，不尝试后续图片，也不调用 change。
5. 第一张图片成功后禁止重新登录。否则新 session 看不到旧 session 下以 `uid` 暂存的相册，文件可能无法关联。
6. 第一张图片成功后禁止自动重传结果未知的图片，以免产生重复文件。
7. change 请求显式传递：
   - `uid`；
   - 替换占位符后的 `spec`；
   - 调用方提供的 `title/verify`，或预检快照中的原值。
8. 显式补齐未提供的 `title/verify`，防止 17.4 change 入口的默认值覆盖原内容；无图片分支保持当前行为，不增加这一步。

`uid` 只用于禅道内部文件归属，不写回 `spec`，也不需要暴露给普通成功响应。

## 8. 重试与认证边界

通用客户端当前会在认证失败后自动重新登录并重试一次。图片事务不能直接沿用该策略，必须由图片分支限制：

- 当前需求的上传前 GET 是只读请求，可以使用现有的一次认证重试。
- 在尚无任何成功上传时，如果上传明确返回认证失败，可以重新登录并从第一张重试一次。
- 已有成功上传后，上传、change 和验证 GET 都不得重新登录；认证失败按已发生的写入状态返回。
- 上传请求一旦可能到达服务器，网络断开、超时或无法解析响应都不得自动重传。
- 已知上传 URL 必须缓存并复用；不得为了重试 change 而重新上传图片。
- change 返回已知瞬时失败时，先 GET 判定远端状态。只有远端仍严格等于预检快照、请求结果明确且使用相同 Token/uid 时，才允许重试 change 一次。
- change 响应未知时只做 GET 判定，不自动重发：若已能验证目标状态则继续成功验证；若仍是旧状态或处于第三种状态，返回 `UNKNOWN`。
- 验证 GET 的已知瞬时失败可用相同 Token 重试一次，因为它是只读操作。

“已知瞬时失败”不由宽泛异常文本猜测；只包括实现明确分类且能够证明重试不会重复上传或重复产生需求变更副作用的情况。无法证明时宁可返回 `UNKNOWN`。

## 9. 图片分支结果契约

图片分支始终返回以下状态之一：

| `status` | 含义 |
| --- | --- |
| `DRY_RUN` | 预检通过，未执行远端业务写入。 |
| `SUCCESS` | change 成功，且随后验证全部通过。 |
| `CONFLICT` | 上传前发现需求 revision 已变化，零业务写入。 |
| `REJECTED` | 输入、文件、认证或已知请求失败，且能证明没有文件或需求写入。 |
| `PARTIAL` | 已知至少有文件上传或需求已修改，但流程未完整成功。 |
| `UNKNOWN` | 无法确定某次上传或 change 是否生效；调用方不得自动重试整次操作。 |

`phase` 固定为 `preflight | upload | change | verify`，表示停止或完成所在阶段。响应至少包含：

```json
{
  "status": "PARTIAL",
  "phase": "upload",
  "story_id": 123,
  "expected_revision": "sha256:...",
  "current_revision": "sha256:...",
  "uploaded": [
    {
      "key": "current_ui",
      "path": "C:\\...\\pasted-1.png",
      "filename": "pasted-1.png",
      "size": 102400,
      "mtime": "2026-08-22T10:00:00.000Z",
      "file_id": 456,
      "url": "/file-read-456.png"
    }
  ],
  "failed": [
    {
      "key": "target_ui",
      "outcome": "known_failure",
      "error": "..."
    }
  ],
  "unattempted": []
}
```

- `uploaded` 只列出已取得合法 `id/url` 的图片。
- `failed` 列出导致停止的当前项或 change/verify 错误；`outcome` 为 `known_failure` 或 `unknown`。
- `unattempted` 按原数组顺序列出没有发送的图片。
- 错误内容继续使用现有脱敏规则，不返回 Token、密码或 Cookie。
- MCP SDK 在进入处理器前发现的基础类型错误继续使用现有 invalid-arguments 错误；进入图片处理器后的业务预检错误使用 `REJECTED`。
- 无图片调用继续返回现有原始响应或现有 write-summary，不包裹上述结构。

典型失败映射：

| 场景 | 结果 |
| --- | --- |
| 本地预检失败、缺少 revision | `REJECTED/preflight` |
| revision 不一致 | `CONFLICT/preflight` |
| 第一张上传明确失败且证明未创建文件 | `REJECTED/upload` |
| 已有成功上传，后续图片明确失败 | `PARTIAL/upload` |
| 任一上传结果无法判断 | `UNKNOWN/upload` |
| 图片均上传但 change 明确失败 | `PARTIAL/change` |
| change 结果无法判断且 GET 不能消歧 | `UNKNOWN/change` |
| change 已知成功但验证失败 | `PARTIAL/verify` |

## 10. 写后验证

change 后使用同一 Token GET 需求，验证：

1. 每个上传响应的 `file_id` 都出现在最终 `spec` 的 `file-read-{id}` 引用中；允许禅道为 URL 增加前缀、后缀或改写标签。
2. 最终 `spec` 不再包含任何 `{{image:` 占位符。
3. 调用未提供 `title` 时，最终标题等于上传前快照。
4. 调用未提供 `verify` 时，最终验收标准等于上传前快照。
5. 调用提供 `title` 或 `verify` 时，最终值等于调用值。

不比较整段 HTML，因为禅道会重写 `<img>`。验证只检查文件 ID、占位符和必须保持或更新的字段。

## 11. 最小实现落点

实现阶段只触及现有责任边界：

- `src/zentao/endpoints.ts`：登记 v1 `/files`。
- `src/zentao/client.ts`：用 Node 20 原生 `FormData`/`Blob` 发送 `imgFile`，并支持图片流程固定 Token、禁止自动认证重试。
- `src/tools/storyTools.ts`：扩展 schema，保留无图片分支，编排预检、revision、顺序上传、change 和验证。
- 仅当上述逻辑使 `storyTools.ts` 明显失去可读性时，才拆一个需求图片专用 helper；不建立通用上传层或单实现工厂。
- 相关现有测试文件优先就地扩充；只有测试职责明显独立时才新增一个图片流程测试文件。

实现中的注释只解释不直观且必须保留的最终约束：17.4 的 Token/uid 同 session 关联、首次成功上传后禁止重登录/重传、`filename` 是声明类型权威值。其余直观代码不写变更历史式注释。

## 12. 验证方案

### 12.1 自动化验证

实现阶段运行最小相关测试，覆盖：

- 占位符一一对应、重复、缺失、未声明和 malformed；
- 绝对普通文件、目录、链接、扩展名、单文件/数量/总大小边界；
- `filename` 覆盖源路径扩展名，且不检查文件内容；
- alt/src HTML 转义；
- dry-run 零 `/files`、零 change，并返回文件元数据和 revision；
- revision 冲突零写入；
- 顺序上传、同 Token/uid、multipart 字段 `imgFile`；
- 首次成功上传后的认证失败和未知结果不重试；
- upload/change/verify 各阶段的状态、列表和停止行为；
- 写后按 file ID 验证，允许禅道重写 HTML；
- 无 `images` 的现有请求和响应兼容性。

CI 使用 mock/fake fetch，不访问真实禅道。

### 12.2 真实环境验证

端到端证明必须在明确授权后使用专用测试需求，至少验证：

- PNG/JPEG/GIF 上传后可在需求详情中显示；
- 禅道文件记录确实关联到目标需求；
- HTML 经 17.4 重写后仍能通过 file ID 验证；
- 需求版本、历史、状态、评审人和通知等正式 change 副作用符合 17.4 实际行为。

未获得真实环境授权时，端到端结果标记为 `NOT RUN`，不得用 mock、构建成功或源码分析冒充实测。

## 13. 已接受剩余风险

- 不设目录白名单意味着：能够调用该工具的主体，可以要求 MCP 读取并上传运行账户可读的任意、符合大小和声明扩展名规则的本地普通文件。这是调用权限边界，不由本功能额外收窄。
- 不检查文件签名意味着恶意或错误内容可能以图片扩展名提交，最终是否接受由禅道 17.4 处理。
- 不计算文件哈希意味着无法证明 dry-run 与确认时的文件内容完全相同。
- 本地检查到打开文件之间存在有限竞态；最终链接检查能防常见 link 输入，但不能构成通用 Windows 文件系统沙箱。
- `/files` 与 story change 非事务；失败后可能留下未关联文件，不自动清理。
- change 会产生禅道正式版本、历史、状态、评审人和通知等副作用；调用方在 `confirm=true` 前必须展示并接受这些副作用。
