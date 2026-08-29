import { createHash } from 'node:crypto';

import { describe, expect, it } from 'vitest';

import { buildUserPrompt, type InterpretContext } from './prompt.js';
import { CURRENT_PROMPT_VERSION, getPromptDefinition, PROMPT_REGISTRY } from './registry.js';
import { InterpretationSchema } from './schema.js';
import { EIGHT_K_ITEM_HINTS, EVENT_TYPE_DEFINITIONS, EVENT_TYPES } from './taxonomy.js';

/**
 * Pin of the v1 system prompt. If this fails you edited a PUBLISHED prompt
 * version's text — mint a new version in registry.ts instead (prompt versions
 * are immutable data, same discipline as rules_versions; silently editing v1
 * would mix vocabularies inside rows already stamped prompt_version='v1').
 */
const V1_SYSTEM_PROMPT_SHA256 = '66d12fc51daff4ba6dd6dcccd9ef5cb715b441ed713325ca4cf3a590dded58b6';
const V3_SYSTEM_PROMPT_SHA256 = '9e8e6e8f934e309c2a1e41beca4a7b0f4c03d734eca4737ca762d2533d096056';
const V3_NOFILING_SYSTEM_PROMPT_SHA256 =
  'a338f7b585093f527e5cacd5860f7d99f5db42d1da448af8d4375f32458d6a69';
const V4A_SYSTEM_PROMPT_SHA256 = 'f748cb1c139439a222006c588c54ef0f4fcd551af60dc453bc0356e3747690d6';

const VALID_OUTPUT = {
  event_type: 'earnings_result',
  direction: 'bullish',
  expected_move_bps: 350,
  horizon: '1d',
  already_expected: false,
  materiality: 0.7,
  confidence: 0.8,
  reasoning: 'Revenue and EPS beat with raised guidance. Direct positive surprise.',
} as const;

function context(overrides?: Partial<InterpretContext>): InterpretContext {
  return {
    instrument: {
      symbol: 'VNDL',
      name: 'Vandelay Industries',
      assetClass: 'us_equity',
      sectorApprox: 'Industrials',
      exchange: 'NYSE',
    },
    cluster: {
      canonicalHeadline: 'Vandelay Industries beats Q3 expectations',
      firstReceivedAtIso: '2026-08-09T13:30:00.000Z',
      itemCount: 3,
      distinctSourceCount: 2,
    },
    items: [
      {
        sourceKey: 'massive_news',
        headline: 'Vandelay Industries beats Q3 expectations',
        lede: 'Vandelay reported EPS of $2.10 vs $1.80 expected and raised full-year guidance.',
        lagFromFirstMs: 0,
        itemCodes: null,
        formType: null,
      },
      {
        sourceKey: 'edgar_8k',
        headline: '8-K - Vandelay Industries Inc',
        lede: 'Item 2.02 Results of Operations and Financial Condition.',
        lagFromFirstMs: 240_000,
        itemCodes: ['2.02', '9.01'],
        formType: '8-K',
      },
    ],
    priceMoveSinceAnchorBps: 212.4,
    ...overrides,
  };
}

describe('InterpretationSchema', () => {
  it('accepts a valid interpretation', () => {
    expect(InterpretationSchema.parse(VALID_OUTPUT)).toEqual(VALID_OUTPUT);
  });

  it('rejects off-taxonomy event types — the whitelist-fragmentation guard', () => {
    expect(() =>
      InterpretationSchema.parse({ ...VALID_OUTPUT, event_type: 'earnings_beat' }),
    ).toThrow();
  });

  it('rejects out-of-range numerics the wire schema cannot express', () => {
    expect(() => InterpretationSchema.parse({ ...VALID_OUTPUT, confidence: 1.2 })).toThrow();
    expect(() => InterpretationSchema.parse({ ...VALID_OUTPUT, materiality: -0.1 })).toThrow();
    expect(() => InterpretationSchema.parse({ ...VALID_OUTPUT, expected_move_bps: -50 })).toThrow();
    expect(() =>
      InterpretationSchema.parse({ ...VALID_OUTPUT, expected_move_bps: 9000 }),
    ).toThrow();
  });

  it('rejects unknown keys and missing reasoning (strict contract)', () => {
    expect(() => InterpretationSchema.parse({ ...VALID_OUTPUT, extra: true })).toThrow();
    // eslint-disable-next-line @typescript-eslint/no-unused-vars -- destructuring is how the key is dropped
    const { reasoning: _dropped, ...withoutReasoning } = VALID_OUTPUT;
    expect(() => InterpretationSchema.parse(withoutReasoning)).toThrow();
  });
});

describe('taxonomy', () => {
  it('every event type has a definition and every 8-K hint targets a real type', () => {
    for (const type of EVENT_TYPES) {
      expect(EVENT_TYPE_DEFINITIONS[type].length).toBeGreaterThan(10);
    }
    for (const hinted of Object.values(EIGHT_K_ITEM_HINTS)) {
      expect(EVENT_TYPES).toContain(hinted);
    }
  });
});

describe('prompt registry', () => {
  it('pins the v1 system prompt text (edit = mint v2, never mutate v1)', () => {
    const def = getPromptDefinition('v1');
    const hash = createHash('sha256').update(def.systemPrompt, 'utf8').digest('hex');
    expect(hash).toBe(V1_SYSTEM_PROMPT_SHA256);
  });

  it('pins the v3 system prompt text and keeps v1 byte-identical apart from the price bullet', () => {
    const v1 = getPromptDefinition('v1').systemPrompt;
    const v3 = getPromptDefinition('v3').systemPrompt;
    expect(createHash('sha256').update(v3, 'utf8').digest('hex')).toBe(V3_SYSTEM_PROMPT_SHA256);
    // The ONLY difference is the PRICE CONTEXT bullet — v3 is not a rewrite,
    // and the diff staying that small is what makes v1-vs-v3 comparable.
    expect(v3).not.toBe(v1);
    expect(v3).toContain('move over the session BEFORE the story arrived');
    expect(v3).toContain('SEC filing text');
    expect(v1).not.toContain('SEC filing text');
    expect(v1).toContain('move since the story first arrived');
    expect(v3).not.toContain('move since the story first arrived');
  });

  it('renders v3 user prompts with pre-arrival price context only', () => {
    const def = getPromptDefinition('v3');
    const rendered = def.buildUserPrompt({
      instrument: {
        symbol: 'VNDL',
        name: 'Vandelay',
        assetClass: 'us_equity',
        sectorApprox: null,
        exchange: null,
      },
      cluster: {
        canonicalHeadline: 'Vandelay beats',
        firstReceivedAtIso: '2026-08-09T10:00:00.000Z',
        itemCount: 1,
        distinctSourceCount: 1,
      },
      items: [],
      // Set to a wild value to prove v3 ignores it entirely.
      priceMoveSinceAnchorBps: 9999,
      priceRunUpBeforeAnchorBps: -250,
    });
    expect(rendered).toContain('Move over the session before arrival: -250 bps');
    expect(rendered).not.toContain('9999');
    expect(rendered).not.toContain('Move since story arrival');
  });

  it('gives v3 room for a filing body while v1 stays byte-frozen at 1500', () => {
    // The regression this pins: 1500 was slack when item text was a feed lede,
    // and became a 97% haircut once the filing-document stage started storing
    // 80k-char 8-Ks. v1 must keep its old rendering for replay.
    const body = 'F'.repeat(90_000);
    const context = {
      instrument: {
        symbol: 'ACN',
        name: 'Accenture',
        assetClass: 'us_equity' as const,
        sectorApprox: null,
        exchange: null,
      },
      cluster: {
        canonicalHeadline: '8-K - Accenture plc',
        firstReceivedAtIso: '2026-07-11T02:37:20.964Z',
        itemCount: 1,
        distinctSourceCount: 1,
      },
      items: [
        {
          sourceKey: 'edgar_8k',
          headline: '8-K - Accenture plc',
          lede: body,
          lagFromFirstMs: 0,
          itemCodes: ['8.01'],
          formType: '8-K',
        },
      ],
      priceMoveSinceAnchorBps: null,
      priceRunUpBeforeAnchorBps: 120,
    };

    const v1 = getPromptDefinition('v1').buildUserPrompt(context);
    const v3 = getPromptDefinition('v3').buildUserPrompt(context);

    expect(v1).toContain(`Text: ${'F'.repeat(1500)}\n`);
    expect(v1).not.toContain('F'.repeat(1501));
    expect(v3).toContain('F'.repeat(40_000));
    expect(v3).not.toContain('F'.repeat(40_001));
  });

  it('caps v3 total item text so a multi-item cluster cannot multiply the budget', () => {
    const items = [0, 1, 2, 3].map((i) => ({
      sourceKey: `src_${i}`,
      headline: `item ${i}`,
      // Filler char that cannot appear in the template itself — counting 'X'
      // silently included the one in "PRICE CONTEXT".
      lede: '\u2588'.repeat(40_000),
      lagFromFirstMs: i * 60_000,
      itemCodes: null,
      formType: null,
    }));
    const rendered = getPromptDefinition('v3').buildUserPrompt({
      instrument: {
        symbol: 'ACN',
        name: 'Accenture',
        assetClass: 'us_equity' as const,
        sectorApprox: null,
        exchange: null,
      },
      cluster: {
        canonicalHeadline: 'many reports',
        firstReceivedAtIso: '2026-07-11T02:37:20.964Z',
        itemCount: 4,
        distinctSourceCount: 4,
      },
      items,
      priceMoveSinceAnchorBps: null,
      priceRunUpBeforeAnchorBps: null,
    });

    // 60k total, not 4 x 40k. The first report keeps its text; the late
    // follow-ups lose theirs, which is the right way round.
    const bodyChars = (rendered.match(/\u2588/g) ?? []).length;
    expect(bodyChars).toBe(60_000);
    expect(rendered).toContain('ITEM 4 [src_3');
  });

  it('pins the experiment arms and keeps their diffs from v3 narrow', () => {
    const v3 = getPromptDefinition('v3');
    const nofiling = getPromptDefinition('v3-nofiling');
    const v4a = getPromptDefinition('v4a');

    expect(createHash('sha256').update(nofiling.systemPrompt, 'utf8').digest('hex')).toBe(
      V3_NOFILING_SYSTEM_PROMPT_SHA256,
    );
    expect(createHash('sha256').update(v4a.systemPrompt, 'utf8').digest('hex')).toBe(
      V4A_SYSTEM_PROMPT_SHA256,
    );

    // v3-nofiling = v3 minus the filing bullet, minus the filing load.
    expect(nofiling.includeFilingText).toBe(false);
    expect(nofiling.systemPrompt).not.toContain('SEC filing text');
    expect(nofiling.systemPrompt).toContain('move over the session BEFORE the story arrived');

    // v4a = v3 plus the two qualified edits, filing input unchanged.
    expect(v4a.includeFilingText).toBe(true);
    expect(v4a.systemPrompt).toContain('SEC filing text');
    expect(v4a.systemPrompt).toContain('Earnings and guidance stories');
    expect(v4a.systemPrompt).toContain('Anchor to these bands');
    expect(v3.systemPrompt).not.toContain('Earnings and guidance stories');
    expect(v3.systemPrompt).toContain('Use the full scale honestly');
    expect(v4a.systemPrompt).not.toContain('Use the full scale honestly');

    // Experiment arms must never be the live version.
    expect(CURRENT_PROMPT_VERSION).toBe('v3');
  });

  it('every registered version declares its filing-text input', () => {
    for (const def of Object.values(PROMPT_REGISTRY)) {
      expect(typeof def.includeFilingText).toBe('boolean');
    }
    // v1/v2/v3 describe pre-existing behavior: the sweep always loaded filing
    // text for them (their size belts did the truncating).
    expect(getPromptDefinition('v1').includeFilingText).toBe(true);
    expect(getPromptDefinition('v3').includeFilingText).toBe(true);
  });

  it('current version exists, targets sonnet, and clears the prompt-cache minimum', () => {
    const def = getPromptDefinition(CURRENT_PROMPT_VERSION);
    expect(def.modelId).toBe('claude-sonnet-5');
    // ~4 chars/token heuristic with margin: the cached prefix must exceed the
    // 1,024-token minimum or every call silently pays full input price.
    expect(def.systemPrompt.length).toBeGreaterThan(1024 * 5);
    expect(Object.keys(PROMPT_REGISTRY)).toContain(CURRENT_PROMPT_VERSION);
  });

  it('throws on unknown versions', () => {
    expect(() => getPromptDefinition('v999')).toThrow(/Unknown prompt version/);
  });
});

describe('buildUserPrompt', () => {
  it('is deterministic and renders every context section', () => {
    const prompt = buildUserPrompt(context());
    expect(buildUserPrompt(context())).toBe(prompt);

    expect(prompt).toContain('VNDL — Vandelay Industries (us_equity, NYSE, sector: Industrials)');
    expect(prompt).toContain(
      'First received: 2026-08-09T13:30:00.000Z · 3 item(s) from 2 source(s)',
    );
    expect(prompt).toContain('ITEM 1 [massive_news, first report]');
    expect(prompt).toContain('ITEM 2 [edgar_8k, 4 min after first]');
    expect(prompt).toContain('8-K items: 2.02 (hint: earnings_result), 9.01');
    expect(prompt).toContain('Move since story arrival: 212 bps');
  });

  it('handles headline-only clusters and missing price context', () => {
    const prompt = buildUserPrompt(
      context({
        items: [
          {
            sourceKey: 'globenewswire',
            headline: 'Solo headline',
            lede: null,
            lagFromFirstMs: 0,
            itemCodes: null,
            formType: null,
          },
        ],
        priceMoveSinceAnchorBps: null,
      }),
    );
    expect(prompt).toContain('Headline: Solo headline');
    expect(prompt).not.toContain('Text:');
    expect(prompt).toContain('Move since story arrival: unavailable');
  });

  it('caps items and lede length defensively', () => {
    const manyItems = Array.from({ length: 8 }, (_, i) => ({
      sourceKey: `src${i}`,
      headline: `h${i}`,
      lede: 'x'.repeat(5000),
      lagFromFirstMs: i * 1000,
      itemCodes: null,
      formType: null,
    }));
    const prompt = buildUserPrompt(context({ items: manyItems }));
    expect(prompt).toContain('ITEM 4');
    expect(prompt).not.toContain('ITEM 5');
    // 1500-char lede cap: the raw 5000-char filler must not survive intact.
    expect(prompt).not.toContain('x'.repeat(1501));
  });
});
