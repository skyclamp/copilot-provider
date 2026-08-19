# copilot-provider

A small Bun/TypeScript proxy for GitHub Copilot CAPI.

It exposes three endpoints:

- `POST /v1/messages`
- `POST /v1/responses`
- `POST /v1/chat/completions`

Requests must contain a JSON object. The proxy adds the CAPI authentication and
device headers, forwards response bodies, and extracts usage from a tee'd
response stream.

```sh
bun run setup-device
bun run auth
bun run gen-keys
bun run start
```

See [docs/design.md](docs/design.md) for the request contract and
[.env.example](.env.example) for configuration.
