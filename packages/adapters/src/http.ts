/**
 * Minimal fetch seam shared by all adapters.
 *
 * Adapters take an injectable `FetchLike` so parsing/cursor logic is testable
 * against fixtures with zero network access. The default implementation is the
 * Node 20 global fetch with a hard request timeout.
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
