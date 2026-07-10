import { normalizeText } from '../ids.js';

/**
 * Pure headline-similarity helpers.
 *
 * The DB clusterer scores candidates with pg_trgm (character trigrams, in
 * Postgres). These word-shingle helpers are the unit-testable reference and
 * the in-app double-check of pg_trgm results. Both paths share normalizeText,
 * so they see identical text.
 *
 * Word 3-shingles are deliberately stricter than character trigrams: a single
 * changed word breaks up to k shingles, while char trigrams barely move. Use
 * them to confirm "clearly the same wire text" matches, not to reproduce the
 * exact pg_trgm score.
 */

/**
 * Word-level k-shingles over normalizeText(text).
 *
 * - Fewer than k words (but at least one): a single shingle of all words, so
 *   short headlines still compare exact-match style instead of vanishing.
 * - Text that normalizes to nothing (e.g. pure punctuation): empty set.
 */
export function shingles(text: string, k = 3): Set<string> {
  const words = normalizeText(text)
    .split(' ')
    .filter((w) => w.length > 0);
  const out = new Set<string>();
  if (words.length === 0) return out;
  if (words.length <= k) {
    out.add(words.join(' '));
    return out;
  }
  for (let i = 0; i + k <= words.length; i += 1) {
    out.add(words.slice(i, i + k).join(' '));
  }
  return out;
}

/**
 * Set-based Jaccard similarity: |A ∩ B| / |A ∪ B|.
 *
 * Two empty sets return 0, not 1: empty shingle sets carry no shared evidence,
 * and a clusterer must never merge two contentless headlines on a 0/0
 * technicality (conservative choice).
 */
export function jaccard(a: ReadonlySet<string>, b: ReadonlySet<string>): number {
  if (a.size === 0 || b.size === 0) return 0;
  let intersection = 0;
  for (const s of a) {
    if (b.has(s)) intersection += 1;
  }
  const union = a.size + b.size - intersection;
  return intersection / union;
}

/** Jaccard over word 3-shingles of the normalized headlines. */
export function headlineSimilarity(a: string, b: string): number {
  return jaccard(shingles(a), shingles(b));
}
