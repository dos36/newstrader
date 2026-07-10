import type { SourceAdapter } from '@newstrader/core';

import { edgarAdapters } from './edgar.js';
import type { FetchLike } from './http.js';
import { massiveNewsAdapter } from './massive-news.js';
import { rssPresetAdapters } from './rss.js';

export * from './edgar.js';
export * from './http.js';
export * from './massive-news.js';
export * from './raw-store.js';
export * from './rss.js';

/**
 * Registry: every enabled source adapter for the current environment.
 *
 * Per-adapter enablement is graceful at this level — a missing key disables
 * that family with a warning instead of throwing, so local dev with a partial
 * .env still polls whatever is configured. (Constructing an individual adapter
 * without its mandatory env still throws; the leniency lives only here.)
 */
export function allAdapters(
  env: Record<string, string | undefined> = process.env,
  fetchImpl?: FetchLike,
): SourceAdapter[] {
  const adapters: SourceAdapter[] = [...rssPresetAdapters(fetchImpl)];

  if (env['EDGAR_USER_AGENT']?.trim()) {
    adapters.push(...edgarAdapters(env, fetchImpl));
  } else {
    console.warn(
      '[adapters] EDGAR_USER_AGENT unset — skipping EDGAR adapters (SEC requires a contact User-Agent).',
    );
  }

  if (env['MASSIVE_API_KEY']?.trim()) {
    adapters.push(massiveNewsAdapter(env, fetchImpl));
  } else {
    console.warn('[adapters] MASSIVE_API_KEY unset — skipping the Massive news adapter.');
  }

  return adapters;
}
