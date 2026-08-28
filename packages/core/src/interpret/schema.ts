// zod/v4 (shipped inside zod ^3.25) — REQUIRED: the Anthropic SDK's
// zodOutputFormat converts via zod-v4's native toJSONSchema, which needs a
// v4-constructed schema. The rest of the repo stays on the classic v3 API;
// only this schema crosses the SDK boundary.
import { z } from 'zod/v4';

import { EVENT_TYPES } from './taxonomy.js';

/**
 * The interpreter's output contract — the single source of truth for what the
 * LLM may say. This zod schema is handed to the Anthropic SDK's structured-
 * output helper (json_schema constraint on the wire) AND re-validated
 * client-side after parsing: the API-side grammar cannot express numeric
 * ranges, so the SDK strips .min/.max from the wire schema and zod enforces
 * them locally. Anything that fails here is a poison pill (no signal row),
 * never a partially-ingested signal.
 *
 * Field semantics mirror llm_signals columns 1:1 (snake_case = wire names):
 * - expected_move_bps is a MAGNITUDE (≥0); direction carries the sign.
 * - already_expected is the model's judgment from TEXT alone; the calendar
 *   gate (calendar_match) is the deterministic sibling — comparing the two
 *   per event type is a standing M5 calibration probe.
 * - reasoning is capped at ~2 sentences; it is stored queryably (M2 adds the
 *   column) for calibration review and the weekly report.
 */
export const InterpretationSchema = z.strictObject({
  event_type: z.enum(EVENT_TYPES),
  direction: z.enum(['bullish', 'bearish', 'neutral']),
  expected_move_bps: z.number().min(0).max(5000),
  horizon: z.enum(['intraday', '1d', '3d', '5d']),
  already_expected: z.boolean(),
  materiality: z.number().min(0).max(1),
  confidence: z.number().min(0).max(1),
  reasoning: z.string().min(1).max(600),
});

export type Interpretation = z.infer<typeof InterpretationSchema>;
