/**
 * Lede extraction from raw-store payloads — the interpreter's article text.
 *
 * The DB stores headlines only (by design); the body-ish text lives inside
 * each item's raw payload (`raw_news_items.payload_ref`), whose shape is
 * whatever the source's adapter captured verbatim:
 *   - sec_edgar: Atom entry; `summary` is html, usually `{ "#text": "..." }`
 *   - newsapi (Massive): flat article; `description` is plain text
 *   - rss: item; `description` (sometimes `summary`) is an html string or
 *     `{ "#text": "..." }` depending on attributes
 *
 * DELIBERATELY TOLERANT, unlike the ingest parsers: a lede is an optional
 * enrichment — headline-only interpretation is a legitimate documented mode —
 * so a shape miss returns null instead of throwing. Throwing here would turn
 * a cosmetic drift into an interpretation poison pill.
 */

const MAX_LEDE_CHARS = 1200;

/** Unwrap fast-xml-parser's `{ "#text": ... }` shape or accept a plain string. */
function textish(value: unknown): string | null {
  if (typeof value === 'string') return value;
  if (typeof value === 'object' && value !== null && '#text' in value) {
    const inner = (value as Record<string, unknown>)['#text'];
    if (typeof inner === 'string') return inner;
  }
  return null;
}

/**
 * Minimal tag stripper + entity decode for feed html (not a sanitizer). Shared
 * with the EDGAR filing-document fetcher, which runs real filing HTML through
 * it — hence the script/style drop, which feed ledes never needed.
 */
export function stripHtml(html: string): string {
  return (
    html
      .replace(/<!--[\s\S]*?-->/g, ' ')
      .replace(/<(script|style)\b[^>]*>[\s\S]*?<\/\1>/gi, ' ')
      // Inline-XBRL hidden facts. Measured on a real Accenture 8-K: without
      // this the document OPENS with "8-K 2 false 0001467373 0001467373
      // 2026-07-10 … iso4217:USD xbrli:shares" — machine-readable tagging that
      // says nothing a reader needs and eats the character budget first.
      .replace(/<ix:header\b[^>]*>[\s\S]*?<\/ix:header>/gi, ' ')
      .replace(/<ix:hidden\b[^>]*>[\s\S]*?<\/ix:hidden>/gi, ' ')
      .replace(/<[^>]*>/g, ' ')
      .replace(/&amp;/g, '&')
      .replace(/&lt;/g, '<')
      .replace(/&gt;/g, '>')
      .replace(/&quot;/g, '"')
      .replace(/&nbsp;/g, ' ')
      // Numeric entities, decimal and hex. Filings are full of &#160; and
      // &#8217; — left encoded they read as noise and cost tokens.
      .replace(/&#x([0-9a-f]+);/gi, (_, hex: string) =>
        String.fromCodePoint(Number.parseInt(hex, 16)),
      )
      .replace(/&#(\d+);/g, (_, dec: string) => String.fromCodePoint(Number.parseInt(dec, 10)))
      // Non-breaking space and friends become plain spaces for the collapse below.
      .replace(/[\u00a0\u2007\u202f]/g, ' ')
      .replace(/\s+/g, ' ')
      .trim()
  );
}

function field(payload: unknown, key: string): unknown {
  if (typeof payload !== 'object' || payload === null) return undefined;
  return (payload as Record<string, unknown>)[key];
}

/**
 * Extract a prompt-ready lede for one item, keyed on news_sources.kind.
 * Returns null when the payload has no usable text (headline-only mode).
 */
export function extractLede(sourceKind: string, payload: unknown): string | null {
  let raw: string | null = null;
  switch (sourceKind) {
    case 'sec_edgar':
      raw = textish(field(payload, 'summary'));
      break;
    case 'newsapi':
      raw = textish(field(payload, 'description'));
      break;
    case 'rss':
      raw = textish(field(payload, 'description')) ?? textish(field(payload, 'summary'));
      break;
    default:
      return null;
  }
  if (raw === null) return null;
  const cleaned = stripHtml(raw);
  if (cleaned.length === 0) return null;
  return cleaned.slice(0, MAX_LEDE_CHARS);
}
