import { describe, expect, it } from 'vitest';
import {
  ONE,
  ZERO,
  absDec,
  add,
  cmp,
  divRound,
  formatDec,
  isZero,
  mul,
  neg,
  numberToDec,
  parseDec,
  roundTo,
  sub,
} from './decimal.js';

const dec = (s: string) => parseDec(s);
const fmt = (s: string) => formatDec(parseDec(s));

describe('parseDec / formatDec', () => {
  it('round-trips canonical decimal strings', () => {
    for (const s of ['0', '1', '-1', '100.05', '-0.000001', '123456789.12345678']) {
      expect(fmt(s)).toBe(s);
    }
  });

  it('trims trailing fraction zeros and never emits "-0"', () => {
    expect(fmt('1.500000')).toBe('1.5');
    expect(fmt('100.000000')).toBe('100');
    expect(formatDec({ units: 0n, scale: 6 })).toBe('0');
    expect(formatDec(neg({ units: 0n, scale: 6 }))).toBe('0');
  });

  it('parses exactly (units/scale)', () => {
    expect(dec('100.05')).toEqual({ units: 10_005n, scale: 2 });
    expect(dec('-0.0005')).toEqual({ units: -5n, scale: 4 });
    expect(dec('42')).toEqual({ units: 42n, scale: 0 });
  });

  it('rejects non-decimal strings', () => {
    for (const bad of ['', 'abc', '1e5', '1E-7', '.5', '1.', '+1', '1,000', 'NaN', 'Infinity']) {
      expect(() => parseDec(bad)).toThrow(/invalid decimal string/);
    }
  });
});

describe('numberToDec', () => {
  it('converts plain config numbers exactly', () => {
    expect(numberToDec(5)).toEqual({ units: 5n, scale: 0 });
    expect(numberToDec(0.26)).toEqual({ units: 26n, scale: 2 });
    expect(numberToDec(-2.5)).toEqual({ units: -25n, scale: 1 });
  });

  it('rejects non-finite and exponent-notation values', () => {
    expect(() => numberToDec(Number.NaN)).toThrow(/non-finite/);
    expect(() => numberToDec(Number.POSITIVE_INFINITY)).toThrow(/non-finite/);
    expect(() => numberToDec(1e-7)).toThrow(/exponent/);
    expect(() => numberToDec(1e21)).toThrow(/exponent/);
  });
});

describe('exact arithmetic', () => {
  it('adds and subtracts across scales exactly', () => {
    expect(formatDec(add(dec('0.1'), dec('0.2')))).toBe('0.3');
    expect(formatDec(sub(dec('1'), dec('0.000001')))).toBe('0.999999');
    expect(formatDec(add(dec('-1.5'), dec('1.5')))).toBe('0');
  });

  it('multiplies exactly (scales add)', () => {
    expect(formatDec(mul(dec('100.05'), dec('0.0005')))).toBe('0.050025');
    expect(formatDec(mul(dec('-3'), dec('2.5')))).toBe('-7.5');
    expect(mul(dec('1.11'), dec('2.222')).scale).toBe(5);
  });

  it('compares numerically across scales', () => {
    expect(cmp(dec('1.50'), dec('1.5'))).toBe(0);
    expect(cmp(dec('-2'), dec('1'))).toBe(-1);
    expect(cmp(dec('0.000001'), ZERO)).toBe(1);
    expect(isZero(sub(ONE, ONE))).toBe(true);
    expect(formatDec(absDec(dec('-4.2')))).toBe('4.2');
  });
});

describe('roundTo (half-away-from-zero)', () => {
  it('rounds ties away from zero in both signs', () => {
    expect(formatDec(roundTo(dec('1.5'), 0))).toBe('2');
    expect(formatDec(roundTo(dec('-1.5'), 0))).toBe('-2');
    expect(formatDec(roundTo(dec('0.0000005'), 6))).toBe('0.000001');
    expect(formatDec(roundTo(dec('-0.0000005'), 6))).toBe('-0.000001');
  });

  it('rounds non-ties to nearest', () => {
    expect(formatDec(roundTo(dec('0.1235177280'), 6))).toBe('0.123518');
    expect(formatDec(roundTo(dec('0.12345674'), 7))).toBe('0.1234567');
  });

  it('is exact when widening the scale', () => {
    expect(roundTo(dec('1.5'), 3)).toEqual({ units: 1_500n, scale: 3 });
  });

  it('rejects invalid scales', () => {
    expect(() => roundTo(ONE, -1)).toThrow(/invalid decimal scale/);
    expect(() => roundTo(ONE, 1.5)).toThrow(/invalid decimal scale/);
  });
});

describe('divRound', () => {
  it('divides with half-away-from-zero rounding at the requested scale', () => {
    expect(formatDec(divRound(dec('32'), dec('3'), 8))).toBe('10.66666667');
    expect(formatDec(divRound(dec('-32'), dec('3'), 8))).toBe('-10.66666667');
    expect(formatDec(divRound(dec('1'), dec('8'), 2))).toBe('0.13'); // 0.125 → away
  });

  it('is exact when the quotient terminates within the scale', () => {
    expect(formatDec(divRound(dec('10.05'), dec('2'), 6))).toBe('5.025');
  });

  it('throws on division by zero', () => {
    expect(() => divRound(ONE, ZERO, 2)).toThrow(/division by zero/);
  });
});
