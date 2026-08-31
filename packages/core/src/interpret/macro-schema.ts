// zod/v4 for the same reason as schema.ts: the Anthropic SDK's zodOutputFormat
// converts via zod-v4's native toJSONSchema. Only schemas crossing the SDK
// boundary use it; the rest of the repo stays on the classic v3 API.
import { z } from 'zod/v4';

import { MACRO_EVENT_TYPES, MACRO_SECTORS, MAX_SECTOR_EXPOSURES } from './macro-taxonomy.js';

/**
 * One sector the model believes this event moves, and which way.
 *
 * `materiality` is per-sector on purpose. One event usually hits different
 * sectors with very different force — an export control can be existential for
 * one industry and a rounding error for its customers — and a single
 * story-level number would flatten that into a average that describes neither.
 * Sizing later reads the per-sector figure, so the distinction has to survive
 * into the row rather than being averaged away here.
 */
export const SectorExposureSchema = z.strictObject({
  sector: z.enum(MACRO_SECTORS),
  direction: z.enum(['bullish', 'bearish', 'neutral']),
  materiality: z.number().min(0).max(1),
});

export type SectorExposure = z.infer<typeof SectorExposureSchema>;

/**
 * The macro interpreter's output contract.
 *
 * Mirrors {@link InterpretationSchema} where the meaning is the same, so both
 * paths write comparable `llm_signals` rows and the existing calibration and
 * event-study machinery reads them without special cases. Two fields carry the
 * real difference:
 *
 * `market_scope` decides what rows get written at all — `none` writes nothing
 * tradeable, `broad` writes one macro row, `sector` writes one row per named
 * sector. It exists as an explicit field rather than being inferred from an
 * empty `sector_exposures` array, because "I judged this to have no market
 * mechanism" and "I could not think of a sector" must not look identical in
 * the data. The first is a real answer worth scoring; the second is a failure.
 *
 * `sector_exposures` is capped at {@link MAX_SECTOR_EXPOSURES}. See that
 * constant for why an unbounded list is worse than a short one.
 *
 * `expected_move_bps` is a magnitude (≥0) and direction carries the sign,
 * exactly as on the company path. Its ceiling is 2000 rather than 5000: a
 * single company can plausibly move 50% on news, an entire GICS sector
 * essentially cannot, and a ceiling that admits impossible values invites them.
 */
export const MacroInterpretationSchema = z.strictObject({
  macro_event_type: z.enum(MACRO_EVENT_TYPES),
  market_scope: z.enum(['none', 'broad', 'sector']),
  /** Direction of the BROAD market call. Required shape; only read when market_scope='broad'. */
  broad_direction: z.enum(['bullish', 'bearish', 'neutral']),
  sector_exposures: z.array(SectorExposureSchema).max(MAX_SECTOR_EXPOSURES),
  expected_move_bps: z.number().min(0).max(2000),
  horizon: z.enum(['intraday', '1d', '3d', '5d']),
  already_expected: z.boolean(),
  materiality: z.number().min(0).max(1),
  confidence: z.number().min(0).max(1),
  reasoning: z.string().min(1).max(600),
});

export type MacroInterpretation = z.infer<typeof MacroInterpretationSchema>;

/**
 * Reject answers that are internally inconsistent, after schema validation.
 *
 * The wire schema cannot express "this field is required only when that field
 * has this value", so a structurally valid response can still be incoherent —
 * `market_scope: 'sector'` with an empty exposure list names nobody, and
 * exposures listed under `market_scope: 'none'` contradict themselves. Both are
 * treated as poison pills rather than repaired, because every repair is a guess
 * about what the model meant, and a guessed signal is indistinguishable from a
 * real one once it is a row.
 *
 * Returns null when coherent, or a reason string for the failure log.
 */
export function macroCoherenceError(value: MacroInterpretation): string | null {
  const named = value.sector_exposures.length;
  if (value.market_scope === 'sector' && named === 0) {
    return 'market_scope=sector but sector_exposures is empty';
  }
  if (value.market_scope === 'none' && named > 0) {
    return `market_scope=none but ${String(named)} sector_exposures were given`;
  }
  if (value.market_scope === 'none' && value.materiality > 0.1) {
    return `market_scope=none but materiality is ${String(value.materiality)}`;
  }
  const duplicates = new Set(value.sector_exposures.map((e) => e.sector)).size !== named;
  if (duplicates) return 'sector_exposures names the same sector twice';
  return null;
}
