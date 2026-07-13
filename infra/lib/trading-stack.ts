import { execFileSync } from 'node:child_process';
import * as path from 'node:path';
import { fileURLToPath } from 'node:url';

import { Duration, RemovalPolicy, Stack } from 'aws-cdk-lib';
import type { StackProps } from 'aws-cdk-lib';
import * as cloudwatch from 'aws-cdk-lib/aws-cloudwatch';
import * as cloudwatchActions from 'aws-cdk-lib/aws-cloudwatch-actions';
import * as iam from 'aws-cdk-lib/aws-iam';
import * as lambda from 'aws-cdk-lib/aws-lambda';
import { SqsEventSource } from 'aws-cdk-lib/aws-lambda-event-sources';
import * as lambdaNodejs from 'aws-cdk-lib/aws-lambda-nodejs';
import * as logs from 'aws-cdk-lib/aws-logs';
import * as scheduler from 'aws-cdk-lib/aws-scheduler';
import * as schedulerTargets from 'aws-cdk-lib/aws-scheduler-targets';
import type * as secretsmanager from 'aws-cdk-lib/aws-secretsmanager';
import type * as sns from 'aws-cdk-lib/aws-sns';
import * as sqs from 'aws-cdk-lib/aws-sqs';
import type { Construct } from 'constructs';

const DIRNAME = path.dirname(fileURLToPath(import.meta.url));
const HANDLERS_SRC = path.resolve(DIRNAME, '..', '..', 'services', 'handlers', 'src');

/** OpsStack's kill-switch parameter — read each invocation by decide/execute (<=30s cache). */
const KILL_SWITCH_PARAM = '/newstrader/kill-switch';

export interface TradingStackProps extends StackProps {
  readonly dbSecret: secretsmanager.ISecret;
  readonly databaseName: string;
  /** OpsStack's alarm topic — trading alarms page the same address. */
  readonly alarmTopic: sns.ITopic;
}

/**
 * Trading stack (M4/M5 — the architecture §4.6 "pipeline-stack" role):
 * decide-sweep → q-orders → execute, plus the position manager.
 *
 * ******************************************************************
 * VENUE IS SIM ONLY. Every order placed by this stack goes through the
 * SimBrokerAdapter against recorded bars (paper). There is NO real-money
 * code path in v1 — going live requires code changes, not configuration
 * (architecture §0/§7).
 * ******************************************************************
 *
 * Functions (all outside any VPC, §4.4):
 *   decide-sweep      rate(5 min), reserved concurrency 1 — pure engine over
 *                     undecided llm_signals; enqueues OrderIntents to q-orders.
 *                     Re-derives undelivered intents from decisions rows, so a
 *                     lost enqueue heals on the next sweep.
 *   execute           q-orders consumer (batch 5, partial-batch failures),
 *                     reserved concurrency 5 — kill switch re-checked HERE
 *                     independently of decide, then SimBroker placeOrder.
 *   position-manager  rate(15 min), reserved concurrency 1 — exit evaluation;
 *                     closes are recorded as replayable action=close decisions.
 *
 * Kill switch: all three read the OpsStack SSM parameter (/newstrader/
 * kill-switch) every invocation with a <=30s cache. Halted ⇒ decisions still
 * recorded (suppressed=true), nothing enqueued, nothing placed.
 *
 * ENGINE_VERSION: stamped at synth time from the repo's git SHA so every
 * decision row records the code that produced it (config versioning does not
 * protect against code drift, §5.4).
 *
 * Alarms (all on props.alarmTopic): q-orders DLQ > 0 (a DLQ message is a bug,
 * not noise), q-orders oldest message > 15 min, decide-sweep error RATE >= 25%
 * for 15 m (invoked every 5 min), execute/position-manager Errors >= 1
 * (sparse/event-driven — rate math cannot accumulate three breaching periods).
 */
export class TradingStack extends Stack {
  public readonly qOrders: sqs.Queue;
  public readonly qOrdersDlq: sqs.Queue;
  public readonly decideSweepFunction: lambdaNodejs.NodejsFunction;
  public readonly executeFunction: lambdaNodejs.NodejsFunction;
  public readonly positionManagerFunction: lambdaNodejs.NodejsFunction;

  constructor(scope: Construct, id: string, props: TradingStackProps) {
    super(scope, id, props);

    const executeTimeout = Duration.seconds(60);

    // ------------------------------------------------------------- queues ----
    // Mirrors q-items (ingest stack): 14d retention, SSL enforced, visibility
    // 6x the consumer timeout, maxReceiveCount 5 -> DLQ (architecture §4.2).
    this.qOrdersDlq = new sqs.Queue(this, 'QOrdersDlq', {
      retentionPeriod: Duration.days(14),
      enforceSSL: true,
    });

    this.qOrders = new sqs.Queue(this, 'QOrders', {
      visibilityTimeout: Duration.seconds(executeTimeout.toSeconds() * 6),
      retentionPeriod: Duration.days(14),
      enforceSSL: true,
      deadLetterQueue: {
        queue: this.qOrdersDlq,
        maxReceiveCount: 5,
      },
    });

    // ---------------------------------------------------------- functions ----
    // Bundling: identical to the ingest/analytics stacks (local esbuild, ESM,
    // createRequire banner for bundled CJS deps like pg).
    const bundling: lambdaNodejs.BundlingOptions = {
      forceDockerBundling: false,
      format: lambdaNodejs.OutputFormat.ESM,
      target: 'node20',
      mainFields: ['module', 'main'],
      banner:
        "import{createRequire}from'node:module';const require=createRequire(import.meta.url);",
      externalModules: ['@aws-sdk/*', 'pg-native'],
      sourceMap: true,
      minify: false,
    };

    const commonEnv: Record<string, string> = {
      NODE_OPTIONS: '--enable-source-maps',
      DB_SECRET_ARN: props.dbSecret.secretArn,
      DB_NAME: props.databaseName,
      KILL_SWITCH_PARAM,
      ENGINE_VERSION: engineVersionFromGit(),
    };

    const killSwitchParamArn = this.formatArn({
      service: 'ssm',
      resource: `parameter${KILL_SWITCH_PARAM}`,
    });
    const grantKillSwitchRead = (fn: lambdaNodejs.NodejsFunction): void => {
      fn.addToRolePolicy(
        new iam.PolicyStatement({
          actions: ['ssm:GetParameter'],
          resources: [killSwitchParamArn],
        }),
      );
    };

    const alarmAction = new cloudwatchActions.SnsAction(props.alarmTopic);
    const wire = (alarm: cloudwatch.Alarm): void => {
      alarm.addAlarmAction(alarmAction);
      alarm.addOkAction(alarmAction);
    };

    // decide-sweep: every 5 minutes; reserved concurrency 1 so a slow pass
    // queues behind itself; retryAttempts 0 — the next tick supersedes.
    this.decideSweepFunction = new lambdaNodejs.NodejsFunction(this, 'DecideSweep', {
      entry: path.join(HANDLERS_SRC, 'decide-sweep.ts'),
      handler: 'handler',
      runtime: lambda.Runtime.NODEJS_20_X,
      architecture: lambda.Architecture.ARM_64,
      memorySize: 512,
      timeout: Duration.minutes(4), // under the 5-min tick
      reservedConcurrentExecutions: 1,
      bundling,
      environment: { ...commonEnv, Q_ORDERS_URL: this.qOrders.queueUrl },
      logGroup: new logs.LogGroup(this, 'DecideSweepLogs', {
        retention: logs.RetentionDays.ONE_MONTH,
        removalPolicy: RemovalPolicy.DESTROY,
      }),
      description:
        'newstrader decide-sweep: pure engine over undecided llm_signals -> decisions + q-orders intents (SIM venue only)',
      retryAttempts: 0, // async-invoke retry kept in lockstep with the scheduler (see analytics stack)
    });
    props.dbSecret.grantRead(this.decideSweepFunction);
    this.qOrders.grantSendMessages(this.decideSweepFunction);
    grantKillSwitchRead(this.decideSweepFunction);

    new scheduler.Schedule(this, 'DecideSweepSchedule', {
      schedule: scheduler.ScheduleExpression.rate(Duration.minutes(5)),
      target: new schedulerTargets.LambdaInvoke(this.decideSweepFunction, { retryAttempts: 0 }),
      description: 'newstrader: decide sweep every 5m',
    });

    // execute: q-orders consumer. Reserved concurrency 5 mirrors process —
    // order placement is DB-bound and must not stampede the micro instance.
    this.executeFunction = new lambdaNodejs.NodejsFunction(this, 'Execute', {
      entry: path.join(HANDLERS_SRC, 'execute.ts'),
      handler: 'handler',
      runtime: lambda.Runtime.NODEJS_20_X,
      architecture: lambda.Architecture.ARM_64,
      memorySize: 512,
      timeout: executeTimeout,
      reservedConcurrentExecutions: 5,
      bundling,
      environment: { ...commonEnv },
      logGroup: new logs.LogGroup(this, 'ExecuteLogs', {
        retention: logs.RetentionDays.ONE_MONTH,
        removalPolicy: RemovalPolicy.DESTROY,
      }),
      description:
        'newstrader execute: q-orders intents -> kill-switch re-check -> SimBroker placeOrder (SIM venue only, no real money path)',
    });
    props.dbSecret.grantRead(this.executeFunction);
    grantKillSwitchRead(this.executeFunction);
    this.executeFunction.addEventSource(
      new SqsEventSource(this.qOrders, {
        batchSize: 5,
        reportBatchItemFailures: true,
      }),
    );

    // position-manager: every 15 minutes; exits must not race themselves.
    this.positionManagerFunction = new lambdaNodejs.NodejsFunction(this, 'PositionManager', {
      entry: path.join(HANDLERS_SRC, 'position-manager.ts'),
      handler: 'handler',
      runtime: lambda.Runtime.NODEJS_20_X,
      architecture: lambda.Architecture.ARM_64,
      memorySize: 512,
      timeout: Duration.minutes(2),
      reservedConcurrentExecutions: 1,
      bundling,
      environment: { ...commonEnv },
      logGroup: new logs.LogGroup(this, 'PositionManagerLogs', {
        retention: logs.RetentionDays.ONE_MONTH,
        removalPolicy: RemovalPolicy.DESTROY,
      }),
      description:
        'newstrader position-manager: exit evaluation over derived open positions -> replayable close decisions (SIM venue only)',
      retryAttempts: 0,
    });
    props.dbSecret.grantRead(this.positionManagerFunction);
    grantKillSwitchRead(this.positionManagerFunction);

    new scheduler.Schedule(this, 'PositionManagerSchedule', {
      schedule: scheduler.ScheduleExpression.rate(Duration.minutes(15)),
      target: new schedulerTargets.LambdaInvoke(this.positionManagerFunction, {
        retryAttempts: 0,
      }),
      description: 'newstrader: position-manager exit pass every 15m',
    });

    // -------------------------------------------------------------- alarms ----
    wire(
      new cloudwatch.Alarm(this, 'QOrdersDlqNotEmpty', {
        metric: this.qOrdersDlq.metricApproximateNumberOfMessagesVisible({
          period: Duration.minutes(1),
          statistic: 'Maximum',
        }),
        threshold: 0,
        comparisonOperator: cloudwatch.ComparisonOperator.GREATER_THAN_THRESHOLD,
        evaluationPeriods: 5,
        treatMissingData: cloudwatch.TreatMissingData.NOT_BREACHING,
        alarmDescription:
          'newstrader: q-orders DLQ has messages. An order intent in the DLQ is a bug, not noise — inspect and redrive.',
      }),
    );

    wire(
      new cloudwatch.Alarm(this, 'QOrdersStale', {
        metric: this.qOrders.metricApproximateAgeOfOldestMessage({
          period: Duration.minutes(5),
          statistic: 'Maximum',
        }),
        threshold: Duration.minutes(15).toSeconds(),
        comparisonOperator: cloudwatch.ComparisonOperator.GREATER_THAN_THRESHOLD,
        evaluationPeriods: 1,
        treatMissingData: cloudwatch.TreatMissingData.NOT_BREACHING,
        alarmDescription:
          'newstrader: oldest q-orders message >15m — the execute consumer is failing or backlogged.',
      }),
    );

    // decide-sweep runs every 5 minutes: error RATE (a lone transient failure
    // must not page; a sustained one must) — mirrors the poller alarms.
    {
      const errors = this.decideSweepFunction.metricErrors({
        period: Duration.minutes(5),
        statistic: 'Sum',
      });
      const invocations = this.decideSweepFunction.metricInvocations({
        period: Duration.minutes(5),
        statistic: 'Sum',
      });
      wire(
        new cloudwatch.Alarm(this, 'DecideSweepErrorRate', {
          metric: new cloudwatch.MathExpression({
            expression: 'IF(invocations > 0, 100 * errors / invocations, 0)',
            usingMetrics: { errors, invocations },
            label: 'DecideSweep error rate %',
            period: Duration.minutes(5),
          }),
          threshold: 25,
          comparisonOperator: cloudwatch.ComparisonOperator.GREATER_THAN_OR_EQUAL_TO_THRESHOLD,
          evaluationPeriods: 3,
          treatMissingData: cloudwatch.TreatMissingData.NOT_BREACHING,
          alarmDescription: 'newstrader: DecideSweep error rate >=25% for 15m.',
        }),
      );
    }

    // execute (event-driven) and position-manager (15-min cron) invoke too
    // sparsely for rate math — any error pages (see analytics stack rationale).
    for (const [constructId, fn] of [
      ['ExecuteErrors', this.executeFunction],
      ['PositionManagerErrors', this.positionManagerFunction],
    ] as const) {
      wire(
        new cloudwatch.Alarm(this, constructId, {
          metric: fn.metricErrors({ period: Duration.hours(1), statistic: 'Sum' }),
          threshold: 1,
          comparisonOperator: cloudwatch.ComparisonOperator.GREATER_THAN_OR_EQUAL_TO_THRESHOLD,
          evaluationPeriods: 1,
          treatMissingData: cloudwatch.TreatMissingData.NOT_BREACHING,
          alarmDescription:
            `newstrader: ${constructId.replace('Errors', '')} failed — sparse invocations, ` +
            'a single failure is signal on the order path; inspect the logs.',
        }),
      );
    }
  }
}

/**
 * The repo's git SHA at synth time — becomes ENGINE_VERSION in every trading
 * Lambda and is snapshotted into each decision's features. 'unknown' when git
 * is unavailable (e.g. a CI synth from an exported tarball); the pipeline
 * still runs, decisions just carry the honest "don't know" stamp.
 */
function engineVersionFromGit(): string {
  try {
    return execFileSync('git', ['rev-parse', '--short', 'HEAD'], {
      cwd: DIRNAME,
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'ignore'],
    }).trim();
  } catch {
    return 'unknown';
  }
}
