import { migrate } from 'drizzle-orm/node-postgres/migrator';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';

import { decide, DEFAULT_RULES_V1, newId, type RulesConfig } from '@newstrader/core';

import { createDb, type Db } from '../client.js';
import {
  decisions,
  instruments,
  itemInstrumentLinks,
  llmSignals,
  newsClusterItems,
  newsClusters,
  newsSources,
  priceBars1d,
  priceBars1m,
  rawNewsItems,
  replayRunMetrics,
  replayRuns,
  rulesVersions,
} from '../schema.js';
import { createRulesVersion } from '../trading/rules-repo.js';
import { runBacktest } from './backtest.js';

/**
 * The backtest's only real risk is look-ahead: a number that could not have been
 * known at the decision instant. These tests are written against that, not
 * against P&L arithmetic — a backtest that returns a beautiful number from
 * tomorrow's prices is worse than useless.
 */

const ANCHOR = new Date('2026-08-10T14:00:00.000Z');
const LAG_MS = 10 * 60_000;
const DECISION_AT = new Date(ANCHOR.getTime() + LAG_MS);

/** Whitelists the event type and drops the gates that need history we do not seed. */
const TRADING_RULES: RulesConfig = {
  ...DEFAULT_RULES_V1,
  gates: {
    ...DEFAULT_RULES_V1.gates,
    eventTypeWhitelist: ['earnings_result'],
    rejectCalendarMatch: false,
    minMedianDollarVolume: 0,
    minConfidence: 0.5,
    staleMoveMaxBps: 100_000,
  },
};

const testDatabaseUrl = process.env.TEST_DATABASE_URL;

describe.skipIf(!testDatabaseUrl)('runBacktest', () => {
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
    await db.delete(priceBars1d);
    await db.delete(itemInstrumentLinks);
    await db.delete(newsClusterItems);
    await db.delete(rawNewsItems);
    await db.delete(newsClusters);
    await db.delete(instruments);
    await db.delete(newsSources);
  }

  async function seedSignal(input: {
    symbol: string;
    anchorTs?: Date;
    direction?: 'bullish' | 'bearish' | 'neutral';
    confidence?: number;
    promptVersion?: string;
    transport?: 'api' | 'cli';
    horizon?: 'intraday' | '1d' | '3d' | '5d';
  }): Promise<{ instrumentId: string; signalId: string }> {
    const instrumentId = newId();
    await db.insert(instruments).values({
      id: instrumentId,
      symbol: input.symbol,
      assetClass: 'us_equity',
      name: `${input.symbol} Inc`,
    });
    const sourceId = newId();
    await db.insert(newsSources).values({
      id: sourceId,
      sourceKey: `src_${sourceId.slice(-8)}`,
      kind: 'newsapi',
      name: 'test',
    });
    const anchorTs = input.anchorTs ?? ANCHOR;
    const itemId = newId();
    await db.insert(rawNewsItems).values({
      id: itemId,
      sourceId,
      externalId: itemId,
      headline: `${input.symbol} beats`,
      payloadRef: `payload/${itemId}`,
      contentHash: newId(),
      receivedAt: anchorTs,
      meta: {},
    });
    const clusterId = newId();
    await db.insert(newsClusters).values({
      id: clusterId,
      canonicalHeadline: `${input.symbol} beats`,
      normalizedHeadline: `${input.symbol.toLowerCase()} beats`,
      firstItemId: itemId,
      firstSourceId: sourceId,
      firstReceivedAt: anchorTs,
      itemCount: 1,
      distinctSourceCount: 1,
      lastItemAt: anchorTs,
    });
    await db.insert(newsClusterItems).values({
      clusterId,
      itemId,
      similarity: 1,
      lagFromFirstMs: 0,
    });
    const signalId = newId();
    await db.insert(llmSignals).values({
      id: signalId,
      signalKey: `${clusterId}:${instrumentId}:${input.promptVersion ?? 'v3'}:m`,
      clusterId,
      scope: 'company',
      instrumentId,
      eventType: 'earnings_result',
      direction: input.direction ?? 'bullish',
      expectedMoveBps: 400,
      horizon: input.horizon ?? '1d',
      alreadyExpected: false,
      materiality: 0.8,
      confidence: input.confidence ?? 0.8,
      modelId: 'claude-sonnet-5',
      promptVersion: input.promptVersion ?? 'v3',
      transport: input.transport ?? 'api',
      clusterItemCountAtAnalysis: 1,
      retrospective: true,
      // Deliberately TODAY — a backfilled row's analyzed_at is when the LLM ran,
      // not when the news broke. Nothing may key off it.
      analyzedAt: new Date('2026-08-22T00:00:00.000Z'),
    });
    return { instrumentId, signalId };
  }

  async function seedBars(
    instrumentId: string,
    minute: Array<[number, string]>,
    daily?: Array<[number, string, string, string]>,
  ): Promise<void> {
    if (minute.length > 0) {
      await db.insert(priceBars1m).values(
        minute.map(([ms, close]) => ({
          instrumentId,
          ts: new Date(ms),
          open: close,
          high: close,
          low: close,
          close,
          volume: '100000',
          source: 'test',
        })),
      );
    }
    if (daily !== undefined && daily.length > 0) {
      await db.insert(priceBars1d).values(
        daily.map(([ms, high, low, close]) => ({
          instrumentId,
          ts: new Date(ms),
          open: close,
          high,
          low,
          close,
          volume: '5000000',
          source: 'test',
        })),
      );
    }
  }

  /** 30 daily bars ending before the anchor, so ATR and $volume are computable. */
  async function seedAtrHistory(instrumentId: string, anchorTs = ANCHOR): Promise<void> {
    const daily: Array<[number, string, string, string]> = [];
    for (let day = 30; day >= 1; day -= 1) {
      daily.push([anchorTs.getTime() - day * 86_400_000, '102.00', '98.00', '100.00']);
    }
    await seedBars(instrumentId, [], daily);
  }

  async function rules(config: RulesConfig = TRADING_RULES): Promise<string> {
    const record = await createRulesVersion(db, { label: 'backtest-test', config });
    return record.label;
  }

  it('dates the decision from the news anchor plus the pipeline lag, never from analyzed_at', async () => {
    const { instrumentId } = await seedSignal({ symbol: 'AAA' });
    await seedAtrHistory(instrumentId);
    await seedBars(instrumentId, [
      [ANCHOR.getTime() - 120_000, '100.00'],
      [DECISION_AT.getTime() - 60_000, '101.00'],
    ]);
    const label = await rules();

    const result = await runBacktest(
      db,
      { decide, engineVersion: 'test' },
      { rulesLabel: label, pipelineLagMs: LAG_MS },
    );

    expect(result.examined).toBe(1);
    expect(result.opens).toBe(1);
    expect(result.firstDecisionAt).toBe(DECISION_AT.toISOString());
    const rows = await db.select().from(decisions);
    expect(rows).toHaveLength(1);
    // Not 2026-08-22, when the interpretation was actually produced.
    expect(rows[0]?.decidedAt.toISOString()).toBe(DECISION_AT.toISOString());
    expect(rows[0]?.replayRunId).not.toBeNull();
  });

  it('prices the entry from the last bar at or before the decision, ignoring later bars', async () => {
    const { instrumentId } = await seedSignal({ symbol: 'BBB' });
    await seedAtrHistory(instrumentId);
    await seedBars(instrumentId, [
      [ANCHOR.getTime() - 120_000, '100.00'],
      [DECISION_AT.getTime() - 60_000, '101.00'],
      // The move the strategy is trying to predict. Reading this as the entry
      // price would make every trade look free.
      [DECISION_AT.getTime() + 60_000, '150.00'],
    ]);
    const label = await rules();

    await runBacktest(
      db,
      { decide, engineVersion: 'test' },
      { rulesLabel: label, pipelineLagMs: LAG_MS },
    );

    const row = (await db.select().from(decisions))[0];
    const quote = row?.quoteSnapshot as { price?: string };
    expect(quote.price).toBe('101.000000');
    expect(quote.price).not.toBe('150.000000');
  });

  it('excludes cli-transport rows by default and admits them on request', async () => {
    const api = await seedSignal({ symbol: 'CCC', transport: 'api' });
    const cli = await seedSignal({ symbol: 'DDD', transport: 'cli' });
    for (const seeded of [api, cli]) {
      await seedAtrHistory(seeded.instrumentId);
      await seedBars(seeded.instrumentId, [
        [ANCHOR.getTime() - 120_000, '100.00'],
        [DECISION_AT.getTime() - 60_000, '100.00'],
      ]);
    }
    const label = await rules();

    const defaults = await runBacktest(
      db,
      { decide, engineVersion: 'test' },
      { rulesLabel: label, pipelineLagMs: LAG_MS, persist: false },
    );
    expect(defaults.examined).toBe(1);

    const both = await runBacktest(
      db,
      { decide, engineVersion: 'test' },
      { rulesLabel: label, pipelineLagMs: LAG_MS, transports: ['api', 'cli'], persist: false },
    );
    expect(both.examined).toBe(2);
  });

  it('carries the portfolio forward: a second signal sees the first position', async () => {
    const first = await seedSignal({ symbol: 'EEE' });
    const later = new Date(ANCHOR.getTime() + 60 * 60_000);
    const second = await seedSignal({ symbol: 'FFF', anchorTs: later });
    for (const seeded of [first, second]) {
      await seedAtrHistory(seeded.instrumentId);
    }
    await seedBars(first.instrumentId, [
      // Pre-anchor close: without it priceMoveSinceAnchorBps is null and the
      // stale-move gate fail-closes, which is correct but tests nothing here.
      [ANCHOR.getTime() - 120_000, '100.00'],
      [DECISION_AT.getTime() - 60_000, '100.00'],
      // Flat for the whole horizon so nothing exits before the second decision.
      [later.getTime() + LAG_MS - 60_000, '100.00'],
    ]);
    await seedBars(second.instrumentId, [
      [later.getTime() - 120_000, '100.00'],
      [later.getTime() + LAG_MS - 60_000, '100.00'],
    ]);
    const label = await rules({
      ...TRADING_RULES,
      gates: { ...TRADING_RULES.gates, maxConcurrentPositions: 1 },
    });

    const result = await runBacktest(
      db,
      { decide, engineVersion: 'test' },
      { rulesLabel: label, pipelineLagMs: LAG_MS },
    );

    // One open, then the concurrency gate stops the second — which only works
    // if the ledger state from the first decision reached the second.
    expect(result.opens).toBe(1);
    expect(result.skips).toBe(1);
    const rows = await db.select().from(decisions);
    const second_ = rows.find((row) => row.action === 'skip');
    const features = second_?.features as { openPositionsCount?: number };
    expect(features.openPositionsCount).toBe(1);
  });

  it('closes on a rule and prices both legs through the production fill model', async () => {
    const { instrumentId } = await seedSignal({ symbol: 'GGG', horizon: 'intraday' });
    await seedAtrHistory(instrumentId);
    // Entry at 100, then a flat rise to 110 across the intraday horizon.
    const minute: Array<[number, string]> = [
      [ANCHOR.getTime() - 120_000, '100.00'],
      [DECISION_AT.getTime() - 60_000, '100.00'],
    ];
    for (let step = 1; step <= 400; step += 1) {
      minute.push([DECISION_AT.getTime() + step * 60_000, '110.00']);
    }
    await seedBars(instrumentId, minute);
    const label = await rules();

    const result = await runBacktest(
      db,
      { decide, engineVersion: 'test' },
      { rulesLabel: label, pipelineLagMs: LAG_MS },
    );

    expect(result.opens).toBe(1);
    expect(result.trades).toBe(1);
    expect(result.stillOpen).toBe(0);
    const trade = result.closedTrades[0];
    expect(trade?.side).toBe('long');
    // Exited by a rule, not by running out of data.
    expect(['time_stop', 'take_profit', 'stop_loss']).toContain(trade?.exitReason);
    expect(Number(trade?.realizedUsd)).toBeGreaterThan(0);
    // The production fill model is doing the filling, not a naive mark: 5 bps
    // of slippage each way off the 100.00 / 110.00 reference prices. (Fees are
    // 0 for us_equity by design — see SIM_FEE_BPS.)
    expect(trade?.entryPrice).toBe('100.05');
    expect(Number(trade?.exitPrice)).toBeLessThan(110);
  });

  it('records skips with their reason so the funnel is visible', async () => {
    // Confidence below the gate: the engine must still write a decision.
    const { instrumentId } = await seedSignal({ symbol: 'HHH', confidence: 0.51 });
    await seedAtrHistory(instrumentId);
    await seedBars(instrumentId, [[DECISION_AT.getTime() - 60_000, '100.00']]);
    const label = await rules({
      ...TRADING_RULES,
      gates: { ...TRADING_RULES.gates, minConfidence: 0.9 },
    });

    const result = await runBacktest(
      db,
      { decide, engineVersion: 'test' },
      { rulesLabel: label, pipelineLagMs: LAG_MS },
    );

    expect(result.opens).toBe(0);
    expect(result.skips).toBe(1);
    expect(result.skipReasons[0]?.count).toBe(1);
    const rows = await db.select().from(decisions);
    expect(rows[0]?.action).toBe('skip');
    expect(rows[0]?.skipReason).not.toBeNull();
    expect((rows[0]?.gates as unknown[]).length).toBeGreaterThan(0);
  });

  it('skips with no_quote when no bar exists at the decision instant', async () => {
    const { instrumentId } = await seedSignal({ symbol: 'III' });
    await seedAtrHistory(instrumentId);
    // Only a bar AFTER the decision — the honest answer is "no price then".
    await seedBars(instrumentId, [[DECISION_AT.getTime() + 3_600_000, '100.00']]);
    const label = await rules();

    const result = await runBacktest(
      db,
      { decide, engineVersion: 'test' },
      { rulesLabel: label, pipelineLagMs: LAG_MS },
    );

    expect(result.noQuote).toBe(1);
    expect(result.opens).toBe(0);
  });

  it('writes nothing with persist: false', async () => {
    const { instrumentId } = await seedSignal({ symbol: 'JJJ' });
    await seedAtrHistory(instrumentId);
    await seedBars(instrumentId, [[DECISION_AT.getTime() - 60_000, '100.00']]);
    const label = await rules();

    await runBacktest(
      db,
      { decide, engineVersion: 'test' },
      { rulesLabel: label, pipelineLagMs: LAG_MS, persist: false },
    );

    expect(await db.select().from(decisions)).toHaveLength(0);
    expect(await db.select().from(replayRuns)).toHaveLength(0);
  });
});

/** Suite-private database — see the working rules in CLAUDE.md. */
async function createSuiteDatabase(adminUrl: string): Promise<string> {
  const parsed = new URL(adminUrl);
  const baseName = parsed.pathname.replace(/^\//, '') || 'postgres';
  const suiteName = `${baseName}_backtest`.replace(/[^a-zA-Z0-9_]/g, '_');

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
