import { evaluateExit, HORIZON_DURATION_MS, type RulesConfig } from '@newstrader/core';
import { and, asc, eq, gt, lte } from 'drizzle-orm';

import type { Db } from '../client.js';
import { priceBars1m } from '../schema.js';
import type { BacktestLedger } from './ledger.js';

/**
 * The simulated-portfolio exit walker, shared by backtest mode and replay
 * Mode B (both drive a BacktestLedger through history; neither may touch the
 * live fills tables). Extracted from backtest.ts unchanged — one walker, so
 * the two counterfactual paths can never disagree about when a stop fires.
 */

/** Cap the per-position exit walk so one stale position cannot scan forever. */
const MAX_EXIT_WALK_BARS = 20_000;

/**
 * Close every open position whose exit rule fires at or before `until` (null =
 * run to the end of available bars). Walks each position's minute bars forward
 * from entry, so a stop is found at the first bar that triggers it rather than
 * at whichever bar the next signal happens to land on.
 */
export async function settleExitsUpTo(
  db: Db,
  ledger: BacktestLedger,
  assetClassById: Map<string, 'us_equity' | 'crypto'>,
  exits: RulesConfig['exits'],
  until: Date | null,
): Promise<void> {
  for (const position of ledger.openPositions()) {
    const side = Number(position.qty) > 0 ? 'long' : 'short';
    const atr = position.atrAtEntry;
    const horizonEnd = new Date(
      position.openedAt.getTime() + HORIZON_DURATION_MS[position.horizon],
    );
    const walkTo =
      until === null ? horizonEnd : new Date(Math.min(until.getTime(), horizonEnd.getTime()));

    const bars = await db
      .select({ ts: priceBars1m.ts, close: priceBars1m.close })
      .from(priceBars1m)
      .where(
        and(
          eq(priceBars1m.instrumentId, position.instrumentId),
          gt(priceBars1m.ts, position.openedAt),
          lte(priceBars1m.ts, walkTo),
        ),
      )
      .orderBy(asc(priceBars1m.ts))
      .limit(MAX_EXIT_WALK_BARS);

    for (const bar of bars) {
      // No ATR means sizing had none either; only the time stop can fire, which
      // evaluateExit handles with a zero stop distance.
      const evaluation = evaluateExit({
        entryPrice: position.avgEntryPrice,
        qty: position.qty,
        side,
        openedAt: position.openedAt,
        horizon: position.horizon,
        atrAtEntry: atr ?? '0',
        config: exits,
        latestPrice: bar.close,
        now: bar.ts,
      });
      if (evaluation.shouldClose) {
        ledger.fillClose({
          instrumentId: position.instrumentId,
          assetClass: assetClassById.get(position.instrumentId) ?? 'us_equity',
          referencePrice: bar.close,
          at: bar.ts,
          reason: evaluation.reason ?? 'unknown',
        });
        break;
      }
    }
  }
}
