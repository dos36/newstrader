import { describe, expect, it } from 'vitest';

import { etWallTimeToUtc, zoneOffsetMinutes } from './et-time.js';

/**
 * US DST in 2026: begins Sunday 2026-03-08 02:00, ends Sunday 2026-11-01 02:00
 * (second Sunday of March / first Sunday of November). All calendar times
 * (08:30 / 14:00 / 16:30 ET) sit safely outside the transition window.
 */
describe('zoneOffsetMinutes', () => {
  it('reports EST (-300) in winter and EDT (-240) in summer for America/New_York', () => {
    expect(zoneOffsetMinutes(new Date('2026-01-15T12:00:00Z'), 'America/New_York')).toBe(-300);
    expect(zoneOffsetMinutes(new Date('2026-07-15T12:00:00Z'), 'America/New_York')).toBe(-240);
  });

  it('reports zero for UTC', () => {
    expect(zoneOffsetMinutes(new Date('2026-01-15T12:00:00Z'), 'UTC')).toBe(0);
  });
});

describe('etWallTimeToUtc', () => {
  it('converts a winter (EST) wall time: 08:30 ET → 13:30Z', () => {
    const utc = etWallTimeToUtc({ year: 2026, month: 1, day: 13, hour: 8, minute: 30 });
    expect(utc.toISOString()).toBe('2026-01-13T13:30:00.000Z');
  });

  it('converts a summer (EDT) wall time: 08:30 ET → 12:30Z', () => {
    const utc = etWallTimeToUtc({ year: 2026, month: 3, day: 11, hour: 8, minute: 30 });
    expect(utc.toISOString()).toBe('2026-03-11T12:30:00.000Z');
  });

  it('is correct ON the spring-forward day (2026-03-08): 14:00 ET is already EDT', () => {
    const utc = etWallTimeToUtc({ year: 2026, month: 3, day: 8, hour: 14, minute: 0 });
    expect(utc.toISOString()).toBe('2026-03-08T18:00:00.000Z');
  });

  it('is correct ON the fall-back day (2026-11-01): 08:30 ET is already EST', () => {
    const utc = etWallTimeToUtc({ year: 2026, month: 11, day: 1, hour: 8, minute: 30 });
    expect(utc.toISOString()).toBe('2026-11-01T13:30:00.000Z');
    // The day BEFORE the transition is still EDT.
    const dayBefore = etWallTimeToUtc({ year: 2026, month: 10, day: 31, hour: 8, minute: 30 });
    expect(dayBefore.toISOString()).toBe('2026-10-31T12:30:00.000Z');
  });

  it('rejects impossible calendar dates instead of rolling them over', () => {
    expect(() => etWallTimeToUtc({ year: 2026, month: 2, day: 30, hour: 8, minute: 30 })).toThrow(
      /impossible calendar date/,
    );
    expect(() => etWallTimeToUtc({ year: 2026, month: 13, day: 1, hour: 8, minute: 30 })).toThrow(
      /out-of-range/,
    );
    expect(() => etWallTimeToUtc({ year: 2026, month: 1, day: 1, hour: 24, minute: 0 })).toThrow(
      /out-of-range/,
    );
  });
});
