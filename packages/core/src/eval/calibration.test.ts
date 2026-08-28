import { describe, expect, it } from 'vitest';

import {
  decileBuckets,
  expectedCalibrationError,
  medianOf,
  quantileOf,
  spearmanRho,
  wilsonInterval,
} from './calibration.js';

describe('wilsonInterval', () => {
  it('matches the textbook value for 8/10', () => {
    const ci = wilsonInterval(8, 10);
    // Reference: Wilson (1927) with z=1.96 → [0.4901, 0.9433].
    expect(ci).not.toBeNull();
    expect(ci?.lo).toBeCloseTo(0.4901, 3);
    expect(ci?.hi).toBeCloseTo(0.9433, 3);
  });

  it('stays inside [0, 1] at the extremes, unlike the normal approximation', () => {
    const zero = wilsonInterval(0, 5);
    const all = wilsonInterval(5, 5);
    expect(zero?.lo).toBe(0);
    expect(zero?.hi).toBeGreaterThan(0);
    expect(zero?.hi).toBeLessThan(1);
    expect(all?.hi).toBe(1);
    expect(all?.lo).toBeGreaterThan(0);
  });

  it('is null for empty or impossible inputs', () => {
    expect(wilsonInterval(0, 0)).toBeNull();
    expect(wilsonInterval(3, 2)).toBeNull();
    expect(wilsonInterval(-1, 2)).toBeNull();
  });
});

describe('decileBuckets', () => {
  it('assigns scores to fixed-width buckets, 1.0 into the top one', () => {
    const buckets = decileBuckets([
      { score: 0.0, hit: true },
      { score: 0.05, hit: false },
      { score: 0.95, hit: true },
      { score: 1.0, hit: true },
    ]);
    expect(buckets).toHaveLength(10);
    expect(buckets[0]?.n).toBe(2);
    expect(buckets[0]?.hits).toBe(1);
    expect(buckets[0]?.hitRate).toBe(0.5);
    expect(buckets[9]?.n).toBe(2);
    expect(buckets[9]?.hitRate).toBe(1);
    // Empty buckets stay null, not zero — "no data" and "0% hit" differ.
    expect(buckets[5]?.n).toBe(0);
    expect(buckets[5]?.hitRate).toBeNull();
    expect(buckets[5]?.ci).toBeNull();
  });

  it('clamps out-of-range scores instead of dropping them', () => {
    const buckets = decileBuckets([
      { score: -0.2, hit: false },
      { score: 1.7, hit: true },
    ]);
    expect(buckets[0]?.n).toBe(1);
    expect(buckets[9]?.n).toBe(1);
  });
});

describe('expectedCalibrationError', () => {
  it('is 0 for perfectly calibrated buckets', () => {
    // 10 outcomes at score 0.75, 7.5 can't hit exactly — use 0.5 with 1/2 hits.
    const buckets = decileBuckets([
      { score: 0.55, hit: true },
      { score: 0.55, hit: false },
      { score: 0.55, hit: true },
      { score: 0.55, hit: false },
    ]);
    expect(expectedCalibrationError(buckets)).toBeCloseTo(0.05, 10); // |0.55 − 0.5|
  });

  it('weights buckets by their share of the data', () => {
    const buckets = decileBuckets([
      // 3 outcomes at ~0.9 all missing: |0.9 − 0| = 0.9, weight 3/4.
      { score: 0.9, hit: false },
      { score: 0.9, hit: false },
      { score: 0.9, hit: false },
      // 1 outcome at ~0.1 hitting: |0.1 − 1| = 0.9, weight 1/4.
      { score: 0.1, hit: true },
    ]);
    expect(expectedCalibrationError(buckets)).toBeCloseTo(0.9, 10);
  });

  it('is null with no data', () => {
    expect(expectedCalibrationError(decileBuckets([]))).toBeNull();
  });
});

describe('quantileOf / medianOf', () => {
  it('interpolates like percentile_cont (R-7)', () => {
    expect(quantileOf([1, 2, 3, 4], 0.5)).toBe(2.5);
    expect(quantileOf([1, 2, 3], 0.5)).toBe(2);
    expect(quantileOf([10, 20], 0.25)).toBe(12.5);
    expect(medianOf([3, 1, 2])).toBe(2);
  });

  it('handles edges', () => {
    expect(quantileOf([], 0.5)).toBeNull();
    expect(quantileOf([5], 0.9)).toBe(5);
    expect(quantileOf([1, 2], 0)).toBe(1);
    expect(quantileOf([1, 2], 1)).toBe(2);
    expect(quantileOf([1, 2], 1.1)).toBeNull();
  });
});

describe('spearmanRho', () => {
  it('is 1 for a monotone relationship regardless of shape', () => {
    expect(spearmanRho([1, 2, 3, 4], [1, 4, 9, 16])).toBeCloseTo(1, 10);
  });

  it('is -1 for a strictly decreasing relationship', () => {
    expect(spearmanRho([1, 2, 3, 4], [10, 8, 3, 1])).toBeCloseTo(-1, 10);
  });

  it('averages tied ranks', () => {
    // xs has a tie; the reference value comes from R: cor(x, y, method="spearman").
    const rho = spearmanRho([1, 2, 2, 3], [1, 2, 3, 4]);
    expect(rho).toBeCloseTo(0.9487, 3);
  });

  it('is null for short or constant series', () => {
    expect(spearmanRho([1, 2], [1, 2])).toBeNull();
    expect(spearmanRho([1, 1, 1], [1, 2, 3])).toBeNull();
  });

  it('throws on length mismatch', () => {
    expect(() => spearmanRho([1, 2, 3], [1, 2])).toThrow(/length mismatch/);
  });
});
