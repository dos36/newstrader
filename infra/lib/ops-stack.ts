import { CfnOutput, CfnParameter, Duration, Stack } from 'aws-cdk-lib';
import type { StackProps } from 'aws-cdk-lib';
import * as budgets from 'aws-cdk-lib/aws-budgets';
import * as cloudwatch from 'aws-cdk-lib/aws-cloudwatch';
import * as cloudwatchActions from 'aws-cdk-lib/aws-cloudwatch-actions';
import type * as lambda from 'aws-cdk-lib/aws-lambda';
import * as sns from 'aws-cdk-lib/aws-sns';
import * as snsSubscriptions from 'aws-cdk-lib/aws-sns-subscriptions';
import * as ssm from 'aws-cdk-lib/aws-ssm';
import type * as sqs from 'aws-cdk-lib/aws-sqs';
import type { Construct } from 'constructs';

export interface OpsStackProps extends StackProps {
  readonly qItems: sqs.IQueue;
  readonly qItemsDlq: sqs.IQueue;
  /** Every Lambda that gets an error-rate alarm (pollers + process). */
  readonly monitoredFunctions: readonly lambda.IFunction[];
}

/**
 * Ops stack: kill switch, alarms, cost budget. Cheap to redeploy, owns nothing stateful.
 *
 * Alarm philosophy (architecture §4.6): a message in a DLQ is a bug, not noise —
 * it pages immediately. Everything routes to one SNS topic with an email
 * subscription; the deploy-time `AlertEmail` parameter must be confirmed once
 * via the SNS confirmation mail before notifications flow.
 */
export class OpsStack extends Stack {
  public readonly alarmTopic: sns.Topic;

  constructor(scope: Construct, id: string, props: OpsStackProps) {
    super(scope, id, props);

    // -------------------------------------------------------- kill switch ----
    // Read by decide/execute each invocation from M4+ (<=30s cache). Values:
    // 'run' | 'halt'. Trip it manually with:
    //   aws ssm put-parameter --name /newstrader/kill-switch --value halt --overwrite
    // CloudFormation only rewrites the value if the TEMPLATE changes, so a
    // manual 'halt' survives ordinary redeploys of this stack.
    new ssm.StringParameter(this, 'KillSwitch', {
      parameterName: '/newstrader/kill-switch',
      stringValue: 'run',
      description:
        "newstrader kill switch: 'run' | 'halt'. decide/execute check it every invocation.",
    });

    // --------------------------------------------------------- SNS + email ----
    const alertEmail = new CfnParameter(this, 'AlertEmail', {
      type: 'String',
      allowedPattern: '.+@.+\\..+',
      description:
        'Email address for alarm and budget notifications (SNS subscription requires one-time confirmation).',
    });

    this.alarmTopic = new sns.Topic(this, 'AlarmTopic', {
      displayName: 'newstrader alarms',
    });
    this.alarmTopic.addSubscription(
      new snsSubscriptions.EmailSubscription(alertEmail.valueAsString),
    );
    const alarmAction = new cloudwatchActions.SnsAction(this.alarmTopic);

    const wire = (alarm: cloudwatch.Alarm): void => {
      alarm.addAlarmAction(alarmAction);
      alarm.addOkAction(alarmAction);
    };

    // -------------------------------------------------------------- alarms ----
    // DLQ visible > 0 for 5 consecutive minutes.
    wire(
      new cloudwatch.Alarm(this, 'DlqNotEmpty', {
        metric: props.qItemsDlq.metricApproximateNumberOfMessagesVisible({
          period: Duration.minutes(1),
          statistic: 'Maximum',
        }),
        threshold: 0,
        comparisonOperator: cloudwatch.ComparisonOperator.GREATER_THAN_THRESHOLD,
        evaluationPeriods: 5,
        treatMissingData: cloudwatch.TreatMissingData.NOT_BREACHING,
        alarmDescription:
          'newstrader: q-items DLQ has messages. A DLQ message is a bug, not noise — inspect and redrive.',
      }),
    );

    // Oldest q-items message older than 15 minutes: process is down or drowning.
    wire(
      new cloudwatch.Alarm(this, 'QItemsStale', {
        metric: props.qItems.metricApproximateAgeOfOldestMessage({
          period: Duration.minutes(5),
          statistic: 'Maximum',
        }),
        threshold: Duration.minutes(15).toSeconds(),
        comparisonOperator: cloudwatch.ComparisonOperator.GREATER_THAN_THRESHOLD,
        evaluationPeriods: 1,
        treatMissingData: cloudwatch.TreatMissingData.NOT_BREACHING,
        alarmDescription:
          'newstrader: oldest q-items message >15m — the process consumer is failing or backlogged.',
      }),
    );

    // Per-function error rate. Rate, not count: pollers hit flaky upstreams every
    // minute — a lone transient failure must not page, a sustained failure must.
    for (const fn of props.monitoredFunctions) {
      const name = fn.node.id;
      const errors = fn.metricErrors({ period: Duration.minutes(5), statistic: 'Sum' });
      const invocations = fn.metricInvocations({ period: Duration.minutes(5), statistic: 'Sum' });
      const errorRate = new cloudwatch.MathExpression({
        expression: 'IF(invocations > 0, 100 * errors / invocations, 0)',
        usingMetrics: { errors, invocations },
        label: `${name} error rate %`,
        period: Duration.minutes(5),
      });
      wire(
        new cloudwatch.Alarm(this, `${name}ErrorRate`, {
          metric: errorRate,
          threshold: 25,
          comparisonOperator: cloudwatch.ComparisonOperator.GREATER_THAN_OR_EQUAL_TO_THRESHOLD,
          evaluationPeriods: 3,
          treatMissingData: cloudwatch.TreatMissingData.NOT_BREACHING,
          alarmDescription: `newstrader: ${name} error rate >=25% for 15m.`,
        }),
      );
    }

    // -------------------------------------------------------------- budget ----
    // $200/mo hard budget with 50/80/100% ACTUAL email notifications
    // (architecture §4.6/§9). Wiring the 100% breach to the kill switch (SNS ->
    // setter Lambda) is deliberately deferred to M4 when decide/execute exist.
    new budgets.CfnBudget(this, 'MonthlyBudget', {
      budget: {
        budgetName: 'newstrader-monthly',
        budgetType: 'COST',
        timeUnit: 'MONTHLY',
        budgetLimit: { amount: 200, unit: 'USD' },
      },
      notificationsWithSubscribers: [50, 80, 100].map((pct) => ({
        notification: {
          notificationType: 'ACTUAL',
          comparisonOperator: 'GREATER_THAN',
          threshold: pct,
          thresholdType: 'PERCENTAGE',
        },
        subscribers: [{ subscriptionType: 'EMAIL', address: alertEmail.valueAsString }],
      })),
    });

    new CfnOutput(this, 'AlarmTopicArn', { value: this.alarmTopic.topicArn });
    new CfnOutput(this, 'KillSwitchParameter', { value: '/newstrader/kill-switch' });
  }
}
