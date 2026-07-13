import type { RulesConfig } from '../trading/contracts.js';

/**
 * v1 default rules — deliberately a config that trades NOTHING.
 *
 * The empty event-type whitelist is the point: entries into it are EARNED by
 * event-study evidence from the reaction analytics (architecture §6), never
 * assumed. Everything else is set conservatively so that when the first event
 * type is whitelisted, the surrounding gates and sizing are already sane.
 * Ships as an immutable rules_versions row; changes are NEW rows.
 */

export const DEFAULT_RULES_LABEL = 'v1-conservative';

export const DEFAULT_RULES_V1: RulesConfig = {
  gates: {
    /** Trade only high-conviction LLM reads; the calibration report earns any loosening. */
    minConfidence: 0.75,
    /** News the LLM judges priced-in has no edge at an hours horizon. */
    rejectAlreadyExpected: true,
    /** A scheduled release matching the anchor is "expected" by deterministic ground truth. */
    rejectCalendarMatch: true,
    /** EMPTY on purpose — the default config trades nothing until evidence earns entries (§6). */
    eventTypeWhitelist: [],
    /** If the price already moved >3% since the anchor, the market beat us; chasing is a different strategy. */
    staleMoveMaxBps: 300,
    /** $5M/day 20d-median floor keeps paper fills honest for eventual live sizes. */
    minMedianDollarVolume: 5_000_000,
    /** Caps blast radius and keeps per-position risk meaningful on small paper equity. */
    maxConcurrentPositions: 10,
    /** Long-only v1: shorting adds borrow/locate semantics SimBroker cannot honestly model. */
    allowShorts: false,
  },
  sizing: {
    /** 0.5% of equity at risk per position — survives long losing streaks while measuring edge. */
    riskBpsOfEquity: 50,
    /** Standard 14-day ATR window, matching the reaction-analytics volatility framing. */
    atrLookbackDays: 14,
    /** Stop sits 2×ATR away — outside normal daily noise; also the sizing denominator. */
    atrStopMultiple: 2,
    /** No single name exceeds 10% of equity, even when a tiny ATR implies a huge qty. */
    maxPositionNotionalPct: 0.1,
  },
  exits: {
    /** Middle of the measured reaction ladder; fallback when a signal carries no horizon. */
    defaultTimeStopHorizon: '3d',
    /** Protective stop mirrors the sizing denominator — risk taken equals risk budgeted. */
    stopAtrMultiple: 2,
    /** No take-profit in v1: reaction analytics should observe full drift, not truncate it. */
    takeProfitAtrMultiple: null,
  },
};
