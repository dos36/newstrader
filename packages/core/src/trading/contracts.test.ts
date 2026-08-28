import { describe, expect, it } from 'vitest';

import {
  DecideFeatures,
  PORTFOLIO_FEATURE_KEYS,
  WORLD_FEATURE_KEYS,
  withPortfolioFeatures,
} from './contracts.js';

/**
 * The world/portfolio partition is what makes replay Mode B sound: every
 * feature must be deliberately classified, so a NEW DecideFeatures key that
 * nobody tagged fails here instead of silently riding through Mode B with
 * live-run portfolio semantics.
 */
describe('feature tagging', () => {
  it('WORLD + PORTFOLIO + engineVersion exactly partition DecideFeatures', () => {
    const shapeKeys = Object.keys(DecideFeatures.shape).sort();
    const tagged = [...WORLD_FEATURE_KEYS, ...PORTFOLIO_FEATURE_KEYS, 'engineVersion'].sort();
    expect(tagged).toEqual(shapeKeys);
    // No key in both sets.
    const overlap = WORLD_FEATURE_KEYS.filter((key) =>
      (PORTFOLIO_FEATURE_KEYS as readonly string[]).includes(key),
    );
    expect(overlap).toEqual([]);
  });

  it('withPortfolioFeatures replaces only the portfolio slice', () => {
    const base = DecideFeatures.parse({
      clusterItemCount: 3,
      distinctSourceCount: 2,
      itemsPerHour: 1,
      calendarMatch: false,
      priceMoveSinceAnchorBps: 12.5,
      medianDollarVolume: 1_000_000,
      atr: '1.25',
      openPositionsCount: 5,
      hasOpenPositionForInstrument: true,
      paperEquityUsd: '90000.00',
      engineVersion: 'test-1',
    });
    const merged = withPortfolioFeatures(base, {
      openPositionsCount: 0,
      hasOpenPositionForInstrument: false,
      paperEquityUsd: '100000.00',
    });
    expect(merged.openPositionsCount).toBe(0);
    expect(merged.hasOpenPositionForInstrument).toBe(false);
    expect(merged.paperEquityUsd).toBe('100000.00');
    // World features and the stamp survive untouched.
    expect(merged.priceMoveSinceAnchorBps).toBe(12.5);
    expect(merged.atr).toBe('1.25');
    expect(merged.engineVersion).toBe('test-1');
  });
});
