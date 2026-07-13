import { DEFAULT_RULES_LABEL } from '@newstrader/core';
import {
  checkKillSwitch,
  ensureDefaultRules,
  evaluateOpenPositions,
  getRulesVersion,
} from '@newstrader/db';
import type { Db, SimBrokerAdapter } from '@newstrader/db';
import { lambdaDb, lazyAsync } from './lib/boot.js';
import { engineExitEvaluator, readKillSwitchFromSsm, simBrokerFromEnv } from './lib/trading.js';

/**
 * Position-manager Lambda (EventBridge Scheduler, every 15 min — architecture
 * §5.4: "signal-driven pipelines forget exits — this one doesn't"). Evaluates
 * every derived open position against the exit policy of the live rules
 * version (time stop at the signal's horizon, stop-loss/take-profit in ATR
 * multiples) and closes through the SimBrokerAdapter — VENUE IS SIM ONLY.
 *
 * Exits are decisions too: every close is recorded as an action='close'
 * decisions row under the same versioning machinery as entries, so exits
 * replay. The exit rules themselves are the engine's pure evaluateExit,
 * injected via engineExitEvaluator.
 *
 * Kill switch (SSM, checked inside evaluateOpenPositions independently of
 * decide): when halted, close decisions are still RECORDED with
 * suppressed=true and no order is placed; the real close (bare decision key)
 * fires on the first run after the switch clears.
 */

interface PositionManagerRuntime {
  db: Db;
  broker: SimBrokerAdapter;
  rulesLabel: string;
}

const runtime: () => Promise<PositionManagerRuntime> = lazyAsync(async () => {
  const db = await lambdaDb();
  // Same idempotent seed as decide-sweep: the default label must resolve even
  // if this function cold-starts first after a fresh deploy.
  await ensureDefaultRules(db);
  return {
    db,
    broker: simBrokerFromEnv(db),
    rulesLabel: process.env['RULES_LABEL'] ?? DEFAULT_RULES_LABEL,
  };
});

export const handler = async (): Promise<void> => {
  const { db, broker, rulesLabel } = await runtime();
  const rules = await getRulesVersion(db, rulesLabel);

  const result = await evaluateOpenPositions(db, {
    broker,
    rules: rules.config,
    rulesVersionId: rules.id,
    now: new Date(),
    evaluateExit: engineExitEvaluator,
    checkHalted: async () => (await checkKillSwitch({ read: readKillSwitchFromSsm })).halted,
  });

  console.log(
    JSON.stringify({
      level: 'info',
      msg: 'position_manager',
      rulesLabel,
      evaluated: result.evaluated,
      closed: result.closed,
      suppressed: result.suppressed,
      skipped: result.skipped,
      details: result.details,
    }),
  );
};
