import {
  bigint,
  boolean,
  index,
  jsonb,
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
    status: text('status', { enum: ['open', 'closed'] }).notNull().default('open'),
  },
  (t) => [index('clusters_first_received_idx').on(t.firstReceivedAt), index('clusters_status_idx').on(t.status)],
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
  (t) => [primaryKey({ columns: [t.clusterId, t.itemId] }), uniqueIndex('cluster_items_item_uq').on(t.itemId)],
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
  (t) => [uniqueIndex('instruments_symbol_class_uq').on(t.symbol, t.assetClass), index('instruments_cik_idx').on(t.cik)],
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
  (t) => [primaryKey({ columns: [t.instrumentId, t.indexCode, t.validFrom] })],
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
