import type { scheduledEvents } from '../schema.js';

/**
 * Pure `calendar_match` / `already_expected` matcher — zero DB access.
 *
 * The decide() path prefetches ONE window of scheduled events (see
 * loadScheduledEventWindow in calendar-repo.ts) and probes it per item with
 * this function; it must never query per item. The result is the deterministic
 * ground truth that the LLM's `already_expected` judgment is calibrated
 * against (architecture §6).
 */

/** Kind union derived from the schema enum so it can never drift from the table. */
export type ScheduledEventKind = (typeof scheduledEvents.$inferSelect)['kind'];

export interface ScheduledEventLite {
  kind: ScheduledEventKind;
  /** null = macro event (matches ANY instrument); set = that instrument's earnings. */
  instrumentId: string | null;
  scheduledAt: Date;
}

export interface ScheduledEventProbe {
  /** Probe instant — a cluster's first_received_at (OUR clock, never published_at). */
  at: Date;
  /** Inclusive half-window: |scheduledAt − at| ≤ tolerance matches. */
  toleranceMinutes: number;
  /** Instrument the news resolves to; omit for macro-scope probes. */
  instrumentId?: string | undefined;
  /** Restrict matching to these kinds; omit = any kind. */
  kinds?: readonly ScheduledEventKind[] | undefined;
}

/**
 * True when a scheduled event falls within the tolerance of the probe time.
 *
 * Matching rules:
 * - Macro events (instrumentId null) match ANY probe, with or without an
 *   instrument — a CPI print is "expected" context for every instrument.
 * - Instrument-scoped events (earnings) match ONLY a probe for that same
 *   instrument; a probe without an instrumentId never matches them.
 * - The tolerance window is symmetric and inclusive on both edges: news minutes
 *   BEFORE a scheduled release (leaks/previews) is as "expected" as news after.
 */
export function isScheduledEvent(
  events: readonly ScheduledEventLite[],
  probe: ScheduledEventProbe,
): boolean {
  const toleranceMs = probe.toleranceMinutes * 60_000;
  const atMs = probe.at.getTime();

  for (const event of events) {
    if (Math.abs(event.scheduledAt.getTime() - atMs) > toleranceMs) continue;
    if (probe.kinds !== undefined && !probe.kinds.includes(event.kind)) continue;
    if (event.instrumentId !== null && event.instrumentId !== probe.instrumentId) continue;
    return true;
  }
  return false;
}
