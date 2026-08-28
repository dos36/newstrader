import {
  DecideFeatures,
  QuoteSnapshot,
  RulesConfig,
  SignalInput,
  buildOrderIntent,
  computeRunMetrics,
  newId,
  withPortfolioFeatures,
} from '@newstrader/core';
import type { DecideFn, PortfolioFeatures, RunMetrics } from '@newstrader/core';
import { and, asc, eq, gte, inArray, isNotNull, isNull, lte } from 'drizzle-orm';

import type { Db } from '../client.js';
import { settleExitsUpTo } from '../backtest/exits.js';
import { BacktestLedger } from '../backtest/ledger.js';
import {
  decisions,
  instruments,
  llmSignals,
  newsClusters,
  replayRuns,
  rulesVersions,
} from '../schema.js';
import { NO_QUOTE_SKIP_REASON, loadDecisionQuote, roundSizedNotional } from './decide-repo.js';
import { persistRunMetrics } from './run-metrics-repo.js';
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
 * actually took IS the trajectory this replay reruns). It is UNSOUND for a
 * DIFFERENT label with the features reused verbatim: a stricter or looser
 * rules version would have opened/skipped a different set of positions along
 * the way, so live's openPositionsCount/equity are not what that label would
 * actually have seen.
 *
 * Mode B (options.simulatePortfolio, M5) closes exactly that gap using the
 * world/portfolio feature tagging in core (WORLD_FEATURE_KEYS /
 * PORTFOLIO_FEATURE_KEYS): WORLD features stay as snapshotted on the live
 * decision — they were true regardless of which rules ran — while the
 * PORTFOLIO slice is recomputed per decision from the run's OWN simulated
 * fills (a BacktestLedger driven by the production fill model, with exits
 * walked over recorded bars between decisions). The run's trades then produce
 * a replay_run_metrics row, the defined output of "compare rules v3 vs v7".
 * Without simulatePortfolio, a label mismatch still only warns
 * (mode_b_unsound_portfolio_features) rather than silently presenting
 * reused-portfolio results as trustworthy.
 */

export interface CreateReplayRunInput {
  rulesLabel: string;
  /** Inclusive llm_signals.analyzed_at window; null = unbounded on that side. */
  from: Date | null;
  to: Date | null;
  notes?: string | null;
  /** Reproducibility knobs (mode, starting cash, slippage) — recorded, not read back. */
  params?: Record<string, unknown>;
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
      params: input.params ?? {},
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

export interface SimulatePortfolioOptions {
  /** Default '100000.00'. */
  startingCashUsd?: string;
  /** Override the production fill model's slippage (bps). */
  slippageBps?: number;
}

/** Mode B output: what this run's own simulated portfolio did. */
export interface SimulatedPortfolioOutcome {
  metrics: RunMetrics;
  feesUsd: string;
  startingCashUsd: string;
  endingEquityUsd: string;
  /** Positions still open past the last decision + exit walk. */
  stillOpen: number;
}

export interface RunReplayOptions {
  replayRunId: string;
  /**
   * Present = Mode B: recompute portfolio features from this run's own
   * simulated fills and persist a replay_run_metrics row. Absent = Mode A
   * (bit-for-bit re-execution from live snapshots).
   */
  simulatePortfolio?: SimulatePortfolioOptions;
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
   * produced the reused live decisions AND the portfolio was NOT simulated —
   * see the Mode A/B note above runReplay. Always false in Mode B: simulating
   * the portfolio is exactly what makes a cross-label replay sound.
   */
  modeBUnsoundPortfolioFeatures: boolean;
  /** Mode B only; null in Mode A. */
  simulated: SimulatedPortfolioOutcome | null;
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
      and(
        eq(llmSignals.scope, 'company'),
        isNotNull(llmSignals.instrumentId),
        // Retrospective rows were interpreted with the news's outcome already
        // in the price history; they are quarantined from the live decide
        // queue for exactly that reason and must not enter replay P&L either.
        eq(llmSignals.retrospective, false),
        ...windowFilters,
      ),
    )
    .orderBy(asc(llmSignals.analyzedAt), asc(llmSignals.id));

  const totals: RunReplayTotals = {
    examined: signals.length,
    decided: 0,
    opens: 0,
    skips: 0,
    skippedNoSnapshot: 0,
    modeBUnsoundPortfolioFeatures: false,
    simulated: null,
  };
  if (signals.length === 0) {
    logTotals(run.id, totals);
    return totals;
  }

  const liveBySignal = await loadEarliestLiveDecisions(
    db,
    signals.map((signal) => signal.id),
  );

  if (options.simulatePortfolio !== undefined) {
    await runWithSimulatedPortfolio(db, deps, {
      run,
      config,
      signals,
      liveBySignal,
      totals,
      startingCashUsd: options.simulatePortfolio.startingCashUsd ?? '100000.00',
      ...(options.simulatePortfolio.slippageBps !== undefined
        ? { slippageBps: options.simulatePortfolio.slippageBps }
        : {}),
    });
    logTotals(run.id, totals);
    return totals;
  }

  // Mode A check (see the module header): the reused live decisions may
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
          // Same helper the live path uses — see roundSizedNotional's comment.
          sizedNotional:
            result.sizedNotional === undefined ? null : roundSizedNotional(result.sizedNotional),
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

// ------------------------------------------------- Mode B (simulated book) --

/** The signal slice the replay loop reads (matches runReplay's select). */
interface ReplaySignalRow {
  id: string;
  clusterId: string;
  instrumentId: string | null;
  assetClass: 'us_equity' | 'crypto';
  eventType: string;
  direction: 'bullish' | 'bearish' | 'neutral';
  expectedMoveBps: number;
  horizon: 'intraday' | '1d' | '3d' | '5d';
  alreadyExpected: boolean;
  materiality: number;
  confidence: number;
  anchorTs: Date;
}

/**
 * Mode B core: walk the live decisions in the order they were made, keeping a
 * simulated portfolio (production fill model, exits walked over recorded bars
 * between decisions). World features come from each decision's snapshot;
 * portfolio features come from the ledger — see the module header.
 *
 * Determinism note: re-invoking the same run id recomputes the identical
 * ledger (every input is stored), the decisions inserts all conflict
 * (decided stays 0), and the metrics insert conflicts too — a rerun is a
 * no-op, which is what makes it safe.
 */
async function runWithSimulatedPortfolio(
  db: Db,
  deps: ReplayDeps,
  input: {
    run: { id: string; rulesVersionId: string };
    config: RulesConfig;
    signals: ReplaySignalRow[];
    liveBySignal: Map<string, LiveDecisionRow>;
    totals: RunReplayTotals;
    startingCashUsd: string;
    slippageBps?: number;
  },
): Promise<void> {
  const { run, config, totals } = input;
  const ledger = new BacktestLedger({
    startingCashUsd: input.startingCashUsd,
    ...(input.slippageBps !== undefined ? { slippageBps: input.slippageBps } : {}),
  });
  const assetClassById = new Map<string, 'us_equity' | 'crypto'>();
  for (const signal of input.signals) {
    if (signal.instrumentId !== null) assetClassById.set(signal.instrumentId, signal.assetClass);
  }

  // Portfolio causality demands LIVE DECISION order, not analyzed_at order:
  // the book at decision N is the product of decisions 1..N−1 as they were
  // actually sequenced.
  const pairs = input.signals
    .flatMap((signal) => {
      const live = input.liveBySignal.get(signal.id);
      if (live === undefined) {
        totals.skippedNoSnapshot += 1;
        return [];
      }
      if (signal.instrumentId === null) return []; // unreachable: isNotNull filter
      return [{ signal: { ...signal, instrumentId: signal.instrumentId }, live }];
    })
    .sort(
      (a, b) =>
        a.live.decidedAt.getTime() - b.live.decidedAt.getTime() ||
        a.signal.id.localeCompare(b.signal.id),
    );

  for (const { signal, live } of pairs) {
    // Advance the world to this instant BEFORE deciding, exactly as the
    // backtest does: an exit that fired earlier must already have freed its
    // position slot and returned its cash.
    await settleExitsUpTo(db, ledger, assetClassById, config.exits, live.decidedAt);
    const portfolio = await ledgerPortfolioFeatures(
      db,
      ledger,
      signal.instrumentId,
      live.decidedAt,
    );

    const decisionKey = `${signal.id}:${run.rulesVersionId}:${run.id}`;
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

    // Even a verbatim no-quote skip gets THIS run's portfolio state stamped
    // into its features — the row must describe what this run saw.
    const features = withPortfolioFeatures(DecideFeatures.parse(live.features), portfolio);

    let action: DecisionSlice['action'];
    let inserted: { id: string }[];
    if (live.skipReason === NO_QUOTE_SKIP_REASON) {
      // No quote existed at decision time — a data fact, not a rules outcome.
      action = live.action;
      inserted = await db
        .insert(decisions)
        .values({
          ...base,
          action: live.action,
          skipReason: live.skipReason,
          gates: live.gates,
          features,
          quoteSnapshot: live.quoteSnapshot,
          sizedQty: live.sizedQty,
          sizedNotional: live.sizedNotional,
        })
        .onConflictDoNothing({ target: decisions.decisionKey })
        .returning({ id: decisions.id });
    } else {
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
          sizedNotional:
            result.sizedNotional === undefined ? null : roundSizedNotional(result.sizedNotional),
        })
        .onConflictDoNothing({ target: decisions.decisionKey })
        .returning({ id: decisions.id });

      if (
        (result.action === 'open_long' || result.action === 'open_short') &&
        result.sizedQty !== undefined
      ) {
        // Fill regardless of insert conflict (see the determinism note): the
        // ledger must replay the same trajectory on a rerun.
        const intent = buildOrderIntent({
          decisionKey,
          instrumentId: signal.instrumentId,
          assetClass: signal.assetClass,
          action: result.action,
          qty: result.sizedQty,
        });
        ledger.fillOpen({
          intent,
          referencePrice: quote.price,
          at: live.decidedAt,
          signalId: signal.id,
          horizon: signal.horizon,
          atrAtEntry: features.atr,
        });
      }
    }

    if (inserted.length === 0) continue; // rerun of the same replay run
    totals.decided += 1;
    if (action === 'skip') totals.skips += 1;
    if (action === 'open_long' || action === 'open_short') totals.opens += 1;
  }

  // Walk whatever is still open past the last decision, so a late trade still
  // meets its stop or time stop rather than vanishing from the metrics.
  await settleExitsUpTo(db, ledger, assetClassById, config.exits, null);

  const trades = ledger.trades();
  const metrics = computeRunMetrics(trades, { startingCashUsd: input.startingCashUsd });
  const outcome: SimulatedPortfolioOutcome = {
    metrics,
    feesUsd: ledger.totalFeesUsd(),
    startingCashUsd: input.startingCashUsd,
    endingEquityUsd: ledger.accountState(new Map()).equityUsd,
    stillOpen: ledger.openPositions().length,
  };
  await persistRunMetrics(db, run.id, {
    ...metrics,
    feesUsd: outcome.feesUsd,
    startingCashUsd: outcome.startingCashUsd,
    endingEquityUsd: outcome.endingEquityUsd,
    stillOpen: outcome.stillOpen,
  });
  totals.simulated = outcome;
}

/**
 * The PORTFOLIO feature slice as this run's ledger sees it at `at`. Equity
 * marks come from the same decision-time quote loader the live path uses; a
 * position with no quote falls back to entry price inside the ledger.
 */
async function ledgerPortfolioFeatures(
  db: Db,
  ledger: BacktestLedger,
  instrumentId: string,
  at: Date,
): Promise<PortfolioFeatures> {
  const marks = new Map<string, string>();
  for (const position of ledger.openPositions()) {
    const quote = await loadDecisionQuote(db, position.instrumentId, at);
    if (quote !== null) marks.set(position.instrumentId, quote.price);
  }
  return {
    openPositionsCount: ledger.openPositions().length,
    hasOpenPositionForInstrument: ledger.openPosition(instrumentId) !== undefined,
    paperEquityUsd: ledger.accountState(marks).equityUsd,
  };
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
