import { edgarAdapters, massiveNewsAdapter, rssPresetAdapters } from '@newstrader/adapters';
import type { SourceAdapter } from '@newstrader/core';
import { createDb } from '@newstrader/db';
import type { Db } from '@newstrader/db';
import { AwsJsonError, getSecretString, getSsmParameter } from './aws-api.js';
import type { AwsCallOptions } from './aws-api.js';

/**
 * Lambda cold-start wiring: env contract (set by infra/lib/ingest-stack.ts),
 * DATABASE_URL assembly from the Secrets Manager secret, and adapter
 * construction per poller family with secrets pulled from SSM SecureStrings.
 */

export function requireEnv(name: string): string {
  const value = process.env[name];
  if (value === undefined || value.trim() === '') {
    throw new Error(`Missing required env var ${name}`);
  }
  return value;
}

/**
 * Read an SSM SecureString whose parameter NAME arrives via an optional env
 * var. Returns undefined (with a structured warn) when the env var is unset
 * OR the parameter does not exist yet (AWS ParameterNotFound) — used for
 * operator secrets that are provisioned out-of-band after deploy (e.g.
 * /newstrader/finnhub-api-key: the calendar sync runs without earnings until
 * the key exists, and a warm-free daily schedule picks the new value up on
 * the next cold start without a redeploy). Any OTHER SSM failure (denied
 * permissions, throttling, a malformed response, …) is rethrown instead of
 * silently downgrading to "not provisioned" — those are operational bugs,
 * not the expected not-yet-provisioned state. Callers that cannot run
 * without the secret must use getSsmParameter(requireEnv(...)) instead so
 * failures stay loud unconditionally.
 */
export async function optionalSsmParameter(
  envName: string,
  options?: AwsCallOptions,
): Promise<string | undefined> {
  const parameterName = process.env[envName];
  if (parameterName === undefined || parameterName.trim() === '') return undefined;
  try {
    return await getSsmParameter(parameterName, options);
  } catch (error) {
    if (!(error instanceof AwsJsonError) || error.awsErrorType !== 'ParameterNotFound') {
      throw error;
    }
    console.warn(
      JSON.stringify({
        level: 'warn',
        msg: 'optional_ssm_parameter_unavailable',
        envName,
        parameterName,
        error: String(error),
      }),
    );
    return undefined;
  }
}

/** Optional positive-integer env knob (schedule tuning without code changes). */
export function intEnv(name: string, fallback: number): number {
  const raw = process.env[name];
  if (raw === undefined || raw.trim() === '') return fallback;
  const parsed = Number.parseInt(raw, 10);
  if (!Number.isInteger(parsed) || parsed < 1) {
    throw new Error(`Env var ${name} must be a positive integer, got "${raw}"`);
  }
  return parsed;
}

/**
 * Memoize an async factory across warm invocations, but forget a rejected
 * promise so a transient cold-start failure (e.g. SSM throttle) is retried on
 * the next invocation instead of poisoning the runtime forever.
 */
export function lazyAsync<T>(factory: () => Promise<T>): () => Promise<T> {
  let cached: Promise<T> | undefined;
  return async () => {
    cached ??= factory();
    try {
      return await cached;
    } catch (error) {
      cached = undefined;
      throw error;
    }
  };
}

/**
 * DATABASE_URL is deliberately NOT a Lambda env var (it would expose the
 * password to lambda:GetFunctionConfiguration). Handlers get DB_SECRET_ARN +
 * DB_NAME and assemble the URL from the RDS-generated secret here.
 *
 * sslmode=no-verify: the instance forces TLS (rds.force_ssl=1) but presents
 * Amazon's RDS CA, which is not in Node's default trust store. Encrypt without
 * CA verification — consistent with the architecture §4.4 threat model; bundle
 * the RDS CA if that trade ever changes.
 */
export async function databaseUrlFromSecret(secretArn: string, dbName?: string): Promise<string> {
  const raw = await getSecretString(secretArn);
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    throw new Error('DB secret SecretString is not JSON');
  }
  const username = requireSecretField(parsed, 'username');
  const password = requireSecretField(parsed, 'password');
  const host = requireSecretField(parsed, 'host');
  const port = requireSecretField(parsed, 'port');
  const database = dbName ?? optionalSecretField(parsed, 'dbname');
  if (database === undefined) {
    throw new Error('Database name missing: set DB_NAME or include dbname in the secret');
  }
  return (
    `postgresql://${encodeURIComponent(username)}:${encodeURIComponent(password)}` +
    `@${host}:${port}/${database}?sslmode=no-verify`
  );
}

/** Shared, memoized DB handle for both handlers. */
export const lambdaDb: () => Promise<Db> = lazyAsync(async () =>
  createDb(await databaseUrlFromSecret(requireEnv('DB_SECRET_ARN'), process.env['DB_NAME'])),
);

/**
 * Build the adapters for a POLLER_SOURCES value: a csv of family names
 * (edgar | massive | rss — one per poller Lambda in the ingest stack).
 * Families needing an operator secret read it from SSM here; the parameter
 * NAMES arrive via env (EDGAR_USER_AGENT_PARAM / MASSIVE_API_KEY_PARAM).
 */
export async function pollerAdapters(pollerSources: string): Promise<SourceAdapter[]> {
  const adapters: SourceAdapter[] = [];
  const families = pollerSources
    .split(',')
    .map((family) => family.trim())
    .filter((family) => family.length > 0);

  for (const family of families) {
    switch (family) {
      case 'edgar': {
        const userAgent = await getSsmParameter(requireEnv('EDGAR_USER_AGENT_PARAM'));
        adapters.push(...edgarAdapters({ EDGAR_USER_AGENT: userAgent }));
        break;
      }
      case 'massive': {
        const apiKey = await getSsmParameter(requireEnv('MASSIVE_API_KEY_PARAM'));
        adapters.push(massiveNewsAdapter({ MASSIVE_API_KEY: apiKey }));
        break;
      }
      case 'rss': {
        adapters.push(...rssPresetAdapters());
        break;
      }
      default:
        throw new Error(
          `Unknown POLLER_SOURCES family "${family}" (expected edgar | massive | rss)`,
        );
    }
  }

  if (adapters.length === 0) {
    throw new Error(`POLLER_SOURCES ("${pollerSources}") selected no adapters`);
  }
  return adapters;
}

function requireSecretField(secret: unknown, field: string): string {
  const value = optionalSecretField(secret, field);
  if (value === undefined) {
    throw new Error(`DB secret is missing field "${field}"`);
  }
  return value;
}

function optionalSecretField(secret: unknown, field: string): string | undefined {
  if (typeof secret !== 'object' || secret === null) return undefined;
  const value = (secret as Record<string, unknown>)[field];
  if (typeof value === 'string' && value.length > 0) return value;
  if (typeof value === 'number') return String(value);
  return undefined;
}
