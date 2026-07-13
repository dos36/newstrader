/**
 * Kill-switch check — architecture §4.4. The switch is read INDEPENDENTLY by
 * decide-time recording and by execution: when tripped, decisions keep being
 * RECORDED with suppressed=true (research data never stops), and no order is
 * ever emitted or sent.
 *
 * Pure decision over injected I/O: the read itself is a supplied getter (the
 * CLI/Lambda wiring passes an SSM Parameter Store reader; local/dev falls back
 * to the NEWSTRADER_KILL_SWITCH env var). This module never imports AWS.
 *
 * FAIL-CLOSED semantics (money-path grade): only the literal value 'run'
 * (or an absent/empty value — the not-provisioned default) permits trading.
 * 'halt' halts, and any UNRECOGNIZED value also halts: a typo'd or corrupted
 * switch parameter must never quietly mean "keep trading".
 */

/** Env var read by the default getter (local/dev; Lambdas inject SSM instead). */
export const KILL_SWITCH_ENV = 'NEWSTRADER_KILL_SWITCH';

export type KillSwitchState = 'run' | 'halt';

export interface KillSwitchDeps {
  /**
   * Returns the raw switch value (SSM parameter / env var), or undefined when
   * not provisioned. Sync or async. Default: process.env[KILL_SWITCH_ENV].
   */
  read?: (() => Promise<string | undefined> | string | undefined) | undefined;
}

export interface KillSwitchStatus {
  state: KillSwitchState;
  /** Convenience: state === 'halt'. Execution must not emit orders when true. */
  halted: boolean;
  /** Raw value observed (trimmed), null when absent — for decision snapshots/logs. */
  raw: string | null;
}

/** Read and interpret the kill switch. Never throws on VALUE content (fail-closed instead). */
export async function checkKillSwitch(deps?: KillSwitchDeps): Promise<KillSwitchStatus> {
  const read = deps?.read ?? (() => process.env[KILL_SWITCH_ENV]);
  const rawValue = await read();
  const trimmed = rawValue?.trim() ?? '';
  const raw = trimmed === '' ? null : trimmed;

  // Absent/empty = run (default state before the parameter is provisioned).
  // This fail-OPEN default is LOCAL-ONLY: it is only reachable via the bare
  // env-var reader (no `deps.read` supplied), which is what the CLI falls
  // back to when KILL_SWITCH_SSM_PARAM is unset (services/handlers/src/lib/
  // trading.ts). Every other path fails CLOSED — decide-sweep/execute/
  // position-manager inject an SSM reader that THROWS on any read failure,
  // crashing the invocation before an order can be placed; the CLI's SSM path
  // catches that same failure and returns 'halt' explicitly, since a crashed
  // CLI process must not fall through to this default.
  const state: KillSwitchState = raw === null || raw.toLowerCase() === 'run' ? 'run' : 'halt';
  return { state, halted: state === 'halt', raw };
}
