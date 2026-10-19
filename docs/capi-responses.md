# CAPI `/responses` 使用手册（客户端视角）

本文整理两个官方 CAPI 客户端如何调用 `POST {api}/responses`，作为本代理对齐上游的参考。
body 只记录**变形/约束**（客户端做了什么改写、哪些字段固定或从不发送），普通字段用法不赘述。

| 客户端 | 版本 / 快照 | 来源 |
|--------|-------------|------|
| VS Code Copilot Chat | `copilot-chat/0.70.0`，VS Code `1.142.0`，HEAD `d956e8a6ac5`（2026-10-14） | TS 源码 `/Users/wenkai/workspace/vscode/extensions/copilot`；header 混入逻辑在 npm 包 `@vscode/copilot-api@0.5.2` |
| Copilot CLI | `@github/copilot` `1.0.98` | Rust 原生模块 `package/prebuilds/darwin-arm64/runtime.node`（`copilot-agent-runtime`），字符串 + 交叉引用逆向；JS bundle 只剩 UI |

VS Code 内置的本地 `/responses` 代理（给 Codex 用）的逐层实现细节见
[vscode-responses-proxy.md](vscode-responses-proxy.md)。

标注约定：VS Code 部分的引用是扩展仓库内相对路径 `file:line`；CLI 部分是逆向结论，
**[确认]** = 字面量存在且由同一函数引用，**[推断]** = 根据上下文推测。

---

## 1. 上游地址与传输方式

### 1.1 Base URL

| | VS Code | CLI |
|---|---|---|
| 默认 | `https://api.githubcopilot.com` | 同左 |
| 实际来源 | Copilot token 的 `endpoints.api`（`/copilot_internal/v2/token`） | `GET {github-api}/copilot_internal/user` 的 `endpoints.api` |
| 覆盖 | 设置 `advanced.debug.overrideCapiUrl` | 环境变量 `COPILOT_API_URL` |
| GHE | dotcom API 改为 `https://api.<ghe-host>`，CAPI 仍取 token 的 `endpoints.api` | GHE.com 数据驻留：`https://copilot-api.<x>.ghe.com`；GHES：`https://{host}/_copilot_proxy_config` |
| 其他 | Model lab 模型走 `https://api-model-lab.githubcopilot.com/responses` | 遇到 HTTP 421 `misdirected_request` 时重新解析 CAPI endpoint |

路径都是 `{api}/responses`，没有 `/v1`。

### 1.2 认证

- **VS Code**：先换 token：`GET {dotcom-api}/copilot_internal/v2/token`，
  请求头为 `Authorization: token <gh>` 和 `X-GitHub-Api-Version: 2025-04-01`
  （`src/platform/authentication/node/copilotTokenManager.ts:250-262`）。
  之后请求 CAPI 用 `Authorization: Bearer <copilot token>`。这与本代理一致。
- **CLI**：**不做 token 交换**。直接用 GitHub OAuth token 作为 CAPI 的 `Bearer`。
  相关字面量 `Using GitHub OAuth token for Copilot API`，二进制里没有 `v2/token`。[确认]
  - OAuth App client id 为 `Ov23ctDVkRmgkPke0Mmm`。
  - scopes 为 `read:user,read:org,repo,gist,codespace,write:plugin_gateway_connections`。
  - 云端 agent 场景另有 `Request-HMAC` 模式。

### 1.3 选择哪个 endpoint

两端都根据 `/models` 返回的 `supported_endpoints` 决定传输方式。可能的取值有：

- `"/chat/completions"`
- `"/responses"`
- `"ws:/responses"`
- `"/v1/messages"`

VS Code 的对应代码在 `chatEndpoint.ts:352-365`，`endpointProvider.ts:80-85`。

### 1.4 WebSocket 传输（`ws:/responses`）

两个客户端都实现了，且 **VS Code 默认开启**。开启的实验开关是
`chat.advanced.responsesApi.webSocket.enabled`，默认值 `true`。

**VS Code 启用 WS 的条件**（`chatEndpoint.ts:561-567`），需同时满足：

1. 模型的 `supported_endpoints` 包含 `ws:/responses`；
2. 有 `turnId` 和 `conversationId`；
3. 实验开关为开。

**握手**

- URL 与 HTTP 相同（`https://…/responses`），握手时升级为 `wss://`。
- header 与 HTTP 基本相同（见 §2），差别如下：
  - 不带 `X-Initiator`；
  - 删除 `Request-Hmac`；
  - 强制带 `Copilot-Integration-Id`（`fetcherServiceImpl.ts:152-158`）。

**消息帧**

- 每次请求发一个文本帧：
  `{"type":"response.create", ...body(去掉 stream), "initiator":"user"|"agent"}`
  （`chatWebSocketManager.ts:702-708`）。
- 服务端每帧是一个裸 JSON 的 Responses 事件，没有 SSE 包装。
- 错误事件格式为 `{type:"error", error:{code,message}, copilot_quota_snapshots?}`。
- 每帧外层可能带 `headers` 字段，其中有 `X-GitHub-Copilot-Request-Te`。

**连接复用**（VS Code）

- 每个 `[conversationId, connectionId(子 agent)]` 对应一条连接，且绑定模型。
- 连接空闲且模型相同才复用。
- 取消请求时销毁整条连接。

**`previous_response_id`**

- VS Code **只在 WS 上**发送这个字段。
  - 取值为上次 `response.completed` 的 `response.id`。
  - `input` 只包含 marker 之后的增量消息，再加上最新的 compaction 项。
  - 如果某个工具调用的结果已不在增量片段里，补一个合成的 `function_call_output`，内容为
    `{"status":"outcome_unknown",...}`（`responsesApi.ts:296-423`）。
  - 状态绑定在连接上，所以 `store:false` 也能用。
- CLI 的做法相同：WS 上用 `previousResponseId` 配合 `acknowledgedNonSystemMessageCount` 做增量。[确认]

**回退到 HTTP**

- VS Code：WS 出错时用 HTTP 重发，此时带 `ignoreStatefulMarker`，即发完整历史；
  连续 3 次"WS 失败但 HTTP 成功"后，本会话不再用 WS。
- CLI 的回退原因枚举：`connect_failed | connection_unavailable | send_failed | api_error | transport_failed`。
  - 关闭 WS：`COPILOT_CLI_DISABLE_WEBSOCKET_RESPONSES`
  - 关闭 HTTP 回退：`COPILOT_CLI_DISABLE_WEBSOCKET_HTTP_FALLBACK`
  - 连接最长存活时间：`COPILOT_CLI_WEBSOCKET_MAX_CONNECTION_AGE_SECS`

**WS 相关错误**

- `previous_response_not_found`
- `connection limit reached`
- 输入项 `does not belong to this connection`
- `websocket_upgrade_rejected`

### 1.5 HTTP 上的 `previous_response_id`

- **VS Code 走 HTTP 请求 CAPI 时从不发送**，总是发送完整历史（已按 compaction 裁剪）
  （`chatEndpoint.ts:568-573`，`responsesApi.ts:65`）。只有 BYOK OpenAI 会在 HTTP 上带它。
- 遇到 400 `previous_response_not_found` 时，去掉 marker 重试一次。
- 模型元数据里 `zeroDataRetentionEnabled` 为真时，不记录 marker。

---

## 2. 请求 Headers

### 2.1 对照表

| Header | VS Code | CLI | 本代理现状 |
|---|---|---|---|
| `Authorization` | `Bearer <copilot token>` | `Bearer <GitHub OAuth token>` | `Bearer <copilot token>` |
| `Content-Type` | `application/json` | `application/json` | 同 |
| `X-GitHub-Api-Version` | **`2026-08-01`**（见 2.2） | **`2026-08-01`**；`/models` 用 `2026-09-21` | 默认 `2025-10-01` |
| `Copilot-Integration-Id` | 正式版 `vscode-chat`（规则见 2.3）；VS Code 自带的本地 responses 代理**不发** | `copilot-developer-cli`（可用 `GITHUB_COPILOT_INTEGRATION_ID` 覆盖） | 不发 |
| `Editor-Version` | `vscode/1.142.0` | `copilot/1.0.98` | `vscode/1.113.0` |
| `Editor-Plugin-Version` | `copilot-chat/0.70.0` | **不发** | `copilot-chat/0.41.2` |
| `User-Agent` | `GitHubCopilotChat/0.70.0`；本地 responses 代理改写为 `vscode_codex/<入站 UA 版本>` | `copilot/<ver> (client/<name> <platform> <node>) term/<TERM_PROGRAM>` | Bun 默认 |
| `X-VSCode-User-Agent-Library-Version` | fetcher 库名 | — | 不发 |
| `OpenAI-Intent`（CLI 写作 `Openai-Intent`） | 按 location 取值，见 2.4 | `conversation-agent` | 不发 |
| `X-Interaction-Type` | 默认同 intent，可覆盖为 `conversation-subagent` / `-compaction` / `-background` | `conversation-user` / `-agent` / `-subagent` / `-background` / `-compaction` / `-sampling` | 不发 |
| `X-Initiator` | `user` / `agent`（规则见 2.5）；WS 改为 body 里的 `initiator` 字段 | `user` / `agent` | 不发 |
| `X-Interaction-Id` | UUID，每次 `startInteraction()` 重置 | 会话 id（可用 `GITHUB_COPILOT_INTERACTION_ID` 覆盖） | 不发 |
| `X-Request-Id` | `ourRequestId`；同一用户回合内的多次迭代可能复用同一个 id | 客户端生成（SDK 称 `clientRequestId`） | 每次新 UUID |
| `X-Agent-Task-Id` | 等于 `X-Request-Id` | 单次 agent 调用的 id | 不发 |
| `X-Parent-Agent-Id` | — | 子 agent 的父 task id | 不发 |
| `X-Client-Session-Id` / `X-Client-Machine-Id` | — | CLI 会话 id / 设备 id | 不发 |
| `VScode-SessionId` | `vscode.env.sessionId`，格式 `<uuid><Date.now()>` | **不发** | 从入站 session header 透传 |
| `VScode-MachineId` / `Editor-Device-Id` | `vscode.env.machineId` / `devDeviceId` | **不发** | env 配置 |
| `VScode-ABExpContext`、`X-Copilot-Client-Exp-Assignment-Context` | 有实验上下文时发送 | 发送 `X-Copilot-Client-Exp-Assignment-Context` | 不发 |
| `Copilot-Session-Token` | Auto 模型通过 `modelMetadata.requestHeaders` 携带 | Auto 模式，由 `/models/session` 签发 | 不发 |
| `Copilot-Vision-Request` | 判断条件写的是 `messages`，Responses body 用的是 `input`，所以 **`/responses` 上永远不发** | 带图片时发送 | 不发 |
| `x-onbehalf-extension-id` | 仅 vscode.lm 扩展调用时发送 | — | — |
| `Copilot-Harness-Id` | — | SDK 驱动时发送（值推断为 `copilot-sdk`） | — |
| `X-Copilot-Traceparent` | — | W3C traceparent | — |
| `X-Github-Repository-Nwo` / `-Host` | — | 仓库上下文 | — |
| `Content-Encoding` | — | 请求 body 可用 **gzip/zstd** 压缩（WS 恒为 identity） | — |
| `Accept` | 不设置 | — | 透传入站值 |
| `anthropic-beta`、`X-Model-Provider-Preference` | 仅 `/v1/messages` | 仅 `/v1/messages` | — |

### 2.2 `X-GitHub-Api-Version` 的来源

VS Code 扩展代码里写的值会被覆盖：

- HTTP 路径写 `2026-01-09`（`networking.ts:523-532`），WS 路径写 `2025-05-01`。
- 随后 `@vscode/copilot-api` 的 `_mixinHeaders` 统一改写为 `2026-08-01`。

`@vscode/copilot-api` 各版本的取值：

| 版本 | 取值 |
|---|---|
| 0.4.3 | `2026-06-01` |
| 0.5.1 | Auto 用 `2026-08-01`，其余用 `2026-06-01` |
| 0.5.2 | 全部用 `2026-08-01` |

CLI 各版本的取值：

| 版本 | 模型调用 | `/models` |
|---|---|---|
| 1.0.73 | `2026-07-01` | — |
| 1.0.97 起 | — | `2026-09-21` |
| 1.0.98 | `2026-08-01` | `2026-09-21` |

两者都只用于 `copilot_internal/v2/token`：`2025-04-01`。

### 2.3 VS Code 的 `Copilot-Integration-Id` 选择规则（copilot-api `_mixinHeaders`）

按顺序取第一个满足的：

1. 配置了 HMAC 积分 id 和密钥 → 用该 id；
2. sku 为 `no_auth_limited_copilot` → `vscode-nl`；
3. license 校验通过且是 prod 构建 → `vscode-chat`；
4. dev 构建且有 HMAC → `vscode-chat-dev`，并附加 `Request-Hmac: <unixSeconds>.<hex HMAC-SHA256>`；
5. 以上都不满足 → `code-oss`。

传入 `suppressIntegrationId` 时完全不发这个 header。VS Code 自带的本地 `/responses` 代理就是这样做的。

### 2.4 `OpenAI-Intent` 取值（VS Code `locationToIntent`，`chatMLFetcher.ts:2414-2435`）

| Location | 取值 |
|---|---|
| Panel | `conversation-panel` |
| Editor | `conversation-inline` |
| EditingSession | `conversation-edits` |
| Notebook | `conversation-notebook` |
| Terminal | `conversation-terminal` |
| Other | `conversation-other` |
| Agent | `conversation-agent` |
| ResponsesProxy | `responses-proxy` |
| MessagesProxy | `messages-proxy` |

`X-Interaction-Type` 默认与 intent 相同，子 agent 时改为 `conversation-subagent`。
`OpenAI-Intent` 本身始终是 location 对应的值。

### 2.5 `X-Initiator` 规则

**VS Code agent 循环**（`toolCallingLoop.ts:1953`）：以下条件全部成立时为 `user`，否则为 `agent`：

- 第 0 次迭代；
- 不是 continuation；
- 不是子 agent；
- 不是系统发起的请求。

标题生成、摘要、分类、子 agent、重试等请求一律是 `agent`。

**VS Code 本地 responses 代理**（`oaiLanguageModelServer.ts:144-146`）：

- `input` 的最后一项是字符串，或是 `{type:"message", role:"user"}` → `user`；
- 否则 → `agent`。

本代理没有会话状态，适合照搬这条规则。

---

## 3. 请求 Body 的变形

### 3.1 VS Code（`createResponsesRequestBody`，`responsesApi.ts:54-192`，再经过 `chatEndpoint.ts:381-391`）

**固定或条件字段**

| 字段 | 行为 |
|---|---|
| `store` | 恒为 `false` |
| `stream` | `true`；模型 `supports.streaming` 为 false 时改成 `false` |
| `include` | 恒为 `["reasoning.encrypted_content"]` |
| `reasoning` | 只有模型声明了 `supports.reasoning_effort` 才发 `{effort}`，默认 `medium`。**不发送 `summary`**（2026-06 起）。`reasoning.context:"all_turns"` 已于 2026-07-01 移除 |
| `truncation` | 默认 **`"disabled"`**；打开 `chat.advanced.useResponsesApiTruncation` 时为 `"auto"` |
| `max_output_tokens` | 取 `capabilities.limits.max_output_tokens`，缺省 4096 |
| `text` | `{verbosity:"low"}`，仅限 `gpt-5.1`、`gpt-5-mini`，以及开启实验（默认开）时的 `gpt-5.6*` / `gpt-6*` |
| `prompt_cache_options` | 支持的模型（`gpt-5.6*`、`gpt-6*`）发 `{mode:"implicit"}`；实验开启时为 `{mode:"explicit"}` |
| `prompt_cache_key` | 实验开启时（默认关）为 `${conversationId}:${family}` |
| `context_management` | 实验开启时（默认关）为 `[{type:"compaction", compact_threshold}]`；`gpt-5` / `5.1` / `5.2` 不发 |
| `tools` | 列表为空时为 `undefined`；模型不支持 tool_calls 时删除 |
| `tool_choice` | 对象形式改写为 `{type:"function", name}` |

**从不发送的字段**：`instructions`、`temperature`、`top_p`、`parallel_tool_calls`、`service_tier`、`metadata`、`user`。

**tools**

- 每个工具写成 `{type:"function", name, description, strict:false, parameters}`。
- 没有参数时 `parameters` 补为 `{type:"object", properties:{}}`。
- **不使用 `custom` 工具**，apply_patch 也是普通 function。
- 支持 tool search 的模型（gpt-5.4 / 5.5 / 5.6 / 6），在 Agent 场景下：
  - 把 `{type:"tool_search", execution:"client", ...}` 放在列表首位；
  - deferred 工具不放进列表；
  - 通过搜索加载的工具调用会带上 `namespace`。

**消息 → `input` 项**（`responsesApi.ts:424-529`）

- **system**：转成 `{type:"message", role:"system", content:[input_text]}`。
  不改成 `developer`，也不放进 `instructions`。
- **user**：content 可以是以下几种：
  - `input_text`
  - `input_image {detail:"auto", image_url}`
  - PDF：`input_file {filename:"document.pdf", file_data:"data:application/pdf;base64,..."}`
  - explicit 缓存模式下，在内容块上加 `prompt_cache_breakpoint:{mode:"explicit"}`。
- **assistant** 按以下顺序展开：
  1. `compaction {id, encrypted_content}`。
  2. `reasoning {id, summary:[], encrypted_content}`。
     - summary 文本**不回放**。
     - 只回放来源为 responses 的 thinking；CAPI 的 reasoning id 是不透明 blob，不带 `rs` 前缀。
  3. `message {role:"assistant", content:[output_text], phase?}`。**不带 `id`/`status`**。
  4. `function_call {name, arguments, call_id, namespace?}`。**不带 item `id`**。
- **tool 结果**：
  - 写成 `function_call_output {call_id, output:<拼接后的字符串>}`。
  - 图片和 PDF 另起一条 user 消息附在后面，文字为
    `"Image associated with the above tool call:"`（PDF 同理）。
  - explicit 缓存模式下 `output` 是数组。
- **历史裁剪**：存在 compaction 项时，丢弃最新 compaction 之前的全部消息。
- **序列化**：修复孤立的 UTF-16 surrogate（`jsonBody.ts:33`）。如果不修，请求会失败。

### 3.2 CLI（`openai_conversion.rs`）

内部保存的是近似 chat-completions 形状的消息，发送前转换成 Responses `input`。与 VS Code 的差异如下：

| 项目 | CLI 的做法 |
|---|---|
| `instructions` | **使用**，系统提示放在这里 [确认] |
| `tools` | 包含 `function`、**`custom`**（带 grammar 的 apply_patch 类工具）、`web_search`、`tool_search`、`namespace`、`defer_loading` |
| `tool_choice` | `auto` / `none` / `required` / `allowed_tools` |
| `reasoning` | `effort`（`none`…`max`，由模型定义）和 **`summary`**（`none/concise/detailed`） |
| `parallel_tool_calls`、`text.verbosity`、`max_output_tokens` | 都会发送 |
| `include` | `["reasoning.encrypted_content"]` |
| `prompt_cache_key` | 由实验 `openaiPromptCachingArm` 控制 |
| `store` | 字段存在，值推断为 `false` [推断] |

**reasoning 回放**

- 回放项为 `reasoning {id, summary:[summary_text], encrypted_content}`。
- 实验 `copilot_cli_drop_replayed_reasoning_summary` 开启时，丢弃回放中的 summary。
- 只有存储时的 `providerId` 与当前目标完全一致，才回放 encrypted_content 和 item id。
- 会话恢复（resume）时剥离加密内容（`COPILOT_STRIP_REASONING_ON_RESUME`）。

**回放清洗**（1.0.97 新增）

- CAPI 会拒绝部分回放的 item id。
- CLI 遇到拒绝后，剥离被拒的 id 或删掉 reasoning 项，然后重试。
- 相关日志：`CAPI rejected Responses replay state; retrying without rejected item ids`。
- 关闭开关：`COPILOT_CLI_DISABLE_RESPONSES_REPLAY_SANITATION`。

**请求体积**

- 请求大小上限：`COPILOT_CAPI_RESPONSES_MAX_REQUEST_SIZE_BYTES`。
- 超大的工具输出替换为 `[Omitted: it exceeds the Responses API size limit.]`。
- 上传超时后缩小请求重试（1.0.97 新增）。
- 模型拒绝图片时，去掉图片重试。

**其他**：`phase` 原样往返；合成的 function call id 以 `fc_` 开头。

---

## 4. 响应 Headers

| Header | VS Code | CLI | 用途 |
|---|---|---|---|
| `x-request-id` | ✓ | ✓ | 请求 id |
| `x-github-request-id` | ✓ | ✓ | 排障、错误上报 |
| `x-copilot-service-request-id` | ✓ | ✓ | 遥测关联 |
| `x-github-copilot-request-te` | ✓（WS 从每帧的 `headers` 读） | ✓ | 遥测 / 资格信号 |
| `x-quota-snapshot-<quota>` | 读 `chat`、`premium_models`、`premium_interactions` | 前缀匹配 | 值是 URL 编码的键值，键有 `ent`、`ov`、`ovPerm`、`rem`、`rst`（CLI 还读 `tbb`、`ovEnt`、`tot`、`totRem`）。成功和失败的响应都会读 |
| `x-usage-ratelimit-<window>` | 读 `session`、`weekly` | 前缀匹配，如 `5hour-session-ratelimits`、`weekly-session-ratelimits` | 限流 UI，编码同上 |
| `retry-after` | 402（日期或秒数）、429 | ✓ | 重试 |
| `retry-after-ms`、`x-should-retry` | — | ✓（1.0.87 起） | 重试 |
| `x-ratelimit-exceeded` | 429 时读 | — | 限流 key |
| `X-Copilot-Experiment` / `x-copilot-api-exp-assignment-context` | ✓ | ✓ | 服务端实验上下文 |
| `azureml-model-deployment`、`apim-request-id` | ✓（遥测、日志） | — | |
| `Copilot-Edits-Session` | ✓ | — | 投机解码 token |
| `Copilot-Session-Token` | — | ✓ | Auto 会话 token 刷新 |

VS Code 不检查 `content-type`，响应 body 一律交给 SSE 解析器。

---

## 5. 响应 Body

### 5.1 SSE 事件

**VS Code 消费的事件**（`responsesApi.ts:1293-1550`）

- `error`：flat 格式 `{code, message, param}`，处理为终止性的 ServerError。
- `response.output_text.delta`：如果与上一个 text delta 的 `output_index` 不同，先插入 `\n\n`。
- `response.output_item.added`：处理 `function_call` 和 `tool_search_call`。
- `response.function_call_arguments.delta`：**按 `output_index` 累积参数**。
- `response.output_item.done`：
  - `function_call`：取最终参数；
  - `reasoning`：只有带 `encrypted_content` 的才记录，记录 `id` + `encrypted_content`；
  - `message`：读取 `phase`。
- `response.reasoning_summary_text.delta`：代码注释说明 CAPI 模型通常不流式输出 summary。
- `response.reasoning_summary_part.done`
- `response.completed`：读取 `response.id`（作为 marker）、usage，并从 `response.output` 重建文本。
- `response.incomplete`：`max_output_tokens` → Length；`content_filter` → ContentFilter（读 `response.content_filters[]`）。
- `response.failed`
- 忽略：`response.created`、`in_progress`、`content_part.*`、`output_text.done`、`function_call_arguments.done`、`reasoning_text.*`。

**CLI 额外处理的事件**

- `response.reasoning_text.delta`
- `response.reasoning_summary_part.added`
- `response.custom_tool_call_input.delta`
- `response.web_search_call.*`
- `response.image_generation_processing_failed`

输出项类型还有 `custom_tool_call`、`web_search_call` 和 programmatic tool call。

### 5.2 Usage 与 CAPI 扩展字段

**标准 usage**

- `usage.input_tokens` / `output_tokens` / `total_tokens`
- `input_tokens_details.cached_tokens`
- `output_tokens_details.reasoning_tokens`
- CLI 还读 `input_tokens_details.cache_write_tokens`（CAPI 扩展）

**`copilot_usage`**

- 位于 `response.completed` **事件顶层**，不在 `response` 对象里。
- 结构：`{total_nano_aiu, model?, token_details:[{batch_size, cost_per_batch, token_count, token_type, model?}]}`。
- VS Code 用 `total_nano_aiu / 1e9` 换算 credits。

**其他扩展字段**

- `copilot_quota_snapshots`：WS 下放在 body 里，作用相当于 HTTP 的 quota header。
- `response.content_filters[]`：`content_filter_raw` / `content_filter_results`。
- CLI 还读 `recommended_auto_tier`、`copilot_annotations`、`copilot_citations`、`copilot_citable_sources`。

### 5.3 Item ID 与 `output_index`（与本代理的流式 ID 归一化有关）

- VS Code 按 **`output_index`** 关联工具调用和文本边界。message 和 function_call 的 item id 不使用，也不回放。
- reasoning 回放时，VS Code 用的是 **`output_item.done` 上的 `item.id`**，与同一事件里的 `encrypted_content` 配对。
  - thinking 的 id 会被每个新 delta 覆盖。
  - 同一响应里有多条 reasoning 时，只保留最后一条加密内容。
- CAPI 生产环境的 reasoning id 是不透明长串，不带 `rs` 前缀（commit `fd249800b7a`）。
- CLI 会回放 item id。1.0.97 起 CAPI 会拒绝某些回放的 id，CLI 因此做了回放清洗（见 3.2）。

> 对本代理的提示：`responses-stream.ts` 把同一 `output_index` 后续事件的 id 统一成首次出现的 id。
> 对 VS Code 类客户端，这会让回放的 reasoning 变成"added 事件的 id + done 事件的
> encrypted_content"组合。如果 CAPI 在 added 和 done 上给出的 reasoning id 不同，这种组合可能被拒。
> 需要实测确认。

### 5.4 错误处理

**HTTP 错误（VS Code `chatMLFetcher.ts:1652-1886`）**：响应 body 是 JSON，先取出嵌套的 `.error`，再按状态码分类。

| 状态码 | 条件 | 处理 |
|---|---|---|
| 400 | 内容含 `off_topic` | 判为跑题 |
| 400 | `code=previous_response_not_found` | 去掉 marker 重试 |
| 401 | 带 `authorize_url` | 要求授权 |
| 401/403 | 其他 | 重置 token |
| 402 | — | 配额用尽，读 `retry-after` |
| 404 | — | NotFound |
| 422 | — | RAI 过滤 |
| 424 | — | 依赖失败 |
| 429 | `extension_blocked` / `rate_limit_error` | 扩展被封 |
| 429 | 其他 | 限流 |
| 466 | — | 客户端版本不受支持 |
| 499 | — | 服务端取消 |
| 503 | — | 按上游限流（`upstream_provider_rate_limit`）处理 |
| 其他 5xx | — | 服务端错误 |

`500` 和 `502` 默认会重试：先依次在 1s、10s、10s 后 ping `{capi}/_ping`，再重发请求，重试时 `X-Initiator: agent`。

**错误码（WS / body）**

| 分类 | 错误码 |
|---|---|
| 限流 | `rate_limited`、`user_model_rate_limited`、`user_global_rate_limited`、`user_weekly_rate_limited`、`integration_rate_limited`、`model_overloaded`、`agent_mode_limit_exceeded` |
| 配额 | `quota_exceeded`、`free_quota_exceeded`、`session_quota_exceeded`、`overage_limit_reached`、`billing_not_configured`、`additional_spend_limit_reached` |
| 模型 | `model_not_supported`、`model_not_available_for_integrator`、`model_max_prompt_tokens_exceeded` |
| 其他 | `content_filter`、`content_policy_violation`、`cyber_policy`、`invalid_prompt`、`request_too_large`、`service_unavailable`、`session_expired`、`internal_error`、`misdirected_request`（421） |

---

## 6. 近期上游变化时间线（2026-07 起）

| 日期 | 变化 |
|---|---|
| 06-29 / 06-30 | VS Code 不再发送 `reasoning.summary` |
| 07-01 | VS Code 移除 `reasoning.context:"all_turns"`；开始做 prompt caching（`prompt_cache_options`、`prompt_cache_breakpoint`） |
| 07-02 | SSE `error` 事件改为终止性错误 |
| 07-08 | user / system 项显式加 `type:"message"` |
| 07-18 | WS 握手带上 `X-Copilot-Client-Exp-Assignment-Context` |
| 07-20 | GPT-5.6 使用 `text.verbosity:"low"` |
| 07-23 | WS 连接按模型和子 agent 分开 |
| 08-04 / 08-10 | copilot-api 升级到 0.5.x，`X-GitHub-Api-Version` 变为 **`2026-08-01`** |
| 08-12 | 用 `previous_response_id` 时，缺失的工具结果补 `outcome_unknown` |
| 08-13 | 无参工具补 `{type:"object", properties:{}}` |
| 08-25 | 请求 JSON 修复孤立 surrogate |
| 09-05 / 10-01 | 读取 `X-Copilot-Service-Request-Id`、`X-GitHub-Copilot-Request-Te` |
| 09-17 / 10-01 | reasoning 是否回放改为按来源判断，不再看 `rs` 前缀（CAPI id 不透明） |

CLI 侧（版本号对应时间较粗）：

- **1.0.87**：新增 `X-GitHub-Copilot-Request-TE`、`x-usage-ratelimit-*`、`retry-after-ms`、`x-should-retry`、421 重解析、请求大小上限。
- **1.0.97**：`/models` 改用 `2026-09-21`；新增 Responses 回放清洗、丢弃回放 summary、上传超时缩包重试。
- **1.0.98**：模型调用使用 `2026-08-01`。

---

## 7. 对本代理的差距清单（待决定是否跟进）

1. **`X-GitHub-Api-Version`**：两端都已是 `2026-08-01`，本代理默认值仍是 `2025-10-01`。
2. **`Editor-Version` / `Editor-Plugin-Version` 默认值过旧**：当前应为 `vscode/1.142.0`、`copilot-chat/0.70.0`。
3. **缺少的身份 / 计费 header**：`Copilot-Integration-Id`、`OpenAI-Intent`、`X-Interaction-Type`、`X-Initiator`、`X-Interaction-Id`、`X-Agent-Task-Id`、`User-Agent`。
   - 可参照 VS Code 本地 responses 代理：intent 用 `responses-proxy`、不发 Integration-Id、`X-Initiator` 按 input 末项推断。
   - 也可模拟正式版 `vscode-chat` + `conversation-agent`。
   - `X-Initiator` 可能影响 premium request 计费，需要优先考虑。
4. **响应头透传**：现在只保留 `x-request-id` 和 `Content-Type`。可以考虑增加：
   - `x-github-request-id`
   - `x-quota-snapshot-*`
   - `x-usage-ratelimit-*`
   - `retry-after`、`retry-after-ms`、`x-should-retry`
5. **流式 ID 归一化**：需要确认 CAPI 在 added 和 done 上给出的 reasoning id 是否一致，以及回放 added id + done encrypted_content 是否会被拒（见 5.3）。
6. **`previous_response_id`**：VS Code 走 HTTP 请求 CAPI 时从不使用。客户端如果带了这个字段，CAPI 在 `store:false` 下大概率返回 `previous_response_not_found`。只有 WS 支持增量续写。
7. **`gpt-5.6-sol` + `service_tier` 改写**：这是本代理自加的 body 改写（`src/responses.ts`），两个官方客户端都不发送 `service_tier`。
