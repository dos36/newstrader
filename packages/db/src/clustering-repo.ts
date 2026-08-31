import { newId, normalizeText } from '@newstrader/core';
import { and, desc, eq, gte, lt, ne, sql } from 'drizzle-orm';
import type { SQLWrapper } from 'drizzle-orm';
import type { Db } from './client.js';
import { newsClusterItems, newsClusters, rawNewsItems } from './schema.js';

/**
 * Clustering attach — architecture doc §5.1.
 *
 * Deterministic, no embeddings, no extra API:
 *   1. exact content_hash match → attach (similarity 1.0)
 *   2. best open cluster in a 48h window by pg_trgm similarity over
 *      normalized headlines, above threshold → attach
 *   3. otherwise mint a new cluster anchored on this item
 *
 * CIK guard (steps 1 and 2): an item carrying meta->>'cik' never attaches to a
 * cluster that already holds a DIFFERENT cik. Templated EDGAR headlines
 * ("8-K - COMPANY (Filer)") score above the trigram threshold across unrelated
 * companies — measured 2,269 mixed-CIK clusters (9.4% of EDGAR clusters)
 * before this guard. Items without a cik keep the pre-guard behavior.
 *
 * Every path runs in ONE transaction under a global advisory lock so two
 * concurrent Lambdas processing echoes of the same story cannot mint duplicate
 * clusters (that would silently corrupt popularity and scoop stats).
 */

/**
 * Minimum pg_trgm similarity(normalized_headline, item headline) for a
 * candidate cluster to win. TUNABLE: the architecture suggests ~0.7 for
 * headline+lede trigram; M0 clusters on headline only, where wire echoes score
 * lower, so we start at 0.5 and let the milestone-0 hand-check of ~50 clusters
 * calibrate it.
 */
export const HEADLINE_SIMILARITY_THRESHOLD = 0.5;

/** Candidate clusters must have started within this many hours of the item's received_at. */
export const CANDIDATE_WINDOW_HOURS = 48;

export interface AttachItemInput {
  id: string;
  sourceId: string;
  headline: string;
  contentHash: string;
  /** Our clock (raw_news_items.received_at) — never the source's published_at. */
  receivedAt: Date;
}

export interface AttachResult {
  clusterId: string;
  /** True when this call minted a new cluster for the item. */
  isNew: boolean;
  /** 1.0 for exact/new; the pg_trgm score for near-dup attaches. */
  similarity: number;
}

type Tx = Parameters<Parameters<Db['transaction']>[0]>[0];

/**
 * Attach one persisted raw item to its story cluster (creating the cluster if
 * the story is novel). Idempotent: redelivering an already-attached item
 * returns the existing membership without touching counters.
 */
export async function attachItemToCluster(db: Db, item: AttachItemInput): Promise<AttachResult> {
  return db.transaction(async (tx) => {
    // M0 choice: ONE global advisory lock serializes every attach. At hundreds
    // of items/day contention is irrelevant, and correctness is trivial to
    // reason about. Instrument-blocked locks (per candidate block) arrive with
    // entity resolution in M1, when "clusters sharing a resolved instrument"
    // becomes a computable lock key.
    await tx.execute(sql`select pg_advisory_xact_lock(hashtext('newstrader_clustering'))`);

    // Idempotent redelivery: if the item is already a member, return that
    // membership unchanged (SQS Standard is at-least-once; see architecture §4.2).
    const existing = await tx
      .select({ clusterId: newsClusterItems.clusterId, similarity: newsClusterItems.similarity })
      .from(newsClusterItems)
      .where(eq(newsClusterItems.itemId, item.id))
      .limit(1);
    const existingRow = existing[0];
    if (existingRow) {
      return { clusterId: existingRow.clusterId, isNew: false, similarity: existingRow.similarity };
    }

    // CIK guard input: read the item's own cik from its persisted row (the FK
    // on news_cluster_items guarantees the row exists). Reading it here instead
    // of widening AttachItemInput keeps every caller — Lambda, CLI, tests — on
    // the same source of truth.
    const itemCikRows = await tx
      .select({ cik: sql<string | null>`${rawNewsItems.meta} ->> 'cik'` })
      .from(rawNewsItems)
      .where(eq(rawNewsItems.id, item.id))
      .limit(1);
    const itemCik = itemCikRows[0]?.cik ?? null;

    // True when the cluster holds no item whose cik differs from this item's.
    // Aliased subquery: step 1's outer query already joins raw_news_items /
    // news_cluster_items, so bare table refs would collide. Cik-less items in
    // the cluster never block, and a cik-less incoming item passes vacuously.
    const cikGuard = (clusterIdCol: SQLWrapper) =>
      itemCik === null
        ? sql`true`
        : sql`not exists (
            select 1
              from news_cluster_items guard_ci
              join raw_news_items guard_ri on guard_ri.id = guard_ci.item_id
             where guard_ci.cluster_id = ${clusterIdCol}
               and guard_ri.meta ->> 'cik' is not null
               and guard_ri.meta ->> 'cik' <> ${itemCik}
          )`;

    // Step 1: exact dup — another raw item with the same content_hash is
    // already clustered → same story, similarity 1.0.
    const exact = await tx
      .select({
        clusterId: newsClusterItems.clusterId,
        firstReceivedAt: newsClusters.firstReceivedAt,
      })
      .from(rawNewsItems)
      .innerJoin(newsClusterItems, eq(newsClusterItems.itemId, rawNewsItems.id))
      .innerJoin(newsClusters, eq(newsClusters.id, newsClusterItems.clusterId))
      .where(
        and(
          eq(rawNewsItems.contentHash, item.contentHash),
          ne(rawNewsItems.id, item.id),
          cikGuard(newsClusterItems.clusterId),
        ),
      )
      .limit(1);
    const exactRow = exact[0];
    if (exactRow) {
      return attachToExisting(tx, exactRow.clusterId, exactRow.firstReceivedAt, item, 1);
    }

    // Step 2: near dup — best open cluster whose story started inside the 48h
    // window, scored by pg_trgm over normalized headlines. The `%` operator is
    // what makes the GIN index from the pg_trgm migration usable (bare
    // similarity() calls always sequential-scan); SET LOCAL scopes the operator
    // threshold to this transaction, and the explicit similarity() filter stays
    // as the exact gate. normalizeText matches what contentHash sees.
    const normalizedHeadline = normalizeText(item.headline);
    const windowStart = new Date(
      item.receivedAt.getTime() - CANDIDATE_WINDOW_HOURS * 60 * 60 * 1000,
    );
    await tx.execute(
      sql.raw(`set local pg_trgm.similarity_threshold = ${HEADLINE_SIMILARITY_THRESHOLD}`),
    );
    const simExpr = sql<number>`similarity(${newsClusters.normalizedHeadline}, ${normalizedHeadline})`;
    const candidates = await tx
      .select({
        id: newsClusters.id,
        firstReceivedAt: newsClusters.firstReceivedAt,
        similarity: simExpr,
      })
      .from(newsClusters)
      .where(
        and(
          eq(newsClusters.status, 'open'),
          gte(newsClusters.firstReceivedAt, windowStart),
          sql`${newsClusters.normalizedHeadline} % ${normalizedHeadline}`,
          gte(simExpr, HEADLINE_SIMILARITY_THRESHOLD),
          cikGuard(newsClusters.id),
        ),
      )
      .orderBy(desc(simExpr))
      .limit(1);
    const best = candidates[0];
    if (best) {
      return attachToExisting(tx, best.id, best.firstReceivedAt, item, best.similarity);
    }

    // Step 3: novel story — mint a new cluster anchored on this item.
    // first_received_at is the anchor for ALL reaction measurements.
    const clusterId = newId();
    await tx.insert(newsClusters).values({
      id: clusterId,
      canonicalHeadline: item.headline,
      normalizedHeadline,
      firstItemId: item.id,
      firstSourceId: item.sourceId,
      firstReceivedAt: item.receivedAt,
      lastItemAt: item.receivedAt,
      // item_count / distinct_source_count default to 1 — they already count this item.
    });
    await tx.insert(newsClusterItems).values({
      clusterId,
      itemId: item.id,
      similarity: 1,
      lagFromFirstMs: 0,
    });
    return { clusterId, isNew: true, similarity: 1 };
  });
}

/** Insert the membership row and bump the cluster's denormalized counters. */
async function attachToExisting(
  tx: Tx,
  clusterId: string,
  firstReceivedAt: Date,
  item: AttachItemInput,
  similarity: number,
): Promise<AttachResult> {
  const inserted = await tx
    .insert(newsClusterItems)
    .values({
      clusterId,
      itemId: item.id,
      similarity,
      lagFromFirstMs: item.receivedAt.getTime() - firstReceivedAt.getTime(),
    })
    .onConflictDoNothing({ target: newsClusterItems.itemId })
    .returning({ clusterId: newsClusterItems.clusterId });

  // Conflict = this item was attached by someone else. Unreachable while the
  // global advisory lock serializes attaches (the early membership check covers
  // redelivery), but kept so idempotency survives a future move to finer locks:
  // return the existing membership and leave counters alone.
  if (inserted.length === 0) {
    const membership = await tx
      .select({ clusterId: newsClusterItems.clusterId, similarity: newsClusterItems.similarity })
      .from(newsClusterItems)
      .where(eq(newsClusterItems.itemId, item.id))
      .limit(1);
    const row = membership[0];
    if (!row) {
      throw new Error(
        `news_cluster_items insert conflicted for item ${item.id} but no membership row exists`,
      );
    }
    return { clusterId: row.clusterId, isNew: false, similarity: row.similarity };
  }

  // Denormalized popularity counters — the one documented UPDATE exception to
  // append-only facts. distinct_source_count is recomputed from memberships
  // (not incremented) so a source echoing twice cannot inflate it; GREATEST
  // keeps last_item_at monotone under out-of-order arrival.
  await tx
    .update(newsClusters)
    .set({
      itemCount: sql`${newsClusters.itemCount} + 1`,
      lastItemAt: sql`greatest(${newsClusters.lastItemAt}, ${item.receivedAt})`,
      distinctSourceCount: sql`(
        select count(distinct ${rawNewsItems.sourceId})
        from ${newsClusterItems}
        join ${rawNewsItems} on ${rawNewsItems.id} = ${newsClusterItems.itemId}
        where ${newsClusterItems.clusterId} = ${clusterId}
      )`,
    })
    .where(eq(newsClusters.id, clusterId));

  return { clusterId, isNew: false, similarity };
}

/**
 * Close clusters that have been silent for `olderThanHours` (architecture:
 * "close after 48h silence"). Closed clusters stop being step-2 candidates.
 * Returns the number of clusters closed. `now` is injectable for tests.
 */
export async function closeStaleClusters(
  db: Db,
  olderThanHours = 48,
  now: Date = new Date(),
): Promise<number> {
  const cutoff = new Date(now.getTime() - olderThanHours * 60 * 60 * 1000);
  const closed = await db
    .update(newsClusters)
    .set({ status: 'closed' })
    .where(and(eq(newsClusters.status, 'open'), lt(newsClusters.lastItemAt, cutoff)))
    .returning({ id: newsClusters.id });
  return closed.length;
}
