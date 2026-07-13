import type { OrderIntent } from '../trading/contracts.js';
import {
  ONE,
  add,
  divRound,
  formatDec,
  mul,
  numberToDec,
  parseDec,
  roundTo,
  sub,
} from './decimal.js';
import type { Dec } from './decimal.js';

/**
 * SimBroker fill model — architecture §7 backend 1. PURE: no I/O, no clock
 * (the fill timestamp is the caller's `now` parameter), no randomness. The
 * same function fills live paper orders and replay Mode B orders, which is
 * what makes live-paper results and backtests directly comparable.
 *
 * v1 semantics: market orders only (OrderIntent.orderType is a 'market'
 * literal), always filled FULLY at the reference price adjusted by an
 * explicit slippage model in the ADVERSE direction — buys pay up, sells
 * receive less. Fees are a flat bps of fill notional.
 *
 * Every output is rounded to the exact scale of its `fills` column
 * (half-away-from-zero, matching Postgres numeric rounding), so the value
 * returned here is bit-identical to the value read back from the row.
 */

/** Default one-way slippage applied to the reference price, in bps. */
export const SIM_SLIPPAGE_BPS = 5;

/**
 * Default simulated fee by asset class, in bps of fill notional.
 *
 * - us_equity 0: IBKR-tier per-share commissions are sub-bp at our sizes and
 *   are deliberately modeled as zero until the IBKR-paper stage measures them.
 * - crypto 26: Kraken-taker-ish. Kraken spot taker fees start at 0.40% for
 *   restricted-dealer Canadian accounts and fall with volume toward the
 *   classic 0.26% pro-tier taker rate; 26 bps is the honest middle used until
 *   the dust-size live calibration phase (architecture §7) measures reality.
 */
export const SIM_FEE_BPS: Readonly<Record<OrderIntent['assetClass'], number>> = {
  us_equity: 0,
  crypto: 26,
};

/** fills.fill_price is numeric(18,6). */
export const FILL_PRICE_SCALE = 6;
/** fills.fill_qty is numeric(20,8). */
export const FILL_QTY_SCALE = 8;
/** fills.fee is numeric(18,6). */
export const FILL_FEE_SCALE = 6;

export interface SimulateFillInput {
  intent: OrderIntent;
  /** Reference price (decimal string) — latest recorded bar close. */
  referencePrice: string;
  /** One-way slippage in bps; defaults to SIM_SLIPPAGE_BPS. */
  slippageBps?: number | undefined;
  /** Fee in bps of notional; defaults to SIM_FEE_BPS[intent.assetClass]. */
  feeBps?: number | undefined;
  /** Injected clock — becomes filledAt verbatim (purity: no Date.now()). */
  now: Date;
}

export interface SimulatedFill {
  /** Decimal string, 6dp (fills.fill_price scale). */
  fillPrice: string;
  /** Decimal string, 8dp (fills.fill_qty scale). */
  fillQty: string;
  /** Decimal string, 6dp (fills.fee scale), always ≥ 0. */
  fee: string;
  filledAt: Date;
}

/**
 * Fill a market order fully at referencePrice × (1 ± slippageBps/10000),
 * signed adversely (buy +, sell −), with fee = notional × feeBps/10000.
 */
export function simulateFill(input: SimulateFillInput): SimulatedFill {
  const { intent, now } = input;
  const slippageBps = input.slippageBps ?? SIM_SLIPPAGE_BPS;
  const feeBps = input.feeBps ?? SIM_FEE_BPS[intent.assetClass];
  if (slippageBps < 0) throw new Error(`simulateFill: negative slippageBps ${String(slippageBps)}`);
  if (feeBps < 0) throw new Error(`simulateFill: negative feeBps ${String(feeBps)}`);

  const reference = parseDec(input.referencePrice);
  if (reference.units <= 0n) {
    throw new Error(`simulateFill: referencePrice "${input.referencePrice}" must be positive`);
  }
  const qty = roundTo(parseDec(intent.qty), FILL_QTY_SCALE);
  if (qty.units <= 0n) {
    throw new Error(`simulateFill: qty "${intent.qty}" must be positive at ${FILL_QTY_SCALE}dp`);
  }

  const slip = bpsToFraction(slippageBps);
  const factor = intent.side === 'buy' ? add(ONE, slip) : sub(ONE, slip);
  const fillPrice = roundTo(mul(reference, factor), FILL_PRICE_SCALE);
  if (fillPrice.units <= 0n) {
    throw new Error(
      `simulateFill: slippage ${String(slippageBps)}bps produced a non-positive sell fill price`,
    );
  }

  const fee = roundTo(mul(mul(fillPrice, qty), bpsToFraction(feeBps)), FILL_FEE_SCALE);

  return {
    fillPrice: formatDec(fillPrice),
    fillQty: formatDec(qty),
    fee: formatDec(fee),
    filledAt: now,
  };
}

/** bps → exact fraction (5 bps → 0.0005). Exact for any finite decimal knob. */
function bpsToFraction(bps: number): Dec {
  const dec = numberToDec(bps);
  // Dividing by 10^4 is exact: just deepen the scale by 4.
  return divRound(dec, { units: 10_000n, scale: 0 }, dec.scale + 4);
}
