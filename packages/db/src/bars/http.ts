/**
 * Minimal fetch seam for the bars fetchers (Massive snapshot/aggregates,
 * Kraken public OHLC).
 *
 * Deliberately duplicated from packages/db/src/universe/http.ts (which itself
 * duplicates packages/adapters/src/http.ts): each module owns its 15-line seam
 * so parsers stay testable against fixtures with zero network access and no
 * cross-module coupling.
 */

export type FetchLike = (url: string, init?: RequestInit) => Promise<Response>;

export const DEFAULT_TIMEOUT_MS = 30_000;

export const defaultFetch: FetchLike = (url, init) =>
  fetch(url, { ...init, signal: AbortSignal.timeout(DEFAULT_TIMEOUT_MS) });

/** GET a URL and return the parsed JSON body, throwing a descriptive error on non-2xx. */
export async function fetchJson(
  fetchImpl: FetchLike,
  url: string,
  init?: RequestInit,
): Promise<unknown> {
  const res = await fetchImpl(url, init);
  if (!res.ok) {
    throw new Error(`GET ${url} failed: ${res.status} ${res.statusText}`);
  }
  return (await res.json()) as unknown;
}
