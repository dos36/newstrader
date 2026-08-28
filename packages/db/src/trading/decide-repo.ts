import {
  DecideFeatures,
  QuoteSnapshot,
  SignalInput,
  buildOrderIntent,
  formatDec,
  newId,
  parseDec,
  roundTo,
} from '@newstrader/core';
import type {
  BrokerAccountState,
  BrokerAdapter,
  BrokerPosition,
  DecideFn,
  GateResult,
  OrderIntent,
  RulesConfig,
} from '@newstrader/core';
import { and, count, desc, eq, gt, gte, lte } from 'drizzle-orm';

import { toPriceString } from '../bars/decimal.js';
import { loadScheduledEventWindow } from '../calendar/calendar-repo.js';
import { isScheduledEvent, type ScheduledEventLite } from '../calendar/match.js';
import type { Db } from '../client.js';
import { DEFAULT_PRICE_STALENESS_MINUTES, simpleReturnBps } from '../reaction/math.js';
import { decisions, newsClusterItems, priceBars1d, priceBars1m, rawNewsItems } from '../schema.js';
import { DOLLAR_VOLUME_LOOKBACK_DAYS, medianDollarVolume, wilderAtr } from './features.js';
import { getRulesVersion } from './rules-repo.js';
import { loadUndecidedSignals, type UndecidedSignal } from './signals-repo.js';

/**
 * The live decide() driver (architecture §5.4). Loads undecided signals,
 * assembles EVERYTHING the pure engine reads — features and quote — persists
 * one decisions row per signal (including skips), and returns order intents
 * for non-suppressed opens.
 *
 * Replay contract: the engine is injected (deps.decide) and every input it
 * saw is snapshotted onto the row (features / quote_snapshot / gates), so
 * replay re-executes from the stored copy and never refetches.
 *
 * Kill switch: when deps.killSwitchHalted is true, decisions are still
 * RECORDED with suppressed=true and no intent is returned — research data
 * never stops (architecture §4.4). Execution checks the switch again
 * independently; this flag is belt, not suspenders.
 */

const MINUTE_MS = 60_000;
const HOUR_MS = 3_600_000;

/**
 * Calendar-match half-window around the ANCHOR (cluster first_received_at).
 *
 * Why 60 min: a scheduled release generates coverage for roughly an hour on
 * either side — previews just before, reactions just after — and that whole band
 * is "expected" news. Much tighter and a preview written 20 minutes early looks
 * novel; much wider and ordinary unrelated news on a CPI morning gets suppressed.
 * A judgment call: the calibration report (LLM `already_expected` vs this
 * deterministic match, per event type) is the evidence that should refine it.
 */
export const CALENDAR_TOLERANCE_MINUTES = 60;

/**
 * A minute bar older than this cannot serve as the decision-time quote.
 *
 * Why 24 h: this is a LIVENESS check, not a freshness target. Its job is to
 * reject an instrument we have no current price for at all (delisted, halted,
 * never recorded), not to guarantee a recent price — equity bars stop at the
 * close, so any tighter bound would reject every overnight and weekend decision,
 * which is precisely when filings arrive. Freshness in the sense that matters for
 * trading is the `stale_move` gate's job: it measures how far price has moved
 * since the anchor, not how old the quote is. Deliberately equal to the
 * execution-side bounds (sim-broker, position-manager) so a decision that passes
 * this gate is never rejected at fill time for the same reason.
 */
export const QUOTE_MAX_AGE_MS = 24 * HOUR_MS;

/** skip_reason recorded when no usable quote bar exists — replay copies these verbatim. */
export const NO_QUOTE_SKIP_REASON = 'no_quote';

/**
 * Daily bars loaded for Wilder-ATR warmup: lookback×3 true ranges converge
 * the smoothing well past the seed SMA; +1 for the extra close a TR needs.
 */
const ATR_WARMUP_MULTIPLE = 3;

export interface DecideDeps {
  /** The pure engine — injected so this module never imports engine code. */
  decide: DecideFn;
  /** Broker port for portfolio-state features (v1: the SimBroker, venue 'sim'). */
  broker: BrokerAdapter;
  /** Kill-switch state read by the caller this invocation (SSM-backed in prod). */
  killSwitchHalted: boolean;
  /** Engine build stamp — config versioning does not protect against code drift. */
  engineVersion: string;
  /** Injectable clock (tests). */
  now?: () => Date;
}

export interface DecideSignalsOptions {
  rulesLabel: string;
  batch: number;
}

export interface DecideSignalsTotals {
  /** Signals loaded this pass. */
  examined: number;
  /** decisions rows actually inserted (conflict = already decided, not counted). */
  decided: number;
  /** Inserted decisions with an open action. */
  opens: number;
  /** Inserted decisions with action=skip (includes no_quote). */
  skips: number;
  /** Inserted decisions recorded while the kill switch was tripped. */
  suppressed: number;
  /** Order intents for NON-suppressed opens only — never emitted when halted. */
  intents: OrderIntent[];
}

export async function decideSignals(
  db: Db,
  deps: DecideDeps,
  options: DecideSignalsOptions,
): Promise<DecideSignalsTotals> {
  const now = deps.now?.() ?? new Date();
  const rules = await getRulesVersion(db, options.rulesLabel);
  const signals = await loadUndecidedSignals(db, {
    rulesVersionId: rules.id,
    batch: options.batch,
  });

  const totals: DecideSignalsTotals = {
    examined: signals.length,
    decided: 0,
    opens: 0,
    skips: 0,
    suppressed: 0,
    intents: [],
  };
  if (signals.length === 0) {
    logTotals(rules.label, totals);
    return totals;
  }

  // One calendar-window prefetch for the whole batch (calendar-repo contract),
  // one broker snapshot: portfolio state is decision-time context shared by
  // every signal in the pass — the engine sees the broker/positions as of
  // batch start, PLUS whatever this same batch has opened so far (below).
  const anchorTimes = signals.map((signal) => signal.anchorTs.getTime());
  const toleranceMs = CALENDAR_TOLERANCE_MINUTES * MINUTE_MS;
  const events = await loadScheduledEventWindow(db, {
    from: new Date(Math.min(...anchorTimes) - toleranceMs),
    to: new Date(Math.max(...anchorTimes) + toleranceMs),
  });
  const positions = await deps.broker.getPositions();
  const account = await deps.broker.getAccountState();

  // Intra-batch portfolio state: without this, two same-instrument signals
  // in one batch both read the SAME batch-start snapshot and both pass
  // no_existing_position, and N opens across instruments can jointly exceed
  // maxConcurrentPositions (the batch-start count never moves). Updated after
  // each NON-suppressed open decision (kill-switch-halted opens place no
  // order, so they don't occupy a slot). paperEquityUsd stays the batch-start
  // value regardless — recomputing it intra-batch would need the fill
  // ledger, not just the decisions rows, and a stale (pre-batch) equity is
  // the conservative direction for sizing later opens in the same batch.
  const openedThisBatch = new Set<string>();
  let opensThisBatch = 0;

  const ctx: FeatureContext = {
    now,
    events,
    positions,
    account,
    engineVersion: deps.engineVersion,
    atrLookbackDays: rules.config.sizing.atrLookbackDays,
    openedThisBatch,
    opensThisBatch: () => opensThisBatch,
  };

  for (const signal of signals) {
    const decisionKey = liveDecisionKey(signal.id, rules.id);
    const quote = await loadDecisionQuote(db, signal.instrumentId, now);
    const features = await assembleFeatures(db, signal, quote, ctx);

    let outcome: DecisionOutcome;
    if (quote === null) {
      outcome = {
        action: 'skip',
        skipReason: NO_QUOTE_SKIP_REASON,
        gates: [NO_QUOTE_GATE],
        sizedQty: null,
        sizedNotional: null,
        intent: null,
      };
    } else {
      const result = deps.decide(toSignalInput(signal), features, quote, rules.config);
      // The pure engine cannot mint the intent: the decisionKey (signal ×
      // rules version × run) is DB-layer knowledge, and clientOrderId derives
      // from it. Build it here (core/decide/intent.ts) for sized opens; honor
      // a pre-built engine intent if a future engine ever supplies one.
      let intent = result.intent ?? null;
      if (
        intent === null &&
        (result.action === 'open_long' || result.action === 'open_short') &&
        result.sizedQty !== undefined
      ) {
        intent = buildOrderIntent({
          decisionKey,
          instrumentId: signal.instrumentId,
          assetClass: signal.assetClass,
          action: result.action,
          qty: result.sizedQty,
        });
      }
      outcome = {
        action: result.action,
        skipReason: result.skipReason ?? null,
        gates: result.gates,
        sizedQty: result.sizedQty ?? null,
        // Pre-round to the column scale so stored == computed (mirrors
        // position-manager.ts) — the engine's raw notional can carry more
        // fractional digits than sized_notional's numeric(18,2) keeps.
        sizedNotional:
          result.sizedNotional === undefined ? null : roundSizedNotional(result.sizedNotional),
        intent,
      };
    }

    const inserted = await db
      .insert(decisions)
      .values({
        id: newId(),
        decisionKey,
        signalId: signal.id,
        instrumentId: signal.instrumentId,
        rulesVersionId: rules.id,
        replayRunId: null,
        decidedAt: now,
        action: outcome.action,
        skipReason: outcome.skipReason,
        suppressed: deps.killSwitchHalted,
        gates: outcome.gates,
        features,
        quoteSnapshot: quote ?? {},
        sizedQty: outcome.sizedQty,
        sizedNotional: outcome.sizedNotional,
      })
      .onConflictDoNothing({ target: decisions.decisionKey })
      .returning({ id: decisions.id });
    if (inserted.length === 0) continue; // raced an earlier pass: already decided

    totals.decided += 1;
    if (deps.killSwitchHalted) totals.suppressed += 1;
    if (outcome.action === 'skip') totals.skips += 1;
    if (outcome.action === 'open_long' || outcome.action === 'open_short') {
      totals.opens += 1;
      if (!deps.killSwitchHalted) {
        // Occupy this instrument's slot for the REST of the batch (fix for
        // the intra-batch portfolio gate — see the comment above ctx). A
        // suppressed open placed no order, so it never occupies a slot.
        openedThisBatch.add(signal.instrumentId);
        opensThisBatch += 1;
        if (outcome.intent !== null) totals.intents.push(outcome.intent);
      }
    }
  }

  logTotals(rules.label, totals);
  return totals;
}

/** `${signalId}:${rulesVersionId}:live` — the decisions idempotency key for live rows. */
export function liveDecisionKey(signalId: string, rulesVersionId: string): string {
  return `${signalId}:${rulesVersionId}:live`;
}

const NO_QUOTE_GATE: GateResult = {
  gate: 'quote_available',
  pass: false,
  observed: null,
  threshold: null,
};

/** decisions.sized_notional is numeric(18,2) (mirrors position-manager.ts). */
const SIZED_NOTIONAL_SCALE = 2;

/**
 * Round to the sized_notional column scale before writing.
 *
 * Exported so replay-repo writes through the SAME helper. The column rounds on
 * write either way and compareRuns canonicalizes trailing zeros, so a divergence
 * is not reachable today — but two independent write paths for one column is
 * exactly how a phantom divergence appears the day someone compares stored
 * strings without canonicalizing. One definition, both paths.
 */
export function roundSizedNotional(value: string): string {
  return formatDec(roundTo(parseDec(value), SIZED_NOTIONAL_SCALE));
}

// ---------------------------------------------------------------- assembly --

/**
 * Exported for the backtest, which reuses this assembler rather than growing a
 * parallel one. Every query below is bounded by `now`, so passing a HISTORICAL
 * instant reconstructs the features as of that instant — that property is the
 * whole reason a backtest can share the live code path, and breaking it (adding
 * an unbounded query, or reading a wall clock) silently introduces look-ahead
 * into both callers at once.
 */
export interface FeatureContext {
  now: Date;
  events: ScheduledEventLite[];
  /** Broker-derived positions as of BATCH START. */
  positions: BrokerPosition[];
  account: BrokerAccountState;
  engineVersion: string;
  atrLookbackDays: RulesConfig['sizing']['atrLookbackDays'];
  /** Instruments opened so far THIS batch (non-suppressed only) — see decideSignals. */
  openedThisBatch: Set<string>;
  /** Count of opens so far this batch — read live via a getter (mutated after each insert). */
  opensThisBatch: () => number;
}

interface DecisionOutcome {
  action: 'open_long' | 'open_short' | 'close' | 'skip';
  skipReason: string | null;
  gates: GateResult[];
  sizedQty: string | null;
  sizedNotional: string | null;
  intent: OrderIntent | null;
}

function toSignalInput(signal: UndecidedSignal): SignalInput {
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

/**
 * Assemble the DecideFeatures snapshot for one signal. Cluster velocity is
 * decision-time context (trailing hour before NOW), while calendarMatch and
 * priceMoveSinceAnchorBps anchor on the cluster's first_received_at. The
 * result is zod-parsed so anything persisted is guaranteed to round-trip
 * through replay's DecideFeatures.parse.
 */
export async function assembleFeatures(
  db: Db,
  signal: UndecidedSignal,
  quote: QuoteSnapshot | null,
  ctx: FeatureContext,
): Promise<DecideFeatures> {
  const hourAgo = new Date(ctx.now.getTime() - HOUR_MS);
  const itemRows = await db
    .select({ n: count() })
    .from(newsClusterItems)
    .innerJoin(rawNewsItems, eq(rawNewsItems.id, newsClusterItems.itemId))
    .where(
      and(
        eq(newsClusterItems.clusterId, signal.clusterId),
        gt(rawNewsItems.receivedAt, hourAgo),
        lte(rawNewsItems.receivedAt, ctx.now),
      ),
    );
  const itemsPerHour = itemRows[0]?.n ?? 0;

  const calendarMatch = isScheduledEvent(ctx.events, {
    at: signal.anchorTs,
    toleranceMinutes: CALENDAR_TOLERANCE_MINUTES,
    instrumentId: signal.instrumentId,
  });

  const anchorClose = await loadSettledCloseAt(db, signal.instrumentId, signal.anchorTs);
  const priceMoveSinceAnchorBps =
    anchorClose !== null && quote !== null ? simpleReturnBps(anchorClose, quote.price) : null;

  // One daily-bar load serves both the liquidity and volatility features.
  const atrBarsWanted = ctx.atrLookbackDays * ATR_WARMUP_MULTIPLE + 1;
  const dailyDesc = await db
    .select({
      high: priceBars1d.high,
      low: priceBars1d.low,
      close: priceBars1d.close,
      volume: priceBars1d.volume,
    })
    .from(priceBars1d)
    .where(and(eq(priceBars1d.instrumentId, signal.instrumentId), lte(priceBars1d.ts, ctx.now)))
    .orderBy(desc(priceBars1d.ts))
    .limit(Math.max(DOLLAR_VOLUME_LOOKBACK_DAYS, atrBarsWanted));

  const volumeWindow = dailyDesc.slice(0, DOLLAR_VOLUME_LOOKBACK_DAYS);
  const atrWindowAsc = dailyDesc.slice(0, atrBarsWanted).reverse();
  const atrValue = wilderAtr(atrWindowAsc, ctx.atrLookbackDays);

  return DecideFeatures.parse({
    clusterItemCount: signal.clusterItemCount,
    distinctSourceCount: signal.clusterDistinctSourceCount,
    itemsPerHour,
    calendarMatch,
    priceMoveSinceAnchorBps,
    medianDollarVolume: medianDollarVolume(volumeWindow),
    atr: atrValue === null ? null : toPriceString(atrValue),
    // Batch-start snapshot PLUS whatever this batch has opened so far — see
    // the intra-batch portfolio state comment in decideSignals.
    openPositionsCount: ctx.positions.length + ctx.opensThisBatch(),
    hasOpenPositionForInstrument:
      ctx.positions.some((position) => position.instrumentId === signal.instrumentId) ||
      ctx.openedThisBatch.has(signal.instrumentId),
    paperEquityUsd: ctx.account.equityUsd,
    engineVersion: ctx.engineVersion,
  });
}

/**
 * Decision-time quote: the latest minute-bar close at-or-before now, no older
 * than QUOTE_MAX_AGE_MS. Bar closes carry no spread (spreadBps null) — real
 * quotes fill that in post-NBBO (architecture §5.5).
 *
 * Exported since M2: the interpret sweep reuses the same quote to compute the
 * prompt's price-move-since-anchor context, so decide and interpret can never
 * disagree about what "the current price" means.
 */
export async function loadDecisionQuote(
  db: Db,
  instrumentId: string,
  now: Date,
): Promise<QuoteSnapshot | null> {
  const rows = await db
    .select({ ts: priceBars1m.ts, close: priceBars1m.close, source: priceBars1m.source })
    .from(priceBars1m)
    .where(
      and(
        eq(priceBars1m.instrumentId, instrumentId),
        lte(priceBars1m.ts, now),
        gte(priceBars1m.ts, new Date(now.getTime() - QUOTE_MAX_AGE_MS)),
      ),
    )
    .orderBy(desc(priceBars1m.ts))
    .limit(1);
  const row = rows[0];
  if (row === undefined) return null;
  return QuoteSnapshot.parse({
    price: row.close,
    ts: row.ts.toISOString(),
    source: row.source,
    spreadBps: null,
  });
}

/**
 * Anchor price with settledBarAt semantics (reaction/math.ts): the last close
 * at-or-before the anchor counts as fresh within the staleness bound; a stale
 * close is accepted only when a LATER bar proves the gap was non-trading
 * (overnight/weekend/halt). Null otherwise — the stale-move feature is then
 * "not computable", which the engine treats as skip-safe.
 *
 * Exported since M2 — see loadDecisionQuote's note.
 */
export async function loadSettledCloseAt(
  db: Db,
  instrumentId: string,
  at: Date,
): Promise<string | null> {
  // Select by CLOSE time, not open. A minute bar's `ts` is its OPEN, so a bar
  // whose open is <= the anchor still CLOSES up to 59s after the news — baking
  // post-news trading into the "before" price and shrinking the observed move
  // (a real 350 bps move reads as 290 and passes a 300 bps threshold). The
  // reaction measurer already shifts the anchor by one bar for this reason
  // (reaction/math.ts anchorLookupTs); the trading path never copied it.
  const lookupAt = new Date(at.getTime() - MINUTE_MS);
  const rows = await db
    .select({ ts: priceBars1m.ts, close: priceBars1m.close })
    .from(priceBars1m)
    .where(and(eq(priceBars1m.instrumentId, instrumentId), lte(priceBars1m.ts, lookupAt)))
    .orderBy(desc(priceBars1m.ts))
    .limit(1);
  const row = rows[0];
  if (row === undefined) return null;
  if (lookupAt.getTime() - row.ts.getTime() <= DEFAULT_PRICE_STALENESS_MINUTES * MINUTE_MS) {
    return row.close;
  }
  const later = await db
    .select({ ts: priceBars1m.ts })
    .from(priceBars1m)
    .where(and(eq(priceBars1m.instrumentId, instrumentId), gt(priceBars1m.ts, lookupAt)))
    .limit(1);
  return later.length > 0 ? row.close : null;
}

function logTotals(rulesLabel: string, totals: DecideSignalsTotals): void {
  console.log(
    JSON.stringify({
      level: 'info',
      msg: 'decide_signals',
      rulesLabel,
      ...totals,
      intents: totals.intents.length,
    }),
  );
}
