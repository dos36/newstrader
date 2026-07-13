import { newId } from '@newstrader/core';
import { and, asc, eq, isNotNull, isNull } from 'drizzle-orm';

import type { Db } from '../client.js';
import { decisions, instruments, llmSignals, newsClusters } from '../schema.js';

/**
 * llm_signals persistence + the decide() driver's work queue.
 *
 * persistSignal is M2's future write path: the interpret stage calls it once
 * per parsed LLM response, and SQS redelivery is absorbed by the signal_key
 * unique constraint (architecture §4.2) — INSERT … ON CONFLICT DO NOTHING,
 * the existing row's id comes back on a duplicate.
 */

/**
 * Explicit input type — deliberately NOT drizzle-inferred so the M2 interpret
 * stage codes against a stable contract, not schema internals. Optional
 * fields persist as NULL when omitted.
 */
export interface PersistSignalInput {
  clusterId: string;
  scope: 'company' | 'sector' | 'macro';
  /** Set iff scope=company. */
  instrumentId?: string | null;
  /** Set iff scope=sector. */
  sectorCode?: string | null;
  eventType: string;
  direction: 'bullish' | 'bearish' | 'neutral';
  expectedMoveBps: number;
  horizon: 'intraday' | '1d' | '3d' | '5d';
  alreadyExpected: boolean;
  materiality: number;
  confidence: number;
  modelId: string;
  promptVersion: string;
  promptRef?: string | null;
  responseRef?: string | null;
  inputTokens?: number | null;
  outputTokens?: number | null;
  costUsd?: number | null;
  latencyMs?: number | null;
  clusterItemCountAtAnalysis?: number | null;
  analyzedAt: Date;
}

export interface PersistSignalResult {
  /** The stored row's id — the pre-existing one when the key already existed. */
  id: string;
  inserted: boolean;
}

/**
 * Idempotency key per the schema doc:
 * `${cluster_id}:${instrument_id ?? sector_code ?? 'macro'}:${prompt_version}:${model_id}`.
 * Re-prompting under a new prompt_version inserts NEW rows — old signals are
 * never touched (prompt A/B compares via join).
 */
export function buildSignalKey(
  input: Pick<
    PersistSignalInput,
    'clusterId' | 'instrumentId' | 'sectorCode' | 'promptVersion' | 'modelId'
  >,
): string {
  const target = input.instrumentId ?? input.sectorCode ?? 'macro';
  return `${input.clusterId}:${target}:${input.promptVersion}:${input.modelId}`;
}

export async function persistSignal(
  db: Db,
  input: PersistSignalInput,
): Promise<PersistSignalResult> {
  const signalKey = buildSignalKey(input);
  const inserted = await db
    .insert(llmSignals)
    .values({
      id: newId(),
      signalKey,
      clusterId: input.clusterId,
      scope: input.scope,
      instrumentId: input.instrumentId ?? null,
      sectorCode: input.sectorCode ?? null,
      eventType: input.eventType,
      direction: input.direction,
      expectedMoveBps: input.expectedMoveBps,
      horizon: input.horizon,
      alreadyExpected: input.alreadyExpected,
      materiality: input.materiality,
      confidence: input.confidence,
      modelId: input.modelId,
      promptVersion: input.promptVersion,
      promptRef: input.promptRef ?? null,
      responseRef: input.responseRef ?? null,
      inputTokens: input.inputTokens ?? null,
      outputTokens: input.outputTokens ?? null,
      costUsd: input.costUsd ?? null,
      latencyMs: input.latencyMs ?? null,
      clusterItemCountAtAnalysis: input.clusterItemCountAtAnalysis ?? null,
      analyzedAt: input.analyzedAt,
    })
    .onConflictDoNothing({ target: llmSignals.signalKey })
    .returning({ id: llmSignals.id });

  const insertedRow = inserted[0];
  if (insertedRow !== undefined) return { id: insertedRow.id, inserted: true };

  const existing = await db
    .select({ id: llmSignals.id })
    .from(llmSignals)
    .where(eq(llmSignals.signalKey, signalKey));
  const existingRow = existing[0];
  if (existingRow === undefined) {
    throw new Error(`persistSignal: conflict on signal_key "${signalKey}" but no row found`);
  }
  return { id: existingRow.id, inserted: false };
}

// -------------------------------------------------------------- work queue --

/**
 * A signal the live decide() driver still owes a decision, joined with the
 * static context the engine's SignalInput needs (anchor = the cluster's
 * first_received_at — OUR clock; assetClass from instruments) plus the
 * cluster's denormalized popularity counters for feature assembly.
 */
export interface UndecidedSignal {
  id: string;
  clusterId: string;
  instrumentId: string;
  assetClass: 'us_equity' | 'crypto';
  eventType: string;
  direction: 'bullish' | 'bearish' | 'neutral';
  expectedMoveBps: number;
  horizon: 'intraday' | '1d' | '3d' | '5d';
  alreadyExpected: boolean;
  materiality: number;
  confidence: number;
  /** cluster.first_received_at — the stale-move reference point. */
  anchorTs: Date;
  analyzedAt: Date;
  clusterItemCount: number;
  clusterDistinctSourceCount: number;
}

export interface LoadUndecidedSignalsOptions {
  rulesVersionId: string;
  batch: number;
}

/**
 * Company-scope signals with an instrument that have NO live decision under
 * this rules version (live = decisions.replay_run_id IS NULL). Ordered
 * analyzed_at asc, id asc; a plain batch loop drains the set because every
 * decided signal leaves it — no cursor needed (unlike the resolver, nothing
 * here is permanently unresolvable: even a missing quote records a decision).
 */
export async function loadUndecidedSignals(
  db: Db,
  options: LoadUndecidedSignalsOptions,
): Promise<UndecidedSignal[]> {
  const rows = await db
    .select({
      id: llmSignals.id,
      clusterId: llmSignals.clusterId,
      instrumentId: llmSignals.instrumentId,
      assetClass: instruments.assetClass,
      eventType: llmSignals.eventType,
      direction: llmSignals.direction,
      expectedMoveBps: llmSignals.expectedMoveBps,
      horizon: llmSignals.horizon,
      alreadyExpected: llmSignals.alreadyExpected,
      materiality: llmSignals.materiality,
      confidence: llmSignals.confidence,
      anchorTs: newsClusters.firstReceivedAt,
      analyzedAt: llmSignals.analyzedAt,
      clusterItemCount: newsClusters.itemCount,
      clusterDistinctSourceCount: newsClusters.distinctSourceCount,
    })
    .from(llmSignals)
    .innerJoin(newsClusters, eq(newsClusters.id, llmSignals.clusterId))
    .innerJoin(instruments, eq(instruments.id, llmSignals.instrumentId))
    .leftJoin(
      decisions,
      and(
        eq(decisions.signalId, llmSignals.id),
        eq(decisions.rulesVersionId, options.rulesVersionId),
        isNull(decisions.replayRunId),
      ),
    )
    .where(
      and(
        eq(llmSignals.scope, 'company'),
        isNotNull(llmSignals.instrumentId),
        isNull(decisions.id),
      ),
    )
    .orderBy(asc(llmSignals.analyzedAt), asc(llmSignals.id))
    .limit(options.batch);

  return rows.map((row) => {
    if (row.instrumentId === null) {
      throw new Error(`loadUndecidedSignals: NULL instrument_id on company signal ${row.id}`);
    }
    return { ...row, instrumentId: row.instrumentId };
  });
}
