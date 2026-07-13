import { describe, expect, it } from 'vitest';

import type {
  DecideFeatures,
  GateResult,
  QuoteSnapshot,
  RulesConfig,
  SignalInput,
} from '../trading/contracts.js';

import { GATE_ORDER, SIZING_GATE_ORDER, decide } from './decide.js';

/**
 * Fixture defaults are a signal that TRADES under testConfig(): every gate
 * passes and sizing yields 125 shares (risk 500 / stop 4) at $50 → $6,250
 * notional, under the $10,000 cap. Each test perturbs exactly what it probes.
 */
const signal = (over: Partial<SignalInput> = {}): SignalInput => ({
  id: 'sig_1',
  clusterId: 'clu_1',
  instrumentId: 'ins_1',
  assetClass: 'us_equity',
  eventType: 'earnings_surprise',
  direction: 'bullish',
  expectedMoveBps: 200,
  horizon: '3d',
  alreadyExpected: false,
  materiality: 0.8,
  confidence: 0.9,
  anchorTs: '2026-07-10T14:00:00.000Z',
  ...over,
});

const features = (over: Partial<DecideFeatures> = {}): DecideFeatures => ({
  clusterItemCount: 3,
  distinctSourceCount: 2,
  itemsPerHour: 1.5,
  calendarMatch: false,
  priceMoveSinceAnchorBps: 40,
  medianDollarVolume: 20_000_000,
  atr: '2.00000000',
  openPositionsCount: 0,
  hasOpenPositionForInstrument: false,
  paperEquityUsd: '100000.00',
  engineVersion: 'test',
  ...over,
});

const quote = (over: Partial<QuoteSnapshot> = {}): QuoteSnapshot => ({
  price: '50.000000',
  ts: '2026-07-10T14:05:00.000Z',
  source: 'massive_delayed',
  spreadBps: null,
  ...over,
});

const testConfig = (
  p: {
    gates?: Partial<RulesConfig['gates']>;
    sizing?: Partial<RulesConfig['sizing']>;
    exits?: Partial<RulesConfig['exits']>;
  } = {},
): RulesConfig => ({
  gates: {
    minConfidence: 0.75,
    rejectAlreadyExpected: true,
    rejectCalendarMatch: true,
    eventTypeWhitelist: ['earnings_surprise'],
    staleMoveMaxBps: 300,
    minMedianDollarVolume: 5_000_000,
    maxConcurrentPositions: 10,
    allowShorts: false,
    ...p.gates,
  },
  sizing: {
    riskBpsOfEquity: 50,
    atrLookbackDays: 14,
    atrStopMultiple: 2,
    maxPositionNotionalPct: 0.1,
    ...p.sizing,
  },
  exits: {
    defaultTimeStopHorizon: '3d',
    stopAtrMultiple: 2,
    takeProfitAtrMultiple: null,
    ...p.exits,
  },
});

const gateByName = (gates: GateResult[], name: string): GateResult => {
  const found = gates.find((g) => g.gate === name);
  if (found === undefined) throw new Error(`gate ${name} not recorded`);
  return found;
};

describe('decide — happy path', () => {
  it('opens a long with exact sizing when every gate passes', () => {
    const result = decide(signal(), features(), quote(), testConfig());
    expect(result.action).toBe('open_long');
    expect(result.skipReason).toBeUndefined();
    expect(result.sizedQty).toBe('125');
    expect(result.sizedNotional).toBe('6250');
    expect(result.intent).toBeUndefined(); // intent is built by the wiring layer (needs decisionKey)
    expect(result.gates.every((g) => g.pass)).toBe(true);
  });

  it('records screening gates then sizing gates, in canonical order', () => {
    const result = decide(signal(), features(), quote(), testConfig());
    expect(result.gates.map((g) => g.gate)).toEqual([...GATE_ORDER, ...SIZING_GATE_ORDER]);
  });

  it('is deterministic: identical inputs produce identical results', () => {
    const a = decide(signal(), features(), quote(), testConfig());
    const b = decide(signal(), features(), quote(), testConfig());
    expect(b).toEqual(a);
  });
});

describe('decide — gate order and full recording', () => {
  it('evaluates and records ALL screening gates even after a failure', () => {
    // Fails direction (neutral), confidence, stale_move (null), and liquidity (null).
    const result = decide(
      signal({ direction: 'neutral', confidence: 0.1 }),
      features({ priceMoveSinceAnchorBps: null, medianDollarVolume: null }),
      quote(),
      testConfig(),
    );
    expect(result.action).toBe('skip');
    expect(result.gates.map((g) => g.gate)).toEqual([...GATE_ORDER]);
    expect(result.skipReason).toBe('direction_actionable');
    expect(result.gates.filter((g) => !g.pass).map((g) => g.gate)).toEqual([
      'direction_actionable',
      'min_confidence',
      'stale_move',
      'liquidity',
    ]);
  });

  it('skipReason is the FIRST failing gate in evaluation order', () => {
    const result = decide(
      signal({ confidence: 0.5, alreadyExpected: true }),
      features({ hasOpenPositionForInstrument: true }),
      quote(),
      testConfig(),
    );
    expect(result.skipReason).toBe('min_confidence');
  });

  it('does not evaluate sizing gates when a screening gate fails', () => {
    const result = decide(signal({ direction: 'neutral' }), features(), quote(), testConfig());
    expect(result.gates.map((g) => g.gate)).toEqual([...GATE_ORDER]);
    expect(result.sizedQty).toBeUndefined();
    expect(result.sizedNotional).toBeUndefined();
  });
});

describe('gate: direction_actionable', () => {
  it('neutral always skips', () => {
    const result = decide(signal({ direction: 'neutral' }), features(), quote(), testConfig());
    expect(result.action).toBe('skip');
    expect(result.skipReason).toBe('direction_actionable');
  });

  it('bearish skips when shorts are disallowed (long-only v1)', () => {
    const result = decide(signal({ direction: 'bearish' }), features(), quote(), testConfig());
    expect(result.action).toBe('skip');
    expect(result.skipReason).toBe('direction_actionable');
    expect(gateByName(result.gates, 'direction_actionable').threshold).toBe('bullish');
  });

  it('bearish opens a short when allowShorts is true', () => {
    const result = decide(
      signal({ direction: 'bearish' }),
      features(),
      quote(),
      testConfig({ gates: { allowShorts: true } }),
    );
    expect(result.action).toBe('open_short');
    expect(result.sizedQty).toBe('125');
  });

  it('neutral skips even when shorts are allowed', () => {
    const result = decide(
      signal({ direction: 'neutral' }),
      features(),
      quote(),
      testConfig({ gates: { allowShorts: true } }),
    );
    expect(result.skipReason).toBe('direction_actionable');
  });
});

describe('gate: min_confidence', () => {
  it('passes at exactly the threshold (inclusive)', () => {
    const result = decide(signal({ confidence: 0.75 }), features(), quote(), testConfig());
    expect(result.action).toBe('open_long');
  });

  it('fails just below the threshold', () => {
    const result = decide(signal({ confidence: 0.7499 }), features(), quote(), testConfig());
    expect(result.skipReason).toBe('min_confidence');
    expect(gateByName(result.gates, 'min_confidence')).toEqual({
      gate: 'min_confidence',
      pass: false,
      observed: 0.7499,
      threshold: 0.75,
    });
  });
});

describe('gate: already_expected', () => {
  it('fails when the signal is already-expected and the config rejects that', () => {
    const result = decide(signal({ alreadyExpected: true }), features(), quote(), testConfig());
    expect(result.skipReason).toBe('already_expected');
  });

  it('passes (recorded, threshold null) when rejectAlreadyExpected is off', () => {
    const result = decide(
      signal({ alreadyExpected: true }),
      features(),
      quote(),
      testConfig({ gates: { rejectAlreadyExpected: false } }),
    );
    expect(result.action).toBe('open_long');
    expect(gateByName(result.gates, 'already_expected')).toEqual({
      gate: 'already_expected',
      pass: true,
      observed: true,
      threshold: null,
    });
  });
});

describe('gate: calendar_match', () => {
  it('fails when a scheduled event matches and the config rejects that', () => {
    const result = decide(signal(), features({ calendarMatch: true }), quote(), testConfig());
    expect(result.skipReason).toBe('calendar_match');
  });

  it('passes (recorded, threshold null) when rejectCalendarMatch is off', () => {
    const result = decide(
      signal(),
      features({ calendarMatch: true }),
      quote(),
      testConfig({ gates: { rejectCalendarMatch: false } }),
    );
    expect(result.action).toBe('open_long');
    expect(gateByName(result.gates, 'calendar_match').threshold).toBeNull();
  });
});

describe('gate: event_type_whitelist', () => {
  it('fails when the event type is not whitelisted', () => {
    const result = decide(
      signal({ eventType: 'analyst_rating' }),
      features(),
      quote(),
      testConfig(),
    );
    expect(result.skipReason).toBe('event_type_whitelist');
    expect(gateByName(result.gates, 'event_type_whitelist').observed).toBe('analyst_rating');
  });

  it('an EMPTY whitelist trades nothing — every event type fails', () => {
    const result = decide(
      signal(),
      features(),
      quote(),
      testConfig({ gates: { eventTypeWhitelist: [] } }),
    );
    expect(result.action).toBe('skip');
    expect(result.skipReason).toBe('event_type_whitelist');
    expect(gateByName(result.gates, 'event_type_whitelist').threshold).toBe('');
  });

  it('records the whitelist as the threshold', () => {
    const result = decide(
      signal(),
      features(),
      quote(),
      testConfig({ gates: { eventTypeWhitelist: ['earnings_surprise', 'guidance_cut'] } }),
    );
    expect(gateByName(result.gates, 'event_type_whitelist').threshold).toBe(
      'earnings_surprise,guidance_cut',
    );
  });
});

describe('gate: stale_move', () => {
  it('passes at exactly the bps cap (inclusive)', () => {
    const result = decide(
      signal(),
      features({ priceMoveSinceAnchorBps: 300 }),
      quote(),
      testConfig(),
    );
    expect(result.action).toBe('open_long');
  });

  it('fails just above the cap', () => {
    const result = decide(
      signal(),
      features({ priceMoveSinceAnchorBps: 301 }),
      quote(),
      testConfig(),
    );
    expect(result.skipReason).toBe('stale_move');
  });

  it('is symmetric: a large NEGATIVE move is equally stale', () => {
    const result = decide(
      signal(),
      features({ priceMoveSinceAnchorBps: -301 }),
      quote(),
      testConfig(),
    );
    expect(result.skipReason).toBe('stale_move');
  });

  it('null move FAILS — unmeasurable is not tradeable', () => {
    const result = decide(
      signal(),
      features({ priceMoveSinceAnchorBps: null }),
      quote(),
      testConfig(),
    );
    expect(result.skipReason).toBe('stale_move');
    expect(gateByName(result.gates, 'stale_move').observed).toBeNull();
  });
});

describe('gate: liquidity', () => {
  it('passes at exactly the floor (inclusive)', () => {
    const result = decide(
      signal(),
      features({ medianDollarVolume: 5_000_000 }),
      quote(),
      testConfig(),
    );
    expect(result.action).toBe('open_long');
  });

  it('fails just below the floor', () => {
    const result = decide(
      signal(),
      features({ medianDollarVolume: 4_999_999 }),
      quote(),
      testConfig(),
    );
    expect(result.skipReason).toBe('liquidity');
  });

  it('null volume FAILS for equities', () => {
    const result = decide(signal(), features({ medianDollarVolume: null }), quote(), testConfig());
    expect(result.skipReason).toBe('liquidity');
  });

  it('crypto auto-passes even with null volume (no dollar-volume concept in our crypto bars)', () => {
    const result = decide(
      signal({ assetClass: 'crypto' }),
      features({ medianDollarVolume: null }),
      quote(),
      testConfig(),
    );
    expect(result.action).toBe('open_long');
    expect(gateByName(result.gates, 'liquidity')).toEqual({
      gate: 'liquidity',
      pass: true,
      observed: null,
      threshold: null,
    });
  });
});

describe('gate: max_concurrent_positions', () => {
  it('passes when one slot remains (strict <)', () => {
    const result = decide(signal(), features({ openPositionsCount: 9 }), quote(), testConfig());
    expect(result.action).toBe('open_long');
  });

  it('fails when the book is full', () => {
    const result = decide(signal(), features({ openPositionsCount: 10 }), quote(), testConfig());
    expect(result.skipReason).toBe('max_concurrent_positions');
  });
});

describe('gate: no_existing_position', () => {
  it('fails when the instrument already has an open position', () => {
    const result = decide(
      signal(),
      features({ hasOpenPositionForInstrument: true }),
      quote(),
      testConfig(),
    );
    expect(result.skipReason).toBe('no_existing_position');
  });
});

describe('decide — sizing gates surface as skips', () => {
  it('null ATR skips with atr_available; position_too_small is not evaluated', () => {
    const result = decide(signal(), features({ atr: null }), quote(), testConfig());
    expect(result.action).toBe('skip');
    expect(result.skipReason).toBe('atr_available');
    expect(result.gates.map((g) => g.gate)).toEqual([...GATE_ORDER, 'atr_available']);
    expect(result.sizedQty).toBeUndefined();
  });

  it('risk budget too small for one share skips with position_too_small', () => {
    // equity 1,000 × 50 bps = $5 risk; stop 2×$5 = $10 → 0.5 shares → floor 0.
    const result = decide(
      signal(),
      features({ paperEquityUsd: '1000.00', atr: '5.00000000' }),
      quote(),
      testConfig(),
    );
    expect(result.skipReason).toBe('position_too_small');
    expect(result.gates.map((g) => g.gate)).toEqual([...GATE_ORDER, ...SIZING_GATE_ORDER]);
  });
});

describe('decide — v1 posture', () => {
  it('long-only default: a perfect bearish signal is recorded as a skip, not traded', () => {
    const result = decide(
      signal({ direction: 'bearish', confidence: 0.99 }),
      features(),
      quote(),
      testConfig(),
    );
    expect(result.action).toBe('skip');
    expect(result.gates).toHaveLength(GATE_ORDER.length); // still fully recorded
  });
});
