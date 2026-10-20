# copilot-provider

A small Node.js/TypeScript proxy for GitHub Copilot CAPI.

It serves the Responses API for Codex (gpt models) and grok-build (grok
models), and exposes only these endpoints:

- `HEAD /`
- `POST /responses`

Request bodies are not validated. The proxy adds the CAPI authentication and
device headers, and forwards response streams directly, except that
`/responses` SSE output item IDs are kept stable per `output_index` throughout
each response, including its terminal output array.

Requires Node.js >= 24.

```sh
npm install
npm run build          # tsc → dist/
npm run setup-device   # prints VSCODE_MACHINE_ID / EDITOR_DEVICE_ID for .env
npm run auth           # GitHub device flow → prints CAPI_TOKEN for .env
npm run gen-keys       # writes client API keys to keys.json
npm start              # node dist/index.js on $PORT (default 4141)
```

The CAPI token and GitHub Enterprise host can come from the environment
(`CAPI_TOKEN`, `CAPI_GHE_HOST`) or from command-line arguments, which take
precedence. They are deliberately not `GITHUB_TOKEN` / `GH_TOKEN`, which other
tools pick up as a general-purpose GitHub PAT:

```sh
node --env-file-if-exists=.env dist/index.js --capi-token "$TOKEN" --capi-ghe-host ghe.example.com --port 4141
```

See [docs/design.md](docs/design.md) for the request contract and
[.env.example](.env.example) for configuration.
