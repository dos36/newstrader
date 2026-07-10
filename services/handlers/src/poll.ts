import { SQSClient } from '@aws-sdk/client-sqs';
import type { SourceAdapter } from '@newstrader/core';
import type { Db } from '@newstrader/db';
import { lambdaDb, lazyAsync, pollerAdapters, requireEnv } from './lib/boot.js';
import { runPoll } from './lib/ingest.js';
import { enqueueRawItems } from './lib/queue.js';
import { S3RawStore } from './lib/s3-raw-store.js';

/**
 * Poller Lambda (EventBridge Scheduler → here, one function per source family;
 * POLLER_SOURCES = edgar | massive | rss). Per architecture §4.1 a poller does
 * exactly three things per adapter: fetch since its cursor, write the raw
 * payload to S3 raw/, enqueue a pointer to q-items. No parsing, no dedup.
 */

interface PollRuntime {
  db: Db;
  adapters: SourceAdapter[];
  rawStore: S3RawStore;
  sqs: SQSClient;
  queueUrl: string;
}

const runtime: () => Promise<PollRuntime> = lazyAsync(async () => {
  const [db, adapters] = await Promise.all([
    lambdaDb(),
    pollerAdapters(requireEnv('POLLER_SOURCES')),
  ]);
  return {
    db,
    adapters,
    rawStore: S3RawStore.fromEnv(process.env),
    sqs: new SQSClient({}),
    queueUrl: requireEnv('Q_ITEMS_URL'),
  };
});

export const handler = async (): Promise<void> => {
  const { db, adapters, rawStore, sqs, queueUrl } = await runtime();

  // Sequential on purpose: EDGAR fair-access wants ≪10 req/s, and nothing at
  // this volume needs parallel polls. One adapter failing must not starve the
  // rest — collect failures and fail the invocation at the end (error-rate
  // alarms see it; the next scheduled tick supersedes, retryAttempts is 0).
  const failures: string[] = [];
  for (const adapter of adapters) {
    try {
      const counts = await runPoll(
        { db, rawStore, enqueue: (messages) => enqueueRawItems(sqs, queueUrl, messages) },
        adapter,
      );
      console.log(JSON.stringify({ level: 'info', msg: 'poll', ...counts }));
    } catch (error) {
      failures.push(adapter.sourceKey);
      console.error(
        JSON.stringify({
          level: 'error',
          msg: 'poll_failed',
          sourceKey: adapter.sourceKey,
          error: String(error),
        }),
      );
    }
  }

  if (failures.length > 0) {
    throw new Error(`poll cycle failed for: ${failures.join(', ')}`);
  }
};
