import Anthropic from '@anthropic-ai/sdk';
import { zodOutputFormat } from '@anthropic-ai/sdk/helpers/zod';
import { InterpretationSchema, type Interpretation } from '@newstrader/core';

import type { LlmTransport } from '../shared-constants.js';
import type { LlmUsage } from './cost.js';

/**
 * The interpreter's LLM seam. One narrow interface so tests inject a fake and
 * the sweep never touches the SDK directly (FetchLike/S3ClientLike precedent).
 *
 * Error contract — the load-bearing part:
 *   - `interpret()` THROWS only for transport/infrastructure problems
 *     (network, 429/5xx after SDK retries, config 4xx). The sweep treats a
 *     throw as "abort this pass, next tick retries" and does NOT burn an
 *     attempt — an Anthropic outage must not poison healthy candidates.
 *   - Content-level failures (safety refusal, truncation, schema-invalid
 *     output) RETURN with interpretation=null + failure set. Those are
 *     poison-pill candidates: the sweep records an attempt and gives up
 *     after the cap.
 */
export interface LlmCallRequest {
  systemPrompt: string;
  userPrompt: string;
  modelId: string;
  maxTokens: number;
  effort: 'low' | 'medium' | 'high' | 'xhigh' | 'max';
}

export interface LlmCallOutcome {
  /** Validated interpretation, or null when this call is a content-level failure. */
  interpretation: Interpretation | null;
  /** Human-readable poison reason iff interpretation is null. */
  failure: string | null;
  stopReason: string | null;
  usage: LlmUsage;
  /** Stable projection of the raw response — persisted in the audit blob. */
  rawResponse: unknown;
  latencyMs: number;
}

export interface LlmClient {
  /**
   * How this client reaches the model. Read by the sweep to stamp
   * llm_signals.transport and to derive the signal key, so the label cannot
   * drift from the code that produced the row.
   */
  readonly transport: LlmTransport;
  interpret(request: LlmCallRequest): Promise<LlmCallOutcome>;
}

/**
 * Production implementation over the official SDK.
 *
 * - The fixed system prompt is sent as a cache_control block: it is the byte-
 *   stable prefix (>1k tokens), so repeat calls within the TTL bill ~0.1× for
 *   it. All volatile content is in the user message, after the breakpoint.
 * - Structured output via output_config.format (zod-derived json_schema); the
 *   SDK strips wire-unsupported constraints (0-1 ranges) and validates them
 *   client-side, and we re-parse with zod anyway — belt and braces.
 * - The API key travels only in the SDK's auth header; it is constructor-
 *   injected and never logged (see the hygiene test).
 */
export class AnthropicLlmClient implements LlmClient {
  private readonly client: Anthropic;

  readonly transport = 'api' as const;

  constructor(options: { apiKey: string | undefined; baseUrl?: string | undefined }) {
    const apiKey = options.apiKey?.trim();
    if (apiKey === undefined || apiKey.length === 0) {
      throw new Error('ANTHROPIC_API_KEY is not set — required for the interpret stage.');
    }
    this.client = new Anthropic({
      apiKey,
      maxRetries: 2,
      // Sized against the prompt version's maxTokens (v2: 10k) on a
      // NON-streaming request. A timeout is a transport error, so it aborts the
      // pass and burns no attempt — benign, but the loop then retries the same
      // candidate first on every tick, so a candidate that reliably exceeds
      // this stalls everything behind it. Watch for transportError set on every
      // pass with interpreted: 0.
      timeout: 120_000,
      ...(options.baseUrl !== undefined ? { baseURL: options.baseUrl } : {}),
    });
  }

  async interpret(request: LlmCallRequest): Promise<LlmCallOutcome> {
    const startedAt = Date.now();
    const response = await this.client.messages.parse({
      model: request.modelId,
      max_tokens: request.maxTokens,
      system: [
        {
          type: 'text',
          text: request.systemPrompt,
          cache_control: { type: 'ephemeral' },
        },
      ],
      output_config: {
        effort: request.effort,
        format: zodOutputFormat(InterpretationSchema),
      },
      messages: [{ role: 'user', content: request.userPrompt }],
    });
    const latencyMs = Date.now() - startedAt;

    const usage: LlmUsage = {
      inputTokens: response.usage.input_tokens,
      outputTokens: response.usage.output_tokens,
      cacheCreationInputTokens: response.usage.cache_creation_input_tokens ?? 0,
      cacheReadInputTokens: response.usage.cache_read_input_tokens ?? 0,
    };
    const rawResponse = {
      id: response.id,
      model: response.model,
      stopReason: response.stop_reason,
      content: response.content,
      usage: response.usage,
    };
    const base = { stopReason: response.stop_reason, usage, rawResponse, latencyMs };

    if (response.stop_reason === 'refusal') {
      return { ...base, interpretation: null, failure: 'safety refusal (stop_reason=refusal)' };
    }
    if (response.stop_reason === 'max_tokens') {
      return {
        ...base,
        interpretation: null,
        failure: 'output truncated (stop_reason=max_tokens)',
      };
    }
    if (response.parsed_output === null || response.parsed_output === undefined) {
      return {
        ...base,
        interpretation: null,
        failure: `structured output missing/unparsable (stop_reason=${String(response.stop_reason)})`,
      };
    }

    const validated = InterpretationSchema.safeParse(response.parsed_output);
    if (!validated.success) {
      return {
        ...base,
        interpretation: null,
        failure: `schema validation failed: ${validated.error.message.slice(0, 300)}`,
      };
    }
    return { ...base, interpretation: validated.data, failure: null };
  }
}

/** Factory reading env (ANTHROPIC_API_KEY, ANTHROPIC_BASE_URL). Throws without the key. */
export function anthropicLlmClient(env: Record<string, string | undefined>): AnthropicLlmClient {
  return new AnthropicLlmClient({
    apiKey: env['ANTHROPIC_API_KEY'],
    baseUrl: env['ANTHROPIC_BASE_URL'],
  });
}
