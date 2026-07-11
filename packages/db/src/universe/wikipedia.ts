import { z } from 'zod';

import { defaultFetch, fetchText, type FetchLike } from './http.js';

/**
 * Wikipedia S&P 500 constituents parser.
 *
 * Source: https://en.wikipedia.org/wiki/List_of_S%26P_500_companies — the
 * FIRST wikitable on the page (id="constituents", verified live 2026-07-10:
 * header columns Symbol / Security / GICS Sector / GICS Sub-Industry /
 * Headquarters Location / Date added / CIK / Founded, 503 data rows).
 *
 * Parsing is regex/string slicing over the table markup — no HTML-parser
 * dependency. That is safe here because the parser is DEFENSIVE, not lenient:
 * any structural surprise (no wikitable, missing required column, a row with
 * too few cells, a malformed symbol/CIK, or a row count outside
 * [MIN_EXPECTED_ROWS, MAX_EXPECTED_ROWS]) throws a descriptive error instead
 * of producing a partial universe. Silent format drift corrupting
 * index_membership is the failure mode this guards against.
 *
 * Symbol convention: Wikipedia's dot form is kept verbatim (BRK.B, BF.B).
 * SEC's company_tickers.json uses the dash form (BRK-B) — the CIK join in
 * sec-tickers.ts normalizes dots to dashes at lookup time.
 */

export const SP500_WIKIPEDIA_URL = 'https://en.wikipedia.org/wiki/List_of_S%26P_500_companies';

/**
 * Sanity bounds on parsed data rows. The S&P 500 has ~503 constituents
 * (multi-class listings); a count outside this band means the page format
 * drifted or the fetch was truncated — never silently accept it.
 */
export const MIN_EXPECTED_ROWS = 400;
export const MAX_EXPECTED_ROWS = 600;

/** Ticker symbols as Wikipedia prints them: uppercase, digits, dots, dashes. */
const SYMBOL_RE = /^[A-Z][A-Z0-9.-]{0,9}$/;

export const Sp500Row = z.object({
  /** Wikipedia's dot form, verbatim (BRK.B). */
  symbol: z.string().regex(SYMBOL_RE),
  /** "Security" column — the short company name ("Alphabet Inc. (Class A)"). */
  security: z.string().min(1),
  /** GICS Sector approximation (architecture §3: official GICS is licensed). */
  sector: z.string().min(1),
  subIndustry: z.string().min(1),
  /** Zero-padded 10-digit CIK. */
  cik: z.string().regex(/^\d{10}$/),
});
export type Sp500Row = z.infer<typeof Sp500Row>;

export interface ParseSp500Options {
  /** Row-count sanity bounds; override only in fixture tests. */
  minRows?: number;
  maxRows?: number;
}

/** Columns the parser requires; anything else (HQ, dates, Founded) is ignored. */
const REQUIRED_COLUMNS = {
  symbol: 'symbol',
  security: 'security',
  sector: 'gics sector',
  subIndustry: 'gics sub-industry',
  cik: 'cik',
} as const;

/**
 * Parse the FIRST wikitable in the page HTML into S&P 500 rows.
 * Throws (never returns partial data) on any structural drift — see module doc.
 */
export function parseSp500Wikitable(html: string, options?: ParseSp500Options): Sp500Row[] {
  const minRows = options?.minRows ?? MIN_EXPECTED_ROWS;
  const maxRows = options?.maxRows ?? MAX_EXPECTED_ROWS;

  const table = firstWikitable(html);
  const rowChunks = table.split(/<tr\b[^>]*>/).slice(1);
  if (rowChunks.length === 0) {
    throw new Error('S&P 500 wikitable parse failed: first wikitable contains no <tr> rows');
  }

  const columns = headerColumns(rowChunks[0] ?? '');

  const rows: Sp500Row[] = [];
  for (const chunk of rowChunks.slice(1)) {
    const cells = cellTexts(chunk, 'td');
    if (cells.length === 0) continue; // header-only chunk (nested <th> rows)
    const maxIndex = Math.max(...Object.values(columns));
    if (cells.length <= maxIndex) {
      throw new Error(
        `S&P 500 wikitable parse failed: row has ${cells.length} cells, ` +
          `need index ${maxIndex} — format drift? Row starts: ${chunk.slice(0, 120)}`,
      );
    }
    const rawCik = cells[columns.cik] ?? '';
    if (!/^\d{1,10}$/.test(rawCik)) {
      throw new Error(`S&P 500 wikitable parse failed: CIK cell is not numeric: "${rawCik}"`);
    }
    rows.push(
      Sp500Row.parse({
        symbol: cells[columns.symbol],
        security: cells[columns.security],
        sector: cells[columns.sector],
        subIndustry: cells[columns.subIndustry],
        cik: rawCik.padStart(10, '0'),
      }),
    );
  }

  if (rows.length < minRows || rows.length > maxRows) {
    throw new Error(
      `S&P 500 wikitable parse failed: parsed ${rows.length} rows, expected ` +
        `${minRows}–${maxRows}. Page format drift or truncated fetch — refusing ` +
        'to sync a partial universe.',
    );
  }

  // Duplicate symbols would produce duplicate membership inserts downstream
  // (PK violation mid-transaction) — refuse here with a better message.
  const seen = new Set<string>();
  for (const parsedRow of rows) {
    if (seen.has(parsedRow.symbol)) {
      throw new Error(
        `S&P 500 wikitable parse failed: duplicate symbol ${parsedRow.symbol} — format drift?`,
      );
    }
    seen.add(parsedRow.symbol);
  }
  return rows;
}

export interface FetchSp500Options {
  /** Descriptive User-Agent (Wikipedia etiquette); sent when provided. */
  userAgent?: string | undefined;
  fetchImpl?: FetchLike;
}

/** Fetch the live page and parse it (production bounds always apply). */
export async function fetchSp500FromWikipedia(options?: FetchSp500Options): Promise<Sp500Row[]> {
  const fetchImpl = options?.fetchImpl ?? defaultFetch;
  const userAgent = options?.userAgent?.trim();
  const html = await fetchText(fetchImpl, SP500_WIKIPEDIA_URL, {
    headers: {
      Accept: 'text/html',
      ...(userAgent !== undefined && userAgent.length > 0 ? { 'User-Agent': userAgent } : {}),
    },
  });
  return parseSp500Wikitable(html);
}

// ---------------------------------------------------------------- internals --

/**
 * Slice out the first `<table>` whose class attribute contains "wikitable".
 * Matching on the tag's class attribute (not a bare substring search) matters:
 * the live page's inline CSS mentions ".wikitable" long before the table.
 */
function firstWikitable(html: string): string {
  for (const match of html.matchAll(/<table\b[^>]*>/g)) {
    const classAttr = /class\s*=\s*"([^"]*)"/.exec(match[0])?.[1] ?? '';
    if (!classAttr.split(/\s+/).includes('wikitable')) continue;
    const start = match.index;
    const end = html.indexOf('</table>', start);
    if (end === -1) {
      throw new Error('S&P 500 wikitable parse failed: wikitable has no closing </table>');
    }
    return html.slice(start, end);
  }
  throw new Error('S&P 500 wikitable parse failed: no <table class="…wikitable…"> in page HTML');
}

/** Map required column names (matched case-insensitively) to header cell indexes. */
function headerColumns(headerChunk: string): Record<keyof typeof REQUIRED_COLUMNS, number> {
  const headers = cellTexts(headerChunk, 'th').map((h) => h.toLowerCase());
  const lookup = (label: string): number => {
    const index = headers.indexOf(label);
    if (index === -1) {
      throw new Error(
        `S&P 500 wikitable parse failed: header column "${label}" not found in ` +
          `[${headers.join(', ')}] — page format drift.`,
      );
    }
    return index;
  };
  return {
    symbol: lookup(REQUIRED_COLUMNS.symbol),
    security: lookup(REQUIRED_COLUMNS.security),
    sector: lookup(REQUIRED_COLUMNS.sector),
    subIndustry: lookup(REQUIRED_COLUMNS.subIndustry),
    cik: lookup(REQUIRED_COLUMNS.cik),
  };
}

/** Extract cleaned text of every `<td>`/`<th>` cell in one row chunk. */
function cellTexts(rowChunk: string, tag: 'td' | 'th'): string[] {
  const re = new RegExp(`<${tag}\\b[^>]*>([\\s\\S]*?)</${tag}>`, 'g');
  return [...rowChunk.matchAll(re)].map((m) => cleanCell(m[1] ?? ''));
}

/** Strip comments/tags, decode common entities, collapse whitespace. */
function cleanCell(cellHtml: string): string {
  const text = cellHtml
    .replace(/<!--[\s\S]*?-->/g, '')
    // Footnote refs (<sup><a>[4]</a></sup>) are removed WITH their inner text —
    // plain tag-stripping would leave "[4]" glued onto a company name/alias.
    .replace(/<sup\b[^>]*>[\s\S]*?<\/sup>/g, '')
    .replace(/<[^>]+>/g, '')
    .replace(/&#x([0-9a-fA-F]+);/g, (_, hex: string) => String.fromCodePoint(parseInt(hex, 16)))
    .replace(/&#(\d+);/g, (_, dec: string) => String.fromCodePoint(Number(dec)))
    .replace(/&amp;/g, '&')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/&nbsp;/g, ' ');
  return text.replace(/\s+/g, ' ').trim();
}
