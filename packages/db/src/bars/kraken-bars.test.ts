import { readFileSync } from 'node:fs';

import { describe, expect, it } from 'vitest';

import type { FetchLike } from './http.js';
import { fetchKrakenOhlc, KRAKEN_PAIRS, parseKrakenOhlc } from './kraken-bars.js';

/**
 * Fixtures are REAL trimmed captures of https://api.kraken.com/0/public/OHLC
 * (2026-07-11): kraken-ohlc-1m.json = pair=XBTUSD&interval=1 (first 3 rows +
 * the final committed row + the in-progress row, real `last`);
 * kraken-ohlc-1d.json = pair=SOLUSD&interval=1440, same trim. Note the result
 * keys: XBTUSD answers under "XXBTZUSD", SOLUSD under "SOLUSD".
 */
const loadFixture = (name: string): unknown =>
  JSON.parse(readFileSync(new URL(`./__fixtures__/${name}`, import.meta.url), 'utf8'));

const minuteFixture = loadFixture('kraken-ohlc-1m.json');
const dailyFixture = loadFixture('kraken-ohlc-1d.json');

describe('parseKrakenOhlc', () => {
  it("parses committed minute candles under Kraken's renamed pair key, prices verbatim", () => {
    const bars = parseKrakenOhlc(minuteFixture, 1);
    // Fixture has 5 rows; the trailing one (time > last) is the in-progress candle.
    expect(bars).toHaveLength(4);
    expect(bars[0]).toEqual({
      ts: new Date(1783748400 * 1000),
      open: '64157.6',
      high: '64157.6',
      low: '64135.3',
      close: '64135.3',
      volume: '0.05757425',
    });
  });

  it('drops the in-progress candle: DO-NOTHING upserts would freeze a partial bar forever', () => {
    const bars = parseKrakenOhlc(minuteFixture, 1);
    const last = 1783791540; // real `last` marker from the capture
    expect(bars[bars.length - 1]?.ts.getTime()).toBe(last * 1000);
    expect(bars.some((b) => b.ts.getTime() > last * 1000)).toBe(false);
  });

  it('parses daily candles at UTC midnight', () => {
    const bars = parseKrakenOhlc(dailyFixture, 1440);
    expect(bars.length).toBeGreaterThan(0);
    for (const bar of bars) {
      expect(bar.ts.getTime() % 86_400_000).toBe(0);
    }
    expect(bars[0]?.ts.toISOString()).toBe('2024-07-21T00:00:00.000Z');
  });

  it('throws on a Kraken error array instead of returning empty data', () => {
    expect(() => parseKrakenOhlc({ error: ['EQuery:Unknown asset pair'] }, 1)).toThrow(
      /Unknown asset pair/,
    );
  });

  it('throws when the result does not contain exactly one pair key', () => {
    expect(() => parseKrakenOhlc({ error: [], result: { last: 1 } }, 1)).toThrow(
      /expected exactly 1/,
    );
    expect(() => parseKrakenOhlc({ error: [], result: { A: [], B: [], last: 1 } }, 1)).toThrow(
      /expected exactly 1/,
    );
  });

  it('throws on tuple shape drift (numbers where strings belong, short rows)', () => {
    expect(() =>
      parseKrakenOhlc(
        { error: [], result: { XXBTZUSD: [[60, 1, 2, 3, 4, 5, 6, 7]], last: 120 } },
        1,
      ),
    ).toThrow();
    expect(() =>
      parseKrakenOhlc({ error: [], result: { XXBTZUSD: [[60, '1', '2']], last: 120 } }, 1),
    ).toThrow();
    expect(() =>
      parseKrakenOhlc({ error: [], result: { XXBTZUSD: 'nope', last: 1 } }, 1),
    ).toThrow();
    expect(() => parseKrakenOhlc(null, 1)).toThrow();
  });

  it('throws on candle times misaligned to the interval', () => {
    const row = [61, '1.0', '1.0', '1.0', '1.0', '1.0', '0.5', 3];
    expect(() => parseKrakenOhlc({ error: [], result: { XXBTZUSD: [row], last: 120 } }, 1)).toThrow(
      /not aligned/,
    );
  });

  it('throws when the last marker is missing or malformed', () => {
    expect(() => parseKrakenOhlc({ error: [], result: { XXBTZUSD: [] } }, 1)).toThrow();
  });
});

describe('fetchKrakenOhlc', () => {
  it('maps universe symbols to Kraken pair names in the query', async () => {
    expect(KRAKEN_PAIRS).toEqual({ BTC: 'XBTUSD', ETH: 'ETHUSD', SOL: 'SOLUSD' });

    let captured: string | undefined;
    const stub: FetchLike = async (url) => {
      captured = url;
      return new Response(JSON.stringify(minuteFixture), { status: 200 });
    };
    const bars = await fetchKrakenOhlc({ fetchImpl: stub }, { symbol: 'BTC', interval: 1 });
    expect(bars).toHaveLength(4);
    expect(captured).toBe('https://api.kraken.com/0/public/OHLC?pair=XBTUSD&interval=1');
  });

  it('threads since and daily interval through', async () => {
    let captured: string | undefined;
    const stub: FetchLike = async (url) => {
      captured = url;
      return new Response(JSON.stringify(dailyFixture), { status: 200 });
    };
    await fetchKrakenOhlc(
      { fetchImpl: stub },
      { symbol: 'SOL', interval: 1440, since: 1721520000 },
    );
    expect(captured).toBe(
      'https://api.kraken.com/0/public/OHLC?pair=SOLUSD&interval=1440&since=1721520000',
    );
  });

  it('surfaces non-2xx as a descriptive error', async () => {
    const stub: FetchLike = async () =>
      new Response('slow down', { status: 429, statusText: 'Too Many Requests' });
    await expect(
      fetchKrakenOhlc({ fetchImpl: stub }, { symbol: 'ETH', interval: 1 }),
    ).rejects.toThrow(/429/);
  });
});
