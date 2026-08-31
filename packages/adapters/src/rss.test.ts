import { readFileSync } from 'node:fs';

import { FetchedItem } from '@newstrader/core';
import { describe, expect, it } from 'vitest';

import type { FetchLike } from './http.js';
import { RSS_PRESETS, RssAdapter, rssPresetAdapters } from './rss.js';

const gnwFixture = readFileSync(
  new URL('./__fixtures__/globenewswire.rss.xml', import.meta.url),
  'utf8',
);
const coindeskFixture = readFileSync(
  new URL('./__fixtures__/coindesk.rss.xml', import.meta.url),
  'utf8',
);
const edgarAtomFixture = readFileSync(
  new URL('./__fixtures__/edgar-8k.atom.xml', import.meta.url),
  'utf8',
);

function adapter(sourceKey = 'test_feed'): RssAdapter {
  return new RssAdapter({ sourceKey, feedUrl: 'https://feed.test/rss' });
}

/** Minimal RSS 2.0 doc; items given as raw <item>…</item> strings. */
function rssDoc(...items: string[]): string {
  return `<?xml version="1.0"?><rss version="2.0"><channel><title>t</title>${items.join('')}</channel></rss>`;
}

describe('RssAdapter parsing — real fixtures', () => {
  it('parses the GlobeNewswire RSS 2.0 feed (guid permalink, stock categories)', () => {
    const { items, nextCursor } = adapter('globenewswire').parseFeed(gnwFixture, null);

    expect(items).toHaveLength(20);
    const first = items[0];
    expect(first?.externalId).toContain(
      'https://www.globenewswire.com/news-release/2026/07/10/3325769/',
    );
    expect(first?.headline).toContain('Burtech Acquisition Corp II');
    expect(first?.publishedAt).toBe('2026-07-10T21:26:00.000Z'); // "Fri, 10 Jul 2026 21:26 GMT"
    expect(first?.meta?.['categories']).toContain('Nasdaq:BRKH');
    expect(first?.body).not.toContain('<p>'); // HTML stripped from description
    expect(nextCursor).not.toBeNull();
  });

  it('parses the CoinDesk RSS 2.0 feed (non-permalink guid)', () => {
    const { items } = adapter('coindesk').parseFeed(coindeskFixture, null);

    expect(items).toHaveLength(25);
    const first = items[0];
    expect(first?.externalId).toBe('43668787-f6f5-4e92-8155-ba541c96beef');
    expect(first?.headline).toContain('Agentic Commerce');
    expect(first?.meta?.['author']).toBe('Sam Ewen');
  });

  it('parses Atom feeds through the same adapter (entry id as externalId)', () => {
    const { items } = adapter('atom_feed').parseFeed(edgarAtomFixture, null);

    expect(items).toHaveLength(40);
    const known = items.find(
      (i) => i.externalId === 'urn:tag:sec.gov,2008:accession-number=0001193125-26-301052',
    );
    expect(known).toBeDefined();
    expect(known?.url).toContain('https://www.sec.gov/Archives/');
    expect(known?.publishedAt).toBe('2026-07-10T21:29:46.000Z');
  });

  it('every parsed item satisfies the FetchedItem contract', () => {
    for (const fixture of [gnwFixture, coindeskFixture]) {
      const { items } = adapter().parseFeed(fixture, null);
      for (const item of items) {
        expect(() => FetchedItem.parse(item)).not.toThrow();
      }
    }
  });
});

describe('RssAdapter externalId fallback chain', () => {
  it('falls back guid → link when guid is missing', () => {
    const noGuid =
      '<item><title>No guid here</title><link>https://feed.test/a1</link>' +
      '<pubDate>Fri, 10 Jul 2026 12:00:00 GMT</pubDate></item>';
    const { items } = adapter().parseFeed(rssDoc(noGuid), null);

    expect(items).toHaveLength(1);
    expect(items[0]?.externalId).toBe('https://feed.test/a1');
  });

  it('prefers guid over link when both exist', () => {
    const withGuid =
      '<item><title>Has guid</title><guid isPermaLink="false">id-123</guid>' +
      '<link>https://feed.test/a2</link></item>';
    const { items } = adapter().parseFeed(rssDoc(withGuid), null);

    expect(items[0]?.externalId).toBe('id-123');
    expect(items[0]?.url).toBe('https://feed.test/a2');
  });

  it('drops items with no guid, no id, and no link', () => {
    const orphan = '<item><title>Unidentifiable</title></item>';
    const { items } = adapter().parseFeed(rssDoc(orphan), null);
    expect(items).toHaveLength(0);
  });

  it('drops items without a title', () => {
    const untitled = '<item><guid>id-9</guid><link>https://feed.test/a9</link></item>';
    const { items } = adapter().parseFeed(rssDoc(untitled), null);
    expect(items).toHaveLength(0);
  });
});

describe('RssAdapter cursor (guid-set)', () => {
  const itemA = '<item><title>A</title><guid>guid-a</guid></item>';
  const itemB = '<item><title>B</title><guid>guid-b</guid></item>';
  const itemC = '<item><title>C</title><guid>guid-c</guid></item>';

  it('first poll returns everything and records the id set', () => {
    const { items, nextCursor } = adapter().parseFeed(rssDoc(itemA, itemB), null);

    expect(items.map((i) => i.externalId)).toEqual(['guid-a', 'guid-b']);
    expect(JSON.parse(nextCursor ?? '[]')).toEqual(['guid-a', 'guid-b']);
  });

  it('re-polling an unchanged feed yields zero items (already-seen ids excluded)', () => {
    const first = adapter().parseFeed(rssDoc(itemA, itemB), null);
    const second = adapter().parseFeed(rssDoc(itemA, itemB), first.nextCursor);

    expect(second.items).toHaveLength(0);
    expect(JSON.parse(second.nextCursor ?? '[]')).toEqual(['guid-a', 'guid-b']);
  });

  it('only new items are emitted; ids that left the feed stay remembered', () => {
    const first = adapter().parseFeed(rssDoc(itemA, itemB), null);
    // Next poll: C appeared, B rotated out of the feed.
    const second = adapter().parseFeed(rssDoc(itemC, itemA), first.nextCursor);

    expect(second.items.map((i) => i.externalId)).toEqual(['guid-c']);
    const remembered = JSON.parse(second.nextCursor ?? '[]') as string[];
    expect(remembered).toContain('guid-b'); // union with previous cursor
    // …so if B flaps back in, it is not re-emitted:
    const third = adapter().parseFeed(rssDoc(itemB, itemC, itemA), second.nextCursor);
    expect(third.items).toHaveLength(0);
  });

  it('treats a malformed cursor as a cold start', () => {
    const { items } = adapter().parseFeed(rssDoc(itemA), 'not-json-at-all');
    expect(items).toHaveLength(1);
  });

  it('keeps the previous cursor when the feed goes empty', () => {
    const first = adapter().parseFeed(rssDoc(itemA), null);
    const empty = adapter().parseFeed(rssDoc(), first.nextCursor);
    expect(empty.items).toHaveLength(0);
    expect(empty.nextCursor).toBe(first.nextCursor);
  });
});

describe('RSS presets', () => {
  it('exposes every verified preset feed, NYT feeds first', () => {
    const adapters = rssPresetAdapters();
    // Asserted as an exact ordered list on purpose: adding a feed should make
    // this fail and force a deliberate edit, because each new preset starts
    // polling in production the moment it lands.
    expect(adapters.map((a) => a.sourceKey)).toEqual([
      'nyt_business',
      'nyt_dealbook',
      'nyt_economy',
      'nyt_technology',
      'nyt_world',
      'nyt_climate',
      'globenewswire',
      'coindesk',
      'cointelegraph',
      'theblock',
    ]);
    for (const a of adapters) {
      expect(a.kind).toBe('rss');
      expect(a.feedUrl).toMatch(/^https:\/\//);
    }
    expect(RSS_PRESETS.coindesk.feedUrl).toBe('https://www.coindesk.com/arc/outboundfeeds/rss');
    expect(RSS_PRESETS.nyt_business.feedUrl).toBe(
      'https://rss.nytimes.com/services/xml/rss/nyt/Business.xml',
    );
  });

  it('sends a User-Agent and Accept header when fetching', async () => {
    let capturedInit: RequestInit | undefined;
    const fetchImpl: FetchLike = async (_url, init) => {
      capturedInit = init;
      return new Response(rssDoc(), { status: 200 });
    };
    const rss = new RssAdapter({ sourceKey: 'x', feedUrl: 'https://feed.test/rss', fetchImpl });
    await rss.fetchSince(null);

    const headers = capturedInit?.headers as Record<string, string>;
    expect(headers['User-Agent']).toContain('NewsTrader');
    expect(headers['Accept']).toContain('application/rss+xml');
  });
});
