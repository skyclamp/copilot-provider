# copilot-provider

A small Bun/TypeScript proxy for GitHub Copilot CAPI.

It exposes these endpoints:

- `HEAD /`
- `HEAD /api/hello`
- `POST /v1/messages`
- `POST /responses`
- `POST /chat/completions`

Request bodies are passed through without being read or validated. The proxy
adds the CAPI authentication and device headers, and forwards response streams
directly.

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

- [`responses-proxy.ts`](standalone-proxies/responses-proxy.ts) serves `POST /responses`.
- [`chat-completions-proxy.ts`](standalone-proxies/chat-completions-proxy.ts) serves
  `POST /chat/completions`.

In the chosen proxy file, replace `VSCODE_MACHINE_ID` and
`EDITOR_DEVICE_ID` with your device values, then pass the GitHub token:

```sh
bun standalone-proxies/responses-proxy.ts --github-token "$GITHUB_TOKEN"
```

For GitHub Enterprise, add `--ghe-host ghe.example.com`. It also supports
`HEAD /` and `HEAD /api/hello`. The API version, VS Code version, and Copilot
plugin version are constants in each file. `PORT` remains optional.
