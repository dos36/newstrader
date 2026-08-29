import { and, asc, eq, gte, inArray, lte, notExists, sql, type SQL } from 'drizzle-orm';

import type { Db } from '../client.js';
import {
  instruments,
  itemInstrumentLinks,
  llmAttempts,
  llmSignals,
  newsClusterItems,
  newsClusters,
  newsSources,
  rawNewsItems,
} from '../schema.js';
import { MIN_LINK_CONFIDENCE, type LlmTransport } from '../shared-constants.js';

/**
 * The interpreter's work queue and bookkeeping.
 *
 * Candidate = one (cluster × instrument) pair — the roadmap's measured unit
 * (~179/day) — selected by the same three-table join the measurer and bars
 * backfill already use, gated at MIN_LINK_CONFIDENCE (0.75: deliberately
 * excludes nameAlias 0.7, the measured ~40%-false-positive channel).
 *
 * "Not yet interpreted" is an anti-join on llm_signals.signal_key built with
 * the SAME concatenation persistSignal uses — the SQL expression below MUST
 * stay in lockstep with buildSignalKey (signals-repo.ts); the integration test
 * pins that by round-tripping a real persistSignal row through the query.
 */
export interface InterpretationCandidate {
  clusterId: string;
  anchorTs: Date;
  canonicalHeadline: string;
  clusterItemCount: number;
  clusterDistinctSourceCount: number;
  instrumentId: string;
  symbol: string;
  name: string;
  assetClass: 'us_equity' | 'crypto';
  sectorApprox: string | null;
  exchange: string | null;
}

export interface LoadCandidatesOptions {
  /** Cluster first_received_at window, inclusive both ends. */
  from: Date;
  to: Date;
  promptVersion: string;
  modelId: string;
  batch: number;
  /** Poison-pill cap: pairs with this many failed attempts stop being retried. */
  maxAttempts: number;
  /**
   * Which transport will do the interpreting. It is part of the key, so a
   * pair already done over 'api' is STILL a candidate for 'cli' and vice
   * versa — deliberate: the two are not interchangeable rows.
   */
  transport: LlmTransport;
  /**
   * Restrict the queue to exactly these `${clusterId}:${instrumentId}` pairs —
   * the sampling hook for prompt experiments (a stratified sample re-run under
   * a new prompt version). Every other predicate (window, anti-join, attempts
   * cap) still applies, so re-running a pairs file is idempotent per version.
   */
  pairKeys?: string[];
}

/** The `${clusterId}:${instrumentId}` expression pairKeys filters on. */
function pairKeyExpr(): SQL<string> {
  return sql<string>`${newsClusters.id} || ':' || ${instruments.id}`;
}

function signalKeyExpr(promptVersion: string, modelId: string, transport: LlmTransport) {
  // Company scope: `${clusterId}:${instrumentId}:${promptVersion}:${modelId}`,
  // plus ':cli' for the dev transport — MUST match buildSignalKey exactly
  // (signals-repo.ts); the integration test round-trips a real row to pin it.
  const suffix = transport === 'cli' ? ':cli' : '';
  return sql`${newsClusters.id} || ':' || ${instruments.id} || ':' || ${promptVersion} || ':' || ${modelId} || ${suffix}`;
}

export async function loadInterpretationCandidates(
  db: Db,
  options: LoadCandidatesOptions,
): Promise<InterpretationCandidate[]> {
  const keyExpr = signalKeyExpr(options.promptVersion, options.modelId, options.transport);

  const rows = await db
    .selectDistinct({
      clusterId: newsClusters.id,
      anchorTs: newsClusters.firstReceivedAt,
      canonicalHeadline: newsClusters.canonicalHeadline,
      clusterItemCount: newsClusters.itemCount,
      clusterDistinctSourceCount: newsClusters.distinctSourceCount,
      instrumentId: instruments.id,
      symbol: instruments.symbol,
      name: instruments.name,
      assetClass: instruments.assetClass,
      sectorApprox: instruments.sectorApprox,
      exchange: instruments.exchange,
    })
    .from(newsClusters)
    .innerJoin(newsClusterItems, eq(newsClusterItems.clusterId, newsClusters.id))
    .innerJoin(
      itemInstrumentLinks,
      and(
        eq(itemInstrumentLinks.itemId, newsClusterItems.itemId),
        gte(itemInstrumentLinks.confidence, MIN_LINK_CONFIDENCE),
      ),
    )
    .innerJoin(instruments, eq(instruments.id, itemInstrumentLinks.instrumentId))
    .where(
      and(
        gte(newsClusters.firstReceivedAt, options.from),
        lte(newsClusters.firstReceivedAt, options.to),
        ...(options.pairKeys !== undefined ? [inArray(pairKeyExpr(), options.pairKeys)] : []),
        notExists(
          db
            .select({ one: sql`1` })
            .from(llmSignals)
            .where(eq(llmSignals.signalKey, keyExpr)),
        ),
        notExists(
          db
            .select({ one: sql`1` })
            .from(llmAttempts)
            .where(
              and(
                eq(llmAttempts.signalKey, keyExpr),
                gte(llmAttempts.attempts, options.maxAttempts),
              ),
            ),
        ),
      ),
    )
    .orderBy(asc(newsClusters.firstReceivedAt), asc(newsClusters.id), asc(instruments.id))
    .limit(options.batch);

  return rows;
}

/** One cluster item with everything the prompt needs (earliest-first). */
export interface PromptItemRow {
  itemId: string;
  sourceKey: string;
  sourceKind: string;
  headline: string;
  /** NOT NULL by schema — every ingested item has a stored payload. */
  payloadRef: string;
  meta: Record<string, unknown>;
  lagFromFirstMs: number;
}

/**
 * Cluster items the interpreter may show, earliest first.
 *
 * maxLagMs is the point-in-time bound: only items that had ALREADY joined the
 * cluster by `anchor + maxLagMs` are eligible. Without it a backfill shows the
 * model follow-up coverage that arrived hours after the story — look-ahead in
 * the prompt itself. Clusters accrete for hours, so this is not a rare edge.
 */
export async function loadClusterItemsForPrompt(
  db: Db,
  clusterId: string,
  limit: number,
  maxLagMs: number,
): Promise<PromptItemRow[]> {
  const rows = await db
    .select({
      itemId: newsClusterItems.itemId,
      sourceKey: newsSources.sourceKey,
      sourceKind: newsSources.kind,
      headline: rawNewsItems.headline,
      payloadRef: rawNewsItems.payloadRef,
      meta: rawNewsItems.meta,
      lagFromFirstMs: newsClusterItems.lagFromFirstMs,
    })
    .from(newsClusterItems)
    .innerJoin(rawNewsItems, eq(rawNewsItems.id, newsClusterItems.itemId))
    .innerJoin(newsSources, eq(newsSources.id, rawNewsItems.sourceId))
    .where(
      and(
        eq(newsClusterItems.clusterId, clusterId),
        lte(newsClusterItems.lagFromFirstMs, maxLagMs),
      ),
    )
    .orderBy(asc(newsClusterItems.lagFromFirstMs), asc(rawNewsItems.id))
    .limit(limit);
  return rows;
}

/**
 * Popularity as of `anchor + maxLagMs`, NOT the cluster's final totals.
 *
 * news_clusters.item_count / distinct_source_count are live counters that keep
 * climbing after the anchor. The prompt tells the model that more sources and
 * faster pickup means a bigger story, so handing it final totals for an old
 * cluster leaks how big the story turned out. Counted from the same rows
 * loadClusterItemsForPrompt filters on, so the prompt's counts and its listed
 * items always agree.
 */
export async function countClusterItemsAsOf(
  db: Db,
  clusterId: string,
  maxLagMs: number,
): Promise<{ itemCount: number; distinctSourceCount: number }> {
  const rows = await db
    .select({
      itemCount: sql<string>`count(*)`,
      distinctSourceCount: sql<string>`count(distinct ${rawNewsItems.sourceId})`,
    })
    .from(newsClusterItems)
    .innerJoin(rawNewsItems, eq(rawNewsItems.id, newsClusterItems.itemId))
    .where(
      and(
        eq(newsClusterItems.clusterId, clusterId),
        lte(newsClusterItems.lagFromFirstMs, maxLagMs),
      ),
    );
  const row = rows[0];
  return {
    itemCount: Number(row?.itemCount ?? 0),
    distinctSourceCount: Number(row?.distinctSourceCount ?? 0),
  };
}

/**
 * How many candidates are still queued under the same predicate, ignoring the
 * batch limit — "items left to process" for a backfill.
 *
 * Deliberately a SEPARATE query the caller opts into: it is a full count over
 * the window with no LIMIT, so the deployed 5-minute sweep should not pay for
 * it on every tick just to log a number nobody reads.
 */
export async function countInterpretationCandidates(
  db: Db,
  options: Omit<LoadCandidatesOptions, 'batch'>,
): Promise<number> {
  const keyExpr = signalKeyExpr(options.promptVersion, options.modelId, options.transport);
  const rows = await db.select({ total: sql<string>`count(*)` }).from(
    db
      .selectDistinct({ clusterId: newsClusters.id, instrumentId: instruments.id })
      .from(newsClusters)
      .innerJoin(newsClusterItems, eq(newsClusterItems.clusterId, newsClusters.id))
      .innerJoin(
        itemInstrumentLinks,
        and(
          eq(itemInstrumentLinks.itemId, newsClusterItems.itemId),
          gte(itemInstrumentLinks.confidence, MIN_LINK_CONFIDENCE),
        ),
      )
      .innerJoin(instruments, eq(instruments.id, itemInstrumentLinks.instrumentId))
      .where(
        and(
          gte(newsClusters.firstReceivedAt, options.from),
          lte(newsClusters.firstReceivedAt, options.to),
          ...(options.pairKeys !== undefined ? [inArray(pairKeyExpr(), options.pairKeys)] : []),
          notExists(
            db
              .select({ one: sql`1` })
              .from(llmSignals)
              .where(eq(llmSignals.signalKey, keyExpr)),
          ),
          notExists(
            db
              .select({ one: sql`1` })
              .from(llmAttempts)
              .where(
                and(
                  eq(llmAttempts.signalKey, keyExpr),
                  gte(llmAttempts.attempts, options.maxAttempts),
                ),
              ),
          ),
        ),
      )
      .as('queued'),
  );
  return Number(rows[0]?.total ?? 0);
}

/** SUM(cost_usd) over signals analyzed at-or-after `since` (spend breaker input). */
export async function sumLlmSpendSince(db: Db, since: Date): Promise<number> {
  const rows = await db
    .select({ total: sql<string | null>`sum(${llmSignals.costUsd})` })
    .from(llmSignals)
    .where(gte(llmSignals.analyzedAt, since));
  const total = rows[0]?.total;
  return total === null || total === undefined ? 0 : Number(total);
}

/**
 * Record a content-level failure (poison pill) — attempts += 1, latest error
 * and audit ref win. This is one of the schema's documented mutable
 * exceptions; transport errors must NOT be recorded here (they are not the
 * candidate's fault and the cap would starve healthy pairs during an outage).
 */
export async function recordAttemptFailure(
  db: Db,
  input: { signalKey: string; error: string; auditRef: string | null; at: Date },
): Promise<void> {
  await db
    .insert(llmAttempts)
    .values({
      signalKey: input.signalKey,
      attempts: 1,
      lastError: input.error,
      auditRef: input.auditRef,
      lastAttemptAt: input.at,
    })
    .onConflictDoUpdate({
      target: llmAttempts.signalKey,
      set: {
        attempts: sql`${llmAttempts.attempts} + 1`,
        lastError: input.error,
        auditRef: input.auditRef,
        lastAttemptAt: input.at,
      },
    });
}

/** Midnight UTC of `now`'s day — the spend breaker's window start. */
export function utcDayStart(now: Date): Date {
  return new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate()));
}
