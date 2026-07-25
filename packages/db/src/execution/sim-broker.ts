import {
  FILL_QTY_SCALE,
  add,
  formatDec,
  mul,
  newId,
  parseDec,
  roundTo,
  simulateFill,
} from '@newstrader/core';
import type {
  BrokerAccountState,
  BrokerAdapter,
  BrokerPosition,
  Dec,
  OrderAck,
  OrderIntent,
} from '@newstrader/core';
import { and, asc, desc, eq, gte, isNull, lte } from 'drizzle-orm';
import type { Db } from '../client.js';
import { decisions, fills, orderEvents, orders, priceBars1m } from '../schema.js';
import { derivePortfolio } from './positions.js';
import type { PortfolioFill } from './positions.js';

/**
 * SimBroker — the ONLY BrokerAdapter implementation in v1 (venue 'sim',
 * architecture §7 backend 1). Fills market orders against recorded
 * price_bars_1m closes via the pure simulateFill model; positions and account
 * state are DERIVED from the append-only fills facts (no mutable positions
 * table — architecture §3).
 *
 * Idempotency (architecture §4.2): client_order_id is the execute-stage key.
 * placeOrder is unique-violation-safe — INSERT … ON CONFLICT DO NOTHING, and
 * on conflict the EXISTING order's ack is returned without a second fill, so
 * a redelivered/replayed intent can never double-order. The whole mutation
 * runs in one transaction: a crash mid-flight rolls back to "never placed"
 * and the redelivery re-executes cleanly.
 *
 * Clock: injected (`now`), defaulting to the wall clock. The engine and fill
 * model stay pure; this adapter is the I/O boundary where time is read.
 */

export const SIM_VENUE = 'sim';
/** placeOrder rejection reason when no recent bar exists for the instrument. */
export const NO_REFERENCE_PRICE = 'no_reference_price';
/**
 * A reference close older than this is stale — the order is rejected.
 *
 * Why 24 h, and why exactly this number: it is a LIVENESS check (is there any
 * current price for this instrument at all?), not a freshness guarantee —
 * equity bars stop at the close, so a tighter bound would reject every
 * overnight fill. It is deliberately EQUAL to decide-repo's QUOTE_MAX_AGE_MS:
 * if execution were stricter than decide, the engine would keep producing
 * intents that can never fill, which looks like a silent trading halt.
 */
export const REFERENCE_PRICE_MAX_AGE_MS = 24 * 60 * 60 * 1000;
/** Starting paper cash when none is configured (architecture paper account). */
export const DEFAULT_PAPER_EQUITY_USD = '100000';
/** cash/equity are reported at the fee column's 6dp scale. */
const ACCOUNT_USD_SCALE = 6;

/** Query-builder surface shared by Db and its transaction handle. */
type DbTx = Parameters<Parameters<Db['transaction']>[0]>[0];

export interface SimBrokerOptions {
  /** Starting cash (decimal string). Default: DEFAULT_PAPER_EQUITY_USD. */
  paperEquityUsd?: string | undefined;
  /** One-way slippage bps; default SIM_SLIPPAGE_BPS (see sim-fill.ts). */
  slippageBps?: number | undefined;
  /** Fee bps override per asset class; default SIM_FEE_BPS (see sim-fill.ts). */
  feeBpsByAssetClass?: Partial<Record<OrderIntent['assetClass'], number>> | undefined;
  /** Injected clock (tests / replay harnesses). Default: () => new Date(). */
  now?: (() => Date) | undefined;
}

export class SimBrokerAdapter implements BrokerAdapter {
  readonly venue = SIM_VENUE;
  private readonly startingCash: Dec;
  private readonly slippageBps: number | undefined;
  private readonly feeBpsByAssetClass: Partial<Record<OrderIntent['assetClass'], number>>;
  private readonly now: () => Date;

  constructor(
    private readonly db: Db,
    options?: SimBrokerOptions,
  ) {
    this.startingCash = parseDec(options?.paperEquityUsd ?? DEFAULT_PAPER_EQUITY_USD);
    this.slippageBps = options?.slippageBps;
    this.feeBpsByAssetClass = options?.feeBpsByAssetClass ?? {};
    this.now = options?.now ?? (() => new Date());
  }

  /**
   * Persist the order (pending → order_events), look up the reference price
   * (latest bar close ≤ now within 24h), fill via simulateFill, and return the
   * ack. A replayed intent (same client_order_id) returns the EXISTING order's
   * ack — exactly one fills row can ever exist per market order.
   */
  async placeOrder(intent: OrderIntent): Promise<OrderAck> {
    const now = this.now();
    // Normalize to the qty column scale so the stored order matches the fill.
    const orderQty = formatDec(roundTo(parseDec(intent.qty), FILL_QTY_SCALE));

    return this.db.transaction(async (tx) => {
      const existing = await this.ackForExisting(tx, intent.clientOrderId);
      if (existing !== undefined) return existing;

      const decisionRows = await tx
        .select({ id: decisions.id })
        .from(decisions)
        // replay_run_id IS NULL: the broker itself refuses replay-derived
        // decisions, in addition to the intent builders never being handed
        // one — a replay decisionKey must never place a real (paper) order.
        .where(and(eq(decisions.decisionKey, intent.decisionKey), isNull(decisions.replayRunId)))
        .limit(1);
      const decision = decisionRows[0];
      if (decision === undefined) {
        // Order intents only ever originate from recorded LIVE decisions — a
        // missing (or replay-only) decision is a caller bug, not a broker
        // condition.
        throw new Error(`SimBroker: no decision found for decisionKey "${intent.decisionKey}"`);
      }

      const orderId = newId();
      const inserted = await tx
        .insert(orders)
        .values({
          id: orderId,
          decisionId: decision.id,
          instrumentId: intent.instrumentId,
          side: intent.side,
          qty: orderQty,
          orderType: intent.orderType,
          tif: intent.tif,
          venue: SIM_VENUE,
          clientOrderId: intent.clientOrderId,
          status: 'pending',
          submittedAt: now,
        })
        .onConflictDoNothing()
        .returning({ id: orders.id });
      if (inserted.length === 0) {
        // Lost a concurrent race on client_order_id: return the winner's ack.
        const winner = await this.ackForExisting(tx, intent.clientOrderId);
        if (winner === undefined) {
          throw new Error('SimBroker: order insert conflicted but no existing row was found');
        }
        return winner;
      }
      await tx
        .insert(orderEvents)
        .values({ id: newId(), orderId, event: 'pending', payload: {}, at: now });

      const reference = await this.latestClose(tx, intent.instrumentId, now, {
        maxAgeMs: REFERENCE_PRICE_MAX_AGE_MS,
      });
      if (reference === undefined) {
        await tx.update(orders).set({ status: 'rejected' }).where(eq(orders.id, orderId));
        await tx.insert(orderEvents).values({
          id: newId(),
          orderId,
          event: 'rejected',
          payload: { reason: NO_REFERENCE_PRICE },
          at: now,
        });
        return { brokerOrderId: orderId, status: 'rejected', reason: NO_REFERENCE_PRICE };
      }

      const fill = simulateFill({
        intent,
        referencePrice: reference.close,
        slippageBps: this.slippageBps,
        feeBps: this.feeBpsByAssetClass[intent.assetClass],
        now,
      });
      await tx.insert(fills).values({
        id: newId(),
        orderId,
        fillQty: fill.fillQty,
        fillPrice: fill.fillPrice,
        fee: fill.fee,
        filledAt: fill.filledAt,
        isSimulated: true,
      });
      await tx.insert(orderEvents).values({
        id: newId(),
        orderId,
        event: 'filled',
        payload: {
          fillPrice: fill.fillPrice,
          fillQty: fill.fillQty,
          fee: fill.fee,
          referencePrice: reference.close,
          referenceTs: reference.ts.toISOString(),
        },
        at: now,
      });
      await tx
        .update(orders)
        .set({ status: 'filled', brokerOrderId: orderId })
        .where(eq(orders.id, orderId));

      return { brokerOrderId: orderId, status: 'accepted' };
    });
  }

  /** Open positions derived from all sim fills (see positions.ts lot method). */
  async getPositions(): Promise<BrokerPosition[]> {
    const portfolio = derivePortfolio(await this.loadSimFills());
    return portfolio.positions.map((position) => ({
      instrumentId: position.instrumentId,
      qty: position.qty,
      avgEntryPrice: position.avgEntryPrice,
    }));
  }

  /**
   * cash = starting cash + Σ sells − Σ buys − fees (exact);
   * equity = cash + Σ open qty × mark, where the mark is the latest recorded
   * bar close ≤ now (no staleness bound — the last known price is the honest
   * paper mark), falling back to the lot's own cost basis when no bar exists.
   */
  async getAccountState(): Promise<BrokerAccountState> {
    const now = this.now();
    const portfolio = derivePortfolio(await this.loadSimFills());
    const cash = add(this.startingCash, parseDec(portfolio.cashDeltaUsd));

    let equity = cash;
    for (const position of portfolio.positions) {
      const qty = parseDec(position.qty);
      const mark = await this.latestClose(this.db, position.instrumentId, now, {});
      const value =
        mark !== undefined
          ? mul(qty, parseDec(mark.close))
          : // No bar at all: value the lot at entry (signed by the qty side).
            mul(qty, parseDec(position.avgEntryPrice));
      equity = add(equity, value);
    }

    return {
      cashUsd: formatDec(roundTo(cash, ACCOUNT_USD_SCALE)),
      equityUsd: formatDec(roundTo(equity, ACCOUNT_USD_SCALE)),
    };
  }

  // -------------------------------------------------------------- internals --

  private async loadSimFills(): Promise<PortfolioFill[]> {
    const rows = await this.db
      .select({
        id: fills.id,
        instrumentId: orders.instrumentId,
        side: orders.side,
        qty: fills.fillQty,
        price: fills.fillPrice,
        fee: fills.fee,
        filledAt: fills.filledAt,
      })
      .from(fills)
      .innerJoin(orders, eq(fills.orderId, orders.id))
      .where(eq(orders.venue, SIM_VENUE))
      .orderBy(asc(fills.filledAt), asc(fills.id));
    return rows;
  }

  /** Ack for an already-persisted client_order_id, or undefined when new. */
  private async ackForExisting(tx: DbTx, clientOrderId: string): Promise<OrderAck | undefined> {
    const rows = await tx
      .select({ id: orders.id, brokerOrderId: orders.brokerOrderId, status: orders.status })
      .from(orders)
      .where(eq(orders.clientOrderId, clientOrderId))
      .limit(1);
    const row = rows[0];
    if (row === undefined) return undefined;
    const brokerOrderId = row.brokerOrderId ?? row.id;
    if (row.status !== 'rejected') return { brokerOrderId, status: 'accepted' };

    const rejection = await tx
      .select({ payload: orderEvents.payload })
      .from(orderEvents)
      .where(and(eq(orderEvents.orderId, row.id), eq(orderEvents.event, 'rejected')))
      .limit(1);
    const reason = rejection[0]?.payload['reason'];
    return {
      brokerOrderId,
      status: 'rejected',
      ...(typeof reason === 'string' ? { reason } : {}),
    };
  }

  /** Latest bar close for the instrument at/before now (optionally age-bounded). */
  private async latestClose(
    tx: DbTx | Db,
    instrumentId: string,
    now: Date,
    options: { maxAgeMs?: number },
  ): Promise<{ close: string; ts: Date } | undefined> {
    const bounds = [eq(priceBars1m.instrumentId, instrumentId), lte(priceBars1m.ts, now)];
    if (options.maxAgeMs !== undefined) {
      bounds.push(gte(priceBars1m.ts, new Date(now.getTime() - options.maxAgeMs)));
    }
    const rows = await tx
      .select({ close: priceBars1m.close, ts: priceBars1m.ts })
      .from(priceBars1m)
      .where(and(...bounds))
      .orderBy(desc(priceBars1m.ts))
      .limit(1);
    return rows[0];
  }
}
