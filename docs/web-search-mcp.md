# GitHub Copilot `web_search` MCP wiring

This note summarizes how the bundled `@github/copilot` package exposes the model-facing `web_search` tool through the built-in GitHub MCP server.

The important boundary: the local package does not contain the implementation of web search, and it does not statically embed the final `web_search` tool `inputSchema`. The local client discovers that schema from the remote MCP server by calling `tools/list`, then forwards invocations through `tools/call`.

## Model-facing name vs MCP name

- Model-facing tool name: `web_search`
- Original discovered tool name: `github-mcp-server-web_search` at the Copilot tool layer
- Raw MCP tool name sent to the GitHub MCP server: `web_search`
- MCP server config key: `github-mcp-server`

The package hoists/renames the discovered GitHub MCP tool from `github-mcp-server-web_search` to `web_search` so the model sees a generic web search tool.

## Host / URL

### Normal CLI / VS Code authenticated path

The authenticated GitHub MCP config builder uses this URL shape:

```text
https://api.githubcopilot.com/mcp/readonly
```

If all GitHub MCP tools are explicitly enabled, or insiders mode is enabled, it uses:

```text
https://api.githubcopilot.com/mcp
```

The base can be overridden by the authenticated Copilot API endpoint:

1. `COPILOT_API_URL`, if set.
2. `authInfo.copilotUser.endpoints.api`, if available from Copilot auth info.
3. Default fallback: `https://api.githubcopilot.com`.

So the effective URL is:

```text
{copilotApiBase}/mcp/readonly   # default
{copilotApiBase}/mcp            # enableAllTools or insiders mode
```

The package also recognizes these GitHub MCP service roots as built-in GitHub MCP hosts:

```text
https://api.githubcopilot.com/mcp
https://api.enterprise.githubcopilot.com/mcp
```

### URL override helper path

Another built-in path constructs the URL with this priority:

1. `GITHUB_MCP_URL_OVERRIDE`, if set.
2. `new URL("/mcp", COPILOT_API_URL)`, if `COPILOT_API_URL` is set.
3. `https://api.githubcopilot.com/mcp`.

When readonly mode is requested, `/readonly` is appended unless already present:

```text
https://api.githubcopilot.com/mcp/readonly
```

## Headers

There are two relevant header sets in the bundle.

### Normal authenticated CLI / VS Code GitHub MCP headers

These are produced when the runtime configures the built-in GitHub MCP server after Copilot auth is available:

```http
Authorization: Bearer <token-from-Copilot-auth>
X-MCP-Host: copilot-cli
```

Optional headers:

```http
X-MCP-Insiders: true
X-MCP-Toolsets: all | <comma-separated additional toolsets>
X-MCP-Tools: <comma-separated allowed tool names>
```

Default readonly mode does not set `X-MCP-Toolsets` unless extra toolsets are configured. Instead it sets `X-MCP-Tools` to the allowed tool list.

Default allowed tools in readonly mode:

```text
get_file_contents,
search_code,
get_copilot_space,
list_copilot_spaces,
web_search,
search_users,
search_repositories,
list_branches,
list_commits,
get_commit,
issue_read,
list_issues,
search_issues,
pull_request_read,
list_pull_requests,
search_pull_requests,
actions_list,
actions_get,
get_job_logs,
list_workflow_runs,
get_workflow_run,
list_workflows,
get_workflow_run_logs,
get_workflow
```

If the workspace is detected as Azure DevOps-only and no broader GitHub MCP options are enabled, the built-in server is restricted to:

```http
X-MCP-Tools: web_search
```

### Coding-agent / env-token GitHub MCP headers

Another path configures the default remote GitHub MCP server using `GITHUB_PERSONAL_ACCESS_TOKEN`:

```http
Authorization: Bearer $GITHUB_PERSONAL_ACCESS_TOKEN
X-MCP-Toolsets: repos,issues,labels,users,pull_requests,discussions,code_security,secret_protection,actions,web_search
X-MCP-Host: github-coding-agent
X-Initiator: agent
```

Optional headers:

```http
Copilot-Integration-Id: <integration-id>
X-Interaction-Id: $GITHUB_COPILOT_INTERACTION_ID
```

If `COPILOT_MCP_COPILOT_SPACES_ENABLED=true`, `copilot_spaces` is appended to `X-MCP-Toolsets`.

For trigger jobs, the code additionally sets:

```http
X-MCP-Features: issues_granular,pull_requests_granular
X-MCP-Exclude-Tools: actions_run_trigger,assign_copilot_to_issue,request_copilot_review,label_write,create_pull_request,merge_pull_request,resolve_review_thread,update_pull_request,update_pull_request_branch,update_pull_request_draft_state,update_pull_request_state,create_branch,create_or_update_file,create_repository,delete_file,fork_repository,push_files,web_search
```

Note that this trigger-job exclusion list includes `web_search`.

### Transport-added HTTP headers

The streamable HTTP MCP transport adds/maintains protocol headers around the configured headers.

For JSON-RPC POST requests:

```http
content-type: application/json
accept: application/json, text/event-stream
mcp-protocol-version: <negotiated protocol version>   # after initialize
mcp-session-id: <server-returned session id>           # after server returns it
```

For optional SSE stream setup:

```http
Accept: text/event-stream
last-event-id: <resumption token>                      # only when resuming
mcp-protocol-version: <negotiated protocol version>
mcp-session-id: <server-returned session id>
```

If no `user-agent` header is already configured, the package injects one before creating the remote transport.

## Observed remote server

Using a Copilot token against `https://api.githubcopilot.com/mcp/readonly`, the MCP server initialized successfully with:

```json
{
  "name": "github-mcp-server",
  "title": "GitHub MCP Server",
  "version": "github-mcp-server/remote-3ae183d1ec75a2bc1ce714aca999ec13d237e771"
}
```

The same `tools/list` call returned exactly one allowed tool when the request included `X-MCP-Tools: web_search`.

## MCP request body schema

The transport is MCP over streamable HTTP using JSON-RPC 2.0. Requests are posted to the MCP URL above.

### Initialize request

The client first sends `initialize`:

```json
{
  "jsonrpc": "2.0",
  "id": 0,
  "method": "initialize",
  "params": {
    "protocolVersion": "2025-11-25",
    "capabilities": {
      "experimental": {},
      "sampling": {},
      "elicitation": {},
      "roots": {},
      "tasks": {},
      "extensions": {}
    },
    "clientInfo": {
      "name": "github-copilot-developer",
      "version": "<copilot-runtime-version>"
    }
  }
}
```

The actual `capabilities` object is feature-dependent; the schema accepts objects for supported capability blocks. The server response contains `protocolVersion`, `capabilities`, `serverInfo`, and optional `instructions`.

The client then sends the initialized notification:

```json
{
  "jsonrpc": "2.0",
  "method": "notifications/initialized",
  "params": {}
}
```

### Discovering the `web_search` input schema

The client discovers tools with:

```json
{
  "jsonrpc": "2.0",
  "id": 1,
  "method": "tools/list",
  "params": {}
}
```

The exact remote `web_search.inputSchema` is not present in the local package; it is returned by the remote GitHub MCP server through `tools/list`. The local package sanitizes `inputSchema` through `schemaSanitizeToolInputSchema` before exposing it as the model-facing `input_schema`.

Observed `web_search` tool metadata:

```json
{
  "name": "web_search",
  "annotations": {
    "openWorldHint": true,
    "readOnlyHint": true,
    "title": "Web Search"
  },
  "description": "This tool performs an AI-powered web search to provide intelligent, contextual answers with citations. Returns an AI-generated response with inline citations and a list of sources.",
  "inputSchema": {
    "type": "object",
    "properties": {
      "query": {
        "type": "string",
        "description": "A clear, specific question or prompt that requires up-to-date information from the web."
      }
    },
    "required": ["query"]
  }
}
```

The full remote description says to use this tool for recent or frequently updated information, new developments, niche/specific topics, explicit web-search requests, and current factual information with verifiable sources. It also says `query` should be a concise standalone natural-language prompt focused on one topic, not a raw keyword query.

### Calling `web_search`

The normal MCP call body is:

```json
{
  "jsonrpc": "2.0",
  "id": 2,
  "method": "tools/call",
  "params": {
    "name": "web_search",
    "arguments": {
      "query": "latest GitHub Copilot MCP web_search schema"
    }
  }
}
```

With progress and trace metadata, the package can send:

```json
{
  "jsonrpc": "2.0",
  "id": 2,
  "method": "tools/call",
  "params": {
    "name": "web_search",
    "arguments": {
      "query": "latest GitHub Copilot MCP web_search schema"
    },
    "_meta": {
      "progressToken": 2,
      "traceparent": "<w3c-traceparent>",
      "tracestate": "<w3c-tracestate>"
    }
  }
}
```

Generic `tools/call` parameter schema from the bundle:

```json
{
  "type": "object",
  "properties": {
    "name": { "type": "string" },
    "arguments": {
      "type": "object",
      "additionalProperties": true
    },
    "_meta": {
      "type": "object",
      "additionalProperties": true,
      "properties": {
        "progressToken": {
          "oneOf": [{ "type": "string" }, { "type": "integer" }]
        }
      }
    }
  },
  "required": ["name"]
}
```

## Response shape

The MCP `tools/call` result is the standard MCP call result:

```json
{
  "jsonrpc": "2.0",
  "id": 2,
  "result": {
    "content": [
      {
        "type": "text",
        "text": "..."
      }
    ],
    "structuredContent": {},
    "isError": false,
    "_meta": {}
  }
}
```

The bundle combines text content and optional `structuredContent` into the tool result passed back to the model. If `isError` is true, the runtime treats it as an MCP tool error.

## Source map in the bundled file

Key locations in `/Users/wenkai/opt/node-tools/node_modules/@github/copilot/app.js`:

- `web_fetch` is a builtin; `web_search` is not. `web_search` is hoisted from `github-mcp-server-web_search`.
- GitHub MCP server name: `github-mcp-server`.
- Default MCP URL constant: `https://api.githubcopilot.com/mcp`.
- URL helper: `F5e(readonly)` handles `GITHUB_MCP_URL_OVERRIDE`, `COPILOT_API_URL`, and `/readonly`.
- Authenticated GitHub MCP config builder: `rvt(token, authInfo, options, logger)`.
- Env-token GitHub MCP headers: `rao(...)`.
- Streamable HTTP MCP transport: `NM`, which sends JSON-RPC POST bodies and manages `mcp-session-id` / `mcp-protocol-version`.
- Tool discovery: `tools/list`, then `inputSchema` is sanitized with `schemaSanitizeToolInputSchema`.
- Tool invocation: `tools/call` with `{ name, arguments, _meta? }`.