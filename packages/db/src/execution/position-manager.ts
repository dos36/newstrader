import {
  absDec,
  buildCloseOrderIntent,
  formatDec,
  mul,
  newId,
  parseDec,
  roundTo,
} from '@newstrader/core';
import type { BrokerAdapter, RulesConfig, TradeHorizon } from '@newstrader/core';
import { and, asc, desc, eq, gte, inArray, isNull, lte } from 'drizzle-orm';
import type { Db } from '../client.js';
import { decisions, instruments, llmSignals, orders, priceBars1m } from '../schema.js';
import { checkKillSwitch } from './kill-switch.js';

/**
 * Position manager — architecture §5.4 exit management: "signal-driven
 * pipelines forget exits — this one doesn't". Runs on a schedule, evaluates
 * every DERIVED open position against the exit policy, and writes
 * action='close' decision rows so exits are replayable under the same
 * versioning machinery as entries.
 *
 * Exit evaluation is an INJECTED pure function (`evaluateExit`): this module
 * deliberately has zero compile-time dependency on the decision-engine module
 * (packages/core/src/decide is owned by another workstream and its exports
 * land in the core index later); the wiring layer passes the engine's
 * evaluator in. Everything the evaluator reads is snapshotted into the close
 * decision's features/quote_snapshot — replay re-executes from stored inputs.
 *
 * Entry-context derivation: a position's entry is the most recent FILLED
 * opening order (live decisions only, replay rows excluded). v1's engine is
 * one-lot-per-instrument (the hasOpenPositionForInstrument gate blocks adds),
 * so the latest opening order IS the lot's entry. Its decision supplies the
 * ATR snapshot (features.atr) and decided_at; its signal supplies the horizon
 * (falling back to config.exits.defaultTimeStopHorizon for signal-less
 * entries).
 *
 * Kill switch (checked here INDEPENDENTLY of decide): when halted, the close
 * decision is still RECORDED with suppressed=true and NO order is placed. A
 * suppressed decision key carries a ':suppressed' suffix so the halt record
 * never blocks the real close once the switch clears (deliberate deviation
 * from the bare 'exit:<openingOrderId>' key, which the unsuppressed close
 * still uses).
 *
 * Idempotency, decision_key = 'exit:<openingOrderId>' — REASON-INDEPENDENT.
 * The reason (time_stop / stop_loss / take_profit) is recorded in
 * features.exitReason, never in the key: two concurrent runners evaluating
 * the same position under different verdicts (e.g. one sees stop_loss, the
 * other time_stop, because they read the price feed a moment apart) MUST
 * mint exactly one close, never two that could both fill and flip the
 * position short. Whichever evaluation's insert wins the decision_key
 * unique constraint owns the exit; the loser short-circuits below and never
 * records its own reason.
 *
 * Order idempotency is layered on TOP of the decision, separately:
 * client_order_id = sha256(`${decisionKey}:a${attempt}`) (buildCloseOrderIntent /
 * clientOrderIdFor — the SAME namespace entries use; a prior revision used
 * the bare decision_key as client_order_id directly). An existing decision
 * short-circuits UNLESS every order recorded against it is 'rejected': a
 * rejected close must retry under a NEW attempt number rather than wedge the
 * exit forever under an already-consumed key. Retries are bounded
 * (MAX_CLOSE_ATTEMPTS) — beyond that the position manager logs a structured
 * error and skips, waiting for a human rather than retrying forever.
 *
 * Positions with no reference bar in the last 24h are SKIPPED without a
 * decision at all: the SimBroker would reject the close order for the same
 * reason, and recording a decision with no chance of a fill yet would just
 * consume an attempt for nothing. The next scheduled run retries once bars
 * exist.
 */

/** A close order is only attempted when a bar this fresh exists. */
export const EXIT_REFERENCE_MAX_AGE_MS = 24 * 60 * 60 * 1000;
/** decisions.sized_notional is numeric(18,2). */
const SIZED_NOTIONAL_SCALE = 2;
/**
 * Bound on retrying a close after REJECTED orders (e.g. repeated
 * no-reference-price races). Beyond this, evaluatePosition stops trying and
 * logs a structured error instead of retrying forever.
 */
export const MAX_CLOSE_ATTEMPTS = 3;

/** Everything the injected exit evaluator may read — snapshotted per decision. */
export interface OpenPositionExitInput {
  instrumentId: string;
  side: 'long' | 'short';
  /** Unsigned open quantity (decimal string). */
  qty: string;
  /** Net-position weighted average entry (decimal string). */
  avgEntryPrice: string;
  /** decided_at of the opening decision — the time-stop anchor. */
  entryDecidedAt: Date;
  /** Signal horizon, or config.exits.defaultTimeStopHorizon when signal-less. */
  horizon: TradeHorizon;
  /** ATR snapshotted into the ENTRY decision's features; null when unknown. */
  atrAtEntry: string | null;
  /** Latest bar close (decimal string) and its bar timestamp. */
  latestClose: string;
  latestCloseTs: Date;
  now: Date;
  config: RulesConfig;
}

export interface ExitEvaluation {
  shouldClose: boolean;
  /** Machine-readable reason (e.g. 'time_stop', 'stop_loss') — keys the decision. */
  reason: string | null;
}

/** The engine's evaluateExit shape, injected by the wiring layer. Pure. */
export type ExitEvaluator = (input: OpenPositionExitInput) => ExitEvaluation;

export interface EvaluateOpenPositionsParams {
  broker: BrokerAdapter;
  rules: RulesConfig;
  /** rules_versions row the close decisions are recorded under. */
  rulesVersionId: string;
  now: Date;
  evaluateExit: ExitEvaluator;
  /** Kill-switch probe; defaults to checkKillSwitch() (env-backed). */
  checkHalted?: (() => Promise<boolean>) | undefined;
}

export type PositionOutcome =
  | 'held'
  | 'closed'
  | 'suppressed'
  | 'close_rejected'
  | 'already_closed'
  | 'skipped_no_entry'
  | 'skipped_no_price';

export interface PositionDetail {
  instrumentId: string;
  outcome: PositionOutcome;
  reason?: string;
  decisionKey?: string;
}

export interface EvaluateOpenPositionsResult {
  evaluated: number;
  closed: number;
  suppressed: number;
  skipped: number;
  details: PositionDetail[];
}

/** Evaluate every open position; record close decisions and place close orders. */
export async function evaluateOpenPositions(
  db: Db,
  params: EvaluateOpenPositionsParams,
): Promise<EvaluateOpenPositionsResult> {
  const { broker, rules, rulesVersionId, now, evaluateExit } = params;
  const checkHalted = params.checkHalted ?? (async () => (await checkKillSwitch()).halted);

  const positions = await broker.getPositions();
  const halted = await checkHalted();

  const result: EvaluateOpenPositionsResult = {
    evaluated: positions.length,
    closed: 0,
    suppressed: 0,
    skipped: 0,
    details: [],
  };

  for (const position of positions) {
    const detail = await evaluatePosition(db, position, {
      broker,
      rules,
      rulesVersionId,
      now,
      evaluateExit,
      halted,
    });
    result.details.push(detail);
    if (detail.outcome === 'closed') result.closed += 1;
    else if (detail.outcome === 'suppressed') result.suppressed += 1;
    else if (detail.outcome !== 'held') result.skipped += 1;
  }
  return result;
}

// ------------------------------------------------------------------ internals --

interface PositionContext {
  broker: BrokerAdapter;
  rules: RulesConfig;
  rulesVersionId: string;
  now: Date;
  evaluateExit: ExitEvaluator;
  halted: boolean;
}

async function evaluatePosition(
  db: Db,
  position: { instrumentId: string; qty: string; avgEntryPrice: string },
  ctx: PositionContext,
): Promise<PositionDetail> {
  const { instrumentId } = position;
  const signedQty = parseDec(position.qty);
  const side: 'long' | 'short' = signedQty.units > 0n ? 'long' : 'short';
  const qtyAbs = formatDec(absDec(signedQty));

  const entry = await findEntryContext(db, instrumentId);
  if (entry === undefined) return { instrumentId, outcome: 'skipped_no_entry' };

  const latest = await latestFreshClose(db, instrumentId, ctx.now);
  if (latest === undefined) return { instrumentId, outcome: 'skipped_no_price' };

  const horizon = entry.horizon ?? ctx.rules.exits.defaultTimeStopHorizon;
  const exitInput: OpenPositionExitInput = {
    instrumentId,
    side,
    qty: qtyAbs,
    avgEntryPrice: position.avgEntryPrice,
    entryDecidedAt: entry.decidedAt,
    horizon,
    atrAtEntry: entry.atr,
    latestClose: latest.close,
    latestCloseTs: latest.ts,
    now: ctx.now,
    config: ctx.rules,
  };
  const evaluation = ctx.evaluateExit(exitInput);
  if (!evaluation.shouldClose) return { instrumentId, outcome: 'held' };

  const reason =
    evaluation.reason !== null && evaluation.reason !== '' ? evaluation.reason : 'exit';
  // REASON-INDEPENDENT: see the module header — this is what stops a
  // stop_loss verdict and a time_stop verdict from ever minting two orders.
  const baseKey = `exit:${entry.openingOrderId}`;
  const decisionKey = ctx.halted ? `${baseKey}:suppressed` : baseKey;

  // Short-circuit on an existing decision — except to retry a rejected order
  // or recover a missing one after a crash between decision insert and order
  // placement (both handled uniformly below via decisionId).
  let decisionId: string;
  const existingRows = await db
    .select({ id: decisions.id, suppressed: decisions.suppressed })
    .from(decisions)
    .where(eq(decisions.decisionKey, decisionKey))
    .limit(1);
  const existing = existingRows[0];
  if (existing === undefined) {
    const insertedRows = await db
      .insert(decisions)
      .values({
        id: newId(),
        decisionKey,
        signalId: null, // position-manager exits have no originating signal
        instrumentId,
        rulesVersionId: ctx.rulesVersionId,
        replayRunId: null,
        decidedAt: ctx.now,
        action: 'close',
        suppressed: ctx.halted,
        gates: [],
        features: {
          openingOrderId: entry.openingOrderId,
          entryDecisionId: entry.decisionId,
          entryDecidedAt: entry.decidedAt.toISOString(),
          horizon,
          atrAtEntry: entry.atr,
          side,
          qty: qtyAbs,
          avgEntryPrice: position.avgEntryPrice,
          exitReason: reason,
          halted: ctx.halted,
        },
        quoteSnapshot: {
          price: latest.close,
          ts: latest.ts.toISOString(),
          source: 'price_bars_1m',
          spreadBps: null,
        },
        sizedQty: qtyAbs,
        sizedNotional: formatDec(
          roundTo(mul(absDec(signedQty), parseDec(latest.close)), SIZED_NOTIONAL_SCALE),
        ),
      })
      .onConflictDoNothing({ target: decisions.decisionKey })
      .returning({ id: decisions.id });
    const inserted = insertedRows[0];
    if (inserted === undefined) {
      // Lost a race on decision_key to a concurrent runner: adopt its row —
      // its reason wins, not ours (this call's `reason` is only ever used
      // below for the returned PositionDetail, never persisted here).
      const raceRows = await db
        .select({ id: decisions.id, suppressed: decisions.suppressed })
        .from(decisions)
        .where(eq(decisions.decisionKey, decisionKey))
        .limit(1);
      const winner = raceRows[0];
      if (winner === undefined) {
        throw new Error(
          `position-manager: decision insert conflicted but no existing row was found for "${decisionKey}"`,
        );
      }
      if (winner.suppressed) return { instrumentId, outcome: 'suppressed', reason, decisionKey };
      decisionId = winner.id;
    } else {
      decisionId = inserted.id;
    }
  } else if (existing.suppressed) {
    // Recorded under halt; the live close (unsuffixed key) happens separately.
    return { instrumentId, outcome: 'suppressed', reason, decisionKey };
  } else {
    decisionId = existing.id;
  }

  if (ctx.halted) {
    // Decision recorded; no order is ever emitted while the switch is tripped.
    return { instrumentId, outcome: 'suppressed', reason, decisionKey };
  }

  // A filled/pending/accepted order already exists — nothing left to do. Only
  // if EVERY existing order is 'rejected' (or none exist yet) do we attempt a
  // new one, under the next attempt number.
  const existingOrders = await db
    .select({ id: orders.id, status: orders.status })
    .from(orders)
    .where(eq(orders.decisionId, decisionId))
    .orderBy(asc(orders.submittedAt));
  const liveOrder = existingOrders.find((order) => order.status !== 'rejected');
  if (liveOrder !== undefined) {
    return { instrumentId, outcome: 'already_closed', reason, decisionKey };
  }

  const attempt = existingOrders.length + 1;
  if (attempt > MAX_CLOSE_ATTEMPTS) {
    console.error(
      JSON.stringify({
        level: 'error',
        msg: 'position_manager_close_attempts_exhausted',
        instrumentId,
        decisionKey,
        attempts: existingOrders.length,
      }),
    );
    return { instrumentId, outcome: 'close_rejected', reason: 'attempts_exhausted', decisionKey };
  }

  const assetClass = await instrumentAssetClass(db, instrumentId);
  const intent = buildCloseOrderIntent({
    decisionKey,
    attempt,
    instrumentId,
    assetClass,
    positionSide: side,
    qty: qtyAbs,
  });
  const ack = await ctx.broker.placeOrder(intent);
  if (ack.status === 'rejected') {
    return {
      instrumentId,
      outcome: 'close_rejected',
      ...(ack.reason !== undefined ? { reason: ack.reason } : {}),
      decisionKey,
    };
  }
  return { instrumentId, outcome: 'closed', reason, decisionKey };
}

interface EntryContext {
  openingOrderId: string;
  decisionId: string;
  decidedAt: Date;
  atr: string | null;
  horizon: TradeHorizon | null;
}

/** Most recent FILLED opening order (live decisions only) for the instrument. */
async function findEntryContext(db: Db, instrumentId: string): Promise<EntryContext | undefined> {
  const rows = await db
    .select({
      orderId: orders.id,
      decisionId: decisions.id,
      decidedAt: decisions.decidedAt,
      features: decisions.features,
      signalId: decisions.signalId,
    })
    .from(orders)
    .innerJoin(decisions, eq(orders.decisionId, decisions.id))
    .where(
      and(
        eq(orders.instrumentId, instrumentId),
        eq(orders.venue, 'sim'),
        eq(orders.status, 'filled'),
        inArray(decisions.action, ['open_long', 'open_short']),
        isNull(decisions.replayRunId),
      ),
    )
    .orderBy(desc(orders.submittedAt), desc(orders.id))
    .limit(1);
  const row = rows[0];
  if (row === undefined) return undefined;

  const atrRaw = row.features['atr'];
  let horizon: TradeHorizon | null = null;
  if (row.signalId !== null) {
    const signalRows = await db
      .select({ horizon: llmSignals.horizon })
      .from(llmSignals)
      .where(eq(llmSignals.id, row.signalId))
      .limit(1);
    horizon = signalRows[0]?.horizon ?? null;
  }
  return {
    openingOrderId: row.orderId,
    decisionId: row.decisionId,
    decidedAt: row.decidedAt,
    atr: typeof atrRaw === 'string' ? atrRaw : null,
    horizon,
  };
}

/** Latest bar close within EXIT_REFERENCE_MAX_AGE_MS, or undefined. */
async function latestFreshClose(
  db: Db,
  instrumentId: string,
  now: Date,
): Promise<{ close: string; ts: Date } | undefined> {
  const rows = await db
    .select({ close: priceBars1m.close, ts: priceBars1m.ts })
    .from(priceBars1m)
    .where(
      and(
        eq(priceBars1m.instrumentId, instrumentId),
        lte(priceBars1m.ts, now),
        gte(priceBars1m.ts, new Date(now.getTime() - EXIT_REFERENCE_MAX_AGE_MS)),
      ),
    )
    .orderBy(desc(priceBars1m.ts))
    .limit(1);
  return rows[0];
}

async function instrumentAssetClass(db: Db, instrumentId: string): Promise<'us_equity' | 'crypto'> {
  const rows = await db
    .select({ assetClass: instruments.assetClass })
    .from(instruments)
    .where(eq(instruments.id, instrumentId))
    .limit(1);
  const row = rows[0];
  if (row === undefined) {
    throw new Error(`position-manager: unknown instrument "${instrumentId}"`);
  }
  return row.assetClass;
}
