import { z } from 'zod';

import { defaultFetch, type FetchLike } from './http.js';
import { stripHtml } from '../llm/lede.js';

/**
 * SEC EDGAR filing-document fetcher — the interpreter's missing article text.
 *
 * WHY THIS EXISTS (measured 2026-08-21): an EDGAR item's stored payload is the
 * `getcurrent` Atom entry, whose `summary` is filing METADATA — "Filed:
 * 2026-08-21 AccNo: … Size: 11 KB". Median extracted lede across 576 sampled
 * EDGAR items: 57 characters. So the highest-signal source in the pipeline
 * (8-K filings, 12% of candidate pairs) reached the model as a form type and a
 * list of item codes, with no statement of what actually happened. Massive
 * articles carry 456 chars, RSS 167. No prompt-size cap was ever the binding
 * constraint; this was.
 *
 * WHAT IT FETCHES: two requests per filing. First `index.json` for the filing's
 * archive directory (small, structured, and a deterministic URL derived from
 * the index link already stored on the item). Then each content document.
 *
 * It deliberately keeps the EXHIBITS as well as the primary document. For an
 * Item 2.02 earnings 8-K the primary document is often three sentences that say
 * "see Exhibit 99.1", and Exhibit 99.1 is the press release with the numbers.
 * Selecting only a "primary" document would systematically discard the content.
 *
 * SEC fair access: every request carries the EDGAR_USER_AGENT contact string
 * (requests without one are 403'd), and the sweep paces itself well under the
 * 10 req/s ceiling.
 */

/** Directory listing shape — narrow on purpose; unknown keys are ignored. */
const DirectorySchema = z.object({
  directory: z.object({
    item: z.array(z.object({ name: z.string() }).passthrough()),
  }),
});

/**
 * Hard caps: the prompt pays for these tokens, and exhibits can be long.
 *
 * 40k chars is roughly 10k input tokens — about $0.03 per call at sonnet-5
 * rates. Sized from measurement, not taste: at a 20k total, 4 of the first 5
 * real filings truncated, which means a cap that low was discarding filing
 * content to make room for cover-page boilerplate.
 */
/**
 * Character budget per filing. Both caps doubled 2026-08-22 after measurement:
 * 5,011 of 9,259 stored filings (54%) came back flagged truncated, and the mean
 * stored length landed at 20,058 — i.e. the PER-DOCUMENT cap was binding on the
 * primary 8-K document, cutting press-release exhibits off mid-way.
 *
 * The two caps move together. Raising only MAX_DOC_CHARS would let one long
 * filing document eat the entire total budget and starve the EX-99.1 press
 * release, which is often the most informative part of the filing.
 *
 * Cost of the increase: ~10k input tokens per call worst case becomes ~20k,
 * about $0.06 instead of $0.03 at sonnet-5 input pricing. Filing text sits
 * after the cached system prefix, so none of it is cache-discounted.
 */
/**
 * Bumped whenever the caps above or the extraction logic change, so already-
 * stored filings can be identified as stale and re-fetched ONCE. Same discipline
 * as RESOLVER_VERSION / MEASURER_VERSION: a change that alters recorded output
 * gets a version, or old and new rows silently mix.
 *
 *   1 — 20k per document / 40k total
 *   2 — 40k per document / 80k total (2026-08-22)
 *
 * Scoping a refetch on "truncated" instead of this cannot converge: a filing
 * longer than the new cap comes back truncated again and re-queues forever.
 */
export const EDGAR_FETCHER_VERSION = 2;

export const MAX_DOC_CHARS = 40_000;
export const MAX_TOTAL_CHARS = 80_000;
/** Content docs per filing. Beyond this it is boilerplate and XBRL noise. */
const MAX_DOCS = 4;

/**
 * Reject list, from the two real 8-K directories used to build this (Peraso
 * ea0303091-8k_peraso.htm + Vvos form8-k.htm/ex99-1.htm):
 *   *-index.htm / *-index-headers.html  the index pages themselves
 *   R<n>.htm                            rendered XBRL viewer reports (~40 KB
 *                                       of financial-statement tables each)
 * Everything non-.htm (xsd, _lab.xml, _pre.xml, MetaLinks.json, report.css,
 * Show.js, xbrl.zip, the full-submission .txt) is dropped by the extension
 * filter. The .txt full submission is skipped on purpose: it repeats every
 * document in the directory, including the ones rejected here.
 */
const INDEX_RE = /-index(-headers)?\.html?$/i;
const XBRL_REPORT_RE = /^R\d+\.html?$/i;
const HTML_RE = /\.html?$/i;
/** Primary 8-K documents are named form8-k.htm, ea…-8k_issuer.htm, etc. */
const PRIMARY_RE = /8-?k/i;

/** `…/0001213900-26-092719-index.htm` → `…/` (the archive directory). */
export function filingDirectoryUrl(indexUrl: string): string {
  const cut = indexUrl.lastIndexOf('/');
  if (cut === -1) throw new Error(`Not a filing index URL: ${indexUrl}`);
  return indexUrl.slice(0, cut + 1);
}

/**
 * Content documents, primary first. Pure — the ordering and the reject list are
 * the whole risk surface here, so they are unit-tested against real listings.
 */
export function selectFilingDocuments(names: string[]): string[] {
  const content = names.filter(
    (name) => HTML_RE.test(name) && !INDEX_RE.test(name) && !XBRL_REPORT_RE.test(name),
  );
  const primary = content.filter((name) => PRIMARY_RE.test(name));
  const rest = content.filter((name) => !PRIMARY_RE.test(name));
  return [...primary, ...rest].slice(0, MAX_DOCS);
}

export interface FilingDocument {
  name: string;
  text: string;
}

export interface FilingText {
  /** Prompt-ready text, documents joined with a name header each. */
  text: string;
  documents: FilingDocument[];
  /** True when a per-document or total cap trimmed something. */
  truncated: boolean;
}

export interface FetchFilingTextOptions {
  fetchImpl?: FetchLike;
  userAgent: string;
  /** Pause between requests to the same host (SEC allows 10 req/s). */
  requestDelayMs?: number;
  sleep?: (ms: number) => Promise<void>;
}

const DEFAULT_REQUEST_DELAY_MS = 150;

const defaultSleep = (ms: number): Promise<void> =>
  new Promise((resolve) => setTimeout(resolve, ms));

/**
 * Fetch and flatten one filing's documents.
 *
 * Throws on transport/format problems (non-2xx, listing drift) — the sweep
 * treats a throw as "record an attempt and move on", so a single bad filing
 * never stops a pass. Returns an empty `documents` array when the listing has
 * no content documents at all, which is a permanent outcome, not an error.
 */
export async function fetchFilingText(
  indexUrl: string,
  options: FetchFilingTextOptions,
): Promise<FilingText> {
  const fetchImpl = options.fetchImpl ?? defaultFetch;
  const sleep = options.sleep ?? defaultSleep;
  const delayMs = options.requestDelayMs ?? DEFAULT_REQUEST_DELAY_MS;
  const headers = { 'User-Agent': options.userAgent, Accept: 'application/json, text/html' };
  const dir = filingDirectoryUrl(indexUrl);

  const listingRes = await fetchImpl(`${dir}index.json`, { headers });
  if (!listingRes.ok) {
    throw new Error(`GET ${dir}index.json failed: ${listingRes.status} ${listingRes.statusText}`);
  }
  const listing = DirectorySchema.safeParse(await listingRes.json());
  if (!listing.success) {
    throw new Error(`EDGAR directory listing drifted: ${listing.error.message.slice(0, 200)}`);
  }

  const names = selectFilingDocuments(listing.data.directory.item.map((entry) => entry.name));
  const documents: FilingDocument[] = [];
  let truncated = false;
  let total = 0;

  for (const name of names) {
    if (total >= MAX_TOTAL_CHARS) {
      truncated = true;
      break;
    }
    await sleep(delayMs);
    const res = await fetchImpl(`${dir}${name}`, { headers });
    if (!res.ok) {
      throw new Error(`GET ${dir}${name} failed: ${res.status} ${res.statusText}`);
    }
    const cleaned = stripHtml(await res.text());
    if (cleaned.length === 0) continue;
    if (cleaned.length > MAX_DOC_CHARS) truncated = true;
    const room = Math.min(MAX_DOC_CHARS, MAX_TOTAL_CHARS - total);
    const text = cleaned.slice(0, room);
    if (text.length < cleaned.length) truncated = true;
    documents.push({ name, text });
    total += text.length;
  }

  return {
    text: documents.map((doc) => `[${doc.name}]\n${doc.text}`).join('\n\n'),
    documents,
    truncated,
  };
}
