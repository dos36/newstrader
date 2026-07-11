import { describe, expect, it } from 'vitest';

import { CRYPTO_SEEDS, equityAliases, stripNameSuffixes } from './aliases.js';

describe('stripNameSuffixes', () => {
  const cases: Array<[input: string, expected: string]> = [
    // Task-specified examples.
    ['The Coca-Cola Company', 'Coca-Cola'],
    ['Alphabet Inc. (Class A)', 'Alphabet'],
    // Wikipedia's actual "(The)" convention (KO row on the live page).
    ['Coca-Cola Company (The)', 'Coca-Cola'],
    ['Gap, Inc. (The)', 'Gap'],
    // Every suffix in the strip list.
    ['Acme Inc', 'Acme'],
    ['Acme Inc.', 'Acme'],
    ['Acme Corp', 'Acme'],
    ['Acme Corp.', 'Acme'],
    ['RTX Corporation', 'RTX'],
    ['Tyson Foods Co', 'Tyson Foods'],
    ['McKesson Co.', 'McKesson'],
    ['The Walt Disney Company', 'Walt Disney'],
    ['Diageo Ltd', 'Diageo'],
    ['Linde plc', 'Linde'],
    ['Pentair PLC', 'Pentair'],
    ['Fox Corporation (Class B)', 'Fox'],
    ['Berkshire Hathaway Class B', 'Berkshire Hathaway'],
    // Trailing comma left behind by suffix stripping.
    ['Amazon.com, Inc.', 'Amazon.com'],
    ['Salesforce, Inc.', 'Salesforce'],
    // Chained suffixes strip iteratively.
    ['News Corp (Class A)', 'News'],
    // Names that must NOT change.
    ['3M', '3M'],
    ['A. O. Smith', 'A. O. Smith'],
    ['Brown–Forman', 'Brown–Forman'],
    ['Alphabet', 'Alphabet'],
    // ".com" must not be mistaken for a "Co" suffix (no separator before "com").
    ['Amazon.com', 'Amazon.com'],
    // "Subclass A" must not be mistaken for a share-class marker.
    ['Subclass A', 'Subclass A'],
    // Never strip to empty: a bare suffix word IS the name.
    ['Company', 'Company'],
    ['The Company', 'Company'],
  ];

  it.each(cases)('%j → %j', (input, expected) => {
    expect(stripNameSuffixes(input)).toBe(expected);
  });
});

describe('equityAliases', () => {
  it('emits ticker, cashtag, cik, full name, and the stripped variant', () => {
    const aliases = equityAliases({
      symbol: 'GOOGL',
      name: 'Alphabet Inc. (Class A)',
      cik: '0001652044',
    });
    expect(aliases).toEqual([
      { alias: 'GOOGL', aliasKind: 'ticker' },
      { alias: '$GOOGL', aliasKind: 'cashtag' },
      { alias: '0001652044', aliasKind: 'cik' },
      { alias: 'Alphabet Inc. (Class A)', aliasKind: 'name' },
      { alias: 'Alphabet', aliasKind: 'name' },
    ]);
  });

  it('omits the stripped variant when stripping changes nothing', () => {
    const aliases = equityAliases({ symbol: 'MMM', name: '3M', cik: '0000066740' });
    expect(aliases.filter((a) => a.aliasKind === 'name')).toEqual([
      { alias: '3M', aliasKind: 'name' },
    ]);
  });

  it('omits the cik alias when no CIK is known', () => {
    const aliases = equityAliases({ symbol: 'ZZZT', name: 'Test Co', cik: null });
    expect(aliases.some((a) => a.aliasKind === 'cik')).toBe(false);
    expect(aliases.some((a) => a.aliasKind === 'ticker')).toBe(true);
  });
});

describe('CRYPTO_SEEDS', () => {
  it('covers BTC/ETH/SOL with name, ticker, and cashtag aliases', () => {
    expect(CRYPTO_SEEDS.map((s) => s.symbol)).toEqual(['BTC', 'ETH', 'SOL']);
    for (const seed of CRYPTO_SEEDS) {
      expect(seed.exchange).toBeNull();
      expect(seed.aliases.some((a) => a.aliasKind === 'name')).toBe(true);
      expect(seed.aliases).toContainEqual({ alias: seed.symbol, aliasKind: 'ticker' });
      expect(seed.aliases).toContainEqual({ alias: `$${seed.symbol}`, aliasKind: 'cashtag' });
    }
    const eth = CRYPTO_SEEDS.find((s) => s.symbol === 'ETH');
    expect(eth?.aliases).toContainEqual({ alias: 'Ether', aliasKind: 'name' });
  });
});
