# GitHub Copilot `web_fetch` implementation

This note summarizes the concrete `web_fetch` implementation in the bundled `@github/copilot` package.

Unlike `web_search`, `web_fetch` is not an MCP tool and does not call a GitHub Copilot search backend. It is a local built-in tool that validates a URL, optionally asks the runtime permission service, directly calls the JavaScript runtime `fetch`, and returns either raw content or locally simplified markdown.

## Tool definition

Model-facing tool name:

```text
web_fetch
```

Tool registration shape:

```js
{
  name: "web_fetch",
  source: "builtin",
  title: "Fetching web content",
  description: "Fetches a URL from the internet and returns the page as either markdown or raw HTML. Use this to safely retrieve up-to-date information from HTML web pages.",
  input_schema: <schema>,
  callback: this.webFetch.bind(this),
  safeForTelemetry: true
}
```

The tool is only registered when `COPILOT_OFFLINE !== "true"`.

## Input schema

The local input schema is statically defined in the bundle:

```json
{
  "type": "object",
  "properties": {
    "url": {
      "type": "string",
      "description": "The URL to fetch"
    },
    "max_length": {
      "type": "number",
      "description": "Maximum number of characters to return (default: 5000, maximum: 20000)"
    },
    "start_index": {
      "type": "number",
      "description": "Start index for pagination. Use this to continue reading if content was truncated (default: 0)"
    },
    "raw": {
      "type": "boolean",
      "description": "If true, returns raw HTML. If false, converts to simplified markdown (default: false)"
    }
  },
  "required": ["url"]
}
```

Runtime defaults and limits:

```text
max_length default: 5000 characters
max_length maximum: 20000 characters
start_index default: 0
raw default: false
network read cap: 10 MiB
network timeout: 30 seconds
```

The schema checks that `max_length` and `start_index` are numbers, but it does not require integers or enforce lower bounds. The implementation only clamps `max_length` to the upper bound of 20000.

## High-level flow

1. Validate arguments with the local schema.
2. Trim `url` and clamp `max_length` with `Math.min(max_length ?? 5000, 20000)`.
3. Build telemetry metadata with a hashed URL, the raw flag, and `startIndex`.
4. Reject missing URLs.
5. Parse the URL with `new URL(...)`; reject invalid URLs.
6. Explicitly reject `file:` URLs and tell the model to use the file-reading tool instead.
7. If URL permissions are enabled, ask the permission service for `{ kind: "url", intention: "Fetch web content", url }`.
8. Fetch content via the local helper `uxn(url, raw ? "raw" : "markdown", 10 MiB, abortSignal)`.
9. Paginate the resulting string using `start_index` and `max_length`.
10. Return a tool result containing `Contents of <url>:` plus the selected slice.

## Network request behavior

The network helper uses the global/runtime `fetch`:

```js
fetch(url, {
  redirect: "follow",
  signal: AbortSignal.any([toolAbortSignal, AbortSignal.timeout(30000)]),
  headers: {
    Accept: mode === "markdown" ? "text/markdown, text/html, */*" : "text/html, */*"
  }
})
```

There are no authentication headers, cookies, or caller-provided custom headers. The built-in help text explicitly notes: no authentication headers supported.

The helper fails immediately for HTTP status codes `>= 400`:

```text
Failed to fetch <url> - status code <status>
```

The response body is read as a stream with a byte cap of 10 MiB. Once the cap is exceeded, the stream is cancelled and the partial decoded text is returned with a marker:

```xml
<truncated />
```

## Raw mode

When `raw: true`, the helper uses `Accept: text/html, */*` and returns the fetched text without markdown simplification.

It still follows redirects, enforces the 30 second timeout, enforces the 10 MiB read cap, and later paginates the returned string through `start_index` / `max_length`.

## Markdown mode

When `raw` is false or omitted, the helper prefers markdown content over HTML:

```http
Accept: text/markdown, text/html, */*
```

Content handling:

- If `Content-Type` includes `text/markdown` or `text/x-markdown`, return the response text as-is.
- If the body appears to be HTML, or `Content-Type` includes `text/html`, or no content type is present, simplify HTML to markdown locally.
- For other content types, return the raw text with a prefix explaining that the content type cannot be simplified.

The non-HTML fallback prefix is:

```text
Content type <content-type> cannot be simplified to markdown. Here is the raw content:
```

## HTML to markdown pipeline

HTML simplification is local and uses these bundled components:

- `linkedom` parser via `parseHTML`.
- Mozilla Readability to extract article content.
- Turndown to convert extracted HTML to markdown.

### Turndown config

The bundle creates a singleton Turndown service:

```js
function zss() {
  return WJt || (WJt = new TurndownService({
    headingStyle: "atx",
    codeBlockStyle: "fenced"
  })), WJt;
}
```

Only two options are overridden:

```json
{
  "headingStyle": "atx",
  "codeBlockStyle": "fenced"
}
```

Everything else uses Turndown defaults from the bundled library:

```json
{
  "hr": "* * *",
  "bulletListMarker": "*",
  "fence": "```",
  "emDelimiter": "_",
  "strongDelimiter": "**",
  "linkStyle": "inlined",
  "linkReferenceStyle": "full",
  "br": "  ",
  "preformattedCode": false
}
```

Practical effects:

- Headings are emitted as ATX headings such as `# Heading`, not setext underlines.
- Code blocks are emitted as fenced code blocks instead of indented code blocks.
- Fenced code language is inferred by Turndown from a child `<code>` class matching `language-(\S+)`.
- If code content itself contains triple backticks, Turndown increases the fence length to avoid breaking the block.
- Links are inline links, not reference-style links.
- No custom Turndown rules or plugins are added by `web_fetch`.

### Code-level control flow

The HTML conversion entrypoint is effectively:

```js
function simplifyHtmlToMarkdown(html, abortSignal) {
  const domParserErrors = {};

  abortSignal?.throwIfAborted();
  const firstDocument = parseHtml(html, abortSignal);
  if (typeof firstDocument === "string") {
    domParserErrors.linkedom = firstDocument;
    return {
      error: "Failed to parse HTML",
      domParserErrors
    };
  }

  abortSignal?.throwIfAborted();
  const firstMarkdown = readabilityToMarkdown(firstDocument);

  if (
    typeof firstMarkdown !== "string" ||
    html.length === 0 ||
    (firstMarkdown.length >= 200 && firstMarkdown.length / html.length >= 0.001)
  ) {
    return firstMarkdown;
  }

  abortSignal?.throwIfAborted();
  const secondDocument = parseHtml(html, abortSignal);
  if (typeof secondDocument === "string") return firstMarkdown;

  removeHiddenAttributes(secondDocument);
  const secondMarkdown = readabilityToMarkdown(secondDocument);

  if (typeof secondMarkdown !== "string") return firstMarkdown;
  return secondMarkdown.length > firstMarkdown.length ? secondMarkdown : firstMarkdown;
}
```

The real minified function names are:

```text
Kss(html, signal)       # simplifyHtmlToMarkdown
axn(html, signal)       # parseHtml
lxn(document)           # readabilityToMarkdown
Zss(document)           # removeHiddenAttributes
zss()                   # get singleton TurndownService
```

Pipeline details:

1. Parse HTML with `linkedom`.
2. Run `new Readability(document).parse()` with no custom Readability options.
3. If Readability returns article `content`, convert only that content with Turndown.
4. If Readability fails, return an error object rather than markdown.
5. If the first markdown output is suspiciously short, re-parse the original HTML, remove `[hidden]` attributes, run Readability again, and keep the longer markdown result.

The Readability conversion helper is effectively:

```js
function readabilityToMarkdown(document) {
  const article = new Readability(document).parse();
  return !article || !article.content
    ? {
        error: "Readability failed to extract article content",
        domParserErrors: {}
      }
    : getTurndownService().turndown(article.content);
}
```

The parser helper is effectively:

```js
function parseHtml(html, abortSignal) {
  try {
    abortSignal?.throwIfAborted();
    const { document } = parseHTML(html);
    return document;
  } catch (error) {
    if (error instanceof DOMException && error.name === "AbortError") throw error;
    return `linkedom parsing failed: ${String(error)}`;
  }
}
```

The `[hidden]` retry helper is intentionally narrow:

```js
function removeHiddenAttributes(document) {
  if (!document || typeof document.querySelectorAll !== "function") return;
  const hiddenElements = document.querySelectorAll("[hidden]");
  for (let index = 0; index < hiddenElements.length; index++) {
    hiddenElements[index].removeAttribute("hidden");
  }
}
```

The suspiciously-short heuristic is:

```text
markdown length < 200 characters
and markdown length / original HTML length < 0.001
```

Equivalently, the first pass is accepted when:

```text
markdown length >= 200 characters
and markdown length / original HTML length >= 0.001
```

If the first pass returns a non-string error object, that error object is returned immediately; the `[hidden]` retry only runs when the first pass produced a string that looked too short.

If parsing or Readability fails, `web_fetch` falls back to raw HTML and prefixes the result:

```text
Failed to simplify HTML to markdown. Here is the raw content:
```

The parsing failure is also recorded in restricted telemetry as `domParsingError`.

## Pagination and output format

After fetching and optional conversion, `web_fetch` paginates the returned string.

If `start_index >= content.length`, the model receives:

```xml
<error>No more content available.</error>
```

Otherwise it returns up to `max_length` characters. If more content remains, it appends:

```xml
<note>Content truncated. Call the fetch tool with a start_index of <nextStartIndex> to get more content.</note>
```

Successful tool result format:

```text
<optional prefix>Contents of <url>:
<returned content slice>
```

The success telemetry metrics include:

```text
originalContentLength
returnedContentLength
startIndex
```

## Error handling

Argument and URL errors return structured tool failures:

```text
URL is required
Invalid URL: "<input>"
The file:// protocol is not supported by web_fetch. Use the view tool to read local files instead.
```

Permission denial uses the runtime permission result. If denied by URL rules, the user-facing message is normalized to:

```text
Permission to access this URL was denied.
```

Fetch or parsing exceptions are caught and returned as:

```text
Failed to fetch <url>: <error>
```

The raw error message is stored in restricted telemetry as `errorMessage`.

## Security / privacy notes

- Only the `file:` protocol is explicitly rejected before calling `fetch`; other unsupported schemes fail through the runtime fetch path.
- No authentication headers are supported.
- The full URL is restricted telemetry; normal telemetry stores only a hash.
- URL permission policy is enforced outside the fetch helper through the session permission service and configured `allowedUrls` / `deniedUrls` rules.
- The tool is intended for HTML web pages and documentation-style content, not arbitrary authenticated APIs.

## Source map in the bundled file

Key locations in `/Users/wenkai/opt/node-tools/node_modules/@github/copilot/app.js`:

- Tool schema and callback: `bdt = "web_fetch"`, `dXt.getTool()`, `dXt.webFetch(...)`.
- Constants: `mfs = 10 * 1024 * 1024`, `ePn = 5000`, `tPn = 20000`.
- Network helper: `uxn(url, mode, byteLimit, abortSignal)`.
- HTML parser wrapper: `axn(...)`.
- HTML simplifier: `Kss(...)`.
- Readability + Turndown conversion: `lxn(...)` and `zss()`.
- Hidden attribute retry: `Zss(...)`.