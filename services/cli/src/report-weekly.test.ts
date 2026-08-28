import { describe, expect, it } from 'vitest';

import { renderWeeklyReport, type WeeklyReportData } from './report-weekly.js';

/**
 * The renderer is a pure function of collected data — these tests pin the
 * report's contract (sections, numbers, reasoning lines) without a database.
 */

function baseData(overrides: Partial<WeeklyReportData> = {}): WeeklyReportData {
  return {
    from: new Date('2026-08-21T00:00:00.000Z'),
    to: new Date('2026-08-28T00:00:00.000Z'),
    portfolio: {
      cashUsd: '99000.00',
      equityUsd: '100500.00',
      realizedPnlUsd: '500.00',
      feesUsd: '12.34',
      openPositions: 2,
    },
    decisions: [
      { action: 'open_long', decisions: 3, suppressed: 1 },
      { action: 'skip', decisions: 40, suppressed: 0 },
    ],
    skipReasons: [
      { skipReason: 'event_type_whitelist', skips: 30 },
      { skipReason: 'min_confidence', skips: 10 },
    ],
    trades: [
      {
        symbol: 'AAA',
        side: 'long',
        qty: '10',
        entryPrice: '100.00',
        exitPrice: '110.00',
        openedAt: new Date('2026-08-22T14:00:00.000Z'),
        closedAt: new Date('2026-08-23T14:00:00.000Z'),
        netUsd: 99.5,
        eventType: 'earnings_result',
        direction: 'bullish',
        confidence: 0.85,
        reasoning: 'Beat on revenue and raised guidance.',
      },
      {
        symbol: 'BBB',
        side: 'long',
        qty: '5',
        entryPrice: '50.00',
        exitPrice: '45.00',
        openedAt: new Date('2026-08-24T14:00:00.000Z'),
        closedAt: new Date('2026-08-25T14:00:00.000Z'),
        netUsd: -25.75,
        eventType: null,
        direction: null,
        confidence: null,
        reasoning: null,
      },
    ],
    eventTypes: [
      {
        eventType: 'earnings_result',
        n: 12,
        nonNeutralShare: 0.75,
        hit: { n: 9, hits: 6, rate: 6 / 9, ci: { lo: 0.35, hi: 0.88 } },
        dedupHitRate: 0.6,
        medianAbsAbn1d: 130.5,
        bigMoveShare: 0.5,
      },
    ],
    calibration: {
      n: 9,
      buckets: [],
      dedupBuckets: [],
      ece: 0.12,
      dedupEce: 0.15,
      sliceHighConfidence: { n: 4, hits: 3, rate: 0.75, ci: { lo: 0.3, hi: 0.95 } },
      sliceLowConfidence: { n: 2, hits: 1, rate: 0.5, ci: { lo: 0.1, hi: 0.9 } },
    },
    evalRowCount: 12,
    measurer: 'm2',
    versions: ['v3'],
    ...overrides,
  };
}

describe('renderWeeklyReport', () => {
  it('renders every section with the collected numbers', () => {
    const markdown = renderWeeklyReport(baseData());
    expect(markdown).toContain('# NewsTrader weekly report — 2026-08-21 → 2026-08-28');
    expect(markdown).toContain('## P&L (paper account, all time)');
    expect(markdown).toContain('100500.00');
    expect(markdown).toContain('## Decision funnel');
    expect(markdown).toContain('| open_long | 3 | 1 |');
    expect(markdown).toContain('### Rejected signals by gate');
    expect(markdown).toContain('| event_type_whitelist | 30 |');
    expect(markdown).toContain('## Hit rate by event type');
    expect(markdown).toContain('| earnings_result | 12 |');
    expect(markdown).toContain('measurer `m2`');
    expect(markdown).toContain('prompt version(s) `v3`');
  });

  it('shows best and worst trades with the LLM reasoning attached', () => {
    const markdown = renderWeeklyReport(baseData());
    expect(markdown).toContain('### Best');
    expect(markdown).toContain('**AAA long +$99.50**');
    expect(markdown).toContain('signal: bullish earnings_result (conf 0.85)');
    expect(markdown).toContain('Beat on revenue and raised guidance.');
    expect(markdown).toContain('### Worst');
    expect(markdown).toContain('**BBB long −$25.75**');
    expect(markdown).toContain('exit decision (no originating signal)');
  });

  it('degrades to placeholders when the window is empty', () => {
    const markdown = renderWeeklyReport(
      baseData({
        decisions: [],
        skipReasons: [],
        trades: [],
        eventTypes: [],
        calibration: {
          n: 0,
          buckets: [],
          dedupBuckets: [],
          ece: null,
          dedupEce: null,
          sliceHighConfidence: { n: 0, hits: 0, rate: null, ci: null },
          sliceLowConfidence: { n: 0, hits: 0, rate: null, ci: null },
        },
        evalRowCount: 0,
      }),
    );
    expect(markdown).toContain('_No live decisions in the window._');
    expect(markdown).toContain('_No skips in the window._');
    expect(markdown).toContain('_No closed trades in the window._');
    expect(markdown).toContain('_No non-neutral joined signals in the window._');
  });
});
