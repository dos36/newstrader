import { createHash } from 'node:crypto';

import {
  buildTriageSystemPrompt,
  buildTriageUserPrompt,
  TRIAGE_MAX_CANDIDATES,
  TRIAGE_MAX_TOKENS,
  TRIAGE_MODEL_ID,
  TRIAGE_VERSION,
  type RawStore,
  type TriageCandidate,
} from '@newstrader/core';
import { and, asc, eq, gte, inArray, lte, notExists, sql } from 'drizzle-orm';

import type { Db } from '../client.js';
import {
  instruments,
  itemInstrumentLinks,
  itemTriage,
  llmAttempts,
  newsSources,
  rawNewsItems,
} from '../schema.js';
import { computeCostUsd } from '../llm/cost.js';
import { extractLede } from '../llm/lede.js';
import { recordAttemptFailure, sumLlmSpendSince, utcDayStart } from '../llm/interpret-repo.js';
import type { TriageLlmClient } from '../llm/triage-client.js';

/**
 * Resolver r2 triage sweep — one cheap LLM call per vendor-tagged item,
 * confirming which source_hint candidates the article is materially about.
 * Confirmed candidates get item_instrument_links rows (method 'llm_ner',
 * confidence 0.9 — above MIN_LINK_CONFIDENCE); every examined item gets an
 * item_triage row so zero-relevant verdicts are remembered.
 *
 * Why (measured, 2026-08-28 audit): r1's source_hint links were 73% mis-links
 * because vendors tag every mentioned ticker; r2 parks source_hint at 0.65
 * (below the interpretation gate) and this stage is what promotes a candidate
 * past it. Safety order mirrors interpretSweep: kill switch → daily spend cap
 * (shared with interpretation) → poison-pill attempts cap.
 */

/** llm_ner confidence: above the 0.75 gate, below cik_exact/ticker_exact. */
export const TRIAGE_LINK_CONFIDENCE = 0.9;

const DEFAULT_BATCH = 50;
const DEFAULT_DAILY_SPEND_CAP_USD = 5;
const MAX_ATTEMPTS = 3;

/** llm_attempts key for a triage poison pill — namespaced so it can never
 * collide with an interpretation signal_key (those start with a cluster id). */
export function triageAttemptKey(itemId: string): string {
  return `triage:${itemId}:${TRIAGE_VERSION}:${TRIAGE_MODEL_ID}`;
}

/** llm-triage/{yyyy-mm-dd}/{sha256(item:version)[0..16]}.json (audit.ts precedent). */
export function triageAuditKey(itemId: string, triagedAt: Date): string {
  const day = triagedAt.toISOString().slice(0, 10);
  const hash = createHash('sha256')
    .update(`${itemId}:${TRIAGE_VERSION}`, 'utf8')
    .digest('hex')
    .slice(0, 16);
  return `llm-triage/${day}/${hash}.json`;
}

export interface TriageSweepDeps {
  llm: TriageLlmClient;
  /** Audit blobs (full prompt + response per call). */
  auditStore: RawStore;
  /** Raw item payloads (payload_ref) for the lede. */
  payloadStore: RawStore;
  killSwitchHalted: boolean;
  now?: () => Date;
}

export interface TriageSweepOptions {
  batch?: number;
  /** received_at window, inclusive; omit for the whole backlog (oldest first). */
  from?: Date;
  to?: Date;
  /** Restrict to these item ids — the validation/sampling hook. */
  itemIds?: string[];
  dailySpendCapUsd?: number;
  /** Assemble candidates + first prompt; no API calls, no writes. */
  dryRun?: boolean;
}

export interface TriageSweepResult {
  halted: boolean;
  examined: number;
  triaged: number;
  /** Items whose verdict kept at least one candidate. */
  withRelevant: number;
  linksWritten: number;
  failures: number;
  spendCapReached: boolean;
  spentTodayUsd: number;
  transportError: string | null;
  dryRun: boolean;
  samplePrompt: string | null;
}

interface TriageItemRow {
  id: string;
  headline: string;
  payloadRef: string;
  sourceKind: string;
}

/** SUM(cost_usd) over triage rows at-or-after `since` — the breaker's second leg. */
export async function sumTriageSpendSince(db: Db, since: Date): Promise<number> {
  const rows = await db
    .select({ total: sql<string | null>`sum(${itemTriage.costUsd})` })
    .from(itemTriage)
    .where(gte(itemTriage.triagedAt, since));
  const total = rows[0]?.total;
  return total === null || total === undefined ? 0 : Number(total);
}

async function loadTriageCandidates(
  db: Db,
  options: { batch: number; from?: Date; to?: Date; itemIds?: string[] },
): Promise<TriageItemRow[]> {
  return db
    .selectDistinct({
      id: rawNewsItems.id,
      headline: rawNewsItems.headline,
      payloadRef: rawNewsItems.payloadRef,
      sourceKind: newsSources.kind,
      receivedAt: rawNewsItems.receivedAt,
    })
    .from(rawNewsItems)
    .innerJoin(newsSources, eq(newsSources.id, rawNewsItems.sourceId))
    .innerJoin(
      itemInstrumentLinks,
      and(
        eq(itemInstrumentLinks.itemId, rawNewsItems.id),
        eq(itemInstrumentLinks.method, 'source_hint'),
      ),
    )
    .where(
      and(
        ...(options.from !== undefined ? [gte(rawNewsItems.receivedAt, options.from)] : []),
        ...(options.to !== undefined ? [lte(rawNewsItems.receivedAt, options.to)] : []),
        ...(options.itemIds !== undefined ? [inArray(rawNewsItems.id, options.itemIds)] : []),
        notExists(
          db
            .select({ one: sql`1` })
            .from(itemTriage)
            .where(
              and(
                eq(itemTriage.itemId, rawNewsItems.id),
                eq(itemTriage.triageVersion, TRIAGE_VERSION),
              ),
            ),
        ),
        notExists(
          db
            .select({ one: sql`1` })
            .from(llmAttempts)
            .where(
              and(
                // MUST stay in lockstep with triageAttemptKey().
                eq(
                  llmAttempts.signalKey,
                  sql`${'triage:'} || ${rawNewsItems.id} || ${`:${TRIAGE_VERSION}:${TRIAGE_MODEL_ID}`}`,
                ),
                gte(llmAttempts.attempts, MAX_ATTEMPTS),
              ),
            ),
        ),
      ),
    )
    .orderBy(asc(rawNewsItems.receivedAt), asc(rawNewsItems.id))
    .limit(options.batch);
}

/** The item's source_hint-linked instruments, symbol-keyed for the prompt. */
async function loadCandidateInstruments(
  db: Db,
  itemId: string,
): Promise<Array<TriageCandidate & { instrumentId: string }>> {
  const rows = await db
    .selectDistinct({
      instrumentId: instruments.id,
      symbol: instruments.symbol,
      name: instruments.name,
    })
    .from(itemInstrumentLinks)
    .innerJoin(instruments, eq(instruments.id, itemInstrumentLinks.instrumentId))
    .where(
      and(eq(itemInstrumentLinks.itemId, itemId), eq(itemInstrumentLinks.method, 'source_hint')),
    )
    .orderBy(asc(instruments.symbol));
  return rows;
}

export async function triageSweep(
  db: Db,
  deps: TriageSweepDeps,
  options?: TriageSweepOptions,
): Promise<TriageSweepResult> {
  const nowFn = deps.now ?? ((): Date => new Date());
  const batch = options?.batch ?? DEFAULT_BATCH;
  const capUsd = options?.dailySpendCapUsd ?? DEFAULT_DAILY_SPEND_CAP_USD;
  const dryRun = options?.dryRun ?? false;

  const result: TriageSweepResult = {
    halted: false,
    examined: 0,
    triaged: 0,
    withRelevant: 0,
    linksWritten: 0,
    failures: 0,
    spendCapReached: false,
    spentTodayUsd: 0,
    transportError: null,
    dryRun,
    samplePrompt: null,
  };

  if (deps.killSwitchHalted) {
    result.halted = true;
    logSweep(result);
    return result;
  }

  const items = await loadTriageCandidates(db, {
    batch,
    ...(options?.from !== undefined ? { from: options.from } : {}),
    ...(options?.to !== undefined ? { to: options.to } : {}),
    ...(options?.itemIds !== undefined ? { itemIds: options.itemIds } : {}),
  });
  result.examined = items.length;

  const systemPrompt = buildTriageSystemPrompt();

  const buildContext = async (
    item: TriageItemRow,
  ): Promise<{
    userPrompt: string;
    candidates: Array<TriageCandidate & { instrumentId: string }>;
  }> => {
    const candidates = (await loadCandidateInstruments(db, item.id)).slice(
      0,
      TRIAGE_MAX_CANDIDATES,
    );
    const payload = await deps.payloadStore.get(item.payloadRef).catch(() => null);
    const lede = payload === null ? null : extractLede(item.sourceKind, payload);
    const userPrompt = buildTriageUserPrompt({ headline: item.headline, lede, candidates });
    return { userPrompt, candidates };
  };

  if (dryRun) {
    const first = items[0];
    if (first !== undefined) result.samplePrompt = (await buildContext(first)).userPrompt;
    logSweep(result);
    return result;
  }

  // The breaker sums BOTH ledgers: interpretation rows and triage rows share
  // one daily cap, so adding this stage can never double the LLM budget.
  const dayStart = utcDayStart(nowFn());
  result.spentTodayUsd =
    (await sumLlmSpendSince(db, dayStart)) + (await sumTriageSpendSince(db, dayStart));

  for (const item of items) {
    if (result.spentTodayUsd >= capUsd) {
      result.spendCapReached = true;
      break;
    }

    const { userPrompt, candidates } = await buildContext(item);
    if (candidates.length === 0) continue; // link rows deleted since selection — nothing to judge

    let outcome;
    try {
      outcome = await deps.llm.triage({
        systemPrompt,
        userPrompt,
        modelId: TRIAGE_MODEL_ID,
        maxTokens: TRIAGE_MAX_TOKENS,
      });
    } catch (error) {
      // Transport/infrastructure: abort the pass, burn no attempt.
      result.transportError = error instanceof Error ? error.message : String(error);
      break;
    }

    const triagedAt = nowFn();
    const costUsd = computeCostUsd(TRIAGE_MODEL_ID, outcome.usage);
    result.spentTodayUsd += costUsd;

    const auditRef = await deps.auditStore.put(triageAuditKey(item.id, triagedAt), {
      schemaVersion: 1,
      itemId: item.id,
      triageVersion: TRIAGE_VERSION,
      modelId: TRIAGE_MODEL_ID,
      transport: deps.llm.transport,
      systemPrompt,
      userPrompt,
      response: outcome.rawResponse,
      parsed: outcome.result,
      failure: outcome.failure,
      usage: outcome.usage,
      latencyMs: outcome.latencyMs,
      triagedAtIso: triagedAt.toISOString(),
    });

    if (outcome.result === null) {
      await recordAttemptFailure(db, {
        signalKey: triageAttemptKey(item.id),
        error: outcome.failure ?? 'unknown content failure',
        auditRef,
        at: triagedAt,
      });
      result.failures += 1;
      continue;
    }

    // Intersect with the candidate list — a hallucinated ticker never links.
    const bySymbol = new Map(candidates.map((c) => [c.symbol.toUpperCase(), c.instrumentId]));
    const relevant = [
      ...new Set(
        outcome.result.relevant_tickers
          .map((t) => t.trim().toUpperCase())
          .filter((t) => bySymbol.has(t)),
      ),
    ];

    const inserted = await db
      .insert(itemTriage)
      .values({
        itemId: item.id,
        triageVersion: TRIAGE_VERSION,
        modelId: TRIAGE_MODEL_ID,
        transport: deps.llm.transport,
        candidateCount: candidates.length,
        relevantCount: relevant.length,
        relevantTickers: relevant,
        auditRef,
        inputTokens: outcome.usage.inputTokens,
        outputTokens: outcome.usage.outputTokens,
        costUsd,
        latencyMs: outcome.latencyMs,
        triagedAt,
      })
      .onConflictDoNothing()
      .returning({ itemId: itemTriage.itemId });
    if (inserted.length === 0) continue; // concurrent sweep won the race — its links stand

    result.triaged += 1;
    if (relevant.length === 0) continue;
    result.withRelevant += 1;

    const linkRows = await db
      .insert(itemInstrumentLinks)
      .values(
        relevant.map((symbol) => ({
          itemId: item.id,
          // get() is safe: `relevant` is filtered on bySymbol membership above.
          instrumentId: bySymbol.get(symbol) as string,
          method: 'llm_ner' as const,
          confidence: TRIAGE_LINK_CONFIDENCE,
          resolverVersion: TRIAGE_VERSION,
        })),
      )
      .onConflictDoNothing({
        target: [
          itemInstrumentLinks.itemId,
          itemInstrumentLinks.instrumentId,
          itemInstrumentLinks.resolverVersion,
        ],
      })
      .returning({ itemId: itemInstrumentLinks.itemId });
    result.linksWritten += linkRows.length;
  }

  logSweep(result);
  return result;
}

function logSweep(result: TriageSweepResult): void {
  console.log(
    JSON.stringify({
      level: 'info',
      msg: 'triage_sweep',
      triageVersion: TRIAGE_VERSION,
      ...result,
      spentTodayUsd: Number(result.spentTodayUsd.toFixed(4)),
      samplePrompt: result.samplePrompt === null ? null : '<omitted>',
    }),
  );
}
