import {
  backfillEventWindows,
  ensureBenchmarks,
  ensureDailyBars,
  fetchAggsBars,
  fetchKrakenOhlc,
  measureReactions,
} from '@newstrader/db';
import type { BackfillDeps, Db, EnsureDailyBarsDeps } from '@newstrader/db';
import { getSsmParameter } from './lib/aws-api.js';
import { intEnv, lambdaDb, lazyAsync, requireEnv } from './lib/boot.js';

/**
 * Nightly analytics Lambda (EventBridge Scheduler): the architecture §1
 * "nightly" job — daily bars, then reaction/recovery measurements.
 *
 * Sequence per run (each step logs its own structured counts):
 *   1. ensureBenchmarks — idempotent SPY/BTC seeds.
 *   2. ensureDailyBars — top up the beta window (90 d before the oldest anchor
 *      in scope, plus margin for non-trading days).
 *   3. backfillEventWindows — minute bars around every cluster in the window.
 *      Re-running over the whole window is REQUIRED, not waste: an event
 *      window extends 5 d past its anchor, so bars recorded after the first
 *      backfill only arrive by re-fetching the window on later nights
 *      (conflict-do-nothing makes the overlap a cheap no-op).
 *   4. measureReactions — the ladder/summary/recovery writes.
 *
 * MEASURE_SINCE_HOURS defaults to 216 (9 days), NOT ~48: the measurer fills
 * horizons per-horizon as they settle (reaction_measurements PK includes
 * horizon), and a 5d horizon landing on a weekend needs up to ~8-9 days of
 * window before its settling proof-bar exists (see measure-repo.ts). A 48 h
 * window would permanently strand every 3d/5d horizon.
 */

interface MeasureRuntime {
  db: Db;
  dailyDeps: EnsureDailyBarsDeps;
  backfillDeps: BackfillDeps;
}

const runtime: () => Promise<MeasureRuntime> = lazyAsync(async () => {
  const [db, apiKey] = await Promise.all([
    lambdaDb(),
    getSsmParameter(requireEnv('MASSIVE_API_KEY_PARAM')),
  ]);
  const massive = { apiKey, baseUrl: process.env['MASSIVE_BASE_URL'] };
  return {
    db,
    dailyDeps: {
      fetchEquityDailyBars: (symbol, fromMs, toMs) =>
        fetchAggsBars(massive, { symbol, timespan: 'day', fromMs, toMs }),
      fetchCryptoDailyBars: (symbol) => fetchKrakenOhlc({}, { symbol, interval: 1440 }),
    },
    backfillDeps: {
      fetchEquityMinuteBars: (symbol, fromMs, toMs) =>
        fetchAggsBars(massive, { symbol, timespan: 'minute', fromMs, toMs }),
      fetchCryptoMinuteBars: (symbol) => fetchKrakenOhlc({}, { symbol, interval: 1 }),
    },
  };
});

export const handler = async (): Promise<void> => {
  const { db, dailyDeps, backfillDeps } = await runtime();
  const sinceHours = intEnv('MEASURE_SINCE_HOURS', 216);
  const now = new Date();

  await ensureBenchmarks(db);
  const lookbackDays = Math.ceil(sinceHours / 24) + 100;
  await ensureDailyBars(db, dailyDeps, { lookbackDays });
  await backfillEventWindows(db, backfillDeps, {
    from: new Date(now.getTime() - sinceHours * 3_600_000),
    to: now,
  });
  await measureReactions(db, { sinceHours, now });
};
