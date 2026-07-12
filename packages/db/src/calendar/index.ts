/**
 * Calendar layer — scheduled macro/earnings events (scheduled_events) and the
 * deterministic `already_expected` / `calendar_match` feature. Wiring: add
 * `export * from './calendar/index.js';` to packages/db/src/index.ts.
 *
 * ./http.js is deliberately NOT re-exported: universe/index.ts already exports
 * the identically-named seam (FetchLike, defaultFetch, fetchText), and two
 * `export *` sources for one name would make it ambiguous and silently DROP it
 * from the package surface. The structural FetchLike type is identical, so
 * fetchImpl injection works with the universe export.
 */
export * from './calendar-repo.js';
export * from './et-time.js';
export * from './finnhub-earnings.js';
export * from './macro.js';
export * from './match.js';
