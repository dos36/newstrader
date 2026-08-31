import Anthropic from '@anthropic-ai/sdk';
import { zodOutputFormat } from '@anthropic-ai/sdk/helpers/zod';
import {
  discoveryCoherenceError,
  DiscoveryInterpretationSchema,
  InterpretationSchema,
  macroCoherenceError,
  MacroInterpretationSchema,
  type DiscoveryInterpretation,
  type Interpretation,
  type MacroInterpretation,
} from '@newstrader/core';

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
  /**
   * Optional second system block, sent with its own cache breakpoint.
   *
   * Exists for large per-run-stable context — the discovery contract's
   * candidate universe (~3.5k tokens). In the user prompt it would bill fresh
   * on every call and dominate the stage's input cost; as a cached block it
   * bills ~0.1× after the first call and re-caches only when its bytes change
   * (index membership changes rarely). Callers must render it
   * deterministically for exactly that reason.
   */
  cachedContext?: string;
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

/** {@link LlmCallOutcome} for the macro (sector) contract. */
export interface MacroLlmCallOutcome {
  /** Validated AND coherence-checked judgment, or null on a content failure. */
  interpretation: MacroInterpretation | null;
  failure: string | null;
  stopReason: string | null;
  usage: LlmUsage;
  rawResponse: unknown;
  latencyMs: number;
}

/** {@link LlmCallOutcome} for the discovery contract. */
export interface DiscoveryLlmCallOutcome {
  /** Validated AND coherence-checked judgment, or null on a content failure. */
  interpretation: DiscoveryInterpretation | null;
  failure: string | null;
  stopReason: string | null;
  usage: LlmUsage;
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
  /**
   * Optional on the interface so existing fakes and the dev CLI transport keep
   * satisfying it without implementing a contract they do not need. The macro
   * sweep checks for it and refuses to run against a client that lacks it,
   * rather than silently interpreting nothing.
   */
  interpretMacro?(request: LlmCallRequest): Promise<MacroLlmCallOutcome>;
  /** Same optionality story as {@link interpretMacro}, for the discovery contract. */
  interpretDiscovery?(request: LlmCallRequest): Promise<DiscoveryLlmCallOutcome>;
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
    const outcome = await this.call(request, InterpretationSchema);
    return { ...outcome, interpretation: outcome.parsed };
  }

  /**
   * The MACRO (sector-contract) variant — same transport, same caching,
   * different output contract. Separate method rather than a schema parameter
   * on {@link interpret} so each call site stays statically typed to the shape
   * it actually gets back; a `schema` argument would hand every caller an
   * `unknown` to narrow, and the first thing anyone does with that is cast.
   */
  async interpretMacro(request: LlmCallRequest): Promise<MacroLlmCallOutcome> {
    const outcome = await this.call(request, MacroInterpretationSchema);
    if (outcome.parsed === null) return { ...outcome, interpretation: null };
    // Coherence is checked HERE, at the transport boundary, so an incoherent
    // answer is a content failure exactly like a schema violation — one of
    // three attempts, no row. The wire schema cannot express "this field is
    // required only when that one has this value", so without this a
    // structurally valid but self-contradicting judgment would persist.
    const incoherent = macroCoherenceError(outcome.parsed);
    if (incoherent !== null) {
      return { ...outcome, interpretation: null, failure: `incoherent answer: ${incoherent}` };
    }
    return { ...outcome, interpretation: outcome.parsed };
  }

  /**
   * The DISCOVERY variant — world news in, up to three candidate companies
   * out. Coherence at the boundary for the same reason as interpretMacro; the
   * remaining fence (symbols must come from the rendered universe) lives in
   * the sweep, which is the only party that knows what it rendered.
   */
  async interpretDiscovery(request: LlmCallRequest): Promise<DiscoveryLlmCallOutcome> {
    const outcome = await this.call(request, DiscoveryInterpretationSchema);
    if (outcome.parsed === null) return { ...outcome, interpretation: null };
    const incoherent = discoveryCoherenceError(outcome.parsed);
    if (incoherent !== null) {
      return { ...outcome, interpretation: null, failure: `incoherent answer: ${incoherent}` };
    }
    return { ...outcome, interpretation: outcome.parsed };
  }

  /**
   * Shared request/response handling for both output contracts.
   *
   * Everything that is a property of the TRANSPORT rather than of the schema
   * lives here: prompt caching on the byte-stable system block, the usage
   * projection, and the three stop-reason failure modes. Duplicating this per
   * contract is how the two paths drift — one gains a failure check the other
   * lacks, and the difference shows up as an unexplained gap in the audit log.
   */
  private async call<T>(
    request: LlmCallRequest,
    schema: { safeParse: (input: unknown) => { success: true; data: T } | { success: false; error: { message: string } } },
  ): Promise<Omit<LlmCallOutcome, 'interpretation'> & { parsed: T | null }> {
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
        // The optional cached-context block gets its OWN breakpoint: the prompt
        // above stays a hit even on the (rare) call where this block's bytes
        // changed and had to be re-written.
        ...(request.cachedContext !== undefined
          ? [
              {
                type: 'text' as const,
                text: request.cachedContext,
                cache_control: { type: 'ephemeral' as const },
              },
            ]
          : []),
      ],
      output_config: {
        effort: request.effort,
        format: zodOutputFormat(schema as never),
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
      return { ...base, parsed: null, failure: 'safety refusal (stop_reason=refusal)' };
    }
    if (response.stop_reason === 'max_tokens') {
      return { ...base, parsed: null, failure: 'output truncated (stop_reason=max_tokens)' };
    }
    if (response.parsed_output === null || response.parsed_output === undefined) {
      return {
        ...base,
        parsed: null,
        failure: `structured output missing/unparsable (stop_reason=${String(response.stop_reason)})`,
      };
    }

    const validated = schema.safeParse(response.parsed_output);
    if (!validated.success) {
      return {
        ...base,
        parsed: null,
        failure: `schema validation failed: ${validated.error.message.slice(0, 300)}`,
      };
    }
    return { ...base, parsed: validated.data, failure: null };
  }
}

/** Factory reading env (ANTHROPIC_API_KEY, ANTHROPIC_BASE_URL). Throws without the key. */
export function anthropicLlmClient(env: Record<string, string | undefined>): AnthropicLlmClient {
  return new AnthropicLlmClient({
    apiKey: env['ANTHROPIC_API_KEY'],
    baseUrl: env['ANTHROPIC_BASE_URL'],
  });
}
