import { execFileSync } from 'node:child_process';
import { OrderIntent, buildOrderIntent, evaluateExit } from '@newstrader/core';
import { checkKillSwitch, SimBrokerAdapter } from '@newstrader/db';
import type { Db, ExitEvaluator, KillSwitchStatus, PortfolioFill } from '@newstrader/db';
import { getSsmParameter } from './aws-api.js';
import { requireEnv } from './boot.js';

/**
 * Shared M4/M5 trading wiring: the glue between the pure engine
 * (packages/core/src/decide), the DB orchestration layer
 * (packages/db/src/{trading,execution}), and the two runners (CLI + Lambdas).
 * Same placement rationale as ingest.ts — the CLI reaches this via a relative
 * import; the Lambda bundler sees only in-package imports. Reads use
 * parameterized SQL over db.$client because neither service package declares
 * drizzle-orm (see ingest.ts "DB access style").
 *
 * VENUE IS SIM ONLY in v1: the only BrokerAdapter constructed anywhere is the
 * SimBrokerAdapter. Going live requires code changes, not configuration
 * (architecture §0).
 */

// ------------------------------------------------------------ exit adapter --

/**
 * Adapt the engine's pure evaluateExit to the position manager's injected
 * ExitEvaluator seam (packages/db/src/execution/position-manager.ts keeps zero
 * compile-time dependency on engine code; the wiring passes the evaluator in).
 *
 * A null ATR-at-entry maps to '0': the engine documents that a non-positive
 * stop/take-profit distance disables those price rules (they would otherwise
 * insta-close at entry) while the mandatory time stop still applies — exactly
 * the honest behavior for a position whose entry ATR was unknown.
 */
export const engineExitEvaluator: ExitEvaluator = (input) =>
  evaluateExit({
    entryPrice: input.avgEntryPrice,
    qty: input.qty,
    side: input.side,
    openedAt: input.entryDecidedAt,
    horizon: input.horizon,
    atrAtEntry: input.atrAtEntry ?? '0',
    config: input.config.exits,
    latestPrice: input.latestClose,
    now: input.now,
  });

// ---------------------------------------------------------- engine version --

/**
 * The engine build stamp recorded into every decision's features
 * (DecideFeatures.engineVersion — config versioning does not protect against
 * code drift, architecture §5.4). Resolution order:
 *   1. ENGINE_VERSION env — set by infra at synth time from the deployed git
 *      SHA, so Lambda decisions carry the code they actually ran;
 *   2. `git rev-parse --short HEAD` — local CLI runs inside the repo;
 *   3. 'unknown' — never throw over a stamp (the decision still records).
 */
export function resolveEngineVersion(): string {
  const fromEnv = process.env['ENGINE_VERSION'];
  if (fromEnv !== undefined && fromEnv.trim() !== '') return fromEnv.trim();
  cachedGitVersion ??= gitShortSha();
  return cachedGitVersion;
}

let cachedGitVersion: string | undefined;

function gitShortSha(): string {
  try {
    return execFileSync('git', ['rev-parse', '--short', 'HEAD'], {
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'ignore'],
    }).trim();
  } catch {
    return 'unknown';
  }
}

// -------------------------------------------------------- kill switch (SSM) --

/** Env var carrying the kill-switch SSM parameter NAME (set by infra). */
export const KILL_SWITCH_PARAM_ENV = 'KILL_SWITCH_PARAM';

/** Architecture §4.4: decide/execute read the switch with a <=30s cache. */
export const KILL_SWITCH_CACHE_MS = 30_000;

let killSwitchCache: { value: string; expiresAt: number } | undefined;

/**
 * SSM-backed kill-switch reader for checkKillSwitch({ read }). Lambdas call
 * this with no argument (reads the parameter NAME from the KILL_SWITCH_PARAM
 * env var, set by infra); the CLI's cliKillSwitch() below calls it with an
 * explicit paramName instead (KILL_SWITCH_SSM_PARAM), so the two runners can
 * use differently-named env vars for the same underlying SSM parameter.
 * Only successful reads are cached — an SSM failure propagates and fails the
 * invocation loudly; silently assuming 'run' on a broken read would defeat
 * the switch. Lambdas let that propagation crash the invocation (fail
 * closed by crash); the CLI catches it instead (see cliKillSwitch).
 */
export async function readKillSwitchFromSsm(paramName?: string): Promise<string> {
  const now = Date.now();
  if (killSwitchCache !== undefined && now < killSwitchCache.expiresAt) {
    return killSwitchCache.value;
  }
  const value = await getSsmParameter(paramName ?? requireEnv(KILL_SWITCH_PARAM_ENV));
  killSwitchCache = { value, expiresAt: now + KILL_SWITCH_CACHE_MS };
  return value;
}

/** Env var carrying the SSM parameter NAME the CLI should read (unset = local env reader). */
export const CLI_KILL_SWITCH_SSM_PARAM_ENV = 'KILL_SWITCH_SSM_PARAM';

/**
 * CLI kill-switch getter. When KILL_SWITCH_SSM_PARAM is set (operating
 * against a deployed DB), reads that SSM parameter via readKillSwitchFromSsm
 * — and ANY read failure (network, IAM, missing parameter) means HALT.
 * This deliberately does NOT mirror the Lambda paths: a Lambda crashing on a
 * thrown read is fail-closed too (the invocation never reaches decide/
 * execute), but the CLI is a long-lived-enough process (loops, multiple
 * commands) that letting the read throw would either crash a command that
 * has no business crashing, or — worse — get wrapped by a caller that
 * swallows the error and falls through to "just trade". So the CLI catches
 * the failure itself and returns an explicit halt.
 *
 * When KILL_SWITCH_SSM_PARAM is unset, falls back to the local/dev env
 * reader (NEWSTRADER_KILL_SWITCH via checkKillSwitch()'s default), which
 * fails OPEN when absent — documented in kill-switch.ts as LOCAL-ONLY.
 */
export async function cliKillSwitch(): Promise<KillSwitchStatus> {
  const paramName = process.env[CLI_KILL_SWITCH_SSM_PARAM_ENV];
  if (paramName === undefined || paramName.trim() === '') {
    return checkKillSwitch(); // local/dev: NEWSTRADER_KILL_SWITCH env var
  }
  try {
    return await checkKillSwitch({ read: () => readKillSwitchFromSsm(paramName) });
  } catch (error) {
    console.error(
      JSON.stringify({
        level: 'error',
        msg: 'cli_kill_switch_ssm_read_failed',
        param: paramName,
        error: error instanceof Error ? error.message : String(error),
      }),
    );
    return { state: 'halt', halted: true, raw: null };
  }
}

// ------------------------------------------------------------------ broker --

/**
 * The v1 broker: SimBroker over recorded bars (venue 'sim'). PAPER_EQUITY_USD
 * overrides the starting cash (decimal string); unset = the $100k default.
 */
export function simBrokerFromEnv(db: Db): SimBrokerAdapter {
  return new SimBrokerAdapter(db, { paperEquityUsd: process.env['PAPER_EQUITY_USD'] });
}

// -------------------------------------------------------- pending intents --

/**
 * Open decisions older than this are NOT re-emitted as order intents. The
 * re-emit sweep exists to survive lost enqueues and kill-switch halts, not to
 * fire hours-stale entries at an hours-horizon strategy: a halt (or outage)
 * longer than this window simply expires the pending entries — the decisions
 * rows remain as research data.
 */
export const INTENT_MAX_AGE_MS = 6 * 60 * 60 * 1000;

export interface LoadPendingIntentsOptions {
  rulesVersionId: string;
  now: Date;
  /** Default INTENT_MAX_AGE_MS. */
  maxAgeMs?: number;
  /** Default 100. */
  limit?: number;
}

interface PendingIntentRow {
  decision_key: string;
  instrument_id: string;
  action: 'open_long' | 'open_short';
  sized_qty: string;
  asset_class: 'us_equity' | 'crypto';
}

/**
 * Rebuild OrderIntents for live, NON-suppressed open decisions that have no
 * orders row yet. This is the durable emit path (at-least-once by re-derive):
 * decideSignals returns intents for freshly inserted opens, but a crash or a
 * failed SQS send between "decision recorded" and "intent delivered" would
 * otherwise strand the open forever — the decision row already exists, so no
 * later pass would re-examine it. Re-deriving from the decisions table makes
 * every sweep re-emit anything undelivered; the deterministic clientOrderId
 * (sha256 of decision_key) makes duplicates collapse at the broker.
 *
 * Suppressed rows are excluded by definition (kill switch: recorded, never
 * ordered). Rejected orders are terminal: an orders row exists, so they are
 * never re-emitted.
 */
export async function loadPendingOpenIntents(
  db: Db,
  options: LoadPendingIntentsOptions,
): Promise<OrderIntent[]> {
  const maxAgeMs = options.maxAgeMs ?? INTENT_MAX_AGE_MS;
  const limit = options.limit ?? 100;
  const result = await db.$client.query<PendingIntentRow>(
    `select d.decision_key, d.instrument_id, d.action, d.sized_qty, i.asset_class
       from decisions d
       join instruments i on i.id = d.instrument_id
       left join orders o on o.decision_id = d.id
      where d.replay_run_id is null
        and d.rules_version_id = $1
        and d.suppressed = false
        and d.action in ('open_long', 'open_short')
        and d.sized_qty is not null
        and d.decided_at >= $2
        and d.decided_at <= $3
        and o.id is null
      order by d.decided_at asc, d.id asc
      limit $4`,
    [options.rulesVersionId, new Date(options.now.getTime() - maxAgeMs), options.now, limit],
  );
  return result.rows.map((row) =>
    buildOrderIntent({
      decisionKey: row.decision_key,
      instrumentId: row.instrument_id,
      assetClass: row.asset_class,
      action: row.action,
      qty: row.sized_qty,
    }),
  );
}

// ------------------------------------------------------------- sim fills --

interface SimFillRow {
  id: string;
  instrument_id: string;
  side: 'buy' | 'sell';
  qty: string;
  price: string;
  fee: string;
  filled_at: Date;
}

/**
 * All sim-venue fills in chronological order, shaped for derivePortfolio —
 * the same derivation the SimBrokerAdapter runs internally, exposed for the
 * CLI's positions/stats reporting (realized P&L, fees, cash delta).
 */
export async function loadSimPortfolioFills(db: Db): Promise<PortfolioFill[]> {
  const result = await db.$client.query<SimFillRow>(
    `select f.id, o.instrument_id, o.side, f.fill_qty as qty, f.fill_price as price,
            f.fee, f.filled_at
       from fills f
       join orders o on o.id = f.order_id
      where o.venue = 'sim'
      order by f.filled_at asc, f.id asc`,
  );
  return result.rows.map((row) => ({
    id: row.id,
    instrumentId: row.instrument_id,
    side: row.side,
    qty: row.qty,
    price: row.price,
    fee: row.fee,
    filledAt: row.filled_at,
  }));
}

// --------------------------------------------------------- intent messages --

/** Poison-pill-safe parse of a q-orders message body (mirrors parseRawItemRecord). */
export function parseOrderIntentRecord(body: string): OrderIntent | null {
  try {
    const result = OrderIntent.safeParse(JSON.parse(body));
    return result.success ? result.data : null;
  } catch {
    return null;
  }
}
