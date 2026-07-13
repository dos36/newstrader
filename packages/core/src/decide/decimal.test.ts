import { describe, expect, it } from 'vitest';

import {
  SCALE,
  divScaled,
  floorScaledTo,
  formatScaled,
  mulScaled,
  parseScaled,
  scaledFromNumber,
} from './decimal.js';

describe('parseScaled', () => {
  it('parses integers, fractions, and negatives at scale 1e8', () => {
    expect(parseScaled('1')).toBe(100_000_000n);
    expect(parseScaled('0.5')).toBe(50_000_000n);
    expect(parseScaled('125.25')).toBe(12_525_000_000n);
    expect(parseScaled('-2.25')).toBe(-225_000_000n);
    expect(parseScaled('0')).toBe(0n);
    expect(parseScaled('0.00000001')).toBe(1n);
  });

  it('round-trips with formatScaled', () => {
    for (const value of ['0', '1', '0.5', '83.33333333', '-2.25', '10000']) {
      expect(formatScaled(parseScaled(value))).toBe(value);
    }
  });

  it('throws on malformed strings — money format drift is never guessed at', () => {
    for (const bad of ['', 'abc', '1.2.3', '1e5', 'NaN', '1,000', '.5', '--1']) {
      expect(() => parseScaled(bad, 'test')).toThrow(/invalid test/);
    }
  });

  it('throws beyond 8 decimal places instead of silently rounding', () => {
    expect(() => parseScaled('1.123456789')).toThrow(/decimal places/);
  });
});

describe('scaledFromNumber', () => {
  it('converts config numbers exactly despite float representation', () => {
    expect(scaledFromNumber(0.1)).toBe(10_000_000n);
    expect(scaledFromNumber(2)).toBe(200_000_000n);
    expect(scaledFromNumber(50)).toBe(5_000_000_000n);
  });

  it('rejects non-finite values', () => {
    expect(() => scaledFromNumber(Number.NaN, 'x')).toThrow(/finite/);
    expect(() => scaledFromNumber(Number.POSITIVE_INFINITY, 'x')).toThrow(/finite/);
  });
});

describe('scaled arithmetic', () => {
  it('multiplies and divides at scale', () => {
    expect(mulScaled(parseScaled('2.5'), parseScaled('4'))).toBe(parseScaled('10'));
    expect(divScaled(parseScaled('10'), parseScaled('4'))).toBe(parseScaled('2.5'));
  });

  it('division truncates toward zero (conservative for sizes)', () => {
    // 1 / 3 = 0.33333333(3…) → truncated at 8 dp.
    expect(formatScaled(divScaled(parseScaled('1'), parseScaled('3')))).toBe('0.33333333');
  });

  it('multiplication of sub-quantum values truncates to zero', () => {
    expect(mulScaled(1n, 1n)).toBe(0n);
  });
});

describe('floorScaledTo', () => {
  it('floors to whole units and to intermediate precisions', () => {
    expect(floorScaledTo(parseScaled('83.9999'), 0)).toBe(parseScaled('83'));
    expect(floorScaledTo(parseScaled('83.339999'), 2)).toBe(parseScaled('83.33'));
    expect(floorScaledTo(parseScaled('83.33333333'), 8)).toBe(parseScaled('83.33333333'));
  });

  it('rejects out-of-range precision', () => {
    expect(() => floorScaledTo(SCALE, 9)).toThrow(/decimals/);
    expect(() => floorScaledTo(SCALE, -1)).toThrow(/decimals/);
  });
});

describe('formatScaled', () => {
  it('emits canonical strings: no trailing zeros, no trailing dot, no exponent', () => {
    expect(formatScaled(parseScaled('125.00000000'))).toBe('125');
    expect(formatScaled(parseScaled('0.50000000'))).toBe('0.5');
    expect(formatScaled(0n)).toBe('0');
    expect(formatScaled(parseScaled('9999.9999'))).toBe('9999.9999');
  });
});
