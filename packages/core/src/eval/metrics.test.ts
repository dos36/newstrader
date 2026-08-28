import { describe, expect, it } from 'vitest';

import { computeRunMetrics, type MetricsTrade } from './metrics.js';

const T0 = new Date('2026-08-10T14:00:00.000Z');
const HOUR_MS = 3_600_000;

function trade(input: {
  realizedUsd: string;
  qty?: string;
  entryPrice?: string;
  openOffsetH?: number;
  closeOffsetH?: number;
}): MetricsTrade {
  return {
    realizedUsd: input.realizedUsd,
    qty: input.qty ?? '10',
    entryPrice: input.entryPrice ?? '100.00',
    openedAt: new Date(T0.getTime() + (input.openOffsetH ?? 0) * HOUR_MS),
    closedAt: new Date(T0.getTime() + (input.closeOffsetH ?? 1) * HOUR_MS),
  };
}

describe('computeRunMetrics', () => {
  it('returns nulls, not zeros, for an empty run', () => {
    const metrics = computeRunMetrics([], { startingCashUsd: '100000.00' });
    expect(metrics.trades).toBe(0);
    expect(metrics.hitRate).toBeNull();
    expect(metrics.profitFactor).toBeNull();
    expect(metrics.maxDrawdownPct).toBeNull();
    expect(metrics.exposureAdjustedReturnPct).toBeNull();
    expect(metrics.realizedUsd).toBe('0.00');
  });

  it('computes hit rate, profit factor, and avg bps per trade', () => {
    const metrics = computeRunMetrics(
      [
        trade({ realizedUsd: '100.00' }), // +100 on 1000 notional = +1000 bps
        trade({ realizedUsd: '-50.00', openOffsetH: 2, closeOffsetH: 3 }), // −500 bps
        trade({ realizedUsd: '0.00', openOffsetH: 4, closeOffsetH: 5 }), // flat: not a win
      ],
      { startingCashUsd: '100000.00' },
    );
    expect(metrics.trades).toBe(3);
    expect(metrics.wins).toBe(1);
    expect(metrics.losses).toBe(1);
    expect(metrics.hitRate).toBeCloseTo(1 / 3, 10);
    expect(metrics.profitFactor).toBeCloseTo(2, 10); // 100 / 50
    expect(metrics.avgBpsPerTrade).toBeCloseTo((1000 - 500 + 0) / 3, 6);
    expect(metrics.realizedUsd).toBe('50.00');
  });

  it('profitFactor is null (not Infinity) when nothing lost', () => {
    const metrics = computeRunMetrics([trade({ realizedUsd: '10.00' })], {
      startingCashUsd: '1000.00',
    });
    expect(metrics.profitFactor).toBeNull();
    expect(metrics.hitRate).toBe(1);
  });

  it('measures drawdown against the running peak in close order', () => {
    // Equity: 1000 → 1100 (peak) → 880 → 990. Max DD = 220/1100 = 20%.
    const metrics = computeRunMetrics(
      [
        trade({ realizedUsd: '100.00', openOffsetH: 0, closeOffsetH: 1 }),
        trade({ realizedUsd: '-220.00', openOffsetH: 1, closeOffsetH: 2 }),
        trade({ realizedUsd: '110.00', openOffsetH: 2, closeOffsetH: 3 }),
      ],
      { startingCashUsd: '1000.00' },
    );
    expect(metrics.maxDrawdownPct).toBeCloseTo(20, 6);
  });

  it('drawdown ignores trade array order — closedAt decides the curve', () => {
    const trades = [
      trade({ realizedUsd: '110.00', openOffsetH: 2, closeOffsetH: 3 }),
      trade({ realizedUsd: '100.00', openOffsetH: 0, closeOffsetH: 1 }),
      trade({ realizedUsd: '-220.00', openOffsetH: 1, closeOffsetH: 2 }),
    ];
    const metrics = computeRunMetrics(trades, { startingCashUsd: '1000.00' });
    expect(metrics.maxDrawdownPct).toBeCloseTo(20, 6);
  });

  it('exposure-adjusted return rewards the same P&L on less deployed capital', () => {
    // One trade, 1000 notional, held for the WHOLE 2h span: avg exposure 1000.
    const fullyDeployed = computeRunMetrics(
      [trade({ realizedUsd: '20.00', openOffsetH: 0, closeOffsetH: 2 })],
      { startingCashUsd: '100000.00' },
    );
    expect(fullyDeployed.exposureAdjustedReturnPct).toBeCloseTo(2, 6); // 20/1000

    // Same P&L, but capital deployed only half the span (two trades framing it).
    const halfDeployed = computeRunMetrics(
      [
        trade({ realizedUsd: '10.00', openOffsetH: 0, closeOffsetH: 0.5 }),
        trade({ realizedUsd: '10.00', openOffsetH: 1.5, closeOffsetH: 2 }),
      ],
      { startingCashUsd: '100000.00' },
    );
    // Avg exposure = (1000×0.5h + 1000×0.5h) / 2h = 500 → 20/500 = 4%.
    expect(halfDeployed.exposureAdjustedReturnPct).toBeCloseTo(4, 6);
  });

  it('handles shorts: signed qty still gives positive notional', () => {
    const metrics = computeRunMetrics(
      [trade({ realizedUsd: '50.00', qty: '-10' })], // short 10 @ 100 → 1000 notional
      { startingCashUsd: '1000.00' },
    );
    expect(metrics.avgBpsPerTrade).toBeCloseTo(500, 6);
  });
});
