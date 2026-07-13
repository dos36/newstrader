import { DecideFeatures, QuoteSnapshot, RulesConfig, SignalInput, newId } from '@newstrader/core';
import type { DecideFn } from '@newstrader/core';
import { and, asc, eq, gte, inArray, isNotNull, isNull, lte } from 'drizzle-orm';

import type { Db } from '../client.js';
import {
  decisions,
  instruments,
  llmSignals,
  newsClusters,
  replayRuns,
  rulesVersions,
} from '../schema.js';
import { NO_QUOTE_SKIP_REASON } from './decide-repo.js';
import { getRulesVersion } from './rules-repo.js';

/**
 * Replay over the stored signal log — v1 replay contract (architecture §5.4
 * Mode A): re-execute the pure decide() from the features / quote_snapshot
 * SNAPSHOTTED on each signal's LIVE decision, never from live queries.
 * Signals in the window without a live decision have no snapshot to replay
 * from and are counted (skippedNoSnapshot), never fabricated.
 *
 * REGRESSION property: replaying the SAME rules version over live history
 * must reproduce every live action bit-for-bit (CI-tested).
 *
 * Mode A vs Mode B honesty: the reused features include PORTFOLIO state
 * (openPositionsCount, hasOpenPositionForInstrument, paperEquityUsd) as it
 * actually was in the LIVE run, never recomputed for the replay's own rules
 * version. That is sound for Mode A (replaying the SAME label the live
 * decisions were produced under — the portfolio trajectory the live run
 * actually took IS the trajectory this replay reruns). It is quietly
 * UNSOUND for Mode B (replaying a DIFFERENT label): a stricter or looser
 * rules version would have opened/skipped a different set of positions
 * along the way, so live's openPositionsCount/equity are not what this
 * label would actually have seen. runReplay does not simulate a
 * counterfactual portfolio (out of scope for v1) — it detects the mismatch
 * and emits a structured warning (mode_b_unsound_portfolio_features)
 * instead of silently presenting Mode-B results as trustworthy.
 */

export interface CreateReplayRunInput {
  rulesLabel: string;
  /** Inclusive llm_signals.analyzed_at window; null = unbounded on that side. */
  from: Date | null;
  to: Date | null;
  notes?: string | null;
}

export interface ReplayRun {
  id: string;
  rulesVersionId: string;
  signalsFrom: Date | null;
  signalsTo: Date | null;
}

export async function createReplayRun(db: Db, input: CreateReplayRunInput): Promise<ReplayRun> {
  const rules = await getRulesVersion(db, input.rulesLabel);
  const rows = await db
    .insert(replayRuns)
    .values({
      id: newId(),
      rulesVersionId: rules.id,
      params: {},
      signalsFrom: input.from,
      signalsTo: input.to,
      notes: input.notes ?? null,
    })
    .returning({
      id: replayRuns.id,
      rulesVersionId: replayRuns.rulesVersionId,
      signalsFrom: replayRuns.signalsFrom,
      signalsTo: replayRuns.signalsTo,
    });
  const row = rows[0];
  if (row === undefined) throw new Error('createReplayRun: insert returned no row');
  return row;
}

/**
 * The rules label a replay run executed under — used by the CLI to default
 * `replay:compare --live-rules` to "the run's own label" when one side of the
 * comparison is 'live'.
 */
export async function getReplayRunRulesLabel(db: Db, replayRunId: string): Promise<string> {
  const rows = await db
    .select({ label: rulesVersions.versionLabel })
    .from(replayRuns)
    .innerJoin(rulesVersions, eq(rulesVersions.id, replayRuns.rulesVersionId))
    .where(eq(replayRuns.id, replayRunId));
  const row = rows[0];
  if (row === undefined) {
    throw new Error(`getReplayRunRulesLabel: no replay run with id "${replayRunId}"`);
  }
  return row.label;
}

export interface ReplayDeps {
  /** The pure engine — the same injection seam the live driver uses. */
  decide: DecideFn;
}

export interface RunReplayOptions {
  replayRunId: string;
}

export interface RunReplayTotals {
  /** Company-scope signals inside the run's window. */
  examined: number;
  /** Replay decisions rows actually inserted (rerun = conflict, not counted). */
  decided: number;
  opens: number;
  skips: number;
  /** Signals with NO live decision — nothing snapshotted, nothing fabricated. */
  skippedNoSnapshot: number;
  /**
   * true when this run's rules label differs from (any of) the label(s) that
   * produced the reused live decisions — see the Mode A/B note above runReplay.
   */
  modeBUnsoundPortfolioFeatures: boolean;
}

export async function runReplay(
  db: Db,
  deps: ReplayDeps,
  options: RunReplayOptions,
): Promise<RunReplayTotals> {
  const runRows = await db
    .select({
      id: replayRuns.id,
      rulesVersionId: replayRuns.rulesVersionId,
      signalsFrom: replayRuns.signalsFrom,
      signalsTo: replayRuns.signalsTo,
    })
    .from(replayRuns)
    .where(eq(replayRuns.id, options.replayRunId));
  const run = runRows[0];
  if (run === undefined) {
    throw new Error(`runReplay: no replay run with id "${options.replayRunId}"`);
  }

  const configRows = await db
    .select({ config: rulesVersions.config })
    .from(rulesVersions)
    .where(eq(rulesVersions.id, run.rulesVersionId));
  const configRow = configRows[0];
  if (configRow === undefined) {
    throw new Error(
      `runReplay: replay run ${run.id} references missing rules ${run.rulesVersionId}`,
    );
  }
  const config = RulesConfig.parse(configRow.config);

  const windowFilters = [
    ...(run.signalsFrom !== null ? [gte(llmSignals.analyzedAt, run.signalsFrom)] : []),
    ...(run.signalsTo !== null ? [lte(llmSignals.analyzedAt, run.signalsTo)] : []),
  ];
  const signals = await db
    .select({
      id: llmSignals.id,
      clusterId: llmSignals.clusterId,
      instrumentId: llmSignals.instrumentId,
      assetClass: instruments.assetClass,
      eventType: llmSignals.eventType,
      direction: llmSignals.direction,
      expectedMoveBps: llmSignals.expectedMoveBps,
      horizon: llmSignals.horizon,
      alreadyExpected: llmSignals.alreadyExpected,
      materiality: llmSignals.materiality,
      confidence: llmSignals.confidence,
      anchorTs: newsClusters.firstReceivedAt,
    })
    .from(llmSignals)
    .innerJoin(newsClusters, eq(newsClusters.id, llmSignals.clusterId))
    .innerJoin(instruments, eq(instruments.id, llmSignals.instrumentId))
    .where(
      and(eq(llmSignals.scope, 'company'), isNotNull(llmSignals.instrumentId), ...windowFilters),
    )
    .orderBy(asc(llmSignals.analyzedAt), asc(llmSignals.id));

  const totals: RunReplayTotals = {
    examined: signals.length,
    decided: 0,
    opens: 0,
    skips: 0,
    skippedNoSnapshot: 0,
    modeBUnsoundPortfolioFeatures: false,
  };
  if (signals.length === 0) {
    logTotals(run.id, totals);
    return totals;
  }

  const liveBySignal = await loadEarliestLiveDecisions(
    db,
    signals.map((signal) => signal.id),
  );

  // Mode A/B check (see the module header): the reused live decisions may
  // have been produced under a DIFFERENT rules version than this replay run.
  const liveRulesVersionIds = new Set(
    [...liveBySignal.values()].map((live) => live.rulesVersionId),
  );
  totals.modeBUnsoundPortfolioFeatures =
    liveRulesVersionIds.size > 0 &&
    (liveRulesVersionIds.size > 1 || !liveRulesVersionIds.has(run.rulesVersionId));
  if (totals.modeBUnsoundPortfolioFeatures) {
    const labelRows = await db
      .select({ id: rulesVersions.id, label: rulesVersions.versionLabel })
      .from(rulesVersions)
      .where(inArray(rulesVersions.id, [run.rulesVersionId, ...liveRulesVersionIds]));
    const labelById = new Map(labelRows.map((row) => [row.id, row.label]));
    console.warn(
      JSON.stringify({
        level: 'warn',
        msg: 'mode_b_unsound_portfolio_features',
        replayRunId: run.id,
        replayRulesLabel: labelById.get(run.rulesVersionId) ?? run.rulesVersionId,
        liveRulesLabels: [...liveRulesVersionIds].map((id) => labelById.get(id) ?? id),
      }),
    );
  }

  for (const signal of signals) {
    const live = liveBySignal.get(signal.id);
    if (live === undefined) {
      totals.skippedNoSnapshot += 1;
      continue;
    }
    if (signal.instrumentId === null) continue; // unreachable: isNotNull filter above

    const decisionKey = `${signal.id}:${run.rulesVersionId}:${run.id}`;
    // Replay rows keep the live decidedAt: replay is a re-derivation of that
    // moment's decision, and reusing the stored instant keeps this function
    // clock-free (nothing here reads Date.now()).
    const base = {
      id: newId(),
      decisionKey,
      signalId: signal.id,
      instrumentId: signal.instrumentId,
      rulesVersionId: run.rulesVersionId,
      replayRunId: run.id,
      decidedAt: live.decidedAt,
      suppressed: false,
    };

    let action: DecisionSlice['action'];
    let inserted: { id: string }[];
    if (live.skipReason === NO_QUOTE_SKIP_REASON) {
      // No quote existed at decision time — a data fact, not a rules outcome.
      // Reproduce the stored skip verbatim under any rules version.
      action = live.action;
      inserted = await db
        .insert(decisions)
        .values({
          ...base,
          action: live.action,
          skipReason: live.skipReason,
          gates: live.gates,
          features: live.features,
          quoteSnapshot: live.quoteSnapshot,
          sizedQty: live.sizedQty,
          sizedNotional: live.sizedNotional,
        })
        .onConflictDoNothing({ target: decisions.decisionKey })
        .returning({ id: decisions.id });
    } else {
      const features = DecideFeatures.parse(live.features);
      const quote = QuoteSnapshot.parse(live.quoteSnapshot);
      const signalInput = SignalInput.parse({
        id: signal.id,
        clusterId: signal.clusterId,
        instrumentId: signal.instrumentId,
        assetClass: signal.assetClass,
        eventType: signal.eventType,
        direction: signal.direction,
        expectedMoveBps: signal.expectedMoveBps,
        horizon: signal.horizon,
        alreadyExpected: signal.alreadyExpected,
        materiality: signal.materiality,
        confidence: signal.confidence,
        anchorTs: signal.anchorTs.toISOString(),
      });
      const result = deps.decide(signalInput, features, quote, config);
      action = result.action;
      inserted = await db
        .insert(decisions)
        .values({
          ...base,
          action: result.action,
          skipReason: result.skipReason ?? null,
          gates: result.gates,
          features,
          quoteSnapshot: quote,
          sizedQty: result.sizedQty ?? null,
          sizedNotional: result.sizedNotional ?? null,
        })
        .onConflictDoNothing({ target: decisions.decisionKey })
        .returning({ id: decisions.id });
    }
    if (inserted.length === 0) continue; // rerun of the same replay run

    totals.decided += 1;
    if (action === 'skip') totals.skips += 1;
    if (action === 'open_long' || action === 'open_short') totals.opens += 1;
  }

  logTotals(run.id, totals);
  return totals;
}

// ----------------------------------------------------------------- compare --

/** A replay_runs id, or the literal 'live' for live paper decisions. */
export type RunRef = string;

export const LIVE_RUN: RunRef = 'live';

export interface DecisionSlice {
  signalId: string;
  action: 'open_long' | 'open_short' | 'close' | 'skip';
  skipReason: string | null;
  sizedQty: string | null;
  sizedNotional: string | null;
}

export type DivergenceReason = 'action_changed' | 'size_changed' | 'skip_reason_changed';

export interface DecisionDivergence {
  signalId: string;
  reasons: DivergenceReason[];
  a: DecisionSlice;
  b: DecisionSlice;
}

export interface CompareRunsResult {
  summary: {
    /** Signals decided in BOTH runs. */
    total: number;
    matched: number;
    actionChanged: number;
    sizeChanged: number;
    skipReasonChanged: number;
    onlyInA: number;
    onlyInB: number;
  };
  divergences: DecisionDivergence[];
}

export interface CompareRunsOptions {
  runA: RunRef;
  runB: RunRef;
  /**
   * Required whenever either side is 'live': live decisions span every rules
   * version that ever decided a signal (loadRunDecisions dedupes only by
   * signal, earliest decidedAt wins), so an unscoped 'live' side can mix
   * decisions from several rules versions — this pins it to exactly one.
   */
  liveRulesVersionId?: string;
}

/**
 * Per-signal join of two runs' decisions ('live' = live paper rows). Reports
 * every signal whose action, size, or skip reason changed, plus summary
 * counts — "compare rules v3 vs v7" with a defined output (architecture §5.4).
 */
export async function compareRuns(db: Db, options: CompareRunsOptions): Promise<CompareRunsResult> {
  if (
    (options.runA === LIVE_RUN || options.runB === LIVE_RUN) &&
    options.liveRulesVersionId === undefined
  ) {
    throw new Error("compareRuns: liveRulesVersionId is required when comparing the 'live' side");
  }
  const [aBySignal, bBySignal] = await Promise.all([
    loadRunDecisions(db, options.runA, options.liveRulesVersionId),
    loadRunDecisions(db, options.runB, options.liveRulesVersionId),
  ]);

  const result: CompareRunsResult = {
    summary: {
      total: 0,
      matched: 0,
      actionChanged: 0,
      sizeChanged: 0,
      skipReasonChanged: 0,
      onlyInA: 0,
      onlyInB: 0,
    },
    divergences: [],
  };

  for (const [signalId, a] of aBySignal) {
    const b = bBySignal.get(signalId);
    if (b === undefined) {
      result.summary.onlyInA += 1;
      continue;
    }
    result.summary.total += 1;

    const reasons: DivergenceReason[] = [];
    if (a.action !== b.action) reasons.push('action_changed');
    if (
      !decimalEquals(a.sizedQty, b.sizedQty) ||
      !decimalEquals(a.sizedNotional, b.sizedNotional)
    ) {
      reasons.push('size_changed');
    }
    if (a.skipReason !== b.skipReason) reasons.push('skip_reason_changed');

    if (reasons.length === 0) {
      result.summary.matched += 1;
      continue;
    }
    if (reasons.includes('action_changed')) result.summary.actionChanged += 1;
    if (reasons.includes('size_changed')) result.summary.sizeChanged += 1;
    if (reasons.includes('skip_reason_changed')) result.summary.skipReasonChanged += 1;
    result.divergences.push({ signalId, reasons, a, b });
  }
  for (const signalId of bBySignal.keys()) {
    if (!aBySignal.has(signalId)) result.summary.onlyInB += 1;
  }
  return result;
}

// --------------------------------------------------------------- internals --

interface LiveDecisionRow {
  decidedAt: Date;
  action: 'open_long' | 'open_short' | 'close' | 'skip';
  skipReason: string | null;
  gates: unknown[];
  features: Record<string, unknown>;
  quoteSnapshot: Record<string, unknown>;
  sizedQty: string | null;
  sizedNotional: string | null;
  /** The rules version that PRODUCED this live decision — feeds the Mode A/B check. */
  rulesVersionId: string;
}

/**
 * Earliest live decision per signal (decided_at asc, id asc). More than one
 * live rules version can have decided the same signal; the earliest snapshot
 * is the canonical "what the world looked like" record.
 */
async function loadEarliestLiveDecisions(
  db: Db,
  signalIds: string[],
): Promise<Map<string, LiveDecisionRow>> {
  const rows = await db
    .select({
      signalId: decisions.signalId,
      decidedAt: decisions.decidedAt,
      action: decisions.action,
      skipReason: decisions.skipReason,
      gates: decisions.gates,
      features: decisions.features,
      quoteSnapshot: decisions.quoteSnapshot,
      sizedQty: decisions.sizedQty,
      sizedNotional: decisions.sizedNotional,
      rulesVersionId: decisions.rulesVersionId,
    })
    .from(decisions)
    .where(and(inArray(decisions.signalId, signalIds), isNull(decisions.replayRunId)))
    .orderBy(asc(decisions.decidedAt), asc(decisions.id));

  const bySignal = new Map<string, LiveDecisionRow>();
  for (const row of rows) {
    if (row.signalId === null || bySignal.has(row.signalId)) continue;
    const { signalId, ...decision } = row;
    bySignal.set(signalId, decision);
  }
  return bySignal;
}

async function loadRunDecisions(
  db: Db,
  ref: RunRef,
  liveRulesVersionId: string | undefined,
): Promise<Map<string, DecisionSlice>> {
  const runFilter =
    ref === LIVE_RUN
      ? and(
          isNull(decisions.replayRunId),
          eq(decisions.rulesVersionId, requireLive(liveRulesVersionId)),
        )
      : eq(decisions.replayRunId, ref);
  const rows = await db
    .select({
      signalId: decisions.signalId,
      action: decisions.action,
      skipReason: decisions.skipReason,
      sizedQty: decisions.sizedQty,
      sizedNotional: decisions.sizedNotional,
    })
    .from(decisions)
    .where(and(isNotNull(decisions.signalId), runFilter))
    .orderBy(asc(decisions.decidedAt), asc(decisions.id));

  const bySignal = new Map<string, DecisionSlice>();
  for (const row of rows) {
    if (row.signalId === null || bySignal.has(row.signalId)) continue;
    bySignal.set(row.signalId, { ...row, signalId: row.signalId });
  }
  return bySignal;
}

/** Defense in depth: compareRuns already throws before reaching here without this. */
function requireLive(liveRulesVersionId: string | undefined): string {
  if (liveRulesVersionId === undefined) {
    throw new Error("loadRunDecisions: liveRulesVersionId is required for the 'live' side");
  }
  return liveRulesVersionId;
}

/**
 * Numeric-string equality that survives numeric-column canonicalization
 * ('1.5' stored in numeric(20,8) reads back '1.50000000').
 */
function decimalEquals(a: string | null, b: string | null): boolean {
  if (a === null || b === null) return a === b;
  return trimDecimal(a) === trimDecimal(b);
}

function trimDecimal(value: string): string {
  if (!value.includes('.')) return value;
  const trimmed = value.replace(/0+$/, '').replace(/\.$/, '');
  return trimmed === '' || trimmed === '-' ? '0' : trimmed;
}

function logTotals(replayRunId: string, totals: RunReplayTotals): void {
  console.log(JSON.stringify({ level: 'info', msg: 'replay_run', replayRunId, ...totals }));
}
