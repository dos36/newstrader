import {
  CURRENT_MACRO_PROMPT_VERSION,
  getMacroPromptDefinition,
  INTERPRET_OBSERVATION_LAG_MS,
  macroSignalRows,
  type MacroInterpretContext,
  type RawStore,
} from '@newstrader/core';

import type { Db } from '../client.js';
import type { LlmTransport } from '../shared-constants.js';
import { persistSignal } from '../trading/signals-repo.js';
import type { LlmClient } from './anthropic-client.js';
import { writeAuditBlob, type AuditBlob } from './audit.js';
import { computeCostUsd } from './cost.js';
import {
  countClusterItemsAsOf,
  loadClusterItemsForPrompt,
  recordAttemptFailure,
  sumLlmSpendSince,
  utcDayStart,
} from './interpret-repo.js';
import { extractLede } from './lede.js';
import { loadMacroCandidates, macroAttemptKey, type MacroCandidate } from './macro-repo.js';

/**
 * The MACRO interpret sweep — unlinked clusters → one LLM call each → zero or
 * more `llm_signals` rows.
 *
 * Structurally a sibling of the company sweep, with the same safety layers in
 * the same order (kill switch, daily spend cap, poison-pill attempts cap,
 * retrospective quarantine) because those are properties of calling a paid
 * model over stored facts, not of which prompt is used. Three things genuinely
 * differ:
 *
 * **The unit is a cluster, not a pair.** There is no instrument to pair with;
 * the affected instruments are an output, produced afterwards by the
 * deterministic fanout in core.
 *
 * **One call can write several rows, or none.** A broad-market judgment writes
 * one `scope='macro'` row, a sector judgment writes one per named sector, and a
 * `market_scope: 'none'` judgment writes nothing at all. `none` is the expected
 * majority answer, which is why it is counted separately in the result rather
 * than lumped in with failures — a stage that correctly declines most stories
 * looks broken in a log that only counts rows written.
 *
 * **No price context is assembled.** The company path shows a pre-arrival move
 * for a known instrument. Here the affected group is chosen by the model after
 * reading the story, so there is nothing to price in advance without
 * prejudging the answer.
 */

const DEFAULT_BATCH = 25;
const DEFAULT_LOOKBACK_HOURS = 24;
const DEFAULT_DAILY_SPEND_CAP_USD = 5;
const MAX_ATTEMPTS = 3;
const ITEMS_PER_PROMPT = 8;

export interface MacroSweepDeps {
  llm: LlmClient;
  auditStore: RawStore;
  payloadStore: RawStore;
  killSwitchHalted: boolean;
  now?: () => Date;
}

export interface MacroSweepOptions {
  promptVersion?: string;
  batch?: number;
  lookbackHours?: number;
  /** Explicit backfill window; rows get retrospective=true. Both bounds required. */
  retrospective?: { from: Date; to: Date };
  dailySpendCapUsd?: number;
  /** Restrict to clusters containing an item from these source keys. */
  sourceKeys?: string[];
  /** Restrict to exactly these cluster ids — experiment sampling, retrospective only. */
  sampleClusterIds?: string[];
  dryRun?: boolean;
}

export interface MacroSweepResult {
  transport: LlmTransport;
  halted: boolean;
  examined: number;
  /** Judgments that produced at least one row. */
  interpreted: number;
  /** Rows actually inserted — a sector judgment writes several. */
  rowsWritten: number;
  /**
   * Judgments of `market_scope: 'none'`. NOT failures: this is the answer the
   * prompt names as most often correct, and its rate is the stage's primary
   * quality metric.
   */
  noMechanism: number;
  duplicates: number;
  failures: number;
  spendCapReached: boolean;
  spentTodayUsd: number;
  transportError: string | null;
  retrospective: boolean;
  dryRun: boolean;
  samplePrompt: string | null;
}

export async function macroInterpretSweep(
  db: Db,
  deps: MacroSweepDeps,
  options?: MacroSweepOptions,
): Promise<MacroSweepResult> {
  const nowFn = deps.now ?? ((): Date => new Date());
  const now = nowFn();
  const promptVersion = options?.promptVersion ?? CURRENT_MACRO_PROMPT_VERSION;
  const prompt = getMacroPromptDefinition(promptVersion);
  const batch = options?.batch ?? DEFAULT_BATCH;
  const capUsd = options?.dailySpendCapUsd ?? DEFAULT_DAILY_SPEND_CAP_USD;
  const isRetrospective = options?.retrospective !== undefined;
  const dryRun = options?.dryRun ?? false;

  if (options?.sampleClusterIds !== undefined && !isRetrospective) {
    throw new Error(
      'macroInterpretSweep: sampleClusterIds is an experiment hook and requires a retrospective ' +
        'window — a live sweep must never be narrowed to a sample.',
    );
  }

  const transport = deps.llm.transport;
  const result: MacroSweepResult = {
    transport,
    halted: deps.killSwitchHalted,
    examined: 0,
    interpreted: 0,
    rowsWritten: 0,
    noMechanism: 0,
    duplicates: 0,
    failures: 0,
    spendCapReached: false,
    spentTodayUsd: 0,
    transportError: null,
    retrospective: isRetrospective,
    dryRun,
    samplePrompt: null,
  };

  if (deps.killSwitchHalted) {
    logSweep(result, promptVersion);
    return result;
  }

  // Checked before any candidate is loaded so the operator finds out from a
  // clear error rather than from a sweep that examines rows and writes nothing.
  const interpretMacro = deps.llm.interpretMacro?.bind(deps.llm);
  if (interpretMacro === undefined) {
    throw new Error(
      `macroInterpretSweep: transport '${transport}' does not implement interpretMacro — ` +
        'the macro output contract is unavailable on this client.',
    );
  }

  const retro = options?.retrospective;
  const window = retro !== undefined
    ? { from: retro.from, to: retro.to }
    : {
        from: new Date(
          now.getTime() - (options?.lookbackHours ?? DEFAULT_LOOKBACK_HOURS) * 3_600_000,
        ),
        to: now,
      };

  const candidates = await loadMacroCandidates(db, {
    from: window.from,
    to: window.to,
    promptVersion,
    modelId: prompt.modelId,
    batch,
    maxAttempts: MAX_ATTEMPTS,
    transport,
    ...(options?.sampleClusterIds !== undefined
      ? { clusterIds: options.sampleClusterIds }
      : {}),
    ...(options?.sourceKeys !== undefined ? { sourceKeys: options.sourceKeys } : {}),
  });
  result.examined = candidates.length;

  if (dryRun) {
    const first = candidates[0];
    if (first !== undefined) {
      const assembled = await assembleMacroContext(db, deps, first, nowFn());
      result.samplePrompt = prompt.buildUserPrompt(assembled.context);
    }
    logSweep(result, promptVersion);
    return result;
  }

  result.spentTodayUsd = await sumLlmSpendSince(db, utcDayStart(now));

  for (const candidate of candidates) {
    if (result.spentTodayUsd >= capUsd) {
      result.spendCapReached = true;
      break;
    }

    const assembled = await assembleMacroContext(db, deps, candidate, nowFn());
    const userPrompt = prompt.buildUserPrompt(assembled.context);
    const attemptKey = macroAttemptKey(
      candidate.clusterId,
      promptVersion,
      prompt.modelId,
      transport,
    );

    let outcome;
    try {
      outcome = await interpretMacro({
        systemPrompt: prompt.systemPrompt,
        userPrompt,
        modelId: prompt.modelId,
        maxTokens: prompt.maxTokens,
        effort: prompt.effort,
      });
    } catch (error) {
      // Transport/infrastructure: abort the pass, burn NO attempt.
      result.transportError = error instanceof Error ? error.message : String(error);
      break;
    }

    const analyzedAt = nowFn();
    const costUsd = computeCostUsd(prompt.modelId, outcome.usage);
    result.spentTodayUsd += costUsd;

    const blob: AuditBlob = {
      schemaVersion: 2,
      signalKey: attemptKey,
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
        signalKey: attemptKey,
        error: outcome.failure ?? 'unknown content failure',
        auditRef,
        at: analyzedAt,
      });
      result.failures += 1;
      continue;
    }

    const judgment = outcome.interpretation;
    const rows = macroSignalRows(judgment);

    if (rows.length === 0) {
      // `none` — a real, valuable answer. Booked as a TERMINAL attempt (at the
      // cap, not one below it) because there is no signal row to mark it done,
      // and without this the sweep would re-ask the same story and re-pay for
      // it on every pass forever.
      result.noMechanism += 1;
      await recordAttemptFailure(db, {
        signalKey: attemptKey,
        error: `no market mechanism (macro_event_type=${judgment.macro_event_type})`,
        auditRef,
        at: analyzedAt,
        attempts: MAX_ATTEMPTS,
      });
      continue;
    }

    let wroteAny = false;
    for (const row of rows) {
      const persisted = await persistSignal(db, {
        clusterId: candidate.clusterId,
        scope: row.scope,
        ...(row.sectorCode !== null ? { sectorCode: row.sectorCode } : {}),
        // The macro taxonomy is a separate vocabulary from EVENT_TYPES; it is
        // stamped into the same column because event_type is free text at the
        // DB level and the prompt_version tells a reader which vocabulary to
        // read it against.
        eventType: judgment.macro_event_type,
        direction: row.direction,
        expectedMoveBps: row.expectedMoveBps,
        horizon: judgment.horizon,
        alreadyExpected: judgment.already_expected,
        materiality: row.materiality,
        confidence: judgment.confidence,
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
        reasoning: judgment.reasoning,
        analyzedAt,
      });
      if (persisted.inserted) {
        result.rowsWritten += 1;
        wroteAny = true;
      } else {
        result.duplicates += 1;
      }
    }
    if (wroteAny) result.interpreted += 1;
  }

  logSweep(result, promptVersion);
  return result;
}

interface AssembledMacroContext {
  context: MacroInterpretContext;
  observedAt: Date;
  itemCountAsOf: number;
}

/**
 * Everything the model is shown, reconstructed as of
 * `min(anchor + INTERPRET_OBSERVATION_LAG_MS, now)` — the same observation lag
 * the company path uses, for the same reason.
 *
 * Without it a backfilled cluster would show its FINAL item count and every
 * item that ever joined, including those that arrived hours later. That is
 * look-ahead handed to the model in its own prompt: a story that turned out to
 * be big accumulates items, so the count itself leaks the outcome. The clamp to
 * `now` stops a cluster that arrived seconds ago being given a future view.
 */
async function assembleMacroContext(
  db: Db,
  deps: MacroSweepDeps,
  candidate: MacroCandidate,
  now: Date,
): Promise<AssembledMacroContext> {
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

  const promptItems = await Promise.all(
    itemRows.map(async (row) => {
      // Best-effort, exactly as on the company path: a missing or garbled blob
      // degrades to headline-only rather than failing the candidate. No filing
      // text is loaded — an unlinked macro cluster has no SEC filing by
      // construction, since a filing always resolves to its own filer.
      const payload = await deps.payloadStore.get(row.payloadRef).catch(() => null);
      const lede = payload === null ? null : extractLede(row.sourceKind, payload);
      return {
        sourceKey: row.sourceKey,
        headline: row.headline,
        lede,
        lagFromFirstMs: row.lagFromFirstMs,
        section: readSection(row.meta),
      };
    }),
  );

  return {
    context: {
      cluster: {
        canonicalHeadline: candidate.canonicalHeadline,
        firstReceivedAtIso: candidate.anchorTs.toISOString(),
        itemCount: counts.itemCount,
        distinctSourceCount: counts.distinctSourceCount,
      },
      items: promptItems,
    },
    observedAt,
    itemCountAsOf: counts.itemCount,
  };
}

/**
 * The publisher's own section label, when the adapter recorded one.
 *
 * Worth showing the model because it is the publisher's judgment about what
 * kind of story this is, made independently of ours — a business desk and a
 * culture desk filing the same words mean different things. Read defensively:
 * `meta` is adapter-shaped JSON, and only some adapters populate it.
 */
function readSection(meta: Record<string, unknown> | null | undefined): string | null {
  if (meta === null || meta === undefined) return null;
  const value = meta['sectionName'];
  return typeof value === 'string' && value.length > 0 ? value : null;
}

function logSweep(result: MacroSweepResult, promptVersion: string): void {
  console.log(
    JSON.stringify({
      level: 'info',
      msg: 'macro_interpret_sweep',
      promptVersion,
      ...result,
      samplePrompt: result.samplePrompt === null ? null : '(omitted)',
    }),
  );
}
