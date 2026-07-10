import { attachItemToCluster } from '@newstrader/db';
import type { SQSBatchItemFailure, SQSBatchResponse, SQSEvent } from 'aws-lambda';
import { lambdaDb } from './lib/boot.js';
import { loadItemsByIds, parseRawItemRecord } from './lib/ingest.js';

/**
 * Process Lambda (q-items → here, batch 5, ReportBatchItemFailures enabled).
 * M0 scope: dedup/cluster only — resolve/interpret/decide arrive with M1+.
 *
 * Idempotency comes from Postgres (attach is advisory-locked and treats
 * redelivery as a no-op), so at-least-once SQS delivery is safe. Unparseable
 * bodies are poison pills: reported as item failures so the redrive policy
 * moves them to the DLQ after maxReceiveCount — never retried past that
 * (architecture §4.2/§4.3).
 */
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
      console.log(
        JSON.stringify({
          level: 'info',
          msg: 'process',
          itemId: message.itemId,
          sourceKey: message.sourceKey,
          clusterId: result.clusterId,
          newCluster: result.isNew,
          similarity: result.similarity,
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
