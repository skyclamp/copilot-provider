# Claude `anthropic-beta` header support on Copilot CAPI

Probe target: GitHub Copilot's upstream `/v1/messages` (CAPI), called **directly**
by `support-matrix.ts` via `capi_tests/_lib/capi.ts`. No proxy involved, so the
proxy's `ANTHROPIC_BETA_PREFIX_WHITELIST` (`src/messages.ts`) does not affect
these results — this is CAPI's own beta gate.

| Field           | Value                                                                 |
|-----------------|-----------------------------------------------------------------------|
| Date probed     | 2026-06-08                                                            |
| Models          | `claude-opus-4.8`, `claude-opus-4.7`, `claude-opus-4.6`, `claude-sonnet-4.6`, `claude-haiku-4.5` |
| CAPI endpoint   | `https://api.enterprise.githubcopilot.com/v1/messages`                |
| Account         | GitHub Enterprise Copilot tenant                                      |
| Reproduce       | `bun run capi_tests/claude/beta-headers/support-matrix.ts [--model <id>] [--beta <name>] [--verbose]` |

Each cell is a minimal `max_tokens=1` "ping" carrying a single `anthropic-beta`
header. `ok` = HTTP 200 (header accepted), `no` = 4xx whose message references a
beta header (rejected at the gate). Rejections come back as
`unsupported beta header(s): <name>`.

Beta-header list sourced from the official Anthropic TS SDK `AnthropicBeta`
union, plus newer date-versions referenced elsewhere in this repo
(`computer-use-2025-11-24`, `code-execution-2026-01-20`,
`advanced-tool-use-2025-11-20`, `structured-outputs-2025-11-13`).

## Result

**The verdict is identical across all five models** — CAPI's beta allow-list is
model-independent for this set. 26 of 31 headers accepted, 5 rejected.

| `anthropic-beta`                           | Verdict     |
|--------------------------------------------|-------------|
| `message-batches-2024-09-24`               | accepted    |
| `prompt-caching-2024-07-31`                | accepted    |
| `computer-use-2024-10-22`                  | accepted    |
| `computer-use-2025-01-24`                  | accepted    |
| `computer-use-2025-11-24`                  | accepted    |
| `pdfs-2024-09-25`                          | accepted    |
| `token-counting-2024-11-01`                | accepted    |
| `token-efficient-tools-2025-02-19`         | accepted    |
| `output-128k-2025-02-19`                   | **rejected**|
| `files-api-2025-04-14`                     | **rejected**|
| `mcp-client-2025-04-04`                    | accepted    |
| `mcp-client-2025-11-20`                    | **rejected**|
| `dev-full-thinking-2025-05-14`             | accepted    |
| `interleaved-thinking-2025-05-14`          | accepted    |
| `fine-grained-tool-streaming-2025-05-14`   | accepted    |
| `code-execution-2025-05-22`                | accepted    |
| `code-execution-2026-01-20`                | accepted    |
| `extended-cache-ttl-2025-04-11`            | accepted    |
| `context-1m-2025-08-07`                    | accepted    |
| `context-management-2025-06-27`            | accepted    |
| `model-context-window-exceeded-2025-08-26` | accepted    |
| `skills-2025-10-02`                        | **rejected**|
| `fast-mode-2026-02-01`                     | accepted    |
| `output-300k-2026-03-24`                   | accepted    |
| `user-profiles-2026-03-24`                 | accepted    |
| `advisor-tool-2026-03-01`                  | **rejected**|
| `advanced-tool-use-2025-11-20`             | accepted    |
| `structured-outputs-2025-11-13`            | accepted    |
| `managed-agents-2026-04-01`                | accepted    |
| `cache-diagnosis-2026-04-07`               | accepted    |
| `thinking-token-count-2026-05-13`          | accepted    |

**Rejected (5):** `output-128k-2025-02-19`, `files-api-2025-04-14`,
`mcp-client-2025-11-20`, `skills-2025-10-02`, `advisor-tool-2026-03-01`.

Rejection example (400):

```json
{ "message": "unsupported beta header(s): files-api-2025-04-14" }
```

## Notes & caveats

- `ok` means CAPI **accepted the header at its beta gate**, not that the feature
  behind it works end-to-end. The body is a bare ping, so feature-level support
  (request-shape validation, tool execution, …) still needs the dedicated probes
  (see `../server-tools/` and `../structured-output/`). For example
  `code-execution-2026-01-20` is accepted as a header here but the
  `code_execution` *tool type* is still rejected for the model (see the
  server-tools matrix).
- Of the 5 rejected, three are endpoint-scoped or product-surfaced features that
  Copilot fronts differently: `files-api-*` (no Files API endpoint exposed),
  `mcp-client-2025-11-20` (only the older `2025-04-04` MCP beta is admitted;
  Copilot wires MCP via its own server), and `skills-2025-10-02`. The other two
  are output-window / advisor betas not enabled on this tenant.
- Results are uniform across the five probed models on this Enterprise tenant.
  Re-run when Copilot's gateway or model routing changes; use `--beta` to
  isolate a single header or `--model` to spot-check one model.
