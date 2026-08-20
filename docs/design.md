# Copilot API Proxy — 透传代理设计

## 透传原则

三个端点仅接受 JSON object。Request body 保持语义不变，仅 `/v1/messages`
做必要的 model 别名映射。CAPI 默认返回 usage，代理不添加 usage 请求字段。

上游状态码和 response body 原样转发；代理自身故障返回 502。

## 路由与上游路径映射

| 代理端点 | 上游路径 |
|----------|----------|
| `POST /v1/messages` | `{api}/v1/messages` |
| `POST /v1/responses` | `{api}/responses` |
| `POST /v1/chat/completions` | `{api}/chat/completions` |

`/v1/responses` 和 `/v1/chat/completions` 的上游路径无 `/v1` 前缀。

其他所有请求 → 404。

## Model 别名

仅 `/v1/messages` 做 model 名称映射（`MODEL_ALIASES`），其余端点原样透传 model。

`/v1/messages` 将 `anthropic-beta` header 原值透传，不做白名单过滤；不向
CAPI 发送 `anthropic-version`。

## 流式转发

当 `stream: true` 时，上游返回 `text/event-stream`。代理 tee 上游
`ReadableStream`：一支直接返回客户端，另一支旁路解析 usage。

## 请求 Headers

每次代理请求组装以下 headers：

```
Authorization: Bearer <copilot_token>
Content-Type: application/json
X-GitHub-Api-Version: <GITHUB_API_VERSION>
VScode-SessionId / VScode-MachineId / Editor-Device-Id
X-Request-Id: <uuid>
Editor-Plugin-Version: copilot-chat/<COPILOT_CHAT_VERSION>
Editor-Version: vscode/<VSCODE_VERSION>
```

响应只保留客户端有用的 `x-request-id` 和 `Content-Type`；其他 CAPI 专用
response headers 不转发。
