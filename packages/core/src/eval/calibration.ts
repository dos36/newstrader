/**
 * Pure statistics for the M5 evaluation reports (eval:signals, report:weekly).
 * No I/O, no clock, no randomness — SQL lives in services/cli (stats.ts
 * pattern); this module turns row slices into calibration and rank statistics
 * that are unit-testable in isolation.
 *
 * Float math throughout, deliberately: these are ANALYTICS over `real` columns
 * (abnormal_return_bps, confidence), not money. Money stays decimal strings.
 */

// ------------------------------------------------------------- Wilson CI --

export interface WilsonInterval {
  lo: number;
  hi: number;
}

/**
 * Wilson score interval for a binomial proportion. Chosen over the normal
 * approximation because calibration deciles routinely hold n < 30, where the
 * normal interval escapes [0, 1] and lies about certainty.
 */
export function wilsonInterval(successes: number, n: number, z = 1.96): WilsonInterval | null {
  if (n <= 0 || successes < 0 || successes > n) return null;
  const p = successes / n;
  const z2 = z * z;
  const denom = 1 + z2 / n;
  const center = (p + z2 / (2 * n)) / denom;
  const half = (z * Math.sqrt((p * (1 - p)) / n + z2 / (4 * n * n))) / denom;
  return { lo: Math.max(0, center - half), hi: Math.min(1, center + half) };
}

// -------------------------------------------------------- decile buckets --

/** One scored binary outcome — e.g. (confidence, direction hit). */
export interface ScoredOutcome {
  /** Score in [0, 1] (confidence, materiality, …). Out-of-range clamps. */
  score: number;
  hit: boolean;
}

export interface DecileBucket {
  /** 0..9; bucket d covers [d/10, (d+1)/10), the last one includes 1.0. */
  decile: number;
  lo: number;
  hi: number;
  n: number;
  hits: number;
  hitRate: number | null;
  meanScore: number | null;
  ci: WilsonInterval | null;
}

/**
 * Fixed-width deciles over [0, 1] — NOT empirical quantiles. Calibration asks
 * "does a 0.8 mean 80%?", so the bucket bounds must be the score scale itself;
 * empirical deciles would move the goalposts with the score distribution.
 */
export function decileBuckets(outcomes: readonly ScoredOutcome[]): DecileBucket[] {
  const buckets: DecileBucket[] = Array.from({ length: 10 }, (_, decile) => ({
    decile,
    lo: decile / 10,
    hi: (decile + 1) / 10,
    n: 0,
    hits: 0,
    hitRate: null,
    meanScore: null,
    ci: null,
  }));
  const scoreSums = new Array<number>(10).fill(0);
  for (const outcome of outcomes) {
    const clamped = Math.min(1, Math.max(0, outcome.score));
    const decile = Math.min(9, Math.floor(clamped * 10));
    const bucket = buckets[decile];
    if (bucket === undefined) continue; // unreachable: decile ∈ [0, 9]
    bucket.n += 1;
    if (outcome.hit) bucket.hits += 1;
    scoreSums[decile] = (scoreSums[decile] ?? 0) + clamped;
  }
  for (const bucket of buckets) {
    if (bucket.n === 0) continue;
    bucket.hitRate = bucket.hits / bucket.n;
    bucket.meanScore = (scoreSums[bucket.decile] ?? 0) / bucket.n;
    bucket.ci = wilsonInterval(bucket.hits, bucket.n);
  }
  return buckets;
}

/**
 * Expected Calibration Error over non-empty buckets:
 * Σ (n_i / N) · |meanScore_i − hitRate_i|. Null when there is no data.
 * 0 = the score is exactly the empirical frequency; 0.1 = off by 10 points
 * on average. THE summary number for "does confidence mean anything".
 */
export function expectedCalibrationError(buckets: readonly DecileBucket[]): number | null {
  const total = buckets.reduce((sum, bucket) => sum + bucket.n, 0);
  if (total === 0) return null;
  let error = 0;
  for (const bucket of buckets) {
    if (bucket.n === 0 || bucket.hitRate === null || bucket.meanScore === null) continue;
    error += (bucket.n / total) * Math.abs(bucket.meanScore - bucket.hitRate);
  }
  return error;
}

// ------------------------------------------------------------- quantiles --

/**
 * Linear-interpolation quantile (R-7, the percentile_cont convention, so a TS
 * number and a SQL percentile over the same values agree). Null when empty.
 */
export function quantileOf(values: readonly number[], q: number): number | null {
  if (values.length === 0 || q < 0 || q > 1) return null;
  const sorted = [...values].sort((a, b) => a - b);
  const pos = (sorted.length - 1) * q;
  const base = Math.floor(pos);
  const rest = pos - base;
  const lower = sorted[base];
  if (lower === undefined) return null;
  const upper = sorted[base + 1];
  return upper === undefined ? lower : lower + rest * (upper - lower);
}

export function medianOf(values: readonly number[]): number | null {
  return quantileOf(values, 0.5);
}

// -------------------------------------------------------------- Spearman --

/**
 * Spearman rank correlation with average ranks for ties (materiality and
 * confidence are heavily tied — the LLM emits round numbers). Null when the
 * series are shorter than 3 pairs or either side is constant (rank variance
 * zero — correlation is undefined, not zero).
 */
export function spearmanRho(xs: readonly number[], ys: readonly number[]): number | null {
  if (xs.length !== ys.length) {
    throw new Error(`spearmanRho: length mismatch (${xs.length} vs ${ys.length})`);
  }
  const n = xs.length;
  if (n < 3) return null;
  const rx = averageRanks(xs);
  const ry = averageRanks(ys);
  return pearson(rx, ry);
}

/** 1-based average ranks (ties share the mean of the positions they occupy). */
function averageRanks(values: readonly number[]): number[] {
  const order = values.map((value, index) => ({ value, index })).sort((a, b) => a.value - b.value);
  const ranks = new Array<number>(values.length).fill(0);
  let i = 0;
  while (i < order.length) {
    let j = i;
    while (j + 1 < order.length && order[j + 1]?.value === order[i]?.value) j += 1;
    const rank = (i + j) / 2 + 1;
    for (let k = i; k <= j; k += 1) {
      const entry = order[k];
      if (entry !== undefined) ranks[entry.index] = rank;
    }
    i = j + 1;
  }
  return ranks;
}

function pearson(xs: readonly number[], ys: readonly number[]): number | null {
  const n = xs.length;
  const meanX = xs.reduce((sum, x) => sum + x, 0) / n;
  const meanY = ys.reduce((sum, y) => sum + y, 0) / n;
  let cov = 0;
  let varX = 0;
  let varY = 0;
  for (let i = 0; i < n; i += 1) {
    const dx = (xs[i] ?? 0) - meanX;
    const dy = (ys[i] ?? 0) - meanY;
    cov += dx * dy;
    varX += dx * dx;
    varY += dy * dy;
  }
  if (varX === 0 || varY === 0) return null;
  return cov / Math.sqrt(varX * varY);
}
