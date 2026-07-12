/**
 * DB-backed reaction-measurement tests — require a live Postgres and are
 * skipped when TEST_DATABASE_URL is unset.
 *
 * Run:
 *   docker compose up -d postgres
 *   TEST_DATABASE_URL=postgres://newstrader:newstrader@localhost:5433/newstrader \
 *     pnpm vitest run packages/db/src/reaction
 *
 * Isolation: the suite creates and migrates its OWN database
 * (<dbname>_reaction) and never touches the shared TEST_DATABASE_URL database
 * (mirrors resolve-repo.test.ts — measureReactions reads clusters globally by
 * time window, so shared-DB rows would change this suite's totals). The suite
 * database is dedicated to this file, so cleanup truncates whole tables.
 *
 * Fixture dates live in 2002 to stay clear of other suites' fixtures and any
 * real dev data (resolver uses 2001).
 */
import { contentHash, newId } from '@newstrader/core';
import { and, eq } from 'drizzle-orm';
import { migrate } from 'drizzle-orm/node-postgres/migrator';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';

import { createDb, type Db } from '../client.js';
import {
  instruments,
  itemInstrumentLinks,
  newsClusterItems,
  newsClusters,
  newsSources,
  priceBars1d,
  priceBars1m,
  rawNewsItems,
  reactionMeasurements,
  reactionSummary,
  recoveryMeasurements,
} from '../schema.js';
import { MEASURER_VERSION, measureReactions } from './measure-repo.js';

const testDatabaseUrl = process.env.TEST_DATABASE_URL;

const MINUTE_MS = 60_000;
const HOUR_MS = 3_600_000;
const DAY_MS = 86_400_000;

/** Cluster anchor (first_received_at) — a 2002 Monday, 14:00 UTC. */
const ANCHOR = new Date('2002-06-03T14:00:00.000Z');
const ANCHOR_MIDNIGHT = new Date('2002-06-03T00:00:00.000Z');
/** Injected clock: 20 days after the anchor, so every horizon has settled. */
const NOW = new Date('2002-06-23T14:00:00.000Z');
const SINCE_HOURS = 21 * 24;

describe.skipIf(!testDatabaseUrl)('reaction measure repo (integration)', () => {
  let db: Db;
  let sourceId: string;

  beforeAll(async () => {
    if (testDatabaseUrl === undefined)
      throw new Error('unreachable: suite is skipped without TEST_DATABASE_URL');
    const suiteUrl = await createSuiteDatabase(testDatabaseUrl);
    db = createDb(suiteUrl);
    await migrate(db, { migrationsFolder: new URL('../../migrations', import.meta.url).pathname });
  }, 60_000);

  afterAll(async () => {
    await cleanupAllRows();
    await db.$client.end();
  });

  beforeEach(async () => {
    await cleanupAllRows();
    sourceId = newId();
    await db
      .insert(newsSources)
      .values({ id: sourceId, sourceKey: 'reaction_test_source', kind: 'rss', name: 'reaction' });
  });

  /** The suite database is dedicated to this file — whole-table deletes, FK-safe order. */
  async function cleanupAllRows(): Promise<void> {
    await db.delete(recoveryMeasurements);
    await db.delete(reactionSummary);
    await db.delete(reactionMeasurements);
    await db.delete(priceBars1m);
    await db.delete(priceBars1d);
    await db.delete(itemInstrumentLinks);
    await db.delete(newsClusterItems);
    await db.delete(newsClusters);
    await db.delete(rawNewsItems);
    await db.delete(newsSources);
    await db.delete(instruments);
  }

  async function seedInstrument(symbol: string, assetClass: 'us_equity' | 'crypto') {
    const id = newId();
    await db.insert(instruments).values({ id, symbol, assetClass, name: `${symbol} test` });
    return id;
  }

  async function seedClusterWithLinks(
    anchor: Date,
    links: {
      instrumentId: string;
      confidence: number;
      method: 'cik_exact' | 'ticker_exact' | 'source_hint' | 'alias_dict' | 'llm_ner';
    }[],
  ): Promise<string> {
    const itemId = newId();
    const headline = `reaction fixture ${itemId}`;
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
    if (links.length > 0) {
      await db.insert(itemInstrumentLinks).values(
        links.map((link) => ({
          itemId,
          instrumentId: link.instrumentId,
          method: link.method,
          confidence: link.confidence,
          resolverVersion: 'test',
        })),
      );
    }
    return clusterId;
  }

  async function seedMinuteBars(
    instrumentId: string,
    base: Date,
    entries: [minutes: number, close: string][],
  ): Promise<void> {
    await db.insert(priceBars1m).values(
      entries.map(([minutes, close]) => ({
        instrumentId,
        ts: new Date(base.getTime() + minutes * MINUTE_MS),
        open: close,
        high: close,
        low: close,
        close,
        source: 'test',
      })),
    );
  }

  async function seedDailyBars(
    instrumentId: string,
    entries: [isoDay: string, close: string][],
  ): Promise<void> {
    await db.insert(priceBars1d).values(
      entries.map(([isoDay, close]) => ({
        instrumentId,
        ts: new Date(`${isoDay}T00:00:00.000Z`),
        open: close,
        high: close,
        low: close,
        close,
        source: 'test',
      })),
    );
  }

  /**
   * 40 pre-anchor daily closes where the instrument's log return is `factor` ×
   * the benchmark's ±1%/0 pattern — beta over them is `factor`.
   */
  async function seedBetaDailies(instrumentId: string, factor: number): Promise<void> {
    const entries: [dayIndex: number, close: string][] = [];
    let logClose = Math.log(factor === 1 ? 400 : 100);
    for (let i = 0; i < 40; i++) {
      if (i > 0) logClose += factor * 0.01 * ((i % 3) - 1);
      entries.push([i, Math.exp(logClose).toFixed(6)]);
    }
    await db.insert(priceBars1d).values(
      entries.map(([i, close]) => ({
        instrumentId,
        ts: new Date(ANCHOR_MIDNIGHT.getTime() - (40 - i) * DAY_MS),
        open: close,
        high: close,
        low: close,
        close,
        source: 'test',
      })),
    );
  }

  interface Fixture {
    equityId: string; // RCTX: full ladder + summary + recovery
    lowConfidenceId: string; // RCLO: linked at 0.7 only — must be excluded
    noBarsId: string; // RCNB: qualifying link, zero bars — skippedNoBars
    btcId: string; // BTC: the crypto benchmark itself — raw-only rows
    equityClusterId: string;
    noBarsClusterId: string;
    btcClusterId: string;
  }

  /** Three clusters: equity (with a low-confidence extra link), no-bars, and BTC. */
  async function seedFixture(): Promise<Fixture> {
    const equityId = await seedInstrument('RCTX', 'us_equity');
    const lowConfidenceId = await seedInstrument('RCLO', 'us_equity');
    const noBarsId = await seedInstrument('RCNB', 'us_equity');
    const spyId = await seedInstrument('SPY', 'us_equity');
    const btcId = await seedInstrument('BTC', 'crypto');

    const equityClusterId = await seedClusterWithLinks(ANCHOR, [
      { instrumentId: equityId, confidence: 0.9, method: 'ticker_exact' },
      { instrumentId: lowConfidenceId, confidence: 0.7, method: 'alias_dict' },
    ]);
    const noBarsClusterId = await seedClusterWithLinks(new Date(ANCHOR.getTime() + HOUR_MS), [
      { instrumentId: noBarsId, confidence: 0.9, method: 'ticker_exact' },
    ]);
    const btcClusterId = await seedClusterWithLinks(ANCHOR, [
      { instrumentId: btcId, confidence: 0.95, method: 'ticker_exact' },
    ]);

    // Equity minute bars at every horizon offset (sparse — sessions have gaps,
    // the math walks actual timestamps). Down 200 bps at 1d → recovery-eligible.
    // [-1, ...] is the true anchor bar under the close-time selection rule
    // (anchor bar = last bar whose CLOSE, open+60s, settles at-or-before the
    // anchor) — same price as the old minute-0 bar, so every return below is
    // unaffected.
    await seedMinuteBars(equityId, ANCHOR, [
      [-1, '100.000000'],
      [0, '100.000000'],
      [5, '99.500000'], // -50 bps
      [15, '99.200000'], // -80
      [30, '98.900000'], // -110 → first |cum| past half of the 1d move
      [60, '98.800000'], // -120
      [240, '98.500000'], // -150
      [1440, '98.000000'], // -200 → 1d, negative event
      [4320, '95.000000'], // -500 → trough
      [7200, '97.000000'], // -300 → 5d
    ]);
    // Flat SPY at the same offsets: benchmark return 0 → abnormal = raw, beta applied.
    await seedMinuteBars(
      spyId,
      ANCHOR,
      [-1, 0, 5, 15, 30, 60, 240, 1440, 4320, 7200].map((m) => [m, '400.000000']),
    );

    // Beta dailies: RCTX moves 1.2× SPY.
    await seedBetaDailies(spyId, 1);
    await seedBetaDailies(equityId, 1.2);

    // Post-anchor dailies extend recovery past the minute window (closes are
    // stamped end-of-day, i.e. +24h): 97.6 → -240 half-reverts (trough/2 =
    // -250), 100.5 → +50 fully reverts.
    await seedDailyBars(equityId, [
      ['2002-06-10', '97.600000'],
      ['2002-06-14', '100.500000'],
      ['2002-06-20', '100.000000'],
    ]);
    await seedDailyBars(spyId, [
      ['2002-06-10', '400.000000'],
      ['2002-06-14', '400.000000'],
      ['2002-06-20', '400.000000'],
    ]);

    // BTC bars cover only through 1d — 3d/5d have no settled price and must be
    // absent. BTC is its own benchmark → raw-only.
    await seedMinuteBars(btcId, ANCHOR, [
      [-1, '50000.000000'],
      [0, '50000.000000'],
      [5, '50050.000000'], // +10 bps
      [15, '50100.000000'], // +20
      [30, '50150.000000'], // +30
      [60, '50200.000000'], // +40
      [240, '50260.000000'], // +52 → first |cum| past half of the +100 1d move
      [1440, '50500.000000'], // +100
    ]);

    return {
      equityId,
      lowConfidenceId,
      noBarsId,
      btcId,
      equityClusterId,
      noBarsClusterId,
      btcClusterId,
    };
  }

  it('measures ladder, summary, and recovery across a full run', async () => {
    const fixture = await seedFixture();

    const totals = await measureReactions(db, { sinceHours: SINCE_HOURS, now: NOW });
    expect(totals).toEqual({
      clusters: 3,
      pairs: 3, // RCTX, RCNB, BTC — the 0.7 RCLO link never becomes a pair
      measured: 2, // RCTX + BTC
      skippedNoBars: 1, // RCNB
      horizonsWritten: 14, // 8 equity + 6 BTC
    });

    // Equity ladder: every horizon, raw values from the seeded closes, flat
    // benchmark → abnormal = raw with beta recorded.
    const equityRows = await db
      .select()
      .from(reactionMeasurements)
      .where(eq(reactionMeasurements.instrumentId, fixture.equityId));
    expect(equityRows).toHaveLength(8);
    const equityByHorizon = new Map(equityRows.map((row) => [row.horizon, row]));
    const expectedEquityRawBps: Record<string, number> = {
      '5m': -50,
      '15m': -80,
      '30m': -110,
      '1h': -120,
      '4h': -150,
      '1d': -200,
      '3d': -500,
      '5d': -300,
    };
    for (const [horizon, expected] of Object.entries(expectedEquityRawBps)) {
      const row = equityByHorizon.get(horizon as (typeof equityRows)[number]['horizon']);
      expect(row, horizon).toBeDefined();
      expect(row?.rawReturnBps).toBeCloseTo(expected, 2);
      expect(row?.abnormalReturnBps).toBeCloseTo(expected, 2); // flat SPY
      expect(row?.betaUsed).toBeCloseTo(1.2, 2);
      expect(row?.benchmark).toBe('SPY');
      expect(row?.barsSource).toBe('test');
      expect(row?.measurerVersion).toBe(MEASURER_VERSION);
      expect(row?.anchorTs.getTime()).toBe(ANCHOR.getTime());
      expect(row?.clusterId).toBe(fixture.equityClusterId);
    }

    // The 0.7-confidence link must produce nothing.
    expect(
      await db
        .select()
        .from(reactionMeasurements)
        .where(eq(reactionMeasurements.instrumentId, fixture.lowConfidenceId)),
    ).toHaveLength(0);
    // The no-bars pair is skipped quietly.
    expect(
      await db
        .select()
        .from(reactionMeasurements)
        .where(eq(reactionMeasurements.instrumentId, fixture.noBarsId)),
    ).toHaveLength(0);

    // BTC (the crypto benchmark itself): raw-only, and only settled horizons.
    const btcRows = await db
      .select()
      .from(reactionMeasurements)
      .where(eq(reactionMeasurements.instrumentId, fixture.btcId));
    expect(btcRows.map((row) => row.horizon).sort()).toEqual(
      ['5m', '15m', '30m', '1h', '4h', '1d'].sort(),
    );
    for (const row of btcRows) {
      expect(row.benchmark).toBeNull();
      expect(row.betaUsed).toBeNull();
      expect(row.abnormalReturnBps).toBeCloseTo(row.rawReturnBps, 6);
    }

    // Summaries: equity down-move and BTC up-move.
    const summaries = await db.select().from(reactionSummary);
    expect(summaries).toHaveLength(2);
    const equitySummary = summaries.find((row) => row.instrumentId === fixture.equityId);
    expect(equitySummary?.peakAbnormalMoveBps).toBeCloseTo(-200, 2);
    expect(equitySummary?.timeToPeakMinutes).toBe(1440);
    expect(equitySummary?.timeToHalfOf1dMoveMinutes).toBe(30); // -110 is the first |cum| ≥ 100
    expect(equitySummary?.direction1d).toBe('down');
    const btcSummary = summaries.find((row) => row.instrumentId === fixture.btcId);
    expect(btcSummary?.peakAbnormalMoveBps).toBeCloseTo(100, 2);
    expect(btcSummary?.timeToHalfOf1dMoveMinutes).toBe(240); // +52 bps at 4h
    expect(btcSummary?.direction1d).toBe('up');

    // Recovery: only the equity's -200 bps 1d move qualifies (≤ -50 bps).
    const recoveries = await db.select().from(recoveryMeasurements);
    expect(recoveries).toHaveLength(1);
    const rec = recoveries[0];
    expect(rec?.instrumentId).toBe(fixture.equityId);
    expect(rec?.troughBps).toBeCloseTo(-500, 2);
    expect(rec?.timeToTroughHours).toBe(72);
    // Daily closes are stamped end-of-day: 2002-06-11T00:00Z / 2002-06-15T00:00Z.
    expect(rec?.timeToHalfReversionHours).toBeCloseTo(178, 2);
    expect(rec?.timeToFullReversionHours).toBeCloseTo(274, 2);
    // Data ends at 2002-06-21T00:00Z → 17d10h of the nominal 30d window.
    expect(rec?.windowDays).toBeCloseTo(17.4167, 3);
  });

  it('re-running writes nothing new (recompute under a NEW measurer_version instead)', async () => {
    await seedFixture();
    const first = await measureReactions(db, { sinceHours: SINCE_HOURS, now: NOW });
    expect(first.horizonsWritten).toBe(14);

    const second = await measureReactions(db, { sinceHours: SINCE_HOURS, now: NOW });
    expect(second).toEqual({
      clusters: 3,
      pairs: 3,
      measured: 2, // still recomputed…
      skippedNoBars: 1,
      horizonsWritten: 0, // …but every row already exists under this version
    });
    expect(await db.select().from(reactionMeasurements)).toHaveLength(14);
    expect(await db.select().from(reactionSummary)).toHaveLength(2);
    expect(await db.select().from(recoveryMeasurements)).toHaveLength(1);
  });

  it('ignores clusters anchored outside the sinceHours window', async () => {
    await seedFixture();
    const totals = await measureReactions(db, { sinceHours: 24, now: NOW }); // anchor is 20d old
    expect(totals).toEqual({
      clusters: 0,
      pairs: 0,
      measured: 0,
      skippedNoBars: 0,
      horizonsWritten: 0,
    });
    expect(await db.select().from(reactionMeasurements)).toHaveLength(0);
  });

  it('yields no pairs when every link is below the confidence threshold', async () => {
    const instrumentId = await seedInstrument('RCLO', 'us_equity');
    await seedClusterWithLinks(ANCHOR, [{ instrumentId, confidence: 0.7, method: 'alias_dict' }]);
    await seedMinuteBars(instrumentId, ANCHOR, [
      [0, '100.000000'],
      [5, '101.000000'],
    ]);

    const totals = await measureReactions(db, { sinceHours: SINCE_HOURS, now: NOW });
    expect(totals).toEqual({
      clusters: 1,
      pairs: 0,
      measured: 0,
      skippedNoBars: 0,
      horizonsWritten: 0,
    });
    expect(await db.select().from(reactionMeasurements)).toHaveLength(0);
  });

  it('admits a 0.8-confidence crypto-keyword link that the old 0.85 threshold excluded', async () => {
    const instrumentId = await seedInstrument('RCCK', 'crypto');
    await seedClusterWithLinks(ANCHOR, [{ instrumentId, confidence: 0.8, method: 'alias_dict' }]);
    await seedMinuteBars(instrumentId, ANCHOR, [
      [-1, '100.000000'],
      [1440, '101.000000'],
    ]);

    const totals = await measureReactions(db, { sinceHours: SINCE_HOURS, now: NOW });
    expect(totals.pairs).toBe(1);
    expect(totals.measured).toBe(1);
  });

  it("excludes the anchor day's own daily bar from beta (no look-ahead into the event move)", async () => {
    const equityId = await seedInstrument('RCBL', 'us_equity');
    const spyId = await seedInstrument('SPY', 'us_equity');
    await seedClusterWithLinks(ANCHOR, [
      { instrumentId: equityId, confidence: 0.9, method: 'ticker_exact' },
    ]);

    // 40 pre-anchor days where the instrument tracks SPY 1:1 — true beta = 1.
    await seedBetaDailies(spyId, 1);
    await seedBetaDailies(equityId, 1);

    // The anchor day's OWN close (stamped at the anchor's UTC midnight, but
    // printed AFTER the anchor and containing the event move): a huge
    // divergence from SPY that would drag beta far from 1 if it leaked into
    // the pre-anchor window via a `bar.ts < anchor` (instead of
    // `< startOfUtcDay(anchor)`) filter.
    await seedDailyBars(equityId, [['2002-06-03', '1000.000000']]);
    await seedDailyBars(spyId, [['2002-06-03', '400.000000']]);

    await seedMinuteBars(equityId, ANCHOR, [
      [-1, '100.000000'],
      [1440, '101.000000'],
    ]);
    await seedMinuteBars(spyId, ANCHOR, [
      [-1, '400.000000'],
      [1440, '400.000000'],
    ]);

    await measureReactions(db, { sinceHours: SINCE_HOURS, now: NOW });
    const row = (
      await db
        .select()
        .from(reactionMeasurements)
        .where(
          and(
            eq(reactionMeasurements.instrumentId, equityId),
            eq(reactionMeasurements.horizon, '1d'),
          ),
        )
    )[0];
    expect(row?.betaUsed).toBeCloseTo(1, 2); // NOT dragged toward the anchor-day outlier
  });

  it('does not write a partial-window recovery row (no full reversion yet, window far short of 30d)', async () => {
    const equityId = await seedInstrument('RCPW', 'us_equity');
    await seedClusterWithLinks(ANCHOR, [
      { instrumentId: equityId, confidence: 0.9, method: 'ticker_exact' },
    ]);
    await seedMinuteBars(equityId, ANCHOR, [
      [-1, '100.000000'],
      [1440, '90.000000'], // -1000bps 1d move, well past RECOVERY_TRIGGER_BPS
    ]);
    // Only ~3 days of post-anchor daily data, never approaching a reversion —
    // windowDaysUsed stays far short of the 30d ask.
    await seedDailyBars(equityId, [
      ['2002-06-05', '85.000000'],
      ['2002-06-06', '80.000000'],
    ]);

    await measureReactions(db, { sinceHours: SINCE_HOURS, now: NOW });
    expect(
      await db
        .select()
        .from(recoveryMeasurements)
        .where(eq(recoveryMeasurements.instrumentId, equityId)),
    ).toHaveLength(0);
  });

  it('writes a completed-window recovery row even with no reversion (NULL genuinely means "never")', async () => {
    const equityId = await seedInstrument('RCFW', 'us_equity');
    await seedClusterWithLinks(ANCHOR, [
      { instrumentId: equityId, confidence: 0.9, method: 'ticker_exact' },
    ]);
    await seedMinuteBars(equityId, ANCHOR, [
      [-1, '100.000000'],
      [1440, '90.000000'], // -1000bps 1d move
    ]);
    // Stays down the ENTIRE 30d window — never reverts, but the window is
    // (near) complete, so the NULL reversion times are the final answer.
    const dailyEntries: [string, string][] = [];
    for (let d = 2; d <= 29; d++) {
      const day = new Date(ANCHOR_MIDNIGHT.getTime() + d * DAY_MS).toISOString().slice(0, 10);
      dailyEntries.push([day, '80.000000']);
    }
    await seedDailyBars(equityId, dailyEntries);

    await measureReactions(db, { sinceHours: SINCE_HOURS, now: NOW });
    const rows = await db
      .select()
      .from(recoveryMeasurements)
      .where(eq(recoveryMeasurements.instrumentId, equityId));
    expect(rows).toHaveLength(1);
    expect(rows[0]?.timeToFullReversionHours).toBeNull();
    expect(rows[0]?.windowDays).toBeGreaterThanOrEqual(29 - 1);
  });

  it('"queue for open": a Saturday anchor with a following Mon-Fri session produces 1d/3d/5d rows, a summary, and recovery', async () => {
    // A 2002 Saturday, 14:00 UTC — off-hours anchor, no trading until Monday.
    const satAnchor = new Date('2002-06-08T14:00:00.000Z');
    const equityId = await seedInstrument('RCQO', 'us_equity');
    await seedClusterWithLinks(satAnchor, [
      { instrumentId: equityId, confidence: 0.9, method: 'ticker_exact' },
    ]);
    await seedMinuteBars(equityId, satAnchor, [
      [-1, '100.000000'], // anchor bar (Saturday, close-time rule)
      [2880, '94.000000'], // Monday (+2d) — 1d falls forward here
      [4320, '92.000000'], // Tuesday, exactly anchor+3d
      [5760, '90.000000'], // Wednesday
      [7200, '89.000000'], // Thursday, exactly anchor+5d
      [8640, '91.000000'], // Friday
    ]);
    // Full reversion ~10 days out makes the recovery row a FINAL answer
    // (fix 5's conclusiveness gate), not a partial-window one.
    await seedDailyBars(equityId, [['2002-06-18', '101.000000']]);

    const totals = await measureReactions(db, { sinceHours: SINCE_HOURS, now: NOW });
    expect(totals.measured).toBe(1);
    expect(totals.skippedNoBars).toBe(0);

    const rows = await db
      .select()
      .from(reactionMeasurements)
      .where(eq(reactionMeasurements.instrumentId, equityId));
    const byHorizon = new Map(rows.map((r) => [r.horizon, r]));
    expect(byHorizon.get('1d')?.rawReturnBps).toBeCloseTo(-600, 1); // fell forward to Monday
    expect(byHorizon.get('3d')?.rawReturnBps).toBeCloseTo(-800, 1);
    expect(byHorizon.get('5d')?.rawReturnBps).toBeCloseTo(-1100, 1);

    const summaries = await db
      .select()
      .from(reactionSummary)
      .where(eq(reactionSummary.instrumentId, equityId));
    expect(summaries).toHaveLength(1);
    expect(summaries[0]?.direction1d).toBe('down');

    const recoveries = await db
      .select()
      .from(recoveryMeasurements)
      .where(eq(recoveryMeasurements.instrumentId, equityId));
    expect(recoveries).toHaveLength(1);
    expect(recoveries[0]?.timeToFullReversionHours).not.toBeNull();
  });

  it('"queue for open" still skips when the series ends exactly at the anchor bar (no proof of a settled gap yet)', async () => {
    const satAnchor = new Date('2002-06-08T14:00:00.000Z');
    const equityId = await seedInstrument('RCND', 'us_equity');
    await seedClusterWithLinks(satAnchor, [
      { instrumentId: equityId, confidence: 0.9, method: 'ticker_exact' },
    ]);
    await seedMinuteBars(equityId, satAnchor, [[-1, '100.000000']]); // nothing after

    const totals = await measureReactions(db, { sinceHours: SINCE_HOURS, now: NOW });
    expect(totals.measured).toBe(0);
    expect(totals.skippedNoBars).toBe(1);
    expect(
      await db
        .select()
        .from(reactionMeasurements)
        .where(eq(reactionMeasurements.instrumentId, equityId)),
    ).toHaveLength(0);
  });
});

// ------------------------------------------------------------------ helpers --

/**
 * Create (if missing) the suite's dedicated database next to the shared
 * TEST_DATABASE_URL one and return its URL. Idempotent across runs; mirrors
 * resolve-repo.test.ts / clustering-repo.test.ts.
 */
async function createSuiteDatabase(adminUrl: string): Promise<string> {
  const parsed = new URL(adminUrl);
  const baseName = parsed.pathname.replace(/^\//, '') || 'postgres';
  const suiteName = `${baseName}_reaction`.replace(/[^a-zA-Z0-9_]/g, '_');

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
