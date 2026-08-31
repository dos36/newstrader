import { describe, expect, it } from 'vitest';

import { CURATED_ETFS, ETF_INDEX_CODE, ETF_VALID_FROM } from './etfs.js';

/**
 * Pure-list guards. The DB seeding itself is a pair of ON CONFLICT inserts;
 * what actually breaks things is the LIST drifting — a duplicate symbol would
 * violate the instruments unique index mid-seed, a symbol colliding with an
 * S&P member would silently merge two different instruments' histories, and a
 * levered product would poison reaction measurement by construction.
 */
describe('curated ETF universe', () => {
  it('has unique, uppercase, plausible symbols', () => {
    const symbols = CURATED_ETFS.map((etf) => etf.symbol);
    expect(new Set(symbols).size).toBe(symbols.length);
    for (const symbol of symbols) {
      expect(symbol).toMatch(/^[A-Z]{2,5}$/);
    }
  });

  it('names every fund descriptively — the model picks from names', () => {
    for (const etf of CURATED_ETFS) {
      expect(etf.name.length).toBeGreaterThan(10);
      // Every entry must be identifiable as a fund from its name alone,
      // because the candidate line is all the model sees.
      expect(/ETF|Fund|Trust|Shares/i.test(etf.name)).toBe(true);
    }
  });

  it('contains no levered or inverse products', () => {
    for (const etf of CURATED_ETFS) {
      expect(/ultra|2x|3x|inverse|short|bear/i.test(etf.name)).toBe(false);
    }
  });

  it('covers each transmission-channel family the macro taxonomy names', () => {
    const symbols = new Set(CURATED_ETFS.map((etf) => etf.symbol));
    // One representative per family; the point is coverage, not the specific fund.
    expect(symbols.has('EWG')).toBe(true); // single-country equity
    expect(symbols.has('XLE')).toBe(true); // US sector
    expect(symbols.has('ITA')).toBe(true); // industry
    expect(symbols.has('GLD')).toBe(true); // commodity
    expect(symbols.has('TLT')).toBe(true); // rates
    expect(symbols.has('UUP')).toBe(true); // currency
  });

  it('pins the membership constants', () => {
    expect(ETF_INDEX_CODE).toBe('ETF_CORE');
    // Every listed fund existed before this date (youngest: XLC, 2018-06). A
    // later date would claim tradability the interval cannot honestly cover
    // for the 2026-07 backfill window; an earlier one would claim it for
    // funds that did not exist yet.
    expect(ETF_VALID_FROM.toISOString()).toBe('2020-01-01T00:00:00.000Z');
  });
});
