import { execFileSync } from 'node:child_process';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import type {
  FetchedItem,
  FetchResult,
  RawItemV1,
  RawStore,
  SourceAdapter,
} from '@newstrader/core';
import {
  createDb,
  ingestWatermarks,
  newsClusterItems,
  newsClusters,
  newsSources,
  rawNewsItems,
} from '@newstrader/db';
import type { Db } from '@newstrader/db';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import {
  loadItemsByIds,
  loadUnclusteredItems,
  runPoll,
  runProcess,
} from '../../handlers/src/lib/ingest.js';

/**
 * End-to-end fixture test of the shared ingest core: fake in-memory adapters +
 * in-memory RawStore + REAL Postgres (clustering needs pg_trgm and the
 * advisory-locked attach). Skipped without TEST_DATABASE_URL.
 *
 * Isolation: this file creates and migrates its OWN database
 * (<dbname>_cli_e2e, via `pnpm --filter @newstrader/db migrate`) because
 * packages/db/src/clustering-repo.test.ts truncates every table in the shared
 * TEST_DATABASE_URL database and vitest runs files in parallel — sharing it
 * would race. Requires CREATEDB rights (the docker-compose superuser has them).
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
    const e2eUrl = await createE2eDatabase(testDatabaseUrl);
    migrateDatabase(e2eUrl);
    db = createDb(e2eUrl);
  }, 120_000);

  afterAll(async () => {
    await db.$client.end();
  });

  beforeEach(async () => {
    // FK order: memberships → clusters, watermarks/items → sources.
    await db.delete(newsClusterItems);
    await db.delete(newsClusters);
    await db.delete(ingestWatermarks);
    await db.delete(rawNewsItems);
    await db.delete(newsSources);
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

    const counts = await runProcess(db, unclustered);
    expect(counts).toEqual({ processed: 3, newClusters: 2, attachedExisting: 1 });

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
    await runProcess(db, await loadUnclusteredItems(db, 500));

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
    const counts = await runProcess(db, redelivered);
    expect(counts).toEqual({ processed: 3, newClusters: 0, attachedExisting: 3 });

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
});

// ------------------------------------------------------------------ helpers --

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
