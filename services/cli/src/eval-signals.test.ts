import { newId } from '@newstrader/core';
import {
  createDb,
  instruments,
  llmSignals,
  newsClusters,
  newsSources,
  priceBars1m,
  rawNewsItems,
  reactionMeasurements,
  reactionSummary,
  scheduledEvents,
} from '@newstrader/db';
import type { Db } from '@newstrader/db';
import { execFileSync } from 'node:child_process';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import {
  calibrationReport,
  compareVersions,
  dedupeByCluster,
  eventTypeReport,
  expectedVsCalendar,
  loadEvalRows,
  loadNextOpenRows,
  neutralReport,
  reactionSpeedReport,
  restrictToAnsweredIntersection,
  sessionSummary,
  whitelistBridge,
  type EvalRow,
} from './eval-signals.js';

/**
 * The eval join's real risks are in SQL: the NY-session bucketing (DST is
 * Postgres's job), the deterministic calendar_match probe, the horizon pivot,
 * the retrospective/transport hygiene filters, and the next-open lateral
 * legs. Seeded once, asserted read-only — the pure assemblers are then
 * exercised on the loaded rows.
 *
 * Dates: 2026-08-07 = Friday … 2026-08-10 = Monday, all EDT (UTC−4).
 */

// Monday 14:30Z = 10:30 EDT → rth.
const ANCHOR_RTH = new Date('2026-08-10T14:30:00.000Z');
// Saturday 15:00Z = 11:00 EDT → weekend.
const ANCHOR_WEEKEND = new Date('2026-08-08T15:00:00.000Z');
// Monday 21:30Z = 17:30 EDT → post.
const ANCHOR_POST = new Date('2026-08-10T21:30:00.000Z');

const MEASURER = 'm2';
const VERSION_A = 'v-a';
const VERSION_B = 'v-b';

const testDatabaseUrl = process.env.TEST_DATABASE_URL;

describe.skipIf(!testDatabaseUrl)('eval:signals', () => {
  let db: Db;
  let rows: EvalRow[] = [];
  const instrumentIds = { AAA: '', BBB: '', CCC: '', SPY: '' };

  beforeAll(async () => {
    const suiteUrl = await createSuiteDatabase(testDatabaseUrl as string);
    migrateDatabase(suiteUrl);
    db = createDb(suiteUrl);
    await seed();
    rows = await loadEvalRows(db, {
      versions: [VERSION_A],
      transports: ['api'],
      measurer: MEASURER,
      includeRetrospective: false,
      holdout: false,
    });
  }, 120_000);

  afterAll(async () => {
    await db.$client.end();
  });

  async function seedInstrument(symbol: keyof typeof instrumentIds): Promise<string> {
    const id = newId();
    instrumentIds[symbol] = id;
    await db.insert(instruments).values({
      id,
      symbol,
      assetClass: 'us_equity',
      name: `${symbol} Inc`,
    });
    return id;
  }

  async function seedCluster(anchor: Date, headline: string): Promise<string> {
    const sourceId = newId();
    await db.insert(newsSources).values({
      id: sourceId,
      sourceKey: `src_${sourceId.slice(-8)}`,
      kind: 'newsapi',
      name: 'test',
    });
    const itemId = newId();
    await db.insert(rawNewsItems).values({
      id: itemId,
      sourceId,
      externalId: itemId,
      headline,
      payloadRef: `payload/${itemId}`,
      contentHash: newId(),
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
    return clusterId;
  }

  async function seedSignal(input: {
    clusterId: string;
    instrumentId: string;
    direction: 'bullish' | 'bearish' | 'neutral';
    confidence: number;
    materiality?: number;
    eventType?: string;
    promptVersion?: string;
    transport?: 'api' | 'cli';
    retrospective?: boolean;
    alreadyExpected?: boolean;
  }): Promise<void> {
    const id = newId();
    await db.insert(llmSignals).values({
      id,
      signalKey: id,
      clusterId: input.clusterId,
      scope: 'company',
      instrumentId: input.instrumentId,
      eventType: input.eventType ?? 'earnings_result',
      direction: input.direction,
      expectedMoveBps: 200,
      horizon: '1d',
      alreadyExpected: input.alreadyExpected ?? false,
      materiality: input.materiality ?? 0.5,
      confidence: input.confidence,
      modelId: 'model',
      promptVersion: input.promptVersion ?? VERSION_A,
      transport: input.transport ?? 'api',
      retrospective: input.retrospective ?? false,
      analyzedAt: new Date('2026-08-11T00:00:00.000Z'),
    });
  }

  async function seedReaction(input: {
    clusterId: string;
    instrumentId: string;
    anchor: Date;
    abn1d: number;
    abn5m?: number;
    beta?: number;
    tthm?: number;
  }): Promise<void> {
    const horizons: Array<['5m' | '1d', number | undefined]> = [
      ['5m', input.abn5m],
      ['1d', input.abn1d],
    ];
    for (const [horizon, abn] of horizons) {
      if (abn === undefined) continue;
      await db.insert(reactionMeasurements).values({
        clusterId: input.clusterId,
        instrumentId: input.instrumentId,
        horizon,
        measurerVersion: MEASURER,
        anchorTs: input.anchor,
        rawReturnBps: abn,
        abnormalReturnBps: abn,
        benchmark: 'SPY',
        betaUsed: input.beta ?? 1,
        barsSource: 'test',
      });
    }
    if (input.tthm !== undefined) {
      await db.insert(reactionSummary).values({
        clusterId: input.clusterId,
        instrumentId: input.instrumentId,
        measurerVersion: MEASURER,
        anchorTs: input.anchor,
        peakAbnormalMoveBps: input.abn1d,
        timeToPeakMinutes: input.tthm,
        timeToHalfOf1dMoveMinutes: input.tthm,
        direction1d: input.abn1d > 0 ? 'up' : 'down',
      });
    }
  }

  async function seedBar(instrumentId: string, ts: Date, close: string): Promise<void> {
    await db.insert(priceBars1m).values({
      instrumentId,
      ts,
      open: close,
      high: close,
      low: close,
      close,
      source: 'test',
    });
  }

  async function seed(): Promise<void> {
    // Seeded ONCE per run and read-only in the tests, so the wipe lives here:
    // without it a second run would double every count.
    await db.delete(reactionSummary);
    await db.delete(reactionMeasurements);
    await db.delete(scheduledEvents);
    await db.delete(llmSignals);
    await db.delete(priceBars1m);
    await db.delete(rawNewsItems);
    await db.delete(newsClusters);
    await db.delete(instruments);
    await db.delete(newsSources);

    const aaa = await seedInstrument('AAA');
    const bbb = await seedInstrument('BBB');
    const ccc = await seedInstrument('CCC');
    const spy = await seedInstrument('SPY');

    // Cluster A: rth, bullish 0.9, HIT (+150), calendar-matched earnings,
    // already_expected=true. A second version-B row feeds the paired A/B view.
    const clusterA = await seedCluster(ANCHOR_RTH, 'AAA beats');
    await seedSignal({
      clusterId: clusterA,
      instrumentId: aaa,
      direction: 'bullish',
      confidence: 0.9,
      materiality: 0.8,
      alreadyExpected: true,
    });
    await seedSignal({
      clusterId: clusterA,
      instrumentId: aaa,
      direction: 'bearish',
      confidence: 0.7,
      promptVersion: VERSION_B,
    });
    await seedReaction({
      clusterId: clusterA,
      instrumentId: aaa,
      anchor: ANCHOR_RTH,
      abn1d: 150,
      abn5m: 50,
      tthm: 30,
    });
    await db.insert(scheduledEvents).values({
      id: newId(),
      eventKey: `earnings:AAA:${ANCHOR_RTH.toISOString()}`,
      kind: 'earnings',
      instrumentId: aaa,
      scheduledAt: new Date(ANCHOR_RTH.getTime() + 30 * 60_000),
      source: 'test',
    });

    // Cluster B: weekend, bearish 0.3, MISS (+80), guidance_update.
    const clusterB = await seedCluster(ANCHOR_WEEKEND, 'BBB warns');
    await seedSignal({
      clusterId: clusterB,
      instrumentId: bbb,
      direction: 'bearish',
      confidence: 0.3,
      materiality: 0.2,
      eventType: 'guidance_update',
    });
    await seedReaction({
      clusterId: clusterB,
      instrumentId: bbb,
      anchor: ANCHOR_WEEKEND,
      abn1d: 80,
      beta: 1,
    });
    // Next-open legs for cluster B: Friday anchor close, Monday 09:30 EDT open
    // bar, and the same two legs for SPY (benchmark).
    await seedBar(bbb, new Date('2026-08-07T19:59:00.000Z'), '100.000000');
    await seedBar(bbb, new Date('2026-08-10T13:30:00.000Z'), '102.000000');
    await seedBar(spy, new Date('2026-08-07T19:59:00.000Z'), '500.000000');
    await seedBar(spy, new Date('2026-08-10T13:30:00.000Z'), '505.000000');

    // Cluster C: post, neutral 0.6, small move (+20).
    const clusterC = await seedCluster(ANCHOR_POST, 'CCC notes');
    await seedSignal({
      clusterId: clusterC,
      instrumentId: ccc,
      direction: 'neutral',
      confidence: 0.6,
      eventType: 'other',
    });
    await seedReaction({ clusterId: clusterC, instrumentId: ccc, anchor: ANCHOR_POST, abn1d: 20 });

    // Hygiene traps: a retrospective row and a cli-transport row on cluster C
    // (must be filtered), and a cluster with NO settled 1d (must not join).
    await seedSignal({
      clusterId: clusterC,
      instrumentId: ccc,
      direction: 'bullish',
      confidence: 0.99,
      retrospective: true,
    });
    await seedSignal({
      clusterId: clusterC,
      instrumentId: ccc,
      direction: 'bullish',
      confidence: 0.99,
      transport: 'cli',
    });
    const clusterD = await seedCluster(new Date('2026-08-10T15:00:00.000Z'), 'DDD unmeasured');
    await seedSignal({
      clusterId: clusterD,
      instrumentId: aaa,
      direction: 'bullish',
      confidence: 0.9,
    });
  }

  it('joins signals to settled 1d measurements with session + calendar computed in SQL', () => {
    expect(rows).toHaveLength(3);
    const bySession = new Map(rows.map((row) => [row.session, row]));
    expect([...bySession.keys()].sort()).toEqual(['post', 'rth', 'weekend']);

    const rth = bySession.get('rth');
    expect(rth?.direction).toBe('bullish');
    expect(rth?.calendarMatch).toBe(true); // earnings for THIS instrument, 30 min after anchor
    expect(rth?.alreadyExpected).toBe(true);
    expect(rth?.abn['1d']).toBe(150);
    expect(rth?.abn['5m']).toBe(50);
    expect(rth?.abn['3d']).toBeNull();
    expect(rth?.tthm).toBe(30);

    const weekend = bySession.get('weekend');
    expect(weekend?.calendarMatch).toBe(false);
    expect(weekend?.tthm).toBeNull();
  });

  it('excludes retrospective and cli-transport rows by default', () => {
    // Cluster C would carry three signals; only the api, non-retrospective
    // neutral one may survive the defaults.
    const clusterCRows = rows.filter((row) => row.session === 'post');
    expect(clusterCRows).toHaveLength(1);
    expect(clusterCRows[0]?.direction).toBe('neutral');
  });

  it('calibration: deciles, ECE, and confidence slices over directional rows', () => {
    const calibration = calibrationReport(rows);
    expect(calibration.n).toBe(2); // neutral excluded
    expect(calibration.buckets[9]?.n).toBe(1); // 0.9 bullish, hit
    expect(calibration.buckets[9]?.hitRate).toBe(1);
    expect(calibration.buckets[3]?.n).toBe(1); // 0.3 bearish, miss (+80)
    expect(calibration.buckets[3]?.hitRate).toBe(0);
    expect(calibration.ece).not.toBeNull();
    expect(calibration.sliceHighConfidence.n).toBe(1);
    expect(calibration.sliceHighConfidence.rate).toBe(1);
    expect(calibration.sliceLowConfidence.n).toBe(1);
    expect(calibration.sliceLowConfidence.rate).toBe(0);
  });

  it('per-event-type, neutral scoring, session summary, and reaction speed', () => {
    const events = eventTypeReport(rows);
    const earnings = events.find((row) => row.eventType === 'earnings_result');
    expect(earnings?.n).toBe(1);
    expect(earnings?.hit.rate).toBe(1);
    expect(earnings?.bigMoveShare).toBe(1); // |150| ≥ 100
    const guidance = events.find((row) => row.eventType === 'guidance_update');
    expect(guidance?.hit.rate).toBe(0);
    expect(guidance?.bigMoveShare).toBe(0);

    const neutral = neutralReport(rows);
    expect(neutral.n).toBe(1);
    expect(neutral.byThreshold.find((t) => t.thresholdBps === 100)?.rate).toBe(1); // |20| < 100
    expect(neutral.byThreshold.find((t) => t.thresholdBps === 50)?.rate).toBe(1);

    const sessions = sessionSummary(rows);
    expect(sessions.map((row) => row.session)).toEqual(['weekend', 'rth', 'post']);
    expect(sessions.find((row) => row.session === 'rth')?.medianTthm).toBe(30);

    const speed = reactionSpeedReport(rows);
    expect(speed.overall.n).toBe(1);
    expect(speed.overall.medianTthm).toBe(30);
    // Capture ratio: only the rth row has |abn 1d| ≥ 100 AND a 5m horizon.
    const fiveMin = speed.captureRatios.find((row) => row.horizon === '5m');
    expect(fiveMin?.n).toBe(1);
    expect(fiveMin?.medianRatio).toBeCloseTo(50 / 150, 10);
  });

  it('whitelist bridge: signed drift with the n-gate verdict', () => {
    const bridge = whitelistBridge(rows, { costBps: 20, horizons: ['1d'] });
    const earnings = bridge.find((row) => row.eventType === 'earnings_result');
    expect(earnings?.medianSignedBps).toBe(150);
    expect(earnings?.beatsCosts).toBe('n<20'); // beats the cost, but n=1
    const guidance = bridge.find((row) => row.eventType === 'guidance_update');
    expect(guidance?.medianSignedBps).toBe(-80); // bearish sign flip
  });

  it('already_expected × calendar_match cross-table', () => {
    const cross = expectedVsCalendar(rows);
    const both = cross.cells.find((cell) => cell.alreadyExpected && cell.calendarMatch);
    expect(both?.n).toBe(1); // cluster A
    const neither = cross.cells.find((cell) => !cell.alreadyExpected && !cell.calendarMatch);
    expect(neither?.n).toBe(2); // clusters B and C
    expect(cross.agreementRate).toBe(1);
  });

  it('multi-version: intersection restriction and the paired direction-flip view', async () => {
    const bothVersions = await loadEvalRows(db, {
      versions: [VERSION_A, VERSION_B],
      transports: ['api'],
      measurer: MEASURER,
      includeRetrospective: false,
      holdout: false,
    });
    const intersected = restrictToAnsweredIntersection(bothVersions, [VERSION_A, VERSION_B]);
    // Only cluster A's pair was answered by BOTH versions.
    expect(new Set(intersected.map((row) => row.clusterId)).size).toBe(1);
    expect(intersected).toHaveLength(2);

    const comparison = compareVersions(
      intersected.filter((row) => row.promptVersion === VERSION_A),
      intersected.filter((row) => row.promptVersion === VERSION_B),
      VERSION_A,
      VERSION_B,
    );
    expect(comparison.pairs).toBe(1);
    expect(comparison.directionAgreement).toBe(0);
    expect(comparison.flips).toEqual([{ from: 'bullish', to: 'bearish', n: 1 }]);
    expect(comparison.meanConfidenceDelta).toBeCloseTo(-0.2, 5);
  });

  it('cluster dedup keeps the max-confidence pair', () => {
    const first = rows[0];
    if (first === undefined) throw new Error('seed produced no rows');
    const twoForOneCluster: EvalRow[] = [...rows, { ...first, id: 'zzz', confidence: 0.1 }];
    const deduped = dedupeByCluster(twoForOneCluster);
    expect(deduped).toHaveLength(3);
    expect(deduped.find((row) => row.id === 'zzz')).toBeUndefined();
  });

  it('next-open reaction: Friday close → Monday 09:30 ET, benchmark-adjusted', async () => {
    const nextOpen = await loadNextOpenRows(db, { measurer: MEASURER });
    // Only cluster B has both legs (cluster A is rth; cluster C has no bars).
    expect(nextOpen).toHaveLength(1);
    const weekend = nextOpen[0];
    expect(weekend?.session).toBe('weekend');
    expect(weekend?.n).toBe(1);
    // (102/100 − 1)·1e4 − 1·(505/500 − 1)·1e4 = 200 − 100 = 100 bps.
    expect(weekend?.medianAbnNextOpenBps).toBeCloseTo(100, 6);
    // |abn 1d| = 80 < 100 → excluded from gap capture.
    expect(weekend?.gapCaptureN).toBe(0);
    expect(weekend?.medianGapCapture).toBeNull();
  });
});

/** Suite-private database — see the working rules in CLAUDE.md. */
async function createSuiteDatabase(adminUrl: string): Promise<string> {
  const parsed = new URL(adminUrl);
  const baseName = parsed.pathname.replace(/^\//, '') || 'postgres';
  const suiteName = `${baseName}_cli_eval`.replace(/[^a-zA-Z0-9_]/g, '_');

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

function isDuplicateDatabase(error: unknown): boolean {
  return (
    typeof error === 'object' &&
    error !== null &&
    'code' in error &&
    (error as { code?: unknown }).code === '42P04'
  );
}

/** Run the canonical drizzle migrations — same pattern as e2e.test.ts. */
function migrateDatabase(databaseUrl: string): void {
  const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..', '..');
  execFileSync('pnpm', ['--filter', '@newstrader/db', 'migrate'], {
    cwd: repoRoot,
    env: { ...process.env, DATABASE_URL: databaseUrl },
    stdio: 'pipe',
  });
}
