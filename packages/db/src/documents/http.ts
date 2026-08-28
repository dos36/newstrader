/**
 * Minimal fetch seam for the EDGAR filing-document fetcher.
 *
 * Deliberately duplicated from packages/db/src/calendar/http.ts (which itself
 * duplicates universe/http.ts and packages/adapters/src/http.ts): each module
 * owns its own 15-line seam instead of creating cross-module coupling. Same
 * contract — injectable `FetchLike` so the selectors and the flattening logic
 * are testable against fixtures with zero network access.
 */

export type FetchLike = (url: string, init?: RequestInit) => Promise<Response>;

export const DEFAULT_TIMEOUT_MS = 30_000;

export const defaultFetch: FetchLike = (url, init) =>
  fetch(url, { ...init, signal: AbortSignal.timeout(DEFAULT_TIMEOUT_MS) });
