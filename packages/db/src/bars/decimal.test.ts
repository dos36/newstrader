import { describe, expect, it } from 'vitest';

import { toDecimalString, toPriceString, toVolumeString } from './decimal.js';

describe('toDecimalString', () => {
  it('passes plain floats through verbatim when they fit the scale', () => {
    expect(toPriceString(313.26)).toBe('313.26');
    expect(toPriceString(20.5105)).toBe('20.5105');
    expect(toPriceString(680)).toBe('680');
    expect(toPriceString(0.396)).toBe('0.396');
  });

  it('rounds values beyond the column scale instead of overflowing it', () => {
    // Real capture: aggs volume 34003.363193 has 6 dp; the volume column is numeric(20,4).
    expect(toVolumeString(34003.363193)).toBe('34003.3632');
    expect(toVolumeString(13414.006698)).toBe('13414.0067');
    expect(toDecimalString(1.9999999, 4)).toBe('2');
  });

  it('expands exponent notation instead of persisting "1e-7"', () => {
    expect(toDecimalString(1e-7, 6)).toBe('0');
    expect(toDecimalString(1.5e-6, 6)).toBe('0.000002');
  });

  it('trims trailing zeros after rounding', () => {
    expect(toDecimalString(1.100000049, 6)).toBe('1.1');
  });

  it('throws on non-finite input — never persists NaN/Infinity', () => {
    expect(() => toPriceString(Number.NaN)).toThrow(/non-finite/);
    expect(() => toPriceString(Number.POSITIVE_INFINITY)).toThrow(/non-finite/);
  });

  it('throws when the integer part would overflow numeric(18,6)/(20,4) (12/16 integer digits)', () => {
    expect(() => toPriceString(1e11)).not.toThrow(); // 12 integer digits — fits exactly
    expect(() => toPriceString(1e12)).toThrow(/integer digits/); // 13 — overflow
    expect(() => toPriceString(-1e12)).toThrow(/integer digits/); // sign must not hide a digit
    expect(() => toVolumeString(1e15)).not.toThrow(); // 16 integer digits — fits exactly
    expect(() => toVolumeString(1e16)).toThrow(/integer digits/); // 17 — overflow
  });

  it('does not limit integer digits by default (bare toDecimalString calls are unaffected)', () => {
    expect(toDecimalString(1e12, 4)).toBe('1000000000000');
  });
});
