import { createHash } from 'node:crypto';

import type { RawStore } from '@newstrader/core';

import type { LlmTransport } from '../shared-constants.js';
import type { LlmUsage } from './cost.js';

/**
 * Audit trail — the full prompt + raw response for EVERY attempt, success or
 * poison (a failure blob is exactly the evidence needed to debug the poison).
 * Written through the existing RawStore seam: FsRawStore locally, S3RawStore
 * over LlmAuditBucket deployed. The ref lands in llm_signals.prompt_ref AND
 * response_ref (one blob carries both halves), or in llm_attempts.audit_ref
 * for failures.
 */
export interface AuditBlob {
  /** 2 added `transport` — v1 blobs predate the CLI transport and are all 'api'. */
  schemaVersion: 2;
  signalKey: string;
  promptVersion: string;
  /**
   * Which client made the call. On 'cli' the effort and maxTokens below are
   * what was REQUESTED, not what applied — the CLI cannot set either, and
   * `response.contractDivergence` records that.
   */
  transport: LlmTransport;
  modelId: string;
  effort: string;
  maxTokens: number;
  /** Full fixed prefix, verbatim — "full prompt" means full. */
  systemPrompt: string;
  userPrompt: string;
  /**
   * The instant the context was reconstructed as of — `min(cluster anchor +
   * INTERPRET_OBSERVATION_LAG_MS, wall clock)`. Compare it against
   * analyzedAtIso to see how far back a backfill was reaching: the gap between
   * the two is exactly the look-ahead that v1 leaked and v2 does not.
   */
  observedAtIso: string;
  /** Stable projection of the API response (content, stop_reason, usage). */
  response: unknown;
  parsed: unknown;
  failure: string | null;
  usage: LlmUsage | null;
  latencyMs: number | null;
  analyzedAtIso: string;
}

/**
 * llm/{yyyy-mm-dd}/{sha256(signalKey)[0..16]}.json — deterministic per
 * (candidate × prompt version × model × day), so a same-day retry of a poison
 * overwrites its own blob instead of littering, while the signal-key hash
 * keeps keys path-safe regardless of what ids contain.
 */
export function auditKey(signalKey: string, analyzedAt: Date): string {
  const day = analyzedAt.toISOString().slice(0, 10);
  const hash = createHash('sha256').update(signalKey, 'utf8').digest('hex').slice(0, 16);
  return `llm/${day}/${hash}.json`;
}

export async function writeAuditBlob(store: RawStore, blob: AuditBlob): Promise<string> {
  return store.put(auditKey(blob.signalKey, new Date(blob.analyzedAtIso)), blob);
}
