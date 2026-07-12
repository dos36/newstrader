/**
 * Eastern-Time wall-clock → UTC instant conversion for calendar sources.
 *
 * Every US macro/earnings calendar publishes wall-clock ET ("08:30 AM",
 * "2:00 PM statement") without a date-dependent offset, so the conversion must
 * be DST-correct: 08:30 ET is 13:30Z in winter (EST, UTC-5) and 12:30Z in
 * summer (EDT, UTC-4). Rather than hardcoding US DST transition rules, the
 * offset comes from the Intl API's America/New_York data (IANA tzdb shipped
 * with Node's full-icu), via the standard two-pass fixed-point trick:
 * format the candidate instant in the target zone, measure the offset, and
 * re-derive. Calendar times (08:30 / 14:00 / 16:30 ET) never fall inside the
 * 02:00–03:00 transition window, so two passes always converge.
 */

const ET_ZONE = 'America/New_York';

/** Zone offset in minutes at an instant (ET: -300 for EST, -240 for EDT). */
export function zoneOffsetMinutes(at: Date, timeZone: string): number {
  const dtf = new Intl.DateTimeFormat('en-US', {
    timeZone,
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
    second: '2-digit',
    hour12: false,
  });
  const parts = new Map(dtf.formatToParts(at).map((p) => [p.type, p.value]));
  const get = (type: Intl.DateTimeFormatPartTypes): number => {
    const value = parts.get(type);
    if (value === undefined) {
      throw new Error(`zoneOffsetMinutes: Intl part "${type}" missing for zone ${timeZone}`);
    }
    return Number(value);
  };
  // hour is formatted "24" at midnight by some ICU versions; normalize.
  const asIfUtc = Date.UTC(
    get('year'),
    get('month') - 1,
    get('day'),
    get('hour') % 24,
    get('minute'),
    get('second'),
  );
  return Math.round((asIfUtc - at.getTime()) / 60_000);
}

export interface EtWallTime {
  year: number;
  /** 1-based calendar month. */
  month: number;
  day: number;
  /** 24h wall-clock hour in ET. */
  hour: number;
  minute: number;
}

/**
 * Convert an ET wall-clock time to its UTC instant, DST-correct via the IANA
 * zone data. Throws on impossible calendar dates (Feb 30) instead of letting
 * Date.UTC roll them over into the next month.
 */
export function etWallTimeToUtc(wall: EtWallTime): Date {
  assertValidCalendarDate(wall);
  const asIfUtc = Date.UTC(wall.year, wall.month - 1, wall.day, wall.hour, wall.minute);
  // Pass 1: measure the offset near the target instant (EST guess is fine).
  const firstOffset = zoneOffsetMinutes(new Date(asIfUtc), ET_ZONE);
  const candidate = new Date(asIfUtc - firstOffset * 60_000);
  // Pass 2: the corrected instant may sit on the other side of a transition.
  const secondOffset = zoneOffsetMinutes(candidate, ET_ZONE);
  return secondOffset === firstOffset ? candidate : new Date(asIfUtc - secondOffset * 60_000);
}

function assertValidCalendarDate(wall: EtWallTime): void {
  const { year, month, day, hour, minute } = wall;
  if (month < 1 || month > 12 || day < 1 || day > 31 || hour < 0 || hour > 23) {
    throw new Error(`etWallTimeToUtc: out-of-range wall time ${JSON.stringify(wall)}`);
  }
  if (minute < 0 || minute > 59) {
    throw new Error(`etWallTimeToUtc: out-of-range wall time ${JSON.stringify(wall)}`);
  }
  const probe = new Date(Date.UTC(year, month - 1, day));
  if (probe.getUTCFullYear() !== year || probe.getUTCMonth() !== month - 1) {
    throw new Error(
      `etWallTimeToUtc: impossible calendar date ${year}-${month}-${day} (month rollover)`,
    );
  }
  if (probe.getUTCDate() !== day) {
    throw new Error(
      `etWallTimeToUtc: impossible calendar date ${year}-${month}-${day} (day rollover)`,
    );
  }
}
