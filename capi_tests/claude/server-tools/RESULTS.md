# Claude server-tools support matrix on Copilot CAPI

Probe target: GitHub Copilot's upstream `/v1/messages` (CAPI), called **directly**
by the scripts in this folder via `capi_tests/_lib/capi.ts`. No proxy involved.

| Field                | Value                                                   |
|----------------------|---------------------------------------------------------|
| Date probed          | 2026-06-04                                              |
| Model id sent        | `claude-opus-4.7`                                       |
| CAPI endpoint        | `https://api.enterprise.githubcopilot.com/v1/messages`  |
| Account              | GitHub Enterprise Copilot tenant                        |
| Reproduce            | `bun run capi_tests/claude/server-tools/support-matrix.ts [--verbose]` |

> Re-run the matrix script when Copilot, the upstream Anthropic gateway, or
> the model variant routing changes. The `--tool <id>` flag isolates a single
> probe; `--verbose` prints the full upstream body.

## Matrix

| Tool `type`               | Tool `name`                    | `anthropic-beta` sent           | HTTP | Verdict     | Signal                                                                 |
|---------------------------|--------------------------------|---------------------------------|------|-------------|------------------------------------------------------------------------|
| `web_search_20260209`     | `web_search`                   | (none)                          | 400  | unsupported | `unsupported_value`: "The use of the web search tool is not supported."|
| `web_fetch_20260209`      | `web_fetch`                    | (none)                          | 400  | unsupported | `invalid_request_body`: "rejected tool(s): web_fetch"                  |
| `code_execution_20260120` | `code_execution`               | `code-execution-2026-01-20`     | 400  | unsupported | Anthropic validator: `type` not in accepted list (see below)           |
| `advisor_20260301`        | `advisor`                      | `advisor-2026-03-01`            | 400  | unsupported | "tool type 'advisor_20260301' is not supported for this model"         |
| `memory_20250818`         | `memory`                       | `context-management-2025-06-27` | 200  | supported   | `tool_use(name=memory)` emitted                                        |
| `bash_20250124`           | `bash`                         | `computer-use-2025-11-24`       | 200  | supported   | `tool_use(name=bash)` emitted                                          |
| `computer_20251124`       | `computer`                     | `computer-use-2025-11-24`       | 200  | supported   | `tool_use(name=computer)` emitted                                      |
| `text_editor_20250728`    | `str_replace_based_edit_tool`  | `computer-use-2025-11-24`       | 200  | supported   | `tool_use(name=str_replace_based_edit_tool)` emitted                   |

**Summary:** 4 supported, 4 unsupported. The supported four are all
client-executed tools — Copilot's CAPI emits a normal `tool_use` block and
expects the client to run the tool and return a `tool_result` on the next
turn. None of the Anthropic *server* tools (`web_search_*`, `web_fetch_*`,
`code_execution_*`) are honoured by Copilot CAPI for this model.

## Per-tool details

### `web_search_20260209` — unsupported

```json
{
  "tools": [{ "type": "web_search_20260209", "name": "web_search", "max_uses": 3 }]
}
```

Upstream response (400):

```json
{ "error": { "message": "The use of the web search tool is not supported.", "code": "unsupported_value" } }
```

Background: in Copilot's product surface, `web_search` is exposed via the
GitHub MCP server (`https://api.githubcopilot.com/mcp/readonly`) rather than
as an Anthropic server tool. See `docs/web-search-mcp.md` for the MCP wiring.

### `web_fetch_20260209` — unsupported

```json
{
  "tools": [{ "type": "web_fetch_20260209", "name": "web_fetch", "max_uses": 1 }]
}
```

Upstream response (400):

```json
{ "error": { "message": "rejected tool(s): web_fetch", "code": "invalid_request_body" } }
```

Background: Copilot has its own client-side built-in `web_fetch` (see
`docs/web-fetch-implementation.md`), so CAPI explicitly blocks attempts to
redefine the same tool name as a versioned Anthropic server tool. Note the
contract differs from `web_search`: this is a tool-name rejection
(`invalid_request_body`), not an unsupported server-tool type
(`unsupported_value`).

### `code_execution_20260120` — unsupported

```json
{
  "tools": [{ "type": "code_execution_20260120", "name": "code_execution" }]
}
```

Headers: `anthropic-beta: code-execution-2026-01-20`.

Upstream response (400) is forwarded straight from the Anthropic gateway and
includes the **full list of tool types this backend accepts**:

```json
{
  "type": "error",
  "error": {
    "type": "invalid_request_error",
    "message": "tools.0: Input tag 'code_execution_20260120' found using 'type' does not match any of the expected tags: 'bash_20250124', 'custom', 'memory_20250818', 'text_editor_20250124', 'text_editor_20250429', 'text_editor_20250728', 'tool_search_tool_bm25', 'tool_search_tool_bm25_20251119', 'tool_search_tool_regex', 'tool_search_tool_regex_20251119', 'web_search_20250305'"
  },
  "request_id": "req_vrtx_..."
}
```

Notes:
- Beta-header probing for this tool: `code-execution-2025-08-25` is rejected
  outright by Copilot (`unsupported beta header(s)`); `code-execution-2026-01-20`
  is accepted as a beta but the tool `type` is still not supported.
- Older versions (`code_execution_20250522` / `_20250825`) are also absent
  from the accepted list above, so Copilot does not currently honour any
  variant of the Anthropic code-execution server tool through this gateway.
- The accepted-types list above is what one CAPI backend (Vertex-routed,
  `request_id` prefix `req_vrtx_`) admits. `computer_20251124` is missing
  from this list yet successfully runs in the matrix, which means Copilot
  routes some `computer-use` beta requests through a different backend.

### `advisor_20260301` — unsupported

```json
{
  "tools": [{ "type": "advisor_20260301", "name": "advisor" }]
}
```

Tried with and without `anthropic-beta: advisor-2026-03-01`. Both responses
(400):

```json
{ "message": "tool type 'advisor_20260301' is not supported for this model" }
```

Note the root-level `message` field — this error shape is distinct from the
Anthropic `{error: {type, message}}` envelope and from the Copilot
`{error: {code, message}}` envelope. Anthropic does not publicly document an
`advisor_*` tool, so the beta-header value here is a best-effort guess.

### `memory_20250818` — supported

```json
{
  "tools": [{ "type": "memory_20250818", "name": "memory" }]
}
```

Headers: `anthropic-beta: context-management-2025-06-27`.

Response (200) emits a `tool_use` block:

```json
{
  "content": [
    { "type": "text", "text": "I'll check my memory directory first, then store your favourite colour." },
    { "type": "tool_use", "id": "toolu_bdrk_...", "name": "memory", "input": { "command": "view", "path": "/memories" } }
  ],
  "context_management": { "applied_edits": [] }
}
```

The `bdrk_` id prefix indicates this request was routed through Bedrock. The
`memory` tool name and its input vocabulary (`command: view`, `path: /memories`)
match Anthropic's spec.

### `bash_20250124` — supported

```json
{
  "tools": [{ "type": "bash_20250124", "name": "bash" }]
}
```

Headers: `anthropic-beta: computer-use-2025-11-24`.

Response (200):

```json
{
  "content": [
    { "type": "text", "text": "I'll run the command for you." },
    { "type": "tool_use", "id": "toolu_vrtx_...", "name": "bash", "input": { "command": "echo hello" } }
  ]
}
```

Vertex-routed (`toolu_vrtx_`). The client is expected to execute the
command and return a `tool_result` on the next turn.

### `computer_20251124` — supported

```json
{
  "tools": [
    {
      "type": "computer_20251124",
      "name": "computer",
      "display_width_px": 1024,
      "display_height_px": 768,
      "display_number": 1
    }
  ]
}
```

Headers: `anthropic-beta: computer-use-2025-11-24`.

Response (200):

```json
{
  "content": [
    { "type": "text", "text": "I'll take a screenshot for you." },
    { "type": "tool_use", "id": "toolu_vrtx_...", "name": "computer", "input": { "action": "screenshot" } }
  ]
}
```

Vertex-routed. Note `computer_20251124` is **not** in the Anthropic
validator's accepted-types list returned by the `code_execution_20260120`
probe, which means Copilot has its own admit-list for the `computer-use`
beta and routes those requests to a different backend.

### `text_editor_20250728` — supported

```json
{
  "tools": [{ "type": "text_editor_20250728", "name": "str_replace_based_edit_tool" }]
}
```

Headers: `anthropic-beta: computer-use-2025-11-24`.

Response (200):

```json
{
  "content": [
    {
      "type": "tool_use",
      "id": "toolu_vrtx_...",
      "name": "str_replace_based_edit_tool",
      "input": { "command": "create", "file_text": "hello", "path": "/foo.txt" }
    }
  ]
}
```

Vertex-routed. The model directly proposes the `create` editor command on
the first turn, with no preceding text block.

## Reproducing

```sh
# All eight at once:
bun run capi_tests/claude/server-tools/support-matrix.ts

# Single tool with the raw upstream body:
bun run capi_tests/claude/server-tools/support-matrix.ts \
  --tool code_execution_20260120 --verbose

# The per-tool probes for web_search / web_fetch with content-block summaries:
bun run capi_tests/claude/server-tools/web-search.ts
bun run capi_tests/claude/server-tools/web-fetch.ts
```

## Caveats

- Results are specific to **`claude-opus-4.7`** on this Enterprise Copilot
  tenant. Other Claude variants (`claude-opus-4.6`, `claude-sonnet-4.6`, the
  `-1m-internal` / `-high` / `-xhigh` sub-models) may have different admit
  lists.
- The `anthropic-beta` header values were chosen to match Anthropic's public
  docs at the time of probing. Copilot validates the beta name against its
  own admit list before forwarding; `code-execution-2025-08-25` is one
  example of a documented Anthropic beta that Copilot rejects outright.
- A `supported` verdict means CAPI accepted the tool declaration *and* the
  model emitted a `tool_use` for it. It does not verify end-to-end execution:
  the client-side tools (`bash`, `computer`, `text_editor`) still need the
  caller to run the tool and return a `tool_result`, and the server-side
  tools (none in the supported set here) would need a follow-up turn to
  exercise the actual result handling.
