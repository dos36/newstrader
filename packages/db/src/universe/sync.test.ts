/**
 * DB-backed universe sync tests — require a live Postgres and are skipped when
 * TEST_DATABASE_URL is unset.
 *
 * Run:
 *   docker compose up -d postgres
 *   TEST_DATABASE_URL=postgres://newstrader:newstrader@localhost:5433/newstrader \
 *     pnpm vitest run packages/db/src/universe
 *
 * Isolation: the suite creates and migrates its OWN database
 * (<dbname>_universe_sync) and never touches the shared TEST_DATABASE_URL
 * database. That isolation is NOT optional for this suite: syncUniverse's
 * membership diff is global (it closes every open SPX row absent from the
 * fetched list), so running it against a shared DB with fixture lists would
 * close all real membership rows — which is exactly what a previous revision
 * did to the dev DB. Mirrors clustering-repo.test.ts / e2e.test.ts. Requires
 * CREATEDB rights (the docker-compose superuser has them).
 */
import { newId } from '@newstrader/core';
import { and, asc, eq, inArray } from 'drizzle-orm';
import { migrate } from 'drizzle-orm/node-postgres/migrator';
import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest';

import { createDb, type Db } from '../client.js';
import { indexMembership, instrumentAliases, instruments } from '../schema.js';
import type { SecTickerMap } from './sec-tickers.js';
import { SPX_INDEX_CODE, syncUniverse, type SyncUniverseDeps } from './sync.js';
import type { Sp500Row } from './wikipedia.js';

const testDatabaseUrl = process.env.TEST_DATABASE_URL;

/** Fixed clocks — valid_from/valid_to values are explicit, never wall-clock. */
const T1 = new Date('2026-07-08T06:00:00.000Z');
const T2 = new Date('2026-07-09T06:00:00.000Z');

/** Deliberately fake symbols so parallel suites sharing the DB can't collide. */
const EQUITY_SYMBOLS = ['ZZTA', 'ZZTB', 'ZZT.B', 'ZZOLD'] as const;
const CRYPTO_SYMBOLS = ['BTC', 'ETH', 'SOL'] as const;
const ALL_TEST_SYMBOLS = [...EQUITY_SYMBOLS, ...CRYPTO_SYMBOLS];

const row = (symbol: string, security: string, cik: string, sector = 'Industrials'): Sp500Row => ({
  symbol,
  security,
  sector,
  subIndustry: 'Test Sub-Industry',
  cik,
});

const deps = (
  sp500: Sp500Row[],
  now: Date,
  secTickers: SecTickerMap = new Map(),
): SyncUniverseDeps => ({
  fetchSp500: async () => sp500,
  fetchSecTickers: async () => secTickers,
  now: () => now,
});

describe.skipIf(!testDatabaseUrl)('syncUniverse (integration)', () => {
  let db: Db;

  beforeAll(async () => {
    if (testDatabaseUrl === undefined)
      throw new Error('unreachable: suite is skipped without TEST_DATABASE_URL');
    const suiteUrl = await createSuiteDatabase(testDatabaseUrl);
    db = createDb(suiteUrl);
    await migrate(db, { migrationsFolder: new URL('../../migrations', import.meta.url).pathname });
  }, 60_000);

  afterAll(async () => {
    // Self-cleaning: the suite database is reused across runs — leave it empty.
    try {
      await wipeTables(db);
    } finally {
      await db.$client.end();
    }
  });

  afterEach(async () => {
    await wipeTables(db);
  });

  /** FK-safe wipe of the SUITE database only (aliases/membership reference instruments). */
  async function wipeTables(target: Db): Promise<void> {
    await target.delete(instrumentAliases);
    await target.delete(indexMembership);
    await target.delete(instruments);
  }

  async function instrumentBySymbol(symbol: string, assetClass: 'us_equity' | 'crypto') {
    const rows = await db
      .select()
      .from(instruments)
      .where(and(eq(instruments.symbol, symbol), eq(instruments.assetClass, assetClass)));
    const found = rows[0];
    if (!found) throw new Error(`instrument ${symbol}/${assetClass} not found`);
    return found;
  }

  async function aliasesOf(instrumentId: string) {
    return db
      .select()
      .from(instrumentAliases)
      .where(eq(instrumentAliases.instrumentId, instrumentId))
      .orderBy(asc(instrumentAliases.aliasKind), asc(instrumentAliases.alias));
  }

  async function membershipsOf(instrumentId: string) {
    return db.select().from(indexMembership).where(eq(indexMembership.instrumentId, instrumentId));
  }

  it('seeds instruments, SPX membership, crypto, and the alias dictionary', async () => {
    const counts = await syncUniverse(db, deps([row('ZZTA', 'Zeta Alpha Corp', '0000000011')], T1));
    expect(counts).toEqual({
      equities: 1,
      cryptoSeeded: 3,
      membersAdded: 1,
      membersClosed: 0,
      // ZZTA: ticker + cashtag + cik + 2 names; BTC/SOL 3 each; ETH 4.
      aliasesInserted: 5 + 3 + 4 + 3,
      aliasesClosed: 0,
    });

    const zeta = await instrumentBySymbol('ZZTA', 'us_equity');
    expect(zeta.name).toBe('Zeta Alpha Corp');
    expect(zeta.cik).toBe('0000000011');
    expect(zeta.sectorApprox).toBe('Industrials');

    const memberships = await membershipsOf(zeta.id);
    expect(memberships).toEqual([
      {
        instrumentId: zeta.id,
        indexCode: SPX_INDEX_CODE,
        validFrom: T1,
        validTo: null,
      },
    ]);

    const zetaAliases = await aliasesOf(zeta.id);
    expect(
      zetaAliases.map(({ alias, aliasKind, validFrom, validTo }) => ({
        alias,
        aliasKind,
        validFrom,
        validTo,
      })),
    ).toEqual([
      { alias: '$ZZTA', aliasKind: 'cashtag', validFrom: T1, validTo: null },
      { alias: '0000000011', aliasKind: 'cik', validFrom: T1, validTo: null },
      { alias: 'Zeta Alpha', aliasKind: 'name', validFrom: T1, validTo: null },
      { alias: 'Zeta Alpha Corp', aliasKind: 'name', validFrom: T1, validTo: null },
      { alias: 'ZZTA', aliasKind: 'ticker', validFrom: T1, validTo: null },
    ]);

    const btc = await instrumentBySymbol('BTC', 'crypto');
    expect(btc.exchange).toBeNull();
    expect(btc.name).toBe('Bitcoin');
    // Crypto never joins SPX.
    expect(await membershipsOf(btc.id)).toEqual([]);
    const btcAliases = await aliasesOf(btc.id);
    expect(btcAliases.map((a) => `${a.aliasKind}:${a.alias}`)).toEqual([
      'cashtag:$BTC',
      'name:Bitcoin',
      'ticker:BTC',
    ]);
  });

  it('prefers the SEC CIK over Wikipedia, resolving dot-form symbols to dash-form', async () => {
    const secTickers: SecTickerMap = new Map([
      ['ZZT-B', { cik: '0000000099', title: 'ZETA TEST B' }],
    ]);
    await syncUniverse(
      db,
      deps([row('ZZT.B', 'Zeta Test (Class B)', '0000000001')], T1, secTickers),
    );

    const instrument = await instrumentBySymbol('ZZT.B', 'us_equity');
    expect(instrument.cik).toBe('0000000099'); // SEC wins over Wikipedia's 0000000001.

    const cikAliases = (await aliasesOf(instrument.id)).filter((a) => a.aliasKind === 'cik');
    expect(cikAliases.map((a) => a.alias)).toEqual(['0000000099']);
  });

  it('is idempotent: re-running the same list is a no-op with zero row drift', async () => {
    const list = [
      row('ZZTA', 'Zeta Alpha Corp', '0000000011'),
      row('ZZTB', 'The Zeta Beta Company', '0000000012', 'Health Care'),
    ];
    await syncUniverse(db, deps(list, T1));

    const snapshot = async () => ({
      instruments: (
        await db.select().from(instruments).where(inArray(instruments.symbol, ALL_TEST_SYMBOLS))
      ).length,
      memberships: (
        await db
          .select()
          .from(indexMembership)
          .innerJoin(instruments, eq(instruments.id, indexMembership.instrumentId))
          .where(inArray(instruments.symbol, ALL_TEST_SYMBOLS))
      ).length,
      aliases: (
        await db
          .select()
          .from(instrumentAliases)
          .innerJoin(instruments, eq(instruments.id, instrumentAliases.instrumentId))
          .where(inArray(instruments.symbol, ALL_TEST_SYMBOLS))
      ).length,
    });

    const before = await snapshot();
    const secondRun = await syncUniverse(db, deps(list, T2));
    const after = await snapshot();

    expect(after).toEqual(before);
    expect(secondRun).toEqual({
      equities: 2,
      cryptoSeeded: 3,
      membersAdded: 0,
      membersClosed: 0,
      aliasesInserted: 0,
      aliasesClosed: 0,
    });

    // Alias-diffing stability: untouched aliases keep their ORIGINAL valid_from.
    const zeta = await instrumentBySymbol('ZZTA', 'us_equity');
    for (const alias of await aliasesOf(zeta.id)) {
      expect(alias.validFrom).toEqual(T1);
      expect(alias.validTo).toBeNull();
    }
    // Membership rows equally untouched.
    expect(await membershipsOf(zeta.id)).toEqual([
      { instrumentId: zeta.id, indexCode: SPX_INDEX_CODE, validFrom: T1, validTo: null },
    ]);
  });

  it('closes membership (valid_to=now) for members absent from the fetched list', async () => {
    // Seed a pre-existing member the way an earlier sync would have.
    const oldId = newId();
    await db.insert(instruments).values({
      id: oldId,
      symbol: 'ZZOLD',
      assetClass: 'us_equity',
      cik: '0000000442',
      name: 'Zeta Old Corp',
    });
    await db.insert(indexMembership).values({
      instrumentId: oldId,
      indexCode: SPX_INDEX_CODE,
      validFrom: T1,
    });

    const counts = await syncUniverse(db, deps([row('ZZTA', 'Zeta Alpha Corp', '0000000011')], T2));
    expect(counts.membersAdded).toBe(1);
    expect(counts.membersClosed).toBe(1);

    // The row is CLOSED, never deleted — point-in-time history survives.
    expect(await membershipsOf(oldId)).toEqual([
      { instrumentId: oldId, indexCode: SPX_INDEX_CODE, validFrom: T1, validTo: T2 },
    ]);
    // The instrument row survives too (survivorship guard).
    expect((await instrumentBySymbol('ZZOLD', 'us_equity')).name).toBe('Zeta Old Corp');

    // Idempotency of the close: a re-run must not close it twice or re-add it.
    const rerun = await syncUniverse(db, deps([row('ZZTA', 'Zeta Alpha Corp', '0000000011')], T2));
    expect(rerun.membersClosed).toBe(0);
    expect(await membershipsOf(oldId)).toHaveLength(1);
  });

  it('rejects a CIK change on an existing symbol instead of silently merging identities', async () => {
    await syncUniverse(db, deps([row('ZZTA', 'Zeta Alpha Corp', '0000000011')], T1));
    // Same ticker, different company (ticker reuse): must throw, not overwrite.
    await expect(
      syncUniverse(db, deps([row('ZZTA', 'Completely New Corp', '0000000777')], T2)),
    ).rejects.toThrow(/CIK change/);
    // Transaction rolled back: the original identity is untouched.
    const zeta = await instrumentBySymbol('ZZTA', 'us_equity');
    expect(zeta.cik).toBe('0000000011');
    expect(zeta.name).toBe('Zeta Alpha Corp');
  });

  it('closes and inserts only the aliases that actually changed on a rename', async () => {
    await syncUniverse(db, deps([row('ZZTA', 'Zeta Alpha Corp', '0000000011')], T1));

    const renamed = await syncUniverse(
      db,
      deps([row('ZZTA', 'Zeta Alpha Holdings Inc.', '0000000011')], T2),
    );
    // Both old name-kind aliases close; both new ones open. Ticker/cashtag/cik untouched.
    expect(renamed.aliasesClosed).toBe(2);
    expect(renamed.aliasesInserted).toBe(2);

    const zeta = await instrumentBySymbol('ZZTA', 'us_equity');
    const byAlias = (await aliasesOf(zeta.id)).map(({ alias, aliasKind, validFrom, validTo }) => ({
      alias,
      aliasKind,
      validFrom,
      validTo,
    }));
    expect(byAlias).toEqual([
      // Unchanged rows keep their ORIGINAL valid_from and stay open.
      { alias: '$ZZTA', aliasKind: 'cashtag', validFrom: T1, validTo: null },
      { alias: '0000000011', aliasKind: 'cik', validFrom: T1, validTo: null },
      // Old names are closed at T2, preserving the dictionary as-of T1.
      { alias: 'Zeta Alpha', aliasKind: 'name', validFrom: T1, validTo: T2 },
      { alias: 'Zeta Alpha Corp', aliasKind: 'name', validFrom: T1, validTo: T2 },
      // New names open at T2.
      { alias: 'Zeta Alpha Holdings', aliasKind: 'name', validFrom: T2, validTo: null },
      { alias: 'Zeta Alpha Holdings Inc.', aliasKind: 'name', validFrom: T2, validTo: null },
      { alias: 'ZZTA', aliasKind: 'ticker', validFrom: T1, validTo: null },
    ]);

    // The instrument row reflects the new name (upsert refreshes attributes).
    expect(zeta.name).toBe('Zeta Alpha Holdings Inc.');
  });
});

// ------------------------------------------------------------------ helpers --

/**
 * Create (if missing) the suite's dedicated database next to the shared
 * TEST_DATABASE_URL one and return its URL. Idempotent across runs; mirrors
 * clustering-repo.test.ts (<dbname>_clustering_repo) and e2e.test.ts.
 */
async function createSuiteDatabase(adminUrl: string): Promise<string> {
  const parsed = new URL(adminUrl);
  const baseName = parsed.pathname.replace(/^\//, '') || 'postgres';
  const suiteName = `${baseName}_universe_sync`.replace(/[^a-zA-Z0-9_]/g, '_');

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
