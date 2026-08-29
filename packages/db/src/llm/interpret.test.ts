/**
 * M2 interpret-stage tests.
 *
 * DB-backed suites run against their OWN database (`<base>_llm`), created by
 * the private createSuiteDatabase below — never point this at a shared DB
 * (see CLAUDE.md: a suite once closed all 503 live membership rows).
 *
 * The LLM is a fake behind the LlmClient seam; the ONLY test that talks to
 * the real API is the opt-in golden eval (golden.eval.test.ts).
 */
import { readFileSync } from 'node:fs';

import { newId, type Interpretation, type RawStore } from '@newstrader/core';
import { migrate } from 'drizzle-orm/node-postgres/migrator';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';

import { createDb, type Db } from '../client.js';
import {
  instruments,
  itemDocuments,
  itemInstrumentLinks,
  llmAttempts,
  llmSignals,
  newsClusterItems,
  newsClusters,
  newsSources,
  priceBars1m,
  rawNewsItems,
} from '../schema.js';
import type { LlmTransport } from '../shared-constants.js';
import type { LlmCallOutcome, LlmCallRequest, LlmClient } from './anthropic-client.js';
import { AnthropicLlmClient } from './anthropic-client.js';
import { auditKey } from './audit.js';
import { computeCostUsd } from './cost.js';
import { interpretSweep } from './interpret-sweep.js';
import { extractLede } from './lede.js';

const NOW = new Date('2026-08-09T12:00:00.000Z');
const HOUR_MS = 3_600_000;
const ANCHOR = new Date(NOW.getTime() - 2 * HOUR_MS);

// ------------------------------------------------------------- pure pieces --

function fixture(name: string): unknown {
  return JSON.parse(readFileSync(new URL(`./__fixtures__/${name}`, import.meta.url), 'utf8'));
}

describe('extractLede', () => {
  it('unwraps EDGAR atom summaries and strips feed html', () => {
    const lede = extractLede('sec_edgar', fixture('edgar-8k-entry.json'));
    expect(lede).toContain('Item 7.01: Regulation FD Disclosure');
    expect(lede).not.toContain('<b>');
    expect(lede).not.toContain('<br>');
  });

  it('reads Massive plain-text descriptions', () => {
    const lede = extractLede('newsapi', fixture('massive-article.json'));
    expect(lede).toContain('tariffs on 60 countries');
  });

  it('strips html from RSS descriptions', () => {
    const lede = extractLede('rss', fixture('globenewswire-item.json'));
    expect(lede).toContain('Riot Platforms, Inc.');
    expect(lede).not.toContain('<p');
  });

  it('returns null for unknown kinds and unusable payloads (headline-only mode)', () => {
    expect(extractLede('exchange_notice', fixture('massive-article.json'))).toBeNull();
    expect(extractLede('newsapi', null)).toBeNull();
    expect(extractLede('newsapi', { description: 42 })).toBeNull();
    expect(extractLede('rss', { description: '<p>   </p>' })).toBeNull();
  });

  it('caps lede length', () => {
    const lede = extractLede('newsapi', { description: 'y'.repeat(9000) });
    expect(lede).toHaveLength(1200);
  });
});

describe('computeCostUsd', () => {
  it('prices sonnet-5 usage incl. cache tiers', () => {
    const cost = computeCostUsd('claude-sonnet-5', {
      inputTokens: 1000,
      outputTokens: 300,
      cacheCreationInputTokens: 2000,
      cacheReadInputTokens: 4000,
    });
    // 1000*3 + 300*15 + 2000*3.75 + 4000*0.3 per MTok
    expect(cost).toBeCloseTo(0.003 + 0.0045 + 0.0075 + 0.0012, 10);
  });

  it('throws for unpriced models so the spend breaker can never go blind', () => {
    expect(() =>
      computeCostUsd('claude-unknown', {
        inputTokens: 1,
        outputTokens: 1,
        cacheCreationInputTokens: 0,
        cacheReadInputTokens: 0,
      }),
    ).toThrow(/No pricing registered/);
  });
});

describe('auditKey', () => {
  it('is deterministic, day-partitioned, and path-safe', () => {
    const key = auditKey('cluster:instr:v1:claude-sonnet-5', NOW);
    expect(key).toMatch(/^llm\/2026-08-09\/[0-9a-f]{16}\.json$/);
    expect(auditKey('cluster:instr:v1:claude-sonnet-5', NOW)).toBe(key);
  });
});

describe('AnthropicLlmClient constructor', () => {
  it('throws without an API key (the key travels only inside the SDK client)', () => {
    expect(() => new AnthropicLlmClient({ apiKey: undefined })).toThrow(/ANTHROPIC_API_KEY/);
    expect(() => new AnthropicLlmClient({ apiKey: '  ' })).toThrow(/ANTHROPIC_API_KEY/);
  });
});

// -------------------------------------------------------------- test doubles --

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

const VALID_INTERPRETATION: Interpretation = {
  event_type: 'earnings_result',
  direction: 'bullish',
  expected_move_bps: 350,
  horizon: '1d',
  already_expected: false,
  materiality: 0.7,
  confidence: 0.8,
  reasoning: 'Clear beat with raised guidance. Direct positive surprise.',
};

function outcome(overrides?: Partial<LlmCallOutcome>): LlmCallOutcome {
  return {
    interpretation: VALID_INTERPRETATION,
    failure: null,
    stopReason: 'end_turn',
    usage: {
      inputTokens: 1000,
      outputTokens: 300,
      cacheCreationInputTokens: 0,
      cacheReadInputTokens: 0,
    },
    rawResponse: { stub: true },
    latencyMs: 42,
    ...overrides,
  };
}

class FakeLlm implements LlmClient {
  readonly requests: LlmCallRequest[] = [];
  readonly queue: Array<LlmCallOutcome | Error> = [];
  /** Mutable so a test can assert the sweep reads the mode off the client. */
  transport: LlmTransport = 'api';

  async interpret(request: LlmCallRequest): Promise<LlmCallOutcome> {
    this.requests.push(request);
    const next = this.queue.shift();
    if (next === undefined) throw new Error('FakeLlm: no outcome queued');
    if (next instanceof Error) throw next;
    return next;
  }
}

// ------------------------------------------------------------- integration --

const testDatabaseUrl = process.env.TEST_DATABASE_URL;

describe.skipIf(!testDatabaseUrl)('interpretSweep (integration)', () => {
  let db: Db;
  let payloadStore: MemoryStore;
  let auditStore: MemoryStore;
  let fake: FakeLlm;

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
    payloadStore = new MemoryStore();
    auditStore = new MemoryStore();
    fake = new FakeLlm();
  });

  async function wipe(): Promise<void> {
    await db.delete(itemDocuments);
    await db.delete(llmAttempts);
    await db.delete(llmSignals);
    await db.delete(priceBars1m);
    await db.delete(itemInstrumentLinks);
    await db.delete(newsClusterItems);
    await db.delete(rawNewsItems);
    await db.delete(newsClusters);
    await db.delete(instruments);
    await db.delete(newsSources);
  }

  function deps(overrides?: { halted?: boolean }) {
    return {
      llm: fake,
      auditStore,
      payloadStore,
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
      cik: '0000000001',
      name: `${symbol} Industries`,
      sectorApprox: 'Industrials',
    });
    return id;
  }

  async function seedPair(input: {
    instrumentId: string;
    headline?: string;
    firstReceivedAt?: Date;
    confidence?: number;
    meta?: Record<string, unknown>;
    payload?: unknown;
    sourceKind?: 'sec_edgar' | 'newsapi' | 'rss';
  }): Promise<{ clusterId: string; itemId: string }> {
    const sourceId = newId();
    const kind = input.sourceKind ?? 'newsapi';
    await db.insert(newsSources).values({
      id: sourceId,
      sourceKey: `test_${sourceId.slice(-8)}`,
      kind,
      name: 'test source',
    });

    const itemId = newId();
    const payloadRef = await payloadStore.put(`payload/${itemId}`, input.payload ?? null);
    const receivedAt = input.firstReceivedAt ?? ANCHOR;
    await db.insert(rawNewsItems).values({
      id: itemId,
      sourceId,
      externalId: itemId,
      headline: input.headline ?? 'Vandelay Industries beats Q3 expectations',
      payloadRef,
      contentHash: newId(),
      receivedAt,
      meta: input.meta ?? {},
    });

    const clusterId = newId();
    await db.insert(newsClusters).values({
      id: clusterId,
      canonicalHeadline: input.headline ?? 'Vandelay Industries beats Q3 expectations',
      normalizedHeadline: 'vandelay industries beats q3 expectations',
      firstItemId: itemId,
      firstSourceId: sourceId,
      firstReceivedAt: receivedAt,
      itemCount: 1,
      distinctSourceCount: 1,
      lastItemAt: receivedAt,
    });
    await db.insert(newsClusterItems).values({
      clusterId,
      itemId,
      similarity: 1,
      lagFromFirstMs: 0,
    });
    await db.insert(itemInstrumentLinks).values({
      itemId,
      instrumentId: input.instrumentId,
      method: 'ticker_exact',
      confidence: input.confidence ?? 0.9,
      resolverVersion: 'r1',
    });
    return { clusterId, itemId };
  }

  /** Extra item joining an existing cluster `lagFromFirstMs` after its anchor. */
  async function addClusterItem(input: {
    clusterId: string;
    instrumentId: string;
    headline: string;
    lagFromFirstMs: number;
  }): Promise<void> {
    const sourceId = newId();
    await db.insert(newsSources).values({
      id: sourceId,
      sourceKey: `late_${sourceId.slice(-8)}`,
      kind: 'newsapi',
      name: 'late source',
    });
    const itemId = newId();
    const payloadRef = await payloadStore.put(`payload/${itemId}`, null);
    await db.insert(rawNewsItems).values({
      id: itemId,
      sourceId,
      externalId: itemId,
      headline: input.headline,
      payloadRef,
      contentHash: newId(),
      receivedAt: new Date(ANCHOR.getTime() + input.lagFromFirstMs),
      meta: {},
    });
    await db.insert(newsClusterItems).values({
      clusterId: input.clusterId,
      itemId,
      similarity: 0.9,
      lagFromFirstMs: input.lagFromFirstMs,
    });
    await db.insert(itemInstrumentLinks).values({
      itemId,
      instrumentId: input.instrumentId,
      method: 'ticker_exact',
      confidence: 0.9,
      resolverVersion: 'r1',
    });
  }

  /** Minute bars as [epochMs, close] — open/high/low mirror the close. */
  async function seedBars(instrumentId: string, bars: Array<[number, string]>): Promise<void> {
    await db.insert(priceBars1m).values(
      bars.map(([ms, close]) => ({
        instrumentId,
        ts: new Date(ms),
        open: close,
        high: close,
        low: close,
        close,
        source: 'test',
      })),
    );
  }

  it('interprets a novel pair end to end: signal row, audit blob, prompt content', async () => {
    const instrumentId = await seedInstrument('VNDL');
    const { clusterId } = await seedPair({
      instrumentId,
      sourceKind: 'sec_edgar',
      meta: { itemCodes: ['2.02', '9.01'], formType: '8-K', cik: '0000000001' },
      payload: {
        summary: {
          '#text': '<b>Filed:</b> 2026-08-09 <br>Item 2.02: Results of Operations',
          '@_type': 'html',
        },
      },
    });
    fake.queue.push(outcome());

    const result = await interpretSweep(db, deps());

    expect(result).toMatchObject({
      halted: false,
      examined: 1,
      interpreted: 1,
      duplicates: 0,
      failures: 0,
      spendCapReached: false,
      transportError: null,
      retrospective: false,
    });

    // The call the model actually saw.
    expect(fake.requests).toHaveLength(1);
    const request = fake.requests[0];
    expect(request?.modelId).toBe('claude-sonnet-5');
    // The registry's ceiling reaches the client unchanged. Pinned because a
    // silently-lowballed cap truncates the reply, and truncation costs one of
    // the candidate's three attempts rather than raising anything.
    expect(request?.maxTokens).toBe(10_000);
    expect(request?.effort).toBe('medium');
    expect(request?.userPrompt).toContain('VNDL — VNDL Industries');
    expect(request?.userPrompt).toContain('8-K items: 2.02 (hint: earnings_result), 9.01');
    expect(request?.userPrompt).toContain('Item 2.02: Results of Operations');
    expect(request?.userPrompt).toContain('Move over the session before arrival: unavailable');
    // v3 shows no post-arrival price action at all — that number is the opening
    // slice of the move being predicted.
    expect(request?.userPrompt).not.toContain('Move since story arrival');

    // The persisted fact.
    const rows = await db.select().from(llmSignals);
    expect(rows).toHaveLength(1);
    const row = rows[0];
    expect(row).toMatchObject({
      clusterId,
      instrumentId,
      scope: 'company',
      eventType: 'earnings_result',
      direction: 'bullish',
      promptVersion: 'v3',
      modelId: 'claude-sonnet-5',
      retrospective: false,
      reasoning: VALID_INTERPRETATION.reasoning,
      inputTokens: 1000,
      outputTokens: 300,
      latencyMs: 42,
      clusterItemCountAtAnalysis: 1,
    });
    expect(row?.costUsd).toBeCloseTo(0.0075, 6);
    expect(row?.promptRef).toBe(row?.responseRef);

    // The audit blob behind the refs — full prompt halves + raw response.
    const blob = (await auditStore.get(row?.promptRef ?? '')) as Record<string, unknown>;
    expect(blob['signalKey']).toBe(row?.signalKey);
    expect(blob['systemPrompt']).toContain('interpretation stage');
    expect(blob['userPrompt']).toBe(request?.userPrompt);
    expect(blob['failure']).toBeNull();

    // Idempotency: the pair has left the work queue.
    const second = await interpretSweep(db, deps());
    expect(second.examined).toBe(0);
    expect(fake.requests).toHaveLength(1);
  });

  it('reconstructs price, items and counts as of the anchor, not the wall clock', async () => {
    // The v1 leak, reproduced: this cluster arrived 2h before the sweep runs.
    // v1 read the quote at `now`, so the prompt carried the full 2h realized
    // move and listed follow-up coverage that did not exist at arrival.
    const instrumentId = await seedInstrument('VNDL');
    const { clusterId } = await seedPair({ instrumentId, headline: 'VNDL wins a contract' });
    await addClusterItem({
      clusterId,
      instrumentId,
      headline: 'ANALYSTS PILE IN ON VNDL AFTER CONTRACT',
      lagFromFirstMs: 90 * 60_000, // 90 minutes later — invisible at arrival
    });
    await seedBars(instrumentId, [
      // A minute EARLIER than the lookup instant on purpose: loadSettledCloseAt
      // selects on bar close, so it shifts its lookup back one minute.
      [ANCHOR.getTime() - 24 * 3_600_000 - 60_000, '90.00'], // prior session close
      [ANCHOR.getTime() - 60_000, '100.00'], // anchor close
      [ANCHOR.getTime() + 4 * 60_000, '101.00'], // reaction — must not be shown
      [ANCHOR.getTime() + 100 * 60_000, '130.00'], // the realized move v1 leaked
    ]);
    fake.queue.push(outcome());

    await interpretSweep(db, deps());

    const userPrompt = fake.requests[0]?.userPrompt ?? '';
    // 90 → 100 over the prior session is +1111 bps: the pre-arrival run-up,
    // which is what already_expected needs and cannot reveal the outcome.
    expect(userPrompt).toContain('Move over the session before arrival: 1111 bps');
    // Neither the 5-minute reaction nor the 2-hour realized move appears.
    expect(userPrompt).not.toContain('Move since story arrival');
    expect(userPrompt).not.toContain('3000 bps');
    // Only the arrival-time item is shown, and the counts agree with it.
    expect(userPrompt).toContain('VNDL wins a contract');
    expect(userPrompt).not.toContain('ANALYSTS PILE IN');
    expect(userPrompt).toContain('1 item(s) from 1 source(s)');

    const row = (await db.select().from(llmSignals))[0];
    expect(row?.clusterItemCountAtAnalysis).toBe(1);
    const blob = (await auditStore.get(row?.promptRef ?? '')) as Record<string, unknown>;
    // observedAt is anchor + 5 min; analyzedAt is 2h later. The gap between the
    // two is exactly the look-ahead this fix removes.
    expect(blob['observedAtIso']).toBe(new Date(ANCHOR.getTime() + 5 * 60_000).toISOString());
    expect(blob['analyzedAtIso']).toBe(NOW.toISOString());
  });

  it('clamps the observation instant to the real clock for a brand-new cluster', async () => {
    // anchor + 5 min would be in the FUTURE here; the clamp keeps the quote at
    // `now`, which is what the live path has always effectively used.
    const instrumentId = await seedInstrument('VNDL');
    await seedPair({ instrumentId, firstReceivedAt: new Date(NOW.getTime() - 60_000) });
    await seedBars(instrumentId, [
      [NOW.getTime() - 120_000, '100.00'],
      [NOW.getTime() - 30_000, '102.00'],
      [NOW.getTime() + 4 * 60_000, '150.00'], // must never be read
    ]);
    fake.queue.push(outcome());

    await interpretSweep(db, deps());

    // No future bar leaks in: the run-up's upper bound is the anchor close.
    expect(fake.requests[0]?.userPrompt).not.toContain('150');
    const row = (await db.select().from(llmSignals))[0];
    const blob = (await auditStore.get(row?.promptRef ?? '')) as Record<string, unknown>;
    expect(blob['observedAtIso']).toBe(NOW.toISOString());
  });

  it('keeps the two transports on separate keys, so a dev call cannot block an api call', async () => {
    // Pins the lockstep the module doc demands: buildSignalKey (signals-repo)
    // and signalKeyExpr (interpret-repo) must agree on the ':cli' suffix, or
    // the dev row would make the pair look done forever.
    const instrumentId = await seedInstrument('VNDL');
    await seedPair({ instrumentId });

    fake.transport = 'cli';
    fake.queue.push(outcome());
    const cliPass = await interpretSweep(db, deps());
    expect(cliPass).toMatchObject({ transport: 'cli', examined: 1, interpreted: 1 });

    const cliRows = await db.select().from(llmSignals);
    expect(cliRows).toHaveLength(1);
    expect(cliRows[0]?.transport).toBe('cli');
    expect(cliRows[0]?.signalKey.endsWith(':cli')).toBe(true);

    const cliBlob = (await auditStore.get(cliRows[0]?.promptRef ?? '')) as Record<string, unknown>;
    expect(cliBlob['transport']).toBe('cli');
    expect(cliBlob['schemaVersion']).toBe(2);

    // The same pair is STILL work for the API transport.
    fake.transport = 'api';
    fake.queue.push(outcome());
    const apiPass = await interpretSweep(db, deps());
    expect(apiPass).toMatchObject({ transport: 'api', examined: 1, interpreted: 1 });

    const allRows = await db.select().from(llmSignals);
    expect(allRows).toHaveLength(2);
    const apiRow = allRows.find((row) => row.transport === 'api');
    expect(apiRow?.signalKey.endsWith(':cli')).toBe(false);

    // And neither transport re-does its own work.
    expect((await interpretSweep(db, deps())).examined).toBe(0);
  });

  it('prefers fetched SEC filing text over the Atom summary', async () => {
    // The whole point of the document sweep: without it an 8-K reaches the
    // model as its form type plus "Filed: … AccNo: … Size: 11 KB" (measured
    // median 57 chars). With it, the filing body and its press release.
    const instrumentId = await seedInstrument('VNDL');
    const { itemId } = await seedPair({
      instrumentId,
      sourceKind: 'sec_edgar',
      meta: { itemCodes: ['2.02'], formType: '8-K' },
      payload: { summary: { '#text': '<b>Filed:</b> 2026-08-09 <b>Size:</b> 11 KB' } },
    });
    const docRef = await payloadStore.put(`edgar-docs/${itemId}.json`, {
      schemaVersion: 1,
      text: '[form8-k.htm]\nItem 2.02. Q3 revenue of $412M, up 12% year over year.',
    });
    await db.insert(itemDocuments).values({
      itemId,
      status: 'ok',
      docRef,
      charCount: 70,
      documentCount: 1,
      truncated: false,
      attempts: 1,
      fetchedAt: NOW,
    });
    fake.queue.push(outcome());

    await interpretSweep(db, deps());

    const userPrompt = fake.requests[0]?.userPrompt ?? '';
    expect(userPrompt).toContain('Q3 revenue of $412M, up 12% year over year.');
    // The metadata summary is gone, not appended alongside.
    expect(userPrompt).not.toContain('AccNo');
    expect(userPrompt).not.toContain('Size:');
  });

  it('falls back to the Atom summary when the filing fetch failed', async () => {
    const instrumentId = await seedInstrument('VNDL');
    const { itemId } = await seedPair({
      instrumentId,
      sourceKind: 'sec_edgar',
      meta: { itemCodes: ['2.02'], formType: '8-K' },
      payload: { summary: { '#text': 'Item 2.02: Results of Operations' } },
    });
    // status='failed' carries no doc_ref, so the prompt must degrade, not break.
    await db.insert(itemDocuments).values({
      itemId,
      status: 'failed',
      docRef: null,
      attempts: 3,
      lastError: 'GET … failed: 500',
      fetchedAt: NOW,
    });
    fake.queue.push(outcome());

    await interpretSweep(db, deps());

    expect(fake.requests[0]?.userPrompt).toContain('Item 2.02: Results of Operations');
  });

  it('degrades to headline-only when the stored filing blob is unreadable', async () => {
    const instrumentId = await seedInstrument('VNDL');
    const { itemId } = await seedPair({
      instrumentId,
      sourceKind: 'sec_edgar',
      headline: 'VNDL files an 8-K',
      meta: { formType: '8-K' },
      payload: null,
    });
    await db.insert(itemDocuments).values({
      itemId,
      status: 'ok',
      // Ref points at nothing — a store miss must never fail the candidate.
      docRef: 'mem://edgar-docs/gone.json',
      charCount: 10,
      documentCount: 1,
      truncated: false,
      attempts: 1,
      fetchedAt: NOW,
    });
    fake.queue.push(outcome());

    const result = await interpretSweep(db, deps());

    expect(result.interpreted).toBe(1);
    expect(fake.requests[0]?.userPrompt).toContain('VNDL files an 8-K');
  });

  it('counts what is left only when asked', async () => {
    const instrumentId = await seedInstrument('VNDL');
    await seedPair({ instrumentId, headline: 'first' });
    await seedPair({ instrumentId, headline: 'second' });
    await seedPair({ instrumentId, headline: 'third' });
    fake.queue.push(outcome());

    const counted = await interpretSweep(db, deps(), { batch: 1, countRemaining: true });
    expect(counted).toMatchObject({ examined: 1, interpreted: 1, remaining: 2 });

    // Off by default: the deployed 5-minute sweep must not pay for the COUNT.
    fake.queue.push(outcome());
    const quiet = await interpretSweep(db, deps(), { batch: 1 });
    expect(quiet.remaining).toBeNull();

    // A dry run must report the REAL backlog: it is the command an operator
    // runs to decide whether to start, so 0 there would be a lie.
    const dry = await interpretSweep(db, deps(), {
      batch: 1,
      dryRun: true,
      countRemaining: true,
    });
    expect(dry.remaining).toBe(1);

    // Halted before the queue is read: null, not a claim of an empty backlog.
    const halted = await interpretSweep(db, deps({ halted: true }), { countRemaining: true });
    expect(halted.remaining).toBeNull();
  });

  it('enforces the link-confidence threshold and the lookback window', async () => {
    const instrumentId = await seedInstrument('VNDL');
    // nameAlias-grade link (0.7) — below MIN_LINK_CONFIDENCE.
    await seedPair({ instrumentId, confidence: 0.7 });
    // In-confidence but older than the 24h lookback.
    await seedPair({
      instrumentId,
      firstReceivedAt: new Date(NOW.getTime() - 48 * HOUR_MS),
      headline: 'Old news',
    });

    const result = await interpretSweep(db, deps());
    expect(result.examined).toBe(0);
    expect(fake.requests).toHaveLength(0);
  });

  it('poison pill: audit + attempts row, no signal, excluded after the cap', async () => {
    const instrumentId = await seedInstrument('VNDL');
    await seedPair({ instrumentId });

    for (let attempt = 1; attempt <= 3; attempt += 1) {
      fake.queue.push(outcome({ interpretation: null, failure: 'schema validation failed: x' }));
      const result = await interpretSweep(db, deps());
      expect(result).toMatchObject({ examined: 1, interpreted: 0, failures: 1 });

      const attempts = await db.select().from(llmAttempts);
      expect(attempts).toHaveLength(1);
      expect(attempts[0]).toMatchObject({
        attempts: attempt,
        lastError: 'schema validation failed: x',
      });
      expect(attempts[0]?.auditRef).toMatch(/^mem:\/\/llm\//);
    }
    expect(await db.select().from(llmSignals)).toHaveLength(0);

    // Attempt cap reached — the pair stops being a candidate entirely.
    const afterCap = await interpretSweep(db, deps());
    expect(afterCap.examined).toBe(0);
    expect(fake.requests).toHaveLength(3);
  });

  it('transport errors abort the pass WITHOUT burning an attempt', async () => {
    const instrumentId = await seedInstrument('VNDL');
    await seedPair({ instrumentId });
    fake.queue.push(new Error('connection reset'));

    const result = await interpretSweep(db, deps());
    expect(result.transportError).toBe('connection reset');
    expect(result.failures).toBe(0);
    expect(await db.select().from(llmAttempts)).toHaveLength(0);

    // Still a candidate on the next tick.
    fake.queue.push(outcome());
    const retry = await interpretSweep(db, deps());
    expect(retry.interpreted).toBe(1);
  });

  it('halts on the kill switch before any API call', async () => {
    const instrumentId = await seedInstrument('VNDL');
    await seedPair({ instrumentId });

    const result = await interpretSweep(db, deps({ halted: true }));
    expect(result.halted).toBe(true);
    expect(result.examined).toBe(0);
    expect(fake.requests).toHaveLength(0);
  });

  it('stops calling when the per-day spend cap is already consumed', async () => {
    const instrumentId = await seedInstrument('VNDL');
    await seedPair({ instrumentId });
    // A prior signal today already burned the budget.
    const spent = await seedPair({
      instrumentId: await seedInstrument('OTHR'),
      headline: 'Earlier expensive story',
    });
    fake.queue.push(outcome());
    await db.insert(llmSignals).values({
      id: newId(),
      signalKey: `${spent.clusterId}:spent:v1:claude-sonnet-5`,
      clusterId: spent.clusterId,
      scope: 'company',
      instrumentId,
      eventType: 'other',
      direction: 'neutral',
      expectedMoveBps: 0,
      horizon: '1d',
      alreadyExpected: false,
      materiality: 0,
      confidence: 0,
      modelId: 'claude-sonnet-5',
      promptVersion: 'v1',
      costUsd: 99,
      analyzedAt: new Date(NOW.getTime() - HOUR_MS),
    });

    const result = await interpretSweep(db, deps(), { dailySpendCapUsd: 5 });
    expect(result.spendCapReached).toBe(true);
    expect(result.interpreted).toBe(0);
    expect(fake.requests).toHaveLength(0);
  });

  it('retrospective windows stamp retrospective=true; the live window refuses old clusters', async () => {
    const instrumentId = await seedInstrument('VNDL');
    const oldAnchor = new Date(NOW.getTime() - 5 * 24 * HOUR_MS);
    await seedPair({ instrumentId, firstReceivedAt: oldAnchor, headline: 'Five days ago' });

    // Live sweep: out of lookback, invisible.
    expect((await interpretSweep(db, deps())).examined).toBe(0);

    // Explicit backfill window: interpreted and quarantined.
    fake.queue.push(outcome());
    const retro = await interpretSweep(db, deps(), {
      retrospective: {
        from: new Date(oldAnchor.getTime() - HOUR_MS),
        to: new Date(oldAnchor.getTime() + HOUR_MS),
      },
    });
    expect(retro).toMatchObject({ examined: 1, interpreted: 1, retrospective: true });

    const rows = await db.select().from(llmSignals);
    expect(rows[0]?.retrospective).toBe(true);
  });

  it('refuses a retrospective window that reaches into the live lookback', async () => {
    // signal_key does not encode retrospective-ness while being unique, so a
    // backfill row overlapping the live window takes the live row's slot and
    // the pair is quarantined from decide forever. Refuse the call instead.
    await expect(
      interpretSweep(db, deps(), {
        retrospective: {
          from: new Date(NOW.getTime() - 5 * 24 * HOUR_MS),
          to: new Date(NOW.getTime() - 2 * HOUR_MS),
        },
      }),
    ).rejects.toThrow(/inside the live lookback/);
  });

  it('dry run assembles the prompt but calls nothing and writes nothing', async () => {
    const instrumentId = await seedInstrument('VNDL');
    await seedPair({ instrumentId, payload: { description: 'A plain lede for the dry run.' } });

    const result = await interpretSweep(db, deps(), { dryRun: true });
    expect(result.examined).toBe(1);
    expect(result.samplePrompt).toContain('Vandelay Industries beats Q3 expectations');
    expect(result.samplePrompt).toContain('A plain lede for the dry run.');
    expect(fake.requests).toHaveLength(0);
    expect(await db.select().from(llmSignals)).toHaveLength(0);
    expect(auditStore.blobs.size).toBe(0);
  });

  it('samplePairs restricts a retrospective pass to the listed pairs only', async () => {
    const instrumentId = await seedInstrument('VNDL');
    const oldAnchor = new Date(NOW.getTime() - 5 * 24 * HOUR_MS);
    await seedPair({ instrumentId, firstReceivedAt: oldAnchor, headline: 'not sampled' });
    const sampled = await seedPair({
      instrumentId,
      firstReceivedAt: oldAnchor,
      headline: 'sampled pair',
    });
    await seedPair({ instrumentId, firstReceivedAt: oldAnchor, headline: 'also not sampled' });
    fake.queue.push(outcome());

    const window = {
      from: new Date(oldAnchor.getTime() - HOUR_MS),
      to: new Date(oldAnchor.getTime() + HOUR_MS),
    };
    const result = await interpretSweep(db, deps(), {
      retrospective: window,
      samplePairs: [`${sampled.clusterId}:${instrumentId}`],
      countRemaining: true,
    });

    // Only the listed pair is examined; the anti-join still applies within the
    // sample, so the remaining count is 0 once its row is written.
    expect(result).toMatchObject({ examined: 1, interpreted: 1, remaining: 0 });
    const rows = await db.select().from(llmSignals);
    expect(rows).toHaveLength(1);
    expect(rows[0]?.clusterId).toBe(sampled.clusterId);
  });

  it('refuses samplePairs on a live sweep — the hook is retrospective-only', async () => {
    await expect(
      interpretSweep(db, deps(), { samplePairs: ['a:b'] }),
    ).rejects.toThrow(/retrospective/);
  });

  it('v3-nofiling never loads filing text — the 8-K ablation arm', async () => {
    // Same seeding as the "prefers fetched SEC filing text" case, so the ONLY
    // difference is the prompt version's includeFilingText flag.
    const instrumentId = await seedInstrument('VNDL');
    const { itemId } = await seedPair({
      instrumentId,
      sourceKind: 'sec_edgar',
      meta: { itemCodes: ['2.02'], formType: '8-K' },
      payload: { summary: { '#text': 'Item 2.02: Results of Operations' } },
    });
    const docRef = await payloadStore.put(`edgar-docs/${itemId}.json`, {
      schemaVersion: 1,
      text: '[form8-k.htm]\nItem 2.02. Q3 revenue of $412M, up 12% year over year.',
    });
    await db.insert(itemDocuments).values({
      itemId,
      status: 'ok',
      docRef,
      charCount: 70,
      documentCount: 1,
      truncated: false,
      attempts: 1,
      fetchedAt: NOW,
    });
    fake.queue.push(outcome());

    await interpretSweep(db, deps(), { promptVersion: 'v3-nofiling' });

    const request = fake.requests[0];
    // The fetched body stays out; the Atom summary lede takes its place, and
    // the system text does not promise filing text it will never carry.
    expect(request?.userPrompt).not.toContain('Q3 revenue of $412M');
    expect(request?.userPrompt).toContain('Item 2.02: Results of Operations');
    expect(request?.systemPrompt).not.toContain('SEC filing text');

    const rows = await db.select().from(llmSignals);
    expect(rows[0]?.promptVersion).toBe('v3-nofiling');
  });
});

// --------------------------------------------------------------- suite infra --

/**
 * Copy of the repo-standard private helper (see trading-repo.test.ts): every
 * DB suite gets its own database, `<base>_llm`.
 */
async function createSuiteDatabase(adminUrl: string): Promise<string> {
  const url = new URL(adminUrl);
  const baseName = url.pathname.replace(/^\//, '') || 'postgres';
  const suiteName = `${baseName}_llm`.replace(/[^a-zA-Z0-9_]/g, '_');
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
