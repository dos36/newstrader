import { and, eq, gt, gte, isNull, lte, or } from 'drizzle-orm';

import type { Db } from '../client.js';
import {
  indexMembership,
  instruments,
  itemInstrumentLinks,
  newsClusterItems,
  newsClusters,
  priceBars1d,
  priceBars1m,
} from '../schema.js';
import { MIN_LINK_CONFIDENCE } from '../shared-constants.js';
import { SPX_INDEX_CODE } from '../universe/sync.js';
import { BENCHMARK_SYMBOLS } from './benchmarks.js';
import { isKrakenSymbol, SOURCE_KRAKEN, type KrakenSymbol } from './kraken-bars.js';
import { SOURCE_MASSIVE_AGGS, SOURCE_MASSIVE_SNAPSHOT } from './massive-bars.js';
import type { ParsedBar, SymbolBar } from './massive-bars.js';
import { coalesceWindows, eventWindow, type WindowMs } from './windows.js';

/**
 * Bars repository — architecture §5.5.
 *
 * Bars are IMMUTABLE FACTS: every write is INSERT … ON CONFLICT
 * (instrument_id, ts) DO NOTHING, so a re-recorded bar never overwrites what
 * was recorded first. If two pipes disagree about the same (instrument, ts)
 * — e.g. the 15-min-delayed snapshot vs a later consolidated aggregates
 * backfill — the disagreement is DETECTED by re-backfilling the range into a
 * staging table/query and diffing against price_bars_1m, never by clobbering
 * the stored row. The `source` column says which pipe won the initial write.
 */

export interface BarUpsertRow extends ParsedBar {
  instrumentId: string;
  /** Which pipe produced the row: massive_snapshot | massive_aggs | kraken. */
  source: string;
}

const CHUNK_SIZE = 500;

/** Insert minute bars, first-write-wins. Returns how many rows were actually new. */
export async function upsertBars1m(db: Db, rows: readonly BarUpsertRow[]): Promise<number> {
  let inserted = 0;
  for (const chunk of chunks(rows, CHUNK_SIZE)) {
    const written = await db
      .insert(priceBars1m)
      .values(chunk.map(toInsertValues))
      .onConflictDoNothing({ target: [priceBars1m.instrumentId, priceBars1m.ts] })
      .returning({ instrumentId: priceBars1m.instrumentId });
    inserted += written.length;
  }
  return inserted;
}

/** Insert daily bars, first-write-wins. Returns how many rows were actually new. */
export async function upsertBars1d(db: Db, rows: readonly BarUpsertRow[]): Promise<number> {
  let inserted = 0;
  for (const chunk of chunks(rows, CHUNK_SIZE)) {
    const written = await db
      .insert(priceBars1d)
      .values(chunk.map(toInsertValues))
      .onConflictDoNothing({ target: [priceBars1d.instrumentId, priceBars1d.ts] })
      .returning({ instrumentId: priceBars1d.instrumentId });
    inserted += written.length;
  }
  return inserted;
}

/** price_bars_1m and price_bars_1d share this column shape. */
function toInsertValues(row: BarUpsertRow): typeof priceBars1m.$inferInsert {
  return {
    instrumentId: row.instrumentId,
    ts: row.ts,
    open: row.open,
    high: row.high,
    low: row.low,
    close: row.close,
    volume: row.volume,
    source: row.source,
  };
}

// -------------------------------------------------------------- universe --

export interface BarInstrument {
  id: string;
  symbol: string;
  assetClass: 'us_equity' | 'crypto';
}

/**
 * Instruments whose bars we record: the point-in-time SPX membership as of
 * `asOf` (never "current members" — survivorship guard), every crypto
 * instrument, and the benchmarks (SPY is not an SPX member, so the membership
 * join alone would silently starve the abnormal-return baseline of bars).
 */
export async function loadBarInstruments(db: Db, asOf: Date): Promise<BarInstrument[]> {
  const selection = {
    id: instruments.id,
    symbol: instruments.symbol,
    assetClass: instruments.assetClass,
  };
  const [members, crypto, benchmarks] = await Promise.all([
    db
      .selectDistinct(selection)
      .from(instruments)
      .innerJoin(indexMembership, eq(indexMembership.instrumentId, instruments.id))
      .where(
        and(
          eq(indexMembership.indexCode, SPX_INDEX_CODE),
          lte(indexMembership.validFrom, asOf),
          or(isNull(indexMembership.validTo), gt(indexMembership.validTo, asOf)),
        ),
      ),
    db.select(selection).from(instruments).where(eq(instruments.assetClass, 'crypto')),
    db
      .select(selection)
      .from(instruments)
      .where(
        and(
          eq(instruments.symbol, BENCHMARK_SYMBOLS.us_equity),
          eq(instruments.assetClass, 'us_equity'),
        ),
      ),
  ]);
  const byId = new Map<string, BarInstrument>();
  for (const row of [...members, ...crypto, ...benchmarks]) {
    byId.set(row.id, row);
  }
  return [...byId.values()];
}

// -------------------------------------------------------------- snapshot --

export interface RecordSnapshotDeps {
  /**
   * e.g. (symbols) => fetchSnapshotMinuteBars({ apiKey, … }, symbols) — ONE
   * full-market call, already filtered to the requested symbol set.
   * Starter-tier data is 15-min delayed; fine for batch analytics.
   */
  fetchEquitySnapshot: (symbols: ReadonlySet<string>) => Promise<readonly SymbolBar[]>;
  /** e.g. (symbol) => fetchKrakenOhlc({}, { symbol, interval: 1 }) — ≤ ~12 h of minute bars. */
  fetchCryptoMinuteBars: (symbol: KrakenSymbol) => Promise<readonly ParsedBar[]>;
  /** Injectable clock (tests); also the membership asOf. */
  now?: () => Date;
}

export interface RecordSnapshotCounts {
  equitySymbols: number;
  equityBarsUpserted: number;
  cryptoInstruments: number;
  cryptoBarsUpserted: number;
}

/**
 * One recorder tick: load the current universe (point-in-time membership as
 * of now + crypto + benchmarks), poll Kraken per coin FIRST, then take one
 * Massive full-market snapshot for ALL equity symbols, first-write-wins
 * upserting each leg into price_bars_1m as soon as it is fetched.
 *
 * Crypto runs first and its error (if any) is never swallowed by the equity
 * leg's: Kraken OHLC only serves ~12 h of history, so a tick's crypto bars
 * that are never fetched are gone forever, while a failed/missing equity
 * snapshot (e.g. the Massive Starter entitlement lapses) can always be
 * re-backfilled later from aggregates. If the equity leg throws, its error is
 * still rethrown — the Lambda alarm must still fire — but only AFTER the
 * crypto bars this tick found are safely persisted.
 */
export async function recordSnapshot(
  db: Db,
  deps: RecordSnapshotDeps,
): Promise<RecordSnapshotCounts> {
  const now = (deps.now ?? (() => new Date()))();
  const universe = await loadBarInstruments(db, now);

  const equities = universe.filter((i) => i.assetClass === 'us_equity');
  const cryptos = universe.filter((i) => i.assetClass === 'crypto');
  const idBySymbol = new Map(equities.map((i) => [i.symbol, i.id]));

  let cryptoBarsUpserted = 0;
  for (const coin of cryptos) {
    const rows = (await fetchCryptoOrThrow(deps.fetchCryptoMinuteBars, coin)).map((bar) => ({
      instrumentId: coin.id,
      source: SOURCE_KRAKEN,
      ...bar,
    }));
    cryptoBarsUpserted += await upsertBars1m(db, rows);
  }

  let equityBarsUpserted = 0;
  let equityError: unknown;
  try {
    const snapshot = await deps.fetchEquitySnapshot(new Set(idBySymbol.keys()));
    const equityRows: BarUpsertRow[] = snapshot.map(({ symbol, bar }) => {
      const instrumentId = idBySymbol.get(symbol);
      if (instrumentId === undefined) {
        // The fetcher filters to the set we passed; an unknown symbol is a bug.
        throw new Error(`snapshot returned symbol ${symbol} outside the requested universe`);
      }
      return { instrumentId, source: SOURCE_MASSIVE_SNAPSHOT, ...bar };
    });
    equityBarsUpserted = await upsertBars1m(db, equityRows);
  } catch (error) {
    equityError = error;
  }

  const counts: RecordSnapshotCounts = {
    equitySymbols: idBySymbol.size,
    equityBarsUpserted,
    cryptoInstruments: cryptos.length,
    cryptoBarsUpserted,
  };
  console.log(JSON.stringify({ level: 'info', msg: 'bars_record_snapshot', ...counts }));
  if (equityError !== undefined) throw equityError;
  return counts;
}

// -------------------------------------------------------- event backfill --

export interface BackfillDeps {
  /**
   * e.g. (symbol, fromMs, toMs) =>
   *   fetchAggsBars({ apiKey, … }, { symbol, timespan: 'minute', fromMs, toMs })
   */
  fetchEquityMinuteBars: (
    symbol: string,
    fromMs: number,
    toMs: number,
  ) => Promise<readonly ParsedBar[]>;
  /**
   * Kraken OHLC serves only the most recent ~720 minute candles (~12 h), so
   * crypto backfill is best-effort: bars outside that horizon are counted as
   * gap windows and warn-logged, never silently faked. Deep crypto history is
   * a flat-file import (architecture §5.5), not this path.
   */
  fetchCryptoMinuteBars: (symbol: KrakenSymbol) => Promise<readonly ParsedBar[]>;
  /** Self-throttle between sequential Massive calls (Starter etiquette ~5 req/s). */
  sleep?: (ms: number) => Promise<void>;
  /** Default 250 ms (~4 req/s). */
  throttleMs?: number;
}

export interface BackfillRange {
  /** Cluster first_received_at range (inclusive) to backfill, OUR clock. */
  from: Date;
  to: Date;
}

export interface BackfillCounts {
  clusters: number;
  instruments: number;
  windowsRequested: number;
  windowsCoalesced: number;
  barsUpserted: number;
  cryptoGapWindows: number;
  /** Equity windows whose vendor call returned zero bars (unentitled key, delisting, etc). */
  equityEmptyWindows: number;
}

/**
 * Backfill minute bars around every cluster in the range that has a
 * SUFFICIENTLY CONFIDENT resolved instrument link (news_cluster_items →
 * item_instrument_links at/above MIN_LINK_CONFIDENCE — the same bar the
 * measurer gates on, so this never spends a rate-limited vendor call fetching
 * windows for a link the measurer will then ignore). Each anchor
 * (cluster.first_received_at — OUR clock, never published_at) expands to
 * [anchor − 72 h, anchor + 5 d]; overlapping windows are coalesced per
 * instrument before any vendor call, and Massive fetches run sequentially
 * with a self-throttle.
 *
 * Every asset class present in the plan ALSO gets a plan entry for that
 * class's benchmark instrument (BENCHMARK_SYMBOLS — SPY / BTC), covering the
 * coalesced union of every window requested for that class. SPY is never
 * news-linked, so without this the equity abnormal-return baseline would
 * silently degrade to raw (reaction/measure-repo.ts needs benchmark bars to
 * compute beta/abnormal returns). Skipped when the benchmark instrument is
 * itself already in the plan (e.g. BTC, which is both a universe member and
 * the crypto benchmark) or does not exist yet (ensureBenchmarks not run).
 */
export async function backfillEventWindows(
  db: Db,
  deps: BackfillDeps,
  range: BackfillRange,
): Promise<BackfillCounts> {
  const sleep = deps.sleep ?? defaultSleep;
  const throttleMs = deps.throttleMs ?? 250;

  const rows = await db
    .selectDistinct({
      clusterId: newsClusters.id,
      anchor: newsClusters.firstReceivedAt,
      instrumentId: instruments.id,
      symbol: instruments.symbol,
      assetClass: instruments.assetClass,
    })
    .from(newsClusters)
    .innerJoin(newsClusterItems, eq(newsClusterItems.clusterId, newsClusters.id))
    .innerJoin(itemInstrumentLinks, eq(itemInstrumentLinks.itemId, newsClusterItems.itemId))
    .innerJoin(instruments, eq(instruments.id, itemInstrumentLinks.instrumentId))
    .where(
      and(
        gte(newsClusters.firstReceivedAt, range.from),
        lte(newsClusters.firstReceivedAt, range.to),
        gte(itemInstrumentLinks.confidence, MIN_LINK_CONFIDENCE),
      ),
    );

  interface Plan {
    instrument: BarInstrument;
    windows: WindowMs[];
  }
  const clusterIds = new Set<string>();
  const plans = new Map<string, Plan>();
  const windowsByAssetClass = new Map<BarInstrument['assetClass'], WindowMs[]>();
  let windowsRequested = 0;
  for (const row of rows) {
    clusterIds.add(row.clusterId);
    const plan = plans.get(row.instrumentId) ?? {
      instrument: { id: row.instrumentId, symbol: row.symbol, assetClass: row.assetClass },
      windows: [],
    };
    const window = eventWindow(row.anchor);
    plan.windows.push(window);
    windowsRequested += 1;
    plans.set(row.instrumentId, plan);

    const classWindows = windowsByAssetClass.get(row.assetClass) ?? [];
    classWindows.push(window);
    windowsByAssetClass.set(row.assetClass, classWindows);
  }

  if (windowsByAssetClass.size > 0) {
    const benchmarkRows = await db
      .select({
        id: instruments.id,
        symbol: instruments.symbol,
        assetClass: instruments.assetClass,
      })
      .from(instruments)
      .where(
        or(
          and(
            eq(instruments.symbol, BENCHMARK_SYMBOLS.us_equity),
            eq(instruments.assetClass, 'us_equity'),
          ),
          and(
            eq(instruments.symbol, BENCHMARK_SYMBOLS.crypto),
            eq(instruments.assetClass, 'crypto'),
          ),
        ),
      );
    for (const benchmarkRow of benchmarkRows) {
      if (plans.has(benchmarkRow.id)) continue; // already planned (e.g. BTC is its own benchmark)
      const classWindows = windowsByAssetClass.get(benchmarkRow.assetClass);
      if (classWindows === undefined) continue; // no clusters of this asset class this run
      plans.set(benchmarkRow.id, { instrument: benchmarkRow, windows: [...classWindows] });
    }
  }

  let barsUpserted = 0;
  let windowsCoalesced = 0;
  let cryptoGapWindows = 0;
  let equityEmptyWindows = 0;
  let massiveCalls = 0;
  for (const { instrument, windows } of plans.values()) {
    const merged = coalesceWindows(windows);
    windowsCoalesced += merged.length;

    if (instrument.assetClass === 'us_equity') {
      for (const window of merged) {
        if (massiveCalls > 0) await sleep(throttleMs);
        massiveCalls += 1;
        const bars = await deps.fetchEquityMinuteBars(
          instrument.symbol,
          window.fromMs,
          window.toMs,
        );
        if (bars.length === 0) equityEmptyWindows += 1;
        barsUpserted += await upsertBars1m(
          db,
          bars.map((bar) => ({
            instrumentId: instrument.id,
            source: SOURCE_MASSIVE_AGGS,
            ...bar,
          })),
        );
      }
      continue;
    }

    // Crypto: ONE Kraken call per instrument (the endpoint only has the most
    // recent ~720 minutes), filtered to the merged windows.
    const available = await fetchCryptoOrThrow(deps.fetchCryptoMinuteBars, instrument);
    const earliestMs = available[0]?.ts.getTime();
    for (const window of merged) {
      if (earliestMs === undefined || window.fromMs < earliestMs) {
        cryptoGapWindows += 1;
      }
    }
    const inWindows = available.filter((bar) => {
      const ms = bar.ts.getTime();
      return merged.some((w) => ms >= w.fromMs && ms <= w.toMs);
    });
    barsUpserted += await upsertBars1m(
      db,
      inWindows.map((bar) => ({ instrumentId: instrument.id, source: SOURCE_KRAKEN, ...bar })),
    );
  }

  const counts: BackfillCounts = {
    clusters: clusterIds.size,
    instruments: plans.size,
    windowsRequested,
    windowsCoalesced,
    barsUpserted,
    cryptoGapWindows,
    equityEmptyWindows,
  };
  const level = cryptoGapWindows > 0 || equityEmptyWindows > 0 ? 'warn' : 'info';
  console.log(JSON.stringify({ level, msg: 'bars_backfill_event_windows', ...counts }));
  return counts;
}

// ------------------------------------------------------------ daily bars --

export interface EnsureDailyBarsDeps {
  /**
   * e.g. (symbol, fromMs, toMs) =>
   *   fetchAggsBars({ apiKey, … }, { symbol, timespan: 'day', fromMs, toMs })
   */
  fetchEquityDailyBars: (
    symbol: string,
    fromMs: number,
    toMs: number,
  ) => Promise<readonly ParsedBar[]>;
  /** e.g. (symbol) => fetchKrakenOhlc({}, { symbol, interval: 1440 }) — ~2 y of dailies. */
  fetchCryptoDailyBars: (symbol: KrakenSymbol) => Promise<readonly ParsedBar[]>;
  sleep?: (ms: number) => Promise<void>;
  /** Default 250 ms (~4 req/s). */
  throttleMs?: number;
  now?: () => Date;
}

export interface EnsureDailyBarsCounts {
  instruments: number;
  barsUpserted: number;
}

/**
 * Keep `lookbackDays` of daily bars for the whole universe + benchmarks
 * (beta/benchmark math needs ~90 d of dailies). Sequential vendor calls with
 * a self-throttle; first-write-wins upserts make re-runs cheap no-ops.
 */
export async function ensureDailyBars(
  db: Db,
  deps: EnsureDailyBarsDeps,
  params: { lookbackDays: number },
): Promise<EnsureDailyBarsCounts> {
  const sleep = deps.sleep ?? defaultSleep;
  const throttleMs = deps.throttleMs ?? 250;
  const now = (deps.now ?? (() => new Date()))();
  const fromMs = now.getTime() - params.lookbackDays * 86_400_000;

  const universe = await loadBarInstruments(db, now);
  let barsUpserted = 0;
  let massiveCalls = 0;
  for (const instrument of universe) {
    let rows: BarUpsertRow[];
    if (instrument.assetClass === 'us_equity') {
      if (massiveCalls > 0) await sleep(throttleMs);
      massiveCalls += 1;
      const bars = await deps.fetchEquityDailyBars(instrument.symbol, fromMs, now.getTime());
      rows = bars.map((bar) => ({
        instrumentId: instrument.id,
        source: SOURCE_MASSIVE_AGGS,
        ...bar,
      }));
    } else {
      const bars = await fetchCryptoOrThrow(deps.fetchCryptoDailyBars, instrument);
      rows = bars
        .filter((bar) => bar.ts.getTime() >= fromMs)
        .map((bar) => ({ instrumentId: instrument.id, source: SOURCE_KRAKEN, ...bar }));
    }
    barsUpserted += await upsertBars1d(db, rows);
  }

  const counts: EnsureDailyBarsCounts = { instruments: universe.length, barsUpserted };
  console.log(JSON.stringify({ level: 'info', msg: 'bars_ensure_daily', ...counts }));
  return counts;
}

// ------------------------------------------------------------- internals --

/**
 * A crypto instrument outside KRAKEN_PAIRS means CRYPTO_SEEDS grew without a
 * bars pipe — fail loudly instead of leaving a silent coverage hole.
 */
function fetchCryptoOrThrow(
  fetcher: (symbol: KrakenSymbol) => Promise<readonly ParsedBar[]>,
  instrument: BarInstrument,
): Promise<readonly ParsedBar[]> {
  if (!isKrakenSymbol(instrument.symbol)) {
    throw new Error(
      `crypto instrument ${instrument.symbol} has no Kraken pair mapping — ` +
        'extend KRAKEN_PAIRS (kraken-bars.ts) alongside CRYPTO_SEEDS.',
    );
  }
  return fetcher(instrument.symbol);
}

const defaultSleep = (ms: number): Promise<void> =>
  new Promise((resolve) => setTimeout(resolve, ms));

function* chunks<T>(items: readonly T[], size: number): Generator<T[]> {
  for (let i = 0; i < items.length; i += size) {
    yield items.slice(i, i + size);
  }
}
