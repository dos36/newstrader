import { fetchSecTickerMap, fetchSp500FromWikipedia, syncUniverse } from '@newstrader/db';
import type { Db } from '@newstrader/db';
import { getSsmParameter } from './lib/aws-api.js';
import { lambdaDb, lazyAsync, requireEnv } from './lib/boot.js';

/**
 * Universe-sync Lambda (EventBridge Scheduler, daily): the scheduled version
 * of `pnpm cli universe:sync`. Closes the M1 gap where the deployed stack had
 * no scheduled sync — point-in-time SPX membership only stays point-in-time if
 * the forward diff actually runs daily (a membership change observed a week
 * late would be recorded with the wrong valid_from).
 *
 * Wikipedia constituents cross-checked against SEC's company_tickers.json
 * (SEC wins CIK conflicts); both fetchers send the contact User-Agent from
 * /newstrader/edgar-user-agent — SEC rejects anonymous clients, Wikipedia gets
 * the same courtesy.
 */

interface UniverseSyncRuntime {
  db: Db;
  userAgent: string;
}

const runtime: () => Promise<UniverseSyncRuntime> = lazyAsync(async () => {
  const [db, userAgent] = await Promise.all([
    lambdaDb(),
    getSsmParameter(requireEnv('EDGAR_USER_AGENT_PARAM')),
  ]);
  return { db, userAgent };
});

export const handler = async (): Promise<void> => {
  const { db, userAgent } = await runtime();
  const counts = await syncUniverse(db, {
    fetchSp500: () => fetchSp500FromWikipedia({ userAgent }),
    fetchSecTickers: () => fetchSecTickerMap({ userAgent }),
  });
  console.log(JSON.stringify({ level: 'info', msg: 'universe_sync', ...counts }));
};
