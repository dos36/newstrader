import { readFileSync } from 'node:fs';

import { describe, expect, it } from 'vitest';

import {
  fetchSp500FromWikipedia,
  MAX_EXPECTED_ROWS,
  MIN_EXPECTED_ROWS,
  parseSp500Wikitable,
  SP500_WIKIPEDIA_URL,
} from './wikipedia.js';
import type { FetchLike } from './http.js';

/**
 * Fixture = trimmed REAL markup from the live page (2026-07-10): the
 * id="constituents" wikitable header + 10 real rows, preceded by a real
 * <style> block that mentions ".wikitable" and followed by a fragment of the
 * page's SECOND wikitable (id="changes").
 */
const fixture = readFileSync(
  new URL('./__fixtures__/sp500-wikitable.html', import.meta.url),
  'utf8',
);

/** The 10 fixture rows can't satisfy production bounds; tests widen them explicitly. */
const testBounds = { minRows: 1, maxRows: 20 };

describe('parseSp500Wikitable', () => {
  it('parses every data row of the first wikitable and nothing from the second', () => {
    const rows = parseSp500Wikitable(fixture, testBounds);
    expect(rows).toHaveLength(10);
    // The trailing "changes" wikitable contains CAG / Conagra Brands — none of
    // it may leak into the parse.
    expect(rows.map((r) => r.symbol)).toEqual([
      'MMM',
      'AOS',
      'ABT',
      'ABBV',
      'GOOGL',
      'GOOG',
      'AMZN',
      'BRK.B',
      'BF.B',
      'KO',
    ]);
  });

  it('extracts symbol, security, sector, sub-industry, and zero-padded CIK', () => {
    const rows = parseSp500Wikitable(fixture, testBounds);
    const mmm = rows.find((r) => r.symbol === 'MMM');
    expect(mmm).toEqual({
      symbol: 'MMM',
      security: '3M',
      sector: 'Industrials',
      subIndustry: 'Industrial Conglomerates',
      cik: '0000066740',
    });
  });

  it('keeps class-share dots, share-class name suffixes, and decodes entities', () => {
    const rows = parseSp500Wikitable(fixture, testBounds);
    const bySymbol = new Map(rows.map((r) => [r.symbol, r]));

    // Wikipedia's dot form is preserved verbatim; the symbol cell also carries
    // an HTML comment ("DO NOT CHANGE THIS TICKER…") that must be stripped.
    expect(bySymbol.get('BRK.B')?.security).toBe('Berkshire Hathaway');
    expect(bySymbol.get('GOOGL')?.security).toBe('Alphabet Inc. (Class A)');
    expect(bySymbol.get('GOOG')?.security).toBe('Alphabet Inc. (Class C)');
    expect(bySymbol.get('KO')?.security).toBe('Coca-Cola Company (The)');
    // &amp; in the sub-industry cell decodes.
    expect(bySymbol.get('BF.B')?.subIndustry).toBe('Distillers & Vintners');
  });

  it('throws on a row count outside the sanity bounds (default production bounds)', () => {
    expect(MIN_EXPECTED_ROWS).toBe(400);
    expect(MAX_EXPECTED_ROWS).toBe(600);
    // The 10-row fixture must trip the drift guard under production bounds.
    expect(() => parseSp500Wikitable(fixture)).toThrow(/parsed 10 rows, expected 400–600/);
    expect(() => parseSp500Wikitable(fixture, { minRows: 1, maxRows: 9 })).toThrow(
      /parsed 10 rows/,
    );
  });

  it('throws when a required header column disappears', () => {
    const mutated = fixture.replace('>CIK</a>', '>Central Key</a>');
    expect(() => parseSp500Wikitable(mutated, testBounds)).toThrow(/header column "cik"/);
  });

  it('throws when the page contains no wikitable', () => {
    expect(() => parseSp500Wikitable('<html><body><p>moved</p></body></html>')).toThrow(
      /no <table/,
    );
    // The CSS mention of ".wikitable" alone must not be mistaken for a table.
    expect(() => parseSp500Wikitable('<style>.sticky:not(.wikitable){color:red}</style>')).toThrow(
      /no <table/,
    );
  });

  it('throws when a data row loses cells (format drift, not silent skip)', () => {
    // Drop the CIK + Founded cells from the MMM row.
    const mutated = fixture.replace('<td id="mwOw">0000066740</td><td id="mwPA">1902</td>', '');
    expect(() => parseSp500Wikitable(mutated, testBounds)).toThrow(/cells/);
  });
});

describe('fetchSp500FromWikipedia', () => {
  it('fetches the constituents URL and applies production bounds', async () => {
    let captured: { url?: string; init?: RequestInit | undefined } = {};
    const stub: FetchLike = async (url, init) => {
      captured = { url, init };
      return new Response(fixture, { status: 200 });
    };
    // 10 fixture rows < production minimum → the guard must throw.
    await expect(
      fetchSp500FromWikipedia({ fetchImpl: stub, userAgent: 'Test test@example.com' }),
    ).rejects.toThrow(/expected 400–600/);
    expect(captured.url).toBe(SP500_WIKIPEDIA_URL);
    expect(new Headers(captured.init?.headers).get('user-agent')).toBe('Test test@example.com');
  });

  it('throws a descriptive error on non-2xx', async () => {
    const stub: FetchLike = async () => new Response('nope', { status: 503, statusText: 'oops' });
    await expect(fetchSp500FromWikipedia({ fetchImpl: stub })).rejects.toThrow(/503/);
  });
});
