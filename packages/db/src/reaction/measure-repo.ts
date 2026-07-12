import { and, asc, eq, gte, inArray, lte, or } from 'drizzle-orm';

import { BENCHMARK_SYMBOLS } from '../bars/benchmarks.js';
import type { Db } from '../client.js';
import {
  REACTION_HORIZONS,
  instruments,
  itemInstrumentLinks,
  newsClusterItems,
  newsClusters,
  priceBars1d,
  priceBars1m,
  reactionMeasurements,
  reactionSummary,
  recoveryMeasurements,
} from '../schema.js';
import { MIN_LINK_CONFIDENCE } from '../shared-constants.js';
import {
  DEFAULT_RECOVERY_WINDOW_DAYS,
  HORIZON_FALLBACK_CAP_MS,
  HORIZON_MINUTES,
  RECOVERY_TRIGGER_BPS,
  beta,
  cumulativeAbnormalSeries,
  reactionLadder,
  recovery,
  settledBarAt,
  summarize,
  type CloseBar,
} from './math.js';

/**
 * Reaction/recovery measurement batch job — architecture §5.6.
 *
 * Anchored on cluster.first_received_at (OUR clock), never published_at.
 * All three derived tables are written INSERT … ON CONFLICT DO NOTHING under
 * MEASURER_VERSION: rows are never overwritten in place — a methodology change
 * ships as a NEW measurer_version and recomputes alongside the old rows, so
 * historic measurements stay comparable. Re-running the job over the same
 * window is therefore a no-op for already-written rows, while horizons that
 * only became measurable since the last run (e.g. 1d after the next session
 * opens) are filled in per-horizon by the reaction_measurements PK.
 *
 * No advisory lock: concurrent runs compute identical rows and race benignly
 * into conflict-do-nothing.
 */

export const MEASURER_VERSION = 'm1';

// MIN_LINK_CONFIDENCE and BENCHMARK_SYMBOLS live in ../shared-constants.js and
// ../bars/benchmarks.js respectively: both are also needed by
// bars/bars-repo.ts's backfillEventWindows, and reaction/ may import bars/
// (benchmarks.ts is a leaf module with no back-imports) but bars/ must never
// import reaction/, so anything both layers need is defined outside either.

const MINUTE_MS = 60_000;
const HOUR_MS = 3_600_000;
const DAY_MS = 86_400_000;

/**
 * Minute-bar load window around the anchor: 72h before … 5d + settle buffer
 * after. The pre-window must reach the PRIOR session's close for off-hours
 * anchors (late-Friday filings, weekend crypto news — the majority class of
 * EDGAR anchors observed live): with only 1h of pre-anchor bars the anchor
 * price never exists and such pairs stayed skippedNoBars forever. 72h covers
 * a long weekend; settledBarAt's later-bar proof keeps the stale anchor
 * honest (must match bars/windows.ts EVENT_WINDOW_BEFORE_MS).
 */
const MINUTE_WINDOW_BEFORE_MS = 72 * HOUR_MS;
/**
 * 5d horizon + 3d buffer: a stale horizon price is only accepted once a LATER
 * bar proves the gap was non-trading (see math.ts), and a 5d horizon landing
 * on a weekend needs up to ~3 days of room for that proof bar.
 */
const MINUTE_WINDOW_AFTER_MS = HORIZON_MINUTES['5d'] * MINUTE_MS + 3 * DAY_MS;

/** Daily-bar lookback before the anchor for beta estimation. */
const BETA_LOOKBACK_DAYS = 90;

export interface MeasureReactionsOptions {
  /** Measure clusters whose first_received_at falls within the last N hours. */
  sinceHours: number;
  /** Injectable clock (tests). */
  now?: Date;
}

export interface MeasureReactionsTotals {
  /** Clusters whose anchor falls inside the window (with or without links). */
  clusters: number;
  /** Distinct (cluster, instrument) pairs with a qualifying link. */
  pairs: number;
  /** Pairs that produced at least one measurable horizon this run. */
  measured: number;
  /** Pairs skipped because no horizon was measurable (missing/unsettled bars). */
  skippedNoBars: number;
  /** reaction_measurements rows actually inserted (0 on a pure re-run). */
  horizonsWritten: number;
}

/**
 * Measure reactions for every (cluster in window, linked instrument) pair:
 * load minute bars around the anchor, benchmark bars, daily bars for beta,
 * then write the horizon ladder, the one-day summary (once the 1d horizon is
 * measurable), and — for negative events (1d abnormal ≤ RECOVERY_TRIGGER_BPS)
 * — the recovery metrics over up to DEFAULT_RECOVERY_WINDOW_DAYS, clamped to
 * available data. Pairs with no usable bars are skipped quietly but counted.
 */
export async function measureReactions(
  db: Db,
  options: MeasureReactionsOptions,
): Promise<MeasureReactionsTotals> {
  const now = options.now ?? new Date();
  const since = new Date(now.getTime() - options.sinceHours * HOUR_MS);

  const clusterRows = await db
    .select({ id: newsClusters.id, firstReceivedAt: newsClusters.firstReceivedAt })
    .from(newsClusters)
    .where(and(gte(newsClusters.firstReceivedAt, since), lte(newsClusters.firstReceivedAt, now)));

  const totals: MeasureReactionsTotals = {
    clusters: clusterRows.length,
    pairs: 0,
    measured: 0,
    skippedNoBars: 0,
    horizonsWritten: 0,
  };
  if (clusterRows.length === 0) {
    logTotals(totals);
    return totals;
  }
  const anchorByCluster = new Map(clusterRows.map((row) => [row.id, row.firstReceivedAt]));

  const pairRows = await db
    .selectDistinct({
      clusterId: newsClusterItems.clusterId,
      instrumentId: itemInstrumentLinks.instrumentId,
      assetClass: instruments.assetClass,
    })
    .from(newsClusterItems)
    .innerJoin(itemInstrumentLinks, eq(itemInstrumentLinks.itemId, newsClusterItems.itemId))
    .innerJoin(instruments, eq(instruments.id, itemInstrumentLinks.instrumentId))
    .where(
      and(
        inArray(newsClusterItems.clusterId, [...anchorByCluster.keys()]),
        gte(itemInstrumentLinks.confidence, MIN_LINK_CONFIDENCE),
      ),
    );
  totals.pairs = pairRows.length;

  const benchmarkRows = await db
    .select({ id: instruments.id, symbol: instruments.symbol, assetClass: instruments.assetClass })
    .from(instruments)
    .where(
      or(
        and(
          eq(instruments.symbol, BENCHMARK_SYMBOLS.us_equity),
          eq(instruments.assetClass, 'us_equity'),
        ),
        and(eq(instruments.symbol, BENCHMARK_SYMBOLS.crypto), eq(instruments.assetClass, 'crypto')),
      ),
    );
  const benchmarkByClass = new Map(benchmarkRows.map((row) => [row.assetClass, row]));

  // Per-run caches: instruments recur across clusters and every pair in a
  // cluster shares its benchmark bars.
  const minuteCache = new Map<string, { bars: CloseBar[]; sources: string[] }>();
  const dailyCache = new Map<string, CloseBar[]>();

  const loadMinuteBars = async (
    instrumentId: string,
    anchor: Date,
  ): Promise<{ bars: CloseBar[]; sources: string[] }> => {
    const key = `${instrumentId}:${anchor.getTime()}`;
    const cached = minuteCache.get(key);
    if (cached !== undefined) return cached;
    const rows = await db
      .select({ ts: priceBars1m.ts, close: priceBars1m.close, source: priceBars1m.source })
      .from(priceBars1m)
      .where(
        and(
          eq(priceBars1m.instrumentId, instrumentId),
          gte(priceBars1m.ts, new Date(anchor.getTime() - MINUTE_WINDOW_BEFORE_MS)),
          lte(priceBars1m.ts, new Date(anchor.getTime() + MINUTE_WINDOW_AFTER_MS)),
        ),
      )
      .orderBy(asc(priceBars1m.ts));
    const loaded = {
      bars: rows.map((row) => ({ ts: row.ts, close: row.close })),
      sources: [...new Set(rows.map((row) => row.source))].sort(),
    };
    minuteCache.set(key, loaded);
    return loaded;
  };

  const loadDailyBars = async (instrumentId: string, anchor: Date): Promise<CloseBar[]> => {
    const key = `${instrumentId}:${anchor.getTime()}`;
    const cached = dailyCache.get(key);
    if (cached !== undefined) return cached;
    const rows = await db
      .select({ ts: priceBars1d.ts, close: priceBars1d.close })
      .from(priceBars1d)
      .where(
        and(
          eq(priceBars1d.instrumentId, instrumentId),
          gte(priceBars1d.ts, new Date(anchor.getTime() - BETA_LOOKBACK_DAYS * DAY_MS)),
          lte(priceBars1d.ts, new Date(anchor.getTime() + DEFAULT_RECOVERY_WINDOW_DAYS * DAY_MS)),
        ),
      )
      .orderBy(asc(priceBars1d.ts));
    dailyCache.set(key, rows);
    return rows;
  };

  for (const pair of pairRows) {
    const anchor = anchorByCluster.get(pair.clusterId);
    if (anchor === undefined) continue; // unreachable: pairs derive from clusterRows

    const benchmarkRow = benchmarkByClass.get(pair.assetClass);
    // The benchmark measured against itself (BTC) is raw-only by construction.
    const benchmark =
      benchmarkRow !== undefined && benchmarkRow.id !== pair.instrumentId
        ? benchmarkRow
        : undefined;

    const { bars, sources } = await loadMinuteBars(pair.instrumentId, anchor);
    const benchBars =
      benchmark !== undefined ? (await loadMinuteBars(benchmark.id, anchor)).bars : [];
    const dailies = await loadDailyBars(pair.instrumentId, anchor);
    const benchDailies = benchmark !== undefined ? await loadDailyBars(benchmark.id, anchor) : [];

    // Daily bars are stamped at UTC midnight of their trading day, so the
    // anchor day's OWN close (e.g. anchor 14:00 UTC, bar ts 00:00 UTC same
    // day) passes a `bar.ts < anchor` filter — but that close prints AFTER
    // the anchor and contains the event's own move, a look-ahead leak into
    // beta. Only bars strictly before the anchor's calendar day qualify.
    const anchorDayStartMs = startOfUtcDay(anchor).getTime();
    const preAnchorDailies = dailies.filter((bar) => bar.ts.getTime() < anchorDayStartMs);
    const betaValue =
      benchmark !== undefined
        ? beta(
            preAnchorDailies,
            benchDailies.filter((bar) => bar.ts.getTime() < anchorDayStartMs),
          )
        : null;

    const ladder = reactionLadder(anchor, bars, benchBars, betaValue, REACTION_HORIZONS);
    if (ladder.length === 0) {
      totals.skippedNoBars += 1;
      continue;
    }
    totals.measured += 1;
    const barsSource = sources.length > 0 ? sources.join(',') : 'unknown';

    const insertedHorizons = await db
      .insert(reactionMeasurements)
      .values(
        ladder.map((row) => ({
          clusterId: pair.clusterId,
          instrumentId: pair.instrumentId,
          horizon: row.horizon,
          measurerVersion: MEASURER_VERSION,
          anchorTs: anchor,
          rawReturnBps: row.rawReturnBps,
          abnormalReturnBps: row.abnormalReturnBps,
          benchmark: row.betaUsed !== null && benchmark !== undefined ? benchmark.symbol : null,
          betaUsed: row.betaUsed,
          barsSource,
        })),
      )
      .onConflictDoNothing()
      .returning({ horizon: reactionMeasurements.horizon });
    totals.horizonsWritten += insertedHorizons.length;

    // Summary and recovery both key off the 1d horizon; writing them before 1d
    // is measurable would freeze a partial-day answer under conflict-do-nothing.
    const oneDayRow = ladder.find((row) => row.horizon === '1d');
    if (oneDayRow === undefined) continue;

    const summaryResult = summarize(
      anchor,
      cumulativeAbnormalSeries(anchor, bars, benchBars, betaValue, {
        untilTs: new Date(anchor.getTime() + HORIZON_MINUTES['1d'] * MINUTE_MS),
        // Same "queue for open" fallback as the ladder's 1d/3d/5d horizons
        // (math.ts): without it, an off-hours anchor with no trading before
        // the nominal 1d mark would produce an EMPTY series here even though
        // the ladder now has a 1d row (via its own fallback) — no summary
        // for the dominant live class of events (off-hours filings).
        fallForwardCapMs: HORIZON_FALLBACK_CAP_MS,
      }),
    );
    if (summaryResult !== null) {
      await db
        .insert(reactionSummary)
        .values({
          clusterId: pair.clusterId,
          instrumentId: pair.instrumentId,
          measurerVersion: MEASURER_VERSION,
          anchorTs: anchor,
          peakAbnormalMoveBps: summaryResult.peakAbnormalMoveBps,
          timeToPeakMinutes: summaryResult.timeToPeakMinutes,
          timeToHalfOf1dMoveMinutes: summaryResult.timeToHalfOf1dMoveMinutes,
          direction1d: summaryResult.direction1d,
        })
        .onConflictDoNothing();
    }

    if (oneDayRow.abnormalReturnBps <= RECOVERY_TRIGGER_BPS) {
      const anchorBar = settledBarAt(bars, anchor);
      const recoveryResult = recovery(
        anchor,
        cumulativeAbnormalSeries(
          anchor,
          extendWithDailyCloses(bars, dailies, anchorBar),
          extendWithDailyCloses(benchBars, benchDailies, undefined),
          betaValue,
          { untilTs: new Date(anchor.getTime() + DEFAULT_RECOVERY_WINDOW_DAYS * DAY_MS) },
        ),
        { windowDays: DEFAULT_RECOVERY_WINDOW_DAYS },
      );
      if (recoveryResult !== null && isConclusiveRecovery(recoveryResult)) {
        await db
          .insert(recoveryMeasurements)
          .values({
            clusterId: pair.clusterId,
            instrumentId: pair.instrumentId,
            measurerVersion: MEASURER_VERSION,
            anchorTs: anchor,
            troughBps: recoveryResult.troughBps,
            timeToTroughHours: recoveryResult.timeToTroughHours,
            timeToHalfReversionHours: recoveryResult.timeToHalfReversionHours,
            timeToFullReversionHours: recoveryResult.timeToFullReversionHours,
            windowDays: recoveryResult.windowDaysUsed,
          })
          .onConflictDoNothing();
      }
    }
  }

  logTotals(totals);
  return totals;
}

// ---------------------------------------------------------------- internals --

/**
 * Extend a minute-bar series past its end with daily closes so recovery can
 * cover up to 30 days from a 5d minute window. A daily bar's ts is the day's
 * OPEN (UTC midnight); its close belongs to the END of that day, so appended
 * points are stamped ts + 24h. Only dailies stamped after the last minute bar
 * are appended (hour-granularity recovery tolerates the coarser sampling).
 */
function extendWithDailyCloses(
  minuteBars: readonly CloseBar[],
  dailyBars: readonly CloseBar[],
  anchorBar: CloseBar | undefined,
): CloseBar[] {
  const lastMinuteMs = minuteBars[minuteBars.length - 1]?.ts.getTime() ?? Number.NEGATIVE_INFINITY;
  const floorMs = Math.max(lastMinuteMs, anchorBar?.ts.getTime() ?? Number.NEGATIVE_INFINITY);
  const appended = dailyBars
    .map((bar) => ({ ts: new Date(bar.ts.getTime() + DAY_MS), close: bar.close }))
    .filter((bar) => bar.ts.getTime() > floorMs);
  return [...minuteBars, ...appended];
}

/** UTC midnight of the given instant's calendar day — matches how daily bars are stamped. */
function startOfUtcDay(ts: Date): Date {
  return new Date(Date.UTC(ts.getUTCFullYear(), ts.getUTCMonth(), ts.getUTCDate()));
}

/**
 * A recovery result is safe to commit under conflict-do-nothing only once it
 * is a FINAL answer: either a full reversion was actually observed, or the
 * covered window is (near) the full DEFAULT_RECOVERY_WINDOW_DAYS ask (1-day
 * tolerance for the daily-bar granularity past the minute window). Otherwise
 * a later run — with more bars available — must be left free to write the
 * real answer instead of finding the row already there.
 */
function isConclusiveRecovery(result: {
  timeToFullReversionHours: number | null;
  windowDaysUsed: number;
}): boolean {
  return (
    result.timeToFullReversionHours !== null ||
    result.windowDaysUsed >= DEFAULT_RECOVERY_WINDOW_DAYS - 1
  );
}

function logTotals(totals: MeasureReactionsTotals): void {
  console.log(
    JSON.stringify({
      level: 'info',
      msg: 'reaction_measure',
      measurerVersion: MEASURER_VERSION,
      ...totals,
    }),
  );
}
