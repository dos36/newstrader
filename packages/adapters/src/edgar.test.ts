import { readFileSync } from 'node:fs';

import { FetchedItem } from '@newstrader/core';
import { describe, expect, it, vi } from 'vitest';

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

  it('does not warn cursor-not-found on an EMPTY feed (quiet weekends)', async () => {
    // An empty feed proves nothing was missed; warning every poll cycle for
    // days trained operators to ignore the overflow signal that matters.
    const empty = '<?xml version="1.0"?><feed xmlns="http://www.w3.org/2005/Atom"></feed>';
    const warns: unknown[] = [];
    const spy = vi.spyOn(console, 'warn').mockImplementation((line) => void warns.push(line));
    try {
      const { items, nextCursor } = await adapter(stubFetch(empty)).fetchSince(NEWEST);
      expect(items).toHaveLength(0);
      expect(nextCursor).toBe(NEWEST);
      expect(warns).toHaveLength(0);
    } finally {
      spy.mockRestore();
    }
  });

  it('still warns cursor-not-found when the feed HAS entries but not the cursor', async () => {
    const warns: string[] = [];
    const spy = vi
      .spyOn(console, 'warn')
      .mockImplementation((line) => void warns.push(String(line)));
    try {
      await adapter(stubFetch(fixture)).fetchSince('0000000000-99-000001');
      expect(warns).toHaveLength(1);
      expect(warns[0]).toContain('edgar_cursor_not_found');
    } finally {
      spy.mockRestore();
    }
  });
});

describe('EdgarAdapter form-type filtering (getcurrent type= prefix-matches)', () => {
  // Shape-faithful minimal Atom entries matching the real feed's markup. The
  // junk types (424B2, 497K) are the exact ones observed flooding the live
  // type=4 feed for 27 days before this filter existed.
  const entryXml = (accession: string, formType: string, title: string): string => `
    <entry>
      <title>${title}</title>
      <link rel="alternate" href="https://www.sec.gov/Archives/edgar/data/1/${accession}-index.htm"/>
      <summary type="html">Filed with the SEC.</summary>
      <updated>2026-08-05T12:00:00-04:00</updated>
      <category scheme="https://www.sec.gov/form-type" label="form type" term="${formType}"/>
      <id>urn:tag:sec.gov,2008:accession-number=${accession}</id>
    </entry>`;

  const feedXml = (entries: string): string =>
    `<?xml version="1.0" encoding="ISO-8859-1"?>
     <feed xmlns="http://www.w3.org/2005/Atom">${entries}</feed>`;

  const form4Adapter = (): EdgarAdapter =>
    new EdgarAdapter({ formType: '4', userAgent: 'Test Person test@example.com' });

  const JUNK_NEWEST = '0001665650-26-900001'; // 424B2, newest entry in the feed
  const mixedFeed = feedXml(
    [
      entryXml(
        JUNK_NEWEST,
        '424B2',
        '424B2 - JPMorgan Chase Financial Co. LLC (0001665650) (Filer)',
      ),
      entryXml('0000000004-26-000002', '4', '4 - Doe John (0000000004) (Reporting)'),
      entryXml('0000000004-26-000003', '4/A', '4/A - Roe Jane (0000000005) (Reporting)'),
      entryXml('0000000497-26-000004', '497K', '497K - Some Fund Trust (0000000497) (Filer)'),
    ].join(''),
  );

  it('keeps only the 4/4A family; 424B2 and 497K junk never become items', () => {
    const { items } = form4Adapter().parseFeed(mixedFeed, null);
    // Feed order is newest-first; parseFeed emits oldest-first.
    expect(items.map((i) => i.meta?.['formType'])).toEqual(['4/A', '4']);
  });

  it('the cursor remains a FEED position: junk entries still advance and stop it', () => {
    // Newest entry is junk — the saved cursor must still point at it, so the
    // next poll stops immediately instead of re-walking the page.
    const first = form4Adapter().parseFeed(mixedFeed, null);
    expect(first.nextCursor).toBe(JUNK_NEWEST);
    const second = form4Adapter().parseFeed(mixedFeed, JUNK_NEWEST);
    expect(second.items).toHaveLength(0);
    expect(second.nextCursor).toBe(JUNK_NEWEST);
  });

  it('8-K keeps its genuine family variants (8-K/A, 8-K12B)', () => {
    const eightKFeed = feedXml(
      [
        entryXml('0000000008-26-000001', '8-K', '8-K - Acme Corp (0000000008) (Filer)'),
        entryXml('0000000008-26-000002', '8-K/A', '8-K/A - Acme Corp (0000000008) (Filer)'),
        entryXml('0000000008-26-000003', '8-K12B', '8-K12B - Acme Corp (0000000008) (Filer)'),
      ].join(''),
    );
    const { items } = adapter().parseFeed(eightKFeed, null);
    expect(items).toHaveLength(3);
  });

  it('an entry with a MISSING category term is kept (fail-open for format drift)', () => {
    const noTermEntry = `
      <entry>
        <title>4 - Poe Edgar (0000000006) (Reporting)</title>
        <link rel="alternate" href="https://www.sec.gov/Archives/edgar/data/1/0000000004-26-000009-index.htm"/>
        <summary type="html">Filed with the SEC.</summary>
        <updated>2026-08-05T12:00:00-04:00</updated>
        <id>urn:tag:sec.gov,2008:accession-number=0000000004-26-000009</id>
      </entry>`;
    const { items } = form4Adapter().parseFeed(feedXml(noTermEntry), null);
    expect(items).toHaveLength(1);
  });
});
