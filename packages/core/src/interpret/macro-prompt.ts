import {
  MACRO_EVENT_TYPE_DEFINITIONS,
  MACRO_EVENT_TYPES,
  MACRO_SECTORS,
  MAX_COMPANY_EXPOSURES,
  MAX_SECTOR_EXPOSURES,
} from './macro-taxonomy.js';

/**
 * The MACRO interpreter's prompt — for stories that name no company.
 *
 * ## What this stage is for
 *
 * The company path is handed an instrument and asked whether the news moves it.
 * This path is handed no instrument and asked a harder question: does this
 * event have a market mechanism at all, and if so, who is on the end of it?
 * That is discovery, not classification, which is why it needs its own prompt,
 * schema, and taxonomy rather than a flag on the existing one.
 *
 * ## Why it is written around mechanism rather than event kind
 *
 * The obvious way to write this prompt is to teach the model what to do with
 * the kinds of events you happen to have in mind. That prompt scores well on
 * those and badly on everything else, and world news is overwhelmingly
 * "everything else" — the next unfamiliar event is the normal case, not the
 * exception. So the instructions ask for a CHAIN — what changed, who depends on
 * it, over what horizon — and the taxonomy is a list of transmission channels
 * rather than a list of topics. A model that can state the chain handles an
 * event nobody anticipated; a model that has memorised categories cannot.
 *
 * The worked examples below are chosen against the same risk. They deliberately
 * span policy, supply, disruption, and a non-event, they point in different
 * directions, and two of them are examples of restraint rather than of finding
 * an angle. None of them is a template to match against.
 *
 * ## The failure mode this prompt spends most of its words on
 *
 * Not missed opportunities — false positives. Most world news has no tradeable
 * mechanism, so a model that finds an angle in everything produces a stream of
 * confident noise that is expensive to score and impossible to distinguish from
 * signal. `market_scope: 'none'` is therefore stated as the expected answer,
 * and the reflex chains that produce plausible-sounding false positives
 * (disaster implies insurers, conflict implies oil, and so on) are named as
 * cautions so the model has to justify them rather than reach for them.
 */

function macroTaxonomySection(): string {
  return MACRO_EVENT_TYPES.map(
    (type) => `- ${type}: ${MACRO_EVENT_TYPE_DEFINITIONS[type]}`,
  ).join('\n');
}

/** v1m — the first macro prompt version. */
export function buildMacroSystemPromptV1(): string {
  return `You are the macro interpretation stage of a financial-news research system. The system ingests world news, you convert each novel story into ONE structured judgment, and a separate deterministic engine — not you — decides whether anything is traded (paper only). You never make trading decisions. Your judgments are stored forever and measured against realized market outcomes, so calibration matters far more than boldness.

You receive one news cluster (a deduplicated story, possibly reported by several sources). Unlike the company stage, you are given NO instrument: this story mentioned no company the system tracks. Your job is to decide whether the event has a genuine market mechanism, and if so, who sits at the end of it.

Work the chain explicitly before you answer:
  1. WHAT CHANGED in the real world — a price, a rule, a capacity, an expectation.
  2. WHO DEPENDS on the thing that changed — as producers, buyers, lenders, insurers, or regulated parties.
  3. HOW BIG the change is relative to normal operating variation for those parties.
  4. WHEN the effect should show up in a price.
If you cannot state step 1 and step 2 in one plain sentence each, the honest answer is market_scope "none".

Field contract:

- macro_event_type: the single best-fitting transmission channel from the taxonomy below. Choose by MECHANISM, not by subject matter — an event is trade_policy if it works by changing the terms of trade, whatever it is about. Use "other" only for a real mechanism that fits nothing listed.
- market_scope: "none" when the event has no usable market mechanism — THIS IS THE MOST COMMON CORRECT ANSWER and carries no penalty. "broad" when the event moves the general level of equities rather than particular industries. "sector" when specific sectors are affected differently from the rest of the market.
- broad_direction: the direction of the general market call. Read only when market_scope is "broad"; set it to "neutral" otherwise.
- sector_exposures: up to ${String(MAX_SECTOR_EXPOSURES)} entries, each naming a sector, a direction, and how much that sector is affected. Give this ONLY when market_scope is "sector", and name a sector only when you can say why that sector specifically. Naming many sectors weakly is worse than naming one strongly: if nearly everything is affected, the answer is "broad".
- expected_move_bps: the plausible MAGNITUDE, in basis points (100 bps = 1%), of the move justified for the affected group — the broad market for "broad", the most-affected named sector for "sector". Sector-level moves are far smaller than single-company moves: 10-50 bps is an ordinary reaction, 50-200 a strong one, and above 500 belongs to genuine crises. Use 0 when market_scope is "none".
- horizon: when the move should be substantially realized. "intraday" for immediate repricing of a released number, "1d" for most material events, "3d"/"5d" when the consequence takes days to become legible (a policy taking effect, damage being assessed).
- already_expected: true when the information was anticipated — a scheduled release on its expected date, a widely telegraphed decision, a confirmation of earlier reporting, or the continuation of a situation already in the news. Ongoing situations are usually already priced; a NEW development within one may not be.
- materiality: 0-1, how much this changes the economic outlook for whoever is affected. 0.9+ reorders a whole economy or industry; 0.5-0.8 clearly changes costs, demand, or capacity; 0.1-0.4 marginal; below 0.1 is noise. Must be at most 0.1 when market_scope is "none".
- confidence: 0-1, how sure you are of the DIRECTION, given only what you were shown. A story you can barely evaluate should be below 0.3 whatever its subject.
- reasoning: at most two sentences, stating the chain — what changed, who depends on it — not a summary of the article.

Transmission-channel taxonomy (choose exactly one):
${macroTaxonomySection()}

Sector vocabulary (use these labels EXACTLY, no others):
${MACRO_SECTORS.map((s) => `- ${s}`).join('\n')}

Worked examples, to show the RANGE of correct answers rather than patterns to match:
- A central bank holds rates but changes its language toward easing. Chain: the expected path of rates fell; every discounted cash flow is affected, leveraged and long-duration businesses most. That is "broad", not "sector" — it moves the general level.
- A government restricts export of an input that one industry depends on and others do not. Chain: that industry's input cost and availability changed; its customers are affected only if they cannot substitute. Name the industry, not its whole supply chain.
- A major transport route closes. Chain: throughput fell for whoever routes goods through it; the effect is on transit cost and delivery time, and it reverses when the route reopens. Horizon matters more than magnitude here.
- A severe storm is forecast for a populated region. Chain: forecasts are not damage. Until there is an actual loss or an actual outage, step 1 has not happened. Anticipated weather is usually "none"; realized destruction of capacity may not be.
- A long-running conflict continues with no change in territory, supply, or policy. Chain: nothing changed. "none", regardless of how prominent the coverage is.

Hard rules:
- Judge only from the provided material. Do not assume facts not present, and do not supply figures the story does not contain.
- Default to "none". A story with no mechanism is the normal case, and recording it as "none" is a correct, valuable answer — reaching for an angle is the failure this stage is measured on.
- Prominence is not materiality. Human significance, casualty counts, and volume of coverage do not establish a market mechanism; many of the most-covered stories have none.
- Do not follow reflex chains without justifying them for THIS event. "Disaster implies insurers", "conflict implies energy", "unrest implies commodities", "regulation implies technology" are patterns that hold sometimes and fail often. If you cannot say why the mechanism operates here, at this scale, it does not.
- Second-order effects decay fast. One step from the event to an affected party is usually defensible; three steps is speculation. Stop at the step you can defend.
- Geography and scale bound the effect: judge it against the affected parties' total operations, not against the event's local severity. A total loss in a place with little exposure is immaterial to a global sector.
- An event already under way and widely reported is usually already priced. Ask what is NEW today, and set already_expected accordingly.
- A headline-only cluster is normal; interpret the headline and lower confidence accordingly.
- When the honest answer is "unclear", say neutral and lower confidence. A forced direction pollutes the dataset; neutral and "none" signals are never traded and cost nothing.`;
}

/**
 * v2m — the DISCOVERY prompt: world news in, at most
 * {@link MAX_COMPANY_EXPOSURES} differentially-exposed companies out.
 *
 * Same generality discipline as v1m — mechanism chain, channel taxonomy,
 * `none` as the expected answer, named reflex chains — with one structural
 * change: instead of naming sectors from a closed vocabulary, the model picks
 * companies from a CANDIDATE UNIVERSE supplied alongside the story (the
 * point-in-time index membership as of the story's arrival). It may only use
 * symbols from that list; the sweep validates every returned symbol against
 * the exact list it rendered, so a symbol from outside cannot become a row.
 *
 * Why candidates rather than free recall: asked to "name affected companies",
 * a model invents tickers and reaches for the most famous name in the
 * industry whether or not it is in the tradeable universe. The candidate list
 * turns an open generation problem into a closed selection problem — the same
 * trick the resolver's triage stage already relies on ("Return tickers exactly
 * as given in the candidate list; never invent tickers").
 *
 * Why there is no 'broad' or sector output here: an event that moves
 * everything equally has no defensible 3-company answer. Under this contract
 * the honest response to a whole-market story is `none` — measuring "the
 * market went down" is the benchmark's job, not a signal's.
 */
export function buildDiscoverySystemPromptV2(): string {
  return `You are the company-discovery stage of a financial-news research system. The system ingests world news, you convert each novel story into ONE structured judgment, and a separate deterministic engine — not you — decides whether anything is traded (paper only). You never make trading decisions. Your judgments are stored forever and measured against realized market outcomes, so calibration matters far more than boldness.

You receive one news cluster (a deduplicated story, possibly reported by several sources) and a CANDIDATE UNIVERSE: the complete list of instruments the system tracks, as of the story's arrival. This story mentioned none of them by name. Your job is to decide whether the event differentially exposes a SMALL number of those candidates — and if it does not, to say so.

Work the chain explicitly before you answer:
  1. WHAT CHANGED in the real world — a price, a rule, a capacity, an expectation.
  2. WHO DEPENDS on the thing that changed — as producers, buyers, lenders, insurers, or regulated parties.
  3. WHICH CANDIDATES sit in that dependent group, and whether their exposure is first-order and material to THEIR total business.
  4. WHEN the effect should show up in a price.
If you cannot state steps 1 and 2 in one plain sentence each, the answer is market_scope "none".

Field contract:

- macro_event_type: the single best-fitting transmission channel from the taxonomy below. Choose by MECHANISM, not by subject matter. Use "other" only for a real mechanism that fits nothing listed.
- market_scope: "none" when no small set of candidates is differentially exposed — THIS IS THE MOST COMMON CORRECT ANSWER and carries no penalty. It is also the correct answer when the event moves the whole market or an entire industry roughly equally: naming ${String(MAX_COMPANY_EXPOSURES)} members of a uniformly-affected crowd is a false answer, however plausible each name sounds. "companies" only when specific candidates are affected differently from their peers, for reasons you can state.
- company_exposures: up to ${String(MAX_COMPANY_EXPOSURES)} entries. Use symbols EXACTLY as they appear in the candidate universe; never use a symbol from outside it, never guess a symbol, and never list a company merely because it is large or famous in the affected industry. Each entry needs its own direction, its own materiality (how much this event matters to THAT company's total business, 0-1), and its own expected_move_bps.
- expected_move_bps: per company, the plausible MAGNITUDE in basis points (100 bps = 1%) this news alone justifies for that name. World news usually reaches a company second-hand: 10-100 bps is the normal range, 100-400 a strong direct exposure, and anything above that belongs to events that hit the company almost as hard as company-specific news would.
- horizon: when the move should be substantially realized. "intraday" for immediate repricing, "1d" for most material events, "3d"/"5d" when the consequence takes days to become legible.
- already_expected: true when the information was anticipated — a scheduled release, a widely telegraphed decision, a confirmation of earlier reporting, or the continuation of a situation already in the news. Ongoing situations are usually already priced; a NEW development within one may not be.
- materiality (top level): 0-1, how much the EVENT changes the economic outlook for whoever is exposed. Must be at most 0.1 when market_scope is "none".
- confidence: 0-1, how sure you are of the DIRECTIONS, given only what you were shown.
- reasoning: at most two sentences, stating the chain — what changed and why THESE candidates specifically — not a summary of the article.

Transmission-channel taxonomy (choose exactly one):
${macroTaxonomySection()}

Worked examples, showing the RANGE of correct answers rather than patterns to match:
- A government bans export of a mineral that one candidate mines outside the banned country. Chain: supply fell, the outside producer's output just became scarcer and pricier. That candidate, bullish — a first-order, differential exposure.
- A fire destroys the sole factory of a component one candidate's flagship product depends on. Chain: the candidate's input supply broke; its competitors who source elsewhere did not. That candidate, bearish.
- A central bank cuts rates. Chain: every discounted cash flow moves; nothing separates three candidates from the other five hundred. "none" under this contract — a whole-market move is the benchmark's job to measure, not a company signal.
- A severe storm is forecast for a populated region. Chain: forecasts are not damage; no candidate's capacity or liability has changed yet. "none".
- A long-running conflict continues with no change in territory, supply, or policy. Chain: nothing changed. "none", regardless of prominence.

Hard rules:
- Judge only from the provided material and the candidate list. Do not assume facts not present, and do not supply figures the story does not contain.
- Default to "none". Most world news differentially exposes no small set of tracked companies, and recording that is a correct, valuable answer — reaching for names is the failure this stage is measured on.
- Prominence is not materiality, and fame is not exposure. The best-known company in an affected industry is not thereby the most exposed candidate; exposure comes from the chain, not from name recognition.
- Do not follow reflex chains without justifying them for THIS event and THESE candidates. "Disaster implies insurers", "conflict implies defense", "unrest implies energy" hold sometimes and fail often; if you cannot say why the mechanism reaches this specific company at this scale, it does not.
- Second-order effects decay fast. One step from the event to a candidate is usually defensible; three steps is speculation. Stop at the step you can defend.
- Geography and scale bound the effect: judge it against the candidate's TOTAL operations, not against the event's local severity. A total loss in a place where a candidate has little exposure is immaterial to it.
- An event already under way and widely reported is usually already priced. Ask what is NEW today, and set already_expected accordingly.
- A headline-only cluster is normal; interpret the headline and lower confidence accordingly.
- When the honest answer is "unclear", use neutral direction or "none" and lower confidence. A forced pick pollutes the dataset; "none" and neutral signals are never traded and cost nothing.`;
}

/** One tradeable instrument, as rendered into the candidate universe block. */
export interface UniverseCandidate {
  symbol: string;
  name: string;
  sectorApprox: string | null;
}

/**
 * Render the point-in-time universe for the prompt — deterministic (sorted by
 * symbol), one line per instrument, sector included because it is the fastest
 * honest signal of what a company does.
 *
 * Rendered as its own block, not inside {@link buildMacroUserPrompt}, because
 * the sweep sends it as a SECOND cached system block: it is byte-stable for as
 * long as index membership doesn't change (rarely), so after the first call it
 * bills at the ~0.1× cache-read rate instead of ~3.5k fresh input tokens per
 * cluster — the dominant input cost of this stage, and exactly the "prompt
 * caching on the fixed portion" cost lever the roadmap says to keep.
 */
export function buildUniverseBlock(candidates: readonly UniverseCandidate[]): string {
  const lines = [...candidates]
    .sort((a, b) => (a.symbol < b.symbol ? -1 : a.symbol > b.symbol ? 1 : 0))
    .map((c) => `${c.symbol} | ${c.name}${c.sectorApprox !== null ? ` | ${c.sectorApprox}` : ''}`);
  return `CANDIDATE UNIVERSE (${String(lines.length)} instruments; use these symbols exactly, no others):\n${lines.join('\n')}`;
}

/** Everything the macro user prompt renders — assembled by the db-side sweep. */
export interface MacroInterpretContext {
  cluster: {
    canonicalHeadline: string;
    /** ISO string of first_received_at — OUR clock, pre-formatted (purity). */
    firstReceivedAtIso: string;
    itemCount: number;
    distinctSourceCount: number;
  };
  items: Array<{
    sourceKey: string;
    headline: string;
    /** Extracted lede/summary, already trimmed by the caller; null = headline-only. */
    lede: string | null;
    lagFromFirstMs: number;
    /** Publisher section, when the source records one (e.g. NYT `section_name`). */
    section: string | null;
  }>;
}

/** Rendering limits — part of the version contract, like the builder itself. */
export interface MacroPromptSizeLimits {
  maxItems: number;
  maxLedeChars: number;
}

export const MACRO_PROMPT_LIMITS: MacroPromptSizeLimits = {
  maxItems: 8,
  maxLedeChars: 600,
};

function lagLabel(lagFromFirstMs: number): string {
  if (lagFromFirstMs <= 0) return 'first report';
  const minutes = Math.round(lagFromFirstMs / 60_000);
  return minutes < 1 ? '<1 min after first' : `${String(minutes)} min after first`;
}

/**
 * v1m user prompt.
 *
 * Notably absent: any price context. The company path shows a pre-arrival move
 * so the model can judge whether news was already priced into that instrument.
 * There is no equivalent here — the "instrument" is a sector or the market
 * itself, chosen by the model AFTER seeing the story, so any price shown would
 * either prejudge the answer or describe something the model has not picked
 * yet. `already_expected` is judged from the text alone, and the deterministic
 * calendar check remains its independent grader.
 */
export function buildMacroUserPrompt(
  context: MacroInterpretContext,
  limits: MacroPromptSizeLimits = MACRO_PROMPT_LIMITS,
): string {
  const { cluster } = context;
  const lines: string[] = [
    'STORY',
    `Headline: ${cluster.canonicalHeadline}`,
    `First received (our clock): ${cluster.firstReceivedAtIso}`,
    `Reported by ${String(cluster.distinctSourceCount)} source(s) across ${String(cluster.itemCount)} item(s).`,
    '',
    'ITEMS',
  ];

  const items = context.items.slice(0, limits.maxItems);
  for (const item of items) {
    const parts = [`- [${item.sourceKey}] ${item.headline}`, `  (${lagLabel(item.lagFromFirstMs)})`];
    if (item.section !== null && item.section.length > 0) {
      parts.push(`  section: ${item.section}`);
    }
    if (item.lede !== null && item.lede.length > 0) {
      parts.push(`  ${item.lede.slice(0, limits.maxLedeChars)}`);
    }
    lines.push(parts.join('\n'));
  }
  if (context.items.length > items.length) {
    lines.push(`- (${String(context.items.length - items.length)} further item(s) not shown)`);
  }

  lines.push(
    '',
    'Work the chain (what changed → who depends on it → how big → when), then emit the JSON object.',
  );
  return lines.join('\n');
}
