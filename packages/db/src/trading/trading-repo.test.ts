/**
 * DB-backed trading-orchestration tests — skipped when TEST_DATABASE_URL is
 * unset.
 *
 * Run:
 *   docker compose up -d postgres
 *   TEST_DATABASE_URL=postgres://newstrader:newstrader@localhost:5433/newstrader \
 *     pnpm vitest run packages/db/src/trading
 *
 * Isolation: the suite creates and migrates its OWN database
 * (<dbname>_trading) and never touches the shared TEST_DATABASE_URL database
 * (mandatory — see resolver/resolve-repo.test.ts header for the incident).
 * beforeEach wipes the trading-path tables wholesale; the suite database is
 * exclusive to this file, so full-table deletes are safe and keep the reused
 * suite DB empty.
 *
 * The engine here is a deterministic STUB DecideFn (pure function of its
 * inputs): opens long when confidence clears config.gates.minConfidence,
 * skips otherwise. That is exactly what the replay regression needs — same
 * stub + same stored inputs + same config must reproduce live rows
 * bit-for-bit, and a config change must flip decisions.
 */
import { clientOrderIdFor, decide, newId } from '@newstrader/core';
import type {
  BrokerAdapter,
  BrokerPosition,
  DecideFeatures,
  DecideFn,
  GateResult,
  QuoteSnapshot,
  RulesConfig,
  SignalInput,
} from '@newstrader/core';
import { eq } from 'drizzle-orm';
import { migrate } from 'drizzle-orm/node-postgres/migrator';
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';

import { createDb, type Db } from '../client.js';
import {
  decisions,
  instruments,
  llmSignals,
  newsClusterItems,
  newsClusters,
  newsSources,
  priceBars1d,
  priceBars1m,
  rawNewsItems,
  replayRuns,
  rulesVersions,
  scheduledEvents,
} from '../schema.js';
import { NO_QUOTE_SKIP_REASON, decideSignals, liveDecisionKey } from './decide-repo.js';
import { ensureDefaultRules } from './default-rules.js';
import { compareRuns, createReplayRun, runReplay } from './replay-repo.js';
import { createRulesVersion, getRulesVersion } from './rules-repo.js';
import { buildSignalKey, loadUndecidedSignals, persistSignal } from './signals-repo.js';

const testDatabaseUrl = process.env.TEST_DATABASE_URL;

const MINUTE_MS = 60_000;
const HOUR_MS = 3_600_000;
const DAY_MS = 86_400_000;

/** Fixed clock — 2001 keeps fixtures visually distinct from real data. */
const NOW = new Date('2001-06-01T12:00:00.000Z');
/** Cluster anchor (first_received_at) two hours before decision time. */
const ANCHOR = new Date(NOW.getTime() - 2 * HOUR_MS);

const ENGINE_VERSION = 'test-engine-1';

/** Full RulesConfig fixture — v1 defaults trade nothing, so tests are explicit. */
function testConfig(overrides?: {
  minConfidence?: number;
  staleMoveMaxBps?: number;
  maxConcurrentPositions?: number;
}): RulesConfig {
  return {
    gates: {
      minConfidence: overrides?.minConfidence ?? 0.5,
      rejectAlreadyExpected: true,
      rejectCalendarMatch: false,
      eventTypeWhitelist: ['earnings_beat'],
      staleMoveMaxBps: overrides?.staleMoveMaxBps ?? 300,
      minMedianDollarVolume: 0,
      maxConcurrentPositions: overrides?.maxConcurrentPositions ?? 5,
      allowShorts: false,
    },
    sizing: {
      riskBpsOfEquity: 50,
      atrLookbackDays: 5,
      atrStopMultiple: 2,
      maxPositionNotionalPct: 0.1,
    },
    exits: { defaultTimeStopHorizon: '3d', stopAtrMultiple: 2, takeProfitAtrMultiple: null },
  };
}

/**
 * Deterministic stub engine: pure in (signal, features, quote, config); opens
 * long above the confidence gate, skips below it. Sized values are fixed so
 * numeric-column canonicalization is the only transformation under test.
 * Engine-faithful: like the real decide(), it never sets DecideResult.intent —
 * the driver must mint the decisionKey and build the intent itself.
 */
const stubDecide: DecideFn = (signal, _features, quote, config) => {
  const pass = signal.confidence >= config.gates.minConfidence;
  const gates: GateResult[] = [
    {
      gate: 'min_confidence',
      pass,
      observed: signal.confidence,
      threshold: config.gates.minConfidence,
    },
  ];
  if (!pass) return { action: 'skip', skipReason: 'min_confidence', gates };
  return {
    action: 'open_long',
    gates,
    sizedQty: '10',
    sizedNotional: String(Number(quote.price) * 10),
  };
};

const neverDecide: DecideFn = () => {
  throw new Error('decide() must not be called on the no_quote path');
};

function stubBroker(positions: BrokerPosition[], equityUsd: string): BrokerAdapter {
  return {
    venue: 'sim',
    placeOrder: () => Promise.reject(new Error('the decide driver must never place orders')),
    getPositions: () => Promise.resolve(positions),
    getAccountState: () => Promise.resolve({ cashUsd: equityUsd, equityUsd }),
  };
}

const OTHER_POSITION: BrokerPosition = {
  instrumentId: 'some-other-instrument',
  qty: '5',
  avgEntryPrice: '10',
};

describe.skipIf(!testDatabaseUrl)('trading repos (integration)', () => {
  let db: Db;

  beforeAll(async () => {
    if (testDatabaseUrl === undefined)
      throw new Error('unreachable: suite is skipped without TEST_DATABASE_URL');
    const suiteUrl = await createSuiteDatabase(testDatabaseUrl);
    db = createDb(suiteUrl);
    await migrate(db, { migrationsFolder: new URL('../../migrations', import.meta.url).pathname });
  }, 60_000);

  afterAll(async () => {
    await wipe();
    await db.$client.end();
  });

  beforeEach(async () => {
    await wipe();
  });

  /** FK-safe wholesale wipe — the suite database is exclusive to this file. */
  async function wipe(): Promise<void> {
    await db.delete(decisions);
    await db.delete(replayRuns);
    await db.delete(rulesVersions);
    await db.delete(llmSignals);
    await db.delete(scheduledEvents);
    await db.delete(priceBars1m);
    await db.delete(priceBars1d);
    await db.delete(newsClusterItems);
    await db.delete(rawNewsItems);
    await db.delete(newsClusters);
    await db.delete(instruments);
    await db.delete(newsSources);
  }

  // ------------------------------------------------------------- seed helpers --

  async function seedInstrument(symbol: string, assetClass: 'us_equity' | 'crypto' = 'us_equity') {
    const id = newId();
    await db.insert(instruments).values({ id, symbol, assetClass, name: `${symbol} Test Co` });
    return id;
  }

  async function seedCluster(input?: { itemCount?: number; distinctSourceCount?: number }) {
    const id = newId();
    await db.insert(newsClusters).values({
      id,
      canonicalHeadline: `headline ${id}`,
      normalizedHeadline: `headline ${id}`,
      firstItemId: newId(),
      firstSourceId: newId(),
      firstReceivedAt: ANCHOR,
      itemCount: input?.itemCount ?? 1,
      distinctSourceCount: input?.distinctSourceCount ?? 1,
      lastItemAt: ANCHOR,
    });
    return id;
  }

  async function seedClusterItems(clusterId: string, receivedAts: Date[]): Promise<void> {
    const sourceId = newId();
    await db
      .insert(newsSources)
      .values({ id: sourceId, sourceKey: `trading_test_${sourceId}`, kind: 'rss', name: 'test' });
    for (const receivedAt of receivedAts) {
      const itemId = newId();
      await db.insert(rawNewsItems).values({
        id: itemId,
        sourceId,
        externalId: itemId,
        headline: 'echo',
        payloadRef: `test/${itemId}.json`,
        contentHash: itemId,
        receivedAt,
      });
      await db.insert(newsClusterItems).values({
        clusterId,
        itemId,
        similarity: 1,
        lagFromFirstMs: Math.max(0, receivedAt.getTime() - ANCHOR.getTime()),
      });
    }
  }

  async function seedMinuteBar(instrumentId: string, ts: Date, close: string): Promise<void> {
    await db.insert(priceBars1m).values({
      instrumentId,
      ts,
      open: close,
      high: close,
      low: close,
      close,
      volume: '1',
      source: 'test',
    });
  }

  /** 21 identical-range daily bars ending yesterday: TR = 2 every day → ATR = 2. */
  async function seedDailyBars(instrumentId: string): Promise<void> {
    for (let i = 1; i <= 21; i++) {
      await db.insert(priceBars1d).values({
        instrumentId,
        ts: new Date(NOW.getTime() - i * DAY_MS),
        open: '100',
        high: '101',
        low: '99',
        close: '100',
        volume: '1000',
        source: 'test',
      });
    }
  }

  async function seedSignal(input: {
    clusterId: string;
    instrumentId: string;
    confidence?: number;
    analyzedAt?: Date;
    promptVersion?: string;
  }): Promise<string> {
    const { id } = await persistSignal(db, {
      clusterId: input.clusterId,
      scope: 'company',
      instrumentId: input.instrumentId,
      eventType: 'earnings_beat',
      direction: 'bullish',
      expectedMoveBps: 150,
      horizon: '1d',
      alreadyExpected: false,
      materiality: 0.8,
      confidence: input.confidence ?? 0.7,
      modelId: 'stub-model',
      promptVersion: input.promptVersion ?? 'p1',
      analyzedAt: input.analyzedAt ?? new Date(NOW.getTime() - 90 * MINUTE_MS),
    });
    return id;
  }

  /** Instrument with a settled anchor close (100) and a decision quote (125). */
  async function seedBars(instrumentId: string): Promise<Date> {
    await seedMinuteBar(instrumentId, new Date(ANCHOR.getTime() - 5 * MINUTE_MS), '100');
    const quoteTs = new Date(NOW.getTime() - 10 * MINUTE_MS);
    await seedMinuteBar(instrumentId, quoteTs, '125');
    await seedDailyBars(instrumentId);
    return quoteTs;
  }

  function liveDeps(overrides?: { decide?: DecideFn; killSwitchHalted?: boolean }) {
    return {
      decide: overrides?.decide ?? stubDecide,
      broker: stubBroker([OTHER_POSITION], '100000'),
      killSwitchHalted: overrides?.killSwitchHalted ?? false,
      engineVersion: ENGINE_VERSION,
      now: () => NOW,
    };
  }

  // ---------------------------------------------------------------- signals --

  describe('persistSignal', () => {
    it('inserts once and returns the existing id on redelivery (signal_key)', async () => {
      const instrumentId = await seedInstrument('VNDL');
      const clusterId = await seedCluster();
      const input = {
        clusterId,
        scope: 'company' as const,
        instrumentId,
        eventType: 'earnings_beat',
        direction: 'bullish' as const,
        expectedMoveBps: 150,
        horizon: '1d' as const,
        alreadyExpected: false,
        materiality: 0.8,
        confidence: 0.7,
        modelId: 'stub-model',
        promptVersion: 'p1',
        analyzedAt: NOW,
      };

      const first = await persistSignal(db, input);
      expect(first.inserted).toBe(true);

      const second = await persistSignal(db, input);
      expect(second).toEqual({ id: first.id, inserted: false });

      const rows = await db.select().from(llmSignals);
      expect(rows).toHaveLength(1);
      expect(rows[0]?.signalKey).toBe(`${clusterId}:${instrumentId}:p1:stub-model`);
      expect(buildSignalKey(input)).toBe(rows[0]?.signalKey);

      // A new prompt version is a NEW row, never an update.
      const reprompted = await persistSignal(db, { ...input, promptVersion: 'p2' });
      expect(reprompted.inserted).toBe(true);
      expect(reprompted.id).not.toBe(first.id);
    });
  });

  describe('loadUndecidedSignals', () => {
    it('returns company signals lacking a LIVE decision under the given rules version, oldest first', async () => {
      const instrumentId = await seedInstrument('VNDL');
      const clusterA = await seedCluster();
      const clusterB = await seedCluster();
      const rulesA = await createRulesVersion(db, { label: 'a', config: testConfig() });
      const rulesB = await createRulesVersion(db, { label: 'b', config: testConfig() });

      const newer = await seedSignal({
        clusterId: clusterB,
        instrumentId,
        analyzedAt: new Date(NOW.getTime() - 1 * MINUTE_MS),
      });
      const older = await seedSignal({
        clusterId: clusterA,
        instrumentId,
        analyzedAt: new Date(NOW.getTime() - 30 * MINUTE_MS),
      });
      // Sector-scope signals never enter the decide queue.
      await persistSignal(db, {
        clusterId: clusterA,
        scope: 'sector',
        sectorCode: 'imports',
        eventType: 'sector_news',
        direction: 'bearish',
        expectedMoveBps: -50,
        horizon: '3d',
        alreadyExpected: false,
        materiality: 0.4,
        confidence: 0.6,
        modelId: 'stub-model',
        promptVersion: 'p1',
        analyzedAt: NOW,
      });

      const loaded = await loadUndecidedSignals(db, { rulesVersionId: rulesA.id, batch: 10 });
      expect(loaded.map((signal) => signal.id)).toEqual([older, newer]);
      expect(loaded[0]).toMatchObject({
        instrumentId,
        assetClass: 'us_equity',
        anchorTs: ANCHOR,
        clusterItemCount: 1,
        clusterDistinctSourceCount: 1,
      });

      // Decide `older` under rules A (live) — it leaves A's queue, stays in B's.
      await db.insert(decisions).values({
        id: newId(),
        decisionKey: liveDecisionKey(older, rulesA.id),
        signalId: older,
        instrumentId,
        rulesVersionId: rulesA.id,
        decidedAt: NOW,
        action: 'skip',
        gates: [],
      });
      const afterDecision = await loadUndecidedSignals(db, {
        rulesVersionId: rulesA.id,
        batch: 10,
      });
      expect(afterDecision.map((signal) => signal.id)).toEqual([newer]);
      const forRulesB = await loadUndecidedSignals(db, { rulesVersionId: rulesB.id, batch: 10 });
      expect(forRulesB.map((signal) => signal.id)).toEqual([older, newer]);
      // batch caps the pass.
      expect(await loadUndecidedSignals(db, { rulesVersionId: rulesB.id, batch: 1 })).toHaveLength(
        1,
      );
    });
  });

  // ------------------------------------------------------------------ rules --

  describe('createRulesVersion', () => {
    it('is idempotent for the same label+config and THROWS on a drifted config (immutability)', async () => {
      const created = await createRulesVersion(db, { label: 'v1', config: testConfig() });
      expect(created.created).toBe(true);

      // Same canonical config, different key order → same hash, same row.
      const again = await createRulesVersion(db, {
        label: 'v1',
        config: JSON.parse(JSON.stringify(testConfig())) as unknown,
      });
      expect(again).toEqual({ ...created, created: false });

      await expect(
        createRulesVersion(db, { label: 'v1', config: testConfig({ minConfidence: 0.9 }) }),
      ).rejects.toThrow(/immutable/);

      const loaded = await getRulesVersion(db, 'v1');
      expect(loaded).toEqual({ id: created.id, label: 'v1', config: testConfig() });
      await expect(getRulesVersion(db, 'missing')).rejects.toThrow(/no rules version/);
    });

    it('ensureDefaultRules seeds the shipped default once — and it trades NOTHING', async () => {
      const seeded = await ensureDefaultRules(db);
      expect(seeded.created).toBe(true);
      // The v1 default is deliberately inert: empty whitelist, long-only.
      expect(seeded.config.gates.eventTypeWhitelist).toEqual([]);
      expect(seeded.config.gates.allowShorts).toBe(false);

      const again = await ensureDefaultRules(db);
      expect(again).toEqual({ ...seeded, created: false });
      const loaded = await getRulesVersion(db, seeded.label);
      expect(loaded.config).toEqual(seeded.config);
    });

    it('rejects a config that fails RulesConfig validation', async () => {
      const broken = { ...testConfig(), gates: { ...testConfig().gates, minConfidence: 2 } };
      await expect(createRulesVersion(db, { label: 'bad', config: broken })).rejects.toThrow();
      expect(await db.select().from(rulesVersions)).toHaveLength(0);
    });
  });

  // ----------------------------------------------------------------- decide --

  describe('decideSignals', () => {
    it('assembles the EXACT features/quote snapshot, persists the decision, and returns the intent', async () => {
      const instrumentId = await seedInstrument('VNDL');
      const clusterId = await seedCluster({ itemCount: 3, distinctSourceCount: 2 });
      // Trailing-hour velocity: two items inside the hour, one before it.
      await seedClusterItems(clusterId, [
        new Date(NOW.getTime() - 30 * MINUTE_MS),
        new Date(NOW.getTime() - 59 * MINUTE_MS),
        new Date(NOW.getTime() - 2 * HOUR_MS),
      ]);
      // Earnings scheduled 30 min after the ANCHOR → calendar_match true.
      await db.insert(scheduledEvents).values({
        id: newId(),
        eventKey: `earnings:VNDL:${new Date(ANCHOR.getTime() + 30 * MINUTE_MS).toISOString()}`,
        kind: 'earnings',
        instrumentId,
        scheduledAt: new Date(ANCHOR.getTime() + 30 * MINUTE_MS),
        source: 'test',
      });
      const quoteTs = await seedBars(instrumentId);
      const signalId = await seedSignal({ clusterId, instrumentId });
      const rules = await createRulesVersion(db, { label: 'live-v1', config: testConfig() });

      const seen: {
        signal?: SignalInput;
        features?: DecideFeatures;
        quote?: QuoteSnapshot;
        config?: RulesConfig;
      } = {};
      const recordingDecide: DecideFn = (signal, features, quote, config) => {
        Object.assign(seen, { signal, features, quote, config });
        return stubDecide(signal, features, quote, config);
      };

      const totals = await decideSignals(db, liveDeps({ decide: recordingDecide }), {
        rulesLabel: 'live-v1',
        batch: 10,
      });

      const expectedFeatures = {
        clusterItemCount: 3,
        distinctSourceCount: 2,
        itemsPerHour: 2,
        calendarMatch: true,
        // anchor close 100.000000 → quote 125.000000
        priceMoveSinceAnchorBps: ((125 - 100) / 100) * 10_000,
        // 20 days × (close 100 × volume 1000)
        medianDollarVolume: 100_000,
        // identical-range days: TR = 2 always → Wilder ATR = 2
        atr: '2',
        openPositionsCount: 1,
        hasOpenPositionForInstrument: false,
        paperEquityUsd: '100000',
        engineVersion: ENGINE_VERSION,
      };
      const expectedQuote = {
        price: '125.000000',
        ts: quoteTs.toISOString(),
        source: 'test',
        spreadBps: null,
      };
      // The driver mints the decisionKey and builds the intent via
      // core/decide/intent.ts — same key ⇒ same clientOrderId, always.
      const expectedIntent = {
        clientOrderId: clientOrderIdFor(liveDecisionKey(signalId, rules.id)),
        decisionKey: liveDecisionKey(signalId, rules.id),
        instrumentId,
        assetClass: 'us_equity',
        side: 'buy',
        qty: '10',
        orderType: 'market',
        tif: 'day',
      };
      expect(totals).toEqual({
        examined: 1,
        decided: 1,
        opens: 1,
        skips: 0,
        suppressed: 0,
        intents: [expectedIntent],
      });

      // The engine saw exactly what got persisted.
      expect(seen.features).toEqual(expectedFeatures);
      expect(seen.quote).toEqual(expectedQuote);
      expect(seen.config).toEqual(testConfig());
      expect(seen.signal).toEqual({
        id: signalId,
        clusterId,
        instrumentId,
        assetClass: 'us_equity',
        eventType: 'earnings_beat',
        direction: 'bullish',
        expectedMoveBps: 150,
        horizon: '1d',
        alreadyExpected: false,
        materiality: 0.8,
        confidence: 0.7,
        anchorTs: ANCHOR.toISOString(),
      });

      const rows = await db.select().from(decisions);
      expect(rows).toHaveLength(1);
      const row = rows[0];
      expect(row).toMatchObject({
        decisionKey: liveDecisionKey(signalId, rules.id),
        signalId,
        instrumentId,
        rulesVersionId: rules.id,
        replayRunId: null,
        decidedAt: NOW,
        action: 'open_long',
        skipReason: null,
        suppressed: false,
        // numeric-column canonicalization pads to the column scale
        sizedQty: '10.00000000',
        sizedNotional: '1250.00',
      });
      expect(row?.features).toEqual(expectedFeatures);
      expect(row?.quoteSnapshot).toEqual(expectedQuote);
      expect(row?.gates).toEqual([
        { gate: 'min_confidence', pass: true, observed: 0.7, threshold: 0.5 },
      ]);

      // Decided signals leave the queue: the next pass is a no-op.
      const secondPass = await decideSignals(db, liveDeps(), { rulesLabel: 'live-v1', batch: 10 });
      expect(secondPass).toEqual({
        examined: 0,
        decided: 0,
        opens: 0,
        skips: 0,
        suppressed: 0,
        intents: [],
      });
    });

    it('records a SKIPPED decision (skip_reason no_quote) when no quote bar exists — decide() never runs', async () => {
      const instrumentId = await seedInstrument('KRMR');
      const clusterId = await seedCluster();
      const signalId = await seedSignal({ clusterId, instrumentId });
      const rules = await createRulesVersion(db, { label: 'live-v1', config: testConfig() });

      const totals = await decideSignals(db, liveDeps({ decide: neverDecide }), {
        rulesLabel: 'live-v1',
        batch: 10,
      });
      expect(totals).toEqual({
        examined: 1,
        decided: 1,
        opens: 0,
        skips: 1,
        suppressed: 0,
        intents: [],
      });

      const rows = await db.select().from(decisions);
      expect(rows).toHaveLength(1);
      expect(rows[0]).toMatchObject({
        decisionKey: liveDecisionKey(signalId, rules.id),
        action: 'skip',
        skipReason: NO_QUOTE_SKIP_REASON,
        suppressed: false,
        sizedQty: null,
        sizedNotional: null,
      });
      expect(rows[0]?.gates).toEqual([
        { gate: 'quote_available', pass: false, observed: null, threshold: null },
      ]);
      expect(rows[0]?.quoteSnapshot).toEqual({});
      // Features are still assembled and snapshotted — price features null.
      expect(rows[0]?.features).toMatchObject({
        priceMoveSinceAnchorBps: null,
        medianDollarVolume: null,
        atr: null,
        engineVersion: ENGINE_VERSION,
      });
    });

    it('kill switch: decision recorded with suppressed=true and NO intent emitted', async () => {
      const instrumentId = await seedInstrument('VNDL');
      const clusterId = await seedCluster();
      await seedBars(instrumentId);
      await seedSignal({ clusterId, instrumentId });
      await createRulesVersion(db, { label: 'live-v1', config: testConfig() });

      const totals = await decideSignals(db, liveDeps({ killSwitchHalted: true }), {
        rulesLabel: 'live-v1',
        batch: 10,
      });
      expect(totals).toEqual({
        examined: 1,
        decided: 1,
        opens: 1,
        skips: 0,
        suppressed: 1,
        intents: [],
      });

      const rows = await db.select().from(decisions);
      expect(rows[0]).toMatchObject({ action: 'open_long', suppressed: true });
    });

    // ---------------------------------------------------- intra-batch state --
    // These use the REAL engine (not stubDecide): the bug is about which
    // FEATURES the driver computes, and only the real gates (no_existing_
    // position / max_concurrent_positions) prove the features were wired up
    // correctly for a signal decided later in the SAME pass.

    /** Generous config: only the gate under test can fail. */
    function realEngineConfig(maxConcurrentPositions: number): RulesConfig {
      return testConfig({ staleMoveMaxBps: 3000, maxConcurrentPositions });
    }

    function realEngineDeps(equityUsd = '1000000') {
      return {
        decide,
        broker: stubBroker([], equityUsd),
        killSwitchHalted: false,
        engineVersion: ENGINE_VERSION,
        now: () => NOW,
      };
    }

    it('intra-batch portfolio state: two same-instrument opens in one batch — the second is gated by no_existing_position', async () => {
      const instrumentId = await seedInstrument('VNDL');
      await seedBars(instrumentId);
      const signalA = await seedSignal({
        clusterId: await seedCluster(),
        instrumentId,
        confidence: 0.9,
        analyzedAt: new Date(NOW.getTime() - 3 * MINUTE_MS),
      });
      const signalB = await seedSignal({
        clusterId: await seedCluster(),
        instrumentId,
        confidence: 0.9,
        analyzedAt: new Date(NOW.getTime() - 2 * MINUTE_MS),
      });
      await createRulesVersion(db, { label: 'intra-batch-v1', config: realEngineConfig(5) });

      const totals = await decideSignals(db, realEngineDeps(), {
        rulesLabel: 'intra-batch-v1',
        batch: 10,
      });
      expect(totals).toMatchObject({ examined: 2, decided: 2, opens: 1, skips: 1 });
      expect(totals.intents).toHaveLength(1);

      const rows = await db.select().from(decisions);
      const bySignal = new Map(rows.map((row) => [row.signalId, row]));
      expect(bySignal.get(signalA)).toMatchObject({ action: 'open_long' });
      expect(bySignal.get(signalB)).toMatchObject({
        action: 'skip',
        skipReason: 'no_existing_position',
      });
    });

    it('intra-batch portfolio state: opens across a batch cannot jointly exceed maxConcurrentPositions', async () => {
      const instrumentA = await seedInstrument('AAAA');
      const instrumentB = await seedInstrument('BBBB');
      const instrumentC = await seedInstrument('CCCC');
      await seedBars(instrumentA);
      await seedBars(instrumentB);
      await seedBars(instrumentC);
      const signalA = await seedSignal({
        clusterId: await seedCluster(),
        instrumentId: instrumentA,
        confidence: 0.9,
        analyzedAt: new Date(NOW.getTime() - 3 * MINUTE_MS),
      });
      const signalB = await seedSignal({
        clusterId: await seedCluster(),
        instrumentId: instrumentB,
        confidence: 0.9,
        analyzedAt: new Date(NOW.getTime() - 2 * MINUTE_MS),
      });
      const signalC = await seedSignal({
        clusterId: await seedCluster(),
        instrumentId: instrumentC,
        confidence: 0.9,
        analyzedAt: new Date(NOW.getTime() - 1 * MINUTE_MS),
      });
      // Cap of 2: A and B open (0 -> 1 -> 2 slots used), C is jointly gated —
      // the batch-start snapshot alone (0 positions) would never catch this.
      await createRulesVersion(db, { label: 'cap-v1', config: realEngineConfig(2) });

      const totals = await decideSignals(db, realEngineDeps(), { rulesLabel: 'cap-v1', batch: 10 });
      expect(totals).toMatchObject({ examined: 3, decided: 3, opens: 2, skips: 1 });
      expect(totals.intents).toHaveLength(2);

      const rows = await db.select().from(decisions);
      const bySignal = new Map(rows.map((row) => [row.signalId, row]));
      expect(bySignal.get(signalA)).toMatchObject({ action: 'open_long' });
      expect(bySignal.get(signalB)).toMatchObject({ action: 'open_long' });
      expect(bySignal.get(signalC)).toMatchObject({
        action: 'skip',
        skipReason: 'max_concurrent_positions',
      });
    });

    // ------------------------------------------------- sized_notional scale --

    it('pre-rounds sizedNotional to the sized_notional column scale (2dp) before persisting', async () => {
      const instrumentId = await seedInstrument('VNDL');
      const clusterId = await seedCluster();
      await seedBars(instrumentId);
      await seedSignal({ clusterId, instrumentId });
      await createRulesVersion(db, { label: 'live-v1', config: testConfig() });

      // A stub engine whose sizedNotional carries MORE precision than the
      // column scale — the driver must round it the SAME way before insert,
      // not rely on Postgres to round it implicitly.
      const preciseDecide: DecideFn = () => ({
        action: 'open_long',
        gates: [],
        sizedQty: '10',
        sizedNotional: '1250.005', // half-away-from-zero at 2dp -> 1250.01
      });

      await decideSignals(db, liveDeps({ decide: preciseDecide }), {
        rulesLabel: 'live-v1',
        batch: 10,
      });

      const rows = await db.select().from(decisions);
      expect(rows[0]?.sizedNotional).toBe('1250.01');
    });
  });

  // ----------------------------------------------------------------- replay --

  /**
   * Live history fixture: signal A opens (confidence 0.7), B skips on the
   * confidence gate (0.3), C records a no_quote skip (bar-less instrument).
   */
  async function seedLiveHistory() {
    const inst1 = await seedInstrument('VNDL');
    const inst2 = await seedInstrument('KRMR');
    await seedBars(inst1);
    const signalA = await seedSignal({
      clusterId: await seedCluster(),
      instrumentId: inst1,
      confidence: 0.7,
      analyzedAt: new Date(NOW.getTime() - 90 * MINUTE_MS),
    });
    const signalB = await seedSignal({
      clusterId: await seedCluster(),
      instrumentId: inst1,
      confidence: 0.3,
      analyzedAt: new Date(NOW.getTime() - 80 * MINUTE_MS),
    });
    const signalC = await seedSignal({
      clusterId: await seedCluster(),
      instrumentId: inst2,
      confidence: 0.7,
      analyzedAt: new Date(NOW.getTime() - 70 * MINUTE_MS),
    });
    await createRulesVersion(db, { label: 'live-v1', config: testConfig() });
    const liveTotals = await decideSignals(db, liveDeps(), { rulesLabel: 'live-v1', batch: 10 });
    expect(liveTotals).toMatchObject({ examined: 3, decided: 3, opens: 1, skips: 2 });
    return { inst1, inst2, signalA, signalB, signalC };
  }

  const REPLAY_WINDOW = {
    from: new Date(NOW.getTime() - 3 * HOUR_MS),
    to: NOW,
  };

  describe('runReplay', () => {
    it('REGRESSION: same rules over live history reproduces every live decision bit-for-bit', async () => {
      const { signalA } = await seedLiveHistory();
      // A signal in the window that was never decided live: no snapshot →
      // counted, never fabricated.
      const undecided = await seedSignal({
        clusterId: await seedCluster(),
        instrumentId: await seedInstrument('QBTC', 'crypto'),
        analyzedAt: new Date(NOW.getTime() - 60 * MINUTE_MS),
      });

      const run = await createReplayRun(db, {
        rulesLabel: 'live-v1',
        ...REPLAY_WINDOW,
        notes: 'regression',
      });
      const totals = await runReplay(db, { decide: stubDecide }, { replayRunId: run.id });
      expect(totals).toEqual({
        examined: 4,
        decided: 3,
        opens: 1,
        skips: 2,
        skippedNoSnapshot: 1,
        modeBUnsoundPortfolioFeatures: false, // Mode A: same label the live decisions were produced under
      });

      const liveRows = await db
        .select()
        .from(decisions)
        .where(eq(decisions.rulesVersionId, run.rulesVersionId));
      const live = liveRows.filter((row) => row.replayRunId === null);
      const replayed = liveRows.filter((row) => row.replayRunId === run.id);
      expect(live).toHaveLength(3);
      expect(replayed).toHaveLength(3);
      for (const liveRow of live) {
        const replayRow = replayed.find((row) => row.signalId === liveRow.signalId);
        expect(replayRow).toBeDefined();
        if (replayRow === undefined) continue;
        // Bit-for-bit: action, reason, gates, snapshots, sizes, instant.
        expect({ ...replayRow }).toEqual({
          ...liveRow,
          id: replayRow.id,
          decisionKey: `${liveRow.signalId}:${run.rulesVersionId}:${run.id}`,
          replayRunId: run.id,
        });
      }
      expect(replayed.some((row) => row.signalId === undecided)).toBe(false);
      expect(replayed.some((row) => row.signalId === signalA && row.action === 'open_long')).toBe(
        true,
      );

      // Re-running the same replay run is idempotent (decision_key conflict).
      const rerun = await runReplay(db, { decide: stubDecide }, { replayRunId: run.id });
      expect(rerun).toEqual({
        examined: 4,
        decided: 0,
        opens: 0,
        skips: 0,
        skippedNoSnapshot: 1,
        modeBUnsoundPortfolioFeatures: false,
      });
    });

    it('a changed config diverges from live and compareRuns reports it; same config matches', async () => {
      const { signalA } = await seedLiveHistory();
      const liveRules = await getRulesVersion(db, 'live-v1');

      // Control: replaying the SAME rules matches live everywhere.
      const sameRun = await createReplayRun(db, { rulesLabel: 'live-v1', ...REPLAY_WINDOW });
      await runReplay(db, { decide: stubDecide }, { replayRunId: sameRun.id });
      const control = await compareRuns(db, {
        runA: 'live',
        runB: sameRun.id,
        liveRulesVersionId: liveRules.id,
      });
      expect(control.summary).toEqual({
        total: 3,
        matched: 3,
        actionChanged: 0,
        sizeChanged: 0,
        skipReasonChanged: 0,
        onlyInA: 0,
        onlyInB: 0,
      });
      expect(control.divergences).toEqual([]);

      // Counterfactual: a tighter confidence gate flips A from open to skip.
      await createRulesVersion(db, {
        label: 'strict-v2',
        config: testConfig({ minConfidence: 0.9 }),
      });
      const strictRun = await createReplayRun(db, { rulesLabel: 'strict-v2', ...REPLAY_WINDOW });
      const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {});
      const totals = await runReplay(db, { decide: stubDecide }, { replayRunId: strictRun.id });
      expect(totals).toEqual({
        examined: 3,
        decided: 3,
        opens: 0,
        skips: 3,
        skippedNoSnapshot: 0,
        // Mode B: strict-v2 differs from live-v1 (the label the reused live
        // decisions were produced under) — the portfolio features runReplay
        // reused (openPositionsCount/equity) are NOT what strict-v2's own
        // trajectory would have produced.
        modeBUnsoundPortfolioFeatures: true,
      });
      expect(warnSpy).toHaveBeenCalledWith(
        expect.stringContaining('mode_b_unsound_portfolio_features'),
      );
      warnSpy.mockRestore();

      const diff = await compareRuns(db, {
        runA: 'live',
        runB: strictRun.id,
        liveRulesVersionId: liveRules.id,
      });
      expect(diff.summary).toEqual({
        total: 3,
        matched: 2, // B (still skipped on confidence) and C (no_quote, copied verbatim)
        actionChanged: 1,
        sizeChanged: 1,
        skipReasonChanged: 1,
        onlyInA: 0,
        onlyInB: 0,
      });
      expect(diff.divergences).toHaveLength(1);
      expect(diff.divergences[0]).toMatchObject({
        signalId: signalA,
        reasons: ['action_changed', 'size_changed', 'skip_reason_changed'],
        a: { action: 'open_long', skipReason: null },
        b: { action: 'skip', skipReason: 'min_confidence', sizedQty: null, sizedNotional: null },
      });
    });

    it('compareRuns requires liveRulesVersionId whenever a side is "live"', async () => {
      await seedLiveHistory();
      const sameRun = await createReplayRun(db, { rulesLabel: 'live-v1', ...REPLAY_WINDOW });
      await runReplay(db, { decide: stubDecide }, { replayRunId: sameRun.id });

      await expect(compareRuns(db, { runA: 'live', runB: sameRun.id })).rejects.toThrow(
        /liveRulesVersionId is required/,
      );
      await expect(compareRuns(db, { runA: sameRun.id, runB: 'live' })).rejects.toThrow(
        /liveRulesVersionId is required/,
      );
      // Neither side 'live': no rules version needed at all.
      const otherRun = await createReplayRun(db, { rulesLabel: 'live-v1', ...REPLAY_WINDOW });
      await runReplay(db, { decide: stubDecide }, { replayRunId: otherRun.id });
      await expect(compareRuns(db, { runA: sameRun.id, runB: otherRun.id })).resolves.toBeDefined();
    });
  });
});

// ------------------------------------------------------------------ helpers --

/**
 * Create (if missing) the suite's dedicated database next to the shared
 * TEST_DATABASE_URL one and return its URL. Idempotent across runs; mirrors
 * resolver/resolve-repo.test.ts / clustering-repo.test.ts.
 */
async function createSuiteDatabase(adminUrl: string): Promise<string> {
  const parsed = new URL(adminUrl);
  const baseName = parsed.pathname.replace(/^\//, '') || 'postgres';
  const suiteName = `${baseName}_trading`.replace(/[^a-zA-Z0-9_]/g, '_');

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
