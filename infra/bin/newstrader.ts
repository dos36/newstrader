import { createRequire } from 'node:module';
import * as path from 'node:path';
import { fileURLToPath } from 'node:url';

import { App } from 'aws-cdk-lib';

import { AnalyticsStack } from '../lib/analytics-stack.js';
import { DataStack } from '../lib/data-stack.js';
import { IngestStack } from '../lib/ingest-stack.js';
import { OpsStack } from '../lib/ops-stack.js';
import { TradingStack } from '../lib/trading-stack.js';

/**
 * Make the workspace esbuild executable for NodejsFunction's local bundling.
 *
 * NodejsFunction detects esbuild with require.resolve (which succeeds through
 * pnpm's hidden hoist, node_modules/.pnpm/node_modules) but then runs it via
 * `pnpm exec esbuild`, which only searches node_modules/.bin — and esbuild is
 * not always a DIRECT dependency of the package being bundled. `pnpm exec` falls
 * back to PATH, so resolving the hoisted package and prepending its bin dir to
 * PATH bridges the gap without Docker.
 *
 * esbuild IS now a declared devDependency of @newstrader/infra, so the ordinary
 * path already works; this shim stays as belt-and-braces for a fresh clone whose
 * install shape differs, and it prefers the declared copy when one resolves.
 */
function ensureEsbuildOnPath(): void {
  const require = createRequire(import.meta.url);
  try {
    const cdkLibPkg = require.resolve('aws-cdk-lib/package.json');
    const esbuildPkg = require.resolve('esbuild/package.json', {
      // Prefer a properly declared esbuild (resolvable from infra) if one ever
      // appears; fall back to the hoist next to aws-cdk-lib.
      paths: [path.dirname(fileURLToPath(import.meta.url)), path.dirname(cdkLibPkg)],
    });
    const binDir = path.join(path.dirname(esbuildPkg), 'bin');
    process.env.PATH = `${binDir}${path.delimiter}${process.env.PATH ?? ''}`;
  } catch {
    // esbuild genuinely absent — NodejsFunction falls back to Docker bundling.
  }
}
ensureEsbuildOnPath();

/**
 * A concrete env is mandatory: DataStack looks up the account's DEFAULT VPC
 * (Vpc.fromLookup), which cannot run environment-agnostic. The cdk CLI sets
 * CDK_DEFAULT_ACCOUNT/REGION from the active AWS credentials; for an offline
 * synth (no credentials) export both variables yourself — the VPC lookup is
 * then served from cdk.context.json.
 */
const account = process.env.CDK_DEFAULT_ACCOUNT;
const region = process.env.CDK_DEFAULT_REGION;
if (!account || !region) {
  throw new Error(
    'CDK_DEFAULT_ACCOUNT and CDK_DEFAULT_REGION must be set. ' +
      'Run via the cdk CLI with AWS credentials configured, or export both for an offline synth.',
  );
}
const env = { account, region };

const app = new App();

const data = new DataStack(app, 'NewstraderData', { env });

const ingest = new IngestStack(app, 'NewstraderIngest', {
  env,
  rawBucket: data.rawBucket,
  dbSecret: data.dbSecret,
  databaseName: data.databaseName,
});

const ops = new OpsStack(app, 'NewstraderOps', {
  env,
  qItems: ingest.qItems,
  qItemsDlq: ingest.qItemsDlq,
  monitoredFunctions: [...ingest.pollerFunctions, ingest.processFunction],
});

// M3 batch analytics. Alarms live inside the stack (sparse crons need
// Errors>=1 alarms, not the ops-stack error-rate shape) but route to the same
// ops SNS topic.
new AnalyticsStack(app, 'NewstraderAnalytics', {
  env,
  dbSecret: data.dbSecret,
  databaseName: data.databaseName,
  alarmTopic: ops.alarmTopic,
});

// M4/M5 trading pipeline: decide-sweep -> q-orders -> execute + the position
// manager. VENUE IS SIM ONLY (paper) — see the stack header. Depends on the
// ops stack for the alarm topic and the kill-switch SSM parameter it reads.
new TradingStack(app, 'NewstraderTrading', {
  env,
  dbSecret: data.dbSecret,
  databaseName: data.databaseName,
  alarmTopic: ops.alarmTopic,
});
