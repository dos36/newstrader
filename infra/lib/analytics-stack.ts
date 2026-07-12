import * as path from 'node:path';
import { fileURLToPath } from 'node:url';

import { Duration, RemovalPolicy, Stack } from 'aws-cdk-lib';
import type { StackProps } from 'aws-cdk-lib';
import * as cloudwatch from 'aws-cdk-lib/aws-cloudwatch';
import * as cloudwatchActions from 'aws-cdk-lib/aws-cloudwatch-actions';
import * as iam from 'aws-cdk-lib/aws-iam';
import * as lambda from 'aws-cdk-lib/aws-lambda';
import * as lambdaNodejs from 'aws-cdk-lib/aws-lambda-nodejs';
import * as logs from 'aws-cdk-lib/aws-logs';
import * as scheduler from 'aws-cdk-lib/aws-scheduler';
import * as schedulerTargets from 'aws-cdk-lib/aws-scheduler-targets';
import type * as secretsmanager from 'aws-cdk-lib/aws-secretsmanager';
import type * as sns from 'aws-cdk-lib/aws-sns';
import type { Construct } from 'constructs';

const DIRNAME = path.dirname(fileURLToPath(import.meta.url));
const HANDLERS_SRC = path.resolve(DIRNAME, '..', '..', 'services', 'handlers', 'src');

export interface AnalyticsStackProps extends StackProps {
  readonly dbSecret: secretsmanager.ISecret;
  readonly databaseName: string;
  /** OpsStack's alarm topic — every analytics alarm routes to the same pager. */
  readonly alarmTopic: sns.ITopic;
}

/**
 * Analytics stack (M3): the five scheduled batch Lambdas — bars recorder,
 * calendar sync, nightly measure, universe sync, resolve sweep. Split from the
 * ingest stack per the deploy-frequency rule (architecture §4.6): these jobs
 * change with the analytics layer, not with the pollers/queues.
 *
 * Every function: outside any VPC (§4.4), reserved concurrency 1 (a slow run
 * must queue behind itself, never stampede the DB or a vendor), DB credentials
 * from the shared secret at cold start, operator secrets from SSM
 * SecureStrings by parameter NAME (same contract as the ingest stack).
 *
 * MANUAL PREREQUISITES (same as ingest, one new OPTIONAL parameter):
 *   /newstrader/edgar-user-agent   (required — calendar + universe sync)
 *   /newstrader/massive-api-key    (required — bars record + measure)
 *   /newstrader/finnhub-api-key    (OPTIONAL — earnings calendar; until it
 *     exists the calendar sync warn-skips earnings and syncs macro only)
 *
 * Schedules:
 *   bars-record    rate(1 minute), 24/7 — crypto trades weekends; during
 *                  equity off-hours the snapshot's unchanged bars no-op on the
 *                  conflict-do-nothing upsert. Runs also require the Massive
 *                  Stocks Starter snapshot entitlement — without it every tick
 *                  fails loudly (by design) and BarsRecordErrorRate fires.
 *   universe-sync  daily 05:45 UTC (before US pre-market)
 *   calendar-sync  daily 10:15 UTC (after BLS/BEA 08:30 ET releases update pages)
 *   measure        nightly 07:05 UTC (~2-3am ET: the prior US session is closed
 *                  and Massive daily aggregates exist)
 *   resolve-sweep  rate(1 hour)
 *
 * Alarms — all on props.alarmTopic:
 *   bars-record: error RATE >= 25% for 15 m (invoked every minute; one flaky
 *   vendor call must not page — mirrors the ops-stack poller alarms).
 *   The four sparse crons: Errors >= 1 (rate math never alarms on a job with
 *   1-24 invocations/day: with missing-data-not-breaching, three consecutive
 *   breaching 5-minute periods can never accumulate).
 */
export class AnalyticsStack extends Stack {
  public readonly functions: lambdaNodejs.NodejsFunction[];

  constructor(scope: Construct, id: string, props: AnalyticsStackProps) {
    super(scope, id, props);

    // Bundling: identical to the ingest stack (local esbuild, ESM output,
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
    };

    const ssmParameterArn = (name: string): string =>
      this.formatArn({ service: 'ssm', resource: `parameter${name}` });

    const alarmAction = new cloudwatchActions.SnsAction(props.alarmTopic);
    const wire = (alarm: cloudwatch.Alarm): void => {
      alarm.addAlarmAction(alarmAction);
      alarm.addOkAction(alarmAction);
    };

    interface JobSpec {
      constructId: string;
      entry: string;
      description: string;
      timeout: Duration;
      memorySize: number;
      environment?: Record<string, string>;
      /** SSM SecureString parameter names this job may read. */
      secureParams?: string[];
      schedule: scheduler.ScheduleExpression;
      scheduleDescription: string;
      /** Daily/nightly jobs retry (nothing supersedes them soon); ticking jobs don't. */
      retryAttempts: number;
      /** 'rate' = error-rate alarm (frequent invokes); 'any' = Errors >= 1 (sparse crons). */
      alarmStyle: 'rate' | 'any';
    }

    const makeJob = (spec: JobSpec): lambdaNodejs.NodejsFunction => {
      const fn = new lambdaNodejs.NodejsFunction(this, spec.constructId, {
        entry: path.join(HANDLERS_SRC, spec.entry),
        handler: 'handler',
        runtime: lambda.Runtime.NODEJS_20_X,
        architecture: lambda.Architecture.ARM_64,
        memorySize: spec.memorySize,
        timeout: spec.timeout,
        reservedConcurrentExecutions: 1,
        bundling,
        environment: { ...commonEnv, ...spec.environment },
        logGroup: new logs.LogGroup(this, `${spec.constructId}Logs`, {
          retention: logs.RetentionDays.ONE_MONTH,
          removalPolicy: RemovalPolicy.DESTROY,
        }),
        description: spec.description,
        // spec.retryAttempts already governs the SCHEDULER's retry of the
        // invoke call; asynchronous Lambda invocations ALSO get the
        // function's OWN retry (2 by default) on top of that. Passing the
        // same number here keeps both knobs in lockstep — critical for the
        // ticking jobs (bars-record, resolve-sweep, retryAttempts: 0): without
        // this, the function would still silently retry a failed invocation
        // twice even though the scheduler side was zeroed, undermining "the
        // next tick supersedes a failed one".
        retryAttempts: spec.retryAttempts,
      });
      props.dbSecret.grantRead(fn);
      if (spec.secureParams !== undefined && spec.secureParams.length > 0) {
        fn.addToRolePolicy(
          new iam.PolicyStatement({
            actions: ['ssm:GetParameter'],
            resources: spec.secureParams.map(ssmParameterArn),
          }),
        );
      }

      new scheduler.Schedule(this, `${spec.constructId}Schedule`, {
        schedule: spec.schedule,
        target: new schedulerTargets.LambdaInvoke(fn, { retryAttempts: spec.retryAttempts }),
        description: spec.scheduleDescription,
      });

      if (spec.alarmStyle === 'rate') {
        const errors = fn.metricErrors({ period: Duration.minutes(5), statistic: 'Sum' });
        const invocations = fn.metricInvocations({
          period: Duration.minutes(5),
          statistic: 'Sum',
        });
        wire(
          new cloudwatch.Alarm(this, `${spec.constructId}ErrorRate`, {
            metric: new cloudwatch.MathExpression({
              expression: 'IF(invocations > 0, 100 * errors / invocations, 0)',
              usingMetrics: { errors, invocations },
              label: `${spec.constructId} error rate %`,
              period: Duration.minutes(5),
            }),
            threshold: 25,
            comparisonOperator: cloudwatch.ComparisonOperator.GREATER_THAN_OR_EQUAL_TO_THRESHOLD,
            evaluationPeriods: 3,
            treatMissingData: cloudwatch.TreatMissingData.NOT_BREACHING,
            alarmDescription: `newstrader: ${spec.constructId} error rate >=25% for 15m.`,
          }),
        );
      } else {
        wire(
          new cloudwatch.Alarm(this, `${spec.constructId}Errors`, {
            metric: fn.metricErrors({ period: Duration.hours(1), statistic: 'Sum' }),
            threshold: 1,
            comparisonOperator: cloudwatch.ComparisonOperator.GREATER_THAN_OR_EQUAL_TO_THRESHOLD,
            evaluationPeriods: 1,
            treatMissingData: cloudwatch.TreatMissingData.NOT_BREACHING,
            alarmDescription:
              `newstrader: ${spec.constructId} failed (sparse schedule — ` +
              'a single failure means a missed daily/hourly run; inspect the logs).',
          }),
        );
      }
      return fn;
    };

    const barsRecord = makeJob({
      constructId: 'BarsRecord',
      entry: 'bars-record.ts',
      description:
        'newstrader bars-record: Massive full-market snapshot + Kraken OHLC -> price_bars_1m (24/7)',
      timeout: Duration.seconds(55), // under the 1-min tick; concurrency 1 stops pile-ups
      memorySize: 1024, // the full-market snapshot payload is tens of MB of JSON
      environment: { MASSIVE_API_KEY_PARAM: '/newstrader/massive-api-key' },
      secureParams: ['/newstrader/massive-api-key'],
      schedule: scheduler.ScheduleExpression.rate(Duration.minutes(1)),
      scheduleDescription: 'newstrader: record price bars every 1m (24/7 — crypto trades weekends)',
      retryAttempts: 0,
      alarmStyle: 'rate',
    });

    const universeSync = makeJob({
      constructId: 'UniverseSync',
      entry: 'universe-sync.ts',
      description:
        'newstrader universe-sync: S&P 500 constituents + SPX point-in-time membership + aliases (daily)',
      timeout: Duration.minutes(5),
      memorySize: 512,
      environment: { EDGAR_USER_AGENT_PARAM: '/newstrader/edgar-user-agent' },
      secureParams: ['/newstrader/edgar-user-agent'],
      schedule: scheduler.ScheduleExpression.cron({ minute: '45', hour: '5' }),
      scheduleDescription: 'newstrader: sync instrument universe daily 05:45 UTC',
      retryAttempts: 2,
      alarmStyle: 'any',
    });

    const calendarSync = makeJob({
      constructId: 'CalendarSync',
      entry: 'calendar-sync.ts',
      description:
        'newstrader calendar-sync: FOMC/CPI/NFP/GDP/PCE (+ Finnhub earnings when provisioned) -> scheduled_events (daily)',
      timeout: Duration.minutes(5),
      memorySize: 512,
      environment: {
        EDGAR_USER_AGENT_PARAM: '/newstrader/edgar-user-agent',
        FINNHUB_API_KEY_PARAM: '/newstrader/finnhub-api-key',
      },
      secureParams: ['/newstrader/edgar-user-agent', '/newstrader/finnhub-api-key'],
      schedule: scheduler.ScheduleExpression.cron({ minute: '15', hour: '10' }),
      scheduleDescription: 'newstrader: sync scheduled-event calendars daily 10:15 UTC',
      retryAttempts: 2,
      alarmStyle: 'any',
    });

    const measure = makeJob({
      constructId: 'Measure',
      entry: 'measure.ts',
      description:
        'newstrader measure: nightly daily-bars top-up + event-window backfill + reaction/recovery measurements',
      // Sequential vendor fetches for ~500 instruments at ~4 req/s: minutes,
      // not seconds. 15 min is the Lambda ceiling; concurrency 1 + nightly
      // cadence make a long run harmless.
      timeout: Duration.minutes(15),
      memorySize: 1024,
      environment: {
        MASSIVE_API_KEY_PARAM: '/newstrader/massive-api-key',
        MEASURE_SINCE_HOURS: '216',
      },
      secureParams: ['/newstrader/massive-api-key'],
      schedule: scheduler.ScheduleExpression.cron({ minute: '5', hour: '7' }),
      scheduleDescription: 'newstrader: nightly reaction measurement 07:05 UTC',
      retryAttempts: 2,
      alarmStyle: 'any',
    });

    const resolveSweep = makeJob({
      constructId: 'ResolveSweep',
      entry: 'resolve-sweep.ts',
      description:
        'newstrader resolve-sweep: hourly full keyset sweep linking unlinked raw items to instruments',
      timeout: Duration.minutes(15),
      memorySize: 512,
      schedule: scheduler.ScheduleExpression.rate(Duration.hours(1)),
      scheduleDescription: 'newstrader: resolve-backfill sweep every 1h',
      retryAttempts: 0,
      alarmStyle: 'any',
    });

    this.functions = [barsRecord, universeSync, calendarSync, measure, resolveSweep];
  }
}
