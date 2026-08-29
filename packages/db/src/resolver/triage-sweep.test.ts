/**
 * Resolver r2 triage-sweep tests.
 *
 * DB-backed suite against its OWN database (`<base>_triage`) via the private
 * createSuiteDatabase below — never point this at a shared DB (see CLAUDE.md).
 * The LLM is a fake behind the TriageLlmClient seam.
 */
import { newId, TRIAGE_MODEL_ID, TRIAGE_VERSION, type RawStore } from '@newstrader/core';
import { migrate } from 'drizzle-orm/node-postgres/migrator';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';

import { createDb, type Db } from '../client.js';
import {
  instruments,
  itemInstrumentLinks,
  itemTriage,
  llmAttempts,
  newsSources,
  rawNewsItems,
} from '../schema.js';
import type {
  TriageCallOutcome,
  TriageCallRequest,
  TriageLlmClient,
} from '../llm/triage-client.js';
import { triageAttemptKey, TRIAGE_LINK_CONFIDENCE, triageSweep } from './triage-sweep.js';

const NOW = new Date('2026-08-09T12:00:00.000Z');

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

function outcome(overrides?: Partial<TriageCallOutcome>): TriageCallOutcome {
  return {
    result: { relevant_tickers: [], reasoning: 'No candidate is a subject.' },
    failure: null,
    stopReason: 'end_turn',
    usage: {
      inputTokens: 800,
      outputTokens: 60,
      cacheCreationInputTokens: 0,
      cacheReadInputTokens: 0,
    },
    rawResponse: { stub: true },
    latencyMs: 21,
    ...overrides,
  };
}

class FakeTriageLlm implements TriageLlmClient {
  readonly requests: TriageCallRequest[] = [];
  readonly queue: Array<TriageCallOutcome | Error> = [];
  readonly transport = 'api' as const;

  async triage(request: TriageCallRequest): Promise<TriageCallOutcome> {
    this.requests.push(request);
    const next = this.queue.shift();
    if (next === undefined) throw new Error('FakeTriageLlm: no outcome queued');
    if (next instanceof Error) throw next;
    return next;
  }
}

const testDatabaseUrl = process.env.TEST_DATABASE_URL;

describe.skipIf(!testDatabaseUrl)('triageSweep (integration)', () => {
  let db: Db;
  let store: MemoryStore;
  let fake: FakeTriageLlm;

  beforeAll(async () => {
    const suiteUrl = await createSuiteDatabase(testDatabaseUrl as string);
    db = createDb(suiteUrl);
    await migrate(db, {
      migrationsFolder: new URL('../../migrations', import.meta.url).pathname,
    });
  }, 60_000);

  afterAll(async () => {
    await wipe();
    await db.$client.end();
  });

  beforeEach(async () => {
    await wipe();
    store = new MemoryStore();
    fake = new FakeTriageLlm();
  });

  async function wipe(): Promise<void> {
    await db.delete(itemTriage);
    await db.delete(llmAttempts);
    await db.delete(itemInstrumentLinks);
    await db.delete(rawNewsItems);
    await db.delete(instruments);
    await db.delete(newsSources);
  }

  function deps(overrides?: { halted?: boolean }) {
    return {
      llm: fake,
      auditStore: store,
      payloadStore: store,
      killSwitchHalted: overrides?.halted ?? false,
      now: () => NOW,
    };
  }

  async function seedInstrument(symbol: string): Promise<string> {
    const id = newId();
    await db.insert(instruments).values({
      id,
      symbol,
      assetClass: 'us_equity',
      exchange: 'NYSE',
      cik: null,
      name: `${symbol} Industries`,
    });
    return id;
  }

  /** One vendor-tagged item with source_hint links to the given instruments. */
  async function seedItem(input: {
    headline: string;
    linkedInstrumentIds: string[];
    payload?: unknown;
  }): Promise<string> {
    const sourceId = newId();
    await db.insert(newsSources).values({
      id: sourceId,
      sourceKey: `test_${sourceId.slice(-8)}`,
      kind: 'newsapi',
      name: 'test source',
    });
    const itemId = newId();
    const payloadRef = await store.put(`payload/${itemId}`, input.payload ?? null);
    await db.insert(rawNewsItems).values({
      id: itemId,
      sourceId,
      externalId: itemId,
      headline: input.headline,
      payloadRef,
      contentHash: newId(),
      receivedAt: NOW,
      meta: {},
    });
    await db.insert(itemInstrumentLinks).values(
      input.linkedInstrumentIds.map((instrumentId) => ({
        itemId,
        instrumentId,
        method: 'source_hint' as const,
        confidence: 0.65,
        resolverVersion: 'r2',
      })),
    );
    return itemId;
  }

  it('confirms the subject candidates: llm_ner links + an item_triage row', async () => {
    const vndl = await seedInstrument('VNDL');
    const kram = await seedInstrument('KRAM');
    const itemId = await seedItem({
      headline: 'Vandelay Industries beats Q3 expectations',
      linkedInstrumentIds: [vndl, kram],
      payload: { description: 'Vandelay reported EPS of $2.10; Kramerica mentioned in passing.' },
    });
    fake.queue.push(
      outcome({
        result: { relevant_tickers: ['VNDL'], reasoning: 'Vandelay is the subject.' },
      }),
    );

    const result = await triageSweep(db, deps());
    expect(result).toMatchObject({
      examined: 1,
      triaged: 1,
      withRelevant: 1,
      linksWritten: 1,
      failures: 0,
    });

    // The prompt carried both candidates and the lede text.
    const request = fake.requests[0];
    expect(request?.userPrompt).toContain('- VNDL: VNDL Industries');
    expect(request?.userPrompt).toContain('- KRAM: KRAM Industries');
    expect(request?.userPrompt).toContain('EPS of $2.10');

    const links = await db.select().from(itemInstrumentLinks);
    const nerLinks = links.filter((l) => l.method === 'llm_ner');
    expect(nerLinks).toHaveLength(1);
    expect(nerLinks[0]).toMatchObject({
      itemId,
      instrumentId: vndl,
      resolverVersion: TRIAGE_VERSION,
    });
    expect(nerLinks[0]?.confidence).toBeCloseTo(TRIAGE_LINK_CONFIDENCE, 5);

    const triageRows = await db.select().from(itemTriage);
    expect(triageRows).toHaveLength(1);
    expect(triageRows[0]).toMatchObject({
      itemId,
      triageVersion: TRIAGE_VERSION,
      modelId: TRIAGE_MODEL_ID,
      transport: 'api',
      candidateCount: 2,
      relevantCount: 1,
      relevantTickers: ['VNDL'],
    });
    // The audit blob is written and referenced.
    expect(store.blobs.has(String(triageRows[0]?.auditRef).replace('mem://', ''))).toBe(true);

    // Idempotent: the verdict removes the item from the queue.
    expect((await triageSweep(db, deps())).examined).toBe(0);
  });

  it('remembers a zero-relevant verdict — the listicle is never re-triaged', async () => {
    const vndl = await seedInstrument('VNDL');
    await seedItem({ headline: '3 Stocks to Buy Now', linkedInstrumentIds: [vndl] });
    fake.queue.push(outcome()); // default: relevant_tickers []

    const result = await triageSweep(db, deps());
    expect(result).toMatchObject({ examined: 1, triaged: 1, withRelevant: 0, linksWritten: 0 });
    expect((await db.select().from(itemInstrumentLinks)).every((l) => l.method === 'source_hint'))
      .toBe(true);
    expect((await triageSweep(db, deps())).examined).toBe(0);
  });

  it('never links a hallucinated ticker — verdicts intersect the candidate list', async () => {
    const vndl = await seedInstrument('VNDL');
    await seedItem({ headline: 'Vandelay wins a contract', linkedInstrumentIds: [vndl] });
    fake.queue.push(
      outcome({
        result: { relevant_tickers: ['vndl', 'AAPL', 'VNDL'], reasoning: 'Subject + noise.' },
      }),
    );

    const result = await triageSweep(db, deps());
    // Case-normalized, deduped, AAPL (not a candidate) dropped.
    expect(result).toMatchObject({ triaged: 1, withRelevant: 1, linksWritten: 1 });
    const rows = await db.select().from(itemTriage);
    expect(rows[0]?.relevantTickers).toEqual(['VNDL']);
  });

  it('content failure burns an attempt; the cap excludes the item', async () => {
    const vndl = await seedInstrument('VNDL');
    const itemId = await seedItem({ headline: 'Refused item', linkedInstrumentIds: [vndl] });

    for (let i = 0; i < 3; i += 1) {
      fake.queue.push(outcome({ result: null, failure: 'output truncated' }));
      const result = await triageSweep(db, deps());
      expect(result).toMatchObject({ examined: 1, failures: 1, triaged: 0 });
    }
    const attempts = await db.select().from(llmAttempts);
    expect(attempts[0]).toMatchObject({ signalKey: triageAttemptKey(itemId), attempts: 3 });
    // Capped: no longer a candidate, and no triage row exists.
    expect((await triageSweep(db, deps())).examined).toBe(0);
    expect(await db.select().from(itemTriage)).toHaveLength(0);
  });

  it('transport errors abort the pass without burning an attempt', async () => {
    const vndl = await seedInstrument('VNDL');
    await seedItem({ headline: 'Outage item', linkedInstrumentIds: [vndl] });
    fake.queue.push(new Error('socket hang up'));

    const result = await triageSweep(db, deps());
    expect(result.transportError).toContain('socket hang up');
    expect(await db.select().from(llmAttempts)).toHaveLength(0);
    // Still a candidate on the next pass.
    fake.queue.push(outcome());
    expect((await triageSweep(db, deps())).examined).toBe(1);
  });

  it('halts on the kill switch before any API call', async () => {
    const vndl = await seedInstrument('VNDL');
    await seedItem({ headline: 'Halted item', linkedInstrumentIds: [vndl] });

    const result = await triageSweep(db, deps({ halted: true }));
    expect(result).toMatchObject({ halted: true, examined: 0 });
    expect(fake.requests).toHaveLength(0);
  });

  it('itemIds restricts the pass to the listed items', async () => {
    const vndl = await seedInstrument('VNDL');
    await seedItem({ headline: 'not sampled', linkedInstrumentIds: [vndl] });
    const wanted = await seedItem({ headline: 'sampled', linkedInstrumentIds: [vndl] });
    fake.queue.push(outcome());

    const result = await triageSweep(db, deps(), { itemIds: [wanted] });
    expect(result).toMatchObject({ examined: 1, triaged: 1 });
    expect((await db.select().from(itemTriage))[0]?.itemId).toBe(wanted);
  });

  it('dry run renders the first prompt but calls nothing and writes nothing', async () => {
    const vndl = await seedInstrument('VNDL');
    await seedItem({
      headline: 'Vandelay beats',
      linkedInstrumentIds: [vndl],
      payload: { description: 'A plain lede.' },
    });

    const result = await triageSweep(db, deps(), { dryRun: true });
    expect(result.examined).toBe(1);
    expect(result.samplePrompt).toContain('Vandelay beats');
    expect(result.samplePrompt).toContain('- VNDL: VNDL Industries');
    expect(fake.requests).toHaveLength(0);
    expect(await db.select().from(itemTriage)).toHaveLength(0);
  });

  it('stops when the shared daily spend cap is already consumed', async () => {
    const vndl = await seedInstrument('VNDL');
    await seedItem({ headline: 'Capped item', linkedInstrumentIds: [vndl] });
    // Pre-existing triage spend today consumes the whole cap.
    const otherItem = await seedItem({ headline: 'earlier item', linkedInstrumentIds: [vndl] });
    await db.insert(itemTriage).values({
      itemId: otherItem,
      triageVersion: 'older-version',
      modelId: TRIAGE_MODEL_ID,
      transport: 'api',
      candidateCount: 1,
      relevantCount: 0,
      relevantTickers: [],
      auditRef: 'mem://x',
      inputTokens: 1,
      outputTokens: 1,
      costUsd: 99,
      triagedAt: NOW,
      latencyMs: 1,
    });

    const result = await triageSweep(db, deps(), { dailySpendCapUsd: 5 });
    expect(result.spendCapReached).toBe(true);
    expect(fake.requests).toHaveLength(0);
  });
});

// --------------------------------------------------------------- suite infra --

/**
 * Copy of the repo-standard private helper (see trading-repo.test.ts): every
 * DB suite gets its own database, `<base>_triage`.
 */
async function createSuiteDatabase(adminUrl: string): Promise<string> {
  const url = new URL(adminUrl);
  const baseName = url.pathname.replace(/^\//, '') || 'postgres';
  const suiteName = `${baseName}_triage`.replace(/[^a-zA-Z0-9_]/g, '_');
  const admin = createDb(adminUrl);
  try {
    await admin.$client.query(`create database "${suiteName}"`);
  } catch (error) {
    if (!isDuplicateDatabase(error)) throw error;
  } finally {
    await admin.$client.end();
  }
  url.pathname = `/${suiteName}`;
  return url.toString();
}

function isDuplicateDatabase(error: unknown): boolean {
  return (
    typeof error === 'object' &&
    error !== null &&
    'code' in error &&
    (error as { code?: string }).code === '42P04'
  );
}
