import Anthropic from '@anthropic-ai/sdk';
import { zodOutputFormat } from '@anthropic-ai/sdk/helpers/zod';
import { TriageResultSchema, type TriageResult } from '@newstrader/core';

import type { LlmTransport } from '../shared-constants.js';
import type { LlmUsage } from './cost.js';

/**
 * The triage stage's LLM seam — same error contract as the interpret client
 * (anthropic-client.ts), which is the load-bearing part:
 *
 *   - `triage()` THROWS only for transport/infrastructure problems; the sweep
 *     aborts the pass and burns no attempt.
 *   - Content-level failures (refusal, truncation, schema-invalid output)
 *     RETURN with result=null + failure set; the sweep records an attempt and
 *     gives up after the cap.
 *
 * Differences from the interpret client, both deliberate:
 *   - No `output_config.effort` and no `thinking` param: the triage model is
 *     claude-haiku-4-5, which rejects `effort`; triage is a containment
 *     judgment and needs neither.
 *   - api transport only. Triage exists to make the pipeline cheaper; a cli
 *     variant would reintroduce the harness-token distortion for no benefit.
 */
export interface TriageCallRequest {
  systemPrompt: string;
  userPrompt: string;
  modelId: string;
  maxTokens: number;
}

export interface TriageCallOutcome {
  result: TriageResult | null;
  failure: string | null;
  stopReason: string | null;
  usage: LlmUsage;
  rawResponse: unknown;
  latencyMs: number;
}

export interface TriageLlmClient {
  readonly transport: LlmTransport;
  triage(request: TriageCallRequest): Promise<TriageCallOutcome>;
}

export class AnthropicTriageClient implements TriageLlmClient {
  private readonly client: Anthropic;

  readonly transport = 'api' as const;

  constructor(options: { apiKey: string | undefined; baseUrl?: string | undefined }) {
    const apiKey = options.apiKey?.trim();
    if (apiKey === undefined || apiKey.length === 0) {
      throw new Error('ANTHROPIC_API_KEY is not set — required for the triage stage.');
    }
    this.client = new Anthropic({
      apiKey,
      maxRetries: 2,
      // Triage outputs are ~100 tokens of JSON; 60s is generous.
      timeout: 60_000,
      ...(options.baseUrl !== undefined ? { baseURL: options.baseUrl } : {}),
    });
  }

  async triage(request: TriageCallRequest): Promise<TriageCallOutcome> {
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
      output_config: { format: zodOutputFormat(TriageResultSchema) },
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
      return { ...base, result: null, failure: 'safety refusal (stop_reason=refusal)' };
    }
    if (response.stop_reason === 'max_tokens') {
      return { ...base, result: null, failure: 'output truncated (stop_reason=max_tokens)' };
    }
    if (response.parsed_output === null || response.parsed_output === undefined) {
      return {
        ...base,
        result: null,
        failure: `structured output missing/unparsable (stop_reason=${String(response.stop_reason)})`,
      };
    }
    const validated = TriageResultSchema.safeParse(response.parsed_output);
    if (!validated.success) {
      return {
        ...base,
        result: null,
        failure: `schema validation failed: ${validated.error.message.slice(0, 300)}`,
      };
    }
    return { ...base, result: validated.data, failure: null };
  }
}

/** Factory reading env (ANTHROPIC_API_KEY, ANTHROPIC_BASE_URL). Throws without the key. */
export function anthropicTriageClient(env: Record<string, string | undefined>): AnthropicTriageClient {
  return new AnthropicTriageClient({
    apiKey: env['ANTHROPIC_API_KEY'],
    baseUrl: env['ANTHROPIC_BASE_URL'],
  });
}
