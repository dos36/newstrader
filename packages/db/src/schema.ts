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
