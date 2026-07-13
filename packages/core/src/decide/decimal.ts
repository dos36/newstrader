/**
 * Fixed-point decimal math for the money path — BigInt at a fixed scale of
 * 8 decimal places (the finest quantum we handle: crypto qty).
 *
 * Why not floats: sizing outputs are persisted decimal strings that replay
 * Mode A must reproduce bit-for-bit; float division (0.3/0.1 =
 * 2.9999999999999996) would leak drift into stored qty/notional. All
 * arithmetic here is integer BigInt; division TRUNCATES toward zero, which
 * equals floor for the non-negative values the sizing path feeds it —
 * truncation is the conservative direction for position sizes.
 */

/** Decimal places carried by every scaled value. */
export const DECIMAL_SCALE = 8;

/** 10^DECIMAL_SCALE — one whole unit in scaled space. */
export const SCALE = 100_000_000n;

const DECIMAL_RE = /^(-?)(\d+)(?:\.(\d+))?$/;

/**
 * Parse a decimal string (as stored in numeric columns) into a scaled BigInt.
 * Throws on format drift — a malformed money string is a bug upstream, never
 * something to guess at. More than 8 fractional digits also throws: silently
 * rounding an input would break replay reproducibility.
 */
export function parseScaled(value: string, label = 'decimal'): bigint {
  const match = DECIMAL_RE.exec(value.trim());
  if (match === null) {
    throw new Error(`invalid ${label} string: "${value}"`);
  }
  const sign = match[1] ?? '';
  const whole = match[2] ?? '0';
  const frac = match[3] ?? '';
  if (frac.length > DECIMAL_SCALE) {
    throw new Error(`${label} "${value}" has more than ${String(DECIMAL_SCALE)} decimal places`);
  }
  const scaled = BigInt(whole) * SCALE + BigInt(frac.padEnd(DECIMAL_SCALE, '0') || '0');
  return sign === '-' ? -scaled : scaled;
}

/**
 * Convert a config number (bps, multiples, fractions — always small and
 * human-authored) into a scaled BigInt. Rounds at the 8th decimal place:
 * config values are data, not measurements, so e.g. 0.1 → exactly 0.1 scaled
 * despite its inexact float representation.
 */
export function scaledFromNumber(value: number, label = 'number'): bigint {
  if (!Number.isFinite(value)) {
    throw new Error(`${label} must be finite, got ${String(value)}`);
  }
  const scaled = Math.round(value * 1e8);
  if (!Number.isSafeInteger(scaled)) {
    throw new Error(`${label} ${String(value)} is out of safe fixed-point range`);
  }
  return BigInt(scaled);
}

/** Scaled multiply: (a × b) at scale, truncating toward zero. */
export function mulScaled(a: bigint, b: bigint): bigint {
  return (a * b) / SCALE;
}

/** Scaled divide: (numerator ÷ denominator) at scale, truncating toward zero. */
export function divScaled(numerator: bigint, denominator: bigint): bigint {
  return (numerator * SCALE) / denominator;
}

/**
 * Floor a scaled value to `decimals` decimal places (0 = whole units).
 * Truncates toward zero — only ever applied to non-negative quantities.
 */
export function floorScaledTo(value: bigint, decimals: number): bigint {
  if (!Number.isInteger(decimals) || decimals < 0 || decimals > DECIMAL_SCALE) {
    throw new Error(`decimals must be an integer in [0, ${String(DECIMAL_SCALE)}]`);
  }
  const factor = 10n ** BigInt(DECIMAL_SCALE - decimals);
  return (value / factor) * factor;
}

/**
 * Canonical decimal-string form of a scaled value: no exponent, no trailing
 * fractional zeros, no trailing dot ("125", "83.33333333", "0.5"). Canonical
 * formatting matters — these strings are persisted and replay-compared.
 */
export function formatScaled(value: bigint): string {
  const negative = value < 0n;
  const abs = negative ? -value : value;
  const whole = (abs / SCALE).toString();
  const frac = (abs % SCALE).toString().padStart(DECIMAL_SCALE, '0').replace(/0+$/, '');
  return `${negative ? '-' : ''}${whole}${frac === '' ? '' : `.${frac}`}`;
}
