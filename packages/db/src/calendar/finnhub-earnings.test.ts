import { readFileSync } from 'node:fs';

import { describe, expect, it } from 'vitest';

import { FinnhubEarningsSource, finnhubEarningsSource } from './finnhub-earnings.js';
import type { FetchLike } from './http.js';

/**
 * Fixture = Finnhub's OWN sample response for GET /api/v1/calendar/earnings,
 * verbatim from the official docs/OpenAPI definition (finnhub.io/docs/api/
 * earnings-calendar, captured 2026-07-11). No FINNHUB_API_KEY exists in this
 * environment, so a live capture was not possible — the docs sample is the
 * authoritative shape. Hour-convention variants beyond the sample's "amc" are
 * exercised with synthetic mutations of the same shape.
 */
const fixture: unknown = JSON.parse(
  readFileSync(new URL('./__fixtures__/finnhub-earnings.json', import.meta.url), 'utf8'),
);

const source = () => new FinnhubEarningsSource({ apiKey: 'test-key' });

const release = (overrides: Record<string, unknown>): unknown => ({
  earningsCalendar: [
    { date: '2026-01-13', symbol: 'ZAPH', epsEstimate: 1.5, quarter: 4, year: 2025, ...overrides },
  ],
});

describe('FinnhubEarningsSource constructor', () => {
  it('throws without FINNHUB_API_KEY (optionality lives in the deps factory, not here)', () => {
    expect(() => new FinnhubEarningsSource({ apiKey: undefined })).toThrow(/FINNHUB_API_KEY/);
    expect(() => new FinnhubEarningsSource({ apiKey: '  ' })).toThrow(/FINNHUB_API_KEY/);
    expect(() => finnhubEarningsSource({})).toThrow(/FINNHUB_API_KEY/);
  });
});

describe('parseResponse', () => {
  it('parses the docs sample; amc → 16:30 ET, DST-correct', () => {
    const entries = source().parseResponse(fixture);
    expect(entries).toHaveLength(2);
    // 2020-01-28 = EST: 16:30 ET → 21:30Z.
    expect(entries[0]?.symbol).toBe('AAPL');
    expect(entries[0]?.scheduledAt.toISOString()).toBe('2020-01-28T21:30:00.000Z');
    // 2019-10-30 = EDT (DST ended Nov 3 2019): 16:30 ET → 20:30Z.
    expect(entries[1]?.scheduledAt.toISOString()).toBe('2019-10-30T20:30:00.000Z');
    expect(entries[0]?.meta).toMatchObject({
      date: '2020-01-28',
      hour: 'amc',
      fiscalYear: 2020,
      fiscalQuarter: 1,
      epsEstimate: 4.5474,
      revenueEstimate: 88496400810,
    });
  });

  it('maps bmo / dmh / missing hour per the documented ET convention', () => {
    // 2026-01-13 is EST (UTC-5).
    const bmo = source().parseResponse(release({ hour: 'bmo' }));
    expect(bmo[0]?.scheduledAt.toISOString()).toBe('2026-01-13T13:30:00.000Z'); // 08:30 ET
    const dmh = source().parseResponse(release({ hour: 'dmh' }));
    expect(dmh[0]?.scheduledAt.toISOString()).toBe('2026-01-13T17:00:00.000Z'); // 12:00 ET
    const missing = source().parseResponse(release({}));
    expect(missing[0]?.scheduledAt.toISOString()).toBe('2026-01-13T21:30:00.000Z'); // assumed amc
    expect(missing[0]?.meta['hour']).toBe('');
    // Summer bmo: 2026-07-15 is EDT.
    const summer = source().parseResponse(release({ hour: 'bmo', date: '2026-07-15' }));
    expect(summer[0]?.scheduledAt.toISOString()).toBe('2026-07-15T12:30:00.000Z');
  });

  it('throws on an unrecognized hour value (format drift)', () => {
    expect(() => source().parseResponse(release({ hour: 'midnight' }))).toThrow(
      /unrecognized hour "midnight"/,
    );
  });

  it('throws on envelope/shape drift', () => {
    expect(() => source().parseResponse({ results: [] })).toThrow();
    expect(() => source().parseResponse(release({ date: '01/13/2026' }))).toThrow();
  });
});

describe('fetchEarnings', () => {
  const fixtureResponse = () =>
    new Response(JSON.stringify(fixture), {
      status: 200,
      headers: { 'content-type': 'application/json' },
    });

  it('sends the key as the X-Finnhub-Token header on EVERY chunk — NEVER as a URL param', async () => {
    const captured: Array<{ url: string; init?: RequestInit | undefined }> = [];
    const stub: FetchLike = async (url, init) => {
      captured.push({ url, init });
      return fixtureResponse();
    };
    const src = new FinnhubEarningsSource({ apiKey: 'sekret-key', fetchImpl: stub });
    // 15 inclusive days = two CHUNK_DAYS(14) chunks: [07-11..07-24] + [07-25].
    const entries = await src.fetchEarnings({ from: '2026-07-11', to: '2026-07-25' });
    expect(entries).toHaveLength(4); // fixture's 2 entries served for each chunk

    expect(captured).toHaveLength(2);
    const first = new URL(captured[0]?.url ?? '');
    expect(first.pathname).toBe('/api/v1/calendar/earnings');
    expect(first.searchParams.get('from')).toBe('2026-07-11');
    expect(first.searchParams.get('to')).toBe('2026-07-24');
    const second = new URL(captured[1]?.url ?? '');
    expect(second.searchParams.get('from')).toBe('2026-07-25');
    expect(second.searchParams.get('to')).toBe('2026-07-25');
    for (const call of captured) {
      expect(call.url).not.toContain('sekret-key');
      expect(new Headers(call.init?.headers).get('x-finnhub-token')).toBe('sekret-key');
    }
  });

  it('halves any chunk that comes back at the silent 1,500-entry cap', async () => {
    const capped = {
      earningsCalendar: Array.from({ length: 1500 }, (_, i) => ({
        date: '2026-07-15',
        symbol: `S${i}`,
        hour: 'amc',
      })),
    };
    const ranges: string[] = [];
    const stub: FetchLike = async (url) => {
      const parsed = new URL(url);
      const from = parsed.searchParams.get('from') ?? '';
      const to = parsed.searchParams.get('to') ?? '';
      ranges.push(`${from}..${to}`);
      const widthDays =
        (Date.parse(`${to}T00:00:00Z`) - Date.parse(`${from}T00:00:00Z`)) / 86_400_000 + 1;
      return widthDays > 7
        ? new Response(JSON.stringify(capped), { status: 200 })
        : fixtureResponse();
    };
    const src = new FinnhubEarningsSource({ apiKey: 'k', fetchImpl: stub });
    // One 14-day chunk; the full-width call caps, both 7-day halves succeed.
    const entries = await src.fetchEarnings({ from: '2026-07-11', to: '2026-07-24' });
    expect(ranges).toEqual([
      '2026-07-11..2026-07-24',
      '2026-07-11..2026-07-17',
      '2026-07-18..2026-07-24',
    ]);
    expect(entries).toHaveLength(4);
  });

  it('refuses silent data loss when a SINGLE DAY hits the cap', async () => {
    const capped = {
      earningsCalendar: Array.from({ length: 1500 }, (_, i) => ({
        date: '2026-07-15',
        symbol: `S${i}`,
        hour: 'amc',
      })),
    };
    const stub: FetchLike = async () => new Response(JSON.stringify(capped), { status: 200 });
    const src = new FinnhubEarningsSource({ apiKey: 'k', fetchImpl: stub });
    await expect(src.fetchEarnings({ from: '2026-07-15', to: '2026-07-15' })).rejects.toThrow(
      /cannot subdivide/,
    );
  });

  it('rejects a malformed date range before any network call', async () => {
    let calls = 0;
    const stub: FetchLike = async () => {
      calls += 1;
      return fixtureResponse();
    };
    const src = new FinnhubEarningsSource({ apiKey: 'k', fetchImpl: stub });
    await expect(src.fetchEarnings({ from: '2026/07/11', to: '2026-10-09' })).rejects.toThrow(
      /YYYY-MM-DD/,
    );
    expect(calls).toBe(0);
  });

  it('throws on zero releases (a multi-week whole-market window is never empty)', async () => {
    const stub: FetchLike = async () =>
      new Response(JSON.stringify({ earningsCalendar: [] }), { status: 200 });
    const src = new FinnhubEarningsSource({ apiKey: 'k', fetchImpl: stub });
    await expect(src.fetchEarnings({ from: '2026-07-11', to: '2026-10-09' })).rejects.toThrow(
      /zero releases/,
    );
  });

  it('throws a descriptive error on non-2xx', async () => {
    const stub: FetchLike = async () =>
      new Response('slow down', { status: 429, statusText: 'Too Many Requests' });
    const src = new FinnhubEarningsSource({ apiKey: 'k', fetchImpl: stub });
    await expect(src.fetchEarnings({ from: '2026-07-11', to: '2026-10-09' })).rejects.toThrow(
      /429/,
    );
  });
});
