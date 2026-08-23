# 禅道新建需求描述图片上传设计

## 1. 结论

`zentao_create_story` 可以在新建需求时直接把本地图片写入需求描述，不需要先创建需求、再调用 `zentao_change_story`。

确认调用使用同一个 Token 和 `uid` 完成以下操作：

1. 通过 `POST /api.php/v1/files?uid=...` 顺序上传图片；
2. 将 `spec` 中的图片占位符替换为上传响应中的 URL；
3. 通过 `POST /api.php/v1/stories` 创建需求，并在请求体中携带同一个 `uid`；
4. 使用创建响应中的需求 ID 重新读取需求，验证图片已经归属新需求且描述写入成功。

本方案扩展现有创建工具，不增加新的 MCP 工具，不调用 Web 路由，也不引入新的依赖。

## 2. 与编辑附图方案的关系

本方案以[禅道需求描述图片上传设计](./zentao-story-description-image-upload.md)为共享基线。以下规则直接继承，不在本文重复定义：

- `images`、`images[].key/path/alt/filename` 的字段含义；
- `{{image:<key>}}` 占位符的一一对应规则；
- 绝对路径、普通文件、链接、文件名和扩展名检查；
- 最多 5 张、单张 10 MiB、合计 25 MiB 的限制；
- PNG、JPEG、GIF 的声明类型；
- `src`、`alt` 的 HTML 属性转义；
- Token 与 `uid` 必须属于同一会话；
- 首张图片上传成功后禁止重新登录或重传结果未知的上传；
- 上传和后续业务写入不是事务，失败时不自动删除远端文件；
- 只接受本地绝对路径，不接收 base64、data URL、远程 URL 或剪贴板对象。

本文只定义创建流程与编辑流程不同的输入、确认、失败判定和写后验证。

## 3. 禅道 17.4 源码依据

结论以 Git 标签 `zentaopms_17.4` 为准：

| 17.4 源码位置 | 结论 |
| --- | --- |
| `api/v1/entries/stories.php:65-83` | `POST /stories` 的字段白名单包含 `uid`，随后进入 `story.create`。 |
| `module/story/model.php:207-234` | 创建模型在插入需求前调用 `processImgURL(..., uid)` 处理描述图片。 |
| `module/story/model.php:247-265` | 需求插入成功后调用 `updateObjectID(uid, storyID, type)`，把已使用图片关联到新需求。 |
| `module/file/model.php:728-762` | `processImgURL` 重写图片 URL，并在当前 `uid` 相册中标记正文实际使用的文件。 |
| `module/file/model.php:869-880` | `updateObjectID` 将已使用文件的 `objectType/objectID` 更新为新需求。 |

仓库中现有 `/files` endpoint、multipart 上传和固定 Token 请求能力已经覆盖底层传输需求。官方创建需求文档没有列出 `uid`，因此未来升级禅道时必须重新核对上述源码契约，不能只依据公开参数表判断兼容性。

## 4. 范围与非目标

### 4.1 目标

- 扩展 `zentao_create_story`，允许在新需求的 `spec` 中插入本地图片。
- 无图片调用保持现有请求、dry-run 和响应完全不变。
- 图片调用返回可区分未写入、部分写入和结果未知的结构化状态。
- 创建成功后验证图片引用和需求正文。
- 复用编辑附图已经验证过的本地文件与会话上传约束。

### 4.2 非目标

- 不通过“先创建、再 change”实现。
- 不支持在 `verify` 或其他字段中插入图片。
- 不新增 `expected_revision`、`expected_create_hash` 或文件内容哈希。
- 不增加删除文件、回滚需求、幂等键或自动补偿机制。
- 不建立通用文件上传框架，不向外暴露 `/files`。
- 不改变无图片创建时 `spec` 的现有可选性，也不顺带修正其他创建字段契约。
- 不改变编辑附图的输入、结果或失败语义。

## 5. MCP 输入契约

在现有 `zentao_create_story` 参数上增加可选 `images`：

```json
{
  "title": "支持登录页改版",
  "product": 1,
  "pri": 2,
  "category": "feature",
  "spec": "当前页面：\n\n{{image:current_ui}}\n\n目标页面：\n\n{{image:target_ui}}",
  "verify": "按目标页面完成并通过验收",
  "images": [
    {
      "key": "current_ui",
      "path": "C:\\Users\\me\\Pictures\\current.png",
      "alt": "当前页面"
    },
    {
      "key": "target_ui",
      "path": "D:\\screenshots\\target.bin",
      "filename": "target.jpg",
      "alt": "目标页面"
    }
  ],
  "confirm": true
}
```

补充规则：

- `images` 未提供或为空数组时，严格走现有创建分支。
- `images` 非空时，`spec` 必须为非空字符串，并满足共享占位符规则。
- `expected_revision` 不属于创建工具；创建前不存在可供并发比较的需求快照。
- 图片 dry-run 不返回确认哈希。确认调用会重新执行全部输入和本地文件预检。
- 未提供 `images` 时，`{{image:...}}` 不作特殊解释，以保持现有行为。

## 6. 结果契约

无图片分支继续返回现有 write-summary 或禅道原始创建响应。非空图片分支统一返回：

```json
{
  "status": "SUCCESS",
  "phase": "verify",
  "story_id": 123,
  "uploaded": [
    {
      "key": "current_ui",
      "path": "C:\\Users\\me\\Pictures\\current.png",
      "filename": "current.png",
      "alt": "当前页面",
      "size": 102400,
      "mtime": "2026-08-23T02:00:00.000Z",
      "file_id": 456,
      "url": "/file-read-456.png"
    }
  ],
  "failed": [],
  "unattempted": []
}
```

字段规则：

- `status` 为 `DRY_RUN | SUCCESS | PARTIAL | UNKNOWN | REJECTED`。
- `phase` 为 `preflight | upload | create | verify`。
- `story_id` 仅在已经从有效创建响应中取得正整数 ID 后出现。
- `request_summary` 只在 `DRY_RUN` 中出现，复用现有创建 write-summary，且不包含尚未生成的 `uid`。
- `uploaded`、`failed`、`unattempted` 与编辑附图分支含义一致。
- Token、密码、Cookie 和 `uid` 不出现在结果或错误文本中。

状态含义：

| 状态 | 含义 |
| --- | --- |
| `DRY_RUN` | 参数和本地文件预检通过，没有远端业务调用。 |
| `SUCCESS` | 创建返回有效需求 ID，随后读取并验证需求成功。 |
| `REJECTED` | 输入、本地文件、认证或上传前置条件失败，能够证明没有图片和需求写入。 |
| `PARTIAL` | 已知至少一张图片上传成功，或已知需求创建成功，但完整流程没有成功结束。 |
| `UNKNOWN` | 无法判定上传或创建是否生效；调用方不得自动重试整次操作。 |

## 7. Dry-run

`confirm` 不为 `true` 时，图片分支执行纯本地 dry-run：

1. 校验现有创建字段；
2. 校验占位符和图片声明；
3. 对本地图片执行路径、类型、大小和 mtime 预检；
4. 返回 `DRY_RUN/preflight`、创建请求摘要和规范化文件信息；
5. 不登录禅道，不调用 `/files`，也不调用 `/stories`。

dry-run 是推荐的用户确认步骤，但不是协议级确认令牌。调用方直接传 `confirm=true` 时，工具在任何远端写入前仍会重新完成相同预检。

## 8. 确认写入流程

```text
校验创建字段和本地图片
  -> 固定当前 Token，生成一次 uid
  -> 按 images 顺序 POST /files?uid=同一个值
  -> 用上传 URL 替换 spec 中的全部占位符
  -> 使用同一 Token POST /stories，body 携带同一个 uid
  -> 从响应取得 story_id
  -> 使用同一 Token GET /stories/{story_id}
  -> 验证图片和正文
```

详细约束：

1. 所有图片和创建请求使用同一个 Token 与 `uid`。
2. 第一张图片尚未成功时，明确认证失败可以重新登录并重试该图片一次。
3. 第一张图片成功后禁止重新登录，后续上传、创建和验证均固定使用当前 Token。
4. 任一上传失败立即停止，不发送后续图片，也不创建需求。
5. 上传结果未知时禁止自动重传该图片。
6. 创建请求体由现有创建字段白名单、替换后的 `spec` 和内部生成的 `uid` 组成；调用方不能直接控制 `uid`。
7. 创建请求无论因何失败都不自动重发，避免重复需求。
8. 只有创建响应是直接对象且包含正整数 `id` 时，才进入写后验证。

## 9. 创建失败与结果未知

图片已经上传后，创建结果按以下规则处理：

| 场景 | 结果 |
| --- | --- |
| 明确的普通 4xx，且不是 408/429 | `PARTIAL/create`，`known_failure` |
| 408、429、5xx、超时、网络中断 | `UNKNOWN/create`，不重试创建 |
| 2xx 但响应不是直接对象或没有有效正整数 ID | `UNKNOWN/create` |
| 创建返回有效 ID，但后续读取失败 | `PARTIAL/verify` |
| 创建成功，但读取结果不满足验证条件 | `PARTIAL/verify` |

禅道的重复需求检查可能在图片上传之后、需求插入之前返回错误。这种情况下需求没有创建，但图片已经上传，因此仍属于 `PARTIAL/create`，不降级为 `REJECTED`。

创建结果未知时没有可靠的需求 ID，也没有按 `uid` 查询新需求的公开接口，无法像编辑流程那样读取既有对象消歧。工具必须返回 `UNKNOWN`，不得按标题搜索后猜测、不得自动重试，也不得把其他同名需求当作本次创建结果。

## 10. 写后验证

取得有效 `story_id` 后，使用创建流程固定的 Token 读取 `/stories/{story_id}`。验证条件为：

1. 返回对象的 `id` 等于创建响应中的 `story_id`；
2. 每个 `uploaded[].file_id` 都出现在最终 `spec` 的 `file-read-{id}` 引用中；
3. 最终 `spec` 不再包含 `{{image:`；
4. 最终标题等于请求标题；
5. 最终验收标准等于请求值；未提供时按空字符串验证。

不比较整段 `spec` HTML，因为禅道会重写图片 URL 和标签。验证 GET 是只读操作；遇到明确的瞬时失败时，可以使用同一 Token 重试一次。验证失败不撤销需求，也不删除图片。

## 11. 实现边界

预计只调整需求工具和需求图片工作流：

- `src/tools/storyTools.ts`
  - 在创建 schema 中加入 `images`；
  - 未提供或空数组时继续调用现有创建 resolver；
  - 非空数组时进入创建附图编排。
- `src/tools/storyImageCreate.ts`
  - 负责创建专用的 dry-run、创建请求、状态映射和写后验证。
- 需求图片共享 helper
  - 从现有编辑附图实现中只抽取本地图片准备、占位符替换和固定会话顺序上传；
  - 不知道 `/stories` 或 `/stories/{id}/change`，不承担创建或编辑业务判断；
  - 只服务创建与编辑两个调用方，不扩展为通用上传框架。
- `src/tools/storyImageChange.ts`
  - 改用共享 helper，保持现有外部行为和结果契约不变。

`src/zentao/client.ts` 和 `src/zentao/endpoints.ts` 已具备所需能力，本需求不应再修改它们，除非实施中的失败测试证明现有传输契约不完整。

代码注释只解释以下不直观约束：

- 同一 Token/`uid` 的会话归属；
- 首张图片成功后禁止重新登录和重传；
- 创建结果未知时禁止自动重试；
- 创建流程不使用 `expected_revision` 的原因。

## 12. 测试与验收

### 12.1 最小相关测试

实施时先增加失败测试，再实现最小代码，至少覆盖：

- 创建 schema 接受 `images`；
- 未提供和空数组保持现有 dry-run、请求及响应完全相等；
- 非空图片要求 `spec`，并复用全部共享预检规则；
- 图片 dry-run 零登录、零上传、零创建；
- 所有上传和创建使用同一 Token/`uid`；
- 创建直接调用 `POST /stories`，不调用 `/stories/{id}/change`；
- 创建 body 包含现有字段、替换后的 `spec` 和内部 `uid`；
- 首张上传成功后的认证失败和未知结果不重试；
- 创建普通 4xx、408/429、5xx、网络异常和无效响应的状态映射；
- 有效需求 ID 后使用同一 Token 读取并验证；
- 编辑附图现有测试保持通过；
- MCP smoke test 能发现创建工具新增的 `images` 参数。

### 12.2 成功标准

以下条件全部满足才视为实现完成：

1. 无图片创建行为没有兼容性变化；
2. 图片调用只产生一次正式需求创建，不产生额外 change 版本；
3. 图片、创建和验证遵守固定会话约束；
4. `SUCCESS` 必须有有效 `story_id` 和写后验证证据；
5. 部分写入与未知结果不会被包装成普通异常或伪装成成功；
6. 自动化测试覆盖创建附图新增分支和编辑附图回归；
7. 未经真实环境授权，不声称完成禅道端到端验证。

### 12.3 真实环境验证

真实验证需要单独授权，并使用允许创建测试需求的产品。至少检查：

- PNG、JPEG、GIF 能在新需求描述中显示；
- 文件记录的 `objectType/objectID` 归属新需求；
- 新需求只产生创建动作，没有额外 change 版本；
- 描述经禅道重写后仍能通过文件 ID 验证；
- 400、重复需求和网络异常场景的实际响应与状态分类一致。

未执行真实验证时统一标记为 `NOT RUN`。

## 13. 风险与升级检查

- 图片上传与需求创建不是事务，创建失败可能留下未关联文件。
- 创建响应未知时可能已经产生需求；调用方必须人工核对，不能自动重试。
- 工具可以读取运行账户有权限访问的本地图片，权限风险与编辑附图功能一致。
- 禅道公开创建 API 文档未声明 `uid`；升级时必须核对 `/files`、`stories.post` 字段白名单、`processImgURL` 和 `updateObjectID`。
- 后续版本若不再以 Token session 保存 `uid` 相册，应停止图片创建能力并报告不兼容，不增加 Web Cookie fallback。
