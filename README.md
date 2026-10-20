# copilot-provider

A small Bun/TypeScript proxy for GitHub Copilot CAPI.

It serves the Responses API for Codex (gpt models) and grok-build (grok
models), and exposes only these endpoints:

- `HEAD /`
- `POST /responses`

Request bodies are not validated. The proxy adds the CAPI authentication and
device headers, and forwards response streams directly, except that
`/responses` SSE output item IDs are kept stable per `output_index` throughout
each response, including its terminal output array.

```sh
bun run setup-device
bun run auth
bun run gen-keys
bun run start
```

See [docs/design.md](docs/design.md) for the request contract and
[.env.example](.env.example) for configuration.

## Standalone proxies

The dependency-free, single-file Bun proxies in
[`standalone-proxies/`](standalone-proxies/) do not read or validate the
caller's API key or request body. They only add the Copilot authentication and
device headers before forwarding the request:

- [`messages-responses-proxy.ts`](standalone-proxies/messages-responses-proxy.ts) serves
  `POST /v1/messages` and `POST /responses`, with the same Responses SSE output
  item ID normalization built into the single file.
- [`chat-completions-proxy.ts`](standalone-proxies/chat-completions-proxy.ts) serves
  `POST /chat/completions`.

In the chosen proxy file, replace `VSCODE_MACHINE_ID` and
`EDITOR_DEVICE_ID` with your device values, then pass the GitHub token:

```sh
bun standalone-proxies/messages-responses-proxy.ts --github-token "$GITHUB_TOKEN"
```

For GitHub Enterprise, add `--ghe-host ghe.example.com`. It also supports
`HEAD /` and `HEAD /api/hello`. The API version, VS Code version, and Copilot
plugin version are constants in each file. `PORT` remains optional.
