import { readFileSync } from 'node:fs';

import { describe, expect, it } from 'vitest';

import type { FetchLike } from './http.js';
import {
  fetchAggsBars,
  fetchSnapshotMinuteBars,
  MASSIVE_DEFAULT_BASE_URL,
  parseAggsPage,
  parseSnapshotMinuteBars,
} from './massive-bars.js';

/**
 * Fixture provenance (2026-07-11):
 * - massive-aggs-1m.json / massive-aggs-1d.json are REAL captures
 *   (AAPL 1/minute 2026-07-09 limit=5; AAPL 1/day 2026-07-01..09).
 * - massive-snapshot.json is DOC-DERIVED (field-for-field from the example at
 *   https://massive.com/docs/rest/stocks/snapshots/full-market-snapshot):
 *   the live key answered status=NOT_AUTHORIZED — the Stocks Starter
 *   subscription is not active on it yet, so a real capture was impossible.
 *   Re-capture once Starter is live (tracked in the M3 verification gate).
 */
const loadFixture = (name: string): unknown =>
  JSON.parse(readFileSync(new URL(`./__fixtures__/${name}`, import.meta.url), 'utf8'));

const snapshotFixture = loadFixture('massive-snapshot.json');
const aggs1mFixture = loadFixture('massive-aggs-1m.json');
const aggs1dFixture = loadFixture('massive-aggs-1d.json');

const jsonResponse = (payload: unknown): Response =>
  new Response(JSON.stringify(payload), { status: 200 });

describe('parseSnapshotMinuteBars', () => {
  it('extracts the latest minute bar per requested symbol as decimal strings', () => {
    const bars = parseSnapshotMinuteBars(snapshotFixture, new Set(['AAPL', 'SPY']));
    expect(bars).toHaveLength(2);
    const aapl = bars.find((b) => b.symbol === 'AAPL');
    expect(aapl?.bar).toEqual({
      ts: new Date(1783584240000),
      open: '314.19',
      high: '314.39',
      low: '312.82',
      close: '312.85',
      volume: '13414.0067', // fractional volume rounded to the numeric(20,4) scale
    });
  });

  it('filters out tickers not in the requested universe (full-market reply)', () => {
    const bars = parseSnapshotMinuteBars(snapshotFixture, new Set(['AAPL']));
    expect(bars.map((b) => b.symbol)).toEqual(['AAPL']);
  });

  it('skips (not throws on) tickers with a zeroed min bar — "no trade yet today"', () => {
    const bars = parseSnapshotMinuteBars(snapshotFixture, new Set(['AAPL', 'MSFT', 'SPY']));
    expect(bars.map((b) => b.symbol).sort()).toEqual(['AAPL', 'SPY']);
  });

  it('accepts status DELAYED (Starter entitlement) but throws on NOT_AUTHORIZED', () => {
    expect(() =>
      parseSnapshotMinuteBars({ status: 'NOT_AUTHORIZED', tickers: [] }, new Set()),
    ).toThrow(/NOT_AUTHORIZED|status/);
  });

  it('throws on shape drift instead of syncing partial data', () => {
    expect(() => parseSnapshotMinuteBars({ status: 'OK' }, new Set())).toThrow();
    expect(() =>
      parseSnapshotMinuteBars(
        { status: 'OK', tickers: [{ ticker: 'AAPL', min: { o: 'not-a-number' } }] },
        new Set(['AAPL']),
      ),
    ).toThrow();
    expect(() => parseSnapshotMinuteBars(null, new Set())).toThrow();
  });

  it('throws on a non-minute-aligned min.t for a kept symbol', () => {
    const drift = {
      status: 'OK',
      tickers: [{ ticker: 'AAPL', min: { o: 1, h: 1, l: 1, c: 1, v: 1, t: 1783584240001 } }],
    };
    expect(() => parseSnapshotMinuteBars(drift, new Set(['AAPL']))).toThrow(/minute-aligned/);
  });

  it('drops a bar still forming (open < 60s ago) — mirrors Kraken dropping the in-progress candle', () => {
    // AAPL's min.t is 1783584240000; 30s later it hasn't closed yet.
    const stillForming = new Date(1783584240000 + 30_000);
    expect(parseSnapshotMinuteBars(snapshotFixture, new Set(['AAPL']), stillForming)).toEqual([]);

    // Exactly at the 60s boundary the bar has closed and is kept.
    const justClosed = new Date(1783584240000 + 60_000);
    const bars = parseSnapshotMinuteBars(snapshotFixture, new Set(['AAPL']), justClosed);
    expect(bars.map((b) => b.symbol)).toEqual(['AAPL']);
  });
});

describe('fetchSnapshotMinuteBars', () => {
  it('hits the snapshot route with Bearer auth (never a URL param) and no ticker list', async () => {
    let captured: { url?: string; init?: RequestInit | undefined } = {};
    const stub: FetchLike = async (url, init) => {
      captured = { url, init };
      return jsonResponse(snapshotFixture);
    };
    const bars = await fetchSnapshotMinuteBars(
      { apiKey: 'test-key', fetchImpl: stub },
      new Set(['SPY']),
    );
    expect(bars).toHaveLength(1);
    expect(captured.url).toBe(
      `${MASSIVE_DEFAULT_BASE_URL}/v2/snapshot/locale/us/markets/stocks/tickers`,
    );
    expect(captured.url).not.toContain('test-key');
    expect(new Headers(captured.init?.headers).get('authorization')).toBe('Bearer test-key');
  });

  it('refuses to run without an API key', async () => {
    await expect(fetchSnapshotMinuteBars({ apiKey: undefined }, new Set())).rejects.toThrow(
      /MASSIVE_API_KEY/,
    );
    await expect(fetchSnapshotMinuteBars({ apiKey: '  ' }, new Set())).rejects.toThrow(
      /MASSIVE_API_KEY/,
    );
  });
});

describe('parseAggsPage', () => {
  it('parses the real minute capture: aligned ts, decimal-string prices, fractional volume', () => {
    const page = parseAggsPage(aggs1mFixture, 'minute');
    expect(page.bars).toHaveLength(5);
    expect(page.bars[0]).toEqual({
      ts: new Date(1783584000000),
      open: '313.26',
      high: '314.96',
      low: '312.89',
      close: '312.9784',
      volume: '34003.3632',
    });
    // Real capture carries a next_url even at count == limit.
    expect(page.nextUrl).toContain('/v2/aggs/ticker/AAPL/');
  });

  it('floors real daily bars (04:00 UTC = midnight ET) to the UTC-midnight trading date', () => {
    const page = parseAggsPage(aggs1dFixture, 'day');
    expect(page.bars.map((b) => b.ts.toISOString())).toEqual([
      '2026-07-01T00:00:00.000Z',
      '2026-07-02T00:00:00.000Z',
      '2026-07-06T00:00:00.000Z',
      '2026-07-07T00:00:00.000Z',
      '2026-07-08T00:00:00.000Z',
      '2026-07-09T00:00:00.000Z',
    ]);
  });

  it('parses an empty range (no results key) as zero bars, not an error', () => {
    const page = parseAggsPage({ status: 'OK', resultsCount: 0 }, 'minute');
    expect(page.bars).toEqual([]);
    expect(page.nextUrl).toBeUndefined();
  });

  it('throws on a daily timestamp too far past UTC midnight to floor safely', () => {
    const noonUtc = Date.parse('2026-07-01T13:00:00Z');
    expect(() =>
      parseAggsPage(
        { status: 'OK', results: [{ o: 1, h: 1, l: 1, c: 1, v: 1, t: noonUtc }] },
        'day',
      ),
    ).toThrow(/mislabel/);
  });

  it('throws on error statuses and on shape drift', () => {
    expect(() => parseAggsPage({ status: 'ERROR', results: [] }, 'minute')).toThrow(/ERROR/);
    expect(() => parseAggsPage({ status: 'OK', results: [{ o: 1, h: 1 }] }, 'minute')).toThrow();
    expect(() => parseAggsPage('nope', 'minute')).toThrow();
  });
});

describe('fetchAggsBars', () => {
  const bar = (t: number) => ({ o: 1.5, h: 2, l: 1, c: 1.75, v: 100, t });

  it('builds the range URL and follows next_url with the Bearer header on every page', async () => {
    const calls: { url: string; auth: string | null }[] = [];
    const page2Url = 'https://api.polygon.io/v2/aggs/ticker/AAPL/cursor2';
    const stub: FetchLike = async (url, init) => {
      calls.push({ url, auth: new Headers(init?.headers).get('authorization') });
      if (calls.length === 1) {
        return jsonResponse({ status: 'OK', results: [bar(60_000)], next_url: page2Url });
      }
      return jsonResponse({ status: 'OK', results: [bar(120_000)] });
    };

    const bars = await fetchAggsBars(
      { apiKey: 'test-key', fetchImpl: stub },
      { symbol: 'AAPL', timespan: 'minute', fromMs: 0, toMs: 300_000 },
    );
    expect(bars.map((b) => b.ts.getTime())).toEqual([60_000, 120_000]);
    expect(calls[0]?.url).toBe(
      `${MASSIVE_DEFAULT_BASE_URL}/v2/aggs/ticker/AAPL/range/1/minute/0/300000` +
        '?adjusted=true&sort=asc&limit=50000',
    );
    expect(calls[1]?.url).toBe(page2Url);
    expect(calls.every((c) => c.auth === 'Bearer test-key')).toBe(true);
  });

  it('throws (never silently truncates) when the page cap is hit with pages remaining', async () => {
    const stub: FetchLike = async (url) =>
      jsonResponse({
        status: 'OK',
        // Distinct ts per page so the stall guard sees progress.
        results: [bar(60_000 * (url.length % 97))],
        next_url: `${url}x`,
      });
    await expect(
      fetchAggsBars(
        { apiKey: 'test-key', fetchImpl: stub },
        { symbol: 'AAPL', timespan: 'minute', fromMs: 0, toMs: 1, maxPages: 3 },
      ),
    ).rejects.toThrow(/3 pages/);
  });

  it('stops on an empty page even if a stalled next_url is present', async () => {
    let calls = 0;
    const stub: FetchLike = async () => {
      calls += 1;
      return jsonResponse({ status: 'OK', results: [], next_url: 'https://stalled.example' });
    };
    const bars = await fetchAggsBars(
      { apiKey: 'test-key', fetchImpl: stub },
      { symbol: 'AAPL', timespan: 'minute', fromMs: 0, toMs: 1 },
    );
    expect(bars).toEqual([]);
    expect(calls).toBe(1);
  });

  it('surfaces non-2xx as a descriptive error', async () => {
    const stub: FetchLike = async () =>
      new Response('denied', { status: 403, statusText: 'Forbidden' });
    await expect(
      fetchAggsBars(
        { apiKey: 'test-key', fetchImpl: stub },
        { symbol: 'AAPL', timespan: 'minute', fromMs: 0, toMs: 1 },
      ),
    ).rejects.toThrow(/403/);
  });
});
