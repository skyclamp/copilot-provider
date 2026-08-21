# Copilot API Proxy — 透传代理设计

## 透传原则

三个 POST 端点不读取、不校验或修改 Request body，直接透传至 CAPI。CAPI 默认
返回 usage，代理不添加 usage 请求字段。

上游状态码和 response body 原样转发；代理自身故障返回 502。

## 路由与上游路径映射

| 代理端点 | 上游路径 |
|----------|----------|
| `POST /v1/messages` | `{api}/v1/messages` |
| `POST /responses` | `{api}/responses` |
| `POST /chat/completions` | `{api}/chat/completions` |
| `HEAD /` | `200` |
| `HEAD /api/hello` | `200` |

`/responses` 和 `/chat/completions` 的上游路径无 `/v1` 前缀。

其他所有请求 → 404。

`/v1/messages` 将 `anthropic-beta` header 原值透传，不向 CAPI 发送
`anthropic-version`。

## 流式转发

当上游返回 `text/event-stream` 时，代理直接将上游 `ReadableStream` 返回客户端。

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
