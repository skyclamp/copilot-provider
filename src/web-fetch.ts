import { parseHTML } from 'linkedom';
import { Readability } from '@mozilla/readability';
import TurndownService from 'turndown';

const DEFAULT_MAX_LENGTH = 5000;
const MAX_LENGTH_CAP = 20_000;
const NETWORK_READ_CAP = 10 * 1024 * 1024;
const NETWORK_TIMEOUT_MS = 30_000;
const SHORT_OUTPUT_MIN_CHARS = 200;
const SHORT_OUTPUT_RATIO = 0.001;

export type WebFetchInput = {
  url: string;
  max_length?: number;
  start_index?: number;
  raw?: boolean;
};

export type WebFetchSuccess = {
  ok: true;
  url: string;
  content: string;
  originalLength: number;
  returnedLength: number;
  startIndex: number;
  nextStartIndex: number | null;
  contentType: string | null;
  prefix: string | null;
};

export type WebFetchFailure = {
  ok: false;
  error: string;
};

export type WebFetchResult = WebFetchSuccess | WebFetchFailure;

let turndownService: TurndownService | null = null;

function getTurndown(): TurndownService {
  if (!turndownService) {
    turndownService = new TurndownService({
      headingStyle: 'atx',
      codeBlockStyle: 'fenced',
    });
  }
  return turndownService;
}

function makeFetchSignal(external: AbortSignal | undefined): AbortSignal {
  const timeout = AbortSignal.timeout(NETWORK_TIMEOUT_MS);
  if (!external) return timeout;
  return AbortSignal.any([timeout, external]);
}

async function readBodyWithCap(body: ReadableStream<Uint8Array>): Promise<{ text: string; truncated: boolean }> {
  const decoder = new TextDecoder('utf-8');
  let text = '';
  let bytes = 0;
  let truncated = false;
  const reader = body.getReader();
  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      let chunk: Uint8Array = value;
      if (bytes + chunk.length > NETWORK_READ_CAP) {
        chunk = chunk.subarray(0, NETWORK_READ_CAP - bytes);
        truncated = true;
      }
      text += decoder.decode(chunk, { stream: !truncated });
      bytes += chunk.length;
      if (truncated) {
        try { await reader.cancel(); } catch {}
        break;
      }
    }
    if (!truncated) text += decoder.decode();
  } finally {
    try { reader.releaseLock(); } catch {}
  }
  return { text, truncated };
}

type ParseFailure = { error: string };

function isParseFailure(value: unknown): value is ParseFailure {
  return typeof value === 'object' && value !== null && 'error' in (value as Record<string, unknown>);
}

function parseHtmlSafe(html: string): any | ParseFailure {
  try {
    const { document } = parseHTML(html);
    return document;
  } catch (err) {
    return { error: `linkedom parsing failed: ${String(err)}` };
  }
}

function readabilityToMarkdown(document: any): string | ParseFailure {
  let article: { content?: string | null } | null;
  try {
    article = new Readability(document).parse() as any;
  } catch (err) {
    return { error: `Readability failed: ${String(err)}` };
  }
  if (!article || !article.content) {
    return { error: 'Readability failed to extract article content' };
  }
  try {
    return getTurndown().turndown(article.content);
  } catch (err) {
    return { error: `Turndown failed: ${String(err)}` };
  }
}

function removeHiddenAttributes(document: any): void {
  const els = document?.querySelectorAll?.('[hidden]');
  if (!els) return;
  for (let i = 0; i < els.length; i++) {
    els[i]?.removeAttribute?.('hidden');
  }
}

function simplifyHtmlToMarkdown(html: string): string | ParseFailure {
  if (!html) return '';
  const doc = parseHtmlSafe(html);
  if (isParseFailure(doc)) return doc;
  const first = readabilityToMarkdown(doc);
  if (isParseFailure(first)) return first;
  const acceptFirst =
    html.length === 0 ||
    (first.length >= SHORT_OUTPUT_MIN_CHARS && first.length / html.length >= SHORT_OUTPUT_RATIO);
  if (acceptFirst) return first;

  const doc2 = parseHtmlSafe(html);
  if (isParseFailure(doc2)) return first;
  removeHiddenAttributes(doc2);
  const second = readabilityToMarkdown(doc2);
  if (isParseFailure(second)) return first;
  return second.length > first.length ? second : first;
}

function looksLikeHtml(text: string): boolean {
  return text.trimStart().startsWith('<');
}

function paginate(
  content: string,
  startIndex: number,
  maxLength: number,
): { slice: string; nextStartIndex: number | null } {
  if (startIndex >= content.length) {
    return { slice: '', nextStartIndex: null };
  }
  const end = Math.min(content.length, startIndex + maxLength);
  return {
    slice: content.slice(startIndex, end),
    nextStartIndex: end < content.length ? end : null,
  };
}

export async function webFetch(input: WebFetchInput, signal?: AbortSignal): Promise<WebFetchResult> {
  const urlRaw = typeof input?.url === 'string' ? input.url.trim() : '';
  if (!urlRaw) return { ok: false, error: 'URL is required' };

  let parsedUrl: URL;
  try {
    parsedUrl = new URL(urlRaw);
  } catch {
    return { ok: false, error: `Invalid URL: "${urlRaw}"` };
  }

  if (parsedUrl.protocol === 'file:') {
    return {
      ok: false,
      error: 'The file:// protocol is not supported by web_fetch. Use the view tool to read local files instead.',
    };
  }

  const raw = input.raw === true;
  const maxLength = Math.min(
    typeof input.max_length === 'number' ? input.max_length : DEFAULT_MAX_LENGTH,
    MAX_LENGTH_CAP,
  );
  const startIndex = typeof input.start_index === 'number' ? input.start_index : 0;

  let response: Response;
  try {
    response = await fetch(parsedUrl, {
      redirect: 'follow',
      signal: makeFetchSignal(signal),
      headers: {
        Accept: raw ? 'text/html, */*' : 'text/markdown, text/html, */*',
      },
    });
  } catch (err) {
    return { ok: false, error: `Failed to fetch ${urlRaw}: ${String(err instanceof Error ? err.message : err)}` };
  }

  if (response.status >= 400) {
    try { await response.body?.cancel(); } catch {}
    return { ok: false, error: `Failed to fetch ${urlRaw} - status code ${response.status}` };
  }

  const contentType = response.headers.get('content-type');
  let bodyText: string;
  let truncated: boolean;
  try {
    if (!response.body) {
      bodyText = '';
      truncated = false;
    } else {
      const result = await readBodyWithCap(response.body);
      bodyText = result.text;
      truncated = result.truncated;
    }
  } catch (err) {
    return { ok: false, error: `Failed to fetch ${urlRaw}: ${String(err instanceof Error ? err.message : err)}` };
  }
  if (truncated) bodyText += '\n<truncated />';

  let processed: string;
  let prefix: string | null = null;
  const ctLower = (contentType || '').toLowerCase();

  if (raw) {
    processed = bodyText;
  } else if (ctLower.includes('text/markdown') || ctLower.includes('text/x-markdown')) {
    processed = bodyText;
  } else if (!contentType || ctLower.includes('text/html') || looksLikeHtml(bodyText)) {
    const simplified = simplifyHtmlToMarkdown(bodyText);
    if (typeof simplified === 'string') {
      processed = simplified;
    } else {
      prefix = 'Failed to simplify HTML to markdown. Here is the raw content:\n';
      processed = bodyText;
    }
  } else {
    prefix = `Content type ${contentType} cannot be simplified to markdown. Here is the raw content:\n`;
    processed = bodyText;
  }

  const { slice, nextStartIndex } = paginate(processed, startIndex, maxLength);

  return {
    ok: true,
    url: urlRaw,
    content: slice,
    originalLength: processed.length,
    returnedLength: slice.length,
    startIndex,
    nextStartIndex,
    contentType,
    prefix,
  };
}

export function webFetchToToolText(result: WebFetchResult): string {
  if (!result.ok) return result.error;
  if (result.startIndex >= result.originalLength) {
    return '<error>No more content available.</error>';
  }
  let out = '';
  if (result.prefix) out += result.prefix;
  out += `Contents of ${result.url}:\n${result.content}`;
  if (result.nextStartIndex !== null) {
    out += `\n<note>Content truncated. Call the fetch tool with a start_index of ${result.nextStartIndex} to get more content.</note>`;
  }
  return out;
}
