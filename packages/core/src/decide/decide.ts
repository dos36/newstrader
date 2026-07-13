import type { DecideFn, GateResult } from '../trading/contracts.js';

import { sizePosition } from './sizing.js';

/**
 * The pure decision engine — architecture §3/§6. A function of exactly
 * (signal, features, quote, config): no I/O, no clock, no randomness.
 * Everything it reads arrives as a parameter and is snapshotted into the
 * decisions row by the wiring layer, so replay Mode A re-executes this
 * function from stored inputs and must reproduce results bit-for-bit.
 *
 * Gate semantics:
 *  - ALL screening gates are evaluated even after a failure — the decisions
 *    row must show every gate's verdict, not just the first miss. skipReason
 *    is the FIRST failing gate in evaluation order.
 *  - Sizing gates (atr_available, position_too_small) run only when every
 *    screening gate passes: they describe how a would-be trade was sized, and
 *    evaluating them for an already-skipped signal would add noise, not data.
 *  - For config-toggled gates (already_expected, calendar_match) a disabled
 *    toggle records the gate as PASS with threshold null — "not enforced by
 *    this rules version" stays visible in the row.
 *
 * Null-input stance: an unmeasurable input is NOT tradeable. A null
 * priceMoveSinceAnchorBps fails stale_move; a null medianDollarVolume fails
 * liquidity (except crypto — our crypto bars have no dollar-volume concept,
 * so the gate auto-passes with threshold null for crypto instruments).
 *
 * What decide() does NOT do:
 *  - Build the OrderIntent. The decisionKey (signal × rules version × replay
 *    run) is minted by the DB layer and is not an engine input, so the intent
 *    (whose clientOrderId derives from it) is built by intent.ts afterwards.
 *    DecideResult.intent is therefore always absent here.
 *  - Check the kill switch. Suppression is an EXECUTION concern: when tripped,
 *    the wiring layer still records this result (suppressed=true) and emits no
 *    order. The engine never knows the switch exists.
 */

/** Screening gates in evaluation order; skipReason is the first failure. */
export const GATE_ORDER = [
  'direction_actionable',
  'min_confidence',
  'already_expected',
  'calendar_match',
  'event_type_whitelist',
  'stale_move',
  'liquidity',
  'max_concurrent_positions',
  'no_existing_position',
] as const;

export type ScreeningGate = (typeof GATE_ORDER)[number];

/** Sizing gates, appended after GATE_ORDER when all screening gates pass. */
export const SIZING_GATE_ORDER = ['atr_available', 'position_too_small'] as const;

export const decide: DecideFn = (signal, features, quote, config) => {
  const g = config.gates;

  const gates: GateResult[] = [
    {
      gate: 'direction_actionable',
      // neutral is never actionable; bearish only when the config allows shorts.
      pass: signal.direction === 'bullish' || (signal.direction === 'bearish' && g.allowShorts),
      observed: signal.direction,
      threshold: g.allowShorts ? 'bullish|bearish' : 'bullish',
    },
    {
      gate: 'min_confidence',
      pass: signal.confidence >= g.minConfidence,
      observed: signal.confidence,
      threshold: g.minConfidence,
    },
    {
      gate: 'already_expected',
      pass: !g.rejectAlreadyExpected || !signal.alreadyExpected,
      observed: signal.alreadyExpected,
      // threshold false = "observed must be false"; null = gate not enforced.
      threshold: g.rejectAlreadyExpected ? false : null,
    },
    {
      gate: 'calendar_match',
      pass: !g.rejectCalendarMatch || !features.calendarMatch,
      observed: features.calendarMatch,
      threshold: g.rejectCalendarMatch ? false : null,
    },
    {
      gate: 'event_type_whitelist',
      // Empty whitelist ⇒ this gate fails for every signal (threshold '').
      pass: g.eventTypeWhitelist.includes(signal.eventType),
      observed: signal.eventType,
      threshold: g.eventTypeWhitelist.join(','),
    },
    {
      gate: 'stale_move',
      // null move = not computable = FAIL: unmeasurable is not tradeable.
      pass:
        features.priceMoveSinceAnchorBps !== null &&
        Math.abs(features.priceMoveSinceAnchorBps) <= g.staleMoveMaxBps,
      observed: features.priceMoveSinceAnchorBps,
      threshold: g.staleMoveMaxBps,
    },
    {
      gate: 'liquidity',
      // Crypto auto-passes: our crypto bars carry no dollar-volume concept
      // (BTC/ETH/SOL liquidity dwarfs our sizes anyway). null = FAIL for equities.
      pass:
        signal.assetClass === 'crypto' ||
        (features.medianDollarVolume !== null &&
          features.medianDollarVolume >= g.minMedianDollarVolume),
      observed: features.medianDollarVolume,
      threshold: signal.assetClass === 'crypto' ? null : g.minMedianDollarVolume,
    },
    {
      gate: 'max_concurrent_positions',
      // Strict <: opening one more position must not exceed the cap.
      pass: features.openPositionsCount < g.maxConcurrentPositions,
      observed: features.openPositionsCount,
      threshold: g.maxConcurrentPositions,
    },
    {
      gate: 'no_existing_position',
      pass: !features.hasOpenPositionForInstrument,
      observed: features.hasOpenPositionForInstrument,
      threshold: false,
    },
  ];

  const firstFail = gates.find((gate) => !gate.pass);
  if (firstFail !== undefined) {
    return { action: 'skip', skipReason: firstFail.gate, gates };
  }

  const sizing = sizePosition({
    assetClass: signal.assetClass,
    atr: features.atr,
    paperEquityUsd: features.paperEquityUsd,
    price: quote.price,
    sizing: config.sizing,
  });
  gates.push(...sizing.gates);
  if (!sizing.sized) {
    return { action: 'skip', skipReason: sizing.skipReason, gates };
  }

  return {
    // direction_actionable passed, so direction is bullish or bearish-with-shorts.
    action: signal.direction === 'bearish' ? 'open_short' : 'open_long',
    gates,
    sizedQty: sizing.qty,
    sizedNotional: sizing.notional,
  };
};
