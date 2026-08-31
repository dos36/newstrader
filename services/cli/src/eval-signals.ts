import {
  decileBuckets,
  expectedCalibrationError,
  medianOf,
  spearmanRho,
  wilsonInterval,
  type DecileBucket,
  type WilsonInterval,
} from '@newstrader/core';
import { CALENDAR_TOLERANCE_MINUTES } from '@newstrader/db';
import type { Db } from '@newstrader/db';

/**
 * `eval:signals` — the M5 calibration/quality report (roadmap §4.3/§4.4/§4.6):
 * does the LLM's confidence mean anything, which event types actually drift,
 * and how fast the market prices the news. Joins llm_signals to
 * reaction_measurements (pinned to one measurer_version) and slices by
 * NY-session buckets, so market-hours-only numbers are one flag away.
 *
 * SQL lives here (stats.ts pattern, raw over the pg pool); the statistics
 * (Wilson CIs, ECE, Spearman, deciles) are pure functions in
 * packages/core/src/eval. Table assembly below is exported and pure so it is
 * unit-testable without a database.
 *
 * Hygiene defaults, each with a reason:
 *  - transport 'api' only — 'cli' rows ignored their prompt contract.
 *  - retrospective EXCLUDED — backfilled interpretations may carry prompt
 *    look-ahead (schema comment on llm_signals.retrospective); include them
 *    only deliberately, via --include-retrospective, e.g. to evaluate a v2+
 *    prompt that reconstructs its inputs at the observation lag.
 *  - one row per (cluster, instrument, version) pair, PLUS a cluster-deduped
 *    robustness view (max-confidence pair per cluster) so one 40-instrument
 *    cluster cannot masquerade as 40 independent observations.
 */

export const EVAL_HORIZONS = ['5m', '15m', '30m', '1h', '4h', '1d', '3d', '5d'] as const;
export type EvalHorizon = (typeof EVAL_HORIZONS)[number];

export const SESSION_BUCKETS = ['weekend', 'pre', 'rth', 'post', 'overnight'] as const;
export type SessionBucket = (typeof SESSION_BUCKETS)[number];

/**
 * |1d abnormal| at or above this = a "big move"; also the neutral-signal
 * correctness bound and the capture-ratio denominator floor. 100 bps ≈ a move
 * that clears realistic round-trip costs with room to be wrong about half.
 */
export const BIG_MOVE_BPS = 100;

/**
 * Below this sample size the whitelist bridge refuses a YES verdict: with
 * n < 20 the Wilson interval on the hit rate spans most of [0, 1], so a
 * "beats costs" median is indistinguishable from luck.
 */
export const MIN_BRIDGE_N = 20;

// ------------------------------------------------------------------- rows --

export interface EvalRow {
  id: string;
  clusterId: string;
  instrumentId: string;
  eventType: string;
  direction: 'bullish' | 'bearish' | 'neutral';
  confidence: number;
  materiality: number;
  expectedMoveBps: number;
  alreadyExpected: boolean;
  /** Deterministic ground truth: a scheduled event within tolerance of the anchor. */
  calendarMatch: boolean;
  promptVersion: string;
  assetClass: 'us_equity' | 'crypto';
  anchorTs: Date;
  session: SessionBucket;
  /** Abnormal return (bps) per settled horizon; null = not settled/measured. */
  abn: Record<EvalHorizon, number | null>;
  /** reaction_summary.time_to_half_of_1d_move_minutes. */
  tthm: number | null;
}

export interface LoadEvalRowsOptions {
  versions: string[];
  transports: string[];
  measurer: string;
  includeRetrospective: boolean;
  from?: Date;
  to?: Date;
  /** Tune/holdout split over cluster first_received_at. */
  split?: Date;
  holdout: boolean;
  eventTypes?: string[];
  /**
   * Restrict to clusters fed by these `news_sources.source_key` values.
   *
   * A cluster merges duplicate reports of one story, so it routinely spans
   * several sources and "signals from source X" has two honest readings:
   *
   *   - default (inclusive): the cluster contains AT LEAST ONE item from the
   *     list. Answers "how did signals that this source touched perform?" —
   *     but a cluster it shared with a wire gets counted, so a source can look
   *     good on stories it merely echoed.
   *   - `sourcesExclusive`: the cluster contains NOTHING BUT items from the
   *     list. Answers "what is this source worth on its own?", which is the
   *     question a single-source efficiency report is actually asking.
   *
   * Neither is more correct; they measure different things, so a report should
   * say which one it used.
   */
  sources?: string[];
  /** See {@link LoadEvalRowsOptions.sources}. Ignored when `sources` is empty. */
  sourcesExclusive?: boolean;
}

interface RawEvalRow {
  id: string;
  cluster_id: string;
  instrument_id: string;
  event_type: string;
  direction: 'bullish' | 'bearish' | 'neutral';
  confidence: number;
  materiality: number;
  expected_move_bps: number;
  already_expected: boolean;
  calendar_match: boolean;
  prompt_version: string;
  asset_class: 'us_equity' | 'crypto';
  anchor_ts: Date;
  session: SessionBucket;
  tthm: number | null;
  [key: `abn_${string}`]: number | null;
}

/**
 * NY-session bucket of a timestamptz, computed in SQL so DST is Postgres's
 * problem, not ours. Bounds follow US equity convention: pre 04:00–09:30,
 * rth 09:30–16:00, post 16:00–20:00; Saturday/Sunday = weekend; the rest
 * (20:00–04:00 weekdays) = overnight.
 */
const SESSION_CASE_SQL = (tsExpr: string): string => `
  case
    when extract(isodow from (${tsExpr} at time zone 'America/New_York')) >= 6 then 'weekend'
    when ((${tsExpr} at time zone 'America/New_York')::time >= time '04:00'
      and (${tsExpr} at time zone 'America/New_York')::time < time '09:30') then 'pre'
    when ((${tsExpr} at time zone 'America/New_York')::time >= time '09:30'
      and (${tsExpr} at time zone 'America/New_York')::time < time '16:00') then 'rth'
    when ((${tsExpr} at time zone 'America/New_York')::time >= time '16:00'
      and (${tsExpr} at time zone 'America/New_York')::time < time '20:00') then 'post'
    else 'overnight'
  end`;

/** One row per (signal, measured pair) with the abnormal ladder pivoted wide. */
export async function loadEvalRows(db: Db, options: LoadEvalRowsOptions): Promise<EvalRow[]> {
  const params: unknown[] = [
    options.versions,
    options.transports,
    options.includeRetrospective,
    options.measurer,
    CALENDAR_TOLERANCE_MINUTES,
  ];
  let filters = '';
  if (options.eventTypes !== undefined && options.eventTypes.length > 0) {
    params.push(options.eventTypes);
    filters += ` and s.event_type = any($${String(params.length)})`;
  }
  if (options.from !== undefined) {
    params.push(options.from);
    filters += ` and c.first_received_at >= $${String(params.length)}`;
  }
  if (options.to !== undefined) {
    params.push(options.to);
    filters += ` and c.first_received_at <= $${String(params.length)}`;
  }
  if (options.split !== undefined) {
    params.push(options.split);
    // Tune = clusters before the split; holdout = at/after. Splitting on the
    // CLUSTER anchor keeps every version's row for a pair on the same side.
    filters += ` and c.first_received_at ${options.holdout ? '>=' : '<'} $${String(params.length)}`;
  }
  if (options.sources !== undefined && options.sources.length > 0) {
    params.push(options.sources);
    const sourceParam = `$${String(params.length)}`;
    // Semi-join on the cluster's items. Written as exists/not-exists rather
    // than a join so a multi-item cluster cannot fan the signal row out into
    // duplicates — a duplicated row would silently double-weight that story in
    // every hit rate and mean below.
    filters += ` and exists (
                   select 1 from news_cluster_items nci
                     join raw_news_items ri on ri.id = nci.item_id
                     join news_sources ns on ns.id = ri.source_id
                    where nci.cluster_id = c.id
                      and ns.source_key = any(${sourceParam})
                 )`;
    if (options.sourcesExclusive === true) {
      filters += ` and not exists (
                     select 1 from news_cluster_items nci
                       join raw_news_items ri on ri.id = nci.item_id
                       join news_sources ns on ns.id = ri.source_id
                      where nci.cluster_id = c.id
                        and not (ns.source_key = any(${sourceParam}))
                   )`;
    }
  }

  const abnSelect = EVAL_HORIZONS.map(
    (horizon) =>
      `max(abnormal_return_bps) filter (where horizon = '${horizon}') as "abn_${horizon}"`,
  ).join(',\n              ');

  const result = await db.$client.query<RawEvalRow>(
    `with sig as (
       select s.id, s.cluster_id, s.instrument_id, s.event_type, s.direction,
              s.confidence, s.materiality, s.expected_move_bps, s.already_expected,
              s.prompt_version, i.asset_class,
              c.first_received_at as anchor_ts,
              ${SESSION_CASE_SQL('c.first_received_at')} as session,
              exists (
                select 1 from scheduled_events e
                 where e.scheduled_at
                       between c.first_received_at - make_interval(mins => $5)
                           and c.first_received_at + make_interval(mins => $5)
                   and (e.instrument_id is null or e.instrument_id = s.instrument_id)
              ) as calendar_match
         from llm_signals s
         join news_clusters c on c.id = s.cluster_id
         join instruments i on i.id = s.instrument_id
        where s.scope = 'company'
          and s.instrument_id is not null
          and s.prompt_version = any($1)
          and s.transport = any($2)
          and ($3::boolean or s.retrospective = false)${filters}
     ),
     rx as (
       select cluster_id, instrument_id,
              ${abnSelect}
         from reaction_measurements
        where measurer_version = $4
        group by 1, 2
     )
     select sig.*, ${EVAL_HORIZONS.map((h) => `rx."abn_${h}"`).join(', ')},
            rs.time_to_half_of_1d_move_minutes as tthm
       from sig
       join rx on rx.cluster_id = sig.cluster_id and rx.instrument_id = sig.instrument_id
       left join reaction_summary rs
         on rs.cluster_id = sig.cluster_id
        and rs.instrument_id = sig.instrument_id
        and rs.measurer_version = $4
      where rx."abn_1d" is not null
      order by sig.anchor_ts, sig.id`,
    params,
  );

  return result.rows.map((row) => {
    const abn = {} as Record<EvalHorizon, number | null>;
    for (const horizon of EVAL_HORIZONS) abn[horizon] = row[`abn_${horizon}`] ?? null;
    return {
      id: row.id,
      clusterId: row.cluster_id,
      instrumentId: row.instrument_id,
      eventType: row.event_type,
      direction: row.direction,
      confidence: row.confidence,
      materiality: row.materiality,
      expectedMoveBps: row.expected_move_bps,
      alreadyExpected: row.already_expected,
      calendarMatch: row.calendar_match,
      promptVersion: row.prompt_version,
      assetClass: row.asset_class,
      anchorTs: row.anchor_ts,
      session: row.session,
      abn,
      tthm: row.tthm,
    };
  });
}

// -------------------------------------------------------- pure assemblers --

/** Directional hit: sign of the 1d abnormal matches the signal's direction. */
export function directionalHit(row: EvalRow): boolean | null {
  const abn1d = row.abn['1d'];
  if (abn1d === null || row.direction === 'neutral') return null;
  return row.direction === 'bullish' ? abn1d > 0 : abn1d < 0;
}

export interface HitStats {
  n: number;
  hits: number;
  rate: number | null;
  ci: WilsonInterval | null;
}

export function hitStats(rows: readonly EvalRow[]): HitStats {
  let n = 0;
  let hits = 0;
  for (const row of rows) {
    const hit = directionalHit(row);
    if (hit === null) continue;
    n += 1;
    if (hit) hits += 1;
  }
  return { n, hits, rate: n > 0 ? hits / n : null, ci: wilsonInterval(hits, n) };
}

/**
 * Robustness view: one row per cluster — the max-confidence pair (ties break
 * to the lexically smallest id, so the pick is deterministic).
 */
export function dedupeByCluster(rows: readonly EvalRow[]): EvalRow[] {
  const byCluster = new Map<string, EvalRow>();
  for (const row of rows) {
    const current = byCluster.get(row.clusterId);
    if (
      current === undefined ||
      row.confidence > current.confidence ||
      (row.confidence === current.confidence && row.id < current.id)
    ) {
      byCluster.set(row.clusterId, row);
    }
  }
  return [...byCluster.values()];
}

export interface CalibrationReport {
  /** Non-neutral rows only (a neutral signal has no direction to hit). */
  n: number;
  buckets: DecileBucket[];
  dedupBuckets: DecileBucket[];
  ece: number | null;
  dedupEce: number | null;
  sliceHighConfidence: HitStats;
  sliceLowConfidence: HitStats;
}

export function calibrationReport(rows: readonly EvalRow[]): CalibrationReport {
  const directional = rows.filter((row) => directionalHit(row) !== null);
  const outcomes = directional.map((row) => ({
    score: row.confidence,
    hit: directionalHit(row) === true,
  }));
  const dedup = dedupeByCluster(directional).filter((row) => directionalHit(row) !== null);
  const dedupOutcomes = dedup.map((row) => ({
    score: row.confidence,
    hit: directionalHit(row) === true,
  }));
  const buckets = decileBuckets(outcomes);
  const dedupBuckets = decileBuckets(dedupOutcomes);
  return {
    n: directional.length,
    buckets,
    dedupBuckets,
    ece: expectedCalibrationError(buckets),
    dedupEce: expectedCalibrationError(dedupBuckets),
    sliceHighConfidence: hitStats(directional.filter((row) => row.confidence >= 0.75)),
    sliceLowConfidence: hitStats(directional.filter((row) => row.confidence < 0.5)),
  };
}

export interface MaterialityBucket {
  decile: number;
  lo: number;
  hi: number;
  n: number;
  medianAbsAbn1d: number | null;
}

export interface MaterialityReport {
  buckets: MaterialityBucket[];
  /** Spearman rho(materiality, |1d abnormal|). */
  rhoMateriality: number | null;
  /** Spearman rho(expected_move_bps, |1d abnormal|). */
  rhoExpectedMove: number | null;
  n: number;
}

export function materialityReport(rows: readonly EvalRow[]): MaterialityReport {
  const usable = rows.filter((row) => row.abn['1d'] !== null);
  const buckets: MaterialityBucket[] = Array.from({ length: 10 }, (_, decile) => ({
    decile,
    lo: decile / 10,
    hi: (decile + 1) / 10,
    n: 0,
    medianAbsAbn1d: null,
  }));
  const values = new Map<number, number[]>();
  for (const row of usable) {
    const clamped = Math.min(1, Math.max(0, row.materiality));
    const decile = Math.min(9, Math.floor(clamped * 10));
    const list = values.get(decile) ?? [];
    list.push(Math.abs(row.abn['1d'] ?? 0));
    values.set(decile, list);
  }
  for (const bucket of buckets) {
    const list = values.get(bucket.decile) ?? [];
    bucket.n = list.length;
    bucket.medianAbsAbn1d = medianOf(list);
  }
  const abs1d = usable.map((row) => Math.abs(row.abn['1d'] ?? 0));
  return {
    buckets,
    rhoMateriality: spearmanRho(
      usable.map((row) => row.materiality),
      abs1d,
    ),
    rhoExpectedMove: spearmanRho(
      usable.map((row) => row.expectedMoveBps),
      abs1d,
    ),
    n: usable.length,
  };
}

export interface EventTypeReportRow {
  eventType: string;
  n: number;
  nonNeutralShare: number;
  hit: HitStats;
  dedupHitRate: number | null;
  medianAbsAbn1d: number | null;
  bigMoveShare: number;
}

export function eventTypeReport(rows: readonly EvalRow[]): EventTypeReportRow[] {
  const byType = groupBy(rows, (row) => row.eventType);
  const out: EventTypeReportRow[] = [];
  for (const [eventType, typeRows] of byType) {
    const nonNeutral = typeRows.filter((row) => row.direction !== 'neutral');
    const abs1d = typeRows
      .map((row) => row.abn['1d'])
      .filter((value): value is number => value !== null)
      .map(Math.abs);
    const dedup = hitStats(dedupeByCluster(typeRows));
    out.push({
      eventType,
      n: typeRows.length,
      nonNeutralShare: typeRows.length > 0 ? nonNeutral.length / typeRows.length : 0,
      hit: hitStats(typeRows),
      dedupHitRate: dedup.rate,
      medianAbsAbn1d: medianOf(abs1d),
      bigMoveShare:
        abs1d.length > 0 ? abs1d.filter((value) => value >= BIG_MOVE_BPS).length / abs1d.length : 0,
    });
  }
  return out.sort((a, b) => b.n - a.n || a.eventType.localeCompare(b.eventType));
}

export interface NeutralReport {
  n: number;
  medianAbsAbn1d: number | null;
  /** hit = |1d abnormal| < threshold bps, per sensitivity threshold. */
  byThreshold: Array<{
    thresholdBps: number;
    hits: number;
    rate: number | null;
    ci: WilsonInterval | null;
  }>;
}

/** Neutral signals scored separately: "nothing should happen" is a testable claim. */
export function neutralReport(
  rows: readonly EvalRow[],
  thresholdsBps: readonly number[] = [50, BIG_MOVE_BPS, 150],
): NeutralReport {
  const neutral = rows.filter((row) => row.direction === 'neutral' && row.abn['1d'] !== null);
  const abs1d = neutral.map((row) => Math.abs(row.abn['1d'] ?? 0));
  return {
    n: neutral.length,
    medianAbsAbn1d: medianOf(abs1d),
    byThreshold: thresholdsBps.map((thresholdBps) => {
      const hits = abs1d.filter((value) => value < thresholdBps).length;
      return {
        thresholdBps,
        hits,
        rate: neutral.length > 0 ? hits / neutral.length : null,
        ci: wilsonInterval(hits, neutral.length),
      };
    }),
  };
}

export interface CaptureRatioRow {
  horizon: EvalHorizon;
  n: number;
  medianRatio: number | null;
}

export interface ReactionSpeedReport {
  overall: { n: number; medianTthm: number | null };
  byEventType: Array<{ key: string; n: number; medianTthm: number | null }>;
  bySession: Array<{ key: string; n: number; medianTthm: number | null }>;
  /** median(abn_h / abn_1d) restricted to |abn_1d| ≥ BIG_MOVE_BPS. */
  captureRatios: CaptureRatioRow[];
}

export function reactionSpeedReport(rows: readonly EvalRow[]): ReactionSpeedReport {
  const withTthm = rows.filter((row) => row.tthm !== null);
  const medianTthmOf = (subset: readonly EvalRow[]): number | null =>
    medianOf(subset.map((row) => row.tthm).filter((value): value is number => value !== null));

  const grouped = (key: (row: EvalRow) => string): ReactionSpeedReport['byEventType'] =>
    [...groupBy(withTthm, key)]
      .map(([groupKey, groupRows]) => ({
        key: groupKey,
        n: groupRows.length,
        medianTthm: medianTthmOf(groupRows),
      }))
      .sort((a, b) => b.n - a.n || a.key.localeCompare(b.key));

  const bigMoves = rows.filter((row) => Math.abs(row.abn['1d'] ?? 0) >= BIG_MOVE_BPS);
  const captureRatios: CaptureRatioRow[] = (['5m', '30m', '1h'] as const).map((horizon) => {
    const ratios = bigMoves
      .filter((row) => row.abn[horizon] !== null && row.abn['1d'] !== null && row.abn['1d'] !== 0)
      .map((row) => (row.abn[horizon] ?? 0) / (row.abn['1d'] ?? 1));
    return { horizon, n: ratios.length, medianRatio: medianOf(ratios) };
  });

  return {
    overall: { n: withTthm.length, medianTthm: medianTthmOf(withTthm) },
    byEventType: grouped((row) => row.eventType),
    bySession: grouped((row) => row.session),
    captureRatios,
  };
}

export interface SessionSummaryRow {
  session: SessionBucket;
  n: number;
  hit: HitStats;
  medianAbsAbn1d: number | null;
  bigMoveShare: number;
  medianTthm: number | null;
}

/** The session cut of the headline metrics — every table's numbers, per bucket. */
export function sessionSummary(rows: readonly EvalRow[]): SessionSummaryRow[] {
  return SESSION_BUCKETS.map((session) => {
    const sessionRows = rows.filter((row) => row.session === session);
    const abs1d = sessionRows
      .map((row) => row.abn['1d'])
      .filter((value): value is number => value !== null)
      .map(Math.abs);
    return {
      session,
      n: sessionRows.length,
      hit: hitStats(sessionRows),
      medianAbsAbn1d: medianOf(abs1d),
      bigMoveShare:
        abs1d.length > 0 ? abs1d.filter((value) => value >= BIG_MOVE_BPS).length / abs1d.length : 0,
      medianTthm: medianOf(
        sessionRows.map((row) => row.tthm).filter((value): value is number => value !== null),
      ),
    };
  }).filter((row) => row.n > 0);
}

export interface BridgeRow {
  eventType: string;
  horizon: EvalHorizon;
  n: number;
  meanSignedBps: number | null;
  medianSignedBps: number | null;
  hitRate: number | null;
  /** 'yes' | 'no' | 'n<MIN_BRIDGE_N' — the whitelist-entry verdict. */
  beatsCosts: string;
}

/**
 * The event-study → whitelist bridge (roadmap §4.3): per event_type × horizon,
 * the direction-signed abnormal drift vs an assumed round-trip cost. An event
 * type EARNS a whitelist entry only when its median signed drift clears the
 * cost with a defensible sample — the empty default whitelist stays empty
 * until this table says otherwise.
 */
export function whitelistBridge(
  rows: readonly EvalRow[],
  options: { costBps: number; horizons: readonly EvalHorizon[] },
): BridgeRow[] {
  const nonNeutral = rows.filter((row) => row.direction !== 'neutral');
  const out: BridgeRow[] = [];
  for (const [eventType, typeRows] of groupBy(nonNeutral, (row) => row.eventType)) {
    for (const horizon of options.horizons) {
      const signed = typeRows
        .filter((row) => row.abn[horizon] !== null)
        .map((row) =>
          row.direction === 'bearish' ? -(row.abn[horizon] ?? 0) : (row.abn[horizon] ?? 0),
        );
      if (signed.length === 0) continue;
      const median = medianOf(signed);
      const hits = signed.filter((value) => value > 0).length;
      const verdict =
        signed.length < MIN_BRIDGE_N
          ? `n<${String(MIN_BRIDGE_N)}`
          : median !== null && median > options.costBps
            ? 'yes'
            : 'no';
      out.push({
        eventType,
        horizon,
        n: signed.length,
        meanSignedBps: signed.reduce((sum, value) => sum + value, 0) / signed.length,
        medianSignedBps: median,
        hitRate: hits / signed.length,
        beatsCosts: verdict,
      });
    }
  }
  return out.sort(
    (a, b) =>
      a.eventType.localeCompare(b.eventType) || horizonIndex(a.horizon) - horizonIndex(b.horizon),
  );
}

function horizonIndex(horizon: EvalHorizon): number {
  return EVAL_HORIZONS.indexOf(horizon);
}

export interface ExpectedVsCalendarReport {
  /** 2×2 counts + non-neutral hit rate per cell. */
  cells: Array<{
    alreadyExpected: boolean;
    calendarMatch: boolean;
    n: number;
    hit: HitStats;
  }>;
  agreementRate: number | null;
  byEventType: Array<{
    eventType: string;
    n: number;
    expectedShare: number;
    matchShare: number;
    agreement: number;
  }>;
}

/**
 * roadmap §4.4 second half: the LLM's already_expected judgment against the
 * deterministic calendar match — a free, ongoing probe of whether the model
 * understands "priced in".
 */
export function expectedVsCalendar(rows: readonly EvalRow[]): ExpectedVsCalendarReport {
  const cells: ExpectedVsCalendarReport['cells'] = [];
  for (const alreadyExpected of [false, true]) {
    for (const calendarMatch of [false, true]) {
      const cellRows = rows.filter(
        (row) => row.alreadyExpected === alreadyExpected && row.calendarMatch === calendarMatch,
      );
      cells.push({ alreadyExpected, calendarMatch, n: cellRows.length, hit: hitStats(cellRows) });
    }
  }
  const agree = rows.filter((row) => row.alreadyExpected === row.calendarMatch).length;
  const byEventType = [...groupBy(rows, (row) => row.eventType)]
    .map(([eventType, typeRows]) => ({
      eventType,
      n: typeRows.length,
      expectedShare: typeRows.filter((row) => row.alreadyExpected).length / typeRows.length,
      matchShare: typeRows.filter((row) => row.calendarMatch).length / typeRows.length,
      agreement:
        typeRows.filter((row) => row.alreadyExpected === row.calendarMatch).length /
        typeRows.length,
    }))
    .sort((a, b) => b.n - a.n || a.eventType.localeCompare(b.eventType));
  return {
    cells,
    agreementRate: rows.length > 0 ? agree / rows.length : null,
    byEventType,
  };
}

export interface VersionComparison {
  baseVersion: string;
  otherVersion: string;
  /** (cluster, instrument) pairs answered by BOTH versions. */
  pairs: number;
  directionAgreement: number | null;
  /** from → to counts for pairs where the direction changed. */
  flips: Array<{ from: string; to: string; n: number }>;
  meanConfidenceDelta: number | null;
  medianConfidenceDelta: number | null;
}

/** Paired A/B view over the intersection of answered pairs. */
export function compareVersions(
  baseRows: readonly EvalRow[],
  otherRows: readonly EvalRow[],
  baseVersion: string,
  otherVersion: string,
): VersionComparison {
  const key = (row: EvalRow): string => `${row.clusterId}:${row.instrumentId}`;
  const baseByPair = new Map(baseRows.map((row) => [key(row), row]));
  const flips = new Map<string, number>();
  const confidenceDeltas: number[] = [];
  let pairs = 0;
  let agree = 0;
  for (const other of otherRows) {
    const base = baseByPair.get(key(other));
    if (base === undefined) continue;
    pairs += 1;
    if (base.direction === other.direction) agree += 1;
    else {
      const flipKey = `${base.direction}→${other.direction}`;
      flips.set(flipKey, (flips.get(flipKey) ?? 0) + 1);
    }
    confidenceDeltas.push(other.confidence - base.confidence);
  }
  return {
    baseVersion,
    otherVersion,
    pairs,
    directionAgreement: pairs > 0 ? agree / pairs : null,
    flips: [...flips.entries()]
      .map(([flip, n]) => {
        const [from = '', to = ''] = flip.split('→');
        return { from, to, n };
      })
      .sort((a, b) => b.n - a.n),
    meanConfidenceDelta:
      confidenceDeltas.length > 0
        ? confidenceDeltas.reduce((sum, value) => sum + value, 0) / confidenceDeltas.length
        : null,
    medianConfidenceDelta: medianOf(confidenceDeltas),
  };
}

/** Restrict to (cluster, instrument) pairs answered by EVERY requested version. */
export function restrictToAnsweredIntersection(
  rows: readonly EvalRow[],
  versions: readonly string[],
): EvalRow[] {
  const key = (row: EvalRow): string => `${row.clusterId}:${row.instrumentId}`;
  const versionsByPair = new Map<string, Set<string>>();
  for (const row of rows) {
    const set = versionsByPair.get(key(row)) ?? new Set<string>();
    set.add(row.promptVersion);
    versionsByPair.set(key(row), set);
  }
  return rows.filter((row) => {
    const set = versionsByPair.get(key(row));
    return set !== undefined && versions.every((version) => set.has(version));
  });
}

function groupBy<T>(rows: readonly T[], key: (row: T) => string): Map<string, T[]> {
  const groups = new Map<string, T[]>();
  for (const row of rows) {
    const groupKey = key(row);
    const list = groups.get(groupKey) ?? [];
    list.push(row);
    groups.set(groupKey, list);
  }
  return groups;
}

// --------------------------------------------------------------- next-open --

export interface NextOpenRow {
  session: SessionBucket;
  n: number;
  medianAbnNextOpenBps: number | null;
  /** median(next-open abnormal / 1d abnormal), restricted to |abn_1d| ≥ 100. */
  medianGapCapture: number | null;
  gapCaptureN: number;
}

interface RawNextOpenRow {
  session: SessionBucket;
  abn_next_open: number;
  abn_1d: number;
}

/**
 * "Next-open reaction" for off-hours anchors (roadmap §4 addendum): return
 * from the anchor's settled close to the close of the first RTH bar at/after
 * the next 09:30 ET, benchmark-adjusted with the pair's stored beta and SPY
 * over the same window. gap_capture = next-open abnormal / 1d abnormal — how
 * much of the day-one move already happened before we could trade it.
 * Deliberately query-level (no m3 measurer): promote only if it proves useful.
 *
 * Equities only: crypto trades continuously, so "next open" is not a thing.
 * The anchor close accepts a stale pre-anchor bar — the anchor is off-hours
 * by construction, so the prior session's close IS the honest reference; a
 * later bar (the next-open bar itself) proves the gap was non-trading.
 */
export async function loadNextOpenRows(
  db: Db,
  options: { measurer: string; from?: Date; to?: Date },
): Promise<NextOpenRow[]> {
  const params: unknown[] = [options.measurer];
  let filters = '';
  if (options.from !== undefined) {
    params.push(options.from);
    filters += ` and m.anchor_ts >= $${String(params.length)}`;
  }
  if (options.to !== undefined) {
    params.push(options.to);
    filters += ` and m.anchor_ts <= $${String(params.length)}`;
  }

  const result = await db.$client.query<RawNextOpenRow>(
    `with pair as (
       select m.cluster_id, m.instrument_id, m.anchor_ts,
              m.abnormal_return_bps as abn_1d, m.beta_used,
              ${SESSION_CASE_SQL('m.anchor_ts')} as session,
              -- next 09:30 ET strictly after the anchor; weekends roll forward
              -- naturally because no bar exists until Monday's session.
              case
                when (m.anchor_ts at time zone 'America/New_York')::time < time '09:30'
                then ((m.anchor_ts at time zone 'America/New_York')::date + time '09:30')
                       at time zone 'America/New_York'
                else ((m.anchor_ts at time zone 'America/New_York')::date + 1 + time '09:30')
                       at time zone 'America/New_York'
              end as next_open_ts
         from reaction_measurements m
         join instruments i on i.id = m.instrument_id
        where m.measurer_version = $1
          and m.horizon = '1d'
          and i.asset_class = 'us_equity'${filters}
     ),
     spy as (select id from instruments where symbol = 'SPY' and asset_class = 'us_equity'),
     legs as (
       select p.*,
              anchor_bar.close as anchor_close,
              open_bar.close  as open_close,
              spy_anchor.close as spy_anchor_close,
              spy_open.close   as spy_open_close
         from pair p
         cross join spy
         cross join lateral (
           select b.close from price_bars_1m b
            where b.instrument_id = p.instrument_id
              and b.ts <= p.anchor_ts - interval '1 minute'
            order by b.ts desc limit 1
         ) anchor_bar
         cross join lateral (
           select b.close from price_bars_1m b
            where b.instrument_id = p.instrument_id
              and b.ts >= p.next_open_ts
              and b.ts <= p.next_open_ts + interval '5 days'
              and (b.ts at time zone 'America/New_York')::time >= time '09:30'
              and (b.ts at time zone 'America/New_York')::time < time '16:00'
              and extract(isodow from (b.ts at time zone 'America/New_York')) < 6
            order by b.ts asc limit 1
         ) open_bar
         cross join lateral (
           select b.close from price_bars_1m b
            where b.instrument_id = spy.id
              and b.ts <= p.anchor_ts - interval '1 minute'
            order by b.ts desc limit 1
         ) spy_anchor
         cross join lateral (
           select b.close from price_bars_1m b
            where b.instrument_id = spy.id
              and b.ts >= p.next_open_ts
              and b.ts <= p.next_open_ts + interval '5 days'
              and (b.ts at time zone 'America/New_York')::time >= time '09:30'
              and (b.ts at time zone 'America/New_York')::time < time '16:00'
              and extract(isodow from (b.ts at time zone 'America/New_York')) < 6
            order by b.ts asc limit 1
         ) spy_open
        where p.session <> 'rth'
     )
     select session,
            ((open_close::float8 / anchor_close::float8 - 1) * 10000)
              - coalesce(beta_used, 1)
                * ((spy_open_close::float8 / spy_anchor_close::float8 - 1) * 10000)
              as abn_next_open,
            abn_1d
       from legs
      where anchor_close::float8 > 0 and spy_anchor_close::float8 > 0`,
    params,
  );

  return SESSION_BUCKETS.filter((session) => session !== 'rth')
    .map((session) => {
      const sessionRows = result.rows.filter((row) => row.session === session);
      const gapRows = sessionRows.filter((row) => Math.abs(row.abn_1d) >= BIG_MOVE_BPS);
      return {
        session,
        n: sessionRows.length,
        medianAbnNextOpenBps: medianOf(sessionRows.map((row) => row.abn_next_open)),
        medianGapCapture: medianOf(gapRows.map((row) => row.abn_next_open / row.abn_1d)),
        gapCaptureN: gapRows.length,
      };
    })
    .filter((row) => row.n > 0);
}

// ---------------------------------------------------------------- printing --

export interface EvalSignalsOptions extends LoadEvalRowsOptions {
  session?: SessionBucket;
  costBps: number;
  bridgeHorizons: EvalHorizon[];
}

export async function printEvalSignals(db: Db, options: EvalSignalsOptions): Promise<void> {
  let rows = await loadEvalRows(db, options);
  const multiVersion = options.versions.length > 1;
  if (multiVersion) rows = restrictToAnsweredIntersection(rows, options.versions);
  if (options.session !== undefined) {
    rows = rows.filter((row) => row.session === options.session);
  }

  console.log(
    `\n== eval:signals — measurer=${options.measurer} versions=${options.versions.join(',')} ` +
      `transports=${options.transports.join(',')} retrospective=${
        options.includeRetrospective ? 'INCLUDED' : 'excluded'
      }${options.session !== undefined ? ` session=${options.session}` : ''}${
        options.split !== undefined
          ? ` split=${options.split.toISOString()} (${options.holdout ? 'HOLDOUT' : 'tune'})`
          : ''
      } ==`,
  );
  if (options.includeRetrospective) {
    console.log(
      'WARNING: retrospective rows included — v1-prompt rows carry prompt look-ahead; ' +
        'only pool versions that reconstruct inputs at the observation lag.',
    );
  }
  if (rows.length === 0) {
    console.log(
      '(no joined rows — need llm_signals AND settled 1d reaction_measurements for the ' +
        'same (cluster, instrument) pairs; run `interpret` and `measure` first)',
    );
    return;
  }
  const clusters = new Set(rows.map((row) => row.clusterId)).size;
  console.log(
    `rows=${rows.length} clusters=${clusters}` +
      (multiVersion ? ' (restricted to pairs answered by every version)' : ''),
  );

  const versionsToPrint = multiVersion ? options.versions : [options.versions[0] ?? ''];
  for (const version of versionsToPrint) {
    const versionRows = multiVersion ? rows.filter((row) => row.promptVersion === version) : rows;
    if (multiVersion) console.log(`\n######## prompt_version ${version} ########`);
    printVersionTables(versionRows, options);
  }

  if (multiVersion) {
    const base = options.versions[0] ?? '';
    const baseRows = rows.filter((row) => row.promptVersion === base);
    for (const other of options.versions.slice(1)) {
      const comparison = compareVersions(
        baseRows,
        rows.filter((row) => row.promptVersion === other),
        base,
        other,
      );
      console.log(`\n== paired comparison: ${base} vs ${other} ==`);
      console.log(
        `pairs=${comparison.pairs} direction agreement=${fmtPct(comparison.directionAgreement)} ` +
          `confidence delta mean=${fmtNum(comparison.meanConfidenceDelta, 3)} ` +
          `median=${fmtNum(comparison.medianConfidenceDelta, 3)}`,
      );
      if (comparison.flips.length > 0) {
        console.table(comparison.flips);
      }
    }
  }

  // Next-open: pair-level (no LLM join), off-hours only — see loadNextOpenRows.
  const nextOpen = await loadNextOpenRows(db, {
    measurer: options.measurer,
    ...(options.from !== undefined ? { from: options.from } : {}),
    ...(options.to !== undefined ? { to: options.to } : {}),
  });
  console.log('\n== next-open reaction (off-hours anchors, equities, all measured pairs) ==');
  if (nextOpen.length === 0) {
    console.log('(no off-hours pairs with a next-open bar)');
  } else {
    console.table(
      nextOpen.map((row) => ({
        session: row.session,
        n: row.n,
        'median next-open abn bps': fmtNum(row.medianAbnNextOpenBps, 1),
        'median gap capture (|1d|≥100)': fmtNum(row.medianGapCapture, 2),
        'gap n': row.gapCaptureN,
      })),
    );
  }
}

function printVersionTables(rows: readonly EvalRow[], options: EvalSignalsOptions): void {
  const calibration = calibrationReport(rows);
  console.log(
    `\n== calibration: confidence deciles vs 1d directional hit rate (non-neutral, n=${String(calibration.n)}) ==`,
  );
  console.table(
    calibration.buckets
      .filter((bucket) => bucket.n > 0 || (calibration.dedupBuckets[bucket.decile]?.n ?? 0) > 0)
      .map((bucket) => ({
        confidence: `${bucket.lo.toFixed(1)}–${bucket.hi.toFixed(1)}`,
        n: bucket.n,
        'hit %': fmtPct(bucket.hitRate),
        'wilson 95%': fmtCi(bucket.ci),
        'mean conf': fmtNum(bucket.meanScore, 2),
        'dedup n': calibration.dedupBuckets[bucket.decile]?.n ?? 0,
        'dedup hit %': fmtPct(calibration.dedupBuckets[bucket.decile]?.hitRate ?? null),
      })),
  );
  console.log(
    `ECE=${fmtNum(calibration.ece, 3)} (cluster-deduped ${fmtNum(calibration.dedupEce, 3)}) · ` +
      `conf≥0.75: ${fmtHit(calibration.sliceHighConfidence)} · ` +
      `conf<0.5: ${fmtHit(calibration.sliceLowConfidence)}`,
  );

  const materiality = materialityReport(rows);
  console.log(`\n== materiality deciles vs median |1d abnormal| (n=${String(materiality.n)}) ==`);
  console.table(
    materiality.buckets
      .filter((bucket) => bucket.n > 0)
      .map((bucket) => ({
        materiality: `${bucket.lo.toFixed(1)}–${bucket.hi.toFixed(1)}`,
        n: bucket.n,
        'median |abn 1d| bps': fmtNum(bucket.medianAbsAbn1d, 1),
      })),
  );
  console.log(
    `Spearman rho(materiality, |abn 1d|)=${fmtNum(materiality.rhoMateriality, 3)} · ` +
      `rho(expected_move_bps, |abn 1d|)=${fmtNum(materiality.rhoExpectedMove, 3)}`,
  );

  console.log('\n== per event type ==');
  console.table(
    eventTypeReport(rows).map((row) => ({
      'event type': row.eventType,
      n: row.n,
      'non-neutral %': fmtPct(row.nonNeutralShare),
      'hit %': fmtPct(row.hit.rate),
      'wilson 95%': fmtCi(row.hit.ci),
      'dedup hit %': fmtPct(row.dedupHitRate),
      'median |abn 1d|': fmtNum(row.medianAbsAbn1d, 1),
      [`big-move % (≥${String(BIG_MOVE_BPS)})`]: fmtPct(row.bigMoveShare),
    })),
  );

  const neutral = neutralReport(rows);
  console.log(`\n== neutral signals (hit = |abn 1d| < threshold; n=${String(neutral.n)}) ==`);
  if (neutral.n === 0) {
    console.log('(no neutral signals in the slice)');
  } else {
    console.table(
      neutral.byThreshold.map((row) => ({
        'threshold bps': row.thresholdBps,
        'hit %': fmtPct(row.rate),
        'wilson 95%': fmtCi(row.ci),
      })),
    );
    console.log(`median |abn 1d| for neutral=${fmtNum(neutral.medianAbsAbn1d, 1)} bps`);
  }

  const speed = reactionSpeedReport(rows);
  console.log(
    `\n== reaction speed: minutes to half of the 1d move (n=${String(speed.overall.n)}, ` +
      `median=${fmtNum(speed.overall.medianTthm, 1)}) ==`,
  );
  if (speed.byEventType.length > 0) {
    console.log('-- by event type --');
    console.table(
      speed.byEventType.map((row) => ({
        'event type': row.key,
        n: row.n,
        'median min': fmtNum(row.medianTthm, 1),
      })),
    );
  }
  if (speed.bySession.length > 0) {
    console.log('-- by session --');
    console.table(
      speed.bySession.map((row) => ({
        session: row.key,
        n: row.n,
        'median min': fmtNum(row.medianTthm, 1),
      })),
    );
  }
  console.log(`-- capture ratio abn_h/abn_1d (|abn 1d| ≥ ${String(BIG_MOVE_BPS)} bps) --`);
  console.table(
    speed.captureRatios.map((row) => ({
      horizon: row.horizon,
      n: row.n,
      'median ratio': fmtNum(row.medianRatio, 2),
    })),
  );

  console.log('\n== session summary (the session cut of every headline metric) ==');
  console.table(
    sessionSummary(rows).map((row) => ({
      session: row.session,
      n: row.n,
      'hit %': fmtPct(row.hit.rate),
      'wilson 95%': fmtCi(row.hit.ci),
      'median |abn 1d|': fmtNum(row.medianAbsAbn1d, 1),
      'big-move %': fmtPct(row.bigMoveShare),
      'median min to half-move': fmtNum(row.medianTthm, 1),
    })),
  );

  console.log(
    `\n== whitelist bridge: signed drift per event type × horizon vs cost=${String(options.costBps)} bps ==`,
  );
  const bridge = whitelistBridge(rows, {
    costBps: options.costBps,
    horizons: options.bridgeHorizons,
  });
  if (bridge.length === 0) {
    console.log('(no non-neutral rows with settled horizons)');
  } else {
    console.table(
      bridge.map((row) => ({
        'event type': row.eventType,
        horizon: row.horizon,
        n: row.n,
        'median signed bps': fmtNum(row.medianSignedBps, 1),
        'mean signed bps': fmtNum(row.meanSignedBps, 1),
        'hit %': fmtPct(row.hitRate),
        'beats costs?': row.beatsCosts,
      })),
    );
  }

  const crossTable = expectedVsCalendar(rows);
  console.log('\n== already_expected (LLM) vs calendar_match (deterministic) ==');
  console.table(
    crossTable.cells.map((cell) => ({
      already_expected: cell.alreadyExpected,
      calendar_match: cell.calendarMatch,
      n: cell.n,
      'hit % (non-neutral)': fmtPct(cell.hit.rate),
    })),
  );
  console.log(`agreement=${fmtPct(crossTable.agreementRate)}`);
  if (crossTable.byEventType.length > 0) {
    console.table(
      crossTable.byEventType.map((row) => ({
        'event type': row.eventType,
        n: row.n,
        'expected %': fmtPct(row.expectedShare),
        'calendar %': fmtPct(row.matchShare),
        'agreement %': fmtPct(row.agreement),
      })),
    );
  }
}

// ------------------------------------------------------------- formatting --

export function fmtPct(value: number | null): string {
  return value === null ? '—' : `${(value * 100).toFixed(1)}%`;
}

export function fmtNum(value: number | null, digits: number): string {
  return value === null ? '—' : value.toFixed(digits);
}

export function fmtCi(ci: WilsonInterval | null): string {
  return ci === null ? '—' : `${(ci.lo * 100).toFixed(0)}–${(ci.hi * 100).toFixed(0)}%`;
}

export function fmtHit(stats: HitStats): string {
  return `${fmtPct(stats.rate)} (n=${String(stats.n)}, ${fmtCi(stats.ci)})`;
}
