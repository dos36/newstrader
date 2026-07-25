import { afterEach, describe, expect, it } from 'vitest';
import type { SNSEvent, SNSEventRecord } from 'aws-lambda';
import { handler } from './kill-switch-setter.js';

/**
 * The setter is a safety control, so the properties worth testing are the two
 * ways it could FAIL SILENTLY — a trip that looks delivered but never wrote
 * `halt` is strictly worse than no automation at all.
 *
 * No mocking: `aws-api.ts` throws synchronously when AWS_REGION/credentials are
 * absent, which is exactly the "the write did not happen" case, so the real code
 * path is the test (same approach as lib/trading.test.ts).
 */

const ENV_KEYS = ['KILL_SWITCH_SSM_PARAM', 'AWS_REGION', 'AWS_DEFAULT_REGION'] as const;
const saved = new Map<string, string | undefined>(ENV_KEYS.map((k) => [k, process.env[k]]));

afterEach(() => {
  for (const [key, value] of saved) {
    if (value === undefined) delete process.env[key];
    else process.env[key] = value;
  }
});

function snsEvent(subject: string): SNSEvent {
  const record: SNSEventRecord = {
    EventVersion: '1.0',
    EventSubscriptionArn: 'arn:aws:sns:us-east-1:000000000000:kill-switch:sub',
    EventSource: 'aws:sns',
    Sns: {
      SignatureVersion: '1',
      Timestamp: '2026-07-24T00:00:00.000Z',
      Signature: 'sig',
      SigningCertUrl: 'https://example.invalid/cert.pem',
      MessageId: 'message-id',
      Message: 'AWS Budgets: newstrader-monthly exceeded 100%',
      MessageAttributes: {},
      Type: 'Notification',
      UnsubscribeUrl: 'https://example.invalid/unsubscribe',
      TopicArn: 'arn:aws:sns:us-east-1:000000000000:kill-switch',
      Subject: subject,
    },
  };
  return { Records: [record] };
}

describe('kill-switch setter', () => {
  it('throws when the parameter name is not configured, instead of no-oping', async () => {
    delete process.env['KILL_SWITCH_SSM_PARAM'];
    // A misconfigured setter must fail loudly: SNS retries and the error is
    // visible, rather than the trip being swallowed and trading continuing.
    await expect(handler(snsEvent('budget breach'))).rejects.toThrow(/KILL_SWITCH_SSM_PARAM/);
  });

  it('propagates a failed SSM write rather than reporting success', async () => {
    process.env['KILL_SWITCH_SSM_PARAM'] = '/newstrader/kill-switch';
    delete process.env['AWS_REGION'];
    delete process.env['AWS_DEFAULT_REGION'];
    // Region missing => the AWS call cannot be made. The handler must reject so
    // the invocation is retried/alarmed; returning normally here would mean the
    // system believes it halted when it did not.
    await expect(handler(snsEvent('AWS Budgets notification'))).rejects.toThrow(/AWS_REGION/);
  });
});
