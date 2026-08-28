import { describe, expect, it } from 'vitest';

import {
  fetchFilingText,
  filingDirectoryUrl,
  selectFilingDocuments,
  MAX_DOC_CHARS,
  MAX_TOTAL_CHARS,
} from './edgar-documents.js';
import type { FetchLike } from './http.js';

/**
 * The document selector is the whole risk surface: pick the wrong files and the
 * prompt fills with rendered XBRL tables instead of the filing. Both listings
 * below are REAL `index.json` responses (captured 2026-08-21) — Peraso, whose
 * primary document has a vendor-generated name, and Vvos, which has both a
 * plainly-named primary and a press-release exhibit.
 */

const PERASO_LISTING = [
  '0001213900-26-092719-index-headers.html',
  '0001213900-26-092719-index.html',
  '0001213900-26-092719.txt',
  '0001213900-26-092719-xbrl.zip',
  'ea0303091-8k_peraso.htm',
  'ea0303091-8k_peraso_htm.xml',
  'FilingSummary.xml',
  'MetaLinks.json',
  'prso-20260821.xsd',
  'prso-20260821_lab.xml',
  'prso-20260821_pre.xml',
  'R1.htm',
  'report.css',
  'Show.js',
];

const VVOS_LISTING = [
  '0001493152-26-039736-index-headers.html',
  '0001493152-26-039736-index.html',
  '0001493152-26-039736.txt',
  '0001493152-26-039736-xbrl.zip',
  'ex99-1.htm',
  'FilingSummary.xml',
  'form8-k.htm',
  'form8-k_htm.xml',
  'MetaLinks.json',
  'R1.htm',
  'report.css',
  'Show.js',
  'vvos-20260820.xsd',
  'vvos-20260820_lab.xml',
  'vvos-20260820_pre.xml',
];

const INDEX_URL =
  'https://www.sec.gov/Archives/edgar/data/1716166/000149315226039736/0001493152-26-039736-index.htm';
const DIR = 'https://www.sec.gov/Archives/edgar/data/1716166/000149315226039736/';

describe('filingDirectoryUrl', () => {
  it('strips the index file to leave the archive directory', () => {
    expect(filingDirectoryUrl(INDEX_URL)).toBe(DIR);
  });

  it('rejects something that is not a URL path', () => {
    expect(() => filingDirectoryUrl('not-a-url')).toThrow(/Not a filing index URL/);
  });
});

describe('selectFilingDocuments', () => {
  it('keeps the primary document and the press-release exhibit, primary first', () => {
    // form8-k.htm before ex99-1.htm even though the listing is alphabetical:
    // the model should read what the company filed before its own press release.
    expect(selectFilingDocuments(VVOS_LISTING)).toEqual(['form8-k.htm', 'ex99-1.htm']);
  });

  it('finds a vendor-named primary document', () => {
    expect(selectFilingDocuments(PERASO_LISTING)).toEqual(['ea0303091-8k_peraso.htm']);
  });

  it('drops the index pages, XBRL viewer reports, and every non-html artefact', () => {
    const kept = selectFilingDocuments([...PERASO_LISTING, ...VVOS_LISTING]);
    // R1.htm is ~40KB of rendered financial-statement tables — the single
    // biggest way to waste the prompt budget.
    expect(kept).not.toContain('R1.htm');
    expect(kept.some((name) => name.includes('-index'))).toBe(false);
    expect(kept.every((name) => name.endsWith('.htm') || name.endsWith('.html'))).toBe(true);
    // The full-submission .txt repeats every document above, rejects included.
    expect(kept.some((name) => name.endsWith('.txt'))).toBe(false);
  });

  it('caps the number of documents', () => {
    const many = Array.from({ length: 20 }, (_, i) => `ex99-${i}.htm`);
    expect(selectFilingDocuments(many).length).toBeLessThanOrEqual(4);
  });

  it('returns nothing for a listing with no content documents', () => {
    expect(selectFilingDocuments(['form4-08212026.xml', 'x-index.htm', 'R1.htm'])).toEqual([]);
  });
});

/** Fake fetch: a directory listing plus a body per document name. */
function fakeFetch(
  listing: string[],
  bodies: Record<string, string>,
  overrides: { status?: number; failOn?: string; listingBody?: unknown } = {},
): { impl: FetchLike; urls: string[] } {
  const urls: string[] = [];
  const impl: FetchLike = (url) => {
    urls.push(url);
    const ok = (body: unknown): Response =>
      ({
        ok: true,
        status: 200,
        statusText: 'OK',
        json: () => Promise.resolve(body),
        text: () => Promise.resolve(String(body)),
      }) as unknown as Response;
    if (url.endsWith('index.json')) {
      if (overrides.status !== undefined) {
        return Promise.resolve({
          ok: false,
          status: overrides.status,
          statusText: 'Forbidden',
        } as unknown as Response);
      }
      return Promise.resolve(
        ok(overrides.listingBody ?? { directory: { item: listing.map((name) => ({ name })) } }),
      );
    }
    const name = url.slice(DIR.length);
    if (overrides.failOn === name) {
      return Promise.resolve({
        ok: false,
        status: 404,
        statusText: 'Not Found',
      } as unknown as Response);
    }
    return Promise.resolve(ok(bodies[name] ?? ''));
  };
  return { impl, urls };
}

const noSleep = (): Promise<void> => Promise.resolve();

describe('fetchFilingText', () => {
  it('flattens the documents in order with filename headers', async () => {
    const { impl, urls } = fakeFetch(VVOS_LISTING, {
      'form8-k.htm': '<html><body><p>Item 2.02. Results of Operations.</p></body></html>',
      'ex99-1.htm': '<html><body>Revenue rose 12% to $410 million.</body></html>',
    });

    const filing = await fetchFilingText(INDEX_URL, {
      fetchImpl: impl,
      userAgent: 'Tester tester@example.com',
      sleep: noSleep,
    });

    expect(filing.documents.map((doc) => doc.name)).toEqual(['form8-k.htm', 'ex99-1.htm']);
    expect(filing.text).toContain('[form8-k.htm]');
    expect(filing.text).toContain('Item 2.02. Results of Operations.');
    expect(filing.text).toContain('[ex99-1.htm]');
    expect(filing.text).toContain('Revenue rose 12% to $410 million.');
    expect(filing.truncated).toBe(false);
    expect(urls[0]).toBe(`${DIR}index.json`);
  });

  it('sends the SEC contact string on every request', async () => {
    const seen: Array<string | undefined> = [];
    const impl: FetchLike = (url, init) => {
      const headers = init?.headers as Record<string, string> | undefined;
      seen.push(headers?.['User-Agent']);
      if (url.endsWith('index.json')) {
        return Promise.resolve({
          ok: true,
          json: () => Promise.resolve({ directory: { item: [{ name: 'form8-k.htm' }] } }),
        } as unknown as Response);
      }
      return Promise.resolve({
        ok: true,
        text: () => Promise.resolve('body'),
      } as unknown as Response);
    };

    await fetchFilingText(INDEX_URL, {
      fetchImpl: impl,
      userAgent: 'Tester tester@example.com',
      sleep: noSleep,
    });

    expect(seen).toHaveLength(2);
    expect(seen.every((ua) => ua === 'Tester tester@example.com')).toBe(true);
  });

  it('strips script and style bodies rather than feeding them to the model', async () => {
    const { impl } = fakeFetch(['form8-k.htm'], {
      'form8-k.htm': '<style>.a{color:red}</style><script>var x=1;</script><p>Real content.</p>',
    });

    const filing = await fetchFilingText(INDEX_URL, {
      fetchImpl: impl,
      userAgent: 'Tester tester@example.com',
      sleep: noSleep,
    });

    expect(filing.text).toContain('Real content.');
    expect(filing.text).not.toContain('color:red');
    expect(filing.text).not.toContain('var x=1');
  });

  it('caps a single long document and says so', async () => {
    const { impl } = fakeFetch(['form8-k.htm'], {
      'form8-k.htm': 'a'.repeat(MAX_DOC_CHARS + 5000),
    });

    const filing = await fetchFilingText(INDEX_URL, {
      fetchImpl: impl,
      userAgent: 'Tester tester@example.com',
      sleep: noSleep,
    });

    expect(filing.documents[0]?.text.length).toBe(MAX_DOC_CHARS);
    expect(filing.truncated).toBe(true);
  });

  it('caps the total across documents', async () => {
    const { impl } = fakeFetch(['form8-k.htm', 'ex99-1.htm', 'ex99-2.htm'], {
      'form8-k.htm': 'a'.repeat(MAX_DOC_CHARS),
      'ex99-1.htm': 'b'.repeat(MAX_DOC_CHARS),
      'ex99-2.htm': 'c'.repeat(MAX_DOC_CHARS),
    });

    const filing = await fetchFilingText(INDEX_URL, {
      fetchImpl: impl,
      userAgent: 'Tester tester@example.com',
      sleep: noSleep,
    });

    const total = filing.documents.reduce((sum, doc) => sum + doc.text.length, 0);
    expect(total).toBeLessThanOrEqual(MAX_TOTAL_CHARS);
    expect(filing.truncated).toBe(true);
  });

  it('returns no documents (not an error) when the listing has none', async () => {
    const { impl } = fakeFetch(['form4.xml', 'R1.htm'], {});

    const filing = await fetchFilingText(INDEX_URL, {
      fetchImpl: impl,
      userAgent: 'Tester tester@example.com',
      sleep: noSleep,
    });

    expect(filing.documents).toEqual([]);
    expect(filing.text).toBe('');
  });

  it('throws when SEC rejects the listing request', async () => {
    const { impl } = fakeFetch(VVOS_LISTING, {}, { status: 403 });

    await expect(
      fetchFilingText(INDEX_URL, {
        fetchImpl: impl,
        userAgent: 'Tester tester@example.com',
        sleep: noSleep,
      }),
    ).rejects.toThrow(/failed: 403/);
  });

  it('throws when the listing shape drifts', async () => {
    const { impl } = fakeFetch(VVOS_LISTING, {}, { listingBody: { directory: {} } });

    await expect(
      fetchFilingText(INDEX_URL, {
        fetchImpl: impl,
        userAgent: 'Tester tester@example.com',
        sleep: noSleep,
      }),
    ).rejects.toThrow(/listing drifted/);
  });

  it('throws when a document 404s', async () => {
    const { impl } = fakeFetch(VVOS_LISTING, { 'ex99-1.htm': 'x' }, { failOn: 'form8-k.htm' });

    await expect(
      fetchFilingText(INDEX_URL, {
        fetchImpl: impl,
        userAgent: 'Tester tester@example.com',
        sleep: noSleep,
      }),
    ).rejects.toThrow(/failed: 404/);
  });

  it('paces itself between document requests', async () => {
    const delays: number[] = [];
    const { impl } = fakeFetch(VVOS_LISTING, { 'form8-k.htm': 'a', 'ex99-1.htm': 'b' });

    await fetchFilingText(INDEX_URL, {
      fetchImpl: impl,
      userAgent: 'Tester tester@example.com',
      requestDelayMs: 150,
      sleep: (ms) => {
        delays.push(ms);
        return Promise.resolve();
      },
    });

    // One pause before each document fetch — SEC allows 10 req/s.
    expect(delays).toEqual([150, 150]);
  });
});
