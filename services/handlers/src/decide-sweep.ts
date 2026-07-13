import { SQSClient } from '@aws-sdk/client-sqs';
import { DEFAULT_RULES_LABEL, decide } from '@newstrader/core';
import {
  checkKillSwitch,
  decideSignals,
  ensureDefaultRules,
  getRulesVersion,
} from '@newstrader/db';
import type { Db, SimBrokerAdapter } from '@newstrader/db';
import { intEnv, lambdaDb, lazyAsync } from './lib/boot.js';
import { enqueueJsonMessages } from './lib/queue.js';
import {
  loadPendingOpenIntents,
  readKillSwitchFromSsm,
  resolveEngineVersion,
  simBrokerFromEnv,
} from './lib/trading.js';

/**
 * Decide-sweep Lambda (EventBridge Scheduler, every 5 min — architecture
 * §1/§5.4): run the pure decision engine over every undecided llm_signals row
 * and enqueue order intents to q-orders. This is a SWEEP, deliberately not
 * wired into the process Lambda: signals do not exist until M2 populates
 * llm_signals, and a query-driven sweep needs no message-schema change when
 * they do. Signals arrive at most one sweep-interval (~5 min) before decide —
 * noise at an hours horizon.
 *
 * VENUE IS SIM ONLY (v1): the broker is the SimBrokerAdapter; going live is a
 * code change, not configuration.
 *
 * Kill switch (SSM /newstrader/kill-switch, <=30s cache): when halted,
 * decisions are still RECORDED with suppressed=true — research data never
 * stops — and NOTHING is enqueued. The execute Lambda re-checks the switch
 * independently before placing anything.
 *
 * Emit path (at-least-once by re-derive): intents are re-derived from
 * decisions rows that have no orders row (loadPendingOpenIntents) rather than
 * taken from decideSignals' return value, so a crash or failed SQS send after
 * the decision insert is repaired by the next sweep; the deterministic
 * clientOrderId makes redeliveries collapse at the broker. Reserved
 * concurrency 1: two overlapping sweeps would double-enqueue harmlessly, but
 * there is no reason to allow it.
 */

interface DecideSweepRuntime {
  db: Db;
  broker: SimBrokerAdapter;
  sqs: SQSClient;
  queueUrl: string;
  rulesLabel: string;
}

const runtime: () => Promise<DecideSweepRuntime> = lazyAsync(async () => {
  const db = await lambdaDb();
  // Idempotent seed: the shipped default config (empty whitelist — trades
  // NOTHING) must exist before the first sweep can decide under it.
  await ensureDefaultRules(db);
  const queueUrl = process.env['Q_ORDERS_URL'];
  if (queueUrl === undefined || queueUrl.trim() === '') {
    throw new Error('Missing required env var Q_ORDERS_URL');
  }
  return {
    db,
    broker: simBrokerFromEnv(db),
    sqs: new SQSClient({}),
    queueUrl,
    rulesLabel: process.env['RULES_LABEL'] ?? DEFAULT_RULES_LABEL,
  };
});

export const handler = async (): Promise<void> => {
  const { db, broker, sqs, queueUrl, rulesLabel } = await runtime();

  const killSwitch = await checkKillSwitch({ read: readKillSwitchFromSsm });
  const totals = await decideSignals(
    db,
    {
      decide,
      broker,
      killSwitchHalted: killSwitch.halted,
      engineVersion: resolveEngineVersion(),
    },
    { rulesLabel, batch: intEnv('DECIDE_BATCH', 200) },
  );

  let enqueued = 0;
  if (!killSwitch.halted) {
    const rules = await getRulesVersion(db, rulesLabel);
    // Minted AFTER decideSignals, not before: loadPendingOpenIntents filters
    // decided_at <= now, so a cutoff captured before decideSignals ran would
    // be OLDER than the decided_at it just wrote — a freshly-decided open
    // would always miss THIS sweep's enqueue and wait a full 5-min cycle.
    const now = new Date();
    const intents = await loadPendingOpenIntents(db, { rulesVersionId: rules.id, now });
    if (intents.length > 0) {
      await enqueueJsonMessages(sqs, queueUrl, intents);
      enqueued = intents.length;
    }
  }

  console.log(
    JSON.stringify({
      level: 'info',
      msg: 'decide_sweep',
      rulesLabel,
      killSwitch: killSwitch.state,
      examined: totals.examined,
      decided: totals.decided,
      opens: totals.opens,
      skips: totals.skips,
      suppressed: totals.suppressed,
      enqueued,
    }),
  );
};
