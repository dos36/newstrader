import { etWallTimeToUtc } from './et-time.js';
import { defaultFetch, fetchText, type FetchLike } from './http.js';

/**
 * Macro-calendar fetchers — FOMC meetings (federalreserve.gov), CPI + NFP
 * release schedules (bls.gov), GDP + PCE release schedules (bea.gov). These
 * feed scheduled_events and the deterministic `already_expected` /
 * `calendar_match` decision feature (architecture §6).
 *
 * All three parsers follow the universe/wikipedia.ts precedent: regex/string
 * slicing over verified live markup, DEFENSIVE rather than lenient — any
 * structural surprise (missing table/panel, unparseable date or time cell,
 * zero events, counts outside sanity bounds) throws a descriptive error
 * instead of syncing a partial calendar. A silently-empty calendar would make
 * every LLM `already_expected` judgment score as a miss.
 *
 * Machine-readable form choices (verified live 2026-07-11):
 * - FOMC: the calendar page's year panels (<h4>YYYY FOMC Meetings</h4> +
 *   fomc-meeting__month / fomc-meeting__date divs). No structured feed exists.
 * - BLS: the PER-RELEASE schedule pages (cpi.htm, empsit.htm), each a clean
 *   3-column `<table class="release-list">` covering ~13 months. Chosen over
 *   the per-year pages (2026_sched.htm 404s mid-year — verified) and over the
 *   ICS subscription (whole-bureau feed that would need release-name string
 *   filtering anyway; the per-release tables also carry the reference month).
 * - BEA: the news schedule page's single #release-schedule-table. It lists the
 *   REMAINING CURRENT YEAR only (header "Year 2026"); around New Year the
 *   forward horizon shrinks until BEA rolls the page. Accepted: syncs run
 *   daily and pick the new year up as soon as it is published.
 *
 * Times: BLS/BEA rows carry their release time (08:30 AM ET for CPI/NFP/GDP/
 * PCE); the FOMC statement is released at 14:00 ET on the meeting's final day.
 * All are converted DST-correctly via et-time.ts.
 *
 * Note on transport: bls.gov rejects curl's TLS fingerprint (403) but serves
 * Node's fetch/undici fine — verified 2026-07-11. A contact User-Agent is sent
 * when provided (same etiquette as the SEC/Wikipedia fetchers).
 */

export type MacroEventKind = 'fomc' | 'cpi' | 'nfp' | 'gdp' | 'pce';

export interface MacroEvent {
  kind: MacroEventKind;
  /** UTC instant of the release/statement. */
  scheduledAt: Date;
  meta: Record<string, unknown>;
}

export interface MacroFetchOptions {
  /** Contact User-Agent ("Name email@example.com"); sent when provided. */
  userAgent?: string | undefined;
  fetchImpl?: FetchLike;
}

// ------------------------------------------------------------------- FOMC --

export const FOMC_CALENDAR_URL = 'https://www.federalreserve.gov/monetarypolicy/fomccalendars.htm';

/** Statement release time on the meeting's final day, ET. */
export const FOMC_STATEMENT_ET = { hour: 14, minute: 0 } as const;

/**
 * Sanity bounds. The page lists ~6-7 year panels × 8 scheduled meetings; a
 * total below MIN_FOMC_TOTAL means the page drifted or the fetch truncated.
 * The per-year cap is loose (8/yr give or take) but catches row-explosion
 * drift; no per-year floor because a freshly-published future year can
 * legitimately start partial.
 */
export const MIN_FOMC_TOTAL = 8;
export const MAX_FOMC_PER_YEAR = 12;

export interface ParseFomcOptions {
  /** Bounds overrides; only for fixture tests. */
  minTotal?: number;
  maxPerYear?: number;
}

const FOMC_YEAR_PANEL_RE = /<h4[^>]*>\s*(?:<a[^>]*>)?\s*(\d{4}) FOMC Meetings/g;
const FOMC_ROW_RE =
  /fomc-meeting__month[^>]*>\s*<strong>([^<]+)<\/strong>[\s\S]*?fomc-meeting__date[^>]*>([^<]*)/g;
/** "27-28", "17-18*", "22", cross-month "31-1" (month cell then reads "Jan/Feb"). */
const FOMC_MEETING_DATE_RE = /^(\d{1,2})(?:-(\d{1,2}))?(\*)?$/;
/** "22 (notation vote)", "15 (unscheduled)" — not scheduled meetings; skipped. */
const FOMC_QUALIFIED_DATE_RE = /^\d{1,2}(?:-\d{1,2})?\*?\s*\([^)]+\)$/;
/** Distance guard between a month cell and its date cell (real rows: <200 chars). */
const FOMC_ROW_GAP_MAX = 500;

/**
 * Parse the FOMC calendar page into one event per scheduled meeting, anchored
 * at 14:00 ET on the meeting's FINAL day (the statement release). Rows with a
 * parenthesized qualifier ("(notation vote)", "(unscheduled)") are skipped —
 * they are not forward-scheduled market events. Throws on drift; see module doc.
 */
export function parseFomcCalendar(html: string, options?: ParseFomcOptions): MacroEvent[] {
  const minTotal = options?.minTotal ?? MIN_FOMC_TOTAL;
  const maxPerYear = options?.maxPerYear ?? MAX_FOMC_PER_YEAR;

  const panels = [...html.matchAll(FOMC_YEAR_PANEL_RE)];
  if (panels.length === 0) {
    throw new Error('FOMC calendar parse failed: no "<year> FOMC Meetings" panels in page HTML');
  }

  const events: MacroEvent[] = [];
  for (const [index, panel] of panels.entries()) {
    const year = Number(panel[1]);
    const start = panel.index;
    const end = index + 1 < panels.length ? panels[index + 1]?.index : html.length;
    const chunk = html.slice(start, end);

    let perYear = 0;
    for (const row of chunk.matchAll(FOMC_ROW_RE)) {
      const monthLabel = (row[1] ?? '').trim();
      const dateLabel = (row[2] ?? '').trim();
      if (row[0].length > FOMC_ROW_GAP_MAX) {
        throw new Error(
          `FOMC calendar parse failed: month/date cells ${row[0].length} chars apart in ` +
            `${year} panel — row pairing drift? Month: "${monthLabel}"`,
        );
      }
      if (FOMC_QUALIFIED_DATE_RE.test(dateLabel)) continue; // notation vote / unscheduled

      const dateMatch = FOMC_MEETING_DATE_RE.exec(dateLabel);
      if (dateMatch === null) {
        throw new Error(
          `FOMC calendar parse failed: unrecognized date cell "${dateLabel}" ` +
            `(${monthLabel} ${year}) — format drift.`,
        );
      }
      const day1 = Number(dateMatch[1]);
      const day2 = dateMatch[2] !== undefined ? Number(dateMatch[2]) : day1;
      const hasProjections = dateMatch[3] !== undefined;

      const monthParts = monthLabel.split('/');
      const startMonth = monthNumber(monthParts[0] ?? '', `FOMC ${year} month "${monthLabel}"`);
      const endMonth =
        monthParts.length === 2
          ? monthNumber(monthParts[1] ?? '', `FOMC ${year} month "${monthLabel}"`)
          : startMonth;
      if (monthParts.length > 2) {
        throw new Error(`FOMC calendar parse failed: month cell "${monthLabel}" — format drift.`);
      }
      // Within one month days must ascend; "31-1" is only valid across months.
      if (endMonth === startMonth && day2 < day1) {
        throw new Error(
          `FOMC calendar parse failed: descending days "${dateLabel}" in single month ` +
            `"${monthLabel}" ${year} — cross-month meeting without a Mon1/Mon2 label?`,
        );
      }

      const scheduledAt = etWallTimeToUtc({
        year,
        month: endMonth,
        day: day2,
        hour: FOMC_STATEMENT_ET.hour,
        minute: FOMC_STATEMENT_ET.minute,
      });
      events.push({
        kind: 'fomc',
        scheduledAt,
        meta: {
          monthLabel,
          dateLabel,
          year,
          hasProjections,
          meetingStart: isoDay(year, startMonth, day1),
          meetingEnd: isoDay(year, endMonth, day2),
        },
      });
      perYear += 1;
    }

    if (perYear > maxPerYear) {
      throw new Error(
        `FOMC calendar parse failed: ${perYear} meetings in ${year} panel, ` +
          `max ${maxPerYear} — format drift.`,
      );
    }
  }

  if (events.length < minTotal) {
    throw new Error(
      `FOMC calendar parse failed: ${events.length} meetings across ${panels.length} year ` +
        `panels, expected at least ${minTotal}. Page format drift or truncated fetch — ` +
        'refusing to sync a partial calendar.',
    );
  }
  return events;
}

/** Fetch the live FOMC calendar page and parse it (production bounds). */
export async function fetchFomcCalendar(options?: MacroFetchOptions): Promise<MacroEvent[]> {
  const html = await fetchCalendarPage(FOMC_CALENDAR_URL, options);
  return parseFomcCalendar(html);
}

// ------------------------------------------------------------ BLS (CPI/NFP) --

export const BLS_CPI_SCHEDULE_URL = 'https://www.bls.gov/schedule/news_release/cpi.htm';
export const BLS_EMPSIT_SCHEDULE_URL = 'https://www.bls.gov/schedule/news_release/empsit.htm';

/**
 * Sanity bounds on release-list rows: the per-release pages list ~13 months of
 * a monthly release.
 */
export const MIN_BLS_ROWS = 6;
export const MAX_BLS_ROWS = 40;

export type BlsKind = Extract<MacroEventKind, 'cpi' | 'nfp'>;

export interface ParseBlsOptions {
  /** Bounds overrides; only for fixture tests. */
  minRows?: number;
  maxRows?: number;
}

/** "Dec. 18, 2025" / "May 12, 2026". */
const BLS_DATE_RE = /^([A-Za-z]+)\.?\s+(\d{1,2}),\s+(\d{4})$/;
/** "08:30 AM". */
const AMPM_TIME_RE = /^(\d{1,2}):(\d{2})\s*(AM|PM)$/i;

/**
 * Parse a BLS per-release schedule page (`<table class="release-list">`,
 * columns Reference Month / Release Date / Release Time) into one event per
 * scheduled release. Throws on drift; see module doc.
 */
export function parseBlsReleaseSchedule(
  html: string,
  kind: BlsKind,
  options?: ParseBlsOptions,
): MacroEvent[] {
  const minRows = options?.minRows ?? MIN_BLS_ROWS;
  const maxRows = options?.maxRows ?? MAX_BLS_ROWS;

  const tableStart = html.indexOf('<table class="release-list">');
  if (tableStart === -1) {
    throw new Error(`BLS ${kind} schedule parse failed: no <table class="release-list"> in page`);
  }
  const tableEnd = html.indexOf('</table>', tableStart);
  if (tableEnd === -1) {
    throw new Error(`BLS ${kind} schedule parse failed: release-list table has no </table>`);
  }
  const table = html.slice(tableStart, tableEnd);

  const headers = [...table.matchAll(/<th[^>]*>([^<]*)<\/th>/g)].map((m) => (m[1] ?? '').trim());
  for (const required of ['Reference Month', 'Release Date', 'Release Time']) {
    if (!headers.includes(required)) {
      throw new Error(
        `BLS ${kind} schedule parse failed: header column "${required}" not found in ` +
          `[${headers.join(', ')}] — page format drift.`,
      );
    }
  }

  const events: MacroEvent[] = [];
  for (const rowChunk of table.split(/<tr\b[^>]*>/).slice(1)) {
    const cells = [...rowChunk.matchAll(/<td[^>]*>([^<]*)<\/td>/g)].map((m) => (m[1] ?? '').trim());
    if (cells.length === 0) continue; // header row
    if (cells.length < 3) {
      throw new Error(
        `BLS ${kind} schedule parse failed: row has ${cells.length} cells, need 3 — ` +
          `format drift? Row starts: ${rowChunk.slice(0, 120)}`,
      );
    }
    const [referenceMonth = '', dateText = '', timeText = ''] = cells;

    const dateMatch = BLS_DATE_RE.exec(dateText);
    if (dateMatch === null) {
      throw new Error(`BLS ${kind} schedule parse failed: unparseable release date "${dateText}"`);
    }
    const { hour, minute } = parseAmPmTime(timeText, `BLS ${kind} release time`);
    const scheduledAt = etWallTimeToUtc({
      year: Number(dateMatch[3]),
      month: monthNumber(dateMatch[1] ?? '', `BLS ${kind} release date "${dateText}"`),
      day: Number(dateMatch[2]),
      hour,
      minute,
    });
    events.push({
      kind,
      scheduledAt,
      meta: { referenceMonth, releaseDate: dateText, releaseTimeEt: timeText },
    });
  }

  if (events.length < minRows || events.length > maxRows) {
    throw new Error(
      `BLS ${kind} schedule parse failed: parsed ${events.length} rows, expected ` +
        `${minRows}-${maxRows}. Page format drift or truncated fetch — refusing to sync ` +
        'a partial calendar.',
    );
  }
  return events;
}

/** Fetch and parse the CPI release schedule. */
export async function fetchCpiSchedule(options?: MacroFetchOptions): Promise<MacroEvent[]> {
  const html = await fetchCalendarPage(BLS_CPI_SCHEDULE_URL, options);
  return parseBlsReleaseSchedule(html, 'cpi');
}

/** Fetch and parse the Employment Situation (NFP) release schedule. */
export async function fetchNfpSchedule(options?: MacroFetchOptions): Promise<MacroEvent[]> {
  const html = await fetchCalendarPage(BLS_EMPSIT_SCHEDULE_URL, options);
  return parseBlsReleaseSchedule(html, 'nfp');
}

// ------------------------------------------------------------ BEA (GDP/PCE) --

export const BEA_SCHEDULE_URL = 'https://www.bea.gov/news/schedule';

/**
 * Only the market-moving quarterly GDP estimates and the monthly Personal
 * Income and Outlays (PCE) release are calendar events; the page's other rows
 * (trade, regional, investment statistics) are ignored. "GDP by County…"
 * deliberately does NOT match the GDP pattern.
 */
const BEA_GDP_TITLE_RE = /^GDP \((Advance|Second|Third) Estimate\)/;
const BEA_PCE_TITLE_RE = /^Personal Income and Outlays, /;

const BEA_YEAR_HEADER_RE =
  /<th[^>]*id="view-field-scheduled-release-date[^"]*"[^>]*>\s*Year (\d{4})\s*</;
const BEA_PRESS_ROW_RE = /<tr class="scheduled-releases-type-press">([\s\S]*?)<\/tr>/g;
/** "July 21". */
const BEA_DATE_RE = /^([A-Za-z]+)\.?\s+(\d{1,2})$/;

/**
 * Parse the BEA news release schedule into GDP + PCE events. The year comes
 * from the table header ("Year 2026" — the page lists the remaining current
 * year only; see module doc for the New-Year horizon caveat). Throws on drift.
 */
export function parseBeaSchedule(html: string): MacroEvent[] {
  const yearMatch = BEA_YEAR_HEADER_RE.exec(html);
  if (yearMatch === null) {
    throw new Error('BEA schedule parse failed: no "Year YYYY" table header — format drift.');
  }
  const year = Number(yearMatch[1]);

  const rows = [...html.matchAll(BEA_PRESS_ROW_RE)];
  if (rows.length === 0) {
    throw new Error('BEA schedule parse failed: no scheduled-releases-type-press rows in page');
  }

  const events: MacroEvent[] = [];
  for (const row of rows) {
    const chunk = row[1] ?? '';
    const title = cleanBeaText(/release-title[^>]*>([^<]*)/.exec(chunk)?.[1]);
    if (title === '') {
      throw new Error(
        `BEA schedule parse failed: press row missing release-title — format drift? ` +
          `Row starts: ${chunk.slice(0, 160)}`,
      );
    }

    // Kind BEFORE date/time: rows we don't care about ("Outdoor Recreation
    // Economic Statistics") can legitimately be "To Be Announced" with no
    // release-date div at all (verified live 2026-07-11).
    let kind: MacroEventKind;
    if (BEA_GDP_TITLE_RE.test(title)) kind = 'gdp';
    else if (BEA_PCE_TITLE_RE.test(title)) kind = 'pce';
    else continue; // other BEA statistics — not calendar events for us

    const dateText = cleanBeaText(/<div class="release-date">([^<]*)<\/div>/.exec(chunk)?.[1]);
    const timeText = cleanBeaText(/<small class="text-muted">([^<]*)<\/small>/.exec(chunk)?.[1]);
    if (dateText === '' || timeText === '') {
      throw new Error(
        `BEA schedule parse failed: GDP/PCE row "${title}" missing date/time — a To-Be-` +
          'Announced quarterly release is drift worth a human look.',
      );
    }

    const dateMatch = BEA_DATE_RE.exec(dateText);
    if (dateMatch === null) {
      throw new Error(`BEA schedule parse failed: unparseable release date "${dateText}"`);
    }
    const { hour, minute } = parseAmPmTime(timeText, `BEA release time for "${title}"`);
    const scheduledAt = etWallTimeToUtc({
      year,
      month: monthNumber(dateMatch[1] ?? '', `BEA release date "${dateText}"`),
      day: Number(dateMatch[2]),
      hour,
      minute,
    });
    events.push({
      kind,
      scheduledAt,
      meta: { title, releaseDate: dateText, releaseTimeEt: timeText, year },
    });
  }

  if (events.length === 0) {
    throw new Error(
      'BEA schedule parse failed: zero GDP/PCE rows matched — title format drift, or the ' +
        'page rolled to a new year with no releases published yet. Refusing to sync silence.',
    );
  }
  return events;
}

/** Fetch and parse the BEA news release schedule. */
export async function fetchBeaSchedule(options?: MacroFetchOptions): Promise<MacroEvent[]> {
  const html = await fetchCalendarPage(BEA_SCHEDULE_URL, options);
  return parseBeaSchedule(html);
}

// ---------------------------------------------------------------- internals --

async function fetchCalendarPage(url: string, options?: MacroFetchOptions): Promise<string> {
  const fetchImpl = options?.fetchImpl ?? defaultFetch;
  const userAgent = options?.userAgent?.trim();
  return fetchText(fetchImpl, url, {
    headers: {
      Accept: 'text/html',
      ...(userAgent !== undefined && userAgent.length > 0 ? { 'User-Agent': userAgent } : {}),
    },
  });
}

const MONTH_PREFIXES = [
  'jan',
  'feb',
  'mar',
  'apr',
  'may',
  'jun',
  'jul',
  'aug',
  'sep',
  'oct',
  'nov',
  'dec',
] as const;

/** "January"/"Jan"/"Sept" → 1-based month. Throws on anything unrecognized. */
function monthNumber(label: string, context: string): number {
  const trimmed = label.trim();
  const index = /^[A-Za-z]{3,9}$/.test(trimmed)
    ? MONTH_PREFIXES.indexOf(trimmed.slice(0, 3).toLowerCase() as (typeof MONTH_PREFIXES)[number])
    : -1;
  if (index === -1) {
    throw new Error(`Calendar parse failed: unrecognized month "${label}" (${context})`);
  }
  return index + 1;
}

/** "08:30 AM" → 24h ET wall-clock parts. Throws on anything unrecognized. */
function parseAmPmTime(text: string, context: string): { hour: number; minute: number } {
  const match = AMPM_TIME_RE.exec(text.trim());
  if (match === null) {
    throw new Error(`Calendar parse failed: unparseable time "${text}" (${context})`);
  }
  const rawHour = Number(match[1]);
  if (rawHour < 1 || rawHour > 12) {
    throw new Error(`Calendar parse failed: unparseable time "${text}" (${context})`);
  }
  const pm = (match[3] ?? '').toUpperCase() === 'PM';
  return { hour: (rawHour % 12) + (pm ? 12 : 0), minute: Number(match[2]) };
}

function isoDay(year: number, month: number, day: number): string {
  return `${year}-${String(month).padStart(2, '0')}-${String(day).padStart(2, '0')}`;
}

function cleanBeaText(text: string | undefined): string {
  return (text ?? '').replace(/\s+/g, ' ').trim();
}
