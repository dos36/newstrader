import type { RulesConfig, TradeHorizon } from '../trading/contracts.js';

import { mulScaled, parseScaled, scaledFromNumber } from './decimal.js';

/**
 * Pure exit evaluation for the position manager (architecture §5.4: exits are
 * decisions too, replayable under the same versioning machinery). No clock —
 * `now` is a parameter, supplied live by the scheduler tick and in replay by
 * the simulated timeline.
 *
 * Rule priority when several trigger on the same evaluation (deterministic,
 * documented, replay-stable):
 *   1. stop_loss    — risk control dominates everything.
 *   2. take_profit  — banking a win beats waiting out the clock.
 *   3. time_stop    — the mandatory horizon backstop.
 *
 * Horizon → duration (calendar time, not sessions):
 *   - intraday = 6.5h — one regular US equity session length.
 *   - 1d/3d/5d = calendar days. Weekends/holidays count: crypto trades
 *     through them, and for equities the close simply executes at the
 *     position manager's next tick after the deadline — a session-aware
 *     calendar here would add complexity without changing when the order can
 *     actually fill.
 *
 * Zero/degenerate ATR guard: a stop or take-profit distance that truncates to
 * zero would close every position instantly (adverse ≥ 0 is always true), so
 * non-positive distances disable that rule; the time stop still applies.
 */

const HOUR_MS = 3_600_000;
const DAY_MS = 86_400_000;

/** Horizon label → time-stop duration in milliseconds. */
export const HORIZON_DURATION_MS: Record<TradeHorizon, number> = {
  intraday: 6.5 * HOUR_MS,
  '1d': DAY_MS,
  '3d': 3 * DAY_MS,
  '5d': 5 * DAY_MS,
};

export type PositionSide = 'long' | 'short';

export type ExitReason = 'time_stop' | 'stop_loss' | 'take_profit';

export interface ExitEvaluationInput {
  /** Average entry price (decimal string). */
  entryPrice: string;
  /** Open qty (decimal string) — carried for the close intent; the rules don't read it. */
  qty: string;
  side: PositionSide;
  openedAt: Date;
  /** The signal's horizon; null falls back to config.defaultTimeStopHorizon. */
  horizon: TradeHorizon | null;
  /** ATR frozen at entry (the same value sizing used), price terms. */
  atrAtEntry: string;
  config: RulesConfig['exits'];
  /** Latest known price (decimal string). */
  latestPrice: string;
  now: Date;
}

export interface ExitEvaluation {
  shouldClose: boolean;
  reason: ExitReason | null;
}

export function evaluateExit(input: ExitEvaluationInput): ExitEvaluation {
  const entry = parseScaled(input.entryPrice, 'entryPrice');
  const latest = parseScaled(input.latestPrice, 'latestPrice');
  const atr = parseScaled(input.atrAtEntry, 'atrAtEntry');

  // Signed move in the position's favor: positive = winning.
  const favorableMove = input.side === 'long' ? latest - entry : entry - latest;
  const adverseMove = -favorableMove;

  const stopDistance = mulScaled(
    scaledFromNumber(input.config.stopAtrMultiple, 'exits.stopAtrMultiple'),
    atr,
  );
  if (stopDistance > 0n && adverseMove >= stopDistance) {
    return { shouldClose: true, reason: 'stop_loss' };
  }

  if (input.config.takeProfitAtrMultiple !== null) {
    const takeProfitDistance = mulScaled(
      scaledFromNumber(input.config.takeProfitAtrMultiple, 'exits.takeProfitAtrMultiple'),
      atr,
    );
    if (takeProfitDistance > 0n && favorableMove >= takeProfitDistance) {
      return { shouldClose: true, reason: 'take_profit' };
    }
  }

  const horizon = input.horizon ?? input.config.defaultTimeStopHorizon;
  const deadlineMs = input.openedAt.getTime() + HORIZON_DURATION_MS[horizon];
  if (input.now.getTime() >= deadlineMs) {
    return { shouldClose: true, reason: 'time_stop' };
  }

  return { shouldClose: false, reason: null };
}
