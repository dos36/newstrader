import type { FetchedItem, FetchResult, SourceAdapter } from '@newstrader/core';
import { z } from 'zod';

import { defaultFetch, type FetchLike } from './http.js';

/**
 * Massive (ex-Polygon) news adapter — GET /v2/reference/news.
 *
 * Endpoint, params, and response shape verified against
 * https://massive.com/docs/rest/stocks/news.md on 2026-07-10:
 * `published_utc.gt|gte|lt|lte`, `order`, `sort`, `limit` (default 10, max
 * 1000); envelope { count, next_url, request_id, results[], status }; result
 * fields include id, title, description, article_url, published_utc (RFC3339),
 * tickers[], keywords[], publisher{}, insights[{ticker, sentiment,
 * sentiment_reasoning}]. Auth: the key is sent as `Authorization: Bearer` —
 * equivalent to the `apiKey` query param but keeps the secret out of URLs/logs.
 *
 * Cursor = max `published_utc` seen. Two silent-skip modes are defended
 * against (both bias exactly the volume measurement M0 exists to make):
 *   - page-boundary loss: a poll follows `next_url` pages (up to `maxPages`)
 *     instead of trusting one page, so same-second articles straddling a page
 *     boundary are not dropped;
 *   - vendor late-arrival: each poll re-queries from `published_utc.gte`
 *     (cursor - `overlapMs`, default 5 min), so articles Massive indexes late
 *     get re-emitted — the DB unique (source_id, external_id) absorbs the
 *     duplicates.
 * First poll (null cursor) looks back `initialLookbackMs` (default 1 h) —
 * without a floor, order=asc would replay the archive from 2016.
 */

const MassiveInsight = z
  .object({
    ticker: z.string().optional(),
    sentiment: z.string().optional(),
    sentiment_reasoning: z.string().optional(),
  })
  .passthrough();

const MassiveArticle = z
  .object({
    id: z.string().min(1),
    title: z.string().min(1),
    description: z.string().optional(),
    author: z.string().optional(),
    article_url: z.string().optional(),
    published_utc: z.string(),
    tickers: z.array(z.string()).optional(),
    keywords: z.array(z.string()).optional(),
    insights: z.array(MassiveInsight).optional(),
    publisher: z.object({ name: z.string().optional() }).passthrough().optional(),
  })
  .passthrough();

const MassiveNewsResponse = z
  .object({
    status: z.string().optional(),
    count: z.number().optional(),
    next_url: z.string().optional(),
    results: z.array(MassiveArticle).optional(),
  })
  .passthrough();

export interface MassiveNewsAdapterOptions {
  /** Value of env MASSIVE_API_KEY. Mandatory. */
  apiKey: string | undefined;
  /** Value of env MASSIVE_BASE_URL; api.polygon.io still serves during the rebrand. */
  baseUrl?: string | undefined;
  /** Lookback window for the very first poll (null cursor). Default 1 hour. */
  initialLookbackMs?: number;
  /** Re-poll overlap subtracted from the cursor (vendor late-arrival guard). Default 5 min. */
  overlapMs?: number;
  /** Safety cap on next_url pages followed per poll. Default 10. */
  maxPages?: number;
  limit?: number;
  fetchImpl?: FetchLike;
}

export const MASSIVE_DEFAULT_BASE_URL = 'https://api.polygon.io';

export class MassiveNewsAdapter implements SourceAdapter {
  readonly kind = 'newsapi' as const;
  readonly sourceKey = 'massive_news';

  private readonly apiKey: string;
  private readonly baseUrl: string;
  private readonly initialLookbackMs: number;
  private readonly overlapMs: number;
  private readonly maxPages: number;
  private readonly limit: number;
  private readonly fetchImpl: FetchLike;

  constructor(options: MassiveNewsAdapterOptions) {
    const apiKey = options.apiKey?.trim();
    if (apiKey === undefined || apiKey.length === 0) {
      throw new Error('MASSIVE_API_KEY is not set — required for the Massive news adapter.');
    }
    this.apiKey = apiKey;
    this.baseUrl = options.baseUrl ?? MASSIVE_DEFAULT_BASE_URL;
    this.initialLookbackMs = options.initialLookbackMs ?? 60 * 60 * 1000;
    this.overlapMs = options.overlapMs ?? 5 * 60 * 1000;
    this.maxPages = options.maxPages ?? 10;
    this.limit = options.limit ?? 100;
    this.fetchImpl = options.fetchImpl ?? defaultFetch;
  }

  async fetchSince(cursor: string | null): Promise<FetchResult> {
    const cursorMs = cursor === null ? Number.NaN : Date.parse(cursor);
    const since = Number.isNaN(cursorMs)
      ? new Date(Date.now() - this.initialLookbackMs).toISOString()
      : new Date(cursorMs - this.overlapMs).toISOString();

    const firstUrl = new URL('/v2/reference/news', this.baseUrl);
    firstUrl.searchParams.set('order', 'asc');
    firstUrl.searchParams.set('sort', 'published_utc');
    firstUrl.searchParams.set('limit', String(this.limit));
    firstUrl.searchParams.set('published_utc.gte', since);

    const items: FetchedItem[] = [];
    const seen = new Set<string>();
    let nextCursor = cursor;
    let url: string | undefined = firstUrl.toString();
    let pages = 0;

    while (url !== undefined && pages < this.maxPages) {
      const page: FetchResult & { nextUrl?: string } = await this.fetchPage(url, nextCursor);
      pages += 1;
      let progressed = false;
      for (const item of page.items) {
        if (seen.has(item.externalId)) continue;
        seen.add(item.externalId);
        items.push(item);
        progressed = true;
      }
      nextCursor = page.nextCursor;
      // No new items = a stalled or self-referential next_url; stop rather
      // than trust the vendor's paging token blindly.
      url = progressed ? page.nextUrl : undefined;
    }
    if (url !== undefined) {
      // Hitting the cap means a genuine backlog (e.g. first poll after downtime).
      // Nothing is lost: the unsaved tail stays above the cursor for next poll.
      console.warn(
        JSON.stringify({
          level: 'warn',
          msg: 'massive_page_cap',
          pages,
          sourceKey: this.sourceKey,
        }),
      );
    }
    return { items, nextCursor };
  }

  private async fetchPage(
    url: string,
    cursor: string | null,
  ): Promise<FetchResult & { nextUrl?: string }> {
    const res = await this.fetchImpl(url, {
      headers: { Authorization: `Bearer ${this.apiKey}`, Accept: 'application/json' },
    });
    if (!res.ok) {
      throw new Error(`Massive news request failed: ${res.status} ${res.statusText}`);
    }
    return this.parseResponse((await res.json()) as unknown, cursor);
  }

  /**
   * Pure parse step for ONE page, exposed for fixture tests. Results arrive
   * oldest-first (order=asc); `nextUrl` is present when Massive has more pages.
   */
  parseResponse(payload: unknown, cursor: string | null): FetchResult & { nextUrl?: string } {
    const response = MassiveNewsResponse.parse(payload);
    const results = response.results ?? [];

    const items: FetchedItem[] = results.map((article) => {
      const publishedAt = toIso(article.published_utc);
      const meta: Record<string, unknown> = {};
      if (article.insights !== undefined && article.insights.length > 0) {
        meta['sentiment'] = article.insights;
      }
      if (article.keywords !== undefined) meta['keywords'] = article.keywords;
      if (article.publisher?.name !== undefined) meta['publisher'] = article.publisher.name;

      return {
        externalId: article.id,
        headline: article.title,
        ...(article.article_url !== undefined ? { url: article.article_url } : {}),
        ...(article.description !== undefined ? { body: article.description } : {}),
        ...(publishedAt !== undefined ? { publishedAt } : {}),
        ...(article.tickers !== undefined ? { symbolsHint: article.tickers } : {}),
        meta,
        raw: article,
      };
    });

    // Cursor only moves forward: with the .gte overlap re-fetch, a page can
    // legitimately end on an item older than the stored cursor.
    const last = results[results.length - 1];
    const nextCursor = maxIso(cursor, last?.published_utc);
    return {
      items,
      nextCursor,
      ...(response.next_url !== undefined ? { nextUrl: response.next_url } : {}),
    };
  }
}

/** Later of two ISO timestamps (compared as instants, not strings); null-safe. */
function maxIso(a: string | null, b: string | undefined): string | null {
  if (b === undefined) return a;
  if (a === null) return b;
  const aMs = Date.parse(a);
  const bMs = Date.parse(b);
  if (Number.isNaN(aMs)) return b;
  if (Number.isNaN(bMs)) return a;
  return bMs > aMs ? b : a;
}

function toIso(value: string): string | undefined {
  const ms = Date.parse(value);
  return Number.isNaN(ms) ? undefined : new Date(ms).toISOString();
}

/** Factory reading env (MASSIVE_API_KEY, MASSIVE_BASE_URL). */
export function massiveNewsAdapter(
  env: Record<string, string | undefined>,
  fetchImpl?: FetchLike,
): MassiveNewsAdapter {
  return new MassiveNewsAdapter({
    apiKey: env['MASSIVE_API_KEY'],
    baseUrl: env['MASSIVE_BASE_URL'],
    ...(fetchImpl !== undefined ? { fetchImpl } : {}),
  });
}
