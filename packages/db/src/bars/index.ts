/**
 * Bars layer — Massive snapshot/aggregates + Kraken OHLC clients, the
 * immutable price_bars_* repository, event-window backfill, and benchmark
 * seeds. Wiring: add `export * from './bars/index.js';` to
 * packages/db/src/index.ts.
 *
 * ./http.js is deliberately NOT re-exported: universe/index.ts already
 * star-exports its own identical seam (FetchLike, defaultFetch,
 * DEFAULT_TIMEOUT_MS), and two star-exports of the same names from the
 * package root would silently drop both. Import the seam from
 * './bars/http.js' directly inside the package.
 */
export * from './bars-repo.js';
export * from './benchmarks.js';
export * from './decimal.js';
export * from './kraken-bars.js';
export * from './massive-bars.js';
export * from './windows.js';
