import {
  buildSystemPromptV1,
  buildSystemPromptV3,
  buildSystemPromptV3NoFiling,
  buildSystemPromptV4a,
  buildUserPrompt,
  buildUserPromptV3,
  type InterpretContext,
} from './prompt.js';

/**
 * Prompt registry — prompt text lives in the repo, versioned; every signal
 * row is stamped with prompt_version + model_id (roadmap §3.2).
 *
 * A prompt version is the WHOLE call contract, not just the system text:
 * model id, effort, and max_tokens all change model behavior, so changing any
 * of them means minting a new entry here (and new rows — re-prompting inserts,
 * never updates; signal_key embeds promptVersion+modelId). The hash-pin test
 * makes silent edits to a published version's system text fail the build —
 * mirroring the rules_versions discipline: versions are immutable data.
 */
export interface PromptDefinition {
  version: string;
  systemPrompt: string;
  /**
   * The version's user-prompt renderer. Part of the contract for the same
   * reason the system text is: it decides which context fields the model
   * actually sees. Held here rather than switched on in the sweep so an old
   * version keeps rendering exactly what it rendered when its rows were
   * written.
   */
  buildUserPrompt: (context: InterpretContext) => string;
  /** Exact Anthropic model id stamped into llm_signals.model_id. */
  modelId: string;
  /** output_config.effort — part of the contract (affects reasoning depth). */
  effort: 'low' | 'medium' | 'high' | 'xhigh' | 'max';
  /**
   * Hard per-response ceiling. NOT a budget the model paces itself against —
   * the model cannot see it, so hitting it truncates mid-token, which the
   * sweep records as a content failure and one of three attempts. Three
   * truncations abandon the candidate.
   *
   * Sizing it is not "JSON size + slack". claude-sonnet-5 runs adaptive
   * thinking whenever `thinking` is omitted, and `budget_tokens` no longer
   * exists on that model, so thinking cannot be capped separately — it spends
   * from THIS number before the ~200 tokens of signal JSON are written. v1's
   * 1500 treated thinking as the remainder; on this model it is the dominant
   * term. Unused headroom is free (you pay for tokens generated), so the only
   * cost of a generous cap is latency — see the client's request timeout.
   */
  maxTokens: number;
  /**
   * Whether the sweep loads fetched SEC filing bodies into this version's
   * items. Part of the contract for the same reason the user-prompt builder
   * is: it decides what the model sees. Added 2026-08-28 as a DESCRIPTION of
   * behavior that already existed — the sweep loaded filing text
   * unconditionally for every version, so `true` on v1/v2/v3 changes nothing
   * about what their stored rows saw (v1/v2 then truncated it to 1,500 chars
   * via their size belt). `false` exists for ablation arms.
   */
  includeFilingText: boolean;
}

/**
 * How long after a cluster's first_received_at the interpreter PRETENDS to be
 * looking, when it assembles context.
 *
 * Every context input is reconstructed as of `anchor + this` (clamped to the
 * real clock, so a fresh cluster is never given a future price): the quote
 * behind priceMoveSinceAnchorBps, which cluster items are shown, and the item
 * and source counts. 5 minutes because that is the deployed interpret-sweep
 * cadence — it is what a timely live pass would actually have seen.
 *
 * Why it exists: v1 assembled context with the WALL CLOCK. For any candidate
 * not interpreted within minutes of arrival — every retrospective backfill, and
 * any live candidate that sat in the queue — "Move since story arrival" then
 * carried the realized move up to today, and the cluster showed items that
 * arrived long after the anchor. That is look-ahead handed to the model in its
 * own prompt, independent of anything the model may have memorised. v2 closes
 * it, which is why v2 exists at all.
 */
export const INTERPRET_OBSERVATION_LAG_MS = 5 * 60_000;

export const PROMPT_REGISTRY: Readonly<Record<string, PromptDefinition>> = {
  v1: {
    version: 'v1',
    systemPrompt: buildSystemPromptV1(),
    buildUserPrompt,
    modelId: 'claude-sonnet-5',
    effort: 'medium',
    maxTokens: 1500,
    includeFilingText: true,
  },
  /**
   * Identical system text to v1 — on purpose. What changed is the CONTEXT
   * ASSEMBLY: v2 reconstructs every input as of the observation lag above,
   * where v1 used the wall clock. The model therefore sees different numbers
   * for the same story, so v1 and v2 rows must never be pooled in per-type
   * statistics. A new version is exactly the mechanism for that: signal_key
   * embeds promptVersion, so v2 re-interprets a pair v1 already answered and
   * both rows survive for comparison.
   *
   * v1 is kept registered, and its rows kept, only so that comparison is
   * possible. Do not run v1 for new measurement — its price context leaks.
   */
  v2: {
    version: 'v2',
    systemPrompt: buildSystemPromptV1(),
    buildUserPrompt,
    modelId: 'claude-sonnet-5',
    effort: 'medium',
    maxTokens: 10_000,
    includeFilingText: true,
  },
  /**
   * v3 — the first version built for measurement rather than for getting the
   * pipeline running. Three changes from v2:
   *
   *   1. PRE-ARRIVAL price context replaces post-arrival. v1/v2 showed the move
   *      from the anchor close to five minutes later — the opening slice of the
   *      reaction being predicted — while instructing the model to read it as
   *      evidence the news was already priced in. The anchor close sits after
   *      any run-up, so the run-up was never visible. v3 shows the prior
   *      session's move and no post-arrival price action at all.
   *   2. maxTokens 10_000, carried from v2.
   *
   * effort is `medium`, deliberately NOT xhigh. v3 exists to answer "is there
   * an edge here at all", and the cheapest honest read answers that: if the
   * signal only appears at maximum reasoning depth it is too fragile to build
   * on. Effort and model are the FIRST sweep dimensions once viability is
   * settled, and because both are part of the version contract, each setting
   * gets its own registry entry — that is the mechanism for comparing them,
   * not a flag to flip on v3.
   *
   * Changing this on v3 rather than minting v4 is legitimate exactly once, and
   * this is it: every v3 row so far is transport='cli', which applies NEITHER
   * effort nor max_tokens, so no stored row ever ran under the value being
   * changed. After the first api row lands, this number is frozen.
   */
  v3: {
    version: 'v3',
    systemPrompt: buildSystemPromptV3(),
    buildUserPrompt: buildUserPromptV3,
    modelId: 'claude-sonnet-5',
    effort: 'medium',
    maxTokens: 10_000,
    includeFilingText: true,
  },
  /**
   * EXPERIMENT ARM — the 8-K filing-text ablation (2026-08-28 investigation).
   * v3 minus the filing text: includeFilingText false stops the sweep loading
   * filing bodies, and the system text drops the (now false) filing bullet.
   * Everything else is byte-identical to v3. Run only via
   * `interpret --prompt-version v3-nofiling --mode cli` on a pairs sample;
   * never make this CURRENT_PROMPT_VERSION.
   *
   * Observational motivation: EDGAR-first clusters whose prompt provably
   * lacked filing text produced 1 directional signal out of 154 (avg
   * materiality 0.08); with filing text, 314 of 593. This arm measures the
   * same contrast causally, paired on identical pairs.
   */
  'v3-nofiling': {
    version: 'v3-nofiling',
    systemPrompt: buildSystemPromptV3NoFiling(),
    buildUserPrompt: buildUserPromptV3,
    modelId: 'claude-sonnet-5',
    effort: 'medium',
    maxTokens: 10_000,
    includeFilingText: false,
  },
  /**
   * EXPERIMENT ARM — v4 candidate a (2026-08-28 investigation). v3 plus
   * exactly two edits, each backed by a named tune-set failure pattern with
   * ≥20 examples (see prompt.ts constants):
   *
   *   1. Earnings direction guidance — 147 earnings/guidance clusters scored
   *      neutral, 58 of which moved ≥200bps abnormal at 1d ("mixed vs prior
   *      year" hedging).
   *   2. Confidence band anchors — v3's calibration curve was flat 46–60%
   *      across deciles (ECE 0.124).
   *
   * Runs on the tune sample first; holdout once; promoted to `v4` (byte-copy)
   * only if it passes the pre-registered criteria in the investigation memo.
   */
  v4a: {
    version: 'v4a',
    systemPrompt: buildSystemPromptV4a(),
    buildUserPrompt: buildUserPromptV3,
    modelId: 'claude-sonnet-5',
    effort: 'medium',
    maxTokens: 10_000,
    includeFilingText: true,
  },
};

export const CURRENT_PROMPT_VERSION = 'v3';

export function getPromptDefinition(version: string): PromptDefinition {
  const def = PROMPT_REGISTRY[version];
  if (def === undefined) {
    throw new Error(
      `Unknown prompt version "${version}" — registered: ${Object.keys(PROMPT_REGISTRY).join(', ')}`,
    );
  }
  return def;
}
