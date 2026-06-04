# capi_tests/

> **Scope.** Every script in this folder is a **probe against Copilot's
> upstream CAPI**, sent directly with `fetch`. These scripts are completely
> independent of the proxy in `src/`: they do their own GitHub-token →
> Copilot-token exchange in `_lib/capi.ts` and POST straight to
> `<copilot-api>/v1/messages`. The local proxy server does **not** need to be
> running for any of these probes, and proxy behaviour (model aliasing, beta
> header whitelist, structured-output rewriting, …) does not affect them.
>
> The goal of each probe is to learn how CAPI itself behaves for a given
> Anthropic-style feature (server tools, structured output, reasoning effort,
> …) on a given Copilot-served model.

Scripts are runnable directly with `bun run`. They are **not** `bun test`
unit tests — there is no assertion framework, just one-shot CAPI calls with
pretty-printed output.

## Layout

Grouped by model family, then by feature category:

```
capi_tests/
  _lib/
    capi.ts                  # token exchange + raw CAPI /v1/messages client
  claude/
    server-tools/
      web-search.ts          # Anthropic web_search server tool probe
      web-fetch.ts           # Anthropic web_fetch server tool probe
      support-matrix.ts      # batch probe across several Anthropic tool types
      RESULTS.md             # recorded findings from the matrix probe
```

Future siblings: other Claude features (structured output, vision, …) and
other families (`gpt/`, `gemini/`, …).

## Prerequisites

1. `.env` is populated with the same vars the proxy needs (`GITHUB_TOKEN`,
   `VSCODE_MACHINE_ID`, `EDITOR_DEVICE_ID`, optionally `COPILOT_CHAT_VERSION`
   / `VSCODE_VERSION` / `GITHUB_API_VERSION` / `GHE_HOST`). Bun auto-loads
   `.env`.
2. That's it — no proxy server, no input API key. The CAPI token is minted on
   the fly from the GitHub token.

## Exit-code semantics

- `0` — CAPI returned 2xx **and** the expected feature output is visible in
  the response (e.g. the tool was actually invoked, or the matrix probe
  finished collecting verdicts).
- non-zero — CAPI did not deliver the feature (4xx/5xx, transport error,
  unexpected response shape). The raw upstream payload is printed so you can
  diff it against the Anthropic-documented contract.

## Running a script

```sh
bun run capi_tests/claude/server-tools/web-search.ts             # non-streaming
bun run capi_tests/claude/server-tools/web-search.ts --stream    # SSE streaming

bun run capi_tests/claude/server-tools/web-fetch.ts
bun run capi_tests/claude/server-tools/web-fetch.ts --stream

bun run capi_tests/claude/server-tools/support-matrix.ts
bun run capi_tests/claude/server-tools/support-matrix.ts --tool code_execution_20260120
bun run capi_tests/claude/server-tools/support-matrix.ts --verbose
```

Each probe prints, in order, the resolved CAPI URL, the model + tool +
streaming mode, the upstream HTTP status + elapsed time, and a summary of
every Anthropic content block (text, `server_tool_use`,
`web_search_tool_result`, `web_fetch_tool_result`, errors, …) plus
`stop_reason` / `usage`. The matrix probe additionally renders a verdict
table at the end.

## Adding a new probe

1. Create a `.ts` file under the right family/category folder.
2. Import `callCapiMessages` from `capi_tests/_lib/capi.ts` and build the
   request body following the Anthropic docs (whose mirrors live in
   `docs/claude/`).
3. Send the appropriate `anthropic-beta` header via the `extraHeaders` option
   when the feature requires it — there is no whitelist to fight.
4. Parse the upstream response and print enough detail that re-running the
   probe makes upstream behaviour changes obvious in the diff.
