import type { FetchedItem, FetchResult, SourceAdapter } from '@newstrader/core';
import { z } from 'zod';

import { defaultFetch, fetchText, type FetchLike } from './http.js';
import { NYT_RSS_PRESETS } from './nyt.js';
import { isRecord, linkHref, parseXml, stripHtml, textOf, toIsoDate } from './xml.js';

/**
 * Generic feed adapter: parses both RSS 2.0 (`rss.channel.item`) and Atom
 * (`feed.entry`) documents with one code path.
 *
 * externalId fallback chain: guid (RSS) → id (Atom) → link. Items with none
 * of the three are dropped (no stable idempotency key = no ingest).
 *
 * Cursor design (documented choice): a JSON array of the externalIds present
 * in the previous poll, capped at {@link RSS_CURSOR_MAX_IDS} (newest polls
 * first). Feed timestamps are too unreliable (missing pubDate, minute-only
 * precision, out-of-order edits) to be a watermark; a guid set is exact,
 * bounded by feed length, and re-emits nothing while items merely reshuffle.
 * The union with the previous cursor keeps ids of items that temporarily fall
 * out of a flapping feed. Any duplicate that still slips through is absorbed
 * by the DB unique (source_id, external_id) — the cursor is noise reduction,
 * not the idempotency mechanism.
 */

export const RSS_CURSOR_MAX_IDS = 500;

const RssDoc = z.union([
  z.object({
    rss: z
      .object({ channel: z.object({ item: z.array(z.unknown()).optional() }).passthrough() })
      .passthrough(),
  }),
  z.object({
    feed: z.object({ entry: z.array(z.unknown()).optional() }).passthrough(),
  }),
]);

export interface RssAdapterConfig {
  sourceKey: string;
  feedUrl: string;
  userAgent?: string;
  fetchImpl?: FetchLike;
}

export class RssAdapter implements SourceAdapter {
  readonly kind = 'rss' as const;
  readonly sourceKey: string;
  readonly feedUrl: string;

  private readonly userAgent: string;
  private readonly fetchImpl: FetchLike;

  constructor(config: RssAdapterConfig) {
    this.sourceKey = config.sourceKey;
    this.feedUrl = config.feedUrl;
    this.userAgent = config.userAgent ?? 'NewsTrader/0.1 (personal news research; RSS poller)';
    this.fetchImpl = config.fetchImpl ?? defaultFetch;
  }

  async fetchSince(cursor: string | null): Promise<FetchResult> {
    const xml = await fetchText(this.fetchImpl, this.feedUrl, {
      headers: {
        'User-Agent': this.userAgent,
        Accept: 'application/rss+xml, application/atom+xml, application/xml, text/xml',
      },
    });
    return this.parseFeed(xml, cursor);
  }

  /** Pure parse step, exposed for fixture tests. */
  parseFeed(xml: string, cursor: string | null): FetchResult {
    const doc = RssDoc.parse(parseXml(xml));
    const rawItems = 'rss' in doc ? (doc.rss.channel.item ?? []) : (doc.feed.entry ?? []);

    const seen = parseCursor(cursor);
    const items: FetchedItem[] = [];
    const currentIds: string[] = [];
    for (const raw of rawItems) {
      const parsed = parseItem(raw);
      if (parsed === undefined) continue;
      currentIds.push(parsed.externalId);
      if (seen.has(parsed.externalId)) continue;
      items.push(parsed);
    }

    if (currentIds.length === 0) return { items: [], nextCursor: cursor };

    const union = [...new Set([...currentIds, ...seen])].slice(0, RSS_CURSOR_MAX_IDS);
    return { items, nextCursor: JSON.stringify(union) };
  }
}

function parseCursor(cursor: string | null): Set<string> {
  if (cursor === null) return new Set();
  try {
    const parsed: unknown = JSON.parse(cursor);
    if (Array.isArray(parsed)) {
      return new Set(parsed.filter((id): id is string => typeof id === 'string'));
    }
  } catch {
    // Malformed/legacy cursor → treat as a cold start; the DB constraint dedups.
  }
  return new Set();
}

function parseItem(item: unknown): FetchedItem | undefined {
  if (!isRecord(item)) return undefined;

  const headline = textOf(item['title']);
  if (headline === undefined) return undefined;

  const url = linkHref(item['link']);
  // guid (RSS 2.0) → id (Atom) → link, in that order.
  const externalId = textOf(item['guid']) ?? textOf(item['id']) ?? url;
  if (externalId === undefined) return undefined;

  const publishedAt = toIsoDate(
    textOf(item['pubDate']) ?? textOf(item['published']) ?? textOf(item['updated']),
  );
  const rawBody = textOf(item['description']) ?? textOf(item['summary']);
  const body = rawBody === undefined ? undefined : stripHtml(rawBody);
  const categories = collectCategories(item['category']);

  const meta: Record<string, unknown> = {};
  if (categories.length > 0) meta['categories'] = categories;
  const creator = textOf(item['dc:creator']) ?? textOf(item['author']);
  if (creator !== undefined) meta['author'] = creator;

  return {
    externalId,
    headline,
    ...(url !== undefined ? { url } : {}),
    ...(body !== undefined && body.length > 0 ? { body } : {}),
    ...(publishedAt !== undefined ? { publishedAt } : {}),
    meta,
    raw: item,
  };
}

/** Category values, kept for the M1 entity resolver (e.g. GlobeNewswire "Nasdaq:XYZ" stock tags). */
function collectCategories(category: unknown): string[] {
  if (category === undefined) return [];
  const values = Array.isArray(category) ? category : [category];
  return values
    .map((value) => textOf(value) ?? attrOfTerm(value))
    .filter((value): value is string => value !== undefined);
}

function attrOfTerm(value: unknown): string | undefined {
  if (!isRecord(value)) return undefined;
  const term = value['@_term'];
  return typeof term === 'string' && term.length > 0 ? term : undefined;
}

/**
 * Preset feeds. The original four URLs verified live (HTTP 200, XML content)
 * 2026-07-10; the NYT feeds verified 2026-08-31. CoinDesk 301-redirects to the
 * same path without the trailing slash; the canonical no-slash form is used
 * here.
 *
 * The NYT feeds live in `nyt.ts` next to the archive adapter, because the two
 * share one publisher's terms and one documented reason for reading
 * `<description>` as the abstract rather than as a body.
 */
export const RSS_PRESETS = {
  ...NYT_RSS_PRESETS,
  globenewswire: {
    sourceKey: 'globenewswire',
    feedUrl:
      'https://www.globenewswire.com/RssFeed/orgclass/1/feedTitle/GlobeNewswire%20-%20News%20about%20Public%20Companies',
  },
  coindesk: {
    sourceKey: 'coindesk',
    feedUrl: 'https://www.coindesk.com/arc/outboundfeeds/rss',
  },
  cointelegraph: {
    sourceKey: 'cointelegraph',
    feedUrl: 'https://cointelegraph.com/rss',
  },
  theblock: {
    sourceKey: 'theblock',
    feedUrl: 'https://www.theblock.co/rss.xml',
  },
} as const satisfies Record<string, Pick<RssAdapterConfig, 'sourceKey' | 'feedUrl'>>;

export function rssPresetAdapters(fetchImpl?: FetchLike): RssAdapter[] {
  return Object.values(RSS_PRESETS).map(
    (preset) => new RssAdapter({ ...preset, ...(fetchImpl !== undefined ? { fetchImpl } : {}) }),
  );
}
