import { z } from 'zod';

import { defaultFetch, fetchJson, type FetchLike } from './http.js';
import type { ParsedBar } from './massive-bars.js';

/**
 * Kraken public OHLC client — GET https://api.kraken.com/0/public/OHLC
 * (public, no auth, no account).
 *
 * Verified live 2026-07-11:
 * - pair=XBTUSD answers under result key "XXBTZUSD", pair=ETHUSD under
 *   "XETHZUSD", pair=SOLUSD under "SOLUSD" — the response key does NOT equal
 *   the requested pair, so the parser takes the single non-"last" result key
 *   and throws if there is not exactly one.
 * - Rows are [time(sec, number), open, high, low, close, vwap, volume (all
 *   strings), count(number)] — prices arrive as decimal STRINGS already,
 *   which is exactly what the numeric columns want; they are stored verbatim.
 * - `result.last` equals the open time of the most recent COMMITTED candle;
 *   the trailing row (time > last) is the current, still-forming candle.
 *   That row is DROPPED: upserts are ON CONFLICT DO NOTHING, so persisting an
 *   in-progress candle would freeze a wrong partial bar forever.
 * - The endpoint returns at most ~720 candles (verified: 721 rows incl. the
 *   in-progress one). At interval=1 that is ~12 h of minute bars — fine for
 *   the 15-min recorder cadence, USELESS for deep backfill (architecture
 *   §5.5: crypto history comes from Kraken CSVs/Trades, not OHLC). At
 *   interval=1440 it is ~2 years of dailies — plenty for the ~90 d beta
 *   window. Daily candles align to UTC midnight (verified).
 */

export const KRAKEN_OHLC_URL = 'https://api.kraken.com/0/public/OHLC';

export const SOURCE_KRAKEN = 'kraken';

/** Universe symbol → Kraken pair query value (USD quotes; architecture §3). */
export const KRAKEN_PAIRS = {
  BTC: 'XBTUSD',
  ETH: 'ETHUSD',
  SOL: 'SOLUSD',
} as const;

export type KrakenSymbol = keyof typeof KRAKEN_PAIRS;

export function isKrakenSymbol(symbol: string): symbol is KrakenSymbol {
  return symbol in KRAKEN_PAIRS;
}

/** 1 = minute candles (recorder), 1440 = daily candles (beta/benchmark window). */
export type KrakenInterval = 1 | 1440;

/** Kraken prints prices/volumes as plain decimal strings; anything else is drift. */
const DECIMAL_STRING = z.string().regex(/^\d+(?:\.\d+)?$/);

const KrakenOhlcRow = z.tuple([
  z.number().int(), // candle open time, Unix SECONDS
  DECIMAL_STRING, // open
  DECIMAL_STRING, // high
  DECIMAL_STRING, // low
  DECIMAL_STRING, // close
  DECIMAL_STRING, // vwap (unused — schema has no vwap column)
  DECIMAL_STRING, // volume
  z.number(), // trade count (unused)
]);

const KrakenEnvelope = z.object({
  error: z.array(z.string()),
  result: z.record(z.string(), z.unknown()).optional(),
});

const MINUTE_S = 60;
const DAY_S = 86_400;

/**
 * Parse an OHLC payload into committed bars, oldest first. Throws on: a
 * non-empty error array, a missing result, not-exactly-one pair key, tuple
 * shape drift, misaligned candle times, or a missing/invalid `last` marker.
 */
export function parseKrakenOhlc(payload: unknown, interval: KrakenInterval): ParsedBar[] {
  const envelope = KrakenEnvelope.parse(payload);
  if (envelope.error.length > 0) {
    throw new Error(`Kraken OHLC returned errors: ${envelope.error.join('; ')}`);
  }
  if (envelope.result === undefined) {
    throw new Error('Kraken OHLC response has no result object — format drift?');
  }
  const pairKeys = Object.keys(envelope.result).filter((key) => key !== 'last');
  const pairKey = pairKeys[0];
  if (pairKey === undefined || pairKeys.length !== 1) {
    throw new Error(
      `Kraken OHLC result has ${pairKeys.length} pair keys [${pairKeys.join(', ')}], expected exactly 1`,
    );
  }
  const last = z.number().int().parse(envelope.result['last']);
  const rows = z.array(KrakenOhlcRow).parse(envelope.result[pairKey]);

  const alignment = interval === 1 ? MINUTE_S : DAY_S;
  const bars: ParsedBar[] = [];
  for (const row of rows) {
    const [time, open, high, low, close, , volume] = row;
    // time > last = the still-forming candle; DO-NOTHING upserts must never see it.
    if (time > last) continue;
    if (time % alignment !== 0) {
      throw new Error(
        `Kraken candle time ${time} is not aligned to interval=${interval} — format drift?`,
      );
    }
    bars.push({ ts: new Date(time * 1000), open, high, low, close, volume });
  }
  return bars;
}

export interface KrakenFetchOptions {
  fetchImpl?: FetchLike;
}

export interface FetchKrakenOhlcParams {
  symbol: KrakenSymbol;
  interval: KrakenInterval;
  /** Optional Unix-seconds floor (Kraken still caps the reply at ~720 candles). */
  since?: number;
}

/** Fetch and parse committed OHLC candles for one of the universe coins. */
export async function fetchKrakenOhlc(
  options: KrakenFetchOptions,
  params: FetchKrakenOhlcParams,
): Promise<ParsedBar[]> {
  const fetchImpl = options.fetchImpl ?? defaultFetch;
  const url = new URL(KRAKEN_OHLC_URL);
  url.searchParams.set('pair', KRAKEN_PAIRS[params.symbol]);
  url.searchParams.set('interval', String(params.interval));
  if (params.since !== undefined) {
    url.searchParams.set('since', String(params.since));
  }
  const payload = await fetchJson(fetchImpl, url.toString(), {
    headers: { Accept: 'application/json' },
  });
  return parseKrakenOhlc(payload, params.interval);
}
