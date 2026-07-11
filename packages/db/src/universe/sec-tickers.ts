import { z } from 'zod';

import { defaultFetch, type FetchLike } from './http.js';

/**
 * SEC company_tickers.json → ticker → { cik, title } map.
 *
 * File shape (verified live 2026-07-10): a JSON object keyed by arbitrary
 * string indexes, values { cik_str: number, ticker: string, title: string }
 * (~9.3k entries). SEC fair-access rules apply to www.sec.gov files exactly as
 * to EDGAR: requests without a contact User-Agent are 403'd, so the fetch
 * refuses to run without one (mirrors EdgarAdapter in packages/adapters).
 *
 * CIK authority: on Wikipedia-vs-SEC CIK conflicts, SEC wins — sync uses this
 * map's CIK whenever the ticker is found here.
 *
 * Symbol convention: SEC prints class shares with a dash (BRK-B) where
 * Wikipedia/Massive use a dot (BRK.B). `lookupSecTicker` tries the symbol
 * verbatim first, then the dot→dash form.
 */

export const SEC_COMPANY_TICKERS_URL = 'https://www.sec.gov/files/company_tickers.json';

const SecTickerEntry = z.object({
  cik_str: z.number().int().positive(),
  ticker: z.string().min(1),
  title: z.string(),
});

const SecTickersFile = z.record(z.string(), SecTickerEntry);

export interface SecTickerInfo {
  /** Zero-padded 10-digit CIK. */
  cik: string;
  /** SEC registrant title (often uppercase: "BERKSHIRE HATHAWAY INC"). */
  title: string;
}

/** Keyed by uppercased ticker exactly as SEC prints it (dash form: BRK-B). */
export type SecTickerMap = Map<string, SecTickerInfo>;

/** zod-parse the raw file payload into the ticker map. Throws on shape drift. */
export function parseSecTickers(payload: unknown): SecTickerMap {
  const file = SecTickersFile.parse(payload);
  const map: SecTickerMap = new Map();
  for (const entry of Object.values(file)) {
    const ticker = entry.ticker.toUpperCase();
    // The file lists some CIKs under multiple tickers (GOOG/GOOGL) but a
    // ticker at most once; keep the first occurrence if that ever changes.
    if (map.has(ticker)) continue;
    map.set(ticker, {
      cik: String(entry.cik_str).padStart(10, '0'),
      title: entry.title,
    });
  }
  return map;
}

/** Lookup tolerant of the dot-vs-dash class-share convention (BRK.B → BRK-B). */
export function lookupSecTicker(map: SecTickerMap, symbol: string): SecTickerInfo | undefined {
  const upper = symbol.toUpperCase();
  return map.get(upper) ?? map.get(upper.replace(/\./g, '-'));
}

export interface FetchSecTickersOptions {
  /** Value of env EDGAR_USER_AGENT. Mandatory — SEC 403s anonymous clients. */
  userAgent: string | undefined;
  fetchImpl?: FetchLike;
}

/** Fetch and parse the live file. */
export async function fetchSecTickerMap(options: FetchSecTickersOptions): Promise<SecTickerMap> {
  const userAgent = options.userAgent?.trim();
  if (userAgent === undefined || userAgent.length === 0) {
    throw new Error(
      'EDGAR_USER_AGENT is not set. SEC fair-access rules require a User-Agent with ' +
        'contact info ("Name email@example.com"); anonymous requests are rejected with 403.',
    );
  }
  const fetchImpl = options.fetchImpl ?? defaultFetch;
  const res = await fetchImpl(SEC_COMPANY_TICKERS_URL, {
    headers: { 'User-Agent': userAgent, Accept: 'application/json' },
  });
  if (!res.ok) {
    throw new Error(`GET ${SEC_COMPANY_TICKERS_URL} failed: ${res.status} ${res.statusText}`);
  }
  return parseSecTickers((await res.json()) as unknown);
}
