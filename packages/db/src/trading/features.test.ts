import { describe, expect, it } from 'vitest';

import {
  DOLLAR_VOLUME_LOOKBACK_DAYS,
  MIN_DOLLAR_VOLUME_ROWS,
  medianDollarVolume,
  wilderAtr,
  type DailyRangeBar,
  type DailyVolumeBar,
} from './features.js';

const rangeBar = (high: number, low: number, close: number): DailyRangeBar => ({
  high: high.toFixed(6),
  low: low.toFixed(6),
  close: close.toFixed(6),
});

const volumeBar = (close: number, volume: number | null): DailyVolumeBar => ({
  close: close.toFixed(6),
  volume: volume === null ? null : volume.toFixed(4),
});

describe('wilderAtr', () => {
  it('matches the hand-computed seed SMA + Wilder smoothing (lookback 3, 5 bars)', () => {
    // Bars (high, low, close); previous closes: 10, 10.5, 10.2, 10.8.
    // TR1 = max(11−10.2, |11−10|, |10.2−10|)      = 1.0
    // TR2 = max(10.6−9.9, |10.6−10.5|, |9.9−10.5|) = 0.7
    // TR3 = max(11.2−10.7, |11.2−10.2|, |10.7−10.2|) = 1.0
    // seed ATR = (1.0 + 0.7 + 1.0) / 3 = 0.9
    // TR4 = max(11.5−10.9, |11.5−10.8|, |10.9−10.8|) = 0.7
    // ATR = (0.9 × 2 + 0.7) / 3 = 0.8333…
    const bars = [
      rangeBar(10.4, 9.8, 10.0),
      rangeBar(11.0, 10.2, 10.5),
      rangeBar(10.6, 9.9, 10.2),
      rangeBar(11.2, 10.7, 10.8),
      rangeBar(11.5, 10.9, 11.1),
    ];
    expect(wilderAtr(bars, 3)).toBeCloseTo(0.8333333333, 9);
  });

  it('with exactly lookback+1 bars the ATR is the plain TR average', () => {
    const bars = [rangeBar(10, 9, 9.5), rangeBar(10.5, 9.5, 10), rangeBar(11, 10, 10.5)];
    // TR1 = max(1.0, 1.0, 0) = 1.0 ; TR2 = max(1.0, 1.0, 0) = 1.0
    expect(wilderAtr(bars, 2)).toBeCloseTo(1.0, 9);
  });

  it('uses gap-driven true range when the day gaps past the prior close', () => {
    // Day 2 gaps up: high−low = 0.5 but |high−prevClose| = 2.5 dominates.
    const bars = [rangeBar(10, 9.5, 10), rangeBar(12.5, 12, 12.2)];
    expect(wilderAtr(bars, 1)).toBeCloseTo(2.5, 9);
  });

  it('returns null with fewer than lookback+1 bars', () => {
    const bars = [rangeBar(10, 9, 9.5), rangeBar(10.5, 9.5, 10)];
    expect(wilderAtr(bars, 2)).toBeNull();
    expect(wilderAtr([], 2)).toBeNull();
  });

  it('throws on a non-positive or fractional lookback', () => {
    const bars = [rangeBar(10, 9, 9.5), rangeBar(10.5, 9.5, 10)];
    expect(() => wilderAtr(bars, 0)).toThrow(/positive integer/);
    expect(() => wilderAtr(bars, 1.5)).toThrow(/positive integer/);
  });

  it('throws on a malformed decimal string instead of yielding NaN', () => {
    const bars = [rangeBar(10, 9, 9.5), { high: 'oops', low: '9.5', close: '10' }];
    expect(() => wilderAtr(bars, 1)).toThrow(/non-numeric/);
  });
});

describe('medianDollarVolume', () => {
  const closeAt = 10; // dollar volume = 10 × volume — easy to hand-compute

  it('odd count: the middle dollar volume', () => {
    // Volumes 1..11 → dollar volumes 10..110, median 60.
    const bars = Array.from({ length: 11 }, (_, i) => volumeBar(closeAt, (i + 1) * 1));
    expect(medianDollarVolume(bars)).toBeCloseTo(60, 9);
  });

  it('even count: averages the middle two', () => {
    // Volumes 1..10 → dollar volumes 10..100, median (50 + 60) / 2 = 55.
    const bars = Array.from({ length: 10 }, (_, i) => volumeBar(closeAt, i + 1));
    expect(medianDollarVolume(bars)).toBeCloseTo(55, 9);
  });

  it('is order-insensitive (input arrives newest-first from the repo)', () => {
    const bars = Array.from({ length: 11 }, (_, i) => volumeBar(closeAt, (11 - i) * 1));
    expect(medianDollarVolume(bars)).toBeCloseTo(60, 9);
  });

  it('null-volume rows (crypto) are excluded; below the floor the answer is null', () => {
    // 10 usable + 5 null rows → still computable from the 10.
    const usable = Array.from({ length: MIN_DOLLAR_VOLUME_ROWS }, (_, i) =>
      volumeBar(closeAt, i + 1),
    );
    const nulls = Array.from({ length: 5 }, () => volumeBar(closeAt, null));
    expect(medianDollarVolume([...usable, ...nulls])).toBeCloseTo(55, 9);

    // 9 usable rows → below MIN_DOLLAR_VOLUME_ROWS → unknown, not zero.
    expect(medianDollarVolume(usable.slice(0, MIN_DOLLAR_VOLUME_ROWS - 1))).toBeNull();
    // All-null (pure crypto without volume) → null.
    expect(medianDollarVolume(nulls)).toBeNull();
    expect(medianDollarVolume([])).toBeNull();
  });

  it('lookback constant matches the architecture (20 trading days)', () => {
    expect(DOLLAR_VOLUME_LOOKBACK_DAYS).toBe(20);
  });
});
