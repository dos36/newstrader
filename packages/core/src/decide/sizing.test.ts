import { describe, expect, it } from 'vitest';

import type { RulesConfig } from '../trading/contracts.js';

import { sizePosition, type SizingInput } from './sizing.js';

const sizingConfig = (over: Partial<RulesConfig['sizing']> = {}): RulesConfig['sizing'] => ({
  riskBpsOfEquity: 50,
  atrLookbackDays: 14,
  atrStopMultiple: 2,
  maxPositionNotionalPct: 0.1,
  ...over,
});

const input = (over: Partial<SizingInput> = {}): SizingInput => ({
  assetClass: 'us_equity',
  atr: '2.00000000',
  paperEquityUsd: '100000.00',
  price: '50.000000',
  sizing: sizingConfig(),
  ...over,
});

describe('sizePosition — core math', () => {
  it('sizes the baseline case exactly: risk 500 / stop 4 = 125 shares, notional 6250', () => {
    const result = sizePosition(input());
    expect(result).toEqual({
      sized: true,
      qty: '125',
      notional: '6250',
      gates: [
        { gate: 'atr_available', pass: true, observed: '2.00000000', threshold: null },
        { gate: 'position_too_small', pass: true, observed: '125', threshold: '0' },
      ],
    });
  });

  it('floors us_equity qty to whole shares', () => {
    // risk 500 / stop 6 = 83.3333… → 83.
    const result = sizePosition(input({ atr: '3.00000000' }));
    expect(result.sized && result.qty).toBe('83');
    expect(result.sized && result.notional).toBe('4150');
  });

  it('floors crypto qty at 8 decimal places, not whole units', () => {
    const result = sizePosition(input({ assetClass: 'crypto', atr: '3.00000000' }));
    expect(result.sized && result.qty).toBe('83.33333333');
  });

  it('has no float drift: 0.3 / 0.1 sizes to exactly 3, not 2.99999999', () => {
    // Float math: 0.3/0.1 = 2.9999999999999996 → would floor to 2.99999999 at 8 dp.
    const result = sizePosition(
      input({
        assetClass: 'crypto',
        paperEquityUsd: '0.30',
        atr: '0.05000000', // stop = 2 × 0.05 = 0.1
        price: '0.100000',
        sizing: sizingConfig({ riskBpsOfEquity: 10_000, maxPositionNotionalPct: 1 }),
      }),
    );
    expect(result.sized && result.qty).toBe('3');
    expect(result.sized && result.notional).toBe('0.3');
  });
});

describe('sizePosition — notional cap', () => {
  it('recomputes qty from the cap when the notional cap binds', () => {
    // risk 2000 / stop 2 = 1000 shares → 50,000 notional > 10,000 cap → 200 shares.
    const result = sizePosition(
      input({ atr: '1.00000000', sizing: sizingConfig({ riskBpsOfEquity: 200 }) }),
    );
    expect(result.sized && result.qty).toBe('200');
    expect(result.sized && result.notional).toBe('10000');
  });

  it('re-floors the cap-derived qty (capped notional stays under the cap)', () => {
    // cap 10,000 / price 33.333333 = 300.0000003 → floor 300 shares → 9,999.9999 notional.
    const result = sizePosition(
      input({
        atr: '1.00000000',
        price: '33.333333',
        sizing: sizingConfig({ riskBpsOfEquity: 200 }),
      }),
    );
    expect(result.sized && result.qty).toBe('300');
    expect(result.sized && result.notional).toBe('9999.9999');
  });

  it('does not touch qty when the notional is exactly AT the cap (strict >)', () => {
    // risk 500 / stop 2.5 = 200 shares × 50 = 10,000 = cap exactly.
    const result = sizePosition(input({ atr: '1.25000000' }));
    expect(result.sized && result.qty).toBe('200');
    expect(result.sized && result.notional).toBe('10000');
  });
});

describe('sizePosition — skip gates', () => {
  it('null ATR fails atr_available and stops before the position gate', () => {
    const result = sizePosition(input({ atr: null }));
    expect(result).toEqual({
      sized: false,
      skipReason: 'atr_available',
      gates: [{ gate: 'atr_available', pass: false, observed: null, threshold: null }],
    });
  });

  it('zero ATR fails atr_available (stop distance would be zero → division blowup)', () => {
    const result = sizePosition(input({ atr: '0' }));
    expect(result.sized).toBe(false);
    expect(!result.sized && result.skipReason).toBe('atr_available');
  });

  it('an ATR so small the stop distance truncates to zero fails atr_available', () => {
    // 2 × 0.00000001 = 0.00000002 > 0 fine; use multiple 0.1 → 0.000000001 → truncates to 0.
    const result = sizePosition(
      input({ atr: '0.00000001', sizing: sizingConfig({ atrStopMultiple: 0.1 }) }),
    );
    expect(!result.sized && result.skipReason).toBe('atr_available');
  });

  it('qty flooring to zero fails position_too_small (equities)', () => {
    // risk 5 / stop 10 = 0.5 shares → floor 0.
    const result = sizePosition(input({ paperEquityUsd: '1000.00', atr: '5.00000000' }));
    expect(result.sized).toBe(false);
    expect(!result.sized && result.skipReason).toBe('position_too_small');
    expect(result.gates).toEqual([
      { gate: 'atr_available', pass: true, observed: '5.00000000', threshold: null },
      { gate: 'position_too_small', pass: false, observed: '0', threshold: '0' },
    ]);
  });

  it('the same sub-share budget SIZES for crypto (fractional qty is legal)', () => {
    const result = sizePosition(
      input({
        assetClass: 'crypto',
        paperEquityUsd: '1000.00',
        atr: '5.00000000',
        price: '10.000000',
      }),
    );
    expect(result.sized && result.qty).toBe('0.5');
    expect(result.sized && result.notional).toBe('5');
  });
});

describe('sizePosition — corrupt input is loud, not a gate', () => {
  it('throws on a non-positive quote price', () => {
    expect(() => sizePosition(input({ price: '0' }))).toThrow(/positive quote price/);
  });

  it('throws on a malformed decimal string', () => {
    expect(() => sizePosition(input({ paperEquityUsd: 'lots' }))).toThrow(/invalid/);
  });
});
