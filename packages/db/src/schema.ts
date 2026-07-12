import { sql } from 'drizzle-orm';
import {
  bigint,
  boolean,
  index,
  jsonb,
  numeric,
  pgTable,
  primaryKey,
  real,
  text,
  timestamp,
  uniqueIndex,
} from 'drizzle-orm/pg-core';

/**
 * Milestone 0/1 schema: ingestion, clustering, instruments/universe.
 * Signal/decision/order/bar tables arrive with their milestones (M2/M3/M4)
 * as separate migrations — facts tables are append-only; new rows, never UPDATEs
 * (denormalized cluster counters are the one documented exception).
 *
 * Timestamp discipline: published_at is what the source CLAIMS (analytics only);
 * received_at is our clock and the ONLY clock the trading path may use.
 */

const tz = (name: string) => timestamp(name, { withTimezone: true, mode: 'date' });

export const newsSources = pgTable('news_sources', {
  id: text('id').primaryKey(),
  sourceKey: text('source_key').notNull().unique(),
  kind: text('kind', { enum: ['sec_edgar', 'newsapi', 'rss', 'exchange_notice'] }).notNull(),
  name: text('name').notNull(),
  handleOrUrl: text('handle_or_url'),
  baseTrust: real('base_trust').notNull().default(0.5),
  active: boolean('active').notNull().default(true),
  createdAt: tz('created_at').notNull().defaultNow(),
});

export const rawNewsItems = pgTable(
  'raw_news_items',
  {
    id: text('id').primaryKey(),
    sourceId: text('source_id')
      .notNull()
      .references(() => newsSources.id),
    externalId: text('external_id').notNull(),
    url: text('url'),
    headline: text('headline').notNull(),
    payloadRef: text('payload_ref').notNull(),
    contentHash: text('content_hash').notNull(),
    publishedAt: tz('published_at'),
    receivedAt: tz('received_at').notNull(),
    lang: text('lang'),
    symbolsHint: jsonb('symbols_hint').$type<string[]>().notNull().default([]),
    meta: jsonb('meta').$type<Record<string, unknown>>().notNull().default({}),
    ingestRunId: text('ingest_run_id'),
    createdAt: tz('created_at').notNull().defaultNow(),
  },
  (t) => [
    uniqueIndex('raw_items_source_external_uq').on(t.sourceId, t.externalId),
    index('raw_items_content_hash_idx').on(t.contentHash),
    index('raw_items_received_at_idx').on(t.receivedAt),
  ],
);

export const newsClusters = pgTable(
  'news_clusters',
  {
    id: text('id').primaryKey(),
    canonicalHeadline: text('canonical_headline').notNull(),
    /** normalizeText(canonical_headline) — trigram similarity target (GIN indexed). */
    normalizedHeadline: text('normalized_headline').notNull(),
    firstItemId: text('first_item_id').notNull(),
    firstSourceId: text('first_source_id').notNull(),
    /** Anchor timestamp for ALL reaction measurements. */
    firstReceivedAt: tz('first_received_at').notNull(),
    itemCount: bigint('item_count', { mode: 'number' }).notNull().default(1),
    distinctSourceCount: bigint('distinct_source_count', { mode: 'number' }).notNull().default(1),
    lastItemAt: tz('last_item_at').notNull(),
    status: text('status', { enum: ['open', 'closed'] })
      .notNull()
      .default('open'),
  },
  (t) => [
    index('clusters_first_received_idx').on(t.firstReceivedAt),
    index('clusters_status_idx').on(t.status),
  ],
);

export const newsClusterItems = pgTable(
  'news_cluster_items',
  {
    clusterId: text('cluster_id')
      .notNull()
      .references(() => newsClusters.id),
    itemId: text('item_id')
      .notNull()
      .references(() => rawNewsItems.id),
    similarity: real('similarity').notNull(),
    lagFromFirstMs: bigint('lag_from_first_ms', { mode: 'number' }).notNull(),
  },
  (t) => [
    primaryKey({ columns: [t.clusterId, t.itemId] }),
    uniqueIndex('cluster_items_item_uq').on(t.itemId),
  ],
);

export const instruments = pgTable(
  'instruments',
  {
    id: text('id').primaryKey(),
    symbol: text('symbol').notNull(),
    assetClass: text('asset_class', { enum: ['us_equity', 'crypto'] }).notNull(),
    exchange: text('exchange'),
    /** Mandatory for equities — SEC filings resolve deterministically via CIK. */
    cik: text('cik'),
    name: text('name').notNull(),
    /** Wikipedia-derived approximation; official GICS is licensed. */
    sectorApprox: text('sector_approx'),
    firstListedAt: tz('first_listed_at'),
    /** Delisted rows are kept forever (survivorship guard). */
    delistedAt: tz('delisted_at'),
  },
  (t) => [
    uniqueIndex('instruments_symbol_class_uq').on(t.symbol, t.assetClass),
    index('instruments_cik_idx').on(t.cik),
  ],
);

/** Point-in-time index membership. Universe queries MUST go through this with an asOf. */
export const indexMembership = pgTable(
  'index_membership',
  {
    instrumentId: text('instrument_id')
      .notNull()
      .references(() => instruments.id),
    indexCode: text('index_code').notNull(),
    validFrom: tz('valid_from').notNull(),
    /** NULL = currently a member. */
    validTo: tz('valid_to'),
  },
  (t) => [
    primaryKey({ columns: [t.instrumentId, t.indexCode, t.validFrom] }),
    // At most ONE open row per (instrument, index) — a duplicate open row means
    // point-in-time queries double-count and the sync diff is broken. A CHECK
    // (valid_to > valid_from) rides in the same migration; drizzle can't
    // express it, but a test-clock incident once wrote inverted intervals.
    uniqueIndex('membership_open_uq')
      .on(t.instrumentId, t.indexCode)
      .where(sql`valid_to is null`),
  ],
);

/** Point-in-time aliases — tickers and names get reused. */
export const instrumentAliases = pgTable(
  'instrument_aliases',
  {
    instrumentId: text('instrument_id')
      .notNull()
      .references(() => instruments.id),
    alias: text('alias').notNull(),
    aliasKind: text('alias_kind', { enum: ['name', 'ticker', 'cashtag', 'cik'] }).notNull(),
    validFrom: tz('valid_from').notNull(),
    validTo: tz('valid_to'),
  },
  (t) => [
    primaryKey({ columns: [t.instrumentId, t.alias, t.aliasKind, t.validFrom] }),
    index('aliases_alias_idx').on(t.alias),
  ],
);

export const itemInstrumentLinks = pgTable(
  'item_instrument_links',
  {
    itemId: text('item_id')
      .notNull()
      .references(() => rawNewsItems.id),
    instrumentId: text('instrument_id')
      .notNull()
      .references(() => instruments.id),
    method: text('method', {
      enum: ['cik_exact', 'ticker_exact', 'source_hint', 'alias_dict', 'llm_ner'],
    }).notNull(),
    confidence: real('confidence').notNull(),
    resolverVersion: text('resolver_version').notNull(),
  },
  (t) => [primaryKey({ columns: [t.itemId, t.instrumentId, t.resolverVersion] })],
);

export const ingestWatermarks = pgTable('ingest_watermarks', {
  sourceId: text('source_id')
    .primaryKey()
    .references(() => newsSources.id),
  cursor: text('cursor'),
  updatedAt: tz('updated_at').notNull().defaultNow(),
});

// ------------------------------------------------------------- M3: prices --

/** Prices are decimal STRINGS end to end (numeric columns) — never floats. */
const price = (name: string) => numeric(name, { precision: 18, scale: 6 });

/**
 * Minute bars, written by the bars-recorder (Massive full-market snapshot for
 * equities, Kraken REST for crypto) and by event-window backfills (Massive
 * aggregates). `source` records which pipe produced the row — reaction
 * analytics report it so delayed-snapshot bars are distinguishable from
 * consolidated historical bars.
 */
export const priceBars1m = pgTable(
  'price_bars_1m',
  {
    instrumentId: text('instrument_id')
      .notNull()
      .references(() => instruments.id),
    /** Bar OPEN time, UTC, minute-aligned. */
    ts: tz('ts').notNull(),
    open: price('open').notNull(),
    high: price('high').notNull(),
    low: price('low').notNull(),
    close: price('close').notNull(),
    volume: numeric('volume', { precision: 20, scale: 4 }),
    source: text('source').notNull(),
    createdAt: tz('created_at').notNull().defaultNow(),
  },
  (t) => [primaryKey({ columns: [t.instrumentId, t.ts] }), index('bars_1m_ts_idx').on(t.ts)],
);

/** Daily bars — benchmarks, beta estimation, long-horizon recovery metrics. */
export const priceBars1d = pgTable(
  'price_bars_1d',
  {
    instrumentId: text('instrument_id')
      .notNull()
      .references(() => instruments.id),
    /** Trading day, UTC midnight. */
    ts: tz('ts').notNull(),
    open: price('open').notNull(),
    high: price('high').notNull(),
    low: price('low').notNull(),
    close: price('close').notNull(),
    volume: numeric('volume', { precision: 20, scale: 4 }),
    source: text('source').notNull(),
    createdAt: tz('created_at').notNull().defaultNow(),
  },
  (t) => [primaryKey({ columns: [t.instrumentId, t.ts] })],
);

// -------------------------------------------- M3: reaction measurements --

export const REACTION_HORIZONS = ['5m', '15m', '30m', '1h', '4h', '1d', '3d', '5d'] as const;

/**
 * Abnormal-return ladder per (cluster, instrument, horizon), anchored on the
 * cluster's first_received_at (OUR clock — never published_at). Derived rows:
 * batch jobs rebuild them idempotently; measurer_version keys methodology
 * changes so old rows are comparable, never overwritten in place.
 */
export const reactionMeasurements = pgTable(
  'reaction_measurements',
  {
    clusterId: text('cluster_id')
      .notNull()
      .references(() => newsClusters.id),
    instrumentId: text('instrument_id')
      .notNull()
      .references(() => instruments.id),
    horizon: text('horizon', { enum: REACTION_HORIZONS }).notNull(),
    measurerVersion: text('measurer_version').notNull(),
    /** cluster.first_received_at, denormalized for query convenience. */
    anchorTs: tz('anchor_ts').notNull(),
    rawReturnBps: real('raw_return_bps').notNull(),
    /** Raw minus beta × benchmark return over the same window. */
    abnormalReturnBps: real('abnormal_return_bps').notNull(),
    /** Benchmark instrument symbol used (SPY for equities, BTC for crypto alts). */
    benchmark: text('benchmark'),
    betaUsed: real('beta_used'),
    barsSource: text('bars_source').notNull(),
    computedAt: tz('computed_at').notNull().defaultNow(),
  },
  (t) => [
    primaryKey({ columns: [t.clusterId, t.instrumentId, t.horizon, t.measurerVersion] }),
    index('reaction_anchor_idx').on(t.anchorTs),
  ],
);

/** One scalar row per (cluster, instrument): the "how fast does the market react" answer. */
export const reactionSummary = pgTable(
  'reaction_summary',
  {
    clusterId: text('cluster_id')
      .notNull()
      .references(() => newsClusters.id),
    instrumentId: text('instrument_id')
      .notNull()
      .references(() => instruments.id),
    measurerVersion: text('measurer_version').notNull(),
    anchorTs: tz('anchor_ts').notNull(),
    peakAbnormalMoveBps: real('peak_abnormal_move_bps').notNull(),
    timeToPeakMinutes: real('time_to_peak_minutes').notNull(),
    /** Minutes until half of the 1d move was realized — the alpha-decay scalar. */
    timeToHalfOf1dMoveMinutes: real('time_to_half_of_1d_move_minutes'),
    direction1d: text('direction_1d', { enum: ['up', 'down', 'flat'] }).notNull(),
    computedAt: tz('computed_at').notNull().defaultNow(),
  },
  (t) => [primaryKey({ columns: [t.clusterId, t.instrumentId, t.measurerVersion] })],
);

/** Recovery metrics for negative-direction events ("how fast does it recover"). */
export const recoveryMeasurements = pgTable(
  'recovery_measurements',
  {
    clusterId: text('cluster_id')
      .notNull()
      .references(() => newsClusters.id),
    instrumentId: text('instrument_id')
      .notNull()
      .references(() => instruments.id),
    measurerVersion: text('measurer_version').notNull(),
    anchorTs: tz('anchor_ts').notNull(),
    troughBps: real('trough_bps').notNull(),
    timeToTroughHours: real('time_to_trough_hours').notNull(),
    /** null = never (half-)reverted within the window. */
    timeToHalfReversionHours: real('time_to_half_reversion_hours'),
    timeToFullReversionHours: real('time_to_full_reversion_hours'),
    windowDays: real('window_days').notNull(),
    computedAt: tz('computed_at').notNull().defaultNow(),
  },
  (t) => [primaryKey({ columns: [t.clusterId, t.instrumentId, t.measurerVersion] })],
);

// ------------------------------------------------------- M3: calendars --

/**
 * Scheduled macro/earnings events feeding the `already_expected` /
 * `calendar_match` decision feature. event_key is the deterministic idempotency
 * key: `${kind}:${instrument symbol or 'macro'}:${scheduled_at ISO}`.
 */
export const scheduledEvents = pgTable(
  'scheduled_events',
  {
    id: text('id').primaryKey(),
    eventKey: text('event_key').notNull().unique(),
    kind: text('kind', { enum: ['fomc', 'cpi', 'nfp', 'gdp', 'pce', 'earnings'] }).notNull(),
    /** null for macro events; set for per-company earnings. */
    instrumentId: text('instrument_id').references(() => instruments.id),
    scheduledAt: tz('scheduled_at').notNull(),
    source: text('source').notNull(),
    meta: jsonb('meta').$type<Record<string, unknown>>().notNull().default({}),
    createdAt: tz('created_at').notNull().defaultNow(),
  },
  (t) => [
    index('scheduled_events_at_idx').on(t.scheduledAt),
    index('scheduled_events_instrument_idx').on(t.instrumentId),
  ],
);

// ------------------------------------------------- M2/M4: signals & trading --

/**
 * LLM-produced structured signals — the replayable asset (architecture §3).
 * Table ships with M4 so the decision engine and replay have their FK targets;
 * M2 populates it. signal_key is the idempotency key:
 * `${cluster_id}:${instrument_id ?? sector_code ?? 'macro'}:${prompt_version}:${model_id}`.
 * Re-prompting with a new prompt_version INSERTS new rows — old signals are
 * never touched (that is how prompt versions are A/B-compared).
 */
export const llmSignals = pgTable(
  'llm_signals',
  {
    id: text('id').primaryKey(),
    signalKey: text('signal_key').notNull().unique(),
    clusterId: text('cluster_id')
      .notNull()
      .references(() => newsClusters.id),
    scope: text('scope', { enum: ['company', 'sector', 'macro'] }).notNull(),
    /** Set iff scope=company. */
    instrumentId: text('instrument_id').references(() => instruments.id),
    /** Set iff scope=sector (GICS-approx sector name). */
    sectorCode: text('sector_code'),
    eventType: text('event_type').notNull(),
    direction: text('direction', { enum: ['bullish', 'bearish', 'neutral'] }).notNull(),
    expectedMoveBps: real('expected_move_bps').notNull(),
    horizon: text('horizon', { enum: ['intraday', '1d', '3d', '5d'] }).notNull(),
    alreadyExpected: boolean('already_expected').notNull(),
    materiality: real('materiality').notNull(),
    confidence: real('confidence').notNull(),
    modelId: text('model_id').notNull(),
    promptVersion: text('prompt_version').notNull(),
    /** Raw prompt/response refs (S3 key or file path) — the audit trail. */
    promptRef: text('prompt_ref'),
    responseRef: text('response_ref'),
    inputTokens: bigint('input_tokens', { mode: 'number' }),
    outputTokens: bigint('output_tokens', { mode: 'number' }),
    costUsd: real('cost_usd'),
    latencyMs: bigint('latency_ms', { mode: 'number' }),
    /** Popularity the LLM saw, frozen at analysis time. */
    clusterItemCountAtAnalysis: bigint('cluster_item_count_at_analysis', { mode: 'number' }),
    analyzedAt: tz('analyzed_at').notNull(),
  },
  (t) => [
    index('signals_cluster_idx').on(t.clusterId),
    index('signals_analyzed_idx').on(t.analyzedAt),
    index('signals_instrument_idx').on(t.instrumentId),
  ],
);

/**
 * Versioned deterministic-engine config. Immutable once referenced by any
 * decision: rule changes ship as NEW rows (config is data — architecture §3).
 */
export const rulesVersions = pgTable('rules_versions', {
  id: text('id').primaryKey(),
  versionLabel: text('version_label').notNull().unique(),
  config: jsonb('config').$type<Record<string, unknown>>().notNull(),
  /** sha256 of canonical JSON — dedup + integrity. */
  configHash: text('config_hash').notNull(),
  parentVersionId: text('parent_version_id'),
  description: text('description'),
  createdAt: tz('created_at').notNull().defaultNow(),
});

/** One row per replay execution over the stored signal log. */
export const replayRuns = pgTable('replay_runs', {
  id: text('id').primaryKey(),
  rulesVersionId: text('rules_version_id')
    .notNull()
    .references(() => rulesVersions.id),
  params: jsonb('params').$type<Record<string, unknown>>().notNull().default({}),
  signalsFrom: tz('signals_from'),
  signalsTo: tz('signals_to'),
  notes: text('notes'),
  createdAt: tz('created_at').notNull().defaultNow(),
});

/**
 * Every evaluation of a signal by the engine, INCLUDING skips — an engine that
 * only logs trades cannot be analyzed. Live and replayed decisions share this
 * table: replay_run_id NULL = live. decision_key is the idempotency key:
 * `${signal_id ?? exit-origin}:${rules_version_id}:${replay_run_id ?? 'live'}`.
 * Everything decide() read is snapshotted (gates/features/quote) — replay must
 * never refetch inputs (architecture §3 replay contract).
 */
export const decisions = pgTable(
  'decisions',
  {
    id: text('id').primaryKey(),
    decisionKey: text('decision_key').notNull().unique(),
    /** null for position-manager exits (no originating signal). */
    signalId: text('signal_id').references(() => llmSignals.id),
    instrumentId: text('instrument_id')
      .notNull()
      .references(() => instruments.id),
    rulesVersionId: text('rules_version_id')
      .notNull()
      .references(() => rulesVersions.id),
    /** NULL = live paper decision; set = produced by a replay run. */
    replayRunId: text('replay_run_id').references(() => replayRuns.id),
    decidedAt: tz('decided_at').notNull(),
    action: text('action', { enum: ['open_long', 'open_short', 'close', 'skip'] }).notNull(),
    /** First failing gate, denormalized for grouping. */
    skipReason: text('skip_reason'),
    /** Kill switch was tripped: decision recorded, no order emitted. */
    suppressed: boolean('suppressed').notNull().default(false),
    /** Every gate, pass or fail: [{gate, pass, observed, threshold}]. */
    gates: jsonb('gates').$type<unknown[]>().notNull().default([]),
    /** Everything the engine read beyond the signal row (velocity, positions, equity…). */
    features: jsonb('features').$type<Record<string, unknown>>().notNull().default({}),
    /** Price/spread at decision time — replay must not refetch. */
    quoteSnapshot: jsonb('quote_snapshot').$type<Record<string, unknown>>().notNull().default({}),
    sizedQty: numeric('sized_qty', { precision: 20, scale: 8 }),
    sizedNotional: numeric('sized_notional', { precision: 18, scale: 2 }),
  },
  (t) => [
    index('decisions_signal_idx').on(t.signalId),
    index('decisions_decided_idx').on(t.decidedAt),
    index('decisions_replay_idx').on(t.replayRunId),
  ],
);

export const orders = pgTable(
  'orders',
  {
    id: text('id').primaryKey(),
    decisionId: text('decision_id')
      .notNull()
      .references(() => decisions.id),
    instrumentId: text('instrument_id')
      .notNull()
      .references(() => instruments.id),
    side: text('side', { enum: ['buy', 'sell'] }).notNull(),
    qty: numeric('qty', { precision: 20, scale: 8 }).notNull(),
    orderType: text('order_type', { enum: ['market', 'limit'] }).notNull(),
    limitPrice: numeric('limit_price', { precision: 18, scale: 6 }),
    tif: text('tif', { enum: ['day', 'gtc', 'ioc'] }).notNull(),
    venue: text('venue').notNull(),
    /** Deterministic idempotency key, honored by SimBroker and real brokers alike. */
    clientOrderId: text('client_order_id').notNull().unique(),
    brokerOrderId: text('broker_order_id'),
    status: text('status', {
      enum: ['pending', 'accepted', 'filled', 'partially_filled', 'canceled', 'rejected'],
    }).notNull(),
    submittedAt: tz('submitted_at').notNull(),
  },
  (t) => [index('orders_decision_idx').on(t.decisionId), index('orders_status_idx').on(t.status)],
);

/** Append-only order lifecycle; status transitions are new rows, never UPDATEs on facts. */
export const orderEvents = pgTable(
  'order_events',
  {
    id: text('id').primaryKey(),
    orderId: text('order_id')
      .notNull()
      .references(() => orders.id),
    event: text('event').notNull(),
    payload: jsonb('payload').$type<Record<string, unknown>>().notNull().default({}),
    at: tz('at').notNull(),
  },
  (t) => [index('order_events_order_idx').on(t.orderId)],
);

export const fills = pgTable(
  'fills',
  {
    id: text('id').primaryKey(),
    orderId: text('order_id')
      .notNull()
      .references(() => orders.id),
    fillQty: numeric('fill_qty', { precision: 20, scale: 8 }).notNull(),
    fillPrice: numeric('fill_price', { precision: 18, scale: 6 }).notNull(),
    fee: numeric('fee', { precision: 18, scale: 6 }).notNull().default('0'),
    filledAt: tz('filled_at').notNull(),
    isSimulated: boolean('is_simulated').notNull(),
  },
  (t) => [index('fills_order_idx').on(t.orderId)],
);
