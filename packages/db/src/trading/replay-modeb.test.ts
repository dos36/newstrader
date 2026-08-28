import { migrate } from 'drizzle-orm/node-postgres/migrator';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';

import {
  decide,
  DecideFeatures,
  DEFAULT_RULES_V1,
  newId,
  type RulesConfig,
} from '@newstrader/core';

import { createDb, type Db } from '../client.js';
import {
  decisions,
  instruments,
  llmSignals,
  newsClusters,
  newsSources,
  priceBars1m,
  rawNewsItems,
  replayRunMetrics,
  replayRuns,
  rulesVersions,
} from '../schema.js';
import { createReplayRun, runReplay } from './replay-repo.js';
import { loadRunMetrics } from './run-metrics-repo.js';
import { createRulesVersion } from './rules-repo.js';

/**
 * Replay Mode B's whole reason to exist is portfolio soundness: a
 * counterfactual rules version must see the portfolio ITS decisions built,
 * never the live run's. These tests are written against that property —
 * feature recomputation, intra-run causality (an earlier open blocks a later
 * same-instrument signal), the exit walk, and the metrics row.
 */

const DECIDED_AT = new Date('2026-08-10T14:10:00.000Z');
const DAY_MS = 86_400_000;

/** Live rules: empty whitelist, so every live decision was a skip. */
const LIVE_RULES: RulesConfig = DEFAULT_RULES_V1;

/** Replay rules: whitelists the event type and relaxes gates the seeds don't cover. */
const REPLAY_RULES: RulesConfig = {
  ...DEFAULT_RULES_V1,
  gates: {
    ...DEFAULT_RULES_V1.gates,
    eventTypeWhitelist: ['earnings_result'],
    rejectCalendarMatch: false,
    minMedianDollarVolume: 0,
    minConfidence: 0.5,
    staleMoveMaxBps: 100_000,
  },
  exits: { ...DEFAULT_RULES_V1.exits, defaultTimeStopHorizon: '1d' },
};

/**
 * A live-run feature snapshot whose PORTFOLIO slice says "book full": under a
 * verbatim reuse the max_concurrent_positions gate must fail, under Mode B the
 * simulated (empty) book must pass. World features are permissive.
 */
const LIVE_FEATURES: DecideFeatures = {
  clusterItemCount: 2,
  distinctSourceCount: 1,
  itemsPerHour: 1,
  calendarMatch: false,
  priceMoveSinceAnchorBps: 10,
  medianDollarVolume: 10_000_000,
  atr: '2.000000',
  openPositionsCount: 99,
  hasOpenPositionForInstrument: true,
  paperEquityUsd: '1.00',
  engineVersion: 'live-test',
};

const testDatabaseUrl = process.env.TEST_DATABASE_URL;

describe.skipIf(!testDatabaseUrl)('runReplay Mode B (simulated portfolio)', () => {
  let db: Db;

  beforeAll(async () => {
    const suiteUrl = await createSuiteDatabase(testDatabaseUrl as string);
    db = createDb(suiteUrl);
    await migrate(db, {
      migrationsFolder: new URL('../../migrations', import.meta.url).pathname,
    });
  }, 60_000);

  afterAll(async () => {
    await wipe();
    await db.$client.end();
  });

  beforeEach(async () => {
    await wipe();
  });

  async function wipe(): Promise<void> {
    await db.delete(replayRunMetrics);
    await db.delete(decisions);
    await db.delete(replayRuns);
    await db.delete(rulesVersions);
    await db.delete(llmSignals);
    await db.delete(priceBars1m);
    await db.delete(rawNewsItems);
    await db.delete(newsClusters);
    await db.delete(instruments);
    await db.delete(newsSources);
  }

  interface Seeded {
    instrumentId: string;
    signalId: string;
    liveRulesId: string;
  }

  /** One signal + its LIVE decision (skip, snapshot above) under LIVE_RULES. */
  async function seedSignalWithLiveDecision(input: {
    symbol: string;
    decidedAt?: Date;
    liveRulesId?: string;
    instrumentId?: string;
    quotePrice?: string;
  }): Promise<Seeded> {
    let instrumentId = input.instrumentId;
    if (instrumentId === undefined) {
      instrumentId = newId();
      await db.insert(instruments).values({
        id: instrumentId,
        symbol: input.symbol,
        assetClass: 'us_equity',
        name: `${input.symbol} Inc`,
      });
    }
    const sourceId = newId();
    await db.insert(newsSources).values({
      id: sourceId,
      sourceKey: `src_${sourceId.slice(-8)}`,
      kind: 'newsapi',
      name: 'test',
    });
    const anchor = new Date(DECIDED_AT.getTime() - 10 * 60_000);
    const itemId = newId();
    await db.insert(rawNewsItems).values({
      id: itemId,
      sourceId,
      externalId: itemId,
      headline: `${input.symbol} beats`,
      payloadRef: `payload/${itemId}`,
      contentHash: newId(),
      receivedAt: anchor,
    });
    const clusterId = newId();
    await db.insert(newsClusters).values({
      id: clusterId,
      canonicalHeadline: `${input.symbol} beats`,
      normalizedHeadline: `${input.symbol.toLowerCase()} beats`,
      firstItemId: itemId,
      firstSourceId: sourceId,
      firstReceivedAt: anchor,
      lastItemAt: anchor,
    });
    const signalId = newId();
    await db.insert(llmSignals).values({
      id: signalId,
      signalKey: `${clusterId}:${instrumentId}:v-test:model`,
      clusterId,
      scope: 'company',
      instrumentId,
      eventType: 'earnings_result',
      direction: 'bullish',
      expectedMoveBps: 200,
      horizon: '1d',
      alreadyExpected: false,
      materiality: 0.8,
      confidence: 0.9,
      modelId: 'model',
      promptVersion: 'v-test',
      analyzedAt: anchor,
    });

    let liveRulesId = input.liveRulesId;
    if (liveRulesId === undefined) {
      const live = await createRulesVersion(db, { label: 'live-rules', config: LIVE_RULES });
      liveRulesId = live.id;
    }
    const decidedAt = input.decidedAt ?? DECIDED_AT;
    await db.insert(decisions).values({
      id: newId(),
      decisionKey: `${signalId}:${liveRulesId}:live`,
      signalId,
      instrumentId,
      rulesVersionId: liveRulesId,
      replayRunId: null,
      decidedAt,
      action: 'skip',
      skipReason: 'event_type_whitelist',
      suppressed: false,
      gates: [],
      features: LIVE_FEATURES,
      quoteSnapshot: {
        price: input.quotePrice ?? '100.000000',
        ts: decidedAt.toISOString(),
        source: 'test',
        spreadBps: null,
      },
    });
    return { instrumentId, signalId, liveRulesId };
  }

  async function replayRules(): Promise<string> {
    const record = await createRulesVersion(db, { label: 'replay-rules', config: REPLAY_RULES });
    return record.label;
  }

  it('recomputes portfolio features from the simulated book — a full live book does not block', async () => {
    const seeded = await seedSignalWithLiveDecision({ symbol: 'AAA' });
    const label = await replayRules();
    const run = await createReplayRun(db, { rulesLabel: label, from: null, to: null });

    const totals = await runReplay(
      db,
      { decide },
      { replayRunId: run.id, simulatePortfolio: { startingCashUsd: '100000.00' } },
    );

    // Live snapshot said 99 open positions and $1 equity; the simulated book
    // is empty and fully funded, so the replayed rules OPEN.
    expect(totals.decided).toBe(1);
    expect(totals.opens).toBe(1);
    expect(totals.modeBUnsoundPortfolioFeatures).toBe(false);

    const rows = await db.select().from(decisions);
    const replayed = rows.find((row) => row.replayRunId === run.id);
    expect(replayed?.action).toBe('open_long');
    const features = DecideFeatures.parse(replayed?.features);
    expect(features.openPositionsCount).toBe(0);
    expect(features.hasOpenPositionForInstrument).toBe(false);
    expect(features.paperEquityUsd).toBe('100000'); // ledger equity, formatDec-trimmed
    // World features stay as snapshotted on the live decision.
    expect(features.medianDollarVolume).toBe(10_000_000);
    expect(features.atr).toBe('2.000000');
    void seeded;
  });

  it('threads the book through the run: an earlier open blocks a later same-instrument signal', async () => {
    const first = await seedSignalWithLiveDecision({ symbol: 'BBB' });
    // Second signal, SAME instrument, decided a minute later.
    await seedSignalWithLiveDecision({
      symbol: 'BBB',
      instrumentId: first.instrumentId,
      liveRulesId: first.liveRulesId,
      decidedAt: new Date(DECIDED_AT.getTime() + 60_000),
    });
    const label = await replayRules();
    const run = await createReplayRun(db, { rulesLabel: label, from: null, to: null });

    const totals = await runReplay(db, { decide }, { replayRunId: run.id, simulatePortfolio: {} });

    expect(totals.decided).toBe(2);
    expect(totals.opens).toBe(1);
    expect(totals.skips).toBe(1);
    const rows = await db.select().from(decisions);
    const skipRow = rows.find((row) => row.replayRunId === run.id && row.action === 'skip');
    expect(skipRow?.skipReason).toBe('no_existing_position');
    const skipFeatures = DecideFeatures.parse(skipRow?.features);
    expect(skipFeatures.hasOpenPositionForInstrument).toBe(true);
    expect(skipFeatures.openPositionsCount).toBe(1);
  });

  it('walks exits over bars and persists a replay_run_metrics row', async () => {
    const seeded = await seedSignalWithLiveDecision({ symbol: 'CCC' });
    // A bar exactly at the 1d time-stop deadline, 5% up: the walk closes there.
    await db.insert(priceBars1m).values({
      instrumentId: seeded.instrumentId,
      ts: new Date(DECIDED_AT.getTime() + DAY_MS),
      open: '105.000000',
      high: '105.000000',
      low: '105.000000',
      close: '105.000000',
      source: 'test',
    });
    const label = await replayRules();
    const run = await createReplayRun(db, { rulesLabel: label, from: null, to: null });

    const totals = await runReplay(
      db,
      { decide },
      { replayRunId: run.id, simulatePortfolio: { startingCashUsd: '100000.00' } },
    );

    expect(totals.opens).toBe(1);
    expect(totals.simulated).not.toBeNull();
    expect(totals.simulated?.metrics.trades).toBe(1);
    expect(totals.simulated?.metrics.wins).toBe(1);
    expect(totals.simulated?.stillOpen).toBe(0);
    expect(Number(totals.simulated?.metrics.realizedUsd)).toBeGreaterThan(0);

    const stored = await loadRunMetrics(db, run.id);
    expect(stored).not.toBeNull();
    expect(stored?.trades).toBe(1);
    expect(stored?.hitRate).toBe(1);
    expect(Number(stored?.realizedUsd)).toBeGreaterThan(0);
  });

  it('a rerun of the same run id is a no-op that keeps the original metrics', async () => {
    await seedSignalWithLiveDecision({ symbol: 'DDD' });
    const label = await replayRules();
    const run = await createReplayRun(db, { rulesLabel: label, from: null, to: null });
    const first = await runReplay(db, { decide }, { replayRunId: run.id, simulatePortfolio: {} });
    expect(first.decided).toBe(1);

    const second = await runReplay(db, { decide }, { replayRunId: run.id, simulatePortfolio: {} });
    expect(second.decided).toBe(0); // every insert conflicted
    // The ledger replayed the identical trajectory, so the reported outcome matches.
    expect(second.simulated?.metrics.trades).toBe(first.simulated?.metrics.trades);
    const metricsRows = await db.select().from(replayRunMetrics);
    expect(metricsRows).toHaveLength(1);
  });

  it('Mode A still warns (and does not simulate) on a label mismatch', async () => {
    await seedSignalWithLiveDecision({ symbol: 'EEE' });
    const label = await replayRules();
    const run = await createReplayRun(db, { rulesLabel: label, from: null, to: null });

    const totals = await runReplay(db, { decide }, { replayRunId: run.id });

    expect(totals.simulated).toBeNull();
    expect(totals.modeBUnsoundPortfolioFeatures).toBe(true);
    // Verbatim reuse: the full live book blocks the open.
    const rows = await db.select().from(decisions);
    const replayed = rows.find((row) => row.replayRunId === run.id);
    expect(replayed?.action).toBe('skip');
    expect(replayed?.skipReason).toBe('max_concurrent_positions');
    expect(await loadRunMetrics(db, run.id)).toBeNull();
  });
});

/** Suite-private database — see the working rules in CLAUDE.md. */
async function createSuiteDatabase(adminUrl: string): Promise<string> {
  const parsed = new URL(adminUrl);
  const baseName = parsed.pathname.replace(/^\//, '') || 'postgres';
  const suiteName = `${baseName}_replay_modeb`.replace(/[^a-zA-Z0-9_]/g, '_');

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
