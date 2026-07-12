import { newId } from '@newstrader/core';

import type { Db } from '../client.js';
import { instruments } from '../schema.js';

/**
 * Benchmark instruments for abnormal-return math (architecture §5.6):
 * equities measure against SPY, crypto alts against BTC.
 *
 * SPY is NOT an S&P 500 member and never a signal target — it exists purely
 * as the beta/benchmark baseline, so it is seeded here (idempotently) rather
 * than arriving via the universe sync. It still needs bars, which is why the
 * bars repo folds BENCHMARK_SYMBOLS into every symbol set it records.
 *
 * BTC doubles as a universe member (CRYPTO_SEEDS) and the crypto benchmark;
 * the universe sync owns its row, but ensureBenchmarks seeds it too
 * (conflict-do-nothing) so bar jobs can run before the first universe sync
 * without a missing-instrument failure. A later sync upgrades the row in
 * place via its own onConflictDoUpdate.
 */

export const BENCHMARK_SYMBOLS = {
  us_equity: 'SPY',
  crypto: 'BTC',
} as const;

const BENCHMARK_SEEDS: readonly (typeof instruments.$inferInsert)[] = [
  {
    id: '', // replaced per insert — newId() must be fresh each call
    symbol: BENCHMARK_SYMBOLS.us_equity,
    assetClass: 'us_equity',
    name: 'SPDR S&P 500 ETF',
  },
  {
    id: '',
    symbol: BENCHMARK_SYMBOLS.crypto,
    assetClass: 'crypto',
    name: 'Bitcoin',
  },
];

/** Idempotently insert the benchmark instruments. Returns how many were new. */
export async function ensureBenchmarks(db: Db): Promise<{ inserted: number }> {
  let inserted = 0;
  for (const seed of BENCHMARK_SEEDS) {
    const rows = await db
      .insert(instruments)
      .values({ ...seed, id: newId() })
      .onConflictDoNothing({ target: [instruments.symbol, instruments.assetClass] })
      .returning({ id: instruments.id });
    inserted += rows.length;
  }
  console.log(JSON.stringify({ level: 'info', msg: 'bars_ensure_benchmarks', inserted }));
  return { inserted };
}
