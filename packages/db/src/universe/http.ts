/**
 * Minimal fetch seam for the universe fetchers (Wikipedia S&P 500 page, SEC
 * company_tickers.json).
 *
 * Deliberately duplicated from packages/adapters/src/http.ts instead of
 * imported: @newstrader/db does not depend on @newstrader/adapters, and a
 * universe sync must not pull in the whole source-adapter package for a
 * 15-line seam. Same contract — injectable `FetchLike` so parsers are testable
 * against fixtures with zero network access.
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
