/**
 * Constants shared across layers that would otherwise need to import each
 * other. bars/ may import reaction/ (e.g. benchmarks.ts is a leaf module),
 * but reaction/ must never import bars/bars-repo.ts, so a constant needed by
 * BOTH bars-repo.ts and reaction/measure-repo.ts lives here instead of in
 * either layer, to avoid an import cycle between them.
 */

/**
 * Minimum item_instrument_links confidence that feeds a measurement: both
 * reaction/measure-repo.ts's ladder query AND bars/bars-repo.ts's
 * backfillEventWindows link join must agree on this number, or the backfill
 * fetches vendor-rate-limited windows for links the measurer will never
 * consider (and vice versa).
 *
 * 0.75 excludes the ~40%-false-positive equity alias_dict links
 * (CONFIDENCE.nameAlias = 0.7, resolver/match.ts) while admitting the crypto
 * keyword channel (CONFIDENCE.cryptoKeyword = 0.8) — the ONLY channel that
 * links crypto news to an instrument. The previous 0.85 threshold excluded
 * both, making crypto structurally unmeasurable end to end.
 */
export const MIN_LINK_CONFIDENCE = 0.75;
