/**
 * DB-backed clustering tests — require a live Postgres and are skipped when
 * TEST_DATABASE_URL is unset.
 *
 * Run:
 *   docker compose up -d postgres
 *   TEST_DATABASE_URL=postgres://newstrader:newstrader@localhost:5433/newstrader pnpm vitest run packages/db
 *
 * Isolation: the suite creates and migrates its OWN database
 * (<dbname>_clustering_repo) and never writes to the shared TEST_DATABASE_URL
 * database. That database holds real dev data, and this suite is unsafe
 * against it three ways: beforeEach resets whole tables, closeStaleClusters
 * mutates every stale cluster globally, and several assertions count whole
 * tables. A previous revision ran directly against it — wiping real rows and
 * leaking 'rss_wire' fixture rows into dev stats. afterAll re-empties the
 * suite database so nothing persists between runs. Requires CREATEDB rights
 * (the docker-compose superuser has them).
 */
import { contentHash, newId } from '@newstrader/core';
import { eq } from 'drizzle-orm';
import { migrate } from 'drizzle-orm/node-postgres/migrator';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import {
  attachItemToCluster,
  closeStaleClusters,
  HEADLINE_SIMILARITY_THRESHOLD,
  type AttachItemInput,
} from './clustering-repo.js';
import { createDb, type Db } from './client.js';
import { newsClusterItems, newsClusters, newsSources, rawNewsItems } from './schema.js';

const testDatabaseUrl = process.env.TEST_DATABASE_URL;

/** Fixed base clock — received_at values are explicit, never wall-clock. */
const T0 = new Date('2026-07-06T12:00:00.000Z');
const minutesAfterT0 = (n: number) => new Date(T0.getTime() + n * 60_000);
const hoursAfterT0 = (n: number) => new Date(T0.getTime() + n * 3_600_000);

describe.skipIf(!testDatabaseUrl)('clustering-repo (integration)', () => {
  let db: Db;

  beforeAll(async () => {
    if (testDatabaseUrl === undefined)
      throw new Error('unreachable: suite is skipped without TEST_DATABASE_URL');
    const suiteUrl = await createSuiteDatabase(testDatabaseUrl);
    db = createDb(suiteUrl);
    await migrate(db, { migrationsFolder: new URL('../migrations', import.meta.url).pathname });
  }, 60_000);

  afterAll(async () => {
    // Self-cleaning: the suite database is reused across runs — leave it empty.
    try {
      await wipeTables(db);
    } finally {
      await db.$client.end();
    }
  });

  beforeEach(async () => {
    await wipeTables(db);
  });

  /** FK-safe wipe, in dependency order: memberships → clusters → items → sources. */
  async function wipeTables(target: Db): Promise<void> {
    await target.delete(newsClusterItems);
    await target.delete(newsClusters);
    await target.delete(rawNewsItems);
    await target.delete(newsSources);
  }

  async function seedSource(sourceKey: string): Promise<string> {
    const id = newId();
    await db.insert(newsSources).values({ id, sourceKey, kind: 'rss', name: sourceKey });
    return id;
  }

  async function seedItem(input: {
    sourceId: string;
    headline: string;
    body?: string;
    receivedAt: Date;
  }): Promise<AttachItemInput> {
    const id = newId();
    const hash = contentHash(input.headline, input.body);
    await db.insert(rawNewsItems).values({
      id,
      sourceId: input.sourceId,
      externalId: id,
      headline: input.headline,
      payloadRef: `test/${id}.json`,
      contentHash: hash,
      receivedAt: input.receivedAt,
    });
    return {
      id,
      sourceId: input.sourceId,
      headline: input.headline,
      contentHash: hash,
      receivedAt: input.receivedAt,
    };
  }

  async function loadCluster(clusterId: string) {
    const rows = await db.select().from(newsClusters).where(eq(newsClusters.id, clusterId));
    const row = rows[0];
    if (!row) throw new Error(`cluster ${clusterId} not found`);
    return row;
  }

  const WIRE_HEADLINE =
    'Acme Corp announces record quarterly earnings beating analyst expectations';
  // Same story, lightly re-edited by another outlet: near-dup, different content hash.
  const ECHO_HEADLINE =
    'Acme Corp announces record quarterly earnings, beating analyst expectations for Q2';

  it('attaches an exact content-hash duplicate with similarity 1.0', async () => {
    const [wireSource, echoSource] = await Promise.all([
      seedSource('rss_wire'),
      seedSource('rss_echo'),
    ]);
    const original = await seedItem({
      sourceId: wireSource,
      headline: WIRE_HEADLINE,
      receivedAt: T0,
    });
    const duplicate = await seedItem({
      sourceId: echoSource,
      headline: WIRE_HEADLINE,
      receivedAt: minutesAfterT0(5),
    });

    const first = await attachItemToCluster(db, original);
    expect(first.isNew).toBe(true);
    expect(first.similarity).toBe(1);

    const second = await attachItemToCluster(db, duplicate);
    expect(second).toEqual({ clusterId: first.clusterId, isNew: false, similarity: 1 });

    const cluster = await loadCluster(first.clusterId);
    expect(cluster.itemCount).toBe(2);
    expect(cluster.distinctSourceCount).toBe(2);
    expect(cluster.firstReceivedAt).toEqual(T0);
    expect(cluster.lastItemAt).toEqual(minutesAfterT0(5));

    const memberships = await db
      .select()
      .from(newsClusterItems)
      .where(eq(newsClusterItems.itemId, duplicate.id));
    expect(memberships[0]?.lagFromFirstMs).toBe(5 * 60_000);
  });

  it('attaches a near-duplicate headline via pg_trgm similarity', async () => {
    const [wireSource, echoSource] = await Promise.all([
      seedSource('rss_wire'),
      seedSource('rss_echo'),
    ]);
    const original = await seedItem({
      sourceId: wireSource,
      headline: WIRE_HEADLINE,
      receivedAt: T0,
    });
    const echo = await seedItem({
      sourceId: echoSource,
      headline: ECHO_HEADLINE,
      receivedAt: minutesAfterT0(12),
    });
    expect(echo.contentHash).not.toBe(original.contentHash);

    const first = await attachItemToCluster(db, original);
    const second = await attachItemToCluster(db, echo);

    expect(second.clusterId).toBe(first.clusterId);
    expect(second.isNew).toBe(false);
    expect(second.similarity).toBeGreaterThanOrEqual(HEADLINE_SIMILARITY_THRESHOLD);
    expect(second.similarity).toBeLessThan(1);

    const cluster = await loadCluster(first.clusterId);
    expect(cluster.itemCount).toBe(2);
    expect(cluster.distinctSourceCount).toBe(2);
    // Canonical headline stays the first item's — echoes never overwrite the anchor.
    expect(cluster.canonicalHeadline).toBe(WIRE_HEADLINE);
  });

  it('gives distinct stories distinct clusters', async () => {
    const sourceId = await seedSource('rss_wire');
    const acme = await seedItem({ sourceId, headline: WIRE_HEADLINE, receivedAt: T0 });
    const unrelated = await seedItem({
      sourceId,
      headline: 'Globex Industries recalls smart thermostats over fire risk',
      receivedAt: minutesAfterT0(1),
    });

    const first = await attachItemToCluster(db, acme);
    const second = await attachItemToCluster(db, unrelated);

    expect(second.isNew).toBe(true);
    expect(second.clusterId).not.toBe(first.clusterId);
    expect(await db.select().from(newsClusters)).toHaveLength(2);
  });

  it('treats a redelivered item as a no-op returning the existing membership', async () => {
    const sourceId = await seedSource('rss_wire');
    const item = await seedItem({ sourceId, headline: WIRE_HEADLINE, receivedAt: T0 });

    const first = await attachItemToCluster(db, item);
    const redelivered = await attachItemToCluster(db, item);

    expect(redelivered).toEqual({ clusterId: first.clusterId, isNew: false, similarity: 1 });
    expect(await db.select().from(newsClusters)).toHaveLength(1);
    expect(await db.select().from(newsClusterItems)).toHaveLength(1);

    const cluster = await loadCluster(first.clusterId);
    expect(cluster.itemCount).toBe(1);
    expect(cluster.distinctSourceCount).toBe(1);
    expect(cluster.lastItemAt).toEqual(T0);
  });

  it('yields ONE cluster when two echoes attach concurrently', async () => {
    const [wireSource, echoSource] = await Promise.all([
      seedSource('rss_wire'),
      seedSource('rss_echo'),
    ]);
    const a = await seedItem({ sourceId: wireSource, headline: WIRE_HEADLINE, receivedAt: T0 });
    const b = await seedItem({
      sourceId: echoSource,
      headline: ECHO_HEADLINE,
      receivedAt: minutesAfterT0(1),
    });

    // Two Lambdas processing echoes of the same story at once: the advisory
    // lock must serialize them into one cluster (which one wins is timing-dependent).
    const [resultA, resultB] = await Promise.all([
      attachItemToCluster(db, a),
      attachItemToCluster(db, b),
    ]);

    expect(resultA.clusterId).toBe(resultB.clusterId);
    expect([resultA.isNew, resultB.isNew].filter(Boolean)).toHaveLength(1);
    expect(await db.select().from(newsClusters)).toHaveLength(1);

    const cluster = await loadCluster(resultA.clusterId);
    expect(cluster.itemCount).toBe(2);
    expect(cluster.distinctSourceCount).toBe(2);
  });

  it('does not attach to clusters whose story started outside the 48h window', async () => {
    const sourceId = await seedSource('rss_wire');
    const original = await seedItem({ sourceId, headline: WIRE_HEADLINE, receivedAt: T0 });
    const lateEcho = await seedItem({
      sourceId,
      headline: ECHO_HEADLINE,
      receivedAt: hoursAfterT0(49),
    });

    const first = await attachItemToCluster(db, original);
    const second = await attachItemToCluster(db, lateEcho);

    expect(second.isNew).toBe(true);
    expect(second.clusterId).not.toBe(first.clusterId);
  });

  it('closeStaleClusters closes silent clusters, which stop attracting attaches', async () => {
    const sourceId = await seedSource('rss_wire');
    const stale = await seedItem({ sourceId, headline: WIRE_HEADLINE, receivedAt: T0 });
    const fresh = await seedItem({
      sourceId,
      headline: 'Globex Industries recalls smart thermostats over fire risk',
      receivedAt: hoursAfterT0(72),
    });

    const staleResult = await attachItemToCluster(db, stale);
    const freshResult = await attachItemToCluster(db, fresh);

    const closedCount = await closeStaleClusters(db, 48, hoursAfterT0(73));
    expect(closedCount).toBe(1);
    expect((await loadCluster(staleResult.clusterId)).status).toBe('closed');
    expect((await loadCluster(freshResult.clusterId)).status).toBe('open');

    // An exact-text echo of the closed story still short-circuits via content
    // hash (step 1 ignores status), but a near-dup must NOT revive the closed
    // cluster through the similarity path.
    const nearDupOfClosed = await seedItem({
      sourceId,
      headline: ECHO_HEADLINE,
      receivedAt: hoursAfterT0(73),
    });
    const revived = await attachItemToCluster(db, nearDupOfClosed);
    expect(revived.isNew).toBe(true);
    expect(revived.clusterId).not.toBe(staleResult.clusterId);
  });
});

// ------------------------------------------------------------------ helpers --

/**
 * Create (if missing) the suite's dedicated database next to the shared
 * TEST_DATABASE_URL one and return its URL. Idempotent across runs; mirrors
 * services/cli/src/e2e.test.ts (<dbname>_cli_e2e).
 */
async function createSuiteDatabase(adminUrl: string): Promise<string> {
  const parsed = new URL(adminUrl);
  const baseName = parsed.pathname.replace(/^\//, '') || 'postgres';
  const suiteName = `${baseName}_clustering_repo`.replace(/[^a-zA-Z0-9_]/g, '_');

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
