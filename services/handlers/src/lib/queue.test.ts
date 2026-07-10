import type { SendMessageBatchCommand } from '@aws-sdk/client-sqs';
import type { RawItemV1 } from '@newstrader/core';
import { describe, expect, it } from 'vitest';
import { chunk, enqueueRawItems, SQS_BATCH_MAX } from './queue.js';

function message(i: number): RawItemV1 {
  return {
    v: 1,
    itemId: `item-${i}`,
    sourceKey: 'fake_wire',
    externalId: `ext-${i}`,
    headline: `Headline ${i}`,
    payloadRef: `s3://bucket/raw/fake_wire/2026-07-10/${i}.json`,
    contentHash: 'c'.repeat(64),
    publishedAt: null,
    receivedAt: '2026-07-10T12:00:00.000Z',
    symbolsHint: [],
    meta: {},
  };
}

class FakeSqs {
  readonly commands: SendMessageBatchCommand[] = [];
  constructor(private readonly failed: unknown[] = []) {}
  async send(command: SendMessageBatchCommand): Promise<unknown> {
    this.commands.push(command);
    return { Failed: this.failed };
  }
}

describe('chunk', () => {
  it('splits into fixed-size chunks with a smaller tail', () => {
    expect(chunk([1, 2, 3, 4, 5], 2)).toEqual([[1, 2], [3, 4], [5]]);
    expect(chunk([], 10)).toEqual([]);
    expect(chunk([1], 10)).toEqual([[1]]);
  });

  it('rejects a non-positive size', () => {
    expect(() => chunk([1], 0)).toThrow(/chunk size/);
  });
});

describe('enqueueRawItems', () => {
  it('sends batches of at most 10 with JSON bodies', async () => {
    const sqs = new FakeSqs();
    const messages = Array.from({ length: 25 }, (_, i) => message(i));
    await enqueueRawItems(sqs, 'https://sqs.example/q-items', messages);

    expect(sqs.commands).toHaveLength(3);
    const sizes = sqs.commands.map((c) => c.input.Entries?.length);
    expect(sizes).toEqual([SQS_BATCH_MAX, SQS_BATCH_MAX, 5]);
    expect(sqs.commands[0]?.input.QueueUrl).toBe('https://sqs.example/q-items');

    const firstBody = sqs.commands[0]?.input.Entries?.[0]?.MessageBody;
    expect(firstBody).toBeDefined();
    expect(JSON.parse(firstBody ?? '')).toMatchObject({
      v: 1,
      itemId: 'item-0',
      sourceKey: 'fake_wire',
    });
  });

  it('throws when SQS reports failed entries (poll must not advance its cursor)', async () => {
    const sqs = new FakeSqs([{ Id: '0' }]);
    await expect(enqueueRawItems(sqs, 'https://sqs.example/q-items', [message(1)])).rejects.toThrow(
      /1 failed entry/,
    );
  });

  it('is a no-op for an empty message list', async () => {
    const sqs = new FakeSqs();
    await enqueueRawItems(sqs, 'https://sqs.example/q-items', []);
    expect(sqs.commands).toHaveLength(0);
  });
});
