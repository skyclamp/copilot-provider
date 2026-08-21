# OpenAI server-tools support matrix on Copilot CAPI

Probe target: GitHub Copilot's upstream `/responses` (CAPI), called **directly**
by the scripts in this folder via `capi_tests/_lib/capi.ts`. No proxy involved.

| Field         | Value                                                   |
|---------------|---------------------------------------------------------|
| Date probed   | 2026-06-04                                              |
| Model id sent | `gpt-5.5`                                               |
| CAPI endpoint | `https://api.enterprise.githubcopilot.com/responses`    |
| Account       | GitHub Enterprise Copilot tenant                        |
| Reproduce     | `bun run capi_tests/openai/server-tools/support-matrix.ts [--verbose]` |

> Re-run the matrix script when Copilot, the upstream OpenAI-compatible
> gateway, or model routing changes. The `--tool <id>` flag isolates a single
> probe; `--model <model>` tests another OpenAI-family model; `--verbose`
> prints the upstream body preview.

## Matrix

| Tool `type`       | HTTP | Verdict     | Signal                                                                 |
|-------------------|------|-------------|------------------------------------------------------------------------|
| `web_search`      | 200  | supported   | `web_search_call` emitted; response status `incomplete`                |
| `mcp`             | 400  | unsupported | `unsupported_value`: "The requested tool mcp is not supported."        |
| `shell`           | 200  | supported   | `shell_call` and `shell_call_output` emitted; response `completed`     |
| `computer`        | 400  | unsupported | `unsupported_value`: "The requested tool computer is not supported."   |
| `image_generation`| 400  | unsupported | `unsupported_value`: "The requested tool image_generation is not supported." |
| `file_search`     | 400  | unsupported | `unsupported_value`: "The requested tool file_search is not supported." |
| `tool_search`     | 200  | supported   | `tool_search_call` and `tool_search_output` emitted; response `completed` |

**Summary:** 3 supported, 4 unsupported. On this CAPI route, `web_search`,
hosted `shell`, and hosted `tool_search` are accepted for `gpt-5.5`.
`mcp`, `computer`, `image_generation`, and `file_search` are rejected at request
validation time before the model can use them.

## Per-tool details

### `web_search` - supported

```json
{
  "tools": [{ "type": "web_search", "search_context_size": "low" }]
}
```

Response (200) emitted a `web_search_call`. The overall response status was
`incomplete`, which means CAPI accepted and invoked the hosted search tool but
the probe's small `max_output_tokens` budget was not enough for a final answer.
For support detection this is still a positive signal because the hosted output
item was present.

### `mcp` - unsupported

```json
{
  "tools": [
    {
      "type": "mcp",
      "server_label": "dmcp",
      "server_description": "A public dice-rolling MCP server used for CAPI probing.",
      "server_url": "https://dmcp-server.deno.dev/sse",
      "require_approval": "never"
    }
  ]
}
```

Upstream response (400):

```json
{
  "error": {
    "code": "unsupported_value",
    "type": "invalid_request_error",
    "message": "The requested tool mcp is not supported."
  }
}
```

### `shell` - supported

```json
{
  "tools": [{ "type": "shell", "environment": { "type": "container_auto" } }]
}
```

Response (200) emitted both `shell_call` and `shell_call_output`, and the
response status was `completed`. This indicates Copilot CAPI can provision and
run the hosted shell container for `gpt-5.5` through `/responses`.

### `computer` - unsupported

```json
{
  "tools": [{ "type": "computer" }]
}
```

Upstream response (400):

```json
{
  "error": {
    "code": "unsupported_value",
    "type": "invalid_request_error",
    "message": "The requested tool computer is not supported."
  }
}
```

### `image_generation` - unsupported

```json
{
  "tools": [{ "type": "image_generation", "size": "1024x1024", "quality": "low" }]
}
```

Upstream response (400):

```json
{
  "error": {
    "code": "unsupported_value",
    "type": "invalid_request_error",
    "message": "The requested tool image_generation is not supported."
  }
}
```

### `file_search` - unsupported

```json
{
  "tools": [
    {
      "type": "file_search",
      "vector_store_ids": ["vs_capi_probe_missing"],
      "max_num_results": 1
    }
  ],
  "include": ["file_search_call.results"]
}
```

Upstream response (400):

```json
{
  "error": {
    "code": "unsupported_value",
    "type": "invalid_request_error",
    "message": "The requested tool file_search is not supported."
  }
}
```

The rejection happens at tool validation time, not because the default probe
uses a placeholder vector store id. Supplying a real vector store id is not
expected to change support on this route unless CAPI enables the tool first.

### `tool_search` - supported

```json
{
  "tools": [
    {
      "type": "namespace",
      "name": "crm",
      "description": "CRM tools for customer lookup and order management.",
      "tools": [
        {
          "type": "function",
          "name": "list_open_orders",
          "description": "List open orders for a customer ID.",
          "defer_loading": true,
          "parameters": {
            "type": "object",
            "properties": { "customer_id": { "type": "string" } },
            "required": ["customer_id"],
            "additionalProperties": false
          }
        }
      ]
    },
    { "type": "tool_search" }
  ],
  "parallel_tool_calls": false
}
```

Response (200) emitted both `tool_search_call` and `tool_search_output`, and
the response status was `completed`. This confirms hosted tool search can load
deferred namespace tools through Copilot CAPI for `gpt-5.5`.
