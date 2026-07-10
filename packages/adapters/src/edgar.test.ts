import { readFileSync } from 'node:fs';

import { FetchedItem } from '@newstrader/core';
import { describe, expect, it } from 'vitest';

import { EDGAR_FORM_TYPES, EdgarAdapter, edgarAdapters } from './edgar.js';
import type { FetchLike } from './http.js';

const fixture = readFileSync(new URL('./__fixtures__/edgar-8k.atom.xml', import.meta.url), 'utf8');

// Real feed snapshot (2026-07-10): 40 entries, newest-first. The three newest:
const NEWEST = '0001193125-26-301052'; // Cue Biopharma — multi-item 8-K
const SECOND = '0001829126-26-007518';
const THIRD = '0001437749-26-023359';

interface Captured {
  url?: string;
  init?: RequestInit | undefined;
}

function stubFetch(body: string, captured?: Captured): FetchLike {
  return async (url, init) => {
    if (captured) {
      captured.url = url;
      captured.init = init;
    }
    return new Response(body, { status: 200 });
  };
}

function adapter(fetchImpl?: FetchLike): EdgarAdapter {
  return new EdgarAdapter({
    formType: '8-K',
    userAgent: 'Test Person test@example.com',
    ...(fetchImpl !== undefined ? { fetchImpl } : {}),
  });
}

describe('EdgarAdapter construction', () => {
  it('throws a clear error when EDGAR_USER_AGENT is unset', () => {
    expect(() => new EdgarAdapter({ formType: '8-K', userAgent: undefined })).toThrow(
      /EDGAR_USER_AGENT/,
    );
    expect(() => new EdgarAdapter({ formType: '8-K', userAgent: '   ' })).toThrow(
      /EDGAR_USER_AGENT/,
    );
  });

  it('factory returns all four form types with the documented source keys', () => {
    const adapters = edgarAdapters({ EDGAR_USER_AGENT: 'Test Person test@example.com' });
    expect(adapters.map((a) => a.sourceKey)).toEqual([
      'edgar_8k',
      'edgar_form4',
      'edgar_13d',
      'edgar_13g',
    ]);
    expect(adapters.map((a) => a.formType)).toEqual([...EDGAR_FORM_TYPES]);
    for (const a of adapters) expect(a.kind).toBe('sec_edgar');
  });
});

describe('EdgarAdapter fetch', () => {
  it('requests the getcurrent Atom feed with the mandatory User-Agent header', async () => {
    const captured: Captured = {};
    await adapter(stubFetch(fixture, captured)).fetchSince(null);

    expect(captured.url).toContain('https://www.sec.gov/cgi-bin/browse-edgar?action=getcurrent');
    expect(captured.url).toContain('type=8-K');
    expect(captured.url).toContain('output=atom');
    const headers = captured.init?.headers as Record<string, string>;
    expect(headers['User-Agent']).toBe('Test Person test@example.com');
  });

  it('throws on non-2xx responses', async () => {
    const failing: FetchLike = async () =>
      new Response('forbidden', { status: 403, statusText: 'Forbidden' });
    await expect(adapter(failing).fetchSince(null)).rejects.toThrow(/403/);
  });
});

describe('EdgarAdapter parsing', () => {
  it('parses every entry, oldest-first, with accession numbers as externalId', async () => {
    const { items, nextCursor } = await adapter(stubFetch(fixture)).fetchSince(null);

    expect(items).toHaveLength(40);
    expect(items[items.length - 1]?.externalId).toBe(NEWEST); // oldest-first output
    expect(nextCursor).toBe(NEWEST);
    for (const item of items) {
      expect(item.externalId).toMatch(/^\d{10}-\d{2}-\d{6}$/);
    }
  });

  it('extracts multiple 8-K item codes, the CIK, and the filing timestamp', async () => {
    const { items } = await adapter(stubFetch(fixture)).fetchSince(null);
    const cue = items.find((i) => i.externalId === NEWEST);

    expect(cue).toBeDefined();
    expect(cue?.headline).toContain('Cue Biopharma');
    expect(cue?.meta?.['itemCodes']).toEqual(['1.01', '3.02', '5.02', '8.01', '9.01']);
    expect(cue?.meta?.['cik']).toBe('0001645460');
    expect(cue?.meta?.['formType']).toBe('8-K');
    expect(cue?.publishedAt).toBe('2026-07-10T21:29:46.000Z'); // 17:29:46-04:00 in UTC
    expect(cue?.url).toContain('https://www.sec.gov/Archives/edgar/data/1645460/');
    expect(cue?.body).toContain('Item 1.01');
    expect(cue?.body).not.toContain('<b>');
  });

  it('every parsed item satisfies the FetchedItem contract', async () => {
    const { items } = await adapter(stubFetch(fixture)).fetchSince(null);
    for (const item of items) {
      expect(() => FetchedItem.parse(item)).not.toThrow();
    }
  });
});

describe('EdgarAdapter cursor', () => {
  it('stops at the cursor: only entries newer than it are returned', async () => {
    const { items, nextCursor } = await adapter(stubFetch(fixture)).fetchSince(SECOND);

    expect(items.map((i) => i.externalId)).toEqual([NEWEST]);
    expect(nextCursor).toBe(NEWEST);
  });

  it('returns items strictly newer than a mid-feed cursor', async () => {
    const { items } = await adapter(stubFetch(fixture)).fetchSince(THIRD);
    expect(items.map((i) => i.externalId)).toEqual([SECOND, NEWEST]);
  });

  it('returns nothing when the cursor is already the newest entry', async () => {
    const { items, nextCursor } = await adapter(stubFetch(fixture)).fetchSince(NEWEST);

    expect(items).toHaveLength(0);
    expect(nextCursor).toBe(NEWEST);
  });

  it('keeps the previous cursor when the feed has no entries', () => {
    const empty = '<?xml version="1.0"?><feed xmlns="http://www.w3.org/2005/Atom"></feed>';
    const result = adapter().parseFeed(empty, NEWEST);
    expect(result.items).toHaveLength(0);
    expect(result.nextCursor).toBe(NEWEST);
  });
});
