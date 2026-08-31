import { and, asc, eq, exists, gte, inArray, lte, notExists, sql } from 'drizzle-orm';

import type { Db } from '../client.js';
import {
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
 * The MACRO interpreter's work queue.
 *
 * The company queue selects (cluster × instrument) pairs. This one selects
 * clusters with **no** instrument pair at all — the class the company path
 * discards, which the roadmap notes is roughly 87% of everything clustered.
 * Those are not junk: a rate decision, an export control, or a grid failure
 * names no ticker and therefore never reaches the company interpreter, while
 * being exactly the news that moves a market through a mechanism.
 *
 * Candidate = one CLUSTER, not a pair. There is nothing to pair with, which is
 * the whole reason this path exists: the affected instruments are an OUTPUT of
 * interpretation here, produced deterministically by the fanout afterwards.
 *
 * The unlinked test uses the same MIN_LINK_CONFIDENCE gate as the company
 * queue, deliberately. A cluster whose only link sits below that threshold is
 * one the company path will never interpret, so treating it as linked here
 * would drop it from BOTH paths and lose it silently.
 */
export interface MacroCandidate {
  clusterId: string;
  anchorTs: Date;
  canonicalHeadline: string;
  clusterItemCount: number;
  clusterDistinctSourceCount: number;
}

export interface LoadMacroCandidatesOptions {
  /** Cluster first_received_at window, inclusive both ends. */
  from: Date;
  to: Date;
  promptVersion: string;
  modelId: string;
  batch: number;
  /** Poison-pill cap: clusters with this many failed attempts stop being retried. */
  maxAttempts: number;
  transport: LlmTransport;
  /** Restrict the queue to exactly these cluster ids — the experiment sampling hook. */
  clusterIds?: string[];
  /**
   * Restrict to clusters containing an item from these `news_sources.source_key`
   * values. The macro path was added for a specific source, and scoping the
   * queue is far cheaper than interpreting the whole unlinked backlog to
   * evaluate one feed.
   */
  sourceKeys?: string[];
}

/**
 * The macro `signal_key` prefix for the anti-join.
 *
 * A macro judgment can produce several rows — one per named sector, or one
 * `'macro'` row for a broad call — and `buildSignalKey` puts
 * `instrument_id ?? sector_code ?? 'macro'` in the middle slot. So there is no
 * single key to test for "already interpreted". What is stable is the
 * PREFIX: every row from one judgment starts `${clusterId}:`, and every row
 * ends `:${promptVersion}:${modelId}`. The anti-join therefore matches on
 * cluster id plus that suffix rather than on an exact key.
 *
 * This matters for a `market_scope: 'none'` judgment, which writes NO signal
 * row at all. Nothing in `llm_signals` would ever mark it done, so the sweep
 * would re-interpret it on every pass forever. `llm_attempts` is what closes
 * that: a `none` judgment records a terminal attempt row under the cluster's
 * own key, and the second anti-join below excludes it.
 */
function macroSignalSuffix(promptVersion: string, modelId: string, transport: LlmTransport): string {
  return `:${promptVersion}:${modelId}${transport === 'cli' ? ':cli' : ''}`;
}

/** The key a `none` judgment (and any failure) is booked against. */
export function macroAttemptKey(
  clusterId: string,
  promptVersion: string,
  modelId: string,
  transport: LlmTransport,
): string {
  return `${clusterId}:macro${macroSignalSuffix(promptVersion, modelId, transport)}`;
}

export async function loadMacroCandidates(
  db: Db,
  options: LoadMacroCandidatesOptions,
): Promise<MacroCandidate[]> {
  const suffix = macroSignalSuffix(options.promptVersion, options.modelId, options.transport);

  const rows = await db
    .selectDistinct({
      clusterId: newsClusters.id,
      anchorTs: newsClusters.firstReceivedAt,
      canonicalHeadline: newsClusters.canonicalHeadline,
      clusterItemCount: newsClusters.itemCount,
      clusterDistinctSourceCount: newsClusters.distinctSourceCount,
    })
    .from(newsClusters)
    .where(
      and(
        gte(newsClusters.firstReceivedAt, options.from),
        lte(newsClusters.firstReceivedAt, options.to),
        ...(options.clusterIds !== undefined
          ? [inArray(newsClusters.id, options.clusterIds)]
          : []),
        // Built with drizzle's exists()/inArray rather than raw SQL: a raw
        // `= any(${array})` in a sql template binds the array as a scalar and
        // Postgres rejects it with "op ANY/ALL (array) requires array on right
        // side" only at execution time.
        ...(options.sourceKeys !== undefined
          ? [
              exists(
                db
                  .select({ one: sql`1` })
                  .from(newsClusterItems)
                  .innerJoin(rawNewsItems, eq(rawNewsItems.id, newsClusterItems.itemId))
                  .innerJoin(newsSources, eq(newsSources.id, rawNewsItems.sourceId))
                  .where(
                    and(
                      eq(newsClusterItems.clusterId, newsClusters.id),
                      inArray(newsSources.sourceKey, options.sourceKeys),
                    ),
                  ),
              ),
            ]
          : []),
        // UNLINKED: no item in this cluster resolved to an instrument at or
        // above the confidence the company path requires.
        notExists(
          db
            .select({ one: sql`1` })
            .from(newsClusterItems)
            .innerJoin(
              itemInstrumentLinks,
              and(
                eq(itemInstrumentLinks.itemId, newsClusterItems.itemId),
                gte(itemInstrumentLinks.confidence, MIN_LINK_CONFIDENCE),
              ),
            )
            .where(eq(newsClusterItems.clusterId, newsClusters.id)),
        ),
        // Not already interpreted under this exact contract. Prefix match,
        // because one judgment can write several rows — see macroSignalSuffix.
        notExists(
          db
            .select({ one: sql`1` })
            .from(llmSignals)
            .where(
              and(
                eq(llmSignals.clusterId, newsClusters.id),
                sql`${llmSignals.signalKey} like ${'%' + suffix}`,
              ),
            ),
        ),
        // Terminal or exhausted attempts. Also how a `market_scope: 'none'`
        // judgment stops being re-asked: it writes no signal row, so this is
        // the only record that it was ever answered.
        notExists(
          db
            .select({ one: sql`1` })
            .from(llmAttempts)
            .where(
              and(
                sql`${llmAttempts.signalKey} = ${newsClusters.id} || ${'macro' + suffix}`,
                gte(llmAttempts.attempts, options.maxAttempts),
              ),
            ),
        ),
      ),
    )
    .orderBy(asc(newsClusters.firstReceivedAt), asc(newsClusters.id))
    .limit(options.batch);

  return rows;
}

/**
 * The point-in-time universe for sector fanout, as of `asOf`.
 *
 * Membership is read from the point-in-time table rather than from
 * `instruments` alone, because invariant 5 makes "current S&P 500" a bug: a
 * sector basket built from today's members would quietly exclude every company
 * that left the index, which is precisely the set that did badly.
 */
export async function loadSectorUniverseAsOf(
  db: Db,
  asOf: Date,
): Promise<Array<{ instrumentId: string; symbol: string; sectorApprox: string | null }>> {
  const result = await db.$client.query<{
    instrument_id: string;
    symbol: string;
    sector_approx: string | null;
  }>(
    `select distinct i.id as instrument_id, i.symbol, i.sector_approx
       from index_membership m
       join instruments i on i.id = m.instrument_id
      where m.valid_from <= $1
        and (m.valid_to is null or m.valid_to > $1)
      order by i.symbol`,
    [asOf],
  );
  return result.rows.map((row) => ({
    instrumentId: row.instrument_id,
    symbol: row.symbol,
    sectorApprox: row.sector_approx,
  }));
}
