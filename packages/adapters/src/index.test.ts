import { describe, expect, it, vi } from 'vitest';

import { allAdapters } from './index.js';

describe('allAdapters registry', () => {
  it('returns only the RSS presets when no keys are configured, warning per family', () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => undefined);
    try {
      const adapters = allAdapters({});
      expect(adapters.map((a) => a.sourceKey)).toEqual([
        'globenewswire',
        'coindesk',
        'cointelegraph',
        'theblock',
      ]);
      const warnings = warn.mock.calls.map((c) => String(c[0]));
      expect(warnings.some((w) => w.includes('EDGAR_USER_AGENT'))).toBe(true);
      expect(warnings.some((w) => w.includes('MASSIVE_API_KEY'))).toBe(true);
    } finally {
      warn.mockRestore();
    }
  });

  it('enables all nine adapters when both keys are present', () => {
    const adapters = allAdapters({
      EDGAR_USER_AGENT: 'Test Person test@example.com',
      MASSIVE_API_KEY: 'k',
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
      'theblock',
    ]);
    // source keys must be unique — they key news_sources rows.
    expect(new Set(adapters.map((a) => a.sourceKey)).size).toBe(adapters.length);
  });

  it('treats whitespace-only env values as unset instead of constructing throwing adapters', () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => undefined);
    try {
      const adapters = allAdapters({ EDGAR_USER_AGENT: '  ', MASSIVE_API_KEY: '' });
      expect(adapters).toHaveLength(4);
    } finally {
      warn.mockRestore();
    }
  });
});
