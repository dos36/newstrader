/**
 * Per-call cost accounting for llm_signals.cost_usd — a MEASUREMENT, not a
 * money-path value (float by design; see the schema's real-vs-numeric note).
 * The per-day spend circuit breaker sums this column, so the constants below
 * are a safety input: keep them at STANDARD (non-promotional) list prices so
 * the breaker over-estimates rather than under-estimates during promo windows.
 */

export interface LlmUsage {
  inputTokens: number;
  outputTokens: number;
  cacheCreationInputTokens: number;
  cacheReadInputTokens: number;
}

interface ModelPricing {
  inputUsdPerMTok: number;
  outputUsdPerMTok: number;
  /** 5-minute-TTL cache write premium (1.25× input). */
  cacheWriteUsdPerMTok: number;
  /** Cache read (~0.1× input). */
  cacheReadUsdPerMTok: number;
}

/**
 * Verified against Anthropic pricing 2026-08-09. Sonnet-5 list is $3/$15 per
 * MTok (an intro $2/$10 runs through 2026-08-31 — deliberately NOT used here;
 * see module doc). Adding a model here is a conscious act: computeCostUsd
 * throws on unknown ids so a model switch can never silently produce
 * cost_usd=0 rows and blind the spend breaker.
 */
const MODEL_PRICING: Readonly<Record<string, ModelPricing>> = {
  'claude-sonnet-5': {
    inputUsdPerMTok: 3,
    outputUsdPerMTok: 15,
    cacheWriteUsdPerMTok: 3.75,
    cacheReadUsdPerMTok: 0.3,
  },
};

export function computeCostUsd(modelId: string, usage: LlmUsage): number {
  const pricing = MODEL_PRICING[modelId];
  if (pricing === undefined) {
    throw new Error(
      `No pricing registered for model "${modelId}" — add it to MODEL_PRICING (llm/cost.ts) ` +
        'so the spend breaker keeps working.',
    );
  }
  const perTok = 1 / 1_000_000;
  return (
    usage.inputTokens * pricing.inputUsdPerMTok * perTok +
    usage.outputTokens * pricing.outputUsdPerMTok * perTok +
    usage.cacheCreationInputTokens * pricing.cacheWriteUsdPerMTok * perTok +
    usage.cacheReadInputTokens * pricing.cacheReadUsdPerMTok * perTok
  );
}
