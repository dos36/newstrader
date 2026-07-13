import {
  ZERO,
  absDec,
  add,
  cmp,
  divRound,
  formatDec,
  isZero,
  mul,
  neg,
  parseDec,
  sub,
} from '@newstrader/core';
import type { Dec } from '@newstrader/core';

/**
 * Pure position/P&L derivation from fills — architecture §3/§5.4: there is NO
 * mutable positions table; positions and P&L are always DERIVED from the
 * append-only `fills` facts. Zero DB access; the SimBroker repo layer feeds
 * this from a query (pure math + repo split, mirroring packages/db/src/reaction).
 *
 * Lot method (documented contract): NET-POSITION WEIGHTED AVERAGE.
 * - Fills are processed chronologically (filledAt, then id — ULIDs, so the
 *   tiebreak is itself time-ordered).
 * - A fill in the direction of the net position (or from flat) adds its
 *   notional to the open lot's cost basis; avg entry = openCost / |netQty|.
 * - A reducing fill realizes P&L against the lot's average entry by removing
 *   a PROPORTIONAL slice of the cost basis. Proportional slices round at
 *   COST_APPORTION_SCALE (8dp) — a full close consumes the exact remaining
 *   basis, so rounding drift never survives a flat position.
 * - A fill crossing through zero closes the whole lot first, then opens the
 *   remainder as a new lot at the fill price.
 *
 * Money integrity: cashDeltaUsd is EXACT (no division touches it) — account
 * equity derives from cash + marks, never from the rounded avg entry.
 */

/** Apportionment scale for partial-close cost slices (matches qty's 8dp). */
export const COST_APPORTION_SCALE = 8;
/** avg entry is reported at the price columns' 6dp scale. */
export const AVG_ENTRY_PRICE_SCALE = 6;

/** The slice of a fills-join-orders row the derivation needs. */
export interface PortfolioFill {
  /** Fill id — chronological tiebreak within one timestamp (ULIDs sort by time). */
  id: string;
  instrumentId: string;
  side: 'buy' | 'sell';
  /** Decimal strings straight from the numeric columns. */
  qty: string;
  price: string;
  fee: string;
  filledAt: Date;
}

export interface DerivedPosition {
  instrumentId: string;
  /** Signed decimal string (negative = short). */
  qty: string;
  /** Net-position weighted average entry of the open lot, 6dp. */
  avgEntryPrice: string;
  /** Exact remaining cost basis of the open lot (≥ 0, unsigned). */
  openCostUsd: string;
}

export interface DerivedPortfolio {
  /** Open positions only (net qty ≠ 0). */
  positions: DerivedPosition[];
  /** Realized P&L across all closed quantity, fees NOT deducted. */
  realizedPnlUsd: string;
  /** Total fees paid. */
  feesUsd: string;
  /** Exact cash effect of all fills: Σ sells − Σ buys − fees. */
  cashDeltaUsd: string;
}

interface LotState {
  /** Signed net quantity. */
  qty: Dec;
  /** Unsigned cost basis of the open lot (entry notional). */
  openCost: Dec;
}

/** Derive open positions, realized P&L, fees, and the exact cash delta. */
export function derivePortfolio(fills: readonly PortfolioFill[]): DerivedPortfolio {
  const ordered = [...fills].sort(
    (a, b) => a.filledAt.getTime() - b.filledAt.getTime() || a.id.localeCompare(b.id),
  );

  const lots = new Map<string, LotState>();
  let realized = ZERO;
  let fees = ZERO;
  let cashDelta = ZERO;

  for (const fill of ordered) {
    const qty = parseDec(fill.qty);
    const price = parseDec(fill.price);
    const fee = parseDec(fill.fee);
    if (qty.units <= 0n) throw new Error(`derivePortfolio: fill ${fill.id} has non-positive qty`);
    if (price.units <= 0n) {
      throw new Error(`derivePortfolio: fill ${fill.id} has non-positive price`);
    }
    if (fee.units < 0n) throw new Error(`derivePortfolio: fill ${fill.id} has negative fee`);

    const notional = mul(price, qty);
    cashDelta = sub(fill.side === 'buy' ? sub(cashDelta, notional) : add(cashDelta, notional), fee);
    fees = add(fees, fee);

    const signed = fill.side === 'buy' ? qty : neg(qty);
    const lot = lots.get(fill.instrumentId) ?? { qty: ZERO, openCost: ZERO };

    if (isZero(lot.qty) || lot.qty.units > 0n === signed.units > 0n) {
      // Opening or adding: extend the lot; avg entry shifts via the cost basis.
      lots.set(fill.instrumentId, {
        qty: add(lot.qty, signed),
        openCost: add(lot.openCost, notional),
      });
      continue;
    }

    // Reducing (and possibly crossing through zero).
    const lotAbs = absDec(lot.qty);
    const fullClose = cmp(qty, lotAbs) >= 0;
    const closeQty = fullClose ? lotAbs : qty;
    const closedCost = fullClose
      ? lot.openCost
      : divRound(mul(lot.openCost, closeQty), lotAbs, COST_APPORTION_SCALE);
    const closeNotional = mul(price, closeQty);
    const pnl =
      lot.qty.units > 0n ? sub(closeNotional, closedCost) : sub(closedCost, closeNotional);
    realized = add(realized, pnl);

    const remainder = sub(qty, closeQty); // opens in the fill's direction past zero
    if (isZero(remainder)) {
      lots.set(fill.instrumentId, {
        qty: add(lot.qty, signed),
        openCost: fullClose ? ZERO : sub(lot.openCost, closedCost),
      });
    } else {
      lots.set(fill.instrumentId, {
        qty: signed.units > 0n ? remainder : neg(remainder),
        openCost: mul(price, remainder),
      });
    }
  }

  const positions: DerivedPosition[] = [];
  for (const [instrumentId, lot] of lots) {
    if (isZero(lot.qty)) continue;
    positions.push({
      instrumentId,
      qty: formatDec(lot.qty),
      avgEntryPrice: formatDec(divRound(lot.openCost, absDec(lot.qty), AVG_ENTRY_PRICE_SCALE)),
      openCostUsd: formatDec(lot.openCost),
    });
  }

  return {
    positions,
    realizedPnlUsd: formatDec(realized),
    feesUsd: formatDec(fees),
    cashDeltaUsd: formatDec(cashDelta),
  };
}
