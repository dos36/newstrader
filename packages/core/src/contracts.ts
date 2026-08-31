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
  /**
   * BACKFILL ONLY — the historical arrival time to record as `received_at`.
   *
   * Invariant 3 says `received_at` is our clock and the only clock the trading
   * path may use. A backfill has no such observation: nobody was watching in
   * 2016. Stamping `now()` instead would land ten years of archive at today's
   * timestamp, which is useless for a backtest, so a backfill adapter supplies
   * the historical instant here (normally derived from the source's own
   * `published_at`).
   *
   * That makes this value a SOURCE CLAIM wearing `received_at`'s clothes, which
   * is why it is fenced three ways: only an adapter with `backfill === true` is
   * allowed to set it, {@link SourceAdapter} is the thing that grants the
   * licence, and the ingest path ignores it on every other adapter. Rows
   * created this way must also carry `meta.backfill = true` so analytics can
   * exclude them from anything that claims to measure observed latency.
   *
   * Live adapters MUST omit this field.
   */
  receivedAtOverride: z.string().datetime({ offset: true }).optional(),
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
  /**
   * `true` marks a historical-archive adapter, which licenses the ingest path
   * to honour each item's {@link FetchedItem.receivedAtOverride} instead of
   * stamping `now()`. Absent or `false` on every live adapter, and the ingest
   * path drops the override for those — so a live adapter cannot backdate its
   * own arrival times, whether by accident or by a compromised feed.
   */
  readonly backfill?: boolean;
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
