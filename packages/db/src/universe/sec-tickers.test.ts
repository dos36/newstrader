import { readFileSync } from 'node:fs';

import { describe, expect, it } from 'vitest';

import {
  fetchSecTickerMap,
  lookupSecTicker,
  parseSecTickers,
  SEC_COMPANY_TICKERS_URL,
} from './sec-tickers.js';
import type { FetchLike } from './http.js';

/** Trimmed REAL sample of https://www.sec.gov/files/company_tickers.json (2026-07-10). */
const fixture: unknown = JSON.parse(
  readFileSync(new URL('./__fixtures__/sec-company-tickers.json', import.meta.url), 'utf8'),
);

describe('parseSecTickers', () => {
  it('maps ticker → zero-padded CIK + title', () => {
    const map = parseSecTickers(fixture);
    expect(map.get('AAPL')).toEqual({ cik: '0000320193', title: 'Apple Inc.' });
    expect(map.get('MMM')).toEqual({ cik: '0000066740', title: '3M CO' });
    // Short CIKs pad to 10 digits.
    expect(map.get('ABT')?.cik).toBe('0000001800');
  });

  it('keeps multi-class listings under SEC dash-form tickers', () => {
    const map = parseSecTickers(fixture);
    expect(map.get('BRK-B')?.cik).toBe('0001067983');
    // GOOG and GOOGL both resolve to Alphabet's CIK.
    expect(map.get('GOOG')?.cik).toBe('0001652044');
    expect(map.get('GOOGL')?.cik).toBe('0001652044');
  });

  it('rejects shape drift instead of guessing', () => {
    expect(() => parseSecTickers([{ ticker: 'AAPL' }])).toThrow();
    expect(() =>
      parseSecTickers({ '0': { cik_str: 'not-a-number', ticker: 'X', title: 'X' } }),
    ).toThrow();
    expect(() => parseSecTickers(null)).toThrow();
  });
});

describe('lookupSecTicker', () => {
  it('resolves Wikipedia dot-form symbols against SEC dash-form tickers', () => {
    const map = parseSecTickers(fixture);
    expect(lookupSecTicker(map, 'BRK.B')?.cik).toBe('0001067983');
    expect(lookupSecTicker(map, 'BF.B')?.cik).toBe('0000014693');
    expect(lookupSecTicker(map, 'AAPL')?.cik).toBe('0000320193');
    expect(lookupSecTicker(map, 'ZZZZ')).toBeUndefined();
  });
});

describe('fetchSecTickerMap', () => {
  it('refuses to run without EDGAR_USER_AGENT (SEC 403s anonymous clients)', async () => {
    await expect(fetchSecTickerMap({ userAgent: undefined })).rejects.toThrow(/EDGAR_USER_AGENT/);
    await expect(fetchSecTickerMap({ userAgent: '   ' })).rejects.toThrow(/EDGAR_USER_AGENT/);
  });

  it('sends the User-Agent and parses the payload', async () => {
    let captured: { url?: string; init?: RequestInit | undefined } = {};
    const stub: FetchLike = async (url, init) => {
      captured = { url, init };
      return new Response(JSON.stringify(fixture), { status: 200 });
    };
    const map = await fetchSecTickerMap({
      userAgent: 'Test Person test@example.com',
      fetchImpl: stub,
    });
    expect(captured.url).toBe(SEC_COMPANY_TICKERS_URL);
    expect(new Headers(captured.init?.headers).get('user-agent')).toBe(
      'Test Person test@example.com',
    );
    expect(map.get('NVDA')?.cik).toBe('0001045810');
  });

  it('throws a descriptive error on non-2xx', async () => {
    const stub: FetchLike = async () =>
      new Response('denied', { status: 403, statusText: 'Forbidden' });
    await expect(
      fetchSecTickerMap({ userAgent: 'Test test@example.com', fetchImpl: stub }),
    ).rejects.toThrow(/403/);
  });
});
