import { EIGHT_K_ITEM_HINTS, EVENT_TYPE_DEFINITIONS, EVENT_TYPES } from './taxonomy.js';

/**
 * Prompt v1 — the fixed system prompt and the per-call user-prompt builder.
 *
 * Everything here is pure: no clock, no I/O, deterministic output for a given
 * context. The system prompt text is part of the prompt-version contract —
 * editing it without minting a new version in registry.ts fails the
 * hash-pin test (interpret.test.ts) on purpose. The system prompt is also the
 * prompt-cache prefix (it must stay byte-stable across calls and above the
 * ~1k-token cache minimum); ALL volatile content belongs in the user prompt.
 */

/**
 * Per-version prompt-size belt. A pure function should not trust callers, and
 * prompt size is a cost control — but the right size depends on what the
 * version is fed.
 *
 * v1/v2 were built when item text was a feed lede: median 456 chars from
 * Massive, 167 from RSS, 57 from an EDGAR Atom summary. 1500 was slack.
 *
 * v3 receives fetched SEC filing bodies plus their press-release exhibits, up
 * to 80k chars each. Left at 1500 the belt silently discarded 97% of an 8-K —
 * measured on a real Accenture filing: 80,059 chars stored, 1,500 rendered.
 * The caps below are what make the filing-document stage reach the model at
 * all, and they are per-version so v1/v2 rendering stays byte-identical for
 * replay.
 */
interface PromptSizeLimits {
  maxItems: number;
  maxLedeChars: number;
  /** Budget across ALL items, so a 4-item cluster cannot multiply the cap. */
  maxTotalLedeChars: number;
}

const LIMITS_V1: PromptSizeLimits = {
  maxItems: 4,
  maxLedeChars: 1500,
  maxTotalLedeChars: Number.POSITIVE_INFINITY,
};

/**
 * 40k chars ≈ 10k tokens per item, 60k total. Sized against cost, not context:
 * sonnet-5 holds 1M tokens, but 60k chars of input is ~$0.045 per call at list
 * price, so ~$300 across a 6.5k-pair backfill. Raising it further is a money
 * decision, not a technical one.
 */
const LIMITS_V3: PromptSizeLimits = {
  maxItems: 4,
  maxLedeChars: 40_000,
  maxTotalLedeChars: 60_000,
};

function taxonomySection(): string {
  return EVENT_TYPES.map((t) => `- ${t}: ${EVENT_TYPE_DEFINITIONS[t]}`).join('\n');
}

/** The one bullet that differs between v1/v2 and v3 (see buildUserPromptV3). */
const PRICE_BULLET_V1 =
  '- PRICE CONTEXT (move since the story first arrived): use it ONLY to judge already_expected — a large move in the news direction before/at arrival suggests the information was already out or leaked. NEVER use the price move to choose direction; direction comes from the news content. Do not invent technical analysis.';

const PRICE_BULLET_V3 =
  "- PRICE CONTEXT (the instrument's move over the session BEFORE the story arrived): use it ONLY to judge already_expected — a large pre-arrival move in the news direction means the information was likely already out, leaked, or widely anticipated. You are shown NO price action from after the story arrived, so nothing here hints at the outcome; do not try to infer one. NEVER use this to choose direction; direction comes from the news content. Do not invent technical analysis.";

/**
 * v3 only. The document sweep fetches 8-K bodies and their press-release
 * exhibits, so a v3 prompt can carry real filing text where v1/v2 carried the
 * Atom summary — filing metadata, median 57 characters. The model needs telling,
 * because the right reading of a long exhibit differs from the right reading of
 * a bare form type.
 */
const FILING_TEXT_BULLET_V3 =
  '- SEC filing text: an EDGAR item may carry the filing body and its exhibits, each under a [filename] header (ex99-1.htm and similar are press releases, usually where the numbers are). Text may be truncated mid-sentence — that is a length cap, not a filing defect. When a filing carries no text beyond the form type and item codes, judge from those and lower confidence accordingly.';

/**
 * The confidence field contract, verbatim as v1–v3 shipped it. Extracted so a
 * later version can replace the calibration language without touching the
 * frozen versions — v1/v3 hash pins prove the extraction is byte-neutral.
 */
const CONFIDENCE_BULLET_V1 =
  '- confidence: 0-1, your calibrated probability that the DIRECTION you chose is correct over the horizon. This is measured: across many signals where you say 0.8, the direction should be right about 80% of the time. Use the full scale honestly; 0.5 with direction neutral is a perfectly good answer for ambiguous news. Reserve ≥ 0.75 for cases where the causal link is direct and the surprise is unambiguous.';

/**
 * v4a change 2 — calibration bands. Measured motivation (tune set, anchors
 * before 2026-08-07): v3's hit rate was FLAT 46–60% across confidence deciles
 * (ECE 0.124, n=740 directional); the crowded 0.55-0.65 mid-range was no better
 * than chance. The band anchors give the model concrete event classes per band
 * instead of one 0.8 example, and forbid mid-range-as-hedge.
 */
const CONFIDENCE_BULLET_V4A =
  '- confidence: 0-1, your calibrated probability that the DIRECTION you chose is correct over the horizon. This is measured: across many signals where you say 0.8, the direction should be right about 80% of the time. Anchor to these bands: 0.50-0.60 for a plausible but ordinary directional read (most real news lives here); 0.60-0.75 when the causal mechanism is direct and the surprise is clear; above 0.75 only for unambiguous shocks (fraud, bankruptcy, a failed trial, an agreed acquisition at a stated premium). Do not park in the middle as a hedge: if the direction is genuinely unclear, choose neutral instead — but when the evidence clearly leans one way, commit to a direction.';

/**
 * v4a change 1 — earnings direction guidance. Measured motivation (tune set):
 * 147 earnings/guidance clusters were scored neutral; 58 of them moved ≥200bps
 * abnormal at 1d (25 moved ≥437bps, the P90 of all pairs). The reasoning texts
 * show the same shape each time: "mixed vs prior year" → neutral, while the
 * market reacted to the guidance or headline-axis surprise.
 */
const EARNINGS_RULE_V4A =
  '- Earnings and guidance stories: judge the surprise against what the market likely expected, not against the prior year — year-over-year comparisons are weak evidence, and the guidance axis usually dominates the reaction. A clear beat or miss on a headline axis (EPS, revenue, or guidance) is directional even when other axes are mixed; most "mixed" quarters still resolve directionally. Reserve neutral for genuinely offsetting axes of similar weight, and name the offsetting axes in reasoning.';

export function buildSystemPromptV1(): string {
  return systemPrompt(PRICE_BULLET_V1, []);
}

/**
 * v3 system prompt — v1 plus two changes, both narrow on purpose: the PRICE
 * CONTEXT bullet is replaced, and one bullet about filing text is added.
 */
export function buildSystemPromptV3(): string {
  return systemPrompt(PRICE_BULLET_V3, [FILING_TEXT_BULLET_V3]);
}

/**
 * v3-nofiling — the 8-K ablation arm: byte-identical to v3 except the filing
 * text bullet is absent, because the sweep (via includeFilingText: false) will
 * not load filing bodies for this version and the bullet would describe input
 * that never arrives. Exists to measure what the fetched filing text is worth.
 */
export function buildSystemPromptV3NoFiling(): string {
  return systemPrompt(PRICE_BULLET_V3, []);
}

/**
 * v4a — v3 plus exactly the two edits the tune-set failure analysis qualified
 * (each pattern has ≥20 tune examples; see the constants above). Everything
 * else is byte-identical to v3 so a v3-vs-v4a delta isolates the edits.
 */
export function buildSystemPromptV4a(): string {
  return systemPrompt(PRICE_BULLET_V3, [FILING_TEXT_BULLET_V3], CONFIDENCE_BULLET_V4A, [
    EARNINGS_RULE_V4A,
  ]);
}

function systemPrompt(
  priceBullet: string,
  extraContextBullets: string[],
  confidenceBullet: string = CONFIDENCE_BULLET_V1,
  extraJudgmentBullets: string[] = [],
): string {
  return `You are the interpretation stage of a financial-news research system. The system ingests news, you convert each novel story into ONE structured signal, and a separate deterministic engine — not you — decides whether anything is traded (paper only). You never make trading decisions; you state what the news says. Your judgments are stored forever and measured against realized market outcomes, so calibration matters more than boldness.

You will receive one news cluster (a deduplicated story, possibly reported by several sources) and one financial instrument the story was mechanically linked to. Emit exactly one JSON object matching the provided schema. Field contract:

- event_type: the single best-fitting category from the taxonomy below. If the story is genuinely about the instrument but fits no category, use "other". If the story is NOT actually about this instrument (bad link — it happens), use "other" with direction "neutral", materiality 0, confidence ≤ 0.2, and say so in reasoning.
- direction: the expected effect of THIS news on THIS instrument's price over your chosen horizon. "bullish" = up, "bearish" = down, "neutral" = no clear directional edge. Judge direction from the news content alone. When the honest answer is "unclear", say neutral — a forced direction pollutes the dataset; neutral signals are never traded and cost nothing.
- expected_move_bps: the plausible MAGNITUDE of the move this news alone justifies, in basis points (100 bps = 1%), regardless of direction. Typical earnings surprises move large caps 200-800 bps; genuine shocks (fraud, bankruptcy, failed trials, surprise M&A) can justify 1000-4000; routine news 0-100. Never exceed what the event class historically produces.
- horizon: when the move should be substantially realized. "intraday" for immediate mechanical repricing, "1d" for most material news, "3d"/"5d" only when the market will plausibly need days to digest (complex deals, regulatory cascades).
- already_expected: true when the information was anticipated — a scheduled release (earnings on the expected date, a known FDA decision date), a confirmation of prior reporting, or a widely telegraphed outcome. True means "the market should have priced this"; the system separately checks a deterministic events calendar, and your judgment is graded against it.
- materiality: 0-1, how much this matters to the company's value. 0.9+ existential (bankruptcy, fraud, transformative M&A); 0.5-0.8 clearly moves the business (earnings, guidance, major contracts); 0.1-0.4 routine; <0.1 noise, PR fluff, or not really about this company.
${confidenceBullet}
- reasoning: at most two sentences. State the mechanism ("X happened, which affects Y, so Z"), not a summary of the article.

Event-type taxonomy (choose exactly one):
${taxonomySection()}

Context you may receive, and how to use it:
- Multiple source items with time lags: more independent sources and faster pickup usually means a bigger story, but judge materiality from content, not popularity alone.
- SEC 8-K item codes with deterministic category hints: trust the hint for event_type unless the filing text clearly says otherwise; codes 7.01/8.01 carry no hint and must be judged from text.
${priceBullet}${extraContextBullets.map((bullet) => `\n${bullet}`).join('')}

Hard rules:
- Judge only from the provided material. Do not assume facts not present.
- A headline-only cluster (no article text) is normal; interpret the headline, lower confidence accordingly.
- Wire-service boilerplate, promotional pieces, and listicles are materiality ≤ 0.1, neutral.
- Never let the linked instrument bias you into finding relevance that is not there — the "other"/neutral escape hatch exists exactly for mis-links.${extraJudgmentBullets.map((bullet) => `\n${bullet}`).join('')}`;
}

/** Everything the user prompt renders — assembled by the db-side sweep. */
export interface InterpretContext {
  instrument: {
    symbol: string;
    name: string;
    assetClass: 'us_equity' | 'crypto';
    sectorApprox: string | null;
    exchange: string | null;
  };
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
    /** 8-K item codes from raw meta, when the item is an EDGAR filing. */
    itemCodes: string[] | null;
    formType: string | null;
  }>;
  /**
   * Signed move from the anchor close to the observation instant — i.e. the
   * FIRST MINUTES OF THE REACTION. Read by v1/v2 only. v3 dropped it: it is
   * the opening slice of the very move the system is trying to predict, so
   * showing it to the model contaminates the prediction no matter what the
   * prompt says it is for.
   */
  priceMoveSinceAnchorBps: number | null;
  /**
   * Signed move over the session BEFORE the story arrived (prior settled close
   * → anchor close). This is the feature `already_expected` actually needs — a
   * run-up in the news direction before arrival is what "leaked or widely
   * anticipated" looks like. Entirely pre-anchor, so it reveals nothing about
   * the outcome. Read by v3; null = unavailable (no bars).
   */
  priceRunUpBeforeAnchorBps?: number | null;
}

function lagLabel(lagFromFirstMs: number): string {
  if (lagFromFirstMs <= 0) return 'first report';
  const minutes = Math.round(lagFromFirstMs / 60_000);
  return minutes < 1 ? '<1 min after first' : `${minutes} min after first`;
}

function itemCodeLine(codes: string[]): string {
  const rendered = codes.map((code) => {
    const hint = EIGHT_K_ITEM_HINTS[code];
    return hint === undefined ? code : `${code} (hint: ${hint})`;
  });
  return rendered.join(', ');
}

/**
 * Instrument + cluster + items — byte-identical across prompt versions. Only
 * the PRICE CONTEXT section differs, so it is appended by each version's
 * builder rather than branched on here.
 */
function renderCommonSections(context: InterpretContext, limits: PromptSizeLimits): string[] {
  const { instrument, cluster } = context;
  const lines: string[] = [];

  lines.push('INSTRUMENT');
  lines.push(
    `${instrument.symbol} — ${instrument.name} (${instrument.assetClass}` +
      `${instrument.exchange !== null ? `, ${instrument.exchange}` : ''}` +
      `${instrument.sectorApprox !== null ? `, sector: ${instrument.sectorApprox}` : ''})`,
  );
  lines.push('');
  lines.push('STORY CLUSTER');
  lines.push(`Headline: ${cluster.canonicalHeadline}`);
  lines.push(
    `First received: ${cluster.firstReceivedAtIso} · ${cluster.itemCount} item(s) from ` +
      `${cluster.distinctSourceCount} source(s)`,
  );

  const items = context.items.slice(0, limits.maxItems);
  // Earliest item first (the caller orders by lag), so when the budget runs out
  // it is the late follow-up coverage that loses text, never the first report.
  let spent = 0;
  for (const [index, item] of items.entries()) {
    lines.push('');
    lines.push(`ITEM ${index + 1} [${item.sourceKey}, ${lagLabel(item.lagFromFirstMs)}]`);
    if (item.formType !== null) lines.push(`Filing: ${item.formType}`);
    if (item.itemCodes !== null && item.itemCodes.length > 0) {
      lines.push(`8-K items: ${itemCodeLine(item.itemCodes)}`);
    }
    lines.push(`Headline: ${item.headline}`);
    if (item.lede !== null && item.lede.length > 0) {
      const room = Math.min(limits.maxLedeChars, limits.maxTotalLedeChars - spent);
      if (room > 0) {
        const text = item.lede.slice(0, room);
        spent += text.length;
        lines.push(`Text: ${text}`);
      }
    }
  }

  return lines;
}

const CLOSING_LINE = 'Interpret this story for this instrument per the system instructions.';

/**
 * v1/v2 user prompt. Byte-frozen — replay of an existing row depends on this
 * producing exactly what it produced when the row was written.
 */
export function buildUserPrompt(context: InterpretContext): string {
  const lines = renderCommonSections(context, LIMITS_V1);
  lines.push('');
  lines.push('PRICE CONTEXT (for already_expected ONLY — never for direction)');
  lines.push(
    context.priceMoveSinceAnchorBps === null
      ? 'Move since story arrival: unavailable'
      : `Move since story arrival: ${Math.round(context.priceMoveSinceAnchorBps)} bps`,
  );
  lines.push('');
  lines.push(CLOSING_LINE);

  return lines.join('\n');
}

/**
 * v3 user prompt: pre-arrival move instead of post-arrival.
 *
 * The post-arrival number is not merely useless here, it is harmful — it is
 * the first minutes of the reaction being measured. v1/v2 told the model to use
 * it for `already_expected` ("a large move in the news direction before/at
 * arrival suggests the information was already out"), which the data could not
 * support: the anchor close sits AFTER any pre-arrival run-up, so the run-up
 * was invisible and the number shown was the reaction instead. v3 supplies
 * what that instruction always meant.
 */
export function buildUserPromptV3(context: InterpretContext): string {
  const lines = renderCommonSections(context, LIMITS_V3);
  lines.push('');
  lines.push('PRICE CONTEXT (pre-arrival only — for already_expected, never for direction)');
  const runUp = context.priceRunUpBeforeAnchorBps;
  lines.push(
    runUp === null || runUp === undefined
      ? 'Move over the session before arrival: unavailable'
      : `Move over the session before arrival: ${Math.round(runUp)} bps`,
  );
  lines.push('');
  lines.push(CLOSING_LINE);

  return lines.join('\n');
}
