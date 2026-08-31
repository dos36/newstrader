import { describe, expect, it, vi } from 'vitest';

import { allAdapters } from './index.js';

/**
 * The keyless baseline: every RSS preset, and nothing that needs a secret.
 * NYT's live feeds are public, so they belong here; only its ARCHIVE backfill
 * adapter is gated on NYT_API_KEY.
 */
const KEYLESS_SOURCE_KEYS = [
  'nyt_business',
  'nyt_dealbook',
  'nyt_economy',
  'nyt_technology',
  'nyt_world',
  'nyt_climate',
  'globenewswire',
  'coindesk',
  'cointelegraph',
  'theblock',
];

describe('allAdapters registry', () => {
  it('returns only the RSS presets when no keys are configured, warning per family', () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => undefined);
    try {
      const adapters = allAdapters({});
      expect(adapters.map((a) => a.sourceKey)).toEqual(KEYLESS_SOURCE_KEYS);
      const warnings = warn.mock.calls.map((c) => String(c[0]));
      expect(warnings.some((w) => w.includes('EDGAR_USER_AGENT'))).toBe(true);
      expect(warnings.some((w) => w.includes('MASSIVE_API_KEY'))).toBe(true);
      expect(warnings.some((w) => w.includes('NYT_API_KEY'))).toBe(true);
    } finally {
      warn.mockRestore();
    }
  });

  it('enables every adapter when all keys are present', () => {
    const adapters = allAdapters({
      EDGAR_USER_AGENT: 'Test Person test@example.com',
      MASSIVE_API_KEY: 'k',
      NYT_API_KEY: 'k',
    });
    expect(adapters.map((a) => a.sourceKey).sort()).toEqual([
      'coindesk',
      'cointelegraph',
      'edgar_13d',
      'edgar_13g',
      'edgar_8k',
      'edgar_form4',
      'globenewswire',
      'massive_news',
      'nyt_archive',
      'nyt_business',
      'nyt_climate',
      'nyt_dealbook',
      'nyt_economy',
      'nyt_technology',
      'nyt_world',
      'theblock',
    ]);
    // source keys must be unique — they key news_sources rows.
    expect(new Set(adapters.map((a) => a.sourceKey)).size).toBe(adapters.length);
  });

  it('gates only the NYT archive on NYT_API_KEY, never the public NYT feeds', () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => undefined);
    try {
      const keys = allAdapters({}).map((a) => a.sourceKey);
      expect(keys).toContain('nyt_world');
      expect(keys).not.toContain('nyt_archive');
    } finally {
      warn.mockRestore();
    }
  });

  it('marks the archive as a backfill adapter and no live adapter as one', () => {
    // runPoll reads `backfill` to decide whether an item may set its own
    // received_at. A live adapter acquiring the flag would let a parsed feed
    // backdate arrival times, which the trading path reads.
    const adapters = allAdapters({
      EDGAR_USER_AGENT: 'Test Person test@example.com',
      MASSIVE_API_KEY: 'k',
      NYT_API_KEY: 'k',
    });
    const backfillKeys = adapters.filter((a) => a.backfill === true).map((a) => a.sourceKey);
    expect(backfillKeys).toEqual(['nyt_archive']);
  });

  it('treats whitespace-only env values as unset instead of constructing throwing adapters', () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => undefined);
    try {
      const adapters = allAdapters({
        EDGAR_USER_AGENT: '  ',
        MASSIVE_API_KEY: '',
        NYT_API_KEY: ' ',
      });
      expect(adapters).toHaveLength(KEYLESS_SOURCE_KEYS.length);
    } finally {
      warn.mockRestore();
    }
  });
});
