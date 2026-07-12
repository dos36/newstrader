import { readFileSync } from 'node:fs';

import { describe, expect, it } from 'vitest';

import type { FetchLike } from './http.js';
import {
  BLS_CPI_SCHEDULE_URL,
  fetchCpiSchedule,
  parseBeaSchedule,
  parseBlsReleaseSchedule,
  parseFomcCalendar,
  type MacroEvent,
} from './macro.js';

/**
 * Fixtures = trimmed REAL markup captured 2026-07-11:
 * - fomc-calendars.html — the FOMC Search panel heading (decoy) plus the 2026,
 *   2025 (incl. the "22 (notation vote)" row), and 2023 (incl. two cross-month
 *   "31-1" rows) year panels, verbatim.
 * - bls-cpi-schedule.html / bls-empsit-schedule.html — the jQuery block that
 *   mentions .release-list (decoy), the h2, and the 13-row release-list table.
 * - bea-schedule.html — the #release-schedule-table ("Year 2026" header,
 *   July–December press rows incl. one dateless "To Be Announced" row).
 */
const fomcFixture = readFileSync(
  new URL('./__fixtures__/fomc-calendars.html', import.meta.url),
  'utf8',
);
const cpiFixture = readFileSync(
  new URL('./__fixtures__/bls-cpi-schedule.html', import.meta.url),
  'utf8',
);
const empsitFixture = readFileSync(
  new URL('./__fixtures__/bls-empsit-schedule.html', import.meta.url),
  'utf8',
);
const beaFixture = readFileSync(
  new URL('./__fixtures__/bea-schedule.html', import.meta.url),
  'utf8',
);

const byMeetingEnd = (events: MacroEvent[]): Map<unknown, MacroEvent> =>
  new Map(events.map((event) => [event.meta['meetingEnd'], event]));

describe('parseFomcCalendar', () => {
  it('parses every regular meeting from the year panels and nothing from the decoy', () => {
    const events = parseFomcCalendar(fomcFixture);
    // 8 (2026) + 8 (2025, notation vote skipped) + 8 (2023).
    expect(events).toHaveLength(24);
    expect(events.every((event) => event.kind === 'fomc')).toBe(true);
  });

  it('anchors the statement at 14:00 ET on day 2, DST-correct', () => {
    const events = byMeetingEnd(parseFomcCalendar(fomcFixture));
    // January = EST: 14:00 ET → 19:00Z.
    expect(events.get('2026-01-28')?.scheduledAt.toISOString()).toBe('2026-01-28T19:00:00.000Z');
    // September = EDT: 14:00 ET → 18:00Z.
    expect(events.get('2026-09-16')?.scheduledAt.toISOString()).toBe('2026-09-16T18:00:00.000Z');
    expect(events.get('2026-01-28')?.meta['meetingStart']).toBe('2026-01-27');
  });

  it('flags Summary-of-Economic-Projections meetings (asterisk)', () => {
    const events = byMeetingEnd(parseFomcCalendar(fomcFixture));
    expect(events.get('2026-03-18')?.meta['hasProjections']).toBe(true);
    expect(events.get('2026-01-28')?.meta['hasProjections']).toBe(false);
  });

  it('resolves cross-month meetings (Jan/Feb "31-1") to day 2 of the SECOND month', () => {
    const events = byMeetingEnd(parseFomcCalendar(fomcFixture));
    const janFeb = events.get('2023-02-01');
    expect(janFeb?.scheduledAt.toISOString()).toBe('2023-02-01T19:00:00.000Z'); // EST
    expect(janFeb?.meta['meetingStart']).toBe('2023-01-31');
    // Oct/Nov 2023 is still EDT (DST ended Nov 5 2023).
    expect(events.get('2023-11-01')?.scheduledAt.toISOString()).toBe('2023-11-01T18:00:00.000Z');
  });

  it('skips the notation-vote row without dropping the rest of the panel', () => {
    const events = parseFomcCalendar(fomcFixture);
    const in2025 = events.filter((event) => event.meta['year'] === 2025);
    expect(in2025).toHaveLength(8);
    expect(events.some((event) => event.meta['meetingEnd'] === '2025-08-22')).toBe(false);
  });

  it('throws when the page has no year panels', () => {
    expect(() => parseFomcCalendar('<html><body><p>moved</p></body></html>')).toThrow(
      /no "<year> FOMC Meetings" panels/,
    );
  });

  it('throws on an unrecognized date cell (format drift, not silent skip)', () => {
    const mutated = fomcFixture.replace('>27-28<', '>27~28<');
    expect(() => parseFomcCalendar(mutated)).toThrow(/unrecognized date cell "27~28"/);
  });

  it('throws on descending days within a single month (cross-month without a label)', () => {
    const mutated = fomcFixture.replace('>27-28<', '>28-27<');
    expect(() => parseFomcCalendar(mutated)).toThrow(/descending days/);
  });

  it('throws when totals fall below the sanity floor', () => {
    expect(() => parseFomcCalendar(fomcFixture, { minTotal: 25 })).toThrow(/at least 25/);
    const tiny =
      '<h4><a id="1">2026 FOMC Meetings</a></h4>' +
      '<div class="fomc-meeting__month"><strong>January</strong></div>' +
      '<div class="fomc-meeting__date">27-28</div>';
    expect(() => parseFomcCalendar(tiny)).toThrow(/at least 8/);
  });

  it('throws when a year panel explodes past the per-year cap', () => {
    expect(() => parseFomcCalendar(fomcFixture, { maxPerYear: 7 })).toThrow(/max 7/);
  });
});

describe('parseBlsReleaseSchedule', () => {
  it('parses all 13 CPI releases with row-supplied times, DST-correct', () => {
    const events = parseBlsReleaseSchedule(cpiFixture, 'cpi');
    expect(events).toHaveLength(13);
    expect(events.every((event) => event.kind === 'cpi')).toBe(true);
    // Dec 18 2025 = EST: 08:30 ET → 13:30Z.
    expect(events[0]?.meta['referenceMonth']).toBe('November 2025');
    expect(events[0]?.scheduledAt.toISOString()).toBe('2025-12-18T13:30:00.000Z');
    // Mar 11 2026 = EDT: 08:30 ET → 12:30Z.
    const march = events.find((event) => event.meta['releaseDate'] === 'Mar. 11, 2026');
    expect(march?.scheduledAt.toISOString()).toBe('2026-03-11T12:30:00.000Z');
  });

  it('parses the Employment Situation page as nfp', () => {
    const events = parseBlsReleaseSchedule(empsitFixture, 'nfp');
    expect(events).toHaveLength(13);
    expect(events.every((event) => event.kind === 'nfp')).toBe(true);
    expect(events[0]?.scheduledAt.toISOString()).toBe('2025-12-16T13:30:00.000Z');
  });

  it('throws when the release-list table is missing', () => {
    expect(() => parseBlsReleaseSchedule('<html><body></body></html>', 'cpi')).toThrow(
      /no <table class="release-list">/,
    );
  });

  it('throws when a required header column disappears', () => {
    const mutated = cpiFixture.replace('<th>Release Date</th>', '<th>Publication Date</th>');
    expect(() => parseBlsReleaseSchedule(mutated, 'cpi')).toThrow(/header column "Release Date"/);
  });

  it('throws on an unparseable time cell', () => {
    const mutated = cpiFixture.replace('<td>08:30 AM</td>', '<td>08:30</td>');
    expect(() => parseBlsReleaseSchedule(mutated, 'cpi')).toThrow(/unparseable time "08:30"/);
  });

  it('throws on row counts outside the sanity bounds', () => {
    expect(() => parseBlsReleaseSchedule(cpiFixture, 'cpi', { minRows: 20 })).toThrow(
      /parsed 13 rows/,
    );
  });
});

describe('parseBeaSchedule', () => {
  it('parses quarterly GDP estimates and monthly PCE releases, ignoring other rows', () => {
    const events = parseBeaSchedule(beaFixture);
    const gdp = events.filter((event) => event.kind === 'gdp');
    const pce = events.filter((event) => event.kind === 'pce');
    expect(gdp).toHaveLength(6); // Advance/Second/Third × Q2 + Q3 2026
    expect(pce).toHaveLength(6); // June–November 2026 Personal Income and Outlays
    expect(events).toHaveLength(12);
    // "GDP by County…" and the dateless "To Be Announced" row must not leak in.
    expect(events.some((event) => String(event.meta['title']).startsWith('GDP by County'))).toBe(
      false,
    );
  });

  it('derives the year from the table header and converts 8:30 AM ET, DST-correct', () => {
    const events = parseBeaSchedule(beaFixture);
    const advanceQ2 = events.find(
      (event) => event.meta['title'] === 'GDP (Advance Estimate), 2nd Quarter 2026',
    );
    expect(advanceQ2?.scheduledAt.toISOString()).toBe('2026-07-30T12:30:00.000Z'); // EDT
    const pceNovember = events.find(
      (event) => event.meta['title'] === 'Personal Income and Outlays, November 2026',
    );
    expect(pceNovember?.scheduledAt.toISOString()).toBe('2026-12-23T13:30:00.000Z'); // EST
  });

  it('throws when the Year header is missing', () => {
    const mutated = beaFixture.replace('Year 2026', 'Calendar 2026');
    expect(() => parseBeaSchedule(mutated)).toThrow(/no "Year YYYY" table header/);
  });

  it('throws when a GDP/PCE row loses its date (TBA quarterly GDP = drift)', () => {
    const mutated = beaFixture.replace('<div class="release-date">July 30</div>', '');
    expect(() => parseBeaSchedule(mutated)).toThrow(/missing date\/time/);
  });

  it('throws when zero GDP/PCE rows match (title drift) and when no press rows exist', () => {
    const noMatches =
      '<table><thead><tr><th id="view-field-scheduled-release-date-1-table-column">Year 2026</th></tr></thead>' +
      '<tr class="scheduled-releases-type-press">' +
      '<td><div class="release-date">July 21</div><small class="text-muted">8:30 AM</small></td>' +
      '<td class="release-title views-field">Some Other Statistic, 2026</td></tr></table>';
    expect(() => parseBeaSchedule(noMatches)).toThrow(/zero GDP\/PCE rows/);

    const noRows =
      '<table><thead><tr><th id="view-field-scheduled-release-date-1-table-column">Year 2026</th></tr></thead></table>';
    expect(() => parseBeaSchedule(noRows)).toThrow(/no scheduled-releases-type-press rows/);
  });
});

describe('fetch wrappers', () => {
  it('fetches the schedule URL with the contact User-Agent and parses the body', async () => {
    let captured: { url?: string; init?: RequestInit | undefined } = {};
    const stub: FetchLike = async (url, init) => {
      captured = { url, init };
      return new Response(cpiFixture, { status: 200 });
    };
    const events = await fetchCpiSchedule({ fetchImpl: stub, userAgent: 'Test test@example.com' });
    expect(events).toHaveLength(13);
    expect(captured.url).toBe(BLS_CPI_SCHEDULE_URL);
    expect(new Headers(captured.init?.headers).get('user-agent')).toBe('Test test@example.com');
  });

  it('throws a descriptive error on non-2xx', async () => {
    const stub: FetchLike = async () => new Response('nope', { status: 503, statusText: 'oops' });
    await expect(fetchCpiSchedule({ fetchImpl: stub })).rejects.toThrow(/503/);
  });
});
