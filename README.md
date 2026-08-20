# copilot-provider

A small Node.js/TypeScript proxy for GitHub Copilot CAPI, with no runtime dependencies.

It exposes three endpoints:

- `POST /v1/messages`
- `POST /v1/responses`
- `POST /v1/chat/completions`

Requests must contain a JSON object. The proxy adds the CAPI authentication and
device headers, forwards response bodies, and extracts usage from a tee'd
response stream.

```sh
npm install
npm run setup-device
npm run auth
npm run gen-keys
npm run build
npm start
```

See [docs/design.md](docs/design.md) for the request contract and
[.env.example](.env.example) for configuration.
