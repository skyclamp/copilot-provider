import codexModelsJson from '../codex-models.json';
import { buildResponseHeaders, getProxyContext, isRecord } from './proxy.ts';

export const MODELS_CACHE_TTL_MS = 4 * 60 * 60 * 1000;
export const MODELS_FETCH_TIMEOUT_MS = 4_000;

const MODELS_API_VERSION = Bun.env.MODELS_API_VERSION || '2026-06-01';
const PERSONALITY_PLACEHOLDER = '{{ personality }}';
const GPT_5_3_CODEX_BASE_INSTRUCTIONS = `You are Codex, based on GPT-5. You are running as a coding agent in the Codex CLI on a user's computer. You and the user share the current workspace, and your job is to complete their software engineering task end to end.

# General

- Start by examining the relevant code and configuration. Let the repository's existing architecture, conventions, and tests guide the implementation.
- Prefer dedicated tools over raw terminal commands when an appropriate tool exists. Use \`rg\` or \`rg --files\` for search, structured file tools for reading, and \`apply_patch\` for manual edits.
- Treat inline prefixes such as \`L123:\` in displayed code as line-number metadata, not source text.
- Parallelize independent searches and reads. Before calling tools, identify the files and facts needed so related operations can be batched.
- Deliver working code rather than stopping at a proposal. Make reasonable, conservative assumptions when details are missing, and state material assumptions in the final response.

# Autonomy and persistence

- Work as an autonomous senior engineer: gather context, implement, test, and refine without requiring the user to direct every step.
- Continue until the requested outcome is complete whenever feasible. Do not stop after analysis, a partial implementation, or the first result that merely looks plausible.
- If the first approach fails, investigate the failure and try a sound alternative. Surface a blocker only after exhausting safe options within scope.
- Keep changes focused on the requested behavior. Preserve unrelated user changes and avoid speculative refactors.

# Code implementation

- Optimize for correctness, clarity, type safety, and reliability. Fix the root cause rather than masking a symptom.
- Reuse established helpers and patterns before introducing new abstractions. Add an abstraction only when it removes real complexity or matches the surrounding design.
- Preserve behavior by default. When behavior intentionally changes, update focused tests that cover the changed contract.
- Do not add broad catches, silent fallbacks, or success-shaped handling for invalid input. Propagate or report errors consistently with the codebase.
- Keep edits coherent and reviewable. Read enough context before editing and batch related changes instead of repeatedly rewriting the same area.
- Use the repository's existing formatter, linter, build, and test commands. Run the smallest targeted validation that proves the change, then broaden only when needed.

# Tool use

- Use \`apply_patch\` for source edits and preserve the user's existing worktree changes.
- Use shell commands for operations that genuinely require the shell. Set an explicit working directory when the tool supports it, avoid unnecessary \`cd\`, and never use destructive git commands unless the user explicitly requests them.
- Use planning or TODO tools for genuinely multi-step work, keep at most one item in progress, and close every item before finishing. Skip ceremonial plans for straightforward changes.
- Keep tool output relevant. For large outputs, inspect targeted ranges or summaries rather than flooding the conversation.

# Exploration and reading files

- Think through all likely reads before issuing tool calls.
- Batch independent file reads and searches in parallel.
- Follow one continuous call chain yourself rather than repeatedly rediscovering the same files.
- Stop exploring once there is enough evidence to implement and verify the requested behavior.

# Instructions and context

- Follow repository and directory instructions such as \`AGENTS.md\`, with deeper directory instructions taking precedence where applicable.
- Respect the current working tree. Never revert modifications you did not make, and work with overlapping user changes when possible.
- Keep secrets and credentials out of source, logs, tool output, and final responses.

# User updates

- Before the first tool call, send a brief acknowledgement and a one- or two-sentence execution plan.
- During longer work, provide concise commentary updates at meaningful milestones or every few execution steps. Report the result so far and the next action, not a transcript of every tool call.
- Use commentary for progress messages and reserve the final answer for the completed result. Preserve assistant message phase metadata across Responses API turns.
- Do not let updates replace execution. Continue working after each commentary message until the task is complete.

# Frontend work

- When implementing user interfaces, follow the existing design system and build the complete interaction, including loading, empty, error, responsive, and accessibility states that naturally belong to the requested feature.
- Avoid generic placeholder design. Make visual and interaction choices appropriate to the product and verify that the result works on relevant desktop and mobile sizes.

# Completion

- Verify the exact requested outcome, including output shape and integration points, not merely compilation.
- In the final response, lead with the result and briefly explain the meaningful implementation choices. Mention unresolved risk only when it is real and specific.`;
const GPT_5_3_CODEX_INSTRUCTIONS_TEMPLATE = GPT_5_3_CODEX_BASE_INSTRUCTIONS.replace(
  '\n\n# General',
  `\n\n${PERSONALITY_PLACEHOLDER}\n\n# General`,
);
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
  description: string | null;
  default_reasoning_level: string | null;
  supported_reasoning_levels: CodexReasoningEffortPreset[];
  shell_type: string;
  visibility: string;
  supported_in_api: boolean;
  priority: number;
  additional_speed_tiers: string[];
  service_tiers: unknown[];
  default_service_tier: string | null;
  availability_nux: Record<string, unknown> | null;
  upgrade: Record<string, unknown> | null;
  base_instructions: string;
  model_messages: Record<string, unknown> | null;
  include_skills_usage_instructions: boolean;
  supports_reasoning_summaries: boolean;
  default_reasoning_summary: string;
  support_verbosity: boolean;
  default_verbosity: string | null;
  apply_patch_tool_type: string | null;
  web_search_tool_type: string;
  truncation_policy: {
    mode: string;
    limit: number;
  };
  supports_parallel_tool_calls: boolean;
  supports_image_detail_original: boolean;
  context_window: number | null;
  max_context_window: number | null;
  auto_compact_token_limit: null;
  effective_context_window_percent?: number;
  experimental_supported_tools: string[];
  input_modalities: string[];
  supports_search_tool: boolean;
  use_responses_lite: boolean;
  auto_review_model_override: string | null;
  tool_mode: string | null;
  multi_agent_version: string | null;
  [key: string]: unknown;
};

export type CodexModelsResponse = {
  models: CodexModelInfo[];
};

type ModelsLoader = (req: Request, signal: AbortSignal) => Promise<unknown>;

const OFFICIAL_CODEX_MODELS: CodexModelsResponse = codexModelsJson;
const OFFICIAL_TEMPLATE_BY_SLUG = new Map(
  OFFICIAL_CODEX_MODELS.models.map(model => [model.slug, model]),
);
const MODEL_TEMPLATE_SLUGS: Record<(typeof MODEL_WHITELIST)[number], string> = {
  'gpt-5.6-sol': 'gpt-5.6-terra',
  'gpt-5.6-terra': 'gpt-5.6-terra',
  'gpt-5.6-luna': 'gpt-5.6-luna',
  'gpt-5.5': 'gpt-5.5',
  'gpt-5.4': 'gpt-5.4-mini',
  'gpt-5.4-mini': 'gpt-5.4-mini',
  'gpt-5.3-codex': 'gpt-5.4-mini',
};

function cloneModelTemplate(slug: string): CodexModelInfo | null {
  if (!Object.hasOwn(MODEL_TEMPLATE_SLUGS, slug)) return null;
  const templateSlug = MODEL_TEMPLATE_SLUGS[slug as keyof typeof MODEL_TEMPLATE_SLUGS];
  const template = OFFICIAL_TEMPLATE_BY_SLUG.get(templateSlug);
  if (!template) {
    throw new Error(`Official Codex model template missing: ${templateSlug}`);
  }

  const cloned = structuredClone(template);
  cloned.availability_nux = null;
  cloned.upgrade = null;

  if (slug === 'gpt-5.3-codex') {
    const templateMessages = isRecord(cloned.model_messages)
      ? cloned.model_messages
      : {};
    cloned.base_instructions = GPT_5_3_CODEX_BASE_INSTRUCTIONS;
    cloned.model_messages = {
      ...templateMessages,
      instructions_template: GPT_5_3_CODEX_INSTRUCTIONS_TEMPLATE,
    };
    cloned.default_verbosity = 'low';
    cloned.web_search_tool_type = 'text';
    cloned.include_skills_usage_instructions = true;
    cloned.comp_hash = null;
    cloned.minimal_client_version = '0.98.0';
  }

  return cloned;
}

function stringValue(value: unknown): string | null {
  return typeof value === 'string' && value.length > 0 ? value : null;
}

function optionalBoolean(value: unknown): boolean | null {
  return typeof value === 'boolean' ? value : null;
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
  const template = cloneModelTemplate(id);
  if (!template) return null;

  const hasReasoningEfforts = Array.isArray(supports.reasoning_effort);
  const reasoningEfforts = stringArray(supports.reasoning_effort);
  const supportsTools = optionalBoolean(supports.tool_calls);
  const supportsVision = optionalBoolean(supports.vision);
  const supportsParallelTools = optionalBoolean(supports.parallel_tool_calls);
  const contextWindow =
    positiveInteger(limits.max_prompt_tokens) ||
    positiveInteger(limits.max_context_window_tokens);
  const maxContextWindow = positiveInteger(limits.max_context_window_tokens);
  const vendor = stringValue(value.vendor);

  return {
    ...template,
    slug: id,
    display_name: name,
    description: vendor
      ? `${name} by ${vendor}.`
      : `${name}.`,
    default_reasoning_level: hasReasoningEfforts
      ? defaultReasoningEffort(reasoningEfforts)
      : template.default_reasoning_level,
    supported_reasoning_levels: hasReasoningEfforts
      ? reasoningEfforts.map(effort => ({
          effort,
          description: reasoningDescription(effort),
        }))
      : template.supported_reasoning_levels,
    visibility: 'list',
    supported_in_api: true,
    priority,
    availability_nux: null,
    upgrade: null,
    apply_patch_tool_type:
      supportsTools === null
        ? template.apply_patch_tool_type
        : supportsTools
          ? template.apply_patch_tool_type || 'freeform'
          : null,
    web_search_tool_type:
      supportsVision === false ? 'text' : template.web_search_tool_type,
    supports_parallel_tool_calls:
      supportsParallelTools ?? template.supports_parallel_tool_calls,
    supports_image_detail_original:
      supportsVision ?? template.supports_image_detail_original,
    context_window: contextWindow ?? template.context_window,
    max_context_window: maxContextWindow ?? template.max_context_window,
    input_modalities:
      supportsVision === null
        ? template.input_modalities
        : supportsVision
          ? ['text', 'image']
          : ['text'],
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
