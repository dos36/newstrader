/**
 * Closed vocabularies for MACRO interpretation — the path for news that names
 * no company.
 *
 * The company path answers "does this news move THIS instrument?", with the
 * instrument supplied by the resolver. Most world news never gets there: it
 * names no company, so the resolver produces no pair and the story is dropped.
 * That discards the entire class of events that move markets through a
 * MECHANISM rather than through a name — a rate decision, an export control, a
 * grid failure, a storm.
 *
 * These vocabularies are closed for the same reason {@link EVENT_TYPES} is:
 * the whitelist gate and the event-study bridge match on exact strings, so
 * free-form labels would fragment per-type statistics until no category could
 * ever accumulate evidence. Adding, renaming, or splitting an entry changes
 * what the model can say and therefore REQUIRES a new prompt version.
 */

/**
 * Macro event types.
 *
 * Chosen to span the ways an event reaches a share price, not to enumerate
 * topics in the news. Each type is a distinct transmission channel — policy
 * changes the discount rate, a supply shock changes input costs, a disruption
 * changes throughput — because the channel is what determines who is affected
 * and in which direction. A topic-shaped list ("floods", "elections", "wars")
 * would need a new entry for every unfamiliar event and would tell the model
 * nothing about mechanism.
 *
 * `other` is deliberately present and deliberately last: a macro event that
 * fits nothing here should be labelled honestly rather than forced into the
 * nearest box, because a mislabelled row corrupts a category's statistics more
 * than an `other` row costs.
 */
export const MACRO_EVENT_TYPES = [
  'monetary_policy',
  'fiscal_policy',
  'trade_policy',
  'macro_data',
  'currency_move',
  'geopolitical_conflict',
  'political_transition',
  'regulation_legal',
  'energy_supply',
  'commodity_supply',
  'supply_chain_disruption',
  'natural_event',
  'public_health',
  'labor_action',
  'technology_shift',
  'other',
] as const;

export type MacroEventType = (typeof MACRO_EVENT_TYPES)[number];

/**
 * One-line definitions, rendered verbatim into the system prompt and reused in
 * docs. Kept to one sentence each; they are prompt text, not documentation
 * prose, so length here is a direct token cost on every call.
 */
export const MACRO_EVENT_TYPE_DEFINITIONS: Record<MacroEventType, string> = {
  monetary_policy:
    'Central bank rate decisions, balance-sheet changes, or official commentary that shifts rate expectations.',
  fiscal_policy:
    'Government budgets, stimulus, subsidies, taxation, or sovereign borrowing decisions.',
  trade_policy:
    'Tariffs, quotas, sanctions, export controls, trade agreements, or their enforcement.',
  macro_data:
    'Released economic statistics: inflation, employment, growth, sentiment, trade balances.',
  currency_move:
    'A material move or intervention in a currency, including pegs and capital controls.',
  geopolitical_conflict:
    'Armed conflict, military action, blockades, or a marked escalation or de-escalation of one.',
  political_transition:
    'Elections, leadership changes, coalition collapse, civil unrest, or governmental instability.',
  regulation_legal:
    'Laws, rulings, antitrust actions, or regulatory regimes affecting an industry rather than one firm.',
  energy_supply:
    'Disruption or expansion of oil, gas, power generation, or fuel distribution capacity.',
  commodity_supply:
    'Disruption or expansion of non-energy commodity supply: metals, minerals, crops, water.',
  supply_chain_disruption:
    'Interruption to transport, ports, shipping lanes, logistics, or critical digital infrastructure.',
  natural_event:
    'Weather, geological, or environmental events: storms, floods, heat, drought, earthquakes, fires.',
  public_health: 'Disease outbreaks, epidemics, or public-health measures that alter activity.',
  labor_action: 'Strikes, lockouts, or labour disputes large enough to affect an industry.',
  technology_shift:
    'A broad technological or scientific development that changes an industry’s economics.',
  other: 'A macro event with a genuine market mechanism that fits none of the above.',
};

/**
 * Sector vocabulary — GICS-11, matching `instruments.sector_approx` EXACTLY.
 *
 * Exact matching is the whole point: a sector signal is fanned out to
 * instruments by string equality against that column, so a label the column
 * never contains fans out to nothing and the signal is silently lost. Verified
 * against the live universe on 2026-08-31, where all 507 instruments carry one
 * of these eleven (4 carry null and are unreachable by sector fanout).
 */
export const MACRO_SECTORS = [
  'Communication Services',
  'Consumer Discretionary',
  'Consumer Staples',
  'Energy',
  'Financials',
  'Health Care',
  'Industrials',
  'Information Technology',
  'Materials',
  'Real Estate',
  'Utilities',
] as const;

export type MacroSector = (typeof MACRO_SECTORS)[number];

/**
 * Upper bound on sectors the model may name for one story.
 *
 * Four, not eleven, and the limit is doing real work. An unbounded list lets
 * the model hedge by naming everything, which is indistinguishable from a
 * broad-market call but produces eleven rows to score instead of one — inflating
 * apparent coverage while saying nothing. A story that genuinely touches most
 * of the market should say so through `market_scope: 'broad'`, which is the
 * honest way to express it.
 */
export const MAX_SECTOR_EXPOSURES = 4;

/**
 * Upper bound on companies the discovery contract may name for one story.
 *
 * Three, by explicit product decision (the operator asked for "a list of
 * companies, cap to 3"), and the cap serves the same anti-hedging purpose as
 * {@link MAX_SECTOR_EXPOSURES}: a story that genuinely exposes more than a
 * handful of names equally is a sector or market story, and the honest answer
 * under this contract is `none`, not three arbitrary picks from a crowd.
 */
export const MAX_COMPANY_EXPOSURES = 3;
