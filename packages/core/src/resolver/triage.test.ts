import { createHash } from 'node:crypto';

import { describe, expect, it } from 'vitest';

import {
  buildTriageSystemPrompt,
  buildTriageUserPrompt,
  TRIAGE_MAX_CANDIDATES,
  TRIAGE_MAX_LEDE_CHARS,
  TRIAGE_VERSION,
  TriageResultSchema,
} from './triage.js';

/**
 * Pin of the t1 triage system prompt — same immutability discipline as the
 * interpret prompt versions: editing published text means minting 't2', never
 * mutating 't1' (item_triage rows are stamped triage_version).
 */
const T1_SYSTEM_PROMPT_SHA256 = '24de1bcb842a91706260167f206af3a8bedbc7eabad139629574cb728244a68c';

describe('triage prompt', () => {
  it('pins the t1 system prompt text (edit = mint t2)', () => {
    expect(TRIAGE_VERSION).toBe('t1');
    const hash = createHash('sha256')
      .update(buildTriageSystemPrompt(), 'utf8')
      .digest('hex');
    expect(hash).toBe(T1_SYSTEM_PROMPT_SHA256);
  });

  it('renders headline, lede, and every candidate deterministically', () => {
    const context = {
      headline: 'Vandelay Industries beats Q3 expectations',
      lede: 'Vandelay reported EPS of $2.10 vs $1.80 expected.',
      candidates: [
        { symbol: 'VNDL', name: 'Vandelay Industries' },
        { symbol: 'KRAM', name: 'Kramerica Industries' },
      ],
    };
    const prompt = buildTriageUserPrompt(context);
    expect(buildTriageUserPrompt(context)).toBe(prompt);
    expect(prompt).toContain('Headline: Vandelay Industries beats Q3 expectations');
    expect(prompt).toContain('Text: Vandelay reported EPS of $2.10');
    expect(prompt).toContain('- VNDL: Vandelay Industries');
    expect(prompt).toContain('- KRAM: Kramerica Industries');
  });

  it('handles headline-only items and caps lede + candidate count', () => {
    const noLede = buildTriageUserPrompt({ headline: 'Solo', lede: null, candidates: [] });
    expect(noLede).not.toContain('Text:');

    const many = Array.from({ length: 40 }, (_, i) => ({ symbol: `S${i}`, name: `n${i}` }));
    const capped = buildTriageUserPrompt({
      headline: 'h',
      lede: 'x'.repeat(TRIAGE_MAX_LEDE_CHARS + 500),
      candidates: many,
    });
    expect(capped).toContain(`- S${TRIAGE_MAX_CANDIDATES - 1}:`);
    expect(capped).not.toContain(`- S${TRIAGE_MAX_CANDIDATES}:`);
    expect(capped).not.toContain('x'.repeat(TRIAGE_MAX_LEDE_CHARS + 1));
  });
});

describe('TriageResultSchema', () => {
  it('accepts a valid verdict including the empty one', () => {
    expect(
      TriageResultSchema.parse({ relevant_tickers: [], reasoning: 'Listicle; no subject.' }),
    ).toEqual({ relevant_tickers: [], reasoning: 'Listicle; no subject.' });
    expect(
      TriageResultSchema.parse({ relevant_tickers: ['VNDL'], reasoning: 'Subject.' }),
    ).toEqual({ relevant_tickers: ['VNDL'], reasoning: 'Subject.' });
  });

  it('rejects unknown keys and missing reasoning (strict contract)', () => {
    expect(() =>
      TriageResultSchema.parse({ relevant_tickers: [], reasoning: 'ok', extra: true }),
    ).toThrow();
    expect(() => TriageResultSchema.parse({ relevant_tickers: [] })).toThrow();
  });
});
