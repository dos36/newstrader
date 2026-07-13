import type { GateResult, RulesConfig } from '../trading/contracts.js';

import {
  divScaled,
  floorScaledTo,
  formatScaled,
  mulScaled,
  parseScaled,
  scaledFromNumber,
} from './decimal.js';

/**
 * Pure position sizing — architecture §7 risk framing, fixed-point math
 * (see decimal.ts for why floats are banned on this path).
 *
 *   riskUsd      = equity × riskBpsOfEquity / 10 000
 *   stopDistance = atrStopMultiple × ATR          (price terms)
 *   qty          = riskUsd / stopDistance          → floored per asset class
 *   notional     = qty × price, hard-capped at maxPositionNotionalPct × equity
 *                  (qty is recomputed FROM the cap when it binds, then re-floored)
 *
 * Sizing failures are gates, not errors — a decision that could not be sized
 * still records WHY on the decisions row:
 *   - atr_available     — ATR null (unknown volatility is untradeable), or so
 *                         small the stop distance truncates to zero.
 *   - position_too_small — qty ≤ 0 after flooring (risk budget can't buy one
 *                         whole share / one satoshi-quantum of the asset).
 *
 * A non-positive quote price, by contrast, THROWS: that is corrupt input from
 * the wiring layer, not a tradeable condition to record.
 */

export type SizingSkipReason = 'atr_available' | 'position_too_small';

export interface SizingInput {
  assetClass: 'us_equity' | 'crypto';
  /** ATR in price terms (decimal string); null = unknown. */
  atr: string | null;
  /** Paper account equity in USD (decimal string). */
  paperEquityUsd: string;
  /** Decision-time price from the quote snapshot (decimal string). */
  price: string;
  sizing: RulesConfig['sizing'];
}

export type SizingOutcome =
  | { sized: true; qty: string; notional: string; gates: GateResult[] }
  | { sized: false; skipReason: SizingSkipReason; gates: GateResult[] };

/** Qty granularity: whole shares for equities; 8 dp (satoshi-scale) for crypto. */
export const QTY_DECIMALS: Record<SizingInput['assetClass'], number> = {
  us_equity: 0,
  crypto: 8,
};

export function sizePosition(input: SizingInput): SizingOutcome {
  const gates: GateResult[] = [];

  const stopMultiple = scaledFromNumber(input.sizing.atrStopMultiple, 'sizing.atrStopMultiple');
  const stopDistance =
    input.atr === null ? null : mulScaled(stopMultiple, parseScaled(input.atr, 'features.atr'));

  gates.push({
    gate: 'atr_available',
    pass: stopDistance !== null && stopDistance > 0n,
    observed: input.atr,
    threshold: null,
  });
  if (stopDistance === null || stopDistance <= 0n) {
    return { sized: false, skipReason: 'atr_available', gates };
  }

  const equity = parseScaled(input.paperEquityUsd, 'features.paperEquityUsd');
  const price = parseScaled(input.price, 'quote.price');
  if (price <= 0n) {
    throw new Error(`sizing requires a positive quote price, got "${input.price}"`);
  }

  const riskBps = scaledFromNumber(input.sizing.riskBpsOfEquity, 'sizing.riskBpsOfEquity');
  const riskUsd = mulScaled(equity, riskBps) / 10_000n;

  const decimals = QTY_DECIMALS[input.assetClass];
  let qty = floorScaledTo(divScaled(riskUsd, stopDistance), decimals);
  let notional = mulScaled(qty, price);

  const capPct = scaledFromNumber(
    input.sizing.maxPositionNotionalPct,
    'sizing.maxPositionNotionalPct',
  );
  const notionalCap = mulScaled(equity, capPct);
  if (notional > notionalCap) {
    qty = floorScaledTo(divScaled(notionalCap, price), decimals);
    notional = mulScaled(qty, price);
  }

  gates.push({
    gate: 'position_too_small',
    pass: qty > 0n,
    observed: formatScaled(qty),
    threshold: '0',
  });
  if (qty <= 0n) {
    return { sized: false, skipReason: 'position_too_small', gates };
  }

  return { sized: true, qty: formatScaled(qty), notional: formatScaled(notional), gates };
}
