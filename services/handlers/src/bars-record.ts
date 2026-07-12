import {
  ensureBenchmarks,
  fetchKrakenOhlc,
  fetchSnapshotMinuteBars,
  recordSnapshot,
} from '@newstrader/db';
import type { Db, RecordSnapshotDeps } from '@newstrader/db';
import { getSsmParameter } from './lib/aws-api.js';
import { lambdaDb, lazyAsync, requireEnv } from './lib/boot.js';

/**
 * Bars-recorder Lambda (EventBridge Scheduler, rate 1 minute — architecture
 * §5.5): ONE Massive full-market snapshot call covers the whole equity
 * universe + SPY, plus one Kraken OHLC call per coin, first-write-wins into
 * price_bars_1m.
 *
 * The schedule runs 24/7 on purpose: crypto trades weekends, and during the
 * equity off-hours the snapshot's unchanged latest-minute bars simply no-op on
 * the conflict-do-nothing upsert — a wasted call per minute is cheaper than
 * market-calendar logic that would also have to know about halts and holidays.
 *
 * Entitlement caveat (see massive-bars.ts): the snapshot endpoint needs the
 * Stocks Starter subscription; without it the recorder FAILS LOUDLY every tick
 * (status NOT_AUTHORIZED) and the error alarm fires — that is the designed
 * behavior, not something to catch and skip.
 */

interface BarsRecordRuntime {
  db: Db;
  deps: RecordSnapshotDeps;
}

const runtime: () => Promise<BarsRecordRuntime> = lazyAsync(async () => {
  const [db, apiKey] = await Promise.all([
    lambdaDb(),
    getSsmParameter(requireEnv('MASSIVE_API_KEY_PARAM')),
  ]);
  // SPY/BTC must exist or the snapshot silently misses the abnormal-return
  // baseline (loadBarInstruments joins by symbol). Idempotent; once per cold start.
  await ensureBenchmarks(db);
  const massive = { apiKey, baseUrl: process.env['MASSIVE_BASE_URL'] };
  return {
    db,
    deps: {
      fetchEquitySnapshot: (symbols) => fetchSnapshotMinuteBars(massive, symbols),
      fetchCryptoMinuteBars: (symbol) => fetchKrakenOhlc({}, { symbol, interval: 1 }),
    },
  };
});

export const handler = async (): Promise<void> => {
  const { db, deps } = await runtime();
  // recordSnapshot logs its own structured counts (msg: bars_record_snapshot).
  await recordSnapshot(db, deps);
};
