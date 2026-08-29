import { execFileSync } from 'node:child_process';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import type {
  FetchedItem,
  FetchResult,
  RawItemV1,
  RawStore,
  RulesConfig,
  SourceAdapter,
} from '@newstrader/core';
import { DEFAULT_RULES_LABEL, decide, newId } from '@newstrader/core';
import {
  CONFIDENCE,
  compareRuns,
  createDb,
  createReplayRun,
  createRulesVersion,
  decideSignals,
  decisions,
  derivePortfolio,
  ensureDefaultRules,
  evaluateOpenPositions,
  fills,
  indexMembership,
  ingestWatermarks,
  instrumentAliases,
  instruments,
  itemInstrumentLinks,
  llmSignals,
  loadResolverDictionary,
  MEASURER_VERSION,
  measureReactions,
  newsClusterItems,
  newsClusters,
  newsSources,
  orderEvents,
  orders,
  persistSignal,
  priceBars1d,
  priceBars1m,
  rawNewsItems,
  reactionMeasurements,
  reactionSummary,
  recoveryMeasurements,
  replayRuns,
  RESOLVER_VERSION,
  rulesVersions,
  runReplay,
  scheduledEvents,
  SimBrokerAdapter,
  upsertBars1m,
} from '@newstrader/db';
import type { BarUpsertRow, Db } from '@newstrader/db';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import {
  loadItemsByIds,
  loadUnclusteredItems,
  runPoll,
  runProcess,
} from '../../handlers/src/lib/ingest.js';
import {
  engineExitEvaluator,
  loadPendingOpenIntents,
  loadSimPortfolioFills,
} from '../../handlers/src/lib/trading.js';

/**
 * End-to-end fixture test of the shared ingest core: fake in-memory adapters +
 * in-memory RawStore + REAL Postgres (clustering needs pg_trgm and the
 * advisory-locked attach). Skipped without TEST_DATABASE_URL.
 *
 * Isolation: this file creates and migrates its OWN database
 * (<dbname>_cli_e2e, via `pnpm --filter @newstrader/db migrate`) because DB
 * suites reset whole tables between tests and vitest runs files in parallel —
 * packages/db/src/clustering-repo.test.ts isolates the same way. The shared
 * TEST_DATABASE_URL database holds real dev data; the only writes this suite
 * ever performs there are the scoped deletes in scrubFixtureSourceLeftovers,
 * which remove fixture rows leaked by prior test revisions. afterAll re-empties
 * the e2e tables so nothing persists between runs. Requires CREATEDB rights
 * (the docker-compose superuser has them).
 */

const testDatabaseUrl = process.env.TEST_DATABASE_URL;

/** Fixed base clock — received_at values are injected, never wall-clock. */
const T0 = new Date('2026-07-06T12:00:00.000Z');

const STORY_A_WIRE: FetchedItem = {
  externalId: 'wire-001',
  url: 'https://wire.example/acme-earnings',
  headline: 'Acme Corp announces record quarterly earnings beating analyst expectations',
  body: 'Acme Corp today reported record quarterly earnings, far ahead of consensus.',
  // published_at is the source's CLAIM — deliberately different from the
  // injected clock so the test catches any code path confusing the two.
  publishedAt: '2026-07-06T11:00:00.000Z',
  symbolsHint: ['ACME'],
  meta: { fixture: true },
  raw: { fixture: 'wire-001', payload: 'verbatim' },
};

/** Same story, lightly re-edited by another outlet: near-dup, different content hash. */
const STORY_A_ECHO: FetchedItem = {
  externalId: 'echo-001',
  headline: 'Acme Corp announces record quarterly earnings, beating analyst expectations for Q2',
  raw: { fixture: 'echo-001' },
};

const STORY_B: FetchedItem = {
  externalId: 'wire-002',
  headline: 'Globex Industries recalls smart thermostats over fire risk',
  raw: { fixture: 'wire-002' },
};

/** Exchange-prefix form in the headline — the ticker_exact resolution channel. */
const STORY_D: FetchedItem = {
  externalId: 'wire-004',
  headline: 'Globex Industries (NYSE: GLBX) expands smart thermostat recall to Europe',
  raw: { fixture: 'wire-004' },
};

class FakeAdapter implements SourceAdapter {
  readonly kind = 'rss' as const;
  fetchCount = 0;
  lastCursor: string | null = null;
  constructor(
    readonly sourceKey: string,
    private readonly items: FetchedItem[],
  ) {}
  async fetchSince(cursor: string | null): Promise<FetchResult> {
    this.fetchCount += 1;
    this.lastCursor = cursor;
    return { items: this.items, nextCursor: `cursor-${this.fetchCount}` };
  }
}

class MemoryRawStore implements RawStore {
  readonly objects = new Map<string, unknown>();
  async put(key: string, payload: unknown): Promise<string> {
    this.objects.set(key, payload);
    return `mem://${key}`;
  }
  async get(ref: string): Promise<unknown> {
    const key = ref.replace(/^mem:\/\//, '');
    if (!this.objects.has(key)) throw new Error(`no such object: ${ref}`);
    return this.objects.get(key);
  }
}

function makeClock(start: Date, stepMs: number): () => Date {
  let tick = 0;
  return () => new Date(start.getTime() + stepMs * (tick += 1) - stepMs);
}

describe.skipIf(!testDatabaseUrl)('ingest e2e: fixtures → poll → process → clusters', () => {
  let db: Db;

  beforeAll(async () => {
    if (testDatabaseUrl === undefined)
      throw new Error('unreachable: suite is skipped without TEST_DATABASE_URL');
    await scrubFixtureSourceLeftovers(testDatabaseUrl);
    const e2eUrl = await createE2eDatabase(testDatabaseUrl);
    migrateDatabase(e2eUrl);
    db = createDb(e2eUrl);
  }, 120_000);

  afterAll(async () => {
    // Self-cleaning: the e2e database is reused across runs — leave it empty.
    try {
      await wipeIngestTables(db);
    } finally {
      await db.$client.end();
    }
  });

  beforeEach(async () => {
    await wipeIngestTables(db);
  });

  function fixtureWorld() {
    const wire = new FakeAdapter('fake_wire', [STORY_A_WIRE, STORY_B]);
    const echo = new FakeAdapter('fake_echo', [STORY_A_ECHO]);
    const rawStore = new MemoryRawStore();
    const queue: RawItemV1[] = [];
    const deps = {
      db,
      rawStore,
      enqueue: async (messages: RawItemV1[]) => {
        queue.push(...messages);
      },
      now: makeClock(T0, 60_000),
    };
    return { wire, echo, rawStore, queue, deps };
  }

  it('ingests 3 fixture items into 3 raw rows and 2 clusters with correct counters', async () => {
    const { wire, echo, rawStore, queue, deps } = fixtureWorld();

    // --- poll ---------------------------------------------------------------
    const wireCounts = await runPoll(deps, wire);
    expect(wireCounts).toMatchObject({
      sourceKey: 'fake_wire',
      fetched: 2,
      inserted: 2,
      duplicates: 0,
    });
    const echoCounts = await runPoll(deps, echo);
    expect(echoCounts).toMatchObject({
      sourceKey: 'fake_echo',
      fetched: 1,
      inserted: 1,
      duplicates: 0,
    });

    const rawRows = await db.select().from(rawNewsItems);
    expect(rawRows).toHaveLength(3);

    // received_at came from OUR clock (T0, T0+1m for wire; T0+3m for echo —
    // the watermark save consumed T0+2m), never from publishedAt.
    const wireRow = rawRows.find((row) => row.externalId === 'wire-001');
    if (wireRow === undefined) throw new Error('wire-001 row missing');
    expect(wireRow.receivedAt).toEqual(T0);
    expect(wireRow.publishedAt).toEqual(new Date('2026-07-06T11:00:00.000Z'));
    expect(wireRow.symbolsHint).toEqual(['ACME']);

    // The raw payload round-trips verbatim through the store ref.
    expect(await rawStore.get(wireRow.payloadRef)).toEqual(STORY_A_WIRE.raw);

    // One pointer per inserted item reached the queue; cursors were saved.
    expect(queue).toHaveLength(3);
    expect(new Set(queue.map((m) => m.itemId)).size).toBe(3);
    const watermarks = await db.select().from(ingestWatermarks);
    expect(watermarks).toHaveLength(2);
    expect(watermarks.map((w) => w.cursor)).toEqual(['cursor-1', 'cursor-1']);
    expect(wire.lastCursor).toBeNull();

    // --- process ------------------------------------------------------------
    const unclustered = await loadUnclusteredItems(db, 500);
    expect(unclustered.map((item) => item.headline)).toEqual([
      STORY_A_WIRE.headline, // oldest first
      STORY_B.headline,
      STORY_A_ECHO.headline,
    ]);

    // Empty dictionary (no instruments seeded): clustering proceeds, no links.
    const counts = await runProcess(db, unclustered, await loadResolverDictionary(db));
    expect(counts).toEqual({
      processed: 3,
      newClusters: 2,
      attachedExisting: 1,
      itemsLinked: 0,
      linksWritten: 0,
    });

    const clusters = await db.select().from(newsClusters);
    expect(clusters).toHaveLength(2);
    const shared = clusters.find((cluster) => cluster.itemCount === 2);
    if (shared === undefined) throw new Error('shared story cluster missing');
    expect(shared.canonicalHeadline).toBe(STORY_A_WIRE.headline);
    expect(shared.distinctSourceCount).toBe(2);
    expect(shared.firstReceivedAt).toEqual(T0);
    const solo = clusters.find((cluster) => cluster.itemCount === 1);
    expect(solo?.canonicalHeadline).toBe(STORY_B.headline);

    expect(await loadUnclusteredItems(db, 500)).toHaveLength(0);
  });

  it('redelivered poll and process batches change nothing', async () => {
    const { wire, echo, queue, deps } = fixtureWorld();

    // First full pass.
    await runPoll(deps, wire);
    await runPoll(deps, echo);
    const dictionary = await loadResolverDictionary(db);
    await runProcess(db, await loadUnclusteredItems(db, 500), dictionary);

    // --- redelivered poll (same items fetched again) --------------------------
    const wireAgain = await runPoll(deps, wire);
    expect(wireAgain).toMatchObject({ fetched: 2, inserted: 0, duplicates: 2 });
    const echoAgain = await runPoll(deps, echo);
    expect(echoAgain).toMatchObject({ fetched: 1, inserted: 0, duplicates: 1 });

    // The saved cursor was handed back to the adapter on the second cycle.
    expect(wire.lastCursor).toBe('cursor-1');

    // Duplicates re-emit the EXISTING rows' pointers (crash-safety for a cycle
    // that dies between enqueue and cursor save) — same 3 itemIds, no new rows.
    expect(queue).toHaveLength(6);
    expect(new Set(queue.map((m) => m.itemId)).size).toBe(3);
    expect(await db.select().from(rawNewsItems)).toHaveLength(3);

    // --- redelivered process batch (Lambda at-least-once semantics) ----------
    const redelivered = await loadItemsByIds(
      db,
      queue.map((m) => m.itemId),
    );
    expect(redelivered).toHaveLength(3);
    const counts = await runProcess(db, redelivered, dictionary);
    expect(counts).toEqual({
      processed: 3,
      newClusters: 0,
      attachedExisting: 3,
      itemsLinked: 0,
      linksWritten: 0,
    });

    // DB state is bit-for-bit the same story: 2 clusters, 3 memberships,
    // counters untouched.
    const clusters = await db.select().from(newsClusters);
    expect(clusters).toHaveLength(2);
    expect(await db.select().from(newsClusterItems)).toHaveLength(3);
    const shared = clusters.find((cluster) => cluster.itemCount === 2);
    if (shared === undefined) throw new Error('shared story cluster missing');
    expect(shared.distinctSourceCount).toBe(2);
    expect(shared.firstReceivedAt).toEqual(T0);
  });

  it('resolves items to seeded instruments during process (source_hint + ticker_exact)', async () => {
    // Seed a 2-instrument universe: ACME resolves STORY_A_WIRE via its
    // symbolsHint (['ACME']); GLBX resolves STORY_D via the "(NYSE: GLBX)"
    // exchange-prefix in the headline. The GLBX name alias also hits STORY_D's
    // headline (alias_dict 0.7) — the resolver must keep only the
    // higher-confidence ticker_exact link per instrument.
    const acmeId = newId();
    const glbxId = newId();
    await db.insert(instruments).values([
      { id: acmeId, symbol: 'ACME', assetClass: 'us_equity', name: 'Acme Corp' },
      { id: glbxId, symbol: 'GLBX', assetClass: 'us_equity', name: 'Globex Industries' },
    ]);
    await db.insert(instrumentAliases).values([
      {
        instrumentId: glbxId,
        alias: 'Globex Industries',
        aliasKind: 'name',
        validFrom: new Date('2020-01-01T00:00:00.000Z'),
      },
    ]);

    const wire = new FakeAdapter('fake_wire', [STORY_A_WIRE, STORY_D]);
    const { deps } = fixtureWorld();
    await runPoll(deps, wire);

    const items = await loadUnclusteredItems(db, 500);
    expect(items).toHaveLength(2);
    const counts = await runProcess(db, items, await loadResolverDictionary(db));
    expect(counts).toMatchObject({ processed: 2, itemsLinked: 2, linksWritten: 2 });

    const links = await db.select().from(itemInstrumentLinks);
    expect(links).toHaveLength(2);

    const byInstrument = new Map(links.map((link) => [link.instrumentId, link]));
    const rawRows = await db.select().from(rawNewsItems);
    const acmeItem = rawRows.find((row) => row.externalId === STORY_A_WIRE.externalId);
    const glbxItem = rawRows.find((row) => row.externalId === STORY_D.externalId);

    expect(byInstrument.get(acmeId)).toMatchObject({
      itemId: acmeItem?.id,
      method: 'source_hint',
      confidence: CONFIDENCE.sourceHint,
      resolverVersion: RESOLVER_VERSION,
    });
    expect(byInstrument.get(glbxId)).toMatchObject({
      itemId: glbxItem?.id,
      method: 'ticker_exact',
      confidence: CONFIDENCE.exchangePrefix,
      resolverVersion: RESOLVER_VERSION,
    });

    // Redelivered process batch: attach and links are both no-ops.
    const again = await runProcess(db, items, await loadResolverDictionary(db));
    expect(again).toMatchObject({ processed: 2, itemsLinked: 2, linksWritten: 0 });
    expect(await db.select().from(itemInstrumentLinks)).toHaveLength(2);
  });

  it('measures reactions end-to-end: poll → process → seeded bars → measure', async () => {
    // M3 flow: the same ingest core produces the cluster + instrument link,
    // then seeded minute bars around the anchor let measureReactions write the
    // ladder + summary. The link must clear MIN_LINK_CONFIDENCE without the
    // r2 triage stage (no LLM in e2e), so the fixture carries in-text ticker
    // evidence — "(NASDAQ: ACME)" → ticker_exact 0.9. A bare vendor tag would
    // park at source_hint 0.65 and the measurer would correctly skip it.
    // The anchor is first_received_at = T0 (OUR clock) — publishedAt (T0 − 1h
    // in the fixture) must play no role, which the assertions pin via anchorTs.
    const acmeId = newId();
    await db
      .insert(instruments)
      .values({ id: acmeId, symbol: 'ACME', assetClass: 'us_equity', name: 'Acme Corp' });

    const prefixedStory: FetchedItem = {
      ...STORY_A_WIRE,
      headline: `${STORY_A_WIRE.headline} (NASDAQ: ACME)`,
    };
    const wire = new FakeAdapter('fake_wire', [prefixedStory]);
    const { deps } = fixtureWorld();
    await runPoll(deps, wire);
    const items = await loadUnclusteredItems(db, 500);
    await runProcess(db, items, await loadResolverDictionary(db));

    const [cluster] = await db.select().from(newsClusters);
    if (cluster === undefined) throw new Error('cluster missing');
    expect(cluster.firstReceivedAt).toEqual(T0);

    // Bars: flat 100.000000 before/at the anchor, 101.000000 from anchor+1m on
    // (a clean +100 bps step), covering anchor−30m … anchor+1d+10m. 3d/5d
    // horizons stay unmeasurable: the last bar is >30m stale at those horizons
    // and no later bar proves the gap was non-trading.
    const bars: BarUpsertRow[] = [];
    for (let minute = -30; minute <= 24 * 60 + 10; minute += 1) {
      const close = minute < 1 ? '100.000000' : '101.000000';
      bars.push({
        instrumentId: acmeId,
        ts: new Date(T0.getTime() + minute * 60_000),
        open: close,
        high: close,
        low: close,
        close,
        volume: null,
        source: 'massive_aggs',
      });
    }
    expect(await upsertBars1m(db, bars)).toBe(bars.length);

    const now = new Date(T0.getTime() + 36 * 3_600_000);
    const totals = await measureReactions(db, { sinceHours: 48, now });
    expect(totals).toEqual({
      clusters: 1,
      pairs: 1,
      measured: 1,
      skippedNoBars: 0,
      horizonsWritten: 6, // 5m 15m 30m 1h 4h 1d; 3d/5d not yet settled
      // The fixture's publishedAt (T0 − 1h) is credible, so the m1-pub view is
      // attempted — but bars only start at T0 − 30m, so no anchor bar exists
      // at the publication clock and the pub ladder is honestly empty.
      pubPairs: 1,
      pubMeasured: 0,
      pubSkippedNoBars: 1,
      pubSkippedNoAnchor: 0,
    });

    const ladder = await db.select().from(reactionMeasurements);
    expect(ladder).toHaveLength(6);
    expect(new Set(ladder.map((row) => row.horizon))).toEqual(
      new Set(['5m', '15m', '30m', '1h', '4h', '1d']),
    );
    for (const row of ladder) {
      expect(row.clusterId).toBe(cluster.id);
      expect(row.instrumentId).toBe(acmeId);
      expect(row.measurerVersion).toBe(MEASURER_VERSION);
      expect(row.anchorTs).toEqual(T0);
      expect(row.rawReturnBps).toBeCloseTo(100, 3);
      // No SPY instrument/bars seeded → abnormal degrades to raw, benchmark null.
      expect(row.abnormalReturnBps).toBe(row.rawReturnBps);
      expect(row.benchmark).toBeNull();
      expect(row.betaUsed).toBeNull();
      expect(row.barsSource).toBe('massive_aggs');
    }

    const summaries = await db.select().from(reactionSummary);
    expect(summaries).toHaveLength(1);
    expect(summaries[0]).toMatchObject({
      clusterId: cluster.id,
      instrumentId: acmeId,
      direction1d: 'up',
    });
    expect(summaries[0]?.peakAbnormalMoveBps).toBeCloseTo(100, 3);
    // The step happens at anchor+1m, so half the 1d move is reached immediately.
    expect(summaries[0]?.timeToHalfOf1dMoveMinutes).toBe(1);

    // +100 bps is not a negative event: no recovery row.
    expect(await db.select().from(recoveryMeasurements)).toHaveLength(0);

    // Idempotency: a re-run measures the same pair but writes nothing new.
    const rerun = await measureReactions(db, { sinceHours: 48, now });
    expect(rerun).toMatchObject({ measured: 1, horizonsWritten: 0 });
    expect(await db.select().from(reactionMeasurements)).toHaveLength(6);
  });
});

describe.skipIf(!testDatabaseUrl)('trading e2e: signal → decide → fill → time-stop close', () => {
  let db: Db;

  /** All trading fixtures anchor here (cluster first_received_at — OUR clock). */
  const ANCHOR = new Date('2026-07-06T12:00:00.000Z');
  const HOUR_MS = 3_600_000;
  const DAY_MS = 86_400_000;
  /** Engine decision time: two hours after the story broke. */
  const DECIDE_NOW = new Date(ANCHOR.getTime() + 2 * HOUR_MS);
  /** Exit pass time: past the signal's 1d horizon from the entry decision. */
  const CLOSE_NOW = new Date(DECIDE_NOW.getTime() + 25 * HOUR_MS);

  const EVENT_TYPE = 'earnings_surprise';
  const ENGINE_VERSION = 'e2e-engine';

  /**
   * Explicit TEST config whose whitelist earns the fixture event type — the
   * shipped default trades NOTHING (empty whitelist) by design, so every test
   * that wants a trade must say so out loud.
   */
  const E2E_RULES: RulesConfig = {
    gates: {
      minConfidence: 0.75,
      rejectAlreadyExpected: true,
      rejectCalendarMatch: true,
      eventTypeWhitelist: [EVENT_TYPE],
      staleMoveMaxBps: 300,
      minMedianDollarVolume: 5_000_000,
      maxConcurrentPositions: 10,
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

  beforeAll(async () => {
    if (testDatabaseUrl === undefined)
      throw new Error('unreachable: suite is skipped without TEST_DATABASE_URL');
    const e2eUrl = await createE2eDatabase(testDatabaseUrl);
    migrateDatabase(e2eUrl);
    db = createDb(e2eUrl);
  }, 120_000);

  afterAll(async () => {
    try {
      await wipeIngestTables(db);
    } finally {
      await db.$client.end();
    }
  });

  beforeEach(async () => {
    await wipeIngestTables(db);
  });

  /**
   * Seed one tradeable world: instrument + cluster + a bullish high-confidence
   * signal, 20 daily bars (constant true range 4 ⇒ ATR exactly 4; $100M/day
   * dollar volume), a settled anchor bar at 100, and a decision-time bar at
   * 101 (+100 bps since anchor — inside the stale-move gate).
   */
  async function seedTradingWorld(): Promise<{ instrumentId: string; signalId: string }> {
    const instrumentId = newId();
    await db
      .insert(instruments)
      .values({ id: instrumentId, symbol: 'ACME', assetClass: 'us_equity', name: 'Acme Corp' });

    const clusterId = newId();
    await db.insert(newsClusters).values({
      id: clusterId,
      canonicalHeadline: 'Acme Corp reports record earnings',
      normalizedHeadline: 'acme corp reports record earnings',
      firstItemId: newId(),
      firstSourceId: newId(),
      firstReceivedAt: ANCHOR,
      itemCount: 1,
      distinctSourceCount: 1,
      lastItemAt: ANCHOR,
    });

    const signal = await persistSignal(db, {
      clusterId,
      scope: 'company',
      instrumentId,
      eventType: EVENT_TYPE,
      direction: 'bullish',
      expectedMoveBps: 150,
      horizon: '1d',
      alreadyExpected: false,
      materiality: 0.8,
      confidence: 0.9,
      modelId: 'e2e-model',
      promptVersion: 'p1',
      analyzedAt: new Date(ANCHOR.getTime() + 5 * 60_000),
    });

    // Daily bars: high 102 / low 98 / close 100 every day ⇒ every true range
    // is exactly 4, so Wilder smoothing lands on ATR = 4 regardless of warmup.
    for (let day = 20; day >= 1; day -= 1) {
      await db.insert(priceBars1d).values({
        instrumentId,
        ts: new Date(ANCHOR.getTime() - day * DAY_MS),
        open: '100',
        high: '102',
        low: '98',
        close: '100',
        volume: '1000000',
        source: 'e2e',
      });
    }

    await db.insert(priceBars1m).values([
      // Settled anchor bar — the stale-move reference price. Its OPEN is one
      // minute BEFORE the anchor so that its close prints exactly at the
      // anchor: a bar opening at the anchor closes 60s after the news and is
      // not a pre-news price (see loadSettledCloseAt).
      {
        instrumentId,
        ts: new Date(ANCHOR.getTime() - 60_000),
        open: '100',
        high: '100',
        low: '100',
        close: '100',
        source: 'e2e',
      },
      // Decision-time quote bar.
      {
        instrumentId,
        ts: new Date(DECIDE_NOW.getTime() - 60_000),
        open: '101',
        high: '101',
        low: '101',
        close: '101',
        source: 'e2e',
      },
    ]);

    return { instrumentId, signalId: signal.id };
  }

  function brokerAt(now: Date): SimBrokerAdapter {
    return new SimBrokerAdapter(db, { now: () => now });
  }

  it('flows a signal end-to-end: decide → intent → fill → position → time-stop close → P&L', async () => {
    const { instrumentId, signalId } = await seedTradingWorld();
    const rules = await createRulesVersion(db, { label: 'e2e-earnings-v1', config: E2E_RULES });

    // --- decide (real engine, real feature assembly) --------------------------
    const broker = brokerAt(DECIDE_NOW);
    const totals = await decideSignals(
      db,
      {
        decide,
        broker,
        killSwitchHalted: false,
        engineVersion: ENGINE_VERSION,
        now: () => DECIDE_NOW,
      },
      { rulesLabel: 'e2e-earnings-v1', batch: 10 },
    );
    expect(totals).toMatchObject({ examined: 1, decided: 1, opens: 1, skips: 0, suppressed: 0 });
    expect(totals.intents).toHaveLength(1);
    const intent = totals.intents[0];
    if (intent === undefined) throw new Error('intent missing');
    // Sizing math: risk = 100000 × 50bps = $500; stop = 2 × ATR(4) = 8;
    // 500 / 8 = 62.5 → floored to whole shares for equities.
    expect(intent).toMatchObject({ side: 'buy', qty: '62', assetClass: 'us_equity' });

    // The durable emit path re-derives the SAME intent from the decisions row.
    const pending = await loadPendingOpenIntents(db, {
      rulesVersionId: rules.id,
      now: DECIDE_NOW,
    });
    expect(pending.map((p) => p.clientOrderId)).toEqual([intent.clientOrderId]);

    // The decision row snapshotted what the engine read (replay contract).
    const [decision] = await db.select().from(decisions);
    expect(decision).toMatchObject({
      signalId,
      action: 'open_long',
      suppressed: false,
      replayRunId: null,
    });
    expect(decision?.features).toMatchObject({ engineVersion: ENGINE_VERSION, atr: '4' });

    // --- execute (SimBroker fill: 5 bps adverse slippage on the 101 quote) ----
    const ack = await broker.placeOrder(intent);
    expect(ack.status).toBe('accepted');
    const positions = await broker.getPositions();
    expect(positions).toEqual([{ instrumentId, qty: '62', avgEntryPrice: '101.0505' }]);
    // Once ordered, the intent is no longer pending (idempotent emit path).
    expect(await loadPendingOpenIntents(db, { rulesVersionId: rules.id, now: DECIDE_NOW })).toEqual(
      [],
    );

    // --- position manager: past the 1d horizon, the time stop closes ----------
    await db.insert(priceBars1m).values({
      instrumentId,
      ts: new Date(CLOSE_NOW.getTime() - 60_000),
      open: '103',
      high: '103',
      low: '103',
      close: '103',
      source: 'e2e',
    });
    const closeBroker = brokerAt(CLOSE_NOW);
    const result = await evaluateOpenPositions(db, {
      broker: closeBroker,
      rules: E2E_RULES,
      rulesVersionId: rules.id,
      now: CLOSE_NOW,
      evaluateExit: engineExitEvaluator,
      checkHalted: async () => false,
    });
    expect(result).toMatchObject({ evaluated: 1, closed: 1, suppressed: 0, skipped: 0 });
    expect(result.details[0]).toMatchObject({ outcome: 'closed', reason: 'time_stop' });

    // --- aftermath: flat, and the P&L is the exact slippage-adjusted number ---
    expect(await closeBroker.getPositions()).toEqual([]);
    const portfolio = derivePortfolio(await loadSimPortfolioFills(db));
    // Buy 62 @ 101×1.0005 = 101.0505 → 6265.131; sell 62 @ 103×0.9995 =
    // 102.9485 → 6382.807; realized = 117.676 (equity fees are 0 in sim).
    expect(portfolio.realizedPnlUsd).toBe('117.676');
    expect(portfolio.feesUsd).toBe('0');
    expect(await db.select().from(orders)).toHaveLength(2);
    expect(await db.select().from(fills)).toHaveLength(2);
    const closeDecisions = await db.select().from(decisions);
    const close = closeDecisions.find((row) => row.action === 'close');
    // REASON-INDEPENDENT key (position-manager.ts) — the reason lives in
    // features.exitReason, not the key.
    expect(close?.decisionKey).toMatch(/^exit:[^:]+$/);
    expect(close?.features).toMatchObject({ exitReason: 'time_stop' });
    expect(close?.suppressed).toBe(false);
  });

  it('Mode A bit-for-bit CI gate: replaying the REAL engine under the SAME rules label reproduces the live decision exactly', async () => {
    // decide-repo.test.ts's own Mode A regression uses a stub engine both
    // sides — this proves the jsonb round-trip of REAL features/gates (this
    // fixture's real decide(), real assembled features, real fill) survives
    // re-execution bit-for-bit, not just a stub's trivial output.
    await seedTradingWorld();
    const rules = await createRulesVersion(db, { label: 'e2e-mode-a-v1', config: E2E_RULES });

    await decideSignals(
      db,
      {
        decide,
        broker: brokerAt(DECIDE_NOW),
        killSwitchHalted: false,
        engineVersion: ENGINE_VERSION,
        now: () => DECIDE_NOW,
      },
      { rulesLabel: 'e2e-mode-a-v1', batch: 10 },
    );

    const run = await createReplayRun(db, {
      rulesLabel: 'e2e-mode-a-v1',
      from: null,
      to: null,
      notes: 'mode-a-ci-gate',
    });
    const replayTotals = await runReplay(db, { decide }, { replayRunId: run.id });
    expect(replayTotals).toMatchObject({
      examined: 1,
      decided: 1,
      opens: 1,
      skippedNoSnapshot: 0,
      modeBUnsoundPortfolioFeatures: false, // same label as the live decision — Mode A
    });

    const comparison = await compareRuns(db, {
      runA: 'live',
      runB: run.id,
      liveRulesVersionId: rules.id,
    });
    expect(comparison.summary).toEqual({
      total: 1,
      matched: 1,
      actionChanged: 0,
      sizeChanged: 0,
      skipReasonChanged: 0,
      onlyInA: 0,
      onlyInB: 0,
    });
    expect(comparison.divergences).toEqual([]);
  });

  it('decide-sweep contract: the pending-intents cutoff must be taken AFTER decideSignals, or a freshly-decided open is invisible to the same pass', async () => {
    const { instrumentId } = await seedTradingWorld();
    const rules = await createRulesVersion(db, { label: 'sweep-contract-v1', config: E2E_RULES });

    const totals = await decideSignals(
      db,
      {
        decide,
        broker: brokerAt(DECIDE_NOW),
        killSwitchHalted: false,
        engineVersion: ENGINE_VERSION,
        now: () => DECIDE_NOW,
      },
      { rulesLabel: 'sweep-contract-v1', batch: 10 },
    );
    expect(totals.opens).toBe(1);

    // The OLD (buggy) decide-sweep minted its `now` cutoff BEFORE calling
    // decideSignals — strictly older than this decision's decided_at.
    const staleCutoff = new Date(DECIDE_NOW.getTime() - 1);
    expect(
      await loadPendingOpenIntents(db, { rulesVersionId: rules.id, now: staleCutoff }),
    ).toEqual([]);

    // The FIXED decide-sweep mints its cutoff AFTER decideSignals returns —
    // at or after decided_at — so the same pass's enqueue sees the open.
    const freshCutoff = DECIDE_NOW;
    const pending = await loadPendingOpenIntents(db, {
      rulesVersionId: rules.id,
      now: freshCutoff,
    });
    expect(pending).toHaveLength(1);
    expect(pending[0]).toMatchObject({ instrumentId });
  });

  it('trades NOTHING under the shipped default rules (empty whitelist)', async () => {
    await seedTradingWorld();
    await ensureDefaultRules(db);

    const totals = await decideSignals(
      db,
      {
        decide,
        broker: brokerAt(DECIDE_NOW),
        killSwitchHalted: false,
        engineVersion: ENGINE_VERSION,
        now: () => DECIDE_NOW,
      },
      { rulesLabel: DEFAULT_RULES_LABEL, batch: 10 },
    );
    expect(totals).toMatchObject({ examined: 1, decided: 1, opens: 0, skips: 1 });
    expect(totals.intents).toEqual([]);

    const [decision] = await db.select().from(decisions);
    expect(decision).toMatchObject({ action: 'skip', skipReason: 'event_type_whitelist' });
    expect(await db.select().from(orders)).toHaveLength(0);
  });

  it('kill switch: decision recorded suppressed, zero orders, nothing pending', async () => {
    await seedTradingWorld();
    const rules = await createRulesVersion(db, { label: 'e2e-earnings-v1', config: E2E_RULES });

    const totals = await decideSignals(
      db,
      {
        decide,
        broker: brokerAt(DECIDE_NOW),
        killSwitchHalted: true, // tripped switch, observed by the caller this invocation
        engineVersion: ENGINE_VERSION,
        now: () => DECIDE_NOW,
      },
      { rulesLabel: 'e2e-earnings-v1', batch: 10 },
    );
    // Research data never stops: the open decision IS recorded — suppressed.
    expect(totals).toMatchObject({ examined: 1, decided: 1, opens: 1, suppressed: 1 });
    expect(totals.intents).toEqual([]);

    const [decision] = await db.select().from(decisions);
    expect(decision).toMatchObject({ action: 'open_long', suppressed: true });
    expect(await db.select().from(orders)).toHaveLength(0);
    // Suppressed decisions never re-emit, even after the switch clears.
    expect(await loadPendingOpenIntents(db, { rulesVersionId: rules.id, now: DECIDE_NOW })).toEqual(
      [],
    );
  });
});

// ------------------------------------------------------------------ helpers --

/**
 * FK-safe wipe of every table the ingest pipeline writes or the tests seed,
 * in dependency order: the M4 trading tables first (fills → order events →
 * orders → decisions → replay runs → rules versions → signals — they
 * reference clusters and instruments), then memberships → clusters →
 * instrument links → raw items → watermarks → sources, then the universe
 * tables (aliases and index membership before the instruments they
 * reference). Only ever pointed at this suite's dedicated e2e database.
 */
async function wipeIngestTables(db: Db): Promise<void> {
  await db.delete(fills);
  await db.delete(orderEvents);
  await db.delete(orders);
  await db.delete(decisions);
  await db.delete(replayRuns);
  await db.delete(rulesVersions);
  await db.delete(llmSignals);
  // M3 derived/fact tables next: they reference clusters and instruments.
  await db.delete(reactionMeasurements);
  await db.delete(reactionSummary);
  await db.delete(recoveryMeasurements);
  await db.delete(scheduledEvents);
  await db.delete(priceBars1m);
  await db.delete(priceBars1d);
  await db.delete(newsClusterItems);
  await db.delete(newsClusters);
  await db.delete(itemInstrumentLinks);
  await db.delete(rawNewsItems);
  await db.delete(ingestWatermarks);
  await db.delete(newsSources);
  await db.delete(instrumentAliases);
  await db.delete(indexMembership);
  await db.delete(instruments);
}

/**
 * Source keys only the DB test suites ever write — real adapters use keys like
 * edgar_8k / massive_news (see packages/adapters). Prior revisions of the DB
 * suites ran straight against the shared TEST_DATABASE_URL database and left
 * these fixture rows behind in real dev data.
 */
const FIXTURE_SOURCE_KEYS = ['rss_wire', 'rss_echo', 'fake_wire', 'fake_echo'];

/**
 * Idempotently delete leftover fixture-source rows from the SHARED
 * TEST_DATABASE_URL database. Strictly scoped by source_key so real dev rows
 * are never touched. FK-safe order: memberships → clusters → instrument links
 * → raw items → watermarks → sources. A cluster anchored (first_item_id) on a
 * fixture item is removed with ALL its memberships — later real items may have
 * joined it and become orphan members; a fixture membership inside a cluster
 * anchored elsewhere is removed alone, leaving the cluster in place.
 */
async function scrubFixtureSourceLeftovers(sharedDatabaseUrl: string): Promise<void> {
  const shared = createDb(sharedDatabaseUrl);
  try {
    const sources = await shared.$client.query<{ id: string }>(
      'select id from news_sources where source_key = any($1)',
      [FIXTURE_SOURCE_KEYS],
    );
    const sourceIds = sources.rows.map((row) => row.id);
    if (sourceIds.length === 0) return;

    const items = await shared.$client.query<{ id: string }>(
      'select id from raw_news_items where source_id = any($1)',
      [sourceIds],
    );
    const itemIds = items.rows.map((row) => row.id);
    const anchored = await shared.$client.query<{ id: string }>(
      'select id from news_clusters where first_item_id = any($1)',
      [itemIds],
    );
    const clusterIds = anchored.rows.map((row) => row.id);

    await shared.$client.query(
      'delete from news_cluster_items where item_id = any($1) or cluster_id = any($2)',
      [itemIds, clusterIds],
    );
    await shared.$client.query('delete from news_clusters where id = any($1)', [clusterIds]);
    await shared.$client.query('delete from item_instrument_links where item_id = any($1)', [
      itemIds,
    ]);
    await shared.$client.query('delete from raw_news_items where id = any($1)', [itemIds]);
    await shared.$client.query('delete from ingest_watermarks where source_id = any($1)', [
      sourceIds,
    ]);
    await shared.$client.query('delete from news_sources where id = any($1)', [sourceIds]);
    console.log(
      JSON.stringify({
        level: 'info',
        msg: 'e2e.scrubbed_fixture_leftovers',
        sources: sourceIds.length,
        items: itemIds.length,
        clusters: clusterIds.length,
      }),
    );
  } finally {
    await shared.$client.end();
  }
}

async function createE2eDatabase(adminUrl: string): Promise<string> {
  const parsed = new URL(adminUrl);
  const baseName = parsed.pathname.replace(/^\//, '') || 'postgres';
  const e2eName = `${baseName}_cli_e2e`.replace(/[^a-zA-Z0-9_]/g, '_');

  const admin = createDb(adminUrl);
  try {
    await admin.$client.query(`create database "${e2eName}"`);
  } catch (error) {
    if (!isDuplicateDatabase(error)) throw error;
  } finally {
    await admin.$client.end();
  }

  const e2eUrl = new URL(adminUrl);
  e2eUrl.pathname = `/${e2eName}`;
  return e2eUrl.toString();
}

function isDuplicateDatabase(error: unknown): boolean {
  return (
    typeof error === 'object' && error !== null && (error as { code?: unknown }).code === '42P04'
  );
}

/** Run the canonical drizzle migrations against the e2e database. */
function migrateDatabase(databaseUrl: string): void {
  const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..', '..');
  execFileSync('pnpm', ['--filter', '@newstrader/db', 'migrate'], {
    cwd: repoRoot,
    env: { ...process.env, DATABASE_URL: databaseUrl },
    stdio: 'pipe',
  });
}
