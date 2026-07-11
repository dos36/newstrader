/**
 * DB-backed resolver tests — require a live Postgres and are skipped when
 * TEST_DATABASE_URL is unset.
 *
 * Run:
 *   docker compose up -d postgres
 *   TEST_DATABASE_URL=postgres://newstrader:newstrader@localhost:5433/newstrader \
 *     pnpm vitest run packages/db/src/resolver
 *
 * Isolation: the suite creates and migrates its OWN database
 * (<dbname>_resolver) and never touches the shared TEST_DATABASE_URL database.
 * Row-scoped cleanup alone proved insufficient: loadResolverDictionary and
 * resolveUnlinkedItems both read GLOBALLY (whole-table dictionary, global
 * oldest-first item ordering), so real dev rows in a shared DB change this
 * suite's results (a test headline once matched a real instrument's alias).
 * The suite still cleans its rows so the reused suite DB stays empty.
 *
 * Determinism note: resolveUnlinkedItems orders globally by received_at, so
 * this suite dates its items in 2001 to keep intra-suite ordering explicit.
 */
import { contentHash, newId } from '@newstrader/core';
import { and, eq, inArray } from 'drizzle-orm';
import { migrate } from 'drizzle-orm/node-postgres/migrator';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { createDb, type Db } from '../client.js';
import {
  instrumentAliases,
  instruments,
  itemInstrumentLinks,
  newsSources,
  rawNewsItems,
} from '../schema.js';
import { CONFIDENCE, RESOLVER_VERSION, type ResolvedLink } from './match.js';
import { loadResolverDictionary, persistLinks, resolveUnlinkedItems } from './resolve-repo.js';
import type { ResolveCursor } from './resolve-repo.js';

const testDatabaseUrl = process.env.TEST_DATABASE_URL;

/** Fictional identifiers so dictionary entries never collide with other suites' seeds. */
const TEST_SOURCE_KEY = 'resolver_test_source';
const TEST_SYMBOLS = ['VNDL', 'KRMR', 'QBTC'];
const VNDL_CIK = '9990001';

/** 2001 base clock: older than every other suite's fixtures (see header note). */
const T0 = new Date('2001-01-01T00:00:00.000Z');
const daysAfterT0 = (n: number) => new Date(T0.getTime() + n * 86_400_000);

const ALIAS_VALID_FROM = new Date('2000-01-01T00:00:00.000Z');

describe.skipIf(!testDatabaseUrl)('resolver repo (integration)', () => {
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
    await cleanupTestRows();
    await db.$client.end();
  });

  beforeEach(async () => {
    await cleanupTestRows();
    sourceId = newId();
    await db
      .insert(newsSources)
      .values({ id: sourceId, sourceKey: TEST_SOURCE_KEY, kind: 'rss', name: 'resolver test' });
  });

  /** Delete every row this suite could have created, in FK-safe order. */
  async function cleanupTestRows(): Promise<void> {
    const sourceRows = await db
      .select({ id: newsSources.id })
      .from(newsSources)
      .where(eq(newsSources.sourceKey, TEST_SOURCE_KEY));
    const sourceIds = sourceRows.map((row) => row.id);
    if (sourceIds.length > 0) {
      const itemRows = await db
        .select({ id: rawNewsItems.id })
        .from(rawNewsItems)
        .where(inArray(rawNewsItems.sourceId, sourceIds));
      const itemIds = itemRows.map((row) => row.id);
      if (itemIds.length > 0) {
        await db.delete(itemInstrumentLinks).where(inArray(itemInstrumentLinks.itemId, itemIds));
        await db.delete(rawNewsItems).where(inArray(rawNewsItems.id, itemIds));
      }
    }
    const instrumentRows = await db
      .select({ id: instruments.id })
      .from(instruments)
      .where(inArray(instruments.symbol, TEST_SYMBOLS));
    const instrumentIds = instrumentRows.map((row) => row.id);
    if (instrumentIds.length > 0) {
      await db
        .delete(itemInstrumentLinks)
        .where(inArray(itemInstrumentLinks.instrumentId, instrumentIds));
      await db
        .delete(instrumentAliases)
        .where(inArray(instrumentAliases.instrumentId, instrumentIds));
      await db.delete(instruments).where(inArray(instruments.id, instrumentIds));
    }
    if (sourceIds.length > 0) {
      await db.delete(newsSources).where(inArray(newsSources.id, sourceIds));
    }
  }

  async function seedInstrument(input: {
    symbol: string;
    assetClass: 'us_equity' | 'crypto';
    name: string;
    cik?: string;
  }): Promise<string> {
    const id = newId();
    await db.insert(instruments).values({
      id,
      symbol: input.symbol,
      assetClass: input.assetClass,
      name: input.name,
      cik: input.cik ?? null,
    });
    return id;
  }

  async function seedAlias(
    instrumentId: string,
    alias: string,
    aliasKind: 'name' | 'ticker' | 'cashtag' | 'cik',
    validTo?: Date,
  ): Promise<void> {
    await db.insert(instrumentAliases).values({
      instrumentId,
      alias,
      aliasKind,
      validFrom: ALIAS_VALID_FROM,
      validTo: validTo ?? null,
    });
  }

  async function seedItem(input: {
    headline: string;
    receivedAt: Date;
    symbolsHint?: string[];
    meta?: Record<string, unknown>;
  }): Promise<string> {
    const id = newId();
    await db.insert(rawNewsItems).values({
      id,
      sourceId,
      externalId: id,
      headline: input.headline,
      payloadRef: `test/${id}.json`,
      contentHash: contentHash(input.headline),
      receivedAt: input.receivedAt,
      symbolsHint: input.symbolsHint ?? [],
      meta: input.meta ?? {},
    });
    return id;
  }

  async function loadLinks(itemId: string) {
    return db
      .select()
      .from(itemInstrumentLinks)
      .where(
        and(
          eq(itemInstrumentLinks.itemId, itemId),
          eq(itemInstrumentLinks.resolverVersion, RESOLVER_VERSION),
        ),
      );
  }

  describe('loadResolverDictionary', () => {
    it('loads instruments plus OPEN aliases only, with normalized keys', async () => {
      const vandelayId = await seedInstrument({
        symbol: 'VNDL',
        assetClass: 'us_equity',
        name: 'Vandelay Industries Inc',
        cik: VNDL_CIK, // stored unpadded — the dictionary must normalize
      });
      const qbtcId = await seedInstrument({
        symbol: 'QBTC',
        assetClass: 'crypto',
        name: 'Quantumcoin',
      });
      await seedAlias(vandelayId, 'Vandelay', 'name');
      await seedAlias(vandelayId, 'VNDY', 'ticker'); // former ticker, still open
      await seedAlias(vandelayId, 'Import-Export Co', 'name', new Date('2020-01-01T00:00:00Z'));
      await seedAlias(qbtcId, 'Quantumcoin', 'name');

      const dict = await loadResolverDictionary(db);

      expect(dict.byCik.get('0009990001')).toBe(vandelayId);
      expect(dict.byTicker.get('VNDL')).toBe(vandelayId);
      expect(dict.byTicker.get('VNDY')).toBe(vandelayId);
      expect(dict.byTicker.get('QBTC')).toBe(qbtcId);

      const mine = dict.nameAliases.filter(
        (a) => a.instrumentId === vandelayId || a.instrumentId === qbtcId,
      );
      // Open name aliases are scannable; the CLOSED alias must be absent.
      expect(mine).toContainEqual({
        alias: 'Vandelay',
        instrumentId: vandelayId,
        kind: 'name',
        assetClass: 'us_equity',
      });
      expect(mine.some((a) => a.alias === 'Import-Export Co')).toBe(false);
      // Crypto symbols double as scan keywords; equity ticker aliases never do.
      expect(mine).toContainEqual({
        alias: 'QBTC',
        instrumentId: qbtcId,
        kind: 'ticker',
        assetClass: 'crypto',
      });
      expect(mine).toContainEqual({
        alias: 'Quantumcoin',
        instrumentId: qbtcId,
        kind: 'name',
        assetClass: 'crypto',
      });
      expect(mine.some((a) => a.alias === 'VNDY')).toBe(false);
    });
  });

  describe('persistLinks', () => {
    it('inserts links once and is a no-op on redelivery (PK conflict-do-nothing)', async () => {
      const vandelayId = await seedInstrument({
        symbol: 'VNDL',
        assetClass: 'us_equity',
        name: 'Vandelay Industries Inc',
      });
      const kramericaId = await seedInstrument({
        symbol: 'KRMR',
        assetClass: 'us_equity',
        name: 'Kramerica Industries',
      });
      const itemId = await seedItem({ headline: 'Vandelay and Kramerica merge', receivedAt: T0 });

      const links: ResolvedLink[] = [
        { instrumentId: vandelayId, method: 'ticker_exact', confidence: 0.9 },
        { instrumentId: kramericaId, method: 'alias_dict', confidence: 0.7 },
      ];

      expect(await persistLinks(db, itemId, links)).toBe(2);
      // Redelivery: same links → nothing written.
      expect(await persistLinks(db, itemId, links)).toBe(0);
      // A conflicting re-resolve must NOT overwrite the stored method/confidence.
      expect(
        await persistLinks(db, itemId, [
          { instrumentId: vandelayId, method: 'source_hint', confidence: 0.95 },
        ]),
      ).toBe(0);

      const rows = await loadLinks(itemId);
      expect(rows).toHaveLength(2);
      const vandelayRow = rows.find((r) => r.instrumentId === vandelayId);
      expect(vandelayRow?.method).toBe('ticker_exact');
      expect(vandelayRow?.confidence).toBeCloseTo(0.9, 5);
      expect(vandelayRow?.resolverVersion).toBe(RESOLVER_VERSION);
    });

    it('returns 0 for an empty link list without touching the DB', async () => {
      const itemId = await seedItem({ headline: 'Nothing to link', receivedAt: T0 });
      expect(await persistLinks(db, itemId, [])).toBe(0);
      expect(await loadLinks(itemId)).toHaveLength(0);
    });
  });

  describe('resolveUnlinkedItems', () => {
    it('resolves oldest-first within the batch, persists links, and skips linked items on the next pass', async () => {
      const vandelayId = await seedInstrument({
        symbol: 'VNDL',
        assetClass: 'us_equity',
        name: 'Vandelay Industries Inc',
        cik: VNDL_CIK,
      });
      await seedAlias(vandelayId, 'Vandelay', 'name');

      const byPrefix = await seedItem({
        headline: 'Shares soar after results (NASDAQ: VNDL)',
        receivedAt: daysAfterT0(0),
      });
      const byAlias = await seedItem({
        headline: 'Vandelay beats latex-futures estimates',
        receivedAt: daysAfterT0(1),
      });
      const byCik = await seedItem({
        headline: '8-K - Vandelay Industries Inc (0009990001) (Filer)',
        receivedAt: daysAfterT0(2),
        meta: { cik: VNDL_CIK, itemCodes: ['2.02'] },
      });
      const unresolvable = await seedItem({
        headline: 'Weather delays shipping across the region',
        receivedAt: daysAfterT0(3),
      });

      // batch=3 examines only the three oldest — the unresolvable item waits.
      const first = await resolveUnlinkedItems(db, { batch: 3 });
      expect(first).toEqual({
        processed: 3,
        linked: 3,
        linksWritten: 3,
        lastKey: { receivedAt: daysAfterT0(2), id: byCik },
      });

      const prefixLinks = await loadLinks(byPrefix);
      expect(prefixLinks).toHaveLength(1);
      expect(prefixLinks[0]?.method).toBe('ticker_exact');
      expect(prefixLinks[0]?.confidence).toBeCloseTo(CONFIDENCE.exchangePrefix, 5);

      const aliasLinks = await loadLinks(byAlias);
      expect(aliasLinks).toHaveLength(1);
      expect(aliasLinks[0]?.method).toBe('alias_dict');
      expect(aliasLinks[0]?.confidence).toBeCloseTo(CONFIDENCE.nameAlias, 5);

      const cikLinks = await loadLinks(byCik);
      expect(cikLinks).toHaveLength(1);
      expect(cikLinks[0]?.method).toBe('cik_exact');
      expect(cikLinks[0]?.confidence).toBe(1);
      expect(cikLinks[0]?.instrumentId).toBe(vandelayId);

      // Next pass: the three linked items are excluded, so batch=1 lands on the
      // unresolvable item, which yields no links (and stays retryable by design).
      const second = await resolveUnlinkedItems(db, { batch: 1 });
      expect(second).toEqual({
        processed: 1,
        linked: 0,
        linksWritten: 0,
        lastKey: { receivedAt: daysAfterT0(3), id: unresolvable },
      });
      expect(await loadLinks(unresolvable)).toHaveLength(0);
      expect(await loadLinks(byPrefix)).toHaveLength(1);
      expect(await loadLinks(byAlias)).toHaveLength(1);
      expect(await loadLinks(byCik)).toHaveLength(1);
    });

    it('the keyset cursor sweeps past a head block of unresolvable items (no starvation)', async () => {
      const vandelayId = await seedInstrument({
        symbol: 'VNDL',
        assetClass: 'us_equity',
        name: 'Vandelay Industries Inc',
      });
      await seedAlias(vandelayId, 'Vandelay', 'name');
      // Two permanently-unresolvable items at the HEAD, resolvable one behind them.
      await seedItem({ headline: 'Weather delays shipping', receivedAt: daysAfterT0(0) });
      await seedItem({ headline: 'Rates unchanged this quarter', receivedAt: daysAfterT0(1) });
      const resolvable = await seedItem({
        headline: 'Vandelay wins export contract',
        receivedAt: daysAfterT0(2),
      });

      // batch=1 without a cursor would return the same head item forever.
      // Threading lastKey → after must reach and link the third item.
      let after: ResolveCursor | undefined;
      let linkedTotal = 0;
      for (let pass = 0; pass < 5; pass++) {
        const counts = await resolveUnlinkedItems(db, {
          batch: 1,
          ...(after !== undefined ? { after } : {}),
        });
        linkedTotal += counts.linked;
        if (counts.processed < 1 || counts.lastKey === null) break;
        after = counts.lastKey;
      }
      expect(linkedTotal).toBe(1);
      expect(await loadLinks(resolvable)).toHaveLength(1);
    });

    it('returns zero counts when nothing is unlinked (empty-batch early-out)', async () => {
      // No items seeded under 2001 timestamps; ask for a batch anyway. Other
      // suites' leftovers could theoretically be picked up, so seed one linked
      // item and assert only that OUR rows are untouched.
      const vandelayId = await seedInstrument({
        symbol: 'VNDL',
        assetClass: 'us_equity',
        name: 'Vandelay Industries Inc',
      });
      const itemId = await seedItem({ headline: 'Already handled', receivedAt: T0 });
      await persistLinks(db, itemId, [
        { instrumentId: vandelayId, method: 'ticker_exact', confidence: 0.9 },
      ]);

      const counts = await resolveUnlinkedItems(db, { batch: 1 });
      // The linked item must not be re-processed; if the DB is otherwise clean
      // this is a true zero pass.
      expect(await loadLinks(itemId)).toHaveLength(1);
      expect(counts.linksWritten).toBe(0);
    });
  });
});

// ------------------------------------------------------------------ helpers --

/**
 * Create (if missing) the suite's dedicated database next to the shared
 * TEST_DATABASE_URL one and return its URL. Idempotent across runs; mirrors
 * clustering-repo.test.ts / sync.test.ts / e2e.test.ts.
 */
async function createSuiteDatabase(adminUrl: string): Promise<string> {
  const parsed = new URL(adminUrl);
  const baseName = parsed.pathname.replace(/^\//, '') || 'postgres';
  const suiteName = `${baseName}_resolver`.replace(/[^a-zA-Z0-9_]/g, '_');

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
