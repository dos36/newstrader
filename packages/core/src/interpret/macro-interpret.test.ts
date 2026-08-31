import { createHash } from 'node:crypto';

import { describe, expect, it } from 'vitest';

import {
  macroSignalRows,
  sectorFanoutWeights,
  instrumentsForSector,
  type FanoutInstrument,
} from './macro-fanout.js';
import { buildMacroUserPrompt, type MacroInterpretContext } from './macro-prompt.js';
import {
  CURRENT_MACRO_PROMPT_VERSION,
  getMacroPromptDefinition,
  isMacroPromptVersion,
  MACRO_PROMPT_REGISTRY,
} from './macro-registry.js';
import {
  macroCoherenceError,
  MacroInterpretationSchema,
  type MacroInterpretation,
} from './macro-schema.js';
import {
  MACRO_EVENT_TYPE_DEFINITIONS,
  MACRO_EVENT_TYPES,
  MACRO_SECTORS,
  MAX_SECTOR_EXPOSURES,
} from './macro-taxonomy.js';
import { PROMPT_REGISTRY } from './registry.js';

/**
 * Pinned so an edit to published prompt text fails the build instead of
 * silently re-labelling every row already stamped v1m. Mirrors the company
 * registry's pins: to change the prompt, mint a new version.
 */
const V1M_SYSTEM_PROMPT_SHA256 =
  '8b21637988bee420cd3342e01a15d4befb652dc9d36939d9ed6fda7c860983e9';

const VALID: MacroInterpretation = {
  macro_event_type: 'monetary_policy',
  market_scope: 'broad',
  broad_direction: 'bullish',
  sector_exposures: [],
  expected_move_bps: 45,
  horizon: '1d',
  already_expected: false,
  materiality: 0.6,
  confidence: 0.55,
  reasoning: 'The expected path of rates fell, which lifts every discounted cash flow.',
};

describe('MacroInterpretationSchema', () => {
  it('accepts a valid macro judgment', () => {
    expect(() => MacroInterpretationSchema.parse(VALID)).not.toThrow();
  });

  it('rejects off-vocabulary event types and sectors', () => {
    expect(() =>
      MacroInterpretationSchema.parse({ ...VALID, macro_event_type: 'flooding' }),
    ).toThrow();
    // A sector label the instruments table never contains would fan out to
    // nothing, so it must fail loudly at the boundary rather than become a row.
    expect(() =>
      MacroInterpretationSchema.parse({
        ...VALID,
        market_scope: 'sector',
        sector_exposures: [{ sector: 'Tech', direction: 'bearish', materiality: 0.5 }],
      }),
    ).toThrow();
  });

  it('caps the sector list and the sector-level move ceiling', () => {
    const tooMany = MACRO_SECTORS.slice(0, MAX_SECTOR_EXPOSURES + 1).map((sector) => ({
      sector,
      direction: 'bearish' as const,
      materiality: 0.4,
    }));
    expect(() =>
      MacroInterpretationSchema.parse({
        ...VALID,
        market_scope: 'sector',
        sector_exposures: tooMany,
      }),
    ).toThrow();
    // 2000 bps, not the company path's 5000: a whole GICS sector does not move 50%.
    expect(() => MacroInterpretationSchema.parse({ ...VALID, expected_move_bps: 2500 })).toThrow();
  });

  it('rejects unknown keys (strict contract)', () => {
    expect(() => MacroInterpretationSchema.parse({ ...VALID, sentiment: 'bad' })).toThrow();
  });
});

describe('macroCoherenceError', () => {
  it('passes coherent judgments', () => {
    expect(macroCoherenceError(VALID)).toBeNull();
    expect(
      macroCoherenceError({
        ...VALID,
        market_scope: 'none',
        broad_direction: 'neutral',
        materiality: 0,
        expected_move_bps: 0,
      }),
    ).toBeNull();
  });

  it('rejects scope=sector that names no sector', () => {
    // Distinguishing this from scope=none is the whole reason market_scope is
    // an explicit field: "no mechanism" is an answer, "named nobody" is a bug.
    expect(macroCoherenceError({ ...VALID, market_scope: 'sector' })).toMatch(/empty/);
  });

  it('rejects scope=none that contradicts itself', () => {
    expect(
      macroCoherenceError({
        ...VALID,
        market_scope: 'none',
        sector_exposures: [{ sector: 'Energy', direction: 'bearish', materiality: 0.5 }],
      }),
    ).toMatch(/sector_exposures were given/);
    expect(macroCoherenceError({ ...VALID, market_scope: 'none', materiality: 0.8 })).toMatch(
      /materiality/,
    );
  });

  it('rejects a repeated sector', () => {
    expect(
      macroCoherenceError({
        ...VALID,
        market_scope: 'sector',
        sector_exposures: [
          { sector: 'Utilities', direction: 'bearish', materiality: 0.6 },
          { sector: 'Utilities', direction: 'bullish', materiality: 0.3 },
        ],
      }),
    ).toMatch(/twice/);
  });
});

describe('macro taxonomy', () => {
  it('every event type has a definition', () => {
    for (const type of MACRO_EVENT_TYPES) {
      expect(MACRO_EVENT_TYPE_DEFINITIONS[type]).toBeTruthy();
    }
    expect(Object.keys(MACRO_EVENT_TYPE_DEFINITIONS).sort()).toEqual([...MACRO_EVENT_TYPES].sort());
  });

  it('is organised by mechanism, not by topic', () => {
    // The generality guard. Topic-shaped entries need a new type for every
    // unfamiliar event; channel-shaped entries generalise to events nobody
    // anticipated. If a specific-hazard label ever appears here, the taxonomy
    // has started tracking the news instead of the mechanism.
    for (const banned of ['flood', 'hurricane', 'earthquake', 'wildfire', 'pandemic', 'war']) {
      expect(MACRO_EVENT_TYPES.some((t) => t.includes(banned))).toBe(false);
    }
    expect(MACRO_EVENT_TYPES).toContain('natural_event');
    expect(MACRO_EVENT_TYPES).toContain('other');
  });

  it('uses exactly the 11 GICS labels the instruments table carries', () => {
    expect(MACRO_SECTORS).toHaveLength(11);
    expect([...MACRO_SECTORS]).toEqual([...MACRO_SECTORS].sort());
  });
});

describe('macro prompt registry', () => {
  it('pins the v1m system prompt text (edit = mint a new version, never mutate v1m)', () => {
    const def = getMacroPromptDefinition('v1m');
    const hash = createHash('sha256').update(def.systemPrompt, 'utf8').digest('hex');
    expect(hash).toBe(V1M_SYSTEM_PROMPT_SHA256);
  });

  it('never collides with a company prompt version', () => {
    // Both registries write to llm_signals.prompt_version; a shared id would
    // pool two different contracts into one set of statistics.
    for (const version of Object.keys(MACRO_PROMPT_REGISTRY)) {
      expect(Object.hasOwn(PROMPT_REGISTRY, version)).toBe(false);
    }
    expect(isMacroPromptVersion(CURRENT_MACRO_PROMPT_VERSION)).toBe(true);
    expect(isMacroPromptVersion('v3')).toBe(false);
  });

  it('current version exists and targets sonnet', () => {
    const def = getMacroPromptDefinition(CURRENT_MACRO_PROMPT_VERSION);
    expect(def.modelId).toBe('claude-sonnet-5');
    expect(def.maxTokens).toBeGreaterThanOrEqual(10_000);
  });

  it('throws on unknown versions', () => {
    expect(() => getMacroPromptDefinition('nope')).toThrow(/Unknown macro prompt version/);
  });

  it('states "none" as the expected answer and warns against reflex chains', () => {
    // These instructions are the false-positive defence. Without them the model
    // finds an angle in everything, which produces confident noise that is
    // expensive to score and indistinguishable from signal.
    const text = getMacroPromptDefinition('v1m').systemPrompt;
    expect(text).toContain('MOST COMMON CORRECT ANSWER');
    expect(text).toContain('Prominence is not materiality');
    expect(text).toContain('reflex chains');
    expect(text).toContain('Second-order effects decay fast');
  });

  it('renders no price context — there is no instrument to price yet', () => {
    // The company path shows a pre-arrival move for a KNOWN instrument. Here
    // the affected group is chosen by the model after reading the story, so any
    // price shown would prejudge the answer.
    const text = getMacroPromptDefinition('v1m').systemPrompt;
    expect(text).not.toContain('PRICE CONTEXT');
  });

  it('names no specific scenario', () => {
    // Direct guard on the brief: a prompt tuned to the example that motivated
    // it scores well on that example and badly on the rest of world news.
    // Naming a hazard TYPE inside a taxonomy definition is fine and necessary
    // — "floods" appears once, defining natural_event alongside five other
    // hazards. Naming a scenario is what overfits.
    const text = getMacroPromptDefinition('v1m').systemPrompt.toLowerCase();
    for (const scenario of ['nepal', 'hydropower', 'monsoon', 'himalaya', 'kathmandu']) {
      expect(text).not.toContain(scenario);
    }
  });

  it('gives no single transmission channel disproportionate prompt space', () => {
    // The measurable form of "not overfit". If one channel's vocabulary
    // dominates, the model learns to reach for that channel; the whole point of
    // a mechanism taxonomy is that all channels are peers.
    const text = getMacroPromptDefinition('v1m').systemPrompt.toLowerCase();
    const mentions = (word: string): number => text.split(word).length - 1;
    for (const hazard of ['flood', 'storm', 'weather', 'disaster']) {
      expect(mentions(hazard)).toBeLessThanOrEqual(3);
    }
    // Policy, supply, and disruption vocabulary must all be present, so the
    // examples cannot all be pulling in one direction.
    for (const channel of ['rate', 'export', 'transport', 'conflict']) {
      expect(mentions(channel)).toBeGreaterThan(0);
    }
  });

  it('teaches restraint in its weather example rather than an angle', () => {
    // The one weather example exists to say "forecasts are not damage" — it
    // argues AGAINST finding a trade, which is the opposite of fitting the
    // prompt to a hoped-for answer.
    const text = getMacroPromptDefinition('v1m').systemPrompt;
    expect(text).toContain('forecasts are not damage');
  });
});

describe('buildMacroUserPrompt', () => {
  const context: MacroInterpretContext = {
    cluster: {
      canonicalHeadline: 'Central Bank Holds Rates, Signals Easing Ahead',
      firstReceivedAtIso: '2026-07-03T18:04:11.000Z',
      itemCount: 3,
      distinctSourceCount: 2,
    },
    items: [
      {
        sourceKey: 'nyt_business',
        headline: 'Central Bank Holds Rates, Signals Easing Ahead',
        lede: 'Policymakers held steady but shifted their language toward a cut.',
        lagFromFirstMs: 0,
        section: 'Business',
      },
      {
        sourceKey: 'globenewswire',
        headline: 'Rate decision reaction',
        lede: null,
        lagFromFirstMs: 240_000,
        section: null,
      },
    ],
  };

  it('is deterministic and renders the story, items, and lags', () => {
    const first = buildMacroUserPrompt(context);
    expect(buildMacroUserPrompt(context)).toBe(first);
    expect(first).toContain('Central Bank Holds Rates');
    expect(first).toContain('2026-07-03T18:04:11.000Z');
    expect(first).toContain('[nyt_business]');
    expect(first).toContain('first report');
    expect(first).toContain('4 min after first');
    expect(first).toContain('section: Business');
  });

  it('handles headline-only items without printing empty fields', () => {
    const text = buildMacroUserPrompt(context);
    expect(text).not.toContain('section: null');
    expect(text).not.toContain('undefined');
  });

  it('caps items and lede length defensively', () => {
    const many: MacroInterpretContext = {
      ...context,
      items: Array.from({ length: 20 }, (_, i) => ({
        sourceKey: 'nyt_world',
        headline: `item ${String(i)}`,
        lede: 'x'.repeat(5000),
        lagFromFirstMs: i * 1000,
        section: 'World',
      })),
    };
    const text = buildMacroUserPrompt(many, { maxItems: 3, maxLedeChars: 50 });
    expect(text).toContain('17 further item(s) not shown');
    expect(text).not.toContain('x'.repeat(51));
  });
});

describe('macroSignalRows', () => {
  it('writes nothing for scope=none', () => {
    // Recording the decline belongs in the attempt log; a row in llm_signals
    // would be a tradeable-looking artifact of a decision NOT to trade.
    expect(
      macroSignalRows({ ...VALID, market_scope: 'none', materiality: 0, expected_move_bps: 0 }),
    ).toEqual([]);
  });

  it('writes one macro row for a broad call', () => {
    expect(macroSignalRows(VALID)).toEqual([
      {
        scope: 'macro',
        sectorCode: null,
        direction: 'bullish',
        materiality: 0.6,
        expectedMoveBps: 45,
      },
    ]);
  });

  it('writes one row per sector and scales the move by relative materiality', () => {
    const rows = macroSignalRows({
      ...VALID,
      market_scope: 'sector',
      expected_move_bps: 100,
      sector_exposures: [
        { sector: 'Utilities', direction: 'bearish', materiality: 0.8 },
        { sector: 'Industrials', direction: 'bearish', materiality: 0.2 },
      ],
    });

    expect(rows).toHaveLength(2);
    // expected_move_bps describes the MOST-affected sector, so the mild sector
    // must not claim the same move — otherwise its row drags down the measured
    // accuracy of the event type for a reason the model never asserted.
    expect(rows[0]).toMatchObject({ sectorCode: 'Utilities', expectedMoveBps: 100 });
    expect(rows[1]).toMatchObject({ sectorCode: 'Industrials', expectedMoveBps: 25 });
    for (const row of rows) expect(row.scope).toBe('sector');
  });

  it('survives an all-zero materiality set without dividing by zero', () => {
    const rows = macroSignalRows({
      ...VALID,
      market_scope: 'sector',
      expected_move_bps: 80,
      sector_exposures: [{ sector: 'Energy', direction: 'neutral', materiality: 0 }],
    });
    expect(rows[0]?.expectedMoveBps).toBe(0);
  });

  it('keeps per-sector direction independent, so one event can split the market', () => {
    const rows = macroSignalRows({
      ...VALID,
      market_scope: 'sector',
      sector_exposures: [
        { sector: 'Energy', direction: 'bullish', materiality: 0.7 },
        { sector: 'Industrials', direction: 'bearish', materiality: 0.7 },
      ],
    });
    expect(rows.map((r) => r.direction)).toEqual(['bullish', 'bearish']);
  });
});

describe('sector fanout', () => {
  const universe: FanoutInstrument[] = [
    { instrumentId: 'i1', symbol: 'AAA', sectorApprox: 'Utilities' },
    { instrumentId: 'i2', symbol: 'BBB', sectorApprox: 'Utilities' },
    { instrumentId: 'i3', symbol: 'CCC', sectorApprox: 'Energy' },
    { instrumentId: 'i4', symbol: 'DDD', sectorApprox: null },
  ];

  it('matches sector exactly and skips null-sector members', () => {
    expect(instrumentsForSector(universe, 'Utilities').map((i) => i.symbol)).toEqual(['AAA', 'BBB']);
    // A null sector is left out deliberately: guessing one would put an
    // instrument in a basket on no evidence.
    expect(instrumentsForSector(universe, 'Real Estate')).toEqual([]);
  });

  it('equal-weights members so the basket measures the sector, not its largest name', () => {
    const weights = sectorFanoutWeights(universe, {
      sector: 'Utilities',
      direction: 'bearish',
      materiality: 0.6,
    });
    expect(weights).toEqual([
      { instrumentId: 'i1', symbol: 'AAA', weight: 0.5 },
      { instrumentId: 'i2', symbol: 'BBB', weight: 0.5 },
    ]);
    expect(weights.reduce((sum, w) => sum + w.weight, 0)).toBeCloseTo(1);
  });

  it('returns nothing when the universe holds no member of that sector', () => {
    expect(
      sectorFanoutWeights(universe, {
        sector: 'Health Care',
        direction: 'bullish',
        materiality: 0.5,
      }),
    ).toEqual([]);
  });
});
