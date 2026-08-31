import { readFileSync } from 'node:fs';

import { FetchedItem } from '@newstrader/core';
import { describe, expect, it } from 'vitest';

import type { FetchLike } from './http.js';
import {
  DEFAULT_ARCHIVE_START_MONTH,
  formatMonth,
  lastCompleteMonth,
  nextMonth,
  NYT_RSS_PRESETS,
  NytArchiveAdapter,
  nytArchiveAdapter,
  parseMonth,
  redactKey,
} from './nyt.js';
import { RSS_PRESETS } from './rss.js';

/**
 * Two fixtures on purpose, guarding drift in both directions.
 *
 * `nyt-archive-2026-07.json` follows the PUBLISHED sample: populated `snippet`,
 * a `lead_paragraph` on every doc, `word_count` as a string. None of that is
 * true of the live API any more, but it is what NYT documents, so it is what a
 * restored field would look like.
 *
 * `nyt-archive-live-2026-07.json` is trimmed from a REAL 2026-07 response
 * (4,111 docs): `keywords: null`, `snippet` empty, no `lead_paragraph` key at
 * all, and the real section labels. The first version of this adapter parsed
 * the published shape and failed the whole month on the live one.
 */
const archiveSample: unknown = JSON.parse(
  readFileSync(new URL('./__fixtures__/nyt-archive-2026-07.json', import.meta.url), 'utf8'),
);
const liveSample: unknown = JSON.parse(
  readFileSync(new URL('./__fixtures__/nyt-archive-live-2026-07.json', import.meta.url), 'utf8'),
);

interface Captured {
  url?: string;
  init?: RequestInit | undefined;
}

function stubFetch(payload: unknown, captured?: Captured): FetchLike {
  return async (url, init) => {
    if (captured) {
      captured.url = url;
      captured.init = init;
    }
    return new Response(JSON.stringify(payload), {
      status: 200,
      headers: { 'content-type': 'application/json' },
    });
  };
}

function adapter(overrides: Partial<{ fetchImpl: FetchLike; now: () => Date }> = {}) {
  return new NytArchiveAdapter({
    apiKey: 'test-key',
    startMonth: '2026-07',
    endMonth: '2026-07',
    now: () => new Date('2026-08-31T00:00:00Z'),
    ...overrides,
  });
}

describe('NytArchiveAdapter', () => {
  it('declares itself a backfill adapter', () => {
    // The ingest path keys `receivedAtOverride` off this flag alone. If it ever
    // flips to false, ten years of archive silently land at today's timestamp.
    expect(adapter().backfill).toBe(true);
    expect(adapter().sourceKey).toBe('nyt_archive');
    expect(adapter().kind).toBe('newsapi');
  });

  it('throws when the API key is missing, and never on a present one', () => {
    expect(() => new NytArchiveAdapter({ apiKey: undefined })).toThrow(/NYT_API_KEY/);
    expect(() => new NytArchiveAdapter({ apiKey: '   ' })).toThrow(/NYT_API_KEY/);
    expect(() => new NytArchiveAdapter({ apiKey: 'k' })).not.toThrow();
  });

  it('emits FetchedItem-valid rows and drops what cannot be interpreted', async () => {
    const { items, nextCursor } = await adapter({ fetchImpl: stubFetch(archiveSample) }).fetchSince(
      null,
    );

    // 6 docs in, 3 out: Sports section, multimedia document_type, and the
    // blank-headline record are each dropped.
    expect(items).toHaveLength(3);
    for (const item of items) {
      expect(() => FetchedItem.parse(item)).not.toThrow();
    }
    expect(items.map((i) => i.headline)).toEqual([
      'Fed Holds Rates Steady but Opens the Door to a September Cut',
      'Nepal Floods Cripple Hydropower, Darkening Half the Country',
      'Reinsurers Reprice Asian Hydro Risk After a Brutal Monsoon',
    ]);
    expect(nextCursor).toBe('2026-07');
  });

  it('carries the abstract as the body and NEVER the lead paragraph', async () => {
    // Load-bearing. The live RSS path only ever supplies the abstract, so a
    // backfill that leaked lead_paragraph would show the interpreter richer
    // text in backtests than production can ever get — inflating any measured
    // edge. The fixture's lead paragraphs are deliberately distinctive.
    const { items } = await adapter({ fetchImpl: stubFetch(archiveSample) }).fetchSince(null);

    const fed = items[0];
    expect(fed?.body).toBe(
      'Policymakers held rates steady but signaled that a cut could come as soon as September.',
    );
    for (const item of items) {
      expect(item.body ?? '').not.toContain('WASHINGTON');
      expect(item.body ?? '').not.toContain('KATHMANDU');
      expect(item.body ?? '').not.toContain('Reinsurers have begun to reprice');
    }
  });

  it('falls back to snippet when abstract is null, and omits body when both are', async () => {
    const { items } = await adapter({ fetchImpl: stubFetch(archiveSample) }).fetchSince(null);

    // The reinsurers doc has abstract=null AND snippet=null; only
    // lead_paragraph carries text, which we refuse to read — so no body.
    const reinsurers = items.find((i) => i.headline.startsWith('Reinsurers'));
    expect(reinsurers).toBeDefined();
    expect(reinsurers?.body).toBeUndefined();
  });

  it('sets receivedAtOverride from pub_date, matching publishedAt exactly', async () => {
    const { items } = await adapter({ fetchImpl: stubFetch(archiveSample) }).fetchSince(null);

    const fed = items[0];
    expect(fed?.publishedAt).toBe('2026-07-03T18:04:11.000Z');
    // Identical by construction: the backfill's only claim to a timeline
    // position IS the published date. A drift between the two would mean one
    // of them was invented.
    expect(fed?.receivedAtOverride).toBe(fed?.publishedAt);
    for (const item of items) {
      expect(item.receivedAtOverride).toBe(item.publishedAt);
    }
  });

  it('marks every row as backfill and records the section for later filtering', async () => {
    const { items } = await adapter({ fetchImpl: stubFetch(archiveSample) }).fetchSince(null);

    for (const item of items) {
      expect(item.meta?.['backfill']).toBe(true);
    }
    const nepal = items.find((i) => i.headline.startsWith('Nepal'));
    expect(nepal?.meta?.['sectionName']).toBe('World');
    expect(nepal?.meta?.['subsectionName']).toBe('Asia Pacific');
    expect(nepal?.meta?.['kicker']).toBe('Asia Pacific');
    expect(nepal?.meta?.['archiveMonth']).toBe('2026-07');
  });

  it('normalizes word_count from string, number, and garbage', async () => {
    const { items } = await adapter({ fetchImpl: stubFetch(archiveSample) }).fetchSince(null);

    expect(items.find((i) => i.headline.startsWith('Fed'))?.meta?.['wordCount']).toBe(1184);
    expect(items.find((i) => i.headline.startsWith('Nepal'))?.meta?.['wordCount']).toBe(903);
    // "not-a-number" must become null rather than NaN — NaN survives JSON as
    // null anyway, so normalizing here keeps meta honest at the source.
    expect(items.find((i) => i.headline.startsWith('Reinsurers'))?.meta?.['wordCount']).toBeNull();
  });

  it('keeps only keyword values that exist', async () => {
    const { items } = await adapter({ fetchImpl: stubFetch(archiveSample) }).fetchSince(null);

    // The reinsurers doc has a second keyword with a name but no value.
    expect(items.find((i) => i.headline.startsWith('Reinsurers'))?.meta?.['keywords']).toEqual([
      'Insurance',
    ]);
  });

  it('preserves the verbatim doc as raw', async () => {
    const { items } = await adapter({ fetchImpl: stubFetch(archiveSample) }).fetchSince(null);

    // lead_paragraph must still reach the raw store even though the pipeline
    // refuses to read it — the raw payload is the audit record, not the input.
    const raw = items[0]?.raw as Record<string, unknown>;
    expect(raw['lead_paragraph']).toContain('WASHINGTON');
    expect(raw['_id']).toBe('nyt://article/aaaa1111-0000-4000-8000-000000000001');
  });

  it('requests the cursor month and puts the key in the query string', async () => {
    const captured: Captured = {};
    await adapter({ fetchImpl: stubFetch(archiveSample, captured) }).fetchSince(null);

    expect(captured.url).toContain('/svc/archive/v1/2026/7.json');
    expect(captured.url).toContain('api-key=test-key');
  });

  describe('cursor walk', () => {
    it('starts at startMonth on a null cursor and advances one month per fetch', async () => {
      const walker = new NytArchiveAdapter({
        apiKey: 'k',
        startMonth: '2026-01',
        endMonth: '2026-12',
        fetchImpl: stubFetch(archiveSample),
      });

      expect((await walker.fetchSince(null)).nextCursor).toBe('2026-01');
      expect((await walker.fetchSince('2026-01')).nextCursor).toBe('2026-02');
      expect((await walker.fetchSince('2026-11')).nextCursor).toBe('2026-12');
    });

    it('holds the cursor and returns nothing once past endMonth', async () => {
      // The "done" signal. A scheduled poller keeps calling forever, so the
      // completed walk must be a cheap no-op rather than a restart or a spin.
      const done = new NytArchiveAdapter({
        apiKey: 'k',
        startMonth: '2026-01',
        endMonth: '2026-07',
        fetchImpl: () => {
          throw new Error('must not fetch past endMonth');
        },
      });

      const result = await done.fetchSince('2026-07');
      expect(result.items).toEqual([]);
      expect(result.nextCursor).toBe('2026-07');
    });

    it('stops at the last COMPLETE month, never the month in progress', async () => {
      // The archive 403s on the in-progress month (verified 2026-08-31: June
      // returned 200, August 403). Defaulting to the current month therefore
      // guaranteed a failed poll at the end of every walk.
      const capped = new NytArchiveAdapter({
        apiKey: 'k',
        startMonth: '2026-01',
        now: () => new Date('2026-03-15T12:00:00Z'),
        fetchImpl: stubFetch(archiveSample),
      });

      expect((await capped.fetchSince('2026-01')).nextCursor).toBe('2026-02');
      // March is in progress, so the walk stops after February.
      const past = await capped.fetchSince('2026-02');
      expect(past.items).toEqual([]);
      expect(past.nextCursor).toBe('2026-02');
    });

    it('rolls back across the year boundary in January', () => {
      expect(lastCompleteMonth(new Date('2026-01-04T00:00:00Z'))).toBe('2025-12');
      expect(lastCompleteMonth(new Date('2026-08-31T23:59:59Z'))).toBe('2026-07');
    });
  });

  it('rejects malformed months rather than guessing', () => {
    expect(() => parseMonth('2026-13')).toThrow(/Invalid NYT archive month/);
    expect(() => parseMonth('2026-00')).toThrow(/Invalid NYT archive month/);
    expect(() => parseMonth('2026-7')).toThrow(/Invalid NYT archive month/);
    expect(() => parseMonth('July 2026')).toThrow(/Invalid NYT archive month/);
    expect(() => new NytArchiveAdapter({ apiKey: 'k', startMonth: 'nope' })).toThrow(
      /Invalid NYT archive month/,
    );
    expect(() => new NytArchiveAdapter({ apiKey: 'k', endMonth: '2026-99' })).toThrow(
      /Invalid NYT archive month/,
    );
  });

  it('rolls the year at December', () => {
    expect(nextMonth('2026-12')).toBe('2027-01');
    expect(nextMonth('2026-01')).toBe('2026-02');
    expect(formatMonth(2026, 7)).toBe('2026-07');
  });

  it('throws on format drift instead of ingesting a partial month', async () => {
    const drifted = adapter({
      fetchImpl: stubFetch({ status: 'OK', response: { docs: [{ web_url: 'x' }] } }),
    });
    // A doc missing _id and pub_date is unusable; a defensive parser must not
    // quietly return zero items and let the cursor advance past the month.
    await expect(drifted.fetchSince(null)).rejects.toThrow();
  });

  it('never leaks the API key into an error message', async () => {
    const failing = new NytArchiveAdapter({
      apiKey: 'super-secret-key',
      startMonth: '2026-07',
      endMonth: '2026-07',
      fetchImpl: async () => new Response('nope', { status: 429, statusText: 'Too Many Requests' }),
    });

    // fetchText embeds the failing URL — which carries the key — in its
    // message, so an unsanitized rethrow would print the secret to a log.
    await expect(failing.fetchSince(null)).rejects.toThrow(/\[REDACTED\]/);
    await expect(failing.fetchSince(null)).rejects.not.toThrow(/super-secret-key/);
  });

  it('redactKey leaves a message alone when the key is empty', () => {
    expect(redactKey('GET https://x?api-key=abc failed', 'abc')).toContain('[REDACTED]');
    expect(redactKey('untouched', '')).toBe('untouched');
  });
});

describe('the live API shape (captured 2026-07)', () => {
  it('parses keywords: null instead of failing the whole month', async () => {
    // The bug this fixture exists for. 220 of 4,111 real docs carry
    // `keywords: null`; an `optional()` array rejected them, and because the
    // parse covers the entire month, one untagged article lost every article.
    const { items } = await adapter({ fetchImpl: stubFetch(liveSample) }).fetchSince(null);
    const live = items.find((i) => i.headline.startsWith('Russia Bombards'));
    expect(live).toBeDefined();
    expect(live?.meta?.['keywords']).toEqual([]);
  });

  it('keeps news and drops commentary, using the real section and material labels', async () => {
    const { items } = await adapter({ fetchImpl: stubFetch(liveSample) }).fetchSince(null);

    const kept = items.map((i) => i.headline);
    // Weather is KEPT deliberately: a heat wave is a macro event with a
    // transmission mechanism, which is the whole reason for this source.
    expect(kept.some((h) => h.startsWith('Heat Wave Spreads East'))).toBe(true);
    expect(kept.some((h) => h.startsWith('Judges Strike Down'))).toBe(true);
    // An Op-Ed comments on an event that already arrived via its own item.
    expect(kept.some((h) => h === 'How to World Cup')).toBe(false);
    // Gameplay and a Food letter cannot carry a market event at all.
    expect(kept.some((h) => h.startsWith('Designation for a Potato'))).toBe(false);
    expect(kept.some((h) => h.startsWith('These Hot Dogs'))).toBe(false);
  });

  it('omits body when the live abstract is blank rather than emitting an empty string', async () => {
    const { items } = await adapter({ fetchImpl: stubFetch(liveSample) }).fetchSince(null);
    for (const item of items) {
      expect(item.body === undefined || item.body.length > 0).toBe(true);
    }
  });

  it('reads word_count as a number on live docs', async () => {
    const { items } = await adapter({ fetchImpl: stubFetch(liveSample) }).fetchSince(null);
    const heat = items.find((i) => i.headline.startsWith('Heat Wave'));
    expect(typeof heat?.meta?.['wordCount']).toBe('number');
  });

  it('still refuses lead_paragraph when the field comes back', async () => {
    // The live API dropped the field entirely; the published sample still has
    // it. If NYT restores it, this must keep failing closed — otherwise
    // backfill silently starts feeding richer text than live RSS can.
    const { items } = await adapter({ fetchImpl: stubFetch(archiveSample) }).fetchSince(null);
    for (const item of items) {
      expect(item.body ?? '').not.toContain('WASHINGTON');
    }
  });
});

describe('nytArchiveAdapter factory', () => {
  it('reads env and honours the documented default start month', () => {
    const built = nytArchiveAdapter({ NYT_API_KEY: 'k' });
    expect(built.sourceKey).toBe('nyt_archive');
    expect(DEFAULT_ARCHIVE_START_MONTH).toBe('2026-07');
  });

  it('throws when NYT_API_KEY is absent', () => {
    expect(() => nytArchiveAdapter({})).toThrow(/NYT_API_KEY/);
  });
});

describe('NYT_RSS_PRESETS', () => {
  it('is spread into RSS_PRESETS so the live poller picks the feeds up', () => {
    for (const key of Object.keys(NYT_RSS_PRESETS)) {
      expect(RSS_PRESETS).toHaveProperty(key);
    }
  });

  it('uses the rss.nytimes.com host and a distinct sourceKey per feed', () => {
    const keys = new Set<string>();
    for (const preset of Object.values(NYT_RSS_PRESETS)) {
      expect(preset.feedUrl).toMatch(/^https:\/\/rss\.nytimes\.com\/services\/xml\/rss\/nyt\//);
      expect(preset.sourceKey.startsWith('nyt_')).toBe(true);
      keys.add(preset.sourceKey);
    }
    expect(keys.size).toBe(Object.keys(NYT_RSS_PRESETS).length);
  });

  it('does not collide with the archive adapter sourceKey', () => {
    // Both write to raw_news_items keyed on (source_id, external_id); a shared
    // sourceKey would make live and backfilled rows fight over the same source.
    const archiveKey = new NytArchiveAdapter({ apiKey: 'k' }).sourceKey;
    for (const preset of Object.values(NYT_RSS_PRESETS)) {
      expect(preset.sourceKey).not.toBe(archiveKey);
    }
  });
});
