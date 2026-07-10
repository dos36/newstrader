import { readFileSync } from 'node:fs';

import { FetchedItem } from '@newstrader/core';
import { describe, expect, it } from 'vitest';

import type { FetchLike } from './http.js';
import { MassiveNewsAdapter, massiveNewsAdapter } from './massive-news.js';

const docsSample: unknown = JSON.parse(
  readFileSync(new URL('./__fixtures__/massive-news.json', import.meta.url), 'utf8'),
);
const multiSample: unknown = JSON.parse(
  readFileSync(new URL('./__fixtures__/massive-news-multi.json', import.meta.url), 'utf8'),
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

function adapter(fetchImpl?: FetchLike): MassiveNewsAdapter {
  return new MassiveNewsAdapter({
    apiKey: 'test-key',
    ...(fetchImpl !== undefined ? { fetchImpl } : {}),
  });
}

describe('MassiveNewsAdapter construction', () => {
  it('throws a clear error when MASSIVE_API_KEY is unset', () => {
    expect(() => new MassiveNewsAdapter({ apiKey: undefined })).toThrow(/MASSIVE_API_KEY/);
    expect(() => new MassiveNewsAdapter({ apiKey: '' })).toThrow(/MASSIVE_API_KEY/);
  });

  it('factory defaults the base URL and honors MASSIVE_BASE_URL', async () => {
    const captured: Captured = {};
    const fromEnv = massiveNewsAdapter(
      { MASSIVE_API_KEY: 'k', MASSIVE_BASE_URL: 'https://example-base.test' },
      stubFetch({ status: 'OK', results: [] }, captured),
    );
    await fromEnv.fetchSince('2026-07-10T00:00:00Z');
    expect(captured.url).toMatch(/^https:\/\/example-base\.test\/v2\/reference\/news\?/);
    expect(fromEnv.sourceKey).toBe('massive_news');
    expect(fromEnv.kind).toBe('newsapi');
  });
});

describe('MassiveNewsAdapter request', () => {
  it('queries /v2/reference/news ascending from the cursor minus the overlap window', async () => {
    // Capture the FIRST request: the docs fixture carries a next_url, so
    // fetchSince legitimately issues a follow-up page request after it.
    const requests: { url: string; init?: RequestInit | undefined }[] = [];
    const fetchImpl: FetchLike = async (url, init) => {
      requests.push({ url, init });
      return new Response(JSON.stringify(docsSample), {
        status: 200,
        headers: { 'content-type': 'application/json' },
      });
    };
    await adapter(fetchImpl).fetchSince('2024-06-24T00:00:00Z');

    const first = requests[0];
    const url = new URL(first?.url ?? '');
    expect(url.origin).toBe('https://api.polygon.io');
    expect(url.pathname).toBe('/v2/reference/news');
    expect(url.searchParams.get('order')).toBe('asc');
    expect(url.searchParams.get('sort')).toBe('published_utc');
    expect(url.searchParams.get('limit')).toBe('100');
    // .gte at cursor - 5 min: the vendor-late-arrival overlap re-fetch.
    expect(url.searchParams.get('published_utc.gte')).toBe('2024-06-23T23:55:00.000Z');
    // Key travels as Authorization: Bearer — never in the URL (log hygiene).
    expect(url.searchParams.get('apiKey')).toBeNull();
    const headers = first?.init?.headers as Record<string, string>;
    expect(headers['Authorization']).toBe('Bearer test-key');
  });

  it('bounds the first poll (null cursor) to the initial lookback window', async () => {
    const captured: Captured = {};
    const before = Date.now();
    await adapter(stubFetch({ status: 'OK', results: [] }, captured)).fetchSince(null);

    const gte = new URL(captured.url ?? '').searchParams.get('published_utc.gte');
    expect(gte).not.toBeNull();
    const gteMs = Date.parse(gte ?? '');
    expect(gteMs).toBeGreaterThanOrEqual(before - 61 * 60 * 1000);
    expect(gteMs).toBeLessThanOrEqual(Date.now());
  });

  it('throws on non-2xx responses', async () => {
    const failing: FetchLike = async () =>
      new Response('nope', { status: 401, statusText: 'Unauthorized' });
    await expect(adapter(failing).fetchSince(null)).rejects.toThrow(/401/);
  });
});

describe('MassiveNewsAdapter parsing', () => {
  it('maps the documented sample response onto FetchedItem', async () => {
    const { items, nextCursor } = await adapter(stubFetch(docsSample)).fetchSince(null);

    expect(items).toHaveLength(1);
    const item = items[0];
    expect(item?.externalId).toBe(
      '8ec638777ca03b553ae516761c2a22ba2fdd2f37befae3ab6fdab74e9e5193eb',
    );
    expect(item?.headline).toContain('Markets are underestimating Fed cuts');
    expect(item?.symbolsHint).toEqual(['UBS']);
    expect(item?.body).toContain('UBS analysts warn');
    expect(item?.publishedAt).toBe('2024-06-24T18:33:53.000Z');
    expect(item?.url).toContain('https://uk.investing.com/');
    const sentiment = item?.meta?.['sentiment'] as Array<Record<string, unknown>>;
    expect(sentiment[0]?.['sentiment']).toBe('positive');
    expect(sentiment[0]?.['ticker']).toBe('UBS');
    expect(item?.meta?.['publisher']).toBe('Investing.com');
    expect(nextCursor).toBe('2024-06-24T18:33:53Z');
  });

  it('handles multi-ticker hints and articles without insights', async () => {
    const { items } = await adapter(stubFetch(multiSample)).fetchSince(null);

    expect(items).toHaveLength(3);
    expect(items[1]?.symbolsHint).toEqual(['BETA', 'GMMA']);
    expect(items[2]?.symbolsHint).toEqual([]);
    expect(items[2]?.meta?.['sentiment']).toBeUndefined();
  });

  it('every parsed item satisfies the FetchedItem contract', async () => {
    const { items } = await adapter(stubFetch(multiSample)).fetchSince(null);
    for (const item of items) {
      expect(() => FetchedItem.parse(item)).not.toThrow();
    }
  });
});

describe('MassiveNewsAdapter cursor', () => {
  it('advances the cursor to the last (max) published_utc of the page', async () => {
    const { nextCursor } = await adapter(stubFetch(multiSample)).fetchSince('2026-07-10T13:00:00Z');
    expect(nextCursor).toBe('2026-07-10T14:10:00Z');
  });

  it('keeps the previous cursor when the page is empty', () => {
    const result = adapter().parseResponse({ status: 'OK', results: [] }, '2026-07-10T13:00:00Z');
    expect(result.items).toHaveLength(0);
    expect(result.nextCursor).toBe('2026-07-10T13:00:00Z');
  });

  it('never moves the cursor backwards when the overlap re-fetch returns only old items', () => {
    // multiSample's max published_utc is 2026-07-10T14:10:00Z; a stored cursor
    // AHEAD of that must win (the .gte overlap re-serves older items).
    const result = adapter().parseResponse(multiSample, '2026-07-10T15:00:00Z');
    expect(result.nextCursor).toBe('2026-07-10T15:00:00Z');
  });

  it('follows next_url pages but stops when a page contributes nothing new', async () => {
    // The stub serves the SAME payload (which carries a next_url) for every
    // request: page 1 contributes the item, page 2 duplicates it → stop.
    const urls: string[] = [];
    const fetchImpl: FetchLike = async (url) => {
      urls.push(url);
      return new Response(JSON.stringify(docsSample), {
        status: 200,
        headers: { 'content-type': 'application/json' },
      });
    };
    const { items } = await adapter(fetchImpl).fetchSince(null);
    expect(items).toHaveLength(1);
    expect(urls).toHaveLength(2);
    expect(urls[1]).toContain('cursor=');
  });
});
