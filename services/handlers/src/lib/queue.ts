import { SendMessageBatchCommand } from '@aws-sdk/client-sqs';
import type { RawItemV1 } from '@newstrader/core';

/** Narrow client seam so tests can fake SQS without network or credentials. */
export interface SqsClientLike {
  send(command: SendMessageBatchCommand): Promise<unknown>;
}

/** SQS SendMessageBatch hard limit. */
export const SQS_BATCH_MAX = 10;

/**
 * Enqueue pointer messages to q-items, SQS_BATCH_MAX at a time. Any reported
 * per-entry failure throws: runPoll calls this BEFORE saving the watermark, so
 * a throw makes the next poll cycle refetch and re-emit (at-least-once; the
 * process stage is idempotent).
 */
export async function enqueueRawItems(
  client: SqsClientLike,
  queueUrl: string,
  messages: readonly RawItemV1[],
): Promise<void> {
  for (const batch of chunk(messages, SQS_BATCH_MAX)) {
    const response = await client.send(
      new SendMessageBatchCommand({
        QueueUrl: queueUrl,
        Entries: batch.map((message, index) => ({
          Id: String(index),
          MessageBody: JSON.stringify(message),
        })),
      }),
    );
    const failed = failedEntries(response);
    if (failed === undefined) {
      // An unrecognizable response must not pass as success — a silent skip
      // here would orphan pointer messages while the watermark advances.
      throw new Error('SQS SendMessageBatch returned an unrecognized response shape');
    }
    if (failed.length > 0) {
      throw new Error(
        `SQS SendMessageBatch reported ${failed.length} failed entr${failed.length === 1 ? 'y' : 'ies'}`,
      );
    }
  }
}

/**
 * `Failed` from a SendMessageBatch response: [] when absent (all entries
 * succeeded), undefined when the response shape is unrecognizable.
 */
function failedEntries(response: unknown): unknown[] | undefined {
  if (typeof response !== 'object' || response === null) return undefined;
  if (!('Failed' in response)) return [];
  const failed = (response as { Failed: unknown }).Failed;
  return Array.isArray(failed) ? failed : undefined;
}

export function chunk<T>(items: readonly T[], size: number): T[][] {
  if (size < 1) throw new Error(`chunk size must be >= 1, got ${size}`);
  const out: T[][] = [];
  for (let i = 0; i < items.length; i += size) {
    out.push(items.slice(i, i + size));
  }
  return out;
}
