/**
 * DB-backed calendar tests — require a live Postgres and are skipped when
 * TEST_DATABASE_URL is unset.
 *
 * Run:
 *   docker compose up -d postgres
 *   TEST_DATABASE_URL=postgres://newstrader:newstrader@localhost:5433/newstrader \
 *     pnpm vitest run packages/db/src/calendar
 *
 * Isolation: the suite creates and migrates its OWN database
 * (<dbname>_calendar) and never touches the shared TEST_DATABASE_URL database
 * (per-suite-database pattern from resolver/resolve-repo.test.ts). The suite
 * still cleans its rows so the reused suite DB stays empty; scheduled_events
 * is wiped wholesale because ONLY this suite writes to this suite's database.
 */
import { newId } from '@newstrader/core';
import { inArray } from 'drizzle-orm';
import { migrate } from 'drizzle-orm/node-postgres/migrator';
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';

import { createDb, type Db } from '../client.js';
import { indexMembership, instruments, scheduledEvents } from '../schema.js';
import { SPX_INDEX_CODE } from '../universe/sync.js';
import { loadScheduledEventWindow, syncCalendar, type SyncCalendarDeps } from './calendar-repo.js';
import type { EarningsCalendarEntry } from './finnhub-earnings.js';
import { isScheduledEvent } from './match.js';
import type { MacroEvent, MacroEventKind } from './macro.js';

const testDatabaseUrl = process.env.TEST_DATABASE_URL;

/** Fictional symbols so seeds never collide with other suites' instruments. */
const TEST_SYMBOLS = ['ZAPH', 'QMEG', 'KRMX.B'];

/** Fictional far-future clock keeps every generated event key suite-local. */
const T_NOW = new Date('2031-06-15T12:00:00.000Z');
const daysAfter = (n: number) => new Date(T_NOW.getTime() + n * 86_400_000);
const hoursAfter = (n: number) => new Date(T_NOW.getTime() + n * 3_600_000);

const MEMBER_SINCE = new Date('2030-01-01T00:00:00.000Z');

const macroEvent = (kind: MacroEventKind, scheduledAt: Date): MacroEvent => ({
  kind,
  scheduledAt,
  meta: { fixture: true },
});

const earningsEntry = (symbol: string, scheduledAt: Date): EarningsCalendarEntry => ({
  symbol,
  scheduledAt,
  meta: { date: scheduledAt.toISOString().slice(0, 10), hour: 'bmo' },
});

describe.skipIf(!testDatabaseUrl)('calendar repo (integration)', () => {
  let db: Db;
  let zaphId: string;
  let qmegId: string;
  let krmxId: string;

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
    zaphId = await seedInstrument('ZAPH', 'Zaphod Industries');
    qmegId = await seedInstrument('QMEG', 'Quantum Megacorp');
    krmxId = await seedInstrument('KRMX.B', 'Kramerica Class B');
    await db.insert(indexMembership).values([
      // ZAPH and KRMX.B are current members; QMEG left the index (closed row).
      { instrumentId: zaphId, indexCode: SPX_INDEX_CODE, validFrom: MEMBER_SINCE },
      { instrumentId: krmxId, indexCode: SPX_INDEX_CODE, validFrom: MEMBER_SINCE },
      {
        instrumentId: qmegId,
        indexCode: SPX_INDEX_CODE,
        validFrom: MEMBER_SINCE,
        validTo: new Date('2030-06-01T00:00:00.000Z'),
      },
    ]);
  });

  async function cleanupTestRows(): Promise<void> {
    await db.delete(scheduledEvents); // suite-exclusive database; see header
    const rows = await db
      .select({ id: instruments.id })
      .from(instruments)
      .where(inArray(instruments.symbol, TEST_SYMBOLS));
    const ids = rows.map((row) => row.id);
    if (ids.length > 0) {
      await db.delete(indexMembership).where(inArray(indexMembership.instrumentId, ids));
      await db.delete(instruments).where(inArray(instruments.id, ids));
    }
  }

  async function seedInstrument(symbol: string, name: string): Promise<string> {
    const id = newId();
    await db.insert(instruments).values({ id, symbol, assetClass: 'us_equity', name });
    return id;
  }

  function baseDeps(overrides?: Partial<SyncCalendarDeps>): SyncCalendarDeps {
    return {
      fetchFomc: async () => [],
      fetchCpi: async () => [],
      fetchNfp: async () => [],
      fetchBea: async () => [],
      fetchEarnings: null,
      now: () => T_NOW,
      ...overrides,
    };
  }

  it('syncs every source, maps earnings symbols through current membership, and is idempotent', async () => {
    let capturedRange: { from: string; to: string } | undefined;
    const deps = baseDeps({
      fetchFomc: async () => [macroEvent('fomc', daysAfter(10))],
      fetchCpi: async () => [macroEvent('cpi', daysAfter(5))],
      fetchNfp: async () => [macroEvent('nfp', daysAfter(6))],
      fetchBea: async () => [macroEvent('gdp', daysAfter(7)), macroEvent('pce', daysAfter(8))],
      fetchEarnings: async (range) => {
        capturedRange = range;
        return [
          earningsEntry('ZAPH', daysAfter(3)),
          earningsEntry('KRMX-B', daysAfter(4)), // dash form must map to KRMX.B
          earningsEntry('QMEG', daysAfter(2)), // closed membership → skipped
          earningsEntry('UNKN', daysAfter(2)), // not in the universe → skipped
        ];
      },
    });

    const counts = await syncCalendar(db, deps);
    expect(counts).toEqual({
      inserted: { fomc: 1, cpi: 1, nfp: 1, gdp: 1, pce: 1, earnings: 2 },
      duplicates: 0,
      outsideWindow: 0,
      earningsSymbolsSkipped: 2,
    });
    // The earnings request window derives from the injected clock + horizon.
    expect(capturedRange).toEqual({ from: '2031-06-15', to: '2031-09-13' });

    const rows = await db.select().from(scheduledEvents);
    expect(rows).toHaveLength(7);

    const zaphRow = rows.find((row) => row.instrumentId === zaphId);
    expect(zaphRow?.kind).toBe('earnings');
    expect(zaphRow?.source).toBe('finnhub');
    expect(zaphRow?.eventKey).toBe(`earnings:ZAPH:${daysAfter(3).toISOString()}`);

    // Dash-form symbol landed on the dot-form instrument, keyed normalized.
    const krmxRow = rows.find((row) => row.instrumentId === krmxId);
    expect(krmxRow?.eventKey).toBe(`earnings:KRMX.B:${daysAfter(4).toISOString()}`);

    const cpiRow = rows.find((row) => row.kind === 'cpi');
    expect(cpiRow?.instrumentId).toBeNull();
    expect(cpiRow?.source).toBe('bls.gov');
    expect(cpiRow?.eventKey).toBe(`cpi:macro:${daysAfter(5).toISOString()}`);
    expect(rows.some((row) => row.instrumentId === qmegId)).toBe(false);

    // Re-run: every event_key already exists → nothing inserted (DO NOTHING).
    const again = await syncCalendar(db, deps);
    expect(again.inserted).toEqual({ fomc: 0, cpi: 0, nfp: 0, gdp: 0, pce: 0, earnings: 0 });
    expect(again.duplicates).toBe(7);
    expect(await db.select().from(scheduledEvents)).toHaveLength(7);
  });

  it('upserts only events inside [now − 1 day, now + horizonDays]', async () => {
    const counts = await syncCalendar(
      db,
      baseDeps({
        fetchFomc: async () => [
          macroEvent('fomc', daysAfter(-2)), // too far past
          macroEvent('fomc', daysAfter(91)), // beyond the default horizon
          macroEvent('fomc', hoursAfter(-2)), // inside the past grace → kept
        ],
      }),
    );
    expect(counts.inserted.fomc).toBe(1);
    expect(counts.outsideWindow).toBe(2);

    const narrow = await syncCalendar(
      db,
      baseDeps({ fetchCpi: async () => [macroEvent('cpi', daysAfter(40))] }),
      { horizonDays: 30 },
    );
    expect(narrow.inserted.cpi).toBe(0);
    expect(narrow.outsideWindow).toBe(1);
  });

  it('collapses intra-batch duplicate event keys before hitting the DB', async () => {
    const at = daysAfter(5);
    const counts = await syncCalendar(
      db,
      baseDeps({ fetchCpi: async () => [macroEvent('cpi', at), macroEvent('cpi', at)] }),
    );
    expect(counts.inserted.cpi).toBe(1);
    expect(counts.duplicates).toBe(1);
  });

  it('skips the earnings source with a warning when it is disabled (no FINNHUB_API_KEY)', async () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    try {
      const counts = await syncCalendar(
        db,
        baseDeps({ fetchCpi: async () => [macroEvent('cpi', daysAfter(5))] }),
      );
      expect(counts.inserted).toEqual({ fomc: 0, cpi: 1, nfp: 0, gdp: 0, pce: 0, earnings: 0 });
      expect(warn).toHaveBeenCalledWith(expect.stringContaining('calendar_sync_earnings_skipped'));
    } finally {
      warn.mockRestore();
    }
  });

  it('loadScheduledEventWindow prefetches ONE window that feeds the pure matcher', async () => {
    const cpiAt = daysAfter(5);
    const earningsAt = new Date(daysAfter(5).getTime() + 2 * 3_600_000);
    await syncCalendar(
      db,
      baseDeps({
        fetchCpi: async () => [macroEvent('cpi', cpiAt)],
        fetchFomc: async () => [macroEvent('fomc', daysAfter(20))], // outside the query window
        fetchEarnings: async () => [earningsEntry('ZAPH', earningsAt)],
      }),
    );

    const window = await loadScheduledEventWindow(db, { from: daysAfter(4), to: daysAfter(6) });
    expect(window).toHaveLength(2);

    // Macro CPI matches ANY instrument's probe...
    expect(
      isScheduledEvent(window, { at: cpiAt, toleranceMinutes: 30, instrumentId: qmegId }),
    ).toBe(true);
    // ...earnings match only THEIR instrument.
    expect(
      isScheduledEvent(window, { at: earningsAt, toleranceMinutes: 30, instrumentId: zaphId }),
    ).toBe(true);
    expect(
      isScheduledEvent(window, { at: earningsAt, toleranceMinutes: 30, instrumentId: qmegId }),
    ).toBe(false);
    // The FOMC event at +20d was excluded by the window, so it can never match.
    expect(
      isScheduledEvent(window, { at: daysAfter(20), toleranceMinutes: 60, instrumentId: zaphId }),
    ).toBe(false);
  });
});

// ------------------------------------------------------------------ helpers --

/**
 * Create (if missing) the suite's dedicated database next to the shared
 * TEST_DATABASE_URL one and return its URL. Idempotent across runs; mirrors
 * resolver/resolve-repo.test.ts / clustering-repo.test.ts / sync.test.ts.
 */
async function createSuiteDatabase(adminUrl: string): Promise<string> {
  const parsed = new URL(adminUrl);
  const baseName = parsed.pathname.replace(/^\//, '') || 'postgres';
  const suiteName = `${baseName}_calendar`.replace(/[^a-zA-Z0-9_]/g, '_');

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
