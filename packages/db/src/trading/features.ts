/**
 * Pure decision-feature math — no DB, no clock, no randomness (architecture
 * §3: everything the engine reads is computed from explicit inputs and
 * snapshotted into the decisions row).
 *
 * Prices arrive as decimal STRINGS (numeric columns) and are parsed
 * explicitly; medianDollarVolume returns a plain number (analytic feature —
 * DecideFeatures.medianDollarVolume is z.number()), while wilderAtr returns a
 * number the repo converts back to a decimal string (DecideFeatures.atr is a
 * string because it feeds sizing math downstream).
 */

/** Minimal daily-bar shape the ATR needs; decimal strings from numeric columns. */
export interface DailyRangeBar {
  high: string;
  low: string;
  close: string;
}

export interface DailyVolumeBar {
  close: string;
  /** null on crypto rows recorded without volume. */
  volume: string | null;
}

/** medianDollarVolume needs at least this many usable (non-null-volume) days. */
export const MIN_DOLLAR_VOLUME_ROWS = 10;

/** medianDollarVolume looks back over this many trading days. */
export const DOLLAR_VOLUME_LOOKBACK_DAYS = 20;

/**
 * Wilder's ATR over `lookback` periods from ASCENDING daily bars.
 *
 * True range for bar i (i ≥ 1): max(high−low, |high−prevClose|, |low−prevClose|).
 * The first ATR value is the simple average of the first `lookback` true
 * ranges; every later bar smooths as ATR = (prevATR × (lookback−1) + TR) / lookback.
 * Returns null when fewer than `lookback + 1` bars are supplied (not enough
 * closes to form `lookback` true ranges). Callers should pass extra warmup
 * bars beyond lookback+1 when available — the smoothing converges with history.
 */
export function wilderAtr(bars: readonly DailyRangeBar[], lookback: number): number | null {
  if (!Number.isInteger(lookback) || lookback <= 0) {
    throw new Error(`wilderAtr: lookback must be a positive integer, got ${String(lookback)}`);
  }
  if (bars.length < lookback + 1) return null;

  const trueRanges: number[] = [];
  for (let i = 1; i < bars.length; i++) {
    const bar = bars[i];
    const prev = bars[i - 1];
    if (bar === undefined || prev === undefined) continue; // unreachable: i bounded by length
    const high = parseDecimal(bar.high, 'high');
    const low = parseDecimal(bar.low, 'low');
    const prevClose = parseDecimal(prev.close, 'close');
    trueRanges.push(Math.max(high - low, Math.abs(high - prevClose), Math.abs(low - prevClose)));
  }

  let atr = trueRanges.slice(0, lookback).reduce((sum, tr) => sum + tr, 0) / lookback;
  for (let i = lookback; i < trueRanges.length; i++) {
    const tr = trueRanges[i];
    if (tr === undefined) continue; // unreachable: i bounded by length
    atr = (atr * (lookback - 1) + tr) / lookback;
  }
  return atr;
}

/**
 * Median daily dollar volume (close × volume, USD) over the supplied trading
 * days. Returns null when fewer than MIN_DOLLAR_VOLUME_ROWS rows carry a
 * volume — crypto bars recorded without volume make the instrument's
 * liquidity unknown, not zero. Even-count medians average the middle two.
 */
export function medianDollarVolume(bars: readonly DailyVolumeBar[]): number | null {
  const dollarVolumes = bars
    .filter((bar): bar is DailyVolumeBar & { volume: string } => bar.volume !== null)
    .map((bar) => parseDecimal(bar.close, 'close') * parseDecimal(bar.volume, 'volume'));
  if (dollarVolumes.length < MIN_DOLLAR_VOLUME_ROWS) return null;

  dollarVolumes.sort((a, b) => a - b);
  const mid = Math.floor(dollarVolumes.length / 2);
  const upper = dollarVolumes[mid];
  if (upper === undefined) return null; // unreachable: length ≥ MIN_DOLLAR_VOLUME_ROWS
  if (dollarVolumes.length % 2 === 1) return upper;
  const lower = dollarVolumes[mid - 1];
  if (lower === undefined) return null; // unreachable: mid ≥ 1 when length is even and ≥ 10
  return (lower + upper) / 2;
}

function parseDecimal(value: string, field: string): number {
  const parsed = Number(value);
  if (!Number.isFinite(parsed)) {
    throw new Error(`features: non-numeric ${field} "${value}" from a numeric column`);
  }
  return parsed;
}
