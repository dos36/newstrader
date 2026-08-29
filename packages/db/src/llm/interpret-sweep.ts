import {
  CURRENT_PROMPT_VERSION,
  getPromptDefinition,
  INTERPRET_OBSERVATION_LAG_MS,
  type InterpretContext,
  type RawStore,
} from '@newstrader/core';

import type { Db } from '../client.js';
import type { LlmTransport } from '../shared-constants.js';
import { simpleReturnBps } from '../reaction/math.js';
import { loadDecisionQuote, loadSettledCloseAt } from '../trading/decide-repo.js';
import { buildSignalKey, persistSignal } from '../trading/signals-repo.js';
import { writeAuditBlob, type AuditBlob } from './audit.js';
import type { LlmClient } from './anthropic-client.js';
import { computeCostUsd } from './cost.js';
import {
  countClusterItemsAsOf,
  countInterpretationCandidates,
  loadClusterItemsForPrompt,
  loadInterpretationCandidates,
  recordAttemptFailure,
  sumLlmSpendSince,
  utcDayStart,
  type InterpretationCandidate,
} from './interpret-repo.js';
import { extractLede } from './lede.js';
import { loadFilingDocumentRefs } from '../documents/document-repo.js';

/**
 * The M2 interpret sweep — novel (cluster × instrument) pairs → one LLM call
 * each → llm_signals rows via persistSignal. Money never moves here: the
 * output is an opinion row; decide-sweep applies the deterministic gates.
 *
 * Safety layers, in evaluation order:
 *   1. kill switch (caller-read, same semantics as decide/execute): halted ⇒
 *      zero API calls;
 *   2. per-UTC-day spend cap over SUM(cost_usd): reached ⇒ stop calling;
 *   3. poison-pill attempts cap (content failures only — transport errors
 *      abort the pass without burning attempts);
 *   4. retrospective quarantine: the live window is bounded by lookbackHours,
 *      and anything older requires an explicit retrospective window whose
 *      rows are stamped retrospective=true (excluded from the decide queue).
 */

const DEFAULT_BATCH = 25;
const DEFAULT_LOOKBACK_HOURS = 24;
const DEFAULT_DAILY_SPEND_CAP_USD = 5;
const MAX_ATTEMPTS = 3;
/** One session back for the pre-arrival run-up (v3's already_expected input). */
const RUN_UP_LOOKBACK_MS = 24 * 3_600_000;
const ITEMS_PER_PROMPT = 3;

export interface InterpretSweepDeps {
  llm: LlmClient;
  /** Where audit blobs go (FsRawStore locally, S3RawStore/LlmAuditBucket deployed). */
  auditStore: RawStore;
  /** Where raw item payloads are read back from (payload_ref is authoritative). */
  payloadStore: RawStore;
  killSwitchHalted: boolean;
  /** Injectable clock (tests). */
  now?: () => Date;
}

export interface InterpretSweepOptions {
  promptVersion?: string;
  batch?: number;
  lookbackHours?: number;
  /**
   * Explicit backfill window (both bounds required, deliberately no default):
   * rows get retrospective=true and never reach the live decide queue.
   */
  retrospective?: { from: Date; to: Date };
  dailySpendCapUsd?: number;
  /**
   * Restrict the pass to exactly these `${clusterId}:${instrumentId}` pairs —
   * the sampling hook for prompt experiments. Retrospective-only: a live sweep
   * must never be silently narrowed to a sample.
   */
  samplePairs?: string[];
  /** Assemble candidates + first prompt, but no API calls and no writes. */
  dryRun?: boolean;
  /**
   * Also count everything still queued after the pass (one extra full-window
   * COUNT). Off by default so the deployed sweep does not pay for it.
   */
  countRemaining?: boolean;
}

export interface InterpretSweepResult {
  /** Which client did the calling — 'cli' rows are dev-only and not comparable. */
  transport: LlmTransport;
  halted: boolean;
  examined: number;
  interpreted: number;
  duplicates: number;
  failures: number;
  spendCapReached: boolean;
  /** SUM(cost_usd) for the UTC day after this pass (estimate: excludes failed-attempt spend). */
  spentTodayUsd: number;
  transportError: string | null;
  retrospective: boolean;
  dryRun: boolean;
  /** First candidate's rendered user prompt (dry-run only). */
  samplePrompt: string | null;
  /** Candidates still queued after this pass; null unless countRemaining was set. */
  remaining: number | null;
}

export async function interpretSweep(
  db: Db,
  deps: InterpretSweepDeps,
  options?: InterpretSweepOptions,
): Promise<InterpretSweepResult> {
  const nowFn = deps.now ?? ((): Date => new Date());
  const now = nowFn();
  const promptVersion = options?.promptVersion ?? CURRENT_PROMPT_VERSION;
  const prompt = getPromptDefinition(promptVersion);
  const batch = options?.batch ?? DEFAULT_BATCH;
  const capUsd = options?.dailySpendCapUsd ?? DEFAULT_DAILY_SPEND_CAP_USD;
  const isRetrospective = options?.retrospective !== undefined;
  const dryRun = options?.dryRun ?? false;
  if (options?.samplePairs !== undefined && !isRetrospective) {
    throw new Error(
      'interpretSweep: samplePairs is an experiment hook and requires a retrospective window — ' +
        'a live sweep must never be narrowed to a sample.',
    );
  }

  const result: InterpretSweepResult = {
    transport: deps.llm.transport,
    halted: false,
    examined: 0,
    interpreted: 0,
    duplicates: 0,
    failures: 0,
    spendCapReached: false,
    spentTodayUsd: 0,
    transportError: null,
    retrospective: isRetrospective,
    dryRun,
    samplePrompt: null,
    remaining: null,
  };

  if (deps.killSwitchHalted) {
    result.halted = true;
    logSweep(result, promptVersion);
    return result;
  }

  let window: { from: Date; to: Date };
  if (options?.retrospective !== undefined) {
    window = options.retrospective;
    if (window.from.getTime() > window.to.getTime()) {
      throw new Error('interpretSweep: retrospective window from > to');
    }
    // The recent-side bound is what makes the quarantine actually two-sided.
    // signal_key does not encode retrospective-ness while being UNIQUE, so a
    // backfill row overlapping the live lookback takes the live row's slot and
    // the candidate anti-join never offers that pair again — the pair is
    // permanently invisible to decide, recoverable only by hand.
    const liveLookbackHours = options?.lookbackHours ?? DEFAULT_LOOKBACK_HOURS;
    const liveFloor = now.getTime() - liveLookbackHours * 3_600_000;
    if (window.to.getTime() > liveFloor) {
      throw new Error(
        `interpretSweep: retrospective window ends at ${window.to.toISOString()}, inside the live ` +
          `lookback (starts ${new Date(liveFloor).toISOString()}) — it would quarantine ` +
          `live-eligible pairs permanently. Move --to earlier.`,
      );
    }
  } else {
    const lookbackHours = options?.lookbackHours ?? DEFAULT_LOOKBACK_HOURS;
    window = { from: new Date(now.getTime() - lookbackHours * 3_600_000), to: now };
  }

  // The transport comes off the client itself, never from a caller-supplied
  // flag — a row cannot be labelled with a mode it was not produced by.
  const transport = deps.llm.transport;

  const candidates = await loadInterpretationCandidates(db, {
    from: window.from,
    to: window.to,
    promptVersion,
    modelId: prompt.modelId,
    batch,
    maxAttempts: MAX_ATTEMPTS,
    transport,
    ...(options?.samplePairs !== undefined ? { pairKeys: options.samplePairs } : {}),
  });
  result.examined = candidates.length;

  const countRemaining = async (): Promise<void> => {
    if (options?.countRemaining !== true) return;
    result.remaining = await countInterpretationCandidates(db, {
      from: window.from,
      to: window.to,
      promptVersion,
      modelId: prompt.modelId,
      maxAttempts: MAX_ATTEMPTS,
      transport,
      ...(options?.samplePairs !== undefined ? { pairKeys: options.samplePairs } : {}),
    });
  };

  if (dryRun) {
    const first = candidates[0];
    if (first !== undefined) {
      const assembled = await assembleContext(db, deps, first, nowFn(), prompt.includeFilingText);
      result.samplePrompt = prompt.buildUserPrompt(assembled.context);
    }
    // A dry run must report the real backlog, not 0 — it is the command an
    // operator uses to decide whether to start.
    await countRemaining();
    logSweep(result, promptVersion);
    return result;
  }

  result.spentTodayUsd = await sumLlmSpendSince(db, utcDayStart(now));

  for (const candidate of candidates) {
    if (result.spentTodayUsd >= capUsd) {
      result.spendCapReached = true;
      break;
    }

    const assembled = await assembleContext(
      db,
      deps,
      candidate,
      nowFn(),
      prompt.includeFilingText,
    );
    const userPrompt = prompt.buildUserPrompt(assembled.context);
    const signalKey = buildSignalKey({
      clusterId: candidate.clusterId,
      instrumentId: candidate.instrumentId,
      promptVersion,
      modelId: prompt.modelId,
      transport,
    });

    let outcome;
    try {
      outcome = await deps.llm.interpret({
        systemPrompt: prompt.systemPrompt,
        userPrompt,
        modelId: prompt.modelId,
        maxTokens: prompt.maxTokens,
        effort: prompt.effort,
      });
    } catch (error) {
      // Transport/infrastructure: abort the pass, burn NO attempt — the next
      // tick retries the same candidates for free.
      result.transportError = error instanceof Error ? error.message : String(error);
      break;
    }

    const analyzedAt = nowFn();
    // On transport='cli' this is dominated by ~25.7k tokens of Claude Code
    // harness prompt per call, so it over-states the interpretation's true
    // cost. Left in on purpose: the daily cap must over-estimate, never under.
    const costUsd = computeCostUsd(prompt.modelId, outcome.usage);
    result.spentTodayUsd += costUsd;

    const blob: AuditBlob = {
      schemaVersion: 2,
      signalKey,
      promptVersion,
      transport,
      modelId: prompt.modelId,
      effort: prompt.effort,
      maxTokens: prompt.maxTokens,
      systemPrompt: prompt.systemPrompt,
      userPrompt,
      observedAtIso: assembled.observedAt.toISOString(),
      response: outcome.rawResponse,
      parsed: outcome.interpretation,
      failure: outcome.failure,
      usage: outcome.usage,
      latencyMs: outcome.latencyMs,
      analyzedAtIso: analyzedAt.toISOString(),
    };
    const auditRef = await writeAuditBlob(deps.auditStore, blob);

    if (outcome.interpretation === null) {
      await recordAttemptFailure(db, {
        signalKey,
        error: outcome.failure ?? 'unknown content failure',
        auditRef,
        at: analyzedAt,
      });
      result.failures += 1;
      continue;
    }

    const interpretation = outcome.interpretation;
    const persisted = await persistSignal(db, {
      clusterId: candidate.clusterId,
      scope: 'company',
      instrumentId: candidate.instrumentId,
      eventType: interpretation.event_type,
      direction: interpretation.direction,
      expectedMoveBps: interpretation.expected_move_bps,
      horizon: interpretation.horizon,
      alreadyExpected: interpretation.already_expected,
      materiality: interpretation.materiality,
      confidence: interpretation.confidence,
      modelId: prompt.modelId,
      promptVersion,
      promptRef: auditRef,
      responseRef: auditRef,
      inputTokens: outcome.usage.inputTokens,
      outputTokens: outcome.usage.outputTokens,
      costUsd,
      latencyMs: outcome.latencyMs,
      clusterItemCountAtAnalysis: assembled.itemCountAsOf,
      retrospective: isRetrospective,
      transport,
      reasoning: interpretation.reasoning,
      analyzedAt,
    });
    if (persisted.inserted) result.interpreted += 1;
    else result.duplicates += 1;
  }

  await countRemaining();

  logSweep(result, promptVersion);
  return result;
}

/**
 * Everything the model is shown, reconstructed as of ONE instant:
 * `min(anchor + INTERPRET_OBSERVATION_LAG_MS, now)`.
 *
 * The clamp matters in both directions. Without the lag, a fresh cluster gets
 * almost no price context; without the clamp, a cluster that arrived seconds
 * ago would be handed a price from the future. Between those, every candidate —
 * live or backfilled, interpreted promptly or after sitting in the queue — sees
 * the same shape of evidence, which is what makes rows from different days
 * comparable at all.
 */
interface AssembledContext {
  context: InterpretContext;
  /** The reconstructed observation instant, recorded in the audit blob. */
  observedAt: Date;
  /** Popularity at observedAt — what goes in llm_signals, not the final total. */
  itemCountAsOf: number;
}

async function assembleContext(
  db: Db,
  deps: InterpretSweepDeps,
  candidate: InterpretationCandidate,
  now: Date,
  includeFilingText: boolean,
): Promise<AssembledContext> {
  const anchorMs = candidate.anchorTs.getTime();
  const observedAt = new Date(Math.min(anchorMs + INTERPRET_OBSERVATION_LAG_MS, now.getTime()));
  const maxLagMs = Math.max(0, observedAt.getTime() - anchorMs);

  const itemRows = await loadClusterItemsForPrompt(
    db,
    candidate.clusterId,
    ITEMS_PER_PROMPT,
    maxLagMs,
  );
  const counts = await countClusterItemsAsOf(db, candidate.clusterId, maxLagMs);

  // Fetched SEC filing text, when the document sweep has it. For an EDGAR item
  // this is the difference between ~57 characters of filing metadata and the
  // actual 8-K body plus its press-release exhibits. Ablation arms
  // (includeFilingText: false on the prompt definition) skip the load entirely
  // and fall back to the Atom summary lede, exactly as a failed fetch would.
  const filingRefs = includeFilingText
    ? await loadFilingDocumentRefs(
        db,
        itemRows.map((row) => row.itemId),
      )
    : new Map<string, string>();

  const items = await Promise.all(
    itemRows.map(async (row) => {
      // Both fetches are best-effort: a missing or garbled blob degrades to the
      // next-best text and finally to headline-only, never failing the
      // candidate. Filing text wins over the Atom summary whenever it exists.
      const filingRef = filingRefs.get(row.itemId);
      const filingText = filingRef === undefined ? null : await readFilingText(deps, filingRef);
      const payload = await deps.payloadStore.get(row.payloadRef).catch(() => null);
      const lede = filingText ?? (payload === null ? null : extractLede(row.sourceKind, payload));
      return {
        sourceKey: row.sourceKey,
        headline: row.headline,
        lede,
        lagFromFirstMs: row.lagFromFirstMs,
        itemCodes: stringArray(row.meta['itemCodes']),
        formType: typeof row.meta['formType'] === 'string' ? row.meta['formType'] : null,
      };
    }),
  );

  const anchorClose = await loadSettledCloseAt(db, candidate.instrumentId, candidate.anchorTs);
  // The pre-arrival run-up (v3's price context): prior settled close → anchor
  // close. Both bounds are at-or-before the anchor, so this cannot leak the
  // reaction. RUN_UP_LOOKBACK_MS back lands on the previous session for an
  // intraday anchor and on Friday for a Monday-morning one (loadSettledCloseAt's
  // non-trading-gap rule handles the weekend). Note both endpoints inherit
  // loadSettledCloseAt's one-minute back-shift — it selects on bar CLOSE, not
  // open — so the run-up is measured between two fully-closed bars.
  const priorClose = await loadSettledCloseAt(
    db,
    candidate.instrumentId,
    new Date(anchorMs - RUN_UP_LOOKBACK_MS),
  );
  const priceRunUpBeforeAnchorBps =
    priorClose !== null && anchorClose !== null ? simpleReturnBps(priorClose, anchorClose) : null;
  // observedAt, NOT now: the whole point. A quote read at `now` turns "move
  // since story arrival" into the realized return to today for anything older
  // than a few minutes. When no bar exists that early (news outside market
  // hours), the quote is null and the prompt honestly says "unavailable".
  const quote = await loadDecisionQuote(db, candidate.instrumentId, observedAt);
  const priceMoveSinceAnchorBps =
    anchorClose !== null && quote !== null ? simpleReturnBps(anchorClose, quote.price) : null;

  return {
    observedAt,
    itemCountAsOf: counts.itemCount,
    context: {
      instrument: {
        symbol: candidate.symbol,
        name: candidate.name,
        assetClass: candidate.assetClass,
        sectorApprox: candidate.sectorApprox,
        exchange: candidate.exchange,
      },
      cluster: {
        canonicalHeadline: candidate.canonicalHeadline,
        firstReceivedAtIso: candidate.anchorTs.toISOString(),
        itemCount: counts.itemCount,
        distinctSourceCount: counts.distinctSourceCount,
      },
      items,
      priceMoveSinceAnchorBps,
      priceRunUpBeforeAnchorBps,
    },
  };
}

/**
 * Pull the flattened text out of a stored filing blob. Tolerant by design: a
 * missing or reshaped blob means "no filing text", not a failed candidate.
 */
async function readFilingText(deps: InterpretSweepDeps, ref: string): Promise<string | null> {
  const blob = await deps.payloadStore.get(ref).catch(() => null);
  if (typeof blob !== 'object' || blob === null) return null;
  const text = (blob as Record<string, unknown>)['text'];
  return typeof text === 'string' && text.trim().length > 0 ? text : null;
}

function stringArray(value: unknown): string[] | null {
  if (!Array.isArray(value)) return null;
  const strings = value.filter((entry): entry is string => typeof entry === 'string');
  return strings.length > 0 ? strings : null;
}

function logSweep(result: InterpretSweepResult, promptVersion: string): void {
  console.log(
    JSON.stringify({
      level: 'info',
      msg: 'interpret_sweep',
      promptVersion,
      ...result,
      spentTodayUsd: Number(result.spentTodayUsd.toFixed(4)),
      samplePrompt: result.samplePrompt === null ? null : '<omitted>',
    }),
  );
}
