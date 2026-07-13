import type { FetchedItem, FetchResult, SourceAdapter } from '@newstrader/core';
import { z } from 'zod';

import { defaultFetch, fetchText, type FetchLike } from './http.js';
import { isRecord, linkHref, parseXml, stripHtml, textOf, toIsoDate } from './xml.js';

/**
 * SEC EDGAR `getcurrent` Atom feed adapter — one instance per form type.
 *
 * SEC fair-access rules (verified live: requests without a contact User-Agent
 * are 403'd): every request sends `EDGAR_USER_AGENT` ("Name email@example.com")
 * and the adapter refuses to construct without it. Each fetchSince() issues
 * exactly ONE request; the registry consumer polls adapters sequentially, so
 * total request rate stays far below the 10 req/s ceiling.
 *
 * Cursor = accession number of the newest entry previously seen. The feed is
 * newest-first; parsing stops at the cursor. If the cursor is not on the first
 * page (>count filings since the last poll — Form 4 bursts after the 4pm ET
 * close do this), fetchSince pages deeper via `&start=` until the cursor is
 * found, the feed is exhausted, or `maxPages` is hit; the latter two log a
 * structured warning so overflow is measured, never silent.
 */

export const EDGAR_FORM_TYPES = ['8-K', '4', 'SC 13D', 'SC 13G'] as const;
export type EdgarFormType = (typeof EDGAR_FORM_TYPES)[number];

const SOURCE_KEY_BY_FORM: Record<EdgarFormType, string> = {
  '8-K': 'edgar_8k',
  '4': 'edgar_form4',
  'SC 13D': 'edgar_13d',
  'SC 13G': 'edgar_13g',
};

/** Accession number as it appears in entry ids: urn:tag:sec.gov,2008:accession-number=… */
const ACCESSION_RE = /accession-number=(\d{10}-\d{2}-\d{6})/;
const ACCESSION_ANY_RE = /(\d{10}-\d{2}-\d{6})/;
/** CIK as it appears in entry titles: "8-K - Acme Corp (0001645460) (Filer)". */
const TITLE_CIK_RE = /\((\d{5,10})\)/;
/** 8-K item codes as they appear in entry summaries: "Item 2.02: Results of…". */
const ITEM_CODE_RE = /\bItem\s+(\d{1,2}\.\d{1,2})\b/g;

const EdgarFeed = z.object({
  feed: z.object({ entry: z.array(z.unknown()).optional() }).passthrough(),
});

export interface EdgarAdapterOptions {
  formType: EdgarFormType;
  /** Value of env EDGAR_USER_AGENT. Mandatory — SEC 403s anonymous clients. */
  userAgent: string | undefined;
  baseUrl?: string;
  count?: number;
  /** Safety cap on `&start=` pages fetched per poll when chasing the cursor. Default 5. */
  maxPages?: number;
  fetchImpl?: FetchLike;
}

export class EdgarAdapter implements SourceAdapter {
  readonly kind = 'sec_edgar' as const;
  readonly sourceKey: string;
  readonly formType: EdgarFormType;

  private readonly userAgent: string;
  private readonly baseUrl: string;
  private readonly count: number;
  private readonly maxPages: number;
  private readonly fetchImpl: FetchLike;

  constructor(options: EdgarAdapterOptions) {
    const userAgent = options.userAgent?.trim();
    if (userAgent === undefined || userAgent.length === 0) {
      throw new Error(
        'EDGAR_USER_AGENT is not set. SEC fair-access rules require a User-Agent with ' +
          'contact info ("Name email@example.com"); anonymous requests are rejected with 403.',
      );
    }
    this.formType = options.formType;
    this.sourceKey = SOURCE_KEY_BY_FORM[options.formType];
    this.userAgent = userAgent;
    this.baseUrl = options.baseUrl ?? 'https://www.sec.gov';
    this.count = options.count ?? 100;
    this.maxPages = options.maxPages ?? 5;
    this.fetchImpl = options.fetchImpl ?? defaultFetch;
  }

  async fetchSince(cursor: string | null): Promise<FetchResult> {
    const collected: FetchedItem[] = [];
    const seen = new Set<string>();
    let newestAccession: string | null = null;
    let cursorFound = false;
    let feedExhausted = false;
    let pages = 0;

    // Page deeper only while chasing a known cursor; a null cursor is the
    // baseline poll — one page establishes the watermark.
    const pageBudget = cursor === null ? 1 : this.maxPages;
    let entriesSeen = 0;
    while (pages < pageBudget) {
      const xml = await fetchText(this.fetchImpl, this.pageUrl(pages * this.count), {
        headers: {
          'User-Agent': this.userAgent,
          Accept: 'application/atom+xml',
        },
      });
      const page = this.parsePage(xml, cursor);
      pages += 1;
      entriesSeen += page.entryCount;
      if (newestAccession === null) newestAccession = page.newestAccession;
      for (const item of page.itemsNewestFirst) {
        // Entries can shift between page fetches when new filings land mid-poll.
        if (seen.has(item.externalId)) continue;
        seen.add(item.externalId);
        collected.push(item);
      }
      if (page.cursorFound) {
        cursorFound = true;
        break;
      }
      if (page.entryCount < this.count) {
        feedExhausted = true;
        break;
      }
    }

    // An EMPTY feed proves nothing was missed — getcurrent cannot scroll past
    // filings it never showed. Quiet weekends empty the low-volume form feeds
    // (13D/13G) for days, and warning every poll cycle trained operators to
    // ignore the log line that matters on busy days.
    if (cursor !== null && !cursorFound && entriesSeen > 0) {
      // Not necessarily data loss (a stale cursor ages out of getcurrent after
      // quiet weekends), but at a 1-min cadence it usually means >maxPages*count
      // filings since last poll. Logged so M0 measures overflow instead of
      // assuming it away.
      console.warn(
        JSON.stringify({
          level: 'warn',
          msg: 'edgar_cursor_not_found',
          sourceKey: this.sourceKey,
          reason: feedExhausted ? 'feed_exhausted' : 'page_cap',
          pages,
          entriesSeen,
        }),
      );
    }

    // Emit oldest-first so downstream ingestion is chronological.
    collected.reverse();
    return { items: collected, nextCursor: newestAccession ?? cursor };
  }

  /** Single-page parse preserving the historical signature, used by fixture tests. */
  parseFeed(xml: string, cursor: string | null): FetchResult {
    const page = this.parsePage(xml, cursor);
    const items = [...page.itemsNewestFirst].reverse();
    return { items, nextCursor: page.newestAccession ?? cursor };
  }

  private pageUrl(start: number): string {
    return (
      `${this.baseUrl}/cgi-bin/browse-edgar?action=getcurrent` +
      `&type=${encodeURIComponent(this.formType)}&output=atom&count=${this.count}` +
      (start > 0 ? `&start=${start}` : '')
    );
  }

  /** Pure parse of one feed page. Entries arrive newest-first; stops at the cursor. */
  private parsePage(
    xml: string,
    cursor: string | null,
  ): {
    itemsNewestFirst: FetchedItem[];
    newestAccession: string | null;
    cursorFound: boolean;
    entryCount: number;
  } {
    const feed = EdgarFeed.parse(parseXml(xml));
    const entries = feed.feed.entry ?? [];

    const itemsNewestFirst: FetchedItem[] = [];
    let newestAccession: string | null = null;
    let cursorFound = false;
    for (const entry of entries) {
      const parsed = parseEntry(entry);
      if (parsed === undefined) continue;
      newestAccession ??= parsed.externalId;
      // The cursor is the newest accession of the previous poll: stop there.
      if (cursor !== null && parsed.externalId === cursor) {
        cursorFound = true;
        break;
      }
      itemsNewestFirst.push(parsed);
    }
    return { itemsNewestFirst, newestAccession, cursorFound, entryCount: entries.length };
  }
}

function parseEntry(entry: unknown): FetchedItem | undefined {
  if (!isRecord(entry)) return undefined;

  const headline = textOf(entry['title']);
  if (headline === undefined) return undefined;

  const id = textOf(entry['id']);
  const url = linkHref(entry['link']);
  const accession =
    (id !== undefined ? ACCESSION_RE.exec(id)?.[1] : undefined) ??
    (url !== undefined ? ACCESSION_ANY_RE.exec(url)?.[1] : undefined);
  if (accession === undefined) return undefined;

  const summary = textOf(entry['summary']);
  const itemCodes =
    summary === undefined
      ? []
      : [...summary.matchAll(ITEM_CODE_RE)]
          .map((m) => m[1])
          .filter((code): code is string => code !== undefined);
  const cik = TITLE_CIK_RE.exec(headline)?.[1];
  const publishedAt = toIsoDate(textOf(entry['updated']));
  const body = summary === undefined ? undefined : stripHtml(summary);

  const meta: Record<string, unknown> = { itemCodes };
  if (cik !== undefined) meta['cik'] = cik;
  const formType = attrTerm(entry['category']);
  if (formType !== undefined) meta['formType'] = formType;

  return {
    externalId: accession,
    headline,
    ...(url !== undefined ? { url } : {}),
    ...(body !== undefined && body.length > 0 ? { body } : {}),
    ...(publishedAt !== undefined ? { publishedAt } : {}),
    meta,
    raw: entry,
  };
}

/** `<category … term="8-K"/>` → "8-K" (category may be an object or array). */
function attrTerm(category: unknown): string | undefined {
  const first = Array.isArray(category) ? category[0] : category;
  if (!isRecord(first)) return undefined;
  const term = first['@_term'];
  return typeof term === 'string' && term.length > 0 ? term : undefined;
}

/** All four EDGAR adapters (8-K, Form 4, SC 13D, SC 13G) sharing one User-Agent. */
export function edgarAdapters(
  env: Record<string, string | undefined>,
  fetchImpl?: FetchLike,
): EdgarAdapter[] {
  return EDGAR_FORM_TYPES.map(
    (formType) =>
      new EdgarAdapter({
        formType,
        userAgent: env['EDGAR_USER_AGENT'],
        ...(fetchImpl !== undefined ? { fetchImpl } : {}),
      }),
  );
}
