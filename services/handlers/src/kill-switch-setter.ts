import type { SNSEvent } from 'aws-lambda';
import { putSsmParameter } from './lib/aws-api.js';
import { requireEnv } from './lib/boot.js';

/**
 * Trips the kill switch when an automated trip path fires (architecture §4.4).
 *
 * The enumerated trip paths are: the CLI, an AWS-Budget-100% breach, reconciler
 * drift, an execute-DLQ alarm, and a daily LLM spend breach. This Lambda is the
 * automated end of that list: anything published to the kill-switch SNS topic
 * sets `/newstrader/kill-switch` to `halt`.
 *
 * Deliberately blunt, for three reasons:
 *   - It NEVER un-trips. Clearing a halt is a human action, because the reason a
 *     halt happened is exactly the thing a human should look at first.
 *   - It ignores the message body. A subscriber that parsed and second-guessed
 *     the payload could decide NOT to halt because of a parse failure, which is
 *     the wrong direction for a safety control.
 *   - It is idempotent. Overwriting `halt` with `halt` is a no-op, so a
 *     retried/duplicated notification costs nothing.
 *
 * Tripping only stops MONEY, never research: decide keeps recording decisions
 * flagged `suppressed=true` while the switch is set.
 */
export const handler = async (event: SNSEvent): Promise<void> => {
  const parameterName = requireEnv('KILL_SWITCH_SSM_PARAM');
  const reasons = event.Records.map((record) => record.Sns.Subject ?? 'sns-notification');

  await putSsmParameter(parameterName, 'halt');

  console.warn(
    JSON.stringify({
      level: 'warn',
      msg: 'kill_switch_tripped',
      parameterName,
      value: 'halt',
      notifications: reasons.length,
      reasons,
      note: 'Trading halted automatically. Clearing it is a deliberate human action.',
    }),
  );
};
