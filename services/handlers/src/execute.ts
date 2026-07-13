import { checkKillSwitch } from '@newstrader/db';
import type { SQSBatchItemFailure, SQSBatchResponse, SQSEvent } from 'aws-lambda';
import { lambdaDb } from './lib/boot.js';
import { parseOrderIntentRecord, readKillSwitchFromSsm, simBrokerFromEnv } from './lib/trading.js';

/**
 * Execute Lambda (q-orders → here, batch 5, ReportBatchItemFailures enabled —
 * architecture §1/§4.2). Consumes OrderIntents and places them through the
 * SimBrokerAdapter — VENUE IS SIM ONLY in v1; there is no real-money code path.
 *
 * Kill switch, checked AGAIN here independently of decide (architecture §4.4):
 * when halted, intents are logged and DROPPED (reported as successes), never
 * placed. Dropping is safe because delivery is re-derived, not queue-durable:
 * the decide-sweep re-emits any open decision that still has no orders row
 * (within its freshness window), so orders resume when the switch clears —
 * and a retry-until-DLQ here would page "bug" alarms for what is an
 * operator-intended halt.
 *
 * Idempotency: clientOrderId is deterministic (sha256 of the decision key) and
 * unique in the orders table; the SimBroker returns the existing ack for a
 * redelivered intent — one fills row can ever exist per order. A rejected ack
 * (e.g. NO_REFERENCE_PRICE) is terminal and reported as success: rejection is
 * a recorded broker outcome, not a processing failure to retry.
 *
 * Poison pills (unparseable/invalid bodies) are reported as item failures so
 * the redrive policy moves them to the DLQ after maxReceiveCount — a DLQ
 * message is a bug, not noise (mirrors process.ts).
 */

export const handler = async (event: SQSEvent): Promise<SQSBatchResponse> => {
  const db = await lambdaDb();
  const broker = simBrokerFromEnv(db);
  const killSwitch = await checkKillSwitch({ read: readKillSwitchFromSsm });

  const batchItemFailures: SQSBatchItemFailure[] = [];
  for (const record of event.Records) {
    const intent = parseOrderIntentRecord(record.body);
    if (intent === null) {
      console.error(
        JSON.stringify({
          level: 'error',
          msg: 'execute_poison_message',
          messageId: record.messageId,
        }),
      );
      batchItemFailures.push({ itemIdentifier: record.messageId });
      continue;
    }

    if (killSwitch.halted) {
      console.log(
        JSON.stringify({
          level: 'warn',
          msg: 'execute_suppressed_by_kill_switch',
          clientOrderId: intent.clientOrderId,
          instrumentId: intent.instrumentId,
        }),
      );
      continue; // dropped, not failed: decide-sweep re-emits after the switch clears
    }

    try {
      const ack = await broker.placeOrder(intent);
      console.log(
        JSON.stringify({
          level: ack.status === 'rejected' ? 'warn' : 'info',
          msg: 'execute_order',
          clientOrderId: intent.clientOrderId,
          instrumentId: intent.instrumentId,
          side: intent.side,
          qty: intent.qty,
          status: ack.status,
          brokerOrderId: ack.brokerOrderId,
          ...(ack.reason !== undefined ? { reason: ack.reason } : {}),
        }),
      );
    } catch (error) {
      console.error(
        JSON.stringify({
          level: 'error',
          msg: 'execute_failed',
          messageId: record.messageId,
          clientOrderId: intent.clientOrderId,
          error: String(error),
        }),
      );
      batchItemFailures.push({ itemIdentifier: record.messageId });
    }
  }

  return { batchItemFailures };
};
