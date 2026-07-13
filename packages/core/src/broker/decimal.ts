/**
 * Fixed-point decimal arithmetic on bigint — the money-path number type.
 *
 * Money/qty values are decimal STRINGS end to end (architecture §7); float
 * math never touches a fill, fee, or position quantity. A `Dec` is an exact
 * scaled integer (`units / 10^scale`); add/sub/mul are exact, and the only
 * lossy operations are the two explicit rounding entry points (`roundTo`,
 * `divRound`), both rounding HALF-AWAY-FROM-ZERO — matching how Postgres
 * rounds numeric columns, so a value rounded here equals the value the column
 * would have stored.
 *
 * Pure module: no I/O, no clock, no randomness.
 */

export interface Dec {
  readonly units: bigint;
  readonly scale: number;
}

export const ZERO: Dec = { units: 0n, scale: 0 };
export const ONE: Dec = { units: 1n, scale: 0 };

/** Optional sign, integer digits, optional fraction — what we parse AND emit. */
const DECIMAL_RE = /^-?\d+(?:\.\d+)?$/;

/** Exact parse of a decimal string; throws on anything else (incl. exponents). */
export function parseDec(value: string): Dec {
  if (!DECIMAL_RE.test(value)) {
    throw new Error(`parseDec: invalid decimal string "${value}"`);
  }
  const negative = value.startsWith('-');
  const unsigned = negative ? value.slice(1) : value;
  const dot = unsigned.indexOf('.');
  const digits = dot === -1 ? unsigned : unsigned.slice(0, dot) + unsigned.slice(dot + 1);
  const scale = dot === -1 ? 0 : unsigned.length - dot - 1;
  const units = BigInt(digits);
  return { units: negative ? -units : units, scale };
}

/**
 * Convert a config-knob number (bps values, equity defaults) to a Dec.
 * Rejects non-finite values and anything whose String() form uses exponent
 * notation — config knobs are human-scale by construction, and silently
 * mis-parsing "1e-7" as text would corrupt a fee. Conversion happens exactly
 * once, here, explicitly (mirrors packages/db/src/bars/decimal.ts).
 */
export function numberToDec(value: number): Dec {
  if (!Number.isFinite(value)) {
    throw new Error(`numberToDec: non-finite value ${String(value)}`);
  }
  const plain = String(value);
  if (/[eE]/.test(plain)) {
    throw new Error(`numberToDec: exponent-notation value ${plain} is not a valid config knob`);
  }
  return parseDec(plain);
}

const pow10 = (n: number): bigint => 10n ** BigInt(n);

/** Exact addition (result carries the finer of the two scales). */
export function add(a: Dec, b: Dec): Dec {
  const scale = Math.max(a.scale, b.scale);
  return {
    units: a.units * pow10(scale - a.scale) + b.units * pow10(scale - b.scale),
    scale,
  };
}

export function neg(a: Dec): Dec {
  return { units: -a.units, scale: a.scale };
}

export function sub(a: Dec, b: Dec): Dec {
  return add(a, neg(b));
}

/** Exact multiplication (scales add). */
export function mul(a: Dec, b: Dec): Dec {
  return { units: a.units * b.units, scale: a.scale + b.scale };
}

export function absDec(a: Dec): Dec {
  return a.units < 0n ? neg(a) : a;
}

export function isZero(a: Dec): boolean {
  return a.units === 0n;
}

/** −1 | 0 | +1 numeric comparison across scales. */
export function cmp(a: Dec, b: Dec): -1 | 0 | 1 {
  const diff = sub(a, b).units;
  return diff < 0n ? -1 : diff > 0n ? 1 : 0;
}

/**
 * Round to `scale` fractional digits, half-away-from-zero. Increasing the
 * scale is an exact rescale (pads zeros).
 */
export function roundTo(a: Dec, scale: number): Dec {
  assertScale(scale);
  if (scale >= a.scale) return { units: a.units * pow10(scale - a.scale), scale };
  return { units: divRoundHalfAway(a.units, pow10(a.scale - scale)), scale };
}

/**
 * num ÷ den, rounded to `scale` fractional digits half-away-from-zero — the
 * ONLY division in the money path (weighted-average entry prices and
 * proportional cost apportionment on partial closes need it).
 */
export function divRound(num: Dec, den: Dec, scale: number): Dec {
  assertScale(scale);
  if (den.units === 0n) throw new Error('divRound: division by zero');
  const negative = num.units < 0n !== den.units < 0n;
  const n = (num.units < 0n ? -num.units : num.units) * pow10(den.scale + scale);
  const d = (den.units < 0n ? -den.units : den.units) * pow10(num.scale);
  const q = divRoundHalfAway(n, d);
  return { units: negative ? -q : q, scale };
}

/** Canonical string form: no exponent, no trailing fraction zeros, no "-0". */
export function formatDec(a: Dec): string {
  const negative = a.units < 0n;
  let digits = (negative ? -a.units : a.units).toString();
  if (a.scale > 0) {
    digits = digits.padStart(a.scale + 1, '0');
    const intPart = digits.slice(0, -a.scale);
    const frac = digits.slice(-a.scale).replace(/0+$/, '');
    digits = frac.length > 0 ? `${intPart}.${frac}` : intPart;
  }
  return negative && digits !== '0' ? `-${digits}` : digits;
}

// ---------------------------------------------------------------- internals --

/** n ÷ d for d > 0, rounding half-away-from-zero on the sign of n. */
function divRoundHalfAway(n: bigint, d: bigint): bigint {
  const negative = n < 0n;
  const an = negative ? -n : n;
  let q = an / d;
  if ((an % d) * 2n >= d) q += 1n;
  return negative ? -q : q;
}

function assertScale(scale: number): void {
  if (!Number.isInteger(scale) || scale < 0) {
    throw new Error(`invalid decimal scale ${String(scale)}`);
  }
}
