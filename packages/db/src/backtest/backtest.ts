import {
  buildOrderIntent,
  computeRunMetrics,
  CURRENT_PROMPT_VERSION,
  newId,
  SignalInput,
  type DecideFn,
  type GateResult,
  type QuoteSnapshot,
  type DecideFeatures,
  type RunMetrics,
} from '@newstrader/core';
import { and, asc, eq, gte, inArray, isNotNull, lte } from 'drizzle-orm';

import type { Db } from '../client.js';
import { decisions, instruments, llmSignals, newsClusters, replayRuns } from '../schema.js';
import type { LlmTransport } from '../shared-constants.js';
import { loadScheduledEventWindow } from '../calendar/calendar-repo.js';
import { getRulesVersion } from '../trading/rules-repo.js';
import { persistRunMetrics } from '../trading/run-metrics-repo.js';
import {
  assembleFeatures,
  loadDecisionQuote,
  type FeatureContext,
} from '../trading/decide-repo.js';
import type { UndecidedSignal } from '../trading/signals-repo.js';
import { settleExitsUpTo } from './exits.js';
import { BacktestLedger, type ClosedTrade } from './ledger.js';

/**
 * Backtest mode — replay the DECISION path over historical signals that never
 * had a live decision, and report the P&L it would have produced.
 *
 * This is not `runReplay`. Replay re-executes the engine from a stored
 * `quote_snapshot` on a decision that actually happened; it answers "what would
 * other rules have done to trades we made". A backfilled signal has no such
 * snapshot, so a backtest must RECONSTRUCT the decision inputs, and every
 * reconstructed input is a chance to leak the future.
 *
 * ── The as-of contract. Read this before changing anything here. ─────────────
 *
 * Reconstructed as of `decisionAt`, never `new Date()`:
 *   • quote            loadDecisionQuote(instrument, decisionAt) — bounded ≤ it
 *   • itemsPerHour     trailing hour ENDING at decisionAt
 *   • calendarMatch    events within tolerance of the cluster anchor
 *   • priceMove        anchor close → the decisionAt quote
 *   • ATR, $volume     daily bars with ts ≤ decisionAt
 *   • positions/equity this run's own earlier fills — causally prior by
 *                      construction, since the loop walks time forward
 *
 * Taken frozen from the signal row (what the model actually saw):
 *   • clusterItemCount, distinctSourceCount, and every interpretation field
 *
 * FORBIDDEN, and each one has drawn blood in this pipeline already:
 *   • `analyzed_at` as a time reference. For a backfilled row it is TODAY, not
 *     when the news broke. Using it would date every decision to the backfill.
 *   • any unbounded price query. The feature assembler is shared with the live
 *     path precisely so this stays one place to get right.
 *   • reading a bar to decide an exit before the loop has reached that bar.
 *
 * `decisionAt` = cluster anchor + pipelineLagMs. It is NOT the anchor: the live
 * system cannot decide at the instant news lands. Interpretation runs on a
 * 5-minute sweep and decisions on another, so the default 10 minutes is the
 * pessimistic end of the real pipeline latency. Shortening it makes results
 * better and less true.
 *
 * ── Known limitations, stated because a backtest that hides them lies ───────
 *
 *   1. Exits are evaluated at BAR CLOSE. A stop pierced intrabar fills at the
 *      close of the bar that pierced it, not at the stop level, so a violent
 *      bar exits at a worse price than a real stop would — pessimistic for
 *      longs in a crash, optimistic when price snaps back. Modelling the fill
 *      at the stop level needs high/low logic outside the pure exit rule.
 *   2. No borrow cost, financing, or dividends. Shorts are free to hold.
 *   3. Fills assume the full sized quantity trades at one price. The liquidity
 *      gate bounds size against median dollar volume, but there is no partial
 *      fill or market-impact model.
 *   4. Equity marks use the last bar ≤ the decision instant; a position whose
 *      instrument has no recent bar is marked at entry, which under-states.
 */

const DEFAULT_PIPELINE_LAG_MS = 10 * 60_000;
const HOUR_MS = 3_600_000;

export interface BacktestDeps {
  decide: DecideFn;
  engineVersion: string;
}

export interface BacktestOptions {
  rulesLabel: string;
  /** Cluster-anchor window. Both bounds optional. */
  from?: Date;
  to?: Date;
  /** Which interpretation rows to trade. Defaults to the current prompt version. */
  promptVersions?: string[];
  /**
   * Defaults to ['api']. 'cli' rows did not honour their prompt version's
   * effort or max_tokens, so including them mixes contracts.
   */
  transports?: LlmTransport[];
  startingCashUsd?: string;
  pipelineLagMs?: number;
  /** Persist the decisions under a replay_runs row. Default true. */
  persist?: boolean;
  slippageBps?: number;
}

export interface BacktestResult {
  runId: string | null;
  rulesLabel: string;
  examined: number;
  decided: number;
  opens: number;
  skips: number;
  noQuote: number;
  /** Top skip reasons, most frequent first — where the funnel actually stops. */
  skipReasons: Array<{ reason: string; count: number }>;
  trades: number;
  wins: number;
  losses: number;
  realizedUsd: string;
  feesUsd: string;
  startingCashUsd: string;
  endingEquityUsd: string;
  /** Positions still open when the window ended (excluded from realized P&L). */
  stillOpen: number;
  firstDecisionAt: string | null;
  lastDecisionAt: string | null;
  closedTrades: ClosedTrade[];
  /**
   * Per-run trade metrics (replay_run_metrics). Computed whenever the run
   * closed at least the possibility of trades; persisted only when the run
   * itself was persisted (runId non-null).
   */
  metrics: RunMetrics | null;
}

interface BacktestSignal extends UndecidedSignal {
  decisionAt: Date;
}

/** Signals eligible to trade, ordered by the instant the pipeline could have decided. */
export async function loadBacktestSignals(
  db: Db,
  options: {
    from?: Date;
    to?: Date;
    promptVersions: string[];
    transports: LlmTransport[];
    pipelineLagMs: number;
  },
): Promise<BacktestSignal[]> {
  const rows = await db
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
      analyzedAt: llmSignals.analyzedAt,
      clusterItemCount: llmSignals.clusterItemCountAtAnalysis,
      clusterDistinctSourceCount: newsClusters.distinctSourceCount,
    })
    .from(llmSignals)
    .innerJoin(newsClusters, eq(newsClusters.id, llmSignals.clusterId))
    .innerJoin(instruments, eq(instruments.id, llmSignals.instrumentId))
    .where(
      and(
        eq(llmSignals.scope, 'company'),
        isNotNull(llmSignals.instrumentId),
        inArray(llmSignals.promptVersion, options.promptVersions),
        inArray(llmSignals.transport, options.transports),
        ...(options.from !== undefined ? [gte(newsClusters.firstReceivedAt, options.from)] : []),
        ...(options.to !== undefined ? [lte(newsClusters.firstReceivedAt, options.to)] : []),
      ),
    )
    // Anchor order, NOT analyzed_at: for a backfilled row analyzed_at is the
    // day the backfill ran, so ordering by it would process a year of news in
    // whatever sequence the LLM happened to be called.
    .orderBy(asc(newsClusters.firstReceivedAt), asc(llmSignals.id));

  return rows.flatMap((row) => {
    if (row.instrumentId === null) return [];
    return [
      {
        ...row,
        instrumentId: row.instrumentId,
        clusterItemCount: row.clusterItemCount ?? 0,
        decisionAt: new Date(row.anchorTs.getTime() + options.pipelineLagMs),
      },
    ];
  });
}

export async function runBacktest(
  db: Db,
  deps: BacktestDeps,
  options: BacktestOptions,
): Promise<BacktestResult> {
  const rules = await getRulesVersion(db, options.rulesLabel);
  const pipelineLagMs = options.pipelineLagMs ?? DEFAULT_PIPELINE_LAG_MS;
  const startingCashUsd = options.startingCashUsd ?? '100000.00';
  const transports = options.transports ?? ['api'];
  const promptVersions = options.promptVersions ?? [CURRENT_PROMPT_VERSION];

  const signals = await loadBacktestSignals(db, {
    ...(options.from !== undefined ? { from: options.from } : {}),
    ...(options.to !== undefined ? { to: options.to } : {}),
    promptVersions,
    transports,
    pipelineLagMs,
  });

  const ledger = new BacktestLedger({
    startingCashUsd,
    ...(options.slippageBps !== undefined ? { slippageBps: options.slippageBps } : {}),
  });
  const assetClassById = new Map(signals.map((s) => [s.instrumentId, s.assetClass]));

  const result: BacktestResult = {
    runId: null,
    rulesLabel: rules.label,
    examined: signals.length,
    decided: 0,
    opens: 0,
    skips: 0,
    noQuote: 0,
    skipReasons: [],
    trades: 0,
    wins: 0,
    losses: 0,
    realizedUsd: '0.00',
    feesUsd: '0.00',
    startingCashUsd,
    endingEquityUsd: startingCashUsd,
    stillOpen: 0,
    firstDecisionAt: null,
    lastDecisionAt: null,
    closedTrades: [],
    metrics: null,
  };
  if (signals.length === 0) {
    logBacktest(result);
    return result;
  }

  const runId = options.persist === false ? null : await createBacktestRun(db, rules.id, options);
  result.runId = runId;

  const anchors = signals.map((s) => s.anchorTs.getTime());
  const events = await loadScheduledEventWindow(db, {
    from: new Date(Math.min(...anchors) - HOUR_MS),
    to: new Date(Math.max(...anchors) + HOUR_MS),
  });

  const skipCounts = new Map<string, number>();
  result.firstDecisionAt = signals[0]?.decisionAt.toISOString() ?? null;

  for (const signal of signals) {
    // Advance the world to this instant BEFORE deciding: any position whose
    // exit triggered earlier must already be closed, or the portfolio gates
    // (open count, existing position) see a state that never existed.
    await settleExitsUpTo(db, ledger, assetClassById, rules.config.exits, signal.decisionAt);

    const quote = await loadDecisionQuote(db, signal.instrumentId, signal.decisionAt);
    const marks = new Map<string, string>();
    for (const position of ledger.openPositions()) {
      const mark = await loadDecisionQuote(db, position.instrumentId, signal.decisionAt);
      if (mark !== null) marks.set(position.instrumentId, mark.price);
    }
    const positions = ledger.positions();
    const account = ledger.accountState(marks);

    const ctx: FeatureContext = {
      now: signal.decisionAt,
      events,
      positions,
      account,
      engineVersion: deps.engineVersion,
      atrLookbackDays: rules.config.sizing.atrLookbackDays,
      openedThisBatch: new Set<string>(),
      opensThisBatch: () => 0,
    };
    const features = await assembleFeatures(db, signal, quote, ctx);

    result.decided += 1;
    result.lastDecisionAt = signal.decisionAt.toISOString();

    if (quote === null) {
      result.noQuote += 1;
      result.skips += 1;
      bump(skipCounts, 'no_quote');
      if (runId !== null) {
        await persistDecision(db, {
          runId,
          rulesVersionId: rules.id,
          signal,
          features,
          quote: null,
          action: 'skip',
          skipReason: 'no_quote',
          gates: [],
          sizedQty: null,
          sizedNotional: null,
        });
      }
      continue;
    }

    const outcome = deps.decide(toSignalInput(signal), features, quote, rules.config);
    if (runId !== null) {
      await persistDecision(db, {
        runId,
        rulesVersionId: rules.id,
        signal,
        features,
        quote,
        action: outcome.action,
        skipReason: outcome.skipReason ?? null,
        gates: outcome.gates,
        sizedQty: outcome.sizedQty ?? null,
        sizedNotional: outcome.sizedNotional ?? null,
      });
    }

    if (outcome.action === 'skip') {
      result.skips += 1;
      bump(skipCounts, outcome.skipReason ?? 'unknown');
      continue;
    }
    if (outcome.action !== 'open_long' && outcome.action !== 'open_short') continue;
    if (outcome.sizedQty === undefined) continue;

    result.opens += 1;
    const intent = buildOrderIntent({
      decisionKey: `${signal.id}:${rules.id}:backtest`,
      instrumentId: signal.instrumentId,
      assetClass: signal.assetClass,
      action: outcome.action,
      qty: outcome.sizedQty,
    });
    ledger.fillOpen({
      intent,
      referencePrice: quote.price,
      at: signal.decisionAt,
      signalId: signal.id,
      horizon: signal.horizon,
      atrAtEntry: features.atr,
    });
  }

  // Walk whatever is still open past the last decision, so a trade opened near
  // the end still gets its stop or time stop rather than vanishing.
  await settleExitsUpTo(db, ledger, assetClassById, rules.config.exits, null);

  const trades = ledger.trades();
  result.closedTrades = trades;
  result.trades = trades.length;
  result.wins = trades.filter((t) => Number(t.realizedUsd) > 0).length;
  result.losses = trades.filter((t) => Number(t.realizedUsd) < 0).length;
  result.realizedUsd = trades.reduce((sum, t) => sum + Number(t.realizedUsd), 0).toFixed(2);
  result.feesUsd = ledger.totalFeesUsd();
  result.stillOpen = ledger.openPositions().length;
  result.endingEquityUsd = ledger.accountState(new Map()).equityUsd;
  result.skipReasons = [...skipCounts.entries()]
    .map(([reason, count]) => ({ reason, count }))
    .sort((a, b) => b.count - a.count)
    .slice(0, 10);

  result.metrics = computeRunMetrics(trades, { startingCashUsd });
  if (runId !== null) {
    await persistRunMetrics(db, runId, {
      ...result.metrics,
      feesUsd: result.feesUsd,
      startingCashUsd,
      endingEquityUsd: result.endingEquityUsd,
      stillOpen: result.stillOpen,
    });
  }

  logBacktest(result);
  return result;
}

/**
 * One replay_runs row per backtest, so its decisions are tagged and separable
 * from live ones exactly as replay's are. `params` records the reconstruction
 * knobs — a result is not interpretable without the pipeline lag it assumed.
 */
async function createBacktestRun(
  db: Db,
  rulesVersionId: string,
  options: BacktestOptions,
): Promise<string> {
  const id = newId();
  await db.insert(replayRuns).values({
    id,
    rulesVersionId,
    params: {
      mode: 'backtest',
      pipelineLagMs: options.pipelineLagMs ?? DEFAULT_PIPELINE_LAG_MS,
      promptVersions: options.promptVersions ?? [CURRENT_PROMPT_VERSION],
      transports: options.transports ?? ['api'],
      startingCashUsd: options.startingCashUsd ?? '100000.00',
      ...(options.slippageBps !== undefined ? { slippageBps: options.slippageBps } : {}),
    },
    ...(options.from !== undefined ? { signalsFrom: options.from } : {}),
    ...(options.to !== undefined ? { signalsTo: options.to } : {}),
    notes: 'backtest mode',
  });
  return id;
}

async function persistDecision(
  db: Db,
  input: {
    runId: string;
    rulesVersionId: string;
    signal: BacktestSignal;
    features: DecideFeatures;
    quote: QuoteSnapshot | null;
    action: 'open_long' | 'open_short' | 'close' | 'skip';
    skipReason: string | null;
    gates: GateResult[];
    sizedQty: string | null;
    sizedNotional: string | null;
  },
): Promise<void> {
  await db
    .insert(decisions)
    .values({
      id: newId(),
      // Run-scoped, so re-running a backtest under the same rules inserts a new
      // set rather than colliding with the previous run or with live decisions.
      decisionKey: `${input.signal.id}:${input.rulesVersionId}:${input.runId}`,
      signalId: input.signal.id,
      instrumentId: input.signal.instrumentId,
      rulesVersionId: input.rulesVersionId,
      replayRunId: input.runId,
      // The reconstructed instant, NOT the wall clock: a backtest decision is
      // dated when the pipeline could have made it.
      decidedAt: input.signal.decisionAt,
      action: input.action,
      skipReason: input.skipReason,
      suppressed: false,
      gates: input.gates,
      features: input.features,
      quoteSnapshot: input.quote ?? {},
      sizedQty: input.sizedQty,
      sizedNotional: input.sizedNotional,
    })
    .onConflictDoNothing({ target: decisions.decisionKey });
}

function bump(counts: Map<string, number>, key: string): void {
  counts.set(key, (counts.get(key) ?? 0) + 1);
}

function toSignalInput(signal: BacktestSignal): SignalInput {
  return SignalInput.parse({
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
}

function logBacktest(result: BacktestResult): void {
  console.log(
    JSON.stringify({
      level: 'info',
      msg: 'backtest',
      ...result,
      closedTrades: result.closedTrades.length,
    }),
  );
}
