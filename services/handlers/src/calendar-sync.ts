import { defaultCalendarDeps, syncCalendar } from '@newstrader/db';
import type { Db, SyncCalendarDeps } from '@newstrader/db';
import { getSsmParameter } from './lib/aws-api.js';
import { intEnv, lambdaDb, lazyAsync, optionalSsmParameter, requireEnv } from './lib/boot.js';

/**
 * Calendar-sync Lambda (EventBridge Scheduler, daily): upserts scheduled_events
 * from the free macro calendars (FOMC / BLS CPI+NFP / BEA GDP+PCE) and — once
 * the operator provisions /newstrader/finnhub-api-key — the Finnhub earnings
 * calendar for current S&P 500 members. Feeds the deterministic
 * already_expected / calendar_match decision feature (architecture §6).
 *
 * The Finnhub key is OPTIONAL by design: the SecureString may not exist yet,
 * so its absence downgrades to a warn (optionalSsmParameter) and the macro
 * calendars still sync — mirroring defaultCalendarDeps' own skip-with-warning
 * behavior for a missing FINNHUB_API_KEY.
 */

interface CalendarSyncRuntime {
  db: Db;
  deps: SyncCalendarDeps;
}

const runtime: () => Promise<CalendarSyncRuntime> = lazyAsync(async () => {
  const [db, userAgent, finnhubKey] = await Promise.all([
    lambdaDb(),
    // Contact User-Agent for the .gov fetches — same courtesy header EDGAR requires.
    getSsmParameter(requireEnv('EDGAR_USER_AGENT_PARAM')),
    optionalSsmParameter('FINNHUB_API_KEY_PARAM'),
  ]);
  return {
    db,
    deps: defaultCalendarDeps({ EDGAR_USER_AGENT: userAgent, FINNHUB_API_KEY: finnhubKey }),
  };
});

export const handler = async (): Promise<void> => {
  const { db, deps } = await runtime();
  // syncCalendar logs its own structured counts (msg: calendar_sync).
  await syncCalendar(db, deps, { horizonDays: intEnv('CALENDAR_HORIZON_DAYS', 90) });
};
