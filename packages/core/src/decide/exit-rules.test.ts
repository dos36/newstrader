import { describe, expect, it } from 'vitest';

import type { RulesConfig } from '../trading/contracts.js';

import { HORIZON_DURATION_MS, evaluateExit, type ExitEvaluationInput } from './exit-rules.js';

const HOUR_MS = 3_600_000;
const DAY_MS = 86_400_000;

const exitsConfig = (over: Partial<RulesConfig['exits']> = {}): RulesConfig['exits'] => ({
  defaultTimeStopHorizon: '3d',
  stopAtrMultiple: 2,
  takeProfitAtrMultiple: null,
  ...over,
});

const openedAt = new Date('2026-07-06T14:00:00.000Z');

/** Defaults hold: long from 100, ATR 2 → stop at 96, opened Monday, 3d horizon. */
const input = (over: Partial<ExitEvaluationInput> = {}): ExitEvaluationInput => ({
  entryPrice: '100.000000',
  qty: '125',
  side: 'long',
  openedAt,
  horizon: '3d',
  atrAtEntry: '2.00000000',
  config: exitsConfig(),
  latestPrice: '100.000000',
  now: new Date(openedAt.getTime() + HOUR_MS),
  ...over,
});

describe('evaluateExit — time stop', () => {
  it('holds 1ms before the horizon deadline', () => {
    const result = evaluateExit(input({ now: new Date(openedAt.getTime() + 3 * DAY_MS - 1) }));
    expect(result).toEqual({ shouldClose: false, reason: null });
  });

  it('closes exactly AT the deadline (inclusive boundary)', () => {
    const result = evaluateExit(input({ now: new Date(openedAt.getTime() + 3 * DAY_MS) }));
    expect(result).toEqual({ shouldClose: true, reason: 'time_stop' });
  });

  it('intraday horizon is one 6.5h session', () => {
    expect(HORIZON_DURATION_MS.intraday).toBe(6.5 * HOUR_MS);
    const before = evaluateExit(
      input({ horizon: 'intraday', now: new Date(openedAt.getTime() + 6.5 * HOUR_MS - 1) }),
    );
    expect(before.shouldClose).toBe(false);
    const at = evaluateExit(
      input({ horizon: 'intraday', now: new Date(openedAt.getTime() + 6.5 * HOUR_MS) }),
    );
    expect(at.reason).toBe('time_stop');
  });

  it('1d and 5d are calendar days', () => {
    expect(HORIZON_DURATION_MS['1d']).toBe(DAY_MS);
    expect(HORIZON_DURATION_MS['5d']).toBe(5 * DAY_MS);
    const result = evaluateExit(
      input({ horizon: '5d', now: new Date(openedAt.getTime() + 5 * DAY_MS) }),
    );
    expect(result.reason).toBe('time_stop');
  });

  it('null horizon falls back to config.defaultTimeStopHorizon', () => {
    const result = evaluateExit(
      input({
        horizon: null,
        config: exitsConfig({ defaultTimeStopHorizon: '1d' }),
        now: new Date(openedAt.getTime() + DAY_MS),
      }),
    );
    expect(result.reason).toBe('time_stop');
  });
});

describe('evaluateExit — stop loss', () => {
  it('long: closes when the adverse move reaches stopAtrMultiple × ATR (inclusive)', () => {
    // stop distance = 2 × 2 = 4 → trigger at 96.
    expect(evaluateExit(input({ latestPrice: '96.000000' })).reason).toBe('stop_loss');
    expect(evaluateExit(input({ latestPrice: '95.000000' })).reason).toBe('stop_loss');
  });

  it('long: holds one tick above the stop', () => {
    expect(evaluateExit(input({ latestPrice: '96.000001' })).shouldClose).toBe(false);
  });

  it('short: symmetric — an UP move is adverse', () => {
    expect(evaluateExit(input({ side: 'short', latestPrice: '104.000000' })).reason).toBe(
      'stop_loss',
    );
    expect(evaluateExit(input({ side: 'short', latestPrice: '103.999999' })).shouldClose).toBe(
      false,
    );
    // A crash is pure profit for a short — no stop.
    expect(evaluateExit(input({ side: 'short', latestPrice: '90.000000' })).shouldClose).toBe(
      false,
    );
  });
});

describe('evaluateExit — take profit', () => {
  const withTp = exitsConfig({ takeProfitAtrMultiple: 3 }); // trigger at ±6 from entry

  it('closes when the favorable move reaches takeProfitAtrMultiple × ATR (inclusive)', () => {
    expect(evaluateExit(input({ config: withTp, latestPrice: '106.000000' })).reason).toBe(
      'take_profit',
    );
    expect(evaluateExit(input({ config: withTp, latestPrice: '105.999999' })).shouldClose).toBe(
      false,
    );
  });

  it('is symmetric for shorts (favorable = down)', () => {
    expect(
      evaluateExit(input({ config: withTp, side: 'short', latestPrice: '94.000000' })).reason,
    ).toBe('take_profit');
  });

  it('null takeProfitAtrMultiple disables it — a huge win still holds until the horizon', () => {
    const result = evaluateExit(input({ latestPrice: '200.000000' }));
    expect(result).toEqual({ shouldClose: false, reason: null });
  });
});

describe('evaluateExit — rule priority (deterministic when several trigger)', () => {
  const pastDeadline = new Date(openedAt.getTime() + 10 * DAY_MS);

  it('stop_loss beats time_stop', () => {
    const result = evaluateExit(input({ latestPrice: '90.000000', now: pastDeadline }));
    expect(result.reason).toBe('stop_loss');
  });

  it('take_profit beats time_stop', () => {
    const result = evaluateExit(
      input({
        config: exitsConfig({ takeProfitAtrMultiple: 3 }),
        latestPrice: '110.000000',
        now: pastDeadline,
      }),
    );
    expect(result.reason).toBe('take_profit');
  });
});

describe('evaluateExit — degenerate ATR guard', () => {
  it('zero ATR disables price rules instead of insta-closing at entry', () => {
    const flat = evaluateExit(input({ atrAtEntry: '0' }));
    expect(flat).toEqual({ shouldClose: false, reason: null }); // adverse 0 ≥ 0 must NOT trigger
    const losing = evaluateExit(input({ atrAtEntry: '0', latestPrice: '50.000000' }));
    expect(losing.shouldClose).toBe(false);
  });

  it('zero ATR still honors the time stop', () => {
    const result = evaluateExit(
      input({ atrAtEntry: '0', now: new Date(openedAt.getTime() + 3 * DAY_MS) }),
    );
    expect(result.reason).toBe('time_stop');
  });
});
