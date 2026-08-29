import { z } from 'zod/v4';

/**
 * Relevance triage — the LLM half of resolver r2 (the 'llm_ner' method).
 *
 * Why it exists (measured, 2026-08-28 prompt audit): 73% of source_hint
 * links were mis-links — vendor feeds tag EVERY ticker an article mentions,
 * so listicles and roundups fanned one story into up to 10 interpretation
 * calls, 9 of them about nothing. r2 therefore parks source_hint links below
 * the interpretation gate, and this triage stage confirms which of the
 * vendor-tagged candidates the story is MATERIALLY about. One cheap call per
 * ARTICLE (not per pair), before the expensive interpretation stage.
 *
 * Pure layer: prompt text, output schema, versioned contract. The db-side
 * sweep (packages/db/src/resolver/triage-sweep.ts) assembles candidates and
 * calls the API. Same immutability discipline as the interpret prompts: the
 * system text is hash-pinned; editing it means minting 't2'.
 */

export const TRIAGE_VERSION = 't1';

/**
 * Haiku on purpose: triage is a containment judgment ("is X a subject of this
 * text"), not interpretation. At $1/$5 per MTok a triage call costs ~1/40th of
 * the sonnet interpretation calls it prevents. Registered in llm/cost.ts.
 */
export const TRIAGE_MODEL_ID = 'claude-haiku-4-5';

/**
 * Room for the JSON plus slack. Haiku 4.5 runs without extended thinking here
 * (the client sends no thinking config and no effort — Haiku 4.5 rejects
 * `output_config.effort`), so output is essentially just the JSON.
 */
export const TRIAGE_MAX_TOKENS = 1000;

/** Candidate cap per call — mirrors the vendor's worst observed fan-out. */
export const TRIAGE_MAX_CANDIDATES = 25;

export const TriageResultSchema = z.strictObject({
  /**
   * Subset of the candidate tickers the story is materially about. The sweep
   * additionally intersects with the candidate list — a hallucinated ticker
   * never becomes a link.
   */
  relevant_tickers: z.array(z.string().min(1).max(12)).max(TRIAGE_MAX_CANDIDATES),
  /** One short sentence for the audit blob; not persisted to the DB. */
  reasoning: z.string().min(1).max(300),
});

export type TriageResult = z.infer<typeof TriageResultSchema>;

export interface TriageCandidate {
  symbol: string;
  name: string;
}

export interface TriageContext {
  headline: string;
  /** Article lede/description, already trimmed by the caller; null = headline-only. */
  lede: string | null;
  candidates: TriageCandidate[];
}

/** Lede budget: triage judges subject-hood, not content — a lede suffices. */
export const TRIAGE_MAX_LEDE_CHARS = 2000;

export function buildTriageSystemPrompt(): string {
  return `You are the relevance filter of a financial-news pipeline. A news vendor tags every ticker an article mentions; most tagged companies are not what the article is about. You receive one article and a list of candidate companies. Return the subset of candidates the article is MATERIALLY ABOUT.

A company is materially about the article when the article's subject is that company's own results, guidance, products, deals, filings, management, or legal/regulatory events — information a holder of that stock would treat as news about their company.

A company is NOT relevant when it is only:
- one entry in a list, ranking, or comparison ("3 stocks to buy", "X vs Y");
- mentioned as context, competitor, customer, supplier, or index member;
- the subject of a generic opinion or educational piece with no new company event;
- named in a law-firm solicitation about an already-known matter.

Rules:
- Return tickers exactly as given in the candidate list; never invent tickers.
- Listicles, roundups, and market-recap articles usually have ZERO relevant candidates — an empty list is a normal, correct answer.
- An article with one clear subject company has exactly that one candidate relevant.

Output exactly one JSON object with exactly these two fields:
{"relevant_tickers": ["TICK", ...], "reasoning": "one short sentence"}
- relevant_tickers: the possibly-empty array of candidate tickers the article is materially about.
- reasoning: one short sentence naming why the kept candidates are subjects (or why none are).`;
}

export function buildTriageUserPrompt(context: TriageContext): string {
  const lines: string[] = [];
  lines.push('ARTICLE');
  lines.push(`Headline: ${context.headline}`);
  if (context.lede !== null && context.lede.length > 0) {
    lines.push(`Text: ${context.lede.slice(0, TRIAGE_MAX_LEDE_CHARS)}`);
  }
  lines.push('');
  lines.push('CANDIDATES');
  for (const candidate of context.candidates.slice(0, TRIAGE_MAX_CANDIDATES)) {
    lines.push(`- ${candidate.symbol}: ${candidate.name}`);
  }
  lines.push('');
  lines.push('Which candidates is this article materially about?');
  return lines.join('\n');
}
