import type {
  DiscoveryInterpretation,
  MacroInterpretation,
  SectorExposure,
} from './macro-schema.js';
import type { MacroSector } from './macro-taxonomy.js';

/**
 * Turning ONE macro judgment into the signal rows it implies — deterministic,
 * pure, and unit-tested, because invariant 2 says the LLM never touches money.
 *
 * The model says "Utilities, bearish, 0.6". It does not choose which utilities,
 * how many, or how much of each. That mapping is arithmetic over the
 * point-in-time universe, and keeping it here rather than in the prompt buys
 * three things the model cannot provide: it cannot hallucinate a ticker, the
 * same judgment fans out identically on every replay, and changing the fanout
 * rule is a code change with a diff rather than a prompt edit with none.
 */

/** A universe member, as of the cluster's anchor instant. */
export interface FanoutInstrument {
  instrumentId: string;
  symbol: string;
  /** `instruments.sector_approx`; null members are unreachable by sector fanout. */
  sectorApprox: string | null;
}

/** One `llm_signals` row implied by a macro judgment. */
export interface MacroSignalRow {
  scope: 'macro' | 'sector';
  /** Set iff scope='sector' — the DB CHECK mirrors this. */
  sectorCode: MacroSector | null;
  direction: 'bullish' | 'bearish' | 'neutral';
  /** Per-sector for sector rows, story-level for the macro row. */
  materiality: number;
  expectedMoveBps: number;
}

/**
 * The signal rows one macro judgment implies.
 *
 * `none` yields zero rows on purpose. The judgment itself is still worth
 * recording — knowing the interpreter correctly declined a story is how its
 * false-positive rate gets measured — but that belongs in the attempt log, not
 * in `llm_signals`, which is the table the decide path reads. A `none` row
 * there would be a tradeable-looking artifact of a decision not to trade.
 */
export function macroSignalRows(judgment: MacroInterpretation): MacroSignalRow[] {
  if (judgment.market_scope === 'none') return [];

  if (judgment.market_scope === 'broad') {
    return [
      {
        scope: 'macro',
        sectorCode: null,
        direction: judgment.broad_direction,
        materiality: judgment.materiality,
        expectedMoveBps: judgment.expected_move_bps,
      },
    ];
  }

  // One row per named sector. `expected_move_bps` describes the MOST-affected
  // sector, so applying it unscaled to every sector would overstate the milder
  // ones; it is scaled by each sector's materiality relative to the strongest.
  // Without that, a story naming one severely and one mildly affected sector
  // would claim an identical move for both, and the mild row would drag the
  // measured accuracy of the whole event type down for a reason the model never
  // asserted.
  const peak = Math.max(...judgment.sector_exposures.map((e) => e.materiality), 0);
  return judgment.sector_exposures.map((exposure) => ({
    scope: 'sector' as const,
    sectorCode: exposure.sector,
    direction: exposure.direction,
    materiality: exposure.materiality,
    expectedMoveBps: scaleMove(judgment.expected_move_bps, exposure.materiality, peak),
  }));
}

/**
 * Scale the peak expected move down for a less-affected sector.
 *
 * Linear in materiality, and linear is a deliberate floor rather than a model:
 * there is no evidence yet for any particular shape, so the simplest monotone
 * rule is the honest one until the event study says otherwise. A `peak` of zero
 * means every named sector had materiality zero, in which case there is nothing
 * to scale and the move is zero too.
 */
function scaleMove(peakMoveBps: number, materiality: number, peak: number): number {
  if (peak <= 0) return 0;
  return Math.round(peakMoveBps * (materiality / peak) * 100) / 100;
}

/** One `llm_signals` row implied by a discovery judgment — company-scoped. */
export interface DiscoverySignalRow {
  scope: 'company';
  instrumentId: string;
  symbol: string;
  direction: 'bullish' | 'bearish' | 'neutral';
  materiality: number;
  expectedMoveBps: number;
}

export interface DiscoveryFanoutResult {
  rows: DiscoverySignalRow[];
  /**
   * Symbols the model returned that are NOT in the universe it was shown —
   * hallucinations that survived the prompt fence. Dropped from `rows`, but
   * surfaced so the sweep can count them: the hallucination rate is a quality
   * metric of the prompt, and silently discarding it would hide a regression.
   */
  unknownSymbols: string[];
}

/**
 * Turn one discovery judgment into company signal rows — the third and final
 * anti-hallucination fence.
 *
 * The prompt says "symbols from the candidate list only" and the wire schema
 * bounds the string, but neither can PROVE the symbol came from the list. This
 * can: every exposure is resolved against the exact universe the sweep
 * rendered into the prompt, and anything unresolved is dropped and reported
 * rather than persisted. Matching is case-insensitive on symbol because that
 * is the one liberty models actually take with tickers; anything beyond that
 * (a near-miss name, a delisted ticker) is treated as the hallucination it is.
 *
 * `none` yields zero rows for the same reason {@link macroSignalRows} gives:
 * the judgment is recorded in the attempt log, not as a tradeable-looking row.
 */
export function discoverySignalRows(
  judgment: DiscoveryInterpretation,
  universe: readonly FanoutInstrument[],
): DiscoveryFanoutResult {
  if (judgment.market_scope === 'none') return { rows: [], unknownSymbols: [] };

  const bySymbol = new Map(universe.map((i) => [i.symbol.toUpperCase(), i]));
  const rows: DiscoverySignalRow[] = [];
  const unknownSymbols: string[] = [];
  for (const exposure of judgment.company_exposures) {
    const match = bySymbol.get(exposure.symbol.toUpperCase());
    if (match === undefined) {
      unknownSymbols.push(exposure.symbol);
      continue;
    }
    rows.push({
      scope: 'company',
      instrumentId: match.instrumentId,
      symbol: match.symbol,
      direction: exposure.direction,
      materiality: exposure.materiality,
      expectedMoveBps: exposure.expected_move_bps,
    });
  }
  return { rows, unknownSymbols };
}

/**
 * Instruments a sector signal applies to, from the point-in-time universe.
 *
 * Matching is exact on `sector_approx`, which is why the sector vocabulary is
 * pinned to that column's real values. Members with a null sector are
 * unreachable here — deliberately, since guessing a sector for them would put
 * an instrument into a basket on no evidence.
 *
 * The caller must pass the universe AS OF the cluster's anchor. Passing today's
 * membership would be survivorship bias, which invariant 5 calls a bug.
 */
export function instrumentsForSector(
  universe: readonly FanoutInstrument[],
  sector: MacroSector,
): FanoutInstrument[] {
  return universe.filter((instrument) => instrument.sectorApprox === sector);
}

/**
 * Per-instrument weights for one sector exposure, equal-weighted.
 *
 * Equal weight, not capitalisation weight, and that is a measurement decision
 * before it is a trading one. A cap-weighted basket's return is dominated by
 * its largest members, so "did this sector move" would really be asking "did
 * its three biggest names move" — which is a different question, and one
 * already answered better by the company path. Equal weight measures the sector.
 *
 * Returns an empty array when no member matches, so a sector naming nothing in
 * the universe contributes nothing rather than erroring: the judgment was still
 * valid, we simply hold no instrument to express it.
 */
export function sectorFanoutWeights(
  universe: readonly FanoutInstrument[],
  exposure: SectorExposure,
): Array<{ instrumentId: string; symbol: string; weight: number }> {
  const members = instrumentsForSector(universe, exposure.sector);
  if (members.length === 0) return [];
  const weight = 1 / members.length;
  return members.map((member) => ({
    instrumentId: member.instrumentId,
    symbol: member.symbol,
    weight,
  }));
}
