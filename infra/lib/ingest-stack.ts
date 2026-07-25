import * as path from 'node:path';
import { fileURLToPath } from 'node:url';

import { Duration, RemovalPolicy, Stack } from 'aws-cdk-lib';
import type { StackProps } from 'aws-cdk-lib';
import * as iam from 'aws-cdk-lib/aws-iam';
import * as lambda from 'aws-cdk-lib/aws-lambda';
import { SqsEventSource } from 'aws-cdk-lib/aws-lambda-event-sources';
import * as lambdaNodejs from 'aws-cdk-lib/aws-lambda-nodejs';
import * as logs from 'aws-cdk-lib/aws-logs';
import type * as s3 from 'aws-cdk-lib/aws-s3';
import * as scheduler from 'aws-cdk-lib/aws-scheduler';
import * as schedulerTargets from 'aws-cdk-lib/aws-scheduler-targets';
import type * as secretsmanager from 'aws-cdk-lib/aws-secretsmanager';
import * as sqs from 'aws-cdk-lib/aws-sqs';
import type { Construct } from 'constructs';

const DIRNAME = path.dirname(fileURLToPath(import.meta.url));
const HANDLERS_SRC = path.resolve(DIRNAME, '..', '..', 'services', 'handlers', 'src');

export interface IngestStackProps extends StackProps {
  /** Concrete Bucket (not IBucket): aws-cdk-lib's optional interface props clash with exactOptionalPropertyTypes. */
  readonly rawBucket: s3.Bucket;
  readonly dbSecret: secretsmanager.ISecret;
  readonly databaseName: string;
}

/**
 * Ingest stack: EventBridge Scheduler crons → poller Lambdas → q-items → process Lambda.
 *
 * All Lambdas run OUTSIDE any VPC (architecture §4.4 — $0 networking; they reach
 * RDS over its public endpoint with forced TLS, see DataStack for the tradeoff).
 *
 * MANUAL PREREQUISITE (one-time, before first deploy): create two SSM
 * SecureString parameters — CloudFormation cannot create SecureStrings, and the
 * values are operator secrets anyway:
 *
 *   aws ssm put-parameter --type SecureString --name /newstrader/edgar-user-agent \
 *     --value "NewsTrader research bot you@example.com"
 *   aws ssm put-parameter --type SecureString --name /newstrader/massive-api-key \
 *     --value "<massive api key>"
 *
 * Handlers receive the parameter NAMES via env (EDGAR_USER_AGENT_PARAM /
 * MASSIVE_API_KEY_PARAM) and read the values with ssm:GetParameter at cold
 * start; the IAM grant below is scoped to exactly those two parameters.
 */
export class IngestStack extends Stack {
  public readonly qItems: sqs.Queue;
  public readonly qItemsDlq: sqs.Queue;
  public readonly pollerFunctions: lambdaNodejs.NodejsFunction[];
  public readonly processFunction: lambdaNodejs.NodejsFunction;

  constructor(scope: Construct, id: string, props: IngestStackProps) {
    super(scope, id, props);

    // Every consumer of q-items gets this timeout; queue visibility is 6x it
    // (architecture §4.2: visibility timeout >= 6x Lambda timeout).
    const processTimeout = Duration.seconds(60);
    const pollTimeout = Duration.seconds(60);

    // ------------------------------------------------------------- queues ----
    this.qItemsDlq = new sqs.Queue(this, 'QItemsDlq', {
      retentionPeriod: Duration.days(14),
      enforceSSL: true,
    });

    this.qItems = new sqs.Queue(this, 'QItems', {
      visibilityTimeout: Duration.seconds(processTimeout.toSeconds() * 6),
      retentionPeriod: Duration.days(14),
      enforceSSL: true,
      deadLetterQueue: {
        queue: this.qItemsDlq,
        maxReceiveCount: 5,
      },
    });

    // ------------------------------------------------------------ pollers ----
    // Bundling: local esbuild only (no docker). ESM output + createRequire
    // banner so bundled CJS deps (pg et al.) keep working; pg-native is an
    // optional native dep that must stay external.
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
      // DATABASE_URL is assembled at runtime from this secret (username,
      // password, host, port). Putting the full URL in Lambda env would expose
      // the password to anyone with lambda:GetFunctionConfiguration.
      DB_SECRET_ARN: props.dbSecret.secretArn,
      DB_NAME: props.databaseName,
      RAW_BUCKET: props.rawBucket.bucketName,
      Q_ITEMS_URL: this.qItems.queueUrl,
    };

    const ssmParameterArn = (name: string): string =>
      this.formatArn({ service: 'ssm', resource: `parameter${name}` });

    const makePoller = (
      constructId: string,
      pollerSources: string,
      secureParamEnv: Record<string, string>,
      secureParamNames: string[],
    ): lambdaNodejs.NodejsFunction => {
      const fn = new lambdaNodejs.NodejsFunction(this, constructId, {
        entry: path.join(HANDLERS_SRC, 'poll.ts'),
        handler: 'handler',
        runtime: lambda.Runtime.NODEJS_20_X,
        architecture: lambda.Architecture.ARM_64,
        memorySize: 256,
        timeout: pollTimeout,
        bundling,
        environment: {
          ...commonEnv,
          POLLER_SOURCES: pollerSources,
          ...secureParamEnv,
        },
        logGroup: new logs.LogGroup(this, `${constructId}Logs`, {
          retention: logs.RetentionDays.ONE_MONTH,
          removalPolicy: RemovalPolicy.DESTROY,
        }),
        description: `newstrader poller (${pollerSources}): fetch since cursor -> S3 raw/ -> q-items pointer`,
      });

      props.rawBucket.grantPut(fn);
      this.qItems.grantSendMessages(fn);
      props.dbSecret.grantRead(fn); // DB access for the ingest cursor (ingest_watermarks)
      if (secureParamNames.length > 0) {
        fn.addToRolePolicy(
          new iam.PolicyStatement({
            actions: ['ssm:GetParameter'],
            resources: secureParamNames.map(ssmParameterArn),
          }),
        );
      }
      return fn;
    };

    const edgarPoller = makePoller(
      'PollerEdgar',
      'edgar',
      { EDGAR_USER_AGENT_PARAM: '/newstrader/edgar-user-agent' },
      ['/newstrader/edgar-user-agent'],
    );
    const massivePoller = makePoller(
      'PollerMassive',
      'massive',
      { MASSIVE_API_KEY_PARAM: '/newstrader/massive-api-key' },
      ['/newstrader/massive-api-key'],
    );
    const rssPoller = makePoller('PollerRss', 'rss', {}, []);
    this.pollerFunctions = [edgarPoller, massivePoller, rssPoller];

    // ---------------------------------------------------------- schedules ----
    // retryAttempts: 0 — a failed poll is superseded by the next tick; retrying
    // a stale invoke only duplicates work the cursor already covers.
    const schedule = (
      constructId: string,
      fn: lambda.IFunction,
      rate: Duration,
      what: string,
    ): void => {
      new scheduler.Schedule(this, constructId, {
        schedule: scheduler.ScheduleExpression.rate(rate),
        target: new schedulerTargets.LambdaInvoke(fn, { retryAttempts: 0 }),
        description: `newstrader: poll ${what} every ${rate.toMinutes()}m`,
      });
    };
    schedule('EdgarSchedule', edgarPoller, Duration.minutes(1), 'SEC EDGAR getcurrent');
    schedule('MassiveSchedule', massivePoller, Duration.minutes(2), 'Massive news');
    schedule('RssSchedule', rssPoller, Duration.minutes(2), 'RSS feeds');

    // ------------------------------------------------------------ process ----
    // Reserved concurrency 5: a news burst must not stampede downstream (and,
    // from M2, Anthropic rate limits). Backpressure is free — messages age
    // harmlessly in-queue (architecture §4.1).
    this.processFunction = new lambdaNodejs.NodejsFunction(this, 'Process', {
      entry: path.join(HANDLERS_SRC, 'process.ts'),
      handler: 'handler',
      runtime: lambda.Runtime.NODEJS_20_X,
      architecture: lambda.Architecture.ARM_64,
      memorySize: 512,
      timeout: processTimeout,
      reservedConcurrentExecutions: 5,
      bundling,
      environment: { ...commonEnv },
      logGroup: new logs.LogGroup(this, 'ProcessLogs', {
        retention: logs.RetentionDays.ONE_MONTH,
        removalPolicy: RemovalPolicy.DESTROY,
      }),
      description:
        'newstrader process: q-items pointer -> dedup/cluster + entity resolution; LLM interpret arrives with M2',
    });
    props.rawBucket.grantRead(this.processFunction);
    props.dbSecret.grantRead(this.processFunction);

    this.processFunction.addEventSource(
      new SqsEventSource(this.qItems, {
        batchSize: 5,
        reportBatchItemFailures: true,
      }),
    );
  }
}
