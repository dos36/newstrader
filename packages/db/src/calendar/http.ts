/**
 * Minimal fetch seam for the calendar fetchers (Fed FOMC page, BLS release
 * schedules, BEA schedule, Finnhub earnings calendar).
 *
 * Deliberately duplicated from packages/db/src/universe/http.ts (which itself
 * duplicates packages/adapters/src/http.ts): each module owns its own 15-line
 * seam instead of creating cross-module coupling. Same contract — injectable
 * `FetchLike` so parsers are testable against fixtures with zero network
 * access.
 */

export type FetchLike = (url: string, init?: RequestInit) => Promise<Response>;

export const DEFAULT_TIMEOUT_MS = 30_000;

export const defaultFetch: FetchLike = (url, init) =>
  fetch(url, { ...init, signal: AbortSignal.timeout(DEFAULT_TIMEOUT_MS) });

/** GET a URL and return the body text, throwing a descriptive error on non-2xx. */
export async function fetchText(
  fetchImpl: FetchLike,
  url: string,
  init?: RequestInit,
): Promise<string> {
  const res = await fetchImpl(url, init);
  if (!res.ok) {
    throw new Error(`GET ${url} failed: ${res.status} ${res.statusText}`);
  }
  return res.text();
}
