import { z } from 'zod';

/**
 * M4 trading contracts — the coupling point between the pure decision engine
 * (packages/core/src/decide), the SimBroker (packages/core/src/broker), and
 * the DB orchestration layer (packages/db/src/trading, packages/db/src/execution).
 *
 * Everything here is deliberately serializable: decisions snapshot their full
 * input (architecture §3 replay contract), so every type below must survive a
 * jsonb round-trip. Money/qty values are decimal STRINGS end to end.
 */

// ------------------------------------------------------------ rules config --

export const TradeHorizon = z.enum(['intraday', '1d', '3d', '5d']);
export type TradeHorizon = z.infer<typeof TradeHorizon>;

/**
 * Versioned deterministic-engine config (rules_versions.config). The engine is
 * a pure function of (signal, features, quote, config) — config is DATA, and
 * every change ships as a new rules_versions row, never an in-place edit.
 */
export const RulesConfig = z.object({
  gates: z.object({
    /** Minimum LLM signal confidence. */
    minConfidence: z.number().min(0).max(1),
    /** Signals the LLM marked already_expected are skipped when true. */
    rejectAlreadyExpected: z.boolean(),
    /** Skip when a scheduled event matches the anchor (calendar_match feature). */
    rejectCalendarMatch: z.boolean(),
    /**
     * Tradeable event types. Empty list = trade NOTHING (the whitelist is
     * EARNED by event-study evidence, never assumed — architecture §6).
     */
    eventTypeWhitelist: z.array(z.string()),
    /** Stale-move gate: skip when |price move since anchor| exceeds this. */
    staleMoveMaxBps: z.number().positive(),
    /** Liquidity floor on the 20d median daily dollar volume (USD). */
    minMedianDollarVolume: z.number().nonnegative(),
    /** Portfolio caps. */
    maxConcurrentPositions: z.number().int().positive(),
    /** v1 is long-only: bearish signals are logged as skips when false. */
    allowShorts: z.boolean(),
  }),
  sizing: z.object({
    /** Risk budget per position, in bps of paper equity. */
    riskBpsOfEquity: z.number().positive(),
    /** ATR lookback (daily bars) for volatility scaling + stop distance. */
    atrLookbackDays: z.number().int().positive(),
    /** Stop distance = atrStopMultiple × ATR; also the sizing denominator. */
    atrStopMultiple: z.number().positive(),
    /** Hard cap: position notional as a fraction of equity (0..1). */
    maxPositionNotionalPct: z.number().positive().max(1),
  }),
  exits: z.object({
    /** Mandatory time stop at the signal's horizon (fallback when signal has none). */
    defaultTimeStopHorizon: TradeHorizon,
    /** Protective stop distance in ATR multiples (same ATR as sizing). */
    stopAtrMultiple: z.number().positive(),
    /** Optional take-profit in ATR multiples; null = none. */
    takeProfitAtrMultiple: z.number().positive().nullable(),
  }),
});
export type RulesConfig = z.infer<typeof RulesConfig>;

// ------------------------------------------------------------ decide inputs --

/** The slice of an llm_signals row the engine reads. */
export const SignalInput = z.object({
  id: z.string(),
  clusterId: z.string(),
  instrumentId: z.string(),
  assetClass: z.enum(['us_equity', 'crypto']),
  eventType: z.string(),
  direction: z.enum(['bullish', 'bearish', 'neutral']),
  expectedMoveBps: z.number(),
  horizon: TradeHorizon,
  alreadyExpected: z.boolean(),
  materiality: z.number(),
  confidence: z.number(),
  /** Cluster anchor (first_received_at) — the stale-move reference point. */
  anchorTs: z.string().datetime({ offset: true }),
});
export type SignalInput = z.infer<typeof SignalInput>;

/**
 * Everything the engine reads that is not on the signal row. Assembled by the
 * DB layer at decision time and SNAPSHOTTED into decisions.features — replay
 * re-executes decide() from the stored copy, never from live queries.
 */
export const DecideFeatures = z.object({
  clusterItemCount: z.number().int().nonnegative(),
  distinctSourceCount: z.number().int().nonnegative(),
  /** Trailing cluster velocity (items/hour over the last hour). */
  itemsPerHour: z.number().nonnegative(),
  /** A scheduled event (macro, or earnings for this instrument) matches the anchor. */
  calendarMatch: z.boolean(),
  /** Price move from anchor to decision time; null = not computable (skip-safe). */
  priceMoveSinceAnchorBps: z.number().nullable(),
  /** 20d median daily dollar volume (USD); null = unknown. */
  medianDollarVolume: z.number().nullable(),
  /** ATR over sizing.atrLookbackDays, in PRICE terms (decimal string); null = unknown. */
  atr: z.string().nullable(),
  openPositionsCount: z.number().int().nonnegative(),
  hasOpenPositionForInstrument: z.boolean(),
  /** Paper account equity in USD at decision time. */
  paperEquityUsd: z.string(),
  /** Engine build stamp — config versioning does not protect against code drift. */
  engineVersion: z.string(),
});
export type DecideFeatures = z.infer<typeof DecideFeatures>;

/**
 * WORLD vs PORTFOLIO feature tagging — the Mode-B replay contract (roadmap
 * §4.1). World features describe the market and the news; they were true at
 * decision time no matter which rules version was running, so a counterfactual
 * replay REUSES them from the live snapshot. Portfolio features describe OUR
 * book, which a different rules version would have built differently, so a
 * counterfactual replay must RECOMPUTE them from its own simulated fills.
 *
 * engineVersion is in neither set: it is a build stamp, kept from the base
 * snapshot by withPortfolioFeatures. The partition test in contracts.test.ts
 * fails compilation/tests when a new DecideFeatures key is added without
 * deciding which set it belongs to — that decision is exactly what keeps
 * Mode B sound.
 */
export const WORLD_FEATURE_KEYS = [
  'clusterItemCount',
  'distinctSourceCount',
  'itemsPerHour',
  'calendarMatch',
  'priceMoveSinceAnchorBps',
  'medianDollarVolume',
  'atr',
] as const;

export const PORTFOLIO_FEATURE_KEYS = [
  'openPositionsCount',
  'hasOpenPositionForInstrument',
  'paperEquityUsd',
] as const;

export type PortfolioFeatures = Pick<DecideFeatures, (typeof PORTFOLIO_FEATURE_KEYS)[number]>;

/**
 * Overlay a recomputed portfolio state onto a stored feature snapshot,
 * keeping every world feature (and the engineVersion stamp) as snapshotted.
 * Parsed on the way out so the result round-trips through replay unchanged.
 */
export function withPortfolioFeatures(
  base: DecideFeatures,
  portfolio: PortfolioFeatures,
): DecideFeatures {
  return DecideFeatures.parse({ ...base, ...portfolio });
}

/** Price context at decision time (decisions.quote_snapshot). */
export const QuoteSnapshot = z.object({
  /** Last known price (decimal string). */
  price: z.string(),
  /** Timestamp of the bar/quote the price came from. */
  ts: z.string().datetime({ offset: true }),
  source: z.string(),
  /** Bar-close proxies have no spread; real quotes may fill this in later. */
  spreadBps: z.number().nullable(),
});
export type QuoteSnapshot = z.infer<typeof QuoteSnapshot>;

// ----------------------------------------------------------- decide outputs --

export const GateResult = z.object({
  gate: z.string(),
  pass: z.boolean(),
  observed: z.union([z.number(), z.string(), z.boolean(), z.null()]),
  threshold: z.union([z.number(), z.string(), z.boolean(), z.null()]),
});
export type GateResult = z.infer<typeof GateResult>;

export const DecideAction = z.enum(['open_long', 'open_short', 'close', 'skip']);
export type DecideAction = z.infer<typeof DecideAction>;

/** Venue-agnostic order intent (architecture §4: strategy never imports a broker SDK). */
export const OrderIntent = z.object({
  /** Deterministic idempotency key — same decision can never double-order. */
  clientOrderId: z.string(),
  decisionKey: z.string(),
  instrumentId: z.string(),
  assetClass: z.enum(['us_equity', 'crypto']),
  side: z.enum(['buy', 'sell']),
  /** Decimal string. */
  qty: z.string(),
  orderType: z.literal('market'),
  tif: z.literal('day'),
});
export type OrderIntent = z.infer<typeof OrderIntent>;

export interface DecideResult {
  action: DecideAction;
  /** First failing gate when action=skip. */
  skipReason?: string;
  /** EVERY gate evaluated, pass or fail, in evaluation order. */
  gates: GateResult[];
  /** Set when action opens a position. */
  sizedQty?: string;
  sizedNotional?: string;
  /** The order to emit (absent for skip; suppressed separately by the kill switch). */
  intent?: OrderIntent;
}

/** The pure engine signature. No I/O, no clock, no randomness. */
export type DecideFn = (
  signal: SignalInput,
  features: DecideFeatures,
  quote: QuoteSnapshot,
  config: RulesConfig,
) => DecideResult;

// ------------------------------------------------------------------ broker --

export interface OrderAck {
  brokerOrderId: string;
  status: 'accepted' | 'rejected';
  reason?: string;
}

export interface BrokerPosition {
  instrumentId: string;
  /** Signed decimal string (negative = short). */
  qty: string;
  avgEntryPrice: string;
}

export interface BrokerAccountState {
  cashUsd: string;
  equityUsd: string;
}

/**
 * Minimal v1 broker port. SimBroker implements it against recorded bars; the
 * IBKR/Kraken adapters implement it at go-live. Strategy/decision code never
 * sees past this interface.
 */
export interface BrokerAdapter {
  readonly venue: string;
  placeOrder(intent: OrderIntent): Promise<OrderAck>;
  getPositions(): Promise<BrokerPosition[]>;
  getAccountState(): Promise<BrokerAccountState>;
}
