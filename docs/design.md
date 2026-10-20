# Copilot API Proxy — 透传代理设计

## 透传原则

代理只服务 Responses API 客户端（Codex 的 gpt 模型、grok-build 的 grok 模型）。
Request body 不做校验，只读取 `input` 计算 `X-Initiator`，以及把
`gpt-5.6-sol` + `service_tier: fast|priority` 改写为 `gpt-5.6-sol-fast`。CAPI 默认
返回 usage，代理不添加 usage 请求字段。

上游状态码原样转发；response body 除 Responses 流式 ID 归一化（见下）外原样转发。
代理自身故障返回 502。

## 路由与上游路径映射

| 代理端点 | 上游路径 |
|----------|----------|
| `POST /responses` | `{api}/responses` |
| `HEAD /` | `200` |

`/responses` 的上游路径无 `/v1` 前缀。

其他所有请求 → 404。

## 流式转发

`/responses` 上游返回 `text/event-stream` 时，经 `src/responses-stream.ts` 归一化后转发：
按 `output_index` 保留首次出现的输出项 ID，统一后续 `item.id`、`item_id` 和生命周期事件
（`response.created/queued/in_progress/completed/failed/incomplete`）`response.output` 中的 ID。
每个请求独立记录，完整事件到达后立即转发；无需修改的事件（含注释、`event:` 行和原换行符）、
非 JSON 或缺少 `type` 的 data 按原字节转发。`call_id`、响应 ID 和加密 reasoning 内容保持原值。

SSE 解析照搬 openai-node（`src/internal/decoders/line.ts` 的 `LineDecoder`、
`src/core/streaming.ts` 的 `SSEDecoder`）：支持 CR / LF / CRLF 及跨 chunk 拆分，行尾 CR
立即结束该行；字段按第一个 `:` 切分并去掉值开头一个空格，多个 `data:` 以 `\n` 拼接；
上游最后一个事件缺少空行时在 EOF 仍会处理，但不补写空行。ID 规则对应 SDK
accumulator 的校验：`item_id` 必须等于 `output[output_index].id`，done 与 completed
中的 ID 必须与 added 一致，否则官方 SDK 会直接抛错。

**为什么必须归一化（2026-10 实测）**：CAPI 对同一输出项的每个事件都给出不同的不透明 ID
（`output_item.added`、各个 delta、`output_item.done`、`response.completed` 各不相同，
均为 ~424 字符的加密串）。Codex 在 `output_item.added` 时以该 ID 发出 item started，
delta 挂在该 ID 上，`output_item.done` 时以 done 事件的 ID 发出 item completed；ID 不一致会
导致 started 的项永远不完成、completed 的项没有开始。Codex 回放历史时会剥离不含 `_` 前缀的
ID，CAPI 也接受"added 的 ID + done 的 encrypted_content"组合回放，所以归一化不影响回放。

其余响应直接转发上游 `ReadableStream`。standalone 代理内置相同的归一化逻辑，保持单文件运行。

## 请求 Headers

每次代理请求组装以下 headers：

```
Authorization: Bearer <copilot_token>
Content-Type: application/json
X-GitHub-Api-Version: <GITHUB_API_VERSION>          (默认 2026-08-01)
VScode-SessionId / VScode-MachineId / Editor-Device-Id
X-Request-Id: <uuid>                                 (每次请求新生成)
X-Agent-Task-Id: <同 X-Request-Id>
X-Interaction-Id: <uuid>                             (进程启动时生成一次)
Editor-Plugin-Version: copilot-chat/<COPILOT_CHAT_VERSION>
Editor-Version: vscode/<VSCODE_VERSION>
User-Agent: GitHubCopilotChat/<COPILOT_CHAT_VERSION>
```

`/responses` 按客户端区分（`session.ts` 的 `requestProduct()`：session header 或 UA
含 `grok-shell` / `xai-grok-build` 判定为 grok-build，其余按 Codex 处理）。

Codex 对齐 VS Code 内置 Responses 代理（见
[vscode-responses-proxy.md](vscode-responses-proxy.md)）：

```
OpenAI-Intent: responses-proxy
X-Interaction-Type: responses-proxy
User-Agent: vscode_codex/<入站 UA 第一个 / 之后的部分>   (入站有 UA 时)
```

grok-build 对齐 VS Code 原生 Chat 的 agent 请求（CAPI 上 grok 模型只支持 `/responses`）：

```
OpenAI-Intent: conversation-agent
X-Interaction-Type: conversation-agent
User-Agent: GitHubCopilotChat/<COPILOT_CHAT_VERSION>   (不改写入站 UA)
```

两者共用：

```
X-Initiator: user | agent       (input 末项为字符串或 role=user 的 message 时为 user)
Accept: <入站 Accept>
```

不发送 `Copilot-Integration-Id`。

### Session ID 映射

客户端的 session id 不直接发给 CAPI。`src/session.ts` 在内存中维护
`<产品前缀>:<客户端 session id>` → 上游 session id 的 map：

- 上游 id 按 VS Code `vscode.env.sessionId` 的格式生成：`<uuid><Date.now()>`。
- 同一客户端会话始终映射到同一个上游 id；首次映射时打印一行 `[proxy] session` 日志。
- 请求不带可识别的 session header 时，使用进程启动时生成的默认上游 id。
- map 最多保留 1000 条，按最近使用淘汰；进程重启后全部重新生成。

## 响应 Headers

转发上游的以下 headers，其余不转发：

- `Content-Type`
- `x-request-id`、`x-github-request-id`
- `retry-after`、`retry-after-ms`、`x-should-retry`
- `x-quota-snapshot-*`、`x-usage-ratelimit-*`
