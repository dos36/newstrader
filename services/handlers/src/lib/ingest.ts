import { rawStoreKey } from '@newstrader/adapters';
import { contentHash, newId, RawItemV1 } from '@newstrader/core';
import type { RawStore, SourceAdapter } from '@newstrader/core';
import { attachItemToCluster, ingestWatermarks, newsSources, rawNewsItems } from '@newstrader/db';
import type { AttachItemInput, Db } from '@newstrader/db';

/**
 * Shared ingest core: the poll and process pipelines, callable from both the
 * CLI (services/cli) and the Lambda handlers (services/handlers/src/*.ts).
 *
 * Placement note: this lives in services/handlers/src/lib so the Lambda
 * bundler (NodejsFunction entry = handlers/src/poll.ts) sees only in-package
 * relative imports; the CLI reaches it via a relative import
 * (../../handlers/src/lib/ingest.js). Neither service package can depend on
 * the other through package.json without a lockfile change, which is off the
 * table while parallel agents share pnpm-lock.yaml.
 *
 * DB access style (deliberate): drizzle's query builder for writes — insert /
 * onConflict need no operator imports — and parameterized SQL via the
 * underlying pg pool (db.$client) for reads, because drizzle's `eq`/`sql`
 * operators live in drizzle-orm, which neither service declares. Keeping the
 * shared core free of drizzle-orm imports keeps both packages' dependency
 * lists honest.
 *
 * Timestamp discipline (architecture §8.1): received_at is stamped from OUR
 * clock (`deps.now`) at persist time; publishedAt is stored verbatim as the
 * source's claim and is never read by the trading path.
 */

export interface IngestDeps {
  db: Db;
  rawStore: RawStore;
  /**
   * Called with the cycle's pointer messages BEFORE the watermark advances.
   * If it throws, the cursor is not saved, so the next poll refetches and
   * re-emits — nothing is ever inserted without a pointer making it out.
   * Omit it (CLI) to skip enqueueing; `process` finds items by query instead.
   */
  enqueue?: (messages: RawItemV1[]) => Promise<void>;
  /** Injectable clock (tests). Every received_at comes from here. */
  now?: () => Date;
}

export interface PollCounts {
  sourceKey: string;
  fetched: number;
  inserted: number;
  duplicates: number;
  cursor: string | null;
}

export interface ProcessCounts {
  processed: number;
  newClusters: number;
  attachedExisting: number;
}

/**
 * One poll cycle for one adapter: load cursor → fetchSince → persist each item
 * (raw store put + idempotent DB insert) → enqueue pointers → save cursor.
 *
 * Duplicates also get their (existing) pointer re-emitted: if a previous cycle
 * crashed between insert and enqueue, the refetch after the unsaved cursor
 * re-emits the pointer instead of orphaning the row; process attach is
 * idempotent, so redundant pointers are harmless.
 *
 * Any throw aborts before the watermark is saved — the next cycle refetches
 * and the unique (source_id, external_id) constraint absorbs the overlap.
 */
export async function runPoll(deps: IngestDeps, adapter: SourceAdapter): Promise<PollCounts> {
  const now = deps.now ?? (() => new Date());
  const sourceId = await ensureSource(deps.db, adapter);
  const cursor = await loadCursor(deps.db, sourceId);
  const { items, nextCursor } = await adapter.fetchSince(cursor);

  const ingestRunId = newId();
  const messages: RawItemV1[] = [];
  let inserted = 0;
  let duplicates = 0;

  for (const item of items) {
    const receivedAt = now();
    const hash = contentHash(item.headline, item.body);
    // Raw store first (immutable, overwrite-idempotent), DB row second: a row
    // must never exist whose payload_ref points at nothing.
    const payloadRef = await deps.rawStore.put(
      rawStoreKey(adapter.sourceKey, receivedAt, hash, item.externalId),
      item.raw,
    );

    const id = newId();
    const insertedRows = await deps.db
      .insert(rawNewsItems)
      .values({
        id,
        sourceId,
        externalId: item.externalId,
        url: item.url ?? null,
        headline: item.headline,
        payloadRef,
        contentHash: hash,
        publishedAt: item.publishedAt !== undefined ? new Date(item.publishedAt) : null,
        receivedAt,
        symbolsHint: item.symbolsHint ?? [],
        meta: item.meta ?? {},
        ingestRunId,
      })
      .onConflictDoNothing({ target: [rawNewsItems.sourceId, rawNewsItems.externalId] })
      .returning({ id: rawNewsItems.id });

    if (insertedRows.length > 0) {
      inserted += 1;
      messages.push(
        RawItemV1.parse({
          v: 1,
          itemId: id,
          sourceKey: adapter.sourceKey,
          externalId: item.externalId,
          headline: item.headline,
          payloadRef,
          contentHash: hash,
          publishedAt:
            item.publishedAt !== undefined ? new Date(item.publishedAt).toISOString() : null,
          receivedAt: receivedAt.toISOString(),
          symbolsHint: item.symbolsHint ?? [],
          meta: item.meta ?? {},
        } satisfies RawItemV1),
      );
    } else {
      duplicates += 1;
      const existing = await loadRawItemRow(deps.db, sourceId, item.externalId);
      if (existing !== undefined) {
        messages.push(RawItemV1.parse(rawItemV1FromRow(adapter.sourceKey, existing)));
      }
    }
  }

  if (deps.enqueue !== undefined && messages.length > 0) {
    await deps.enqueue(messages);
  }

  const savedAt = now();
  await deps.db
    .insert(ingestWatermarks)
    .values({ sourceId, cursor: nextCursor, updatedAt: savedAt })
    .onConflictDoUpdate({
      target: ingestWatermarks.sourceId,
      set: { cursor: nextCursor, updatedAt: savedAt },
    });

  return {
    sourceKey: adapter.sourceKey,
    fetched: items.length,
    inserted,
    duplicates,
    cursor: nextCursor,
  };
}

/**
 * Cluster a batch of persisted raw items. Attach is idempotent (advisory-locked
 * in packages/db), so redelivered batches are safe: they count as
 * attachedExisting and change nothing.
 */
export async function runProcess(
  db: Db,
  items: readonly AttachItemInput[],
): Promise<ProcessCounts> {
  let newClusters = 0;
  let attachedExisting = 0;
  for (const item of items) {
    const result = await attachItemToCluster(db, item);
    if (result.isNew) newClusters += 1;
    else attachedExisting += 1;
  }
  return { processed: items.length, newClusters, attachedExisting };
}

/**
 * Upsert the news_sources row for an adapter and return its id. Pollers call
 * this every cycle (self-healing — a Lambda poller works without a prior
 * sources:seed); the seed command reuses it to pre-register and refresh names.
 */
export async function ensureSource(db: Db, adapter: SourceAdapter): Promise<string> {
  const name = sourceDisplayName(adapter.sourceKey);
  const handleOrUrl = adapterHandleOrUrl(adapter);
  const rows = await db
    .insert(newsSources)
    .values({ id: newId(), sourceKey: adapter.sourceKey, kind: adapter.kind, name, handleOrUrl })
    .onConflictDoUpdate({
      target: newsSources.sourceKey,
      set: { kind: adapter.kind, name, handleOrUrl },
    })
    .returning({ id: newsSources.id });
  const row = rows[0];
  if (row === undefined) {
    throw new Error(`news_sources upsert for ${adapter.sourceKey} returned no row`);
  }
  return row.id;
}

/** Raw items not yet attached to any cluster, oldest first (received_at, then id). */
export async function loadUnclusteredItems(db: Db, limit: number): Promise<AttachItemInput[]> {
  const result = await db.$client.query<AttachRow>(
    `select r.id, r.source_id, r.headline, r.content_hash, r.received_at
       from raw_news_items r
      where not exists (select 1 from news_cluster_items ci where ci.item_id = r.id)
      order by r.received_at asc, r.id asc
      limit $1`,
    [limit],
  );
  return result.rows.map(toAttachInput);
}

/** Load attach inputs for specific raw item ids (process Lambda path). */
export async function loadItemsByIds(db: Db, ids: readonly string[]): Promise<AttachItemInput[]> {
  if (ids.length === 0) return [];
  const result = await db.$client.query<AttachRow>(
    `select r.id, r.source_id, r.headline, r.content_hash, r.received_at
       from raw_news_items r
      where r.id = any($1)`,
    [ids],
  );
  return result.rows.map(toAttachInput);
}

/** Parse an SQS message body as a RawItemV1 pointer; null = poison pill. */
export function parseRawItemRecord(body: string): RawItemV1 | null {
  try {
    const result = RawItemV1.safeParse(JSON.parse(body));
    return result.success ? result.data : null;
  } catch {
    return null;
  }
}

/** Human-readable source names for news_sources.name; falls back to the key. */
export function sourceDisplayName(sourceKey: string): string {
  return SOURCE_NAMES[sourceKey] ?? sourceKey;
}

const SOURCE_NAMES: Record<string, string> = {
  edgar_8k: 'SEC EDGAR 8-K filings',
  edgar_form4: 'SEC EDGAR Form 4 insider filings',
  edgar_13d: 'SEC EDGAR SC 13D filings',
  edgar_13g: 'SEC EDGAR SC 13G filings',
  massive_news: 'Massive (ex-Polygon) news API',
  globenewswire: 'GlobeNewswire public-company releases',
  coindesk: 'CoinDesk',
  cointelegraph: 'Cointelegraph',
  theblock: 'The Block',
};

// ---------------------------------------------------------------- internals --

type AttachRow = {
  id: string;
  source_id: string;
  headline: string;
  content_hash: string;
  received_at: Date;
};

type RawItemRow = AttachRow & {
  external_id: string;
  payload_ref: string;
  published_at: Date | null;
  symbols_hint: string[];
  meta: Record<string, unknown>;
};

async function loadCursor(db: Db, sourceId: string): Promise<string | null> {
  const result = await db.$client.query<{ cursor: string | null }>(
    'select cursor from ingest_watermarks where source_id = $1',
    [sourceId],
  );
  return result.rows[0]?.cursor ?? null;
}

async function loadRawItemRow(
  db: Db,
  sourceId: string,
  externalId: string,
): Promise<RawItemRow | undefined> {
  const result = await db.$client.query<RawItemRow>(
    `select id, source_id, headline, content_hash, received_at,
            external_id, payload_ref, published_at, symbols_hint, meta
       from raw_news_items
      where source_id = $1 and external_id = $2`,
    [sourceId, externalId],
  );
  return result.rows[0];
}

function rawItemV1FromRow(sourceKey: string, row: RawItemRow): RawItemV1 {
  return {
    v: 1,
    itemId: row.id,
    sourceKey,
    externalId: row.external_id,
    headline: row.headline,
    payloadRef: row.payload_ref,
    contentHash: row.content_hash,
    publishedAt: row.published_at === null ? null : row.published_at.toISOString(),
    receivedAt: row.received_at.toISOString(),
    symbolsHint: row.symbols_hint,
    meta: row.meta,
  };
}

function toAttachInput(row: AttachRow): AttachItemInput {
  return {
    id: row.id,
    sourceId: row.source_id,
    headline: row.headline,
    contentHash: row.content_hash,
    receivedAt: row.received_at,
  };
}

/** RSS adapters expose feedUrl; record it as news_sources.handle_or_url. */
function adapterHandleOrUrl(adapter: SourceAdapter): string | null {
  if ('feedUrl' in adapter) {
    const feedUrl = (adapter as SourceAdapter & { feedUrl?: unknown }).feedUrl;
    if (typeof feedUrl === 'string') return feedUrl;
  }
  return null;
}
