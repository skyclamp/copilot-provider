# Copilot API Proxy — 设计指南

## 目标

提供一个轻量代理服务，将 Claude Messages API（`/v1/messages`）和 OpenAI Embeddings API（`/v1/embeddings`）请求转发到 GitHub Copilot API，封装整个 GitHub OAuth + Copilot Token 的认证流程。

## 架构概览

```
客户端 (Claude / OpenAI API 格式)
    │
    ▼
┌─────────────────────────────────┐
│  Express Server (Bun runtime)   │
│  POST /v1/messages              │
│    1. model 名称映射            │
│    2. 获取 Copilot Token        │
│    3. 透传 request → Copilot    │
│    4. 透传 response → 客户端    │
│  POST /v1/embeddings            │
│    1. 校验固定模型              │
│    2. 规范化 input 为 string[]  │
│    3. 转发到 Copilot /embeddings│
│    4. 补齐 OpenAI 风格响应字段   │
│  其他路由 → 404 + log           │
└─────────────────────────────────┘
    │
    ▼
GitHub Copilot API (https://api.githubcopilot.com)
```

## API 设计

### `POST /v1/messages`

透传 Claude Messages API 请求到 Copilot API。

**行为：**
1. 读取客户端请求 body
2. 如果 `model` 为 `claude-haiku-4-5-20251001`，替换为 `claude-haiku-4-5`
3. 组装 Copilot 所需的 headers（Authorization、User-Agent、各种 ID 等）
4. 将请求转发到 `https://api.githubcopilot.com/v1/messages`
5. 将 Copilot 的 response（包括 SSE 流）原样透传回客户端

**SSE 支持：**
- 当请求 body 中 `stream: true` 时，Copilot 返回 `text/event-stream`
- 代理需要逐 chunk 转发 response，不能等整个 response 完成再发
- 设置 `Content-Type: text/event-stream` 等相应 headers

**支持的 model 值：**
- `claude-opus-4-6`
- `claude-sonnet-4-6`
- `claude-haiku-4-5`
- `claude-haiku-4-5-20251001` → 自动映射为 `claude-haiku-4-5`

### `POST /v1/embeddings`

对外暴露 OpenAI 风格 embeddings 接口，对内转发到 Copilot 上游的 `/embeddings`。

**行为：**
1. `model` 必须是 `text-embedding-3-small`
2. `input` 支持单个非空字符串或非空字符串数组
3. 单字符串会被规范化成 `string[]`
4. 透传 `dimensions`
5. 只接受 `encoding_format: "float"`；其他值直接返回 400
6. 成功响应补齐稳定的 OpenAI 风格顶层字段：`object`、`data`、`model`

**约束：**
- 仅支持 `text-embedding-3-small`
- 不支持 token-array 形式的 `input`
- 不支持 `encoding_format: "base64"`
- 上游真实路径是 `{endpoints.api}/embeddings`，不是 `{endpoints.api}/v1/embeddings`

### 其他所有请求 → 404

任何非 `POST /v1/messages` / `POST /v1/embeddings` 的请求统一返回 404，同时在服务端打印日志：

```
[404] GET /v1/models
[404] POST /v1/chat/completions
```

## 认证与配置

### 数据文件总览

| 文件 | 内容 | 生命周期 | 产生方式 |
|------|------|----------|----------|
| `.token` | GitHub access_token（纯文本） | 长期有效，基本不变 | `bun run scripts/auth.ts` 一次性生成 |
| `.copilot` | Copilot token exchange 返回值（JSON） | 短时有效，自动刷新 | 服务运行时自动管理 |
| `.device` | Copilot API 请求所需的设备 headers（JSON） | 固定不变 | `bun run scripts/setup-device.ts` 一次性生成 |
| `.env` | 版本号等会变的配置 | 手动维护 | 手动编辑 |

### 第一步：GitHub OAuth — 独立脚本，只跑一次

运行 `bun run scripts/auth.ts`，执行 GitHub Device Flow：

1. 向 `https://github.com/login/device/code` 发起设备流
2. 终端打印验证 URL 和 user code，等待用户在浏览器中授权
3. 轮询 `https://github.com/login/oauth/access_token` 获取 `access_token`
4. 将 access_token 写入 `.token` 文件（纯文本，权限 0o600）

GitHub token 有效期基本无限长，授权一次即可，后续不需要再跑。

**配置常量：**
- `client_id`: `Iv1.b507a08c87ecfe98`
- `scope`: `read:user`

### 第二步：设备信息 — 独立脚本，只跑一次

运行 `bun run scripts/setup-device.ts`，生成 `.device` 文件：

```json
{
  "vscodeSessionId": "<uuid>",
  "vscodeMachineId": "<uuid>",
  "editorDeviceId": "<uuid>"
}
```

这些 ID 是 Copilot API headers 所需的设备标识，生成后固定不变。

### 第三步：Copilot Token — 服务自动管理

Copilot token 是短时 token，由服务在运行时自动获取和刷新。

**获取流程：**
1. 从 `.token` 读取 GitHub access_token
2. 调用 `GET https://api.github.com/copilot_internal/v2/token`
3. 返回值写入 `.copilot` 文件（JSON），同时缓存到内存

**`.copilot` 文件结构：**
```json
{
  "endpoints": {
    "api": "https://api.enterprise.githubcopilot.com",
    "proxy": "https://proxy.enterprise.githubcopilot.com"
  },
  "expires_at": 1775114915,
  "token": "tid=...;exp=...;..."
}
```

**缓存策略：**
- 内存中缓存完整的 token exchange 返回值
- 每次请求前检查 `expires_at`，距过期 < 60s 则重新获取
- 获取后同时更新内存缓存和 `.copilot` 文件
- 进程重启时从 `.copilot` 文件恢复缓存（检查 expires_at 是否仍有效）

**关键：`endpoints.api` 是 Copilot API 的实际 host**，请求目标 URL 从这里取，不硬编码。

### `.env` 配置

存放会变化的版本号：

```env
COPILOT_CHAT_VERSION=0.41.2
VSCODE_VERSION=1.113.0
GITHUB_API_VERSION=2025-10-01
PORT=4141
```

Bun 自动加载 `.env`，无需 dotenv。

### Copilot API 请求 Headers

```
Authorization: Bearer <copilot_token>           # 来自 .copilot → token
Content-Type: application/json
User-Agent: GitHubCopilotChat/<COPILOT_CHAT_VERSION>   # 来自 .env
X-GitHub-Api-Version: <GITHUB_API_VERSION>            # 来自 .env
VScode-SessionId: <vscodeSessionId>             # 来自 .device
VScode-MachineId: <vscodeMachineId>             # 来自 .device
Editor-Device-Id: <editorDeviceId>              # 来自 .device
Copilot-Integration-Id: vscode-chat
OpenAI-Intent: conversation-agent
X-Interaction-Type: conversation
X-Request-Id: <uuid>                            # 每次请求新生成
Editor-Plugin-Version: copilot-chat/<COPILOT_CHAT_VERSION>
Editor-Version: vscode/<VSCODE_VERSION>
```

## 文件结构

```
copilot-provider/
├── index.ts                    # 入口：启动 Express 服务
├── scripts/
│   ├── auth.ts                 # GitHub Device Flow OAuth → .token
│   └── setup-device.ts         # 生成 .device（设备 ID）
├── src/
│   ├── server.ts               # Express app 定义 + 路由
│   ├── proxy.ts                # /v1/messages 与 /v1/embeddings 代理逻辑
│   ├── copilot-token.ts        # Copilot Token 获取 + 缓存 + 刷新
│   └── constants.ts            # URL、默认值等常量
├── .token                      # GitHub access_token（git ignored）
├── .copilot                    # Copilot token exchange 返回值（git ignored）
├── .device                     # 设备 headers（git ignored）
├── .env                        # 版本号等配置（git ignored）
├── docs/
│   └── design.md               # 本文档
├── package.json
└── tsconfig.json
```

## 技术决策

| 决策 | 选择 | 理由 |
|------|------|------|
| Runtime | Bun | 项目要求 |
| HTTP 框架 | Express 5 | 项目已引入，满足需求 |
| HTTP 客户端 | 原生 fetch | Bun 内置，无需额外依赖 |
| Token 存储 | 文件 + 内存双层缓存 | 进程重启不丢失，运行时高效 |
| 流式转发 | response.body（ReadableStream）pipe 到 Express res | 原生支持，无需 buffer 整个响应 |

## 运行方式

```bash
# 1. 首次使用：GitHub 授权（只需一次）
bun run scripts/auth.ts

# 2. 首次使用：生成设备信息（只需一次）
bun run scripts/setup-device.ts

# 3. 配置版本号（手动编辑 .env）
echo "COPILOT_CHAT_VERSION=0.41.2\nVSCODE_VERSION=1.113.0\nGITHUB_API_VERSION=2025-10-01\nPORT=4141" > .env

# 4. 启动服务（Copilot token 自动获取和刷新）
bun run index.ts
# 5. 测试
curl -X POST http://localhost:4141/v1/messages \
  -H "Content-Type: application/json" \
  -d '{"model":"claude-sonnet-4-6","max_tokens":1024,"messages":[{"role":"user","content":"hi"}]}'

curl -X POST http://localhost:4141/v1/embeddings \
  -H "Content-Type: application/json" \
  -d '{"model":"text-embedding-3-small","input":"The quick brown fox jumped over the lazy dog"}'
```

## 不做的事情

- **不做** 客户端认证/鉴权（这是本地工具，不暴露到公网）
- **不做** `/v1/messages` 的请求体校验（透传即可，错误由 Copilot API 返回）
- **不做** 除 `/v1/embeddings` 兼容层之外的 response body 修改
- **不做** 多用户支持（单用户本地使用）
- **不做** view engine / 静态文件 / cookie 等 web 功能
