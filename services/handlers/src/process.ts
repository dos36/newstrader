import { attachItemToCluster, loadResolverDictionary } from '@newstrader/db';
import type { Db, ResolverDictionary } from '@newstrader/db';
import type { SQSBatchItemFailure, SQSBatchResponse, SQSEvent } from 'aws-lambda';
import { lambdaDb } from './lib/boot.js';
import { loadItemsByIds, parseRawItemRecord, resolveProcessItem } from './lib/ingest.js';

/**
 * Process Lambda (q-items → here, batch 5, ReportBatchItemFailures enabled).
 * M1 scope: dedup/cluster, then deterministic entity resolution — each item is
 * attached to its story cluster and linked to instruments via the dictionary
 * matcher (interpret/decide run as their own 5-min sweeps, not from here —
 * a query-driven sweep needs no message-schema change).
 *
 * Idempotency comes from Postgres (attach is advisory-locked and treats
 * redelivery as a no-op; link inserts are conflict-do-nothing on their PK), so
 * at-least-once SQS delivery is safe. Unparseable bodies are poison pills:
 * reported as item failures so the redrive policy moves them to the DLQ after
 * maxReceiveCount — never retried past that (architecture §4.2/§4.3).
 */

/**
 * Memoize the resolver dictionary across warm invocations, like lambdaDb, but
 * with a TTL: universe:sync changes instruments/aliases out-of-band, and a
 * warm container must pick that up without a redeploy. 5 minutes staleness is
 * tolerable, with one honest caveat: items missed during the window stay
 * unlinked until a `resolve` backfill sweep runs. That sweep IS deployed — the
 * analytics stack runs resolve-sweep hourly and universe-sync daily — so the
 * worst case is a link arriving up to an hour late, not never arriving.
 */
const DICTIONARY_TTL_MS = 5 * 60_000;
let dictionaryCache: { dictionary: ResolverDictionary; expiresAt: number } | undefined;

async function lambdaDictionary(db: Db): Promise<ResolverDictionary> {
  const now = Date.now();
  if (dictionaryCache !== undefined && now < dictionaryCache.expiresAt) {
    return dictionaryCache.dictionary;
  }
  const dictionary = await loadResolverDictionary(db);
  dictionaryCache = { dictionary, expiresAt: now + DICTIONARY_TTL_MS };
  return dictionary;
}

export const handler = async (event: SQSEvent): Promise<SQSBatchResponse> => {
  const db = await lambdaDb();

  const batchItemFailures: SQSBatchItemFailure[] = [];
  for (const record of event.Records) {
    const message = parseRawItemRecord(record.body);
    if (message === null) {
      console.error(
        JSON.stringify({
          level: 'error',
          msg: 'process_poison_message',
          messageId: record.messageId,
        }),
      );
      batchItemFailures.push({ itemIdentifier: record.messageId });
      continue;
    }

    try {
      const [item] = await loadItemsByIds(db, [message.itemId]);
      if (item === undefined) {
        // Pointers are only enqueued after the row commit, so this indicates
        // real drift — retry, then DLQ via redrive.
        throw new Error(`raw_news_items row ${message.itemId} not found`);
      }
      const result = await attachItemToCluster(db, item);
      const resolution = await resolveProcessItem(db, item, await lambdaDictionary(db));
      console.log(
        JSON.stringify({
          level: 'info',
          msg: 'process',
          itemId: message.itemId,
          sourceKey: message.sourceKey,
          clusterId: result.clusterId,
          newCluster: result.isNew,
          similarity: result.similarity,
          links: resolution.links.length,
          linksWritten: resolution.linksWritten,
        }),
      );
    } catch (error) {
      console.error(
        JSON.stringify({
          level: 'error',
          msg: 'process_failed',
          messageId: record.messageId,
          itemId: message.itemId,
          error: String(error),
        }),
      );
      batchItemFailures.push({ itemIdentifier: record.messageId });
    }
  }

  return { batchItemFailures };
};
