import { anthropicLlmClient, checkKillSwitch, interpretSweep } from '@newstrader/db';
import type { Db, LlmClient } from '@newstrader/db';
import { intEnv, lambdaDb, lazyAsync, optionalSsmParameter } from './lib/boot.js';
import { S3RawStore } from './lib/s3-raw-store.js';
import { readKillSwitchFromSsm } from './lib/trading.js';

/**
 * Interpret-sweep Lambda (EventBridge Scheduler, every 5 min) — M2's deployed
 * driver: novel (cluster × instrument) pairs → one claude-sonnet-5 structured
 * call each → llm_signals rows. decide-sweep picks the rows up on its own
 * 5-min cadence; the LLM itself never touches the money path.
 *
 * The Anthropic key is OPTIONAL by design (Finnhub precedent): the
 * SecureString may not be provisioned yet, in which case every invocation
 * logs a warn-skip and exits — the stack deploys and runs without LLM spend
 * until the operator creates /newstrader/anthropic-api-key.
 *
 * API transport ONLY. The CLI transport (claudeCliLlmClient) is dev-only and
 * refuses to construct when AWS_LAMBDA_FUNCTION_NAME is set: subscription auth
 * is interactive, and its rows cannot honour the prompt version's effort or
 * max_tokens. Deployed rows are always transport='api'.
 *
 * Safety mirrors the CLI path exactly: SSM kill switch (fail-closed — an SSM
 * read failure crashes the invocation), the per-UTC-day spend cap over
 * SUM(cost_usd), and the poison-pill attempts cap. Reserved concurrency 1
 * keeps one sweep in flight (idempotent anyway via signal_key, and Anthropic
 * rate limits appreciate it).
 *
 * Stores: audit blobs → LLM_AUDIT_BUCKET (llm/{date}/{hash}.json at the
 * bucket root); item payloads ← their authoritative s3:// payload_ref
 * (RAW_BUCKET only anchors the client construction).
 */

interface InterpretSweepRuntime {
  db: Db;
  /** null = key not provisioned — warn-skip mode. */
  llm: LlmClient | null;
  auditStore: S3RawStore;
  payloadStore: S3RawStore;
}

const runtime: () => Promise<InterpretSweepRuntime> = lazyAsync(async () => {
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
    llm: apiKey === undefined ? null : anthropicLlmClient({ ANTHROPIC_API_KEY: apiKey }),
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
        msg: 'interpret_sweep_skipped',
        reason: 'ANTHROPIC_API_KEY SSM parameter not provisioned',
      }),
    );
    return;
  }

  const killSwitch = await checkKillSwitch({ read: readKillSwitchFromSsm });
  const cap = spendCapFromEnv();

  // interpretSweep logs its own structured counts (msg: interpret_sweep).
  const result = await interpretSweep(
    db,
    {
      llm,
      auditStore,
      payloadStore,
      killSwitchHalted: killSwitch.halted,
    },
    {
      batch: intEnv('INTERPRET_BATCH', 25),
      lookbackHours: intEnv('INTERPRET_LOOKBACK_HOURS', 24),
      ...(cap !== undefined ? { dailySpendCapUsd: cap } : {}),
    },
  );

  // A transport failure (bad key, Anthropic outage) aborts the pass without
  // burning an attempt, so returning normally made it invisible: every alarm
  // here is Lambda-Errors-based. Throwing is safe — completed candidates are
  // already persisted and the scheduler target sets retryAttempts: 0, so the
  // next tick simply retries the remainder.
  if (result.transportError !== null) {
    throw new Error(`interpret sweep aborted on transport error: ${result.transportError}`);
  }
};
