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
 * The published API sample also shows `snippet` and `lead_paragraph`. **We drop
 * `lead_paragraph` on purpose.** Feeding it to the interpreter would let a
 * backtest read richer text than the live path can ever get, which inflates
 * any measured edge — the exact failure the replay invariant exists to
 * prevent.
 *
 * As of a live capture of 2026-07 (4,111 docs) neither field is actually
 * populated any more: `lead_paragraph` is absent from every doc and `snippet`
 * is an empty string in all 4,111. The guard and the snippet fallback are kept
 * regardless — they cost nothing and they are what stops a silent asymmetry if
 * NYT restores either field.
 *
 * That same capture is the evidence the whole design rests on: archive
 * abstracts run to a **median of 136 chars** (p10 65, p90 177, 93 empty)
 * against **143 measured on live RSS**. Backfill and live therefore show the
 * interpreter the same shape of input, which is what makes a backtest over
 * this source honest.
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
    // `.nullish()`, not `.optional()`: the live API sends `keywords: null` on
    // articles with no tags — 220 of 4,111 docs in the 2026-07 capture. An
    // `optional()` array rejected those and failed the whole month, which is
    // the defensive parser working as designed, and is why this is pinned to a
    // real capture rather than to the published sample.
    keywords: z.array(NytKeyword).nullish(),
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
 * Sections dropped by default. Matched case-insensitively on `section_name`.
 *
 * This is an EXCLUDE list, not an include list, and that is the point: the goal
 * is to analyse ALL news, because an event with no company in it still moves
 * markets through a mechanism (weather through utilities and insurers, a border
 * closure through shipping). Everything therefore survives unless its section
 * structurally cannot carry a new event. Deciding WHICH names are affected is
 * the interpreter's job, not this filter's.
 *
 * Names pinned to a live capture of 2026-07 (4,111 docs) — the published sample
 * uses different labels ('Business Day' vs the real 'Business', 'Crosswords &
 * Games' vs 'Gameplay'), so a list written from the docs would have silently
 * matched nothing.
 *
 * Two judgement calls worth seeing, both from reading real headlines:
 *   - **Weather stays.** Its July docs include "Heat Wave Spreads East ...
 *     Putting Millions More at Risk" and "Tracking Tropical Storm Bavi" —
 *     precisely the macro events this source was added for.
 *   - **Briefing and Polls go.** "Today, In Short" is a digest of news that
 *     already arrived through its own items, and "Toplines: Times/Siena Polls"
 *     is a data dump, not an event.
 */
export const NYT_EXCLUDED_SECTIONS: readonly string[] = [
  'Sports',
  'Arts',
  'Movies',
  'Theater',
  'Music',
  'Dance',
  'Books',
  'Style',
  'Food',
  'Travel',
  'Gameplay',
  'Podcasts',
  'Briefing',
  'Polls',
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
  'Crosswords & Games',
  'Fashion & Style',
];

/**
 * `type_of_material` values dropped by default, case-insensitive.
 *
 * A cleaner cut than section for one specific thing: removing COMMENTARY. An
 * Op-Ed, editorial, letter, or review discusses an event that already reached
 * us through its own item, so interpreting it double-counts one story and pays
 * twice for it. In the 2026-07 capture this removes 220 Op-Eds, 145 interactive
 * features, 122 reviews, 84 obituaries, 56 letters, and 55 briefings while
 * leaving all 3,229 'News' docs and both News Analysis and Live Blog Post
 * intact. Note the API's own casing is inconsistent ('briefing' lowercase,
 * 'Op-Ed' hyphenated), which is why matching is case-folded.
 */
export const NYT_EXCLUDED_MATERIAL_TYPES: readonly string[] = [
  'Op-Ed',
  'Editorial',
  'Letter',
  'Review',
  'Obituary (Obit)',
  'briefing',
  'Quote',
  'NYT Cooking',
  'Correction',
  'Interactive Feature',
  'Recipe',
  'Slideshow',
  'Video',
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
   * Last month to backfill, `YYYY-MM` inclusive. Defaults to the last COMPLETE
   * month before `now()` — see {@link lastCompleteMonth}. A sweep that reaches
   * past this returns zero items and holds its cursor, so a scheduled poller
   * cannot spin.
   */
  endMonth?: string | undefined;
  excludedSections?: readonly string[] | undefined;
  excludedDocumentTypes?: readonly string[] | undefined;
  excludedMaterialTypes?: readonly string[] | undefined;
  /** Injectable for tests; the adapter is otherwise clock-free. */
  now?: (() => Date) | undefined;
  fetchImpl?: FetchLike | undefined;
}

/**
 * Default backfill start, chosen to match the data the rest of the system
 * actually holds rather than the depth the API offers.
 *
 * The archive reaches 1851 and it is tempting to take all of it. That would be
 * waste: a news item is only useful once it can be MEASURED, which needs price
 * bars for the reaction window, and only comparable once a competing source
 * covered the same day. Every other source in this repo begins 2026-07-10/11
 * (verified against `raw_news_items` on 2026-08-31: edgar_form4, globenewswire,
 * edgar_8k, massive_news, and the crypto feeds all start that week), and the
 * locked tune/holdout split sits inside that window at 2026-08-07. Months
 * before it would ingest tens of thousands of rows that no evaluation can score
 * and no source comparison can use.
 *
 * Raise the window deliberately — with `NYT_ARCHIVE_START` — once bars and a
 * second source cover the earlier period.
 */
export const DEFAULT_ARCHIVE_START_MONTH = '2026-07';

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

/**
 * The newest month the Archive API will actually serve: the last COMPLETE one.
 *
 * Verified 2026-08-31 — `/2026/6.json` returns 200 while `/2026/8.json`, the
 * month in progress, returns **403**. Not a rate limit and not an auth problem:
 * the same key served June seconds earlier. The archive simply does not publish
 * a month until it closes, and it says so with a status code that looks exactly
 * like a bad key, which is worth knowing before anyone debugs their credentials
 * over it.
 *
 * The practical consequence: the current month is reachable only through the
 * live RSS feeds, so a backfill can never be fully current.
 */
export function lastCompleteMonth(now: Date): string {
  const year = now.getUTCFullYear();
  const month = now.getUTCMonth() + 1;
  return month === 1 ? formatMonth(year - 1, 12) : formatMonth(year, month - 1);
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
  private readonly excludedMaterialTypes: ReadonlySet<string>;
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
    this.excludedMaterialTypes = new Set(
      (config.excludedMaterialTypes ?? NYT_EXCLUDED_MATERIAL_TYPES).map((s) => s.toLowerCase()),
    );
    this.now = config.now ?? ((): Date => new Date());
    this.fetchImpl = config.fetchImpl ?? defaultFetch;
  }

  async fetchSince(cursor: string | null): Promise<FetchResult> {
    const month = cursor === null ? this.startMonth : nextMonth(cursor);
    const last = this.endMonth ?? lastCompleteMonth(this.now());

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
    const materialType = doc.type_of_material ?? '';
    if (this.excludedMaterialTypes.has(materialType.toLowerCase())) return undefined;

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
