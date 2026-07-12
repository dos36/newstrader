import { describe, expect, it } from 'vitest';

import { isScheduledEvent, type ScheduledEventLite } from './match.js';

const CPI_AT = new Date('2030-01-15T13:30:00.000Z');
const EARNINGS_AT = new Date('2030-01-15T21:30:00.000Z');

const macroCpi: ScheduledEventLite = { kind: 'cpi', instrumentId: null, scheduledAt: CPI_AT };
const zaphEarnings: ScheduledEventLite = {
  kind: 'earnings',
  instrumentId: 'inst_zaph',
  scheduledAt: EARNINGS_AT,
};
const events = [macroCpi, zaphEarnings];

const minutesAfter = (base: Date, minutes: number) => new Date(base.getTime() + minutes * 60_000);

describe('isScheduledEvent', () => {
  it('macro events match ANY instrument, and probes without an instrument', () => {
    expect(
      isScheduledEvent(events, { at: CPI_AT, toleranceMinutes: 30, instrumentId: 'inst_other' }),
    ).toBe(true);
    expect(isScheduledEvent(events, { at: CPI_AT, toleranceMinutes: 30 })).toBe(true);
  });

  it('earnings match ONLY their instrument — never another, never a macro probe', () => {
    const at = EARNINGS_AT;
    expect(isScheduledEvent(events, { at, toleranceMinutes: 30, instrumentId: 'inst_zaph' })).toBe(
      true,
    );
    expect(isScheduledEvent(events, { at, toleranceMinutes: 30, instrumentId: 'inst_other' })).toBe(
      false,
    );
    // No instrumentId on the probe = macro-scope news; company earnings are not
    // "expected" context for it (only the macro CPI 8h earlier, out of tolerance).
    expect(isScheduledEvent(events, { at, toleranceMinutes: 30 })).toBe(false);
  });

  it('the tolerance window is symmetric and inclusive on both edges', () => {
    // Exactly ±30 minutes: inclusive.
    expect(isScheduledEvent(events, { at: minutesAfter(CPI_AT, 30), toleranceMinutes: 30 })).toBe(
      true,
    );
    expect(isScheduledEvent(events, { at: minutesAfter(CPI_AT, -30), toleranceMinutes: 30 })).toBe(
      true,
    );
    // One millisecond past the edge: out.
    expect(
      isScheduledEvent(events, {
        at: new Date(CPI_AT.getTime() + 30 * 60_000 + 1),
        toleranceMinutes: 30,
      }),
    ).toBe(false);
    // Zero tolerance matches only the exact instant.
    expect(isScheduledEvent(events, { at: CPI_AT, toleranceMinutes: 0 })).toBe(true);
    expect(
      isScheduledEvent(events, { at: new Date(CPI_AT.getTime() + 1), toleranceMinutes: 0 }),
    ).toBe(false);
  });

  it('kinds narrows which events can match', () => {
    expect(isScheduledEvent(events, { at: CPI_AT, toleranceMinutes: 30, kinds: ['cpi'] })).toBe(
      true,
    );
    expect(
      isScheduledEvent(events, { at: CPI_AT, toleranceMinutes: 30, kinds: ['fomc', 'nfp'] }),
    ).toBe(false);
    expect(
      isScheduledEvent(events, {
        at: EARNINGS_AT,
        toleranceMinutes: 30,
        instrumentId: 'inst_zaph',
        kinds: ['earnings'],
      }),
    ).toBe(true);
  });

  it('returns false over an empty prefetched window', () => {
    expect(isScheduledEvent([], { at: CPI_AT, toleranceMinutes: 60 })).toBe(false);
  });
});
