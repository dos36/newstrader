/**
 * Event-window math for backfills — pure functions, no DB, no network.
 *
 * A reaction/recovery measurement needs bars around a cluster anchor
 * (first_received_at — OUR clock, never published_at): 72 h of context before
 * and the full 5 d horizon after (REACTION_HORIZONS tops out at 5d). Clusters
 * about the same instrument arrive in bursts, so naive per-anchor fetching
 * would re-download heavily overlapping ranges; the backfill coalesces each
 * instrument's windows into disjoint spans first.
 */

/** Half-open-ish millisecond span; from <= to always holds after validation. */
export interface WindowMs {
  fromMs: number;
  toMs: number;
}

/**
 * 72 h of pre-anchor context. Off-hours anchors are the NORM for filings
 * (late-Friday 8-Ks, weekend crypto news): the anchor price is the prior
 * session's close, which can sit up to ~3 days back across a long weekend.
 * A 1 h window left every weekend anchor permanently unmeasurable.
 */
export const EVENT_WINDOW_BEFORE_MS = 72 * 60 * 60 * 1000;
/**
 * 5 d post-anchor — the longest reaction/recovery horizon.
 *
 * Deliberately NARROWER than what the measurer READS (reaction/measure-repo.ts
 * reads 5 d + a 3 d settling buffer, because a horizon landing on a weekend needs
 * a later bar to prove the gap was non-trading rather than the end of our data).
 * The asymmetry is fine in normal operation: the continuous bars-recorder fills
 * everything forward minute by minute, so the proof bars exist without any event
 * window asking for them. It matters in exactly one case — a pure historical
 * backfill with no recorder running, where the newest anchors' 5 d horizons stay
 * unmeasurable until a later backfill extends past them.
 * (The BEFORE side, by contrast, must match the measurer's — see above.)
 */
export const EVENT_WINDOW_AFTER_MS = 5 * 24 * 60 * 60 * 1000;

/** The bar-fetch window for one cluster anchor. */
export function eventWindow(anchor: Date): WindowMs {
  return {
    fromMs: anchor.getTime() - EVENT_WINDOW_BEFORE_MS,
    toMs: anchor.getTime() + EVENT_WINDOW_AFTER_MS,
  };
}

/**
 * Merge overlapping or touching windows into the minimal set of disjoint
 * spans, sorted ascending. Input order does not matter. Touching windows
 * (a.toMs === b.fromMs) merge too — bar ranges are inclusive at both ends, so
 * fetching them separately would double-fetch the boundary minute.
 * Throws on an inverted window (fromMs > toMs): that is caller corruption
 * (e.g. a clock bug), never something to silently "fix".
 */
export function coalesceWindows(windows: readonly WindowMs[]): WindowMs[] {
  for (const w of windows) {
    if (w.fromMs > w.toMs) {
      throw new Error(`coalesceWindows: inverted window [${w.fromMs}, ${w.toMs}]`);
    }
  }
  const sorted = [...windows].sort((a, b) => a.fromMs - b.fromMs || a.toMs - b.toMs);
  const merged: WindowMs[] = [];
  for (const w of sorted) {
    const previous = merged[merged.length - 1];
    if (previous !== undefined && w.fromMs <= previous.toMs) {
      previous.toMs = Math.max(previous.toMs, w.toMs);
    } else {
      merged.push({ ...w });
    }
  }
  return merged;
}
