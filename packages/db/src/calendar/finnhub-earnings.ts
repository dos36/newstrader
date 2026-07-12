import { z } from 'zod';

import { etWallTimeToUtc } from './et-time.js';
import { defaultFetch, type FetchLike } from './http.js';

/**
 * Finnhub earnings-calendar source — GET /api/v1/calendar/earnings?from&to.
 *
 * Response shape verified against Finnhub's OpenAPI definition + sample
 * response (finnhub.io/docs/api/earnings-calendar, captured 2026-07-11):
 * envelope { earningsCalendar: EarningRelease[] }, release fields date
 * (YYYY-MM-DD), symbol, hour ("bmo" | "amc" | "dmh" | empty), year, quarter,
 * epsActual/epsEstimate/revenueActual/revenueEstimate (nullable numbers).
 *
 * Auth: the key is sent as the `X-Finnhub-Token` header — Finnhub's documented
 * equivalent of the `token` query param — keeping the secret out of URLs and
 * logs (same discipline as the Massive adapter's Authorization: Bearer).
 *
 * OPTIONAL source: constructing the class without FINNHUB_API_KEY throws, but
 * the sync-level deps factory (calendar-repo.ts) skips the source with a
 * console.warn instead, mirroring allAdapters in packages/adapters.
 *
 * scheduledAt convention (ET wall clock, DST-correct via et-time.ts):
 *   bmo (before market open)  → 08:30 ET
 *   amc (after market close)  → 16:30 ET
 *   dmh (during market hours) → 12:00 ET
 *   missing/empty hour        → 16:30 ET (amc is the dominant slot; the raw
 *                               hour value is preserved in meta for analytics)
 * Any OTHER non-empty hour value is format drift and throws. The convention
 * only anchors the `already_expected` tolerance window — it is not a trading
 * timestamp.
 */

export const FINNHUB_BASE_URL = 'https://finnhub.io';

const EARNINGS_HOUR_ET: Record<string, { hour: number; minute: number }> = {
  bmo: { hour: 8, minute: 30 },
  amc: { hour: 16, minute: 30 },
  dmh: { hour: 12, minute: 0 },
  '': { hour: 16, minute: 30 },
};

const FinnhubEarningsRelease = z
  .object({
    date: z.string().regex(/^\d{4}-\d{2}-\d{2}$/),
    symbol: z.string().min(1),
    hour: z.string().nullish(),
    year: z.number().nullish(),
    quarter: z.number().nullish(),
    epsActual: z.number().nullish(),
    epsEstimate: z.number().nullish(),
    revenueActual: z.number().nullish(),
    revenueEstimate: z.number().nullish(),
  })
  .passthrough();

const FinnhubEarningsResponse = z
  .object({ earningsCalendar: z.array(FinnhubEarningsRelease) })
  .passthrough();

const ISO_DAY_RE = /^\d{4}-\d{2}-\d{2}$/;

export interface EarningsCalendarEntry {
  /** Finnhub symbol, verbatim (dot form for class shares: BRK.B). */
  symbol: string;
  /** UTC instant per the hour convention above. */
  scheduledAt: Date;
  meta: Record<string, unknown>;
}

export interface EarningsDateRange {
  /** Inclusive YYYY-MM-DD. */
  from: string;
  to: string;
}

export interface FinnhubEarningsOptions {
  /** Value of env FINNHUB_API_KEY. Mandatory here; optionality lives in the deps factory. */
  apiKey: string | undefined;
  baseUrl?: string | undefined;
  fetchImpl?: FetchLike;
}

export class FinnhubEarningsSource {
  private readonly apiKey: string;
  private readonly baseUrl: string;
  private readonly fetchImpl: FetchLike;

  constructor(options: FinnhubEarningsOptions) {
    const apiKey = options.apiKey?.trim();
    if (apiKey === undefined || apiKey.length === 0) {
      throw new Error('FINNHUB_API_KEY is not set — required for the Finnhub earnings source.');
    }
    this.apiKey = apiKey;
    this.baseUrl = options.baseUrl ?? FINNHUB_BASE_URL;
    this.fetchImpl = options.fetchImpl ?? defaultFetch;
  }

  async fetchEarnings(range: EarningsDateRange): Promise<EarningsCalendarEntry[]> {
    if (!ISO_DAY_RE.test(range.from) || !ISO_DAY_RE.test(range.to)) {
      throw new Error(
        `Finnhub earnings range must be YYYY-MM-DD, got from="${range.from}" to="${range.to}"`,
      );
    }
    const url = new URL('/api/v1/calendar/earnings', this.baseUrl);
    url.searchParams.set('from', range.from);
    url.searchParams.set('to', range.to);

    const res = await this.fetchImpl(url.toString(), {
      headers: { 'X-Finnhub-Token': this.apiKey, Accept: 'application/json' },
    });
    if (!res.ok) {
      throw new Error(`Finnhub earnings request failed: ${res.status} ${res.statusText}`);
    }
    const entries = this.parseResponse((await res.json()) as unknown);
    if (entries.length === 0) {
      // A multi-week window over the whole US market is never legitimately
      // empty; zero means a broken query/entitlement, not a quiet calendar.
      throw new Error(
        `Finnhub earnings returned zero releases for ${range.from}..${range.to} — ` +
          'refusing to sync silence.',
      );
    }
    return entries;
  }

  /** Pure parse step, exposed for fixture tests. Throws on shape/hour drift. */
  parseResponse(payload: unknown): EarningsCalendarEntry[] {
    const response = FinnhubEarningsResponse.parse(payload);

    return response.earningsCalendar.map((release) => {
      const rawHour = release.hour ?? '';
      const slot = EARNINGS_HOUR_ET[rawHour];
      if (slot === undefined) {
        throw new Error(
          `Finnhub earnings parse failed: unrecognized hour "${rawHour}" for ` +
            `${release.symbol} ${release.date} — format drift.`,
        );
      }
      const [year = 0, month = 0, day = 0] = release.date.split('-').map(Number);
      const scheduledAt = etWallTimeToUtc({ year, month, day, ...slot });

      const meta: Record<string, unknown> = { date: release.date, hour: rawHour };
      if (release.year !== undefined && release.year !== null) meta['fiscalYear'] = release.year;
      if (release.quarter !== undefined && release.quarter !== null) {
        meta['fiscalQuarter'] = release.quarter;
      }
      if (release.epsEstimate !== undefined && release.epsEstimate !== null) {
        meta['epsEstimate'] = release.epsEstimate;
      }
      if (release.revenueEstimate !== undefined && release.revenueEstimate !== null) {
        meta['revenueEstimate'] = release.revenueEstimate;
      }
      return { symbol: release.symbol, scheduledAt, meta };
    });
  }
}

/** Factory reading env (FINNHUB_API_KEY, FINNHUB_BASE_URL). Throws without the key. */
export function finnhubEarningsSource(
  env: Record<string, string | undefined>,
  fetchImpl?: FetchLike,
): FinnhubEarningsSource {
  return new FinnhubEarningsSource({
    apiKey: env['FINNHUB_API_KEY'],
    baseUrl: env['FINNHUB_BASE_URL'],
    ...(fetchImpl !== undefined ? { fetchImpl } : {}),
  });
}
