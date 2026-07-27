import { isRecord } from './proxy.ts';

// Claude Code discovers gateway models with `GET /v1/models?limit=1000`
// (https://code.claude.com/docs/en/llm-gateway-protocol.md#model-discovery).
// It reads `id` and the optional `display_name` from each `data` entry and
// drops ids that do not start with `claude` / `anthropic`.
export const CLAUDE_MODELS_CACHE_TTL_MS = 4 * 60 * 60 * 1000;
const CLAUDE_MODELS_MAX_LIMIT = 1000;
const CLAUDE_MESSAGES_ENDPOINT = '/v1/messages';
const FAMILY_RANKS = ['opus', 'sonnet', 'haiku'] as const;
const MODELS_FILE = new URL('../models.json', import.meta.url);

let cachedModels: ClaudeModelInfo[] | null = null;

export type ClaudeModelInfo = {
  type: 'model';
  id: string;
  display_name: string;
};

export type ClaudeModelsResponse = {
  data: ClaudeModelInfo[];
  has_more: boolean;
  first_id: string | null;
  last_id: string | null;
};

function stringValue(value: unknown): string | null {
  return typeof value === 'string' && value.length > 0 ? value : null;
}

function familyRank(id: string): number {
  const index = FAMILY_RANKS.findIndex(family => id.includes(`-${family}`));
  return index === -1 ? FAMILY_RANKS.length : index;
}

function versionRank(id: string): number {
  const match = id.match(/-(\d+(?:\.\d+)?)(?:-|$)/);
  return match ? Number(match[1]) : 0;
}

function toClaudeModelInfo(value: unknown): ClaudeModelInfo | null {
  if (!isRecord(value) || value.model_picker_enabled !== true) return null;

  const id = stringValue(value.id);
  if (!id || !id.startsWith('claude')) return null;

  const endpoints = Array.isArray(value.supported_endpoints) ? value.supported_endpoints : [];
  if (!endpoints.includes(CLAUDE_MESSAGES_ENDPOINT)) return null;

  const policy = isRecord(value.policy) ? value.policy : null;
  if (policy && typeof policy.state === 'string' && policy.state !== 'enabled') return null;

  return { type: 'model', id, display_name: stringValue(value.name) || id };
}

/** Maps a CAPI `/models` payload to the Anthropic model-listing schema. */
export function toClaudeModelsResponse(payload: unknown, limit?: number): ClaudeModelsResponse {
  const entries = isRecord(payload) && Array.isArray(payload.data) ? payload.data : [];
  const models = entries
    .map(toClaudeModelInfo)
    .filter((model): model is ClaudeModelInfo => model !== null);

  models.sort((left, right) => {
    const byFamily = familyRank(left.id) - familyRank(right.id);
    if (byFamily !== 0) return byFamily;
    const byVersion = versionRank(right.id) - versionRank(left.id);
    if (byVersion !== 0) return byVersion;
    return left.id.localeCompare(right.id);
  });

  return page(models, limit);
}

function page(models: ClaudeModelInfo[], limit?: number): ClaudeModelsResponse {
  const capped = limit === undefined ? models : models.slice(0, limit);

  return {
    data: capped,
    has_more: capped.length < models.length,
    first_id: capped[0]?.id ?? null,
    last_id: capped[capped.length - 1]?.id ?? null,
  };
}

/**
 * Reads the Claude catalogue from the repository's `models.json` dump
 * (`bun run fetch-models`). The file is gitignored, so a missing or invalid
 * dump degrades to an empty catalogue instead of breaking the proxy.
 */
export async function loadClaudeModels(): Promise<ClaudeModelInfo[]> {
  if (!cachedModels) {
    let payload: unknown = null;
    try {
      payload = await Bun.file(MODELS_FILE).json();
    } catch (error) {
      console.error('[proxy] claude models catalog unavailable:', error);
    }
    cachedModels = toClaudeModelsResponse(payload).data;
  }
  return cachedModels;
}

function parseLimit(url: URL): number | undefined {
  const raw = url.searchParams.get('limit');
  if (raw === null) return undefined;
  const parsed = Number(raw);
  if (!Number.isSafeInteger(parsed) || parsed < 1) return undefined;
  return Math.min(parsed, CLAUDE_MODELS_MAX_LIMIT);
}

/**
 * Detects Claude Code from request headers.
 *
 * Model discovery (`GET /v1/models?limit=1000`) always sends
 * `User-Agent: claude-code/<version>` and `anthropic-version: 2023-06-01`,
 * with the credential in `Authorization: Bearer` (ANTHROPIC_AUTH_TOKEN) or in
 * `x-api-key`. Inference traffic instead carries `User-Agent: claude-cli/*`,
 * `x-app: cli` and `x-claude-code-*` headers. Codex CLI sends none of these —
 * it authenticates with `Authorization: Bearer` and a `codex_cli_rs/*` agent.
 */
export function isClaudeCodeRequest(req: Request): boolean {
  const headers = req.headers;

  const userAgent = (headers.get('user-agent') || '').toLowerCase();
  if (userAgent.includes('claude-cli') || userAgent.includes('claude-code')) return true;

  if ((headers.get('x-app') || '').toLowerCase() === 'cli') return true;

  for (const name of headers.keys()) {
    if (name.startsWith('x-claude-code-') || name.startsWith('anthropic-')) return true;
  }

  return headers.has('x-api-key') && !headers.has('authorization');
}

/** Claude Code model discovery: Claude-only catalogue sourced from models.json. */
export async function listClaudeCodeModels(req: Request): Promise<Response> {
  const models = await loadClaudeModels();
  return Response.json(page(models, parseLimit(new URL(req.url))), {
    headers: {
      'Cache-Control': `private, max-age=${Math.floor(CLAUDE_MODELS_CACHE_TTL_MS / 1000)}`,
    },
  });
}
