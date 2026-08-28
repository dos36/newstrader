import { newId } from '@newstrader/core';
import { and, eq, gte, isNull, lte } from 'drizzle-orm';

import type { Db } from '../client.js';
import { indexMembership, instruments, scheduledEvents } from '../schema.js';
import { SPX_INDEX_CODE } from '../universe/sync.js';
import {
  finnhubEarningsSource,
  type EarningsCalendarEntry,
  type EarningsDateRange,
} from './finnhub-earnings.js';
import type { FetchLike } from './http.js';
import {
  fetchBeaSchedule,
  fetchCpiSchedule,
  fetchFomcCalendar,
  fetchNfpSchedule,
  type MacroEvent,
  type MacroEventKind,
} from './macro.js';
import type { ScheduledEventKind, ScheduledEventLite } from './match.js';

/**
 * Calendar sync — scheduled_events upserts feeding the `already_expected` /
 * `calendar_match` decision feature (architecture §6).
 *
 * One run fetches every source (macro pages + optional Finnhub earnings) and
 * upserts by the deterministic event_key
 * `${kind}:${symbol-or-'macro'}:${scheduledAt ISO}` with ON CONFLICT DO
 * NOTHING — re-running is a no-op, and a RESCHEDULED release simply adds a row
 * under the new time (the old row stays; the tolerance matcher may match
 * either, which is the honest reading of "this was on the calendar").
 *
 * Window discipline: only events inside [now − 1 day, now + horizonDays] are
 * upserted. The macro pages list years of history; the calendar table is a
 * forward-looking feature input, not an archive (raw pages are re-fetchable).
 *
 * The one deliberate exception is backfill mode (backfillFromDay): it widens
 * the window into the past to recover "was this scheduled?" ground truth for
 * analytics over an already-collected news window. Every row older than the
 * normal 1-day grace is stamped meta.backfilled=true — those rows were NOT in
 * the table at decide time, so M5 analytics must never read them as knowledge
 * the live path had. Finnhub's free tier serves only ~30 days of earnings
 * history (verified live 2026-08-09: day 31 returns zero), so the log reports
 * earningsServedFrom against what was requested.
 *
 * Earnings symbols map to instruments through the CURRENT S&P 500 membership
 * (open index_membership rows); non-members are counted and skipped. This is
 * deliberately as-of-now, not point-in-time: the calendar describes the
 * future, where current membership is the best available universe.
 */

const DAY_MS = 24 * 60 * 60 * 1000;

/** Events already up to `past grace` in the past still upsert (same-day boot). */
const PAST_GRACE_MS = DAY_MS;

export const DEFAULT_HORIZON_DAYS = 90;

export interface SyncCalendarDeps {
  fetchFomc: () => Promise<MacroEvent[]>;
  fetchCpi: () => Promise<MacroEvent[]>;
  fetchNfp: () => Promise<MacroEvent[]>;
  fetchBea: () => Promise<MacroEvent[]>;
  /** null = source disabled (no FINNHUB_API_KEY); the sync logs the skip. */
  fetchEarnings: ((range: EarningsDateRange) => Promise<EarningsCalendarEntry[]>) | null;
  /** Injectable clock (tests). Anchors the horizon window. */
  now?: () => Date;
}

export interface SyncCalendarCounts {
  /** Rows actually inserted, per kind. */
  inserted: Record<ScheduledEventKind, number>;
  /** Candidate rows skipped because their event_key already existed (or repeated in-batch). */
  duplicates: number;
  /** Fetched events outside [now − grace, now + horizon]. */
  outsideWindow: number;
  /** Earnings releases whose symbol is not a current S&P 500 member. */
  earningsSymbolsSkipped: number;
}

export interface SyncCalendarOptions {
  horizonDays?: number;
  /**
   * ISO day (UTC, YYYY-MM-DD), at or before today. Widens the upsert window
   * back to this day and fetches earnings from it — see the module docstring's
   * backfill-mode paragraph for the provenance rules (meta.backfilled).
   */
  backfillFromDay?: string;
}

export async function syncCalendar(
  db: Db,
  deps: SyncCalendarDeps,
  options?: SyncCalendarOptions,
): Promise<SyncCalendarCounts> {
  const horizonDays = options?.horizonDays ?? DEFAULT_HORIZON_DAYS;
  const now = (deps.now ?? (() => new Date()))();
  const graceFrom = new Date(now.getTime() - PAST_GRACE_MS);
  const backfillFrom = parseBackfillFrom(options?.backfillFromDay, now);
  const windowFrom =
    backfillFrom !== null && backfillFrom.getTime() < graceFrom.getTime()
      ? backfillFrom
      : graceFrom;
  const windowTo = new Date(now.getTime() + horizonDays * DAY_MS);

  const earningsRange: EarningsDateRange = {
    from: isoDay(backfillFrom ?? now),
    to: isoDay(windowTo),
  };
  if (deps.fetchEarnings === null) {
    console.warn(
      JSON.stringify({
        level: 'warn',
        msg: 'calendar_sync_earnings_skipped',
        reason: 'FINNHUB_API_KEY unset',
      }),
    );
  }

  const [fomc, cpi, nfp, bea, earnings] = await Promise.all([
    deps.fetchFomc(),
    deps.fetchCpi(),
    deps.fetchNfp(),
    deps.fetchBea(),
    deps.fetchEarnings === null ? Promise.resolve([]) : deps.fetchEarnings(earningsRange),
  ]);

  const inserted: Record<ScheduledEventKind, number> = {
    fomc: 0,
    cpi: 0,
    nfp: 0,
    gdp: 0,
    pce: 0,
    earnings: 0,
  };
  let outsideWindow = 0;
  let earningsSymbolsSkipped = 0;

  type CandidateRow = typeof scheduledEvents.$inferInsert;
  const candidates = new Map<string, CandidateRow>(); // keyed by event_key (intra-batch dedup)
  let duplicates = 0;
  let backfilledCandidates = 0;

  const addCandidate = (row: CandidateRow): void => {
    if (row.scheduledAt < windowFrom || row.scheduledAt > windowTo) {
      outsideWindow += 1;
      return;
    }
    if (candidates.has(row.eventKey)) {
      duplicates += 1;
      return;
    }
    if (row.scheduledAt < graceFrom) {
      // Reachable only in backfill mode (windowFrom < graceFrom): recorded
      // after the fact, so flagged — never pre-event knowledge (docstring).
      backfilledCandidates += 1;
      candidates.set(row.eventKey, { ...row, meta: { ...row.meta, backfilled: true } });
      return;
    }
    candidates.set(row.eventKey, row);
  };

  for (const event of [...fomc, ...cpi, ...nfp, ...bea]) {
    addCandidate({
      id: newId(),
      eventKey: macroEventKey(event.kind, event.scheduledAt),
      kind: event.kind,
      instrumentId: null,
      scheduledAt: event.scheduledAt,
      source: MACRO_SOURCE[event.kind],
      meta: event.meta,
    });
  }

  if (earnings.length > 0) {
    const bySymbol = await loadSpxSymbolMap(db);
    for (const entry of earnings) {
      const instrumentId = bySymbol.get(normalizeSymbol(entry.symbol));
      if (instrumentId === undefined) {
        earningsSymbolsSkipped += 1;
        continue;
      }
      addCandidate({
        id: newId(),
        eventKey: earningsEventKey(entry.symbol, entry.scheduledAt),
        kind: 'earnings',
        instrumentId,
        scheduledAt: entry.scheduledAt,
        source: 'finnhub',
        meta: entry.meta,
      });
    }
  }

  const rows = [...candidates.values()];
  for (const chunk of chunks(rows, 500)) {
    const returned = await db
      .insert(scheduledEvents)
      .values(chunk)
      .onConflictDoNothing({ target: scheduledEvents.eventKey })
      .returning({ kind: scheduledEvents.kind });
    for (const row of returned) {
      inserted[row.kind] += 1;
    }
    duplicates += chunk.length - returned.length;
  }

  const counts: SyncCalendarCounts = {
    inserted,
    duplicates,
    outsideWindow,
    earningsSymbolsSkipped,
  };
  // Backfill observability: Finnhub's free tier silently serves nothing past
  // ~30 days back, so a requested-vs-served gap must be loud, not invisible.
  let earliestEarningsDay: string | null = null;
  for (const entry of earnings) {
    const day = isoDay(entry.scheduledAt);
    if (earliestEarningsDay === null || day < earliestEarningsDay) earliestEarningsDay = day;
  }
  const backfillLog =
    backfillFrom === null
      ? {}
      : {
          backfillFrom: isoDay(backfillFrom),
          backfilledCandidates,
          earningsServedFrom: earliestEarningsDay,
        };
  console.log(
    JSON.stringify({
      level: 'info',
      msg: 'calendar_sync',
      horizonDays,
      windowFrom: windowFrom.toISOString(),
      windowTo: windowTo.toISOString(),
      ...backfillLog,
      ...counts,
    }),
  );
  return counts;
}

/**
 * Default deps for a live sync, mirroring allAdapters in packages/adapters:
 * a missing FINNHUB_API_KEY disables the earnings source with a warning at
 * sync time instead of throwing, so a partial .env still syncs the free macro
 * calendars. The contact User-Agent reuses EDGAR_USER_AGENT ("Name email") —
 * same courtesy header the SEC/Wikipedia fetchers send.
 */
export function defaultCalendarDeps(
  env: Record<string, string | undefined> = process.env,
  fetchImpl?: FetchLike,
): SyncCalendarDeps {
  const fetchOptions = {
    userAgent: env['EDGAR_USER_AGENT'],
    ...(fetchImpl !== undefined ? { fetchImpl } : {}),
  };

  let fetchEarnings: SyncCalendarDeps['fetchEarnings'] = null;
  if (env['FINNHUB_API_KEY']?.trim()) {
    const source = finnhubEarningsSource(env, fetchImpl);
    fetchEarnings = (range) => source.fetchEarnings(range);
  }

  return {
    fetchFomc: () => fetchFomcCalendar(fetchOptions),
    fetchCpi: () => fetchCpiSchedule(fetchOptions),
    fetchNfp: () => fetchNfpSchedule(fetchOptions),
    fetchBea: () => fetchBeaSchedule(fetchOptions),
    fetchEarnings,
  };
}

// ------------------------------------------------- calendar_match DB wrapper --

export interface ScheduledEventWindow {
  /** Inclusive UTC bounds. */
  from: Date;
  to: Date;
}

/**
 * Prefetch every scheduled event in one window for the pure isScheduledEvent
 * matcher (match.js). The decide() path calls this ONCE per batch — window =
 * [min probe at − tolerance, max probe at + tolerance] — then probes the list
 * per item; it must never query per item.
 */
export async function loadScheduledEventWindow(
  db: Db,
  window: ScheduledEventWindow,
): Promise<ScheduledEventLite[]> {
  return db
    .select({
      kind: scheduledEvents.kind,
      instrumentId: scheduledEvents.instrumentId,
      scheduledAt: scheduledEvents.scheduledAt,
    })
    .from(scheduledEvents)
    .where(
      and(
        gte(scheduledEvents.scheduledAt, window.from),
        lte(scheduledEvents.scheduledAt, window.to),
      ),
    );
}

// ---------------------------------------------------------------- internals --

const MACRO_SOURCE: Record<MacroEventKind, string> = {
  fomc: 'federalreserve.gov',
  cpi: 'bls.gov',
  nfp: 'bls.gov',
  gdp: 'bea.gov',
  pce: 'bea.gov',
};

function macroEventKey(kind: MacroEventKind, scheduledAt: Date): string {
  return `${kind}:macro:${scheduledAt.toISOString()}`;
}

function earningsEventKey(symbol: string, scheduledAt: Date): string {
  return `earnings:${normalizeSymbol(symbol)}:${scheduledAt.toISOString()}`;
}

const ISO_DAY_RE = /^\d{4}-\d{2}-\d{2}$/;

/** Backfill start: ISO day → UTC midnight. Rejects malformed and future days. */
function parseBackfillFrom(day: string | undefined, now: Date): Date | null {
  if (day === undefined) return null;
  if (!ISO_DAY_RE.test(day)) {
    throw new Error(`backfillFromDay must be YYYY-MM-DD, got "${day}"`);
  }
  const at = new Date(`${day}T00:00:00.000Z`);
  if (Number.isNaN(at.getTime()) || at.getTime() > now.getTime()) {
    throw new Error(`backfillFromDay must be a real day at or before today, got "${day}"`);
  }
  return at;
}

/**
 * Uppercase, dash→dot (BRK-B → BRK.B): instruments store Wikipedia's dot form,
 * Finnhub also prints dots, but tolerate the SEC-style dash form.
 */
function normalizeSymbol(symbol: string): string {
  return symbol.toUpperCase().replace(/-/g, '.');
}

/** Current S&P 500 members: normalized symbol → instrument id. */
async function loadSpxSymbolMap(db: Db): Promise<Map<string, string>> {
  const members = await db
    .select({ id: instruments.id, symbol: instruments.symbol })
    .from(instruments)
    .innerJoin(indexMembership, eq(indexMembership.instrumentId, instruments.id))
    .where(and(eq(indexMembership.indexCode, SPX_INDEX_CODE), isNull(indexMembership.validTo)));
  return new Map(members.map((m) => [normalizeSymbol(m.symbol), m.id]));
}

function isoDay(at: Date): string {
  return at.toISOString().slice(0, 10);
}

function* chunks<T>(items: T[], size: number): Generator<T[]> {
  for (let i = 0; i < items.length; i += size) {
    yield items.slice(i, i + size);
  }
}
