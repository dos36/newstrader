/**
 * Pure entity-resolution matcher — milestone M1, architecture doc §5.2.
 *
 * resolveItem() maps one news item onto instruments using a prebuilt
 * dictionary (loaded by resolve-repo.ts). Deterministic, no I/O, no LLM.
 * Method precedence and confidence:
 *
 *   1. Filing items (EDGAR)       → cik_exact    1.0   and STOP. Filings
 *      resolve by CIK only — their summaries name counterparties, auditors,
 *      and acquirers constantly, so text-scanning EDGAR items is forbidden.
 *      An item counts as a filing when meta carries ANY of cik / itemCodes /
 *      formType: the EDGAR adapter always sets itemCodes, while cik depends on
 *      a title regex — gating on cik alone would let a filing with an
 *      unparseable title fall through to the text scan.
 *   2. symbolsHint ∩ tickers      → source_hint  0.95  (vendor-tagged, e.g. Massive tickers[])
 *   3. "NYSE: XYZ"-style prefix   → ticker_exact 0.9   (headline + body)
 *   4. "$XYZ" cashtags            → ticker_exact 0.85  (headline + body)
 *   5. alias scan, HEADLINE only  → alias_dict   0.7   (body prose is too noisy)
 *      crypto keywords (BTC/…)    → alias_dict   0.8
 *
 * False-positive guards (the reason this module exists):
 *   - Bare-token ticker matching is NOT a method. "AAPL rose 3%" resolves via
 *     symbolsHint or the $/exchange-prefix forms, never by scanning prose for
 *     ticker strings.
 *   - 1–2 char tickers (A, IT, V, …) collide with English words even in vendor
 *     hint arrays; they match ONLY via the exchange-prefix or cashtag forms.
 *   - Name aliases shorter than 4 chars, or on the generic-word stoplist
 *     ("Company", …), never scan-match. Real company names that double as
 *     common words ("Target", "Apple", "Oracle") are deliberately NOT
 *     stoplisted — they WILL false-positive on prose occasionally, which is
 *     exactly why alias_dict carries 0.7 confidence for downstream thresholds
 *     to discount.
 *   - Crypto ticker keywords (kind='ticker', crypto instruments) match
 *     case-SENSITIVELY ("BTC hits new high" yes, "btc"/"Sol" prose no); name
 *     aliases match case-insensitively on word boundaries.
 *   - Output dedupes to the single highest-confidence method per instrument.
 *
 * 'llm_ner' exists in the schema enum but is reserved for a later milestone;
 * the r1 resolver never emits it.
 */

/** Stamped on every item_instrument_links row this resolver writes. */
export const RESOLVER_VERSION = 'r1';

/** Methods the r1 resolver can emit — a subset of the schema's method enum. */
export type ResolutionMethod = 'cik_exact' | 'ticker_exact' | 'source_hint' | 'alias_dict';

export interface ResolvedLink {
  instrumentId: string;
  method: ResolutionMethod;
  confidence: number;
}

/** The slice of a raw news item the matcher reads. body is optional — the DB
 * row carries only the headline (bodies live in the raw store). */
export interface ResolvableItem {
  headline: string;
  body?: string;
  symbolsHint: string[];
  meta: Record<string, unknown>;
}

export type ScanAliasKind = 'name' | 'ticker';

/** One scannable dictionary entry. assetClass distinguishes crypto keyword
 * aliases (0.8) from equity name aliases (0.7); equity kind='ticker' entries
 * are ignored entirely (bare-token guard). */
export interface ScanAlias {
  alias: string;
  instrumentId: string;
  kind: ScanAliasKind;
  assetClass: 'us_equity' | 'crypto';
}

export interface ResolverDictionary {
  /** 10-digit zero-padded CIK → instrumentId. */
  byCik: ReadonlyMap<string, string>;
  /** Uppercase ticker symbol → instrumentId. */
  byTicker: ReadonlyMap<string, string>;
  /** Aliases scanned against the headline (never the body). */
  nameAliases: readonly ScanAlias[];
}

/** Per-method confidences, exported so tests and analytics share one source. */
export const CONFIDENCE = {
  cikExact: 1.0,
  sourceHint: 0.95,
  exchangePrefix: 0.9,
  cashtag: 0.85,
  cryptoKeyword: 0.8,
  nameAlias: 0.7,
} as const;

/** 1–2 char tickers only match via exchange-prefix or cashtag — even vendor
 * symbol hints skip them ("A", "IT" appear in hint arrays as noise too). */
const MIN_SOURCE_HINT_TICKER_LENGTH = 3;

/** Name aliases shorter than this are near-guaranteed prose collisions ("KO"). */
const MIN_NAME_ALIAS_LENGTH = 4;

/**
 * Generic alias tokens that must never scan-match. Small and deliberately
 * conservative: only words that are corporate boilerplate rather than a name
 * ("Company", "Holdings"). Real company names that double as common words
 * (Target, Apple, Oracle, Visa) are NOT listed — see module doc.
 */
export const GENERIC_ALIAS_STOPLIST: ReadonlySet<string> = new Set([
  'company',
  'corp',
  'corporation',
  'incorporated',
  'limited',
  'holdings',
  'group',
  'industries',
  'international',
  'enterprises',
  'technologies',
  'systems',
  'solutions',
  'partners',
  'brands',
  'the',
]);

/**
 * "NYSE American: ABC", "(Nasdaq: AAPL)", "NYSE: BRK.B". The multi-word
 * exchanges work despite "NYSE" appearing first in the alternation: when the
 * `:` fails to follow, the regex engine backtracks into "NYSE American"/"NYSE
 * Arca" at the same position.
 */
const EXCHANGE_PREFIX_RE =
  /\b(?:NYSE|NASDAQ|Nasdaq|NYSE American|NYSE Arca)\s*:\s*([A-Z]{1,6}(?:\.[A-Z])?)\b/g;

/** "$AAPL", "$IT", "$BRK.B" — the deliberate-tag form where 1–2 char tickers
 * are allowed. Cannot match dollar amounts: those start with a digit. */
const CASHTAG_RE = /\$([A-Z]{1,6}(?:\.[A-Z])?)\b/g;

/**
 * Resolve one item against the dictionary. Returns links sorted by confidence
 * (desc), then instrumentId (asc) for determinism; at most one link per
 * instrument (highest-confidence method wins).
 */
export function resolveItem(item: ResolvableItem, dict: ResolverDictionary): ResolvedLink[] {
  // EDGAR stop-rule: filings resolve by CIK or not at all. A malformed/unknown
  // CIK still stops; falling through to a text scan would link filings to
  // companies they merely mention. Gate on every marker the EDGAR adapter
  // sets (itemCodes is unconditional; cik depends on a title regex).
  if ('cik' in item.meta || 'itemCodes' in item.meta || 'formType' in item.meta) {
    const cik = normalizeCik(item.meta['cik']);
    if (cik === undefined) return [];
    const instrumentId = dict.byCik.get(cik);
    if (instrumentId === undefined) return [];
    return [{ instrumentId, method: 'cik_exact', confidence: CONFIDENCE.cikExact }];
  }

  const best = new Map<string, ResolvedLink>();
  const add = (instrumentId: string, method: ResolutionMethod, confidence: number): void => {
    const existing = best.get(instrumentId);
    if (existing === undefined || confidence > existing.confidence) {
      best.set(instrumentId, { instrumentId, method, confidence });
    }
  };

  // 2. Vendor symbol hints (structured tickers[], not prose) — 0.95.
  for (const hint of item.symbolsHint) {
    const symbol = hint.trim().toUpperCase();
    if (symbol.length < MIN_SOURCE_HINT_TICKER_LENGTH) continue;
    const instrumentId = dict.byTicker.get(symbol);
    if (instrumentId !== undefined) add(instrumentId, 'source_hint', CONFIDENCE.sourceHint);
  }

  const text = item.body === undefined ? item.headline : `${item.headline}\n${item.body}`;

  // 3. Exchange-prefix form — 0.9. The one channel where 1–2 char tickers match.
  for (const symbol of capturedGroups(EXCHANGE_PREFIX_RE, text)) {
    const instrumentId = dict.byTicker.get(symbol);
    if (instrumentId !== undefined) add(instrumentId, 'ticker_exact', CONFIDENCE.exchangePrefix);
  }

  // 4. Cashtags — 0.85. Also a deliberate tag, so 1–2 char tickers match.
  for (const symbol of capturedGroups(CASHTAG_RE, text)) {
    const instrumentId = dict.byTicker.get(symbol);
    if (instrumentId !== undefined) add(instrumentId, 'ticker_exact', CONFIDENCE.cashtag);
  }

  // 5. Alias scan — HEADLINE ONLY. Bodies mention competitors, indexes, and
  // half the S&P in passing; headlines name the subject.
  for (const entry of dict.nameAliases) {
    if (entry.kind === 'ticker') {
      // Bare-token guard: equity tickers are never scanned as words. Crypto
      // keywords (BTC/ETH/SOL) are the exception — matched case-sensitively.
      if (entry.assetClass !== 'crypto') continue;
      if (!matchesWord(item.headline, entry.alias, { caseSensitive: true })) continue;
      add(entry.instrumentId, 'alias_dict', CONFIDENCE.cryptoKeyword);
      continue;
    }
    const alias = entry.alias.trim();
    // Short pure-letter aliases ("KO") are prose collisions and never scan;
    // short digit-bearing names ("3M") are real but match case-SENSITIVELY so
    // "3m tall" prose cannot hit them.
    const isShort = alias.length < MIN_NAME_ALIAS_LENGTH;
    if (isShort && !/\d/.test(alias)) continue;
    if (GENERIC_ALIAS_STOPLIST.has(alias.toLowerCase())) continue;
    if (!matchesWord(item.headline, alias, { caseSensitive: isShort })) continue;
    const confidence =
      entry.assetClass === 'crypto' ? CONFIDENCE.cryptoKeyword : CONFIDENCE.nameAlias;
    add(entry.instrumentId, 'alias_dict', confidence);
  }

  return [...best.values()].sort(
    (a, b) => b.confidence - a.confidence || a.instrumentId.localeCompare(b.instrumentId),
  );
}

/**
 * Normalize a CIK (string or number, as EDGAR meta and instruments.cik vary)
 * to the canonical 10-digit zero-padded form; undefined when unusable.
 */
export function normalizeCik(value: unknown): string | undefined {
  let raw: string;
  if (typeof value === 'number') {
    if (!Number.isInteger(value) || value < 0) return undefined;
    raw = String(value);
  } else if (typeof value === 'string') {
    raw = value.trim();
  } else {
    return undefined;
  }
  if (!/^\d{1,10}$/.test(raw)) return undefined;
  return raw.padStart(10, '0');
}

/** All first capture groups of a /g regex. matchAll clones the regex, so the
 * shared module-level RegExp objects keep no lastIndex state between items. */
function capturedGroups(re: RegExp, text: string): string[] {
  const out: string[] = [];
  for (const match of text.matchAll(re)) {
    const group = match[1];
    if (group !== undefined) out.push(group);
  }
  return out;
}

/**
 * Word-boundary containment test ("Target" matches, "Targeting" does not).
 * Lookarounds instead of \b: \b after a non-word char never asserts, which
 * silently killed every alias ending in punctuation ("Apple Inc.",
 * "Alphabet Inc. (Class A)") against headlines that contain them verbatim.
 */
function matchesWord(text: string, word: string, options: { caseSensitive: boolean }): boolean {
  const re = new RegExp(
    `(?<![\\p{L}\\p{N}_])${escapeRegExp(word)}(?![\\p{L}\\p{N}_])`,
    options.caseSensitive ? 'u' : 'iu',
  );
  return re.test(text);
}

function escapeRegExp(text: string): string {
  return text.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}
