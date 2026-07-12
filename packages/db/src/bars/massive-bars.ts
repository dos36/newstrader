import { z } from 'zod';

import { toPriceString, toVolumeString } from './decimal.js';
import { defaultFetch, fetchJson, type FetchLike } from './http.js';

/**
 * Massive (ex-Polygon) bar clients — full-market snapshot + aggregates.
 *
 * Verified against https://massive.com/docs and the live API on 2026-07-11:
 *
 * - Snapshot: GET /v2/snapshot/locale/us/markets/stocks/tickers returns EVERY
 *   US ticker's latest state in one call ({ status, count, tickers: [{ ticker,
 *   min: { o,h,l,c,v,vw,av,n,t }, day, prevDay, … }] }); `min.t` is the minute
 *   bar's OPEN time in Unix millis. Requires Stocks Starter or higher;
 *   Starter/Developer data is 15-MINUTE DELAYED (docs) — fine for our
 *   hours-horizon batch analytics, and `source='massive_snapshot'` marks the
 *   rows so they are distinguishable from consolidated historical bars.
 *   LIVE CAVEAT (2026-07-11): the current MASSIVE_API_KEY gets
 *   status=NOT_AUTHORIZED from this endpoint (aggregates work) — i.e. the
 *   Starter subscription is not active on this key yet. The parser therefore
 *   accepts status OK|DELAYED and throws on anything else, so the recorder
 *   fails loudly instead of recording nothing.
 *
 * - Aggregates: GET /v2/aggs/ticker/{sym}/range/1/{minute|day}/{from}/{to}
 *   (?adjusted=true&sort=asc&limit=50000) — the historical pipe for
 *   event-window backfills and daily-bar maintenance. Verified live: results
 *   [{ o,h,l,c,v,vw,t,n }], `v` may be FRACTIONAL, minute `t` is
 *   minute-aligned millis, daily `t` is 04:00/05:00 UTC (midnight ET) so
 *   flooring to UTC midnight yields the trading date; `next_url` pages are
 *   followed with the same Bearer header. Starter has unlimited calls; callers
 *   still self-throttle to ~5 req/s (see bars-repo) out of politeness.
 *
 * Auth: the key travels ONLY as `Authorization: Bearer` — never a URL param
 * (precedent: packages/adapters/src/massive-news.ts; keeps secrets out of
 * URLs/logs).
 */

export const MASSIVE_DEFAULT_BASE_URL = 'https://api.polygon.io';

export const SOURCE_MASSIVE_SNAPSHOT = 'massive_snapshot';
export const SOURCE_MASSIVE_AGGS = 'massive_aggs';

const MINUTE_MS = 60_000;
const DAY_MS = 86_400_000;

/** One parsed bar; prices already decimal strings, `ts` = bar OPEN time (UTC). */
export interface ParsedBar {
  ts: Date;
  open: string;
  high: string;
  low: string;
  close: string;
  volume: string | null;
}

/** A parsed bar still keyed by vendor symbol (instrument resolution is the repo's job). */
export interface SymbolBar {
  symbol: string;
  bar: ParsedBar;
}

export interface MassiveBarsOptions {
  /** Value of env MASSIVE_API_KEY. Mandatory. */
  apiKey: string | undefined;
  /** Value of env MASSIVE_BASE_URL; api.polygon.io still serves during the rebrand. */
  baseUrl?: string | undefined;
  fetchImpl?: FetchLike;
}

// ------------------------------------------------------------- snapshot --

const SnapshotMinBar = z
  .object({
    o: z.number(),
    h: z.number(),
    l: z.number(),
    c: z.number(),
    v: z.number(),
    /** Minute-bar open time, Unix millis; 0 on tickers with no trade today. */
    t: z.number(),
  })
  .passthrough();

const SnapshotTicker = z
  .object({
    ticker: z.string().min(1),
    min: SnapshotMinBar.optional(),
  })
  .passthrough();

const SnapshotResponse = z
  .object({
    status: z.string(),
    tickers: z.array(SnapshotTicker),
  })
  .passthrough();

/**
 * Parse a full-market snapshot payload into the latest minute bar per symbol,
 * filtered to `symbols` (the point-in-time universe + benchmarks — one call
 * covers all ~500). Throws on shape drift or a non-OK/DELAYED status; SKIPS
 * (does not throw on) tickers with an absent or zeroed `min` bar — on a
 * full-market snapshot that is the normal "no trade yet today" state, not
 * format drift — AND a bar still `now`-forming (open time within the last
 * 60s, i.e. its close hasn't happened yet): the snapshot is a live read, so
 * that bar's OHLC can still change on the NEXT tick, and upserts are
 * ON CONFLICT DO NOTHING — persisting it now would freeze a partial minute
 * forever. Mirrors kraken-bars.ts dropping the in-progress candle.
 */
export function parseSnapshotMinuteBars(
  payload: unknown,
  symbols: ReadonlySet<string>,
  now: Date = new Date(),
): SymbolBar[] {
  const response = SnapshotResponse.parse(payload);
  if (response.status !== 'OK' && response.status !== 'DELAYED') {
    throw new Error(
      `Massive snapshot returned status "${response.status}" — ` +
        'NOT_AUTHORIZED means the plan lacks the snapshot entitlement (needs Stocks Starter+).',
    );
  }
  const nowMs = now.getTime();
  const out: SymbolBar[] = [];
  for (const entry of response.tickers) {
    if (!symbols.has(entry.ticker)) continue;
    const min = entry.min;
    if (min === undefined || min.t === 0) continue; // not traded yet today
    if (nowMs - min.t < MINUTE_MS) continue; // still forming — not yet closed
    out.push({ symbol: entry.ticker, bar: toParsedBar(min, 'minute') });
  }
  return out;
}

/**
 * Fetch the full-market snapshot (ONE call for the whole US market) and return
 * the latest minute bar for each requested symbol.
 */
export async function fetchSnapshotMinuteBars(
  options: MassiveBarsOptions,
  symbols: ReadonlySet<string>,
  now: Date = new Date(),
): Promise<SymbolBar[]> {
  const { apiKey, baseUrl, fetchImpl } = resolveOptions(options);
  const url = new URL('/v2/snapshot/locale/us/markets/stocks/tickers', baseUrl);
  const payload = await fetchJson(fetchImpl, url.toString(), authInit(apiKey));
  return parseSnapshotMinuteBars(payload, symbols, now);
}

// ----------------------------------------------------------- aggregates --

const AggsBar = z
  .object({
    o: z.number(),
    h: z.number(),
    l: z.number(),
    c: z.number(),
    /** Verified live: can be fractional (odd lots). Absent on some index aggs. */
    v: z.number().optional(),
    /** Bar open time, Unix millis. */
    t: z.number(),
  })
  .passthrough();

const AggsResponse = z
  .object({
    status: z.string(),
    ticker: z.string().optional(),
    results: z.array(AggsBar).optional(),
    resultsCount: z.number().optional(),
    next_url: z.string().optional(),
  })
  .passthrough();

export type AggsTimespan = 'minute' | 'day';

/**
 * Parse ONE aggregates page. Throws on shape drift or a non-OK/DELAYED status.
 * `results` may legitimately be absent (zero bars in range) — that parses to
 * an empty page, not an error.
 */
export function parseAggsPage(
  payload: unknown,
  timespan: AggsTimespan,
): { bars: ParsedBar[]; nextUrl?: string } {
  const response = AggsResponse.parse(payload);
  if (response.status !== 'OK' && response.status !== 'DELAYED') {
    throw new Error(`Massive aggregates returned status "${response.status}"`);
  }
  const bars = (response.results ?? []).map((bar) => toParsedBar(bar, timespan));
  return {
    bars,
    ...(response.next_url !== undefined ? { nextUrl: response.next_url } : {}),
  };
}

export interface FetchAggsParams {
  symbol: string;
  timespan: AggsTimespan;
  /** Inclusive range bounds (Massive accepts Unix millis in the path). */
  fromMs: number;
  toMs: number;
  /** Massive maximum is 50 000. */
  limit?: number;
  /** Safety cap on next_url pages followed per fetch. Default 10. */
  maxPages?: number;
}

/**
 * Fetch aggregate bars for one symbol/range, following next_url pagination
 * (each page re-sends the Bearer header). Throws if the page cap is hit with
 * more pages remaining — a silent truncation would leave an undetectable hole
 * in an event window; the caller should narrow the range instead.
 */
export async function fetchAggsBars(
  options: MassiveBarsOptions,
  params: FetchAggsParams,
): Promise<ParsedBar[]> {
  const { apiKey, baseUrl, fetchImpl } = resolveOptions(options);
  const limit = params.limit ?? 50_000;
  const maxPages = params.maxPages ?? 10;

  const firstUrl = new URL(
    `/v2/aggs/ticker/${encodeURIComponent(params.symbol)}/range/1/${params.timespan}` +
      `/${params.fromMs}/${params.toMs}`,
    baseUrl,
  );
  firstUrl.searchParams.set('adjusted', 'true');
  firstUrl.searchParams.set('sort', 'asc');
  firstUrl.searchParams.set('limit', String(limit));

  const bars: ParsedBar[] = [];
  let url: string | undefined = firstUrl.toString();
  let pages = 0;
  while (url !== undefined) {
    if (pages >= maxPages) {
      throw new Error(
        `Massive aggregates for ${params.symbol} exceeded ${maxPages} pages — ` +
          'refusing to return a silently truncated range; narrow the window.',
      );
    }
    const page = parseAggsPage(await fetchJson(fetchImpl, url, authInit(apiKey)), params.timespan);
    pages += 1;
    bars.push(...page.bars);
    // An empty page with a next_url would loop forever on a stalled cursor.
    url = page.bars.length > 0 ? page.nextUrl : undefined;
  }
  return bars;
}

// ------------------------------------------------------------ internals --

function resolveOptions(options: MassiveBarsOptions): {
  apiKey: string;
  baseUrl: string;
  fetchImpl: FetchLike;
} {
  const apiKey = options.apiKey?.trim();
  if (apiKey === undefined || apiKey.length === 0) {
    throw new Error('MASSIVE_API_KEY is not set — required for the Massive bars client.');
  }
  return {
    apiKey,
    baseUrl: options.baseUrl ?? MASSIVE_DEFAULT_BASE_URL,
    fetchImpl: options.fetchImpl ?? defaultFetch,
  };
}

function authInit(apiKey: string): RequestInit {
  return { headers: { Authorization: `Bearer ${apiKey}`, Accept: 'application/json' } };
}

/**
 * Vendor floats → decimal strings + timestamp normalization.
 * Minute bars: `t` must be minute-aligned (verified live) — drift throws.
 * Daily bars: `t` arrives at midnight ET (04:00/05:00 UTC, verified live);
 * flooring to UTC midnight yields the trading date the schema documents
 * ("Trading day, UTC midnight") because 04–05 h UTC is the same UTC calendar
 * day. A daily `t` in the back half of a UTC day would floor to the WRONG
 * date, so that throws instead.
 */
function toParsedBar(
  bar: { o: number; h: number; l: number; c: number; v?: number | undefined; t: number },
  timespan: AggsTimespan,
): ParsedBar {
  let ts: Date;
  if (timespan === 'minute') {
    if (bar.t % MINUTE_MS !== 0) {
      throw new Error(
        `Massive minute bar timestamp ${bar.t} is not minute-aligned — format drift?`,
      );
    }
    ts = new Date(bar.t);
  } else {
    const offset = bar.t % DAY_MS;
    if (offset >= DAY_MS / 2) {
      throw new Error(
        `Massive daily bar timestamp ${bar.t} is ${offset} ms past UTC midnight — ` +
          'flooring would mislabel the trading date; format drift?',
      );
    }
    ts = new Date(bar.t - offset);
  }
  return {
    ts,
    open: toPriceString(bar.o),
    high: toPriceString(bar.h),
    low: toPriceString(bar.l),
    close: toPriceString(bar.c),
    volume: bar.v === undefined ? null : toVolumeString(bar.v),
  };
}
