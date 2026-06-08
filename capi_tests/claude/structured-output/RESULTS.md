# Claude structured-output support on Copilot CAPI

Probe target: GitHub Copilot's upstream `/v1/messages` (CAPI), called **directly**
by the scripts in this folder via `capi_tests/_lib/capi.ts`. No proxy involved.

| Field                | Value                                                   |
|----------------------|---------------------------------------------------------|
| Date probed          | 2026-06-08                                              |
| Models id sent       | `claude-opus-4.8`, `claude-opus-4.7`, `claude-opus-4.6` |
| CAPI endpoint        | `https://api.enterprise.githubcopilot.com/v1/messages`  |
| Account              | GitHub Enterprise Copilot tenant                        |
| Reproduce            | `bun run capi_tests/claude/structured-output/json-schema.ts [--stream] [--model <id>]` |

> Re-run when Copilot, the upstream Anthropic gateway, or the model variant
> routing changes.

## Verdict

| Model               | HTTP | Verdict         | Signal                                                                 |
|---------------------|------|-----------------|------------------------------------------------------------------------|
| `claude-opus-4.8`   | 200  | **supported**   | Text block is valid JSON matching the schema (non-stream + stream)     |
| `claude-opus-4.6`   | 200  | **supported**   | Text block is valid JSON matching the schema (non-stream + stream)     |
| `claude-opus-4.7`   | 400  | **unsupported** | `{"message":"output_config.format: Extra inputs are not permitted"}`   |

Also tested on a supported model (sub-field of `output_config.format`):

| Feature                                   | HTTP | Verdict     | Signal                                                                 |
|-------------------------------------------|------|-------------|------------------------------------------------------------------------|
| `output_config.format.name`               | 400  | rejected    | `invalid_request_error`: "output_config.format.name: Extra inputs are not permitted" |

**Summary:** CAPI's native `/v1/messages` supports Anthropic JSON structured
outputs (`output_config.format`) for **`claude-opus-4.8` and `claude-opus-4.6`**,
both non-streaming and streaming — the response is a single `text` block whose
contents parse as JSON and validate against the requested schema. **`claude-opus-4.7`
does NOT support it**: CAPI rejects the entire `output_config.format` parameter
with a root-level `{"message": ...}` envelope (distinct from the Anthropic
`{error:{type,message}}` shape returned by the supported backends), which means
4.7 is routed to a backend that does not accept the parameter at all.

This is a change from the situation the proxy was built for, where
structured-output requests had to be rewritten onto `/chat/completions` (see
`src/messages-structured-output.ts`). The rewrite is still required for the
models where native support is absent (e.g. `claude-opus-4.7`).

The one caveat on the supported backends: CAPI rejects a `name` field inside
`output_config.format` (`Extra inputs are not permitted`). Only `type` +
`schema` are accepted on the format object.

## Per-case details

### `output_config.format` (json_schema) — supported

Request body (non-streaming):

```json
{
  "model": "claude-opus-4.8",
  "max_tokens": 1024,
  "messages": [
    {
      "role": "user",
      "content": "Extract the key information from this email: John Smith (john@example.com) is interested in our Enterprise plan and wants to schedule a demo for next Tuesday at 2pm."
    }
  ],
  "output_config": {
    "format": {
      "type": "json_schema",
      "schema": {
        "type": "object",
        "properties": {
          "name": { "type": "string" },
          "email": { "type": "string" },
          "plan_interest": { "type": "string" },
          "demo_requested": { "type": "boolean" }
        },
        "required": ["name", "email", "plan_interest", "demo_requested"],
        "additionalProperties": false
      }
    }
  }
}
```

Response (200), single text block:

```json
{ "demo_requested": true, "email": "john@example.com", "name": "John Smith", "plan_interest": "Enterprise" }
```

`stop_reason=end_turn`, `model=claude-opus-4-8`. Streaming (`--stream`) emits
the normal `message_start` → `content_block_*` → `message_delta` → `message_stop`
sequence and the accumulated `text_delta` payloads form the same JSON object.

`claude-opus-4.6` behaves identically (200, schema-valid JSON, both modes).

### `claude-opus-4.7` — unsupported

Same body, only `model` changed to `claude-opus-4.7`. Upstream response (400),
both streaming and non-streaming:

```json
{ "message": "output_config.format: Extra inputs are not permitted" }
```

Note the **root-level `message`** envelope — distinct from the Anthropic
`{error:{type,message}}` shape the supported backends return. CAPI rejects the
whole `output_config.format` parameter here, so 4.7 is routed to a backend that
does not accept structured outputs at all. The proxy's `/chat/completions`
rewrite remains necessary for this model.

### `output_config.format.name` — rejected

Adding a `name` to the format object:

```json
{ "output_config": { "format": { "type": "json_schema", "name": "email_extraction", "schema": { "...": "..." } } } }
```

Upstream response (400):

```json
{
  "type": "error",
  "error": {
    "type": "invalid_request_error",
    "message": "output_config.format.name: Extra inputs are not permitted"
  }
}
```

## Caveats

- Results are specific to these Claude variants on this Enterprise Copilot
  tenant: `claude-opus-4.8` + `claude-opus-4.6` (supported), `claude-opus-4.7`
  (unsupported). Native support is per-backend, not monotonic across versions —
  use `--model <id>` to check any other variant.
- A `supported` verdict means CAPI accepted `output_config.format` *and*
  returned schema-valid JSON. The probe validates the response's required keys
  but does not exhaustively validate every JSON Schema constraint.
- The proxy in `src/messages-structured-output.ts` still rewrites
  structured-output requests onto `/chat/completions`. Given native support is
  now present, that workaround may no longer be necessary for this model.
