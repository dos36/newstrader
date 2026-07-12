/**
 * DB-backed bars-repo tests — require a live Postgres and are skipped when
 * TEST_DATABASE_URL is unset.
 *
 * Run:
 *   docker compose up -d postgres
 *   TEST_DATABASE_URL=postgres://newstrader:newstrader@localhost:5433/newstrader \
 *     pnpm vitest run packages/db/src/bars
 *
 * Isolation: the suite creates and migrates its OWN database (<dbname>_bars)
 * and never touches the shared TEST_DATABASE_URL database (per-suite-database
 * pattern from resolver/resolve-repo.test.ts — a prior suite corrupted the
 * shared dev DB). Rows are still cleaned per test so the reused suite DB
 * stays empty. Item/cluster fixtures are dated in 2003 to keep them apart
 * from other suites' conventions (resolver uses 2001).
 */
import { contentHash, newId } from '@newstrader/core';
import { eq, inArray } from 'drizzle-orm';
import { migrate } from 'drizzle-orm/node-postgres/migrator';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';

import { createDb, type Db } from '../client.js';
import {
  indexMembership,
  instruments,
  itemInstrumentLinks,
  newsClusterItems,
  newsClusters,
  newsSources,
  priceBars1d,
  priceBars1m,
  rawNewsItems,
} from '../schema.js';
import { MIN_LINK_CONFIDENCE } from '../shared-constants.js';
import { SPX_INDEX_CODE } from '../universe/sync.js';
import {
  backfillEventWindows,
  ensureDailyBars,
  loadBarInstruments,
  recordSnapshot,
  upsertBars1d,
  upsertBars1m,
  type BarUpsertRow,
} from './bars-repo.js';
import { BENCHMARK_SYMBOLS, ensureBenchmarks } from './benchmarks.js';
import type { KrakenSymbol } from './kraken-bars.js';
import type { ParsedBar } from './massive-bars.js';
import { EVENT_WINDOW_AFTER_MS, EVENT_WINDOW_BEFORE_MS } from './windows.js';

const testDatabaseUrl = process.env.TEST_DATABASE_URL;

const TEST_SOURCE_KEY = 'bars_test_source';
/** Fictional equities + the real benchmark/crypto symbols this suite may seed. */
const TEST_SYMBOLS = ['VNBR', 'TQQA', 'TQQB', 'TQQC', 'DOGE', 'SPY', 'BTC', 'ETH', 'SOL'];

/** 2003 base clock (see header note). */
const T_NOW = new Date('2003-03-01T15:00:00.000Z');
const HOUR_MS = 3_600_000;
const DAY_MS = 86_400_000;
const minuteAligned = (ms: number): number => ms - (ms % 60_000);

const bar = (tsMs: number, close = '10'): ParsedBar => ({
  ts: new Date(minuteAligned(tsMs)),
  open: '10',
  high: '11',
  low: '9',
  close,
  volume: '100',
});

describe.skipIf(!testDatabaseUrl)('bars repo (integration)', () => {
  let db: Db;

  beforeAll(async () => {
    if (testDatabaseUrl === undefined)
      throw new Error('unreachable: suite is skipped without TEST_DATABASE_URL');
    const suiteUrl = await createSuiteDatabase(testDatabaseUrl);
    db = createDb(suiteUrl);
    await migrate(db, { migrationsFolder: new URL('../../migrations', import.meta.url).pathname });
  }, 60_000);

  afterAll(async () => {
    await cleanupTestRows();
    await db.$client.end();
  });

  beforeEach(async () => {
    await cleanupTestRows();
  });

  /** Delete every row this suite could have created, in FK-safe order. */
  async function cleanupTestRows(): Promise<void> {
    const instrumentRows = await db
      .select({ id: instruments.id })
      .from(instruments)
      .where(inArray(instruments.symbol, TEST_SYMBOLS));
    const instrumentIds = instrumentRows.map((row) => row.id);
    if (instrumentIds.length > 0) {
      await db.delete(priceBars1m).where(inArray(priceBars1m.instrumentId, instrumentIds));
      await db.delete(priceBars1d).where(inArray(priceBars1d.instrumentId, instrumentIds));
      await db
        .delete(itemInstrumentLinks)
        .where(inArray(itemInstrumentLinks.instrumentId, instrumentIds));
      await db.delete(indexMembership).where(inArray(indexMembership.instrumentId, instrumentIds));
    }
    const sourceRows = await db
      .select({ id: newsSources.id })
      .from(newsSources)
      .where(eq(newsSources.sourceKey, TEST_SOURCE_KEY));
    const sourceIds = sourceRows.map((row) => row.id);
    if (sourceIds.length > 0) {
      const clusterRows = await db
        .select({ id: newsClusters.id })
        .from(newsClusters)
        .where(inArray(newsClusters.firstSourceId, sourceIds));
      const clusterIds = clusterRows.map((row) => row.id);
      if (clusterIds.length > 0) {
        await db.delete(newsClusterItems).where(inArray(newsClusterItems.clusterId, clusterIds));
        await db.delete(newsClusters).where(inArray(newsClusters.id, clusterIds));
      }
      const itemRows = await db
        .select({ id: rawNewsItems.id })
        .from(rawNewsItems)
        .where(inArray(rawNewsItems.sourceId, sourceIds));
      const itemIds = itemRows.map((row) => row.id);
      if (itemIds.length > 0) {
        await db.delete(itemInstrumentLinks).where(inArray(itemInstrumentLinks.itemId, itemIds));
        await db.delete(rawNewsItems).where(inArray(rawNewsItems.id, itemIds));
      }
      await db.delete(newsSources).where(inArray(newsSources.id, sourceIds));
    }
    if (instrumentIds.length > 0) {
      await db.delete(instruments).where(inArray(instruments.id, instrumentIds));
    }
  }

  async function seedInstrument(
    symbol: string,
    assetClass: 'us_equity' | 'crypto',
    name = symbol,
  ): Promise<string> {
    const id = newId();
    await db.insert(instruments).values({ id, symbol, assetClass, name });
    return id;
  }

  async function seedMembership(
    instrumentId: string,
    validFrom: Date,
    validTo?: Date,
  ): Promise<void> {
    await db.insert(indexMembership).values({
      instrumentId,
      indexCode: SPX_INDEX_CODE,
      validFrom,
      validTo: validTo ?? null,
    });
  }

  async function seedSource(): Promise<string> {
    const id = newId();
    await db
      .insert(newsSources)
      .values({ id, sourceKey: TEST_SOURCE_KEY, kind: 'rss', name: 'bars test' });
    return id;
  }

  /** One cluster (anchor = first_received_at) linked to one instrument. */
  async function seedCluster(
    sourceId: string,
    instrumentId: string,
    headline: string,
    anchor: Date,
    confidence = 0.9,
  ): Promise<string> {
    const itemId = newId();
    await db.insert(rawNewsItems).values({
      id: itemId,
      sourceId,
      externalId: itemId,
      headline,
      payloadRef: `test/${itemId}.json`,
      contentHash: contentHash(headline),
      receivedAt: anchor,
    });
    const clusterId = newId();
    await db.insert(newsClusters).values({
      id: clusterId,
      canonicalHeadline: headline,
      normalizedHeadline: headline.toLowerCase(),
      firstItemId: itemId,
      firstSourceId: sourceId,
      firstReceivedAt: anchor,
      lastItemAt: anchor,
    });
    await db
      .insert(newsClusterItems)
      .values({ clusterId, itemId, similarity: 1, lagFromFirstMs: 0 });
    await db.insert(itemInstrumentLinks).values({
      itemId,
      instrumentId,
      method: 'ticker_exact',
      confidence,
      resolverVersion: 'bars-test',
    });
    return clusterId;
  }

  describe('upsertBars1m / upsertBars1d', () => {
    it('inserts once; a conflicting re-record NEVER overwrites (first write wins)', async () => {
      const id = await seedInstrument('VNBR', 'us_equity');
      const ts = new Date('2003-02-03T14:30:00.000Z');
      const first: BarUpsertRow = {
        instrumentId: id,
        source: 'massive_snapshot',
        ...bar(ts.getTime(), '10.5'),
      };

      expect(await upsertBars1m(db, [first])).toBe(1);
      // Same (instrument, ts) from another pipe with DIFFERENT values: dropped.
      // A source disagreement is detected by re-backfilling into a staging
      // query and diffing — never by clobbering the recorded fact.
      const conflicting: BarUpsertRow = {
        instrumentId: id,
        source: 'massive_aggs',
        ...bar(ts.getTime(), '99'),
      };
      expect(await upsertBars1m(db, [conflicting])).toBe(0);

      const rows = await db.select().from(priceBars1m).where(eq(priceBars1m.instrumentId, id));
      expect(rows).toHaveLength(1);
      expect(Number(rows[0]?.close)).toBe(10.5);
      expect(rows[0]?.source).toBe('massive_snapshot');
    });

    it('same ts on 1m and 1d land in different tables; empty input is a no-op', async () => {
      const id = await seedInstrument('VNBR', 'us_equity');
      const ts = Date.parse('2003-02-03T00:00:00.000Z');
      expect(await upsertBars1m(db, [])).toBe(0);
      expect(await upsertBars1m(db, [{ instrumentId: id, source: 's', ...bar(ts) }])).toBe(1);
      expect(await upsertBars1d(db, [{ instrumentId: id, source: 's', ...bar(ts) }])).toBe(1);
      expect(await upsertBars1d(db, [{ instrumentId: id, source: 's', ...bar(ts) }])).toBe(0);
    });
  });

  describe('ensureBenchmarks', () => {
    it('seeds SPY + BTC once and is idempotent', async () => {
      expect((await ensureBenchmarks(db)).inserted).toBe(2);
      expect((await ensureBenchmarks(db)).inserted).toBe(0);
      const spy = await db
        .select()
        .from(instruments)
        .where(eq(instruments.symbol, BENCHMARK_SYMBOLS.us_equity));
      expect(spy).toHaveLength(1);
      expect(spy[0]?.assetClass).toBe('us_equity');
      expect(spy[0]?.name).toBe('SPDR S&P 500 ETF');
    });
  });

  describe('loadBarInstruments', () => {
    it('applies point-in-time membership and always folds in crypto + benchmarks', async () => {
      const openMember = await seedInstrument('TQQA', 'us_equity');
      const closedMember = await seedInstrument('TQQB', 'us_equity');
      const futureMember = await seedInstrument('TQQC', 'us_equity');
      await seedMembership(openMember, new Date('2003-01-01T00:00:00Z'));
      await seedMembership(
        closedMember,
        new Date('2002-01-01T00:00:00Z'),
        new Date('2003-02-01T00:00:00Z'), // left the index before asOf
      );
      await seedMembership(futureMember, new Date('2003-04-01T00:00:00Z')); // joins after asOf
      const btc = await seedInstrument('BTC', 'crypto', 'Bitcoin');
      await ensureBenchmarks(db); // SPY (BTC insert no-ops against the seed above)

      const universe = await loadBarInstruments(db, T_NOW);
      const symbols = universe.map((i) => i.symbol).sort();
      expect(symbols).toEqual(['BTC', 'SPY', 'TQQA']);
      expect(universe.find((i) => i.symbol === 'BTC')?.id).toBe(btc);
    });
  });

  describe('recordSnapshot', () => {
    it('records one snapshot tick: universe symbols + benchmark to Massive, coins to Kraken', async () => {
      const equity = await seedInstrument('VNBR', 'us_equity');
      await seedMembership(equity, new Date('2003-01-01T00:00:00Z'));
      await ensureBenchmarks(db);

      const nowMs = T_NOW.getTime();
      let requestedSymbols: ReadonlySet<string> | undefined;
      const krakenCalls: KrakenSymbol[] = [];
      const counts = await recordSnapshot(db, {
        now: () => T_NOW,
        fetchEquitySnapshot: async (symbols) => {
          requestedSymbols = symbols;
          return [
            { symbol: 'VNBR', bar: bar(nowMs - 60_000, '10.5') },
            { symbol: 'SPY', bar: bar(nowMs - 60_000, '90') },
          ];
        },
        fetchCryptoMinuteBars: async (symbol) => {
          krakenCalls.push(symbol);
          return [bar(nowMs - 120_000, '64000'), bar(nowMs - 60_000, '64100')];
        },
      });

      // SPY rides along even though it is not an SPX member.
      expect([...(requestedSymbols ?? [])].sort()).toEqual(['SPY', 'VNBR']);
      expect(krakenCalls).toEqual(['BTC']);
      expect(counts).toEqual({
        equitySymbols: 2,
        equityBarsUpserted: 2,
        cryptoInstruments: 1,
        cryptoBarsUpserted: 2,
      });

      const stored = await db.select().from(priceBars1m);
      const bySource = new Map<string, number>();
      for (const row of stored) bySource.set(row.source, (bySource.get(row.source) ?? 0) + 1);
      expect(bySource.get('massive_snapshot')).toBe(2);
      expect(bySource.get('kraken')).toBe(2);

      // Second tick with identical vendor data: pure no-op (immutable facts).
      const again = await recordSnapshot(db, {
        now: () => T_NOW,
        fetchEquitySnapshot: async () => [{ symbol: 'VNBR', bar: bar(nowMs - 60_000, '10.5') }],
        fetchCryptoMinuteBars: async () => [bar(nowMs - 60_000, '64100')],
      });
      expect(again.equityBarsUpserted).toBe(0);
      expect(again.cryptoBarsUpserted).toBe(0);
    });

    it('throws when the snapshot returns a symbol outside the requested universe', async () => {
      const equity = await seedInstrument('VNBR', 'us_equity');
      await seedMembership(equity, new Date('2003-01-01T00:00:00Z'));
      await expect(
        recordSnapshot(db, {
          now: () => T_NOW,
          fetchEquitySnapshot: async () => [{ symbol: 'ROGUE', bar: bar(T_NOW.getTime()) }],
          fetchCryptoMinuteBars: async () => [],
        }),
      ).rejects.toThrow(/outside the requested universe/);
    });

    it('throws on a crypto instrument without a Kraken pair mapping (no silent gap)', async () => {
      await seedInstrument('DOGE', 'crypto', 'Dogecoin');
      await expect(
        recordSnapshot(db, {
          now: () => T_NOW,
          fetchEquitySnapshot: async () => [],
          fetchCryptoMinuteBars: async () => [],
        }),
      ).rejects.toThrow(/no Kraken pair mapping/);
    });

    it('persists crypto bars even when the equity snapshot leg fails, then rethrows its error', async () => {
      const equity = await seedInstrument('VNBR', 'us_equity');
      await seedMembership(equity, new Date('2003-01-01T00:00:00Z'));
      const btc = await seedInstrument('BTC', 'crypto', 'Bitcoin');
      const nowMs = T_NOW.getTime();

      let krakenCalled = false;
      let equityCalled = false;
      await expect(
        recordSnapshot(db, {
          now: () => T_NOW,
          fetchEquitySnapshot: async () => {
            equityCalled = true;
            throw new Error('403 not authorized — snapshot entitlement missing');
          },
          fetchCryptoMinuteBars: async () => {
            // Kraken must have already been called (and its bars persisted
            // below) by the time the equity leg's error is observed.
            krakenCalled = true;
            return [bar(nowMs - 120_000, '64000'), bar(nowMs - 60_000, '64100')];
          },
        }),
      ).rejects.toThrow(/403 not authorized/);

      expect(krakenCalled).toBe(true);
      expect(equityCalled).toBe(true);
      const stored = await db.select().from(priceBars1m).where(eq(priceBars1m.instrumentId, btc));
      expect(stored).toHaveLength(2); // crypto bars survived the equity leg's rejection
    });
  });

  describe('backfillEventWindows', () => {
    it('coalesces overlapping windows per instrument into single vendor calls', async () => {
      const sourceId = await seedSource();
      const equity = await seedInstrument('VNBR', 'us_equity');
      const anchorA = new Date('2003-02-10T14:00:00.000Z');
      const anchorB = new Date(anchorA.getTime() + 2 * HOUR_MS); // window overlaps A's
      const anchorC = new Date(anchorA.getTime() - 30 * DAY_MS); // disjoint
      await seedCluster(sourceId, equity, 'VNBR beats estimates', anchorA);
      await seedCluster(sourceId, equity, 'VNBR raises guidance', anchorB);
      await seedCluster(sourceId, equity, 'VNBR CFO departs', anchorC);

      const equityCalls: { symbol: string; fromMs: number; toMs: number }[] = [];
      let sleeps = 0;
      const counts = await backfillEventWindows(
        db,
        {
          fetchEquityMinuteBars: async (symbol, fromMs, toMs) => {
            equityCalls.push({ symbol, fromMs, toMs });
            return [bar(fromMs + 60_000, '11'), bar(fromMs + 120_000, '12')];
          },
          fetchCryptoMinuteBars: async () => [],
          sleep: async () => {
            sleeps += 1;
          },
        },
        { from: new Date(anchorC.getTime() - DAY_MS), to: new Date(anchorB.getTime() + DAY_MS) },
      );

      // Three anchors → two merged windows → exactly two Massive calls.
      expect(equityCalls).toHaveLength(2);
      expect(equityCalls.map((c) => c.symbol)).toEqual(['VNBR', 'VNBR']);
      const sorted = [...equityCalls].sort((a, b) => a.fromMs - b.fromMs);
      expect(sorted[0]).toEqual({
        symbol: 'VNBR',
        fromMs: anchorC.getTime() - EVENT_WINDOW_BEFORE_MS,
        toMs: anchorC.getTime() + EVENT_WINDOW_AFTER_MS,
      });
      expect(sorted[1]).toEqual({
        symbol: 'VNBR',
        fromMs: anchorA.getTime() - EVENT_WINDOW_BEFORE_MS,
        toMs: anchorB.getTime() + EVENT_WINDOW_AFTER_MS,
      });
      expect(sleeps).toBe(1); // throttled between the two sequential calls
      expect(counts).toEqual({
        clusters: 3,
        instruments: 1,
        windowsRequested: 3,
        windowsCoalesced: 2,
        barsUpserted: 4,
        cryptoGapWindows: 0,
        equityEmptyWindows: 0,
      });
    });

    it('ignores clusters outside the requested range', async () => {
      const sourceId = await seedSource();
      const equity = await seedInstrument('VNBR', 'us_equity');
      await seedCluster(sourceId, equity, 'old news', new Date('2003-01-01T00:00:00Z'));

      const counts = await backfillEventWindows(
        db,
        {
          fetchEquityMinuteBars: async () => {
            throw new Error('must not be called');
          },
          fetchCryptoMinuteBars: async () => [],
        },
        { from: new Date('2003-02-01T00:00:00Z'), to: new Date('2003-03-01T00:00:00Z') },
      );
      expect(counts.clusters).toBe(0);
      expect(counts.barsUpserted).toBe(0);
    });

    it('crypto: one Kraken call per instrument, bars filtered to windows, gaps counted honestly', async () => {
      const sourceId = await seedSource();
      const btc = await seedInstrument('BTC', 'crypto', 'Bitcoin');
      const anchorOld = new Date('2003-02-01T12:00:00.000Z'); // before Kraken's ~12 h horizon
      const anchorNew = new Date('2003-02-20T12:00:00.000Z');
      await seedCluster(sourceId, btc, 'BTC ETF approved', anchorOld);
      await seedCluster(sourceId, btc, 'BTC exchange hacked', anchorNew);

      let krakenCalls = 0;
      // Available candles start AT anchorNew (so anchorNew's window, which
      // opens 1 h earlier, is partially covered → counted as a gap window too).
      const available = [
        bar(anchorNew.getTime(), '64000'),
        bar(anchorNew.getTime() + 60_000, '64100'),
        // Outside every window: 10 d after anchorNew.
        bar(anchorNew.getTime() + 10 * DAY_MS, '65000'),
      ];
      const counts = await backfillEventWindows(
        db,
        {
          fetchEquityMinuteBars: async () => {
            throw new Error('must not be called');
          },
          fetchCryptoMinuteBars: async () => {
            krakenCalls += 1;
            return available;
          },
        },
        { from: new Date('2003-01-31T00:00:00Z'), to: new Date('2003-02-21T00:00:00Z') },
      );

      expect(krakenCalls).toBe(1);
      expect(counts.windowsCoalesced).toBe(2);
      expect(counts.cryptoGapWindows).toBe(2);
      expect(counts.barsUpserted).toBe(2); // the 10-days-later bar was filtered out

      const stored = await db.select().from(priceBars1m).where(eq(priceBars1m.instrumentId, btc));
      expect(stored.map((r) => r.source)).toEqual(['kraken', 'kraken']);
    });

    it("also backfills the asset class benchmark (SPY), covering the union of that class's windows", async () => {
      const sourceId = await seedSource();
      const equity = await seedInstrument('VNBR', 'us_equity');
      await ensureBenchmarks(db); // seeds SPY — never itself news-linked
      const anchorA = new Date('2003-02-10T14:00:00.000Z');
      const anchorB = new Date(anchorA.getTime() + 2 * HOUR_MS); // overlaps A's window
      await seedCluster(sourceId, equity, 'VNBR beats estimates', anchorA);
      await seedCluster(sourceId, equity, 'VNBR raises guidance', anchorB);

      const equityCalls: { symbol: string; fromMs: number; toMs: number }[] = [];
      const counts = await backfillEventWindows(
        db,
        {
          fetchEquityMinuteBars: async (symbol, fromMs, toMs) => {
            equityCalls.push({ symbol, fromMs, toMs });
            return [bar(fromMs + 60_000, '11')];
          },
          fetchCryptoMinuteBars: async () => [],
        },
        { from: new Date(anchorA.getTime() - DAY_MS), to: new Date(anchorB.getTime() + DAY_MS) },
      );

      // Two instruments now: VNBR (linked) + SPY (the derived benchmark plan).
      expect(counts.instruments).toBe(2);
      const bySymbol = new Map(
        equityCalls.map((c) => [c.symbol, { fromMs: c.fromMs, toMs: c.toMs }]),
      );
      expect([...bySymbol.keys()].sort()).toEqual(['SPY', 'VNBR']);
      // SPY's window is the coalesced UNION of both anchors' windows — same
      // bounds as VNBR's own two disjoint windows would coalesce to.
      expect(bySymbol.get('SPY')).toEqual({
        fromMs: anchorA.getTime() - EVENT_WINDOW_BEFORE_MS,
        toMs: anchorB.getTime() + EVENT_WINDOW_AFTER_MS,
      });

      const spyRow = (
        await db
          .select()
          .from(instruments)
          .where(eq(instruments.symbol, BENCHMARK_SYMBOLS.us_equity))
      )[0];
      const spyBars = await db
        .select()
        .from(priceBars1m)
        .where(eq(priceBars1m.instrumentId, spyRow?.id ?? ''));
      expect(spyBars.length).toBeGreaterThan(0);
    });

    it('does not double-plan a benchmark that is itself already news-linked (BTC)', async () => {
      const sourceId = await seedSource();
      const btc = await seedInstrument('BTC', 'crypto', 'Bitcoin');
      const anchor = new Date('2003-02-20T12:00:00.000Z');
      await seedCluster(sourceId, btc, 'BTC exchange hacked', anchor);

      let krakenCalls = 0;
      const counts = await backfillEventWindows(
        db,
        {
          fetchEquityMinuteBars: async () => {
            throw new Error('must not be called');
          },
          fetchCryptoMinuteBars: async () => {
            krakenCalls += 1;
            return [bar(anchor.getTime(), '64000')];
          },
        },
        { from: new Date(anchor.getTime() - DAY_MS), to: new Date(anchor.getTime() + DAY_MS) },
      );

      // BTC is both the universe member here AND the crypto benchmark — one
      // plan entry, one Kraken call, never a duplicate "benchmark" fetch.
      expect(counts.instruments).toBe(1);
      expect(krakenCalls).toBe(1);
    });

    it('excludes below-threshold links from the plan (no vendor call for links the measurer will never use)', async () => {
      const sourceId = await seedSource();
      const equity = await seedInstrument('VNBR', 'us_equity');
      const anchor = new Date('2003-02-10T14:00:00.000Z');
      expect(MIN_LINK_CONFIDENCE).toBeGreaterThan(0.7); // sanity: 0.7 must stay excluded
      await seedCluster(sourceId, equity, 'VNBR rumor (low-confidence alias match)', anchor, 0.7);

      const counts = await backfillEventWindows(
        db,
        {
          fetchEquityMinuteBars: async () => {
            throw new Error('must not be called — the only link is below MIN_LINK_CONFIDENCE');
          },
          fetchCryptoMinuteBars: async () => [],
        },
        { from: new Date(anchor.getTime() - DAY_MS), to: new Date(anchor.getTime() + DAY_MS) },
      );
      expect(counts).toEqual({
        clusters: 0,
        instruments: 0,
        windowsRequested: 0,
        windowsCoalesced: 0,
        barsUpserted: 0,
        cryptoGapWindows: 0,
        equityEmptyWindows: 0,
      });
    });

    it('counts and warn-logs equity windows that return zero bars', async () => {
      const sourceId = await seedSource();
      const equity = await seedInstrument('VNBR', 'us_equity');
      const anchor = new Date('2003-02-10T14:00:00.000Z');
      await seedCluster(sourceId, equity, 'VNBR delisted', anchor);

      const counts = await backfillEventWindows(
        db,
        {
          fetchEquityMinuteBars: async () => [], // e.g. an unentitled key or a delisted symbol
          fetchCryptoMinuteBars: async () => [],
        },
        { from: new Date(anchor.getTime() - DAY_MS), to: new Date(anchor.getTime() + DAY_MS) },
      );
      expect(counts.equityEmptyWindows).toBe(1);
      expect(counts.barsUpserted).toBe(0);
    });
  });

  describe('ensureDailyBars', () => {
    it('fetches dailies for universe + benchmarks, crypto trimmed to the lookback, idempotently', async () => {
      const equity = await seedInstrument('VNBR', 'us_equity');
      await seedMembership(equity, new Date('2003-01-01T00:00:00Z'));
      await ensureBenchmarks(db);

      const nowMs = T_NOW.getTime();
      const dayTs = (daysAgo: number): number => {
        const ms = nowMs - daysAgo * DAY_MS;
        return ms - (ms % DAY_MS);
      };
      const equityCalls: string[] = [];
      const deps = {
        now: () => T_NOW,
        fetchEquityDailyBars: async (symbol: string, fromMs: number, toMs: number) => {
          equityCalls.push(symbol);
          expect(toMs - fromMs).toBe(90 * DAY_MS);
          return [bar(dayTs(2)), bar(dayTs(1))];
        },
        fetchCryptoDailyBars: async () => [
          bar(dayTs(400), '300'), // outside the 90 d lookback → dropped
          bar(dayTs(3), '64000'),
        ],
        sleep: async () => {},
      };

      const counts = await ensureDailyBars(db, deps, { lookbackDays: 90 });
      expect(equityCalls.sort()).toEqual(['SPY', 'VNBR']);
      expect(counts.instruments).toBe(3); // VNBR + SPY + BTC
      expect(counts.barsUpserted).toBe(5); // 2 + 2 equities, 1 kept crypto daily

      const btcRows = await db
        .select()
        .from(priceBars1d)
        .innerJoin(instruments, eq(instruments.id, priceBars1d.instrumentId))
        .where(eq(instruments.symbol, 'BTC'));
      expect(btcRows).toHaveLength(1);
      expect(btcRows[0]?.price_bars_1d.source).toBe('kraken');

      expect((await ensureDailyBars(db, deps, { lookbackDays: 90 })).barsUpserted).toBe(0);
    });
  });
});

// ------------------------------------------------------------------ helpers --

/**
 * Create (if missing) the suite's dedicated database next to the shared
 * TEST_DATABASE_URL one and return its URL. Idempotent across runs; mirrors
 * resolver/resolve-repo.test.ts.
 */
async function createSuiteDatabase(adminUrl: string): Promise<string> {
  const parsed = new URL(adminUrl);
  const baseName = parsed.pathname.replace(/^\//, '') || 'postgres';
  const suiteName = `${baseName}_bars`.replace(/[^a-zA-Z0-9_]/g, '_');

  const admin = createDb(adminUrl);
  try {
    await admin.$client.query(`create database "${suiteName}"`);
  } catch (error) {
    if (!isDuplicateDatabase(error)) throw error;
  } finally {
    await admin.$client.end();
  }

  const suiteUrl = new URL(adminUrl);
  suiteUrl.pathname = `/${suiteName}`;
  return suiteUrl.toString();
}

/** Postgres error 42P04: duplicate_database — the suite database already exists. */
function isDuplicateDatabase(error: unknown): boolean {
  return (
    typeof error === 'object' && error !== null && (error as { code?: unknown }).code === '42P04'
  );
}
