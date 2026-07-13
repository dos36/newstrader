import type { OrderIntent } from '../trading/contracts.js';

import { sha256Hex } from './sha256.js';

/**
 * OrderIntent construction — the double-order guard (architecture §4.2).
 *
 * clientOrderId = sha256(decisionKey) hex, first 32 chars. Deterministic by
 * construction: the same decision can NEVER mint two different order ids, so
 * a redelivered queue message collides on orders.client_order_id (unique)
 * instead of double-ordering. Built here rather than inside decide() because
 * the decisionKey (signal × rules version × replay run) is minted by the DB
 * layer and is not an engine input — the wiring layer calls this right after
 * recording the decision.
 */

export const CLIENT_ORDER_ID_LENGTH = 32;

/** Deterministic idempotent order id for a decision. Same key ⇒ same id, always. */
export function clientOrderIdFor(decisionKey: string): string {
  return sha256Hex(decisionKey).slice(0, CLIENT_ORDER_ID_LENGTH);
}

export interface BuildOrderIntentInput {
  decisionKey: string;
  instrumentId: string;
  assetClass: 'us_equity' | 'crypto';
  /** The opening action decide() returned. */
  action: 'open_long' | 'open_short';
  /** DecideResult.sizedQty — decimal string, already floored per asset class. */
  qty: string;
}

/** Intent for an OPENING decision: open_long buys, open_short sells. */
export function buildOrderIntent(input: BuildOrderIntentInput): OrderIntent {
  return {
    clientOrderId: clientOrderIdFor(input.decisionKey),
    decisionKey: input.decisionKey,
    instrumentId: input.instrumentId,
    assetClass: input.assetClass,
    side: input.action === 'open_long' ? 'buy' : 'sell',
    qty: input.qty,
    orderType: 'market',
    tif: 'day',
  };
}

export interface BuildCloseOrderIntentInput {
  /** The close decision's key — REASON-INDEPENDENT (position-manager.ts), stays fixed across retries. */
  decisionKey: string;
  /**
   * 1-based retry attempt. A close decision can accumulate multiple REJECTED
   * orders before one finally fills; the attempt number keeps each retry's
   * clientOrderId distinct (`${decisionKey}:a${attempt}`) while decisionKey —
   * and therefore the FK the broker resolves it through — never changes.
   */
  attempt: number;
  instrumentId: string;
  assetClass: 'us_equity' | 'crypto';
  /** Side of the OPEN position being closed — a close's side is not derivable from action alone. */
  positionSide: 'long' | 'short';
  /** Full open qty (decimal string) — v1 closes are always whole-position. */
  qty: string;
}

/**
 * Intent for a CLOSE decision (position manager): sell closes longs, buy
 * closes shorts. clientOrderId hashes `decisionKey:a<attempt>` — the SAME
 * sha256 namespace buildOrderIntent uses for entries (a prior revision used
 * the bare decisionKey as clientOrderId directly, a second, unhashed
 * namespace that also could never retry after a rejection).
 */
export function buildCloseOrderIntent(input: BuildCloseOrderIntentInput): OrderIntent {
  return {
    clientOrderId: clientOrderIdFor(`${input.decisionKey}:a${input.attempt}`),
    decisionKey: input.decisionKey,
    instrumentId: input.instrumentId,
    assetClass: input.assetClass,
    side: input.positionSide === 'long' ? 'sell' : 'buy',
    qty: input.qty,
    orderType: 'market',
    tif: 'day',
  };
}
