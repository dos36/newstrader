import { z } from 'zod';

/**
 * Versioned message contracts between pipeline stages.
 *
 * These schemas are the ONLY coupling between pollers, the process stage, and
 * (later) queue transports. A websocket-based source at the minutes-level
 * migration emits the same RawItemV1 and nothing downstream changes.
 */

export const SourceKind = z.enum(['sec_edgar', 'newsapi', 'rss', 'exchange_notice']);
export type SourceKind = z.infer<typeof SourceKind>;

export const AssetClass = z.enum(['us_equity', 'crypto']);
export type AssetClass = z.infer<typeof AssetClass>;

export const CanonicalSymbol = z.object({
  assetClass: AssetClass,
  symbol: z.string().min(1),
});
export type CanonicalSymbol = z.infer<typeof CanonicalSymbol>;

/**
 * One news item as fetched from a source, before persistence.
 * `externalId` must be the source's own stable id (accession number, article id,
 * RSS guid) — it is half of the ingest idempotency key (source_key, external_id).
 */
export const FetchedItem = z.object({
  externalId: z.string().min(1),
  url: z.string().url().optional(),
  headline: z.string().min(1),
  /** Full text/body when the source provides it. */
  body: z.string().optional(),
  /** What the source CLAIMS. Analytics only — never the trading clock. */
  publishedAt: z.string().datetime({ offset: true }).optional(),
  /** Source-provided ticker hints (e.g. Massive tags). Hints, not truth. */
  symbolsHint: z.array(z.string()).optional(),
  /** Structured extras (e.g. 8-K item codes, sentiment tags). */
  meta: z.record(z.unknown()).optional(),
  /** The raw payload exactly as received; persisted verbatim to the raw store. */
  raw: z.unknown(),
});
export type FetchedItem = z.infer<typeof FetchedItem>;

/** Pointer message emitted after a raw item is persisted (S3/fs + Postgres row). */
export const RawItemV1 = z.object({
  v: z.literal(1),
  itemId: z.string(),
  sourceKey: z.string(),
  externalId: z.string(),
  headline: z.string(),
  payloadRef: z.string(),
  contentHash: z.string(),
  publishedAt: z.string().datetime({ offset: true }).nullable(),
  receivedAt: z.string().datetime({ offset: true }),
  symbolsHint: z.array(z.string()).default([]),
  meta: z.record(z.unknown()).default({}),
});
export type RawItemV1 = z.infer<typeof RawItemV1>;

/** Result of one adapter poll. `nextCursor` is persisted in ingest_watermarks. */
export interface FetchResult {
  items: FetchedItem[];
  nextCursor: string | null;
}

/**
 * Every news source implements this. Pull-based in v1; a push-based source at
 * the minutes migration is just another implementation that buffers frames.
 */
export interface SourceAdapter {
  /** Stable key referenced by news_sources.source_key (e.g. 'edgar_8k'). */
  readonly sourceKey: string;
  readonly kind: SourceKind;
  fetchSince(cursor: string | null): Promise<FetchResult>;
}

/**
 * Raw payload storage. FsRawStore locally, S3RawStore when deployed.
 * Returned ref is stored on raw_news_items.payload_ref.
 */
export interface RawStore {
  put(key: string, payload: unknown): Promise<string>;
  get(ref: string): Promise<unknown>;
}
