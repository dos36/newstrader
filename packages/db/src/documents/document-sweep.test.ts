/**
 * Document-sweep integration — the queue, the terminal/retryable split, and the
 * remaining count.
 *
 * Own database per the repo rule (`<base>_documents`): a suite that ran against
 * the shared dev database once closed 503 live membership rows.
 */
import { migrate } from 'drizzle-orm/node-postgres/migrator';
import { eq } from 'drizzle-orm';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';

import { newId, type RawStore } from '@newstrader/core';

import { createDb, type Db } from '../client.js';
import { itemDocuments, newsSources, rawNewsItems } from '../schema.js';
import { documentSweep } from './document-sweep.js';
import {
  countFilingFetchCandidates,
  filingDocumentKey,
  loadFilingFetchCandidates,
  recordFilingDocument,
} from './document-repo.js';
import type { FetchLike } from './http.js';

const INDEX_URL =
  'https://www.sec.gov/Archives/edgar/data/1716166/000149315226039736/0001493152-26-039736-index.htm';
const DIR = 'https://www.sec.gov/Archives/edgar/data/1716166/000149315226039736/';
const NOW = new Date('2026-08-21T18:00:00.000Z');

class MemoryStore implements RawStore {
  readonly blobs = new Map<string, unknown>();
  async put(key: string, payload: unknown): Promise<string> {
    this.blobs.set(key, payload);
    return `mem://${key}`;
  }
  async get(ref: string): Promise<unknown> {
    const key = ref.replace(/^mem:\/\//, '');
    if (!this.blobs.has(key)) throw new Error(`MemoryStore: missing ${ref}`);
    return this.blobs.get(key);
  }
}

function okFetch(bodies: Record<string, string>): FetchLike {
  return (url) => {
    if (url.endsWith('index.json')) {
      return Promise.resolve({
        ok: true,
        json: () =>
          Promise.resolve({
            directory: { item: Object.keys(bodies).map((name) => ({ name })) },
          }),
      } as unknown as Response);
    }
    const name = url.slice(DIR.length);
    return Promise.resolve({
      ok: true,
      text: () => Promise.resolve(bodies[name] ?? ''),
    } as unknown as Response);
  };
}

const failingFetch: FetchLike = () =>
  Promise.resolve({ ok: false, status: 500, statusText: 'Server Error' } as unknown as Response);

const testDatabaseUrl = process.env.TEST_DATABASE_URL;

describe.skipIf(!testDatabaseUrl)('documentSweep (integration)', () => {
  let db: Db;
  let store: MemoryStore;

  beforeAll(async () => {
    const url = new URL(testDatabaseUrl as string);
    const base = url.pathname.replace(/^\//, '') || 'postgres';
    const suite = `${base}_documents`.replace(/[^a-zA-Z0-9_]/g, '_');
    const admin = createDb(testDatabaseUrl as string);
    try {
      await admin.$client.query(`create database "${suite}"`);
    } catch (error) {
      if ((error as { code?: string }).code !== '42P04') throw error;
    } finally {
      await admin.$client.end();
    }
    url.pathname = `/${suite}`;
    db = createDb(url.toString());
    await migrate(db, { migrationsFolder: new URL('../../migrations', import.meta.url).pathname });
  }, 60_000);

  afterAll(async () => {
    await wipe();
    await db.$client.end();
  });

  beforeEach(async () => {
    await wipe();
    store = new MemoryStore();
  });

  async function wipe(): Promise<void> {
    await db.delete(itemDocuments);
    await db.delete(rawNewsItems);
    await db.delete(newsSources);
  }

  async function seedItem(input: {
    formType: string;
    url?: string | null;
    kind?: 'sec_edgar' | 'newsapi' | 'rss';
    receivedAt?: Date;
  }): Promise<string> {
    const sourceId = newId();
    await db.insert(newsSources).values({
      id: sourceId,
      sourceKey: `src_${sourceId.slice(-8)}`,
      kind: input.kind ?? 'sec_edgar',
      name: 'test source',
    });
    const itemId = newId();
    await db.insert(rawNewsItems).values({
      id: itemId,
      sourceId,
      externalId: itemId,
      headline: `${input.formType} - Test Co`,
      payloadRef: `payload/${itemId}`,
      contentHash: newId(),
      receivedAt: input.receivedAt ?? NOW,
      ...(input.url === null ? {} : { url: input.url ?? INDEX_URL }),
      meta: { formType: input.formType },
    });
    return itemId;
  }

  it('queues every 8-K variant ingest treats as an 8-K, and nothing else', async () => {
    // Regression: an exact ['8-K','8-K/A'] list left 8-K12B / 8-K12G3 / 8-K15D5
    // permanently unfetched while the queue reported EMPTY — 11 real filings in
    // the local store. The EDGAR adapter accepts the whole 8-K* family as
    // genuine 8-K events (edgar.ts ACCEPTED_FORM_TYPES), so this stage must
    // agree or documents go missing with no signal that anything is wrong.
    for (const form of ['8-K', '8-K/A', '8-K12B', '8-K12G3', '8-K15D5']) {
      await seedItem({ formType: form });
    }
    // Still excluded: the noise forms that carry no interpretable event.
    await seedItem({ formType: '4' });
    await seedItem({ formType: '424B2' });

    const candidates = await loadFilingFetchCandidates(db, { batch: 50, maxAttempts: 3 });

    expect(candidates.map((c) => c.formType).sort()).toEqual([
      '8-K',
      '8-K/A',
      '8-K12B',
      '8-K12G3',
      '8-K15D5',
    ]);
    expect(await countFilingFetchCandidates(db, { maxAttempts: 3 })).toBe(5);
  });

  it('scopes a refetch to stale trimmed filings, and converges', async () => {
    // Two traps here. Re-downloading all 9k filings to fix the 54% that were
    // cut is twice the SEC requests for the same result — and scoping on
    // `truncated` alone never finishes, because a filing longer than the NEW cap
    // comes back truncated again and re-queues forever.
    const trimmed = await seedItem({ formType: '8-K' });
    const whole = await seedItem({ formType: '8-K' });
    await recordFilingDocument(db, {
      itemId: trimmed,
      status: 'ok',
      docRef: 'ref/trimmed',
      charCount: 20_000,
      documentCount: 1,
      truncated: true,
      at: NOW,
    });
    // Trimmed, but already stored by the CURRENT fetcher — nothing to gain.
    const trimmedCurrent = await seedItem({ formType: '8-K' });
    await recordFilingDocument(db, {
      itemId: trimmedCurrent,
      status: 'ok',
      docRef: 'ref/current',
      charCount: 80_000,
      documentCount: 2,
      truncated: true,
      at: NOW,
    });
    await recordFilingDocument(db, {
      itemId: whole,
      status: 'ok',
      docRef: 'ref/whole',
      charCount: 4_000,
      documentCount: 2,
      truncated: false,
      at: NOW,
    });

    // recordFilingDocument stamps the current version, so only the row written
    // under the old one qualifies.
    await db
      .update(itemDocuments)
      .set({ fetcherVersion: 1 })
      .where(eq(itemDocuments.itemId, trimmed));
    const scoped = await loadFilingFetchCandidates(db, {
      batch: 50,
      maxAttempts: 3,
      includeStored: true,
      onlyStale: true,
    });
    expect(scoped.map((c) => c.itemId)).toEqual([trimmed]);

    // A blanket refetch still takes both.
    const all = await loadFilingFetchCandidates(db, {
      batch: 50,
      maxAttempts: 3,
      includeStored: true,
    });
    expect(all).toHaveLength(3);

    // Convergence: re-storing it stamps the current version, so a second stale
    // pass finds nothing even though the filing is STILL truncated.
    await recordFilingDocument(db, {
      itemId: trimmed,
      status: 'ok',
      docRef: 'ref/trimmed',
      charCount: 80_000,
      documentCount: 1,
      truncated: true,
      at: NOW,
    });
    const second = await loadFilingFetchCandidates(db, {
      batch: 50,
      maxAttempts: 3,
      includeStored: true,
      onlyStale: true,
    });
    expect(second).toEqual([]);

    // And a normal pass takes neither — both are already stored.
    expect(await countFilingFetchCandidates(db, { maxAttempts: 3 })).toBe(0);
  });

  function deps(fetchImpl: FetchLike) {
    return {
      store,
      userAgent: 'Tester tester@example.com',
      fetchImpl,
      sleep: (): Promise<void> => Promise.resolve(),
      now: () => NOW,
    };
  }

  it('stores filing text and reports nothing left', async () => {
    const itemId = await seedItem({ formType: '8-K' });

    const result = await documentSweep(
      db,
      deps(
        okFetch({ 'form8-k.htm': '<p>Item 2.02 results.</p>', 'ex99-1.htm': '<p>Revenue up.</p>' }),
      ),
    );

    expect(result).toMatchObject({ examined: 1, stored: 1, empty: 0, failed: 0, remaining: 0 });
    const rows = await db.select().from(itemDocuments);
    expect(rows[0]).toMatchObject({ itemId, status: 'ok', documentCount: 2, truncated: false });
    expect(rows[0]?.docRef).toBe(`mem://${filingDocumentKey(itemId)}`);
    const blob = store.blobs.get(filingDocumentKey(itemId)) as { text: string };
    expect(blob.text).toContain('Item 2.02 results.');
    expect(blob.text).toContain('Revenue up.');
  });

  it('never re-fetches a stored filing', async () => {
    await seedItem({ formType: '8-K' });
    await documentSweep(db, deps(okFetch({ 'form8-k.htm': '<p>x</p>' })));

    const second = await documentSweep(db, deps(failingFetch));

    expect(second).toMatchObject({ examined: 0, remaining: 0 });
  });

  it('leaves the queue alone for forms that carry no event', async () => {
    // Form 4 insider filings and 424B prospectuses are 4% of candidate pairs
    // and would spend the SEC request budget on nothing.
    await seedItem({ formType: '4' });
    await seedItem({ formType: '424B2' });

    const result = await documentSweep(db, deps(failingFetch));

    expect(result).toMatchObject({ examined: 0, remaining: 0 });
  });

  it('honours an explicit form-type list', async () => {
    await seedItem({ formType: '4' });

    const result = await documentSweep(db, deps(okFetch({ 'form4.htm': '<p>y</p>' })), {
      formTypes: ['4'],
    });

    expect(result.stored).toBe(1);
  });

  it('skips an item with no index URL and non-EDGAR sources', async () => {
    await seedItem({ formType: '8-K', url: null });
    await seedItem({ formType: '8-K', kind: 'newsapi' });

    const result = await documentSweep(db, deps(failingFetch));

    expect(result).toMatchObject({ examined: 0, remaining: 0 });
  });

  it('marks a listing with no content documents terminal, not retryable', async () => {
    await seedItem({ formType: '8-K' });

    const first = await documentSweep(db, deps(okFetch({ 'R1.htm': '<p>xbrl</p>' })));

    expect(first).toMatchObject({ examined: 1, empty: 1, stored: 0, remaining: 0 });
    const rows = await db.select().from(itemDocuments);
    expect(rows[0]?.status).toBe('empty');
    // Terminal: a filing that lists no documents today will list none tomorrow.
    expect((await documentSweep(db, deps(failingFetch))).examined).toBe(0);
  });

  it('retries a failure up to the cap, then drops it from the queue', async () => {
    const itemId = await seedItem({ formType: '8-K' });

    for (const expectedRemaining of [1, 1, 0]) {
      const pass = await documentSweep(db, deps(failingFetch));
      expect(pass.failed).toBe(1);
      expect(pass.remaining).toBe(expectedRemaining);
    }

    const row = (await db.select().from(itemDocuments).where(eq(itemDocuments.itemId, itemId)))[0];
    expect(row?.status).toBe('failed');
    expect(row?.attempts).toBe(3);
    expect(row?.lastError).toContain('500');
    // A fourth pass sees nothing — one unreachable filing cannot stall forever.
    expect((await documentSweep(db, deps(failingFetch))).examined).toBe(0);
  });

  it('one bad filing does not stop the rest of the pass', async () => {
    await seedItem({ formType: '8-K', url: INDEX_URL, receivedAt: new Date(NOW.getTime() - 1000) });
    // A DIFFERENT archive directory — the failing URL has to differ in the
    // directory part, since that is what the listing request is built from.
    await seedItem({
      formType: '8-K',
      url: 'https://www.sec.gov/Archives/edgar/data/999/000099900026000001/other-index.htm',
    });
    let call = 0;
    // Match on the CIK path segment: the filename is stripped before the
    // listing request, so the directory is the only thing left to match on.
    const flaky: FetchLike = (url) => {
      if (url.includes('/data/999/')) return failingFetch(url);
      call += 1;
      return okFetch({ 'form8-k.htm': '<p>fine</p>' })(url);
    };

    const result = await documentSweep(db, deps(flaky));

    expect(result).toMatchObject({ examined: 2, stored: 1, failed: 1 });
    expect(call).toBeGreaterThan(0);
  });

  it('reports how many are left when the batch is smaller than the queue', async () => {
    for (let i = 0; i < 3; i += 1) {
      await seedItem({ formType: '8-K', receivedAt: new Date(NOW.getTime() - i * 1000) });
    }

    const first = await documentSweep(db, deps(okFetch({ 'form8-k.htm': '<p>z</p>' })), {
      batch: 1,
    });

    expect(first).toMatchObject({ examined: 1, stored: 1, remaining: 2 });
  });
});
