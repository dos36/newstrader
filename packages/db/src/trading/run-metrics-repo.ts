import type { RunMetrics } from '@newstrader/core';
import { eq } from 'drizzle-orm';

import type { Db } from '../client.js';
import { replayRunMetrics } from '../schema.js';

/**
 * replay_run_metrics persistence (M5). One row per simulated run (backtest or
 * replay Mode B), computed by core's computeRunMetrics from the run's own
 * ledger at run end. Conflict-do-nothing: re-invoking a run id is a
 * decisions-level no-op (every insert conflicts), so the metrics computed on
 * the FIRST execution are the ones that describe the run.
 */

export interface PersistRunMetricsInput extends RunMetrics {
  feesUsd: string;
  startingCashUsd: string;
  endingEquityUsd: string;
  stillOpen: number;
}

export async function persistRunMetrics(
  db: Db,
  replayRunId: string,
  metrics: PersistRunMetricsInput,
): Promise<{ inserted: boolean }> {
  const inserted = await db
    .insert(replayRunMetrics)
    .values({
      replayRunId,
      trades: metrics.trades,
      wins: metrics.wins,
      losses: metrics.losses,
      hitRate: metrics.hitRate,
      avgBpsPerTrade: metrics.avgBpsPerTrade,
      profitFactor: metrics.profitFactor,
      maxDrawdownPct: metrics.maxDrawdownPct,
      exposureAdjustedReturnPct: metrics.exposureAdjustedReturnPct,
      realizedUsd: metrics.realizedUsd,
      feesUsd: metrics.feesUsd,
      startingCashUsd: metrics.startingCashUsd,
      endingEquityUsd: metrics.endingEquityUsd,
      stillOpen: metrics.stillOpen,
    })
    .onConflictDoNothing({ target: replayRunMetrics.replayRunId })
    .returning({ replayRunId: replayRunMetrics.replayRunId });
  return { inserted: inserted.length > 0 };
}

export type StoredRunMetrics = typeof replayRunMetrics.$inferSelect;

export async function loadRunMetrics(
  db: Db,
  replayRunId: string,
): Promise<StoredRunMetrics | null> {
  const rows = await db
    .select()
    .from(replayRunMetrics)
    .where(eq(replayRunMetrics.replayRunId, replayRunId));
  return rows[0] ?? null;
}
