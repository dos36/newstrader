import { REACTION_HORIZONS } from '../schema.js';

/**
 * Reaction/recovery math — architecture §5.6 / §6, pure functions, no DB.
 *
 * Every anchor is the cluster's first_received_at (OUR clock); published_at
 * never feeds these functions. Prices arrive as decimal STRINGS (numeric
 * columns) and are parsed explicitly; results are plain numbers because bps
 * returns tolerate float math (persistence stays decimal-string upstream).
 *
 * Session discipline: equity minute bars exist only during market hours, so
 * nothing here assumes contiguous minutes — every lookup walks the actual bar
 * timestamps. Two price-lookup contracts coexist:
 *
 *  - `priceAt` — last close at-or-before ts, undefined beyond a staleness
 *    bound. The strict contract for callers that need a FRESH price.
 *  - `settledBarAt` (used by the ladder/series) — additionally accepts a stale
 *    bar when a LATER bar exists. A later bar proves the gap was a non-trading
 *    gap (overnight/weekend/halt) and the stale close is the true last trade;
 *    no later bar means the data simply hasn't arrived yet, and using the
 *    stale close would mislabel a partial window as a settled horizon. This is
 *    what lets a Friday-evening anchor's horizons resolve once Monday bars
 *    land, without ever fabricating rows early.
 *
 * "Queue for open" reading (reactionLadder / cumulativeAbnormalSeries, daily+
 * horizons only — 1d/3d/5d): when a horizon's settled bar turns out to BE the
 * anchor bar (no trading anywhere in [anchor, horizon] — the norm for
 * off-hours anchors like a late-Friday 8-K or weekend crypto news), the
 * horizon falls forward to the first settled bar once the next session
 * opens, capped 3 days past the horizon. A weekend event's 1d reaction is
 * therefore read as the next session's move versus the prior close, rather
 * than being permanently unmeasurable. Intraday horizons (5m–4h) keep strict
 * semantics: no trading in a sub-day window genuinely means unmeasurable.
 */

export type ReactionHorizon = (typeof REACTION_HORIZONS)[number];

/** Minimal bar shape the math needs; `ts` is the bar OPEN time (UTC). */
export interface CloseBar {
  ts: Date;
  /** Decimal string straight from the numeric column. */
  close: string;
}

export const DEFAULT_PRICE_STALENESS_MINUTES = 30;

/** Horizon labels → window length in minutes. */
export const HORIZON_MINUTES: Record<ReactionHorizon, number> = {
  '5m': 5,
  '15m': 15,
  '30m': 30,
  '1h': 60,
  '4h': 240,
  '1d': 1_440,
  '3d': 4_320,
  '5d': 7_200,
};

const MINUTE_MS = 60_000;
const HOUR_MS = 3_600_000;
const DAY_MS = 86_400_000;

/**
 * Horizons that get the "queue for open" fallback (see reactionLadder):
 * daily+ only. Intraday horizons (5m–4h) keep strict semantics — no trading
 * in a sub-day window genuinely means unmeasurable, not "wait for Monday".
 */
const DAILY_PLUS_HORIZONS: ReadonlySet<ReactionHorizon> = new Set(['1d', '3d', '5d']);

/**
 * Cap on how far past a daily+ horizon timestamp the "queue for open"
 * fallback will look for the next settled bar — mirrors the 3-day settle
 * buffer reaction/measure-repo.ts already loads bars for (MINUTE_WINDOW_AFTER_MS).
 */
export const HORIZON_FALLBACK_CAP_MS = 3 * DAY_MS;

/**
 * Last bar close at-or-before `ts` from an ascending-sorted bar list;
 * undefined when no bar exists within `stalenessMinutes` of `ts`.
 */
export function priceAt(
  bars: readonly CloseBar[],
  ts: Date,
  stalenessMinutes: number = DEFAULT_PRICE_STALENESS_MINUTES,
): string | undefined {
  const index = lastIndexAtOrBefore(bars, ts.getTime());
  if (index < 0) return undefined;
  const bar = bars[index];
  if (bar === undefined) return undefined;
  if (ts.getTime() - bar.ts.getTime() > stalenessMinutes * MINUTE_MS) return undefined;
  return bar.close;
}

/**
 * Last bar at-or-before `ts`: fresh (within `freshMinutes`) always wins; a
 * stale bar is accepted only when a later bar proves the gap was non-trading
 * (see module header). Undefined otherwise.
 */
export function settledBarAt(
  bars: readonly CloseBar[],
  ts: Date,
  freshMinutes: number = DEFAULT_PRICE_STALENESS_MINUTES,
): CloseBar | undefined {
  const index = lastIndexAtOrBefore(bars, ts.getTime());
  if (index < 0) return undefined;
  const bar = bars[index];
  if (bar === undefined) return undefined;
  if (ts.getTime() - bar.ts.getTime() <= freshMinutes * MINUTE_MS) return bar;
  return index + 1 < bars.length ? bar : undefined;
}

/** Simple return in basis points from decimal-string prices; throws on format drift. */
export function simpleReturnBps(p0: string, p1: string): number {
  const from = parsePrice(p0);
  const to = parsePrice(p1);
  return ((to - from) / from) * 10_000;
}

/** Beta needs at least this many overlapping daily closes, else it is null. */
export const MIN_BETA_OVERLAP_DAYS = 30;

/**
 * OLS beta = cov(instrument, benchmark) / var(benchmark) over log returns of
 * date-aligned daily closes. Null when overlap < MIN_BETA_OVERLAP_DAYS or the
 * benchmark is flat (zero variance) — callers then use abnormal = raw.
 * Returns are computed between CONSECUTIVE aligned dates, so a shared holiday
 * gap contributes one multi-day return to both series consistently.
 */
export function beta(
  instrumentDailyCloses: readonly CloseBar[],
  benchmarkDailyCloses: readonly CloseBar[],
): number | null {
  const benchByTs = new Map<number, string>();
  for (const bar of benchmarkDailyCloses) benchByTs.set(bar.ts.getTime(), bar.close);

  const aligned: { instrument: number; bench: number }[] = [];
  const sortedInstrument = [...instrumentDailyCloses].sort(
    (a, b) => a.ts.getTime() - b.ts.getTime(),
  );
  for (const bar of sortedInstrument) {
    const benchClose = benchByTs.get(bar.ts.getTime());
    if (benchClose === undefined) continue;
    aligned.push({ instrument: parsePrice(bar.close), bench: parsePrice(benchClose) });
  }
  if (aligned.length < MIN_BETA_OVERLAP_DAYS) return null;

  const instrumentReturns: number[] = [];
  const benchReturns: number[] = [];
  for (let i = 1; i < aligned.length; i++) {
    const prev = aligned[i - 1];
    const curr = aligned[i];
    if (prev === undefined || curr === undefined) continue;
    instrumentReturns.push(Math.log(curr.instrument / prev.instrument));
    benchReturns.push(Math.log(curr.bench / prev.bench));
  }

  const meanInstrument = mean(instrumentReturns);
  const meanBench = mean(benchReturns);
  let covariance = 0;
  let benchVariance = 0;
  for (let i = 0; i < benchReturns.length; i++) {
    const ri = instrumentReturns[i];
    const rb = benchReturns[i];
    if (ri === undefined || rb === undefined) continue;
    covariance += (ri - meanInstrument) * (rb - meanBench);
    benchVariance += (rb - meanBench) ** 2;
  }
  if (benchVariance === 0) return null;
  return covariance / benchVariance;
}

/** Raw minus beta × benchmark; falls back to raw when either input is null. */
export function abnormalReturnBps(
  rawBps: number,
  benchBps: number | null,
  betaValue: number | null,
): number {
  if (betaValue === null || benchBps === null) return rawBps;
  return rawBps - betaValue * benchBps;
}

export interface LadderRow {
  horizon: ReactionHorizon;
  rawReturnBps: number;
  abnormalReturnBps: number;
  /** Null when the benchmark adjustment could not be applied (abnormal = raw). */
  betaUsed: number | null;
}

export interface LadderOptions {
  /** Freshness bound for settledBarAt lookups. */
  freshMinutes?: number;
}

/**
 * Per-horizon raw + abnormal return from the anchor price. A horizon is
 * SKIPPED (absent row = not measurable, never a fabricated zero) when:
 *  - there is no settled anchor bar, in which case the whole ladder is empty;
 *  - the horizon has no settled bar (data hasn't arrived yet); or
 *  - the horizon's bar IS the anchor bar (no trading happened in the window)
 *    AND the horizon is intraday (5m–4h) — for daily+ horizons (1d/3d/5d)
 *    this instead falls forward to the next session's first settled bar (see
 *    module header, "queue for open"), only skipping if none exists within
 *    HORIZON_FALLBACK_CAP_MS.
 * The benchmark return spans the same [anchor, horizon] window; when beta or
 * the benchmark window is unavailable the row falls back to abnormal = raw
 * with betaUsed null.
 */
export function reactionLadder(
  anchorTs: Date,
  bars1m: readonly CloseBar[],
  benchBars1m: readonly CloseBar[],
  betaValue: number | null,
  horizons: readonly ReactionHorizon[] = REACTION_HORIZONS,
  options: LadderOptions = {},
): LadderRow[] {
  const freshMinutes = options.freshMinutes ?? DEFAULT_PRICE_STALENESS_MINUTES;
  // Select the anchor bar by CLOSE (open + 60s), not open: a bar whose OPEN
  // is <= anchorTs can still CLOSE after it, baking up to a minute of
  // post-news trading into the "before" price and shrinking every horizon's
  // return. See module header / anchorBarLookupTs below.
  const anchorLookupTs = new Date(anchorTs.getTime() - MINUTE_MS);
  const anchorBar = settledBarAt(bars1m, anchorLookupTs, freshMinutes);
  if (anchorBar === undefined) return [];
  const benchAnchor =
    betaValue !== null ? settledBarAt(benchBars1m, anchorLookupTs, freshMinutes) : undefined;

  const rows: LadderRow[] = [];
  for (const horizon of horizons) {
    const horizonTs = new Date(anchorTs.getTime() + HORIZON_MINUTES[horizon] * MINUTE_MS);
    let horizonBar = settledBarAt(bars1m, horizonTs, freshMinutes);
    if (
      horizonBar !== undefined &&
      horizonBar.ts.getTime() <= anchorBar.ts.getTime() &&
      DAILY_PLUS_HORIZONS.has(horizon)
    ) {
      // "Queue for open": the settled horizon bar IS the anchor bar, i.e. no
      // trading happened anywhere in [anchor, horizon] (the norm for an
      // off-hours anchor — a Friday-evening filing's 1d horizon lands on
      // Saturday). Rather than treat the dominant live class of events as
      // permanently unmeasurable, fall forward to the first settled bar once
      // the next session opens: a weekend event's 1d reaction becomes the
      // next session's move vs the prior close.
      horizonBar = firstBarAfter(bars1m, horizonTs, HORIZON_FALLBACK_CAP_MS);
    }
    if (horizonBar === undefined || horizonBar.ts.getTime() <= anchorBar.ts.getTime()) continue;

    const rawReturnBps = simpleReturnBps(anchorBar.close, horizonBar.close);
    let abnormal = rawReturnBps;
    let betaUsed: number | null = null;
    if (betaValue !== null && benchAnchor !== undefined) {
      const benchHorizon = settledBarAt(benchBars1m, horizonTs, freshMinutes);
      if (benchHorizon !== undefined && benchHorizon.ts.getTime() > benchAnchor.ts.getTime()) {
        const benchBps = simpleReturnBps(benchAnchor.close, benchHorizon.close);
        abnormal = abnormalReturnBps(rawReturnBps, benchBps, betaValue);
        betaUsed = betaValue;
      }
    }
    rows.push({ horizon, rawReturnBps, abnormalReturnBps: abnormal, betaUsed });
  }
  return rows;
}

/** One cumulative abnormal-move sample; ts is the sampled bar's open time. */
export interface CumulativePoint {
  ts: Date;
  cumAbnormalBps: number;
}

/**
 * Cumulative abnormal move sampled at every available instrument bar strictly
 * after the anchor bar, up to `untilTs`. Cumulative abnormal at t is NOT
 * path-dependent: cum(t) = rawReturn(anchor→t) − beta × benchReturn(anchor→t),
 * so mixing bar resolutions (minute bars + appended daily closes) is sound.
 * Empty when there is no settled anchor bar. Benchmark samples take the last
 * bench close at-or-before each instrument bar; before the bench anchor moves
 * the point degrades to raw-only.
 */
export function cumulativeAbnormalSeries(
  anchorTs: Date,
  bars: readonly CloseBar[],
  benchBars: readonly CloseBar[],
  betaValue: number | null,
  options: {
    untilTs: Date;
    freshMinutes?: number;
    /**
     * "Queue for open" fallback: when NOTHING traded in (anchor, untilTs]
     * (settledBarAt(untilTs) resolves to the anchor bar itself — the common
     * off-hours-anchor case for the 1d summary window), extend the window to
     * the first settled bar after untilTs, capped at untilTs + this many ms,
     * so the summary reflects the next session's move instead of reporting
     * an empty/unmeasurable series. Mirrors reactionLadder's daily+ horizon
     * fallback (see HORIZON_FALLBACK_CAP_MS). Undefined (default): no
     * fallback — the plain [anchor, untilTs] window, as before. Only the 1d
     * summary window opts in (measure-repo.ts); the 30d recovery window is
     * already generous enough that this never triggers for it.
     */
    fallForwardCapMs?: number;
  },
): CumulativePoint[] {
  const freshMinutes = options.freshMinutes ?? DEFAULT_PRICE_STALENESS_MINUTES;
  // Select the anchor bar by CLOSE (open + 60s) — see reactionLadder.
  const anchorLookupTs = new Date(anchorTs.getTime() - MINUTE_MS);
  const anchorBar = settledBarAt(bars, anchorLookupTs, freshMinutes);
  if (anchorBar === undefined) return [];
  const benchAnchor =
    betaValue !== null ? settledBarAt(benchBars, anchorLookupTs, freshMinutes) : undefined;

  let effectiveUntilMs = options.untilTs.getTime();
  if (options.fallForwardCapMs !== undefined) {
    const untilBar = settledBarAt(bars, options.untilTs, freshMinutes);
    if (untilBar !== undefined && untilBar.ts.getTime() <= anchorBar.ts.getTime()) {
      const fallback = firstBarAfter(bars, options.untilTs, options.fallForwardCapMs);
      if (fallback !== undefined) effectiveUntilMs = fallback.ts.getTime();
    }
  }

  const points: CumulativePoint[] = [];
  for (const bar of bars) {
    if (bar.ts.getTime() <= anchorBar.ts.getTime()) continue;
    if (bar.ts.getTime() > effectiveUntilMs) break;
    const raw = simpleReturnBps(anchorBar.close, bar.close);
    let cum = raw;
    if (betaValue !== null && benchAnchor !== undefined) {
      const benchIndex = lastIndexAtOrBefore(benchBars, bar.ts.getTime());
      const benchBar = benchIndex >= 0 ? benchBars[benchIndex] : undefined;
      if (benchBar !== undefined && benchBar.ts.getTime() > benchAnchor.ts.getTime()) {
        cum = abnormalReturnBps(raw, simpleReturnBps(benchAnchor.close, benchBar.close), betaValue);
      }
    }
    points.push({ ts: bar.ts, cumAbnormalBps: cum });
  }
  return points;
}

/** |1d abnormal| under this is 'flat': no direction, no time-to-half. */
export const FLAT_1D_THRESHOLD_BPS = 10;

export interface ReactionSummaryResult {
  /** Max-|cumulative| move over the day, SIGNED. */
  peakAbnormalMoveBps: number;
  timeToPeakMinutes: number;
  /**
   * First minute |cum| reaches half of |1d move| WITH THE SAME SIGN as the
   * 1d move; null when 1d is flat. The sign check matters: a whipsaw dip
   * opposite the eventual move (e.g. -60bps at 5m before a +100bps 1d close)
   * would otherwise satisfy "half of the move" purely on magnitude.
   */
  timeToHalfOf1dMoveMinutes: number | null;
  direction1d: 'up' | 'down' | 'flat';
}

/**
 * Summary scalars over a cumulative series spanning [anchor, anchor+1d]. The
 * series' LAST point defines the 1d move (same bar the ladder's 1d horizon
 * resolves to). Null when the series is empty — the caller must only invoke
 * this once the 1d horizon is measurable, so a null here means no summary row.
 * Ties on |peak| go to the earliest point.
 */
export function summarize(
  anchorTs: Date,
  points: readonly CumulativePoint[],
): ReactionSummaryResult | null {
  const sorted = [...points].sort((a, b) => a.ts.getTime() - b.ts.getTime());
  const last = sorted[sorted.length - 1];
  if (last === undefined) return null;
  const move1d = last.cumAbnormalBps;

  let peak = last;
  for (const point of sorted) {
    if (Math.abs(point.cumAbnormalBps) > Math.abs(peak.cumAbnormalBps)) peak = point;
  }
  // Earliest point among |peak| ties (the loop above keeps the LAST strict max
  // seeded from `last`, so re-scan for the first occurrence of that magnitude).
  for (const point of sorted) {
    if (Math.abs(point.cumAbnormalBps) === Math.abs(peak.cumAbnormalBps)) {
      peak = point;
      break;
    }
  }

  const direction1d: 'up' | 'down' | 'flat' =
    Math.abs(move1d) < FLAT_1D_THRESHOLD_BPS ? 'flat' : move1d > 0 ? 'up' : 'down';

  let timeToHalfOf1dMoveMinutes: number | null = null;
  if (direction1d !== 'flat') {
    const halfAbs = Math.abs(move1d) / 2;
    const move1dSign = Math.sign(move1d);
    for (const point of sorted) {
      if (
        Math.abs(point.cumAbnormalBps) >= halfAbs &&
        Math.sign(point.cumAbnormalBps) === move1dSign
      ) {
        timeToHalfOf1dMoveMinutes = (point.ts.getTime() - anchorTs.getTime()) / MINUTE_MS;
        break;
      }
    }
  }

  return {
    peakAbnormalMoveBps: peak.cumAbnormalBps,
    timeToPeakMinutes: (peak.ts.getTime() - anchorTs.getTime()) / MINUTE_MS,
    timeToHalfOf1dMoveMinutes,
    direction1d,
  };
}

/** A (cluster, instrument) qualifies for recovery when 1d abnormal ≤ this. TUNABLE. */
export const RECOVERY_TRIGGER_BPS = -50;

export const DEFAULT_RECOVERY_WINDOW_DAYS = 30;

export interface RecoveryResult {
  /** Most negative cumulative abnormal move inside the window (bps). */
  troughBps: number;
  timeToTroughHours: number;
  /** First time after the trough that cum reverts to trough/2; null = never in window. */
  timeToHalfReversionHours: number | null;
  /** First time after the trough that cum reverts to ≥ 0; null = never in window. */
  timeToFullReversionHours: number | null;
  /**
   * min(requested windowDays, actual data coverage in days) — when the window
   * extends beyond the newest bar we compute with what exists and report the
   * days actually covered.
   */
  windowDaysUsed: number;
}

/**
 * Recovery metrics over a cumulative abnormal series (negative events only —
 * the caller gates on 1d abnormal ≤ RECOVERY_TRIGGER_BPS). Null when the
 * window holds no points or the trough is not negative (nothing to recover
 * from). Ties on the trough go to the earliest point.
 */
export function recovery(
  anchorTs: Date,
  points: readonly CumulativePoint[],
  options: { windowDays?: number } = {},
): RecoveryResult | null {
  const windowDays = options.windowDays ?? DEFAULT_RECOVERY_WINDOW_DAYS;
  const cutoffMs = anchorTs.getTime() + windowDays * DAY_MS;
  const sorted = points
    .filter((p) => p.ts.getTime() > anchorTs.getTime() && p.ts.getTime() <= cutoffMs)
    .sort((a, b) => a.ts.getTime() - b.ts.getTime());
  const last = sorted[sorted.length - 1];
  if (last === undefined) return null;

  let trough = sorted[0];
  if (trough === undefined) return null;
  for (const point of sorted) {
    if (point.cumAbnormalBps < trough.cumAbnormalBps) trough = point;
  }
  if (trough.cumAbnormalBps >= 0) return null;

  const halfTarget = trough.cumAbnormalBps / 2;
  let timeToHalfReversionHours: number | null = null;
  let timeToFullReversionHours: number | null = null;
  for (const point of sorted) {
    if (point.ts.getTime() <= trough.ts.getTime()) continue;
    if (timeToHalfReversionHours === null && point.cumAbnormalBps >= halfTarget) {
      timeToHalfReversionHours = (point.ts.getTime() - anchorTs.getTime()) / HOUR_MS;
    }
    if (timeToFullReversionHours === null && point.cumAbnormalBps >= 0) {
      timeToFullReversionHours = (point.ts.getTime() - anchorTs.getTime()) / HOUR_MS;
    }
    if (timeToHalfReversionHours !== null && timeToFullReversionHours !== null) break;
  }

  const coveredDays = (last.ts.getTime() - anchorTs.getTime()) / DAY_MS;
  return {
    troughBps: trough.cumAbnormalBps,
    timeToTroughHours: (trough.ts.getTime() - anchorTs.getTime()) / HOUR_MS,
    timeToHalfReversionHours,
    timeToFullReversionHours,
    windowDaysUsed: Math.min(windowDays, coveredDays),
  };
}

// ---------------------------------------------------------------- internals --

/**
 * First bar strictly after `ts`, capped at `ts + capMs`; undefined if none
 * exists within the cap. Powers the daily+ "queue for open" fallback in
 * reactionLadder / cumulativeAbnormalSeries: the bar returned here is exactly
 * the "later bar" settledBarAt(bars, ts) would have used as proof that a
 * stale bar at-or-before `ts` is genuinely settled, so callers only reach
 * this once that proof already exists.
 */
function firstBarAfter(bars: readonly CloseBar[], ts: Date, capMs: number): CloseBar | undefined {
  const tsMs = ts.getTime();
  const candidate = bars[lastIndexAtOrBefore(bars, tsMs) + 1];
  if (candidate === undefined) return undefined;
  return candidate.ts.getTime() <= tsMs + capMs ? candidate : undefined;
}

/** Binary search: index of the last bar with ts ≤ tsMs, or -1. Bars sorted asc. */
function lastIndexAtOrBefore(bars: readonly CloseBar[], tsMs: number): number {
  let lo = 0;
  let hi = bars.length - 1;
  let answer = -1;
  while (lo <= hi) {
    const mid = (lo + hi) >> 1;
    const bar = bars[mid];
    if (bar === undefined) return answer; // unreachable on a dense array
    if (bar.ts.getTime() <= tsMs) {
      answer = mid;
      lo = mid + 1;
    } else {
      hi = mid - 1;
    }
  }
  return answer;
}

/** Parse a decimal-string price; throws on format drift or non-positive values. */
function parsePrice(value: string): number {
  const trimmed = value.trim();
  const parsed = trimmed.length > 0 ? Number(trimmed) : Number.NaN;
  if (!Number.isFinite(parsed) || parsed <= 0) {
    throw new Error(
      `reaction:math invalid price ${JSON.stringify(value)} — expected a positive decimal string`,
    );
  }
  return parsed;
}

function mean(values: readonly number[]): number {
  if (values.length === 0) return 0;
  let sum = 0;
  for (const value of values) sum += value;
  return sum / values.length;
}
