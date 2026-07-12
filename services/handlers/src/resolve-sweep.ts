import { resolveUnlinkedItems } from '@newstrader/db';
import type { ResolveCursor } from '@newstrader/db';
import { intEnv, lambdaDb } from './lib/boot.js';

/**
 * Resolve-sweep Lambda (EventBridge Scheduler, hourly): one full keyset-cursor
 * sweep over every unlinked raw item — the scheduled version of `pnpm cli
 * resolve`. The process Lambda resolves items inline as they arrive; this
 * sweep is the backstop that retroactively links items ingested before the
 * dictionary knew their instruments (universe-sync runs out-of-band, and the
 * process Lambda's dictionary cache is up to 5 minutes stale).
 *
 * The cursor advances past unresolvable items too (the majority class:
 * non-S&P filings), so a head-of-queue block cannot starve the sweep; a sweep
 * is done when a pass examined fewer than a full batch. There is no
 * cross-invocation cursor on purpose — each run re-examines every unlinked
 * item, which is exactly what "a new dictionary entry retroactively resolves
 * old items" requires (resolver r1 keeps no no-match marker).
 */

export const handler = async (): Promise<void> => {
  const db = await lambdaDb();
  const batch = intEnv('RESOLVE_BATCH', 500);

  const totals = { passes: 0, processed: 0, linked: 0, linksWritten: 0 };
  let after: ResolveCursor | undefined;
  for (;;) {
    const counts = await resolveUnlinkedItems(db, {
      batch,
      ...(after !== undefined ? { after } : {}),
    });
    totals.passes += 1;
    totals.processed += counts.processed;
    totals.linked += counts.linked;
    totals.linksWritten += counts.linksWritten;
    if (counts.processed < batch || counts.lastKey === null) break;
    after = counts.lastKey;
  }

  console.log(JSON.stringify({ level: 'info', msg: 'resolve_sweep', ...totals }));
};
