import { buildResponseHeaders, getProxyContext, isRecord, mapModel } from './proxy.ts';
import {
  StructuredOutputAdapterError,
  chatCompletionToClaudeMessage,
  chatCompletionToClaudeMessageStream,
  claudeStructuredOutputToChatCompletions,
  hasClaudeStructuredOutput,
} from './messages-structured-output.ts';
import { pickHeaderExtras, pipeAndExtractUsage } from './usage.ts';
import type { RequestContext } from './types.ts';

// Exact `anthropic-beta` flags the proxy forwards upstream. Derived from the
// CAPI beta-header probe (`capi_tests/claude/beta-headers/`), which records
// which headers Copilot's `/v1/messages` admits vs. rejects with
// "unsupported beta header(s)". Anything not listed here is silently stripped,
// so an unprobed/rejected header can never reach CAPI and trigger a 400.
//
// Tool/input betas are only included when the matching server-tools probe
// (`capi_tests/claude/server-tools/`) confirms the underlying tool actually
// works on Copilot CAPI. Re-run both probes and reconcile this list when
// Copilot's gateway changes.
const ANTHROPIC_BETA_WHITELIST = new Set<string>([
  // Generation / thinking / context
  'interleaved-thinking-2025-05-14',
  'dev-full-thinking-2025-05-14',
  'thinking-token-count-2026-05-13',
  'context-management-2025-06-27', // also gates the `memory` tool (probe: supported)
  'context-1m-2025-08-07',
  'model-context-window-exceeded-2025-08-26',
  'advanced-tool-use-2025-11-20',
  'fast-mode-2026-02-01',
  'output-300k-2026-03-24',
  // Caching
  'prompt-caching-2024-07-31',
  'extended-cache-ttl-2025-04-11',
  'cache-diagnosis-2026-04-07',
  // Tools / input — only betas the server-tools probe confirms work on CAPI
  'computer-use-2025-11-24', // bash / computer / text_editor tools (probe: supported)
  'fine-grained-tool-streaming-2025-05-14', // tool-input streaming toggle
]);

function isAllowedAnthropicBeta(flag: string): boolean {
  return ANTHROPIC_BETA_WHITELIST.has(flag);
}

function messageUsageExtras(req: Request): Record<string, string> {
  const extras = pickHeaderExtras(req.headers, [
    'x-claude-code-session-id',
    'x-session-affinity',
    'x-opencode-session',
  ]);
  const ua = req.headers.get('user-agent');
  if (ua) extras['user-agent'] = ua;
  return extras;
}

function invalidStructuredOutputRequest(error: StructuredOutputAdapterError): Response {
  return new Response(
    JSON.stringify({ type: 'error', error: { type: 'invalid_request_error', message: error.message } }),
    { status: 400, headers: { 'Content-Type': 'application/json' } },
  );
}

export async function proxyMessages(ctx: RequestContext): Promise<Response> {
  try {
    const { req, apiKeyId } = ctx;
    const { apiBase, headers } = await getProxyContext(req);
    const body: Record<string, unknown> = isRecord(ctx.body) ? { ...ctx.body } : {};

    if (typeof body.model === 'string') {
      body.model = mapModel(body.model);
    }

    const upstreamBeta = req.headers.get('anthropic-beta')
      ?.split(',')
      .map(h => h.trim())
      .filter(h => h && isAllowedAnthropicBeta(h))
      .join(',');
    if (upstreamBeta) {
      headers['anthropic-beta'] = upstreamBeta;
    }

    const outputConfig = isRecord(body.output_config) ? body.output_config : null;
    const thinking = isRecord(body.thinking) ? body.thinking : null;
    const effort = typeof outputConfig?.effort === 'string' ? (outputConfig.effort as string) : null;

    const thinkingType = typeof thinking?.type === 'string' ? (thinking.type as string) : 'none';
    console.log(
      `[proxy] ${String(body.model)} stream=${Boolean(body.stream)} effort=${effort} thinking=${thinkingType} key=${apiKeyId}`,
    );

    if (hasClaudeStructuredOutput(body)) {
      let chatBody: Record<string, unknown>;
      try {
        chatBody = claudeStructuredOutputToChatCompletions(body);
      } catch (error) {
        if (error instanceof StructuredOutputAdapterError) {
          return invalidStructuredOutputRequest(error);
        }
        throw error;
      }

      const chatHeaders = { ...headers };

      console.log(
        `[proxy] structured output via chat/completions model=${String(chatBody.model)} stream=${Boolean(body.stream)} key=${apiKeyId}`,
      );

      const upstream = await fetch(`${apiBase}/chat/completions`, {
        method: 'POST',
        headers: chatHeaders,
        body: JSON.stringify(chatBody),
      });

      const respHeaders = buildResponseHeaders(upstream);

      if (!upstream.ok) {
        const errorBody = await upstream.text();
        console.error(`[proxy] structured output upstream ${upstream.status}: ${errorBody}`);
        return new Response(errorBody, { status: upstream.status, headers: respHeaders });
      }

      const completion = await upstream.json();
      if (!isRecord(completion)) {
        throw new Error('structured output upstream returned non-object JSON');
      }
      const requestModel = typeof body.model === 'string' ? body.model : null;

      if (Boolean(body.stream)) {
        respHeaders.set('Content-Type', 'text/event-stream; charset=utf-8');
        const transformed = new Response(chatCompletionToClaudeMessageStream(completion, requestModel), {
          status: upstream.status,
          headers: respHeaders,
        });
        return pipeAndExtractUsage(transformed, respHeaders, {
          endpoint: 'messages',
          keyId: apiKeyId,
          stream: true,
          requestModel,
          extras: messageUsageExtras(req),
        });
      }

      respHeaders.set('Content-Type', 'application/json');
      const transformed = new Response(JSON.stringify(chatCompletionToClaudeMessage(completion, requestModel)), {
        status: upstream.status,
        headers: respHeaders,
      });
      return pipeAndExtractUsage(transformed, respHeaders, {
        endpoint: 'messages',
        keyId: apiKeyId,
        stream: false,
        requestModel,
        extras: messageUsageExtras(req),
      });
    }

    const upstream = await fetch(`${apiBase}/v1/messages`, {
      method: 'POST',
      headers,
      body: JSON.stringify(body),
    });

    const respHeaders = buildResponseHeaders(upstream);

    if (!upstream.ok) {
      const errorBody = await upstream.text();
      console.error(`[proxy] upstream ${upstream.status}: ${errorBody}`);
      return new Response(errorBody, { status: upstream.status, headers: respHeaders });
    }

    if (upstream.body) {
      return pipeAndExtractUsage(upstream, respHeaders, {
        endpoint: 'messages',
        keyId: apiKeyId,
        stream: Boolean(body.stream),
        requestModel: typeof body.model === 'string' ? body.model : null,
        extras: messageUsageExtras(req),
      });
    }

    return new Response(null, { status: upstream.status, headers: respHeaders });
  } catch (error) {
    console.error('[proxy] Error:', error);
    return new Response(
      JSON.stringify({ type: 'error', error: { type: 'proxy_error', message: String(error) } }),
      { status: 502, headers: { 'Content-Type': 'application/json' } },
    );
  }
}
