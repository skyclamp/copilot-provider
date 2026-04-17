# Copilot API Proxy — 透传代理设计

## 透传原则

三个端点的核心逻辑一致：**不校验、不改写 request body（仅做必要的 model 别名映射），response 原样透传**。

错误处理也是透传——上游返回什么状态码和 body，就原样转发给客户端。代理层只在自身故障时返回 502。

## 路由与上游路径映射

| 代理端点 | 上游路径 |
|----------|----------|
| `POST /v1/messages` | `{api}/v1/messages` |
| `POST /v1/responses` | `{api}/responses` |
| `POST /v1/embeddings` | `{api}/embeddings` |

`/v1/responses` 和 `/v1/embeddings` 的上游路径无 `/v1` 前缀。

其他所有请求 → 404。

## Model 别名

仅 `/v1/messages` 做 model 名称映射（`MODEL_ALIASES`），其余端点原样透传 model。

`/v1/messages` 会识别 `anthropic-beta` header 中的 `context-1m-2025-08-07`，对 `claude-opus-4-6` 自动替换为 `claude-opus-4.6-1m` 并从 header 中移除该 beta flag。

## 流式转发

当 `stream: true` 时，上游返回 `text/event-stream`。代理通过 `ReadableStream` 逐 chunk pipe 到 Express response，不 buffer 整个响应。

## 请求 Headers

每次代理请求组装以下 headers：

```
Authorization: Bearer <copilot_token>
Content-Type: application/json
User-Agent: GitHubCopilotChat/<COPILOT_CHAT_VERSION>
X-GitHub-Api-Version: <GITHUB_API_VERSION>
VScode-SessionId / VScode-MachineId / Editor-Device-Id
Copilot-Integration-Id: vscode-chat
OpenAI-Intent: conversation-agent
X-Interaction-Type: conversation
X-Request-Id: <uuid>
Editor-Plugin-Version: copilot-chat/<COPILOT_CHAT_VERSION>
Editor-Version: vscode/<VSCODE_VERSION>
```

响应时转发上游的 `x-request-id`、`x-github-request-id` 和 `Content-Type`。
