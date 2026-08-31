import { anthropicTriageClient, checkKillSwitch, triageSweep } from '@newstrader/db';
import type { Db, TriageLlmClient } from '@newstrader/db';
import { intEnv, lambdaDb, lazyAsync, optionalSsmParameter } from './lib/boot.js';
import { S3RawStore } from './lib/s3-raw-store.js';
import { readKillSwitchFromSsm } from './lib/trading.js';

/**
 * Triage-sweep Lambda (EventBridge Scheduler, every 5 min) — resolver r2's
 * deployed driver: vendor-tagged items whose only links are source_hint
 * (parked at 0.65, below the interpretation gate) → one cheap claude-haiku
 * relevance call each → item_triage rows + confirmed llm_ner links at 0.9.
 * Without this sweep, deployed Massive items never clear the gate.
 *
 * The Anthropic key is OPTIONAL by design (interpret-sweep precedent): until
 * the operator creates /newstrader/anthropic-api-key, every invocation logs a
 * warn-skip and exits — the stack deploys and runs with zero LLM spend.
 *
 * API transport ONLY — the triage client has no CLI variant on purpose
 * (triage exists to make the pipeline cheaper; see triage-client.ts).
 *
 * Safety mirrors interpret-sweep: SSM kill switch (fail-closed — an SSM read
 * failure crashes the invocation), the per-UTC-day spend cap summed over BOTH
 * ledgers (llm_signals + item_triage share one budget), and the poison-pill
 * attempts cap. Reserved concurrency 1 keeps one sweep in flight (idempotent
 * anyway via the item_triage PK, and Anthropic rate limits appreciate it).
 *
 * Stores: audit blobs → LLM_AUDIT_BUCKET (llm-triage/{date}/{hash}.json at the
 * bucket root); item payloads ← their authoritative s3:// payload_ref
 * (RAW_BUCKET only anchors the client construction).
 */

interface TriageSweepRuntime {
  db: Db;
  /** null = key not provisioned — warn-skip mode. */
  llm: TriageLlmClient | null;
  auditStore: S3RawStore;
  payloadStore: S3RawStore;
}

const runtime: () => Promise<TriageSweepRuntime> = lazyAsync(async () => {
  const [db, apiKey] = await Promise.all([
    lambdaDb(),
    optionalSsmParameter('ANTHROPIC_API_KEY_PARAM'),
  ]);
  const auditBucket = process.env['LLM_AUDIT_BUCKET'];
  if (auditBucket === undefined || auditBucket.trim() === '') {
    throw new Error('Missing required env var LLM_AUDIT_BUCKET');
  }
  return {
    db,
    llm: apiKey === undefined ? null : anthropicTriageClient({ ANTHROPIC_API_KEY: apiKey }),
    auditStore: new S3RawStore({ bucket: auditBucket, keyPrefix: '' }),
    payloadStore: S3RawStore.fromEnv(process.env),
  };
});

function spendCapFromEnv(): number | undefined {
  const raw = process.env['LLM_DAILY_SPEND_USD_CAP'];
  if (raw === undefined || raw.trim() === '') return undefined;
  const parsed = Number(raw);
  if (!Number.isFinite(parsed) || parsed <= 0) {
    throw new Error(`LLM_DAILY_SPEND_USD_CAP must be a positive number, got "${raw}"`);
  }
  return parsed;
}

export const handler = async (): Promise<void> => {
  const { db, llm, auditStore, payloadStore } = await runtime();

  if (llm === null) {
    console.warn(
      JSON.stringify({
        level: 'warn',
        msg: 'triage_sweep_skipped',
        reason: 'ANTHROPIC_API_KEY SSM parameter not provisioned',
      }),
    );
    return;
  }

  const killSwitch = await checkKillSwitch({ read: readKillSwitchFromSsm });
  const cap = spendCapFromEnv();

  // triageSweep logs its own structured counts (msg: triage_sweep).
  const result = await triageSweep(
    db,
    {
      llm,
      auditStore,
      payloadStore,
      killSwitchHalted: killSwitch.halted,
    },
    {
      batch: intEnv('TRIAGE_BATCH', 25),
      ...(cap !== undefined ? { dailySpendCapUsd: cap } : {}),
    },
  );

  // Transport failures abort the pass without burning an attempt, so a normal
  // return would hide them from the Lambda-Errors alarm. Throwing is safe —
  // completed items are already persisted and the scheduler target sets
  // retryAttempts: 0, so the next tick simply retries the remainder.
  if (result.transportError !== null) {
    throw new Error(`triage sweep aborted on transport error: ${result.transportError}`);
  }
};
