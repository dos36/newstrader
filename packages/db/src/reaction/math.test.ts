import { describe, expect, it } from 'vitest';

import {
  DEFAULT_RECOVERY_WINDOW_DAYS,
  FLAT_1D_THRESHOLD_BPS,
  MIN_BETA_OVERLAP_DAYS,
  RECOVERY_TRIGGER_BPS,
  abnormalReturnBps,
  beta,
  cumulativeAbnormalSeries,
  priceAt,
  reactionLadder,
  recovery,
  settledBarAt,
  simpleReturnBps,
  summarize,
  type CloseBar,
  type CumulativePoint,
} from './math.js';

const MINUTE_MS = 60_000;
const HOUR_MS = 3_600_000;
const DAY_MS = 86_400_000;

const at = (iso: string): Date => new Date(iso);
const minutesAfter = (base: Date, minutes: number): Date =>
  new Date(base.getTime() + minutes * MINUTE_MS);
const bar = (ts: Date, close: string): CloseBar => ({ ts, close });
const point = (base: Date, minutes: number, cumAbnormalBps: number): CumulativePoint => ({
  ts: minutesAfter(base, minutes),
  cumAbnormalBps,
});

/** Sparse bars at explicit minute offsets from a base — sessions have gaps, so does this. */
const barsAt = (base: Date, entries: [minutes: number, close: string][]): CloseBar[] =>
  entries.map(([minutes, close]) => bar(minutesAfter(base, minutes), close));

/**
 * Aligned daily closes where the instrument's log return is `factor` × the
 * benchmark's (a ±1%/0 repeating pattern) — OLS beta is `factor` by construction.
 */
function alignedDailySeries(
  days: number,
  factor: number,
): { instrument: CloseBar[]; bench: CloseBar[] } {
  const start = Date.UTC(2024, 0, 1);
  const instrument: CloseBar[] = [];
  const bench: CloseBar[] = [];
  let benchLog = Math.log(400);
  let instrumentLog = Math.log(100);
  for (let i = 0; i < days; i++) {
    if (i > 0) {
      const dailyReturn = 0.01 * ((i % 3) - 1); // -1%, 0, +1%, repeating
      benchLog += dailyReturn;
      instrumentLog += factor * dailyReturn;
    }
    const ts = new Date(start + i * DAY_MS);
    bench.push(bar(ts, Math.exp(benchLog).toFixed(6)));
    instrument.push(bar(ts, Math.exp(instrumentLog).toFixed(6)));
  }
  return { instrument, bench };
}

describe('priceAt', () => {
  const base = at('2024-03-04T14:30:00.000Z');
  const bars = barsAt(base, [
    [0, '100.000000'],
    [1, '101.000000'],
    [5, '102.000000'],
  ]);

  it('returns the close of the bar exactly at ts', () => {
    expect(priceAt(bars, minutesAfter(base, 1))).toBe('101.000000');
  });

  it('returns the last close before ts when no exact bar exists', () => {
    expect(priceAt(bars, minutesAfter(base, 3))).toBe('101.000000');
  });

  it('is undefined before the first bar', () => {
    expect(priceAt(bars, minutesAfter(base, -1))).toBeUndefined();
  });

  it('is undefined beyond the default 30-minute staleness bound', () => {
    expect(priceAt(bars, minutesAfter(base, 36))).toBeUndefined();
  });

  it('honors a custom staleness bound', () => {
    expect(priceAt(bars, minutesAfter(base, 36), 60)).toBe('102.000000');
    expect(priceAt(bars, minutesAfter(base, 6), 0)).toBeUndefined();
  });

  it('is undefined on an empty bar list', () => {
    expect(priceAt([], base)).toBeUndefined();
  });
});

describe('settledBarAt', () => {
  const base = at('2024-03-08T15:00:00.000Z'); // Friday
  const fridayClose = bar(minutesAfter(base, 0), '100.000000');
  const mondayOpen = bar(minutesAfter(base, 3 * 24 * 60 - 30), '103.000000');

  it('accepts a fresh bar without proof', () => {
    expect(settledBarAt([fridayClose], minutesAfter(base, 10))?.close).toBe('100.000000');
  });

  it('accepts a stale bar only when a later bar proves the gap was non-trading', () => {
    const weekend = minutesAfter(base, 24 * 60); // Saturday
    expect(settledBarAt([fridayClose], weekend)).toBeUndefined();
    expect(settledBarAt([fridayClose, mondayOpen], weekend)?.close).toBe('100.000000');
  });

  it('is undefined with no bar at-or-before ts', () => {
    expect(settledBarAt([mondayOpen], base)).toBeUndefined();
  });
});

describe('simpleReturnBps', () => {
  it('computes positive and negative returns in bps', () => {
    expect(simpleReturnBps('100.000000', '101.000000')).toBeCloseTo(100, 8);
    expect(simpleReturnBps('200.000000', '190.000000')).toBeCloseTo(-500, 8);
  });

  it('handles decimal-string precision inputs', () => {
    expect(simpleReturnBps('123.456789', '123.456789')).toBe(0);
  });

  it('throws on malformed price strings (format drift)', () => {
    expect(() => simpleReturnBps('abc', '100')).toThrow(/invalid price/);
    expect(() => simpleReturnBps('100', '')).toThrow(/invalid price/);
  });

  it('throws on non-positive prices', () => {
    expect(() => simpleReturnBps('0', '100')).toThrow(/invalid price/);
    expect(() => simpleReturnBps('100', '-5')).toThrow(/invalid price/);
  });
});

describe('beta', () => {
  it('recovers the constructed beta from aligned daily log returns', () => {
    const { instrument, bench } = alignedDailySeries(40, 2);
    expect(beta(instrument, bench)).toBeCloseTo(2, 3);
    const halfBeta = alignedDailySeries(40, 0.5);
    expect(beta(halfBeta.instrument, halfBeta.bench)).toBeCloseTo(0.5, 3);
  });

  it('is null below the 30-overlapping-day minimum and computes at exactly 30', () => {
    const short = alignedDailySeries(MIN_BETA_OVERLAP_DAYS - 1, 2);
    expect(beta(short.instrument, short.bench)).toBeNull();
    const exact = alignedDailySeries(MIN_BETA_OVERLAP_DAYS, 2);
    expect(beta(exact.instrument, exact.bench)).toBeCloseTo(2, 3);
  });

  it('is null for a flat benchmark (zero variance)', () => {
    const { instrument, bench } = alignedDailySeries(40, 2);
    const flatBench = bench.map((b) => ({ ts: b.ts, close: '400.000000' }));
    expect(beta(instrument, flatBench)).toBeNull();
  });

  it('only counts date-aligned closes toward the overlap minimum', () => {
    const { instrument, bench } = alignedDailySeries(40, 2);
    // Instrument reports only every other day: 20 overlapping days < 30 → null.
    const sparseInstrument = instrument.filter((_, i) => i % 2 === 0);
    expect(beta(sparseInstrument, bench)).toBeNull();
    // A few missing days keep 35 aligned days; shared multi-day gaps preserve beta.
    const mostlyAligned = instrument.filter((_, i) => i < 20 || i >= 25);
    expect(beta(mostlyAligned, bench)).toBeCloseTo(2, 3);
  });

  it('tolerates unsorted instrument input', () => {
    const { instrument, bench } = alignedDailySeries(40, 2);
    expect(beta([...instrument].reverse(), bench)).toBeCloseTo(2, 3);
  });
});

describe('abnormalReturnBps', () => {
  it('subtracts beta × benchmark from raw', () => {
    expect(abnormalReturnBps(100, 50, 2)).toBe(0);
    expect(abnormalReturnBps(-300, -100, 1.5)).toBeCloseTo(-150, 8);
  });

  it('falls back to raw when beta or the benchmark return is null', () => {
    expect(abnormalReturnBps(100, 50, null)).toBe(100);
    expect(abnormalReturnBps(100, null, 2)).toBe(100);
  });
});

describe('reactionLadder', () => {
  const anchor = at('2024-03-04T00:00:00.000Z');
  /**
   * Continuous-market (crypto-like) sparse bars covering every horizon
   * exactly. The [-1, ...] entry is the true anchor bar under the
   * close-time selection rule (anchor bar = last bar whose CLOSE, i.e.
   * open+60s, settles at-or-before the anchor) — it carries the SAME price
   * as the old minute-0 bar so every horizon's raw return is unaffected.
   */
  const fullBars = barsAt(anchor, [
    [-1, '100.000000'],
    [0, '100.000000'],
    [5, '101.000000'],
    [15, '102.000000'],
    [30, '103.000000'],
    [60, '104.000000'],
    [240, '105.000000'],
    [1440, '110.000000'],
    [4320, '120.000000'],
    [7200, '130.000000'],
  ]);

  it('measures every horizon with raw returns and abnormal = raw when beta is null', () => {
    const rows = reactionLadder(anchor, fullBars, [], null);
    expect(rows.map((r) => r.horizon)).toEqual(['5m', '15m', '30m', '1h', '4h', '1d', '3d', '5d']);
    expect(rows.map((r) => Math.round(r.rawReturnBps))).toEqual([
      100, 200, 300, 400, 500, 1000, 2000, 3000,
    ]);
    for (const row of rows) {
      expect(row.abnormalReturnBps).toBe(row.rawReturnBps);
      expect(row.betaUsed).toBeNull();
    }
  });

  it('applies the beta × benchmark adjustment over the same window', () => {
    // Benchmark gains 100 bps by every horizon; beta 2 → abnormal = raw − 200.
    const benchBars = barsAt(anchor, [
      [-1, '400.000000'],
      [0, '400.000000'],
      [5, '404.000000'],
      [15, '404.000000'],
      [30, '404.000000'],
      [60, '404.000000'],
      [240, '404.000000'],
      [1440, '404.000000'],
      [4320, '404.000000'],
      [7200, '404.000000'],
    ]);
    const rows = reactionLadder(anchor, fullBars, benchBars, 2);
    expect(rows).toHaveLength(8);
    for (const row of rows) {
      expect(row.betaUsed).toBe(2);
      expect(row.abnormalReturnBps).toBeCloseTo(row.rawReturnBps - 200, 6);
    }
  });

  it('falls back to raw with betaUsed null when benchmark bars are missing', () => {
    const rows = reactionLadder(anchor, fullBars, [], 2);
    expect(rows).toHaveLength(8);
    for (const row of rows) {
      expect(row.abnormalReturnBps).toBe(row.rawReturnBps);
      expect(row.betaUsed).toBeNull();
    }
  });

  it('bridges a weekend session gap once a later bar settles the horizon', () => {
    const friday = at('2024-03-08T15:00:00.000Z');
    const bars = [
      bar(minutesAfter(friday, -1), '100.000000'), // true anchor bar (close-time rule)
      bar(friday, '100.000000'),
      bar(minutesAfter(friday, 5), '101.000000'),
      bar(minutesAfter(friday, 359), '102.000000'), // Friday 20:59 close
      bar(at('2024-03-11T14:30:00.000Z'), '105.000000'), // Monday open proves the gap
    ];
    const rows = reactionLadder(friday, bars, [], null, ['5m', '1h', '1d']);
    expect(rows.map((r) => [r.horizon, Math.round(r.rawReturnBps)])).toEqual([
      ['5m', 100],
      // 1h horizon: last bar is 55 min stale, but a later bar proves no trading between.
      ['1h', 100],
      // 1d horizon lands on Saturday → Friday close, settled by Monday's bar.
      ['1d', 200],
    ]);
  });

  it('skips horizons whose price has not settled yet (data simply ends)', () => {
    const monday = at('2024-03-04T15:00:00.000Z');
    const bars = barsAt(monday, [
      [-1, '100.000000'],
      [0, '100.000000'],
      [5, '101.000000'],
      [60, '102.000000'],
    ]);
    const rows = reactionLadder(monday, bars, [], null, ['5m', '1h', '4h', '1d']);
    // 4h/1d: last bar is stale with NO later bar — absent row, never a zero.
    expect(rows.map((r) => r.horizon)).toEqual(['5m', '1h']);
  });

  it('"queue for open": a daily+ horizon whose window saw no trading falls forward to the next settled bar', () => {
    const fridayClose = at('2024-03-08T20:00:00.000Z');
    const bars = [
      bar(minutesAfter(fridayClose, -1), '100.000000'), // anchor bar (close-time rule)
      bar(at('2024-03-11T14:30:00.000Z'), '102.000000'), // Monday open — 1d falls forward here
      bar(at('2024-03-11T20:00:00.000Z'), '103.000000'), // exactly anchor+3d — real trading
    ];
    const rows = reactionLadder(fridayClose, bars, [], null, ['5m', '1d', '3d']);
    // 5m stays strict (intraday) → skipped (no trading in a 5-minute window is
    // genuinely unmeasurable). 1d falls forward to Monday's open. 3d resolves
    // normally — real trading landed exactly on the horizon.
    expect(rows.map((r) => [r.horizon, Math.round(r.rawReturnBps)])).toEqual([
      ['1d', 200],
      ['3d', 300],
    ]);
  });

  it('"queue for open" still skips when the series ends exactly at the anchor bar (no proof of a settled gap)', () => {
    const fridayClose = at('2024-03-08T20:00:00.000Z');
    const bars = [
      bar(minutesAfter(fridayClose, -1), '100.000000'),
      // Nothing after the anchor at all — data simply hasn't arrived yet.
    ];
    const rows = reactionLadder(fridayClose, bars, [], null, ['1d', '3d']);
    expect(rows).toEqual([]);
  });

  it('returns an empty ladder when the anchor has no settled bar', () => {
    const anchorTs = at('2024-03-04T00:00:00.000Z');
    // Bars only after the anchor:
    expect(reactionLadder(anchorTs, barsAt(anchorTs, [[10, '100']]), [], null)).toEqual([]);
    // Single stale bar with no proof:
    expect(reactionLadder(anchorTs, barsAt(anchorTs, [[-120, '100']]), [], null)).toEqual([]);
  });
});

describe('cumulativeAbnormalSeries', () => {
  const anchor = at('2024-03-04T14:30:00.000Z');

  it('samples every bar strictly after the anchor bar up to untilTs', () => {
    // [-1, ...] is the true anchor bar under the close-time selection rule
    // (same price as the old minute-0 bar), so minute 0 is now itself a real
    // sampled point (0bps — no move yet) ahead of the 5/10-minute moves.
    const bars = barsAt(anchor, [
      [-1, '100.000000'],
      [0, '100.000000'],
      [5, '101.000000'],
      [10, '102.000000'],
      [20, '99.000000'],
    ]);
    const points = cumulativeAbnormalSeries(anchor, bars, [], null, {
      untilTs: minutesAfter(anchor, 15),
    });
    expect(points.map((p) => Math.round(p.cumAbnormalBps))).toEqual([0, 100, 200]);
    expect(points.map((p) => p.ts.getTime())).toEqual([
      minutesAfter(anchor, 0).getTime(),
      minutesAfter(anchor, 5).getTime(),
      minutesAfter(anchor, 10).getTime(),
    ]);
  });

  it('beta-adjusts each point against the latest benchmark close', () => {
    const bars = barsAt(anchor, [
      [-1, '100.000000'],
      [0, '100.000000'],
      [5, '101.000000'],
      [10, '102.000000'],
    ]);
    const benchBars = barsAt(anchor, [
      [-1, '400.000000'],
      [0, '400.000000'],
      [5, '402.000000'], // +50 bps
      [10, '404.000000'], // +100 bps
    ]);
    const points = cumulativeAbnormalSeries(anchor, bars, benchBars, 2, {
      untilTs: minutesAfter(anchor, 10),
    });
    expect(points.map((p) => Math.round(p.cumAbnormalBps))).toEqual([0, 0, 0]);
  });

  it('is empty when the anchor has no settled bar', () => {
    expect(
      cumulativeAbnormalSeries(anchor, barsAt(anchor, [[10, '100']]), [], null, {
        untilTs: minutesAfter(anchor, 60),
      }),
    ).toEqual([]);
  });

  describe('fallForwardCapMs ("queue for open" for the 1d summary window)', () => {
    const fridayClose = at('2024-03-08T20:00:00.000Z');
    const noWeekendTrading = [
      bar(minutesAfter(fridayClose, -1), '100.000000'), // anchor bar (close-time rule)
      bar(at('2024-03-11T14:30:00.000Z'), '102.000000'), // Monday open, +200bps
    ];
    const oneDayUntil = new Date(fridayClose.getTime() + 1_440 * MINUTE_MS);

    it('without the option, an off-hours window with no trading is empty (unchanged default)', () => {
      expect(
        cumulativeAbnormalSeries(fridayClose, noWeekendTrading, [], null, {
          untilTs: oneDayUntil,
        }),
      ).toEqual([]);
    });

    it('with the option, extends to the first settled bar past untilTs when nothing traded', () => {
      const points = cumulativeAbnormalSeries(fridayClose, noWeekendTrading, [], null, {
        untilTs: oneDayUntil,
        fallForwardCapMs: 3 * 24 * HOUR_MS,
      });
      expect(points).toHaveLength(1);
      expect(points[0]?.ts.getTime()).toBe(at('2024-03-11T14:30:00.000Z').getTime());
      expect(Math.round(points[0]?.cumAbnormalBps ?? Number.NaN)).toBe(200);
    });

    it('does not extend past the cap, and does not affect a window that already has real trading', () => {
      // Cap too small to reach Monday's bar (~66.5h away) — stays empty.
      expect(
        cumulativeAbnormalSeries(fridayClose, noWeekendTrading, [], null, {
          untilTs: oneDayUntil,
          fallForwardCapMs: HOUR_MS,
        }),
      ).toEqual([]);

      // Real trading inside the window: the option must be a no-op.
      const tradedThroughWeekend = [
        bar(minutesAfter(fridayClose, -1), '100.000000'),
        bar(minutesAfter(fridayClose, 300), '101.000000'), // within the 1d window
      ];
      const points = cumulativeAbnormalSeries(fridayClose, tradedThroughWeekend, [], null, {
        untilTs: oneDayUntil,
        fallForwardCapMs: 3 * 24 * HOUR_MS,
      });
      expect(points).toHaveLength(1);
      expect(points[0]?.ts.getTime()).toBe(minutesAfter(fridayClose, 300).getTime());
    });
  });
});

describe('summarize', () => {
  const anchor = at('2024-03-04T14:30:00.000Z');

  it('finds the signed peak, time to peak, and time to half of the 1d move', () => {
    const points = [point(anchor, 30, -120), point(anchor, 60, -80), point(anchor, 1440, -100)];
    const summary = summarize(anchor, points);
    expect(summary).toEqual({
      peakAbnormalMoveBps: -120,
      timeToPeakMinutes: 30,
      timeToHalfOf1dMoveMinutes: 30, // first |cum| ≥ 50
      direction1d: 'down',
    });
  });

  it('reports the first minute the half-move threshold is crossed', () => {
    const points = [point(anchor, 5, -10), point(anchor, 45, -60), point(anchor, 1440, -100)];
    expect(summarize(anchor, points)?.timeToHalfOf1dMoveMinutes).toBe(45);
  });

  it('labels an up move from the final cumulative value', () => {
    const points = [point(anchor, 15, 90), point(anchor, 1440, 150)];
    const summary = summarize(anchor, points);
    expect(summary?.direction1d).toBe('up');
    expect(summary?.peakAbnormalMoveBps).toBe(150);
    expect(summary?.timeToPeakMinutes).toBe(1440);
  });

  it("requires the half-move point to share the 1d move's sign (a whipsaw dip must not count)", () => {
    // -60bps at 5m is already past half of the eventual +100bps 1d move in
    // MAGNITUDE, but it is a dip in the WRONG direction — the real half-move
    // crossing (same sign as the +100 close) only happens at the 1d point.
    const points = [point(anchor, 5, -60), point(anchor, 60, 10), point(anchor, 1440, 100)];
    const summary = summarize(anchor, points);
    expect(summary?.direction1d).toBe('up');
    expect(summary?.timeToHalfOf1dMoveMinutes).toBe(1440);
  });

  it('marks a sub-threshold 1d move flat with a null time-to-half', () => {
    const points = [point(anchor, 60, 40), point(anchor, 1440, FLAT_1D_THRESHOLD_BPS - 1)];
    const summary = summarize(anchor, points);
    expect(summary).toEqual({
      peakAbnormalMoveBps: 40,
      timeToPeakMinutes: 60,
      timeToHalfOf1dMoveMinutes: null,
      direction1d: 'flat',
    });
  });

  it('is null on an empty series (1d unmeasurable → no summary row)', () => {
    expect(summarize(anchor, [])).toBeNull();
  });
});

describe('recovery', () => {
  const anchor = at('2024-03-04T14:30:00.000Z');
  const hourPoint = (hours: number, cum: number): CumulativePoint => ({
    ts: new Date(anchor.getTime() + hours * HOUR_MS),
    cumAbnormalBps: cum,
  });

  it('measures trough, time to trough, and half/full reversion times', () => {
    const points = [
      hourPoint(12, -100),
      hourPoint(24, -300),
      hourPoint(48, -500),
      hourPoint(96, -250), // half reversion: ≥ trough/2
      hourPoint(120, -100),
      hourPoint(150, 10), // full reversion: ≥ 0
    ];
    expect(recovery(anchor, points)).toEqual({
      troughBps: -500,
      timeToTroughHours: 48,
      timeToHalfReversionHours: 96,
      timeToFullReversionHours: 150,
      windowDaysUsed: 6.25,
    });
  });

  it('reports null reversion times when the move never reverts in the window', () => {
    const points = [
      hourPoint(24, -300),
      hourPoint(48, -500),
      hourPoint(DEFAULT_RECOVERY_WINDOW_DAYS * 24, -480),
    ];
    const result = recovery(anchor, points);
    expect(result?.timeToHalfReversionHours).toBeNull();
    expect(result?.timeToFullReversionHours).toBeNull();
    expect(result?.windowDaysUsed).toBe(DEFAULT_RECOVERY_WINDOW_DAYS);
  });

  it('clamps the window to available data and reports the days actually used', () => {
    const points = [hourPoint(24, -300), hourPoint(240, -200)]; // data ends at 10d
    expect(recovery(anchor, points)?.windowDaysUsed).toBe(10);
  });

  it('excludes points beyond an explicit windowDays', () => {
    const points = [hourPoint(12, -100), hourPoint(24, -300), hourPoint(60, 0)];
    const result = recovery(anchor, points, { windowDays: 2 });
    expect(result?.troughBps).toBe(-300);
    expect(result?.timeToFullReversionHours).toBeNull(); // the 60h reversion is outside
    expect(result?.windowDaysUsed).toBe(1);
  });

  it('is null when the trough is not negative (nothing to recover from)', () => {
    expect(recovery(anchor, [hourPoint(24, 100), hourPoint(48, 50)])).toBeNull();
  });

  it('is null on an empty series', () => {
    expect(recovery(anchor, [])).toBeNull();
  });

  it('exports a negative recovery trigger for callers to gate on', () => {
    expect(RECOVERY_TRIGGER_BPS).toBeLessThan(0);
  });
});
