/**
 * Number → decimal-string conversion for the price_bars_* numeric columns.
 *
 * Persistence discipline (schema.ts): prices are decimal STRINGS end to end.
 * Massive returns JSON floats, so the float → string conversion happens
 * exactly once, here, explicitly — and THROWS on non-finite values or values
 * that cannot fit the column (numeric(18,6) for prices, numeric(20,4) for
 * volume) instead of letting Postgres coerce or reject mid-batch.
 */

/** Matches what we emit: optional sign, digits, optional fraction. */
const DECIMAL_RE = /^-?\d+(?:\.\d+)?$/;

/**
 * Convert a JSON float to a decimal string with at most `maxScale` fractional
 * digits (trailing zeros trimmed). Rounds half-away-from-zero via toFixed —
 * acceptable because maxScale mirrors the column scale, so anything beyond it
 * would be rounded by Postgres anyway; doing it here keeps the stored string
 * equal to the string we computed with.
 *
 * `maxIntegerDigits` (default: unlimited) throws when the integer part alone
 * would overflow the column's total precision — e.g. numeric(18,6) allows at
 * most 12 integer digits, so a 13-digit price must be rejected here instead
 * of failing (or silently truncating) mid-batch inside Postgres.
 */
export function toDecimalString(
  value: number,
  maxScale: number,
  maxIntegerDigits: number = Number.POSITIVE_INFINITY,
): string {
  if (!Number.isFinite(value)) {
    throw new Error(`toDecimalString: non-finite value ${String(value)}`);
  }
  const plain = String(value);
  const s =
    /[eE]/.test(plain) || fractionDigits(plain) > maxScale
      ? trimZeros(value.toFixed(maxScale))
      : plain;
  if (!DECIMAL_RE.test(s)) {
    throw new Error(`toDecimalString: produced non-decimal output "${s}" from ${String(value)}`);
  }
  const integerDigits = countIntegerDigits(s);
  if (integerDigits > maxIntegerDigits) {
    throw new Error(
      `toDecimalString: ${String(value)} has ${integerDigits} integer digits, exceeding the ` +
        `column's ${maxIntegerDigits}-digit capacity — would overflow, not silently truncate`,
    );
  }
  return s;
}

/** numeric(18,6) price columns: 18 total digits − 6 scale = 12 integer digits. */
export const toPriceString = (value: number): string => toDecimalString(value, 6, 12);

/** numeric(20,4) volume column: 20 total digits − 4 scale = 16 integer digits. */
export const toVolumeString = (value: number): string => toDecimalString(value, 4, 16);

function fractionDigits(plain: string): number {
  const dot = plain.indexOf('.');
  return dot === -1 ? 0 : plain.length - dot - 1;
}

function countIntegerDigits(decimalString: string): number {
  const unsigned = decimalString.startsWith('-') ? decimalString.slice(1) : decimalString;
  const dot = unsigned.indexOf('.');
  return dot === -1 ? unsigned.length : dot;
}

function trimZeros(fixed: string): string {
  if (!fixed.includes('.')) return fixed;
  const trimmed = fixed.replace(/0+$/, '').replace(/\.$/, '');
  return trimmed === '' || trimmed === '-' ? '0' : trimmed;
}
