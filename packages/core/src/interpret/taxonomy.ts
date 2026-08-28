/**
 * Closed event-type taxonomy — part of the prompt-version contract.
 *
 * Why closed: the decide engine's whitelist gate matches event_type by EXACT
 * string (decide.ts eventTypeWhitelist.includes), and M5's event-study →
 * whitelist bridge aggregates drift statistics per event_type. Free-form
 * labels ("earnings_beat" vs "earnings-beat" vs "strong_earnings") would
 * fragment those statistics and the whitelist could never accumulate
 * evidence. The structured-output schema (schema.ts) enforces this enum at
 * the API layer, so an off-taxonomy label is a parse failure, never a row.
 *
 * Changing this list — adding, renaming, or splitting a type — changes what
 * the model can say and therefore REQUIRES a new prompt_version (registry.ts)
 * so per-type statistics never silently mix vocabularies.
 */

export const EVENT_TYPES = [
  'earnings_result',
  'guidance_update',
  'merger_acquisition',
  'ma_speculation',
  'executive_change',
  'analyst_action',
  'capital_return',
  'capital_raise',
  'restatement_accounting',
  'bankruptcy_restructuring',
  'impairment_writeoff',
  'delisting_compliance',
  'material_agreement',
  'legal_regulatory',
  'clinical_fda',
  'product_news',
  'insider_activity',
  'stake_disclosure',
  'other',
] as const;

export type EventType = (typeof EVENT_TYPES)[number];

/**
 * One-line definitions — the single source both for the system prompt's
 * taxonomy section (prompt.ts renders these) and for human docs. Keep each to
 * one sentence; the model sees them verbatim.
 */
export const EVENT_TYPE_DEFINITIONS: Record<EventType, string> = {
  earnings_result:
    'Actual financial results announced (quarterly/annual earnings, revenue, EPS) — 8-K item 2.02.',
  guidance_update:
    'Forward-looking guidance raised, cut, withdrawn, or issued outside a scheduled report; pre-announcements.',
  merger_acquisition:
    'An announced or completed acquisition, merger, divestiture, or asset sale involving the company — 8-K item 2.01.',
  ma_speculation:
    'Unconfirmed deal talk: rumors, "exploring strategic alternatives", reported takeover interest.',
  executive_change:
    'Departure or appointment of directors or principal officers (CEO/CFO/board) — 8-K item 5.02.',
  analyst_action: 'Analyst or rating-agency upgrades, downgrades, initiations, or target changes.',
  capital_return: 'Dividends (initiated, raised, cut, suspended) or share buyback programs.',
  capital_raise:
    'New equity or debt issuance, secondary offerings, convertibles — dilution or leverage events.',
  restatement_accounting:
    'Non-reliance on previously issued financials, restatements, auditor disputes — 8-K item 4.02.',
  bankruptcy_restructuring:
    'Bankruptcy or receivership (8-K item 1.03), restructurings, exit/disposal costs (item 2.05), going-concern distress.',
  impairment_writeoff: 'Material impairments or write-downs — 8-K item 2.06.',
  delisting_compliance:
    'Exchange delisting notices or listing-standard non-compliance — 8-K item 3.01.',
  material_agreement:
    'Entry into or termination of a material definitive agreement (contract wins/losses, partnerships) — 8-K items 1.01/1.02.',
  legal_regulatory:
    'Lawsuits, investigations, fines, settlements, antitrust actions, or regulatory approvals/denials outside clinical trials.',
  clinical_fda:
    'Drug/device trial results, FDA advisory or approval decisions, clinical holds — the biotech/pharma catalyst class.',
  product_news:
    'Product launches, recalls, major outages, safety incidents, or significant customer/order announcements.',
  insider_activity: 'Insider purchases or sales reported on SEC Form 4.',
  stake_disclosure:
    'Activist or passive stake disclosures (SC 13D/13G), stake increases or exits by notable holders.',
  other:
    'Anything that fits no category above, or a story that is not actually about this instrument.',
};

/**
 * Deterministic 8-K item-code → event-type hints, surfaced to the model as
 * context (the codes arrive on raw_news_items.meta.itemCodes from the EDGAR
 * adapter). 7.01/8.01 (Reg FD / other events) are deliberately absent — they
 * are grab-bags the model must judge from text.
 */
export const EIGHT_K_ITEM_HINTS: Readonly<Record<string, EventType>> = {
  '1.01': 'material_agreement',
  '1.02': 'material_agreement',
  '1.03': 'bankruptcy_restructuring',
  '2.01': 'merger_acquisition',
  '2.02': 'earnings_result',
  '2.05': 'bankruptcy_restructuring',
  '2.06': 'impairment_writeoff',
  '3.01': 'delisting_compliance',
  '4.02': 'restatement_accounting',
  '5.02': 'executive_change',
};
