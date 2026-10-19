# VS Code 官方 `/responses` 代理实现细节

VS Code Copilot Chat 扩展内置了一个本地 OpenAI Responses 代理。它的用途与本项目最接近：
把外部 Responses 客户端接到 CAPI。本文逐层记录这个代理如何构造请求和处理响应，作为本代理对齐的参考。

**快照版本**

- 扩展：`copilot-chat/0.70.0`，HEAD `d956e8a6ac5`（2026-10-14）
- `@vscode/copilot-api@0.5.2`

**路径约定**：文中路径相对 `/Users/wenkai/workspace/vscode/extensions/copilot/`；
copilot-api 部分引用的是格式化后的 npm 包 `dist/index.js`。

CAPI 侧更完整的协议说明见 [capi-responses.md](capi-responses.md)。

---

## 1. 用途与生命周期

**使用方**：OpenAI Codex 扩展（VS Code 内的 Codex agent）。

**注册**（`src/extension/externalAgents/vscode-node/lmProxyContrib.ts`）：

- 满足以下任一条件时，调用 `vscode.lm.registerLanguageModelProxyProvider` 注册：
  - Copilot token 的 `codexAgentEnabled` 为真；
  - 设置 `chat.experimental.codex.enabled` 为真。
- token 变化时重新判断。

**启动**（`src/extension/externalAgents/node/modelProxyProvider.ts`）：

1. Codex 扩展请求模型代理时，`provideModelProxy` 新建一个 `OpenAILanguageModelServer`，监听 `127.0.0.1:0`（随机端口）。
2. 返回 `{ uri: http://localhost:<port>, key: "vscode-lm-<uuid>" }`。
3. Codex 把它当作 `OPENAI_BASE_URL` 加 API key 使用。

**实现**：`src/extension/externalAgents/node/oaiLanguageModelServer.ts`，共 525 行。
它自身只负责 HTTP 收发。真正的上游请求交给 Copilot Chat 的通用请求管线
`IChatMLFetcher.fetchOne`，做法是用 `StreamingPassThroughEndpoint` 伪装成一个模型 endpoint 接入管线。

调用链如下：

```
Codex ──HTTP──▶ OpenAILanguageModelServer.handleResponsesRequest
                 │  解析 body、过滤 web_search、推断 initiator、选模型
                 │  res.writeHead(200, SSE)                ← 先回 200
                 ▼
          StreamingPassThroughEndpoint.makeChatRequest2
                 ▼
          ChatMLFetcherImpl.fetchOne → fetchMany            (chatMLFetcher.ts)
                 │  createRequestBody() → 原样返回入站 body
                 │  isValidChatPayload()
                 ▼
          _fetchAndStreamChat → _doFetchViaHttp → _fetchWithInstrumentation
                 ▼
          postRequest → networkRequest                      (networking.ts)
                 │  组装第一层 headers；调用 interceptBody(body)
                 ▼
          CAPIClientImpl.makeRequest                        (capiClient.ts)
                 ▼
          copilot-api CAPIClient.makeRequest → _mixinHeaders → URL 解析
                 ▼
          FetcherService.fetch → BaseFetchFetcher.fetch     (UA、Content-Type、序列化)
                 ▼
          POST {token.endpoints.api}/responses
                 ▼
          processResponseFromChatEndpoint：逐块写回 Codex，同时解析 SSE 用于日志和遥测
```

---

## 2. 入站处理（`OpenAILanguageModelServer`）

### 2.1 路由

| 方法 / 路径 | 行为 |
|---|---|
| `OPTIONS *` | `200`，空 body |
| `POST /v1/responses`、`/responses`、`//responses` | Responses 代理。`//responses` 用来兼容以 `/` 结尾的 `OPENAI_BASE_URL` |
| `GET /` | `200 Hello from LanguageModelServer` |
| 其他 | `404 {"error":"Not found"}` |

### 2.2 鉴权

- 先读完整个 body，再校验 `Authorization: Bearer <nonce>`。
- 校验失败返回 `401 {"error":"Invalid authentication"}`。

### 2.3 Body 解析与改写（仅此一处主动改写）

```ts
const requestBody = JSON.parse(bodyString);
if (Array.isArray(requestBody.tools)) {
  requestBody.tools = requestBody.tools.filter(tool =>
    !(typeof tool?.type === 'string' && tool.type.startsWith('web_search')));
}
```

- 删除所有 `type` 以 `web_search` 开头的工具（CAPI 不支持），并记一条 warn 日志。
- body 其余部分保持原样，包括 `model`、`input`、`instructions`、`reasoning`、`store`、
  `previous_response_id`、`include` 等。
- JSON 解析失败时返回 `500 {"error":"Failed to process chat request", details}`。

### 2.4 `X-Initiator` 推断

```ts
const lastMessage = requestBody.input?.at(-1);
const isUserInitiatedMessage = typeof lastMessage === 'string' ||
    lastMessage?.type === 'message' && lastMessage.role === 'user';
```

- `input` 最后一项是字符串，或是 `{type:"message", role:"user"}` → `user`。
- 其他情况（`function_call_output`、`reasoning`、assistant message 等）→ `agent`。
- 注意：省略 `type` 的 easy-input message（`{role:"user", content}`）会被判为 `agent`。
- `input` 是字符串时，`.at(-1)` 取的是最后一个字符，结果为 `user`。

### 2.5 选模型

```ts
const endpoints = await this.endpointProvider.getAllChatEndpoints();
selected = requestedModel ? endpoints.find(e => e.family === requestedModel) : endpoints[0];
```

- 用 `body.model` 与 endpoint 的 **`family`** 精确匹配，不是与 model id 匹配。
- 没有可用模型，或匹配不到时，返回 `404 {"error":"No language models available" | "No model found matching criteria"}`。
- 匹配到的 endpoint 决定以下内容：
  - 上游 URL；
  - `interceptBody` 的模型能力判断；
  - `modelMetadata.requestHeaders`。
- **`body.model` 不会被改写**，CAPI 收到的是客户端原值，即 family 名。

### 2.6 先回 200

```ts
res.writeHead(200, {
  'Content-Type': 'text/event-stream',
  'Cache-Control': 'no-cache',
  'Connection': 'keep-alive',
});
```

- 在请求上游**之前**就把状态码和 header 写死。上游的状态码和响应头都不会到达客户端（见 §5）。
- `res.on('close')` 触发时取消 `CancellationToken`，进而 abort 上游 fetch。

### 2.7 调用管线的参数

```ts
streamingEndpoint.makeChatRequest2({
  debugName: 'oaiLMServer',
  messages: messagesForLogging,      // 仅用于日志和校验
  finishedCb: async () => undefined,
  location: ChatLocation.ResponsesProxy,
  modelCapabilities: { enableThinking: true },
  userInitiatedRequest: isUserInitiatedMessage,
}, token);
```

- `messagesForLogging` 来自 `responseApiInputToRawMessagesForLogging(body)`，**只在 `input` 是数组时计算**，否则为 `[]`。
- 没有传 `turnId`、`conversationId`、`useWebSocket`、`enableRetryOnError`、`telemetryProperties.requestId`。
  因此：
  - 只走 HTTP，不用 WebSocket；
  - 不重试；
  - `X-Request-Id` 每次新生成 UUID。
- 调用返回的 `ChatResponse`（成功或失败）**被忽略**，之后直接 `res.end()`。

---

## 3. 请求 Body 在管线中的变化

| 步骤 | 位置 | 对 body 的影响 |
|---|---|---|
| `fetchOne` | `chatMLFetcher.ts:85-94` | `requestOptions` 加 `n:1`，**不进 body** |
| `fetchMany` | `chatMLFetcher.ts:162-177` | 构造 `max_tokens`、`temperature`、`top_p`、`stream:true` 等 `postOptions`。但 `StreamingPassThroughEndpoint.createRequestBody()` **直接返回入站 body**，`postOptions` 不生效 |
| `isValidChatPayload` | `chatMLFetcher.ts:2372-2392` | 不改 body，只做校验：`messagesForLogging` 为空时判定失败（`No messages provided`），**不发上游请求**。所以 `input` 是字符串的请求会静默失败（见 §5.3） |
| `interceptBody` | `networking.ts:534-536` → `chatEndpoint.ts:381-391` | 模型 `supportsToolCalls` 为 false 时 `delete body.tools`；模型 `supports.streaming` 为 false 时 `body.stream = false`。chat-completions 专用的 token 参数改写对 Responses 不生效 |
| 序列化 | `baseFetchFetcher.ts:43-48` → `jsonBody.ts:33` | `stringifyJsonBody`：与 `JSON.stringify` 相同，额外把孤立的 UTF-16 surrogate 修复为合法字符 |

**结论**：body 最终的变形只有四处：

1. 删除 `web_search*` 工具；
2. 模型不支持工具调用时删除 `tools`；
3. 模型不支持流式时把 `stream` 改为 `false`；
4. 修复孤立 surrogate。

**不做的事**：

- 不补 `store`、`include`、`stream`；
- 不处理 `previous_response_id`；
- 不改 `model`；
- 不注入 `prompt_cache_key`、`reasoning` 等字段。

扩展自己的 agent 请求所用的 `createResponsesRequestBody`（见 capi-responses.md §3.1）**不参与这个代理**。

---

## 4. 请求 Headers 的构造

headers 分层组装，后写的覆盖先写的。

### 4.1 第一层：`networkRequest`（`networking.ts:519-532`）

```ts
headers = {
  Authorization: `Bearer ${copilotToken.token}`,   // secretKey ??= copilotToken.token
  'X-Request-Id': ourRequestId,                    // 每次 generateUuid()
  'OpenAI-Intent': 'responses-proxy',              // locationToIntent(ResponsesProxy)
  'X-GitHub-Api-Version': '2026-01-09',            // 之后被 mixin 覆盖
  // additionalHeaders（chatMLFetcher.ts:1524-1530）
  'X-Interaction-Id': interactionService.interactionId,
  'X-Initiator': userInitiated ? 'user' : 'agent',
  // endpoint.getExtraHeaders()
  ...modelMetadata.requestHeaders,                 // 模型元数据里自带的 headers（如 Auto 的 Copilot-Session-Token）
  'User-Agent': `vscode_codex${inboundUA.substring(inboundUA.indexOf('/'))}`,
};
headers['X-Interaction-Type'] = 'responses-proxy';
headers['X-Agent-Task-Id'] = ourRequestId;
```

- `X-Interaction-Id` 是扩展进程内的全局 UUID，只在 `startInteraction()` 时重置。
  它与 Chat 面板共享，**不按 Codex 会话区分**。
- `Copilot-Vision-Request` 的判断条件是 `request.messages`，Responses body 用的是 `input`，所以**永远不发**。
- 对 Responses 模型，`getExtraHeaders` 不加 `anthropic-beta` 和 `X-Model-Provider-Preference`。
- **User-Agent 改写**（`StreamingPassThroughEndpoint.getUserAgent`）：
  - 入站 UA 含 `/` 时，把第一个 `/` 之前的产品名替换成 `vscode_codex`，
    例如 `codex_cli_rs/0.50.0 (Mac OS ...)` → `vscode_codex/0.50.0 (Mac OS ...)`。
  - 不含 `/` 时为 `vscode_codex/<原 UA>`。
  - 入站没有 UA 时不设置，由第四层补默认值。
- `getEndpointFetchOptions()` 返回 `{ suppressIntegrationId: true }`。
- 请求超时为 `requestTimeoutMs`。

### 4.2 第二层：`CAPIClientImpl.makeRequest`（`capiClient.ts:41-58`）

有实验上下文时添加：

- `VScode-ABExpContext: <ctx>`
- `X-Copilot-Client-Exp-Assignment-Context: <ctx>`

### 4.3 第三层：copilot-api `_mixinHeaders`（`ChatResponses` 类型）

```js
r["X-GitHub-Api-Version"]  = "2026-08-01";             // 覆盖第一层的值
r["VScode-SessionId"]      = vscode.env.sessionId;     // <uuid><Date.now()>，每个窗口会话一个
r["VScode-MachineId"]      = vscode.env.machineId;
r["Editor-Device-Id"]      = vscode.env.devDeviceId;
r["Editor-Plugin-Version"] = `copilot-chat/0.70.0`;
r["Editor-Version"]        = `vscode/1.142.0`;
// suppressIntegrationId = true → 不写 Copilot-Integration-Id，也不写 Request-Hmac
```

URL 由 copilot-api 按 `RequestType.ChatResponses` 解析，得到 `{token.endpoints.api}/responses`。

### 4.4 第四层：`BaseFetchFetcher.fetch`（`baseFetchFetcher.ts:35-48`）

- `User-Agent: GitHubCopilotChat/0.70.0`：仅在第一层没有设置时才补。
- `X-VSCode-User-Agent-Library-Version: <fetcher 库名>`
- `Content-Type: application/json`

### 4.5 最终 header 清单

```
Authorization: Bearer <copilot token>
Content-Type: application/json
X-GitHub-Api-Version: 2026-08-01
X-Request-Id: <uuid>
X-Agent-Task-Id: <同 X-Request-Id>
X-Interaction-Id: <扩展进程级 uuid>
X-Interaction-Type: responses-proxy
OpenAI-Intent: responses-proxy
X-Initiator: user | agent
User-Agent: vscode_codex/<入站 UA 版本部分>     (入站无 UA 时为 GitHubCopilotChat/0.70.0)
X-VSCode-User-Agent-Library-Version: <lib>
VScode-SessionId / VScode-MachineId / Editor-Device-Id
Editor-Plugin-Version: copilot-chat/0.70.0
Editor-Version: vscode/1.142.0
[VScode-ABExpContext, X-Copilot-Client-Exp-Assignment-Context]   (有实验上下文时)
[modelMetadata.requestHeaders]                                     (模型元数据自带时)
— 不发: Copilot-Integration-Id, Request-Hmac, Copilot-Vision-Request, anthropic-beta, Accept
```

入站 header 中**只有 `User-Agent` 被读取并改写转发**。`Accept`、session 类 header 等其他入站 header 一律不透传。

---

## 5. 响应处理

### 5.1 上游 200：流式透传

`StreamingPassThroughEndpoint.processResponseFromChatEndpoint`：

```ts
for await (const chunk of body) {
  if (cancellationToken?.isCancellationRequested) break;
  this.responseStream.write(chunk);   // 原始字节直接写回客户端
  parser.feed(chunk);                 // 旁路解析，只用于日志和遥测
}
```

- **body 字节原样转发**：不改 item id，不改事件，不重新分帧。
- 旁路解析使用 `SSEParser` 加 `OpenAIResponsesProcessor`，产出 `ChatCompletion`，用途有三：
  - 请求日志；
  - token usage 和 `copilot_usage` 遥测；
  - 读取 `X-Request-ID`、`x-github-request-id`、`x-copilot-service-request-id`、
    `X-GitHub-Copilot-Request-Te`、实验上下文等响应头，写入遥测。
- 旁路解析出错（例如收到 SSE `error` 事件）时，只让内部 iterable reject。已经写出的字节不受影响。
- 管线还会顺带处理以下响应头：
  - `Copilot-Edits-Session`：存入扩展的 auth 服务；
  - `x-quota-snapshot-*`：更新扩展 UI 的配额显示（`processQuotaHeaders`）。
- 上游 `Content-Type` 不检查。即使 `interceptBody` 把 `stream` 改成了 `false`、上游返回 JSON，
  也照样以 `text/event-stream` 原样写回。
- 客户端断开时，cancel 生效：读取循环 `break`，上游 body 被 `destroy()`。

### 5.2 响应 Headers

- 回给客户端的**只有** §2.6 写死的三个 header：`Content-Type: text/event-stream`、`Cache-Control: no-cache`、`Connection: keep-alive`。
- 上游的所有响应头（`x-request-id`、配额、限流、`retry-after` 等）**都不转发**，只在扩展内部消费。

### 5.3 上游非 200 或网络错误：错误被吞掉

- `_doFetchViaHttp` 遇到 `status !== 200` 时调用 `_handleError`（`chatMLFetcher.ts:1652+`）：
  - 读取并解析错误 body；
  - 401/403 时重置 Copilot token；
  - 读取 quota header；
  - 返回一个 `ChatRequestFailed` 对象。
- 网络异常在 `fetchMany` 里被 catch，同样转成失败结果返回。
- `enableRetryOnError` 未设置，所以**不重试**：不重试 500/502，不 ping `/_ping`，不回退 WebSocket。
  CAPI 请求也不走 `networkRequest` 里的"连接重置重试一次"分支，该分支只对非 CAPI URL 生效。
- 代理忽略返回值，直接 `res.end()`。

**客户端看到的结果是 `200 text/event-stream` 加一个空 body**。上游状态码、错误码、错误信息全部丢失。

以下情况也表现为"200 + 空流"：

- `input` 是字符串，或 `input` 数组转换后为空：`isValidChatPayload` 判定失败，根本不请求上游；
- Copilot token 缺失：`key is missing`。

如果在 `writeHead(200)` 之后抛出异常，catch 块里再调用 `res.writeHead(500)` 会因 header 已发送而失败。

---

## 6. 与本代理的对比

| 方面 | 官方代理 | 本代理（`src/responses.ts`） |
|---|---|---|
| 入站鉴权 | `Bearer <nonce>`，失败返回 `401` | `Bearer <key>`，失败返回 `404 null` |
| 选模型 | `family` 精确匹配，body.model 不改 | 不选择，body.model 透传（`gpt-5.6-sol` + fast/priority 时改写） |
| Body 变形 | 删 `web_search*` 工具；按模型能力删 tools、改 stream；修复 surrogate | 只有 `gpt-5.6-sol` 的 service_tier 改写 |
| 字符串 `input` | 静默失败（200 空流） | 正常透传 |
| `X-GitHub-Api-Version` | `2026-08-01` | 默认 `2025-10-01` |
| `OpenAI-Intent` / `X-Interaction-Type` | `responses-proxy` | 不发 |
| `X-Initiator` | 按 input 末项推断 | 不发 |
| `X-Interaction-Id` / `X-Agent-Task-Id` | 进程级 UUID / 等于 request id | 不发 |
| `Copilot-Integration-Id` | 不发 | 不发 |
| `User-Agent` | `vscode_codex/<入站版本>` | Bun 默认 |
| `Editor-*` / `VScode-*` | 真实值（0.70.0 / 1.142.0） | env 配置（默认 0.41.2 / 1.113.0） |
| 入站 header 透传 | 仅 `User-Agent`（改写后） | `Accept`；session header → `VScode-SessionId` |
| 传输 | 仅 HTTP | 仅 HTTP |
| 上游错误 | 吞掉，返回 200 空流 | 原样透传状态码和 body |
| 响应头 | 一律不转发，固定三个 SSE header | 转发 `x-request-id`、`Content-Type` |
| 流式 body | 原始字节透传 | 按 `output_index` 归一化 item id 后转发 |
| 重试 | 无 | 无 |

**可以借鉴**：

- 身份类 headers：`responses-proxy` intent、`X-Initiator` 推断规则、不发 Integration-Id、UA 改写方式；
- API 和编辑器版本号；
- 过滤 `web_search*` 工具（如果需要兼容 Codex）。

**不应照搬**：

- 先回 200 再请求上游、吞掉错误；
- 丢弃全部响应头；
- 用 family 匹配并强依赖 `/models` 元数据；
- 字符串 `input` 静默失败。

**值得注意**：官方代理对流式 body 完全不做 id 处理，Codex 依然可以正常工作。
这说明 `responses-stream.ts` 的 id 归一化至少对 Codex 类客户端不是必需的。
