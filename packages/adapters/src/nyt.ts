import type { FetchedItem, FetchResult, SourceAdapter } from '@newstrader/core';
import { z } from 'zod';

import { defaultFetch, fetchText, type FetchLike } from './http.js';

/**
 * Structural shape of an RSS preset. Declared here rather than imported from
 * `rss.ts` on purpose: `rss.ts` spreads {@link NYT_RSS_PRESETS} into
 * `RSS_PRESETS`, so importing back from it — even type-only — would make the
 * dependency circular on paper and invite a real cycle the first time someone
 * needs a value instead of a type.
 */
type RssPreset = { sourceKey: string; feedUrl: string };

/**
 * New York Times adapters — global/macro news with a free deep archive.
 *
 * Two adapters, one publisher, deliberately asymmetric in role:
 *
 *   - {@link NYT_RSS_PRESETS} feed the LIVE path through the existing
 *     {@link RssAdapter}. Public, no key, no throttle. Verified live
 *     2026-08-31: all feeds HTTP 200, newest item 8 min old,
 *     `cache-control: max-age=300` (so 5 min is the real resolution, not
 *     sub-minute), 10 rapid requests all 200, no rate-limit headers, and no
 *     ETag — conditional GET does not work, every poll re-downloads the body.
 *
 *   - {@link NytArchiveAdapter} feeds BACKFILL through the Archive API
 *     (metadata by month, back to 1851, 2,000 req/day on a free key).
 *
 * ## Why `body` is the abstract, and never `lead_paragraph`
 *
 * The live RSS `<description>` carries the article's abstract and nothing else.
 * Measured 2026-08-31 over 58 World items: median 143 chars, range 83–253.
 * These are hand-written editorial deks, NOT truncated text — 0/58 ended in an
 * ellipsis, 0/58 ended mid-word, 57/58 ended in sentence punctuation, and 43
 * distinct lengths appeared across the range (a character cap would cluster at
 * one value). The same article carried a byte-identical description in every
 * feed it appeared in (91 cross-feed articles, 0 differing), so it is one
 * canonical stored field, delivered whole.
 *
 * The Archive API also returns `snippet` and `lead_paragraph`. **We drop
 * `lead_paragraph` on purpose.** Feeding it to the interpreter would let a
 * backtest read richer text than the live path can ever get, which inflates
 * any measured edge — the exact failure the replay invariant exists to
 * prevent. `abstract` is the field that matches live; `snippet` is a fallback
 * because the API's own sample shows `abstract` can be null.
 *
 * Article BODIES are not obtainable from either path and must not be attempted:
 * a body fetch returns 403 from DataDome bot protection, and robots.txt
 * separately disallows automated clients by name. GDELT is no help here either
 * — its GKG publishes a word count (`wc:375`) but no text, and its DOC 2.0 API
 * returns title-only.
 *
 * ## Terms
 *
 * The API terms state personal, noncommercial use and require attribution.
 * This project is personal research on a paper-only venue, which fits, but it
 * is the same class of exposure the architecture doc tracks under free-tier
 * terms drift. Re-check if the project's purpose changes.
 */

/**
 * Live RSS feeds, for spreading into {@link RSS_PRESETS}.
 *
 * Feed choice is driven by the RESOLVER, not by editorial interest. Resolution
 * matches instrument aliases (name | ticker | cashtag | cik) against item text.
 * NYT prose never prints "(NYSE: AAPL)", so only NAME matching can fire — which
 * works in Business/DealBook/Economy/Technology, where companies are named
 * constantly, and fails in the regional world feeds, where a story about a
 * flood names no company. The regional feeds are included anyway because
 * macro-scope interpretation is the point of adding NYT; until `signal_fanout`
 * exists they land as unlinked items and the resolve sweep steps past them,
 * exactly as it does for non-S&P filings.
 *
 * All URLs verified live (HTTP 200, item count > 0) 2026-08-31.
 */
export const NYT_RSS_PRESETS = {
  nyt_business: {
    sourceKey: 'nyt_business',
    feedUrl: 'https://rss.nytimes.com/services/xml/rss/nyt/Business.xml',
  },
  nyt_dealbook: {
    sourceKey: 'nyt_dealbook',
    feedUrl: 'https://rss.nytimes.com/services/xml/rss/nyt/Dealbook.xml',
  },
  nyt_economy: {
    sourceKey: 'nyt_economy',
    feedUrl: 'https://rss.nytimes.com/services/xml/rss/nyt/Economy.xml',
  },
  nyt_technology: {
    sourceKey: 'nyt_technology',
    feedUrl: 'https://rss.nytimes.com/services/xml/rss/nyt/Technology.xml',
  },
  nyt_world: {
    sourceKey: 'nyt_world',
    feedUrl: 'https://rss.nytimes.com/services/xml/rss/nyt/World.xml',
  },
  nyt_climate: {
    sourceKey: 'nyt_climate',
    feedUrl: 'https://rss.nytimes.com/services/xml/rss/nyt/Climate.xml',
  },
} as const satisfies Record<string, RssPreset>;

/**
 * Archive API response. `.passthrough()` everywhere so the verbatim payload
 * still reaches the raw store when NYT adds fields; the fields we READ are
 * pinned so format drift throws instead of silently ingesting nulls.
 *
 * Shape pinned against
 * https://raw.githubusercontent.com/nytimes/public_api_specs/master/archive_api/archive_api.md
 * (fetched 2026-08-31). Note `word_count` is a STRING in the published sample,
 * and `lead_paragraph` / `abstract` / `section_name` are all nullable.
 */
const NytHeadline = z
  .object({
    main: z.string().optional(),
    kicker: z.string().nullish(),
  })
  .passthrough();

const NytKeyword = z
  .object({
    name: z.string().optional(),
    value: z.string().optional(),
  })
  .passthrough();

const NytDoc = z
  .object({
    _id: z.string().min(1),
    web_url: z.string().nullish(),
    headline: NytHeadline.optional(),
    abstract: z.string().nullish(),
    snippet: z.string().nullish(),
    pub_date: z.string().min(1),
    section_name: z.string().nullish(),
    subsection_name: z.string().nullish(),
    news_desk: z.string().nullish(),
    document_type: z.string().nullish(),
    type_of_material: z.string().nullish(),
    word_count: z.union([z.number(), z.string()]).nullish(),
    keywords: z.array(NytKeyword).optional(),
    source: z.string().nullish(),
  })
  .passthrough();

const NytArchiveResponse = z
  .object({
    status: z.string().optional(),
    response: z
      .object({
        docs: z.array(NytDoc).optional(),
        meta: z.object({ hits: z.number().optional() }).passthrough().optional(),
      })
      .passthrough(),
  })
  .passthrough();

/**
 * Sections dropped by default.
 *
 * The user's ask is explicitly "analyze ALL news" — a Nepal flood is wanted,
 * because disasters in developed economies move insurers, reinsurers, and
 * supply chains. So this is an EXCLUDE list, not an include list: everything
 * survives unless it is structurally incapable of carrying market information.
 * Matched case-insensitively against `section_name`.
 */
export const NYT_EXCLUDED_SECTIONS: readonly string[] = [
  'Sports',
  'Arts',
  'Movies',
  'Theater',
  'Music',
  'Books',
  'Style',
  'Fashion & Style',
  'Food',
  'Travel',
  'Games',
  'Crosswords & Games',
  'Obituaries',
  'Corrections',
  'The Learning Network',
  'Times Insider',
  'Reader Center',
  'Well',
  'Parenting',
  'Love',
  'Magazine',
  'T Magazine',
  'Real Estate',
];

/**
 * Document types dropped by default. These carry no reportable event: a
 * multimedia stub or an audio container has no abstract worth interpreting.
 */
export const NYT_EXCLUDED_DOCUMENT_TYPES: readonly string[] = ['multimedia', 'audio'];

export interface NytArchiveAdapterConfig {
  /** Value of env NYT_API_KEY. Mandatory. */
  apiKey: string | undefined;
  /** Value of env NYT_ARCHIVE_BASE_URL; defaults to the documented host. */
  baseUrl?: string | undefined;
  /**
   * First month to backfill, `YYYY-MM`. Only read on a null cursor. Defaults
   * to {@link DEFAULT_ARCHIVE_START_MONTH}.
   */
  startMonth?: string | undefined;
  /**
   * Last month to backfill, `YYYY-MM` inclusive. Defaults to the month of
   * `now()`. A sweep that reaches past this returns zero items and holds its
   * cursor, so a scheduled poller cannot spin.
   */
  endMonth?: string | undefined;
  excludedSections?: readonly string[] | undefined;
  excludedDocumentTypes?: readonly string[] | undefined;
  /** Injectable for tests; the adapter is otherwise clock-free. */
  now?: (() => Date) | undefined;
  fetchImpl?: FetchLike | undefined;
}

/**
 * Default backfill start. 2016-01 is not arbitrary: it is where Massive's own
 * news archive begins, so a shared window makes NYT-vs-Massive source
 * comparisons possible without one side having a head start.
 */
export const DEFAULT_ARCHIVE_START_MONTH = '2016-01';

const MONTH_RE = /^(\d{4})-(0[1-9]|1[0-2])$/;

/** Parse `YYYY-MM` into a {year, month} pair, throwing on anything else. */
export function parseMonth(value: string): { year: number; month: number } {
  const match = MONTH_RE.exec(value);
  if (match === null) {
    throw new Error(`Invalid NYT archive month "${value}" — expected YYYY-MM.`);
  }
  // Both groups are guaranteed present by a successful match; the non-null
  // assertions noUncheckedIndexedAccess would otherwise demand are avoided by
  // destructuring with defaults that can never be taken.
  const [, yearText = '', monthText = ''] = match;
  return { year: Number(yearText), month: Number(monthText) };
}

export function formatMonth(year: number, month: number): string {
  return `${String(year).padStart(4, '0')}-${String(month).padStart(2, '0')}`;
}

/** Next calendar month, as `YYYY-MM`. */
export function nextMonth(value: string): string {
  const { year, month } = parseMonth(value);
  return month === 12 ? formatMonth(year + 1, 1) : formatMonth(year, month + 1);
}

/** Lexicographic compare is correct for zero-padded `YYYY-MM`. */
function monthIsAfter(a: string, b: string): boolean {
  return a > b;
}

function currentMonth(now: Date): string {
  return formatMonth(now.getUTCFullYear(), now.getUTCMonth() + 1);
}

/**
 * NYT Archive API backfill adapter.
 *
 * ## Cursor
 *
 * The cursor is the last month successfully ingested, `YYYY-MM`. One fetch
 * covers exactly one month, because that is the API's only granularity — there
 * is no paging and no partial month. A null cursor starts at `startMonth`.
 * Once the walk passes `endMonth` the adapter returns `{items: [], nextCursor:
 * <unchanged>}`, which is the "done" signal: a repeated poll is a cheap no-op
 * rather than a spin.
 *
 * ## Why this is a backfill adapter and not a poller
 *
 * `backfill = true` tells {@link runPoll} to take each item's
 * `receivedAtOverride` instead of stamping `now()`. Without that, ten years of
 * archive would all land with today's `received_at` and be worthless for a
 * backtest. The override is derived from `pub_date`, which means it is a
 * SOURCE CLAIM, not an observation by our clock — so backfilled rows carry
 * `meta.backfill = true` and are only ever sound for analytics and backtests.
 * The live RSS path remains the only source of true `received_at`.
 */
export class NytArchiveAdapter implements SourceAdapter {
  readonly kind = 'newsapi' as const;
  readonly sourceKey = 'nyt_archive';
  /** Licenses `receivedAtOverride`; see the class note. */
  readonly backfill = true as const;

  private readonly apiKey: string;
  private readonly baseUrl: string;
  private readonly startMonth: string;
  private readonly endMonth: string | undefined;
  private readonly excludedSections: ReadonlySet<string>;
  private readonly excludedDocumentTypes: ReadonlySet<string>;
  private readonly now: () => Date;
  private readonly fetchImpl: FetchLike;

  constructor(config: NytArchiveAdapterConfig) {
    const apiKey = config.apiKey?.trim();
    if (apiKey === undefined || apiKey.length === 0) {
      throw new Error('NYT_API_KEY is not set — required for the NYT archive adapter.');
    }
    this.apiKey = apiKey;
    this.baseUrl = (config.baseUrl?.trim() ?? '') || 'https://api.nytimes.com';
    this.startMonth = config.startMonth?.trim() || DEFAULT_ARCHIVE_START_MONTH;
    parseMonth(this.startMonth);
    const endMonth = config.endMonth?.trim();
    if (endMonth !== undefined && endMonth.length > 0) {
      parseMonth(endMonth);
      this.endMonth = endMonth;
    } else {
      this.endMonth = undefined;
    }
    this.excludedSections = new Set(
      (config.excludedSections ?? NYT_EXCLUDED_SECTIONS).map((s) => s.toLowerCase()),
    );
    this.excludedDocumentTypes = new Set(
      (config.excludedDocumentTypes ?? NYT_EXCLUDED_DOCUMENT_TYPES).map((s) => s.toLowerCase()),
    );
    this.now = config.now ?? ((): Date => new Date());
    this.fetchImpl = config.fetchImpl ?? defaultFetch;
  }

  async fetchSince(cursor: string | null): Promise<FetchResult> {
    const month = cursor === null ? this.startMonth : nextMonth(cursor);
    const last = this.endMonth ?? currentMonth(this.now());

    if (monthIsAfter(month, last)) {
      // Walk complete. Hold the cursor so a rerun is a no-op, not a restart.
      return { items: [], nextCursor: cursor };
    }

    const { year, month: monthNumber } = parseMonth(month);
    // The key goes in the query string because the Archive API accepts it
    // nowhere else — unlike Massive, there is no Authorization-header form.
    // fetchText echoes the URL into its error message, so failures are
    // sanitized below rather than letting the key reach a log.
    const url = `${this.baseUrl}/svc/archive/v1/${year}/${monthNumber}.json?api-key=${encodeURIComponent(this.apiKey)}`;

    let text: string;
    try {
      text = await fetchText(this.fetchImpl, url, { headers: { Accept: 'application/json' } });
    } catch (error) {
      throw new Error(
        `NYT archive fetch for ${month} failed: ${redactKey(
          error instanceof Error ? error.message : String(error),
          this.apiKey,
        )}`,
      );
    }

    const parsed = NytArchiveResponse.parse(JSON.parse(text) as unknown);
    const docs = parsed.response.docs ?? [];
    const items: FetchedItem[] = [];
    for (const doc of docs) {
      const item = this.toItem(doc);
      if (item !== undefined) items.push(item);
    }

    return { items, nextCursor: month };
  }

  /** Pure mapping step, exposed for fixture tests. */
  toItem(doc: z.infer<typeof NytDoc>): FetchedItem | undefined {
    const section = doc.section_name ?? '';
    if (this.excludedSections.has(section.toLowerCase())) return undefined;
    const documentType = doc.document_type ?? '';
    if (this.excludedDocumentTypes.has(documentType.toLowerCase())) return undefined;

    const headline = doc.headline?.main?.trim();
    if (headline === undefined || headline.length === 0) return undefined;

    // pub_date is the ONLY timestamp the archive offers, and it becomes the
    // backfill's received_at. A doc without a parseable one cannot be placed on
    // the timeline, so it is dropped rather than silently stamped with now().
    const publishedAt = new Date(doc.pub_date);
    if (Number.isNaN(publishedAt.getTime())) return undefined;
    const publishedAtIso = publishedAt.toISOString();

    // abstract first, snippet as fallback; lead_paragraph deliberately unused.
    const abstract = (doc.abstract ?? doc.snippet ?? '').trim();

    const meta: Record<string, unknown> = {
      backfill: true,
      archiveMonth: formatMonth(publishedAt.getUTCFullYear(), publishedAt.getUTCMonth() + 1),
      sectionName: doc.section_name ?? null,
      subsectionName: doc.subsection_name ?? null,
      newsDesk: doc.news_desk ?? null,
      documentType: doc.document_type ?? null,
      typeOfMaterial: doc.type_of_material ?? null,
      kicker: doc.headline?.kicker ?? null,
      wordCount: normalizeWordCount(doc.word_count),
      keywords: (doc.keywords ?? [])
        .map((k) => k.value)
        .filter((v): v is string => v !== undefined && v.length > 0),
    };

    return {
      externalId: doc._id,
      ...(doc.web_url !== undefined && doc.web_url !== null ? { url: doc.web_url } : {}),
      headline,
      ...(abstract.length > 0 ? { body: abstract } : {}),
      publishedAt: publishedAtIso,
      receivedAtOverride: publishedAtIso,
      meta,
      raw: doc,
    };
  }
}

/**
 * `word_count` arrives as a string in the API's published sample and as a
 * number in current responses. Normalize to a number, or null when neither.
 */
function normalizeWordCount(value: number | string | null | undefined): number | null {
  if (typeof value === 'number') return Number.isFinite(value) ? value : null;
  if (typeof value !== 'string') return null;
  const parsed = Number(value.trim());
  return Number.isFinite(parsed) ? parsed : null;
}

/**
 * Strip the API key from an error string. The key rides in the query string
 * (the Archive API offers no header form) and `fetchText` puts the failing URL
 * into its message, so an unsanitized rethrow would print the secret.
 */
export function redactKey(message: string, apiKey: string): string {
  if (apiKey.length === 0) return message;
  return message.split(apiKey).join('[REDACTED]');
}

/** Factory reading env (NYT_API_KEY, NYT_ARCHIVE_BASE_URL, NYT_ARCHIVE_START/END). */
export function nytArchiveAdapter(
  env: Record<string, string | undefined>,
  fetchImpl?: FetchLike,
): NytArchiveAdapter {
  return new NytArchiveAdapter({
    apiKey: env['NYT_API_KEY'],
    baseUrl: env['NYT_ARCHIVE_BASE_URL'],
    startMonth: env['NYT_ARCHIVE_START'],
    endMonth: env['NYT_ARCHIVE_END'],
    ...(fetchImpl !== undefined ? { fetchImpl } : {}),
  });
}
