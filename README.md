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
