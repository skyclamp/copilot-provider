import { buildResponseHeaders, getProxyContext, isRecord } from './proxy.ts';

export const MODELS_CACHE_TTL_MS = 4 * 60 * 60 * 1000;
export const MODELS_FETCH_TIMEOUT_MS = 4_000;

const MODELS_API_VERSION = Bun.env.MODELS_API_VERSION || '2026-06-01';
const CODEX_BASE_INSTRUCTIONS =
  'You are Codex, a coding agent. Work with the user in the current workspace to complete software engineering tasks. Follow the instructions provided by the client, use tools when helpful, make precise changes, and continue until the task is complete.';
const MODEL_WHITELIST = [
  'gpt-5.6-sol',
  'gpt-5.6-terra',
  'gpt-5.6-luna',
  'gpt-5.5',
  'gpt-5.4',
  'gpt-5.4-mini',
  'gpt-5.3-codex',
] as const;

type CodexReasoningEffortPreset = {
  effort: string;
  description: string;
};

export type CodexModelInfo = {
  slug: string;
  display_name: string;
  description: string;
  default_reasoning_level: string | null;
  supported_reasoning_levels: CodexReasoningEffortPreset[];
  shell_type: 'shell_command';
  visibility: 'list';
  supported_in_api: true;
  priority: number;
  additional_speed_tiers: string[];
  service_tiers: [];
  default_service_tier: null;
  availability_nux: null;
  upgrade: null;
  base_instructions: string;
  model_messages: null;
  include_skills_usage_instructions: false;
  supports_reasoning_summaries: boolean;
  default_reasoning_summary: 'none';
  support_verbosity: boolean;
  default_verbosity: 'low' | null;
  apply_patch_tool_type: 'freeform' | null;
  web_search_tool_type: 'text';
  truncation_policy: {
    mode: 'tokens';
    limit: number;
  };
  supports_parallel_tool_calls: boolean;
  supports_image_detail_original: false;
  context_window: number | null;
  max_context_window: number | null;
  auto_compact_token_limit: null;
  effective_context_window_percent: 95;
  experimental_supported_tools: [];
  input_modalities: Array<'text' | 'image'>;
  supports_search_tool: false;
  use_responses_lite: false;
  auto_review_model_override: null;
  tool_mode: null;
  multi_agent_version: null;
};

export type CodexModelsResponse = {
  models: CodexModelInfo[];
};

type ModelsLoader = (req: Request, signal: AbortSignal) => Promise<unknown>;

function stringValue(value: unknown): string | null {
  return typeof value === 'string' && value.length > 0 ? value : null;
}

function booleanValue(value: unknown): boolean {
  return value === true;
}

function positiveInteger(value: unknown): number | null {
  return typeof value === 'number' && Number.isSafeInteger(value) && value > 0 ? value : null;
}

function stringArray(value: unknown): string[] {
  if (!Array.isArray(value)) return [];
  return [...new Set(value.filter((item): item is string => typeof item === 'string' && item.length > 0))];
}

function reasoningDescription(effort: string): string {
  switch (effort) {
    case 'none':
      return 'Fastest responses without additional reasoning';
    case 'minimal':
      return 'Very fast responses with minimal reasoning';
    case 'low':
      return 'Fast responses with lighter reasoning';
    case 'medium':
      return 'Balances speed and reasoning depth for everyday tasks';
    case 'high':
      return 'Greater reasoning depth for complex problems';
    case 'xhigh':
      return 'Extra high reasoning depth for complex problems';
    case 'max':
      return 'Maximum reasoning depth for the hardest problems';
    case 'ultra':
      return 'Maximum reasoning with automatic task delegation';
    default:
      return `${effort} reasoning effort`;
  }
}

function defaultReasoningEffort(efforts: string[]): string | null {
  for (const preferred of ['medium', 'low', 'none']) {
    if (efforts.includes(preferred)) return preferred;
  }
  return efforts[0] || null;
}

function mapCopilotModel(value: unknown, priority: number): CodexModelInfo | null {
  if (!isRecord(value) || value.model_picker_enabled !== true) return null;

  const id = stringValue(value.id);
  const name = stringValue(value.name);
  if (!id || !name) return null;

  const endpoints = stringArray(value.supported_endpoints);
  if (!endpoints.includes('/responses')) return null;

  const policy = isRecord(value.policy) ? value.policy : null;
  if (policy && typeof policy.state === 'string' && policy.state !== 'enabled') return null;

  const capabilities = isRecord(value.capabilities) ? value.capabilities : {};
  const limits = isRecord(capabilities.limits) ? capabilities.limits : {};
  const supports = isRecord(capabilities.supports) ? capabilities.supports : {};
  const reasoningEfforts = stringArray(supports.reasoning_effort);
  const supportsTools = booleanValue(supports.tool_calls);
  const supportsVision = booleanValue(supports.vision);
  const supportsVerbosity = id.startsWith('gpt-5');
  const vendor = stringValue(value.vendor);

  return {
    slug: id,
    display_name: name,
    description: vendor
      ? `${name} by ${vendor}, available through GitHub Copilot.`
      : `${name}, available through GitHub Copilot.`,
    default_reasoning_level: defaultReasoningEffort(reasoningEfforts),
    supported_reasoning_levels: reasoningEfforts.map(effort => ({
      effort,
      description: reasoningDescription(effort),
    })),
    shell_type: 'shell_command',
    visibility: 'list',
    supported_in_api: true,
    priority,
    additional_speed_tiers: [],
    service_tiers: [],
    default_service_tier: null,
    availability_nux: null,
    upgrade: null,
    base_instructions: CODEX_BASE_INSTRUCTIONS,
    model_messages: null,
    include_skills_usage_instructions: false,
    supports_reasoning_summaries: reasoningEfforts.length > 0,
    default_reasoning_summary: 'none',
    support_verbosity: supportsVerbosity,
    default_verbosity: supportsVerbosity ? 'low' : null,
    apply_patch_tool_type: supportsTools ? 'freeform' : null,
    web_search_tool_type: 'text',
    truncation_policy: { mode: 'tokens', limit: 10_000 },
    supports_parallel_tool_calls: booleanValue(supports.parallel_tool_calls),
    supports_image_detail_original: false,
    context_window:
      positiveInteger(limits.max_prompt_tokens) ||
      positiveInteger(limits.max_context_window_tokens),
    max_context_window: positiveInteger(limits.max_context_window_tokens),
    auto_compact_token_limit: null,
    effective_context_window_percent: 95,
    experimental_supported_tools: [],
    input_modalities: supportsVision ? ['text', 'image'] : ['text'],
    supports_search_tool: false,
    use_responses_lite: false,
    auto_review_model_override: null,
    tool_mode: null,
    multi_agent_version: null,
  };
}

export function toCodexModelsResponse(payload: unknown): CodexModelsResponse {
  if (!isRecord(payload) || !Array.isArray(payload.data)) {
    throw new Error('CAPI /models response missing data array');
  }

  const modelRanks = new Map<string, number>(
    MODEL_WHITELIST.map((slug, index) => [slug, index]),
  );
  const models = payload.data
    .map((model, index) => mapCopilotModel(model, index + 1))
    .filter(
      (model): model is CodexModelInfo =>
        model !== null && modelRanks.has(model.slug),
    );

  if (models.length === 0) {
    throw new Error('CAPI /models returned no Codex-compatible models');
  }

  models.sort((left, right) => {
    return (modelRanks.get(left.slug) ?? 0) - (modelRanks.get(right.slug) ?? 0);
  });
  models.forEach((model, index) => {
    model.priority = index + 1;
  });

  return { models };
}

export class ModelsUpstreamError extends Error {
  constructor(
    readonly status: number,
    readonly statusText: string,
    readonly body: string,
    readonly headers: Headers,
  ) {
    super(`CAPI /models failed: ${status} ${statusText}`);
  }
}

async function loadCopilotModels(req: Request, signal: AbortSignal): Promise<unknown> {
  const { apiBase, headers } = await getProxyContext(req);
  headers.Accept = 'application/json';
  headers['X-GitHub-Api-Version'] = MODELS_API_VERSION;

  const response = await fetch(`${apiBase}/models`, {
    method: 'GET',
    headers,
    signal,
  });

  if (!response.ok) {
    throw new ModelsUpstreamError(
      response.status,
      response.statusText,
      await response.text(),
      buildResponseHeaders(response),
    );
  }

  return response.json();
}

export class CodexModelsCatalog {
  private cached: { value: CodexModelsResponse; expiresAt: number } | null = null;
  private refresh: Promise<CodexModelsResponse> | null = null;

  constructor(
    private readonly loader: ModelsLoader = loadCopilotModels,
    private readonly now: () => number = Date.now,
    private readonly ttlMs: number = MODELS_CACHE_TTL_MS,
    private readonly fetchTimeoutMs: number = MODELS_FETCH_TIMEOUT_MS,
  ) {}

  async get(req: Request): Promise<CodexModelsResponse> {
    if (this.cached && this.cached.expiresAt > this.now()) {
      return this.cached.value;
    }

    if (this.refresh) return this.refresh;

    const abortController = new AbortController();
    let timeout: ReturnType<typeof setTimeout> | undefined;
    const timedOut = new Promise<never>((_, reject) => {
      timeout = setTimeout(() => {
        abortController.abort();
        reject(new Error(`CAPI /models timed out after ${this.fetchTimeoutMs}ms`));
      }, this.fetchTimeoutMs);
    });

    this.refresh = Promise.race([
      this.loader(req, abortController.signal).then(toCodexModelsResponse),
      timedOut,
    ])
      .then(value => {
        this.cached = { value, expiresAt: this.now() + this.ttlMs };
        return value;
      })
      .finally(() => {
        if (timeout) clearTimeout(timeout);
      });

    try {
      return await this.refresh;
    } finally {
      this.refresh = null;
    }
  }
}

const modelsCatalog = new CodexModelsCatalog();

export async function listCodexModels(
  req: Request,
  catalog: CodexModelsCatalog = modelsCatalog,
): Promise<Response> {
  try {
    const result = await catalog.get(req);
    return Response.json(result, {
      headers: {
        'Cache-Control': `private, max-age=${Math.floor(MODELS_CACHE_TTL_MS / 1000)}`,
      },
    });
  } catch (error) {
    if (error instanceof ModelsUpstreamError) {
      console.error(`[proxy] models upstream ${error.status}: ${error.body}`);
      return new Response(error.body, {
        status: error.status,
        headers: error.headers,
      });
    }

    console.error('[proxy] Models error:', error);
    return Response.json(
      { error: { type: 'proxy_error', message: String(error) } },
      { status: 502 },
    );
  }
}
